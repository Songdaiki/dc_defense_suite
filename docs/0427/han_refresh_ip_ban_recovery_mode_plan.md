# 도배기갱신차단자동 비상 복구모드 구현 문서

작성일: 2026-04-27

## 1. 결론

새 탭을 만들지 않고, 기존 `도배기갱신차단자동` 탭 안에 `비상 복구모드` 체크/접이식 섹션을 추가한다.

이유는 단순하다.

```txt
기존 도배기갱신차단자동
-> 관리내역 페이지를 읽음
-> IP형 유동 row를 고름
-> user_code_avoid API로 6시간 재차단

복구모드
-> 같은 관리내역 페이지를 읽음
-> 같은 IP형 유동 row를 고름
-> 같은 user_code_avoid API로 6시간 재차단
```

즉 데이터 출처, API, 설정, 로그가 모두 같다. 새 탭으로 빼면 같은 설정과 같은 로그를 한 번 더 복제해야 해서 오히려 연결 실수가 늘어난다.

다만 복구모드는 일반 자동갱신과 성격이 다르다.

```txt
일반 자동갱신:
  차단 중 row만 5시간마다 무한 갱신

비상 복구모드:
  차단 중 + 해제됨 row까지 포함해서 과거 차단 풀을 한 번 복구
```

그래서 같은 탭 안에 두되, 실행 경로는 분리한다.

권장 UI:

```txt
도배기갱신차단자동 탭
  ON/OFF 토글: 기존 일반 자동갱신
  설정: 기존 요청 딜레이, fallback 최대 페이지
  비상 복구모드 [ ] 체크
    목표 unique 제목 수: 1475
    복구 스캔
    복구 실행
    복구 통계
```

예시:

```txt
만약 현재 차단 1475건이 실수로 전부 풀렸다면:
1. 도배기갱신차단자동 탭으로 이동
2. 비상 복구모드 체크
3. 목표 unique 제목 수에 1475 입력
4. 복구 스캔
5. "unique 제목 1475건 발견" 확인
6. 복구 실행
```

## 2. 목표

비상 복구모드의 목표는 아래다.

```txt
관리내역에서
사유가 "도배기IP차단(무고한 경우 문의)"인
IP형 유동 row를
차단 중/해제됨 구분 없이 훑고
게시물 제목 원문 기준으로 중복 제거해서
목표 개수만큼 다시 6시간 차단한다.
```

핵심 조건:

- `해제됨` row도 포함한다.
- `차단 중` row도 포함한다.
- 사유는 `도배기IP차단(무고한 경우 문의)`만 본다.
- 작성자 토큰은 IP형 유동만 본다.
- UID/고닉 row는 제외한다.
- 게시글/댓글 row 둘 다 포함한다.
- 중복 제거 기준은 제목이다.
- 제목은 공격 정규화 없이 사용한다.
- 목표 개수는 사용자가 입력한다. 예: `1475`.
- 복구는 자동 무한 루프가 아니라 one-shot이다.

## 3. 현재 실제 코드 확인 결과

### 3.1 현재 탭 위치

파일:

```txt
popup/popup.html
```

현재 `도배기갱신차단자동` 탭은 이미 있다.

```txt
popup/popup.html:554
```

현재 UI 구조:

```txt
section[data-feature="hanRefreshIpBan"]
  feature-header
    제목: 도배기갱신차단자동
    ON/OFF 토글
  status-grid
  settings-section
    요청 딜레이
    fallback 최대 페이지
    설정 저장
  통계 초기화
  최근 로그
```

따라서 새 탭이 아니라 이 섹션 안에 복구모드 UI를 추가하면 된다.

### 3.2 현재 popup JS 연결

파일:

```txt
popup/popup.js
```

현재 DOM 매핑:

```txt
popup/popup.js:132
FEATURE_DOM.hanRefreshIpBan
```

현재 이벤트:

```txt
popup/popup.js:991
bindHanRefreshIpBanEvents()
```

현재 상태 반영:

```txt
popup/popup.js:3447
updateHanRefreshIpBanUI(status)
```

복구모드 UI를 추가하면 아래 세 군데를 같이 수정해야 한다.

```txt
1. FEATURE_DOM.hanRefreshIpBan에 복구모드 DOM 추가
2. bindHanRefreshIpBanEvents()에 복구 스캔/실행/초기화 이벤트 추가
3. updateHanRefreshIpBanUI()에 복구 상태 표시 추가
4. getHanRefreshIpBanStatusLabel()/getHanRefreshIpBanStatusClassName()에 recovery phase 반영
```

### 3.3 현재 background 메시지 연결

파일:

```txt
background/background.js
```

현재 `hanRefreshIpBan` 설정 저장은 여기서 normalize된다.

```txt
background/background.js:965
message.config = normalizeHanRefreshIpBanConfig(...)
```

현재 통계 초기화는 여기서 처리된다.

```txt
background/background.js:1496
feature === 'hanRefreshIpBan'
```

현재 별도 reset helper도 있다.

```txt
background/background.js:2508
resetHanRefreshIpBanSchedulerState()
```

복구모드 액션은 기존 `start`, `stop`, `updateConfig`, `resetStats`와 분리해서 추가한다.

추가할 action:

```txt
scanRecovery
executeRecovery
resetRecovery
```

### 3.4 현재 scheduler 동작

파일:

```txt
features/han-refresh-ip-ban/scheduler.js
```

현재 주요 흐름:

```txt
start()
-> run()
-> runCycle()
-> fetchDetectedMaxPageWithHtml()
-> scanPageRange()
-> processPage()
-> extractActionableManagementRows()
-> rebanManagementRows()
```

현재 `runCycle()`는 1페이지를 먼저 읽고, 그 시점의 최대 `data-num`을 baseline으로 잡는다.

```txt
features/han-refresh-ip-ban/scheduler.js:172
detectedMaxPage 설정

features/han-refresh-ip-ban/scheduler.js:173
currentCycleBaselineMaxBlockDataNum 설정
```

이 baseline은 중요하다.

예시:

```txt
사이클 시작 때 1페이지 최대 data-num = 5000
스캔하면서 재차단해서 새 row data-num = 5001이 생김
기존 자동갱신은 data-num 5001을 이번 사이클에서 다시 잡지 않음
```

이게 없으면 같은 사이클 안에서 새로 만든 차단 row를 다시 따라가면서 페이지가 계속 밀릴 수 있다.

### 3.5 현재 parser 동작

파일:

```txt
features/han-refresh-ip-ban/parser.js
features/ip/parser.js
```

현재 관리내역 row 파싱은 공용 함수가 한다.

```txt
features/ip/parser.js:61
parseBlockListRows(html)
```

현재 row 구조:

```js
{
  postNo,
  title,
  blockDataNum,
  reason,
  duration,
  stateText,
  releaseId,
  writerToken,
  writerDisplay,
  isActive,
  rowHtml
}
```

`isActive`는 `set_avoid(..., 'R', ...)` 해제 버튼이 있으면 true다.

```txt
차단 중 row -> releaseId 있음 -> isActive true
해제됨 row -> releaseId 없음 -> isActive false
```

현재 자동갱신 대상 추출 함수:

```txt
features/han-refresh-ip-ban/parser.js:69
extractActionableManagementRows(html, options)
```

현재 필터 순서:

```txt
1. 게시글/댓글 row인지 확인
2. row.isActive true인지 확인
3. IP형 유동인지 확인
4. 제목 한자 2글자 이상 또는 사유에 "도배" 포함인지 확인
5. baseline data-num보다 새 row인지 확인
6. avoidNo 중복 제거
```

즉 현재 자동갱신은 일부러 `해제됨`을 제외한다.

복구모드에서 기존 함수를 그대로 바꾸면 위험하다. 일반 자동갱신까지 `해제됨`을 다시 잡아버릴 수 있기 때문이다.

그래서 복구모드는 별도 함수로 분리해야 한다.

### 3.6 현재 재차단 API

파일:

```txt
features/han-refresh-ip-ban/api.js
```

현재 API helper:

```txt
features/han-refresh-ip-ban/api.js:110
rebanManagementRows(config, avoidNos, refererPage)
```

실제 POST:

```txt
POST /ajax/managements_ajax/user_code_avoid
```

body:

```txt
ci_t
gallery_id
_GALLTYPE_
avoid_hour
avoid_reason
avoid_reason_txt
nos[]
```

현재 사유 기본값:

```txt
도배기IP차단(무고한 경우 문의)
```

복구모드도 이 API를 그대로 사용하면 된다. 별도 차단 API를 만들 필요 없다.

### 3.7 추가 교차검증에서 발견한 구현 주의점

문서 작성 후 실제 연결부를 다시 대조하면서 아래 항목을 추가로 확인했다. 이 항목들은 패치 때 반드시 같이 반영해야 한다.

#### 3.7.1 `btn-danger` 클래스는 현재 없다

현재 CSS에는 아래 버튼 class만 확인된다.

```txt
.btn
.btn-primary
.btn-secondary
.btn-warning
```

따라서 복구 실행 버튼을 `btn btn-danger`로 만들면 스타일이 적용되지 않는다.

수정 기준:

```html
<button id="hanRefreshIpBanRecoveryExecuteBtn" class="btn btn-warning recovery-danger-btn">복구 실행</button>
```

그리고 `popup/popup.css`에 아래처럼 별도 보강 class를 추가한다.

```css
.recovery-danger-btn {
  border-color: rgba(255, 123, 133, 0.45);
  color: #ffe1e4;
}
```

#### 3.7.2 `getFeatureConfigInputs('hanRefreshIpBan')`도 수정해야 한다

현재 popup dirty tracking은 `getFeatureConfigInputs(feature)`가 반환하는 input에만 걸린다.

현재 `hanRefreshIpBan`은 아래 2개만 반환한다.

```txt
requestDelayInput
fallbackMaxPageInput
```

복구모드 target input을 추가하면 아래도 포함해야 한다.

```txt
recoveryModeEnabledInput
recoveryTargetUniqueTitleCountInput
```

그렇지 않으면 사용자가 복구 목표 수를 바꿔도 dirty 상태가 제대로 잡히지 않을 수 있다.

#### 3.7.3 target count 변경 시 기존 스캔 후보는 무효화해야 한다

예시:

```txt
1. 목표 1475로 복구 스캔
2. 후보 1475건 READY
3. 사용자가 목표를 1200으로 바꿈
4. 그대로 복구 실행
```

이 경우 UI에는 1200이라고 보이는데 내부 후보는 1475 기준일 수 있다. 반대로 1475에서 2000으로 바꿨는데 옛 후보로 실행될 수도 있다.

수정 기준:

```txt
recoveryTargetUniqueTitleCount 변경
-> recovery.candidates 비움
-> recovery.phase = IDLE
-> recovery 통계 초기화
```

`recoveryModeEnabled`가 OFF로 바뀔 때도 안전하게 후보를 지운다. 다시 ON으로 바꾸면 빈 상태에서 새로 스캔하게 한다.

#### 3.7.4 `resetStats` 동작을 명확히 해야 한다

현재 `resetStats`는 `resetSchedulerStats()`에서 기능별 통계를 직접 지운다. `hanRefreshIpBan`에는 아직 recovery state가 없다.

패치 후 기준:

```txt
통계 초기화:
  일반 자동갱신 통계/로그 초기화
  recovery transient state 초기화
  recovery config 값은 유지

복구 초기화:
  recovery transient state만 초기화
  일반 자동갱신 통계는 유지
```

여기서 `transient state`는 아래다.

```txt
phase
currentPage
detectedMaxPage
scannedRows
candidateRows
uniqueTitleCount
duplicateTitleCount
activeRowCount
inactiveRowCount
successCount
failureCount
lastScanAt
lastRunAt
candidates
```

`recoveryModeEnabled`, `recoveryTargetUniqueTitleCount`는 config라서 초기화하지 않는다.

#### 3.7.5 `parseBlockListRows()`의 href 파싱도 구현 전 확인해야 한다

현재 공용 관리내역 parser는 제목 링크에서 게시물 번호를 이렇게 뽑는다.

```js
href=".../12345"
```

즉 `/(\d+)` 형태가 있어야 한다.

만약 실제 관리내역 링크가 아래처럼 query만 쓰는 형태면 파싱이 실패한다.

```txt
/board/view/?id=xxx&no=12345
```

현재 기능이 실사용에서 동작하고 있으므로 실제 관리내역은 대체로 기존 정규식에 맞는 것으로 보인다. 그래도 복구모드 패치에는 parser 보강을 같이 포함한다.

수정 기준:

```txt
1. 기존 /(\d+) 추출 유지
2. 실패하면 URL searchParams no 값으로 추출
3. 둘 다 실패하면 row skip
```

이 보강은 기존 자동갱신에도 이득이고, 동작 변경 위험은 낮다.

#### 3.7.6 상단 상태 라벨도 recovery phase를 봐야 한다

현재 popup 상태 라벨은 아래처럼 동작한다.

```txt
isRunning false -> 🔴 정지
phase WAITING -> 🟡 대기 중
그 외 -> 🟢 실행 중
```

복구모드는 일반 자동갱신을 OFF로 둔 상태에서 실행한다. 따라서 기존 그대로 두면 복구 스캔/실행 중에도 상단 상태가 `정지`로 보일 수 있다.

수정 기준:

```txt
recovery.phase === SCANNING -> 🧯 복구 스캔 중
recovery.phase === EXECUTING -> 🧯 복구 실행 중
그 외에는 기존 isRunning/phase 기준 유지
```

상태 class도 같이 맞춘다.

```txt
SCANNING -> status-warn
EXECUTING -> status-warn
COMPLETED -> status-on
SHORTAGE/FAILED/COMPLETED_WITH_FAILURE -> status-warn
```

#### 3.7.7 recovery busy 상태를 background가 알아야 한다

문서 초안은 `복구 스캔/실행 중에는 일반 자동갱신을 켜지 않는다`는 UI 기준만 적었다. 그런데 실제 background는 기능 실행 여부를 아래 기준으로 판단한다.

```txt
isRunning
runPromise
startAbortController
```

복구모드는 one-shot이라 일반 자동갱신의 `isRunning`을 켜지 않고 돌리는 구조가 맞다. 하지만 그렇게 구현하면 background 입장에서는 복구 스캔/실행 중에도 `정지 상태`로 보일 수 있다.

이 상태에서 생기는 문제:

```txt
1. 복구 스캔 중 일반 자동갱신 토글 ON 가능
2. 복구 실행 중 설정 저장 가능
3. 복구 실행 중 공통 갤러리 설정 변경 가능
4. 복구 스캔 버튼을 연타해서 중복 스캔 가능
5. 복구 실행 중 복구 초기화 가능
```

예시:

```txt
복구 스캔이 page 20까지 읽는 중
-> background는 isRunning=false라 일반 자동갱신 start를 허용
-> 일반 자동갱신이 같은 관리내역을 읽고 즉시 재차단
-> 복구 스캔의 page 기준이 밀림
```

수정 기준:

```js
this.recoveryRunPromise = null;

isRecoveryBusy() {
  return Boolean(
    this.recoveryRunPromise
    || this.recovery.phase === 'SCANNING'
    || this.recovery.phase === 'EXECUTING'
  );
}

getStartBlockReason() {
  if (this.isRecoveryBusy()) {
    return '복구 스캔/실행 중에는 일반 자동갱신을 시작할 수 없습니다.';
  }
  return '';
}
```

background 쪽 기준:

```txt
isSchedulerBusy(scheduler)
-> scheduler.isRecoveryBusy?.()도 포함

hanRefreshIpBan updateConfig
-> recovery busy면 저장 차단

scanRecovery
-> 일반 자동갱신 running이면 차단
-> recovery busy면 차단

executeRecovery
-> 일반 자동갱신 running이면 차단
-> recovery busy면 차단

resetRecovery
-> recovery busy면 차단
```

이렇게 해야 기존 공통 설정 저장 로직도 복구 중인 `hanRefreshIpBan`을 busy로 인식한다.

#### 3.7.8 `delayWhileRunning()`은 복구모드에서 쓰면 안 된다

현재 scheduler의 지연 helper는 아래 기준으로 동작한다.

```txt
delayWhileRunning(scheduler, waitMs)
-> scheduler.isRunning이 true인 동안만 대기
```

일반 자동갱신에는 맞다. OFF를 누르면 `isRunning=false`가 되고 대기 루프가 끊겨야 하기 때문이다.

하지만 복구모드는 일반 자동갱신 OFF 상태에서 실행한다. 즉 복구 스캔/실행 중에도 `isRunning=false`다.

잘못 구현한 예:

```js
await delayWhileRunning(this, getRequestDelayMs(this.config));
```

결과:

```txt
isRunning=false
-> 지연 없이 바로 반환
-> page fetch가 요청 딜레이 없이 몰림
```

수정 기준:

```js
await this.delayFn(getRequestDelayMs(this.config));
```

또는 recovery 전용 helper를 따로 만든다.

```js
async function delayWhileRecoveryBusy(scheduler, waitMs) {
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    return;
  }
  if (!scheduler.isRecoveryBusy()) {
    return;
  }
  await scheduler.delayFn(waitMs);
}
```

이번 구현에서는 중간 취소 버튼을 만들지 않으므로 단순 `this.delayFn()`이 더 명확하다. 복구 초기화는 실행 중에는 막고, 완료/실패/목표미달 상태에서만 허용한다.

#### 3.7.9 복구 중 예외가 나면 phase를 반드시 정리해야 한다

기존 일반 자동갱신 `run()`은 try/catch로 감싸져 있다. 오류가 나면 `WAITING`으로 정리하고 로그를 남긴다.

복구모드도 별도 one-shot이라 같은 수준의 실패 정리가 필요하다.

잘못 구현한 예:

```txt
recovery.phase = SCANNING
-> 12페이지 fetch에서 예외
-> finally에서 recoveryRunPromise만 null
-> recovery.phase는 계속 SCANNING
```

이러면 UI는 계속 `복구 스캔 중`으로 보이고, `isRecoveryBusy()`도 true로 남아 일반 자동갱신/설정저장이 계속 막힐 수 있다.

수정 기준:

```txt
runRecoveryScan() catch
-> recovery.phase = FAILED
-> 오류 로그 저장
-> lastScanAt 저장
-> saveState()

runRecoveryExecute() catch
-> recovery.phase = COMPLETED_WITH_FAILURE 또는 FAILED
-> 오류 로그 저장
-> lastRunAt 저장
-> saveState()
```

예시:

```txt
복구 실행 중 40페이지 batch에서 예외
-> 성공 900건 / 실패 35건까지 저장
-> phase COMPLETED_WITH_FAILURE
-> 사용자가 로그를 보고 다시 스캔/실행 판단 가능
```

#### 3.7.10 저장하지 않은 recovery 설정으로 스캔하면 안 된다

현재 popup에는 dirty tracking이 있다.

```txt
input/change 발생
-> DIRTY_FEATURES.hanRefreshIpBan = true
```

그런데 기존 `hanRefreshIpBan` 토글은 dirty 설정을 강제로 막지 않는다. 복구모드에서 이걸 그대로 두면 target count가 어긋날 수 있다.

문제 예시:

```txt
1. 저장된 target count = 1475
2. 사용자가 input을 1200으로 바꿈
3. 설정 저장을 누르지 않음
4. 복구 스캔 클릭
5. scheduler는 여전히 1475로 스캔
6. UI 입력값은 1200이라 사용자가 결과를 오해함
```

수정 기준:

```txt
복구 스캔 클릭
-> DIRTY_FEATURES.hanRefreshIpBan true면 차단
-> "설정을 저장한 뒤 복구 스캔을 실행하세요." 안내

복구 실행 클릭
-> DIRTY_FEATURES.hanRefreshIpBan true면 차단
-> "설정을 저장한 뒤 복구 실행을 실행하세요." 안내
```

대안으로 스캔 버튼에서 자동 저장 후 실행할 수도 있지만, 이 기능은 차단 복구라 영향이 크다. 사용자가 저장 버튼을 한 번 눌러 확정한 값으로만 스캔/실행하는 쪽이 더 안전하다.

## 4. 복구모드 최종 동작 정의

### 4.1 일반 자동갱신은 그대로 둔다

일반 자동갱신은 지금처럼 동작한다.

```txt
차단 중 row만
IP형 유동만
제목 한자 또는 사유 도배 포함이면
5시간마다 무한 재차단
```

여기에는 복구모드 로직을 섞지 않는다.

### 4.2 복구모드는 별도 one-shot이다

복구모드는 사용자가 명시적으로 눌렀을 때 한 번만 돈다.

```txt
복구 스캔
-> 복구 후보 목록 생성
-> 사용자가 통계를 확인
-> 복구 실행
-> 완료
```

일반 토글 ON/OFF와 의미가 다르다.

```txt
일반 토글 ON:
  앞으로 계속 갱신

복구 실행:
  과거 풀린 목록을 목표 개수만큼 한 번 복구
```

### 4.3 왜 one-shot이어야 하는가

복구모드는 `해제됨`을 포함한다. 이것을 무한 루프로 돌리면 운영자가 일부러 풀어준 무고한 유동까지 계속 되살릴 수 있다.

예시:

```txt
무고한 사용자 A가 문의해서 차단 해제됨
복구모드가 무한 루프라면
-> 다음 루프에서 A를 다시 차단할 수 있음
```

그래서 복구모드는 비상시에만 수동 실행해야 한다.

## 5. 복구 대상 필터

복구모드 전용 extractor를 새로 만든다.

권장 함수명:

```js
extractRecoveryManagementRows(html, options)
```

필터 순서:

```txt
1. parseBlockListRows(html)로 row 파싱
2. 게시글/댓글 row인지 확인
3. IP형 유동인지 확인
4. 사유가 "도배기IP차단(무고한 경우 문의)"인지 확인
5. blockDataNum으로 avoidNo 계산 가능 여부 확인
6. 제목 dedupe key 생성
7. 같은 제목은 첫 row만 대표로 채택
```

일반 자동갱신과 다른 점:

```txt
일반 자동갱신:
  row.isActive true만 허용
  사유에 "도배" 포함이면 허용
  제목 한자도 허용
  baseline data-num 상한 적용

복구모드:
  row.isActive true/false 둘 다 허용
  사유는 정확히 "도배기IP차단(무고한 경우 문의)"만 허용
  제목 한자 조건은 보지 않음
  baseline data-num 상한 적용하지 않음
  제목 기준으로 dedupe
```

예시:

```txt
row 1
  상태: 해제됨
  작성자: 118.235
  제목: 공격글A
  사유: 도배기IP차단(무고한 경우 문의)
  -> 복구 후보

row 2
  상태: 차단 중
  작성자: 118.235
  제목: 공격글A
  사유: 도배기IP차단(무고한 경우 문의)
  -> 제목 중복이므로 제외

row 3
  상태: 해제됨
  작성자: user123
  제목: 공격글B
  사유: 도배기IP차단(무고한 경우 문의)
  -> UID라 제외

row 4
  상태: 해제됨
  작성자: 211.234
  제목: 공격글C
  사유: 일반 분탕
  -> 사유 불일치라 제외
```

## 6. 제목 dedupe 기준

사용자 요구는 `정규화없이 안겹치는 게시물제목`이다.

구현 기준은 아래로 둔다.

```txt
parseBlockListRows()가 뽑은 row.title을 그대로 key로 쓴다.
```

주의할 점:

현재 `row.title`은 HTML byte 원문이 아니다. 이미 아래 처리가 들어간다.

```txt
태그 제거
HTML entity decode
공백 정리
trim
```

확인 위치:

```txt
features/ip/parser.js:90
const title = decodeHtml(stripTags(postMatch[2]));
```

하지만 공격 제목 정규화는 하지 않는다.

하지 않는 것:

```txt
한글 사이 기호 제거 안 함
이모티콘 제거 안 함
한자 치환 안 함
유사도 계산 안 함
소문자 변환 안 함
```

즉 운영상 의미는 아래다.

```txt
"안녕하세요"
"안 녕 하 세 요"
"안녕ㅎㅏ세요"
```

이 셋은 복구모드에서는 서로 다른 제목으로 본다.

이유:

복구모드는 공격 탐지가 아니라 이미 과거에 `도배기IP차단(무고한 경우 문의)`로 차단했던 row를 복구하는 기능이다. 여기서 유사도/정규화를 넣으면 엉뚱한 제목이 같은 묶음으로 합쳐져 목표 개수와 실제 복구 수가 어긋날 수 있다.

## 7. scan 먼저, execute 나중

복구모드는 반드시 2단계로 한다.

```txt
1단계: 복구 스캔
  관리내역을 읽기만 함
  후보 avoidNo 목록 생성
  제목 unique 개수 계산

2단계: 복구 실행
  스캔 때 저장한 후보 avoidNo만 재차단
```

이유:

복구하면서 동시에 스캔하면 페이지가 밀린다.

나쁜 예시:

```txt
1페이지 스캔
-> 20건 재차단
-> 새 차단 row 20개가 1페이지 위로 생김
-> 기존 2페이지 내용이 3페이지로 밀림
-> 스캔 누락/중복 가능
```

좋은 예시:

```txt
1페이지부터 끝까지 먼저 스캔
-> 후보 1475개 확정
-> 그 다음 확정된 avoidNo만 실행
```

## 8. 복구 스캔 상세 플로우

권장 scheduler method:

```js
async scanRecoveryCandidates()
```

흐름:

```txt
1. 일반 자동갱신이 실행 중인지 확인
2. 복구 targetUniqueTitleCount 검증
3. recovery state 초기화
4. 관리내역 1페이지 fetch
5. detectedMaxPage 계산
6. page 1부터 detectedMaxPage까지 순서대로 fetch
7. 각 page에서 extractRecoveryManagementRows()
8. titleKey Set으로 중복 제거
9. unique title 수가 목표치에 도달하면 스캔 중단
10. 후보 목록과 통계를 state에 저장
```

스캔 중단 조건:

```txt
목표 unique 제목 수에 도달
또는 detectedMaxPage 끝까지 도달
또는 사용자가 reset/취소
또는 fetch 실패가 계속되어 더 진행 불가
```

목표치 예시:

```txt
targetUniqueTitleCount = 1475

page 1~12 스캔 결과:
  unique 제목 1475개
  후보 row 1475개
  중복 제목 row 210개
  active 1300개
  inactive 175개

-> 여기서 스캔 종료
```

목표치를 못 채운 예시:

```txt
targetUniqueTitleCount = 1475

전체 페이지 스캔 결과:
  unique 제목 1390개

-> 복구 실행 버튼은 기본적으로 비활성
-> 로그에 "목표 1475건 미달, 발견 1390건" 표시
```

처음 구현에서는 목표 미달 partial 실행은 막는 쪽이 안전하다.

## 9. 복구 실행 상세 플로우

권장 scheduler method:

```js
async executeRecoveryCandidates()
```

흐름:

```txt
1. recovery 후보 목록 존재 확인
2. 목표 unique 제목 수 이상인지 확인
3. 후보를 sourcePage 기준으로 그룹화
4. page 그룹별 avoidNo[]를 rebanManagementRows(config, avoidNos, page)로 전송
5. 성공/실패 수 집계
6. 완료 로그 저장
```

왜 sourcePage로 그룹화하는가:

현재 API helper는 refererPage를 받는다.

```js
rebanManagementRows(config, avoidNos, refererPage)
```

관리내역 페이지에서 온 요청처럼 보이게 하려면 후보가 나온 page를 referer로 쓰는 것이 가장 자연스럽다.

예시:

```txt
page 3에서 나온 후보 20개
-> rebanManagementRows(config, [avoidNo...], 3)

page 4에서 나온 후보 18개
-> rebanManagementRows(config, [avoidNo...], 4)
```

## 10. 일반 자동갱신과 동시 실행 정책

복구모드 실행 중에는 일반 자동갱신과 겹치면 안 된다.

권장 정책:

```txt
일반 자동갱신 isRunning === true
-> 복구 스캔/실행 버튼 비활성
-> 안내: "일반 자동갱신을 끈 뒤 복구모드를 실행하세요."
```

이유:

일반 자동갱신은 스캔하면서 즉시 재차단한다. 복구 스캔이 동시에 관리내역을 읽으면 페이지 밀림이 생길 수 있다.

예시:

```txt
복구 스캔이 page 10을 읽는 중
일반 자동갱신이 page 2에서 30건 재차단
-> 관리내역 앞쪽에 새 row 30건 추가
-> 복구 스캔의 page 11 내용이 달라질 수 있음
```

그래서 복구모드는 일반 자동갱신을 끈 상태에서만 실행한다.

복구 실행이 끝난 뒤에는 사용자가 다시 일반 자동갱신 ON을 켜면 된다.

## 11. 추가할 state/config

### 11.1 config

기존 config:

```js
{
  galleryId,
  galleryType,
  baseUrl,
  requestDelay,
  fallbackMaxPage,
  cycleIntervalMs,
  avoidHour,
  avoidReason,
  avoidReasonText
}
```

추가 권장:

```js
{
  recoveryModeEnabled: false,
  recoveryTargetUniqueTitleCount: 1475
}
```

사유는 사용자가 바꾸는 값으로 두지 않는다.

복구 사유는 고정:

```txt
도배기IP차단(무고한 경우 문의)
```

구현 기준:

```js
const RECOVERY_REASON_TEXT = DEFAULT_CONFIG.avoidReasonText;
const RECOVERY_AVOID_HOUR = DEFAULT_CONFIG.avoidHour;
const RECOVERY_AVOID_REASON = DEFAULT_CONFIG.avoidReason;
```

이유:

복구모드는 이 사유로 차단했던 풀을 되살리는 기능이다. 사유 입력을 열어두면 다른 차단 사유까지 섞일 위험이 있다.

### 11.2 recovery state

권장 state:

```js
recovery: {
  phase: 'IDLE',
  targetUniqueTitleCount: 1475,
  currentPage: 0,
  detectedMaxPage: 0,
  scannedRows: 0,
  candidateRows: 0,
  uniqueTitleCount: 0,
  duplicateTitleCount: 0,
  activeRowCount: 0,
  inactiveRowCount: 0,
  skippedReasonCount: 0,
  skippedNonIpCount: 0,
  skippedEmptyTitleCount: 0,
  successCount: 0,
  failureCount: 0,
  lastScanAt: '',
  lastRunAt: '',
  candidates: []
}
```

`candidates`는 최소 필드만 저장한다.

```js
{
  avoidNo: '12345',
  sourcePage: 12,
  postNo: 67890,
  titleKey: '원문 제목',
  writerToken: '118.235',
  isActive: false
}
```

1475건 정도는 chrome.storage.local에 저장해도 부담이 크지 않다. 그래도 후보 저장은 최소 필드만 둔다.

## 12. UI 구현 계획

### 12.1 popup.html

위치:

```txt
popup/popup.html:612 settings-section 다음
```

추가:

```html
<details class="settings-section recovery-section">
  <summary>비상 복구모드</summary>
  <label class="inline-check">
    <input type="checkbox" id="hanRefreshIpBanRecoveryModeEnabled">
    복구모드 사용
  </label>
  <div class="settings-grid">
    <div class="setting-item">
      <label for="hanRefreshIpBanRecoveryTargetUniqueTitleCount">목표 unique 제목 수</label>
      <input type="number" id="hanRefreshIpBanRecoveryTargetUniqueTitleCount" min="1" max="10000" value="1475">
    </div>
    <button id="hanRefreshIpBanRecoveryScanBtn" class="btn btn-secondary">복구 스캔</button>
    <button id="hanRefreshIpBanRecoveryExecuteBtn" class="btn btn-warning recovery-danger-btn">복구 실행</button>
    <button id="hanRefreshIpBanRecoveryResetBtn" class="btn btn-secondary">복구 초기화</button>
  </div>
  <div class="status-grid compact">
    ...
  </div>
</details>
```

실제 class 이름은 기존 CSS에 맞춰 조정한다.

### 12.2 popup.js DOM

`FEATURE_DOM.hanRefreshIpBan`에 추가:

```js
recoveryModeEnabledInput
recoveryTargetUniqueTitleCountInput
recoveryScanBtn
recoveryExecuteBtn
recoveryResetBtn
recoveryPhaseText
recoveryCurrentPageText
recoveryUniqueTitleCountText
recoveryCandidateRowsText
recoveryActiveInactiveText
recoverySuccessFailureText
```

### 12.3 popup.js event

`bindHanRefreshIpBanEvents()`에 추가:

```txt
복구모드 체크 변경
-> updateConfig({ recoveryModeEnabled })
-> OFF로 바뀌면 recovery 후보/통계 초기화

목표 수 저장
-> updateConfig({ recoveryTargetUniqueTitleCount })
-> 기존 recovery 후보/통계 초기화

복구 스캔
-> DIRTY_FEATURES.hanRefreshIpBan true면 차단
-> sendFeatureMessage('hanRefreshIpBan', { action: 'scanRecovery' })

복구 실행
-> DIRTY_FEATURES.hanRefreshIpBan true면 차단
-> confirm 후 sendFeatureMessage('hanRefreshIpBan', { action: 'executeRecovery' })

복구 초기화
-> sendFeatureMessage('hanRefreshIpBan', { action: 'resetRecovery' })
```

복구 실행 confirm 문구 예시:

```txt
복구 후보 1475건을 도배기IP차단(무고한 경우 문의) 사유로 6시간 재차단합니다.
계속할까요?
```

### 12.4 버튼 활성 조건

```txt
일반 자동갱신 실행 중:
  복구 스캔 disabled
  복구 실행 disabled
  복구 초기화 disabled

복구모드 체크 OFF:
  복구 스캔 disabled
  복구 실행 disabled

복구 스캔 중:
  복구 스캔 disabled
  복구 실행 disabled
  복구 초기화 disabled
  일반 자동갱신 토글 disabled
  일반 설정 저장 disabled
  통계 초기화 disabled

후보 unique 수 < 목표 수:
  복구 실행 disabled

후보 unique 수 >= 목표 수:
  복구 실행 enabled

복구 실행 중:
  복구 스캔 disabled
  복구 실행 disabled
  복구 초기화 disabled
  일반 자동갱신 토글 disabled
  일반 설정 저장 disabled
  통계 초기화 disabled

복구 완료/실패/목표미달:
  복구 초기화 enabled
  일반 자동갱신 토글 enabled
```

예시:

```txt
복구 스캔이 12페이지를 읽는 중
-> 사용자가 일반 자동갱신 ON 클릭
-> UI는 버튼 disabled
-> background도 getStartBlockReason()으로 한 번 더 차단
```

## 13. background 구현 계획

`handleFeatureMessage()`의 switch에 추가한다.

```js
case 'scanRecovery':
  if (message.feature !== 'hanRefreshIpBan') ...
  if (scheduler.isRunning) throw new Error('일반 자동갱신을 끈 뒤 복구모드를 실행하세요.');
  if (scheduler.isRecoveryBusy?.()) throw new Error('이미 복구 작업이 진행 중입니다.');
  await scheduler.scanRecoveryCandidates();
  return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };

case 'executeRecovery':
  if (message.feature !== 'hanRefreshIpBan') ...
  if (scheduler.isRunning) throw new Error('일반 자동갱신을 끈 뒤 복구모드를 실행하세요.');
  if (scheduler.isRecoveryBusy?.()) throw new Error('이미 복구 작업이 진행 중입니다.');
  await scheduler.executeRecoveryCandidates();
  return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };

case 'resetRecovery':
  if (message.feature !== 'hanRefreshIpBan') ...
  if (scheduler.isRecoveryBusy?.()) throw new Error('복구 작업 중에는 초기화할 수 없습니다.');
  scheduler.resetRecoveryState();
  await scheduler.saveState();
  return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };
```

`isSchedulerBusy()`도 recovery를 포함해야 한다.

```js
function isSchedulerBusy(scheduler) {
  return Boolean(
    scheduler?.isRunning
    || scheduler?.runPromise
    || scheduler?.startAbortController
    || scheduler?.isRecoveryBusy?.()
  );
}
```

`start` action은 기존처럼 `scheduler.getStartBlockReason()`을 호출한다. 따라서 scheduler에 recovery busy 차단 사유를 추가하면 일반 자동갱신 ON도 background에서 막힌다.

config normalize에는 추가 필드를 반영한다.

```js
recoveryModeEnabled: Boolean(config.recoveryModeEnabled),
recoveryTargetUniqueTitleCount: normalizeRecoveryTargetUniqueTitleCount(config.recoveryTargetUniqueTitleCount)
```

권장 helper:

```js
function normalizeRecoveryTargetUniqueTitleCount(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1475;
  }
  return Math.min(10000, Math.max(1, parsed));
}
```

그리고 `updateConfig`가 실제로 `scheduler.config = { ...scheduler.config, ...message.config }`를 적용하기 전에, recovery 관련 config 변경 여부를 계산해야 한다.

```txt
recoveryTargetUniqueTitleCount 변경됨
-> scheduler.resetRecoveryState({ keepConfig: true })

recoveryModeEnabled true -> false
-> scheduler.resetRecoveryState({ keepConfig: true })
```

이 처리를 하지 않으면 옛 스캔 후보가 새 target count와 섞일 수 있다.

추가로 `updateConfig`는 recovery busy 중에는 막는다.

```txt
복구 스캔/실행 중 설정 저장
-> 실패 처리
-> 메시지: "복구 작업 중에는 설정을 변경할 수 없습니다."
```

공통 설정 변경도 `getBusyFeatures()`를 통해 막혀야 한다. 그래서 위 `isSchedulerBusy()` 보강이 필수다.

`resetStats`도 recovery busy 중에는 막는다.

```txt
복구 스캔/실행 중 통계 초기화
-> 실패 처리
-> 메시지: "복구 작업 중에는 통계를 초기화할 수 없습니다."
```

이유는 `resetStats`가 일반 통계와 recovery transient state를 같이 지우도록 정의했기 때문이다. 복구 실행 중 state를 지우면 background의 async loop가 계속 진행되면서 UI 숫자와 실제 실행 결과가 어긋날 수 있다.

`resetHanRefreshIpBanSchedulerState()`는 공통 갤러리 설정 변경 때 호출된다. 패치 후에는 일반 통계뿐 아니라 recovery transient state도 같이 지운다.

```txt
galleryId 변경
-> resetHanRefreshIpBanSchedulerState()
-> 일반 자동갱신 상태 초기화
-> recovery candidates/통계 초기화
-> recovery config 값은 유지
```

## 14. scheduler 구현 계획

### 14.1 constructor 추가

추가 dependency:

```js
this.extractRecoveryManagementRows = dependencies.extractRecoveryManagementRows || extractRecoveryManagementRows;
```

추가 state:

```js
this.recovery = buildDefaultRecoveryState();
this.recoveryRunPromise = null;
```

추가 method:

```js
isRecoveryBusy() {
  return Boolean(
    this.recoveryRunPromise
    || this.recovery.phase === 'SCANNING'
    || this.recovery.phase === 'EXECUTING'
  );
}

getStartBlockReason() {
  if (this.isRecoveryBusy()) {
    return '복구 스캔/실행 중에는 일반 자동갱신을 시작할 수 없습니다.';
  }
  return '';
}
```

### 14.2 save/load/getStatus

아래 세 곳에 recovery를 넣는다.

```txt
saveState()
loadState()
getStatus()
```

저장 시 후보 목록은 너무 커지지 않게 최소 필드만 저장한다.

`getStatus()`에는 UI와 background guard가 바로 쓸 수 있게 busy 여부도 같이 넣는다.

```js
recovery: this.recovery,
isRecoveryBusy: this.isRecoveryBusy()
```

저장 대상에는 `recoveryRunPromise`를 넣지 않는다. 실행 중 promise는 service worker 메모리 상태라서 storage에 저장해도 복원할 수 없고, 복원 시에는 `recovery.phase` 기준으로 안전하게 정리한다.

load 기준:

```txt
저장된 recovery.phase가 SCANNING/EXECUTING
-> service worker가 중간에 suspend된 것으로 본다
-> phase FAILED 또는 IDLE로 정리
-> candidates는 실행 전 READY 상태가 아니면 비운다
```

### 14.3 scanRecoveryCandidates()

의사코드:

```js
async scanRecoveryCandidates() {
  if (this.isRunning) {
    throw new Error('일반 자동갱신을 끈 뒤 복구모드를 실행하세요.');
  }
  if (this.isRecoveryBusy()) {
    throw new Error('이미 복구 작업이 진행 중입니다.');
  }

  this.recoveryRunPromise = this.runRecoveryScan().finally(() => {
    this.recoveryRunPromise = null;
  });
  return this.recoveryRunPromise;
}

async runRecoveryScan() {
  if (!this.config.recoveryModeEnabled) {
    throw new Error('복구모드를 먼저 켜세요.');
  }

  const targetCount = normalizeRecoveryTargetCount(this.config.recoveryTargetUniqueTitleCount);
  resetRecoveryMetrics(this, { keepModeEnabled: true });
  this.recovery.phase = 'SCANNING';
  this.recovery.targetUniqueTitleCount = targetCount;
  this.log(`🧯 복구 스캔 시작 - 목표 unique 제목 ${targetCount}건`);
  await this.saveState();

  const firstPage = await this.fetchDetectedMaxPageWithHtml('복구 스캔 1페이지 로딩 실패');
  this.recovery.detectedMaxPage = firstPage.detectedMaxPage;

  const seenTitleKeys = new Set();
  const candidates = [];

  for (let page = 1; page <= this.recovery.detectedMaxPage; page += 1) {
    const html = page === 1 ? firstPage.html : await this.fetchManagementBlockHTML(this.config, page, 2);
    const result = this.extractRecoveryManagementRows(html, {
      seenTitleKeys,
      reasonText: DEFAULT_CONFIG.avoidReasonText,
      page,
    });

    candidates.push(...result.recoveryRows);
    updateRecoveryMetrics(result);

    if (seenTitleKeys.size >= targetCount) {
      break;
    }

    await this.delayFn(getRequestDelayMs(this.config));
  }

  this.recovery.candidates = candidates.slice(0, targetCount);
  this.recovery.phase = candidates.length >= targetCount ? 'READY' : 'SHORTAGE';
  this.recovery.lastScanAt = new Date().toISOString();
  await this.saveState();
}
```

### 14.4 executeRecoveryCandidates()

의사코드:

```js
async executeRecoveryCandidates() {
  if (this.isRunning) {
    throw new Error('일반 자동갱신을 끈 뒤 복구모드를 실행하세요.');
  }
  if (this.isRecoveryBusy()) {
    throw new Error('이미 복구 작업이 진행 중입니다.');
  }

  this.recoveryRunPromise = this.runRecoveryExecute().finally(() => {
    this.recoveryRunPromise = null;
  });
  return this.recoveryRunPromise;
}

async runRecoveryExecute() {
  if (!this.config.recoveryModeEnabled) {
    throw new Error('복구모드를 먼저 켜세요.');
  }

  if (this.recovery.phase !== 'READY') {
    throw new Error('복구 스캔을 먼저 완료하세요.');
  }

  const candidates = this.recovery.candidates.slice(0, this.recovery.targetUniqueTitleCount);
  if (candidates.length < this.recovery.targetUniqueTitleCount) {
    throw new Error('복구 후보가 목표 개수보다 적습니다.');
  }

  this.recovery.phase = 'EXECUTING';
  await this.saveState();

  const pageGroups = groupCandidatesBySourcePage(candidates);
  const recoveryConfig = {
    ...this.config,
    avoidHour: DEFAULT_CONFIG.avoidHour,
    avoidReason: DEFAULT_CONFIG.avoidReason,
    avoidReasonText: DEFAULT_CONFIG.avoidReasonText,
  };
  for (const [page, rows] of pageGroups) {
    const avoidNos = rows.map((row) => row.avoidNo);
    const result = await this.rebanManagementRows(recoveryConfig, avoidNos, page);
    this.recovery.successCount += result.successNos.length;
    this.recovery.failureCount += result.failedNos.length;
    await this.saveState();
    await this.delayFn(getRequestDelayMs(this.config));
  }

  this.recovery.phase = this.recovery.failureCount > 0 ? 'COMPLETED_WITH_FAILURE' : 'COMPLETED';
  this.recovery.lastRunAt = new Date().toISOString();
  this.log(`🧯 복구 실행 완료 - 성공 ${this.recovery.successCount}건 / 실패 ${this.recovery.failureCount}건`);
  await this.saveState();
}
```

실제 구현에서는 `runRecoveryScan()`과 `runRecoveryExecute()` 본문을 try/catch로 감싼다.

```txt
scan 실패:
  recovery.phase = FAILED
  lastScanAt 저장
  오류 로그 저장
  candidates는 비움

execute 실패:
  일부 batch 성공 후 실패라면 COMPLETED_WITH_FAILURE
  시작 전 치명 오류라면 FAILED
  lastRunAt 저장
  성공/실패 카운트 저장
```

## 15. parser 구현 계획

추가 함수:

```js
function extractRecoveryManagementRows(html, options = {}) {
  const rows = parseBlockListRows(html);
  const seenTitleKeys = options.seenTitleKeys instanceof Set
    ? options.seenTitleKeys
    : new Set();
  const reasonText = normalizeRecoveryReason(options.reasonText || '도배기IP차단(무고한 경우 문의)');
  const recoveryRows = [];
  const stats = buildRecoveryParseStats(rows.length);

  for (const row of rows) {
    if (!isRebannableBlockRow(row)) {
      stats.skippedTypeCount += 1;
      continue;
    }

    if (!isIpLikeWriterToken(row.writerToken)) {
      stats.skippedNonIpCount += 1;
      continue;
    }

    if (normalizeRecoveryReason(row.reason) !== reasonText) {
      stats.skippedReasonCount += 1;
      continue;
    }

    const titleKey = getRecoveryTitleKey(row.title);
    if (!titleKey) {
      stats.skippedEmptyTitleCount += 1;
      continue;
    }

    if (seenTitleKeys.has(titleKey)) {
      stats.duplicateTitleCount += 1;
      continue;
    }

    const avoidNo = toAvoidNo(row.blockDataNum);
    if (avoidNo <= 0) {
      stats.skippedInvalidAvoidNoCount += 1;
      continue;
    }

    seenTitleKeys.add(titleKey);
    stats.uniqueTitleCount += 1;
    if (row.isActive) stats.activeRowCount += 1;
    else stats.inactiveRowCount += 1;

    recoveryRows.push({
      ...row,
      avoidNo,
      titleKey,
      sourcePage: Number(options.page) || 1,
    });
  }

  return { rows, recoveryRows, stats };
}
```

사유 normalize:

```js
function normalizeRecoveryReason(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
```

제목 key:

```js
function getRecoveryTitleKey(value) {
  return String(value || '').trim();
}
```

중요:

기존 `hasDobaeReason()`처럼 `includes('도배')`를 쓰면 안 된다.

나쁜 예:

```txt
사유: 도배 의심
사유: 도배 테스트
사유: 도배기IP차단(무고한 경우 문의)
```

이 셋이 전부 섞인다.

복구모드는 정확히 아래 사유만 본다.

```txt
도배기IP차단(무고한 경우 문의)
```

## 16. API 구현 계획

새 API는 만들지 않는다.

기존:

```js
rebanManagementRows(config, avoidNos, refererPage)
```

이것을 그대로 사용한다.

추가 helper가 필요하다면 scheduler 내부에서 그룹화만 한다.

```js
function groupRecoveryCandidatesByPage(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const page = Math.max(1, Number(candidate.sourcePage) || 1);
    if (!groups.has(page)) {
      groups.set(page, []);
    }
    groups.get(page).push(candidate);
  }
  return groups;
}
```

## 17. 로그 설계

추가할 로그 예시:

```txt
[12:00:01] 🧯 복구 스캔 시작 - 목표 unique 제목 1475건
[12:00:02] 🧯 복구 1P: 검사 50줄 / 후보 35줄 / unique 35 / 중복 0 / 해제됨 5
[12:00:10] 🧯 복구 12P: 검사 50줄 / 후보 40줄 / unique 1475 / 중복 210 / 해제됨 175
[12:00:10] ✅ 복구 스캔 완료 - 목표 1475건 확보
[12:00:15] 🧯 복구 실행 시작 - 1475건
[12:00:16] ✅ 복구 실행 1P 그룹 - 성공 35건 / 실패 0건
[12:00:50] ✅ 복구 실행 완료 - 성공 1475건 / 실패 0건
```

목표 미달:

```txt
[12:00:30] ⚠️ 복구 스캔 목표 미달 - 목표 1475건 / 발견 1390건
```

일반 자동갱신 실행 중:

```txt
[12:00:01] ⚠️ 일반 자동갱신 실행 중에는 복구모드를 실행할 수 없습니다. 먼저 OFF로 전환하세요.
```

## 18. 엣지케이스 정적 검증

1. 일반 자동갱신 OFF, 복구모드 체크 OFF, 복구 스캔 클릭
   - 실행하지 않고 안내한다.

2. 일반 자동갱신 ON, 복구 스캔 클릭
   - 실행하지 않는다.

3. 일반 자동갱신 ON, 복구 실행 클릭
   - 실행하지 않는다.

4. target count가 빈 값
   - 기본 1475 또는 최소 1로 normalize한다.

5. target count가 0
   - 1로 보정하거나 저장 실패 처리한다.

6. target count가 음수
   - 1로 보정하거나 저장 실패 처리한다.

7. target count가 10000 초과
   - 10000으로 clamp한다.

8. 관리내역 1페이지 fetch 실패
   - recovery phase를 FAILED로 두고 로그를 남긴다.

9. 관리내역 HTML 구조가 아님
   - 기존 `isLikelyManagementBlockHtml()` 검증 실패로 중단한다.

10. detectedMaxPage가 감지되지 않음
    - fallbackMaxPage를 사용한다.

11. page 중간 fetch 실패
    - 해당 page 실패 로그 후 다음 page로 진행한다. 단, 10페이지 연속 fetch 실패면 recovery phase를 FAILED로 두고 중단한다.

12. 모든 page를 봐도 target count 미달
    - phase SHORTAGE, 실행 버튼 비활성.

13. 후보가 target count보다 많음
    - 스캔은 target 도달 즉시 중단하고 `slice(0, target)`만 저장한다.

14. 같은 제목이 차단 중/해제됨 둘 다 있음
    - 최신순 관리내역에서 먼저 나온 row 하나만 대표로 쓴다.

15. 같은 제목이 서로 다른 IP에 여러 번 있음
    - 제목 기준 중복 제거라 하나만 선택한다. 사용자의 "안겹치는 게시물제목" 요구에 맞춘다.

16. 같은 IP가 여러 제목으로 있음
    - 제목이 다르면 여러 후보가 될 수 있다.

17. row 제목이 비어 있음
    - dedupe 불가라 제외한다.

18. row 사유가 `도배기IP차단(무고한 경우 문의)`와 정확히 다름
    - 제외한다.

19. row 사유에 공백만 다름
    - 공백 normalize 후 같으면 포함한다.

20. row 사유가 `도배기IP차단(무고한 경우 문의) `처럼 끝 공백이 있음
    - trim 후 포함한다.

21. row 사유가 `도배기IP차단`까지만 있음
    - 제외한다.

22. row 사유가 `도배`만 있음
    - 제외한다.

23. row 작성자가 UID
    - 제외한다.

24. row 작성자 토큰이 `118.235`
    - 포함 가능.

25. row 작성자 토큰이 `(118.235)`
    - `normalizeWriterToken()` 때문에 포함 가능.

26. row 작성자 토큰이 full IP `118.235.1.2`
    - 현재 normalize는 앞 `118.235`를 뽑으므로 포함 가능.

27. row 타입이 게시글
    - 포함 가능.

28. row 타입이 댓글
    - 포함 가능.

29. row 타입이 다른 관리 항목
    - 제외한다.

30. blockDataNum이 없음
    - avoidNo 계산 불가라 제외한다.

31. blockDataNum이 1 이하
    - avoidNo가 0 이하라 제외한다.

32. 스캔 후 popup을 닫았다 다시 열었음
    - recovery candidates를 storage에 저장했으면 실행 가능하다.

33. 스캔 후 브라우저가 service worker를 suspend함
    - storage 저장이 있으면 복원 가능하다.

34. 스캔 후 사용자가 target count를 바꿈
    - 기존 candidates는 reset하거나 READY를 무효화해야 한다.

34-1. target count를 바꿨는데 기존 candidates가 남아 있음
    - 구현 버그다. `updateConfig`에서 recovery transient state를 지워야 한다.

35. 스캔 후 일반 자동갱신을 ON함
    - 복구 실행 버튼은 비활성화한다.

36. 복구 실행 중 일부 batch 실패
    - 성공/실패를 분리 집계하고 실패 avoidNo는 로그로 남긴다.

37. ci_c 쿠키 없음
    - 기존 `rebanManagementRows()`가 실패 결과를 반환한다.

38. DC 서버가 HTTP 429 반환
    - 기존 retry가 처리한다.

39. DC 서버가 403 반환
    - 기존 retry가 처리한다.

40. 후보 목록에 중복 avoidNo가 들어감
    - 기존 `rebanManagementRows()`가 uniqueNos로 중복 제거한다.

41. 복구 스캔 중 복구 스캔 버튼을 다시 누름
    - background와 scheduler 양쪽에서 `isRecoveryBusy()`로 차단한다.

42. 복구 스캔 중 복구 실행 버튼을 누름
    - UI는 disabled, background는 `isRecoveryBusy()`로 차단한다.

43. 복구 실행 중 복구 초기화를 누름
    - 실행 중 state를 지우면 async loop와 UI가 어긋나므로 차단한다.

44. 복구 실행 중 통계 초기화를 누름
    - `resetStats`도 recovery transient state를 지우므로 차단한다.

45. 복구 스캔 중 일반 자동갱신 토글 ON
    - UI는 disabled, background는 `getStartBlockReason()`으로 차단한다.

46. 복구 실행 중 설정 저장
    - 후보/target/config가 섞이지 않도록 `updateConfig`에서 차단한다.

47. 복구 실행 중 공통 갤러리 설정 변경
    - `getBusyFeatures()`가 `isRecoveryBusy()`를 보고 차단한다.

48. 복구 실행 중 popup을 닫음
    - background 작업은 계속 진행하고 상태는 storage에 저장한다.

49. 복구 스캔 중 service worker가 suspend됨
    - 다음 load 때 SCANNING/EXECUTING을 그대로 이어가지 말고 실패/초기화 상태로 정리한다.

50. 복구 스캔에서 `delayWhileRunning()`을 사용함
    - 구현 버그다. `isRunning=false`라 딜레이 없이 요청이 몰린다. 복구는 `this.delayFn()`을 사용한다.

51. 일반 자동갱신 대기 중 WAITING 상태에서 복구 스캔 클릭
    - 일반 자동갱신 ON 상태이므로 차단한다.

52. 복구 READY 상태에서 target count를 변경
    - 기존 candidates는 무효화하고 READY를 해제한다.

53. 복구 READY 상태에서 recoveryModeEnabled를 OFF
    - 기존 candidates는 무효화하고 복구 실행 버튼을 비활성화한다.

54. target count를 바꾼 뒤 저장하지 않고 복구 스캔 클릭
    - UI에서 차단하고 설정 저장을 안내한다.

55. requestDelay를 바꾼 뒤 저장하지 않고 복구 실행 클릭
    - 실행 딜레이가 사용자의 기대와 달라지므로 UI에서 차단한다.

## 19. 실제 구현 순서

1. `features/han-refresh-ip-ban/parser.js`
   - `extractRecoveryManagementRows()` 추가
   - `normalizeRecoveryReason()` 추가
   - `getRecoveryTitleKey()` 추가
   - export 추가

2. `features/han-refresh-ip-ban/scheduler.js`
   - recovery state 추가
   - `recoveryRunPromise` 추가
   - `isRecoveryBusy()` 추가
   - `getStartBlockReason()` 추가
   - recovery reason/hour/reasonCode는 `DEFAULT_CONFIG` 기준으로 고정
   - `scanRecoveryCandidates()` 추가
   - `executeRecoveryCandidates()` 추가
   - `resetRecoveryState()` 추가
   - save/load/getStatus에 recovery 포함
   - 일반 자동갱신 running 중 복구 실행 차단
   - 복구 busy 중 일반 자동갱신 start 차단
   - 복구 busy 중 중복 scan/execute/reset 차단
   - 복구 요청 딜레이는 `delayWhileRunning()`이 아니라 `this.delayFn()` 사용
   - 복구 scan/execute 예외 시 phase/log/state 정리

3. `background/background.js`
   - `scanRecovery`, `executeRecovery`, `resetRecovery` action 추가
   - `isSchedulerBusy()`에 `scheduler.isRecoveryBusy?.()` 포함
   - recovery busy 중 `updateConfig` 차단
   - recovery busy 중 `resetStats` 차단
   - hanRefreshIpBan config normalize에 recovery 필드 추가
   - resetStats에서 recovery transient state도 초기화
   - `resetHanRefreshIpBanSchedulerState()`에서 recovery transient state도 초기화

4. `popup/popup.html`
   - 기존 `hanRefreshIpBan` panel 안에 `비상 복구모드` details 추가

5. `popup/popup.js`
   - DOM 매핑 추가
   - 이벤트 추가
   - status 반영 추가
   - 상단 상태 라벨/class에 recovery phase 반영
   - 버튼 활성/비활성 조건 추가
   - `getFeatureConfigInputs('hanRefreshIpBan')`에 recovery input 추가
   - recovery scan/execute 전 dirty config 차단

6. `popup/popup.css`
   - compact status/recovery warning 스타일 추가
   - `recovery-danger-btn` 스타일 추가

7. 정적 테스트
   - parser 목업 row 테스트
   - scheduler dependency mock 테스트
   - popup DOM null 체크
   - background action smoke test
   - target 변경 후 후보 무효화 테스트

## 20. 구현 후 검증 시나리오

### 20.1 parser 단위 목업

목업 HTML:

```txt
1. 차단 중 / IP / 정확한 사유 / 제목 A
2. 해제됨 / IP / 정확한 사유 / 제목 B
3. 해제됨 / UID / 정확한 사유 / 제목 C
4. 해제됨 / IP / 다른 사유 / 제목 D
5. 해제됨 / IP / 정확한 사유 / 제목 A
```

기대:

```txt
후보: A, B
uniqueTitleCount: 2
duplicateTitleCount: 1
skippedNonIpCount: 1
skippedReasonCount: 1
```

### 20.2 scheduler scan mock

조건:

```txt
target = 3
page1 후보 2개
page2 후보 2개
```

기대:

```txt
page2에서 unique 3 도달 후 중단
candidates.length = 3
phase = READY
```

### 20.3 scheduler shortage mock

조건:

```txt
target = 1475
전체 page 후보 1390개
```

기대:

```txt
phase = SHORTAGE
executeRecoveryCandidates() 호출 시 실패
```

### 20.4 execute mock

조건:

```txt
candidates:
  page1 20개
  page2 30개
```

기대:

```txt
rebanManagementRows(config, page1 avoidNos, 1)
rebanManagementRows(config, page2 avoidNos, 2)
successCount/failureCount 집계
```

### 20.5 일반 자동갱신 보호

조건:

```txt
isRunning = true
scanRecoveryCandidates()
```

기대:

```txt
throw Error 또는 실패 응답
일반 runLoop 상태 변경 없음
```

## 21. 파생 문제 검토

### 21.1 일반 자동갱신이 해제됨까지 잡는 문제

발생하지 않게 해야 한다.

대응:

```txt
기존 extractActionableManagementRows()는 수정하지 않는다.
복구용 extractRecoveryManagementRows()를 별도 추가한다.
```

### 21.2 복구 실행 때문에 페이지가 밀리는 문제

대응:

```txt
scan과 execute를 분리한다.
scan 중에는 절대 reban하지 않는다.
execute는 scan으로 확정된 avoidNo만 사용한다.
```

### 21.3 운영자가 풀어준 무고한 유동을 다시 차단하는 문제

완전히 없앨 수는 없다. 복구모드는 해제됨까지 포함하기 때문이다.

대응:

```txt
기본 OFF
일반 자동루프 아님
정확한 사유만 대상
목표 수 수동 입력
스캔 결과 확인 후 실행
```

### 21.4 사유가 조금 다른 과거 row 누락

의도된 동작이다.

복구 대상은 `도배기IP차단(무고한 경우 문의)` 사유로 만든 차단 풀이다. 과거 사유가 `도배` 또는 `도배기`였던 row까지 복구하려면 별도 옵션이 필요하지만, 지금은 넣지 않는 것이 안전하다.

### 21.5 같은 제목 중복 제거로 실제 IP 수가 1475보다 적어질 수 있음

가능하다.

예시:

```txt
같은 제목으로 IP 3개가 차단됐던 경우
제목 dedupe 기준이면 1개만 복구한다.
```

이건 사용자가 말한 `정규화없이 안겹치는 게시물제목으로 1475건` 기준을 따른 결과다.

만약 나중에 `제목 + writerToken` 기준이 필요하면 옵션을 추가할 수 있다. 하지만 이번 구현에서는 넣지 않는다.

### 21.6 popup 닫힘/서비스워커 suspend

대응:

```txt
recovery.candidates를 최소 필드로 storage에 저장한다.
```

### 21.7 storage 용량

1475건 최소 필드는 큰 문제가 없다.

대략:

```txt
1건 200~500 bytes
1475건 약 300KB~750KB
```

그래도 후보 필드는 최소로 제한한다.

## 22. 최종 구현 판단

구조상 문제는 아래 분리 기준과 busy guard를 같이 적용하면 없다.

가장 중요한 분리 기준은 아래다.

```txt
일반 자동갱신:
  기존 함수 유지
  active-only 유지
  5시간 무한 유지

비상 복구모드:
  별도 parser
  별도 scheduler action
  별도 UI 섹션
  scan -> execute 2단계
  exact reason + raw title dedupe
  recovery busy guard 적용
  recovery 전용 지연 처리 적용
```

이렇게 구현하면 기존 플로우가 깨지지 않는다.

실제 사용 예시는 아래처럼 된다.

```txt
평소:
  도배기갱신차단자동 ON
  -> 5시간마다 차단 중 row 자동 갱신

전부 풀린 비상 상황:
  도배기갱신차단자동 OFF
  -> 비상 복구모드 체크
  -> 목표 unique 제목 수 1475 입력
  -> 복구 스캔
  -> 1475건 확보 확인
  -> 복구 실행
  -> 다시 도배기갱신차단자동 ON
```

이 문서 기준으로 바로 패치 진행 가능하다.

## 23. 3차 교차검증 결과

실제 코드와 문서를 다시 대조한 결과, 처음 문서에서 보강해야 할 부분은 모두 위에 반영했다.

확인한 실제 연결부:

```txt
features/han-refresh-ip-ban/parser.js
features/han-refresh-ip-ban/scheduler.js
features/han-refresh-ip-ban/api.js
features/ip/parser.js
background/background.js
popup/popup.html
popup/popup.js
popup/popup.css
```

수정 반영한 문서 이슈:

1. `btn-danger` 미존재
   - 실제 CSS에는 `btn-danger`가 없다.
   - 문서를 `btn btn-warning recovery-danger-btn` + CSS 추가로 수정했다.

2. dirty tracking 누락 가능성
   - `getFeatureConfigInputs('hanRefreshIpBan')`가 기존 설정 2개만 반환한다.
   - recovery input도 포함하도록 문서에 추가했다.

3. target count 변경 후 stale candidates 문제
   - `updateConfig`는 최종적으로 `scheduler.config = { ...scheduler.config, ...message.config }`를 바로 적용한다.
   - target count 변경 또는 recovery OFF 전환 시 `resetRecoveryState({ keepConfig: true })`를 먼저 호출하도록 문서에 추가했다.

4. resetStats 의미 불명확
   - 기존 `resetSchedulerStats()`에는 recovery가 없다.
   - `resetStats`는 일반 통계와 recovery transient state를 초기화하고, `resetRecovery`는 recovery transient state만 초기화하는 것으로 확정했다.

5. 관리내역 href 파싱 보강
   - 현재 parser는 `/숫자` 형태를 우선 기대한다.
   - query `?no=숫자`도 fallback으로 읽도록 parser 보강을 구현 범위에 넣었다.

6. 복구 중 상단 상태가 `정지`로 보일 문제
   - 현재 `getHanRefreshIpBanStatusLabel()`은 `isRunning=false`면 `정지`다.
   - recovery `SCANNING`/`EXECUTING` phase를 상단 라벨/class에 반영하도록 문서에 추가했다.

7. 복구 작업이 background busy 판정에 안 잡힐 문제
   - 현재 busy 판정은 `isRunning`, `runPromise`, `startAbortController` 중심이다.
   - 복구 one-shot은 `isRunning=false`로 돌아야 하므로 `isRecoveryBusy()`와 `recoveryRunPromise`를 추가하도록 문서에 반영했다.

8. 복구 중 일반 자동갱신/설정변경이 들어올 문제
   - `getStartBlockReason()`, `isSchedulerBusy()`, `updateConfig`, `resetRecovery` 차단 조건을 문서에 추가했다.
   - 예시로 복구 스캔 중 일반 자동갱신 ON, 복구 실행 중 공통 갤러리 변경, 복구 실행 중 초기화 모두 막도록 정리했다.

9. 복구 요청 딜레이가 생략될 문제
   - 기존 `delayWhileRunning()`은 `isRunning=false`면 바로 반환한다.
   - 복구모드에서는 이 helper를 쓰지 않고 `this.delayFn(getRequestDelayMs(...))`를 쓰도록 문서에 반영했다.

10. service worker suspend 후 실행 중 phase 복원 문제
    - 저장된 `SCANNING`/`EXECUTING`을 그대로 믿으면 끊긴 작업을 실행 중처럼 표시할 수 있다.
    - load 시 실패/초기화 상태로 정리하고 READY가 아닌 candidates는 비우는 기준을 문서에 추가했다.

11. 복구 예외 후 phase 고정 문제
    - `recoveryRunPromise`만 finally로 비우고 phase를 정리하지 않으면 `SCANNING`/`EXECUTING`이 계속 남을 수 있다.
    - scan/execute 본문에서 catch로 `FAILED` 또는 `COMPLETED_WITH_FAILURE`를 기록하도록 문서에 추가했다.

12. 복구 중 `resetStats`로 state가 지워질 문제
    - 문서상 `resetStats`는 recovery transient state도 지우므로 실행 중 허용하면 async loop와 UI 상태가 어긋날 수 있다.
    - recovery busy 중에는 통계 초기화도 차단하도록 문서에 추가했다.

13. 저장하지 않은 target count로 복구 스캔할 문제
    - popup dirty tracking이 이미 있으므로 recovery scan/execute 전에 dirty 상태를 확인하도록 문서에 추가했다.
    - 예를 들어 input은 1200인데 storage/config는 1475인 상태로 스캔하는 일을 막는다.

14. 복구 사유가 config 커스텀값을 따라갈 문제
    - 복구 대상은 정확히 `도배기IP차단(무고한 경우 문의)` 사유의 차단 풀이다.
    - parser reason과 재차단 실행 config 모두 `DEFAULT_CONFIG.avoidReasonText` 기준으로 고정하도록 문서에 반영했다.

최종 판단:

```txt
구현 전 추가로 남은 구조 이슈 없음.
패치 때 위 14개 보강사항을 함께 적용하면 기존 자동갱신 플로우와 복구모드가 충돌하지 않는다.
```
