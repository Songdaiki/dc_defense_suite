import { fetchBoardListHtml } from '../reflux-dataset-collector/api.js';

const DEFAULT_PROXY_BRIDGE_ENDPOINT = 'http://127.0.0.1:4318';

function createDirectListPageTransport(dependencies = {}) {
  const fetchBoardListHtmlImpl = dependencies.fetchBoardListHtml || fetchBoardListHtml;

  return {
    mode: 'direct',
    workerCount: 1,
    async ensureReady() {
      return {
        success: true,
        mode: 'direct',
        proxyCount: 0,
      };
    },
    getEffectiveWorkerCount() {
      return 1;
    },
    async fetchBoardListHtml(galleryId, page, options = {}) {
      return fetchBoardListHtmlImpl(galleryId, page, options);
    },
  };
}

function createProxyBridgeListPageTransport(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const bridgeEndpoint = normalizeProxyBridgeEndpoint(dependencies.bridgeEndpoint);
  const workerCount = Math.max(1, Number(dependencies.workerCount) || 1);
  let availableProxyCount = 0;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch 구현이 없습니다.');
  }

  return {
    mode: 'proxy_bridge',
    workerCount,
    async ensureReady(options = {}) {
      const response = await fetchImpl(`${bridgeEndpoint}/health`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: options?.signal,
      });
      const payload = await readBridgeJsonResponse(response);
      if (!response.ok || !payload.success) {
        throw new Error(String(payload.message || `proxy bridge 연결 실패 (HTTP ${response.status})`));
      }

      const proxyCount = Math.max(0, Number(payload.proxyCount) || 0);
      if (proxyCount <= 0) {
        throw new Error(String(payload.message || '사용 가능한 proxy가 없습니다.'));
      }

      availableProxyCount = proxyCount;
      return {
        ...payload,
        proxyCount,
      };
    },
    getEffectiveWorkerCount(targetPageCount = workerCount) {
      const normalizedTargetPageCount = Math.max(1, Number(targetPageCount) || 1);
      const proxyBound = availableProxyCount > 0 ? availableProxyCount : workerCount;
      return Math.max(1, Math.min(workerCount, proxyBound, normalizedTargetPageCount));
    },
    async fetchBoardListHtml(galleryId, page, options = {}) {
      const response = await fetchImpl(`${bridgeEndpoint}/reflux-overlay/fetch-board-list`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          galleryId,
          page,
          maxRetries: Math.max(1, Number(options?.maxRetries) || 1),
        }),
        signal: options?.signal,
      });
      const payload = await readBridgeJsonResponse(response);
      if (!response.ok || !payload.success) {
        throw new Error(String(payload.message || `proxy bridge 목록 요청 실패 (HTTP ${response.status})`));
      }

      if (typeof payload.html !== 'string' || !payload.html.trim()) {
        throw new Error('proxy bridge가 비정상 HTML을 반환했습니다.');
      }

      return payload.html;
    },
  };
}

function createListPageTransport(config = {}, dependencies = {}) {
  if (String(config.transportMode || '').trim() === 'proxy_bridge') {
    return createProxyBridgeListPageTransport({
      ...dependencies,
      workerCount: config.proxyWorkerCount,
    });
  }

  return createDirectListPageTransport(dependencies);
}

export {
  createDirectListPageTransport,
  createListPageTransport,
  createProxyBridgeListPageTransport,
};

function normalizeProxyBridgeEndpoint(value) {
  const rawValue = String(value || DEFAULT_PROXY_BRIDGE_ENDPOINT).trim() || DEFAULT_PROXY_BRIDGE_ENDPOINT;
  return rawValue.replace(/\/+$/g, '');
}

async function readBridgeJsonResponse(response) {
  const fallback = {
    success: false,
    message: '',
  };

  if (!response) {
    return fallback;
  }

  try {
    return {
      ...fallback,
      ...(await response.json()),
    };
  } catch {
    return {
      ...fallback,
      message: response.ok ? 'proxy bridge JSON 파싱 실패' : `proxy bridge 응답 실패 (HTTP ${response.status})`,
    };
  }
}
