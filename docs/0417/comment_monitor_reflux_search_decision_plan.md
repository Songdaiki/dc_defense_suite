# 댓글 자동 감시 역류기 Search 판정 연결 문서

> 작성일: 2026-04-17  
> 기준 코드: `HEAD 58decfe`  
> 대상 범위: `comment-monitor`의 자동 공격 모드 판정  
> 제외 범위: 댓글 실제 삭제 런타임 변경, 게시물 자동 감시 변경, search broker 규칙 변경, UI 문구 개편

## 0. 한 줄 결론

이번 건은 **댓글 자동판단 쪽만 연결하면 된다.**

쉽게 말하면 지금 구조는 이렇게 나뉜다.

1. 게시물 자동 감지: 이미 `matcher + search duplicate`까지 연결되어 있음
2. 댓글 실제 삭제: 이미 `matcher + search cache + search resolve`까지 연결되어 있음
3. 댓글 자동 감지: 아직 `matcher만` 보고 있음

즉 사용자가 말한

- “댓글 로직도 게시물 역류방어처럼 잘 해놨는데”
- “자동판단에 대해서만 연결 잘하면 된다”

이 판단이 현재 코드 기준으로 맞다.

다만 한 가지 중요한 차이는 있다.

- 게시물 자동 감지는 `5개 샘플 중 3개`
- 댓글 자동 감지는 **5개 게시물이 아니라**
  - 변경된 게시글 최대 `5개`
  - 각 게시글에서 유동 댓글 최대 `20개`
  - 전체 샘플 유동 댓글이 `20개 이상`일 때
  - `70% 이상`이면 역류기로 본다

예:

- 게시물 자동 감지:
  - 샘플 제목 5개 중 3개가 역류 hit면 `SEMICONDUCTOR_REFLUX`
- 댓글 자동 감지:
  - 샘플 댓글 30개 중 21개가 역류 hit면 `COMMENT_REFLUX`

즉 댓글은 원래부터 `5중3`이 아니라 `댓글 비율형`이다.  
이번 문서는 **그 비율 계산에 search duplicate까지 포함시키는 문서**다.

## 1. 실제 코드 교차검증 결과

이 문서는 아래 실제 코드 흐름을 다시 읽고 대조한 뒤 작성했다.

- 게시물 자동 감지:
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)
- 게시물 matcher:
  - [features/post/semiconductor-reflux-post-title-matcher.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-post-title-matcher.js)
  - [features/post/semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js)
- 게시물 search broker:
  - [features/post/reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js)
- 댓글 자동 감지:
  - [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js)
- 댓글 실제 삭제:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js)
- 댓글 matcher wrapper:
  - [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js)
- 댓글 search broker:
  - [features/comment/comment-reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-search-duplicate-broker.js)
- 댓글 정규화:
  - [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js)

### 1.1 게시물 자동 감지는 이미 search duplicate까지 본다

[features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L497) 기준:

- `decideAttackMode()`는 먼저 `buildAttackModeDecision()`으로 base count를 만든다.
- 이 base count는 matcher를 쓴다.
- 그다음 matcher miss인 제목만 [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L532) 에서 `resolveRefluxSearchDuplicateDecision()`으로 다시 확인한다.
- search positive면 `refluxLikeCount`에 추가한다.
- 마지막에 그 count로 다시 [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L93) 의 `buildAttackModeDecisionFromCounts()`를 탄다.

즉 게시물 자동 감지는 이미:

- local matcher hit
- search duplicate hit

둘 다 공격 판정 count에 포함한다.

### 1.2 게시물 matcher는 exact-only가 아니다

[features/post/semiconductor-reflux-post-title-matcher.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-post-title-matcher.js#L98) 기준:

- `hasSemiconductorRefluxPostTitle(title)`는 먼저 [features/post/semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L201) 의 `hasSemiconductorRefluxTitle(title)`를 본다.
- 이 함수는
  - exact
  - permutation
  - containment
  를 포함한다.
- 거기서 miss이면 게시물 전용 `2-parent mix`까지 본다.

즉 게시물 자동 감지의 base matcher는 이미:

1. exact
2. permutation
3. containment
4. two-parent

까지 포함한다.

### 1.3 댓글 실제 삭제 런타임도 이미 search duplicate까지 본다

[features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L249) 기준:

- `COMMENT_REFLUX` 실행 중이면 일반 삭제 경로를 안 타고 `planCommentRefluxDeletion()`으로 간다.
- 여기서 각 댓글은 [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L386) 의 `inspectRefluxFourStepCandidate()`를 탄다.

실제 4단계는 이렇다.

1. matcher hit
2. search cache positive
3. search miss면 queue
4. search resolve positive면 삭제

즉 댓글 **실제 삭제**는 이미 게시물처럼 “matcher miss를 search duplicate로 보강”하고 있다.

### 1.4 댓글 matcher도 exact-only가 아니다

[features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L145) 기준:

- `hasCommentRefluxMemo(memo)`는
  - 먼저 `hasNormalizedSemiconductorRefluxTitle(normalizedMemo)`를 보고
  - miss면
  - `hasNormalizedSemiconductorRefluxTwoParentMixTitle(normalizedMemo)`까지 본다.

즉 댓글 matcher도 이미:

1. exact
2. permutation
3. containment
4. two-parent

를 포함한다.

그래서 댓글 쪽도 “dataset 완전일치만 본다”는 상태는 이미 아니다.

### 1.5 댓글 자동 감지만 아직 matcher-only다

[features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L470) 기준:

- `buildManagedAttackModeDecision()`는 샘플 댓글을 모은 뒤
- [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L502) 에서
  `hasCommentRefluxMemo(comment.memo)`로만 `refluxMatchCount`를 센다.
- 이후 `refluxRatio >= 0.7`이면 `COMMENT_REFLUX`로 판정한다.

여기에는

- `ensureCommentRefluxSearchDuplicateBrokerLoaded()`
- `peekCommentRefluxSearchDuplicateDecision()`
- `resolveCommentRefluxSearchDuplicateDecision()`

가 전혀 들어가 있지 않다.

즉 지금 댓글 자동 감지는:

- matcher hit는 셈
- matcher miss를 search duplicate로 재확인하지는 않음

상태다.

### 1.6 그래서 현재 불균형은 정확히 이거다

현재 역류기 관련 경로를 한 줄로 요약하면:

- 게시물 자동 감지: `matcher + search`
- 게시물 실제 분류: `matcher + search`
- 댓글 자동 감지: `matcher만`
- 댓글 실제 삭제: `matcher + search`

즉 지금 남은 연결 구멍은 **댓글 자동 감지 1개**다.

## 2. 이번 패치의 목표

목표는 아주 좁다.

- 댓글 자동 감지의 `refluxMatchCount` 계산을
  - 기존 `matcher-only`
  - 에서
  - `matcher + search duplicate`
  - 로 올린다.

쉽게 말하면:

- 지금:
  - 댓글 자동 감시가 공격 판단할 때
  - “local matcher에 걸리는 댓글”만 역류로 센다
- 목표:
  - local matcher miss여도
  - 실제 댓글 삭제 런타임처럼
  - search duplicate positive면 역류로 센다

예:

- 샘플 댓글 25개 중
  - matcher hit 14개
  - matcher miss인데 search positive 5개
  - 총 19개

그러면

- 현재: `14 / 25 = 56%`라서 역류기 아님
- 목표: `19 / 25 = 76%`라서 역류기 맞음

이게 이번 문서의 핵심이다.

## 3. 변경 범위

### 3.1 반드시 바뀌는 파일

- [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js)

### 3.2 import만 추가될 가능성이 큰 파일

- [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js)

추가 후보 import:

- `ensureCommentRefluxSearchDuplicateBrokerLoaded`
- `peekCommentRefluxSearchDuplicateDecision`
- `resolveCommentRefluxSearchDuplicateDecision`

출처:

- [features/comment/comment-reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-search-duplicate-broker.js)

### 3.3 바꾸지 않는 파일

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js)
  - 실제 삭제 런타임은 이미 잘 연결돼 있으므로 유지
- [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js)
  - matcher 자체는 이미 4단계(local 2-parent 포함)라 유지
- [features/comment/comment-reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-search-duplicate-broker.js)
  - search broker 규칙은 이번 범위 밖
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)
  - 게시물 자동 감지는 이미 연결돼 있으므로 유지

## 4. 구현 방식

### 4.1 새 helper를 comment-monitor 안에 추가한다

권장 형태:

- `buildCommentRefluxSearchContext(sampleComment)`
- `countManagedCommentRefluxMatches(sampleComments)`

이유:

- 현재 댓글 실제 삭제용 `buildCommentRefluxSearchContext()`는 [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L346) 에 `Scheduler` 인스턴스 메서드로 묶여 있다.
- comment-monitor는 그걸 직접 재사용하기 어렵다.
- 이번 패치는 자동 감지 경로만 건드리면 되므로, comment-monitor 안에서 같은 규칙으로 context를 만드는 작은 helper를 하나 두는 게 제일 단순하다.

필드 구조는 댓글 search broker의 `normalizeDecisionContext()` 요구사항을 그대로 맞추면 된다:

- `deleteGalleryId`
- `searchGalleryId`
- `currentPostNo`
- `plainText`
- `normalizedCompareKey`
- `searchQuery`

근거:

- [features/comment/comment-reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-search-duplicate-broker.js#L404)

### 4.2 count 로직은 `cache-first + unresolved resolve` 순서로 간다

추천 순서:

1. 샘플 댓글 수집
2. matcher ready 확인
   - matcher/dataset이 준비되지 않았으면 search broker도 보지 않고 기존처럼 `refluxMatchCount = 0`으로 둔다
   - 이유: 실제 child 댓글 삭제 scheduler는 `COMMENT_REFLUX` 시작 시 dataset 준비를 강제하므로, 자동감지 쪽만 search로 우회 판정하면 시작 직후 `DEFAULT` fallback과 엇갈릴 수 있다
3. matcher miss만 따로 모은다
4. miss가 하나라도 있으면 그때만 search broker load
5. miss 댓글들을 먼저 `peekCommentRefluxSearchDuplicateDecision(context)`로 분류한다
   - `positive`면 즉시 count++
   - `negative`면 즉시 non-hit
   - `error`면 즉시 non-hit
   - `pending` / `miss`면 unresolved 목록으로 보낸다
6. 현재 count만으로 이미 역류기 확정/불가 판정이 가능한지 먼저 본다
7. 아직 판정이 안 나면 unresolved만 `resolveCommentRefluxSearchDuplicateDecision(context)`로 순차 확인한다
8. 각 resolve 결과마다 조기 성공 / 조기 실패를 다시 계산한다
9. 최종 `refluxRatio` 계산

이 순서가 맞는 이유:

- 게시물 자동 감지와 방향은 같되, 댓글 쪽 `최대 100샘플` 규모를 고려한 구조가 된다.
- 실제 댓글 삭제 런타임의 `4단계 필터`와 더 가까워진다.
- search broker는 내부에 cache/pending dedupe가 있으므로 중복 질의도 자동 흡수된다.
- miss가 하나도 없으면 search broker preload조차 안 해도 된다.
- cache positive만으로 이미 70%를 넘는 경우 불필요한 resolve를 아예 안 할 수 있다.
- 반대로 남은 unresolved를 전부 hit로 가정해도 70%를 못 넘는 순간 조기 실패할 수 있다.

### 4.3 `peek + resolve`를 같이 쓴다

이번 범위에서는 `peek만`도 아니고 `resolve만`도 아니다.

이유:

- 자동 공격 판정은 실제 진입 직전 핵심 판단이라 최종적으로는 `resolve`가 필요하다.
- 하지만 댓글 monitor는 게시물보다 샘플 수가 훨씬 많아서, 처음부터 전부 `resolve`로 밀면 진입 지연과 요청 수가 커진다.
- 따라서
  - 1차는 `peek`로 cache positive / negative / error / pending을 분류하고
  - 2차는 정말 필요한 unresolved만 `resolve`
  하는 2단계가 맞다.

쉽게 말하면:

- `peek`는 “이미 아는 답”을 바로 꺼내는 단계
- `resolve`는 “아직 모르는 것만 실제 확인하는” 단계

이다.

근거:

- [features/comment/comment-reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-search-duplicate-broker.js#L89)
- [features/comment/comment-reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-search-duplicate-broker.js#L123)

### 4.4 공격 판정 이유 문자열도 함께 바꾼다

지금은 reason이:

- `matcher 매치 X개`

형태다.

패치 후에는 아래처럼 바꾸는 것이 맞다.

- `샘플 유동 댓글 28개 중 matcher/search 매치 21개 (75.00%)`

가능하면 더 좋게:

- `샘플 유동 댓글 28개 중 matcher 15개 + search 6개 = 21개 (75.00%)`

이렇게 해야 나중에 로그를 보고

- local matcher가 잡은 건지
- search duplicate가 보강한 건지

즉시 알 수 있다.

### 4.5 stop 중 경합을 막는 재검사가 필요하다

이건 이번 재검토에서 새로 찾은 중요한 연결 이슈다.

[features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L389) 기준:

- `enterAttackMode()`는 시작 시점에만 `isRunning`을 확인한다.
- 그런데 그 직후 `await this.buildManagedAttackModeDecision(metrics)`를 탄다.
- 현재는 이 await 뒤에 `isRunning` 재검사가 없다.

지금은 matcher-only라 짧게 끝나서 티가 덜 났지만,
search resolve까지 붙으면 이 구간이 길어질 수 있다.

그래서 이번 패치에서는 최소한 아래 둘 중 하나가 필요하다.

1. `buildManagedAttackModeDecision()` / 하위 helper가 `stale`를 반환
2. 또는 `enterAttackMode()`가 await 뒤에 `if (!this.isRunning) return;`를 한 번 더 확인

이 재검사가 없으면:

- 사용자가 정지 버튼을 눌렀는데
- 느린 search resolve가 끝난 뒤
- 다시 `ATTACKING` 상태를 세팅하는

식의 레이스가 생길 수 있다.

## 5. 세부 알고리즘

### 5.1 현재 유지할 기준

이번 패치에서는 아래 기준을 유지한다.

- 샘플링 대상 게시글 수: `5`
- 게시글당 샘플 댓글 수: `20`
- 최소 샘플 유동 댓글 수: `20`
- 역류기 판정 임계치: `70%`

근거:

- [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L26)

즉 이번 패치는 “무엇을 역류로 세는지”만 확장하고,
“몇 개 이상이면 공격인가” 기준은 건드리지 않는다.

### 5.2 sample comment 하나를 셀 때의 규칙

댓글 하나당 판단 순서는 아래로 고정한다.

1. `plainText = normalizeCommentMemo(comment.memo)`
2. `normalizedCompareKey = normalizeCommentRefluxCompareKey(plainText)`
3. 값이 비면 skip
4. `hasCommentRefluxMemo(comment.memo)`가 true면 hit
5. false면 search context 구성
6. `peekCommentRefluxSearchDuplicateDecision(context)` 실행
7. `positive`면 hit
8. `negative` / `error`면 non-hit
9. `pending` / `miss`면 unresolved 목록에 보관
10. unresolved에 대해서만 `resolveCommentRefluxSearchDuplicateDecision(context)` 실행
11. `positive`면 hit
12. 그 외(`negative`, `error`, `cancelled`)는 hit 아님

중요:

- `error`를 hit로 치면 안 된다.
- `cancelled`를 hit로 치면 안 된다.
- `pending`은 기존 queue를 기다리는 의미이므로 unresolved로 넘겨야 한다.
- `miss`도 즉시 non-hit가 아니라 unresolved다.
- matcher가 준비되지 않았으면 4~12단계 자체를 건너뛰고 기존처럼 `refluxMatchCount = 0`으로 처리해야 한다.
- `sampleCount` 분모는 기존처럼 `sampleComments.length`를 유지해야 한다.
  즉 invalid/empty memo는 hit가 안 될 뿐, 전체 샘플 분모에서는 빠지지 않는다.

### 5.3 threshold 계산은 ratio 그대로 두되 정수 컷오프로 판단한다

현재 판정은:

- `refluxRatio >= 0.7`

이다.

실제 구현 helper에서는 조기 종료를 위해 아래 값을 같이 써야 한다.

- `requiredMatchCount = Math.ceil(sampleCount * COMMENT_ATTACK_SAMPLE_RATIO_THRESHOLD)`

예:

- `sampleCount = 20` -> 필요 hit `14`
- `sampleCount = 21` -> 필요 hit `15`
- `sampleCount = 30` -> 필요 hit `21`

이 값을 쓰면 아래 조기 종료가 가능하다.

- 현재 hit가 `requiredMatchCount` 이상이면 즉시 성공
- 현재 hit + 남은 unresolved 수가 `requiredMatchCount` 미만이면 즉시 실패

### 5.4 searchGalleryId는 기존 댓글 삭제 런타임과 같은 규칙을 쓴다

반드시 같은 규칙을 써야 한다.

즉:

- `commentScheduler.config.refluxSearchGalleryId`가 있으면 그 값
- 없으면 `commentScheduler.config.galleryId`

근거:

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L354)
- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L1011)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L200)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L201)

이걸 다르게 쓰면

- 자동 감지는 A 갤을 보고
- 실제 삭제는 B 갤 기준으로 검색

하는 어색한 상태가 된다.

중요:

- `comment-monitor` 자신의 config에는 `refluxSearchGalleryId`가 없다.
- 그래서 자동 감지 helper는 **반드시** `commentScheduler.config`를 읽어야 한다.
- 다행히 background 복원 순서상 `comment` state가 `commentMonitor`보다 먼저 로드되므로,
  이 전제는 현재 코드와 충돌하지 않는다.
- 갤러리 ID 자체도 popup 공통 설정 저장 시 [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1032) 에서
  `comment`와 `commentMonitor`에 함께 반영된다.
  그래서 이번 패치에서 별도 gallery sync 로직을 추가할 필요는 없다.

## 6. 파생 이슈 검토

### 6.1 댓글 실제 삭제 런타임과 충돌하지 않나

충돌하지 않는다.

이유:

- 댓글 실제 삭제는 이미 search duplicate를 쓰고 있다.
- 이번 패치는 자동 감지 count를 그 실제 삭제 기준에 더 가깝게 맞추는 것이다.
- 그리고 실제 댓글 삭제 시작 시 [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L767) 의 runtime reset이 호출되더라도,
  broker는 pending/queue만 비우고 cache 자체는 유지한다.
  즉 자동 감지에서 이미 확인한 search 결과는 실제 삭제 런타임에서도 다시 활용될 수 있다.

즉 “판정”이 “실행”을 따라오게 만드는 패치다.

### 6.2 게시물 자동 감지와 어긋나지 않나

어긋나지 않는다.

오히려 맞춰진다.

지금 게시물은 이미 자동 감지에서 matcher miss를 search duplicate로 재확인한다.
댓글만 그 보강이 빠져 있었다.

이번 패치 후 양쪽 구조는 이렇게 맞춰진다.

- 게시물 자동 감지: matcher + search
- 댓글 자동 감지: matcher + search

### 6.3 search 요청이 너무 많아지지 않나

이건 그냥 “감당 가능”이라고 넘기면 안 된다. 이번 재검토에서 실제 이슈로 봐야 한다.

이유:

- 샘플 게시글 최대 `5개`
- 게시글당 댓글 최대 `20개`
- 즉 샘플 댓글 최대 `100개`

그래서 naive 구현이

- “matcher miss 전부 `resolve`”

형태면 진입 지연과 요청 수가 커질 수 있다.

따라서 이번 패치 문서 기준 안전장치는 아래가 **필수**다.

1. matcher first
2. broker load only if needed
3. cache-first `peek`
4. unresolved만 `resolve`
5. threshold 조기 성공 / 조기 실패

그리고 실제로는:

- matcher hit는 local에서 끝남
- search broker는 cache/pending dedupe가 있음
- 동일 문구 중복은 cacheKey 기준으로 흡수됨
- threshold 조기 종료가 들어가면 모든 unresolved를 끝까지 확인할 필요도 없다
- matcher 미준비 상태에서는 search broker까지 가지 않으므로 기존 fallback 흐름도 유지된다

즉 “무조건 100개 full search”가 아니라
**필요한 것만 search**로 만드는 게 이번 설계의 핵심이다.

### 6.4 search broker load 실패 시 어떻게 하나

이건 hard fail보다 soft fallback이 맞다.

권장 정책:

- matcher는 그대로 계산
- search broker load/resolve에서 실패한 건 count에 넣지 않음
- 대신 로그에
  - `자동 역류기 샘플 search 확인 실패`
  정도만 남김

이유:

- 자동 감지 단계는 보강 로직이다.
- 여기서 search가 실패했다고 전체 댓글 감시가 죽는 건 과하다.
- 기존 matcher-only 판정으로 내려앉는 편이 안정적이다.

쉽게 말하면:

- 최선: matcher + search
- 차선: matcher only
- 최악: 댓글 감시 전체 실패

여기서 차선이 맞다.

### 6.5 stop / 정지 중에는 조용히 중단돼야 한다

이것도 이번 재검토에서 추가된 연결 이슈다.

search resolve가 붙으면 `buildManagedAttackModeDecision()`가 지금보다 오래 걸릴 수 있다.

그래서 helper 내부에서 최소한 아래 체크가 필요하다.

- broker load 뒤 `if (!this.isRunning)` 확인
- unresolved resolve loop 각 iteration 전후 `if (!this.isRunning)` 확인

필요하면 반환값에:

- `stale: true`

를 넣고 상위 `enterAttackMode()`가 그대로 빠져나오게 하는 구조가 가장 깔끔하다.

핵심은:

- 정지 버튼을 눌렀으면
- 오래 돌던 자동 역류기 판정이 끝난 뒤에도
- phase / mode / totalAttackDetected를 다시 건드리면 안 된다는 점이다.

### 6.6 UI나 설정 저장 구조를 바꿔야 하나

필수는 아니다.

이번 패치는 내부 자동 판정 로직만 바꾸는 것이므로:

- popup
- config schema
- storage key

는 건드리지 않아도 된다.

## 7. 구현 순서

1. [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js)에 search broker import 추가
2. comment-monitor 내부에 search context helper 추가
3. comment-monitor 내부에 `countManagedCommentRefluxMatches(sampleComments)` helper 추가
4. helper 내부를 `matcher -> peek -> unresolved resolve -> threshold early exit` 구조로 구현
5. `buildManagedAttackModeDecision()`에서 기존 `sampleComments.reduce(hasCommentRefluxMemo)` 부분을 helper 호출로 교체
6. `enterAttackMode()` await 뒤 `isRunning` 재검사 또는 `stale` 처리 추가
7. reason 문자열을 `matcher/search` 기준으로 보강
8. syntax check
9. 정적 검증
   - matcher hit only 케이스
   - search cache positive 케이스
   - matcher miss + search positive 케이스
   - matcher miss + search negative 케이스
   - broker load 실패 케이스
   - search resolve error 케이스
   - threshold 조기 성공 케이스
   - threshold 조기 실패 케이스
   - stop 중 stale bailout 케이스
   - 샘플 20 미만 케이스

## 8. 패치 후 기대 결과

패치 후에는 이런 케이스가 바뀐다.

예:

- 샘플 댓글 30개
- local matcher hit 15개
- local miss 중 search positive 7개

현재:

- `15 / 30 = 50%`
- 자동 역류기 진입 실패

패치 후:

- `22 / 30 = 73.33%`
- 자동 역류기 진입 성공

즉 “실제 댓글 삭제 런타임은 search까지 보는데, 자동 감지만 matcher-only라 공격 진입이 늦는 문제”를 바로 줄일 수 있다.

## 9. 최종 판단

현재 코드 기준 결론은 아래다.

1. 게시물 자동 감지는 이미 연결돼 있다.
2. 댓글 실제 삭제도 이미 연결돼 있다.
3. 댓글 matcher는 exact-only가 아니라 `exact + permutation + containment + two-parent`다.
4. 남은 구멍은 댓글 자동 감지의 `search duplicate 미반영` 하나다.
5. 다만 naive하게 “matcher miss 전부 resolve”로 가면 지연/정지 경합 이슈가 생길 수 있다.
6. 따라서 이번 패치는 **댓글 자동 감지에만 search duplicate count를 연결하되, `peek + resolve + threshold early exit + stale bailout`까지 같이 넣어야 한다.**

즉 이 문서 기준으로는 **남은 blocking issue는 문서에 반영 완료**됐다.

남은 일은:

- `comment-monitor`에 안전장치 포함 보강 단계를 붙이는 것

하나다.
