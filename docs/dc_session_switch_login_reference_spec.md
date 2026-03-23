# 디시 세션 전환 로그인 레퍼런스 스펙

## 목적

삭제 한도 계정 fallback 작업에서 필요한 "로그인 전환" 부분만 따로 떼어,
이미 구현된 신문고봇 로그인 자동화 코드를 기준으로 재사용 범위를 정의한다.

이 문서는 다음 질문에 답하기 위한 참조 스펙이다.

1. 신문고봇 쪽에 실제 로그인 자동화 구현이 있는가
2. 메인 확장에서 그대로 가져다 쓸 수 있는 부분은 무엇인가
3. 메인 확장에서 추가로 필요한 권한/설정/UI는 무엇인가
4. 본계정/부계정 전환용으로 일반화할 때 어디를 바꿔야 하는가


## 결론 먼저

신문고봇 쪽은 문서만 있는 게 아니라, **전용 탭 생성 + 로그인 DOM 자동 입력 + 관리자 권한 확인 + 재시도/쿨다운**까지 실제 코드가 이미 있다.

즉 메인 확장에서 새로 만들어야 하는 것은:

- 로그인 자동화 그 자체

가 아니라,

- 메인 확장 manifest 권한 확장
- 본계정/부계정 설정 UI
- 단일 계정 로그인 자동화를 2계정 전환 브로커로 일반화
- 현재 자동화들과 충돌하지 않게 전역 세션 스위치에 붙이기

추가로 중요한 점:

- 신문고봇의 30초 로그인 세션 유지 자동화도 레퍼런스로 재사용 가능하지만,
- ownership은 신문고봇에 남기지 말고 **메인 확장 `dcSessionBroker`로 이전**하는 것이 맞다
- 자세한 이전 계획은 아래 문서를 따른다
  - [dc_session_broker_login_keepalive_plan.md](/home/eorb915/projects/dc_defense_suite/docs/dc_session_broker_login_keepalive_plan.md)

이다.


## 실제 구현이 있는 레퍼런스

### 1. manifest 권한

신문고봇은 이미 로그인 자동화를 위해 아래 권한을 갖고 있다.

- [projects/dc_auto_bot/manifest.json](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/manifest.json)

핵심 권한:

- `tabs`
- `scripting`
- `notifications`
- host permission `https://sign.dcinside.com/*`

반면 메인 확장은 아직 아래 수준이다.

- [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json)

즉 메인 확장에서 로그인 전환을 구현하려면 먼저 이 권한 차이를 메워야 한다.


### 2. 전용 세션 체크 탭

신문고봇은 전용 탭 1개를 유지한다.

- 세션 체크 탭 생성/재사용:
  - [projects/dc_auto_bot/background/background.js#L996](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L996)
- 탭 로딩 완료 대기:
  - [projects/dc_auto_bot/background/background.js#L1033](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1033)
- 탭 새로고침/이동:
  - [projects/dc_auto_bot/background/background.js#L1059](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1059)
  - [projects/dc_auto_bot/background/background.js#L1081](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1081)

정책:

- 탭은 1개만 유지
- `active: false`
- `pinned: true`
- 사용자가 보던 일반 디시 탭을 건드리지 않음

이 구조는 메인 확장에서도 거의 그대로 가져가면 된다.

추가로 실제 구현에는 아래 보강도 들어 있다.

- 탭 제거 시 재생성:
  - [projects/dc_auto_bot/background/background.js#L93](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L93)
- 탭 식별용 hash:
  - [projects/dc_auto_bot/background/background.js#L19](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L19)
  - [projects/dc_auto_bot/background/background.js#L967](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L967)
- session tab id/runtime 저장:
  - [projects/dc_auto_bot/background/background.js#L848](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L848)
  - [projects/dc_auto_bot/background/background.js#L863](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L863)

즉 메인 확장도 단순 `tabs.create()`만 복사하면 부족하고,

- tab 재발견
- tab 제거 복구
- runtime 저장/복원

까지 같이 가져가는 게 맞다.


### 3. 관리자 권한 / 로그아웃 상태 판정

신문고봇은 특갤 목록 페이지를 새로고침한 뒤 DOM으로 상태를 판정한다.

- 세션 페이지 검사:
  - [projects/dc_auto_bot/background/background.js#L1099](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1099)
- 실제 DOM 판정 함수:
  - [projects/dc_auto_bot/background/background.js#L1525](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1525)

판정 기준:

1. `button.btn_useradmin_go`가 현재 갤러리 ID 기준으로 있으면 성공
2. `로그인해 주세요.` strong + `sign.dcinside.com/login` onclick이 있으면 로그아웃
3. 둘 다 아니면 `wrong_account_or_no_manager`

이 방식은 메인 확장의 계정 전환 성공 판정에도 그대로 쓸 수 있다.


### 4. 로그인 페이지 자동 입력/제출

신문고봇은 로그인 페이지에서 실제 DOM 조작으로 입력 후 제출한다.

- 자동 로그인 진입:
  - [projects/dc_auto_bot/background/background.js#L1142](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1142)
- 로그인 폼 채우기/제출:
  - [projects/dc_auto_bot/background/background.js#L1555](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1555)

사용 selector:

- 아이디:
  - `#id`
  - `input[name="user_id"]`
- 비밀번호:
  - `#pw`
  - `input[name="pw"]`
- 로그인 버튼:
  - `button[type="submit"]`
  - `button.btn_blue.small.btn_wfull`

즉 "로그인 전환이 실제로 될까"에 대한 핵심 DOM 자동화는 이미 검증된 패턴이 있다.


### 5. 로그인 상태 확인 / 자동 재로그인 루프

신문고봇은 로그인 상태를 주기적으로 보고, 필요 시 자동 로그인을 시도한다.

- 로그인 상태 확인/자동 로그인 메인 루프:
  - [projects/dc_auto_bot/background/background.js#L1241](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1241)
- 액션 직전 세션 확인:
  - [projects/dc_auto_bot/background/background.js#L1417](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1417)
- 액션 실패 후 세션 복구:
  - [projects/dc_auto_bot/background/background.js#L1437](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1437)

이 구조 중 메인 확장에서 직접 재사용 가치가 큰 것은:

- 전용 탭 재사용
- 새로고침 후 상태 판정
- 로그아웃 시 로그인 시도
- wrong account / no manager 분리
- 재시도/쿨다운

이다.

추가로 중요한 구현 포인트는 **singleflight**다.

- [projects/dc_auto_bot/background/background.js#L1259](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L1259)

신문고봇은 `pendingPromise`를 써서
동시에 여러 로그인 상태 확인/자동 로그인 시도가 겹치지 않게 막는다.

메인 확장의 계정 fallback broker도 똑같이:

- `pendingSwitchPromise`
- 또는 `pendingHealthCheckPromise`

를 둬서 중복 전환을 coalesce해야 한다.


### 6. 설정 UI와 저장 방식

신문고봇 popup에는 이미 아이디/비밀번호 저장 UI가 있다.

- 토글:
  - [projects/dc_auto_bot/popup/popup.html#L37](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/popup/popup.html#L37)
- 아이디 입력:
  - [projects/dc_auto_bot/popup/popup.html#L128](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/popup/popup.html#L128)
- 비밀번호 입력:
  - [projects/dc_auto_bot/popup/popup.html#L132](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/popup/popup.html#L132)
- popup config builder:
  - [projects/dc_auto_bot/popup/popup.js#L468](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/popup/popup.js#L468)
- background 업데이트:
  - [projects/dc_auto_bot/background/background.js#L337](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/background/background.js#L337)

즉 메인 확장도 같은 방식으로:

- `primaryUserId`
- `primaryPassword`
- `backupUserId`
- `backupPassword`

를 popup에 두고 `chrome.storage.local`에 넣으면 된다.


## 메인 확장에서 그대로 재사용 가능한 것

### 그대로 가져갈 수 있는 영역

1. 전용 세션 체크 탭 단일 유지 방식
2. 탭 로딩 완료 대기 로직
3. 세션 페이지 DOM 검사 방식
4. 로그인 폼 selector와 제출 방식
5. 로그인 실패 상태 분류
6. 재시도/쿨다운 기본 구조


### 그대로는 못 가져가는 영역

1. 신문고봇은 단일 계정 자동 로그인 기준이다
2. 메인 확장은 댓글/게시글/IP/감시 자동화가 같은 쿠키 세션을 공유한다
3. 메인 확장은 액션 중간에 삭제 한도 fallback으로 계정을 전환해야 한다
4. 따라서 단순 `ensureLoginSessionBeforeAction()` 수준이 아니라
   **전역 세션 브로커**가 필요하다
5. 신문고봇은 로그인 정보를 단일 scheduler config에 저장하지만,
   메인 확장은 그 방식을 쓰면 안 된다


## 메인 확장용 일반화 포인트

### 1. 계정 구조

신문고봇 현재 구조:

- `dcLoginUserId`
- `dcLoginPassword`

메인 확장 확장안:

- `primaryAccount.userId`
- `primaryAccount.password`
- `backupAccount.userId`
- `backupAccount.password`
- `activeAccountId`

권장:

- 이 값들은 scheduler config가 아니라 broker 전용 상태로 관리

이유:

- 메인 확장은 여러 scheduler가 따로 저장되므로
- 동일 credential이 feature별로 중복 저장되면 드리프트가 나기 쉽다


### 2. 로그인 시도 함수 일반화

현재 레퍼런스 함수:

- `attemptAutoLogin(tabId, loginUrl, galleryId)`

메인 확장에서는 아래처럼 일반화하는 게 맞다.

```js
attemptAccountLogin(tabId, {
  accountId: 'primary' | 'backup',
  userId,
  password,
  galleryId,
})
```

즉 함수 내부에서 `scheduler.config.dcLoginUserId`를 직접 읽지 말고,
broker가 넘겨준 계정 정보를 쓰도록 바꿔야 한다.

즉 기존 레퍼런스 코드는 "로컬 상태 + 단일 계정 자동 로그인"이고,
메인 확장은 "broker가 선택한 계정으로 session switch"로 추상화해야 한다.


### 3. 성공 판정은 그대로

전환 성공 판정은 그대로:

- 특갤 페이지 새로고침
- `btn_useradmin_go` 확인

으로 두는 게 제일 안전하다.

즉 "로그인 성공"이 아니라 "현재 계정이 특갤 관리자 권한으로 살아 있는가"가 기준이다.


### 4. wrong account / no manager 상태 처리

이 상태는 메인 확장에서 더 중요하다.

왜냐면:

- 부계정 정보가 틀렸거나
- 부계정이 아직 부매니저 권한을 못 받았거나
- 잘못된 계정으로 로그인되었을 수 있기 때문이다.

정책:

- `wrong_account_or_no_manager`면 바로 switch success로 보지 않음
- 이번 계정 fallback은 실패 처리
- 현재 동작으로 내려가면 `ban-only`


## 메인 확장에서 추가로 필요한 스펙

### 1. 권한 추가

메인 확장 manifest에 아래를 추가해야 한다.

- `tabs`
- `scripting`
- `notifications`
- `https://sign.dcinside.com/*`


### 2. 설정 UI

메인 확장 popup에 최소 아래가 필요하다.

- `본계정 아이디`
- `본계정 비밀번호`
- `부계정 아이디`
- `부계정 비밀번호`
- 현재 활성 계정 표시
- 계정 전환 중 상태 표시

1차 구현에서는 수동 강제 전환 버튼은 없어도 된다.

주의:

- 이 설정은 `updateSharedConfig`가 아니라 별도 broker action으로 업데이트하는 것이 맞다
- 예: `updateSessionFallbackConfig`
- 이유는 gallery/headtext 공통설정과 성격이 다르고 저장 위치도 다르기 때문이다


### 3. broker 연계

이 레퍼런스만으로는 부족하고, 실제 삭제한도 fallback은 아래 문서의 broker 구조와 합쳐야 한다.

- [delete_limit_account_fallback_plan.md](/home/eorb915/projects/dc_defense_suite/docs/delete_limit_account_fallback_plan.md)

즉 이 로그인 스펙은:

- 전용 탭 생성
- 로그인 DOM 자동화
- 관리자 권한 확인

까지의 참조 문서이고,

실제 "공격 중 pause -> 계정 전환 -> 같은 run resume"은 fallback 문서 쪽이 본체다.


### 4. 1차에서는 전체 login health automation을 그대로 옮길 필요는 없다

신문고봇 레퍼런스에는:

- 30초 alarm 기반 로그인 health check
- 자동 재로그인
- 알림 notification

까지 모두 들어 있다.

하지만 메인 확장의 1차 목적은:

- delete-limit 발생 시 계정 전환

이므로,

1차에서는 아래만 가져오면 충분하다.

1. session tab 생성/유지
2. on-demand 로그인 전환
3. 관리자 권한 확인
4. 최소한의 retry/cooldown

즉 **주기적 30초 health check 전체를 그대로 포팅하는 것은 1차 필수는 아니다.**

필요하면 2차에 별도로 붙인다.


## 최종 판단

`본계정/부계정만 입력하면 로그인 전환 자체는 쉬운가?`에 대한 답은:

- **예, 비교적 쉽다**

다만 정확히는:

- 로그인 자동화 자체는 이미 레퍼런스가 있고
- 메인 확장에 권한만 추가하면 거의 그대로 재사용할 수 있다

하지만 전체 작업은:

- 로그인 자동화 재사용
- 2계정 일반화
- 전역 세션 브로커
- 삭제한도 fallback 정책

이 함께 들어가므로, **전체 기능은 중간 이상 규모의 구조 작업**이다.

즉 가장 어려운 건 로그인 DOM 자동화가 아니라,
**공격 중/자동화 ON 상태에서도 전체 자동화를 안전하게 멈췄다가 같은 run으로 이어받는 broker 설계**다.
