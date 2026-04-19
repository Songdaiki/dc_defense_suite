import http from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VPNCMD_PATH,
  MANAGED_ACCOUNT_PREFIX,
  SoftEtherCli,
  buildSoftEtherNicCandidateList,
  buildManagedAccountName,
  isManagedAccountName,
  normalizePreferredSoftEtherNicName,
  sanitizeManagedToken,
} from './lib/softether_cli.mjs';
import {
  NetworkObserver,
  buildBaseline,
  compareBaseline,
} from './lib/network_state.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const DEFAULT_MANAGED_NIC_NAME = 'VPN2';
const DEFAULT_STATE_DIR = path.join(os.tmpdir(), 'dc-defense-suite');
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, 'self-hosted-vpn-agent-state.json');
const DEFAULT_TOKEN = String(process.env.SELF_HOSTED_VPN_TOKEN || '').trim();
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 128 * 1024;
const DEFAULT_MONITOR_INTERVAL_MS = 1200;
const DEFAULT_CONNECT_SETTLE_TIMEOUT_MS = 75_000;
const DEFAULT_DISCONNECT_SETTLE_TIMEOUT_MS = 45_000;
const DEFAULT_CONNECT_BASELINE_CACHE_TTL_MS = 60_000;
const CONNECTION_MODE = {
  PROFILE: 'profile',
  SOFTETHER_VPNGATE_RAW: 'softether_vpngate_raw',
};
const PHASE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR',
};

class SelfHostedVpnAgent {
  constructor(options = {}) {
    this.host = String(options.host || DEFAULT_HOST).trim() || DEFAULT_HOST;
    this.port = normalizePort(options.port, DEFAULT_PORT);
    this.authToken = String(options.authToken || DEFAULT_TOKEN).trim();
    this.managedNicName = normalizePreferredSoftEtherNicName(
      options.managedNicName || DEFAULT_MANAGED_NIC_NAME,
      DEFAULT_MANAGED_NIC_NAME,
    );
    this.stateFile = String(options.stateFile || DEFAULT_STATE_FILE).trim() || DEFAULT_STATE_FILE;
    this.softEtherCli = new SoftEtherCli({
      vpncmdPath: options.vpncmdPath || DEFAULT_VPNCMD_PATH,
      timeoutMs: normalizePositiveInteger(options.vpncmdTimeoutMs, 15000),
    });
    this.networkObserver = new NetworkObserver();

    this.state = buildInitialState(this.managedNicName);
    this.healthCache = null;
    this.refreshPromise = null;
    this.actionQueue = Promise.resolve();
    this.monitorTimer = null;
    this.statusCache = null;
    this.softEtherMutationInFlight = false;
  }

  async init() {
    await this.loadState();
    await this.refreshState({ force: true, includeNetwork: true });
    this.ensureBackgroundMonitor();
  }

  getRuntimeConfig() {
    return {
      host: this.host,
      port: this.port,
      managedNicName: this.managedNicName,
      vpncmdPath: this.softEtherCli.vpncmdPath,
      stateFile: this.stateFile,
      managedAccountPrefix: MANAGED_ACCOUNT_PREFIX,
    };
  }

  async getHealth() {
    if (this.healthCache && (Date.now() - this.healthCache.observedAtMs) < 3000) {
      return this.healthCache.value;
    }

    let ok = false;
    let message = '';
    try {
      const vpncmdExists = await this.softEtherCli.isAvailable();
      if (!vpncmdExists) {
        message = `vpncmd.exe 경로를 찾지 못했습니다: ${this.softEtherCli.vpncmdPath}`;
      } else {
        await this.softEtherCli.probeClient();
        ok = true;
      }
    } catch (error) {
      message = String(error?.message || 'SoftEther Client 연결 실패');
    }

    const value = {
      ok,
      agentVersion: '0.1.0',
      message,
      managedNicName: this.managedNicName,
      vpncmdPath: this.softEtherCli.vpncmdPath,
      phase: this.state.phase,
    };
    this.healthCache = {
      observedAtMs: Date.now(),
      value,
    };
    return value;
  }

  async getStatus() {
    await this.refreshState({ includeNetwork: false });

    const response = {
      phase: this.state.phase,
      operationId: this.state.operationId,
      connectionMode: this.state.connectionMode,
      mode: this.state.connectionMode,
      profileId: this.state.profileId,
      activeProfileId: this.state.profileId,
      activeRelayId: this.state.activeRelayId,
      activeRelayIp: this.state.activeRelayIp,
      activeRelayFqdn: this.state.activeRelayFqdn,
      activeSelectedSslPort: this.state.activeSelectedSslPort,
      activeAdapterName: this.state.activeAdapterName,
      publicIpBefore: this.state.publicIpBefore,
      publicIpAfter: this.state.publicIpAfter,
      currentPublicIp: this.state.currentPublicIp,
      publicIpProvider: this.state.publicIpProvider,
      ipv4DefaultRouteChanged: this.state.ipv4DefaultRouteChanged,
      ipv6DefaultRouteChanged: this.state.ipv6DefaultRouteChanged,
      dnsChanged: this.state.dnsChanged,
      connectedAt: this.state.connectedAt,
      lastErrorCode: this.state.lastErrorCode,
      lastErrorMessage: this.state.lastErrorMessage,
      activeAccountName: this.state.accountName,
      managedNicName: this.managedNicName,
      underlayProtocol: this.state.underlayProtocol,
      udpAccelerationActive: this.state.udpAccelerationActive,
      relay: {
        id: this.state.activeRelayId,
        fqdn: this.state.activeRelayFqdn,
        ip: this.state.activeRelayIp,
        selectedSslPort: this.state.activeSelectedSslPort,
      },
    };

    return response;
  }

  async getEgress() {
    await this.refreshState({ includeNetwork: false });
    void this.refreshPublicIp({
      force: false,
      allowStale: true,
    }).catch(() => {
      // egress 조회 자체는 마지막 캐시를 우선 반환하고, 백그라운드 갱신 실패는 다음 refresh에 맡긴다.
    });
    return {
      publicIp: this.state.currentPublicIp,
      ip: this.state.currentPublicIp,
      provider: this.state.publicIpProvider,
      observedAt: this.state.networkObservedAt,
    };
  }

  async connect(payload = {}) {
    return this.runSerializedAction(async () => {
      await this.refreshState({ force: true, includeNetwork: false });
      const request = normalizeConnectRequest(payload);

      const conflictingManagedBusyAccounts = this.findConflictingManagedBusyAccounts(this.state.accountRows);
      if (conflictingManagedBusyAccounts.length > 0) {
        throw httpError(
          409,
          'MULTIPLE_MANAGED_ACCOUNTS',
          `관리용 SoftEther account가 이미 활성화되어 있습니다. 먼저 정리하세요: ${conflictingManagedBusyAccounts.map(row => row.name).join(', ')}`,
        );
      }

      const foreignBusyAccount = this.findForeignBusyAccount(this.state.accountRows, request);
      if (foreignBusyAccount) {
        throw httpError(
          409,
          'SOFTETHER_FOREIGN_ACCOUNT_ACTIVE',
          `SoftEther Client에 다른 연결이 살아 있습니다. 먼저 수동 연결을 끊으세요: ${foreignBusyAccount.name}`,
        );
      }

      if ([PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(this.state.phase)) {
        throw httpError(
          409,
          'VPN_ALREADY_ACTIVE',
          `이미 자체 VPN 테스트 상태입니다. 현재 phase=${this.state.phase}`,
        );
      }

      if (request.mode === CONNECTION_MODE.PROFILE) {
        return this.connectProfile(request);
      }

      return this.connectRawRelay(request);
    });
  }

  async disconnect() {
    return this.runSerializedAction(async () => {
      const canReuseTrackedStateDuringMutation = this.softEtherMutationInFlight
        && [PHASE.CONNECTING, PHASE.DISCONNECTING].includes(this.state.phase)
        && Boolean(this.state.accountName || this.state.accountProvisioning);
      if (!canReuseTrackedStateDuringMutation) {
        await this.refreshState({ force: true, includeNetwork: false });
      }
      if (!this.state.accountName) {
        await this.transitionToIdle();
        return {
          accepted: true,
          operationId: this.state.operationId || '',
          phase: PHASE.IDLE,
          profileId: this.state.profileId || '',
        };
      }

      const trackedAccount = this.state.accountRows.find(row => row.name === this.state.accountName) || null;
      if (!canReuseTrackedStateDuringMutation && (!trackedAccount || trackedAccount.statusKind === 'DISCONNECTED')) {
        await this.finishDisconnectCleanup();
        return {
          accepted: true,
          operationId: '',
          phase: PHASE.IDLE,
          profileId: '',
        };
      }

      this.state.operationId = buildOperationId('disconnect');
      this.state.phase = PHASE.DISCONNECTING;
      this.state.lastErrorCode = '';
      this.state.lastErrorMessage = '';
      await this.saveState();

      void this.executeDisconnect({
        operationId: this.state.operationId,
        accountName: this.state.accountName,
        accountOwnership: this.state.accountOwnership,
      });
      this.ensureBackgroundMonitor();
      return {
        accepted: true,
        operationId: this.state.operationId,
        phase: PHASE.DISCONNECTING,
        profileId: this.state.profileId || '',
      };
    });
  }

  async connectProfile(request) {
    const matchingAccount = await this.findAccountByName(request.profileId);
    if (!matchingAccount) {
      throw httpError(404, 'PROFILE_NOT_FOUND', `SoftEther 계정을 찾지 못했습니다: ${request.profileId}`);
    }

    this.state.operationId = buildOperationId('connect');
    this.state.phase = PHASE.CONNECTING;
    this.state.connectionMode = CONNECTION_MODE.PROFILE;
    this.state.profileId = request.profileId;
    this.state.accountName = request.profileId;
    this.state.accountOwnership = 'profile';
    this.state.accountProvisioning = false;
    this.state.activeAdapterName = matchingAccount.nicName || this.managedNicName;
    this.state.activeRelayId = '';
    this.state.activeRelayIp = '';
    this.state.activeRelayFqdn = '';
    this.state.activeSelectedSslPort = 0;
    this.state.baseline = null;
    this.state.publicIpBefore = '';
    this.state.publicIpAfter = '';
    this.state.lastErrorCode = '';
    this.state.lastErrorMessage = '';
    await this.saveState();

    void this.executeProfileConnect({
      operationId: this.state.operationId,
      request,
      matchingAccount,
    });
    this.ensureBackgroundMonitor();
    return {
      accepted: true,
      operationId: this.state.operationId,
      phase: PHASE.CONNECTING,
      connectionMode: CONNECTION_MODE.PROFILE,
      profileId: this.state.profileId,
      activeAdapterName: this.state.activeAdapterName,
    };
  }

  async connectRawRelay(request) {
    const accountName = buildManagedAccountName(request.relay, request.relay.selectedSslPort);

    this.state.operationId = buildOperationId('connect');
    this.state.phase = PHASE.CONNECTING;
    this.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
    this.state.profileId = request.profileId;
    this.state.accountName = accountName;
    this.state.accountOwnership = 'managed_raw';
    this.state.accountProvisioning = true;
    this.state.activeAdapterName = '';
    this.state.activeRelayId = request.relay.id;
    this.state.activeRelayIp = request.relay.ip;
    this.state.activeRelayFqdn = request.relay.fqdn;
    this.state.activeSelectedSslPort = request.relay.selectedSslPort;
    this.state.baseline = null;
    this.state.publicIpBefore = '';
    this.state.publicIpAfter = '';
    this.state.lastErrorCode = '';
    this.state.lastErrorMessage = '';
    await this.saveState();

    void this.executeRawRelayConnect({
      operationId: this.state.operationId,
      request,
      accountName,
    });
    this.ensureBackgroundMonitor();
    return {
      accepted: true,
      operationId: this.state.operationId,
      phase: PHASE.CONNECTING,
      connectionMode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
      profileId: this.state.profileId,
      activeAdapterName: this.state.activeAdapterName,
      relay: {
        id: this.state.activeRelayId,
        fqdn: this.state.activeRelayFqdn,
        ip: this.state.activeRelayIp,
        selectedSslPort: this.state.activeSelectedSslPort,
      },
    };
  }

  async executeProfileConnect(context = {}) {
    const { operationId, request, matchingAccount } = context;
    this.softEtherMutationInFlight = true;
    try {
      const baseline = await this.captureBaseline();
      if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        return;
      }

      this.state.baseline = baseline;
      this.state.publicIpBefore = baseline.publicIp;
      await this.saveState();

      if (matchingAccount?.statusKind !== 'CONNECTED') {
        await this.softEtherCli.connectAccount(request.profileId);
      }

      const connectedContext = await this.waitForTrackedAccountConnected({
        accountName: request.profileId,
        operationId,
      });
      if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        return;
      }

      await this.applyConnectedAccountContext(connectedContext);
      this.softEtherMutationInFlight = false;
      await this.saveState();
      await this.finalizePostConnectRefresh(operationId);
    } catch (error) {
      if (this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        await this.setErrorState('PROFILE_CONNECT_FAILED', String(error?.message || 'AccountConnect 실패'));
      }
    } finally {
      this.softEtherMutationInFlight = false;
    }
  }

  async executeRawRelayConnect(context = {}) {
    const { operationId, request, accountName } = context;
    this.softEtherMutationInFlight = true;

    try {
      const adapterName = await this.ensureManagedNic();
      if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        return;
      }

      this.state.activeAdapterName = adapterName;
      await this.saveState();

      await this.cleanupManagedInactiveAccounts();
      if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        return;
      }

      const baseline = await this.captureBaseline();
      if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        return;
      }

      this.state.baseline = baseline;
      this.state.publicIpBefore = baseline.publicIp;
      await this.saveState();

      const relayHost = request.relay.ip || request.relay.fqdn;
      const relayPortAttempts = buildRelayPortAttemptList(request.relay);
      const attemptErrors = [];
      let connectedContext = null;

      for (const attemptPort of relayPortAttempts) {
        if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
          await this.safeDeleteManagedAccount(accountName);
          return;
        }

        this.state.activeSelectedSslPort = attemptPort;
        this.state.accountProvisioning = true;

        try {
          await this.safeDeleteManagedAccount(accountName);
          await this.softEtherCli.createAccount({
            name: accountName,
            serverHost: relayHost,
            serverPort: attemptPort,
            hubName: 'VPNGATE',
            username: 'VPN',
            nicName: adapterName,
          });
          this.state.accountProvisioning = false;

          await this.softEtherCli.setAccountAnonymous(accountName);
          await this.softEtherCli.setAccountRetry(accountName, {
            numRetry: 0,
            retryInterval: 15,
          });
          await this.softEtherCli.disableServerCertCheck(accountName);
          await this.softEtherCli.setAccountDetails(accountName, {
            maxTcp: 1,
            additionalConnectionInterval: 1,
            connectionTtl: 0,
            halfDuplex: false,
            bridgeMode: false,
            monitorMode: false,
            noRoutingTracking: false,
            noQos: true,
          });

          if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
            await this.safeDeleteManagedAccount(accountName);
            return;
          }

          await this.softEtherCli.connectAccount(accountName);
          if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
            await this.safeDeleteManagedAccount(accountName);
            return;
          }

          connectedContext = await this.waitForTrackedAccountConnected({
            accountName,
            operationId,
          });
          if (connectedContext?.trackedAccount) {
            break;
          }
        } catch (error) {
          attemptErrors.push(`[${attemptPort}] ${String(error?.message || 'raw relay connect 실패')}`);
          this.state.accountProvisioning = false;
          await this.safeDeleteManagedAccount(accountName);
        }
      }

      if (!connectedContext?.trackedAccount) {
        throw new Error(
          `모든 raw 포트 시도 실패 (${relayHost}) - ${attemptErrors.join(' / ') || '성공한 포트가 없습니다.'}`,
        );
      }

      if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        await this.safeDeleteManagedAccount(accountName);
        return;
      }

      await this.applyConnectedAccountContext(connectedContext);
      this.softEtherMutationInFlight = false;
      await this.saveState();
      await this.finalizePostConnectRefresh(operationId);
    } catch (error) {
      this.state.accountProvisioning = false;
      await this.safeDeleteManagedAccount(accountName);
      if (this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        this.state.accountName = '';
        this.state.accountProvisioning = false;
        this.state.activeAdapterName = '';
        this.state.connectedAt = '';
        this.state.underlayProtocol = '';
        this.state.udpAccelerationActive = false;
        await this.setErrorState('RAW_CONNECT_FAILED', String(error?.message || 'raw relay connect 실패'));
      }
    } finally {
      this.softEtherMutationInFlight = false;
    }
  }

  async executeDisconnect(context = {}) {
    const { operationId, accountName } = context;
    this.softEtherMutationInFlight = true;

    try {
      await this.softEtherCli.disconnectAccount(accountName);
    } catch (error) {
      const normalizedMessage = String(error?.message || '');
      const benign = normalizedMessage.includes('not found')
        || normalizedMessage.includes('not connected')
        || normalizedMessage.includes('already');
      if (!benign) {
        let accountGone = false;
        try {
          const refreshedAccount = await this.findAccountByName(accountName);
          accountGone = !refreshedAccount || refreshedAccount.statusKind === 'DISCONNECTED';
        } catch {
          accountGone = false;
        }
        if (accountGone) {
          if (this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
            await this.finishDisconnectCleanup();
          }
          return;
        }
        if (this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
          await this.setErrorState('DISCONNECT_REQUEST_FAILED', normalizedMessage || 'SoftEther disconnect 실패');
        }
        return;
      }
    }

    try {
      if (!this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
        return;
      }

      await this.waitForTrackedAccountDisconnected({
        accountName,
        operationId,
      });
      if (!this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
        return;
      }

      await this.finishDisconnectCleanup();
      this.softEtherMutationInFlight = false;
      await this.finalizePostDisconnectRefresh(operationId);
    } catch (error) {
      if (this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
        await this.setErrorState('DISCONNECT_REFRESH_FAILED', String(error?.message || 'disconnect 후 상태 반영 실패'));
      }
    } finally {
      this.softEtherMutationInFlight = false;
    }
  }

  async ensureManagedNic() {
    const nicRows = await this.softEtherCli.listNics();
    const candidateNames = buildSoftEtherNicCandidateList(this.managedNicName);
    const prefersSharedVpnNic = String(this.managedNicName || '').trim().toUpperCase() === 'VPN';
    const primaryCandidateNames = prefersSharedVpnNic
      ? [...candidateNames]
      : candidateNames.filter(name => name !== 'VPN');
    const fallbackCandidateNames = prefersSharedVpnNic ? [] : ['VPN'];
    const disabledCandidates = [];

    for (const candidateName of primaryCandidateNames) {
      const existingNic = nicRows.find(row => row.name === candidateName);
      if (!existingNic) {
        continue;
      }

      if (/enabled/i.test(existingNic.status)) {
        this.managedNicName = candidateName;
        this.state.managedNicName = candidateName;
        return candidateName;
      }

      disabledCandidates.push(candidateName);
    }

    let lastError = null;
    for (const candidateName of primaryCandidateNames) {
      if (nicRows.some(row => row.name === candidateName)) {
        continue;
      }

      try {
        await this.softEtherCli.createNic(candidateName);
        const refreshedNicRows = await this.softEtherCli.listNics();
        const createdNic = refreshedNicRows.find(row => row.name === candidateName);
        if (createdNic && /enabled/i.test(createdNic.status)) {
          this.managedNicName = candidateName;
          this.state.managedNicName = candidateName;
          return candidateName;
        }

        if (createdNic) {
          disabledCandidates.push(candidateName);
        }
      } catch (error) {
        lastError = error;
      }
    }

    for (const candidateName of fallbackCandidateNames) {
      const existingNic = nicRows.find(row => row.name === candidateName);
      if (!existingNic) {
        continue;
      }

      if (/enabled/i.test(existingNic.status)) {
        this.managedNicName = candidateName;
        this.state.managedNicName = candidateName;
        return candidateName;
      }

      disabledCandidates.push(candidateName);
    }

    if (disabledCandidates.length > 0) {
      throw httpError(
        500,
        'NIC_DISABLED',
        `관리용 SoftEther 어댑터가 비활성화되어 있습니다: ${disabledCandidates.join(', ')}`,
      );
    }

    throw httpError(
      500,
      'NIC_CREATE_FAILED',
      `관리용 SoftEther 어댑터 생성 실패 (${this.managedNicName}) - SoftEther는 VPN/VPN2... 형식만 허용하며, 현재 후보 생성도 실패했습니다. ${String(lastError?.message || '')}`.trim(),
    );
  }

  async cleanupManagedInactiveAccounts() {
    const accountRows = await this.softEtherCli.listAccounts();
    const staleManagedAccounts = accountRows.filter(row => (
      isManagedAccountName(row.name)
      && row.statusKind === 'DISCONNECTED'
    ));

    for (const row of staleManagedAccounts) {
      try {
        await this.softEtherCli.deleteAccount(row.name);
      } catch {
        // 다음 연결을 막는 수준만 아니면 stale 계정 삭제 실패는 무시한다.
      }
    }
  }

  async captureBaseline() {
    const localSnapshotCache = this.networkObserver.localSnapshotCache || null;
    const publicIpCache = this.networkObserver.publicIpCache || null;
    const cachedLocalSnapshot = localSnapshotCache
      && Number.isFinite(localSnapshotCache.observedAtMs)
      && (Date.now() - localSnapshotCache.observedAtMs) < DEFAULT_CONNECT_BASELINE_CACHE_TTL_MS
      ? localSnapshotCache.value
      : null;
    const cachedPublicIp = publicIpCache
      && Number.isFinite(publicIpCache.observedAtMs)
      && (Date.now() - publicIpCache.observedAtMs) < DEFAULT_CONNECT_BASELINE_CACHE_TTL_MS
      ? publicIpCache.value
      : null;

    if (!cachedLocalSnapshot) {
      void this.networkObserver.getLocalSnapshot({ force: true }).catch(() => {
        // baseline 준비를 막지 않도록 무거운 route snapshot은 background warm-up으로만 돌린다.
      });
    }

    if (!cachedPublicIp && !this.state.currentPublicIp) {
      try {
        const publicIp = await this.networkObserver.getPublicIp({ force: true, allowStale: false });
        return buildBaseline(
          cachedLocalSnapshot || {
            observedAt: new Date().toISOString(),
            ipv4DefaultRouteKey: '',
            ipv6DefaultRouteKey: '',
            dnsSignature: '',
          },
          publicIp,
        );
      } catch {
        // public IP 실시간 조회까지 실패하면 현재 상태의 마지막 캐시로 진행한다.
      }
    }

    return buildBaseline(
      cachedLocalSnapshot || {
        observedAt: new Date().toISOString(),
        ipv4DefaultRouteKey: '',
        ipv6DefaultRouteKey: '',
        dnsSignature: '',
      },
      cachedPublicIp || {
        ip: String(this.state.currentPublicIp || '').trim(),
        provider: String(this.state.publicIpProvider || '').trim(),
      },
    );
  }

  async waitForTrackedAccountConnected(context = {}) {
    const timeoutMs = normalizePositiveInteger(context.timeoutMs, DEFAULT_CONNECT_SETTLE_TIMEOUT_MS);
    const pollIntervalMs = normalizePositiveInteger(context.pollIntervalMs, DEFAULT_MONITOR_INTERVAL_MS);
    const accountName = String(context.accountName || '').trim();
    const operationId = context.operationId;
    const startedAt = Date.now();
    let lastStateText = '';
    let lastError = '';

    while ((Date.now() - startedAt) < timeoutMs) {
      if (!this.isCurrentOperation(operationId, PHASE.CONNECTING)) {
        return null;
      }

      try {
        const accountRows = await this.softEtherCli.listAccounts();
        this.state.accountRows = accountRows;

        const trackedAccount = accountRows.find(row => row.name === accountName) || null;
        if (trackedAccount) {
          lastStateText = trackedAccount.statusText || trackedAccount.statusKind || 'UNKNOWN';
          if (trackedAccount.statusKind === 'CONNECTED') {
            return {
              trackedAccount,
              accountStatus: null,
              accountRows,
              nicRows: this.state.nicRows,
            };
          }
        } else {
          lastStateText = this.state.accountProvisioning ? 'PROVISIONING' : 'MISSING';
        }
      } catch (error) {
        lastError = String(error?.message || error || '').trim();
      }

      await delay(pollIntervalMs);
    }

    const suffix = lastError ? `, lastError=${lastError}` : '';
    throw new Error(`SoftEther 연결 상태 timeout (${timeoutMs}ms, account=${accountName || '-'}, last=${lastStateText || '-'}${suffix})`);
  }

  async waitForTrackedAccountDisconnected(context = {}) {
    const timeoutMs = normalizePositiveInteger(context.timeoutMs, DEFAULT_DISCONNECT_SETTLE_TIMEOUT_MS);
    const pollIntervalMs = normalizePositiveInteger(context.pollIntervalMs, DEFAULT_MONITOR_INTERVAL_MS);
    const accountName = String(context.accountName || '').trim();
    const operationId = context.operationId;
    const startedAt = Date.now();
    let lastStateText = '';
    let lastError = '';

    while ((Date.now() - startedAt) < timeoutMs) {
      if (!this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
        return null;
      }

      try {
        const accountRows = await this.softEtherCli.listAccounts();
        this.state.accountRows = accountRows;
        const trackedAccount = accountRows.find(row => row.name === accountName) || null;
        if (!trackedAccount) {
          lastStateText = 'MISSING';
          return {
            trackedAccount: null,
            accountRows,
          };
        }

        lastStateText = trackedAccount.statusText || trackedAccount.statusKind || 'UNKNOWN';
        if (trackedAccount.statusKind === 'DISCONNECTED') {
          return {
            trackedAccount,
            accountRows,
          };
        }
      } catch (error) {
        lastError = String(error?.message || error || '').trim();
      }

      await delay(pollIntervalMs);
    }

    const suffix = lastError ? `, lastError=${lastError}` : '';
    throw new Error(`SoftEther 종료 상태 timeout (${timeoutMs}ms, account=${accountName || '-'}, last=${lastStateText || '-'}${suffix})`);
  }

  async applyConnectedAccountContext(context = {}) {
    const trackedAccount = context.trackedAccount || null;
    if (!trackedAccount) {
      throw new Error('연결된 SoftEther account를 찾지 못했습니다.');
    }

    this.state.accountRows = Array.isArray(context.accountRows) ? context.accountRows : this.state.accountRows;
    this.state.nicRows = Array.isArray(context.nicRows) ? context.nicRows : this.state.nicRows;
    this.adoptTrackedAccount(trackedAccount);
    this.state.accountName = trackedAccount.name;
    this.state.activeAdapterName = trackedAccount.nicName || this.state.activeAdapterName || this.managedNicName;
    await this.updateConnectedState(trackedAccount, { includeNetwork: false });
  }

  async finalizePostConnectRefresh(operationId) {
    try {
      if (String(this.state.operationId || '') !== String(operationId || '')
        || this.state.phase !== PHASE.CONNECTED) {
        return;
      }

      await this.refreshNetworkState({ force: true, forceNetworkIp: true });
      this.statusCache = {
        observedAtMs: Date.now(),
      };
      await this.saveState();
    } catch (error) {
      if (String(this.state.operationId || '') !== String(operationId || '')) {
        return;
      }

      if (this.state.phase === PHASE.CONNECTED) {
        this.state.lastErrorCode = 'NETWORK_OBSERVE_FAILED';
        this.state.lastErrorMessage = `터널 연결은 성공했지만 route/public IP 관측이 실패했습니다. ${String(error?.message || '')}`.trim();
        await this.saveState();
        return;
      }

      throw error;
    }
  }

  async finalizePostDisconnectRefresh(operationId) {
    try {
      await this.refreshNetworkState({ force: true, forceNetworkIp: true });
      this.statusCache = {
        observedAtMs: Date.now(),
      };
      await this.saveState();
    } catch (error) {
      if (String(this.state.operationId || '') !== String(operationId || '')) {
        return;
      }

      if (this.state.phase === PHASE.IDLE) {
        return;
      }

      throw error;
    }
  }

  async refreshState(options = {}) {
    const force = options.force === true;
    if (!force && this.softEtherMutationInFlight) {
      return this.state;
    }
    if (!force && this.statusCache && (Date.now() - this.statusCache.observedAtMs) < 700) {
      return this.state;
    }

    if (this.refreshPromise) {
      if (options.includeNetwork === false || [PHASE.CONNECTING, PHASE.DISCONNECTING].includes(this.state.phase)) {
        return this.state;
      }
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh(options)
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  async performRefresh(options = {}) {
    const includeNetwork = options.includeNetwork !== false;
    const shouldRefreshNics = options.force === true || this.state.nicRows.length === 0;
    let accountRows = [];
    let nicRows = this.state.nicRows;
    try {
      accountRows = await this.softEtherCli.listAccounts();
      if (shouldRefreshNics) {
        nicRows = await this.softEtherCli.listNics();
      }
    } catch (error) {
      this.state.accountRows = [];
      if (this.state.phase !== PHASE.DISCONNECTING) {
        this.state.phase = this.state.phase === PHASE.IDLE ? PHASE.IDLE : PHASE.ERROR;
      }
      this.state.lastErrorCode = 'SOFTETHER_QUERY_FAILED';
      this.state.lastErrorMessage = String(error?.message || 'SoftEther 상태 조회 실패');
      this.statusCache = {
        observedAtMs: Date.now(),
      };
      await this.saveState();
      return this.state;
    }

    this.state.accountRows = accountRows;
    this.state.nicRows = nicRows;

    const activeManagedAccounts = this.findActiveManagedAccounts(accountRows);
    const trackedAccount = this.resolveTrackedAccount(accountRows);
    if (trackedAccount) {
      this.adoptTrackedAccount(trackedAccount);
      this.state.accountName = trackedAccount.name;
      this.state.activeAdapterName = trackedAccount.nicName || this.state.activeAdapterName || this.managedNicName;
    } else if (!this.state.accountName && activeManagedAccounts.length > 1) {
      this.state.phase = PHASE.ERROR;
      this.state.lastErrorCode = 'MULTIPLE_MANAGED_ACCOUNTS';
      this.state.lastErrorMessage = `관리용 SoftEther account가 여러 개 활성화되어 있습니다: ${activeManagedAccounts.map(row => row.name).join(', ')}`;
    }

    if (!this.state.accountName) {
      if (![PHASE.IDLE, PHASE.ERROR].includes(this.state.phase)) {
        await this.transitionToIdle();
      }
    } else if (!trackedAccount) {
      if (this.state.phase === PHASE.CONNECTING && this.state.accountProvisioning === true) {
        // raw 연결 준비 단계에서는 AccountCreate 이전 잠깐 동안 list 결과가 비어도 정상이다.
      } else if (this.state.phase === PHASE.CONNECTING) {
        await this.setErrorState(
          'CONNECT_ACCOUNT_MISSING',
          'SoftEther account가 연결 중 사라져 연결을 이어갈 수 없습니다.',
        );
      } else if (this.state.phase === PHASE.DISCONNECTING) {
        await this.finishDisconnectCleanup();
      } else if (![PHASE.IDLE, PHASE.ERROR].includes(this.state.phase)) {
        await this.transitionToIdle();
      }
    } else if (trackedAccount.statusKind === 'CONNECTED') {
      await this.updateConnectedState(trackedAccount, options);
    } else if (trackedAccount.statusKind === 'CONNECTING') {
      this.state.phase = this.state.phase === PHASE.DISCONNECTING ? PHASE.DISCONNECTING : PHASE.CONNECTING;
    } else if (trackedAccount.statusKind === 'DISCONNECTED') {
      if (this.state.phase === PHASE.DISCONNECTING) {
        await this.finishDisconnectCleanup();
      } else if (this.state.phase === PHASE.CONNECTING || this.state.phase === PHASE.CONNECTED) {
        if (this.state.accountOwnership === 'managed_raw') {
          await this.safeDeleteManagedAccount(this.state.accountName);
        }
        await this.setErrorState('CONNECT_FAILED', 'SoftEther account는 생성됐지만 연결이 완료되지 않았습니다.');
      } else {
        await this.transitionToIdle();
      }
    }

    if (includeNetwork) {
      await this.refreshNetworkState(options);
    }

    this.statusCache = {
      observedAtMs: Date.now(),
    };
    await this.saveState();
    return this.state;
  }

  async updateConnectedState(trackedAccount, options = {}) {
    this.state.phase = PHASE.CONNECTED;
    this.state.lastErrorCode = '';
    this.state.lastErrorMessage = '';

    try {
      const accountStatus = await this.softEtherCli.getAccountStatus(trackedAccount.name);
      this.state.connectedAt = accountStatus.connectedAt || this.state.connectedAt;
      this.state.underlayProtocol = accountStatus.underlayProtocol || this.state.underlayProtocol;
      this.state.udpAccelerationActive = accountStatus.udpAccelerationActive === true;
    } catch {
      // status 상세 조회 실패는 phase 자체를 깨지 않게 둔다.
    }

    if (options.includeNetwork !== false) {
      await this.refreshNetworkState(options);
    }
  }

  async refreshNetworkState(options = {}) {
    const localSnapshot = await this.networkObserver.getLocalSnapshot({
      force: options.force === true,
    });
    const publicIp = options.includePublicIp === false
      ? await this.networkObserver.getPublicIp({
        force: false,
        allowStale: true,
        allowEmpty: true,
      })
      : await this.networkObserver.getPublicIp({
        force: options.forceNetworkIp === true,
        allowStale: options.forceNetworkIp !== true,
      });

    this.state.networkObservedAt = String(localSnapshot.observedAt || new Date().toISOString());
    this.state.currentPublicIp = String(publicIp.ip || '').trim();
    this.state.publicIpProvider = String(publicIp.provider || '').trim();

    if (this.state.baseline) {
      const diff = compareBaseline(this.state.baseline, localSnapshot, publicIp);
      this.state.publicIpBefore = diff.publicIpBefore;
      this.state.publicIpAfter = diff.publicIpAfter;
      this.state.ipv4DefaultRouteChanged = diff.ipv4DefaultRouteChanged;
      this.state.ipv6DefaultRouteChanged = diff.ipv6DefaultRouteChanged;
      this.state.dnsChanged = diff.dnsChanged;
    }
  }

  async refreshPublicIp(options = {}) {
    const publicIp = await this.networkObserver.getPublicIp({
      force: options.force === true,
      allowStale: options.allowStale !== false,
    });

    this.state.currentPublicIp = String(publicIp.ip || '').trim();
    this.state.publicIpProvider = String(publicIp.provider || '').trim();

    if (this.state.baseline && this.state.currentPublicIp) {
      this.state.publicIpAfter = this.state.currentPublicIp;
    }

    await this.saveState();
    return publicIp;
  }

  resolveTrackedAccount(accountRows = []) {
    if (this.state.accountName) {
      const exact = accountRows.find(row => row.name === this.state.accountName);
      if (exact) {
        return exact;
      }
    }

    const activeManagedAccounts = accountRows.filter((row) => (
      isManagedAccountName(row.name)
      && ['CONNECTED', 'CONNECTING'].includes(row.statusKind)
    ));

    if (this.state.accountOwnership === 'managed_raw') {
      return activeManagedAccounts[0] || null;
    }

    if (!this.state.accountName && activeManagedAccounts.length === 1) {
      return activeManagedAccounts[0];
    }

    return null;
  }

  findActiveManagedAccounts(accountRows = []) {
    return accountRows.filter((row) => (
      isManagedAccountName(row.name)
      && ['CONNECTED', 'CONNECTING'].includes(row.statusKind)
    ));
  }

  adoptTrackedAccount(accountRow = {}) {
    if (!accountRow?.name) {
      return;
    }

    this.state.accountName = accountRow.name;
    if (isManagedAccountName(accountRow.name)) {
      this.state.accountOwnership = 'managed_raw';
      this.state.accountProvisioning = false;
      this.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
      this.state.profileId = this.state.profileId
        || buildCompatibilityProfileId(accountRow.host || accountRow.name, accountRow.port || 0);

      if (!this.state.activeRelayIp && !this.state.activeRelayFqdn) {
        if (accountRow.host && isIP(accountRow.host) > 0) {
          this.state.activeRelayIp = accountRow.host;
        } else if (accountRow.host) {
          this.state.activeRelayFqdn = accountRow.host;
        }
      }

      if (!this.state.activeSelectedSslPort && accountRow.port) {
        this.state.activeSelectedSslPort = accountRow.port;
      }
    }
  }

  findForeignBusyAccount(accountRows = [], request = {}) {
    return accountRows.find((row) => {
      if (!row.name) {
        return false;
      }

      if (row.name === this.state.accountName) {
        return false;
      }

      if (isManagedAccountName(row.name)) {
        return false;
      }

      if (request.mode === CONNECTION_MODE.PROFILE && row.name === request.profileId) {
        return false;
      }

      return ['CONNECTED', 'CONNECTING'].includes(row.statusKind);
    }) || null;
  }

  findConflictingManagedBusyAccounts(accountRows = []) {
    return accountRows.filter((row) => (
      isManagedAccountName(row.name)
      && row.name !== this.state.accountName
      && ['CONNECTED', 'CONNECTING'].includes(row.statusKind)
    ));
  }

  async findAccountByName(accountName) {
    const cached = this.state.accountRows.find(row => row.name === accountName);
    if (cached) {
      return cached;
    }

    const rows = await this.softEtherCli.listAccounts();
    return rows.find(row => row.name === accountName) || null;
  }

  async finishDisconnectCleanup() {
    if (this.state.accountOwnership === 'managed_raw' && this.state.accountName) {
      await this.safeDeleteManagedAccount(this.state.accountName);
    }

    await this.transitionToIdle();
  }

  async safeDeleteManagedAccount(accountName) {
    if (!accountName || !isManagedAccountName(accountName)) {
      return;
    }

    try {
      await this.softEtherCli.disconnectAccount(accountName);
    } catch {
      // 이미 끊겼거나 아직 세션이 안 올라온 계정이면 그대로 삭제를 시도한다.
    }

    try {
      await this.softEtherCli.deleteAccount(accountName);
    } catch {
      // stale account 삭제 실패는 다음 refresh 때 다시 시도한다.
    }
  }

  isCurrentOperation(operationId, phase) {
    return String(this.state.operationId || '') === String(operationId || '')
      && this.state.phase === phase;
  }

  async transitionToIdle(reason = '') {
    this.state.phase = PHASE.IDLE;
    this.state.operationId = '';
    this.state.connectionMode = CONNECTION_MODE.PROFILE;
    this.state.profileId = '';
    this.state.accountName = '';
    this.state.accountOwnership = '';
    this.state.accountProvisioning = false;
    this.state.activeRelayId = '';
    this.state.activeRelayIp = '';
    this.state.activeRelayFqdn = '';
    this.state.activeSelectedSslPort = 0;
    this.state.activeAdapterName = '';
    this.state.connectedAt = '';
    this.state.underlayProtocol = '';
    this.state.udpAccelerationActive = false;
    this.state.ipv4DefaultRouteChanged = false;
    this.state.ipv6DefaultRouteChanged = false;
    this.state.dnsChanged = false;
    this.state.baseline = null;
    this.state.publicIpBefore = '';
    this.state.publicIpAfter = '';
    this.state.lastErrorCode = '';
    this.state.lastErrorMessage = reason ? String(reason) : '';
    await this.saveState();
  }

  async setErrorState(code, message) {
    this.state.phase = PHASE.ERROR;
    this.state.lastErrorCode = String(code || '').trim();
    this.state.lastErrorMessage = String(message || '').trim();
    await this.saveState();
  }

  ensureBackgroundMonitor() {
    if (this.monitorTimer) {
      return;
    }

    const run = async () => {
      this.monitorTimer = null;
      try {
        await this.refreshState({ force: false, includeNetwork: false });
      } catch {
        // refreshState 내부에서 상태를 저장하므로 여기서는 삼킨다.
      }

      if ([PHASE.CONNECTING, PHASE.DISCONNECTING].includes(this.state.phase)) {
        this.monitorTimer = setTimeout(() => {
          run();
        }, DEFAULT_MONITOR_INTERVAL_MS);
      }
    };

    this.monitorTimer = setTimeout(() => {
      run();
    }, DEFAULT_MONITOR_INTERVAL_MS);
  }

  async loadState() {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        ...buildInitialState(this.managedNicName),
        ...parsed,
        managedNicName: this.managedNicName,
      };
    } catch {
      this.state = buildInitialState(this.managedNicName);
    }
  }

  async saveState() {
    const persistedState = {
      ...this.state,
      accountRows: [],
      nicRows: [],
    };
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, `${JSON.stringify(persistedState, null, 2)}\n`, 'utf8');
  }

  async resetStateFile() {
    try {
      await rm(this.stateFile, { force: true });
    } catch {
      // ignore
    }
  }

  async runSerializedAction(action) {
    const previous = this.actionQueue;
    let release = () => {};
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.actionQueue = current;

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.actionQueue === current) {
        this.actionQueue = Promise.resolve();
      }
    }
  }
}

function buildInitialState(managedNicName) {
  return {
    phase: PHASE.IDLE,
    operationId: '',
    connectionMode: CONNECTION_MODE.PROFILE,
    profileId: '',
    accountName: '',
    accountOwnership: '',
    accountProvisioning: false,
    activeRelayId: '',
    activeRelayIp: '',
    activeRelayFqdn: '',
    activeSelectedSslPort: 0,
    activeAdapterName: '',
    publicIpBefore: '',
    publicIpAfter: '',
    currentPublicIp: '',
    publicIpProvider: '',
    ipv4DefaultRouteChanged: false,
    ipv6DefaultRouteChanged: false,
    dnsChanged: false,
    connectedAt: '',
    lastErrorCode: '',
    lastErrorMessage: '',
    underlayProtocol: '',
    udpAccelerationActive: false,
    baseline: null,
    networkObservedAt: '',
    managedNicName,
    accountRows: [],
    nicRows: [],
  };
}

function normalizeConnectRequest(payload = {}) {
  const mode = normalizeConnectionMode(payload.mode || payload.connectionMode);
  const profileId = String(payload.profileId || '').trim();

  if (mode === CONNECTION_MODE.PROFILE) {
    if (!profileId) {
      throw httpError(400, 'PROFILE_ID_REQUIRED', 'profile 모드에서는 profileId가 필요합니다.');
    }

    if (profileId.includes('"')) {
      throw httpError(400, 'PROFILE_ID_INVALID', 'profileId에는 큰따옴표(\")를 넣을 수 없습니다.');
    }

    return {
      mode,
      profileId,
    };
  }

  const relay = payload.relay && typeof payload.relay === 'object' ? payload.relay : {};
  const relayId = String(relay.id ?? '').trim();
  const relayFqdn = String(relay.fqdn || '').trim();
  const relayIp = String(relay.ip || '').trim();
  const relayHost = relayIp || relayFqdn;
  const selectedSslPort = normalizePort(relay.selectedSslPort, 0);
  const sslPorts = buildRelayPortAttemptList({
    selectedSslPort,
    sslPorts: relay.sslPorts,
  });

  if (!relayHost) {
    throw httpError(400, 'RELAY_HOST_REQUIRED', 'raw 모드에서는 relay.ip 또는 relay.fqdn 이 필요합니다.');
  }

  if (!selectedSslPort) {
    throw httpError(400, 'RELAY_PORT_REQUIRED', 'raw 모드에서는 relay.selectedSslPort 가 필요합니다.');
  }

  if (relayIp && isIP(relayIp) === 0) {
    throw httpError(400, 'RELAY_IP_INVALID', 'relay.ip 형식이 올바른 IPv4/IPv6 주소가 아닙니다.');
  }

  if (!relayIp && relayFqdn && !isLikelyHostname(relayFqdn)) {
    throw httpError(400, 'RELAY_FQDN_INVALID', 'relay.fqdn 형식이 올바르지 않습니다.');
  }

  const hostUniqueKey = String(relay.hostUniqueKey || '').trim().toUpperCase();
  if (hostUniqueKey && !/^[0-9A-F]{40}$/.test(hostUniqueKey)) {
    throw httpError(400, 'HOST_UNIQUE_KEY_INVALID', 'relay.hostUniqueKey 는 40자리 HEX 문자열이어야 합니다.');
  }

  const normalizedProfileId = profileId || buildCompatibilityProfileId(relayId || relayHost, selectedSslPort);

  return {
    mode,
    profileId: normalizedProfileId,
    relay: {
      id: relayId,
      fqdn: relayFqdn,
      ip: relayIp,
      selectedSslPort,
      sslPorts,
      udpPort: normalizePort(relay.udpPort, 0),
      hostUniqueKey,
    },
  };
}

function normalizeConnectionMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === CONNECTION_MODE.SOFTETHER_VPNGATE_RAW
    ? CONNECTION_MODE.SOFTETHER_VPNGATE_RAW
    : CONNECTION_MODE.PROFILE;
}

function isLikelyHostname(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 253) {
    return false;
  }

  if (!/^[A-Za-z0-9.-]+$/.test(normalized)) {
    return false;
  }

  if (normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) {
    return false;
  }

  return normalized.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
  ));
}

function buildCompatibilityProfileId(relayToken, port) {
  return `vpngate-${sanitizeManagedToken(relayToken)}-${port}`;
}

function buildOperationId(prefix = 'op') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePort(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Number.parseInt(String(fallback ?? 1), 10) || 1);
  }

  return parsed;
}

function normalizePortList(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\s,]+/)
      .filter(Boolean);
  const normalized = [];
  const seen = new Set();
  for (const rawValue of rawValues) {
    const port = normalizePort(rawValue, 0);
    if (!port || seen.has(port)) {
      continue;
    }
    seen.add(port);
    normalized.push(port);
  }
  return normalized;
}

function buildRelayPortAttemptList(relay = {}) {
  const selectedSslPort = normalizePort(relay.selectedSslPort, 0);
  const sslPorts = normalizePortList(relay.sslPorts);
  if (!selectedSslPort) {
    return sslPorts;
  }

  return [
    selectedSslPort,
    ...sslPorts.filter(port => port !== selectedSslPort),
  ];
}

function httpError(statusCode, code, message) {
  const error = new Error(String(message || '').trim() || '요청 처리 실패');
  error.statusCode = statusCode;
  error.code = String(code || '').trim() || 'ERROR';
  return error;
}

function buildCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, X-DefenseSuite-Token, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function extractTokenFromRequest(request) {
  const authHeader = String(request.headers.authorization || '').trim();
  if (/^bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^bearer\s+/i, '').trim();
  }

  return String(request.headers['x-defensesuite-token'] || '').trim();
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > DEFAULT_REQUEST_BODY_LIMIT_BYTES) {
      throw httpError(413, 'REQUEST_TOO_LARGE', '요청 바디가 너무 큽니다.');
    }
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw httpError(400, 'INVALID_JSON', 'JSON 요청 바디를 해석하지 못했습니다.');
  }
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    ...buildCorsHeaders(),
  });
  response.end(body);
}

async function main() {
  const agent = new SelfHostedVpnAgent({
    host: process.env.HOST || DEFAULT_HOST,
    port: process.env.PORT || DEFAULT_PORT,
    authToken: process.env.SELF_HOSTED_VPN_TOKEN || DEFAULT_TOKEN,
    managedNicName: process.env.SELF_HOSTED_VPN_NIC_NAME || DEFAULT_MANAGED_NIC_NAME,
    stateFile: process.env.SELF_HOSTED_VPN_STATE_FILE || DEFAULT_STATE_FILE,
    vpncmdPath: process.env.SELF_HOSTED_VPN_VPNCMD_PATH || DEFAULT_VPNCMD_PATH,
  });

  await agent.init();

  const server = http.createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 404, {
        error: 'NOT_FOUND',
        message: '요청 경로가 없습니다.',
      });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, buildCorsHeaders());
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || `${agent.host}:${agent.port}`}`);
    const tokenRequired = Boolean(agent.authToken);
    const requestToken = extractTokenFromRequest(request);
    if (tokenRequired && requestToken !== agent.authToken) {
      sendJson(response, 401, {
        error: 'UNAUTHORIZED',
        message: 'local agent 인증 토큰이 일치하지 않습니다.',
      });
      return;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, await agent.getHealth());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/vpn/status') {
        sendJson(response, 200, await agent.getStatus());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/vpn/egress') {
        sendJson(response, 200, await agent.getEgress());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/connect') {
        sendJson(response, 200, await agent.connect(await readJsonBody(request)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/disconnect') {
        sendJson(response, 200, await agent.disconnect());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/') {
        sendJson(response, 200, {
          ok: true,
          message: 'Self-hosted VPN local agent',
          config: agent.getRuntimeConfig(),
        });
        return;
      }

      sendJson(response, 404, {
        error: 'NOT_FOUND',
        message: `지원하지 않는 경로입니다: ${request.method} ${url.pathname}`,
      });
    } catch (error) {
      const statusCode = normalizePort(error?.statusCode, 500) || 500;
      sendJson(response, statusCode, {
        accepted: false,
        error: String(error?.code || 'INTERNAL_ERROR'),
        message: String(error?.message || '알 수 없는 오류'),
      });
    }
  });

  server.listen(agent.port, agent.host, () => {
    const runtimeConfig = agent.getRuntimeConfig();
    console.log(`[self-hosted-vpn-agent] listening on http://${runtimeConfig.host}:${runtimeConfig.port}`);
    console.log(`[self-hosted-vpn-agent] vpncmd path: ${runtimeConfig.vpncmdPath}`);
    console.log(`[self-hosted-vpn-agent] managed nic: ${runtimeConfig.managedNicName}`);
    console.log(`[self-hosted-vpn-agent] state file: ${runtimeConfig.stateFile}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('[self-hosted-vpn-agent] fatal:', error?.message || error);
    process.exitCode = 1;
  });
}

export {
  CONNECTION_MODE,
  DEFAULT_MANAGED_NIC_NAME,
  DEFAULT_STATE_FILE,
  PHASE,
  SelfHostedVpnAgent,
  buildCompatibilityProfileId,
  buildInitialState,
  extractTokenFromRequest,
  httpError,
  normalizeConnectRequest,
  normalizeConnectionMode,
};
