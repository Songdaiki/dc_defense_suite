# 게시물 자동감시 공격 중 분탕자동차단 Ban-Only 전환 문서

> 작성일: 2026-04-17  
> 기준 코드: `HEAD 23f92a0`  
> 대상 범위: 게시물 `monitor`가 공격 상태일 때 `uid-warning-autoban`을 완전 정지하지 않고 `ban-only`로 유지  
> 제외 범위: `uid-warning-autoban` 탐지 규칙 변경, UI 구조 개편, `ip`/`post` 공격 대응 방식 변경

## 0. 한 줄 결론

이번 건은 **완전 최소패치로 가능하다.**

쉽게 말하면 지금은:

1. `monitor`가 공격 감지
2. `uid-warning-autoban`을 아예 `stop()`
3. 공격 종료 후 다시 `start()`

인데,

바꿀 것은:

1. `monitor`가 공격 감지
2. `uid-warning-autoban`은 계속 실행
3. 대신 `runtimeDeleteEnabled = false`로 내려서 `차단만 유지`
4. 공격 종료 후 원래 설정이 삭제 ON이었다면 다시 `차단 + 삭제`로 복원

즉 사용자가 말한

- “공격 중에는 ban-only”
- “공격 풀리면 다시 삭제/차단”

이 요구는 현재 코드 기준으로 **새 시스템을 만드는 게 아니라 기존 런타임 삭제 토글을 monitor가 재사용하면 되는 구조**다.

## 1. 실제 코드 교차검증 결과

이 문서는 아래 실제 코드를 다시 읽고 연결관계를 대조한 뒤 작성했다.

- 게시물 자동감시 본체:
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)
- 분탕자동차단 본체:
  - [features/uid-warning-autoban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js)
- background 복원/충돌 처리:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)
- popup 상태 표시:
  - [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)

### 1.1 지금 monitor는 공격 진입 시 uid-warning-autoban을 완전히 내린다

[features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L317) 기준:

- `enterAttackMode()` 마지막에서 `await this.suspendUidWarningAutoBanForAttack();`를 호출한다.

[features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L860) 기준:

- `suspendUidWarningAutoBanForAttack()`는
  - `uidWarningAutoBanScheduler`가 실행 중이면
  - `await scheduler.stop();`
  - `managedUidWarningAutoBanSuspended = true`
  - monitor 로그에 `🛑 분탕자동차단 일시 정지`
  - uid scheduler 로그에 `게시물 자동화 공격 감지로 분탕자동차단을 일시 정지합니다.`
  - 를 남긴다.

즉 현재는 **ban-only가 아니라 완전 stop**이다.

### 1.2 공격 종료 시에는 다시 start()로 복원한다

[features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L795) 기준:

- `enterRecoveringMode()`는 `const shouldResumeUidWarningAutoBan = this.managedUidWarningAutoBanSuspended;`
  를 잡고,
- child 정리 뒤
- `await this.resumeUidWarningAutoBanAfterAttack(shouldResumeUidWarningAutoBan);`
  를 호출한다.

[features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L879) 기준:

- `resumeUidWarningAutoBanAfterAttack()`는
  - `scheduler.start()`
  - `게시물 자동화 공격 종료로 분탕자동차단을 자동 복원합니다.`
  - `🔁 분탕자동차단 자동 복원`
  을 수행한다.

즉 현재 복원 방식도 **실행 재시작**이다.

### 1.3 그런데 uid-warning-autoban 자체는 이미 ban-only 런타임 상태를 지원한다

[features/uid-warning-autoban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L71) 기준:

- scheduler는 `runtimeDeleteEnabled`를 따로 가진다.

[features/uid-warning-autoban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L323), [features/uid-warning-autoban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L408), [features/uid-warning-autoban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L528) 기준:

- 실제 제재 호출은 전부 `deleteEnabled: this.runtimeDeleteEnabled`를 탄다.

즉 이 값만 `false`로 내리면:

- 탐지는 계속 돈다
- 차단은 계속 된다
- 삭제만 멈춘다

사용자가 원하는 `ban-only`가 이미 구현되어 있는 셈이다.

### 1.4 popup UI도 이미 ban-only 상태를 그대로 보여줄 수 있다

[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2607) 기준:

- `runtimeDeleteEnabled === false`면
  - 상태 텍스트: `차단만 유지`
  - 색상: `status-warn`

[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3212) 기준:

- 메타 텍스트도 `runtimeDeleteEnabled === false`를 해석해 보여준다.

즉 UI는 이번 패치 때문에 새로 만들 게 거의 없다.

### 1.5 background 쪽에는 지금 새 요구와 충돌하는 stop 로직이 있다

[background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1385) 기준:

- `resolveUidWarningAutoBanResumeConflict()`는
  - monitor가 `ATTACKING`/`RECOVERING`이면
  - `await schedulers.uidWarningAutoBan.stop();`
  - `감시 자동화 공격/복구 상태와 충돌해 분탕자동차단 자동 복원을 취소했습니다.`
  를 남긴다.

이 함수는 [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L265) 에서 서비스워커 복원 시 항상 돈다.

즉 monitor 쪽만 ban-only로 바꿔도,

- 서비스워커가 다시 살아날 때
- background가 uid autoban을 다시 stop 시켜버릴 수 있다.

이번 문서에서 background를 같이 바꾸는 이유가 이거다.

### 1.6 popup은 지금 ban-only 이유를 구분하지 못한다

[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3167) 기준:

- `runtimeDeleteEnabled === false`면 상태는 전부 `차단만 유지 중`으로 보인다.

[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3212) 기준:

- 메타 문구는 무조건
  - `삭제 한도 보호 상태라 새 글이 와도 당분간 차단만 수행합니다`
  로 나온다.

즉 monitor 공격 때문에 ban-only로 내려도 popup은 지금 그걸 **삭제 한도 보호로 오인**한다.

예:

- 실제 이유:
  - monitor 공격 진입
  - monitor가 uid autoban을 ban-only로 강제
- 현재 UI 문구:
  - `삭제 한도 보호 상태`

이건 사용자 입장에서 오해를 부르는 상태다.

그래서 이번 패치는 동작만 바꾸는 걸로 끝내면 안 되고,
**ban-only 이유를 구분하는 작은 상태값**도 같이 넣는 편이 맞다.

### 1.7 uid autoban 제재 1회는 호출 시점의 deleteEnabled를 캡처한다

[features/ip/ban-executor.js](/home/eorb915/projects/dc_defense_suite/features/ip/ban-executor.js#L21) 기준:

- `executeBanWithDeleteFallback()`는 시작 시점에
  - `const deleteEnabled = Boolean(options.deleteEnabled);`
  로 값을 캡처한다.

[features/ip/ban-executor.js](/home/eorb915/projects/dc_defense_suite/features/ip/ban-executor.js#L57) 기준:

- 실제 첫 ban 호출도 그 캡처값으로 바로 실행된다.

즉 monitor가 공격 감지 직후 `runtimeDeleteEnabled = false`로 내려도,
**이미 시작된 uid autoban 1회 실행**은 기존 `deleteEnabled=true` 스냅샷으로 끝날 수 있다.

예:

1. uid autoban이 방금 `executeBan({ deleteEnabled: true })` 시작
2. 그 직후 monitor 공격 감지
3. monitor가 `runtimeDeleteEnabled = false` 전환
4. 이미 시작한 그 1회는 기존 모드로 끝남
5. 다음 제재 호출부터 ban-only 반영

즉 이번 패치는 **다음 호출부터 ban-only가 강제된다**는 의미지,
이미 시작된 in-flight 1회를 원자적으로 중단하는 패치는 아니다.

이건 현재 구조에서 자연스러운 한계라 문서에 명시해야 한다.

### 1.8 기존 복원 로직의 IP guard를 그대로 쓰면 영구 ban-only 위험이 있다

[features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L895) 기준:

- 현재 `resumeUidWarningAutoBanAfterAttack()`는
  - `ipScheduler`가 아직 실행 중이면
  - 자동 복원을 건너뛴다.

이건 지금 구조에서는 “uid autoban을 다시 start하지 말자”는 의미로 맞았다.

그런데 ban-only 구조로 바꾸고도 이 guard를 그대로 복사하면,

예:

1. 공격 종료
2. uid autoban delete 모드 복원을 시도
3. ip child가 아직 running으로 보임
4. 복원 건너뜀
5. 이후 재시도 지점이 없으면 계속 ban-only

가 된다.

즉 새 구조에서는 이 부분을 다시 결정해야 한다.

- 선택지 A:
  - old IP guard를 제거
  - `stopManagedDefenses()`가 끝난 뒤면 바로 복원
  - diff는 작다
- 선택지 B:
  - guard 유지
  - 대신 `restorePending` 같은 재시도 상태를 추가
  - 더 안전하지만 diff가 커진다

이번 건은 최소패치가 목표라서,
**기본 권장안은 A**다.  
대신 ip child 정지 실패는 residual risk로 문서에 남긴다.

### 1.9 `uid-warning-autoban`은 현재 `delChk`를 영속 저장하지 않는다

[features/uid-warning-autoban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L770) 기준:

- `buildPersistedConfig()`는
  - `galleryId`
  - `galleryType`
  - `baseUrl`
  - `immediateTitleBanRules`
  만 저장한다.

즉 `delChk`는 현재 persisted config에 들어가지 않는다.

또 [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3444) 기준:

- uid autoban UI에서 실제 저장 가능한 config input도 현재는 규칙 목록뿐이다.

쉽게 말하면 지금 제품 기준으로는:

- uid autoban 삭제 ON/OFF는 사용자 UI 설정으로 운영되는 기능이 아니다
- 런타임 값은 `runtimeDeleteEnabled`가 따로 들고 간다
- 재기동 후 `config.delChk`는 사실상 기본값 `true`로 복귀한다

그래서 이번 패치 문서에서 말하는

- `config.delChk` 기준 복원

은 **현재 세션 메모리 기준 설명으로는 맞지만**,
장기적으로 “사용자 설정 삭제모드”까지 보장하는 구조는 아니다.

현재 운영 기준에서는 문제되지 않는다.

이유:

- popup에 삭제모드 설정 UI가 없다
- persisted config도 그 값을 저장하지 않는다
- 즉 오늘 패치 범위에서 사용자가 기대하는 복원값은 사실상 `기본 삭제 ON`이다

다만 나중에 uid autoban에도 삭제모드 설정 UI를 붙일 계획이 생기면,
이 항목은 반드시 같이 손봐야 한다.

필요한 후속은:

- `buildPersistedConfig()`에 `delChk` 포함
- `readPersistedConfig()`에서 `delChk` 복원
- popup 설정 input 추가
- 그때 `runtimeDeleteModeReason = config` 분기 의미가 완전히 살아난다

## 2. 이번 패치의 목표

목표는 아주 좁다.

- `monitor` 공격 진입 시:
  - `uid-warning-autoban`을 정지하지 않는다.
  - 대신 `runtimeDeleteEnabled = false`로 내려서 `ban-only` 유지
- `monitor` 공격 종료 또는 monitor 수동 정지 시:
  - monitor가 이번 공격에서 직접 ban-only로 내렸던 경우만
  - 현재 세션 기준 원래 설정(`config.delChk`)대로 복원
- 서비스워커 복원 중 monitor가 공격 상태면:
  - uid autoban을 stop하지 말고
  - ban-only 상태만 다시 강제
- popup/status에서는
  - ban-only 이유가 `삭제 한도`인지
  - `monitor 공격`인지
  - 구분해서 보여준다

예:

- 원래 상태:
  - 분탕자동차단 ON
  - `runtimeDeleteEnabled = true`
  - 즉 `차단 + 삭제`
- 공격 감지 후:
  - 분탕자동차단은 계속 ON
  - `runtimeDeleteEnabled = false`
  - 즉 `차단만 유지`
- 공격 종료 후:
  - 다시 `runtimeDeleteEnabled = true`
  - 즉 `차단 + 삭제`

## 3. 왜 이게 최소패치인지

이유는 간단하다.

지금 새로 만들어야 하는 것은 거의 없고, 아래 4가지만 바꾸면 된다.

1. monitor가 `stop/start` 하던 것을 `runtimeDeleteEnabled false/restore`로 바꾼다.
2. monitor가 “내가 이번 공격에서 ban-only를 강제했는지”만 state로 기억한다.
3. background 복원 시 stop 대신 ban-only 재적용으로 바꾼다.
4. uid autoban status/popup이 ban-only 이유를 구분하도록 작은 상태값을 더한다.

안 건드려도 되는 것:

- `uid-warning-autoban`의 탐지 로직
- `uid-warning-autoban`의 executeBan 경로 본체
- popup 구조 전면개편
- manual lock UI
- post/ip child 제어

즉 범위가 작고 파생 영향도도 제한적이다.

## 4. 실제 변경 포인트

### 4.1 `features/monitor/scheduler.js`

#### 현재 상태

- 공격 진입:
  - `enterAttackMode()`
  - `suspendUidWarningAutoBanForAttack()`
  - `scheduler.stop()`
- 공격 종료:
  - `resumeUidWarningAutoBanAfterAttack()`
  - `scheduler.start()`
- state:
  - `managedUidWarningAutoBanSuspended`

#### 변경안

- 새 monitor 상태 추가:
  - `managedUidWarningAutoBanBanOnly`
  - 의미: “이번 공격 세션에서 monitor가 uid autoban을 ban-only로 강제했는가”

- `enterAttackMode()`에서
  - `suspendUidWarningAutoBanForAttack()`
  - 대신
  - `activateUidWarningAutoBanBanOnlyForAttack()`
  - 호출

- 새 함수 `activateUidWarningAutoBanBanOnlyForAttack()`:
  - `uid scheduler`가 없거나 미실행이면 아무것도 안 함
  - 이미 `runtimeDeleteEnabled === false`면
    - 강제 전환한 것이 아니므로 `managedUidWarningAutoBanBanOnly = false`
    - 그대로 둠
  - `runtimeDeleteEnabled === true`면
    - uid scheduler helper를 통해 `runtimeDeleteEnabled = false`
    - `managedUidWarningAutoBanBanOnly = true`
    - uid scheduler 로그:
      - `게시물 자동화 공격 감지로 분탕자동차단은 공격 종료까지 차단만 유지합니다.`
    - monitor 로그:
      - `🛡️ 분탕자동차단 ban-only 전환`
    - `scheduler.saveState()`

- 새 함수 `restoreUidWarningAutoBanDeleteModeAfterAttack()`:
  - `managedUidWarningAutoBanBanOnly !== true`면 아무것도 안 함
  - `scheduler`가 없으면 flag만 내리고 종료
  - uid scheduler helper를 통해 `runtimeDeleteEnabled = Boolean(scheduler.config.delChk)`
  - 즉 원래 설정이 삭제 ON이면 ON으로,
    원래부터 삭제 OFF면 OFF로 복원
  - **기존 `resumeUidWarningAutoBanAfterAttack()`의 IP running guard는 그대로 복사하지 않는다**
  - 이유:
    - 이제는 `start()`가 아니라 delete mode restore이기 때문
    - old guard를 유지하면 영구 ban-only 위험이 생긴다
  - uid scheduler 로그:
    - `게시물 자동화 공격 종료로 분탕자동차단 삭제/차단 모드를 원래 설정으로 복원합니다.`
  - monitor 로그:
    - `🔁 분탕자동차단 삭제 모드 복원`
  - `scheduler.saveState()`

- `enterAttackMode()` 안에서는
  - ban-only 전환 직후
  - monitor 자신의 `saveState()`도 한 번 더 해두는 쪽이 안전하다
  - 이유:
    - `phase=ATTACKING`
    - `managedUidWarningAutoBanBanOnly=true`
    - 이 조합이 서비스워커 재기동 전에 저장돼야 복원 일관성이 좋아진다

#### 중요한 이유

여기서 restore를 `true` 고정으로 하면 안 된다.

예:

- 사용자가 원래부터 `delChk = false`로 쓴 경우
- monitor 공격 끝났다고 강제로 삭제 ON으로 올리면 오동작

그래서 복원값은 반드시 `scheduler.config.delChk`를 기준으로 잡아야 한다.

### 4.2 `features/uid-warning-autoban/scheduler.js`

#### 현재 상태

- `runtimeDeleteEnabled`는 있으나
- “왜 ban-only인지”는 없다.
- 그래서 popup은 false만 보고 삭제 한도 보호로 해석한다.

#### 변경안

- 작은 상태값 추가:
  - `runtimeDeleteModeReason`

- 권장 값:
  - `normal`
  - `delete_limit`
  - `monitor_attack`

- 권장 helper:
  - `activateMonitorAttackBanOnly()`
  - `restoreRuntimeDeleteModeFromConfig()`

- 반영 포인트:
  - constructor / start / stop / loadState / saveState / getStatus
  - `activateDeleteLimitBanOnly()`에서는 `delete_limit`
  - monitor 강제 ban-only에서는 `monitor_attack`
  - 원복 시에는 현재 세션의 `config.delChk` 기준으로
    - 삭제 ON이면 `normal`
    - 삭제 OFF면 `normal` 또는 빈 값으로 정리

현재 코드에서는 `delChk`가 persisted config가 아니므로
`config`라는 별도 reason 값을 지금 당장 도입할 실익은 크지 않다.

이 값이 있으면 popup이 이유를 정확히 보여줄 수 있고,
delete limit ban-only와 monitor ban-only를 섞어 해석하지 않아도 된다.

helper로 묶는 이유는 단순하다.

- `runtimeDeleteEnabled`
- `runtimeDeleteModeReason`
- 필요 시 로그/저장

이 세 가지를 monitor/background가 제각각 직접 만지기 시작하면
상태가 쉽게 어긋난다.

### 4.3 `popup/popup.js`

#### 현재 상태

- `runtimeDeleteEnabled === false`면 무조건 삭제 한도 보호 문구

#### 변경안

- `buildUidWarningAutoBanMetaText()`에서
  - `status.runtimeDeleteModeReason`
  - 을 우선 본다.
- `buildDefaultUidWarningAutoBanStatus()`에도
  - `runtimeDeleteModeReason`
  - 기본값을 추가한다.

예:

- `monitor_attack`
  - `감시 자동화 공격/복구 중이라 분탕자동차단은 차단만 유지합니다.`
- `delete_limit`
  - 기존 문구 유지

이 보정이 있어야 사용자 입장에서 현재 ban-only 이유를 바로 이해할 수 있다.

### 4.4 `background/background.js`

#### 현재 상태

- `resolveUidWarningAutoBanResumeConflict()`가
  - monitor가 공격/복구 상태면
  - uid autoban을 stop해 버린다.

#### 변경안

- 함수 의미를 “충돌 해결”에서 “공격 상태 복원 보정”으로 바꾼다.

- monitor가 `ATTACKING`/`RECOVERING`이고
  uid autoban이 `isRunning === true`면:
  - stop하지 않는다
  - uid scheduler helper로 ban-only만 강제
  - 이미 false이면 불필요한 중복 로그는 남기지 않는다
  - monitor가 이미 ban-only로 썼던 상태와 맞춘다
  - 필요하면 로그:
    - `감시 자동화 공격/복구 상태 복원으로 분탕자동차단을 차단만 유지 상태로 맞춥니다.`

- 그리고 이 보정은
  - `resumeStandaloneScheduler(schedulers.uidWarningAutoBan, ...)`
  - 보다 앞
  - `monitor.ensureManagedDefensesStarted()`
  - 보다도 앞
  에 남아 있어야 한다.

이 순서가 깨지면 서비스워커 복원 직후 잠깐이라도

- uid autoban = 삭제 가능
- monitor child ip/post = 공격 복원 중

상태가 겹칠 수 있다.

이걸 안 바꾸면 생기는 문제:

1. monitor 공격 중
2. service worker 재기동
3. background 복원
4. uid autoban stop
5. 사용자는 “ban-only 유지”를 기대했는데 실제로는 꺼짐

즉 이 함수는 이번 패치에서 반드시 같이 바뀌어야 한다.

### 4.5 상태 저장/초기화 코드

아래 위치도 같이 맞춰야 한다.

- `features/monitor/scheduler.js`
  - constructor
  - `start()`
  - `stop()`
  - `clearAttackSession()`
  - `saveState()`
  - `loadState()`
  - `getStatus()`

- `features/uid-warning-autoban/scheduler.js`
  - constructor
  - `start()`
  - `stop()`
  - `saveState()`
  - `loadState()`
  - `getStatus()`

- `background/background.js`
  - monitor reset helper에서 새 flag 초기화
  - uid autoban reset helper에서 새 reason/state 초기화

여기 하나라도 빠지면:

- 공격 중 재기동 후 flag 유실
- 복원 시 delete 모드 원복 누락
- reset 후 이전 세션 flag 잔존

같은 문제가 생긴다.

## 5. 구현 플로우 예시

### 예시 1. 정상 케이스

초기 상태:

- monitor = NORMAL
- uid autoban = 실행 중
- `runtimeDeleteEnabled = true`

흐름:

1. monitor 공격 감지
2. `activateUidWarningAutoBanBanOnlyForAttack()`
3. uid autoban 계속 실행
4. 새 제재는 `deleteEnabled: false`
5. 공격 종료
6. `restoreUidWarningAutoBanDeleteModeAfterAttack()`
7. `runtimeDeleteEnabled = true`

결과:

- 공격 중에는 차단만
- 공격 끝나면 다시 차단+삭제

### 예시 2. 원래부터 삭제 OFF였던 경우

초기 상태:

- uid autoban 실행 중
- `config.delChk = false`
- `runtimeDeleteEnabled = false`

흐름:

1. monitor 공격 감지
2. 이미 ban-only라서 추가 전환 없음
3. `managedUidWarningAutoBanBanOnly = false`
4. 공격 종료
5. restore 스킵

결과:

- 공격 전후 모두 계속 ban-only
- monitor가 사용자의 원래 설정을 망치지 않음

### 예시 3. 삭제 한도 때문에 이미 ban-only였던 경우

초기 상태:

- uid autoban 실행 중
- delete limit fallback으로 `runtimeDeleteEnabled = false`

흐름:

1. monitor 공격 감지
2. 이미 false이므로 monitor가 새로 내린 것이 아님
3. `managedUidWarningAutoBanBanOnly = false`
4. 공격 종료
5. restore 스킵

결과:

- delete limit ban-only 상태를 monitor가 덮어쓰지 않음

이 케이스가 중요하다.

왜냐면 공격 종료 후 무조건 true로 올려버리면
원래 delete limit 보호 때문에 유지 중이던 ban-only를 깨뜨리기 때문이다.

## 6. 패치 전 논리검증 결과

### 6.1 파생 문제 없는가

현재 기준으로 큰 파생 문제는 없다.

이유:

1. `uid-warning-autoban`은 원래 `runtimeDeleteEnabled`를 중심으로 동작한다.
2. popup도 이미 그 값을 읽어 상태를 보여준다.
3. manual lock도 monitor phase 기준이라 실행 지속과 충돌하지 않는다.
4. 게시물 `monitor`는 uid autoban의 탐지 규칙에는 손대지 않는다.

즉 이번 변경은 **실행 여부 제어를 삭제 여부 제어로 바꾸는 것**이지,
탐지 로직을 바꾸는 게 아니다.

### 6.2 실제로 조심해야 할 부분

#### A. `managedUidWarningAutoBanSuspended`만 그대로 두고 의미를 바꾸면 코드가 헷갈린다

예:

- 이름은 `Suspended`
- 실제 의미는 `BanOnly`

이러면 이후 유지보수에서 틀리기 쉽다.

그래서 새 boolean을 따로 두는 게 맞다.

#### B. background stop 분기를 안 바꾸면 패치가 반쪽이다

monitor만 고치고 background를 안 고치면:

- 공격 중엔 ban-only처럼 보여도
- service worker 재기동 후 stop될 수 있다.

이건 실제 운영에서 바로 터질 수 있는 연결 문제다.

#### C. 복원값을 `true` 고정으로 올리면 안 된다

반드시 `config.delChk`를 기준으로 원복해야 한다.

#### D. popup 문구를 안 고치면 동작은 맞아도 설명이 틀린다

예:

- 실제:
  - `monitor_attack` ban-only
- popup:
  - `삭제 한도 보호 상태`

이건 운영자가 원인을 잘못 읽게 만든다.

그래서 이유 구분 없이 `runtimeDeleteEnabled`만 보는 설계는 여기서 한 번 정리하는 게 맞다.

#### E. 공격 종료 시점에 uid scheduler가 이미 꺼져 있어도 오류로 만들 필요는 없다

예:

- 사용자가 monitor stop 직전 상태 꼬임
- service worker 재기동 복원 중 예외

이 경우에도 restore는 조용히 빠져야 한다.

이번 패치는 “원복 실패로 전체 공격 복구 흐름을 깨지 않는 것”이 중요하다.

#### F. 이미 시작된 uid autoban 1회 제재는 기존 delete 모드로 끝날 수 있다

이건 위 1.7에서 본 것처럼 구조상 남는 잔존 한계다.

즉 기대값은:

- 공격 감지 직후 즉시 모든 in-flight 삭제 중단

이 아니라

- **다음 ban 실행부터 ban-only 강제**

다.

이번 패치는 이 동작을 문서와 로그로 명확히 해두는 게 맞다.

## 7. 정적 검증 체크리스트

패치 후 아래를 반드시 본다.

### 7.1 상태 흐름 검증

1. monitor NORMAL -> ATTACKING 진입 시 uid autoban이 stop되지 않는가
2. ATTACKING 진입 직후 uid autoban `isRunning === true` 유지되는가
3. ATTACKING 진입 직후 `runtimeDeleteEnabled === false`가 되는가
4. RECOVERING/NORMAL 복귀 시 `runtimeDeleteEnabled === config.delChk`로 돌아오는가
5. monitor 수동 stop 시에도 같은 복원이 되는가
6. popup에 ban-only 이유가 `monitor_attack`으로 정확히 보이는가

### 7.2 예외/엣지케이스 검증

1. uid autoban이 원래 꺼져 있으면 건드리지 않는가
2. 원래부터 `delChk = false`면 restore가 불필요하게 true로 안 올라가는가
3. delete limit ban-only 상태에서 공격 종료 후 true로 잘못 안 올라가는가
4. service worker 복원 시 monitor ATTACKING이면 stop 대신 ban-only 유지되는가
5. reset stats / reset state에서 새 flag가 남지 않는가
6. attack 진입 직전 시작된 uid autoban 1회는 기존 delete mode로 끝날 수 있음을 로그/문서상 이해 가능한가

### 7.3 UI 검증

1. 공격 중 uid autoban 상태가 `차단만 유지`로 보이는가
2. 공격 중 meta 문구가 삭제 한도 보호가 아니라 monitor 공격 이유로 보이는가
3. 공격 종료 후 다시 `차단 + 삭제`로 보이는가
4. manual lock 메시지는 그대로 유지되는가

## 8. 결론

이번 건은 문서화 기준으로 구현 난도가 낮다.

핵심은 딱 세 가지다.

1. monitor가 uid autoban을 끄지 말고 `runtimeDeleteEnabled`만 내리기
2. background 복원 시 stop 충돌 로직을 ban-only 보정으로 바꾸기
3. popup/status가 ban-only 이유를 정확히 설명하게 만들기

즉 구조를 갈아엎는 패치가 아니라,
기존 `uid-warning-autoban`의 ban-only 런타임 기능을
`monitor`가 공격 상태에서 재사용하도록 연결하는 패치다.

현재 코드 기준으로 더 큰 구조 이슈는 보이지 않는다.  
실제 패치는 이 문서대로 바로 진행 가능하다.
