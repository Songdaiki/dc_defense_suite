# 삭제 한도 계정 Fallback 스펙

## 목적

메인 확장에서 삭제 한도가 발생했을 때,
현재처럼 즉시 `ban-only`로만 내려가지 않고
본계정/부계정 2개를 번갈아 사용해 **같은 run을 최대한 이어서 진행**하는 동작을 정의한다.

이 문서는 구현 기준 스펙 문서다.

- 로그인 전환 참조 구현:
  - [dc_session_switch_login_reference_spec.md](/home/eorb915/projects/dc_defense_suite/docs/dc_session_switch_login_reference_spec.md)
- 전체 배경/아키텍처 플랜:
  - [delete_limit_account_fallback_plan.md](/home/eorb915/projects/dc_defense_suite/docs/delete_limit_account_fallback_plan.md)
- 세션 유지 ownership 이전:
  - [dc_session_broker_login_keepalive_plan.md](/home/eorb915/projects/dc_defense_suite/docs/dc_session_broker_login_keepalive_plan.md)


## 1차 범위

1차 구현은 **IP 삭제 한도 감지 시만** 계정 fallback을 시도한다.

전제:

- 신문고봇의 기존 로그인 세션 자동화가 세션 주도권을 계속 가지면 broker와 충돌할 수 있다
- 따라서 운영 rollout 전에는 최소한
  - 특궁 broker가 로그인 유지 자동화를 소유하거나
  - 신문고봇 로그인 자동화가 비활성화/제거되어야 한다

포함:

- 메인 확장에 신문고봇식 로그인 자동화 권한/전용 탭 로직 추가
- 설정에 `본계정`, `부계정` 추가
- 공통 설정에 실제 broker 경로를 타는 `계정 전환 테스트` 버튼 추가
- background에 `dcSessionBroker` 추가
- `IP 삭제한도` 감지 시 broker가 계정 전환 시도
- 전환 성공 시 같은 run 계속
- 전환 실패 시 현재처럼 `ban-only`
- 부계도 limit면 본계 1회 복귀
- 짧은 시간 안에 다시 limit면 더 이상 전환 안 하고 `ban-only`
- 특궁 broker가 세션 유지 ownership을 가진 상태를 전제

제외:

- 댓글 delete-limit 기반 계정 fallback
- 게시글 분류 delete-limit 기반 계정 fallback
- 3계정 이상 로테이션
- **특궁-신문고봇 external bridge**


## 현재 실제 감지 지점

1차 트리거는 아래 두 지점으로 확정한다.

- [features/ip/scheduler.js#L320](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L320)
- [features/ip/scheduler.js#L431](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L431)

의미:

1. IP 삭제/차단 요청 결과에서 `deleteLimitExceeded` 감지
2. 현재처럼 바로 `activateDeleteLimitBanOnly()`를 확정하기 전에
3. 먼저 broker에 계정 fallback을 요청


## 확정 정책

### 계정 정책

- 계정은 2개만 쓴다
  - `primaryAccount`
  - `backupAccount`
- popup에서 사용자 입력으로 저장한다
- 활성 계정은 항상 하나만 가진다
  - `activeAccountId = 'primary' | 'backup'`


### 기본 전환 정책

1. 기본 활성 계정은 `primary`
2. `primary`에서 삭제 한도 발생
   - `backup`으로 전환 시도
3. 전환 성공
   - 같은 run 그대로 계속 진행
4. `backup`에서도 삭제 한도 발생
   - `primary`로 1회 복귀 시도
5. 그 복귀 직후 짧은 시간 안에 다시 삭제 한도 발생
   - 더 이상 계정 전환 안 함
   - 현재처럼 `ban-only`


### 루프 가드 정책

- `DELETE_LIMIT_LOOP_GUARD_MS` 안에
- 계정을 바꾼 직후 다시 delete-limit가 나면
- 추가 전환을 금지한다

권장 초기값:

- `10분`

즉 허용되는 최대 흐름은:

- `primary -> backup`
- `backup -> primary`

까지이고,

- `primary` 복귀 직후 다시 빠른 delete-limit

이면 종료 후 `ban-only`다.


### 실패 시 정책

아래 중 하나면 계정 fallback은 실패 처리한다.

- 로그인 폼 자동 입력 실패
- 로그인 결과 확인 timeout
- `wrong_account_or_no_manager`
- `btn_useradmin_go` 확인 실패
- 본계/부계 계정 정보 누락
- session tab 생성 실패

실패 시 동작:

- 현재 동작대로 `ban-only`


### external bridge 정책

1차는 **external bridge 없이 간다.**

- 특궁 메인 확장은 `onMessageExternal` 같은 cross-extension broker 상태 공개를 넣지 않는다
- 신문고봇은 `switchInProgress`를 조회하지 않는다
- 계정 전환 중 신문고봇 액션이 짧은 타이밍에 겹쳐 1회 실패할 가능성은 허용한다

즉 1차에서 꼭 필요한 것은:

- 특궁 broker가 세션 유지/계정 전환 ownership을 갖는 것
- 신문고봇이 자체 로그인 자동화를 제거하는 것

이고,

- 외부 상태 브리지
- 전환 중 선대기

는 후속 보강안이다.


### 추가로 확정해야 할 운영 정책

아래는 구현 전에 값까지 확정하는 것이 좋다.

1. `SWITCH_LOGIN_TIMEOUT_MS`
   - 권장: `15초`
2. `LEASE_DRAIN_TIMEOUT_MS`
   - 권장: `5초`
3. `DELETE_LIMIT_LOOP_GUARD_MS`
   - 권장: `10분`
4. 계정 설정 수정 가능 시점
   - 권장: `switchInProgress=false` 이고 모든 DC 자동화가 idle일 때만 허용
5. 전환 실패 로그 정책
   - `로그인 실패`
   - `권한 없음`
   - `timeout`
   - `loop guard`
   를 구분해 남길지


## 구현 구조

### 1. manifest 권한 확장

메인 확장 manifest에 아래를 추가해야 한다.

- `tabs`
- `scripting`
- `notifications`
- host permission `https://sign.dcinside.com/*`

참조:

- [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json)
- [projects/dc_auto_bot/manifest.json](/home/eorb915/projects/dc_defense_suite/projects/dc_auto_bot/manifest.json)


### 2. popup 설정

popup에 아래 설정을 추가한다.

- `본계정 아이디`
- `본계정 비밀번호`
- `부계정 아이디`
- `부계정 비밀번호`
- `계정 전환 테스트` 버튼

1차에서는 추가로 아래 상태만 표시하면 충분하다.

- 현재 활성 계정
- 세션 전환 중 여부
- 최근 delete-limit 발생 계정

권장:

- 설정 저장 경로는 `updateSharedConfig`가 아니라
  `updateSessionFallbackConfig` 같은 broker 전용 action으로 분리
- 계정 정보는 scheduler config가 아니라 broker 전용 storage에 저장
- `계정 전환 테스트`도 별도 broker action으로 분리하고,
  실제 delete-limit fallback과 같은 로그인/권한 확인 경로를 그대로 재사용한다
- 1차는 안전하게, 자동화가 실행 중일 때는 `계정 전환 테스트`를 막는다


### 3. background `dcSessionBroker`

위치 권장:

- `background/dc-session-broker.js`

역할:

- 활성 계정 관리
- 전용 session tab 관리
- 계정 로그인 전환
- 현재 전환 진행 상태 저장
- delete-limit 루프 가드 적용
- 새 DC 요청 lease 제어

최소 상태:

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
- `pendingSwitchPromise`

주의:

- broker는 scheduler registry에 넣지 않고 background singleton 서비스로 둔다
- service worker startup 때 scheduler보다 먼저 broker state를 복원해야 한다
- startup 시 `switchInProgress=true`가 남아 있더라도,
  1차 구현은 `switchTarget`을 성공으로 간주하지 않고
  **마지막 확정 activeAccountId를 유지한 채 전환 실패로 reconcile** 한다


### 4. 로그인 전환 로직

신문고봇 구현을 참조해 아래를 가져간다.

- 전용 탭 1개 생성/유지
- 특갤 목록 페이지 refresh 후 관리자 버튼 검사
- 로그인 페이지 DOM 입력/제출
- wrong account / no manager 판정

참조 스펙:

- [dc_session_switch_login_reference_spec.md](/home/eorb915/projects/dc_defense_suite/docs/dc_session_switch_login_reference_spec.md)


### 5. 요청 lease / pause

계정 전환 중에는 새 DC 요청이 들어가면 안 된다.

따라서 API 단위 per-fetch gate가 아니라,
`ci_c` 조회부터 chunk/retry까지 포함한 **high-level request lease**가 필요하다.

예:

```js
const lease = await dcSessionBroker.acquireRequestLease({
  feature: 'ip',
  kind: 'banPosts',
});

try {
  // ci_c 조회 + chunk POST + retry 전체
} finally {
  lease.release();
}
```

전환 시:

1. 새 lease 획득 차단
2. in-flight lease drain 대기
3. 1차 구현은 drain timeout까지 기다리고, timeout이면 전환 실패로 간주
4. 추후 확장 시 필요하면 abort signal 사용
5. 로그인 전환
6. 성공 후 lease 재개

### 1차 구현 메모

이번 1차 구현은 `AbortController` 기반 cooperative abort까지는 넣지 않고,
다음 보수적 정책으로 간다.

- **high-level request lease**는 전 기능에 적용
- 계정 전환 시 **새 lease는 즉시 차단**
- 기존 in-flight lease는 `LEASE_DRAIN_TIMEOUT_MS` 동안만 drain 대기
- 시간 안에 정리되지 않으면 전환 실패로 보고 현재처럼 `ban-only`

즉 1차는:

- `lease + drain timeout` O
- `same run resume` O
- `cooperative abort transport` X

이다.

주의:

- pause/abort를 일반 `Error`로 던지면 현재 scheduler run loop가 `오류 발생 -> 10초 후 재시도`로 처리한다
- 따라서 `AbortError` 또는 `SessionSwitchPauseError` 같은 특별 제어 예외를 두고
  scheduler에서 별도 처리해야 한다
- 특히 monitor `performInitialSweep()`는 pause 예외를 일반 오류로 처리하면 `initialSweepCompleted=true`로 굳을 수 있으므로
  별도 분기 처리가 필요하다
- long retry/backoff와 cycle delay는 현재 비중단형 sleep이 많아서,
  1차는 `drain timeout 실패 -> ban-only`로 보수적으로 처리하고
  이후 단계에서 broker-aware abortable delay 확장을 고려한다


## 기능 플로우

### 정상 흐름

1. 활성 계정은 `primary`
2. IP 스케줄러가 삭제/차단 수행
3. delete-limit 없음
4. 현재처럼 계속 진행


### fallback 흐름

1. IP 스케줄러가 delete-limit 감지
2. 즉시 `ban-only`를 확정하지 않고 broker에 fallback 요청
3. broker가 새 DC lease 차단
4. in-flight lease 정리
5. session tab에서 `backup` 로그인 시도
6. 특갤 관리자 버튼으로 성공 검증
7. 성공 시 `activeAccountId = backup`
8. 실패 chunk 또는 다음 chunk부터 같은 run 재개
9. 이후는 `backup`으로 그대로 운영

중요:

- `activateDeleteLimitBanOnly()`는 broker 실패가 확정되기 전에는 commit하면 안 된다
- 즉 detect와 commit을 분리해야 한다


### backup도 limit인 흐름

1. `backup` 운영 중 delete-limit 감지
2. broker가 `primary` 복귀 1회 시도
3. 성공하면 같은 run 재개
4. 그런데 짧은 시간 안에 다시 delete-limit
5. 루프 가드 발동
6. 더 이상 전환 안 함
7. `ban-only`


### monitor 연동 주의사항

1차 트리거는 IP만이지만, monitor가 child IP 상태를 보고 ban-only를 굳히는 경로가 이미 있다.

- [features/monitor/scheduler.js#L380](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L380)
- [features/monitor/scheduler.js#L598](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L598)

따라서 IP scheduler가 broker 성공 전에 너무 일찍:

- `runtimeDeleteEnabled = false`
- `lastDeleteLimitExceededAt` 설정

을 해버리면 monitor가 이를 보고 공격 세션을 조기 ban-only로 굳힐 수 있다.

즉 detect/commit 분리는 IP 단독 경로뿐 아니라 monitor child 연동 관점에서도 필수다.


## 구현 순서

1. manifest 권한 추가
2. popup 계정 설정 UI 추가
3. 신문고봇 login automation 참조 로직을 메인 background용으로 분리
4. `dcSessionBroker` 추가
5. API request lease/gate 추가
6. `features/ip/scheduler.js`에서 delete-limit 감지와 `ban-only commit` 분리
7. broker fallback 연결
8. 상태/로그/UI 반영


## 최종 판단

이 스펙의 핵심은:

- 로그인 전환 자체는 신문고봇 레퍼런스를 재사용
- 실제 난점은 전역 세션 브로커와 같은 run resume
- 1차는 `IP delete-limit`만 대상으로 좁혀서 구현

즉 가장 빠르고 안전한 방향은:

- **IP 삭제 한도 감지 시만 계정 fallback**
- **성공하면 같은 run 계속**
- **실패하면 현재처럼 ban-only**

이다.
