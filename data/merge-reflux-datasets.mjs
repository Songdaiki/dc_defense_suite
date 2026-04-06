#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';

const DEFAULT_OUTPUT_PATH = 'data/reflux-title-set-unified.json';
const DEFAULT_MAX_SHARD_BYTES = 45 * 1024 * 1024;

async function main() {
  const {
    inputPaths,
    outputPath,
    version,
    maxShardBytes,
  } = parseCliArgs(process.argv.slice(2));

  if (!inputPaths.length) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const mergedDataset = await buildMergedDataset(inputPaths, version);
  const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
  const outputSummary = await writeMergedDatasetOutput(resolvedOutputPath, mergedDataset, maxShardBytes);

  console.log('[merge-reflux-datasets] 완료');
  console.log(`- 입력 파일 수: ${inputPaths.length}`);
  console.log(`- sourceGalleryIds: ${mergedDataset.sourceGalleryIds.join(', ') || '(없음)'}`);
  console.log(`- 고유 제목 수: ${mergedDataset.titles.length}`);
  console.log(`- version: ${mergedDataset.version}`);
  console.log(`- shard 수: ${outputSummary.shardCount}`);
  console.log(`- 출력 manifest: ${resolvedOutputPath}`);
}

function parseCliArgs(argv) {
  const inputPaths = [];
  let outputPath = DEFAULT_OUTPUT_PATH;
  let version = '';
  let maxShardMb = '';

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

    if (token === '--max-shard-mb') {
      maxShardMb = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }

    inputPaths.push(token);
  }

  return {
    inputPaths,
    outputPath,
    version: version || buildAutoVersion(),
    maxShardBytes: normalizeMaxShardBytes(maxShardMb),
  };
}

function printUsage() {
  console.log('사용법:');
  console.log('  node data/merge-reflux-datasets.mjs <input1.json> <input2.json> [...inputN.json] [--out <output.json>] [--version <version>] [--max-shard-mb <mb>]');
  console.log('');
  console.log('예시:');
  console.log('  node data/merge-reflux-datasets.mjs ./semiconductor.json ./thesingularity.json');
  console.log('  node data/merge-reflux-datasets.mjs ./semiconductor.json ./thesingularity.json --out ./merged.json');
  console.log('  node data/merge-reflux-datasets.mjs ./semiconductor.json ./thesingularity.json --version 2026-04-05-v2');
  console.log('  node data/merge-reflux-datasets.mjs ./semiconductor.json ./thesingularity.json --max-shard-mb 45');
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

async function writeMergedDatasetOutput(outputPath, mergedDataset, maxShardBytes) {
  const relativeOutputPath = normalizeRelativeOutputPath(outputPath);
  const shardDefinitions = buildTitleShards(relativeOutputPath, mergedDataset.titles, maxShardBytes);
  const manifest = buildShardManifest(outputPath, mergedDataset, shardDefinitions);
  const staleShardPaths = await findExistingShardPaths(outputPath);
  const nextShardPaths = new Set(shardDefinitions.map((shard) => shard.absolutePath));

  for (const shard of shardDefinitions) {
    await fs.writeFile(
      shard.absolutePath,
      `${JSON.stringify({ titles: shard.titles }, null, 2)}\n`,
      'utf8',
    );
  }

  for (const staleShardPath of staleShardPaths) {
    if (!nextShardPaths.has(staleShardPath)) {
      await fs.rm(staleShardPath, { force: true });
    }
  }

  await fs.writeFile(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  return {
    shardCount: shardDefinitions.length,
  };
}

function buildTitleShards(outputPath, titles, maxShardBytes) {
  const normalizedTitles = Array.isArray(titles) ? titles : [];
  const shardCollections = [];
  let currentShard = [];
  let currentShardBytes = 16;

  for (const title of normalizedTitles) {
    const normalizedTitle = String(title || '');
    const titleEntryBytes = Buffer.byteLength(JSON.stringify(normalizedTitle), 'utf8') + 2;
    const nextShardWouldOverflow = currentShard.length > 0 && (currentShardBytes + titleEntryBytes) > maxShardBytes;

    if (nextShardWouldOverflow) {
      shardCollections.push(currentShard);
      currentShard = [];
      currentShardBytes = 16;
    }

    currentShard.push(normalizedTitle);
    currentShardBytes += titleEntryBytes;
  }

  if (currentShard.length > 0 || shardCollections.length === 0) {
    shardCollections.push(currentShard);
  }

  const shardDigitWidth = Math.max(2, String(shardCollections.length).length);
  return shardCollections.map((shardTitles, index) => {
    const relativePath = buildShardRelativePath(outputPath, index + 1, shardDigitWidth);
    return {
      relativePath,
      absolutePath: path.resolve(process.cwd(), relativePath),
      titleCount: shardTitles.length,
      titles: shardTitles,
    };
  });
}

function buildShardManifest(outputPath, mergedDataset, shardDefinitions) {
  return {
    _comment: 'JSON은 일반 주석을 지원하지 않아서 안내를 _comment 필드로 남긴다.',
    _comment_update_rule: 'shard 구조라도 dataset 내용을 바꿨다면 version도 반드시 같이 올려야 한다.',
    _comment_scope: 'manifest는 작은 메타만 들고, 실제 제목은 shard 파일들에 나뉘어 저장된다.',
    version: mergedDataset.version,
    updatedAt: mergedDataset.updatedAt,
    sourceGalleryIds: mergedDataset.sourceGalleryIds,
    titleCount: mergedDataset.titles.length,
    shards: shardDefinitions.map((shard) => ({
      path: normalizeManifestPath(shard.relativePath),
      titleCount: shard.titleCount,
    })),
  };
}

function buildShardRelativePath(outputPath, shardNumber, digitWidth) {
  const parsedPath = path.parse(outputPath);
  return path.join(
    parsedPath.dir,
    `${parsedPath.name}.part${String(shardNumber).padStart(digitWidth, '0')}${parsedPath.ext || '.json'}`,
  );
}

async function findExistingShardPaths(outputPath) {
  const parsedPath = path.parse(outputPath);
  const directoryPath = parsedPath.dir || '.';
  const shardPrefix = `${parsedPath.name}.part`;
  const shardSuffix = parsedPath.ext || '.json';

  try {
    const fileNames = await fs.readdir(directoryPath);
    return fileNames
      .filter((fileName) => fileName.startsWith(shardPrefix) && fileName.endsWith(shardSuffix))
      .map((fileName) => path.resolve(process.cwd(), directoryPath, fileName));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
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

function normalizeMaxShardBytes(rawValue) {
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_MAX_SHARD_BYTES;
  }

  return Math.max(1, Math.trunc(parsedValue)) * 1024 * 1024;
}

function normalizeRelativeOutputPath(outputPath) {
  const relativePath = path.relative(process.cwd(), outputPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return path.basename(outputPath);
  }
  return relativePath;
}

function normalizeManifestPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

main().catch((error) => {
  console.error('[merge-reflux-datasets] 실패:', error.message);
  process.exitCode = 1;
});
