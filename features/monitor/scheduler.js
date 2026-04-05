import { deletePosts, fetchPostListHTML, delay } from '../post/api.js';
import { parseBoardPosts } from '../post/parser.js';
import {
  ATTACK_MODE,
  ATTACK_MODE_SAMPLE_POST_LIMIT,
  buildAttackModeDecision,
  formatAttackModeLabel,
  getAttackModeFilterLabel,
  isEligibleForAttackMode,
  normalizeAttackMode,
} from '../post/attack-mode.js';
import {
  ensureSemiconductorRefluxTitleSetLoaded,
  hasSemiconductorRefluxTitle,
  isSemiconductorRefluxTitleSetReady,
} from '../post/semiconductor-reflux-title-set.js';

const STORAGE_KEY = 'monitorSchedulerState';

const PHASE = {
  SEEDING: 'SEEDING',
  NORMAL: 'NORMAL',
  ATTACKING: 'ATTACKING',
  RECOVERING: 'RECOVERING',
};

class Scheduler {
  constructor({ postScheduler, ipScheduler, uidWarningAutoBanScheduler } = {}) {
    if (!postScheduler || !ipScheduler) {
      throw new Error('MonitorScheduler는 post/ip scheduler 의존성이 필요합니다.');
    }

    this.postScheduler = postScheduler;
    this.ipScheduler = ipScheduler;
    this.uidWarningAutoBanScheduler = uidWarningAutoBanScheduler || null;

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
    this.attackCutoffPostNo = 0;
    this.attackMode = ATTACK_MODE.DEFAULT;
    this.attackModeReason = '';
    this.attackModeSampleTitles = [];
    this.initialSweepCompleted = false;
    this.pendingInitialSweepPostNos = [];
    this.pendingInitialSweepPosts = [];
    this.pendingManagedIpBanOnlyPosts = [];
    this.managedPostStarted = false;
    this.managedIpStarted = false;
    this.managedIpDeleteEnabled = true;
    this.managedUidWarningAutoBanSuspended = false;
    this.totalAttackDetected = 0;
    this.totalAttackReleased = 0;
    this.logs = [];

    this.config = {
      galleryId: 'thesingularity',
      monitorPages: 2,
      pollIntervalMs: 20000,
      attackNewPostThreshold: 15,
      attackFluidRatioThreshold: 88,
      attackConsecutiveCount: 2,
      releaseNewPostThreshold: 10,
      releaseFluidRatioThreshold: 30,
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

    await ensureSemiconductorRefluxTitleSetLoaded();
    this.isRunning = true;
    this.phase = PHASE.SEEDING;
    this.currentPollPage = 0;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.lastPollAt = '';
    this.lastMetrics = buildEmptyMetrics();
    this.lastSnapshot = [];
    this.attackSessionId = '';
    this.attackCutoffPostNo = 0;
    this.attackMode = ATTACK_MODE.DEFAULT;
    this.attackModeReason = '';
    this.attackModeSampleTitles = [];
    this.initialSweepCompleted = false;
    this.pendingInitialSweepPostNos = [];
    this.pendingInitialSweepPosts = [];
    this.pendingManagedIpBanOnlyPosts = [];
    this.managedPostStarted = false;
    this.managedIpStarted = false;
    this.managedIpDeleteEnabled = true;
    this.managedUidWarningAutoBanSuspended = false;
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

    const shouldResumeUidWarningAutoBan = this.managedUidWarningAutoBanSuspended;
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
    this.attackCutoffPostNo = 0;
    this.attackMode = ATTACK_MODE.DEFAULT;
    this.attackModeReason = '';
    this.attackModeSampleTitles = [];
    this.initialSweepCompleted = false;
    this.pendingInitialSweepPostNos = [];
    this.pendingInitialSweepPosts = [];
    this.pendingManagedIpBanOnlyPosts = [];
    this.log('🔴 자동 감시 중지.');
    await this.resumeUidWarningAutoBanAfterAttack(shouldResumeUidWarningAutoBan);
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
          await this.evaluateNormalState(metrics, currentSnapshot);
        } else if (this.phase === PHASE.ATTACKING) {
          this.maybeWidenAttackMode(metrics);
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
    return this.fetchBoardSnapshotPages(this.config.monitorPages, { trackProgress: true });
  }

  async fetchBoardSnapshotPages(pagesInput, { trackProgress = false } = {}) {
    const postMap = new Map();
    const pages = Math.max(1, Number(pagesInput) || 1);

    for (let page = 1; page <= pages; page += 1) {
      if (!this.isRunning) {
        break;
      }

      if (trackProgress) {
        this.currentPollPage = page;
      }
      const html = await fetchPostListHTML({ galleryId: this.config.galleryId }, page);
      const posts = parseBoardPosts(html).map((post) => ({
        ...post,
        sourcePage: page,
      }));

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

  async evaluateNormalState(metrics, currentSnapshot) {
    const attackCondition = metrics.newPostCount >= this.config.attackNewPostThreshold
      && metrics.fluidRatio >= this.config.attackFluidRatioThreshold;

    if (attackCondition) {
      this.attackHitCount += 1;
      this.log(`🚨 공격 감지 streak ${this.attackHitCount}/${this.config.attackConsecutiveCount}`);
      if (this.attackHitCount >= this.config.attackConsecutiveCount) {
        await this.enterAttackMode(metrics, currentSnapshot);
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

  async enterAttackMode(metrics, currentSnapshot) {
    const attackSnapshot = await this.resolveAttackCutoffSnapshot(currentSnapshot);
    const attackCutoffPostNo = getMaxPostNo(attackSnapshot);
    if (attackCutoffPostNo <= 0) {
      throw new Error('공격 cutoff snapshot 추출에 실패했습니다.');
    }

    const attackModeDecision = this.decideAttackMode(metrics);
    const initialSweepPages = getNormalizedInitialSweepPages(this.config, attackModeDecision.attackMode);
    const initialSweepSnapshot = await this.resolveInitialSweepSnapshot(currentSnapshot, attackModeDecision.attackMode);
    const initialSweepAllFluidPosts = buildAllFluidSnapshotPosts(initialSweepSnapshot);
    const initialSweepTargetPosts = buildInitialSweepPosts(
      initialSweepSnapshot,
      attackModeDecision.attackMode,
      initialSweepPages,
    );

    this.phase = PHASE.ATTACKING;
    this.attackSessionId = `attack_${Date.now()}`;
    this.attackCutoffPostNo = attackCutoffPostNo;
    this.attackMode = attackModeDecision.attackMode;
    this.attackModeReason = attackModeDecision.reason;
    this.attackModeSampleTitles = attackModeDecision.sampleTitles;
    this.initialSweepCompleted = false;
    this.pendingInitialSweepPosts = initialSweepTargetPosts;
    this.pendingInitialSweepPostNos = buildInitialSweepPostNos(this.pendingInitialSweepPosts);
    this.pendingManagedIpBanOnlyPosts = [];
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.totalAttackDetected += 1;
    this.log(`🚨 공격 상태 진입 (${this.attackSessionId})`);
    this.log(`🧷 감시 자동화 cutoff 저장 (#${this.attackCutoffPostNo})`);
    this.log(`🧠 공격 모드 판정: ${formatAttackModeLabel(this.attackMode)} (${this.attackModeReason})`);
    if (this.attackModeSampleTitles.length > 0) {
      this.log(`🧾 공격 샘플 제목: ${formatAttackSampleTitles(this.attackModeSampleTitles)}`);
    }
    if (this.attackMode !== ATTACK_MODE.DEFAULT) {
      this.log(
        `🧹 initial sweep 대상 ${formatInitialSweepSnapshotScope(initialSweepPages)} 유동 ${initialSweepAllFluidPosts.length}개 -> ${getAttackModeFilterLabel(this.attackMode)} 후 ${initialSweepTargetPosts.length}개`,
      );
    } else {
      this.log(`🧹 initial sweep 대상 ${formatInitialSweepSnapshotScope(initialSweepPages)} 유동 ${initialSweepTargetPosts.length}개`);
    }
    await this.suspendUidWarningAutoBanForAttack();
    await this.ensureManagedDefensesStarted();
  }

  async resolveAttackCutoffSnapshot(currentSnapshot) {
    if (getMaxPostNo(currentSnapshot) > 0) {
      return currentSnapshot;
    }

    this.log('⚠️ 공격 cutoff snapshot 추출 실패, 1000ms 후 1회 재시도');
    await delay(1000);
    return await this.pollBoardSnapshot();
  }

  async resolveInitialSweepSnapshot(currentSnapshot, attackMode = ATTACK_MODE.DEFAULT) {
    const initialSweepPages = getNormalizedInitialSweepPages(this.config, attackMode);
    const currentSnapshotPages = getSnapshotMaxSourcePage(currentSnapshot);

    if (getMaxPostNo(currentSnapshot) > 0 && initialSweepPages <= currentSnapshotPages) {
      return filterSnapshotByMaxSourcePage(currentSnapshot, initialSweepPages);
    }

    this.log(`⚠️ initial sweep snapshot ${initialSweepPages}페이지 재수집`);
    const initialSweepSnapshot = await this.fetchBoardSnapshotPages(initialSweepPages, { trackProgress: false });
    if (getMaxPostNo(initialSweepSnapshot) > 0) {
      return initialSweepSnapshot;
    }

    this.log('⚠️ initial sweep snapshot 추출 실패, 1000ms 후 1회 재시도');
    await delay(1000);
    return await this.fetchBoardSnapshotPages(initialSweepPages, { trackProgress: false });
  }

  decideAttackMode(metrics) {
    const samplePosts = pickAttackModeSamplePosts(metrics);
    return buildAttackModeDecision(samplePosts, {
      isSemiconductorRefluxDatasetReady: isSemiconductorRefluxTitleSetReady(),
      matchesSemiconductorRefluxTitle: hasSemiconductorRefluxTitle,
    });
  }

  maybeWidenAttackMode(metrics) {
    if (this.attackMode === ATTACK_MODE.DEFAULT) {
      return false;
    }

    const attackModeDecision = this.decideAttackMode(metrics);
    if (attackModeDecision.sampleCount < ATTACK_MODE_SAMPLE_POST_LIMIT) {
      return false;
    }

    if (attackModeDecision.attackMode === this.attackMode) {
      return false;
    }

    const previousAttackModeLabel = formatAttackModeLabel(this.attackMode);
    this.attackMode = ATTACK_MODE.DEFAULT;
    this.attackModeReason = attackModeDecision.attackMode === ATTACK_MODE.DEFAULT
      ? attackModeDecision.reason
      : `공격 중 최신 샘플 3개가 ${formatAttackModeLabel(attackModeDecision.attackMode)} 패턴으로 바뀌어 DEFAULT로 확장`;
    this.attackModeSampleTitles = attackModeDecision.sampleTitles;
    this.log(`↔️ 공격 모드 확장: ${previousAttackModeLabel} -> DEFAULT (${this.attackModeReason})`);
    if (this.attackModeSampleTitles.length > 0) {
      this.log(`🧾 공격 샘플 제목: ${formatAttackSampleTitles(this.attackModeSampleTitles)}`);
    }
    return true;
  }

  async ensureManagedDefensesStarted() {
    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
    }

    if (!this.initialSweepCompleted) {
      await this.performInitialSweep();
    }

    this.syncManagedIpDeleteModeFromChild();

    if (!this.postScheduler.isRunning) {
      try {
        await this.postScheduler.start({
          cutoffPostNo: this.attackCutoffPostNo,
          attackMode: this.attackMode,
          source: 'monitor',
        });
      } catch (error) {
        this.log(`⚠️ 게시글 분류 자동 시작 실패 - ${error.message}`);
      }
    } else {
      let postStateChanged = false;

      if (Number(this.postScheduler.config.cutoffPostNo) !== Number(this.attackCutoffPostNo)) {
        this.postScheduler.config.cutoffPostNo = this.attackCutoffPostNo;
        postStateChanged = true;
      }

      if (this.postScheduler.setMonitorAttackMode(this.attackMode)) {
        postStateChanged = true;
      }

      if (!this.postScheduler.runPromise) {
        this.postScheduler.log('🔁 감시 자동화 관리 대상 게시글 분류 복원');
        this.postScheduler.ensureRunLoop();
        postStateChanged = true;
      }

      if (postStateChanged) {
        await this.postScheduler.saveState();
      }
    }

    if (this.postScheduler.isRunning && !this.managedPostStarted) {
      this.managedPostStarted = true;
      this.log('🛡️ 게시글 분류 자동 대응 ON');
    }

    if (!this.ipScheduler.isRunning) {
      try {
        await this.ipScheduler.start({
          cutoffPostNo: this.attackCutoffPostNo,
          delChk: this.managedIpDeleteEnabled,
          source: 'monitor',
        });
      } catch (error) {
        this.log(`⚠️ IP 차단 자동 시작 실패 - ${error.message}`);
      }
    } else {
      let ipStateChanged = false;

      if (Number(this.ipScheduler.config.cutoffPostNo) !== Number(this.attackCutoffPostNo)) {
        this.ipScheduler.config.cutoffPostNo = this.attackCutoffPostNo;
        ipStateChanged = true;
      }

      if (this.ipScheduler.syncManagedDeleteEnabled(this.managedIpDeleteEnabled)) {
        ipStateChanged = true;
      }

      if (!this.ipScheduler.runPromise) {
        this.ipScheduler.log('🔁 감시 자동화 관리 대상 IP 차단 복원');
        this.ipScheduler.ensureRunLoop();
        ipStateChanged = true;
      }

      if (ipStateChanged) {
        await this.ipScheduler.saveState();
      }
    }

    if (this.ipScheduler.isRunning) {
      await this.flushPendingManagedIpBanOnlyPosts();

      if (!this.managedIpStarted) {
        this.managedIpStarted = true;
        this.log('🛡️ IP 차단 자동 대응 ON');
      }

    }
  }

  async performInitialSweep() {
    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
    }

    const targetPosts = dedupePostsByNo(this.pendingInitialSweepPosts);
    const targetPostNos = buildInitialSweepPostNos(targetPosts);
    if (targetPostNos.length === 0) {
      this.initialSweepCompleted = true;
      return;
    }

    try {
      await performClassifyOnce(this.postScheduler, targetPostNos);
    } catch (error) {
      this.log(`⚠️ 감시 자동화 initial sweep 실패 - ${error.message}`);
    }

    try {
      const deleteResult = await performDeleteOnce(this.postScheduler, targetPostNos);
      if (deleteResult.successNos.length > 0) {
        this.log(`🗑️ 감시 자동화 initial sweep 삭제 완료 (${deleteResult.successNos.length}개)`);
      }
      if (deleteResult.failedNos.length > 0) {
        this.log(`⚠️ 감시 자동화 initial sweep 삭제 실패 ${deleteResult.failedNos.length}개 - ${deleteResult.failedNos.join(', ')}`);
        if (deleteResult.message) {
          this.log(`⚠️ 감시 자동화 initial sweep 삭제 상세: ${deleteResult.message}`);
        }

        if (deleteResult.deleteLimitExceeded || isDeleteLimitExceededText(deleteResult.message)) {
          this.pendingManagedIpBanOnlyPosts = dedupePostsByNo([
            ...this.pendingManagedIpBanOnlyPosts,
            ...pickPostsByNos(targetPosts, deleteResult.failedNos),
          ]);
          this.activateManagedIpBanOnly(deleteResult.message);
        }
      }
    } catch (error) {
      this.log(`⚠️ 감시 자동화 initial sweep 삭제 오류 - ${error.message}`);
      if (isDeleteLimitExceededText(error.message)) {
        this.pendingManagedIpBanOnlyPosts = dedupePostsByNo([
          ...this.pendingManagedIpBanOnlyPosts,
          ...targetPosts,
        ]);
        this.activateManagedIpBanOnly(error.message);
      }
    }

    this.pendingInitialSweepPostNos = [];
    this.pendingInitialSweepPosts = [];
    this.initialSweepCompleted = true;
    this.log(`✅ 감시 자동화 initial sweep 1회 처리 완료 (${targetPostNos.length}개 대상)`);

    await this.saveState();
  }

  async enterRecoveringMode() {
    const shouldResumeUidWarningAutoBan = this.managedUidWarningAutoBanSuspended;
    this.phase = PHASE.RECOVERING;
    this.releaseHitCount = 0;
    this.log('🧊 공격 종료 확정. 자동 대응 종료 시작');

    await this.stopManagedDefenses();
    this.totalAttackReleased += 1;
    this.clearAttackSession();
    this.phase = PHASE.NORMAL;
    this.log('✅ 감시 자동화 NORMAL 상태 복귀');
    await this.resumeUidWarningAutoBanAfterAttack(shouldResumeUidWarningAutoBan);
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

  clearAttackSession() {
    this.attackSessionId = '';
    this.attackCutoffPostNo = 0;
    this.attackMode = ATTACK_MODE.DEFAULT;
    this.attackModeReason = '';
    this.attackModeSampleTitles = [];
    this.initialSweepCompleted = false;
    this.pendingInitialSweepPostNos = [];
    this.pendingInitialSweepPosts = [];
    this.pendingManagedIpBanOnlyPosts = [];
    this.managedPostStarted = false;
    this.managedIpStarted = false;
    this.managedIpDeleteEnabled = true;
    this.managedUidWarningAutoBanSuspended = false;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.postScheduler.clearRuntimeAttackMode();
  }

  async suspendUidWarningAutoBanForAttack() {
    const scheduler = this.uidWarningAutoBanScheduler;
    if (!scheduler || !scheduler.isRunning) {
      this.managedUidWarningAutoBanSuspended = false;
      return;
    }

    try {
      await scheduler.stop();
      scheduler.log('ℹ️ 게시물 자동화 공격 감지로 분탕자동차단을 일시 정지합니다.');
      await scheduler.saveState();
      this.managedUidWarningAutoBanSuspended = true;
      this.log('🛑 분탕자동차단 일시 정지');
    } catch (error) {
      this.managedUidWarningAutoBanSuspended = false;
      this.log(`⚠️ 분탕자동차단 일시 정지 실패 - ${error.message}`);
    }
  }

  async resumeUidWarningAutoBanAfterAttack(shouldResume = this.managedUidWarningAutoBanSuspended) {
    if (!shouldResume) {
      this.managedUidWarningAutoBanSuspended = false;
      return;
    }

    const scheduler = this.uidWarningAutoBanScheduler;
    this.managedUidWarningAutoBanSuspended = false;
    if (!scheduler) {
      return;
    }

    if (scheduler.isRunning || scheduler.runPromise) {
      return;
    }

    if (this.ipScheduler.isRunning || this.ipScheduler.runPromise || this.ipScheduler.isReleaseRunning) {
      this.log('ℹ️ IP 차단 종료 전이라 분탕자동차단 자동 복원을 건너뜁니다.');
      return;
    }

    try {
      await scheduler.start();
      scheduler.log('🔁 게시물 자동화 공격 종료로 분탕자동차단을 자동 복원합니다.');
      await scheduler.saveState();
      this.log('🔁 분탕자동차단 자동 복원');
    } catch (error) {
      this.log(`⚠️ 분탕자동차단 자동 복원 실패 - ${error.message}`);
    }
  }

  activateManagedIpBanOnly(message = '') {
    const trimmedMessage = String(message || '').trim();
    if (!this.managedIpDeleteEnabled) {
      return false;
    }

    this.managedIpDeleteEnabled = false;
    this.log('⚠️ 삭제 한도 초과 감지 - 이번 공격 세션 동안 IP 차단만 유지');
    if (trimmedMessage) {
      this.log(`⚠️ 삭제 한도 상세: ${trimmedMessage}`);
    }

    if (this.ipScheduler.currentSource === 'monitor') {
      this.ipScheduler.activateDeleteLimitBanOnly(trimmedMessage);
    }

    return true;
  }

  syncManagedIpDeleteModeFromChild() {
    if (!this.managedIpDeleteEnabled) {
      return false;
    }

    if (this.ipScheduler.currentSource !== 'monitor') {
      return false;
    }

    if (this.ipScheduler.runtimeDeleteEnabled) {
      return false;
    }

    if (!this.ipScheduler.lastDeleteLimitExceededAt && !this.ipScheduler.lastDeleteLimitMessage) {
      return false;
    }

    this.managedIpDeleteEnabled = false;
    this.log('⚠️ 삭제 한도 초과 상태 확인 - 이번 공격 세션 동안 IP 차단만 유지');
    return true;
  }

  async flushPendingManagedIpBanOnlyPosts() {
    const targetPosts = dedupePostsByNo(this.pendingManagedIpBanOnlyPosts);
    if (targetPosts.length === 0) {
      return false;
    }

    if (!this.ipScheduler.isRunning || this.ipScheduler.currentSource !== 'monitor') {
      return false;
    }

    const result = await this.ipScheduler.banPostsOnce(targetPosts, {
      deleteEnabled: false,
      logLabel: '감시 자동화 initial sweep IP 차단',
    });

    if (result.failedNos.length > 0) {
      this.pendingManagedIpBanOnlyPosts = dedupePostsByNo(
        pickPostsByNos(targetPosts, result.failedNos),
      );
      await this.saveState();
      return false;
    }

    this.pendingManagedIpBanOnlyPosts = [];
    await this.saveState();
    return true;
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
          attackCutoffPostNo: this.attackCutoffPostNo,
          attackMode: this.attackMode,
          attackModeReason: this.attackModeReason,
          attackModeSampleTitles: this.attackModeSampleTitles,
          initialSweepCompleted: this.initialSweepCompleted,
          pendingInitialSweepPostNos: this.pendingInitialSweepPostNos,
          pendingInitialSweepPosts: this.pendingInitialSweepPosts,
          pendingManagedIpBanOnlyPosts: this.pendingManagedIpBanOnlyPosts,
          managedPostStarted: this.managedPostStarted,
          managedIpStarted: this.managedIpStarted,
          managedIpDeleteEnabled: this.managedIpDeleteEnabled,
          managedUidWarningAutoBanSuspended: this.managedUidWarningAutoBanSuspended,
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
      this.attackCutoffPostNo = Number(schedulerState.attackCutoffPostNo) || 0;
      this.attackMode = normalizeAttackMode(schedulerState.attackMode);
      this.attackModeReason = String(schedulerState.attackModeReason || '').trim();
      this.attackModeSampleTitles = normalizeAttackSampleTitles(schedulerState.attackModeSampleTitles);
      this.initialSweepCompleted = Boolean(schedulerState.initialSweepCompleted);
      this.pendingInitialSweepPostNos = dedupePostNos(schedulerState.pendingInitialSweepPostNos);
      this.pendingInitialSweepPosts = dedupePostsByNo(schedulerState.pendingInitialSweepPosts);
      this.pendingManagedIpBanOnlyPosts = dedupePostsByNo(schedulerState.pendingManagedIpBanOnlyPosts);
      this.managedPostStarted = Boolean(schedulerState.managedPostStarted);
      this.managedIpStarted = Boolean(schedulerState.managedIpStarted);
      this.managedIpDeleteEnabled = schedulerState.managedIpDeleteEnabled === undefined
        ? true
        : Boolean(schedulerState.managedIpDeleteEnabled);
      this.managedUidWarningAutoBanSuspended = Boolean(schedulerState.managedUidWarningAutoBanSuspended);
      this.totalAttackDetected = schedulerState.totalAttackDetected || 0;
      this.totalAttackReleased = schedulerState.totalAttackReleased || 0;
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = {
        ...this.config,
        ...(schedulerState.config || {}),
      };
      await ensureSemiconductorRefluxTitleSetLoaded();
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
      attackCutoffPostNo: this.attackCutoffPostNo,
      attackMode: this.attackMode,
      attackModeReason: this.attackModeReason,
      attackModeSampleTitles: this.attackModeSampleTitles,
      initialSweepCompleted: this.initialSweepCompleted,
      pendingInitialSweepPostNos: this.pendingInitialSweepPostNos,
      pendingInitialSweepPosts: this.pendingInitialSweepPosts,
      pendingManagedIpBanOnlyPosts: this.pendingManagedIpBanOnlyPosts,
      managedPostStarted: this.managedPostStarted,
      managedIpStarted: this.managedIpStarted,
      managedIpDeleteEnabled: this.managedIpDeleteEnabled,
      managedUidWarningAutoBanSuspended: this.managedUidWarningAutoBanSuspended,
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

async function performClassifyOnce(postScheduler, postNos) {
  return postScheduler.classifyPostsOnce(postNos, {
    logLabel: '감시 자동화 initial sweep',
  });
}

async function performDeleteOnce(postScheduler, postNos) {
  return deletePosts(postScheduler.config, postNos);
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

function formatAttackSampleTitles(titles) {
  return normalizeAttackSampleTitles(titles).join(' / ');
}

function normalizeAttackSampleTitles(titles) {
  return (Array.isArray(titles) ? titles : [])
    .map((title) => String(title || '').trim())
    .filter(Boolean)
    .slice(0, ATTACK_MODE_SAMPLE_POST_LIMIT);
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

function getMaxPostNo(posts) {
  return (Array.isArray(posts) ? posts : []).reduce(
    (maxPostNo, post) => Math.max(maxPostNo, Number(post?.no) || 0),
    0,
  );
}

function buildInitialSweepPostNos(snapshot) {
  return dedupePostNos(
    dedupePostsByNo(snapshot)
      .filter((post) => post?.isFluid)
      .map((post) => post.no),
  );
}

function buildAllFluidSnapshotPosts(snapshot) {
  return dedupePostsByNo(
    (Array.isArray(snapshot) ? snapshot : []).filter((post) => post?.isFluid),
  );
}

function buildInitialSweepPosts(snapshot, attackMode = ATTACK_MODE.DEFAULT, initialSweepPages = 1) {
  const normalizedAttackMode = normalizeAttackMode(attackMode);
  const limitedSnapshot = filterSnapshotByMaxSourcePage(snapshot, initialSweepPages);
  const allFluidPosts = buildAllFluidSnapshotPosts(limitedSnapshot);

  if (normalizedAttackMode !== ATTACK_MODE.DEFAULT) {
    return allFluidPosts.filter((post) => isEligibleForAttackMode(post, normalizedAttackMode, {
      isSemiconductorRefluxDatasetReady: isSemiconductorRefluxTitleSetReady(),
      matchesSemiconductorRefluxTitle: hasSemiconductorRefluxTitle,
    }));
  }

  return allFluidPosts;
}

function pickAttackModeSamplePosts(metrics) {
  return dedupePostsByNo(metrics?.newPosts)
    .filter((post) => post?.isFluid)
    .sort((left, right) => (Number(right?.no) || 0) - (Number(left?.no) || 0))
    .slice(0, ATTACK_MODE_SAMPLE_POST_LIMIT);
}

function formatInitialSweepSnapshotScope(monitorPages) {
  const normalizedPages = Math.max(1, Number(monitorPages) || 1);
  return normalizedPages === 1
    ? '1페이지'
    : `1~${normalizedPages}페이지`;
}

function getSnapshotMaxSourcePage(snapshot) {
  return dedupePostsByNo(snapshot).reduce(
    (maxPage, post) => Math.max(maxPage, Number(post?.sourcePage) || 0),
    0,
  );
}

function filterSnapshotByMaxSourcePage(snapshot, maxSourcePage = 1) {
  const normalizedMaxSourcePage = Math.max(1, Number(maxSourcePage) || 1);
  return dedupePostsByNo(snapshot).filter((post) => (Number(post?.sourcePage) || 1) <= normalizedMaxSourcePage);
}

function getNormalizedInitialSweepPages(config = {}, attackMode = ATTACK_MODE.DEFAULT) {
  const monitorPages = Number(config?.monitorPages);
  const normalizedMonitorPages = Number.isFinite(monitorPages) && monitorPages > 0
    ? Math.max(1, monitorPages)
    : 1;

  // 기본 모드는 감시 범위를 그대로 쓰고, 좁은 공격 모드(CJK/역류기)는 별도 initial sweep 설정을 공유한다.
  if (normalizeAttackMode(attackMode) === ATTACK_MODE.DEFAULT) {
    return normalizedMonitorPages;
  }

  const initialSweepPages = Number(config?.initialSweepPages);
  if (Number.isFinite(initialSweepPages) && initialSweepPages > 0) {
    return Math.max(1, initialSweepPages);
  }

  return normalizedMonitorPages;
}

function dedupePostNos(postNos) {
  return [...new Set(
    (Array.isArray(postNos) ? postNos : [])
      .map((postNo) => String(postNo || '').trim())
      .filter((postNo) => /^\d+$/.test(postNo)),
  )];
}

function dedupePostsByNo(posts) {
  const postMap = new Map();

  for (const post of Array.isArray(posts) ? posts : []) {
    const postNo = String(post?.no || '').trim();
    if (!/^\d+$/.test(postNo) || postMap.has(postNo)) {
      continue;
    }
    postMap.set(postNo, post);
  }

  return [...postMap.values()];
}

function pickPostsByNos(posts, postNos) {
  const targetNos = new Set(dedupePostNos(postNos));
  return dedupePostsByNo(
    (Array.isArray(posts) ? posts : []).filter((post) => targetNos.has(String(post?.no || '').trim())),
  );
}

function isDeleteLimitExceededText(value) {
  return /(일일\s*삭제\s*횟수가\s*초과되어\s*삭제할\s*수\s*없습니다|추가\s*삭제가\s*필요한\s*경우\s*신고\s*게시판에\s*문의)/.test(String(value || ''));
}

export { PHASE, Scheduler };
