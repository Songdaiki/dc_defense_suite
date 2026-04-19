import {
  CONNECTION_MODE,
  DEFAULT_CONFIG,
  connectVpn,
  disconnectVpn,
  getConfigValidationMessage,
  getEffectiveProfileId,
  getAgentHealth,
  getVpnEgress,
  getVpnStatus,
  normalizeConfig,
} from './api.js';

const STORAGE_KEY = 'selfHostedVpnSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  AGENT_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  ERROR: 'ERROR',
};
const MIN_SYNC_INTERVAL_MS = 900;

class Scheduler {
  constructor(dependencies = {}) {
    this.connectVpn = dependencies.connectVpn || connectVpn;
    this.disconnectVpn = dependencies.disconnectVpn || disconnectVpn;
    this.getAgentHealth = dependencies.getAgentHealth || getAgentHealth;
    this.getVpnStatus = dependencies.getVpnStatus || getVpnStatus;
    this.getVpnEgress = dependencies.getVpnEgress || getVpnEgress;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.healthOk = false;
    this.agentReachable = false;
    this.agentVersion = '';
    this.lastSyncAt = '';
    this.lastHealthAt = '';
    this.operationId = '';
    this.activeConnectionMode = CONNECTION_MODE.PROFILE;
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

    this.config = normalizeConfig(DEFAULT_CONFIG);
    this.lastSyncCompletedAtMs = 0;
    this.syncPromise = null;
    this.actionQueue = Promise.resolve();
  }

  getStartBlockReason() {
    return getConfigValidationMessage(this.config);
  }

  async start() {
    return this.runSerializedAction(async () => {
      if ([PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(this.phase)) {
        this.log(`⚠️ 이미 연결 상태입니다. (${this.phase})`);
        await this.saveState();
        return;
      }

      const startBlockReason = this.getStartBlockReason();
      if (startBlockReason) {
        throw new Error(startBlockReason);
      }

      this.isRunning = true;
      this.phase = PHASE.CONNECTING;
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
      await this.saveState();

      let response;
      try {
        response = await this.connectVpn(this.config);
      } catch (error) {
        await this.handleActionFailure('CONNECT_REQUEST_FAILED', `연결 시작 실패 - ${error.message}`, {
          fallbackPhase: PHASE.ERROR,
          preserveRunning: false,
        });
        throw error;
      }

      if (response?.accepted === false) {
        const message = String(response?.data?.message || 'local agent가 연결 시작을 거부했습니다.');
        await this.handleActionFailure('CONNECT_REJECTED', message, {
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
      this.log(buildConnectLogMessage(this.config, this.activeProfileId));
      await this.saveState();
      await this.refreshStatusFromAgent({ force: true, logFailures: true });
    });
  }

  async stop(reason = '') {
    return this.runSerializedAction(async () => {
      if (!this.isRunning && ![PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(this.phase)) {
        this.log('⚠️ 이미 정지 상태입니다.');
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
        this.log('ℹ️ 종료 요청 이후 agent 응답이 끊겨 정지 상태로 정리했습니다.');
        await this.saveState();
      }
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

    const [healthResult, statusResult, egressResult] = await Promise.allSettled([
      this.getAgentHealth(this.config, requestOptions),
      this.getVpnStatus(this.config, requestOptions),
      this.getVpnEgress(this.config, requestOptions),
    ]);

    this.lastSyncAt = nowIso;

    const healthData = healthResult.status === 'fulfilled' ? healthResult.value?.data || {} : null;
    const statusData = statusResult.status === 'fulfilled' ? statusResult.value?.data || {} : null;
    const egressData = egressResult.status === 'fulfilled' ? egressResult.value?.data || {} : null;

    this.agentReachable = healthResult.status === 'fulfilled'
      || statusResult.status === 'fulfilled'
      || egressResult.status === 'fulfilled';
    this.healthOk = Boolean(healthData?.ok);
    this.lastHealthAt = healthResult.status === 'fulfilled' ? nowIso : this.lastHealthAt;
    this.agentVersion = String(healthData?.agentVersion || healthData?.version || this.agentVersion || '').trim();

    if (statusData) {
      this.applyAgentStatus(statusData);
    } else if (suppressUnavailableNoise) {
      this.phase = PHASE.IDLE;
      this.isRunning = false;
    } else {
      const fallbackPhase = this.agentReachable ? PHASE.ERROR : PHASE.AGENT_UNAVAILABLE;
      const keepRunning = [PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING, PHASE.AGENT_UNAVAILABLE].includes(this.phase)
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

    if (!statusData) {
      const failureMessage = extractRefreshFailureMessage(healthResult, statusResult, egressResult);
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
    this.phase = normalizedPhase;
    this.isRunning = [PHASE.CONNECTING, PHASE.CONNECTED, PHASE.DISCONNECTING].includes(normalizedPhase);
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
    } else if (normalizedPhase === PHASE.IDLE) {
      this.connectedAt = '';
    }

    const nextLastErrorCode = String(status.lastErrorCode || '').trim();
    const nextLastErrorMessage = String(status.lastErrorMessage || status.error || '').trim();
    if (nextLastErrorCode || nextLastErrorMessage) {
      this.lastErrorCode = nextLastErrorCode;
      this.lastErrorMessage = nextLastErrorMessage;
    }

    if (!nextLastErrorMessage && [PHASE.CONNECTED, PHASE.IDLE].includes(normalizedPhase)) {
      this.lastErrorCode = '';
      this.lastErrorMessage = '';
    }

    if (normalizedPhase === PHASE.IDLE) {
      this.activeRelayId = '';
      this.activeRelayIp = '';
      this.activeRelayFqdn = '';
      this.activeSelectedSslPort = 0;
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
      || status?.selectedSslPort,
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
      || resolvedConfig.selectedRelayId
      || resolvedConfig.relaySnapshot.id
      || '',
    ).trim();
    const nextActiveRelayIp = String(
      status?.activeRelayIp
      || status?.relayIp
      || relayData.ip
      || resolvedConfig.relaySnapshot.ip
      || '',
    ).trim();
    const nextActiveRelayFqdn = String(
      status?.activeRelayFqdn
      || status?.relayFqdn
      || relayData.fqdn
      || resolvedConfig.relaySnapshot.fqdn
      || '',
    ).trim();
    const nextActiveSelectedSslPort = Number.parseInt(String(
      status?.activeSelectedSslPort
      || status?.selectedSslPort
      || relayData.selectedSslPort
      || resolvedConfig.selectedSslPort
      || 0,
    ), 10) || 0;

    this.activeRelayId = nextActiveRelayId;
    this.activeRelayIp = nextActiveRelayIp;
    this.activeRelayFqdn = nextActiveRelayFqdn;
    this.activeSelectedSslPort = nextActiveSelectedSslPort;
  }
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

function extractRefreshFailureMessage(healthResult, statusResult, egressResult) {
  const reasons = [healthResult, statusResult, egressResult]
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
