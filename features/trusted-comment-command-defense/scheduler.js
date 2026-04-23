import {
  fetchPostList,
  fetchPostPage,
  extractEsno,
  fetchRecentComments,
  delay,
} from '../comment/api.js';
import {
  fetchPostListHTML,
  deletePosts,
} from '../post/api.js';
import {
  extractHeadtextName,
  extractPostNos,
  parseBoardPosts,
  parseFluidPosts,
} from '../post/parser.js';
import { fetchTargetListHTML } from '../ip/api.js';
import { parseTargetPosts } from '../ip/parser.js';
import {
  COMMAND_TYPE,
  parseCommandPostTarget,
  parseTrustedCommand,
  parseTrustedUsersText,
  serializeTrustedUsersText,
  sortCommentsByNo,
} from './parser.js';

const STORAGE_KEY = 'trustedCommentCommandDefenseSchedulerState';

const PHASE = {
  IDLE: 'IDLE',
  SEEDING: 'SEEDING',
  POLLING: 'POLLING',
  WAITING: 'WAITING',
  EXECUTING_POST_DEFENSE: 'EXECUTING_POST_DEFENSE',
  EXECUTING_COMMENT_DEFENSE: 'EXECUTING_COMMENT_DEFENSE',
};

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  headtextId: '130',
  commandPostUrl: '',
  commandGalleryId: '',
  commandPostNo: '',
  trustedUsersText: '',
  trustedUsers: [],
  commandPrefix: '@특갤봇',
  pollIntervalMs: 20000,
  holdMs: 600000,
  recentCommentPages: 2,
};

class Scheduler {
  constructor(dependencies = {}) {
    this.commentScheduler = dependencies.commentScheduler;
    this.postScheduler = dependencies.postScheduler;
    this.ipScheduler = dependencies.ipScheduler;
    this.shouldAllowPostDefenseStart = typeof dependencies.shouldAllowPostDefenseStart === 'function'
      ? dependencies.shouldAllowPostDefenseStart
      : () => true;
    this.shouldAllowCommentDefenseStart = typeof dependencies.shouldAllowCommentDefenseStart === 'function'
      ? dependencies.shouldAllowCommentDefenseStart
      : () => true;

    this.isRunning = false;
    this.runPromise = null;
    this.abortController = null;
    this.phase = PHASE.IDLE;
    this.pollCount = 0;
    this.startedAt = '';
    this.lastPollAt = '';
    this.seededAt = '';
    this.seeded = false;
    this.lastSeenCommentNo = '';
    this.processedCommandCommentNos = [];
    this.lastCommandType = '';
    this.lastCommandCommentNo = '';
    this.lastCommandUserId = '';
    this.lastCommandAt = '';
    this.postDefenseUntilTs = 0;
    this.commentDefenseUntilTs = 0;
    this.ownedPostScheduler = false;
    this.ownedIpScheduler = false;
    this.ownedCommentScheduler = false;
    this.postDefenseCutoffPostNo = 0;
    this.logs = [];

    this.config = normalizeConfig(DEFAULT_CONFIG);
  }

  getStartBlockReason() {
    if (!String(this.config.galleryId || '').trim()) {
      return '공통 갤 ID를 먼저 저장하세요.';
    }

    if (!String(this.config.headtextId || '').trim()) {
      return '공통 도배기탭 번호를 먼저 저장하세요.';
    }

    if (!String(this.config.commandPostNo || '').trim()) {
      return '명령 게시물 링크를 저장한 뒤 시작하세요.';
    }

    if (!String(this.config.commandGalleryId || '').trim()) {
      return '명령 게시물 갤 ID를 확인하지 못했습니다.';
    }

    if (String(this.config.commandGalleryId) !== String(this.config.galleryId)) {
      return '명령 게시물은 현재 공통 갤과 같은 갤이어야 합니다.';
    }

    if (!Array.isArray(this.config.trustedUsers) || this.config.trustedUsers.length <= 0) {
      return '신뢰 사용자 목록을 1개 이상 저장하세요.';
    }

    if (!String(this.config.commandPrefix || '').trim()) {
      return '명령 prefix를 입력하세요.';
    }

    return '';
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 신뢰댓글 명령 방어가 실행 중입니다.');
      await this.saveState();
      return;
    }

    const startBlockReason = this.getStartBlockReason();
    if (startBlockReason) {
      this.log(`⚠️ ${startBlockReason}`);
      await this.saveState();
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.phase = PHASE.SEEDING;
    this.startedAt = new Date().toISOString();
    this.lastPollAt = '';
    this.seededAt = '';
    this.seeded = false;
    this.lastSeenCommentNo = '';
    this.processedCommandCommentNos = [];
    this.lastCommandType = '';
    this.lastCommandCommentNo = '';
    this.lastCommandUserId = '';
    this.lastCommandAt = '';
    this.log(
      `🟢 신뢰댓글 명령 방어 시작 - 관리 글 #${this.config.commandPostNo} / 신뢰 사용자 ${this.config.trustedUsers.length}명`,
    );
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop(reason = '🔴 신뢰댓글 명령 방어 중지.') {
    if (!this.isRunning && !this.runPromise && !this.abortController) {
      this.log('⚠️ 이미 신뢰댓글 명령 방어가 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
    }

    await this.stopOwnedPostDefense('ℹ️ 게시물방어 ownership 해제');
    await this.stopOwnedCommentDefense('ℹ️ 댓글방어 ownership 해제');

    this.abortController = null;
    this.phase = PHASE.IDLE;
    this.log(reason);
    await this.saveState();
  }

  ensureRunLoop() {
    if (!this.isRunning || this.runPromise) {
      return;
    }

    this.runPromise = this.run().finally(() => {
      this.runPromise = null;
      this.abortController = null;
    });
  }

  async run() {
    while (this.isRunning) {
      try {
        await this.syncOwnedDefenseState();
        if (!this.isRunning) {
          break;
        }

        await this.pollOnce();
        if (!this.isRunning) {
          break;
        }

        this.phase = PHASE.WAITING;
        await this.saveState();
        await delay(this.getNextWakeDelayMs(), this.abortController?.signal);
      } catch (error) {
        if (error?.name === 'AbortError') {
          break;
        }

        this.log(`❌ 신뢰댓글 명령 polling 오류 - ${String(error?.message || '알 수 없는 오류')}`);
        this.phase = PHASE.WAITING;
        await this.saveState();
        await delay(this.getNextWakeDelayMs(), this.abortController?.signal);
      }
    }

    this.phase = PHASE.IDLE;
    await this.saveState();
  }

  async pollOnce() {
    await this.handleExpiredDefenses();
    if (!this.isRunning) {
      return;
    }

    this.phase = this.seeded ? PHASE.POLLING : PHASE.SEEDING;
    this.lastPollAt = new Date().toISOString();
    this.pollCount += 1;
    await this.saveState();

    const commandPostHtml = await fetchPostPage(this.getCommentConfig(), this.config.commandPostNo);
    const esno = extractEsno(commandPostHtml);
    if (!esno) {
      throw new Error('명령 게시물 e_s_n_o 추출에 실패했습니다.');
    }

    const recentCommentsResult = await fetchRecentComments(
      this.getCommentConfig(),
      this.config.commandPostNo,
      esno,
      this.config.recentCommentPages,
    );

    const sortedComments = sortCommentsByNo(recentCommentsResult.comments || []);
    const maxVisibleCommentNo = getMaxCommentNo(sortedComments);

    if (!this.seeded) {
      this.seeded = true;
      this.seededAt = new Date().toISOString();
      this.lastSeenCommentNo = maxVisibleCommentNo;
      this.log(
        maxVisibleCommentNo
          ? `🌱 첫 poll seed 완료 - 기존 댓글 #${maxVisibleCommentNo}까지 건너뜁니다.`
          : '🌱 첫 poll seed 완료 - 기존 댓글이 없어 다음 명령부터 감지합니다.',
      );
      await this.saveState();
      return;
    }

    const newComments = sortedComments.filter((comment) => compareCommentNo(comment?.no, this.lastSeenCommentNo) > 0);
    if (newComments.length <= 0) {
      await this.saveState();
      return;
    }

    for (const comment of newComments) {
      if (!this.isRunning) {
        return;
      }

      const commandCommentNo = normalizeCommentNo(comment?.no);
      if (commandCommentNo) {
        this.lastSeenCommentNo = getMaxNumericString(this.lastSeenCommentNo, commandCommentNo);
      }

      if (!commandCommentNo || this.processedCommandCommentNos.includes(commandCommentNo)) {
        continue;
      }

      const parsedCommand = parseTrustedCommand(comment, this.config.commandPrefix);
      if (!parsedCommand.success) {
        continue;
      }

      if (!this.isTrustedUserId(parsedCommand.commandUserId)) {
        continue;
      }

      try {
        this.markCommandCommentProcessed(commandCommentNo);
        await this.handleCommand(parsedCommand, esno);
      } catch (error) {
        this.log(
          `❌ 명령 실행 실패 - 댓글 #${commandCommentNo} / ${parsedCommand.commandUserId} / ${String(error?.message || '알 수 없는 오류')}`,
        );
      }
    }

    if (compareCommentNo(maxVisibleCommentNo, this.lastSeenCommentNo) > 0) {
      this.lastSeenCommentNo = maxVisibleCommentNo;
    }
    await this.saveState();
  }

  async handleCommand(command, sharedEsno) {
    this.lastCommandType = command.type;
    this.lastCommandCommentNo = String(command.commandCommentNo || '');
    this.lastCommandUserId = String(command.commandUserId || '');
    this.lastCommandAt = new Date().toISOString();

    if (command.type === COMMAND_TYPE.POST_DEFENSE) {
      await this.executePostDefenseCommand(sharedEsno);
      return;
    }

    if (command.type === COMMAND_TYPE.COMMENT_DEFENSE) {
      await this.executeCommentDefenseCommand(sharedEsno);
    }
  }

  async executePostDefenseCommand(sharedEsno) {
    const now = Date.now();
    if (this.isPostDefenseActive()) {
      this.extendPostDefense(now);
      this.log(`⏱️ 게시물방어 연장 - ${formatRemainingMs(this.postDefenseUntilTs - now)} 남음`);
      await this.ensureOwnedDefensesStarted();
      await this.saveState();
      return;
    }

    this.phase = PHASE.EXECUTING_POST_DEFENSE;
    await this.saveState();

    if (!this.shouldAllowPostDefenseStart()) {
      throw new Error('감시 자동화가 실행 중이라 게시물방어 child를 시작할 수 없습니다.');
    }

    const boardListHtml = await fetchPostListHTML(this.getPostConfig(), 1);
    const headtextName = extractHeadtextName(boardListHtml, this.config.headtextId);
    if (!headtextName) {
      throw new Error(`도배기탭 번호 ${this.config.headtextId} 라벨 추출 실패로 게시물방어를 중단합니다.`);
    }

    const pageOnePosts = parseBoardPosts(boardListHtml);
    const cutoffPostNo = getMaxPostNo(pageOnePosts);
    if (cutoffPostNo <= 0) {
      throw new Error('1페이지 cutoff snapshot 추출에 실패했습니다.');
    }

    const fluidPosts = parseFluidPosts(boardListHtml, headtextName);
    const fluidPostNos = extractPostNos(fluidPosts);
    if (fluidPostNos.length > 0) {
      await this.postScheduler.classifyPostsOnce(fluidPostNos, {
        logLabel: '명령 게시물방어 initial sweep',
      });
      this.log(`🧹 게시물방어 initial sweep 분류 - ${fluidPostNos.length}개`);
    } else {
      this.log('🧹 게시물방어 initial sweep 분류 대상 없음');
    }

    const targetHtml = await fetchTargetListHTML(this.getIpConfig(), 1);
    const targetPosts = parseTargetPosts(targetHtml, headtextName, { includeUidTargets: false });
    const targetPostNos = extractPostNos(targetPosts);
    if (targetPostNos.length > 0) {
      const deleteResult = await deletePosts(this.getPostConfig(), targetPostNos);
      const deletedCount = Array.isArray(deleteResult.successNos) ? deleteResult.successNos.length : 0;
      const failedCount = Array.isArray(deleteResult.failedNos) ? deleteResult.failedNos.length : 0;
      this.log(`🗑️ 게시물방어 initial sweep 삭제 - 성공 ${deletedCount}개 / 실패 ${failedCount}개`);
    } else {
      this.log('🗑️ 게시물방어 initial sweep 삭제 대상 없음');
    }

    try {
      await this.postScheduler.start({
        source: 'manual',
        attackMode: 'default',
        cutoffPostNo,
      });
      await this.ipScheduler.start({
        source: 'manual',
        cutoffPostNo,
        delChk: true,
      });
    } catch (error) {
      if (this.postScheduler.isRunning) {
        await this.postScheduler.stop();
      }
      if (this.ipScheduler.isRunning) {
        await this.ipScheduler.stop();
      }
      throw error;
    }

    this.ownedPostScheduler = true;
    this.ownedIpScheduler = true;
    this.postDefenseCutoffPostNo = cutoffPostNo;
    this.extendPostDefense(now);
    this.log(`🛡️ 게시물방어 활성화 - cutoff #${cutoffPostNo}, ${formatRemainingMs(this.postDefenseUntilTs - now)} 유지`);
    await this.saveState();
  }

  async executeCommentDefenseCommand(sharedEsno) {
    const now = Date.now();
    if (this.isCommentDefenseActive()) {
      this.extendCommentDefense(now);
      this.log(`⏱️ 댓글방어 연장 - ${formatRemainingMs(this.commentDefenseUntilTs - now)} 남음`);
      await this.ensureOwnedDefensesStarted();
      await this.saveState();
      return;
    }

    this.phase = PHASE.EXECUTING_COMMENT_DEFENSE;
    await this.saveState();

    if (!this.shouldAllowCommentDefenseStart()) {
      throw new Error('댓글 자동화가 실행 중이라 댓글방어 child를 시작할 수 없습니다.');
    }

    const { posts, esno } = await fetchPostList(this.getCommentConfig(), 1);
    const candidatePosts = (Array.isArray(posts) ? posts : []).filter((post) => Number(post?.commentCount) > 0);
    if (candidatePosts.length > 0) {
      await this.commentScheduler.cleanupPostsOnce(candidatePosts, {
        sharedEsno: esno || sharedEsno,
        source: 'manual',
        attackMode: 'default',
        logLabel: '명령 댓글방어 initial sweep',
      });
      this.log(`🧹 댓글방어 initial sweep 완료 - 댓글 있는 글 ${candidatePosts.length}개`);
    } else {
      this.log('🧹 댓글방어 initial sweep 대상 없음');
    }

    await this.commentScheduler.start({
      source: 'manual',
      commentAttackMode: 'default',
    });

    this.ownedCommentScheduler = true;
    this.extendCommentDefense(now);
    this.log(`🛡️ 댓글방어 활성화 - ${formatRemainingMs(this.commentDefenseUntilTs - now)} 유지`);
    await this.saveState();
  }

  async handleExpiredDefenses() {
    const now = Date.now();

    if (this.postDefenseUntilTs > 0 && this.postDefenseUntilTs <= now) {
      await this.stopOwnedPostDefense('⏹️ 게시물방어 10분 유지가 끝나 자동 종료했습니다.');
    }

    if (this.commentDefenseUntilTs > 0 && this.commentDefenseUntilTs <= now) {
      await this.stopOwnedCommentDefense('⏹️ 댓글방어 10분 유지가 끝나 자동 종료했습니다.');
    }
  }

  async syncOwnedDefenseState() {
    await this.handleExpiredDefenses();
    await this.ensureOwnedDefensesStarted({
      allowPostDefense: this.shouldAllowPostDefenseStart(),
      allowCommentDefense: this.shouldAllowCommentDefenseStart(),
    });
  }

  async ensureOwnedDefensesStarted(options = {}) {
    const allowPostDefense = options.allowPostDefense !== false;
    const allowCommentDefense = options.allowCommentDefense !== false;

    if (!this.isRunning) {
      return false;
    }

    let restarted = false;

    if (allowPostDefense && this.isPostDefenseActive()) {
      if (this.ownedPostScheduler && !this.postScheduler.isRunning) {
        await this.postScheduler.start({
          source: 'manual',
          attackMode: 'default',
          cutoffPostNo: this.postDefenseCutoffPostNo,
        });
        this.log('🔁 게시물방어 child 복원 - 게시글 분류 재시작');
        restarted = true;
      } else if (
        this.ownedPostScheduler
        && this.postScheduler.isRunning
        && !this.postScheduler.runPromise
        && typeof this.postScheduler.ensureRunLoop === 'function'
      ) {
        this.postScheduler.log?.('🔁 명령 게시물방어 ownership 복원으로 게시글 분류 루프를 재개합니다.');
        this.postScheduler.ensureRunLoop();
        this.log('🔁 게시물방어 child 복원 - 게시글 분류 루프 재개');
        restarted = true;
      }

      if (this.ownedIpScheduler && !this.ipScheduler.isRunning) {
        await this.ipScheduler.start({
          source: 'manual',
          cutoffPostNo: this.postDefenseCutoffPostNo,
          delChk: true,
        });
        this.log('🔁 게시물방어 child 복원 - IP 차단 재시작');
        restarted = true;
      } else if (
        this.ownedIpScheduler
        && this.ipScheduler.isRunning
        && !this.ipScheduler.runPromise
        && typeof this.ipScheduler.ensureRunLoop === 'function'
      ) {
        this.ipScheduler.log?.('🔁 명령 게시물방어 ownership 복원으로 IP 차단 루프를 재개합니다.');
        this.ipScheduler.ensureRunLoop();
        this.log('🔁 게시물방어 child 복원 - IP 차단 루프 재개');
        restarted = true;
      }
    }

    if (allowCommentDefense && this.isCommentDefenseActive() && this.ownedCommentScheduler) {
      if (!this.commentScheduler.isRunning) {
        await this.commentScheduler.start({
          source: 'manual',
          commentAttackMode: 'default',
        });
        this.log('🔁 댓글방어 child 복원 - 댓글 방어 재시작');
        restarted = true;
      } else if (
        !this.commentScheduler.runPromise
        && typeof this.commentScheduler.ensureRunLoop === 'function'
      ) {
        this.commentScheduler.log?.('🔁 명령 댓글방어 ownership 복원으로 댓글 방어 루프를 재개합니다.');
        this.commentScheduler.ensureRunLoop();
        this.log('🔁 댓글방어 child 복원 - 댓글 방어 루프 재개');
        restarted = true;
      }
    }

    if (restarted) {
      await this.saveState();
    }
    return restarted;
  }

  async handleOwnedChildStopped(feature) {
    const normalizedFeature = String(feature || '').trim();

    if (normalizedFeature === 'comment' && this.ownedCommentScheduler) {
      await this.stopOwnedCommentDefense('ℹ️ 댓글 방어를 수동으로 중지해 명령 댓글방어 ownership을 종료했습니다.');
      return true;
    }

    if ((normalizedFeature === 'post' && this.ownedPostScheduler) || (normalizedFeature === 'ip' && this.ownedIpScheduler)) {
      await this.stopOwnedPostDefense('ℹ️ 게시글 분류/IP 차단을 수동으로 중지해 명령 게시물방어 ownership을 종료했습니다.');
      return true;
    }

    return false;
  }

  async stopOwnedPostDefense(reason) {
    if (!this.ownedPostScheduler && !this.ownedIpScheduler && this.postDefenseUntilTs <= 0) {
      return false;
    }

    if (this.ownedPostScheduler && this.postScheduler.isRunning) {
      await this.postScheduler.stop();
    }

    if (this.ownedIpScheduler && this.ipScheduler.isRunning) {
      await this.ipScheduler.stop();
    }

    this.ownedPostScheduler = false;
    this.ownedIpScheduler = false;
    this.postDefenseUntilTs = 0;
    this.postDefenseCutoffPostNo = 0;
    if (reason) {
      this.log(reason);
    }
    await this.saveState();
    return true;
  }

  async stopOwnedCommentDefense(reason) {
    if (!this.ownedCommentScheduler && this.commentDefenseUntilTs <= 0) {
      return false;
    }

    if (this.ownedCommentScheduler && this.commentScheduler.isRunning) {
      await this.commentScheduler.stop();
    }

    this.ownedCommentScheduler = false;
    this.commentDefenseUntilTs = 0;
    if (reason) {
      this.log(reason);
    }
    await this.saveState();
    return true;
  }

  extendPostDefense(now = Date.now()) {
    this.postDefenseUntilTs = now + this.config.holdMs;
  }

  extendCommentDefense(now = Date.now()) {
    this.commentDefenseUntilTs = now + this.config.holdMs;
  }

  isPostDefenseActive() {
    return this.postDefenseUntilTs > Date.now() && (this.ownedPostScheduler || this.ownedIpScheduler);
  }

  isCommentDefenseActive() {
    return this.commentDefenseUntilTs > Date.now() && this.ownedCommentScheduler;
  }

  isOwningFeature(feature) {
    if (feature === 'comment') {
      return this.ownedCommentScheduler;
    }
    if (feature === 'post') {
      return this.ownedPostScheduler;
    }
    if (feature === 'ip') {
      return this.ownedIpScheduler;
    }
    return false;
  }

  isTrustedUserId(userId) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      return false;
    }

    return (Array.isArray(this.config.trustedUsers) ? this.config.trustedUsers : [])
      .some((user) => String(user?.userId || '').trim() === normalizedUserId);
  }

  markCommandCommentProcessed(commentNo) {
    const normalizedCommentNo = normalizeCommentNo(commentNo);
    if (!normalizedCommentNo) {
      return;
    }

    this.processedCommandCommentNos = [
      normalizedCommentNo,
      ...this.processedCommandCommentNos.filter((item) => item !== normalizedCommentNo),
    ].slice(0, 200);
  }

  getCommentConfig() {
    return {
      ...this.commentScheduler.config,
      galleryId: this.config.galleryId,
    };
  }

  getPostConfig() {
    return {
      ...this.postScheduler.config,
      galleryId: this.config.galleryId,
      headtextId: this.config.headtextId,
    };
  }

  getIpConfig() {
    return {
      ...this.ipScheduler.config,
      galleryId: this.config.galleryId,
      headtextId: this.config.headtextId,
      delChk: true,
    };
  }

  getNextWakeDelayMs() {
    const candidates = [this.config.pollIntervalMs];
    if (this.postDefenseUntilTs > 0) {
      candidates.push(Math.max(1000, this.postDefenseUntilTs - Date.now()));
    }
    if (this.commentDefenseUntilTs > 0) {
      candidates.push(Math.max(1000, this.commentDefenseUntilTs - Date.now()));
    }
    return Math.max(1000, Math.min(...candidates.filter((value) => Number.isFinite(value) && value > 0)));
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[TrustedCommandDefense] ${message}`);
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
          pollCount: this.pollCount,
          startedAt: this.startedAt,
          lastPollAt: this.lastPollAt,
          seededAt: this.seededAt,
          seeded: this.seeded,
          lastSeenCommentNo: this.lastSeenCommentNo,
          processedCommandCommentNos: this.processedCommandCommentNos.slice(0, 200),
          lastCommandType: this.lastCommandType,
          lastCommandCommentNo: this.lastCommandCommentNo,
          lastCommandUserId: this.lastCommandUserId,
          lastCommandAt: this.lastCommandAt,
          postDefenseUntilTs: this.postDefenseUntilTs,
          commentDefenseUntilTs: this.commentDefenseUntilTs,
          ownedPostScheduler: this.ownedPostScheduler,
          ownedIpScheduler: this.ownedIpScheduler,
          ownedCommentScheduler: this.ownedCommentScheduler,
          postDefenseCutoffPostNo: this.postDefenseCutoffPostNo,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[TrustedCommandDefense] 상태 저장 실패:', error.message);
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
      this.pollCount = Math.max(0, Number(schedulerState.pollCount) || 0);
      this.startedAt = String(schedulerState.startedAt || '');
      this.lastPollAt = String(schedulerState.lastPollAt || '');
      this.seededAt = String(schedulerState.seededAt || '');
      this.seeded = Boolean(schedulerState.seeded);
      this.lastSeenCommentNo = normalizeCommentNo(schedulerState.lastSeenCommentNo);
      this.processedCommandCommentNos = normalizeProcessedCommentNos(schedulerState.processedCommandCommentNos);
      this.lastCommandType = String(schedulerState.lastCommandType || '');
      this.lastCommandCommentNo = normalizeCommentNo(schedulerState.lastCommandCommentNo);
      this.lastCommandUserId = String(schedulerState.lastCommandUserId || '');
      this.lastCommandAt = String(schedulerState.lastCommandAt || '');
      this.postDefenseUntilTs = Math.max(0, Number(schedulerState.postDefenseUntilTs) || 0);
      this.commentDefenseUntilTs = Math.max(0, Number(schedulerState.commentDefenseUntilTs) || 0);
      this.ownedPostScheduler = Boolean(schedulerState.ownedPostScheduler);
      this.ownedIpScheduler = Boolean(schedulerState.ownedIpScheduler);
      this.ownedCommentScheduler = Boolean(schedulerState.ownedCommentScheduler);
      this.postDefenseCutoffPostNo = Math.max(0, Number(schedulerState.postDefenseCutoffPostNo) || 0);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...schedulerState.config,
      });
    } catch (error) {
      console.error('[TrustedCommandDefense] 상태 복원 실패:', error.message);
    }
  }

  async resumeIfNeeded() {
    if (this.runPromise) {
      return;
    }

    await this.loadState();
    if (this.isRunning) {
      this.log('🔁 저장된 신뢰댓글 명령 방어 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      pollCount: this.pollCount,
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      seededAt: this.seededAt,
      seeded: this.seeded,
      lastSeenCommentNo: this.lastSeenCommentNo,
      lastCommandType: this.lastCommandType,
      lastCommandCommentNo: this.lastCommandCommentNo,
      lastCommandUserId: this.lastCommandUserId,
      lastCommandAt: this.lastCommandAt,
      postDefenseUntilTs: this.postDefenseUntilTs,
      commentDefenseUntilTs: this.commentDefenseUntilTs,
      ownedPostScheduler: this.ownedPostScheduler,
      ownedIpScheduler: this.ownedIpScheduler,
      ownedCommentScheduler: this.ownedCommentScheduler,
      postDefenseCutoffPostNo: this.postDefenseCutoffPostNo,
      trustedUserCount: Array.isArray(this.config.trustedUsers) ? this.config.trustedUsers.length : 0,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }
}

function normalizeConfig(config = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config || {}),
  };

  const galleryId = String(merged.galleryId || '').trim();
  const headtextId = String(merged.headtextId || '').trim();
  const commandTarget = parseCommandPostTarget(
    merged.commandPostUrl || merged.commandPostNo || '',
    galleryId,
  );
  const trustedUsers = parseTrustedUsersText(merged.trustedUsersText || serializeTrustedUsersText(merged.trustedUsers));

  return {
    galleryId,
    headtextId,
    commandPostUrl: commandTarget.success ? commandTarget.commandPostUrl : '',
    commandGalleryId: commandTarget.success ? commandTarget.commandGalleryId : '',
    commandPostNo: commandTarget.success ? commandTarget.commandPostNo : '',
    trustedUsersText: serializeTrustedUsersText(trustedUsers),
    trustedUsers,
    commandPrefix: String(merged.commandPrefix || DEFAULT_CONFIG.commandPrefix).trim() || DEFAULT_CONFIG.commandPrefix,
    pollIntervalMs: clampNumber(merged.pollIntervalMs, 10000, 300000, DEFAULT_CONFIG.pollIntervalMs),
    holdMs: clampNumber(merged.holdMs, 60000, 3600000, DEFAULT_CONFIG.holdMs),
    recentCommentPages: clampNumber(merged.recentCommentPages, 1, 5, DEFAULT_CONFIG.recentCommentPages),
  };
}

function normalizePhase(phase) {
  return Object.values(PHASE).includes(phase) ? phase : PHASE.IDLE;
}

function normalizeCommentNo(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function normalizeProcessedCommentNos(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeCommentNo(value))
      .filter(Boolean),
  )].slice(0, 200);
}

function compareCommentNo(left, right) {
  return (Number(left) || 0) - (Number(right) || 0);
}

function getMaxCommentNo(comments = []) {
  return (Array.isArray(comments) ? comments : []).reduce((maxNo, comment) => {
    const commentNo = normalizeCommentNo(comment?.no);
    return compareCommentNo(commentNo, maxNo) > 0 ? commentNo : maxNo;
  }, '');
}

function getMaxNumericString(left, right) {
  return compareCommentNo(left, right) >= 0 ? normalizeCommentNo(left) : normalizeCommentNo(right);
}

function getMaxPostNo(posts = []) {
  return (Array.isArray(posts) ? posts : []).reduce((maxNo, post) => {
    const postNo = Number(post?.no) || 0;
    return postNo > maxNo ? postNo : maxNo;
  }, 0);
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function formatRemainingMs(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil((Number(remainingMs) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}초`;
  }
  return `${minutes}분 ${seconds}초`;
}

export {
  DEFAULT_CONFIG,
  PHASE,
  Scheduler,
  normalizeConfig,
};
