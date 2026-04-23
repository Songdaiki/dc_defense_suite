# 신뢰사용자 댓글 명령 방어 탭 설계서

> 작성일: 2026-04-23  
> 범위: **root 프로젝트(`/home/eorb915/projects/dc_defense_suite`) 기준**  
> 목적: 신뢰사용자 댓글 명령으로 `게시물방어` / `댓글방어`를 즉시 10분간 켜는 전용 탭을, 지금 코드 구조에 맞게 바로 패치 가능한 수준으로 정리

## 1. 목표

이 문서의 목표는 아래 요구를 **지금 레포 구조에서 실제로 구현 가능한 방식**으로 고정하는 것이다.

1. 운영자가 지정한 `명령 게시물` 1개를 정한다.
2. 신뢰사용자가 그 글에 댓글로 명령을 쓴다.
3. 확장프로그램이 1분마다 그 댓글을 읽는다.
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
  - `1분 polling`
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

### 3.4 댓글 쪽은 "1회 청소 helper"가 아직 public API로 안 빠져 있다

댓글 쪽 핵심 파일은 [features/comment/scheduler.js](../../features/comment/scheduler.js) 다.

현재 이 파일은 이미 아래 모든 걸 갖고 있다.

1. 1페이지 게시물 목록 조회
2. 각 게시물 댓글 페이지 조회
3. 유동 댓글 필터
4. 삭제 또는 삭제+차단
5. 검증 삭제 수 기록

문제는 이 흐름이 지금 public helper로 분리되어 있지 않다는 점이다.

실제 삭제 핵심은 아래 내부 흐름에 묻혀 있다.

1. `processPost(post, sharedEsno)`
2. `processPostsInParallel(posts, sharedEsno)`
3. `executeCommentDeletionBatch(...)`

즉 새 기능에서 필요한 댓글 쪽 추가 작업은 이거다.

- `commentScheduler` 안에 `cleanupPostsOnce(posts, options)` 같은 **1회성 public helper**를 뽑아야 한다.

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

즉 v1은 wrapper만 추가하는 게 아니라,
**`isRunning`과 독립적으로 1회 청소를 수행할 수 있는 public helper**를 새로 꺼내는 쪽이 맞다.

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

### 3.5 명령 댓글 polling은 `전체 댓글 조회`가 아니라 `최근 1~2페이지 조회`가 맞다

이건 구조적으로 중요한 포인트다.

지금 root [features/comment/api.js](../../features/comment/api.js) 에는
`fetchAllComments()` 는 있지만, `dc_auto_bot` 쪽에 있는 `fetchRecentComments()` 같은 helper는 없다.

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

그래서 이 기능은 신문고봇처럼
**최근 1~2페이지만 읽고, 거기서 새 댓글만 보는 구조**로 고정하는 게 맞다.

즉 새 기능 설계는 아래처럼 바꿔야 한다.

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

그래서 새 기능은 **기존 child scheduler가 이미 다른 owner로 실행 중이면 시작하지 않는 정책**이 가장 안전하다.

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

### 4.2 새 파일

최소 파일 구조는 아래를 추천한다.

```txt
features/trusted-command-defense/
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

필요하면 아래 helper 추출도 추가한다.

```txt
features/trusted-command-defense/actions.js   (선택)
```

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

정규화 후 exact match만 허용한다.

1. `@특갤봇 게시물방어`
2. `@특갤봇 게시물 방어`
3. `@특갤봇 댓글방어`
4. `@특갤봇 댓글 방어`

예시:

```txt
허용:
@특갤봇 게시물방어
@특갤봇 댓글 방어

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

v1은 popup에서 별도 add/remove 버튼까지 만들 필요 없다.
`설정 저장` 패턴에 맞춰 textarea 기반으로 가는 게 더 단순하다.

필수 입력:

1. 명령 게시물 URL
2. 신뢰 사용자 목록 textarea
3. 명령 prefix
4. polling 주기(ms)
5. 유지 시간(ms)

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

신뢰 사용자 목록 문법 예시:

```txt
gung_master,주딱
sub_admin_01,부매니저1
sub_admin_02
```

규칙:

1. 한 줄당 1명
2. `userId,label` 또는 `userId`
3. label이 없으면 userId를 그대로 로그에 표시

이 방식이 좋은 이유:

1. root popup은 원래 `설정 저장` 중심 구조다.
2. `addTrustedUser/removeTrustedUser` 전용 background action을 새로 안 만들어도 된다.
3. 문서/운영이 단순하다.

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

아래 중 하나면 시작하지 않는다.

1. `monitor`가 실행 중
2. `post`가 이미 다른 owner로 실행 중
3. `ip`가 이미 다른 owner로 실행 중
4. 공통 `headtextId` 가 비어 있음

이유:

- `monitor`는 스스로 `post/ip` child ownership을 관리한다.
- 그 상태에서 명령 기능이 끼어들면 종료 시 누가 뭘 끌지 꼬인다.
- `게시물방어`는 "도배기탭 1페이지 삭제"까지 포함이라 `headtextId` 없이는 반쪽 실행이 된다.

예시:

```txt
이미 감시 자동화가 공격 상태
-> 댓글 명령 게시물방어 도착
-> 실행 안 함
-> 로그: 감시 자동화가 post/ip child를 소유 중이라 게시물방어 명령을 건너뜀

shared headtextId 비어 있음
-> "@특갤봇 게시물방어" 도착
-> 실행 안 함
-> 로그: 도배기 말머리 ID가 없어 게시물방어 명령을 건너뜀
```

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

아래 중 하나면 시작하지 않는다.

1. `commentMonitor`가 실행 중
2. `comment`가 이미 다른 owner로 실행 중

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

### 10.1 새 파일: `features/trusted-command-defense/parser.js`

이 파일에서 할 일:

1. trusted user 목록 normalize
2. comment memo normalize
3. exact command parse
4. command type enum 반환

추천 export:

```js
normalizeTrustedUsers(rawList)
isTrustedUser(comment, trustedUsers)
normalizeCommandMemo(memo)
parseTrustedDefenseCommand(comment, commandPrefix)
```

### 10.2 새 파일: `features/trusted-command-defense/scheduler.js`

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

추천 메서드:

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

여기에는 public 1회 청소 helper를 추가한다.

추천 메서드:

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
4. trusted users textarea
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

여기서는 `dc_auto_bot`처럼 add/remove 버튼 API를 만들지 말고,
textarea 전체 저장 방식으로 단순하게 간다.

---

## 11. 충돌 정책 확정안

v1에서는 아래처럼 확정하는 게 가장 안전하다.

### 11.1 게시물방어 명령 거부 조건

1. `monitor.isRunning`
2. `post.isRunning && !ownedByCommand`
3. `ip.isRunning && !ownedByCommand`

### 11.2 댓글방어 명령 거부 조건

1. `commentMonitor.isRunning`
2. `comment.isRunning && !ownedByCommand`

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

### 11.4 허용 조건

1. 해당 child가 꺼져 있음
2. 또는 이미 이 기능이 켠 child임

쉽게 예시로 보면:

```txt
댓글 감시 자동화가 이미 ON
-> "@특갤봇 댓글방어" 무시

명령 방어 탭이 5분 전에 게시물방어를 시작함
-> "@특갤봇 게시물방어" 또 들어옴
-> 재시작 아님
-> 10분 연장만
```

### 11.5 명령 게시물 자체의 트래픽 가정

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

## 12. 실제 구현 순서

가장 안전한 순서는 아래다.

1. `parser.js` 추가
2. `comment/api.js` 에 `fetchRecentComments()` 추가
3. `commentScheduler.cleanupPostsOnce()` helper 추출
4. `scheduler.js` 추가
5. `background/background.js` 등록
6. `popup.html/js` 탭 추가
7. 실제 polling -> command detect -> extend policy 구현
8. child ownership / expiry stop 구현
9. `resumeAllSchedulers()` 특수 복원 구현
10. child 수동 OFF 즉시 ownership 정리 구현
11. 저장 상태 복원 / reset / 로그 정리

이 순서가 좋은 이유:

- `fetchRecentComments()` 가 먼저 없으면 polling 설계가 처음부터 비효율적으로 굳는다.
- 댓글 1회 청소 helper가 빠지면 댓글방어 구현이 중간에 막힌다.
- background/popup를 먼저 붙이면 UI는 떠도 실제 실행이 비어 있을 수 있다.
- 복원/ownership 동기화를 마지막에 빼먹으면 재시작 직후 꼬임이 남는다.

---

## 13. 정적 검증 체크리스트

패치 후 최소한 아래를 검증해야 한다.

1. 토글 ON 시 예전 댓글 명령을 재실행하지 않는가
2. trusted user가 아닌 댓글은 무시되는가
3. exact match가 아닌 명령 문구는 무시되는가
4. `게시물방어` 명령이 page1 snapshot 기준으로 cutoff를 잡는가
5. `게시물방어` initial sweep가 유동글만 분류하는가
6. `게시물방어` initial sweep가 도배기탭 page1 삭제를 수행하는가
7. `게시물방어` 이후 `post/ip` child가 실제 ON 상태로 보이는가
8. `댓글방어` initial sweep가 page1 게시물들의 댓글만 1회 청소하는가
9. `댓글방어` 이후 `comment` child가 실제 ON 상태로 보이는가
10. 같은 명령 재입력 시 initial sweep 재실행 없이 만료만 연장되는가
11. `monitor` 실행 중 `게시물방어` 명령은 거부되는가
12. `commentMonitor` 실행 중 `댓글방어` 명령은 거부되는가
13. child 탭을 사용자가 수동 OFF하면 ownership이 정리되는가
14. 명령 방어 탭 OFF 시 owned child만 stop하는가
15. popup 상태와 background status가 일치하는가
16. polling이 `fetchAllComments()` 가 아니라 최근 1~2페이지 조회로 유지되는가
17. trusted user 판정이 실제 `comment.user_id` 기준으로 동작하는가
18. 명령 게시물 URL 저장 시 shared `galleryId` 와 다른 갤 URL은 거부되는가
19. 브라우저 재시작 후 owned child가 standalone처럼 잘못 복원되지 않는가
20. child를 수동 OFF한 직후 브라우저를 닫아도 stale ownership이 남지 않는가
21. 명령 방어 실행 중 `commandPostUrl/trustedUsers/prefix/pollInterval/holdMs` 저장이 거부되는가
22. reset 시 `lastSeenCommentNo/seeded/processedCommandCommentNos/...Until/owned flags` 가 함께 비워지는가
23. 저장 안 된 명령 방어 설정이 남아 있을 때 toggle ON이 거부되는가
24. `extractHeadtextName()` 실패 시 게시물방어가 fail-safe로 중단되는가
25. 명령 방어 실행 중 자기 자신의 `resetStats` 가 거부되는가

---

## 14. 이 문서 기준으로 바로 패치 가능한 범위

이 문서 기준으로는 아래까지 바로 패치 가능하다.

1. root 프로젝트 내부 단독 구조
2. 새 탭 1개
3. 신뢰사용자 textarea 저장
4. 명령 게시물 댓글 polling
5. exact command 인식
6. 게시물방어 10분 유지
7. 댓글방어 10분 유지
8. child ownership 관리

남는 구현상 핵심 포인트는 이제 3개다.

1. `features/comment/api.js` 안의 최근 댓글 조회 helper 추가
2. `features/comment/scheduler.js` 안의 댓글 1회 청소 흐름을 public helper로 뽑는 것
3. `background/background.js` 복원/ownership 동기화를 특수 처리하는 것

이건 새 발명이라기보다 **지금 내부에 묻혀 있는 로직과 복원 순서를 밖으로 꺼내는 리팩터링** 문제다.

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
5. 댓글방어는 `cleanupPostsOnce()` helper 추출이 추가로 필요하다.
6. polling은 `fetchAllComments()` 가 아니라 `fetchRecentComments()` 를 새로 넣어야 느려지지 않는다.
7. 복원과 child 수동 OFF 동기화까지 설계에 넣어야 실제 운영에서 ownership이 안 꼬인다.
8. v1 충돌정책은 “이미 다른 owner가 child를 돌리고 있으면 거부”가 가장 안전하다.

즉 이 기능은

- **새 탭 1개**
- **새 scheduler 1개**
- **최근 댓글 조회 helper 1개 추가**
- **댓글 1회 청소 helper 1개 추출**
- **background 복원/ownership 보강**

이 세 축으로 구현하는 게 제일 깔끔하다.
