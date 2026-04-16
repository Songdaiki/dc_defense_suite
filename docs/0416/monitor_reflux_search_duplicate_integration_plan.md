# 감시 자동화 역류기 search duplicate 연동 계획

## 1. 목표

현재 게시물 역류기 방어는 두 갈래로 나뉘어 있다.

- 수동 `역류기 공격` 토글 ON:
  - `dataset + getSearch duplicate`를 같이 쓴다.
- 감시 자동화가 공격을 잡아서 `SEMICONDUCTOR_REFLUX`로 들어간 경우:
  - 이름만 역류기 모드이고,
  - 실제 판정과 initial sweep은 아직 `dataset exact-match` 위주다.

이번 문서의 목표는 이 불일치를 없애는 것이다.

한 줄 요약:

- `감시 자동화가 역류기 공격으로 판정했다면`
- `초기 판정`, `initial sweep`, `공격 중 child post scheduler`까지
- 전부 **수동 역류기와 같은 search duplicate 계열 로직**을 타게 만든다.

쉽게 예시로:

- 새 유동글 5개 중 3개가 dataset에는 아직 없지만,
- `getSearch`로 보면 과거 중복 글이 잡힌다.
- 지금은 자동 감시가 이걸 `DEFAULT`로 볼 수 있다.
- 패치 후에는 `SEMICONDUCTOR_REFLUX`로 판정하고,
- 이미 페이지에 떠 있는 그 글들도 initial sweep에서 같이 치운다.

중요:

- 일반 공격 감지 조건 자체는 그대로 둔다.
- 바꾸는 건 `공격 감지 후 어떤 공격 모드로 볼지`, 그리고 `역류기 모드일 때 실제로 무엇을 지울지`다.
- UI를 새로 만들 필요는 없다.
  - 게시글 분류 탭에 이미 `역류 검색 갤 ID`가 있다.

---

## 2. 실제 코드 교차검증 결과

이 문서는 아래 실제 코드 기준으로 다시 확인한 뒤 썼다.

### 2.1 감시 자동화의 공격 진입 자체는 “게시물 수 + 유동 비율” 기반이다

공격 진입 조건:

- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L274)

실제 동작:

1. `metrics.newPostCount >= attackNewPostThreshold`
2. `metrics.fluidRatio >= attackFluidRatioThreshold`
3. streak 충족 시 `enterAttackMode(...)`

즉 이번 패치는:

- 공격을 “언제 감지하느냐”를 바꾸는 게 아니다.
- 공격 감지 뒤에 `DEFAULT / CJK / 역류기` 중 무엇으로 분기하느냐를 바꾸는 것이다.

### 2.2 현재 자동 공격 모드 판정은 dataset-only다

공격 진입 시:

- [features/monitor/scheduler.js:313](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L313)
- [features/monitor/scheduler.js:389](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L389)

현재 흐름:

1. `enterAttackMode(...)`
2. `this.decideAttackMode(metrics)`
3. `buildAttackModeDecision(samplePosts, ...)`

실제 판정 함수:

- [features/post/attack-mode.js:79](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L79)

핵심 문제:

- `refluxLikeCount`가 [features/post/attack-mode.js:92](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L92) 에서 `matchesSemiconductorRefluxTitle(...)`만 본다.
- 즉 search duplicate는 자동 공격 모드 판정에 전혀 안 들어간다.

예시:

- 샘플 유동글 5개
- 그중 3개가 아래처럼 최신 특갤 글 복붙 공격
  - `특ᅠ이ᅠ점ᅠ미니갤러리ᅠ이주했으면ᅠㅈ망했음`
  - `역ᅠ류ᅠ기 걍ᅠ1분컷이네`
  - `절ᅠ반ᅠ만 맞다는 건 반으로 잘라버려도 된다는ᅠ뜻이지?`
- dataset에 아직 없으면
  - 현재 자동 감시는 `refluxLikeCount = 0`
  - 그래서 `DEFAULT` 유지 가능

즉 자동 분기 기준이 현재 공격 패턴을 따라가지 못한다.

### 2.3 현재 monitor source 게시글 분류는 search duplicate를 아예 안 쓴다

핵심 코드:

- [features/post/scheduler.js:711](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L711)
- [features/post/scheduler.js:439](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L439)

현재 규칙:

```js
function shouldUseSearchDuplicateForCurrentRun(source, attackMode) {
    return source === 'manual' && normalizeAttackMode(attackMode) === ATTACK_MODE.SEMICONDUCTOR_REFLUX;
}
```

즉 지금은:

- `manual + SEMICONDUCTOR_REFLUX`일 때만 `filterRefluxCandidatePosts(...)`
- `monitor + SEMICONDUCTOR_REFLUX`는 여전히 `isEligibleForAttackMode(...)`
- 그리고 그 함수는 역류기일 때 dataset만 본다.
  - [features/post/attack-mode.js:150](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L150)

쉽게 말하면:

- 로그에는 `SEMICONDUCTOR_REFLUX`
- 실제 분류는 `dataset-only`

인 상태다.

### 2.4 initial sweep도 dataset-only라서 search duplicate 글을 영구 누락할 수 있다

핵심 코드:

- 공격 진입 후 initial sweep 타깃 계산:
  - [features/monitor/scheduler.js:320](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L320)
- initial sweep 타깃 빌드:
  - [features/monitor/scheduler.js:983](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L983)
- monitor child run은 항상 cutoff 적용:
  - [features/post/scheduler.js:681](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L681)
  - [features/post/scheduler.js:436](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L436)

현재 실제 흐름:

1. 공격 진입 순간의 `max postNo`를 `attackCutoffPostNo`로 저장
2. initial sweep이 현재 1~N페이지를 한 번 처리
3. 그 뒤 child `postScheduler`는 `cutoff 이후 글만` 본다

문제는:

- initial sweep 타깃이 `buildInitialSweepPosts(...)`에서 narrow mode일 때 dataset-only 필터를 쓴다.
- search duplicate로만 잡히는 글은 initial sweep 대상에서 빠질 수 있다.
- 그런데 child run은 cutoff 때문에 그 글을 다시 안 본다.

즉:

- 공격 진입 시점에 이미 떠 있던 search duplicate 글은
- initial sweep에서 놓치면
- **영구 누락**될 수 있다.

이건 이번 패치에서 반드시 같이 고쳐야 한다.

### 2.5 현재 post search broker는 caller 문맥을 완전히 보존하지 못한다

핵심 코드:

- cache key:
  - [features/post/reflux-search-duplicate-broker.js:357](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js#L357)
- 현재 결과 저장:
  - [features/post/reflux-search-duplicate-broker.js:225](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js#L225)
- self-match skip:
  - [features/post/reflux-search-duplicate-broker.js:311](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js#L311)

현재 broker의 cache key는:

- `searchGalleryId + normalizedTitle`

뿐이다.

그런데 최종 positive/negative는:

- `currentPostNo`
- `deleteGalleryId`

까지 알아야 self-match를 제외하고 판단할 수 있다.

예시:

1. 현재 글 `#1001`, 제목 `먹을수있는HBM나옴`
2. 검색 결과에는 `#1001` 자기 자신만 있음
3. 현재 broker는 이걸 `negative`로 cache 저장
4. 잠시 뒤 같은 제목의 새 글 `#1002`가 올라옴
5. 이 경우 `#1002` 입장에서는 `#1001`이 과거 duplicate라 positive여야 한다
6. 그런데 cache key가 같아서 이전 `negative`를 그대로 먹을 수 있다

즉 현재 post broker는:

- search fetch는 잘 하고 있지만
- `postNo`별 최종 판정 cache 모델은 댓글 broker만큼 안전하지 않다.

댓글 broker 쪽은 이미 이 문제를 풀어놨다.

- [features/comment/comment-reflux-search-duplicate-broker.js:123](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-search-duplicate-broker.js#L123)

거기는:

- row cache를 저장하고
- caller 문맥별로 final decision을 다시 만든다.

이번 패치는 post broker도 그 방향으로 맞추는 게 맞다.

### 2.6 monitor는 `refluxSearchGalleryId`를 자기 config에 안 들고 있다

핵심 코드:

- monitor config:
  - [features/monitor/scheduler.js:64](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L64)
- post config:
  - [features/post/scheduler.js:69](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L69)
- post 쪽 resolver:
  - [features/post/scheduler.js:720](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L720)
- background 쪽 resolver:
  - [background/background.js:1666](/home/eorb915/projects/dc_defense_suite/background/background.js#L1666)

현재 실제 상태:

- monitor config에는 `galleryId`, `monitorPages`, threshold류만 있다.
- `refluxSearchGalleryId`는 post scheduler config에만 있다.
- 같은 resolver 로직도 이미 post/background 두 군데에 중복돼 있다.

즉 이번 패치에서 monitor가 search duplicate를 직접 쓰기 시작하면:

- `monitor.config`에서 찾으면 안 되고
- `this.postScheduler.config` 기준으로 읽어야 하며
- resolver를 또 복붙하면 세 번째 중복이 생긴다.

정리하면:

- search 기준 갤 ID는 **monitor 설정이 아니라 post 설정을 따라야 한다**
- 구현은 **공용 helper로 묶는 쪽이 맞다**

### 2.7 `maybeWidenAttackMode(...)`를 그대로 async live search로 바꾸면 공격 중 매 사이클 요청이 늘어난다

핵심 코드:

- attacking loop:
  - [features/monitor/scheduler.js:198](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L198)
- widen 함수:
  - [features/monitor/scheduler.js:397](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L397)

현재는:

- 공격 중 매 poll cycle마다 `maybeWidenAttackMode(metrics)`를 한 번 부른다.
- 지금은 dataset-only라 싸다.

그런데 이걸 단순히:

- `decideAttackMode(metrics)` async화
- `maybeWidenAttackMode(...)`도 같은 resolve 기반 판정 재사용

으로 바꾸면,

- 공격 중인 동안
- 최신 샘플 5개에 대해
- 매 사이클 live search resolve가 반복될 수 있다.

이건 user가 우려한 IP 차단 관점에서도 좋은 방향이 아니다.

그래서 widen은 이렇게 분리하는 게 맞다.

- `enterAttackMode(...)`의 **첫 판정만** resolve-heavy
- `maybeWidenAttackMode(...)`는 **dataset + 이미 있는 positive cache + Han/CJK 신호만**으로 cheap하게 판단
- 애매하면 live search를 더 하지 말고 `DEFAULT`로 넓히는 쪽이 안전

예시:

- 현재 공격 모드가 `SEMICONDUCTOR_REFLUX`
- 이번 사이클 샘플 5개가 dataset/cache상 명확히 역류기로 안 잡힘
- 그러면 굳이 5건 live search를 더 때리지 말고
- `DEFAULT`로 넓혀서 놓치지 않게 가는 게 낫다

즉 widen은 “정밀 재판정”이 아니라 “좁은 모드를 유지할 자신이 없으면 풀기”에 가깝게 설계해야 한다.

### 2.8 async search를 attack 진입 전에 붙이면 `stop()`과 race가 생긴다

핵심 코드:

- stop:
  - [features/monitor/scheduler.js:127](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L127)
- attack 진입:
  - [features/monitor/scheduler.js:313](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L313)

현재도 `enterAttackMode(...)` 안에 await는 있지만,
search resolve를 붙이면 그 구간이 훨씬 길어진다.

문제 예시:

1. monitor가 공격 감지
2. `enterAttackMode(...)` 안에서 search resolve 시작
3. 사용자가 그 사이 `정지` 클릭
4. `stop()`은 `isRunning=false`, 상태 초기화, 로그 저장
5. 그런데 늦게 끝난 `enterAttackMode(...)`가 다시 돌아와
   - `phase=ATTACKING`
   - `attackMode=...`
   - `suspendUidWarningAutoBanForAttack()`
   - `ensureManagedDefensesStarted()`
   를 호출할 수 있다

즉 정지 후에도 늦게 도착한 async 결과가 상태를 다시 덮을 수 있다.

이번 패치에서는 최소한 아래 둘 중 하나가 필요하다.

- 각 await 뒤에 `if (!this.isRunning) return;` 가드
- 또는 attack/session generation token을 둬서 stale async 결과를 버리기

이건 문서상 필수 연결 이슈다.

### 2.9 broker를 monitor가 pre-start에서 직접 쓰면 stop 시 stale pending이 남을 수 있다

현재 broker reset은 주로 post scheduler lifecycle에서 이뤄진다.

- post stop reset:
  - [features/post/scheduler.js:132](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L132)
- post start 시 runtime reset:
  - [features/post/scheduler.js:97](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L97)

그런데 이번 패치에서는:

- `enterAttackMode(...)` 안에서
- `postScheduler.start(...)`보다 먼저
- monitor가 broker를 직접 쓸 수 있다.

이 경우 stop 타이밍에 따라:

- pre-start search pending
- pre-start cache warming

이 child lifecycle 바깥에서 남을 수 있다.

이건 치명적 버그까진 아니지만,
다음 실행에 stale pending이 섞이지 않도록 문서에서 정리해야 한다.

권장 방향:

- monitor가 pre-start search를 시작한 뒤 stop되면
- stale 결과는 generation/token 가드로 무시하고
- 필요하면 monitor stop 경로에서 broker runtime reset을 추가 검토한다

### 2.10 initial sweep이 resolve-heavy가 되면 child start가 늦어진다

핵심 코드:

- `ensureManagedDefensesStarted()`에서 initial sweep 먼저:
  - [features/monitor/scheduler.js:424](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L424)
- child post start는 그 뒤:
  - [features/monitor/scheduler.js:435](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L435)

현재 순서는:

1. initial sweep
2. child post scheduler start

dataset-only일 때는 큰 문제가 없었지만,
initial sweep까지 resolve-heavy로 바꾸면
child start가 그만큼 늦어진다.

다만 여기서 child를 먼저 띄우고 initial sweep을 병렬로 돌리면,

- 같은 postScheduler 인스턴스에서
- run loop와 `performClassifyOnce / performDeleteOnce`
- 가 섞여 들어갈 수 있다.

즉 단순 병렬화도 안전하지 않다.

이번 1차 문서에서는 이렇게 정리하는 게 맞다.

- **순서는 그대로 유지**
- 대신 initial sweep 대상은 `initialSweepPages` 범위로 제한된 현재 설계를 유지
- resolve-heavy 비용이 커졌다는 점을 문서에 명시
- child와 initial sweep을 병렬화하는 구조 변경은 이번 범위 밖으로 둔다

### 2.11 widen 로그의 `샘플 3개` 문구는 현재 상수와 안 맞는다

핵심 코드:

- sample limit 상수:
  - [features/post/attack-mode.js:13](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L13)
- widen reason:
  - [features/monitor/scheduler.js:415](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L415)

현재 상수는 `5`인데,
widen 로그는 `"최신 샘플 3개"`라고 써 있다.

즉 이번 패치 범위에서는 기능 로직뿐 아니라
이런 stale 문구도 같이 정리해야 한다.

### 2.12 monitor 공격 중 post 설정 저장은 재검증 결과 global lock으로 이미 막혀 있다

핵심 코드:

- post config update merge:
  - [background/background.js:683](/home/eorb915/projects/dc_defense_suite/background/background.js#L683)
- running manual only transition:
  - [background/background.js:669](/home/eorb915/projects/dc_defense_suite/background/background.js#L669)
- running post transition helper:
  - [background/background.js:1594](/home/eorb915/projects/dc_defense_suite/background/background.js#L1594)

현재 실제 동작:

- post feature 설정 저장은 기본적으로 `scheduler.config = { ...scheduler.config, ...message.config }`
  로 즉시 반영된다.
- 별도 runtime 전환 처리는 `scheduler.currentSource === 'manual'`일 때만 탄다.
- 다만 background에서 `getMonitorManualLockMessage(...)`가
  monitor 실행 중 post `updateConfig` 자체를 막고 있다.

즉:

- 이전에는 “mid-run 즉시 반영 가능성”을 의심했지만,
- 실제 background 호출 경로를 다시 따라가 보니
- monitor 실행 중 post 설정 저장은 애초에 lock으로 막힌다.

따라서 여기서 필요한 건 추가 차단 패치가 아니라,
문서/구현 인식 정합성 정리다.

정리:

- monitor attack session 중 post 설정 저장은 이미 막혀 있다.
- 그래서 이번 패치에서는
  - `refluxSearchGalleryId`를 `postScheduler.config`에서 읽는 것
  - 그 resolve 로직을 공용 helper로 묶는 것
  만 하면 된다.

---

## 3. 이번 패치 범위

이번 문서는 아래 4가지를 한 세트로 묶는다.

1. 자동 공격 모드 판정에 search duplicate를 반영
2. initial sweep도 search duplicate 기준으로 잡히게 변경
3. monitor source child post scheduler도 search duplicate 런타임을 사용
4. post search broker를 caller-context-safe 구조로 보강

이 4개를 같이 묶는 이유는 간단하다.

- 1번만 하면: 모드 이름만 역류기고 실제 삭제는 약하다.
- 2번을 안 하면: 공격 진입 시점의 기존 페이지 글을 놓친다.
- 3번을 안 하면: 공격 진입 후 새 글도 dataset-only로 본다.
- 4번을 안 하면: self-match negative cache가 다음 글 판정을 오염시킬 수 있다.

즉 부분 패치가 아니라, 이번 건은 묶어서 가야 논리가 닫힌다.

---

## 4. 구현 방향

### 4.1 post broker를 댓글 broker 방식으로 정리한다

바꿀 파일:

- [features/post/reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js)

핵심 방향:

1. `pendingMap`을 단순 `generation` 숫자가 아니라 `pendingEntry`로 바꾼다.
2. `resolveRefluxSearchDuplicateDecision(context)`를 추가한다.
3. cache에는 `positive/negative` 최종값이 아니라
   - “같은 normalized title로 검색에서 잡힌 row 목록”
   - 또는 최소한 caller별 재판정이 가능한 row 정보
   를 저장한다.
4. final positive/negative는 `deleteGalleryId + currentPostNo`를 보고 계산한다.

쉽게 예시로:

- 검색 결과 row:
  - `thesingularity #1108445`
  - `galaxy #555`
- 현재 처리 중인 글:
  - `thesingularity #1108445`

그러면:

- 자기 자신 `#1108445`는 제외
- `galaxy #555`가 남아 있으므로 positive

반대로 검색 결과가 자기 자신 한 줄뿐이면:

- `#1108445` 처리 시에는 negative
- 나중에 `#1112000` 처리 시에는 positive

즉 fetch cache와 final decision cache를 분리해야 한다.

### 4.2 runtime용과 “지금 당장 결론이 필요한 곳”을 분리한다

이번 패치에는 search duplicate 관련 판단 위치가 4종류 있다.

1. steady-state 게시글 분류 루프
2. 공격 진입 시 attack mode 판정
3. 공격 진입 직후 initial sweep
4. 공격 중 widen 판정

이 넷은 같은 검색 브로커를 써도 성격이 다르다.

#### A. steady-state run loop

현재처럼 non-blocking 성격 유지가 맞다.

- dataset/hot cache positive는 즉시 후보
- miss는 queue에 넣고 이번 사이클은 넘긴다
- 다음 사이클부터 cache positive로 빨리 잡는다

이건 이미 [features/post/scheduler.js:748](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L748) 의 `filterRefluxCandidatePosts(...)`가 하는 방향과 맞다.

#### B. attack mode 판정

여기는 지금 결론이 필요하다.

이유:

- `DEFAULT`로 갈지
- `SEMICONDUCTOR_REFLUX`로 갈지를
- 공격 진입 시점에 정해야 하기 때문이다.

따라서 여기서는 `peek`가 아니라 `resolve`를 써야 한다.

#### C. initial sweep

여기도 지금 결론이 필요하다.

이유:

- initial sweep은 one-shot이고
- 여기서 놓치면 cutoff 때문에 다시 못 볼 수 있기 때문이다.

따라서 initial sweep도 `resolve`를 써야 한다.

#### D. 공격 중 widen 판정

여기는 오히려 live resolve를 피하는 게 맞다.

이유:

- [features/monitor/scheduler.js:198](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L198)
  에서 매 cycle 돈다.
- 여기까지 resolve-heavy로 만들면 공격 중 지속 요청이 늘어난다.

따라서 widen은:

- dataset
- 이미 warm된 positive cache
- Han/CJK 신호

만 보고 판단하고,

- 좁은 모드를 유지할 확신이 없으면 `DEFAULT`로 넓힌다

가 맞다.

정리:

- run loop: `peek + enqueue`
- attack mode decision: `resolve`
- initial sweep: `resolve`
- widen decision: `cache/dataset only`, no forced live resolve

### 4.3 자동 공격 모드 판정은 async wrapper로 감싼다

현재 `buildAttackModeDecision(...)`는 pure sync 함수다.

- [features/post/attack-mode.js:79](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L79)

이 함수 자체는 유지하는 쪽이 낫다.

이유:

- CJK/dataset-only 계산은 pure helper로 남기는 게 테스트하기 좋다.
- search duplicate까지 이 파일에 직접 넣으면 책임이 커진다.

권장 구조:

1. `attack-mode.js`
   - 기존 sync helper 유지
2. `monitor/scheduler.js`
   - `decideAttackMode(metrics)`를 `async`로 바꾸거나
   - `decideAttackModeWithSearch(metrics)` 같은 async wrapper 추가
3. wrapper 내부에서:
   - 먼저 `ensureRefluxSearchDuplicateBrokerLoaded()` 보장
   - 샘플 5개 추출
   - CJK count 계산
   - dataset hit 먼저 계산
   - dataset miss에 대해서만 `resolveRefluxSearchDuplicateDecision(...)`
   - 최종 `refluxLikeCount` 재계산
   - 기존 threshold 정책으로 결과 반환

즉 attack-mode.js의 기준식은 살리고,
search duplicate는 monitor가 바깥에서 주입하는 구조가 가장 깔끔하다.

추가로 여기서 중요한 연결 포인트가 하나 더 있다.

- monitor는 `refluxSearchGalleryId`를 자기 config에 안 들고 있다.
- 따라서 attack mode decision wrapper는
  - `this.config`가 아니라
  - `this.postScheduler.config`
  기준으로 search gallery를 해석해야 한다.

그리고 resolver 로직은

- [features/post/scheduler.js:720](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L720)
- [background/background.js:1666](/home/eorb915/projects/dc_defense_suite/background/background.js#L1666)

에 이미 중복이 있으므로,
이번엔 monitor에 세 번째 복사본을 만들지 말고 공용 helper로 정리하는 쪽이 맞다.

### 4.4 initial sweep은 역류기일 때 resolved filter를 써야 한다

현재:

- `buildInitialSweepPosts(snapshot, attackMode)`가 sync dataset-only다.

권장 변경:

1. `DEFAULT`
   - 기존 유지
2. `CJK_NARROW`
   - 기존 유지
3. `SEMICONDUCTOR_REFLUX`
   - 새 async helper 사용

예시 이름:

- `resolveInitialSweepPosts(snapshot, attackMode, context)`
- 또는 `buildInitialSweepPostsResolved(...)`

실제 동작:

1. snapshot에서 1~N페이지 유동글 추출
2. 제목 없는 글 제외
3. dataset/hot cache positive 즉시 포함
4. miss는 `resolveRefluxSearchDuplicateDecision(...)`로 확인
5. positive만 initial sweep 대상에 포함

이렇게 해야:

- 공격 진입 시 이미 떠 있던 search duplicate 글도
- initial sweep 1회에서 바로 같이 처리된다.

### 4.5 monitor source도 search duplicate 런타임을 타게 바꾼다

현재:

- [features/post/scheduler.js:711](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L711)

패치 방향:

```js
function shouldUseSearchDuplicateForCurrentRun(source, attackMode) {
    return normalizeAttackMode(attackMode) === ATTACK_MODE.SEMICONDUCTOR_REFLUX;
}
```

즉 source 구분을 빼고:

- `manual`
- `monitor`

둘 다 역류기 모드면 search duplicate 경로를 타게 한다.

이미 필요한 나머지 재료는 대부분 있다.

- start 시 broker preload/reset:
  - [features/post/scheduler.js:97](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L97)
- loadState 시 broker preload:
  - [features/post/scheduler.js:592](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L592)
- monitor가 child에 attackMode 전달:
  - [features/monitor/scheduler.js:437](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L437)
  - [features/monitor/scheduler.js:453](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L453)

즉 여기서 바꿀 핵심은:

- source 제한 제거
- monitor 쪽 attack mode async 결정
- initial sweep resolved filter 추가
- monitor pre-start search에서 broker preload를 직접 보장
- `refluxSearchGalleryId`는 monitor config가 아니라 post config에서 공용 helper로 읽기

이다.

### 4.6 `maybeWidenAttackMode(...)`는 오히려 cheap widen으로 유지한다

현재:

- [features/monitor/scheduler.js:397](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L397)

처음에는 `maybeWidenAttackMode(...)`도 `decideAttackMode(...)`와 똑같이 async resolve 기반으로 맞추는 안을 생각할 수 있다.

그런데 실제 코드 흐름을 다시 보면 그건 좋지 않다.

- widen은 attacking loop에서 매 cycle 호출된다.
- 따라서 여기를 live resolve로 바꾸면 공격 중 지속 검색이 늘어난다.

이번 문서 기준 권장안은 이거다.

1. `enterAttackMode(...)`의 첫 분기는 resolve-heavy
2. `maybeWidenAttackMode(...)`는 별도 cheap helper 사용
3. cheap helper는:
   - dataset hit
   - positive cache/hotset
   - Han/CJK 여부
   정도만 본다
4. 결과가 애매하면 좁은 모드를 유지하려 하지 말고 `DEFAULT`로 확장

즉:

- 초기 진입은 정밀하게
- 공격 중 유지/해제는 보수적으로 넓게

가 맞다.

### 4.7 async enter/widen에는 stale result 가드를 넣는다

위 2.8에서 본 것처럼,
이번 패치부터는 monitor 내부 async 구간이 길어진다.

그래서 최소한 아래 가드는 필수다.

1. `enterAttackMode(...)`에서 heavy await 뒤 `isRunning/phase/session` 재검사
2. state 쓰기 직전 한 번 더 재검사
3. `suspendUidWarningAutoBanForAttack()` 호출 전 재검사
4. `maybeWidenAttackMode(...)`에서도 적용 결과 반영 전 재검사

권장 구현:

- 간단히는 `if (!this.isRunning) return;`
- 더 안전하게는 `attackResolutionToken` 같은 generation/token 필드 추가

중요한 건:

- stop 후 늦게 끝난 async 결과가
- attack state를 다시 덮지 못하게 하는 것이다

### 4.8 initial sweep 순서는 유지하고, 병렬화는 이번 범위에서 빼 둔다

현재 순서:

1. initial sweep
2. child post start

search duplicate 때문에 initial sweep이 느려질 수는 있다.

그래도 이번 1차에서는
child를 먼저 띄우고 initial sweep을 같은 scheduler로 병렬 실행하는 쪽이 더 위험하다.

이유:

- 같은 scheduler 인스턴스의
- run loop / classifyOnce / deleteOnce
- 가 섞일 수 있기 때문이다

따라서 이번 문서의 권장 방향은:

- 순서는 유지
- initialSweepPages 범위는 그대로 좁게 유지
- 향후 정말 지연이 문제로 확인되면
  - child와 분리된 one-shot 작업기
  - 또는 별도 API helper
  쪽을 다음 단계로 검토

이다.

### 4.9 monitor 공격 세션 중 search gallery 기준은 흔들리지 않게 한다

위 2.12 기준으로,
이번 패치에선 search gallery 기준이 공격 세션 중 바뀌지 않게 해야 한다.

1차 권장안:

- background에서 저장 차단

예시 문구:

- `역류 검색 갤 ID는 자동 감시 역류기 대응 중에는 변경할 수 없습니다. 감시 자동화를 정지한 뒤 변경하세요.`

장점:

- 구현이 가장 작다
- initial sweep / child run / attack decision 기준이 안 갈린다

세션 고정(snapshot) 방식도 가능하지만,
그건 state 필드와 전달 경로가 더 늘어난다.
이번 1차 문서 기준에서는 차단이 더 안전하다.

---

## 5. 권장 상세 플로우

### 5.1 공격 감지 후 attack mode 판정

1. `evaluateNormalState(...)`가 공격 streak 충족
2. `enterAttackMode(metrics, currentSnapshot)` 진입
3. `pickAttackModeSamplePosts(metrics)`로 최신 유동글 5개 추출
4. 샘플별 처리:
   - CJK 패턴이면 `hanLikeCount +1`
   - dataset hit면 `refluxLikeCount +1`
   - dataset miss면 `resolveRefluxSearchDuplicateDecision(...)`
   - resolve positive면 `refluxLikeCount +1`
5. 최종 count로 기존 규칙 적용:
   - `han >= 3 && reflux == 0` -> `CJK_NARROW`
   - `reflux >= 3 && han == 0` -> `SEMICONDUCTOR_REFLUX`
   - 둘 다 섞이면 `DEFAULT`

예시:

- 샘플 5개 중
  - dataset hit 1개
  - search duplicate positive 2개
  - 일반글 2개
- 최종 `refluxLikeCount = 3`
- 자동 분기는 `SEMICONDUCTOR_REFLUX`

### 5.2 공격 진입 직후 initial sweep

1. attack cutoff 저장
2. attack mode가 역류기면 snapshot 유동글에 resolved reflux filter 적용
3. 걸린 글들을 `pendingInitialSweepPosts`에 넣음
4. classify 1회
5. delete 1회
6. 그 뒤 child post scheduler 시작

예시:

- 공격 감지 시점 1~2페이지 유동글 14개
- dataset hit 2개
- search duplicate positive 4개
- 최종 initial sweep 대상 6개

그러면:

- 이 6개를 먼저 한 번 치우고
- 이후 child scheduler는 cutoff 이후 새 글만 본다

### 5.3 공격 중 child post scheduler

1. monitor source + attackMode = `SEMICONDUCTOR_REFLUX`
2. `shouldUseSearchDuplicateForCurrentRun(...)`가 true
3. run loop에서 `filterRefluxCandidatePosts(...)` 경로 사용
4. dataset/hot cache positive는 즉시 후보
5. miss는 queue 적재
6. 이후 cache positive가 된 글은 다음 사이클에서 빠르게 분류

즉 steady-state는 지금 수동 역류기와 거의 같은 구조가 된다.

### 5.4 공격 중 widen 판정

1. 현재 attack mode가 narrow(`CJK` 또는 `역류기`)
2. 최신 샘플 5개를 다시 본다
3. 여기서는 live search resolve를 하지 않는다
4. dataset/positive cache/Han-CJK 신호만 본다
5. 그 신호만으로도 현재 좁은 모드를 유지할 자신이 없으면 `DEFAULT`로 확장한다

예시:

- 현재 `SEMICONDUCTOR_REFLUX`
- 최신 샘플 5개 중 dataset/cache positive는 1개뿐
- 나머지는 일반글인지, 아직 cache miss인 최신 역류기인지 불명확

그러면:

- 굳이 live search 4건을 더 때리지 말고
- `DEFAULT`로 넓혀서 놓치지 않는 쪽으로 간다

---

## 6. 파일별 수정 포인트

### 6.1 [features/post/reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js)

필수 수정:

- `pendingMap`을 promise-aware 구조로 변경
- `resolveRefluxSearchDuplicateDecision(context)` 추가
- cache entry를 row-based 또는 caller 재판정 가능한 구조로 변경
- self-match를 final decision 단계에서 계산
- 기존 `getRefluxSearchDuplicatePositiveDecision / getRefluxSearchDuplicateDecision / enqueue...`는 run loop용 shortcut로 유지

권장 이유:

- 댓글 broker와 같은 패턴이라 사고가 덜 난다.
- monitor attack decision / initial sweep / steady-state를 한 broker로 통일할 수 있다.

### 6.2 [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js)

필수 수정:

- `shouldUseSearchDuplicateForCurrentRun(...)`에서 source 제한 제거
- 필요 시 `filterRefluxCandidatePosts(...)` 내부 decision helper를 새 broker 구조에 맞게 조정
- loadState/start/stop에서 broker reset/load 연동이 monitor reflux에도 자연스럽게 맞는지 점검
- monitor가 pre-start에서 broker를 직접 쓴 뒤 `postScheduler.start(...)`가 와도, warm cache를 깨지 않는지 확인
- monitor 공격 중 search gallery 기준이 바뀌지 않는다는 전제하에 resolver가 같은 값을 계속 읽는지 확인

추가 확인 포인트:

- `stop()`은 이미 `resetSearchDuplicateRuntime()`을 부른다.
  - [features/post/scheduler.js:132](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L132)
- monitor 공격 종료 시 `postScheduler.stop()`도 불린다.
  - [features/monitor/scheduler.js:593](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L593)

즉 reset 시점은 이미 거의 맞춰져 있다.

### 6.3 [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)

필수 수정:

- `decideAttackMode(...)` async화
- `enterAttackMode(...)`에서 await
- `maybeWidenAttackMode(...)`는 live resolve가 아닌 cheap widen helper로 재구성
- monitor용 search gallery 해석은 `this.postScheduler.config` 기준으로 통일
- stale async result 가드 추가
- initial sweep target 계산을 async resolved helper로 전환
- 필요 시 attack session 동안 사용할 resolved search gallery를 로그/상태용으로만 잡아둘지 검토

여기가 이번 패치의 중심이다.

### 6.4 [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)

필수 수정:

- `getConfigUpdateBlockMessage(...)`에
  - monitor attacking 중
  - post `refluxSearchGalleryId` 변경 차단
  를 추가

이유:

- 지금은 manual running만 runtime transition을 탄다.
- monitor child running은 그냥 config merge가 된다.
- 이번 패치 뒤에는 그게 attack session 기준 흔들림으로 이어진다.

### 6.5 [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js)

권장 수정:

- pure helper 성격은 유지
- 필요하다면 `buildAttackModeDecisionFromCounts(...)` 같은 보조 pure helper를 추가

예시:

- 현재는 `buildAttackModeDecision(samplePosts, ...)`가 내부에서 dataset count를 직접 계산한다.
- 패치 후에는 monitor wrapper에서 `hanLikeCount`, `refluxLikeCount`, `sampleTitles`, `sampleCount`를 만든 뒤
- pure helper에 넘기는 구조가 더 테스트하기 쉽다.

반드시 이 구조일 필요는 없지만,
sync pure helper와 async I/O helper를 분리하는 방향이 안전하다.

---

## 7. 이번 패치에서 바꾸지 않는 것

혼선을 막기 위해 명시한다.

- 공격 진입 threshold 자체는 안 바꾼다.
- `attackNewPostThreshold`, `attackFluidRatioThreshold`는 그대로 둔다.
- 게시글 분류 탭 UI는 새로 안 만든다.
  - `역류 검색 갤 ID`는 이미 있음
  - [popup/popup.js:1478](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1478)
  - [popup/popup.js:2471](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2471)
- 공통 `galleryId` 의미도 안 바꾼다.
- search request delay/jitter 기본값도 이번 문서 범위에서는 안 건드린다.
- child와 initial sweep을 병렬로 돌리는 구조 변경도 이번 범위에서는 안 건드린다.
- attack session 중 search gallery를 동적으로 바꾸는 UX도 이번 범위에서는 안 허용한다.

즉 이번 건은:

- “자동 역류기 분기와 실제 동작을 수동 역류기 수준으로 맞추는 연결 패치”

다.

---

## 8. 정적 검증 체크리스트

패치 전에 미리 확인해야 할 포인트를 최대한 쪼갰다.

### 8.1 attack mode 판정

1. 샘플 유동글이 5개 미만이면 기존처럼 `DEFAULT` 유지되는가
2. dataset hit 3개, CJK 0개면 `SEMICONDUCTOR_REFLUX`가 되는가
3. dataset 1개 + search duplicate 2개 + CJK 0개면 `SEMICONDUCTOR_REFLUX`가 되는가
4. dataset 0개 + search duplicate 3개 + CJK 0개면 `SEMICONDUCTOR_REFLUX`가 되는가
5. CJK 3개 + reflux 0개면 `CJK_NARROW`가 되는가
6. CJK 3개 + reflux 1개면 `DEFAULT` 유지되는가
7. CJK 1개 + reflux 3개면 현재 정책상 `DEFAULT` 유지되는가
8. 검색 error 2개 + dataset 1개면 threshold 미달로 `DEFAULT`가 되는가
9. search pending 상태를 attack mode 결정에 그대로 두지 않고 resolve까지 기다리는가
10. attack mode reason 문자열이 dataset/search 혼합 케이스에서도 이해되게 남는가
11. attack mode decision이 `monitor.config`가 아니라 `postScheduler.config.refluxSearchGalleryId`를 기준으로 검색하는가

### 8.2 initial sweep

12. attack 진입 시점에 이미 보이던 dataset miss 글도 search duplicate positive면 initial sweep 대상에 들어가는가
13. initial sweep에서 자기 자신만 검색되는 글은 제외되는가
14. initial sweep 후 child run cutoff 때문에 누락이 생기지 않는가
15. `DEFAULT` attack mode에서는 initial sweep 동작이 기존과 같게 유지되는가
16. `CJK_NARROW` attack mode에서는 initial sweep 동작이 기존과 같게 유지되는가
17. initial sweep 중 search error가 나면 전체 공격 진입이 깨지지 않고 로그만 남기는가
18. initial sweep 대상 수 로그가 resolved 최종 결과 기준으로 찍히는가
19. initial sweep이 0건이면 기존처럼 바로 완료 처리되는가
20. initial sweep resolve-heavy 비용 때문에 child start가 느려질 수 있다는 점이 문서/구현 의도와 일치하는가

### 8.3 monitor child runtime

21. `source='monitor'` + `SEMICONDUCTOR_REFLUX`에서 `filterRefluxCandidatePosts(...)`를 실제 타는가
22. `source='monitor'` + `DEFAULT`에서는 기존 cutoff 기반 일반 분류만 타는가
23. `source='monitor'` + `CJK_NARROW`에서는 기존 CJK 필터만 타는가
24. 공격 종료 후 child stop 시 broker runtime이 reset되는가
25. 저장 상태 복원 후 monitor attack 중이었다면 broker load가 빠지지 않는가
26. monitor 중간에 `attackMode`가 `DEFAULT`로 widen되면 search duplicate 경로가 해제되는가
27. monitor 실행 중 post `updateConfig` 자체가 global lock으로 막혀, `refluxSearchGalleryId`가 세션 중간에 바뀌지 않는가

### 8.4 broker 캐시/판정

28. 같은 제목이라도 `#1001` self-only 결과가 `#1002`의 negative로 재사용되지 않는가
29. positive cache가 caller 문맥이 달라도 과하게 false positive를 만들지 않는가
30. `pending` 상태에서 같은 제목 재요청이 들어오면 중복 fetch 대신 같은 pending promise를 기다리는가
31. reset 시 pending promise들이 `cancelled` 등 안전한 결과로 정리되는가
32. search error cache가 retry cooldown 이후 다시 재시도되는가
33. row cache expiry 후에는 새 fetch를 다시 타는가
34. title normalization은 현재 filler/zero-width 제거 정책과 충돌하지 않는가
35. search query용 normalization과 compare key용 normalization 역할이 섞이지 않는가
36. row cache는 full search rows 전체가 아니라 caller 재판정에 필요한 matched rows만 저장해 storage 크기가 과도하게 늘지 않는가

### 8.5 연결/호출부

37. `enterAttackMode(...)`만 async 바꾸고 call site를 안 바꾸는 누락이 없는가
38. `maybeWidenAttackMode(...)`가 live resolve를 매 cycle 치지 않도록 분리됐는가
39. `buildInitialSweepPosts(...)`를 유지하더라도 reflux 경로에서는 더 이상 dataset-only helper가 직접 쓰이지 않는가
40. `postScheduler.start({ source: 'monitor', attackMode: this.attackMode })` 흐름에서 별도 UI 값 없이도 `refluxSearchGalleryId`를 기존 post config에서 읽는가
41. monitor에서 search gallery resolver를 또 복붙하지 않고 공용 helper를 쓰는가
42. manual 역류기 토글 동작은 이번 패치로 깨지지 않는가
43. comment 역류기 broker/flow와 이름만 비슷하고 실제 import가 꼬이지 않는가
44. stop 도중 늦게 끝난 async attack decision이 attack state를 다시 덮지 않는가
45. stop 도중 늦게 끝난 async attack decision이 uid autoban suspend를 다시 호출하지 않는가
46. background의 post config update가 monitor attacking 중엔 search gallery 변경을 차단하는가

### 8.6 운영 관점

47. attack mode 판정 때 샘플 5개만 resolve하므로 네트워크 부하가 과도하게 늘지 않는가
48. initial sweep은 공격 진입 1회만 resolve-heavy 경로를 쓰고, steady-state는 기존 queue 기반으로 유지되는가
49. `maybeWidenAttackMode(...)`가 매 cycle live search를 치지 않아 지속 부하가 늘지 않는가
50. search duplicate 브로커 로그가 monitor와 manual에서 모두 이해 가능한 문구로 남는가
51. dataset이 비어 있어도 search duplicate만으로 자동 역류기 판정이 가능해지는지, 아니면 정책상 dataset 보조만 허용할지 의도가 명확한가
52. stale `샘플 3개` 같은 로그 문구가 실제 상수(5개)와 맞게 정리되는가

---

## 9. 작업 전 결론

이번 재검토 기준 결론은 이렇다.

1. 지금 구조는 “자동이 역류기라고 말하지만 실제 동작은 수동 역류기보다 약한 상태”가 맞다.
2. 그 이유는 단순히 `shouldUseSearchDuplicateForCurrentRun(...)` 한 줄 문제가 아니라,
   - 자동 attack mode 판정
   - initial sweep
   - monitor child runtime
   - post broker cache 모델
   - search gallery 설정 경로
   - attack session 중 config 변경 차단
   - 공격 중 widen 전략
   - async stop race
   까지 같이 걸려 있기 때문이다.
3. 추가 스펙은 더 없어도 된다.
   - 검색 기준 갤 ID UI는 이미 있다.
   - 기존 getSearch 경로도 이미 있다.
4. 다만 패치는 처음 버전 문서 그대로가 아니라,
   - `maybeWidenAttackMode(...)`를 live resolve로 만들지 않고
   - monitor가 `postScheduler.config`를 기준으로 search gallery를 읽고
   - stale async result 가드를 넣는 방향으로 들어가야 한다.
5. 위 보강점을 포함하면 다음 패치는 이 문서대로 바로 들어갈 수 있다.

즉 이번 문서 기준으로는:

- “문서만 그럴듯하고 실제 코드 연결이 비는 상태”

는 아니다.

실제 패치 전에 먼저 잡아야 할 연결 이슈까지 포함해서,
바로 구현 가능한 수준으로 정리된 상태다.
