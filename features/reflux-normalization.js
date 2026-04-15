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

export {
  buildRefluxSearchQuery,
  normalizeRefluxCompareKey,
};
