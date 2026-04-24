import { deletePosts, fetchPostListHTML, delay } from '../post/api.js';
import { parseBoardPosts } from '../post/parser.js';
import {
  ATTACK_MODE,
  ATTACK_MODE_SAMPLE_POST_LIMIT,
  buildAttackModeDecision,
  buildAttackModeDecisionFromCounts,
  formatAttackModeLabel,
  getAttackModeFilterLabel,
  isEligibleForAttackMode,
  normalizeAttackMode,
} from '../post/attack-mode.js';
import {
  ensureSemiconductorRefluxEffectiveMatcherLoaded,
  hasSemiconductorRefluxEffectivePostTitle,
  isSemiconductorRefluxEffectiveMatcherReady,
} from '../post/semiconductor-reflux-effective-matcher.js';
import {
  ensureRefluxSearchDuplicateBrokerLoaded,
  peekRefluxSearchDuplicateDecision,
  resolveRefluxSearchDuplicateDecision,
} from '../post/reflux-search-duplicate-broker.js';
import { resolveRefluxSearchGalleryId } from '../reflux-search-gallery-id.js';
import { requestDeleteLimitAccountFallback } from '../../background/dc-session-broker.js';

const STORAGE_KEY = 'monitorSchedulerState';

const PHASE = {
  SEEDING: 'SEEDING',
  NORMAL: 'NORMAL',
  ATTACKING: 'ATTACKING',
  RECOVERING: 'RECOVERING',
};

class Scheduler {
  constructor({ postScheduler, ipScheduler, uidWarningAutoBanScheduler, isTrustedOwnedFeature } = {}) {
    if (!postScheduler || !ipScheduler) {
      throw new Error('MonitorScheduler는 post/ip scheduler 의존성이 필요합니다.');
    }

    this.postScheduler = postScheduler;
    this.ipScheduler = ipScheduler;
    this.uidWarningAutoBanScheduler = uidWarningAutoBanScheduler || null;
    this.isTrustedOwnedFeature = typeof isTrustedOwnedFeature === 'function'
      ? isTrustedOwnedFeature
      : () => false;

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
    this.managedUidWarningAutoBanBanOnly = false;
    this.totalAttackDetected = 0;
    this.totalAttackReleased = 0;
    this.logs = [];
    this.asyncDecisionToken = 0;

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
    const postBlocked = (this.postScheduler.isRunning || this.postScheduler.runPromise)
      && !this.isTrustedOwnedFeature('post');
    if (postBlocked) {
      return '감시 자동화를 시작하기 전에 게시글 분류를 먼저 정지하세요.';
    }

    const ipBlocked = (this.ipScheduler.isRunning || this.ipScheduler.runPromise || this.ipScheduler.isReleaseRunning)
      && !this.isTrustedOwnedFeature('ip');
    if (ipBlocked) {
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

    await ensureSemiconductorRefluxEffectiveMatcherLoaded();
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
    this.managedUidWarningAutoBanBanOnly = false;
    this.asyncDecisionToken += 1;
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

    const shouldRestoreUidWarningAutoBanDeleteMode = this.managedUidWarningAutoBanBanOnly;
    this.asyncDecisionToken += 1;
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
    await this.restoreUidWarningAutoBanDeleteModeAfterAttack(shouldRestoreUidWarningAutoBanDeleteMode);
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
    const asyncDecisionToken = this.asyncDecisionToken;
    const attackSnapshot = await this.resolveAttackCutoffSnapshot(currentSnapshot);
    if (this.isAsyncDecisionStale(asyncDecisionToken)) {
      return;
    }
    const attackCutoffPostNo = getMaxPostNo(attackSnapshot);
    if (attackCutoffPostNo <= 0) {
      throw new Error('공격 cutoff snapshot 추출에 실패했습니다.');
    }

    const attackModeDecision = await this.decideAttackMode(metrics, {
      operationToken: asyncDecisionToken,
    });
    if (attackModeDecision?.stale || this.isAsyncDecisionStale(asyncDecisionToken)) {
      return;
    }
    const initialSweepPages = getNormalizedInitialSweepPages(this.config, attackModeDecision.attackMode);
    const initialSweepSnapshot = await this.resolveInitialSweepSnapshot(currentSnapshot, attackModeDecision.attackMode);
    if (this.isAsyncDecisionStale(asyncDecisionToken)) {
      return;
    }
    const initialSweepAllFluidPosts = buildAllFluidSnapshotPosts(initialSweepSnapshot);
    const initialSweepTargetPosts = await this.resolveInitialSweepTargetPosts(
      initialSweepSnapshot,
      attackModeDecision.attackMode,
      initialSweepPages,
      asyncDecisionToken,
    );
    if (initialSweepTargetPosts?.stale || this.isAsyncDecisionStale(asyncDecisionToken)) {
      return;
    }

    this.phase = PHASE.ATTACKING;
    this.attackSessionId = `attack_${Date.now()}`;
    this.attackCutoffPostNo = attackCutoffPostNo;
    this.attackMode = attackModeDecision.attackMode;
    this.attackModeReason = attackModeDecision.reason;
    this.attackModeSampleTitles = attackModeDecision.sampleTitles;
    this.initialSweepCompleted = false;
    this.pendingInitialSweepPosts = initialSweepTargetPosts.posts;
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
        `🧹 initial sweep 대상 ${formatInitialSweepSnapshotScope(initialSweepPages)} 유동 ${initialSweepAllFluidPosts.length}개 -> ${getAttackModeFilterLabel(this.attackMode)} 후 ${initialSweepTargetPosts.posts.length}개`,
      );
    } else {
      this.log(`🧹 initial sweep 대상 ${formatInitialSweepSnapshotScope(initialSweepPages)} 유동 ${initialSweepTargetPosts.posts.length}개`);
    }
    await this.activateUidWarningAutoBanBanOnlyForAttack();
    await this.saveState();
    if (this.isAsyncDecisionStale(asyncDecisionToken) || this.phase !== PHASE.ATTACKING) {
      return;
    }
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

  isAsyncDecisionStale(operationToken) {
    return !this.isRunning || operationToken !== this.asyncDecisionToken;
  }

  getResolvedRefluxSearchGalleryId() {
    return resolveRefluxSearchGalleryId(this.postScheduler?.config || {});
  }

  buildRefluxSearchDecisionContext(post, searchGalleryId = this.getResolvedRefluxSearchGalleryId()) {
    return {
      deleteGalleryId: this.config.galleryId,
      searchGalleryId,
      postNo: post?.no,
      title: String(post?.subject || '').trim(),
    };
  }

  async resolveInitialSweepTargetPosts(
    snapshot,
    attackMode = ATTACK_MODE.DEFAULT,
    initialSweepPages = 1,
    operationToken = this.asyncDecisionToken,
  ) {
    const normalizedAttackMode = normalizeAttackMode(attackMode);
    if (normalizedAttackMode !== ATTACK_MODE.SEMICONDUCTOR_REFLUX) {
      return {
        stale: false,
        posts: buildInitialSweepPosts(snapshot, normalizedAttackMode, initialSweepPages),
      };
    }

    const limitedSnapshot = filterSnapshotByMaxSourcePage(snapshot, initialSweepPages);
    const allFluidPosts = buildAllFluidSnapshotPosts(limitedSnapshot);
    const matchedPosts = [];
    const searchGalleryId = this.getResolvedRefluxSearchGalleryId();

    const missingDatasetPosts = allFluidPosts.filter((post) => !hasSemiconductorRefluxEffectivePostTitle(post?.subject));
    if (missingDatasetPosts.length > 0) {
      await ensureRefluxSearchDuplicateBrokerLoaded();
      if (this.isAsyncDecisionStale(operationToken)) {
        return {
          stale: true,
          posts: [],
        };
      }
    }

    for (const post of allFluidPosts) {
      const title = String(post?.subject || '').trim();
      if (!title) {
        continue;
      }

      if (hasSemiconductorRefluxEffectivePostTitle(title)) {
        matchedPosts.push(post);
        continue;
      }

      const searchDecision = await resolveRefluxSearchDuplicateDecision(
        this.buildRefluxSearchDecisionContext(post, searchGalleryId),
      );
      if (this.isAsyncDecisionStale(operationToken)) {
        return {
          stale: true,
          posts: [],
        };
      }

      if (searchDecision.result === 'positive') {
        matchedPosts.push(post);
      }
    }

    return {
      stale: false,
      posts: dedupePostsByNo(matchedPosts),
    };
  }

  async decideAttackMode(metrics, { operationToken = this.asyncDecisionToken } = {}) {
    const samplePosts = pickAttackModeSamplePosts(metrics);
    const baseDecision = buildAttackModeDecision(samplePosts, {
      isSemiconductorRefluxDatasetReady: isSemiconductorRefluxEffectiveMatcherReady(),
      matchesSemiconductorRefluxTitle: hasSemiconductorRefluxEffectivePostTitle,
    });
    if (baseDecision.sampleCount < ATTACK_MODE_SAMPLE_POST_LIMIT) {
      return baseDecision;
    }

    const searchGalleryId = this.getResolvedRefluxSearchGalleryId();
    if (!searchGalleryId) {
      return baseDecision;
    }

    await ensureRefluxSearchDuplicateBrokerLoaded();
    if (this.isAsyncDecisionStale(operationToken)) {
      return {
        ...baseDecision,
        stale: true,
      };
    }

    let refluxLikeCount = 0;
    for (const post of samplePosts) {
      const title = String(post?.subject || '').trim();
      if (!title) {
        continue;
      }

      if (hasSemiconductorRefluxEffectivePostTitle(title)) {
        refluxLikeCount += 1;
        continue;
      }

      const searchDecision = await resolveRefluxSearchDuplicateDecision(
        this.buildRefluxSearchDecisionContext(post, searchGalleryId),
      );
      if (this.isAsyncDecisionStale(operationToken)) {
        return {
          ...baseDecision,
          stale: true,
        };
      }

      if (searchDecision.result === 'positive') {
        refluxLikeCount += 1;
      }
    }

    return buildAttackModeDecisionFromCounts({
      sampleCount: baseDecision.sampleCount,
      hanLikeCount: baseDecision.hanLikeCount,
      refluxLikeCount,
      sampleTitles: baseDecision.sampleTitles,
    });
  }

  buildCheapAttackModeDecision(metrics) {
    const samplePosts = pickAttackModeSamplePosts(metrics);
    const baseDecision = buildAttackModeDecision(samplePosts, {
      isSemiconductorRefluxDatasetReady: isSemiconductorRefluxEffectiveMatcherReady(),
      matchesSemiconductorRefluxTitle: hasSemiconductorRefluxEffectivePostTitle,
    });
    if (baseDecision.sampleCount < ATTACK_MODE_SAMPLE_POST_LIMIT) {
      return baseDecision;
    }

    const searchGalleryId = this.getResolvedRefluxSearchGalleryId();
    if (!searchGalleryId) {
      return baseDecision;
    }

    let refluxLikeCount = 0;
    for (const post of samplePosts) {
      const title = String(post?.subject || '').trim();
      if (!title) {
        continue;
      }

      if (hasSemiconductorRefluxEffectivePostTitle(title)) {
        refluxLikeCount += 1;
        continue;
      }

      const searchDecision = peekRefluxSearchDuplicateDecision(
        this.buildRefluxSearchDecisionContext(post, searchGalleryId),
      );
      if (searchDecision.result === 'positive') {
        refluxLikeCount += 1;
      }
    }

    return buildAttackModeDecisionFromCounts({
      sampleCount: baseDecision.sampleCount,
      hanLikeCount: baseDecision.hanLikeCount,
      refluxLikeCount,
      sampleTitles: baseDecision.sampleTitles,
    });
  }

  maybeWidenAttackMode(metrics) {
    if (this.attackMode === ATTACK_MODE.DEFAULT) {
      return false;
    }

    const attackModeDecision = this.buildCheapAttackModeDecision(metrics);
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
      : `공격 중 최신 샘플 ${ATTACK_MODE_SAMPLE_POST_LIMIT}개가 ${formatAttackModeLabel(attackModeDecision.attackMode)} 패턴으로 바뀌어 DEFAULT로 확장`;
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

    if (this.isTrustedOwnedFeature('post') || this.isTrustedOwnedFeature('ip')) {
      return;
    }

    if (!this.initialSweepCompleted) {
      await this.performInitialSweep();
    }

    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
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

      if (this.attackMode === ATTACK_MODE.SEMICONDUCTOR_REFLUX) {
        await ensureSemiconductorRefluxEffectiveMatcherLoaded();
      }

      if (Number(this.postScheduler.config.cutoffPostNo) !== Number(this.attackCutoffPostNo)) {
        this.postScheduler.config.cutoffPostNo = this.attackCutoffPostNo;
        postStateChanged = true;
      }

      if (await this.postScheduler.setMonitorAttackMode(this.attackMode)) {
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

    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
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

    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
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

    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
    }

    await this.deleteInitialSweepPostsWithFallback(targetPosts, targetPostNos);

    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
    }

    this.pendingInitialSweepPostNos = [];
    this.pendingInitialSweepPosts = [];
    this.initialSweepCompleted = true;
    this.log(`✅ 감시 자동화 initial sweep 1회 처리 완료 (${targetPostNos.length}개 대상)`);

    await this.saveState();
  }

  async deleteInitialSweepPostsWithFallback(targetPosts, targetPostNos) {
    let pendingNos = dedupePostNos(targetPostNos);
    let fallbackAttemptCount = 0;
    const maxFallbackAttempts = 3;

    while (pendingNos.length > 0) {
      if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
        return;
      }

      let deleteResult = null;
      try {
        deleteResult = await performDeleteOnce(this.postScheduler, pendingNos);
      } catch (error) {
        this.log(`⚠️ 감시 자동화 initial sweep 삭제 오류 - ${error.message}`);
        if (!isDeleteLimitExceededText(error.message)) {
          return;
        }

        deleteResult = {
          successNos: [],
          failedNos: [...pendingNos],
          message: error.message,
          deleteLimitExceeded: true,
        };
      }

      this.logInitialSweepDeleteResult(deleteResult);
      const successNos = dedupePostNos(deleteResult?.successNos);
      if (successNos.length > 0) {
        this.removePendingManagedIpBanOnlyPosts(successNos);
      }

      const deleteLimitExceeded = Boolean(deleteResult?.deleteLimitExceeded) || isDeleteLimitExceededText(deleteResult?.message);
      if (!deleteLimitExceeded) {
        return;
      }

      const resultFailedNos = dedupePostNos(deleteResult?.failedNos);
      const failedNos = resultFailedNos.length > 0 ? resultFailedNos : pendingNos;
      const failedPosts = pickPostsByNos(targetPosts, failedNos);
      if (failedPosts.length > 0) {
        this.pendingManagedIpBanOnlyPosts = dedupePostsByNo([
          ...this.pendingManagedIpBanOnlyPosts,
          ...failedPosts,
        ]);
      }

      if (fallbackAttemptCount >= maxFallbackAttempts) {
        this.activateManagedIpBanOnly('삭제 한도 계정 전환 재시도 한도에 도달해 이번 공격 세션 동안 IP 차단만 유지합니다.');
        return;
      }

      let fallbackResult = null;
      try {
        fallbackResult = await requestDeleteLimitAccountFallback({
          feature: 'monitor',
          reason: 'delete_limit_exceeded',
          message: deleteResult.message,
        });
      } catch (error) {
        const message = error?.message || deleteResult.message || '삭제 한도 계정 전환 중 오류가 발생했습니다.';
        this.activateManagedIpBanOnly(message);
        return;
      }

      if (!fallbackResult?.success) {
        this.activateManagedIpBanOnly(fallbackResult?.message || deleteResult.message);
        return;
      }

      if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
        return;
      }

      fallbackAttemptCount += 1;
      this.log(`🔁 감시 자동화 initial sweep 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 삭제를 재시도합니다.`);
      pendingNos = failedNos;
    }
  }

  removePendingManagedIpBanOnlyPosts(postNos) {
    const removeNos = new Set(dedupePostNos(postNos));
    if (removeNos.size === 0 || this.pendingManagedIpBanOnlyPosts.length === 0) {
      return false;
    }

    const beforeCount = this.pendingManagedIpBanOnlyPosts.length;
    this.pendingManagedIpBanOnlyPosts = dedupePostsByNo(
      this.pendingManagedIpBanOnlyPosts.filter((post) => !removeNos.has(String(post?.no || '').trim())),
    );
    return this.pendingManagedIpBanOnlyPosts.length !== beforeCount;
  }

  logInitialSweepDeleteResult(deleteResult) {
    const successNos = dedupePostNos(deleteResult?.successNos);
    const failedNos = dedupePostNos(deleteResult?.failedNos);
    const message = String(deleteResult?.message || '').trim();

    if (successNos.length > 0) {
      this.log(`🗑️ 감시 자동화 initial sweep 삭제 완료 (${successNos.length}개)`);
    }

    if (failedNos.length > 0) {
      this.log(`⚠️ 감시 자동화 initial sweep 삭제 실패 ${failedNos.length}개 - ${failedNos.join(', ')}`);
      if (message) {
        this.log(`⚠️ 감시 자동화 initial sweep 삭제 상세: ${message}`);
      }
    }
  }

  async enterRecoveringMode() {
    const shouldRestoreUidWarningAutoBanDeleteMode = this.managedUidWarningAutoBanBanOnly;
    this.phase = PHASE.RECOVERING;
    this.releaseHitCount = 0;
    this.log('🧊 공격 종료 확정. 자동 대응 종료 시작');

    await this.stopManagedDefenses();
    this.totalAttackReleased += 1;
    this.clearAttackSession();
    this.phase = PHASE.NORMAL;
    this.log('✅ 감시 자동화 NORMAL 상태 복귀');
    await this.restoreUidWarningAutoBanDeleteModeAfterAttack(shouldRestoreUidWarningAutoBanDeleteMode);
  }

  async stopManagedDefenses() {
    const shouldStopPost = this.managedPostStarted;
    const shouldStopIp = this.managedIpStarted;

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
    this.managedUidWarningAutoBanBanOnly = false;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.postScheduler.clearRuntimeAttackMode();
  }

  async activateUidWarningAutoBanBanOnlyForAttack() {
    const scheduler = this.uidWarningAutoBanScheduler;
    if (!scheduler || !scheduler.isRunning) {
      this.managedUidWarningAutoBanBanOnly = false;
      return;
    }

    try {
      if (typeof scheduler.activateMonitorAttackBanOnly !== 'function') {
        throw new Error('분탕자동차단 ban-only helper를 찾을 수 없습니다.');
      }

      const switched = scheduler.activateMonitorAttackBanOnly();
      this.managedUidWarningAutoBanBanOnly = Boolean(switched);
      if (switched) {
        await scheduler.saveState();
        this.log('🛡️ 분탕자동차단 ban-only 전환');
      }
    } catch (error) {
      this.managedUidWarningAutoBanBanOnly = false;
      this.log(`⚠️ 분탕자동차단 ban-only 전환 실패 - ${error.message}`);
    }
  }

  async restoreUidWarningAutoBanDeleteModeAfterAttack(shouldRestore = this.managedUidWarningAutoBanBanOnly) {
    if (!shouldRestore) {
      this.managedUidWarningAutoBanBanOnly = false;
      return;
    }

    const scheduler = this.uidWarningAutoBanScheduler;
    this.managedUidWarningAutoBanBanOnly = false;
    if (!scheduler) {
      return;
    }

    try {
      if (typeof scheduler.restoreRuntimeDeleteModeFromConfig !== 'function') {
        throw new Error('분탕자동차단 delete mode restore helper를 찾을 수 없습니다.');
      }

      scheduler.restoreRuntimeDeleteModeFromConfig();
      scheduler.log('🔁 게시물 자동화 공격 종료로 분탕자동차단 삭제/차단 모드를 원래 설정으로 복원합니다.');
      await scheduler.saveState();
      this.log('🔁 분탕자동차단 삭제 모드 복원');
    } catch (error) {
      this.log(`⚠️ 분탕자동차단 삭제 모드 복원 실패 - ${error.message}`);
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
          managedUidWarningAutoBanBanOnly: this.managedUidWarningAutoBanBanOnly,
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
      this.managedUidWarningAutoBanBanOnly = schedulerState.managedUidWarningAutoBanBanOnly === undefined
        ? Boolean(schedulerState.managedUidWarningAutoBanSuspended)
        : Boolean(schedulerState.managedUidWarningAutoBanBanOnly);
      this.totalAttackDetected = schedulerState.totalAttackDetected || 0;
      this.totalAttackReleased = schedulerState.totalAttackReleased || 0;
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = {
        ...this.config,
        ...(schedulerState.config || {}),
      };
      if (this.isRunning) {
        await ensureSemiconductorRefluxEffectiveMatcherLoaded();
      }
      if (this.isRunning && this.attackMode === ATTACK_MODE.SEMICONDUCTOR_REFLUX) {
        await ensureRefluxSearchDuplicateBrokerLoaded();
      }
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
      managedUidWarningAutoBanBanOnly: this.managedUidWarningAutoBanBanOnly,
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
      isSemiconductorRefluxDatasetReady: isSemiconductorRefluxEffectiveMatcherReady(),
      matchesSemiconductorRefluxTitle: hasSemiconductorRefluxEffectivePostTitle,
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
  return /(일일.*(삭제|차단)횟수.*초과.*(삭제|차단)할\s*수\s*없|추가.*(삭제|차단).*신고\s*게시판.*문의)/i.test(String(value || ''));
}

export { PHASE, Scheduler };
