import {
  DEFAULT_CONFIG,
  connectVpn,
  disconnectVpn,
  getAgentBaseUrlValidationMessage,
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
    this.activeProfileId = '';
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
    const baseUrlValidationMessage = getAgentBaseUrlValidationMessage(this.config.agentBaseUrl);
    if (baseUrlValidationMessage) {
      return baseUrlValidationMessage;
    }

    if (!this.config.agentBaseUrl) {
      return 'local agent 주소를 입력한 뒤 저장하세요.';
    }

    if (!this.config.profileId) {
      return 'profile ID를 입력한 뒤 저장하세요.';
    }

    return '';
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
      this.activeProfileId = '';
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
        response = await this.connectVpn(this.config, this.config.profileId);
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
      this.activeProfileId = String(response?.data?.profileId || this.config.profileId || '').trim();
      this.log(`🟡 연결 요청 전송 - profileId=${this.config.profileId}`);
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
        this.activeProfileId = '';
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
      if (failureMessage) {
        this.lastErrorCode = this.agentReachable ? 'STATUS_UNAVAILABLE' : 'AGENT_UNAVAILABLE';
        this.lastErrorMessage = failureMessage;
        if (logFailures) {
          this.log(`⚠️ 상태 확인 실패 - ${failureMessage}`);
        }
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
    this.activeProfileId = String(
      status.profileId
      || status.activeProfileId
      || this.activeProfileId
      || this.config.profileId
      || '',
    ).trim();
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
      activeProfileId: this.activeProfileId,
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
      this.activeProfileId = String(schedulerState.activeProfileId || '');
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
      activeProfileId: this.activeProfileId,
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
