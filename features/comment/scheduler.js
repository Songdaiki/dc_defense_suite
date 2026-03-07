/**
 * DC Comment Protect - 스케줄러 모듈
 * 
 * 1~5페이지를 순회하며 각 게시물의 유동닉 댓글을 감지하고 삭제합니다.
 */

import {
    fetchPostList,
    fetchPostPage,
    extractEsno,
    fetchAllComments,
    deleteComments,
    delay,
} from './api.js';

import {
    filterFluidComments,
    extractCommentNos,
} from './parser.js';

const STORAGE_KEY = 'commentSchedulerState';
const MAX_VERIFICATION_EVENTS = 200;
const DEFAULT_VERIFICATION_WINDOW_MS = 30000;

// ============================================================
// 스케줄러 클래스
// ============================================================

class Scheduler {
    constructor() {
        this.isRunning = false;
        this.runPromise = null;
        this.currentPage = 0;
        this.currentPostNo = 0;
        this.totalDeleted = 0;
        this.cycleCount = 0;
        this.lastVerifiedDeletedCount = 0;
        this.verificationEvents = [];
        this.logs = [];

        // 설정 (기본값)
        this.config = {
            galleryId: 'thesingularity',
            minPage: 1,            // 시작 페이지 (테스트용)
            maxPage: 5,
            requestDelay: 100,     // 워커별 게시물 처리 후 딜레이 (ms)
            cycleDelay: 1000,      // 사이클 간 딜레이 (ms)
            postConcurrency: 50,   // 한 페이지에서 동시에 처리할 게시물 수
            commentPageConcurrency: 4, // 한 게시물의 댓글 페이지 동시 조회 수
        };
    }

    // ============================================================
    // 제어
    // ============================================================

    async start() {
        if (this.isRunning) {
            this.log('⚠️ 이미 실행 중입니다.');
            return;
        }

        this.isRunning = true;
        this.log('🟢 자동 삭제 시작!');
        await this.saveState();

        this.ensureRunLoop();
    }

    async stop() {
        this.isRunning = false;
        this.log('🔴 자동 삭제 중지.');
        await this.saveState();
    }

    // ============================================================
    // 메인 루프
    // ============================================================

    async run() {
        while (this.isRunning) {
            try {
                const startPage = this.currentPage > 0 ? this.currentPage : this.config.minPage;

                // minPage~maxPage 순회
                for (let page = startPage; page <= this.config.maxPage; page++) {
                    if (!this.isRunning) break;
                    this.currentPage = page;
                    this.currentPostNo = 0;
                    await this.saveState();

                    this.log(`📄 ${page}페이지 게시물 목록 로딩...`);
                    const { posts, esno } = await fetchPostList(this.config, page);
                    const candidatePosts = posts.filter((post) => post.commentCount > 0);
                    this.log(
                        `📄 ${page}페이지: ${posts.length}개 게시물, 댓글 있는 ${candidatePosts.length}개 병렬 처리 (${this.config.postConcurrency}동시)`,
                    );

                    if (candidatePosts.length === 0) {
                        continue;
                    }

                    await this.processPostsInParallel(candidatePosts, esno);
                }

                // 사이클 완료
                if (this.isRunning) {
                    this.cycleCount++;
                    this.currentPage = 0;
                    this.currentPostNo = 0;
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
    // 게시물 처리
    // ============================================================

    async processPost(post, sharedEsno = null) {
        try {
            const postNo = typeof post === 'number' ? post : post.no;
            const commentCount = typeof post === 'number' ? null : post.commentCount;

            if (commentCount === 0) {
                return false;
            }

            // 1. e_s_n_o 토큰 확보
            let esno = sharedEsno;
            if (!esno) {
                const html = await fetchPostPage(this.config, postNo);
                esno = extractEsno(html);
            }

            if (!esno) {
                this.log(`⚠️ #${postNo}: e_s_n_o 토큰 추출 실패, 스킵`);
                return false;
            }

            if (!this.isRunning) {
                return false;
            }

            // 2. 댓글 목록 가져오기
            let comments;

            try {
                ({ comments } = await fetchAllComments(
                    this.config,
                    postNo,
                    esno,
                    this.config.commentPageConcurrency,
                ));
            } catch (error) {
                if (!sharedEsno) {
                    throw error;
                }

                const html = await fetchPostPage(this.config, postNo);
                const refreshedEsno = extractEsno(html);
                if (!refreshedEsno) {
                    throw error;
                }

                ({ comments } = await fetchAllComments(
                    this.config,
                    postNo,
                    refreshedEsno,
                    this.config.commentPageConcurrency,
                ));
            }

            if (comments.length === 0) {
                return true; // 댓글 조회는 했으므로 요청 딜레이는 적용
            }

            // 3. 유동닉 필터링
            const fluidComments = filterFluidComments(comments);

            if (fluidComments.length === 0) {
                return true;
            }

            if (!this.isRunning) {
                return false;
            }

            // 4. 댓글 삭제
            const commentNos = extractCommentNos(fluidComments);
            this.log(`🗑️ #${postNo}: 유동닉 ${fluidComments.length}개 삭제 중...`);

            const result = await deleteComments(this.config, postNo, commentNos);

            if (result.success) {
                const verification = await this.verifyDeletedComments(postNo, esno, commentNos, sharedEsno);
                const verifiedDeletedCount = verification.deletedCount;

                this.lastVerifiedDeletedCount = verifiedDeletedCount;
                this.recordVerifiedDeletionEvent(verifiedDeletedCount);
                this.totalDeleted += verifiedDeletedCount;

                if (verification.verificationFailed) {
                    this.log(`⚠️ #${postNo}: 삭제 응답 성공, 검증 실패 - ${verification.message}`);
                } else if (verifiedDeletedCount === fluidComments.length) {
                    this.log(`✅ #${postNo}: ${verifiedDeletedCount}개 검증 삭제 완료 (총 ${this.totalDeleted}개)`);
                } else if (verifiedDeletedCount > 0) {
                    this.log(
                        `⚠️ #${postNo}: ${verifiedDeletedCount}/${fluidComments.length}개만 검증 삭제됨 (총 ${this.totalDeleted}개)`,
                    );
                } else {
                    this.log(`⚠️ #${postNo}: 삭제 응답 성공, 검증 삭제 수 0개`);
                }
                await this.saveState();
            } else {
                this.lastVerifiedDeletedCount = 0;
                this.log(`❌ #${postNo}: 삭제 실패 - ${result.message}`);
                await this.saveState();
            }

            return true;

        } catch (error) {
            const postNo = typeof post === 'number' ? post : post.no;
            this.lastVerifiedDeletedCount = 0;
            this.log(`❌ #${postNo}: 처리 실패 - ${error.message}`);
            await this.saveState();
            return true;
        }
    }

    async verifyDeletedComments(postNo, initialEsno, targetCommentNos, sharedEsno = null) {
        const normalizedTargets = targetCommentNos.map((no) => String(no));
        const targetSet = new Set(normalizedTargets);

        try {
            let esno = initialEsno;
            let comments;

            try {
                ({ comments } = await fetchAllComments(
                    this.config,
                    postNo,
                    esno,
                    this.config.commentPageConcurrency,
                ));
            } catch (error) {
                if (!sharedEsno) {
                    throw error;
                }

                const html = await fetchPostPage(this.config, postNo);
                const refreshedEsno = extractEsno(html);
                if (!refreshedEsno) {
                    throw error;
                }

                esno = refreshedEsno;
                ({ comments } = await fetchAllComments(
                    this.config,
                    postNo,
                    esno,
                    this.config.commentPageConcurrency,
                ));
            }

            const remainingActiveNos = new Set(
                extractCommentNos(filterFluidComments(comments))
                    .filter((no) => targetSet.has(String(no))),
            );

            return {
                deletedCount: normalizedTargets.length - remainingActiveNos.size,
                remainingCount: remainingActiveNos.size,
                remainingNos: [...remainingActiveNos],
                verificationFailed: false,
                message: '',
            };
        } catch (error) {
            return {
                deletedCount: 0,
                remainingCount: normalizedTargets.length,
                remainingNos: [...targetSet],
                verificationFailed: true,
                message: error.message,
            };
        }
    }

    async processPostsInParallel(posts, sharedEsno) {
        const workerCount = Math.max(1, Math.min(this.config.postConcurrency, posts.length));
        let nextIndex = 0;

        const workers = Array.from({ length: workerCount }, async () => {
            while (this.isRunning) {
                const currentIndex = nextIndex;
                nextIndex += 1;

                if (currentIndex >= posts.length) {
                    return;
                }

                const post = posts[currentIndex];
                this.currentPostNo = post.no;

                const shouldDelay = await this.processPost(post, sharedEsno);
                if (shouldDelay && this.config.requestDelay > 0) {
                    await delay(this.config.requestDelay);
                }
            }
        });

        await Promise.all(workers);
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

    recordVerifiedDeletionEvent(count) {
        const numericCount = Math.max(0, Number(count) || 0);
        const now = Date.now();

        this.pruneVerificationEvents(now);
        this.verificationEvents.push({
            at: now,
            count: numericCount,
        });

        if (this.verificationEvents.length > MAX_VERIFICATION_EVENTS) {
            this.verificationEvents = this.verificationEvents.slice(-MAX_VERIFICATION_EVENTS);
        }
    }

    pruneVerificationEvents(now = Date.now(), windowMs = DEFAULT_VERIFICATION_WINDOW_MS * 10) {
        const threshold = now - Math.max(windowMs, DEFAULT_VERIFICATION_WINDOW_MS);
        this.verificationEvents = this.verificationEvents.filter((event) => {
            if (!event || typeof event !== 'object') {
                return false;
            }

            const at = Number(event.at) || 0;
            return at >= threshold;
        });
    }

    getVerifiedDeletedCountWithin(windowMs = DEFAULT_VERIFICATION_WINDOW_MS) {
        const now = Date.now();
        const normalizedWindowMs = Math.max(1000, Number(windowMs) || DEFAULT_VERIFICATION_WINDOW_MS);

        this.pruneVerificationEvents(now, normalizedWindowMs * 10);

        return this.verificationEvents.reduce((sum, event) => {
            const at = Number(event.at) || 0;
            if (now - at > normalizedWindowMs) {
                return sum;
            }

            return sum + (Number(event.count) || 0);
        }, 0);
    }

    resetVerificationState() {
        this.lastVerifiedDeletedCount = 0;
        this.verificationEvents = [];
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
                    currentPostNo: this.currentPostNo,
                    totalDeleted: this.totalDeleted,
                    cycleCount: this.cycleCount,
                    lastVerifiedDeletedCount: this.lastVerifiedDeletedCount,
                    verificationEvents: this.verificationEvents.slice(-MAX_VERIFICATION_EVENTS),
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
                this.currentPostNo = schedulerState.currentPostNo || 0;
                this.totalDeleted = schedulerState.totalDeleted || 0;
                this.cycleCount = schedulerState.cycleCount || 0;
                this.lastVerifiedDeletedCount = schedulerState.lastVerifiedDeletedCount || 0;
                this.verificationEvents = Array.isArray(schedulerState.verificationEvents)
                    ? schedulerState.verificationEvents
                    : [];
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
            currentPostNo: this.currentPostNo,
            totalDeleted: this.totalDeleted,
            cycleCount: this.cycleCount,
            lastVerifiedDeletedCount: this.lastVerifiedDeletedCount,
            recentVerifiedDeletedCount: this.getVerifiedDeletedCountWithin(DEFAULT_VERIFICATION_WINDOW_MS),
            logs: this.logs.slice(0, 20), // 팝업에는 최근 20개만
            config: this.config,
        };
    }
}

// ============================================================
// Export
// ============================================================
export { Scheduler };
