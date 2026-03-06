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
        this.logs = [];

        // 설정 (기본값)
        this.config = {
            minPage: 1,            // 시작 페이지 (테스트용)
            maxPage: 5,
            requestDelay: 500,     // API 요청 간 딜레이 (ms)
            cycleDelay: 5000,      // 사이클 간 딜레이 (ms)
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
                    const { posts, esno } = await fetchPostList(page);
                    this.log(`📄 ${page}페이지: ${posts.length}개 게시물 발견`);

                    // 각 게시물 처리
                    for (const post of posts) {
                        if (!this.isRunning) break;
                        this.currentPostNo = post.no;
                        await this.saveState();

                        const shouldDelay = await this.processPost(post, esno);
                        if (shouldDelay) {
                            await delay(this.config.requestDelay);
                        }
                    }
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
                const html = await fetchPostPage(postNo);
                esno = extractEsno(html);
            }

            if (!esno) {
                this.log(`⚠️ #${postNo}: e_s_n_o 토큰 추출 실패, 스킵`);
                return false;
            }

            // 2. 댓글 목록 가져오기
            let comments;

            try {
                ({ comments } = await fetchAllComments(postNo, esno));
            } catch (error) {
                if (!sharedEsno) {
                    throw error;
                }

                const html = await fetchPostPage(postNo);
                const refreshedEsno = extractEsno(html);
                if (!refreshedEsno) {
                    throw error;
                }

                ({ comments } = await fetchAllComments(postNo, refreshedEsno));
            }

            if (comments.length === 0) {
                return true; // 댓글 조회는 했으므로 요청 딜레이는 적용
            }

            // 3. 유동닉 필터링
            const fluidComments = filterFluidComments(comments);

            if (fluidComments.length === 0) {
                return true;
            }

            // 4. 댓글 삭제
            const commentNos = extractCommentNos(fluidComments);
            this.log(`🗑️ #${postNo}: 유동닉 ${fluidComments.length}개 삭제 중...`);

            const result = await deleteComments(postNo, commentNos);

            if (result.success) {
                this.totalDeleted += fluidComments.length;
                this.log(`✅ #${postNo}: ${fluidComments.length}개 삭제 완료 (총 ${this.totalDeleted}개)`);
                await this.saveState();
            } else {
                this.log(`❌ #${postNo}: 삭제 실패 - ${result.message}`);
                await this.saveState();
            }

            return true;

        } catch (error) {
            const postNo = typeof post === 'number' ? post : post.no;
            this.log(`❌ #${postNo}: 처리 실패 - ${error.message}`);
            await this.saveState();
            return true;
        }
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
                schedulerState: {
                    isRunning: this.isRunning,
                    currentPage: this.currentPage,
                    currentPostNo: this.currentPostNo,
                    totalDeleted: this.totalDeleted,
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
            const { schedulerState } = await chrome.storage.local.get('schedulerState');
            if (schedulerState) {
                this.isRunning = Boolean(schedulerState.isRunning);
                this.currentPage = schedulerState.currentPage || 0;
                this.currentPostNo = schedulerState.currentPostNo || 0;
                this.totalDeleted = schedulerState.totalDeleted || 0;
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
            currentPostNo: this.currentPostNo,
            totalDeleted: this.totalDeleted,
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
