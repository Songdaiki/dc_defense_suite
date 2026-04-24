import { withDcRequestLease } from '../../background/dc-session-broker.js';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  headtextId: '130',
  headtextName: '',
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: '도배기IP차단(무고한 경우 문의)',
  delChk: false,
  avoidTypeChk: false,
  banBatchSize: 20,
};

async function dcFetch(url, options = {}) {
  return fetch(url, {
    credentials: 'include',
    headers: options.headers || {},
    ...options,
  });
}

async function dcFetchWithRetry(url, options = {}, maxRetries = 3) {
  const retries = Math.max(1, maxRetries);
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        await delay((attempt + 1) * 2000);
        continue;
      }

      if (response.status === 403) {
        await delay(5000);
        continue;
      }

      return response;
    } catch (error) {
      if (attempt === retries - 1) {
        lastError = error;
        break;
      }
      lastError = error;
      await delay(1000);
    }
  }

  throw new Error(
    lastError?.message
      ? `최대 재시도 횟수 초과 - ${lastError.message}`
      : '최대 재시도 횟수 초과',
  );
}

function buildBoardListUrl(config, page = 1) {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const url = new URL('/mgallery/board/lists/', resolved.baseUrl);
  url.searchParams.set('id', resolved.galleryId);
  url.searchParams.set('sort_type', 'N');
  url.searchParams.set('search_head', resolved.headtextId);
  url.searchParams.set('page', String(page));
  return url.toString();
}

function buildBlockListUrl(config, page = 1) {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const url = new URL('/mgallery/management/block', resolved.baseUrl);
  url.searchParams.set('id', resolved.galleryId);
  if (page > 1) {
    url.searchParams.set('page', String(page));
  }
  return url.toString();
}

async function fetchTargetListHTML(config, page = 1) {
  return withDcRequestLease({ feature: 'ip', kind: 'fetchTargetListHTML' }, async () => {
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const response = await dcFetchWithRetry(buildBoardListUrl(resolved, page));
    return response.text();
  });
}

async function fetchBlockListHTML(config, page = 1) {
  return withDcRequestLease({ feature: 'ip', kind: 'fetchBlockListHTML' }, async () => {
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const response = await dcFetchWithRetry(buildBlockListUrl(resolved, page));
    return response.text();
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
    console.error('[API] ci_c 쿠키 조회 실패:', error.message);
    return null;
  }
}

async function banPosts(config, postNos) {
  return withDcRequestLease({ feature: 'ip', kind: 'banPosts' }, async () => {
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const uniquePostNos = [...new Set(postNos.map((postNo) => String(postNo)))];

    if (uniquePostNos.length === 0) {
      return {
        success: true,
        successNos: [],
        failedNos: [],
        message: '차단할 게시물이 없습니다.',
      };
    }

    const ciToken = await getCiToken(resolved.baseUrl);
    if (!ciToken) {
      return {
        success: false,
        successNos: [],
        failedNos: uniquePostNos,
        message: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      };
    }

    const chunks = chunkArray(uniquePostNos, resolved.banBatchSize);
    const aggregate = {
      successNos: [],
      failedNos: [],
      messages: [],
    };

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const result = await banPostsWithFallback(resolved, ciToken, chunk);
      aggregate.successNos.push(...result.successNos);
      if (result.message) {
        aggregate.messages.push(result.message);
      }

      if (result.deleteLimitExceeded) {
        const remainingNos = dedupePostNos([
          ...result.deleteLimitExceededNos,
          ...chunks.slice(index + 1).flat(),
        ]);
        aggregate.failedNos.push(...remainingNos);

        return {
          success: false,
          successNos: dedupePostNos(aggregate.successNos),
          failedNos: dedupePostNos(aggregate.failedNos),
          message: aggregate.messages.join(' | '),
          failureType: 'delete_limit_exceeded',
          deleteLimitExceeded: true,
          deleteLimitExceededNos: remainingNos,
        };
      }

      aggregate.failedNos.push(...result.failedNos);
    }

    return {
      success: aggregate.failedNos.length === 0,
      successNos: dedupePostNos(aggregate.successNos),
      failedNos: dedupePostNos(aggregate.failedNos),
      message: aggregate.messages.join(' | '),
      failureType: '',
      deleteLimitExceeded: false,
      deleteLimitExceededNos: [],
    };
  });
}

async function banPostsWithFallback(config, ciToken, postNos) {
  const batchResult = await banPostBatch(config, ciToken, postNos);

  if (batchResult.success) {
    return {
      successNos: [...postNos],
      failedNos: [],
      message: '',
      failureType: '',
      deleteLimitExceeded: false,
      deleteLimitExceededNos: [],
    };
  }

  if (postNos.length === 1 || batchResult.shouldSplit === false) {
    const deleteLimitExceeded = batchResult.failureType === 'delete_limit_exceeded';
    return {
      successNos: [],
      failedNos: [...postNos],
      message: batchResult.message,
      failureType: batchResult.failureType,
      deleteLimitExceeded,
      deleteLimitExceededNos: deleteLimitExceeded ? [...postNos] : [],
    };
  }

  const middleIndex = Math.ceil(postNos.length / 2);
  const leftResult = await banPostsWithFallback(config, ciToken, postNos.slice(0, middleIndex));
  if (leftResult.deleteLimitExceeded) {
    const rightNos = postNos.slice(middleIndex);
    return {
      successNos: [...leftResult.successNos],
      failedNos: dedupePostNos([...leftResult.failedNos, ...rightNos]),
      message: leftResult.message,
      failureType: leftResult.failureType,
      deleteLimitExceeded: true,
      deleteLimitExceededNos: dedupePostNos([...leftResult.deleteLimitExceededNos, ...rightNos]),
    };
  }

  const rightResult = await banPostsWithFallback(config, ciToken, postNos.slice(middleIndex));

  return {
    successNos: [...leftResult.successNos, ...rightResult.successNos],
    failedNos: dedupePostNos([...leftResult.failedNos, ...rightResult.failedNos]),
    message: [leftResult.message, rightResult.message].filter(Boolean).join(' | '),
    failureType: rightResult.failureType || leftResult.failureType,
    deleteLimitExceeded: rightResult.deleteLimitExceeded,
    deleteLimitExceededNos: [...rightResult.deleteLimitExceededNos],
  };
}

async function banPostBatch(config, ciToken, postNos) {
  const body = new URLSearchParams();
  body.set('ci_t', ciToken);
  body.set('id', config.galleryId);
  body.set('parent', '');
  body.set('avoid_hour', String(config.avoidHour));
  body.set('avoid_reason', String(config.avoidReason));
  body.set('avoid_reason_txt', config.avoidReasonText || '');
  body.set('del_chk', config.delChk ? '1' : '0');
  body.set('_GALLTYPE_', config.galleryType);
  body.set('avoid_type_chk', config.avoidTypeChk ? '1' : '0');

  for (const postNo of postNos) {
    body.append('nos[]', String(postNo));
  }

  const response = await dcFetchWithRetry(
    `${config.baseUrl}/ajax/minor_manager_board_ajax/update_avoid_list`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': buildBoardListUrl(config, 1),
        'Origin': config.baseUrl,
      },
      body: body.toString(),
    },
  );

  const responseText = await response.text();
  const parsed = safeParseJson(responseText);
  const failureType = inferBanFailureType(response, parsed, responseText);

  return {
    success: isBanResponseSuccessful(response, parsed, responseText),
    message: summarizeResponse(parsed, responseText),
    rawText: summarizeText(responseText),
    failureType,
    shouldSplit: shouldSplitBanFailure(response, responseText, failureType),
  };
}

async function releaseBan(config, releaseId) {
  return releaseBans(config, [releaseId]);
}

async function releaseBans(config, releaseIds) {
  return withDcRequestLease({ feature: 'ip', kind: 'releaseBans' }, async () => {
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const normalizedTargets = normalizeReleaseTargets(releaseIds);
    const uniqueTargets = dedupeReleaseTargets(normalizedTargets);

    if (uniqueTargets.length === 0) {
      return {
        success: true,
        releasedIds: [],
        failedIds: [],
        message: '해제할 대상이 없습니다.',
      };
    }

    const ciToken = await getCiToken(resolved.baseUrl);
    if (!ciToken) {
      return {
        success: false,
        releasedIds: [],
        failedIds: uniqueTargets.map((target) => target.releaseId),
        message: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      };
    }

    const anoValues = [...new Set(uniqueTargets.map((target) => String(target.ano ?? '0')))];
    if (anoValues.length > 1) {
      return {
        success: false,
        releasedIds: [],
        failedIds: uniqueTargets.map((target) => target.releaseId),
        message: 'ano 값이 서로 다른 해제 요청은 한 번에 처리할 수 없습니다.',
      };
    }

    const body = new URLSearchParams();
    body.set('ci_t', ciToken);
    body.set('gallery_id', resolved.galleryId);
    body.set('_GALLTYPE_', resolved.galleryType);
    body.set('avoid_type', 'R');
    body.set('ano', anoValues[0] || '0');

    for (const target of uniqueTargets) {
      body.append('nos[]', String(target.releaseId));
    }

    const response = await dcFetchWithRetry(
      `${resolved.baseUrl}/ajax/managements_ajax/set_avoid`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': buildBlockListUrl(resolved, 1),
          'Origin': resolved.baseUrl,
        },
        body: body.toString(),
      },
    );

    const responseText = await response.text();
    const parsed = safeParseJson(responseText);
    const success = isReleaseResponseSuccessful(response, parsed, responseText);

    return {
      success,
      releasedIds: success ? uniqueTargets.map((target) => target.releaseId) : [],
      failedIds: success ? [] : uniqueTargets.map((target) => target.releaseId),
      message: summarizeResponse(parsed, responseText),
    };
  });
}

function isBanResponseSuccessful(response, data, responseText) {
  if (!response.ok) {
    return false;
  }

  if (Array.isArray(data) && data[0]?.result === 'success') {
    return true;
  }

  if (data?.result === 'success') {
    return true;
  }

  return responseText.includes('"result":"success"');
}

function shouldSplitBanFailure(response, responseText, failureType = '') {
  if (failureType === 'delete_limit_exceeded') {
    return false;
  }

  if (!response.ok) {
    return response.status !== 403 && response.status !== 429;
  }

  const hardFailurePatterns = [
    'ci_t',
    '권한',
    '로그인',
    '차단',
    '정상적인 접근이 아닙니다',
  ];

  return !hardFailurePatterns.some((pattern) => responseText.includes(pattern));
}

function inferBanFailureType(response, data, responseText) {
  const normalizedText = normalizeFailureText(data, responseText);

  if (isDeleteLimitExceededText(normalizedText)) {
    return 'delete_limit_exceeded';
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return 'auth_or_permission';
    }
    return 'http_error';
  }

  if (/(정상적인접근이아닙니다|권한|로그인|forbidden|denied|ci_t)/i.test(normalizedText)) {
    return 'auth_or_permission';
  }

  return 'unknown';
}

function isReleaseResponseSuccessful(response, data, responseText) {
  if (!response.ok) {
    return false;
  }

  if (data?.result === 'success') {
    return true;
  }

  return responseText.includes('"result":"success"');
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeResponse(data, responseText) {
  if (!data) {
    return summarizeText(responseText);
  }

  if (Array.isArray(data)) {
    return data
      .map((item) => {
        if (item?.msg) {
          return String(item.msg);
        }
        return JSON.stringify(item);
      })
      .join(' | ');
  }

  if (data.msg) {
    return String(data.msg);
  }

  return JSON.stringify(data);
}

function summarizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function normalizeFailureText(data, responseText) {
  const summarized = summarizeResponse(data, responseText);
  return String(summarized || responseText || '')
    .replace(/\s+/g, '')
    .trim();
}

function isDeleteLimitExceededText(value) {
  return /(일일.*(삭제|차단)횟수.*초과.*(삭제|차단)할수없|추가.*(삭제|차단).*신고게시판.*문의)/i.test(String(value || ''));
}

function chunkArray(items, chunkSize) {
  const normalizedChunkSize = Math.max(1, Number(chunkSize) || 1);
  const chunks = [];

  for (let index = 0; index < items.length; index += normalizedChunkSize) {
    chunks.push(items.slice(index, index + normalizedChunkSize));
  }

  return chunks;
}

function dedupePostNos(postNos) {
  return [...new Set(
    (Array.isArray(postNos) ? postNos : [])
      .map((postNo) => String(postNo || '').trim())
      .filter((postNo) => /^\d+$/.test(postNo)),
  )];
}

function normalizeReleaseTargets(releaseIds) {
  return releaseIds
    .map((target) => {
      if (typeof target === 'object' && target !== null) {
        return {
          releaseId: String(target.releaseId ?? ''),
          ano: String(target.ano ?? '0'),
        };
      }

      return {
        releaseId: String(target ?? ''),
        ano: '0',
      };
    })
    .filter((target) => target.releaseId);
}

function dedupeReleaseTargets(targets) {
  const seen = new Set();
  const deduped = [];

  for (const target of targets) {
    const key = `${target.releaseId}:${target.ano}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  DEFAULT_CONFIG,
  buildBoardListUrl,
  buildBlockListUrl,
  chunkArray,
  delay,
  fetchBlockListHTML,
  fetchTargetListHTML,
  banPosts,
  releaseBan,
  releaseBans,
};
