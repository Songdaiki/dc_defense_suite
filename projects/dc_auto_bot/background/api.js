const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  reportTarget: '',
  reportPostNo: '0',
  pollIntervalMs: 60000,
  trustedUsers: [],
  dailyLimitPerUser: 2,
  commandPrefix: '@특갤봇',
  avoidHour: '6',
  avoidReason: '0',
  avoidTypeChk: true,
  deleteTargetPost: true,
  applyAuthorFilter: true,
  lowActivityThreshold: 100,
  cliHelperEndpoint: 'http://127.0.0.1:4317/judge',
  cliHelperTimeoutMs: 90000,
  llmConfidenceThreshold: 0.85,
};

const VALID_DECISIONS = new Set(['allow', 'deny', 'review']);
const VALID_POLICY_IDS = new Set([
  'NONE',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
  'P12',
  'P13',
  'P14',
  'P15',
]);

function resolveConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
  };
}

function normalizeCliHelperEndpoint(value) {
  const rawValue = String(value || '').trim();
  const candidate = rawValue || DEFAULT_CONFIG.cliHelperEndpoint;

  let url = null;
  try {
    url = new URL(candidate);
  } catch {
    return {
      success: false,
      message: 'CLI helper endpoint 형식이 올바르지 않습니다.',
    };
  }

  if (url.protocol !== 'http:') {
    return {
      success: false,
      message: 'CLI helper endpoint는 http://localhost 또는 http://127.0.0.1 주소만 허용됩니다.',
    };
  }

  const normalizedHost = String(url.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(normalizedHost)) {
    return {
      success: false,
      message: 'CLI helper endpoint는 localhost 계열 주소만 허용됩니다.',
    };
  }

  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/judge';
  }

  url.search = '';
  url.hash = '';

  return {
    success: true,
    endpoint: url.toString(),
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
  const retries = Math.max(1, Number(maxRetries) || 1);
  const signal = options?.signal;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        await delayWithSignal((attempt + 1) * 2000, signal);
        continue;
      }

      if (response.status === 403) {
        await delayWithSignal(5000, signal);
        continue;
      }

      return response;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }

      if (attempt === retries - 1) {
        throw error;
      }

      await delayWithSignal(1000, signal);
    }
  }

  throw new Error('최대 재시도 횟수 초과');
}

async function fetchPostPage(config = {}, postNo, signal) {
  const resolved = resolveConfig(config);
  const url = `${resolved.baseUrl}/mgallery/board/view/?id=${resolved.galleryId}&no=${postNo}`;
  const response = await dcFetchWithRetry(url, { signal });
  const html = await response.text();

  if (html.includes('정상적인 접근이 아닙니다')) {
    throw new Error('게시물 페이지 접근 차단 응답을 받았습니다');
  }

  return html;
}

function extractEsno(html) {
  const variableMatch = html.match(/e_s_n_o\s*=\s*['"]([^'"]+)['"]/);
  if (variableMatch) {
    return variableMatch[1];
  }

  const inputMatch = html.match(/name=['"]e_s_n_o['"][^>]*value=['"]([^'"]+)['"]/);
  if (inputMatch) {
    return inputMatch[1];
  }

  const dataMatch = html.match(/data-esno=['"]([^'"]+)['"]/);
  if (dataMatch) {
    return dataMatch[1];
  }

  return null;
}

async function fetchComments(config = {}, postNo, esno, commentPage = 1, signal) {
  const resolved = resolveConfig(config);
  const url = `${resolved.baseUrl}/board/comment/`;
  const body = new URLSearchParams({
    id: resolved.galleryId,
    no: String(postNo),
    cmt_id: resolved.galleryId,
    cmt_no: String(postNo),
    e_s_n_o: esno,
    comment_page: String(commentPage),
    sort: 'D',
    _GALLTYPE_: resolved.galleryType,
  });

  const response = await dcFetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${resolved.baseUrl}/mgallery/board/view/?id=${resolved.galleryId}&no=${postNo}`,
    },
    body: body.toString(),
    signal,
  });

  const data = await response.json();

  return {
    comments: data.comments || [],
    totalCnt: Number(data.total_cnt || 0),
  };
}

async function fetchAllComments(config = {}, postNo, esno, pageConcurrency = 4, signal) {
  const firstPage = await fetchComments(config, postNo, esno, 1, signal);
  const allComments = [...firstPage.comments];
  const firstPageSize = firstPage.comments.length || 20;
  const totalPages = Math.max(1, Math.ceil(firstPage.totalCnt / firstPageSize));

  if (totalPages > 1) {
    const pageNumbers = [];
    for (let page = 2; page <= totalPages; page += 1) {
      pageNumbers.push(page);
    }

    const pageResults = await mapWithConcurrency(
      pageNumbers,
      pageConcurrency,
      async (page) => fetchComments(config, postNo, esno, page, signal),
    );

    for (const pageResult of pageResults) {
      allComments.push(...pageResult.comments);
    }
  }

  return {
    comments: allComments,
    totalCnt: firstPage.totalCnt,
  };
}

async function fetchRecentComments(config = {}, postNo, esno, maxPages = 2, signal) {
  const firstPage = await fetchComments(config, postNo, esno, 1, signal);
  const allComments = [...firstPage.comments];
  const firstPageSize = firstPage.comments.length || 20;
  const totalPages = Math.max(1, Math.ceil(firstPage.totalCnt / firstPageSize));
  const pagesToFetch = Math.max(1, Math.min(Number(maxPages) || 1, totalPages));

  if (pagesToFetch > 1) {
    const pageNumbers = [];
    for (let page = 2; page <= pagesToFetch; page += 1) {
      pageNumbers.push(page);
    }

    const pageResults = await mapWithConcurrency(
      pageNumbers,
      Math.min(2, pageNumbers.length || 1),
      async (page) => fetchComments(config, postNo, esno, page, signal),
    );

    for (const pageResult of pageResults) {
      allComments.push(...pageResult.comments);
    }
  }

  return {
    comments: allComments,
    totalCnt: firstPage.totalCnt,
    fetchedPages: pagesToFetch,
  };
}

async function getCiToken(baseUrl = DEFAULT_CONFIG.baseUrl) {
  try {
    const cookie = await chrome.cookies.get({
      url: baseUrl,
      name: 'ci_c',
    });
    return cookie ? cookie.value : null;
  } catch (error) {
    console.error('[AutoBot] ci_c 쿠키 조회 실패:', error.message);
    return null;
  }
}

function buildReasonText(label, rawReasonText = '') {
  const safeReason = String(rawReasonText || '').trim();
  const maxLength = 20;
  const suffix = ' 특갤봇차단';
  const separator = ':';
  let safeLabel = String(label || '').trim().slice(0, maxLength) || '신문고봇';

  let candidate = `${safeLabel}${suffix}`;
  if (safeReason) {
    const fullCandidate = `${candidate}${separator}${safeReason}`;
    if (fullCandidate.length <= maxLength) {
      return fullCandidate;
    }

    const remainingLength = maxLength - candidate.length - separator.length;
    if (remainingLength > 0) {
      return `${candidate}${separator}${safeReason.slice(0, remainingLength)}`;
    }
  }

  if (candidate.length <= maxLength) {
    return candidate;
  }

  const labelBudget = Math.max(0, maxLength - suffix.length);
  safeLabel = safeLabel.slice(0, labelBudget);
  candidate = `${safeLabel}${suffix}`;
  return candidate.slice(0, maxLength);
}

async function fetchUserActivityStats(config = {}, uid, signal) {
  const resolved = resolveConfig(config);
  const normalizedUid = String(uid || '').trim();

  if (!normalizedUid) {
    return {
      success: false,
      uid: normalizedUid,
      message: '식별코드(uid) 없음',
    };
  }

  const ciToken = await getCiToken(resolved.baseUrl);
  if (!ciToken) {
    return {
      success: false,
      uid: normalizedUid,
      message: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
    };
  }

  const body = new URLSearchParams();
  body.set('ci_t', ciToken);
  body.set('user_id', normalizedUid);

  const response = await dcFetchWithRetry(
    `${resolved.baseUrl}/api/gallog_user_layer/gallog_content_reple/`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${resolved.baseUrl}/mgallery/board/lists/?id=${resolved.galleryId}`,
        'Origin': resolved.baseUrl,
      },
      body: body.toString(),
      signal,
    },
  );

  const responseText = await response.text();
  if (!response.ok) {
    return {
      success: false,
      uid: normalizedUid,
      message: summarizeResponse(null, responseText) || `HTTP ${response.status}`,
    };
  }

  const parsed = parseActivityStatsResponse(responseText);
  if (!parsed.success) {
    return {
      success: false,
      uid: normalizedUid,
      message: parsed.message,
    };
  }

  return {
    success: true,
    uid: normalizedUid,
    postCount: parsed.postCount,
    commentCount: parsed.commentCount,
    totalActivityCount: parsed.totalActivityCount,
  };
}

function parseActivityStatsResponse(responseText) {
  const normalized = String(responseText || '').trim();
  const numberMatches = normalized.match(/\d+/g) || [];
  if (numberMatches.length < 2) {
    return {
      success: false,
      message: `응답 파싱 실패: ${normalized.slice(0, 120)}`,
    };
  }

  const postCount = parseInt(numberMatches[0], 10);
  const commentCount = parseInt(numberMatches[1], 10);
  if (!Number.isInteger(postCount) || !Number.isInteger(commentCount) || postCount < 0 || commentCount < 0) {
    return {
      success: false,
      message: `응답 파싱 실패: ${normalized.slice(0, 120)}`,
    };
  }

  return {
    success: true,
    postCount,
    commentCount,
    totalActivityCount: postCount + commentCount,
  };
}

async function executeDeleteAndBan(config = {}, targetPostNo, label, rawReasonText, signal) {
  const resolved = resolveConfig(config);
  const ciToken = await getCiToken(resolved.baseUrl);

  if (!ciToken) {
    return {
      success: false,
      message: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      reasonText: '',
    };
  }

  const reasonText = buildReasonText(label, rawReasonText);
  const body = new URLSearchParams();
  body.set('ci_t', ciToken);
  body.set('id', resolved.galleryId);
  body.set('parent', '');
  body.set('avoid_hour', String(resolved.avoidHour));
  body.set('avoid_reason', String(resolved.avoidReason));
  body.set('avoid_reason_txt', reasonText);
  body.set('del_chk', resolved.deleteTargetPost ? '1' : '0');
  body.set('_GALLTYPE_', resolved.galleryType);
  body.set('avoid_type_chk', resolved.avoidTypeChk ? '1' : '0');
  body.append('nos[]', String(targetPostNo));

  const response = await dcFetchWithRetry(
    `${resolved.baseUrl}/ajax/minor_manager_board_ajax/update_avoid_list`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${resolved.baseUrl}/mgallery/board/lists/?id=${resolved.galleryId}`,
        'Origin': resolved.baseUrl,
      },
      body: body.toString(),
      signal,
    },
  );

  const responseText = await response.text();
  const parsed = safeParseJson(responseText);

  return {
    success: isAvoidResponseSuccessful(response, parsed, responseText),
    message: summarizeResponse(parsed, responseText),
    reasonText,
  };
}

async function callCliHelperJudge(config = {}, input, signal) {
  const resolved = resolveConfig(config);
  const endpointResult = normalizeCliHelperEndpoint(resolved.cliHelperEndpoint);
  if (!endpointResult.success) {
    return {
      success: false,
      message: endpointResult.message,
      rawText: '',
    };
  }

  const requestBody = {
    targetUrl: String(input?.targetUrl || '').trim(),
    title: String(input?.title || '').trim(),
    bodyText: String(input?.bodyText || '').trim(),
    imageUrls: Array.isArray(input?.imageUrls)
      ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
    reportReason: String(input?.reportReason || '').trim(),
    requestLabel: String(input?.requestLabel || '').trim(),
    authorFilter: String(input?.authorFilter || '').trim() || 'unknown',
  };

  const timeoutMs = Math.max(1000, Number(resolved.cliHelperTimeoutMs) || DEFAULT_CONFIG.cliHelperTimeoutMs);
  const requestController = new AbortController();
  let didTimeout = false;
  let timeoutId = 0;
  let abortListener = null;

  if (signal) {
    if (signal.aborted) {
      requestController.abort();
    } else {
      abortListener = () => requestController.abort();
      signal.addEventListener('abort', abortListener, { once: true });
    }
  }

  timeoutId = setTimeout(() => {
    didTimeout = true;
    requestController.abort();
  }, timeoutMs);

  try {
    const response = await dcFetchWithRetry(
      endpointResult.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: requestController.signal,
      },
      1,
    );

    const responseText = await response.text();
    const raw = safeParseJson(responseText);
    if (!response.ok) {
      return {
        success: false,
        message: summarizeResponse(raw, responseText) || `HTTP ${response.status}`,
        rawText: responseText,
      };
    }

    const parsed = parseCliHelperJudgeResponse(raw, responseText);
    if (!parsed.success) {
      return {
        success: false,
        message: parsed.message,
        rawText: parsed.rawText || responseText,
      };
    }

    return {
      success: true,
      decision: parsed.decision,
      confidence: parsed.confidence,
      policy_ids: parsed.policy_ids,
      reason: parsed.reason,
      rawText: parsed.rawText || responseText,
    };
  } catch (error) {
    if (error?.name === 'AbortError' && didTimeout) {
      return {
        success: false,
        message: 'CLI helper 응답 대기 시간이 초과되었습니다.',
        rawText: '',
      };
    }

    if (error?.name === 'AbortError') {
      throw error;
    }

    return {
      success: false,
      message: `CLI helper 연결 실패: ${error.message}`,
      rawText: '',
    };
  } finally {
    clearTimeout(timeoutId);
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

function parseCliHelperJudgeResponse(data, responseText) {
  if (!data || typeof data !== 'object') {
    return {
      success: false,
      message: 'CLI helper 응답 JSON 파싱 실패',
      rawText: String(responseText || ''),
    };
  }

  const success = data.success;
  const rawText = data.rawText == null ? String(responseText || '') : String(data.rawText);
  if (success !== true) {
    return {
      success: false,
      message: String(data.message || 'CLI helper 판정 실패'),
      rawText,
    };
  }

  return parseModerationDecisionPayload(data, rawText);
}

function parseModerationDecisionPayload(data, rawText = '') {
  const decision = String(data.decision || '').trim().toLowerCase();
  const confidence = Number(data.confidence);
  const rawPolicyIds = Array.isArray(data.policy_ids)
    ? data.policy_ids
    : (Array.isArray(data.policyIds) ? data.policyIds : []);
  const policyIds = [...new Set(
    rawPolicyIds
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean),
  )];
  const reason = String(data.reason || '').trim();

  if (!VALID_DECISIONS.has(decision)) {
    return {
      success: false,
      message: 'decision 값이 올바르지 않습니다.',
      rawText,
    };
  }

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      success: false,
      message: 'confidence 값이 올바르지 않습니다.',
      rawText,
    };
  }

  if (policyIds.length === 0) {
    return {
      success: false,
      message: 'policy_ids가 비어 있습니다.',
      rawText,
    };
  }

  if (policyIds.some((policyId) => !VALID_POLICY_IDS.has(policyId))) {
    return {
      success: false,
      message: 'policy_ids에 허용되지 않은 값이 포함되어 있습니다.',
      rawText,
    };
  }

  if (!reason) {
    return {
      success: false,
      message: 'reason 값이 비어 있습니다.',
      rawText,
    };
  }

  const hasNone = policyIds.includes('NONE');
  if (hasNone && policyIds.length > 1) {
    return {
      success: false,
      message: 'policy_ids에 NONE과 다른 정책이 동시에 포함될 수 없습니다.',
      rawText,
    };
  }

  if (hasNone && decision !== 'deny') {
    return {
      success: false,
      message: 'policy_ids가 ["NONE"]이면 decision은 deny여야 합니다.',
      rawText,
    };
  }

  if (decision === 'allow' && policyIds.length === 1 && policyIds[0] === 'P15') {
    return {
      success: false,
      message: 'P15 단독 allow는 자동 삭제/차단 대상으로 처리할 수 없습니다.',
      rawText,
    };
  }

  if (!hasNone && decision === 'allow' && policyIds.length < 1) {
    return {
      success: false,
      message: 'allow 결정에는 최소 1개 이상의 정책 ID가 필요합니다.',
      rawText,
    };
  }

  return {
    success: true,
    decision,
    confidence,
    policyIds,
    policy_ids: policyIds,
    reason,
    rawText,
  };
}

function isAvoidResponseSuccessful(response, data, responseText) {
  if (!response.ok) {
    return false;
  }

  if (Array.isArray(data) && data[0]?.result === 'success') {
    return true;
  }

  if (data?.result === 'success') {
    return true;
  }

  return String(responseText || '').includes('"result":"success"');
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeResponse(data, responseText) {
  if (data?.msg) {
    return String(data.msg);
  }

  if (Array.isArray(data)) {
    return data.map((entry) => entry?.msg || JSON.stringify(entry)).join(' | ');
  }

  if (data) {
    return JSON.stringify(data);
  }

  return String(responseText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (items.length === 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayWithSignal(ms, signal) {
  if (!signal) {
    return delay(ms);
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export {
  DEFAULT_CONFIG,
  buildReasonText,
  callCliHelperJudge,
  delay,
  executeDeleteAndBan,
  extractEsno,
  fetchAllComments,
  fetchComments,
  fetchRecentComments,
  fetchPostPage,
  fetchUserActivityStats,
  getCiToken,
  normalizeCliHelperEndpoint,
  parseActivityStatsResponse,
  parseCliHelperJudgeResponse,
  parseModerationDecisionPayload,
  resolveConfig,
};
