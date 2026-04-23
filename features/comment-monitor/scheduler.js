import {
  delay,
  extractEsno,
  fetchAllComments,
  fetchPostList,
  fetchPostPage,
} from '../comment/api.js';
import {
  COMMENT_ATTACK_MODE,
  getCommentAttackModeHumanLabel,
  normalizeCommentAttackMode,
} from '../comment/attack-mode.js';
import {
  ensureCommentRefluxMatcherLoaded,
  getCommentRefluxMatcherStatus,
  hasCommentRefluxMemo,
  isCommentRefluxMatcherReady,
} from '../comment/comment-reflux-dataset.js';
import {
  ensureCommentRefluxSearchDuplicateBrokerLoaded,
  peekCommentRefluxSearchDuplicateDecision,
  resolveCommentRefluxSearchDuplicateDecision,
} from '../comment/comment-reflux-search-duplicate-broker.js';
import {
  buildCommentRefluxSearchQuery,
  filterFluidComments,
  isPureHangulCommentMemo,
  normalizeCommentMemo,
  normalizeCommentRefluxCompareKey,
} from '../comment/parser.js';
import { resolveRefluxSearchGalleryId } from '../reflux-search-gallery-id.js';
import { REFLUX_FOUR_STEP_STAGE, inspectRefluxFourStepCandidate } from '../reflux-four-step-filter.js';

const STORAGE_KEY = 'commentMonitorSchedulerState';
const COMMENT_ATTACK_SAMPLE_POST_LIMIT = 5;
const COMMENT_ATTACK_SAMPLE_COMMENT_LIMIT_PER_POST = 20;
const COMMENT_ATTACK_SAMPLE_MIN_FLUID_COMMENT_COUNT = 20;
const COMMENT_ATTACK_SAMPLE_RATIO_THRESHOLD = 0.7;

const PHASE = {
  SEEDING: 'SEEDING',
  NORMAL: 'NORMAL',
  ATTACKING: 'ATTACKING',
  RECOVERING: 'RECOVERING',
};

class Scheduler {
  constructor({ commentScheduler, isTrustedOwnedFeature } = {}) {
    if (!commentScheduler) {
      throw new Error('CommentMonitorScheduler는 comment scheduler 의존성이 필요합니다.');
    }

    this.commentScheduler = commentScheduler;
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
    this.managedCommentStarted = false;
    this.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
    this.lastManagedAttackModeReason = '';
    this.totalAttackDetected = 0;
    this.totalAttackReleased = 0;
    this.reseedRemaining = 1;
    this.lastLoggedCommentRefluxMatcherDegradedReason = '';
    this.logs = [];

    this.config = {
      galleryId: 'thesingularity',
      monitorPages: 2,
      pollIntervalMs: 20000,
      attackNewCommentThreshold: 30,
      attackChangedPostThreshold: 20,
      attackAltNewCommentThreshold: 50,
      attackAltChangedPostThreshold: 9,
      attackConsecutiveCount: 2,
      releaseNewCommentThreshold: 30,
      releaseVerifiedDeleteThreshold: 10,
      releaseConsecutiveCount: 3,
      reseedPollCountAfterRelease: 1,
    };
  }

  getStartBlockReason() {
    const commentBlocked = (this.commentScheduler.isRunning || this.commentScheduler.runPromise)
      && !this.isTrustedOwnedFeature('comment');
    if (commentBlocked) {
      return '댓글 감시 자동화를 시작하기 전에 댓글 방어를 먼저 정지하세요.';
    }

    return '';
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 댓글 감시 자동화가 실행 중입니다.');
      return;
    }

    const startBlockReason = this.getStartBlockReason();
    if (startBlockReason) {
      throw new Error(startBlockReason);
    }

    this.isRunning = true;
    this.phase = PHASE.SEEDING;
    this.currentPollPage = 0;
    this.cycleCount = 0;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.lastPollAt = '';
    this.lastMetrics = buildEmptyMetrics();
    this.lastSnapshot = [];
    this.attackSessionId = '';
    this.managedCommentStarted = false;
    this.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
    this.lastManagedAttackModeReason = '';
    this.reseedRemaining = 1;
    this.lastLoggedCommentRefluxMatcherDegradedReason = '';
    this.log('🟢 댓글 감시 자동화 시작!');
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('⚠️ 이미 댓글 감시 자동화가 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    await this.stopManagedDefense();
    await waitForOwnRunLoop(this);
    this.clearAttackSession();
    this.phase = PHASE.SEEDING;
    this.currentPollPage = 0;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.lastPollAt = '';
    this.lastMetrics = buildEmptyMetrics();
    this.lastSnapshot = [];
    this.reseedRemaining = 1;
    this.log('🔴 댓글 감시 자동화 중지.');
    await this.saveState();
  }

  async run() {
    while (this.isRunning) {
      try {
        const currentSnapshot = await this.pollCommentSnapshot();
        if (!this.isRunning) {
          break;
        }

        const metrics = this.computeMetrics(currentSnapshot);
        metrics.verifiedDeletedCount = this.commentScheduler.getVerifiedDeletedCountWithin(this.config.pollIntervalMs);
        this.lastPollAt = new Date().toISOString();
        if (!this.isRunning) {
          break;
        }

        if (this.phase === PHASE.RECOVERING) {
          await this.enterRecoveringMode();
          if (!this.isRunning) {
            break;
          }

          this.lastSnapshot = currentSnapshot;
          this.lastMetrics = buildSeedMetrics(metrics.snapshotPostCount);
          this.currentPollPage = 0;
          this.cycleCount += 1;
          await this.saveState();
          if (!this.isRunning) {
            break;
          }
          await delayWhileRunning(this, this.config.pollIntervalMs);
          continue;
        }

        if (this.phase === PHASE.SEEDING || this.lastSnapshot.length === 0 || this.reseedRemaining > 0) {
          this.lastSnapshot = currentSnapshot;
          this.lastMetrics = buildSeedMetrics(metrics.snapshotPostCount);
          this.reseedRemaining = Math.max(0, this.reseedRemaining - 1);
          this.phase = this.reseedRemaining > 0 ? PHASE.SEEDING : PHASE.NORMAL;
          this.currentPollPage = 0;
          this.cycleCount += 1;
          this.log(`🌱 기준 스냅샷 저장 완료 (${metrics.snapshotPostCount}개 게시물)`);
          await this.saveState();
          if (!this.isRunning) {
            break;
          }
          await delayWhileRunning(this, this.config.pollIntervalMs);
          continue;
        }

        this.log(
          `📡 새 댓글 ${metrics.newCommentCount}개 / 변화 글 ${metrics.changedPostCount}개 / 실제 삭제 ${metrics.verifiedDeletedCount}개`,
        );
        if (!this.isRunning) {
          break;
        }

        if (this.phase === PHASE.NORMAL) {
          await this.evaluateNormalState(metrics);
        } else if (this.phase === PHASE.ATTACKING) {
          await this.ensureManagedDefenseStarted();
          await this.evaluateAttackingState(metrics);
        }
        if (!this.isRunning) {
          break;
        }

        this.lastSnapshot = currentSnapshot;
        this.lastMetrics = metrics;
        this.currentPollPage = 0;
        this.cycleCount += 1;
        await this.saveState();
        if (!this.isRunning) {
          break;
        }
        await delayWhileRunning(this, this.config.pollIntervalMs);
      } catch (error) {
        this.currentPollPage = 0;
        this.log(`❌ 댓글 감시 오류 - ${error.message}`);
        console.error('[CommentMonitorScheduler] run error:', error);
        await this.saveState();

        if (this.isRunning) {
          await delayWhileRunning(this, 10000);
        }
      }
    }

    await this.saveState();
  }

  async pollCommentSnapshot() {
    const postMap = new Map();
    const pages = Math.max(1, Number(this.config.monitorPages) || 1);

    for (let page = 1; page <= pages; page += 1) {
      if (!this.isRunning) {
        break;
      }

      this.currentPollPage = page;
      const { posts } = await fetchPostList({ galleryId: this.config.galleryId }, page);

      for (const post of posts) {
        const key = String(post.no);
        if (!postMap.has(key)) {
          postMap.set(key, {
            postNo: post.no,
            commentCount: post.commentCount,
          });
          continue;
        }

        const existing = postMap.get(key);
        existing.commentCount = Math.max(existing.commentCount, post.commentCount);
      }
    }

    return [...postMap.values()];
  }

  computeMetrics(currentSnapshot) {
    const previousCommentCountByPost = new Map(
      this.lastSnapshot.map((post) => [String(post.postNo), Number(post.commentCount) || 0]),
    );
    const topChangedPosts = [];
    let newCommentCount = 0;
    let changedPostCount = 0;

    for (const post of currentSnapshot) {
      const postNo = String(post.postNo);
      const currentCommentCount = Number(post.commentCount) || 0;
      const previousCommentCount = previousCommentCountByPost.has(postNo)
        ? previousCommentCountByPost.get(postNo)
        : null;
      const delta = previousCommentCount === null
        ? currentCommentCount
        : Math.max(0, currentCommentCount - previousCommentCount);

      if (delta > 0) {
        changedPostCount += 1;
        newCommentCount += delta;
        topChangedPosts.push({
          postNo: post.postNo,
          delta,
          commentCount: currentCommentCount,
        });
      }
    }

    topChangedPosts.sort((left, right) => right.delta - left.delta);

    return {
      snapshotPostCount: currentSnapshot.length,
      changedPostCount,
      newCommentCount,
      verifiedDeletedCount: 0,
      topChangedPosts: topChangedPosts.slice(0, COMMENT_ATTACK_SAMPLE_POST_LIMIT),
    };
  }

  async evaluateNormalState(metrics) {
    if (!this.isRunning) {
      return;
    }

    const attackEvaluation = this.evaluateAttackCondition(metrics);

    if (attackEvaluation.matched) {
      this.attackHitCount += 1;
      this.log(
        `🚨 댓글 공격 감지 streak ${this.attackHitCount}/${this.config.attackConsecutiveCount} `
        + `(새 댓글 ${metrics.newCommentCount} / 변화 글 ${metrics.changedPostCount} / 조건 ${attackEvaluation.ruleLabel})`,
      );
      if (this.attackHitCount >= this.config.attackConsecutiveCount) {
        await this.enterAttackMode(metrics);
      }
      return;
    }

    if (this.attackHitCount > 0) {
      this.log('ℹ️ 댓글 공격 감지 streak 초기화');
    }
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
  }

  evaluateAttackCondition(metrics) {
    const primaryNewCommentThreshold = Math.max(1, Number(this.config.attackNewCommentThreshold) || 30);
    const primaryChangedPostThreshold = Math.max(1, Number(this.config.attackChangedPostThreshold) || 20);
    const altNewCommentThreshold = Math.max(1, Number(this.config.attackAltNewCommentThreshold) || 50);
    const altChangedPostThreshold = Math.max(1, Number(this.config.attackAltChangedPostThreshold) || 9);

    const primaryMatched = metrics.newCommentCount >= primaryNewCommentThreshold
      && metrics.changedPostCount >= primaryChangedPostThreshold;
    if (primaryMatched) {
      return {
        matched: true,
        ruleKey: 'primary',
        ruleLabel: `${primaryNewCommentThreshold}/${primaryChangedPostThreshold}`,
      };
    }

    const altMatched = metrics.newCommentCount >= altNewCommentThreshold
      && metrics.changedPostCount >= altChangedPostThreshold;
    if (altMatched) {
      return {
        matched: true,
        ruleKey: 'alt',
        ruleLabel: `${altNewCommentThreshold}/${altChangedPostThreshold}`,
      };
    }

    return {
      matched: false,
      ruleKey: '',
      ruleLabel: '',
    };
  }

  async evaluateAttackingState(metrics) {
    if (!this.isRunning) {
      return;
    }

    const releaseCondition = metrics.newCommentCount <= this.config.releaseNewCommentThreshold
      && metrics.verifiedDeletedCount <= this.config.releaseVerifiedDeleteThreshold;

    if (releaseCondition) {
      this.releaseHitCount += 1;
      this.log(
        `🧊 댓글 종료 감지 streak ${this.releaseHitCount}/${this.config.releaseConsecutiveCount} `
        + `(새 댓글 ${metrics.newCommentCount} / 실제 삭제 ${metrics.verifiedDeletedCount})`,
      );
      if (this.releaseHitCount >= this.config.releaseConsecutiveCount) {
        await this.enterRecoveringMode();
      }
      return;
    }

    if (this.releaseHitCount > 0) {
      this.log('ℹ️ 댓글 종료 감지 streak 초기화');
    }
    this.releaseHitCount = 0;
  }

  async enterAttackMode(metrics = buildEmptyMetrics()) {
    if (!this.isRunning) {
      return;
    }

    const attackModeDecision = await this.buildManagedAttackModeDecision(metrics);
    if (!this.isRunning || attackModeDecision?.stale) {
      return;
    }

    this.phase = PHASE.ATTACKING;
    this.attackSessionId = `comment_attack_${Date.now()}`;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.totalAttackDetected += 1;
    this.currentManagedAttackMode = attackModeDecision.attackMode;
    this.lastManagedAttackModeReason = attackModeDecision.reason;
    this.commentScheduler.resetVerificationState();
    this.log(
      `🚨 댓글 공격 상태 진입 (${this.attackSessionId}) / ${getCommentAttackModeHumanLabel(this.currentManagedAttackMode)} `
      + `- ${this.lastManagedAttackModeReason}`,
    );
    await this.ensureManagedDefenseStarted();
  }

  async ensureManagedDefenseStarted() {
    if (!this.isRunning || this.phase !== PHASE.ATTACKING) {
      return;
    }

    if (this.isTrustedOwnedFeature('comment')) {
      return;
    }

    let attackMode = normalizeCommentAttackMode(this.currentManagedAttackMode);

    if (!this.commentScheduler.isRunning) {
      try {
        await this.commentScheduler.start({
          source: 'monitor',
          commentAttackMode: attackMode,
        });
      } catch (error) {
        if (attackMode !== COMMENT_ATTACK_MODE.DEFAULT) {
          this.log(`⚠️ ${getCommentAttackModeHumanLabel(attackMode)} 자동 시작 실패 - ${error.message}. 기본 댓글 방어로 전환합니다.`);
          this.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
          this.lastManagedAttackModeReason = `${error.message} / 기본 댓글 방어 fallback`;
          attackMode = COMMENT_ATTACK_MODE.DEFAULT;
          try {
            await this.commentScheduler.start({
              source: 'monitor',
              commentAttackMode: attackMode,
            });
          } catch (fallbackError) {
            this.log(`⚠️ 댓글 방어 자동 시작 실패 - ${fallbackError.message}`);
          }
        } else {
          this.log(`⚠️ 댓글 방어 자동 시작 실패 - ${error.message}`);
        }
      }
    } else {
      const sourceChanged = this.commentScheduler.setCurrentSource('monitor');
      let attackModeChanged = false;

      try {
        attackModeChanged = await this.commentScheduler.setRuntimeAttackMode(attackMode);
      } catch (error) {
        if (attackMode !== COMMENT_ATTACK_MODE.DEFAULT) {
          this.log(`⚠️ ${getCommentAttackModeHumanLabel(attackMode)} 전환 실패 - ${error.message}. 기본 댓글 방어로 전환합니다.`);
          this.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
          this.lastManagedAttackModeReason = `${error.message} / 기본 댓글 방어 fallback`;
          attackMode = COMMENT_ATTACK_MODE.DEFAULT;
          attackModeChanged = await this.commentScheduler.setRuntimeAttackMode(attackMode);
        } else {
          throw error;
        }
      }

      if (sourceChanged || attackModeChanged) {
        await this.commentScheduler.saveState();
      }
    }

    if (this.commentScheduler.isRunning && !this.managedCommentStarted) {
      this.managedCommentStarted = true;
      this.log(`🛡️ 댓글 방어 자동 대응 ON - ${getCommentAttackModeHumanLabel(attackMode)}`);
    }
  }

  async buildManagedAttackModeDecision(metrics = buildEmptyMetrics()) {
    const sampleComments = await this.collectSampleFluidComments(metrics.topChangedPosts);
    const sampleCount = sampleComments.length;

    if (sampleCount < COMMENT_ATTACK_SAMPLE_MIN_FLUID_COMMENT_COUNT) {
      return {
        attackMode: COMMENT_ATTACK_MODE.DEFAULT,
        reason: `샘플 유동 댓글 ${sampleCount}개라서 기본 댓글 방어 유지`,
      };
    }

    let refluxMatcherReady = false;
    let refluxMatcherStatus = getCommentRefluxMatcherStatus();
    try {
      await ensureCommentRefluxMatcherLoaded();
      refluxMatcherReady = isCommentRefluxMatcherReady();
      refluxMatcherStatus = getCommentRefluxMatcherStatus();
    } catch (error) {
      const errorMessage = String(error?.message || 'unknown error').trim() || 'unknown error';
      refluxMatcherStatus = {
        ...refluxMatcherStatus,
        ready: false,
        twoParentIndexReady: false,
        reason: errorMessage,
      };
      this.log(`⚠️ 역류기 댓글 matcher 준비 실패 - ${errorMessage}`);
    }

    if (refluxMatcherReady && !refluxMatcherStatus.twoParentIndexReady) {
      this.maybeLogCommentRefluxMatcherDegradedWarning(refluxMatcherStatus.reason);
    }

    const refluxMatchStats = refluxMatcherReady
      ? await this.countManagedCommentRefluxMatches(sampleComments)
      : buildEmptyManagedCommentRefluxMatchStats();
    if (refluxMatchStats.stale) {
      return {
        attackMode: COMMENT_ATTACK_MODE.DEFAULT,
        reason: '댓글 감시 자동화가 정지되어 공격 판정을 중단했습니다.',
        stale: true,
      };
    }

    if (refluxMatchStats.brokerErrorMessage) {
      this.log(`⚠️ 자동 역류기 샘플 search 준비 실패 - ${refluxMatchStats.brokerErrorMessage}`);
    }

    if (refluxMatchStats.searchErrorCount > 0) {
      this.log(`⚠️ 자동 역류기 샘플 search 확인 실패 ${refluxMatchStats.searchErrorCount}건`);
    }

    const refluxMatchCount = refluxMatchStats.totalMatchCount;
    const refluxSearchMatchCount = refluxMatchStats.searchCachePositiveCount + refluxMatchStats.searchPositiveCount;
    const nonPureHangulCount = sampleComments.reduce((count, comment) => (
      isNonPureHangulLikeComment(comment.memo) ? count + 1 : count
    ), 0);

    const refluxRatio = sampleCount > 0 ? refluxMatchCount / sampleCount : 0;
    const nonPureHangulRatio = sampleCount > 0 ? nonPureHangulCount / sampleCount : 0;

    if (refluxMatcherReady && refluxRatio >= COMMENT_ATTACK_SAMPLE_RATIO_THRESHOLD) {
      return {
        attackMode: COMMENT_ATTACK_MODE.COMMENT_REFLUX,
        reason: `샘플 유동 댓글 ${sampleCount}개 중 matcher ${refluxMatchStats.matcherCount}개 + search ${refluxSearchMatchCount}개 = ${refluxMatchCount}개 (${formatRatioPercent(refluxRatio)}%)`,
      };
    }

    if (nonPureHangulRatio >= COMMENT_ATTACK_SAMPLE_RATIO_THRESHOLD) {
      return {
        attackMode: COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL,
        reason: `샘플 유동 댓글 ${sampleCount}개 중 비순수한글 ${nonPureHangulCount}개 (${formatRatioPercent(nonPureHangulRatio)}%) / 역류 matcher ${refluxMatchStats.matcherCount}개 + search ${refluxSearchMatchCount}개 = ${refluxMatchCount}개`,
      };
    }

    return {
      attackMode: COMMENT_ATTACK_MODE.DEFAULT,
      reason: `샘플 유동 댓글 ${sampleCount}개 중 역류 matcher ${refluxMatchStats.matcherCount}개 + search ${refluxSearchMatchCount}개 = ${refluxMatchCount}개 / 비순수한글 ${nonPureHangulCount}개라서 기본 댓글 방어 유지`,
    };
  }

  buildManagedCommentRefluxSearchContext(comment, context = {}) {
    const plainText = normalizeCommentMemo(comment?.memo);
    const normalizedCompareKey = normalizeCommentRefluxCompareKey(plainText);
    const searchQuery = buildCommentRefluxSearchQuery(plainText);
    if (!plainText || !normalizedCompareKey || !searchQuery) {
      return null;
    }

    return {
      deleteGalleryId: String(context.deleteGalleryId || '').trim().toLowerCase(),
      searchGalleryId: String(context.searchGalleryId || '').trim().toLowerCase(),
      currentPostNo: Number(comment?.postNo) || 0,
      plainText,
      normalizedCompareKey,
      searchQuery,
    };
  }

  async countManagedCommentRefluxMatches(sampleComments = []) {
    const stats = buildEmptyManagedCommentRefluxMatchStats();
    const sampleCount = Array.isArray(sampleComments) ? sampleComments.length : 0;
    const requiredMatchCount = Math.ceil(sampleCount * COMMENT_ATTACK_SAMPLE_RATIO_THRESHOLD);
    if (sampleCount <= 0) {
      return stats;
    }

    const matcherMissComments = [];
    for (const comment of sampleComments) {
      if (!this.isRunning) {
        return {
          ...stats,
          stale: true,
        };
      }

      if (hasCommentRefluxMemo(comment?.memo)) {
        stats.matcherCount += 1;
        stats.totalMatchCount += 1;
      } else {
        matcherMissComments.push(comment);
      }
    }

    if (stats.totalMatchCount >= requiredMatchCount || matcherMissComments.length <= 0) {
      return stats;
    }

    const deleteGalleryId = String(
      this.commentScheduler?.config?.galleryId || this.config.galleryId || '',
    ).trim().toLowerCase();
    // 자동 감지도 실제 댓글 삭제 런타임과 같은 search 갤 기준을 써야 판정/실행이 어긋나지 않는다.
    const searchGalleryId = resolveRefluxSearchGalleryId({
      galleryId: deleteGalleryId,
      refluxSearchGalleryId: this.commentScheduler?.config?.refluxSearchGalleryId,
    });
    if (!searchGalleryId) {
      return stats;
    }

    try {
      await ensureCommentRefluxSearchDuplicateBrokerLoaded();
    } catch (error) {
      return {
        ...stats,
        brokerErrorMessage: String(error?.message || 'unknown error').trim() || 'unknown error',
      };
    }

    if (!this.isRunning) {
      return {
        ...stats,
        stale: true,
      };
    }

    const unresolvedJobs = [];
    const sharedContext = {
      deleteGalleryId,
      searchGalleryId,
    };

    for (const comment of matcherMissComments) {
      if (!this.isRunning) {
        return {
          ...stats,
          stale: true,
        };
      }

      const inspection = inspectRefluxFourStepCandidate({
        value: comment,
        matchesDataset: () => false,
        buildSearchContext: (currentComment) => this.buildManagedCommentRefluxSearchContext(currentComment, sharedContext),
        peekSearchDecision: peekCommentRefluxSearchDuplicateDecision,
      });

      if (inspection.stage === REFLUX_FOUR_STEP_STAGE.SEARCH_CACHE_POSITIVE) {
        stats.searchCachePositiveCount += 1;
        stats.totalMatchCount += 1;
      } else if (inspection.stage === REFLUX_FOUR_STEP_STAGE.SEARCH_NEGATIVE) {
        stats.searchNegativeCount += 1;
      } else if (inspection.stage === REFLUX_FOUR_STEP_STAGE.SEARCH_ERROR) {
        stats.searchErrorCount += 1;
      } else {
        unresolvedJobs.push(inspection.searchContext);
      }

      if (stats.totalMatchCount >= requiredMatchCount) {
        return stats;
      }
    }

    // 남은 unresolved를 전부 hit로 가정해도 70%를 못 넘으면 더 볼 필요가 없다.
    if (stats.totalMatchCount + unresolvedJobs.length < requiredMatchCount) {
      return stats;
    }

    for (let index = 0; index < unresolvedJobs.length; index += 1) {
      const remainingCandidateCount = unresolvedJobs.length - index;
      if (stats.totalMatchCount + remainingCandidateCount < requiredMatchCount) {
        return stats;
      }

      if (!this.isRunning) {
        return {
          ...stats,
          stale: true,
        };
      }

      const decision = await resolveCommentRefluxSearchDuplicateDecision(unresolvedJobs[index]);
      if (!this.isRunning) {
        return {
          ...stats,
          stale: true,
        };
      }

      if (decision.result === 'positive') {
        stats.searchPositiveCount += 1;
        stats.totalMatchCount += 1;
      } else if (decision.result === 'negative') {
        stats.searchNegativeCount += 1;
      } else if (decision.result === 'cancelled') {
        stats.cancelledCount += 1;
      } else {
        stats.searchErrorCount += 1;
      }

      if (stats.totalMatchCount >= requiredMatchCount) {
        return stats;
      }
    }

    return stats;
  }

  async collectSampleFluidComments(topChangedPosts = []) {
    const config = { galleryId: this.config.galleryId };
    const sampleComments = [];

    for (const post of (Array.isArray(topChangedPosts) ? topChangedPosts : []).slice(0, COMMENT_ATTACK_SAMPLE_POST_LIMIT)) {
      if (!this.isRunning) {
        break;
      }

      const postNo = Number(post?.postNo) || 0;
      if (postNo <= 0) {
        continue;
      }

      try {
        const html = await fetchPostPage(config, postNo);
        const esno = extractEsno(html);
        if (!esno) {
          this.log(`⚠️ 자동 댓글 모드 샘플링 스킵 - #${postNo} e_s_n_o 추출 실패`);
          continue;
        }

        const { comments } = await fetchAllComments(config, postNo, esno, 4);
        const fluidComments = filterFluidComments(comments)
          .slice(0, COMMENT_ATTACK_SAMPLE_COMMENT_LIMIT_PER_POST)
          .map((comment) => ({
            postNo,
            no: comment.no,
            memo: comment.memo,
          }));

        sampleComments.push(...fluidComments);
      } catch (error) {
        this.log(`⚠️ 자동 댓글 모드 샘플링 스킵 - #${postNo} ${error.message}`);
      }
    }

    return sampleComments;
  }

  async enterRecoveringMode() {
    if (!this.isRunning) {
      return;
    }

    this.releaseHitCount = 0;
    this.log('🧊 댓글 공격 종료 확정. 댓글 방어 자동 종료 시작');
    await this.stopManagedDefense();
    this.totalAttackReleased += 1;
    this.clearAttackSession();
    this.reseedRemaining = Math.max(1, Number(this.config.reseedPollCountAfterRelease) || 1);
    this.phase = PHASE.SEEDING;
    this.log(`🌱 댓글 감시 기준 스냅샷 재수집 예정 (${this.reseedRemaining} poll)`);
  }

  async stopManagedDefense() {
    const shouldStopComment = this.managedCommentStarted;

    if (!shouldStopComment) {
      return;
    }

    try {
      if (this.commentScheduler.isRunning) {
        await this.commentScheduler.stop();
      }
      await waitForSchedulerRunLoop(this.commentScheduler, '댓글 방어');
      this.log('🛑 댓글 방어 자동 대응 OFF');
    } catch (error) {
      this.log(`⚠️ 댓글 방어 자동 정지 실패 - ${error.message}`);
    }
  }

  clearAttackSession() {
    this.attackSessionId = '';
    this.managedCommentStarted = false;
    this.attackHitCount = 0;
    this.releaseHitCount = 0;
    this.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
    this.lastManagedAttackModeReason = '';
    this.lastLoggedCommentRefluxMatcherDegradedReason = '';
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[CommentMonitorScheduler] ${message}`);
    this.logs.unshift(entry);
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(0, 100);
    }
  }

  maybeLogCommentRefluxMatcherDegradedWarning(reason = '') {
    const normalizedReason = String(reason || '').trim() || 'unknown reason';
    if (this.lastLoggedCommentRefluxMatcherDegradedReason === normalizedReason) {
      return;
    }

    this.lastLoggedCommentRefluxMatcherDegradedReason = normalizedReason;
    this.log(`⚠️ 댓글 2-parent index 준비 실패 - single-title matcher만 사용합니다. (${normalizedReason})`);
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
          lastMetrics: this.lastMetrics,
          lastSnapshot: this.lastSnapshot,
          attackSessionId: this.attackSessionId,
          managedCommentStarted: this.managedCommentStarted,
          currentManagedAttackMode: this.currentManagedAttackMode,
          lastManagedAttackModeReason: this.lastManagedAttackModeReason,
          totalAttackDetected: this.totalAttackDetected,
          totalAttackReleased: this.totalAttackReleased,
          reseedRemaining: this.reseedRemaining,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[CommentMonitorScheduler] 상태 저장 실패:', error.message);
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
      this.managedCommentStarted = Boolean(schedulerState.managedCommentStarted);
      this.currentManagedAttackMode = normalizeCommentAttackMode(schedulerState.currentManagedAttackMode);
      this.lastManagedAttackModeReason = String(schedulerState.lastManagedAttackModeReason || '');
      this.totalAttackDetected = schedulerState.totalAttackDetected || 0;
      this.totalAttackReleased = schedulerState.totalAttackReleased || 0;
      this.reseedRemaining = Math.max(0, schedulerState.reseedRemaining || 0);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = {
        ...this.config,
        ...(schedulerState.config || {}),
      };
    } catch (error) {
      console.error('[CommentMonitorScheduler] 상태 복원 실패:', error.message);
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
      this.log('🔁 저장된 댓글 감시 자동화 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    const refluxMatcherStatus = getCommentRefluxMatcherStatus();
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      currentPollPage: this.currentPollPage,
      cycleCount: this.cycleCount,
      attackHitCount: this.attackHitCount,
      releaseHitCount: this.releaseHitCount,
      lastPollAt: this.lastPollAt,
      lastMetrics: this.lastMetrics,
      attackSessionId: this.attackSessionId,
      managedCommentStarted: this.managedCommentStarted,
      currentManagedAttackMode: this.currentManagedAttackMode,
      lastManagedAttackModeReason: this.lastManagedAttackModeReason,
      totalAttackDetected: this.totalAttackDetected,
      totalAttackReleased: this.totalAttackReleased,
      reseedRemaining: this.reseedRemaining,
      refluxMatcherReady: Boolean(refluxMatcherStatus.ready),
      refluxTwoParentReady: Boolean(refluxMatcherStatus.ready && refluxMatcherStatus.twoParentIndexReady),
      refluxMatcherReason: String(refluxMatcherStatus.reason || ''),
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }
}

function buildEmptyMetrics() {
  return {
    snapshotPostCount: 0,
    changedPostCount: 0,
    newCommentCount: 0,
    verifiedDeletedCount: 0,
    topChangedPosts: [],
  };
}

function buildSeedMetrics(snapshotPostCount) {
  return {
    ...buildEmptyMetrics(),
    snapshotPostCount,
  };
}

function buildEmptyManagedCommentRefluxMatchStats() {
  return {
    stale: false,
    totalMatchCount: 0,
    matcherCount: 0,
    searchCachePositiveCount: 0,
    searchPositiveCount: 0,
    searchNegativeCount: 0,
    searchErrorCount: 0,
    cancelledCount: 0,
    brokerErrorMessage: '',
  };
}

function normalizePhase(phase) {
  if (Object.values(PHASE).includes(phase)) {
    return phase;
  }

  return PHASE.SEEDING;
}

function isNonPureHangulLikeComment(memo) {
  const normalizedMemo = normalizeCommentMemo(memo);
  if (!normalizedMemo) {
    return false;
  }

  return !isPureHangulCommentMemo(normalizedMemo);
}

function formatRatioPercent(value) {
  return (Math.max(0, Number(value) || 0) * 100).toFixed(1);
}

async function waitForSchedulerRunLoop(scheduler, featureName) {
  if (!scheduler?.runPromise) {
    return;
  }

  try {
    await scheduler.runPromise;
  } catch (error) {
    throw new Error(`${featureName} 정지 대기 실패: ${error.message}`);
  }
}

async function waitForOwnRunLoop(scheduler) {
  if (!scheduler?.runPromise) {
    return;
  }

  try {
    await scheduler.runPromise;
  } catch (error) {
    throw new Error(`댓글 감시 자동화 정지 대기 실패: ${error.message}`);
  }
}

async function delayWhileRunning(scheduler, waitMs) {
  const normalizedWaitMs = Math.max(0, Number(waitMs) || 0);
  const startedAt = Date.now();

  while (scheduler?.isRunning) {
    const elapsed = Date.now() - startedAt;
    const remaining = normalizedWaitMs - elapsed;
    if (remaining <= 0) {
      return;
    }

    await delay(Math.min(remaining, 250));
  }
}

export { PHASE, Scheduler };
