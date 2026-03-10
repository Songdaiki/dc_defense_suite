import {
  DEFAULT_CONFIG,
  delay,
  fetchConceptListHTML,
  fetchConceptPostViewHTML,
  releaseConceptPost,
} from './api.js';
import {
  extractConceptPostMetrics,
  parseConceptListPosts,
} from './parser.js';

const STORAGE_KEY = 'conceptMonitorSchedulerState';
const SNAPSHOT_LIMIT = 20;
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;
const CYCLE_BUFFER_MS = 5000;
const TARGET_INSPECT_DELAY_MS = 5000;
const INSPECT_DELAY_JITTER_MS = 500;

class Scheduler {
  constructor() {
    this.isRunning = false;
    this.runPromise = null;
    this.currentPostNo = 0;
    this.lastPollAt = '';
    this.cycleCount = 0;
    this.lastScanCount = 0;
    this.lastCandidateCount = 0;
    this.totalDetectedCount = 0;
    this.totalReleasedCount = 0;
    this.totalFailedCount = 0;
    this.totalUnclearCount = 0;
    this.blockedUntilTs = 0;
    this.logs = [];

    this.config = {
      galleryId: DEFAULT_CONFIG.galleryId,
      pollIntervalMs: 120000,
      fluidRatioThresholdPercent: 90,
      testMode: true,
    };
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 개념글 방어가 실행 중입니다.');
      return;
    }

    this.isRunning = true;
    this.currentPostNo = 0;
    this.log(this.config.testMode
      ? '🟢 개념글 방어 시작! (테스트 모드)'
      : '🟢 개념글 방어 시작! (실행 모드)');
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
          const waitMs = Math.max(0, Number(this.config.pollIntervalMs) - elapsedMs);
          await delayWhileRunning(this, waitMs);
        }
      } catch (error) {
        this.currentPostNo = 0;

        if (isBlockSignalMessage(error.message)) {
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
    this.lastScanCount = 0;
    this.lastCandidateCount = 0;
    this.currentPostNo = 0;

    const listHtml = await fetchConceptListHTML(this.config);
    const snapshotPosts = parseConceptListPosts(listHtml, SNAPSHOT_LIMIT);
    this.lastScanCount = snapshotPosts.length;

    if (snapshotPosts.length === 0) {
      this.log('⚠️ 개념글 목록에서 실제 게시물 row를 찾지 못했습니다.');
      this.cycleCount += 1;
      await this.saveState();
      return;
    }

    this.log(`📄 개념글 snapshot ${snapshotPosts.length}개 확보 (${this.config.testMode ? '테스트' : '실행'} 모드)`);

    const cycleTargetEndedAt = cycleStartedAt + Math.max(0, Number(this.config.pollIntervalMs) || 0) - CYCLE_BUFFER_MS;

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

      const interPostDelayMs = computeInterPostDelay(index, snapshotPosts.length, cycleTargetEndedAt);
      if (interPostDelayMs > 0) {
        await delayWhileRunning(this, interPostDelayMs);
      }
    }

    this.currentPostNo = 0;
    this.cycleCount += 1;
    await this.saveState();
  }

  async inspectPost(post, position = 0, totalPosts = 0) {
    const postNo = String(post?.no || '').trim();
    if (!postNo) {
      return;
    }

    const progressLabel = formatProgressLabel(position, totalPosts);

    let viewHtml = '';
    try {
      viewHtml = await fetchConceptPostViewHTML(this.config, postNo);
    } catch (error) {
      this.totalFailedCount += 1;
      this.log(`⚠️ #${postNo} view 조회 실패 - ${error.message}`);
      if (isBlockSignalMessage(error.message)) {
        throw error;
      }
      return;
    }

    const metrics = extractConceptPostMetrics(viewHtml, {
      postNoHint: postNo,
      assumeConcept: true,
    });
    if (!metrics.success) {
      this.totalFailedCount += 1;
      this.log(`⚠️ #${postNo} 파싱 실패 - ${metrics.message}${metrics.debugSummary ? ` / debug: ${metrics.debugSummary}` : ''}`);
      return;
    }

    if (!metrics.isConcept) {
      return;
    }

    if (metrics.totalRecommendCount <= 0) {
      return;
    }

    if (metrics.fixedNickRecommendCount > metrics.totalRecommendCount) {
      this.totalFailedCount += 1;
      this.log(`⚠️ #${postNo} 비정상 추천값 - 총추천 ${metrics.totalRecommendCount}, 고정닉 ${metrics.fixedNickRecommendCount}`);
      return;
    }

    const fluidRecommendCount = metrics.totalRecommendCount - metrics.fixedNickRecommendCount;
    const fluidRatio = fluidRecommendCount / metrics.totalRecommendCount;
    const configuredThreshold = Number(this.config.fluidRatioThresholdPercent);
    const thresholdPercent = Number.isFinite(configuredThreshold) ? configuredThreshold : 90;
    const thresholdRatio = Math.max(0, Math.min(100, thresholdPercent)) / 100;

    if (fluidRatio < thresholdRatio) {
      return;
    }

    this.lastCandidateCount += 1;
    this.totalDetectedCount += 1;
    this.log(
      `🎯 ${progressLabel} 개념글 해제 후보 #${postNo} - 총추천 ${metrics.totalRecommendCount}, 고정닉 ${metrics.fixedNickRecommendCount}, 유동비율 ${fluidRatio.toFixed(2)}`,
    );

    if (this.config.testMode) {
      this.log(`🧪 테스트 모드 - 해제 미실행 #${postNo}`);
      return;
    }

    await this.executeRelease(postNo);
  }

  async executeRelease(postNo) {
    this.log(`⚙️ 개념글 해제 실행 #${postNo}`);

    let releaseResult;
    try {
      releaseResult = await releaseConceptPost(this.config, postNo);
    } catch (error) {
      this.totalFailedCount += 1;
      this.log(`❌ 개념글 해제 실패 #${postNo} - ${error.message}`);
      return;
    }

    if (releaseResult.status !== 200) {
      this.totalFailedCount += 1;
      this.log(`❌ 개념글 해제 실패 #${postNo} - HTTP ${releaseResult.status} / raw: ${releaseResult.rawSummary}`);
      return;
    }

    let recheckHtml = '';
    try {
      recheckHtml = await fetchConceptPostViewHTML(this.config, postNo);
    } catch (error) {
      this.totalUnclearCount += 1;
      this.log(`⚠️ 개념글 해제 결과 불명확 #${postNo} - 재확인 실패 (${error.message}) / raw: ${releaseResult.rawSummary}`);
      return;
    }

    const rechecked = extractConceptPostMetrics(recheckHtml, {
      postNoHint: postNo,
    });
    if (!rechecked.success) {
      this.totalUnclearCount += 1;
      this.log(`⚠️ 개념글 해제 결과 불명확 #${postNo} - 재확인 파싱 실패${rechecked.debugSummary ? ` / debug: ${rechecked.debugSummary}` : ''} / raw: ${releaseResult.rawSummary}`);
      return;
    }

    if (!rechecked.isConcept) {
      this.totalReleasedCount += 1;
      this.log(`✅ 개념글 해제 완료 #${postNo}`);
      return;
    }

    this.totalFailedCount += 1;
    this.log(`❌ 개념글 해제 실패 #${postNo} - HTTP 200 / raw: ${releaseResult.rawSummary}`);
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
          cycleCount: this.cycleCount,
          lastScanCount: this.lastScanCount,
          lastCandidateCount: this.lastCandidateCount,
          totalDetectedCount: this.totalDetectedCount,
          totalReleasedCount: this.totalReleasedCount,
          totalFailedCount: this.totalFailedCount,
          totalUnclearCount: this.totalUnclearCount,
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
      this.cycleCount = schedulerState.cycleCount || 0;
      this.lastScanCount = schedulerState.lastScanCount || 0;
      this.lastCandidateCount = schedulerState.lastCandidateCount || 0;
      this.totalDetectedCount = schedulerState.totalDetectedCount || 0;
      this.totalReleasedCount = schedulerState.totalReleasedCount || 0;
      this.totalFailedCount = schedulerState.totalFailedCount || 0;
      this.totalUnclearCount = schedulerState.totalUnclearCount || 0;
      this.blockedUntilTs = Math.max(0, Number(schedulerState.blockedUntilTs) || 0);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = {
        ...this.config,
        ...(schedulerState.config || {}),
        galleryId: String(schedulerState.config?.galleryId || this.config.galleryId).trim() || DEFAULT_CONFIG.galleryId,
        testMode: schedulerState.config?.testMode !== false,
      };
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
    return {
      isRunning: this.isRunning,
      currentPostNo: this.currentPostNo,
      lastPollAt: this.lastPollAt,
      cycleCount: this.cycleCount,
      lastScanCount: this.lastScanCount,
      lastCandidateCount: this.lastCandidateCount,
      totalDetectedCount: this.totalDetectedCount,
      totalReleasedCount: this.totalReleasedCount,
      totalFailedCount: this.totalFailedCount,
      totalUnclearCount: this.totalUnclearCount,
      blockedUntilTs: this.blockedUntilTs,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }
}

function computeInterPostDelay(index, totalPosts, cycleTargetEndedAt) {
  const remainingPosts = Math.max(0, totalPosts - index - 1);
  if (remainingPosts <= 0) {
    return 0;
  }

  const remainingTimeMs = cycleTargetEndedAt - Date.now();
  if (remainingTimeMs <= 0) {
    return 0;
  }

  const desiredDelayMs = applyJitter(TARGET_INSPECT_DELAY_MS);
  const budgetedDelayMs = Math.floor(remainingTimeMs / remainingPosts);
  return Math.max(0, Math.min(desiredDelayMs, budgetedDelayMs));
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
