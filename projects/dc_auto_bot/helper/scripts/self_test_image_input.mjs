import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import {
  buildRuntimeConfig,
  cleanupPreparedJudgeImageInputs,
  runGeminiCli,
} from '../server.mjs';

const DEFAULT_IMAGE_PATH = '../icons/1773057277.png';
const EXPECTED_KEYWORDS = [
  '안드레이',
  '카르파티',
  'karpathy',
  '0.9979',
  '0.9697',
  '126',
  'session report',
];
const SELF_TEST_TIMEOUT_MS = 30000;

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const helperDir = resolve(scriptDir, '..');
  const imagePath = resolve(helperDir, process.argv[2] || DEFAULT_IMAGE_PATH);

  const runtimeConfig = buildRuntimeConfig();
  runtimeConfig.helperRootDir = helperDir;
  runtimeConfig.judgeInputDir = resolve(helperDir, 'gemini-inputs');
  runtimeConfig.timeoutMs = SELF_TEST_TIMEOUT_MS;

  await mkdir(runtimeConfig.judgeInputDir, { recursive: true });
  const tempImagePath = resolve(runtimeConfig.judgeInputDir, 'self_test_target.png');
  await copyFile(imagePath, tempImagePath);
  const fallbackPrepared = {
    imageFileRefs: [toPromptRelativePath(helperDir, tempImagePath)],
    cleanupPaths: [tempImagePath],
  };

  const strategies = [
    {
      name: 'file_ref_only',
      prompt: buildPrompt({
        imageFileRefs: fallbackPrepared.imageFileRefs,
        localReadInstruction: '',
      }),
      runtimeConfig,
    },
    {
      name: 'read_many_files_explicit',
      prompt: buildPrompt({
        imageFileRefs: fallbackPrepared.imageFileRefs,
        localReadInstruction: `먼저 read_many_files(paths=[${fallbackPrepared.imageFileRefs.map((fileRef) => `"${fileRef}"`).join(', ')}], useDefaultExcludes=false, respect_git_ignore=false) 를 호출해 이미지를 읽은 뒤 답해라.`,
      }),
      runtimeConfig,
    },
    {
      name: 'read_many_files_yolo',
      prompt: buildPrompt({
        imageFileRefs: fallbackPrepared.imageFileRefs,
        localReadInstruction: `먼저 read_many_files(paths=[${fallbackPrepared.imageFileRefs.map((fileRef) => `"${fileRef}"`).join(', ')}], useDefaultExcludes=false, respect_git_ignore=false) 를 호출해 이미지를 읽은 뒤 답해라.`,
      }),
      runtimeConfig: {
        ...runtimeConfig,
        args: [...runtimeConfig.args, '--approval-mode', 'yolo'],
      },
    },
  ];

  const reports = [];
  try {
    for (const strategy of strategies) {
      const result = await runGeminiCli(strategy.prompt, strategy.runtimeConfig);
      const rawText = String(result?.rawText || '').trim();
      reports.push({
        name: strategy.name,
        success: Boolean(result?.success),
        score: scoreImageRecognition(rawText),
        matchedKeywords: pickMatchedKeywords(rawText),
        rawText,
        message: result?.message || '',
      });
    }
  } finally {
    await cleanupPreparedJudgeImageInputs(fallbackPrepared);
    await rm(tempImagePath, { force: true }).catch(() => {});
  }

  const best = [...reports].sort((left, right) => right.score - left.score)[0] || null;
  process.stdout.write(`${JSON.stringify({
    imagePath,
    imageFileRefs: fallbackPrepared.imageFileRefs,
    expectedKeywords: EXPECTED_KEYWORDS,
    best,
    reports,
  }, null, 2)}\n`);
}

function buildPrompt({ imageFileRefs, localReadInstruction }) {
  return [
    '다음 첨부 이미지 내용을 확인해서 아주 짧게 답해라.',
    '설명이나 추측을 길게 쓰지 말고, 이미지에서 확인한 핵심 정보만 답해라.',
    '반드시 아래 2가지를 포함해라:',
    '1. 화면 상단 프로필명',
    '2. 카드 이미지 속 숫자 쌍',
    localReadInstruction || '',
    '',
    '첨부 이미지 파일:',
    imageFileRefs.map((fileRef) => `@${fileRef}`).join('\n'),
  ].filter(Boolean).join('\n');
}

function scoreImageRecognition(text) {
  return pickMatchedKeywords(text).length;
}

function pickMatchedKeywords(text) {
  const normalized = String(text || '').toLowerCase();
  return EXPECTED_KEYWORDS.filter((keyword) => normalized.includes(keyword.toLowerCase()));
}

function toPromptRelativePath(helperDir, filePath) {
  const relativePath = relative(helperDir, filePath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('../')) {
    return filePath.replace(/\\/g, '/');
  }

  return relativePath.startsWith('./') ? relativePath : `./${relativePath}`;
}

main().catch((error) => {
  console.error('[self_test_image_input] failed:', error);
  process.exitCode = 1;
});
