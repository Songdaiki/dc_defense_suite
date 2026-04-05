import {
  DEFAULT_CONFIG,
  delay,
  fetchBoardListHtml,
  getRequestDelayWithJitter,
  isValidGalleryId,
  normalizeConfig,
  normalizeGalleryId,
} from './api.js';
import { parseRefluxCollectorTitles } from './parser.js';
import {
  appendRefluxCollectorTitles,
  clearAllRefluxCollectorTitles,
  loadRefluxCollectorTitlesForRun,
} from './store.js';
import { normalizeSemiconductorRefluxTitle } from '../post/attack-mode.js';

const STORAGE_KEY = 'refluxDatasetCollectorSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  COMPLETED: 'COMPLETED',
  INTERRUPTED: 'INTERRUPTED',
};

class Scheduler {
  constructor(dependencies = {}) {
    this.fetchBoardListHtml = dependencies.fetchBoardListHtml || fetchBoardListHtml;
    this.delayFn = dependencies.delayFn || delay;
    this.getDelayWithJitter = dependencies.getDelayWithJitter || getRequestDelayWithJitter;
    this.parseTitles = dependencies.parseTitles || parseRefluxCollectorTitles;
    this.normalizeTitle = dependencies.normalizeTitle || normalizeSemiconductorRefluxTitle;
    this.clearAllTitles = dependencies.clearAllTitles || clearAllRefluxCollectorTitles;
    this.appendTitles = dependencies.appendTitles || appendRefluxCollectorTitles;
    this.loadTitlesForRun = dependencies.loadTitlesForRun || loadRefluxCollectorTitlesForRun;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.runId = '';
    this.currentPage = 0;
    this.fetchedPageCount = 0;
    this.rawTitleCount = 0;
    this.normalizedTitleCount = 0;
    this.startedAt = '';
    this.finishedAt = '';
    this.lastError = '';
    this.logs = [];
    this.downloadReady = false;
    this.exportVersion = '';
    this.interrupted = false;
    this.collectedGalleryId = '';
    this.config = normalizeConfig(DEFAULT_CONFIG);

    this.runtimeTitleSet = new Set();
  }

  getStartBlockReason() {
    const galleryId = normalizeGalleryId(this.config.galleryId);
    if (!galleryId) {
      return '갤 ID를 저장한 뒤 시작하세요.';
    }

    if (!isValidGalleryId(galleryId)) {
      return '갤 ID는 영문/숫자/밑줄만 입력하세요.';
    }

    if (this.config.endPage < this.config.startPage) {
      return '끝 페이지는 시작 페이지보다 작을 수 없습니다.';
    }

    return '';
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 역류기글 수집이 실행 중입니다.');
      await this.saveState();
      return;
    }

    const startBlockReason = this.getStartBlockReason();
    if (startBlockReason) {
      this.log(`⚠️ ${startBlockReason}`);
      await this.saveState();
      return;
    }

    await this.clearCollectedData();

    this.isRunning = true;
    this.phase = PHASE.RUNNING;
    this.runId = buildRunId();
    this.currentPage = 0;
    this.fetchedPageCount = 0;
    this.rawTitleCount = 0;
    this.normalizedTitleCount = 0;
    this.startedAt = new Date().toISOString();
    this.finishedAt = '';
    this.lastError = '';
    this.logs = [];
    this.downloadReady = false;
    this.exportVersion = '';
    this.interrupted = false;
    this.collectedGalleryId = normalizeGalleryId(this.config.galleryId);
    this.runtimeTitleSet = new Set();
    this.log(`🟢 역류기글 수집 시작! (${this.config.galleryId} / ${this.config.startPage}~${this.config.endPage})`);
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop(reason = '🔴 역류기글 수집 중지.') {
    if (!this.isRunning) {
      this.log('⚠️ 이미 역류기글 수집이 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.log(reason);
    await this.saveState();
  }

  async run() {
    try {
      for (let page = this.config.startPage; page <= this.config.endPage; page += 1) {
        if (!this.isRunning) {
          break;
        }

        this.phase = PHASE.RUNNING;
        this.currentPage = page;
        await this.saveState();

        const html = await this.fetchBoardListHtml(this.config.galleryId, page);
        const titles = this.parseTitles(html);
        const normalizedNewTitles = collectNewNormalizedTitles(titles, this.normalizeTitle, this.runtimeTitleSet);

        this.fetchedPageCount += 1;
        this.rawTitleCount += titles.length;
        this.normalizedTitleCount = this.runtimeTitleSet.size;

        if (normalizedNewTitles.length > 0) {
          await this.appendTitles(this.runId, normalizedNewTitles);
        }

        this.log(`📄 ${page}페이지 수집 완료 - 원본 ${titles.length}개 / 신규 ${normalizedNewTitles.length}개 / 누적 고유 ${this.normalizedTitleCount}개`);
        await this.saveState();

        if (!this.isRunning || page >= this.config.endPage) {
          continue;
        }

        this.phase = PHASE.WAITING;
        await this.saveState();
        await delayWhileRunning(this, this.getDelayWithJitter(this.config));
      }

      if (!this.isRunning) {
        await this.saveState();
        return;
      }

      this.isRunning = false;
      this.phase = PHASE.COMPLETED;
      this.finishedAt = new Date().toISOString();
      this.downloadReady = this.normalizedTitleCount > 0;
      this.exportVersion = this.downloadReady ? buildDatasetVersion(this.finishedAt) : '';
      if (this.downloadReady) {
        this.log(`✅ 수집 완료 - 원본 ${this.rawTitleCount}개 / 정규화 고유 ${this.normalizedTitleCount}개 / JSON 다운로드 준비 완료`);
      } else {
        this.log('⚠️ 수집은 끝났지만 다운로드할 제목이 없습니다.');
      }
      await this.saveState();
    } catch (error) {
      this.isRunning = false;
      this.phase = PHASE.IDLE;
      this.lastError = String(error?.message || '알 수 없는 오류');
      this.log(`❌ 역류기글 수집 오류 - ${this.lastError}`);
      await this.saveState();
    }
  }

  async buildDownloadDescriptor() {
    if (!this.downloadReady || !this.runId) {
      return {
        success: false,
        message: '다운로드할 수집 결과가 없습니다.',
      };
    }

    const version = this.exportVersion || buildDatasetVersion(this.finishedAt || new Date().toISOString());
    const collectedGalleryId = this.collectedGalleryId || normalizeGalleryId(this.config.galleryId);

    return {
      success: true,
      runId: this.runId,
      collectedGalleryId,
      updatedAt: this.finishedAt || new Date().toISOString(),
      version,
      fileName: buildDownloadFileName(collectedGalleryId, version),
      titleCount: this.normalizedTitleCount,
    };
  }

  async clearCollectedData() {
    this.runtimeTitleSet = new Set();
    await this.clearAllTitles();
  }

  async saveState() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          isRunning: this.isRunning,
          phase: this.phase,
          runId: this.runId,
          currentPage: this.currentPage,
          fetchedPageCount: this.fetchedPageCount,
          rawTitleCount: this.rawTitleCount,
          normalizedTitleCount: this.normalizedTitleCount,
          startedAt: this.startedAt,
          finishedAt: this.finishedAt,
          lastError: this.lastError,
          logs: this.logs.slice(0, 50),
          downloadReady: this.downloadReady,
          exportVersion: this.exportVersion,
          interrupted: this.interrupted,
          collectedGalleryId: this.collectedGalleryId,
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[RefluxDatasetCollectorScheduler] 상태 저장 실패:', error.message);
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
      this.runId = String(schedulerState.runId || '');
      this.currentPage = Math.max(0, Number(schedulerState.currentPage) || 0);
      this.fetchedPageCount = Math.max(0, Number(schedulerState.fetchedPageCount) || 0);
      this.rawTitleCount = Math.max(0, Number(schedulerState.rawTitleCount) || 0);
      this.normalizedTitleCount = Math.max(0, Number(schedulerState.normalizedTitleCount) || 0);
      this.startedAt = String(schedulerState.startedAt || '');
      this.finishedAt = String(schedulerState.finishedAt || '');
      this.lastError = String(schedulerState.lastError || '');
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.downloadReady = Boolean(schedulerState.downloadReady);
      this.exportVersion = String(schedulerState.exportVersion || '');
      this.interrupted = Boolean(schedulerState.interrupted);
      this.collectedGalleryId = normalizeGalleryId(schedulerState.collectedGalleryId);
      this.config = normalizeConfig({
        ...this.config,
        ...(schedulerState.config || {}),
      });

      if (this.isRunning) {
        this.isRunning = false;
        this.phase = PHASE.INTERRUPTED;
        this.interrupted = true;
        this.downloadReady = false;
        this.exportVersion = '';
        this.log('ℹ️ 중단된 수집 작업이 있어 자동 복원을 건너뜁니다.');
        await this.saveState();
      }
    } catch (error) {
      console.error('[RefluxDatasetCollectorScheduler] 상태 복원 실패:', error.message);
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
      runId: this.runId,
      currentPage: this.currentPage,
      fetchedPageCount: this.fetchedPageCount,
      rawTitleCount: this.rawTitleCount,
      normalizedTitleCount: this.normalizedTitleCount,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastError: this.lastError,
      logs: this.logs.slice(0, 20),
      downloadReady: this.downloadReady,
      exportVersion: this.exportVersion,
      interrupted: this.interrupted,
      collectedGalleryId: this.collectedGalleryId,
      config: this.config,
    };
  }

  log(message) {
    const timestamp = new Date().toLocaleTimeString('ko-KR', {
      hour12: false,
    });
    this.logs.unshift(`[${timestamp}] ${message}`);
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(0, 100);
    }
  }
}

function collectNewNormalizedTitles(titles, normalizeTitle, runtimeTitleSet) {
  const nextTitles = [];
  (Array.isArray(titles) ? titles : []).forEach((title) => {
    const normalizedTitle = normalizeTitle(title);
    if (!normalizedTitle || runtimeTitleSet.has(normalizedTitle)) {
      return;
    }

    runtimeTitleSet.add(normalizedTitle);
    nextTitles.push(normalizedTitle);
  });
  return nextTitles;
}

function normalizePhase(value) {
  return Object.values(PHASE).includes(value) ? value : PHASE.IDLE;
}

function buildRunId(nowIso = new Date().toISOString()) {
  return `run-${nowIso.replace(/[-:.TZ]/g, '')}`;
}

function buildDatasetVersion(nowIso = new Date().toISOString()) {
  const date = new Date(nowIso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

function buildDownloadFileName(galleryId, version) {
  const normalizedGalleryId = normalizeGalleryId(galleryId) || 'unknown-gallery';
  return `reflux-title-set-${normalizedGalleryId}-${version}.json`;
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
