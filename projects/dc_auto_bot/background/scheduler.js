import {
  callCliHelperRecord,
  callCliHelperJudge,
  DEFAULT_CONFIG,
  delay,
  executeDeleteAndBan,
  extractEsno,
  fetchPostListHTML,
  fetchRecentComments,
  fetchPostPage,
  fetchUserActivityStats,
} from './api.js';
import {
  buildCommandKey,
  extractRecommendState,
  extractPostContentForLlm,
  isDeletedComment,
  isTrustedUser,
  normalizeReportTarget,
  normalizeTrustedUsers,
  parseCommandComment,
  parseRegularBoardPosts,
  sortCommentsByNo,
  extractPostAuthorMeta,
} from './parser.js';

const STORAGE_KEY = 'reportBotSchedulerState';
const LEGACY_DEFAULT_HELPER_TIMEOUT_MS = 20000;
const POST_DOMINANT_RATIO_THRESHOLD = 0.9;
const RECENT_REGULAR_POST_LIMIT = 100;
const RECENT_REGULAR_POST_CACHE_MS = 5000;
const RECENT_REGULAR_POST_MAX_PAGES = 10;
const PHASE = {
  IDLE: 'IDLE',
  SEEDING: 'SEEDING',
  RUNNING: 'RUNNING',
};

class Scheduler {
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.lastPollAt = '';
    this.pollCount = 0;
    this.totalProcessedCommands = 0;
    this.totalAttemptedCommands = 0;
    this.totalSucceededCommands = 0;
    this.totalFailedCommands = 0;
    this.lastSeenCommentNo = '0';
    this.processedCommandKeys = [];
    this.processedTargetPostNos = [];
    this.dailyUsage = {};
    this.logs = [];
    this.seeded = false;
    this.runPromise = null;
    this.activeAbortController = null;
    this.recentRegularPostsCache = {
      fetchedAtMs: 0,
      posts: [],
    };
  }

  async loadState() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const state = stored[STORAGE_KEY];
    if (!state) {
      return;
    }

    this.config = {
      ...DEFAULT_CONFIG,
      ...(state.config || {}),
      trustedUsers: normalizeTrustedUsers(state.config?.trustedUsers || []),
    };
    this.config.cliHelperTimeoutMs = migrateLegacyHelperTimeout(this.config.cliHelperTimeoutMs);
    this.isRunning = Boolean(state.isRunning);
    this.phase = state.phase || (this.isRunning ? PHASE.SEEDING : PHASE.IDLE);
    this.lastPollAt = state.lastPollAt || '';
    this.pollCount = Number(state.pollCount || 0);
    this.totalProcessedCommands = Number(state.totalProcessedCommands || 0);
    this.totalAttemptedCommands = Number(state.totalAttemptedCommands || 0);
    this.totalSucceededCommands = Number(state.totalSucceededCommands || 0);
    this.totalFailedCommands = Number(state.totalFailedCommands || 0);
    this.lastSeenCommentNo = String(state.lastSeenCommentNo || '0').trim() || '0';
    this.processedCommandKeys = normalizeStringArray(state.processedCommandKeys);
    this.processedTargetPostNos = normalizeStringArray(state.processedTargetPostNos);
    this.dailyUsage = normalizeDailyUsage(state.dailyUsage);
    this.logs = normalizeLogs(state.logs);
    this.seeded = Boolean(state.seeded);
  }

  async saveState() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        config: {
          ...this.config,
          trustedUsers: normalizeTrustedUsers(this.config.trustedUsers),
        },
        isRunning: this.isRunning,
        phase: this.phase,
        lastPollAt: this.lastPollAt,
        pollCount: this.pollCount,
        totalProcessedCommands: this.totalProcessedCommands,
        totalAttemptedCommands: this.totalAttemptedCommands,
        totalSucceededCommands: this.totalSucceededCommands,
        totalFailedCommands: this.totalFailedCommands,
        lastSeenCommentNo: this.lastSeenCommentNo,
        processedCommandKeys: trimRecentArray(this.processedCommandKeys, 5000),
        processedTargetPostNos: trimRecentArray(this.processedTargetPostNos, 5000),
        dailyUsage: this.dailyUsage,
        logs: trimArray(this.logs, 200),
        seeded: this.seeded,
      },
    });
  }

  getStatus() {
    return {
      config: {
        ...this.config,
        trustedUsers: normalizeTrustedUsers(this.config.trustedUsers),
      },
      isRunning: this.isRunning,
      phase: this.phase,
      lastPollAt: this.lastPollAt,
      pollCount: this.pollCount,
      totalProcessedCommands: this.totalProcessedCommands,
      totalAttemptedCommands: this.totalAttemptedCommands,
      totalSucceededCommands: this.totalSucceededCommands,
      totalFailedCommands: this.totalFailedCommands,
      processedTargetCount: this.processedTargetPostNos.length,
      trustedUserCount: normalizeTrustedUsers(this.config.trustedUsers).length,
      logs: this.logs,
    };
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    const normalization = normalizeReportTarget(this.config.reportTarget);
    if (!normalization.success) {
      throw new Error(normalization.message);
    }

    if (normalization.targetGalleryId && normalization.targetGalleryId !== this.config.galleryId) {
      throw new Error('신문고 게시물 링크의 갤러리 ID가 현재 갤러리 설정과 다릅니다.');
    }

    this.config.reportTarget = normalization.reportTarget;
    this.config.reportPostNo = normalization.reportPostNo;
    this.config.trustedUsers = normalizeTrustedUsers(this.config.trustedUsers);

    this.isRunning = true;
    this.phase = PHASE.SEEDING;
    this.seeded = false;
    this.invalidateRecentRegularPostsCache();
    this.addLog('🟢 신문고 봇 시작');
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    this.isRunning = false;
    this.activeAbortController?.abort();
    if (this.runPromise) {
      await this.runPromise;
    }

    this.phase = PHASE.IDLE;
    this.invalidateRecentRegularPostsCache();
    this.addLog('🔴 신문고 봇 중지');
    await this.saveState();
  }

  ensureRunLoop() {
    if (!this.isRunning || this.runPromise) {
      return;
    }

    this.runPromise = this.run()
      .catch((error) => {
        console.error('[ReportBot] run loop 실패:', error);
        this.addLog(`❌ 런루프 오류: ${error.message}`);
      })
      .finally(async () => {
        this.runPromise = null;
        await this.saveState();
      });
  }

  async run() {
    while (this.isRunning) {
      await this.pollOnce();
      if (!this.isRunning) {
        break;
      }

      await delayWhileRunning(this, Math.max(1000, Number(this.config.pollIntervalMs) || 60000));
    }
  }

  async pollOnce() {
    this.lastPollAt = new Date().toISOString();
    this.pollCount += 1;

    try {
      const reportPostNo = String(this.config.reportPostNo || '').trim();
      if (!/^\d+$/.test(reportPostNo)) {
        this.addLog('⚠️ 신문고 게시물 번호가 없어 폴링을 건너뜁니다.');
        this.phase = PHASE.IDLE;
        await this.saveState();
        return;
      }

      const pollController = new AbortController();
      this.activeAbortController = pollController;

      const pageHtml = await fetchPostPage(this.config, reportPostNo, pollController.signal);
      if (!this.isRunning) {
        return;
      }

      const esno = extractEsno(pageHtml);
      if (!esno) {
        this.addLog('⚠️ 신문고 게시물 e_s_n_o 추출 실패');
        await this.saveState();
        return;
      }

      const { comments, fetchedPages } = await fetchRecentComments(this.config, reportPostNo, esno, 2, pollController.signal);
      if (!this.isRunning) {
        return;
      }

      const visibleComments = dedupeCommentsByNo(
        sortCommentsByNo(comments).filter((comment) => !isDeletedComment(comment)),
      );
      const currentMaxCommentNo = getMaxCommentNo(visibleComments);

      if (!this.seeded) {
        this.seedVisibleComments(visibleComments, currentMaxCommentNo);
        this.phase = PHASE.RUNNING;
        this.addLog(`🌱 초기 댓글 시드 완료 (${visibleComments.length}개 / ${fetchedPages}페이지)`);
        await this.saveState();
        return;
      }

      this.phase = PHASE.RUNNING;
      const newComments = visibleComments.filter((comment) => Number(comment?.no || 0) > Number(this.lastSeenCommentNo || 0));
      if (newComments.length === 0) {
        this.bumpLastSeenCommentNo(currentMaxCommentNo);
        this.addLog(`📡 새 댓글 없음 (${fetchedPages}페이지 확인)`);
        await this.saveState();
        return;
      }

      this.addLog(`📡 새 댓글 ${newComments.length}개 확인 (${fetchedPages}페이지)`);
      for (const comment of newComments) {
        if (!this.isRunning) {
          return;
        }

        await this.processComment(comment, pollController.signal);
      }

      this.bumpLastSeenCommentNo(currentMaxCommentNo);
      await this.saveState();
    } catch (error) {
      if (error?.name === 'AbortError') {
        return;
      }

      this.addLog(`❌ 폴링 오류: ${error.message}`);
      await this.saveState();
    } finally {
      this.activeAbortController = null;
    }
  }

  seedVisibleComments(comments, currentMaxCommentNo) {
    this.lastSeenCommentNo = currentMaxCommentNo;
    this.seeded = true;
  }

  bumpLastSeenCommentNo(commentNo) {
    const numericCurrent = Number(this.lastSeenCommentNo || 0);
    const numericNext = Number(commentNo || 0);
    if (numericNext > numericCurrent) {
      this.lastSeenCommentNo = String(numericNext);
    }
  }

  async processComment(comment, signal) {
    const commentNo = String(comment?.no || '').trim();
    const trustedUser = isTrustedUser(comment, this.config.trustedUsers);
    if (!trustedUser) {
      return;
    }

    const parsedCommand = parseCommandComment(comment, this.config.commandPrefix);
    if (!parsedCommand.success) {
      this.addLog(`📝 [${trustedUser.label}] 명령 아님 #${commentNo} - ${parsedCommand.reason}`);
      return;
    }

    const commandKey = buildCommandKey(
      this.config.galleryId,
      parsedCommand.targetGalleryId || this.config.galleryId,
      parsedCommand.targetPostNo,
    );

    if (this.hasProcessedCommandKey(commandKey)) {
      this.addLog(`↩️ [${trustedUser.label}] 중복 링크 무시 #${parsedCommand.targetPostNo}`);
      return;
    }

    if (this.isDailyLimitExceeded(trustedUser.userId)) {
      this.addLog(`⛔ [${trustedUser.label}] 일일 2회 제한 초과`);
      return;
    }

    const isForeignGallery = parsedCommand.targetGalleryId
      && parsedCommand.targetGalleryId !== this.config.galleryId;

    this.markCommandAttempted(commandKey, parsedCommand.targetPostNo, trustedUser.userId);
    this.totalProcessedCommands += 1;
    this.totalAttemptedCommands += 1;

    if (isForeignGallery) {
      this.totalFailedCommands += 1;
      this.addLog(`⚠️ [${trustedUser.label}] 다른 갤 링크 무시 #${parsedCommand.targetPostNo}`);
      return;
    }

    const pageHtml = await fetchPostPage(this.config, parsedCommand.targetPostNo, signal);
    const authorCheck = await this.evaluateTargetAuthorFromPageHtml(pageHtml, this.config, signal);
    const content = extractPostContentForLlm(pageHtml, this.config.baseUrl);

    if (!authorCheck.success) {
      this.totalFailedCommands += 1;
      this.addLog(`❌ [${trustedUser.label}] 작성자 판정 실패 #${parsedCommand.targetPostNo} - ${authorCheck.message}`);
      return;
    }

    if (!authorCheck.allowed) {
      this.totalFailedCommands += 1;
      this.addLog(`⏭️ [${trustedUser.label}] 자동 처리 제외 #${parsedCommand.targetPostNo} - ${authorCheck.message}`);
      return;
    }

    const recommendState = extractRecommendState(pageHtml);
    if (!recommendState.success) {
      this.totalFailedCommands += 1;
      this.addLog(`❌ [${trustedUser.label}] 개념글 판정 실패 #${parsedCommand.targetPostNo} - ${recommendState.message}`);
      return;
    }

    if (recommendState.isConcept) {
      this.totalFailedCommands += 1;
      this.addLog(`⏭️ [${trustedUser.label}] 개념글 자동 처리 제외 #${parsedCommand.targetPostNo}`);
      return;
    }

    let recentRegularPosts = null;
    try {
      recentRegularPosts = await this.getRecentRegularPosts(signal);
    } catch (error) {
      this.totalFailedCommands += 1;
      this.addLog(`❌ [${trustedUser.label}] 최근 100개 판정 실패 #${parsedCommand.targetPostNo} - ${error.message}`);
      return;
    }

    const isWithinRecentWindow = recentRegularPosts.some((post) => String(post.no) === String(parsedCommand.targetPostNo));
    if (!isWithinRecentWindow) {
      this.totalFailedCommands += 1;
      this.addLog(`⏭️ [${trustedUser.label}] 최근 100개 밖 자동 처리 제외 #${parsedCommand.targetPostNo}`);
      return;
    }

    const helperResult = await callCliHelperJudge(
      this.config,
      {
        targetUrl: parsedCommand.targetUrl,
        title: content.title,
        bodyText: content.bodyText,
        imageUrls: content.imageUrls,
        reportReason: parsedCommand.reasonText,
        requestLabel: trustedUser.label,
        authorFilter: mapAuthorFilterResult(authorCheck),
      },
      signal,
    );

    if (!helperResult.success) {
      this.totalFailedCommands += 1;
      this.addLog(`❌ [${trustedUser.label}] LLM helper 실패 #${parsedCommand.targetPostNo} - ${helperResult.message || '응답 확인 실패'}`);
      return;
    }

    await persistTransparencyRecordBestEffort(this.config, buildTransparencyRecord({
      id: createRecordId(),
      source: 'auto_report',
      targetUrl: parsedCommand.targetUrl,
      targetPostNo: parsedCommand.targetPostNo,
      reportReason: parsedCommand.reasonText,
      title: content.title,
      bodyText: content.bodyText,
      imageUrls: content.imageUrls,
      decision: helperResult.decision,
      confidence: helperResult.confidence,
      policyIds: helperResult.policy_ids || [],
      reason: helperResult.reason || '',
    }), signal);

    if (helperResult.decision !== 'allow') {
      this.totalFailedCommands += 1;
      this.addLog(`⏭️ [${trustedUser.label}] LLM 보류 #${parsedCommand.targetPostNo} - ${formatLlmDecisionSummary(helperResult)}`);
      return;
    }

    const confidenceThreshold = clampConfidenceThreshold(this.config.llmConfidenceThreshold);
    if (helperResult.confidence < confidenceThreshold) {
      this.totalFailedCommands += 1;
      this.addLog(`⏭️ [${trustedUser.label}] LLM 신뢰도 부족 #${parsedCommand.targetPostNo} - ${formatLlmDecisionSummary(helperResult)} / threshold=${confidenceThreshold.toFixed(2)}`);
      return;
    }

    const actionResult = await executeDeleteAndBan(
      this.config,
      parsedCommand.targetPostNo,
      trustedUser.label,
      parsedCommand.reasonText,
      signal,
    );

    if (actionResult.success) {
      this.totalSucceededCommands += 1;
      this.addLog(`✅ [${trustedUser.label}] 처리 완료 #${parsedCommand.targetPostNo} (${authorCheck.message} / ${formatLlmDecisionSummary(helperResult)} / ${actionResult.reasonText})`);
      return;
    }

    this.totalFailedCommands += 1;
    this.addLog(`❌ [${trustedUser.label}] 처리 실패 #${parsedCommand.targetPostNo} - ${actionResult.message || '응답 확인 실패'}`);
  }

  async evaluateTargetAuthor(targetPostNo, signal, config = this.config) {
    const evaluationConfig = {
      ...this.config,
      ...(config || {}),
    };

    if (evaluationConfig.applyAuthorFilter === false) {
      return { success: true, allowed: true, message: '작성자 필터 비활성화' };
    }

    const pageHtml = await fetchPostPage(evaluationConfig, targetPostNo, signal);
    return this.evaluateTargetAuthorFromPageHtml(pageHtml, evaluationConfig, signal);
  }

  async evaluateTargetAuthorFromPageHtml(pageHtml, config = this.config, signal) {
    const evaluationConfig = {
      ...this.config,
      ...(config || {}),
    };

    if (evaluationConfig.applyAuthorFilter === false) {
      return { success: true, allowed: true, message: '작성자 필터 비활성화' };
    }

    const authorMeta = extractPostAuthorMeta(pageHtml);
    if (!authorMeta.success) {
      return { success: false, message: authorMeta.message };
    }

    if (!authorMeta.uid && authorMeta.ip) {
      return { success: true, allowed: true, message: `유동(${authorMeta.nick || 'ㅇㅇ'} ${authorMeta.ip})` };
    }

    if (!authorMeta.uid) {
      return { success: false, message: '작성자 uid/ip를 모두 확인하지 못했습니다.' };
    }

    const stats = await fetchUserActivityStats(evaluationConfig, authorMeta.uid, signal);
    if (!stats.success) {
      return { success: false, message: `활동 통계 조회 실패: ${stats.message}` };
    }

    const threshold = Math.max(1, Number(evaluationConfig.lowActivityThreshold) || 100);
    const totalActivityCount = Math.max(0, Number(stats.totalActivityCount) || 0);
    const postCount = Math.max(0, Number(stats.postCount) || 0);
    const commentCount = Math.max(0, Number(stats.commentCount) || 0);
    const postRatio = totalActivityCount > 0 ? postCount / totalActivityCount : 0;

    if (totalActivityCount < threshold) {
      return {
        success: true,
        allowed: true,
        message: `깡계(${authorMeta.nick || authorMeta.uid} ${totalActivityCount})`,
      };
    }

    if (postRatio >= POST_DOMINANT_RATIO_THRESHOLD) {
      return {
        success: true,
        allowed: true,
        message: `글편중(${authorMeta.nick || authorMeta.uid} 글 ${postCount} 댓글 ${commentCount} 비중 ${postRatio.toFixed(2)})`,
      };
    }

    return {
      success: true,
      allowed: false,
      message: `일반 계정(${authorMeta.nick || authorMeta.uid} 글 ${postCount} 댓글 ${commentCount} 비중 ${postRatio.toFixed(2)})`,
    };
  }

  hasProcessedCommandKey(commandKey) {
    return this.processedCommandKeys.includes(String(commandKey));
  }

  markCommandAttempted(commandKey, targetPostNo, userId) {
    if (!this.hasProcessedCommandKey(commandKey)) {
      this.processedCommandKeys.push(String(commandKey));
      this.processedCommandKeys = trimRecentArray(this.processedCommandKeys, 5000);
    }

    if (!this.processedTargetPostNos.includes(String(targetPostNo))) {
      this.processedTargetPostNos.push(String(targetPostNo));
      this.processedTargetPostNos = trimRecentArray(this.processedTargetPostNos, 5000);
    }

    this.incrementDailyUsage(userId);
  }

  isDailyLimitExceeded(userId) {
    const todayKey = getKstDateKey();
    const usage = Number(this.dailyUsage?.[userId]?.[todayKey] || 0);
    return usage >= Math.max(1, Number(this.config.dailyLimitPerUser) || 2);
  }

  incrementDailyUsage(userId) {
    const todayKey = getKstDateKey();
    if (!this.dailyUsage[userId]) {
      this.dailyUsage[userId] = {};
    }

    this.dailyUsage[userId][todayKey] = Number(this.dailyUsage[userId][todayKey] || 0) + 1;
    pruneDailyUsage(this.dailyUsage);
  }

  resetStats() {
    this.phase = this.isRunning ? PHASE.SEEDING : PHASE.IDLE;
    this.lastPollAt = '';
    this.pollCount = 0;
    this.totalProcessedCommands = 0;
    this.totalAttemptedCommands = 0;
    this.totalSucceededCommands = 0;
    this.totalFailedCommands = 0;
    this.lastSeenCommentNo = '0';
    this.processedCommandKeys = [];
    this.processedTargetPostNos = [];
    this.dailyUsage = {};
    this.logs = [];
    this.seeded = false;
  }

  addTrustedUser(userId, label) {
    this.config.trustedUsers = normalizeTrustedUsers([
      ...this.config.trustedUsers,
      { userId, label },
    ]);
  }

  removeTrustedUser(userId) {
    this.config.trustedUsers = normalizeTrustedUsers(
      this.config.trustedUsers.filter((entry) => entry.userId !== userId),
    );
  }

  addLog(message) {
    const timestamp = formatKstTime(new Date());
    this.logs.unshift(`[${timestamp}] ${message}`);
    this.logs = trimArray(this.logs, 200);
  }

  invalidateRecentRegularPostsCache() {
    this.recentRegularPostsCache = {
      fetchedAtMs: 0,
      posts: [],
    };
  }

  async getRecentRegularPosts(signal) {
    const now = Date.now();
    if (
      this.recentRegularPostsCache.posts.length > 0
      && (now - this.recentRegularPostsCache.fetchedAtMs) < RECENT_REGULAR_POST_CACHE_MS
    ) {
      return this.recentRegularPostsCache.posts;
    }

    const posts = [];
    const seen = new Set();

    for (let page = 1; page <= RECENT_REGULAR_POST_MAX_PAGES && posts.length < RECENT_REGULAR_POST_LIMIT; page += 1) {
      const html = await fetchPostListHTML(this.config, page, signal);
      const parsedPosts = parseRegularBoardPosts(html);
      if (parsedPosts.length === 0) {
        break;
      }

      for (const post of parsedPosts) {
        const postNo = String(post.no || '').trim();
        if (!postNo || seen.has(postNo)) {
          continue;
        }

        seen.add(postNo);
        posts.push({
          no: postNo,
          subject: String(post.subject || ''),
          currentHead: String(post.currentHead || ''),
        });

        if (posts.length >= RECENT_REGULAR_POST_LIMIT) {
          break;
        }
      }
    }

    if (posts.length === 0) {
      throw new Error('전체글 목록에서 최근 regular row를 찾지 못했습니다.');
    }

    this.recentRegularPostsCache = {
      fetchedAtMs: now,
      posts,
    };

    return posts;
  }
}

function mapAuthorFilterResult(authorCheck) {
  if (!authorCheck || authorCheck.success === false) {
    return 'unknown';
  }

  const message = String(authorCheck.message || '');
  if (message.startsWith('유동(')) {
    return 'fluid';
  }
  if (message.startsWith('깡계(')) {
    return 'low_activity';
  }
  if (message.startsWith('글편중(')) {
    return 'post_dominant';
  }
  if (message.startsWith('일반 계정(')) {
    return 'normal';
  }

  return authorCheck.allowed ? 'allowed' : 'review';
}

function formatLlmDecisionSummary(result) {
  const decision = String(result?.decision || '').trim() || 'unknown';
  const confidence = Number(result?.confidence);
  const confidenceText = Number.isFinite(confidence) ? confidence.toFixed(2) : 'n/a';
  const policyIds = Array.isArray(result?.policy_ids) ? result.policy_ids.join(',') : '';
  const reason = String(result?.reason || '').replace(/\s+/g, ' ').trim();
  return `${decision} ${confidenceText}${policyIds ? ` [${policyIds}]` : ''}${reason ? ` ${reason}` : ''}`;
}

function clampConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0.85;
  }

  return Math.min(1, Math.max(0, numericValue));
}

function buildTransparencyRecord(input) {
  return {
    id: String(input.id || createRecordId()),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    targetUrl: String(input.targetUrl || ''),
    targetPostNo: String(input.targetPostNo || ''),
    reportReason: String(input.reportReason || ''),
    title: String(input.title || ''),
    bodyText: String(input.bodyText || ''),
    imageUrls: Array.isArray(input.imageUrls) ? input.imageUrls : [],
    source: 'auto_report',
    decision: String(input.decision || ''),
    confidence: input.confidence ?? null,
    policyIds: Array.isArray(input.policyIds) ? input.policyIds : [],
    reason: String(input.reason || ''),
  };
}

async function persistTransparencyRecordBestEffort(config, record, signal) {
  if (!record) {
    return;
  }

  try {
    const result = await callCliHelperRecord(config, record, signal);
    if (!result.success) {
      console.warn('[ReportBot] transparency record 저장 실패:', result.message);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }
    console.warn('[ReportBot] transparency record 저장 예외:', error.message);
  }
}

function createRecordId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `record_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeStringArray(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function migrateLegacyHelperTimeout(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return DEFAULT_CONFIG.cliHelperTimeoutMs;
  }

  if (numericValue === LEGACY_DEFAULT_HELPER_TIMEOUT_MS) {
    return DEFAULT_CONFIG.cliHelperTimeoutMs;
  }

  return numericValue;
}

function normalizeDailyUsage(dailyUsage) {
  if (!dailyUsage || typeof dailyUsage !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [userId, usageByDate] of Object.entries(dailyUsage)) {
    if (!usageByDate || typeof usageByDate !== 'object') {
      continue;
    }

    normalized[userId] = {};
    for (const [dateKey, count] of Object.entries(usageByDate)) {
      const numericCount = Number(count || 0);
      if (numericCount > 0) {
        normalized[userId][dateKey] = numericCount;
      }
    }
  }

  return normalized;
}

function dedupeCommentsByNo(comments = []) {
  const deduped = [];
  const seen = new Set();
  for (const comment of comments) {
    const commentNo = String(comment?.no || '').trim();
    if (!commentNo || seen.has(commentNo)) {
      continue;
    }

    seen.add(commentNo);
    deduped.push(comment);
  }

  return deduped;
}

function getMaxCommentNo(comments = []) {
  let maxCommentNo = 0;
  for (const comment of comments) {
    const commentNo = Number(comment?.no || 0);
    if (commentNo > maxCommentNo) {
      maxCommentNo = commentNo;
    }
  }

  return String(maxCommentNo);
}

function normalizeLogs(logs = []) {
  return trimArray(Array.isArray(logs) ? logs.map((entry) => String(entry || '')) : [], 200);
}

function trimArray(values, maxLength) {
  return values.slice(0, Math.max(0, maxLength));
}

function trimRecentArray(values, maxLength) {
  return values.slice(-Math.max(0, maxLength));
}

function getKstDateKey(now = new Date()) {
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const year = kst.getFullYear();
  const month = String(kst.getMonth() + 1).padStart(2, '0');
  const day = String(kst.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatKstTime(now = new Date()) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
}

function pruneDailyUsage(dailyUsage) {
  const todayKey = getKstDateKey();
  for (const usageByDate of Object.values(dailyUsage)) {
    for (const dateKey of Object.keys(usageByDate)) {
      if (dateKey !== todayKey) {
        delete usageByDate[dateKey];
      }
    }
  }
}

async function delayWhileRunning(scheduler, ms) {
  const startedAt = Date.now();
  while (scheduler.isRunning && Date.now() - startedAt < ms) {
    await delay(Math.min(250, ms - (Date.now() - startedAt)));
  }
}

export {
  DEFAULT_CONFIG,
  PHASE,
  STORAGE_KEY,
  Scheduler,
  normalizeDailyUsage,
  normalizeStringArray,
};
