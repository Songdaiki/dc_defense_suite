import {
  activateCatalogRelay,
  CONNECTION_MODE,
  DEFAULT_CONFIG,
  connectVpn,
  disconnectVpn,
  getAgentBaseUrlValidationMessage,
  getConfigValidationMessage,
  getEffectiveProfileId,
  getAgentHealth,
  getParallelProbeStatus,
  primeRawRelayCatalogNics,
  getVpnEgress,
  getVpnStatus,
  normalizeConfig as normalizeApiConfig,
  prepareRawRelayCatalog,
  startParallelProbe,
  stopParallelProbe,
} from './api.js';

const STORAGE_KEY = 'selfHostedVpnSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  READY: 'READY',
  SWITCHING: 'SWITCHING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  AGENT_UNAVAILABLE: 'AGENT_UNAVAILABLE',
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
const MIN_SYNC_INTERVAL_MS = 900;
const PRIME_CATALOG_NICS_TIMEOUT_MS = 10 * 60 * 1000;

class Scheduler {
  constructor(dependencies = {}) {
    this.connectVpn = dependencies.connectVpn || connectVpn;
    this.disconnectVpn = dependencies.disconnectVpn || disconnectVpn;
    this.prepareRawRelayCatalogRequest = dependencies.prepareRawRelayCatalog || prepareRawRelayCatalog;
    this.activateCatalogRelayRequest = dependencies.activateCatalogRelay || activateCatalogRelay;
    this.getAgentHealth = dependencies.getAgentHealth || getAgentHealth;
    this.getParallelProbeStatus = dependencies.getParallelProbeStatus || getParallelProbeStatus;
    this.getVpnStatus = dependencies.getVpnStatus || getVpnStatus;
    this.getVpnEgress = dependencies.getVpnEgress || getVpnEgress;
    this.startParallelProbeRequest = dependencies.startParallelProbe || startParallelProbe;
    this.stopParallelProbeRequest = dependencies.stopParallelProbe || stopParallelProbe;
    this.primeRawRelayCatalogNicsRequest = dependencies.primeRawRelayCatalogNics || primeRawRelayCatalogNics;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.catalogEnabled = false;
    this.healthOk = false;
    this.agentReachable = false;
    this.agentVersion = '';
    this.lastSyncAt = '';
    this.lastHealthAt = '';
    this.operationId = '';
    this.activeConnectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
    this.activeProfileId = '';
    this.activeRelayId = '';
    this.activeRelayIp = '';
    this.activeRelayFqdn = '';
    this.activeSelectedSslPort = 0;
    this.publicIpBefore = '';
    this.publicIpAfter = '';
    this.currentPublicIp = '';
    this.publicIpProvider = '';
    this.ipv4DefaultRouteChanged = false;
    this.ipv6DefaultRouteChanged = false;
    this.dnsChanged = false;
    this.activeAdapterName = '';
    this.connectedAt = '';
    this.lastErrorCode = '';
    this.lastErrorMessage = '';
    this.logs = [];
    this.rawRelayCatalog = buildDefaultRawRelayCatalogStatus();
    this.parallelProbe = buildDefaultParallelProbeStatus();

    this.config = normalizeConfig(DEFAULT_CONFIG);
    this.lastSyncCompletedAtMs = 0;
    this.syncPromise = null;
    this.actionQueue = Promise.resolve();
  }

  getStartBlockReason() {
    if (this.parallelProbe?.isRunning) {
      return '병렬 3슬롯 시험이 실행 중일 때는 단일 VPN 연결을 시작할 수 없습니다.';
    }

    if ((this.config.connectionMode || CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) === CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) {
      return getAgentBaseUrlValidationMessage(this.config?.agentBaseUrl);
    }

    return getConfigValidationMessage(this.config);
  }

  async start() {
    return this.runSerializedAction(async () => {
      if ([PHASE.PREPARING, PHASE.READY, PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(this.phase)) {
        this.log(`⚠️ 이미 연결 상태입니다. (${this.phase})`);
        await this.saveState();
        return;
      }

      const startBlockReason = this.getStartBlockReason();
      if (startBlockReason) {
        throw new Error(startBlockReason);
      }

      this.isRunning = true;
      const rawCatalogMode = (this.config.connectionMode || CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) === CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
      this.phase = rawCatalogMode ? PHASE.PREPARING : PHASE.CONNECTING;
      this.catalogEnabled = rawCatalogMode;
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
      this.operationId = '';
      this.activeConnectionMode = this.config.connectionMode || CONNECTION_MODE.PROFILE;
      this.activeProfileId = '';
      this.activeRelayId = '';
      this.activeRelayIp = '';
      this.activeRelayFqdn = '';
      this.activeSelectedSslPort = 0;
      this.publicIpBefore = '';
      this.publicIpAfter = '';
      this.currentPublicIp = '';
      this.publicIpProvider = '';
      this.ipv4DefaultRouteChanged = false;
      this.ipv6DefaultRouteChanged = false;
      this.dnsChanged = false;
      this.activeAdapterName = '';
      this.connectedAt = '';
      if (rawCatalogMode) {
        this.rawRelayCatalog = buildDefaultRawRelayCatalogStatus();
        this.rawRelayCatalog.phase = PHASE.PREPARING;
        this.rawRelayCatalog.startedAt = new Date().toISOString();
      }
      await this.saveState();

      let response;
      try {
        response = rawCatalogMode
          ? await this.prepareRawRelayCatalogRequest(this.config, {
            body: {
              limit: 200,
              logicalSlotCount: 200,
              requestedPhysicalNicCount: 200,
              connectConcurrency: 24,
              nicPrepareConcurrency: 8,
              verifyConcurrency: 1,
              experimentalMaxNicIndex: 200,
              statusPollIntervalMs: 1000,
              connectTimeoutMs: 45000,
              preferredCountries: ['KR', 'JP'],
              preferredPorts: [443, 995, 1698, 5555, 992, 1194],
            },
          })
          : await this.connectVpn(this.config);
      } catch (error) {
        if (rawCatalogMode) {
          this.catalogEnabled = false;
          this.isRunning = false;
          this.rawRelayCatalog = {
            ...normalizeRawRelayCatalogStatus(this.rawRelayCatalog),
            phase: PHASE.ERROR,
            completedAt: new Date().toISOString(),
            lastErrorCode: 'RAW_CATALOG_PREPARE_REQUEST_FAILED',
            lastErrorMessage: `raw 목록 준비 시작 실패 - ${error.message}`,
          };
        }
        await this.handleActionFailure(
          rawCatalogMode ? 'RAW_CATALOG_PREPARE_REQUEST_FAILED' : 'CONNECT_REQUEST_FAILED',
          `${rawCatalogMode ? 'raw 목록 준비 시작 실패' : '연결 시작 실패'} - ${error.message}`,
          {
            fallbackPhase: PHASE.ERROR,
            preserveRunning: false,
          },
        );
        throw error;
      }

      if (response?.accepted === false) {
        const message = String(response?.data?.message || (rawCatalogMode
          ? 'local agent가 raw 목록 준비를 거부했습니다.'
          : 'local agent가 연결 시작을 거부했습니다.'));
        if (rawCatalogMode) {
          this.catalogEnabled = false;
          this.isRunning = false;
          this.rawRelayCatalog = {
            ...normalizeRawRelayCatalogStatus(this.rawRelayCatalog),
            phase: PHASE.ERROR,
            completedAt: new Date().toISOString(),
            lastErrorCode: 'RAW_CATALOG_PREPARE_REJECTED',
            lastErrorMessage: message,
          };
        }
        await this.handleActionFailure(rawCatalogMode ? 'RAW_CATALOG_PREPARE_REJECTED' : 'CONNECT_REJECTED', message, {
          fallbackPhase: PHASE.ERROR,
          preserveRunning: false,
        });
        throw new Error(message);
      }

      this.operationId = String(response?.data?.operationId || '').trim();
      this.activeConnectionMode = String(
        response?.data?.connectionMode
        || response?.data?.mode
        || this.config.connectionMode
        || CONNECTION_MODE.PROFILE,
      ).trim() || CONNECTION_MODE.PROFILE;
      this.activeProfileId = String(response?.data?.profileId || getEffectiveProfileId(this.config) || '').trim();
      this.applyActiveRelayConfig(this.config, response?.data);
      if (rawCatalogMode) {
        this.applyRawRelayCatalogStatus(response?.data?.rawRelayCatalog || {});
        this.log('🟡 raw 릴레이 목록 준비 요청 전송');
      } else {
        this.log(buildConnectLogMessage(this.config, this.activeProfileId));
      }
      await this.saveState();
      await this.refreshStatusFromAgent({ force: true, logFailures: true });
    });
  }

  async stop(reason = '') {
    return this.runSerializedAction(async () => {
      if (!this.isRunning && ![PHASE.PREPARING, PHASE.READY, PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(this.phase)) {
        this.log('⚠️ 이미 정지 상태입니다.');
        await this.saveState();
        return;
      }

      if (this.phase === PHASE.AGENT_UNAVAILABLE && !this.agentReachable) {
        this.forceLocalStop(reason || 'ℹ️ local agent 미준비 상태라 로컬 OFF로 정리했습니다.');
        await this.saveState();
        return;
      }

      const previousPhase = this.phase;
      const previousIsRunning = this.isRunning;
      this.isRunning = true;
      this.phase = PHASE.DISCONNECTING;
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
      await this.saveState();

      try {
        const response = await this.disconnectVpn(this.config);
        if (response?.accepted === false) {
          throw new Error(String(response?.data?.message || 'local agent가 종료 요청을 거부했습니다.'));
        }
      } catch (error) {
        if (previousPhase === PHASE.AGENT_UNAVAILABLE || isAgentUnavailableActionError(error)) {
          this.forceLocalStop(reason || 'ℹ️ local agent 미응답 상태라 종료 요청 대신 로컬 OFF로 정리했습니다.');
          await this.saveState();
          return;
        }

        this.phase = previousPhase;
        this.isRunning = previousIsRunning;
        await this.handleActionFailure('DISCONNECT_REQUEST_FAILED', `연결 종료 실패 - ${error.message}`, {
          fallbackPhase: previousPhase || PHASE.ERROR,
          preserveRunning: previousIsRunning,
        });
        throw error;
      }

      this.log(reason || '🟡 연결 종료 요청 전송');
      await this.saveState();
      await this.refreshStatusFromAgent({ force: true, logFailures: true });

      if (this.phase === PHASE.AGENT_UNAVAILABLE && !this.agentReachable) {
        this.isRunning = false;
        this.catalogEnabled = false;
        this.operationId = '';
        this.activeConnectionMode = this.config.connectionMode || CONNECTION_MODE.PROFILE;
        this.activeProfileId = '';
        this.activeRelayId = '';
        this.activeRelayIp = '';
        this.activeRelayFqdn = '';
        this.activeSelectedSslPort = 0;
        this.ipv4DefaultRouteChanged = false;
        this.ipv6DefaultRouteChanged = false;
        this.dnsChanged = false;
        this.activeAdapterName = '';
        this.connectedAt = '';
        this.reconcileRawRelayCatalogState();
        this.log('ℹ️ 종료 요청 이후 agent 응답이 끊겨 정지 상태로 정리했습니다.');
        await this.saveState();
      }
    });
  }

  async startParallelProbe() {
    return this.runSerializedAction(async () => {
      if ([PHASE.PREPARING, PHASE.READY, PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(this.phase)) {
        throw new Error('raw 목록 준비 또는 단일 VPN 연결이 실행 중일 때는 병렬 3슬롯 시험을 시작할 수 없습니다.');
      }

      if (this.parallelProbe?.isRunning) {
        this.log(`⚠️ 병렬 3슬롯 시험이 이미 실행 중입니다. (${this.parallelProbe.phase || 'UNKNOWN'})`);
        await this.saveState();
        return;
      }

      const agentBaseUrlValidationMessage = getAgentBaseUrlValidationMessage(this.config?.agentBaseUrl);
      if (agentBaseUrlValidationMessage) {
        throw new Error(agentBaseUrlValidationMessage);
      }

      this.parallelProbe = {
        ...buildDefaultParallelProbeStatus(),
        isRunning: true,
        phase: 'PREPARING',
        logs: this.parallelProbe?.logs || [],
      };
      await this.saveState();

      let response;
      try {
        response = await this.startParallelProbeRequest(this.config);
      } catch (error) {
        this.parallelProbe.isRunning = false;
        this.parallelProbe.phase = 'ERROR';
        this.parallelProbe.lastErrorCode = 'PARALLEL_PROBE_START_FAILED';
        this.parallelProbe.lastErrorMessage = String(error?.message || error || '병렬 3슬롯 시험 시작 실패');
        this.log(`❌ 병렬 3슬롯 시험 시작 실패 - ${this.parallelProbe.lastErrorMessage}`);
        await this.saveState();
        throw error;
      }

      this.applyParallelProbeStatus(response?.data || {});
      this.log('🟡 병렬 3슬롯 시험 시작 요청 전송');
      await this.saveState();
      await this.refreshStatusFromAgent({ force: true, logFailures: true });
    });
  }

  async primeCatalogNics() {
    return this.runSerializedAction(async () => {
      if (this.parallelProbe?.isRunning) {
        throw new Error('병렬 3슬롯 시험이 실행 중일 때는 VPN1~200 준비를 실행할 수 없습니다.');
      }

      if (this.isRunning || [PHASE.PREPARING, PHASE.READY, PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING, PHASE.SWITCHING].includes(this.phase)) {
        throw new Error(`VPN 연결/목록 준비가 활성 상태일 때는 VPN1~200 준비를 실행할 수 없습니다. phase=${this.phase}`);
      }

      const agentBaseUrlValidationMessage = getAgentBaseUrlValidationMessage(this.config?.agentBaseUrl);
      if (agentBaseUrlValidationMessage) {
        throw new Error(agentBaseUrlValidationMessage);
      }

      const nicPrimeTimeoutMs = Math.max(
        PRIME_CATALOG_NICS_TIMEOUT_MS,
        Number.parseInt(String(this.config?.actionTimeoutMs ?? 0), 10) || 0,
      );
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
      this.phase = PHASE.PREPARING;
      this.isRunning = true;
      this.catalogEnabled = false;
      this.log(`🟡 VPN1~200 준비 시작 - 목표 200 / 타임아웃 ${nicPrimeTimeoutMs}ms / local agent 응답 대기 중`);
      await this.saveState();

      let response;
      try {
        response = await this.primeRawRelayCatalogNicsRequest(this.config, {
          timeoutMs: nicPrimeTimeoutMs,
          body: {
            requestedPhysicalNicCount: 200,
            nicPrepareConcurrency: 8,
            experimentalMaxNicIndex: 200,
          },
        });
      } catch (error) {
        await this.handleActionFailure('RAW_CATALOG_PRIME_NICS_FAILED', `VPN1~200 준비 실패 - ${error.message}`, {
          fallbackPhase: this.phase || PHASE.IDLE,
          preserveRunning: false,
        });
        throw error;
      }

      if (response?.accepted === false) {
        const message = String(response?.data?.message || 'local agent가 VPN1~200 준비를 거부했습니다.');
        await this.handleActionFailure('RAW_CATALOG_PRIME_NICS_REJECTED', message, {
          fallbackPhase: this.phase || PHASE.IDLE,
          preserveRunning: false,
        });
        throw new Error(message);
      }

      const summary = response?.data || {};
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
      this.phase = PHASE.IDLE;
      this.isRunning = false;
      this.catalogEnabled = false;
      this.log(
        `🟡 VPN1~200 준비 완료 - 목표 ${summary.requestedPhysicalNicCount ?? 0} / 기존 ${summary.existingNicCount ?? 0} / 신규 ${summary.createdNicCount ?? 0} / 총 준비 ${summary.preparedNicCount ?? 0} / 남음 ${summary.remainingMissingCount ?? 0}`,
      );
      await this.saveState();
      return summary;
    });
  }

  async activateCatalogRelay(relay = {}) {
    return this.runSerializedAction(async () => {
      const normalizedRelay = normalizeRawRelayCatalogItem(relay);

      if (this.parallelProbe?.isRunning) {
        throw new Error('병렬 3슬롯 시험이 실행 중일 때는 raw 릴레이 연결을 시작할 수 없습니다.');
      }

      if ((this.config.connectionMode || CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) !== CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) {
        throw new Error('raw 릴레이 목록 연결은 SoftEther VPNGate raw 모드에서만 사용할 수 있습니다.');
      }

      if ([PHASE.PREPARING, PHASE.CONNECTING, PHASE.DISCONNECTING, PHASE.SWITCHING].includes(this.phase)) {
        throw new Error(`현재 상태에서는 raw 릴레이 연결을 시작할 수 없습니다. phase=${this.phase}`);
      }

      if (!Array.isArray(this.rawRelayCatalog?.items) || this.rawRelayCatalog.items.length <= 0) {
        throw new Error('raw 릴레이 목록이 아직 준비되지 않았습니다. 먼저 토글 ON으로 목록을 준비하세요.');
      }

      const previousActiveSnapshot = {
        activeProfileId: this.activeProfileId,
        activeRelayId: this.activeRelayId,
        activeRelayIp: this.activeRelayIp,
        activeRelayFqdn: this.activeRelayFqdn,
        activeSelectedSslPort: this.activeSelectedSslPort,
        activeAdapterName: this.activeAdapterName,
        connectedAt: this.connectedAt,
      };

      if (normalizedRelay.slotId && this.rawRelayCatalog.activeSlotId === normalizedRelay.slotId && this.phase === PHASE.CONNECTED) {
        await this.saveState();
        return;
      }

      this.isRunning = true;
      this.catalogEnabled = true;
      this.phase = PHASE.SWITCHING;
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
      this.operationId = '';
      this.activeConnectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
      await this.saveState();

      let response;
      try {
        response = await this.activateCatalogRelayRequest(this.config, normalizedRelay);
      } catch (error) {
        this.operationId = '';
        this.phase = this.rawRelayCatalog.activeSlotId ? PHASE.CONNECTED : PHASE.READY;
        this.isRunning = true;
        this.catalogEnabled = true;
        this.activeProfileId = previousActiveSnapshot.activeProfileId;
        this.activeRelayId = previousActiveSnapshot.activeRelayId;
        this.activeRelayIp = previousActiveSnapshot.activeRelayIp;
        this.activeRelayFqdn = previousActiveSnapshot.activeRelayFqdn;
        this.activeSelectedSslPort = previousActiveSnapshot.activeSelectedSslPort;
        this.activeAdapterName = previousActiveSnapshot.activeAdapterName;
        this.connectedAt = previousActiveSnapshot.connectedAt;
        await this.handleActionFailure('RAW_CATALOG_CONNECT_REQUEST_FAILED', `raw 릴레이 연결 시작 실패 - ${error.message}`, {
          fallbackPhase: this.rawRelayCatalog.activeSlotId ? PHASE.CONNECTED : PHASE.READY,
          preserveRunning: true,
        });
        throw error;
      }

      if (response?.accepted === false) {
        const message = String(response?.data?.message || 'local agent가 raw 릴레이 연결을 거부했습니다.');
        this.operationId = '';
        this.phase = this.rawRelayCatalog.activeSlotId ? PHASE.CONNECTED : PHASE.READY;
        this.isRunning = true;
        this.catalogEnabled = true;
        this.activeProfileId = previousActiveSnapshot.activeProfileId;
        this.activeRelayId = previousActiveSnapshot.activeRelayId;
        this.activeRelayIp = previousActiveSnapshot.activeRelayIp;
        this.activeRelayFqdn = previousActiveSnapshot.activeRelayFqdn;
        this.activeSelectedSslPort = previousActiveSnapshot.activeSelectedSslPort;
        this.activeAdapterName = previousActiveSnapshot.activeAdapterName;
        this.connectedAt = previousActiveSnapshot.connectedAt;
        await this.handleActionFailure('RAW_CATALOG_CONNECT_REJECTED', message, {
          fallbackPhase: this.rawRelayCatalog.activeSlotId ? PHASE.CONNECTED : PHASE.READY,
          preserveRunning: true,
        });
        throw new Error(message);
      }

      this.operationId = String(response?.data?.operationId || '').trim();
      this.activeProfileId = String(response?.data?.profileId || this.activeProfileId || '').trim();
      this.applyActiveRelayConfig(this.config, response?.data);
      this.applyRawRelayCatalogStatus(response?.data?.rawRelayCatalog || {});
      this.log(`🟡 raw live pool owner 전환 요청 전송 - ${normalizedRelay.slotId || normalizedRelay.lookupKey || normalizedRelay.ip || normalizedRelay.fqdn}:${normalizedRelay.selectedSslPort}`);
      await this.saveState();
      await this.refreshStatusFromAgent({ force: true, logFailures: true });
    });
  }

  async stopParallelProbe() {
    return this.runSerializedAction(async () => {
      if (!this.parallelProbe?.isRunning && !isParallelProbeActivePhase(this.parallelProbe?.phase)) {
        this.parallelProbe = buildDefaultParallelProbeStatus();
        await this.saveState();
        return;
      }

      this.parallelProbe.phase = 'STOPPING';
      await this.saveState();

      try {
        await this.stopParallelProbeRequest(this.config);
      } catch (error) {
        this.parallelProbe.lastErrorCode = 'PARALLEL_PROBE_STOP_FAILED';
        this.parallelProbe.lastErrorMessage = String(error?.message || error || '병렬 3슬롯 시험 종료 실패');
        this.log(`❌ 병렬 3슬롯 시험 종료 실패 - ${this.parallelProbe.lastErrorMessage}`);
        await this.saveState();
        throw error;
      }

      this.log('🟡 병렬 3슬롯 시험 종료 요청 전송');
      await this.saveState();
      await this.refreshStatusFromAgent({ force: true, logFailures: true });
    });
  }

  async refreshStatusFromAgent(options = {}) {
    const force = options.force === true;
    if (this.syncPromise) {
      return this.syncPromise;
    }

    if (!force && (Date.now() - this.lastSyncCompletedAtMs) < MIN_SYNC_INTERVAL_MS) {
      return this.getStatus();
    }

    this.syncPromise = this.performStatusRefresh(options).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async performStatusRefresh(options = {}) {
    const logFailures = options.logFailures === true;
    const suppressUnavailableNoise = !this.isRunning
      && this.phase === PHASE.IDLE
      && logFailures !== true
      && options.force !== true;
    const nowIso = new Date().toISOString();
    const beforeSnapshot = this.buildStateSnapshot();
    const requestOptions = options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {};

    const [healthResult, statusResult, egressResult, parallelProbeResult] = await Promise.allSettled([
      this.getAgentHealth(this.config, requestOptions),
      this.getVpnStatus(this.config, requestOptions),
      this.getVpnEgress(this.config, requestOptions),
      this.getParallelProbeStatus(this.config, requestOptions),
    ]);

    this.lastSyncAt = nowIso;

    const healthData = healthResult.status === 'fulfilled' ? healthResult.value?.data || {} : null;
    const statusData = statusResult.status === 'fulfilled' ? statusResult.value?.data || {} : null;
    const egressData = egressResult.status === 'fulfilled' ? egressResult.value?.data || {} : null;
    const parallelProbeData = parallelProbeResult.status === 'fulfilled' ? parallelProbeResult.value?.data || {} : null;

    this.agentReachable = healthResult.status === 'fulfilled'
      || statusResult.status === 'fulfilled'
      || egressResult.status === 'fulfilled'
      || parallelProbeResult.status === 'fulfilled';
    this.healthOk = this.agentReachable && (
      Boolean(healthData?.ok)
      || Boolean(statusData)
      || Boolean(egressData)
      || Boolean(parallelProbeData)
    );
    this.lastHealthAt = this.agentReachable ? nowIso : this.lastHealthAt;
    this.agentVersion = String(healthData?.agentVersion || healthData?.version || this.agentVersion || '').trim();

    if (statusData) {
      this.applyAgentStatus(statusData);
    } else if (suppressUnavailableNoise) {
      this.phase = PHASE.IDLE;
      this.isRunning = false;
    } else {
      const fallbackPhase = this.agentReachable ? PHASE.ERROR : PHASE.AGENT_UNAVAILABLE;
      const keepRunning = this.catalogEnabled
        || [PHASE.PREPARING, PHASE.READY, PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING, PHASE.AGENT_UNAVAILABLE].includes(this.phase)
        || this.isRunning;
      this.phase = fallbackPhase;
      this.isRunning = keepRunning && fallbackPhase !== PHASE.IDLE;
    }

    if (egressData) {
      this.currentPublicIp = String(egressData.publicIp || egressData.ip || this.currentPublicIp || '').trim();
      this.publicIpProvider = String(egressData.provider || this.publicIpProvider || '').trim();
      if (!this.publicIpAfter && this.phase === PHASE.CONNECTED && this.currentPublicIp) {
        this.publicIpAfter = this.currentPublicIp;
      }
    }

    if (parallelProbeData) {
      this.applyParallelProbeStatus(parallelProbeData);
    } else if (!this.parallelProbe?.isRunning) {
      this.parallelProbe = buildDefaultParallelProbeStatus();
    }

    this.reconcileRawRelayCatalogState();

    if (!statusData) {
      const failureMessage = extractRefreshFailureMessage(healthResult, statusResult, egressResult, parallelProbeResult);
      if (failureMessage && !suppressUnavailableNoise) {
        this.lastErrorCode = this.agentReachable ? 'STATUS_UNAVAILABLE' : 'AGENT_UNAVAILABLE';
        this.lastErrorMessage = failureMessage;
        if (logFailures) {
          this.log(`⚠️ 상태 확인 실패 - ${failureMessage}`);
        }
      } else if (suppressUnavailableNoise) {
        this.lastErrorCode = '';
        this.lastErrorMessage = '';
      }
    } else if (!this.agentReachable) {
      this.lastErrorCode = 'AGENT_UNAVAILABLE';
      this.lastErrorMessage = 'local agent에 연결할 수 없습니다.';
    }

    const afterSnapshot = this.buildStateSnapshot();
    const changed = JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot);
    this.lastSyncCompletedAtMs = Date.now();
    if (changed) {
      await this.saveState();
    }

    return this.getStatus();
  }

  applyAgentStatus(status = {}) {
    const normalizedPhase = normalizePhase(status.phase || status.status);
    const hasExplicitCatalogEnabled = Object.prototype.hasOwnProperty.call(status, 'catalogEnabled');
    this.applyRawRelayCatalogStatus(status.rawRelayCatalog || {});
    this.phase = normalizedPhase;
    this.catalogEnabled = hasExplicitCatalogEnabled
      ? Boolean(status.catalogEnabled)
      : Boolean(
        [PHASE.PREPARING, PHASE.READY, PHASE.SWITCHING, PHASE.CONNECTED].includes(normalizedPhase)
        || this.rawRelayCatalog.items.length > 0
        || this.catalogEnabled
      );
    this.isRunning = this.catalogEnabled || [PHASE.CONNECTING, PHASE.SWITCHING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(normalizedPhase);
    this.operationId = String(status.operationId || this.operationId || '').trim();
    this.activeConnectionMode = String(
      status.connectionMode
      || status.mode
      || this.activeConnectionMode
      || this.config.connectionMode
      || CONNECTION_MODE.PROFILE,
    ).trim() || CONNECTION_MODE.PROFILE;
    this.activeProfileId = String(
      status.profileId
      || status.activeProfileId
      || this.activeProfileId
      || getEffectiveProfileId(this.config)
      || '',
    ).trim();
    this.applyActiveRelayConfig(this.config, status);
    this.publicIpBefore = String(status.publicIpBefore || this.publicIpBefore || '').trim();
    this.publicIpAfter = String(status.publicIpAfter || this.publicIpAfter || '').trim();
    if (Object.prototype.hasOwnProperty.call(status, 'ipv4DefaultRouteChanged')) {
      this.ipv4DefaultRouteChanged = Boolean(status.ipv4DefaultRouteChanged);
    } else if (normalizedPhase === PHASE.IDLE) {
      this.ipv4DefaultRouteChanged = false;
    }

    if (Object.prototype.hasOwnProperty.call(status, 'ipv6DefaultRouteChanged')) {
      this.ipv6DefaultRouteChanged = Boolean(status.ipv6DefaultRouteChanged);
    } else if (normalizedPhase === PHASE.IDLE) {
      this.ipv6DefaultRouteChanged = false;
    }

    if (Object.prototype.hasOwnProperty.call(status, 'dnsChanged')) {
      this.dnsChanged = Boolean(status.dnsChanged);
    } else if (normalizedPhase === PHASE.IDLE) {
      this.dnsChanged = false;
    }

    const nextActiveAdapterName = String(status.activeAdapterName || status.adapterName || '').trim();
    if (nextActiveAdapterName) {
      this.activeAdapterName = nextActiveAdapterName;
    } else if (normalizedPhase === PHASE.IDLE) {
      this.activeAdapterName = '';
    }

    const nextConnectedAt = String(status.connectedAt || '').trim();
    if (nextConnectedAt) {
      this.connectedAt = nextConnectedAt;
    } else if ([PHASE.IDLE, PHASE.READY, PHASE.PREPARING].includes(normalizedPhase)) {
      this.connectedAt = '';
    }

    const nextLastErrorCode = String(status.lastErrorCode || '').trim();
    const nextLastErrorMessage = String(status.lastErrorMessage || status.error || '').trim();
    if (nextLastErrorCode || nextLastErrorMessage) {
      this.lastErrorCode = nextLastErrorCode;
      this.lastErrorMessage = nextLastErrorMessage;
    }

    if (!nextLastErrorMessage && [PHASE.CONNECTED, PHASE.IDLE, PHASE.READY].includes(normalizedPhase)) {
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
    }

    if ([PHASE.IDLE, PHASE.READY, PHASE.PREPARING].includes(normalizedPhase)) {
      this.activeRelayId = '';
      this.activeRelayIp = '';
      this.activeRelayFqdn = '';
      this.activeSelectedSslPort = 0;
    }

    this.reconcileRawRelayCatalogState();
  }

  applyRawRelayCatalogStatus(status = {}) {
    const nextStatus = normalizeRawRelayCatalogStatus(status);
    const previousLogs = Array.isArray(this.rawRelayCatalog?.logs) ? this.rawRelayCatalog.logs : [];
    this.rawRelayCatalog = {
      ...nextStatus,
      logs: Array.isArray(nextStatus.logs) && nextStatus.logs.length > 0 ? nextStatus.logs : previousLogs,
    };
  }

  applyParallelProbeStatus(status = {}) {
    const nextStatus = normalizeParallelProbeStatus(status);
    const previousLogs = Array.isArray(this.parallelProbe?.logs) ? this.parallelProbe.logs : [];
    this.parallelProbe = {
      ...nextStatus,
      logs: Array.isArray(nextStatus.logs) && nextStatus.logs.length > 0 ? nextStatus.logs : previousLogs,
    };
  }

  reconcileRawRelayCatalogState() {
    if (!shouldCollapseRawRelayCatalogState({
      phase: this.phase,
      isRunning: this.isRunning,
      catalogEnabled: this.catalogEnabled,
      rawRelayCatalog: this.rawRelayCatalog,
    })) {
      return;
    }

    this.rawRelayCatalog = buildInactiveRawRelayCatalogStatus(this.rawRelayCatalog);
  }

  forceLocalStop(message = '') {
    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.catalogEnabled = false;
    this.healthOk = false;
    this.agentReachable = false;
    this.operationId = '';
    this.activeConnectionMode = this.config.connectionMode || CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
    this.activeProfileId = '';
    this.activeRelayId = '';
    this.activeRelayIp = '';
    this.activeRelayFqdn = '';
    this.activeSelectedSslPort = 0;
    this.publicIpBefore = '';
    this.publicIpAfter = '';
    this.currentPublicIp = '';
    this.publicIpProvider = '';
    this.ipv4DefaultRouteChanged = false;
    this.ipv6DefaultRouteChanged = false;
    this.dnsChanged = false;
    this.activeAdapterName = '';
    this.connectedAt = '';
    this.lastErrorCode = '';
    this.lastErrorMessage = '';
    this.reconcileRawRelayCatalogState();
    if (message) {
      this.log(message);
    }
  }

  async handleActionFailure(errorCode, message, options = {}) {
    this.lastErrorCode = String(errorCode || '').trim();
    this.lastErrorMessage = String(message || '').trim();
    this.phase = normalizePhase(options.fallbackPhase || PHASE.ERROR);
    this.isRunning = Boolean(options.preserveRunning);
    this.log(`❌ ${message}`);
    await this.saveState();
  }

  async runSerializedAction(action) {
    // popup double-click이나 연속 토글로 connect/disconnect가 겹치지 않게 직렬화한다.
    const previousAction = this.actionQueue;
    let releaseQueue = () => {};
    const nextAction = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    this.actionQueue = nextAction;

    await previousAction;

    try {
      return await action();
    } finally {
      releaseQueue();
      if (this.actionQueue === nextAction) {
        this.actionQueue = Promise.resolve();
      }
    }
  }

  buildStateSnapshot() {
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      catalogEnabled: this.catalogEnabled,
      healthOk: this.healthOk,
      agentReachable: this.agentReachable,
      agentVersion: this.agentVersion,
      lastSyncAt: this.lastSyncAt,
      lastHealthAt: this.lastHealthAt,
      operationId: this.operationId,
      activeConnectionMode: this.activeConnectionMode,
      activeProfileId: this.activeProfileId,
      activeRelayId: this.activeRelayId,
      activeRelayIp: this.activeRelayIp,
      activeRelayFqdn: this.activeRelayFqdn,
      activeSelectedSslPort: this.activeSelectedSslPort,
      publicIpBefore: this.publicIpBefore,
      publicIpAfter: this.publicIpAfter,
      currentPublicIp: this.currentPublicIp,
      publicIpProvider: this.publicIpProvider,
      ipv4DefaultRouteChanged: this.ipv4DefaultRouteChanged,
      ipv6DefaultRouteChanged: this.ipv6DefaultRouteChanged,
      dnsChanged: this.dnsChanged,
      activeAdapterName: this.activeAdapterName,
      connectedAt: this.connectedAt,
      lastErrorCode: this.lastErrorCode,
      lastErrorMessage: this.lastErrorMessage,
      rawRelayCatalog: normalizeRawRelayCatalogStatus(this.rawRelayCatalog),
      parallelProbe: normalizeParallelProbeStatus(this.parallelProbe),
    };
  }

  async saveState() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          ...this.buildStateSnapshot(),
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[SelfHostedVpnScheduler] 상태 저장 실패:', error.message);
    }
  }

  async loadState() {
    try {
      const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
      if (!schedulerState) {
        return;
      }

      this.isRunning = Boolean(schedulerState.isRunning);
      this.phase = normalizePhase(schedulerState.phase);
      this.catalogEnabled = Boolean(schedulerState.catalogEnabled);
      this.healthOk = Boolean(schedulerState.healthOk);
      this.agentReachable = Boolean(schedulerState.agentReachable);
      this.agentVersion = String(schedulerState.agentVersion || '');
      this.lastSyncAt = String(schedulerState.lastSyncAt || '');
      this.lastHealthAt = String(schedulerState.lastHealthAt || '');
      this.operationId = String(schedulerState.operationId || '');
      this.activeConnectionMode = String(schedulerState.activeConnectionMode || CONNECTION_MODE.PROFILE);
      this.activeProfileId = String(schedulerState.activeProfileId || '');
      this.activeRelayId = String(schedulerState.activeRelayId || '');
      this.activeRelayIp = String(schedulerState.activeRelayIp || '');
      this.activeRelayFqdn = String(schedulerState.activeRelayFqdn || '');
      this.activeSelectedSslPort = Number.parseInt(String(schedulerState.activeSelectedSslPort || '0'), 10) || 0;
      this.publicIpBefore = String(schedulerState.publicIpBefore || '');
      this.publicIpAfter = String(schedulerState.publicIpAfter || '');
      this.currentPublicIp = String(schedulerState.currentPublicIp || '');
      this.publicIpProvider = String(schedulerState.publicIpProvider || '');
      this.ipv4DefaultRouteChanged = Boolean(schedulerState.ipv4DefaultRouteChanged);
      this.ipv6DefaultRouteChanged = Boolean(schedulerState.ipv6DefaultRouteChanged);
      this.dnsChanged = Boolean(schedulerState.dnsChanged);
      this.activeAdapterName = String(schedulerState.activeAdapterName || '');
      this.connectedAt = String(schedulerState.connectedAt || '');
      this.lastErrorCode = String(schedulerState.lastErrorCode || '');
      this.lastErrorMessage = String(schedulerState.lastErrorMessage || '');
      this.rawRelayCatalog = normalizeRawRelayCatalogStatus(schedulerState.rawRelayCatalog || {});
      this.parallelProbe = normalizeParallelProbeStatus(schedulerState.parallelProbe || {});
      this.reconcileRawRelayCatalogState();
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...(schedulerState.config || {}),
      });
    } catch (error) {
      console.error('[SelfHostedVpnScheduler] 상태 복원 실패:', error.message);
    }
  }

  ensureRunLoop() {
    // MV3 service worker에서는 long-running poll 대신 popup/background 요청 시 agent 상태를 새로 읽는다.
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      catalogEnabled: this.catalogEnabled,
      healthOk: this.healthOk,
      agentReachable: this.agentReachable,
      agentVersion: this.agentVersion,
      lastSyncAt: this.lastSyncAt,
      lastHealthAt: this.lastHealthAt,
      operationId: this.operationId,
      activeConnectionMode: this.activeConnectionMode,
      activeProfileId: this.activeProfileId,
      activeRelayId: this.activeRelayId,
      activeRelayIp: this.activeRelayIp,
      activeRelayFqdn: this.activeRelayFqdn,
      activeSelectedSslPort: this.activeSelectedSslPort,
      publicIpBefore: this.publicIpBefore,
      publicIpAfter: this.publicIpAfter,
      currentPublicIp: this.currentPublicIp,
      publicIpProvider: this.publicIpProvider,
      ipv4DefaultRouteChanged: this.ipv4DefaultRouteChanged,
      ipv6DefaultRouteChanged: this.ipv6DefaultRouteChanged,
      dnsChanged: this.dnsChanged,
      activeAdapterName: this.activeAdapterName,
      connectedAt: this.connectedAt,
      lastErrorCode: this.lastErrorCode,
      lastErrorMessage: this.lastErrorMessage,
      rawRelayCatalog: normalizeRawRelayCatalogStatus(this.rawRelayCatalog),
      parallelProbe: normalizeParallelProbeStatus(this.parallelProbe),
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }

  log(message) {
    const timestamp = new Date().toLocaleTimeString('ko-KR', {
      hour12: false,
    });
    this.logs.unshift(`[${timestamp}] ${message}`);
    if (this.logs.length > 50) {
      this.logs = this.logs.slice(0, 50);
    }
  }

  applyActiveRelayConfig(config = {}, status = {}) {
    const resolvedConfig = normalizeConfig(config);
    const relayData = status?.relay && typeof status.relay === 'object' ? status.relay : {};
    const activeCatalogItem = this.rawRelayCatalog.items.find((item) => (
      item.slotId && item.slotId === this.rawRelayCatalog.activeSlotId
    )) || this.rawRelayCatalog.items.find(item => item.isActive) || null;
    const statusHasRelayFields = Boolean(
      relayData.id
      || relayData.ip
      || relayData.fqdn
      || relayData.selectedSslPort
      || status?.activeRelayId
      || status?.relayId
      || status?.activeRelayIp
      || status?.relayIp
      || status?.activeRelayFqdn
      || status?.relayFqdn
      || status?.activeSelectedSslPort
      || status?.selectedSslPort
      || activeCatalogItem,
    );
    const resolvedConnectionMode = String(
      status?.connectionMode
      || status?.mode
      || (statusHasRelayFields ? CONNECTION_MODE.SOFTETHER_VPNGATE_RAW : '')
      || this.activeConnectionMode
      || resolvedConfig.connectionMode
      || CONNECTION_MODE.PROFILE,
    ).trim() || CONNECTION_MODE.PROFILE;
    if (resolvedConnectionMode !== CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) {
      this.activeRelayId = '';
      this.activeRelayIp = '';
      this.activeRelayFqdn = '';
      this.activeSelectedSslPort = 0;
      return;
    }

    const nextActiveRelayId = String(
      status?.activeRelayId
      || status?.relayId
      || relayData.id
      || activeCatalogItem?.id
      || '',
    ).trim();
    const nextActiveRelayIp = String(
      status?.activeRelayIp
      || status?.relayIp
      || relayData.ip
      || activeCatalogItem?.ip
      || '',
    ).trim();
    const nextActiveRelayFqdn = String(
      status?.activeRelayFqdn
      || status?.relayFqdn
      || relayData.fqdn
      || activeCatalogItem?.fqdn
      || '',
    ).trim();
    const nextActiveSelectedSslPort = Number.parseInt(String(
      status?.activeSelectedSslPort
      || status?.selectedSslPort
      || relayData.selectedSslPort
      || activeCatalogItem?.selectedSslPort
      || 0,
    ), 10) || 0;

    this.activeRelayId = nextActiveRelayId;
    this.activeRelayIp = nextActiveRelayIp;
    this.activeRelayFqdn = nextActiveRelayFqdn;
    this.activeSelectedSslPort = nextActiveSelectedSslPort;
  }
}

function buildDefaultRawRelayCatalogStatus() {
  return {
    phase: 'IDLE',
    stage: 'IDLE',
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
    availableNicNames: [],
    preparedNicNames: [],
    slotQueue: [],
    request: {
      limit: 200,
      logicalSlotCount: 200,
      requestedPhysicalNicCount: 200,
      connectConcurrency: 24,
      nicPrepareConcurrency: 8,
      verifyConcurrency: 1,
      experimentalMaxNicIndex: 200,
      statusPollIntervalMs: 1000,
      connectTimeoutMs: 45000,
      preferredCountries: ['KR', 'JP'],
      preferredPorts: [443, 995, 1698, 5555, 992, 1194],
    },
    items: [],
    logs: [],
  };
}

function buildInactiveRawRelayCatalogStatus(currentStatus = {}) {
  const baseStatus = buildDefaultRawRelayCatalogStatus();
  const normalizedStatus = normalizeRawRelayCatalogStatus(currentStatus);
  return {
    ...baseStatus,
    request: {
      ...baseStatus.request,
      ...(normalizedStatus.request && typeof normalizedStatus.request === 'object' ? normalizedStatus.request : {}),
    },
    logs: normalizedStatus.logs,
  };
}

function shouldCollapseRawRelayCatalogState(state = {}) {
  const topLevelPhase = normalizePhase(state.phase || PHASE.IDLE);
  if (Boolean(state.catalogEnabled) || Boolean(state.isRunning)) {
    return false;
  }

  if (![PHASE.IDLE, PHASE.AGENT_UNAVAILABLE, PHASE.ERROR].includes(topLevelPhase)) {
    return false;
  }

  const catalog = normalizeRawRelayCatalogStatus(state.rawRelayCatalog || {});
  const hasCatalogError = Boolean(catalog.lastErrorCode || catalog.lastErrorMessage);
  if (topLevelPhase === PHASE.ERROR && hasCatalogError) {
    return false;
  }

  return Boolean(
    catalog.startedAt
    || catalog.completedAt
    || catalog.stage !== 'IDLE'
    || catalog.sourceHostCount > 0
    || catalog.usableRelayCount > 0
    || catalog.requestedCandidateCount > 0
    || catalog.logicalSlotCount > 0
    || catalog.requestedPhysicalNicCount > 0
    || catalog.detectedPhysicalNicCapacity > 0
    || catalog.preparedNicCount > 0
    || catalog.connectAttemptedCount > 0
    || catalog.provisionableSlotCount > 0
    || catalog.connectedSlotCount > 0
    || catalog.verifiedSlotCount > 0
    || catalog.deadSlotCount > 0
    || catalog.failedSlotCount > 0
    || catalog.capacityDeferredSlotCount > 0
    || catalog.activeSlotId
    || catalog.routeOwnerSlotId
    || catalog.lastVerifiedAt
    || catalog.lastVerifiedPublicIp
    || (Array.isArray(catalog.preparedNicNames) && catalog.preparedNicNames.length > 0)
    || (Array.isArray(catalog.items) && catalog.items.length > 0)
    || [PHASE.PREPARING, PHASE.READY, PHASE.SWITCHING, PHASE.CONNECTED].includes(catalog.phase)
  );
}

function normalizeRawRelayCatalogItem(item = {}) {
  const rawItem = item && typeof item === 'object' ? item : {};
  return {
    slotId: String(rawItem.slotId || '').trim(),
    lookupKey: String(rawItem.lookupKey || '').trim(),
    id: String(rawItem.id ?? '').trim(),
    ip: String(rawItem.ip || '').trim(),
    fqdn: String(rawItem.fqdn || '').trim(),
    hostName: String(rawItem.hostName || '').trim(),
    countryShort: String(rawItem.countryShort || '').trim().toUpperCase(),
    countryFull: String(rawItem.countryFull || '').trim(),
    selectedSslPort: Number.parseInt(String(rawItem.selectedSslPort || 0), 10) || 0,
    sslPorts: Array.isArray(rawItem.sslPorts)
      ? rawItem.sslPorts.map(port => Number.parseInt(String(port || 0), 10) || 0).filter(Boolean)
      : [],
    udpPort: Number.parseInt(String(rawItem.udpPort || 0), 10) || 0,
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

function normalizeRawRelayCatalogStatus(status = {}) {
  const baseStatus = buildDefaultRawRelayCatalogStatus();
  const rawStatus = status && typeof status === 'object' ? status : {};
  return {
    ...baseStatus,
    ...rawStatus,
    phase: normalizePhase(rawStatus.phase || baseStatus.phase),
    stage: String(rawStatus.stage || baseStatus.stage || 'IDLE').trim().toUpperCase() || 'IDLE',
    startedAt: String(rawStatus.startedAt || '').trim(),
    completedAt: String(rawStatus.completedAt || '').trim(),
    sourceHostCount: Number.parseInt(String(rawStatus.sourceHostCount || 0), 10) || 0,
    usableRelayCount: Number.parseInt(String(
      rawStatus.usableRelayCount
      || rawStatus.verifiedSlotCount
      || 0,
    ), 10) || 0,
    requestedCandidateCount: Number.parseInt(String(rawStatus.requestedCandidateCount || 0), 10) || 0,
    logicalSlotCount: Number.parseInt(String(rawStatus.logicalSlotCount || 0), 10) || 0,
    requestedPhysicalNicCount: Number.parseInt(String(rawStatus.requestedPhysicalNicCount || 0), 10) || 0,
    detectedPhysicalNicCapacity: Number.parseInt(String(
      rawStatus.detectedPhysicalNicCapacity
      || rawStatus.provisionableSlotCount
      || 0,
    ), 10) || 0,
    preparedNicCount: Number.parseInt(String(rawStatus.preparedNicCount || 0), 10) || 0,
    connectAttemptedCount: Number.parseInt(String(rawStatus.connectAttemptedCount || 0), 10) || 0,
    provisionableSlotCount: Number.parseInt(String(rawStatus.provisionableSlotCount || 0), 10) || 0,
    connectedSlotCount: Number.parseInt(String(rawStatus.connectedSlotCount || 0), 10) || 0,
    verifiedSlotCount: Number.parseInt(String(rawStatus.verifiedSlotCount || 0), 10) || 0,
    deadSlotCount: Number.parseInt(String(rawStatus.deadSlotCount || 0), 10) || 0,
    failedSlotCount: Number.parseInt(String(rawStatus.failedSlotCount || 0), 10) || 0,
    capacityDeferredSlotCount: Number.parseInt(String(rawStatus.capacityDeferredSlotCount || 0), 10) || 0,
    activeSlotId: String(rawStatus.activeSlotId || '').trim(),
    routeOwnerSlotId: String(rawStatus.routeOwnerSlotId || '').trim(),
    lastVerifiedAt: String(rawStatus.lastVerifiedAt || '').trim(),
    lastVerifiedPublicIp: String(rawStatus.lastVerifiedPublicIp || '').trim(),
    lastVerifiedPublicIpProvider: String(rawStatus.lastVerifiedPublicIpProvider || '').trim(),
    lastErrorCode: String(rawStatus.lastErrorCode || '').trim(),
    lastErrorMessage: String(rawStatus.lastErrorMessage || '').trim(),
    availableNicNames: Array.isArray(rawStatus.availableNicNames)
      ? rawStatus.availableNicNames.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [],
    preparedNicNames: Array.isArray(rawStatus.preparedNicNames)
      ? rawStatus.preparedNicNames.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [],
    slotQueue: Array.isArray(rawStatus.slotQueue)
      ? rawStatus.slotQueue.map((entry) => {
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
    request: {
      limit: Number.parseInt(String(rawStatus.request?.limit || baseStatus.request.limit), 10) || baseStatus.request.limit,
      logicalSlotCount: Number.parseInt(String(rawStatus.request?.logicalSlotCount || baseStatus.request.logicalSlotCount), 10) || baseStatus.request.logicalSlotCount,
      requestedPhysicalNicCount: Number.parseInt(String(rawStatus.request?.requestedPhysicalNicCount || baseStatus.request.requestedPhysicalNicCount), 10) || baseStatus.request.requestedPhysicalNicCount,
      connectConcurrency: Number.parseInt(String(rawStatus.request?.connectConcurrency || baseStatus.request.connectConcurrency), 10) || baseStatus.request.connectConcurrency,
      nicPrepareConcurrency: Number.parseInt(String(rawStatus.request?.nicPrepareConcurrency || baseStatus.request.nicPrepareConcurrency), 10) || baseStatus.request.nicPrepareConcurrency,
      verifyConcurrency: Number.parseInt(String(rawStatus.request?.verifyConcurrency || baseStatus.request.verifyConcurrency), 10) || baseStatus.request.verifyConcurrency,
      experimentalMaxNicIndex: Number.parseInt(String(rawStatus.request?.experimentalMaxNicIndex || baseStatus.request.experimentalMaxNicIndex), 10) || baseStatus.request.experimentalMaxNicIndex,
      statusPollIntervalMs: Number.parseInt(String(rawStatus.request?.statusPollIntervalMs || baseStatus.request.statusPollIntervalMs), 10) || baseStatus.request.statusPollIntervalMs,
      connectTimeoutMs: Number.parseInt(String(rawStatus.request?.connectTimeoutMs || baseStatus.request.connectTimeoutMs), 10) || baseStatus.request.connectTimeoutMs,
      preferredCountries: Array.isArray(rawStatus.request?.preferredCountries)
        ? rawStatus.request.preferredCountries.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
        : [...baseStatus.request.preferredCountries],
      preferredPorts: Array.isArray(rawStatus.request?.preferredPorts)
        ? rawStatus.request.preferredPorts.map(value => Number.parseInt(String(value || 0), 10) || 0).filter(Boolean)
        : [...baseStatus.request.preferredPorts],
    },
    items: Array.isArray(rawStatus.items)
      ? rawStatus.items.map((item) => normalizeRawRelayCatalogItem(item))
      : [],
    logs: Array.isArray(rawStatus.logs)
      ? rawStatus.logs.map(entry => String(entry || '').trim()).filter(Boolean).slice(0, 20)
      : [],
  };
}

function buildConnectLogMessage(config = {}, effectiveProfileId = '') {
  const resolvedConfig = normalizeConfig(config);
  if (resolvedConfig.connectionMode === CONNECTION_MODE.SOFTETHER_VPNGATE_RAW) {
    const relayHost = resolvedConfig.relaySnapshot.ip || resolvedConfig.relaySnapshot.fqdn || '미지정 릴레이';
    const relayPort = resolvedConfig.selectedSslPort || '미지정 포트';
    const compatibilityProfileId = effectiveProfileId || getEffectiveProfileId(resolvedConfig) || '미지정 profile';
    return `🟡 raw 릴레이 연결 요청 전송 - ${relayHost}:${relayPort} / profileId=${compatibilityProfileId}`;
  }

  return `🟡 연결 요청 전송 - profileId=${effectiveProfileId || resolvedConfig.profileId || '미지정 profile'}`;
}

function normalizePhase(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return PHASE.IDLE;
  }

  if (Object.values(PHASE).includes(normalized)) {
    return normalized;
  }

  if (['CONNECTED', 'RUNNING', 'ACTIVE', 'UP'].includes(normalized)) {
    return PHASE.CONNECTED;
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

  if (['CONNECTING', 'STARTING', 'PENDING'].includes(normalized)) {
    return PHASE.CONNECTING;
  }

  if (['DISCONNECTING', 'STOPPING'].includes(normalized)) {
    return PHASE.DISCONNECTING;
  }

  if (['ERROR', 'FAILED', 'FAIL'].includes(normalized)) {
    return PHASE.ERROR;
  }

  if (['UNAVAILABLE', 'OFFLINE'].includes(normalized)) {
    return PHASE.AGENT_UNAVAILABLE;
  }

  return PHASE.IDLE;
}

function isAgentUnavailableActionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return [
    'local agent 요청 실패',
    'local agent 요청 시간 초과',
    'failed to fetch',
    'fetch failed',
    'econnrefused',
    'err_connection_refused',
    'networkerror',
    'network error',
    'network request failed',
  ].some(fragment => message.includes(fragment));
}

function normalizeParallelProbePhase(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return PARALLEL_PROBE_PHASE.IDLE;
  }

  if (Object.values(PARALLEL_PROBE_PHASE).includes(normalized)) {
    return normalized;
  }

  if (['RUNNING', 'ACTIVE', 'PREPARE', 'PROVISIONING'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.PREPARING;
  }

  if (['CONNECT', 'CONNECTING_SLOTS'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.CONNECTING;
  }

  if (['VERIFY', 'VERIFYING_SLOTS'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.VERIFYING;
  }

  if (['DONE', 'FINISHED', 'COMPLETED'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.COMPLETE;
  }

  if (['STOP', 'STOPPING_SLOTS'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.STOPPING;
  }

  if (['FAIL', 'FAILED'].includes(normalized)) {
    return PARALLEL_PROBE_PHASE.ERROR;
  }

  return PARALLEL_PROBE_PHASE.IDLE;
}

function isParallelProbeActivePhase(value) {
  const normalized = normalizeParallelProbePhase(value);
  return [
    PARALLEL_PROBE_PHASE.PREPARING,
    PARALLEL_PROBE_PHASE.CONNECTING,
    PARALLEL_PROBE_PHASE.VERIFYING,
    PARALLEL_PROBE_PHASE.COMPLETE,
    PARALLEL_PROBE_PHASE.STOPPING,
  ].includes(normalized);
}

function buildDefaultParallelProbeStatus() {
  return {
    isRunning: false,
    phase: PARALLEL_PROBE_PHASE.IDLE,
    startedAt: '',
    completedAt: '',
    lastVerifiedAt: '',
    routeOwnerSlotId: '',
    lastVerifiedPublicIp: '',
    lastVerifiedPublicIpProvider: '',
    lastErrorCode: '',
    lastErrorMessage: '',
    slots: [],
    logs: [],
  };
}

function normalizeParallelProbeSlot(slot = {}, fallbackIndex = 0) {
  const rawRelay = slot.relay && typeof slot.relay === 'object' ? slot.relay : {};
  return {
    slotId: String(slot.slotId || `slot-${fallbackIndex + 1}`).trim() || `slot-${fallbackIndex + 1}`,
    nicName: String(slot.nicName || '').trim(),
    phase: String(slot.phase || slot.status || 'IDLE').trim().toUpperCase() || 'IDLE',
    accountName: String(slot.accountName || '').trim(),
    connectedAt: String(slot.connectedAt || '').trim(),
    lastVerifiedAt: String(slot.lastVerifiedAt || '').trim(),
    routeOwned: Boolean(slot.routeOwned),
    routeReady: Boolean(slot.routeReady),
    exitPublicIp: String(slot.exitPublicIp || '').trim(),
    exitPublicIpProvider: String(slot.exitPublicIpProvider || '').trim(),
    interfaceAlias: String(slot.interfaceAlias || '').trim(),
    interfaceIndex: Number.parseInt(String(slot.interfaceIndex || 0), 10) || 0,
    defaultRouteIfIndex: Number.parseInt(String(slot.defaultRouteIfIndex || 0), 10) || 0,
    lastErrorCode: String(slot.lastErrorCode || '').trim(),
    lastErrorMessage: String(slot.lastErrorMessage || '').trim(),
    underlayProtocol: String(slot.underlayProtocol || '').trim(),
    udpAccelerationActive: Boolean(slot.udpAccelerationActive),
    relay: {
      id: String(rawRelay.id ?? '').trim(),
      ip: String(rawRelay.ip || '').trim(),
      fqdn: String(rawRelay.fqdn || '').trim(),
      countryShort: String(rawRelay.countryShort || '').trim(),
      countryFull: String(rawRelay.countryFull || '').trim(),
      selectedSslPort: Number.parseInt(String(rawRelay.selectedSslPort || 0), 10) || 0,
      udpPort: Number.parseInt(String(rawRelay.udpPort || 0), 10) || 0,
      hostUniqueKey: String(rawRelay.hostUniqueKey || '').trim(),
    },
  };
}

function normalizeParallelProbeStatus(status = {}) {
  const nextStatus = {
    ...buildDefaultParallelProbeStatus(),
    ...(status && typeof status === 'object' ? status : {}),
  };
  const normalizedPhase = normalizeParallelProbePhase(nextStatus.phase);
  const normalizedSlots = Array.isArray(nextStatus.slots)
    ? nextStatus.slots.map((slot, index) => normalizeParallelProbeSlot(slot, index))
    : [];
  const normalizedLogs = Array.isArray(nextStatus.logs)
    ? nextStatus.logs
      .map(entry => String(entry || '').trim())
      .filter(Boolean)
      .slice(0, 50)
    : [];

  return {
    isRunning: Boolean(nextStatus.isRunning) || isParallelProbeActivePhase(normalizedPhase),
    phase: normalizedPhase,
    startedAt: String(nextStatus.startedAt || '').trim(),
    completedAt: String(nextStatus.completedAt || '').trim(),
    lastVerifiedAt: String(nextStatus.lastVerifiedAt || '').trim(),
    routeOwnerSlotId: String(nextStatus.routeOwnerSlotId || '').trim(),
    lastVerifiedPublicIp: String(nextStatus.lastVerifiedPublicIp || '').trim(),
    lastVerifiedPublicIpProvider: String(nextStatus.lastVerifiedPublicIpProvider || '').trim(),
    lastErrorCode: String(nextStatus.lastErrorCode || '').trim(),
    lastErrorMessage: String(nextStatus.lastErrorMessage || '').trim(),
    slots: normalizedSlots,
    logs: normalizedLogs,
  };
}

function normalizeConfig(config = {}) {
  const normalized = normalizeApiConfig(config);
  return {
    ...normalized,
    connectionMode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
    profileId: '',
  };
}

function extractRefreshFailureMessage(...results) {
  const reasons = results
    .filter(result => result.status === 'rejected')
    .map(result => String(result.reason?.message || '').trim())
    .filter(Boolean);
  return reasons[0] || '';
}

export {
  PHASE,
  Scheduler,
  normalizeConfig,
};
