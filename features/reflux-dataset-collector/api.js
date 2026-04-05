const DEFAULT_CONFIG = {
  galleryId: '',
  startPage: 1,
  endPage: 397,
  requestDelayMs: 1200,
  jitterMs: 400,
};

const BASE_URL = 'https://gall.dcinside.com';
const GALLERY_ID_REGEX = /^[a-z0-9_]+$/i;

function normalizeGalleryId(value) {
  return String(value || '').trim();
}

function isValidGalleryId(value) {
  const normalized = normalizeGalleryId(value);
  return Boolean(normalized) && GALLERY_ID_REGEX.test(normalized);
}

function normalizePositiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return Math.max(minimum, Number.parseInt(String(fallback ?? minimum), 10) || minimum);
  }

  if (parsed < minimum) {
    return minimum;
  }

  return parsed;
}

function normalizeConfig(config = {}) {
  const startPage = normalizePositiveInteger(config.startPage, DEFAULT_CONFIG.startPage, 1);
  const endPage = normalizePositiveInteger(config.endPage, DEFAULT_CONFIG.endPage, 1);
  return {
    galleryId: normalizeGalleryId(config.galleryId),
    startPage,
    endPage: Math.max(startPage, endPage),
    requestDelayMs: normalizePositiveInteger(config.requestDelayMs, DEFAULT_CONFIG.requestDelayMs, 500),
    jitterMs: normalizePositiveInteger(config.jitterMs, DEFAULT_CONFIG.jitterMs, 0),
  };
}

function buildListUrl(galleryId, page) {
  const url = new URL('/mgallery/board/lists/', BASE_URL);
  url.searchParams.set('id', normalizeGalleryId(galleryId));
  url.searchParams.set('page', String(normalizePositiveInteger(page, 1, 1)));
  return url.toString();
}

async function fetchBoardListHtml(galleryId, page, options = {}) {
  const normalizedGalleryId = normalizeGalleryId(galleryId);
  if (!isValidGalleryId(normalizedGalleryId)) {
    throw new Error('갤 ID 형식이 비정상입니다.');
  }

  const url = buildListUrl(normalizedGalleryId, page);
  const maxRetries = Math.max(1, Number(options.maxRetries) || 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: options.signal,
      });

      if (response.status === 429 && attempt < maxRetries - 1) {
        await delay((attempt + 1) * 2000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`목록 요청 실패 (HTTP ${response.status})`);
      }

      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        await delay((attempt + 1) * 1000);
      }
    }
  }

  throw new Error(lastError?.message || '목록 요청 실패');
}

function getRequestDelayWithJitter(config = {}) {
  const normalizedConfig = normalizeConfig(config);
  const jitterMs = normalizedConfig.jitterMs > 0
    ? Math.floor(Math.random() * (normalizedConfig.jitterMs + 1))
    : 0;
  return normalizedConfig.requestDelayMs + jitterMs;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export {
  BASE_URL,
  DEFAULT_CONFIG,
  buildListUrl,
  delay,
  fetchBoardListHtml,
  getRequestDelayWithJitter,
  isValidGalleryId,
  normalizeConfig,
  normalizeGalleryId,
};
