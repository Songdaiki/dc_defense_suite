import { normalizeSemiconductorRefluxTitle } from './attack-mode.js';
import {
  SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY,
  ensureSemiconductorRefluxPostTitleMatcherLoaded,
  getSemiconductorRefluxBundledTwoParentIndexSnapshot,
  getSemiconductorRefluxPostTitleMatcherStatus,
  hasNormalizedSemiconductorRefluxTwoParentMixTitle,
} from './semiconductor-reflux-post-title-matcher.js';
import {
  createSemiconductorRefluxTitleMatchRuntimeFromNormalizedTitles,
  ensureSemiconductorRefluxTitleSetLoaded,
  getSemiconductorRefluxTitleSetStatus,
  hasNormalizedSemiconductorRefluxTitle,
  hasNormalizedSemiconductorRefluxTitleInRuntime,
} from './semiconductor-reflux-title-set.js';
import { loadActiveOverlayDataset } from './semiconductor-reflux-overlay-store.js';
import { extractRefluxAllChunksFromNormalizedCompareKey } from '../reflux-normalization.js';

const runtimeState = {
  loaded: false,
  loadingPromise: null,
  overlayVersionKey: '',
  overlayUpdatedAt: '',
  overlayActiveCount: 0,
  overlayTitleCount: 0,
  overlayMatchRuntime: createSemiconductorRefluxTitleMatchRuntimeFromNormalizedTitles([]),
  overlayTwoParentIndexState: buildOverlayTwoParentIndexState([]),
  baseTwoParentSnapshot: buildEmptyBundledTwoParentSnapshot(),
  twoParentIndexReady: false,
  twoParentChunkLengths: [...SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.chunkLengths],
};

async function ensureSemiconductorRefluxEffectiveMatcherLoaded() {
  await ensureSemiconductorRefluxTitleSetLoaded();
  await ensureSemiconductorRefluxPostTitleMatcherLoaded();

  if (runtimeState.loaded) {
    return getSemiconductorRefluxEffectiveMatcherStatus();
  }

  await reloadSemiconductorRefluxEffectiveMatcher();
  return getSemiconductorRefluxEffectiveMatcherStatus();
}

async function reloadSemiconductorRefluxEffectiveMatcher() {
  await ensureSemiconductorRefluxTitleSetLoaded();
  await ensureSemiconductorRefluxPostTitleMatcherLoaded();

  if (runtimeState.loadingPromise) {
    await runtimeState.loadingPromise;
  }

  runtimeState.loadingPromise = buildEffectiveMatcherRuntime()
    .finally(() => {
      runtimeState.loadingPromise = null;
    });

  await runtimeState.loadingPromise;
  return getSemiconductorRefluxEffectiveMatcherStatus();
}

function getSemiconductorRefluxEffectiveMatcherStatus() {
  const baseTitleSetStatus = getSemiconductorRefluxTitleSetStatus();
  const baseMatcherStatus = getSemiconductorRefluxPostTitleMatcherStatus();
  const ready = Boolean(baseTitleSetStatus.ready || runtimeState.overlayTitleCount > 0);
  const overlayTwoParentReady = Boolean(runtimeState.overlayTwoParentIndexState?.twoParentIndexReady);

  return {
    loaded: Boolean(runtimeState.loaded || baseTitleSetStatus.loaded || baseMatcherStatus.loaded),
    ready,
    baseTitleSetReady: Boolean(baseTitleSetStatus.ready),
    overlayActiveCount: runtimeState.overlayActiveCount,
    overlayTitleCount: runtimeState.overlayTitleCount,
    overlayUpdatedAt: runtimeState.overlayUpdatedAt,
    overlayVersionKey: runtimeState.overlayVersionKey,
    baseTwoParentIndexReady: Boolean(baseMatcherStatus.twoParentIndexReady),
    overlayTwoParentIndexReady: overlayTwoParentReady,
    twoParentIndexReady: Boolean(runtimeState.twoParentIndexReady),
    twoParentChunkLengths: [...runtimeState.twoParentChunkLengths],
    reason: buildEffectiveMatcherReason(baseTitleSetStatus, baseMatcherStatus, ready),
  };
}

function isSemiconductorRefluxEffectiveMatcherReady() {
  const status = getSemiconductorRefluxEffectiveMatcherStatus();
  return Boolean(status.ready);
}

function hasSemiconductorRefluxEffectivePostTitle(title) {
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  if (!normalizedTitle) {
    return false;
  }

  return hasNormalizedSemiconductorRefluxEffectiveTitle(normalizedTitle);
}

function hasNormalizedSemiconductorRefluxEffectiveTitle(normalizedTitle) {
  const normalizedValue = normalizeSemiconductorRefluxTitle(normalizedTitle);
  if (!normalizedValue) {
    return false;
  }

  if (hasNormalizedSemiconductorRefluxTitle(normalizedValue)) {
    return true;
  }

  if (hasNormalizedSemiconductorRefluxTitleInRuntime(normalizedValue, runtimeState.overlayMatchRuntime)) {
    return true;
  }

  if (runtimeState.baseTwoParentSnapshot.ready && hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedValue)) {
    return true;
  }

  if (
    runtimeState.overlayTwoParentIndexState.twoParentIndexReady
    && hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedValue, runtimeState.overlayTwoParentIndexState)
  ) {
    return true;
  }

  if (
    runtimeState.baseTwoParentSnapshot.ready
    && runtimeState.overlayTwoParentIndexState.twoParentIndexReady
    && hasNormalizedSemiconductorRefluxMixedTwoParentTitle(
      normalizedValue,
      runtimeState.baseTwoParentSnapshot,
      runtimeState.overlayTwoParentIndexState,
      runtimeState.twoParentChunkLengths,
    )
  ) {
    return true;
  }

  return false;
}

async function buildEffectiveMatcherRuntime() {
  const baseSnapshot = normalizeBundledTwoParentSnapshot(getSemiconductorRefluxBundledTwoParentIndexSnapshot());
  const overlayDataset = await loadActiveOverlayDataset();
  const overlayTitles = dedupeNormalizedTitles(
    (Array.isArray(overlayDataset?.titles) ? overlayDataset.titles : [])
      .map((title) => normalizeSemiconductorRefluxTitle(title))
      .filter(Boolean),
  );
  const overlayMatchRuntime = createSemiconductorRefluxTitleMatchRuntimeFromNormalizedTitles(overlayTitles);
  const overlayTwoParentIndexState = buildOverlayTwoParentIndexState(overlayTitles);
  const nextChunkLengths = normalizeChunkLengths([
    ...(Array.isArray(baseSnapshot.chunkLengths) ? baseSnapshot.chunkLengths : []),
    ...(Array.isArray(overlayTwoParentIndexState.twoParentChunkLengths)
      ? overlayTwoParentIndexState.twoParentChunkLengths
      : []),
  ]);
  const nextRuntimeState = {
    loaded: true,
    overlayVersionKey: buildOverlayVersionKey(overlayDataset?.overlays || []),
    overlayUpdatedAt: String(overlayDataset?.updatedAt || '').trim(),
    overlayActiveCount: Array.isArray(overlayDataset?.overlays) ? overlayDataset.overlays.length : 0,
    overlayTitleCount: overlayTitles.length,
    overlayMatchRuntime,
    overlayTwoParentIndexState,
    baseTwoParentSnapshot: baseSnapshot,
    twoParentIndexReady: Boolean(baseSnapshot.ready || overlayTwoParentIndexState.twoParentIndexReady),
    twoParentChunkLengths: nextChunkLengths,
  };

  Object.assign(runtimeState, nextRuntimeState);
}

function buildEffectiveMatcherReason(baseTitleSetStatus, baseMatcherStatus, ready) {
  if (runtimeState.loadingPromise) {
    return '역류기 effective matcher 로딩 중입니다.';
  }

  if (!ready) {
    const baseReason = String(baseMatcherStatus.reason || '').trim();
    if (!baseTitleSetStatus.ready && runtimeState.overlayActiveCount <= 0) {
      return baseReason || '기본 dataset과 overlay가 모두 비어 있습니다.';
    }
    if (runtimeState.overlayActiveCount > 0 && runtimeState.overlayTitleCount <= 0) {
      return 'overlay metadata는 있지만 로드된 제목이 없습니다.';
    }
    return baseReason || '역류기 effective matcher가 준비되지 않았습니다.';
  }

  if (!runtimeState.twoParentIndexReady) {
    const baseReason = String(baseMatcherStatus.reason || '').trim();
    return baseReason || '2-parent matcher를 사용할 수 없어 single-title matcher만 사용합니다.';
  }

  return '';
}

function buildEmptyBundledTwoParentSnapshot() {
  return {
    ready: false,
    datasetVersion: '',
    titleCount: 0,
    bucketCount: 0,
    chunkLengths: [...SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.chunkLengths],
    postingEncoding: '',
    chunkPostingMap: new Map(),
  };
}

function normalizeBundledTwoParentSnapshot(snapshot = {}) {
  return {
    ready: Boolean(snapshot.ready && snapshot.chunkPostingMap instanceof Map && snapshot.chunkPostingMap.size > 0),
    datasetVersion: String(snapshot.datasetVersion || '').trim(),
    titleCount: Math.max(0, Number(snapshot.titleCount) || 0),
    bucketCount: Math.max(0, Number(snapshot.bucketCount) || 0),
    chunkLengths: normalizeChunkLengths(snapshot.chunkLengths),
    postingEncoding: String(snapshot.postingEncoding || '').trim(),
    chunkPostingMap: snapshot.chunkPostingMap instanceof Map
      ? snapshot.chunkPostingMap
      : new Map(),
  };
}

function buildOverlayTwoParentIndexState(titles) {
  const chunkPostingMap = new Map();
  const chunkLengths = [...SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.chunkLengths];

  (Array.isArray(titles) ? titles : []).forEach((title, titleId) => {
    const chunks = extractRefluxAllChunksFromNormalizedCompareKey(
      title,
      {
        chunkLengths,
        minChunkLength: 3,
        minLatinChunkLength: 4,
        minHangulChunkLength: 3,
      },
    );

    for (const chunk of chunks) {
      if (!chunkPostingMap.has(chunk)) {
        chunkPostingMap.set(chunk, []);
      }
      chunkPostingMap.get(chunk).push(titleId);
    }
  });

  return {
    twoParentIndexReady: chunkPostingMap.size > 0,
    twoParentChunkLengths: chunkLengths,
    chunkPostingMap,
  };
}

function hasNormalizedSemiconductorRefluxMixedTwoParentTitle(
  normalizedTitle,
  bundledSnapshot,
  overlayIndexState,
  chunkLengths = SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.chunkLengths,
) {
  const normalizedValue = normalizeSemiconductorRefluxTitle(normalizedTitle);
  if (!normalizedValue) {
    return false;
  }

  const chars = Array.from(normalizedValue);
  if (chars.length < SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minTitleLength) {
    return false;
  }

  const normalizedChunkLengths = normalizeChunkLengths(chunkLengths);
  for (
    let splitIndex = SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideLength;
    splitIndex <= chars.length - SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideLength;
    splitIndex += 1
  ) {
    const leftValue = chars.slice(0, splitIndex).join('');
    const rightValue = chars.slice(splitIndex).join('');
    const leftChunks = extractTwoParentChunks(leftValue, normalizedChunkLengths);
    if (leftChunks.length < SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideMatchCount) {
      continue;
    }

    const rightChunks = extractTwoParentChunks(rightValue, normalizedChunkLengths);
    if (rightChunks.length < SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideMatchCount) {
      continue;
    }

    const leftBaseCounts = countTwoParentCandidateHits(leftChunks, bundledSnapshot.chunkPostingMap);
    const rightBaseCounts = countTwoParentCandidateHits(rightChunks, bundledSnapshot.chunkPostingMap);
    const leftOverlayCounts = countTwoParentCandidateHits(leftChunks, overlayIndexState.chunkPostingMap);
    const rightOverlayCounts = countTwoParentCandidateHits(rightChunks, overlayIndexState.chunkPostingMap);

    if (
      (leftBaseCounts.size <= 0 && leftOverlayCounts.size <= 0)
      || (rightBaseCounts.size <= 0 && rightOverlayCounts.size <= 0)
    ) {
      continue;
    }

    if (
      hasSingleParentDominatingBothSides(leftBaseCounts, rightBaseCounts)
      || hasSingleParentDominatingBothSides(leftOverlayCounts, rightOverlayCounts)
    ) {
      continue;
    }

    const leftNamedCounts = mergeNamedCandidateCounts([
      namespaceCandidateCounts(leftBaseCounts, 'b'),
      namespaceCandidateCounts(leftOverlayCounts, 'o'),
    ]);
    const rightNamedCounts = mergeNamedCandidateCounts([
      namespaceCandidateCounts(rightBaseCounts, 'b'),
      namespaceCandidateCounts(rightOverlayCounts, 'o'),
    ]);
    const leftCandidates = selectTopTwoParentCandidates(leftNamedCounts);
    const rightCandidates = selectTopTwoParentCandidates(rightNamedCounts);

    if (
      leftCandidates.length > 0
      && rightCandidates.length > 0
      && hasMixedTwoParentCandidatePair(leftCandidates, rightCandidates, leftNamedCounts, rightNamedCounts)
    ) {
      return true;
    }
  }

  return false;
}

function extractTwoParentChunks(value, chunkLengths) {
  return extractRefluxAllChunksFromNormalizedCompareKey(
    value,
    {
      chunkLengths,
      minChunkLength: 3,
      minLatinChunkLength: 4,
      minHangulChunkLength: 3,
    },
  );
}

function countTwoParentCandidateHits(chunks, chunkPostingMap) {
  const candidateCounts = new Map();

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const postings = chunkPostingMap instanceof Map
      ? chunkPostingMap.get(chunk)
      : null;
    if (!postings || postings.length <= 0) {
      continue;
    }

    for (let index = 0; index < postings.length; index += 1) {
      const titleId = postings[index];
      candidateCounts.set(titleId, (candidateCounts.get(titleId) || 0) + 1);
    }
  }

  return candidateCounts;
}

function namespaceCandidateCounts(candidateCounts, prefix) {
  const nextCounts = new Map();
  for (const [titleId, count] of candidateCounts.entries()) {
    nextCounts.set(`${prefix}:${titleId}`, count);
  }
  return nextCounts;
}

function mergeNamedCandidateCounts(candidateCountMaps = []) {
  const mergedCounts = new Map();

  for (const candidateCounts of Array.isArray(candidateCountMaps) ? candidateCountMaps : []) {
    for (const [candidateKey, count] of candidateCounts.entries()) {
      mergedCounts.set(candidateKey, (mergedCounts.get(candidateKey) || 0) + count);
    }
  }

  return mergedCounts;
}

function selectTopTwoParentCandidates(candidateCounts) {
  return [...candidateCounts.entries()]
    .filter(([, count]) => count >= SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideMatchCount)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return String(left[0]).localeCompare(String(right[0]), 'ko');
    })
    .slice(0, SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.maxCandidatesPerSide);
}

function hasMixedTwoParentCandidatePair(leftCandidates, rightCandidates, leftCounts, rightCounts) {
  for (const [leftCandidateKey, leftCount] of leftCandidates) {
    if (leftCount < SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideMatchCount) {
      continue;
    }

    for (const [rightCandidateKey, rightCount] of rightCandidates) {
      if (rightCount < SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideMatchCount) {
        continue;
      }

      const leftNamespace = getCandidateNamespace(leftCandidateKey);
      const rightNamespace = getCandidateNamespace(rightCandidateKey);
      if (!leftNamespace || !rightNamespace || leftNamespace === rightNamespace) {
        continue;
      }

      if ((rightCounts.get(leftCandidateKey) || 0) > SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.maxOppositeLeakCount) {
        continue;
      }

      if ((leftCounts.get(rightCandidateKey) || 0) > SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.maxOppositeLeakCount) {
        continue;
      }

      return true;
    }
  }

  return false;
}

function hasSingleParentDominatingBothSides(leftCounts, rightCounts) {
  for (const [candidateKey, leftCount] of leftCounts.entries()) {
    if (leftCount < SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideMatchCount) {
      continue;
    }

    if ((rightCounts.get(candidateKey) || 0) >= SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.minSideMatchCount) {
      return true;
    }
  }

  return false;
}

function getCandidateNamespace(candidateKey) {
  const normalizedKey = String(candidateKey || '').trim();
  if (!normalizedKey.includes(':')) {
    return '';
  }

  return normalizedKey.split(':', 1)[0];
}

function dedupeNormalizedTitles(titles) {
  return [...new Set(
    (Array.isArray(titles) ? titles : [])
      .map((title) => String(title || '').trim())
      .filter(Boolean),
  )];
}

function buildOverlayVersionKey(overlays = []) {
  return sortOverlayMetas(overlays)
    .map((overlayMeta) => `${overlayMeta.overlayId}:${overlayMeta.storageOverlayId}:${overlayMeta.titleCount}`)
    .join('|');
}

function sortOverlayMetas(overlays = []) {
  return [...(Array.isArray(overlays) ? overlays : [])]
    .map((overlayMeta) => ({
      overlayId: String(overlayMeta?.overlayId || '').trim(),
      storageOverlayId: String(overlayMeta?.storageOverlayId || '').trim(),
      titleCount: Math.max(0, Number(overlayMeta?.titleCount) || 0),
    }))
    .filter((overlayMeta) => overlayMeta.overlayId)
    .sort((left, right) => left.overlayId.localeCompare(right.overlayId, 'ko-KR'));
}

function normalizeChunkLengths(chunkLengths) {
  const normalizedChunkLengths = [...new Set(
    (Array.isArray(chunkLengths) ? chunkLengths : [])
      .map((chunkLength) => Math.trunc(Number(chunkLength) || 0))
      .filter((chunkLength) => chunkLength >= 2),
  )].sort((left, right) => left - right);

  return normalizedChunkLengths.length > 0
    ? normalizedChunkLengths
    : [...SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY.chunkLengths];
}

export {
  ensureSemiconductorRefluxEffectiveMatcherLoaded,
  getSemiconductorRefluxEffectiveMatcherStatus,
  hasNormalizedSemiconductorRefluxEffectiveTitle,
  hasSemiconductorRefluxEffectivePostTitle,
  isSemiconductorRefluxEffectiveMatcherReady,
  reloadSemiconductorRefluxEffectiveMatcher,
};
