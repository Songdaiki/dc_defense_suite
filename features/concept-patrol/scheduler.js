import {
  DEFAULT_CONFIG,
  delay,
  fetchConceptListPageHTML,
  fetchConceptPostViewHTML,
  releaseConceptPost,
} from '../concept-monitor/api.js';
import {
  parseConceptListDetectedMaxPage,
  parseConceptListPagePosts,
} from '../concept-monitor/parser.js';
import {
  BLOCK_COOLDOWN_MS,
  inspectConceptPostCandidate,
  isConceptBlockSignalMessage,
  releaseInspectedConceptCandidate,
} from '../concept-monitor/release-helper.js';
import {
  getConceptRecommendCutCoordinatorStatus,
  triggerConceptPatrolRecommendCutHold,
} from '../concept-monitor/recommend-cut-coordinator.js';

const STORAGE_KEY = 'conceptPatrolSchedulerState';
const DEFAULT_POLL_INTERVAL_MS = 30000;
const DEFAULT_PATROL_PAGES = 5;
const DEFAULT_PAGE_REQUEST_DELAY_MS = 500;
const DEFAULT_RELEASE_REQUEST_DELAY_MS = 500;
const DEFAULT_FLUID_RATIO_THRESHOLD_PERCENT = 90;
const DEFAULT_PATROL_DEFENDING_CANDIDATE_THRESHOLD = 2;
const DEFAULT_PATROL_DEFENDING_HOLD_MS = 300000;
const DEFAULT_SNAPSHOT_POST_LIMIT = 5;

class Scheduler {
  constructor(dependencies = {}) {
    this.conceptMonitorScheduler = dependencies.conceptMonitorScheduler || null;
    this.delayFn = dependencies.delayFn || delay;
    this.fetchConceptListPageHTML = dependencies.fetchConceptListPageHTML || fetchConceptListPageHTML;
    this.fetchConceptPostViewHTML = dependencies.fetchConceptPostViewHTML || fetchConceptPostViewHTML;
    this.releaseConceptPost = dependencies.releaseConceptPost || releaseConceptPost;
    this.parseConceptListDetectedMaxPage = dependencies.parseConceptListDetectedMaxPage || parseConceptListDetectedMaxPage;
    this.parseConceptListPagePosts = dependencies.parseConceptListPagePosts || parseConceptListPagePosts;
    this.inspectConceptPostCandidate = dependencies.inspectConceptPostCandidate || inspectConceptPostCandidate;
    this.releaseInspectedConceptCandidate = dependencies.releaseInspectedConceptCandidate || releaseInspectedConceptCandidate;
    this.triggerConceptPatrolRecommendCutHold = dependencies.triggerConceptPatrolRecommendCutHold || triggerConceptPatrolRecommendCutHold;

    this.isRunning = false;
    this.runPromise = null;
    this.currentPage = 0;
    this.currentPostNo = 0;
    this.cycleCount = 0;
    this.lastPollAt = '';
    this.lastDetectedMaxPage = 0;
    this.lastWindowSize = 0;
    this.lastNewPostCount = 0;
    this.lastCandidateCount = 0;
    this.totalDetectedCount = 0;
    this.totalReleasedCount = 0;
    this.totalFailedCount = 0;
    this.totalUnclearCount = 0;
    this.baselineReady = false;
    this.previousWindowPostNos = [];
    this.previousWindowMeta = {};
    this.baselineVersionKey = '';
    this.blockedUntilTs = 0;
    this.logs = [];

    this.config = normalizeConfig({
      galleryId: DEFAULT_CONFIG.galleryId,
      galleryType: DEFAULT_CONFIG.galleryType,
      baseUrl: DEFAULT_CONFIG.baseUrl,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      patrolPages: DEFAULT_PATROL_PAGES,
      pageRequestDelayMs: DEFAULT_PAGE_REQUEST_DELAY_MS,
      fluidRatioThresholdPercent: DEFAULT_FLUID_RATIO_THRESHOLD_PERCENT,
      patrolDefendingCandidateThreshold: DEFAULT_PATROL_DEFENDING_CANDIDATE_THRESHOLD,
      patrolDefendingHoldMs: DEFAULT_PATROL_DEFENDING_HOLD_MS,
      testMode: false,
    });
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 개념글순회가 실행 중입니다.');
      return;
    }

    this.isRunning = true;
    this.currentPage = 0;
    this.currentPostNo = 0;
    this.baselineReady = false;
    this.previousWindowPostNos = [];
    this.previousWindowMeta = {};
    this.baselineVersionKey = '';
    this.lastNewPostCount = 0;
    this.lastCandidateCount = 0;
    this.log(this.config.testMode
      ? '🧭 개념글순회 시작! (테스트 모드)'
      : '🧭 개념글순회 시작! (실행 모드)');
    this.log(
      `⏱️ 확인 주기 ${formatDuration(this.getPollIntervalMs())} / 페이지 사이 대기 ${formatDuration(this.getPageRequestDelayMs())} / 해제 사이 대기 ${formatDuration(this.getReleaseRequestDelayMs())}`,
    );
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('⚠️ 이미 개념글순회가 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.currentPage = 0;
    this.currentPostNo = 0;
    this.log('🔴 개념글순회 중지.');
    await this.saveState();
  }

  async run() {
    while (this.isRunning) {
      const cycleStartedAt = Date.now();

      try {
        if (this.blockedUntilTs > cycleStartedAt) {
          const cooldownRemainingMs = this.blockedUntilTs - cycleStartedAt;
          this.log(`🧊 접근 차단 쿨다운 중 - ${formatDuration(cooldownRemainingMs)} 후 재개`);
          await this.saveState();
          await delayWhileRunning(this, cooldownRemainingMs);
          continue;
        }

        await this.runCycle(cycleStartedAt);
        this.cycleCount += 1;
        await this.saveState();

        if (this.isRunning) {
          await delayWhileRunning(this, this.getPollIntervalMs());
        }
      } catch (error) {
        this.currentPage = 0;
        this.currentPostNo = 0;

        if (isConceptBlockSignalMessage(error?.message)) {
          this.blockedUntilTs = Date.now() + BLOCK_COOLDOWN_MS;
          this.log(`🧊 차단 의심 응답 감지 - ${error.message}. ${formatDuration(BLOCK_COOLDOWN_MS)} 쿨다운`);
          console.error('[ConceptPatrolScheduler] block cooldown:', error);
          await this.saveState();
          if (this.isRunning) {
            await delayWhileRunning(this, BLOCK_COOLDOWN_MS);
          }
          continue;
        }

        this.log(`❌ 개념글순회 오류 - ${error.message}`);
        console.error('[ConceptPatrolScheduler] run error:', error);
        await this.saveState();

        if (this.isRunning) {
          await delayWhileRunning(this, 10000);
        }
      }
    }

    this.currentPage = 0;
    this.currentPostNo = 0;
    await this.saveState();
  }

  async runCycle(cycleStartedAt = Date.now()) {
    this.lastPollAt = new Date(cycleStartedAt).toISOString();
    this.currentPage = 0;
    this.currentPostNo = 0;
    this.lastNewPostCount = 0;
    this.lastCandidateCount = 0;

    const windowResult = await this.fetchWindowSnapshot();
    this.lastDetectedMaxPage = Math.max(0, Number(windowResult.detectedMaxPage) || 0);

    if (!windowResult.complete) {
      return;
    }

    const currentEntries = Array.isArray(windowResult.entries) ? windowResult.entries : [];
    this.lastWindowSize = currentEntries.length;

    if (currentEntries.length <= 0) {
      this.log('⚠️ 개념글순회 window에서 실제 게시물 row를 찾지 못했습니다.');
      return;
    }

    this.log(`🗂️ 개념글 window snapshot ${currentEntries.length}개 확보 (1~${windowResult.targetPageCount}페이지)`);

    const baselineVersionKey = buildBaselineVersionKey(this.config);
    const { newEntries, removedPostNos } = diffConceptPatrolWindow(this.previousWindowPostNos, currentEntries);
    this.lastNewPostCount = newEntries.length;

    if (!this.baselineReady || this.baselineVersionKey !== baselineVersionKey) {
      this.commitBaseline(currentEntries, baselineVersionKey);
      this.log('🧱 초기 baseline 저장 완료 - 이번 cycle은 신규 검사 없음');
      return;
    }

    if (removedPostNos.length > 0) {
      this.log(`📤 window 이탈 ${removedPostNos.length}건 감지`);
    }

    const overlapSkipSet = buildConceptMonitorOverlapSkipSet(
      this.getLiveConceptMonitorStatus(),
      currentEntries,
      Date.now(),
    );
    const inspectEntries = newEntries.filter((entry) => !overlapSkipSet.has(entry.no));
    const skippedOverlapCount = newEntries.length - inspectEntries.length;

    if (skippedOverlapCount > 0) {
      this.log(`↪️ page 1 최신 ${skippedOverlapCount}건은 개념글 방어 빠른 lane 우선`);
    }

    if (inspectEntries.length === 0) {
      this.commitBaseline(currentEntries, baselineVersionKey);
      this.log('ℹ️ 이번 cycle 신규 inspect 대상 없음');
      return;
    }

    let cycleCandidateCount = 0;
    let cycleReleasedCount = 0;
    let cycleFailedCount = 0;
    let cycleUnclearCount = 0;
    let patrolHoldTriggered = false;

    for (let index = 0; index < inspectEntries.length; index += 1) {
      const entry = inspectEntries[index];
      if (!this.isRunning) {
        this.currentPage = 0;
        this.currentPostNo = 0;
        return;
      }

      this.currentPage = entry.sourcePage;
      this.currentPostNo = Number(entry.no) || 0;
      this.log(`📥 개념글 신규 진입 감지 #${entry.no} (${entry.sourcePage}페이지)`);

      const result = await this.inspectConceptPostCandidate({
        config: this.config,
        post: entry,
        progressLabel: formatProgressLabel(index + 1, inspectEntries.length),
        log: (message) => this.log(message),
        delayFn: this.delayFn,
        fetchConceptPostViewHTMLFn: (config, postNo) => this.fetchConceptPostViewHTML(config, postNo, 'conceptPatrol'),
      });

      cycleCandidateCount += result.candidateCount;
      cycleFailedCount += result.failedCount;
      const defendingThreshold = Math.max(
        1,
        Number(this.config.patrolDefendingCandidateThreshold) || DEFAULT_PATROL_DEFENDING_CANDIDATE_THRESHOLD,
      );

      if (!patrolHoldTriggered && cycleCandidateCount >= defendingThreshold) {
        const coordinatorStatus = await this.triggerConceptPatrolRecommendCutHold(this.config, {
          holdMs: this.config.patrolDefendingHoldMs,
        });
        patrolHoldTriggered = true;
        this.log(
          `🛡️ patrol 조작 ${cycleCandidateCount}건 감지 - 개념컷 ${coordinatorStatus.effectiveRecommendCut} 유지 요청 (${formatTimestamp(coordinatorStatus.patrolHoldUntilTs)}까지)`,
        );
      }

      if (result.isCandidate) {
        const releaseResult = await this.releaseInspectedConceptCandidate({
          config: this.config,
          postNo: entry.no,
          log: (message) => this.log(message),
          delayFn: this.delayFn,
          fetchConceptPostViewHTMLFn: (config, postNo) => this.fetchConceptPostViewHTML(config, postNo, 'conceptPatrol'),
          releaseConceptPostFn: (config, postNo) => this.releaseConceptPost(config, postNo, 'conceptPatrol'),
        });

        cycleReleasedCount += releaseResult.releasedCount;
        cycleFailedCount += releaseResult.failedCount;
        cycleUnclearCount += releaseResult.unclearCount;
      }

      if (!this.isRunning) {
        this.currentPage = 0;
        this.currentPostNo = 0;
        return;
      }

      if (index < inspectEntries.length - 1) {
        await delayWhileRunning(this, this.getReleaseRequestDelayMs());
      }
    }

    if (!this.isRunning) {
      this.currentPage = 0;
      this.currentPostNo = 0;
      return;
    }

    this.lastCandidateCount = cycleCandidateCount;

    this.totalDetectedCount += cycleCandidateCount;
    this.totalReleasedCount += cycleReleasedCount;
    this.totalFailedCount += cycleFailedCount;
    this.totalUnclearCount += cycleUnclearCount;

    this.commitBaseline(currentEntries, baselineVersionKey);
    this.currentPage = 0;
    this.currentPostNo = 0;
  }

  async fetchWindowSnapshot() {
    this.currentPage = 1;
    let firstPageHtml = '';
    try {
      firstPageHtml = await this.fetchConceptListPageHTML(this.config, 1, 'conceptPatrol');
    } catch (error) {
      if (isConceptBlockSignalMessage(error?.message)) {
        throw error;
      }
      this.log(`⚠️ 개념글순회 1페이지 로딩 실패 - ${error.message}`);
      return {
        complete: false,
        detectedMaxPage: 0,
        targetPageCount: 0,
        entries: [],
      };
    }

    const pageInfo = this.parseConceptListDetectedMaxPage(firstPageHtml, 1);
    const detectedMaxPage = Math.max(1, Number(pageInfo.detectedMaxPage) || 1);
    const targetPageCount = Math.max(1, Math.min(normalizePatrolPages(this.config.patrolPages), detectedMaxPage));
    const entries = [];
    const seenPostNos = new Set();

    this.collectWindowPageEntries(entries, seenPostNos, firstPageHtml, 1);

    for (let page = 2; page <= targetPageCount; page += 1) {
      const requestDelayMs = this.getPageRequestDelayMs();
      if (requestDelayMs > 0) {
        await delayWhileRunning(this, requestDelayMs);
      }

      this.currentPage = page;
      let pageHtml = '';
      try {
        pageHtml = await this.fetchConceptListPageHTML(this.config, page, 'conceptPatrol');
      } catch (error) {
        if (isConceptBlockSignalMessage(error?.message)) {
          throw error;
        }
        this.log(`⚠️ 개념글순회 ${page}페이지 로딩 실패 - 이번 cycle baseline 미갱신`);
        return {
          complete: false,
          detectedMaxPage,
          targetPageCount,
          entries: [],
        };
      }

      this.collectWindowPageEntries(entries, seenPostNos, pageHtml, page);
    }

    return {
      complete: true,
      detectedMaxPage,
      targetPageCount,
      entries,
    };
  }

  collectWindowPageEntries(targetEntries, seenPostNos, html, page) {
    const posts = this.parseConceptListPagePosts(html);
    for (const post of posts) {
      const postNo = String(post?.no || '').trim();
      if (!postNo || seenPostNos.has(postNo)) {
        continue;
      }

      seenPostNos.add(postNo);
      targetEntries.push({
        no: postNo,
        currentHead: post?.currentHead || '',
        subject: post?.subject || '',
        sourcePage: page,
      });
    }
  }

  commitBaseline(entries, versionKey) {
    const nowIso = new Date().toISOString();
    const nextMeta = {};
    const previousMeta = this.previousWindowMeta || {};

    for (const entry of Array.isArray(entries) ? entries : []) {
      const postNo = String(entry?.no || '').trim();
      if (!postNo) {
        continue;
      }

      const existingMeta = previousMeta[postNo];
      nextMeta[postNo] = {
        page: Math.max(1, Number(entry?.sourcePage) || 1),
        subject: String(entry?.subject || ''),
        currentHead: String(entry?.currentHead || ''),
        firstSeenAt: existingMeta?.firstSeenAt || nowIso,
      };
    }

    this.previousWindowPostNos = Array.isArray(entries)
      ? entries
        .map((entry) => String(entry?.no || '').trim())
        .filter(Boolean)
      : [];
    this.previousWindowMeta = nextMeta;
    this.baselineReady = true;
    this.baselineVersionKey = String(versionKey || '');
  }

  getLiveConceptMonitorStatus() {
    if (!this.conceptMonitorScheduler) {
      return null;
    }

    return {
      isRunning: Boolean(this.conceptMonitorScheduler.isRunning),
      blockedUntilTs: Math.max(0, Number(this.conceptMonitorScheduler.blockedUntilTs) || 0),
      config: {
        snapshotPostLimit: this.conceptMonitorScheduler.config?.snapshotPostLimit,
      },
    };
  }

  getPollIntervalMs() {
    return Math.max(1000, Number(this.config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  }

  getPageRequestDelayMs() {
    return Math.max(0, Number(this.config.pageRequestDelayMs) || 0);
  }

  getReleaseRequestDelayMs() {
    return DEFAULT_RELEASE_REQUEST_DELAY_MS;
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[ConceptPatrolScheduler] ${message}`);
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
          currentPostNo: this.currentPostNo,
          cycleCount: this.cycleCount,
          lastPollAt: this.lastPollAt,
          lastDetectedMaxPage: this.lastDetectedMaxPage,
          lastWindowSize: this.lastWindowSize,
          lastNewPostCount: this.lastNewPostCount,
          lastCandidateCount: this.lastCandidateCount,
          totalDetectedCount: this.totalDetectedCount,
          totalReleasedCount: this.totalReleasedCount,
          totalFailedCount: this.totalFailedCount,
          totalUnclearCount: this.totalUnclearCount,
          baselineReady: this.baselineReady,
          previousWindowPostNos: this.previousWindowPostNos,
          previousWindowMeta: this.previousWindowMeta,
          baselineVersionKey: this.baselineVersionKey,
          blockedUntilTs: this.blockedUntilTs,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[ConceptPatrolScheduler] 상태 저장 실패:', error.message);
    }
  }

  async loadState() {
    try {
      const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
      if (!schedulerState) {
        return;
      }

      this.isRunning = Boolean(schedulerState.isRunning);
      this.currentPage = Math.max(0, Number(schedulerState.currentPage) || 0);
      this.currentPostNo = Math.max(0, Number(schedulerState.currentPostNo) || 0);
      this.cycleCount = Math.max(0, Number(schedulerState.cycleCount) || 0);
      this.lastPollAt = schedulerState.lastPollAt || '';
      this.lastDetectedMaxPage = Math.max(0, Number(schedulerState.lastDetectedMaxPage) || 0);
      this.lastWindowSize = Math.max(0, Number(schedulerState.lastWindowSize) || 0);
      this.lastNewPostCount = Math.max(0, Number(schedulerState.lastNewPostCount) || 0);
      this.lastCandidateCount = Math.max(0, Number(schedulerState.lastCandidateCount) || 0);
      this.totalDetectedCount = Math.max(0, Number(schedulerState.totalDetectedCount) || 0);
      this.totalReleasedCount = Math.max(0, Number(schedulerState.totalReleasedCount) || 0);
      this.totalFailedCount = Math.max(0, Number(schedulerState.totalFailedCount) || 0);
      this.totalUnclearCount = Math.max(0, Number(schedulerState.totalUnclearCount) || 0);
      this.baselineReady = Boolean(schedulerState.baselineReady);
      this.previousWindowPostNos = normalizePostNoArray(schedulerState.previousWindowPostNos);
      this.previousWindowMeta = normalizeWindowMeta(schedulerState.previousWindowMeta);
      this.baselineVersionKey = String(schedulerState.baselineVersionKey || '');
      this.blockedUntilTs = Math.max(0, Number(schedulerState.blockedUntilTs) || 0);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...(schedulerState.config || {}),
      });
    } catch (error) {
      console.error('[ConceptPatrolScheduler] 상태 복원 실패:', error.message);
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
      this.log('🔁 저장된 개념글순회 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    const coordinatorStatus = getConceptRecommendCutCoordinatorStatus();
    return {
      isRunning: this.isRunning,
      currentPage: this.currentPage,
      currentPostNo: this.currentPostNo,
      cycleCount: this.cycleCount,
      lastPollAt: this.lastPollAt,
      lastDetectedMaxPage: this.lastDetectedMaxPage,
      lastWindowSize: this.lastWindowSize,
      lastNewPostCount: this.lastNewPostCount,
      lastCandidateCount: this.lastCandidateCount,
      totalDetectedCount: this.totalDetectedCount,
      totalReleasedCount: this.totalReleasedCount,
      totalFailedCount: this.totalFailedCount,
      totalUnclearCount: this.totalUnclearCount,
      baselineReady: this.baselineReady,
      baselineVersionKey: this.baselineVersionKey,
      blockedUntilTs: this.blockedUntilTs,
      previousWindowSize: this.previousWindowPostNos.length,
      previousWindowMeta: this.previousWindowMeta,
      patrolHoldUntilTs: coordinatorStatus.patrolHoldUntilTs,
      patrolHoldActive: coordinatorStatus.patrolHoldActive,
      effectiveRecommendCut: coordinatorStatus.effectiveRecommendCut,
      lastAppliedRecommendCut: coordinatorStatus.lastAppliedRecommendCut,
      lastRecommendCutApplySucceeded: coordinatorStatus.lastRecommendCutApplySucceeded,
      lastCutChangedAt: coordinatorStatus.lastCutChangedAt,
      logs: this.logs.slice(0, 20),
      config: this.config,
      sharedRecommendCutStatus: coordinatorStatus,
    };
  }
}

function normalizeConfig(config = {}) {
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    pollIntervalMs: Math.max(1000, Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS),
    patrolPages: normalizePatrolPages(config.patrolPages),
    pageRequestDelayMs: Math.max(0, Number(config.pageRequestDelayMs) || DEFAULT_PAGE_REQUEST_DELAY_MS),
    fluidRatioThresholdPercent: clampPercent(config.fluidRatioThresholdPercent, DEFAULT_FLUID_RATIO_THRESHOLD_PERCENT),
    patrolDefendingCandidateThreshold: Math.max(1, Number(config.patrolDefendingCandidateThreshold) || DEFAULT_PATROL_DEFENDING_CANDIDATE_THRESHOLD),
    patrolDefendingHoldMs: Math.max(1000, Number(config.patrolDefendingHoldMs) || DEFAULT_PATROL_DEFENDING_HOLD_MS),
    testMode: config.testMode === true,
  };
}

function normalizePatrolPages(value) {
  return Math.max(1, Number(value) || DEFAULT_PATROL_PAGES);
}

function clampPercent(value, fallback) {
  const normalized = Number(value);
  const thresholdPercent = Number.isFinite(normalized) ? normalized : fallback;
  return Math.max(0, Math.min(100, thresholdPercent));
}

function buildBaselineVersionKey(config = {}) {
  const galleryId = String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId;
  return `${galleryId}:${normalizePatrolPages(config.patrolPages)}`;
}

function diffConceptPatrolWindow(previousWindowPostNos = [], currentEntries = []) {
  const previousSet = new Set(normalizePostNoArray(previousWindowPostNos));
  const currentPostNos = [];
  const currentSet = new Set();
  const newEntries = [];

  for (const entry of Array.isArray(currentEntries) ? currentEntries : []) {
    const postNo = String(entry?.no || '').trim();
    if (!postNo || currentSet.has(postNo)) {
      continue;
    }

    currentSet.add(postNo);
    currentPostNos.push(postNo);
    if (!previousSet.has(postNo)) {
      newEntries.push(entry);
    }
  }

  const removedPostNos = normalizePostNoArray(previousWindowPostNos)
    .filter((postNo) => !currentSet.has(postNo));

  return {
    currentPostNos,
    newEntries,
    removedPostNos,
  };
}

function buildConceptMonitorOverlapSkipSet(conceptMonitorStatus, currentEntries, nowTs = Date.now()) {
  if (!conceptMonitorStatus?.isRunning) {
    return new Set();
  }

  const blockedUntilTs = Math.max(0, Number(conceptMonitorStatus.blockedUntilTs) || 0);
  if (blockedUntilTs > nowTs) {
    return new Set();
  }

  const snapshotPostLimit = Math.max(
    1,
    Number(conceptMonitorStatus.config?.snapshotPostLimit) || DEFAULT_SNAPSHOT_POST_LIMIT,
  );
  const pageOneEntries = Array.isArray(currentEntries)
    ? currentEntries.filter((entry) => Math.max(1, Number(entry?.sourcePage) || 1) === 1)
    : [];

  return new Set(
    pageOneEntries
      .slice(0, snapshotPostLimit)
      .map((entry) => String(entry?.no || '').trim())
      .filter(Boolean),
  );
}

function normalizePostNoArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function normalizeWindowMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return {};
  }

  const nextMeta = {};
  Object.entries(meta).forEach(([postNo, value]) => {
    const normalizedPostNo = String(postNo || '').trim();
    if (!normalizedPostNo || !value || typeof value !== 'object') {
      return;
    }

    nextMeta[normalizedPostNo] = {
      page: Math.max(1, Number(value.page) || 1),
      subject: String(value.subject || ''),
      currentHead: String(value.currentHead || ''),
      firstSeenAt: String(value.firstSeenAt || ''),
    };
  });
  return nextMeta;
}

function formatDuration(durationMs) {
  const normalizedMs = Math.max(0, Number(durationMs) || 0);
  const totalSeconds = Math.ceil(normalizedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds}초`;
  }

  if (seconds === 0) {
    return `${minutes}분`;
  }

  return `${minutes}분 ${seconds}초`;
}

function formatProgressLabel(position, totalPosts) {
  const normalizedPosition = Math.max(0, Number(position) || 0);
  const normalizedTotal = Math.max(0, Number(totalPosts) || 0);
  if (normalizedPosition <= 0 || normalizedTotal <= 0) {
    return '검사';
  }

  return `순회 검사 ${normalizedPosition}/${normalizedTotal}`;
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return '-';
  }

  return new Date(timestamp).toLocaleString('ko-KR', { hour12: false });
}

async function delayWhileRunning(scheduler, waitMs) {
  const normalizedWaitMs = Math.max(0, Number(waitMs) || 0);
  if (!scheduler?.isRunning || normalizedWaitMs <= 0) {
    return;
  }

  const startedAt = Date.now();
  while (scheduler.isRunning) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = normalizedWaitMs - elapsedMs;
    if (remainingMs <= 0) {
      return;
    }

    await delay(Math.min(remainingMs, 250));
  }
}

export {
  Scheduler,
  buildBaselineVersionKey,
  buildConceptMonitorOverlapSkipSet,
  diffConceptPatrolWindow,
  normalizeConfig,
  normalizePatrolPages,
};
