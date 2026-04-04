import { fetchGallogGuestbookHtml } from '../features/uid-warning-autoban/api.js';
import { parseGallogGuestbookState } from '../features/uid-warning-autoban/parser.js';
import { UID_RATIO_WARNING_CACHE_TTL_MS } from '../features/semi-post/uid-warning.js';

const uidGallogGuestbookCache = new Map();

async function getOrFetchUidGallogGuestbookState(config = {}, uid = '') {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) {
    return buildGuestbookStateFailure('식별코드(uid) 없음');
  }

  const now = Date.now();
  const cached = uidGallogGuestbookCache.get(normalizedUid);
  if (isUidGallogGuestbookCacheFresh(cached, now)) {
    return cached.state;
  }

  const html = await fetchGallogGuestbookHtml(config, normalizedUid);
  const state = parseGallogGuestbookState(html);
  if (state?.success === true) {
    uidGallogGuestbookCache.set(normalizedUid, {
      state,
      expiresAt: now + UID_RATIO_WARNING_CACHE_TTL_MS,
    });
  }
  return state;
}

function buildGuestbookStateFailure(message = '') {
  return {
    success: false,
    message: String(message || '').trim() || '방명록 상태 확인 실패',
    guestbookLocked: false,
    guestbookWritable: false,
    guestbookStateKnown: false,
  };
}

function isUidGallogGuestbookCacheFresh(entry, now = Date.now()) {
  return Boolean(
    entry
      && Number(entry.expiresAt) > 0
      && Number(entry.expiresAt) > Number(now),
  );
}

export {
  getOrFetchUidGallogGuestbookState,
};
