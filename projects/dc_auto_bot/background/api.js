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
  googleOAuthClientId: '',
  googleCloudProjectId: '',
  geminiModel: 'gemini-2.5-flash',
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

function buildGeminiModerationPrompt(input) {
  const title = String(input?.title || '').trim();
  const body = String(input?.bodyText || '').trim();
  const reason = String(input?.reportReason || '').trim();
  const imageUrls = Array.isArray(input?.imageUrls) ? input.imageUrls.filter(Boolean) : [];
  const authorFilter = String(input?.authorFilter || '').trim() || 'unknown';
  const requestLabel = String(input?.requestLabel || '').trim();
  const targetUrl = String(input?.targetUrl || '').trim();

  const imageSection = imageUrls.length
    ? imageUrls.map((url, index) => `${index + 1}. ${url}`).join('\n')
    : '없음';

  return [
    '다음 게시물 정보를 보고, 디시 운영 규정 P1~P15 중 어떤 정책에 해당하는지 JSON으로만 답해줘.',
    '',
    '규정 분류:',
    '- P1: 디시 이용약관, 법률, 건전한 사회 통념 위반',
    '- P2: 닉언, 친목질, 사칭',
    '- P3: 분탕/어그로',
    '- P4: 종교/음모론',
    '- P5: 반과학/유사과학/직업 비하',
    '- P6: 레퍼런스 없는 선형글',
    '- P7: 설교성/일침성',
    '- P8: 팬보이/갈드컵/무인증 권위 주장',
    '- P9: 투자/주식/코인',
    '- P10: 국뽕/일뽕/중뽕/혐한/국까',
    '- P11: 정치/성별혐오/지역드립',
    '- P12: 타 갤러리/타 커뮤니티 언급',
    '- P13: 맥락 없는 욕설/싸움',
    '- P14: 금지 떡밥',
    '- P15: 개념글 제한',
    '- NONE: 해당 없음',
    '',
    '중요:',
    '- "allow"는 자동 삭제/차단을 진행해도 되는 경우에만 사용한다.',
    '- 운영 규정 위반이 아니면 반드시 "deny"를 사용한다.',
    '- 애매하거나 확신이 낮으면 "review"를 사용한다.',
    '- policy_ids가 ["NONE"]이면 decision은 반드시 "deny"여야 한다.',
    '- allow는 최소 1개 이상의 정책 위반이 명확히 성립할 때만 허용된다.',
    '',
    '출력 JSON:',
    '{',
    '  "decision": "allow|deny|review",',
    '  "confidence": 0.0,',
    '  "policy_ids": [],',
    '  "reason": ""',
    '}',
    '',
    `대상 게시물 URL:\n${targetUrl || '없음'}`,
    '',
    `작성자 필터 결과:\n${authorFilter}`,
    '',
    `신고자 label:\n${requestLabel || '없음'}`,
    '',
    `신고 사유:\n${reason || '없음'}`,
    '',
    `제목:\n${title || '없음'}`,
    '',
    `본문:\n${body || '없음'}`,
    '',
    `이미지 URL:\n${imageSection}`,
  ].join('\n');
}

async function callGeminiModeration(config = {}, accessToken, input, signal) {
  const resolved = resolveConfig(config);
  const token = String(accessToken || '').trim();
  if (!token) {
    throw new Error('Google OAuth access token이 없습니다.');
  }

  const model = String(resolved.geminiModel || 'gemini-2.5-flash').trim();
  const prompt = buildGeminiModerationPrompt(input);
  const requestBody = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
  const projectId = String(resolved.googleCloudProjectId || '').trim();
  if (projectId) {
    headers['x-goog-user-project'] = projectId;
  }

  const response = await dcFetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
    },
    1,
  );

  const responseText = await response.text();
  const raw = safeParseJson(responseText);
  if (!response.ok) {
    return {
      success: false,
      message: summarizeResponse(raw, responseText),
      rawText: responseText,
    };
  }

  const parsed = parseGeminiDecisionResponse(raw, responseText);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.message,
      rawText: responseText,
    };
  }

  return {
    success: true,
    ...parsed,
    rawText: responseText,
  };
}

function parseGeminiDecisionResponse(data, responseText) {
  const text = extractGeminiText(data) || responseText;
  const cleaned = stripJsonFences(String(text || '').trim());
  const parsed = safeParseJson(cleaned);
  if (!parsed || typeof parsed !== 'object') {
    return {
      success: false,
      message: 'Gemini 응답 JSON 파싱 실패',
    };
  }

  const decision = String(parsed.decision || '').trim();
  const confidence = Number(parsed.confidence);
  const policyIds = Array.isArray(parsed.policy_ids)
    ? parsed.policy_ids.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const reason = String(parsed.reason || '').trim();

  if (!['allow', 'deny', 'review'].includes(decision)) {
    return {
      success: false,
      message: 'decision 값이 올바르지 않습니다.',
    };
  }

  if (!Number.isFinite(confidence)) {
    return {
      success: false,
      message: 'confidence 값이 올바르지 않습니다.',
    };
  }

  if (policyIds.length === 0) {
    return {
      success: false,
      message: 'policy_ids가 비어 있습니다.',
    };
  }

  return {
    success: true,
    decision,
    confidence,
    policyIds,
    reason,
    parsed,
  };
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts.map((part) => String(part?.text || '')).join('\n').trim();
}

function stripJsonFences(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
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
  delay,
  executeDeleteAndBan,
  extractEsno,
  fetchAllComments,
  fetchComments,
  fetchRecentComments,
  fetchPostPage,
  fetchUserActivityStats,
  getCiToken,
  parseActivityStatsResponse,
  resolveConfig,
  callGeminiModeration,
  buildGeminiModerationPrompt,
};
