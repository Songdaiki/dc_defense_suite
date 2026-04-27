const STORAGE_KEY = 'dcSessionBrokerState';
const SESSION_CHECK_TAB_HASH = '#dc-defense-session-check';
const LOGIN_HEALTH_ALARM_NAME = 'dcSessionBrokerLoginHealth';
const LOGIN_CHECK_INTERVAL_MINUTES = 0.5;
const LOGIN_HEALTH_CACHE_MS = 25_000;
const LOGIN_PROMPT_TEXT = '로그인해 주세요.';

const DEFAULT_SWITCH_LOGIN_TIMEOUT_MS = 15_000;
const DEFAULT_LEASE_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_DELETE_LIMIT_LOOP_GUARD_MS = 10 * 60 * 1000;
const LOGIN_RETRY_MAX = 3;
const LOGIN_RETRY_BASE_MS = 60_000;
const LOGIN_RETRY_JITTER_MS = 20_000;
const LOGIN_COOLDOWN_MS = 10 * 60 * 1000;

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  primaryUserId: '',
  primaryPassword: '',
  backupUserId: '',
  backupPassword: '',
  keepaliveEnabled: true,
  switchLoginTimeoutMs: DEFAULT_SWITCH_LOGIN_TIMEOUT_MS,
  leaseDrainTimeoutMs: DEFAULT_LEASE_DRAIN_TIMEOUT_MS,
  deleteLimitLoopGuardMs: DEFAULT_DELETE_LIMIT_LOOP_GUARD_MS,
};

function buildDefaultLoginHealthState() {
  return {
    status: 'disabled',
    checkedAt: '',
    message: '로그인 세션 자동화가 비활성화되었습니다.',
    detail: '',
    retryCount: 0,
    nextRetryAtMs: 0,
    cooldownUntilMs: 0,
    lastAttemptAt: '',
  };
}

const brokerState = {
  config: { ...DEFAULT_CONFIG },
  activeAccountId: 'primary',
  switchInProgress: false,
  switchTargetAccountId: '',
  switchReason: '',
  sessionAutomationInProgress: false,
  sessionAutomationKind: '',
  requestGateBlocked: false,
  lastSwitchAt: '',
  lastSwitchError: '',
  lastDeleteLimitAccountId: '',
  lastDeleteLimitAtByAccount: {
    primary: '',
    backup: '',
  },
  switchWindowStartedAt: '',
  switchCountInWindow: 0,
  sessionTabId: 0,
  loginHealth: buildDefaultLoginHealthState(),
};

const runtime = {
  initialized: false,
  initPromise: null,
  pendingSwitchPromise: null,
  pendingSessionAutomationPromise: null,
  pendingSessionAutomationKind: '',
  activeLeases: new Map(),
  nextLeaseId: 1,
};

class SessionSwitchFailure extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SessionSwitchFailure';
    this.reason = String(reason || 'switch_failed');
  }
}

async function initializeDcSessionBroker() {
  if (runtime.initialized) {
    return getDcSessionBrokerStatus();
  }

  if (runtime.initPromise) {
    return runtime.initPromise;
  }

  runtime.initPromise = (async () => {
    await loadState();
    await reconcileTransientState();
    runtime.initialized = true;
    await reconcileLoginKeepalive({ reason: 'initialize', forceRefresh: true });
    return getDcSessionBrokerStatus();
  })().finally(() => {
    runtime.initPromise = null;
  });

  return runtime.initPromise;
}

async function loadState() {
  try {
    const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
    if (!stored || typeof stored !== 'object') {
      return;
    }

    const normalized = normalizeStoredState(stored);
    Object.assign(brokerState, normalized);
  } catch (error) {
    console.error('[DcSessionBroker] 상태 복원 실패:', error.message);
  }
}

async function saveState() {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY]: buildStoredState(),
    });
  } catch (error) {
    console.error('[DcSessionBroker] 상태 저장 실패:', error.message);
  }
}

async function reconcileTransientState() {
  const hadTransientState = brokerState.switchInProgress
    || brokerState.sessionAutomationInProgress
    || brokerState.requestGateBlocked;

  if (!hadTransientState) {
    return;
  }

  brokerState.switchInProgress = false;
  brokerState.switchTargetAccountId = '';
  brokerState.switchReason = '';
  brokerState.sessionAutomationInProgress = false;
  brokerState.sessionAutomationKind = '';
  brokerState.requestGateBlocked = false;
  brokerState.lastSwitchError = '서비스 워커 재시작으로 진행 중 세션 자동화 상태를 정리했습니다. 마지막 확정 계정 표시를 유지합니다.';
  await saveState();
}

function buildStoredState() {
  return {
    config: { ...brokerState.config },
    activeAccountId: brokerState.activeAccountId,
    switchInProgress: brokerState.switchInProgress,
    switchTargetAccountId: brokerState.switchTargetAccountId,
    switchReason: brokerState.switchReason,
    sessionAutomationInProgress: brokerState.sessionAutomationInProgress,
    sessionAutomationKind: brokerState.sessionAutomationKind,
    requestGateBlocked: brokerState.requestGateBlocked,
    lastSwitchAt: brokerState.lastSwitchAt,
    lastSwitchError: brokerState.lastSwitchError,
    lastDeleteLimitAccountId: brokerState.lastDeleteLimitAccountId,
    lastDeleteLimitAtByAccount: { ...brokerState.lastDeleteLimitAtByAccount },
    switchWindowStartedAt: brokerState.switchWindowStartedAt,
    switchCountInWindow: brokerState.switchCountInWindow,
    sessionTabId: brokerState.sessionTabId,
    loginHealth: { ...brokerState.loginHealth },
  };
}

function normalizeStoredState(stored) {
  const config = normalizeSessionFallbackConfig(stored?.config || {});

  return {
    config,
    activeAccountId: normalizeAccountId(stored?.activeAccountId),
    switchInProgress: Boolean(stored?.switchInProgress),
    switchTargetAccountId: normalizeAccountId(stored?.switchTargetAccountId),
    switchReason: String(stored?.switchReason || '').trim(),
    sessionAutomationInProgress: Boolean(stored?.sessionAutomationInProgress),
    sessionAutomationKind: normalizeSessionAutomationKind(stored?.sessionAutomationKind),
    requestGateBlocked: Boolean(stored?.requestGateBlocked),
    lastSwitchAt: normalizeIsoString(stored?.lastSwitchAt),
    lastSwitchError: String(stored?.lastSwitchError || '').trim(),
    lastDeleteLimitAccountId: normalizeAccountId(stored?.lastDeleteLimitAccountId),
    lastDeleteLimitAtByAccount: {
      primary: normalizeIsoString(stored?.lastDeleteLimitAtByAccount?.primary),
      backup: normalizeIsoString(stored?.lastDeleteLimitAtByAccount?.backup),
    },
    switchWindowStartedAt: normalizeIsoString(stored?.switchWindowStartedAt),
    switchCountInWindow: Math.max(0, Number(stored?.switchCountInWindow) || 0),
    sessionTabId: Math.max(0, Number(stored?.sessionTabId) || 0),
    loginHealth: normalizeLoginHealthState(stored?.loginHealth),
  };
}

function normalizeSessionFallbackConfig(config = {}) {
  return {
    galleryId: normalizeGalleryId(config.galleryId),
    primaryUserId: String(config.primaryUserId || '').trim(),
    primaryPassword: String(config.primaryPassword || ''),
    backupUserId: String(config.backupUserId || '').trim(),
    backupPassword: String(config.backupPassword || ''),
    keepaliveEnabled: config.keepaliveEnabled !== false,
    switchLoginTimeoutMs: normalizeTimeout(config.switchLoginTimeoutMs, DEFAULT_SWITCH_LOGIN_TIMEOUT_MS, 1_000, 60_000),
    leaseDrainTimeoutMs: normalizeTimeout(config.leaseDrainTimeoutMs, DEFAULT_LEASE_DRAIN_TIMEOUT_MS, 1_000, 60_000),
    deleteLimitLoopGuardMs: normalizeTimeout(config.deleteLimitLoopGuardMs, DEFAULT_DELETE_LIMIT_LOOP_GUARD_MS, 60_000, 60 * 60 * 1000),
  };
}

function normalizeLoginHealthState(state) {
  const defaults = buildDefaultLoginHealthState();
  return {
    status: normalizeLoginHealthStatus(state?.status),
    checkedAt: normalizeIsoString(state?.checkedAt),
    message: String(state?.message || defaults.message),
    detail: String(state?.detail || ''),
    retryCount: Math.max(0, Number(state?.retryCount || 0)),
    nextRetryAtMs: Math.max(0, Number(state?.nextRetryAtMs || 0)),
    cooldownUntilMs: Math.max(0, Number(state?.cooldownUntilMs || 0)),
    lastAttemptAt: normalizeIsoString(state?.lastAttemptAt),
  };
}

function normalizeLoginHealthStatus(value) {
  switch (String(value || '').trim()) {
    case 'checking':
    case 'healthy':
    case 'logged_out':
    case 'retrying':
    case 'manual_attention_required':
    case 'wrong_account_or_no_manager':
    case 'credentials_missing':
    case 'disabled':
      return String(value);
    default:
      return 'disabled';
  }
}

function normalizeTimeout(value, fallback, min, max) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(normalized)));
}

function normalizeGalleryId(value) {
  return String(value || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId;
}

function normalizeAccountId(value) {
  return value === 'backup' ? 'backup' : 'primary';
}

function normalizeSessionAutomationKind(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function normalizeIsoString(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function getAccountCredentials(accountId) {
  if (normalizeAccountId(accountId) === 'backup') {
    return {
      userId: brokerState.config.backupUserId,
      password: brokerState.config.backupPassword,
    };
  }

  return {
    userId: brokerState.config.primaryUserId,
    password: brokerState.config.primaryPassword,
  };
}

function hasAccountCredentials(config, accountId) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const userId = normalizedAccountId === 'backup'
    ? String(config.backupUserId || '').trim()
    : String(config.primaryUserId || '').trim();
  const password = normalizedAccountId === 'backup'
    ? String(config.backupPassword || '')
    : String(config.primaryPassword || '');

  return Boolean(userId && password);
}

function getAccountLabel(accountId, config = brokerState.config) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const baseLabel = normalizedAccountId === 'backup' ? '계정2' : '계정1';
  const userId = normalizedAccountId === 'backup'
    ? String(config.backupUserId || '').trim()
    : String(config.primaryUserId || '').trim();

  return userId ? `${baseLabel} (${userId})` : baseLabel;
}

function getBrokerLoginHealthSnapshot() {
  return {
    status: brokerState.loginHealth.status,
    checkedAt: brokerState.loginHealth.checkedAt,
    message: brokerState.loginHealth.message,
    detail: brokerState.loginHealth.detail,
    retryCount: brokerState.loginHealth.retryCount,
    nextRetryAt: brokerState.loginHealth.nextRetryAtMs
      ? new Date(brokerState.loginHealth.nextRetryAtMs).toISOString()
      : '',
    cooldownUntil: brokerState.loginHealth.cooldownUntilMs
      ? new Date(brokerState.loginHealth.cooldownUntilMs).toISOString()
      : '',
    lastAttemptAt: brokerState.loginHealth.lastAttemptAt,
  };
}

function getDcSessionBrokerStatus() {
  return {
    activeAccountId: brokerState.activeAccountId,
    activeAccountLabel: getAccountLabel(brokerState.activeAccountId),
    switchInProgress: brokerState.switchInProgress,
    switchTargetAccountId: brokerState.switchTargetAccountId,
    switchTargetAccountLabel: brokerState.switchTargetAccountId
      ? getAccountLabel(brokerState.switchTargetAccountId)
      : '',
    switchReason: brokerState.switchReason,
    sessionAutomationInProgress: brokerState.sessionAutomationInProgress || Boolean(runtime.pendingSessionAutomationPromise),
    sessionAutomationKind: runtime.pendingSessionAutomationKind || brokerState.sessionAutomationKind || '',
    requestGateBlocked: brokerState.requestGateBlocked,
    lastSwitchAt: brokerState.lastSwitchAt,
    lastSwitchError: brokerState.lastSwitchError,
    lastDeleteLimitAccountId: brokerState.lastDeleteLimitAccountId,
    lastDeleteLimitAccountLabel: brokerState.lastDeleteLimitAccountId
      ? getAccountLabel(brokerState.lastDeleteLimitAccountId)
      : '',
    activeLeaseCount: runtime.activeLeases.size,
    loginHealth: getBrokerLoginHealthSnapshot(),
    config: {
      primaryUserId: brokerState.config.primaryUserId,
      primaryPassword: brokerState.config.primaryPassword,
      backupUserId: brokerState.config.backupUserId,
      backupPassword: brokerState.config.backupPassword,
      keepaliveEnabled: brokerState.config.keepaliveEnabled === true,
    },
  };
}

async function updateDcSessionBrokerConfig(nextConfig = {}) {
  await initializeDcSessionBroker();
  brokerState.config = normalizeSessionFallbackConfig({
    ...brokerState.config,
    ...nextConfig,
  });
  await saveState();
  await reconcileLoginKeepalive({ reason: 'config', forceRefresh: true });
  return getDcSessionBrokerStatus();
}

async function syncDcSessionBrokerSharedConfig(nextSharedConfig = {}) {
  await initializeDcSessionBroker();
  const normalizedGalleryId = normalizeGalleryId(nextSharedConfig.galleryId);
  if (brokerState.config.galleryId === normalizedGalleryId) {
    return getDcSessionBrokerStatus();
  }

  brokerState.config.galleryId = normalizedGalleryId;
  await saveState();
  await reconcileLoginKeepalive({ reason: 'gallery_change', forceRefresh: true });
  return getDcSessionBrokerStatus();
}

async function waitUntilDcSessionReady(options = {}) {
  const signal = options.signal;
  await initializeDcSessionBroker();

  while (brokerState.switchInProgress || brokerState.requestGateBlocked) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    if (runtime.pendingSessionAutomationPromise) {
      try {
        await waitForPromiseOrAbort(runtime.pendingSessionAutomationPromise, signal);
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
        // 세션 자동화가 실패해도 gate 해제 이후 다음 요청은 계속 진행한다.
      }
      continue;
    }

    await sleep(100, signal);
  }
}

async function acquireDcRequestLease(meta = {}, options = {}) {
  await waitUntilDcSessionReady({ signal: options.signal });

  if (options.signal?.aborted) {
    throw createAbortError();
  }

  const leaseId = runtime.nextLeaseId;
  runtime.nextLeaseId += 1;
  const controller = new AbortController();

  runtime.activeLeases.set(leaseId, {
    id: leaseId,
    feature: String(meta.feature || 'unknown'),
    kind: String(meta.kind || 'request'),
    acquiredAt: Date.now(),
    controller,
  });

  return {
    id: leaseId,
    signal: controller.signal,
    release() {
      runtime.activeLeases.delete(leaseId);
    },
  };
}

async function withDcRequestLease(meta = {}, work, options = {}) {
  const lease = await acquireDcRequestLease(meta, { signal: options.signal });
  try {
    return await work(lease);
  } finally {
    lease.release();
  }
}

async function awaitSessionAutomationIdle() {
  while (runtime.pendingSessionAutomationPromise) {
    try {
      await runtime.pendingSessionAutomationPromise;
    } catch {
      // 기존 세션 자동화 실패는 무시하고 다음 자동화를 이어서 처리한다.
    }
  }
}

async function runSessionAutomationTask(kind, task) {
  brokerState.sessionAutomationInProgress = true;
  brokerState.sessionAutomationKind = normalizeSessionAutomationKind(kind);
  runtime.pendingSessionAutomationKind = brokerState.sessionAutomationKind;
  await saveState();

  const promise = (async () => {
    try {
      return await task();
    } finally {
      brokerState.sessionAutomationInProgress = false;
      brokerState.sessionAutomationKind = '';
      brokerState.requestGateBlocked = false;
      runtime.pendingSessionAutomationPromise = null;
      runtime.pendingSessionAutomationKind = '';
      await saveState();
    }
  })();

  runtime.pendingSessionAutomationPromise = promise;
  return promise;
}

async function requestDeleteLimitAccountFallback(options = {}) {
  await initializeDcSessionBroker();

  if (runtime.pendingSwitchPromise) {
    return runtime.pendingSwitchPromise;
  }

  await awaitSessionAutomationIdle();
  if (runtime.pendingSwitchPromise) {
    return runtime.pendingSwitchPromise;
  }

  runtime.pendingSwitchPromise = runSessionAutomationTask(
    'delete_limit_switch',
    () => performDeleteLimitAccountFallback(options),
  ).finally(() => {
    runtime.pendingSwitchPromise = null;
  });

  return runtime.pendingSwitchPromise;
}

async function requestManualSessionSwitch(options = {}) {
  await initializeDcSessionBroker();

  if (runtime.pendingSwitchPromise) {
    return runtime.pendingSwitchPromise;
  }

  await awaitSessionAutomationIdle();
  if (runtime.pendingSwitchPromise) {
    return runtime.pendingSwitchPromise;
  }

  runtime.pendingSwitchPromise = runSessionAutomationTask(
    'manual_switch',
    () => performManualSessionSwitch(options),
  ).finally(() => {
    runtime.pendingSwitchPromise = null;
  });

  return runtime.pendingSwitchPromise;
}

async function refreshDcSessionBrokerLoginHealth(force = false, options = {}) {
  await initializeDcSessionBroker();

  const { passive = false } = options;
  if (!brokerState.config.keepaliveEnabled && !passive) {
    setBrokerLoginHealthState({
      status: 'disabled',
      message: '로그인 세션 자동화가 비활성화되었습니다.',
      detail: '',
    });
    return getBrokerLoginHealthSnapshot();
  }

  if (runtime.pendingSessionAutomationPromise) {
    try {
      await runtime.pendingSessionAutomationPromise;
    } catch {
      // 직전 세션 자동화 실패 뒤에도 최신 health 상태를 다시 계산한다.
    }
  }

  return runSessionAutomationTask('login_health', () => performLoginHealthCheck(force, options));
}

async function performDeleteLimitAccountFallback(options = {}) {
  const nowMs = Date.now();
  const activeAccountId = normalizeAccountId(brokerState.activeAccountId);

  brokerState.lastDeleteLimitAccountId = activeAccountId;
  brokerState.lastDeleteLimitAtByAccount[activeAccountId] = new Date(nowMs).toISOString();
  await saveState();

  const decision = evaluateSwitchOpportunity({
    activeAccountId,
    config: brokerState.config,
    switchWindowStartedAt: brokerState.switchWindowStartedAt,
    switchCountInWindow: brokerState.switchCountInWindow,
    nowMs,
  });

  if (!decision.canSwitch) {
    const message = buildFallbackFailureMessage(decision.reason, decision.targetAccountId);
    brokerState.lastSwitchError = message;
    await saveState();
    return {
      success: false,
      reason: decision.reason,
      message,
      activeAccountId,
      activeAccountLabel: getAccountLabel(activeAccountId),
    };
  }

  brokerState.switchInProgress = true;
  brokerState.switchTargetAccountId = decision.targetAccountId;
  brokerState.switchReason = String(options.reason || 'delete_limit_exceeded').trim() || 'delete_limit_exceeded';
  brokerState.lastSwitchError = '';
  brokerState.requestGateBlocked = true;
  await saveState();

  try {
    const drained = await waitForLeasesToDrain(brokerState.config.leaseDrainTimeoutMs);
    if (!drained) {
      throw new SessionSwitchFailure('lease_drain_timeout', '전환 전에 기존 요청이 정리되지 않아 계정 전환을 중단했습니다.');
    }

    const switchResult = await switchSessionToAccount(decision.targetAccountId);
    if (!switchResult.success) {
      throw new SessionSwitchFailure(switchResult.reason, switchResult.message);
    }

    const nextWindow = applySuccessfulSwitchWindow({
      switchWindowStartedAt: brokerState.switchWindowStartedAt,
      switchCountInWindow: brokerState.switchCountInWindow,
      nowMs,
      guardMs: brokerState.config.deleteLimitLoopGuardMs,
    });

    brokerState.activeAccountId = decision.targetAccountId;
    brokerState.switchWindowStartedAt = nextWindow.switchWindowStartedAt;
    brokerState.switchCountInWindow = nextWindow.switchCountInWindow;
    brokerState.lastSwitchAt = new Date(nowMs).toISOString();
    brokerState.lastSwitchError = '';

    return {
      success: true,
      reason: '',
      message: `${getAccountLabel(decision.targetAccountId)}로 세션 전환 후 같은 run을 이어갑니다.`,
      activeAccountId: brokerState.activeAccountId,
      activeAccountLabel: getAccountLabel(brokerState.activeAccountId),
    };
  } catch (error) {
    const fallbackMessage = error?.message
      ? String(error.message)
      : '계정 전환 중 알 수 없는 오류가 발생했습니다.';
    brokerState.lastSwitchError = fallbackMessage;

    return {
      success: false,
      reason: String(error?.reason || 'switch_failed'),
      message: fallbackMessage,
      activeAccountId,
      activeAccountLabel: getAccountLabel(activeAccountId),
    };
  } finally {
    brokerState.switchInProgress = false;
    brokerState.switchTargetAccountId = '';
    brokerState.switchReason = '';
    await saveState();
  }
}

async function performManualSessionSwitch(options = {}) {
  const nowMs = Date.now();
  const activeAccountId = normalizeAccountId(brokerState.activeAccountId);
  const requestedTargetAccountId = String(options.targetAccountId || '').trim();
  const targetAccountId = requestedTargetAccountId
    ? normalizeAccountId(requestedTargetAccountId)
    : getAlternateAccountId(activeAccountId);

  if (!hasAccountCredentials(brokerState.config, targetAccountId)) {
    const message = `${getAccountLabel(targetAccountId)} 계정 정보를 먼저 입력하세요.`;
    brokerState.lastSwitchError = message;
    await saveState();
    return {
      success: false,
      reason: 'target_credentials_missing',
      message,
      activeAccountId,
      activeAccountLabel: getAccountLabel(activeAccountId),
    };
  }

  brokerState.switchInProgress = true;
  brokerState.switchTargetAccountId = targetAccountId;
  brokerState.switchReason = 'manual_test';
  brokerState.lastSwitchError = '';
  brokerState.requestGateBlocked = true;
  await saveState();

  try {
    const drained = await waitForLeasesToDrain(brokerState.config.leaseDrainTimeoutMs);
    if (!drained) {
      throw new SessionSwitchFailure('lease_drain_timeout', '수동 계정 전환 전에 기존 요청이 정리되지 않아 테스트를 중단했습니다.');
    }

    const switchResult = await switchSessionToAccount(targetAccountId);
    if (!switchResult.success) {
      throw new SessionSwitchFailure(switchResult.reason, switchResult.message);
    }

    brokerState.activeAccountId = targetAccountId;
    brokerState.lastSwitchAt = new Date(nowMs).toISOString();
    brokerState.lastSwitchError = '';

    return {
      success: true,
      reason: '',
      message: `${getAccountLabel(targetAccountId)}로 수동 계정 전환 테스트를 완료했습니다.`,
      activeAccountId: brokerState.activeAccountId,
      activeAccountLabel: getAccountLabel(brokerState.activeAccountId),
    };
  } catch (error) {
    const failureMessage = error?.message
      ? String(error.message)
      : '수동 계정 전환 테스트 중 알 수 없는 오류가 발생했습니다.';
    brokerState.lastSwitchError = failureMessage;

    return {
      success: false,
      reason: String(error?.reason || 'manual_switch_failed'),
      message: failureMessage,
      activeAccountId,
      activeAccountLabel: getAccountLabel(activeAccountId),
    };
  } finally {
    brokerState.switchInProgress = false;
    brokerState.switchTargetAccountId = '';
    brokerState.switchReason = '';
    await saveState();
  }
}

async function performLoginHealthCheck(force = false, options = {}) {
  const { allowAutoLogin = false, reason = 'status', passive = false } = options;
  const keepaliveEnabled = brokerState.config.keepaliveEnabled === true;

  if (!keepaliveEnabled && !passive) {
    setBrokerLoginHealthState({
      status: 'disabled',
      message: '로그인 세션 자동화가 비활성화되었습니다.',
      detail: '',
    });
    return getBrokerLoginHealthSnapshot();
  }

  const checkedAtMs = brokerState.loginHealth.checkedAt
    ? new Date(brokerState.loginHealth.checkedAt).getTime()
    : 0;
  const isCacheValid = checkedAtMs > 0 && (Date.now() - checkedAtMs) < LOGIN_HEALTH_CACHE_MS;
  if (!force && isCacheValid) {
    return getBrokerLoginHealthSnapshot();
  }

  setBrokerLoginHealthState({
    status: 'checking',
    message: '로그인 상태 확인 중입니다.',
    detail: '',
  });

  const tab = await ensureSessionCheckTab();
  await refreshSessionCheckSurface(tab.id, brokerState.config.galleryId);
  const sessionResult = await inspectSessionPage(tab.id, brokerState.config.galleryId);

  if (sessionResult.success) {
    resetBrokerLoginRetryState();
    setBrokerLoginHealthState({
      status: 'healthy',
      message: 'login 연결 정상',
      detail: sessionResult.detail,
    });
    return getBrokerLoginHealthSnapshot();
  }

  if (sessionResult.state !== 'logged_out' || !allowAutoLogin || !keepaliveEnabled) {
    setBrokerLoginHealthState({
      status: sessionResult.state === 'wrong_account_or_no_manager'
        ? 'wrong_account_or_no_manager'
        : 'manual_attention_required',
      message: mapLoginStateMessage(sessionResult.state, sessionResult.message),
      detail: sessionResult.detail,
    });
    return getBrokerLoginHealthSnapshot();
  }

  const activeAccountId = normalizeAccountId(brokerState.activeAccountId);
  if (!hasAccountCredentials(brokerState.config, activeAccountId)) {
    setBrokerLoginHealthState({
      status: 'credentials_missing',
      message: `${getAccountLabel(activeAccountId)} 로그인 정보를 먼저 입력하세요.`,
      detail: '현재 활성 계정 정보를 찾지 못했습니다.',
    });
    return getBrokerLoginHealthSnapshot();
  }

  const retryWindowResult = evaluateLoginRetryWindow(reason === 'pre_action' || reason === 'access_failure');
  if (!retryWindowResult.canAttempt) {
    setBrokerLoginHealthState({
      status: normalizeLoginHealthStatus(retryWindowResult.status),
      message: retryWindowResult.message,
      detail: retryWindowResult.detail,
    });
    return getBrokerLoginHealthSnapshot();
  }

  brokerState.loginHealth.lastAttemptAt = new Date().toISOString();
  setBrokerLoginHealthState({
    status: 'retrying',
    message: '자동 로그인 시도 중입니다.',
    detail: `현재 활성 계정 ${getAccountLabel(activeAccountId)} 기준 재로그인 시도`,
  });

  brokerState.requestGateBlocked = true;
  await saveState();
  const drained = await waitForLeasesToDrain(brokerState.config.leaseDrainTimeoutMs);
  if (!drained) {
    setBrokerLoginHealthState({
      status: 'manual_attention_required',
      message: '로그인 세션 복구 전에 기존 요청이 정리되지 않았습니다.',
      detail: 'drain timeout으로 자동 로그인 시도를 중단했습니다.',
    });
    return getBrokerLoginHealthSnapshot();
  }

  const loginResult = await loginToAccount(activeAccountId, {
    forceLogout: false,
    loginUrl: sessionResult.loginUrl,
    galleryId: brokerState.config.galleryId,
  });

  if (loginResult.success) {
    resetBrokerLoginRetryState();
    setBrokerLoginHealthState({
      status: 'healthy',
      message: 'login 연결 정상',
      detail: `현재 활성 계정 ${getAccountLabel(activeAccountId)} 자동 로그인 성공`,
    });
    return getBrokerLoginHealthSnapshot();
  }

  registerBrokerLoginRetryFailure();
  setBrokerLoginHealthState({
    status: normalizeLoginHealthStatus(loginResult.state === 'logged_out' ? 'manual_attention_required' : loginResult.state),
    message: mapLoginStateMessage(loginResult.state, loginResult.message),
    detail: loginResult.detail || formatRetryDetail(loginResult.state),
  });
  return getBrokerLoginHealthSnapshot();
}

function resetBrokerLoginRetryState() {
  brokerState.loginHealth.retryCount = 0;
  brokerState.loginHealth.nextRetryAtMs = 0;
  brokerState.loginHealth.cooldownUntilMs = 0;
  brokerState.loginHealth.lastAttemptAt = '';
}

function setBrokerLoginHealthState(nextState) {
  brokerState.loginHealth.status = normalizeLoginHealthStatus(nextState.status);
  brokerState.loginHealth.checkedAt = new Date().toISOString();
  brokerState.loginHealth.message = String(nextState.message || '');
  brokerState.loginHealth.detail = String(nextState.detail || '');
}

function evaluateLoginRetryWindow(bypassRetryWindow) {
  const now = Date.now();
  if (brokerState.loginHealth.cooldownUntilMs > now) {
    return {
      canAttempt: false,
      status: 'manual_attention_required',
      message: '자동 로그인 재시도 한도 초과',
      detail: `다음 시도 가능: ${formatTimestamp(new Date(brokerState.loginHealth.cooldownUntilMs).toISOString())}`,
    };
  }

  if (!bypassRetryWindow && brokerState.loginHealth.nextRetryAtMs > now) {
    return {
      canAttempt: false,
      status: 'retrying',
      message: '자동 로그인 재시도 대기 중입니다.',
      detail: `다음 재시도: ${formatTimestamp(new Date(brokerState.loginHealth.nextRetryAtMs).toISOString())}`,
    };
  }

  return {
    canAttempt: true,
  };
}

function registerBrokerLoginRetryFailure() {
  const jitter = getRetryJitterMs();
  brokerState.loginHealth.retryCount += 1;
  brokerState.loginHealth.nextRetryAtMs = Date.now() + LOGIN_RETRY_BASE_MS + jitter;
  if (brokerState.loginHealth.retryCount >= LOGIN_RETRY_MAX) {
    brokerState.loginHealth.cooldownUntilMs = Date.now() + LOGIN_COOLDOWN_MS;
  }
}

function getRetryJitterMs() {
  const randomOffset = Math.floor(Math.random() * ((LOGIN_RETRY_JITTER_MS * 2) + 1));
  return randomOffset - LOGIN_RETRY_JITTER_MS;
}

function formatRetryDetail(state) {
  if (state === 'manual_attention_required' && brokerState.loginHealth.cooldownUntilMs > 0) {
    return `재시도 ${LOGIN_RETRY_MAX}회 실패, 10분 cooldown 적용 중`;
  }

  if (brokerState.loginHealth.nextRetryAtMs > 0) {
    return `다음 재시도: ${formatTimestamp(new Date(brokerState.loginHealth.nextRetryAtMs).toISOString())}`;
  }

  return '';
}

function mapLoginStateMessage(state, fallbackMessage) {
  switch (state) {
    case 'healthy':
      return 'login 연결 정상';
    case 'logged_out':
      return '로그아웃 상태입니다.';
    case 'wrong_account_or_no_manager':
      return '관리자 권한 버튼을 찾지 못했습니다.';
    case 'credentials_invalid':
      return '식별 코드 또는 비밀번호를 확인해 주세요.';
    case 'retrying':
      return '자동 로그인 재시도 중입니다.';
    case 'credentials_missing':
      return fallbackMessage || '현재 활성 계정 정보를 먼저 입력하세요.';
    case 'manual_attention_required':
      return fallbackMessage || '로그인 페이지를 수동으로 확인해 주세요.';
    default:
      return fallbackMessage || 'login 연결실패';
  }
}

async function waitForLeasesToDrain(timeoutMs) {
  const startedAt = Date.now();
  const maxWaitMs = Math.max(0, Number(timeoutMs) || 0);

  while (runtime.activeLeases.size > 0) {
    if (Date.now() - startedAt >= maxWaitMs) {
      return false;
    }
    await sleep(100);
  }

  return true;
}

function evaluateSwitchOpportunity({
  activeAccountId,
  config,
  switchWindowStartedAt,
  switchCountInWindow,
  nowMs,
}) {
  const targetAccountId = getAlternateAccountId(activeAccountId);
  if (!hasAccountCredentials(config, targetAccountId)) {
    return {
      canSwitch: false,
      reason: 'target_credentials_missing',
      targetAccountId,
    };
  }

  const resetWindow = !isWithinGuardWindow(switchWindowStartedAt, nowMs, config.deleteLimitLoopGuardMs);
  const normalizedSwitchCount = resetWindow ? 0 : Math.max(0, Number(switchCountInWindow) || 0);

  if (normalizedSwitchCount >= 2) {
    return {
      canSwitch: false,
      reason: 'loop_guard_blocked',
      targetAccountId,
    };
  }

  return {
    canSwitch: true,
    reason: '',
    targetAccountId,
  };
}

function applySuccessfulSwitchWindow({
  switchWindowStartedAt,
  switchCountInWindow,
  nowMs,
  guardMs,
}) {
  if (!isWithinGuardWindow(switchWindowStartedAt, nowMs, guardMs)) {
    return {
      switchWindowStartedAt: new Date(nowMs).toISOString(),
      switchCountInWindow: 1,
    };
  }

  return {
    switchWindowStartedAt,
    switchCountInWindow: Math.max(0, Number(switchCountInWindow) || 0) + 1,
  };
}

function isWithinGuardWindow(switchWindowStartedAt, nowMs, guardMs) {
  const startedAt = normalizeIsoString(switchWindowStartedAt);
  if (!startedAt) {
    return false;
  }

  return (nowMs - new Date(startedAt).getTime()) < Math.max(0, Number(guardMs) || 0);
}

function getAlternateAccountId(activeAccountId) {
  return normalizeAccountId(activeAccountId) === 'backup'
    ? 'primary'
    : 'backup';
}

function buildFallbackFailureMessage(reason, targetAccountId) {
  switch (reason) {
    case 'target_credentials_missing':
      return `${getAccountLabel(targetAccountId)} 계정 정보를 먼저 입력하세요.`;
    case 'loop_guard_blocked':
      return '짧은 시간 안에 계정 전환이 반복되어 더 이상 전환하지 않고 차단만 유지합니다.';
    default:
      return '계정 전환을 계속할 수 없어 차단만 유지합니다.';
  }
}

async function switchSessionToAccount(accountId) {
  return loginToAccount(accountId, {
    forceLogout: true,
    galleryId: brokerState.config.galleryId,
  });
}

async function loginToAccount(accountId, options = {}) {
  const targetAccountId = normalizeAccountId(accountId);
  const targetCredentials = getAccountCredentials(targetAccountId);
  if (!String(targetCredentials.userId || '').trim() || !String(targetCredentials.password || '')) {
    return {
      success: false,
      reason: 'target_credentials_missing',
      state: 'credentials_missing',
      message: `${getAccountLabel(targetAccountId)} 계정 정보가 비어 있습니다.`,
      detail: '',
    };
  }

  const galleryId = normalizeGalleryId(options.galleryId || brokerState.config.galleryId);
  const tab = await ensureSessionCheckTab();
  const loginUrl = String(options.loginUrl || '').trim() || buildDefaultLoginUrl(galleryId);

  if (options.forceLogout) {
    await navigateTab(tab.id, buildLogoutUrl(galleryId));
  }
  await navigateTab(tab.id, loginUrl);

  const loginPageResult = await executeScriptInTab(tab.id, fillAndSubmitLoginForm, [
    targetCredentials.userId,
    targetCredentials.password,
  ]);
  if (!loginPageResult?.success) {
    return {
      success: false,
      reason: 'login_form_not_found',
      state: 'manual_attention_required',
      message: loginPageResult?.message || '로그인 폼 selector를 찾지 못했습니다.',
      detail: '',
    };
  }

  const waitResult = await waitForLoginSubmissionResult(
    tab.id,
    galleryId,
    brokerState.config.switchLoginTimeoutMs,
  );
  if (waitResult.state === 'credentials_invalid') {
    return {
      success: false,
      reason: 'credentials_invalid',
      state: 'credentials_invalid',
      message: `${getAccountLabel(targetAccountId)} 계정 아이디/비밀번호를 확인하세요.`,
      detail: 'login/member_check 응답을 받았습니다.',
    };
  }

  if (waitResult.state === 'manual_attention_required') {
    return {
      success: false,
      reason: 'login_timeout',
      state: 'manual_attention_required',
      message: waitResult.message,
      detail: '',
    };
  }

  await navigateTab(tab.id, buildSessionCheckListUrl(galleryId));
  const sessionResult = await inspectSessionPage(tab.id, galleryId);
  if (sessionResult.success) {
    return {
      success: true,
      reason: '',
      state: 'healthy',
      message: `${getAccountLabel(targetAccountId)} 로그인 및 관리자 권한 확인 완료`,
      detail: sessionResult.detail,
    };
  }

  return {
    success: false,
    reason: sessionResult.state === 'wrong_account_or_no_manager'
      ? 'wrong_account_or_no_manager'
      : 'login_verification_failed',
    state: sessionResult.state,
    message: sessionResult.message,
    detail: sessionResult.detail,
  };
}

async function reconcileLoginKeepalive({ reason = 'status', forceRefresh = false } = {}) {
  configureLoginHealthAlarm();

  if (!brokerState.config.keepaliveEnabled) {
    await closeSessionCheckTab();
    resetBrokerLoginRetryState();
    setBrokerLoginHealthState({
      status: 'disabled',
      message: '로그인 세션 자동화가 비활성화되었습니다.',
      detail: '',
    });
    await saveState();
    return getDcSessionBrokerStatus();
  }

  if (runtime.pendingSessionAutomationPromise) {
    return getDcSessionBrokerStatus();
  }

  await ensureSessionCheckTab();
  await refreshDcSessionBrokerLoginHealth(forceRefresh, {
    allowAutoLogin: true,
    reason,
  });
  return getDcSessionBrokerStatus();
}

function configureLoginHealthAlarm() {
  if (!brokerState.config.keepaliveEnabled) {
    chrome.alarms.clear(LOGIN_HEALTH_ALARM_NAME);
    return;
  }

  chrome.alarms.create(LOGIN_HEALTH_ALARM_NAME, {
    periodInMinutes: LOGIN_CHECK_INTERVAL_MINUTES,
  });
}

async function closeSessionCheckTab() {
  const tabId = Math.max(0, Number(brokerState.sessionTabId) || 0);
  if (tabId > 0) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // 이미 닫힌 탭은 무시한다.
    }
  }

  brokerState.sessionTabId = 0;
  await saveState();
}

async function handleDcSessionBrokerAlarm(alarmName) {
  if (alarmName !== LOGIN_HEALTH_ALARM_NAME) {
    return false;
  }

  await initializeDcSessionBroker();
  if (!brokerState.config.keepaliveEnabled) {
    return true;
  }

  try {
    await refreshDcSessionBrokerLoginHealth(true, {
      allowAutoLogin: true,
      reason: 'alarm',
    });
  } catch (error) {
    console.error('[DcSessionBroker] 로그인 상태 확인 실패:', error.message);
    setBrokerLoginHealthState({
      status: 'manual_attention_required',
      message: `login 상태 확인 실패: ${error.message}`,
      detail: '',
    });
    await saveState();
  }

  return true;
}

async function handleDcSessionBrokerTabRemoved(tabId) {
  await initializeDcSessionBroker();
  if (tabId !== brokerState.sessionTabId) {
    return false;
  }

  brokerState.sessionTabId = 0;
  await saveState();

  if (!brokerState.config.keepaliveEnabled || runtime.pendingSessionAutomationPromise) {
    return true;
  }

  try {
    await refreshDcSessionBrokerLoginHealth(true, {
      allowAutoLogin: true,
      reason: 'tab_removed',
    });
  } catch (error) {
    console.error('[DcSessionBroker] 세션 체크 탭 복구 실패:', error.message);
    setBrokerLoginHealthState({
      status: 'manual_attention_required',
      message: `세션 체크 탭 복구 실패: ${error.message}`,
      detail: '',
    });
    await saveState();
  }

  return true;
}

function buildSessionCheckListUrl(galleryId = brokerState.config.galleryId) {
  const normalizedGalleryId = normalizeGalleryId(galleryId);
  return `https://gall.dcinside.com/mgallery/board/lists/?id=${encodeURIComponent(normalizedGalleryId)}${SESSION_CHECK_TAB_HASH}`;
}

function buildGalleryListUrl(galleryId = brokerState.config.galleryId) {
  const normalizedGalleryId = normalizeGalleryId(galleryId);
  return `https://gall.dcinside.com/mgallery/board/lists/?id=${encodeURIComponent(normalizedGalleryId)}`;
}

function buildDefaultLoginUrl(galleryId = brokerState.config.galleryId) {
  const targetUrl = buildGalleryListUrl(galleryId);
  return `https://sign.dcinside.com/login?s_url=${encodeURIComponent(targetUrl)}`;
}

function buildLogoutUrl(galleryId = brokerState.config.galleryId) {
  const targetUrl = buildGalleryListUrl(galleryId);
  return `https://sign.dcinside.com/logout?s_url=${encodeURIComponent(targetUrl)}`;
}

async function ensureSessionCheckTab({ forceCreate = false } = {}) {
  const targetUrl = buildSessionCheckListUrl();
  const currentTabId = Math.max(0, Number(brokerState.sessionTabId) || 0);
  if (currentTabId > 0 && !forceCreate) {
    try {
      const currentTab = await chrome.tabs.get(currentTabId);
      if (currentTab?.id) {
        return currentTab;
      }
    } catch {
      brokerState.sessionTabId = 0;
    }
  }

  const existingTabs = await chrome.tabs.query({
    url: [
      'https://gall.dcinside.com/*',
      'https://sign.dcinside.com/*',
    ],
  });
  const existingTab = existingTabs.find((tab) => isSessionCheckTab(tab, targetUrl));
  if (existingTab?.id) {
    brokerState.sessionTabId = existingTab.id;
    await saveState();
    return existingTab;
  }

  const createdTab = await chrome.tabs.create({
    url: targetUrl,
    active: false,
    pinned: true,
  });
  brokerState.sessionTabId = Math.max(0, Number(createdTab?.id) || 0);
  await saveState();
  return createdTab;
}

async function waitForTabComplete(tabId, timeoutMs = brokerState.config.switchLoginTimeoutMs) {
  const existingTab = await chrome.tabs.get(tabId);
  if (existingTab.status === 'complete') {
    return existingTab;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(new Error(`탭 로딩 timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    function handleUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }

      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(tab);
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);
  });
}

async function reloadSessionCheckTab(tabId) {
  await chrome.tabs.reload(tabId, { bypassCache: true });
  return waitForTabComplete(tabId);
}

async function refreshSessionCheckSurface(tabId, galleryId) {
  const targetUrl = buildSessionCheckListUrl(galleryId);
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return navigateTab(tabId, targetUrl);
  }

  const currentUrl = String(tab?.url || '');
  if (currentUrl === targetUrl) {
    return reloadSessionCheckTab(tabId);
  }

  return navigateTab(tabId, targetUrl);
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, {
    url,
    active: false,
  });
  return waitForTabComplete(tabId);
}

async function executeScriptInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });

  return results?.[0]?.result;
}

async function inspectSessionPage(tabId, galleryId) {
  const result = await executeScriptInTab(tabId, inspectSessionPageDom, [galleryId, LOGIN_PROMPT_TEXT]);
  if (!result || typeof result !== 'object') {
    return {
      success: false,
      state: 'manual_attention_required',
      message: '세션 확인 페이지 DOM 검사에 실패했습니다.',
      detail: '',
      loginUrl: '',
    };
  }

  if (result.hasManagerButton) {
    return {
      success: true,
      state: 'healthy',
      message: 'login 연결 정상',
      detail: '특갤 관리자 권한 확인 완료',
      loginUrl: '',
    };
  }

  if (result.hasLoginPrompt) {
    return {
      success: false,
      state: 'logged_out',
      message: '로그아웃 상태입니다.',
      detail: '특갤 페이지에서 로그인 유도 요소가 확인되었습니다.',
      loginUrl: result.loginUrl || buildDefaultLoginUrl(galleryId),
    };
  }

  return {
    success: false,
    state: 'wrong_account_or_no_manager',
    message: '관리자 권한 버튼을 찾지 못했습니다.',
    detail: result.hasForeignManagerButton
      ? '다른 갤러리 관리자 버튼만 보입니다.'
      : '로그인 상태이지만 특갤 관리 권한이 없거나 다른 계정일 수 있습니다.',
    loginUrl: '',
  };
}

async function waitForLoginSubmissionResult(tabId, galleryId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(500);

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return {
        state: 'manual_attention_required',
        message: '세션 전환 탭을 찾지 못했습니다.',
      };
    }

    const currentUrl = String(tab.url || '');
    if (currentUrl.includes('/login/member_check')) {
      return {
        state: 'credentials_invalid',
      };
    }

    if (currentUrl.startsWith(buildGalleryListUrl(galleryId))) {
      return {
        state: 'redirected',
      };
    }
  }

  return {
    state: 'manual_attention_required',
    message: '로그인 제출 결과를 제시간에 확인하지 못했습니다.',
  };
}

function isSessionCheckTab(tab, targetUrl) {
  const tabId = Math.max(0, Number(tab?.id) || 0);
  if (!tabId) {
    return false;
  }

  const currentUrl = String(tab?.url || '');
  if (!currentUrl) {
    return false;
  }

  if (currentUrl === targetUrl) {
    return true;
  }

  return currentUrl.includes(SESSION_CHECK_TAB_HASH)
    && (
      currentUrl.startsWith(buildGalleryListUrl())
      || currentUrl.startsWith(buildDefaultLoginUrl())
      || currentUrl.startsWith('https://sign.dcinside.com/login/')
      || currentUrl.startsWith(buildLogoutUrl())
      || currentUrl.startsWith('https://sign.dcinside.com/logout/')
    );
}

function inspectSessionPageDom(galleryId, loginPromptText) {
  const normalizedGalleryId = String(galleryId || '').trim();
  const expectedAdminButtonSelector = `button.btn_useradmin_go[onclick*="/mgallery/management?id=${normalizedGalleryId}"]`;
  const adminButton = document.querySelector(expectedAdminButtonSelector)
    || document.querySelector(`button.btn_useradmin_go[onclick*="id=${normalizedGalleryId}"]`);
  const anyAdminButton = document.querySelector('button.btn_useradmin_go');
  const loginPrompt = [...document.querySelectorAll('strong[onclick]')].find((element) => {
    const text = String(element.textContent || '').trim();
    const onclick = String(element.getAttribute('onclick') || '');
    return text.includes(loginPromptText) && onclick.includes('sign.dcinside.com/login');
  });

  let loginUrl = '';
  if (loginPrompt) {
    const onclick = String(loginPrompt.getAttribute('onclick') || '');
    const match = onclick.match(/location\s*=\s*['"]([^'"]+)['"]/i);
    if (match) {
      loginUrl = match[1];
    }
  }

  return {
    currentUrl: location.href,
    hasManagerButton: Boolean(adminButton),
    hasForeignManagerButton: Boolean(anyAdminButton) && !adminButton,
    hasLoginPrompt: Boolean(loginPrompt),
    loginUrl,
  };
}

function fillAndSubmitLoginForm(userId, password) {
  const idInput = document.querySelector('#id') || document.querySelector('input[name="user_id"]');
  const passwordInput = document.querySelector('#pw') || document.querySelector('input[name="pw"]');
  const submitButton = document.querySelector('button[type="submit"]')
    || document.querySelector('button.btn_blue.small.btn_wfull');

  if (!idInput || !passwordInput || !submitButton) {
    return {
      success: false,
      message: '로그인 페이지 selector를 찾지 못했습니다. 2차 인증/캡차/페이지 변경 가능성이 있습니다.',
    };
  }

  idInput.value = String(userId || '');
  idInput.dispatchEvent(new Event('input', { bubbles: true }));
  idInput.dispatchEvent(new Event('change', { bubbles: true }));

  passwordInput.value = String(password || '');
  passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
  passwordInput.dispatchEvent(new Event('change', { bubbles: true }));

  submitButton.click();
  return { success: true };
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }

  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function waitForPromiseOrAbort(promise, signal) {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise)
      .then((value) => {
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

function createAbortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }
}

const __test = {
  DEFAULT_CONFIG,
  buildDefaultLoginHealthState,
  normalizeSessionFallbackConfig,
  normalizeStoredState,
  evaluateSwitchOpportunity,
  applySuccessfulSwitchWindow,
  getAlternateAccountId,
  buildFallbackFailureMessage,
  getAccountLabel,
  isWithinGuardWindow,
  mapLoginStateMessage,
};

export {
  LOGIN_HEALTH_ALARM_NAME,
  __test,
  acquireDcRequestLease,
  getDcSessionBrokerStatus,
  handleDcSessionBrokerAlarm,
  handleDcSessionBrokerTabRemoved,
  initializeDcSessionBroker,
  refreshDcSessionBrokerLoginHealth,
  requestDeleteLimitAccountFallback,
  requestManualSessionSwitch,
  syncDcSessionBrokerSharedConfig,
  updateDcSessionBrokerConfig,
  waitUntilDcSessionReady,
  withDcRequestLease,
};
