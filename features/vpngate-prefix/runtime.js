import { decodeVpnGateDatBuffer } from './dat-decode.js';
import {
  buildNormalizedPrefixSet,
  filterCommentsByVpnGatePrefixes,
  filterPostsByVpnGatePrefixes,
  normalizeVpnGatePrefix,
  sortUniqueStrings,
} from './prefix-normalization.js';

const STORAGE_KEY = 'vpngatePrefixRuntimeState';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DAT_BASE_URL = 'http://xd.x1.client.api.vpngate2.jp/api/';
const REQUEST_HEADERS = {
  'Accept': '*/*',
};

let runtimeStateCache = null;
let runtimeStateLock = Promise.resolve();

function createEmptyRuntimeState() {
  return {
    liveSnapshotPrefixes: [],
    overlayPrefixes: [],
    effectivePrefixes: [],
    lastAttemptAt: '',
    lastRefreshAt: '',
    lastSuccessfulDatSource: '',
    meta: {
      hostCount: 0,
      uniqueIpCount: 0,
      overlayPrefixCount: 0,
    },
    activeConsumers: [],
  };
}

function cloneRuntimeState(state) {
  const normalizedState = sanitizeRuntimeState(state);
  return {
    ...normalizedState,
    liveSnapshotPrefixes: [...normalizedState.liveSnapshotPrefixes],
    overlayPrefixes: [...normalizedState.overlayPrefixes],
    effectivePrefixes: [...normalizedState.effectivePrefixes],
    activeConsumers: [...normalizedState.activeConsumers],
    meta: { ...normalizedState.meta },
  };
}

function sanitizeRuntimeState(state) {
  const baseState = createEmptyRuntimeState();
  const rawState = state && typeof state === 'object' ? state : {};
  const liveSnapshotPrefixes = sortUniqueStrings(rawState.liveSnapshotPrefixes);
  const overlayPrefixes = sortUniqueStrings([
    ...(Array.isArray(rawState.overlayPrefixes) ? rawState.overlayPrefixes : []),
    ...(Array.isArray(rawState.krOverlayPrefixes) ? rawState.krOverlayPrefixes : []),
  ]);
  const effectivePrefixes = sortUniqueStrings([
    ...liveSnapshotPrefixes,
    ...overlayPrefixes,
  ]);

  return {
    ...baseState,
    liveSnapshotPrefixes,
    overlayPrefixes,
    effectivePrefixes,
    lastAttemptAt: String(rawState.lastAttemptAt || '').trim(),
    lastRefreshAt: String(rawState.lastRefreshAt || '').trim(),
    lastSuccessfulDatSource: String(rawState.lastSuccessfulDatSource || '').trim(),
    meta: {
      hostCount: Math.max(0, Number(rawState?.meta?.hostCount) || 0),
      uniqueIpCount: Math.max(0, Number(rawState?.meta?.uniqueIpCount) || 0),
      overlayPrefixCount: overlayPrefixes.length,
    },
    activeConsumers: sortUniqueStrings(rawState.activeConsumers),
  };
}

function normalizeConsumerId(value) {
  return String(value || '').trim();
}

function hasUsablePrefixes(state) {
  return Array.isArray(state?.effectivePrefixes) && state.effectivePrefixes.length > 0;
}

function buildDatUrl(sessionId = '') {
  return `${DAT_BASE_URL}?session_id=${sessionId || buildRandomSessionId()}`;
}

function buildRandomSessionId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return BigInt(`0x${hex}`).toString(10);
}

function getTimestampMs(value) {
  const timestampMs = Date.parse(String(value || ''));
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function shouldRefreshRuntimeState(state, forceRefresh = false, now = Date.now()) {
  if (forceRefresh) {
    return true;
  }

  const lastAttemptMs = getTimestampMs(state.lastAttemptAt || state.lastRefreshAt);
  if (!lastAttemptMs) {
    return true;
  }

  return (now - lastAttemptMs) >= REFRESH_INTERVAL_MS;
}

async function withRuntimeStateLock(task) {
  const run = runtimeStateLock.then(task, task);
  runtimeStateLock = run.catch(() => {});
  return run;
}

async function loadRuntimeState() {
  if (runtimeStateCache) {
    return cloneRuntimeState(runtimeStateCache);
  }

  const { [STORAGE_KEY]: storedState } = await chrome.storage.local.get(STORAGE_KEY);
  runtimeStateCache = sanitizeRuntimeState(storedState);
  return cloneRuntimeState(runtimeStateCache);
}

async function saveRuntimeState(state) {
  const normalizedState = sanitizeRuntimeState(state);
  runtimeStateCache = normalizedState;
  await chrome.storage.local.set({
    [STORAGE_KEY]: normalizedState,
  });
  return cloneRuntimeState(normalizedState);
}

async function clearRuntimeState() {
  runtimeStateCache = createEmptyRuntimeState();
  await chrome.storage.local.remove(STORAGE_KEY);
  return cloneRuntimeState(runtimeStateCache);
}

function addConsumer(state, consumerId) {
  const normalizedConsumerId = normalizeConsumerId(consumerId);
  if (!normalizedConsumerId) {
    return {
      state,
      changed: false,
    };
  }

  const consumerSet = new Set(state.activeConsumers);
  const changed = !consumerSet.has(normalizedConsumerId);
  consumerSet.add(normalizedConsumerId);

  return {
    state: {
      ...state,
      activeConsumers: sortUniqueStrings([...consumerSet]),
    },
    changed,
  };
}

function removeConsumer(state, consumerId) {
  const normalizedConsumerId = normalizeConsumerId(consumerId);
  if (!normalizedConsumerId) {
    return {
      state,
      changed: false,
    };
  }

  const consumerSet = new Set(state.activeConsumers);
  const changed = consumerSet.delete(normalizedConsumerId);

  return {
    state: {
      ...state,
      activeConsumers: sortUniqueStrings([...consumerSet]),
    },
    changed,
  };
}

async function fetchDatBytes(datUrl) {
  const response = await fetch(datUrl, {
    method: 'GET',
    headers: REQUEST_HEADERS,
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`DAT 응답 실패 (${response.status})`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function buildRuntimeStateFromHosts(hosts, state, datUrl, nowIso) {
  const livePrefixSet = new Set();
  const uniqueIpSet = new Set();
  const overlaySet = new Set(state.overlayPrefixes);

  for (const host of Array.isArray(hosts) ? hosts : []) {
    const ip = String(host?.IP || '').trim();
    if (!ip) {
      continue;
    }

    uniqueIpSet.add(ip);
    const prefix = normalizeVpnGatePrefix(ip);
    if (prefix) {
      livePrefixSet.add(prefix);
      overlaySet.add(prefix);
    }
  }

  const liveSnapshotPrefixes = sortUniqueStrings([...livePrefixSet]);
  const overlayPrefixes = sortUniqueStrings([...overlaySet]);

  return {
    ...state,
    liveSnapshotPrefixes,
    overlayPrefixes,
    effectivePrefixes: sortUniqueStrings([
      ...liveSnapshotPrefixes,
      ...overlayPrefixes,
    ]),
    lastAttemptAt: nowIso,
    lastRefreshAt: nowIso,
    lastSuccessfulDatSource: datUrl,
    meta: {
      hostCount: Math.max(0, Number(Array.isArray(hosts) ? hosts.length : 0)),
      uniqueIpCount: uniqueIpSet.size,
      overlayPrefixCount: overlayPrefixes.length,
    },
  };
}

async function refreshRuntimeState(state, { logger } = {}) {
  const datUrl = buildDatUrl();
  const nowIso = new Date().toISOString();
  const pendingState = {
    ...state,
    lastAttemptAt: nowIso,
  };

  try {
    const datBytes = await fetchDatBytes(datUrl);
    const decoded = await decodeVpnGateDatBuffer(datBytes);
    const hosts = Array.isArray(decoded?.feed?.hosts) ? decoded.feed.hosts : [];
    if (hosts.length <= 0) {
      throw new Error('VPNGate host 목록이 비어 있습니다.');
    }

    const refreshedState = buildRuntimeStateFromHosts(hosts, pendingState, datUrl, nowIso);
    logger?.(
      `🛰️ VPNGate prefix refresh 완료 - live ${refreshedState.liveSnapshotPrefixes.length}개 / `
      + `overlay ${refreshedState.overlayPrefixes.length}개 / `
      + `effective ${refreshedState.effectivePrefixes.length}개`,
    );

    return {
      state: refreshedState,
      refreshed: true,
      usedStaleCache: false,
      fallbackToDefault: false,
      errorMessage: '',
    };
  } catch (error) {
    if (hasUsablePrefixes(pendingState)) {
      logger?.(`⚠️ VPNGate prefix refresh 실패 - 직전 캐시로 계속 진행 (${error.message})`);
      return {
        state: pendingState,
        refreshed: false,
        usedStaleCache: true,
        fallbackToDefault: false,
        errorMessage: error.message,
      };
    }

    logger?.(`⚠️ VPNGate prefix refresh 실패 - 기존 DEFAULT로 계속 진행 (${error.message})`);
    return {
      state: pendingState,
      refreshed: false,
      usedStaleCache: false,
      fallbackToDefault: true,
      errorMessage: error.message,
    };
  }
}

function buildEnsureResult(state, refreshResult = {}) {
  const runtimeState = cloneRuntimeState(state);
  const effectivePrefixSet = buildNormalizedPrefixSet(runtimeState.effectivePrefixes);

  return {
    state: runtimeState,
    effectivePrefixSet,
    hasUsablePrefixes: effectivePrefixSet.size > 0,
    refreshed: Boolean(refreshResult.refreshed),
    usedStaleCache: Boolean(refreshResult.usedStaleCache),
    fallbackToDefault: Boolean(refreshResult.fallbackToDefault) || effectivePrefixSet.size <= 0,
    errorMessage: String(refreshResult.errorMessage || '').trim(),
  };
}

async function ensureVpnGatePrefixRuntimeReady(consumerId, options = {}) {
  return withRuntimeStateLock(async () => {
    let state = await loadRuntimeState();
    const { state: consumerAddedState } = addConsumer(state, consumerId);
    state = consumerAddedState;

    if (shouldRefreshRuntimeState(state, options.forceRefresh === true)) {
      const refreshResult = await refreshRuntimeState(state, options);
      state = refreshResult.state;
      await saveRuntimeState(state);
      return buildEnsureResult(state, refreshResult);
    }

    await saveRuntimeState(state);
    return buildEnsureResult(state);
  });
}

async function releaseVpnGatePrefixRuntimeConsumer(consumerId) {
  return withRuntimeStateLock(async () => {
    const normalizedConsumerId = normalizeConsumerId(consumerId);
    if (!normalizedConsumerId) {
      return {
        cleared: false,
        state: await loadRuntimeState(),
      };
    }

    let state = await loadRuntimeState();
    const removalResult = removeConsumer(state, normalizedConsumerId);
    state = removalResult.state;

    if (state.activeConsumers.length <= 0) {
      const clearedState = await clearRuntimeState();
      return {
        cleared: true,
        state: clearedState,
      };
    }

    const savedState = await saveRuntimeState(state);
    return {
      cleared: false,
      state: savedState,
    };
  });
}

async function getVpnGatePrefixRuntimeStatus() {
  return withRuntimeStateLock(async () => loadRuntimeState());
}

export {
  REFRESH_INTERVAL_MS as VPNGATE_PREFIX_REFRESH_INTERVAL_MS,
  ensureVpnGatePrefixRuntimeReady,
  filterCommentsByVpnGatePrefixes,
  filterPostsByVpnGatePrefixes,
  getVpnGatePrefixRuntimeStatus,
  normalizeVpnGatePrefix,
  releaseVpnGatePrefixRuntimeConsumer,
};
