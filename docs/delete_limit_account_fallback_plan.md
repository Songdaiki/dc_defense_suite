# 삭제 한도 계정 Fallback 플랜

## 목적

삭제 한도에 걸렸을 때 현재처럼 바로 `IP 차단만 유지`로 내려가는 대신,
부매니저 계정이 하나 더 있을 경우 **같은 크롬 프로필 / 같은 확장 / 같은 창 흐름 안에서**
디시 세션을 다른 계정으로 전환하고 자동화를 이어서 수행하는 구조를 정의한다.

이 문서는 다음 상황을 기준으로 한다.

- 자동화가 이미 켜져 있음
- 공격 대응 중일 수 있음
- 삭제 한도가 현재 활성 계정에서 발생함
- 부계정도 동일 갤 매니저/부매니저 권한이 있음

핵심 목표는 이거다.

1. 본계정으로 삭제/차단 수행 중 삭제 한도 초과 감지
2. 전용 세션 탭에서 부계정으로 자동 로그인
3. 같은 자동화 흐름을 끊지 않고 이어서 진행
4. 부계정도 삭제 한도 초과가 나면 본계정으로 한 번만 되돌림
5. 짧은 시간 안에 양쪽 다 삭제 한도 초과가 반복되면 계정 전환 루프를 멈추고
6. 현재처럼 `IP 차단만 유지` 모드로 안전하게 내려감


## 현재 확정 구현 방향

이 작업의 1차 구현 방향은 아래로 확정한다.

1. 메인 확장에 신문고봇식 로그인 자동화 권한/전용 탭 로직 추가
2. 설정에 `본계정`, `부계정` 추가
3. 공통 설정에 실제 broker 경로를 타는 `계정 전환 테스트` 버튼 추가
4. background에 `dcSessionBroker` 하나 둠
5. `IP 삭제한도` 감지 시만 broker가 계정 전환 시도
6. 전환 성공하면 같은 run 계속
7. 실패하면 지금처럼 `ban-only`
8. 부계도 limit면 본계 1회 복귀
9. 짧은 시간 안에 다시 limit면 더 이상 전환 안 하고 `ban-only`
10. **1차는 특궁-신문고봇 external bridge 없이 간다**

구현 스펙은 아래 문서로 분리한다.

- [delete_limit_account_fallback_spec.md](/home/eorb915/projects/dc_defense_suite/docs/delete_limit_account_fallback_spec.md)

로그인 전환 참조 구현은 아래 문서를 따른다.

- [dc_session_switch_login_reference_spec.md](/home/eorb915/projects/dc_defense_suite/docs/dc_session_switch_login_reference_spec.md)

세션 유지 자동화 ownership 이전은 아래 문서를 같이 따른다.

- [dc_session_broker_login_keepalive_plan.md](/home/eorb915/projects/dc_defense_suite/docs/dc_session_broker_login_keepalive_plan.md)


## 결론 먼저

가능은 하다. 다만 구조 변경 범위가 크다.

중요:

- `삭제 한도 계정 fallback`만 먼저 붙이고
- 신문고봇의 기존 로그인 자동화를 그대로 두면
- 두 프로젝트가 같은 브라우저 쿠키 세션을 각자 복구하려 하면서 충돌 가능성이 남는다

즉 운영 기준으로는:

1. 특궁 `dcSessionBroker`가 세션 유지까지 가져오고
2. 신문고봇은 로그인 자동화 dependency를 제거해야 하며
3. delete-limit fallback이 안정적으로 굴러간다

이유는 현재 모든 디시 관련 요청이:

- `fetch(..., { credentials: 'include' })`
- `chrome.cookies.get(... name: 'ci_c')`

를 사용하기 때문에, **확장 전체가 브라우저 프로필의 쿠키 세션 1개를 공유**하기 때문이다.

즉 이 기능은:

- 계정 A용 크롬 창
- 계정 B용 크롬 창

처럼 분리하는 문제가 아니라,

- **현재 확장 전체의 디시 세션을 전역으로 A <-> B 전환하는 문제**

다.

그래서 답은:

- `IP 차단만 계정 B`
- `댓글 방어는 계속 계정 A`

처럼 병렬 분리는 안 되고,

- **세션 스위치 시점에는 전체 자동화를 잠깐 멈추고**
- **세션 전환 후 전체 자동화를 같은 새 계정 세션으로 계속 수행**

하는 구조가 맞다.


## 현재 실제 구조

### 1. 모든 디시 요청은 같은 쿠키 세션을 공유한다

현재 확장은 디시 요청마다 별도 계정 컨텍스트를 넘기지 않는다.

- 권한:
  - [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json)
- 댓글:
  - [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js)
- 게시글:
  - [features/post/api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js)
- IP 차단:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js)
- 도배기 갱신 차단:
  - [features/han-refresh-ip-ban/api.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/api.js)
- 신문고 봇:
  - 로그인 전환 레퍼런스만 참조
  - 메인 확장 1차 lease 적용 범위에는 포함하지 않음

공통 특징:

- `credentials: 'include'`
- `ci_t`는 `ci_c` 쿠키에서 읽음

즉 쿠키가 바뀌면 **모든 기능의 계정이 한꺼번에 바뀐다.**

### 2. 현재 background는 스케줄러들을 하나의 전역 registry로 관리한다

- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)

현재 등록된 주요 자동화:

- `comment`
- `commentMonitor`
- `post`
- `semiPost`
- `ip`
- `monitor`
- `hanRefreshIpBan`
- `conceptMonitor`

즉 전역 세션 전환을 넣을 위치는 사실상 `background/background.js`가 맞다.

### 3. 지금 public `stop()`을 그대로 쓰면 “이어지게” 하기 어렵다

기존 stop은 단순 대기 상태가 아니라 **진행 상태와 runtime mode를 많이 초기화**한다.

- 댓글 stop:
  - `currentSource = ''`
  - `excludePureHangulMode = false`
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js)
- 게시글 stop:
  - `currentPage = 0`
  - `clearRuntimeAttackMode()`
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js)
- IP stop:
  - `currentPage = 0`
  - `includeExistingTargetsMode = false`
  - `runtimeDeleteEnabled` 재설정
  - `lastDeleteLimitExceededAt` 초기화
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js)

즉 삭제 한도 fallback은 `stop() -> login -> start()` 재사용보다,

- `세션 스위치 중 신규 요청만 막고`
- `in-flight 요청이 끝나면 로그인 전환`
- `기존 run loop를 그대로 이어가기`

가 더 안전하다.

### 4. 현재 background 부트스트랩 순서는 broker보다 schedulers가 먼저다

메인 background는 현재 top-level에서 바로 scheduler 복원을 시작한다.

- 초기 호출:
  - [background/background.js#L38](/home/eorb915/projects/dc_defense_suite/background/background.js#L38)
- scheduler 복원:
  - [background/background.js#L90](/home/eorb915/projects/dc_defense_suite/background/background.js#L90)
- dormant child 정리:
  - [background/background.js#L667](/home/eorb915/projects/dc_defense_suite/background/background.js#L667)
  - [background/background.js#L691](/home/eorb915/projects/dc_defense_suite/background/background.js#L691)

즉 broker를 넣을 때는:

1. broker runtime/state 복원
2. switch 진행 중인지 reconcile
3. 그 다음 `resumeAllSchedulers()`

순서를 강제해야 한다.

이 순서가 안 맞으면:

- service worker 재시작 직후
- 이전 계정 전환이 아직 덜 끝난 상태에서
- IP/monitor child가 먼저 재개

하는 race가 생길 수 있다.

### 5. 모든 run loop는 지금 pause를 일반 오류로 취급한다

현재 주요 scheduler는 공통적으로:

- `catch (error)`
- `오류 발생` 로그
- `10초 후 재시도`

패턴을 갖고 있다.

- IP:
  - [features/ip/scheduler.js#L240](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L240)
  - [features/ip/scheduler.js#L292](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L292)
- monitor:
  - [features/monitor/scheduler.js#L143](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L143)
  - [features/monitor/scheduler.js#L201](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L201)
- 댓글/게시글/도배기 갱신 차단/개념글 방어도 동일 계열

즉 broker가 pause/abort를 그냥 `Error`로 던지면 안 된다.

반드시:

- `AbortError`
- 또는 `SessionSwitchPauseError`

같은 **명시적 제어 예외**를 두고,
scheduler 쪽에서:

- 오류 로그를 찍지 않고
- 10초 재시도 sleep도 타지 않도록

특별 처리해야 한다.

### 6. 계정 정보는 scheduler.config에 넣으면 안 된다

신문고봇 레퍼런스는 단일 봇이라 로그인 정보가 `scheduler.config`에 들어 있다.

- [projects/dc_auto_bot/background/background.js#L337](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L337)

하지만 메인 확장은:

- 여러 scheduler가 따로 저장되고
- `updateSharedConfig`는 공통 갤 설정용이며
- 각 scheduler state가 따로 `chrome.storage.local`에 저장된다

즉 계정 정보를 각 scheduler `config`에 넣으면:

- 동일 credential이 여러 저장 키에 중복 저장되고
- 일부 scheduler만 갱신된 상태가 생기고
- reset/load 경로에서 드리프트가 날 수 있다

그래서:

- 계정1/계정2 정보
- 활성 계정
- 전환 중 상태

는 **broker 전용 저장소**로 따로 가져가야 한다.

### 7. 계정 설정 업데이트는 shared config 경로를 타면 안 된다

메인 background의 `updateSharedConfig`는 현재:

- gallery/headtext 계열 공통 설정
- 실행 중 busy feature 차단

을 담당한다.

- [background/background.js#L176](/home/eorb915/projects/dc_defense_suite/background/background.js#L176)
- [background/background.js#L552](/home/eorb915/projects/dc_defense_suite/background/background.js#L552)

계정1/계정2 설정은 이 경로가 아니라 별도 action이 맞다.

권장:

- `updateSessionFallbackConfig`
- `getSessionFallbackStatus`

처럼 broker 전용 메시지로 분리

이유:

- 계정 정보는 feature 공통 설정과 성격이 다르고
- 저장 위치도 scheduler가 아니라 broker여야 하며
- 향후 `switchInProgress` 중 수정 금지 같은 별도 정책이 필요하기 때문이다.


### 8. 1차는 신문고봇과 external bridge 없이 간다

1차 운영 정책은 아래로 고정한다.

1. 특궁 메인 확장이 세션 유지/계정 전환 ownership을 가진다
2. 신문고봇은 자체 로그인 자동화를 제거한다
3. **`onMessageExternal` 같은 cross-extension bridge는 1차에 넣지 않는다**
4. 계정 전환 중 짧은 창구간에서 신문고봇 액션 1회 실패 가능성은 운영상 허용한다

즉 1차 목표는:

- 세션 주도권 충돌 제거
- delete-limit fallback 안정화

이고,

- 전환 중 broker 상태를 외부 확장에 실시간 공개
- 신문고봇이 `switchInProgress`를 보고 잠깐 대기

같은 보강은 후순위다.


### 9. external bridge가 없으면 신문고봇 액션은 broker lease 바깥에 남는다

1차에서 external bridge를 안 넣는다는 뜻은,
신문고봇 액션이 특궁 broker의 high-level lease에 직접 참여하지 않는다는 뜻이기도 하다.

즉:

- 특궁 내부 feature들
  - `comment`
  - `post`
  - `ip`
  - `semiPost`
  - `conceptMonitor`
  - `hanRefreshIpBan`

은 broker lease로 pause 가능하지만,

- 신문고봇 액션은 같은 쿠키를 쓰더라도 **별도 프로젝트**라서
  그 lease drain 대상에 직접 들어오지 않는다.

1차 정책은 이 상태를 운영상 허용한다.

의미:

- delete-limit 전환 중
- 신문고봇 액션 1건이 짧은 타이밍에 겹치면
- 그 1건은 실패할 수 있다

하지만 중요한 건:

- 신문고봇이 세션을 다시 덮어쓰지 않는 것

이고,

- broker lease에 외부 프로젝트까지 참여시키는 것

은 1차 범위가 아니다.


### 10. broker keepalive를 붙이면 현재 fallback UI 계약도 같이 바뀐다

지금 특궁 popup의 fallback 영역은 사실상:

- 계정 저장
- `계정 전환 테스트`
- 활성 계정 / 전환 상태 / 최근 delete-limit 계정

만 다룬다.

- [popup/popup.html#L850](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L850)
- [popup/popup.js#L341](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L341)

하지만 broker가 로그인 유지까지 소유하게 되면,
이 영역은 더 이상 “delete-limit 전환만”의 UI가 아니다.

최소한 다음 상태가 추가로 필요하다.

1. 로그인 유지 자동화 ON/OFF
2. 현재 login health
3. session automation busy 상태

이유:

- health-check 중
- auto relogin 중
- session tab 재생성 중

에도 사용자가 계정 저장 / 수동 전환 테스트를 누르면
같은 session tab과 singleflight를 건드리게 된다.

즉 keepalive 이전은 단순 background 기능 추가로 끝나지 않고,
**popup 상태/잠금 계약 변경까지 같이 와야 한다**는 점을 문서에 포함한다.

### 8. broker는 scheduler registry에 넣지 않는 편이 낫다

현재 registry는 모두 `start/stop/getStatus/saveState/loadState/ensureRunLoop` 류의 scheduler 형태를 전제한다.

- [background/background.js#L22](/home/eorb915/projects/dc_defense_suite/background/background.js#L22)

`dcSessionBroker`는:

- 장기 run loop가 아니라
- 전역 세션 상태 관리자
- lease/gate/switch orchestration

이므로 scheduler registry에 끼워 넣기보다
background singleton 서비스로 두는 쪽이 맞다.

### 9. pause 대상은 IP만이 아니라 모든 DC 요청자다

1차 트리거는 IP여도, 세션 자체는 전역 공유다.

즉 메인 확장 기준으로 아래 요청자들은 모두 broker gate/lease 대상이 된다.

- 댓글 API:
  - [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js)
- 게시글 API:
  - [features/post/api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js)
- IP API:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js)
- 반고닉 API:
  - [features/semi-post/api.js](/home/eorb915/projects/dc_defense_suite/features/semi-post/api.js)
- 개념글 방어 API:
  - [features/concept-monitor/api.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/api.js)
- 도배기 갱신 차단 API:
  - [features/han-refresh-ip-ban/api.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/api.js)

특히 아래는 장기 대기시간이 있어 abort 가능성이 중요하다.

- 댓글 403 backoff 30초:
  - [features/comment/api.js#L63](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L63)
- 반고닉 403 backoff 30초:
  - [features/semi-post/api.js#L34](/home/eorb915/projects/dc_defense_suite/features/semi-post/api.js#L34)
- 개념글 방어 403 backoff 30초:
  - [features/concept-monitor/api.js#L39](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/api.js#L39)

즉 "IP만 broker 붙이기"가 아니라,
**트리거는 IP만, gate는 전 세션 요청자 공통**
으로 이해해야 한다.

### 10. monitor 연동은 child sync 경로까지 같이 봐야 한다

현재 monitor는 child IP 상태를 보고 스스로도 ban-only를 굳힌다.

- child sync:
  - [features/monitor/scheduler.js#L380](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L380)
  - [features/monitor/scheduler.js#L598](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L598)
- 직접 ban-only commit:
  - [features/monitor/scheduler.js#L579](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L579)

즉 1차 구현이 IP trigger만 사용하더라도,
나중에 monitor child가 같은 IP scheduler를 관리할 때는:

- IP scheduler가 너무 일찍 `runtimeDeleteEnabled=false`
- `lastDeleteLimitExceededAt` 세팅

을 해버리면 monitor가 그것을 보고 이번 공격 세션을 영구 ban-only로 굳힐 수 있다.

그래서 `detect delete-limit`와 `commit ban-only`를 분리하는 작업은
IP 단독 경로뿐 아니라 **monitor child 연동 관점에서도 필수**다.

### 11. monitor initial sweep는 pause 예외를 일반 실패로 처리하면 안 된다

현재 `performInitialSweep()`는 classify/delete에서 오류가 나더라도
마지막에 무조건:

- `pendingInitialSweepPosts = []`
- `initialSweepCompleted = true`

를 실행한다.

- [features/monitor/scheduler.js#L469](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L469)
- [features/monitor/scheduler.js#L512](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L512)

즉 계정 전환용 pause/abort가 여기서 일반 error로 잡히면:

- initial sweep가 실제로는 덜 끝났는데
- 이미 완료된 것으로 굳어져
- 재개 후 남은 initial sweep를 놓칠 수 있다

따라서 monitor 쪽은:

- `SessionSwitchPauseError`
- `AbortError`

를 별도 분기해서

- `pendingInitialSweepPosts` 유지
- `initialSweepCompleted` 유지값 보존
- "완료" 로그를 찍지 않음

으로 처리해야 한다.

### 12. 현재 delay/backoff는 전부 비중단형이다

현재 주요 API와 scheduler는 `delay()`로 그냥 sleep한다.

- IP API:
  - [features/ip/api.js#L516](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L516)
- 게시글 API:
  - [features/post/api.js#L422](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L422)
- 댓글 API:
  - [features/comment/api.js#L382](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L382)

그리고 403/429/backoff 구간도 길다.

- 댓글 403 30초:
  - [features/comment/api.js#L63](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L63)
- 개념글 방어 403 30초:
  - [features/concept-monitor/api.js#L39](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/api.js#L39)
- 반고닉 403 30초:
  - [features/semi-post/api.js#L34](/home/eorb915/projects/dc_defense_suite/features/semi-post/api.js#L34)

즉 broker가 "전환 시작"을 선언해도
이미 들어간 sleep은 즉시 깨지지 않는다.

그래서 1차 구현에서는 최소한:

- long retry/backoff fetch
- scheduler cycle/request delay

를 broker-aware abortable delay로 바꾸거나,
적어도 `LEASE_DRAIN_TIMEOUT_MS`를 넘기면 abort signal로 끊을 수 있게 해야 한다.


## 현재 삭제 한도 감지 지점

### 1. IP 차단은 이미 삭제 한도를 명시적으로 알고 있다

- API:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js)
- scheduler:
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js)

현재는:

1. `banPosts()`가 `deleteLimitExceeded`를 반환
2. `processBanCandidates()`가 이를 감지
3. `activateDeleteLimitBanOnly()`로 `runtimeDeleteEnabled = false`
4. 계속 `IP 차단만 유지`

즉 계정 fallback의 1차 트리거는 여기다.

### 2. monitor도 initial sweep 삭제에서 삭제 한도를 감지한다

- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)

현재는:

1. initial sweep `deletePosts()` 실패
2. delete-limit면 `pendingManagedIpBanOnlyPosts` 적재
3. `activateManagedIpBanOnly()` 호출

즉 monitor 공격 대응도 계정 fallback 트리거로 연결할 수 있다.

### 3. 게시글 삭제 API도 delete-limit flag는 이미 갖고 있다

- [features/post/api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js)

다만 현재 수동 게시글 분류 쪽에서 이것을 “계정 스위치”로 연결한 로직은 없다.

### 4. 댓글 API는 아직 delete-limit를 별도 failure type으로 분리하지 않는다

- [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js)

즉 1차 구현은:

- `IP`
- `monitor initial sweep / managed ip`

위주로 붙이고,
댓글은 나중에 확장하는 게 안전하다.


## 현재 로그인 자동화 레퍼런스

로그인 전환 부분은 별도 참조 스펙으로 분리한다.

- 레퍼런스 구현 문서:
  - [projects/dc_auto_bot/docs/login_automation.md](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/docs/login_automation.md)
- 메인 확장용 참조 스펙:
  - [dc_session_switch_login_reference_spec.md](/home/eorb915/projects/dc_defense_suite/docs/dc_session_switch_login_reference_spec.md)

핵심 요약:

1. 신문고봇에는 전용 세션 체크 탭, 로그인 DOM 자동화, 매니저 권한 확인이 이미 실제 코드로 있다
2. 메인 확장은 manifest 권한이 아직 부족해서 그대로는 못 붙인다
3. 로그인 자동화 자체보다 어려운 건 전역 세션 브로커와 run resume이다
4. 따라서 이 문서는 broker/fallback 본체를, 참조 스펙은 로그인 전환 구현 재사용 범위를 담당한다


## 구현 전 선행 조건

현재 메인 확장은 이 설계를 바로 구현할 권한이 부족하다.

현재 권한:

- `storage`
- `alarms`
- `cookies`
- host: `https://gall.dcinside.com/*`

즉 지금은:

- 전용 세션 탭 생성
- 로그인 페이지 DOM 주입
- 로그인 자동 제출
- 브라우저 notification 경고

를 바로 구현할 수 없다.

레퍼런스 쪽은 이미 아래 권한을 전제로 동작한다.

- `tabs`
- `scripting`
- `notifications`
- `https://sign.dcinside.com/*`

따라서 이 작업의 0단계는 아래 manifest 확장이다.

1. `tabs`
2. `scripting`
3. `notifications`
4. host permission에 `https://sign.dcinside.com/*`

이게 없으면 “전용 세션 탭에서 로그인 전환” 자체가 막힌다.


## 확정 정책

### 1. 계정 구성

계정은 최대 2개만 관리한다.

- `primaryAccount`
- `backupAccount`

각각 저장값:

- `username`
- `password`
- `enabled`

### 2. 활성 계정

확장 전체의 디시 세션은 항상 **활성 계정 1개**만 가진다.

- `activeAccount = 'primary' | 'backup'`

동시에 둘을 유지하지 않는다.

### 3. 기본 fallback 정책

1. 처음에는 `primary`
2. `primary`에서 삭제 한도 초과 -> `backup`으로 전환 시도
3. 전환 성공 후에는 그냥 `backup`으로 계속 운영
4. `backup`도 삭제 한도 초과 -> `primary`로 1회 전환 시도
5. 그런데 그 `primary` 복귀 직후 짧은 시간 안에 다시 삭제 한도 초과 -> 계정 전환 중단
6. 현재처럼 `IP 차단만 유지`로 내려감

즉 “주기적으로 본계로 복귀” 정책은 두지 않는다.

### 4. 전환 루프 방지 정책

아래 조건이면 계정 전환을 더 하지 않는다.

- 마지막 계정 전환 후 `DELETE_LIMIT_LOOP_GUARD_MS` 이내
- 다시 `delete_limit_exceeded` 발생

권장 초기값:

- `DELETE_LIMIT_LOOP_GUARD_MS = 10분`

즉:

- `primary -> backup`
- `backup -> primary`

까지는 허용하되,

- 짧은 시간 내 다시 `primary -> backup`

이 필요해지는 상황이면 루프로 보고 중단한다.

### 5. ban-only fallback 최종 보루 유지

계정 fallback이 실패하거나 루프 가드가 걸리면,
현재 구현된 `ban-only` 동작은 그대로 최종 보루로 남긴다.

즉 이번 작업은:

- `ban-only` 제거

가 아니라

- `ban-only` 전에 한 번 더 계정 fallback 기회를 주는 작업

이다.


## 권장 아키텍처

### 1. `dcSessionBroker` 신설

위치 권장:

- `background/dc-session-broker.js`

background가 이 broker를 들고 있고,
각 feature API는 broker lease를 통해서만 디시 요청을 보낸다.

#### broker 상태

- `activeAccountId`
- `switchInProgress`
- `switchTargetAccountId`
- `switchReason`
- `lastSwitchAt`
- `lastSwitchError`
- `lastDeleteLimitAccountId`
- `lastDeleteLimitAtByAccount`
- `switchWindowStartedAt`
- `switchCountInWindow`
- `sessionTabId`
- `activeLeaseCount`

#### broker 주요 메서드

- `acquireRequestLease(context)`
- `waitUntilReady()`
- `requestDeleteLimitFallback(context)`
- `switchToAccount(accountId, reason)`
- `ensureSessionTab()`
- `verifyActiveManagerSession(accountId)`
- `performLogin(accountId)`
- `canSwitchAfterDeleteLimit(context)`
- `markDeleteLimit(accountId, context)`
- `saveState()`
- `loadState()`
- `reconcileOnStartup()`

### 2. 공용 request lease + gate

현재 각 API가 직접:

- `fetch`
- `chrome.cookies.get`

를 호출한다.  
여기서 단순한 per-fetch gate만 두면 안 된다.

이유는 현재 API들이 공통으로:

1. `ci_c`를 읽어 `ci_t`를 잡고
2. 그 `ci_t`로
3. 분할 요청 / 재귀 fallback / chunk loop

를 계속 보내기 때문이다.

즉 계정 전환이:

- `ci_c` 읽기 후
- chunk POST 중간

에 끼면

- 쿠키는 계정 B
- `ci_t`는 계정 A

같은 혼종 요청이 생길 수 있다.

그래서 필요한 것은 per-fetch gate가 아니라, **요청 묶음 전체를 감싸는 high-level lease**다.

예:

```js
const lease = await dcSessionBroker.acquireRequestLease({
  feature: 'ip',
  kind: 'ban_posts',
});

try {
  const ciToken = await getCiToken();
  // chunk loop / retry / recursive fallback 포함 전체 수행
} finally {
  lease.release();
}
```

#### 적용 대상

최소한 메인 확장에서는 다음 API 모듈이 다 들어가야 한다.

- `features/comment/api.js`
- `features/post/api.js`
- `features/ip/api.js`
- `features/semi-post/api.js`
- `features/concept-monitor/api.js`
- `features/han-refresh-ip-ban/api.js`

참고:

- `projects/dc_auto_bot/*` 는 로그인 전환 참조 구현 범위이고,
  이번 1차 메인 확장 lease 적용 범위에는 넣지 않는다.

#### transport 요구사항

단순 gate만으로는 부족하다.

현재 일부 경로는:

- chunk loop
- 403/429 재시도 sleep
- 댓글 페이지 동시조회

를 오래 수행할 수 있다.

그래서 broker는 최소한 다음을 지원해야 한다.

1. **새 lease 획득 차단**
2. 이미 잡힌 lease 개수 추적
3. 1차 구현에서는 drain timeout까지 대기하고, timeout이면 switch 실패 처리
4. 추후 확장에서 오래 걸리는 요청 중단을 위한 `AbortController` 전달

즉 정확한 방향은:

- `stop()` 재사용 X
- `gate-only` X
- **high-level lease + drain timeout** O
- **cooperative pause + abort 가능한 transport** 추후 확장

이다.

### 3. 전용 세션 탭 재사용

단일 계정 로그인 자동화와 마찬가지로,
사용자 탭을 건드리지 않고 전용 탭에서만 계정 전환을 수행한다.

정책:

- 탭은 1개만 유지
- `active: false`
- 가능하면 pinned
- URL은 특갤 목록 또는 로그인 페이지
- 계정 전환이 필요할 때만 사용

성공 판정:

- 특갤 페이지 새로고침 후 `btn_useradmin_go` 존재

### 4. feature별 pause 방식

이번 작업에서 public `stop()` 재사용은 권장하지 않는다.

이유:

- 댓글/게시글/IP 모두 stop 시 진행 상태를 크게 지움
- 공격 중 child ownership도 꼬일 수 있음

따라서 권장 방식은 **cooperative pause**다.

정확히는:

1. scheduler public 상태는 유지
2. 새 request lease 획득은 막음
3. 이미 실행 중인 긴 요청은 abort 가능해야 함
4. 세션 전환 후 같은 run loop가 이어서 다음 요청을 수행

즉:

- `stop()` X
- `gate-only` X
- `cooperative pause + request lease + abort` O

이다.

### 5. 세션 전환 중간상태 저장/복원

현재 background 복원은:

- service worker install
- activate
- startup
- keepAlive

때 scheduler의 `isRunning`/phase만 보고 child를 다시 붙인다.

즉 broker가 아래 상태를 저장/복원하지 않으면,

- 세션 전환 중 재시작
- 세션 탭이 닫힘
- switch 도중 keepAlive 복원

에서 상태가 쉽게 꼬인다.

#### broker persisted state 권장

- `activeAccountId`
- `switchInProgress`
- `switchTargetAccountId`
- `switchReason`
- `switchStartedAt`
- `lastSwitchAt`
- `lastDeleteLimitAtByAccount`
- `banOnlyFallbackActive`
- `sessionTabId`
- `loginRetryCount`
- `cooldownUntil`

#### 재시작 복원 정책

1. startup/keepAlive에서 broker state 먼저 복원
2. `switchInProgress === true`면 진행 중 전환 잔재를 reconcile
3. 1차 구현은 `switchTargetAccountId`를 성공으로 간주하지 않고,
   마지막 확정 `activeAccountId`를 유지한 채 전환 실패로 정리
4. 그 다음 scheduler resume/child reattach 수행

즉 broker 복원이 scheduler 복원보다 먼저 와야 안전하다.


## detect 와 ban-only commit 분리

이건 구현 순서상 매우 중요하다.

현재는 IP 쪽이 delete-limit를 감지하면 거의 즉시 `ban-only` 상태를 굳힌다.

계정 fallback을 넣으려면 아래 2단계로 쪼개야 한다.

1. `delete-limit detected`
2. `ban-only committed`

권장 변경:

- `ip/api`와 `ip/scheduler`는 먼저 `delete-limit detected`만 상위로 올림
- broker fallback 시도
- 실패한 경우에만 `ban-only committed`

monitor도 동일하다.

즉 구조상 순서는:

1. detect
2. broker attempt
3. success면 retry
4. fail이면 ban-only commit

이어야 한다.


## 실제 fallback 플로우

### A. IP 수동/자동 공통 1차 플로우

1. `ipScheduler.processBanCandidates()`가 `banPosts()` 호출
2. 결과에 `deleteLimitExceeded === true`
3. **기존처럼 바로 `activateDeleteLimitBanOnly()`를 commit하지 말고**
4. 먼저 `dcSessionBroker.requestDeleteLimitFallback({ feature: 'ip', source, failedNos, message })`
5. broker가 전환 가능하면:
   - `switchInProgress=true`
   - 새 lease block
   - in-flight lease drain or abort
   - 전용 세션 탭에서 target account 로그인
   - 관리자 권한 확인
   - 성공 시 lease gate release
   - 방금 실패한 chunk를 동일 함수 안에서 1회 재시도
6. 재시도 성공이면 계속 진행
7. 전환 실패 또는 루프 가드 hit면
   - 기존 `activateDeleteLimitBanOnly()` 실행

### B. monitor initial sweep 플로우

1. `performInitialSweep()`에서 `performDeleteOnce()` 실패
2. delete-limit 감지
3. broker fallback 요청
4. 전환 성공 시 initial sweep delete chunk 1회 재시도
5. 그래도 실패하면 현재 로직처럼 `pendingManagedIpBanOnlyPosts` 적재 + ban-only

### C. monitor가 이미 소유한 ip child 플로우

1. ip child가 ATTACKING 중 delete-limit 감지
2. broker fallback 요청
3. 성공하면 ip child는 새 세션으로 계속 진행
4. 실패하면 현재처럼 `managedIpDeleteEnabled = false`

### D. 댓글 경로는 1차에서 트리거 제외

중요:

- 댓글 방어도 실제로는 `delete+ban`을 쓰고 같은 계열 API를 때리지만
- 현재 API 결과가 delete-limit를 typed signal로 올려주지 않는다

즉 1차 구현에서 댓글은:

- 세션 스위치의 영향을 받는 **소비자**
- 하지만 delete-limit fallback의 **트리거 생산자**는 아님

으로 두는 게 안전하다.

2차에서 `features/comment/api.js`에 delete-limit failure type을 추가한 뒤 확장한다.


## 왜 “같은 창에서 이어지게” 가능한가

가능한 이유는 세션 전환 자체가 background 레벨에서 일어나고,
자동화는 popup 탭이 아니라 service worker scheduler가 돌기 때문이다.

즉 사용자 입장에서는:

- popup 토글은 계속 ON
- 로그만 조금 뜸
- 전용 세션 탭에서 로그인 전환
- 이후 자동화가 그대로 이어짐

처럼 보이게 만들 수 있다.

다만 내부적으로는:

- 쿠키 세션 전체가 갈아끼워짐

이므로, **정확히는 “전체 자동화가 같은 새 계정으로 이어지는 것”**이다.


## 구현 단계 권장 순서

### 0단계: manifest / 로그인 인프라 선행

- `tabs`
- `scripting`
- `notifications`
- `https://sign.dcinside.com/*`

추가

그리고 단일 계정용 전용 세션 탭/로그인 DOM 자동화를 먼저 메인 확장으로 포팅한다.

### 1단계: detect 와 ban-only commit 분리

- `features/ip/scheduler.js`
- `features/monitor/scheduler.js`

에서 delete-limit 감지와 ban-only 확정 로직을 분리한다.

이 단계가 먼저 되어야 broker 시도 후 fallback이 가능하다.

### 2단계: broker 뼈대

- `background/dc-session-broker.js`
- 계정 2개 저장
- 전용 세션 탭 생성/유지
- 로그인/권한 확인

### 3단계: high-level request lease + abort

- 모든 DC API에 lease 삽입
- `ci_t` 획득부터 chunk loop 전체를 한 lease로 감싸기
- in-flight 카운터 추적
- `AbortController` 전달 구조 추가

### 4단계: broker persistence / resume

- broker state 저장/복원
- switch 중 service worker 재시작 복구
- session tab 제거/복구 처리
- scheduler resume보다 broker reconcile 먼저 수행

### 5단계: IP delete-limit fallback

- `features/ip/scheduler.js`에서 broker 호출
- 전환 성공 시 실패 chunk 재시도
- 실패 시 기존 ban-only

### 6단계: monitor initial sweep / managed ip 연동

- `features/monitor/scheduler.js`에 broker fallback 연결
- 현재 `managedIpDeleteEnabled`와 충돌 없이 유지

### 7단계: 상태/UI

- 현재 active account
- fallback 진행 중 여부
- 최근 delete-limit 감지 계정
- ban-only fallback 여부

정도는 popup이나 로그에 노출

### 8단계: 댓글 delete-limit typed signal 확장

이건 1차 필수는 아니다.

- `features/comment/api.js`에 delete-limit failure type 추가
- 이후 댓글 방어도 delete-limit trigger producer로 승격

즉 2차 확장으로 둔다.


## 테스트 플랜

### 정적 검증

1. manifest 권한 추가 후 로그인 탭 생성 가능
2. 모든 API가 high-level lease를 타는지
3. `ci_c` 읽기부터 후속 chunk loop까지 같은 lease인지
4. `primary -> backup` 전환 성공 시 `activeAccount` 변경
5. `backup -> primary` 1회 복귀 허용
6. 짧은 시간 내 3번째 전환 시 ban-only 강등
7. 전환 실패 시 기존 계정 유지 + ban-only
8. monitor ATTACKING 복원 중에도 broker 상태 복원
9. service worker 재시작 후 `switchInProgress` 복구 정책
10. child scheduler ownership과 source가 보존되는지
11. delete-limit detect와 ban-only commit이 분리되어 있는지
12. comment 경로는 1차에서 trigger producer가 아님을 확인

### E2E 시나리오

1. 본계 삭제 한도 초과
2. 부계 로그인 전환
3. 같은 자동화 이어서 동작
4. 부계도 삭제 한도 초과
5. 본계 1회 복귀
6. 짧은 시간 내 다시 limit
7. `ban-only`로 안전 강등

### 특히 먼저 봐야 할 레이스 테스트

1. mixed-token race
   - `ci_c` 읽은 뒤 세션 전환이 끼어드는 경우
2. worker restart mid-switch
3. monitor-owned ip child fallback
4. session-check tab removal
5. 댓글 고동시성 drain
6. 403 retry sleep 중 session switch
7. login 성공 직후 manager button verification 실패


## 최종 판단

이 작업은 꽤 크다.

하지만 실제 코드 기준으로는 방향이 분명하다.

- 현재 삭제 한도 감지 포인트가 이미 있음
- background 전역 registry가 이미 있음
- 단일 계정 로그인 자동화 레퍼런스도 있음

즉 필요한 것은:

- **전역 세션 브로커**
- **공용 high-level request lease**
- **abort 가능한 transport**
- **IP/monitor delete-limit fallback 연결**

이 4개다.

핵심 설계 판단을 한 줄로 정리하면 이렇다.

- **같은 창에서 이어지게 하려면, 각 자동화를 개별 계정으로 분리하는 게 아니라, 확장 전체의 디시 세션을 전역으로 갈아끼우는 broker 구조로 가야 한다.**
- 그리고 구현 순서는 반드시
  - `권한/로그인 인프라`
  - `detect/ban-only 분리`
  - `request lease + abort`
  - `broker 복원`
  - `IP -> monitor fallback`
  순으로 가야 한다.
