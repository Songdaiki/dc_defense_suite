import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const DEFAULT_IDLE_MS = 0;
const DEFAULT_MAX_JOBS_PER_WORKER = 0;

export function createGeminiWorkerManager(options = {}) {
  const workerScriptUrl = options.workerScriptUrl || new URL('./gemini_worker.mjs', import.meta.url);
  const idleMs = normalizeNonNegativeInt(options.idleMs, DEFAULT_IDLE_MS);
  const maxJobsPerWorker = normalizeNonNegativeInt(options.maxJobsPerWorker, DEFAULT_MAX_JOBS_PER_WORKER);

  let worker = null;
  let workerReadyPromise = null;
  let activePackageRoot = '';
  let activeRuntimeFingerprint = '';
  let activeExclusiveEntry = null;
  let activePromptEntry = null;
  let queue = [];
  let jobsProcessedInWorker = 0;
  let idleTimer = null;

  async function runExclusive(taskFn) {
    return new Promise((resolve, reject) => {
      queue.push({ taskFn, resolve, reject });
      void processQueue();
    });
  }

  async function processQueue() {
    if (activeExclusiveEntry || queue.length === 0) {
      return;
    }

    clearIdleTimer();
    activeExclusiveEntry = queue.shift();
    try {
      const result = await activeExclusiveEntry.taskFn({
        runPrompt,
        warmRuntime,
      });
      activeExclusiveEntry.resolve(result);
    } catch (error) {
      activeExclusiveEntry.reject(error);
    } finally {
      activeExclusiveEntry = null;
      if (maxJobsPerWorker > 0 && jobsProcessedInWorker >= maxJobsPerWorker) {
        await terminateWorker();
      }
      if (queue.length > 0) {
        void processQueue();
      } else {
        scheduleIdleTermination();
      }
    }
  }

  async function runPrompt(taskInput) {
    return runWorkerJob('run', taskInput);
  }

  async function warmRuntime(taskInput) {
    return runWorkerJob('warm', taskInput);
  }

  async function runWorkerJob(jobType, taskInput) {
    if (!taskInput || typeof taskInput !== 'object') {
      throw new Error('Gemini worker prompt 입력이 비어 있습니다.');
    }

    if (activePromptEntry) {
      throw new Error('Gemini worker는 한 번에 하나의 prompt만 처리할 수 있습니다.');
    }

    const packageRoot = String(taskInput.packageRoot || '').trim();
    const runtimeFingerprint = String(taskInput.runtimeFingerprint || packageRoot).trim();
    if (!packageRoot) {
      throw new Error('Gemini worker packageRoot가 필요합니다.');
    }
    if (!runtimeFingerprint) {
      throw new Error('Gemini worker runtime fingerprint가 필요합니다.');
    }

    if (
      (activePackageRoot && activePackageRoot !== packageRoot)
      || (activeRuntimeFingerprint && activeRuntimeFingerprint !== runtimeFingerprint)
    ) {
      await terminateWorker();
    }

    const taskId = String(taskInput.jobId || randomUUID());
    const runtimeConfig = taskInput.runtimeConfig && typeof taskInput.runtimeConfig === 'object'
      ? taskInput.runtimeConfig
      : {};
    const timeoutMs = normalizePositiveInt(runtimeConfig.timeoutMs, 240000);
    const promptEntry = createActivePromptEntry(taskId, timeoutMs);
    activePromptEntry = promptEntry;

    try {
      const ensuredWorker = await ensureWorker(packageRoot, runtimeFingerprint);
      ensuredWorker.postMessage({
        type: jobType,
        job: {
          jobId: taskId,
          packageRoot,
          prompt: String(taskInput.prompt || ''),
          cwd: String(taskInput.cwd || process.cwd()),
          runtimeConfig: {
            args: Array.isArray(runtimeConfig.args) ? runtimeConfig.args.map((entry) => String(entry || '')) : [],
            timeoutMs,
            compressAfterJobs: normalizeNonNegativeInt(runtimeConfig.compressAfterJobs, 0),
            countTowardCompression: runtimeConfig.countTowardCompression !== false,
          },
          runtimeFingerprint,
          promptId: String(taskInput.promptId || ''),
        },
      });

      const result = await promptEntry.promise;
      jobsProcessedInWorker += 1;
      return result;
    } finally {
      clearActivePromptEntry(taskId);
    }
  }

  function ensureWorker(packageRoot, runtimeFingerprint) {
    if (
      worker
      && workerReadyPromise
      && activePackageRoot === packageRoot
      && activeRuntimeFingerprint === runtimeFingerprint
    ) {
      return workerReadyPromise;
    }

    return startWorker(packageRoot, runtimeFingerprint);
  }

  function startWorker(packageRoot, runtimeFingerprint) {
    if (workerReadyPromise) {
      return workerReadyPromise;
    }

    worker = new Worker(workerScriptUrl);
    const targetWorker = worker;
    activePackageRoot = String(packageRoot || '').trim();
    activeRuntimeFingerprint = String(runtimeFingerprint || '').trim();
    jobsProcessedInWorker = 0;

    worker.on('message', handleWorkerMessage);
    worker.on('error', handleWorkerError);
    worker.on('exit', handleWorkerExit);

    workerReadyPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const startupError = new Error('Gemini worker 시작 시간이 초과되었습니다.');
        void terminateWorker().finally(() => {
          reject(startupError);
        });
      }, 5000);

      const onReady = (message) => {
        if (message?.type !== 'ready') {
          return;
        }

        clearTimeout(timeoutId);
        targetWorker.off('message', onReady);
        targetWorker.off('error', onStartupError);
        targetWorker.off('exit', onStartupExit);
        resolve(targetWorker);
      };

      const onStartupError = (error) => {
        clearTimeout(timeoutId);
        targetWorker.off('message', onReady);
        targetWorker.off('error', onStartupError);
        targetWorker.off('exit', onStartupExit);
        void terminateWorker().finally(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      const onStartupExit = (code) => {
        clearTimeout(timeoutId);
        targetWorker.off('message', onReady);
        targetWorker.off('error', onStartupError);
        targetWorker.off('exit', onStartupExit);
        void terminateWorker().finally(() => {
          reject(new Error(`Gemini worker 시작 중 종료되었습니다. (${Number(code) || 0})`));
        });
      };

      targetWorker.on('message', onReady);
      targetWorker.once('error', onStartupError);
      targetWorker.once('exit', onStartupExit);
    });

    return workerReadyPromise;
  }

  function handleWorkerMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'stream') {
      if (activePromptEntry && activePromptEntry.jobId === String(message.jobId || '')) {
        const chunk = String(message.chunk || '');
        if (message.stream === 'stderr') {
          activePromptEntry.stderr.push(chunk);
        } else {
          activePromptEntry.stdout.push(chunk);
        }
      }
      return;
    }

    if (message.type === 'result') {
      if (!activePromptEntry || activePromptEntry.jobId !== String(message.jobId || '')) {
        return;
      }

      resolvePromptEntry(activePromptEntry, {
        success: message.success === true,
        message: String(message.message || ''),
        failureType: String(message.failureType || ''),
        rawText: String(message.rawText || buildRawTextFromPromptEntry(activePromptEntry)),
      });
    }
  }

  function handleWorkerError(error) {
    if (!activePromptEntry) {
      return;
    }

    if (activePromptEntry.expectedCompletion) {
      return;
    }

    resolvePromptEntry(activePromptEntry, {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      failureType: 'worker_error',
      rawText: buildRawTextFromPromptEntry(activePromptEntry),
    });
  }

  function handleWorkerExit(code) {
    const exitCode = Number.isInteger(code) ? code : 0;
    worker = null;
    workerReadyPromise = null;
    activePackageRoot = '';
    activeRuntimeFingerprint = '';

    if (!activePromptEntry) {
      return;
    }

    if (activePromptEntry.expectedCompletion) {
      return;
    }

    resolvePromptEntry(activePromptEntry, {
      success: false,
      message: `Gemini worker 종료 코드가 비정상입니다. (${exitCode})`,
      failureType: 'worker_exit',
      rawText: buildRawTextFromPromptEntry(activePromptEntry),
    });
  }

  async function terminateWorker() {
    clearIdleTimer();
    if (!worker) {
      workerReadyPromise = null;
      activePackageRoot = '';
      activeRuntimeFingerprint = '';
      jobsProcessedInWorker = 0;
      return;
    }

    const targetWorker = worker;
    worker = null;
    workerReadyPromise = null;
    activePackageRoot = '';
    activeRuntimeFingerprint = '';
    jobsProcessedInWorker = 0;
    await targetWorker.terminate();
  }

  function scheduleIdleTermination() {
    clearIdleTimer();
    if (idleMs <= 0 || !worker || activeExclusiveEntry || queue.length > 0) {
      return;
    }

    idleTimer = setTimeout(() => {
      void terminateWorker();
    }, idleMs);
    if (typeof idleTimer.unref === 'function') {
      idleTimer.unref();
    }
  }

  function clearIdleTimer() {
    if (!idleTimer) {
      return;
    }

    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function createActivePromptEntry(jobId, timeoutMs) {
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const entry = {
      jobId,
      timeoutId: null,
      promise,
      resolve: resolvePromise,
      stdout: [],
      stderr: [],
      settled: false,
      expectedCompletion: null,
    };

    entry.timeoutId = setTimeout(() => {
      if (!activePromptEntry || activePromptEntry.jobId !== jobId || activePromptEntry.settled) {
        return;
      }

      const timedOutResult = {
        success: false,
        message: `Gemini CLI 응답 대기 시간이 초과되었습니다. (${timeoutMs}ms)`,
        failureType: 'timeout',
        rawText: '',
      };
      activePromptEntry.expectedCompletion = timedOutResult;
      void terminateWorker().finally(() => {
        resolvePromptEntry(entry, {
          ...timedOutResult,
          rawText: buildRawTextFromPromptEntry(entry),
        });
      });
    }, timeoutMs);

    return entry;
  }

  function clearActivePromptEntry(jobId) {
    if (!activePromptEntry || activePromptEntry.jobId !== jobId) {
      return;
    }

    clearTimeout(activePromptEntry.timeoutId);
    activePromptEntry = null;
  }

  function resolvePromptEntry(promptEntry, result) {
    if (!promptEntry || promptEntry.settled) {
      return;
    }

    promptEntry.settled = true;
    clearTimeout(promptEntry.timeoutId);
    promptEntry.resolve(result);
  }

  function getStatus() {
    return {
      hasWorker: Boolean(worker),
      queueLength: queue.length,
      activePackageRoot,
      activeRuntimeFingerprint,
      jobsProcessedInWorker,
    };
  }

  return {
    getStatus,
    runExclusive,
    terminateWorker,
  };
}

function normalizeNonNegativeInt(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
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

function buildRawTextFromPromptEntry(promptEntry) {
  if (!promptEntry) {
    return '';
  }

  const stdout = promptEntry.stdout.join('').trim();
  const stderr = promptEntry.stderr.join('').trim();
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}
