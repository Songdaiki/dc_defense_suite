import { withDcRequestLease } from '../../background/dc-session-broker.js';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
};

function resolveConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
  };
}

async function dcFetch(url, options = {}) {
  return fetch(url, {
    credentials: 'include',
    headers: options.headers || {},
    ...options,
  });
}

async function dcFetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        if (attempt === maxRetries - 1) {
          return response;
        }
        await delay((attempt + 1) * 2000);
        continue;
      }

      if (response.status === 403) {
        if (attempt === maxRetries - 1) {
          return response;
        }
        await delay(30000);
        continue;
      }

      return response;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }

      if (attempt === maxRetries - 1) {
        throw error;
      }

      await delay(1000);
    }
  }

  throw new Error('[ConceptMonitor API] 최대 재시도 횟수 초과');
}

async function fetchConceptListHTML(config = {}) {
  return fetchConceptListPageHTML(config, 1, 'conceptMonitor');
}

async function fetchConceptListPageHTML(config = {}, page = 1, leaseFeature = 'conceptPatrol') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'fetchConceptListHTML' }, async () => {
    const resolved = resolveConfig(config);
    const normalizedPage = Math.max(1, Number(page) || 1);
    const url = new URL('/mgallery/board/lists/', resolved.baseUrl);
    url.searchParams.set('id', resolved.galleryId);
    url.searchParams.set('exception_mode', 'recommend');
    url.searchParams.set('page', String(normalizedPage));

    const response = await dcFetchWithRetry(url.toString());
    const html = await response.text();
    assertValidHtmlResponse(response, html, {
      label: `개념글 목록 페이지 ${normalizedPage}`,
      shapeCheck: looksLikeConceptListHtml,
    });

    return html;
  });
}

async function fetchBoardListHTML(config = {}) {
  return withDcRequestLease({ feature: 'conceptMonitor', kind: 'fetchBoardListHTML' }, async () => {
    const resolved = resolveConfig(config);
    const url = new URL('/mgallery/board/lists/', resolved.baseUrl);
    url.searchParams.set('id', resolved.galleryId);

    const response = await dcFetchWithRetry(url.toString());
    const html = await response.text();
    assertValidHtmlResponse(response, html, {
      label: '전체글 목록 페이지',
      shapeCheck: looksLikeBoardListHtml,
    });

    return html;
  });
}

async function fetchConceptPostViewHTML(config = {}, postNo, leaseFeature = 'conceptMonitor') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'fetchConceptPostViewHTML' }, async () => {
    const resolved = resolveConfig(config);
    const url = buildPostViewUrl(resolved, postNo);
    const response = await dcFetchWithRetry(url);
    const html = await response.text();
    assertValidHtmlResponse(response, html, {
      label: '게시물 페이지',
      shapeCheck: looksLikeBoardViewHtml,
    });

    return html;
  });
}

async function releaseConceptPost(config = {}, postNo, leaseFeature = 'conceptMonitor') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'releaseConceptPost' }, async () => {
    const resolved = resolveConfig(config);
    const ciToken = await getCiToken(resolved.baseUrl);

    if (!ciToken) {
      return {
        success: false,
        status: 0,
        rawText: '',
        rawSummary: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      };
    }

    const body = new URLSearchParams();
    body.set('ci_t', ciToken);
    body.set('id', resolved.galleryId);
    body.append('nos[]', String(postNo));
    body.set('_GALLTYPE_', resolved.galleryType);
    body.set('mode', 'REL');

    const response = await dcFetchWithRetry(
      `${resolved.baseUrl}/ajax/minor_manager_board_ajax/set_recommend`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': resolved.baseUrl,
          'Referer': buildPostViewUrl(resolved, postNo),
        },
        body: body.toString(),
      },
      1,
    );

    const rawText = await response.text();

    return {
      success: response.status === 200,
      status: response.status,
      rawText,
      rawSummary: summarizeResponseText(rawText),
    };
  });
}

async function updateRecommendCut(config = {}, recommendCount, leaseFeature = 'conceptRecommendCut') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'updateRecommendCut' }, async () => {
    const resolved = resolveConfig(config);
    const ciToken = await getCiToken(resolved.baseUrl);

    if (!ciToken) {
      return {
        success: false,
        status: 0,
        result: '',
        rawText: '',
        rawSummary: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      };
    }

    const body = new URLSearchParams();
    body.set('ci_t', ciToken);
    body.set('gallery_id', resolved.galleryId);
    body.set('_GALLTYPE_', resolved.galleryType);
    body.set('decom_use', '0');
    body.set('recom_down_use', '0');
    body.set('recom_count', String(recommendCount));
    body.set('decom_count', '0');

    const response = await dcFetchWithRetry(
      `${resolved.baseUrl}/ajax/managements_ajax/update_recom_decom`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': resolved.baseUrl,
          'Referer': `${resolved.baseUrl}/mgallery/management/gallery?id=${encodeURIComponent(resolved.galleryId)}`,
        },
        body: body.toString(),
      },
      1,
    );

    const rawText = await response.text();
    const parsed = parseJsonResponse(rawText);
    const result = String(parsed?.result || '').trim();

    return {
      success: response.status === 200 && result === 'success',
      status: response.status,
      result,
      rawText,
      rawSummary: summarizeResponseText(rawText),
    };
  });
}

async function getCiToken(baseUrl = DEFAULT_CONFIG.baseUrl) {
  try {
    const cookie = await chrome.cookies.get({
      url: baseUrl,
      name: 'ci_c',
    });
    return cookie ? cookie.value : null;
  } catch (error) {
    console.error('[ConceptMonitor API] ci_c 쿠키 조회 실패:', error.message);
    return null;
  }
}

function buildPostViewUrl(config, postNo) {
  const url = new URL('/mgallery/board/view/', config.baseUrl);
  url.searchParams.set('id', config.galleryId);
  url.searchParams.set('no', String(postNo));
  return url.toString();
}

function assertValidHtmlResponse(response, html, { label, shapeCheck }) {
  const htmlText = String(html || '');

  if (htmlText.includes('정상적인 접근이 아닙니다')) {
    throw new Error(`${label} 접근 차단 응답을 받았습니다`);
  }

  if (!htmlText.trim()) {
    throw new Error(`${label} 빈 응답을 받았습니다`);
  }

  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status} / raw: ${summarizeResponseText(htmlText)}`);
  }

  if (!looksLikeHtmlDocument(htmlText)) {
    throw new Error(`${label} 비정상 HTML 응답 / raw: ${summarizeResponseText(htmlText)}`);
  }

  if (typeof shapeCheck === 'function' && !shapeCheck(htmlText)) {
    throw new Error(`${label} 형태 검증 실패 / raw: ${summarizeResponseText(htmlText)}`);
  }
}

function looksLikeHtmlDocument(htmlText) {
  return /<html[\s>]/i.test(htmlText) && /<\/html>/i.test(htmlText);
}

function looksLikeConceptListHtml(htmlText) {
  const normalized = String(htmlText || '');
  return hasAnyMarker(normalized, [
    '/mgallery/board/lists/?id=',
    'class="gall_recommend"',
    'class="ub-content',
    'class="gall_listwrap',
  ]);
}

function looksLikeBoardListHtml(htmlText) {
  const normalized = String(htmlText || '');
  return hasAnyMarker(normalized, [
    '/mgallery/board/lists/?id=',
    'class="gall_recommend"',
    'class="ub-content',
    'class="gall_listwrap',
  ]);
}

function looksLikeBoardViewHtml(htmlText) {
  const normalized = String(htmlText || '');
  return hasAnyMarker(normalized, [
    '/mgallery/board/view/?id=',
    'class="btn_recommend_box',
    'id="recommend"',
    'class="view_content_wrap',
    'class="write_div',
  ]);
}

function hasAnyMarker(text, markers) {
  return markers.some((marker) => String(text || '').includes(marker));
}

function summarizeResponseText(responseText) {
  const normalized = String(responseText || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '<empty>';
  }

  try {
    return JSON.stringify(JSON.parse(normalized)).slice(0, 200);
  } catch {
    return normalized.slice(0, 200);
  }
}

function parseJsonResponse(responseText) {
  try {
    return JSON.parse(String(responseText || '').trim());
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  DEFAULT_CONFIG,
  delay,
  fetchBoardListHTML,
  fetchConceptListHTML,
  fetchConceptListPageHTML,
  fetchConceptPostViewHTML,
  releaseConceptPost,
  resolveConfig,
  updateRecommendCut,
};
