import { normalizeSemiconductorRefluxTitle } from './attack-mode.js';

const STORAGE_KEY = 'semiconductorRefluxTitleSetState';
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
  titleCount: 0,
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
  if (bundledState) {
    return true;
  }

  const normalizedStoredState = normalizeSemiconductorRefluxTitleSetState(storedState);
  return normalizedStoredState.sourceType !== 'bundled' && normalizedStoredState.titles.length > 0;
}

function normalizeSemiconductorRefluxTitleSetState(storedState) {
  const normalizedTitles = dedupeNormalizedTitles(storedState?.titles || []);
  const sourceGalleryIds = normalizeSourceGalleryIds(storedState);
  const titleCount = normalizedTitles.length > 0
    ? normalizedTitles.length
    : normalizeTitleCount(storedState?.titleCount);
  return {
    titles: normalizedTitles,
    titleCount,
    updatedAt: String(storedState?.updatedAt || '').trim(),
    sourceGalleryId: sourceGalleryIds[0] || '',
    sourceGalleryIds,
    version: String(storedState?.version || '').trim(),
    sourceType: String(storedState?.sourceType || '').trim(),
  };
}

function normalizePreNormalizedSemiconductorRefluxTitleSetState(storedState) {
  const normalizedTitles = dedupePreNormalizedTitles(storedState?.titles || []);
  const sourceGalleryIds = normalizeSourceGalleryIds(storedState);
  const titleCount = normalizedTitles.length > 0
    ? normalizedTitles.length
    : normalizeTitleCount(storedState?.titleCount);
  return {
    titles: normalizedTitles,
    titleCount,
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
  runtimeState.loaded = true;
  runtimeState.titleSet = new Set(normalizedTitles);
  runtimeState.titleCount = normalizedTitles.length > 0
    ? normalizedTitles.length
    : normalizeTitleCount(normalizedState.titleCount);
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

  return runtimeState.titleSet.has(normalizedTitle);
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
      .map((title) => String(title || '').trim())
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
  ensureSemiconductorRefluxTitleSetLoaded,
  getSemiconductorRefluxTitleSetStatus,
  hasSemiconductorRefluxTitle,
  isSemiconductorRefluxTitleSetReady,
  replaceSemiconductorRefluxTitleSet,
};
