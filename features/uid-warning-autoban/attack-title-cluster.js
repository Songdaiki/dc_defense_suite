import { normalizeImmediateTitleValue } from './parser.js';

const ATTACK_TITLE_CLUSTER_MIN_COUNT = 3;
const ATTACK_TITLE_SIMILARITY_THRESHOLD = 0.95;
const MIN_ATTACK_TITLE_LENGTH = 8;
const MAX_ATTACK_TITLE_LENGTH = 120;
const ATTACK_TITLE_BAN_REASON_TEXT = '도배기IP차단(무고한 경우 문의)';
const ATTACK_TITLE_BAN_HOUR = '6';
const ATTACK_TITLE_PATTERN_DATASET_PATH = 'data/uid-warning-attack-title-patterns-20260424.txt';
const EMPTY_ATTACK_TITLE_PATTERN_CORPUS = Object.freeze({
  rawCount: 0,
  patternCount: 0,
  patterns: Object.freeze([]),
});

function normalizeAttackTitle(value) {
  return normalizeImmediateTitleValue(value)
    .replace(/[a-z]+/g, '')
    .trim()
    .slice(0, MAX_ATTACK_TITLE_LENGTH);
}

function loadAttackTitlePatternCorpusFromText(text = '') {
  const patternMap = new Map();
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const rawTitle of lines) {
    const normalizedTitle = normalizeAttackTitle(rawTitle);
    if (normalizedTitle.length < MIN_ATTACK_TITLE_LENGTH) {
      continue;
    }

    const existing = patternMap.get(normalizedTitle);
    if (existing) {
      existing.count += 1;
      continue;
    }

    patternMap.set(normalizedTitle, {
      rawTitle,
      normalizedTitle,
      count: 1,
    });
  }

  const patterns = [...patternMap.values()]
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      if (right.normalizedTitle.length !== left.normalizedTitle.length) {
        return right.normalizedTitle.length - left.normalizedTitle.length;
      }

      return left.normalizedTitle.localeCompare(right.normalizedTitle, 'ko-KR');
    });

  return {
    rawCount: lines.length,
    patternCount: patterns.length,
    patterns,
  };
}

async function loadBundledAttackTitlePatternCorpus(
  datasetPath = ATTACK_TITLE_PATTERN_DATASET_PATH,
) {
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : null;
  const datasetUrl = runtime?.getURL
    ? runtime.getURL(datasetPath)
    : datasetPath;
  const response = await fetch(datasetUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return loadAttackTitlePatternCorpusFromText(await response.text());
}

function detectAttackTitleClusters(rows = [], patternCorpus = EMPTY_ATTACK_TITLE_PATTERN_CORPUS, options = {}) {
  const minCount = Math.max(
    2,
    Number(options.minCount) || ATTACK_TITLE_CLUSTER_MIN_COUNT,
  );
  const threshold = normalizeSimilarityThreshold(options.threshold);
  const candidates = buildAttackTitleCandidates(rows, patternCorpus, threshold);
  if (candidates.length < minCount) {
    return [];
  }

  const unionFind = new UnionFind(candidates.length);
  unionKnownPatternCandidates(candidates, unionFind);
  unionSimilarTitleCandidates(candidates, unionFind, threshold);

  const componentMap = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const root = unionFind.find(index);
    const existing = componentMap.get(root);
    if (existing) {
      existing.push(candidates[index]);
      continue;
    }

    componentMap.set(root, [candidates[index]]);
  }

  const assignedPostNos = new Set();
  const clusters = [];
  for (const componentCandidates of componentMap.values()) {
    const uniqueRows = dedupeCandidatesByPostNo(componentCandidates)
      .filter((candidate) => !assignedPostNos.has(candidate.postNo));
    if (uniqueRows.length < minCount) {
      continue;
    }

    uniqueRows.forEach((candidate) => assignedPostNos.add(candidate.postNo));
    clusters.push(buildAttackTitleCluster(uniqueRows));
  }

  clusters.sort((left, right) => {
    if (right.rows.length !== left.rows.length) {
      return right.rows.length - left.rows.length;
    }

    return right.newestPostNo - left.newestPostNo;
  });

  return clusters;
}

function buildAttackTitleCandidates(rows = [], patternCorpus = EMPTY_ATTACK_TITLE_PATTERN_CORPUS, threshold = ATTACK_TITLE_SIMILARITY_THRESHOLD) {
  const candidates = [];
  const seenPostNos = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.isFluid !== true || isAlreadySpamHead(row?.currentHead)) {
      continue;
    }

    const postNo = Number(row?.no) || 0;
    if (postNo <= 0 || seenPostNos.has(postNo)) {
      continue;
    }

    const normalizedTitle = normalizeAttackTitle(row?.title || row?.subject || '');
    if (normalizedTitle.length < MIN_ATTACK_TITLE_LENGTH) {
      continue;
    }

    seenPostNos.add(postNo);
    candidates.push({
      row,
      postNo,
      normalizedTitle,
      matchedPattern: findBestPatternMatch(normalizedTitle, patternCorpus, threshold),
    });
  }

  return candidates;
}

function unionKnownPatternCandidates(candidates, unionFind) {
  const patternGroups = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const patternKey = String(candidates[index]?.matchedPattern?.normalizedTitle || '').trim();
    if (!patternKey) {
      continue;
    }

    const existingIndex = patternGroups.get(patternKey);
    if (existingIndex === undefined) {
      patternGroups.set(patternKey, index);
      continue;
    }

    unionFind.union(existingIndex, index);
  }
}

function unionSimilarTitleCandidates(candidates, unionFind, threshold) {
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (
        areAttackTitlesSimilar(
          candidates[leftIndex].normalizedTitle,
          candidates[rightIndex].normalizedTitle,
          threshold,
        )
      ) {
        unionFind.union(leftIndex, rightIndex);
      }
    }
  }
}

function dedupeCandidatesByPostNo(candidates = []) {
  const seenPostNos = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const postNo = Number(candidate?.postNo) || 0;
    if (postNo <= 0 || seenPostNos.has(postNo)) {
      continue;
    }

    seenPostNos.add(postNo);
    deduped.push(candidate);
  }

  deduped.sort((left, right) => right.postNo - left.postNo);
  return deduped;
}

function buildAttackTitleCluster(candidates = []) {
  const rows = candidates.map((candidate) => candidate.row);
  const representative = chooseRepresentativeTitle(candidates);
  const averageSimilarity = calculateAverageSimilarityToRepresentative(candidates, representative);
  const matchedPattern = chooseRepresentativePattern(candidates);

  return {
    representative,
    averageSimilarity,
    matchedPattern,
    normalizedTitles: [...new Set(candidates.map((candidate) => candidate.normalizedTitle))],
    newestPostNo: candidates.reduce((maxPostNo, candidate) => Math.max(maxPostNo, candidate.postNo), 0),
    rows,
  };
}

function chooseRepresentativeTitle(candidates = []) {
  const counts = new Map();
  for (const candidate of candidates) {
    const normalizedTitle = String(candidate?.normalizedTitle || '').trim();
    if (!normalizedTitle) {
      continue;
    }

    const existing = counts.get(normalizedTitle);
    if (existing) {
      existing.count += 1;
      existing.maxPostNo = Math.max(existing.maxPostNo, candidate.postNo);
      continue;
    }

    counts.set(normalizedTitle, {
      normalizedTitle,
      count: 1,
      maxPostNo: candidate.postNo,
    });
  }

  const [first] = [...counts.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    if (right.normalizedTitle.length !== left.normalizedTitle.length) {
      return right.normalizedTitle.length - left.normalizedTitle.length;
    }

    return right.maxPostNo - left.maxPostNo;
  });

  return first?.normalizedTitle || '';
}

function chooseRepresentativePattern(candidates = []) {
  const patternMap = new Map();
  for (const candidate of candidates) {
    const pattern = candidate?.matchedPattern;
    const normalizedTitle = String(pattern?.normalizedTitle || '').trim();
    if (!normalizedTitle) {
      continue;
    }

    const existing = patternMap.get(normalizedTitle);
    if (existing) {
      existing.count += 1;
      existing.scoreSum += Number(pattern.score) || 0;
      continue;
    }

    patternMap.set(normalizedTitle, {
      ...pattern,
      count: 1,
      scoreSum: Number(pattern.score) || 0,
    });
  }

  const [first] = [...patternMap.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    return (right.scoreSum / right.count) - (left.scoreSum / left.count);
  });

  return first || null;
}

function calculateAverageSimilarityToRepresentative(candidates = [], representative = '') {
  const normalizedRepresentative = String(representative || '').trim();
  if (!normalizedRepresentative || candidates.length <= 0) {
    return 0;
  }

  const sum = candidates.reduce(
    (total, candidate) => total + calculateAttackTitleSimilarity(candidate.normalizedTitle, normalizedRepresentative),
    0,
  );
  return sum / candidates.length;
}

function findBestPatternMatch(normalizedTitle = '', patternCorpus = EMPTY_ATTACK_TITLE_PATTERN_CORPUS, threshold = ATTACK_TITLE_SIMILARITY_THRESHOLD) {
  const title = String(normalizedTitle || '').trim();
  if (!title || !Array.isArray(patternCorpus?.patterns) || patternCorpus.patterns.length === 0) {
    return null;
  }

  let bestPattern = null;
  let bestScore = 0;
  for (const pattern of patternCorpus.patterns) {
    const patternTitle = String(pattern?.normalizedTitle || '').trim();
    if (!patternTitle) {
      continue;
    }

    if (!canReachSimilarityThreshold(title, patternTitle, threshold)) {
      continue;
    }

    const score = calculateAttackTitleSimilarity(title, patternTitle, threshold);
    if (score < threshold || score <= bestScore) {
      continue;
    }

    bestScore = score;
    bestPattern = {
      ...pattern,
      score,
    };
  }

  return bestPattern;
}

function isAlreadySpamHead(value) {
  return String(value || '')
    .split(',')
    .map((head) => head.trim())
    .filter(Boolean)
    .some((head) => head.includes('도배기'));
}

function areAttackTitlesSimilar(leftValue, rightValue, threshold = ATTACK_TITLE_SIMILARITY_THRESHOLD) {
  const normalizedThreshold = normalizeSimilarityThreshold(threshold);
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (!left || !right) {
    return false;
  }

  if (!canReachSimilarityThreshold(left, right, normalizedThreshold)) {
    return false;
  }

  return calculateAttackTitleSimilarity(left, right, normalizedThreshold) >= normalizedThreshold;
}

function calculateAttackTitleSimilarity(leftValue, rightValue, threshold = 0) {
  const left = String(leftValue || '').trim();
  const right = String(rightValue || '').trim();
  if (left === right) {
    return left ? 1 : 0;
  }

  if (!left || !right) {
    return 0;
  }

  const maxLength = Math.max(left.length, right.length);
  const maxDistance = threshold > 0
    ? Math.floor((1 - normalizeSimilarityThreshold(threshold)) * maxLength)
    : maxLength;
  const distance = calculateLevenshteinDistance(left, right, maxDistance);
  return Math.max(0, 1 - (distance / maxLength));
}

function canReachSimilarityThreshold(leftValue, rightValue, threshold = ATTACK_TITLE_SIMILARITY_THRESHOLD) {
  const leftLength = String(leftValue || '').length;
  const rightLength = String(rightValue || '').length;
  const maxLength = Math.max(leftLength, rightLength);
  if (maxLength <= 0) {
    return false;
  }

  const minDistance = Math.abs(leftLength - rightLength);
  return 1 - (minDistance / maxLength) >= normalizeSimilarityThreshold(threshold);
}

function calculateLevenshteinDistance(left, right, maxDistance = Infinity) {
  if (left === right) {
    return 0;
  }

  const leftChars = [...left];
  const rightChars = [...right];
  if (leftChars.length === 0) {
    return rightChars.length;
  }

  if (rightChars.length === 0) {
    return leftChars.length;
  }

  let previous = Array.from({ length: rightChars.length + 1 }, (_, index) => index);
  let current = new Array(rightChars.length + 1);

  for (let leftIndex = 1; leftIndex <= leftChars.length; leftIndex += 1) {
    current[0] = leftIndex;
    let rowMinimum = current[0];

    for (let rightIndex = 1; rightIndex <= rightChars.length; rightIndex += 1) {
      const substitutionCost = leftChars[leftIndex - 1] === rightChars[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    [previous, current] = [current, previous];
  }

  return previous[rightChars.length];
}

function normalizeSimilarityThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return ATTACK_TITLE_SIMILARITY_THRESHOLD;
  }

  return Math.min(1, Math.max(0, numericValue));
}

class UnionFind {
  constructor(size) {
    this.parents = Array.from({ length: Math.max(0, Number(size) || 0) }, (_, index) => index);
    this.ranks = Array.from({ length: this.parents.length }, () => 0);
  }

  find(index) {
    const normalizedIndex = Math.max(0, Number(index) || 0);
    if (this.parents[normalizedIndex] !== normalizedIndex) {
      this.parents[normalizedIndex] = this.find(this.parents[normalizedIndex]);
    }

    return this.parents[normalizedIndex];
  }

  union(leftIndex, rightIndex) {
    const leftRoot = this.find(leftIndex);
    const rightRoot = this.find(rightIndex);
    if (leftRoot === rightRoot) {
      return;
    }

    if (this.ranks[leftRoot] < this.ranks[rightRoot]) {
      this.parents[leftRoot] = rightRoot;
      return;
    }

    if (this.ranks[leftRoot] > this.ranks[rightRoot]) {
      this.parents[rightRoot] = leftRoot;
      return;
    }

    this.parents[rightRoot] = leftRoot;
    this.ranks[leftRoot] += 1;
  }
}

export {
  ATTACK_TITLE_BAN_HOUR,
  ATTACK_TITLE_BAN_REASON_TEXT,
  ATTACK_TITLE_CLUSTER_MIN_COUNT,
  ATTACK_TITLE_PATTERN_DATASET_PATH,
  ATTACK_TITLE_SIMILARITY_THRESHOLD,
  EMPTY_ATTACK_TITLE_PATTERN_CORPUS,
  MAX_ATTACK_TITLE_LENGTH,
  MIN_ATTACK_TITLE_LENGTH,
  areAttackTitlesSimilar,
  calculateAttackTitleSimilarity,
  detectAttackTitleClusters,
  isAlreadySpamHead,
  loadAttackTitlePatternCorpusFromText,
  loadBundledAttackTitlePatternCorpus,
  normalizeAttackTitle,
};
