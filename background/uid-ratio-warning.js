import { fetchUserActivityStats } from '../features/semi-post/api.js';
import {
  UID_RATIO_WARNING_CACHE_TTL_MS,
  UID_RATIO_WARNING_ENABLED_STORAGE_KEY,
  UID_RATIO_WARNING_STATE_STORAGE_KEY,
  UID_RATIO_WARNING_THRESHOLD_PERCENT,
  applyUidRatioWarningBadgesToPage,
  clearUidRatioWarningBadgesFromPage,
  collectUidWriterEntriesFromPage,
  createDefaultUidRatioWarningStatus,
  getUidStatsCacheKey,
  isSupportedUidRatioWarningUrl,
  isUidStatsCacheFresh,
  normalizeUidRatioWarningStateEntry,
  normalizeUidWriterEntries,
} from '../features/semi-post/uid-warning.js';

const uidStatsCache = new Map();
let uidRatioWarningState = createDefaultUidRatioWarningStatus();
let uidRatioWarningStateLoaded = false;
let uidRatioWarningResumePromise = null;

async function getUidRatioWarningStatusForActiveTab() {
  await ensureUidRatioWarningStateLoaded();
  const tab = await getActiveTab();
  if (!tab?.id) {
    return createDefaultUidRatioWarningStatus({
      enabled: uidRatioWarningState.enabled,
      supported: false,
      lastError: '활성 탭을 찾지 못했습니다.',
    });
  }

  return getUidRatioWarningStatusForTab(tab.id, tab.url);
}

function getUidRatioWarningStatusForTab(tabId, pageUrl = '') {
  const currentUrl = String(pageUrl || '');
  const supported = isSupportedUidRatioWarningUrl(currentUrl);

  if (!uidRatioWarningState.enabled) {
    return createDefaultUidRatioWarningStatus({
      tabId,
      pageUrl: currentUrl,
      supported,
    });
  }

  const sameTab = Number(uidRatioWarningState.tabId) === Number(tabId);
  const sameUrl = String(uidRatioWarningState.pageUrl || '') === currentUrl;

  if (sameTab && (sameUrl || uidRatioWarningState.applying)) {
    return createDefaultUidRatioWarningStatus({
      ...uidRatioWarningState,
      tabId,
      pageUrl: currentUrl,
      supported,
    });
  }

  return createDefaultUidRatioWarningStatus({
    ...uidRatioWarningState,
    applying: false,
    tabId,
    pageUrl: currentUrl,
    supported,
    matchedUidCount: 0,
    warnedUidCount: 0,
    lastAppliedAt: '',
    lastError: '',
  });
}

async function toggleUidRatioWarningForActiveTab(options = {}) {
  await ensureUidRatioWarningStateLoaded();
  const enabled = Boolean(options.enabled);
  const tab = await getActiveTab();
  if (!tab?.id) {
    const status = createDefaultUidRatioWarningStatus({
      enabled: uidRatioWarningState.enabled,
      supported: false,
      lastError: '활성 탭을 찾지 못했습니다.',
    });
    return {
      success: false,
      message: status.lastError,
      uidRatioWarningStatus: status,
    };
  }

  if (!enabled) {
    return disableUidRatioWarning(tab);
  }

  uidRatioWarningState = createDefaultUidRatioWarningStatus({
    ...uidRatioWarningState,
    enabled: true,
    tabId: tab.id,
    pageUrl: String(tab.url || ''),
  });
  await persistUidRatioWarningState();

  if (!isSupportedUidRatioWarningUrl(tab.url)) {
    const status = createDefaultUidRatioWarningStatus({
      ...uidRatioWarningState,
      tabId: tab.id,
      pageUrl: String(tab.url || ''),
      supported: false,
    });
    uidRatioWarningState = status;
    await persistUidRatioWarningState();
    return {
      success: true,
      message: '분탕경고를 켰습니다. 디시 게시판/본문 페이지로 이동하면 자동 적용됩니다.',
      uidRatioWarningStatus: status,
    };
  }

  return applyUidRatioWarningToTab(tab, {
    fallbackGalleryId: options.galleryId,
  });
}

async function handleUidRatioWarningTabActivated(activeInfo = {}) {
  await ensureUidRatioWarningStateLoaded();
  if (!uidRatioWarningState.enabled) {
    return;
  }

  const tabId = Number(activeInfo.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return;
  }

  const tab = await safeGetTab(tabId);
  if (!tab?.id) {
    return;
  }

  if (!isSupportedUidRatioWarningUrl(tab.url)) {
    uidRatioWarningState = createDefaultUidRatioWarningStatus({
      ...uidRatioWarningState,
      enabled: true,
      applying: false,
      tabId,
      pageUrl: String(tab.url || ''),
      supported: false,
      matchedUidCount: 0,
      warnedUidCount: 0,
      lastAppliedAt: '',
      lastError: '',
    });
    await persistUidRatioWarningState();
    return;
  }

  await applyUidRatioWarningToTab(tab);
}

async function handleUidRatioWarningTabUpdated(tabId, changeInfo = {}, tab = null) {
  await ensureUidRatioWarningStateLoaded();
  if (!uidRatioWarningState.enabled) {
    return;
  }

  const nextTab = tab?.id ? tab : await safeGetTab(tabId);
  if (!nextTab?.id || !nextTab.active) {
    return;
  }

  const nextUrl = String(changeInfo.url || nextTab.url || '');
  const supported = isSupportedUidRatioWarningUrl(nextUrl);
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    uidRatioWarningState = createDefaultUidRatioWarningStatus({
      ...uidRatioWarningState,
      enabled: true,
      applying: supported,
      tabId,
      pageUrl: nextUrl,
      supported,
      matchedUidCount: 0,
      warnedUidCount: 0,
      lastAppliedAt: '',
      lastError: '',
      generation: getNextGeneration(),
    });
    await persistUidRatioWarningState();
  }

  if (changeInfo.status !== 'complete') {
    return;
  }

  if (!supported) {
    uidRatioWarningState = createDefaultUidRatioWarningStatus({
      ...uidRatioWarningState,
      enabled: true,
      applying: false,
      tabId,
      pageUrl: nextUrl,
      supported: false,
      matchedUidCount: 0,
      warnedUidCount: 0,
      lastAppliedAt: '',
      lastError: '',
    });
    await persistUidRatioWarningState();
    return;
  }

  await applyUidRatioWarningToTab(nextTab);
}

async function handleUidRatioWarningTabRemoved(tabId) {
  await ensureUidRatioWarningStateLoaded();
  const managedTabIds = new Set(uidRatioWarningState.managedTabIds || []);
  managedTabIds.delete(Number(tabId));

  uidRatioWarningState = createDefaultUidRatioWarningStatus({
    ...uidRatioWarningState,
    managedTabIds: Array.from(managedTabIds),
    tabId: Number(uidRatioWarningState.tabId) === Number(tabId) ? 0 : uidRatioWarningState.tabId,
    pageUrl: Number(uidRatioWarningState.tabId) === Number(tabId) ? '' : uidRatioWarningState.pageUrl,
    applying: Number(uidRatioWarningState.tabId) === Number(tabId) ? false : uidRatioWarningState.applying,
    matchedUidCount: Number(uidRatioWarningState.tabId) === Number(tabId) ? 0 : uidRatioWarningState.matchedUidCount,
    warnedUidCount: Number(uidRatioWarningState.tabId) === Number(tabId) ? 0 : uidRatioWarningState.warnedUidCount,
  });
  await persistUidRatioWarningState();
}

async function resumeUidRatioWarningForActiveTab() {
  await ensureUidRatioWarningStateLoaded();
  if (!uidRatioWarningState.enabled) {
    return getUidRatioWarningStatusForActiveTab();
  }

  if (uidRatioWarningResumePromise) {
    return uidRatioWarningResumePromise;
  }

  uidRatioWarningResumePromise = (async () => {
    const tab = await getActiveTab();
    if (!tab?.id) {
      return createDefaultUidRatioWarningStatus({
        enabled: true,
        supported: false,
        lastError: '활성 탭을 찾지 못했습니다.',
      });
    }

    const pageUrl = String(tab.url || '');
    const supported = isSupportedUidRatioWarningUrl(pageUrl);
    const alreadyApplied = Number(uidRatioWarningState.tabId) === Number(tab.id)
      && String(uidRatioWarningState.pageUrl || '') === pageUrl
      && uidRatioWarningState.applying !== true
      && Array.isArray(uidRatioWarningState.managedTabIds)
      && uidRatioWarningState.managedTabIds.includes(Number(tab.id));

    if (supported && alreadyApplied) {
      return getUidRatioWarningStatusForTab(tab.id, tab.url);
    }

    if (!supported) {
      uidRatioWarningState = createDefaultUidRatioWarningStatus({
        ...uidRatioWarningState,
        enabled: true,
        applying: false,
        tabId: tab.id,
        pageUrl,
        supported: false,
        matchedUidCount: 0,
        warnedUidCount: 0,
        lastAppliedAt: '',
        lastError: '',
      });
      await persistUidRatioWarningState();
      return getUidRatioWarningStatusForTab(tab.id, tab.url);
    }

    const result = await applyUidRatioWarningToTab(tab);
    return result?.uidRatioWarningStatus || getUidRatioWarningStatusForTab(tab.id, tab.url);
  })().finally(() => {
    uidRatioWarningResumePromise = null;
  });

  return uidRatioWarningResumePromise;
}

async function applyUidRatioWarningToTab(tab, options = {}) {
  await ensureUidRatioWarningStateLoaded();
  if (!uidRatioWarningState.enabled) {
    return buildCancelledResult(tab?.id, tab?.url);
  }

  const tabId = Number(tab?.id) || 0;
  const pageUrl = String(tab?.url || '');
  const supported = isSupportedUidRatioWarningUrl(pageUrl);
  const generation = getNextGeneration();
  uidRatioWarningState = createDefaultUidRatioWarningStatus({
    ...uidRatioWarningState,
    enabled: true,
    applying: supported,
    tabId,
    pageUrl,
    supported,
    matchedUidCount: 0,
    warnedUidCount: 0,
    lastAppliedAt: '',
    lastError: '',
    generation,
  });
  await persistUidRatioWarningState();

  if (!supported) {
    return {
      success: true,
      message: '디시 게시판/본문 페이지에서 자동 적용됩니다.',
      uidRatioWarningStatus: getUidRatioWarningStatusForTab(tabId, pageUrl),
    };
  }

  try {
    const writerEntries = normalizeUidWriterEntries(await collectUidWriterEntriesInTab(tabId));
    if (!isGenerationCurrent(generation)) {
      return buildCancelledResult(tabId, pageUrl);
    }

    const galleryId = resolveGalleryIdFromUrl(pageUrl) || String(options.fallbackGalleryId || '').trim();
    if (!galleryId) {
      return await buildApplyErrorResult({
        tabId,
        pageUrl,
        generation,
        message: '현재 페이지에서 갤러리 ID를 확인하지 못했습니다.',
        clearBadges: true,
      });
    }

    const warnedUids = [];
    let successfulStatsCount = 0;
    let firstStatsErrorMessage = '';
    for (const entry of writerEntries) {
      if (!isGenerationCurrent(generation)) {
        return buildCancelledResult(tabId, pageUrl);
      }

      const stats = await getOrFetchUidStats(galleryId, entry.uid);
      if (!isGenerationCurrent(generation)) {
        return buildCancelledResult(tabId, pageUrl);
      }

      if (!stats?.success) {
        if (!firstStatsErrorMessage && stats?.message) {
          firstStatsErrorMessage = String(stats.message);
        }
        continue;
      }

      successfulStatsCount += 1;
      if (Number(stats.totalActivityCount) <= 0) {
        continue;
      }

      if (Number(stats.postRatio) >= UID_RATIO_WARNING_THRESHOLD_PERCENT) {
        warnedUids.push(entry.uid);
      }
    }

    if (writerEntries.length > 0 && successfulStatsCount === 0) {
      return await buildApplyErrorResult({
        tabId,
        pageUrl,
        generation,
        message: firstStatsErrorMessage || '식별코드 활동 통계를 조회하지 못했습니다.',
        clearBadges: true,
      });
    }

    await applyUidWarningBadgesInTab(tabId, warnedUids);
    if (!isGenerationCurrent(generation)) {
      return buildCancelledResult(tabId, pageUrl);
    }

    const managedTabIds = new Set(uidRatioWarningState.managedTabIds || []);
    managedTabIds.add(tabId);
    uidRatioWarningState = createDefaultUidRatioWarningStatus({
      ...uidRatioWarningState,
      enabled: true,
      applying: false,
      tabId,
      pageUrl,
      supported: true,
      matchedUidCount: writerEntries.length,
      warnedUidCount: warnedUids.length,
      lastAppliedAt: new Date().toISOString(),
      lastError: '',
      generation,
      managedTabIds: Array.from(managedTabIds),
    });
    await persistUidRatioWarningState();

    return {
      success: true,
      message: writerEntries.length > 0
        ? `현재 페이지 식별코드 ${writerEntries.length}명 검사 완료, 경고 ${warnedUids.length}명 표시`
        : '현재 페이지에 식별코드 작성자가 없어 경고를 표시하지 않았습니다.',
      uidRatioWarningStatus: createDefaultUidRatioWarningStatus(uidRatioWarningState),
    };
  } catch (error) {
    return buildApplyErrorResult({
      tabId,
      pageUrl,
      generation,
      message: error?.message || '식별코드 경고를 적용하지 못했습니다.',
      clearBadges: false,
    });
  }
}

async function disableUidRatioWarning(activeTab = null) {
  await ensureUidRatioWarningStateLoaded();
  const pageUrl = String(activeTab?.url || '');
  const tabId = Number(activeTab?.id) || 0;
  const managedTabIds = Array.from(
    new Set([
      ...(Array.isArray(uidRatioWarningState.managedTabIds) ? uidRatioWarningState.managedTabIds : []),
      tabId,
    ].filter((value) => Number.isInteger(value) && value > 0)),
  );
  const generation = getNextGeneration();

  uidRatioWarningState = createDefaultUidRatioWarningStatus({
    tabId,
    pageUrl,
    supported: isSupportedUidRatioWarningUrl(pageUrl),
    generation,
    managedTabIds: [],
  });
  await persistUidRatioWarningState();

  await clearUidWarningBadgesInTabs(managedTabIds);
  return {
    success: true,
    message: '분탕경고를 껐습니다.',
    uidRatioWarningStatus: createDefaultUidRatioWarningStatus(uidRatioWarningState),
  };
}

async function buildApplyErrorResult({ tabId, pageUrl, generation, message, clearBadges }) {
  if (clearBadges) {
    await clearUidWarningBadgesInTabs([tabId]);
  }

  uidRatioWarningState = createDefaultUidRatioWarningStatus({
    ...uidRatioWarningState,
    enabled: true,
    applying: false,
    tabId,
    pageUrl,
    supported: isSupportedUidRatioWarningUrl(pageUrl),
    lastError: String(message || '식별코드 경고를 적용하지 못했습니다.'),
    matchedUidCount: 0,
    warnedUidCount: 0,
    lastAppliedAt: '',
    generation,
  });
  await persistUidRatioWarningState();

  return {
    success: false,
    message: uidRatioWarningState.lastError,
    uidRatioWarningStatus: createDefaultUidRatioWarningStatus(uidRatioWarningState),
  };
}

async function ensureUidRatioWarningStateLoaded() {
  if (uidRatioWarningStateLoaded) {
    return;
  }

  uidRatioWarningStateLoaded = true;

  try {
    const [sessionStored, localStored] = await Promise.all([
      chrome.storage.session.get(UID_RATIO_WARNING_STATE_STORAGE_KEY),
      chrome.storage.local.get(UID_RATIO_WARNING_ENABLED_STORAGE_KEY),
    ]);
    uidRatioWarningState = normalizeUidRatioWarningStateEntry(sessionStored?.[UID_RATIO_WARNING_STATE_STORAGE_KEY]);
    const persistedEnabled = localStored?.[UID_RATIO_WARNING_ENABLED_STORAGE_KEY] === true;
    uidRatioWarningState = createDefaultUidRatioWarningStatus({
      ...uidRatioWarningState,
      enabled: persistedEnabled,
      applying: false,
      matchedUidCount: persistedEnabled ? uidRatioWarningState.matchedUidCount : 0,
      warnedUidCount: persistedEnabled ? uidRatioWarningState.warnedUidCount : 0,
      lastAppliedAt: persistedEnabled ? uidRatioWarningState.lastAppliedAt : '',
      lastError: persistedEnabled ? uidRatioWarningState.lastError : '',
      managedTabIds: persistedEnabled ? uidRatioWarningState.managedTabIds : [],
    });
  } catch (error) {
    console.error('[UidRatioWarning] 상태 복원 실패:', error);
  }
}

async function persistUidRatioWarningState() {
  try {
    await Promise.all([
      chrome.storage.session.set({
        [UID_RATIO_WARNING_STATE_STORAGE_KEY]: normalizeUidRatioWarningStateEntry(uidRatioWarningState),
      }),
      chrome.storage.local.set({
        [UID_RATIO_WARNING_ENABLED_STORAGE_KEY]: uidRatioWarningState.enabled === true,
      }),
    ]);
  } catch (error) {
    console.error('[UidRatioWarning] 상태 저장 실패:', error);
  }
}

async function collectUidWriterEntriesInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectUidWriterEntriesFromPage,
  });
  return results?.[0]?.result || [];
}

async function applyUidWarningBadgesInTab(tabId, warnedUids) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: applyUidRatioWarningBadgesToPage,
    args: [warnedUids],
  });
}

async function clearUidWarningBadgesInTabs(tabIds = []) {
  const uniqueTabIds = Array.from(
    new Set(
      (Array.isArray(tabIds) ? tabIds : [])
        .map((tabId) => Number(tabId))
        .filter((tabId) => Number.isInteger(tabId) && tabId > 0),
    ),
  );

  await Promise.all(uniqueTabIds.map(async (tabId) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: clearUidRatioWarningBadgesFromPage,
      });
    } catch (error) {
      if (!String(error?.message || '').includes('No tab with id')) {
        console.error('[UidRatioWarning] 배지 제거 실패:', error);
      }
    }
  }));
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tabs?.[0] || null;
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function resolveGalleryIdFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return String(parsed.searchParams.get('id') || '').trim();
  } catch {
    return '';
  }
}

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

function getNextGeneration() {
  return Number(uidRatioWarningState.generation || 0) + 1;
}

function isGenerationCurrent(generation) {
  return uidRatioWarningState.enabled && Number(uidRatioWarningState.generation || 0) === Number(generation);
}

function buildCancelledResult(tabId, pageUrl) {
  return {
    success: true,
    message: '이전 식별코드 경고 적용 요청은 최신 토글 상태로 무시되었습니다.',
    uidRatioWarningStatus: getUidRatioWarningStatusForTab(tabId, pageUrl),
  };
}

export {
  getUidRatioWarningStatusForActiveTab,
  handleUidRatioWarningTabActivated,
  handleUidRatioWarningTabRemoved,
  handleUidRatioWarningTabUpdated,
  resumeUidRatioWarningForActiveTab,
  toggleUidRatioWarningForActiveTab,
};
