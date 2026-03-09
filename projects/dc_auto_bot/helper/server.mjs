import http from 'node:http';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, constants as fsConstants } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { createModerationRecordStore } from './db.mjs';
import { renderTransparencyDetailPage, renderTransparencyListPage } from './transparency.mjs';

const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_PORT = normalizePort(process.env.PORT, 4317);
const DEFAULT_TIMEOUT_MS = normalizePositiveInt(process.env.GEMINI_TIMEOUT_MS, 240000);
const DEFAULT_PROMPT_MODE = normalizePromptMode(process.env.GEMINI_PROMPT_MODE || getDefaultPromptMode());
const DEFAULT_PROMPT_FLAG = String(process.env.GEMINI_PROMPT_FLAG || '-p').trim() || '-p';
const DEFAULT_GEMINI_COMMAND = String(process.env.GEMINI_COMMAND || getDefaultGeminiCommand()).trim() || getDefaultGeminiCommand();
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_IMAGE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000;
const MAX_TITLE_LENGTH = 300;
const MAX_BODY_LENGTH = 4000;
const MAX_REASON_LENGTH = 300;
const MAX_IMAGE_URLS = 8;
const DEFAULT_THUMBNAIL_WIDTH = normalizePositiveInt(process.env.TRANSPARENCY_THUMBNAIL_WIDTH, 360);
const DEFAULT_THUMBNAIL_BLUR_SIGMA = normalizePositiveInt(process.env.TRANSPARENCY_THUMBNAIL_BLUR_SIGMA, 5);
const DEFAULT_THUMBNAIL_QUALITY = normalizePositiveInt(process.env.TRANSPARENCY_THUMBNAIL_WEBP_QUALITY, 64);
const COMMAND_CHECK_CACHE_MS = 5000;
const COMMAND_CHECK_TIMEOUT_MS = 2000;
const VALID_DECISIONS = new Set(['allow', 'deny', 'review']);
const IMAGE_ANALYSIS_TIMEOUT_FAILURE_TYPE = 'image_analysis_timeout';
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
const TRANSPARENCY_CSS_TEXT = readFileSync(
  new URL('./public/transparency.css', import.meta.url),
  'utf8',
);
const BOT_ICON_BUFFER = readFileSync(
  new URL('./public/bot-icon.png', import.meta.url),
);
const GEMINI_ICON_BUFFER = readFileSync(
  new URL('./public/gemini-icon.webp', import.meta.url),
);

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
  const imageFileRefs = Array.isArray(input.imageFileRefs) ? input.imageFileRefs.slice(0, MAX_IMAGE_URLS) : [];
  const imageSection = imageFileRefs.length > 0
    ? '생략 (로컬 첨부 이미지 파일을 우선 사용)'
    : imageUrls.length
      ? imageUrls.map((url, index) => `${index + 1}. ${url}`).join('\n')
      : '없음';
  const imageFileSection = imageFileRefs.length
    ? imageFileRefs.map((fileRef) => `@${fileRef}`).join('\n')
    : '없음';
  const readManyFilesInstruction = imageFileRefs.length > 0
    ? `read_many_files(paths=[${imageFileRefs.map((fileRef) => `"${fileRef}"`).join(', ')}], useDefaultExcludes=false, respect_git_ignore=false)`
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
    '- 독립 위반 정책이 3개 이상 동시에 성립하면 review보다 allow를 우선 고려해라.',
    '- 원문에 명시된 허용 예외(사실에 기반한 완장 비판, 현재 기술에 대한 비판, 단순 욕설)는 삭제/차단 사유로 분류하지 마라.',
    '- P6는 원문에 적힌 레퍼런스 기준을 따라 판정해라.',
    '- P11은 원문에 적힌 허용 예시와 금지 예시를 구분해라.',
    '- P14는 원문에 적힌 금지 떡밥 예시를 기준으로 판정해라.',
    '- 제목과 본문에 충분한 문맥이 있으면 텍스트 맥락을 우선하고, 이미지는 보조 근거로만 사용해라.',
    '- 본문이 비어 있거나 매우 짧고 이미지가 실제 핵심 내용을 담고 있을 때만 이미지 비중을 높여라.',
    '- 제목/본문이 정상적인 사용 후기, 정보 공유, 링크 소개라면 이미지가 다소 자극적이거나 썸네일 성격이어도 낚시글로 과잉 판정하지 마라.',
    '- 존재 여부가 불명확한 모델명, 버전명, 과장된 제목, 드립성 표현만으로 허위사실이나 낚시글로 단정하지 마라. 본문과 이미지 맥락까지 함께 확인해라.',
    '- 이미지 URL이 1개 이상 있으면 제목/본문과 함께 보조 근거로 확인해라.',
    '- 첨부 이미지 파일 경로가 제공되면 URL보다 파일 입력을 우선 확인해라.',
    '- 첨부 이미지 파일 경로가 제공되면 먼저 아래 read_many_files 호출 예시와 같은 방식으로 로컬 파일을 읽어라.',
    `- 이미지 파일 읽기 예시: ${readManyFilesInstruction}`,
    '- 첨부 이미지 파일 경로가 제공되면 외부 web_fetch 같은 도구를 쓰지 말고, 제공된 로컬 파일만 기준으로 이미지 내용을 판단해라.',
    '- 제목/본문이 명확하게 정상 정보 공유인데, 이미지가 단순 썸네일·프로필 사진·홍보 배너 수준이면 이미지 단독으로 과잉 판정하지 마라.',
    '- 인물 사진, 썸네일, 장식 이미지 자체만으로는 낚시/어그로로 단정하지 마라.',
    '- 이미지에 위반 근거가 있더라도 제목/본문 맥락과 함께 종합 판단해라.',
    '- 텍스트와 이미지가 충돌하면 곧바로 allow/deny로 단정하지 말고 review를 우선 고려해라.',
    '- 위반 근거가 이미지에만 있으면 reason에 반드시 "이미지" 또는 "첨부 이미지"를 직접 언급해라.',
    '- 이미지 내용을 충분히 확인하지 못해 판단이 애매하면 deny로 넘기지 말고 review를 사용해라.',
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
    `첨부 이미지 판독 결과:\n${String(input.imageAnalysis || '').trim() || '없음'}`,
    '',
    `첨부 이미지 파일 (멀티모달 입력, 있으면 반드시 확인):\n${imageFileSection}`,
    '',
    `첨부 이미지 URL (있으면 반드시 확인):\n${imageSection}`,
  ].join('\n');
}

function buildImageAnalysisPrompt(imageFileRefs = []) {
  const fileSection = Array.isArray(imageFileRefs) && imageFileRefs.length > 0
    ? imageFileRefs.map((fileRef) => `@${fileRef}`).join('\n')
    : '없음';

  return [
    '첨부 이미지의 내용을 직접 읽고, 판정에 필요한 텍스트/핵심 장면만 짧게 정리해라.',
    '추측하지 말고 실제로 보이는 내용만 적어라.',
    '특히 이미지 안의 텍스트, 고유명사, 숫자, 슬로건, 정치/혐오/광고/망상성 표현이 있으면 반드시 적어라.',
    '반드시 JSON object 하나만 출력해라.',
    '',
    '출력 형식:',
    '{',
    '  "visible_text": ["보이는 문구1", "보이는 문구2"],',
    '  "summary": "이미지 핵심 내용 요약",',
    '  "contains_policy_signal": true,',
    '  "notes": "판정에 참고할 점"',
    '}',
    '',
    '첨부 이미지 파일:',
    fileSection,
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
      imageFileRefs: [],
    },
  };
}

function sanitizeSelfTestImageRequest(input) {
  const targetUrl = String(input?.targetUrl || '').trim();
  const imageUrls = Array.isArray(input?.imageUrls)
    ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean).slice(0, MAX_IMAGE_URLS)
    : [];

  if (!targetUrl) {
    return { success: false, message: 'targetUrl이 필요합니다.' };
  }
  if (imageUrls.length === 0) {
    return { success: false, message: 'imageUrls가 필요합니다.' };
  }

  return {
    success: true,
    payload: {
      targetUrl,
      imageUrls,
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

function hasUsableGeminiDecisionOutput(rawText) {
  return parseGeminiCliJson(rawText).success === true;
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

function normalizeJudgeDecisionForAutomation(result) {
  if (!result || result.success !== true) {
    return result;
  }

  if (result.decision !== 'review') {
    return result;
  }

  const policyIds = Array.isArray(result.policy_ids)
    ? result.policy_ids.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
    : [];
  const promotablePolicyIds = policyIds.filter((policyId) => policyId !== 'NONE');

  if (promotablePolicyIds.length < 3) {
    return result;
  }

  return {
    ...result,
    decision: 'allow',
  };
}

function createHelperServer(runtimeConfig = buildRuntimeConfig(), dependencies = {}) {
  const store = dependencies.store || createModerationRecordStore(runtimeConfig.recordsFilePath);
  return http.createServer(async (request, response) => {
    try {
      await store.init();
      const requestUrl = new URL(request.url || '/', `http://${runtimeConfig.host}:${runtimeConfig.port}`);

      // ── Cloudflare Tunnel 보안 게이트 ──
      // CF-Connecting-IP 헤더가 있으면 Cloudflare Tunnel 경유 (외부 요청)
      // 외부 요청은 공개 읽기 전용 경로만 허용, 나머지 차단
      const isExternalRequest = Boolean(request.headers['cf-connecting-ip']);
      if (isExternalRequest) {
        const pathname = requestUrl.pathname;
        const isPublicRoute = request.method === 'GET' && (
          pathname === '/'
          || pathname === ''
          || pathname === '/index.html'
          || pathname === '/transparency'
          || pathname === '/transparency.css'
          || pathname === '/bot-icon.png'
          || pathname === '/gemini-icon.webp'
          || pathname.startsWith('/transparency/')
          || pathname.startsWith('/transparency-assets/')
        );

        if (!isPublicRoute) {
          writeJson(response, 403, {
            success: false,
            message: 'This endpoint is not available on the public site.',
          }, request);
          return;
        }
      }

      if (request.method === 'OPTIONS') {
        writeJson(response, 204, {});
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/health') {
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

      const pageHealthStatus = await buildTransparencyHealthStatus(runtimeConfig);

      if (request.method === 'GET' && (
        requestUrl.pathname === '/'
        || requestUrl.pathname === ''
        || requestUrl.pathname === '/index.html'
      )) {
        response.writeHead(302, {
          Location: '/transparency',
          ...buildCorsHeaders(request),
        });
        response.end();
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/transparency.css') {
        writeText(response, 200, TRANSPARENCY_CSS_TEXT, 'text/css; charset=utf-8', request);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/bot-icon.png') {
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        });
        response.end(BOT_ICON_BUFFER);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/gemini-icon.webp') {
        response.writeHead(200, {
          'Content-Type': 'image/webp',
          'Cache-Control': 'public, max-age=86400',
        });
        response.end(GEMINI_ICON_BUFFER);
        return;
      }

      if ((request.method === 'GET' || request.method === 'HEAD') && requestUrl.pathname.startsWith('/transparency-assets/')) {
        const assetName = sanitizeRequestedAssetFileName(requestUrl.pathname.replace(/^\/transparency-assets\//, ''));
        if (!assetName) {
          writeText(response, 404, renderNotFoundPage('이미지를 찾지 못했습니다.', pageHealthStatus), 'text/html; charset=utf-8', request);
          return;
        }

        const assetPath = resolve(runtimeConfig.assetsDir, assetName);
        if (!assetPath.startsWith(resolve(runtimeConfig.assetsDir))) {
          writeText(response, 404, renderNotFoundPage('이미지를 찾지 못했습니다.', pageHealthStatus), 'text/html; charset=utf-8', request);
          return;
        }

        try {
          const assetBody = await readFile(assetPath);
          response.writeHead(200, {
            'Content-Type': 'image/webp',
            'Cache-Control': 'public, max-age=300',
            ...buildCorsHeaders(request),
          });
          response.end(request.method === 'HEAD' ? undefined : assetBody);
        } catch {
          writeText(response, 404, renderNotFoundPage('이미지를 찾지 못했습니다.', pageHealthStatus), 'text/html; charset=utf-8', request);
        }
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/transparency') {
        const cursor = Math.max(0, Number(requestUrl.searchParams.get('cursor') || 0));
        const listResult = await store.listRecords({
          decision: requestUrl.searchParams.get('decision') || '',
          policyId: requestUrl.searchParams.get('policyId') || '',
          limit: requestUrl.searchParams.get('limit') || '50',
          cursor,
        });
        writeText(
          response,
          200,
          renderTransparencyListPage({
            records: listResult.records,
            nextCursor: listResult.nextCursor,
            total: listResult.total,
            cursor,
            healthStatus: pageHealthStatus,
          }),
          'text/html; charset=utf-8',
          request,
        );
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/transparency/')) {
        const recordId = decodeURIComponent(requestUrl.pathname.replace(/^\/transparency\//, ''));
        const record = await store.getRecord(recordId);
        if (!record) {
          writeText(response, 404, renderNotFoundPage('기록을 찾지 못했습니다.', pageHealthStatus), 'text/html; charset=utf-8', request);
          return;
        }

        writeText(response, 200, renderTransparencyDetailPage(record, pageHealthStatus), 'text/html; charset=utf-8', request);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/moderation-records') {
        const listResult = await store.listRecords({
          decision: requestUrl.searchParams.get('decision') || '',
          policyId: requestUrl.searchParams.get('policyId') || '',
          limit: requestUrl.searchParams.get('limit') || '50',
          cursor: requestUrl.searchParams.get('cursor') || '',
        });
        writeJson(response, 200, {
          success: true,
          total: listResult.total,
          records: listResult.records,
          nextCursor: listResult.nextCursor,
        });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/moderation-records/')) {
        const recordId = decodeURIComponent(requestUrl.pathname.replace(/^\/api\/moderation-records\//, ''));
        const record = await store.getRecord(recordId);
        if (!record) {
          writeJson(response, 404, {
            success: false,
            message: '기록을 찾지 못했습니다.',
          });
          return;
        }

        writeJson(response, 200, {
          success: true,
          record,
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/record') {
        const requestBody = await readJsonBody(request);
        const sanitized = sanitizeRecordRequest(requestBody);
        if (!sanitized.success) {
          writeJson(response, 400, {
            success: false,
            message: sanitized.message,
          });
          return;
        }

        const record = await preparePublicRecord(sanitized.recordInput, runtimeConfig);
        const savedRecord = await store.upsertRecord(record);
        writeJson(response, 200, {
          success: true,
          id: savedRecord.id,
          record: savedRecord,
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/self-test-image') {
        const requestBody = await readJsonBody(request);
        const sanitized = sanitizeSelfTestImageRequest(requestBody);
        if (!sanitized.success) {
          writeJson(response, 400, {
            success: false,
            message: sanitized.message,
          });
          return;
        }

        const result = await runImageRecognitionSelfTest(sanitized.payload, runtimeConfig);
        writeJson(response, 200, {
          success: true,
          ...result,
        });
        return;
      }

      if (request.method !== 'POST' || requestUrl.pathname !== '/judge') {
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

      const judgeStartedAtMs = Date.now();
      const preparedInputs = await prepareJudgeImageInputs(sanitized.payload, runtimeConfig);
      let cliResult = null;
      let imageAnalysisText = '';
      try {
        const imageAnalysisResult = await runImageAnalysis(preparedInputs.imageFileRefs, runtimeConfig, judgeStartedAtMs);
        if (imageAnalysisResult.timedOut) {
          writeJson(response, 200, {
            success: false,
            failure_type: IMAGE_ANALYSIS_TIMEOUT_FAILURE_TYPE,
            message: 'Gemini 이미지 분석 시간 초과',
            rawText: imageAnalysisResult.rawText || '',
          }, request);
          return;
        }
        imageAnalysisText = imageAnalysisResult.text;
        cliResult = await runGeminiCli(
          buildGeminiCliPrompt({
            ...sanitized.payload,
            imageFileRefs: preparedInputs.imageFileRefs,
            imageAnalysis: imageAnalysisText,
          }),
          withRemainingJudgeBudget(runtimeConfig, judgeStartedAtMs),
        );
      } finally {
        await cleanupPreparedJudgeImageInputs(preparedInputs);
      }
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

      const normalizedDecision = normalizeJudgeDecisionForAutomation(parsed);

      writeJson(response, 200, {
        success: true,
        decision: normalizedDecision.decision,
        confidence: normalizedDecision.confidence,
        policy_ids: normalizedDecision.policy_ids,
        reason: normalizedDecision.reason,
        rawText: normalizedDecision.rawText,
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
    recordsFilePath: process.env.TRANSPARENCY_RECORDS_FILE || fileURLToPath(new URL('./data/moderation-records.jsonl', import.meta.url)),
    assetsDir: process.env.TRANSPARENCY_ASSETS_DIR || fileURLToPath(new URL('./data/transparency-assets', import.meta.url)),
    judgeInputDir: process.env.TRANSPARENCY_JUDGE_INPUT_DIR || fileURLToPath(new URL('./gemini-inputs', import.meta.url)),
    helperRootDir: fileURLToPath(new URL('./', import.meta.url)),
    thumbnailWidth: DEFAULT_THUMBNAIL_WIDTH,
    thumbnailBlurSigma: DEFAULT_THUMBNAIL_BLUR_SIGMA,
    thumbnailWebpQuality: DEFAULT_THUMBNAIL_QUALITY,
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

function buildCorsHeaders(request) {
  // 외부 요청(Cloudflare Tunnel 경유)이면 CORS 헤더를 붙이지 않음
  // 로컬 익스텐션 요청에만 CORS 허용 (크롬 확장 프로그램은 CORS 필요)
  if (request && request.headers && request.headers['cf-connecting-ip']) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

function writeJson(response, statusCode, payload, request) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildCorsHeaders(request),
  });
  response.end(JSON.stringify(payload));
}

function writeText(response, statusCode, body, contentType, request) {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    ...buildCorsHeaders(request),
  });
  response.end(body);
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

async function buildTransparencyHealthStatus(runtimeConfig) {
  const availability = await checkGeminiCommandAvailability(runtimeConfig);
  return availability.available
    ? {
      isHealthy: true,
      label: '서버 상태',
      emoji: '🟢',
    }
    : {
      isHealthy: false,
      label: '서버 상태',
      emoji: '🔴',
    };
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

function sanitizeRecordRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      success: false,
      message: 'record 요청 본문 형식이 올바르지 않습니다.',
    };
  }

  const targetUrl = String(input.targetUrl || '').trim();
  const targetPostNo = String(input.targetPostNo || '').trim();
  if (!targetUrl && !targetPostNo) {
    return {
      success: false,
      message: 'targetUrl 또는 targetPostNo 중 하나는 필요합니다.',
    };
  }

  const source = String(input.source || 'auto_report').trim();
  if (source !== 'auto_report' && source !== 'manual_test') {
    return {
      success: false,
      message: '공개 transparency record는 auto_report 또는 manual_test만 저장합니다.',
    };
  }

  const decisionSource = String(input.decisionSource || 'gemini').trim();
  if (decisionSource === 'image_analysis_timeout_fallback') {
    const targetUrl = String(input.targetUrl || '').trim();
    const targetPostNo = String(input.targetPostNo || '').trim();
    const reason = String(input.reason || '').trim();
    if (!targetUrl && !targetPostNo) {
      return {
        success: false,
        message: 'targetUrl 또는 targetPostNo 중 하나는 필요합니다.',
      };
    }
    if (!reason) {
      return {
        success: false,
        message: 'reason 값이 비어 있습니다.',
      };
    }

    return {
      success: true,
      recordInput: {
        id: String(input.id || '').trim(),
        source,
        decisionSource,
        targetUrl,
        targetPostNo,
        title: String(input.title || '').trim(),
        bodyText: String(input.bodyText || '').trim(),
        reportReason: String(input.reportReason || '').trim(),
        imageUrls: Array.isArray(input.imageUrls)
          ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean).slice(0, MAX_IMAGE_URLS)
          : [],
        decision: 'allow',
        confidence: null,
        policyIds: [],
        reason,
      },
    };
  }

  const validatedDecision = validateJudgeDecision({
    decision: input.decision,
    confidence: input.confidence,
    policy_ids: Array.isArray(input.policyIds) ? input.policyIds : input.policy_ids,
    reason: input.reason,
  }, '');
  if (!validatedDecision.success) {
    return {
      success: false,
      message: validatedDecision.message,
    };
  }

  return {
    success: true,
    recordInput: {
      id: String(input.id || '').trim(),
      source,
      decisionSource,
      targetUrl,
      targetPostNo,
      title: String(input.title || '').trim(),
      bodyText: String(input.bodyText || '').trim(),
      reportReason: String(input.reportReason || '').trim(),
      imageUrls: Array.isArray(input.imageUrls)
        ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean).slice(0, MAX_IMAGE_URLS)
        : [],
      decision: validatedDecision.decision,
      confidence: validatedDecision.confidence,
      policyIds: validatedDecision.policy_ids,
      reason: validatedDecision.reason,
    },
  };
}

async function preparePublicRecord(input, runtimeConfig) {
  const recordId = String(input.id || '').trim() || buildRecordId();
  const blurredThumbnailPath = await createBlurredThumbnail({
    recordId,
    targetUrl: input.targetUrl,
    imageUrls: input.imageUrls,
    runtimeConfig,
  });

  return {
    id: recordId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: input.source,
    decisionSource: input.decisionSource,
    targetUrl: input.targetUrl,
    targetPostNo: input.targetPostNo,
    publicTitle: String(input.title || '').trim(),
    publicBody: String(input.bodyText || '').trim(),
    reportReason: input.reportReason,
    decision: input.decision,
    confidence: input.confidence,
    policyIds: input.policyIds,
    reason: input.reason,
    blurredThumbnailPath,
    imageCount: Array.isArray(input.imageUrls) ? input.imageUrls.length : 0,
  };
}

async function createBlurredThumbnail({ recordId, targetUrl, imageUrls, runtimeConfig }) {
  const candidateUrls = Array.isArray(imageUrls) ? imageUrls.map((value) => String(value || '').trim()).filter(Boolean) : [];
  if (candidateUrls.length === 0) {
    return '';
  }

  await mkdir(runtimeConfig.assetsDir, { recursive: true });
  const assetName = `${sanitizeAssetBaseName(recordId) || buildRecordId()}.webp`;
  const assetPath = resolve(runtimeConfig.assetsDir, assetName);

  for (const imageUrl of candidateUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, IMAGE_DOWNLOAD_TIMEOUT_MS);
      const response = await fetch(imageUrl, {
        method: 'GET',
        headers: buildImageDownloadHeaders(targetUrl),
        signal: controller.signal,
      }).finally(() => {
        clearTimeout(timeoutId);
      });
      if (!response.ok) {
        continue;
      }

      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (isClearlyNonImageContentType(contentType)) {
        continue;
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_IMAGE_DOWNLOAD_BYTES) {
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) {
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

async function prepareJudgeImageInputs(input, runtimeConfig) {
  const imageUrls = Array.isArray(input?.imageUrls) ? input.imageUrls.map((value) => String(value || '').trim()).filter(Boolean).slice(0, MAX_IMAGE_URLS) : [];
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
    const imageUrl = imageUrls[index];
    const downloaded = await downloadJudgeImageInput({
      imageUrl,
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, IMAGE_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(imageUrl, {
      method: 'GET',
      headers: buildImageDownloadHeaders(targetUrl),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { success: false };
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (isClearlyNonImageContentType(contentType)) {
      return { success: false };
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_DOWNLOAD_BYTES) {
      return { success: false };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) {
      return { success: false };
    }

    const normalizedBuffer = await normalizeJudgeImageBuffer(buffer);
    const fileName = `${buildRecordId()}_${index + 1}.png`;
    const filePath = resolve(runtimeConfig.judgeInputDir, fileName);
    await writeFile(filePath, normalizedBuffer);

    return {
      success: true,
      filePath,
      promptPath: toPromptRelativePath(runtimeConfig.helperRootDir, filePath),
    };
  } catch {
    return { success: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cleanupPreparedJudgeImageInputs(preparedInputs) {
  const cleanupPaths = Array.isArray(preparedInputs?.cleanupPaths) ? preparedInputs.cleanupPaths : [];
  for (const filePath of cleanupPaths) {
    try {
      await rm(filePath, { force: true });
    } catch {
      continue;
    }
  }
}

async function runImageAnalysis(imageFileRefs, runtimeConfig, judgeStartedAtMs = Date.now()) {
  if (!Array.isArray(imageFileRefs) || imageFileRefs.length === 0) {
    return {
      text: '',
      timedOut: false,
      rawText: '',
    };
  }

  const analysisResult = await runGeminiCli(
    buildImageAnalysisPrompt(imageFileRefs),
    withRemainingJudgeBudget(runtimeConfig, judgeStartedAtMs),
  );

  if (!analysisResult.success) {
    return {
      text: '',
      timedOut: String(analysisResult.message || '').includes('시간 초과'),
      rawText: String(analysisResult.rawText || ''),
    };
  }

  const parsed = safeParseJson(String(analysisResult.rawText || '').trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      text: '',
      timedOut: false,
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
    timedOut: false,
    rawText: String(analysisResult.rawText || ''),
  };
}

function withRemainingJudgeBudget(runtimeConfig, startedAtMs) {
  const elapsedMs = Math.max(0, Date.now() - Number(startedAtMs || 0));
  const remainingMs = Math.max(1000, Number(runtimeConfig.timeoutMs || DEFAULT_TIMEOUT_MS) - elapsedMs);
  return {
    ...runtimeConfig,
    timeoutMs: remainingMs,
  };
}

async function runImageRecognitionSelfTest(input, runtimeConfig) {
  const preparedInputs = await prepareJudgeImageInputs(input, runtimeConfig);
  const fileRefs = preparedInputs.imageFileRefs;
  const reports = [];
  const strategies = [
    {
      name: 'file_ref_only',
      prompt: buildImageRecognitionSelfTestPrompt(fileRefs),
      runtimeConfig: {
        ...runtimeConfig,
        timeoutMs: Math.min(runtimeConfig.timeoutMs, 30000),
      },
    },
    {
      name: 'read_many_files_explicit',
      prompt: buildImageRecognitionSelfTestPrompt(
        fileRefs,
        `먼저 read_many_files(include=[${fileRefs.map((fileRef) => `"${fileRef}"`).join(', ')}], useDefaultExcludes=false, file_filtering_options={respect_git_ignore:false, respect_gemini_ignore:false}) 를 호출해 이미지를 읽어라.`,
      ),
      runtimeConfig: {
        ...runtimeConfig,
        timeoutMs: Math.min(runtimeConfig.timeoutMs, 30000),
      },
    },
    {
      name: 'read_many_files_yolo',
      prompt: buildImageRecognitionSelfTestPrompt(
        fileRefs,
        `먼저 read_many_files(include=[${fileRefs.map((fileRef) => `"${fileRef}"`).join(', ')}], useDefaultExcludes=false, file_filtering_options={respect_git_ignore:false, respect_gemini_ignore:false}) 를 호출해 이미지를 읽어라.`,
      ),
      runtimeConfig: {
        ...runtimeConfig,
        timeoutMs: Math.min(runtimeConfig.timeoutMs, 30000),
        args: [...runtimeConfig.args, '--approval-mode', 'yolo'],
      },
    },
  ];

  try {
    for (const strategy of strategies) {
      const result = await runGeminiCli(strategy.prompt, strategy.runtimeConfig);
      reports.push({
        name: strategy.name,
        success: Boolean(result?.success),
        message: String(result?.message || ''),
        rawText: String(result?.rawText || ''),
      });
    }
  } finally {
    await cleanupPreparedJudgeImageInputs(preparedInputs);
  }

  return {
    imageFileRefs: fileRefs,
    reports,
  };
}

function buildImageRecognitionSelfTestPrompt(imageFileRefs, extraInstruction = '') {
  return [
    '첨부 이미지를 직접 읽고 아주 짧게 답해라.',
    '반드시 다음 2가지를 답해라.',
    '1. 상단 프로필명',
    '2. 카드 이미지 속 숫자 쌍',
    extraInstruction || '',
    '',
    '첨부 이미지 파일:',
    imageFileRefs.map((fileRef) => `@${fileRef}`).join('\n'),
  ].filter(Boolean).join('\n');
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

  if (normalized.startsWith('image/')) {
    return false;
  }

  if (normalized === 'application/octet-stream') {
    return false;
  }

  return normalized.startsWith('text/')
    || normalized.includes('html')
    || normalized.includes('json')
    || normalized.includes('xml');
}

function sanitizeAssetBaseName(value) {
  const normalized = basename(String(value || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!normalized) {
    return '';
  }

  return normalized.replace(/\.(webp|png|jpg|jpeg)$/i, '');
}

function sanitizeRequestedAssetFileName(value) {
  const normalized = basename(String(value || '').trim()).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!normalized || !normalized.toLowerCase().endsWith('.webp')) {
    return '';
  }

  return normalized;
}

async function normalizeJudgeImageBuffer(buffer) {
  return sharp(buffer, { animated: true })
    .rotate()
    .png()
    .toBuffer();
}

function toPromptRelativePath(rootDir, filePath) {
  const relativePath = relative(rootDir, filePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('../')) {
    return filePath.replace(/\\/g, '/');
  }

  return relativePath.startsWith('./') ? relativePath : `./${relativePath}`;
}

function buildRecordId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `record_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
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

function renderNotFoundPage(message) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>Not Found</title><link rel="stylesheet" href="/transparency.css"></head><body><main class="app"><section class="page-header"><h1>Not Found</h1><p>${message}</p><p><a href="/transparency">목록으로 돌아가기</a></p></section></main></body></html>`;
}

async function startServer(runtimeConfig = buildRuntimeConfig()) {
  // ── 보안: loopback 전용 바인딩 강제 ──
  // Cloudflare Tunnel 보안 게이트는 loopback 바인딩을 전제로 동작합니다.
  // 127.0.0.1 또는 ::1 외의 주소로 바인딩하면 외부에서 CF 헤더 없이
  // 직접 접근이 가능해져 보안 게이트가 우회됩니다.
  const ALLOWED_HOSTS = ['127.0.0.1', '::1', 'localhost'];
  if (!ALLOWED_HOSTS.includes(runtimeConfig.host)) {
    throw new Error(
      `[보안 오류] HOST=${runtimeConfig.host} 바인딩은 금지됩니다. `
      + 'Cloudflare Tunnel 보안 게이트가 우회될 수 있습니다. '
      + 'HOST=127.0.0.1 (기본값)으로 실행하세요.'
    );
  }

  const store = createModerationRecordStore(runtimeConfig.recordsFilePath);
  await store.init();
  const server = createHelperServer(runtimeConfig, { store });
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
  buildImageAnalysisPrompt,
  buildRuntimeConfig,
  cleanupPreparedJudgeImageInputs,
  createHelperServer,
  normalizeJudgeDecisionForAutomation,
  prepareJudgeImageInputs,
  pickBestCommandPath,
  parseGeminiCliJson,
  runImageAnalysis,
  runGeminiCli,
  sanitizeJudgeRequest,
  sanitizeRecordRequest,
  shouldUseShellExecution,
  startServer,
  validateJudgeDecision,
};
