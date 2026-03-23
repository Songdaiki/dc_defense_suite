# 디시 세션 Broker 로그인 유지 이전 플랜

## 목적

`삭제 한도 계정 fallback`을 실제 운영에 안전하게 쓰려면,
**세션 유지 자동화의 주도권도 특궁 메인 확장의 `dcSessionBroker` 하나로 통합**해야 한다.

이 문서는 다음 질문에 답하기 위한 플랜 문서다.

1. 왜 신문고봇의 기존 로그인 세션 자동화와 특궁 broker가 충돌할 수 있는가
2. 세션 유지 자동화를 특궁 broker로 옮기려면 실제로 무엇을 바꿔야 하는가
3. 신문고봇 쪽에서는 어떤 의존성을 제거해야 하는가
4. 두 프로젝트가 동시에 켜져 있을 때 어떤 레이스를 막아야 하는가


## 결론 먼저

지금 구조에서는 **신문고봇의 30초 로그인 자동화와 특궁 broker 계정 전환이 동시에 세션 주도권을 잡으려 하기 때문에 구조적으로 충돌 가능성이 있다.**

핵심 이유:

- 특궁 broker는 `계정1/계정2` 중 **현재 활성 계정**을 기준으로 세션을 관리하려고 한다
- 신문고봇은 여전히 **자기 설정의 단일 계정**으로 30초마다 상태를 보고, 필요하면 자동 로그인한다

그래서 운영 기준으로 맞는 구조는:

1. **특궁 메인 확장**
   - `dcSessionBroker`가 로그인 유지 자동화까지 맡는다
   - 활성 계정(`계정1/계정2`)을 알고 있고
   - 세션이 풀리면 **현재 활성 계정으로 다시 로그인**한다
   - 삭제 한도에서만 계정 전환을 수행한다
2. **신문고봇**
   - 더 이상 세션 유지/자동 로그인 주체가 아니다
   - 공유 쿠키 세션을 그대로 사용만 한다
   - 1차는 특궁 broker 상태를 직접 조회하지 않는다


## 현재 실제 충돌 지점

### 1. 신문고봇은 자체 로그인 자동화를 계속 돌린다

- 30초 alarm:
  - [projects/dc_auto_bot/background/background.js#L78](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L78)
- 전용 세션 체크 탭:
  - [projects/dc_auto_bot/background/background.js#L998](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L998)
- 주기 상태 확인/자동 로그인:
  - [projects/dc_auto_bot/background/background.js#L1241](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1241)
- 실행 직전 세션 재검사:
  - [projects/dc_auto_bot/background/background.js#L1417](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1417)
- 실행 실패 후 세션 복구:
  - [projects/dc_auto_bot/background/background.js#L1437](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1437)

즉 신문고봇은 여전히:

- 세션이 풀렸는지 검사하고
- 풀렸으면
- 자기 저장 계정으로
- 다시 로그인하려고 한다


### 2. 신문고봇은 단일 계정만 안다

신문고봇 설정은 현재:

- `loginAutomationEnabled`
- `dcLoginUserId`
- `dcLoginPassword`

에 묶여 있다.

- 상태/설정 노출:
  - [projects/dc_auto_bot/background/background.js#L207](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L207)
- 설정 저장:
  - [projects/dc_auto_bot/background/background.js#L289](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L289)
- popup 입력:
  - [projects/dc_auto_bot/popup/popup.html#L128](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/popup/popup.html#L128)
  - [projects/dc_auto_bot/popup/popup.js#L468](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/popup/popup.js#L468)

즉 특궁 broker가 계정2로 전환해도,
신문고봇이 나중에 `logged_out`를 보면 다시 **자기 단일 계정**으로 로그인할 수 있다.


### 3. 특궁 broker는 계정 전환 시 실제 로그아웃 -> 로그인 순서를 탄다

- 실제 전환:
  - [background/dc-session-broker.js#L598](/home/eorb915/projects/dc_defense_suite/background/dc-session-broker.js#L598)
- 로그아웃 이동:
  - [background/dc-session-broker.js#L614](/home/eorb915/projects/dc_defense_suite/background/dc-session-broker.js#L614)
- 로그인 페이지 이동:
  - [background/dc-session-broker.js#L615](/home/eorb915/projects/dc_defense_suite/background/dc-session-broker.js#L615)

즉 전환 중 짧은 로그아웃 구간이 있고,
그 순간 신문고봇 30초 체크나 실행 직전 재검사가 끼어들면
서로 다른 자동 로그인 시도가 동시에 일어날 수 있다.


## 목표 구조

### 특궁 메인 확장이 가져갈 것

`background/dc-session-broker.js`가 다음을 전부 소유한다.

1. 계정1/계정2 credential 저장
2. 현재 활성 계정 상태
3. 전용 세션 체크 탭
4. 30초 주기 로그인 상태 확인
5. 로그아웃 시 현재 활성 계정으로 자동 로그인
6. 삭제 한도 시 계정1 <-> 계정2 전환
7. loop guard / lease drain / switchInProgress


### 신문고봇이 버릴 것

신문고봇은 더 이상 아래를 직접 소유하지 않는다.

1. `loginAutomationEnabled`
2. `dcLoginUserId`
3. `dcLoginPassword`
4. `loginAutomationState`
5. 자체 전용 세션 체크 탭
6. `ensureLoginSessionBeforeAction()`
7. `recoverLoginSessionAfterAccessFailure()`

즉 **신문고봇은 세션 유지 자동화 dependency를 제거하고 공유 쿠키 세션을 사용만** 한다.


## 특궁 broker 로그인 유지 플로우

### 평시 로그인 유지

1. 30초마다 broker 전용 alarm 실행
2. 전용 세션 체크 탭 refresh
3. 특갤 페이지 DOM 검사
4. `btn_useradmin_go` 있으면 healthy
5. `logged_out`면 **현재 활성 계정** credential로 자동 로그인
6. 성공하면 healthy 복귀
7. 실패하면 `login_unhealthy` 상태와 경고만 유지

중요:

- 여기서는 **계정 전환을 하지 않는다**
- 단지 현재 활성 계정을 유지 복구한다


### 삭제 한도 발생 시

1. IP scheduler가 delete-limit 감지
2. broker가 `switchInProgress=true`
3. 새 lease 차단
4. drain timeout까지 대기
5. 계정1 -> 계정2 또는 계정2 -> 계정1 전환
6. 성공하면 `activeAccountId` 갱신
7. 같은 run 계속
8. 그 뒤 30초 세션 유지 자동화는 **새 활성 계정 기준으로 계속** 돈다


## 신문고봇 변경 플로우

### 1. 실행 직전 세션 보장 의존성 제거

현재:

- [projects/dc_auto_bot/background/scheduler.js#L703](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/scheduler.js#L703)

신문고봇은 실제 삭제/차단 직전에:

- `ensureLoginSessionForAction()`
- `ensureLoginSessionBeforeAction()`

를 타고 있다.

이 의존성은 제거하거나 no-op로 바꿔야 한다.

이유:

- 세션 보장은 이제 특궁 broker의 책임이기 때문이다
- 신문고봇이 별도 로그인 회복을 시도하면 다시 세션 주도권 충돌이 난다


### 2. 접근 실패 후 세션 복구 의존성 제거

현재:

- [projects/dc_auto_bot/background/scheduler.js#L765](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/scheduler.js#L765)

신문고봇은 `manager_permission_denied`, `session_access_denied`, `ci_token_missing`류 실패를 만나면
자체 로그인 세션 복구를 시도한다.

이것도 제거해야 한다.

대신:

- 실패는 그대로 기록
- 필요하면 “특궁 세션 브로커 상태 확인 필요” 메시지를 남기게 한다


## 숨은 이슈

### 1. 브라우저 프로필은 같아도 확장은 서로 다른 runtime이다

특궁 broker와 신문고봇은 **다른 확장 프로젝트**라서

- 쿠키는 공유하지만
- `chrome.storage.local`은 공유하지 않는다
- runtime 상태도 공유하지 않는다

즉 신문고봇이 특궁 broker의 `switchInProgress`를 알고 싶으면
그냥 import로는 안 되고 **별도 브리지**가 필요하다.


### 2. cross-extension bridge가 없으면 짧은 race가 남는다

신문고봇 로그인 자동화를 제거해도,
특궁 broker가 로그아웃 -> 로그인 전환 중일 때
신문고봇 액션이 정확히 그 타이밍에 걸리면 1회 실패할 수 있다.

1차 정책은 여기서 **단순안으로 고정**한다.

- 특궁 메인 확장은 external bridge를 만들지 않는다
- 신문고봇은 broker 상태를 조회하지 않는다
- 아주 짧은 전환 창구간 충돌은 **1회 실패 가능성으로 허용**한다

즉 1차 목표는:

- 세션 주도권 충돌 제거
- 현재 활성 계정 기준 로그인 유지

이고,

- `onMessageExternal`
- `switchInProgress` 외부 조회
- 전환 중 액션 선대기

는 후속 보강안이다.


### 3. broker 로그인 유지와 계정 전환은 같은 session tab / 같은 singleflight를 써야 한다

특궁 broker에 로그인 유지 자동화를 넣으면,
아래 3개가 모두 **같은 전용 session tab**을 건드리게 된다.

1. 30초 주기 health-check
2. `계정 전환 테스트`
3. delete-limit 계정 전환

따라서:

- `pendingSwitchPromise`
- `pendingHealthCheckPromise`

를 따로 두더라도 결국은 **하나의 session automation lock**으로 직렬화해야 한다.

그렇지 않으면:

- health-check가 탭을 새로고침하는 순간
- manual test 또는 delete-limit switch가 logout/login DOM 조작을 시작하고
- 같은 탭에서 서로 다른 navigation / script 실행이 꼬일 수 있다

즉 1차 구현 시 broker는:

- session tab 1개
- session automation singleflight 1개

를 전제로 잡는 것이 맞다.

추가로,

- `switchInProgress`

만으로는 부족하다.

로그인 유지 health-check가 도는 중에도:

- 계정 저장
- `계정 전환 테스트`
- delete-limit 전환 시작

이 서로 동시에 들어오면 session tab이 꼬일 수 있다.

따라서 broker status에는 최소한 아래 둘을 분리하는 것이 안전하다.

1. `switchInProgress`
2. `sessionAutomationInProgress`

그리고 popup / background action 차단도
`switchInProgress`만이 아니라 **session automation 전체 busy 상태**를 기준으로 보게 해야 한다.


### 4. 메인 background의 alarm 훅과 합쳐야 한다

메인 확장은 이미:

- `keepAlive` alarm 생성
- `chrome.alarms.onAlarm` listener

를 background에서 사용 중이다.

- [background/background.js#L64](/home/eorb915/projects/dc_defense_suite/background/background.js#L64)
- [background/background.js#L66](/home/eorb915/projects/dc_defense_suite/background/background.js#L66)

즉 broker health-check용 30초 alarm을 넣을 때는:

- alarm 이름 충돌이 나지 않게 분리하고
- listener도 기존 background 훅 안에서 같이 분기하거나
- 최소한 동일 파일에서 lifecycle을 같이 관리해야 한다

안 그러면:

- broker alarm은 생성되는데 restore 경로에서 다시 안 붙거나
- disable 시 clear가 누락되거나
- service worker 재시작 후 keepAlive만 살아 있고 login health alarm은 죽는

반쪽 상태가 생길 수 있다.


### 5. session check 탭 제거 복구도 broker ownership으로 같이 옮겨야 한다

신문고봇 레퍼런스는 단순히 탭을 만드는 것뿐 아니라,

- `tabs.onRemoved` 감지
- sessionCheckTabId 초기화
- 필요 시 탭 재생성

까지 같이 들어 있다.

- [projects/dc_auto_bot/background/background.js#L93](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L93)

특궁 broker도 로그인 유지 자동화를 소유하게 되면
이 복구 훅까지 같이 가져가야 한다.

그렇지 않으면:

- 사용자가 전용 탭을 닫았을 때
- 다음 health-check가 죽은 tab id만 계속 바라보거나
- delete-limit 전환 직전 session tab 재생성이 늦어져 timeout이 날 수 있다


### 6. popup 상태 계약도 keepalive 이전과 함께 바뀌어야 한다

현재 특궁 popup의 fallback UI는:

- 계정 저장
- `계정 전환 테스트`
- 활성 계정 / 전환 상태 / 최근 delete-limit 계정

까지만 본다.

- [popup/popup.html#L850](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L850)
- [popup/popup.js#L341](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L341)

broker keepalive를 넣으면 여기에 최소한:

- 로그인 유지 ON/OFF
- login health 상태
- session automation busy 상태

가 추가로 필요하다.

특히 현재는 버튼 disable 기준이 사실상 `switchInProgress` 중심인데,
keepalive 이후에는:

- health-check 진행 중
- session tab 재생성 중
- auto relogin 진행 중

에도 같은 버튼을 잠가야 안전하다.


### 3. 신문고봇 UI 의미도 바뀐다

기존:

- `로그인 세션 자동화`
- `디시 아이디`
- `디시 비밀번호`

는 신문고봇 자체 기능이었다.

이전 후에는:

- 해당 UI를 제거하거나
- “특궁 세션 브로커가 관리 중” 표시로 바꿔야 한다


## 권장 구현 순서

1. 특궁 broker에 30초 로그인 유지 자동화 추가
2. 특궁 popup에 `로그인 세션 자동화` 토글과 health 상태 추가
3. 신문고봇 로그인 자동화 코드를 feature flag로 끄고, 동일 브라우저 쿠키만 사용하도록 정리
4. 필요하면 이후 단계에서 cross-extension broker status bridge 추가
5. 마지막에 신문고봇 UI/설정/문서에서 로그인 자동화 dependency 제거


## 구현 전에 확정할 정책

1. 특궁 broker의 로그인 유지 기본 ON/OFF
   - 권장: `ON`
2. health check interval
   - 권장: `30초`
3. logged_out 시 자동 로그인 재시도 횟수
   - 권장: 신문고봇과 동일한 `3회`
4. retry / cooldown
   - 권장: 신문고봇 레퍼런스 유지
5. 신문고봇과 broker 상태 브리지 도입 여부
   - 1차: `미도입`
   - 후속: 필요 시 `도입`
6. 신문고봇 UI에서 로그인 항목을 완전 제거할지, “특궁 broker 사용 중”으로 남길지
   - 권장: 1차는 안내 문구 유지, 2차에 제거
