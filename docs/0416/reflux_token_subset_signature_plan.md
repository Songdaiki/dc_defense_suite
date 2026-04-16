# 역류기 토큰 부분집합 signature 설계 문서

## 1. 목표

현재 역류기 dataset 방어는 크게 두 단계다.

1. exact normalized title match
2. 글자 순서무시 permutation signature match

이 두 단계는 아래 공격을 잘 못 잡는다.

- 공격자가 실제 dataset 제목 2개를 섞어서 새 제목 1개를 만든 경우
- 예:
  - 원본 A: `나노바나나는 업데이트한지 꽤됐지않나`
  - 원본 B: `쎈수학황이 hle 40퍼 찍고 왔는데 언제 hle 포화시키냐...`
  - 공격 제목: `꽤됐지않나 업데이트한지 나노바나나는 40퍼 포화시키냐... hle 쎈수학`

이 경우는:

- exact는 당연히 miss
- permutation도 한 개 원문 제목의 글자 집합이 아니므로 miss

그래서 이번 설계의 목표는:

- `datasetMatch = exact || permutation || tokenSubset`

로 만드는 것이다.

쉽게 말하면:

- 제목 전체가 안 맞아도
- dataset 안의 어떤 제목이 가진 “핵심 토큰 3개”가 들어 있으면
- 역류기 dataset hit로 본다.

중요:

- 이 기능은 `getSearch duplicate`를 대체하지 않는다.
- 역할은 `search 전에 local dataset에서 더 많이 잡기`다.
- 즉 네트워크 요청을 늘리는 기능이 아니라, 오히려 `search miss`를 줄이는 보조 기능이다.

---

## 2. 실제 코드 교차검증 결과

이 문서는 아래 실제 코드 기준으로 다시 확인한 뒤 작성했다.

### 2.1 현재 공용 역류기 매칭은 exact + permutation까지만 있다

공용 정규화:

- [features/reflux-normalization.js](/home/eorb915/projects/dc_defense_suite/features/reflux-normalization.js#L18)

현재 permutation helper:

- [features/reflux-normalization.js](/home/eorb915/projects/dc_defense_suite/features/reflux-normalization.js#L44)

공용 dataset loader / matcher:

- [features/post/semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L24)
- [features/post/semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L175)
- [features/post/semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L184)

현재 실제 동작:

1. `titleSet.has(normalizedValue)` exact 확인
2. miss면 `permutationSignatureSet.has(signature)` 확인
3. 둘 다 아니면 false

즉 “토큰 일부 조합이 같은가”는 아직 없다.

### 2.2 현재 최종 runtime dataset은 토큰 경계를 잃어버린다

현재 merge/build:

- [data/merge-reflux-datasets.mjs](/home/eorb915/projects/dc_defense_suite/data/merge-reflux-datasets.mjs#L241)
- [data/merge-reflux-datasets.mjs](/home/eorb915/projects/dc_defense_suite/data/merge-reflux-datasets.mjs#L271)

핵심:

- `dedupeNormalizedTitles(...)`에서 `normalizeSemiconductorRefluxTitle(title)`로 바로 저장한다.
- 이 normalize는 공백을 없앤 compare key를 만든다.

예:

- 원문: `나노바나나는 업데이트한지 꽤됐지않나`
- 최종 dataset 저장값: `나노바나나는업데이트한지꽤됐지않나`

문제:

- runtime dataset에는 이미 공백/토큰 경계가 없다.
- 따라서 **현재 `titles`만 보고 runtime에서 정확한 token subset signature를 새로 만드는 것은 어렵다.**

이건 이번 설계에서 제일 중요한 제약이다.

즉 토큰 subset signature는:

- runtime에서 기존 `titles[]`만 가지고 만들면 안 되고
- **merge/build 단계에서 raw title 기준으로 미리 계산해서 같이 배포**하는 쪽이 맞다.

### 2.3 게시글 쪽 호출부는 raw title을 갖고 있어서 토큰 subset 확장이 쉽다

게시글 scheduler:

- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L438)
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L447)

자동 공격 모드 판정:

- [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L148)
- [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L173)

현재 게시글 호출은 대부분 `post.subject` 원문을 넘긴다.

즉 게시글 쪽은:

- helper 구현만 raw-aware하게 바꾸면
- exact/permutation/tokenSubset 전부 한 함수에서 처리할 수 있다.

### 2.4 댓글 쪽 호출부는 지금 normalized helper를 바로 호출해서 그대로는 부족하다

댓글 dataset 경로:

- [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L98)

현재 동작:

1. `normalizeCommentRefluxMemo(memo)`
2. `hasNormalizedSemiconductorRefluxTitle(normalizedMemo)`

문제:

- `normalizedMemo`는 이미 공백이 날아간 값이다.
- token subset은 raw token 경계가 필요하다.

즉 댓글 쪽은 이번 패치에서:

- raw memo를 받는 공용 matcher를 새로 쓰거나
- `hasCommentRefluxMemo(memo)` 내부를 raw-aware 경로로 바꿔야 한다.

그냥 지금 helper에 dataset만 추가하면 댓글은 token subset을 못 탄다.

### 2.5 comments도 같은 공용 dataset을 쓰므로, 한 번만 설계하면 둘 다 탄다

댓글 dataset 로더:

- [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L21)
- [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L41)

실제 구조:

- 댓글 전용 dataset은 버렸고
- 공용 [reflux-title-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.json) 만 본다.

즉 token subset도:

- 공용 manifest/shard에만 추가하면
- 게시글/댓글 둘 다 같은 source-of-truth를 공유할 수 있다.

---

## 3. 실제 공격 예시 분석

아래는 지금 dataset 안에 실제로 있는 제목 조각들이다.

### 3.1 예시 1

공격 제목:

- `꽤됐지않나 업데이트한지 나노바나나는 40퍼 포화시키냐... hle 쎈수학`

실제 dataset 조각:

- `나노바나나는 업데이트한지 꽤됐지않나`
  - [reflux-title-set-unified.part01.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part01.json#L508806)
- `쎈수학황이 hle 40퍼 찍고 왔는데 언제 hle 포화시키냐...`
  - [reflux-title-set-unified.part02.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part02.json#L232989)

의미:

- 이건 제목 1개를 순서만 바꾼 게 아니다.
- 제목 A의 핵심 토큰 3개 + 제목 B의 핵심 토큰 3개를 붙인 것이다.

### 3.2 예시 2

공격 제목:

- `3.1 소설 이야 더 띠부럴 잘쓰네 띵킹 성능이 3.1 미쳤네 대비`

실제 dataset 조각:

- `3.1 띵킹 대비 성능이 미쳤네`
  - [reflux-title-set-unified.part01.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part01.json#L130545)
- `이야 띠부럴 3.1 소설 더 잘쓰네`
  - [reflux-title-set-unified.part02.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part02.json#L684565)

### 3.3 예시 3

공격 제목:

- `svg 같은데 오 괜찮은거 없는데? 게 소설 으로 달라진 3.1 써봤는데`

실제 dataset 조각:

- `3.1 으로 소설 써봤는데 달라진 게 없는데?`
  - [reflux-title-set-unified.part01.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part01.json#L130616)
- `오 svg 괜찮은거 같은데`
  - [reflux-title-set-unified.part02.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part02.json#L461342)

### 3.4 예시 4

공격 제목:

- `한번씩만 투표 해보자.vote 다들 시키지마라.. 제발 너프만`

실제 dataset 조각:

- `다들 투표 한번씩만 해보자.vote`
  - [reflux-title-set-unified.part01.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part01.json#L650402)
- `제발 너프만 시키지마라..`
  - [reflux-title-set-unified.part02.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.part02.json#L805742)

정리:

- 지금 공격 패턴은 `순열형`만이 아니다.
- 실제 제목 여러 개의 핵심 토큰들을 섞는 `splice형`이 크다.
- 따라서 다음 단계는 fuzzy edit distance보다 `토큰 부분집합 signature`가 더 맞다.

---

## 4. 최종 설계 방향

## 4.1 전체 판정 순서

최종 로컬 dataset 판정은 아래 순서를 권장한다.

1. exact normalized title match
2. permutation signature match
3. token subset signature match

즉:

```txt
localDatasetHit = exact || permutation || tokenSubset
```

그 다음:

- local hit면 즉시 역류기 판정
- local miss일 때만 현재처럼 `getSearch duplicate`를 탄다

이 순서의 장점:

- 네트워크 요청 증가 없음
- 기존 빠른 Set lookup 구조 유지
- search duplicate miss 수를 줄일 수 있음

### 4.2 token subset은 merge/build 단계에서 미리 만든다

이유는 간단하다.

- 최종 runtime `titles[]`는 공백이 사라진 compare key다.
- 거기서는 `3.1`, `소설`, `띵킹`, `대비` 같은 토큰 경계가 안전하게 복구되지 않는다.

그래서 설계는 아래가 맞다.

1. source JSON의 raw title를 merge script가 읽는다
2. raw title 기준으로 token subset signature를 만든다
3. signature 전용 shard를 같이 출력한다
4. runtime loader는 그 shard를 읽어서 Set으로 적재한다

즉:

- exact/permutation은 기존 `titles` shard
- token subset은 신규 `tokenSubset` shard

두 갈래로 간다.

### 4.3 토큰화 규칙

토큰화는 `shared normalization helper`에서 공용으로 제공한다.

추가 후보 파일:

- [features/reflux-normalization.js](/home/eorb915/projects/dc_defense_suite/features/reflux-normalization.js)

권장 규칙:

1. `String(value).normalize('NFKC')`
2. 기존 invisible / filler / emoji / combining 제거 규칙 재사용
3. lower-case
4. `/[\\p{L}\\p{N}.]+/gu` 로 token 추출
5. 길이 2 미만 token 제거
6. 동일 token은 순서 유지 dedupe

예:

- 입력:
  - `특ᅠ이ᅠ점ᅠ미니갤러리ᅠ이주했으면ᅠㅈ망했음`
- 토큰:
  - `특이점`
  - `미니갤러리`
  - `이주했으면`
  - `ㅈ망했음`

예:

- 입력:
  - `다들 투표 한번씩만 해보자.vote`
- 토큰:
  - `다들`
  - `투표`
  - `한번씩만`
  - `해보자.vote`

즉 filler 우회는 여기서 같이 제거된다.

### 4.4 informative token 선별 규칙

모든 token을 다 쓰면 generic token이 많아져 오탐이 커진다.

예:

- `솔직히`
- `무슨`
- `다들`
- `그냥`
- `의견`

이런 token은 어디에나 많다.

그래서 token subset은 “정보량 높은 token” 위주로 뽑아야 한다.

권장 규칙:

1. hard stop token 제거
2. 남은 token에 score 부여
3. 상위 4개까지만 선택

초기 hard stop token 예시:

- `근데`
- `그냥`
- `진짜`
- `솔직히`
- `이거`
- `이건`
- `이런거`
- `같은데`
- `다들`
- `의견`

초기 score 예시:

- 기본점수 = token 길이
- 숫자 포함 +8
- 라틴 포함 +6
- 한글/숫자 또는 라틴/숫자 혼합 +4

예:

- `3.1프로`는 점수가 높다
- `gpt불매`는 점수가 높다
- `다들`은 stop token이면 제거된다

이 단계는 exact 규칙이 아니라 “대표 token 선택용”이다.

### 4.5 signature 생성 규칙

#### 4.5.1 왜 “top4 choose3 전부”는 바로 넣기 부담스러운가

로컬 샘플 30만 건 기준 대략:

- token 3개 이상 title 비율: `0.8978`
- `top4 choose3` 조합 평균: `3.0097개 / title`

이걸 현재 전체 title 수 `2,547,451`에 그대로 적용하면:

- 대략 `7.6M` 수준 signature가 생긴다

이건 JS `Set<string>`로 바로 들고 가기엔 다소 무거운 편이다.

#### 4.5.2 권장안: 대표 1개 + 보강 1개

1차 권장안:

- title당 최대 2개 signature만 만든다.

규칙:

1. informative token 상위 4개를 뽑는다
2. token 3개 미만이면 signature 없음
3. 대표 signature:
   - 상위 3개 token
4. 보강 signature:
   - token이 4개 이상이면 `가장 강한 token`을 뺀 나머지 3개

쉽게 예시:

- 선택 token:
  - `쎈수학황이`
  - `hle`
  - `40퍼`
  - `포화시키냐`

대표 signature:

- `쎈수학황이`
- `hle`
- `40퍼`

보강 signature:

- `hle`
- `40퍼`
- `포화시키냐`

이 보강 signature가 필요한 이유:

- 공격자는 가장 독한 1토큰만 깨거나 줄여서 우회할 수 있다.
- 위 예시에서는 `쎈수학황이 -> 쎈수학`처럼 바꿔도
- `hle + 40퍼 + 포화시키냐` 3개는 그대로 남을 수 있다.

샘플 30만 건 기준 이 설계의 대략 규모:

- 대표 signature 대상 비율: `0.8978`
- 보강 signature 대상 비율: `0.7039`
- 평균 signature 수: `1.6018개 / title`
- 전체 title 환산 추정: 약 `4.08M`

즉 `top4 choose3 전부`보다 훨씬 가볍고,
대표 1개만 두는 것보다 recall이 좋다.

#### 4.5.3 signature 문자열 형식

권장 형식:

- `ts1:<subsetSize>:<totalChars>:<hash>`

예:

- `ts1:3:12:4f8d2a...`

설명:

- `ts1`: token subset algorithm v1
- `subsetSize`: 지금은 3 고정
- `totalChars`: 짧은 조합 오탐 방지용
- `hash`: 정렬된 token triplet의 FNV-1a 64bit 해시

token 순서는 공격자가 바꿀 수 있으므로:

- combo 안에서는 token을 정렬한 뒤 hash한다.

즉:

- `3.1 | 띵킹 | 대비`
- `대비 | 3.1 | 띵킹`

은 같은 signature가 된다.

### 4.6 merge/build 산출물 구조

현재 manifest:

- [reflux-title-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.json)

권장 확장안:

```json
{
  "version": "2026-04-16-v1",
  "updatedAt": "...",
  "sourceGalleryIds": ["thesingularity", "tsmcsamsungskhynix"],
  "titleCount": 2547451,
  "shards": [
    { "path": "data/reflux-title-set-unified.part01.json", "titleCount": 913617 }
  ],
  "tokenSubset": {
    "algorithm": "triplet_primary_recovery_v1",
    "signatureCount": 4080422,
    "shards": [
      { "path": "data/reflux-token-subset-signatures.part01.json", "signatureCount": 1200000 }
    ]
  }
}
```

signature shard 형식 예시:

```json
{
  "signatures": [
    "ts1:3:12:4f8d2a...",
    "ts1:3:11:7ab013..."
  ]
}
```

중요:

- `titles` shard와 `tokenSubset` shard는 분리한다.
- 그래야 기존 exact/permutation 구조를 안 깨고 확장할 수 있다.
- algorithm version도 manifest에 남겨야 나중에 규칙을 바꿔도 역호환 처리가 쉽다.

### 4.7 runtime loader 변경 방향

핵심 수정 파일:

- [features/post/semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js)

추가 runtime state:

- `tokenSubsetSignatureSet`
- `tokenSubsetSignatureCount`
- `tokenSubsetAlgorithm`

load 흐름:

1. 기존 manifest/shard로 `titles` 로드
2. 기존처럼 `titleSet`, `permutationSignatureSet` 구성
3. manifest에 `tokenSubset`가 있으면 signature shard도 로드
4. `tokenSubsetSignatureSet` 구성

주의:

- 기존 dataset에 `tokenSubset`가 없을 수 있으므로
- 1차 로더는 “없으면 비활성”으로 처리하는 게 배포 전환에 안전하다.

즉:

- `tokenSubset ready = manifest.tokenSubset 존재 && shard 로드 성공`
- 아니면 기존 exact/permutation만 유지

### 4.8 공용 matcher 인터페이스 변경 방향

현재 구조상 `hasNormalizedSemiconductorRefluxTitle(normalizedText)`는
token subset에 적합하지 않다.

이유:

- normalizedText에는 token 경계가 없다.

그래서 권장 구조는 아래다.

#### 4.8.1 raw-aware public matcher

새 공용 함수 예시:

- `matchSemiconductorRefluxText(text)`

반환값 예시:

```js
{
  matched: true,
  reason: 'token_subset'
}
```

또는 최소형:

- `hasSemiconductorRefluxText(text)`

내부 순서:

1. raw text -> exact
2. raw text -> permutation
3. raw text -> token subset

#### 4.8.2 normalized helper는 exact/permutation 전용으로 남긴다

기존 함수:

- `hasNormalizedSemiconductorRefluxTitle(...)`

이 함수는:

- 이미 경계가 사라진 문자열만 받으므로
- exact/permutation까지만 책임지게 두는 편이 맞다.

즉:

- post / comment / monitor의 일반 호출부는 raw-aware helper
- internal exact-only 경로는 normalized helper

이렇게 역할을 나눈다.

### 4.9 게시글/댓글 호출부 연결 방식

#### 4.9.1 게시글

게시글은 이미 raw title을 들고 있다.

영향 파일:

- [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js)
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js)

변경 포인트:

- `matchesSemiconductorRefluxTitle(post.subject)`가 이제 token subset까지 포함하게만 하면 된다.

즉 게시글 쪽은 큰 구조 변경이 필요 없다.

#### 4.9.2 댓글

댓글은 현재 normalized helper를 바로 부른다.

영향 파일:

- [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L98)

권장 변경:

- `hasCommentRefluxMemo(memo)`가 raw `memo`를 공용 raw-aware matcher에 넘기게 바꾼다.

예:

```js
function hasCommentRefluxMemo(memo) {
  return hasSemiconductorRefluxText(memo);
}
```

이렇게 해야 댓글도 token subset을 탄다.

### 4.10 search duplicate와의 관계

이 기능은 `getSearch`를 대체하지 않는다.

최종 권장 흐름:

1. exact hit
2. permutation hit
3. token subset hit
4. 여기까지 miss면 search duplicate

쉽게 예시:

- `3.1 소설 이야 더 띠부럴 잘쓰네 띵킹 성능이 3.1 미쳤네 대비`
  - token subset에서 이미 hit
  - `getSearch` 안 침

- `최근에 막 올라온 완전 새 제목`
  - local dataset 3단계 모두 miss
  - 그때만 `getSearch` queue로 감

즉 token subset은 `search 이전 local 확장 레이어`다.

---

## 5. 구현 단계 제안

### 5.1 1차 구현 범위

1. `features/reflux-normalization.js`
   - tokenization / scoring / subset signature helper 추가
2. `data/merge-reflux-datasets.mjs`
   - raw title 기반 token subset signature 생성
   - manifest `tokenSubset` 섹션 추가
   - signature shard 출력
3. `features/post/semiconductor-reflux-title-set.js`
   - token subset shard 로드
   - raw-aware matcher 추가
4. `features/comment/comment-reflux-dataset.js`
   - raw-aware matcher 사용으로 전환

1차에서는 여기까지면 충분하다.

이 단계만으로:

- 게시글 dataset match
- 댓글 dataset match

둘 다 token subset을 쓴다.

### 5.2 2차 확장 후보

1차 이후 부족하면 검토할 것:

1. hard stop token list 조정
2. score weight 조정
3. 보강 signature 규칙 변경
4. comment search duplicate와 결합해 “token subset miss만 search” 최적화

지금 단계에서는 fuzzy edit distance까지 넣지 않는 게 맞다.

---

## 6. 왜 fuzzy 규칙보다 이게 먼저인가

`토큰 겹침률`, `편집거리`, `추가/삭제 허용 fuzzy`는 좋아 보이지만
현재 구조에는 비용이 더 크다.

이유:

1. dataset가 250만 건 이상이라 full fuzzy 비교는 무겁다
2. 오탐 설명이 어렵다
3. 댓글/게시글 양쪽에서 같은 규칙을 재현하기가 까다롭다

반대로 token subset signature는:

1. build-time에 미리 압축 가능
2. runtime은 Set lookup이라 빠름
3. 왜 잡혔는지 설명하기 쉽다

예:

- `3.1 + 띵킹 + 대비`가 dataset signature에 있음
- 그래서 역류기 hit

이건 운영 판단도 쉽다.

---

## 7. 정적 검증 체크리스트

아래 체크가 모두 맞아야 “문서대로 구현해도 구조가 안 꼬인다”고 볼 수 있다.

1. merge script가 raw title를 본 뒤 exact/permutation용 normalized title와 token subset signature를 각각 분리 생성하는가
2. runtime에서 token subset을 기존 `titles[]`로부터 역산하려 하지 않는가
3. manifest에 `tokenSubset.algorithm`이 있어 규칙 버전이 드러나는가
4. manifest에 `tokenSubset.signatureCount`가 있어 로드 검증이 가능한가
5. shard 파일명이 `title shard`와 혼동되지 않게 분리되는가
6. loader가 token subset shard 부재 시 exact/permutation만으로 계속 동작하는가
7. token subset shard 로드 실패가 기존 exact/permutation readiness를 망치지 않는가
8. public matcher가 raw text를 받아 token subset까지 처리하는가
9. normalized helper는 exact/permutation 전용으로만 쓰이게 역할이 분리되는가
10. 게시글 attack mode decision이 raw-aware matcher를 타는가
11. 게시글 scheduler dataset 필터가 raw-aware matcher를 타는가
12. 댓글 dataset helper가 raw memo를 raw-aware matcher로 넘기는가
13. comment monitor도 결국 같은 댓글 dataset helper를 타는가
14. invisible filler 제거 규칙이 exact/permutation/token subset에서 일관적인가
15. `3.1`, `5.4`, `gpt-4.2` 같은 버전 token이 토큰화에서 망가지지 않는가
16. `해보자.vote` 같은 token이 split 과정에서 쓸모없이 두 동강 나지 않는가
17. hard stop token이 너무 많아서 의미 있는 제목도 token 3개 미만으로 떨어지지 않는가
18. hard stop token이 너무 적어서 `솔직히/근데/다들` 같은 generic token 조합으로 오탐이 늘지 않는가
19. token 순서를 바꿔도 같은 signature가 나오도록 combo 내부 정렬이 들어가는가
20. 대표 signature와 보강 signature가 동일하면 dedupe되는가
21. title당 signature 수가 최대 2개로 제한되는가
22. loader 상태에 `tokenSubsetSignatureCount`가 노출되어 진단이 쉬운가
23. 기존 permutation 로직이 token subset 추가로 깨지지 않는가
24. search duplicate miss-only 경로가 token subset 추가 때문에 역으로 더 많이 호출되지 않는가
25. 기존 dataset version 규칙처럼 token subset 내용 변경 시 version도 같이 올라가게 merge script 주석/문서가 남는가
26. 댓글에서 raw memo를 바로 써도 기존 exact/permutation 결과와 불일치가 나지 않는가
27. 공백만 다른 입력, filler만 낀 입력, 이모지만 낀 입력이 token subset에서 일관되게 정리되는가
28. 한 제목이 아니라 두 제목 splice 공격 예시에서 실제로 최소 한 원본 title signature가 살아남는지 확인했는가
29. generic 잡문 제목은 token subset signature가 안 생기거나 약하게 생기도록 totalChars/minToken rules가 있는가
30. search duplicate와 dataset token subset이 서로 다른 이유로 positive가 나와도 삭제/차단 흐름이 충돌하지 않는가

---

## 8. 최종 권장 결론

이번 건은 이렇게 가는 게 맞다.

1. **token subset은 runtime 즉석 생성이 아니라 merge/build 선계산**
2. **title당 최대 2개 signature**
   - 대표 1개
   - 보강 1개
3. **posts/comments 둘 다 raw-aware 공용 matcher로 통일**
4. **search duplicate는 그대로 miss-only fallback 유지**

쉽게 한 줄로 정리하면:

- `전체문장 동일`은 exact
- `글자 순서 바꿈`은 permutation
- `실제 제목 조각 섞기`는 token subset
- `dataset에도 아직 없는 최신글`은 getSearch

이 4단 구성이 현재 공격 패턴에 가장 맞다.
