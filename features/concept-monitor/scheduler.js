import {
  DEFAULT_CONFIG,
  delay,
  fetchBoardListHTML,
  fetchConceptListHTML,
} from './api.js';
import {
  parseBoardRecommendSnapshot,
  parseConceptListPosts,
} from './parser.js';
import {
  AUTO_CUT_STATE,
  NORMAL_RECOMMEND_CUT,
  getConceptRecommendCutCoordinatorStatus,
  syncConceptMonitorRecommendCutState,
} from './recommend-cut-coordinator.js';
import {
  BLOCK_COOLDOWN_MS,
  inspectAndMaybeReleaseConceptPost,
  isConceptBlockSignalMessage,
} from './release-helper.js';

const STORAGE_KEY = 'conceptMonitorSchedulerState';
const DEFAULT_SNAPSHOT_POST_LIMIT = 5;
const DEFAULT_AUTO_CUT_POLL_INTERVAL_MS = 30000;
const DEFAULT_AUTO_CUT_ATTACK_RECOMMEND_THRESHOLD = 200;
const DEFAULT_AUTO_CUT_ATTACK_CONSECUTIVE_COUNT = 1;
const DEFAULT_AUTO_CUT_RELEASE_RECOMMEND_THRESHOLD = 40;
const DEFAULT_AUTO_CUT_RELEASE_CONSECUTIVE_COUNT = 2;
const TARGET_INSPECT_DELAY_MS = 5000;
const INSPECT_DELAY_JITTER_MS = 500;

class Scheduler {
  constructor() {
    this.isRunning = false;
    this.runPromise = null;
    this.currentPostNo = 0;
    this.lastPollAt = '';
    this.lastConceptPollAt = '';
    this.cycleCount = 0;
    this.lastScanCount = 0;
    this.lastCandidateCount = 0;
    this.totalDetectedCount = 0;
    this.totalReleasedCount = 0;
    this.totalFailedCount = 0;
    this.totalUnclearCount = 0;
    this.autoCutState = AUTO_CUT_STATE.NORMAL;
    this.autoCutAttackHitCount = 0;
    this.autoCutReleaseHitCount = 0;
    this.lastRecommendDelta = 0;
    this.lastComparedPostCount = 0;
    this.lastCutChangedAt = '';
    this.lastAutoCutPollAt = '';
    this.lastRecommendSnapshot = [];
    this.lastAppliedRecommendCut = NORMAL_RECOMMEND_CUT;
    this.lastRecommendCutApplySucceeded = true;
    this.blockedUntilTs = 0;
    this.logs = [];

    this.config = {
      galleryId: DEFAULT_CONFIG.galleryId,
      pollIntervalMs: 30000,
      snapshotPostLimit: DEFAULT_SNAPSHOT_POST_LIMIT,
      fluidRatioThresholdPercent: 90,
      testMode: true,
      autoCutEnabled: false,
      autoCutPollIntervalMs: DEFAULT_AUTO_CUT_POLL_INTERVAL_MS,
      autoCutAttackRecommendThreshold: DEFAULT_AUTO_CUT_ATTACK_RECOMMEND_THRESHOLD,
      autoCutAttackConsecutiveCount: DEFAULT_AUTO_CUT_ATTACK_CONSECUTIVE_COUNT,
      autoCutReleaseRecommendThreshold: DEFAULT_AUTO_CUT_RELEASE_RECOMMEND_THRESHOLD,
      autoCutReleaseConsecutiveCount: DEFAULT_AUTO_CUT_RELEASE_CONSECUTIVE_COUNT,
    };
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 개념글 방어가 실행 중입니다.');
      return;
    }

    if (this.config.autoCutEnabled) {
      this.resetAutoCutState('ℹ️ 개념컷 자동조절 활성화 - NORMAL 기준으로 감시를 시작합니다.');
    }

    this.isRunning = true;
    this.currentPostNo = 0;
    this.log(this.config.testMode
      ? '🟢 개념글 방어 시작! (테스트 모드)'
      : '🟢 개념글 방어 시작! (실행 모드)');
    await this.syncRecommendCutCoordinator();
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('⚠️ 이미 개념글 방어가 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.currentPostNo = 0;
    this.log('🔴 개념글 방어 중지.');
    await this.syncRecommendCutCoordinator();
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

        await this.pollOnce(cycleStartedAt);
        if (this.isRunning) {
          const elapsedMs = Date.now() - cycleStartedAt;
          const waitMs = Math.max(0, this.getLoopIntervalMs() - elapsedMs);
          await delayWhileRunning(this, waitMs);
        }
      } catch (error) {
        this.currentPostNo = 0;

        if (isConceptBlockSignalMessage(error.message)) {
          this.blockedUntilTs = Date.now() + BLOCK_COOLDOWN_MS;
          this.log(`🧊 차단 의심 응답 감지 - ${error.message}. ${formatDuration(BLOCK_COOLDOWN_MS)} 쿨다운`);
          console.error('[ConceptMonitorScheduler] block cooldown:', error);
          await this.saveState();
          if (this.isRunning) {
            await delayWhileRunning(this, BLOCK_COOLDOWN_MS);
          }
          continue;
        }

        this.log(`❌ 개념글 방어 오류 - ${error.message}`);
        console.error('[ConceptMonitorScheduler] run error:', error);
        await this.saveState();

        if (this.isRunning) {
          await delayWhileRunning(this, 10000);
        }
      }
    }

    await this.saveState();
  }

  async pollOnce(cycleStartedAt = Date.now()) {
    this.lastPollAt = new Date(cycleStartedAt).toISOString();
    this.currentPostNo = 0;
    await this.runAutoCutCycleIfDue(cycleStartedAt);
    await this.runConceptReleaseCycleIfDue(cycleStartedAt);

    this.currentPostNo = 0;
    this.cycleCount += 1;
    await this.saveState();
  }

  async runConceptReleaseCycleIfDue(cycleStartedAt) {
    const lastConceptPollAtTs = parseTimestamp(this.lastConceptPollAt);
    if (lastConceptPollAtTs > 0 && cycleStartedAt - lastConceptPollAtTs < this.getConceptReleasePollIntervalMs()) {
      return;
    }

    this.lastConceptPollAt = new Date(cycleStartedAt).toISOString();
    this.lastScanCount = 0;
    this.lastCandidateCount = 0;

    const listHtml = await fetchConceptListHTML(this.config);
    const snapshotLimit = Math.max(1, Number(this.config.snapshotPostLimit) || DEFAULT_SNAPSHOT_POST_LIMIT);
    const snapshotPosts = parseConceptListPosts(listHtml, snapshotLimit);
    this.lastScanCount = snapshotPosts.length;

    if (snapshotPosts.length === 0) {
      this.log('⚠️ 개념글 목록에서 실제 게시물 row를 찾지 못했습니다.');
      return;
    }

    this.log(`📄 개념글 snapshot ${snapshotPosts.length}개 확보 (${this.config.testMode ? '테스트' : '실행'} 모드)`);

    for (let index = 0; index < snapshotPosts.length; index += 1) {
      const post = snapshotPosts[index];
      if (!this.isRunning) {
        break;
      }

      this.currentPostNo = Number(post.no) || 0;
      await this.inspectPost(post, index + 1, snapshotPosts.length);

      if (!this.isRunning || index >= snapshotPosts.length - 1) {
        continue;
      }

      const interPostDelayMs = computeInterPostDelay(index, snapshotPosts.length);
      if (interPostDelayMs > 0) {
        await delayWhileRunning(this, interPostDelayMs);
      }
    }
  }

  async runAutoCutCycleIfDue(cycleStartedAt) {
    if (!this.config.autoCutEnabled) {
      return;
    }

    const lastAutoCutPollAtTs = parseTimestamp(this.lastAutoCutPollAt);
    if (lastAutoCutPollAtTs > 0 && cycleStartedAt - lastAutoCutPollAtTs < this.getAutoCutPollIntervalMs()) {
      return;
    }

    this.lastAutoCutPollAt = new Date(cycleStartedAt).toISOString();

    const listHtml = await fetchBoardListHTML(this.config);
    const snapshotPosts = parseBoardRecommendSnapshot(listHtml);
    const metrics = computeRecommendDeltaMetrics(this.lastRecommendSnapshot, snapshotPosts);
    this.lastRecommendDelta = metrics.totalIncrease;
    this.lastComparedPostCount = metrics.comparedPostCount;

    if (metrics.comparedPostCount <= 0) {
      this.lastRecommendSnapshot = snapshotPosts;
      this.autoCutAttackHitCount = 0;
      this.autoCutReleaseHitCount = 0;
      this.log(`ℹ️ 개념컷 자동조절 비교 가능한 게시물 없음 - snapshot ${snapshotPosts.length}개 갱신`);
      await this.syncRecommendCutCoordinator();
      return;
    }

    const previousState = this.autoCutState;
    const nextState = this.evaluateAutoCutState(metrics.totalIncrease);
    this.autoCutState = nextState;
    this.lastRecommendSnapshot = snapshotPosts;
    this.logAutoCutCycle(metrics, previousState, nextState);
    await this.syncRecommendCutCoordinator();
  }

  async inspectPost(post, position = 0, totalPosts = 0) {
    const postNo = String(post?.no || '').trim();
    if (!postNo) {
      return;
    }

    const progressLabel = formatProgressLabel(position, totalPosts);
    const inspectionResult = await inspectAndMaybeReleaseConceptPost({
      config: this.config,
      post,
      progressLabel,
      log: (message) => this.log(message),
      delayFn: delay,
    });

    this.lastCandidateCount += inspectionResult.candidateCount;
    this.totalDetectedCount += inspectionResult.candidateCount;
    this.totalReleasedCount += inspectionResult.releasedCount;
    this.totalFailedCount += inspectionResult.failedCount;
    this.totalUnclearCount += inspectionResult.unclearCount;
  }

  evaluateAutoCutState(totalIncrease) {
    const attackThreshold = Math.max(0, Number(this.config.autoCutAttackRecommendThreshold) || DEFAULT_AUTO_CUT_ATTACK_RECOMMEND_THRESHOLD);
    const releaseThreshold = Math.max(0, Number(this.config.autoCutReleaseRecommendThreshold) || DEFAULT_AUTO_CUT_RELEASE_RECOMMEND_THRESHOLD);
    const attackConsecutiveCount = Math.max(1, Number(this.config.autoCutAttackConsecutiveCount) || DEFAULT_AUTO_CUT_ATTACK_CONSECUTIVE_COUNT);
    const releaseConsecutiveCount = Math.max(1, Number(this.config.autoCutReleaseConsecutiveCount) || DEFAULT_AUTO_CUT_RELEASE_CONSECUTIVE_COUNT);

    if (totalIncrease >= attackThreshold) {
      this.autoCutAttackHitCount = Math.min(attackConsecutiveCount, this.autoCutAttackHitCount + 1);
      this.autoCutReleaseHitCount = 0;
      if (this.autoCutAttackHitCount >= attackConsecutiveCount) {
        return AUTO_CUT_STATE.DEFENDING;
      }
      return this.autoCutState;
    }

    if (totalIncrease <= releaseThreshold) {
      this.autoCutReleaseHitCount = Math.min(releaseConsecutiveCount, this.autoCutReleaseHitCount + 1);
      this.autoCutAttackHitCount = 0;
      if (this.autoCutReleaseHitCount >= releaseConsecutiveCount) {
        return AUTO_CUT_STATE.NORMAL;
      }
      return this.autoCutState;
    }

    this.autoCutAttackHitCount = 0;
    this.autoCutReleaseHitCount = 0;
    return this.autoCutState;
  }

  logAutoCutCycle(metrics, previousState, nextState) {
    const attackThreshold = Math.max(0, Number(this.config.autoCutAttackRecommendThreshold) || DEFAULT_AUTO_CUT_ATTACK_RECOMMEND_THRESHOLD);
    const releaseThreshold = Math.max(0, Number(this.config.autoCutReleaseRecommendThreshold) || DEFAULT_AUTO_CUT_RELEASE_RECOMMEND_THRESHOLD);
    const attackConsecutiveCount = Math.max(1, Number(this.config.autoCutAttackConsecutiveCount) || DEFAULT_AUTO_CUT_ATTACK_CONSECUTIVE_COUNT);
    const releaseConsecutiveCount = Math.max(1, Number(this.config.autoCutReleaseConsecutiveCount) || DEFAULT_AUTO_CUT_RELEASE_CONSECUTIVE_COUNT);
    const stateSummary = previousState === nextState
      ? `${nextState} 유지`
      : `${previousState} -> ${nextState}`;

    this.log(
      `📊 개념컷 자동조절 - 증가량 ${metrics.totalIncrease} / 비교 ${metrics.comparedPostCount}개 / 상태 ${stateSummary}`
      + ` / 공격 ${this.autoCutAttackHitCount}/${attackConsecutiveCount}`
      + ` / 복귀 ${this.autoCutReleaseHitCount}/${releaseConsecutiveCount}`
      + ` / 기준 ${attackThreshold}/${releaseThreshold}`,
    );
  }

  async syncRecommendCutCoordinator() {
    try {
      const coordinatorStatus = await syncConceptMonitorRecommendCutState(this.config, {
        isRunning: this.isRunning,
        autoCutEnabled: this.config.autoCutEnabled,
        autoCutState: this.autoCutState,
      });
      this.applyRecommendCutCoordinatorStatus(coordinatorStatus);
    } catch (error) {
      this.lastRecommendCutApplySucceeded = false;
      this.log(`❌ 공용 개념컷 상태 동기화 실패 - ${error.message}`);
    }
  }

  getLoopIntervalMs() {
    const intervals = [this.getConceptReleasePollIntervalMs()];
    if (this.config.autoCutEnabled) {
      intervals.push(this.getAutoCutPollIntervalMs());
    }

    return Math.max(1000, Math.min(...intervals));
  }

  getConceptReleasePollIntervalMs() {
    return Math.max(1000, Number(this.config.pollIntervalMs) || 30000);
  }

  getAutoCutPollIntervalMs() {
    return Math.max(1000, Number(this.config.autoCutPollIntervalMs) || DEFAULT_AUTO_CUT_POLL_INTERVAL_MS);
  }

  resetAutoCutState(message = '') {
    this.autoCutState = AUTO_CUT_STATE.NORMAL;
    this.autoCutAttackHitCount = 0;
    this.autoCutReleaseHitCount = 0;
    this.lastRecommendDelta = 0;
    this.lastComparedPostCount = 0;
    this.lastCutChangedAt = '';
    this.lastAutoCutPollAt = '';
    this.lastRecommendSnapshot = [];
    this.lastAppliedRecommendCut = NORMAL_RECOMMEND_CUT;
    this.lastRecommendCutApplySucceeded = true;

    if (message) {
      this.log(message);
    }
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[ConceptMonitorScheduler] ${message}`);
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
          currentPostNo: this.currentPostNo,
          lastPollAt: this.lastPollAt,
          lastConceptPollAt: this.lastConceptPollAt,
          lastAutoCutPollAt: this.lastAutoCutPollAt,
          cycleCount: this.cycleCount,
          lastScanCount: this.lastScanCount,
          lastCandidateCount: this.lastCandidateCount,
          totalDetectedCount: this.totalDetectedCount,
          totalReleasedCount: this.totalReleasedCount,
          totalFailedCount: this.totalFailedCount,
          totalUnclearCount: this.totalUnclearCount,
          autoCutState: this.autoCutState,
          autoCutAttackHitCount: this.autoCutAttackHitCount,
          autoCutReleaseHitCount: this.autoCutReleaseHitCount,
          lastRecommendDelta: this.lastRecommendDelta,
          lastComparedPostCount: this.lastComparedPostCount,
          lastCutChangedAt: this.lastCutChangedAt,
          lastRecommendSnapshot: this.lastRecommendSnapshot,
          lastAppliedRecommendCut: this.lastAppliedRecommendCut,
          lastRecommendCutApplySucceeded: this.lastRecommendCutApplySucceeded,
          blockedUntilTs: this.blockedUntilTs,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[ConceptMonitorScheduler] 상태 저장 실패:', error.message);
    }
  }

  async loadState() {
    try {
      const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
      if (!schedulerState) {
        return;
      }

      this.isRunning = Boolean(schedulerState.isRunning);
      this.currentPostNo = schedulerState.currentPostNo || 0;
      this.lastPollAt = schedulerState.lastPollAt || '';
      this.lastConceptPollAt = schedulerState.lastConceptPollAt || '';
      this.lastAutoCutPollAt = schedulerState.lastAutoCutPollAt || '';
      this.cycleCount = schedulerState.cycleCount || 0;
      this.lastScanCount = schedulerState.lastScanCount || 0;
      this.lastCandidateCount = schedulerState.lastCandidateCount || 0;
      this.totalDetectedCount = schedulerState.totalDetectedCount || 0;
      this.totalReleasedCount = schedulerState.totalReleasedCount || 0;
      this.totalFailedCount = schedulerState.totalFailedCount || 0;
      this.totalUnclearCount = schedulerState.totalUnclearCount || 0;
      this.autoCutState = normalizeAutoCutState(schedulerState.autoCutState);
      this.autoCutAttackHitCount = Math.max(0, Number(schedulerState.autoCutAttackHitCount) || 0);
      this.autoCutReleaseHitCount = Math.max(0, Number(schedulerState.autoCutReleaseHitCount) || 0);
      this.lastRecommendDelta = Math.max(0, Number(schedulerState.lastRecommendDelta) || 0);
      this.lastComparedPostCount = Math.max(0, Number(schedulerState.lastComparedPostCount) || 0);
      this.lastCutChangedAt = schedulerState.lastCutChangedAt || '';
      this.lastRecommendSnapshot = normalizeRecommendSnapshot(schedulerState.lastRecommendSnapshot);
      this.lastAppliedRecommendCut = normalizeRecommendCut(schedulerState.lastAppliedRecommendCut);
      this.lastRecommendCutApplySucceeded = schedulerState.lastRecommendCutApplySucceeded !== false;
      this.blockedUntilTs = Math.max(0, Number(schedulerState.blockedUntilTs) || 0);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = {
        ...this.config,
        ...(schedulerState.config || {}),
        galleryId: String(schedulerState.config?.galleryId || this.config.galleryId).trim() || DEFAULT_CONFIG.galleryId,
        snapshotPostLimit: Math.max(1, Number(schedulerState.config?.snapshotPostLimit) || this.config.snapshotPostLimit),
        testMode: schedulerState.config?.testMode !== false,
        autoCutEnabled: Boolean(schedulerState.config?.autoCutEnabled),
        autoCutPollIntervalMs: Math.max(1000, Number(schedulerState.config?.autoCutPollIntervalMs) || DEFAULT_AUTO_CUT_POLL_INTERVAL_MS),
        autoCutAttackRecommendThreshold: Math.max(0, Number(schedulerState.config?.autoCutAttackRecommendThreshold) || DEFAULT_AUTO_CUT_ATTACK_RECOMMEND_THRESHOLD),
        autoCutAttackConsecutiveCount: Math.max(1, Number(schedulerState.config?.autoCutAttackConsecutiveCount) || DEFAULT_AUTO_CUT_ATTACK_CONSECUTIVE_COUNT),
        autoCutReleaseRecommendThreshold: Math.max(0, Number(schedulerState.config?.autoCutReleaseRecommendThreshold) || DEFAULT_AUTO_CUT_RELEASE_RECOMMEND_THRESHOLD),
        autoCutReleaseConsecutiveCount: Math.max(1, Number(schedulerState.config?.autoCutReleaseConsecutiveCount) || DEFAULT_AUTO_CUT_RELEASE_CONSECUTIVE_COUNT),
      };
      this.applyRecommendCutCoordinatorStatus(getConceptRecommendCutCoordinatorStatus());
    } catch (error) {
      console.error('[ConceptMonitorScheduler] 상태 복원 실패:', error.message);
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
      this.log('🔁 저장된 개념글 방어 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    const coordinatorStatus = getConceptRecommendCutCoordinatorStatus();
    return {
      isRunning: this.isRunning,
      currentPostNo: this.currentPostNo,
      lastPollAt: this.lastPollAt,
      lastConceptPollAt: this.lastConceptPollAt,
      lastAutoCutPollAt: this.lastAutoCutPollAt,
      cycleCount: this.cycleCount,
      lastScanCount: this.lastScanCount,
      lastCandidateCount: this.lastCandidateCount,
      totalDetectedCount: this.totalDetectedCount,
      totalReleasedCount: this.totalReleasedCount,
      totalFailedCount: this.totalFailedCount,
      totalUnclearCount: this.totalUnclearCount,
      autoCutState: this.autoCutState,
      autoCutAttackHitCount: this.autoCutAttackHitCount,
      autoCutReleaseHitCount: this.autoCutReleaseHitCount,
      lastRecommendDelta: this.lastRecommendDelta,
      lastComparedPostCount: this.lastComparedPostCount,
      lastCutChangedAt: coordinatorStatus.lastCutChangedAt || this.lastCutChangedAt,
      lastAppliedRecommendCut: coordinatorStatus.lastAppliedRecommendCut ?? this.lastAppliedRecommendCut,
      lastRecommendCutApplySucceeded: coordinatorStatus.lastRecommendCutApplySucceeded ?? this.lastRecommendCutApplySucceeded,
      sharedRecommendCutStatus: coordinatorStatus,
      blockedUntilTs: this.blockedUntilTs,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }

  applyRecommendCutCoordinatorStatus(status) {
    if (!status) {
      return;
    }

    this.lastAppliedRecommendCut = status.lastAppliedRecommendCut ?? this.lastAppliedRecommendCut;
    this.lastRecommendCutApplySucceeded = status.lastRecommendCutApplySucceeded !== false;
    this.lastCutChangedAt = status.lastCutChangedAt || '';
  }
}

function computeInterPostDelay(index, totalPosts) {
  const remainingPosts = Math.max(0, totalPosts - index - 1);
  if (remainingPosts <= 0) {
    return 0;
  }

  return Math.max(0, applyJitter(TARGET_INSPECT_DELAY_MS));
}

function applyJitter(baseDelayMs) {
  const jitterMs = Math.max(0, Number(INSPECT_DELAY_JITTER_MS) || 0);
  if (jitterMs <= 0) {
    return baseDelayMs;
  }

  const minDelayMs = Math.max(0, baseDelayMs - jitterMs);
  const maxDelayMs = baseDelayMs + jitterMs;
  return minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
}

function isBlockSignalMessage(message) {
  const normalizedMessage = String(message || '');
  return /접근 차단 응답|HTTP 403|HTTP 429|빈 응답|정상적인 접근이 아닙니다|<empty>/i.test(normalizedMessage);
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

  return `검사 ${normalizedPosition}/${normalizedTotal}`;
}

function normalizeBoardHead(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isGeneralBoardHead(currentHead) {
  return normalizeBoardHead(currentHead) === '일반';
}

function formatBoardHeadLabel(currentHead) {
  const normalized = normalizeBoardHead(currentHead);
  return normalized || '(없음)';
}

function computeRecommendDeltaMetrics(previousSnapshot, currentSnapshot) {
  const previousMap = new Map(
    Array.isArray(previousSnapshot)
      ? previousSnapshot.map((post) => [String(post.no || ''), Math.max(0, Number(post.recommendCount) || 0)])
      : [],
  );

  let totalIncrease = 0;
  let comparedPostCount = 0;

  for (const post of Array.isArray(currentSnapshot) ? currentSnapshot : []) {
    const postNo = String(post?.no || '').trim();
    if (!postNo || !previousMap.has(postNo)) {
      continue;
    }

    comparedPostCount += 1;
    const previousRecommendCount = previousMap.get(postNo);
    const currentRecommendCount = Math.max(0, Number(post?.recommendCount) || 0);
    totalIncrease += Math.max(0, currentRecommendCount - previousRecommendCount);
  }

  return {
    totalIncrease,
    comparedPostCount,
  };
}

function normalizeAutoCutState(value) {
  return value === AUTO_CUT_STATE.DEFENDING ? AUTO_CUT_STATE.DEFENDING : AUTO_CUT_STATE.NORMAL;
}

function normalizeRecommendSnapshot(snapshot) {
  if (!Array.isArray(snapshot)) {
    return [];
  }

  return snapshot
    .map((post) => {
      const postNo = String(post?.no || '').trim();
      const recommendCount = Math.max(0, Number(post?.recommendCount) || 0);
      if (!postNo) {
        return null;
      }
      return {
        no: postNo,
        recommendCount,
      };
    })
    .filter(Boolean);
}

function normalizeRecommendCut(value) {
  return Number(value) === DEFENDING_RECOMMEND_CUT ? DEFENDING_RECOMMEND_CUT : NORMAL_RECOMMEND_CUT;
}

function parseTimestamp(value) {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
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

export { Scheduler };
