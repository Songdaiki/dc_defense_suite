/**
 * 역류기 제목 정규화용 필터 regex
 *
 * 카테고리:
 *   1. 불가시 문자 — Soft Hyphen, ZWSP, ZWNJ, ZWJ, Hangul Filler, Braille Blank 등
 *   2. 이모지 — Extended_Pictographic, Regional Indicator(국기), Variation Selector, Tag Characters
 *   3. 결합 문자 — \p{M} (Combining Marks: 악센트, 취소선, keycap 등)
 *                  ※ NFKC 정규화 이후 적용하므로 한글 자모 합성에 안전
 *   4. 구두점 — ❌ strip하지 않음 (5.4->5.5, Q&A 등 정상 제목 오탐 방지)
 */
const REFLUX_INVISIBLE_DELIMITER_REGEX = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\uFE00-\uFE0F\uFFF9-\uFFFB]|\p{Extended_Pictographic}|\p{M}|[\u{1F1E0}-\u{1F1FF}]|[\u{E0001}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;
const REFLUX_WHITESPACE_REGEX = /\s+/gu;
const REFLUX_PERMUTATION_CORE_CHAR_REGEX = /[^\p{L}\p{N}]+/gu;
const REFLUX_LATIN_CHAR_REGEX = /\p{Script=Latin}/u;
const REFLUX_HANGUL_CHAR_REGEX = /\p{Script=Hangul}/u;
const REFLUX_HANGUL_SYLLABLE_CHAR_REGEX = /[\uAC00-\uD7A3]/u;
const REFLUX_HANGUL_JAMO_ONLY_REGEX = /^[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]+$/u;
const FNV1A64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A64_PRIME = 0x100000001b3n;
const FNV1A64_MASK = 0xffffffffffffffffn;

function buildRefluxSearchQuery(value) {
  // search query는 "보이지 않는 filler만 삭제"하고
  // 원래 존재하던 실제 공백만 유지해야 한다.
  // 잘못된 token merge로 "클로 드인", "덕테 이프" 같은 가짜 공백이 생기면
  // getSearch 매칭이 오히려 약해진다.
  return String(value || '')
    .replace(REFLUX_INVISIBLE_DELIMITER_REGEX, '')
    .replace(REFLUX_WHITESPACE_REGEX, ' ')
    .trim();
}

function normalizeRefluxCompareKey(value) {
  let normalizedValue = buildRefluxSearchQuery(value);
  try {
    normalizedValue = normalizedValue.normalize('NFKC');
  } catch (error) {
    // normalize 미지원 환경에서도 문자열 정리만 계속 진행한다.
  }

  return normalizedValue
    .replace(REFLUX_INVISIBLE_DELIMITER_REGEX, '')
    .toLowerCase()
    .replace(REFLUX_WHITESPACE_REGEX, '')
    .trim();
}

function buildRefluxPermutationSignature(value, options = {}) {
  const normalizedCompareKey = normalizeRefluxCompareKey(value);
  return buildRefluxPermutationSignatureFromNormalizedCompareKey(normalizedCompareKey, options);
}

function buildRefluxPermutationSignatureFromNormalizedCompareKey(value, { minLength = 7 } = {}) {
  const normalizedMinLength = Math.max(1, Math.trunc(Number(minLength) || 0));
  const coreValue = String(value || '')
    .replace(REFLUX_PERMUTATION_CORE_CHAR_REGEX, '')
    .trim();
  if (!coreValue) {
    return '';
  }

  const chars = Array.from(coreValue);
  if (chars.length < normalizedMinLength) {
    return '';
  }

  chars.sort();
  return `${chars.length}:${hashSortedCharsToFnv1a64Hex(chars)}`;
}

function buildRefluxContainmentSignatures(value, options = {}) {
  const normalizedCompareKey = normalizeRefluxCompareKey(value);
  return buildRefluxContainmentSignaturesFromNormalizedCompareKey(normalizedCompareKey, options);
}

function buildRefluxContainmentSignaturesFromNormalizedCompareKey(
  value,
  {
    minLength = 12,
    minChunkLength = 4,
    minLatinChunkLength = 5,
    minHangulChunkLength = 4,
    maxChunkLength = 6,
  } = {},
) {
  const chars = Array.from(String(value || '').trim());
  const normalizedMinLength = Math.max(1, Math.trunc(Number(minLength) || 0));
  const normalizedMinChunkLength = Math.max(2, Math.trunc(Number(minChunkLength) || 0));
  const normalizedMinLatinChunkLength = Math.max(
    normalizedMinChunkLength,
    Math.trunc(Number(minLatinChunkLength) || 0),
  );
  const normalizedMinHangulChunkLength = Math.max(
    normalizedMinChunkLength,
    Math.trunc(Number(minHangulChunkLength) || 0),
  );
  const normalizedMaxChunkLength = Math.max(
    normalizedMinChunkLength,
    Math.trunc(Number(maxChunkLength) || 0),
  );

  if (chars.length < normalizedMinLength) {
    return [];
  }

  const chunkLength = Math.max(
    normalizedMinChunkLength,
    Math.min(normalizedMaxChunkLength, Math.floor(chars.length / 4) || 0),
  );
  if (chars.length < chunkLength * 3) {
    return [];
  }

  const signatures = new Set();
  const maxStart = chars.length - chunkLength;
  const anchorStarts = [...new Set([
    0,
    Math.floor(maxStart / 4),
    Math.floor(maxStart / 2),
    maxStart,
  ])];
  const anchorChunks = anchorStarts
    .map((start) => chars.slice(start, start + chunkLength).join(''))
    .filter((chunk) => isRefluxContainmentChunkEligible(
      chunk,
      {
        minChunkLength: normalizedMinChunkLength,
        minLatinChunkLength: normalizedMinLatinChunkLength,
        minHangulChunkLength: normalizedMinHangulChunkLength,
      },
    ));

  for (let firstIndex = 0; firstIndex < anchorChunks.length - 2; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < anchorChunks.length - 1; secondIndex += 1) {
      for (let thirdIndex = secondIndex + 1; thirdIndex < anchorChunks.length; thirdIndex += 1) {
        // prefix만 겹치는 영문 제목 오탐을 줄이기 위해,
        // anchor가 4개 이상일 때는 "앞 + 뒤 + 중간 1개" 조합만 시그니처로 인정한다.
        if (
          anchorChunks.length >= 4
          && (firstIndex !== 0 || thirdIndex !== anchorChunks.length - 1)
        ) {
          continue;
        }

        const signature = buildRefluxContainmentSignatureFromChunks(
          [
            anchorChunks[firstIndex],
            anchorChunks[secondIndex],
            anchorChunks[thirdIndex],
          ],
          {
            chunkLength,
            minChunkLength: normalizedMinChunkLength,
            minLatinChunkLength: normalizedMinLatinChunkLength,
            minHangulChunkLength: normalizedMinHangulChunkLength,
          },
        );
        if (signature) {
          signatures.add(signature);
        }
      }
    }
  }

  return [...signatures];
}

function buildRefluxContainmentSignatureFromChunks(
  chunks,
  {
    chunkLength = 0,
    minChunkLength = 4,
    minLatinChunkLength = 5,
    minHangulChunkLength = 4,
  } = {},
) {
  const normalizedChunks = (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => String(chunk || '').trim())
    .filter((chunk) => isRefluxContainmentChunkEligible(
      chunk,
      {
        minChunkLength,
        minLatinChunkLength,
        minHangulChunkLength,
      },
    ));
  if (normalizedChunks.length < 3) {
    return '';
  }

  const dedupedChunks = [...new Set(normalizedChunks)];
  if (dedupedChunks.length < 3) {
    return '';
  }

  const normalizedChunkLength = Math.max(1, Math.trunc(Number(chunkLength) || 0));
  const sortedChunks = [...dedupedChunks].sort((left, right) => left.localeCompare(right, 'ko'));
  const payload = sortedChunks.join('\u001f');
  const totalChars = dedupedChunks.reduce((sum, chunk) => sum + Array.from(chunk).length, 0);
  return `rc1:${normalizedChunkLength}:${totalChars}:${hashStringToFnv1a64Hex(payload)}`;
}

function getRefluxContainmentChunkMinLength(
  chunk,
  {
    minChunkLength = 4,
    minLatinChunkLength = 5,
    minHangulChunkLength = 4,
  } = {},
) {
  const normalizedMinChunkLength = Math.max(1, Math.trunc(Number(minChunkLength) || 0));
  const normalizedMinLatinChunkLength = Math.max(
    normalizedMinChunkLength,
    Math.trunc(Number(minLatinChunkLength) || 0),
  );
  const normalizedMinHangulChunkLength = Math.max(
    normalizedMinChunkLength,
    Math.trunc(Number(minHangulChunkLength) || 0),
  );
  const normalizedChunk = String(chunk || '').trim();
  if (!normalizedChunk) {
    return normalizedMinChunkLength;
  }

  let requiredMinLength = normalizedMinChunkLength;
  if (REFLUX_HANGUL_CHAR_REGEX.test(normalizedChunk)) {
    requiredMinLength = Math.max(requiredMinLength, normalizedMinHangulChunkLength);
  }
  if (REFLUX_LATIN_CHAR_REGEX.test(normalizedChunk)) {
    requiredMinLength = Math.max(requiredMinLength, normalizedMinLatinChunkLength);
  }

  return requiredMinLength;
}

function isRefluxContainmentChunkEligible(
  chunk,
  {
    minChunkLength = 4,
    minLatinChunkLength = 5,
    minHangulChunkLength = 4,
  } = {},
) {
  const normalizedChunk = String(chunk || '').trim();
  if (!normalizedChunk) {
    return false;
  }

  const chunkLength = Array.from(normalizedChunk).length;
  if (
    REFLUX_HANGUL_JAMO_ONLY_REGEX.test(normalizedChunk)
    && !REFLUX_HANGUL_SYLLABLE_CHAR_REGEX.test(normalizedChunk)
  ) {
    // `ㅋㅋㅋㅋ`, `ㄷㄷㄷㄷ`, `ㅅㅂㅅㅂ`, `ㅇㅇㅇㅇ`처럼
    // 자모만 반복되는 조각은 너무 흔해서 containment 공통조각으로 쓰면 오탐이 커진다.
    return false;
  }

  return chunkLength >= getRefluxContainmentChunkMinLength(
    normalizedChunk,
    {
      minChunkLength,
      minLatinChunkLength,
      minHangulChunkLength,
    },
  );
}

function extractRefluxAllChunksFromNormalizedCompareKey(
  value,
  {
    chunkLengths = [3, 4],
    minChunkLength = 3,
    minLatinChunkLength = 4,
    minHangulChunkLength = 3,
  } = {},
) {
  const chars = Array.from(String(value || '').trim());
  if (chars.length <= 0) {
    return [];
  }

  const normalizedChunkLengths = normalizeRefluxChunkLengths(chunkLengths, minChunkLength);
  const chunks = [];
  const seen = new Set();

  for (const chunkLength of normalizedChunkLengths) {
    if (chars.length < chunkLength) {
      continue;
    }

    for (let start = 0; start <= chars.length - chunkLength; start += 1) {
      const chunk = chars.slice(start, start + chunkLength).join('');
      if (
        !isRefluxContainmentChunkEligible(
          chunk,
          {
            minChunkLength,
            minLatinChunkLength,
            minHangulChunkLength,
          },
        )
        || seen.has(chunk)
      ) {
        continue;
      }

      seen.add(chunk);
      chunks.push(chunk);
    }
  }

  return chunks;
}

function extractRefluxRepresentativeChunksFromNormalizedCompareKey(
  value,
  {
    chunkLengths = [3, 4],
    minChunkLength = 3,
    minLatinChunkLength = 4,
    minHangulChunkLength = 3,
    anchorMode = 'start_mid_end',
  } = {},
) {
  const chars = Array.from(String(value || '').trim());
  if (chars.length <= 0) {
    return [];
  }

  const normalizedChunkLengths = normalizeRefluxChunkLengths(chunkLengths, minChunkLength);
  const chunks = [];
  const seen = new Set();

  for (const chunkLength of normalizedChunkLengths) {
    if (chars.length < chunkLength) {
      continue;
    }

    const maxStart = chars.length - chunkLength;
    const anchorStarts = getRefluxRepresentativeAnchorStarts(maxStart, anchorMode);
    for (const start of anchorStarts) {
      const chunk = chars.slice(start, start + chunkLength).join('');
      if (
        !isRefluxContainmentChunkEligible(
          chunk,
          {
            minChunkLength,
            minLatinChunkLength,
            minHangulChunkLength,
          },
        )
        || seen.has(chunk)
      ) {
        continue;
      }

      seen.add(chunk);
      chunks.push(chunk);
    }
  }

  return chunks;
}

function normalizeRefluxChunkLengths(chunkLengths, minChunkLength) {
  const normalizedMinChunkLength = Math.max(1, Math.trunc(Number(minChunkLength) || 0));
  return [...new Set(
    (Array.isArray(chunkLengths) ? chunkLengths : [])
      .map((chunkLength) => Math.trunc(Number(chunkLength) || 0))
      .filter((chunkLength) => chunkLength >= normalizedMinChunkLength),
  )].sort((left, right) => left - right);
}

function getRefluxRepresentativeAnchorStarts(maxStart, anchorMode = 'start_mid_end') {
  const normalizedMaxStart = Math.max(0, Math.trunc(Number(maxStart) || 0));
  if (anchorMode === 'start_quarter_mid_threequarter_end') {
    return [...new Set([
      0,
      Math.floor(normalizedMaxStart / 4),
      Math.floor(normalizedMaxStart / 2),
      Math.floor((normalizedMaxStart * 3) / 4),
      normalizedMaxStart,
    ])];
  }

  return [...new Set([
    0,
    Math.floor(normalizedMaxStart / 2),
    normalizedMaxStart,
  ])];
}

function hashSortedCharsToFnv1a64Hex(chars) {
  let hash = FNV1A64_OFFSET_BASIS;

  for (const char of Array.isArray(chars) ? chars : []) {
    const codePoint = String(char || '').codePointAt(0);
    if (!Number.isFinite(codePoint)) {
      continue;
    }

    hash ^= BigInt(codePoint);
    hash = (hash * FNV1A64_PRIME) & FNV1A64_MASK;
  }

  return hash.toString(16).padStart(16, '0');
}

function hashStringToFnv1a64Hex(value) {
  let hash = FNV1A64_OFFSET_BASIS;

  for (const char of Array.from(String(value || ''))) {
    const codePoint = String(char || '').codePointAt(0);
    if (!Number.isFinite(codePoint)) {
      continue;
    }

    hash ^= BigInt(codePoint);
    hash = (hash * FNV1A64_PRIME) & FNV1A64_MASK;
  }

  return hash.toString(16).padStart(16, '0');
}

function hashRefluxStringToFnv1a64Hex(value) {
  return hashStringToFnv1a64Hex(value);
}

export {
  buildRefluxContainmentSignatureFromChunks,
  buildRefluxContainmentSignatures,
  buildRefluxContainmentSignaturesFromNormalizedCompareKey,
  buildRefluxSearchQuery,
  buildRefluxPermutationSignature,
  buildRefluxPermutationSignatureFromNormalizedCompareKey,
  extractRefluxAllChunksFromNormalizedCompareKey,
  extractRefluxRepresentativeChunksFromNormalizedCompareKey,
  getRefluxContainmentChunkMinLength,
  hashRefluxStringToFnv1a64Hex,
  isRefluxContainmentChunkEligible,
  normalizeRefluxCompareKey,
};
