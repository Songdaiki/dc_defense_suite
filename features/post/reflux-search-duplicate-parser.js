import { normalizeSemiconductorRefluxTitle } from './attack-mode.js';

const SEARCH_BASE_URL = 'https://search.dcinside.com';
const GALL_BASE_URL = 'https://gall.dcinside.com';

function parseRefluxSearchDuplicateJsonp(jsonpText) {
  const payload = unwrapJsonpPayload(jsonpText);
  const rows = extractSearchRows(payload);

  return rows
    .map((row) => normalizeSearchRow(row))
    .filter(Boolean);
}

function unwrapJsonpPayload(jsonpText) {
  const rawText = String(jsonpText || '').trim();
  if (!rawText) {
    throw new Error('빈 JSONP 응답입니다.');
  }

  const wrapperStartIndex = rawText.indexOf('(');
  const wrapperEndIndex = rawText.lastIndexOf(')');
  if (wrapperStartIndex <= 0 || wrapperEndIndex <= wrapperStartIndex) {
    throw new Error('JSONP wrapper를 찾지 못했습니다.');
  }

  const payloadText = rawText.slice(wrapperStartIndex + 1, wrapperEndIndex).trim();
  if (!payloadText) {
    throw new Error('JSONP payload가 비어 있습니다.');
  }

  try {
    return JSON.parse(payloadText);
  } catch (error) {
    throw new Error(`JSONP payload JSON 파싱 실패: ${error.message}`);
  }
}

function extractSearchRows(payload) {
  const candidateArrays = [];
  collectCandidateArrays(payload, candidateArrays, 0);
  if (candidateArrays.length <= 0) {
    return [];
  }

  const flattenedRows = candidateArrays
    .sort((left, right) => right.length - left.length)
    .flatMap((rows) => rows);

  const uniqueRows = [];
  const seenKeys = new Set();
  for (const row of flattenedRows) {
    const rowKey = buildRowIdentityKey(row);
    if (!rowKey || seenKeys.has(rowKey)) {
      continue;
    }
    seenKeys.add(rowKey);
    uniqueRows.push(row);
  }

  return uniqueRows;
}

function collectCandidateArrays(value, candidateArrays, depth) {
  if (depth > 5 || value == null) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.some((row) => isSearchRowLike(row))) {
      candidateArrays.push(value.filter((row) => isSearchRowLike(row)));
      return;
    }

    value.forEach((item) => collectCandidateArrays(item, candidateArrays, depth + 1));
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  Object.values(value).forEach((nestedValue) => collectCandidateArrays(nestedValue, candidateArrays, depth + 1));
}

function isSearchRowLike(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return Boolean(
    value.board_id
    || value.title
    || value.url
    || value.url_param
    || value.gall_name,
  );
}

function buildRowIdentityKey(row) {
  const boardId = String(row?.board_id || row?.url_param?.id || '').trim();
  const postNo = String(row?.url_param?.no || '').trim();
  const title = String(row?.title || '').trim();
  const url = String(row?.url || '').trim();

  return [boardId, postNo, title, url].filter(Boolean).join('::');
}

function normalizeSearchRow(row) {
  const rawTitle = stripHtml(String(row?.title || ''));
  const decodedTitle = decodeHtmlEntities(rawTitle).trim();
  const normalizedTitle = normalizeSemiconductorRefluxTitle(decodedTitle);
  const boardId = String(row?.board_id || row?.url_param?.id || extractBoardIdFromUrl(row?.url) || '').trim();
  const postNo = normalizePostNo(row?.url_param?.no || extractPostNoFromUrl(row?.url));
  const href = normalizeHref(row?.url);
  if (!decodedTitle || !normalizedTitle || !boardId || !href) {
    return null;
  }

  return {
    title: decodedTitle,
    normalizedTitle,
    boardId,
    galleryName: decodeHtmlEntities(String(row?.gall_name || '').trim()),
    postNo,
    href,
    datetime: String(row?.datetime || '').trim(),
  };
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(value) {
  const entityMap = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: '\'',
    nbsp: ' ',
  };

  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entityBody) => {
    const normalizedEntityBody = String(entityBody || '').trim();
    if (!normalizedEntityBody) {
      return match;
    }

    if (normalizedEntityBody[0] === '#') {
      const rawCodePoint = normalizedEntityBody[1] === 'x' || normalizedEntityBody[1] === 'X'
        ? Number.parseInt(normalizedEntityBody.slice(2), 16)
        : Number.parseInt(normalizedEntityBody.slice(1), 10);
      if (!Number.isFinite(rawCodePoint)) {
        return match;
      }
      try {
        return String.fromCodePoint(rawCodePoint);
      } catch {
        return match;
      }
    }

    const mappedValue = entityMap[normalizedEntityBody.toLowerCase()];
    return mappedValue === undefined ? match : mappedValue;
  });
}

function normalizePostNo(value) {
  const normalizedValue = String(value || '').trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return 0;
  }
  return Number(normalizedValue);
}

function normalizeHref(value) {
  const rawHref = String(value || '').trim();
  if (!rawHref) {
    return '';
  }

  try {
    const baseUrl = rawHref.startsWith('/mgallery/')
      || rawHref.startsWith('/board/')
      || rawHref.startsWith('/mini/')
      ? GALL_BASE_URL
      : SEARCH_BASE_URL;
    return new URL(rawHref, baseUrl).href;
  } catch {
    return rawHref;
  }
}

function extractBoardIdFromUrl(value) {
  try {
    const resolvedUrl = new URL(String(value || ''), SEARCH_BASE_URL);
    return String(resolvedUrl.searchParams.get('id') || '').trim();
  } catch {
    return '';
  }
}

function extractPostNoFromUrl(value) {
  try {
    const resolvedUrl = new URL(String(value || ''), SEARCH_BASE_URL);
    return String(resolvedUrl.searchParams.get('no') || '').trim();
  } catch {
    return '';
  }
}

export {
  parseRefluxSearchDuplicateJsonp,
};
