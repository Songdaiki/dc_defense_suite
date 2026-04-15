import {
  DEFAULT_CONFIG,
  syncKcaptchaRecomCnt,
  updateRecommendCut,
} from './api.js';

const STORAGE_KEY = 'conceptRecommendCutCoordinatorState';
const HOLD_ALARM_NAME = 'conceptRecommendCutHoldExpiry';
const NORMAL_RECOMMEND_CUT = 14;
const DEFENDING_RECOMMEND_CUT = 100;
const NORMAL_KCAPTCHA_RECOM_CNT = 2;
const DEFENDING_KCAPTCHA_RECOM_CNT = 8;
const UNKNOWN_KCAPTCHA_RECOM_CNT = 0;
const AUTO_CUT_STATE = {
  NORMAL: 'NORMAL',
  DEFENDING: 'DEFENDING',
};

let initialized = false;
let initializePromise = null;
let reconcilePromise = null;

const state = {
  config: {
    galleryId: DEFAULT_CONFIG.galleryId,
    galleryType: DEFAULT_CONFIG.galleryType,
    baseUrl: DEFAULT_CONFIG.baseUrl,
  },
  conceptMonitorProducerEnabled: false,
  conceptMonitorAutoCutState: AUTO_CUT_STATE.NORMAL,
  patrolHoldUntilTs: 0,
  lastAppliedRecommendCut: NORMAL_RECOMMEND_CUT,
  lastRecommendCutApplySucceeded: true,
  lastCutChangedAt: '',
  lastAppliedKcaptchaRecomCnt: UNKNOWN_KCAPTCHA_RECOM_CNT,
  lastKcaptchaApplySucceeded: false,
  lastKcaptchaSettings: null,
};

async function initializeConceptRecommendCutCoordinator() {
  if (initialized) {
    return getConceptRecommendCutCoordinatorStatus();
  }

  if (initializePromise) {
    return initializePromise;
  }

  initializePromise = (async () => {
    try {
      const { [STORAGE_KEY]: savedState } = await chrome.storage.local.get(STORAGE_KEY);
      if (savedState) {
        state.config = normalizeConfig(savedState.config);
        state.conceptMonitorProducerEnabled = Boolean(savedState.conceptMonitorProducerEnabled);
        state.conceptMonitorAutoCutState = normalizeAutoCutState(savedState.conceptMonitorAutoCutState);
        state.patrolHoldUntilTs = Math.max(0, Number(savedState.patrolHoldUntilTs) || 0);
        state.lastAppliedRecommendCut = normalizeRecommendCut(savedState.lastAppliedRecommendCut);
        state.lastRecommendCutApplySucceeded = savedState.lastRecommendCutApplySucceeded !== false;
        state.lastCutChangedAt = savedState.lastCutChangedAt || '';
        state.lastAppliedKcaptchaRecomCnt = normalizeStoredKcaptchaRecomCnt(savedState.lastAppliedKcaptchaRecomCnt);
        state.lastKcaptchaApplySucceeded = savedState.lastKcaptchaApplySucceeded === true;
        state.lastKcaptchaSettings = normalizeStoredKcaptchaSettings(savedState.lastKcaptchaSettings);
      }

      if (state.patrolHoldUntilTs > Date.now()) {
        scheduleHoldAlarm(state.patrolHoldUntilTs);
      } else {
        state.patrolHoldUntilTs = 0;
        await clearHoldAlarm();
      }

      await saveState();
      initialized = true;
      return getConceptRecommendCutCoordinatorStatus();
    } finally {
      initializePromise = null;
    }
  })();

  return initializePromise;
}

function getConceptRecommendCutCoordinatorStatus() {
  const now = Date.now();
  const patrolHoldActive = state.patrolHoldUntilTs > now;
  const conceptMonitorDefending = state.conceptMonitorProducerEnabled
    && state.conceptMonitorAutoCutState === AUTO_CUT_STATE.DEFENDING;
  return {
    conceptMonitorProducerEnabled: state.conceptMonitorProducerEnabled,
    conceptMonitorAutoCutState: state.conceptMonitorAutoCutState,
    patrolHoldUntilTs: state.patrolHoldUntilTs,
    patrolHoldActive,
    effectiveRecommendCut: (patrolHoldActive || conceptMonitorDefending)
      ? DEFENDING_RECOMMEND_CUT
      : NORMAL_RECOMMEND_CUT,
    lastAppliedRecommendCut: state.lastAppliedRecommendCut,
    lastRecommendCutApplySucceeded: state.lastRecommendCutApplySucceeded,
    lastAppliedKcaptchaRecomCnt: state.lastAppliedKcaptchaRecomCnt,
    lastKcaptchaApplySucceeded: state.lastKcaptchaApplySucceeded,
    lastCutChangedAt: state.lastCutChangedAt,
    config: { ...state.config },
  };
}

async function syncConceptMonitorRecommendCutState(config = {}, autoCutState = {}) {
  await initializeConceptRecommendCutCoordinator();
  state.config = normalizeConfig(config);
  state.conceptMonitorProducerEnabled = Boolean(autoCutState.isRunning && autoCutState.autoCutEnabled);
  state.conceptMonitorAutoCutState = state.conceptMonitorProducerEnabled
    ? normalizeAutoCutState(autoCutState.autoCutState)
    : AUTO_CUT_STATE.NORMAL;
  await saveState();
  return reconcileRecommendCutCoordinator();
}

async function triggerConceptPatrolRecommendCutHold(config = {}, options = {}) {
  await initializeConceptRecommendCutCoordinator();
  state.config = normalizeConfig(config);
  const holdMs = Math.max(1000, Number(options.holdMs) || 0);
  const nextHoldUntilTs = Date.now() + holdMs;
  state.patrolHoldUntilTs = Math.max(state.patrolHoldUntilTs, nextHoldUntilTs);
  scheduleHoldAlarm(state.patrolHoldUntilTs);
  await saveState();
  return reconcileRecommendCutCoordinator();
}

async function resetConceptRecommendCutCoordinator(config = {}) {
  await initializeConceptRecommendCutCoordinator();
  state.config = normalizeConfig(config);
  state.conceptMonitorProducerEnabled = false;
  state.conceptMonitorAutoCutState = AUTO_CUT_STATE.NORMAL;
  state.patrolHoldUntilTs = 0;
  state.lastAppliedRecommendCut = NORMAL_RECOMMEND_CUT;
  state.lastRecommendCutApplySucceeded = false;
  state.lastCutChangedAt = '';
  state.lastAppliedKcaptchaRecomCnt = UNKNOWN_KCAPTCHA_RECOM_CNT;
  state.lastKcaptchaApplySucceeded = false;
  state.lastKcaptchaSettings = null;
  await clearHoldAlarm();
  await saveState();
  return getConceptRecommendCutCoordinatorStatus();
}

async function handleConceptRecommendCutCoordinatorAlarm(alarmName) {
  if (alarmName !== HOLD_ALARM_NAME) {
    return false;
  }

  await initializeConceptRecommendCutCoordinator();
  if (state.patrolHoldUntilTs <= 0) {
    await reconcileRecommendCutCoordinator();
    return true;
  }

  if (state.patrolHoldUntilTs > Date.now()) {
    scheduleHoldAlarm(state.patrolHoldUntilTs);
    return true;
  }

  state.patrolHoldUntilTs = 0;
  await clearHoldAlarm();
  await saveState();
  await reconcileRecommendCutCoordinator();
  return true;
}

async function reconcileRecommendCutCoordinator() {
  await initializeConceptRecommendCutCoordinator();
  const task = async () => {
    const desiredRecommendCut = getConceptRecommendCutCoordinatorStatus().effectiveRecommendCut;
    const desiredKcaptchaRecomCnt = desiredRecommendCut === DEFENDING_RECOMMEND_CUT
      ? DEFENDING_KCAPTCHA_RECOM_CNT
      : NORMAL_KCAPTCHA_RECOM_CNT;

    if (state.lastAppliedRecommendCut !== desiredRecommendCut || !state.lastRecommendCutApplySucceeded) {
      let updateResult = null;
      try {
        updateResult = await updateRecommendCut(state.config, desiredRecommendCut);
      } catch (_error) {
        state.lastRecommendCutApplySucceeded = false;
        await saveState();
        return getConceptRecommendCutCoordinatorStatus();
      }

      if (updateResult.success) {
        state.lastAppliedRecommendCut = desiredRecommendCut;
        state.lastRecommendCutApplySucceeded = true;
        state.lastCutChangedAt = new Date().toISOString();
        await saveState();
      } else {
        state.lastRecommendCutApplySucceeded = false;
        await saveState();
        return getConceptRecommendCutCoordinatorStatus();
      }
    }

    if (state.lastAppliedKcaptchaRecomCnt !== desiredKcaptchaRecomCnt || !state.lastKcaptchaApplySucceeded) {
      try {
        await applyKcaptchaRecomCnt(desiredKcaptchaRecomCnt);
      } catch (error) {
        console.error('[RecommendCutCoordinator] kcaptcha recom_cnt 변경 실패:', error.message);
        state.lastKcaptchaApplySucceeded = false;
        await saveState();
      }
    }

    return getConceptRecommendCutCoordinatorStatus();
  };

  let currentTaskPromise = null;
  if (reconcilePromise) {
    currentTaskPromise = reconcilePromise.then(task, task);
    reconcilePromise = currentTaskPromise;
  } else {
    currentTaskPromise = task();
    reconcilePromise = currentTaskPromise;
  }

  try {
    return await currentTaskPromise;
  } finally {
    if (reconcilePromise === currentTaskPromise) {
      reconcilePromise = null;
    }
  }
}

async function saveState() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      config: state.config,
      conceptMonitorProducerEnabled: state.conceptMonitorProducerEnabled,
      conceptMonitorAutoCutState: state.conceptMonitorAutoCutState,
      patrolHoldUntilTs: state.patrolHoldUntilTs,
      lastAppliedRecommendCut: state.lastAppliedRecommendCut,
      lastRecommendCutApplySucceeded: state.lastRecommendCutApplySucceeded,
      lastCutChangedAt: state.lastCutChangedAt,
      lastAppliedKcaptchaRecomCnt: state.lastAppliedKcaptchaRecomCnt,
      lastKcaptchaApplySucceeded: state.lastKcaptchaApplySucceeded,
      lastKcaptchaSettings: state.lastKcaptchaSettings,
    },
  });
}

async function applyKcaptchaRecomCnt(desiredRecomCnt) {
  const result = await syncKcaptchaRecomCnt(state.config, desiredRecomCnt);
  if (!result.success) {
    state.lastKcaptchaApplySucceeded = false;
    await saveState();
    throw new Error(`kcaptcha update 실패: ${result.rawSummary}`);
  }

  state.lastAppliedKcaptchaRecomCnt = normalizeStoredKcaptchaRecomCnt(desiredRecomCnt);
  state.lastKcaptchaApplySucceeded = true;
  state.lastKcaptchaSettings = normalizeStoredKcaptchaSettings(result.appliedSettings);
  await saveState();
}

function scheduleHoldAlarm(whenTs) {
  const normalizedWhenTs = Math.max(Date.now() + 1000, Number(whenTs) || 0);
  chrome.alarms.create(HOLD_ALARM_NAME, { when: normalizedWhenTs });
}

async function clearHoldAlarm() {
  await chrome.alarms.clear(HOLD_ALARM_NAME);
}

function normalizeConfig(config = {}) {
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
  };
}

function normalizeRecommendCut(value) {
  return Number(value) === DEFENDING_RECOMMEND_CUT
    ? DEFENDING_RECOMMEND_CUT
    : NORMAL_RECOMMEND_CUT;
}

function normalizeAutoCutState(value) {
  return value === AUTO_CUT_STATE.DEFENDING
    ? AUTO_CUT_STATE.DEFENDING
    : AUTO_CUT_STATE.NORMAL;
}

function normalizeStoredKcaptchaRecomCnt(value) {
  if (Number(value) === NORMAL_KCAPTCHA_RECOM_CNT) {
    return NORMAL_KCAPTCHA_RECOM_CNT;
  }

  return Number(value) === DEFENDING_KCAPTCHA_RECOM_CNT
    ? DEFENDING_KCAPTCHA_RECOM_CNT
    : UNKNOWN_KCAPTCHA_RECOM_CNT;
}

function normalizeStoredKcaptchaSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    return null;
  }

  const normalized = {};
  for (const [key, value] of Object.entries(settings)) {
    normalized[key] = String(value ?? '').trim();
  }

  return normalized;
}

export {
  AUTO_CUT_STATE,
  DEFENDING_RECOMMEND_CUT,
  HOLD_ALARM_NAME,
  NORMAL_RECOMMEND_CUT,
  getConceptRecommendCutCoordinatorStatus,
  handleConceptRecommendCutCoordinatorAlarm,
  initializeConceptRecommendCutCoordinator,
  reconcileRecommendCutCoordinator,
  resetConceptRecommendCutCoordinator,
  syncConceptMonitorRecommendCutState,
  triggerConceptPatrolRecommendCutHold,
};
