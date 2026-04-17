const BASE_URL = 'https://gall.dcinside.com';
const GALLERY_ID_REGEX = /^[a-z0-9_]+$/i;

const DEFAULT_PAGE_LOCATOR_CONFIG = {
  requestDelayMs: 500,
  jitterMs: 100,
  neighborPageRadius: 3,
  maxBinaryProbeCount: 32,
  maxRetries: 1,
  delayFirstRequest: true,
};

function normalizeGalleryId(value) {
  return String(value || '').trim();
}

function isValidGalleryId(value) {
  const normalizedGalleryId = normalizeGalleryId(value);
  return Boolean(normalizedGalleryId) && GALLERY_ID_REGEX.test(normalizedGalleryId);
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

function normalizePageLocatorConfig(config = {}) {
  return {
    requestDelayMs: normalizePositiveInteger(config.requestDelayMs, DEFAULT_PAGE_LOCATOR_CONFIG.requestDelayMs, 0),
    jitterMs: normalizePositiveInteger(config.jitterMs, DEFAULT_PAGE_LOCATOR_CONFIG.jitterMs, 0),
    neighborPageRadius: normalizePositiveInteger(config.neighborPageRadius, DEFAULT_PAGE_LOCATOR_CONFIG.neighborPageRadius, 0),
    maxBinaryProbeCount: normalizePositiveInteger(config.maxBinaryProbeCount, DEFAULT_PAGE_LOCATOR_CONFIG.maxBinaryProbeCount, 1),
    maxRetries: normalizePositiveInteger(config.maxRetries, DEFAULT_PAGE_LOCATOR_CONFIG.maxRetries, 1),
    delayFirstRequest: config.delayFirstRequest == null
      ? DEFAULT_PAGE_LOCATOR_CONFIG.delayFirstRequest
      : Boolean(config.delayFirstRequest),
    signal: config.signal,
  };
}

function parsePositiveIntegerOrZero(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function parseBoardViewUrl(viewUrl) {
  const normalizedViewUrl = String(viewUrl || '').trim();
  if (!normalizedViewUrl) {
    throw new Error('view URL이 비어 있습니다.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedViewUrl);
  } catch (error) {
    throw new Error('view URL 형식이 비정상입니다.');
  }

  const galleryId = normalizeGalleryId(parsedUrl.searchParams.get('id'));
  const targetNo = parsePositiveIntegerOrZero(parsedUrl.searchParams.get('no'));

  if (!isValidGalleryId(galleryId)) {
    throw new Error('view URL의 갤 ID 형식이 비정상입니다.');
  }

  if (targetNo <= 0) {
    throw new Error('view URL의 글 번호가 비정상입니다.');
  }

  return {
    viewUrl: parsedUrl.toString(),
    galleryId,
    targetNo,
  };
}

function buildListUrl(galleryId, page) {
  const url = new URL('/mgallery/board/lists/', BASE_URL);
  url.searchParams.set('id', normalizeGalleryId(galleryId));
  url.searchParams.set('page', String(normalizePositiveInteger(page, 1, 1)));
  return url.toString();
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeText(text) {
  return decodeHtml(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSubject(rowHtml) {
  const titleMatch = rowHtml.match(/<td[^>]*class="gall_tit[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  if (!titleMatch) {
    return '';
  }

  const titleHtml = titleMatch[1]
    .replace(/<em[^>]*class="icon_[^"]*"[\s\S]*?<\/em>/gi, ' ')
    .replace(/<span[^>]*class="reply_num"[\s\S]*?<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  return normalizeText(titleHtml);
}

function extractCurrentHead(rowHtml) {
  const subjectMatch = rowHtml.match(/<td[^>]*class="gall_subject[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  if (!subjectMatch) {
    return '';
  }

  const subjectHtml = subjectMatch[1]
    .replace(/<p[^>]*class="subject_inner"[\s\S]*?<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  return normalizeText(subjectHtml)
    .replace(/\s*,\s*/g, ',')
    .replace(/,+$/g, '');
}

function isRegularBoardRow(rowHtml) {
  const gallNumMatch = rowHtml.match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  if (!gallNumMatch) {
    return false;
  }

  const gallNumText = normalizeText(gallNumMatch[1].replace(/<[^>]+>/g, ' '));
  return /^\d+$/.test(gallNumText);
}

function isNoticeHead(currentHead) {
  return String(currentHead || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .includes('공지');
}

function parseBoardListRows(html) {
  const rows = [];
  const rowRegex = /<tr[^>]*class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const postNo = Number.parseInt(match[1], 10);
    if (postNo <= 0) {
      continue;
    }

    const rowHtml = match[2];
    if (!isRegularBoardRow(rowHtml)) {
      continue;
    }

    rows.push({
      no: postNo,
      subject: extractSubject(rowHtml),
      currentHead: extractCurrentHead(rowHtml),
    });
  }

  return rows;
}

function parseListPageInfo(html, page, targetNo) {
  const rows = parseBoardListRows(html);
  const regularRows = rows.filter((row) => !isNoticeHead(row.currentHead));
  const rowNos = regularRows.map((row) => row.no);
  const newestNo = rowNos.length > 0 ? Math.max(...rowNos) : null;
  const oldestNo = rowNos.length > 0 ? Math.min(...rowNos) : null;
  const totalPageCount = Number.parseInt(
    html.match(/page=(\d+)"[^>]*class="sp_pagingicon page_end"/)?.[1] || '1',
    10,
  ) || 1;

  const exactIndex = regularRows.findIndex((row) => row.no === targetNo);
  const exactPost = exactIndex >= 0
    ? {
        page,
        rowIndex: exactIndex + 1,
        no: regularRows[exactIndex].no,
        currentHead: regularRows[exactIndex].currentHead,
        subject: regularRows[exactIndex].subject,
      }
    : null;

  return {
    page,
    totalPageCount,
    regularRows,
    newestNo,
    oldestNo,
    exactPost,
  };
}

function getRequestDelayWithJitter(config, randomFn = Math.random) {
  const normalizedConfig = normalizePageLocatorConfig(config);
  const jitterMs = normalizedConfig.jitterMs > 0
    ? Math.floor(randomFn() * (normalizedConfig.jitterMs + 1))
    : 0;
  return normalizedConfig.requestDelayMs + jitterMs;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function createAbortError(message = '요청이 중단되었습니다.') {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }

  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return Boolean(error?.name === 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function waitWithSignal(ms, delayFn = delay, signal) {
  const waitMs = Math.max(0, Number(ms) || 0);
  throwIfAborted(signal);
  if (waitMs <= 0) {
    return;
  }

  if (!signal) {
    await delayFn(waitMs);
    return;
  }

  await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      settleReject(createAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });

    Promise.resolve(delayFn(waitMs))
      .then(settleResolve)
      .catch(settleReject);
  });

  throwIfAborted(signal);
}

async function fetchBoardListHtml(galleryId, page, options = {}, dependencies = {}) {
  const normalizedGalleryId = normalizeGalleryId(galleryId);
  if (!isValidGalleryId(normalizedGalleryId)) {
    throw new Error('갤 ID 형식이 비정상입니다.');
  }

  const normalizedPage = normalizePositiveInteger(page, 1, 1);
  const signal = options?.signal;
  const customFetchBoardListHtml = dependencies.fetchBoardListHtmlImpl;
  if (typeof customFetchBoardListHtml === 'function') {
    throwIfAborted(signal);
    return customFetchBoardListHtml(normalizedGalleryId, normalizedPage, {
      ...options,
      signal,
    });
  }

  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const delayFn = dependencies.delayFn || delay;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch 구현이 없습니다.');
  }

  const url = buildListUrl(normalizedGalleryId, normalizedPage);
  const maxRetries = normalizePositiveInteger(options.maxRetries, DEFAULT_PAGE_LOCATOR_CONFIG.maxRetries, 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      throwIfAborted(signal);
      const response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal,
      });

      if (response.status === 429 && attempt < maxRetries - 1) {
        await waitWithSignal((attempt + 1) * 2000, delayFn, signal);
        continue;
      }

      if (!response.ok) {
        throw new Error(`목록 요청 실패 (HTTP ${response.status})`);
      }

      return response.text();
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw createAbortError();
      }

      lastError = error;
      if (attempt < maxRetries - 1) {
        await waitWithSignal((attempt + 1) * 1000, delayFn, signal);
      }
    }
  }

  throw new Error(lastError?.message || '목록 요청 실패');
}

function buildCheckedPageEntry(parsedPage, metadata = {}) {
  return {
    stage: String(metadata.stage || ''),
    page: parsedPage.page,
    newestNo: parsedPage.newestNo,
    oldestNo: parsedPage.oldestNo,
    exactMatch: Boolean(parsedPage.exactPost),
    delayMs: Math.max(0, Number(metadata.delayMs) || 0),
  };
}

function buildLocateResult(baseResult, overrides = {}) {
  return {
    success: false,
    strategy: 'binary-search-neighbor-scan',
    galleryId: baseResult.galleryId,
    targetNo: baseResult.targetNo,
    foundPage: null,
    candidatePage: null,
    totalPageCount: baseResult.totalPageCount,
    binaryProbeCount: baseResult.binaryProbeCount,
    networkFetchCount: baseResult.networkFetchCount,
    checkedPages: baseResult.checkedPages.slice(),
    foundPost: null,
    reason: '',
    ...overrides,
  };
}

async function locateBoardListPageByPostNo(input, options = {}, dependencies = {}) {
  const galleryId = normalizeGalleryId(input?.galleryId);
  const targetNo = parsePositiveIntegerOrZero(input?.targetNo);
  if (!isValidGalleryId(galleryId)) {
    throw new Error('갤 ID 형식이 비정상입니다.');
  }
  if (targetNo <= 0) {
    throw new Error('글 번호가 비정상입니다.');
  }

  const normalizedConfig = normalizePageLocatorConfig(options);
  const delayFn = dependencies.delayFn || delay;
  const randomFn = dependencies.randomFn || Math.random;
  const pageCache = new Map();
  const checkedPages = [];
  let binaryProbeCount = 0;
  let networkFetchCount = 0;

  async function loadPage(page, stage, shouldDelay) {
    throwIfAborted(normalizedConfig.signal);
    const normalizedPage = normalizePositiveInteger(page, 1, 1);
    if (pageCache.has(normalizedPage)) {
      return pageCache.get(normalizedPage);
    }

    let delayMs = 0;
    if (shouldDelay) {
      delayMs = getRequestDelayWithJitter(normalizedConfig, randomFn);
      await waitWithSignal(delayMs, delayFn, normalizedConfig.signal);
    }

    const html = await fetchBoardListHtml(
      galleryId,
      normalizedPage,
      normalizedConfig,
      dependencies,
    );
    networkFetchCount += 1;

    const parsedPage = parseListPageInfo(html, normalizedPage, targetNo);
    pageCache.set(normalizedPage, parsedPage);
    checkedPages.push(buildCheckedPageEntry(parsedPage, { stage, delayMs }));
    return parsedPage;
  }

  const firstPage = await loadPage(1, 'bootstrap', normalizedConfig.delayFirstRequest);
  const baseResult = {
    galleryId,
    targetNo,
    totalPageCount: firstPage.totalPageCount,
    binaryProbeCount,
    networkFetchCount,
    checkedPages,
  };

  if (firstPage.exactPost) {
    return buildLocateResult(baseResult, {
      success: true,
      foundPage: 1,
      candidatePage: 1,
      foundPost: firstPage.exactPost,
    });
  }

  let low = 1;
  let high = firstPage.totalPageCount;
  let candidatePage = null;

  while (low <= high && binaryProbeCount < normalizedConfig.maxBinaryProbeCount) {
    const mid = Math.floor((low + high) / 2);
    const parsedPage = await loadPage(
      mid,
      'binary',
      mid !== 1 || binaryProbeCount > 0 || normalizedConfig.delayFirstRequest,
    );
    binaryProbeCount += 1;

    if (parsedPage.exactPost) {
      return buildLocateResult(baseResult, {
        success: true,
        totalPageCount: firstPage.totalPageCount,
        binaryProbeCount,
        networkFetchCount,
        foundPage: parsedPage.page,
        candidatePage: parsedPage.page,
        foundPost: parsedPage.exactPost,
      });
    }

    if (parsedPage.newestNo == null || parsedPage.oldestNo == null) {
      return buildLocateResult(baseResult, {
        totalPageCount: firstPage.totalPageCount,
        binaryProbeCount,
        networkFetchCount,
        reason: '정규 글 범위 파싱 실패',
      });
    }

    if (targetNo > parsedPage.newestNo) {
      high = mid - 1;
      continue;
    }

    if (targetNo < parsedPage.oldestNo) {
      low = mid + 1;
      continue;
    }

    candidatePage = parsedPage.page;
    break;
  }

  if (candidatePage == null) {
    return buildLocateResult(baseResult, {
      totalPageCount: firstPage.totalPageCount,
      binaryProbeCount,
      networkFetchCount,
      reason: '이분탐색 범위에서 후보 페이지를 찾지 못함',
    });
  }

  const startPage = Math.max(1, candidatePage - normalizedConfig.neighborPageRadius);
  const endPage = Math.min(firstPage.totalPageCount, candidatePage + normalizedConfig.neighborPageRadius);

  for (let page = startPage; page <= endPage; page += 1) {
    const parsedPage = await loadPage(page, 'neighbor', true);
    if (!parsedPage.exactPost) {
      continue;
    }

    return buildLocateResult(baseResult, {
      success: true,
      totalPageCount: firstPage.totalPageCount,
      binaryProbeCount,
      networkFetchCount,
      foundPage: parsedPage.page,
      candidatePage,
      foundPost: parsedPage.exactPost,
    });
  }

  return buildLocateResult(baseResult, {
    totalPageCount: firstPage.totalPageCount,
    binaryProbeCount,
    networkFetchCount,
    candidatePage,
    reason: '후보 페이지 주변에서 exact row를 찾지 못함',
  });
}

async function locateBoardListPageFromViewUrl(viewUrl, options = {}, dependencies = {}) {
  const parsedView = parseBoardViewUrl(viewUrl);
  return locateBoardListPageByPostNo(parsedView, options, dependencies);
}

export {
  DEFAULT_PAGE_LOCATOR_CONFIG,
  buildListUrl,
  locateBoardListPageByPostNo,
  locateBoardListPageFromViewUrl,
  normalizePageLocatorConfig,
  parseBoardViewUrl,
  parseListPageInfo,
};
