const DB_NAME = 'refluxDatasetCollectorDb';
const DB_VERSION = 1;
const TITLES_STORE_NAME = 'titles';
const RUN_ID_INDEX = 'runId';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TITLES_STORE_NAME)) {
        const store = db.createObjectStore(TITLES_STORE_NAME, {
          keyPath: 'key',
        });
        store.createIndex(RUN_ID_INDEX, 'runId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 열기 실패'));
  });
}

async function clearAllRefluxCollectorTitles() {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(TITLES_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(TITLES_STORE_NAME);
      store.clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB clear 실패'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB clear abort'));
    });
  } finally {
    db.close();
  }
}

async function appendRefluxCollectorTitles(runId, titles) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId || !Array.isArray(titles) || titles.length <= 0) {
    return;
  }

  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(TITLES_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(TITLES_STORE_NAME);
      titles.forEach((title) => {
        const normalizedTitle = String(title || '').trim();
        if (!normalizedTitle) {
          return;
        }

        store.put({
          key: `${normalizedRunId}::${normalizedTitle}`,
          runId: normalizedRunId,
          title: normalizedTitle,
        });
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB append 실패'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB append abort'));
    });
  } finally {
    db.close();
  }
}

async function loadRefluxCollectorTitlesForRun(runId) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return [];
  }

  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(TITLES_STORE_NAME, 'readonly');
      const store = transaction.objectStore(TITLES_STORE_NAME);
      const index = store.index(RUN_ID_INDEX);
      const request = index.getAll(normalizedRunId);
      request.onsuccess = () => {
        const titles = (Array.isArray(request.result) ? request.result : [])
          .map((entry) => String(entry?.title || '').trim())
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right, 'ko-KR'));
        resolve(titles);
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB load 실패'));
    });
  } finally {
    db.close();
  }
}

export {
  appendRefluxCollectorTitles,
  clearAllRefluxCollectorTitles,
  loadRefluxCollectorTitlesForRun,
};
