import { normalizeSemiconductorRefluxTitle } from './attack-mode.js';
import {
  ensureSemiconductorRefluxTitleSetLoaded,
  getSemiconductorRefluxTitleSetStatus,
  hasSemiconductorRefluxTitle,
} from './semiconductor-reflux-title-set.js';
import {
  extractRefluxAllChunksFromNormalizedCompareKey,
  hashRefluxStringToFnv1a64Hex,
} from '../reflux-normalization.js';

const BUNDLED_TWO_PARENT_INDEX_PATH = 'data/reflux-two-parent-index.json';
const DEFAULT_BUCKET_COUNT = 64;
const DEFAULT_CHUNK_LENGTHS = Object.freeze([3, 4]);
const DEFAULT_POSTING_ENCODING = 'u32_delta_base64';
// 운영 정책: 2-parent 분기는 26자 이상 제목만 본다.
const TWO_PARENT_MIN_TITLE_LENGTH = 26;
const TWO_PARENT_MIN_SIDE_LENGTH = 4;
const TWO_PARENT_MIN_SIDE_MATCH_COUNT = 2;
const TWO_PARENT_MAX_CANDIDATES_PER_SIDE = 40;
const TWO_PARENT_MAX_OPPOSITE_LEAK_COUNT = 1;
const TWO_PARENT_BUCKET_LOAD_CONCURRENCY = 4;
const SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY = Object.freeze({
  minTitleLength: TWO_PARENT_MIN_TITLE_LENGTH,
  minSideLength: TWO_PARENT_MIN_SIDE_LENGTH,
  minSideMatchCount: TWO_PARENT_MIN_SIDE_MATCH_COUNT,
  maxCandidatesPerSide: TWO_PARENT_MAX_CANDIDATES_PER_SIDE,
  maxOppositeLeakCount: TWO_PARENT_MAX_OPPOSITE_LEAK_COUNT,
  chunkLengths: [...DEFAULT_CHUNK_LENGTHS],
});

const runtimeState = {
  loaded: false,
  loadingPromise: null,
  twoParentIndexReady: false,
  twoParentIndexVersionMatch: false,
  twoParentIndexDatasetVersion: '',
  twoParentIndexTitleCount: 0,
  twoParentBucketCount: 0,
  twoParentChunkLengths: [...DEFAULT_CHUNK_LENGTHS],
  postingEncoding: DEFAULT_POSTING_ENCODING,
  reason: '',
  chunkPostingMap: new Map(),
};

async function ensureSemiconductorRefluxPostTitleMatcherLoaded() {
  runtimeState.loaded = true;
  await ensureSemiconductorRefluxTitleSetLoaded();
  const titleSetStatus = getSemiconductorRefluxTitleSetStatus();

  if (!titleSetStatus.ready) {
    return getSemiconductorRefluxPostTitleMatcherStatus();
  }

  if (titleSetStatus.sourceType !== 'bundled') {
    runtimeState.twoParentIndexReady = false;
    runtimeState.twoParentIndexVersionMatch = false;
    runtimeState.reason = '번들 title-set이 아니라 2-parent index를 사용하지 않습니다.';
    return getSemiconductorRefluxPostTitleMatcherStatus();
  }

  if (isTwoParentIndexUsableForTitleSetStatus(titleSetStatus)) {
    runtimeState.reason = '';
    return getSemiconductorRefluxPostTitleMatcherStatus();
  }

  if (runtimeState.loadingPromise) {
    await runtimeState.loadingPromise;
    return getSemiconductorRefluxPostTitleMatcherStatus();
  }

  runtimeState.loadingPromise = loadBundledTwoParentIndex(titleSetStatus)
    .catch((error) => {
      runtimeState.twoParentIndexReady = false;
      runtimeState.reason = `2-parent index 로드 실패: ${error.message}`;
    })
    .finally(() => {
      runtimeState.loadingPromise = null;
    });

  await runtimeState.loadingPromise;
  return getSemiconductorRefluxPostTitleMatcherStatus();
}

function getSemiconductorRefluxPostTitleMatcherStatus() {
  const titleSetStatus = getSemiconductorRefluxTitleSetStatus();
  return {
    loaded: runtimeState.loaded,
    ready: Boolean(titleSetStatus.ready),
    titleSetReady: Boolean(titleSetStatus.ready),
    datasetVersion: String(titleSetStatus.version || '').trim(),
    titleSetSourceType: String(titleSetStatus.sourceType || '').trim(),
    twoParentIndexReady: isTwoParentIndexUsableForTitleSetStatus(titleSetStatus),
    twoParentIndexVersionMatch: isTwoParentIndexVersionCompatibleWithTitleSetStatus(titleSetStatus),
    twoParentIndexDatasetVersion: runtimeState.twoParentIndexDatasetVersion,
    twoParentBucketCount: runtimeState.twoParentBucketCount,
    twoParentChunkLengths: [...runtimeState.twoParentChunkLengths],
    reason: buildMatcherReason(titleSetStatus),
  };
}

function isSemiconductorRefluxPostTitleMatcherReady() {
  return Boolean(getSemiconductorRefluxTitleSetStatus().ready);
}

function hasSemiconductorRefluxPostTitle(title) {
  if (hasSemiconductorRefluxTitle(title)) {
    return true;
  }

  const titleSetStatus = getSemiconductorRefluxTitleSetStatus();
  if (!isTwoParentIndexUsableForTitleSetStatus(titleSetStatus)) {
    return false;
  }

  const normalizedTitle = normalizeSemiconductorRefluxTitle(title);
  if (!normalizedTitle) {
    return false;
  }

  return hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedTitle);
}

function hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedTitle, indexState = runtimeState) {
  const normalizedValue = normalizeSemiconductorRefluxTitle(normalizedTitle);
  if (!normalizedValue || !isTwoParentIndexStateReady(indexState)) {
    return false;
  }

  const chars = Array.from(normalizedValue);
  if (chars.length < TWO_PARENT_MIN_TITLE_LENGTH) {
    return false;
  }

  const chunkLengths = normalizeChunkLengths(indexState?.twoParentChunkLengths);
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

    const leftCandidateCounts = countTwoParentCandidateHits(leftChunks, indexState.chunkPostingMap);
    if (leftCandidateCounts.size <= 0) {
      continue;
    }

    const rightCandidateCounts = countTwoParentCandidateHits(rightChunks, indexState.chunkPostingMap);
    if (rightCandidateCounts.size <= 0) {
      continue;
    }

    const leftCandidates = selectTopTwoParentCandidates(leftCandidateCounts);
    if (leftCandidates.length <= 0) {
      continue;
    }

    const rightCandidates = selectTopTwoParentCandidates(rightCandidateCounts);
    if (rightCandidates.length <= 0) {
      continue;
    }

    if (hasTwoParentCandidatePair(leftCandidates, rightCandidates, leftCandidateCounts, rightCandidateCounts)) {
      return true;
    }
  }

  return false;
}

function countTwoParentCandidateHits(chunks, chunkPostingMap) {
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

function selectTopTwoParentCandidates(candidateCounts) {
  return [...candidateCounts.entries()]
    .filter(([, count]) => count >= TWO_PARENT_MIN_SIDE_MATCH_COUNT)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return compareTwoParentCandidateKeys(left[0], right[0]);
    })
    .slice(0, TWO_PARENT_MAX_CANDIDATES_PER_SIDE);
}

function compareTwoParentCandidateKeys(leftKey, rightKey) {
  const leftNumber = Number(leftKey);
  const rightNumber = Number(rightKey);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return String(leftKey).localeCompare(String(rightKey), 'ko');
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
  const leftEntries = leftCandidateCounts instanceof Map
    ? leftCandidateCounts.entries()
    : [];

  for (const [parentId, leftCount] of leftEntries) {
    if (leftCount < TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
      continue;
    }

    if ((rightCandidateCounts.get(parentId) || 0) >= TWO_PARENT_MIN_SIDE_MATCH_COUNT) {
      return true;
    }
  }

  return false;
}

function isTwoParentIndexStateReady(indexState = runtimeState) {
  return Boolean(
    indexState
    && indexState.twoParentIndexReady
    && indexState.chunkPostingMap instanceof Map
    && indexState.chunkPostingMap.size > 0,
  );
}

function normalizeChunkLengths(chunkLengths) {
  const normalizedChunkLengths = [...new Set(
    (Array.isArray(chunkLengths) ? chunkLengths : [])
      .map((chunkLength) => Math.trunc(Number(chunkLength) || 0))
      .filter((chunkLength) => chunkLength >= 2),
  )].sort((left, right) => left - right);
  return normalizedChunkLengths.length > 0
    ? normalizedChunkLengths
    : [...DEFAULT_CHUNK_LENGTHS];
}

function getComparableTitleSetTitleCount(titleSetStatus) {
  return Math.max(
    0,
    Number(titleSetStatus?.sourceTitleCount ?? titleSetStatus?.titleCount) || 0,
  );
}

async function loadBundledTwoParentIndex(titleSetStatus) {
  const manifestJson = await readBundledDatasetJson(BUNDLED_TWO_PARENT_INDEX_PATH);
  const manifest = normalizeBundledTwoParentIndexManifest(manifestJson);
  runtimeState.twoParentIndexDatasetVersion = manifest.datasetVersion;
  runtimeState.twoParentIndexTitleCount = manifest.titleCount;
  runtimeState.twoParentBucketCount = manifest.bucketCount;
  runtimeState.twoParentChunkLengths = [...manifest.chunkLengths];
  runtimeState.postingEncoding = manifest.postingEncoding;
  runtimeState.twoParentIndexVersionMatch = manifest.datasetVersion === String(titleSetStatus.version || '').trim()
    && manifest.titleCount === getComparableTitleSetTitleCount(titleSetStatus);

  if (!runtimeState.twoParentIndexVersionMatch) {
    runtimeState.twoParentIndexReady = false;
    runtimeState.reason = '2-parent index와 title-set version/titleCount가 일치하지 않습니다.';
    return;
  }

  const nextChunkPostingMap = await loadBundledTwoParentBucketEntries(manifest);
  runtimeState.chunkPostingMap = nextChunkPostingMap;
  runtimeState.twoParentIndexReady = nextChunkPostingMap.size > 0;
  runtimeState.twoParentIndexVersionMatch = true;
  runtimeState.reason = runtimeState.twoParentIndexReady
    ? ''
    : '2-parent index bucket이 비어 있습니다.';
}

async function loadBundledTwoParentBucketEntries(manifest) {
  const bucketPaths = [...manifest.paths];
  const nextChunkPostingMap = new Map();
  let nextBucketIndex = 0;

  async function worker() {
    while (nextBucketIndex < bucketPaths.length) {
      const currentBucketIndex = nextBucketIndex;
      nextBucketIndex += 1;
      const bucketJson = await readBundledDatasetJson(bucketPaths[currentBucketIndex]);
      const entries = normalizeBundledTwoParentBucketEntries(bucketJson, manifest.postingEncoding);
      for (const [chunk, postings] of entries) {
        nextChunkPostingMap.set(chunk, postings);
      }
    }
  }

  const workerCount = Math.max(
    1,
    Math.min(TWO_PARENT_BUCKET_LOAD_CONCURRENCY, bucketPaths.length),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return nextChunkPostingMap;
}

function normalizeBundledTwoParentIndexManifest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('2-parent index manifest 형식이 올바르지 않습니다.');
  }

  const bucketCount = Math.max(1, Math.trunc(Number(payload?.bucketCount) || 0));
  const paths = (Array.isArray(payload?.paths) ? payload.paths : [])
    .map((pathValue) => String(pathValue || '').trim())
    .filter(Boolean);
  if (paths.length !== bucketCount) {
    throw new Error(`2-parent index bucket 경로 수가 올바르지 않습니다. (${paths.length}/${bucketCount})`);
  }

  return {
    datasetVersion: String(payload?.datasetVersion || '').trim(),
    titleCount: Math.max(0, Math.trunc(Number(payload?.titleCount) || 0)),
    bucketCount,
    chunkLengths: normalizeChunkLengths(payload?.chunkLengths),
    postingEncoding: String(payload?.postingEncoding || DEFAULT_POSTING_ENCODING).trim() || DEFAULT_POSTING_ENCODING,
    paths,
  };
}

function normalizeBundledTwoParentBucketEntries(payload, expectedEncoding = DEFAULT_POSTING_ENCODING) {
  if (Array.isArray(payload?.rows)) {
    const bucketEncoding = String(payload?.encoding || expectedEncoding).trim() || expectedEncoding;
    if (bucketEncoding !== expectedEncoding) {
      throw new Error(`지원하지 않는 bucket encoding입니다. (${bucketEncoding})`);
    }

    return payload.rows.map((row, index) => {
      if (!Array.isArray(row) || row.length < 2) {
        throw new Error(`2-parent bucket row 형식이 올바르지 않습니다. (index=${index})`);
      }

      const normalizedChunk = String(row[0] || '').trim();
      if (!normalizedChunk) {
        throw new Error(`2-parent bucket chunk 키가 비어 있습니다. (index=${index})`);
      }

      const postings = decodePackedUint32DeltaBase64(row[1], 0);
      return [normalizedChunk, postings];
    });
  }

  const entries = payload?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('2-parent bucket entries 형식이 올바르지 않습니다.');
  }

  return Object.entries(entries).map(([chunk, entry]) => {
    const normalizedChunk = String(chunk || '').trim();
    if (!normalizedChunk) {
      throw new Error('2-parent bucket chunk 키가 비어 있습니다.');
    }

    const encoding = String(entry?.encoding || expectedEncoding).trim() || expectedEncoding;
    if (encoding !== expectedEncoding) {
      throw new Error(`지원하지 않는 postings encoding입니다. (${encoding})`);
    }

    const count = Math.max(0, Math.trunc(Number(entry?.count) || 0));
    const postings = decodePackedUint32DeltaBase64(entry?.data, count);
    return [normalizedChunk, postings];
  });
}

function decodePackedUint32DeltaBase64(base64Value, expectedCount = 0) {
  const bytes = decodeBase64ToUint8Array(base64Value);
  if (bytes.byteLength % 4 !== 0) {
    throw new Error('packed postings byte 길이가 4의 배수가 아닙니다.');
  }

  const valueCount = bytes.byteLength / 4;
  if (expectedCount > 0 && valueCount !== expectedCount) {
    throw new Error(`packed postings count가 맞지 않습니다. (${valueCount}/${expectedCount})`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const postings = new Uint32Array(valueCount);
  let runningValue = 0;

  for (let index = 0; index < valueCount; index += 1) {
    runningValue += view.getUint32(index * 4, true);
    postings[index] = runningValue;
  }

  return postings;
}

function decodeBase64ToUint8Array(base64Value) {
  const normalizedValue = String(base64Value || '').trim();
  if (!normalizedValue) {
    return new Uint8Array(0);
  }

  if (typeof atob === 'function') {
    const binaryString = atob(normalizedValue);
    const bytes = new Uint8Array(binaryString.length);
    for (let index = 0; index < binaryString.length; index += 1) {
      bytes[index] = binaryString.charCodeAt(index);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(normalizedValue, 'base64'));
  }

  throw new Error('base64 디코더를 찾을 수 없습니다.');
}

function readBundledDatasetJson(datasetPath) {
  const datasetUrl = chrome.runtime?.getURL
    ? chrome.runtime.getURL(datasetPath)
    : datasetPath;
  return fetch(datasetUrl).then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  });
}

function buildMatcherReason(titleSetStatus) {
  if (!titleSetStatus.ready) {
    return '기존 title-set이 준비되지 않았습니다.';
  }

  if (String(titleSetStatus.sourceType || '').trim() !== 'bundled') {
    return '번들 title-set이 아니라 2-parent index를 사용하지 않습니다.';
  }

  if (runtimeState.loadingPromise) {
    return '2-parent index 로딩 중입니다.';
  }

  if (!runtimeState.twoParentIndexDatasetVersion) {
    return runtimeState.reason || '2-parent index가 아직 로드되지 않았습니다.';
  }

  if (!isTwoParentIndexVersionCompatibleWithTitleSetStatus(titleSetStatus)) {
    return runtimeState.reason || '2-parent index version/titleCount가 맞지 않습니다.';
  }

  if (!runtimeState.twoParentIndexReady) {
    return runtimeState.reason || '2-parent index를 사용할 수 없습니다.';
  }

  return runtimeState.reason || '';
}

function isTwoParentIndexVersionCompatibleWithTitleSetStatus(titleSetStatus) {
  return Boolean(
    runtimeState.twoParentIndexVersionMatch
    && runtimeState.twoParentIndexDatasetVersion
    && runtimeState.twoParentIndexDatasetVersion === String(titleSetStatus?.version || '').trim()
    && runtimeState.twoParentIndexTitleCount === getComparableTitleSetTitleCount(titleSetStatus),
  );
}

function isTwoParentIndexUsableForTitleSetStatus(titleSetStatus) {
  return Boolean(
    titleSetStatus?.ready
    && String(titleSetStatus?.sourceType || '').trim() === 'bundled'
    && isTwoParentIndexVersionCompatibleWithTitleSetStatus(titleSetStatus)
    && runtimeState.twoParentIndexReady
    && runtimeState.chunkPostingMap.size > 0,
  );
}

function getSemiconductorRefluxTwoParentBucketIndex(chunk, bucketCount = runtimeState.twoParentBucketCount || DEFAULT_BUCKET_COUNT) {
  const normalizedBucketCount = Math.max(1, Math.trunc(Number(bucketCount) || 0));
  const chunkHashHex = hashRefluxStringToFnv1a64Hex(chunk);
  return Number(BigInt(`0x${chunkHashHex}`) % BigInt(normalizedBucketCount));
}

function getSemiconductorRefluxBundledTwoParentIndexSnapshot() {
  return {
    ready: Boolean(runtimeState.twoParentIndexReady),
    datasetVersion: runtimeState.twoParentIndexDatasetVersion,
    titleCount: runtimeState.twoParentIndexTitleCount,
    bucketCount: runtimeState.twoParentBucketCount,
    chunkLengths: [...runtimeState.twoParentChunkLengths],
    postingEncoding: runtimeState.postingEncoding,
    chunkPostingMap: runtimeState.chunkPostingMap,
  };
}

export {
  SEMICONDUCTOR_REFLUX_TWO_PARENT_POLICY,
  ensureSemiconductorRefluxPostTitleMatcherLoaded,
  getSemiconductorRefluxBundledTwoParentIndexSnapshot,
  getSemiconductorRefluxPostTitleMatcherStatus,
  getSemiconductorRefluxTwoParentBucketIndex,
  hasNormalizedSemiconductorRefluxTwoParentMixTitle,
  hasSemiconductorRefluxPostTitle,
  isSemiconductorRefluxPostTitleMatcherReady,
};
