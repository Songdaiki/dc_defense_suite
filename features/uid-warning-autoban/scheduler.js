import {
  ATTACK_TITLE_BAN_HOUR,
  ATTACK_TITLE_BAN_REASON_TEXT,
  EMPTY_ATTACK_TITLE_PATTERN_CORPUS,
  detectAttackTitleClusters,
  isAlreadySpamHead,
  loadBundledAttackTitlePatternCorpus,
} from './attack-title-cluster.js';
import {
  buildAttackCommentActionKey,
  buildAttackCommentDeletePlanByPostNo,
  createAttackCommentSnapshotComments,
  detectAttackCommentClusters,
} from './attack-comment-cluster.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_AVOID_REASON_TEXT,
  LEGACY_AVOID_REASON_TEXT,
  PREVIOUS_DEFAULT_AVOID_REASON_TEXT,
  delay,
  fetchUidWarningAutoBanListHTML,
  fetchUidWarningAutoBanPostViewHTML,
} from './api.js';
import {
  createImmediateTitleBanTargetPosts,
  createUidBanTargetPosts,
  getNewestPostNo,
  getRecentRowsWithinWindow,
  groupRowsByUid,
  hasUserHttpsLinkInPostBody,
  normalizeImmediateTitleBanRules,
  normalizeImmediateTitleValue,
  parseImmediateTitleBanRows,
  parseUidWarningAutoBanRows,
} from './parser.js';
import {
  deleteAndBanComments,
  extractEsno,
  fetchRecentComments,
} from '../comment/api.js';
import { filterFluidComments } from '../comment/parser.js';
import { executeBanWithDeleteFallback } from '../ip/ban-executor.js';
import { getOrFetchUidStats } from '../../background/uid-stats-cache.js';
import { getOrFetchUidGallogPrivacy } from '../../background/uid-gallog-privacy-cache.js';
import { getOrFetchUidGallogGuestbookState } from '../../background/uid-gallog-guestbook-cache.js';

const STORAGE_KEY = 'uidWarningAutoBanSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
};
const DELETE_MODE_REASON = {
  NORMAL: 'normal',
  DELETE_LIMIT: 'delete_limit',
  MONITOR_ATTACK: 'monitor_attack',
};
const UID_ACTION_RETENTION_MS = 24 * 60 * 60 * 1000;
const ATTACK_COMMENT_ACTION_RETENTION_MS = 10 * 60 * 1000;
const SINGLE_SIGHT_TOTAL_ACTIVITY_THRESHOLD = 20;
const DEFAULT_LINKBAIT_TITLE_NEEDLE = normalizeImmediateTitleValue('이거 진짜');

class Scheduler {
  constructor(dependencies = {}) {
    this.fetchListHtml = dependencies.fetchListHtml || fetchUidWarningAutoBanListHTML;
    this.fetchPostViewHtml = dependencies.fetchPostViewHtml || fetchUidWarningAutoBanPostViewHTML;
    this.parseRows = dependencies.parseRows || parseUidWarningAutoBanRows;
    this.parseImmediateRows = dependencies.parseImmediateRows || parseImmediateTitleBanRows;
    this.fetchUidStats = dependencies.fetchUidStats || getOrFetchUidStats;
    this.fetchUidGallogPrivacy = dependencies.fetchUidGallogPrivacy || getOrFetchUidGallogPrivacy;
    this.fetchUidGallogGuestbookState = dependencies.fetchUidGallogGuestbookState || getOrFetchUidGallogGuestbookState;
    this.detectAttackTitleClusters = dependencies.detectAttackTitleClusters || detectAttackTitleClusters;
    this.loadAttackTitlePatternCorpus = dependencies.loadAttackTitlePatternCorpus || loadBundledAttackTitlePatternCorpus;
    this.detectAttackCommentClusters = dependencies.detectAttackCommentClusters || detectAttackCommentClusters;
    this.extractEsno = dependencies.extractEsno || extractEsno;
    this.fetchRecentComments = dependencies.fetchRecentComments || fetchRecentComments;
    this.deleteAndBanComments = dependencies.deleteAndBanComments || deleteAndBanComments;
    this.filterFluidComments = dependencies.filterFluidComments || filterFluidComments;
    this.executeBan = dependencies.executeBan || executeBanWithDeleteFallback;
    this.isCommentDefenseRunning = dependencies.isCommentDefenseRunning || (() => false);
    this.delayFn = dependencies.delayFn || delay;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.currentPage = 1;
    this.lastPollAt = '';
    this.nextRunAt = '';
    this.lastTriggeredUid = '';
    this.lastTriggeredPostCount = 0;
    this.lastBurstRecentCount = 0;
    this.lastSingleSightTriggeredUid = '';
    this.lastSingleSightTriggeredPostCount = 0;
    this.lastImmediateTitleBanCount = 0;
    this.lastImmediateTitleBanMatchedTitle = '';
    this.lastLinkbaitBodyLinkCandidateCount = 0;
    this.lastLinkbaitBodyLinkCheckedCount = 0;
    this.lastLinkbaitBodyLinkMatchedCount = 0;
    this.lastLinkbaitBodyLinkActionCount = 0;
    this.lastLinkbaitBodyLinkRepresentative = '';
    this.lastAttackTitleClusterCount = 0;
    this.lastAttackTitleClusterPostCount = 0;
    this.lastAttackTitleClusterRepresentative = '';
    this.lastAttackCommentClusterCount = 0;
    this.lastAttackCommentClusterDeleteCount = 0;
    this.lastAttackCommentClusterPostCount = 0;
    this.lastAttackCommentClusterRepresentative = '';
    this.lastPageRowCount = 0;
    this.lastPageUidCount = 0;
    this.totalTriggeredUidCount = 0;
    this.totalSingleSightTriggeredUidCount = 0;
    this.totalImmediateTitleBanPostCount = 0;
    this.totalLinkbaitBodyLinkPostCount = 0;
    this.totalAttackTitleClusterPostCount = 0;
    this.totalAttackCommentClusterDeleteCount = 0;
    this.totalSingleSightBannedPostCount = 0;
    this.totalBannedPostCount = 0;
    this.totalFailedPostCount = 0;
    this.deleteLimitFallbackCount = 0;
    this.banOnlyFallbackCount = 0;
    this.lastError = '';
    this.cycleCount = 0;
    this.logs = [];
    this.runtimeDeleteEnabled = Boolean(DEFAULT_CONFIG.delChk);
    this.runtimeDeleteModeReason = DELETE_MODE_REASON.NORMAL;
    this.lastDeleteLimitExceededAt = '';
    this.lastDeleteLimitMessage = '';
    this.recentUidActions = {};
    this.recentImmediatePostActions = {};
    this.recentLinkbaitBodyLinkActions = {};
    this.recentAttackTitlePostActions = {};
    this.recentAttackCommentActions = {};
    this.commentSnapshotByPostNo = {};
    this.attackTitlePatternLoadError = '';
    this.attackTitlePatternCorpusPromise = null;
    this.lastAttackTitlePatternLoadErrorLog = '';

    this.config = normalizeConfig({
      galleryId: DEFAULT_CONFIG.galleryId,
      galleryType: DEFAULT_CONFIG.galleryType,
      baseUrl: DEFAULT_CONFIG.baseUrl,
    });
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 분탕자동차단이 실행 중입니다.');
      return;
    }

    this.isRunning = true;
    this.phase = PHASE.RUNNING;
    this.currentPage = 1;
    this.nextRunAt = '';
    this.commentSnapshotByPostNo = {};
    this.restoreRuntimeDeleteModeFromConfig();
    this.lastError = '';
    this.log('🟢 분탕자동차단 시작!');
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    if (!this.isRunning) {
      this.commentSnapshotByPostNo = {};
      this.log('⚠️ 이미 분탕자동차단이 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.currentPage = 1;
    this.nextRunAt = '';
    this.commentSnapshotByPostNo = {};
    this.restoreRuntimeDeleteModeFromConfig();
    this.lastError = '';
    this.log('🔴 분탕자동차단 중지.');
    await this.saveState();
  }

  async run() {
    while (this.isRunning) {
      const nextRunAtMs = parseTimestamp(this.nextRunAt);
      if (nextRunAtMs > Date.now()) {
        if (this.phase !== PHASE.WAITING) {
          this.phase = PHASE.WAITING;
          await this.saveState();
        }

        await delayWhileRunning(this, nextRunAtMs - Date.now());
        continue;
      }

      try {
        this.phase = PHASE.RUNNING;
        await this.saveState();
        await this.runCycle();

        if (!this.isRunning) {
          break;
        }

        const completedAt = Date.now();
        this.cycleCount += 1;
        this.lastPollAt = new Date(completedAt).toISOString();
        this.nextRunAt = new Date(completedAt + getPollIntervalMs(this.config)).toISOString();
        this.phase = PHASE.WAITING;
        this.currentPage = 1;
        this.log(
          `✅ 사이클 #${this.cycleCount} 완료 - page1 글 ${this.lastPageRowCount}개 / uid ${this.lastPageUidCount}명 / 누적 uid 제재 ${this.totalTriggeredUidCount}명 / 제목 직차단 ${this.totalImmediateTitleBanPostCount}개 / 이거진짜 링크본문 ${this.totalLinkbaitBodyLinkPostCount}개 / 실제공격 ${this.totalAttackTitleClusterPostCount}개 / 댓글군집 ${this.totalAttackCommentClusterDeleteCount}개 / 단일깡계 ${this.totalSingleSightBannedPostCount}개`,
        );
        await this.saveState();
      } catch (error) {
        this.phase = PHASE.WAITING;
        this.currentPage = 1;
        this.lastError = String(error?.message || '알 수 없는 오류');
        this.log(`❌ 분탕자동차단 오류 - ${this.lastError}`);
        console.error('[UidWarningAutoBanScheduler] run error:', error);

        if (this.isRunning) {
          this.nextRunAt = new Date(Date.now() + getPollIntervalMs(this.config)).toISOString();
        }

        await this.saveState();
      }
    }

    this.phase = PHASE.IDLE;
    await this.saveState();
  }

  async runCycle() {
    this.currentPage = 1;
    this.lastError = '';
    this.lastImmediateTitleBanCount = 0;
    this.lastImmediateTitleBanMatchedTitle = '';
    this.lastLinkbaitBodyLinkCandidateCount = 0;
    this.lastLinkbaitBodyLinkCheckedCount = 0;
    this.lastLinkbaitBodyLinkMatchedCount = 0;
    this.lastLinkbaitBodyLinkActionCount = 0;
    this.lastLinkbaitBodyLinkRepresentative = '';
    this.lastAttackTitleClusterCount = 0;
    this.lastAttackTitleClusterPostCount = 0;
    this.lastAttackTitleClusterRepresentative = '';
    this.lastAttackCommentClusterCount = 0;
    this.lastAttackCommentClusterDeleteCount = 0;
    this.lastAttackCommentClusterPostCount = 0;
    this.lastAttackCommentClusterRepresentative = '';
    pruneRecentUidActions(this.recentUidActions);
    pruneRecentImmediatePostActions(this.recentImmediatePostActions);
    pruneRecentLinkbaitBodyLinkActions(this.recentLinkbaitBodyLinkActions);
    pruneRecentAttackTitlePostActions(this.recentAttackTitlePostActions);
    pruneRecentAttackCommentActions(this.recentAttackCommentActions);
    const nowMs = Date.now();
    const html = await this.fetchListHtml(this.config, 1);
    const allRows = this.parseImmediateRows(html);
    const pageUidRows = allRows.filter((row) => row?.hasUid === true);
    this.lastPageRowCount = allRows.length;
    this.lastPageUidCount = groupRowsByUid(pageUidRows).length;
    this.log(`📄 page1 snapshot ${allRows.length}개 / uid ${this.lastPageUidCount}명`);
    await this.saveState();
    const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
    const processedLinkbaitBodyLinkPostNos = await this.handleLinkbaitBodyLinkRows(
      allRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0)),
      nowMs,
    );
    const processedAttackTitlePostNos = await this.handleAttackTitleClusterRows(
      allRows.filter((row) => {
        const postNo = Number(row?.no) || 0;
        return !processedImmediatePostNos.has(postNo)
          && !processedLinkbaitBodyLinkPostNos.has(postNo);
      }),
      nowMs,
    );
    const processedPostNos = new Set([
      ...processedImmediatePostNos,
      ...processedLinkbaitBodyLinkPostNos,
      ...processedAttackTitlePostNos,
    ]);
    try {
      await this.handleAttackCommentClusterRows(
        allRows.filter((row) => !processedPostNos.has(Number(row?.no) || 0)),
        html,
        nowMs,
      );
    } catch (error) {
      this.log(`⚠️ 실제공격 댓글 군집 확인 실패 - ${error.message}`);
    }
    const rows = pageUidRows.filter((row) => !processedPostNos.has(Number(row?.no) || 0));
    const groupedRows = groupRowsByUid(rows);

    let statsCandidateCount = 0;
    let statsFailureCount = 0;
    let statsSuccessCount = 0;
    let gallogCandidateCount = 0;
    let gallogFailureCount = 0;
    let gallogSuccessCount = 0;
    let guestbookCandidateCount = 0;
    let guestbookFailureCount = 0;
    let guestbookSuccessCount = 0;

    for (const groupedEntry of groupedRows) {
      if (!this.isRunning) {
        break;
      }

      const countableRows = groupedEntry.rows.filter((row) => row?.isPicturePost !== true);
      const recentRows = getRecentRowsWithinWindow(
        countableRows,
        getRecentWindowMs(this.config),
        getRecentPostThreshold(this.config),
      );
      const isBurstCandidate = recentRows.length >= getRecentPostThreshold(this.config);
      const representativeNick = String(
        recentRows[0]?.nick || countableRows[0]?.nick || groupedEntry.rows[0]?.nick || '',
      ).trim();
      if (!isTwoConsonantNick(representativeNick)) {
        this.log(`ℹ️ ${groupedEntry.uid} 스킵 - 자음 2글자 닉네임 필터 미달 (최신 닉네임: ${representativeNick || '없음'})`);
        continue;
      }

      const dedupeRows = countableRows.length > 0 ? countableRows : groupedEntry.rows;
      const newestPostNo = getNewestPostNo(dedupeRows);
      const actionKey = buildUidActionKey(this.config.galleryId, groupedEntry.uid);
      if (shouldSkipRecentUidAction(this.recentUidActions[actionKey], newestPostNo, nowMs, getRetryCooldownMs(this.config))) {
        this.log(`ℹ️ ${groupedEntry.uid} 스킵 - 새 글번호가 없어 같은 uid 재시도를 건너뜀`);
        continue;
      }

      statsCandidateCount += 1;
      let stats;
      try {
        stats = await this.fetchUidStats(this.config.galleryId, groupedEntry.uid);
      } catch (error) {
        statsFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 활동 통계 조회 실패 - ${error.message}`);
        continue;
      }

      if (stats?.success !== true) {
        statsFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 활동 통계 조회 실패 - ${stats?.message || '응답 형식 오류'}`);
        continue;
      }

      const effectivePostRatio = Number(stats?.effectivePostRatio ?? stats?.postRatio);
      if (!Number.isFinite(effectivePostRatio)) {
        statsFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 활동 통계 비율 값이 비정상이라 이번 cycle에서 제외합니다.`);
        continue;
      }

      statsSuccessCount += 1;
      if (effectivePostRatio < getPostRatioThresholdPercent(this.config)) {
        this.log(
          `ℹ️ ${groupedEntry.uid} 스킵 - 글비중 ${formatPostRatio(effectivePostRatio)}%라 기준 ${getPostRatioThresholdPercent(this.config)}% 미달`,
        );
        continue;
      }

      const totalActivityCount = Number(stats?.totalActivityCount);
      if (!Number.isFinite(totalActivityCount) || totalActivityCount < 0) {
        statsFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 활동 통계 총합 값이 비정상이라 이번 cycle에서 제외합니다.`);
        continue;
      }

      if (isBurstCandidate && totalActivityCount >= SINGLE_SIGHT_TOTAL_ACTIVITY_THRESHOLD) {
        this.log(
          `ℹ️ ${groupedEntry.uid} 스킵 - 글댓총합 ${totalActivityCount}라 burst 기준 ${SINGLE_SIGHT_TOTAL_ACTIVITY_THRESHOLD} 미만 조건 불충족`,
        );
        continue;
      }

      if (!isBurstCandidate && totalActivityCount >= SINGLE_SIGHT_TOTAL_ACTIVITY_THRESHOLD) {
        this.log(
          `ℹ️ ${groupedEntry.uid} 스킵 - 글댓총합 ${totalActivityCount}라 단일발견 기준 ${SINGLE_SIGHT_TOTAL_ACTIVITY_THRESHOLD} 미만 조건 불충족`,
        );
        continue;
      }

      gallogCandidateCount += 1;
      let gallogPrivacy;
      try {
        gallogPrivacy = await this.fetchUidGallogPrivacy(this.config, groupedEntry.uid);
      } catch (error) {
        gallogFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 갤로그 비공개 확인 실패 - ${error.message}`);
        continue;
      }

      if (gallogPrivacy?.success !== true) {
        gallogFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 갤로그 비공개 확인 실패 - ${gallogPrivacy?.message || '응답 형식 오류'}`);
        continue;
      }

      gallogSuccessCount += 1;
      if (isBurstCandidate) {
        if (gallogPrivacy.fullyPrivate !== true) {
          this.log(`ℹ️ ${groupedEntry.uid} 스킵 - 갤로그 필터 미달 (${buildGallogPrivacySummary(gallogPrivacy)})`);
          continue;
        }

        const targetPosts = createUidBanTargetPosts(groupedEntry.rows);
        if (targetPosts.length === 0) {
          this.log(`ℹ️ ${groupedEntry.uid} 스킵 - page1 대상 글번호를 만들지 못함`);
          continue;
        }

        this.lastTriggeredUid = groupedEntry.uid;
        this.lastTriggeredPostCount = targetPosts.length;
        this.lastBurstRecentCount = recentRows.length;
        this.totalTriggeredUidCount += 1;
        this.log(
          `🚨 ${groupedEntry.uid} page1 5분 텍스트 burst ${recentRows.length}글 / 글비중 ${formatPostRatio(effectivePostRatio)}% / 총합 ${totalActivityCount} / 갤로그 게시글·댓글 비공개 -> page1 ${targetPosts.length}개 제재 시작`,
        );

        const result = await this.executeBan({
          feature: 'uidWarningAutoBan',
          config: this.config,
          posts: targetPosts,
          deleteEnabled: this.runtimeDeleteEnabled,
          onDeleteLimitFallbackSuccess: (fallbackResult) => {
            this.log(`🔁 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 같은 run을 이어갑니다.`);
          },
          onDeleteLimitBanOnlyActivated: (message) => {
            this.activateDeleteLimitBanOnly(message);
          },
        });

        this.totalBannedPostCount += result.successNos.length;
        this.totalFailedPostCount += result.failedNos.length;
        this.deleteLimitFallbackCount += result.deleteLimitFallbackCount;
        if (result.banOnlyFallbackUsed) {
          this.banOnlyFallbackCount += 1;
        }
        this.runtimeDeleteEnabled = result.finalDeleteEnabled;

        if (result.successNos.length > 0) {
          this.log(`⛔ ${groupedEntry.uid} page1 글 ${result.successNos.length}개 차단${result.finalDeleteEnabled ? '/삭제' : ''} 완료`);
        }

        if (result.banOnlyRetrySuccessCount > 0) {
          this.log(`🧯 삭제 한도 초과로 ${groupedEntry.uid} 글 ${result.banOnlyRetrySuccessCount}개는 차단만 수행`);
        }

        if (result.failedNos.length > 0) {
          this.log(`⚠️ ${groupedEntry.uid} 제재 실패 ${result.failedNos.length}개 - ${result.failedNos.join(', ')}`);
        }

        const success = result.failedNos.length === 0 && result.successNos.length > 0;
        this.recentUidActions[actionKey] = createRecentUidActionEntry({
          newestPostNo,
          success,
          nowIso: new Date().toISOString(),
        });
        await this.saveState();
        continue;
      }

      if (gallogPrivacy.fullyPrivate !== true) {
        this.log(`ℹ️ ${groupedEntry.uid} 스킵 - 단일발견 갤로그 필터 미달 (${buildGallogPrivacySummary(gallogPrivacy)})`);
        continue;
      }

      guestbookCandidateCount += 1;
      let guestbookState;
      try {
        guestbookState = await this.fetchUidGallogGuestbookState(this.config, groupedEntry.uid);
      } catch (error) {
        guestbookFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 방명록 잠금 확인 실패 - ${error.message}`);
        continue;
      }

      if (guestbookState?.success !== true) {
        guestbookFailureCount += 1;
        this.log(`⚠️ ${groupedEntry.uid} 방명록 잠금 확인 실패 - ${guestbookState?.message || '응답 형식 오류'}`);
        continue;
      }

      guestbookSuccessCount += 1;
      if (guestbookState.guestbookLocked !== true) {
        this.log(
          `ℹ️ ${groupedEntry.uid} 스킵 - 단일발견 갤로그 필터 미달 (${buildGallogPrivacySummary(gallogPrivacy)} / ${buildGuestbookStateSummary(guestbookState)})`,
        );
        continue;
      }

      const targetPosts = createUidBanTargetPosts(groupedEntry.rows);
      if (targetPosts.length === 0) {
        this.log(`ℹ️ ${groupedEntry.uid} 스킵 - page1 대상 글번호를 만들지 못함`);
        continue;
      }

      this.lastSingleSightTriggeredUid = groupedEntry.uid;
      this.lastSingleSightTriggeredPostCount = targetPosts.length;
      this.totalSingleSightTriggeredUidCount += 1;
      this.log(
        `🚨 ${groupedEntry.uid} 단일발견 깡계 fast-path / 글비중 ${formatPostRatio(effectivePostRatio)}% / 총합 ${totalActivityCount} / 갤로그 게시글·댓글 비공개 + 방명록 잠금 -> page1 ${targetPosts.length}개 제재 시작`,
      );

      const result = await this.executeBan({
        feature: 'uidWarningAutoBan',
        config: this.config,
        posts: targetPosts,
        deleteEnabled: this.runtimeDeleteEnabled,
        onDeleteLimitFallbackSuccess: (fallbackResult) => {
          this.log(`🔁 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 같은 run을 이어갑니다.`);
        },
        onDeleteLimitBanOnlyActivated: (message) => {
          this.activateDeleteLimitBanOnly(message);
        },
      });

      this.totalSingleSightBannedPostCount += result.successNos.length;
      this.totalBannedPostCount += result.successNos.length;
      this.totalFailedPostCount += result.failedNos.length;
      this.deleteLimitFallbackCount += result.deleteLimitFallbackCount;
      if (result.banOnlyFallbackUsed) {
        this.banOnlyFallbackCount += 1;
      }
      this.runtimeDeleteEnabled = result.finalDeleteEnabled;

      if (result.successNos.length > 0) {
        this.log(`⛔ ${groupedEntry.uid} 단일발견 깡계 글 ${result.successNos.length}개 차단${result.finalDeleteEnabled ? '/삭제' : ''} 완료`);
      }

      if (result.banOnlyRetrySuccessCount > 0) {
        this.log(`🧯 삭제 한도 초과로 ${groupedEntry.uid} 단일발견 글 ${result.banOnlyRetrySuccessCount}개는 차단만 수행`);
      }

      if (result.failedNos.length > 0) {
        this.log(`⚠️ ${groupedEntry.uid} 단일발견 깡계 제재 실패 ${result.failedNos.length}개 - ${result.failedNos.join(', ')}`);
      }

      const success = result.failedNos.length === 0 && result.successNos.length > 0;
      this.recentUidActions[actionKey] = createRecentUidActionEntry({
        newestPostNo,
        success,
        nowIso: new Date().toISOString(),
      });
      await this.saveState();
    }

    if (statsCandidateCount > 0 && statsSuccessCount === 0 && statsFailureCount > 0) {
      this.lastError = '식별코드 활동 통계 조회에 실패해 이번 사이클을 건너뛰었습니다.';
    } else if (gallogCandidateCount > 0 && gallogSuccessCount === 0 && gallogFailureCount > 0) {
      this.lastError = '갤로그 공개/비공개 확인에 실패해 이번 사이클을 건너뛰었습니다.';
    } else if (guestbookCandidateCount > 0 && guestbookSuccessCount === 0 && guestbookFailureCount > 0) {
      this.lastError = '방명록 잠금 확인에 실패해 단일발견 깡계 판정을 건너뛰었습니다.';
    }

    pruneRecentUidActions(this.recentUidActions);
    pruneRecentImmediatePostActions(this.recentImmediatePostActions);
    pruneRecentAttackTitlePostActions(this.recentAttackTitlePostActions);
    pruneRecentAttackCommentActions(this.recentAttackCommentActions);
  }

  async handleAttackCommentClusterRows(rows = [], html = '', nowMs = Date.now()) {
    const normalizedRows = Array.isArray(rows) ? rows : [];
    this.pruneCommentSnapshotsToPageRows(normalizedRows);

    if (!getAttackCommentClusterEnabled(this.config)) {
      return;
    }

    if (!this.isRunning || this.isCommentDefenseRunning()) {
      return;
    }

    const fetchCandidates = this.selectAttackCommentFetchCandidates(normalizedRows, nowMs);
    if (fetchCandidates.length > 0) {
      const esno = this.extractEsno(html);
      if (!esno) {
        this.log('⚠️ 실제공격 댓글 군집 스킵 - e_s_n_o 토큰 추출 실패');
      } else {
        await this.refreshAttackCommentSnapshots(fetchCandidates, esno, nowMs);
      }
    }

    if (!this.isRunning || this.isCommentDefenseRunning()) {
      return;
    }

    const snapshotEntries = Object.values(this.commentSnapshotByPostNo);
    const clusters = this.detectAttackCommentClusters(snapshotEntries, {
      minCount: getAttackCommentClusterMinCount(this.config),
      minNormalizedLength: getAttackCommentMinNormalizedLength(this.config),
      recentActions: this.recentAttackCommentActions,
    });
    if (clusters.length <= 0) {
      return;
    }

    const matchedRepresentatives = [];
    for (const cluster of clusters) {
      if (!this.isRunning || this.isCommentDefenseRunning()) {
        break;
      }

      const deletedCount = await this.deleteAttackCommentCluster(cluster);
      if (deletedCount <= 0) {
        continue;
      }

      const representative = String(cluster?.representative || cluster?.normalizedMemo || '댓글군집').trim();
      matchedRepresentatives.push(representative);
      this.lastAttackCommentClusterRepresentative = summarizeMatchedTitles(matchedRepresentatives);
    }
  }

  pruneCommentSnapshotsToPageRows(rows = []) {
    const pagePostNos = new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => String(Math.max(0, Number(row?.no) || 0)))
        .filter((postNo) => postNo !== '0'),
    );

    for (const postNo of Object.keys(this.commentSnapshotByPostNo || {})) {
      if (!pagePostNos.has(String(postNo))) {
        delete this.commentSnapshotByPostNo[postNo];
      }
    }
  }

  selectAttackCommentFetchCandidates(rows = [], nowMs = Date.now()) {
    const candidates = [];
    const seenPostNos = new Set();
    const ttlMs = getAttackCommentSnapshotTtlMs(this.config);

    for (const row of Array.isArray(rows) ? rows : []) {
      const postNo = Math.max(0, Number(row?.no) || 0);
      if (postNo <= 0 || seenPostNos.has(postNo)) {
        continue;
      }

      seenPostNos.add(postNo);
      const commentCount = Math.max(0, Number(row?.commentCount) || 0);
      const snapshot = this.commentSnapshotByPostNo[String(postNo)];
      const hasDirectRecentSuccessInSnapshot = snapshotHasRecentAttackCommentSuccess(
        snapshot,
        this.recentAttackCommentActions,
      );
      const hasRecentSuccessInSnapshot =
        hasDirectRecentSuccessInSnapshot
        || snapshotSharesRecentAttackCommentSuccess(snapshot, this.recentAttackCommentActions);
      const lastCheckedAtMs = parseTimestamp(snapshot?.lastCheckedAt);
      const isSnapshotExpired = lastCheckedAtMs <= 0 || nowMs - lastCheckedAtMs >= ttlMs;

      if (commentCount <= 0) {
        if (hasDirectRecentSuccessInSnapshot) {
          continue;
        }

        delete this.commentSnapshotByPostNo[String(postNo)];
        continue;
      }

      if (!snapshot) {
        candidates.push(row);
        continue;
      }

      if (Math.max(0, Number(snapshot.commentCount) || 0) !== commentCount) {
        if (hasRecentSuccessInSnapshot) {
          continue;
        }

        candidates.push(row);
        continue;
      }

      if (hasRecentSuccessInSnapshot) {
        continue;
      }

      if (isSnapshotExpired) {
        candidates.push(row);
      }
    }

    return candidates;
  }

  async refreshAttackCommentSnapshots(rows = [], esno = '', nowMs = Date.now()) {
    const candidates = Array.isArray(rows) ? rows : [];
    if (candidates.length <= 0) {
      return;
    }

    const fetchedAt = new Date(nowMs).toISOString();
    await mapWithConcurrencyWorkerPool(
      candidates,
      getAttackCommentFetchConcurrency(this.config),
      getAttackCommentFetchRequestDelayMs(this.config),
      async (row) => {
        if (!this.isRunning || this.isCommentDefenseRunning()) {
          return;
        }

        const postNo = Math.max(0, Number(row?.no) || 0);
        if (postNo <= 0) {
          return;
        }

        try {
          const result = await runWithTimeoutSignal(
            getAttackCommentFetchTimeoutMs(this.config),
            (signal) => this.fetchRecentComments(this.config, postNo, esno, 1, { signal }),
            '실제공격 댓글 군집 조회 시간 초과',
          );
          const fluidComments = this.filterFluidComments(Array.isArray(result?.comments) ? result.comments : []);
          this.commentSnapshotByPostNo[String(postNo)] = {
            postNo,
            commentCount: Math.max(0, Number(row?.commentCount) || 0),
            fetchedTotalCount: Math.max(0, Number(result?.totalCnt) || 0),
            lastCheckedAt: fetchedAt,
            comments: createAttackCommentSnapshotComments(fluidComments, {
              postNo,
              minNormalizedLength: getAttackCommentMinNormalizedLength(this.config),
            }),
          };
        } catch (error) {
          const commentCount = Math.max(0, Number(row?.commentCount) || 0);
          this.log(`⚠️ 실제공격 댓글 군집 조회 실패 - #${postNo} / 목록 댓글 ${commentCount}개: ${error.message}`);
        }
      },
      () => this.isRunning && !this.isCommentDefenseRunning(),
      this.delayFn,
    );
  }

  async deleteAttackCommentCluster(cluster = {}) {
    const deletePlanByPostNo = buildAttackCommentDeletePlanByPostNo(cluster);
    if (deletePlanByPostNo.size <= 0) {
      return 0;
    }

    const representative = String(cluster?.representative || cluster?.normalizedMemo || '댓글군집').trim();
    const totalClusterCommentCount = Math.max(
      Array.isArray(cluster?.allComments) ? cluster.allComments.length : 0,
      Array.isArray(cluster?.comments) ? cluster.comments.length : 0,
    );
    const targetCommentCount = Array.isArray(cluster?.comments) ? cluster.comments.length : 0;
    this.lastAttackCommentClusterCount += 1;
    this.lastAttackCommentClusterPostCount += deletePlanByPostNo.size;
    this.log(
      `🚨 실제공격 댓글 군집 "${representative}" 유동댓글 ${totalClusterCommentCount}개 / 차단/삭제 대상 ${targetCommentCount}개 / ${deletePlanByPostNo.size}글 -> 댓글 IP차단+삭제 시작`,
    );

    let deletedCount = 0;
    let successPostCount = 0;
    let failedDeleteCount = 0;
    const succeededComments = [];
    const actionAt = new Date().toISOString();
    for (const [postNo, commentNos] of deletePlanByPostNo.entries()) {
      if (!this.isRunning || this.isCommentDefenseRunning()) {
        break;
      }

      const numericPostNo = Math.max(0, Number(postNo) || 0);
      if (numericPostNo <= 0 || commentNos.length <= 0) {
        continue;
      }

      let result;
      try {
        result = await runWithTimeoutSignal(
          getAttackCommentDeleteTimeoutMs(this.config),
          (signal) => this.deleteAndBanComments(
            buildAttackCommentBanConfig(this.config),
            numericPostNo,
            commentNos,
            { signal },
          ),
          '실제공격 댓글 군집 차단/삭제 시간 초과',
        );
      } catch (error) {
        failedDeleteCount += commentNos.length;
        this.log(`⚠️ 실제공격 댓글 군집 차단/삭제 실패 - #${numericPostNo} / 대상 댓글 ${commentNos.length}개: ${error.message}`);
        await this.saveState();
        continue;
      }

      if (!result.success) {
        failedDeleteCount += commentNos.length;
        this.log(`⚠️ 실제공격 댓글 군집 차단/삭제 실패 - #${numericPostNo} / 대상 댓글 ${commentNos.length}개: ${result.message}`);
      } else {
        successPostCount += 1;
        deletedCount += commentNos.length;
        for (const commentNo of commentNos) {
          succeededComments.push({ postNo: numericPostNo, no: commentNo });
          this.recentAttackCommentActions[buildAttackCommentActionKey(numericPostNo, commentNo)] =
            createRecentAttackCommentActionEntry({
              postNo: numericPostNo,
              commentNo,
              normalizedMemo: representative,
              success: true,
              nowIso: actionAt,
            });
        }
      }

      await this.saveState();
      if (this.isRunning && !this.isCommentDefenseRunning() && getAttackCommentDeleteDelayMs(this.config) > 0) {
        await this.delayFn(getAttackCommentDeleteDelayMs(this.config));
      }
    }

    if (deletedCount > 0) {
      this.removeAttackCommentSnapshotComments(succeededComments);
      this.lastAttackCommentClusterDeleteCount += deletedCount;
      this.totalAttackCommentClusterDeleteCount += deletedCount;
      this.log(`🗑️⛔ 실제공격 댓글 군집 "${representative}" ${successPostCount}글 / 댓글 ${deletedCount}개 IP차단+삭제 요청 완료`);
      await this.saveState();
    }

    return deletedCount;
  }

  removeAttackCommentSnapshotComments(comments = []) {
    const groupedCommentNos = new Map();
    for (const comment of Array.isArray(comments) ? comments : []) {
      const postNo = Math.max(0, Number(comment?.postNo) || 0);
      const commentNo = String(comment?.no || '').trim();
      if (postNo <= 0 || !commentNo) {
        continue;
      }

      const postKey = String(postNo);
      const existing = groupedCommentNos.get(postKey);
      if (existing) {
        existing.push(commentNo);
        continue;
      }

      groupedCommentNos.set(postKey, [commentNo]);
    }

    for (const [postNo, commentNos] of groupedCommentNos.entries()) {
      this.removeAttackCommentNosFromSnapshot(postNo, commentNos);
    }
  }

  removeAttackCommentNosFromSnapshot(postNo, commentNos = []) {
    const postKey = String(Math.max(0, Number(postNo) || 0));
    const snapshot = this.commentSnapshotByPostNo[postKey];
    if (!snapshot) {
      return;
    }

    const removedNos = new Set(
      (Array.isArray(commentNos) ? commentNos : [])
        .map((commentNo) => String(commentNo || '').trim())
        .filter(Boolean),
    );
    snapshot.comments = (Array.isArray(snapshot.comments) ? snapshot.comments : [])
      .filter((comment) => !removedNos.has(String(comment?.no || '').trim()));
  }

  async handleLinkbaitBodyLinkRows(rows = [], nowMs = Date.now()) {
    const processedLinkbaitBodyLinkPostNos = new Set();
    if (!getLinkbaitBodyLinkEnabled(this.config)) {
      return processedLinkbaitBodyLinkPostNos;
    }

    const candidates = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const postNo = Math.max(0, Number(row?.no) || 0);
      if (!isLinkbaitBodyLinkTitleCandidate(row, this.config)) {
        continue;
      }

      this.lastLinkbaitBodyLinkCandidateCount += 1;
      const actionKey = buildLinkbaitBodyLinkActionKey(postNo);
      if (
        shouldSkipRecentLinkbaitBodyLinkAction(
          this.recentLinkbaitBodyLinkActions[actionKey],
          nowMs,
          getRetryCooldownMs(this.config),
        )
      ) {
        processedLinkbaitBodyLinkPostNos.add(postNo);
        this.log(`ℹ️ 이거진짜 링크본문 스킵 - #${postNo}는 최근 처리 이력이 있어 건너뜀`);
        continue;
      }

      candidates.push(row);
    }

    if (candidates.length <= 0) {
      return processedLinkbaitBodyLinkPostNos;
    }

    this.log(`🔎 이거진짜 링크본문 후보 ${candidates.length}개 확인 시작`);
    const checkedResults = await mapWithConcurrencyWorkerPool(
      candidates,
      getLinkbaitBodyLinkFetchConcurrency(this.config),
      getLinkbaitBodyLinkFetchRequestDelayMs(this.config),
      async (row) => {
        const postNo = Math.max(0, Number(row?.no) || 0);
        try {
          const viewHtml = await runWithTimeoutSignal(
            getLinkbaitBodyLinkFetchTimeoutMs(this.config),
            (signal) => this.fetchPostViewHtml(this.config, postNo, { signal }),
            '이거진짜 링크본문 조회 시간 초과',
          );

          return {
            row,
            postNo,
            matched: hasUserHttpsLinkInPostBody(viewHtml),
          };
        } catch (error) {
          this.log(`⚠️ 이거진짜 링크본문 조회 실패 - #${postNo}: ${error.message}`);
          return {
            row,
            postNo,
            matched: false,
            failed: true,
          };
        }
      },
      () => this.isRunning,
      this.delayFn,
    );

    this.lastLinkbaitBodyLinkCheckedCount = candidates.length;
    const matchedRows = [];
    for (const result of checkedResults) {
      if (!result || result.failed) {
        continue;
      }

      if (result.matched === true) {
        matchedRows.push(result.row);
        continue;
      }

      if (result.postNo > 0) {
        this.log(`ℹ️ 이거진짜 링크본문 스킵 - #${result.postNo} 본문 사용자 https 링크 없음`);
      }
    }
    this.lastLinkbaitBodyLinkMatchedCount = matchedRows.length;

    if (!this.isRunning || matchedRows.length <= 0) {
      return processedLinkbaitBodyLinkPostNos;
    }

    const targetPosts = createImmediateTitleBanTargetPosts(matchedRows);
    if (targetPosts.length <= 0) {
      this.log('ℹ️ 이거진짜 링크본문 스킵 - page1 대상 글번호를 만들지 못함');
      return processedLinkbaitBodyLinkPostNos;
    }

    this.lastLinkbaitBodyLinkRepresentative = summarizeMatchedTitles(
      matchedRows.map((row) => row?.title || row?.subject || ''),
    );
    this.lastLinkbaitBodyLinkActionCount += targetPosts.length;
    this.log(`🚨 이거진짜 링크본문 "${this.lastLinkbaitBodyLinkRepresentative || '제목'}" ${targetPosts.length}개 -> 차단/삭제 시작`);

    const result = await this.executeBan({
      feature: 'uidWarningAutoBan',
      config: {
        ...this.config,
        avoidHour: ATTACK_TITLE_BAN_HOUR,
        avoidReason: '0',
        avoidReasonText: ATTACK_TITLE_BAN_REASON_TEXT,
        delChk: true,
        avoidTypeChk: true,
      },
      posts: targetPosts,
      deleteEnabled: this.runtimeDeleteEnabled,
      onDeleteLimitFallbackSuccess: (fallbackResult) => {
        this.log(`🔁 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 같은 run을 이어갑니다.`);
      },
      onDeleteLimitBanOnlyActivated: (message) => {
        this.activateDeleteLimitBanOnly(message);
      },
    });

    this.totalLinkbaitBodyLinkPostCount += result.successNos.length;
    this.totalBannedPostCount += result.successNos.length;
    this.totalFailedPostCount += result.failedNos.length;
    this.deleteLimitFallbackCount += result.deleteLimitFallbackCount;
    if (result.banOnlyFallbackUsed) {
      this.banOnlyFallbackCount += 1;
    }
    this.runtimeDeleteEnabled = result.finalDeleteEnabled;

    if (result.successNos.length > 0) {
      this.log(`⛔ 이거진짜 링크본문 글 ${result.successNos.length}개 차단${result.finalDeleteEnabled ? '/삭제' : ''} 완료`);
    }

    if (result.banOnlyRetrySuccessCount > 0) {
      this.log(`🧯 이거진짜 링크본문 글 ${result.banOnlyRetrySuccessCount}개는 차단만 수행`);
    }

    if (result.failedNos.length > 0) {
      this.log(`⚠️ 이거진짜 링크본문 제재 실패 ${result.failedNos.length}개 - ${result.failedNos.join(', ')}`);
    }

    const actionAt = new Date().toISOString();
    const successNos = new Set(result.successNos.map((postNo) => String(postNo)));
    for (const targetPost of targetPosts) {
      const postNo = Number(targetPost.no) || 0;
      if (postNo > 0) {
        processedLinkbaitBodyLinkPostNos.add(postNo);
      }
      this.recentLinkbaitBodyLinkActions[buildLinkbaitBodyLinkActionKey(targetPost.no)] =
        createRecentLinkbaitBodyLinkActionEntry({
          success: successNos.has(String(targetPost.no)),
          nowIso: actionAt,
        });
    }

    await this.saveState();
    return processedLinkbaitBodyLinkPostNos;
  }

  async handleAttackTitleClusterRows(rows = [], nowMs = Date.now()) {
    const processedAttackTitlePostNos = new Set();
    const patternCorpus = await this.getAttackTitlePatternCorpus();
    let clusters = [];
    try {
      clusters = this.detectAttackTitleClusters(rows, patternCorpus);
    } catch (error) {
      this.log(`⚠️ 실제공격 제목 클러스터 판정 실패 - ${error.message}`);
      return processedAttackTitlePostNos;
    }

    const matchedRepresentatives = [];
    for (const cluster of clusters) {
      if (!this.isRunning) {
        break;
      }

      const targetRows = [];
      for (const row of Array.isArray(cluster?.rows) ? cluster.rows : []) {
        const postNo = Number(row?.no) || 0;
        if (postNo <= 0) {
          continue;
        }

        processedAttackTitlePostNos.add(postNo);

        const actionKey = buildAttackTitlePostActionKey(postNo);
        if (
          shouldSkipRecentAttackTitlePostAction(
            this.recentAttackTitlePostActions[actionKey],
            nowMs,
            getRetryCooldownMs(this.config),
          )
        ) {
          this.log(`ℹ️ 실제공격 제목 클러스터 스킵 - #${postNo}는 최근 처리 이력이 있어 건너뜀`);
          continue;
        }

        targetRows.push(row);
      }

      if (targetRows.length <= 0) {
        continue;
      }

      const targetPosts = createImmediateTitleBanTargetPosts(targetRows);
      if (targetPosts.length <= 0) {
        this.log('ℹ️ 실제공격 제목 클러스터 스킵 - page1 대상 글번호를 만들지 못함');
        continue;
      }

      const representative = String(cluster?.representative || cluster?.matchedPattern?.normalizedTitle || '패턴').trim();
      matchedRepresentatives.push(representative);
      this.lastAttackTitleClusterRepresentative = summarizeMatchedTitles(matchedRepresentatives);
      this.lastAttackTitleClusterCount += 1;
      this.lastAttackTitleClusterPostCount += targetPosts.length;
      this.log(
        `🚨 실제공격 제목 클러스터 "${representative}" ${Number(cluster?.rows?.length) || targetPosts.length}개 군집 / 제재 대상 ${targetPosts.length}개 / 유사도 ${formatSimilarityPercent(cluster?.averageSimilarity)}% -> 제재 시작`,
      );

      const result = await this.executeBan({
        feature: 'uidWarningAutoBan',
        config: {
          ...this.config,
          avoidHour: ATTACK_TITLE_BAN_HOUR,
          avoidReason: '0',
          avoidReasonText: ATTACK_TITLE_BAN_REASON_TEXT,
          delChk: true,
          avoidTypeChk: true,
        },
        posts: targetPosts,
        deleteEnabled: this.runtimeDeleteEnabled,
        onDeleteLimitFallbackSuccess: (fallbackResult) => {
          this.log(`🔁 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 같은 run을 이어갑니다.`);
        },
        onDeleteLimitBanOnlyActivated: (message) => {
          this.activateDeleteLimitBanOnly(message);
        },
      });

      this.totalAttackTitleClusterPostCount += result.successNos.length;
      this.totalBannedPostCount += result.successNos.length;
      this.totalFailedPostCount += result.failedNos.length;
      this.deleteLimitFallbackCount += result.deleteLimitFallbackCount;
      if (result.banOnlyFallbackUsed) {
        this.banOnlyFallbackCount += 1;
      }
      this.runtimeDeleteEnabled = result.finalDeleteEnabled;

      if (result.successNos.length > 0) {
        this.log(`⛔ 실제공격 제목 클러스터 글 ${result.successNos.length}개 차단${result.finalDeleteEnabled ? '/삭제' : ''} 완료`);
      }

      if (result.banOnlyRetrySuccessCount > 0) {
        this.log(`🧯 실제공격 제목 클러스터 글 ${result.banOnlyRetrySuccessCount}개는 차단만 수행`);
      }

      if (result.failedNos.length > 0) {
        this.log(`⚠️ 실제공격 제목 클러스터 제재 실패 ${result.failedNos.length}개 - ${result.failedNos.join(', ')}`);
      }

      const actionAt = new Date().toISOString();
      const successNos = new Set(result.successNos.map((postNo) => String(postNo)));
      for (const targetPost of targetPosts) {
        this.recentAttackTitlePostActions[buildAttackTitlePostActionKey(targetPost.no)] =
          createRecentAttackTitlePostActionEntry({
            success: successNos.has(String(targetPost.no)),
            nowIso: actionAt,
          });
      }

      await this.saveState();
    }

    this.lastAttackTitleClusterRepresentative = summarizeMatchedTitles(matchedRepresentatives);
    return processedAttackTitlePostNos;
  }

  async getAttackTitlePatternCorpus() {
    if (!this.attackTitlePatternCorpusPromise) {
      this.attackTitlePatternCorpusPromise = Promise.resolve().then(() => this.loadAttackTitlePatternCorpus());
    }

    try {
      const corpus = await this.attackTitlePatternCorpusPromise;
      this.attackTitlePatternLoadError = '';
      this.lastAttackTitlePatternLoadErrorLog = '';
      return corpus || EMPTY_ATTACK_TITLE_PATTERN_CORPUS;
    } catch (error) {
      const message = String(error?.message || '알 수 없는 오류').trim() || '알 수 없는 오류';
      this.attackTitlePatternLoadError = message;
      this.attackTitlePatternCorpusPromise = null;
      if (this.lastAttackTitlePatternLoadErrorLog !== message) {
        this.log(`⚠️ 실제공격 제목 패턴 로딩 실패 - ${message}, 이번 사이클은 page1 자체 군집만 봅니다.`);
        this.lastAttackTitlePatternLoadErrorLog = message;
      }
      return EMPTY_ATTACK_TITLE_PATTERN_CORPUS;
    }
  }

  async handleImmediateTitleBanRows(rows = [], nowMs = Date.now()) {
    const processedImmediatePostNos = new Set();
    const normalizedRules = normalizeImmediateTitleBanRules(this.config.immediateTitleBanRules);
    if (normalizedRules.length <= 0) {
      return processedImmediatePostNos;
    }

    const matchedGroups = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
      const postNo = Number(row?.no) || 0;
      if (postNo <= 0) {
        continue;
      }

      const normalizedTitle = normalizeImmediateTitleValue(row?.title || row?.subject || '');
      const matchedRule = findImmediateTitleMatchedRule(normalizedRules, normalizedTitle);
      if (!matchedRule) {
        continue;
      }

      // recent-skip이어도 같은 글이 UID 경로로 다시 들어가 중복 처리되지 않게 먼저 표시한다.
      processedImmediatePostNos.add(postNo);

      const actionKey = buildImmediatePostActionKey(postNo);
      if (
        shouldSkipRecentImmediatePostAction(
          this.recentImmediatePostActions[actionKey],
          nowMs,
          getRetryCooldownMs(this.config),
        )
      ) {
        this.log(`ℹ️ 제목 직차단 스킵 - #${postNo} ${getImmediateTitleRuleLogLabel(matchedRule)}는 최근 처리 이력이 있어 건너뜀`);
        continue;
      }

      const matchedRuleKey = String(matchedRule.ruleKey || matchedRule.normalizedTitle || '').trim();
      const existingGroup = matchedGroups.get(matchedRuleKey);
      if (existingGroup) {
        existingGroup.rows.push(row);
        continue;
      }

      matchedGroups.set(matchedRuleKey, {
        rule: matchedRule,
        rows: [row],
      });
    }

    const matchedTitles = [];
    for (const matchedGroup of matchedGroups.values()) {
      if (!this.isRunning) {
        break;
      }

      const targetPosts = createImmediateTitleBanTargetPosts(matchedGroup.rows);
      if (targetPosts.length <= 0) {
        this.log(`ℹ️ 제목 직차단 스킵 - ${matchedGroup.rule.rawTitle}는 page1 대상 글번호를 만들지 못함`);
        continue;
      }

      matchedTitles.push(matchedGroup.rule.rawTitle);
      this.lastImmediateTitleBanCount += targetPosts.length;
      this.log(`🚨 제목 직차단 ${getImmediateTitleRuleLogLabel(matchedGroup.rule)} 매치 -> page1 ${targetPosts.length}개 제재 시작`);

      const result = await this.executeBan({
        feature: 'uidWarningAutoBan',
        config: this.config,
        posts: targetPosts,
        deleteEnabled: this.runtimeDeleteEnabled,
        onDeleteLimitFallbackSuccess: (fallbackResult) => {
          this.log(`🔁 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 같은 run을 이어갑니다.`);
        },
        onDeleteLimitBanOnlyActivated: (message) => {
          this.activateDeleteLimitBanOnly(message);
        },
      });

      this.totalImmediateTitleBanPostCount += result.successNos.length;
      this.totalBannedPostCount += result.successNos.length;
      this.totalFailedPostCount += result.failedNos.length;
      this.deleteLimitFallbackCount += result.deleteLimitFallbackCount;
      if (result.banOnlyFallbackUsed) {
        this.banOnlyFallbackCount += 1;
      }
      this.runtimeDeleteEnabled = result.finalDeleteEnabled;

      if (result.successNos.length > 0) {
        this.log(`⛔ 제목 직차단 ${getImmediateTitleRuleLogLabel(matchedGroup.rule)} 글 ${result.successNos.length}개 차단${result.finalDeleteEnabled ? '/삭제' : ''} 완료`);
      }

      if (result.banOnlyRetrySuccessCount > 0) {
        this.log(`🧯 제목 직차단 ${getImmediateTitleRuleLogLabel(matchedGroup.rule)} 글 ${result.banOnlyRetrySuccessCount}개는 차단만 수행`);
      }

      if (result.failedNos.length > 0) {
        this.log(`⚠️ 제목 직차단 ${getImmediateTitleRuleLogLabel(matchedGroup.rule)} 제재 실패 ${result.failedNos.length}개 - ${result.failedNos.join(', ')}`);
      }

      const actionAt = new Date().toISOString();
      const successNos = new Set(result.successNos.map((postNo) => String(postNo)));
      for (const targetPost of targetPosts) {
        this.recentImmediatePostActions[buildImmediatePostActionKey(targetPost.no)] =
          createRecentImmediatePostActionEntry({
            success: successNos.has(String(targetPost.no)),
            nowIso: actionAt,
          });
      }

      await this.saveState();
    }

    this.lastImmediateTitleBanMatchedTitle = summarizeMatchedTitles(matchedTitles);
    return processedImmediatePostNos;
  }

  activateDeleteLimitBanOnly(message = '') {
    const trimmedMessage = String(message || '').trim();
    const switched = this.runtimeDeleteEnabled;
    this.runtimeDeleteEnabled = false;
    this.runtimeDeleteModeReason = DELETE_MODE_REASON.DELETE_LIMIT;
    this.lastDeleteLimitExceededAt = new Date().toISOString();
    this.lastDeleteLimitMessage = trimmedMessage;

    if (switched) {
      this.log('⚠️ 삭제 한도 초과 감지 - 토글 OFF할 때까지 분탕자동차단은 차단만 유지합니다.');
      if (trimmedMessage) {
        this.log(`⚠️ 삭제 한도 상세: ${trimmedMessage}`);
      }
    }
  }

  activateMonitorAttackBanOnly() {
    if (!this.runtimeDeleteEnabled) {
      return false;
    }

    this.runtimeDeleteEnabled = false;
    this.runtimeDeleteModeReason = DELETE_MODE_REASON.MONITOR_ATTACK;
    this.lastDeleteLimitExceededAt = '';
    this.lastDeleteLimitMessage = '';
    this.log('⚠️ 게시물 자동화 공격 감지 - 공격 종료까지 분탕자동차단은 차단만 유지합니다.');
    return true;
  }

  restoreRuntimeDeleteModeFromConfig() {
    const nextDeleteEnabled = Boolean(this.config.delChk);
    const changed = this.runtimeDeleteEnabled !== nextDeleteEnabled
      || this.runtimeDeleteModeReason !== DELETE_MODE_REASON.NORMAL
      || this.lastDeleteLimitExceededAt
      || this.lastDeleteLimitMessage;

    this.runtimeDeleteEnabled = nextDeleteEnabled;
    this.runtimeDeleteModeReason = DELETE_MODE_REASON.NORMAL;
    this.lastDeleteLimitExceededAt = '';
    this.lastDeleteLimitMessage = '';
    return changed;
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[UidWarningAutoBanScheduler] ${message}`);
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
          currentPage: this.currentPage,
          lastPollAt: this.lastPollAt,
          nextRunAt: this.nextRunAt,
          lastTriggeredUid: this.lastTriggeredUid,
          lastTriggeredPostCount: this.lastTriggeredPostCount,
          lastBurstRecentCount: this.lastBurstRecentCount,
          lastSingleSightTriggeredUid: this.lastSingleSightTriggeredUid,
          lastSingleSightTriggeredPostCount: this.lastSingleSightTriggeredPostCount,
          lastImmediateTitleBanCount: this.lastImmediateTitleBanCount,
          lastImmediateTitleBanMatchedTitle: this.lastImmediateTitleBanMatchedTitle,
          lastLinkbaitBodyLinkCandidateCount: this.lastLinkbaitBodyLinkCandidateCount,
          lastLinkbaitBodyLinkCheckedCount: this.lastLinkbaitBodyLinkCheckedCount,
          lastLinkbaitBodyLinkMatchedCount: this.lastLinkbaitBodyLinkMatchedCount,
          lastLinkbaitBodyLinkActionCount: this.lastLinkbaitBodyLinkActionCount,
          lastLinkbaitBodyLinkRepresentative: this.lastLinkbaitBodyLinkRepresentative,
          lastAttackTitleClusterCount: this.lastAttackTitleClusterCount,
          lastAttackTitleClusterPostCount: this.lastAttackTitleClusterPostCount,
          lastAttackTitleClusterRepresentative: this.lastAttackTitleClusterRepresentative,
          lastAttackCommentClusterCount: this.lastAttackCommentClusterCount,
          lastAttackCommentClusterDeleteCount: this.lastAttackCommentClusterDeleteCount,
          lastAttackCommentClusterPostCount: this.lastAttackCommentClusterPostCount,
          lastAttackCommentClusterRepresentative: this.lastAttackCommentClusterRepresentative,
          lastPageRowCount: this.lastPageRowCount,
          lastPageUidCount: this.lastPageUidCount,
          totalTriggeredUidCount: this.totalTriggeredUidCount,
          totalSingleSightTriggeredUidCount: this.totalSingleSightTriggeredUidCount,
          totalImmediateTitleBanPostCount: this.totalImmediateTitleBanPostCount,
          totalLinkbaitBodyLinkPostCount: this.totalLinkbaitBodyLinkPostCount,
          totalAttackTitleClusterPostCount: this.totalAttackTitleClusterPostCount,
          totalAttackCommentClusterDeleteCount: this.totalAttackCommentClusterDeleteCount,
          totalSingleSightBannedPostCount: this.totalSingleSightBannedPostCount,
          totalBannedPostCount: this.totalBannedPostCount,
          totalFailedPostCount: this.totalFailedPostCount,
          deleteLimitFallbackCount: this.deleteLimitFallbackCount,
          banOnlyFallbackCount: this.banOnlyFallbackCount,
          lastError: this.lastError,
          cycleCount: this.cycleCount,
          runtimeDeleteEnabled: this.runtimeDeleteEnabled,
          runtimeDeleteModeReason: this.runtimeDeleteModeReason,
          lastDeleteLimitExceededAt: this.lastDeleteLimitExceededAt,
          lastDeleteLimitMessage: this.lastDeleteLimitMessage,
          recentUidActions: this.recentUidActions,
          recentImmediatePostActions: this.recentImmediatePostActions,
          recentLinkbaitBodyLinkActions: this.recentLinkbaitBodyLinkActions,
          recentAttackTitlePostActions: this.recentAttackTitlePostActions,
          recentAttackCommentActions: this.recentAttackCommentActions,
          commentSnapshotByPostNo: this.commentSnapshotByPostNo,
          attackTitlePatternLoadError: this.attackTitlePatternLoadError,
          logs: this.logs.slice(0, 50),
          config: buildPersistedConfig(this.config),
        },
      });
    } catch (error) {
      console.error('[UidWarningAutoBanScheduler] 상태 저장 실패:', error.message);
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
      this.currentPage = 1;
      this.lastPollAt = String(schedulerState.lastPollAt || '');
      this.nextRunAt = String(schedulerState.nextRunAt || '');
      this.lastTriggeredUid = String(schedulerState.lastTriggeredUid || '');
      this.lastTriggeredPostCount = Math.max(0, Number(schedulerState.lastTriggeredPostCount) || 0);
      this.lastBurstRecentCount = Math.max(0, Number(schedulerState.lastBurstRecentCount) || 0);
      this.lastSingleSightTriggeredUid = String(schedulerState.lastSingleSightTriggeredUid || '');
      this.lastSingleSightTriggeredPostCount = Math.max(0, Number(schedulerState.lastSingleSightTriggeredPostCount) || 0);
      this.lastImmediateTitleBanCount = Math.max(0, Number(schedulerState.lastImmediateTitleBanCount) || 0);
      this.lastImmediateTitleBanMatchedTitle = String(schedulerState.lastImmediateTitleBanMatchedTitle || '');
      this.lastLinkbaitBodyLinkCandidateCount = Math.max(0, Number(schedulerState.lastLinkbaitBodyLinkCandidateCount) || 0);
      this.lastLinkbaitBodyLinkCheckedCount = Math.max(0, Number(schedulerState.lastLinkbaitBodyLinkCheckedCount) || 0);
      this.lastLinkbaitBodyLinkMatchedCount = Math.max(0, Number(schedulerState.lastLinkbaitBodyLinkMatchedCount) || 0);
      this.lastLinkbaitBodyLinkActionCount = Math.max(0, Number(schedulerState.lastLinkbaitBodyLinkActionCount) || 0);
      this.lastLinkbaitBodyLinkRepresentative = String(schedulerState.lastLinkbaitBodyLinkRepresentative || '');
      this.lastAttackTitleClusterCount = Math.max(0, Number(schedulerState.lastAttackTitleClusterCount) || 0);
      this.lastAttackTitleClusterPostCount = Math.max(0, Number(schedulerState.lastAttackTitleClusterPostCount) || 0);
      this.lastAttackTitleClusterRepresentative = String(schedulerState.lastAttackTitleClusterRepresentative || '');
      this.lastAttackCommentClusterCount = Math.max(0, Number(schedulerState.lastAttackCommentClusterCount) || 0);
      this.lastAttackCommentClusterDeleteCount = Math.max(0, Number(schedulerState.lastAttackCommentClusterDeleteCount) || 0);
      this.lastAttackCommentClusterPostCount = Math.max(0, Number(schedulerState.lastAttackCommentClusterPostCount) || 0);
      this.lastAttackCommentClusterRepresentative = String(schedulerState.lastAttackCommentClusterRepresentative || '');
      this.lastPageRowCount = Math.max(0, Number(schedulerState.lastPageRowCount) || 0);
      this.lastPageUidCount = Math.max(0, Number(schedulerState.lastPageUidCount) || 0);
      this.totalTriggeredUidCount = Math.max(0, Number(schedulerState.totalTriggeredUidCount) || 0);
      this.totalSingleSightTriggeredUidCount = Math.max(0, Number(schedulerState.totalSingleSightTriggeredUidCount) || 0);
      this.totalImmediateTitleBanPostCount = Math.max(0, Number(schedulerState.totalImmediateTitleBanPostCount) || 0);
      this.totalLinkbaitBodyLinkPostCount = Math.max(0, Number(schedulerState.totalLinkbaitBodyLinkPostCount) || 0);
      this.totalAttackTitleClusterPostCount = Math.max(0, Number(schedulerState.totalAttackTitleClusterPostCount) || 0);
      this.totalAttackCommentClusterDeleteCount = Math.max(0, Number(schedulerState.totalAttackCommentClusterDeleteCount) || 0);
      this.totalSingleSightBannedPostCount = Math.max(0, Number(schedulerState.totalSingleSightBannedPostCount) || 0);
      this.totalBannedPostCount = Math.max(0, Number(schedulerState.totalBannedPostCount) || 0);
      this.totalFailedPostCount = Math.max(0, Number(schedulerState.totalFailedPostCount) || 0);
      this.deleteLimitFallbackCount = Math.max(0, Number(schedulerState.deleteLimitFallbackCount) || 0);
      this.banOnlyFallbackCount = Math.max(0, Number(schedulerState.banOnlyFallbackCount) || 0);
      this.lastError = String(schedulerState.lastError || '');
      this.cycleCount = Math.max(0, Number(schedulerState.cycleCount) || 0);
      this.runtimeDeleteEnabled = schedulerState.runtimeDeleteEnabled === undefined
        ? Boolean(schedulerState.config?.delChk)
        : Boolean(schedulerState.runtimeDeleteEnabled);
      this.runtimeDeleteModeReason = normalizeRuntimeDeleteModeReason(
        schedulerState.runtimeDeleteModeReason,
        {
          runtimeDeleteEnabled: this.runtimeDeleteEnabled,
          lastDeleteLimitExceededAt: schedulerState.lastDeleteLimitExceededAt,
          lastDeleteLimitMessage: schedulerState.lastDeleteLimitMessage,
        },
      );
      this.lastDeleteLimitExceededAt = String(schedulerState.lastDeleteLimitExceededAt || '');
      this.lastDeleteLimitMessage = String(schedulerState.lastDeleteLimitMessage || '');
      this.recentUidActions = normalizeRecentUidActions(schedulerState.recentUidActions);
      this.recentImmediatePostActions = normalizeRecentImmediatePostActions(schedulerState.recentImmediatePostActions);
      this.recentLinkbaitBodyLinkActions = normalizeRecentLinkbaitBodyLinkActions(schedulerState.recentLinkbaitBodyLinkActions);
      this.recentAttackTitlePostActions = normalizeRecentAttackTitlePostActions(schedulerState.recentAttackTitlePostActions);
      this.recentAttackCommentActions = normalizeRecentAttackCommentActions(schedulerState.recentAttackCommentActions);
      this.commentSnapshotByPostNo = normalizeCommentSnapshots(schedulerState.commentSnapshotByPostNo);
      this.attackTitlePatternLoadError = String(schedulerState.attackTitlePatternLoadError || '');
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...readPersistedConfig(schedulerState.config),
      });
      pruneRecentUidActions(this.recentUidActions);
      pruneRecentImmediatePostActions(this.recentImmediatePostActions);
      pruneRecentLinkbaitBodyLinkActions(this.recentLinkbaitBodyLinkActions);
      pruneRecentAttackTitlePostActions(this.recentAttackTitlePostActions);
      pruneRecentAttackCommentActions(this.recentAttackCommentActions);
    } catch (error) {
      console.error('[UidWarningAutoBanScheduler] 상태 복원 실패:', error.message);
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
      this.log('🔁 저장된 분탕자동차단 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    pruneRecentUidActions(this.recentUidActions);
    pruneRecentImmediatePostActions(this.recentImmediatePostActions);
    pruneRecentLinkbaitBodyLinkActions(this.recentLinkbaitBodyLinkActions);
    pruneRecentAttackTitlePostActions(this.recentAttackTitlePostActions);
    pruneRecentAttackCommentActions(this.recentAttackCommentActions);
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      currentPage: this.currentPage,
      lastPollAt: this.lastPollAt,
      nextRunAt: this.nextRunAt,
      lastTriggeredUid: this.lastTriggeredUid,
      lastTriggeredPostCount: this.lastTriggeredPostCount,
      lastBurstRecentCount: this.lastBurstRecentCount,
      lastSingleSightTriggeredUid: this.lastSingleSightTriggeredUid,
      lastSingleSightTriggeredPostCount: this.lastSingleSightTriggeredPostCount,
      lastImmediateTitleBanCount: this.lastImmediateTitleBanCount,
      lastImmediateTitleBanMatchedTitle: this.lastImmediateTitleBanMatchedTitle,
      lastLinkbaitBodyLinkCandidateCount: this.lastLinkbaitBodyLinkCandidateCount,
      lastLinkbaitBodyLinkCheckedCount: this.lastLinkbaitBodyLinkCheckedCount,
      lastLinkbaitBodyLinkMatchedCount: this.lastLinkbaitBodyLinkMatchedCount,
      lastLinkbaitBodyLinkActionCount: this.lastLinkbaitBodyLinkActionCount,
      lastLinkbaitBodyLinkRepresentative: this.lastLinkbaitBodyLinkRepresentative,
      lastAttackTitleClusterCount: this.lastAttackTitleClusterCount,
      lastAttackTitleClusterPostCount: this.lastAttackTitleClusterPostCount,
      lastAttackTitleClusterRepresentative: this.lastAttackTitleClusterRepresentative,
      lastAttackCommentClusterCount: this.lastAttackCommentClusterCount,
      lastAttackCommentClusterDeleteCount: this.lastAttackCommentClusterDeleteCount,
      lastAttackCommentClusterPostCount: this.lastAttackCommentClusterPostCount,
      lastAttackCommentClusterRepresentative: this.lastAttackCommentClusterRepresentative,
      lastPageRowCount: this.lastPageRowCount,
      lastPageUidCount: this.lastPageUidCount,
      totalTriggeredUidCount: this.totalTriggeredUidCount,
      totalSingleSightTriggeredUidCount: this.totalSingleSightTriggeredUidCount,
      totalImmediateTitleBanPostCount: this.totalImmediateTitleBanPostCount,
      totalLinkbaitBodyLinkPostCount: this.totalLinkbaitBodyLinkPostCount,
      totalAttackTitleClusterPostCount: this.totalAttackTitleClusterPostCount,
      totalAttackCommentClusterDeleteCount: this.totalAttackCommentClusterDeleteCount,
      totalSingleSightBannedPostCount: this.totalSingleSightBannedPostCount,
      totalBannedPostCount: this.totalBannedPostCount,
      totalFailedPostCount: this.totalFailedPostCount,
      deleteLimitFallbackCount: this.deleteLimitFallbackCount,
      banOnlyFallbackCount: this.banOnlyFallbackCount,
      lastError: this.lastError,
      cycleCount: this.cycleCount,
      runtimeDeleteEnabled: this.runtimeDeleteEnabled,
      runtimeDeleteModeReason: this.runtimeDeleteModeReason,
      lastDeleteLimitExceededAt: this.lastDeleteLimitExceededAt,
      lastDeleteLimitMessage: this.lastDeleteLimitMessage,
      attackTitlePatternLoadError: this.attackTitlePatternLoadError,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }
}

function normalizeConfig(config = {}) {
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    pollIntervalMs: Math.max(1000, Number(config.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs),
    recentWindowMs: Math.max(60000, Number(config.recentWindowMs) || DEFAULT_CONFIG.recentWindowMs),
    recentPostThreshold: Math.max(1, Number(config.recentPostThreshold) || DEFAULT_CONFIG.recentPostThreshold),
    postRatioThresholdPercent: clampPercent(config.postRatioThresholdPercent, DEFAULT_CONFIG.postRatioThresholdPercent),
    retryCooldownMs: Math.max(1000, Number(config.retryCooldownMs) || DEFAULT_CONFIG.retryCooldownMs),
    avoidHour: String(config.avoidHour || DEFAULT_CONFIG.avoidHour).trim() || DEFAULT_CONFIG.avoidHour,
    avoidReason: String(config.avoidReason || DEFAULT_CONFIG.avoidReason).trim() || DEFAULT_CONFIG.avoidReason,
    avoidReasonText: normalizeAvoidReasonText(config.avoidReasonText),
    delChk: config.delChk === undefined ? Boolean(DEFAULT_CONFIG.delChk) : Boolean(config.delChk),
    avoidTypeChk: config.avoidTypeChk === undefined ? Boolean(DEFAULT_CONFIG.avoidTypeChk) : Boolean(config.avoidTypeChk),
    immediateTitleBanRules: normalizeImmediateTitleBanRules(config.immediateTitleBanRules),
    attackCommentClusterEnabled: config.attackCommentClusterEnabled === undefined
      ? Boolean(DEFAULT_CONFIG.attackCommentClusterEnabled)
      : Boolean(config.attackCommentClusterEnabled),
    attackCommentClusterMinCount: Math.max(2, Number(config.attackCommentClusterMinCount) || DEFAULT_CONFIG.attackCommentClusterMinCount),
    attackCommentMinNormalizedLength: Math.max(1, Number(config.attackCommentMinNormalizedLength) || DEFAULT_CONFIG.attackCommentMinNormalizedLength),
    attackCommentFetchConcurrency: Math.max(1, Number(config.attackCommentFetchConcurrency) || DEFAULT_CONFIG.attackCommentFetchConcurrency),
    attackCommentFetchRequestDelayMs: Math.max(
      0,
      Number(config.attackCommentFetchRequestDelayMs ?? config.attackCommentFetchStartDelayMs)
        || DEFAULT_CONFIG.attackCommentFetchRequestDelayMs,
    ),
    attackCommentFetchTimeoutMs: Math.max(1000, Number(config.attackCommentFetchTimeoutMs) || DEFAULT_CONFIG.attackCommentFetchTimeoutMs),
    attackCommentDeleteDelayMs: Math.max(0, Number(config.attackCommentDeleteDelayMs) || DEFAULT_CONFIG.attackCommentDeleteDelayMs),
    attackCommentDeleteTimeoutMs: Math.max(1000, Number(config.attackCommentDeleteTimeoutMs) || DEFAULT_CONFIG.attackCommentDeleteTimeoutMs),
    attackCommentSnapshotTtlMs: Math.max(1000, Number(config.attackCommentSnapshotTtlMs) || DEFAULT_CONFIG.attackCommentSnapshotTtlMs),
    linkbaitBodyLinkEnabled: config.linkbaitBodyLinkEnabled === undefined
      ? Boolean(DEFAULT_CONFIG.linkbaitBodyLinkEnabled)
      : Boolean(config.linkbaitBodyLinkEnabled),
    linkbaitBodyLinkTitleNeedle: String(config.linkbaitBodyLinkTitleNeedle || DEFAULT_CONFIG.linkbaitBodyLinkTitleNeedle).trim()
      || DEFAULT_CONFIG.linkbaitBodyLinkTitleNeedle,
    linkbaitBodyLinkFetchConcurrency: Math.max(1, Number(config.linkbaitBodyLinkFetchConcurrency) || DEFAULT_CONFIG.linkbaitBodyLinkFetchConcurrency),
    linkbaitBodyLinkFetchRequestDelayMs: Math.max(0, Number(config.linkbaitBodyLinkFetchRequestDelayMs) || DEFAULT_CONFIG.linkbaitBodyLinkFetchRequestDelayMs),
    linkbaitBodyLinkFetchTimeoutMs: Math.max(1000, Number(config.linkbaitBodyLinkFetchTimeoutMs) || DEFAULT_CONFIG.linkbaitBodyLinkFetchTimeoutMs),
  };
}

function buildAttackCommentBanConfig(config = {}) {
  return {
    ...config,
    avoidHour: ATTACK_TITLE_BAN_HOUR,
    avoidReason: '0',
    avoidReasonText: ATTACK_TITLE_BAN_REASON_TEXT,
    delChk: true,
    avoidTypeChk: true,
  };
}

function buildPersistedConfig(config = {}) {
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    immediateTitleBanRules: normalizeImmediateTitleBanRules(config.immediateTitleBanRules),
  };
}

function readPersistedConfig(raw = {}) {
  return buildPersistedConfig(raw);
}

function normalizeRuntimeDeleteModeReason(value, context = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  if (Object.values(DELETE_MODE_REASON).includes(normalized)) {
    return normalized;
  }

  const runtimeDeleteEnabled = Boolean(context.runtimeDeleteEnabled);
  const lastDeleteLimitExceededAt = String(context.lastDeleteLimitExceededAt || '').trim();
  const lastDeleteLimitMessage = String(context.lastDeleteLimitMessage || '').trim();
  if (!runtimeDeleteEnabled && (lastDeleteLimitExceededAt || lastDeleteLimitMessage)) {
    return DELETE_MODE_REASON.DELETE_LIMIT;
  }

  return DELETE_MODE_REASON.NORMAL;
}

function normalizeAvoidReasonText(value) {
  const normalized = String(value || '').trim();
  if (
    !normalized
    || normalized === LEGACY_AVOID_REASON_TEXT
    || normalized === PREVIOUS_DEFAULT_AVOID_REASON_TEXT
  ) {
    return DEFAULT_AVOID_REASON_TEXT;
  }

  return normalized;
}

function buildGallogPrivacySummary(privacy = {}) {
  return [
    privacy.postingPrivate ? '게시글 비공개' : '게시글 공개',
    privacy.commentPrivate ? '댓글 비공개' : '댓글 공개',
  ].join(' / ');
}

function buildGuestbookStateSummary(state = {}) {
  if (state.guestbookLocked === true) {
    return '방명록 잠금';
  }

  if (state.guestbookWritable === true) {
    return '방명록 공개';
  }

  return '방명록 미확인';
}

function buildUidActionKey(galleryId, uid) {
  return `${String(galleryId || '').trim()}::${String(uid || '').trim()}`;
}

function createRecentUidActionEntry({ newestPostNo, success, nowIso }) {
  return {
    lastNewestPostNo: Math.max(0, Number(newestPostNo) || 0),
    lastActionAt: String(nowIso || ''),
    success: success === true,
  };
}

function shouldSkipRecentUidAction(entry, newestPostNo, nowMs, retryCooldownMs) {
  if (!entry) {
    return false;
  }

  const normalizedNewestPostNo = Math.max(0, Number(newestPostNo) || 0);
  const previousNewestPostNo = Math.max(0, Number(entry.lastNewestPostNo) || 0);
  if (normalizedNewestPostNo > previousNewestPostNo) {
    return false;
  }

  if (entry.success === true) {
    return true;
  }

  const lastActionAtMs = parseTimestamp(entry.lastActionAt);
  if (lastActionAtMs <= 0) {
    return false;
  }

  return nowMs - lastActionAtMs < Math.max(1000, Number(retryCooldownMs) || 0);
}

function normalizeRecentUidActions(raw = {}) {
  const result = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      continue;
    }

    result[normalizedKey] = createRecentUidActionEntry({
      newestPostNo: value?.lastNewestPostNo,
      success: value?.success,
      nowIso: value?.lastActionAt,
    });
  }
  return result;
}

function buildImmediatePostActionKey(postNo) {
  return String(Math.max(0, Number(postNo) || 0));
}

function createRecentImmediatePostActionEntry({ success, nowIso }) {
  return {
    lastActionAt: String(nowIso || ''),
    success: success === true,
  };
}

function shouldSkipRecentImmediatePostAction(entry, nowMs, retryCooldownMs) {
  if (!entry) {
    return false;
  }

  if (entry.success === true) {
    return true;
  }

  const lastActionAtMs = parseTimestamp(entry.lastActionAt);
  if (lastActionAtMs <= 0) {
    return false;
  }

  return nowMs - lastActionAtMs < Math.max(1000, Number(retryCooldownMs) || 0);
}

function normalizeRecentImmediatePostActions(raw = {}) {
  const result = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const normalizedKey = buildImmediatePostActionKey(key);
    if (normalizedKey === '0') {
      continue;
    }

    result[normalizedKey] = createRecentImmediatePostActionEntry({
      success: value?.success,
      nowIso: value?.lastActionAt,
    });
  }
  return result;
}

function buildAttackTitlePostActionKey(postNo) {
  return buildImmediatePostActionKey(postNo);
}

function buildLinkbaitBodyLinkActionKey(postNo) {
  return buildImmediatePostActionKey(postNo);
}

function createRecentAttackTitlePostActionEntry({ success, nowIso }) {
  return createRecentImmediatePostActionEntry({ success, nowIso });
}

function createRecentLinkbaitBodyLinkActionEntry({ success, nowIso }) {
  return createRecentImmediatePostActionEntry({ success, nowIso });
}

function shouldSkipRecentAttackTitlePostAction(entry, nowMs, retryCooldownMs) {
  return shouldSkipRecentImmediatePostAction(entry, nowMs, retryCooldownMs);
}

function shouldSkipRecentLinkbaitBodyLinkAction(entry, nowMs, retryCooldownMs) {
  return shouldSkipRecentImmediatePostAction(entry, nowMs, retryCooldownMs);
}

function normalizeRecentAttackTitlePostActions(raw = {}) {
  return normalizeRecentImmediatePostActions(raw);
}

function normalizeRecentLinkbaitBodyLinkActions(raw = {}) {
  return normalizeRecentImmediatePostActions(raw);
}

function createRecentAttackCommentActionEntry({
  postNo,
  commentNo,
  normalizedMemo,
  success,
  nowIso,
}) {
  return {
    postNo: Math.max(0, Number(postNo) || 0),
    commentNo: String(commentNo || '').trim(),
    normalizedMemo: String(normalizedMemo || '').trim(),
    lastActionAt: String(nowIso || ''),
    success: success === true,
  };
}

function normalizeRecentAttackCommentActions(raw = {}) {
  const result = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const keyParts = String(key || '').split('::');
    const normalizedPostNo = Math.max(0, Number(value?.postNo || keyParts[0]) || 0);
    const normalizedCommentNo = String(value?.commentNo || keyParts[1] || '').trim();
    const normalizedKey = normalizedPostNo > 0 && normalizedCommentNo
      ? buildAttackCommentActionKey(normalizedPostNo, normalizedCommentNo)
      : String(key || '').trim();
    if (!normalizedKey || normalizedKey === '0::') {
      continue;
    }

    result[normalizedKey] = createRecentAttackCommentActionEntry({
      postNo: normalizedPostNo,
      commentNo: normalizedCommentNo || String(normalizedKey.split('::')[1] || '').trim(),
      normalizedMemo: value?.normalizedMemo,
      success: value?.success,
      nowIso: value?.lastActionAt,
    });
  }
  return result;
}

function normalizeCommentSnapshots(raw = {}) {
  const result = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const postNo = Math.max(0, Number(value?.postNo || key) || 0);
    if (postNo <= 0) {
      continue;
    }

    const comments = [];
    const seenCommentNos = new Set();
    for (const comment of Array.isArray(value?.comments) ? value.comments : []) {
      const commentNo = String(comment?.no || '').trim();
      const normalizedMemo = String(comment?.normalizedMemo || '').trim();
      if (!commentNo || !normalizedMemo || seenCommentNos.has(commentNo)) {
        continue;
      }

      seenCommentNos.add(commentNo);
      comments.push({
        postNo,
        no: commentNo,
        ip: String(comment?.ip || '').trim(),
        name: String(comment?.name || '').trim(),
        memoPreview: String(comment?.memoPreview || '').slice(0, 120),
        normalizedMemo,
      });
    }

    result[String(postNo)] = {
      postNo,
      commentCount: Math.max(0, Number(value?.commentCount) || 0),
      fetchedTotalCount: Math.max(0, Number(value?.fetchedTotalCount) || 0),
      lastCheckedAt: String(value?.lastCheckedAt || ''),
      comments,
    };
  }
  return result;
}

function snapshotHasRecentAttackCommentSuccess(snapshot = {}, recentActions = {}) {
  const postNo = Math.max(0, Number(snapshot?.postNo) || 0);
  if (postNo <= 0) {
    return false;
  }

  for (const comment of Array.isArray(snapshot?.comments) ? snapshot.comments : []) {
    const commentNo = String(comment?.no || '').trim();
    if (!commentNo) {
      continue;
    }

    const actionKey = buildAttackCommentActionKey(postNo, commentNo);
    if (recentActions?.[actionKey]?.success === true) {
      return true;
    }
  }

  return false;
}

function snapshotSharesRecentAttackCommentSuccess(snapshot = {}, recentActions = {}) {
  const normalizedMemos = new Set(
    (Array.isArray(snapshot?.comments) ? snapshot.comments : [])
      .map((comment) => String(comment?.normalizedMemo || '').trim())
      .filter(Boolean),
  );
  if (normalizedMemos.size <= 0) {
    return false;
  }

  for (const action of Object.values(recentActions || {})) {
    const normalizedMemo = String(action?.normalizedMemo || '').trim();
    if (action?.success === true && normalizedMemo && normalizedMemos.has(normalizedMemo)) {
      return true;
    }
  }

  return false;
}

function pruneRecentUidActions(entries = {}) {
  const nowMs = Date.now();
  for (const [key, value] of Object.entries(entries || {})) {
    const actionAtMs = parseTimestamp(value?.lastActionAt);
    if (actionAtMs <= 0 || nowMs - actionAtMs > UID_ACTION_RETENTION_MS) {
      delete entries[key];
    }
  }
}

function pruneRecentImmediatePostActions(entries = {}) {
  const nowMs = Date.now();
  for (const [key, value] of Object.entries(entries || {})) {
    const actionAtMs = parseTimestamp(value?.lastActionAt);
    if (actionAtMs <= 0 || nowMs - actionAtMs > UID_ACTION_RETENTION_MS) {
      delete entries[key];
    }
  }
}

function pruneRecentAttackTitlePostActions(entries = {}) {
  pruneRecentImmediatePostActions(entries);
}

function pruneRecentLinkbaitBodyLinkActions(entries = {}) {
  pruneRecentImmediatePostActions(entries);
}

function pruneRecentAttackCommentActions(entries = {}) {
  const nowMs = Date.now();
  for (const [key, value] of Object.entries(entries || {})) {
    const actionAtMs = parseTimestamp(value?.lastActionAt);
    if (actionAtMs <= 0 || nowMs - actionAtMs > ATTACK_COMMENT_ACTION_RETENTION_MS) {
      delete entries[key];
    }
  }
}

function clampPercent(value, fallback) {
  return Math.min(100, Math.max(0, Number(value) || Number(fallback) || 0));
}

function getPollIntervalMs(config = {}) {
  return Math.max(1000, Number(config.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs);
}

function getRecentWindowMs(config = {}) {
  return Math.max(60000, Number(config.recentWindowMs) || DEFAULT_CONFIG.recentWindowMs);
}

function getRecentPostThreshold(config = {}) {
  return Math.max(1, Number(config.recentPostThreshold) || DEFAULT_CONFIG.recentPostThreshold);
}

function getPostRatioThresholdPercent(config = {}) {
  return clampPercent(config.postRatioThresholdPercent, DEFAULT_CONFIG.postRatioThresholdPercent);
}

function getRetryCooldownMs(config = {}) {
  return Math.max(1000, Number(config.retryCooldownMs) || DEFAULT_CONFIG.retryCooldownMs);
}

function getAttackCommentClusterEnabled(config = {}) {
  return config.attackCommentClusterEnabled !== false;
}

function getAttackCommentClusterMinCount(config = {}) {
  return Math.max(2, Number(config.attackCommentClusterMinCount) || DEFAULT_CONFIG.attackCommentClusterMinCount);
}

function getAttackCommentMinNormalizedLength(config = {}) {
  return Math.max(1, Number(config.attackCommentMinNormalizedLength) || DEFAULT_CONFIG.attackCommentMinNormalizedLength);
}

function getAttackCommentFetchConcurrency(config = {}) {
  return Math.max(1, Number(config.attackCommentFetchConcurrency) || DEFAULT_CONFIG.attackCommentFetchConcurrency);
}

function getAttackCommentFetchRequestDelayMs(config = {}) {
  return Math.max(
    0,
    Number(config.attackCommentFetchRequestDelayMs ?? config.attackCommentFetchStartDelayMs)
      || DEFAULT_CONFIG.attackCommentFetchRequestDelayMs,
  );
}

function getAttackCommentFetchTimeoutMs(config = {}) {
  return Math.max(1000, Number(config.attackCommentFetchTimeoutMs) || DEFAULT_CONFIG.attackCommentFetchTimeoutMs);
}

function getAttackCommentDeleteDelayMs(config = {}) {
  return Math.max(0, Number(config.attackCommentDeleteDelayMs) || DEFAULT_CONFIG.attackCommentDeleteDelayMs);
}

function getAttackCommentDeleteTimeoutMs(config = {}) {
  return Math.max(1000, Number(config.attackCommentDeleteTimeoutMs) || DEFAULT_CONFIG.attackCommentDeleteTimeoutMs);
}

function getAttackCommentSnapshotTtlMs(config = {}) {
  return Math.max(1000, Number(config.attackCommentSnapshotTtlMs) || DEFAULT_CONFIG.attackCommentSnapshotTtlMs);
}

function getLinkbaitBodyLinkEnabled(config = {}) {
  return config.linkbaitBodyLinkEnabled !== false;
}

function getLinkbaitBodyLinkTitleNeedle(config = {}) {
  const normalizedNeedle = normalizeImmediateTitleValue(
    config.linkbaitBodyLinkTitleNeedle || DEFAULT_CONFIG.linkbaitBodyLinkTitleNeedle,
  );
  return normalizedNeedle || DEFAULT_LINKBAIT_TITLE_NEEDLE;
}

function getLinkbaitBodyLinkFetchConcurrency(config = {}) {
  return Math.max(1, Number(config.linkbaitBodyLinkFetchConcurrency) || DEFAULT_CONFIG.linkbaitBodyLinkFetchConcurrency);
}

function getLinkbaitBodyLinkFetchRequestDelayMs(config = {}) {
  return Math.max(0, Number(config.linkbaitBodyLinkFetchRequestDelayMs) || DEFAULT_CONFIG.linkbaitBodyLinkFetchRequestDelayMs);
}

function getLinkbaitBodyLinkFetchTimeoutMs(config = {}) {
  return Math.max(1000, Number(config.linkbaitBodyLinkFetchTimeoutMs) || DEFAULT_CONFIG.linkbaitBodyLinkFetchTimeoutMs);
}

function isLinkbaitBodyLinkTitleCandidate(row = {}, config = {}) {
  const postNo = Number(row?.no) || 0;
  if (postNo <= 0) {
    return false;
  }

  if (isAlreadySpamHead(row?.currentHead)) {
    return false;
  }

  const normalizedTitle = normalizeImmediateTitleValue(row?.title || row?.subject || '');
  return normalizedTitle.includes(getLinkbaitBodyLinkTitleNeedle(config));
}

function parseTimestamp(value) {
  const timeMs = Date.parse(String(value || '').trim());
  return Number.isFinite(timeMs) ? timeMs : 0;
}

function normalizePhase(value) {
  return Object.values(PHASE).includes(value) ? value : PHASE.IDLE;
}

function formatPostRatio(value) {
  const numericValue = Number(value) || 0;
  return numericValue.toFixed(2).replace(/\.00$/, '');
}

function formatSimilarityPercent(value) {
  return formatPostRatio((Number(value) || 0) * 100);
}

function summarizeMatchedTitles(titles = []) {
  const normalizedTitles = [...new Set(
    (Array.isArray(titles) ? titles : [])
      .map((title) => String(title || '').trim())
      .filter(Boolean),
  )];
  if (normalizedTitles.length <= 0) {
    return '';
  }

  if (normalizedTitles.length === 1) {
    return normalizedTitles[0];
  }

  return `${normalizedTitles[0]} 외 ${normalizedTitles.length - 1}개`;
}

function findImmediateTitleMatchedRule(rules = [], normalizedTitle = '') {
  const title = String(normalizedTitle || '').trim();
  if (!title) {
    return null;
  }

  let matchedRule = null;
  let matchedSpecificity = -1;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!matchesImmediateTitleRule(rule, title)) {
      continue;
    }

    const specificity = getImmediateTitleRuleSpecificity(rule);
    if (!matchedRule) {
      matchedRule = rule;
      matchedSpecificity = specificity;
      continue;
    }

    if (specificity > matchedSpecificity) {
      matchedRule = rule;
      matchedSpecificity = specificity;
      continue;
    }

    if (specificity !== matchedSpecificity) {
      continue;
    }

    const normalizedRuleLength = String(rule?.normalizedTitle || '').length;
    const matchedRuleLength = String(matchedRule?.normalizedTitle || '').length;
    if (normalizedRuleLength > matchedRuleLength) {
      matchedRule = rule;
      matchedSpecificity = specificity;
      continue;
    }

    if (normalizedRuleLength !== matchedRuleLength) {
      continue;
    }

    if (String(rule?.type || '') === 'and' && String(matchedRule?.type || '') !== 'and') {
      matchedRule = rule;
      matchedSpecificity = specificity;
      continue;
    }

    const ruleKey = String(rule?.ruleKey || '').trim();
    const matchedRuleKey = String(matchedRule?.ruleKey || '').trim();
    if (ruleKey && matchedRuleKey && ruleKey.localeCompare(matchedRuleKey, 'ko-KR') < 0) {
      matchedRule = rule;
      matchedSpecificity = specificity;
    }
  }

  return matchedRule;
}

function matchesImmediateTitleRule(rule = {}, normalizedTitle = '') {
  const title = String(normalizedTitle || '').trim();
  if (!title) {
    return false;
  }

  if (String(rule?.type || '').trim() === 'and') {
    const normalizedTokens = Array.isArray(rule?.normalizedTokens)
      ? rule.normalizedTokens
      : [];
    return normalizedTokens.length >= 2
      && normalizedTokens.every((token) => title.includes(String(token || '').trim()));
  }

  const normalizedRule = String(rule?.normalizedTitle || '').trim();
  return Boolean(normalizedRule) && title.includes(normalizedRule);
}

function getImmediateTitleRuleSpecificity(rule = {}) {
  if (String(rule?.type || '').trim() === 'and') {
    const normalizedTokens = Array.isArray(rule?.normalizedTokens)
      ? rule.normalizedTokens.map((token) => String(token || '').trim()).filter(Boolean)
      : [];
    const tokenLengthSum = normalizedTokens.reduce((sum, token) => sum + token.length, 0);
    return tokenLengthSum + normalizedTokens.length;
  }

  return String(rule?.normalizedTitle || '').trim().length;
}

function getImmediateTitleRuleLogLabel(rule = {}) {
  const typeLabel = String(rule?.type || '').trim() === 'and' ? '[AND]' : '[포함]';
  const rawTitle = String(rule?.rawTitle || '').trim();
  const normalizedTitle = String(rule?.normalizedTitle || '').trim();
  return `${typeLabel} ${rawTitle || normalizedTitle}`;
}

function isTwoConsonantNick(value) {
  return /^[ㄱ-ㅎ]{2}$/.test(String(value || '').trim());
}

async function mapWithConcurrencyWorkerPool(
  items,
  concurrency,
  requestDelayMs,
  mapper,
  shouldContinue = () => true,
  delayFn = delay,
) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (normalizedItems.length <= 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, normalizedItems.length));
  const delayMs = Math.max(0, Number(requestDelayMs) || 0);
  const results = new Array(normalizedItems.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (shouldContinue()) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= normalizedItems.length) {
        return;
      }

      if (!shouldContinue()) {
        return;
      }

      try {
        results[currentIndex] = await mapper(normalizedItems[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = {
          success: false,
          message: String(error?.message || '알 수 없는 오류'),
        };
      }

      if (delayMs > 0 && shouldContinue() && nextIndex < normalizedItems.length) {
        await delayFn(delayMs);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

async function runWithTimeoutSignal(timeoutMs, work, timeoutLabel = '작업 시간 초과') {
  const normalizedTimeoutMs = Math.max(1000, Number(timeoutMs) || 0);
  const controller = new AbortController();
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`${timeoutLabel} (${normalizedTimeoutMs}ms)`));
    }, normalizedTimeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      timeoutPromise,
    ]);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      if (String(error?.message || '').includes(timeoutLabel)) {
        throw error;
      }
      throw new Error(`${timeoutLabel} (${normalizedTimeoutMs}ms)`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function delayWhileRunning(scheduler, ms) {
  const remainingMs = Math.max(0, Number(ms) || 0);
  if (remainingMs <= 0) {
    return;
  }

  const stepMs = Math.min(remainingMs, 1000);
  const startedAt = Date.now();
  while (scheduler.isRunning && Date.now() - startedAt < remainingMs) {
    await scheduler.delayFn(stepMs);
  }
}

export {
  PHASE,
  Scheduler,
  buildUidActionKey,
  createRecentUidActionEntry,
  normalizeConfig,
  shouldSkipRecentUidAction,
};
