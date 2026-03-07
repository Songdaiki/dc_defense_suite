import {
    fetchPostListHTML,
    classifyPosts,
    delay,
} from '../post/api.js';

import {
    parseUidBearingPosts,
    extractHeadtextName,
} from '../post/parser.js';

import { fetchUserActivityStats } from './api.js';

const STORAGE_KEY = 'semiPostSchedulerState';

class Scheduler {
    constructor() {
        this.isRunning = false;
        this.runPromise = null;
        this.currentClassifyAbortController = null;
        this.currentPage = 0;
        this.totalClassified = 0;
        this.totalSuspiciousUid = 0;
        this.suspiciousUidSet = new Set();
        this.cycleCount = 0;
        this.logs = [];

        this.config = {
            galleryId: 'thesingularity',
            headtextId: '130',
            minPage: 1,
            maxPage: 5,
            requestDelay: 500,
            cycleDelay: 5000,
            minTotalActivityCount: 20,
            minPostRatioPercent: 95,
        };
    }

    async start() {
        if (this.isRunning) {
            this.log('⚠️ 이미 반고닉 분류가 실행 중입니다.');
            return;
        }

        this.isRunning = true;
        this.log('🟢 반고닉 도배기 분류 시작!');
        await this.saveState();
        this.ensureRunLoop();
    }

    async stop() {
        if (!this.isRunning && !this.runPromise) {
            this.log('⚠️ 이미 반고닉 분류가 정지 상태입니다.');
            await this.saveState();
            return;
        }

        this.isRunning = false;
        this.currentClassifyAbortController?.abort();

        if (this.runPromise) {
            this.log('⏳ 반고닉 도배기 분류 종료 대기...');
            try {
                await this.runPromise;
            } catch (error) {
                if (error?.name !== 'AbortError') {
                    console.error('[SemiPostScheduler] 종료 대기 중 오류:', error);
                }
            }
        }

        this.currentPage = 0;
        this.log('🔴 반고닉 도배기 분류 중지.');
        await this.saveState();
    }

    async run() {
        while (this.isRunning) {
            const cycleUidStatsCache = new Map();
            const cycleSuspiciousUidSet = new Set();

            try {
                const startPage = this.currentPage > 0 ? this.currentPage : this.config.minPage;

                for (let page = startPage; page <= this.config.maxPage; page += 1) {
                    if (!this.isRunning) {
                        break;
                    }

                    this.currentPage = page;
                    await this.saveState();

                    this.log(`📄 ${page}페이지 로딩...`);
                    const html = await fetchPostListHTML(this.config, page);
                    if (!this.isRunning) {
                        break;
                    }

                    const targetHeadName = extractHeadtextName(html, this.config.headtextId);
                    if (!targetHeadName) {
                        this.log(`⚠️ ${page}페이지: 도배기탭 번호 ${this.config.headtextId} 라벨 추출 실패, 페이지 스킵`);
                        await this.saveState();
                        if (this.isRunning && this.config.requestDelay > 0) {
                            await delayWhileRunning(this, this.config.requestDelay);
                        }
                        continue;
                    }

                    const uidPosts = parseUidBearingPosts(html, targetHeadName);
                    const uidGroups = groupPostsByUid(uidPosts);
                    this.log(`📄 ${page}페이지: 식별코드 글 ${uidPosts.length}개 / 작성자 ${uidGroups.length}명 발견`);

                    if (uidGroups.length === 0) {
                        if (this.isRunning && this.config.requestDelay > 0) {
                            await delayWhileRunning(this, this.config.requestDelay);
                        }
                        continue;
                    }

                    const suspiciousGroups = [];

                    for (const group of uidGroups) {
                        if (!this.isRunning) {
                            break;
                        }

                        const stats = await this.getOrFetchUidStats(cycleUidStatsCache, group.uid);
                        if (!this.isRunning) {
                            break;
                        }

                        if (!stats.success) {
                            this.log(`⚠️ ${group.uid}: 활동 통계 조회 실패 - ${stats.message}`);
                            continue;
                        }

                        if (isSuspiciousWriter(stats, this.config)) {
                            suspiciousGroups.push({ ...group, stats });

                            if (!cycleSuspiciousUidSet.has(group.uid)) {
                                cycleSuspiciousUidSet.add(group.uid);
                            }

                            if (!this.suspiciousUidSet.has(group.uid)) {
                                this.suspiciousUidSet.add(group.uid);
                                this.totalSuspiciousUid = this.suspiciousUidSet.size;
                            }

                            this.log(
                                `🚨 ${group.uid}: 글 ${stats.postCount} / 댓글 ${stats.commentCount} / 게시물비율 ${formatRatio(stats.postRatio)}%`,
                            );
                        }
                    }

                    if (!this.isRunning) {
                        break;
                    }

                    const postNos = extractGroupedPostNos(suspiciousGroups);
                    if (postNos.length === 0) {
                        this.log(`ℹ️ ${page}페이지: 판정된 반고닉 도배기 없음`);
                        await this.saveState();
                        if (this.isRunning && this.config.requestDelay > 0) {
                            await delayWhileRunning(this, this.config.requestDelay);
                        }
                        continue;
                    }

                    this.log(`🏷️ ${suspiciousGroups.length}명 / ${postNos.length}개 게시물 도배기 분류 중...`);
                    const abortController = new AbortController();
                    this.currentClassifyAbortController = abortController;
                    let result;

                    try {
                        result = await classifyPosts(this.config, postNos, {
                            signal: abortController.signal,
                        });
                    } finally {
                        if (this.currentClassifyAbortController === abortController) {
                            this.currentClassifyAbortController = null;
                        }
                    }

                    if (!this.isRunning) {
                        break;
                    }

                    if (result.successCount > 0) {
                        this.totalClassified += result.successCount;
                    }

                    if (result.success) {
                        this.log(`✅ ${result.successCount}개 분류 완료 (총 ${this.totalClassified}개)`);
                    } else if (result.successCount > 0) {
                        this.log(
                            `⚠️ ${result.successCount}개 분류, ${result.failureCount}개 실패 (총 ${this.totalClassified}개)`,
                        );
                        if (result.message) {
                            this.log(`⚠️ 상세: ${result.message}`);
                        }
                    } else {
                        this.log(`❌ 분류 실패 - ${result.message}`);
                    }

                    await this.saveState();

                    if (this.isRunning && this.config.requestDelay > 0) {
                        await delayWhileRunning(this, this.config.requestDelay);
                    }
                }

                if (this.isRunning) {
                    this.cycleCount += 1;
                    this.currentPage = 0;
                    this.log(`🔄 사이클 #${this.cycleCount} 완료. ${this.config.cycleDelay}ms 후 재시작...`);
                    await this.saveState();
                    await delayWhileRunning(this, this.config.cycleDelay);
                }
            } catch (error) {
                if (error?.name === 'AbortError') {
                    continue;
                }
                this.log(`❌ 오류 발생: ${error.message}`);
                console.error('[SemiPostScheduler] Error:', error);
                await this.saveState();

                if (this.isRunning) {
                    this.log('⏳ 10초 후 재시도...');
                    await delayWhileRunning(this, 10000);
                }
            }
        }

        this.currentClassifyAbortController = null;
        await this.saveState();
    }

    async getOrFetchUidStats(cache, uid) {
        if (cache.has(uid)) {
            return cache.get(uid);
        }

        const stats = await fetchUserActivityStats(this.config, uid);
        cache.set(uid, stats);
        return stats;
    }

    log(message) {
        const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
        const entry = `[${now}] ${message}`;

        console.log(`[SemiPostScheduler] ${message}`);

        this.logs.unshift(entry);
        if (this.logs.length > 100) {
            this.logs = this.logs.slice(0, 100);
        }
    }

    async saveState() {
        try {
            await chrome.storage.local.set({
                [STORAGE_KEY]: {
                    isRunning: this.isRunning,
                    currentPage: this.currentPage,
                    totalClassified: this.totalClassified,
                    totalSuspiciousUid: this.totalSuspiciousUid,
                    suspiciousUids: [...this.suspiciousUidSet],
                    cycleCount: this.cycleCount,
                    logs: this.logs.slice(0, 50),
                    config: this.config,
                },
            });
        } catch (error) {
            console.error('[SemiPostScheduler] 상태 저장 실패:', error.message);
        }
    }

    async loadState() {
        try {
            const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
            if (schedulerState) {
                this.isRunning = Boolean(schedulerState.isRunning);
                this.currentPage = schedulerState.currentPage || 0;
                this.totalClassified = schedulerState.totalClassified || 0;
                this.suspiciousUidSet = Array.isArray(schedulerState.suspiciousUids)
                    ? new Set(schedulerState.suspiciousUids.map((uid) => String(uid)))
                    : new Set();
                this.totalSuspiciousUid = this.suspiciousUidSet.size || schedulerState.totalSuspiciousUid || 0;
                this.cycleCount = schedulerState.cycleCount || 0;
                this.logs = schedulerState.logs || [];
                this.config = { ...this.config, ...schedulerState.config };
            }
        } catch (error) {
            console.error('[SemiPostScheduler] 상태 복원 실패:', error.message);
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

    getStatus() {
        return {
            isRunning: this.isRunning,
            currentPage: this.currentPage,
            totalClassified: this.totalClassified,
            totalSuspiciousUid: this.totalSuspiciousUid,
            cycleCount: this.cycleCount,
            logs: this.logs.slice(0, 20),
            config: this.config,
        };
    }
}

function groupPostsByUid(posts) {
    const groups = new Map();

    for (const post of posts) {
        if (!post.uid) {
            continue;
        }

        if (!groups.has(post.uid)) {
            groups.set(post.uid, {
                uid: post.uid,
                nick: post.nick,
                posts: [],
            });
        }

        groups.get(post.uid).posts.push({
            no: post.no,
            subject: post.subject,
            currentHead: post.currentHead,
        });
    }

    return Array.from(groups.values());
}

function isSuspiciousWriter(stats, config) {
    return stats.totalActivityCount >= config.minTotalActivityCount
        && stats.postRatio >= config.minPostRatioPercent;
}

function extractGroupedPostNos(groups) {
    return [...new Set(groups.flatMap((group) => group.posts.map((post) => String(post.no))))];
}

function formatRatio(value) {
    return Number(value || 0).toFixed(2);
}

async function delayWhileRunning(scheduler, ms) {
    if (!scheduler.isRunning || ms <= 0) {
        return;
    }

    const startedAt = Date.now();
    const sliceMs = Math.min(250, ms);
    while (scheduler.isRunning) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = ms - elapsedMs;
        if (remainingMs <= 0) {
            return;
        }

        await delay(Math.min(sliceMs, remainingMs));
    }
}

export { Scheduler };
