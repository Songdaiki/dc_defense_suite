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
import {
    ATTACK_MODE,
    formatAttackModeLabel,
    getAttackModeFilterLabel,
    getAttackModeHumanLabel,
    getAttackModeSubjectLabel,
    isEligibleForAttackMode,
    isNarrowAttackMode,
    normalizeAttackMode,
} from './attack-mode.js';
import {
    ensureSemiconductorRefluxEffectiveMatcherLoaded,
    hasSemiconductorRefluxEffectivePostTitle,
    isSemiconductorRefluxEffectiveMatcherReady,
} from './semiconductor-reflux-effective-matcher.js';
import {
    enqueueRefluxSearchDuplicate,
    ensureRefluxSearchDuplicateBrokerLoaded,
    peekRefluxSearchDuplicateDecision,
    resetRefluxSearchDuplicateBrokerRuntime,
    setRefluxSearchDuplicateBrokerLogger,
} from './reflux-search-duplicate-broker.js';
import {
    REFLUX_FOUR_STEP_STAGE,
    inspectRefluxFourStepCandidate,
} from '../reflux-four-step-filter.js';
import { resolveRefluxSearchGalleryId } from '../reflux-search-gallery-id.js';

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
        this.currentSource = 'manual';
        this.currentAttackMode = ATTACK_MODE.DEFAULT;
        this.pendingRuntimeTransition = null;

        // 설정 (기본값)
        this.config = {
            galleryId: 'thesingularity',
            headtextId: '130',
            refluxSearchGalleryId: '',
            minPage: 1,            // 시작 페이지
            maxPage: 1,            // 끝 페이지
            requestDelay: 500,     // 페이지 간 딜레이 (ms)
            cycleDelay: 1000,      // 사이클 간 딜레이 (ms)
            cutoffPostNo: 0,       // 시작 시점 snapshot 기준 게시물 번호
            manualAttackMode: ATTACK_MODE.DEFAULT,
        };
        setRefluxSearchDuplicateBrokerLogger((message) => {
            this.log(message);
        });
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
        if (shouldPreloadSemiconductorRefluxPostMatcher(normalizedOptions.attackMode)) {
            await ensureSemiconductorRefluxEffectiveMatcherLoaded();
        }
        this.assertManualAttackModeReady(normalizedOptions.source, normalizedOptions.attackMode);
        if (shouldUseSearchDuplicateForCurrentRun(normalizedOptions.source, normalizedOptions.attackMode)) {
            await ensureRefluxSearchDuplicateBrokerLoaded();
            resetRefluxSearchDuplicateBrokerRuntime();
        }
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
        } else if (shouldForcePageOneOnlyForSource(normalizedOptions.source, normalizedOptions.attackMode)) {
            this.log('🧷 수동 게시글 분류 cutoff 미사용 (1페이지 전체 검사 수동 모드, 1페이지 고정)');
        } else {
            this.log(`🧷 수동 게시글 분류 cutoff 미사용 (${getAttackModeHumanLabel(normalizedOptions.attackMode)} 수동 모드)`);
        }
        this.log(`🧠 ${getCutoffSourceLabel(normalizedOptions.source)} 분류 모드: ${formatAttackModeLabel(this.getEffectiveAttackMode())}`);
        this.log('🟢 자동 분류 시작!');
        await this.saveState();

        this.ensureRunLoop();
    }

    async stop() {
        this.isRunning = false;
        this.currentPage = 0;
        this.cancelPendingRuntimeTransition('게시글 분류가 정지되어 모드 전환을 취소했습니다.');
        this.clearRuntimeAttackMode();
        this.resetSearchDuplicateRuntime();
        this.log('🔴 자동 분류 중지.');
        await this.saveState();
    }

    resetSearchDuplicateRuntime() {
        resetRefluxSearchDuplicateBrokerRuntime();
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
        const currentAttackMode = normalizeAttackMode(this.currentAttackMode);
        const nextAttackMode = normalizeAttackMode(normalizedNextConfig.manualAttackMode);
        if (shouldPreloadSemiconductorRefluxPostMatcher(nextAttackMode)) {
            await ensureSemiconductorRefluxEffectiveMatcherLoaded();
        }
        this.assertManualAttackModeReady('manual', nextAttackMode);
        if (shouldUseSearchDuplicateForCurrentRun('manual', nextAttackMode)
            || shouldUseSearchDuplicateForCurrentRun('manual', currentAttackMode)) {
            await ensureRefluxSearchDuplicateBrokerLoaded();
        }
        const nextCutoffPostNo = isNarrowAttackMode(nextAttackMode)
            ? 0
            : await this.captureCutoffPostNoWithRetry(normalizedNextConfig);

        if (!isNarrowAttackMode(nextAttackMode) && nextCutoffPostNo <= 0) {
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
                resetRefluxSearchRuntime: shouldResetRefluxSearchRuntime(currentAttackMode, nextAttackMode),
                transitionLogMessage: buildManualRuntimeTransitionLogMessage({
                    nextAttackMode,
                    nextCutoffPostNo,
                    nextConfig: normalizedNextConfig,
                    modeChangeOnly: true,
                }),
                resolve,
                reject,
            };
            this.ensureRunLoop();
        });
    }

    async transitionManualRefluxConfigWhileRunning(nextConfig = {}) {
        if (!this.isRunning || this.currentSource !== 'manual') {
            throw new Error('수동 게시글 분류 실행 중에만 역류기 설정 전환을 적용할 수 있습니다.');
        }

        if (this.pendingRuntimeTransition) {
            throw new Error('게시글 분류 모드 전환이 이미 진행 중입니다. 잠시 후 다시 시도하세요.');
        }

        const currentAttackMode = normalizeAttackMode(this.currentAttackMode);
        if (currentAttackMode !== ATTACK_MODE.SEMICONDUCTOR_REFLUX) {
            return false;
        }

        await ensureSemiconductorRefluxEffectiveMatcherLoaded();
        await ensureRefluxSearchDuplicateBrokerLoaded();
        const normalizedNextConfig = {
            ...this.config,
            ...nextConfig,
            manualAttackMode: normalizeAttackMode(this.config.manualAttackMode),
            cutoffPostNo: 0,
        };

        return await new Promise((resolve, reject) => {
            this.pendingRuntimeTransition = {
                nextConfig: {
                    ...nextConfig,
                    manualAttackMode: normalizeAttackMode(this.config.manualAttackMode),
                    cutoffPostNo: 0,
                },
                nextAttackMode: currentAttackMode,
                nextCutoffPostNo: 0,
                resetRefluxSearchRuntime: true,
                transitionLogMessage: buildManualRuntimeTransitionLogMessage({
                    nextAttackMode: currentAttackMode,
                    nextCutoffPostNo: 0,
                    nextConfig: normalizedNextConfig,
                    modeChangeOnly: false,
                }),
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
            if (pendingRuntimeTransition.resetRefluxSearchRuntime) {
                this.resetSearchDuplicateRuntime();
            }

            this.log(
                pendingRuntimeTransition.transitionLogMessage
                    || buildManualRuntimeTransitionLogMessage({
                        nextAttackMode: pendingRuntimeTransition.nextAttackMode,
                        nextCutoffPostNo: pendingRuntimeTransition.nextCutoffPostNo,
                        nextConfig: this.config,
                        modeChangeOnly: true,
                    }),
            );

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

                const [minPage, maxPage] = getRuntimePageRange(
                    this.config,
                    this.currentSource,
                    this.getEffectiveAttackMode(),
                );
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
                    const shouldUseSearchDuplicate = shouldUseSearchDuplicateForCurrentRun(this.currentSource, effectiveAttackMode);
                    const refluxFilterResult = shouldUseSearchDuplicate
                        ? await filterRefluxCandidatePosts(basePosts, {
                            deleteGalleryId: this.config.galleryId,
                            searchGalleryId: resolveRefluxSearchGalleryId(this.config),
                        })
                        : null;
                    const candidatePosts = refluxFilterResult
                        ? refluxFilterResult.candidatePosts
                        : basePosts.filter((post) => isEligibleForAttackMode(post, effectiveAttackMode, {
                            isSemiconductorRefluxDatasetReady: isSemiconductorRefluxEffectiveMatcherReady(),
                            matchesSemiconductorRefluxTitle: hasSemiconductorRefluxEffectivePostTitle,
                        }));
                    const filterLabel = shouldUseSearchDuplicate
                        ? '역류기 검색/데이터셋 필터'
                        : getAttackModeFilterLabel(effectiveAttackMode);
                    const refluxSummary = refluxFilterResult
                        ? buildRefluxFilterSummary(refluxFilterResult.stats)
                        : '';

                    if (isNarrowAttackMode(effectiveAttackMode)) {
                        if (shouldApplyCutoff) {
                            this.log(
                                `📄 ${page}페이지: 유동닉 ${fluidPosts.length}개 발견, cutoff 이후 ${basePosts.length}개, ${filterLabel} 후 ${candidatePosts.length}개${refluxSummary}`,
                            );
                        } else {
                            this.log(
                                `📄 ${page}페이지: 유동닉 ${fluidPosts.length}개 발견, 기존 포함 ${basePosts.length}개, ${filterLabel} 후 ${candidatePosts.length}개${refluxSummary}`,
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
                            : `${page}페이지 기존 포함 ${getAttackModeSubjectLabel(effectiveAttackMode)} 게시물`,
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
            if (this.isRunning && shouldPreloadSemiconductorRefluxPostMatcher(this.currentAttackMode)) {
                await ensureSemiconductorRefluxEffectiveMatcherLoaded();
            }
            if (this.isRunning && shouldUseSearchDuplicateForCurrentRun(this.currentSource, this.currentAttackMode)) {
                await ensureRefluxSearchDuplicateBrokerLoaded();
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

    assertManualAttackModeReady(source, attackMode) {
        if (source !== 'manual') {
            return;
        }

        if (normalizeAttackMode(attackMode) !== ATTACK_MODE.SEMICONDUCTOR_REFLUX) {
            return;
        }
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

function normalizeRunSource(value, fallback = 'manual') {
    return value === 'monitor' || value === 'manual'
        ? value
        : fallback;
}

function shouldApplyCutoffForSource(source, attackMode) {
    if (source === 'monitor') {
        return true;
    }

    return !isNarrowAttackMode(attackMode);
}

function shouldForcePageOneOnlyForSource(source, attackMode) {
    return source === 'manual' && normalizeAttackMode(attackMode) === ATTACK_MODE.PAGE1_NO_CUTOFF;
}

function getNormalizedPageRange(config = {}) {
    const minPage = Math.max(1, Number(config.minPage) || 1);
    const maxPage = Math.max(minPage, Number(config.maxPage) || minPage);
    return [minPage, maxPage];
}

function getRuntimePageRange(config = {}, source, attackMode) {
    if (shouldForcePageOneOnlyForSource(source, attackMode)) {
        return [1, 1];
    }

    return getNormalizedPageRange(config);
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

function shouldUseSearchDuplicateForCurrentRun(source, attackMode) {
    return normalizeAttackMode(attackMode) === ATTACK_MODE.SEMICONDUCTOR_REFLUX;
}

function shouldResetRefluxSearchRuntime(currentAttackMode, nextAttackMode) {
    return normalizeAttackMode(currentAttackMode) === ATTACK_MODE.SEMICONDUCTOR_REFLUX
        || normalizeAttackMode(nextAttackMode) === ATTACK_MODE.SEMICONDUCTOR_REFLUX;
}

function shouldPreloadSemiconductorRefluxPostMatcher(attackMode) {
    return normalizeAttackMode(attackMode) === ATTACK_MODE.SEMICONDUCTOR_REFLUX;
}

function buildManualRuntimeTransitionLogMessage({
    nextAttackMode,
    nextCutoffPostNo,
    nextConfig,
    modeChangeOnly = true,
} = {}) {
    if (normalizeAttackMode(nextAttackMode) === ATTACK_MODE.SEMICONDUCTOR_REFLUX) {
        const searchGalleryId = resolveRefluxSearchGalleryId(nextConfig);
        const messagePrefix = modeChangeOnly ? '모드 적용' : '설정 적용';
        return `🔁 수동 역류기 공격 ${messagePrefix} - 첫 페이지부터 다시 스캔합니다. (검색 갤: ${searchGalleryId || '-'}, cutoff 미사용)`;
    }

    if (normalizeAttackMode(nextAttackMode) === ATTACK_MODE.PAGE1_NO_CUTOFF) {
        return '🔁 수동 1페이지 전체 검사 모드 적용 - 1페이지만 다시 스캔합니다. (cutoff 미사용, 1페이지 고정)';
    }

    if (isNarrowAttackMode(nextAttackMode)) {
        return `🔁 수동 ${getAttackModeHumanLabel(nextAttackMode)} 모드 적용 - 첫 페이지부터 다시 스캔합니다. (cutoff 미사용)`;
    }

    return `🔁 수동 일반 공격 모드 적용 - 새 cutoff (#${nextCutoffPostNo}) 기준으로 첫 페이지부터 다시 스캔합니다.`;
}

async function filterRefluxCandidatePosts(posts, context = {}) {
    await ensureRefluxSearchDuplicateBrokerLoaded();

    const immediateMatches = [];
    const stats = {
        datasetCount: 0,
        positiveCacheCount: 0,
        negativeCount: 0,
        pendingCount: 0,
        errorCooldownCount: 0,
        queueEnqueuedCount: 0,
    };

    for (const post of Array.isArray(posts) ? posts : []) {
        const title = String(post?.subject || '').trim();
        if (!title) {
            continue;
        }

        const inspection = inspectRefluxFourStepCandidate({
            value: title,
            matchesDataset: hasSemiconductorRefluxEffectivePostTitle,
            buildSearchContext: () => ({
                deleteGalleryId: context.deleteGalleryId,
                searchGalleryId: context.searchGalleryId,
                postNo: post?.no,
                title,
            }),
            peekSearchDecision: peekRefluxSearchDuplicateDecision,
        });

        if (inspection.stage === REFLUX_FOUR_STEP_STAGE.DATASET) {
            immediateMatches.push(post);
            stats.datasetCount += 1;
            continue;
        }

        if (inspection.stage === REFLUX_FOUR_STEP_STAGE.SEARCH_CACHE_POSITIVE) {
            immediateMatches.push(post);
            stats.positiveCacheCount += 1;
            continue;
        }

        if (inspection.stage === REFLUX_FOUR_STEP_STAGE.SEARCH_NEGATIVE) {
            stats.negativeCount += 1;
            continue;
        }

        if (inspection.stage === REFLUX_FOUR_STEP_STAGE.SEARCH_PENDING) {
            stats.pendingCount += 1;
            continue;
        }

        if (inspection.stage === REFLUX_FOUR_STEP_STAGE.SEARCH_ERROR) {
            stats.errorCooldownCount += 1;
            continue;
        }

        const didEnqueue = enqueueRefluxSearchDuplicate(inspection.searchContext);
        if (didEnqueue) {
            stats.queueEnqueuedCount += 1;
        }
    }

    return {
        candidatePosts: immediateMatches,
        stats,
    };
}

function buildRefluxFilterSummary(stats = {}) {
    const summaryParts = [];
    if (stats.positiveCacheCount > 0) {
        summaryParts.push(`search cache ${stats.positiveCacheCount}`);
    }
    if (stats.datasetCount > 0) {
        summaryParts.push(`dataset ${stats.datasetCount}`);
    }
    if (stats.pendingCount > 0) {
        summaryParts.push(`pending ${stats.pendingCount}`);
    }
    if (stats.negativeCount > 0) {
        summaryParts.push(`negative ${stats.negativeCount}`);
    }
    if (stats.errorCooldownCount > 0) {
        summaryParts.push(`error cooldown ${stats.errorCooldownCount}`);
    }
    if (stats.queueEnqueuedCount > 0) {
        summaryParts.push(`queue ${stats.queueEnqueuedCount}`);
    }

    return summaryParts.length > 0
        ? ` (${summaryParts.join(', ')})`
        : '';
}
