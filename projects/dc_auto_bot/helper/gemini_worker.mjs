import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('Gemini worker는 worker thread 환경에서만 실행할 수 있습니다.');
}

const cliModuleCache = {
  packageRoot: '',
  loadSettings: null,
  loadCliConfig: null,
  parseArguments: null,
  runNonInteractive: null,
  validateNonInteractiveAuth: null,
};

let activeCapture = null;
let workerRuntime = null;

process.stdout.write = function patchedWorkerStdoutWrite(chunk, encodingOrCallback, callback) {
  return captureWorkerOutput('stdout', chunk, encodingOrCallback, callback);
};

process.stderr.write = function patchedWorkerStderrWrite(chunk, encodingOrCallback, callback) {
  return captureWorkerOutput('stderr', chunk, encodingOrCallback, callback);
};

parentPort.on('message', async (message) => {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'run') {
    const result = await executeJob(message.job || {});
    parentPort.postMessage({
      type: 'result',
      jobId: String(message.job?.jobId || ''),
      ...result,
    });
    return;
  }

  if (message.type === 'shutdown') {
    await disposeWorkerRuntime();
    process.exit(0);
  }
});

parentPort.postMessage({ type: 'ready' });

function captureWorkerOutput(streamName, chunk, encodingOrCallback, callback) {
  const callbackFn = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
  const text = normalizeChunk(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined);
  if (activeCapture && text) {
    activeCapture[streamName].push(text);
    parentPort.postMessage({
      type: 'stream',
      jobId: activeCapture.jobId,
      stream: streamName,
      chunk: text,
    });
  }

  if (callbackFn) {
    callbackFn();
  }
  return true;
}

function normalizeChunk(chunk, encoding) {
  if (typeof chunk === 'string') {
    return chunk;
  }

  if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) {
    return Buffer.from(chunk).toString(encoding || 'utf8');
  }

  return String(chunk || '');
}

function getCombinedCaptureText(capture = activeCapture) {
  if (!capture) {
    return '';
  }

  const stdout = capture.stdout.join('').trim();
  const stderr = capture.stderr.join('').trim();
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

function normalizeNonNegativeInt(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return Math.floor(numericValue);
}

async function ensureCliModules(packageRoot) {
  const normalizedRoot = String(packageRoot || '').trim();
  if (!normalizedRoot) {
    throw new Error('Gemini CLI package root가 비어 있습니다.');
  }

  if (
    cliModuleCache.packageRoot === normalizedRoot
    && cliModuleCache.loadSettings
    && cliModuleCache.loadCliConfig
    && cliModuleCache.parseArguments
    && cliModuleCache.runNonInteractive
    && cliModuleCache.validateNonInteractiveAuth
  ) {
    return cliModuleCache;
  }

  const configModuleUrl = pathToFileURL(resolve(normalizedRoot, 'dist/src/config/config.js')).href;
  const settingsModuleUrl = pathToFileURL(resolve(normalizedRoot, 'dist/src/config/settings.js')).href;
  const nonInteractiveModuleUrl = pathToFileURL(resolve(normalizedRoot, 'dist/src/nonInteractiveCli.js')).href;
  const validateAuthModuleUrl = pathToFileURL(resolve(normalizedRoot, 'dist/src/validateNonInterActiveAuth.js')).href;

  const [configModule, settingsModule, nonInteractiveModule, validateAuthModule] = await Promise.all([
    import(configModuleUrl),
    import(settingsModuleUrl),
    import(nonInteractiveModuleUrl),
    import(validateAuthModuleUrl),
  ]);

  cliModuleCache.packageRoot = normalizedRoot;
  cliModuleCache.loadSettings = settingsModule.loadSettings;
  cliModuleCache.loadCliConfig = configModule.loadCliConfig;
  cliModuleCache.parseArguments = configModule.parseArguments;
  cliModuleCache.runNonInteractive = nonInteractiveModule.runNonInteractive;
  cliModuleCache.validateNonInteractiveAuth = validateAuthModule.validateNonInteractiveAuth;
  return cliModuleCache;
}

function sanitizeRuntimeArgs(args = []) {
  const values = Array.isArray(args) ? args.map((entry) => String(entry || '')) : [];
  const sanitized = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const nextValue = values[index + 1];
    const lowerValue = value.toLowerCase();

    if (lowerValue === '-p' || lowerValue === '--prompt' || lowerValue === '-i' || lowerValue === '--prompt-interactive') {
      if (nextValue && !String(nextValue).startsWith('-')) {
        index += 1;
      }
      continue;
    }

    if (
      lowerValue.startsWith('--prompt=')
      || lowerValue.startsWith('--prompt-interactive=')
      || lowerValue.startsWith('--output-format=')
    ) {
      continue;
    }

    if (lowerValue === '--output-format') {
      if (nextValue && !String(nextValue).startsWith('-')) {
        index += 1;
      }
      continue;
    }

    if (lowerValue === '-r' || lowerValue === '--resume' || lowerValue === '--delete-session') {
      if (nextValue && !String(nextValue).startsWith('-')) {
        index += 1;
      }
      continue;
    }

    if (lowerValue === '--list-sessions' || lowerValue === '--list-extensions') {
      continue;
    }

    sanitized.push(value);
  }

  return sanitized;
}

function buildWorkerStartupArgv(runtimeConfig = {}) {
  return [
    'node',
    'gemini',
    ...sanitizeRuntimeArgs(runtimeConfig.args),
    '--output-format',
    'text',
  ];
}

async function ensureWorkerRuntime(job) {
  const packageRoot = String(job.packageRoot || '').trim();
  if (!packageRoot) {
    throw new Error('Gemini CLI package root가 비어 있습니다.');
  }

  const cwd = String(job.cwd || process.cwd());
  const runtimeFingerprint = String(job.runtimeFingerprint || `${packageRoot}:${cwd}`).trim();
  if (
    workerRuntime
    && workerRuntime.packageRoot === packageRoot
    && workerRuntime.fingerprint === runtimeFingerprint
  ) {
    return workerRuntime;
  }

  await disposeWorkerRuntime();

  const modules = await ensureCliModules(packageRoot);
  const settings = modules.loadSettings(cwd);
  const originalArgv = process.argv.slice();
  const originalIsTTY = process.stdin.isTTY;
  const startupArgv = buildWorkerStartupArgv(job.runtimeConfig);
  let config = null;

  try {
    process.stdin.isTTY = false;
    process.argv = startupArgv.slice();
    const argv = await modules.parseArguments(settings.merged);
    const sessionId = randomUUID();
    config = await modules.loadCliConfig(settings.merged, sessionId, argv, { cwd });
    await config.initialize();
    const authType = await modules.validateNonInteractiveAuth(
      settings.merged?.security?.auth?.selectedType,
      settings.merged?.security?.auth?.useExternal,
      config,
      settings,
    );
    await config.refreshAuth(authType);

    workerRuntime = {
      fingerprint: runtimeFingerprint,
      packageRoot,
      cwd,
      sessionId,
      settings,
      config,
      modules,
      startupArgv,
      jobsSinceCompression: 0,
      promptCount: 0,
    };
    return workerRuntime;
  } catch (error) {
    if (config && typeof config.dispose === 'function') {
      try {
        await config.dispose();
      } catch {
        // 초기화 실패 cleanup은 최종 오류를 덮지 않는다.
      }
    }
    throw error;
  } finally {
    process.argv = originalArgv;
    process.stdin.isTTY = originalIsTTY;
  }
}

async function disposeWorkerRuntime() {
  if (!workerRuntime) {
    return;
  }

  const runtimeToDispose = workerRuntime;
  workerRuntime = null;
  if (runtimeToDispose.config && typeof runtimeToDispose.config.dispose === 'function') {
    try {
      await runtimeToDispose.config.dispose();
    } catch {
      // worker 종료 경로의 dispose 실패는 무시한다.
    }
  }
}

async function maybeCompressContext(runtime, job, promptId) {
  const shouldCountTowardCompression = job?.runtimeConfig?.countTowardCompression !== false;
  if (!shouldCountTowardCompression) {
    return null;
  }

  const compressAfterJobs = normalizeNonNegativeInt(job?.runtimeConfig?.compressAfterJobs, 0);
  runtime.promptCount += 1;
  if (compressAfterJobs <= 0) {
    return null;
  }

  runtime.jobsSinceCompression += 1;
  if (runtime.jobsSinceCompression < compressAfterJobs) {
    return null;
  }
  runtime.jobsSinceCompression = 0;

  try {
    const compressionInfo = await runtime.config.getGeminiClient().tryCompressChat(
      `${promptId}-compress-${runtime.promptCount}`,
      true,
    );
    return {
      attempted: true,
      compressionStatus: String(compressionInfo?.compressionStatus || ''),
      originalTokenCount: Number(compressionInfo?.originalTokenCount || 0),
      newTokenCount: Number(compressionInfo?.newTokenCount || 0),
    };
  } catch (error) {
    return {
      attempted: true,
      compressionStatus: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeJob(job) {
  const capture = {
    jobId: String(job.jobId || ''),
    stdout: [],
    stderr: [],
  };
  activeCapture = capture;

  const originalArgv = process.argv.slice();
  const originalIsTTY = process.stdin.isTTY;
  process.stdout.removeAllListeners('error');

  try {
    const runtime = await ensureWorkerRuntime(job);
    const promptId = String(job.promptId || `judge-${Date.now()}`);
    process.stdin.isTTY = false;
    process.argv = runtime.startupArgv.slice();

    await runtime.modules.runNonInteractive({
      config: runtime.config,
      settings: runtime.settings,
      input: String(job.prompt || ''),
      prompt_id: promptId,
      resumedSessionData: undefined,
    });

    const compression = await maybeCompressContext(runtime, job, promptId);

    return {
      success: true,
      rawText: getCombinedCaptureText(capture),
      message: '',
      failureType: '',
      compression,
    };
  } catch (error) {
    await disposeWorkerRuntime();
    return {
      success: false,
      rawText: getCombinedCaptureText(capture),
      message: error instanceof Error ? error.message : String(error),
      failureType: 'runtime_error',
    };
  } finally {
    process.argv = originalArgv;
    process.stdin.isTTY = originalIsTTY;
    process.stdout.removeAllListeners('error');
    activeCapture = null;
  }
}
