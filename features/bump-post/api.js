import { withDcRequestLease } from '../../background/dc-session-broker.js';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  postNo: '',
  durationMinutes: 60,
  intervalMinutes: 1,
};

function resolveConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
  };
}

async function bumpPost(config = {}, postNo = '', options = {}) {
  return withDcRequestLease({ feature: 'bumpPost', kind: 'updateBump' }, async () => {
    const resolved = resolveConfig(config);
    const normalizedPostNo = normalizePostNo(postNo || resolved.postNo);
    if (!normalizedPostNo) {
      return {
        success: false,
        postNo: '',
        message: '게시물 번호를 숫자로 입력하세요.',
        failureType: 'validation',
      };
    }

    const ciToken = await getCiToken(resolved.baseUrl);
    if (!ciToken) {
      return {
        success: false,
        postNo: normalizedPostNo,
        message: 'ci_t 토큰(ci_c 쿠키) 없음. 로그인 상태를 확인하세요.',
        failureType: 'auth',
      };
    }

    const url = `${resolved.baseUrl}/ajax/minor_manager_board_ajax/update_bump`;
    const bodyParts = [
      `ci_t=${encodeURIComponent(ciToken)}`,
      `id=${encodeURIComponent(resolved.galleryId)}`,
      `_GALLTYPE_=${encodeURIComponent(resolved.galleryType)}`,
      `nos%5B%5D=${encodeURIComponent(normalizedPostNo)}`,
    ];

    let response;
    try {
      response = await dcFetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': resolved.baseUrl,
          'Referer': `${resolved.baseUrl}/mgallery/board/view/?id=${resolved.galleryId}&no=${normalizedPostNo}&page=1`,
        },
        body: bodyParts.join('&'),
        signal: options.signal,
      }, options.maxRetries ?? 3);
    } catch (error) {
      return {
        success: false,
        postNo: normalizedPostNo,
        message: error?.message || '끌올 요청 중 네트워크 오류가 발생했습니다.',
        failureType: 'network',
      };
    }

    const responseText = await response.text();
    const failureType = inferBumpFailureType(response, responseText);
    if (failureType) {
      return {
        success: false,
        postNo: normalizedPostNo,
        message: buildFailureMessage(response, responseText, failureType),
        failureType,
      };
    }

    return {
      success: true,
      postNo: normalizedPostNo,
      message: summarizeResponseText(responseText),
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
    console.error('[BumpPostAPI] ci_c 쿠키 가져오기 실패:', error.message);
    return null;
  }
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
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await dcFetch(url, options);
      lastResponse = response;

      if (response.status === 429 && attempt < retries - 1) {
        await delay((attempt + 1) * 2000);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await delay((attempt + 1) * 1000);
      }
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw new Error(
    lastError?.message
      ? `최대 재시도 횟수 초과 - ${lastError.message}`
      : '최대 재시도 횟수 초과',
  );
}

function inferBumpFailureType(response, responseText) {
  if (response.status === 429) {
    return 'rate_limit';
  }

  if (response.status === 403) {
    return 'forbidden';
  }

  if (!response.ok) {
    return 'unknown';
  }

  if (/(정상적인 접근이 아닙니다|로그인|ci_t|ci_c)/i.test(responseText)) {
    return 'auth';
  }

  if (/(권한|forbidden|denied)/i.test(responseText)) {
    return 'forbidden';
  }

  if (/(실패|error|fail)/i.test(responseText)) {
    return 'unknown';
  }

  return '';
}

function buildFailureMessage(response, responseText, failureType) {
  const responseSummary = summarizeResponseText(responseText);
  if (failureType === 'rate_limit') {
    return responseSummary || '끌올 요청이 너무 많아 잠시 후 다시 시도해야 합니다.';
  }

  if (failureType === 'forbidden') {
    return responseSummary || '끌올 권한이 없거나 접근이 거부되었습니다.';
  }

  if (failureType === 'auth') {
    return responseSummary || '로그인 또는 ci_t 토큰 문제로 끌올에 실패했습니다.';
  }

  if (!response.ok) {
    return responseSummary || `끌올 요청 실패 (HTTP ${response.status})`;
  }

  return responseSummary || '끌올 응답이 비정상이라 실패로 처리했습니다.';
}

function normalizePostNo(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function summarizeResponseText(responseText) {
  return String(responseText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export {
  DEFAULT_CONFIG,
  bumpPost,
  delay,
  normalizePostNo,
  resolveConfig,
};
