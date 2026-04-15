import { normalizeCommentRefluxMemo } from './parser.js';
import {
  ensureSemiconductorRefluxTitleSetLoaded,
  getSemiconductorRefluxTitleSetStatus,
  hasNormalizedSemiconductorRefluxTitle,
  isSemiconductorRefluxTitleSetReady,
} from '../post/semiconductor-reflux-title-set.js';

const STORAGE_KEY = 'commentRefluxDatasetState';

const runtimeState = {
  loaded: false,
  memoCount: 0,
  updatedAt: '',
  sourceGalleryId: '',
  sourceGalleryIds: [],
  version: '',
  sourceType: '',
};

async function ensureCommentRefluxDatasetLoaded() {
  if (
    runtimeState.loaded
    && runtimeState.sourceType === 'bundled_shared_title_set'
    && isSemiconductorRefluxTitleSetReady()
  ) {
    return getCommentRefluxDatasetStatus();
  }

  const sharedDatasetState = await loadSharedCommentRefluxDatasetState();
  if (!sharedDatasetState) {
    resetRuntimeState();
    throw new Error('역류기 공용 dataset(reflux-title-set-unified.json) 로드 실패');
  }

  hydrateCommentRefluxDatasetState(sharedDatasetState);
  await saveSharedCommentRefluxDatasetState(sharedDatasetState);
  return getCommentRefluxDatasetStatus();
}

async function loadSharedCommentRefluxDatasetState() {
  await ensureSemiconductorRefluxTitleSetLoaded();

  const sharedDatasetStatus = getSemiconductorRefluxTitleSetStatus();
  if (!sharedDatasetStatus.ready) {
    return null;
  }

  return {
    memoCount: Math.max(0, Number(sharedDatasetStatus.titleCount) || 0),
    updatedAt: String(sharedDatasetStatus.updatedAt || '').trim(),
    sourceGalleryId: String(sharedDatasetStatus.sourceGalleryId || '').trim(),
    sourceGalleryIds: normalizeSourceGalleryIds(sharedDatasetStatus),
    version: String(sharedDatasetStatus.version || '').trim(),
    sourceType: 'bundled_shared_title_set',
  };
}

function hydrateCommentRefluxDatasetState(nextState = {}) {
  runtimeState.loaded = true;
  runtimeState.memoCount = Math.max(0, Number(nextState.memoCount) || 0);
  runtimeState.updatedAt = String(nextState.updatedAt || '').trim();
  runtimeState.sourceGalleryId = String(nextState.sourceGalleryId || '').trim();
  runtimeState.sourceGalleryIds = normalizeSourceGalleryIds(nextState);
  runtimeState.version = String(nextState.version || '').trim();
  runtimeState.sourceType = String(nextState.sourceType || '').trim();
}

function resetRuntimeState() {
  runtimeState.loaded = false;
  runtimeState.memoCount = 0;
  runtimeState.updatedAt = '';
  runtimeState.sourceGalleryId = '';
  runtimeState.sourceGalleryIds = [];
  runtimeState.version = '';
  runtimeState.sourceType = '';
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
  return runtimeState.loaded
    && runtimeState.sourceType === 'bundled_shared_title_set'
    && isSemiconductorRefluxTitleSetReady();
}

function hasCommentRefluxMemo(memo) {
  if (!isCommentRefluxDatasetReady()) {
    return false;
  }

  const normalizedMemo = normalizeCommentRefluxMemo(memo);
  if (!normalizedMemo) {
    return false;
  }

  return hasNormalizedSemiconductorRefluxTitle(normalizedMemo);
}

async function replaceCommentRefluxDataset() {
  throw new Error('댓글 전용 dataset 주입은 더 이상 지원하지 않습니다. reflux-title-set-unified.json 공용 dataset만 사용하세요.');
}

async function saveSharedCommentRefluxDatasetState(nextState = {}) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      memoCount: Math.max(0, Number(nextState.memoCount) || 0),
      updatedAt: String(nextState.updatedAt || '').trim(),
      sourceGalleryId: String(nextState.sourceGalleryId || '').trim(),
      sourceGalleryIds: normalizeSourceGalleryIds(nextState),
      version: String(nextState.version || '').trim(),
      sourceType: 'bundled_shared_title_set',
    },
  });
}

function normalizeSourceGalleryIds(value) {
  const rawSourceGalleryIds = Array.isArray(value?.sourceGalleryIds)
    ? value.sourceGalleryIds
    : [];
  const fallbackSourceGalleryId = String(value?.sourceGalleryId || '').trim();

  const normalizedSourceGalleryIds = [
    ...rawSourceGalleryIds.map((entry) => String(entry || '').trim()).filter(Boolean),
    ...(fallbackSourceGalleryId ? [fallbackSourceGalleryId] : []),
  ];

  return [...new Set(normalizedSourceGalleryIds)];
}

export {
  ensureCommentRefluxDatasetLoaded,
  getCommentRefluxDatasetStatus,
  hasCommentRefluxMemo,
  isCommentRefluxDatasetReady,
  replaceCommentRefluxDataset,
};
