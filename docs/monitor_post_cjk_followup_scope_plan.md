# monitor / post 한자 공격 후속 범위 조정 구현 플랜

## 배경

현재 한자/CJK형 공격 모드는 이미 1차 구현이 들어가 있다.

기준 문서:
- [monitor_unicode_attack_mode_plan.md](/home/eorb915/projects/dc_defense_suite/docs/monitor_unicode_attack_mode_plan.md)

하지만 지금 운영 요구는 그 문서보다 한 단계 더 구체적이다.

이번 후속 요구는 3개다.

1. 자동 감시가 공격 감지 후 broad initial sweep를 할 때, 기존 `1~2페이지 유동 전체`가 아니라 **1페이지만** 처리
2. 자동 감시가 `중국어/한자 감지 모드`일 때는 broad initial sweep 대신 **한자 제목 글만** 처리
3. 수동 게시글 분류에서 `중국어/한자 공격` 토글이 ON이면, **토글 ON 시점 이후 cutoff를 무시**하고 설정한 페이지 범위 안의 한자 제목 글을 전부 분류

즉 이번 작업은 “한자 공격 모드 자체를 새로 넣는 것”이 아니라,

- 자동 initial sweep 범위 축소
- `cjk_narrow` initial sweep 의미 고정
- 수동 CJK 모드의 cutoff 예외

이 세 가지를 실제 코드 흐름에 맞게 후속 조정하는 작업이다.

---

## 현재 실제 로직

### 1. monitor snapshot은 기본적으로 1~N페이지 전체를 모은다

현재 자동 감시는 `monitorPages`만큼 페이지를 돌면서 snapshot을 만든다.

- page loop: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L211)
- 기본값 `monitorPages: 2`: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L51)

중요한 점:

- 현재 `currentSnapshot` 안의 post 객체에는 **몇 페이지에서 왔는지 정보가 없다**
- 즉 지금 상태로는 snapshot 안에서 `1페이지 글만` 다시 골라낼 수 없다

이 부분이 이번 1번 요구에서 가장 중요한 구조 문제다.

### 2. 자동 공격 진입 시 initial sweep 대상은 snapshot 전체 기준이다

현재 공격 진입 흐름:

1. `enterAttackMode(metrics, currentSnapshot)`
2. `resolveAttackCutoffSnapshot(currentSnapshot)`
3. `buildInitialSweepPosts(attackSnapshot, attackMode)`
4. `pendingInitialSweepPosts` 저장
5. `performInitialSweep()`에서 분류 + 삭제

관련 코드:
- 공격 진입: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L289)
- initial sweep 대상 생성: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L298)
- initial sweep 실행: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L453)
- 대상 빌더: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L872)

현재 `buildInitialSweepPosts()` 의미:

- `default`
  - snapshot 안의 유동글 전체
- `cjk_narrow`
  - snapshot 안의 유동글 중 `isHanCjkSpamLikePost(post)`만

즉 **현재 2번 요구는 구조상 일부 이미 들어가 있다.**

다만 지금은 `cjk_narrow`도 snapshot 범위가 `1~monitorPages` 전체라서,
1번 요구를 넣는 과정에서 이 분기를 실수로 같이 `1페이지만`으로 줄이면 안 된다.

### 3. 수동 게시글 분류는 지금 항상 cutoff를 먼저 건다

현재 수동/자동 공통 게시글 분류 흐름:

1. `start()`에서 cutoff 저장
2. run loop에서 `parseFluidPosts()`
3. `cutoffPosts = fluidPosts.filter(isPostAfterCutoff(...))`
4. 그 다음에 attack mode 필터 적용

관련 코드:
- `start()`: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L64)
- cutoff 추출: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L95)
- run loop 필터: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L220)
- attack mode 필터: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L222)

즉 지금 수동 CJK 토글 ON도 실제론:

- 설정 페이지 범위 안의 한자 제목 전체를 보는 게 아니라
- **시작 시점 cutoff 이후 글 중에서만**
- 한자 제목을 분류한다

이건 이번 3번 요구와 다르다.

### 4. 수동 post 설정 변경은 실행 중에도 들어간다

현재 background의 `updateConfig`는 post가 실행 중이어도 막지 않는다.

- updateConfig generic merge: [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L226)
- 실행 중 변경 차단은 `monitorPages` 같은 일부 기능에만 있음: [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L500)

단, 중요한 완화 조건이 하나 있다.

- monitor가 실행 중일 때는 `post.updateConfig` 자체가 이미 막힌다
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L535)
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L536)

즉 이번 후속 작업에서 실행 중 mode 전환 helper가 실제로 다뤄야 하는 범위는

- **monitor 관리 하위 child가 아니라**
- **standalone 수동 post 실행 중 전환**

쪽으로 한정된다.

즉 이번 3번 요구를 넣을 때는

- 수동 post가 이미 돌고 있는 상태에서
- `manualAttackMode: default <-> cjk_narrow`

전환이 들어오는 경우도 같이 설계해야 한다.

이걸 빼먹으면 `cutoffPostNo = 0` 같은 값이 broad mode에 그대로 남아서,
오히려 페이지 범위 안 유동글 전체를 다시 다 분류하는 사고가 날 수 있다.

---

## 이번 후속 변경의 정확한 목표

### 자동 감시

- 공격 감지 자체는 기존처럼 `monitorPages` 범위에서 계속 한다
- 단, attack 진입 직후 initial sweep 대상은 다음처럼 나눈다

#### `default`

- `1페이지` 유동글만 initial sweep
- `2페이지 이상` 기존 글은 initial sweep 대상에서 제외
- 이후 child scheduler는 기존처럼 cutoff 이후 새 글을 처리

#### `cjk_narrow`

- attack snapshot 전체(`1~monitorPages`) 중
- `한자 제목`으로 판정된 유동글만 initial sweep
- 이후 post child도 기존처럼 cutoff 이후 새 글 중 한자 제목만 분류

즉 자동 감시 initial sweep 규칙은 최종적으로 이렇게 갈라진다.

- `default` = **1페이지 broad**
- `cjk_narrow` = **전체 snapshot narrow**

### 수동 게시글 분류

#### `default`

- 기존 그대로
- 시작 시 cutoff 저장
- cutoff 이후 유동글 전체 분류

#### `cjk_narrow`

- 수동 source일 때만 특별 취급
- 설정한 `minPage ~ maxPage` 범위 안에서
- **기존 글 포함**
- 한자 제목 글 전부 분류

즉 수동 CJK 모드는 “좁게 + 기존 글 포함”이다.

---

## 구현 방향

### 1. monitor snapshot에 `sourcePage`를 태깅한다

대상 파일:
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L211)

권장 구현:

```js
const posts = parseBoardPosts(html).map((post) => ({
  ...post,
  sourcePage: page,
}));
```

이 방식이 필요한 이유:

- 현재 snapshot에는 page provenance가 없다
- 따라서 `default initial sweep = 1페이지만`을 하려면
  - page 정보를 snapshot 안에 실어야 한다

이 방식의 장점:

- 추가 fetch가 필요 없다
- attack 감지와 initial sweep이 같은 snapshot 기준을 공유한다
- `computeMetrics()`는 `post.no`만 보기 때문에 `sourcePage` 추가로 기존 비교 로직이 깨지지 않는다

추가 제약:

- `pollBoardSnapshot()`는 지금 `page = 1 -> N` 순서로 돈다
- 그리고 같은 `post.no`는 **처음 본 항목만 유지**한다
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L213)
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L224)

이건 이번 설계에 유리하다.

이유:

- 같은 글이 page 1과 page 2에 동시에 보이면
- page 1에서 먼저 읽은 `sourcePage: 1` 정보가 유지되기 때문이다

즉 이번 문서 기준으로는:

- page loop는 **오름차순 유지**
- dedupe는 **first-hit 유지**

가 전제 조건이다.

비권장 대안:

- attack 진입 시점에 1페이지를 다시 fetch해서 initial sweep snapshot을 따로 만드는 방식

이 방식은 가능은 하지만

- attack 직후 snapshot이 또 바뀔 수 있고
- 네트워크 호출도 하나 더 생기므로
- 이번 요구에는 `sourcePage` 태깅 방식이 더 맞다

### 2. `buildInitialSweepPosts()` 의미를 mode별로 명확히 갈라서 고정한다

대상 파일:
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L872)

변경 후 의미:

#### `default`

```js
post.isFluid && post.sourcePage === 1
```

#### `cjk_narrow`

```js
post.isFluid && isHanCjkSpamLikePost(post)
```

중요:

- 여기서는 `cjk_narrow`에 `sourcePage === 1` 조건을 넣지 않는다
- 즉 `cjk_narrow`는 기존처럼 attack snapshot 전체 범위에서 한자 제목만 남긴다

이유:

- 이게 바로 사용자 요청 2번의 의미다
- “1,2페이지 싹 삭제” 대신 “1,2페이지 안에서 한자 제목만 삭제”로 가야 한다

즉 이번 변경은:

- `default`만 page 1로 줄이고
- `cjk_narrow`는 narrow filter를 유지

하는 구조다.

추가로 중요한 점:

- 현재 `enterAttackMode()`는 로그용 broad 기준 수치를
  `buildInitialSweepPosts(attackSnapshot)`로 얻고 있다
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L297)

하지만 이번 변경 후에는 `buildInitialSweepPosts()`의 `default` 의미가
`snapshot 전체 유동`이 아니라 `1페이지 broad`로 바뀐다.

즉 구현할 때 broad 기준 수치 helper를 따로 분리해야 한다.

권장:

- `buildAllFluidSnapshotPosts(snapshot)`
- `buildInitialSweepPosts(snapshot, attackMode)`

를 나눠서 쓰는 방식

이걸 안 나누면 `cjk_narrow` 로그가

- 실제론 `1~2페이지 유동 24개 -> 필터 후 19개`

여야 하는데

- 잘못하면 `1페이지 유동 12개 -> 필터 후 19개`

같은 잘못된 숫자가 찍힐 수 있다.

### 3. monitor 로그 문구도 새 의미에 맞춰 분리한다

대상 파일:
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L315)

권장 로그:

#### `default`

- `🧹 initial sweep 대상 1페이지 유동 12개`

#### `cjk_narrow`

- `🧹 initial sweep 대상 1~2페이지 유동 24개 -> 한자/CJK 필터 후 19개`

이 로그가 필요한 이유:

- 운영자가 지금 broad page1 sweep인지
- 전체 snapshot narrow sweep인지

즉시 구분할 수 있어야 하기 때문이다.

### 4. 수동 post 쪽에 `shouldApplyCutoffForCurrentRun()` 분기를 추가한다

대상 파일:
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L220)

권장 helper:

```js
function shouldApplyCutoffForCurrentRun() {
  if (this.currentSource === 'monitor') {
    return true;
  }

  return this.getEffectiveAttackMode() !== ATTACK_MODE.CJK_NARROW;
}
```

그리고 run loop는 이렇게 갈라진다.

```js
const basePosts = shouldApplyCutoff
  ? fluidPosts.filter((post) => isPostAfterCutoff(post, this.config.cutoffPostNo))
  : fluidPosts;

const candidatePosts = basePosts.filter((post) => isEligibleForAttackMode(post, effectiveAttackMode));
```

이렇게 해야:

- monitor child는 기존 cutoff 의미 유지
- 수동 default도 기존 cutoff 의미 유지
- 수동 cjk만 기존 글 포함 분류

가 동시에 성립한다.

### 5. 수동 CJK start 시에는 cutoff 캡처를 건너뛴다

대상 파일:
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L64)

현재는 manual start도 explicit cutoff가 없으면 무조건 `captureCutoffPostNoWithRetry()`를 탄다.

하지만 수동 CJK는 cutoff를 안 쓸 거라서,
이 캡처를 그대로 두면:

- 쓸모없는 fetch/파싱이 추가되고
- 로그도 실제 동작과 다르게 보인다

따라서 manual start에서 아래 조건이면:

- `source === 'manual'`
- `config.manualAttackMode === 'cjk_narrow'`

그냥:

- `cutoffPostNo = 0`
- `cutoff disabled` 로그 출력

으로 가는 편이 맞다.

권장 로그:

- `🧷 수동 게시글 분류 cutoff 미사용 (중국어/한자 공격 수동 모드)`

### 6. 가장 중요한 숨은 이슈: 실행 중 수동 토글 ON/OFF 전환

대상 파일:
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L226)
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L64)

현재는 `updateConfig`가 실행 중에도 그냥 merge된다.

이 상태에서 manual CJK 예외를 넣으면 아래 사고가 가능하다.

#### 위험 시나리오

1. 수동 post 실행 중
2. 관리자가 `중국어/한자 공격` 토글 ON
3. 구현이 단순히 `shouldApplyCutoff = false`만 바꾸고 `cutoffPostNo = 0`으로 둠
4. 이후 관리자가 실행 중 다시 토글 OFF
5. 이번엔 broad mode인데 `cutoffPostNo`가 0이라
6. 페이지 범위 안 유동글 전체를 다시 broad 분류할 수 있음

따라서 **ON/OFF 전환 규칙을 background updateConfig 단계에서 명시적으로 처리**해야 한다.

그런데 여기서 끝이 아니다.

현재 `updateConfig`는 단순 merge라서:

- background가 config를 바꾸는 동안
- post scheduler run loop는 동시에 현재 cycle을 계속 돌 수 있다
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L234)
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L193)

즉 mode 전환을 plain merge로 처리하면:

- 어떤 페이지는 old mode
- 다음 페이지는 new mode

처럼 중간 상태가 섞일 수 있다.

특히 이번 요구는

- `default -> cjk_narrow`: 기존 글 포함으로 의미가 크게 바뀌고
- `cjk_narrow -> default`: fresh cutoff 재캡처가 필요하므로

단순 merge보다 **직렬화된 전환 helper**가 더 안전하다.

권장 방향:

- `transitionManualAttackModeWhileRunning(nextConfig)`

같은 전용 경로를 두고

1. 필요한 값 계산
2. 현재 run loop를 안전하게 끊거나 다음 cycle로 넘김
3. `currentPage = 0`으로 되돌림
4. config/cutoff 반영
5. 저장

순으로 처리하는 편이 맞다.

이게 필요한 이유:

- 현재 post run loop는
  `for (let page = startPage; page <= maxPage; page++)`
  구조다
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L200)

즉 실행 중에 바깥에서 `scheduler.currentPage = 0`만 바꿔도

- 이미 돌고 있는 현재 `for` 루프의 local `page` 변수는 그대로라서
- 즉시 1페이지부터 다시 시작하지 않는다

따라서 “다음 cycle부터 첫 페이지부터 다시”를 진짜 보장하려면

- run loop를 한 번 안전하게 끊고 재개하거나
- loop 내부에서 전환 플래그를 보고 break/reseed 하게 만들거나

둘 중 하나가 필요하다.

여기서 한 가지 더 중요한 점:

- 이 전환을 public `stop()` / `start()` 조합으로 때우는 방식은 권장하지 않는다

이유:

- `stop()`은 사용자 입장에서 실제 정지 로그를 남긴다
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L92)
- `start()`는 새 시작 로그와 cutoff 로그를 다시 남긴다
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L84)
- 즉 단순 전환인데도 UI/로그상 “정지 후 재시작”처럼 보여 운영자가 혼동할 수 있다

따라서 전환은 가능하면:

- 내부 전환 helper
- 또는 reseed 전용 경로

로 처리하는 편이 맞다.

권장 규칙:

#### `default -> cjk_narrow` 전환, post가 수동 실행 중

- `scheduler.config.manualAttackMode = 'cjk_narrow'`
- `scheduler.config.cutoffPostNo = 0`
- `scheduler.currentPage = 0`
- 저장
- 다음 cycle부터 **첫 페이지부터 다시**
- 설정 페이지 범위 안의 기존 한자 제목 포함 분류

#### `cjk_narrow -> default` 전환, post가 수동 실행 중

- **다음에 적용될 page range 기준으로** fresh cutoff를 다시 캡처
- 성공 시
  - `scheduler.config.cutoffPostNo = freshCutoff`
  - `manualAttackMode = 'default'`
  - `scheduler.currentPage = 0`
- 실패 시
  - config update 자체를 거부
  - 에러 메시지 반환

이걸 빼면 안전하지 않다.

여기서 “다음에 적용될 page range 기준”이 중요한 이유:

- 사용자가 같은 저장에서
  - `minPage/maxPage`
  - `manualAttackMode`

를 같이 바꿀 수 있기 때문이다.

즉 helper는

- 먼저 `nextConfig = { ...scheduler.config, ...message.config }`
- 그 `nextConfig` 기준으로 cutoff 계산

순서로 가는 편이 맞다.

### 7. popup 설명 문구도 실제 의미에 맞게 바꾼다

대상 파일:
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L386)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L510)

현재 문구:

- `수동 게시글 분류에서 한자 제목만 좁게 분류`

후속 변경 후 실제 의미:

- 수동 CJK ON이면
  - 좁게 분류는 맞지만
  - 동시에 **기존 한자 제목도 포함**

따라서 문구는 예를 들어 이렇게 바꾸는 편이 맞다.

- `수동 게시글 분류에서 한자 제목만 분류 (ON 시 현재 설정 페이지의 기존 글도 포함)`

추가로 UI 의미도 문서에 박아둘 필요가 있다.

현재 popup은:

- 체크박스를 바꿨다고 바로 적용되지 않고
- `저장` 버튼을 눌러야 실제 config가 반영된다
  - [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L510)

즉 사용자 표현의 “토글 ON 시점”은 실제로는

- 체크박스를 켠 순간이 아니라
- **저장 성공 시점**

으로 보는 것이 맞다.

여기서 실제 연결 이슈가 하나 더 있다.

- 현재 `post` 저장 버튼 핸들러는 `response.success === true`일 때만 UI를 갱신하고
- 실패(`success: false`)일 때는 경고창도, 상태 복원도 하지 않는다
  - [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L510)

기존에는 `post.updateConfig`가 사실상 거의 실패하지 않았기 때문에 큰 문제가 아니었다.

하지만 이번 후속 작업부터는:

- 실행 중 `cjk_narrow -> default` 전환에서 fresh cutoff 캡처 실패
- 실행 중 직렬화 전환 helper 내부 검증 실패

같은 케이스가 실제로 발생할 수 있다.

따라서 popup도 같이 바꿔야 한다.

권장:

- `response.success === false`면 `alert(response.message)` 출력
- `refreshAllStatuses()`로 실제 저장 상태 다시 복원

이걸 안 넣으면 운영자는

- 체크를 바꾸고 저장했는데
- 실제로는 반영이 실패한 상태를
- 팝업에서 바로 눈치채기 어렵다

즉 이건 단순 UX 보강이 아니라, **이번 패치부터 새로 생기는 실제 실패 경로를 UI가 받아낼 수 있게 하는 연결 수정**이다.

---

## 실제 변경 포인트 요약

### monitor

대상 파일:
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)

변경 포인트:

1. `pollBoardSnapshot()`에서 `sourcePage` 태깅
2. `buildInitialSweepPosts(snapshot, attackMode)` 분기 변경
3. initial sweep 로그 문구 분리

### post

대상 파일:
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js)

변경 포인트:

1. manual CJK일 때 start cutoff 캡처 스킵
2. `shouldApplyCutoffForCurrentRun()` 추가
3. run loop에서 `basePosts`를 cutoff 적용 여부에 따라 분기
4. manual CJK 로그 문구 변경

### background

대상 파일:
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)

변경 포인트:

1. `post.updateConfig`에 실행 중 mode 전환 helper 추가
2. `default -> cjk_narrow` 전환 시 cutoff 0 처리
3. `cjk_narrow -> default` 전환 시 fresh cutoff 캡처 후 merge
4. mode 전환 시 `currentPage = 0`으로 되돌려 첫 페이지부터 다시 스캔
5. cutoff 재캡처는 `nextConfig` 기준 page range로 수행
6. 단순 config live merge 대신 직렬화된 전환 경로 사용
7. 전환 helper를 탄 경우에는 generic `scheduler.config = { ...scheduler.config, ...message.config }` 경로로 다시 떨어지지 않게 분기

### popup

대상 파일:
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)

변경 포인트:

1. 수동 CJK 토글 설명 문구 최신화
2. `post.updateConfig` 실패 시 alert + 상태 재동기화 처리 추가

---

## 파생 이슈와 결정 사항

### 0. 공통 설정 변경은 이번 범위의 핵심 리스크가 아니다

관련 코드:
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L164)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L173)

공통 설정 변경은 이미:

- busy feature가 하나라도 있으면 거부되고
- 전부 정지한 뒤에만 반영된다

즉 이번 후속 작업에서 실행 중 전환 위험을 신경 써야 하는 핵심 경로는

- `updateSharedConfig`

가 아니라

- `post.updateConfig`

쪽이다.

추가로 현재 수동 post의

- `minPage/maxPage`
- `requestDelay/cycleDelay`

같은 일반 live config 변경은 예전부터 plain merge 기반이었다.

즉 이번 문서가 집중하는 위험은

- **mode 의미가 크게 바뀌는 전환**

이고,

- 일반 숫자 설정 live merge 전체를 이번 패치에서 재설계하는 것은 범위를 넘는다

고 보는 편이 맞다.

단, 이번 패치에서는 background `updateConfig` 안에

- **post 전용 실행 중 mode 전환 분기**

가 새로 들어갈 수밖에 없다.

현재 코드는:

- 검증 후
- `scheduler.config = { ...scheduler.config, ...message.config }`
- `saveState()`

로 바로 내려간다
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L234)
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L250)

따라서 실제 구현에서는 이 순서를 바꿔야 한다.

권장:

1. `feature === 'post'`
2. `scheduler.isRunning`
3. `manualAttackMode` 전환 또는 그에 준하는 helper 필요 조건인지 검사
4. 맞으면 전용 helper 실행 후 **즉시 return**
5. 아니면 기존 generic merge 경로 유지

이걸 안 하면:

- helper가 fresh cutoff를 잡아도
- 이후 generic merge/save가 다시 내려가면서
- 전환용 로그/상태/에러 처리 경계가 흐려질 수 있다

즉 이번 후속 작업은 “background generic updateConfig 위에 post 전용 분기 하나를 얹는 작업”으로 보는 편이 정확하다.

### 1. 자동 감지 범위와 initial sweep 범위는 분리 유지

이번 변경에서도 `monitorPages`는 공격 감지용 snapshot 범위를 뜻한다.

즉:

- 공격 감지는 기존처럼 `1~monitorPages`
- broad initial sweep만 `1페이지`

이 구조로 유지한다.

이유:

- 공격 감지 민감도는 유지하고
- 기존 글 오탐 피해만 줄이기 위해서다

### 2. `cjk_narrow`는 요청 2 때문에 오히려 “1페이지 제한”을 받지 않아야 한다

이건 이번 문서에서 가장 중요한 의사결정이다.

정리하면:

- 요청 1은 `default` broad initial sweep을 page1로 줄이자는 뜻
- 요청 2는 `cjk_narrow`에서는 broad 삭제 대신 한자 제목만 처리하자는 뜻

즉 두 요청은 **같은 분기를 줄이는 게 아니라 분기를 갈라서 서로 다르게 처리**하자는 의미다.

### 3. 수동 CJK는 “현재 설정 페이지 범위 전체”를 스캔한다

여기서 “기존 글 포함”의 기준은:

- 갤러리 전체 과거 글 전부가 아니라
- `minPage ~ maxPage` 범위 안 현재 보이는 글들

즉 수동 CJK는:

- monitor broad initial sweep처럼 1페이지 고정이 아니고
- 사용자가 수동으로 지정한 page range 전체를 본다

### 4. 현재 helper는 Han 기준이다

관련 코드:
- [features/post/parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L1)

현재 `isHanCjkSpamLikePost()`는 이름은 CJK처럼 보이지만 실제 구현은 `Script=Han` 기반이다.

즉 이번 후속 작업에서도 실질적으로는:

- 중국어/한자/Hanja형 제목

을 잡는 기준으로 본다.

이건 현재 공격 유형과는 맞는다.

### 5. 배포 직후 mid-attack 복원은 1회성 예외가 있을 수 있다

이번 변경으로 monitor snapshot/post 객체에 `sourcePage`가 새로 들어간다.

정상적인 새 공격 세션에는 문제가 없다.

하지만 패치를 배포하는 순간 이미 monitor가 `ATTACKING` 상태였고,
그 상태가 구버전 구조로 storage에 저장돼 있었다면:

- `pendingInitialSweepPosts`
- `lastSnapshot`

에는 `sourcePage`가 없을 수 있다.

이 경우 배포 직후 그 **한 번의 복원 세션**에서는
새 page1 initial sweep 규칙이 완전히 반영되지 않을 수 있다.

즉 구조 blocker는 아니지만,

- 패치 배포 후 monitor를 한 번 정지/재시작하거나
- 새 공격 세션부터 정책이 안정 적용된다고 보는 편이 안전하다

---

## 구현 순서 권장안

1. `monitor.pollBoardSnapshot()`에 `sourcePage` 태깅 추가
2. `buildInitialSweepPosts()`를 `default page1 / cjk_narrow full snapshot Han-only`로 변경
3. monitor initial sweep 로그 문구 변경
4. post run loop에 `shouldApplyCutoffForCurrentRun()` 도입
5. manual CJK start의 cutoff 캡처 스킵 추가
6. background `post.updateConfig`에 실행 중 mode 전환 처리 추가
7. popup 설명 문구 업데이트

이 순서가 좋은 이유:

- 먼저 자동 initial sweep 범위를 안정적으로 분리하고
- 그 다음 수동 cutoff 예외를 넣어야
- manual 전환 로직의 위험을 분리해서 검증하기 쉽다

---

## 정적 검증 체크리스트

### 자동 감시

1. `monitorPages = 2`, `default` 공격 진입 시 initial sweep 대상이 `sourcePage === 1` 글만 잡히는가
2. `monitorPages = 2`, `cjk_narrow` 공격 진입 시 page 2 한자 제목도 initial sweep에 포함되는가
3. `default`에서 page 2 기존 유동글이 initial sweep 삭제 대상에서 빠지는가
4. `cjk_narrow`에서 page 1 일반 제목 유동글이 initial sweep 삭제 대상에서 빠지는가
5. `cjk_narrow`에서 page 2 한자 제목 유동글이 initial sweep 삭제 대상에 남는가
6. `monitorPages = 1`일 때도 default/cjk 양쪽이 자연스럽게 동작하는가
7. attack mode widening(`cjk_narrow -> default`) 이후 future child filtering만 넓어지고, 이미 만든 initial sweep 대상은 유지되는가

### 수동 post

8. 수동 `default` start는 기존처럼 cutoff를 캡처하는가
9. 수동 `cjk_narrow` start는 cutoff 캡처를 건너뛰는가
10. 수동 `cjk_narrow`는 설정 페이지 범위 안 기존 한자 제목을 바로 분류하는가
11. 수동 `cjk_narrow`는 설정 페이지 범위 안 기존 일반 제목 유동글은 분류하지 않는가
12. 수동 `default`는 여전히 cutoff 이후 유동글만 분류하는가
13. 수동 실행 중 `default -> cjk_narrow` 전환 시 다음 cycle부터 기존 한자 제목 포함 분류로 바뀌는가
14. 수동 실행 중 `cjk_narrow -> default` 전환 시 fresh cutoff를 다시 잡고 broad mode로 안전하게 복귀하는가
15. `cjk_narrow -> default` 전환 중 cutoff 캡처 실패 시 config update가 거부되는가
16. 실행 중 mode 전환 시 `currentPage = 0`으로 돌아가 첫 페이지부터 다시 스캔하는가
17. 실행 중 mode 전환 중 old/new mode가 같은 cycle에 섞이지 않게 직렬화되는가
18. page range와 mode를 같이 저장할 때 fresh cutoff가 `nextConfig` 기준으로 계산되는가
19. `currentPage = 0`만 바꾼 경우 현재 `for` 루프가 그대로 진행되는 문제를 실제로 막았는가

### 상태/복원

20. 수동 CJK 실행 중 service worker 재시작 후에도 `manualAttackMode` 기준으로 cutoff 미적용 상태가 유지되는가
21. monitor ATTACKING 복원 후 initial sweep/page1 분기 의미가 깨지지 않는가
22. `resetPostSchedulerState()` 이후 runtime mode / cutoff 상태가 안전하게 초기화되는가
23. `stopDormantMonitorChildSchedulers()`가 post runtime mode만 비우고 manual config는 건드리지 않는가
24. patch 배포 직후 구버전 ATTACKING state 복원 시 1회성 page provenance 누락이 운영상 허용 가능한가

### 로그/UI

25. monitor 로그에 `1페이지 broad`와 `full snapshot narrow`가 구분되어 보이는가
26. `cjk_narrow` 로그의 broad 기준 수치가 `1페이지`가 아니라 `전체 snapshot 유동`으로 찍히는가
27. 수동 CJK ON 설명 문구가 실제 동작과 일치하는가
28. 수동 CJK ON 상태에서 로그가 `cutoff 이후`라고 잘못 말하지 않는가
29. “토글 ON 시점”이 실제론 저장 성공 시점이라는 점이 운영자에게 혼동 없이 보이는가
30. 실행 중 mode 전환 실패 시 popup 저장 버튼이 에러 메시지를 보여주고 실제 상태를 다시 동기화하는가
31. post 전용 전환 helper를 탄 요청이 background generic merge 경로로 다시 떨어지지 않는가

---

## 결론

이번 후속 요구는 단순히 if 문 3개 추가로 끝나는 작업이 아니다.

핵심은 두 가지다.

1. 자동 initial sweep은 **page provenance가 필요하다**
2. 수동 CJK cutoff 예외는 **실행 중 mode 전환 로직까지 같이 설계해야 안전하다**

즉 구현 포인트는 실제로 아래 두 줄에 압축된다.

- monitor: `default = 1페이지 broad`, `cjk_narrow = full snapshot Han-only`
- manual post: `manual cjk = cutoff 무시`, 단 `ON/OFF 전환은 background에서 안전하게 처리`

이 문서 기준이면 바로 패치 작업에 들어가도 된다.
