import { normalizeSemiconductorRefluxTitle } from './attack-mode.js';

const STORAGE_KEY = 'semiconductorRefluxTitleSetState';
// 번들 dataset은 모든 관리자에게 같이 배포되는 원본이다.
// 예:
// - 배포본 version = 2026-04-05-v1
// - 관리자 로컬 cache version = 2026-04-05-v0
// 이 경우 새 배포본이 로컬 cache를 자동으로 덮어쓴다.
//
// 중요:
// dataset 제목을 수정했다면 JSON 안의 `version`도 반드시 같이 올려야 한다.
// version이 그대로면 "같은 dataset"으로 간주해서 기존 cache를 유지할 수 있다.
const BUNDLED_DATASET_PATH = 'data/semiconductor-reflux-title-set.json';

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

  hydrateSemiconductorRefluxTitleSetState(nextState);

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
    const datasetUrl = chrome.runtime?.getURL
      ? chrome.runtime.getURL(BUNDLED_DATASET_PATH)
      : BUNDLED_DATASET_PATH;
    const response = await fetch(datasetUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const datasetJson = await response.json();
    return normalizeSemiconductorRefluxTitleSetState({
      ...datasetJson,
      sourceType: 'bundled',
    });
  } catch (error) {
    console.warn('[SemiconductorRefluxTitleSet] 번들 dataset 로드 실패:', error.message);
    return null;
  }
}

function shouldHydrateBundledState(storedState, bundledState) {
  if (!bundledState) {
    return false;
  }

  const normalizedStoredState = normalizeSemiconductorRefluxTitleSetState(storedState);
  // 번들 dataset이 source-of-truth다.
  // 즉:
  // 1. storage에 아직 bundled dataset이 없거나
  // 2. storage version이 새 번들 version과 다르면
  // 항상 번들 쪽을 다시 hydration 한다.
  //
  // 예:
  // - storage: sourceType=manual, version=manual-v1
  // - bundle:  sourceType=bundled, version=2026-04-06-v2
  // 결과: bundle이 storage를 덮어쓴다.
  //
  // 반대로 version이 같으면 같은 배포 dataset으로 보고 기존 cache를 유지한다.
  return normalizedStoredState.sourceType !== 'bundled'
    || normalizedStoredState.version !== bundledState.version;
}

function normalizeSemiconductorRefluxTitleSetState(storedState) {
  const normalizedTitles = dedupeNormalizedTitles(storedState?.titles || []);
  const sourceGalleryIds = normalizeSourceGalleryIds(storedState);
  return {
    titles: normalizedTitles,
    updatedAt: String(storedState?.updatedAt || '').trim(),
    sourceGalleryId: sourceGalleryIds[0] || '',
    sourceGalleryIds,
    version: String(storedState?.version || '').trim(),
    sourceType: String(storedState?.sourceType || '').trim(),
  };
}

function hydrateSemiconductorRefluxTitleSetState(storedState) {
  const normalizedState = normalizeSemiconductorRefluxTitleSetState(storedState);
  const normalizedTitles = normalizedState.titles;
  runtimeState.loaded = true;
  runtimeState.titleSet = new Set(normalizedTitles);
  runtimeState.titleCount = normalizedTitles.length;
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
  return runtimeState.loaded && runtimeState.titleCount > 0;
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
  await chrome.storage.local.set({
    [STORAGE_KEY]: normalizeSemiconductorRefluxTitleSetState(storedState),
  });
}

function dedupeNormalizedTitles(titles) {
  return [...new Set(
    (Array.isArray(titles) ? titles : [])
      .map((title) => normalizeSemiconductorRefluxTitle(title))
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

export {
  ensureSemiconductorRefluxTitleSetLoaded,
  getSemiconductorRefluxTitleSetStatus,
  hasSemiconductorRefluxTitle,
  isSemiconductorRefluxTitleSetReady,
  replaceSemiconductorRefluxTitleSet,
};
