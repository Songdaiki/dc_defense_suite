import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import { readFileSync, constants as fsConstants } from 'node:fs';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = normalizePort(process.env.PORT, 4317);
const DEFAULT_TIMEOUT_MS = normalizePositiveInt(process.env.GEMINI_TIMEOUT_MS, 90000);
const DEFAULT_PROMPT_MODE = normalizePromptMode(process.env.GEMINI_PROMPT_MODE || getDefaultPromptMode());
const DEFAULT_PROMPT_FLAG = String(process.env.GEMINI_PROMPT_FLAG || '-p').trim() || '-p';
const DEFAULT_GEMINI_COMMAND = String(process.env.GEMINI_COMMAND || getDefaultGeminiCommand()).trim() || getDefaultGeminiCommand();
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 4000;
const MAX_REASON_LENGTH = 300;
const MAX_IMAGE_URLS = 8;
const COMMAND_CHECK_CACHE_MS = 5000;
const COMMAND_CHECK_TIMEOUT_MS = 2000;
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

const POLICY_GUIDE = [
  'P1: 디시인사이드 이용 약관, 법률, 건전한 사회 통념을 위반하는 내용',
  'P2: 닉언, 친목질, 사칭',
  'P3: 분탕 및 어그로(꼬투리 잡기 등 고로시 포함)',
  'P4: 모든 종류의 종교, 음모론 관련 글 (자연의 섭리 포함)',
  'P5: 반과학, 유사과학, 반지성주의, 직업 비하/조롱',
  'P6: 1개 이상의 레퍼런스를 첨부하지 않은 선형글',
  'P7: 주제 무관, 본 갤러리 또는 이용자에 대한 일침/설교성 글',
  'P8: 구체적 인증 없이 현직자/전공자를 주장하며 작성한 글, 과도한 특정 인물 팬보이 글, 의도적 갈드컵 유발 글',
  'P9: 주식, 코인, 투자 관련 글',
  'P10: 과도한 국뽕, 일뽕, 중뽕, 출산율, 혐한/국까 떡밥',
  'P11: 모든 종류의 국내 정치인/정당/정책/공약/정치사상적 주장, 지역드립, 성별 혐오',
  'P12: 타 갤러리, 타 커뮤니티 언급',
  'P13: 맥락 없는 시비성 욕설, 상호 간 욕설이 포함된 싸움',
  'P14: 금지 떡밥 게시글',
  'P15: 개념글 제한',
  'NONE: 해당 없음',
].join('\n');

const GALLERY_POLICY_SOURCE_TEXT = readFileSync(
  new URL('../docs/thesingularity_gallery_policy.md', import.meta.url),
  'utf8',
).trim();

const commandAvailabilityCache = {
  key: '',
  checkedAtMs: 0,
  result: null,
};

function buildGeminiCliPrompt(input) {
  const title = truncateText(input.title, MAX_TITLE_LENGTH);
  const bodyText = truncateText(input.bodyText, MAX_BODY_LENGTH);
  const reportReason = truncateText(input.reportReason, MAX_REASON_LENGTH);
  const requestLabel = truncateText(input.requestLabel, 40);
  const authorFilter = truncateText(input.authorFilter, 40) || 'unknown';
  const imageUrls = input.imageUrls.slice(0, MAX_IMAGE_URLS);
  const imageSection = imageUrls.length
    ? imageUrls.map((url, index) => `${index + 1}. ${url}`).join('\n')
    : '없음';

  return [
    '다음 게시물이 디시 운영 규정 P1~P15 중 어디에 해당하는지 판정해라.',
    '반드시 JSON object 하나만 출력하고 설명문, 코드펜스, 마크다운을 붙이지 마라.',
    '원문 운영 방침과 허용 예외를 source of truth로 사용하고, 요약 인덱스는 원문 매핑용으로만 사용해라.',
    '',
    '정책 ID:',
    POLICY_GUIDE,
    '',
    '갤러리 운영 방침 원문:',
    GALLERY_POLICY_SOURCE_TEXT,
    '',
    '강제 규칙:',
    '- allow는 현재 자동화가 삭제/차단을 바로 진행해도 되는 경우에만 사용한다.',
    '- deny는 운영 규정 위반이 아니거나 자동 삭제/차단을 하면 안 되는 경우에 사용한다.',
    '- review는 애매하거나 운영자 확인이 필요한 경우에 사용한다.',
    '- policy_ids가 ["NONE"]이면 decision은 반드시 "deny"여야 한다.',
    '- allow는 최소 1개 이상의 P1~P15 위반이 명확할 때만 사용한다.',
    '- 개념글 제한만 필요한 경우처럼 삭제/차단 자동화와 맞지 않는 경우는 review를 사용한다.',
    '- 원문에 명시된 허용 예외(사실에 기반한 완장 비판, 현재 기술에 대한 비판, 단순 욕설)는 삭제/차단 사유로 분류하지 마라.',
    '- P6는 원문에 적힌 레퍼런스 기준을 따라 판정해라.',
    '- P11은 원문에 적힌 허용 예시와 금지 예시를 구분해라.',
    '- P14는 원문에 적힌 금지 떡밥 예시를 기준으로 판정해라.',
    '',
    '출력 형식:',
    '{',
    '  "decision": "allow|deny|review",',
    '  "confidence": 0.0,',
    '  "policy_ids": ["P3"],',
    '  "reason": "짧은 판정 사유"',
    '}',
    '',
    `대상 게시물 URL:\n${input.targetUrl}`,
    '',
    `작성자 필터 결과:\n${authorFilter}`,
    '',
    `신고자 label:\n${requestLabel || '없음'}`,
    '',
    `신고 사유:\n${reportReason || '없음'}`,
    '',
    `제목:\n${title || '없음'}`,
    '',
    `본문:\n${bodyText || '없음'}`,
    '',
    `이미지 URL:\n${imageSection}`,
  ].join('\n');
}

function sanitizeJudgeRequest(input) {
  const targetUrl = String(input?.targetUrl || '').trim();
  if (!targetUrl) {
    return { success: false, message: 'targetUrl이 필요합니다.' };
  }

  return {
    success: true,
    payload: {
      targetUrl,
      title: String(input?.title || '').trim(),
      bodyText: String(input?.bodyText || '').trim(),
      imageUrls: Array.isArray(input?.imageUrls)
        ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
      reportReason: String(input?.reportReason || '').trim(),
      requestLabel: String(input?.requestLabel || '').trim(),
      authorFilter: String(input?.authorFilter || '').trim() || 'unknown',
    },
  };
}

async function runGeminiCli(prompt, runtimeConfig = buildRuntimeConfig()) {
  const availability = await checkGeminiCommandAvailability(runtimeConfig);
  if (!availability.available) {
    return {
      success: false,
      message: availability.message,
      rawText: '',
    };
  }

  const commandToRun = availability.commandPath || runtimeConfig.command;
  const primaryResult = await runGeminiCliOnce(prompt, runtimeConfig, commandToRun);
  if (shouldRetryGeminiCliWithStdin(runtimeConfig, primaryResult)) {
    return runGeminiCliOnce(
      prompt,
      {
        ...runtimeConfig,
        promptMode: 'stdin',
      },
      commandToRun,
    );
  }

  return primaryResult;
}

async function runGeminiCliOnce(prompt, runtimeConfig, commandToRun) {
  const childArgs = [...runtimeConfig.args];
  if (runtimeConfig.promptMode === 'arg') {
    childArgs.push(runtimeConfig.promptFlag, prompt);
  } else if (runtimeConfig.promptMode === 'stdin') {
    childArgs.push(runtimeConfig.promptFlag, '');
  }

  const child = spawn(commandToRun, childArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: shouldUseShellExecution(commandToRun),
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

  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
  });

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    child.kill('SIGKILL');
  }, runtimeConfig.timeoutMs);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const rawText = [stdout, stderr].filter(Boolean).join('\n').trim();

    if (didTimeout) {
      return {
        success: false,
        message: `Gemini CLI 응답 대기 시간이 초과되었습니다. (${runtimeConfig.timeoutMs}ms)`,
        rawText,
      };
    }

    if (result.code !== 0) {
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
    const message = error?.code === 'ENOENT'
      ? 'Gemini CLI 실행 파일을 찾지 못했습니다. GEMINI_COMMAND 또는 PATH를 확인하세요.'
      : `Gemini CLI 실행 실패: ${error.message}`;
    return {
      success: false,
      message,
      rawText: Buffer.concat([...stdoutChunks, ...stderrChunks]).toString('utf8').trim(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseGeminiCliJson(rawText) {
  const normalizedText = String(rawText || '').trim();
  if (!normalizedText) {
    return {
      success: false,
      message: 'Gemini CLI 출력이 비어 있습니다.',
    };
  }

  const candidates = [];
  candidates.push(normalizedText);

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

function validateJudgeDecision(data, rawText) {
  const decision = String(data.decision || '').trim().toLowerCase();
  const confidence = Number(data.confidence);
  const policyIds = [...new Set(
    (Array.isArray(data.policy_ids) ? data.policy_ids : (Array.isArray(data.policyIds) ? data.policyIds : []))
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean),
  )];
  const reason = String(data.reason || '').trim();

  if (!VALID_DECISIONS.has(decision)) {
    return { success: false, message: 'decision 값이 올바르지 않습니다.' };
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { success: false, message: 'confidence 값이 올바르지 않습니다.' };
  }
  if (policyIds.length === 0) {
    return { success: false, message: 'policy_ids가 비어 있습니다.' };
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
    return { success: false, message: 'policy_ids가 ["NONE"]이면 decision은 deny여야 합니다.' };
  }

  if (decision === 'allow' && policyIds.length === 1 && policyIds[0] === 'P15') {
    return { success: false, message: 'P15 단독 allow는 자동 삭제/차단 대상으로 처리할 수 없습니다.' };
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

function createHelperServer(runtimeConfig = buildRuntimeConfig()) {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        writeJson(response, 204, {});
        return;
      }

      if (request.method === 'GET' && request.url === '/health') {
        const availability = await checkGeminiCommandAvailability(runtimeConfig);
        if (!availability.available) {
          writeJson(response, 200, {
            success: false,
            status: 'gemini_unavailable',
            message: availability.message,
            host: runtimeConfig.host,
            port: runtimeConfig.port,
            geminiCommand: runtimeConfig.command,
            commandPath: availability.commandPath || '',
            promptMode: runtimeConfig.promptMode,
            timeoutMs: runtimeConfig.timeoutMs,
          });
          return;
        }

        writeJson(response, 200, {
          success: true,
          status: 'ok',
          host: runtimeConfig.host,
          port: runtimeConfig.port,
          geminiCommand: runtimeConfig.command,
          commandPath: availability.commandPath || '',
          promptMode: runtimeConfig.promptMode,
          timeoutMs: runtimeConfig.timeoutMs,
        });
        return;
      }

      if (request.method !== 'POST' || request.url !== '/judge') {
        writeJson(response, 404, {
          success: false,
          message: '지원하지 않는 endpoint입니다.',
        });
        return;
      }

      const requestBody = await readJsonBody(request);
      const sanitized = sanitizeJudgeRequest(requestBody);
      if (!sanitized.success) {
        writeJson(response, 400, {
          success: false,
          message: sanitized.message,
        });
        return;
      }

      const prompt = buildGeminiCliPrompt(sanitized.payload);
      const cliResult = await runGeminiCli(prompt, runtimeConfig);
      if (!cliResult.success) {
        writeJson(response, 200, {
          success: false,
          message: cliResult.message,
          rawText: cliResult.rawText || '',
        });
        return;
      }

      const parsed = parseGeminiCliJson(cliResult.rawText);
      if (!parsed.success) {
        writeJson(response, 200, {
          success: false,
          message: parsed.message,
          rawText: cliResult.rawText,
        });
        return;
      }

      writeJson(response, 200, {
        success: true,
        decision: parsed.decision,
        confidence: parsed.confidence,
        policy_ids: parsed.policy_ids,
        reason: parsed.reason,
        rawText: parsed.rawText,
      });
    } catch (error) {
      writeJson(response, 500, {
        success: false,
        message: error.message,
      });
    }
  });
}

function buildRuntimeConfig() {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    command: DEFAULT_GEMINI_COMMAND,
    args: parseArgsJson(process.env.GEMINI_ARGS_JSON),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    promptMode: DEFAULT_PROMPT_MODE,
    promptFlag: DEFAULT_PROMPT_FLAG,
  };
}

function parseArgsJson(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((entry) => String(entry || ''));
  } catch {
    return [];
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(payload));
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

      const parsed = safeParseJson(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new Error('JSON 요청 본문 파싱 실패'));
        return;
      }

      resolve(parsed);
    });

    request.on('error', reject);
  });
}

function stripJsonFences(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function extractJsonObjects(text) {
  const source = String(text || '');
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  const objects = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

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
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateText(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizePort(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return numericValue;
}

function normalizePositiveInt(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.floor(numericValue);
}

function normalizePromptMode(value) {
  return String(value || '').trim().toLowerCase() === 'stdin' ? 'stdin' : 'arg';
}

function getDefaultPromptMode() {
  return process.platform === 'win32' ? 'stdin' : 'arg';
}

function shouldRetryGeminiCliWithStdin(runtimeConfig, result) {
  if (process.platform !== 'win32') {
    return false;
  }

  if (runtimeConfig.promptMode !== 'arg') {
    return false;
  }

  if (result?.success) {
    return false;
  }

  const message = String(result?.message || '');
  const rawText = String(result?.rawText || '');
  return message.startsWith('Gemini CLI 종료 코드가 비정상입니다.')
    || rawText.includes('Cannot use both a positional prompt and the --prompt (-p) flag together');
}

function getDefaultGeminiCommand() {
  return process.platform === 'win32' ? 'gemini.cmd' : 'gemini';
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

  let result = null;
  if (looksLikePath(runtimeConfig.command)) {
    result = await checkCommandPath(runtimeConfig.command);
  } else {
    result = await locateCommandInPath(runtimeConfig.command);
  }

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

  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  const timeoutId = setTimeout(() => {
    didTimeout = true;
    child.kill('SIGKILL');
  }, COMMAND_CHECK_TIMEOUT_MS);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        resolve({ code });
      });
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

function pickBestCommandPath(paths) {
  const candidates = Array.isArray(paths) ? paths.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (candidates.length === 0) {
    return '';
  }

  if (process.platform !== 'win32') {
    return candidates[0];
  }

  const preferredExtensions = ['.cmd', '.exe', '.bat', '.com'];
  for (const extension of preferredExtensions) {
    const matched = candidates.find((candidate) => candidate.toLowerCase().endsWith(extension));
    if (matched) {
      return matched;
    }
  }

  return candidates[0];
}

function shouldUseShellExecution(commandPath) {
  if (process.platform !== 'win32') {
    return false;
  }

  return /\.(cmd|bat)$/i.test(String(commandPath || '').trim());
}

function startServer(runtimeConfig = buildRuntimeConfig()) {
  const server = createHelperServer(runtimeConfig);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(runtimeConfig.port, runtimeConfig.host, () => {
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
    .then((server) => {
      const address = server.address();
      if (address && typeof address === 'object') {
        console.log(`[CLI Helper] listening on http://${address.address}:${address.port}`);
      }
    })
    .catch((error) => {
      console.error('[CLI Helper] failed to start:', error);
      process.exitCode = 1;
    });
}

export {
  buildGeminiCliPrompt,
  buildRuntimeConfig,
  pickBestCommandPath,
  createHelperServer,
  parseGeminiCliJson,
  runGeminiCli,
  sanitizeJudgeRequest,
  shouldUseShellExecution,
  startServer,
  validateJudgeDecision,
};
