import {
  DEFAULT_CONFIG,
  bumpPost,
  delay,
  normalizePostNo,
} from './api.js';

const STORAGE_KEY = 'bumpPostSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
};

class Scheduler {
  constructor(dependencies = {}) {
    this.bumpPost = dependencies.bumpPost || bumpPost;
    this.delayFn = dependencies.delayFn || delay;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.cycleCount = 0;
    this.startedAt = '';
    this.endsAt = '';
    this.nextRunAt = '';
    this.lastBumpedAt = '';
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.lastBumpedPostNo = '';
    this.totalBumpedCount = 0;
    this.totalFailedCount = 0;
    this.logs = [];

    this.config = normalizeConfig(DEFAULT_CONFIG);
  }

  getStartBlockReason() {
    if (!this.config.postNo) {
      return '게시물 번호를 저장한 뒤 시작하세요.';
    }

    if (!normalizePostNo(this.config.postNo)) {
      return '게시물 번호는 숫자만 입력할 수 있습니다.';
    }

    return '';
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 끌올 자동이 실행 중입니다.');
      return;
    }

    const startBlockReason = this.getStartBlockReason();
    if (startBlockReason) {
      this.log(`⚠️ ${startBlockReason}`);
      await this.saveState();
      return;
    }

    const now = new Date();
    this.isRunning = true;
    this.phase = PHASE.RUNNING;
    this.startedAt = now.toISOString();
    this.endsAt = new Date(now.getTime() + getDurationMs(this.config)).toISOString();
    this.nextRunAt = now.toISOString();
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.log(`🟢 끌올 자동 시작! (#${this.config.postNo} / ${this.config.durationMinutes}분 / ${this.config.intervalMinutes}분)`);
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop(reason = '🔴 끌올 자동 중지.') {
    if (!this.isRunning) {
      this.log('⚠️ 이미 끌올 자동이 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.nextRunAt = '';
    this.log(reason);
    await this.saveState();
  }

  async run() {
    while (this.isRunning) {
      if (hasExpired(this.endsAt)) {
        await this.stop('⏹️ 지속 시간이 끝나 끌올 자동을 종료했습니다.');
        break;
      }

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
        const nextRunAt = completedAt + getIntervalMs(this.config);
        if (nextRunAt > parseTimestamp(this.endsAt)) {
          this.nextRunAt = '';
          await this.saveState();
          await this.stop('⏹️ 다음 예약 시각이 지속 시간을 넘어 끌올 자동을 종료했습니다.');
          break;
        }

        this.nextRunAt = new Date(nextRunAt).toISOString();
        this.phase = PHASE.WAITING;
        this.log(`⏳ 다음 끌올 예정: ${formatTimestamp(this.nextRunAt)}`);
        await this.saveState();
      } catch (error) {
        this.phase = PHASE.WAITING;
        const nowIso = new Date().toISOString();
        this.lastErrorAt = nowIso;
        this.lastErrorMessage = String(error?.message || '알 수 없는 오류');
        this.totalFailedCount += 1;
        this.log(`❌ 끌올 자동 오류 - ${this.lastErrorMessage}`);

        if (!this.isRunning) {
          break;
        }

        const nextRunAt = Date.now() + getIntervalMs(this.config);
        if (nextRunAt > parseTimestamp(this.endsAt)) {
          this.nextRunAt = '';
          await this.saveState();
          await this.stop('⏹️ 오류 후 다음 예약 시각이 지속 시간을 넘어 끌올 자동을 종료했습니다.');
          break;
        }

        this.nextRunAt = new Date(nextRunAt).toISOString();
        await this.saveState();
      }
    }

    this.phase = PHASE.IDLE;
    await this.saveState();
  }

  async runCycle() {
    if (hasExpired(this.endsAt)) {
      this.isRunning = false;
      this.phase = PHASE.IDLE;
      this.nextRunAt = '';
      return;
    }

    const postNo = normalizePostNo(this.config.postNo);
    if (!postNo) {
      throw new Error('게시물 번호가 비어 있거나 비정상입니다.');
    }

    const result = await this.bumpPost(this.config, postNo);
    if (!result?.success) {
      const message = result?.message || '끌올 요청 실패';
      this.lastErrorAt = new Date().toISOString();
      this.lastErrorMessage = message;
      this.totalFailedCount += 1;
      this.log(`⚠️ #${postNo} 끌올 실패 - ${message}`);
      await this.saveState();
      return;
    }

    const nowIso = new Date().toISOString();
    this.lastBumpedAt = nowIso;
    this.lastBumpedPostNo = postNo;
    this.lastErrorAt = '';
    this.lastErrorMessage = '';
    this.totalBumpedCount += 1;
    this.log(`⬆️ #${postNo} 끌올 완료`);
    await this.saveState();
  }

  async saveState() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          isRunning: this.isRunning,
          phase: this.phase,
          cycleCount: this.cycleCount,
          startedAt: this.startedAt,
          endsAt: this.endsAt,
          nextRunAt: this.nextRunAt,
          lastBumpedAt: this.lastBumpedAt,
          lastErrorAt: this.lastErrorAt,
          lastErrorMessage: this.lastErrorMessage,
          lastBumpedPostNo: this.lastBumpedPostNo,
          totalBumpedCount: this.totalBumpedCount,
          totalFailedCount: this.totalFailedCount,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[BumpPostScheduler] 상태 저장 실패:', error.message);
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
      this.cycleCount = Math.max(0, Number(schedulerState.cycleCount) || 0);
      this.startedAt = String(schedulerState.startedAt || '');
      this.endsAt = String(schedulerState.endsAt || '');
      this.nextRunAt = String(schedulerState.nextRunAt || '');
      this.lastBumpedAt = String(schedulerState.lastBumpedAt || '');
      this.lastErrorAt = String(schedulerState.lastErrorAt || '');
      this.lastErrorMessage = String(schedulerState.lastErrorMessage || '');
      this.lastBumpedPostNo = String(schedulerState.lastBumpedPostNo || '');
      this.totalBumpedCount = Math.max(0, Number(schedulerState.totalBumpedCount) || 0);
      this.totalFailedCount = Math.max(0, Number(schedulerState.totalFailedCount) || 0);
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...(schedulerState.config || {}),
      });

      if (this.isRunning && hasExpired(this.endsAt)) {
        this.isRunning = false;
        this.phase = PHASE.IDLE;
        this.nextRunAt = '';
        this.log('ℹ️ 저장된 끌올 자동 지속 시간이 이미 끝나 자동 복원을 건너뜁니다.');
        await this.saveState();
      }
    } catch (error) {
      console.error('[BumpPostScheduler] 상태 복원 실패:', error.message);
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

  getStatus() {
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      cycleCount: this.cycleCount,
      startedAt: this.startedAt,
      endsAt: this.endsAt,
      nextRunAt: this.nextRunAt,
      lastBumpedAt: this.lastBumpedAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorMessage: this.lastErrorMessage,
      lastBumpedPostNo: this.lastBumpedPostNo,
      totalBumpedCount: this.totalBumpedCount,
      totalFailedCount: this.totalFailedCount,
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

function normalizeConfig(config = {}) {
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    postNo: normalizePostNo(config.postNo),
    durationMinutes: normalizePositiveInteger(config.durationMinutes, DEFAULT_CONFIG.durationMinutes),
    intervalMinutes: normalizePositiveInteger(config.intervalMinutes, DEFAULT_CONFIG.intervalMinutes),
  };
}

function getDurationMs(config = {}) {
  return normalizePositiveInteger(config.durationMinutes, DEFAULT_CONFIG.durationMinutes) * 60 * 1000;
}

function getIntervalMs(config = {}) {
  return normalizePositiveInteger(config.intervalMinutes, DEFAULT_CONFIG.intervalMinutes) * 60 * 1000;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(1, Number.parseInt(String(fallback ?? 1), 10) || 1);
  }

  return parsed;
}

function normalizePhase(value) {
  return Object.values(PHASE).includes(value) ? value : PHASE.IDLE;
}

function parseTimestamp(value) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasExpired(value) {
  const timestamp = parseTimestamp(value);
  return timestamp > 0 && Date.now() >= timestamp;
}

function formatTimestamp(value) {
  const parsed = parseTimestamp(value);
  if (parsed <= 0) {
    return '-';
  }

  return new Date(parsed).toLocaleString('ko-KR', { hour12: false });
}

async function delayWhileRunning(scheduler, waitMs) {
  const remainingMs = Math.max(0, Number(waitMs) || 0);
  if (remainingMs <= 0) {
    return;
  }

  let elapsedMs = 0;
  while (scheduler.isRunning && elapsedMs < remainingMs) {
    const chunkMs = Math.min(1000, remainingMs - elapsedMs);
    await scheduler.delayFn(chunkMs);
    elapsedMs += chunkMs;
  }
}

export {
  PHASE,
  Scheduler,
  normalizeConfig,
};
