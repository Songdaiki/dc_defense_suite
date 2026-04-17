import { parseBoardViewUrl } from '../reflux-dataset-collector/page-locator.js';

const DEFAULT_CONFIG = {
  viewUrl: '',
  beforePages: 30,
  afterPages: 30,
  requestDelayMs: 500,
  jitterMs: 100,
  transportMode: 'direct',
  proxyWorkerCount: 10,
  maxRetriesPerPage: 5,
};

const SUPPORTED_TRANSPORT_MODES = new Set(['direct', 'proxy_bridge']);
const MGALLERY_VIEW_PATHNAME = '/mgallery/board/view/';

function normalizeConfig(config = {}) {
  return {
    viewUrl: normalizeViewUrl(config.viewUrl),
    beforePages: normalizePositiveInteger(config.beforePages, DEFAULT_CONFIG.beforePages, 0),
    afterPages: normalizePositiveInteger(config.afterPages, DEFAULT_CONFIG.afterPages, 0),
    requestDelayMs: normalizePositiveInteger(config.requestDelayMs, DEFAULT_CONFIG.requestDelayMs, 500),
    jitterMs: normalizePositiveInteger(config.jitterMs, DEFAULT_CONFIG.jitterMs, 0),
    transportMode: normalizeTransportMode(config.transportMode),
    proxyWorkerCount: normalizePositiveInteger(config.proxyWorkerCount, DEFAULT_CONFIG.proxyWorkerCount, 1, 10),
    maxRetriesPerPage: normalizePositiveInteger(config.maxRetriesPerPage, DEFAULT_CONFIG.maxRetriesPerPage, 1, 10),
  };
}

function parseValidatedViewUrl(viewUrl) {
  const normalizedViewUrl = normalizeViewUrl(viewUrl);
  if (!normalizedViewUrl) {
    throw new Error('URL 입력을 해주세요.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedViewUrl);
  } catch (error) {
    throw new Error('URL 입력 형식이 비정상입니다.');
  }

  if (parsedUrl.origin !== 'https://gall.dcinside.com') {
    throw new Error('URL 입력은 gall.dcinside.com 마이너 갤 주소만 지원합니다.');
  }

  if (parsedUrl.pathname !== MGALLERY_VIEW_PATHNAME) {
    throw new Error('URL 입력은 /mgallery/board/view/ 경로만 지원합니다.');
  }

  return parseBoardViewUrl(normalizedViewUrl);
}

function validateConfig(config = {}) {
  const normalizedConfig = normalizeConfig(config);
  parseValidatedViewUrl(normalizedConfig.viewUrl);

  if (!SUPPORTED_TRANSPORT_MODES.has(normalizedConfig.transportMode)) {
    throw new Error('지원하지 않는 transport mode입니다.');
  }

  return normalizedConfig;
}

function buildTargetPages(anchorPage, beforePages, afterPages, totalPageCount) {
  const normalizedAnchorPage = normalizePositiveInteger(anchorPage, 1, 1);
  const normalizedBeforePages = normalizePositiveInteger(beforePages, 0, 0);
  const normalizedAfterPages = normalizePositiveInteger(afterPages, 0, 0);
  const normalizedTotalPageCount = normalizePositiveInteger(totalPageCount, normalizedAnchorPage, 1);
  const startPage = Math.max(1, normalizedAnchorPage - normalizedBeforePages);
  const endPage = Math.min(normalizedTotalPageCount, normalizedAnchorPage + normalizedAfterPages);
  const pages = [];

  for (let page = startPage; page <= endPage; page += 1) {
    pages.push(page);
  }

  return pages.sort((left, right) => {
    const leftDistance = Math.abs(left - normalizedAnchorPage);
    const rightDistance = Math.abs(right - normalizedAnchorPage);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    if (left >= normalizedAnchorPage && right < normalizedAnchorPage) {
      return -1;
    }
    if (right >= normalizedAnchorPage && left < normalizedAnchorPage) {
      return 1;
    }
    return left - right;
  });
}

function buildOverlayId({ galleryId, anchorPostNo, startPage, endPage } = {}) {
  const normalizedGalleryId = String(galleryId || '').trim();
  const normalizedAnchorPostNo = normalizePositiveInteger(anchorPostNo, 0);
  const normalizedStartPage = normalizePositiveInteger(startPage, 0);
  const normalizedEndPage = normalizePositiveInteger(endPage, 0);
  if (!normalizedGalleryId || normalizedAnchorPostNo <= 0 || normalizedStartPage <= 0 || normalizedEndPage <= 0) {
    return '';
  }

  return `${normalizedGalleryId}::${normalizedAnchorPostNo}::${normalizedStartPage}::${normalizedEndPage}`;
}

function normalizeTransportMode(value) {
  return SUPPORTED_TRANSPORT_MODES.has(value)
    ? value
    : DEFAULT_CONFIG.transportMode;
}

function normalizeViewUrl(value) {
  return String(value || '').trim();
}

function normalizePositiveInteger(value, fallback, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return clampInteger(fallback, minimum, maximum);
  }

  return clampInteger(parsed, minimum, maximum);
}

function clampInteger(value, minimum, maximum) {
  const normalizedValue = Math.trunc(Number(value) || 0);
  return Math.min(maximum, Math.max(minimum, normalizedValue));
}

export {
  DEFAULT_CONFIG,
  buildOverlayId,
  buildTargetPages,
  normalizeConfig,
  normalizeTransportMode,
  normalizeViewUrl,
  parseValidatedViewUrl,
  validateConfig,
};
