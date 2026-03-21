# 게시물 자동화 / 수동 게시글 분류 한자/CJK형 공격 모드 구현 플랜

## 배경

현재 게시물 자동화(`features/monitor/scheduler.js`)는 공격 감지 후 아래 순서로 동작한다.

1. `pollBoardSnapshot()`으로 1~N페이지 snapshot 수집
2. `computeMetrics()`에서 `newPosts`, `newFluidCount`, `fluidRatio` 계산
3. `evaluateNormalState()`에서 공격 조건 충족 시 streak 누적
4. streak 충족 시 `enterAttackMode()` 진입
5. `pendingInitialSweepPostNos = buildInitialSweepPostNos(attackSnapshot)`으로 **공격 시점 snapshot의 모든 유동글**을 initial sweep 대상으로 저장
6. `performInitialSweep()`에서 그 대상 전체를
   - `postScheduler.classifyPostsOnce()`로 도배기 분류
   - `deletePosts()`로 1회 삭제
7. 이후 `post/ip` child scheduler는 `attackCutoffPostNo` 이후 새 글만 처리

관련 코드:
- 공격 판정: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L228)
- 공격 진입: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L266)
- initial sweep 대상 생성: [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L692)
- 게시물 분류 후보 필터: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L184)
- 제목 파싱: [features/post/parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L94)

## 문제

이 구조는 감지까지 걸린 40초 안의 도배글을 한 번에 정리하는 데는 유리하다.

하지만 공격 종류가 두 가지라 단순 제목 필터만으로는 부족하다.

- 중국어/한자/CJK형 짧은 제목 도배
- 예전 사람이 쓴 제목/내용을 복붙해서 역류시키는 공격

즉,

- `중국어처럼 보이면 잡자`만으로는 역류기 공격을 놓친다.
- 반대로 지금처럼 `공격 시점 snapshot의 모든 유동글`을 initial sweep에 넣으면 무고한 유동 피해가 커진다.

따라서 메인 전략은 여전히 **기존 공격 플로우 유지**여야 하고, 중국어/한자/CJK형 공격일 때만 **좁은 모드**로 전환하는 것이 맞다.

## 목표

공격 감지 직후, **공격이 확정된 그 poll에서 새로 들어온 유동글 제목 3개 정도만** 샘플로 보고 이번 공격 세션을 둘 중 하나로 분류한다.

- `default`
  - 현재와 동일
  - initial sweep도 기존처럼 snapshot 유동글 전체 처리
  - 역류기/일반 도배 대응
- `cjk_narrow`
  - 중국어/한자/CJK형 짧은 제목 공격으로 판정된 경우
  - initial sweep과 이후 post child 분류 대상을 **한자/CJK 패턴 글만** 좁혀서 처리

핵심은:

- 제목 필터를 항상 쓰지 않는다.
- **공격 시작 순간 한 번만 모드 판정**
- 그 공격 세션 동안 모드 유지

추가로 수동 게시글 분류(`post`)는 관리자가 직접 공격 유형을 고를 수 있게 한다.

- `일반 공격`
  - 현재와 동일
  - cutoff 이후 유동글 전체 분류
- `중국어/한자/CJK 공격`
  - cutoff 이후 유동글 중 한자/CJK 패턴 제목만 분류
- 수동 게시글 분류 쪽에는 체크말고 지금 토글밑에 중국어공격토글이 따로 있는걸로 하자


즉 최종 목표는 두 갈래다.

1. 자동 감시 공격 세션에서는 monitor가 모드를 자동 판정
2. 수동 게시글 분류에서는 관리자가 모드를 직접 선택

## 구현 방향

### 1. monitor에 공격 세션 모드 상태 추가

대상 파일:
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)

추가 상태:

- `attackMode = 'default' | 'cjk_narrow'`
- `attackModeReason = ''`
- `attackModeSampleTitles = []`

초기화 위치:
- constructor
- `start()`
- `stop()`
- `clearAttackSession()`
- `loadState()` / `saveState()` / `getStatus()`

의미:

- `attackMode`
  - 이번 공격 세션의 처리 방식
- `attackModeReason`
  - 왜 한자/CJK형 모드로 봤는지 로그/디버그용
- `attackModeSampleTitles`
  - 판정에 사용한 제목 샘플 저장용

중요:

- 이 상태는 **monitor 공격 세션 상태**로만 유지한다.
- `postScheduler.config` 같은 영구 설정 객체에는 넣지 않는다.

이유:

- post scheduler는 `config` 전체를 저장/복원한다.
- 여기에 `attackMode`를 넣으면 공격 종료 후에도 `cjk_narrow`가 남아서 수동 게시글 분류나 다음 실행까지 좁아질 위험이 있다.

### 2. 공격 진입 시 모드 판정 함수 추가

대상 파일:
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)

새 함수 예시:

- `decideAttackMode(metrics, attackSnapshot)`
- `pickAttackModeSamplePosts(metrics)`
- `isHanCjkSpamLikePost(post)`
- `analyzeHanCjkAttackSample(samplePosts)`

판정 기준:

1. 샘플 후보는 **공격이 확정된 그 poll의 `metrics.newPosts` 중 `isFluid === true`인 글**만 사용한다
2. 최근 유동글 전체나 snapshot 전체 유동글은 모드 판정 샘플로 쓰지 않는다
3. 샘플은 최신 글번호 기준으로 최대 3개
4. 샘플 3개 중 **1개라도** 아래 조건을 만족하면 `cjk_narrow`
5. 샘플이 너무 적거나 애매하면 무조건 `default`

이유:

- 최근 유동글 전체를 보면 이미 earlier initial sweep이나 다른 자동 처리 대상이 섞여 오판할 수 있다
- 운영 의도는 “지금 공격을 만든 새 글들”만 보고 모드를 고르는 것이다
- 따라서 모드 판정은 attack streak 전체 누적보다 **공격 확정 poll의 새 유동글** 기준이 더 맞다

권장 기준:

- 제목에 Han/CJK 글자가 1개 이상 있음
- 가능하면 제목 길이가 너무 짧은 1~2글자 노이즈는 제외
- 필요하면 동일/유사 패턴 반복은 로그 참고용 보조 정보로만 사용

중요:

- 이 판정은 **Han/CJK 글자가 실제로 보일 때만** `cjk_narrow`
- 애매하면 무조건 `default`

이유:

- 역류기 공격을 놓치면 안 되기 때문

### 3. initial sweep 대상을 attack mode에 따라 다르게 만들기

현재:

- `buildInitialSweepPostNos(snapshot)`은 snapshot 유동글 전체를 반환

변경:

- `buildInitialSweepTargets(snapshot, attackMode)`
- 또는 `buildInitialSweepPostNos(snapshot, attackMode)`

동작:

- `default`
  - 기존과 동일
  - snapshot 유동글 전체
- `cjk_narrow`
  - snapshot 유동글 중 `isHanCjkSpamLikePost(post)`만 포함

대상 파일:
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L692)

### 4. post child scheduler에도 같은 모드 적용

현재:

- post child는 `parseFluidPosts()` 후 `cutoffPostNo` 이후 모든 유동글을 분류

변경:

- `postScheduler`에 **세션 전용 attack mode 상태** 추가
  - 예: `postScheduler.currentAttackMode`
  - 또는 `setAttackMode(mode)` / `clearAttackMode()` 메서드
- `monitor.ensureManagedDefensesStarted()`에서 attack mode를 post child에 주입
- `features/post/scheduler.js`에서 candidate filter 직전에 attack mode 기반 필터 추가

중요 구현 방식:

- `postScheduler.start()`가 `attackMode` start option을 받을 수 있게 하거나
- 최소한 run loop 시작 전에 `currentAttackMode`를 먼저 세팅해야 한다

이유:

- monitor가 post child를 켤 때 `start()` 이후에 attack mode를 나중에 꽂으면
- 첫 cycle 일부가 기존 broad 모드로 먼저 돌 수 있다
- 즉 **첫 분류부터 올바른 모드**가 적용되게 시작 옵션으로 넘기는 편이 안전하다

구현 형태:

- `isEligibleForAttackMode(post, attackMode)`
- `candidatePosts = fluidPosts.filter(post => isPostAfterCutoff(...) && isEligibleForAttackMode(post, this.currentAttackMode))`

동작:

- `default`
  - 기존과 동일
- `cjk_narrow`
  - 한자/CJK 패턴 제목만 분류

주의:

- IP child는 도배기탭에 이미 분류된 글만 차단하므로 별도 제목 필터는 필요 없다.
- 즉 attack mode는 사실상 `monitor + post`만 알면 충분하다.
- `attackMode`는 persisted config가 아니라 **run-time session field**여야 한다.
- `monitor.stopManagedDefenses()` / `clearAttackSession()` / monitor reset 시점에 post child의 세션 모드도 반드시 초기화해야 한다.
- 수동 `post.start()`도 런타임 모드를 명시적으로 초기화하거나, 저장된 수동 `manualMode`에서 다시 세팅해야 한다.
- background의 `stopDormantMonitorChildSchedulers()`처럼 monitor child를 강제로 끄는 경로에서도 post child 세션 모드를 같이 비워야 한다.
- service worker 재시작 후 monitor가 `ATTACKING` 상태로 복원되면 `monitor.ensureManagedDefensesStarted()`가 post child 세션 모드를 다시 주입해야 한다.

권장:

- 한자/CJK 판정 함수는 monitor와 post가 **같은 구현을 공유**해야 한다
- monitor는 그 함수로 공격 모드를 결정하고
- post child / 수동 post는 같은 함수로 실제 분류 대상을 필터링한다

이유:

- monitor 판정 기준과 post 필터 기준이 다르면
  `cjk_narrow`로 들어갔는데 정작 post가 다른 글을 분류하는 불일치가 생긴다

구현 위치 권장:

- `features/post/parser.js`에 helper export 추가
- 또는 `features/post/attack-mode.js` 같은 shared helper 파일 분리

### 4-1. 수동 게시글 분류 모드 추가

대상 파일:
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js)
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)

핵심:

- 수동 게시글 분류는 자동 판정이 필요 없다.
- 관리자가 직접 공격 유형을 고르면 된다.

권장 UI:

- 기존 게시글 분류 설정에 `분류 모드` 추가
  - `일반 공격`
  - `중국어/한자/CJK 공격`

동작:

- `일반 공격`
  - 기존과 동일
  - `parseFluidPosts()` 결과 전체를 cutoff 이후 기준으로 분류
- `중국어/한자/CJK 공격`
  - cutoff 이후 유동글 중 `isHanCjkSpamLikePost(post)`만 분류

중요:

- 이 수동 모드는 **post 기능 전용**
- `ip` 기능은 바꾸지 않는다
- monitor가 자동으로 post child를 켜는 동안에는 수동 설정값을 바꾸지 못하게 유지한다
- monitor 실행 중에는 **실제 런타임 모드 우선순위가 monitor session mode > 수동 저장 mode**가 된다

이유:

- IP 차단은 이미 도배기탭에 들어온 글만 대상으로 움직인다
- 따라서 “어떤 글을 도배기탭으로 보낼지”만 `post`에서 바꾸면 충분하다

### 5. UI/상태 표시 추가

대상 파일:
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)

상태 표시 권장:

- 현재 단계 아래에 `공격 모드`
  - `DEFAULT`
  - `CJK_NARROW`

디버그용 표시 권장:

- 최근 공격 샘플 제목 2~3개
- 또는 로그만으로 충분하면 상태칸엔 모드만 표시

로그 예시:

- `🧠 공격 모드 판정: DEFAULT (샘플 부족 또는 일반 패턴)`
- `🧠 공격 모드 판정: CJK_NARROW (새 유동글 샘플 3개 중 1개 이상이 Han/CJK 제목)`
- `🧹 initial sweep 대상 24개 -> 한자/CJK 필터 후 19개`

### 6. background 변경 필요 여부

대상 파일:
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)

필수 변경은 크지 않지만, **reset 경로 반영은 필요**하다.

- monitor 상태를 popup으로 전달하는 구조는 이미 있음
- `getStatus()`에 `attackMode`, `attackModeReason`이 들어가면 popup이 받아서 표시 가능
- 별도 메시지 타입 추가는 필요 없을 가능성이 높다
- 다만 아래 reset 경로에서 stale mode/sample이 남지 않도록 같이 비워야 한다
  - monitor `resetStats`
  - 공통 설정 변경 시 monitor reset helper
  - child scheduler 강제 중단/복원 경로

### 7. IP 차단 변경 불필요

대상 파일:
- [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js)

결론:

- `ip`는 손대지 않는다.

현재 구조에서:

1. `post`가 도배기탭으로 무엇을 보낼지 결정
2. `ip`는 도배기탭에 들어온 글을 그대로 차단/삭제

즉 이번 개선은
- 자동 감시의 `post child`
- 수동 `post`

두 곳만 바꾸면 충분하다.

## 권장 판정 로직

### 기본 원칙

- 이 모드는 운영상 **중국어/한자/CJK형이 조금만 보여도 바로 좁혀 잡는 공격 대응 모드**다.
- 운영 기준상 새 유동글 샘플에 Han/CJK 글자가 조금이라도 보이면 `cjk_narrow` 후보로 본다.

### LLM 없이 어떻게 구분하는가

이 판정은 **뜻을 이해하는 방식이 아니라 글자 종류를 세는 방식**이다.

즉:

- 제목에 Han/CJK 글자가 있는지
- 필요하면 한국어 글자도 같이 세는지

를 본다.

예:

- `안녕하세요 특이점`
  - Han/CJK 글자 없음
- `驅籟炡坎翬窕龠塍`
  - Han/CJK 글자 다수

자바스크립트 기준 구현 방향:

- `\p{Script=Han}` 또는 CJK 범위로 한자 수 계산
- 필요하면 `\p{Script=Hangul}`로 한글 수 계산
- 공백/숫자/기호는 제외

즉 이 기능은

- “중국어 의미를 이해하는 것”이 아니라
- “제목에 Han/CJK 글자가 실제로 들어있는가”를 보는 것이다

그래서 LLM 없이도 충분히 구현 가능하다.

### 추천 휴리스틱

샘플 제목 3개 기준으로:

- 제목 하나에 Han/CJK 글자가 1개 이상 있으면 “한자/CJK형 샘플”로 본다
- 샘플 3개 중 **1개 이상**이 한자/CJK형이면 `cjk_narrow`

추가 가산점:

- 공백/구두점 패턴 유사
- 닉네임/아이피 분포가 공격적으로 반복

### 왜 이 방식이 오늘 공격엔 먹히는가

오늘 같은 케이스는:

- 제목이 짧고
- 한자/CJK 비율이 매우 높고
- 샘플 몇 개만 봐도 패턴이 눈에 띈다

그래서 `cjk_narrow`로 판정되면 무고한 일반 유동글이 같이 밀릴 가능성을 줄일 수 있다.

반대로 역류기 공격은:

- 정상 한국어 제목/본문을 복붙할 수 있으므로
- 이런 한자/CJK 패턴 판정만으로는 못 잡는다

그래서 이 기능은 **전체 공격 분류기**가 아니라,
중국어/한자/CJK형 공격일 때만 자동 감시를 좁게 돌리는 보조 모드로 써야 한다.

## 수동 토글 정책

자동 감시 monitor와 수동 게시글 분류 post를 분리해서 본다.

### 자동 감시 monitor

- 별도 수동 토글을 두지 않는다.
- 공격 진입 시 monitor가 한 번 자동 판정
- 그 공격 세션 동안만 `default` 또는 `cjk_narrow`
- 공격 종료 시 자동 초기화

이유:

- monitor는 공격 세션용 보조 모드이기 때문
- 사용자가 켜둔 채 잊어버리면 stale mode 위험이 있기 때문

### 수동 게시글 분류 post

- 여기에는 별도 모드 선택 UI를 둔다.
- 관리자가 직접 보고 판단하는 기능이므로 수동 선택형이 맞다.

UI 해석 원칙:

- post 패널의 `분류 모드`는 **수동 저장값**
- monitor 패널의 `공격 모드`는 **현재 자동 공격 세션의 실제 런타임 모드**

즉 monitor가 post child를 켠 상황에서:

- post 토글은 ON처럼 보일 수 있다
- 하지만 post 패널의 모드 표시를 현재 자동 공격 모드처럼 오해하면 안 된다
- 실제 자동 공격 모드는 monitor 패널에서 별도로 보여주는 것이 맞다

즉 정리:

- 자동 감시 monitor: 자동 판정, 별도 토글 없음
- 수동 게시글 분류 post: `일반 공격 / 중국어/한자/CJK 공격` 선택형 UI

권장하지 않는 것:

- 본문 fetch 추가
- LLM 판정
- 모든 공격에 제목 필터 강제 적용

이유:

- 구현이 무거워지고
- 역류기 대응이 약해질 수 있음

## 핵심 리스크와 방어 원칙

### 1. `cjk_narrow` 오탐은 즉시 삭제로 이어진다

현재 initial sweep은:

1. 분류
2. 같은 대상 `deletePosts()`

순서로 바로 삭제까지 간다.

즉 `cjk_narrow`에서 잘못 포함된 글은 “조금 덜 분류”가 아니라 **즉시 삭제**될 수 있다.

따라서:

- `cjk_narrow`는 “Han/CJK 글자가 있는 샘플 1개 이상”일 때만 진입
- 그 외엔 `default`

이 원칙이 필수다.

추가 주의:

- 이 기준은 운영 의도상 매우 공격적이다
- 즉 정상 한국어 제목에 한자 1글자만 섞여 있어도 `cjk_narrow`로 좁아질 수 있다
- 따라서 이 기준은 “오늘 같은 공격을 우선 잡는다”는 운영 판단이 전제다

### 2. initial sweep에서 빠진 글은 나중에 자동 복구되지 않는다

공격 진입 시 cutoff는 고정된다.

즉:

- initial sweep에서 snapshot 내부 공격 글을 잘못 제외하면
- child scheduler는 cutoff 이후 새 글만 보기 때문에
- 그 글은 이번 공격 세션에서 사실상 영구 미처리될 수 있다

따라서:

- Han/CJK 샘플이 없으면 `default`
- 필요하면 `cjk_narrow`에서도 snapshot 내부 제외 대상을 로그로 충분히 남겨야 한다

### 3. stale attack mode 방지

반드시 초기화해야 하는 위치:

- monitor `start()`
- monitor `stop()`
- `clearAttackSession()`
- `enterRecoveringMode()` 이후 NORMAL 복귀
- `resetStats`
- 공통 설정 변경 reset helper
- `resetPostSchedulerState`
- post child 강제 중단 후 복원 경로

### 4. 공격 중 패턴 전환 대응

중요 시나리오:

- 공격 시작은 중국어/한자/CJK형이라서 `cjk_narrow`로 진입
- 그런데 공격 중간에 상대가 한국어 역류기/일반형으로 패턴을 바꿈

이때 현재 세션 모드를 끝까지 `cjk_narrow`로 고정하면:

- post child가 새 글 중 Han/CJK형 제목만 계속 분류하고
- 한국어 역류기 글은 cutoff 이후 새 글이어도 놓칠 수 있다

따라서 권장 동작:

- 공격 진입 시점에는 한 번만 `default / cjk_narrow`를 고른다
- 단, **이미 `cjk_narrow`로 들어간 세션만** ATTACKING 중 매 poll마다 최신 `metrics.newPosts` 샘플 3개를 다시 본다
- 그 최신 샘플에 Han/CJK 글자가 전혀 없는데도 공격 상태가 계속 유지되면
  - `cjk_narrow -> default`로 **넓히는 것만 허용**한다
- 반대로 `default -> cjk_narrow`로 중간 전환은 굳이 하지 않아도 된다

이유:

- `default`는 중국어형도, 한국어 역류기도 둘 다 처리 가능하다
- 문제는 `cjk_narrow`가 너무 좁아서 패턴 전환 후 새 글을 놓칠 수 있다는 점이다
- 그래서 세션 중간 전환은 **좁힘이 아니라 넓힘만** 허용하는 편이 안전하다
- 단, 이렇게 넓혀도 initial sweep 시점에 이미 제외된 snapshot 내부 글은 되살아나지 않는다
- 즉 widening은 **그 이후 새 글 손실을 줄이는 장치**이지, 초기에 제외된 글 복구 장치는 아니다

## 상세 구현 순서

1. `features/monitor/scheduler.js`
   - `attackMode`, `attackModeReason`, `attackModeSampleTitles` 상태 추가
   - save/load/getStatus/clearAttackSession 반영
2. `features/monitor/scheduler.js`
   - `decideAttackMode()` 구현
   - `enterAttackMode()`가 `metrics`도 함께 받아, 공격 확정 poll의 `newPosts`로 샘플 3개를 골라 모드 결정 후 저장
3. `features/monitor/scheduler.js`
   - `buildInitialSweepPostNos()`를 attack mode aware하게 변경
4. `features/post/scheduler.js`
   - persisted `config`가 아닌 session field 기반 `attackMode` 추가
   - `start({ source, attackMode })` 또는 동등한 방식으로 첫 cycle 전 모드 주입
   - candidate filter에 `isEligibleForAttackMode()` 추가
5. shared helper 정리
   - monitor와 post가 동일한 한자/CJK 판정 helper를 공유하게 정리
6. `features/monitor/scheduler.js`
   - `ensureManagedDefensesStarted()`에서 post child에 `attackMode`를 시작 옵션 또는 run loop 시작 전 주입
   - `stopManagedDefenses()`와 `clearAttackSession()`에서 post child attack mode 초기화
   - service worker resume 시 `monitor ATTACKING -> ensureManagedDefensesStarted()` 경로에서도 post child mode 재주입
7. `features/post/scheduler.js`, `popup/popup.js`, `popup/popup.html`
   - 수동 게시글 분류용 `분류 모드` 설정 추가
   - `일반 공격 / 중국어/한자/CJK 공격` 저장/복원/표시
8. `popup/popup.js`, `popup/popup.html`
   - 상태 표시에 공격 모드 추가
   - 필요 시 샘플 제목/사유 표시
9. 로그 정리
   - 공격 진입 시 모드 판정 로그
   - initial sweep 필터 결과 로그
10. `background/background.js`
   - monitor reset helper / `resetPostSchedulerState` / 공통 설정 reset / dormant child stop 경로에서 stale mode/sample 초기화 반영

## 테스트 플랜

### 정상 유지

- 일반 공격/역류기 공격에서는 `default`로 유지되고 기존과 동일하게 동작
- attack mode를 안 쓰는 평상시 자동 감시 child는 기존과 동일
- 수동 게시글 분류 `일반 공격` 모드도 기존과 동일

### 한자/CJK형 공격

- 샘플 제목 3개 중 1개 이상에 Han/CJK 글자가 있으면 `cjk_narrow`
- initial sweep 대상이 줄어드는지 확인
- post child도 cutoff 이후 한자/CJK 패턴 글만 분류하는지 확인
- initial sweep 삭제 대상과 분류 대상이 로그상 일치하는지 확인
- 수동 게시글 분류 `중국어/한자/CJK 공격` 모드에서도 같은 제목 패턴 필터가 적용되는지 확인

### 애매한 케이스

- 샘플 3개 모두 Han/CJK 글자가 없으면 `default`로 남아야 함

### 공격 확정 poll 샘플 확인

- 공격 확정 poll의 새 유동글 3개 중 1개만 Han/CJK형이어도 `cjk_narrow`로 가는지 확인
- 공격 확정 poll의 새 유동글이 1~2개뿐이면 보수적으로 `default`로 남는지 확인
- 공격 확정 poll의 새 유동글 3개가 모두 일반형이면 `default`로 가는지 확인

### 회귀 방지

- attack mode가 recovering/stop 후 초기화되는지
- resetStats / 공통 설정 변경 후에도 초기화되는지
- save/load 후에도 모드가 꼬이지 않는지
- popup 상태 표시가 저장된 값과 일치하는지
- monitor 실행 중 post 패널의 저장 모드와 monitor 패널의 런타임 모드가 서로 헷갈리지 않게 표시되는지

## 최종 판단

이 기능은 **본문/내용 분석이 아니라 공격 세션 모드 선택**으로 보는 게 맞다.

구현 난이도는 중간 정도다.

- 어렵지 않은 부분
  - 상태 추가
  - 모드 전달
  - initial sweep / cutoff 이후 분류 조건 분기
  - 수동 게시글 분류용 모드 UI 추가
- 신경 써야 할 부분
  - “Han/CJK 한 글자만 보이면 좁힘”이 꽤 공격적인 기준이라는 점
  - 자동 monitor 모드와 수동 post 모드를 혼동하지 않게 분리하는 것
  - widening은 미래 글엔 효과가 있지만 initial sweep에서 빠진 글을 복구하지 못한다는 점

즉, 이 플랜은:

- 중국어 한자/CJK형 도배에는 무고한 유동 피해를 줄이고
- 역류기 공격은 기존처럼 놓치지 않도록 유지하는
- 비교적 얇은 변경 경로다.
