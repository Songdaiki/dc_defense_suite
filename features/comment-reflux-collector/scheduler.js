import {
  DEFAULT_CONFIG,
  delay,
  extractEsno,
  fetchAllCollectorComments,
  fetchCollectorPostListHtml,
  fetchCollectorPostViewHtml,
  isValidGalleryId,
  normalizeConfig,
  normalizeGalleryId,
} from './api.js';
import {
  collectNormalizedCommentRefluxMemos,
  parseCollectorPostEntries,
} from './parser.js';
import {
  appendCollectorMemos,
  clearAllCollectorMemos,
} from './store.js';

const STORAGE_KEY = 'commentRefluxCollectorSchedulerState';
const PHASE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  COMPLETED: 'COMPLETED',
  INTERRUPTED: 'INTERRUPTED',
};

class Scheduler {
  constructor(dependencies = {}) {
    this.fetchPostListHtml = dependencies.fetchPostListHtml || fetchCollectorPostListHtml;
    this.fetchPostViewHtml = dependencies.fetchPostViewHtml || fetchCollectorPostViewHtml;
    this.fetchAllComments = dependencies.fetchAllComments || fetchAllCollectorComments;
    this.extractEsno = dependencies.extractEsno || extractEsno;
    this.parsePostEntries = dependencies.parsePostEntries || parseCollectorPostEntries;
    this.collectMemos = dependencies.collectMemos || collectNormalizedCommentRefluxMemos;
    this.clearAllMemos = dependencies.clearAllMemos || clearAllCollectorMemos;
    this.appendMemos = dependencies.appendMemos || appendCollectorMemos;
    this.delayFn = dependencies.delayFn || delay;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.runId = '';
    this.currentPage = 0;
    this.currentPostNo = 0;
    this.fetchedPageCount = 0;
    this.processedPostCount = 0;
    this.failedPostCount = 0;
    this.rawCommentCount = 0;
    this.normalizedMemoCount = 0;
    this.startedAt = '';
    this.finishedAt = '';
    this.lastError = '';
    this.downloadReady = false;
    this.exportVersion = '';
    this.interrupted = false;
    this.collectedGalleryId = '';
    this.logs = [];
    this.config = normalizeConfig(DEFAULT_CONFIG);

    this.runtimeMemoSet = new Set();
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
      this.log('⚠️ 이미 역류댓글 수집이 실행 중입니다.');
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
    this.currentPostNo = 0;
    this.fetchedPageCount = 0;
    this.processedPostCount = 0;
    this.failedPostCount = 0;
    this.rawCommentCount = 0;
    this.normalizedMemoCount = 0;
    this.startedAt = new Date().toISOString();
    this.finishedAt = '';
    this.lastError = '';
    this.downloadReady = false;
    this.exportVersion = '';
    this.interrupted = false;
    this.collectedGalleryId = normalizeGalleryId(this.config.galleryId);
    this.logs = [];
    this.runtimeMemoSet = new Set();
    this.log(`🟢 역류댓글 수집 시작! (${this.collectedGalleryId} / ${this.config.startPage}~${this.config.endPage})`);
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop(reason = '🔴 역류댓글 수집 중지.') {
    if (!this.isRunning) {
      this.log('⚠️ 이미 역류댓글 수집이 정지 상태입니다.');
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
        this.currentPostNo = 0;
        await this.saveState();

        const listHtml = await this.fetchPostListHtml(this.config.galleryId, page);
        const postEntries = this.parsePostEntries(listHtml);
        const candidatePosts = postEntries.filter((entry) => Number(entry?.commentCount) > 0);

        this.fetchedPageCount += 1;
        this.log(`📄 ${page}페이지 로드 - 댓글 있는 글 ${candidatePosts.length}개 / 동시 처리 ${this.config.postConcurrency}`);
        await this.saveState();

        await this.processPostsInParallel(candidatePosts);

        if (!this.isRunning || page >= this.config.endPage) {
          continue;
        }

        this.phase = PHASE.WAITING;
        this.currentPostNo = 0;
        await this.saveState();
        await delayWhileRunning(this, this.config.cycleDelayMs);
      }

      if (!this.isRunning) {
        await this.saveState();
        return;
      }

      this.isRunning = false;
      this.phase = PHASE.COMPLETED;
      this.finishedAt = new Date().toISOString();
      this.downloadReady = this.normalizedMemoCount > 0;
      this.exportVersion = this.downloadReady ? buildDatasetVersion(this.finishedAt) : '';
      if (this.downloadReady) {
        this.log(`✅ 수집 완료 - 원본 댓글 ${this.rawCommentCount}개 / 정규화 고유 댓글 ${this.normalizedMemoCount}개 / source 다운로드 준비 완료`);
      } else {
        this.log('⚠️ 수집은 끝났지만 다운로드할 댓글이 없습니다.');
      }
      await this.saveState();
    } catch (error) {
      this.isRunning = false;
      this.phase = PHASE.IDLE;
      this.lastError = String(error?.message || '알 수 없는 오류');
      this.log(`❌ 역류댓글 수집 오류 - ${this.lastError}`);
      await this.saveState();
    }
  }

  async processPostsInParallel(posts) {
    const normalizedPosts = Array.isArray(posts) ? posts : [];
    if (normalizedPosts.length <= 0) {
      return;
    }

    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, Number(this.config.postConcurrency) || 1), normalizedPosts.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (this.isRunning && nextIndex < normalizedPosts.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await this.processSinglePost(normalizedPosts[currentIndex]);

        if (!this.isRunning) {
          break;
        }

        await delayWhileRunning(this, this.config.requestDelayMs);
      }
    });

    await Promise.all(workers);
    this.currentPostNo = 0;
    await this.saveState();
  }

  async processSinglePost(postEntry) {
    const postNo = Number(postEntry?.no) || 0;
    if (postNo <= 0 || !this.isRunning) {
      return;
    }

    this.currentPostNo = postNo;
    await this.saveState();

    try {
      const postHtml = await this.fetchPostViewHtml(this.config.galleryId, postNo);
      const esno = this.extractEsno(postHtml);
      if (!esno) {
        throw new Error('e_s_n_o 토큰 추출 실패');
      }

      const { comments } = await this.fetchAllComments(this.config, postNo, esno, this.config.commentPageConcurrency);
      const normalizedMemos = collectNewNormalizedMemos(
        this.collectMemos(comments),
        this.runtimeMemoSet,
      );

      if (normalizedMemos.length > 0) {
        await this.appendMemos(this.runId, normalizedMemos);
        mergeNormalizedMemosIntoRuntimeSet(this.runtimeMemoSet, normalizedMemos);
      }

      this.processedPostCount += 1;
      this.rawCommentCount += Array.isArray(comments) ? comments.length : 0;
      this.normalizedMemoCount = this.runtimeMemoSet.size;

      this.log(`💬 #${postNo} 처리 완료 - 원본 ${Array.isArray(comments) ? comments.length : 0}개 / 신규 ${normalizedMemos.length}개 / 누적 고유 ${this.normalizedMemoCount}개`);
      await this.saveState();
    } catch (error) {
      this.failedPostCount += 1;
      this.log(`⚠️ #${postNo} 처리 실패 - ${error.message}`);
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
      memoCount: this.normalizedMemoCount,
      baseFileStem: buildDownloadFileStem(collectedGalleryId, version),
    };
  }

  async clearCollectedData() {
    this.runtimeMemoSet = new Set();
    await this.clearAllMemos();
  }

  async saveState() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          isRunning: this.isRunning,
          phase: this.phase,
          runId: this.runId,
          currentPage: this.currentPage,
          currentPostNo: this.currentPostNo,
          fetchedPageCount: this.fetchedPageCount,
          processedPostCount: this.processedPostCount,
          failedPostCount: this.failedPostCount,
          rawCommentCount: this.rawCommentCount,
          normalizedMemoCount: this.normalizedMemoCount,
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
      console.error('[CommentRefluxCollectorScheduler] 상태 저장 실패:', error.message);
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
      this.currentPostNo = Math.max(0, Number(schedulerState.currentPostNo) || 0);
      this.fetchedPageCount = Math.max(0, Number(schedulerState.fetchedPageCount) || 0);
      this.processedPostCount = Math.max(0, Number(schedulerState.processedPostCount) || 0);
      this.failedPostCount = Math.max(0, Number(schedulerState.failedPostCount) || 0);
      this.rawCommentCount = Math.max(0, Number(schedulerState.rawCommentCount) || 0);
      this.normalizedMemoCount = Math.max(0, Number(schedulerState.normalizedMemoCount) || 0);
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
        this.log('ℹ️ 중단된 댓글 수집 작업이 있어 자동 복원을 건너뜁니다.');
        await this.saveState();
      }
    } catch (error) {
      console.error('[CommentRefluxCollectorScheduler] 상태 복원 실패:', error.message);
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
      currentPostNo: this.currentPostNo,
      fetchedPageCount: this.fetchedPageCount,
      processedPostCount: this.processedPostCount,
      failedPostCount: this.failedPostCount,
      rawCommentCount: this.rawCommentCount,
      normalizedMemoCount: this.normalizedMemoCount,
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

function collectNewNormalizedMemos(memos, runtimeMemoSet) {
  const nextMemos = [];
  (Array.isArray(memos) ? memos : []).forEach((memo) => {
    const normalizedMemo = String(memo || '').trim();
    if (!normalizedMemo || runtimeMemoSet.has(normalizedMemo)) {
      return;
    }

    nextMemos.push(normalizedMemo);
  });
  return nextMemos;
}

function mergeNormalizedMemosIntoRuntimeSet(runtimeMemoSet, memos) {
  (Array.isArray(memos) ? memos : []).forEach((memo) => {
    const normalizedMemo = String(memo || '').trim();
    if (!normalizedMemo) {
      return;
    }

    runtimeMemoSet.add(normalizedMemo);
  });
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

function buildDownloadFileStem(galleryId, version) {
  const normalizedGalleryId = normalizeGalleryId(galleryId) || 'unknown-gallery';
  return `comment-reflux-source-${normalizedGalleryId}-${version}`;
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
