#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeSemiconductorRefluxTitle } from '../features/post/attack-mode.js';
import {
  hasNormalizedSemiconductorRefluxTwoParentMixTitle,
} from '../features/post/semiconductor-reflux-post-title-matcher.js';
import {
  extractRefluxRepresentativeChunksFromNormalizedCompareKey,
} from '../features/reflux-normalization.js';

const DEFAULT_INDEX_MANIFEST_PATH = 'data/reflux-two-parent-index.json';
const DEFAULT_ATTACK_SAMPLE_PATH = 'docs/실제공격.md';
const CHUNK_OPTIONS = {
  chunkLengths: [3, 4],
  minChunkLength: 3,
  minLatinChunkLength: 4,
  minHangulChunkLength: 3,
  anchorMode: 'start_mid_end',
};

async function main() {
  const indexManifestPath = path.resolve(process.cwd(), process.argv[2] || DEFAULT_INDEX_MANIFEST_PATH);
  const attackSamplePath = path.resolve(process.cwd(), process.argv[3] || DEFAULT_ATTACK_SAMPLE_PATH);

  const syntheticResult = runSyntheticEdgeCases();
  console.log(`[verify-reflux-two-parent-matcher] synthetic required edge cases: ${syntheticResult.requiredPassCount}/${syntheticResult.requiredTotalCount}`);
  console.log(`[verify-reflux-two-parent-matcher] synthetic limitation cases: ${syntheticResult.limitationObservedCount}/${syntheticResult.limitationTotalCount}`);
  if (syntheticResult.failures.length > 0) {
    for (const failure of syntheticResult.failures) {
      console.log(`- 실패: ${failure.name} (expected=${failure.expected}, actual=${failure.actual})`);
    }
  }
  if (syntheticResult.limitations.length > 0) {
    for (const limitation of syntheticResult.limitations) {
      console.log(`- 제한 확인: ${limitation.name} (expected=${limitation.expected}, actual=${limitation.actual})`);
    }
  }

  const realIndexState = await loadIndexState(indexManifestPath);
  const attackRecallResult = await runRealAttackRecall(realIndexState, attackSamplePath);
  console.log(`[verify-reflux-two-parent-matcher] real attack recall: ${attackRecallResult.hitCount}/${attackRecallResult.totalCount} (${attackRecallResult.recallPercent.toFixed(2)}%)`);
  if (attackRecallResult.misses.length > 0) {
    console.log('- real attack miss 샘플:');
    for (const missTitle of attackRecallResult.misses.slice(0, 10)) {
      console.log(`  ${missTitle}`);
    }
  }

  if (syntheticResult.failures.length > 0 || attackRecallResult.recallPercent < 90) {
    process.exitCode = 1;
  }
}

function runSyntheticEdgeCases() {
  const parentTitles = [
    '시바드디어지피티플러스0원구독끝나네',
    '대기업때려치고창업한다진짜',
    '제미나이3pro딥씽크오늘공홈출시',
    'gptfiveprolaunchtoday',
    'openaipluspricecutdone',
  ];
  const syntheticIndexState = buildSyntheticIndexState(parentTitles);
  const cases = [
    { name: '01_concat_ab', title: '시바드디어지피티플러스0원구독끝나네대기업때려치고창업한다진짜', expected: true },
    { name: '02_mix_ab_shorter', title: '시바드디어플러스끝나네대기업때려치고창업한다진짜', expected: true },
    { name: '03_mix_ab_reordered_words', title: '시바끝나네드디어플러스지피티0원구독대기업창업한다때려치고진짜', expected: true, kind: 'limitation' },
    { name: '04_mix_ab_with_spaces', title: '시바 드디어 플러스 끝나네 대기업 때려치고 창업한다 진짜', expected: true },
    { name: '05_mix_ab_with_punct', title: '시바-드디어-플러스-끝나네 / 대기업-때려치고-창업한다-진짜', expected: true, kind: 'limitation' },
    { name: '06_concat_ba', title: '대기업때려치고창업한다진짜시바드디어지피티플러스0원구독끝나네', expected: true },
    { name: '07_mix_ba_shorter', title: '대기업창업한다때려치고진짜시바드디어플러스끝나네', expected: true, kind: 'limitation' },
    { name: '08_mix_ac', title: '시바드디어플러스끝나네제미나이딥씽크공홈출시오늘', expected: true },
    { name: '09_mix_ca', title: '제미나이딥씽크오늘공홈출시시바드디어플러스끝나네', expected: true },
    { name: '10_mix_bc', title: '대기업때려치고창업한다진짜제미나이딥씽크공홈출시오늘', expected: true },
    { name: '11_latin_concat_de', title: 'gptfiveprolaunchtodayopenaipluspricecutdone', expected: true },
    { name: '12_latin_mix_de', title: 'gptfiveprotodayloadopenaipluspricecutdone', expected: true },
    { name: '13_latin_korean_mix', title: '시바드디어플러스끝나네openaipluspricecutdone', expected: true },
    { name: '14_korean_latin_mix', title: 'gptfiveprolaunchtoday대기업때려치고창업한다진짜', expected: true },
    { name: '15_noise_inside', title: '시바드디어___플러스끝나네###대기업때려치고창업한다진짜', expected: true },
    { name: '16_nfkc_fullwidth', title: '시바드디어플러스끝나네 ＧＰＴＦＩＶＥＰＲＯＬＡＵＮＣＨＴＯＤＡＹ', expected: true },
    { name: '17_single_parent_a', title: '시바드디어지피티플러스0원구독끝나네', expected: false },
    { name: '18_single_parent_b', title: '대기업때려치고창업한다진짜', expected: false },
    { name: '19_same_parent_a_twice', title: '시바드디어플러스끝나네시바드디어플러스끝나네', expected: false },
    { name: '20_same_parent_b_twice', title: '대기업때려치고창업한다진짜대기업때려치고창업한다진짜', expected: false },
    { name: '21_too_short', title: '시바끝나네', expected: false },
    { name: '22_left_side_too_short', title: '시바대기업때려치고창업한다진짜', expected: false },
    { name: '23_right_side_too_short', title: '시바드디어플러스끝나네대기', expected: false },
    { name: '24_unrelated', title: '오늘점심뭐먹지갑자기비가많이오네', expected: false },
    { name: '25_jamo_only', title: 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', expected: false },
    { name: '26_partial_one_side_only', title: '시바드디어플러스끝나네아무말아무말아무말', expected: false },
    { name: '27_other_side_one_chunk_only', title: '시바드디어플러스끝나네대기업', expected: false },
    { name: '28_same_parent_leak_large', title: '시바드디어플러스끝나네시바지피티0원구독끝나네대기업', expected: false },
    { name: '29_latin_three_only', title: 'gptopenai', expected: false },
    { name: '30_latin_single_parent_d', title: 'gptfiveprolaunchtoday', expected: false },
    { name: '31_latin_single_parent_e', title: 'openaipluspricecutdone', expected: false },
    { name: '32_korean_partial_noise', title: '시바드디어플러스끝나네@@@@', expected: false },
    { name: '33_digits_only_noise', title: '12345678901234567890', expected: false },
    { name: '34_mixed_but_same_parent_c', title: '제미나이딥씽크공홈출시제미나이오늘공홈출시', expected: false },
    { name: '35_cross_parent_with_spaces', title: '대기업 때려치고 창업한다 진짜 / 제미나이 딥씽크 공홈 출시 오늘', expected: true },
    { name: '36_cross_parent_with_linebreak_like_spaces', title: '시바드디어플러스끝나네\n대기업때려치고창업한다진짜', expected: true },
  ];

  const failures = [];
  const limitations = [];
  let requiredPassCount = 0;
  let limitationObservedCount = 0;
  for (const testCase of cases) {
    const actual = hasNormalizedSemiconductorRefluxTwoParentMixTitle(testCase.title, syntheticIndexState);
    const isLimitationCase = testCase.kind === 'limitation';
    if (actual === testCase.expected) {
      if (isLimitationCase) {
        limitationObservedCount += 1;
      } else {
        requiredPassCount += 1;
      }
      continue;
    }

    if (isLimitationCase) {
      limitations.push({
        ...testCase,
        actual,
      });
      continue;
    }

    failures.push({
      ...testCase,
      actual,
    });
  }

  return {
    totalCount: cases.length,
    requiredTotalCount: cases.filter((testCase) => testCase.kind !== 'limitation').length,
    requiredPassCount,
    limitationTotalCount: cases.filter((testCase) => testCase.kind === 'limitation').length,
    limitationObservedCount,
    failures,
    limitations,
  };
}

function buildSyntheticIndexState(parentTitles) {
  const chunkPostingMap = new Map();
  const normalizedTitles = (Array.isArray(parentTitles) ? parentTitles : [])
    .map((title) => normalizeSemiconductorRefluxTitle(title))
    .filter(Boolean);

  normalizedTitles.forEach((title, titleId) => {
    const representativeChunks = extractRefluxRepresentativeChunksFromNormalizedCompareKey(title, CHUNK_OPTIONS);
    for (const chunk of representativeChunks) {
      const postings = chunkPostingMap.get(chunk) || [];
      postings.push(titleId);
      chunkPostingMap.set(chunk, postings);
    }
  });

  return {
    twoParentIndexReady: true,
    twoParentChunkLengths: [...CHUNK_OPTIONS.chunkLengths],
    chunkPostingMap,
  };
}

async function loadIndexState(indexManifestPath) {
  const manifest = JSON.parse(await fs.readFile(indexManifestPath, 'utf8'));
  const manifestDir = path.dirname(indexManifestPath);
  const chunkPostingMap = new Map();

  for (const bucketPath of Array.isArray(manifest.paths) ? manifest.paths : []) {
    const resolvedBucketPath = path.resolve(process.cwd(), bucketPath);
    const bucketJson = JSON.parse(await fs.readFile(
      resolvedBucketPath.startsWith(manifestDir) ? resolvedBucketPath : path.resolve(manifestDir, bucketPath),
      'utf8',
    ));
    if (Array.isArray(bucketJson?.rows)) {
      for (const row of bucketJson.rows) {
        if (!Array.isArray(row) || row.length < 2) {
          throw new Error(`bucket row 형식이 올바르지 않습니다. (${bucketPath})`);
        }
        chunkPostingMap.set(
          String(row[0] || '').trim(),
          decodePackedUint32DeltaBase64(row[1], 0),
        );
      }
      continue;
    }

    for (const [chunk, entry] of Object.entries(bucketJson?.entries || {})) {
      chunkPostingMap.set(
        chunk,
        decodePackedUint32DeltaBase64(entry?.data, entry?.count),
      );
    }
  }

  return {
    twoParentIndexReady: true,
    twoParentChunkLengths: Array.isArray(manifest.chunkLengths) ? manifest.chunkLengths : [3, 4],
    chunkPostingMap,
  };
}

async function runRealAttackRecall(indexState, attackSamplePath) {
  const sampleLines = (await fs.readFile(attackSamplePath, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => String(line || '').trim())
    .filter(Boolean);

  let hitCount = 0;
  const misses = [];
  for (const title of sampleLines) {
    if (hasNormalizedSemiconductorRefluxTwoParentMixTitle(title, indexState)) {
      hitCount += 1;
      continue;
    }
    misses.push(title);
  }

  return {
    totalCount: sampleLines.length,
    hitCount,
    misses,
    recallPercent: sampleLines.length > 0 ? (hitCount / sampleLines.length) * 100 : 0,
  };
}

function decodePackedUint32DeltaBase64(base64Value, expectedCount = 0) {
  const bytes = Uint8Array.from(Buffer.from(String(base64Value || '').trim(), 'base64'));
  if (bytes.byteLength % 4 !== 0) {
    throw new Error('packed postings byte 길이가 4의 배수가 아닙니다.');
  }

  const valueCount = bytes.byteLength / 4;
  if (expectedCount > 0 && valueCount !== expectedCount) {
    throw new Error(`packed postings count mismatch (${valueCount}/${expectedCount})`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Uint32Array(valueCount);
  let runningValue = 0;
  for (let index = 0; index < valueCount; index += 1) {
    runningValue += view.getUint32(index * 4, true);
    values[index] = runningValue;
  }
  return values;
}

main().catch((error) => {
  console.error('[verify-reflux-two-parent-matcher] 실패:', error.message);
  process.exitCode = 1;
});
