import { fetchUserActivityStats } from '../features/semi-post/api.js';
import {
  UID_RATIO_WARNING_CACHE_TTL_MS,
  getUidStatsCacheKey,
  isUidStatsCacheFresh,
} from '../features/semi-post/uid-warning.js';

const uidStatsCache = new Map();

async function getOrFetchUidStats(galleryId, uid) {
  const cacheKey = getUidStatsCacheKey(galleryId, uid);
  const cached = uidStatsCache.get(cacheKey);
  const now = Date.now();
  if (isUidStatsCacheFresh(cached, now)) {
    return cached.stats;
  }

  const stats = await fetchUserActivityStats({ galleryId }, uid);
  uidStatsCache.set(cacheKey, {
    stats,
    expiresAt: now + UID_RATIO_WARNING_CACHE_TTL_MS,
  });
  return stats;
}

export {
  getOrFetchUidStats,
};
