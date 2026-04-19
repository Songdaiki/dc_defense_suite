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
  buildRawCatalogAccountName,
  buildManagedAccountName,
  isManagedAccountName,
  isRawCatalogAccountName,
  normalizePreferredSoftEtherNicName,
  normalizeSoftEtherMaxNicIndex,
  sanitizeManagedToken,
} from './lib/softether_cli.mjs';
import {
  applyInterfaceMetricPlan,
  collectInterfaceMetrics,
  NetworkObserver,
  buildBaseline,
  compareBaseline,
  probeFreshPublicIpv4,
  restoreInterfaceMetrics,
} from './lib/network_state.mjs';
import {
  DEFAULT_PREFERRED_COUNTRIES,
  DEFAULT_PREFERRED_PORTS,
  fetchOfficialVpnGateRelayCatalog,
  fetchOfficialVpnGateRelays,
} from './lib/vpngate_feed.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const DEFAULT_MANAGED_NIC_NAME = 'VPN2';
const DEFAULT_STATE_DIR = path.join(os.tmpdir(), 'dc-defense-suite');
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, 'self-hosted-vpn-agent-state.json');
const DEFAULT_TOKEN = String(process.env.SELF_HOSTED_VPN_TOKEN || '').trim();
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 128 * 1024;
const DEFAULT_MONITOR_INTERVAL_MS = 1200;
const DEFAULT_HEALTH_CACHE_TTL_MS = 15_000;
const DEFAULT_CONNECT_SETTLE_TIMEOUT_MS = 75_000;
const DEFAULT_DISCONNECT_SETTLE_TIMEOUT_MS = 45_000;
const DEFAULT_CONNECT_BASELINE_CACHE_TTL_MS = 60_000;
const DEFAULT_RAW_RELAY_CATALOG_LIMIT = 200;
const DEFAULT_RAW_LIVE_POOL_LOGICAL_SLOT_COUNT = 200;
const DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT = 200;
const DEFAULT_RAW_LIVE_POOL_NIC_PREPARE_CONCURRENCY = 8;
const DEFAULT_RAW_LIVE_POOL_CONNECT_CONCURRENCY = 24;
const DEFAULT_RAW_LIVE_POOL_STATUS_POLL_INTERVAL_MS = 1000;
const DEFAULT_RAW_LIVE_POOL_VERIFY_CONCURRENCY = 1;
const DEFAULT_RAW_LIVE_POOL_CONNECT_TIMEOUT_MS = 45_000;
const DEFAULT_RAW_LIVE_POOL_EXPERIMENTAL_MAX_NIC_INDEX = 200;
const DEFAULT_RAW_LIVE_POOL_TERMINAL_POLL_INTERVAL_MS = 200;
const DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES = Object.freeze(['VPN2', 'VPN3', 'VPN4']);
const DEFAULT_PARALLEL_PROBE_CONNECT_TIMEOUT_MS = 45_000;
const DEFAULT_PARALLEL_PROBE_ROUTE_SETTLE_MS = 1500;
const PARALLEL_PROBE_ACCOUNT_PREFIX = 'DCDSVPNPROBE-';
const RAW_RELAY_CATALOG_STAGE = {
  IDLE: 'IDLE',
  FETCHING_FEED: 'FETCHING_FEED',
  PREPARING_NICS: 'PREPARING_NICS',
  CONNECTING_SLOTS: 'CONNECTING_SLOTS',
  VERIFYING_SLOTS: 'VERIFYING_SLOTS',
  READY: 'READY',
};
const CONNECTION_MODE = {
  PROFILE: 'profile',
  SOFTETHER_VPNGATE_RAW: 'softether_vpngate_raw',
};
const PHASE = {
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  READY: 'READY',
  SWITCHING: 'SWITCHING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  ERROR: 'ERROR',
};
const PARALLEL_PROBE_PHASE = {
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  CONNECTING: 'CONNECTING',
  VERIFYING: 'VERIFYING',
  COMPLETE: 'COMPLETE',
  STOPPING: 'STOPPING',
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
      serializeCommands: true,
    });
    this.routeCli = this.softEtherCli;
    this.statusCli = new SoftEtherCli({
      vpncmdPath: options.vpncmdPath || DEFAULT_VPNCMD_PATH,
      timeoutMs: normalizePositiveInteger(options.vpncmdTimeoutMs, 15000),
      serializeCommands: false,
    });
    this.provisionCliOptions = {
      vpncmdPath: options.vpncmdPath || DEFAULT_VPNCMD_PATH,
      timeoutMs: normalizePositiveInteger(options.vpncmdTimeoutMs, 15000),
      serializeCommands: false,
    };
    this.networkObserver = new NetworkObserver();

    this.state = buildInitialState(this.managedNicName);
    this.healthCache = null;
    this.refreshPromise = null;
    this.actionQueue = Promise.resolve();
    this.monitorTimer = null;
    this.statusCache = null;
    this.softEtherMutationInFlight = false;
    this.stateSaveQueue = Promise.resolve();
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
    if (this.healthCache && (Date.now() - this.healthCache.observedAtMs) < DEFAULT_HEALTH_CACHE_TTL_MS) {
      return this.healthCache.value;
    }

    let ok = false;
    let message = '';
    let vpncmdExists = false;
    try {
      vpncmdExists = await this.softEtherCli.isAvailable();
      if (!vpncmdExists) {
        message = `vpncmd.exe 경로를 찾지 못했습니다: ${this.softEtherCli.vpncmdPath}`;
      } else {
        ok = true;
      }
    } catch (error) {
      message = String(error?.message || 'local agent health 확인 실패');
    }

    const value = {
      ok,
      agentVersion: '0.1.0',
      message,
      managedNicName: this.managedNicName,
      vpncmdPath: this.softEtherCli.vpncmdPath,
      softEtherReady: vpncmdExists,
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
    reconcileRawRelayCatalogState(this.state);

    const response = {
      phase: this.state.phase,
      operationId: this.state.operationId,
      catalogEnabled: Boolean(this.state.catalogEnabled),
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
      rawRelayCatalog: buildPublicRawRelayCatalogState(this.state.rawRelayCatalog, this.state),
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

  async getParallelProbeStatus() {
    return buildPublicParallelProbeState(this.state.parallelProbe);
  }

  async startParallelProbe(payload = {}) {
    return this.runSerializedAction(async () => {
      await this.refreshState({ force: true, includeNetwork: false });
      const request = normalizeParallelProbeRequest(payload);

      if (this.state.catalogEnabled && Array.isArray(this.state.rawRelayCatalog?.items) && this.state.rawRelayCatalog.items.length > 0) {
        throw httpError(409, 'RAW_LIVE_POOL_ACTIVE', 'raw live pool이 살아 있을 때는 병렬 3슬롯 시험을 시작할 수 없습니다. 먼저 토글 OFF로 정리하세요.');
      }

      const conflictingManagedBusyAccounts = this.findConflictingManagedBusyAccounts(this.state.accountRows);
      if (conflictingManagedBusyAccounts.length > 0) {
        throw httpError(
          409,
          'MULTIPLE_MANAGED_ACCOUNTS',
          `관리용 SoftEther account가 이미 활성화되어 있습니다. 먼저 정리하세요: ${conflictingManagedBusyAccounts.map(row => row.name).join(', ')}`,
        );
      }

      const foreignBusyAccount = this.findForeignBusyAccount(this.state.accountRows, {});
      if (foreignBusyAccount) {
        throw httpError(
          409,
          'SOFTETHER_FOREIGN_ACCOUNT_ACTIVE',
          `SoftEther Client에 다른 연결이 살아 있습니다. 먼저 수동 연결을 끊으세요: ${foreignBusyAccount.name}`,
        );
      }

      if ([PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(this.state.phase)) {
        throw httpError(409, 'VPN_ALREADY_ACTIVE', `단일 VPN 연결이 이미 실행 중입니다. phase=${this.state.phase}`);
      }

      if (isParallelProbeActivePhase(this.state.parallelProbe?.phase)) {
        return {
          accepted: true,
          ...buildPublicParallelProbeState(this.state.parallelProbe),
        };
      }

      const operationId = buildOperationId('probe');
      this.state.parallelProbe = {
        ...buildInitialParallelProbeState(),
        isRunning: true,
        operationId,
        phase: PARALLEL_PROBE_PHASE.PREPARING,
        startedAt: new Date().toISOString(),
        request,
      };
      appendParallelProbeLog(this.state.parallelProbe, '병렬 3슬롯 시험 시작 요청 수락');
      await this.saveState();

      void this.executeParallelProbeStart({
        operationId,
        request,
      });

      return {
        accepted: true,
        ...buildPublicParallelProbeState(this.state.parallelProbe),
      };
    });
  }

  async stopParallelProbe() {
    return this.runSerializedAction(async () => {
      if (!isParallelProbeActivePhase(this.state.parallelProbe?.phase)) {
        const currentProbe = buildPublicParallelProbeState(this.state.parallelProbe);
        this.state.parallelProbe = {
          ...buildInitialParallelProbeState(),
          logs: currentProbe.logs,
        };
        await this.saveState();
        return {
          accepted: true,
          ...buildPublicParallelProbeState(this.state.parallelProbe),
        };
      }

      this.state.parallelProbe.phase = PARALLEL_PROBE_PHASE.STOPPING;
      appendParallelProbeLog(this.state.parallelProbe, '병렬 3슬롯 시험 종료 요청 수락');
      await this.saveState();

      void this.executeParallelProbeStop({
        operationId: String(this.state.parallelProbe?.operationId || '').trim(),
      });

      return {
        accepted: true,
        ...buildPublicParallelProbeState(this.state.parallelProbe),
      };
    });
  }

  async prepareRawRelayCatalog(payload = {}) {
    return this.runSerializedAction(async () => {
      await this.refreshState({ force: true, includeNetwork: false });
      const request = normalizeRawRelayCatalogPrepareRequest(payload);

      if (isParallelProbeActivePhase(this.state.parallelProbe?.phase)) {
        throw httpError(409, 'PARALLEL_PROBE_ACTIVE', '병렬 3슬롯 시험이 실행 중일 때는 raw 목록 준비를 시작할 수 없습니다.');
      }

      if ([PHASE.CONNECTING, PHASE.DISCONNECTING].includes(this.state.phase)) {
        throw httpError(409, 'VPN_ALREADY_ACTIVE', `VPN 연결이 활성 상태일 때는 raw 목록 준비를 시작할 수 없습니다. phase=${this.state.phase}`);
      }

      const foreignBusyAccount = this.findForeignBusyAccount(this.state.accountRows, {});
      if (foreignBusyAccount) {
        throw httpError(
          409,
          'SOFTETHER_FOREIGN_ACCOUNT_ACTIVE',
          `SoftEther Client에 다른 연결이 살아 있습니다. 먼저 수동 연결을 끊으세요: ${foreignBusyAccount.name}`,
        );
      }

      const conflictingManagedBusyAccounts = this.findConflictingManagedBusyAccounts(this.state.accountRows);
      if (conflictingManagedBusyAccounts.length > 0) {
        throw httpError(
          409,
          'SOFTETHER_AGENT_ACCOUNT_ACTIVE',
          `agent 관리용 SoftEther 연결이 이미 살아 있습니다. 먼저 정리하세요: ${conflictingManagedBusyAccounts.map(row => row.name).join(', ')}`,
        );
      }

      if (this.state.catalogEnabled
        && [PHASE.PREPARING, PHASE.READY, PHASE.SWITCHING, PHASE.CONNECTED].includes(this.state.phase)
        && Array.isArray(this.state.rawRelayCatalog?.items)
        && this.state.rawRelayCatalog.items.length > 0) {
        return {
          accepted: true,
          phase: this.state.phase,
          operationId: this.state.operationId,
          catalogEnabled: true,
          rawRelayCatalog: buildPublicRawRelayCatalogState(this.state.rawRelayCatalog, this.state),
        };
      }

      this.state.operationId = buildOperationId('catalog');
      this.state.catalogEnabled = true;
      this.state.phase = PHASE.PREPARING;
      this.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
      this.clearRawLivePoolActiveState({ preserveBaseline: false });
      this.state.lastErrorCode = '';
      this.state.lastErrorMessage = '';
      this.state.rawRelayCatalog = {
        ...buildInitialRawRelayCatalogState(),
        phase: PHASE.PREPARING,
        stage: RAW_RELAY_CATALOG_STAGE.FETCHING_FEED,
        startedAt: new Date().toISOString(),
        requestedCandidateCount: request.limit,
        logicalSlotCount: request.logicalSlotCount,
        requestedPhysicalNicCount: request.requestedPhysicalNicCount,
        request,
      };
      appendRawRelayCatalogLog(
        this.state.rawRelayCatalog,
        `raw catalog 준비 시작 (후보=${request.limit}, logical=${request.logicalSlotCount}, requested NIC=${request.requestedPhysicalNicCount})`,
      );
      await this.saveState();
      this.softEtherMutationInFlight = true;

      void this.executeRawRelayCatalogPrepare({
        operationId: this.state.operationId,
        request,
      });

      return {
        accepted: true,
        phase: this.state.phase,
        operationId: this.state.operationId,
        catalogEnabled: true,
        rawRelayCatalog: buildPublicRawRelayCatalogState(this.state.rawRelayCatalog, this.state),
      };
    });
  }

  async primeRawCatalogNics(payload = {}) {
    return this.runSerializedAction(async () => {
      await this.refreshState({ force: true, includeNetwork: false });
      const request = normalizeRawRelayCatalogPrepareRequest(payload);

      if (isParallelProbeActivePhase(this.state.parallelProbe?.phase)) {
        throw httpError(409, 'PARALLEL_PROBE_ACTIVE', '병렬 3슬롯 시험이 실행 중일 때는 NIC 준비만 따로 실행할 수 없습니다.');
      }

      if (this.state.catalogEnabled || [PHASE.PREPARING, PHASE.CONNECTING, PHASE.DISCONNECTING, PHASE.SWITCHING, PHASE.CONNECTED].includes(this.state.phase)) {
        throw httpError(409, 'VPN_BUSY', `raw 목록 준비/연결이 활성 상태일 때는 NIC 준비만 따로 실행할 수 없습니다. phase=${this.state.phase}`);
      }

      const nicInventory = await this.ensureRawCatalogNicInventory(request);
      return {
        accepted: true,
        requestedPhysicalNicCount: request.requestedPhysicalNicCount,
        experimentalMaxNicIndex: request.experimentalMaxNicIndex,
        nicPrepareConcurrency: nicInventory.concurrency,
        existingNicCount: nicInventory.existingNicNames.length,
        attemptedCreateCount: nicInventory.missingNicNames.length,
        createdNicCount: nicInventory.createdNicNames.length,
        preparedNicCount: nicInventory.preparedNicNames.length,
        remainingMissingCount: nicInventory.failedNicNames.length,
        preparedNicNames: nicInventory.preparedNicNames,
        createdNicNames: nicInventory.createdNicNames,
        remainingMissingNicNames: nicInventory.failedNicNames,
      };
    });
  }

  async activateCatalogRelay(payload = {}) {
    return this.runSerializedAction(async () => {
      await this.refreshState({ force: true, includeNetwork: false });
      const request = normalizeConnectRequest({
        mode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
        relay: payload?.relay && typeof payload.relay === 'object' ? payload.relay : payload,
      });

      if (isParallelProbeActivePhase(this.state.parallelProbe?.phase)) {
        throw httpError(409, 'PARALLEL_PROBE_ACTIVE', '병렬 3슬롯 시험이 실행 중일 때는 raw 릴레이 연결을 시작할 수 없습니다.');
      }

      if ([PHASE.PREPARING, PHASE.CONNECTING, PHASE.DISCONNECTING, PHASE.SWITCHING].includes(this.state.phase)) {
        throw httpError(409, 'VPN_BUSY', `현재 상태에서는 raw 릴레이 연결을 시작할 수 없습니다. phase=${this.state.phase}`);
      }

      if (!this.state.catalogEnabled || !Array.isArray(this.state.rawRelayCatalog?.items) || this.state.rawRelayCatalog.items.length <= 0) {
        throw httpError(409, 'RAW_CATALOG_NOT_READY', 'raw 목록이 아직 준비되지 않았습니다. 먼저 토글 ON으로 목록을 준비하세요.');
      }

      const catalogItem = this.findRawRelayCatalogItem(request.relay);
      if (!catalogItem) {
        throw httpError(404, 'RAW_CATALOG_ITEM_NOT_FOUND', '선택한 raw 릴레이를 현재 catalog에서 찾지 못했습니다. 먼저 목록을 다시 준비하세요.');
      }

      if (catalogItem.poolState !== 'VERIFIED' || catalogItem.accountStatusKind !== 'CONNECTED') {
        throw httpError(409, 'RAW_CATALOG_SLOT_NOT_READY', '선택한 slot은 아직 검증 통과 상태가 아닙니다. 다시 준비한 뒤 시도하세요.');
      }

      if (catalogItem.slotId && catalogItem.slotId === this.state.rawRelayCatalog.activeSlotId && this.state.phase === PHASE.CONNECTED) {
        return {
          accepted: true,
          operationId: '',
          phase: PHASE.CONNECTED,
          catalogEnabled: true,
          profileId: this.state.profileId,
          relay: {
            id: this.state.activeRelayId,
            fqdn: this.state.activeRelayFqdn,
            ip: this.state.activeRelayIp,
            selectedSslPort: this.state.activeSelectedSslPort,
          },
          rawRelayCatalog: buildPublicRawRelayCatalogState(this.state.rawRelayCatalog, this.state),
        };
      }

      const foreignBusyAccount = this.findForeignBusyAccount(this.state.accountRows, request);
      if (foreignBusyAccount) {
        throw httpError(
          409,
          'SOFTETHER_FOREIGN_ACCOUNT_ACTIVE',
          `SoftEther Client에 다른 연결이 살아 있습니다. 먼저 수동 연결을 끊으세요: ${foreignBusyAccount.name}`,
        );
      }

      const conflictingManagedBusyAccounts = this.findConflictingManagedBusyAccounts(this.state.accountRows);
      if (conflictingManagedBusyAccounts.length > 0) {
        throw httpError(
          409,
          'SOFTETHER_AGENT_ACCOUNT_ACTIVE',
          `agent 관리용 SoftEther 연결이 이미 살아 있습니다. 먼저 정리하세요: ${conflictingManagedBusyAccounts.map(row => row.name).join(', ')}`,
        );
      }

      this.state.operationId = buildOperationId('switch');
      this.state.phase = PHASE.SWITCHING;
      this.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
      this.state.lastErrorCode = '';
      this.state.lastErrorMessage = '';
      appendRawRelayCatalogLog(this.state.rawRelayCatalog, `owner 전환 시도 - ${catalogItem.slotId || '-'} / ${(catalogItem.ip || catalogItem.fqdn) || '-'}:${catalogItem.selectedSslPort || '-'}`);
      await this.saveState();

      void this.executeCatalogRelaySwitch({
        operationId: this.state.operationId,
        slotId: catalogItem.slotId,
        previousSlotId: this.state.rawRelayCatalog.activeSlotId,
      });
      this.ensureBackgroundMonitor();
      return {
        accepted: true,
        operationId: this.state.operationId,
        phase: PHASE.SWITCHING,
        catalogEnabled: true,
        profileId: this.state.profileId || buildCompatibilityProfileId(catalogItem.id || catalogItem.ip || catalogItem.fqdn, catalogItem.selectedSslPort),
        relay: {
          id: catalogItem.id,
          fqdn: catalogItem.fqdn,
          ip: catalogItem.ip,
          selectedSslPort: catalogItem.selectedSslPort,
        },
        rawRelayCatalog: buildPublicRawRelayCatalogState(this.state.rawRelayCatalog, this.state),
      };
    });
  }

  async connect(payload = {}) {
    return this.runSerializedAction(async () => {
      await this.refreshState({ force: true, includeNetwork: false });
      const request = normalizeConnectRequest(payload);

      if (this.state.catalogEnabled && Array.isArray(this.state.rawRelayCatalog?.items) && this.state.rawRelayCatalog.items.length > 0) {
        throw httpError(409, 'RAW_LIVE_POOL_ACTIVE', 'raw live pool이 활성 상태일 때는 단일 연결을 시작할 수 없습니다. 먼저 토글 OFF로 정리하세요.');
      }

      if (isParallelProbeActivePhase(this.state.parallelProbe?.phase)) {
        throw httpError(409, 'PARALLEL_PROBE_ACTIVE', '병렬 3슬롯 시험이 실행 중일 때는 단일 연결을 시작할 수 없습니다.');
      }

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
      const hasRawLivePool = Boolean(this.state.catalogEnabled)
        || (Array.isArray(this.state.rawRelayCatalog?.items) && this.state.rawRelayCatalog.items.length > 0);
      if (hasRawLivePool) {
        this.state.operationId = buildOperationId('disconnect');
        this.state.phase = PHASE.DISCONNECTING;
        this.state.lastErrorCode = '';
        this.state.lastErrorMessage = '';
        await this.saveState();

        void this.executeRawRelayCatalogDisconnect({
          operationId: this.state.operationId,
        });
        this.ensureBackgroundMonitor();
        return {
          accepted: true,
          operationId: this.state.operationId,
          phase: PHASE.DISCONNECTING,
          profileId: this.state.profileId || '',
          rawRelayCatalog: buildPublicRawRelayCatalogState(this.state.rawRelayCatalog, this.state),
        };
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

  async executeRawRelayCatalogPrepare(context = {}) {
    const { operationId, request } = context;
    this.softEtherMutationInFlight = true;
    let statusPoller = null;

    try {
      const adapterName = await this.ensureManagedNic();
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      this.state.activeAdapterName = adapterName;
      await this.restoreRawRelayCatalogMetrics({ swallowErrors: true });
      await this.cleanupAllRawCatalogAccounts();
      const baseline = await this.captureBaseline();
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      this.state.baseline = baseline;
      this.state.publicIpBefore = baseline.publicIp;
      this.state.publicIpAfter = '';
      this.state.currentPublicIp = '';
      this.state.publicIpProvider = '';
      this.setRawRelayCatalogStage(RAW_RELAY_CATALOG_STAGE.FETCHING_FEED);
      await this.saveState();

      const catalog = await fetchOfficialVpnGateRelayCatalog({
        limit: request.limit,
        preferredCountries: request.preferredCountries,
        preferredPorts: request.preferredPorts,
      });
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      const relayCandidates = Array.isArray(catalog.relays) ? catalog.relays : [];
      const logicalSlotCount = Math.min(
        Math.max(1, Number.parseInt(String(request.logicalSlotCount || 0), 10) || 1),
        relayCandidates.length,
      );
      const relayItems = buildRawLogicalSlotItems(relayCandidates, logicalSlotCount);
      const baselineMetricRows = await collectInterfaceMetrics();
      this.state.rawRelayCatalog = {
        ...normalizeRawRelayCatalogState(this.state.rawRelayCatalog),
        phase: PHASE.PREPARING,
        stage: RAW_RELAY_CATALOG_STAGE.FETCHING_FEED,
        startedAt: this.state.rawRelayCatalog.startedAt || new Date().toISOString(),
        sourceHostCount: Number(catalog.totalHosts || relayCandidates.length || 0),
        usableRelayCount: 0,
        requestedCandidateCount: request.limit,
        logicalSlotCount,
        requestedPhysicalNicCount: request.requestedPhysicalNicCount,
        detectedPhysicalNicCapacity: 0,
        preparedNicCount: 0,
        connectAttemptedCount: 0,
        provisionableSlotCount: 0,
        connectedSlotCount: 0,
        verifiedSlotCount: 0,
        deadSlotCount: 0,
        failedSlotCount: 0,
        capacityDeferredSlotCount: 0,
        request,
        baselineMetricRows,
        availableNicNames: [],
        preparedNicNames: [],
        slotQueue: [],
        items: buildRawRelayCatalogItems(relayItems, [], '', ''),
        logs: Array.isArray(this.state.rawRelayCatalog?.logs) ? this.state.rawRelayCatalog.logs.slice(0, 50) : [],
      };
      appendRawRelayCatalogLog(
        this.state.rawRelayCatalog,
        `live pool 후보 적재 완료 - 후보 ${relayCandidates.length} / logical slot ${logicalSlotCount}`,
      );
      await this.saveState();

      if (logicalSlotCount <= 0) {
        throw new Error('official raw feed 에서 usable relay 후보를 받지 못했습니다.');
      }

      const preparedNicNames = await this.prepareRawLivePoolNics(operationId, request);
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }
      appendRawRelayCatalogLog(
        this.state.rawRelayCatalog,
        `NIC warmup 완료 - requested ${request.requestedPhysicalNicCount} / prepared ${preparedNicNames.length} / deferred ${this.state.rawRelayCatalog.capacityDeferredSlotCount}`,
      );
      await this.saveState();

      statusPoller = this.startRawLivePoolStatusPoller(operationId, {
        pollIntervalMs: request.statusPollIntervalMs,
      });

      await this.connectRawRelayCatalogSlots(operationId, {
        concurrency: request.connectConcurrency,
        statusPollIntervalMs: request.statusPollIntervalMs,
        connectTimeoutMs: request.connectTimeoutMs,
      });
      if (statusPoller) {
        statusPoller.stop();
        await statusPoller.done.catch(() => {});
        statusPoller = null;
      }
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      try {
        this.state.accountRows = await this.statusCli.listAccounts();
        this.syncRawRelayCatalogStatuses(this.state.accountRows);
      } catch (error) {
        appendRawRelayCatalogLog(
          this.state.rawRelayCatalog,
          `최종 account 상태 동기화 실패 - ${String(error?.message || 'AccountList 실패')}`,
        );
      }
      const connectedSlotIds = this.state.rawRelayCatalog.items
        .filter(item => item.poolState === 'CONNECTED' && item.accountStatusKind === 'CONNECTED')
        .map(item => item.slotId)
        .filter(Boolean);
      this.setRawRelayCatalogStage(RAW_RELAY_CATALOG_STAGE.VERIFYING_SLOTS);
      appendRawRelayCatalogLog(
        this.state.rawRelayCatalog,
        `live pool 연결 단계 완료 - connect attempted ${this.state.rawRelayCatalog.connectAttemptedCount} / connected ${connectedSlotIds.length}`,
      );
      await this.saveState();

      for (const slotId of connectedSlotIds) {
        if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
          return;
        }

        await this.verifyRawRelayCatalogSlot(operationId, slotId);
      }
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      await this.restoreRawRelayCatalogMetrics({ swallowErrors: true });
      await this.refreshRawRelayCatalogRouteSnapshot({ operationId });
      this.clearRawLivePoolActiveState({ preserveBaseline: true });
      this.syncRawRelayCatalogSummary();

      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      this.state.accountRows = await this.softEtherCli.listAccounts();
      this.state.catalogEnabled = this.state.rawRelayCatalog.verifiedSlotCount > 0;
      this.state.phase = this.state.rawRelayCatalog.verifiedSlotCount > 0 ? PHASE.READY : PHASE.ERROR;
      this.state.operationId = '';
      this.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
      this.state.rawRelayCatalog = {
        ...normalizeRawRelayCatalogState(this.state.rawRelayCatalog),
        phase: this.state.rawRelayCatalog.verifiedSlotCount > 0 ? PHASE.READY : PHASE.ERROR,
        stage: this.state.rawRelayCatalog.verifiedSlotCount > 0
          ? RAW_RELAY_CATALOG_STAGE.READY
          : RAW_RELAY_CATALOG_STAGE.VERIFYING_SLOTS,
        completedAt: new Date().toISOString(),
        lastErrorCode: this.state.rawRelayCatalog.verifiedSlotCount > 0 ? '' : 'RAW_LIVE_POOL_EMPTY',
        lastErrorMessage: this.state.rawRelayCatalog.verifiedSlotCount > 0 ? '' : '검증 통과 슬롯이 0개라 live pool 준비에 실패했습니다.',
      };
      if (this.state.rawRelayCatalog.verifiedSlotCount > 0) {
        appendRawRelayCatalogLog(
          this.state.rawRelayCatalog,
          `live pool 준비 완료 - logical ${this.state.rawRelayCatalog.logicalSlotCount} / NIC ${this.state.rawRelayCatalog.preparedNicCount} / verified ${this.state.rawRelayCatalog.verifiedSlotCount}`,
        );
        this.state.lastErrorCode = '';
        this.state.lastErrorMessage = '';
      } else {
        this.state.lastErrorCode = 'RAW_LIVE_POOL_EMPTY';
        this.state.lastErrorMessage = this.state.rawRelayCatalog.lastErrorMessage;
      }
      await this.saveState();
    } catch (error) {
      if (statusPoller) {
        statusPoller.stop();
        await statusPoller.done.catch(() => {});
        statusPoller = null;
      }
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      await this.restoreRawRelayCatalogMetrics({ swallowErrors: true });
      await this.cleanupAllRawCatalogAccounts();
      this.clearRawLivePoolActiveState({ preserveBaseline: true });
      this.state.catalogEnabled = false;
      this.state.phase = PHASE.ERROR;
      this.state.lastErrorCode = 'RAW_CATALOG_PREPARE_FAILED';
      this.state.lastErrorMessage = String(error?.message || 'raw catalog 준비 실패');
      this.state.rawRelayCatalog = {
        ...normalizeRawRelayCatalogState(this.state.rawRelayCatalog),
        phase: PHASE.ERROR,
        completedAt: new Date().toISOString(),
        stage: String(this.state.rawRelayCatalog?.stage || RAW_RELAY_CATALOG_STAGE.IDLE).trim().toUpperCase() || RAW_RELAY_CATALOG_STAGE.IDLE,
        lastErrorCode: 'RAW_CATALOG_PREPARE_FAILED',
        lastErrorMessage: String(error?.message || 'raw catalog 준비 실패'),
      };
      appendRawRelayCatalogLog(this.state.rawRelayCatalog, `raw catalog 준비 실패 - ${this.state.lastErrorMessage}`);
      await this.saveState();
    } finally {
      if (statusPoller) {
        statusPoller.stop();
        await statusPoller.done.catch(() => {});
      }
      this.softEtherMutationInFlight = false;
    }
  }

  async provisionRawCatalogAccount(relay, nicName, accountName, options = {}) {
    const cli = options.cli || this.softEtherCli;
    const relayHost = String(relay?.ip || relay?.fqdn || '').trim();
    const relayPort = normalizePort(relay?.selectedSslPort, 0);
    if (!relayHost || !relayPort) {
      throw new Error('raw catalog 계정을 생성할 relay host/port 정보가 부족합니다.');
    }

    await this.safeDeleteRawCatalogAccount(accountName, { cli });
    await cli.createAccount({
      name: accountName,
      serverHost: relayHost,
      serverPort: relayPort,
      hubName: 'VPNGATE',
      username: 'VPN',
      nicName,
    });
    await cli.setAccountAnonymous(accountName);
    await cli.setAccountRetry(accountName, {
      numRetry: 0,
      retryInterval: 15,
    });
    await cli.disableServerCertCheck(accountName);
    await cli.setAccountDetails(accountName, {
      maxTcp: 1,
      additionalConnectionInterval: 1,
      connectionTtl: 0,
      halfDuplex: false,
      bridgeMode: false,
      monitorMode: false,
      noRoutingTracking: false,
      noQos: true,
    });
  }

  async executeCatalogRelaySwitch(context = {}) {
    const { operationId, slotId, previousSlotId } = context;
    this.softEtherMutationInFlight = true;

    try {
      const targetSlot = this.findRawRelayCatalogItem({ slotId });
      if (!targetSlot) {
        throw new Error(`owner 전환 대상 slot을 찾지 못했습니다: ${slotId}`);
      }
      if (targetSlot.poolState !== 'VERIFIED' || targetSlot.accountStatusKind !== 'CONNECTED') {
        throw new Error(`owner 전환 대상 slot이 준비되지 않았습니다: ${slotId}`);
      }

      if (!this.state.baseline) {
        const baseline = await this.captureBaseline();
        if (!this.isCurrentOperation(operationId, PHASE.SWITCHING)) {
          return;
        }
        this.state.baseline = baseline;
        this.state.publicIpBefore = baseline.publicIp;
      }

      await this.refreshRawRelayCatalogRouteSnapshot({ operationId });
      if (!this.isCurrentOperation(operationId, PHASE.SWITCHING)) {
        return;
      }

      await this.applyRawRelayCatalogRouteOwner(slotId, {
        operationId,
        previousSlotId,
      });
      if (!this.isCurrentOperation(operationId, PHASE.SWITCHING)) {
        return;
      }

      await delay(DEFAULT_PARALLEL_PROBE_ROUTE_SETTLE_MS);
      if (!this.isCurrentOperation(operationId, PHASE.SWITCHING)) {
        return;
      }

      await this.refreshRawRelayCatalogRouteSnapshot({ operationId });
      const refreshedTargetSlot = this.findRawRelayCatalogItem({ slotId });
      if (!refreshedTargetSlot?.routeOwned) {
        throw new Error('metric 전환 후에도 target slot이 기본 IPv4 route owner가 되지 않았습니다.');
      }

      const publicIp = await probeFreshPublicIpv4();
      const observedAt = new Date().toISOString();
      refreshedTargetSlot.poolState = 'VERIFIED';
      refreshedTargetSlot.lastVerifiedAt = observedAt;
      refreshedTargetSlot.exitPublicIp = String(publicIp.ip || '').trim();
      refreshedTargetSlot.exitPublicIpProvider = String(publicIp.provider || '').trim();
      refreshedTargetSlot.lastErrorCode = '';
      refreshedTargetSlot.lastErrorMessage = '';
      this.state.rawRelayCatalog.lastVerifiedAt = observedAt;
      this.state.rawRelayCatalog.lastVerifiedPublicIp = refreshedTargetSlot.exitPublicIp;
      this.state.rawRelayCatalog.lastVerifiedPublicIpProvider = refreshedTargetSlot.exitPublicIpProvider;
      this.applyRawRelayCatalogActiveSlot(refreshedTargetSlot);
      this.state.catalogEnabled = true;
      this.state.phase = PHASE.CONNECTED;
      this.state.operationId = '';
      this.state.lastErrorCode = '';
      this.state.lastErrorMessage = '';
      this.state.rawRelayCatalog.phase = PHASE.CONNECTED;
      appendRawRelayCatalogLog(
        this.state.rawRelayCatalog,
        `owner 전환 성공 - ${refreshedTargetSlot.slotId} / ${refreshedTargetSlot.exitPublicIp || '-'} (${refreshedTargetSlot.exitPublicIpProvider || '-'})`,
      );
      this.syncRawRelayCatalogSummary();
      await this.refreshNetworkState({
        force: true,
        forceNetworkIp: true,
      });
      await this.saveState();
    } catch (error) {
      const failureMessage = String(error?.message || 'owner 전환 실패');
      if (this.isCurrentOperation(operationId, PHASE.SWITCHING)) {
        const targetSlot = this.findRawRelayCatalogItem({ slotId });
        if (targetSlot) {
          targetSlot.poolState = 'ERROR';
          targetSlot.lastErrorCode = 'RAW_CATALOG_SWITCH_FAILED';
          targetSlot.lastErrorMessage = failureMessage;
          targetSlot.routeOwned = false;
          targetSlot.routeReady = false;
          targetSlot.defaultRouteIfIndex = 0;
          targetSlot.interfaceAlias = '';
          targetSlot.interfaceIndex = 0;
          targetSlot.connectedAt = '';
          targetSlot.accountStatusKind = 'MISSING';
          targetSlot.accountStatusText = '';
          await this.safeDeleteRawCatalogAccount(targetSlot.accountName);
        }

        let restoredPreviousOwner = false;
        if (previousSlotId && previousSlotId !== slotId) {
          try {
            await this.refreshRawRelayCatalogRouteSnapshot({ operationId });
            await this.applyRawRelayCatalogRouteOwner(previousSlotId, {
              operationId,
              previousSlotId: slotId,
            });
            await delay(DEFAULT_PARALLEL_PROBE_ROUTE_SETTLE_MS);
            await this.refreshRawRelayCatalogRouteSnapshot({ operationId });
            const restoredSlot = this.findRawRelayCatalogItem({ slotId: previousSlotId });
            if (restoredSlot?.routeOwned) {
              const restoredIp = await probeFreshPublicIpv4();
              const restoredAt = new Date().toISOString();
              restoredSlot.lastVerifiedAt = restoredAt;
              restoredSlot.exitPublicIp = String(restoredIp.ip || '').trim();
              restoredSlot.exitPublicIpProvider = String(restoredIp.provider || '').trim();
              this.state.rawRelayCatalog.lastVerifiedAt = restoredAt;
              this.state.rawRelayCatalog.lastVerifiedPublicIp = restoredSlot.exitPublicIp;
              this.state.rawRelayCatalog.lastVerifiedPublicIpProvider = restoredSlot.exitPublicIpProvider;
              this.applyRawRelayCatalogActiveSlot(restoredSlot);
              restoredPreviousOwner = true;
            }
          } catch (restoreError) {
            appendRawRelayCatalogLog(
              this.state.rawRelayCatalog,
              `owner 복구 실패 - ${String(restoreError?.message || '알 수 없는 오류')}`,
            );
          }
        }

        this.syncRawRelayCatalogSummary();
        if (restoredPreviousOwner) {
          this.state.catalogEnabled = true;
          this.state.phase = PHASE.CONNECTED;
          this.state.operationId = '';
          this.state.lastErrorCode = '';
          this.state.lastErrorMessage = '';
          this.state.rawRelayCatalog.phase = PHASE.CONNECTED;
          appendRawRelayCatalogLog(
            this.state.rawRelayCatalog,
            `owner 전환 실패, 이전 owner 복구 성공 - ${previousSlotId}`,
          );
          await this.refreshNetworkState({
            force: true,
            forceNetworkIp: true,
          });
          await this.saveState();
          return;
        }

        this.clearRawLivePoolActiveState({ preserveBaseline: true });
        this.state.catalogEnabled = this.state.rawRelayCatalog.verifiedSlotCount > 0;
        this.state.phase = PHASE.ERROR;
        this.state.operationId = '';
        this.state.lastErrorCode = 'RAW_CATALOG_SWITCH_FAILED';
        this.state.lastErrorMessage = failureMessage;
        this.state.rawRelayCatalog.phase = PHASE.ERROR;
        this.state.rawRelayCatalog.lastErrorCode = 'RAW_CATALOG_SWITCH_FAILED';
        this.state.rawRelayCatalog.lastErrorMessage = failureMessage;
        appendRawRelayCatalogLog(this.state.rawRelayCatalog, `owner 전환 실패 - ${failureMessage}`);
        await this.saveState();
      }
    } finally {
      this.softEtherMutationInFlight = false;
    }
  }

  async executeRawRelayCatalogDisconnect(context = {}) {
    const { operationId } = context;
    this.softEtherMutationInFlight = true;

    try {
      await this.restoreRawRelayCatalogMetrics({ swallowErrors: true });
      if (!this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
        return;
      }

      await this.cleanupAllRawCatalogAccounts();
      if (!this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
        return;
      }

      await this.finishDisconnectCleanup();
      this.softEtherMutationInFlight = false;
      await this.finalizePostDisconnectRefresh(operationId);
    } catch (error) {
      if (this.isCurrentOperation(operationId, PHASE.DISCONNECTING)) {
        await this.setErrorState('RAW_LIVE_POOL_DISCONNECT_FAILED', String(error?.message || 'live pool 정리 실패'));
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

  async ensureSpecificNic(nicName) {
    const targetNicName = normalizePreferredSoftEtherNicName(nicName, nicName);
    const nicRows = await this.softEtherCli.listNics();
    const existingNic = nicRows.find(row => row.name === targetNicName) || null;
    if (existingNic) {
      if (/enabled/i.test(existingNic.status)) {
        return targetNicName;
      }

      throw httpError(500, 'NIC_DISABLED', `SoftEther 어댑터가 비활성화되어 있습니다: ${targetNicName}`);
    }

    await this.softEtherCli.createNic(targetNicName);
    const refreshedNicRows = await this.softEtherCli.listNics();
    const createdNic = refreshedNicRows.find(row => row.name === targetNicName) || null;
    if (createdNic && /enabled/i.test(createdNic.status)) {
      return targetNicName;
    }

    throw httpError(500, 'NIC_CREATE_FAILED', `SoftEther 어댑터 생성 실패: ${targetNicName}`);
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

  async cleanupInactiveParallelProbeAccounts() {
    const accountRows = await this.softEtherCli.listAccounts();
    const staleProbeAccounts = accountRows.filter(row => (
      isParallelProbeAccountName(row.name)
      && row.statusKind === 'DISCONNECTED'
    ));

    for (const row of staleProbeAccounts) {
      await this.safeDeleteParallelProbeAccount(row.name);
    }
  }

  async cleanupAllParallelProbeAccounts() {
    const accountRows = await this.softEtherCli.listAccounts();
    const probeAccounts = accountRows.filter(row => isParallelProbeAccountName(row.name));
    for (const row of probeAccounts) {
      await this.safeDeleteParallelProbeAccount(row.name);
    }
  }

  async executeParallelProbeStart(context = {}) {
    const operationId = String(context.operationId || '').trim();
    const request = normalizeParallelProbeRequest(context.request || {});

    try {
      appendParallelProbeLog(this.state.parallelProbe, '병렬 probe 준비 시작');
      await this.saveState();

      await this.cleanupAllParallelProbeAccounts();
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      const relayCandidates = request.relays.length > 0
        ? request.relays
        : await fetchOfficialVpnGateRelays({
          limit: request.limit,
          preferredCountries: request.preferredCountries,
          preferredPorts: request.preferredPorts,
        });

      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      if (!Array.isArray(relayCandidates) || relayCandidates.length === 0) {
        throw new Error('official raw feed에서 병렬 probe 후보를 찾지 못했습니다.');
      }

      const preparedSlots = buildParallelProbeSlotsFromRelays(relayCandidates, request.slotNicNames);
      this.state.parallelProbe.request = request;
      this.state.parallelProbe.slots = preparedSlots;
      this.state.parallelProbe.baselineMetricRows = await collectInterfaceMetrics();
      this.state.parallelProbe.phase = PARALLEL_PROBE_PHASE.CONNECTING;
      appendParallelProbeLog(this.state.parallelProbe, `병렬 probe 후보 ${preparedSlots.length}개 준비 완료`);
      await this.saveState();

      for (const slot of preparedSlots) {
        if (!this.isCurrentParallelProbeOperation(operationId)) {
          return;
        }

        await this.connectParallelProbeSlot(operationId, slot.slotId);
      }

      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      const connectedSlots = this.state.parallelProbe.slots.filter(slot => slot.phase === 'CONNECTED');
      if (connectedSlots.length <= 0) {
        throw new Error('병렬 probe 후보가 모두 연결 실패했습니다.');
      }

      this.state.parallelProbe.phase = PARALLEL_PROBE_PHASE.VERIFYING;
      appendParallelProbeLog(this.state.parallelProbe, `연결 성공 슬롯 ${connectedSlots.length}개, route/IP 검증 시작`);
      await this.saveState();

      for (const slot of connectedSlots) {
        if (!this.isCurrentParallelProbeOperation(operationId)) {
          return;
        }

        await this.verifyParallelProbeSlot(operationId, slot.slotId);
      }

      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      await this.restoreParallelProbeMetrics();
      await this.refreshParallelProbeRouteSnapshot();

      this.state.parallelProbe.phase = PARALLEL_PROBE_PHASE.COMPLETE;
      this.state.parallelProbe.completedAt = new Date().toISOString();
      this.state.parallelProbe.lastErrorCode = '';
      this.state.parallelProbe.lastErrorMessage = '';
      appendParallelProbeLog(
        this.state.parallelProbe,
        `병렬 probe 완료 - connected ${connectedSlots.length}/${this.state.parallelProbe.slots.length}`,
      );
      await this.saveState();
    } catch (error) {
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      await this.restoreParallelProbeMetrics({ swallowErrors: true });
      await this.cleanupAllParallelProbeAccounts();
      await this.setParallelProbeErrorState(
        'PARALLEL_PROBE_START_FAILED',
        String(error?.message || '병렬 probe 시작 실패'),
      );
    }
  }

  async executeParallelProbeStop(context = {}) {
    const operationId = String(context.operationId || '').trim();
    const currentLogs = Array.isArray(this.state.parallelProbe?.logs)
      ? this.state.parallelProbe.logs.slice(0, 50)
      : [];

    try {
      if (!this.state.parallelProbe || String(this.state.parallelProbe.operationId || '').trim() !== operationId) {
        return;
      }

      await this.restoreParallelProbeMetrics({ swallowErrors: true });
      await this.cleanupAllParallelProbeAccounts();

      this.state.parallelProbe = {
        ...buildInitialParallelProbeState(),
        completedAt: new Date().toISOString(),
        logs: currentLogs,
      };
      appendParallelProbeLog(this.state.parallelProbe, '병렬 3슬롯 시험 종료 및 정리 완료');
      await this.saveState();
    } catch (error) {
      await this.setParallelProbeErrorState(
        'PARALLEL_PROBE_STOP_FAILED',
        String(error?.message || '병렬 probe 종료 실패'),
        { preserveLogs: currentLogs },
      );
    }
  }

  async connectParallelProbeSlot(operationId, slotId) {
    const slot = this.findParallelProbeSlot(slotId);
    if (!slot) {
      throw new Error(`병렬 probe slot을 찾지 못했습니다: ${slotId}`);
    }

    slot.phase = 'CONNECTING';
    slot.lastErrorCode = '';
    slot.lastErrorMessage = '';
    appendParallelProbeLog(
      this.state.parallelProbe,
      `${slot.slotId} 연결 시도 - ${slot.relay.ip || slot.relay.fqdn}:${slot.relay.selectedSslPort} / NIC=${slot.nicName}`,
    );
    await this.saveState();

    try {
      const nicName = await this.ensureSpecificNic(slot.nicName);
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      const relayHost = slot.relay.ip || slot.relay.fqdn;
      const accountName = buildParallelProbeAccountName(slot);
      slot.nicName = nicName;
      slot.accountName = accountName;

      await this.safeDeleteParallelProbeAccount(accountName);
      await this.softEtherCli.createAccount({
        name: accountName,
        serverHost: relayHost,
        serverPort: slot.relay.selectedSslPort,
        hubName: 'VPNGATE',
        username: 'VPN',
        nicName,
      });
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
        noRoutingTracking: true,
        noQos: true,
      });
      await this.softEtherCli.connectAccount(accountName);

      const connectedRow = await this.waitForNamedAccountConnected(accountName, {
        timeoutMs: DEFAULT_PARALLEL_PROBE_CONNECT_TIMEOUT_MS,
        operationId,
      });
      if (!connectedRow) {
        return;
      }
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      let accountStatus = null;
      try {
        accountStatus = await this.softEtherCli.getAccountStatus(accountName);
      } catch {
        accountStatus = null;
      }
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      slot.phase = 'CONNECTED';
      slot.connectedAt = String(accountStatus?.connectedAt || new Date().toISOString());
      slot.underlayProtocol = String(accountStatus?.underlayProtocol || '').trim();
      slot.udpAccelerationActive = accountStatus?.udpAccelerationActive === true;
      await this.refreshParallelProbeRouteSnapshot({ operationId });
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }
      appendParallelProbeLog(
        this.state.parallelProbe,
        `${slot.slotId} 연결 성공 - ${relayHost}:${slot.relay.selectedSslPort}${slot.interfaceAlias ? ` / ${slot.interfaceAlias}` : ''}`,
      );
      await this.saveState();
    } catch (error) {
      slot.phase = 'ERROR';
      slot.lastErrorCode = 'SLOT_CONNECT_FAILED';
      slot.lastErrorMessage = String(error?.message || 'slot 연결 실패');
      appendParallelProbeLog(this.state.parallelProbe, `${slot.slotId} 연결 실패 - ${slot.lastErrorMessage}`);
      await this.safeDeleteParallelProbeAccount(slot.accountName);
      slot.accountName = '';
      await this.saveState();
    }
  }

  async verifyParallelProbeSlot(operationId, slotId) {
    const slot = this.findParallelProbeSlot(slotId);
    if (!slot || slot.phase !== 'CONNECTED') {
      return;
    }

    try {
      await this.applyParallelProbeRouteOwner(slotId, { operationId });
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }

      await delay(DEFAULT_PARALLEL_PROBE_ROUTE_SETTLE_MS);
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }
      await this.refreshParallelProbeRouteSnapshot({ operationId });
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }
      if (!slot.routeOwned) {
        slot.lastErrorCode = 'ROUTE_OWNER_MISMATCH';
        slot.lastErrorMessage = 'metric 전환 후에도 이 slot이 기본 IPv4 route owner가 되지 않았습니다.';
        appendParallelProbeLog(this.state.parallelProbe, `${slot.slotId} route owner 불일치`);
        await this.saveState();
        return;
      }

      const publicIp = await probeFreshPublicIpv4();
      if (!this.isCurrentParallelProbeOperation(operationId)) {
        return;
      }
      const observedAt = new Date().toISOString();
      slot.lastVerifiedAt = observedAt;
      slot.exitPublicIp = String(publicIp.ip || '').trim();
      slot.exitPublicIpProvider = String(publicIp.provider || '').trim();
      this.state.parallelProbe.routeOwnerSlotId = slot.slotId;
      this.state.parallelProbe.lastVerifiedAt = observedAt;
      this.state.parallelProbe.lastVerifiedPublicIp = slot.exitPublicIp;
      this.state.parallelProbe.lastVerifiedPublicIpProvider = slot.exitPublicIpProvider;
      appendParallelProbeLog(
        this.state.parallelProbe,
        `${slot.slotId} 출구 IPv4 확인 - ${slot.exitPublicIp || '-'} (${slot.exitPublicIpProvider || '-'})`,
      );
      await this.saveState();
    } catch (error) {
      slot.lastErrorCode = 'EXIT_IP_VERIFY_FAILED';
      slot.lastErrorMessage = String(error?.message || '출구 IPv4 확인 실패');
      appendParallelProbeLog(this.state.parallelProbe, `${slot.slotId} 출구 IPv4 확인 실패 - ${slot.lastErrorMessage}`);
      await this.saveState();
    }
  }

  async applyParallelProbeRouteOwner(targetSlotId, options = {}) {
    const operationId = String(options.operationId || '').trim();
    if (operationId && !this.isCurrentParallelProbeOperation(operationId)) {
      return;
    }

    const connectedSlots = this.state.parallelProbe.slots.filter(slot => (
      slot.phase === 'CONNECTED'
      && Number(slot.interfaceIndex || 0) > 0
    ));
    const targetSlot = connectedSlots.find(slot => slot.slotId === targetSlotId) || null;
    if (!targetSlot) {
      throw new Error(`route owner 후보 slot을 찾지 못했습니다: ${targetSlotId}`);
    }

    const metricPlan = connectedSlots.map(slot => ({
      ifIndex: slot.interfaceIndex,
      interfaceMetric: slot.slotId === targetSlotId ? 1 : 50,
    }));
    await applyInterfaceMetricPlan(metricPlan);
    if (operationId && !this.isCurrentParallelProbeOperation(operationId)) {
      return;
    }
    this.state.parallelProbe.routeOwnerSlotId = targetSlotId;
    await this.saveState();
  }

  async restoreParallelProbeMetrics(options = {}) {
    const baselineMetricRows = Array.isArray(this.state.parallelProbe?.baselineMetricRows)
      ? this.state.parallelProbe.baselineMetricRows
      : [];
    if (baselineMetricRows.length <= 0) {
      return;
    }

    try {
      await restoreInterfaceMetrics(baselineMetricRows);
      this.state.parallelProbe.routeOwnerSlotId = '';
      await this.saveState();
    } catch (error) {
      if (options.swallowErrors === true) {
        appendParallelProbeLog(
          this.state.parallelProbe,
          `metric 원복 실패 - ${String(error?.message || '알 수 없는 오류')}`,
        );
        await this.saveState();
        return;
      }

      throw error;
    }
  }

  async refreshParallelProbeRouteSnapshot(options = {}) {
    const operationId = String(options.operationId || '').trim();
    if (operationId && !this.isCurrentParallelProbeOperation(operationId)) {
      return null;
    }

    const localSnapshot = await this.networkObserver.getLocalSnapshot({ force: true });
    if (operationId && !this.isCurrentParallelProbeOperation(operationId)) {
      return localSnapshot;
    }
    const primaryIfIndex = Number(localSnapshot?.primaryIpv4Route?.ifIndex || 0);

    for (const slot of this.state.parallelProbe.slots) {
      const interfaceInfo = resolveParallelProbeInterfaceInfo(localSnapshot, slot);
      slot.interfaceAlias = interfaceInfo.interfaceAlias;
      slot.interfaceIndex = interfaceInfo.interfaceIndex;
      slot.defaultRouteIfIndex = interfaceInfo.defaultRouteIfIndex;
      slot.routeReady = interfaceInfo.routeReady;
      slot.routeOwned = interfaceInfo.routeOwned;
    }

    const routeOwnerSlot = this.state.parallelProbe.slots.find(slot => (
      Number(slot.interfaceIndex || 0) > 0
      && Number(slot.interfaceIndex || 0) === primaryIfIndex
    )) || null;
    if (operationId && !this.isCurrentParallelProbeOperation(operationId)) {
      return localSnapshot;
    }
    this.state.parallelProbe.routeOwnerSlotId = routeOwnerSlot?.slotId || '';
    await this.saveState();
    return localSnapshot;
  }

  findParallelProbeSlot(slotId) {
    return this.state.parallelProbe.slots.find(slot => slot.slotId === slotId) || null;
  }

  async waitForNamedAccountConnected(accountName, options = {}) {
    const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_PARALLEL_PROBE_CONNECT_TIMEOUT_MS);
    const operationId = String(options.operationId || '').trim();
    const startedAt = Date.now();
    let lastStateText = '';

    while ((Date.now() - startedAt) < timeoutMs) {
      if (operationId && !this.isCurrentParallelProbeOperation(operationId)) {
        return null;
      }

      const accountRows = await this.softEtherCli.listAccounts();
      const row = accountRows.find(item => item.name === accountName) || null;
      if (row) {
        lastStateText = row.statusText || row.statusKind || 'UNKNOWN';
        if (row.statusKind === 'CONNECTED') {
          return row;
        }

        if (row.statusKind === 'DISCONNECTED') {
          throw new Error(`계정이 연결되지 못하고 종료됐습니다. account=${accountName}, last=${lastStateText}`);
        }
      } else {
        lastStateText = 'MISSING';
      }

      await delay(DEFAULT_MONITOR_INTERVAL_MS);
    }

    throw new Error(`병렬 probe 연결 timeout (${timeoutMs}ms, account=${accountName}, last=${lastStateText || '-'})`);
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
    this.syncRawRelayCatalogStatuses(accountRows);

    const hasRawRelayCatalogState = Boolean(this.state.catalogEnabled)
      || (Array.isArray(this.state.rawRelayCatalog?.items) && this.state.rawRelayCatalog.items.length > 0);
    if (hasRawRelayCatalogState) {
      await this.refreshRawRelayCatalogRouteSnapshot();
      this.syncRawRelayCatalogSummary();

      const routeOwnerItem = this.state.rawRelayCatalog.routeOwnerSlotId
        ? this.findRawRelayCatalogItem({ slotId: this.state.rawRelayCatalog.routeOwnerSlotId })
        : null;
      const activeSlot = routeOwnerItem && routeOwnerItem.accountStatusKind === 'CONNECTED'
        && ['CONNECTED', 'VERIFYING', 'VERIFIED'].includes(routeOwnerItem.poolState)
        ? routeOwnerItem
        : null;
      const hasConnectedSlot = this.state.rawRelayCatalog.items.some((item) => (
        item.accountStatusKind === 'CONNECTED'
        && ['CONNECTED', 'VERIFYING', 'VERIFIED'].includes(item.poolState)
      ));

      if (this.state.phase === PHASE.DISCONNECTING && !hasConnectedSlot) {
        await this.finishDisconnectCleanup();
      } else if (activeSlot) {
        this.applyRawRelayCatalogActiveSlot(activeSlot);
        if (![PHASE.PREPARING, PHASE.SWITCHING, PHASE.DISCONNECTING].includes(this.state.phase)) {
          this.state.phase = PHASE.CONNECTED;
          this.state.lastErrorCode = '';
          this.state.lastErrorMessage = '';
        }
        this.state.catalogEnabled = true;
      } else if (this.state.rawRelayCatalog.verifiedSlotCount > 0) {
        this.clearRawLivePoolActiveState({ preserveBaseline: true });
        this.state.catalogEnabled = true;
        if (![PHASE.PREPARING, PHASE.SWITCHING, PHASE.DISCONNECTING].includes(this.state.phase)) {
          this.state.phase = PHASE.READY;
          this.state.lastErrorCode = '';
          this.state.lastErrorMessage = '';
        }
      } else if (this.state.phase === PHASE.PREPARING && !this.softEtherMutationInFlight) {
        appendRawRelayCatalogLog(
          this.state.rawRelayCatalog,
          'agent 재시작으로 이전 raw 준비 상태가 중간에 끊겨 정리 후 IDLE로 복구했습니다.',
        );
        await this.restoreRawRelayCatalogMetrics({ swallowErrors: true });
        await this.cleanupAllRawCatalogAccounts();
        this.clearRawLivePoolActiveState({ preserveBaseline: false });
        await this.transitionToIdle();
      } else if (![PHASE.PREPARING, PHASE.DISCONNECTING].includes(this.state.phase)) {
        this.clearRawLivePoolActiveState({ preserveBaseline: true });
        this.state.catalogEnabled = false;
        if (this.state.rawRelayCatalog.items.length > 0) {
          this.state.phase = PHASE.ERROR;
        } else {
          await this.transitionToIdle();
        }
      }

      if (includeNetwork && this.state.phase === PHASE.CONNECTED && this.state.rawRelayCatalog.activeSlotId) {
        await this.refreshNetworkState(options);
      }

      reconcileRawRelayCatalogState(this.state);
      this.statusCache = {
        observedAtMs: Date.now(),
      };
      await this.saveState();
      return this.state;
    }

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
      if (this.state.catalogEnabled && this.state.rawRelayCatalog.items.length > 0) {
        if (![PHASE.READY, PHASE.ERROR, PHASE.PREPARING].includes(this.state.phase)) {
          await this.transitionToCatalogReady();
        }
      } else if (![PHASE.IDLE, PHASE.ERROR].includes(this.state.phase)) {
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
      } else if (this.state.catalogEnabled && this.state.rawRelayCatalog.items.length > 0) {
        await this.transitionToCatalogReady();
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
      } else if (this.state.catalogEnabled && this.state.rawRelayCatalog.items.length > 0) {
        await this.transitionToCatalogReady();
      } else {
        await this.transitionToIdle();
      }
    }

    if (includeNetwork) {
      await this.refreshNetworkState(options);
    }

    reconcileRawRelayCatalogState(this.state);
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
      isAgentOwnedSingleConnectionAccountName(row.name)
      && ['CONNECTED', 'CONNECTING'].includes(row.statusKind)
    ));

    if (['managed_raw', 'raw_catalog'].includes(this.state.accountOwnership)) {
      return activeManagedAccounts[0] || null;
    }

    if (!this.state.accountName && activeManagedAccounts.length === 1) {
      return activeManagedAccounts[0];
    }

    return null;
  }

  findActiveManagedAccounts(accountRows = []) {
    return accountRows.filter((row) => (
      isAgentOwnedSingleConnectionAccountName(row.name)
      && ['CONNECTED', 'CONNECTING'].includes(row.statusKind)
    ));
  }

  adoptTrackedAccount(accountRow = {}) {
    if (!accountRow?.name) {
      return;
    }

    this.state.accountName = accountRow.name;
    if (isManagedAccountName(accountRow.name) || isRawCatalogAccountName(accountRow.name)) {
      this.state.accountOwnership = isRawCatalogAccountName(accountRow.name) ? 'raw_catalog' : 'managed_raw';
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

      if (isRawCatalogAccountName(row.name)) {
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
      isAgentOwnedSingleConnectionAccountName(row.name)
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
    const hasRawRelayCatalogState = Boolean(this.state.catalogEnabled)
      || (Array.isArray(this.state.rawRelayCatalog?.items) && this.state.rawRelayCatalog.items.length > 0);
    if (hasRawRelayCatalogState) {
      await this.restoreRawRelayCatalogMetrics({ swallowErrors: true });
      await this.cleanupAllRawCatalogAccounts();
      await this.transitionToIdle();
      return;
    }

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

  async safeDeleteParallelProbeAccount(accountName) {
    if (!accountName || !isParallelProbeAccountName(accountName)) {
      return;
    }

    try {
      await this.softEtherCli.disconnectAccount(accountName);
    } catch {
      // ignore
    }

    try {
      await this.softEtherCli.deleteAccount(accountName);
    } catch {
      // ignore
    }
  }

  async safeDeleteRawCatalogAccount(accountName, options = {}) {
    const cli = options.cli || this.softEtherCli;
    if (!accountName || !isRawCatalogAccountName(accountName)) {
      return;
    }

    try {
      await cli.disconnectAccount(accountName);
    } catch {
      // 이미 offline이면 그대로 삭제를 시도한다.
    }

    try {
      await cli.deleteAccount(accountName);
    } catch {
      // stale cache account 삭제 실패는 다음 sync 때 다시 시도한다.
    }
  }

  isCurrentOperation(operationId, phase) {
    return String(this.state.operationId || '') === String(operationId || '')
      && this.state.phase === phase;
  }

  isCurrentParallelProbeOperation(operationId) {
    return Boolean(this.state.parallelProbe?.isRunning)
      && String(this.state.parallelProbe?.operationId || '').trim() === String(operationId || '').trim()
      && this.state.parallelProbe.phase !== PARALLEL_PROBE_PHASE.STOPPING;
  }

  async transitionToIdle(reason = '') {
    this.state.phase = PHASE.IDLE;
    this.state.operationId = '';
    this.state.catalogEnabled = false;
    this.state.connectionMode = CONNECTION_MODE.PROFILE;
    this.state.profileId = '';
    this.clearRawLivePoolActiveState({ preserveBaseline: false });
    this.state.lastErrorCode = '';
    this.state.lastErrorMessage = reason ? String(reason) : '';
    this.state.ipv4DefaultRouteChanged = false;
    this.state.ipv6DefaultRouteChanged = false;
    this.state.dnsChanged = false;
    this.state.rawRelayCatalog.stage = RAW_RELAY_CATALOG_STAGE.IDLE;
    markRawRelayCatalogActiveItem(this.state.rawRelayCatalog, '');
    reconcileRawRelayCatalogState(this.state);
    await this.saveState();
  }

  async transitionToCatalogReady(reason = '') {
    this.state.phase = PHASE.READY;
    this.state.operationId = '';
    this.state.catalogEnabled = true;
    this.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
    this.clearRawLivePoolActiveState({ preserveBaseline: true });
    this.state.lastErrorCode = '';
    this.state.lastErrorMessage = reason ? String(reason) : '';
    this.state.ipv4DefaultRouteChanged = false;
    this.state.ipv6DefaultRouteChanged = false;
    this.state.dnsChanged = false;
    this.state.rawRelayCatalog.phase = PHASE.READY;
    this.state.rawRelayCatalog.stage = RAW_RELAY_CATALOG_STAGE.READY;
    this.state.rawRelayCatalog.lastErrorCode = '';
    this.state.rawRelayCatalog.lastErrorMessage = '';
    markRawRelayCatalogActiveItem(this.state.rawRelayCatalog, '');
    this.syncRawRelayCatalogSummary();
    await this.saveState();
  }

  async setErrorState(code, message) {
    this.state.phase = PHASE.ERROR;
    this.state.lastErrorCode = String(code || '').trim();
    this.state.lastErrorMessage = String(message || '').trim();
    await this.saveState();
  }

  async setParallelProbeErrorState(code, message, options = {}) {
    const existingLogs = Array.isArray(options.preserveLogs)
      ? options.preserveLogs
      : (Array.isArray(this.state.parallelProbe?.logs) ? this.state.parallelProbe.logs : []);
    const currentSlots = Array.isArray(this.state.parallelProbe?.slots)
      ? this.state.parallelProbe.slots.map((slot, index) => normalizeParallelProbeSlot(slot, index))
      : buildInitialParallelProbeState().slots;
    const currentRequest = this.state.parallelProbe?.request
      ? normalizeParallelProbeRequest(this.state.parallelProbe.request)
      : buildDefaultParallelProbeRequest();
    this.state.parallelProbe = {
      ...buildInitialParallelProbeState(),
      completedAt: new Date().toISOString(),
      phase: PARALLEL_PROBE_PHASE.ERROR,
      lastErrorCode: String(code || '').trim(),
      lastErrorMessage: String(message || '').trim(),
      request: currentRequest,
      slots: currentSlots,
      logs: existingLogs.slice(0, 50),
    };
    appendParallelProbeLog(this.state.parallelProbe, `병렬 probe 오류 - ${this.state.parallelProbe.lastErrorMessage}`);
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

      if ([PHASE.CONNECTING, PHASE.DISCONNECTING, PHASE.PREPARING].includes(this.state.phase)) {
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
      const normalizedParallelProbe = normalizeParallelProbeState(parsed.parallelProbe || {});
      const normalizedRawRelayCatalog = normalizeRawRelayCatalogState(parsed.rawRelayCatalog || {});
      this.state = {
        ...buildInitialState(this.managedNicName),
        ...parsed,
        catalogEnabled: Boolean(parsed.catalogEnabled),
        managedNicName: this.managedNicName,
        rawRelayCatalog: normalizedRawRelayCatalog,
        parallelProbe: normalizedParallelProbe,
      };
      reconcileRawRelayCatalogState(this.state);
    } catch {
      this.state = buildInitialState(this.managedNicName);
    }
  }

  async saveState() {
    const task = async () => {
      const persistedState = {
        ...this.state,
        accountRows: [],
        nicRows: [],
      };
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      await writeFile(this.stateFile, `${JSON.stringify(persistedState, null, 2)}\n`, 'utf8');
    };

    this.stateSaveQueue = this.stateSaveQueue
      .catch(() => {})
      .then(task);
    return this.stateSaveQueue;
  }

  createProvisionCli() {
    return new SoftEtherCli({
      ...this.provisionCliOptions,
      serializeCommands: false,
    });
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

  async cleanupAllRawCatalogAccounts() {
    const accountRows = await this.softEtherCli.listAccounts();
    const rawCatalogAccounts = accountRows.filter(row => isRawCatalogAccountName(row.name));
    for (const row of rawCatalogAccounts) {
      await this.safeDeleteRawCatalogAccount(row.name);
    }
  }

  syncRawRelayCatalogSummary() {
    syncRawRelayCatalogSummary(this.state.rawRelayCatalog);
  }

  setRawRelayCatalogStage(stage) {
    this.state.rawRelayCatalog.stage = String(stage || RAW_RELAY_CATALOG_STAGE.IDLE).trim().toUpperCase() || RAW_RELAY_CATALOG_STAGE.IDLE;
  }

  assignRawRelayCatalogNicLease(slotId, nicName, options = {}) {
    const slot = this.findRawRelayCatalogItem({ slotId });
    if (!slot) {
      return null;
    }

    const normalizedNicName = String(nicName || '').trim().toUpperCase();
    slot.preferredNicName = normalizedNicName || slot.preferredNicName || '';
    slot.nicName = normalizedNicName;
    slot.capacityDeferred = false;
    if (options.markPrepared !== false) {
      slot.nicPreparedAt = slot.nicPreparedAt || new Date().toISOString();
    }
    if (['PENDING', 'CAPACITY_DEFERRED', 'NIC_PREPARING'].includes(slot.poolState)) {
      slot.poolState = normalizedNicName ? 'NIC_READY' : 'PENDING';
    }
    return slot;
  }

  clearRawRelayCatalogConnectionState(slotId, options = {}) {
    const slot = this.findRawRelayCatalogItem({ slotId });
    if (!slot) {
      return '';
    }

    const releasedNicName = String(options.releaseNicName ?? slot.nicName ?? '').trim().toUpperCase();
    slot.accountStatusKind = 'MISSING';
    slot.accountStatusText = '';
    slot.connectedAt = '';
    slot.interfaceAlias = '';
    slot.interfaceIndex = 0;
    slot.defaultRouteIfIndex = 0;
    slot.routeOwned = false;
    slot.routeReady = false;
    if (options.keepNic !== true) {
      slot.nicName = '';
    }
    return releasedNicName;
  }

  promoteNextDeferredRawRelayCatalogSlot(nicName) {
    const normalizedNicName = String(nicName || '').trim().toUpperCase();
    if (!normalizedNicName) {
      return null;
    }

    const deferredSlot = this.state.rawRelayCatalog.items.find((item) => (
      item.poolState === 'CAPACITY_DEFERRED'
      && item.capacityDeferred === true
      && item.connectAttempted !== true
    )) || null;
    if (!deferredSlot) {
      return null;
    }

    this.assignRawRelayCatalogNicLease(deferredSlot.slotId, normalizedNicName);
    deferredSlot.poolState = 'NIC_READY';
    deferredSlot.capacityDeferred = false;
    appendRawRelayCatalogLog(
      this.state.rawRelayCatalog,
      `${deferredSlot.slotId} NIC lease 승격 - ${normalizedNicName}`,
    );
    return deferredSlot;
  }

  clearRawLivePoolActiveState(options = {}) {
    const preserveBaseline = options.preserveBaseline !== false;
    this.state.accountName = '';
    this.state.accountOwnership = '';
    this.state.accountProvisioning = false;
    this.state.profileId = '';
    this.state.activeRelayId = '';
    this.state.activeRelayIp = '';
    this.state.activeRelayFqdn = '';
    this.state.activeSelectedSslPort = 0;
    this.state.activeAdapterName = '';
    this.state.connectedAt = '';
    this.state.underlayProtocol = '';
    this.state.udpAccelerationActive = false;
    this.state.currentPublicIp = '';
    this.state.publicIpAfter = '';
    this.state.publicIpProvider = '';
    this.state.ipv4DefaultRouteChanged = false;
    this.state.ipv6DefaultRouteChanged = false;
    this.state.dnsChanged = false;
    this.state.rawRelayCatalog.activeSlotId = '';
    if (!preserveBaseline) {
      this.state.baseline = null;
      this.state.publicIpBefore = '';
    }
  }

  applyRawRelayCatalogActiveSlot(activeSlot = null) {
    if (!activeSlot) {
      this.clearRawLivePoolActiveState({ preserveBaseline: true });
      return;
    }

    this.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
    this.state.accountName = activeSlot.accountName || '';
    this.state.accountOwnership = 'raw_catalog';
    this.state.accountProvisioning = false;
    this.state.profileId = buildCompatibilityProfileId(
      activeSlot.id || activeSlot.ip || activeSlot.fqdn || activeSlot.slotId,
      activeSlot.selectedSslPort,
    );
    this.state.activeRelayId = activeSlot.id || '';
    this.state.activeRelayIp = activeSlot.ip || '';
    this.state.activeRelayFqdn = activeSlot.fqdn || '';
    this.state.activeSelectedSslPort = activeSlot.selectedSslPort || 0;
    this.state.activeAdapterName = activeSlot.nicName || '';
    this.state.connectedAt = activeSlot.connectedAt || '';
    this.state.publicIpAfter = activeSlot.exitPublicIp || '';
    this.state.currentPublicIp = activeSlot.exitPublicIp || '';
    this.state.publicIpProvider = activeSlot.exitPublicIpProvider || '';
    this.state.rawRelayCatalog.activeSlotId = activeSlot.slotId || '';
  }

  async restoreRawRelayCatalogMetrics(options = {}) {
    const baselineMetricRows = Array.isArray(this.state.rawRelayCatalog?.baselineMetricRows)
      ? this.state.rawRelayCatalog.baselineMetricRows
      : [];
    if (baselineMetricRows.length <= 0) {
      return;
    }

    try {
      await restoreInterfaceMetrics(baselineMetricRows);
      this.state.rawRelayCatalog.routeOwnerSlotId = '';
    } catch (error) {
      if (options.swallowErrors === true) {
        appendRawRelayCatalogLog(
          this.state.rawRelayCatalog,
          `raw live pool metric 원복 실패 - ${String(error?.message || '알 수 없는 오류')}`,
        );
        return;
      }
      throw error;
    }
  }

  async refreshRawRelayCatalogRouteSnapshot(options = {}) {
    const operationId = String(options.operationId || '').trim();
    if (operationId && String(this.state.operationId || '').trim() !== operationId) {
      return null;
    }

    const localSnapshot = await this.networkObserver.getLocalSnapshot({ force: true });
    if (operationId && String(this.state.operationId || '').trim() !== operationId) {
      return localSnapshot;
    }

    const primaryIfIndex = Number(localSnapshot?.primaryIpv4Route?.ifIndex || 0);
    for (const item of this.state.rawRelayCatalog.items) {
      const interfaceInfo = resolveParallelProbeInterfaceInfo(localSnapshot, item);
      item.interfaceAlias = interfaceInfo.interfaceAlias;
      item.interfaceIndex = interfaceInfo.interfaceIndex;
      item.defaultRouteIfIndex = interfaceInfo.defaultRouteIfIndex;
      item.routeReady = interfaceInfo.routeReady;
      item.routeOwned = interfaceInfo.routeOwned;
    }

    const routeOwnerItem = this.state.rawRelayCatalog.items.find((item) => (
      Number(item.interfaceIndex || 0) > 0
      && Number(item.interfaceIndex || 0) === primaryIfIndex
    )) || null;
    this.state.rawRelayCatalog.routeOwnerSlotId = routeOwnerItem?.slotId || '';
    this.syncRawRelayCatalogSummary();
    return localSnapshot;
  }

  async applyRawRelayCatalogRouteOwner(targetSlotId, options = {}) {
    const operationId = String(options.operationId || '').trim();
    if (operationId && String(this.state.operationId || '').trim() !== operationId) {
      return;
    }

    const connectedItems = this.state.rawRelayCatalog.items.filter((item) => (
      Number(item.interfaceIndex || 0) > 0
      && item.accountStatusKind === 'CONNECTED'
      && ['CONNECTED', 'VERIFYING', 'VERIFIED'].includes(item.poolState)
    ));
    const targetItem = connectedItems.find(item => item.slotId === targetSlotId) || null;
    if (!targetItem) {
      throw new Error(`route owner 대상 slot을 찾지 못했습니다: ${targetSlotId}`);
    }

    const metricPlan = connectedItems.map((item) => ({
      ifIndex: item.interfaceIndex,
      interfaceMetric: item.slotId === targetSlotId ? 1 : 50,
    }));
    await applyInterfaceMetricPlan(metricPlan);
    this.state.rawRelayCatalog.routeOwnerSlotId = targetSlotId;
  }

  async prepareRawLivePoolNics(operationId, request = {}) {
    const desiredNicNames = buildRawCatalogSlotNicNames(
      this.managedNicName,
      request.requestedPhysicalNicCount,
      { maxNicIndex: request.experimentalMaxNicIndex },
    );
    this.state.rawRelayCatalog.availableNicNames = desiredNicNames;
    this.setRawRelayCatalogStage(RAW_RELAY_CATALOG_STAGE.PREPARING_NICS);

    const nicInventory = await this.ensureRawCatalogNicInventory(request, {
      shouldContinue: () => this.isCurrentOperation(operationId, PHASE.PREPARING),
      onLog: (message) => {
        appendRawRelayCatalogLog(this.state.rawRelayCatalog, message);
      },
    });
    const preparedNicNames = nicInventory.preparedNicNames;
    this.state.rawRelayCatalog.preparedNicNames = preparedNicNames;
    this.state.rawRelayCatalog.detectedPhysicalNicCapacity = preparedNicNames.length;
    this.state.rawRelayCatalog.provisionableSlotCount = preparedNicNames.length;

    for (let index = 0; index < this.state.rawRelayCatalog.items.length; index += 1) {
      const item = this.state.rawRelayCatalog.items[index];
      const nicName = preparedNicNames[index] || '';
      item.preferredNicName = nicName;
      item.connectAttempted = false;
      item.connectAttemptedAt = '';
      item.lastErrorCode = '';
      item.lastErrorMessage = '';
      item.accountStatusKind = 'MISSING';
      item.accountStatusText = '';
      item.connectedAt = '';
      item.exitPublicIp = '';
      item.exitPublicIpProvider = '';
      item.lastVerifiedAt = '';
      if (nicName) {
        this.assignRawRelayCatalogNicLease(item.slotId, nicName);
        item.poolState = 'NIC_READY';
      } else {
        item.nicName = '';
        item.nicPreparedAt = '';
        item.capacityDeferred = true;
        item.poolState = 'CAPACITY_DEFERRED';
      }
    }

    this.syncRawRelayCatalogSummary();
    await this.saveState();
    return preparedNicNames;
  }

  async ensureRawCatalogNicInventory(request = {}, options = {}) {
    const desiredNicNames = buildRawCatalogSlotNicNames(
      this.managedNicName,
      request.requestedPhysicalNicCount,
      { maxNicIndex: request.experimentalMaxNicIndex },
    );
    const nicRows = await this.statusCli.listNics();
    this.state.nicRows = nicRows;
    const enabledNicSet = new Set(
      nicRows
        .filter(row => /enabled/i.test(String(row.status || '')))
        .map(row => String(row.name || '').trim().toUpperCase()),
    );
    const existingNicNames = desiredNicNames.filter(nicName => enabledNicSet.has(nicName));
    const missingNicNames = desiredNicNames.filter(nicName => !enabledNicSet.has(nicName));
    const concurrency = Math.max(1, Math.min(
      request.requestedPhysicalNicCount || DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT,
      normalizePositiveInteger(request.nicPrepareConcurrency, DEFAULT_RAW_LIVE_POOL_NIC_PREPARE_CONCURRENCY),
    ));
    const shouldContinue = typeof options.shouldContinue === 'function'
      ? options.shouldContinue
      : () => true;
    const onLog = typeof options.onLog === 'function'
      ? options.onLog
      : null;

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, missingNicNames.length || 1) }, async () => {
      while (cursor < missingNicNames.length) {
        const nicName = missingNicNames[cursor];
        cursor += 1;
        if (!shouldContinue()) {
          return;
        }

        const cli = this.createProvisionCli();
        try {
          await cli.createNic(nicName);
          onLog?.(`${nicName} 준비 완료`);
        } catch (error) {
          onLog?.(`${nicName} 준비 실패 - ${String(error?.message || 'NicCreate 실패')}`);
        }
      }
    });
    await Promise.all(workers);

    const refreshedNicRows = await this.statusCli.listNics();
    this.state.nicRows = refreshedNicRows;
    const refreshedEnabledNicSet = new Set(
      refreshedNicRows
        .filter(row => /enabled/i.test(String(row.status || '')))
        .map(row => String(row.name || '').trim().toUpperCase()),
    );
    const preparedNicNames = desiredNicNames.filter(nicName => refreshedEnabledNicSet.has(nicName));
    const existingNicSet = new Set(existingNicNames);
    const createdNicNames = preparedNicNames.filter(nicName => !existingNicSet.has(nicName));
    const failedNicNames = missingNicNames.filter(nicName => !refreshedEnabledNicSet.has(nicName));

    return {
      desiredNicNames,
      existingNicNames,
      missingNicNames,
      preparedNicNames,
      createdNicNames,
      failedNicNames,
      concurrency,
    };
  }

  startRawLivePoolStatusPoller(operationId, options = {}) {
    const pollIntervalMs = Math.max(
      100,
      normalizePositiveInteger(options.pollIntervalMs, DEFAULT_RAW_LIVE_POOL_STATUS_POLL_INTERVAL_MS),
    );
    let stopped = false;
    let loggedFailure = false;
    const done = (async () => {
      while (!stopped && this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        try {
          const accountRows = await this.statusCli.listAccounts();
          this.state.accountRows = accountRows;
          this.syncRawRelayCatalogStatuses(accountRows);
          await this.saveState();
          loggedFailure = false;
        } catch (error) {
          if (!loggedFailure) {
            appendRawRelayCatalogLog(
              this.state.rawRelayCatalog,
              `raw live pool 상태 조회 실패 - ${String(error?.message || 'AccountList 실패')}`,
            );
            loggedFailure = true;
          }
        }

        if (stopped || !this.isCurrentOperation(operationId, PHASE.PREPARING)) {
          break;
        }
        await delay(pollIntervalMs);
      }
    })();

    return {
      stop() {
        stopped = true;
      },
      done,
    };
  }

  async waitForSlotTerminalState(operationId, slotId, options = {}) {
    const timeoutMs = Math.max(
      5_000,
      normalizePositiveInteger(options.timeoutMs, DEFAULT_RAW_LIVE_POOL_CONNECT_TIMEOUT_MS),
    );
    const pollIntervalMs = Math.max(
      50,
      normalizePositiveInteger(options.pollIntervalMs, DEFAULT_RAW_LIVE_POOL_TERMINAL_POLL_INTERVAL_MS),
    );
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < timeoutMs) {
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return null;
      }

      const slot = this.findRawRelayCatalogItem({ slotId });
      if (!slot) {
        throw new Error(`raw live pool slot을 찾지 못했습니다: ${slotId}`);
      }
      if (slot.accountStatusKind === 'CONNECTED' || ['CONNECTED', 'VERIFYING', 'VERIFIED'].includes(slot.poolState)) {
        return slot;
      }
      if (slot.poolState === 'ERROR') {
        throw new Error(slot.lastErrorMessage || `slot 연결 실패: ${slotId}`);
      }

      await delay(pollIntervalMs);
    }

    const slot = this.findRawRelayCatalogItem({ slotId });
    const lastStateText = slot?.accountStatusText || slot?.accountStatusKind || slot?.poolState || '-';
    throw new Error(`SoftEther 연결 상태 timeout (${timeoutMs}ms, slot=${slotId}, last=${lastStateText})`);
  }

  async connectRawRelayCatalogSlots(operationId, options = {}) {
    const concurrency = Math.max(1, Math.min(
      this.state.rawRelayCatalog.preparedNicCount || DEFAULT_RAW_LIVE_POOL_CONNECT_CONCURRENCY,
      normalizePositiveInteger(options.concurrency, DEFAULT_RAW_LIVE_POOL_CONNECT_CONCURRENCY),
    ));
    this.setRawRelayCatalogStage(RAW_RELAY_CATALOG_STAGE.CONNECTING_SLOTS);

    const claimNextSlotId = () => {
      const nextSlot = this.state.rawRelayCatalog.items.find((item) => (
        item.poolState === 'NIC_READY'
        && item.connectAttempted !== true
      )) || null;
      if (!nextSlot) {
        return '';
      }

      nextSlot.connectAttempted = true;
      nextSlot.connectAttemptedAt = new Date().toISOString();
      nextSlot.poolState = 'CONNECTING';
      nextSlot.lastErrorCode = '';
      nextSlot.lastErrorMessage = '';
      return nextSlot.slotId;
    };

    const workers = Array.from({ length: Math.min(concurrency, this.state.rawRelayCatalog.items.length || 1) }, async () => {
      while (this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        const slotId = claimNextSlotId();
        if (!slotId) {
          const hasInFlight = this.state.rawRelayCatalog.items.some(item => item.poolState === 'CONNECTING');
          if (!hasInFlight) {
            return;
          }
          await delay(DEFAULT_RAW_LIVE_POOL_TERMINAL_POLL_INTERVAL_MS);
          continue;
        }
        await this.connectRawRelayCatalogSlot(operationId, slotId, options);
      }
    });
    await Promise.all(workers);
  }

  async connectRawRelayCatalogSlot(operationId, slotId, options = {}) {
    let slot = this.findRawRelayCatalogItem({ slotId });
    if (!slot) {
      throw new Error(`raw live pool slot을 찾지 못했습니다: ${slotId}`);
    }

    const nicName = String(slot.nicName || slot.preferredNicName || '').trim().toUpperCase();
    if (!nicName) {
      slot.poolState = 'CAPACITY_DEFERRED';
      slot.capacityDeferred = true;
      return;
    }

    slot.lastErrorCode = '';
    slot.lastErrorMessage = '';
    slot.accountName = slot.accountName || buildRawCatalogSlotAccountName(slot.slotId);
    appendRawRelayCatalogLog(
      this.state.rawRelayCatalog,
      `${slot.slotId} 연결 시도 - ${(slot.ip || slot.fqdn) || '-'}:${slot.selectedSslPort || '-'} / NIC=${nicName}`,
    );
    this.syncRawRelayCatalogSummary();
    await this.saveState();

    const cli = this.createProvisionCli();
    try {
      await this.provisionRawCatalogAccount(slot, nicName, slot.accountName, { cli });
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      await cli.connectAccount(slot.accountName);
      await this.waitForSlotTerminalState(operationId, slotId, {
        timeoutMs: options.connectTimeoutMs,
        pollIntervalMs: options.statusPollIntervalMs,
      });
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING)) {
        return;
      }

      slot = this.findRawRelayCatalogItem({ slotId });
      if (!slot) {
        return;
      }
      slot.accountStatusKind = 'CONNECTED';
      slot.accountStatusText = 'Connected';
      slot.poolState = 'CONNECTED';
      slot.connectedAt = slot.connectedAt || new Date().toISOString();
      appendRawRelayCatalogLog(
        this.state.rawRelayCatalog,
        `${slot.slotId} 연결 성공 - ${(slot.ip || slot.fqdn) || '-'}:${slot.selectedSslPort || '-'}`,
      );
      this.syncRawRelayCatalogSummary();
      await this.saveState();
    } catch (error) {
      const releasedNicName = String(slot.nicName || nicName).trim().toUpperCase();
      await this.safeDeleteRawCatalogAccount(slot.accountName, { cli });
      slot = this.findRawRelayCatalogItem({ slotId });
      if (!slot) {
        return;
      }

      slot.poolState = 'ERROR';
      slot.lastErrorCode = 'SLOT_CONNECT_FAILED';
      slot.lastErrorMessage = String(error?.message || 'slot 연결 실패');
      this.clearRawRelayCatalogConnectionState(slotId, {
        keepNic: false,
        releaseNicName: releasedNicName,
      });
      appendRawRelayCatalogLog(this.state.rawRelayCatalog, `${slot.slotId} 연결 실패 - ${slot.lastErrorMessage}`);
      this.promoteNextDeferredRawRelayCatalogSlot(releasedNicName);
      this.syncRawRelayCatalogSummary();
      await this.saveState();
    }
  }

  async verifyRawRelayCatalogSlot(operationId, slotId) {
    let slot = this.findRawRelayCatalogItem({ slotId });
    if (!slot || slot.poolState !== 'CONNECTED') {
      return;
    }

    slot.poolState = 'VERIFYING';
    await this.saveState();

    try {
      await this.applyRawRelayCatalogRouteOwner(slotId, { operationId });
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING) && !this.isCurrentOperation(operationId, PHASE.SWITCHING)) {
        return;
      }

      await delay(DEFAULT_PARALLEL_PROBE_ROUTE_SETTLE_MS);
      if (!this.isCurrentOperation(operationId, PHASE.PREPARING) && !this.isCurrentOperation(operationId, PHASE.SWITCHING)) {
        return;
      }

      await this.refreshRawRelayCatalogRouteSnapshot({ operationId });
      slot = this.findRawRelayCatalogItem({ slotId });
      if (!slot) {
        return;
      }
      if (!slot.routeOwned) {
        throw new Error('metric 전환 후에도 이 slot이 기본 IPv4 route owner가 되지 않았습니다.');
      }

      const publicIp = await probeFreshPublicIpv4();
      const observedAt = new Date().toISOString();
      slot.poolState = 'VERIFIED';
      slot.lastVerifiedAt = observedAt;
      slot.exitPublicIp = String(publicIp.ip || '').trim();
      slot.exitPublicIpProvider = String(publicIp.provider || '').trim();
      slot.lastErrorCode = '';
      slot.lastErrorMessage = '';
      this.state.rawRelayCatalog.lastVerifiedAt = observedAt;
      this.state.rawRelayCatalog.lastVerifiedPublicIp = slot.exitPublicIp;
      this.state.rawRelayCatalog.lastVerifiedPublicIpProvider = slot.exitPublicIpProvider;
      appendRawRelayCatalogLog(
        this.state.rawRelayCatalog,
        `${slot.slotId} 출구 IPv4 확인 - ${slot.exitPublicIp || '-'} (${slot.exitPublicIpProvider || '-'})`,
      );
      this.syncRawRelayCatalogSummary();
      await this.saveState();
    } catch (error) {
      slot = this.findRawRelayCatalogItem({ slotId });
      if (!slot) {
        return;
      }
      slot.poolState = 'ERROR';
      slot.lastErrorCode = 'EXIT_IP_VERIFY_FAILED';
      slot.lastErrorMessage = String(error?.message || '출구 IPv4 확인 실패');
      appendRawRelayCatalogLog(this.state.rawRelayCatalog, `${slot.slotId} 검증 실패 - ${slot.lastErrorMessage}`);
      await this.safeDeleteRawCatalogAccount(slot.accountName);
      slot.accountStatusKind = 'MISSING';
      slot.accountStatusText = '';
      slot.routeOwned = false;
      slot.routeReady = false;
      this.syncRawRelayCatalogSummary();
      await this.saveState();
    }
  }

  syncRawRelayCatalogStatuses(accountRows = this.state.accountRows) {
    if (!this.state.rawRelayCatalog || !Array.isArray(this.state.rawRelayCatalog.items)) {
      return;
    }
    const accountMap = new Map(
      (Array.isArray(accountRows) ? accountRows : []).map(row => [String(row.name || '').trim(), row]),
    );
    for (const item of this.state.rawRelayCatalog.items) {
      const matchedAccount = accountMap.get(item.accountName) || null;
      item.accountStatusKind = matchedAccount?.statusKind || 'MISSING';
      item.accountStatusText = matchedAccount?.statusText || '';
      if (matchedAccount?.nicName) {
        item.nicName = String(matchedAccount.nicName || '').trim().toUpperCase();
      }
      if (matchedAccount?.statusKind === 'CONNECTED') {
        if (!item.connectedAt) {
          item.connectedAt = new Date().toISOString();
        }
        if (['IDLE', 'PENDING', 'NIC_READY', 'CONNECTING', 'PROVISIONING'].includes(item.poolState)) {
          item.poolState = 'CONNECTED';
        }
      } else if (!matchedAccount && ['CONNECTED', 'VERIFYING', 'VERIFIED'].includes(item.poolState)) {
        item.poolState = 'ERROR';
      }
      item.isActive = Boolean(this.state.rawRelayCatalog.activeSlotId) && item.slotId === this.state.rawRelayCatalog.activeSlotId;
    }
    syncRawRelayCatalogSummary(this.state.rawRelayCatalog);
  }

  findRawRelayCatalogItem(relay = {}) {
    const normalizedSlotId = String(relay.slotId || '').trim();
    if (normalizedSlotId) {
      return this.state.rawRelayCatalog.items.find(item => item.slotId === normalizedSlotId) || null;
    }

    const normalizedLookupKey = String(relay.lookupKey || '').trim() || buildRawRelayCatalogLookupKey(relay);
    return this.state.rawRelayCatalog.items.find((item) => (
      String(item.lookupKey || '').trim() === normalizedLookupKey
      || buildRawRelayCatalogLookupKey(item) === normalizedLookupKey
    )) || null;
  }
}

function buildInitialState(managedNicName) {
  return {
    phase: PHASE.IDLE,
    operationId: '',
    catalogEnabled: false,
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
    rawRelayCatalog: buildInitialRawRelayCatalogState(),
    parallelProbe: buildInitialParallelProbeState(),
  };
}

function buildDefaultRawRelayCatalogRequest() {
  return {
    limit: DEFAULT_RAW_RELAY_CATALOG_LIMIT,
    logicalSlotCount: DEFAULT_RAW_LIVE_POOL_LOGICAL_SLOT_COUNT,
    requestedPhysicalNicCount: DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT,
    connectConcurrency: DEFAULT_RAW_LIVE_POOL_CONNECT_CONCURRENCY,
    nicPrepareConcurrency: DEFAULT_RAW_LIVE_POOL_NIC_PREPARE_CONCURRENCY,
    verifyConcurrency: DEFAULT_RAW_LIVE_POOL_VERIFY_CONCURRENCY,
    experimentalMaxNicIndex: DEFAULT_RAW_LIVE_POOL_EXPERIMENTAL_MAX_NIC_INDEX,
    statusPollIntervalMs: DEFAULT_RAW_LIVE_POOL_STATUS_POLL_INTERVAL_MS,
    connectTimeoutMs: DEFAULT_RAW_LIVE_POOL_CONNECT_TIMEOUT_MS,
    preferredCountries: [...DEFAULT_PREFERRED_COUNTRIES],
    preferredPorts: [...DEFAULT_PREFERRED_PORTS],
  };
}

function buildInitialRawRelayCatalogState() {
  return {
    phase: PHASE.IDLE,
    stage: RAW_RELAY_CATALOG_STAGE.IDLE,
    startedAt: '',
    completedAt: '',
    sourceHostCount: 0,
    usableRelayCount: 0,
    requestedCandidateCount: 0,
    logicalSlotCount: 0,
    requestedPhysicalNicCount: 0,
    detectedPhysicalNicCapacity: 0,
    preparedNicCount: 0,
    connectAttemptedCount: 0,
    provisionableSlotCount: 0,
    connectedSlotCount: 0,
    verifiedSlotCount: 0,
    deadSlotCount: 0,
    failedSlotCount: 0,
    capacityDeferredSlotCount: 0,
    activeSlotId: '',
    routeOwnerSlotId: '',
    lastVerifiedAt: '',
    lastVerifiedPublicIp: '',
    lastVerifiedPublicIpProvider: '',
    lastErrorCode: '',
    lastErrorMessage: '',
    baselineMetricRows: [],
    availableNicNames: [],
    preparedNicNames: [],
    slotQueue: [],
    request: buildDefaultRawRelayCatalogRequest(),
    items: [],
    logs: [],
  };
}

function buildInactiveRawRelayCatalogState(currentState = {}) {
  const baseState = buildInitialRawRelayCatalogState();
  const normalizedState = normalizeRawRelayCatalogState(currentState);
  return {
    ...baseState,
    request: normalizedState.request,
    logs: normalizedState.logs,
  };
}

function normalizeRawRelayCatalogPrepareRequest(payload = {}) {
  const rawPayload = payload && typeof payload === 'object' ? payload : {};
  const normalizedLimit = Math.max(1, Math.min(
    DEFAULT_RAW_RELAY_CATALOG_LIMIT,
    normalizePositiveInteger(rawPayload.limit, DEFAULT_RAW_RELAY_CATALOG_LIMIT),
  ));
  return {
    limit: normalizedLimit,
    logicalSlotCount: Math.max(1, Math.min(
      normalizedLimit,
      normalizePositiveInteger(rawPayload.logicalSlotCount, DEFAULT_RAW_LIVE_POOL_LOGICAL_SLOT_COUNT),
    )),
    requestedPhysicalNicCount: Math.max(1, Math.min(
      DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT,
      normalizePositiveInteger(rawPayload.requestedPhysicalNicCount, DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT),
    )),
    connectConcurrency: Math.max(1, Math.min(
      DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT,
      normalizePositiveInteger(rawPayload.connectConcurrency, DEFAULT_RAW_LIVE_POOL_CONNECT_CONCURRENCY),
    )),
    nicPrepareConcurrency: Math.max(1, Math.min(
      DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT,
      normalizePositiveInteger(rawPayload.nicPrepareConcurrency, DEFAULT_RAW_LIVE_POOL_NIC_PREPARE_CONCURRENCY),
    )),
    verifyConcurrency: Math.max(1, Math.min(
      4,
      normalizePositiveInteger(rawPayload.verifyConcurrency, DEFAULT_RAW_LIVE_POOL_VERIFY_CONCURRENCY),
    )),
    experimentalMaxNicIndex: Math.max(2, Math.min(
      DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT,
      normalizeSoftEtherMaxNicIndex(
        rawPayload.experimentalMaxNicIndex,
        DEFAULT_RAW_LIVE_POOL_EXPERIMENTAL_MAX_NIC_INDEX,
      ),
    )),
    statusPollIntervalMs: Math.max(100, Math.min(
      10_000,
      normalizePositiveInteger(rawPayload.statusPollIntervalMs, DEFAULT_RAW_LIVE_POOL_STATUS_POLL_INTERVAL_MS),
    )),
    connectTimeoutMs: Math.max(5_000, Math.min(
      300_000,
      normalizePositiveInteger(rawPayload.connectTimeoutMs, DEFAULT_RAW_LIVE_POOL_CONNECT_TIMEOUT_MS),
    )),
    preferredCountries: normalizeCountryList(rawPayload.preferredCountries, DEFAULT_PREFERRED_COUNTRIES),
    preferredPorts: normalizePortList(rawPayload.preferredPorts).length > 0
      ? normalizePortList(rawPayload.preferredPorts)
      : [...DEFAULT_PREFERRED_PORTS],
  };
}

function normalizeRawRelayCatalogItem(item = {}) {
  const rawItem = item && typeof item === 'object' ? item : {};
  return {
    slotId: String(rawItem.slotId || '').trim(),
    lookupKey: String(rawItem.lookupKey || '').trim() || buildRawRelayCatalogLookupKey(rawItem),
    id: String(rawItem.id ?? '').trim(),
    ip: String(rawItem.ip || '').trim(),
    fqdn: String(rawItem.fqdn || '').trim(),
    hostName: String(rawItem.hostName || '').trim(),
    countryShort: String(rawItem.countryShort || '').trim().toUpperCase(),
    countryFull: String(rawItem.countryFull || '').trim(),
    selectedSslPort: normalizePort(rawItem.selectedSslPort, 0),
    sslPorts: normalizePortList(rawItem.sslPorts),
    udpPort: normalizePort(rawItem.udpPort, 0),
    hostUniqueKey: String(rawItem.hostUniqueKey || '').trim().toUpperCase(),
    score: Number(rawItem.score || 0),
    verifyDate: Number(rawItem.verifyDate || 0),
    accountName: String(rawItem.accountName || '').trim(),
    accountStatusKind: String(rawItem.accountStatusKind || 'MISSING').trim().toUpperCase() || 'MISSING',
    accountStatusText: String(rawItem.accountStatusText || '').trim(),
    preferredNicName: String(rawItem.preferredNicName || '').trim().toUpperCase(),
    nicName: String(rawItem.nicName || '').trim().toUpperCase(),
    poolState: String(rawItem.poolState || '').trim().toUpperCase() || 'IDLE',
    connectAttempted: Boolean(rawItem.connectAttempted),
    connectAttemptedAt: String(rawItem.connectAttemptedAt || '').trim(),
    capacityDeferred: Boolean(rawItem.capacityDeferred),
    nicPreparedAt: String(rawItem.nicPreparedAt || '').trim(),
    interfaceAlias: String(rawItem.interfaceAlias || '').trim(),
    interfaceIndex: Number.parseInt(String(rawItem.interfaceIndex || 0), 10) || 0,
    defaultRouteIfIndex: Number.parseInt(String(rawItem.defaultRouteIfIndex || 0), 10) || 0,
    routeOwned: Boolean(rawItem.routeOwned),
    routeReady: Boolean(rawItem.routeReady),
    connectedAt: String(rawItem.connectedAt || '').trim(),
    lastVerifiedAt: String(rawItem.lastVerifiedAt || '').trim(),
    exitPublicIp: String(rawItem.exitPublicIp || '').trim(),
    exitPublicIpProvider: String(rawItem.exitPublicIpProvider || '').trim(),
    lastErrorCode: String(rawItem.lastErrorCode || '').trim(),
    lastErrorMessage: String(rawItem.lastErrorMessage || '').trim(),
    isActive: Boolean(rawItem.isActive),
  };
}

function normalizeRawRelayCatalogState(value = {}) {
  const baseState = buildInitialRawRelayCatalogState();
  const rawState = value && typeof value === 'object' ? value : {};
  return {
    ...baseState,
    ...rawState,
    phase: normalizePhase(rawState.phase || baseState.phase),
    stage: String(rawState.stage || baseState.stage || RAW_RELAY_CATALOG_STAGE.IDLE).trim().toUpperCase() || RAW_RELAY_CATALOG_STAGE.IDLE,
    startedAt: String(rawState.startedAt || '').trim(),
    completedAt: String(rawState.completedAt || '').trim(),
    sourceHostCount: Number.parseInt(String(rawState.sourceHostCount || 0), 10) || 0,
    usableRelayCount: Number.parseInt(String(
      rawState.usableRelayCount
      || rawState.verifiedSlotCount
      || 0,
    ), 10) || 0,
    requestedCandidateCount: Number.parseInt(String(rawState.requestedCandidateCount || 0), 10) || 0,
    logicalSlotCount: Number.parseInt(String(rawState.logicalSlotCount || 0), 10) || 0,
    requestedPhysicalNicCount: Number.parseInt(String(rawState.requestedPhysicalNicCount || 0), 10) || 0,
    detectedPhysicalNicCapacity: Number.parseInt(String(
      rawState.detectedPhysicalNicCapacity
      || rawState.provisionableSlotCount
      || 0,
    ), 10) || 0,
    preparedNicCount: Number.parseInt(String(rawState.preparedNicCount || 0), 10) || 0,
    connectAttemptedCount: Number.parseInt(String(rawState.connectAttemptedCount || 0), 10) || 0,
    provisionableSlotCount: Number.parseInt(String(rawState.provisionableSlotCount || 0), 10) || 0,
    connectedSlotCount: Number.parseInt(String(rawState.connectedSlotCount || 0), 10) || 0,
    verifiedSlotCount: Number.parseInt(String(rawState.verifiedSlotCount || 0), 10) || 0,
    deadSlotCount: Number.parseInt(String(rawState.deadSlotCount || 0), 10) || 0,
    failedSlotCount: Number.parseInt(String(rawState.failedSlotCount || 0), 10) || 0,
    capacityDeferredSlotCount: Number.parseInt(String(rawState.capacityDeferredSlotCount || 0), 10) || 0,
    activeSlotId: String(rawState.activeSlotId || '').trim(),
    routeOwnerSlotId: String(rawState.routeOwnerSlotId || '').trim(),
    lastVerifiedAt: String(rawState.lastVerifiedAt || '').trim(),
    lastVerifiedPublicIp: String(rawState.lastVerifiedPublicIp || '').trim(),
    lastVerifiedPublicIpProvider: String(rawState.lastVerifiedPublicIpProvider || '').trim(),
    lastErrorCode: String(rawState.lastErrorCode || '').trim(),
    lastErrorMessage: String(rawState.lastErrorMessage || '').trim(),
    baselineMetricRows: Array.isArray(rawState.baselineMetricRows) ? rawState.baselineMetricRows : [],
    availableNicNames: Array.isArray(rawState.availableNicNames)
      ? rawState.availableNicNames.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [],
    preparedNicNames: Array.isArray(rawState.preparedNicNames)
      ? rawState.preparedNicNames.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [],
    slotQueue: Array.isArray(rawState.slotQueue)
      ? rawState.slotQueue.map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        return {
          slotId: String(entry.slotId || '').trim(),
          poolState: String(entry.poolState || '').trim().toUpperCase(),
          nicName: String(entry.nicName || '').trim().toUpperCase(),
          capacityDeferred: Boolean(entry.capacityDeferred),
          connectAttempted: Boolean(entry.connectAttempted),
        };
      }).filter(Boolean)
      : [],
    request: normalizeRawRelayCatalogPrepareRequest(rawState.request || {}),
    items: Array.isArray(rawState.items)
      ? rawState.items.map((item) => normalizeRawRelayCatalogItem(item))
      : [],
    logs: Array.isArray(rawState.logs)
      ? rawState.logs.map(entry => String(entry || '').trim()).filter(Boolean).slice(0, 50)
      : [],
  };
}

function shouldCollapseRawRelayCatalogState(state = {}) {
  const topLevelPhase = normalizePhase(state.phase || PHASE.IDLE);
  if (Boolean(state.catalogEnabled) || Boolean(state.accountName)) {
    return false;
  }

  if (![PHASE.IDLE, PHASE.ERROR].includes(topLevelPhase)) {
    return false;
  }

  const rawRelayCatalog = normalizeRawRelayCatalogState(state.rawRelayCatalog || {});
  const hasCatalogError = Boolean(rawRelayCatalog.lastErrorCode || rawRelayCatalog.lastErrorMessage);
  if (topLevelPhase === PHASE.ERROR && hasCatalogError) {
    return false;
  }

  return Boolean(
    rawRelayCatalog.startedAt
    || rawRelayCatalog.completedAt
    || rawRelayCatalog.stage !== RAW_RELAY_CATALOG_STAGE.IDLE
    || rawRelayCatalog.sourceHostCount > 0
    || rawRelayCatalog.usableRelayCount > 0
    || rawRelayCatalog.requestedCandidateCount > 0
    || rawRelayCatalog.logicalSlotCount > 0
    || rawRelayCatalog.requestedPhysicalNicCount > 0
    || rawRelayCatalog.detectedPhysicalNicCapacity > 0
    || rawRelayCatalog.preparedNicCount > 0
    || rawRelayCatalog.connectAttemptedCount > 0
    || rawRelayCatalog.provisionableSlotCount > 0
    || rawRelayCatalog.connectedSlotCount > 0
    || rawRelayCatalog.verifiedSlotCount > 0
    || rawRelayCatalog.deadSlotCount > 0
    || rawRelayCatalog.failedSlotCount > 0
    || rawRelayCatalog.capacityDeferredSlotCount > 0
    || rawRelayCatalog.activeSlotId
    || rawRelayCatalog.routeOwnerSlotId
    || rawRelayCatalog.lastVerifiedAt
    || rawRelayCatalog.lastVerifiedPublicIp
    || (Array.isArray(rawRelayCatalog.preparedNicNames) && rawRelayCatalog.preparedNicNames.length > 0)
    || (Array.isArray(rawRelayCatalog.items) && rawRelayCatalog.items.length > 0)
    || [PHASE.PREPARING, PHASE.READY, PHASE.SWITCHING, PHASE.CONNECTED].includes(rawRelayCatalog.phase)
  );
}

function reconcileRawRelayCatalogState(state = {}) {
  if (!state || typeof state !== 'object') {
    return buildInitialRawRelayCatalogState();
  }

  if (!shouldCollapseRawRelayCatalogState(state)) {
    state.rawRelayCatalog = normalizeRawRelayCatalogState(state.rawRelayCatalog || {});
    return state.rawRelayCatalog;
  }

  state.rawRelayCatalog = buildInactiveRawRelayCatalogState(state.rawRelayCatalog);
  return state.rawRelayCatalog;
}

function buildRawRelayCatalogLookupKey(relay = {}) {
  const slotId = String(relay.slotId || '').trim();
  if (slotId) {
    return slotId;
  }
  const relayId = String(relay.id ?? '').trim();
  const relayHost = String(relay.ip || relay.fqdn || '').trim();
  const relayPort = normalizePort(relay.selectedSslPort, 0);
  return `${relayId || relayHost}:${relayPort}`;
}

function buildRawCatalogSlotId(index = 0) {
  const normalizedIndex = Math.max(1, Number.parseInt(String(index || 0), 10) || 1);
  return `slot-${String(normalizedIndex).padStart(3, '0')}`;
}

function buildRawCatalogSlotAccountName(slotId = '') {
  const slotToken = sanitizeManagedToken(String(slotId || '').trim() || 'slot');
  return `${MANAGED_ACCOUNT_PREFIX.replace('GATE', 'RAWCACHE')}${slotToken}`.slice(0, 63);
}

function buildRawLogicalSlotItems(relays = [], logicalSlotCount = 0) {
  const normalizedLogicalSlotCount = Math.max(
    0,
    Math.min(
      Number.parseInt(String(logicalSlotCount || 0), 10) || 0,
      Array.isArray(relays) ? relays.length : 0,
    ),
  );

  return (Array.isArray(relays) ? relays : [])
    .slice(0, normalizedLogicalSlotCount)
    .map((relay, index) => {
      const slotId = buildRawCatalogSlotId(index + 1);
      return {
        ...relay,
        slotId,
        lookupKey: buildRawRelayCatalogLookupKey({ ...relay, slotId }),
        accountName: buildRawCatalogSlotAccountName(slotId),
        preferredNicName: '',
        nicName: '',
        poolState: 'PENDING',
        connectAttempted: false,
        connectAttemptedAt: '',
        capacityDeferred: false,
        nicPreparedAt: '',
        interfaceAlias: '',
        interfaceIndex: 0,
        defaultRouteIfIndex: 0,
        routeOwned: false,
        routeReady: false,
        connectedAt: '',
        lastVerifiedAt: '',
        exitPublicIp: '',
        exitPublicIpProvider: '',
        lastErrorCode: '',
        lastErrorMessage: '',
      };
    });
}

function buildRawCatalogSlotNicNames(managedNicName = '', limit = 0, options = {}) {
  const normalizedManagedNicName = String(managedNicName || '').trim().toUpperCase();
  const candidates = buildSoftEtherNicCandidateList(normalizedManagedNicName, {
    maxNicIndex: normalizeSoftEtherMaxNicIndex(options.maxNicIndex, DEFAULT_RAW_LIVE_POOL_EXPERIMENTAL_MAX_NIC_INDEX),
  })
    .filter(nicName => nicName !== normalizedManagedNicName);
  return normalizePositiveInteger(limit, 0) > 0
    ? candidates.slice(0, normalizePositiveInteger(limit, 0))
    : candidates;
}

function buildRawRelayCatalogItems(relays = [], accountRows = [], nicName = '', activeSlotId = '') {
  const accountMap = new Map(
    (Array.isArray(accountRows) ? accountRows : []).map(row => [String(row.name || '').trim(), row]),
  );

  return relays.map((relay) => {
    const normalizedRelay = normalizeRawRelayCatalogItem({
      ...relay,
      slotId: String(relay.slotId || '').trim(),
      lookupKey: String(relay.lookupKey || '').trim() || buildRawRelayCatalogLookupKey(relay),
      accountName: String(relay.accountName || buildRawCatalogSlotAccountName(relay.slotId || '')).trim(),
      preferredNicName: String(relay.preferredNicName || relay.nicName || nicName || '').trim().toUpperCase(),
      nicName: String(relay.nicName || '').trim().toUpperCase(),
    });
    const matchedAccount = accountMap.get(normalizedRelay.accountName) || null;
    let nextPoolState = normalizedRelay.poolState;
    if (matchedAccount?.statusKind === 'CONNECTED' && ['IDLE', 'PROVISIONING', 'CONNECTING'].includes(nextPoolState)) {
      nextPoolState = 'CONNECTED';
    } else if (!matchedAccount && ['CONNECTED', 'VERIFYING', 'VERIFIED'].includes(nextPoolState)) {
      nextPoolState = 'ERROR';
    }
    return {
      ...normalizedRelay,
      accountStatusKind: matchedAccount?.statusKind || 'MISSING',
      accountStatusText: matchedAccount?.statusText || '',
      preferredNicName: String(normalizedRelay.preferredNicName || nicName || '').trim().toUpperCase(),
      nicName: String(matchedAccount?.nicName || normalizedRelay.nicName || '').trim().toUpperCase(),
      poolState: nextPoolState,
      isActive: normalizedRelay.slotId !== '' && normalizedRelay.slotId === String(activeSlotId || '').trim(),
    };
  });
}

function syncRawRelayCatalogSummary(rawRelayCatalog = {}) {
  if (!rawRelayCatalog || !Array.isArray(rawRelayCatalog.items)) {
    return rawRelayCatalog;
  }

  const connectedSlotCount = rawRelayCatalog.items.filter((item) => (
    item.accountStatusKind === 'CONNECTED'
    && ['CONNECTED', 'VERIFYING', 'VERIFIED'].includes(item.poolState)
  )).length;
  const verifiedSlotCount = rawRelayCatalog.items.filter(item => item.poolState === 'VERIFIED').length;
  const deadSlotCount = rawRelayCatalog.items.filter(item => ['ERROR', 'DEAD'].includes(item.poolState)).length;
  const failedSlotCount = rawRelayCatalog.items.filter(item => item.lastErrorCode || item.lastErrorMessage).length;
  const capacityDeferredSlotCount = rawRelayCatalog.items.filter(item => item.capacityDeferred || item.poolState === 'CAPACITY_DEFERRED').length;
  const connectAttemptedCount = rawRelayCatalog.items.filter(item => item.connectAttempted).length;
  const preparedNicNames = [];
  const seenPreparedNicNames = new Set();
  for (const item of rawRelayCatalog.items) {
    const nicName = String(item.nicName || item.preferredNicName || '').trim().toUpperCase();
    if (!nicName || seenPreparedNicNames.has(nicName) || ['PENDING', 'CAPACITY_DEFERRED'].includes(item.poolState)) {
      continue;
    }
    seenPreparedNicNames.add(nicName);
    preparedNicNames.push(nicName);
  }

  rawRelayCatalog.logicalSlotCount = Math.max(
    Number.parseInt(String(rawRelayCatalog.logicalSlotCount || 0), 10) || 0,
    rawRelayCatalog.items.length,
  );
  rawRelayCatalog.detectedPhysicalNicCapacity = Math.max(
    Number.parseInt(String(rawRelayCatalog.detectedPhysicalNicCapacity || 0), 10) || 0,
    preparedNicNames.length,
  );
  rawRelayCatalog.preparedNicCount = preparedNicNames.length;
  rawRelayCatalog.connectAttemptedCount = connectAttemptedCount;
  rawRelayCatalog.connectedSlotCount = connectedSlotCount;
  rawRelayCatalog.verifiedSlotCount = verifiedSlotCount;
  rawRelayCatalog.deadSlotCount = deadSlotCount;
  rawRelayCatalog.failedSlotCount = failedSlotCount;
  rawRelayCatalog.capacityDeferredSlotCount = capacityDeferredSlotCount;
  rawRelayCatalog.usableRelayCount = verifiedSlotCount;
  rawRelayCatalog.preparedNicNames = preparedNicNames;
  rawRelayCatalog.provisionableSlotCount = rawRelayCatalog.detectedPhysicalNicCapacity;
  rawRelayCatalog.slotQueue = rawRelayCatalog.items.slice(0, 20).map(item => ({
    slotId: item.slotId,
    poolState: item.poolState,
    nicName: item.nicName || item.preferredNicName || '',
    capacityDeferred: Boolean(item.capacityDeferred),
    connectAttempted: Boolean(item.connectAttempted),
  }));

  if (!rawRelayCatalog.activeSlotId || !rawRelayCatalog.items.some(item => item.slotId === rawRelayCatalog.activeSlotId && item.poolState === 'VERIFIED')) {
    rawRelayCatalog.activeSlotId = '';
  }
  if (!rawRelayCatalog.routeOwnerSlotId || !rawRelayCatalog.items.some(item => item.slotId === rawRelayCatalog.routeOwnerSlotId)) {
    rawRelayCatalog.routeOwnerSlotId = '';
  }

  for (const item of rawRelayCatalog.items) {
    item.isActive = Boolean(rawRelayCatalog.activeSlotId) && item.slotId === rawRelayCatalog.activeSlotId;
  }
  return rawRelayCatalog;
}

function buildPublicRawRelayCatalogState(rawRelayCatalog = {}, state = {}) {
  const normalized = syncRawRelayCatalogSummary(normalizeRawRelayCatalogState(rawRelayCatalog));
  return {
    phase: normalized.phase,
    stage: normalized.stage,
    startedAt: normalized.startedAt,
    completedAt: normalized.completedAt,
    sourceHostCount: normalized.sourceHostCount,
    usableRelayCount: normalized.usableRelayCount,
    requestedCandidateCount: normalized.requestedCandidateCount,
    logicalSlotCount: normalized.logicalSlotCount,
    requestedPhysicalNicCount: normalized.requestedPhysicalNicCount,
    detectedPhysicalNicCapacity: normalized.detectedPhysicalNicCapacity,
    preparedNicCount: normalized.preparedNicCount,
    connectAttemptedCount: normalized.connectAttemptedCount,
    provisionableSlotCount: normalized.provisionableSlotCount,
    connectedSlotCount: normalized.connectedSlotCount,
    verifiedSlotCount: normalized.verifiedSlotCount,
    deadSlotCount: normalized.deadSlotCount,
    failedSlotCount: normalized.failedSlotCount,
    capacityDeferredSlotCount: normalized.capacityDeferredSlotCount,
    activeSlotId: normalized.activeSlotId,
    routeOwnerSlotId: normalized.routeOwnerSlotId,
    lastVerifiedAt: normalized.lastVerifiedAt,
    lastVerifiedPublicIp: normalized.lastVerifiedPublicIp,
    lastVerifiedPublicIpProvider: normalized.lastVerifiedPublicIpProvider,
    lastErrorCode: normalized.lastErrorCode,
    lastErrorMessage: normalized.lastErrorMessage,
    availableNicNames: normalized.availableNicNames,
    preparedNicNames: normalized.preparedNicNames,
    slotQueue: normalized.slotQueue,
    request: normalized.request,
    items: normalized.items,
    logs: normalized.logs.slice(0, 20),
  };
}

function appendRawRelayCatalogLog(rawRelayCatalog, message) {
  if (!rawRelayCatalog) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString('ko-KR', {
    hour12: false,
  });
  const entry = `[${timestamp}] ${String(message || '').trim()}`;
  const nextLogs = Array.isArray(rawRelayCatalog.logs) ? rawRelayCatalog.logs.slice(0, 49) : [];
  rawRelayCatalog.logs = [entry, ...nextLogs];
}

function markRawRelayCatalogActiveItem(rawRelayCatalog, accountName = '') {
  if (!rawRelayCatalog || !Array.isArray(rawRelayCatalog.items)) {
    return;
  }

  const normalizedKey = String(accountName || '').trim();
  for (const item of rawRelayCatalog.items) {
    item.isActive = normalizedKey !== '' && (item.accountName === normalizedKey || item.slotId === normalizedKey);
  }
  rawRelayCatalog.activeSlotId = rawRelayCatalog.items.find(item => item.isActive)?.slotId || '';
}

function buildInitialParallelProbeState() {
  return {
    isRunning: false,
    operationId: '',
    phase: PARALLEL_PROBE_PHASE.IDLE,
    startedAt: '',
    completedAt: '',
    lastVerifiedAt: '',
    routeOwnerSlotId: '',
    lastVerifiedPublicIp: '',
    lastVerifiedPublicIpProvider: '',
    lastErrorCode: '',
    lastErrorMessage: '',
    baselineMetricRows: [],
    request: buildDefaultParallelProbeRequest(),
    slots: DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES.map((nicName, index) => buildInitialParallelProbeSlot(`slot-${index + 1}`, nicName)),
    logs: [],
  };
}

function buildInitialParallelProbeSlot(slotId, nicName) {
  return {
    slotId,
    nicName,
    phase: 'IDLE',
    accountName: '',
    connectedAt: '',
    lastVerifiedAt: '',
    routeOwned: false,
    routeReady: false,
    interfaceAlias: '',
    interfaceIndex: 0,
    defaultRouteIfIndex: 0,
    exitPublicIp: '',
    exitPublicIpProvider: '',
    lastErrorCode: '',
    lastErrorMessage: '',
    underlayProtocol: '',
    udpAccelerationActive: false,
    relay: {
      id: '',
      ip: '',
      fqdn: '',
      countryShort: '',
      countryFull: '',
      selectedSslPort: 0,
      udpPort: 0,
      hostUniqueKey: '',
    },
  };
}

function buildDefaultParallelProbeRequest() {
  return {
    limit: DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES.length,
    preferredCountries: [...DEFAULT_PREFERRED_COUNTRIES],
    preferredPorts: [...DEFAULT_PREFERRED_PORTS],
    slotNicNames: [...DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES],
    relays: [],
  };
}

function normalizeParallelProbeRequest(payload = {}) {
  const rawPayload = payload && typeof payload === 'object' ? payload : {};
  const limit = Math.min(
    DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES.length,
    normalizePositiveInteger(rawPayload.limit, DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES.length),
  );
  const slotNicNames = normalizeParallelProbeSlotNicNames(rawPayload.slotNicNames, limit);
  const preferredCountries = normalizeCountryList(rawPayload.preferredCountries, DEFAULT_PREFERRED_COUNTRIES);
  const preferredPorts = normalizePortList(rawPayload.preferredPorts);
  const rawRelays = Array.isArray(rawPayload.relays) ? rawPayload.relays.slice(0, limit) : [];
  const relays = rawRelays.map((relay) => {
    const normalized = normalizeConnectRequest({
      mode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
      relay,
    });
    return {
      id: String(normalized.relay.id || '').trim(),
      ip: String(normalized.relay.ip || '').trim(),
      fqdn: String(normalized.relay.fqdn || '').trim(),
      selectedSslPort: Number(normalized.relay.selectedSslPort || 0),
      udpPort: Number(normalized.relay.udpPort || 0),
      hostUniqueKey: String(normalized.relay.hostUniqueKey || '').trim(),
      countryShort: String(relay?.countryShort || '').trim().toUpperCase(),
      countryFull: String(relay?.countryFull || '').trim(),
    };
  });

  return {
    limit,
    preferredCountries,
    preferredPorts: preferredPorts.length > 0 ? preferredPorts : [...DEFAULT_PREFERRED_PORTS],
    slotNicNames,
    relays,
  };
}

function normalizeParallelProbeSlotNicNames(value, limit) {
  const rawValues = Array.isArray(value) ? value : DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES;
  const normalized = [];
  const seen = new Set();

  for (const rawValue of rawValues) {
    const nicName = normalizePreferredSoftEtherNicName(rawValue, rawValue);
    if (!nicName || seen.has(nicName)) {
      continue;
    }
    seen.add(nicName);
    normalized.push(nicName);
    if (normalized.length >= limit) {
      break;
    }
  }

  for (const fallbackNicName of DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES) {
    const nicName = normalizePreferredSoftEtherNicName(fallbackNicName, fallbackNicName);
    if (seen.has(nicName)) {
      continue;
    }
    seen.add(nicName);
    normalized.push(nicName);
    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized.slice(0, limit);
}

function normalizeCountryList(value, fallback = []) {
  const rawValues = Array.isArray(value) ? value : fallback;
  const normalized = [];
  const seen = new Set();
  for (const rawValue of rawValues) {
    const country = String(rawValue || '').trim().toUpperCase();
    if (!country || seen.has(country)) {
      continue;
    }
    seen.add(country);
    normalized.push(country);
  }
  return normalized;
}

function normalizeParallelProbePhase(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return PARALLEL_PROBE_PHASE.IDLE;
  }

  if (Object.values(PARALLEL_PROBE_PHASE).includes(normalized)) {
    return normalized;
  }

  if (['RUNNING', 'ACTIVE', 'PROVISIONING'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.PREPARING;
  }

  if (['VERIFY', 'VERIFIED'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.VERIFYING;
  }

  if (['DONE', 'FINISHED'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.COMPLETE;
  }

  if (['FAIL', 'FAILED'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.ERROR;
  }

  return PARALLEL_PROBE_PHASE.IDLE;
}

function isParallelProbeActivePhase(value) {
  return [
    PARALLEL_PROBE_PHASE.PREPARING,
    PARALLEL_PROBE_PHASE.CONNECTING,
    PARALLEL_PROBE_PHASE.VERIFYING,
    PARALLEL_PROBE_PHASE.COMPLETE,
    PARALLEL_PROBE_PHASE.STOPPING,
  ].includes(normalizeParallelProbePhase(value));
}

function normalizeParallelProbeSlot(slot = {}, fallbackIndex = 0) {
  const baseSlot = buildInitialParallelProbeSlot(
    String(slot.slotId || `slot-${fallbackIndex + 1}`),
    String(slot.nicName || DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES[fallbackIndex] || `VPN${fallbackIndex + 2}`),
  );
  const rawRelay = slot.relay && typeof slot.relay === 'object' ? slot.relay : {};

  return {
    ...baseSlot,
    ...slot,
    slotId: baseSlot.slotId,
    nicName: baseSlot.nicName,
    phase: String(slot.phase || baseSlot.phase).trim().toUpperCase() || 'IDLE',
    accountName: String(slot.accountName || '').trim(),
    connectedAt: String(slot.connectedAt || '').trim(),
    lastVerifiedAt: String(slot.lastVerifiedAt || '').trim(),
    routeOwned: Boolean(slot.routeOwned),
    routeReady: Boolean(slot.routeReady),
    interfaceAlias: String(slot.interfaceAlias || '').trim(),
    interfaceIndex: Number.parseInt(String(slot.interfaceIndex || 0), 10) || 0,
    defaultRouteIfIndex: Number.parseInt(String(slot.defaultRouteIfIndex || 0), 10) || 0,
    exitPublicIp: String(slot.exitPublicIp || '').trim(),
    exitPublicIpProvider: String(slot.exitPublicIpProvider || '').trim(),
    lastErrorCode: String(slot.lastErrorCode || '').trim(),
    lastErrorMessage: String(slot.lastErrorMessage || '').trim(),
    underlayProtocol: String(slot.underlayProtocol || '').trim(),
    udpAccelerationActive: Boolean(slot.udpAccelerationActive),
    relay: {
      id: String(rawRelay.id ?? '').trim(),
      ip: String(rawRelay.ip || '').trim(),
      fqdn: String(rawRelay.fqdn || '').trim(),
      countryShort: String(rawRelay.countryShort || '').trim().toUpperCase(),
      countryFull: String(rawRelay.countryFull || '').trim(),
      selectedSslPort: normalizePort(rawRelay.selectedSslPort, 0),
      udpPort: normalizePort(rawRelay.udpPort, 0),
      hostUniqueKey: String(rawRelay.hostUniqueKey || '').trim().toUpperCase(),
    },
  };
}

function normalizeParallelProbeState(value = {}) {
  const baseState = buildInitialParallelProbeState();
  const rawState = value && typeof value === 'object' ? value : {};
  const rawRequest = rawState.request && typeof rawState.request === 'object'
    ? rawState.request
    : {};
  const normalizedRequest = normalizeParallelProbeRequest({
    ...rawRequest,
    relays: Array.isArray(rawRequest.relays) ? rawRequest.relays : [],
  });
  const normalizedSlots = Array.isArray(rawState.slots)
    ? rawState.slots.map((slot, index) => normalizeParallelProbeSlot(slot, index))
    : baseState.slots;

  return {
    ...baseState,
    ...rawState,
    isRunning: Boolean(rawState.isRunning) || isParallelProbeActivePhase(rawState.phase),
    operationId: String(rawState.operationId || '').trim(),
    phase: normalizeParallelProbePhase(rawState.phase),
    startedAt: String(rawState.startedAt || '').trim(),
    completedAt: String(rawState.completedAt || '').trim(),
    lastVerifiedAt: String(rawState.lastVerifiedAt || '').trim(),
    routeOwnerSlotId: String(rawState.routeOwnerSlotId || '').trim(),
    lastVerifiedPublicIp: String(rawState.lastVerifiedPublicIp || '').trim(),
    lastVerifiedPublicIpProvider: String(rawState.lastVerifiedPublicIpProvider || '').trim(),
    lastErrorCode: String(rawState.lastErrorCode || '').trim(),
    lastErrorMessage: String(rawState.lastErrorMessage || '').trim(),
    baselineMetricRows: Array.isArray(rawState.baselineMetricRows) ? rawState.baselineMetricRows : [],
    request: normalizedRequest,
    slots: normalizedSlots,
    logs: Array.isArray(rawState.logs)
      ? rawState.logs.map(item => String(item || '').trim()).filter(Boolean).slice(0, 50)
      : [],
  };
}

function buildParallelProbeSlotsFromRelays(relays = [], slotNicNames = DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES) {
  return relays.map((relay, index) => ({
    ...buildInitialParallelProbeSlot(`slot-${index + 1}`, slotNicNames[index] || DEFAULT_PARALLEL_PROBE_SLOT_NIC_NAMES[index] || `VPN${index + 2}`),
    relay: {
      id: String(relay.id ?? '').trim(),
      ip: String(relay.ip || '').trim(),
      fqdn: String(relay.fqdn || '').trim(),
      countryShort: String(relay.countryShort || '').trim().toUpperCase(),
      countryFull: String(relay.countryFull || '').trim(),
      selectedSslPort: normalizePort(relay.selectedSslPort, 0),
      udpPort: normalizePort(relay.udpPort, 0),
      hostUniqueKey: String(relay.hostUniqueKey || '').trim().toUpperCase(),
    },
  }));
}

function buildPublicParallelProbeState(parallelProbe = {}) {
  const normalized = normalizeParallelProbeState(parallelProbe);
  return {
    isRunning: Boolean(normalized.isRunning),
    phase: normalized.phase,
    startedAt: normalized.startedAt,
    completedAt: normalized.completedAt,
    lastVerifiedAt: normalized.lastVerifiedAt,
    routeOwnerSlotId: normalized.routeOwnerSlotId,
    lastVerifiedPublicIp: normalized.lastVerifiedPublicIp,
    lastVerifiedPublicIpProvider: normalized.lastVerifiedPublicIpProvider,
    lastErrorCode: normalized.lastErrorCode,
    lastErrorMessage: normalized.lastErrorMessage,
    slots: normalized.slots,
    logs: normalized.logs,
  };
}

function appendParallelProbeLog(parallelProbe, message) {
  if (!parallelProbe) {
    return;
  }

  const timestamp = new Date().toLocaleTimeString('ko-KR', {
    hour12: false,
  });
  const entry = `[${timestamp}] ${String(message || '').trim()}`;
  const nextLogs = Array.isArray(parallelProbe.logs) ? parallelProbe.logs.slice(0, 49) : [];
  parallelProbe.logs = [entry, ...nextLogs];
}

function buildParallelProbeAccountName(slot = {}) {
  const relayToken = slot?.relay?.id || slot?.relay?.ip || slot?.relay?.fqdn || slot?.slotId || 'slot';
  const portToken = normalizePort(slot?.relay?.selectedSslPort, 0) || 'port';
  return `${PARALLEL_PROBE_ACCOUNT_PREFIX}${sanitizeManagedToken(relayToken)}-${sanitizeManagedToken(slot.slotId || 'slot')}-${portToken}-${Date.now().toString(36)}`.slice(0, 63);
}

function isParallelProbeAccountName(value) {
  return String(value || '').trim().toUpperCase().startsWith(PARALLEL_PROBE_ACCOUNT_PREFIX);
}

function isAgentOwnedSingleConnectionAccountName(value) {
  return isManagedAccountName(value);
}

function resolveParallelProbeInterfaceInfo(localSnapshot = {}, slot = {}) {
  const nicName = String(slot.nicName || '').trim().toUpperCase();
  const ipConfigs = Array.isArray(localSnapshot.ipConfigs) ? localSnapshot.ipConfigs : [];
  const ipv4DefaultRoutes = Array.isArray(localSnapshot.ipv4DefaultRoutes) ? localSnapshot.ipv4DefaultRoutes : [];

  const matchingIpConfig = ipConfigs.find((item) => {
    const interfaceAlias = String(item.InterfaceAlias || '').trim().toUpperCase();
    return interfaceAlias === nicName
      || interfaceAlias.startsWith(`${nicName} `)
      || interfaceAlias.includes(`${nicName} -`)
      || interfaceAlias.startsWith(`${nicName}-`);
  }) || null;

  const interfaceIndex = Number.parseInt(
    String(matchingIpConfig?.InterfaceIndex || slot.interfaceIndex || 0),
    10,
  ) || 0;
  const interfaceAlias = String(matchingIpConfig?.InterfaceAlias || slot.interfaceAlias || '').trim();
  const routeReady = interfaceIndex > 0 && ipv4DefaultRoutes.some(route => Number(route.ifIndex || 0) === interfaceIndex);
  const routeOwned = interfaceIndex > 0 && Number(localSnapshot?.primaryIpv4Route?.ifIndex || 0) === interfaceIndex;

  return {
    interfaceAlias,
    interfaceIndex,
    defaultRouteIfIndex: routeReady ? interfaceIndex : 0,
    routeReady,
    routeOwned,
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
  const slotId = String(relay.slotId || '').trim();
  const lookupKey = String(relay.lookupKey || '').trim();
  const relayId = String(relay.id ?? '').trim();
  const relayFqdn = String(relay.fqdn || '').trim();
  const relayIp = String(relay.ip || '').trim();
  const relayHost = relayIp || relayFqdn;
  const selectedSslPort = normalizePort(relay.selectedSslPort, 0);
  const sslPorts = buildRelayPortAttemptList({
    selectedSslPort,
    sslPorts: relay.sslPorts,
  });

  if (!slotId && !lookupKey && !relayHost) {
    throw httpError(400, 'RELAY_HOST_REQUIRED', 'raw 모드에서는 relay.ip 또는 relay.fqdn 이 필요합니다.');
  }

  if (!slotId && !lookupKey && !selectedSslPort) {
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
      slotId,
      lookupKey,
      id: relayId,
      fqdn: relayFqdn,
      ip: relayIp,
      selectedSslPort,
      sslPorts,
      udpPort: normalizePort(relay.udpPort, 0),
      hostUniqueKey,
      accountName: String(relay.accountName || '').trim(),
      nicName: String(relay.nicName || '').trim().toUpperCase(),
    },
  };
}

function normalizeConnectionMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === CONNECTION_MODE.SOFTETHER_VPNGATE_RAW
    ? CONNECTION_MODE.SOFTETHER_VPNGATE_RAW
    : CONNECTION_MODE.PROFILE;
}

function normalizePhase(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return PHASE.IDLE;
  }

  if (Object.values(PHASE).includes(normalized)) {
    return normalized;
  }

  if (['PREPARE', 'PREPARING_CATALOG', 'SYNCING'].includes(normalized)) {
    return PHASE.PREPARING;
  }

  if (['READY', 'CATALOG_READY'].includes(normalized)) {
    return PHASE.READY;
  }

  if (['SWITCHING', 'OWNER_SWITCH', 'ROUTE_SWITCH'].includes(normalized)) {
    return PHASE.SWITCHING;
  }

  if (['CONNECTED', 'RUNNING', 'ACTIVE', 'UP'].includes(normalized)) {
    return PHASE.CONNECTED;
  }

  if (['CONNECTING', 'STARTING', 'PENDING'].includes(normalized)) {
    return PHASE.CONNECTING;
  }

  if (['DISCONNECTING', 'STOPPING'].includes(normalized)) {
    return PHASE.DISCONNECTING;
  }

  if (['ERROR', 'FAILED', 'FAIL'].includes(normalized)) {
    return PHASE.ERROR;
  }

  return PHASE.IDLE;
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

      if (request.method === 'GET' && url.pathname === '/v1/vpn/parallel-probe/status') {
        sendJson(response, 200, await agent.getParallelProbeStatus());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/catalog/prepare') {
        sendJson(response, 200, await agent.prepareRawRelayCatalog(await readJsonBody(request)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/catalog/prime-nics') {
        sendJson(response, 200, await agent.primeRawCatalogNics(await readJsonBody(request)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/catalog/activate') {
        sendJson(response, 200, await agent.activateCatalogRelay(await readJsonBody(request)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/connect') {
        sendJson(response, 200, await agent.connect(await readJsonBody(request)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/parallel-probe/start') {
        sendJson(response, 200, await agent.startParallelProbe(await readJsonBody(request)));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/disconnect') {
        sendJson(response, 200, await agent.disconnect());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/vpn/parallel-probe/stop') {
        sendJson(response, 200, await agent.stopParallelProbe());
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
  PARALLEL_PROBE_PHASE,
  PHASE,
  SelfHostedVpnAgent,
  buildCompatibilityProfileId,
  buildInitialState,
  buildPublicParallelProbeState,
  buildPublicRawRelayCatalogState,
  extractTokenFromRequest,
  httpError,
  normalizeParallelProbeRequest,
  normalizeRawRelayCatalogPrepareRequest,
  normalizeConnectRequest,
  normalizeConnectionMode,
};
