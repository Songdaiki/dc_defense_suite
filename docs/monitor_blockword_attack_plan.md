# Monitor Blockword Attack Plan

## 목적

자동 감시(`features/monitor`)가 공격을 감지하면 갤 관리 페이지의 `blockword`를 임시로 공격 대응용 금지단어 목록으로 교체하고, 공격이 끝나면 공격 시작 시점에 저장해 둔 기존 값으로 복구한다.

이번 계획은 아래 조건으로 고정한다.

- 공격 감지 즉시 적용
- 기존 `blockword` / `use_blockword` 값을 스냅샷으로 저장
- 공격용 목록은 [banned_words.md](/home/eorb915/projects/dc_defense_suite/docs/banned_words.md) 사용
- 쉼표 포함 총 길이 `9900`자 이하로 잘라서 저장
- `auto_blockword`는 사용하지 않음
- 공격 종료 시 스냅샷 값으로 원복

## 실제로 확인한 사실

### 1. 현재 금지단어 값은 관리 페이지 HTML에서 읽을 수 있다

관리 페이지:

- `https://gall.dcinside.com/mgallery/management/gallery?id=<galleryId>`

실제로 읽히는 항목:

- `input[name="use_blockword"][value="Y"|"N"]`
- `textarea#blockword`
- `input[name="auto_use_blockword"][value="Y"|"N"]`
- `textarea#auto_blockword`

실제 확인 결과:

- `blockword`는 해시값이 아니라 평문 텍스트 그대로 들어 있다
- `use_blockword` 현재 값도 HTML에서 바로 읽힌다
- `auto_blockword`는 별도 textarea로 존재한다

즉 공격 시작 시 스냅샷은 관리 페이지 HTML GET만으로 가능하다.

### 2. 저장 API는 확보됐다

저장 경로:

- `POST https://gall.dcinside.com/ajax/managements_ajax/update_blockword`

확인된 필드:

- `ci_t`
- `gallery_id`
- `_GALLTYPE_`
- `use_blockword`
- `blockword`
- `auto_use_blockword`
- `auto_blockword`

성공 기준:

- JSON 응답의 `result === "success"`

### 3. `auto_blockword`는 이번 구현에서 쓰지 않는다

이유:

- 운영상 실제 사용 가능한 길이가 너무 짧다
- 이번 목표는 공격용 한자 금지단어를 대량으로 넣는 것이므로 `blockword`를 임시 덮어쓰는 방식이 맞다

### 4. 공격 시작/종료 훅은 이미 있다

공격 시작:

- [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L266)

공격 종료:

- [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L420)

즉 `enterAttackMode()`에서 적용하고 `enterRecoveringMode()`에서 복구하면 된다.

### 5. monitor 상태는 이미 저장/복원 구조가 있다

저장:

- [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L499)

복원:

- [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L620)

background 재시작 복원:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L105)
- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L131)

즉 스냅샷 상태를 monitor scheduler state에 넣어 두면 service worker 재시작 후에도 복구 가능하다.

### 6. 확장 권한도 이미 갖춰져 있다

manifest:

- [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json#L1)

이미 있는 권한:

- `cookies`
- `host_permissions: https://gall.dcinside.com/*`

즉 새 기능을 위해 추가 host permission을 더 붙일 필요는 없다.

### 7. 기존 API 코드 패턴을 그대로 재사용할 수 있다

기존 API 모듈은 이미 아래 패턴을 쓰고 있다.

- `fetch(..., { credentials: 'include' })`
- `chrome.cookies.get({ name: 'ci_c' })`로 `ci_t` 확보

관련 코드:

- [post/api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L35)
- [post/api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L404)
- [ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L15)
- [ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L91)

즉 금지단어 API도 같은 패턴으로 구현하는 게 맞다.

## 최종 플로우

### 공격 감지 직후

1. `enterAttackMode()` 진입
2. monitor runtime 상태 저장
3. `ensureManagedDefensesStarted()` 먼저 실행
4. 그 다음 관리 페이지 `management/gallery?id=<galleryId>` GET
5. 현재 아래 값을 읽어서 스냅샷 저장
   - `use_blockword`
   - `blockword`
   - `auto_use_blockword`
   - `auto_blockword`
6. [banned_words.md](/home/eorb915/projects/dc_defense_suite/docs/banned_words.md) 내용을 읽음
7. 쉼표 포함 총 길이가 `9900`자를 넘지 않도록 잘라서 공격용 `blockword` 문자열 생성
8. `update_blockword` 호출
   - `use_blockword=Y`
   - `blockword=<공격용 목록>`
   - `auto_use_blockword` / `auto_blockword`는 스냅샷 값 그대로 전달
9. 성공하면 이번 공격 세션에 `blockword`가 적용되었다고 상태 기록

중요:

- 금지단어 적용은 공격 대응 보조 기능이다
- `post/ip` child 시작보다 앞에서 오래 붙잡고 있으면 안 된다
- 즉 **공격 감지 즉시 적용**은 맞지만, 구현 순서는 **방어 child 시작을 먼저 보장**하는 쪽이 안전하다

### 공격 종료 직후

1. `enterRecoveringMode()` 진입
2. 기존 `stopManagedDefenses()` 먼저 실행
3. 공격 세션에 `blockword` 적용 성공 기록이 있으면 복구 시도
4. 공격 시작 시 스냅샷으로 저장해 둔 값으로 `update_blockword` 재호출
   - `use_blockword=<snapshot.useBlockword>`
   - `blockword=<snapshot.blockword>`
   - `auto_use_blockword=<snapshot.autoUseBlockword>`
   - `auto_blockword=<snapshot.autoBlockword>`
5. 성공 시 스냅샷 상태 제거
6. 이후 기존 monitor 종료 플로우 계속 진행

중요:

- 공격 종료 시에도 금지단어 복구가 `post/ip` child 정지를 오래 지연시키면 안 된다
- 따라서 자동 종료 경로는 **child 정지 후 복구**가 더 안전하다

## `banned_words.md` 처리 규칙

원본 파일:

- [banned_words.md](/home/eorb915/projects/dc_defense_suite/docs/banned_words.md)

처리 규칙:

- 파일은 쉼표로 구분된 평문 목록으로 취급
- 항목 순서는 파일 순서를 유지
- 빈 항목 제거
- 앞뒤 공백 제거
- 중복 항목 제거
- 최종 문자열은 `항목,항목,항목` 형태
- 공백 없는 쉼표 구분 유지
- 총 길이 `9900`자를 넘기면 뒤에서 잘라낸다

길이 계산 규칙:

- 항목 문자 수 + 쉼표 수를 실제 저장 길이로 계산
- 마지막 항목 뒤에는 쉼표를 붙이지 않는다
- JS 문자열 `length` 기준으로 계산한다

주의:

- 일부 CJK 확장 문자는 사람이 보기엔 1글자여도 JS `length`에서는 2로 셀 수 있다
- 따라서 `9900` 제한 검사는 `Array.from().length`가 아니라 **최종 payload 문자열의 실제 `string.length`** 기준으로 해야 한다

현재 [banned_words.md](/home/eorb915/projects/dc_defense_suite/docs/banned_words.md) 기준 참고값:

- 전체 항목 수 `5433`
- `string.length <= 9900` 기준 실제 포함 가능 항목 수 `4950`
- 실제 길이 `9899`

## monitor에 추가할 상태

`features/monitor/scheduler.js` runtime + 저장 상태에 아래 필드를 추가한다.

- `managedBlockwordApplied`
- `managedBlockwordSnapshot`
- `managedBlockwordApplyPending`
- `managedBlockwordAppliedAt`
- `managedBlockwordErrorMessage`

`managedBlockwordSnapshot` 구조:

- `useBlockword`
- `blockword`
- `autoUseBlockword`
- `autoBlockword`

초기값:

- `managedBlockwordApplied = false`
- `managedBlockwordSnapshot = null`
- `managedBlockwordApplyPending = false`
- `managedBlockwordAppliedAt = ''`
- `managedBlockwordErrorMessage = ''`

추가 권장 상태:

- `managedBlockwordRestorePending`

의미:

- 원복 실패 후 아직 복구가 안 끝난 상태

초기값:

- `managedBlockwordRestorePending = false`

## 스냅샷 저장 방식

이 스냅샷은 메모리에만 두면 안 된다.

이유:

- service worker 재시작 시 메모리 상태는 사라질 수 있다
- 사용자가 감시를 수동으로 `중지`할 수 있다
- 브라우저/확장 새로고침 중에도 원복 정보가 유지되어야 한다

따라서 구현 규칙은 아래처럼 고정한다.

### 1. 스냅샷을 읽자마자 즉시 저장

공격 시작 직후 관리 페이지에서 현재 값을 읽은 다음,

- `managedBlockwordSnapshot`
- `managedBlockwordApplied = false`

를 먼저 monitor state에 넣고 `saveState()`를 바로 호출한다.

즉 순서는 아래처럼 간다.

1. 관리 페이지 GET
2. 현재 `blockword` / `use_blockword` 읽기
3. `managedBlockwordSnapshot` 설정
4. `saveState()` 즉시 호출
5. 그 다음 `update_blockword` 호출

이렇게 해야 적용 요청 도중 service worker가 재시작돼도 원복용 스냅샷은 남는다.

### 2. 적용 성공 후 다시 저장

`update_blockword` 성공 후에는

- `managedBlockwordApplied = true`
- `managedBlockwordApplyPending = false`
- `managedBlockwordRestorePending = false`
- `managedBlockwordAppliedAt`
- `managedBlockwordErrorMessage = ''`

로 갱신하고 다시 `saveState()`를 호출한다.

### 3. 스냅샷은 복구 성공 전까지 지우지 않음

공격 종료나 수동 정지 시에도 먼저 원복을 시도하고, 원복 성공 후에만 아래를 지운다.

- `managedBlockwordSnapshot`
- `managedBlockwordApplied`
- `managedBlockwordApplyPending`
- `managedBlockwordRestorePending`
- `managedBlockwordAppliedAt`
- `managedBlockwordErrorMessage`

즉 "먼저 clearAttackSession()" 하면 안 된다.

## 수동 정지 시 플로우

사용자가 자동 감시를 수동으로 꺼도 스냅샷이 날아가면 안 된다.

따라서 `monitor.stop()` 구현 순서는 아래처럼 가야 한다.

1. `managedBlockwordApplied === true` 이고 `managedBlockwordSnapshot`이 있으면 원복 시도
2. 원복 성공 시 blockword 관련 상태 제거
3. 그 다음 기존 `stopManagedDefenses()`
4. 그 다음 `clearAttackSession()`
5. 마지막에 `saveState()`

즉 수동 정지도 "그냥 멈춤"이 아니라 "원복 후 정지"여야 한다.

추가 규칙:

- 원복 실패 시 monitor는 정지하더라도 `managedBlockwordSnapshot`은 남겨 둔다
- 즉 "감시는 꺼졌지만 원복 대기 중" 상태가 가능해야 한다

### 적용/원복 동시 실행 금지

`blockword` 적용과 원복은 서로 겹치면 안 된다.

위험한 경우:

1. 공격 시작 직후 `update_blockword(공격용 목록)` 요청이 아직 안 끝남
2. 사용자가 바로 감시를 `중지`
3. `중지` 경로가 스냅샷으로 원복 요청을 먼저 보냄
4. 그런데 늦게 끝난 공격 적용 요청이 다시 공격용 `blockword`를 덮어씀

이러면 사용자는 "정지했고 원복도 눌렀는데 금지단어가 다시 공격용으로 바뀌는" 상태를 보게 된다.

따라서 구현 규칙은 아래처럼 고정한다.

- 적용/원복/수동 원복은 공용 직렬화 경로 하나로만 실행한다
- 동시에 두 요청을 보내지 않는다
- `monitor.stop()` / `enterRecoveringMode()` / 수동 원복 버튼은 진행 중인 금지단어 작업이 있으면 먼저 그 작업 종료를 기다린다

권장 runtime 필드:

- `managedBlockwordTask`

이 값은 저장 상태가 아니라 runtime 전용 promise다.

즉 "원격 저장 요청은 항상 한 번에 하나"만 가게 만들어야 한다.

## 수동 원복 버튼

자동 원복이 있어도 수동 원복 버튼은 따로 있어야 한다.

이유:

- 자동 원복 실패 시 운영자가 직접 복구할 수 있어야 한다
- 감시를 이미 껐는데 금지단어가 아직 공격용 목록으로 남아 있을 수 있다
- service worker 재시작, 로그인 만료, 네트워크 오류 같은 예외 상황에서 비상구가 필요하다

### UI 위치

`게시물 자동화` 패널에 버튼 1개를 추가한다.

예시 라벨:

- `금지단어 원복`

권장 위치:

- [popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L701)

즉 monitor 설정 저장 버튼 / 통계 초기화 버튼 근처에 둔다.

### 버튼 동작

버튼을 누르면 아래 순서로 동작한다.

1. monitor state에서 `managedBlockwordSnapshot` 확인
2. 스냅샷이 없으면 아무 것도 안 하고 안내 메시지 표시
3. 스냅샷이 있으면 `update_blockword`로 원복 시도
4. 성공 시
   - `managedBlockwordApplied = false`
   - `managedBlockwordSnapshot = null`
   - `managedBlockwordApplyPending = false`
   - `managedBlockwordRestorePending = false`
   - `managedBlockwordAppliedAt = ''`
   - `managedBlockwordErrorMessage = ''`
   - `saveState()`
5. monitor 자체는 켜져 있든 꺼져 있든 건드리지 않음

즉 이 버튼은 "감시 토글"이 아니라 "금지단어만 복구" 버튼이다.

### 버튼 활성 조건

버튼은 아래 조건에서만 활성화한다.

- `managedBlockwordApplied === true`
  또는
- `managedBlockwordSnapshot != null`

그 외에는 비활성화한다.

쉽게 말하면:

- 원복할 스냅샷이 있을 때만 누를 수 있게 한다

### background action

새 액션 예시:

- `feature: 'monitor'`
- `action: 'restoreManagedBlockword'`

처리 위치:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L183)

즉 popup 버튼은 background message를 보내고, 실제 원복은 monitor scheduler가 가진 스냅샷으로 수행한다.

추가 UI 상태 노출 권장:

- `금지단어 적용됨`
- `금지단어 원복 대기`
- `마지막 금지단어 오류`

이유:

- 버튼이 왜 활성화됐는지 사용자가 한눈에 알아야 한다
- 원복 실패 후 현재 상태를 popup에서 바로 확인할 수 있어야 한다

## 재시작 복원 시 플로우

ATTACKING 중 service worker가 재시작되면:

- `loadState()`가 `managedBlockwordSnapshot`과 `managedBlockwordApplied`를 복원
- 공격이 계속 중이면 재적용하지 않음
- 공격 종료 또는 수동 정지 시 그 스냅샷으로 원복

즉 스냅샷 저장 위치는 `chrome.storage.local`에 저장되는 monitor scheduler state다.

추가 규칙:

- ATTACKING 중 재시작 후 이미 `managedBlockwordApplied === true`면 다시 스냅샷을 덮어쓰면 안 된다
- 즉 **다음 공격 시작처럼 새로 snapshot/apply를 다시 타면 안 된다**

### 적용 도중 재시작된 경우

더 위험한 경우가 하나 더 있다.

1. 공격 시작
2. 관리 페이지에서 현재 `blockword`를 읽음
3. `managedBlockwordSnapshot` 저장까지는 성공
4. 그런데 공격용 `update_blockword` 요청이 끝나기 전에 service worker 재시작

이때 복원된 상태는 보통 아래처럼 보인다.

- `managedBlockwordSnapshot != null`
- `managedBlockwordApplied === false`
- `managedBlockwordApplyPending === true`

이 상태를 그냥 실패로 취급하면 안 된다.

이유:

- 실제 원격 저장은 성공했을 수도 있고
- 반대로 아직 적용이 안 됐을 수도 있다

따라서 재시작 복원 규칙은 아래처럼 고정한다.

- `managedBlockwordApplyPending === true`면 새 스냅샷 생성 금지
- 기존 스냅샷을 그대로 유지
- 공격 세션이 아직 살아 있으면 기존 스냅샷으로 **적용 1회 재확인/재시도**
- 이 재시도도 공용 직렬화 경로를 사용

즉 "snapshot은 이미 있으니 다시 읽지 말고, apply만 이어서 처리"가 맞다.

## 구현 포인트

### 1. 공격 세션당 1번만 적용

공격 중 매 poll마다 다시 `blockword`를 덮어쓰면 안 된다.

조건:

- `managedBlockwordApplied === false`일 때만 적용 시도

추가 조건:

- `managedBlockwordSnapshot == null`일 때만 새 스냅샷 생성
- `managedBlockwordApplyPending === false`일 때만 새 apply 시작

이유:

- 이전 공격 복구가 안 끝난 상태에서 새 공격이 오면 원본 스냅샷이 덮어써질 수 있다
- 적용 중인 요청과 새 apply가 겹치면 원격 상태가 꼬일 수 있다

### 2. 복구는 스냅샷이 있을 때만

스냅샷이 없는데 빈 값으로 복구하면 기존 설정을 날릴 수 있다.

조건:

- `managedBlockwordSnapshot`이 있을 때만 복구 시도

### 3. 적용 실패가 나도 공격 자체는 계속

금지단어 주입은 보조 방어다.

즉:

- `blockword` 적용 실패
- `post/ip` 방어는 계속 진행

### 4. 복구 실패도 로그에 남기고 monitor는 종료

원복 실패가 monitor 종료 자체를 막으면 더 위험하다.

즉:

- 복구 실패 로그 남김
- monitor 종료 플로우는 계속 진행

추가 규칙:

- 복구 실패 시 `managedBlockwordRestorePending = true`로 남긴다
- 수동 원복 버튼이 이 상태를 보고 동작해야 한다

### 5. 재시작 복원 시 상태만 보고 중복 적용 금지

service worker가 ATTACKING 중 재시작될 수 있다.

이때:

- 스냅샷이 이미 있고
- `managedBlockwordApplied === true`

이면 다시 적용하지 않는다.

추가 규칙:

- 스냅샷이 있고 `managedBlockwordApplyPending === true`면 "미완료 적용"으로 취급한다
- 이 경우에는 새 스냅샷을 만들지 말고 기존 스냅샷으로 apply 재확인/재시도만 한다

즉 blockword 적용 helper는 `enterAttackMode()` 전용으로 끝내면 안 된다.

권장 구조:

- `enterAttackMode()`에서 공용 helper 호출
- `ensureManagedDefensesStarted()` 또는 재시작 복원 경로에서도 같은 helper 호출

그래야 ATTACKING 중 재시작 후에도 "snapshot은 유지하고 apply만 이어서 처리"가 가능하다

### 6. restore pending 상태에서 새 공격이 와도 blockword 상태는 건드리지 않음

restore 실패 후 monitor가 계속 살아 있으면, 다음 공격이 다시 올 수 있다.

이때 아래처럼 동작하면 안 된다.

- 이전 snapshot이 남아 있는데 새 snapshot 생성
- restore pending 상태인데 공격용 apply를 다시 시작

이러면 원복 기준점이 더 망가지거나, 사용자가 수동 원복해야 할 값을 잃어버릴 수 있다.

따라서 규칙은 아래처럼 고정한다.

- `managedBlockwordRestorePending === true`면 새 공격이 와도 blockword helper는 **아무 것도 바꾸지 않는다**
- monitor의 post/ip child 방어는 계속 진행
- popup과 로그에는 "금지단어 원복 대기 중이라 자동 재적용 생략" 같은 상태를 남긴다

즉 restore pending은 "blockword 쪽은 사람 개입이 먼저 필요한 상태"로 취급한다.

### 7. keepAlive / resume 반복 호출에도 idempotent 해야 함

현재 background는 아래 경로로 monitor 복원을 여러 번 시도할 수 있다.

- `onInstalled`
- `activate`
- `onStartup`
- `alarms.keepAlive`

관련 실제 위치:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L34)
- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L39)
- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L44)
- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L49)
- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L84)

즉 ATTACKING 중에는 `ensureManagedDefensesStarted()`가 여러 번 다시 불릴 수 있다.

따라서 blockword helper는 반드시 아래를 만족해야 한다.

- 이미 `managedBlockwordApplied === true`면 재적용 안 함
- `managedBlockwordApplyPending === true`면 새 apply 시작 안 함
- `managedBlockwordRestorePending === true`면 새 apply 시작 안 함

즉 "반복 호출돼도 상태 변화가 한 번만 일어나는 helper"여야 한다.

## background 리셋/초기화 경로 반영

### 1. 일반 `resetStats` 액션

`resetStats`는 통계/로그용이므로 blockword snapshot 상태를 지우면 안 된다.

즉 아래 값은 **유지**하는 쪽이 맞다.

- `managedBlockwordApplied`
- `managedBlockwordSnapshot`
- `managedBlockwordApplyPending`
- `managedBlockwordRestorePending`
- `managedBlockwordAppliedAt`
- `managedBlockwordErrorMessage`

관련 위치:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L355)
- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L724)

주의:

- **복구 대기 중에는 resetStats로 이 상태를 지우면 안 된다**
- 그렇지 않으면 수동 원복 버튼으로도 복구할 수 없게 된다

따라서 아래 중 하나로 고정해야 한다.

1. `managedBlockwordSnapshot`이 있으면 `resetStats`를 막는다
2. 아니면 `resetStats`가 blockword 스냅샷 상태는 건드리지 않는다

권장:

- `resetStats`는 blockword 스냅샷 상태를 건드리지 않는다

### 2. gallery 변경 / 진짜 초기화 경로

`galleryId` 변경처럼 실질적으로 monitor 상태를 다시 짜야 하는 경로는 다르게 봐야 한다.

관련 위치:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L380)

이 경우에는 아래 규칙이 필요하다.

- `managedBlockwordSnapshot`이 남아 있으면 gallery 변경을 막는다
- 먼저 수동 원복 또는 자동 원복 완료 후에만 gallery 변경 허용

즉 "리셋"과 "갤러리 전환"은 같은 취급을 하면 안 된다

## 예상 tradeoff

### 1. 공격 중 수동 관리 변경 충돌

공격 도중 관리 페이지에서 사람이 직접 `blockword`를 수정하면, 공격 종료 시 스냅샷 원복이 그 값을 덮어쓸 수 있다.

이번 계획에서는 이 동작을 허용한다.

이유:

- 스펙상 "공격 시작 시점 스냅샷으로 복구"가 우선
- 구현을 단순하게 유지해야 함

### 2. 기존 금지단어는 공격 중 임시로 치워진다

이번 방식은 기존 `blockword`에 공격용 목록을 덮어쓴다.

즉 공격 중에는 기존 금지단어가 비활성화될 수 있다.

이번 계획에서는 이 동작을 허용한다.

이유:

- `10000`자 제한 때문에 병합보다 임시 덮어쓰기가 안정적
- 종료 후 원복으로 회복 가능

### 3. 적용/복구 실패 가능성

로그인 만료, `ci_t` 불일치, 관리 페이지 구조 변경 시 실패할 수 있다.

그래도:

- 공격 자동 감시 본체는 계속 돌아가야 한다
- 금지단어 주입은 보조 기능으로 취급한다

### 4. 새로운 공격 시작 시 스냅샷 덮어쓰기 위험

이전 공격 원복이 안 끝난 상태에서 새 공격이 오면, 새 스냅샷을 만들 때 원래 값이 아니라 공격용 `blockword`를 다시 읽게 될 수 있다.

그러면 원복 기준점이 망가진다.

대응 규칙:

- `managedBlockwordSnapshot`이 남아 있으면 새 스냅샷 생성 금지
- 이미 `managedBlockwordApplied === true`면 그대로 유지하고 재적용만 생략

### 5. 시작 시 스냅샷 대기 상태면 감시 시작 자체를 막아야 할 수 있음

감시가 완전히 꺼진 상태인데 `managedBlockwordSnapshot`만 남아 있으면, 사용자는 아직 복구를 안 한 상태일 수 있다.

이때 새 감시 시작으로 snapshot 상태를 초기화하면 위험하다.

권장 규칙:

- `managedBlockwordSnapshot != null` 이고 `managedBlockwordApplied === false`인데 복구 대기 중이면
- 감시 시작 전에 먼저 수동 원복 또는 명시적 폐기 선택이 필요하다

최소한 문구 안내라도 필요하다

### 6. 공통 설정 변경과 충돌 가능성

공유 설정의 `galleryId`를 바꾸면 monitor reset 경로가 실행될 수 있다.

그 상태에서 복구 대기 중 snapshot을 지우면 원복 불가능해진다.

대응 규칙:

- `managedBlockwordSnapshot`이 남아 있으면 gallery 변경을 막거나
- 최소한 먼저 원복하라는 에러를 띄워야 한다

### 7. popup 상태 노출은 boolean 하나로 끝내면 안 됨

수동 원복 버튼과 상태 문구는 아래 경우를 구분해서 보여줘야 한다.

1. 스냅샷 없음
   - 아무 것도 안 한 상태
2. 스냅샷 있음 + `managedBlockwordApplyPending === true`
   - 적용 진행 중 또는 재시작 후 적용 재확인 필요
3. 스냅샷 있음 + `managedBlockwordApplied === true`
   - 공격용 금지단어 적용 완료
4. 스냅샷 있음 + `managedBlockwordRestorePending === true`
   - 원복 실패, 수동 원복 필요

즉 popup은 최소한 아래 값을 `getStatus()`로 받아야 한다.

- `managedBlockwordApplied`
- `managedBlockwordApplyPending`
- `managedBlockwordRestorePending`
- `managedBlockwordAppliedAt`
- `managedBlockwordErrorMessage`

## 구현 순서

1. `features/monitor`에 blockword snapshot/applied 상태 추가
2. 관리 페이지 HTML GET + snapshot parser 추가
3. `banned_words.md` 읽어서 9900자 문자열 만드는 helper 추가
4. `update_blockword` API helper 추가
5. `enterAttackMode()`에서 1회 적용 연결
6. `enterRecoveringMode()`에서 원복 연결
7. `saveState/loadState/getStatus/reset` 경로 반영
8. `start/stop/resetStats/updateSharedConfig` 충돌 가드 반영
9. popup 수동 원복 버튼 + 상태 표시 추가
10. background reset/resume 연동 검증

## 구현 완료 후 검증 항목

1. 공격 시작 시 현재 `blockword` 스냅샷 저장
2. 공격 시작 시 `blockword`가 공격용 목록으로 바뀜
3. 공격 중 추가 poll에서 재적용 안 함
4. 공격 종료 시 스냅샷 값으로 원복
5. ATTACKING 중 service worker 재시작 후 재적용 안 함
6. ATTACKING 중 service worker 재시작 후 종료 시 원복 가능
7. 적용 실패 시 monitor 본체는 계속 동작
8. 복구 실패 시 monitor 종료 자체는 계속 동작
9. 복구 실패 후 수동 원복 버튼으로 복구 가능
10. resetStats가 복구 대기 스냅샷을 날리지 않는지 검증
11. shared gallery 변경이 복구 대기 상태에서 막히는지 검증
12. 새 공격 시작 시 기존 snapshot을 덮어쓰지 않는지 검증
13. `banned_words.md` 길이 자르기 결과가 실제 `string.length <= 9900`인지 검증

## 정적 검증 체크리스트

아래는 구현 전에 문서 기준으로 반드시 다시 볼 체크리스트다.

### 공격 시작 경로

1. `enterAttackMode()`가 공격 세션 id를 만든 직후 blockword helper를 연결해도 child 시작 순서를 망치지 않는가
2. `ensureManagedDefensesStarted()`가 먼저 돌아도 blockword snapshot이 늦게 덮어써지지 않는가
3. 공격 시작 직후 `galleryId`는 `scheduler.config.galleryId`를 그대로 쓰는가
4. `thesingularity` 같은 하드코딩이 남지 않는가
5. 관리 페이지 GET 실패 시 attack 본체는 계속 도는가
6. 관리 페이지 HTML 구조가 바뀌어 snapshot parser가 실패해도 post/ip child는 계속 도는가
7. `use_blockword=N` 상태에서 공격 적용 시 `Y`로 강제 적용되는가
8. `blockword`가 원래 비어 있어도 snapshot 값이 정상 저장되는가
9. `banned_words.md`가 비어 있거나 읽기 실패하면 apply를 건너뛰고 monitor는 계속 도는가
10. `banned_words.md` dedupe 결과가 0개일 때 빈 `blockword`를 밀어넣지 않도록 막는가

### 스냅샷 저장

11. snapshot 읽자마자 `saveState()`가 먼저 호출되는가
12. snapshot 저장 전에는 `managedBlockwordApplied=true`가 되지 않는가
13. snapshot 저장 성공 후 service worker가 재시작돼도 원복용 값이 남는가
14. snapshot 구조에 `useBlockword`, `blockword`, `autoUseBlockword`, `autoBlockword`가 모두 들어가는가
15. `auto_*` 값은 건드리지 않고 snapshot 보존만 하는가

### apply 요청

16. `update_blockword` payload가 `ci_t`, `gallery_id`, `_GALLTYPE_`, `use_blockword`, `blockword`, `auto_use_blockword`, `auto_blockword`를 모두 포함하는가
17. `ci_t`는 기존처럼 `ci_c` 쿠키에서 읽는가
18. 응답이 JSON이 아니거나 `result !== "success"`이면 apply 실패로 기록하는가
19. apply 성공 후에만 `managedBlockwordApplied=true`로 바꾸는가
20. apply 성공 후 `managedBlockwordApplyPending=false`로 내려가는가
21. apply 실패 후에도 snapshot은 지우지 않는가
22. apply 실패 후 공격 중 매 poll마다 계속 재시도하지 않도록 구분 상태가 있는가

### 동시 실행 / race

23. apply 도중 사용자가 `stop`을 눌러도 apply/restore가 동시에 날아가지 않는가
24. apply 도중 자동 종료가 와도 restore가 apply와 겹치지 않는가
25. 수동 원복 버튼을 눌러도 이미 진행 중인 apply/restore와 겹치지 않는가
26. 늦게 끝난 apply 응답이 stop 후 상태를 다시 공격용으로 되돌리지 않는가
27. 직렬화 promise/runtime lock이 stop, recover, manual restore 모두에서 공통으로 쓰이는가

### 자동 종료 / 수동 정지

28. `enterRecoveringMode()`는 child 정지 후 restore를 하는가
29. restore 성공 전에는 blockword 관련 snapshot 상태를 지우지 않는가
30. restore 실패 시 `managedBlockwordRestorePending=true`가 남는가
31. restore 실패 후 monitor는 종료되지만 수동 원복 버튼으로 다시 시도할 수 있는가
32. `stop()` 경로도 recover와 같은 restore 규칙을 공유하는가
33. 이미 monitor가 꺼진 상태에서 `stop()`을 또 눌러도 snapshot이 날아가지 않는가

### 재시작 복원

34. ATTACKING 중 재시작 후 `managedBlockwordApplied=true`면 재적용을 건너뛰는가
35. ATTACKING 중 재시작 후 `managedBlockwordApplyPending=true`면 새 snapshot을 만들지 않는가
36. ATTACKING 중 재시작 후 `managedBlockwordApplyPending=true`면 기존 snapshot으로 apply 재확인/재시도만 하는가
37. 재시작 복원 helper가 `enterAttackMode()` 전용이 아니라 `ensureManagedDefensesStarted()` 또는 resume 경로에서도 호출 가능한가
38. `managedBlockwordRestorePending=true` 상태에서 새 공격이 와도 blockword helper가 아무 것도 바꾸지 않는가
39. keepAlive / resume 반복 호출 중에도 apply가 한 번만 실행되는가

### background / reset / shared config

40. `resetStats`가 blockword snapshot 상태를 건드리지 않는가
41. `resetMonitorSchedulerState()` 경로에 snapshot 관련 상태를 실수로 같이 지우지 않도록 가드가 있는가
42. `updateSharedConfig`는 busy check 통과 후에도 snapshot pending 상태를 별도로 막는가
43. gallery 변경 시 snapshot이 남아 있으면 먼저 restore하라는 에러를 띄우는가
44. headtext 변경만 할 때는 blockword snapshot 상태를 건드리지 않는가

### popup / 상태 노출

45. monitor 패널에 수동 원복 버튼이 실제로 존재하는가
46. 버튼은 `managedBlockwordApplied` 또는 `managedBlockwordSnapshot` 존재 시에만 활성화되는가
47. popup은 `managedBlockwordApplyPending`, `managedBlockwordApplied`, `managedBlockwordRestorePending`, `managedBlockwordErrorMessage`를 모두 보여줄 수 있는가
48. monitor가 꺼져 있어도 restore pending이면 버튼이 계속 보이는가
49. `applyAutomationLocks()`가 monitor restore 버튼을 실수로 비활성화하지 않는가

### banned_words 처리

50. 원본 파일 순서를 유지하는가
51. 앞뒤 공백 제거 후 빈 항목은 버리는가
52. 중복 항목 제거 후 실제 payload는 `항목,항목,항목` 형태로 공백 없이 합쳐지는가
53. 마지막 항목 뒤에 쉼표를 붙이지 않는가
54. 길이 계산은 `string.length` 기준인가
55. `9900`자를 넘기기 직전까지만 잘리고 정확히 멈추는가
56. 잘린 뒤 실제 payload를 다시 확인했을 때 `length <= 9900`인가
