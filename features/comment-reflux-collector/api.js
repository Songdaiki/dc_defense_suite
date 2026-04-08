import {
  extractEsno,
  fetchAllComments as fetchCommentAllComments,
  fetchComments as fetchCommentCommentsPage,
  fetchPostList as fetchCommentPostList,
  fetchPostPage as fetchCommentPostPage,
} from '../comment/api.js';

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

function buildCollectorCommentApiConfig(config = {}) {
  const normalizedConfig = normalizeConfig(config);
  return {
    galleryId: normalizedConfig.galleryId,
    galleryType: 'M',
    baseUrl: BASE_URL,
  };
}

async function fetchCollectorPostList(config = {}, page = 1) {
  const normalizedConfig = normalizeConfig(config);
  if (!isValidGalleryId(normalizedConfig.galleryId)) {
    throw new Error('갤 ID 형식이 비정상입니다.');
  }

  return fetchCommentPostList(buildCollectorCommentApiConfig(normalizedConfig), page);
}

async function fetchCollectorPostPage(config = {}, postNo) {
  const normalizedConfig = normalizeConfig(config);
  if (!isValidGalleryId(normalizedConfig.galleryId)) {
    throw new Error('갤 ID 형식이 비정상입니다.');
  }

  return fetchCommentPostPage(buildCollectorCommentApiConfig(normalizedConfig), postNo);
}

async function fetchCollectorCommentsPage(config = {}, postNo, esno, commentPage = 1) {
  const normalizedConfig = normalizeConfig(config);
  return fetchCommentCommentsPage(
    buildCollectorCommentApiConfig(normalizedConfig),
    postNo,
    esno,
    Math.max(1, Number(commentPage) || 1),
  );
}

async function fetchAllCollectorComments(config = {}, postNo, esno, pageConcurrency = DEFAULT_CONFIG.commentPageConcurrency) {
  const normalizedConfig = normalizeConfig(config);
  return fetchCommentAllComments(
    buildCollectorCommentApiConfig(normalizedConfig),
    postNo,
    esno,
    Math.max(1, Number(pageConcurrency) || normalizedConfig.commentPageConcurrency),
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export {
  BASE_URL,
  DEFAULT_CONFIG,
  buildListUrl,
  buildViewUrl,
  delay,
  extractEsno,
  fetchAllCollectorComments,
  fetchCollectorPostList,
  fetchCollectorPostPage,
  fetchCollectorCommentsPage,
  isValidGalleryId,
  normalizeConfig,
  normalizeGalleryId,
};
