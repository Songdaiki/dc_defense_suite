/**
 * DC Post Protect - API 모듈
 * 
 * 디시인사이드 내부 API 호출을 담당합니다.
 * SPEC.md에서 확인된 엔드포인트와 파라미터를 사용합니다.
 */

// ============================================================
// 설정
// ============================================================
const DC_CONFIG = {
    galleryId: 'thesingularity',
    galleryType: 'M',           // M = 마이너 갤러리
    baseUrl: 'https://gall.dcinside.com',
    headtextId: '130',          // 도배기 머릿말 번호
    classifyBatchSize: 20,      // 배치 요청 크기
};

function resolveConfig(config = {}) {
    return {
        ...DC_CONFIG,
        ...config,
    };
}

// ============================================================
// 공통 fetch 래퍼
// ============================================================

/**
 * 디시인사이드 API 요청 공통 래퍼
 * - credentials: include → 로그인 세션 쿠키 자동 포함
 * - X-Requested-With → AJAX 요청으로 인식
 */
async function dcFetch(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'include',
        headers: options.headers || {},
        ...options,
    });

    return response;
}

/**
 * 레이트 리밋 대응 재시도 래퍼
 */
async function dcFetchWithRetry(url, options = {}, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await dcFetch(url, options);

            if (response.status === 429) {
                const backoff = (i + 1) * 2000;
                console.warn(`[API] 레이트 리밋 감지. ${backoff}ms 대기 후 재시도...`);
                await delay(backoff);
                continue;
            }

            if (response.status === 403) {
                console.warn('[API] ⚠️ 접근 차단 감지. 30초 대기...');
                await delay(30000);
                continue;
            }

            return response;
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw error;
            }
            console.error(`[API] 네트워크 에러: ${error.message}. 재시도 ${i + 1}/${maxRetries}`);
            await delay(1000);
        }
    }

    throw new Error('[API] 최대 재시도 횟수 초과');
}

// ============================================================
// API 함수들
// ============================================================

/**
 * 게시물 목록 HTML 가져오기
 * 
 * GET /mgallery/board/lists/?id={갤러리ID}&page={페이지}
 * 
 * @param {number} page - 페이지 번호 (1~)
 * @returns {Promise<string>} 페이지 HTML
 */
async function fetchPostListHTML(config = {}, page = 1) {
    const resolved = resolveConfig(config);
    const url = `${resolved.baseUrl}/mgallery/board/lists/?id=${resolved.galleryId}&page=${page}`;

    const response = await dcFetchWithRetry(url);
    return await response.text();
}

/**
 * 게시물 머릿말을 "도배기"로 분류 (배치)
 * 
 * POST /ajax/minor_manager_board_ajax/chg_headtext_batch
 * Body: ci_t, id, nos[], _GALLTYPE_, headtext
 * 
 * @param {string[]} postNos - 분류할 게시물 번호 배열
 * @returns {Promise<{success: boolean, successCount: number, failureCount: number, failedNos: string[], message: string}>}
 */
async function classifyPosts(config = {}, postNos, options = {}) {
    const resolved = resolveConfig(config);
    if (postNos.length === 0) {
        return {
            success: true,
            successCount: 0,
            failureCount: 0,
            failedNos: [],
            message: '분류할 게시물 없음',
        };
    }

    const ciToken = await getCiToken(resolved.baseUrl);
    if (!ciToken) {
        return {
            success: false,
            successCount: 0,
            failureCount: postNos.length,
            failedNos: [...postNos],
            message: 'ci_t 토큰(ci_c 쿠키) 없음. 로그인 상태를 확인하세요.',
        };
    }

    const uniquePostNos = [...new Set(postNos.map((no) => String(no)))];
    const chunks = chunkArray(uniquePostNos, resolved.classifyBatchSize);
    const aggregate = {
        successCount: 0,
        failedNos: [],
        messages: [],
    };

    for (const chunk of chunks) {
        const result = await classifyPostsWithFallback(resolved, ciToken, chunk, options);
        aggregate.successCount += result.successCount;
        aggregate.failedNos.push(...result.failedNos);
        if (result.message) {
            aggregate.messages.push(result.message);
        }
    }

    return {
        success: aggregate.failedNos.length === 0,
        successCount: aggregate.successCount,
        failureCount: aggregate.failedNos.length,
        failedNos: aggregate.failedNos,
        message: aggregate.messages.join(' | '),
    };
}

async function classifyPostsWithFallback(config, ciToken, postNos, options = {}) {
    const batchResult = await classifyPostBatch(config, ciToken, postNos, options);
    if (batchResult.success) {
        return {
            successCount: postNos.length,
            failedNos: [],
            message: '',
        };
    }

    if (postNos.length === 1 || batchResult.shouldSplit === false) {
        return {
            successCount: 0,
            failedNos: [...postNos],
            message: postNos.length === 1
                ? `#${postNos[0]} 분류 실패 - ${batchResult.message}`
                : `${postNos.length}개 배치 분류 실패 - ${batchResult.message}`,
        };
    }

    const midpoint = Math.ceil(postNos.length / 2);
    const leftResult = await classifyPostsWithFallback(config, ciToken, postNos.slice(0, midpoint), options);
    const rightResult = await classifyPostsWithFallback(config, ciToken, postNos.slice(midpoint), options);

    return {
        successCount: leftResult.successCount + rightResult.successCount,
        failedNos: [...leftResult.failedNos, ...rightResult.failedNos],
        message: [leftResult.message, rightResult.message].filter(Boolean).join(' | '),
    };
}

async function classifyPostBatch(config, ciToken, postNos, options = {}) {
    if (postNos.length === 0) {
        return { success: true, message: '' };
    }

    const url = `${config.baseUrl}/ajax/minor_manager_board_ajax/chg_headtext_batch`;

    // Form Data 직렬화
    const bodyParts = [
        `ci_t=${encodeURIComponent(ciToken)}`,
        `id=${encodeURIComponent(config.galleryId)}`,
        `_GALLTYPE_=${encodeURIComponent(config.galleryType)}`,
        `headtext=${encodeURIComponent(config.headtextId)}`,
    ];

    // nos[]는 배열 파라미터 → 수동 직렬화
    for (const no of postNos) {
        bodyParts.push(`nos%5B%5D=${encodeURIComponent(String(no))}`);
    }

    const response = await dcFetchWithRetry(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': `${config.baseUrl}/mgallery/board/lists/?id=${config.galleryId}`,
            'Origin': config.baseUrl,
        },
        body: bodyParts.join('&'),
        signal: options.signal,
    });

    const responseText = await response.text();

    try {
        const data = JSON.parse(responseText);
        return {
            success: isClassifyResponseSuccessful(response, data, responseText),
            message: JSON.stringify(data),
            shouldSplit: shouldSplitClassificationFailure(response, responseText),
        };
    } catch {
        return {
            success: isClassifyResponseSuccessful(response, null, responseText),
            message: summarizeResponseText(responseText),
            shouldSplit: shouldSplitClassificationFailure(response, responseText),
        };
    }
}

/**
 * ci_t 토큰 가져오기 (= ci_c 쿠키값)
 * @returns {Promise<string|null>}
 */
async function getCiToken(baseUrl = DC_CONFIG.baseUrl) {
    try {
        const cookie = await chrome.cookies.get({
            url: baseUrl,
            name: 'ci_c',
        });
        return cookie ? cookie.value : null;
    } catch (error) {
        console.error('[API] ci_c 쿠키 가져오기 실패:', error.message);
        return null;
    }
}

// ============================================================
// 유틸리티
// ============================================================

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArray(items, chunkSize) {
    const normalizedChunkSize = Math.max(1, chunkSize);
    const chunks = [];

    for (let index = 0; index < items.length; index += normalizedChunkSize) {
        chunks.push(items.slice(index, index + normalizedChunkSize));
    }

    return chunks;
}

function isClassifyResponseSuccessful(response, data, responseText) {
    if (!response.ok) {
        return false;
    }

    if (data && typeof data === 'object') {
        if ('success' in data) {
            return matchesSuccessValue(data.success);
        }

        const statusValue = data.result ?? data.status ?? data.msg ?? data.message;
        if (statusValue !== undefined) {
            return matchesSuccessValue(statusValue);
        }
    }

    const normalizedText = (responseText || '').trim().toLowerCase();
    if (!normalizedText) {
        return true;
    }

    if (/(정상적인 접근이 아닙니다|권한|실패|error|fail|denied|forbidden)/i.test(responseText)) {
        return false;
    }

    if (/(success|ok|완료)/i.test(responseText)) {
        return true;
    }

    return true;
}

function matchesSuccessValue(value) {
    const normalized = String(value).trim().toLowerCase();

    if (!normalized) {
        return false;
    }

    if (['true', '1', 'ok', 'success', 'completed'].includes(normalized)) {
        return true;
    }

    if (['false', '0', 'fail', 'failed', 'error', 'denied'].includes(normalized)) {
        return false;
    }

    if (/(실패|error|fail|denied|forbidden)/i.test(String(value))) {
        return false;
    }

    return /(성공|완료|success|ok)/i.test(String(value));
}

function summarizeResponseText(responseText) {
    return (responseText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

function shouldSplitClassificationFailure(response, responseText) {
    if ([401, 403].includes(response.status)) {
        return false;
    }

    if (/(정상적인 접근이 아닙니다|권한|로그인|forbidden|denied|ci_t)/i.test(responseText || '')) {
        return false;
    }

    return true;
}

// ============================================================
// Export
// ============================================================
export {
    DC_CONFIG,
    fetchPostListHTML,
    classifyPosts,
    getCiToken,
    delay,
};
