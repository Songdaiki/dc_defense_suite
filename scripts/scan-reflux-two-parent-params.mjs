#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';
import {
  extractRefluxAllChunksFromNormalizedCompareKey,
} from '../features/reflux-normalization.js';

const DEFAULT_INDEX_MANIFEST_PATH = 'data/reflux-two-parent-index.json';
const DEFAULT_POSITIVE_PATH = 'docs/실제공격.md';
const DEFAULT_NEGATIVE_PATH = 'docs/가짜공격.md';

async function main() {
  const repoRoot = process.cwd();
  const indexManifestPath = path.resolve(repoRoot, process.argv[2] || DEFAULT_INDEX_MANIFEST_PATH);
  const positivePath = path.resolve(repoRoot, process.argv[3] || DEFAULT_POSITIVE_PATH);
  const negativePath = path.resolve(repoRoot, process.argv[4] || DEFAULT_NEGATIVE_PATH);

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  };

  const titleSetModule = await import('../features/post/semiconductor-reflux-title-set.js');
  const datasetTitles = loadDatasetTitles(repoRoot);
  await titleSetModule.replaceSemiconductorRefluxTitleSet(datasetTitles.titles, {
    version: datasetTitles.version,
    updatedAt: datasetTitles.updatedAt,
    sourceType: 'manual',
    sourceGalleryIds: datasetTitles.sourceGalleryIds,
  });

  const indexState = loadIndexState(indexManifestPath);
  const positiveTitles = readTitleLines(positivePath);
  const negativeTitles = readTitleLines(negativePath);
  const parameterRows = buildParameterRows();
  const results = [];

  for (const params of parameterRows) {
    const positiveHitCount = countHits(positiveTitles, indexState, params);
    const negativeHitCount = countHits(negativeTitles, indexState, params);
    const positiveFullLocalHitCount = countFullLocalHits(positiveTitles, titleSetModule, indexState, params);
    const negativeFullLocalHitCount = countFullLocalHits(negativeTitles, titleSetModule, indexState, params);
    results.push({
      ...params,
      positiveHitCount,
      positiveRecall: toPercent(positiveHitCount, positiveTitles.length),
      negativeHitCount,
      negativeHitRate: toPercent(negativeHitCount, negativeTitles.length),
      positiveFullLocalHitCount,
      positiveFullLocalRecall: toPercent(positiveFullLocalHitCount, positiveTitles.length),
      negativeFullLocalHitCount,
      negativeFullLocalHitRate: toPercent(negativeFullLocalHitCount, negativeTitles.length),
      gap: Number((toPercent(positiveHitCount, positiveTitles.length) - toPercent(negativeHitCount, negativeTitles.length)).toFixed(2)),
    });
  }

  results.sort((left, right) => {
    if (right.gap !== left.gap) {
      return right.gap - left.gap;
    }
    if (right.positiveRecall !== left.positiveRecall) {
      return right.positiveRecall - left.positiveRecall;
    }
    return left.negativeHitRate - right.negativeHitRate;
  });

  console.log(JSON.stringify({
    positiveTotal: positiveTitles.length,
    negativeTotal: negativeTitles.length,
    topByGap: results.slice(0, 20),
    topByLowestNegative: [...results]
      .sort((left, right) => {
        if (left.negativeHitRate !== right.negativeHitRate) {
          return left.negativeHitRate - right.negativeHitRate;
        }
        if (right.positiveRecall !== left.positiveRecall) {
          return right.positiveRecall - left.positiveRecall;
        }
        return right.gap - left.gap;
      })
      .slice(0, 20),
    topByMinSideMatch3OrMore: results
      .filter((row) => row.minSideMatchCount >= 3)
      .slice(0, 20),
    candidateFullLocal: results.filter((row) => (
      row.minSideLength === 5
      && row.minSideMatchCount === 2
      && [22, 24, 26, 28].includes(row.minTitleLength)
    )),
  }, null, 2));
}

function buildParameterRows() {
  const rows = [];
  const minTitleLengths = [10, 14, 18, 22, 24, 26, 28, 30];
  const minSideLengths = [4, 5, 6, 7, 8, 9, 10];
  const minSideMatchCounts = [2, 3, 4];

  for (const minTitleLength of minTitleLengths) {
    for (const minSideLength of minSideLengths) {
      for (const minSideMatchCount of minSideMatchCounts) {
        rows.push({
          minTitleLength,
          minSideLength,
          minSideMatchCount,
        });
      }
    }
  }

  return rows;
}

function countHits(titles, indexState, params) {
  let hitCount = 0;
  for (const title of titles) {
    if (hasTwoParentMixTitle(title, indexState, params)) {
      hitCount += 1;
    }
  }
  return hitCount;
}

function countFullLocalHits(titles, titleSetModule, indexState, params) {
  let hitCount = 0;
  for (const title of titles) {
    if (
      titleSetModule.hasSemiconductorRefluxTitle(title)
      || hasTwoParentMixTitle(title, indexState, params)
    ) {
      hitCount += 1;
    }
  }
  return hitCount;
}

function hasTwoParentMixTitle(title, indexState, params) {
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  const chars = Array.from(normalizedTitle);
  if (chars.length < params.minTitleLength) {
    return false;
  }

  const minSideLength = params.minSideLength;
  for (let splitIndex = minSideLength; splitIndex <= chars.length - minSideLength; splitIndex += 1) {
    const leftValue = chars.slice(0, splitIndex).join('');
    const rightValue = chars.slice(splitIndex).join('');
    const leftChunks = extractRefluxAllChunksFromNormalizedCompareKey(
      leftValue,
      {
        chunkLengths: indexState.twoParentChunkLengths,
        minChunkLength: 3,
        minLatinChunkLength: 4,
        minHangulChunkLength: 3,
      },
    );
    if (leftChunks.length < params.minSideMatchCount) {
      continue;
    }

    const rightChunks = extractRefluxAllChunksFromNormalizedCompareKey(
      rightValue,
      {
        chunkLengths: indexState.twoParentChunkLengths,
        minChunkLength: 3,
        minLatinChunkLength: 4,
        minHangulChunkLength: 3,
      },
    );
    if (rightChunks.length < params.minSideMatchCount) {
      continue;
    }

    const leftCounts = countCandidateHits(leftChunks, indexState.chunkPostingMap);
    const rightCounts = countCandidateHits(rightChunks, indexState.chunkPostingMap);
    const leftTop = selectTopCandidates(leftCounts, params.minSideMatchCount);
    const rightTop = selectTopCandidates(rightCounts, params.minSideMatchCount);

    if (leftTop.length <= 0 || rightTop.length <= 0) {
      continue;
    }

    if (hasSingleParentDominatingBothSides(leftCounts, rightCounts, params.minSideMatchCount)) {
      continue;
    }

    for (const [leftParentId, leftCount] of leftTop) {
      if (leftCount < params.minSideMatchCount) {
        continue;
      }

      for (const [rightParentId, rightCount] of rightTop) {
        if (rightCount < params.minSideMatchCount) {
          continue;
        }

        if (leftParentId === rightParentId) {
          continue;
        }

        if ((rightCounts.get(leftParentId) || 0) > 1) {
          continue;
        }

        if ((leftCounts.get(rightParentId) || 0) > 1) {
          continue;
        }

        return true;
      }
    }
  }

  return false;
}

function hasSingleParentDominatingBothSides(leftCounts, rightCounts, minSideMatchCount) {
  for (const [parentId, leftCount] of leftCounts.entries()) {
    if (leftCount < minSideMatchCount) {
      continue;
    }

    if ((rightCounts.get(parentId) || 0) >= minSideMatchCount) {
      return true;
    }
  }

  return false;
}

function countCandidateHits(chunks, chunkPostingMap) {
  const candidateCounts = new Map();

  for (const chunk of chunks) {
    const postings = chunkPostingMap.get(chunk);
    if (!postings || postings.length <= 0) {
      continue;
    }

    for (let index = 0; index < postings.length; index += 1) {
      const titleId = postings[index];
      candidateCounts.set(titleId, (candidateCounts.get(titleId) || 0) + 1);
    }
  }

  return candidateCounts;
}

function selectTopCandidates(candidateCounts, minSideMatchCount) {
  return [...candidateCounts.entries()]
    .filter(([, count]) => count >= minSideMatchCount)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0] - right[0];
    })
    .slice(0, 40);
}

function loadIndexState(indexManifestPath) {
  const manifest = JSON.parse(fs.readFileSync(indexManifestPath, 'utf8'));
  const chunkPostingMap = new Map();

  for (const bucketPath of Array.isArray(manifest.paths) ? manifest.paths : []) {
    const bucketJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), bucketPath), 'utf8'));
    for (const row of bucketJson.rows || []) {
      const chunk = String(row[0] || '').trim();
      const bytes = Uint8Array.from(Buffer.from(String(row[1] || '').trim(), 'base64'));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const postings = new Uint32Array(bytes.byteLength / 4);
      let runningValue = 0;

      for (let index = 0; index < postings.length; index += 1) {
        runningValue += view.getUint32(index * 4, true);
        postings[index] = runningValue;
      }

      chunkPostingMap.set(chunk, postings);
    }
  }

  return {
    twoParentChunkLengths: Array.isArray(manifest.chunkLengths) ? manifest.chunkLengths : [3, 4],
    chunkPostingMap,
  };
}

function loadDatasetTitles(repoRoot) {
  const datasetManifestPath = path.resolve(repoRoot, 'data/reflux-title-set-unified.json');
  const manifest = JSON.parse(fs.readFileSync(datasetManifestPath, 'utf8'));
  const titles = [];

  for (const shard of Array.isArray(manifest.shards) ? manifest.shards : []) {
    const shardJson = JSON.parse(fs.readFileSync(path.resolve(repoRoot, shard.path), 'utf8'));
    const shardTitles = Array.isArray(shardJson?.titles)
      ? shardJson.titles
      : Array.isArray(shardJson)
        ? shardJson
        : [];
    for (const title of shardTitles) {
      titles.push(title);
    }
  }

  return {
    titles,
    version: String(manifest.version || '').trim(),
    updatedAt: String(manifest.updatedAt || '').trim(),
    sourceGalleryIds: Array.isArray(manifest.sourceGalleryIds) ? manifest.sourceGalleryIds : [],
  };
}

function readTitleLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => String(line || '').trim())
    .filter(Boolean);
}

function toPercent(value, total) {
  return total > 0 ? Number(((value / total) * 100).toFixed(2)) : 0;
}

main().catch((error) => {
  console.error('[scan-reflux-two-parent-params] 실패:', error.message);
  process.exitCode = 1;
});
