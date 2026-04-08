import { normalizeCommentRefluxMemo } from './parser.js';

const STORAGE_KEY = 'commentRefluxDatasetState';
const BUNDLED_DATASET_PATH = 'data/comment-reflux-set-unified.json';

const runtimeState = {
  loaded: false,
  memoSet: new Set(),
  memoCount: 0,
  updatedAt: '',
  sourceGalleryId: '',
  sourceGalleryIds: [],
  version: '',
  sourceType: '',
};

async function ensureCommentRefluxDatasetLoaded() {
  if (runtimeState.loaded) {
    return getCommentRefluxDatasetStatus();
  }

  const bundledState = await loadBundledCommentRefluxDatasetState();
  const storedState = await loadStoredCommentRefluxDatasetState();
  const shouldUseBundledState = shouldHydrateBundledCommentRefluxState(storedState, bundledState);
  const nextState = shouldUseBundledState
    ? bundledState
    : normalizeCommentRefluxDatasetState(storedState);

  hydrateCommentRefluxDatasetState(nextState, {
    memosArePreNormalized: shouldUseBundledState,
  });

  if (shouldUseBundledState && bundledState) {
    await saveNormalizedCommentRefluxDatasetState(bundledState);
  }

  return getCommentRefluxDatasetStatus();
}

async function loadStoredCommentRefluxDatasetState() {
  try {
    const { [STORAGE_KEY]: storedState } = await chrome.storage.local.get(STORAGE_KEY);
    return storedState || null;
  } catch (error) {
    console.error('[CommentRefluxDataset] 상태 복원 실패:', error.message);
    return null;
  }
}

async function loadBundledCommentRefluxDatasetState() {
  try {
    const datasetJson = await readBundledDatasetJson(BUNDLED_DATASET_PATH);
    if (Array.isArray(datasetJson?.memos)) {
      return normalizeCommentRefluxDatasetState({
        ...datasetJson,
        sourceType: 'bundled',
      });
    }

    const manifest = normalizeBundledCommentRefluxManifest(datasetJson);
    const memos = await loadBundledCommentRefluxShardMemos(manifest.shards);
    return {
      memos,
      memoCount: memos.length,
      updatedAt: manifest.updatedAt,
      sourceGalleryId: manifest.sourceGalleryIds[0] || '',
      sourceGalleryIds: manifest.sourceGalleryIds,
      version: manifest.version,
      sourceType: 'bundled',
    };
  } catch (error) {
    console.warn('[CommentRefluxDataset] 번들 dataset 로드 실패:', error.message);
    return null;
  }
}

function normalizeCommentRefluxDatasetState(storedState) {
  const normalizedMemos = dedupeNormalizedMemos(storedState?.memos || []);
  const sourceGalleryIds = normalizeSourceGalleryIds(storedState);
  const memoCount = normalizedMemos.length > 0
    ? normalizedMemos.length
    : normalizeMemoCount(storedState?.memoCount);

  return {
    memos: normalizedMemos,
    memoCount,
    updatedAt: String(storedState?.updatedAt || '').trim(),
    sourceGalleryId: sourceGalleryIds[0] || '',
    sourceGalleryIds,
    version: String(storedState?.version || '').trim(),
    sourceType: String(storedState?.sourceType || '').trim(),
  };
}

function shouldHydrateBundledCommentRefluxState(storedState, bundledState) {
  if (!bundledState) {
    return false;
  }

  // 번들 dataset이 실제로 채워져 있으면 그쪽이 source-of-truth다.
  // 다만 지금처럼 placeholder 번들이 비어 있을 때는,
  // 나중에 수동 주입한 댓글 dataset이 있으면 그걸 우선 써야 cold start 후에도 테스트가 유지된다.
  if (normalizeMemoCount(bundledState.memoCount) > 0) {
    return true;
  }

  const storedMemoCount = Array.isArray(storedState?.memos)
    ? dedupeNormalizedMemos(storedState.memos).length
    : normalizeMemoCount(storedState?.memoCount);
  return storedMemoCount <= 0;
}

function normalizePreNormalizedCommentRefluxDatasetState(storedState) {
  const normalizedMemos = dedupePreNormalizedMemos(storedState?.memos || []);
  const sourceGalleryIds = normalizeSourceGalleryIds(storedState);
  const memoCount = normalizedMemos.length > 0
    ? normalizedMemos.length
    : normalizeMemoCount(storedState?.memoCount);

  return {
    memos: normalizedMemos,
    memoCount,
    updatedAt: String(storedState?.updatedAt || '').trim(),
    sourceGalleryId: sourceGalleryIds[0] || '',
    sourceGalleryIds,
    version: String(storedState?.version || '').trim(),
    sourceType: String(storedState?.sourceType || '').trim(),
  };
}

function hydrateCommentRefluxDatasetState(storedState, options = {}) {
  const normalizedState = options.memosArePreNormalized
    ? normalizePreNormalizedCommentRefluxDatasetState(storedState)
    : normalizeCommentRefluxDatasetState(storedState);
  const normalizedMemos = normalizedState.memos;

  runtimeState.loaded = true;
  runtimeState.memoSet = new Set(normalizedMemos);
  runtimeState.memoCount = normalizedMemos.length > 0
    ? normalizedMemos.length
    : normalizeMemoCount(normalizedState.memoCount);
  runtimeState.updatedAt = normalizedState.updatedAt;
  runtimeState.sourceGalleryId = normalizedState.sourceGalleryId;
  runtimeState.sourceGalleryIds = normalizedState.sourceGalleryIds;
  runtimeState.version = normalizedState.version;
  runtimeState.sourceType = normalizedState.sourceType;
}

function getCommentRefluxDatasetStatus() {
  return {
    loaded: runtimeState.loaded,
    ready: isCommentRefluxDatasetReady(),
    memoCount: runtimeState.memoCount,
    updatedAt: runtimeState.updatedAt,
    sourceGalleryId: runtimeState.sourceGalleryId,
    sourceGalleryIds: [...runtimeState.sourceGalleryIds],
    version: runtimeState.version,
    sourceType: runtimeState.sourceType,
  };
}

function isCommentRefluxDatasetReady() {
  return runtimeState.loaded && runtimeState.memoSet.size > 0;
}

function hasCommentRefluxMemo(memo) {
  const normalizedMemo = normalizeCommentRefluxMemo(memo);
  if (!normalizedMemo) {
    return false;
  }

  return runtimeState.memoSet.has(normalizedMemo);
}

async function replaceCommentRefluxDataset(memos, options = {}) {
  const storedState = normalizeCommentRefluxDatasetState({
    memos,
    updatedAt: String(options?.updatedAt || new Date().toISOString()),
    sourceGalleryId: String(options?.sourceGalleryId || '').trim(),
    sourceGalleryIds: Array.isArray(options?.sourceGalleryIds) ? options.sourceGalleryIds : undefined,
    version: String(options?.version || '').trim(),
    sourceType: String(options?.sourceType || 'manual').trim(),
  });

  hydrateCommentRefluxDatasetState(storedState);
  await saveNormalizedCommentRefluxDatasetState(storedState);

  return getCommentRefluxDatasetStatus();
}

async function saveNormalizedCommentRefluxDatasetState(storedState) {
  const normalizedState = normalizeCommentRefluxDatasetState(storedState);
  const storageState = normalizedState.sourceType === 'bundled'
    ? {
      memos: [],
      memoCount: normalizedState.memoCount,
      updatedAt: normalizedState.updatedAt,
      sourceGalleryId: normalizedState.sourceGalleryId,
      sourceGalleryIds: normalizedState.sourceGalleryIds,
      version: normalizedState.version,
      sourceType: normalizedState.sourceType,
    }
    : normalizedState;

  await chrome.storage.local.set({
    [STORAGE_KEY]: storageState,
  });
}

function dedupeNormalizedMemos(memos) {
  return [...new Set(
    (Array.isArray(memos) ? memos : [])
      .map((memo) => normalizeCommentRefluxMemo(memo))
      .filter(Boolean),
  )];
}

function dedupePreNormalizedMemos(memos) {
  return [...new Set(
    (Array.isArray(memos) ? memos : [])
      .map((memo) => String(memo || '').trim())
      .filter(Boolean),
  )];
}

function normalizeSourceGalleryIds(storedState) {
  const rawSourceGalleryIds = Array.isArray(storedState?.sourceGalleryIds)
    ? storedState.sourceGalleryIds
    : [];
  const fallbackSourceGalleryId = String(storedState?.sourceGalleryId || '').trim();

  const normalizedSourceGalleryIds = [
    ...rawSourceGalleryIds.map((value) => String(value || '').trim()).filter(Boolean),
    ...(fallbackSourceGalleryId ? [fallbackSourceGalleryId] : []),
  ];

  return [...new Set(normalizedSourceGalleryIds)];
}

function normalizeMemoCount(value) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 0;
  }

  return Math.trunc(parsedValue);
}

async function readBundledDatasetJson(datasetPath) {
  const datasetUrl = chrome.runtime?.getURL
    ? chrome.runtime.getURL(datasetPath)
    : datasetPath;
  const response = await fetch(datasetUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function normalizeBundledCommentRefluxManifest(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('manifest 형식이 아닙니다.');
  }

  return {
    version: String(value.version || '').trim(),
    updatedAt: String(value.updatedAt || '').trim(),
    sourceGalleryIds: normalizeSourceGalleryIds(value),
    shards: Array.isArray(value.shards)
      ? value.shards
        .map((entry) => ({
          path: String(entry?.path || '').trim(),
          memoCount: normalizeMemoCount(entry?.memoCount),
        }))
        .filter((entry) => entry.path)
      : [],
  };
}

async function loadBundledCommentRefluxShardMemos(shards) {
  const normalizedMemos = [];

  for (const shard of Array.isArray(shards) ? shards : []) {
    const shardJson = await readBundledDatasetJson(String(shard?.path || '').trim());
    const shardMemos = Array.isArray(shardJson?.memos) ? shardJson.memos : [];

    for (const memo of shardMemos) {
      const normalizedMemo = normalizeCommentRefluxMemo(memo);
      if (!normalizedMemo) {
        continue;
      }
      normalizedMemos.push(normalizedMemo);
    }
  }

  return dedupePreNormalizedMemos(normalizedMemos);
}

export {
  ensureCommentRefluxDatasetLoaded,
  getCommentRefluxDatasetStatus,
  hasCommentRefluxMemo,
  isCommentRefluxDatasetReady,
  replaceCommentRefluxDataset,
};
