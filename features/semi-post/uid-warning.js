const UID_RATIO_WARNING_THRESHOLD_PERCENT = 90;
const UID_RATIO_WARNING_CACHE_TTL_MS = 2 * 60 * 1000;
const UID_RATIO_WARNING_STATE_STORAGE_KEY = 'uidRatioWarningState';
const UID_RATIO_WARNING_ENABLED_STORAGE_KEY = 'uidRatioWarningEnabled';
const UID_RATIO_WARNING_BADGE_ATTR = 'uid-ratio';
const UID_RATIO_WARNING_BADGE_TEXT = '- 분탕주의';

function isUidWarningSupportedLoc(loc = '') {
    const normalizedLoc = String(loc || '').trim().toLowerCase();
    return normalizedLoc === 'view_list'
        || normalizedLoc === 'list';
}
function createDefaultUidRatioWarningStatus(overrides = {}) {
    return {
        enabled: false,
        applying: false,
        supported: true,
        tabId: 0,
        pageUrl: '',
        matchedUidCount: 0,
        warnedUidCount: 0,
        lastAppliedAt: '',
        lastError: '',
        generation: 0,
        managedTabIds: [],
        ...overrides,
    };
}

function normalizeUidRatioWarningStateEntry(raw = {}) {
    return createDefaultUidRatioWarningStatus({
        enabled: raw.enabled === true,
        applying: false,
        supported: raw.supported !== false,
        tabId: Number(raw.tabId) > 0 ? Number(raw.tabId) : 0,
        pageUrl: String(raw.pageUrl || ''),
        matchedUidCount: Math.max(0, Number(raw.matchedUidCount) || 0),
        warnedUidCount: Math.max(0, Number(raw.warnedUidCount) || 0),
        lastAppliedAt: String(raw.lastAppliedAt || ''),
        lastError: String(raw.lastError || ''),
        generation: Math.max(0, Number(raw.generation) || 0),
        managedTabIds: Array.from(
            new Set(
                (Array.isArray(raw.managedTabIds) ? raw.managedTabIds : [])
                    .map((tabId) => Number(tabId))
                    .filter((tabId) => Number.isInteger(tabId) && tabId > 0),
            ),
        ),
    });
}

function isSupportedUidRatioWarningUrl(url) {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
        return false;
    }

    try {
        const parsed = new URL(normalizedUrl);
        if (parsed.protocol !== 'https:') {
            return false;
        }

        return parsed.hostname === 'gall.dcinside.com'
            || parsed.hostname.endsWith('.dcinside.co.kr');
    } catch {
        return false;
    }
}

function normalizeUidWriterEntries(entries = []) {
    const results = [];
    const seen = new Set();

    for (const entry of Array.isArray(entries) ? entries : []) {
        const uid = String(entry?.uid || '').trim();
        if (!uid || seen.has(uid)) {
            continue;
        }

        seen.add(uid);
        results.push({
            uid,
            nick: String(entry?.nick || '').trim(),
            loc: String(entry?.loc || '').trim(),
        });
    }

    return results;
}

function collectUidWriterEntriesFromPage() {
    const writerSelector = '.gall_writer[data-uid]';
    const isSupportedLoc = (loc = '') => {
        const normalizedLoc = String(loc || '').trim().toLowerCase();
        return normalizedLoc === 'view_list'
            || normalizedLoc === 'list';
    };
    const writers = Array.from(document.querySelectorAll(writerSelector));
    const results = [];
    const seen = new Set();

    for (const element of writers) {
        const uid = String(element.getAttribute('data-uid') || '').trim();
        if (!uid) {
            continue;
        }

        const loc = String(element.getAttribute('data-loc') || '').trim();
        if (!isSupportedLoc(loc)) {
            continue;
        }

        if (seen.has(uid)) {
            continue;
        }

        seen.add(uid);
        results.push({
            uid,
            nick: String(element.getAttribute('data-nick') || '').trim(),
            loc,
        });
    }

    return results;
}

function clearUidRatioWarningBadgesFromPage() {
    const badges = Array.from(document.querySelectorAll('[data-defense-warning-badge="uid-ratio"]'));
    badges.forEach((badge) => badge.remove());

    const highlightedNodes = Array.from(document.querySelectorAll('[data-defense-warning-highlight="uid-ratio"]'));
    highlightedNodes.forEach((node) => {
        const originalStyle = String(node.getAttribute('data-defense-warning-original-style') || '');
        if (originalStyle) {
            node.setAttribute('style', originalStyle);
        } else {
            node.removeAttribute('style');
        }
        node.removeAttribute('data-defense-warning-highlight');
        node.removeAttribute('data-defense-warning-original-style');
    });

    const highlightedRows = Array.from(document.querySelectorAll('[data-defense-warning-row-highlight="uid-ratio"]'));
    highlightedRows.forEach((node) => {
        const originalStyle = String(node.getAttribute('data-defense-warning-row-original-style') || '');
        if (originalStyle) {
            node.setAttribute('style', originalStyle);
        } else {
            node.removeAttribute('style');
        }
        node.removeAttribute('data-defense-warning-row-highlight');
        node.removeAttribute('data-defense-warning-row-original-style');
    });

    return badges.length;
}

function applyUidRatioWarningBadgesToPage(warnedUids = [], badgeText = '- 분탕주의') {
    const badgeAttr = 'uid-ratio';
    const writerSelector = '.gall_writer[data-uid]';
    const isSupportedLoc = (loc = '') => {
        const normalizedLoc = String(loc || '').trim().toLowerCase();
        return normalizedLoc === 'view_list'
            || normalizedLoc === 'list';
    };
    const existingBadges = Array.from(document.querySelectorAll('[data-defense-warning-badge="uid-ratio"]'));
    existingBadges.forEach((badge) => badge.remove());

    const warnedUidSet = new Set(
        (Array.isArray(warnedUids) ? warnedUids : [])
            .map((uid) => String(uid || '').trim())
            .filter(Boolean),
    );

    if (warnedUidSet.size === 0) {
        return 0;
    }

    let appliedCount = 0;
    const writers = Array.from(document.querySelectorAll(writerSelector));
    for (const element of writers) {
        const uid = String(element.getAttribute('data-uid') || '').trim();
        if (!uid || !warnedUidSet.has(uid)) {
            continue;
        }

        const loc = String(element.getAttribute('data-loc') || '').trim();
        if (!isSupportedLoc(loc)) {
            continue;
        }

        const badge = document.createElement('span');
        badge.setAttribute('data-defense-warning-badge', badgeAttr);
        badge.textContent = ` ${badgeText}`;
        badge.style.marginLeft = '4px';
        badge.style.color = '#ff2d2d';
        badge.style.fontWeight = '700';
        badge.style.fontSize = '11px';
        badge.style.whiteSpace = 'nowrap';
        const badgeAnchor = element.querySelector('.nickname')
            || element.querySelector('.writer_nikcon')
            || element;
        const nicknameNode = element.querySelector('.nickname');
        const nicknameTextNode = nicknameNode?.querySelector('em') || null;
        [nicknameNode, nicknameTextNode].filter(Boolean).forEach((node) => {
            if (!node.hasAttribute('data-defense-warning-highlight')) {
                const originalStyle = node.getAttribute('style');
                node.setAttribute('data-defense-warning-highlight', badgeAttr);
                node.setAttribute('data-defense-warning-original-style', originalStyle ?? '');
            }
            node.style.color = '#ff2d2d';
            node.style.fontWeight = '700';
        });

        const rowTargets = [];
        const tableRow = typeof element.closest === 'function' ? element.closest('tr') : null;
        if (tableRow && typeof tableRow.querySelectorAll === 'function') {
            rowTargets.push(...Array.from(tableRow.querySelectorAll('td, th')));
        } else {
            const viewHeader = typeof element.closest === 'function' ? element.closest('.gallview_head') : null;
            if (viewHeader) {
                rowTargets.push(viewHeader);
            }
        }

        rowTargets.forEach((node) => {
            if (!node.hasAttribute('data-defense-warning-row-highlight')) {
                const originalStyle = node.getAttribute('style');
                node.setAttribute('data-defense-warning-row-highlight', badgeAttr);
                node.setAttribute('data-defense-warning-row-original-style', originalStyle ?? '');
            }
            node.style.background = 'rgba(255, 45, 45, 0.10)';
            node.style.boxShadow = 'none';
        });

        badgeAnchor.appendChild(badge);
        appliedCount += 1;
    }

    return appliedCount;
}

function getUidStatsCacheKey(galleryId, uid) {
    return `${String(galleryId || '').trim()}::${String(uid || '').trim()}`;
}

function isUidStatsCacheFresh(entry, now = Date.now()) {
    return Boolean(
        Boolean(entry)
        && typeof entry.expiresAt === 'number'
        && entry.expiresAt > now
        && entry.stats
        && typeof entry.stats === 'object'
    );
}

export {
    UID_RATIO_WARNING_BADGE_ATTR,
    UID_RATIO_WARNING_BADGE_TEXT,
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
    isUidWarningSupportedLoc,
    isUidStatsCacheFresh,
    normalizeUidRatioWarningStateEntry,
    normalizeUidWriterEntries,
};
