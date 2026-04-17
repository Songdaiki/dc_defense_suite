#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';
import {
  extractRefluxAllChunksFromNormalizedCompareKey,
} from '../features/reflux-normalization.js';

const METHODS = [
  {
    label: 'current',
    test: (f) => f.hasTwoParent,
  },
  {
    label: 'len24',
    test: (f) => f.hasTwoParent && f.len >= 24,
  },
  {
    label: 'len26',
    test: (f) => f.hasTwoParent && f.len >= 26,
  },
  {
    label: 'bestSum5',
    test: (f) => f.hasTwoParent && f.bestSum >= 5,
  },
  {
    label: 'streak3',
    test: (f) => f.hasTwoParent && f.maxAdjacentSamePairStreak >= 3,
  },
  {
    label: 'len22_bestSum5',
    test: (f) => f.hasTwoParent && f.len >= 22 && f.bestSum >= 5,
  },
  {
    label: 'len22_streak3',
    test: (f) => f.hasTwoParent && f.len >= 22 && f.maxAdjacentSamePairStreak >= 3,
  },
  {
    label: 'len24_bestSum5',
    test: (f) => f.hasTwoParent && f.len >= 24 && f.bestSum >= 5,
  },
  {
    label: 'len24_bestSum5_streak2',
    test: (f) => f.hasTwoParent && f.len >= 24 && f.bestSum >= 5 && f.maxAdjacentSamePairStreak >= 2,
  },
  {
    label: 'len24_bestSum6',
    test: (f) => f.hasTwoParent && f.len >= 24 && f.bestSum >= 6,
  },
  {
    label: 'len24_bestSum5_pairFreq3',
    test: (f) => f.hasTwoParent && f.len >= 24 && f.bestSum >= 5 && f.maxPairFrequency >= 3,
  },
  {
    label: 'len26_bestSum5',
    test: (f) => f.hasTwoParent && f.len >= 26 && f.bestSum >= 5,
  },
  {
    label: 'len26_bestSum5_streak2',
    test: (f) => f.hasTwoParent && f.len >= 26 && f.bestSum >= 5 && f.maxAdjacentSamePairStreak >= 2,
  },
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

  const positiveFeatures = positiveTitles.map((title) => buildTitleFeatures(title, titleSetModule, indexState));
  const negativeFeatures = negativeTitles.map((title) => buildTitleFeatures(title, titleSetModule, indexState));

  const rows = METHODS.map((method) => {
    const positiveTwoParentCount = positiveFeatures.filter((feature) => method.test(feature)).length;
    const negativeTwoParentCount = negativeFeatures.filter((feature) => method.test(feature)).length;
    const positiveFullLocalCount = positiveFeatures.filter((feature) => feature.singleHit || method.test(feature)).length;
    const negativeFullLocalCount = negativeFeatures.filter((feature) => feature.singleHit || method.test(feature)).length;

    return {
      label: method.label,
      positiveTwoParentCount,
      positiveTwoParentRecall: toPercent(positiveTwoParentCount, positiveFeatures.length),
      negativeTwoParentCount,
      negativeTwoParentHitRate: toPercent(negativeTwoParentCount, negativeFeatures.length),
      positiveFullLocalCount,
      positiveFullLocalRecall: toPercent(positiveFullLocalCount, positiveFeatures.length),
      negativeFullLocalCount,
      negativeFullLocalHitRate: toPercent(negativeFullLocalCount, negativeFeatures.length),
      gap: Number((toPercent(positiveFullLocalCount, positiveFeatures.length) - toPercent(negativeFullLocalCount, negativeFeatures.length)).toFixed(2)),
    };
  }).sort((left, right) => {
    if (right.gap !== left.gap) {
      return right.gap - left.gap;
    }
    if (right.positiveFullLocalRecall !== left.positiveFullLocalRecall) {
      return right.positiveFullLocalRecall - left.positiveFullLocalRecall;
    }
    return left.negativeFullLocalHitRate - right.negativeFullLocalHitRate;
  });

  console.log(JSON.stringify({
    positiveTotal: positiveFeatures.length,
    negativeTotal: negativeFeatures.length,
    rows,
  }, null, 2));
}

function buildTitleFeatures(title, titleSetModule, indexState) {
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  const chars = Array.from(normalizedTitle);
  const singleHit = titleSetModule.hasSemiconductorRefluxTitle(title);
  if (chars.length < 10) {
    return {
      title,
      len: chars.length,
      singleHit,
      hasTwoParent: false,
      acceptedCount: 0,
      distinctPairCount: 0,
      maxPairFrequency: 0,
      maxAdjacentSamePairStreak: 0,
      bestSum: 0,
      bestMinTop: 0,
      bestBalance: 0,
    };
  }

  const accepted = [];
  for (let splitIndex = 4; splitIndex <= chars.length - 4; splitIndex += 1) {
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
    const rightChunks = extractRefluxAllChunksFromNormalizedCompareKey(
      rightValue,
      {
        chunkLengths: indexState.twoParentChunkLengths,
        minChunkLength: 3,
        minLatinChunkLength: 4,
        minHangulChunkLength: 3,
      },
    );
    if (leftChunks.length < 2 || rightChunks.length < 2) {
      continue;
    }

    const leftCounts = countCandidateHits(leftChunks, indexState.chunkPostingMap);
    const rightCounts = countCandidateHits(rightChunks, indexState.chunkPostingMap);
    const leftTop = selectTopCandidates(leftCounts);
    const rightTop = selectTopCandidates(rightCounts);
    if (leftTop.length <= 0 || rightTop.length <= 0) {
      continue;
    }

    if (hasSingleParentDominatingBothSides(leftCounts, rightCounts)) {
      continue;
    }

    let acceptedRow = null;
    for (const [leftParentId, leftCount] of leftTop) {
      for (const [rightParentId, rightCount] of rightTop) {
        if (leftParentId === rightParentId) {
          continue;
        }

        if ((rightCounts.get(leftParentId) || 0) > 1) {
          continue;
        }

        if ((leftCounts.get(rightParentId) || 0) > 1) {
          continue;
        }

        acceptedRow = {
          splitIndex,
          leftParentId,
          rightParentId,
          leftCount,
          rightCount,
          sum: leftCount + rightCount,
          minTop: Math.min(leftCount, rightCount),
          balance: Math.min(splitIndex, chars.length - splitIndex) / chars.length,
        };
        break;
      }
      if (acceptedRow) {
        break;
      }
    }

    if (acceptedRow) {
      accepted.push(acceptedRow);
    }
  }

  if (accepted.length <= 0) {
    return {
      title,
      len: chars.length,
      singleHit,
      hasTwoParent: false,
      acceptedCount: 0,
      distinctPairCount: 0,
      maxPairFrequency: 0,
      maxAdjacentSamePairStreak: 0,
      bestSum: 0,
      bestMinTop: 0,
      bestBalance: 0,
    };
  }

  const pairCounts = new Map();
  for (const row of accepted) {
    const key = `${row.leftParentId}:${row.rightParentId}`;
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  }

  let best = accepted[0];
  for (const row of accepted) {
    if (row.sum > best.sum || (row.sum === best.sum && row.minTop > best.minTop)) {
      best = row;
    }
  }

  let maxAdjacentSamePairStreak = 1;
  let currentStreak = 1;
  for (let index = 1; index < accepted.length; index += 1) {
    const previousRow = accepted[index - 1];
    const currentRow = accepted[index];
    if (
      currentRow.splitIndex === previousRow.splitIndex + 1
      && currentRow.leftParentId === previousRow.leftParentId
      && currentRow.rightParentId === previousRow.rightParentId
    ) {
      currentStreak += 1;
      if (currentStreak > maxAdjacentSamePairStreak) {
        maxAdjacentSamePairStreak = currentStreak;
      }
    } else {
      currentStreak = 1;
    }
  }

  return {
    title,
    len: chars.length,
    singleHit,
    hasTwoParent: true,
    acceptedCount: accepted.length,
    distinctPairCount: pairCounts.size,
    maxPairFrequency: Math.max(...pairCounts.values()),
    maxAdjacentSamePairStreak,
    bestSum: best.sum,
    bestMinTop: best.minTop,
    bestBalance: Number(best.balance.toFixed(3)),
  };
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

function selectTopCandidates(candidateCounts) {
  return [...candidateCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0] - right[0];
    })
    .slice(0, 40);
}

function hasSingleParentDominatingBothSides(leftCounts, rightCounts) {
  for (const [parentId, leftCount] of leftCounts.entries()) {
    if (leftCount < 2) {
      continue;
    }

    if ((rightCounts.get(parentId) || 0) >= 2) {
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
  console.error('[compare-reflux-two-parent-methods] 실패:', error.message);
  process.exitCode = 1;
});
