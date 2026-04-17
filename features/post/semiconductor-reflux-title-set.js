import { normalizeSemiconductorRefluxTitle } from './attack-mode.js';
import {
  buildRefluxContainmentSignatureFromChunks,
  buildRefluxContainmentSignaturesFromNormalizedCompareKey,
  buildRefluxPermutationSignatureFromNormalizedCompareKey,
  isRefluxContainmentChunkEligible,
} from '../reflux-normalization.js';

const STORAGE_KEY = 'semiconductorRefluxTitleSetState';
const PERMUTATION_SIGNATURE_MIN_LENGTH = 7;
const CONTAINMENT_SIGNATURE_MIN_LENGTH = 12;
const CONTAINMENT_CHUNK_MIN_LENGTH = 4;
const CONTAINMENT_LATIN_CHUNK_MIN_LENGTH = 5;
const CONTAINMENT_HANGUL_CHUNK_MIN_LENGTH = 4;
const CONTAINMENT_CHUNK_MAX_LENGTH = 6;
const CONTAINMENT_MAX_COMBINATION_COUNT = 12000;
// 번들 dataset은 모든 관리자에게 같이 배포되는 원본이다.
// 이름이 `reflux-title-set-unified.json`인 이유는,
// 수집 원본(reflux-title-set-<gallery>-<version>.json)과
// 실제 확장이 읽는 최종 통합 배포본을 파일명만 봐도 구분하려는 목적이다.
// 예:
// - 배포본 version = 2026-04-05-v1
// - 관리자 로컬 cache version = 2026-04-05-v0
// 이 경우 새 배포본이 로컬 cache를 자동으로 덮어쓴다.
//
// 중요:
// dataset 제목을 수정했다면 JSON 안의 `version`도 반드시 같이 올려야 한다.
// version이 그대로면 "같은 dataset"으로 간주해서 기존 cache를 유지할 수 있다.
//
// 또한 통합 dataset이 커지면 GitHub 100MB 제한에 걸릴 수 있어서,
// 지금 배포본은 작은 manifest 1개 + 여러 shard JSON 파일로 쪼개질 수 있다.
// 로더는 이 manifest를 읽고 shard 파일들을 이어서 읽어 최종 Set을 만든다.
const BUNDLED_DATASET_PATH = 'data/reflux-title-set-unified.json';

const runtimeState = {
  loaded: false,
  titleSet: new Set(),
  permutationSignatureSet: new Set(),
  containmentSignatureSet: new Set(),
  titleCount: 0,
  sourceTitleCount: 0,
  permutationSignatureCount: 0,
  containmentSignatureCount: 0,
  updatedAt: '',
  sourceGalleryId: '',
  sourceGalleryIds: [],
  version: '',
  sourceType: '',
};

async function ensureSemiconductorRefluxTitleSetLoaded() {
  if (runtimeState.loaded) {
    return getSemiconductorRefluxTitleSetStatus();
  }

  const bundledState = await loadBundledSemiconductorRefluxTitleSetState();
  const storedState = await loadStoredSemiconductorRefluxTitleSetState();
  const shouldUseBundledState = shouldHydrateBundledState(storedState, bundledState);
  const nextState = shouldUseBundledState
    ? bundledState
    : normalizeSemiconductorRefluxTitleSetState(storedState);

  hydrateSemiconductorRefluxTitleSetState(nextState, {
    titlesArePreNormalized: shouldUseBundledState,
  });

  if (shouldUseBundledState && bundledState) {
    await saveNormalizedSemiconductorRefluxTitleSetState(bundledState);
  }

  return getSemiconductorRefluxTitleSetStatus();
}

async function loadStoredSemiconductorRefluxTitleSetState() {
  try {
    const { [STORAGE_KEY]: storedState } = await chrome.storage.local.get(STORAGE_KEY);
    return storedState || null;
  } catch (error) {
    console.error('[SemiconductorRefluxTitleSet] 상태 복원 실패:', error.message);
    return null;
  }
}

async function loadBundledSemiconductorRefluxTitleSetState() {
  try {
    const datasetJson = await readBundledDatasetJson(BUNDLED_DATASET_PATH);
    if (Array.isArray(datasetJson?.titles)) {
      return normalizeSemiconductorRefluxTitleSetState({
        ...datasetJson,
        sourceType: 'bundled',
      });
    }

    const manifest = normalizeBundledSemiconductorRefluxManifest(datasetJson);
    const titles = await loadBundledSemiconductorRefluxShardTitles(manifest.shards);
    return {
      titles,
      titleCount: titles.length,
      updatedAt: manifest.updatedAt,
      sourceGalleryId: manifest.sourceGalleryIds[0] || '',
      sourceGalleryIds: manifest.sourceGalleryIds,
      version: manifest.version,
      sourceType: 'bundled',
    };
  } catch (error) {
    console.warn('[SemiconductorRefluxTitleSet] 번들 dataset 로드 실패:', error.message);
    return null;
  }
}

function shouldHydrateBundledState(storedState, bundledState) {
  // 번들 manifest/shard를 읽을 수 있으면 그쪽이 항상 source-of-truth다.
  // 반대로 번들 로드가 실패하면, 남아 있는 storage 상태(예: 수동 주입 dataset)로 fallback 해야 한다.
  return Boolean(bundledState);
}

function normalizeSemiconductorRefluxTitleSetState(storedState) {
  const normalizedTitles = dedupeNormalizedTitles(storedState?.titles || []);
  const sourceTitleCount = normalizeTitleCount(storedState?.sourceTitleCount ?? storedState?.titleCount);
  const sourceGalleryIds = normalizeSourceGalleryIds(storedState);
  const titleCount = normalizedTitles.length > 0
    ? normalizedTitles.length
    : sourceTitleCount;
  return {
    titles: normalizedTitles,
    titleCount,
    sourceTitleCount: sourceTitleCount > 0 ? sourceTitleCount : titleCount,
    updatedAt: String(storedState?.updatedAt || '').trim(),
    sourceGalleryId: sourceGalleryIds[0] || '',
    sourceGalleryIds,
    version: String(storedState?.version || '').trim(),
    sourceType: String(storedState?.sourceType || '').trim(),
  };
}

function normalizePreNormalizedSemiconductorRefluxTitleSetState(storedState) {
  const normalizedTitles = dedupePreNormalizedTitles(storedState?.titles || []);
  const sourceTitleCount = normalizeTitleCount(storedState?.sourceTitleCount ?? storedState?.titleCount);
  const sourceGalleryIds = normalizeSourceGalleryIds(storedState);
  const titleCount = normalizedTitles.length > 0
    ? normalizedTitles.length
    : sourceTitleCount;
  return {
    titles: normalizedTitles,
    titleCount,
    sourceTitleCount: sourceTitleCount > 0 ? sourceTitleCount : titleCount,
    updatedAt: String(storedState?.updatedAt || '').trim(),
    sourceGalleryId: sourceGalleryIds[0] || '',
    sourceGalleryIds,
    version: String(storedState?.version || '').trim(),
    sourceType: String(storedState?.sourceType || '').trim(),
  };
}

function hydrateSemiconductorRefluxTitleSetState(storedState, options = {}) {
  const normalizedState = options.titlesArePreNormalized
    ? normalizePreNormalizedSemiconductorRefluxTitleSetState(storedState)
    : normalizeSemiconductorRefluxTitleSetState(storedState);
  const normalizedTitles = normalizedState.titles;
  const matchRuntime = createSemiconductorRefluxTitleMatchRuntimeFromNormalizedTitles(normalizedTitles);
  runtimeState.loaded = true;
  runtimeState.titleSet = matchRuntime.titleSet;
  runtimeState.permutationSignatureSet = matchRuntime.permutationSignatureSet;
  runtimeState.containmentSignatureSet = matchRuntime.containmentSignatureSet;
  runtimeState.titleCount = normalizedTitles.length > 0
    ? normalizedTitles.length
    : normalizeTitleCount(normalizedState.titleCount);
  runtimeState.sourceTitleCount = normalizeTitleCount(normalizedState.sourceTitleCount) > 0
    ? normalizeTitleCount(normalizedState.sourceTitleCount)
    : runtimeState.titleCount;
  runtimeState.permutationSignatureCount = matchRuntime.permutationSignatureSet.size;
  runtimeState.containmentSignatureCount = matchRuntime.containmentSignatureSet.size;
  runtimeState.updatedAt = normalizedState.updatedAt;
  runtimeState.sourceGalleryId = normalizedState.sourceGalleryId;
  runtimeState.sourceGalleryIds = normalizedState.sourceGalleryIds;
  runtimeState.version = normalizedState.version;
  runtimeState.sourceType = normalizedState.sourceType;
}

function getSemiconductorRefluxTitleSetStatus() {
  return {
    loaded: runtimeState.loaded,
    ready: isSemiconductorRefluxTitleSetReady(),
    titleCount: runtimeState.titleCount,
    sourceTitleCount: runtimeState.sourceTitleCount,
    permutationSignatureCount: runtimeState.permutationSignatureCount,
    containmentSignatureCount: runtimeState.containmentSignatureCount,
    updatedAt: runtimeState.updatedAt,
    sourceGalleryId: runtimeState.sourceGalleryId,
    sourceGalleryIds: [...runtimeState.sourceGalleryIds],
    version: runtimeState.version,
    sourceType: runtimeState.sourceType,
  };
}

function isSemiconductorRefluxTitleSetReady() {
  return runtimeState.loaded && runtimeState.titleSet.size > 0;
}

function hasSemiconductorRefluxTitle(title) {
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  if (!normalizedTitle) {
    return false;
  }

  return hasNormalizedSemiconductorRefluxTitle(normalizedTitle);
}

function hasNormalizedSemiconductorRefluxTitle(normalizedTitle) {
  return hasNormalizedSemiconductorRefluxTitleInRuntime(normalizedTitle, runtimeState);
}

function hasNormalizedSemiconductorRefluxTitleInRuntime(normalizedTitle, matchRuntime = runtimeState) {
  const normalizedValue = normalizeSemiconductorRefluxTitle(normalizedTitle);
  if (!normalizedValue) {
    return false;
  }

  if (matchRuntime?.titleSet instanceof Set && matchRuntime.titleSet.has(normalizedValue)) {
    return true;
  }

  // exact miss일 때만 "순서무시 signature"를 본다.
  // 7글자 이상 긴 문구만 대상으로 해서 짧은 문구 오탐을 줄인다.
  const permutationSignature = buildRefluxPermutationSignatureFromNormalizedCompareKey(
    normalizedValue,
    { minLength: PERMUTATION_SIGNATURE_MIN_LENGTH },
  );
  if (!permutationSignature) {
    return hasNormalizedSemiconductorRefluxContainmentTitleInRuntime(normalizedValue, matchRuntime);
  }

  if (
    matchRuntime?.permutationSignatureSet instanceof Set
    && matchRuntime.permutationSignatureSet.has(permutationSignature)
  ) {
    return true;
  }

  return hasNormalizedSemiconductorRefluxContainmentTitleInRuntime(normalizedValue, matchRuntime);
}

async function replaceSemiconductorRefluxTitleSet(titles, options = {}) {
  // 이 경로는 수동/로컬 dataset 주입용이다.
  // 다만 다음 배포에서 bundled dataset version이 바뀌면, 그 배포본이 다시 source-of-truth로 덮어쓴다.
  const storedState = normalizeSemiconductorRefluxTitleSetState({
    titles,
    updatedAt: String(options?.updatedAt || new Date().toISOString()),
    sourceGalleryId: String(options?.sourceGalleryId || '').trim(),
    sourceGalleryIds: Array.isArray(options?.sourceGalleryIds) ? options.sourceGalleryIds : undefined,
    version: String(options?.version || '').trim(),
    sourceType: String(options?.sourceType || 'manual').trim(),
  });

  hydrateSemiconductorRefluxTitleSetState(storedState);
  await saveNormalizedSemiconductorRefluxTitleSetState(storedState);

  return getSemiconductorRefluxTitleSetStatus();
}

async function saveNormalizedSemiconductorRefluxTitleSetState(storedState) {
  const normalizedState = normalizeSemiconductorRefluxTitleSetState(storedState);
  const storageState = normalizedState.sourceType === 'bundled'
    ? {
      titles: [],
      titleCount: normalizedState.titleCount,
      sourceTitleCount: normalizedState.sourceTitleCount,
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

function dedupeNormalizedTitles(titles) {
  return [...new Set(
    (Array.isArray(titles) ? titles : [])
      .map((title) => normalizeSemiconductorRefluxTitle(title))
      .filter(Boolean),
  )];
}

function dedupePreNormalizedTitles(titles) {
  return [...new Set(
    (Array.isArray(titles) ? titles : [])
      .map((title) => normalizeSemiconductorRefluxTitle(title))
      .filter(Boolean),
  )];
}

function createSemiconductorRefluxTitleMatchRuntimeFromNormalizedTitles(titles) {
  const normalizedTitles = dedupePreNormalizedTitles(titles);
  const permutationSignatureSet = buildPermutationSignatureSet(normalizedTitles);
  const containmentSignatureSet = buildContainmentSignatureSet(normalizedTitles);
  return {
    titleSet: new Set(normalizedTitles),
    permutationSignatureSet,
    containmentSignatureSet,
    titleCount: normalizedTitles.length,
  };
}

function buildPermutationSignatureSet(titles) {
  const permutationSignatures = new Set();

  for (const title of Array.isArray(titles) ? titles : []) {
    const permutationSignature = buildRefluxPermutationSignatureFromNormalizedCompareKey(
      title,
      { minLength: PERMUTATION_SIGNATURE_MIN_LENGTH },
    );
    if (!permutationSignature) {
      continue;
    }

    permutationSignatures.add(permutationSignature);
  }

  return permutationSignatures;
}

function buildContainmentSignatureSet(titles) {
  const containmentSignatures = new Set();

  for (const title of Array.isArray(titles) ? titles : []) {
    const signatures = buildRefluxContainmentSignaturesFromNormalizedCompareKey(
      title,
      {
        minLength: CONTAINMENT_SIGNATURE_MIN_LENGTH,
        minChunkLength: CONTAINMENT_CHUNK_MIN_LENGTH,
        minLatinChunkLength: CONTAINMENT_LATIN_CHUNK_MIN_LENGTH,
        minHangulChunkLength: CONTAINMENT_HANGUL_CHUNK_MIN_LENGTH,
        maxChunkLength: CONTAINMENT_CHUNK_MAX_LENGTH,
      },
    );
    for (const signature of signatures) {
      containmentSignatures.add(signature);
    }
  }

  return containmentSignatures;
}

function hasNormalizedSemiconductorRefluxContainmentTitle(normalizedTitle) {
  return hasNormalizedSemiconductorRefluxContainmentTitleInRuntime(normalizedTitle, runtimeState);
}

function hasNormalizedSemiconductorRefluxContainmentTitleInRuntime(normalizedTitle, matchRuntime = runtimeState) {
  if (!(matchRuntime?.containmentSignatureSet instanceof Set) || matchRuntime.containmentSignatureSet.size <= 0) {
    return false;
  }

  const chars = Array.from(String(normalizedTitle || '').trim());
  if (chars.length < CONTAINMENT_SIGNATURE_MIN_LENGTH) {
    return false;
  }

  const maxChunkLength = Math.min(
    CONTAINMENT_CHUNK_MAX_LENGTH,
    Math.floor(chars.length / 3),
  );
  if (maxChunkLength < CONTAINMENT_CHUNK_MIN_LENGTH) {
    return false;
  }

  let combinationCount = 0;
  for (let chunkLength = maxChunkLength; chunkLength >= CONTAINMENT_CHUNK_MIN_LENGTH; chunkLength -= 1) {
    const substrings = extractUniqueContainmentSubstrings(chars, chunkLength);
    if (substrings.length < 3) {
      continue;
    }

    for (let firstIndex = 0; firstIndex < substrings.length - 2; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < substrings.length - 1; secondIndex += 1) {
        for (let thirdIndex = secondIndex + 1; thirdIndex < substrings.length; thirdIndex += 1) {
          const signature = buildRefluxContainmentSignatureFromChunks(
            [
              substrings[firstIndex],
              substrings[secondIndex],
              substrings[thirdIndex],
            ],
            {
              chunkLength,
              minChunkLength: CONTAINMENT_CHUNK_MIN_LENGTH,
              minLatinChunkLength: CONTAINMENT_LATIN_CHUNK_MIN_LENGTH,
              minHangulChunkLength: CONTAINMENT_HANGUL_CHUNK_MIN_LENGTH,
            },
          );
          combinationCount += 1;
          if (signature && matchRuntime.containmentSignatureSet.has(signature)) {
            return true;
          }
          if (combinationCount >= CONTAINMENT_MAX_COMBINATION_COUNT) {
            return false;
          }
        }
      }
    }
  }

  return false;
}

function extractUniqueContainmentSubstrings(chars, chunkLength) {
  const substrings = [];
  const seen = new Set();

  for (let start = 0; start <= chars.length - chunkLength; start += 1) {
    const chunk = chars.slice(start, start + chunkLength).join('');
    if (
      !isRefluxContainmentChunkEligible(
        chunk,
        {
          minChunkLength: CONTAINMENT_CHUNK_MIN_LENGTH,
          minLatinChunkLength: CONTAINMENT_LATIN_CHUNK_MIN_LENGTH,
          minHangulChunkLength: CONTAINMENT_HANGUL_CHUNK_MIN_LENGTH,
        },
      )
      || seen.has(chunk)
    ) {
      continue;
    }

    seen.add(chunk);
    substrings.push(chunk);
  }

  return substrings;
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

function normalizeTitleCount(value) {
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

function normalizeBundledSemiconductorRefluxManifest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('번들 dataset manifest 형식이 올바르지 않습니다.');
  }

  const sourceGalleryIds = normalizeSourceGalleryIds(payload);
  const shards = (Array.isArray(payload?.shards) ? payload.shards : [])
    .map((shard, index) => {
      const shardPath = String(shard?.path || '').trim();
      if (!shardPath) {
        throw new Error(`번들 dataset shard 경로가 비어 있습니다. (index=${index})`);
      }
      return {
        path: shardPath,
        titleCount: normalizeTitleCount(shard?.titleCount),
      };
    });

  if (shards.length === 0) {
    throw new Error('번들 dataset shard 목록이 비어 있습니다.');
  }

  return {
    updatedAt: String(payload?.updatedAt || '').trim(),
    sourceGalleryIds,
    version: String(payload?.version || '').trim(),
    titleCount: normalizeTitleCount(payload?.titleCount),
    shards,
  };
}

async function loadBundledSemiconductorRefluxShardTitles(shards) {
  const titles = [];

  for (const shard of Array.isArray(shards) ? shards : []) {
    const shardJson = await readBundledDatasetJson(shard.path);
    const shardTitles = Array.isArray(shardJson?.titles)
      ? shardJson.titles
      : Array.isArray(shardJson)
        ? shardJson
        : [];

    for (const title of shardTitles) {
      const normalizedTitle = String(title || '').trim();
      if (normalizedTitle) {
        titles.push(normalizedTitle);
      }
    }
  }

  return titles;
}

export {
  createSemiconductorRefluxTitleMatchRuntimeFromNormalizedTitles,
  ensureSemiconductorRefluxTitleSetLoaded,
  getSemiconductorRefluxTitleSetStatus,
  hasNormalizedSemiconductorRefluxContainmentTitleInRuntime,
  hasNormalizedSemiconductorRefluxTitleInRuntime,
  hasNormalizedSemiconductorRefluxTitle,
  hasSemiconductorRefluxTitle,
  isSemiconductorRefluxTitleSetReady,
  replaceSemiconductorRefluxTitleSet,
};
