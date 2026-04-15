import { withDcRequestLease } from '../../background/dc-session-broker.js';
import {
  buildSemiconductorRefluxSearchQuery,
  normalizeSemiconductorRefluxTitle,
} from './attack-mode.js';
import { parseRefluxSearchDuplicateJsonp } from './reflux-search-duplicate-parser.js';

const STORAGE_KEY = 'refluxSearchDuplicateCacheState';
const SEARCH_BASE_URL = 'https://search.dcinside.com';
const SEARCH_RESULT_PAGE_SIZE = 20;
const SEARCH_REQUEST_BASE_DELAY_MS = 100;
const SEARCH_REQUEST_JITTER_MS = 30;
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const ERROR_RETRY_COOLDOWN_MS = 30 * 1000;
const MAX_CACHE_ENTRY_COUNT = 4000;

const runtimeState = {
  loaded: false,
  loadPromise: null,
  cacheMap: new Map(),
  positiveHotset: new Set(),
  pendingMap: new Map(),
  queue: [],
  workerPromise: null,
  generation: 0,
  logger: null,
};

async function ensureRefluxSearchDuplicateBrokerLoaded() {
  if (runtimeState.loaded) {
    return;
  }

  if (runtimeState.loadPromise) {
    await runtimeState.loadPromise;
    return;
  }

  runtimeState.loadPromise = (async () => {
    try {
      const { [STORAGE_KEY]: storedState } = await chrome.storage.local.get(STORAGE_KEY);
      hydrateStoredCacheState(storedState);
    } catch (error) {
      console.error('[RefluxSearchDuplicateBroker] cache 상태 복원 실패:', error.message);
      hydrateStoredCacheState(null);
    } finally {
      runtimeState.loaded = true;
      runtimeState.loadPromise = null;
    }
  })();

  await runtimeState.loadPromise;
}

function hydrateStoredCacheState(storedState) {
  runtimeState.cacheMap = new Map();
  runtimeState.positiveHotset = new Set();

  const entries = Array.isArray(storedState?.entries) ? storedState.entries : [];
  for (const rawEntry of entries) {
    const normalizedEntry = normalizePersistentCacheEntry(rawEntry);
    if (!normalizedEntry || isPersistentEntryExpired(normalizedEntry)) {
      continue;
    }

    runtimeState.cacheMap.set(normalizedEntry.cacheKey, normalizedEntry);
    if (normalizedEntry.result === 'positive') {
      runtimeState.positiveHotset.add(normalizedEntry.cacheKey);
    }
  }
}

function setRefluxSearchDuplicateBrokerLogger(logger) {
  runtimeState.logger = typeof logger === 'function' ? logger : null;
}

function resetRefluxSearchDuplicateBrokerRuntime() {
  runtimeState.generation += 1;
  runtimeState.queue = [];
  runtimeState.pendingMap = new Map();
  runtimeState.positiveHotset = new Set();
}

function getRefluxSearchDuplicatePositiveDecision({ searchGalleryId, title }) {
  const cacheKey = buildCacheKey(searchGalleryId, title);
  if (!cacheKey) {
    return 'miss';
  }

  if (runtimeState.positiveHotset.has(cacheKey)) {
    return 'positive';
  }

  const cacheEntry = getUsablePersistentCacheEntry(cacheKey);
  if (cacheEntry?.result === 'positive') {
    runtimeState.positiveHotset.add(cacheKey);
    return 'positive';
  }

  return 'miss';
}

function getRefluxSearchDuplicateDecision({ searchGalleryId, title }) {
  const cacheKey = buildCacheKey(searchGalleryId, title);
  if (!cacheKey) {
    return 'miss';
  }

  const pendingGeneration = runtimeState.pendingMap.get(cacheKey);
  if (pendingGeneration === runtimeState.generation) {
    return 'pending';
  }

  if (runtimeState.positiveHotset.has(cacheKey)) {
    return 'positive';
  }

  const cacheEntry = getUsablePersistentCacheEntry(cacheKey);
  if (!cacheEntry) {
    return 'miss';
  }

  if (cacheEntry.result === 'positive') {
    runtimeState.positiveHotset.add(cacheKey);
    return 'positive';
  }

  return cacheEntry.result;
}

function shouldEnqueueRefluxSearchDuplicate({ searchGalleryId, title }) {
  const cacheKey = buildCacheKey(searchGalleryId, title);
  if (!cacheKey) {
    return false;
  }

  const pendingGeneration = runtimeState.pendingMap.get(cacheKey);
  if (pendingGeneration === runtimeState.generation) {
    return false;
  }

  return getRefluxSearchDuplicateDecision({ searchGalleryId, title }) === 'miss';
}

function enqueueRefluxSearchDuplicate({ deleteGalleryId, searchGalleryId, postNo, title }) {
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  const searchQuery = buildSemiconductorRefluxSearchQuery(title);
  const normalizedSearchGalleryId = normalizeGalleryId(searchGalleryId);
  const normalizedDeleteGalleryId = normalizeGalleryId(deleteGalleryId);
  const normalizedPostNo = normalizePostNo(postNo);
  const cacheKey = buildCacheKey(normalizedSearchGalleryId, title);
  if (!cacheKey || !normalizedSearchGalleryId || !normalizedDeleteGalleryId || !normalizedTitle || !searchQuery) {
    return false;
  }

  if (!shouldEnqueueRefluxSearchDuplicate({
    searchGalleryId: normalizedSearchGalleryId,
    title,
  })) {
    return false;
  }

  const generation = runtimeState.generation;
  runtimeState.pendingMap.set(cacheKey, generation);
  runtimeState.queue.push({
    cacheKey,
    deleteGalleryId: normalizedDeleteGalleryId,
    searchGalleryId: normalizedSearchGalleryId,
    normalizedTitle,
    searchQuery,
    title: String(title || '').trim(),
    postNo: normalizedPostNo,
    generation,
    enqueuedAt: new Date().toISOString(),
  });
  ensureWorkerRunning();
  return true;
}

function ensureWorkerRunning() {
  if (runtimeState.workerPromise) {
    return;
  }

  runtimeState.workerPromise = runWorker().finally(() => {
    runtimeState.workerPromise = null;
    if (runtimeState.queue.length > 0) {
      ensureWorkerRunning();
    }
  });
}

async function runWorker() {
  while (runtimeState.queue.length > 0) {
    const queueItem = runtimeState.queue.shift();
    if (!queueItem) {
      continue;
    }

    if (queueItem.generation !== runtimeState.generation) {
      clearPendingEntry(queueItem.cacheKey, queueItem.generation);
      continue;
    }

    await sleepWithJitter(SEARCH_REQUEST_BASE_DELAY_MS, SEARCH_REQUEST_JITTER_MS);

    if (queueItem.generation !== runtimeState.generation) {
      clearPendingEntry(queueItem.cacheKey, queueItem.generation);
      continue;
    }

    await processQueueItem(queueItem);
  }
}

async function processQueueItem(queueItem) {
  try {
    const searchRows = await fetchSearchRows(queueItem);
    if (queueItem.generation !== runtimeState.generation) {
      clearPendingEntry(queueItem.cacheKey, queueItem.generation);
      return;
    }

    const duplicateMatch = findDuplicateMatch(searchRows, queueItem);
    if (duplicateMatch) {
      runtimeState.positiveHotset.add(queueItem.cacheKey);
      runtimeState.cacheMap.set(queueItem.cacheKey, {
        cacheKey: queueItem.cacheKey,
        normalizedTitle: queueItem.normalizedTitle,
        searchTargetGalleryId: queueItem.searchGalleryId,
        result: 'positive',
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + POSITIVE_TTL_MS).toISOString(),
        retryAt: '',
        matchedGalleryId: duplicateMatch.boardId,
        matchedPostNo: duplicateMatch.postNo,
        matchedHref: duplicateMatch.href,
        source: 'getSearch',
        errorMessage: '',
      });
      await persistCurrentCacheStateSafely();
      emitLog(`🔎 검색 중복 확인: ${queueItem.title} -> ${duplicateMatch.boardId} #${duplicateMatch.postNo}`);
    } else {
      runtimeState.positiveHotset.delete(queueItem.cacheKey);
      runtimeState.cacheMap.set(queueItem.cacheKey, {
        cacheKey: queueItem.cacheKey,
        normalizedTitle: queueItem.normalizedTitle,
        searchTargetGalleryId: queueItem.searchGalleryId,
        result: 'negative',
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + NEGATIVE_TTL_MS).toISOString(),
        retryAt: '',
        matchedGalleryId: '',
        matchedPostNo: 0,
        matchedHref: '',
        source: 'getSearch',
        errorMessage: '',
      });
      await persistCurrentCacheStateSafely();
      emitLog(`🔎 검색 미확인: ${queueItem.title}`);
    }
  } catch (error) {
    if (queueItem.generation === runtimeState.generation) {
      runtimeState.positiveHotset.delete(queueItem.cacheKey);
      runtimeState.cacheMap.set(queueItem.cacheKey, {
        cacheKey: queueItem.cacheKey,
        normalizedTitle: queueItem.normalizedTitle,
        searchTargetGalleryId: queueItem.searchGalleryId,
        result: 'error',
        checkedAt: new Date().toISOString(),
        expiresAt: '',
        retryAt: new Date(Date.now() + ERROR_RETRY_COOLDOWN_MS).toISOString(),
        matchedGalleryId: '',
        matchedPostNo: 0,
        matchedHref: '',
        source: 'getSearch',
        errorMessage: String(error?.message || 'unknown error'),
      });
      await persistCurrentCacheStateSafely();
      emitLog(`⚠️ 검색 확인 실패: ${queueItem.title} - ${error.message}`);
    }
  } finally {
    clearPendingEntry(queueItem.cacheKey, queueItem.generation);
  }
}

async function fetchSearchRows(queueItem) {
  const callbackName = `jsonpCallback_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const encodedTitle = encodeSearchKeywordPath(queueItem.searchQuery);
  const searchUrl = `${SEARCH_BASE_URL}/ajax/getSearch/p/1/n/${SEARCH_RESULT_PAGE_SIZE}/q/${encodedTitle}?jsoncallback=${callbackName}`;

  return withDcRequestLease({ feature: 'post', kind: 'searchDuplicate' }, async (lease) => {
    const response = await fetch(searchUrl, {
      credentials: 'include',
      signal: lease.signal,
      headers: {
        Accept: '*/*',
      },
    });

    if (!response.ok) {
      throw new Error(`search 응답 실패 (${response.status})`);
    }

    const responseText = await response.text();
    return parseRefluxSearchDuplicateJsonp(responseText);
  });
}

function findDuplicateMatch(searchRows, queueItem) {
  const targetSearchGalleryId = queueItem.searchGalleryId;
  const deleteTargetGalleryId = queueItem.deleteGalleryId;
  const currentPostNo = normalizePostNo(queueItem.postNo);

  for (const row of Array.isArray(searchRows) ? searchRows : []) {
    if (!row || row.normalizedTitle !== queueItem.normalizedTitle) {
      continue;
    }

    if (normalizeGalleryId(row.boardId) !== targetSearchGalleryId) {
      continue;
    }

    if (targetSearchGalleryId === deleteTargetGalleryId) {
      if (currentPostNo <= 0 || normalizePostNo(row.postNo) <= 0) {
        continue;
      }

      if (normalizePostNo(row.postNo) === currentPostNo) {
        continue;
      }
    }

    return row;
  }

  return null;
}

function clearPendingEntry(cacheKey, generation) {
  if (runtimeState.pendingMap.get(cacheKey) === generation) {
    runtimeState.pendingMap.delete(cacheKey);
  }
}

function encodeSearchKeywordPath(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  if (bytes.length <= 0) {
    return '';
  }

  return Array.from(
    bytes,
    (byte) => `.${byte.toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('');
}

function buildCacheKey(searchGalleryId, title) {
  const normalizedSearchGalleryId = normalizeGalleryId(searchGalleryId);
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  if (!normalizedSearchGalleryId || !normalizedTitle) {
    return '';
  }

  return `${normalizedSearchGalleryId}::${normalizedTitle}`;
}

function normalizeGalleryId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePostNo(value) {
  const normalizedValue = String(value || '').trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return 0;
  }
  return Number(normalizedValue);
}

function getUsablePersistentCacheEntry(cacheKey) {
  const cacheEntry = runtimeState.cacheMap.get(cacheKey);
  if (!cacheEntry) {
    return null;
  }

  if (isPersistentEntryExpired(cacheEntry)) {
    runtimeState.cacheMap.delete(cacheKey);
    runtimeState.positiveHotset.delete(cacheKey);
    void persistCurrentCacheStateSafely();
    return null;
  }

  return cacheEntry;
}

function isPersistentEntryExpired(cacheEntry) {
  if (!cacheEntry) {
    return true;
  }

  if (cacheEntry.result === 'positive' || cacheEntry.result === 'negative') {
    return isIsoTimestampExpired(cacheEntry.expiresAt);
  }

  if (cacheEntry.result === 'error') {
    return isIsoTimestampExpired(cacheEntry.retryAt);
  }

  return true;
}

function isIsoTimestampExpired(isoTimestamp) {
  const timestamp = Date.parse(String(isoTimestamp || ''));
  if (!Number.isFinite(timestamp)) {
    return true;
  }
  return timestamp <= Date.now();
}

function normalizePersistentCacheEntry(rawEntry) {
  const searchTargetGalleryId = normalizeGalleryId(rawEntry?.searchTargetGalleryId);
  const normalizedTitle = normalizeSemiconductorRefluxTitle(rawEntry?.normalizedTitle);
  const cacheKey = searchTargetGalleryId && normalizedTitle
    ? `${searchTargetGalleryId}::${normalizedTitle}`
    : String(rawEntry?.cacheKey || '').trim();
  const result = String(rawEntry?.result || '').trim();
  if (!cacheKey || !['positive', 'negative', 'error'].includes(result)) {
    return null;
  }

  return {
    cacheKey,
    normalizedTitle,
    searchTargetGalleryId,
    result,
    checkedAt: String(rawEntry?.checkedAt || '').trim(),
    expiresAt: String(rawEntry?.expiresAt || '').trim(),
    retryAt: String(rawEntry?.retryAt || '').trim(),
    matchedGalleryId: normalizeGalleryId(rawEntry?.matchedGalleryId),
    matchedPostNo: normalizePostNo(rawEntry?.matchedPostNo),
    matchedHref: String(rawEntry?.matchedHref || '').trim(),
    source: String(rawEntry?.source || 'getSearch').trim(),
    errorMessage: String(rawEntry?.errorMessage || '').trim(),
  };
}

async function persistCurrentCacheState() {
  const normalizedEntries = [...runtimeState.cacheMap.values()]
    .map((entry) => normalizePersistentCacheEntry(entry))
    .filter((entry) => entry && !isPersistentEntryExpired(entry))
    .sort((left, right) => Date.parse(right.checkedAt || '') - Date.parse(left.checkedAt || ''))
    .slice(0, MAX_CACHE_ENTRY_COUNT);

  runtimeState.cacheMap = new Map();
  runtimeState.positiveHotset = new Set();
  for (const entry of normalizedEntries) {
    runtimeState.cacheMap.set(entry.cacheKey, entry);
    if (entry.result === 'positive') {
      runtimeState.positiveHotset.add(entry.cacheKey);
    }
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      updatedAt: new Date().toISOString(),
      entries: normalizedEntries,
    },
  });
}

async function persistCurrentCacheStateSafely() {
  try {
    await persistCurrentCacheState();
  } catch (error) {
    console.error('[RefluxSearchDuplicateBroker] cache 저장 실패:', error.message);
  }
}

function emitLog(message) {
  if (typeof runtimeState.logger === 'function') {
    runtimeState.logger(message);
  }
}

async function sleepWithJitter(baseDelayMs, jitterMs) {
  const normalizedBaseDelayMs = Math.max(0, Number(baseDelayMs) || 0);
  const normalizedJitterMs = Math.max(0, Number(jitterMs) || 0);
  const jitter = normalizedJitterMs > 0
    ? Math.floor(Math.random() * (normalizedJitterMs + 1))
    : 0;
  const sleepMs = normalizedBaseDelayMs + jitter;

  if (sleepMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, sleepMs);
  });
}

export {
  enqueueRefluxSearchDuplicate,
  ensureRefluxSearchDuplicateBrokerLoaded,
  getRefluxSearchDuplicateDecision,
  getRefluxSearchDuplicatePositiveDecision,
  resetRefluxSearchDuplicateBrokerRuntime,
  setRefluxSearchDuplicateBrokerLogger,
  shouldEnqueueRefluxSearchDuplicate,
};
