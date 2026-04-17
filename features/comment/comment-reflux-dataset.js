import { normalizeCommentRefluxMemo } from './parser.js';
import {
  ensureSemiconductorRefluxTitleSetLoaded,
  getSemiconductorRefluxTitleSetStatus,
} from '../post/semiconductor-reflux-title-set.js';
import {
  ensureSemiconductorRefluxEffectiveMatcherLoaded,
  getSemiconductorRefluxEffectiveMatcherStatus,
  hasNormalizedSemiconductorRefluxEffectiveTitle,
} from '../post/semiconductor-reflux-effective-matcher.js';

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
  if (runtimeState.loaded && runtimeState.memoCount > 0) {
    return getCommentRefluxDatasetStatus();
  }

  const sharedDatasetState = await loadSharedCommentRefluxDatasetState();
  if (!sharedDatasetState) {
    hydrateCommentRefluxDatasetState(buildFallbackCommentRefluxDatasetState());
    return getCommentRefluxDatasetStatus();
  }

  hydrateCommentRefluxDatasetState(sharedDatasetState);
  await saveSharedCommentRefluxDatasetState(sharedDatasetState);
  return getCommentRefluxDatasetStatus();
}

async function ensureCommentRefluxMatcherLoaded() {
  await ensureCommentRefluxDatasetLoaded();
  await ensureSemiconductorRefluxEffectiveMatcherLoaded();
  return getCommentRefluxMatcherStatus();
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

function getCommentRefluxMatcherStatus() {
  const datasetStatus = getCommentRefluxDatasetStatus();
  const effectiveMatcherStatus = getSemiconductorRefluxEffectiveMatcherStatus();
  const matcherReady = Boolean(effectiveMatcherStatus.ready);
  const twoParentIndexReady = Boolean(matcherReady && effectiveMatcherStatus.twoParentIndexReady);

  return {
    loaded: Boolean(datasetStatus.loaded || effectiveMatcherStatus.loaded),
    ready: matcherReady,
    datasetReady: Boolean(datasetStatus.ready),
    memoCount: datasetStatus.memoCount,
    updatedAt: datasetStatus.updatedAt,
    sourceGalleryId: datasetStatus.sourceGalleryId,
    sourceGalleryIds: [...datasetStatus.sourceGalleryIds],
    version: datasetStatus.version,
    sourceType: datasetStatus.sourceType,
    overlayActiveCount: Math.max(0, Number(effectiveMatcherStatus.overlayActiveCount) || 0),
    overlayTitleCount: Math.max(0, Number(effectiveMatcherStatus.overlayTitleCount) || 0),
    twoParentIndexReady,
    twoParentIndexVersionMatch: Boolean(effectiveMatcherStatus.baseTwoParentIndexReady),
    twoParentIndexDatasetVersion: String(datasetStatus.version || '').trim(),
    twoParentBucketCount: 0,
    twoParentChunkLengths: Array.isArray(effectiveMatcherStatus.twoParentChunkLengths)
      ? [...effectiveMatcherStatus.twoParentChunkLengths]
      : [],
    reason: buildCommentRefluxMatcherReason(datasetStatus, effectiveMatcherStatus),
  };
}

function isCommentRefluxDatasetReady() {
  return Boolean(runtimeState.loaded && runtimeState.memoCount > 0);
}

function isCommentRefluxMatcherReady() {
  return Boolean(getCommentRefluxMatcherStatus().ready);
}

function isCommentRefluxTwoParentReady() {
  const matcherStatus = getCommentRefluxMatcherStatus();
  return Boolean(matcherStatus.ready && matcherStatus.twoParentIndexReady);
}

function hasCommentRefluxMemo(memo) {
  if (!isCommentRefluxMatcherReady()) {
    return false;
  }

  const normalizedMemo = normalizeCommentRefluxMemo(memo);
  if (!normalizedMemo) {
    return false;
  }

  return hasNormalizedSemiconductorRefluxEffectiveTitle(normalizedMemo);
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

function buildFallbackCommentRefluxDatasetState() {
  return {
    memoCount: 0,
    updatedAt: '',
    sourceGalleryId: '',
    sourceGalleryIds: [],
    version: '',
    sourceType: 'bundled_shared_title_set',
  };
}

function buildCommentRefluxMatcherReason(datasetStatus = {}, effectiveMatcherStatus = {}) {
  if (!effectiveMatcherStatus.loaded) {
    return '역류기 effective matcher가 아직 로드되지 않았습니다.';
  }

  if (!effectiveMatcherStatus.ready) {
    if (!datasetStatus.ready && (Number(effectiveMatcherStatus.overlayActiveCount) || 0) <= 0) {
      return '역류기 공용 dataset과 overlay가 모두 비어 있습니다.';
    }

    return String(effectiveMatcherStatus.reason || '').trim() || '역류기 effective matcher를 사용할 수 없습니다.';
  }

  if (!effectiveMatcherStatus.twoParentIndexReady) {
    return String(effectiveMatcherStatus.reason || '').trim() || '댓글 2-parent matcher를 사용할 수 없습니다.';
  }

  return '';
}

export {
  ensureCommentRefluxDatasetLoaded,
  ensureCommentRefluxMatcherLoaded,
  getCommentRefluxDatasetStatus,
  getCommentRefluxMatcherStatus,
  hasCommentRefluxMemo,
  isCommentRefluxDatasetReady,
  isCommentRefluxMatcherReady,
  isCommentRefluxTwoParentReady,
  replaceCommentRefluxDataset,
};
