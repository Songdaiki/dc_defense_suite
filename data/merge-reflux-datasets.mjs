#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';

const DEFAULT_OUTPUT_PATH = 'data/semiconductor-reflux-title-set.json';

async function main() {
  const { inputPaths, outputPath, version } = parseCliArgs(process.argv.slice(2));

  if (!inputPaths.length) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const mergedDataset = await buildMergedDataset(inputPaths, version);
  const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
  await fs.writeFile(
    resolvedOutputPath,
    `${JSON.stringify(mergedDataset, null, 2)}\n`,
    'utf8',
  );

  console.log('[merge-reflux-datasets] 완료');
  console.log(`- 입력 파일 수: ${inputPaths.length}`);
  console.log(`- sourceGalleryIds: ${mergedDataset.sourceGalleryIds.join(', ') || '(없음)'}`);
  console.log(`- 고유 제목 수: ${mergedDataset.titles.length}`);
  console.log(`- version: ${mergedDataset.version}`);
  console.log(`- 출력 파일: ${resolvedOutputPath}`);
}

function parseCliArgs(argv) {
  const inputPaths = [];
  let outputPath = DEFAULT_OUTPUT_PATH;
  let version = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      continue;
    }

    if (token === '--out') {
      outputPath = String(argv[index + 1] || '').trim() || DEFAULT_OUTPUT_PATH;
      index += 1;
      continue;
    }

    if (token === '--version') {
      version = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    inputPaths.push(token);
  }

  return {
    inputPaths,
    outputPath,
    version: version || buildAutoVersion(),
  };
}

function printUsage() {
  console.log('사용법:');
  console.log('  node data/merge-reflux-datasets.mjs <input1.json> <input2.json> [...inputN.json] [--out <output.json>] [--version <version>]');
  console.log('');
  console.log('예시:');
  console.log('  node data/merge-reflux-datasets.mjs ./semiconductor.json ./thesingularity.json');
  console.log('  node data/merge-reflux-datasets.mjs ./semiconductor.json ./thesingularity.json --out ./merged.json');
  console.log('  node data/merge-reflux-datasets.mjs ./semiconductor.json ./thesingularity.json --version 2026-04-05-v2');
}

async function buildMergedDataset(inputPaths, version) {
  const normalizedTitleSet = new Set();
  const sourceGalleryIdSet = new Set();

  for (const rawInputPath of inputPaths) {
    const resolvedInputPath = path.resolve(process.cwd(), rawInputPath);
    const inputJson = await readJsonFile(resolvedInputPath);
    const dataset = normalizeInputDataset(inputJson, resolvedInputPath);

    for (const sourceGalleryId of dataset.sourceGalleryIds) {
      sourceGalleryIdSet.add(sourceGalleryId);
    }

    for (const title of dataset.titles) {
      normalizedTitleSet.add(title);
    }
  }

  return {
    _comment: 'JSON은 일반 주석을 지원하지 않아서 안내를 _comment 필드로 남긴다.',
    _comment_update_rule: 'titles를 수정했다면 version도 반드시 같이 올려야 한다. version이 그대로면 기존 관리자 local cache가 유지될 수 있다.',
    _comment_example: '예: 제목을 추가/삭제했다면 version을 2026-04-05-v1 -> 2026-04-06-v2 같이 올린다.',
    _comment_scope: '이 dataset은 반도체갤 전용이 아니라 특갤 옛글까지 합친 통합 역류기 제목 dataset으로 써도 된다.',
    version,
    updatedAt: new Date().toISOString(),
    sourceGalleryIds: [...sourceGalleryIdSet].sort((left, right) => left.localeCompare(right)),
    titles: [...normalizedTitleSet].sort((left, right) => left.localeCompare(right, 'ko')),
  };
}

async function readJsonFile(filePath) {
  try {
    const rawText = await fs.readFile(filePath, 'utf8');
    return JSON.parse(rawText);
  } catch (error) {
    throw new Error(`JSON 읽기 실패 (${filePath}): ${error.message}`);
  }
}

function normalizeInputDataset(payload, filePathForError) {
  if (Array.isArray(payload)) {
    return {
      sourceGalleryIds: [],
      titles: dedupeNormalizedTitles(payload),
    };
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`지원하지 않는 dataset 형식 (${filePathForError})`);
  }

  return {
    sourceGalleryIds: normalizeSourceGalleryIds(payload),
    titles: dedupeNormalizedTitles(payload.titles || []),
  };
}

function normalizeSourceGalleryIds(payload) {
  const rawSourceGalleryIds = Array.isArray(payload?.sourceGalleryIds)
    ? payload.sourceGalleryIds
    : [];
  const fallbackSourceGalleryId = String(payload?.sourceGalleryId || '').trim();

  return [...new Set([
    ...rawSourceGalleryIds.map((value) => String(value || '').trim()).filter(Boolean),
    ...(fallbackSourceGalleryId ? [fallbackSourceGalleryId] : []),
  ])];
}

function dedupeNormalizedTitles(titles) {
  return [...new Set(
    (Array.isArray(titles) ? titles : [])
      .map((title) => normalizeSemiconductorRefluxTitle(title))
      .filter(Boolean),
  )];
}

function buildAutoVersion(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

main().catch((error) => {
  console.error('[merge-reflux-datasets] 실패:', error.message);
  process.exitCode = 1;
});
