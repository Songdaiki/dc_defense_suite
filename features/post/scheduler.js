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
    isHanCjkSpamLikePost,
} from './parser.js';

const STORAGE_KEY = 'postSchedulerState';
const ATTACK_MODE = {
    DEFAULT: 'default',
    CJK_NARROW: 'cjk_narrow',
};

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
        this.currentSource = 'manual';
        this.currentAttackMode = ATTACK_MODE.DEFAULT;
        this.pendingRuntimeTransition = null;

        // 설정 (기본값)
        this.config = {
            galleryId: 'thesingularity',
            headtextId: '130',
            minPage: 1,            // 시작 페이지
            maxPage: 1,            // 끝 페이지
            requestDelay: 500,     // 페이지 간 딜레이 (ms)
            cycleDelay: 1000,      // 사이클 간 딜레이 (ms)
            cutoffPostNo: 0,       // 시작 시점 snapshot 기준 게시물 번호
            manualAttackMode: ATTACK_MODE.DEFAULT,
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
        const shouldApplyCutoff = shouldApplyCutoffForSource(
            normalizedOptions.source,
            normalizedOptions.attackMode,
        );
        const cutoffPostNo = normalizedOptions.hasExplicitCutoff
            ? normalizedOptions.cutoffPostNo
            : shouldApplyCutoff
                ? await this.captureCutoffPostNoWithRetry()
                : 0;

        if (normalizedOptions.source === 'monitor' && cutoffPostNo <= 0) {
            throw new Error('게시글 분류 cutoff snapshot 추출에 실패했습니다.');
        }

        this.currentPage = 0;
        this.config.cutoffPostNo = cutoffPostNo;
        this.currentSource = normalizedOptions.source;
        this.currentAttackMode = normalizedOptions.attackMode;
        this.isRunning = true;
        if (shouldApplyCutoff) {
            this.log(`🧷 ${getCutoffSourceLabel(normalizedOptions.source)} cutoff 저장 (#${cutoffPostNo})`);
        } else {
            this.log('🧷 수동 게시글 분류 cutoff 미사용 (중국어/한자 공격 수동 모드)');
        }
        this.log(`🧠 ${getCutoffSourceLabel(normalizedOptions.source)} 분류 모드: ${getAttackModeLabel(this.getEffectiveAttackMode())}`);
        this.log('🟢 자동 분류 시작!');
        await this.saveState();

        this.ensureRunLoop();
    }

    async stop() {
        this.isRunning = false;
        this.currentPage = 0;
        this.cancelPendingRuntimeTransition('게시글 분류가 정지되어 모드 전환을 취소했습니다.');
        this.clearRuntimeAttackMode();
        this.log('🔴 자동 분류 중지.');
        await this.saveState();
    }

    async captureCutoffPostNo(config = this.config) {
        let maxPostNo = 0;
        const [minPage, maxPage] = getNormalizedPageRange(config);

        for (let page = minPage; page <= maxPage; page += 1) {
            const html = await fetchPostListHTML(config, page);
            const posts = parseBoardPosts(html);
            maxPostNo = Math.max(maxPostNo, getMaxPostNo(posts));
        }

        return maxPostNo;
    }

    async captureCutoffPostNoWithRetry(config = this.config) {
        try {
            const cutoffPostNo = await this.captureCutoffPostNo(config);
            if (cutoffPostNo > 0) {
                return cutoffPostNo;
            }

            this.log('⚠️ 게시글 분류 cutoff snapshot 추출 실패, 1000ms 후 1회 재시도');
            await delay(1000);
            return await this.captureCutoffPostNo(config);
        } catch (error) {
            this.log(`⚠️ 게시글 분류 cutoff snapshot 추출 오류, 1000ms 후 1회 재시도 - ${error.message}`);
            await delay(1000);
            return await this.captureCutoffPostNo(config);
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

    setMonitorAttackMode(attackMode) {
        const normalizedAttackMode = normalizeAttackMode(attackMode);
        const sourceChanged = this.currentSource !== 'monitor';
        const modeChanged = this.currentAttackMode !== normalizedAttackMode;

        this.currentSource = 'monitor';
        this.currentAttackMode = normalizedAttackMode;
        return sourceChanged || modeChanged;
    }

    clearRuntimeAttackMode() {
        this.currentSource = 'manual';
        this.currentAttackMode = ATTACK_MODE.DEFAULT;
    }

    cancelPendingRuntimeTransition(message = '') {
        if (!this.pendingRuntimeTransition) {
            return false;
        }

        const pendingRuntimeTransition = this.pendingRuntimeTransition;
        this.pendingRuntimeTransition = null;
        if (typeof pendingRuntimeTransition.reject === 'function') {
            pendingRuntimeTransition.reject(new Error(String(message || '게시글 분류 모드 전환이 취소되었습니다.')));
        }
        return true;
    }

    getEffectiveAttackMode() {
        if (this.currentSource === 'monitor') {
            return normalizeAttackMode(this.currentAttackMode);
        }

        if (this.isRunning) {
            return normalizeAttackMode(this.currentAttackMode);
        }

        return normalizeAttackMode(this.config.manualAttackMode);
    }

    shouldApplyCutoffForCurrentRun() {
        return shouldApplyCutoffForSource(this.currentSource, this.getEffectiveAttackMode());
    }

    async transitionManualAttackModeWhileRunning(nextConfig = {}) {
        if (!this.isRunning || this.currentSource !== 'manual') {
            throw new Error('수동 게시글 분류 실행 중에만 모드 전환을 적용할 수 있습니다.');
        }

        if (this.pendingRuntimeTransition) {
            throw new Error('게시글 분류 모드 전환이 이미 진행 중입니다. 잠시 후 다시 시도하세요.');
        }

        const normalizedNextConfig = {
            ...this.config,
            ...nextConfig,
            manualAttackMode: normalizeAttackMode(nextConfig.manualAttackMode),
        };
        const nextAttackMode = normalizeAttackMode(normalizedNextConfig.manualAttackMode);
        const nextCutoffPostNo = nextAttackMode === ATTACK_MODE.CJK_NARROW
            ? 0
            : await this.captureCutoffPostNoWithRetry(normalizedNextConfig);

        if (nextAttackMode !== ATTACK_MODE.CJK_NARROW && nextCutoffPostNo <= 0) {
            throw new Error('게시글 분류 cutoff snapshot 추출에 실패했습니다.');
        }

        return await new Promise((resolve, reject) => {
            this.pendingRuntimeTransition = {
                nextConfig: {
                    ...nextConfig,
                    manualAttackMode: nextAttackMode,
                    cutoffPostNo: nextCutoffPostNo,
                },
                nextAttackMode,
                nextCutoffPostNo,
                resolve,
                reject,
            };
            this.ensureRunLoop();
        });
    }

    async applyPendingRuntimeTransitionIfNeeded() {
        if (!this.pendingRuntimeTransition) {
            return false;
        }

        const pendingRuntimeTransition = this.pendingRuntimeTransition;
        this.pendingRuntimeTransition = null;

        try {
            this.config = {
                ...this.config,
                ...pendingRuntimeTransition.nextConfig,
            };
            this.currentPage = 0;
            this.currentSource = 'manual';
            this.currentAttackMode = pendingRuntimeTransition.nextAttackMode;

            if (pendingRuntimeTransition.nextAttackMode === ATTACK_MODE.CJK_NARROW) {
                this.log('🔁 수동 중국어/한자 공격 모드 적용 - 첫 페이지부터 다시 스캔합니다. (cutoff 미사용)');
            } else {
                this.log(
                    `🔁 수동 일반 공격 모드 적용 - 새 cutoff (#${pendingRuntimeTransition.nextCutoffPostNo}) 기준으로 첫 페이지부터 다시 스캔합니다.`,
                );
            }

            await this.saveState();
            pendingRuntimeTransition.resolve();
            return true;
        } catch (error) {
            pendingRuntimeTransition.reject(error);
            throw error;
        }
    }

    // ============================================================
    // 메인 루프
    // ============================================================

    async run() {
        while (this.isRunning) {
            try {
                if (await this.applyPendingRuntimeTransitionIfNeeded()) {
                    continue;
                }

                const [minPage, maxPage] = getNormalizedPageRange(this.config);
                const startPage = this.currentPage > 0 ? this.currentPage : minPage;
                let shouldRestartFromFirstPage = false;

                // minPage~maxPage 순회
                for (let page = startPage; page <= maxPage; page++) {
                    if (!this.isRunning) break;
                    if (await this.applyPendingRuntimeTransitionIfNeeded()) {
                        shouldRestartFromFirstPage = true;
                        break;
                    }
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
                    const effectiveAttackMode = this.getEffectiveAttackMode();
                    const shouldApplyCutoff = this.shouldApplyCutoffForCurrentRun();
                    const basePosts = shouldApplyCutoff
                        ? fluidPosts.filter((post) => isPostAfterCutoff(post, this.config.cutoffPostNo))
                        : fluidPosts;
                    const candidatePosts = basePosts.filter((post) => isEligibleForAttackMode(post, effectiveAttackMode));

                    if (effectiveAttackMode === ATTACK_MODE.CJK_NARROW) {
                        if (shouldApplyCutoff) {
                            this.log(
                                `📄 ${page}페이지: 유동닉 ${fluidPosts.length}개 발견, cutoff 이후 ${basePosts.length}개, 한자/CJK 필터 후 ${candidatePosts.length}개`,
                            );
                        } else {
                            this.log(
                                `📄 ${page}페이지: 유동닉 ${fluidPosts.length}개 발견, 기존 포함 ${basePosts.length}개, 한자/CJK 필터 후 ${candidatePosts.length}개`,
                            );
                        }
                    } else {
                        this.log(`📄 ${page}페이지: 유동닉 ${fluidPosts.length}개 발견, cutoff 이후 ${candidatePosts.length}개`);
                    }

                    if (candidatePosts.length === 0) {
                        if (this.config.requestDelay > 0) {
                            await delay(this.config.requestDelay);
                        }
                        continue;
                    }

                    // 3. "도배기"로 분류
                    const postNos = extractPostNos(candidatePosts);
                    await this.classifyPostsOnce(postNos, {
                        logLabel: shouldApplyCutoff
                            ? `${page}페이지 cutoff 이후 게시물`
                            : `${page}페이지 기존 포함 한자 제목 게시물`,
                    });

                    await this.saveState();

                    if (await this.applyPendingRuntimeTransitionIfNeeded()) {
                        shouldRestartFromFirstPage = true;
                        break;
                    }

                    if (this.config.requestDelay > 0) {
                        await delay(this.config.requestDelay);
                    }
                }

                if (shouldRestartFromFirstPage) {
                    continue;
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
                this.totalClassified = schedulerState.totalClassified || 0;
                this.cycleCount = schedulerState.cycleCount || 0;
                this.logs = schedulerState.logs || [];
                this.config = {
                    ...this.config,
                    ...schedulerState.config,
                    manualAttackMode: normalizeAttackMode(schedulerState?.config?.manualAttackMode),
                };
                this.pendingRuntimeTransition = null;
                this.currentSource = normalizeRunSource(
                    schedulerState.currentSource || '',
                    schedulerState.isRunning ? 'manual' : 'manual',
                );
                this.currentAttackMode = normalizeAttackMode(schedulerState.currentAttackMode);
                if (!schedulerState.isRunning) {
                    this.clearRuntimeAttackMode();
                }
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
            currentSource: this.currentSource,
            currentAttackMode: this.currentAttackMode,
            effectiveAttackMode: this.getEffectiveAttackMode(),
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
    const attackMode = normalizeAttackMode(options?.attackMode);

    return {
        source,
        attackMode,
        cutoffPostNo,
        hasExplicitCutoff: hasExplicitCutoff && Number.isFinite(cutoffPostNo),
    };
}

function getCutoffSourceLabel(source) {
    return source === 'monitor' ? '감시 자동화' : '수동 게시글 분류';
}

function getAttackModeLabel(mode) {
    return normalizeAttackMode(mode) === ATTACK_MODE.CJK_NARROW
        ? 'CJK_NARROW'
        : 'DEFAULT';
}

function normalizeAttackMode(value) {
    return value === ATTACK_MODE.CJK_NARROW
        ? ATTACK_MODE.CJK_NARROW
        : ATTACK_MODE.DEFAULT;
}

function normalizeRunSource(value, fallback = 'manual') {
    return value === 'monitor' || value === 'manual'
        ? value
        : fallback;
}

function shouldApplyCutoffForSource(source, attackMode) {
    if (source === 'monitor') {
        return true;
    }

    return normalizeAttackMode(attackMode) !== ATTACK_MODE.CJK_NARROW;
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

function isEligibleForAttackMode(post, attackMode) {
    if (normalizeAttackMode(attackMode) !== ATTACK_MODE.CJK_NARROW) {
        return true;
    }

    return isHanCjkSpamLikePost(post);
}

function dedupePostNos(postNos) {
    return [...new Set(
        (Array.isArray(postNos) ? postNos : [])
            .map((postNo) => String(postNo || '').trim())
            .filter((postNo) => /^\d+$/.test(postNo)),
    )];
}
