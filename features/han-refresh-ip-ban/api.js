import { withDcRequestLease } from '../../background/dc-session-broker.js';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  requestDelay: 500,
  fallbackMaxPage: 400,
  cycleIntervalMs: 5 * 60 * 60 * 1000,
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: '도배기로 인한 해당 유동IP차단',
};

async function delay(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (waitMs <= 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, waitMs);
  });
}

async function dcFetch(url, options = {}) {
  return fetch(url, {
    credentials: 'include',
    headers: options.headers || {},
    ...options,
  });
}

async function dcFetchWithRetry(url, options = {}, maxRetries = 2) {
  const retries = Math.max(1, Number(maxRetries) || 1);
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        lastError = new Error('HTTP 429');
        await delay((attempt + 1) * 2000);
        continue;
      }

      if (response.status === 403) {
        lastError = new Error('HTTP 403');
        await delay(5000);
        continue;
      }

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < retries - 1) {
          await delay(1000);
          continue;
        }
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await delay(1000);
        continue;
      }
    }
  }

  throw new Error(lastError?.message || '최대 재시도 횟수 초과');
}

function buildManagementBlockUrl(config, page = 1) {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  const url = new URL('/mgallery/management/block', resolved.baseUrl);
  url.searchParams.set('id', resolved.galleryId);
  url.searchParams.set('s', '');
  url.searchParams.set('t', 'u');
  url.searchParams.set('p', String(Math.max(1, Number(page) || 1)));
  return url.toString();
}

async function fetchManagementBlockHTML(config, page = 1, maxRetries = 2) {
  return withDcRequestLease({ feature: 'hanRefreshIpBan', kind: 'fetchManagementBlockHTML' }, async () => {
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const response = await dcFetchWithRetry(
      buildManagementBlockUrl(resolved, page),
      {},
      maxRetries,
    );
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
    console.error('[HanRefreshIpBanAPI] ci_c 쿠키 조회 실패:', error.message);
    return null;
  }
}

async function rebanManagementRows(config, avoidNos, refererPage = 1) {
  return withDcRequestLease({ feature: 'hanRefreshIpBan', kind: 'rebanManagementRows' }, async () => {
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const uniqueNos = [...new Set(
      (avoidNos || [])
        .map((value) => String(value || '').trim())
        .filter((value) => /^\d+$/.test(value) && Number(value) > 0),
    )];

    if (uniqueNos.length === 0) {
      return {
        success: true,
        successNos: [],
        failedNos: [],
        message: '차단 대상이 없습니다.',
      };
    }

    const ciToken = await getCiToken(resolved.baseUrl);
    if (!ciToken) {
      return {
        success: false,
        successNos: [],
        failedNos: uniqueNos,
        message: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
      };
    }

    return rebanManagementRowsWithFallback(resolved, ciToken, uniqueNos, refererPage);
  });
}

async function rebanManagementRowsWithFallback(config, ciToken, avoidNos, refererPage) {
  const batchResult = await rebanManagementRowBatch(config, ciToken, avoidNos, refererPage);
  if (batchResult.success) {
    return {
      success: true,
      successNos: [...avoidNos],
      failedNos: [],
      message: '',
    };
  }

  if (avoidNos.length === 1) {
    return {
      success: false,
      successNos: [],
      failedNos: [...avoidNos],
      message: batchResult.message,
    };
  }

  const middleIndex = Math.ceil(avoidNos.length / 2);
  const leftResult = await rebanManagementRowsWithFallback(
    config,
    ciToken,
    avoidNos.slice(0, middleIndex),
    refererPage,
  );
  const rightResult = await rebanManagementRowsWithFallback(
    config,
    ciToken,
    avoidNos.slice(middleIndex),
    refererPage,
  );

  return {
    success: leftResult.success && rightResult.success,
    successNos: [...leftResult.successNos, ...rightResult.successNos],
    failedNos: dedupeNos([...leftResult.failedNos, ...rightResult.failedNos]),
    message: [leftResult.message, rightResult.message].filter(Boolean).join(' | '),
  };
}

async function rebanManagementRowBatch(config, ciToken, avoidNos, refererPage) {
  const body = new URLSearchParams();
  body.set('ci_t', ciToken);
  body.set('gallery_id', config.galleryId);
  body.set('_GALLTYPE_', config.galleryType);
  body.set('avoid_hour', String(config.avoidHour));
  body.set('avoid_reason', String(config.avoidReason));
  body.set('avoid_reason_txt', config.avoidReasonText || '');

  for (const avoidNo of avoidNos) {
    body.append('nos[]', String(avoidNo));
  }

  const response = await dcFetchWithRetry(
    `${config.baseUrl}/ajax/managements_ajax/user_code_avoid`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': buildManagementBlockUrl(config, refererPage),
        'Origin': config.baseUrl,
      },
      body: body.toString(),
    },
    2,
  );

  const responseText = await response.text();
  const parsed = safeParseJson(responseText);
  const success = response.ok && String(parsed?.result || '').toLowerCase() === 'success';

  return {
    success,
    message: success
      ? ''
      : summarizeFailureMessage(response.status, parsed, responseText),
  };
}

function summarizeFailureMessage(status, parsed, responseText) {
  const message = String(parsed?.msg || parsed?.message || '').trim();
  if (message) {
    return `HTTP ${status} / ${message}`;
  }

  const trimmedText = String(responseText || '').replace(/\s+/g, ' ').trim();
  if (trimmedText) {
    return `HTTP ${status} / ${trimmedText.slice(0, 200)}`;
  }

  return `HTTP ${status} / 응답 본문 없음`;
}

function safeParseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function dedupeNos(values) {
  return [...new Set((values || []).map((value) => String(value)))];
}

export {
  DEFAULT_CONFIG,
  buildManagementBlockUrl,
  delay,
  fetchManagementBlockHTML,
  rebanManagementRows,
  safeParseJson,
};
