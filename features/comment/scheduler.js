/**
 * DC Comment Protect - 스케줄러 모듈
 * 
 * 기본적으로 1페이지를 순회하며 각 게시물의 유동닉 댓글을 감지하고 삭제합니다.
 */

import {
    fetchPostList,
    fetchPostPage,
    extractEsno,
    fetchAllComments,
    deleteComments,
    deleteAndBanComments,
    delay,
} from './api.js';

import {
    buildCommentRefluxSearchQuery,
    filterFluidComments,
    filterDeletionTargetComments,
    extractCommentNos,
    normalizeCommentMemo,
    normalizeCommentRefluxCompareKey,
} from './parser.js';
import {
    COMMENT_ATTACK_MODE,
    getCommentAttackModeHumanLabel,
    normalizeCommentAttackMode,
} from './attack-mode.js';
import {
    ensureCommentRefluxDatasetLoaded,
    hasCommentRefluxMemo,
    isCommentRefluxDatasetReady,
} from './comment-reflux-dataset.js';
import {
    ensureCommentRefluxSearchDuplicateBrokerLoaded,
    peekCommentRefluxSearchDuplicateDecision,
    resetCommentRefluxSearchDuplicateBrokerRuntime,
    resolveCommentRefluxSearchDuplicateDecision,
    setCommentRefluxSearchDuplicateBrokerLogger,
} from './comment-reflux-search-duplicate-broker.js';

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
            maxPage: 1,
            requestDelay: 100,     // 워커별 게시물 처리 후 딜레이 (ms)
            cycleDelay: 1000,      // 사이클 간 딜레이 (ms)
            postConcurrency: 50,   // 한 페이지에서 동시에 처리할 게시물 수
            commentPageConcurrency: 4, // 한 게시물의 댓글 페이지 동시 조회 수
            banOnDelete: true,     // 삭제 시 IP 차단 동시 수행
            avoidHour: '1',        // IP 차단 시간 (시)
            avoidReason: '0',      // 차단 사유 코드 (기타)
            avoidReasonText: '도배기로 인한 해당 유동IP차단',
            avoidTypeChk: true,    // IP 차단 여부
            refluxSearchGalleryId: '',
            excludePureHangulManualOnly: false,
        };
        this.currentSource = '';
        this.currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
    }

    // ============================================================
    // 제어
    // ============================================================

    async start(options = {}) {
        if (this.isRunning) {
            this.log('⚠️ 이미 실행 중입니다.');
            return;
        }

        this.currentSource = normalizeRunSource(options.source, 'manual');
        this.currentAttackMode = normalizeRequestedCommentAttackMode(options);
        await this.ensureDatasetReadyForAttackMode(this.currentAttackMode);
        await this.prepareCommentRefluxSearchRuntime(COMMENT_ATTACK_MODE.DEFAULT, this.currentAttackMode, {
            forceReset: true,
        });
        this.isRunning = true;
        if (this.currentSource === 'manual') {
            this.log(`🧷 수동 댓글 방어 시작 - ${getCommentAttackModeHumanLabel(this.currentAttackMode)} 모드로 처리합니다.`);
        }
        this.log(`🟢 자동 삭제 시작! (${getRunSourceLabel(this.currentSource)} / ${getCommentAttackModeHumanLabel(this.currentAttackMode)})`);
        await this.saveState();

        this.ensureRunLoop();
    }

    async stop() {
        this.isRunning = false;
        this.resetCommentRefluxSearchRuntime();
        setCommentRefluxSearchDuplicateBrokerLogger(null);
        this.currentSource = '';
        this.currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
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

            if (this.shouldFilterCommentRefluxForCurrentRun()) {
                // 역류기 댓글은 dataset/cache obvious hit를 먼저 지우고, miss만 검색으로 넘긴다.
                const refluxPlan = await this.planCommentRefluxDeletion(postNo, fluidComments);
                if (refluxPlan.immediateTargets.length <= 0 && refluxPlan.pendingSearchJobs.length <= 0) {
                    this.logCommentRefluxFilterSummary(postNo, refluxPlan.stats);
                    return true;
                }

                if (!this.isRunning) {
                    return false;
                }

                if (refluxPlan.immediateTargets.length > 0) {
                    const immediateBatchResult = await this.executeCommentDeletionBatch(
                        postNo,
                        refluxPlan.immediateTargets,
                        esno,
                        sharedEsno,
                        {
                            totalFluidCount: fluidComments.length,
                            phaseLabel: '즉시',
                        },
                    );
                    if (!immediateBatchResult.shouldContinue) {
                        this.logCommentRefluxFilterSummary(postNo, refluxPlan.stats);
                        return immediateBatchResult.shouldDelay;
                    }
                }

                if (refluxPlan.pendingSearchJobs.length <= 0) {
                    this.logCommentRefluxFilterSummary(postNo, refluxPlan.stats);
                    return true;
                }

                const deferredResolution = await this.resolveDeferredCommentRefluxTargets(
                    postNo,
                    refluxPlan.pendingSearchJobs,
                    refluxPlan.stats,
                );
                this.logCommentRefluxFilterSummary(postNo, deferredResolution.stats);

                if (deferredResolution.deferredTargets.length <= 0) {
                    return true;
                }

                if (!this.isRunning) {
                    return false;
                }

                const deferredBatchResult = await this.executeCommentDeletionBatch(
                    postNo,
                    deferredResolution.deferredTargets,
                    esno,
                    sharedEsno,
                    {
                        totalFluidCount: fluidComments.length,
                        phaseLabel: '검색확정',
                    },
                );
                return deferredBatchResult.shouldDelay;
            }

            const deletionTargets = filterDeletionTargetComments(fluidComments, {
                attackMode: this.currentAttackMode,
                matchesCommentRefluxMemo: hasCommentRefluxMemo,
            });

            if (deletionTargets.length === 0) {
                this.log(`ℹ️ #${postNo}: 유동닉 ${fluidComments.length}개 중 ${getDeletionSkipReasonText(this.currentAttackMode)} 삭제 대상 0개`);
                return true;
            }

            if (!this.isRunning) {
                return false;
            }

            const batchResult = await this.executeCommentDeletionBatch(
                postNo,
                deletionTargets,
                esno,
                sharedEsno,
                {
                    totalFluidCount: fluidComments.length,
                    phaseLabel: '',
                },
            );
            return batchResult.shouldDelay;

        } catch (error) {
            const postNo = typeof post === 'number' ? post : post.no;
            this.lastVerifiedDeletedCount = 0;
            this.log(`❌ #${postNo}: 처리 실패 - ${error.message}`);
            await this.saveState();
            return true;
        }
    }

    buildCommentRefluxSearchContext(postNo, comment, context = {}) {
        const plainText = normalizeCommentMemo(comment?.memo);
        const normalizedCompareKey = normalizeCommentRefluxCompareKey(plainText);
        const searchQuery = buildCommentRefluxSearchQuery(plainText);
        if (!plainText || !normalizedCompareKey || !searchQuery) {
            return null;
        }

        return {
            deleteGalleryId: String(context.deleteGalleryId || this.config.galleryId || '').trim().toLowerCase(),
            searchGalleryId: String(context.searchGalleryId || resolveCommentRefluxSearchGalleryId(this.config)).trim().toLowerCase(),
            currentPostNo: postNo,
            plainText,
            normalizedCompareKey,
            searchQuery,
        };
    }

    async planCommentRefluxDeletion(postNo, fluidComments) {
        await ensureCommentRefluxSearchDuplicateBrokerLoaded();
        const immediateTargetNos = new Set();
        const immediateTargets = [];
        const pendingSearchJobs = [];
        const sharedContext = {
            deleteGalleryId: String(this.config.galleryId || '').trim().toLowerCase(),
            searchGalleryId: resolveCommentRefluxSearchGalleryId(this.config),
        };
        const stats = {
            fluidCount: fluidComments.length,
            datasetCount: 0,
            searchCachePositiveCount: 0,
            searchPositiveCount: 0,
            searchNegativeCount: 0,
            searchErrorCount: 0,
            queueEnqueuedCount: 0,
            pendingAwaitCount: 0,
            cancelledCount: 0,
            totalTargetCount: 0,
        };

        for (const comment of fluidComments) {
            if (hasCommentRefluxMemo(comment?.memo)) {
                const commentNo = String(comment?.no || '').trim();
                if (commentNo && !immediateTargetNos.has(commentNo)) {
                    immediateTargetNos.add(commentNo);
                    immediateTargets.push(comment);
                }
                stats.datasetCount += 1;
                continue;
            }

            const searchContext = this.buildCommentRefluxSearchContext(postNo, comment, sharedContext);
            if (!searchContext) {
                stats.searchNegativeCount += 1;
                continue;
            }

            const cachedDecision = peekCommentRefluxSearchDuplicateDecision(searchContext);
            if (cachedDecision.result === 'positive') {
                const commentNo = String(comment?.no || '').trim();
                if (commentNo && !immediateTargetNos.has(commentNo)) {
                    immediateTargetNos.add(commentNo);
                    immediateTargets.push(comment);
                }
                stats.searchCachePositiveCount += 1;
                continue;
            }

            if (cachedDecision.result === 'negative') {
                stats.searchNegativeCount += 1;
                continue;
            }

            if (cachedDecision.result === 'error') {
                stats.searchErrorCount += 1;
                continue;
            }

            if (cachedDecision.result === 'pending') {
                stats.pendingAwaitCount += 1;
            } else if (cachedDecision.result === 'miss') {
                stats.queueEnqueuedCount += 1;
            }

            pendingSearchJobs.push({
                comment,
                context: searchContext,
                promise: resolveCommentRefluxSearchDuplicateDecision(searchContext),
            });
        }

        stats.totalTargetCount = stats.datasetCount + stats.searchCachePositiveCount;
        return {
            immediateTargets,
            pendingSearchJobs,
            stats,
        };
    }

    async resolveDeferredCommentRefluxTargets(postNo, pendingSearchJobs, stats) {
        const deferredTargetNos = new Set();
        const deferredTargets = [];
        const loggedPositiveKeys = new Set();
        const loggedErrorKeys = new Set();
        const settledJobs = await Promise.all(
            pendingSearchJobs.map(async (job) => ({
                ...job,
                decision: await job.promise,
            })),
        );

        for (const settledJob of settledJobs) {
            const { comment, context, decision } = settledJob;
            if (decision.result === 'positive') {
                const commentNo = String(comment?.no || '').trim();
                if (commentNo && !deferredTargetNos.has(commentNo)) {
                    deferredTargetNos.add(commentNo);
                    deferredTargets.push(comment);
                }
                stats.searchPositiveCount += 1;
                if (!loggedPositiveKeys.has(context.normalizedCompareKey) && decision.matchedRow) {
                    loggedPositiveKeys.add(context.normalizedCompareKey);
                    this.log(
                        `🔎 댓글 검색 중복 확인: ${context.plainText} -> ${decision.matchedRow.boardId} #${decision.matchedRow.postNo}`,
                    );
                }
                continue;
            }

            if (decision.result === 'negative') {
                stats.searchNegativeCount += 1;
                continue;
            }

            if (decision.result === 'cancelled') {
                stats.cancelledCount += 1;
                continue;
            }

            stats.searchErrorCount += 1;
            if (!loggedErrorKeys.has(context.normalizedCompareKey)) {
                loggedErrorKeys.add(context.normalizedCompareKey);
                this.log(`⚠️ 댓글 검색 확인 실패: ${context.plainText} - ${decision.errorMessage || 'unknown error'}`);
            }
        }

        stats.totalTargetCount = stats.datasetCount + stats.searchCachePositiveCount + stats.searchPositiveCount;
        if (!this.isRunning) {
            return {
                deferredTargets: [],
                stats,
            };
        }

        return {
            deferredTargets,
            stats,
        };
    }

    logCommentRefluxFilterSummary(postNo, stats = {}) {
        const summaryParts = [];
        if (stats.datasetCount > 0) {
            summaryParts.push(`dataset ${stats.datasetCount}`);
        }
        if (stats.searchCachePositiveCount > 0) {
            summaryParts.push(`search cache ${stats.searchCachePositiveCount}`);
        }
        if (stats.searchPositiveCount > 0) {
            summaryParts.push(`search positive ${stats.searchPositiveCount}`);
        }
        if (stats.searchNegativeCount > 0) {
            summaryParts.push(`search negative ${stats.searchNegativeCount}`);
        }
        if (stats.searchErrorCount > 0) {
            summaryParts.push(`search error ${stats.searchErrorCount}`);
        }
        if (stats.pendingAwaitCount > 0) {
            summaryParts.push(`pending ${stats.pendingAwaitCount}`);
        }
        if (stats.queueEnqueuedCount > 0) {
            summaryParts.push(`queue ${stats.queueEnqueuedCount}`);
        }
        if (stats.cancelledCount > 0) {
            summaryParts.push(`cancelled ${stats.cancelledCount}`);
        }

        this.log(
            `ℹ️ #${postNo}: 유동닉 ${Math.max(0, Number(stats.fluidCount) || 0)}개 중 `
            + `${summaryParts.length > 0 ? summaryParts.join(' / ') : '역류기 필터 통과 0'} `
            + `-> 삭제 대상 ${Math.max(0, Number(stats.totalTargetCount) || 0)}개`,
        );
    }

    async executeCommentDeletionBatch(postNo, targetComments, esno, sharedEsno, {
        totalFluidCount = 0,
        phaseLabel = '',
    } = {}) {
        const commentNos = [...new Set(extractCommentNos(targetComments))];
        if (commentNos.length <= 0) {
            return {
                shouldContinue: this.isRunning,
                shouldDelay: true,
            };
        }

        const phasePrefix = phaseLabel ? `${phaseLabel} ` : '';
        const deletionTargetText = commentNos.length === totalFluidCount
            ? `${commentNos.length}개`
            : `${totalFluidCount}개 중 삭제 대상 ${commentNos.length}개`;
        let result;

        if (this.config.banOnDelete) {
            this.log(`🗑️⛔ #${postNo}: ${phasePrefix}유동닉 ${deletionTargetText} 삭제+차단 중...`);
            result = await deleteAndBanComments(this.config, postNo, commentNos);
        } else {
            this.log(`🗑️ #${postNo}: ${phasePrefix}유동닉 ${deletionTargetText} 삭제 중...`);
            result = await deleteComments(this.config, postNo, commentNos);
        }

        if (!result.success) {
            this.lastVerifiedDeletedCount = 0;
            this.log(`❌ #${postNo}: ${phasePrefix}삭제 실패 - ${result.message}`);
            await this.saveState();
            return {
                shouldContinue: false,
                shouldDelay: true,
            };
        }

        const verification = await this.verifyDeletedComments(postNo, esno, commentNos, sharedEsno);
        const verifiedDeletedCount = verification.deletedCount;
        this.lastVerifiedDeletedCount = verifiedDeletedCount;
        this.recordVerifiedDeletionEvent(verifiedDeletedCount);
        this.totalDeleted += verifiedDeletedCount;

        if (verification.verificationFailed) {
            this.log(`⚠️ #${postNo}: ${phasePrefix}삭제 응답 성공, 검증 실패 - ${verification.message}`);
        } else if (verifiedDeletedCount === commentNos.length) {
            this.log(`✅ #${postNo}: ${phasePrefix}${verifiedDeletedCount}개 검증 삭제 완료 (총 ${this.totalDeleted}개)`);
        } else if (verifiedDeletedCount > 0) {
            this.log(
                `⚠️ #${postNo}: ${phasePrefix}${verifiedDeletedCount}/${commentNos.length}개만 검증 삭제됨 (총 ${this.totalDeleted}개)`,
            );
        } else {
            this.log(`⚠️ #${postNo}: ${phasePrefix}삭제 응답 성공, 검증 삭제 수 0개`);
        }

        await this.saveState();
        return {
            shouldContinue: this.isRunning,
            shouldDelay: true,
        };
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

    async ensureDatasetReadyForAttackMode(attackMode) {
        if (normalizeCommentAttackMode(attackMode) !== COMMENT_ATTACK_MODE.COMMENT_REFLUX) {
            return;
        }

        await ensureCommentRefluxDatasetLoaded();
        if (!isCommentRefluxDatasetReady()) {
            throw new Error('역류기 공용 dataset이 비어 있어 시작할 수 없습니다.');
        }
    }

    async prepareCommentRefluxSearchRuntime(previousAttackMode, nextAttackMode, { forceReset = false } = {}) {
        const normalizedPreviousAttackMode = normalizeCommentAttackMode(previousAttackMode);
        const normalizedNextAttackMode = normalizeCommentAttackMode(nextAttackMode);
        const involvesCommentReflux = normalizedPreviousAttackMode === COMMENT_ATTACK_MODE.COMMENT_REFLUX
            || normalizedNextAttackMode === COMMENT_ATTACK_MODE.COMMENT_REFLUX;
        if (!involvesCommentReflux) {
            return;
        }

        await ensureCommentRefluxSearchDuplicateBrokerLoaded();
        setCommentRefluxSearchDuplicateBrokerLogger((message) => this.log(message));
        if (forceReset || normalizedPreviousAttackMode !== normalizedNextAttackMode) {
            this.resetCommentRefluxSearchRuntime();
        }
    }

    resetCommentRefluxSearchRuntime() {
        resetCommentRefluxSearchDuplicateBrokerRuntime();
    }

    shouldExcludePureHangulForCurrentRun() {
        return this.currentAttackMode === COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL;
    }

    shouldFilterCommentRefluxForCurrentRun() {
        return this.currentAttackMode === COMMENT_ATTACK_MODE.COMMENT_REFLUX;
    }

    setCurrentSource(source, { logChange = true } = {}) {
        const nextSource = normalizeRunSource(source, this.isRunning ? 'manual' : '');
        if (this.currentSource === nextSource) {
            return false;
        }

        this.currentSource = nextSource;
        if (this.isRunning && logChange) {
            this.log(`ℹ️ 실행 출처 전환: ${getRunSourceLabel(nextSource)}`);
        }
        return true;
    }

    async setRuntimeAttackMode(attackMode, { logChange = true } = {}) {
        const nextAttackMode = normalizeCommentAttackMode(attackMode);
        const previousAttackMode = normalizeCommentAttackMode(this.currentAttackMode);
        await this.ensureDatasetReadyForAttackMode(nextAttackMode);
        await this.prepareCommentRefluxSearchRuntime(previousAttackMode, nextAttackMode);

        if (this.currentAttackMode === nextAttackMode) {
            return false;
        }

        this.currentAttackMode = nextAttackMode;
        if (this.isRunning && logChange) {
            this.log(`ℹ️ 댓글 공격 모드 전환: ${getCommentAttackModeHumanLabel(nextAttackMode)}`);
        }
        return true;
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
                    currentSource: this.currentSource,
                    currentAttackMode: this.currentAttackMode,
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
                this.config.avoidReasonText = normalizeAvoidReasonText(this.config.avoidReasonText);
                this.config.refluxSearchGalleryId = String(this.config.refluxSearchGalleryId || '').trim().toLowerCase();
                this.currentSource = normalizeRunSource(
                    schedulerState.currentSource,
                    schedulerState.isRunning ? 'manual' : '',
                );
                this.currentAttackMode = normalizeStoredCommentAttackMode(schedulerState);
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
        await this.ensureRuntimeReadyForRestoredMode();
        if (this.isRunning) {
            this.log('🔁 저장된 실행 상태 복원');
            this.ensureRunLoop();
        }
    }

    async ensureRuntimeReadyForRestoredMode() {
        if (!this.isRunning) {
            return;
        }

        try {
            await this.ensureDatasetReadyForAttackMode(this.currentAttackMode);
            await this.prepareCommentRefluxSearchRuntime(COMMENT_ATTACK_MODE.DEFAULT, this.currentAttackMode, {
                forceReset: true,
            });
        } catch (error) {
            this.log(`⚠️ 저장된 댓글 방어 모드 복원 실패 - ${error.message}. 일반 모드로 전환합니다.`);
            this.resetCommentRefluxSearchRuntime();
            this.currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
            await this.saveState();
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
            currentSource: this.currentSource,
            currentAttackMode: this.currentAttackMode,
            excludePureHangulMode: this.currentAttackMode === COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL,
            commentRefluxMode: this.currentAttackMode === COMMENT_ATTACK_MODE.COMMENT_REFLUX,
            excludePureHangulEffective: this.shouldExcludePureHangulForCurrentRun(),
            commentRefluxEffective: this.shouldFilterCommentRefluxForCurrentRun(),
        };
    }
}

function normalizeRunSource(source, fallback = '') {
    if (source === '') {
        return '';
    }

    if (source === 'manual' || source === 'monitor') {
        return source;
    }

    return fallback;
}

function getRunSourceLabel(source) {
    if (source === 'monitor') {
        return '자동';
    }
    if (source === 'manual') {
        return '수동';
    }
    return '미지정';
}

function normalizeRequestedCommentAttackMode(options = {}) {
    if (options.commentAttackMode !== undefined) {
        return normalizeCommentAttackMode(options.commentAttackMode);
    }

    if (options.excludePureHangulOnStart === true) {
        return COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL;
    }

    return COMMENT_ATTACK_MODE.DEFAULT;
}

function normalizeStoredCommentAttackMode(schedulerState) {
    if (schedulerState?.currentAttackMode !== undefined) {
        return normalizeCommentAttackMode(schedulerState.currentAttackMode);
    }

    if (schedulerState?.excludePureHangulMode === true) {
        return COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL;
    }

    return COMMENT_ATTACK_MODE.DEFAULT;
}

function getDeletionSkipReasonText(attackMode) {
    const normalizedAttackMode = normalizeCommentAttackMode(attackMode);

    if (normalizedAttackMode === COMMENT_ATTACK_MODE.COMMENT_REFLUX) {
        return '역류기 댓글 필터 후';
    }

    if (normalizedAttackMode === COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL) {
        return '순수 한글 제외로';
    }

    return '필터 후';
}

function resolveCommentRefluxSearchGalleryId(config = {}) {
    const explicitSearchGalleryId = String(config?.refluxSearchGalleryId || '').trim().toLowerCase();
    if (explicitSearchGalleryId) {
        return explicitSearchGalleryId;
    }

    return String(config?.galleryId || '').trim().toLowerCase();
}

function normalizeAvoidReasonText(value) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized === '도배' || normalized === '도배기') {
        return '도배기로 인한 해당 유동IP차단';
    }
    return normalized;
}

// ============================================================
// Export
// ============================================================
export { Scheduler };
