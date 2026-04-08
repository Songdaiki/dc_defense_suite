const DB_NAME = 'commentRefluxCollectorDb';
const DB_VERSION = 1;
const MEMOS_STORE_NAME = 'memos';
const RUN_ID_INDEX = 'runId';

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEMOS_STORE_NAME)) {
        const store = db.createObjectStore(MEMOS_STORE_NAME, {
          keyPath: 'key',
        });
        store.createIndex(RUN_ID_INDEX, 'runId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 열기 실패'));
  });
}

async function clearAllCollectorMemos() {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(MEMOS_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(MEMOS_STORE_NAME);
      store.clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB clear 실패'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB clear abort'));
    });
  } finally {
    db.close();
  }
}

async function appendCollectorMemos(runId, memos) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId || !Array.isArray(memos) || memos.length <= 0) {
    return;
  }

  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(MEMOS_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(MEMOS_STORE_NAME);

      memos.forEach((memo) => {
        const normalizedMemo = String(memo || '').trim();
        if (!normalizedMemo) {
          return;
        }

        store.put({
          key: `${normalizedRunId}::${normalizedMemo}`,
          runId: normalizedRunId,
          memo: normalizedMemo,
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

async function countCollectorMemosByRun(runId) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return 0;
  }

  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(MEMOS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(MEMOS_STORE_NAME);
      const index = store.index(RUN_ID_INDEX);
      const request = index.count(IDBKeyRange.only(normalizedRunId));
      request.onsuccess = () => resolve(Math.max(0, Number(request.result) || 0));
      request.onerror = () => reject(request.error || new Error('IndexedDB count 실패'));
    });
  } finally {
    db.close();
  }
}

async function iterateCollectorMemosByRun(runId, visitor) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId || typeof visitor !== 'function') {
    return 0;
  }

  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(MEMOS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(MEMOS_STORE_NAME);
      const index = store.index(RUN_ID_INDEX);
      const request = index.openCursor(IDBKeyRange.only(normalizedRunId));
      let visitedCount = 0;

      request.onerror = () => reject(request.error || new Error('IndexedDB iterate 실패'));
      request.onsuccess = async () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(visitedCount);
          return;
        }

        try {
          const memo = String(cursor.value?.memo || '').trim();
          if (memo) {
            visitedCount += 1;
            await visitor(memo, visitedCount);
          }
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      };

      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB iterate abort'));
    });
  } finally {
    db.close();
  }
}

export {
  appendCollectorMemos,
  clearAllCollectorMemos,
  countCollectorMemosByRun,
  iterateCollectorMemosByRun,
};
