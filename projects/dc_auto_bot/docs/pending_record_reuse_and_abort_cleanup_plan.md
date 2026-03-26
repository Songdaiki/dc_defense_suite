# DC Auto Bot - Pending 재사용 및 Abort/Stale 정리 플랜

## 1. 목표

이 문서는 transparency 사이트에서 같은 게시물이

- `검토중`
- `검토중`
- `삭제 승인`

처럼 여러 줄로 쌓이는 문제와,

- 처리 도중 확장 리로드/중지/서비스워커 재시작이 끼면 `검토중`이 영구 잔류하는 문제

를 해결하기 위한 구현 플랜을 정리한다.

목표는 아래와 같다.

- 같은 `targetPostNo`의 **진행 중 pending 레코드는 재사용**한다.
- 처리 도중 중단된 pending은 **failed로 정리**한다.
- helper 대기열 때문에 오래 걸리는 정상 케이스는 **한 줄의 pending만 유지**한다.
- 이미 완료된 과거 기록은 그대로 남기고, **진행 중 기록만 dedupe**한다.

## 2. 현재 실제 로직

현재 자동 신고 처리 플로우는 아래와 같다.

```text
신고 댓글 감지
-> snapshot(view HTML, title, body, imageUrls) 확보
-> random recordId 생성
-> pending 레코드 저장
-> 작성자/개념글/최근100개/LLM/helper 판정
-> 같은 recordId로 completed 또는 failed 저장
```

현재 코드 기준:

- pending 생성:
  - `projects/dc_auto_bot/background/scheduler.js`
  - `processComment()` 안에서 `createRecordId()` 후 `status: 'pending'` 저장
- completed/failed 갱신:
  - 같은 함수 안에서 같은 `recordId`로 다시 저장
- record 저장소:
  - `projects/dc_auto_bot/helper/db.mjs`
  - `upsertRecord()`는 `id` 기준으로만 upsert

즉 **한 번의 시도 내부**에서는 pending -> completed/final update가 한 row로 유지된다.

## 3. 지금 문제가 생기는 이유

### 3.1 새 시도마다 recordId가 새로 생김

현재 `processComment()`는 처리 시작 때마다 무조건 `createRecordId()`를 호출한다.

즉 같은 게시물이 다시 처리되면:

- 이전 pending row는 남고
- 새 recordId로 새 pending row가 생긴다.

저장소는 `id` 기준 upsert라서, 이 경우 같은 게시물이라도 **새 줄**로 쌓인다.

### 3.2 중복 방지 상태는 메모리/저장 타이밍 경계가 있음

중복 방지는 `commandKey = galleryId:targetPostNo` 기반으로 되어 있다.

하지만:

- `markCommandSeen()`은 처리 시작 직후 메모리에 반영되고
- scheduler state 저장은 poll 종료 시점에 이뤄진다

그래서 처리 도중 아래가 끼면:

- 확장 새로고침
- 서비스워커 재시작
- 수동 stop/reset
- gallery/reportTarget 변경으로 state reset

이미 저장된 pending은 남는데 dedupe 상태는 복원되지 못할 수 있다.

그 결과 같은 글이 **새 시도**로 다시 들어온다.

### 3.3 Abort 시 pending 정리 로직이 없음

현재 poll 루프는 `AbortError`가 나면 그냥 빠져나간다.

즉 pending을 만들어놓고

- helper 대기 중 abort
- 로그인 세션 검사 중 abort
- 삭제/차단 실행 전에 abort

가 나면 pending은 그대로 남는다.

### 3.4 helper는 직렬 큐라 정상 케이스도 오래 pending일 수 있음

`/judge`는 worker manager의 `runExclusive()`로 직렬 처리된다.

즉 신고가 몰리면:

- 앞 요청 처리 중
- 뒤 요청은 queue 대기

상태가 되고, 이 동안 transparency에서는 `검토중`으로 보인다.

이건 에러가 아니라 **정상 대기**다.

## 4. 원하는 최종 동작

목표 동작은 아래다.

```text
신고 댓글 감지
-> 같은 targetPostNo의 진행 중 pending 존재 확인
  -> 있으면 같은 recordId 재사용
  -> 없으면 새 recordId 생성
-> pending upsert
-> 처리 중 heartbeat로 pending 갱신
-> 성공 시 같은 row를 completed로 갱신
-> abort/중단 시 같은 row를 failed로 갱신
-> startup/reconcile 시 오래된 orphan pending sweep
```

즉 사용자 관점에서는:

- 같은 글은 진행 중이면 **항상 한 줄**
- 오래 걸리면 그 한 줄이 계속 `검토중`
- 끝나면 그 줄이 `삭제 승인 / 삭제 반려 / 검토 필요 / 처리 실패`로 바뀜

## 5. 구현 원칙

### 5.1 dedupe 대상은 `completed`가 아니라 `pending`만

같은 `targetPostNo`라도 이미 완료된 과거 record는 기록으로 남겨야 한다.

따라서 재사용 대상은:

- `source = auto_report`
- `targetPostNo = 동일`
- `status = pending`

인 **진행 중 record 하나**만 본다.

### 5.2 공개 UI에서 보이는 row는 recordId 하나

같은 target이라도 진행 중이면 기존 pending row를 재사용해야 한다.

즉 구현 기준은:

- 새 row 생성 최소화
- 같은 처리 단위는 같은 `recordId`

다.

### 5.3 정상 대기와 orphan pending을 구분해야 함

helper queue 때문에 오래 걸리는 pending은 정상이다.

따라서 stale cleanup은 단순 생성시각만 보면 안 되고:

- heartbeat
- updatedAt

를 함께 봐야 한다.

### 5.4 reuse key는 `targetPostNo` 단독보다 `targetUrl` 우선이 안전함

현재 runtime dedupe command key는 사실상 `galleryId + targetPostNo`다.

공개 record에는 `galleryId`를 별도 저장하지 않고,

- `targetUrl`
- `targetPostNo`

를 저장한다.

따라서 pending reuse lookup은 가능하면:

- `source`
- `targetUrl`

우선으로 찾고,

fallback으로만

- `source`
- `targetPostNo`

를 쓰는 것이 안전하다.

이유:

- 게시물 번호는 갤러리별로 충돌 가능성이 있다.
- `targetUrl`에는 gallery 정보가 들어 있다.

### 5.5 reuse 시 reporter 메타는 최초 pending 값을 보존해야 함

같은 target을 서로 다른 trusted user가 비슷한 시점에 신고할 수 있다.

이때 기존 pending row를 재사용하면서 새 시도의

- `reporterUserId`
- `reporterLabel`
- `reportReason`

까지 덮어쓰면, 진행 중 row의 의미가 흔들리고 reporter ranking도 왜곡될 수 있다.

따라서 1차 구현 원칙은:

- **기존 pending 재사용 시 reporter 메타는 최초 pending 값을 유지**
- heartbeat/reuse 갱신에서는 `updatedAt` 중심으로만 갱신

이 맞다.

### 5.6 `completed` 저장 시점과 진짜 terminal finalize를 구분해야 함

현재 `processComment()`의 일반 allow 경로는:

- helper decision이 `allow`이면 먼저 `status: 'completed'`를 저장하고
- 그 다음 로그인 세션 확인 / 실제 삭제·차단 실행으로 들어간다

즉 코드상 `completed`가 항상 **진짜 최종 종료 상태**를 뜻하는 것은 아니다.

따라서 abort cleanup 구현 시:

- `completed/failed를 저장했다`는 사실만으로 무조건 finalize 완료로 보면 안 되고
- **실제 terminal 종료 지점**
  - `deny/review` 확정 후 return
  - `allow + action success`
  - `allow + action failed`

를 별도로 추적해야 한다.

안 그러면:

- `pending -> completed(allow 저장)` 직후
- 로그인 세션 확인/삭제 실행 전에 abort

가 났을 때 같은 row가 잘못 `삭제 승인`으로 영구 남을 수 있다.

### 5.7 pending lookup/cleanup 실패가 본 작업을 막으면 안 됨

pending 재사용 lookup과 stale cleanup은 transparency 품질 개선용 보조 경로다.

따라서:

- lookup API 실패
- stale cleanup API 실패
- helper record 저장소 일시 오류

가 나더라도 **본문 판정/삭제 실행 본 흐름은 계속 진행**되어야 한다.

1차 구현 원칙:

- pending lookup 실패 시: 새 `recordId`로 진행
- stale cleanup 실패 시: 로그만 남기고 scheduler resume 계속

즉 이 경로는 **best-effort**여야 한다.

## 6. 구현 변경안

### 6.1 helper store에 pending 조회 메서드 추가

파일:

- `projects/dc_auto_bot/helper/db.mjs`

추가:

- `findLatestPendingRecord({ source, targetUrl, targetPostNo, staleBeforeIso })`

동작:

- `source === 'auto_report'`
- `status === 'pending'`
- `targetUrl` 우선 일치
- fallback으로 `targetPostNo` 일치
- `updatedAt >= staleBeforeIso` 조건

인 record 중 `updatedAt` 최신 하나를 후보로 본다.

추가 규칙:

- 같은 key의 최신 `completed/failed` row가
  후보 pending보다 **더 최신이면**
  해당 pending은 재사용하지 않는다.

주의:

- `completed`/`failed`는 재사용 대상이 아님
- `manual_test`는 auto_report와 분리
- stale timeout보다 오래된 pending은 재사용하지 않음

### 6.2 helper 서버에 내부용 pending lookup API 추가

파일:

- `projects/dc_auto_bot/helper/server.mjs`

추가 엔드포인트:

- `GET /api/moderation-records/pending-latest?source=auto_report&targetUrl=...&targetPostNo=1073568&staleBeforeIso=...`

응답 예:

```json
{
  "success": true,
  "record": {
    "id": "uuid",
    "status": "pending",
    "targetPostNo": "1073568",
    "updatedAt": "2026-03-26T08:30:12.000Z"
  }
}
```

용도:

- scheduler가 pending 생성 전 기존 진행 중 row를 재사용하기 위해 조회

주의:

- localhost helper 내부 호출 전용
- public transparency route에는 그대로 노출하지 않음

### 6.3 scheduler에 pending record 재사용 단계 추가

파일:

- `projects/dc_auto_bot/background/scheduler.js`

변경:

`processComment()`에서 무조건 `createRecordId()`를 만들지 않고,

1. `findLatestPendingRecord(targetUrl, targetPostNo, staleBeforeIso)`
2. pending row 있으면 그 `id` 재사용
3. 없으면 새 `recordId` 생성

으로 바꾼다.

즉:

```text
reusePending = await findLatestPendingRecord(auto_report, targetUrl, targetPostNo, staleBeforeIso)
recordId = reusePending?.id || createRecordId()
```

그 후 pending 저장은 항상 upsert로 간다.

재사용 시 pending 저장 규칙:

- 기존 pending 발견 시
  - `id`는 재사용
  - `reporterUserId`, `reporterLabel`, `reportReason`는 기존 값 유지
  - `updatedAt`만 최신화
- 새 pending 생성 시
  - 현재 시도의 reporter 메타를 처음 저장

효과:

- 같은 글이 재시도돼도 기존 pending row를 덮어쓴다
- `검토중`이 여러 줄로 쌓이지 않는다

### 6.4 pending heartbeat 추가

파일:

- `projects/dc_auto_bot/background/scheduler.js`

추가 상태:

- `activeTransparencyPending = null`
- `pendingHeartbeatTimer = null`

추가 함수:

- `startPendingHeartbeat(recordContext)`
- `stopPendingHeartbeat()`

동작:

- pending 생성/재사용 직후 시작
- 30초마다 같은 `recordId`로 `status: 'pending'` upsert
- `updatedAt`만 최신으로 갱신
- reason은 계속 `검토중`

왜 필요한가:

- helper queue 대기 중에도 이 row가 **살아있는 처리**임을 표시
- stale cleanup이 정상 대기와 orphan를 구분할 수 있게 함

### 6.5 Abort 시 same record를 failed로 정리

파일:

- `projects/dc_auto_bot/background/scheduler.js`

변경 포인트:

- `processComment()` 전체를 `try/finally` 또는 `try/catch/finally`로 감싸고
- pending이 만들어진 뒤 `AbortError`가 나면
  - 같은 `recordId`
  - `status: 'failed'`
  - reason: `자동 처리 중단: 확장 재시작/중지/abort`

로 저장

정리 규칙:

- **진짜 terminal finalize 이후에만** abort 정리 금지
- pending heartbeat도 함께 중단

중요:

- abort finalize 저장은 **기존 aborted signal을 재사용하면 안 된다**
- 현재 `callCliHelperRecord()`는 전달된 signal이 abort 상태면 그대로 중단된다
- 따라서 abort 정리용 record 저장은
  - `signal` 없이 보내거나
  - 별도 no-abort helper 경로를 써야 한다

효과:

- stop/reload 순간 orphan pending이 남는 케이스 감소
- `allow completed 선저장 -> action 전 abort` 케이스도 잘못된 `삭제 승인` 고정을 막을 수 있음

### 6.6 startup/reconcile 시 stale pending sweep 추가

파일:

- `projects/dc_auto_bot/helper/db.mjs`
- `projects/dc_auto_bot/helper/server.mjs`
- `projects/dc_auto_bot/background/background.js`

추가 helper store 메서드:

- `markStalePendingAsFailed({ source, staleBeforeIso, reason })`

추가 helper API:

- `POST /api/moderation-records/cleanup-stale-pending`

요청 예:

```json
{
  "source": "auto_report",
  "staleBeforeIso": "2026-03-26T08:20:00.000Z",
  "reason": "자동 처리 중단: stale pending 정리"
}
```

동작:

- `status === 'pending'`
- `updatedAt < staleBeforeIso`
- `source === auto_report`

면 `failed`로 바꾼다.

호출 시점:

- helper health 확인 직후 1회
- `scheduler.loadState()` / `ensureRunLoop()` 전에 1회
- `resumeScheduler()` 공용 경로 안에 넣어 event 진입점별 순서 차이를 없앰
- `resumeScheduler()` 자체도 singleflight/직렬화가 필요

효과:

- crash 등으로 abort handler가 못 돈 orphan pending 정리

주의:

- `resumeScheduler()`는 `onInstalled`, `activate`, `onStartup`, `keepAlive`에서 모두 호출된다
- 따라서 stale cleanup은 idempotent해야 한다
- 동시에 여러 `resumeScheduler()`가 들어와도 cleanup/loadState/ensureRunLoop가 중복 실행되지 않도록
  `resumePromise` 같은 singleflight guard가 필요하다

### 6.7 stale 기준은 heartbeat 전제로 잡는다

권장 기본값:

- heartbeat interval: `30000ms`
- stale timeout: `10분`

이유:

- helper timeout 기본값이 `240000ms(4분)`
- 정상 대기 중엔 heartbeat가 `updatedAt`를 계속 갱신
- 진짜 orphan만 `10분 이상 updatedAt 정지`로 걸러낼 수 있음

즉 stale cleanup은 **생성시각 기준이 아니라 heartbeat가 멈춘 pending 기준**으로 본다.

## 7. 실제 파일별 변경 범위

### 7.1 `background/scheduler.js`

필수:

- pending lookup 호출 추가
- recordId 재사용 로직 추가
- pending heartbeat 시작/중단 추가
- abort/finalize 상태 추적 플래그 추가
- `completed 저장`과 `terminal finalize`를 분리하는 상태 플래그 추가
- AbortError 시 failed finalize 추가

권장 내부 상태:

- `currentPendingRecordId`
- `currentPendingDecisionPersisted`
- `currentPendingTerminalFinalized`
- `currentPendingHeartbeatTimer`

### 7.2 `background/api.js`

필수:

- helper record lookup API 호출 함수
- stale cleanup API 호출 함수
- abort finalize 전용 no-abort record 저장 helper

원칙:

- lookup/cleanup 실패는 caller가 recover 가능해야 한다
- 즉 함수는 throw-only보다
  - `success: false, message`
  - 또는 명확한 recoverable error
  를 돌려서 scheduler가 best-effort fallback을 할 수 있어야 한다

예:

- `findLatestPendingTransparencyRecord(config, source, targetUrl, targetPostNo, staleBeforeIso, signal)`
- `cleanupStalePendingTransparencyRecords(config, payload, signal)`
- `persistTransparencyRecordWithoutAbort(config, record)`

### 7.3 `helper/db.mjs`

필수:

- `findLatestPendingRecord()`
- `markStalePendingAsFailed()`

### 7.4 `helper/server.mjs`

필수:

- internal-only pending lookup route
- internal-only stale cleanup route

주의:

- lookup/cleanup route는 public transparency route와 분리
- 내부 route 실패가 `/transparency`, `/judge`, `/record` main path를 막지 않게
  독립적인 handler/에러 처리로 둔다

### 7.5 `helper/transparency.mjs` / `helper/db.mjs`

필수:

- abort/stale pending 정리 reason을 **known failed reason**으로 분류

이유:

현재 transparency 쪽은 알려진 실패 사유가 아니면:

- `isInternalErrorFailed(record) === true`
- `강제 승인`

으로 집계/표시한다.

따라서 아래 새 reason이 추가되면:

- `자동 처리 중단: 확장 재시작/중지/abort`
- `자동 처리 중단: stale pending 정리`

를 `isKnownFailedReason()`에 포함시켜야 한다.

안 그러면 stale cleanup/abort 정리가 오히려 공개 사이트에서 **강제 승인**으로 보일 수 있다.

## 8. 상태 전이 규칙

### 8.1 정상 성공

```text
pending
-> heartbeat 갱신 반복
-> completed(allow/deny/review)
```

### 8.2 helper timeout fallback 성공

```text
pending
-> heartbeat 갱신
-> helper timeout 감지
-> force allow fallback 처리 성공
-> completed(allow)
```

### 8.3 abort 중단

```text
pending
-> abort
-> failed("자동 처리 중단: 확장 재시작/중지/abort")
```

### 8.4 crash/orphan

```text
pending
-> heartbeat 중단
-> startup cleanup에서 stale 탐지
-> failed("자동 처리 중단: stale pending 정리")
```

### 8.5 같은 target 재시도

```text
old pending exists
-> findLatestPendingRecord()
-> old id 재사용
-> same row 유지
-> 최종 completed/failed로 갱신
```

## 9. 네가 보여준 현상이 이 플랜으로 해결되는가

### 9.1 같은 글이 `검토중`, `검토중`, `삭제 승인`으로 여러 줄 쌓이는 문제

**해결된다.**

이유:

- 새 시도 때 random recordId를 새로 만들지 않고
- 같은 `targetPostNo`의 진행 중 pending row를 재사용하므로
- 같은 글은 진행 중에 **한 줄만 유지**된다.

### 9.2 처리 도중 끊겨서 `검토중`이 영구 잔류하는 문제

**대부분 해결된다.**

이유:

- 정상 abort는 즉시 `failed`로 finalize
- 비정상 종료/crash는 startup stale cleanup으로 정리

즉 예전처럼 orphan pending이 계속 남는 케이스는 크게 줄어든다.

### 9.3 `검토중`이 한동안 보이는 현상 자체

**이건 없어지지 않는다.**

이유:

- pending-first 구조는 유지
- helper queue 대기와 실제 판정 시간은 여전히 필요

다만 바뀌는 점은:

- 예전: `검토중` row가 여러 줄
- 이후: **한 줄의 `검토중`이 오래 유지되다가 최종 상태로 바뀜**

즉 사용자 체감은 훨씬 자연스러워진다.

## 10. 주의점

### 10.1 reporter ranking 영향

현재 reporter ranking은 record 단위 집계다.

진행 중 pending을 재사용하면, 같은 target의 중복 재시도가 새 record로 안 쌓이므로
이상 중복 카운트가 줄어드는 효과가 있다.

이건 오히려 의도에 맞다.

### 10.2 같은 target을 서로 다른 trusted user가 거의 동시에 신고한 경우

현재 dedupe도 사실상 `targetPostNo` 단위에 가깝다.

따라서 이번 플랜도 1차는:

- `auto_report + targetUrl` 우선, fallback으로 `targetPostNo` 기준 pending 재사용

으로 맞추는 게 현재 정책과 가장 자연스럽다.

### 10.3 stale timeout은 heartbeat 없이 넣으면 안 됨

heartbeat 없이 단순 age 기준 stale cleanup을 넣으면
정상 queue 대기 중인 pending을 잘못 실패 처리할 수 있다.

따라서:

- **heartbeat 먼저**
- **cleanup은 그 다음**

순서가 필요하다.

### 10.3.1 `allow` 경로는 completed 저장 직후가 terminal이 아님

현재 일반 `allow` 경로는 helper decision record를 먼저 `completed`로 저장하고,
실제 삭제/차단은 그 다음 단계에서 수행한다.

따라서 구현 시:

- `currentPendingTerminalFinalized === true`가 되기 전까지는
  abort cleanup이 같은 row를 `failed`로 덮을 수 있어야 한다

이 점을 빼먹으면,

- UI에는 `삭제 승인`
- 실제 삭제는 미실행

인 잘못된 상태가 남을 수 있다.

### 10.3.2 pending lookup/cleanup은 본 작업 비차단이어야 함

lookup/cleanup helper route가 실패했다고:

- 신고 처리 자체
- scheduler resume 자체

를 막아버리면 transparency 품질 보강 때문에 본 기능이 죽는다.

따라서:

- lookup 실패 -> 새 recordId fallback
- cleanup 실패 -> 로그만 남기고 resume 진행

이 안전하다.

### 10.4 목록 dedupe는 total/stats도 같은 기준으로 계산해야 함

목록에서만 dedupe 표시를 넣을 때,

- rows만 숨기고
- `total`, `stats.review` 등은 raw record 기준으로 두면

화면 숫자와 목록 row가 서로 안 맞게 된다.

따라서 list-only dedupe를 넣는 경우에도:

- `/transparency`
- `/api/moderation-records`

에서 반환하는

- `records`
- `total`
- `stats`

는 모두 **dedupe 후 기준**으로 맞추는 것이 안전하다.

### 10.5 abort/stale failed reason은 transparency에서 강제 승인으로 보이면 안 됨

현재 transparency의:

- `helper/transparency.mjs`
- `helper/db.mjs`

는 알려진 실패 사유가 아니면 내부 오류로 보고 `강제 승인` 쪽으로 분류한다.

따라서 이 플랜을 구현할 때는 새 abort/stale reason을 반드시 known failure 목록에 넣어야 한다.

## 11. 웹사이트 임시 완화안

근본 해결과 별개로, **가시성 문제만 빠르게 줄이기 위한 목록 전용 dedupe 표시**를 같이 둘 수 있다.

이 완화안의 목적은:

- 실제 중복 row를 당장 DB에서 지우지 않더라도
- `/transparency` 목록에서만
  - 오래된 `검토중`
  - 같은 글의 중복 `검토중`

을 숨겨서 사용자가 자연스럽게 보게 만드는 것이다.

### 11.1 적용 범위

1차는 아래 범위만 권장한다.

- `GET /transparency`
- `GET /api/moderation-records`

즉 **목록 표시와 목록 API 응답에서만** dedupe한다.

다음은 건드리지 않는다.

- DB 원본 row
- `/transparency/:id` 상세 페이지
- `/api/moderation-records/:id` 상세 API

### 11.2 dedupe 규칙

기준 key:

- `source === auto_report`
- `targetUrl` 우선
- fallback으로 `targetPostNo`

규칙:

1. 같은 key에서 **최신 `completed/failed` row가 최신 pending보다 더 최신이면**
   - 그 pending row는 목록에서 숨긴다.
2. 같은 key에 `pending`만 여러 개 있으면
   - `updatedAt` 최신 `pending` 1개만 목록에 남긴다.
3. 같은 key에 **정상 `completed` row가 있고**, 다른 row가
   - `자동 처리 중단: 확장 재시작/중지/abort`
   - `자동 처리 중단: stale pending 정리`
   같은 **정리용 failed row**라면
   - 그 정리용 failed row는 목록에서 숨긴다.
4. stale pending을 failed로 정리할 때도
   - `updatedAt`을 현재 시각으로 끌어올리지 않고
   - 원래 stale 시각을 유지한다.
5. `manual_test`는 dedupe 대상에서 제외한다.

즉 결과적으로 목록에서는:

- `검토중`
- `검토중`
- `삭제 승인`

이렇게 보이던 것이

- `삭제 승인`

또는 진행 중이면

- 최신 `검토중`

하나만 보이게 된다.

반대로 과거 `삭제 승인`이 있고,
그 뒤 더 최신의 새 `검토중`이 생긴 경우에는

- 과거 terminal row는 기록으로 남고
- 최신 `검토중`도 같이 보일 수 있다.

### 11.3 구현 위치

파일:

- `projects/dc_auto_bot/helper/db.mjs`
- 또는 `projects/dc_auto_bot/helper/transparency.mjs` 직전 list result 조합부

권장 위치는 `db.mjs`의 list 계층이다.

이유:

- `/transparency`
- `/api/moderation-records`

둘 다 같은 dedupe 규칙을 재사용할 수 있기 때문이다.

구현 방향:

- `filterRecords()` 이후
- `listRecords()`에서 paginate 전
- `collapseDuplicatePendingForList(records)` 적용

그리고 이 결과 기준으로:

- `total`
- `stats`
- `records`
- `nextCursor`

를 같이 계산한다.

### 11.4 주의점

이 완화안은 **보이기만 정리**하는 것이다.

즉:

- DB 안의 중복 row는 그대로 남는다
- reporter ranking 같은 집계 왜곡 가능성은 그대로다
- stale pending 자체가 없어지는 것은 아니다

따라서 이건 **임시 완화**이고,
근본 해결은 여전히

- pending 재사용
- abort/stale cleanup

이 필요하다.

## 12. 구현 순서

1. helper DB에 `findLatestPendingRecord`, `markStalePendingAsFailed` 추가
2. helper server에 lookup/cleanup 내부 API 추가
3. background api에 helper 호출 함수 추가
4. scheduler에 pending 재사용 로직 추가
5. scheduler에 heartbeat 추가
6. scheduler에 AbortError failed finalize 추가
7. background startup/reconcile에 stale cleanup 추가
8. transparency 목록/상세에서 stale failed reason 노출 확인

### 12.1 빠른 완화만 먼저 넣는 경우

가시성만 급하면 아래 순서로 잘라서 먼저 갈 수 있다.

1. `listRecords()` 단계 dedupe 표시 추가
2. `/transparency`, `/api/moderation-records` 확인

이 경우 사용자 화면상 중복 pending은 대부분 사라진다.

다만 DB 원본 중복과 stale pending 원인은 그대로 남는다.

## 13. 최종 판단

이 플랜을 구현하면 네가 보여준 문제는 아래처럼 정리된다.

- `검토중`이 여러 줄로 중복 생성되는 문제: **해결**
- abort/reload 뒤 pending 영구 잔류 문제: **해결**
- helper queue 때문에 잠깐 `검토중`으로 보이는 현상: **유지**
  - 단, **한 줄 상태 업데이트**로 보이게 바뀜

즉 사용자 관점에서는 결국

```text
검토중
-> 삭제 승인
```

이 **같은 줄에서 바뀌는 형태**로 보이게 된다.
