import { fetchGallogHomeHtml } from '../features/uid-warning-autoban/api.js';
import { parseGallogPrivacy } from '../features/uid-warning-autoban/parser.js';
import { UID_RATIO_WARNING_CACHE_TTL_MS } from '../features/semi-post/uid-warning.js';

const uidGallogPrivacyCache = new Map();

async function getOrFetchUidGallogPrivacy(config = {}, uid = '') {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) {
    return {
      success: false,
      message: '식별코드(uid) 없음',
      postingPublic: false,
      commentPublic: false,
      postingPrivate: false,
      commentPrivate: false,
      fullyPrivate: false,
    };
  }

  const now = Date.now();
  const cached = uidGallogPrivacyCache.get(normalizedUid);
  if (isUidGallogPrivacyCacheFresh(cached, now)) {
    return cached.privacy;
  }

  const html = await fetchGallogHomeHtml(config, normalizedUid);
  const privacy = parseGallogPrivacy(html);
  if (privacy?.success === true) {
    uidGallogPrivacyCache.set(normalizedUid, {
      privacy,
      expiresAt: now + UID_RATIO_WARNING_CACHE_TTL_MS,
    });
  }
  return privacy;
}

function isUidGallogPrivacyCacheFresh(entry, now = Date.now()) {
  return Boolean(
    entry
      && Number(entry.expiresAt) > 0
      && Number(entry.expiresAt) > Number(now),
  );
}

export {
  getOrFetchUidGallogPrivacy,
};
