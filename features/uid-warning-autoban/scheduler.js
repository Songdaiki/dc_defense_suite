import {
  DEFAULT_CONFIG,
  DEFAULT_AVOID_REASON_TEXT,
  LEGACY_AVOID_REASON_TEXT,
  delay,
  fetchUidWarningAutoBanListHTML,
} from './api.js';
import {
  createUidBanTargetPosts,
  getNewestPostNo,
  getRecentRowsWithinWindow,
  groupRowsByUid,
  parseUidWarningAutoBanRows,
} from './parser.js';
import { executeBanWithDeleteFallback } from '../ip/ban-executor.js';
import { getOrFetchUidStats } from '../../background/uid-stats-cache.js';
import { getOrFetchUidGallogPrivacy } from '../../background/uid-gallog-privacy-cache.js';

const STORAGE_KEY = 'uidWarningAutoBanSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
};
const UID_ACTION_RETENTION_MS = 24 * 60 * 60 * 1000;

class Scheduler {
  constructor(dependencies = {}) {
    this.fetchListHtml = dependencies.fetchListHtml || fetchUidWarningAutoBanListHTML;
    this.parseRows = dependencies.parseRows || parseUidWarningAutoBanRows;
    this.fetchUidStats = dependencies.fetchUidStats || getOrFetchUidStats;
    this.fetchUidGallogPrivacy = dependencies.fetchUidGallogPrivacy || getOrFetchUidGallogPrivacy;
    this.executeBan = dependencies.executeBan || executeBanWithDeleteFallback;
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
    this.lastPageRowCount = 0;
    this.lastPageUidCount = 0;
    this.totalTriggeredUidCount = 0;
    this.totalBannedPostCount = 0;
    this.totalFailedPostCount = 0;
    this.deleteLimitFallbackCount = 0;
    this.banOnlyFallbackCount = 0;
    this.lastError = '';
    this.cycleCount = 0;
    this.logs = [];
    this.runtimeDeleteEnabled = Boolean(DEFAULT_CONFIG.delChk);
    this.lastDeleteLimitExceededAt = '';
    this.lastDeleteLimitMessage = '';
    this.recentUidActions = {};

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
    this.runtimeDeleteEnabled = Boolean(this.config.delChk);
    this.lastDeleteLimitExceededAt = '';
    this.lastDeleteLimitMessage = '';
    this.lastError = '';
    this.log('🟢 분탕자동차단 시작!');
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('⚠️ 이미 분탕자동차단이 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.currentPage = 1;
    this.nextRunAt = '';
    this.runtimeDeleteEnabled = Boolean(this.config.delChk);
    this.lastDeleteLimitExceededAt = '';
    this.lastDeleteLimitMessage = '';
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
          `✅ 사이클 #${this.cycleCount} 완료 - page1 글 ${this.lastPageRowCount}개 / uid ${this.lastPageUidCount}명 / 누적 제재 ${this.totalTriggeredUidCount}명`,
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
    pruneRecentUidActions(this.recentUidActions);
    const nowMs = Date.now();
    const html = await this.fetchListHtml(this.config, 1);
    const rows = this.parseRows(html);
    const groupedRows = groupRowsByUid(rows);
    this.lastPageRowCount = rows.length;
    this.lastPageUidCount = groupedRows.length;
    this.log(`📄 page1 uid snapshot ${rows.length}개 / uid ${groupedRows.length}명`);
    await this.saveState();

    let statsCandidateCount = 0;
    let statsFailureCount = 0;
    let statsSuccessCount = 0;
    let gallogCandidateCount = 0;
    let gallogFailureCount = 0;
    let gallogSuccessCount = 0;

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
      if (recentRows.length < getRecentPostThreshold(this.config)) {
        if (groupedEntry.rows.length >= getRecentPostThreshold(this.config)) {
          this.log(
            `ℹ️ ${groupedEntry.uid} 스킵 - page1 5분 텍스트 burst 글수 ${recentRows.length}개라 기준 ${getRecentPostThreshold(this.config)}개 미달`,
          );
        }
        continue;
      }

      const representativeNick = String(recentRows[0]?.nick || groupedEntry.rows[0]?.nick || '').trim();
      if (!isTwoConsonantNick(representativeNick)) {
        this.log(`ℹ️ ${groupedEntry.uid} 스킵 - 자음 2글자 닉네임 필터 미달 (최신 닉네임: ${representativeNick || '없음'})`);
        continue;
      }

      const newestPostNo = getNewestPostNo(countableRows);
      const actionKey = buildUidActionKey(this.config.galleryId, groupedEntry.uid);
      if (shouldSkipRecentUidAction(this.recentUidActions[actionKey], newestPostNo, nowMs, getRetryCooldownMs(this.config))) {
        this.log(`ℹ️ ${groupedEntry.uid} 스킵 - 새 글번호가 없어 같은 burst 재시도를 건너뜀`);
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
      if (gallogPrivacy.fullyPrivate !== true) {
        const privacySummary = [
          gallogPrivacy.postingPrivate ? '게시글 비공개' : '게시글 공개',
          gallogPrivacy.commentPrivate ? '댓글 비공개' : '댓글 공개',
        ].join(' / ');
        this.log(`ℹ️ ${groupedEntry.uid} 스킵 - 갤로그 필터 미달 (${privacySummary})`);
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
        `🚨 ${groupedEntry.uid} page1 5분 텍스트 burst ${recentRows.length}글 / 글비중 ${formatPostRatio(effectivePostRatio)}% / 갤로그 게시글·댓글 비공개 -> page1 ${targetPosts.length}개 제재 시작`,
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
    }

    if (statsCandidateCount > 0 && statsSuccessCount === 0 && statsFailureCount > 0) {
      this.lastError = '식별코드 활동 통계 조회에 실패해 이번 사이클을 건너뛰었습니다.';
    } else if (gallogCandidateCount > 0 && gallogSuccessCount === 0 && gallogFailureCount > 0) {
      this.lastError = '갤로그 공개/비공개 확인에 실패해 이번 사이클을 건너뛰었습니다.';
    }

    pruneRecentUidActions(this.recentUidActions);
  }

  activateDeleteLimitBanOnly(message = '') {
    const trimmedMessage = String(message || '').trim();
    const switched = this.runtimeDeleteEnabled;
    this.runtimeDeleteEnabled = false;
    this.lastDeleteLimitExceededAt = new Date().toISOString();
    this.lastDeleteLimitMessage = trimmedMessage;

    if (switched) {
      this.log('⚠️ 삭제 한도 초과 감지 - 토글 OFF할 때까지 분탕자동차단은 차단만 유지합니다.');
      if (trimmedMessage) {
        this.log(`⚠️ 삭제 한도 상세: ${trimmedMessage}`);
      }
    }
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
          lastPageRowCount: this.lastPageRowCount,
          lastPageUidCount: this.lastPageUidCount,
          totalTriggeredUidCount: this.totalTriggeredUidCount,
          totalBannedPostCount: this.totalBannedPostCount,
          totalFailedPostCount: this.totalFailedPostCount,
          deleteLimitFallbackCount: this.deleteLimitFallbackCount,
          banOnlyFallbackCount: this.banOnlyFallbackCount,
          lastError: this.lastError,
          cycleCount: this.cycleCount,
          runtimeDeleteEnabled: this.runtimeDeleteEnabled,
          lastDeleteLimitExceededAt: this.lastDeleteLimitExceededAt,
          lastDeleteLimitMessage: this.lastDeleteLimitMessage,
          recentUidActions: this.recentUidActions,
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
      this.lastPageRowCount = Math.max(0, Number(schedulerState.lastPageRowCount) || 0);
      this.lastPageUidCount = Math.max(0, Number(schedulerState.lastPageUidCount) || 0);
      this.totalTriggeredUidCount = Math.max(0, Number(schedulerState.totalTriggeredUidCount) || 0);
      this.totalBannedPostCount = Math.max(0, Number(schedulerState.totalBannedPostCount) || 0);
      this.totalFailedPostCount = Math.max(0, Number(schedulerState.totalFailedPostCount) || 0);
      this.deleteLimitFallbackCount = Math.max(0, Number(schedulerState.deleteLimitFallbackCount) || 0);
      this.banOnlyFallbackCount = Math.max(0, Number(schedulerState.banOnlyFallbackCount) || 0);
      this.lastError = String(schedulerState.lastError || '');
      this.cycleCount = Math.max(0, Number(schedulerState.cycleCount) || 0);
      this.runtimeDeleteEnabled = schedulerState.runtimeDeleteEnabled === undefined
        ? Boolean(schedulerState.config?.delChk)
        : Boolean(schedulerState.runtimeDeleteEnabled);
      this.lastDeleteLimitExceededAt = String(schedulerState.lastDeleteLimitExceededAt || '');
      this.lastDeleteLimitMessage = String(schedulerState.lastDeleteLimitMessage || '');
      this.recentUidActions = normalizeRecentUidActions(schedulerState.recentUidActions);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...readPersistedConfig(schedulerState.config),
      });
      pruneRecentUidActions(this.recentUidActions);
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
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      currentPage: this.currentPage,
      lastPollAt: this.lastPollAt,
      nextRunAt: this.nextRunAt,
      lastTriggeredUid: this.lastTriggeredUid,
      lastTriggeredPostCount: this.lastTriggeredPostCount,
      lastBurstRecentCount: this.lastBurstRecentCount,
      lastPageRowCount: this.lastPageRowCount,
      lastPageUidCount: this.lastPageUidCount,
      totalTriggeredUidCount: this.totalTriggeredUidCount,
      totalBannedPostCount: this.totalBannedPostCount,
      totalFailedPostCount: this.totalFailedPostCount,
      deleteLimitFallbackCount: this.deleteLimitFallbackCount,
      banOnlyFallbackCount: this.banOnlyFallbackCount,
      lastError: this.lastError,
      cycleCount: this.cycleCount,
      runtimeDeleteEnabled: this.runtimeDeleteEnabled,
      lastDeleteLimitExceededAt: this.lastDeleteLimitExceededAt,
      lastDeleteLimitMessage: this.lastDeleteLimitMessage,
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
  };
}

function buildPersistedConfig(config = {}) {
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
  };
}

function readPersistedConfig(raw = {}) {
  return buildPersistedConfig(raw);
}

function normalizeAvoidReasonText(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === LEGACY_AVOID_REASON_TEXT) {
    return DEFAULT_AVOID_REASON_TEXT;
  }

  return normalized;
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

function pruneRecentUidActions(entries = {}) {
  const nowMs = Date.now();
  for (const [key, value] of Object.entries(entries || {})) {
    const actionAtMs = parseTimestamp(value?.lastActionAt);
    if (actionAtMs <= 0 || nowMs - actionAtMs > UID_ACTION_RETENTION_MS) {
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

function isTwoConsonantNick(value) {
  return /^[ㄱ-ㅎ]{2}$/.test(String(value || '').trim());
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
