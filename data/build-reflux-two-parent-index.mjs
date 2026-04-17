#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';
import {
  extractRefluxRepresentativeChunksFromNormalizedCompareKey,
  hashRefluxStringToFnv1a64Hex,
} from '../features/reflux-normalization.js';

const DEFAULT_INPUT_PATH = 'data/reflux-title-set-unified.json';
const DEFAULT_OUTPUT_PATH = 'data/reflux-two-parent-index.json';
const DEFAULT_BUCKET_COUNT = 64;
const DEFAULT_DF_THRESHOLD = 400;
const DEFAULT_CHUNK_LENGTHS = Object.freeze([3, 4]);
const DEFAULT_POSTING_ENCODING = 'u32_delta_base64';
const OVERFLOW_SENTINEL = Symbol('overflow');

async function main() {
  const {
    inputPath,
    outputPath,
    bucketCount,
    dfThreshold,
    chunkLengths,
  } = parseCliArgs(process.argv.slice(2));
  const resolvedInputPath = path.resolve(process.cwd(), inputPath);
  const resolvedOutputPath = path.resolve(process.cwd(), outputPath);

  const inputManifest = normalizeInputDatasetManifest(await readJsonFile(resolvedInputPath), resolvedInputPath);
  const buildResult = await buildTwoParentIndex(inputManifest, resolvedInputPath, {
    bucketCount,
    dfThreshold,
    chunkLengths,
  });
  const writeSummary = await writeTwoParentIndexOutput(resolvedOutputPath, buildResult);

  console.log('[build-reflux-two-parent-index] 완료');
  console.log(`- 입력 manifest: ${resolvedInputPath}`);
  console.log(`- datasetVersion: ${buildResult.manifest.datasetVersion}`);
  console.log(`- titleCount: ${buildResult.manifest.titleCount}`);
  console.log(`- kept chunk 수: ${buildResult.keptChunkCount}`);
  console.log(`- overflow chunk 수: ${buildResult.overflowChunkCount}`);
  console.log(`- posting 수: ${buildResult.postingCount}`);
  console.log(`- bucket 수: ${buildResult.manifest.bucketCount}`);
  console.log(`- chunkLengths: ${buildResult.manifest.chunkLengths.join(',')}`);
  console.log(`- 출력 manifest: ${resolvedOutputPath}`);
  console.log(`- 출력 bucket 수: ${writeSummary.bucketCount}`);
}

function parseCliArgs(argv) {
  let inputPath = DEFAULT_INPUT_PATH;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let bucketCount = DEFAULT_BUCKET_COUNT;
  let dfThreshold = DEFAULT_DF_THRESHOLD;
  let chunkLengths = [...DEFAULT_CHUNK_LENGTHS];

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

    if (token === '--bucket-count') {
      bucketCount = normalizePositiveInteger(argv[index + 1], DEFAULT_BUCKET_COUNT);
      index += 1;
      continue;
    }

    if (token === '--df-threshold') {
      dfThreshold = normalizePositiveInteger(argv[index + 1], DEFAULT_DF_THRESHOLD);
      index += 1;
      continue;
    }

    if (token === '--chunk-lengths') {
      chunkLengths = normalizeChunkLengthsArg(argv[index + 1], DEFAULT_CHUNK_LENGTHS);
      index += 1;
      continue;
    }

    inputPath = token;
  }

  return {
    inputPath,
    outputPath,
    bucketCount,
    dfThreshold,
    chunkLengths,
  };
}

async function buildTwoParentIndex(inputManifest, inputManifestPath, options = {}) {
  const bucketCount = normalizePositiveInteger(options.bucketCount, DEFAULT_BUCKET_COUNT);
  const dfThreshold = normalizePositiveInteger(options.dfThreshold, DEFAULT_DF_THRESHOLD);
  const chunkLengths = normalizeChunkLengthsArg(options.chunkLengths, DEFAULT_CHUNK_LENGTHS);
  const postingMap = new Map();
  let titleId = 0;

  for (const shard of inputManifest.shards) {
    const shardPath = await resolveInputManifestChildPath(inputManifestPath, shard.path);
    const shardJson = await readJsonFile(shardPath);
    const shardTitles = Array.isArray(shardJson?.titles)
      ? shardJson.titles
      : Array.isArray(shardJson)
        ? shardJson
        : [];

    for (const rawTitle of shardTitles) {
      const normalizedTitle = normalizeSemiconductorRefluxTitle(rawTitle);
      if (!normalizedTitle) {
        titleId += 1;
        continue;
      }

      const representativeChunks = extractRefluxRepresentativeChunksFromNormalizedCompareKey(
        normalizedTitle,
        {
          chunkLengths,
          minChunkLength: 3,
          minLatinChunkLength: 4,
          minHangulChunkLength: 3,
          anchorMode: 'start_mid_end',
        },
      );

      for (const chunk of representativeChunks) {
        const currentValue = postingMap.get(chunk);
        if (currentValue === OVERFLOW_SENTINEL) {
          continue;
        }

        if (!currentValue) {
          postingMap.set(chunk, [titleId]);
          continue;
        }

        currentValue.push(titleId);
        if (currentValue.length > dfThreshold) {
          postingMap.set(chunk, OVERFLOW_SENTINEL);
        }
      }

      titleId += 1;
    }

    console.log(`[build-reflux-two-parent-index] shard 처리 완료: ${shard.path} (누적 titleId=${titleId})`);
  }

  const bucketMaps = Array.from({ length: bucketCount }, () => new Map());
  let keptChunkCount = 0;
  let overflowChunkCount = 0;
  let postingCount = 0;

  for (const [chunk, postings] of postingMap.entries()) {
    if (postings === OVERFLOW_SENTINEL) {
      overflowChunkCount += 1;
      continue;
    }

    if (!Array.isArray(postings) || postings.length <= 0) {
      continue;
    }

    const bucketIndex = getBucketIndexForChunk(chunk, bucketCount);
    bucketMaps[bucketIndex].set(chunk, {
      count: postings.length,
      encoding: DEFAULT_POSTING_ENCODING,
      data: packUint32DeltaArrayToBase64(postings),
    });
    keptChunkCount += 1;
    postingCount += postings.length;
  }

  return {
    manifest: {
      datasetVersion: inputManifest.version,
      titleCount: titleId,
      updatedAt: new Date().toISOString(),
      bucketCount,
      dfThreshold,
      chunkLengths: [...chunkLengths],
      anchorMode: 'start_mid_end',
      postingEncoding: DEFAULT_POSTING_ENCODING,
      paths: [],
    },
    buckets: bucketMaps,
    keptChunkCount,
    overflowChunkCount,
    postingCount,
  };
}

async function resolveInputManifestChildPath(inputManifestPath, childPath) {
  const normalizedChildPath = String(childPath || '').trim();
  if (!normalizedChildPath) {
    throw new Error('입력 manifest child path가 비어 있습니다.');
  }

  if (path.isAbsolute(normalizedChildPath)) {
    return normalizedChildPath;
  }

  const cwdRelativePath = path.resolve(process.cwd(), normalizedChildPath);
  if (await doesPathExist(cwdRelativePath)) {
    return cwdRelativePath;
  }

  const manifestRelativePath = path.resolve(path.dirname(inputManifestPath), normalizedChildPath);
  if (await doesPathExist(manifestRelativePath)) {
    return manifestRelativePath;
  }

  return cwdRelativePath;
}

async function writeTwoParentIndexOutput(outputPath, buildResult) {
  const relativeOutputPath = normalizeRelativeOutputPath(outputPath);
  const bucketDefinitions = buildBucketDefinitions(relativeOutputPath, buildResult.buckets);
  const staleBucketPaths = await findExistingBucketPaths(outputPath);
  const nextBucketPaths = new Set(bucketDefinitions.map((bucket) => bucket.absolutePath));

  for (const bucket of bucketDefinitions) {
    const rows = [...bucket.entries.entries()]
      .sort((left, right) => left[0].localeCompare(right[0], 'ko'))
      .map(([chunk, entry]) => [chunk, entry.data]);
    await fs.writeFile(
      bucket.absolutePath,
      `${JSON.stringify({
        encoding: DEFAULT_POSTING_ENCODING,
        rows,
      })}\n`,
      'utf8',
    );
  }

  for (const staleBucketPath of staleBucketPaths) {
    if (!nextBucketPaths.has(staleBucketPath)) {
      await fs.rm(staleBucketPath, { force: true });
    }
  }

  const manifest = {
    ...buildResult.manifest,
    paths: bucketDefinitions.map((bucket) => normalizeManifestPath(bucket.relativePath)),
  };
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  return {
    bucketCount: bucketDefinitions.length,
  };
}

function buildBucketDefinitions(outputPath, bucketMaps) {
  const normalizedBucketMaps = Array.isArray(bucketMaps) ? bucketMaps : [];
  const bucketDigitWidth = Math.max(2, String(normalizedBucketMaps.length - 1).length);
  return normalizedBucketMaps.map((entries, index) => {
    const relativePath = buildBucketRelativePath(outputPath, index, bucketDigitWidth);
    return {
      relativePath,
      absolutePath: path.resolve(process.cwd(), relativePath),
      entries,
    };
  });
}

function buildBucketRelativePath(outputPath, bucketIndex, digitWidth) {
  const parsedPath = path.parse(outputPath);
  return path.join(
    parsedPath.dir,
    `${parsedPath.name}.bucket${String(bucketIndex).padStart(digitWidth, '0')}${parsedPath.ext || '.json'}`,
  );
}

async function findExistingBucketPaths(outputPath) {
  const parsedPath = path.parse(outputPath);
  const directoryPath = parsedPath.dir || '.';
  const bucketPrefix = `${parsedPath.name}.bucket`;
  const bucketSuffix = parsedPath.ext || '.json';

  try {
    const fileNames = await fs.readdir(directoryPath);
    return fileNames
      .filter((fileName) => fileName.startsWith(bucketPrefix) && fileName.endsWith(bucketSuffix))
      .map((fileName) => path.resolve(process.cwd(), directoryPath, fileName));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function normalizeInputDatasetManifest(payload, inputPath) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`입력 dataset manifest 형식이 올바르지 않습니다. (${inputPath})`);
  }

  const shards = (Array.isArray(payload?.shards) ? payload.shards : [])
    .map((shard, index) => {
      const shardPath = String(shard?.path || '').trim();
      if (!shardPath) {
        throw new Error(`입력 dataset shard 경로가 비어 있습니다. (index=${index})`);
      }

      return {
        path: shardPath,
        titleCount: normalizePositiveInteger(shard?.titleCount, 0),
      };
    });
  if (shards.length <= 0) {
    throw new Error(`입력 dataset manifest에 shard가 없습니다. (${inputPath})`);
  }

  return {
    version: String(payload?.version || '').trim(),
    titleCount: normalizePositiveInteger(payload?.titleCount, 0),
    shards,
  };
}

function getBucketIndexForChunk(chunk, bucketCount) {
  const normalizedBucketCount = Math.max(1, Math.trunc(Number(bucketCount) || 0));
  const hashHex = hashRefluxStringToFnv1a64Hex(chunk);
  return Number(BigInt(`0x${hashHex}`) % BigInt(normalizedBucketCount));
}

function packUint32DeltaArrayToBase64(values) {
  const normalizedValues = (Array.isArray(values) ? values : [])
    .map((value) => Math.max(0, Math.trunc(Number(value) || 0)));
  const bytes = new Uint8Array(normalizedValues.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let previousValue = 0;

  for (let index = 0; index < normalizedValues.length; index += 1) {
    const currentValue = normalizedValues[index];
    const deltaValue = index === 0 ? currentValue : currentValue - previousValue;
    view.setUint32(index * 4, deltaValue, true);
    previousValue = currentValue;
  }

  return Buffer.from(bytes).toString('base64');
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`JSON 읽기 실패 (${filePath}): ${error.message}`);
  }
}

async function doesPathExist(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

function normalizePositiveInteger(value, fallback = 0) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return Math.max(0, Math.trunc(Number(fallback) || 0));
  }

  return Math.trunc(parsedValue);
}

function normalizeChunkLengthsArg(value, fallbackValue) {
  const normalizedValues = [...new Set(
    (Array.isArray(value) ? value : String(value || '').split(','))
      .map((token) => Math.trunc(Number(String(token || '').trim()) || 0))
      .filter((chunkLength) => chunkLength >= 2),
  )].sort((left, right) => left - right);
  return normalizedValues.length > 0
    ? normalizedValues
    : [...fallbackValue];
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
  console.error('[build-reflux-two-parent-index] 실패:', error.message);
  process.exitCode = 1;
});
