import http from 'node:http';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createDryRunRecordStore, getEffectiveDecisionLabel, sanitizePublicRecord } from './db.mjs';
import { createDryRunQueue } from './queue.mjs';
import { scanPagesToQueue } from './scanner.mjs';
import { DcFetchError, buildPostUrl, fetchPostListHtml, fetchPostPageHtml } from './fetcher.mjs';
import { extractPostAuthorMeta, extractPostContentForLlm, parseRegularBoardPosts } from './parser.mjs';
import {
  applyDryRunDecisionPolicy,
  createBlurredThumbnail,
  getDefaultGeminiCommand,
  getDefaultPromptMode,
  judgePost,
  prewarmPersistentGeminiWorker,
} from './judge.mjs';
import { renderDryRunDetailPage, renderDryRunListPage, renderNotFoundPage } from './transparency.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('./', import.meta.url));
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = normalizePort(process.env.PORT, 4327);
const MAX_REQUEST_BYTES = 256 * 1024;

function buildRuntimeConfig() {
  const helperRootDir = PROJECT_ROOT;
  const itemJitterMinMs = normalizeNonNegativeInt(process.env.DRY_RUN_ITEM_JITTER_MIN_MS, 350);
  const itemJitterMaxMs = Math.max(
    itemJitterMinMs,
    normalizeNonNegativeInt(process.env.DRY_RUN_ITEM_JITTER_MAX_MS, 1400),
  );
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    baseUrl: String(process.env.BASE_URL || 'https://gall.dcinside.com').replace(/\/+$/g, ''),
    galleryId: String(process.env.GALLERY_ID || 'thesingularity').trim() || 'thesingularity',
    boardPath: String(process.env.BOARD_PATH || 'mgallery').trim() || 'mgallery',
    pageFrom: Math.max(1, Number(process.env.PAGE_FROM) || 1),
    pageTo: Math.max(1, Number(process.env.PAGE_TO) || 20),
    fetchAttempts: Math.max(1, Number(process.env.FETCH_ATTEMPTS) || 3),
    fetchTimeoutMs: normalizePositiveInt(process.env.FETCH_TIMEOUT_MS, 30000),
    command: String(process.env.GEMINI_COMMAND || getDefaultGeminiCommand()).trim() || getDefaultGeminiCommand(),
    args: parseArgsJson(process.env.GEMINI_ARGS_JSON),
    timeoutMs: normalizePositiveInt(process.env.GEMINI_TIMEOUT_MS, 240000),
    promptMode: normalizePromptMode(process.env.GEMINI_PROMPT_MODE || getDefaultPromptMode()),
    promptFlag: String(process.env.GEMINI_PROMPT_FLAG || '-p').trim() || '-p',
    confidenceThreshold: clampConfidenceThreshold(process.env.LLM_CONFIDENCE_THRESHOLD || 0.85),
    helperRootDir,
    recordsFilePath: process.env.DRY_RUN_RECORDS_FILE || fileURLToPath(new URL('./data/dry-run-records.jsonl', import.meta.url)),
    queueFilePath: process.env.DRY_RUN_QUEUE_FILE || fileURLToPath(new URL('./data/dry-run-queue.jsonl', import.meta.url)),
    assetsDir: process.env.DRY_RUN_ASSETS_DIR || fileURLToPath(new URL('./data/transparency-assets', import.meta.url)),
    judgeInputDir: process.env.DRY_RUN_JUDGE_INPUT_DIR || fileURLToPath(new URL('./gemini-inputs', import.meta.url)),
    thumbnailWidth: normalizePositiveInt(process.env.DRY_RUN_THUMBNAIL_WIDTH, 360),
    thumbnailBlurSigma: normalizePositiveInt(process.env.DRY_RUN_THUMBNAIL_BLUR_SIGMA, 5),
    thumbnailWebpQuality: normalizePositiveInt(process.env.DRY_RUN_THUMBNAIL_WEBP_QUALITY, 64),
    workerCompressAfterJobs: normalizeNonNegativeInt(process.env.GEMINI_WORKER_COMPRESS_AFTER_JOBS, 10),
    workerPrewarmEnabled: String(process.env.GEMINI_WORKER_PREWARM_ENABLED || '1').trim() !== '0',
    workerPrewarmTimeoutMs: normalizePositiveInt(process.env.GEMINI_WORKER_PREWARM_TIMEOUT_MS, 30000),
    workerIdleMs: normalizeNonNegativeInt(process.env.GEMINI_WORKER_IDLE_MS, 0),
    workerMaxJobs: normalizeNonNegativeInt(process.env.GEMINI_WORKER_MAX_JOBS, 0),
    workerSessionScope: 'ai-moderator-dry-run',
    disablePersistentWorker: String(process.env.GEMINI_DISABLE_PERSISTENT_WORKER || '0').trim() === '1',
    workerConcurrency: normalizeBoundedPositiveInt(process.env.DRY_RUN_WORKER_CONCURRENCY, 1, 8, 1),
    itemJitterMinMs,
    itemJitterMaxMs,
    livePollEnabled: String(process.env.DRY_RUN_LIVE_POLL_ENABLED || '0').trim() === '1',
    livePollIntervalMs: normalizePositiveInt(process.env.DRY_RUN_LIVE_POLL_INTERVAL_MS, 10000),
  };
}

class DryRunRunner {
  constructor({ config, queue, store }) {
    this.config = config;
    this.queue = queue;
    this.store = store;
    this.running = false;
    this.stopRequested = false;
    this.currentPostNo = '';
    this.activeWorkers = new Map();
    this.completedInRun = 0;
    this.failedInRun = 0;
    this.skippedInRun = 0;
    this.startedAt = '';
    this.lastUpdatedAt = '';
    this.lastMessage = '';
  }

  getWorkerCount() {
    const requested = normalizeBoundedPositiveInt(this.config.workerConcurrency, 1, 8, 1);
    return this.config.disablePersistentWorker === true ? requested : 1;
  }

  getStatus() {
    const activeWorkers = [...this.activeWorkers.values()];
    return {
      running: this.running,
      stopRequested: this.stopRequested,
      currentPostNo: activeWorkers.map((entry) => entry.postNo).join(',') || this.currentPostNo,
      activeWorkers,
      workerConcurrency: normalizeBoundedPositiveInt(this.config.workerConcurrency, 1, 8, 1),
      effectiveWorkerConcurrency: this.getWorkerCount(),
      parallelGeminiEnabled: this.config.disablePersistentWorker === true,
      completedInRun: this.completedInRun,
      failedInRun: this.failedInRun,
      skippedInRun: this.skippedInRun,
      startedAt: this.startedAt,
      lastUpdatedAt: this.lastUpdatedAt,
      lastMessage: this.lastMessage,
    };
  }

  requestStop() {
    this.stopRequested = true;
    this.lastMessage = '현재 처리 중인 글 이후 정지 요청됨';
    this.lastUpdatedAt = new Date().toISOString();
  }

  async start() {
    if (this.running) {
      return {
        started: false,
        message: '이미 큐 처리가 실행 중입니다.',
      };
    }

    this.running = true;
    this.stopRequested = false;
    this.startedAt = new Date().toISOString();
    this.lastUpdatedAt = this.startedAt;
    this.lastMessage = '큐 처리 시작';
    this.currentPostNo = '';
    this.activeWorkers.clear();
    this.completedInRun = 0;
    this.failedInRun = 0;
    this.skippedInRun = 0;

    void this.runWorkers().catch((error) => {
      this.lastMessage = error?.message || String(error);
      this.lastUpdatedAt = new Date().toISOString();
      this.running = false;
      this.currentPostNo = '';
      this.activeWorkers.clear();
      console.error('[AI dry-run] runner failed:', error);
    });

    return {
      started: true,
      message: '큐 처리를 시작했습니다.',
    };
  }

  async runWorkers() {
    try {
      const workerCount = this.getWorkerCount();
      this.lastMessage = `큐 처리 시작: worker ${workerCount}개`;
      const workers = Array.from({ length: workerCount }, (_, index) => (
        this.workerLoop(`worker-${index + 1}`)
      ));
      const results = await Promise.allSettled(workers);
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('[AI dry-run] worker failed:', result.reason);
        }
      }
    } finally {
      const wasStopRequested = this.stopRequested;
      this.running = false;
      this.currentPostNo = '';
      this.activeWorkers.clear();
      this.lastUpdatedAt = new Date().toISOString();
      if (wasStopRequested) {
        this.lastMessage = '정지됨';
        return;
      }

      const summary = await this.queue.getStatusSummary();
      if (summary.queued > 0) {
        this.lastMessage = `종료 직전 queued ${summary.queued}개 감지, runner 재시작`;
        void this.start();
        return;
      }

      this.lastMessage = 'queued 항목 없음';
    }
  }

  async workerLoop(workerId) {
    while (!this.stopRequested) {
      const item = await this.queue.claimNextQueued(workerId);
      if (!item) {
        if (this.activeWorkers.size > 0) {
          await delay(500);
          continue;
        }
        return;
      }

      this.activeWorkers.set(workerId, {
        workerId,
        postNo: item.postNo,
        subjectFromList: item.subjectFromList || '',
        startedAt: new Date().toISOString(),
      });
      this.updateCurrentPostNo();
      this.lastUpdatedAt = new Date().toISOString();
      this.lastMessage = `${workerId} 게시글 ${item.postNo} 판정 시작`;

      let outcome = 'failed';
      try {
        outcome = await this.processItem(item);
      } catch (error) {
        outcome = 'failed';
        console.error(`[AI dry-run] ${workerId} item failed:`, error);
        await this.markRuntimeFailed(item, error);
      } finally {
        this.activeWorkers.delete(workerId);
        this.updateCurrentPostNo();
        this.countOutcome(outcome);
        this.lastUpdatedAt = new Date().toISOString();
      }

      if (!this.stopRequested) {
        await this.waitBetweenItems(item.postNo, workerId);
      }
    }
  }

  updateCurrentPostNo() {
    this.currentPostNo = [...this.activeWorkers.values()].map((entry) => entry.postNo).join(',');
  }

  countOutcome(outcome) {
    if (outcome === 'completed') {
      this.completedInRun += 1;
    } else if (outcome === 'skipped') {
      this.skippedInRun += 1;
    } else if (outcome === 'failed') {
      this.failedInRun += 1;
    }
  }

  async processItem(item) {
    const targetUrl = buildPostUrl({
      baseUrl: this.config.baseUrl,
      boardPath: this.config.boardPath,
      galleryId: this.config.galleryId,
      postNo: item.postNo,
    });

    try {
      const html = await fetchPostPageHtml(this.config, item.postNo);
      const content = extractPostContentForLlm(html, this.config.baseUrl);
      const authorMeta = extractPostAuthorMeta(html);
      const title = String(content.title || item.subjectFromList || '').trim();
      const bodyText = String(content.bodyText || '').trim();

      if (!title && !bodyText) {
        await this.writeSkippedRecord(item, {
          targetUrl,
          title: item.subjectFromList || '(제목 없음)',
          reason: '제목과 본문을 추출하지 못했습니다.',
          authorMeta,
          imageUrls: content.imageUrls,
        });
        return 'skipped';
      }

      const contentCompleteness = bodyText ? 'full' : 'title_only';
      const finalBodyText = bodyText || '(본문 없음)';
      const recordId = buildRecordId(item.postNo);
      const blurredThumbnailPath = await createBlurredThumbnail({
        recordId,
        targetUrl,
        imageUrls: content.imageUrls,
        runtimeConfig: this.config,
      });

      const judgeResult = await judgePost({
        targetUrl,
        title,
        bodyText: finalBodyText,
        imageUrls: content.imageUrls,
        authorNick: authorMeta.success ? authorMeta.nick : '',
        authorUid: authorMeta.success ? authorMeta.uid : '',
        authorIp: authorMeta.success ? authorMeta.ip : '',
      }, this.config);

      if (!judgeResult.success) {
        await this.store.upsertRecord({
          id: recordId,
          status: 'failed',
          targetUrl,
          targetPostNo: item.postNo,
          publicTitle: title || item.subjectFromList || '(제목 없음)',
          publicBody: finalBodyText,
          contentCompleteness,
          authorNick: authorMeta.success ? authorMeta.nick : '',
          authorUid: authorMeta.success ? authorMeta.uid : '',
          authorIp: authorMeta.success ? authorMeta.ip : '',
          effectiveDecision: 'no_action',
          decision: 'deny',
          rawDecision: 'deny',
          normalizedDecision: 'deny',
          confidence: null,
          confidenceThreshold: this.config.confidenceThreshold,
          policyIds: [],
          reason: judgeResult.message || 'Gemini 판정 실패',
          imageCount: content.imageUrls.length,
          imageDownloadedCount: Math.max(0, Number(judgeResult.imageDownloadedCount) || 0),
          imageAnalysis: String(judgeResult.imageAnalysis || ''),
          blurredThumbnailPath,
          debugFailureType: 'gemini',
          debugFailureMessage: judgeResult.message || '',
          debugFailureRawText: judgeResult.rawText || '',
        });
        await this.queue.markFailed(item.postNo, judgeResult.message || 'Gemini 판정 실패');
        return 'failed';
      }

      const policy = applyDryRunDecisionPolicy(judgeResult, this.config.confidenceThreshold);
      await this.store.upsertRecord({
        id: recordId,
        status: 'completed',
        targetUrl,
        targetPostNo: item.postNo,
        publicTitle: title || item.subjectFromList || '(제목 없음)',
        publicBody: finalBodyText,
        contentCompleteness,
        authorNick: authorMeta.success ? authorMeta.nick : '',
        authorUid: authorMeta.success ? authorMeta.uid : '',
        authorIp: authorMeta.success ? authorMeta.ip : '',
        decision: policy.decision,
        rawDecision: policy.rawDecision,
        normalizedDecision: policy.normalizedDecision,
        effectiveDecision: policy.effectiveDecision,
        thresholdBlocked: policy.thresholdBlocked,
        confidenceThreshold: policy.confidenceThreshold,
        displayDecision: getEffectiveDecisionLabel(policy.effectiveDecision, 'completed'),
        confidence: judgeResult.confidence,
        policyIds: judgeResult.policy_ids,
        reason: judgeResult.reason,
        imageCount: content.imageUrls.length,
        imageDownloadedCount: Math.max(0, Number(judgeResult.imageDownloadedCount) || 0),
        imageAnalysis: String(judgeResult.imageAnalysis || ''),
        blurredThumbnailPath,
      });
      await this.queue.markCompleted(item.postNo);
      this.lastMessage = `게시글 ${item.postNo} 판정 완료`;
      return 'completed';
    } catch (error) {
      if (error instanceof DcFetchError && (error.kind === 'not_found' || error.kind === 'blocked_access')) {
        const skipReason = error.kind === 'not_found' ? '이미 삭제' : error.message;
        await this.writeSkippedRecord(item, {
          targetUrl,
          title: item.subjectFromList || '(제목 없음)',
          reason: skipReason,
          authorMeta: null,
          imageUrls: [],
        });
        return 'skipped';
      }

      await this.markRuntimeFailed(item, error, { targetUrl });
      return 'failed';
    }
  }

  async markRuntimeFailed(item, error, options = {}) {
    try {
      await this.writeRuntimeFailedRecord(item, error, options);
    } catch (recordError) {
      const originalMessage = error?.message || String(error);
      const recordMessage = recordError?.message || String(recordError);
      const fallbackMessage = `${originalMessage}; 실패 기록 저장 실패: ${recordMessage}`;
      console.error('[AI dry-run] failed to write runtime failure record:', recordError);
      try {
        await this.queue.markFailed(item.postNo, fallbackMessage);
      } catch (queueError) {
        console.error('[AI dry-run] failed to mark queue item failed:', queueError);
      }
    }
  }

  async writeRuntimeFailedRecord(item, error, options = {}) {
    const targetUrl = options.targetUrl || buildPostUrl({
      baseUrl: this.config.baseUrl,
      boardPath: this.config.boardPath,
      galleryId: this.config.galleryId,
      postNo: item.postNo,
    });
    const message = error?.message || String(error);
    await this.store.upsertRecord({
      id: buildRecordId(item.postNo),
      status: 'failed',
      targetUrl,
      targetPostNo: item.postNo,
      publicTitle: item.subjectFromList || '(제목 없음)',
      publicBody: '',
      contentCompleteness: 'unknown',
      effectiveDecision: 'no_action',
      decision: 'deny',
      rawDecision: 'deny',
      normalizedDecision: 'deny',
      confidenceThreshold: this.config.confidenceThreshold,
      policyIds: [],
      reason: message,
      imageCount: 0,
      debugFailureType: 'runtime',
      debugFailureMessage: message,
    });
    await this.queue.markFailed(item.postNo, message);
  }

  async waitBetweenItems(postNo, workerId = '') {
    const minMs = Math.max(0, Number(this.config.itemJitterMinMs) || 0);
    const maxMs = Math.max(minMs, Number(this.config.itemJitterMaxMs) || minMs);
    if (maxMs <= 0) {
      return;
    }
    const delayMs = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    const prefix = workerId ? `${workerId} ` : '';
    this.lastMessage = `${prefix}게시글 ${postNo} 처리 후 ${delayMs}ms jitter 대기`;
    this.lastUpdatedAt = new Date().toISOString();
    await delay(delayMs);
  }

  async writeSkippedRecord(item, details) {
    await this.store.upsertRecord({
      id: buildRecordId(item.postNo),
      status: 'skipped',
      targetUrl: details.targetUrl,
      targetPostNo: item.postNo,
      publicTitle: details.title || item.subjectFromList || '(제목 없음)',
      publicBody: '',
      contentCompleteness: 'empty',
      authorNick: details.authorMeta?.success ? details.authorMeta.nick : '',
      authorUid: details.authorMeta?.success ? details.authorMeta.uid : '',
      authorIp: details.authorMeta?.success ? details.authorMeta.ip : '',
      effectiveDecision: 'no_action',
      decision: 'deny',
      rawDecision: 'deny',
      normalizedDecision: 'deny',
      confidenceThreshold: this.config.confidenceThreshold,
      policyIds: [],
      reason: details.reason || '스킵',
      imageCount: Array.isArray(details.imageUrls) ? details.imageUrls.length : 0,
      imageDownloadedCount: 0,
      imageAnalysis: '',
    });
    await this.queue.markSkipped(item.postNo, details.reason || '스킵');
  }
}

class LivePagePoller {
  constructor({ config, queue, store, runner }) {
    this.config = config;
    this.queue = queue;
    this.store = store;
    this.runner = runner;
    this.running = false;
    this.polling = false;
    this.seeded = false;
    this.timer = null;
    this.seenPostNos = new Set();
    this.baselineMaxPostNo = 0;
    this.startedAt = '';
    this.lastUpdatedAt = '';
    this.lastMessage = '';
    this.lastError = '';
    this.lastParsed = 0;
    this.lastAdded = 0;
    this.totalAdded = 0;
  }

  getStatus() {
    return {
      running: this.running,
      polling: this.polling,
      seeded: this.seeded,
      intervalMs: this.config.livePollIntervalMs,
      seenCount: this.seenPostNos.size,
      baselineMaxPostNo: this.baselineMaxPostNo,
      startedAt: this.startedAt,
      lastUpdatedAt: this.lastUpdatedAt,
      lastMessage: this.lastMessage,
      lastError: this.lastError,
      lastParsed: this.lastParsed,
      lastAdded: this.lastAdded,
      totalAdded: this.totalAdded,
    };
  }

  start() {
    if (this.running) {
      return { started: false, message: 'live polling이 이미 실행 중입니다.' };
    }

    this.running = true;
    this.seeded = false;
    this.baselineMaxPostNo = 0;
    this.startedAt = new Date().toISOString();
    this.lastUpdatedAt = this.startedAt;
    this.lastMessage = 'live polling 시작';
    this.lastError = '';
    this.schedule(0);
    return { started: true, message: 'live polling을 시작했습니다.' };
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.polling = false;
    this.lastUpdatedAt = new Date().toISOString();
    this.lastMessage = 'live polling 정지';
    return { stopped: true, message: 'live polling을 정지했습니다.' };
  }

  schedule(delayMs) {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => {
        if (this.running) {
          this.schedule(this.config.livePollIntervalMs);
        }
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  async pollOnce() {
    if (this.polling) {
      return;
    }

    this.polling = true;
    this.lastUpdatedAt = new Date().toISOString();
    this.lastError = '';
    try {
      const html = await fetchPostListHtml({ ...this.config, pageFrom: 1, pageTo: 1 }, 1);
      const posts = parseRegularBoardPosts(html).map((post) => ({ ...post, page: 1 }));
      this.lastParsed = posts.length;

      if (!this.seeded) {
        this.seenPostNos = new Set(posts.map((post) => String(post.no || '').trim()).filter(Boolean));
        this.baselineMaxPostNo = getMaxPostNo(posts);
        this.seeded = true;
        this.lastAdded = 0;
        this.lastMessage = `live seed 완료: 현재 1페이지 ${posts.length}개 기준선 저장 / max=${this.baselineMaxPostNo || '-'}`;
        return;
      }

      const candidates = [];
      for (const post of posts) {
        const postNo = String(post.no || '').trim();
        if (!postNo) {
          continue;
        }
        this.seenPostNos.add(postNo);
        const numericPostNo = Number(postNo);
        if (Number.isFinite(numericPostNo) && numericPostNo <= this.baselineMaxPostNo) {
          continue;
        }
        const existingRecord = await this.store.findByPostNo(postNo);
        if (!existingRecord) {
          candidates.push(post);
        }
      }

      if (candidates.length <= 0) {
        this.lastAdded = 0;
        this.lastMessage = `live polling 완료: 새 글 없음 / parsed=${posts.length}`;
        return;
      }

      const enqueueResult = await this.queue.enqueuePosts(candidates, { force: false });
      this.lastAdded = enqueueResult.added;
      this.totalAdded += enqueueResult.added;
      this.lastMessage = `live 새 글 ${enqueueResult.added}개 큐 추가`;

      if (enqueueResult.added > 0 && !this.runner.running) {
        await this.runner.start();
      }
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.lastMessage = `live polling 실패: ${this.lastError}`;
      console.warn('[AI dry-run] live polling failed:', error);
    } finally {
      this.polling = false;
      this.lastUpdatedAt = new Date().toISOString();
    }
  }
}

function getMaxPostNo(posts) {
  let maxPostNo = 0;
  for (const post of posts) {
    const postNo = Number(String(post?.no || '').trim());
    if (Number.isFinite(postNo) && postNo > maxPostNo) {
      maxPostNo = postNo;
    }
  }
  return maxPostNo;
}

async function createServer(runtimeConfig = buildRuntimeConfig()) {
  const allowedHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!allowedHosts.has(runtimeConfig.host)) {
    throw new Error(`HOST=${runtimeConfig.host} 바인딩은 허용하지 않습니다. 127.0.0.1로 실행하세요.`);
  }

  await mkdir(runtimeConfig.assetsDir, { recursive: true });
  await mkdir(runtimeConfig.judgeInputDir, { recursive: true });

  const queue = createDryRunQueue(runtimeConfig.queueFilePath);
  const store = createDryRunRecordStore(runtimeConfig.recordsFilePath);
  await queue.init();
  await store.init();
  const runner = new DryRunRunner({ config: runtimeConfig, queue, store });
  const livePoller = new LivePagePoller({ config: runtimeConfig, queue, store, runner });
  if (runtimeConfig.livePollEnabled) {
    livePoller.start();
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://${runtimeConfig.host}:${runtimeConfig.port}`);
      if (request.method === 'OPTIONS') {
        writeText(response, 204, '', 'text/plain; charset=utf-8');
        return;
      }

      if (!isAllowedRequest(request, requestUrl)) {
        writeJson(response, 403, { success: false, message: 'local only endpoint' });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        response.writeHead(302, { Location: '/dry-run' });
        response.end();
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/dry-run.css') {
        writeText(response, 200, await readFile(new URL('./public/dry-run.css', import.meta.url), 'utf8'), 'text/css; charset=utf-8');
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/bot-icon.png') {
        writeBuffer(response, 200, await readFile(new URL('./public/bot-icon.png', import.meta.url)), 'image/png');
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/gemini-icon.webp') {
        writeBuffer(response, 200, await readFile(new URL('./public/gemini-icon.webp', import.meta.url)), 'image/webp');
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/transparency-assets/')) {
        await serveTransparencyAsset(response, runtimeConfig, requestUrl.pathname);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/dry-run') {
        const decisionFilter = requestUrl.searchParams.get('decision') || '';
        const listResult = await store.listRecords({
          effectiveDecision: mapTransparencyDecisionFilter(decisionFilter),
          limit: requestUrl.searchParams.get('limit') || '50',
          cursor: requestUrl.searchParams.get('cursor') || '',
        });
        const queueStatus = await queue.getStatusSummary();
        writeText(response, 200, renderDryRunListPage({
          records: listResult.records,
          nextCursor: listResult.nextCursor,
          total: listResult.total,
          stats: listResult.stats,
          currentFilter: decisionFilter,
          queueStatus,
          runnerStatus: runner.getStatus(),
        }), 'text/html; charset=utf-8');
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/dry-run/')) {
        const recordId = decodeURIComponent(requestUrl.pathname.replace(/^\/dry-run\//, ''));
        const record = await store.getRecord(recordId);
        writeText(response, record ? 200 : 404, record ? renderDryRunDetailPage(record) : renderNotFoundPage('기록을 찾지 못했습니다.'), 'text/html; charset=utf-8');
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        writeJson(response, 200, {
          success: true,
          runner: runner.getStatus(),
          queue: await queue.getStatusSummary(),
          stats: await store.getStats(),
          live: livePoller.getStatus(),
          config: sanitizeRuntimeConfig(runtimeConfig),
        });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/records') {
        const decisionFilter = requestUrl.searchParams.get('decision') || '';
        const listResult = await store.listRecords({
          effectiveDecision: mapTransparencyDecisionFilter(decisionFilter),
          status: requestUrl.searchParams.get('status') || '',
          policyId: requestUrl.searchParams.get('policyId') || '',
          limit: requestUrl.searchParams.get('limit') || '50',
          cursor: requestUrl.searchParams.get('cursor') || '',
        });
        writeJson(response, 200, {
          success: true,
          total: listResult.total,
          stats: listResult.stats,
          records: listResult.records.map((record) => sanitizePublicRecord(record)),
          nextCursor: listResult.nextCursor,
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/scan') {
        const body = await readJsonBody(request);
        const scanConfig = {
          ...runtimeConfig,
          pageFrom: Math.max(1, Number(body.pageFrom) || runtimeConfig.pageFrom),
          pageTo: Math.max(1, Number(body.pageTo) || runtimeConfig.pageTo),
        };
        const result = await scanPagesToQueue({
          config: scanConfig,
          queue,
          force: body.force === true,
        });
        writeJson(response, 200, { success: true, result, queue: await queue.getStatusSummary() });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/run') {
        const result = await runner.start();
        writeJson(response, 200, { success: true, ...result, runner: runner.getStatus() });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/stop') {
        runner.requestStop();
        writeJson(response, 200, { success: true, runner: runner.getStatus() });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/retry-failed') {
        const result = await queue.requeueFailedAndSkipped();
        writeJson(response, 200, { success: true, result, queue: await queue.getStatusSummary() });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/live/start') {
        const result = livePoller.start();
        writeJson(response, 200, { success: true, ...result, live: livePoller.getStatus() });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/live/stop') {
        const result = livePoller.stop();
        writeJson(response, 200, { success: true, ...result, live: livePoller.getStatus() });
        return;
      }

      writeText(response, 404, renderNotFoundPage('요청한 경로가 없습니다.'), 'text/html; charset=utf-8');
    } catch (error) {
      console.error('[AI dry-run] request failed:', error);
      writeJson(response, 500, {
        success: false,
        message: error?.message || String(error),
      });
    }
  });

  server.on('close', () => {
    livePoller.stop();
  });

  return { server, runner, livePoller };
}

function isAllowedRequest(request, requestUrl) {
  const method = String(request.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    const path = requestUrl.pathname;
    if (request.headers['cf-connecting-ip']) {
      return path === '/'
        || path === '/dry-run'
        || path.startsWith('/dry-run/')
        || path === '/dry-run.css'
        || path === '/bot-icon.png'
        || path === '/gemini-icon.webp'
        || path.startsWith('/transparency-assets/')
        || path === '/api/records';
    }
    return true;
  }

  return isLocalRequest(request);
}

function isLocalRequest(request) {
  const host = String(request.headers.host || '');
  const remote = String(request.socket?.remoteAddress || '');
  return host.startsWith('127.0.0.1:')
    || host.startsWith('localhost:')
    || remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1';
}

async function serveTransparencyAsset(response, runtimeConfig, pathname) {
  const fileName = basename(decodeURIComponent(pathname.replace(/^\/transparency-assets\//, ''))).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!fileName || !fileName.toLowerCase().endsWith('.webp')) {
    writeText(response, 404, 'not found', 'text/plain; charset=utf-8');
    return;
  }

  const assetPath = resolve(runtimeConfig.assetsDir, fileName);
  try {
    await access(assetPath, fsConstants.F_OK);
    writeBuffer(response, 200, await readFile(assetPath), 'image/webp');
  } catch {
    writeText(response, 404, 'not found', 'text/plain; charset=utf-8');
  }
}

function sanitizeRuntimeConfig(config) {
  return {
    baseUrl: config.baseUrl,
    galleryId: config.galleryId,
    boardPath: config.boardPath,
    pageFrom: config.pageFrom,
    pageTo: config.pageTo,
    confidenceThreshold: config.confidenceThreshold,
    command: config.command,
    args: config.args,
    recordsFilePath: config.recordsFilePath,
    queueFilePath: config.queueFilePath,
    workerConcurrency: config.workerConcurrency,
    livePollEnabled: config.livePollEnabled,
    livePollIntervalMs: config.livePollIntervalMs,
  };
}

function mapTransparencyDecisionFilter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'allow' || normalized === 'action') {
    return 'action';
  }
  if (normalized === 'deny' || normalized === 'no_action') {
    return 'no_action';
  }
  if (normalized === 'review') {
    return 'review';
  }
  return '';
}

function buildRecordId(postNo) {
  return `dryrun-${String(postNo || '').replace(/[^0-9]/g, '') || Date.now()}`;
}

function normalizePort(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0 || numericValue > 65535) {
    return fallback;
  }
  return Math.floor(numericValue);
}

function normalizePositiveInt(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return Math.floor(numericValue);
}

function normalizeNonNegativeInt(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }
  return Math.floor(numericValue);
}

function normalizeBoundedPositiveInt(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < min) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(numericValue)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizePromptMode(value) {
  return String(value || '').trim().toLowerCase() === 'stdin' ? 'stdin' : 'arg';
}

function clampConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0.85;
  }
  return Math.max(0, Math.min(1, numericValue));
}

function parseArgsJson(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry || '')) : [];
  } catch {
    return [];
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('요청 JSON 파싱 실패'));
      }
    });
    request.on('error', reject);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function writeText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
  });
  response.end(body);
}

function writeBuffer(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
  });
  response.end(body);
}

async function startServer(runtimeConfig = buildRuntimeConfig()) {
  const { server } = await createServer(runtimeConfig);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(runtimeConfig.port, runtimeConfig.host, () => {
      void prewarmPersistentGeminiWorker(runtimeConfig)
        .then((result) => {
          if (!result.attempted) return;
          if (result.success) {
            console.log('[AI dry-run] persistent Gemini worker prewarmed');
          } else {
            console.warn('[AI dry-run] persistent Gemini worker prewarm failed:', result.message || result.failureType || 'unknown');
          }
        })
        .catch((error) => {
          console.warn('[AI dry-run] persistent Gemini worker prewarm failed:', error?.message || String(error));
        });
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
    .then((server) => {
      const address = server.address();
      if (address && typeof address === 'object') {
        console.log(`[AI dry-run] listening on http://${address.address}:${address.port}/dry-run`);
      }
    })
    .catch((error) => {
      console.error('[AI dry-run] failed to start:', error);
      process.exitCode = 1;
    });
}

export {
  DryRunRunner,
  buildRuntimeConfig,
  createServer,
  startServer,
};
