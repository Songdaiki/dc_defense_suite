import { delay } from '../reflux-dataset-collector/api.js';
import { locateBoardListPageFromViewUrl } from '../reflux-dataset-collector/page-locator.js';
import { parseRefluxCollectorTitles } from '../reflux-dataset-collector/parser.js';
import { normalizeSemiconductorRefluxTitle } from '../post/attack-mode.js';
import { reloadSemiconductorRefluxEffectiveMatcher } from '../post/semiconductor-reflux-effective-matcher.js';
import { saveOverlay } from '../post/semiconductor-reflux-overlay-store.js';
import {
  DEFAULT_CONFIG,
  buildOverlayId,
  buildTargetPages,
  normalizeConfig,
  parseValidatedViewUrl,
  validateConfig,
} from './api.js';
import { createListPageTransport } from './transport.js';

const STORAGE_KEY = 'refluxOverlayCollectorSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  LOCATING: 'LOCATING',
  FETCHING: 'FETCHING',
  SAVING: 'SAVING',
  COMPLETED: 'COMPLETED',
  INTERRUPTED: 'INTERRUPTED',
  FAILED: 'FAILED',
};

class Scheduler {
  constructor(dependencies = {}) {
    this.delayFn = dependencies.delayFn || delay;
    this.createTransport = dependencies.createTransport || createListPageTransport;
    this.locateBoardListPage = dependencies.locateBoardListPage || locateBoardListPageFromViewUrl;
    this.parseTitles = dependencies.parseTitles || parseRefluxCollectorTitles;
    this.normalizeTitle = dependencies.normalizeTitle || normalizeSemiconductorRefluxTitle;
    this.saveOverlayImpl = dependencies.saveOverlay || saveOverlay;
    this.reloadEffectiveMatcher = dependencies.reloadEffectiveMatcher || reloadSemiconductorRefluxEffectiveMatcher;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.currentPage = 0;
    this.galleryId = '';
    this.targetPostNo = 0;
    this.foundPage = 0;
    this.totalPageCount = 0;
    this.targetPageCount = 0;
    this.completedPageCount = 0;
    this.failedPageCount = 0;
    this.failedPages = [];
    this.rawTitleCount = 0;
    this.normalizedTitleCount = 0;
    this.appliedOverlayId = '';
    this.startedAt = '';
    this.finishedAt = '';
    this.lastError = '';
    this.logs = [];
    this.interrupted = false;
    this.config = normalizeConfig(DEFAULT_CONFIG);

    this.runtimeTitleSet = new Set();
    this.activeTransport = null;
    this.startAbortController = null;
    this.locateAbortController = null;
    this.pageAbortControllers = new Set();
    this.stateSaveQueue = Promise.resolve();
  }

  getStartBlockReason() {
    try {
      validateConfig(this.config);
      return '';
    } catch (error) {
      return String(error?.message || '설정이 비정상입니다.');
    }
  }

  async start() {
    if (this.isRunning || this.runPromise || this.startAbortController) {
      this.log('⚠️ 이미 임시 overlay 수집이 실행 중입니다.');
      await this.saveState();
      return;
    }

    const startBlockReason = this.getStartBlockReason();
    if (startBlockReason) {
      this.log(`⚠️ ${startBlockReason}`);
      this.lastError = startBlockReason;
      await this.saveState();
      return;
    }

    this.config = validateConfig(this.config);
    const parsedView = parseValidatedViewUrl(this.config.viewUrl);
    const startedAt = new Date().toISOString();
    const transport = this.createTransport(this.config);
    const startAbortController = new AbortController();

    this.resetRunState(startedAt, parsedView);
    this.startAbortController = startAbortController;
    this.log(`🟢 임시 overlay 수집 준비 (${parsedView.galleryId} / #${parsedView.targetNo})`);
    await this.saveState();

    try {
      if (transport.mode === 'proxy_bridge') {
        this.log('🌉 proxy bridge 준비 상태를 확인합니다.');
        await this.saveState();
        await transport.ensureReady({
          signal: startAbortController.signal,
        });
      }

      if (startAbortController.signal.aborted || this.interrupted) {
        await this.finalizeInterruptedRun();
        return;
      }
    } catch (error) {
      if (isAbortError(error) || startAbortController.signal.aborted || this.interrupted) {
        await this.finalizeInterruptedRun();
        return;
      }

      this.phase = PHASE.FAILED;
      this.finishedAt = new Date().toISOString();
      this.lastError = String(error?.message || 'proxy bridge 준비 실패');
      this.activeTransport = null;
      this.log(`❌ 임시 overlay 수집 시작 실패 - ${this.lastError}`);
      await this.saveState();
      throw error;
    } finally {
      this.startAbortController = null;
    }

    this.activeTransport = transport;
    this.isRunning = true;
    this.phase = PHASE.LOCATING;
    this.lastError = '';
    this.log(`🚀 임시 overlay 수집 시작 (${this.config.transportMode})`);
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop(reason = '🔴 임시 overlay 수집 중지.') {
    if (!this.isRunning && !this.runPromise && !this.startAbortController) {
      this.log('⚠️ 이미 임시 overlay 수집이 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.phase = PHASE.INTERRUPTED;
    this.interrupted = true;
    this.lastError = '';
    this.abortAllControllers();
    this.log(reason);
    await this.saveState();
  }

  async run() {
    const transport = this.activeTransport || this.createTransport(this.config);

    try {
      if (!this.activeTransport && transport.mode === 'proxy_bridge') {
        await transport.ensureReady();
      }
      this.activeTransport = transport;

      const parsedView = parseValidatedViewUrl(this.config.viewUrl);
      this.galleryId = parsedView.galleryId;
      this.targetPostNo = parsedView.targetNo;
      this.phase = PHASE.LOCATING;
      this.currentPage = 0;
      this.log(`🔎 anchor 페이지 탐색 시작 (${this.galleryId} / #${this.targetPostNo})`);
      await this.saveState();

      const locateAbortController = new AbortController();
      this.locateAbortController = locateAbortController;

      let locateResult;
      try {
        const locateDependencies = {
          delayFn: createStoppableDelayFn(this, locateAbortController.signal),
        };
        if (transport.mode === 'proxy_bridge') {
          locateDependencies.fetchBoardListHtmlImpl = transport.fetchBoardListHtml.bind(transport);
        }

        locateResult = await this.locateBoardListPage(
          this.config.viewUrl,
          {
            requestDelayMs: this.config.requestDelayMs,
            jitterMs: this.config.jitterMs,
            maxRetries: this.config.maxRetriesPerPage,
            delayFirstRequest: true,
            signal: locateAbortController.signal,
          },
          locateDependencies,
        );
      } finally {
        this.locateAbortController = null;
      }

      if (!this.isRunning) {
        await this.finalizeInterruptedRun();
        return;
      }

      if (!locateResult?.success || Number(locateResult?.foundPage) <= 0) {
        throw new Error(String(locateResult?.reason || 'anchor 페이지를 찾지 못했습니다.'));
      }

      this.foundPage = Math.max(0, Number(locateResult.foundPage) || 0);
      this.totalPageCount = Math.max(1, Number(locateResult.totalPageCount) || this.foundPage || 1);

      const targetPages = buildTargetPages(
        this.foundPage,
        this.config.beforePages,
        this.config.afterPages,
        this.totalPageCount,
      );

      this.phase = PHASE.FETCHING;
      this.currentPage = 0;
      this.targetPageCount = targetPages.length;
      this.completedPageCount = 0;
      this.failedPages = [];
      this.failedPageCount = 0;
      this.log(`📚 anchor ${this.foundPage}페이지 기준 ${targetPages.length}페이지 수집 시작`);
      await this.saveState();

      if (transport.mode === 'proxy_bridge') {
        await this.fetchTargetPagesWithWorkers(targetPages, transport);
      } else {
        await this.fetchTargetPagesSequentially(targetPages, transport);
      }

      if (!this.isRunning) {
        await this.finalizeInterruptedRun();
        return;
      }

      if (this.runtimeTitleSet.size <= 0) {
        throw new Error('수집된 정규화 제목이 없어 overlay를 저장할 수 없습니다.');
      }

      this.phase = PHASE.SAVING;
      this.currentPage = 0;
      this.log(`💾 overlay 저장 시작 (${this.runtimeTitleSet.size}개)`);
      await this.saveState();

      const [startPage, endPage] = getOverlayPageBounds(targetPages);
      const overlayMeta = await this.saveOverlayImpl(
        {
          overlayId: buildOverlayId({
            galleryId: this.galleryId,
            anchorPostNo: this.targetPostNo,
            startPage,
            endPage,
          }),
          galleryId: this.galleryId,
          anchorPostNo: this.targetPostNo,
          anchorPage: this.foundPage,
          startPage,
          endPage,
          pageCount: targetPages.length,
          completedPageCount: this.completedPageCount,
          failedPages: this.failedPages,
          titleCount: this.runtimeTitleSet.size,
          createdAt: new Date().toISOString(),
          sourceType: 'window_overlay',
          active: true,
        },
        [...this.runtimeTitleSet],
      );

      await this.reloadEffectiveMatcher();

      this.isRunning = false;
      this.interrupted = false;
      this.phase = PHASE.COMPLETED;
      this.finishedAt = new Date().toISOString();
      this.appliedOverlayId = String(overlayMeta?.overlayId || '').trim();
      this.lastError = '';
      this.currentPage = 0;
      this.log(
        `✅ overlay 적용 완료 - 성공 ${this.completedPageCount}/${this.targetPageCount}페이지`
        + ` / 실패 ${this.failedPageCount}페이지 / 정규화 ${this.normalizedTitleCount}개`,
      );
      await this.saveState();
    } catch (error) {
      if (isAbortError(error) || (!this.isRunning && this.interrupted)) {
        await this.finalizeInterruptedRun();
        return;
      }

      this.isRunning = false;
      this.phase = PHASE.FAILED;
      this.finishedAt = new Date().toISOString();
      this.lastError = String(error?.message || '알 수 없는 오류');
      this.log(`❌ 임시 overlay 수집 오류 - ${this.lastError}`);
      await this.saveState();
    } finally {
      this.activeTransport = null;
      this.clearAbortRegistries();
    }
  }

  async fetchTargetPagesSequentially(targetPages, transport) {
    for (let index = 0; index < targetPages.length; index += 1) {
      if (!this.isRunning) {
        return;
      }

      const page = targetPages[index];
      this.currentPage = page;
      await this.saveState();

      const abortController = new AbortController();
      this.pageAbortControllers.add(abortController);

      try {
        const html = await transport.fetchBoardListHtml(this.galleryId, page, {
          maxRetries: this.config.maxRetriesPerPage,
          signal: abortController.signal,
        });
        this.recordFetchedPage(page, html);
      } catch (error) {
        if (isAbortError(error) || abortController.signal.aborted) {
          throw createAbortError();
        }

        this.recordPageFailure(page, error);
      } finally {
        this.pageAbortControllers.delete(abortController);
      }

      await this.saveState();

      if (!this.isRunning || index >= targetPages.length - 1) {
        continue;
      }

      await delayWhileRunning(this, getRequestDelayWithJitter(this.config));
    }
  }

  async fetchTargetPagesWithWorkers(targetPages, transport) {
    if (targetPages.length <= 0) {
      return;
    }

    let nextIndex = 0;
    const workerCount = Math.max(1, transport.getEffectiveWorkerCount(targetPages.length));
    this.log(`🧵 proxy worker ${workerCount}개로 병렬 수집합니다.`);
    await this.saveState();

    const workers = Array.from({ length: workerCount }, async () => {
      let isFirstRequest = true;

      while (this.isRunning) {
        const currentIndex = nextIndex;
        if (currentIndex >= targetPages.length) {
          return;
        }
        nextIndex += 1;

        if (!isFirstRequest) {
          await delayWhileRunning(this, getRequestDelayWithJitter(this.config));
        }
        isFirstRequest = false;

        if (!this.isRunning) {
          return;
        }

        const page = targetPages[currentIndex];
        this.currentPage = page;
        void this.saveState();

        const abortController = new AbortController();
        this.pageAbortControllers.add(abortController);

        try {
          const html = await transport.fetchBoardListHtml(this.galleryId, page, {
            maxRetries: this.config.maxRetriesPerPage,
            signal: abortController.signal,
          });
          this.recordFetchedPage(page, html);
          void this.saveState();
        } catch (error) {
          if (isAbortError(error) || abortController.signal.aborted) {
            throw createAbortError();
          }

          this.recordPageFailure(page, error);
          void this.saveState();
        } finally {
          this.pageAbortControllers.delete(abortController);
        }
      }
    });

    await Promise.all(workers);
  }

  recordFetchedPage(page, html) {
    const titles = this.parseTitles(html);
    const normalizedNewTitles = collectNewNormalizedTitles(titles, this.normalizeTitle, this.runtimeTitleSet);

    this.completedPageCount += 1;
    this.rawTitleCount += titles.length;
    this.normalizedTitleCount = this.runtimeTitleSet.size;
    this.failedPageCount = this.failedPages.length;
    this.log(
      `📄 ${page}페이지 수집 완료 - 원본 ${titles.length}개 / 신규 ${normalizedNewTitles.length}개`
      + ` / 누적 고유 ${this.normalizedTitleCount}개`,
    );
  }

  recordPageFailure(page, error) {
    this.failedPages = normalizePageList([...this.failedPages, page]);
    this.failedPageCount = this.failedPages.length;
    this.log(`⚠️ ${page}페이지 수집 실패 - ${String(error?.message || '알 수 없는 오류')}`);
  }

  abortAllControllers() {
    if (this.locateAbortController) {
      this.locateAbortController.abort();
    }

    if (this.startAbortController) {
      this.startAbortController.abort();
    }

    for (const controller of this.pageAbortControllers) {
      controller.abort();
    }
  }

  clearAbortRegistries() {
    this.startAbortController = null;
    this.locateAbortController = null;
    this.pageAbortControllers.clear();
  }

  async finalizeInterruptedRun() {
    this.isRunning = false;
    this.interrupted = true;
    this.phase = PHASE.INTERRUPTED;
    this.finishedAt = this.finishedAt || new Date().toISOString();
    this.lastError = '';
    await this.saveState();
  }

  resetRunState(startedAt, parsedView) {
    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.currentPage = 0;
    this.galleryId = String(parsedView?.galleryId || '').trim();
    this.targetPostNo = Math.max(0, Number(parsedView?.targetNo) || 0);
    this.foundPage = 0;
    this.totalPageCount = 0;
    this.targetPageCount = 0;
    this.completedPageCount = 0;
    this.failedPageCount = 0;
    this.failedPages = [];
    this.rawTitleCount = 0;
    this.normalizedTitleCount = 0;
    this.startedAt = String(startedAt || new Date().toISOString());
    this.finishedAt = '';
    this.lastError = '';
    this.logs = [];
    this.interrupted = false;
    this.runtimeTitleSet = new Set();
    this.clearAbortRegistries();
  }

  async saveState() {
    this.stateSaveQueue = this.stateSaveQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await chrome.storage.local.set({
            [STORAGE_KEY]: {
              isRunning: this.isRunning,
              phase: this.phase,
              currentPage: this.currentPage,
              galleryId: this.galleryId,
              targetPostNo: this.targetPostNo,
              foundPage: this.foundPage,
              totalPageCount: this.totalPageCount,
              targetPageCount: this.targetPageCount,
              completedPageCount: this.completedPageCount,
              failedPageCount: this.failedPageCount,
              failedPages: this.failedPages,
              rawTitleCount: this.rawTitleCount,
              normalizedTitleCount: this.normalizedTitleCount,
              appliedOverlayId: this.appliedOverlayId,
              startedAt: this.startedAt,
              finishedAt: this.finishedAt,
              lastError: this.lastError,
              logs: this.logs.slice(0, 50),
              interrupted: this.interrupted,
              config: this.config,
            },
          });
        } catch (error) {
          console.error('[RefluxOverlayCollectorScheduler] 상태 저장 실패:', error.message);
        }
      });

    return this.stateSaveQueue;
  }

  async loadState() {
    try {
      const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
      if (!schedulerState) {
        return;
      }

      this.isRunning = Boolean(schedulerState.isRunning);
      this.phase = normalizePhase(schedulerState.phase);
      this.currentPage = Math.max(0, Number(schedulerState.currentPage) || 0);
      this.galleryId = String(schedulerState.galleryId || '').trim();
      this.targetPostNo = Math.max(0, Number(schedulerState.targetPostNo) || 0);
      this.foundPage = Math.max(0, Number(schedulerState.foundPage) || 0);
      this.totalPageCount = Math.max(0, Number(schedulerState.totalPageCount) || 0);
      this.targetPageCount = Math.max(0, Number(schedulerState.targetPageCount) || 0);
      this.completedPageCount = Math.max(0, Number(schedulerState.completedPageCount) || 0);
      this.failedPageCount = Math.max(0, Number(schedulerState.failedPageCount) || 0);
      this.failedPages = normalizePageList(schedulerState.failedPages);
      this.rawTitleCount = Math.max(0, Number(schedulerState.rawTitleCount) || 0);
      this.normalizedTitleCount = Math.max(0, Number(schedulerState.normalizedTitleCount) || 0);
      this.appliedOverlayId = String(schedulerState.appliedOverlayId || '').trim();
      this.startedAt = String(schedulerState.startedAt || '');
      this.finishedAt = String(schedulerState.finishedAt || '');
      this.lastError = String(schedulerState.lastError || '');
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.interrupted = Boolean(schedulerState.interrupted);
      this.config = normalizeConfig({
        ...this.config,
        ...(schedulerState.config || {}),
      });
      if (Number(schedulerState.config?.maxRetriesPerPage) === 2) {
        this.config.maxRetriesPerPage = normalizeConfig({ maxRetriesPerPage: 5 }).maxRetriesPerPage;
      }
      this.runtimeTitleSet = new Set();
      this.activeTransport = null;
      this.clearAbortRegistries();

      if (this.isRunning) {
        this.isRunning = false;
        this.phase = PHASE.INTERRUPTED;
        this.interrupted = true;
        this.log('ℹ️ 중단된 임시 overlay 수집 작업이 있어 자동 복원을 건너뜁니다.');
        await this.saveState();
      }
    } catch (error) {
      console.error('[RefluxOverlayCollectorScheduler] 상태 복원 실패:', error.message);
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
      currentPage: this.currentPage,
      galleryId: this.galleryId,
      targetPostNo: this.targetPostNo,
      foundPage: this.foundPage,
      totalPageCount: this.totalPageCount,
      targetPageCount: this.targetPageCount,
      completedPageCount: this.completedPageCount,
      failedPageCount: this.failedPageCount,
      failedPages: this.failedPages,
      rawTitleCount: this.rawTitleCount,
      normalizedTitleCount: this.normalizedTitleCount,
      appliedOverlayId: this.appliedOverlayId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastError: this.lastError,
      logs: this.logs.slice(0, 20),
      interrupted: this.interrupted,
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
  for (const rawTitle of Array.isArray(titles) ? titles : []) {
    const normalizedTitle = normalizeTitle(rawTitle);
    if (!normalizedTitle || runtimeTitleSet.has(normalizedTitle)) {
      continue;
    }
    runtimeTitleSet.add(normalizedTitle);
    nextTitles.push(normalizedTitle);
  }
  return nextTitles;
}

function normalizePhase(phase) {
  return Object.values(PHASE).includes(phase)
    ? phase
    : PHASE.IDLE;
}

function normalizePageList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((page) => Math.max(0, Number.parseInt(String(page ?? ''), 10) || 0))
      .filter((page) => page > 0),
  )].sort((left, right) => left - right);
}

function getRequestDelayWithJitter(config = {}) {
  const requestDelayMs = Math.max(0, Number(config?.requestDelayMs) || 0);
  const jitterMs = Math.max(0, Number(config?.jitterMs) || 0);
  const jitter = jitterMs > 0
    ? Math.floor(Math.random() * (jitterMs + 1))
    : 0;
  return requestDelayMs + jitter;
}

function getOverlayPageBounds(targetPages = []) {
  const normalizedPages = normalizePageList(targetPages);
  if (normalizedPages.length <= 0) {
    return [0, 0];
  }

  return [
    normalizedPages[0],
    normalizedPages[normalizedPages.length - 1],
  ];
}

function createAbortError(message = '요청이 중단되었습니다.') {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }

  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return Boolean(error?.name === 'AbortError');
}

function throwIfStoppedOrAborted(scheduler, signal) {
  if (!scheduler.isRunning || signal?.aborted) {
    throw createAbortError();
  }
}

function createStoppableDelayFn(scheduler, signal) {
  return async (ms) => {
    await delayWhileRunning(scheduler, ms, signal);
  };
}

async function delayWhileRunning(scheduler, ms, signal) {
  let remainingMs = Math.max(0, Number(ms) || 0);
  while (remainingMs > 0) {
    throwIfStoppedOrAborted(scheduler, signal);
    const stepMs = Math.min(100, remainingMs);
    await scheduler.delayFn(stepMs);
    remainingMs -= stepMs;
  }

  throwIfStoppedOrAborted(scheduler, signal);
}

export {
  PHASE,
  Scheduler,
  normalizeConfig,
};
