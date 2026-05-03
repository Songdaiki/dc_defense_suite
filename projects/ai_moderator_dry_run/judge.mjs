import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { createGeminiWorkerManager } from './gemini_worker_manager.mjs';
import { buildDryRunPrompt, buildImageAnalysisPrompt, MAX_IMAGE_URLS } from './prompt.mjs';

const VALID_DECISIONS = new Set(['allow', 'deny', 'review']);
const VALID_POLICY_IDS = new Set([
  'NONE',
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
  'P12',
  'P13',
  'P14',
  'P15',
]);
const MAX_IMAGE_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000;
const COMMAND_CHECK_CACHE_MS = 5000;
const COMMAND_CHECK_TIMEOUT_MS = 2000;

const commandAvailabilityCache = {
  key: '',
  checkedAtMs: 0,
  result: null,
};

let geminiWorkerManager = null;
let cachedSharpModule = undefined;

async function judgePost(input, runtimeConfig) {
  const requestedImageCount = Array.isArray(input?.imageUrls)
    ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean).slice(0, MAX_IMAGE_URLS).length
    : 0;
  const preparedInputs = await prepareJudgeImageInputs(input, runtimeConfig);
  try {
    if (requestedImageCount > 0 && preparedInputs.imageFileRefs.length === 0) {
      return {
        success: false,
        message: `image_download_failed: 첨부 이미지 ${requestedImageCount}개를 감지했지만 판정용 이미지 파일을 만들지 못했습니다.`,
        rawText: '',
        imageDownloadedCount: 0,
        imageAnalysis: '',
      };
    }

    const judgeStartedAtMs = Date.now();
    let imageAnalysis = {
      text: '',
      rawText: '',
    };
    const runJudgeSequence = async (executionContext) => {
      imageAnalysis = await runImageAnalysis(
        preparedInputs.imageFileRefs,
        runtimeConfig,
        judgeStartedAtMs,
        executionContext,
      );
      const prompt = buildDryRunPrompt({
        ...input,
        imageFileRefs: preparedInputs.imageFileRefs,
        imageAnalysis: imageAnalysis.text,
      });
      return runGeminiCli(
        prompt,
        withRemainingJudgeBudget(runtimeConfig, judgeStartedAtMs),
        executionContext,
      );
    };
    const cliResult = runtimeConfig.disablePersistentWorker === true
      ? await runJudgeSequence(null)
      : await getGeminiWorkerManager(runtimeConfig).runExclusive(runJudgeSequence);
    if (!cliResult.success) {
      return {
        success: false,
        message: cliResult.message || 'Gemini CLI 판정 실패',
        rawText: String(cliResult.rawText || ''),
        imageDownloadedCount: preparedInputs.imageFileRefs.length,
        imageAnalysis: imageAnalysis.text,
      };
    }

    const parsed = parseGeminiCliJson(cliResult.rawText);
    if (!parsed.success) {
      return {
        ...parsed,
        rawText: String(cliResult.rawText || ''),
        imageDownloadedCount: preparedInputs.imageFileRefs.length,
        imageAnalysis: imageAnalysis.text,
      };
    }

    return {
      ...parsed,
      imageDownloadedCount: preparedInputs.imageFileRefs.length,
      imageAnalysis: imageAnalysis.text,
      imageAnalysisRawText: imageAnalysis.rawText,
    };
  } finally {
    await cleanupPreparedJudgeImageInputs(preparedInputs);
  }
}

async function runGeminiCli(prompt, runtimeConfig, executionContext = null) {
  const availability = await checkGeminiCommandAvailability(runtimeConfig);
  if (!availability.available) {
    return {
      success: false,
      message: availability.message,
      rawText: '',
    };
  }

  const commandToRun = availability.commandPath || runtimeConfig.command;
  const packageRoot = await resolveGeminiCliPackageRoot(commandToRun);
  if (!packageRoot || runtimeConfig.disablePersistentWorker === true) {
    return runGeminiCliViaSpawn(prompt, runtimeConfig, commandToRun);
  }

  const workerRuntimeFingerprint = createGeminiWorkerRuntimeFingerprint(packageRoot, runtimeConfig);
  const executeWithWorker = async (executor) => executor.runPrompt({
    prompt,
    runtimeConfig: {
      args: runtimeConfig.args,
      timeoutMs: runtimeConfig.timeoutMs,
      compressAfterJobs: runtimeConfig.workerCompressAfterJobs,
      countTowardCompression: runtimeConfig.countTowardCompression !== false,
    },
    runtimeFingerprint: workerRuntimeFingerprint,
    packageRoot,
    cwd: runtimeConfig.helperRootDir,
  });

  let workerResult = null;
  try {
    workerResult = executionContext?.runPrompt
      ? await executeWithWorker(executionContext)
      : await getGeminiWorkerManager(runtimeConfig).runExclusive(executeWithWorker);
  } catch {
    return runGeminiCliViaSpawn(prompt, runtimeConfig, commandToRun);
  }

  if (
    workerResult.failureType === 'runtime_error'
    || workerResult.failureType === 'worker_exit'
    || workerResult.failureType === 'worker_error'
  ) {
    const fallbackResult = normalizeGeminiCliResult(
      workerResult,
      runtimeConfig.timeoutMs,
      'Gemini CLI 실행 실패',
    );
    if (fallbackResult.success || shouldRetryGeminiCliWithStdin(runtimeConfig, fallbackResult)) {
      return shouldRetryGeminiCliWithStdin(runtimeConfig, fallbackResult)
        ? runGeminiCliViaSpawn(prompt, { ...runtimeConfig, promptMode: 'stdin' }, commandToRun)
        : fallbackResult;
    }
    return fallbackResult;
  }

  return normalizeGeminiCliResult(workerResult, runtimeConfig.timeoutMs);
}

async function prewarmPersistentGeminiWorker(runtimeConfig) {
  if (runtimeConfig.disablePersistentWorker === true || runtimeConfig.workerPrewarmEnabled !== true) {
    return {
      attempted: false,
      success: false,
      message: 'persistent worker prewarm 비활성화',
    };
  }

  const availability = await checkGeminiCommandAvailability(runtimeConfig);
  if (!availability.available) {
    return {
      attempted: false,
      success: false,
      message: availability.message,
    };
  }

  const commandToRun = availability.commandPath || runtimeConfig.command;
  const packageRoot = await resolveGeminiCliPackageRoot(commandToRun);
  if (!packageRoot) {
    return {
      attempted: false,
      success: false,
      message: 'Gemini CLI package root를 찾지 못했습니다.',
    };
  }

  const runtimeFingerprint = createGeminiWorkerRuntimeFingerprint(packageRoot, runtimeConfig);
  const result = await getGeminiWorkerManager(runtimeConfig).runExclusive((executor) => executor.warmRuntime({
    packageRoot,
    cwd: runtimeConfig.helperRootDir,
    runtimeFingerprint,
    runtimeConfig: {
      args: runtimeConfig.args,
      timeoutMs: runtimeConfig.workerPrewarmTimeoutMs,
      compressAfterJobs: runtimeConfig.workerCompressAfterJobs,
      countTowardCompression: false,
    },
  }));

  return {
    attempted: true,
    success: result.success === true,
    message: String(result.message || ''),
    failureType: String(result.failureType || ''),
  };
}

function getGeminiWorkerManager(runtimeConfig) {
  if (!geminiWorkerManager) {
    geminiWorkerManager = createGeminiWorkerManager({
      workerScriptUrl: new URL('./gemini_worker.mjs', import.meta.url),
      idleMs: Math.max(0, Number(runtimeConfig.workerIdleMs) || 0),
      maxJobsPerWorker: Math.max(0, Number(runtimeConfig.workerMaxJobs) || 0),
      compressionIdleMs: 5000,
    });
  }
  return geminiWorkerManager;
}

async function runGeminiCliViaSpawn(prompt, runtimeConfig, commandToRun) {
  const primaryResult = await runGeminiCliViaSpawnOnce(prompt, runtimeConfig, commandToRun);
  if (shouldRetryGeminiCliWithStdin(runtimeConfig, primaryResult)) {
    return runGeminiCliViaSpawnOnce(prompt, { ...runtimeConfig, promptMode: 'stdin' }, commandToRun);
  }
  return primaryResult;
}

async function runGeminiCliViaSpawnOnce(prompt, runtimeConfig, commandToRun) {
  const childArgs = [
    ...runtimeConfig.args,
    ...buildPromptInvocationArgs(runtimeConfig, prompt),
  ];

  const child = spawn(commandToRun, childArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: shouldUseShellExecution(commandToRun),
    cwd: runtimeConfig.helperRootDir,
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  let didTimeout = false;

  if (runtimeConfig.promptMode === 'stdin') {
    child.stdin.write(prompt);
    child.stdin.end();
  } else {
    child.stdin.end();
  }

  child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    child.kill('SIGKILL');
  }, runtimeConfig.timeoutMs);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const rawText = [stdout, stderr].filter(Boolean).join('\n').trim();
    const hasUsableDecisionOutput = hasUsableGeminiDecisionOutput(rawText);

    if (didTimeout && !hasUsableDecisionOutput) {
      return {
        success: false,
        message: `Gemini CLI 응답 대기 시간이 초과되었습니다. (${runtimeConfig.timeoutMs}ms)`,
        rawText,
      };
    }

    if (result.code !== 0 && !hasUsableDecisionOutput) {
      return {
        success: false,
        message: `Gemini CLI 종료 코드가 비정상입니다. (${result.code ?? 'null'})`,
        rawText,
      };
    }

    return {
      success: true,
      rawText,
    };
  } catch (error) {
    return {
      success: false,
      message: error?.code === 'ENOENT'
        ? 'Gemini CLI 실행 파일을 찾지 못했습니다. GEMINI_COMMAND 또는 PATH를 확인하세요.'
        : `Gemini CLI 실행 실패: ${error.message}`,
      rawText: Buffer.concat([...stdoutChunks, ...stderrChunks]).toString('utf8').trim(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeGeminiCliResult(result, timeoutMs, fallbackMessage = 'Gemini CLI 실행 실패') {
  const rawText = String(result?.rawText || '').trim();
  const hasUsableDecisionOutput = hasUsableGeminiDecisionOutput(rawText);
  if (result?.success === true || hasUsableDecisionOutput) {
    return {
      success: true,
      rawText,
      compression: normalizeCompressionResult(result?.compression),
    };
  }

  if (String(result?.failureType || '') === 'timeout') {
    return {
      success: false,
      message: `Gemini CLI 응답 대기 시간이 초과되었습니다. (${timeoutMs}ms)`,
      rawText,
    };
  }

  return {
    success: false,
    message: String(result?.message || fallbackMessage),
    rawText,
  };
}

function parseGeminiCliJson(rawText) {
  const normalizedText = String(rawText || '').trim();
  if (!normalizedText) {
    return {
      success: false,
      message: 'Gemini CLI 출력이 비어 있습니다.',
    };
  }

  const candidates = [normalizedText];
  const fencedBlocks = normalizedText.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fencedBlocks) {
    candidates.push(stripJsonFences(block));
  }

  const extractedObjects = extractJsonObjects(normalizedText);
  for (const extracted of extractedObjects) {
    candidates.push(extracted);
  }

  for (const candidate of candidates) {
    const parsed = safeParseJson(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return validateJudgeDecision(parsed, normalizedText);
    }
  }

  return {
    success: false,
    message: 'Gemini CLI 출력에서 JSON object를 추출하지 못했습니다.',
  };
}

function validateJudgeDecision(data, rawText = '') {
  let decision = String(data.decision || '').trim().toLowerCase();
  const confidence = Number(data.confidence);
  let policyIds = [...new Set(
    (Array.isArray(data.policy_ids) ? data.policy_ids : (Array.isArray(data.policyIds) ? data.policyIds : []))
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean),
  )];
  let reason = String(data.reason || '').trim();

  if (!VALID_DECISIONS.has(decision)) {
    return { success: false, message: 'decision 값이 올바르지 않습니다.' };
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { success: false, message: 'confidence 값이 올바르지 않습니다.' };
  }
  if (policyIds.length === 0) {
    policyIds = ['NONE'];
  }
  if (policyIds.some((policyId) => !VALID_POLICY_IDS.has(policyId))) {
    return { success: false, message: 'policy_ids에 허용되지 않은 값이 포함되어 있습니다.' };
  }
  if (!reason) {
    return { success: false, message: 'reason 값이 비어 있습니다.' };
  }

  const hasNone = policyIds.includes('NONE');
  if (hasNone && policyIds.length > 1) {
    return { success: false, message: 'policy_ids에 NONE과 다른 정책이 동시에 포함될 수 없습니다.' };
  }
  if (hasNone && decision !== 'deny') {
    decision = 'deny';
  }
  if (decision === 'allow' && policyIds.length === 1 && policyIds[0] === 'P15') {
    decision = 'review';
  }

  return {
    success: true,
    decision,
    confidence,
    policy_ids: policyIds,
    reason,
    rawText,
  };
}

async function runImageAnalysis(imageFileRefs, runtimeConfig, judgeStartedAtMs = Date.now(), executionContext = null) {
  if (!Array.isArray(imageFileRefs) || imageFileRefs.length === 0) {
    return {
      text: '',
      rawText: '',
    };
  }

  const analysisResult = await runGeminiCli(
    buildImageAnalysisPrompt(imageFileRefs),
    {
      ...withRemainingJudgeBudget(runtimeConfig, judgeStartedAtMs),
      countTowardCompression: false,
    },
    executionContext,
  );

  if (!analysisResult.success) {
    return {
      text: '',
      rawText: String(analysisResult.rawText || ''),
    };
  }

  const parsed = parseLooseJsonObject(String(analysisResult.rawText || '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      text: '',
      rawText: String(analysisResult.rawText || ''),
    };
  }

  const visibleText = Array.isArray(parsed.visible_text)
    ? parsed.visible_text.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const summary = String(parsed.summary || '').trim();
  const notes = String(parsed.notes || '').trim();
  const containsPolicySignal = parsed.contains_policy_signal === true ? '예' : '아니오';

  return {
    text: [
      `visible_text: ${visibleText.length > 0 ? visibleText.join(' | ') : '없음'}`,
      `summary: ${summary || '없음'}`,
      `contains_policy_signal: ${containsPolicySignal}`,
      `notes: ${notes || '없음'}`,
    ].join('\n'),
    rawText: String(analysisResult.rawText || ''),
  };
}

function withRemainingJudgeBudget(runtimeConfig, startedAtMs) {
  const elapsedMs = Math.max(0, Date.now() - Number(startedAtMs || 0));
  const remainingMs = Math.max(1000, Number(runtimeConfig.timeoutMs || 240000) - elapsedMs);
  return {
    ...runtimeConfig,
    timeoutMs: remainingMs,
  };
}

function normalizeJudgeDecisionForAutomation(result) {
  if (!result || result.success !== true || result.decision !== 'review') {
    return result;
  }

  const policyIds = Array.isArray(result.policy_ids)
    ? result.policy_ids.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const promotablePolicyIds = policyIds.filter((policyId) => policyId !== 'NONE');

  return {
    ...result,
    decision: promotablePolicyIds.length > 0 ? 'allow' : 'deny',
  };
}

function applyDryRunDecisionPolicy(parsed, threshold = 0.85) {
  const rawDecision = String(parsed?.decision || '').trim().toLowerCase();
  const normalized = normalizeJudgeDecisionForAutomation(parsed);
  const normalizedDecision = String(normalized?.decision || rawDecision).trim().toLowerCase();
  const confidenceThreshold = clampConfidenceThreshold(threshold);
  const confidence = Number(parsed?.confidence);

  if (normalizedDecision !== 'allow') {
    return {
      rawDecision,
      normalizedDecision,
      effectiveDecision: normalizedDecision === 'review' ? 'review' : 'no_action',
      decision: normalizedDecision === 'review' ? 'review' : 'deny',
      thresholdBlocked: false,
      confidenceThreshold,
    };
  }

  if (!Number.isFinite(confidence) || confidence < confidenceThreshold) {
    return {
      rawDecision,
      normalizedDecision,
      effectiveDecision: 'no_action',
      decision: 'deny',
      thresholdBlocked: true,
      confidenceThreshold,
    };
  }

  return {
    rawDecision,
    normalizedDecision,
    effectiveDecision: 'action',
    decision: 'allow',
    thresholdBlocked: false,
    confidenceThreshold,
  };
}

async function prepareJudgeImageInputs(input, runtimeConfig) {
  const imageUrls = Array.isArray(input?.imageUrls)
    ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean).slice(0, MAX_IMAGE_URLS)
    : [];
  if (imageUrls.length === 0) {
    return {
      imageFileRefs: [],
      cleanupPaths: [],
    };
  }

  await mkdir(runtimeConfig.judgeInputDir, { recursive: true });
  const cleanupPaths = [];
  const imageFileRefs = [];

  for (let index = 0; index < imageUrls.length; index += 1) {
    const downloaded = await downloadJudgeImageInput({
      imageUrl: imageUrls[index],
      targetUrl: input.targetUrl,
      runtimeConfig,
      index,
    });
    if (!downloaded.success) {
      continue;
    }
    cleanupPaths.push(downloaded.filePath);
    imageFileRefs.push(downloaded.promptPath);
  }

  return {
    imageFileRefs,
    cleanupPaths,
  };
}

async function downloadJudgeImageInput({ imageUrl, targetUrl, runtimeConfig, index }) {
  const buffer = await downloadImageBuffer(imageUrl, targetUrl);
  if (!buffer) {
    return { success: false };
  }

  const normalizedBuffer = await normalizeJudgeImageBuffer(buffer);
  if (!normalizedBuffer) {
    return { success: false };
  }

  const fileName = `${randomUUID()}_${index + 1}.png`;
  const filePath = resolve(runtimeConfig.judgeInputDir, fileName);
  await writeFile(filePath, normalizedBuffer);
  return {
    success: true,
    filePath,
    promptPath: toPromptRelativePath(runtimeConfig.helperRootDir, filePath),
  };
}

async function createBlurredThumbnail({ recordId, targetUrl, imageUrls, runtimeConfig }) {
  const candidateUrls = Array.isArray(imageUrls)
    ? imageUrls.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (candidateUrls.length === 0) {
    return '';
  }

  const sharp = await loadSharp();
  if (!sharp) {
    return '';
  }

  await mkdir(runtimeConfig.assetsDir, { recursive: true });
  const assetName = `${sanitizeAssetBaseName(recordId) || randomUUID()}.webp`;
  const assetPath = resolve(runtimeConfig.assetsDir, assetName);

  for (const imageUrl of candidateUrls) {
    try {
      const buffer = await downloadImageBuffer(imageUrl, targetUrl);
      if (!buffer) {
        continue;
      }

      const output = await sharp(buffer)
        .rotate()
        .resize({
          width: runtimeConfig.thumbnailWidth,
          height: runtimeConfig.thumbnailWidth,
          fit: 'cover',
          withoutEnlargement: true,
        })
        .blur(runtimeConfig.thumbnailBlurSigma)
        .webp({
          quality: runtimeConfig.thumbnailWebpQuality,
        })
        .toBuffer();

      await writeFile(assetPath, output);
      return `/transparency-assets/${assetName}`;
    } catch {
      continue;
    }
  }

  return '';
}

async function downloadImageBuffer(imageUrl, targetUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, {
      method: 'GET',
      headers: buildImageDownloadHeaders(targetUrl),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (isClearlyNonImageContentType(contentType)) {
      return null;
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_DOWNLOAD_BYTES) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function normalizeJudgeImageBuffer(buffer) {
  const sharp = await loadSharp();
  if (!sharp) {
    return null;
  }
  const metadata = await sharp(buffer, { animated: true }).metadata();
  const isMultiFrame = Math.max(1, Number(metadata?.pages) || 1) > 1;
  return sharp(buffer, { animated: !isMultiFrame })
    .rotate()
    .png()
    .toBuffer();
}

async function cleanupPreparedJudgeImageInputs(preparedInputs) {
  const cleanupPaths = Array.isArray(preparedInputs?.cleanupPaths) ? preparedInputs.cleanupPaths : [];
  for (const filePath of cleanupPaths) {
    try {
      await rm(filePath, { force: true });
    } catch {
      // 임시 파일 cleanup 실패는 판정 결과를 덮지 않는다.
    }
  }
}

async function loadSharp() {
  if (cachedSharpModule !== undefined) {
    return cachedSharpModule;
  }
  try {
    const module = await import('sharp');
    cachedSharpModule = module.default || module;
  } catch {
    cachedSharpModule = null;
  }
  return cachedSharpModule;
}

function buildImageDownloadHeaders(targetUrl) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    Referer: String(targetUrl || '').trim(),
  };
}

function isClearlyNonImageContentType(contentType) {
  const normalized = String(contentType || '').toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith('image/') || normalized === 'application/octet-stream') {
    return false;
  }
  return normalized.startsWith('text/')
    || normalized.includes('html')
    || normalized.includes('json')
    || normalized.includes('xml');
}

function stripJsonFences(rawText) {
  return String(rawText || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonObjects(rawText) {
  const text = String(rawText || '');
  const objects = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return objects;
}

function parseLooseJsonObject(rawText) {
  const normalizedText = String(rawText || '').trim();
  if (!normalizedText) {
    return null;
  }

  const candidates = [normalizedText];
  const fencedBlocks = normalizedText.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const block of fencedBlocks) {
    candidates.push(stripJsonFences(block));
  }
  for (const extracted of extractJsonObjects(normalizedText)) {
    candidates.push(extracted);
  }

  for (const candidate of candidates) {
    const parsed = safeParseJson(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  }
  return null;
}

function hasUsableGeminiDecisionOutput(rawText) {
  return parseGeminiCliJson(rawText).success === true;
}

function createGeminiWorkerRuntimeFingerprint(packageRoot, runtimeConfig) {
  return JSON.stringify({
    packageRoot: String(packageRoot || '').trim(),
    cwd: String(runtimeConfig.helperRootDir || '').trim(),
    args: Array.isArray(runtimeConfig.args) ? runtimeConfig.args.map((entry) => String(entry || '')) : [],
    sessionScope: String(runtimeConfig.workerSessionScope || 'ai-moderator-dry-run'),
  });
}

async function resolveGeminiCliPackageRoot(commandToRun) {
  const resolvedCommandPath = await resolveCommandRealPath(commandToRun);
  const candidateDirectories = buildGeminiPackageRootCandidates(resolvedCommandPath, commandToRun);
  for (const candidateDirectory of candidateDirectories) {
    if (await isGeminiCliPackageRoot(candidateDirectory)) {
      return candidateDirectory;
    }
  }
  return '';
}

async function resolveCommandRealPath(commandToRun) {
  try {
    return await realpath(commandToRun);
  } catch {
    return String(commandToRun || '');
  }
}

function buildGeminiPackageRootCandidates(resolvedCommandPath, originalCommandPath) {
  const commandDirectories = [resolvedCommandPath, originalCommandPath]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => dirname(value));
  const candidates = new Set();
  for (const directory of commandDirectories) {
    let currentDirectory = directory;
    let previousDirectory = '';
    while (currentDirectory && currentDirectory !== previousDirectory) {
      candidates.add(currentDirectory);
      candidates.add(resolve(currentDirectory, 'node_modules/@google/gemini-cli'));
      candidates.add(resolve(currentDirectory, '../node_modules/@google/gemini-cli'));
      candidates.add(resolve(currentDirectory, '../lib/node_modules/@google/gemini-cli'));
      previousDirectory = currentDirectory;
      currentDirectory = dirname(currentDirectory);
    }
  }
  return [...candidates];
}

async function isGeminiCliPackageRoot(candidateDirectory) {
  const packageJsonPath = resolve(candidateDirectory, 'package.json');
  const requiredModulePaths = [
    resolve(candidateDirectory, 'dist/src/config/config.js'),
    resolve(candidateDirectory, 'dist/src/config/settings.js'),
    resolve(candidateDirectory, 'dist/src/nonInteractiveCli.js'),
  ];
  try {
    const packageJsonText = await readFile(packageJsonPath, 'utf8');
    const parsed = safeParseJson(packageJsonText);
    if (parsed?.name !== '@google/gemini-cli') {
      return false;
    }
    await Promise.all(requiredModulePaths.map((modulePath) => access(modulePath, fsConstants.F_OK)));
    return true;
  } catch {
    return false;
  }
}

async function checkGeminiCommandAvailability(runtimeConfig) {
  const cacheKey = JSON.stringify({
    command: runtimeConfig.command,
    platform: process.platform,
  });
  const now = Date.now();
  if (
    commandAvailabilityCache.result
    && commandAvailabilityCache.key === cacheKey
    && (now - commandAvailabilityCache.checkedAtMs) < COMMAND_CHECK_CACHE_MS
  ) {
    return commandAvailabilityCache.result;
  }

  const result = looksLikePath(runtimeConfig.command)
    ? await checkCommandPath(runtimeConfig.command)
    : await locateCommandInPath(runtimeConfig.command);

  commandAvailabilityCache.key = cacheKey;
  commandAvailabilityCache.checkedAtMs = now;
  commandAvailabilityCache.result = result;
  return result;
}

function looksLikePath(command) {
  const normalized = String(command || '').trim();
  return normalized.includes('/') || normalized.includes('\\') || /^[A-Za-z]:/.test(normalized);
}

async function checkCommandPath(command) {
  try {
    await access(command, fsConstants.F_OK);
    return {
      available: true,
      message: 'Gemini CLI 실행 가능',
      commandPath: String(command),
    };
  } catch {
    return {
      available: false,
      message: 'Gemini CLI 실행 파일 경로를 찾지 못했습니다. GEMINI_COMMAND 경로를 확인하세요.',
      commandPath: String(command),
    };
  }
}

async function locateCommandInPath(command) {
  const locatorCommand = process.platform === 'win32' ? 'where' : 'which';
  const child = spawn(locatorCommand, [command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let didTimeout = false;
  child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    child.kill('SIGKILL');
  }, COMMAND_CHECK_TIMEOUT_MS);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code }));
    });
    const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const resolvedPaths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstPath = pickBestCommandPath(resolvedPaths);
    if (didTimeout) {
      return {
        available: false,
        message: `Gemini CLI 경로 확인이 timeout되었습니다. (${COMMAND_CHECK_TIMEOUT_MS}ms)`,
        commandPath: '',
      };
    }
    if (result.code === 0 && firstPath) {
      return {
        available: true,
        message: 'Gemini CLI 실행 가능',
        commandPath: firstPath,
      };
    }
    return {
      available: false,
      message: stderr || 'Gemini CLI 실행 파일을 찾지 못했습니다. GEMINI_COMMAND 또는 PATH를 확인하세요.',
      commandPath: '',
    };
  } catch (error) {
    return {
      available: false,
      message: error?.code === 'ENOENT'
        ? `${locatorCommand} 명령을 찾지 못했습니다. PATH 점검이 불가능합니다.`
        : `Gemini CLI 경로 확인 실패: ${error.message}`,
      commandPath: '',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildPromptInvocationArgs(runtimeConfig, prompt) {
  if (runtimeConfig.promptMode === 'arg') {
    return [runtimeConfig.promptFlag, prompt];
  }
  if (runtimeConfig.promptMode === 'stdin') {
    return [buildInlineEmptyPromptFlag(runtimeConfig.promptFlag)];
  }
  return [];
}

function buildInlineEmptyPromptFlag(promptFlag) {
  const normalizedFlag = String(promptFlag || '').trim();
  if (!normalizedFlag || normalizedFlag === '-p' || normalizedFlag === '--prompt') {
    return '--prompt=';
  }
  if (normalizedFlag.endsWith('=')) {
    return normalizedFlag;
  }
  return `${normalizedFlag}=`;
}

function getDefaultGeminiCommand() {
  return process.platform === 'win32' ? 'gemini.cmd' : 'gemini';
}

function getDefaultPromptMode() {
  return process.platform === 'win32' ? 'stdin' : 'arg';
}

function pickBestCommandPath(paths) {
  const candidates = Array.isArray(paths) ? paths.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (candidates.length === 0) {
    return '';
  }
  if (process.platform !== 'win32') {
    return candidates[0];
  }
  const preferredExtensions = ['.cmd', '.exe', '.bat', '.com'];
  return candidates.find((candidate) => preferredExtensions.some((extension) => candidate.toLowerCase().endsWith(extension)))
    || candidates[0];
}

function shouldUseShellExecution(commandPath) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(commandPath || '').trim());
}

function shouldRetryGeminiCliWithStdin(runtimeConfig, result) {
  if (process.platform !== 'win32' || runtimeConfig.promptMode !== 'arg' || result?.success) {
    return false;
  }
  const message = String(result?.message || '');
  const rawText = String(result?.rawText || '');
  return message.startsWith('Gemini CLI 종료 코드가 비정상입니다.')
    || rawText.includes('Cannot use both a positional prompt and the --prompt (-p) flag together');
}

function normalizeCompressionResult(compression) {
  if (!compression || typeof compression !== 'object') {
    return null;
  }
  return {
    attempted: compression.attempted === true,
    compressionStatus: String(compression.compressionStatus || ''),
    originalTokenCount: Number(compression.originalTokenCount || 0),
    newTokenCount: Number(compression.newTokenCount || 0),
    successful: compression.successful === true,
    shouldRecycleRuntime: compression.shouldRecycleRuntime === true,
    message: String(compression.message || ''),
  };
}

function sanitizeAssetBaseName(value) {
  const normalized = basename(String(value || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!normalized) {
    return '';
  }
  return normalized.replace(/\.(webp|png|jpg|jpeg)$/i, '');
}

function toPromptRelativePath(rootDir, filePath) {
  const relativePath = relative(rootDir, filePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('../')) {
    return filePath.replace(/\\/g, '/');
  }
  return relativePath.startsWith('./') ? relativePath : `./${relativePath}`;
}

function clampConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0.85;
  }
  return Math.max(0, Math.min(1, numericValue));
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export {
  applyDryRunDecisionPolicy,
  cleanupPreparedJudgeImageInputs,
  createBlurredThumbnail,
  getDefaultGeminiCommand,
  getDefaultPromptMode,
  judgePost,
  parseGeminiCliJson,
  prepareJudgeImageInputs,
  prewarmPersistentGeminiWorker,
  runGeminiCli,
  validateJudgeDecision,
};
