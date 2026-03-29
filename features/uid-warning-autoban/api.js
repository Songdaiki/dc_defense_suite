import { withDcRequestLease } from '../../background/dc-session-broker.js';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  pollIntervalMs: 60000,
  recentWindowMs: 5 * 60 * 1000,
  recentPostThreshold: 3,
  postRatioThresholdPercent: 90,
  retryCooldownMs: 60000,
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: '매일 오는 gdp틀딱 (자동차단)',
  delChk: true,
  avoidTypeChk: true,
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

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export {
  DEFAULT_CONFIG,
  delay,
  fetchUidWarningAutoBanListHTML,
  resolveConfig,
};
