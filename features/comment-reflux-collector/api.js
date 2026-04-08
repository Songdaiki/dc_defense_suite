import { extractEsno, fetchComments } from '../comment/api.js';

const DEFAULT_CONFIG = {
  galleryId: '',
  startPage: 1,
  endPage: 100,
  requestDelayMs: 100,
  cycleDelayMs: 5000,
  postConcurrency: 8,
  commentPageConcurrency: 4,
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

  return Math.max(minimum, parsed);
}

function normalizeConfig(config = {}) {
  const startPage = normalizePositiveInteger(config.startPage, DEFAULT_CONFIG.startPage, 1);
  const endPage = normalizePositiveInteger(config.endPage, DEFAULT_CONFIG.endPage, 1);
  return {
    galleryId: normalizeGalleryId(config.galleryId),
    startPage,
    endPage: Math.max(startPage, endPage),
    requestDelayMs: normalizePositiveInteger(config.requestDelayMs, DEFAULT_CONFIG.requestDelayMs, 0),
    cycleDelayMs: normalizePositiveInteger(config.cycleDelayMs, DEFAULT_CONFIG.cycleDelayMs, 0),
    postConcurrency: normalizePositiveInteger(config.postConcurrency, DEFAULT_CONFIG.postConcurrency, 1),
    commentPageConcurrency: normalizePositiveInteger(config.commentPageConcurrency, DEFAULT_CONFIG.commentPageConcurrency, 1),
  };
}

function buildListUrl(galleryId, page) {
  const url = new URL('/mgallery/board/lists/', BASE_URL);
  url.searchParams.set('id', normalizeGalleryId(galleryId));
  url.searchParams.set('page', String(normalizePositiveInteger(page, 1, 1)));
  return url.toString();
}

function buildViewUrl(galleryId, postNo) {
  const url = new URL('/mgallery/board/view/', BASE_URL);
  url.searchParams.set('id', normalizeGalleryId(galleryId));
  url.searchParams.set('no', String(normalizePositiveInteger(postNo, 1, 1)));
  return url.toString();
}

async function fetchCollectorPostListHtml(galleryId, page, options = {}) {
  const normalizedGalleryId = normalizeGalleryId(galleryId);
  if (!isValidGalleryId(normalizedGalleryId)) {
    throw new Error('갤 ID 형식이 비정상입니다.');
  }

  return fetchCollectorHtml(buildListUrl(normalizedGalleryId, page), options);
}

async function fetchCollectorPostViewHtml(galleryId, postNo, options = {}) {
  const normalizedGalleryId = normalizeGalleryId(galleryId);
  if (!isValidGalleryId(normalizedGalleryId)) {
    throw new Error('갤 ID 형식이 비정상입니다.');
  }

  const html = await fetchCollectorHtml(buildViewUrl(normalizedGalleryId, postNo), options);
  if (html.includes('정상적인 접근이 아닙니다')) {
    throw new Error('게시물 페이지 접근 차단 응답을 받았습니다');
  }

  return html;
}

async function fetchCollectorCommentsPage(config = {}, postNo, esno, commentPage = 1) {
  const normalizedConfig = normalizeConfig(config);
  return fetchComments(
    {
      galleryId: normalizedConfig.galleryId,
      galleryType: 'M',
      baseUrl: BASE_URL,
    },
    postNo,
    esno,
    commentPage,
  );
}

async function fetchAllCollectorComments(config = {}, postNo, esno, pageConcurrency = DEFAULT_CONFIG.commentPageConcurrency) {
  const normalizedConfig = normalizeConfig(config);
  const firstPage = await fetchCollectorCommentsPage(normalizedConfig, postNo, esno, 1);
  const allComments = [...firstPage.comments];
  const firstPageSize = firstPage.comments.length || 20;
  const totalPages = Math.max(1, Math.ceil(firstPage.totalCnt / firstPageSize));

  if (totalPages <= 1) {
    return {
      comments: allComments,
      totalCnt: firstPage.totalCnt,
    };
  }

  const pageNumbers = [];
  for (let page = 2; page <= totalPages; page += 1) {
    pageNumbers.push(page);
  }

  const pageResults = await mapWithConcurrency(
    pageNumbers,
    Math.max(1, Number(pageConcurrency) || normalizedConfig.commentPageConcurrency),
    async (page) => ({
      page,
      data: await fetchCollectorCommentsPage(normalizedConfig, postNo, esno, page),
    }),
  );

  pageResults
    .sort((left, right) => left.page - right.page)
    .forEach((result) => {
      allComments.push(...result.data.comments);
    });

  return {
    comments: allComments,
    totalCnt: firstPage.totalCnt,
  };
}

async function fetchCollectorHtml(url, options = {}) {
  const maxRetries = Math.max(1, Number(options.maxRetries) || 3);
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

      if (response.status === 429) {
        if (attempt < maxRetries - 1) {
          await delay((attempt + 1) * 2000);
          continue;
        }
        throw new Error('목록/본문 요청이 레이트 리밋에 걸렸습니다.');
      }

      if (response.status === 403) {
        if (attempt < maxRetries - 1) {
          await delay(30000);
          continue;
        }
        throw new Error('목록/본문 요청이 접근 차단 응답을 반환했습니다.');
      }

      if (!response.ok) {
        throw new Error(`목록/본문 요청 실패 (HTTP ${response.status})`);
      }

      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        await delay((attempt + 1) * 1000);
      }
    }
  }

  throw new Error(lastError?.message || '목록/본문 요청 실패');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const nextConcurrency = Math.max(1, Number(concurrency) || 1);
  const results = new Array(normalizedItems.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(nextConcurrency, normalizedItems.length || 1) }, async () => {
    while (nextIndex < normalizedItems.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(normalizedItems[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results.filter((entry) => entry !== undefined);
}

export {
  BASE_URL,
  DEFAULT_CONFIG,
  buildListUrl,
  buildViewUrl,
  delay,
  extractEsno,
  fetchAllCollectorComments,
  fetchCollectorCommentsPage,
  fetchCollectorPostListHtml,
  fetchCollectorPostViewHtml,
  isValidGalleryId,
  normalizeConfig,
  normalizeGalleryId,
};
