import { withDcRequestLease } from '../../background/dc-session-broker.js';

const LEGACY_AVOID_REASON_TEXT = '매일 오는 gdp틀딱 (자동차단)';
const PREVIOUS_DEFAULT_AVOID_REASON_TEXT = '깡계분탕(요격)';
const DEFAULT_AVOID_REASON_TEXT = '깡계분탕';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  gallogBaseUrl: 'https://gallog.dcinside.com',
  pollIntervalMs: 10000,
  recentWindowMs: 5 * 60 * 1000,
  recentPostThreshold: 2,
  postRatioThresholdPercent: 90,
  retryCooldownMs: 60000,
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: DEFAULT_AVOID_REASON_TEXT,
  delChk: true,
  avoidTypeChk: true,
  immediateTitleBanRules: [],
  attackCommentClusterEnabled: true,
  attackCommentClusterMinCount: 10,
  attackCommentMinNormalizedLength: 6,
  attackCommentFetchConcurrency: 10,
  attackCommentFetchRequestDelayMs: 100,
  attackCommentFetchTimeoutMs: 15 * 1000,
  attackCommentDeleteDelayMs: 100,
  attackCommentDeleteTimeoutMs: 15 * 1000,
  attackCommentSnapshotTtlMs: 30 * 1000,
  linkbaitBodyLinkEnabled: true,
  linkbaitBodyLinkTitleNeedle: '이거 진짜',
  linkbaitBodyLinkTitleNeedles: ['이거 진짜', '이거 ㄹㅇ', '레전드네', '개웃기네'],
  linkbaitBodyLinkFetchConcurrency: 10,
  linkbaitBodyLinkFetchRequestDelayMs: 100,
  linkbaitBodyLinkFetchTimeoutMs: 5 * 1000,
};

function resolveConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
  };
}

async function fetchUidWarningAutoBanListHTML(config = {}, page = 1) {
  return withDcRequestLease({ feature: 'uidWarningAutoBan', kind: 'fetchListHTML' }, async () => {
    const resolved = resolveConfig(config);
    const url = new URL('/mgallery/board/lists/', resolved.baseUrl);
    url.searchParams.set('id', resolved.galleryId);
    url.searchParams.set('page', String(page));

    const response = await dcFetchWithRetry(url.toString());
    return response.text();
  });
}

async function fetchUidWarningAutoBanPostViewHTML(config = {}, postNo, options = {}) {
  return withDcRequestLease(
    { feature: 'uidWarningAutoBan', kind: 'fetchPostViewHTML' },
    async (lease) => {
      const resolved = resolveConfig(config);
      const normalizedPostNo = Math.max(0, Number(postNo) || 0);
      if (normalizedPostNo <= 0) {
        throw new Error('글번호 없음');
      }

      const url = new URL('/mgallery/board/view/', resolved.baseUrl);
      url.searchParams.set('id', resolved.galleryId);
      url.searchParams.set('no', String(normalizedPostNo));
      url.searchParams.set('page', '1');

      const response = await dcFetchWithRetry(url.toString(), {
        signal: mergeAbortSignals(options.signal, lease.signal),
        headers: {
          Referer: `${resolved.baseUrl}/mgallery/board/lists/?id=${encodeURIComponent(resolved.galleryId)}&page=1`,
        },
      });
      const html = await response.text();
      if (html.includes('정상적인 접근이 아닙니다')) {
        throw new Error('정상적인 접근이 아닙니다');
      }
      return html;
    },
    { signal: options.signal },
  );
}

async function fetchGallogHomeHtml(config = {}, uid = '') {
  return withDcRequestLease({ feature: 'uidWarningAutoBan', kind: 'fetchGallogHomeHtml' }, async () => {
    const resolved = resolveConfig(config);
    const normalizedUid = String(uid || '').trim();
    if (!normalizedUid) {
      throw new Error('식별코드(uid) 없음');
    }

    const url = new URL(`/${encodeURIComponent(normalizedUid)}`, resolved.gallogBaseUrl);
    const response = await dcFetchWithRetry(url.toString(), {
      headers: {
        Referer: `${resolved.baseUrl}/mgallery/board/lists/?id=${resolved.galleryId}`,
      },
    });
    return response.text();
  });
}

async function fetchGallogGuestbookHtml(config = {}, uid = '') {
  return withDcRequestLease({ feature: 'uidWarningAutoBan', kind: 'fetchGallogGuestbookHtml' }, async () => {
    const resolved = resolveConfig(config);
    const normalizedUid = String(uid || '').trim();
    if (!normalizedUid) {
      throw new Error('식별코드(uid) 없음');
    }

    const url = new URL(`/${encodeURIComponent(normalizedUid)}/guestbook`, resolved.gallogBaseUrl);
    const response = await dcFetchWithRetry(url.toString(), {
      headers: {
        Referer: `${resolved.baseUrl}/mgallery/board/lists/?id=${resolved.galleryId}`,
      },
    });
    return response.text();
  });
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

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        await delay((attempt + 1) * 2000, options.signal);
        continue;
      }

      if (response.status === 403) {
        await delay(5000, options.signal);
        continue;
      }

      return response;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
      lastError = error;
      await delay(1000, options.signal);
    }
  }

  throw new Error(
    lastError?.message
      ? `최대 재시도 횟수 초과 - ${lastError.message}`
      : '최대 재시도 횟수 초과',
  );
}

async function delay(ms, signal) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  if (signal.aborted) {
    throw createAbortError();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }
}

function mergeAbortSignals(...signals) {
  const normalizedSignals = signals.filter(Boolean);
  if (normalizedSignals.length === 0) {
    return undefined;
  }

  if (normalizedSignals.length === 1) {
    return normalizedSignals[0];
  }

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(normalizedSignals);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of normalizedSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

export {
  DEFAULT_CONFIG,
  DEFAULT_AVOID_REASON_TEXT,
  LEGACY_AVOID_REASON_TEXT,
  PREVIOUS_DEFAULT_AVOID_REASON_TEXT,
  delay,
  fetchGallogGuestbookHtml,
  fetchGallogHomeHtml,
  fetchUidWarningAutoBanListHTML,
  fetchUidWarningAutoBanPostViewHTML,
  resolveConfig,
};
