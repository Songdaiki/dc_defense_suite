#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeCommentRefluxMemo } from '../features/comment/parser.js';

const DEFAULT_OUTPUT_PATH = 'data/comment-reflux-set-unified.json';
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

  console.log('[merge-comment-reflux-datasets] 완료');
  console.log(`- 입력 파일 수: ${inputPaths.length}`);
  console.log(`- sourceGalleryIds: ${mergedDataset.sourceGalleryIds.join(', ') || '(없음)'}`);
  console.log(`- 고유 댓글 수: ${mergedDataset.memos.length}`);
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
  console.log('  node data/merge-comment-reflux-datasets.mjs <input1.json> <input2.json> [...inputN.json] [--out <output.json>] [--version <version>] [--max-shard-mb <mb>]');
  console.log('');
  console.log('예시:');
  console.log('  node data/merge-comment-reflux-datasets.mjs ./data/past/comment-reflux-source-tsmcsamsungskhynix-2026-04-08-214042.json');
  console.log('  node data/merge-comment-reflux-datasets.mjs ./a.json ./b.json --version 2026-04-08-230000');
}

async function buildMergedDataset(inputPaths, version) {
  const normalizedMemoSet = new Set();
  const sourceGalleryIdSet = new Set();

  for (const rawInputPath of inputPaths) {
    const resolvedInputPath = path.resolve(process.cwd(), rawInputPath);
    const inputJson = await readJsonFile(resolvedInputPath);
    const dataset = await normalizeInputDataset(inputJson, resolvedInputPath);

    for (const sourceGalleryId of dataset.sourceGalleryIds) {
      sourceGalleryIdSet.add(sourceGalleryId);
    }

    for (const memo of dataset.memos) {
      normalizedMemoSet.add(memo);
    }
  }

  return {
    _comment: '실제 댓글 본문은 shard 파일들에 나뉘어 저장된다. 댓글 dataset을 수정했다면 version도 반드시 같이 올려야 한다.',
    _comment_update_rule: 'memos를 수정했다면 version도 반드시 같이 올려야 한다. version이 그대로면 기존 관리자 local cache가 유지될 수 있다.',
    _comment_scope: '이 dataset은 반도체산업갤 댓글만이 아니라 여러 갤 source를 합친 통합 역류기 댓글 dataset으로 써도 된다.',
    version,
    updatedAt: new Date().toISOString(),
    sourceGalleryIds: [...sourceGalleryIdSet].sort((left, right) => left.localeCompare(right)),
    memos: [...normalizedMemoSet].sort((left, right) => left.localeCompare(right, 'ko')),
  };
}

async function normalizeInputDataset(payload, inputPath) {
  if (Array.isArray(payload)) {
    return {
      sourceGalleryIds: [],
      memos: dedupeNormalizedMemos(payload),
    };
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`지원하지 않는 dataset 형식 (${inputPath})`);
  }

  if (Array.isArray(payload.memos)) {
    return {
      sourceGalleryIds: normalizeSourceGalleryIds(payload),
      memos: dedupeNormalizedMemos(payload.memos),
    };
  }

  const manifest = normalizeInputManifest(payload, inputPath);
  const memos = await loadInputShardMemos(manifest.shards, inputPath);
  return {
    sourceGalleryIds: manifest.sourceGalleryIds,
    memos,
  };
}

function normalizeInputManifest(payload, inputPath) {
  return {
    sourceGalleryIds: normalizeSourceGalleryIds(payload),
    shards: Array.isArray(payload.shards)
      ? payload.shards
        .map((entry) => ({
          path: String(entry?.path || '').trim(),
          memoCount: normalizeMemoCount(entry?.memoCount),
        }))
        .filter((entry) => entry.path)
      : [],
    inputPath,
  };
}

async function loadInputShardMemos(shards, manifestPath) {
  const normalizedMemos = [];

  for (const shard of Array.isArray(shards) ? shards : []) {
    const shardPath = await resolveInputShardPath(manifestPath, String(shard?.path || '').trim());
    const shardJson = await readJsonFile(shardPath);
    const shardMemos = Array.isArray(shardJson?.memos) ? shardJson.memos : [];

    for (const memo of shardMemos) {
      const normalizedMemo = normalizeCommentRefluxMemo(memo);
      if (!normalizedMemo) {
        continue;
      }
      normalizedMemos.push(normalizedMemo);
    }
  }

  return dedupePreNormalizedMemos(normalizedMemos);
}

async function resolveInputShardPath(manifestPath, shardPath) {
  if (!shardPath) {
    throw new Error(`shard path가 비어 있습니다. (${manifestPath})`);
  }

  if (path.isAbsolute(shardPath)) {
    return shardPath;
  }

  const manifestDirPath = path.dirname(manifestPath);
  const manifestRelativePath = path.resolve(manifestDirPath, shardPath);
  if (await pathExists(manifestRelativePath)) {
    return manifestRelativePath;
  }

  const cwdRelativePath = path.resolve(process.cwd(), shardPath);
  if (await pathExists(cwdRelativePath)) {
    return cwdRelativePath;
  }

  throw new Error(`shard 파일을 찾지 못했습니다. (${shardPath})`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeMergedDatasetOutput(outputPath, mergedDataset, maxShardBytes) {
  const relativeOutputPath = normalizeRelativeOutputPath(outputPath);
  const shardDefinitions = buildMemoShards(relativeOutputPath, mergedDataset.memos, maxShardBytes);
  const manifest = buildShardManifest(mergedDataset, shardDefinitions);
  const staleShardPaths = await findExistingShardPaths(outputPath);
  const nextShardPaths = new Set(shardDefinitions.map((shard) => shard.absolutePath));

  for (const shard of shardDefinitions) {
    await fs.writeFile(
      shard.absolutePath,
      `${JSON.stringify({ memos: shard.memos }, null, 2)}\n`,
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

function buildMemoShards(outputPath, memos, maxShardBytes) {
  const normalizedMemos = Array.isArray(memos) ? memos : [];
  const shardCollections = [];
  let currentShard = [];
  let currentShardBytes = 16;

  for (const memo of normalizedMemos) {
    const normalizedMemo = String(memo || '');
    const memoEntryBytes = Buffer.byteLength(JSON.stringify(normalizedMemo), 'utf8') + 2;
    const nextShardWouldOverflow = currentShard.length > 0 && (currentShardBytes + memoEntryBytes) > maxShardBytes;

    if (nextShardWouldOverflow) {
      shardCollections.push(currentShard);
      currentShard = [];
      currentShardBytes = 16;
    }

    currentShard.push(normalizedMemo);
    currentShardBytes += memoEntryBytes;
  }

  if (currentShard.length > 0 || shardCollections.length === 0) {
    shardCollections.push(currentShard);
  }

  const shardDigitWidth = Math.max(2, String(shardCollections.length).length);
  return shardCollections.map((shardMemos, index) => {
    const relativePath = buildShardRelativePath(outputPath, index + 1, shardDigitWidth);
    return {
      relativePath,
      absolutePath: path.resolve(process.cwd(), relativePath),
      memoCount: shardMemos.length,
      memos: shardMemos,
    };
  });
}

function buildShardManifest(mergedDataset, shardDefinitions) {
  return {
    _comment: '실제 댓글 본문은 shard 파일들에 나뉘어 저장된다. 댓글 dataset을 수정했다면 version도 반드시 같이 올려야 한다.',
    _comment_update_rule: 'shard 구조라도 dataset 내용을 바꿨다면 version도 반드시 같이 올려야 한다.',
    _comment_scope: 'manifest는 작은 메타만 들고, 실제 댓글은 shard 파일들에 나뉘어 저장된다.',
    version: mergedDataset.version,
    updatedAt: mergedDataset.updatedAt,
    sourceGalleryIds: mergedDataset.sourceGalleryIds,
    memoCount: mergedDataset.memos.length,
    shards: shardDefinitions.map((shard) => ({
      path: normalizeManifestPath(shard.relativePath),
      memoCount: shard.memoCount,
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

function dedupeNormalizedMemos(memos) {
  return [...new Set(
    (Array.isArray(memos) ? memos : [])
      .map((memo) => normalizeCommentRefluxMemo(memo))
      .filter(Boolean),
  )];
}

function dedupePreNormalizedMemos(memos) {
  return [...new Set(
    (Array.isArray(memos) ? memos : [])
      .map((memo) => String(memo || '').trim())
      .filter(Boolean),
  )];
}

function normalizeMemoCount(value) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 0;
  }

  return Math.trunc(parsedValue);
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
  console.error('[merge-comment-reflux-datasets] 실패:', error.message);
  process.exitCode = 1;
});
