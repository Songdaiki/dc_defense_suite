# 댓글 역류기 2-Parent Len Gate 적용 문서

> 작성일: 2026-04-17  
> 기준 코드: `HEAD 1709d9b`  
> 기준 전제: 이미 게시물 쪽 `2-parent(len26)` matcher는 존재하고, 댓글 쪽은 아직 `single-title`만 본다.  
> 목표 범위: `COMMENT_REFLUX` 댓글 삭제 경로 + 댓글 감시의 역류기 샘플 판정  
> 제외 범위: search duplicate broker 규칙 변경, weighted/score 계열 로직, popup UI 개편

## 0. 한 줄 결론

질문한 방향은 맞다.

- **댓글도 게시물과 같은 느낌으로 local matcher를 올려야 한다.**
- 정확히는:
  - 기존 `single-title exact + permutation + containment`
  - 여기에 **게시물과 동일한 `len gate 포함 2-parent`**
  - 를 추가하는 방향이 맞다.

쉽게 말하면:

- 지금 댓글 `4단계 필터`는 이미 있다.
- 하지만 그 4단계의 **1단계 local dataset hit 품질**이 아직 게시물보다 약하다.
- 그래서 `진짜 공격 댓글`은 local에서 놓치고, 나중에 search duplicate에만 기대는 구조가 남아 있다.
- 이걸 **게시물과 같은 local matcher**로 끌어올리는 문서다.

예:

- 진짜 공격:
  - `시바 끝나네 드디어 플러스 지피티 0원구독 창업한다 때려치고 대기업`
- 지금 댓글:
  - `single-title`로는 놓칠 수 있음
- 목표 댓글:
  - 게시물과 같은 `len26 + 2-parent`로 local hit 가능

반대로:

- 일반 댓글:
  - `대기업 다니다가 창업 고민중인데 지피티 플러스는 비싸네`
- `2-parent`를 무식하게 풀면 오탐이 커질 수 있음
- 그래서 **게시물과 같은 len gate/side gate를 그대로 재사용**해야 한다

## 1. 실제 코드 교차검증 결과

이 문서는 아래 실제 파일을 다시 읽고 교차검증한 뒤 작성했다.

- 댓글 dataset wrapper:
  - [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js)
- 댓글 scheduler:
  - [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js)
- 댓글 parser:
  - [features/comment/parser.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/parser.js)
- 댓글 monitor:
  - [features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js)
- 게시물 2-parent matcher:
  - [features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js)
- 공용 title-set matcher:
  - [features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js)
- 공용 정규화:
  - [features/reflux-normalization.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-normalization.js)
- 게시물 2-parent 구현 문서:
  - [docs/0417/reflux_two_parent_mix_detector_plan.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0417/reflux_two_parent_mix_detector_plan.md)

### 1.1 현재 댓글 local matcher는 아직 single-title만 본다

[features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js:98) 기준:

- `hasCommentRefluxMemo(memo)`는
  - `normalizeCommentRefluxMemo(memo)`로 댓글을 normalize하고
  - [features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js:210)의
    `hasNormalizedSemiconductorRefluxTitle(normalizedMemo)`만 호출한다.

즉 지금 댓글 local matcher는:

1. exact
2. permutation
3. stricter containment

까지만 본다.

**게시물용 2-parent는 아직 안 탄다.**

### 1.2 현재 댓글 4단계 필터는 이미 있다

[features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:248) 와
[features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:363) 기준:

- 댓글 `COMMENT_REFLUX` 경로는 이미 아래 4단계를 탄다.

1. local dataset hit
2. search cache positive
3. search negative / pending / error
4. miss면 검색 resolve

즉 지금 부족한 건 **흐름**이 아니라 **1단계 local hit 품질**이다.

### 1.3 게시물 2-parent는 이미 len26 정책으로 구현돼 있다

[features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js:12) 기준:

- chunk lengths: `3 / 4`
- `TWO_PARENT_MIN_TITLE_LENGTH = 26`
- `TWO_PARENT_MIN_SIDE_LENGTH = 4`
- `TWO_PARENT_MIN_SIDE_MATCH_COUNT = 2`
- `TWO_PARENT_MAX_OPPOSITE_LEAK_COUNT = 1`

[features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js:98) 기준:

- `hasSemiconductorRefluxPostTitle(title)`는
  1. single-title 먼저 보고
  2. miss면
  3. normalized 후
  4. `hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedTitle)`를 탄다

즉 댓글에 필요한 건 **새 알고리즘 추가**가 아니라
**이미 검증된 게시물 2-parent matcher 재사용**이다.

### 1.4 댓글 정규화와 게시물 정규화는 호환된다

댓글 정규화:

- [features/comment/parser.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/parser.js:96)
  - `normalizeCommentMemo(memo)`
- [features/comment/parser.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/parser.js:133)
  - `normalizeCommentRefluxCompareKey(memo)`
  - 내부적으로 `normalizeRefluxCompareKey(normalizeCommentMemo(memo))`

게시물 정규화:

- [features/post/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/attack-mode.js:89)
  - `normalizeSemiconductorRefluxTitle(value)`
  - 내부적으로 `normalizeRefluxCompareKey(value)`

공용 compareKey 규칙:

- [features/reflux-normalization.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-normalization.js:33)
  - `normalizeRefluxCompareKey(value)`

즉 댓글은:

1. 먼저 HTML/entity/`<br>` 제거
2. 그다음 공용 compareKey로 변환

게시물은:

1. 바로 공용 compareKey로 변환

따라서 댓글 쪽에서 **`normalizeCommentRefluxMemo()`로 만든 normalized memo를 게시물 2-parent normalized matcher에 넘기는 구조는 논리적으로 맞다.**

### 1.5 댓글 감시도 같은 matcher를 공유한다

[features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js:13) 와
[features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js:486) 기준:

- comment-monitor는 `ensureCommentRefluxDatasetLoaded()`
- 그리고 `hasCommentRefluxMemo(comment.memo)`로 샘플 hit 비율을 계산한다

즉 `hasCommentRefluxMemo()`를 올리면 영향 범위는 두 군데다.

1. 댓글 삭제 본체
2. 댓글 감시의 `COMMENT_REFLUX` 샘플 판정

이건 **버그가 아니라 의도된 공유 범위**로 보는 게 맞다.

### 1.6 현재 댓글 시작/복원 준비 루틴은 2-parent preload를 안 한다

[features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:748) 기준:

- `ensureDatasetReadyForAttackMode()`는 지금 `ensureCommentRefluxDatasetLoaded()`만 한다
- 즉 title-set ready만 보지, post 2-parent matcher preload는 안 한다

그래서 지금 상태에서 `hasCommentRefluxMemo()`만 바꾸면:

- 댓글 삭제 본체는 local hit가 강해질 수 있지만
- preload 누락 시 일부 경로에서 `single-title only`로 조용히 내려앉을 수 있다

이건 문서 기준으로 **반드시 같이 막아야 하는 연결 이슈**다.

### 1.7 실제 게시물 쪽도 “2-parent 미준비 = hard fail”로 막고 있지는 않다

이건 이번 재검토에서 새로 확인한 중요한 사실이다.

[features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js:77) 기준:

- 게시물 matcher status는
  - `ready`
  - `twoParentIndexReady`
  - 를 분리해서 들고 있다

그리고 [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:655) 기준:

- `assertManualAttackModeReady()`는 현재 사실상 no-op다

즉 실제 게시물 동작은:

- title-set local matcher는 살려 두고
- 2-parent만 별도 준비 상태로 본다

쉽게 말하면:

- 게시물도 지금 `2-parent index`가 깨졌다고 무조건 시작 실패시키지 않는다
- 그 대신 single-title matcher는 계속 돈다

그래서 댓글 문서도 **게시물과 같은 느낌**으로 맞추려면
`댓글만 유독 hard fail`로 가지 않는 게 더 자연스럽다.

### 1.8 현재 사용자 문구는 아직 dataset-only 의미에 묶여 있다

실제 코드 기준으로 아래 문구는 지금 모두 `dataset-only` 의미다.

- popup quick toggle:
  - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1332)
- popup 설명 문구:
  - [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html:538)
- 댓글 공격 모드 라벨:
  - [features/comment/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/attack-mode.js:15)
- 댓글 스케줄러 요약 로그:
  - [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:505)
- comment-monitor 공격 이유:
  - [features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js:501)

이번 패치 후 local matcher가

- exact
- permutation
- containment
- 2-parent

까지 보게 되면, 위 문구를 계속 `dataset 공격`, `dataset 매치`라고 두는 건 설명상 틀린 상태가 된다.

즉 이건 기능 blocking issue는 아니지만,
**운영/로그/UX 기준으로는 같이 고치는 게 맞는 이슈**다.

### 1.9 import cycle 리스크는 현재 없다

실제 import 방향을 확인했다.

- 댓글 scheduler:
  - [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:30)
- 댓글 monitor:
  - [features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js:13)

현재는:

- comment 계층이 `comment-reflux-dataset.js`를 본다
- post matcher 쪽이 comment 계층을 다시 import 하지는 않는다

즉 `comment-reflux-dataset.js -> post matcher -> title-set -> normalization`
방향으로 추가해도 현재 기준 **순환 import는 생기지 않는다.**

## 2. 최종 목표 동작

최종 목표는 아래 한 줄이다.

- **댓글 `COMMENT_REFLUX`의 local matcher를 게시물 `SEMICONDUCTOR_REFLUX` local matcher와 같은 느낌으로 맞춘다.**

정확히는:

- 댓글 local hit:
  - `single-title exact + permutation + containment`
  - `+ len26 2-parent`
- search duplicate:
  - 기존 그대로 유지
- 4단계 흐름:
  - 기존 그대로 유지

즉 바뀌는 건 이거 하나다.

- `inspection.stage === DATASET`로 들어오는 댓글 수가 늘어난다

안 바뀌는 건 이거다.

- `pending/miss`를 search broker에 넘기는 방식
- 삭제 API batch 구조
- 검증/통계/로그 흐름

## 3. 구현 원칙

### 3.1 댓글 레이어에 2-parent 규칙을 복붙하지 않는다

금지:

- 댓글 파일에 `TWO_PARENT_MIN_TITLE_LENGTH = 26` 같은 상수를 새로 복사
- 댓글 파일에 split/chunk/candidate pair 로직을 한 번 더 구현

이유:

- 게시물과 댓글 정책이 다시 벌어질 수 있다
- 나중에 len gate를 바꾸면 두 군데를 따로 수정하게 된다

권장:

- 댓글은 **게시물 2-parent matcher를 가져다 쓰는 thin wrapper**만 둔다

### 3.2 댓글 local matcher는 “댓글용 normalize + 게시물용 normalized matcher”로 간다

권장 구조:

1. 댓글 raw memo
2. `normalizeCommentRefluxMemo(memo)`로 comment-specific cleanup
3. normalized memo를
   - `hasNormalizedSemiconductorRefluxTitle(normalizedMemo)`
   - `hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedMemo)`
   에 순서대로 넣는다

이 구조가 맞는 이유:

- 댓글만의 HTML/entity cleanup은 유지
- exact/permutation/containment와 2-parent는 게시물과 같은 policy를 공유
- 이중 normalize는 피할 수 있고, intent도 더 분명하다

### 3.3 댓글 `COMMENT_REFLUX`는 실제 필요 경로에서만 matcher preload를 시도하고, 상태 의미는 게시물과 맞춘다

권장 결정:

- 댓글 `COMMENT_REFLUX` 시작/복원/감시 판정에서는
  - 댓글 scheduler의 `COMMENT_REFLUX` 시작/복원
  - comment-monitor의 실제 `COMMENT_REFLUX` 샘플 판정 시점
  - 에서만 matcher preload를 **명시적으로 시도**한다

다만 상태 의미는 게시물과 맞춘다.

이유:

- 실제 게시물 쪽도 `ready`와 `twoParentIndexReady`를 분리한다
- 댓글만 별도로 hard fail로 만들면 게시물과 의미가 벌어진다

쉽게 말하면:

- 댓글 scheduler가 실제 `COMMENT_REFLUX`로 들어갈 때 matcher preload는 해 둔다
- comment-monitor는 그냥 켜졌다는 이유만으로 matcher 전체를 미리 로드하지는 않는다
- 다만 2-parent만 실패해도 single-title local matcher까지 같이 꺼버리지는 않는다
- 대신 **경고 로그나 status field로 degraded 상태를 보이게 한다**

왜 comment-monitor 시작/복원 eager preload를 권장하지 않느냐:

- comment-monitor는 평소엔 스냅샷/증감만 보다가
- 실제 공격 전환 판정 시점에만 reflux matcher를 사용한다
- 그래서 `start()` / `loadState()`에서 미리 큰 matcher를 올리면
  - 시작 지연
  - 복원 지연
  - 불필요한 메모리 점유
  만 늘어날 수 있다

즉 최종 정책은:

- `ready`: 댓글 reflux local matcher 사용 가능
- `twoParentIndexReady`: 2-parent까지 준비됨

으로 분리하는 게 맞다.

## 4. 파일별 실제 패치 계획

## 4.1 [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js)

### 현재 역할

- shared title-set 상태 로드
- `hasCommentRefluxMemo()` 제공

### 변경 목표

- 댓글용 normalized memo를 기준으로
  - single-title
  - post 2-parent
  를 함께 판단하는 matcher wrapper로 확장
- comment scheduler / comment-monitor가 preload 상태를 명시적으로 확인할 수 있게 matcher status helper 추가

### 권장 수정 내용

1. import 추가

- `ensureSemiconductorRefluxPostTitleMatcherLoaded`
- `getSemiconductorRefluxPostTitleMatcherStatus`
- `hasNormalizedSemiconductorRefluxTwoParentMixTitle`

from:

- `../post/semiconductor-reflux-post-title-matcher.js`

2. 새 helper 추가

권장 이름:

- `ensureCommentRefluxMatcherLoaded()`
- `getCommentRefluxMatcherStatus()`
- `isCommentRefluxMatcherReady()`

권장 의미:

- `ensureCommentRefluxMatcherLoaded()`
  - 기존 `ensureCommentRefluxDatasetLoaded()`
  - + `ensureSemiconductorRefluxPostTitleMatcherLoaded()`
- `getCommentRefluxMatcherStatus()`
  - dataset status
  - + post matcher status 일부
  - 최소 포함:
    - `ready`
    - `datasetReady`
    - `twoParentIndexReady`
    - `twoParentIndexVersionMatch`
    - `reason`
- `isCommentRefluxMatcherReady()`
  - **게시물과 맞춰 `datasetReady`와 같은 의미로 둔다**

권장 보조 helper:

- `isCommentRefluxTwoParentReady()`
  - `datasetReady && twoParentIndexReady`

3. `hasCommentRefluxMemo()` 변경

현재:

```js
return hasNormalizedSemiconductorRefluxTitle(normalizedMemo);
```

목표:

```js
if (hasNormalizedSemiconductorRefluxTitle(normalizedMemo)) {
  return true;
}

return hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedMemo);
```

중요:

- `hasSemiconductorRefluxPostTitle(rawTitle)`를 그대로 부르는 방식보다
- **normalized memo 기준의 direct 호출**이 더 명확하다

이유:

- 댓글은 이미 HTML/entity cleanup을 거쳤다
- 여기서 raw string을 다시 post raw matcher에 넘길 필요가 없다

### 이 파일에서 바꾸지 말아야 할 것

- `STORAGE_KEY`
- persisted dataset state 구조
- `sourceType = 'bundled_shared_title_set'`

이유:

- 이번 작업은 dataset 저장형식 변경이 아니다
- matcher readiness만 추가되는 것이지 dataset manifest가 바뀌는 건 아니다

## 4.2 [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js)

### 현재 영향 지점

- 시작: L92-L111
- 댓글 삭제 본체: L248-L307
- local+search 4단계 plan: L363-L442
- attack mode 준비: L748-L775
- 복원: L881-L909

### 변경 목표

- `COMMENT_REFLUX` 실행 시 matcher preload를 보장
- 4단계 필터 흐름은 그대로 유지

### 권장 수정 내용

1. import 교체/추가

기존:

- `ensureCommentRefluxDatasetLoaded`
- `isCommentRefluxDatasetReady`

추가 권장:

- `ensureCommentRefluxMatcherLoaded`
- `getCommentRefluxMatcherStatus`
- `isCommentRefluxMatcherReady`

2. `ensureDatasetReadyForAttackMode()` 내부 변경

현재:

- dataset만 로드
- dataset ready만 확인

목표:

- `COMMENT_REFLUX`면 `ensureCommentRefluxMatcherLoaded()` 호출
- `isCommentRefluxMatcherReady()` 확인
- false면 `getCommentRefluxMatcherStatus().reason` 포함해서 throw
- `twoParentIndexReady === false`면
  - **시작 자체를 막지 말고**
  - 로그에 한 번 경고를 남기거나
  - status field에 degraded reason을 노출한다

추가로 같이 맞춰야 하는 사용자 노출 로그:

- `logCommentRefluxFilterSummary()`의
  - `dataset ${stats.datasetCount}`
  - 는 패치 후 의미가 틀린다
- 내부 stats 필드명을 꼭 바꿀 필요는 없지만
  - 사용자 로그 문구는
  - `local matcher ${stats.datasetCount}`
  - 또는 `matcher ${stats.datasetCount}`
  - 처럼 바꾸는 게 맞다

권장 에러 예시:

- `댓글 2-parent matcher 준비 실패 - ${reason}`

권장 경고 예시:

- `⚠️ 댓글 2-parent index 준비 실패 - single-title matcher만 사용합니다. (${reason})`

3. `processPost()` / `planCommentRefluxDeletion()` / `resolveDeferredCommentRefluxTargets()`는 구조 유지

이 부분은 이미 맞다.

- [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:248)
- [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:363)
- [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:444)

여기서 바뀌는 건 오직:

- `hasCommentRefluxMemo()`가 더 강해져서
- `inspection.stage === DATASET` hit가 늘어나는 것뿐이다

즉 `4단계 분기 자체는 수정하지 않는 것`이 맞다.

### 쉽게 말한 before / after

원래:

- 댓글이 `A+B 합성`이면 local miss
- 나중에 search duplicate에서만 잡힐 수도 있고, 못 잡을 수도 있음

패치 후:

- 댓글이 `A+B 합성`이고 len26 조건을 넘으면
- local dataset 단계에서 바로 hit 가능
- 그러면 `즉시 삭제 batch`로 더 빨리 간다

## 4.3 [features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js)

### 현재 영향 지점

- import: L13-L17
- 샘플 판정: L467-L516
- 상태 복원 연계:
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:214)
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:274)

### 변경 목표

- 감시가 `COMMENT_REFLUX`를 고를 때도 같은 upgraded matcher를 쓰게 맞춘다
- 다만 comment-monitor 자체의 시작/복원 지연은 늘리지 않는다

### 권장 수정 내용

1. import 교체/추가

- `ensureCommentRefluxMatcherLoaded`
- `isCommentRefluxMatcherReady`

2. `start()` / `loadState()`에는 eager preload를 넣지 않는다

이건 이번 재검토에서 정리된 중요한 운영 포인트다.

- comment-monitor는 시작 직후 바로 reflux matcher를 쓰지 않는다
- 그래서 여기서 preload를 넣으면
  - monitor 시작이 늦어지고
  - service worker 복원도 느려질 수 있다
- 특히 [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:200) 기준 복원은 여러 scheduler `loadState()`를 순서대로 훑기 때문에,
  comment-monitor `loadState()`에 큰 matcher preload를 넣는 건 전체 복원 지연으로 이어질 수 있다

쉽게 말하면:

- comment-monitor는 “필요할 때만 lazy preload”가 맞다

3. `buildManagedAttackModeDecision()`의 preload 변경

현재:

- `ensureCommentRefluxDatasetLoaded()`
- `isCommentRefluxDatasetReady()`

목표:

- `ensureCommentRefluxMatcherLoaded()`
- `isCommentRefluxMatcherReady()`
- local 변수명도 `refluxDatasetReady`보다 `refluxMatcherReady`로 바꾸는 게 맞다

4. `refluxMatchCount` 계산은 그대로

현재:

```js
hasCommentRefluxMemo(comment.memo) ? count + 1 : count
```

이 한 줄은 그대로 둔다.

왜냐면:

- wrapper만 바꾸면 comment-monitor도 같은 matcher를 공유하게 되기 때문이다

### 주의점

이 변경 후에는 comment-monitor가 예전보다 `COMMENT_REFLUX`를 더 잘 고를 수 있다.

이건 부작용이 아니라 의도다.

이유:

- 이전에는 합성 댓글을 local에서 덜 잡았기 때문

5. reason/log 문자열도 같이 바꾼다

현재:

- `dataset 로드 실패`
- `dataset 매치 ${count}개`

패치 후 권장:

- `역류기 댓글 matcher 준비 실패`
- `샘플 유동 댓글 ${sampleCount}개 중 matcher 매치 ${refluxMatchCount}개`

이유:

- 이제 실제 판정 기준이 dataset-only가 아니기 때문이다

6. 가능하면 comment-monitor status/log에도 degraded 이유를 남긴다

권장 최소안:

- `getCommentRefluxMatcherStatus()`를 한 번 읽어서
  - `twoParentIndexReady === false`
  - 이면 comment-monitor 로그에 경고를 남긴다
- 또는 `commentMonitor.getStatus()`에
  - `refluxMatcherReady`
  - `refluxTwoParentReady`
  - `refluxMatcherReason`
  - 를 같이 노출한다

왜 이게 필요하냐면:

- 댓글 방어 scheduler는 아직 시작되지 않았어도
- comment-monitor는 `buildManagedAttackModeDecision()` 시점에 `COMMENT_REFLUX` 진입 여부를 판단하고 있다
- 이때 2-parent가 죽어 있으면 샘플 hit가 줄 수 있는데
- 그 사실이 monitor 쪽에 안 보이면 “왜 자동 전환이 약하냐”를 추적하기 어렵다

## 4.4 [features/comment/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/attack-mode.js) + popup copy

이번 재검토에서 새로 드러난 non-blocking 이슈지만,
실제 운영 기준으로는 같이 고치는 게 맞다.

권장 변경:

- [features/comment/attack-mode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/attack-mode.js:15)
  - `역류기 공용 matcher 공격`
  - -> `역류기 공용 matcher 공격`
- [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1332)
  - toggle label 동기화
- [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html:538)
  - 설명 문구를
    - dataset만
    - 이 아니라
    - `공용 matcher + 검색 필터`
    의미에 맞게 수정

이건 기능을 바꾸는 패치는 아니지만,
패치 후 사용자 인지와 로그 해석을 위해 같이 반영하는 게 낫다.

## 4.5 [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js) status 노출

`twoParent`를 best-effort로 둘 경우, degraded 상태를 보일 곳이 필요하다.

권장 최소 추가:

- `getStatus()`에 아래 field 추가
  - `commentRefluxMatcherReady`
  - `commentRefluxTwoParentReady`
  - `commentRefluxMatcherReason`

이유:

- hard fail을 안 하면 사용자는 “왜 어떤 댓글은 여전히 search까지 가느냐”를 모를 수 있다
- popup이 당장 이 field를 안 써도 background/status payload에는 남겨 두는 편이 디버깅에 유리하다

## 4.6 변경하지 않는 파일

이번 패치에서 **건드리지 않는 게 맞는 파일**:

- `features/comment/comment-reflux-search-duplicate-broker.js`
- `features/reflux-four-step-filter.js`
- `features/comment/api.js`
- `background/background.js`

이유:

- search duplicate 규칙은 그대로
- 4단계 분기 helper는 이미 공유화 완료
- 삭제 API shape 불변
- background message routing 불변

즉 이번 작업은 **matcher 강화 패치**이지 **흐름 재배선 패치**가 아니다.

## 5. 논리 검증 결과

## 5.1 왜 댓글도 2-parent가 필요하냐

맞다. 필요하다.

이유:

- 지금 댓글 4단계 필터는 있어도
- `1단계 local hit`가 single-title only라서
- `두 부모 합성 댓글`은 local에서 약하다

즉 지금 상태는:

- “흐름은 맞는데 local detector가 약한 상태”

## 5.2 왜 len gate를 꼭 같이 써야 하냐

이걸 빼면 가짜공격 일반글/일반댓글도 더 많이 맞을 수 있다.

게시물에서 이미 결정된 정책:

- `TWO_PARENT_MIN_TITLE_LENGTH = 26`

이건 그대로 재사용하는 게 맞다.

중요:

- 이 길이 기준은 raw 댓글 길이가 아니라
- **댓글 normalize 이후 compareKey 길이**
  기준으로 해석된다

즉 `<br>`, HTML tag, entity, 공백 정리 이후 길이를 본다.

쉽게 말하면:

- 짧은 문장 두 조각은 너무 흔하다
- 길이 gate 없이 2-parent를 열면 오탐이 빨리 커진다

## 5.3 왜 댓글에서 별도 2-parent 구현을 만들면 안 되냐

안 좋은 이유:

1. 정책 drift
2. 상수 중복
3. 디버깅 포인트 증가
4. 게시물/댓글 결과가 다시 엇갈릴 수 있음

그래서 권장안은 하나다.

- **댓글은 게시물 matcher를 재사용**

## 5.4 왜 search duplicate 쪽은 안 건드리냐

search duplicate는 현재도 역할이 맞다.

- local obvious hit를 먼저 잡고
- miss/pending만 검색으로 넘기는 구조

여기서 필요한 건 search 규칙 변경이 아니라
`local hit를 게시물 수준으로 올리는 것`이다.

즉:

- 현재 bottleneck은 search가 아니라 local이다

## 5.5 comment-monitor까지 같이 바꾸는 게 왜 맞냐

안 바꾸면 이런 문제가 생긴다.

- 댓글 삭제 본체는 upgraded matcher 사용
- comment-monitor attack mode 샘플링은 old single-title matcher 사용

그러면:

- 실제 삭제는 강해졌는데
- 감시는 여전히 그 패턴을 충분히 못 봐서 `COMMENT_REFLUX` 진입이 늦어질 수 있다

즉 같은 `hasCommentRefluxMemo()` 공유 지점을 올리는 게 맞다.

## 5.6 hard fail보다 “best-effort + visible degraded state”가 왜 더 맞냐

이건 이번 재검토에서 문서가 수정된 핵심 포인트다.

처음 초안은:

- 2-parent 미준비면 댓글 `COMMENT_REFLUX` 자체를 막는 방향

이었지만, 실제 게시물은 그렇게 안 한다.

현재 게시물 실제 의미:

- single-title matcher는 살아 있으면 `ready`
- 2-parent는 별도 준비 상태

그래서 댓글도 같은 철학으로 맞추는 게 더 일관된다.

즉 권장 최종안:

1. matcher preload는 명시적으로 시도
2. title-set/local matcher가 살아 있으면 모드는 시작 가능
3. 2-parent가 꺼져 있으면
   - 경고 로그
   - status field
   - user-facing copy
   로만 드러낸다

## 6. 구현 후 기대 플로우

패치 후 댓글 `COMMENT_REFLUX`는 이렇게 된다.

1. 댓글 raw memo 수집
2. `normalizeCommentMemo()`로 HTML/entity 정리
3. `normalizeCommentRefluxMemo()`로 compareKey 생성
4. local matcher:
   - single-title exact/permutation/containment
   - miss면 post 2-parent(len26) 검사
5. local hit면 `즉시 삭제 batch`
6. local miss면 기존 search duplicate 4단계로 진행

예:

- 댓글:
  - `시바 끝나네 드디어 플러스 지피티 0원구독 창업한다 때려치고 대기업`
- patched local:
  - `len >= 26`
  - 좌/우 split 가능
  - 게시물과 같은 3/4 chunk 기준 2-parent hit
- 결과:
  - search까지 안 가고 즉시 삭제 batch 후보

## 7. 구현 전 남은 이슈 점검

현재 기준으로 **blocking issue는 없다.**

다만 아래 다섯 개는 문서대로 반드시 같이 가야 한다.

1. `hasCommentRefluxMemo()`만 바꾸고 preload를 안 넣는 실수
2. scheduler만 바꾸고 comment-monitor의 `buildManagedAttackModeDecision()` preload를 안 맞추는 실수
3. comment-monitor `start()/loadState()`에 eager preload를 넣어서 시작/복원 지연을 키우는 실수
4. 요약 로그/라벨/reason 문자열을 `dataset` 의미 그대로 두는 실수
5. degraded 상태를 comment scheduler에만 남기고 comment-monitor 결정 경로에서는 안 보이게 두는 실수

이 다섯 가지를 같이 맞추면, 현재 코드 기준으로는 남는 연결 문제는 없다.

## 8. 실제 패치 체크리스트

패치 순서는 아래로 고정하는 걸 권장한다.

1. `features/comment/comment-reflux-dataset.js`
   - matcher import 추가
   - `ensureCommentRefluxMatcherLoaded()`
   - `getCommentRefluxMatcherStatus()`
   - `isCommentRefluxMatcherReady()`
   - `isCommentRefluxTwoParentReady()` optional
   - `hasCommentRefluxMemo()`를 `single-title + 2-parent`로 변경
2. `features/comment/scheduler.js`
   - `COMMENT_REFLUX` 준비 루틴을 matcher 기준으로 변경
   - degraded warning / status field 추가
   - 요약 로그의 `dataset N` 문구를 matcher 의미로 정리
   - 삭제 본체 4단계 plan/resolve는 그대로 유지
3. `features/comment-monitor/scheduler.js`
   - sample 판정 preload/ready 기준을 matcher 기준으로 변경
   - reason/log 문구를 dataset -> matcher 의미로 변경
   - degraded 상태를 monitor log/status에서도 확인 가능하게 정리
4. `features/comment/attack-mode.js` + popup copy
   - dataset-only 문구 정리
5. 검증
   - 구문검사
   - 댓글 local matcher 정적 케이스 30+
   - scheduler/monitor 호출 경로 정적 검증
   - `docs/실제공격.md` / `docs/가짜공격.md` 기반 샘플 측정

## 9. 구현 후 최소 검증 기준

최소한 아래는 확인해야 한다.

1. 댓글 raw memo에 HTML/entity가 있어도 normalize 후 matcher가 정상 동작
2. `single-title` hit는 기존과 동일
3. `len < 26` 합성 댓글은 local 2-parent false
4. `len >= 26` 진짜 합성 댓글은 local 2-parent true
5. local matcher hit면 search broker를 타지 않음
6. search pending/miss 흐름은 기존 그대로 유지
7. comment-monitor sample 판정도 같은 matcher를 씀
8. title-set 자체가 비었을 때만 시작 차단이 걸리고, `twoParent` 미준비만으로는 hard fail하지 않음
9. `twoParent` 미준비 상태는 degraded warning/status/log로 확인 가능
10. comment-monitor가 `COMMENT_REFLUX` 진입 판정 중일 때도 degraded 이유를 로그/status에서 확인 가능
11. comment-monitor `start()` / `loadState()`는 이전보다 눈에 띄게 느려지지 않음

## 10. 최종 결론

질문한 표현으로 정리하면 이렇다.

- **“게시물과 같은 느낌으로 필터링”**  
  -> 맞다.

다만 정확한 뜻은:

- 댓글도 이제
  - `single-title`
  - `+ 게시물과 같은 len26 2-parent`
  - `+ 기존 4단계 search duplicate`
  구조로 간다는 뜻이다.

그리고 이번 재검토에서 확정된 운영 원칙은 이것이다.

- 게시물과 맞추기 위해
  - `ready`와 `twoParentReady`는 분리한다
  - 2-parent 미준비를 기본적으로 hard fail로 보지 않는다
  - 대신 degraded 상태는 로그/status/copy에서 숨기지 않는다

즉 이번 패치는:

- 댓글에 별도 이상한 점수제 추가
- 댓글에 별도 다른 2-parent 규칙 추가

가 아니라

- **게시물에서 이미 확정한 2-parent 정책을 댓글 local matcher에도 공유한다**

가 핵심이다.
