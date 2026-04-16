# 게시글 2-Parent Mix Detector 구현 문서

> 작성일: 2026-04-17  
> 기준 코드: `main` HEAD (`4954fce`)  
> 기준 dataset: `data/reflux-title-set-unified.json` (`version = 2026-04-16-222009`, `titleCount = 2,503,996`, `shards = 3`)  
> 대상 범위: 게시글 분류 + 게시글 자동 감시의 역류기 제목 판정  
> 제외 범위: 댓글/댓글감시 공용 matcher, weighted/score 계열 로직

## 0. 한 줄 결론

현재 역류기 제목 필터는 `제목 1개` 기준의 `exact + permutation + containment`만 본다.  
그래서 `A 제목 일부 + B 제목 일부`를 섞은 게시글은 구조적으로 놓칠 수 있다.

이번 문서의 최종 결론은 아래다.

1. `2-parent mix`는 기존 containment 완화로 넣지 않는다.
2. `게시글 전용 4번째 분기`로 따로 넣는다.
3. 댓글/댓글감시는 같은 공용 matcher를 타므로 기존 공용 `title-set` matcher는 직접 건드리지 않는다.
4. 구현은 `게시글 전용 matcher 모듈` + `오프라인 2-parent index artifact` 조합으로 간다.
5. 기본안은 `한글 3자 / 영어 4자`, `dataset 대표조각 길이 3/4`, `anchor = 앞/중간/뒤`다.
6. 이번 재검토에서 발견한 연결 리스크까지 반영하면, 현재 기준으로는 `설계상 blocking issue는 없다`. 남은 것은 구현 후 recall/오탐/산출물 크기 검증이다.

실제 공격셋([docs/실제공격.md](../실제공격.md)) 기준 추천 기본안 recall:

- `243 / 254 = 95.67%`

더 공격적으로 올리면:

- `길이 3/4/5`, `anchor = 앞/중간/뒤`: `248 / 254 = 97.64%`
- `길이 3/4/5/6`, `anchor = 앞/사분위/중간/사분위/뒤`: `250 / 254 = 98.43%`

즉 사용자가 요구한 `90% 이상`은 기본안으로도 넘긴다.

## 1. 실제 코드 교차검증 결과

이 문서는 아래 실제 코드와 라인 기준으로 다시 대조했다.

- 공용 제목 matcher:
  - [features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js)
- containment 규칙:
  - [features/reflux-normalization.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-normalization.js)
- 게시글 분류:
  - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js)
- 자동 감시:
  - [features/monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js)
- 댓글 공용 dataset 래퍼:
  - [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js)
- 댓글 memo 정규화:
  - [features/comment/parser.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/parser.js)
- background 복원:
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js)
- dataset merge 스크립트:
  - [data/merge-reflux-datasets.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/data/merge-reflux-datasets.mjs)

### 1.1 공용 제목 matcher의 현재 범위

[features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js) 기준:

- `hasSemiconductorRefluxTitle()` L192-L199
- `hasNormalizedSemiconductorRefluxTitle()` L201-L225
- 내부 분기:
  - exact: L207-L209
  - permutation: L213-L223
  - containment: L218, L225

즉 현재는 `single-title 3분기`만 있다.

### 1.2 containment가 왜 2-parent를 못 잡는지

[features/reflux-normalization.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-normalization.js) 기준:

- containment 최소 제목 길이: L79 `minLength = 12`
- chunk 최소 길이: L80-L82
  - 기본 4
  - 영문 5
  - 한글 4
- anchor 위치: L116-L121
  - 앞 / 1/4 / 중간 / 뒤
- 조합 제한: L133-L143
  - anchor가 4개 이상이면 사실상 `앞 + 뒤 + 중간 1개`만 인정

쉽게 말하면:

- 현재 containment는 `원문 제목 1개`의 앞/중간/뒤 흔적이 같이 남아 있느냐를 보는 규칙이다.
- `A 절반 + B 절반`은 애초에 질문 자체가 다르다.

예:

- 원문 A: `시바 드디어 지피티 플러스 0원구독 끝나네`
- 원문 B: `대기업 때려치고 창업한다`
- 공격 제목: `시바 끝나네 드디어 플러스 지피티 0원구독 창업한다 때려치고 대기업`

이 제목은 A의 앞/중간/뒤 1세트도 아니고, B의 앞/중간/뒤 1세트도 아니다.  
그래서 single-title containment만으로는 구조적으로 약하다.

### 1.3 게시글 분류 호출부

[features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js) 기준:

- `start()` L93에서 현재는 무조건 `ensureSemiconductorRefluxTitleSetLoaded()`
- `transitionManualAttackModeWhileRunning()` L273도 무조건 preload
- `transitionManualRefluxConfigWhileRunning()` L324도 preload
- `loadState()` L596도 preload
- 실제 게시글 후보 필터:
  - `filterRefluxCandidatePosts()` L760-L826
  - local dataset match: L779-L783
  - search cache / queue: L785-L820
- 일반 분기 `isEligibleForAttackMode(...)` 주입:
  - L453-L456

중요한 점:

- `hasSemiconductorRefluxTitle(title)`는 `동기 boolean`으로 바로 쓰인다.
- `filterRefluxCandidatePosts()` 안에서는 게시물마다 바로 호출된다.
- 그래서 새 matcher도 결국 `동기 boolean 함수`를 유지해야 한다.

### 1.4 monitor 호출부

[features/monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js) 기준:

- `start()` L108에서 현재는 무조건 title-set preload
- `loadState()` L1064도 무조건 title-set preload
- initial sweep:
  - L454, L471
- attack mode 샘플 판정:
  - L497-L552
- cheap 판정:
  - L555-L596
- buildInitialSweepPosts:
  - L1207-L1216

중요한 점:

1. `buildAttackModeDecision(...)`에 넘기는 matcher는 동기 boolean이다.  
   - [features/post/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/attack-mode.js) L161-L183
2. `buildCheapAttackModeDecision()`는 async search가 아니라 `peek`만 본다.  
   - [features/monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js) L582-L587
3. 즉 local matcher가 sync로 안정적으로 살아 있어야 cheap path도 안 깨진다.

### 1.5 댓글 경로는 공용 matcher를 공유한다

[features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js) 기준:

- `hasCommentRefluxMemo()` L98-L109
- 내부에서 `hasNormalizedSemiconductorRefluxTitle(normalizedMemo)`를 직접 호출

그리고 댓글 정규화는 제목과 다르다.

- [features/comment/parser.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/parser.js) L96-L135

따라서 `2-parent mix`를 공용 `hasNormalizedSemiconductorRefluxTitle()`에 넣으면 댓글 삭제/댓글 감시까지 같이 변한다.  
이번 작업 범위가 아니다.

### 1.6 background 복원 구조도 고려해야 한다

[background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js) 기준:

- `resumeAllSchedulers()` L191-L285
- `loadSchedulerStateIfIdle()` L1344-L1350

핵심:

- background가 뜨면 `idle scheduler도 loadState()`를 먼저 돈다.
- 즉 `loadState()` 안에 무거운 preload를 무조건 넣으면, 사용자가 아직 그 기능을 켜지 않았어도 서비스워커 복원이 느려진다.

이건 이번 문서에서 반드시 막아야 하는 연결 리스크다.

## 2. 왜 공용 matcher 직접 수정이 아니라 게시글 전용 matcher 추가인가

핵심 결정:

- 유지:
  - `hasNormalizedSemiconductorRefluxTitle()` = 기존 single-title matcher 유지
  - 댓글/댓글감시 = 그대로 유지
- 추가:
  - `hasSemiconductorRefluxPostTitle()` = 게시글 전용 `single-title + 2-parent mix`

이 구조가 맞는 이유:

1. 실제 호출자가 다르다.
2. 댓글 memo는 제목보다 길고 구조가 다르다.
3. 게시글만 2-parent를 원한다.
4. 기존 댓글 방어 회귀를 피할 수 있다.
5. 현재 공용 matcher status/sourceType를 바꾸면 댓글 공용 dataset 래퍼도 같이 흔들린다.

## 3. 프로토타입 검증 결과

검증 대상:

- 공격셋: [docs/실제공격.md](../실제공격.md)
- 총 254줄
- dataset: `data/reflux-title-set-unified.json`
- dataset version: `2026-04-16-222009`

### 3.1 레퍼런스 프로토타입

의미:

- query side: split 후 모든 substring chunk 사용
- dataset side: 모든 substring chunk 사용
- 규칙:
  - 좌/우 서로 다른 parent
  - 각 side `2개 이상` chunk hit
  - opposite side leak `1개 이하`
  - df threshold `400`

결과:

- `252 / 254 = 99.21%`

이 수치는 `아이디어 자체는 맞다`는 검증이다.  
다만 이 방식은 전역 index 규모가 너무 커서 그대로 runtime에 넣기엔 비현실적이다.

### 3.2 index 규모 샘플

10만 제목 샘플(`reflux-title-set-unified.part01.json` 앞 100,000개) 기준:

#### 전역 substring 전체 사용

- 평균 chunk 수/title: `52.75`
- unique chunk 수: `3,227,758`

이건 full dataset 전역 index로 가기엔 너무 크다.

#### 대표조각 압축안 1: `앞/중간/뒤`, 길이 `3/4`

- 평균 representative chunk 수/title: `5.74`
- unique representative chunk 수: `252,907`
- 공격셋 hit: `243 / 254 = 95.67%`

#### 대표조각 압축안 2: `앞/중간/뒤`, 길이 `3/4/5`

- 평균 representative chunk 수/title: `8.72`
- unique representative chunk 수: `462,142`
- 공격셋 hit: `248 / 254 = 97.64%`

#### 대표조각 압축안 3: `앞/사분위/중간/사분위/뒤`, 길이 `3/4/5/6`

- 평균 representative chunk 수/title: `19.24`
- unique representative chunk 수: `1,232,840`
- 공격셋 hit: `250 / 254 = 98.43%`

### 3.3 이번 문서의 기본안

기본 구현안은 아래로 고정한다.

- dataset representative chunk:
  - anchor = `앞 / 중간 / 뒤`
  - 길이 = `3 / 4`
- query split side:
  - 모든 substring chunk
  - 길이 = `3 / 4`
- min rule:
  - 한글 chunk 최소 `3`
  - 영문 포함 chunk 최소 `4`
- df threshold = `400`

이유:

1. 사용자가 요구한 `한글 3 / 영어 4 조각단위`와 정확히 맞는다.
2. 공격셋에서 이미 `95.67%`가 나온다.
3. 대표조각 수가 가장 작아서 index artifact가 가장 현실적이다.
4. 댓글/게시글 공용 matcher를 건드리지 않고도 게시글 쪽 local 4번째 분기를 구현할 수 있다.

## 4. 이번 재검토에서 문서에 추가 반영한 핵심 리스크

이 섹션이 이번 2차 문서화의 핵심이다.  
처음 아이디어만 보면 맞아 보이는데, 실제 호출 라인을 따라가면 여기서 설계가 자주 깨진다.

### 4.1 `sync boolean matcher`라서 첫 조회 lazy fetch는 안 된다

현재 호출부는 새 matcher를 전부 이런 식으로 쓴다.

- `Array.filter((post) => matches(post.subject))`
- `if (hasSemiconductorRefluxTitle(title)) { ... }`
- `buildAttackModeDecision(..., { matchesSemiconductorRefluxTitle })`

즉 `hasSemiconductorRefluxPostTitle()`는 `즉시 true/false`를 반환해야 한다.

이 말은 곧:

- `hasTitle()` 안에서 `await fetch(bucket)`를 할 수 없다.
- “처음 이 chunk가 나오면 그 bucket만 lazy load” 설계는 현재 호출 그래프와 충돌한다.

예:

- `filterRefluxCandidatePosts()`는 게시물마다 `if (hasSemiconductorRefluxTitle(title))`를 바로 탄다.
- 여기서 bucket fetch가 필요하면 함수 시그니처 자체가 async로 바뀌어야 한다.
- 그러면 post scheduler / monitor / attack-mode core 호출부가 연쇄적으로 다 바뀐다.

결론:

- `v1`에서는 `ensure...Loaded()` 단계에서 2-parent index 전체를 미리 메모리에 올린다.
- bucket 파일은 `배포/파일분할 목적`으로 유지한다.
- runtime `hasTitle()`는 메모리 안 자료만 읽는 순수 sync 함수로 고정한다.

### 4.2 preload는 “어디서나”가 아니라 “필요한 경로만” 해야 한다

이 부분을 잘못 넣으면 기능은 맞아도 서비스워커 복원이 느려진다.

#### 게시글 scheduler 쪽 규칙

[features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js) 기준:

- `start()` L93
- `transitionManualAttackModeWhileRunning()` L273
- `transitionManualRefluxConfigWhileRunning()` L324
- `loadState()` L596

최종 규칙:

1. `start()`는 `attackMode === SEMICONDUCTOR_REFLUX`일 때만 post matcher preload
2. `transitionManualAttackModeWhileRunning()`도 `nextAttackMode === SEMICONDUCTOR_REFLUX`일 때만 preload
3. `transitionManualRefluxConfigWhileRunning()`은 현재 reflux 모드만 타므로 preload 유지
4. `loadState()`는 `this.isRunning && this.currentAttackMode === SEMICONDUCTOR_REFLUX`일 때만 preload
5. default / cjk / page1_no_cutoff 수동 실행에는 2-parent preload를 하지 않는다

이유:

- 현재 `assertManualAttackModeReady()` L645-L653은 사실상 no-op다.
- 즉 preload/gating을 이 helper에 기대면 안 된다.
- start/loadState 쪽에서 명시적으로 처리해야 한다.

#### monitor 쪽 규칙

[features/monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js) 기준:

- `start()` L108
- `loadState()` L1064

최종 규칙:

1. `monitor.start()`는 post matcher preload를 한다
2. `monitor.loadState()`는 `this.isRunning === true`일 때만 preload 한다
3. idle monitor `loadState()`에서는 preload 하지 않는다

이유:

- monitor는 실행 중이면 normal 상태에서도 attack mode sample 판정을 곧 해야 한다
- 하지만 background 복원 시 idle scheduler도 `loadState()`가 호출되므로, idle 상태까지 무거운 preload를 하면 안 된다

### 4.3 `ready`는 “2-parent index 준비 완료”가 아니라 “게시글 reflux local matcher 사용 가능”이어야 한다

[features/post/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/attack-mode.js) L164-L176, L190-L208 기준:

- `isSemiconductorRefluxDatasetReady`가 false면 attack-mode core는 refluxLikeCount를 0으로 친다
- 즉 `ready`를 너무 빡세게 잡으면, 2-parent index만 빠져도 single-title local match까지 같이 꺼진다

이건 안 된다.

예:

1. title-set bundled 로드는 성공
2. 2-parent index 파일 하나만 누락
3. `ready=false`로 잡아버림
4. monitor의 `buildAttackModeDecision()`은 sample 5개를 보고도 refluxLikeCount를 0으로 계산
5. 실제로는 single-title exact/permutation/containment가 가능한데도 공격 판정이 약해진다

그래서 status는 아래처럼 분리한다.

```javascript
{
  ready: true,                  // title-set 기반 local matcher는 쓸 수 있음
  titleSetReady: true,
  twoParentIndexReady: false,   // 2-parent만 꺼짐
  twoParentIndexVersionMatch: false
}
```

최종 규칙:

- `isSemiconductorRefluxPostTitleMatcherReady()`는 `titleSetReady`와 같은 의미로 둔다
- 2-parent index 준비 여부는 별도 field로만 노출한다
- index 누락/버전 불일치 시에도 single-title local matcher는 살아 있어야 한다

### 4.4 2-parent branch는 `bundled + matching version`일 때만 켠다

[features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js) 기준:

- status에 `version`, `sourceType`가 있다
  - L173-L185
- storage/manual dataset 주입 경로도 존재한다
  - `replaceSemiconductorRefluxTitleSet()` L228-L243

그래서 2-parent branch 활성 조건은 아래로 고정한다.

1. title-set status의 `sourceType === 'bundled'`
2. title-set status의 `version === twoParentIndex.datasetVersion`
3. 필요하면 `titleCount`도 일치 확인

예:

- 관리자가 storage에 수동 dataset 50개를 넣은 상태
- 기존 single-title matcher는 그 50개로 동작 가능
- 하지만 2-parent index는 bundled 250만 제목 기준 artifact

이 상태에서 2-parent까지 켜면 parent ID 의미가 꼬인다.  
그래서 이 경우는 `single-title only`로 강등해야 맞다.

### 4.5 로더는 `loadingPromise + atomic swap + 제한된 동시성`이 필요하다

필수 규칙:

1. 모듈 레벨 `loadingPromise`로 중복 preload 방지
2. manifest/bucket을 임시 객체에 다 읽은 뒤 성공 시점에만 runtimeState 교체
3. bucket 64개를 한 번에 `Promise.all(64)`로 읽지 말고 제한된 동시성으로 읽기
4. `getStatus()` 안에서는 preload/decode를 절대 하지 않기

이유:

- post.start / monitor.start / resume 경로가 겹치면 같은 무거운 preload가 중복될 수 있다
- 중간 bucket 하나가 실패했는데 반쯤 채운 Map을 runtimeState에 넣으면 sync matcher가 불안정해진다
- 한 번에 다 읽으면 메모리 피크가 커진다
- popup은 [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js) L388-L393에서 `refreshAllStatuses()`를 1초마다 호출하고, [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js) L330-L337은 그때 모든 scheduler `getStatus()`를 바로 반환한다
- 그래서 matcher 상태 표시를 넣더라도 `getStatus()`는 이미 메모리에 있는 숫자/flag만 읽는 순수 getter여야 한다

권장:

- 동시성 `4` 또는 `8`
- 성공 전까지는 `nextTwoParentState`에 적재
- 실패 시 `twoParentIndexReady = false`로만 마킹하고 single-title 상태는 유지

### 4.6 index artifact는 `JSON 숫자배열` 그대로 두지 않는다

기존 문서 초안의 이런 형태:

```json
{
  "entries": {
    "시바": [12, 4901, 93021]
  }
}
```

는 개념 설명용으로는 쉬워도, full dataset에서는 너무 비대해질 가능성이 크다.

현재 검토 결론:

- `naive JSON number array`는 최종 산출물로 채택하지 않는다
- `v1`은 `delta-encoded Uint32Array -> base64` 포맷으로 고정한다

예:

```json
{
  "entries": {
    "시바": {
      "count": 3,
      "encoding": "u32_delta_base64",
      "data": "DAAAAA0AAAABAAAA"
    }
  }
}
```

뜻:

- 실제 postings는 `[12, 25, 26]` 같은 sorted `titleId`
- 저장 시 delta `[12, 13, 1]`
- 이를 `Uint32Array`로 packed 후 base64 문자열로 저장

장점:

- JSON 숫자배열보다 훨씬 작다
- 구현이 과하게 복잡하지 않다
- runtime decode도 단순하다

### 4.7 build 절차를 문서에 박아두지 않으면 운영 실수가 난다

[package.json](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/package.json)은 현재 `{}`다.  
즉 자동 build pipeline이 없다.

또 [data/merge-reflux-datasets.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/data/merge-reflux-datasets.mjs) 는 현재:

- 입력 dataset merge
- titles 정규화/정렬
- shard manifest + shard files write

까지만 한다.

따라서 2-parent index는 별도 builder를 두되, 문서에 아래를 명시해야 한다.

1. `reflux-title-set-unified.json` version이 바뀌면 2-parent index도 반드시 재생성
2. 배포 전에 `datasetVersion` 일치 확인
3. runtime은 mismatch 시 single-title only로 fallback

즉 “실행은 되는데 2-parent만 몰래 stale 상태”를 문서 차원에서 막는다.

### 4.8 background 복원 순서상 `post.loadState()`는 `monitor` 상태를 미리 알 수 없다

[background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js) L200-L212 기준으로, 관련 scheduler subset만 보면 background 복원 순서는:

1. `post.loadState()`
2. `ip.loadState()`
3. `monitor.loadState()`

순서로 돈다.

뜻:

- `post.loadState()`가 실행될 때는 아직 `monitor.isRunning / monitor.phase`를 신뢰할 수 없다
- 그래서 post matcher preload 여부는 `post` 자기 저장 상태만 기준으로 결정해야 한다

최종 규칙:

1. `post.loadState()`는 `this.isRunning && this.currentAttackMode === SEMICONDUCTOR_REFLUX`만 보고 preload 여부를 정한다
2. 여기서 monitor child 여부까지 판단하려고 cross-module 상태를 보지 않는다
3. 비정상 종료로 stale child state가 남아 있어도, background가 뒤에서 `monitor` 상태를 읽은 뒤 child 정리를 수행한다

쉽게 말하면:

- `post.loadState()`는 “내 저장 상태상 역류기 실행 중이면 일단 준비”
- 그 다음 단계에서 background가 “이게 진짜 살아 있어야 하는 child인지”를 정리

이 순서가 현재 구조에서 가장 안전하다.

## 5. 최종 구현안

### 5.1 신규 파일

신규 파일 1:

- `features/post/semiconductor-reflux-post-title-matcher.js`

역할:

- 게시글 전용 matcher 진입점
- 기존 single-title matcher + 새 2-parent mix branch 결합
- post/monitor 전용 `ensure/getStatus/hasTitle` 제공
- 중요:
  - 기존 title-set module을 `래핑`만 한다
  - `titleSet / permutationSignatureSet / containmentSignatureSet`를 새 모듈 안에서 다시 만들지 않는다
  - 즉 single-title 판정은 기존 [features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js)의 runtime을 그대로 재사용한다

신규 파일 2:

- `data/build-reflux-two-parent-index.mjs`

역할:

- `data/reflux-title-set-unified.json` manifest + shard들을 읽음
- representative chunk 기반 2-parent index 산출
- `datasetVersion` / `titleCount` / `bucketCount`를 artifact에 기록

신규 data artifact:

- `data/reflux-two-parent-index.json`
- `data/reflux-two-parent-index.bucket00.json` ... `bucket63.json`

### 5.2 수정 파일

#### 수정 파일 1: 게시글 scheduler

- [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js)

교체 지점:

- import: L35-L38
- `start()`: L93
- `transitionManualAttackModeWhileRunning()`: L273
- `transitionManualRefluxConfigWhileRunning()`: L324
- `isEligibleForAttackMode()` 주입: L454-L455
- `loadState()`: L596
- `filterRefluxCandidatePosts()` local match: L779

변경 규칙:

1. 기존 `hasSemiconductorRefluxTitle` -> `hasSemiconductorRefluxPostTitle`
2. 기존 `isSemiconductorRefluxTitleSetReady` -> `isSemiconductorRefluxPostTitleMatcherReady`
3. preload는 `reflux mode`일 때만

#### 수정 파일 2: monitor scheduler

- [features/monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js)

교체 지점:

- import: L13-L17
- `start()`: L108
- initial sweep local miss / hit: L454, L471
- attack mode sample decision: L500-L501
- async search 보강 local hit: L527
- cheap decision: L558-L559, L577
- `loadState()`: L1064
- `buildInitialSweepPosts()`: L1214-L1215

변경 규칙:

1. monitor 실행 중 local reflux 판정은 전부 post matcher 사용
2. `start()`는 preload
3. `loadState()`는 `isRunning`일 때만 preload

#### 수정 파일 3: 공용 normalization helper

- [features/reflux-normalization.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-normalization.js)

추가 helper:

- `extractRefluxAllChunksFromNormalizedCompareKey(value, options)`
- `extractRefluxRepresentativeChunksFromNormalizedCompareKey(value, options)`
- `hashRefluxStringToFnv1a64Hex(value)` 또는 동일 역할 helper

목적:

- builder와 runtime이 같은 chunk 규칙을 쓰게 고정

### 5.3 변경하지 않을 파일

아래는 이번 작업에서 의도적으로 변경하지 않는다.

- [features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js)
  - single-title exact/permutation/containment 유지
- [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js)
- [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js)
- [features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js)
- [manifest.json](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/manifest.json)

### 5.4 manifest / 리소스 접근

[features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js) L426-L435 기준으로, 기존 title-set 로더는 `chrome.runtime.getURL(...) + fetch(...)` 패턴을 이미 사용한다.

이번 작업에서는:

- 새 2-parent index도 같은 background/service worker 문맥에서 읽는다
- `manifest.json` 수정은 기본적으로 불필요하다
- 단, 나중에 content script에서 직접 읽게 만들 계획이 생기면 그때 `web_accessible_resources`를 별도로 검토한다

## 6. 게시글 전용 matcher API

추천 export 표면:

```javascript
async function ensureSemiconductorRefluxPostTitleMatcherLoaded()
function getSemiconductorRefluxPostTitleMatcherStatus()
function isSemiconductorRefluxPostTitleMatcherReady()
function hasSemiconductorRefluxPostTitle(title)
```

권장 status 형태:

```javascript
{
  loaded: true,
  ready: true,
  titleSetReady: true,
  datasetVersion: '2026-04-16-222009',
  titleSetSourceType: 'bundled',
  twoParentIndexReady: true,
  twoParentIndexVersionMatch: true,
  twoParentIndexDatasetVersion: '2026-04-16-222009',
  twoParentBucketCount: 64,
  twoParentChunkLengths: [3, 4],
  reason: ''
}
```

핵심 규칙:

1. matcher는 먼저 기존 `ensureSemiconductorRefluxTitleSetLoaded()`를 호출한다
2. title-set이 준비되지 않으면 `ready = false`
3. title-set은 준비됐는데 index만 실패하면:
   - `ready = true`
   - `twoParentIndexReady = false`
   - `hasSemiconductorRefluxPostTitle()`는 single-title만 동작
4. sourceType/version mismatch면:
   - `ready = true`
   - `twoParentIndexReady = false`
   - `twoParentIndexVersionMatch = false`
5. 새 matcher는 기존 single-title runtime을 복제하지 않는다
   - base module의 `hasSemiconductorRefluxTitle()`와 status를 그대로 사용
   - 새 모듈은 `2-parent runtime state`만 추가로 가진다

## 7. 4번째 분기 알고리즘

### 7.1 최종 분기 순서

게시글 전용 matcher의 최종 순서는 아래로 고정한다.

1. single-title exact
2. single-title permutation
3. single-title containment
4. two-parent mix
5. caller 쪽 search fallback

즉 search보다 앞, 기존 local 3분기 뒤에 들어간다.

### 7.2 입력 정규화

- 게시글 제목 정규화는 기존과 동일
- [features/post/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/attack-mode.js) L89-L91 경로 유지

### 7.3 query split 규칙

정규화된 제목 `normalizedTitle`에 대해:

1. 전체 길이가 `10 미만`이면 바로 false
2. cut point를 `4 .. (n - 4)` 전체 순회
3. 각 cut마다:
   - left side
   - right side
   - 두 side 모두 길이 `4 이상`

예:

- 제목: `시바끝나네드디어플러스지피티0원구독창업한다`
- 가능한 split 예:
  - `시바끝나네 | 드디어플러스지피티0원구독창업한다`
  - `시바끝나네드디어 | 플러스지피티0원구독창업한다`
  - `시바끝나네드디어플러스 | 지피티0원구독창업한다`

### 7.4 query side chunk 규칙

각 side에서:

- 길이 `3`, `4` substring 전부 추출
- 중복 제거
- 제외 규칙:
  - 자모-only 반복 (`ㅋㅋㅋ`, `ㅅㅂㅅ`, `ㄷㄷㄷ`) 제외
  - 한글 포함 chunk는 `3 미만` 제외
  - 영문 포함 chunk는 `4 미만` 제외

### 7.5 dataset side representative chunk 규칙

각 dataset title에 대해:

- 길이 `3`, `4`
- anchor 위치 `앞 / 중간 / 뒤`
- 각 `(anchor, length)` 조합에서 대표 chunk 1개
- title 내부 중복 제거
- df > `400` chunk는 폐기

예:

- 제목: `시바드디어지피티플러스0원구독끝나네`
- 길이 3
  - 앞: `시바드`
  - 중간: `플러스`
  - 뒤: `끝나네`
- 길이 4
  - 앞: `시바드디`
  - 중간: `티플러스`
  - 뒤: `구독끝나`

실제 구현은 글자 index 기준으로 자른다.  
위 예시는 이해용이다.

### 7.6 candidate 판정 규칙

각 cut에 대해:

1. left side chunk postings로 `leftCandidateCounts` 누적
2. right side chunk postings로 `rightCandidateCounts` 누적
3. side별 `count >= 2` 후보만 유지
4. side별 상위 `40개`까지만 유지
5. 아래를 만족하는 `(leftParentId, rightParentId)`가 하나라도 있으면 true

통과 조건:

- `leftParentId !== rightParentId`
- `leftCount >= 2`
- `rightCount >= 2`
- `rightCounts[leftParentId] <= 1`
- `leftCounts[rightParentId] <= 1`

뜻:

- 왼쪽은 A 부모 조각이 2개 이상 보여야 하고
- 오른쪽은 B 부모 조각이 2개 이상 보여야 하며
- 같은 title 하나가 양쪽을 다 설명하면 안 된다

예:

- 왼쪽에서 A가 3개 hit
- 오른쪽에서 B가 2개 hit
- A가 오른쪽에서 0개
- B가 왼쪽에서 1개

이면 통과다.

반대로:

- 왼쪽 3개, 오른쪽 3개가 모두 사실상 같은 parent X에서 나온 경우

는 `single title 변형` 쪽으로 보는 게 맞으므로 2-parent mix로 통과시키지 않는다.

## 8. index artifact 형식

### 8.1 manifest

```json
{
  "datasetVersion": "2026-04-16-222009",
  "titleCount": 2503996,
  "updatedAt": "2026-04-17T00:00:00.000Z",
  "bucketCount": 64,
  "dfThreshold": 400,
  "chunkLengths": [3, 4],
  "anchorMode": "start_mid_end",
  "postingEncoding": "u32_delta_base64",
  "paths": [
    "data/reflux-two-parent-index.bucket00.json",
    "data/reflux-two-parent-index.bucket01.json"
  ]
}
```

### 8.2 bucket

```json
{
  "encoding": "u32_delta_base64",
  "rows": [
    ["시바", "DAAAAA0AAAABAAAA"],
    ["플러", "MwAAAIcAAAA="]
  ]
}
```

설명:

- `rows[i][0]` = representative chunk 문자열
- `rows[i][1]` = delta-encoded `Uint32Array`의 base64
- `count`는 별도 저장하지 않고 decode 후 `byteLength / 4`로 계산한다
- 이유:
  - `entries: { chunk: { count, encoding, data } }` 형태는 key/object overhead가 너무 커서
  - 실제 shard 규모에서는 배포 artifact 크기가 과도하게 불어난다
  - 그래서 구현은 compact rows 형식으로 저장하고, runtime은 legacy object 형식도 읽을 수 있게 둔다

decode 규칙:

1. base64 -> bytes
2. bytes -> `Uint32Array`
3. `bytes.byteLength / 4`로 postings 길이 계산
4. prefix sum으로 실제 `titleId` 복원

## 9. builder 구현 규칙

`data/build-reflux-two-parent-index.mjs`는 아래 순서로 구현한다.

1. `data/reflux-title-set-unified.json` manifest 로드
2. shard 순회
3. titleId를 shard 순회 순서 기준 `0..N-1`로 고정
4. 각 title에서 representative chunk 추출
5. chunk별 postings 누적
6. df > 400이면 폐기
7. 남은 chunk만 bucket으로 분산
8. manifest + bucket 파일 write

권장 bucket key:

- `FNV1a64(chunk) % 64`

권장 구현 디테일:

1. 입력은 반드시 `통합 manifest`를 받는다
2. 현재 merge 스크립트가 만든 shard 구조를 그대로 읽는다
3. 출력 전에 postings는 오름차순 정렬
4. postings는 delta encode 후 base64 pack
5. 기존 stale bucket 파일은 정리한다

권장 CLI:

```bash
node data/build-reflux-two-parent-index.mjs data/reflux-title-set-unified.json
```

배포 전 필수 순서:

1. `node data/merge-reflux-datasets.mjs ... --version <new-version>`
2. `node data/build-reflux-two-parent-index.mjs data/reflux-title-set-unified.json`
3. 두 manifest의 `datasetVersion` 일치 확인

## 10. 실제 호출 흐름에서 바뀌는 점

### 10.1 게시글 분류 수동/자동

변경 전:

- local single-title match
- search cache/queue

변경 후:

- local single-title match
- local two-parent mix
- search cache/queue

즉 search 전에 local hit가 늘어난다.

### 10.2 monitor attack mode 판정

[features/post/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/attack-mode.js) L161-L183은 matcher 함수를 외부에서 받는다.

즉 core 함수는 안 건드리고,
monitor 쪽에서 넘기는 matcher만 `hasSemiconductorRefluxPostTitle`로 바꾸면 된다.

### 10.3 댓글 쪽 영향 없음

댓글은 여전히:

- normalized memo
- single-title matcher

만 사용한다.

즉 이번 작업으로 댓글 삭제율/댓글 공격 감시 판단은 바뀌지 않는다.

## 11. 구현 전 논리 검증 결론

이번 라인바이라인 재검토 기준 결론:

1. `anchor 완화만으로 해결`되는 문제가 아니다.
2. `single-title matcher`와 `two-parent mix matcher`는 질문 자체가 다르다.
3. 공용 matcher 직접 확장은 댓글 경로까지 변하게 하므로 범위가 너무 넓다.
4. 게시글 전용 matcher 추가가 가장 안전하다.
5. query마다 full dataset scan은 runtime에서 불가능하다.
6. 그래서 오프라인 index artifact가 필수다.
7. `sync boolean matcher` 호출 구조 때문에 첫 조회 lazy bucket fetch는 현재 설계와 충돌한다.
8. preload는 `필요한 실행 경로에서만` 해야 한다.
9. `ready`는 `two-parent 준비 여부`가 아니라 `게시글 local matcher usable 여부`여야 한다.
10. 2-parent branch는 `bundled + version match`일 때만 켜야 한다.
11. artifact는 naive JSON postings가 아니라 packed postings로 가야 한다.
12. 현재 기준으로 설계상 남은 blocking issue는 없다.

남은 것은 구현 후 검증 항목이다.

## 12. 구현 체크리스트

패치할 때 체크:

1. 게시글 scheduler import 교체
2. monitor scheduler import 교체
3. post scheduler preload를 `reflux mode`로 한정
4. monitor `loadState()` idle 경로에서 무거운 preload 금지
5. comment/comment-monitor import는 건드리지 않기
6. `ready`와 `twoParentIndexReady` 의미 분리
7. `sourceType/version/titleCount` mismatch graceful fallback 넣기
8. `loadingPromise + atomic swap + limited concurrency` 넣기
9. search fallback 순서 유지하기
10. 실제공격셋 recall 다시 확인하기
11. 정상글 negative 샘플로 오탐 확인하기
12. background 재기동 후 복원 지연/오류 확인하기
13. data artifact 누락 시 single-title matcher가 살아 있는지 확인하기

## 13. 바로 구현할 때의 기본 선택

이번 문서 기준 최종 기본 선택:

- 구현 범위:
  - 게시글 분류
  - 게시글 자동 감시
  - attack mode sample 판단
- 구현 제외:
  - 댓글 삭제
  - 댓글 감시
- index 기본안:
  - representative chunk = `앞/중간/뒤`
  - chunk lengths = `3/4`
  - df threshold = `400`
  - side min hit = `2`
  - leak max = `1`
  - top candidates per side = `40`
  - bucket count = `64`
  - posting encoding = `u32_delta_base64`

이 문서 기준으로는 바로 패치에 들어가도 된다.  
지금 남아 있는 건 설계 결함이 아니라, 구현 후 수치 검증이다.
