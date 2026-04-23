# 신뢰사용자 댓글 명령 방어 탭 설계서

> 작성일: 2026-04-23  
> 범위: **root 프로젝트(`/home/eorb915/projects/dc_defense_suite`) 기준**  
> 목적: 신뢰사용자 댓글 명령으로 `게시물방어` / `댓글방어`를 즉시 10분간 켜는 전용 탭을, 지금 코드 구조에 맞게 바로 패치 가능한 수준으로 정리

## 1. 목표

이 문서의 목표는 아래 요구를 **지금 레포 구조에서 실제로 구현 가능한 방식**으로 고정하는 것이다.

1. 운영자가 지정한 `명령 게시물` 1개를 정한다.
2. 신뢰사용자가 그 글에 댓글로 명령을 쓴다.
3. 확장프로그램이 **기본 20초 주기**로 그 댓글을 읽는다.
4. 명령이 확인되면 즉시 초기 청소를 1회 수행한다.
5. 그 다음 기존 `게시글 분류`, `IP 차단`, `댓글 방어` 스케줄러를 **10분 동안만** 켠다.
6. 10분이 지나면 **이 기능이 켠 child scheduler만** 다시 끈다.

쉽게 예시로 쓰면 이렇다.

```txt
지정 게시물: 1045755
신뢰사용자: gung_master

10:00
gung_master가 댓글로 "@특갤봇 게시물방어" 입력

10:01 폴링
-> 1페이지 유동 게시물 1회 도배기 분류
-> 1페이지 도배기탭 게시물 1회 삭제
-> 게시글 분류 ON
-> IP 차단/삭제 ON
-> 10:11까지 유지

10:11
-> 이 기능이 켠 게시글 분류 / IP 차단만 OFF
```

댓글방어도 같은 구조다.

```txt
10:20
gung_master가 "@특갤봇 댓글방어" 입력

10:21 폴링
-> 1페이지 게시물들의 유동댓글 1회 정리
-> 댓글 방어 ON
-> 10:31까지 유지

10:31
-> 이 기능이 켠 댓글 방어만 OFF
```

---

## 2. 결론 먼저

결론은 아래다.

1. **신문고봇(`projects/dc_auto_bot`)과 직접 연결하지 않는다.**
2. 대신 root 프로젝트에 **새 탭 1개**를 만든다.
3. 그 새 탭이 신문고봇의 댓글 polling 패턴만 가져와서, **자체적으로 댓글을 읽고** 명령을 인식한다.
4. 실제 방어 실행은 root 프로젝트가 이미 가진
   - [features/post/scheduler.js](../../features/post/scheduler.js)
   - [features/ip/scheduler.js](../../features/ip/scheduler.js)
   - [features/comment/scheduler.js](../../features/comment/scheduler.js)
   를 직접 켜고 끄는 방식으로 한다.

쉽게 말하면:

- 신문고봇 구조에서 가져올 것:
  - `짧은 주기 polling`
  - `trusted user`
  - `lastSeenCommentNo`
  - `중복 명령 무시`
- root 확장에서 직접 할 것:
  - 실제 게시물 분류
  - 실제 IP 차단/삭제
  - 실제 댓글 삭제/차단
  - 10분 타이머 관리

즉 **댓글 읽기만 참고하고, 방어 ownership은 root 확장이 전부 가진다.**

이 방식이 제일 깔끔하다.

---

## 3. 실제 코드와 대조해서 확인한 사실

### 3.1 root background가 이미 모든 방어 scheduler의 ownership을 갖고 있다

핵심 파일은 [background/background.js](../../background/background.js) 다.

현재 이 파일은 이미 아래 scheduler들을 한 곳에서 관리한다.

1. `comment`
2. `commentMonitor`
3. `conceptMonitor`
4. `conceptPatrol`
5. `hanRefreshIpBan`
6. `bumpPost`
7. `sinmungoComment`
8. `post`
9. `semiPost`
10. `ip`
11. `uidWarningAutoBan`
12. `monitor`

`getAllStatuses()`도 여기서 한 번에 모으고, `handleMessage()`도 여기서 start/stop/updateConfig를 받는다.

즉 새 기능도 **여기에 scheduler 하나 더 등록하는 구조**가 맞다.

예시:

```txt
지금:
popup -> background -> post/ip/comment scheduler

추가 후:
popup(명령 방어 탭) -> background -> trustedCommandDefense scheduler
                                       -> 내부에서 post/ip/comment child 제어
```

### 3.2 게시물 쪽 초기 1회 처리 로직은 이미 monitor 안에 거의 다 있다

현재 [features/monitor/scheduler.js](../../features/monitor/scheduler.js) 에는 아래 흐름이 이미 있다.

1. 공격 감지
2. `performClassifyOnce(this.postScheduler, targetPostNos)`
3. `performDeleteOnce(this.postScheduler, targetPostNos)`
4. child `postScheduler`, `ipScheduler` 시작

즉 게시물 쪽은 **전혀 새 발명 수준은 아니다.**

다만 그대로 복붙하면 안 되는 이유도 있다.

지금 monitor의 initial sweep 삭제는
- “이번 공격 후보 글 번호들”을 삭제하는 구조이지,
- “도배기탭 1페이지에 현재 걸려 있는 글 전체”를 지우는 구조는 아니다.

사용자 요구는 아래다.

1. 1페이지 유동 게시물 1회 도배기 분류
2. 1페이지 도배기탭 게시물 1회 삭제

즉 게시물 명령 방어에서는 `monitor initial sweep`를 그대로 재활용하는 게 아니라,
**1페이지 유동글 분류 1회**와 **도배기탭 1페이지 삭제 1회**를 분리해서 구현하는 게 맞다.

### 3.3 댓글 API는 raw comment 객체를 그대로 넘기므로 `user_id` 판정은 가능하다

핵심 파일은 [features/comment/api.js](../../features/comment/api.js) 다.

현재 `fetchComments()` / `fetchAllComments()` 는 댓글 응답을 별도 remap 없이
`data.comments || []` 그대로 돌려준다.

즉 서버 응답에 `user_id`가 포함되면,
새 기능도 `comment.user_id` 기준으로 trusted user를 안정적으로 판정할 수 있다.

쉽게 예시로 보면:

```txt
댓글 응답 raw object:
{
  no: 901,
  memo: "@특갤봇 게시물방어",
  user_id: "gung_master",
  ip: "",
  nicktype: "..."
}

-> parser에서 comment.user_id === "gung_master" 로 직접 판정 가능
```

즉 이 부분은 **별도 우회 없이 root comment API 그대로 써도 된다.**

### 3.4 댓글 쪽은 "1회 청소 helper"가 이미 들어가 있고, ownership 기준만 더 맞추면 된다

댓글 쪽 핵심 파일은 [features/comment/scheduler.js](../../features/comment/scheduler.js) 다.

현재 이 파일은 이미 아래 모든 걸 갖고 있다.

1. 1페이지 게시물 목록 조회
2. 각 게시물 댓글 페이지 조회
3. 유동 댓글 필터
4. 삭제 또는 삭제+차단
5. 검증 삭제 수 기록

지금은 이 내부 흐름을 감싸는 public helper가 이미 있다.

- [features/comment/scheduler.js](../../features/comment/scheduler.js)의 `cleanupPostsOnce(posts, options)`

즉 새 기능에서 필요한 댓글 쪽 추가 작업은
**helper를 새로 만드는 것**이 아니라,
이 helper가 trusted ownership/monitor 공존 정책 안에서 안전하게 호출되도록
주변 가드와 ownership 정리를 맞추는 것이다.

여기서 중요한 구현 디테일이 하나 더 있다.

현재 root [features/comment/scheduler.js](../../features/comment/scheduler.js)의
`processPostsInParallel()` / `processPost()` 는 전부 `this.isRunning` 전제를 깔고 있다.

쉽게 예시로 보면:

```txt
명령 댓글방어 initial sweep 시점
-> commentScheduler는 아직 start 전
-> this.isRunning === false
-> 기존 processPostsInParallel()를 그대로 외부 호출
-> worker while 조건에서 바로 종료
```

즉 핵심 포인트는 여전히 맞다.

- `processPostsInParallel()` 를 밖에서 직접 부르면 안 되고
- **`isRunning`과 독립된 1회 청소 public helper**를 써야 한다.

다만 그 helper는 이제 이미 들어가 있다.

예시:

```txt
지금:
댓글 방어 토글 ON
-> run loop 진입
-> processPostsInParallel()

필요한 것:
명령 감지
-> 1페이지 게시물 목록만 전달
-> cleanupPostsOnce(posts, { logLabel: '명령 댓글방어 initial sweep' })
-> 바로 1회 정리
```

### 3.5 명령 댓글 polling은 `전체 댓글 조회`가 아니라 `최근 1~2페이지 조회`로 이미 들어가 있다

이건 구조적으로 중요한 포인트다.

지금 root [features/comment/api.js](../../features/comment/api.js) 에는
`fetchAllComments()` 와 함께 `fetchRecentComments()` 도 이미 들어가 있다.

그런데 명령 게시물은 시간이 갈수록 댓글이 쌓일 수 있다.
이 상태에서 1분마다 `fetchAllComments()` 로 전체 댓글을 다 읽으면,
초반엔 빨라도 나중에는 **신문고봇이 피했던 그대로 느려지는 문제**가 다시 생긴다.

쉽게 예시로 보면:

```txt
처음:
명령 게시물 댓글 20개
-> 전체 조회도 빠름

며칠 뒤:
명령 게시물 댓글 800개
-> 1분마다 전체 조회
-> 명령 감지 자체가 점점 느려짐
```

현재 구현도 신문고봇처럼
**최근 1~2페이지만 읽고, 거기서 새 댓글만 보는 구조**로 가고 있다.

즉 여기서 남은 일은 helper를 새로 넣는 게 아니라,
이 polling helper가 broad start block이나 ownership 충돌 때문에
제대로 못 도는 부분을 정리하는 것이다.

1. root `features/comment/api.js` 에 `fetchRecentComments(config, postNo, esno, maxPages = 2)` helper를 추가
2. 명령 scheduler는 poll마다 `fetchRecentComments(..., 2)` 만 호출
3. `lastSeenCommentNo` 이후 새 댓글만 처리

구현 방식도 `fetchAllComments()` 와 같은 결로 맞추는 게 안전하다.

- `fetchRecentComments()` 도 **한 번의 `withDcRequestLease({ feature: 'comment', kind: 'fetchRecentComments' })` 안에서**
  최근 페이지들을 순차 조회하는 구조가 맞다.
- 페이지마다 lease를 다시 잡거나, lease 없이 `fetchComments()`만 직접 반복하면
  root 댓글 방어와 명령 polling이 동시에 도는 상황에서 요청 조율 기준이 흐려질 수 있다.

### 3.6 popup은 새 탭 1개 추가하기 좋은 구조다

현재 탭 구조는 [popup/popup.html](../../popup/popup.html), [popup/popup.js](../../popup/popup.js) 에 있다.

특징은 단순하다.

1. 상단 `<nav class="tabs">`에 버튼 추가
2. `<section class="panel" data-feature="...">` 추가
3. `FEATURE_DOM`에 DOM 매핑 추가
4. `refreshAllStatuses()`에서 렌더 추가
5. `bindFeatureEvents()`에서 토글/저장 버튼 연결

즉 새 기능은 **탭 1개**로 넣는 게 구조상 자연스럽다.

사용자 요청인 “탭 한 개에 넣는 느낌”과 정확히 맞는다.

### 3.7 공통 갤 설정과 충돌 관리도 background에서 같이 처리해야 한다

[background/background.js](../../background/background.js)의 `applySharedConfig()`는 지금 이미 `galleryId`와 `headtextId`를 각 scheduler에 퍼뜨린다.

즉 새 기능도 여기에 들어가야 한다.

필요한 이유:

1. 명령 댓글을 읽을 갤러리도 root 공통 `galleryId`를 따라야 함
2. 게시물방어가 도배기탭 삭제를 하려면 공통 `headtextId`도 알아야 함

또 `getBusyFeatures()`도 있다.

이건 새 기능 충돌정책을 잡을 때 중요하다.

예시:

```txt
이미 감시 자동화가 공격 중
-> 그 상태에서 명령 게시물방어가 오면
-> 누가 post/ip child ownership을 가지는지 애매해짐
```

여기서 중요한 건 **명령 방어 탭 자체의 polling 시작**과 **각 명령의 실제 방어 실행**을 분리해서 봐야 한다는 점이다.

이 문서 초안은 둘을 한꺼번에 묶어 “이미 다른 owner가 child를 돌리고 있으면 시작하지 않는다”고 적었는데,
실제 요구와 현재 코드 흐름을 대조해 보면 이건 너무 넓게 막는 정책이다.

정확한 정책은 아래가 맞다.

1. **명령 방어 탭 자체의 polling은 항상 시작 가능해야 한다.**
2. `게시물방어` 명령은 **게시물 축이 이미 대응 중일 때만** 무시한다.
3. `댓글방어` 명령은 **댓글 축이 이미 대응 중일 때만** 무시한다.
4. 자동 감시가 켜져 있어도 아직 child를 안 잡은 상태라면, 명령 방어가 먼저 들어와도 된다.

쉽게 예시로 보면:

```txt
감시 자동화 ON
현재 NORMAL 상태
post/ip child 아직 OFF

-> trusted user가 "@특갤봇 게시물방어"
-> 허용
-> 10분 동안 게시물방어 먼저 실행
```

반대로:

```txt
감시 자동화 ON
현재 ATTACKING 상태
post/ip child 이미 ON

-> trusted user가 "@특갤봇 게시물방어"
-> "이미 게시물 축 대응 중"으로 무시
```

### 3.8 background 복원 순서와 child 수동 OFF 동기화는 별도 처리해야 한다

이건 문서 초안보다 더 중요한 연결 포인트다.

현재 [background/background.js](../../background/background.js)의 `resumeAllSchedulers()` 는

1. `commentMonitor` / `monitor` 상태를 보고
2. 그 child인 `comment`, `post`, `ip` 를 특수 복원한다.

즉 **parent가 child ownership을 갖는 구조는 이미 있지만, 명령 방어용 분기는 아직 없다.**

이 상태로 새 scheduler만 추가하면 재시작 직후 이런 문제가 생길 수 있다.

```txt
브라우저 종료 직전:
명령 방어가 post/ip/comment를 소유 중

브라우저 재시작:
background가 기존 순서대로 post/comment/ip를 standalone처럼 먼저 복원
-> 잠깐 ownership이 꼬일 수 있음
```

그래서 `resumeAllSchedulers()` 에도 명령 방어 분기를 넣어야 한다.

권장 방식:

1. `trustedCommandDefense` 상태를 child보다 먼저 load
2. `commentMonitor` / `monitor` 보다 우선하지는 말고,
   - `commentMonitor`가 comment를 소유 중이면 그쪽 우선
   - `monitor`가 post/ip를 소유 중이면 그쪽 우선
3. 그 외 경우에만
   - `trustedCommandDefense.ownsCommentScheduler === true` 면 comment child 복원
   - `trustedCommandDefense.ownsPostScheduler === true` 면 post child 복원
   - `trustedCommandDefense.ownsIpScheduler === true` 면 ip child 복원
4. 마지막에 `trustedCommandDefense.ensureRunLoop()` 복원

여기서 실제 코드 기준으로 한 단계 더 봐야 할 게 있다.

- 현재 [background/background.js](../../background/background.js)의 `resumeAllSchedulers()` 는
  trusted ownership이 active여도
  `ensureOwnedDefensesStarted({ allowPostDefense, allowCommentDefense })` 를 호출할 때
  `allowPostDefense = shouldAllowPostDefenseStart()`
  `allowCommentDefense = shouldAllowCommentDefenseStart()`
  값을 그대로 쓴다.
- 그런데 이 `shouldAllow...` 함수는 지금 `monitor.isRunning`, `commentMonitor.isRunning` 만으로도 `false`가 된다.

쉽게 예시로 보면:

```txt
브라우저 종료 직전:
trusted 게시물방어 active
monitor는 ON이지만 NORMAL

브라우저 재시작:
resumeAllSchedulers()
-> trusted ownership state는 살아 있음
-> 하지만 monitor.isRunning === true
-> allowPostDefense=false
-> trusted post/ip child 복원이 건너뛰어질 수 있음
```

즉 복원도 같은 기준으로 바뀌어야 한다.

1. `monitor/commentMonitor` 가 **그냥 켜져 있는 것만으로는** trusted 복원을 막으면 안 된다.
2. 실제 `ATTACKING/RECOVERING` + child ownership이 있는 경우에만 해당 축 복원을 막아야 한다.
3. trusted ownership이 살아 있으면, `resumeAllSchedulers()` 는 해당 축 child를 **monitor/commentMonitor보다 먼저** 복원해야 한다.
4. monitor/commentMonitor 는 그 뒤 자기 run loop만 복원하고, trusted-owned child에는 손대지 않아야 한다.

또 하나 더 있다.

문서 초안은 "child를 사용자가 수동 OFF하면 다음 poll에서 ownership 정리"라고 적었는데,
이것만으로는 늦다.

예시:

```txt
10:05 명령 방어가 post/ip 소유 중
10:06 사용자가 post를 수동 OFF
10:06:10 브라우저 종료

다음 poll 전에 종료됐으므로
명령 방어 상태엔 still ownsPostScheduler=true 가 남을 수 있음
```

그래서 background `handleMessage(stop)` 에서
`post/comment/ip` 가 수동 정지될 때,
`trustedCommandDefense` 가 그 child를 소유 중이면
**그 자리에서 바로 ownership 상태를 정리**해야 안전하다.

즉 "다음 poll에서 감지"는 보조 안전장치로 두고,
실제 정리는 `background stop hook`가 1차 책임을 가져야 한다.

### 3.10 현재 코드와 다시 대조해서 확인한 추가 이슈

이번 턴에 실제 root 코드를 다시 대조하면서, 문서 초안에 없던 중요한 충돌 포인트를 추가로 확인했다.

#### 3.10.1 지금은 `명령 방어` 시작 자체를 너무 넓게 막고 있다

[background/background.js](../../background/background.js)의 `getTrustedCommandDefenseStartBlockMessage()` 는 현재 아래 조건이면
명령 방어 탭 ON 자체를 막는다.

1. `monitor.isRunning`
2. `commentMonitor.isRunning`
3. `post.isRunning && !ownedByCommand`
4. `ip.isRunning && !ownedByCommand`
5. `comment.isRunning && !ownedByCommand`

즉 지금 코드는 아래처럼 동작한다.

```txt
감시 자동화만 켜져 있고 아직 공격은 못 잡은 상태
-> 명령 방어 ON 시도
-> "감시 자동화 실행 중에는 명령 방어를 시작할 수 없습니다."
```

이건 요구와 다르다.

사용자 요구는 아래다.

1. 명령 방어는 **늘 댓글을 보고 있어야 한다**
2. 이미 게시물 축이 대응 중이면 `게시물방어` 명령만 무시
3. 이미 댓글 축이 대응 중이면 `댓글방어` 명령만 무시
4. 감시가 켜져 있지만 아직 대응을 시작하지 않았다면, 명령 방어가 먼저 개입 가능

즉 `getTrustedCommandDefenseStartBlockMessage()` 는
**start 자체를 막는 broad block가 아니라, 최소한의 validation 수준으로 축소**하는 게 맞다.

#### 3.10.2 현재 `shouldAllowPostDefenseStart()` / `shouldAllowCommentDefenseStart()` 기준도 너무 넓다

[background/background.js](../../background/background.js)의 scheduler 주입 부분을 보면,
`shouldAllowPostDefenseStart()` 는 사실상 아래 조건을 쓴다.

1. `!monitor.isRunning`
2. `post`가 안 돌거나 command owner
3. `ip`가 안 돌거나 command owner

댓글도 비슷하게:

1. `!commentMonitor.isRunning`
2. `comment`가 안 돌거나 command owner

즉 지금은 감시가 NORMAL/SEEDING 상태로 그냥 켜져 있기만 해도 명령 실행을 막는다.

하지만 필요한 건 이게 아니다.

정확한 기준은 아래다.

1. 게시물방어 명령은
   - `monitor`가 **ATTACKING/RECOVERING** 이거나
   - `post/ip`가 이미 다른 owner로 실제 대응 중일 때만 무시
2. 댓글방어 명령은
   - `commentMonitor`가 **ATTACKING/RECOVERING** 이거나
   - `comment`가 이미 다른 owner로 실제 대응 중일 때만 무시

즉 “감시가 켜져 있느냐”가 아니라
**“그 축에서 실제 대응 중이냐”** 를 봐야 한다.

#### 3.10.3 `monitor` / `commentMonitor` 가 trusted child를 조용히 가져갈 수 있다

이건 더 위험한 포인트다.

[features/comment-monitor/scheduler.js](../../features/comment-monitor/scheduler.js)의
`ensureManagedDefenseStarted()` 는 `commentScheduler` 가 이미 돌고 있으면
그 child를 그대로 재사용하면서 `source`와 `attackMode`를 바꾼다.

쉽게 예시로 보면:

```txt
명령 댓글방어가 commentScheduler를 먼저 켬
-> currentSource = manual

그 뒤 commentMonitor가 공격 감지
-> 이미 commentScheduler가 돌고 있으니
-> setCurrentSource('monitor')
-> runtime attack mode도 monitor 기준으로 덮어씀
```

즉 trusted ownership이 조용히 monitor ownership처럼 변질될 수 있다.

게시물 쪽도 비슷하다.

[features/monitor/scheduler.js](../../features/monitor/scheduler.js)의
`ensureManagedDefensesStarted()` 는 `post/ip` 가 이미 돌고 있으면
현재 child를 그대로 재사용하면서 `cutoff`, `attackMode`, `runLoop`를 monitor 기준으로 덮는다.

즉 v1에서 필요한 건 아래다.

1. trusted가 이미 소유 중인 child는
   - monitor/commentMonitor가 **가져가지 않는다**
2. monitor/commentMonitor는 그 상황을 감지하면
   - “trusted ownership active라 이번 cycle은 takeover 안 함” 로그만 남긴다
3. trusted hold가 끝난 뒤에도 공격 상태가 계속이면
   - 다음 cycle에서 monitor/commentMonitor가 그때 takeover 가능

#### 3.10.4 `monitor` / `commentMonitor` 가 trusted child를 복구 종료 시 같이 꺼버릴 수 있다

이 부분은 실제로 더 치명적이다.

[features/monitor/scheduler.js](../../features/monitor/scheduler.js)의 `stopManagedDefenses()` 는 현재

```txt
this.phase === ATTACKING && (postScheduler.isRunning || ipScheduler.isRunning)
```

이면 managed flag와 무관하게 child를 stop 대상으로 본다.

즉 예시:

```txt
감시 자동화 ON
아직 공격 못 잡은 상태
trusted user가 "@특갤봇 게시물방어"
-> trusted가 post/ip를 먼저 켬

조금 뒤 monitor가 공격 감지해서 ATTACKING 진입
나중에 release 조건 만족
-> stopManagedDefenses()
-> 지금 켜져 있는 post/ip를 monitor가 자기 것처럼 같이 꺼버릴 수 있음
```

댓글도 동일하다.

[features/comment-monitor/scheduler.js](../../features/comment-monitor/scheduler.js)의 `stopManagedDefense()` 는

```txt
this.phase === ATTACKING && commentScheduler.isRunning
```

이면 managedCommentStarted와 무관하게 comment child를 stop 대상으로 본다.

즉 trusted 댓글방어도 release 시점에 commentMonitor가 같이 꺼버릴 수 있다.

그래서 v1은 아래처럼 수정돼야 안전하다.

1. monitor/commentMonitor는
   - 자신이 실제로 start/adopt한 child만 stop
2. trusted ownership active인 child는
   - release 시점에도 stop 대상에서 제외

#### 3.10.5 monitor/commentMonitor lock이 trusted child 수동 OFF까지 막고 있다

문서 초안은 "child 수동 OFF는 허용하고, trusted ownership이 즉시 정리된다"고 적었지만,
현재 [background/background.js](../../background/background.js)의 `getMonitorManualLockMessage()` 는
`monitor.isRunning` / `commentMonitor.isRunning` 만으로도 `post/ip/comment stop` 을 막는다.

쉽게 예시로 보면:

```txt
monitor ON / NORMAL
trusted 게시물방어 active
운영자가 게시글 분류 탭에서 OFF 클릭

현재 코드:
-> "감시 자동화 실행 중에는 게시글 분류 / 반고닉 분류 / IP 차단을 수동으로 조작할 수 없습니다."
-> stop 자체가 막힘

문서상 맞는 정책:
-> stop 허용
-> 바로 trustedCommandDefense.handleOwnedChildStopped('post')
-> post/ip ownership 세트 전체 정리
```

즉 `monitor/commentMonitor` 가 켜져 있어도,
**trusted가 실제 소유 중인 child의 수동 stop은 예외 허용**해야 문서 정책과 실제가 맞는다.

#### 3.10.6 같은 축의 중복 명령은 "실패"가 아니라 "무시"여야 한다

현재 trusted scheduler는 `shouldAllow...Start()` 가 false면 `throw` 로 실패 처리한다.

하지만 요구는 이렇다.

```txt
게시물 축이 이미 자동 감시로 대응 중
-> 또 "@특갤봇 게시물방어"
-> 에러가 아니라 그냥 무시
```

즉 정책은:

1. 같은 축이 이미 다른 owner로 대응 중이면
   - 명령 댓글은 processed 처리
   - 로그만 남기고 무시
2. 같은 축을 이미 trustedCommandDefense가 소유 중이면
   - initial sweep 재실행 없이 10분 연장만

#### 3.10.7 자동감시와 trusted 명령은 공존해야 한다

이 문서의 최종 정책은 아래처럼 잡아야 한다.

1. `monitor` / `commentMonitor` 는 **항상 켜져 있을 수 있다**
2. trusted 명령은
   - 해당 축이 아직 실제 대응 중이 아니면 실행 가능
3. trusted가 먼저 대응 중일 때
   - monitor/commentMonitor는 감시는 계속하되
   - child takeover / child stop은 하지 않는다
4. trusted hold 종료 뒤에도 공격이 계속이면
   - monitor/commentMonitor가 다음 cycle에서 takeover 가능

쉽게 예시로 보면:

```txt
10:00 monitor ON, 아직 NORMAL
10:01 trusted "@특갤봇 게시물방어"
-> trusted가 post/ip 10분 소유

10:03 monitor가 공격 감지
-> 감시는 계속
-> 하지만 trusted post/ip는 건드리지 않음

10:11 trusted hold 만료
-> monitor가 여전히 ATTACKING이면
-> 다음 cycle에서 monitor가 post/ip takeover
```

#### 3.10.8 `background` lock만 풀어도 끝이 아니다. `monitor/commentMonitor` 자신의 start block도 같이 바꿔야 한다

현재 root 코드는 `background` 쪽 start lock과 별개로,
각 scheduler 자신도 `getStartBlockReason()` 에서 child가 이미 돌고 있으면 start를 막는다.

쉽게 예시로 보면:

```txt
trusted 게시물방어 active
-> post/ip child 이미 ON
-> 운영자가 monitor.start

현재 코드:
-> background lock을 풀어도
-> monitor.getStartBlockReason()
-> "감시 자동화를 시작하기 전에 게시글 분류를 먼저 정지하세요."
-> 결국 coexistence 실패
```

댓글도 동일하다.

```txt
trusted 댓글방어 active
-> comment child ON
-> 운영자가 commentMonitor.start

현재 코드:
-> commentMonitor.getStartBlockReason()
-> "댓글 감시 자동화를 시작하기 전에 댓글 방어를 먼저 정지하세요."
```

즉 문서 정책대로 가려면 아래 둘도 같이 바뀌어야 한다.

1. `monitor.getStartBlockReason()`
   - trusted가 소유한 `post/ip` child는 start blocker로 보지 않음
2. `commentMonitor.getStartBlockReason()`
   - trusted가 소유한 `comment` child는 start blocker로 보지 않음

정확히는:

1. **standalone 수동 `post/ip/comment`가 돌고 있을 때만** monitor/commentMonitor start를 막고
2. trusted ownership active인 child는 **공존 가능한 상태**로 간주하는 게 맞다

쉽게 요약하면:

- `background` lock 완화
- `monitor/commentMonitor` own start block 완화

이 두 개를 같이 해야 문서 정책이 실제로 성립한다.

### 3.9 신문고봇의 polling 패턴은 재사용 가치가 크다

신문고봇 쪽 실제 참고 파일은 아래다.

- [projects/dc_auto_bot/background/scheduler.js](../../projects/dc_auto_bot/background/scheduler.js)
- [projects/dc_auto_bot/background/parser.js](../../projects/dc_auto_bot/background/parser.js)
- [projects/dc_auto_bot/background/api.js](../../projects/dc_auto_bot/background/api.js)

재사용 가치가 큰 부분:

1. `pollIntervalMs: 60000`
2. `trustedUsers`
3. `lastSeenCommentNo`
4. trusted user만 처리
5. 첫 실행 시 현재 visible comment max no로 seed
6. 이미 처리한 command key 중복 무시

하지만 parser는 그대로 못 쓴다.

현재 신문고봇 `parseCommandComment()`는 아래를 기대한다.

1. prefix
2. 링크
3. `사유:`

즉 지금 원하는

- `@특갤봇 게시물방어`
- `@특갤봇 댓글방어`

같은 단순 명령형에는 맞지 않는다.

결론:

- polling 구조는 참고
- parser는 새로 작성

---

## 4. 추천 구조

### 4.1 새 기능 이름

root 프로젝트에 아래 feature를 새로 만든다.

```txt
feature id: trustedCommandDefense
탭 이름: 명령 방어
```

### 4.2 현재 구현 파일 기준 범위

현재 이 기능은 아래 파일에 이미 들어가 있다.

```txt
features/trusted-comment-command-defense/
  parser.js
  scheduler.js
```

추가 수정 파일:

```txt
background/background.js
popup/popup.html
popup/popup.js
features/comment/scheduler.js
```
즉 이 문서의 남은 목적은
**새 파일 생성 설계**가 아니라, 이미 들어간 기능의 충돌 정책과 ownership 정리를 맞추는 것이다.

### 4.3 왜 cross-extension bridge를 안 쓰는가

`projects/dc_auto_bot`와 직접 연결하는 방법도 기술적으로는 가능하다.

예시:

```txt
dc_auto_bot가 명령 인식
-> chrome.runtime.sendMessage(external) 또는 storage relay
-> root 확장이 post/ip/comment 실행
```

하지만 이 방식은 아래 문제가 생긴다.

1. 확장프로그램 두 개가 동시에 살아 있어야 한다.
2. 한쪽만 재시작되면 10분 ownership 상태가 꼬인다.
3. 누가 child scheduler를 껐는지 추적이 어려워진다.
4. 디버깅 로그가 두 확장에 나뉜다.

그래서 v1은 **root 단독 소유**가 맞다.

---

## 5. 명령 문법

v1은 일부러 단순하게 간다.

### 5.1 허용 명령

현재 구현 기준으로는 아래처럼 읽는다.

1. 댓글 메모를 `normalizeCommentMemo()` 기준으로 정리한다.
2. 뒤에 붙은 `- dc App`, `- dcside app` 꼬릿말은 잘라낸다.
3. `commandPrefix` 는 문장 맨 앞 고정이 아니라, **정규화된 메모 안에 포함되어 있으면 된다.**
4. prefix 뒤 남은 본문을 공백 제거 후 `게시물방어` 또는 `댓글방어` 와 비교한다.

즉 "본문 exact match"는 맞지만, **댓글 전체 문자열 exact match만 허용하는 구조는 아니다.**

1. `@특갤봇 게시물방어`
2. `@특갤봇 게시물 방어`
3. `@특갤봇 댓글방어`
4. `@특갤봇 댓글 방어`

예시:

```txt
허용:
@특갤봇 게시물방어
@특갤봇 댓글 방어
@특갤봇 게시물방어 - dc App
- dc App @특갤봇 게시물방어

불허:
@특갤봇 게시물방어 좀 해줘
@특갤봇 게시물방어!!! 
게시물방어
```

이유는 오작동을 줄이기 위해서다.

### 5.2 trusted user 판정

v1은 **닉네임이 아니라 user_id 기준**으로만 판정한다.

이유:

1. 닉네임은 겹칠 수 있음
2. 바뀔 수 있음
3. 비슷한 닉으로 오발동 위험이 큼

주의:

- `user_id` 가 비어 있는 유동/비회원 댓글은 trusted user로 인정하지 않는다.
- 즉 신뢰사용자는 **로그인된 계정 댓글**이어야 한다.

예시:

```txt
닉네임: 주딱
user_id: ""
-> trusted 아님

닉네임: 주딱
user_id: "gung_master"
-> trusted 가능
```

### 5.3 첫 실행 seed 정책

토글 ON 직후 첫 polling 때는
현재 보이는 댓글 중 `최대 comment no`를 `lastSeenCommentNo`로 저장하고,
그 이전 댓글은 처리하지 않는다.

예시:

```txt
10:00 토글 ON
현재 최신 댓글 no = 900

10:01 첫 polling
-> lastSeenCommentNo = 900으로 seed
-> 예전 댓글 1~900은 무시

10:02 이후
-> 901부터 새 댓글만 명령 후보
```

이게 없으면 토글 켤 때 예전 명령 댓글이 다시 실행된다.

---

## 6. 탭 UI 설계

탭은 **1개만** 추가한다.

추천 위치는 자동화/수동 방어 탭 사이 어디든 괜찮지만,
실사용 성격상 `댓글 자동화` 옆이나 `게시글 분류` 앞이 적당하다.

### 6.1 탭 이름

```txt
명령 방어
```

### 6.2 상태 표시

최소 상태칸은 아래가 필요하다.

1. 실행 상태
2. 현재 단계
3. 최근 폴링 시각
4. 최근 확인 댓글 번호
5. 최근 명령
6. 최근 명령 사용자
7. 게시물방어 유지 종료 시각
8. 댓글방어 유지 종료 시각
9. 현재 소유 child

예시:

```txt
상태: 🟢 실행 중
현재 단계: POLLING
최근 폴링: 2026-04-23 10:21:04
최근 명령: 게시물방어
최근 명령 사용자: gung_master
게시물방어 유지: 10:31:04까지
댓글방어 유지: -
소유 child: post, ip
```

### 6.3 설정 입력

현재 popup은 textarea 직입력이 아니라, **설정 섹션 + 신뢰 사용자 섹션**으로 나뉜 구조다.

필수 입력:

1. 명령 게시물 URL
2. 명령 prefix
3. polling 주기(초)
4. 유지 시간(분)

그리고 별도 접힘 섹션에서:

5. 신뢰 사용자 `user_id`
6. 신뢰 사용자 `label`
7. `신뢰 사용자 추가`
8. 등록 리스트 개별 삭제

쉽게 예시로 보면 현재 popup은 아래 느낌이다.

```txt
[설정]
- 명령 게시물 링크/번호
- 호출어 (@특갤봇)
- 폴링 주기 (초) = 20
- 방어 유지 시간 (분) = 10

[신뢰 사용자]
- user_id: image8481
- label: だいき
- 신뢰 사용자 추가
- 등록 리스트 / 개별 삭제
```

주의:

- 내부 저장은 여전히 `trustedUsersText` + `trustedUsers` 정규화 구조를 같이 쓴다.
- 하지만 **운영자 UX 기준은 textarea가 아니라 add/remove 리스트 UI**다.

여기서 `명령 게시물 URL` 은 그냥 문자열 저장으로 끝내면 안 된다.

권장 규칙:

1. `mgallery view URL`만 허용
2. 저장 시 URL에서 `id` 와 `no` 를 추출
3. 추출한 `id` 가 root 공통 `galleryId` 와 다르면 저장 거부
4. `commandGalleryId` 와 `commandPostNo` 를 함께 저장
5. 런타임은 URL 전체보다 `commandPostNo` 를 기준으로 poll

쉽게 예시로 보면:

```txt
입력:
https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1045755&page=1

저장:
commandPostUrl = 원본 유지
commandGalleryId = thesingularity
commandPostNo = 1045755

잘못된 예:
shared galleryId = thesingularity
입력 URL id = other_gallery
-> 저장 거부
```

또 하나 더 있다.

shared `galleryId` 를 나중에 다른 갤로 바꿨는데,
예전 `commandGalleryId` 가 그대로 남아 있으면 다음 start 때 설정이 꼬일 수 있다.

그래서 `getStartBlockReason()` 에도 아래 검사를 넣는 게 맞다.

1. `commandGalleryId === shared galleryId` 인가
2. 아니면 start 거부 + "명령 게시물 URL을 다시 저장하세요"

또 하나 더 있다.

이 기능은 `commandPostUrl`, `trustedUsers`, `prefix`, `pollIntervalMs`, `holdMs` 중 하나라도
저장 안 된 수정이 남은 상태에서 바로 toggle ON 하면
**사용자가 보고 있는 값이 아니라 마지막 저장값으로 polling** 하게 된다.

쉽게 예시로 보면:

```txt
popup에서 명령 게시물 URL을 새 글로 바꿨지만 저장은 안 함
-> 바로 토글 ON
-> background는 예전 저장값 commandPostNo로 polling 시작
```

그래서 popup 쪽도 `DIRTY_FEATURES.trustedCommandDefense === true` 인 상태에서는
**start 자체를 막고 먼저 저장을 요구**하는 게 맞다.

신뢰 사용자 판정은 `label` 이 아니라 `user_id` 기준이다.

예시:

```txt
user_id = image8481
label = だいき
```

여기서 trusted 판정은 `image8481` 로만 한다.
`label` 은 popup에서 보기 쉽게 붙이는 이름표다.

---

## 7. 실행 흐름

## 7.1 공통 poll 흐름

새 scheduler는 아래 순서로 돈다.

1. 명령 게시물 URL/글번호 확인
2. `fetchPostPage()` 로 글 페이지 HTML 읽기
3. `extractEsno()` 로 댓글 조회용 `e_s_n_o` 추출
4. `fetchRecentComments(..., 2)` 로 최근 1~2페이지 댓글만 조회
5. `comment.no` 기준으로 sort + dedupe
6. `lastSeenCommentNo` 이후 새 댓글만 필터
7. trusted user만 남김
8. 명령 parser로 판정
9. 명령 실행
10. 각 방어 만료 시각이 지났는지 확인하고 owned child stop

즉 polling 뼈대는 신문고봇에서 가져오고,
실제 API 호출은 root의 기존 comment API를 그대로 쓴다.

주의:

- 여기서 `fetchAllComments()` 를 쓰면 명령 게시물 댓글이 쌓일수록 polling 자체가 느려진다.
- v1은 **최근 2페이지 고정**으로 두는 게 맞다.
- 새 댓글 판정 전에는 `comment.no` 기준 sort + dedupe를 먼저 해야 안전하다.

### 7.2 게시물방어 명령 실행 순서

명령: `@특갤봇 게시물방어`

#### 1단계. 충돌 검사

아래 중 하나면 **실패가 아니라 무시**한다.

1. `post`가 이미 다른 owner로 실제 대응 중
2. `ip`가 이미 다른 owner로 실제 대응 중
3. `monitor.phase === ATTACKING/RECOVERING` 이고 monitor가 `post/ip` ownership을 가진 상태
4. 실행 시점의 공통 `headtextId` 가 비어 있음

이유:

- `monitor.isRunning` 자체는 무시 사유가 아니다.
- 실제 게시물 축이 이미 대응 중일 때만 같은 축 명령을 건너뛰어야 한다.
- `게시물방어`는 "도배기탭 1페이지 삭제"까지 포함이라 `headtextId` 없이는 반쪽 실행이 된다.

예시:

```txt
monitor ON / ATTACKING / post/ip ON
-> 댓글 명령 게시물방어 도착
-> 실행 안 함
-> 로그: 이미 게시물 축 자동 대응 중이라 게시물방어 명령을 건너뜀

shared headtextId 비어 있음
-> "@특갤봇 게시물방어" 도착
-> 실행 안 함
-> 로그: 도배기 말머리 ID가 없어 게시물방어 명령을 건너뜀
```

여기서 실제 코드와 문서가 아직 안 맞는 포인트가 하나 더 있다.

- 현재 [features/trusted-comment-command-defense/scheduler.js](../../features/trusted-comment-command-defense/scheduler.js)의
  `getStartBlockReason()` 는 `headtextId` 가 비어 있으면 **명령 방어 탭 자체 start**를 막는다.
- 그런데 `headtextId` 는 `게시물방어`에만 필요하고, `댓글방어` polling 자체와는 무관하다.

쉽게 예시로 보면:

```txt
운영자는 댓글방어 명령만 쓸 생각
공통 headtextId는 아직 비어 있음

현재 코드:
-> 명령 방어 탭 ON 자체가 막힘

맞는 정책:
-> polling 시작은 허용
-> 나중에 "@특갤봇 게시물방어"가 들어왔을 때만
   "도배기탭 번호가 없어 게시물방어는 건너뜀"
```

즉 `headtextId` 필수 검사는 **scheduler start 시점이 아니라 게시물방어 실행 시점**으로 내려야 한다.

#### 2단계. 1페이지 snapshot 확보

1. `fetchPostListHTML(..., 1)`
2. `parseBoardPosts(html)` 로 1페이지 글 목록
3. `cutoffPostNo = 1페이지 최대 글 번호`
4. `extractHeadtextName(html, headtextId)` 로 도배기 라벨명 추출

여기서 `extractHeadtextName()` 이 빈 문자열이면 그대로 진행하면 안 된다.

이유:

1. `parseFluidPosts(html, targetHeadName)` 는 `targetHeadName` 이 비면 이미 도배기탭인 글을 제외하지 못한다.
2. 즉 라벨 추출 실패 상태에서 분류를 계속하면 "이미 도배기인 글"까지 다시 후보에 섞일 수 있다.

그래서 v1은 아래처럼 fail-safe로 두는 게 맞다.

```txt
headtextId는 저장돼 있음
하지만 1페이지 HTML에서 라벨 추출 실패
-> 게시물방어 명령 자체를 로그 남기고 중단
```

#### 3단계. 1페이지 유동 게시물 1회 분류

1. `parseFluidPosts(html, targetHeadName)` 로 유동글만 추출
2. `postScheduler.classifyPostsOnce(postNos, { logLabel: '명령 게시물방어 initial sweep' })`

예시:

```txt
1페이지 유동 게시물: 1045901, 1045902, 1045904
-> 3개 1회 도배기 분류
```

#### 4단계. 1페이지 도배기탭 게시물 1회 삭제

이 부분은 monitor helper로는 바로 안 된다.

필요한 정확한 구현:

1. `fetchTargetListHTML(ipConfig, 1)`
2. `parseTargetPosts(html, headtextName, { includeUidTargets: false })`
3. 추출된 post no를 `deletePosts(postConfig, nos)`로 1회 삭제

예시:

```txt
도배기탭 1페이지 게시물: 1045880, 1045883
-> 2개 1회 삭제
```

#### 5단계. child scheduler 10분 시작

이 기능은 child를 아래처럼 킨다.

1. `postScheduler.start({ source: 'manual', attackMode: DEFAULT, cutoffPostNo })`
2. `ipScheduler.start({ source: 'manual', cutoffPostNo, delChk: true })`

여기서 `source`는 새로 만들지 않고 `manual`을 그대로 쓴다.

이유:

1. 현재 `post/comment` scheduler는 `manual/monitor` 두 모드 전제로 상태 문구와 복원 로직이 짜여 있음
2. 억지로 `trustedCommand` 같은 새 source를 만들면 기존 복원/문구 분기가 늘어난다
3. ownership은 새 command scheduler가 별도 상태로 들고 있으면 충분하다

즉 child 입장에서는 “manual로 켜진 것처럼 보이지만”,
실제 소유권은 parent `trustedCommandDefense`가 갖는다.

#### 6단계. 유지 시간 기록

상태에 아래를 저장한다.

1. `postDefenseUntil`
2. `ownsPostScheduler=true`
3. `ownsIpScheduler=true`
4. `lastPostCommandCommentNo`
5. `lastPostCommandUserId`

### 7.3 댓글방어 명령 실행 순서

명령: `@특갤봇 댓글방어`

#### 1단계. 충돌 검사

아래 중 하나면 **실패가 아니라 무시**한다.

1. `comment`가 이미 다른 owner로 실제 대응 중
2. `commentMonitor.phase === ATTACKING/RECOVERING` 이고 commentMonitor가 `comment` ownership을 가진 상태

#### 2단계. 1페이지 게시물 목록 확보

1. `fetchPostList(config, 1)`
2. 1페이지 게시물 배열 확보

#### 3단계. 1회 댓글 청소

여기서 새 helper가 필요하다.

추천 public helper:

```txt
commentScheduler.cleanupPostsOnce(posts, {
  source: 'manual',
  attackMode: COMMENT_ATTACK_MODE.DEFAULT,
  logLabel: '명령 댓글방어 initial sweep'
})
```

이 helper 내부에서는 현재 `processPost()` / `processPostsInParallel()` / `executeCommentDeletionBatch()` 흐름을 재사용하면 된다.

다만 **기존 `processPostsInParallel()`를 그대로 public export처럼 노출하는 방식은 안 된다.**

이유는 위 3.4에서 본 것처럼
그 내부가 `this.isRunning` 전제를 깔고 있어서,
child `commentScheduler.start()` 전의 initial sweep에는 그대로 못 쓰기 때문이다.

예시:

```txt
1페이지 게시물 30개
-> 각 글 댓글 읽음
-> 유동 댓글만 삭제 또는 삭제+차단
-> 1회 청소 끝
```

#### 4단계. child scheduler 10분 시작

이후 기존 댓글 방어를 그냥 켠다.

```txt
commentScheduler.start({
  source: 'manual',
  commentAttackMode: DEFAULT
})
```

#### 5단계. 유지 시간 기록

상태에 아래를 저장한다.

1. `commentDefenseUntil`
2. `ownsCommentScheduler=true`
3. `lastCommentCommandCommentNo`
4. `lastCommentCommandUserId`

---

## 8. 반복 명령 / 중복 명령 정책

### 8.1 같은 댓글 재처리 금지

각 command comment는 `comment.no` 기준으로 한 번만 처리한다.

상태에 아래를 저장한다.

1. `lastSeenCommentNo`
2. `processedCommandCommentNos` (최근 200개 정도)

### 8.2 이미 같은 방어가 활성 중일 때

가장 안전한 정책은 이거다.

1. **같은 방어가 이미 active + owned 상태**
   - initial sweep 재실행하지 않음
   - `...Until = now + 10분`으로 연장만 함

2. **다른 owner가 이미 child를 실행 중**
   - 명령 거부
   - 로그만 남김

예시:

```txt
10:01 게시물방어 시작, 만료 10:11
10:05 같은 trusted user가 또 "@특갤봇 게시물방어"
-> initial sweep 다시 안 함
-> 만료만 10:15로 연장
```

이유:

- sweep를 매번 다시 돌리면 삭제 한도나 분류 요청을 낭비할 수 있다.

---

## 9. stop / 만료 / 수동 개입 정책

### 9.1 명령 방어 탭 OFF

탭 OFF 시에는 아래 순서로 간다.

1. polling 중지
2. 자신이 owned인 child scheduler만 stop
3. owned flag 초기화

### 9.2 10분 만료

polling loop는 각 cycle마다 만료 시각을 확인한다.

1. `postDefenseUntil <= now` 이면 owned `post/ip` stop
2. `commentDefenseUntil <= now` 이면 owned `comment` stop

### 9.3 사용자가 child 탭을 수동 OFF한 경우

이 경우 명령 방어 탭은 **그 수동 OFF를 존중**해야 한다.

v1에서는 2단계로 처리하는 게 맞다.

`게시물방어` 는 `post + ip` 가 한 세트이므로,
둘 중 하나가 수동 OFF되면 **게시물방어 세트 전체를 종료**하는 쪽이 더 안전하다.

쉽게 예시로 보면:

```txt
명령 방어가 post + ip를 같이 소유 중
-> 사용자가 post만 OFF
-> ip만 남기면 반쪽 상태가 됨
-> 따라서 ip도 같이 stop하고 postDefenseUntil도 비움
```

1차:

1. background `handleMessage(stop)` 에서
2. `post/comment/ip` 수동 stop 요청을 받을 때
3. `trustedCommandDefense` 가 그 child를 소유 중이면
4. 즉시 `handleOwnedChildStopped(feature)` 호출
5. `post` 또는 `ip` 였다면 게시물방어 세트 전체 ownership 정리

2차 fallback:

1. polling 중 child status 재확인
2. owned flag가 켜져 있었는데 실제 child가 이미 꺼져 있으면
3. 그 owned flag를 해제
4. expiry 때 다시 억지로 stop 안 함

예시:

```txt
명령 방어가 commentScheduler를 켬
-> 사용자가 댓글 방어 탭에서 직접 OFF
-> 명령 방어 탭은 다음 poll에서 "사용자 수동 정지 감지" 로그
-> ownsCommentScheduler=false 로 정리
```

---

## 10. 파일별 패치 계획

### 10.1 기존 파일: `features/trusted-comment-command-defense/parser.js`

이 파일에서 할 일:

1. trusted user 목록 normalize
2. comment memo normalize
3. prefix + 명령 본문 parse
4. command type enum 반환

추천 export:

```js
normalizeTrustedUsers(rawList)
isTrustedUser(comment, trustedUsers)
normalizeCommandMemo(memo)
parseTrustedDefenseCommand(comment, commandPrefix)
```

### 10.2 기존 파일: `features/trusted-comment-command-defense/scheduler.js`

이 파일이 핵심 owner다.

이 파일에서 할 일:

1. config/state 정의
2. polling run loop
3. lastSeenCommentNo seed
4. 게시물방어 실행
5. 댓글방어 실행
6. child ownership 관리
7. expiry 관리
8. status/log/saveState/loadState

추천 state:

```txt
isRunning
runPromise
phase
lastPollAt
lastSeenCommentNo
seeded
postDefenseUntil
commentDefenseUntil
ownsPostScheduler
ownsIpScheduler
ownsCommentScheduler
lastCommandType
lastCommandAt
lastCommandUserId
processedCommandCommentNos
logs
config
```

추가로 이 scheduler는 아래 hook도 가져야 한다.

```js
getStartBlockReason()
handleOwnedChildStopped(feature)
clearExpiredOwnership()
```

이유:

1. 필수 설정이 비어 있으면 background generic start 전에 바로 막아야 한다.
2. child 수동 OFF를 다음 poll까지 기다리지 말고 즉시 ownership 정리해야 한다.
3. 만료 처리도 poll loop 안에서 공통 함수로 정리하는 게 안전하다.
4. `post` 또는 `ip` 수동 OFF는 게시물방어 세트 전체 종료로 묶는 게 안전하다.

### 10.3 수정: `features/comment/api.js`

여기에는 명령 polling용 helper를 추가한다.

현재는 이미 아래 메서드가 들어가 있다.

```js
async fetchRecentComments(config = {}, postNo, esno, maxPages = 2)
```

최소 요구:

1. page 1은 항상 조회
2. `maxPages` 와 `totalCnt` 기준으로 필요한 최근 페이지만 추가 조회
3. return shape는 `{ comments, totalCnt, fetchedPages }`
4. root 기존 `fetchComments()` / `fetchAllComments()` 와 같은 raw comment shape 유지

핵심은 명령 게시물 polling이 `fetchAllComments()` 로 비대해지지 않게 하는 것이다.

### 10.4 수정: `features/comment/scheduler.js`

여기서는 이미 들어간 public 1회 청소 helper를 ownership 정책에 맞게 유지/보강한다.

현재는 이미 아래 메서드가 들어가 있다.

```js
async cleanupPostsOnce(posts, options = {})
```

최소 요구:

1. `posts` 배열 입력
2. `attackMode` 지정 가능
3. `source` 지정 가능
4. 현재 run loop 없이도 실행 가능
5. `totalDeleted`, `lastVerifiedDeletedCount`, logs 저장

핵심은 지금 내부의 `processPostsInParallel()` 흐름을 **1회성으로 외부 호출 가능하게 뽑는 것**이다.

### 10.5 수정: `background/background.js`

해야 할 일:

1. 새 scheduler import / instantiate
2. `getAllStatuses()`에 추가
3. `handleMessage()` generic start/stop/updateConfig/resetStats 연결
4. `applySharedConfig()`에 galleryId/headtextId 전달
5. `getBusyFeatures()`에 명령 방어 추가
6. feature-specific reset helper 추가
7. `resumeAllSchedulers()` 특수 복원 순서 추가
8. `handleMessage(stop)` 에 child 수동 OFF ownership 동기화 추가
9. `getMonitorManualLockMessage()` 또는 별도 helper에서 command-owned child update/reset 제한 추가
10. `updateConfig` branch에서 명령 게시물 URL validate + `commandPostNo` 추출 추가
11. `getConfigUpdateBlockMessage()` 에서 명령 방어 실행 중 핵심 설정 변경 제한 추가

추가로 새 scheduler constructor에는 child refs를 넘기는 게 맞다.

예시:

```js
trustedCommandDefense: new TrustedCommandDefenseScheduler({
  postScheduler: schedulers.post,
  ipScheduler: schedulers.ip,
  commentScheduler: schedulers.comment,
  monitorScheduler: schedulers.monitor,
  commentMonitorScheduler: schedulers.commentMonitor,
})
```

여기서 중요한 구현 디테일:

1. `post/comment/ip` child 수동 **stop** 은 허용
2. 대신 `trustedCommandDefense.handleOwnedChildStopped('post'|'comment'|'ip')` 를 즉시 호출
3. 반대로 command가 child를 소유 중일 때 child `updateConfig` / `resetStats` 는 막는 게 안전

쉽게 예시로 보면:

```txt
명령 방어가 post를 소유 중
-> 사용자가 post 탭 OFF
-> background stop에서 바로 ownsPostScheduler=false 저장

명령 방어가 post를 소유 중
-> 사용자가 post 설정 저장 시도
-> 거부: 명령 방어가 관리 중인 게시글 분류 설정은 먼저 종료 후 변경
```

명령 방어 자체 설정도 마찬가지다.

예시:

```txt
명령 방어가 polling 중
-> 사용자가 명령 게시물 URL을 다른 글로 바꿈
-> lastSeenCommentNo 기준이 깨짐
-> 그래서 실행 중 저장은 거부
```

reset helper는 단순 `cycleCount/logs = 0` 수준이면 안 된다.

최소한 아래를 같이 초기화해야 한다.

1. `lastSeenCommentNo`
2. `seeded`
3. `processedCommandCommentNos`
4. `postDefenseUntil`
5. `commentDefenseUntil`
6. `ownsPostScheduler`
7. `ownsIpScheduler`
8. `ownsCommentScheduler`
9. `lastCommandType`
10. `lastCommandAt`
11. `lastCommandUserId`

### 10.6 수정: `popup/popup.html`

새 탭 버튼 + 새 panel 추가.

필수 UI:

1. toggle
2. 상태 grid
3. 명령 게시물 URL input
4. 신뢰 사용자 add/remove UI
5. prefix input
6. polling interval input
7. 유지 시간 input
8. save button
9. reset button
10. log section

### 10.7 수정: `popup/popup.js`

해야 할 일:

1. `FEATURE_DOM.trustedCommandDefense` 추가
2. 저장/복원 바인딩
3. 상태 렌더 함수 추가
4. toggle start/stop 메시지 연결

실제 popup은 이미 add/remove UI로 구현돼 있으므로,
이 문서의 남은 패치 범위는 **UI 재설계가 아니라 ownership/lock 정책 조정**으로 보는 게 맞다.

---

## 11. 충돌 정책 확정안

v1에서는 **"명령 방어 탭 polling은 항상 허용, 실제 방어 실행은 축별로 판단"** 으로 확정하는 게 맞다.

### 11.1 게시물방어 명령 무시 조건

아래일 때만 `게시물방어` 명령을 무시한다.

1. `post` 또는 `ip` 가 이미 다른 owner로 실제 대응 중
2. `monitor.phase` 가 `ATTACKING` 또는 `RECOVERING` 이고, monitor가 `post/ip` takeover 준비 또는 ownership을 가진 상태

반대로 아래는 **무시 조건이 아니다.**

1. `monitor.isRunning` 이기만 한 상태
2. `monitor.phase === SEEDING/NORMAL`
3. 감시는 켜져 있지만 아직 `post/ip` child를 안 잡은 상태

예시:

```txt
monitor ON / NORMAL / post/ip OFF
-> "@특갤봇 게시물방어"
-> 실행

monitor ON / ATTACKING / post/ip ON
-> "@특갤봇 게시물방어"
-> 무시
```

### 11.2 댓글방어 명령 무시 조건

아래일 때만 `댓글방어` 명령을 무시한다.

1. `comment` 가 이미 다른 owner로 실제 대응 중
2. `commentMonitor.phase` 가 `ATTACKING` 또는 `RECOVERING` 이고, commentMonitor가 `comment` takeover 준비 또는 ownership을 가진 상태

반대로 아래는 **무시 조건이 아니다.**

1. `commentMonitor.isRunning` 이기만 한 상태
2. `commentMonitor.phase === SEEDING/NORMAL`
3. 감시는 켜져 있지만 아직 `comment` child를 안 잡은 상태

### 11.3 child 수동 조작 정책

v1은 아래처럼 나누는 게 안전하다.

1. child **stop** 은 허용
2. child **start** 는 실익이 없으므로 사실상 무시돼도 무방
3. child **updateConfig / resetStats** 는 command owner가 있을 때 거부

이유:

- stop은 운영자가 "지금 바로 그만" 하려는 의도가 분명하다.
- 반면 updateConfig/resetStats를 허용하면 10분 command run 도중 child 동작 기준이 바뀌어서 ownership 의미가 흐려진다.
- 특히 `게시물방어` 는 `post + ip` 한 세트라서, 둘 중 하나를 stop하면 세트 전체 종료가 더 자연스럽다.

또 `trustedCommandDefense` **자기 자신**의 `resetStats` 도 실행 중에는 막는 게 맞다.

쉽게 예시로 보면:

```txt
명령 방어가 polling 중
-> 사용자가 명령 방어 reset 클릭
-> lastSeenCommentNo / processedCommandCommentNos / ...Until / owned flags 가 중간에 비워짐
-> 다음 poll부터 상태 의미가 깨짐
```

즉 v1은 아래처럼 고정하는 게 안전하다.

1. `trustedCommandDefense` 실행 중
   - `updateConfig` 거부
   - `resetStats` 거부

추가로 현재 코드와 문서가 어긋나는 실제 포인트가 하나 있다.

- 지금 [background/background.js](../../background/background.js)의 `getMonitorManualLockMessage()` 는
  `monitor.isRunning` / `commentMonitor.isRunning` 만으로도 child `stop` 을 막는다.
- 그래서 trusted ownership이 살아 있어도, 운영자가 child 탭에서 직접 OFF를 눌러 ownership을 정리하는 흐름이 막힐 수 있다.

즉 여기서 필요한 수정은 아래다.

1. `monitor/commentMonitor` ON 상태여도
2. **trusted가 실제 소유 중인 child의 stop은 예외 허용**
3. 그 뒤 `handleOwnedChildStopped()` 로 세트 정리

### 11.4 trusted 명령과 자동감시의 공존 정책

이 문서 기준으로는 아래처럼 고정한다.

1. `monitor` / `commentMonitor` 는 trusted 명령과 **동시에 켜져 있어도 된다**
2. trusted가 이미 소유 중인 child는 monitor/commentMonitor가 가져가지 않는다
3. monitor/commentMonitor는 trusted child를 release 시점에 같이 끄지 않는다
4. trusted hold가 끝난 뒤에도 공격 상태가 계속이면, 다음 cycle에서 monitor/commentMonitor가 takeover 가능하다

추가로 현재 코드에는 반대 방향 lock도 남아 있다.

- [background/background.js](../../background/background.js)의 `getMonitorManualLockMessage()` 는
  trusted 게시물방어 active면 `monitor.start`
  trusted 댓글방어 active면 `commentMonitor.start`
  를 막는다.

하지만 이 문서의 최종 정책은
**"monitor/commentMonitor는 같이 켜져 있어도 되고, 실제 child ownership만 존중한다"** 이므로,
이 start lock도 같이 풀어야 문서와 실제가 맞는다.

예시:

```txt
10:00 monitor ON
10:01 trusted 게시물방어 실행
10:03 monitor ATTACKING 진입
-> monitor는 감시만 유지
-> post/ip는 trusted ownership 그대로 유지
10:11 trusted 만료
-> monitor가 여전히 ATTACKING이면 다음 cycle에서 takeover
```

### 11.5 허용 조건

1. 해당 축의 child가 꺼져 있음
2. 또는 이미 이 기능이 켠 child임
3. 또는 자동감시는 켜져 있지만 아직 그 축 child를 실제로 안 돌리고 있음

쉽게 예시로 보면:

```txt
댓글 감시 자동화가 ON이지만 아직 NORMAL
-> "@특갤봇 댓글방어"
-> 실행

댓글 감시 자동화가 ATTACKING이고 comment child 이미 ON
-> "@특갤봇 댓글방어"
-> 무시

명령 방어 탭이 5분 전에 게시물방어를 시작함
-> "@특갤봇 게시물방어" 또 들어옴
-> 재시작 아님
-> 10분 연장만
```

### 11.6 명령 게시물 자체의 트래픽 가정

v1의 `최근 2페이지 polling` 은 성능과 정확도의 균형점이다.
다만 이 전제는 **명령 게시물이 일반적으로 저트래픽**이라는 조건 위에 있다.

쉽게 예시로 보면:

```txt
명령 게시물에 1분 동안 댓글 30개
-> 최근 2페이지 polling으로 충분

명령 게시물에 1분 동안 댓글 300개
-> trusted user 명령 댓글이 3페이지 밖으로 밀릴 수 있음
-> 최근 2페이지 polling이면 놓칠 수 있음
```

그래서 운영 가이드는 아래처럼 두는 게 맞다.

1. 명령 게시물은 댓글 폭주가 적은 전용 관리 글을 쓴다.
2. v1은 최근 2페이지 고정으로 두고, 초고속 댓글 폭주는 지원 범위 밖으로 본다.

---

## 12. 남은 조정 구현 순서

현재는 parser / popup / recent comment polling / 댓글 1회 청소 helper까지 이미 들어가 있다.
남은 건 **충돌 정책과 ownership 복원 보정**이다.

가장 안전한 순서는 아래다.

1. `background/background.js`
   - `getTrustedCommandDefenseStartBlockMessage()` 완화
   - `getMonitorManualLockMessage()` 완화
   - `shouldAllowPostDefenseStart` / `shouldAllowCommentDefenseStart` 기준을 phase/ownership 기반으로 교체
2. `features/monitor/scheduler.js` / `features/comment-monitor/scheduler.js`
   - `getStartBlockReason()` 이 trusted-owned child를 blocker로 보지 않게 완화
3. `features/trusted-comment-command-defense/scheduler.js`
   - 같은 축이 이미 자동 대응 중이면 `throw` 대신 ignore log 처리
   - `headtextId` 검사를 scheduler start가 아니라 게시물방어 실행 시점으로 이동
4. `features/monitor/scheduler.js`
   - trusted-owned `post/ip` takeover 금지
   - release 시 trusted-owned `post/ip` stop 금지
5. `features/comment-monitor/scheduler.js`
   - trusted-owned `comment` takeover 금지
   - release 시 trusted-owned `comment` stop 금지
6. 재시작 복원 검증
   - trusted active + monitor/commentMonitor NORMAL
   - trusted active + ATTACKING
   - trusted child 수동 OFF 직후 재시작

이 순서가 좋은 이유:

- 지금 핵심 문제는 새 UI나 새 API가 아니라 **lock/ownership 판정**이다.
- 먼저 background와 trusted scheduler 기준을 고쳐야 나머지 monitor/commentMonitor 보강이 맞물린다.
- 마지막에 복원 시나리오를 다시 확인해야 재시작 꼬임을 같이 잡을 수 있다.

---

## 13. 정적 검증 체크리스트

패치 후 최소한 아래를 검증해야 한다.

1. 토글 ON 시 예전 댓글 명령을 재실행하지 않는가
2. trusted user가 아닌 댓글은 무시되는가
3. prefix 뒤 본문이 `게시물방어`/`댓글방어` 가 아닌 문구는 무시되는가
4. `게시물방어` 명령이 page1 snapshot 기준으로 cutoff를 잡는가
5. `게시물방어` initial sweep가 유동글만 분류하는가
6. `게시물방어` initial sweep가 도배기탭 page1 삭제를 수행하는가
7. `게시물방어` 이후 `post/ip` child가 실제 ON 상태로 보이는가
8. `댓글방어` initial sweep가 page1 게시물들의 댓글만 1회 청소하는가
9. `댓글방어` 이후 `comment` child가 실제 ON 상태로 보이는가
10. 같은 명령 재입력 시 initial sweep 재실행 없이 만료만 연장되는가
11. `monitor` 가 `NORMAL/SEEDING` 일 때 `게시물방어` 명령이 정상 실행되는가
12. `commentMonitor` 가 `NORMAL/SEEDING` 일 때 `댓글방어` 명령이 정상 실행되는가
13. `monitor` 가 실제 `ATTACKING/RECOVERING` 으로 게시물 축 대응 중일 때만 `게시물방어` 명령이 무시되는가
14. `commentMonitor` 가 실제 `ATTACKING/RECOVERING` 으로 댓글 축 대응 중일 때만 `댓글방어` 명령이 무시되는가
15. trusted 게시물방어 실행 중 monitor가 child source/cutoff/attackMode를 takeover하지 않는가
16. trusted 댓글방어 실행 중 commentMonitor가 comment child source/attackMode를 takeover하지 않는가
17. monitor release 시 trusted `post/ip` child를 같이 stop하지 않는가
18. commentMonitor release 시 trusted `comment` child를 같이 stop하지 않는가
19. child 탭을 사용자가 수동 OFF하면 ownership이 정리되는가
20. 명령 방어 탭 OFF 시 owned child만 stop하는가
21. popup 상태와 background status가 일치하는가
22. polling이 `fetchAllComments()` 가 아니라 최근 1~2페이지 조회로 유지되는가
23. trusted user 판정이 실제 `comment.user_id` 기준으로 동작하는가
24. 명령 게시물 URL 저장 시 shared `galleryId` 와 다른 갤 URL은 거부되는가
25. 브라우저 재시작 후 owned child가 standalone처럼 잘못 복원되지 않는가
26. child를 수동 OFF한 직후 브라우저를 닫아도 stale ownership이 남지 않는가
27. 명령 방어 실행 중 `commandPostUrl/trustedUsers/prefix/pollInterval/holdMs` 저장이 거부되는가
28. reset 시 `lastSeenCommentNo/seeded/processedCommandCommentNos/...Until/owned flags` 가 함께 비워지는가
29. 저장 안 된 명령 방어 설정이 남아 있을 때 toggle ON이 거부되는가
30. `extractHeadtextName()` 실패 시 게시물방어가 fail-safe로 중단되는가
31. 명령 방어 실행 중 자기 자신의 `resetStats` 가 거부되는가
32. 축 A가 이미 자동 대응 중일 때 축 B 명령은 독립적으로 실행 가능한가
33. `headtextId` 가 없어도 명령 방어 polling 자체는 시작 가능한가
34. trusted active + monitor/commentMonitor NORMAL 상태에서 재시작 복원이 막히지 않는가
35. monitor/commentMonitor ON 상태에서도 trusted가 소유한 child stop은 허용되는가
36. trusted-owned `post/ip/comment` 가 켜져 있어도 monitor/commentMonitor 수동 start가 가능하고, start 직후 child를 바로 뺏지 않는가

---

## 14. 이 문서 기준으로 바로 패치 가능한 범위

이 문서 기준으로는 아래까지 바로 패치 가능하다.

1. root 프로젝트 내부 단독 구조
2. 새 탭 1개
3. 신뢰사용자 add/remove UI 저장
4. 명령 게시물 댓글 polling
5. exact command 인식
6. 게시물방어 10분 유지
7. 댓글방어 10분 유지
8. child ownership 관리

남는 구현상 핵심 포인트는 이제 3개다.

1. `features/comment/api.js` 의 최근 댓글 조회 helper가 broad start block에 막히지 않게 하는 것
2. `features/comment/scheduler.js` 의 댓글 1회 청소 helper가 trusted ownership 정책과 충돌하지 않게 하는 것
3. `background/background.js` / `monitor` / `commentMonitor` 의 복원·takeover·manual stop 정책을 특수 처리하는 것

이건 새 발명이라기보다 **이미 있는 helper와 ownership 흐름을 현재 정책에 맞게 정렬하는 리팩터링** 문제다.

쉽게 말하면:

```txt
게시물방어 쪽:
이미 있는 부품 조립

댓글방어 쪽:
이미 있는 엔진을 바깥 스위치에서도 돌릴 수 있게 배선 빼기

복원 쪽:
이미 있는 parent-child 복원 패턴에 명령 방어 한 갈래 더 넣기
```

---

## 15. 최종 판단

최종 판단은 아래다.

1. 사용자 요구 방향은 지금 코드베이스에서 충분히 구현 가능하다.
2. 신문고봇과 직접 연결하는 방식보다, root 확장이 polling과 방어를 둘 다 소유하는 방식이 낫다.
3. UI는 새 탭 1개가 가장 맞다.
4. 게시물방어는 현재 코드 재사용 비율이 높다.
5. 댓글방어 1회 청소 helper는 이미 들어가 있고, 남은 건 ownership 충돌 정책 조정이다.
6. polling은 이미 `fetchRecentComments()` 를 쓰고 있으므로, 남은 건 주기/충돌 정책 조정이다.
7. 복원과 child 수동 OFF 동기화까지 설계에 넣어야 실제 운영에서 ownership이 안 꼬인다.
8. v1 충돌정책은 “명령 방어 polling은 항상 허용, 실제 방어 실행은 축별로 이미 대응 중일 때만 무시”가 맞다.
9. `headtextId` 는 게시물방어 실행 시점에만 요구하고, polling start 조건으로 두면 안 된다.
10. monitor/commentMonitor는 trusted child를 takeover하거나 release 시 같이 stop하면 안 된다.
11. monitor/commentMonitor ON 상태에서도 trusted가 소유한 child stop은 막지 말아야 한다.
12. monitor/commentMonitor의 own `getStartBlockReason()` 도 trusted-owned child 공존 기준으로 같이 완화돼야 한다.

즉 이 기능은

- **새 탭 1개**
- **새 scheduler 1개**
- **기존 최근 댓글 조회 helper의 start/restore 조건 정리**
- **기존 댓글 1회 청소 helper의 ownership 연동 정리**
- **background 복원/ownership 보강**
- **monitor/commentMonitor의 trusted ownership 존중 로직 보강**

이 세 축으로 구현하는 게 제일 깔끔하다.
