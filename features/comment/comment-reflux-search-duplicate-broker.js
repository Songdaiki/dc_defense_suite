import { withDcRequestLease } from '../../background/dc-session-broker.js';
import {
  buildCommentRefluxSearchQuery,
  normalizeCommentMemo,
  normalizeCommentRefluxCompareKey,
} from './parser.js';
import { parseRefluxSearchDuplicateJsonp } from '../post/reflux-search-duplicate-parser.js';

const STORAGE_KEY = 'commentRefluxSearchDuplicateCacheState';
const SEARCH_BASE_URL = 'https://search.dcinside.com';
const SEARCH_RESULT_PAGE_SIZE = 20;
const SEARCH_REQUEST_BASE_DELAY_MS = 100;
const SEARCH_REQUEST_JITTER_MS = 30;
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const ERROR_RETRY_COOLDOWN_MS = 30 * 1000;
const MAX_CACHE_ENTRY_COUNT = 800;

const runtimeState = {
  loaded: false,
  loadPromise: null,
  cacheMap: new Map(),
  pendingMap: new Map(),
  queue: [],
  workerPromise: null,
  generation: 0,
  logger: null,
};

async function ensureCommentRefluxSearchDuplicateBrokerLoaded() {
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
      console.error('[CommentRefluxSearchDuplicateBroker] cache 상태 복원 실패:', error.message);
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

  const entries = Array.isArray(storedState?.entries) ? storedState.entries : [];
  for (const rawEntry of entries) {
    const normalizedEntry = normalizePersistentCacheEntry(rawEntry);
    if (!normalizedEntry || isPersistentEntryExpired(normalizedEntry)) {
      continue;
    }

    runtimeState.cacheMap.set(normalizedEntry.cacheKey, normalizedEntry);
  }
}

function setCommentRefluxSearchDuplicateBrokerLogger(logger) {
  runtimeState.logger = typeof logger === 'function' ? logger : null;
}

function resetCommentRefluxSearchDuplicateBrokerRuntime() {
  runtimeState.generation += 1;
  runtimeState.queue = [];

  const pendingEntries = [...runtimeState.pendingMap.values()];
  runtimeState.pendingMap = new Map();
  pendingEntries.forEach((pendingEntry) => {
    settlePendingEntry(pendingEntry, {
      result: 'cancelled',
      rows: [],
      errorMessage: '',
    });
  });
}

function peekCommentRefluxSearchDuplicateDecision(context = {}) {
  const normalizedContext = normalizeDecisionContext(context);
  if (!normalizedContext) {
    return buildDecision({
      result: 'negative',
      source: 'invalid',
      matchedRow: null,
      errorMessage: '',
    });
  }

  const pendingEntry = getCurrentPendingEntry(normalizedContext.cacheKey);
  if (pendingEntry) {
    return buildDecision({
      result: 'pending',
      source: 'search_pending',
      matchedRow: null,
      errorMessage: '',
    });
  }

  const cacheEntry = getUsablePersistentCacheEntry(normalizedContext.cacheKey);
  if (!cacheEntry) {
    return buildDecision({
      result: 'miss',
      source: 'search_miss',
      matchedRow: null,
      errorMessage: '',
    });
  }

  return buildDecisionFromCacheEntry(cacheEntry, normalizedContext, 'search_cache');
}

async function resolveCommentRefluxSearchDuplicateDecision(context = {}) {
  const normalizedContext = normalizeDecisionContext(context);
  if (!normalizedContext) {
    return buildDecision({
      result: 'negative',
      source: 'invalid',
      matchedRow: null,
      errorMessage: '',
    });
  }

  const cacheEntry = getUsablePersistentCacheEntry(normalizedContext.cacheKey);
  if (cacheEntry) {
    return buildDecisionFromCacheEntry(cacheEntry, normalizedContext, 'search_cache');
  }

  let pendingEntry = getCurrentPendingEntry(normalizedContext.cacheKey);
  if (!pendingEntry) {
    pendingEntry = createPendingEntry(runtimeState.generation);
    runtimeState.pendingMap.set(normalizedContext.cacheKey, pendingEntry);
    runtimeState.queue.push({
      cacheKey: normalizedContext.cacheKey,
      searchGalleryId: normalizedContext.searchGalleryId,
      normalizedCompareKey: normalizedContext.normalizedCompareKey,
      searchQuery: normalizedContext.searchQuery,
      labelText: normalizedContext.labelText,
      generation: runtimeState.generation,
    });
    ensureWorkerRunning();
  }

  const fetchResult = await pendingEntry.promise;
  return buildDecisionFromFetchResult(fetchResult, normalizedContext);
}

function createPendingEntry(generation) {
  const deferred = createDeferred();
  return {
    generation,
    settled: false,
    promise: deferred.promise,
    resolve: deferred.resolve,
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });

  return {
    promise,
    resolve,
  };
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
      continue;
    }

    await sleepWithJitter(SEARCH_REQUEST_BASE_DELAY_MS, SEARCH_REQUEST_JITTER_MS);
    if (queueItem.generation !== runtimeState.generation) {
      continue;
    }

    await processQueueItem(queueItem);
  }
}

async function processQueueItem(queueItem) {
  try {
    const searchRows = await fetchSearchRows(queueItem);
    if (queueItem.generation !== runtimeState.generation) {
      return;
    }

    // cache에는 전체 검색 결과가 아니라, 같은 compare key row만 남긴다.
    const matchedRows = extractMatchedRows(searchRows, queueItem);
    const checkedAt = new Date().toISOString();
    runtimeState.cacheMap.set(queueItem.cacheKey, {
      cacheKey: queueItem.cacheKey,
      searchTargetGalleryId: queueItem.searchGalleryId,
      normalizedCompareKey: queueItem.normalizedCompareKey,
      result: 'success',
      checkedAt,
      expiresAt: new Date(
        Date.now() + (matchedRows.length > 0 ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
      ).toISOString(),
      retryAt: '',
      rows: matchedRows,
      errorMessage: '',
    });
    await persistCurrentCacheStateSafely();
    settlePendingEntryByKey(queueItem.cacheKey, queueItem.generation, {
      result: 'success',
      rows: matchedRows,
      errorMessage: '',
    });
  } catch (error) {
    if (queueItem.generation !== runtimeState.generation) {
      return;
    }

    runtimeState.cacheMap.set(queueItem.cacheKey, {
      cacheKey: queueItem.cacheKey,
      searchTargetGalleryId: queueItem.searchGalleryId,
      normalizedCompareKey: queueItem.normalizedCompareKey,
      result: 'error',
      checkedAt: new Date().toISOString(),
      expiresAt: '',
      retryAt: new Date(Date.now() + ERROR_RETRY_COOLDOWN_MS).toISOString(),
      rows: [],
      errorMessage: String(error?.message || 'unknown error'),
    });
    await persistCurrentCacheStateSafely();
    settlePendingEntryByKey(queueItem.cacheKey, queueItem.generation, {
      result: 'error',
      rows: [],
      errorMessage: String(error?.message || 'unknown error'),
    });
  }
}

async function fetchSearchRows(queueItem) {
  const callbackName = `commentJsonpCallback_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const encodedTitle = encodeSearchKeywordPath(queueItem.searchQuery);
  const searchUrl = `${SEARCH_BASE_URL}/ajax/getSearch/p/1/n/${SEARCH_RESULT_PAGE_SIZE}/q/${encodedTitle}?jsoncallback=${callbackName}`;

  return withDcRequestLease({ feature: 'comment', kind: 'searchDuplicate' }, async (lease) => {
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

function extractMatchedRows(searchRows, queueItem) {
  const dedupedRows = new Map();

  for (const row of Array.isArray(searchRows) ? searchRows : []) {
    if (!row || row.normalizedTitle !== queueItem.normalizedCompareKey) {
      continue;
    }

    const normalizedRow = normalizeMatchedRow(row, queueItem.normalizedCompareKey);
    if (!normalizedRow) {
      continue;
    }

    const rowKey = `${normalizedRow.boardId}::${normalizedRow.postNo}::${normalizedRow.href}`;
    if (!dedupedRows.has(rowKey)) {
      dedupedRows.set(rowKey, normalizedRow);
    }
  }

  return [...dedupedRows.values()];
}

function normalizeMatchedRow(row, fallbackNormalizedCompareKey = '') {
  const boardId = normalizeGalleryId(row?.boardId);
  const postNo = normalizePostNo(row?.postNo);
  const href = String(row?.href || '').trim();
  const normalizedTitle = normalizeCommentRefluxCompareKey(
    row?.normalizedTitle || row?.title || fallbackNormalizedCompareKey,
  );
  if (!boardId || !href || !normalizedTitle) {
    return null;
  }

  return {
    boardId,
    postNo,
    href,
    normalizedTitle,
  };
}

function buildDecisionFromCacheEntry(cacheEntry, context, source) {
  if (cacheEntry.result === 'error') {
    return buildDecision({
      result: 'error',
      source: 'search_error',
      matchedRow: null,
      errorMessage: cacheEntry.errorMessage,
    });
  }

  const matchedRow = findApplicableDuplicateMatch(cacheEntry.rows, context);
  return buildDecision({
    result: matchedRow ? 'positive' : 'negative',
    source,
    matchedRow,
    errorMessage: '',
  });
}

function buildDecisionFromFetchResult(fetchResult, context) {
  if (!fetchResult || fetchResult.result === 'cancelled') {
    return buildDecision({
      result: 'cancelled',
      source: 'cancelled',
      matchedRow: null,
      errorMessage: '',
    });
  }

  if (fetchResult.result === 'error') {
    return buildDecision({
      result: 'error',
      source: 'search_error',
      matchedRow: null,
      errorMessage: fetchResult.errorMessage,
    });
  }

  const matchedRow = findApplicableDuplicateMatch(fetchResult.rows, context);
  return buildDecision({
    result: matchedRow ? 'positive' : 'negative',
    source: 'search_queue',
    matchedRow,
    errorMessage: '',
  });
}

function buildDecision({
  result = 'negative',
  source = 'search_cache',
  matchedRow = null,
  errorMessage = '',
} = {}) {
  return {
    result,
    source,
    matchedRow,
    errorMessage,
  };
}

function findApplicableDuplicateMatch(rows, context) {
  const deleteTargetGalleryId = normalizeGalleryId(context.deleteGalleryId);
  const currentPostNo = normalizePostNo(context.currentPostNo);

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.normalizedTitle !== context.normalizedCompareKey) {
      continue;
    }

    const rowGalleryId = normalizeGalleryId(row.boardId);
    const rowPostNo = normalizePostNo(row.postNo);
    if (
      rowGalleryId
      && deleteTargetGalleryId
      && rowGalleryId === deleteTargetGalleryId
      && currentPostNo > 0
      && rowPostNo > 0
      && rowPostNo === currentPostNo
    ) {
      continue;
    }

    return row;
  }

  return null;
}

function normalizeDecisionContext(context = {}) {
  const plainText = String(
    context.plainText !== undefined
      ? context.plainText
      : normalizeCommentMemo(context.memo),
  ).trim();
  const normalizedCompareKey = String(
    context.normalizedCompareKey || normalizeCommentRefluxCompareKey(plainText),
  ).trim();
  const searchQuery = String(
    context.searchQuery || buildCommentRefluxSearchQuery(plainText),
  ).trim();
  const searchGalleryId = normalizeGalleryId(context.searchGalleryId);
  const deleteGalleryId = normalizeGalleryId(context.deleteGalleryId);
  const currentPostNo = normalizePostNo(context.currentPostNo || context.postNo);
  const cacheKey = buildCacheKey(searchGalleryId, normalizedCompareKey);
  if (!plainText || !normalizedCompareKey || !searchQuery || !searchGalleryId || !cacheKey) {
    return null;
  }

  return {
    plainText,
    labelText: plainText,
    normalizedCompareKey,
    searchQuery,
    searchGalleryId,
    deleteGalleryId,
    currentPostNo,
    cacheKey,
  };
}

function buildCacheKey(searchGalleryId, normalizedCompareKey) {
  const normalizedSearchGalleryId = normalizeGalleryId(searchGalleryId);
  const compareKey = normalizeCommentRefluxCompareKey(normalizedCompareKey);
  if (!normalizedSearchGalleryId || !compareKey) {
    return '';
  }

  return `${normalizedSearchGalleryId}::${compareKey}`;
}

function getCurrentPendingEntry(cacheKey) {
  const pendingEntry = runtimeState.pendingMap.get(cacheKey);
  if (!pendingEntry || pendingEntry.generation !== runtimeState.generation) {
    return null;
  }

  return pendingEntry;
}

function settlePendingEntryByKey(cacheKey, generation, result) {
  const pendingEntry = runtimeState.pendingMap.get(cacheKey);
  if (!pendingEntry || pendingEntry.generation !== generation) {
    return;
  }

  runtimeState.pendingMap.delete(cacheKey);
  settlePendingEntry(pendingEntry, result);
}

function settlePendingEntry(pendingEntry, result) {
  if (!pendingEntry || pendingEntry.settled) {
    return;
  }

  pendingEntry.settled = true;
  pendingEntry.resolve(result);
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
    void persistCurrentCacheStateSafely();
    return null;
  }

  return cacheEntry;
}

function normalizePersistentCacheEntry(rawEntry) {
  const searchTargetGalleryId = normalizeGalleryId(rawEntry?.searchTargetGalleryId);
  const normalizedCompareKey = normalizeCommentRefluxCompareKey(
    rawEntry?.normalizedCompareKey || rawEntry?.normalizedTitle,
  );
  const cacheKey = searchTargetGalleryId && normalizedCompareKey
    ? `${searchTargetGalleryId}::${normalizedCompareKey}`
    : String(rawEntry?.cacheKey || '').trim();
  const result = String(rawEntry?.result || '').trim();
  if (!cacheKey || !['success', 'error'].includes(result)) {
    return null;
  }

  return {
    cacheKey,
    searchTargetGalleryId,
    normalizedCompareKey,
    result,
    checkedAt: String(rawEntry?.checkedAt || '').trim(),
    expiresAt: String(rawEntry?.expiresAt || '').trim(),
    retryAt: String(rawEntry?.retryAt || '').trim(),
    rows: normalizeStoredRows(rawEntry?.rows, normalizedCompareKey),
    errorMessage: String(rawEntry?.errorMessage || '').trim(),
  };
}

function normalizeStoredRows(rows, fallbackNormalizedCompareKey = '') {
  const dedupedRows = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const normalizedRow = normalizeMatchedRow(row, fallbackNormalizedCompareKey);
    if (!normalizedRow) {
      continue;
    }

    const rowKey = `${normalizedRow.boardId}::${normalizedRow.postNo}::${normalizedRow.href}`;
    if (!dedupedRows.has(rowKey)) {
      dedupedRows.set(rowKey, normalizedRow);
    }
  }

  return [...dedupedRows.values()];
}

function isPersistentEntryExpired(cacheEntry) {
  if (!cacheEntry) {
    return true;
  }

  if (cacheEntry.result === 'success') {
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

async function persistCurrentCacheState() {
  const normalizedEntries = [...runtimeState.cacheMap.values()]
    .map((entry) => normalizePersistentCacheEntry(entry))
    .filter((entry) => entry && !isPersistentEntryExpired(entry))
    .sort((left, right) => Date.parse(right.checkedAt || '') - Date.parse(left.checkedAt || ''))
    .slice(0, MAX_CACHE_ENTRY_COUNT);

  runtimeState.cacheMap = new Map(normalizedEntries.map((entry) => [entry.cacheKey, entry]));

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
    console.error('[CommentRefluxSearchDuplicateBroker] cache 저장 실패:', error.message);
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
  ensureCommentRefluxSearchDuplicateBrokerLoaded,
  peekCommentRefluxSearchDuplicateDecision,
  resetCommentRefluxSearchDuplicateBrokerRuntime,
  resolveCommentRefluxSearchDuplicateDecision,
  setCommentRefluxSearchDuplicateBrokerLogger,
};
