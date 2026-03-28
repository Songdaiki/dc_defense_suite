# 신문고봇 로그인 자동화 의존성 제거 플랜

## 목적

특궁 메인 확장의 `dcSessionBroker`가 디시 세션 유지와 계정1/계정2 전환을 전담하게 되면,
신문고봇은 더 이상 자체 로그인 자동화 주체로 남아 있으면 안 된다.

이 문서는 신문고봇 쪽에서 제거/축소해야 할 로그인 자동화 의존성을 정리한다.

참조:

- 메인 이전 플랜:
  - [dc_session_broker_login_keepalive_plan.md](../../../docs/dc_session_broker_login_keepalive_plan.md)
- 기존 신문고봇 로그인 자동화:
  - [login_automation.md](./login_automation.md)


## 현재 실제 의존성

### 1. 설정/상태 의존성

신문고봇은 현재 아래 설정을 자기 config에 저장한다.

- `loginAutomationEnabled`
- `dcLoginUserId`
- `dcLoginPassword`

기준:

- [background.js#L207](../background/background.js#L207)
- [background.js#L289](../background/background.js#L289)
- [popup.html#L128](../popup/popup.html#L128)
- [popup.js#L468](../popup/popup.js#L468)


### 2. 런타임 자동화 의존성

신문고봇은 현재:

- 30초 alarm
- 전용 세션 체크 탭
- 자동 로그인 retry/cooldown
- 실행 직전 세션 보장
- 접근 실패 후 세션 복구

를 전부 자체 background가 수행한다.

기준:

- [background.js#L78](../background/background.js#L78)
- [background.js#L1241](../background/background.js#L1241)
- [background.js#L1417](../background/background.js#L1417)
- [background.js#L1437](../background/background.js#L1437)


### 3. scheduler 실행 경로 의존성

신문고봇 scheduler는 실제 삭제/차단 직전에 로그인 보장을 기대한다.

- [scheduler.js#L503](../background/scheduler.js#L503)
- [scheduler.js#L635](../background/scheduler.js#L635)
- [scheduler.js#L703](../background/scheduler.js#L703)
- [scheduler.js#L765](../background/scheduler.js#L765)


## 목표 상태

신문고봇은:

1. 로그인 자동화 주체가 아니다
2. 계정 정보를 직접 저장하지 않는다
3. 실행 직전 로그인 보장을 직접 시도하지 않는다
4. 접근 실패 시 자동 로그인 복구도 직접 시도하지 않는다
5. 같은 브라우저 프로필의 공유 쿠키 세션을 그대로 사용한다

즉 세션 유지 책임은 특궁 `dcSessionBroker`가 가진다.


## 제거/변경 대상

### 제거 대상

1. `loginAutomationEnabled`
2. `dcLoginUserId`
3. `dcLoginPassword`
4. `loginAutomationState`
5. `LOGIN_CHECK_ALARM_NAME`
6. `ensureSessionCheckTab()`
7. `refreshLoginHealth()`
8. `attemptAutoLogin()`
9. `ensureLoginSessionBeforeAction()`
10. `recoverLoginSessionAfterAccessFailure()`


### 유지 가능한 것

1. `manager_permission_denied`
2. `session_access_denied`
3. `ci_token_missing`

같은 failure type 분류 자체는 유지 가능하다.

이유:

- 세션이 깨졌는지 로그/통계에는 여전히 의미가 있기 때문이다

단, 이 failure를 만났을 때 **신문고봇이 다시 로그인하려고 하면 안 된다.**


## 권장 변경 플로우

### 1. 1차

- 신문고봇의 로그인 자동화 UI를 “특궁 broker 사용 예정” 상태로 유지
- 내부 자동 로그인 실행만 feature flag로 비활성화
- 삭제/차단 전 세션 보장 호출을 no-op로 바꿈
- 접근 실패 복구도 no-op로 바꿈
- startup/reconcile 시 **기존 저장된 `loginAutomationEnabled=true` 값도 강제로 비활성화**하거나 무시한다

중요:

- 단순히 함수 본문만 지우면 부족하다
- 현재 background는 startup 시점에
  - `scheduler.ensureLoginSession = ...`
  - `scheduler.recoverLoginSession = ...`
  - `scheduler.handleLoginAccessFailure = ...`
  를 직접 주입한다
- 따라서 1차에서는 이 **주입 자체를 제거하거나 no-op 함수 주입**으로 바꿔야 한다

기준:

- [projects/dc_auto_bot/background/background.js#L55](../background/background.js#L55)


### 2. 2차

- popup에서 `디시 아이디`, `디시 비밀번호`, `로그인 세션 자동화` 제거
- background의 login automation runtime 제거
- 관련 문서 정리


## 숨은 이슈

### 1. broker 상태를 모르면 전환 중 짧은 race가 남는다

특궁 broker가 로그아웃 -> 로그인 전환 중일 때
신문고봇 액션이 정확히 그 순간 실행되면 1회 실패할 수 있다.

하지만 1차 정책은 **broker 상태 조회 없이 간다**로 고정한다.

- 특궁 메인 확장은 `onMessageExternal` 같은 cross-extension bridge를 만들지 않는다
- 신문고봇은 `switchInProgress`, `loginHealth`를 조회하지 않는다
- 신문고봇은 세션을 다시 덮어쓰지만 않으면 된다
- 전환 중 짧은 순간 1회 실패 가능성은 운영상 허용한다

즉 1차 핵심은:

- 세션 주도권 충돌 제거

이고,

- broker 상태 외부 노출
- 전환 중 선대기

는 후속 보강안이다


### 2. 같은 브라우저 프로필 전제가 깨지면 안 된다

이 구조는 두 확장이 **같은 크롬 프로필**을 공유한다는 전제 위에 서 있다.

프로필이 다르면 쿠키가 분리되어 broker 의미가 없다.


### 3. 저장된 legacy 설정/알람/탭을 같이 정리해야 한다

신문고봇은 현재 login automation을 다음 여러 층위에 나눠 들고 있다.

1. `scheduler.config.loginAutomationEnabled`
2. `scheduler.config.dcLoginUserId/dcLoginPassword`
3. `loginAutomationState`
4. `LOGIN_CHECK_ALARM_NAME`
5. `sessionCheckTabId`

즉 1차에서 단순히:

- pre-action ensure를 no-op로 바꾸는 것만으로는 부족하다

아래도 같이 정리해야 한다.

- startup 시 `reconcileLoginAutomation()`가 더 이상 자동 로그인 루틴을 되살리지 않게 할 것
- 기존 `loginSessionCheck` alarm을 clear 할 것
- 기존 세션 체크 탭을 닫거나 broker ownership 바깥으로 남지 않게 할 것
- 저장돼 있던 `loginAutomationEnabled=true`가 있어도 다음 재시작부터는 자동으로 꺼진 상태가 되게 할 것

이 migration이 빠지면:

- UI상으론 껐는데 background는 계속 alarm을 돌리거나
- 이전 session check tab이 남아 login 관련 DOM 자동화를 계속 시도하는

반쪽 제거 상태가 생길 수 있다.


### 4. popup/status 계약도 1차와 2차를 나눠 봐야 한다

신문고봇 popup은 현재:

- `loginAutomationToggle`
- `saveLoginAutomationBtn`
- `dcLoginUserIdInput`
- `dcLoginPasswordInput`
- `status.login.*`

에 직접 묶여 있다.

- [projects/dc_auto_bot/popup/popup.js#L3](../popup/popup.js#L3)
- [projects/dc_auto_bot/background/background.js#L207](../background/background.js#L207)

따라서 1차에서는:

- UI를 남기더라도 **읽기 전용 안내 상태**로 바꾸거나
- `updateLoginAutomation`을 no-op/거절 응답으로 바꿔
- 더 이상 실제 config를 흔들지 않게 해야 한다

그렇지 않으면:

- 사용자가 예전 토글을 다시 켜서
- 제거 예정인 login automation 상태를 다시 저장하거나
- popup/status와 background 실제 동작이 어긋날 수 있다

즉:

- 1차: UI 유지 가능, 하지만 동작은 막아야 함
- 2차: UI 자체 제거

로 나누는 것이 안전하다.


### 5. `updateConfig` / `start` 경로도 같이 끊어야 한다

신문고봇 login automation은 전용 action만으로 켜지는 게 아니다.

- popup 토글 change 시 `updateLoginAutomation`
- 저장 버튼 클릭 시 `updateLoginAutomation`
- 일반 `updateConfig`
- `startAutomation()` 내부의 선행 `refreshLoginHealth(...)`

까지 실제 실행 경로에 걸려 있다.

기준:

- [projects/dc_auto_bot/popup/popup.js#L69](../popup/popup.js#L69)
- [projects/dc_auto_bot/popup/popup.js#L120](../popup/popup.js#L120)
- [projects/dc_auto_bot/background/background.js#L337](../background/background.js#L337)
- [projects/dc_auto_bot/background/background.js#L364](../background/background.js#L364)

즉 1차 제거 시에는 아래가 같이 필요하다.

1. `updateLoginAutomation`이 더 이상 runtime을 바꾸지 않게 할 것
2. `updateConfig`가 login 관련 필드를 저장/복원 대상으로 취급하지 않게 할 것
3. `startAutomation()`이 login health를 선행 호출하지 않게 할 것

이 셋 중 하나라도 남아 있으면,

- UI에서 켜지지 않는 것처럼 보여도
- 실행 시작 시점에 login automation이 다시 살아날 수 있다


## 구현 전에 확정할 정책

1. 신문고봇이 특궁 broker 상태를 직접 조회할지
   - 1차: `조회 안 함`
2. 조회 방식
   - 1차: `없음`
3. broker 전환 중 신문고봇 액션 대기 시간
   - 1차: `별도 대기 없음`
4. broker unavailable이면 어떻게 할지
   - 1차: `해당 없음`
