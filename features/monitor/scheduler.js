import { fetchPostListHTML, delay } from '../post/api.js';
import { parseBoardPosts } from '../post/parser.js';

const STORAGE_KEY = 'monitorSchedulerState';

const PHASE = {
  SEEDING: 'SEEDING',
  NORMAL: 'NORMAL',
  ATTACKING: 'ATTACKING',
  RECOVERING: 'RECOVERING',
};

class Scheduler {
  constructor({ postScheduler, ipScheduler } = {}) {
    if (!postScheduler || !ipScheduler) {
      throw new Error('MonitorScheduler는 post/ip scheduler 의존성이 필요합니다.');
    }

    this.postScheduler = postScheduler;
    this.ipScheduler = ipScheduler;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.SEEDING;
    this.currentPollPage = 0;
    this.cycleCount = 0;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.lastPollAt = '';
    this.lastMetrics = buildEmptyMetrics();
    this.lastSnapshot = [];
    this.attackSessionId = '';
    this.managedPostStarted = false;
    this.managedIpStarted = false;
    this.managedIpRunId = '';
    this.totalAttackDetected = 0;
    this.totalAttackReleased = 0;
    this.logs = [];

    this.config = {
      galleryId: 'thesingularity',
      monitorPages: 1,
      pollIntervalMs: 30000,
      attackNewPostThreshold: 50,
      attackFluidRatioThreshold: 85,
      attackConsecutiveCount: 2,
      releaseNewPostThreshold: 10,
      releaseFluidRatioThreshold: 40,
      releaseConsecutiveCount: 3,
    };
  }

  getStartBlockReason() {
    if (this.postScheduler.isRunning || this.postScheduler.runPromise) {
      return '감시 자동화를 시작하기 전에 게시글 분류를 먼저 정지하세요.';
    }

    if (this.ipScheduler.isRunning || this.ipScheduler.runPromise || this.ipScheduler.isReleaseRunning) {
      return '감시 자동화를 시작하기 전에 IP 차단을 먼저 정지하세요.';
    }

    return '';
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 자동 감시가 실행 중입니다.');
      return;
    }

    const startBlockReason = this.getStartBlockReason();
    if (startBlockReason) {
      throw new Error(startBlockReason);
    }

    this.isRunning = true;
    this.phase = PHASE.SEEDING;
    this.currentPollPage = 0;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.lastPollAt = '';
    this.lastMetrics = buildEmptyMetrics();
    this.lastSnapshot = [];
    this.attackSessionId = '';
    this.managedPostStarted = false;
    this.managedIpStarted = false;
    this.managedIpRunId = '';
    this.log('🟢 자동 감시 시작!');
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('⚠️ 이미 자동 감시가 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    await this.stopManagedDefenses();
    this.clearAttackSession();
    this.phase = PHASE.SEEDING;
    this.currentPollPage = 0;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.lastPollAt = '';
    this.lastMetrics = buildEmptyMetrics();
    this.lastSnapshot = [];
    this.log('🔴 자동 감시 중지.');
    await this.saveState();
  }

  async run() {
    while (this.isRunning) {
      try {
        const currentSnapshot = await this.pollBoardSnapshot();
        const metrics = this.computeMetrics(currentSnapshot);
        this.lastPollAt = new Date().toISOString();

        if (this.phase === PHASE.RECOVERING) {
          await this.enterRecoveringMode();
          this.lastSnapshot = currentSnapshot;
          this.lastMetrics = metrics;
          this.currentPollPage = 0;
          this.cycleCount += 1;
          await this.saveState();
          await delay(this.config.pollIntervalMs);
          continue;
        }

        if (this.phase === PHASE.SEEDING || this.lastSnapshot.length === 0) {
          this.lastSnapshot = currentSnapshot;
          this.lastMetrics = {
            ...buildEmptyMetrics(),
            snapshotPostCount: metrics.snapshotPostCount,
          };
          this.phase = PHASE.NORMAL;
          this.currentPollPage = 0;
          this.cycleCount += 1;
          this.log(`🌱 기준 스냅샷 저장 완료 (${metrics.snapshotPostCount}개 게시물)`);
          await this.saveState();
          await delay(this.config.pollIntervalMs);
          continue;
        }

        this.log(
          `📡 새 글 ${metrics.newPostCount}개 / 유동 ${metrics.newFluidCount}개 (${formatRatio(metrics.fluidRatio)}%)`,
        );

        if (this.phase === PHASE.NORMAL) {
          await this.evaluateNormalState(metrics);
        } else if (this.phase === PHASE.ATTACKING) {
          await this.ensureManagedDefensesStarted();
          await this.evaluateAttackingState(metrics);
        }

        this.lastSnapshot = currentSnapshot;
        this.lastMetrics = metrics;
        this.currentPollPage = 0;
        this.cycleCount += 1;
        await this.saveState();
        await delay(this.config.pollIntervalMs);
      } catch (error) {
        this.currentPollPage = 0;
        this.log(`❌ 감시 오류 - ${error.message}`);
        console.error('[MonitorScheduler] run error:', error);
        await this.saveState();

        if (this.isRunning) {
          await delay(10000);
        }
      }
    }

    await this.saveState();
  }

  async pollBoardSnapshot() {
    const postMap = new Map();
    const pages = Math.max(1, Number(this.config.monitorPages) || 1);

    for (let page = 1; page <= pages; page += 1) {
      if (!this.isRunning) {
        break;
      }

      this.currentPollPage = page;
      const html = await fetchPostListHTML({ galleryId: this.config.galleryId }, page);
      const posts = parseBoardPosts(html);

      for (const post of posts) {
        const postKey = String(post.no);
        if (!postMap.has(postKey)) {
          postMap.set(postKey, post);
        }
      }
    }

    return [...postMap.values()];
  }

  computeMetrics(currentSnapshot) {
    const previousNos = new Set(this.lastSnapshot.map((post) => String(post.no)));
    const newPosts = currentSnapshot.filter((post) => !previousNos.has(String(post.no)));
    const newFluidCount = newPosts.filter((post) => post.isFluid).length;
    const fluidRatio = newPosts.length > 0
      ? (newFluidCount / newPosts.length) * 100
      : 0;

    return {
      snapshotPostCount: currentSnapshot.length,
      newPostCount: newPosts.length,
      newFluidCount,
      fluidRatio: Number(fluidRatio.toFixed(1)),
      newPosts,
    };
  }

  async evaluateNormalState(metrics) {
    const attackCondition = metrics.newPostCount >= this.config.attackNewPostThreshold
      && metrics.fluidRatio >= this.config.attackFluidRatioThreshold;

    if (attackCondition) {
      this.attackHitCount += 1;
      this.log(`🚨 공격 감지 streak ${this.attackHitCount}/${this.config.attackConsecutiveCount}`);
      if (this.attackHitCount >= this.config.attackConsecutiveCount) {
        await this.enterAttackMode();
      }
      return;
    }

    if (this.attackHitCount > 0) {
      this.log('ℹ️ 공격 감지 streak 초기화');
    }
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
  }

  async evaluateAttackingState(metrics) {
    const releaseCondition = metrics.newPostCount < this.config.releaseNewPostThreshold
      && metrics.fluidRatio < this.config.releaseFluidRatioThreshold;

    if (releaseCondition) {
      this.releaseHitCount += 1;
      this.log(`🧊 종료 감지 streak ${this.releaseHitCount}/${this.config.releaseConsecutiveCount}`);
      if (this.releaseHitCount >= this.config.releaseConsecutiveCount) {
        await this.enterRecoveringMode();
      }
      return;
    }

    if (this.releaseHitCount > 0) {
      this.log('ℹ️ 종료 감지 streak 초기화');
    }
    this.releaseHitCount = 0;
  }

  async enterAttackMode() {
    this.phase = PHASE.ATTACKING;
    this.attackSessionId = `attack_${Date.now()}`;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.totalAttackDetected += 1;
    this.log(`🚨 공격 상태 진입 (${this.attackSessionId})`);
    await this.ensureManagedDefensesStarted();
  }

  async ensureManagedDefensesStarted() {
    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
    }

    if (!this.postScheduler.isRunning) {
      try {
        await this.postScheduler.start();
      } catch (error) {
        this.log(`⚠️ 게시글 분류 자동 시작 실패 - ${error.message}`);
      }
    }

    if (this.postScheduler.isRunning && !this.managedPostStarted) {
      this.managedPostStarted = true;
      this.log('🛡️ 게시글 분류 자동 대응 ON');
    }

    if (!this.ipScheduler.isRunning) {
      try {
        await this.ipScheduler.start();
      } catch (error) {
        this.log(`⚠️ IP 차단 자동 시작 실패 - ${error.message}`);
      }
    }

    if (this.ipScheduler.isRunning) {
      if (!this.managedIpStarted) {
        this.managedIpStarted = true;
        this.log('🛡️ IP 차단 자동 대응 ON');
      }

      const nextRunId = String(this.ipScheduler.currentRunId || '').trim();
      if (nextRunId && this.managedIpRunId !== nextRunId) {
        this.managedIpRunId = nextRunId;
        this.log(`🧷 자동 해제 대상 runId 저장 (${nextRunId})`);
      }
    }
  }

  async enterRecoveringMode() {
    this.phase = PHASE.RECOVERING;
    this.releaseHitCount = 0;
    this.log('🧊 공격 종료 확정. 자동 대응 종료 및 IP 자동 해제 시작');

    await this.stopManagedDefenses();
    const releaseResult = await this.releaseManagedIpBans();

    if (releaseResult.success) {
      this.log(`✅ 자동 해제 완료 - ${releaseResult.message || '성공'}`);
    } else {
      this.log(`⚠️ 자동 해제 경고 - ${releaseResult.message || '실패'}`);
    }

    this.totalAttackReleased += 1;
    this.clearAttackSession();
    this.phase = PHASE.NORMAL;
    this.log('✅ 감시 자동화 NORMAL 상태 복귀');
  }

  async stopManagedDefenses() {
    const shouldStopPost = this.managedPostStarted || (this.phase === PHASE.ATTACKING && (this.postScheduler.isRunning || this.postScheduler.runPromise));
    const shouldStopIp = this.managedIpStarted || (this.phase === PHASE.ATTACKING && (this.ipScheduler.isRunning || this.ipScheduler.runPromise));

    if (shouldStopPost) {
      try {
        if (this.postScheduler.isRunning) {
          await this.postScheduler.stop();
        }
        await waitForSchedulerRunLoop(this.postScheduler, '게시글 분류');
        this.log('🛑 게시글 분류 자동 대응 OFF');
      } catch (error) {
        this.log(`⚠️ 게시글 분류 자동 정지 실패 - ${error.message}`);
      }
    }

    if (shouldStopIp) {
      try {
        if (this.ipScheduler.isRunning) {
          await this.ipScheduler.stop();
        }
        await waitForSchedulerRunLoop(this.ipScheduler, 'IP 차단');
        this.log('🛑 IP 차단 자동 대응 OFF');
      } catch (error) {
        this.log(`⚠️ IP 차단 자동 정지 실패 - ${error.message}`);
      }
    }
  }

  async releaseManagedIpBans() {
    if (!this.managedIpRunId) {
      return {
        success: true,
        releasedCount: 0,
        failedReleaseCount: 0,
        missingCount: 0,
        message: '자동 해제 대상 runId가 없습니다.',
      };
    }

    const result = await this.ipScheduler.releaseTrackedBans({ runId: this.managedIpRunId });
    return {
      success: Boolean(result?.success),
      releasedCount: result?.releasedCount || 0,
      failedReleaseCount: result?.failedReleaseCount || 0,
      missingCount: result?.missingCount || 0,
      message: result?.message || '자동 해제 결과 없음',
    };
  }

  clearAttackSession() {
    this.attackSessionId = '';
    this.managedPostStarted = false;
    this.managedIpStarted = false;
    this.managedIpRunId = '';
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[MonitorScheduler] ${message}`);
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
          phase: this.phase,
          currentPollPage: this.currentPollPage,
          cycleCount: this.cycleCount,
          attackHitCount: this.attackHitCount,
          releaseHitCount: this.releaseHitCount,
          lastPollAt: this.lastPollAt,
          lastMetrics: buildStoredMetrics(this.lastMetrics),
          lastSnapshot: this.lastSnapshot,
          attackSessionId: this.attackSessionId,
          managedPostStarted: this.managedPostStarted,
          managedIpStarted: this.managedIpStarted,
          managedIpRunId: this.managedIpRunId,
          totalAttackDetected: this.totalAttackDetected,
          totalAttackReleased: this.totalAttackReleased,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[MonitorScheduler] 상태 저장 실패:', error.message);
    }
  }

  async loadState() {
    try {
      const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
      if (!schedulerState) {
        return;
      }

      this.isRunning = Boolean(schedulerState.isRunning);
      this.phase = normalizePhase(schedulerState.phase);
      this.currentPollPage = schedulerState.currentPollPage || 0;
      this.cycleCount = schedulerState.cycleCount || 0;
      this.attackHitCount = schedulerState.attackHitCount || 0;
      this.releaseHitCount = schedulerState.releaseHitCount || 0;
      this.lastPollAt = schedulerState.lastPollAt || '';
      this.lastMetrics = {
        ...buildEmptyMetrics(),
        ...(schedulerState.lastMetrics || {}),
      };
      this.lastSnapshot = Array.isArray(schedulerState.lastSnapshot) ? schedulerState.lastSnapshot : [];
      this.attackSessionId = schedulerState.attackSessionId || '';
      this.managedPostStarted = Boolean(schedulerState.managedPostStarted);
      this.managedIpStarted = Boolean(schedulerState.managedIpStarted);
      this.managedIpRunId = schedulerState.managedIpRunId || '';
      this.totalAttackDetected = schedulerState.totalAttackDetected || 0;
      this.totalAttackReleased = schedulerState.totalAttackReleased || 0;
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = {
        ...this.config,
        ...(schedulerState.config || {}),
      };
    } catch (error) {
      console.error('[MonitorScheduler] 상태 복원 실패:', error.message);
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
      this.log('🔁 저장된 자동 감시 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      currentPollPage: this.currentPollPage,
      cycleCount: this.cycleCount,
      attackHitCount: this.attackHitCount,
      releaseHitCount: this.releaseHitCount,
      lastPollAt: this.lastPollAt,
      lastMetrics: buildStoredMetrics(this.lastMetrics),
      attackSessionId: this.attackSessionId,
      managedPostStarted: this.managedPostStarted,
      managedIpStarted: this.managedIpStarted,
      managedIpRunId: this.managedIpRunId,
      totalAttackDetected: this.totalAttackDetected,
      totalAttackReleased: this.totalAttackReleased,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }
}

function buildEmptyMetrics() {
  return {
    snapshotPostCount: 0,
    newPostCount: 0,
    newFluidCount: 0,
    fluidRatio: 0,
    newPosts: [],
  };
}

function buildStoredMetrics(metrics) {
  return {
    snapshotPostCount: metrics?.snapshotPostCount || 0,
    newPostCount: metrics?.newPostCount || 0,
    newFluidCount: metrics?.newFluidCount || 0,
    fluidRatio: metrics?.fluidRatio || 0,
  };
}

function normalizePhase(value) {
  return Object.values(PHASE).includes(value) ? value : PHASE.SEEDING;
}

function formatRatio(value) {
  return Number(value || 0).toFixed(1);
}

async function waitForSchedulerRunLoop(scheduler, label) {
  if (!scheduler?.runPromise) {
    return;
  }

  try {
    await scheduler.runPromise;
  } catch (error) {
    console.error(`[MonitorScheduler] ${label} 종료 대기 실패:`, error);
  }
}

export { PHASE, Scheduler };
