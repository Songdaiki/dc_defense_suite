// 유저가 실제 복사한 공격 텍스트의 코드포인트를 확인하고
// reflux-normalization.js 수정 전/후로 정규화 결과 비교

const pairs = [
  {
    orig: '베센트, 미토스는 능력 면에서 도약된 모델',
    atk:  '베ᅠ센ᅠ트,ᅠ미토스는 능력 면에서 도약된 모델',
  },
  {
    orig: '덕테이프)우리 다시 돌아갈수있을까?',
    atk:  '덕ᅠ테ᅠ이프)우리 다시ᅠ돌아갈수있을까?',
  },
  {
    orig: '클로드인 엑셀 쓰려면 오피스365 구독해야되네?',
    atk:  '클ᅠ로ᅠ드인ᅠ엑셀ᅠ쓰려면ᅠ오피스365ᅠ구독해야되네?',
  },
];

// 새 정규화 (현재 reflux-normalization.js)
import { buildRefluxSearchQuery, normalizeRefluxCompareKey } from '../features/reflux-normalization.js';

console.log('====================================');
console.log('  코드포인트 분석 + 정규화 테스트');
console.log('====================================\n');

for (const { orig, atk } of pairs) {
  console.log(`원본: "${orig}"`);
  console.log(`공격: "${atk}"`);

  // 공격본에서 비 한글 syllable, 비 ASCII 문자 찾기
  console.log('\n  공격본 특수 코드포인트:');
  for (const ch of [...atk]) {
    const cp = ch.codePointAt(0);
    // 한글 syllable(AC00-D7AF), 기본 ASCII(20-7E) 제외
    if (!(cp >= 0xAC00 && cp <= 0xD7AF) && !(cp >= 0x20 && cp <= 0x7E)) {
      console.log(`    U+${cp.toString(16).toUpperCase().padStart(4, '0')} = ${JSON.stringify(ch)}`);
    }
  }

  // 정규화 비교
  const origKey = normalizeRefluxCompareKey(orig);
  const atkKey = normalizeRefluxCompareKey(atk);
  const origQuery = buildRefluxSearchQuery(orig);
  const atkQuery = buildRefluxSearchQuery(atk);

  console.log(`\n  normalizeRefluxCompareKey:`);
  console.log(`    원본 → "${origKey}"`);
  console.log(`    공격 → "${atkKey}"`);
  console.log(`    매칭: ${origKey === atkKey ? '✅ 일치' : '❌ 불일치'}`);

  console.log(`\n  buildRefluxSearchQuery:`);
  console.log(`    원본 → "${origQuery}"`);
  console.log(`    공격 → "${atkQuery}"`);

  console.log('\n' + '─'.repeat(60) + '\n');
}
