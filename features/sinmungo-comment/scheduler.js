import {
  DEFAULT_CONFIG,
  cancelManualChallenge,
  normalizeConfig,
  normalizeMemo,
  normalizePostNo,
  prepareAnonymousManualChallenge,
  refreshAnonymousManualChallenge,
  submitComment,
  submitPreparedAnonymousChallenge,
} from './api.js';

const STORAGE_KEY = 'sinmungoCommentSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  PREPARING_CHALLENGE: 'PREPARING_CHALLENGE',
  WAITING_CODE: 'WAITING_CODE',
  SUBMITTING: 'SUBMITTING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
};

class Scheduler {
  constructor(dependencies = {}) {
    this.submitComment = dependencies.submitComment || submitComment;
    this.prepareAnonymousManualChallenge = dependencies.prepareAnonymousManualChallenge
      || prepareAnonymousManualChallenge;
    this.refreshAnonymousManualChallenge = dependencies.refreshAnonymousManualChallenge
      || refreshAnonymousManualChallenge;
    this.submitPreparedAnonymousChallenge = dependencies.submitPreparedAnonymousChallenge
      || submitPreparedAnonymousChallenge;
    this.cancelManualChallenge = dependencies.cancelManualChallenge || cancelManualChallenge;

    this.isRunning = false;
    this.runPromise = null;
    this.startAbortController = null;
    this.phase = PHASE.IDLE;
    this.startedAt = '';
    this.finishedAt = '';
    this.lastSubmittedAt = '';
    this.lastVerifiedAt = '';
    this.lastSuccessAt = '';
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.lastTargetPostNo = '';
    this.lastSubmittedMemo = '';
    this.lastCommentNo = '';
    this.totalSubmittedCount = 0;
    this.totalFailedCount = 0;
    this.pendingChallenge = null;
    this.logs = [];

    this.config = normalizeConfig(DEFAULT_CONFIG);
  }

  getStartBlockReason() {
    if (!normalizePostNo(this.config.postNo)) {
      return '게시물 번호를 저장한 뒤 시작하세요.';
    }

    if (!normalizeMemo(this.config.memo)) {
      return '댓글 문구를 저장한 뒤 시작하세요.';
    }

    if (this.config.submitMode === 'anonymous' && String(this.config.password || '').trim().length < 2) {
      return '유동/비회원 테스트 비밀번호는 2자 이상 입력하세요.';
    }

    return '';
  }

  async start() {
    if (this.isRunning || this.runPromise) {
      this.log('⚠️ 이미 신문고 댓글 등록이 실행 중입니다.');
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
    this.startAbortController = new AbortController();
    this.phase = this.config.submitMode === 'anonymous'
      ? PHASE.PREPARING_CHALLENGE
      : PHASE.SUBMITTING;
    this.startedAt = new Date().toISOString();
    this.finishedAt = '';
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.lastTargetPostNo = normalizePostNo(this.config.postNo);
    this.lastSubmittedMemo = normalizeMemo(this.config.memo);
    this.pendingChallenge = null;
    this.log(`🟡 #${this.lastTargetPostNo} 신문고 댓글 등록 시작 (${getSubmitModeLabel(this.config.submitMode)})`);
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop(reason = '🔴 신문고 댓글 등록 중지.') {
    if (!this.isRunning && !this.startAbortController && !this.pendingChallenge) {
      this.log('⚠️ 이미 신문고 댓글 등록이 정지 상태입니다.');
      await this.saveState();
      return;
    }

    const hadPendingChallenge = Boolean(this.pendingChallenge);
    this.isRunning = false;
    this.finishedAt = new Date().toISOString();
    if (this.startAbortController) {
      this.startAbortController.abort();
    }
    if (hadPendingChallenge) {
      await this.cancelPreparedChallenge(false);
    }
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
    });
  }

  async run() {
    const abortController = this.startAbortController || new AbortController();
    this.startAbortController = abortController;

    try {
      let result = null;
      if (this.config.submitMode === 'anonymous') {
        const prepareResult = await this.prepareAnonymousRun(abortController.signal);
        if (prepareResult?.waitingForCode) {
          return;
        }
        result = prepareResult?.result || null;
      } else {
        result = await this.submitComment(this.config, {
          submitMode: this.config.submitMode,
          postNo: this.config.postNo,
          memo: this.config.memo,
          replyNo: this.config.replyNo,
          signal: abortController.signal,
        });
      }

      await this.applySubmitResult(result);
    } catch (error) {
      if (error?.name === 'AbortError') {
        this.finishedAt = new Date().toISOString();
        if (this.phase !== PHASE.WAITING_CODE) {
          this.phase = PHASE.IDLE;
        }
        return;
      }

      this.phase = PHASE.ERROR;
      this.finishedAt = new Date().toISOString();
      this.lastErrorAt = this.finishedAt;
      this.lastErrorMessage = String(error?.message || '댓글 등록 중 알 수 없는 오류');
      this.totalFailedCount += 1;
      this.pendingChallenge = null;
      this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 댓글 등록 오류 - ${this.lastErrorMessage}`);
    } finally {
      if (this.phase !== PHASE.WAITING_CODE) {
        this.isRunning = false;
      }
      this.startAbortController = null;
      await this.saveState();
    }
  }

  async prepareAnonymousRun(signal) {
    this.phase = PHASE.PREPARING_CHALLENGE;
    await this.saveState();

    const prepared = await this.prepareAnonymousManualChallenge(this.config, {
      postNo: this.config.postNo,
      signal,
      requestedName: this.config.name,
    });

    if (!prepared?.success) {
      return { result: prepared };
    }

    if (prepared.requiresManualCode) {
      this.pendingChallenge = normalizePendingChallenge(prepared.challenge);
      this.phase = PHASE.WAITING_CODE;
      this.log(`🟠 #${this.lastTargetPostNo || this.config.postNo} 인증코드 입력 대기 - popup에 뜬 이미지를 보고 코드를 입력하세요.`);
      await this.saveState();
      return { waitingForCode: true };
    }

    this.phase = PHASE.SUBMITTING;
    this.log(`🟡 #${this.lastTargetPostNo || this.config.postNo} 인증코드 없이 바로 댓글 등록을 진행합니다.`);
    const result = await this.submitPreparedAnonymousChallenge(this.config, prepared.challenge, {
      postNo: this.config.postNo,
      memo: this.config.memo,
      replyNo: this.config.replyNo,
      name: this.config.name,
      password: this.config.password,
      recommend: this.config.recommend,
      signal,
      closeTab: true,
    });
    return { result };
  }

  async submitPreparedAnonymousCode(code, name = '') {
    if (!this.isRunning || this.phase !== PHASE.WAITING_CODE || !this.pendingChallenge) {
      this.log('⚠️ 현재 입력 대기 중인 인증코드 작업이 없습니다.');
      await this.saveState();
      return;
    }

    const normalizedCode = String(code || '').trim();
    const normalizedName = String(name || '').trim();
    if (this.pendingChallenge.requiresCode && !normalizedCode) {
      this.log('⚠️ 인증코드를 입력한 뒤 댓글 등록을 누르세요.');
      await this.saveState();
      return;
    }

    if (this.pendingChallenge.nameEditable && !normalizedName) {
      this.log('⚠️ 유동 닉네임을 입력한 뒤 댓글 등록을 누르세요.');
      await this.saveState();
      return;
    }

    const challenge = normalizePendingChallenge(this.pendingChallenge);
    this.phase = PHASE.SUBMITTING;
    this.finishedAt = '';
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.log(`🟡 #${this.lastTargetPostNo || this.config.postNo} 인증코드 제출 후 댓글 등록을 진행합니다.`);
    await this.saveState();

    const abortController = new AbortController();
    this.startAbortController = abortController;

    try {
      const result = await this.submitPreparedAnonymousChallenge(this.config, challenge, {
        postNo: this.config.postNo,
        memo: this.config.memo,
        replyNo: this.config.replyNo,
        name: normalizedName || challenge.anonymousName || this.config.name,
        password: this.config.password,
        code: normalizedCode,
        recommend: this.config.recommend,
        signal: abortController.signal,
        closeTab: true,
      });
      this.pendingChallenge = null;

      if (!result?.success && result?.failureType === 'captcha') {
        await this.reprepareAfterCaptchaFailure(result, abortController.signal);
        return;
      }

      await this.applySubmitResult(result);
    } catch (error) {
      if (error?.name === 'AbortError') {
        this.finishedAt = new Date().toISOString();
        this.phase = PHASE.IDLE;
        return;
      }

      this.phase = PHASE.ERROR;
      this.finishedAt = new Date().toISOString();
      this.lastErrorAt = this.finishedAt;
      this.lastErrorMessage = String(error?.message || '댓글 등록 중 알 수 없는 오류');
      this.totalFailedCount += 1;
      this.pendingChallenge = null;
      this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 댓글 등록 오류 - ${this.lastErrorMessage}`);
    } finally {
      if (this.phase !== PHASE.WAITING_CODE) {
        this.isRunning = false;
      }
      this.startAbortController = null;
      await this.saveState();
    }
  }

  async refreshPreparedAnonymousChallenge() {
    if (!this.isRunning || !this.pendingChallenge) {
      this.log('⚠️ 새로 받을 인증코드 작업이 없습니다.');
      await this.saveState();
      return;
    }

    const currentChallenge = normalizePendingChallenge(this.pendingChallenge);
    this.phase = PHASE.PREPARING_CHALLENGE;
    this.log(`🟡 #${this.lastTargetPostNo || this.config.postNo} 인증코드 이미지를 새로 준비합니다.`);
    await this.saveState();

    const abortController = new AbortController();
    this.startAbortController = abortController;

    try {
      const prepared = await this.refreshAnonymousManualChallenge(this.config, currentChallenge, {
        postNo: this.config.postNo,
        signal: abortController.signal,
        requestedName: this.config.name,
      });

      if (!prepared?.success) {
        this.pendingChallenge = null;
        this.phase = PHASE.ERROR;
        this.finishedAt = new Date().toISOString();
        this.lastErrorAt = this.finishedAt;
        this.lastErrorMessage = String(prepared?.message || '인증코드 이미지를 새로 준비하지 못했습니다.');
        this.totalFailedCount += 1;
        this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 인증코드 새로고침 실패 - ${this.lastErrorMessage}`);
        return;
      }

      this.pendingChallenge = normalizePendingChallenge(prepared.challenge);
      this.phase = PHASE.WAITING_CODE;
      this.lastErrorAt = '';
      this.lastErrorMessage = '';
      this.log(`🟠 #${this.lastTargetPostNo || this.config.postNo} 새 인증코드 준비 완료 - popup에서 다시 입력하세요.`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        this.phase = PHASE.IDLE;
        return;
      }

      this.pendingChallenge = null;
      this.phase = PHASE.ERROR;
      this.finishedAt = new Date().toISOString();
      this.lastErrorAt = this.finishedAt;
      this.lastErrorMessage = String(error?.message || '인증코드 새로고침 중 오류가 발생했습니다.');
      this.totalFailedCount += 1;
      this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 인증코드 새로고침 오류 - ${this.lastErrorMessage}`);
    } finally {
      if (this.phase !== PHASE.WAITING_CODE) {
        this.isRunning = false;
      }
      this.startAbortController = null;
      await this.saveState();
    }
  }

  async cancelPreparedChallenge(logCancel = true) {
    if (!this.pendingChallenge) {
      return;
    }

    const challenge = normalizePendingChallenge(this.pendingChallenge);
    this.pendingChallenge = null;
    await this.cancelManualChallenge(challenge);
    if (logCancel) {
      this.log(`🔴 #${this.lastTargetPostNo || this.config.postNo} 인증코드 대기를 취소했습니다.`);
    }
  }

  async handleTrackedTabRemoved(tabId) {
    const trackedTabId = Number(this.pendingChallenge?.tabId || 0);
    if (!trackedTabId || trackedTabId !== Number(tabId || 0)) {
      return;
    }

    this.pendingChallenge = null;
    this.isRunning = false;
    this.phase = PHASE.ERROR;
    this.finishedAt = new Date().toISOString();
    this.lastErrorAt = this.finishedAt;
    this.lastErrorMessage = '인증코드 준비 탭이 닫혀 작업을 종료했습니다.';
    this.totalFailedCount += 1;
    this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 인증코드 준비 탭이 닫혀 작업을 종료했습니다.`);
    await this.saveState();
  }

  async handleTrackedTabUpdated(tabId, changeInfo, tab) {
    const trackedTabId = Number(this.pendingChallenge?.tabId || 0);
    if (!trackedTabId || trackedTabId !== Number(tabId || 0)) {
      return;
    }

    const nextUrl = String(changeInfo?.url || tab?.url || tab?.pendingUrl || '').trim();
    if (!nextUrl) {
      return;
    }

    if (!isExpectedTrackedTabUrl(nextUrl, this.pendingChallenge)) {
      await this.cancelPreparedChallenge(false);
      this.isRunning = false;
      this.phase = PHASE.ERROR;
      this.finishedAt = new Date().toISOString();
      this.lastErrorAt = this.finishedAt;
      this.lastErrorMessage = '인증코드 준비 탭이 다른 페이지로 이동해 작업을 종료했습니다.';
      this.totalFailedCount += 1;
      this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 인증코드 준비 탭이 다른 페이지로 이동해 작업을 종료했습니다.`);
      await this.saveState();
    }
  }

  async reprepareAfterCaptchaFailure(result, signal) {
    this.totalFailedCount += 1;
    this.log(`⚠️ #${this.lastTargetPostNo || this.config.postNo} 인증코드가 틀렸거나 만료돼 새 이미지를 다시 준비합니다.`);
    this.phase = PHASE.PREPARING_CHALLENGE;
    await this.saveState();

    const prepared = await this.prepareAnonymousManualChallenge(this.config, {
      postNo: this.config.postNo,
      signal,
      requestedName: this.config.name,
    });

    if (!prepared?.success) {
      this.phase = PHASE.ERROR;
      this.finishedAt = new Date().toISOString();
      this.lastErrorAt = this.finishedAt;
      this.lastErrorMessage = String(prepared?.message || result?.message || '새 인증코드를 준비하지 못했습니다.');
      this.pendingChallenge = null;
      this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 인증코드 재준비 실패 - ${this.lastErrorMessage}`);
      return;
    }

    if (!prepared.requiresManualCode) {
      const retryResult = await this.submitPreparedAnonymousChallenge(this.config, prepared.challenge, {
        postNo: this.config.postNo,
        memo: this.config.memo,
        replyNo: this.config.replyNo,
        name: this.config.name,
        password: this.config.password,
        recommend: this.config.recommend,
        signal,
        closeTab: true,
      });
      await this.applySubmitResult(retryResult);
      return;
    }

    this.pendingChallenge = normalizePendingChallenge(prepared.challenge);
    this.phase = PHASE.WAITING_CODE;
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.log(`🟠 #${this.lastTargetPostNo || this.config.postNo} 새 인증코드 준비 완료 - popup에서 다시 입력하세요.`);
  }

  async applySubmitResult(result) {
    if (!result?.success) {
      this.phase = PHASE.ERROR;
      this.finishedAt = new Date().toISOString();
      this.lastErrorAt = this.finishedAt;
      this.lastErrorMessage = String(result?.message || '댓글 등록 실패');
      this.totalFailedCount += 1;
      this.log(`❌ #${this.lastTargetPostNo || this.config.postNo} 댓글 등록 실패 - ${this.lastErrorMessage}`);
      return;
    }

    const completedAt = new Date().toISOString();
    this.phase = PHASE.SUCCESS;
    this.finishedAt = completedAt;
    this.lastSubmittedAt = completedAt;
    this.lastVerifiedAt = String(result.verifiedAt || completedAt);
    this.lastSuccessAt = completedAt;
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.lastTargetPostNo = String(result.postNo || this.config.postNo || '').trim();
    this.lastSubmittedMemo = String(result.memo || this.config.memo || '').trim();
    this.lastCommentNo = String(result.commentNo || '').trim();
    this.totalSubmittedCount += 1;
    this.pendingChallenge = null;
    this.log(`🟢 #${this.lastTargetPostNo} 댓글 등록 완료${this.lastCommentNo ? ` (댓글 #${this.lastCommentNo})` : ''}`);
  }

  async saveState() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          isRunning: this.isRunning,
          phase: this.phase,
          startedAt: this.startedAt,
          finishedAt: this.finishedAt,
          lastSubmittedAt: this.lastSubmittedAt,
          lastVerifiedAt: this.lastVerifiedAt,
          lastSuccessAt: this.lastSuccessAt,
          lastErrorAt: this.lastErrorAt,
          lastErrorMessage: this.lastErrorMessage,
          lastTargetPostNo: this.lastTargetPostNo,
          lastSubmittedMemo: this.lastSubmittedMemo,
          lastCommentNo: this.lastCommentNo,
          totalSubmittedCount: this.totalSubmittedCount,
          totalFailedCount: this.totalFailedCount,
          pendingChallenge: this.pendingChallenge,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[SinmungoCommentScheduler] 상태 저장 실패:', error.message);
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
      this.startedAt = String(schedulerState.startedAt || '');
      this.finishedAt = String(schedulerState.finishedAt || '');
      this.lastSubmittedAt = String(schedulerState.lastSubmittedAt || '');
      this.lastVerifiedAt = String(schedulerState.lastVerifiedAt || '');
      this.lastSuccessAt = String(schedulerState.lastSuccessAt || '');
      this.lastErrorAt = String(schedulerState.lastErrorAt || '');
      this.lastErrorMessage = String(schedulerState.lastErrorMessage || '');
      this.lastTargetPostNo = String(schedulerState.lastTargetPostNo || '');
      this.lastSubmittedMemo = String(schedulerState.lastSubmittedMemo || '');
      this.lastCommentNo = String(schedulerState.lastCommentNo || '');
      this.totalSubmittedCount = Math.max(0, Number(schedulerState.totalSubmittedCount) || 0);
      this.totalFailedCount = Math.max(0, Number(schedulerState.totalFailedCount) || 0);
      this.pendingChallenge = normalizePendingChallenge(schedulerState.pendingChallenge);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...(schedulerState.config || {}),
      });

      if (!this.isRunning && this.pendingChallenge) {
        await this.cancelPreparedChallenge(false);
        this.phase = PHASE.IDLE;
        await this.saveState();
        return;
      }

      if (this.isRunning && this.phase === PHASE.WAITING_CODE && this.pendingChallenge) {
        await this.cancelPreparedChallenge(false);
        this.isRunning = false;
        this.phase = PHASE.ERROR;
        this.finishedAt = new Date().toISOString();
        this.lastErrorAt = this.finishedAt;
        this.lastErrorMessage = '브라우저 background가 다시 시작되어 인증코드 대기가 만료됐습니다. 토글 ON으로 다시 준비하세요.';
        this.log('ℹ️ background 재시작으로 기존 인증코드 대기를 만료 처리했습니다. 다시 준비하세요.');
        await this.saveState();
        return;
      }

      if (this.isRunning) {
        this.isRunning = false;
        this.phase = this.lastSuccessAt ? PHASE.SUCCESS : PHASE.IDLE;
        this.finishedAt = new Date().toISOString();
        this.log('ℹ️ 신문고 댓글 등록은 1회성 작업이라 중간 실행 상태를 자동 복원하지 않았습니다.');
        await this.saveState();
      }
    } catch (error) {
      console.error('[SinmungoCommentScheduler] 상태 복원 실패:', error.message);
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastSubmittedAt: this.lastSubmittedAt,
      lastVerifiedAt: this.lastVerifiedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorMessage: this.lastErrorMessage,
      lastTargetPostNo: this.lastTargetPostNo,
      lastSubmittedMemo: this.lastSubmittedMemo,
      lastCommentNo: this.lastCommentNo,
      totalSubmittedCount: this.totalSubmittedCount,
      totalFailedCount: this.totalFailedCount,
      pendingChallenge: this.pendingChallenge,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }

  log(message) {
    const timestamp = new Date().toLocaleTimeString('ko-KR', {
      hour12: false,
    });
    this.logs.unshift(`[${timestamp}] ${message}`);
    if (this.logs.length > 50) {
      this.logs = this.logs.slice(0, 50);
    }
  }
}

function normalizePhase(value) {
  return Object.values(PHASE).includes(String(value || '').trim())
    ? String(value || '').trim()
    : PHASE.IDLE;
}

function normalizePendingChallenge(challenge = null) {
  if (!challenge || typeof challenge !== 'object') {
    return null;
  }

  const postNo = normalizePostNo(challenge.postNo);
  const challengeId = String(challenge.challengeId || '').trim();
  const tabId = Math.max(0, Number(challenge.tabId) || 0);
  if (!challengeId || !postNo || tabId <= 0) {
    return null;
  }

  return {
    challengeId,
    tabId,
    tabUrl: String(challenge.tabUrl || '').trim(),
    postNo,
    galleryId: String(challenge.galleryId || '').trim(),
    galleryType: String(challenge.galleryType || '').trim(),
    baseUrl: String(challenge.baseUrl || '').trim(),
    preparedAt: String(challenge.preparedAt || '').trim(),
    captchaImageUrl: String(challenge.captchaImageUrl || '').trim(),
    requiresCode: Boolean(challenge.requiresCode),
    useGallNick: String(challenge.useGallNick || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
    gallNickName: String(challenge.gallNickName || '').trim(),
    anonymousName: String(challenge.anonymousName || '').trim(),
    anonymousNameVisible: Boolean(challenge.anonymousNameVisible),
    nameEditable: Boolean(challenge.nameEditable),
    passwordRequired: Boolean(challenge.passwordRequired),
    passwordMinLength: Math.max(0, Number(challenge.passwordMinLength) || 0),
  };
}

function isExpectedTrackedTabUrl(url = '', challenge = null) {
  if (!challenge) {
    return false;
  }

  try {
    const parsedUrl = new URL(String(url || ''));
    const galleryId = String(challenge.galleryId || '').trim();
    const postNo = String(challenge.postNo || '').trim();
    if (!/\/(?:m?gallery)\/board\/view\/?/i.test(parsedUrl.pathname)) {
      return false;
    }
    if (galleryId && parsedUrl.searchParams.get('id') !== galleryId) {
      return false;
    }
    if (postNo && parsedUrl.searchParams.get('no') !== postNo) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getSubmitModeLabel(value = '') {
  return String(value || '').trim().toLowerCase() === 'anonymous'
    ? '유동용 테스트'
    : '고닉용 테스트';
}

export {
  DEFAULT_CONFIG,
  PHASE,
  Scheduler,
  normalizeConfig,
};
