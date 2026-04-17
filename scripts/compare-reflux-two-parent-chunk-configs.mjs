#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';
import {
  extractRefluxAllChunksFromNormalizedCompareKey,
} from '../features/reflux-normalization.js';

const DEFAULT_CHUNK_CONFIGS = [
  { label: '3', chunkLengths: [3] },
  { label: '3_4', chunkLengths: [3, 4] },
  { label: '4', chunkLengths: [4] },
];

const LEN_GATES = [10, 18, 20, 22, 24, 26, 28, 30];
const TWO_PARENT_MIN_TITLE_LENGTH = 10;
const TWO_PARENT_MIN_SIDE_LENGTH = 4;
const TWO_PARENT_MIN_SIDE_MATCH_COUNT = 2;
const TWO_PARENT_MAX_CANDIDATES_PER_SIDE = 40;
const TWO_PARENT_MAX_OPPOSITE_LEAK_COUNT = 1;

async function main() {
  const repoRoot = process.cwd();
  const {
    indexPath,
    chunkConfigs,
  } = parseCliArgs(process.argv.slice(2));
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

  const indexState = loadIndexState(path.resolve(repoRoot, indexPath));
  const positiveTitles = readTitleLines(path.resolve(repoRoot, 'docs/실제공격.md'));
  const negativeTitles = readTitleLines(path.resolve(repoRoot, 'docs/가짜공격.md'));
  const positiveBase = positiveTitles.map((title) => buildBaseFeature(title, titleSetModule));
  const negativeBase = negativeTitles.map((title) => buildBaseFeature(title, titleSetModule));

  const rows = [];
  for (const chunkConfig of chunkConfigs) {
    const positiveEvaluated = positiveBase.map((feature) => ({
      ...feature,
      twoParentHit: hasTwoParentMixTitle(feature.normalizedTitle, indexState.chunkPostingMap, chunkConfig.chunkLengths),
    }));
    const negativeEvaluated = negativeBase.map((feature) => ({
      ...feature,
      twoParentHit: hasTwoParentMixTitle(feature.normalizedTitle, indexState.chunkPostingMap, chunkConfig.chunkLengths),
    }));

    for (const minTitleLength of LEN_GATES) {
      const positiveTwoParentCount = countTwoParentHits(positiveEvaluated, minTitleLength);
      const negativeTwoParentCount = countTwoParentHits(negativeEvaluated, minTitleLength);
      const positiveFullLocalCount = countFullLocalHits(positiveEvaluated, minTitleLength);
      const negativeFullLocalCount = countFullLocalHits(negativeEvaluated, minTitleLength);
      const positiveFullLocalRecall = toPercent(positiveFullLocalCount, positiveEvaluated.length);
      const negativeFullLocalHitRate = toPercent(negativeFullLocalCount, negativeEvaluated.length);

      rows.push({
        chunkLabel: chunkConfig.label,
        chunkLengths: [...chunkConfig.chunkLengths],
        minTitleLength,
        positiveTwoParentCount,
        positiveTwoParentRecall: toPercent(positiveTwoParentCount, positiveEvaluated.length),
        negativeTwoParentCount,
        negativeTwoParentHitRate: toPercent(negativeTwoParentCount, negativeEvaluated.length),
        positiveFullLocalCount,
        positiveFullLocalRecall,
        negativeFullLocalCount,
        negativeFullLocalHitRate,
        gap: Number((positiveFullLocalRecall - negativeFullLocalHitRate).toFixed(2)),
      });
    }
  }

  rows.sort((left, right) => {
    if (right.gap !== left.gap) {
      return right.gap - left.gap;
    }
    if (right.positiveFullLocalRecall !== left.positiveFullLocalRecall) {
      return right.positiveFullLocalRecall - left.positiveFullLocalRecall;
    }
    return left.negativeFullLocalHitRate - right.negativeFullLocalHitRate;
  });

  console.log(JSON.stringify({
    positiveTotal: positiveBase.length,
    negativeTotal: negativeBase.length,
    indexPath,
    chunkConfigs,
    lenGates: LEN_GATES,
    rows,
  }, null, 2));
}

function parseCliArgs(argv) {
  let indexPath = 'data/reflux-two-parent-index.json';
  let chunkConfigs = DEFAULT_CHUNK_CONFIGS.map((config) => ({
    label: config.label,
    chunkLengths: [...config.chunkLengths],
  }));

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      continue;
    }

    if (token === '--index') {
      indexPath = String(argv[index + 1] || '').trim() || indexPath;
      index += 1;
      continue;
    }

    if (token === '--chunk-configs') {
      chunkConfigs = parseChunkConfigsArg(argv[index + 1], chunkConfigs);
      index += 1;
    }
  }

  return {
    indexPath,
    chunkConfigs,
  };
}

function parseChunkConfigsArg(value, fallbackValue) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return fallbackValue.map((config) => ({
      label: config.label,
      chunkLengths: [...config.chunkLengths],
    }));
  }

  const configs = rawValue
    .split(';')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const chunkLengths = [...new Set(
        token
          .split(',')
          .map((part) => Math.trunc(Number(String(part || '').trim()) || 0))
          .filter((chunkLength) => chunkLength >= 2),
      )].sort((left, right) => left - right);
      return {
        label: chunkLengths.join('_'),
        chunkLengths,
      };
    })
    .filter((config) => config.chunkLengths.length > 0);

  return configs.length > 0 ? configs : fallbackValue.map((config) => ({
    label: config.label,
    chunkLengths: [...config.chunkLengths],
  }));
}

function buildBaseFeature(title, titleSetModule) {
  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  return {
    title,
    normalizedTitle,
    len: Array.from(normalizedTitle).length,
    singleHit: titleSetModule.hasSemiconductorRefluxTitle(title),
  };
}

function countTwoParentHits(features, minTitleLength) {
  let hitCount = 0;
  for (const feature of features) {
    if (feature.twoParentHit && feature.len >= minTitleLength) {
      hitCount += 1;
    }
  }
  return hitCount;
}

function countFullLocalHits(features, minTitleLength) {
  let hitCount = 0;
  for (const feature of features) {
    if (feature.singleHit || (feature.twoParentHit && feature.len >= minTitleLength)) {
      hitCount += 1;
    }
  }
  return hitCount;
}

function hasTwoParentMixTitle(normalizedTitle, chunkPostingMap, chunkLengths) {
  const chars = Array.from(String(normalizedTitle || '').trim());
  if (chars.length < TWO_PARENT_MIN_TITLE_LENGTH) {
    return false;
  }

  for (let splitIndex = TWO_PARENT_MIN_SIDE_LENGTH; splitIndex <= chars.length - TWO_PARENT_MIN_SIDE_LENGTH; splitIndex += 1) {
    const leftValue = chars.slice(0, splitIndex).join('');
    const rightValue = chars.slice(splitIndex).join('');
    const leftChunks = extractRefluxAllChunksFromNormalizedCompareKey(
      leftValue,
      {
        chunkLengths,
        minChunkLength: 3,
        minLatinChunkLength: 4,
        minHangulChunkLength: 3,
      },
    );
    if (leftChunks.length < TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
      continue;
    }

    const rightChunks = extractRefluxAllChunksFromNormalizedCompareKey(
      rightValue,
      {
        chunkLengths,
        minChunkLength: 3,
        minLatinChunkLength: 4,
        minHangulChunkLength: 3,
      },
    );
    if (rightChunks.length < TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
      continue;
    }

    const leftCandidateCounts = countCandidateHits(leftChunks, chunkPostingMap);
    if (leftCandidateCounts.size <= 0) {
      continue;
    }

    const rightCandidateCounts = countCandidateHits(rightChunks, chunkPostingMap);
    if (rightCandidateCounts.size <= 0) {
      continue;
    }

    const leftCandidates = selectTopCandidates(leftCandidateCounts);
    if (leftCandidates.length <= 0) {
      continue;
    }

    const rightCandidates = selectTopCandidates(rightCandidateCounts);
    if (rightCandidates.length <= 0) {
      continue;
    }

    if (hasTwoParentCandidatePair(leftCandidates, rightCandidates, leftCandidateCounts, rightCandidateCounts)) {
      return true;
    }
  }

  return false;
}

function countCandidateHits(chunks, chunkPostingMap) {
  const candidateCounts = new Map();

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
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
    .filter(([, count]) => count >= TWO_PARENT_MIN_SIDE_MATCH_COUNT)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0] - right[0];
    })
    .slice(0, TWO_PARENT_MAX_CANDIDATES_PER_SIDE);
}

function hasTwoParentCandidatePair(leftCandidates, rightCandidates, leftCandidateCounts, rightCandidateCounts) {
  if (hasSingleParentDominatingBothSides(leftCandidateCounts, rightCandidateCounts)) {
    return false;
  }

  for (const [leftParentId, leftCount] of leftCandidates) {
    if (leftCount < TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
      continue;
    }

    for (const [rightParentId, rightCount] of rightCandidates) {
      if (rightCount < TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
        continue;
      }

      if (leftParentId === rightParentId) {
        continue;
      }

      if ((rightCandidateCounts.get(leftParentId) || 0) > TWO_PARENT_MAX_OPPOSITE_LEAK_COUNT) {
        continue;
      }

      if ((leftCandidateCounts.get(rightParentId) || 0) > TWO_PARENT_MAX_OPPOSITE_LEAK_COUNT) {
        continue;
      }

      return true;
    }
  }

  return false;
}

function hasSingleParentDominatingBothSides(leftCandidateCounts, rightCandidateCounts) {
  for (const [parentId, leftCount] of leftCandidateCounts.entries()) {
    if (leftCount < TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
      continue;
    }

    if ((rightCandidateCounts.get(parentId) || 0) >= TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
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
    chunkPostingMap,
  };
}

function loadDatasetTitles(repoRoot) {
  const manifestPath = path.resolve(repoRoot, 'data/reflux-title-set-unified.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const titles = [];
  const shards = Array.isArray(manifest.shards)
    ? manifest.shards
    : Array.isArray(manifest.parts)
      ? manifest.parts.map((partPath) => ({ path: partPath }))
      : [];

  for (const shard of shards) {
    const relativePartPath = String(shard?.path || '').trim();
    if (!relativePartPath) {
      continue;
    }

    const partPath = path.resolve(repoRoot, relativePartPath);
    const partJson = JSON.parse(fs.readFileSync(partPath, 'utf8'));
    for (const title of partJson.titles || []) {
      const value = String(title || '').trim();
      if (value) {
        titles.push(value);
      }
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
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?)\s*\/\s*\d{2}\.\d{2}$/u);
      return match ? match[1].trim() : line;
    });
}

function toPercent(value, total) {
  if (!total) {
    return 0;
  }
  return Number(((value / total) * 100).toFixed(2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
