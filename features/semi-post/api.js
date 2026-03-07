import { DC_CONFIG as POST_CONFIG, getCiToken, delay } from '../post/api.js';

const SEMI_POST_CONFIG = {
    galleryId: POST_CONFIG.galleryId,
    baseUrl: POST_CONFIG.baseUrl,
};

function resolveConfig(config = {}) {
    return {
        ...SEMI_POST_CONFIG,
        ...config,
    };
}

async function dcFetch(url, options = {}) {
    return await fetch(url, {
        credentials: 'include',
        headers: options.headers || {},
        ...options,
    });
}

async function dcFetchWithRetry(url, options = {}, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        try {
            const response = await dcFetch(url, options);

            if (response.status === 429) {
                await delay((attempt + 1) * 2000);
                continue;
            }

            if (response.status === 403) {
                await delay(30000);
                continue;
            }

            return response;
        } catch {
            await delay(1000);
        }
    }

    throw new Error('반고닉 활동 통계 조회 최대 재시도 횟수 초과');
}

async function fetchUserActivityStats(config = {}, uid) {
    const resolved = resolveConfig(config);
    const normalizedUid = String(uid || '').trim();

    if (!normalizedUid) {
        return {
            success: false,
            uid: normalizedUid,
            message: '식별코드(uid) 없음',
        };
    }

    const ciToken = await getCiToken(resolved.baseUrl);
    if (!ciToken) {
        return {
            success: false,
            uid: normalizedUid,
            message: 'ci_t 토큰(ci_c 쿠키) 없음. 로그인 상태를 확인하세요.',
        };
    }

    const url = `${resolved.baseUrl}/api/gallog_user_layer/gallog_content_reple/`;
    const body = [
        `ci_t=${encodeURIComponent(ciToken)}`,
        `user_id=${encodeURIComponent(normalizedUid)}`,
    ].join('&');

    const response = await dcFetchWithRetry(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${resolved.baseUrl}/mgallery/board/lists/?id=${resolved.galleryId}`,
            'Origin': resolved.baseUrl,
        },
        body,
    });

    const responseText = await response.text();
    if (!response.ok) {
        return {
            success: false,
            uid: normalizedUid,
            message: summarizeResponseText(responseText) || `HTTP ${response.status}`,
        };
    }

    const parsed = parseActivityStatsResponse(responseText);
    if (!parsed.success) {
        return {
            success: false,
            uid: normalizedUid,
            message: parsed.message,
        };
    }

    return {
        success: true,
        uid: normalizedUid,
        postCount: parsed.postCount,
        commentCount: parsed.commentCount,
        totalActivityCount: parsed.totalActivityCount,
        postRatio: parsed.postRatio,
    };
}

function parseActivityStatsResponse(responseText) {
    const normalizedText = String(responseText || '').trim();
    const parts = normalizedText.split(',');

    if (parts.length < 2) {
        return {
            success: false,
            message: `예상치 못한 응답 형식: ${summarizeResponseText(normalizedText)}`,
        };
    }

    const postCount = parseInt(parts[0], 10);
    const commentCount = parseInt(parts[1], 10);

    if (!Number.isInteger(postCount) || !Number.isInteger(commentCount) || postCount < 0 || commentCount < 0) {
        return {
            success: false,
            message: `응답 파싱 실패: ${summarizeResponseText(normalizedText)}`,
        };
    }

    const totalActivityCount = postCount + commentCount;
    const postRatio = totalActivityCount > 0
        ? Number(((postCount / totalActivityCount) * 100).toFixed(2))
        : 0;

    return {
        success: true,
        postCount,
        commentCount,
        totalActivityCount,
        postRatio,
    };
}

function summarizeResponseText(responseText) {
    return String(responseText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

export {
    SEMI_POST_CONFIG,
    fetchUserActivityStats,
    parseActivityStatsResponse,
};
