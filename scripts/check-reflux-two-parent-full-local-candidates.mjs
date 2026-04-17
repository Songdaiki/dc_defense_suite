#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';
import {
  extractRefluxAllChunksFromNormalizedCompareKey,
} from '../features/reflux-normalization.js';

const CANDIDATES = [
  { minTitleLength: 10, minSideLength: 4, minSideMatchCount: 2, requireFourCharHitPerSide: false, label: 'current' },
  { minTitleLength: 22, minSideLength: 5, minSideMatchCount: 2, requireFourCharHitPerSide: false, label: 'len22' },
  { minTitleLength: 24, minSideLength: 5, minSideMatchCount: 2, requireFourCharHitPerSide: false, label: 'len24' },
  { minTitleLength: 24, minSideLength: 5, minSideMatchCount: 2, requireFourCharHitPerSide: true, label: 'len24_4gram' },
  { minTitleLength: 26, minSideLength: 5, minSideMatchCount: 2, requireFourCharHitPerSide: false, label: 'len26' },
  { minTitleLength: 26, minSideLength: 5, minSideMatchCount: 2, requireFourCharHitPerSide: true, label: 'len26_4gram' },
  { minTitleLength: 28, minSideLength: 5, minSideMatchCount: 2, requireFourCharHitPerSide: false, label: 'len28' },
  { minTitleLength: 28, minSideLength: 5, minSideMatchCount: 2, requireFourCharHitPerSide: true, label: 'len28_4gram' },
];

async function main() {
  const repoRoot = process.cwd();
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  };

  const titleSetModule = await import('../features/post/semiconductor-reflux-title-set.js');
  const dataset = loadDatasetTitles(repoRoot);
  await titleSetModule.replaceSemiconductorRefluxTitleSet(dataset.titles, {
    version: dataset.version,
    updatedAt: dataset.updatedAt,
    sourceType: 'manual',
    sourceGalleryIds: dataset.sourceGalleryIds,
  });

  const indexState = loadIndexState(path.resolve(repoRoot, 'data/reflux-two-parent-index.json'));
  const positiveTitles = readTitleLines(path.resolve(repoRoot, 'docs/실제공격.md'));
  const negativeTitles = readTitleLines(path.resolve(repoRoot, 'docs/가짜공격.md'));
  const rows = [];

  for (const params of CANDIDATES) {
    rows.push({
      ...params,
      positiveTwoParent: countHits(positiveTitles, indexState, params),
      negativeTwoParent: countHits(negativeTitles, indexState, params),
      positiveFullLocal: countFullLocalHits(positiveTitles, titleSetModule, indexState, params),
      negativeFullLocal: countFullLocalHits(negativeTitles, titleSetModule, indexState, params),
    });
  }

  console.log(JSON.stringify({
    positiveTotal: positiveTitles.length,
    negativeTotal: negativeTitles.length,
    rows: rows.map((row) => ({
      ...row,
      positiveTwoParentRecall: toPercent(row.positiveTwoParent, positiveTitles.length),
      negativeTwoParentHitRate: toPercent(row.negativeTwoParent, negativeTitles.length),
      positiveFullLocalRecall: toPercent(row.positiveFullLocal, positiveTitles.length),
      negativeFullLocalHitRate: toPercent(row.negativeFullLocal, negativeTitles.length),
    })),
  }, null, 2));
}

function countFullLocalHits(titles, titleSetModule, indexState, params) {
  let hitCount = 0;
  for (const title of titles) {
    if (titleSetModule.hasSemiconductorRefluxTitle(title) || hasTwoParentMixTitle(title, indexState, params)) {
      hitCount += 1;
    }
  }
  return hitCount;
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

function hasTwoParentMixTitle(title, indexState, params) {
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  const chars = Array.from(normalizedTitle);
  if (chars.length < params.minTitleLength) {
    return false;
  }

  for (let splitIndex = params.minSideLength; splitIndex <= chars.length - params.minSideLength; splitIndex += 1) {
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

    const leftHitState = countCandidateHits(leftChunks, indexState.chunkPostingMap);
    const rightHitState = countCandidateHits(rightChunks, indexState.chunkPostingMap);
    const leftCounts = leftHitState.counts;
    const rightCounts = rightHitState.counts;
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

        if (
          params.requireFourCharHitPerSide
          && (
            (leftHitState.fourCharCounts.get(leftParentId) || 0) <= 0
            || (rightHitState.fourCharCounts.get(rightParentId) || 0) <= 0
          )
        ) {
          continue;
        }

        return true;
      }
    }
  }

  return false;
}

function countCandidateHits(chunks, chunkPostingMap) {
  const candidateCounts = new Map();
  const fourCharCounts = new Map();

  for (const chunk of chunks) {
    const postings = chunkPostingMap.get(chunk);
    if (!postings || postings.length <= 0) {
      continue;
    }

    const chunkLength = Array.from(String(chunk || '')).length;

    for (let index = 0; index < postings.length; index += 1) {
      const titleId = postings[index];
      candidateCounts.set(titleId, (candidateCounts.get(titleId) || 0) + 1);
      if (chunkLength >= 4) {
        fourCharCounts.set(titleId, (fourCharCounts.get(titleId) || 0) + 1);
      }
    }
  }

  return {
    counts: candidateCounts,
    fourCharCounts,
  };
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

function loadIndexState(indexManifestPath) {
  const manifest = JSON.parse(fs.readFileSync(indexManifestPath, 'utf8'));
  const chunkPostingMap = new Map();

  for (const bucketPath of manifest.paths || []) {
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
  const manifest = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'data/reflux-title-set-unified.json'), 'utf8'));
  const titles = [];

  for (const shard of manifest.shards || []) {
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
  console.error('[check-reflux-two-parent-full-local-candidates] 실패:', error.message);
  process.exitCode = 1;
});
