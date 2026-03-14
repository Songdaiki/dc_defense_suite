/**
 * DC Post Protect - 스케줄러 모듈
 * 
 * 기본적으로 1페이지를 순회하며 유동닉 게시물을 감지하고 "도배기"로 분류합니다.
 * 
 * 기존 dc_comment_potect 대비 단순화:
 * - 게시물에 진입하지 않음 (목록 HTML에서 바로 판별)
 * - 댓글 API 호출 불필요
 * - 페이지 단위 배치 처리 (postConcurrency 불필요)
 */

import {
    fetchPostListHTML,
    classifyPosts,
    delay,
} from './api.js';

import {
    parseBoardPosts,
    parseFluidPosts,
    extractPostNos,
    extractHeadtextName,
} from './parser.js';

const STORAGE_KEY = 'postSchedulerState';

// ============================================================
// 스케줄러 클래스
// ============================================================

class Scheduler {
    constructor() {
        this.isRunning = false;
        this.runPromise = null;
        this.currentPage = 0;
        this.totalClassified = 0;
        this.cycleCount = 0;
        this.logs = [];

        // 설정 (기본값)
        this.config = {
            galleryId: 'thesingularity',
            headtextId: '130',
            minPage: 1,            // 시작 페이지
            maxPage: 1,            // 끝 페이지
            requestDelay: 500,     // 페이지 간 딜레이 (ms)
            cycleDelay: 1000,      // 사이클 간 딜레이 (ms)
            cutoffPostNo: 0,       // 시작 시점 snapshot 기준 게시물 번호
        };
    }

    // ============================================================
    // 제어
    // ============================================================

    async start(options = {}) {
        if (this.isRunning) {
            this.log('⚠️ 이미 실행 중입니다.');
            return;
        }

        const normalizedOptions = normalizeStartOptions(options);
        const cutoffPostNo = normalizedOptions.hasExplicitCutoff
            ? normalizedOptions.cutoffPostNo
            : await this.captureCutoffPostNoWithRetry();

        if (normalizedOptions.source === 'monitor' && cutoffPostNo <= 0) {
            throw new Error('게시글 분류 cutoff snapshot 추출에 실패했습니다.');
        }

        this.currentPage = 0;
        this.config.cutoffPostNo = cutoffPostNo;
        this.isRunning = true;
        this.log(`🧷 ${getCutoffSourceLabel(normalizedOptions.source)} cutoff 저장 (#${cutoffPostNo})`);
        this.log('🟢 자동 분류 시작!');
        await this.saveState();

        this.ensureRunLoop();
    }

    async stop() {
        this.isRunning = false;
        this.currentPage = 0;
        this.log('🔴 자동 분류 중지.');
        await this.saveState();
    }

    async captureCutoffPostNo() {
        let maxPostNo = 0;
        const [minPage, maxPage] = getNormalizedPageRange(this.config);

        for (let page = minPage; page <= maxPage; page += 1) {
            const html = await fetchPostListHTML(this.config, page);
            const posts = parseBoardPosts(html);
            maxPostNo = Math.max(maxPostNo, getMaxPostNo(posts));
        }

        return maxPostNo;
    }

    async captureCutoffPostNoWithRetry() {
        try {
            const cutoffPostNo = await this.captureCutoffPostNo();
            if (cutoffPostNo > 0) {
                return cutoffPostNo;
            }

            this.log('⚠️ 게시글 분류 cutoff snapshot 추출 실패, 1000ms 후 1회 재시도');
            await delay(1000);
            return await this.captureCutoffPostNo();
        } catch (error) {
            this.log(`⚠️ 게시글 분류 cutoff snapshot 추출 오류, 1000ms 후 1회 재시도 - ${error.message}`);
            await delay(1000);
            return await this.captureCutoffPostNo();
        }
    }

    async classifyPostsOnce(postNos, options = {}) {
        const uniquePostNos = dedupePostNos(postNos);
        if (uniquePostNos.length === 0) {
            return {
                success: true,
                successCount: 0,
                failureCount: 0,
                failedNos: [],
                message: '분류할 게시물 없음',
            };
        }

        const logLabel = String(options.logLabel || '1회성 분류').trim() || '1회성 분류';
        this.log(`🏷️ ${logLabel}: ${uniquePostNos.length}개 게시물 분류 시도`);

        const result = await classifyPosts(this.config, uniquePostNos, options);

        if (result.successCount > 0) {
            this.totalClassified += result.successCount;
        }

        if (result.success) {
            this.log(`✅ ${logLabel}: ${result.successCount}개 분류 완료 (총 ${this.totalClassified}개)`);
        } else if (result.successCount > 0) {
            this.log(`⚠️ ${logLabel}: ${result.successCount}개 분류, ${result.failureCount}개 실패 (총 ${this.totalClassified}개)`);
            if (result.message) {
                this.log(`⚠️ ${logLabel} 상세: ${result.message}`);
            }
        } else {
            this.log(`❌ ${logLabel}: 분류 실패 - ${result.message}`);
        }

        await this.saveState();
        return result;
    }

    // ============================================================
    // 메인 루프
    // ============================================================

    async run() {
        while (this.isRunning) {
            try {
                const [minPage, maxPage] = getNormalizedPageRange(this.config);
                const startPage = this.currentPage > 0 ? this.currentPage : minPage;

                // minPage~maxPage 순회
                for (let page = startPage; page <= maxPage; page++) {
                    if (!this.isRunning) break;
                    this.currentPage = page;
                    await this.saveState();

                    // 1. 게시물 목록 HTML 가져오기
                    this.log(`📄 ${page}페이지 로딩...`);
                    const html = await fetchPostListHTML(this.config, page);
                    const targetHeadName = extractHeadtextName(html, this.config.headtextId);
                    if (!targetHeadName) {
                        this.log(`⚠️ ${page}페이지: 도배기탭 번호 ${this.config.headtextId} 라벨 추출 실패, 페이지 스킵`);
                        await this.saveState();
                        if (this.config.requestDelay > 0) {
                            await delay(this.config.requestDelay);
                        }
                        continue;
                    }

                    // 2. 유동닉 게시물 파싱
                    const fluidPosts = parseFluidPosts(html, targetHeadName);
                    const candidatePosts = fluidPosts.filter((post) => isPostAfterCutoff(post, this.config.cutoffPostNo));
                    this.log(`📄 ${page}페이지: 유동닉 ${fluidPosts.length}개 발견, cutoff 이후 ${candidatePosts.length}개`);

                    if (candidatePosts.length === 0) {
                        if (this.config.requestDelay > 0) {
                            await delay(this.config.requestDelay);
                        }
                        continue;
                    }

                    // 3. "도배기"로 분류
                    const postNos = extractPostNos(candidatePosts);
                    await this.classifyPostsOnce(postNos, {
                        logLabel: `${page}페이지 cutoff 이후 게시물`,
                    });

                    await this.saveState();

                    if (this.config.requestDelay > 0) {
                        await delay(this.config.requestDelay);
                    }
                }

                // 사이클 완료
                if (this.isRunning) {
                    this.cycleCount++;
                    this.currentPage = 0;
                    this.log(`🔄 사이클 #${this.cycleCount} 완료. ${this.config.cycleDelay}ms 후 재시작...`);
                    await this.saveState();
                    await delay(this.config.cycleDelay);
                }

            } catch (error) {
                this.log(`❌ 오류 발생: ${error.message}`);
                console.error('[Scheduler] Error:', error);
                await this.saveState();

                if (this.isRunning) {
                    this.log('⏳ 10초 후 재시도...');
                    await delay(10000);
                }
            }
        }

        await this.saveState();
    }

    // ============================================================
    // 로그
    // ============================================================

    log(message) {
        const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const entry = `[${now}] ${message}`;

        console.log(`[Scheduler] ${message}`);

        this.logs.unshift(entry);
        if (this.logs.length > 100) {
            this.logs = this.logs.slice(0, 100);
        }
    }

    // ============================================================
    // 상태 저장/복원
    // ============================================================

    async saveState() {
        try {
            await chrome.storage.local.set({
                [STORAGE_KEY]: {
                    isRunning: this.isRunning,
                    currentPage: this.currentPage,
                    totalClassified: this.totalClassified,
                    cycleCount: this.cycleCount,
                    logs: this.logs.slice(0, 50), // 최근 50개만 저장
                    config: this.config,
                },
            });
        } catch (error) {
            console.error('[Scheduler] 상태 저장 실패:', error.message);
        }
    }

    async loadState() {
        try {
            const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
            if (schedulerState) {
                this.isRunning = Boolean(schedulerState.isRunning);
                this.currentPage = schedulerState.currentPage || 0;
                this.totalClassified = schedulerState.totalClassified || 0;
                this.cycleCount = schedulerState.cycleCount || 0;
                this.logs = schedulerState.logs || [];
                this.config = { ...this.config, ...schedulerState.config };
            }
        } catch (error) {
            console.error('[Scheduler] 상태 복원 실패:', error.message);
        }
    }

    ensureRunLoop() {
        if (!this.isRunning || this.runPromise) {
            return;
        }

        this.runPromise = this.run().finally(() => {
            this.runPromise = null;
        });
    }

    async resumeIfNeeded() {
        if (this.runPromise) {
            return;
        }

        await this.loadState();
        if (this.isRunning) {
            this.log('🔁 저장된 실행 상태 복원');
            this.ensureRunLoop();
        }
    }

    // ============================================================
    // 현재 상태 조회 (팝업에서 사용)
    // ============================================================

    getStatus() {
        return {
            isRunning: this.isRunning,
            currentPage: this.currentPage,
            totalClassified: this.totalClassified,
            cycleCount: this.cycleCount,
            logs: this.logs.slice(0, 20), // 팝업에는 최근 20개만
            config: this.config,
        };
    }
}

// ============================================================
// Export
// ============================================================
export { Scheduler };

function normalizeStartOptions(options = {}) {
    const source = String(options?.source || 'manual').trim() || 'manual';
    const rawCutoffPostNo = options?.cutoffPostNo;
    const hasExplicitCutoff = rawCutoffPostNo !== undefined && rawCutoffPostNo !== null && String(rawCutoffPostNo).trim() !== '';
    const cutoffPostNo = hasExplicitCutoff ? Number(rawCutoffPostNo) : 0;

    return {
        source,
        cutoffPostNo,
        hasExplicitCutoff: hasExplicitCutoff && Number.isFinite(cutoffPostNo),
    };
}

function getCutoffSourceLabel(source) {
    return source === 'monitor' ? '감시 자동화' : '수동 게시글 분류';
}

function getNormalizedPageRange(config = {}) {
    const minPage = Math.max(1, Number(config.minPage) || 1);
    const maxPage = Math.max(minPage, Number(config.maxPage) || minPage);
    return [minPage, maxPage];
}

function getMaxPostNo(posts) {
    return posts.reduce((maxPostNo, post) => Math.max(maxPostNo, Number(post?.no) || 0), 0);
}

function isPostAfterCutoff(post, cutoffPostNo) {
    return Number(post?.no) > (Number(cutoffPostNo) || 0);
}

function dedupePostNos(postNos) {
    return [...new Set(
        (Array.isArray(postNos) ? postNos : [])
            .map((postNo) => String(postNo || '').trim())
            .filter((postNo) => /^\d+$/.test(postNo)),
    )];
}
