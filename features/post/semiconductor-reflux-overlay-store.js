const STORAGE_KEY = 'semiconductorRefluxOverlayMetaState';
const DB_NAME = 'semiconductorRefluxOverlayDb';
const DB_VERSION = 1;
const OVERLAYS_STORE_NAME = 'overlays';
const TITLES_STORE_NAME = 'titles';
const STORAGE_OVERLAY_ID_INDEX = 'storageOverlayId';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OVERLAYS_STORE_NAME)) {
        db.createObjectStore(OVERLAYS_STORE_NAME, {
          keyPath: 'storageOverlayId',
        });
      }

      if (!db.objectStoreNames.contains(TITLES_STORE_NAME)) {
        const store = db.createObjectStore(TITLES_STORE_NAME, {
          keyPath: 'key',
        });
        store.createIndex(STORAGE_OVERLAY_ID_INDEX, 'storageOverlayId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('overlay IndexedDB 열기 실패'));
  });
}

async function saveOverlay(overlayMeta = {}, normalizedTitles = []) {
  const nextMeta = normalizeOverlayMeta(overlayMeta);
  if (!nextMeta.overlayId) {
    throw new Error('overlayId가 비어 있습니다.');
  }

  const dedupedTitles = dedupeNormalizedTitles(normalizedTitles);
  const currentState = await readOverlayMetaState();
  const existingMeta = currentState.overlays.find((entry) => entry.overlayId === nextMeta.overlayId) || null;
  const storageOverlayId = buildStorageOverlayId(nextMeta.overlayId, nextMeta.createdAt);
  const persistedMeta = normalizeOverlayMeta({
    ...existingMeta,
    ...nextMeta,
    storageOverlayId,
    titleCount: dedupedTitles.length,
    active: true,
  });

  await writeOverlayStorageEntry(storageOverlayId, persistedMeta.overlayId, dedupedTitles);

  const nextMetas = [
    persistedMeta,
    ...currentState.overlays.filter((entry) => entry.overlayId !== persistedMeta.overlayId),
  ];
  await writeOverlayMetaState({
    overlays: nextMetas,
    updatedAt: new Date().toISOString(),
  });

  if (existingMeta?.storageOverlayId && existingMeta.storageOverlayId !== storageOverlayId) {
    try {
      await deleteStorageOverlayEntry(existingMeta.storageOverlayId);
    } catch (error) {
      console.warn('[SemiconductorRefluxOverlayStore] 이전 overlay storage 정리 실패:', error.message);
    }
  }

  try {
    await reconcileOverlayStorageState();
  } catch (error) {
    console.warn('[SemiconductorRefluxOverlayStore] overlay reconcile 지연:', error.message);
  }
  return persistedMeta;
}

async function listOverlayMetas() {
  const { overlays } = await reconcileOverlayStorageState();
  return overlays;
}

async function loadActiveOverlayDataset() {
  const { overlays, updatedAt } = await reconcileOverlayStorageState();
  const activeOverlays = overlays.filter((entry) => entry.active !== false && entry.storageOverlayId);
  const titleSet = new Set();

  for (const overlayMeta of activeOverlays) {
    const titles = await loadTitlesByStorageOverlayId(overlayMeta.storageOverlayId);
    for (const title of titles) {
      titleSet.add(title);
    }
  }

  return {
    overlays: activeOverlays,
    titles: [...titleSet].sort((left, right) => left.localeCompare(right, 'ko-KR')),
    updatedAt,
  };
}

async function deleteOverlay(overlayId) {
  const normalizedOverlayId = String(overlayId || '').trim();
  if (!normalizedOverlayId) {
    return false;
  }

  const currentState = await readOverlayMetaState();
  const existingMeta = currentState.overlays.find((entry) => entry.overlayId === normalizedOverlayId) || null;
  if (!existingMeta) {
    await reconcileOverlayStorageState();
    return false;
  }

  if (existingMeta.storageOverlayId) {
    await deleteStorageOverlayEntry(existingMeta.storageOverlayId);
  }

  await writeOverlayMetaState({
    overlays: currentState.overlays.filter((entry) => entry.overlayId !== normalizedOverlayId),
    updatedAt: new Date().toISOString(),
  });

  await reconcileOverlayStorageState();
  return true;
}

async function clearAllOverlays() {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([OVERLAYS_STORE_NAME, TITLES_STORE_NAME], 'readwrite');
      transaction.objectStore(OVERLAYS_STORE_NAME).clear();
      transaction.objectStore(TITLES_STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('overlay 전체 삭제 실패'));
      transaction.onabort = () => reject(transaction.error || new Error('overlay 전체 삭제 abort'));
    });
  } finally {
    db.close();
  }

  await writeOverlayMetaState({
    overlays: [],
    updatedAt: new Date().toISOString(),
  });
}

async function reconcileOverlayStorageState() {
  const currentState = await readOverlayMetaState();
  const dbStorageOverlayIds = await listPersistedStorageOverlayIds();
  const referencedStorageOverlayIds = new Set();
  const nextOverlays = [];

  for (const overlayMeta of currentState.overlays) {
    const normalizedMeta = normalizeOverlayMeta(overlayMeta);
    if (!normalizedMeta.overlayId || !normalizedMeta.storageOverlayId) {
      continue;
    }

    if (!dbStorageOverlayIds.has(normalizedMeta.storageOverlayId)) {
      continue;
    }

    if (referencedStorageOverlayIds.has(normalizedMeta.storageOverlayId)) {
      continue;
    }

    referencedStorageOverlayIds.add(normalizedMeta.storageOverlayId);
    nextOverlays.push(normalizedMeta);
  }

  const orphanStorageOverlayIds = [...dbStorageOverlayIds].filter(
    (storageOverlayId) => !referencedStorageOverlayIds.has(storageOverlayId),
  );
  for (const orphanStorageOverlayId of orphanStorageOverlayIds) {
    await deleteStorageOverlayEntry(orphanStorageOverlayId);
  }

  const sortedOverlays = sortOverlayMetas(nextOverlays);
  const metadataChanged = hasOverlayMetaStateChanged(currentState.overlays, sortedOverlays);
  const shouldPersist = metadataChanged || orphanStorageOverlayIds.length > 0;
  const normalizedUpdatedAt = shouldPersist
    ? new Date().toISOString()
    : normalizeIsoString(currentState.updatedAt);

  if (shouldPersist) {
    await writeOverlayMetaState({
      overlays: sortedOverlays,
      updatedAt: normalizedUpdatedAt,
    });
  }

  return {
    overlays: sortedOverlays,
    updatedAt: normalizedUpdatedAt,
  };
}

async function writeOverlayStorageEntry(storageOverlayId, overlayId, titles) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([OVERLAYS_STORE_NAME, TITLES_STORE_NAME], 'readwrite');
      const overlayStore = transaction.objectStore(OVERLAYS_STORE_NAME);
      const titleStore = transaction.objectStore(TITLES_STORE_NAME);

      overlayStore.put({
        storageOverlayId,
        overlayId,
        createdAt: new Date().toISOString(),
      });

      for (const title of Array.isArray(titles) ? titles : []) {
        titleStore.put({
          key: `${storageOverlayId}::${title}`,
          storageOverlayId,
          overlayId,
          title,
        });
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('overlay 저장 실패'));
      transaction.onabort = () => reject(transaction.error || new Error('overlay 저장 abort'));
    });
  } finally {
    db.close();
  }
}

async function deleteStorageOverlayEntry(storageOverlayId) {
  const normalizedStorageOverlayId = String(storageOverlayId || '').trim();
  if (!normalizedStorageOverlayId) {
    return;
  }

  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction([OVERLAYS_STORE_NAME, TITLES_STORE_NAME], 'readwrite');
      const overlayStore = transaction.objectStore(OVERLAYS_STORE_NAME);
      const titleStore = transaction.objectStore(TITLES_STORE_NAME);
      const titleIndex = titleStore.index(STORAGE_OVERLAY_ID_INDEX);

      overlayStore.delete(normalizedStorageOverlayId);
      const request = titleIndex.openCursor(IDBKeyRange.only(normalizedStorageOverlayId));
      request.onerror = () => reject(request.error || new Error('overlay title 삭제 실패'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          return;
        }
        cursor.delete();
        cursor.continue();
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('overlay 삭제 실패'));
      transaction.onabort = () => reject(transaction.error || new Error('overlay 삭제 abort'));
    });
  } finally {
    db.close();
  }
}

async function listPersistedStorageOverlayIds() {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(OVERLAYS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(OVERLAYS_STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const ids = new Set(
          (Array.isArray(request.result) ? request.result : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean),
        );
        resolve(ids);
      };
      request.onerror = () => reject(request.error || new Error('overlay key 조회 실패'));
    });
  } finally {
    db.close();
  }
}

async function loadTitlesByStorageOverlayId(storageOverlayId) {
  const normalizedStorageOverlayId = String(storageOverlayId || '').trim();
  if (!normalizedStorageOverlayId) {
    return [];
  }

  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(TITLES_STORE_NAME, 'readonly');
      const store = transaction.objectStore(TITLES_STORE_NAME);
      const index = store.index(STORAGE_OVERLAY_ID_INDEX);
      const request = index.getAll(normalizedStorageOverlayId);
      request.onsuccess = () => {
        const titles = dedupeNormalizedTitles(
          (Array.isArray(request.result) ? request.result : [])
            .map((entry) => String(entry?.title || '').trim()),
        );
        resolve(titles);
      };
      request.onerror = () => reject(request.error || new Error('overlay title 조회 실패'));
    });
  } finally {
    db.close();
  }
}

async function readOverlayMetaState() {
  try {
    const { [STORAGE_KEY]: storedState } = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeOverlayMetaState(storedState);
  } catch (error) {
    console.error('[SemiconductorRefluxOverlayStore] metadata 로드 실패:', error.message);
    return {
      overlays: [],
      updatedAt: '',
    };
  }
}

async function writeOverlayMetaState(nextState = {}) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: normalizeOverlayMetaState(nextState),
  });
}

function normalizeOverlayMetaState(value) {
  return {
    overlays: sortOverlayMetas(Array.isArray(value?.overlays) ? value.overlays : []),
    updatedAt: normalizeIsoString(value?.updatedAt),
  };
}

function normalizeOverlayMeta(value = {}) {
  return {
    overlayId: String(value?.overlayId || '').trim(),
    storageOverlayId: String(value?.storageOverlayId || '').trim(),
    galleryId: String(value?.galleryId || '').trim(),
    anchorPostNo: normalizePositiveInteger(value?.anchorPostNo, 0),
    anchorPage: normalizePositiveInteger(value?.anchorPage, 0),
    startPage: normalizePositiveInteger(value?.startPage, 0),
    endPage: normalizePositiveInteger(value?.endPage, 0),
    pageCount: normalizePositiveInteger(value?.pageCount, 0),
    completedPageCount: normalizePositiveInteger(value?.completedPageCount, 0),
    failedPages: normalizePageList(value?.failedPages),
    titleCount: normalizePositiveInteger(value?.titleCount, 0),
    createdAt: normalizeIsoString(value?.createdAt) || new Date().toISOString(),
    sourceType: String(value?.sourceType || 'window_overlay').trim() || 'window_overlay',
    active: value?.active !== false,
  };
}

function normalizePageList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((page) => normalizePositiveInteger(page, 0))
      .filter((page) => page > 0),
  )].sort((left, right) => left - right);
}

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.max(0, Number.parseInt(String(fallback ?? 0), 10) || 0);
  }

  return parsed;
}

function normalizeIsoString(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return '';
  }

  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString();
}

function dedupeNormalizedTitles(titles) {
  return [...new Set(
    (Array.isArray(titles) ? titles : [])
      .map((title) => String(title || '').trim())
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right, 'ko-KR'));
}

function sortOverlayMetas(overlays) {
  return [...new Map(
    (Array.isArray(overlays) ? overlays : [])
      .map((overlayMeta) => normalizeOverlayMeta(overlayMeta))
      .filter((overlayMeta) => overlayMeta.overlayId)
      .map((overlayMeta) => [overlayMeta.overlayId, overlayMeta]),
  ).values()].sort((left, right) => {
    const rightTime = Date.parse(right.createdAt) || 0;
    const leftTime = Date.parse(left.createdAt) || 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return left.overlayId.localeCompare(right.overlayId, 'ko-KR');
  });
}

function hasOverlayMetaStateChanged(previousOverlays = [], nextOverlays = []) {
  return JSON.stringify(sortOverlayMetas(previousOverlays)) !== JSON.stringify(sortOverlayMetas(nextOverlays));
}

function buildStorageOverlayId(overlayId, createdAt) {
  const normalizedOverlayId = String(overlayId || '').trim();
  const normalizedCreatedAt = normalizeIsoString(createdAt) || new Date().toISOString();
  return `${normalizedOverlayId}::${normalizedCreatedAt}`;
}

export {
  clearAllOverlays,
  deleteOverlay,
  listOverlayMetas,
  loadActiveOverlayDataset,
  saveOverlay,
};
