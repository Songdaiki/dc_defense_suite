const DEFAULT_BASE_URL = 'https://gall.dcinside.com';
const DEFAULT_BOARD_PATH = 'mgallery';
const DEFAULT_FETCH_TIMEOUT_MS = 30000;

class DcFetchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DcFetchError';
    this.kind = String(details.kind || 'fetch_error');
    this.status = Number.isFinite(Number(details.status)) ? Number(details.status) : 0;
    this.url = String(details.url || '');
  }
}

function normalizeBoardPath(boardPath = DEFAULT_BOARD_PATH) {
  const normalized = String(boardPath || DEFAULT_BOARD_PATH)
    .replace(/^\/+|\/+$/g, '')
    .trim();
  return normalized || DEFAULT_BOARD_PATH;
}

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/g, '') || DEFAULT_BASE_URL;
}

function buildPostListUrl({ baseUrl = DEFAULT_BASE_URL, boardPath = DEFAULT_BOARD_PATH, galleryId, page = 1 }) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/${normalizeBoardPath(boardPath)}/board/lists/`);
  url.searchParams.set('id', String(galleryId || 'thesingularity'));
  url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
  return url.toString();
}

function buildPostUrl({ baseUrl = DEFAULT_BASE_URL, boardPath = DEFAULT_BOARD_PATH, galleryId, postNo }) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/${normalizeBoardPath(boardPath)}/board/view/`);
  url.searchParams.set('id', String(galleryId || 'thesingularity'));
  url.searchParams.set('no', String(postNo || ''));
  return url.toString();
}

function buildDcHtmlHeaders(baseUrl = DEFAULT_BASE_URL) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: `${normalizeBaseUrl(baseUrl)}/`,
  };
}

async function fetchPostListHtml(config = {}, page = 1, signal = null) {
  const url = buildPostListUrl({ ...config, page });
  return fetchHtmlWithRetry(url, config, signal);
}

async function fetchPostPageHtml(config = {}, postNo, signal = null) {
  const url = buildPostUrl({ ...config, postNo });
  return fetchHtmlWithRetry(url, config, signal);
}

async function fetchHtmlWithRetry(url, config = {}, externalSignal = null) {
  const maxAttempts = Math.max(1, Math.min(5, Number(config.fetchAttempts) || 3));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchHtmlOnce(url, config, externalSignal);
    } catch (error) {
      lastError = error;
      if (!shouldRetryFetch(error) || attempt >= maxAttempts) {
        break;
      }
      await delay(Math.min(2500, 350 * attempt));
    }
  }

  throw lastError || new DcFetchError('HTML fetch 실패', { url });
}

async function fetchHtmlOnce(url, config = {}, externalSignal = null) {
  const timeoutMs = Math.max(1000, Number(config.fetchTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortHandler = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildDcHtmlHeaders(config.baseUrl),
      signal: controller.signal,
    });

    const html = await response.text();
    if (!response.ok) {
      throw new DcFetchError(`HTTP ${response.status}`, {
        kind: response.status === 404 ? 'not_found' : 'response_status',
        status: response.status,
        url,
      });
    }

    if (html.includes('정상적인 접근이 아닙니다')) {
      throw new DcFetchError('접근 제한 응답', { kind: 'blocked_access', url });
    }

    return html;
  } catch (error) {
    if (error instanceof DcFetchError) {
      throw error;
    }
    const aborted = controller.signal.aborted || externalSignal?.aborted;
    throw new DcFetchError(
      aborted ? `HTML fetch timeout 또는 중단 (${timeoutMs}ms)` : `HTML fetch 실패: ${error?.message || String(error)}`,
      {
        kind: aborted ? 'timeout' : 'network_error',
        url,
      },
    );
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortHandler);
    }
  }
}

function shouldRetryFetch(error) {
  if (!(error instanceof DcFetchError)) {
    return true;
  }
  if (error.kind === 'network_error' || error.kind === 'timeout') {
    return true;
  }
  return error.status === 403 || error.status === 429 || error.status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  DcFetchError,
  buildDcHtmlHeaders,
  buildPostListUrl,
  buildPostUrl,
  fetchHtmlWithRetry,
  fetchPostListHtml,
  fetchPostPageHtml,
  normalizeBaseUrl,
  normalizeBoardPath,
};
