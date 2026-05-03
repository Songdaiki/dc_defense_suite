# AI 관리자 dry-run Gemini 병렬 worker 구현 계획

작성일: 2026-05-03

## 1. 목표

`projects/ai_moderator_dry_run`은 현재 10초마다 1페이지 새 글을 큐에 넣고, Gemini CLI로 판정한 뒤 로컬 웹에 결과를 남긴다.

현재 문제는 큐 처리가 완전 직렬이라는 점이다.

예시:

```text
현재
1159880 처리 시작
1159880 Gemini 판정 완료
jitter 대기
1159881 처리 시작
1159881 Gemini 판정 완료
...
```

원하는 구조:

```text
변경 후, workerConcurrency=3 예시
worker-1: 1159880 처리
worker-2: 1159881 처리
worker-3: 1159882 처리

worker-2가 먼저 끝나면 다음 queued 글 1159883을 가져감
worker-1이 늦어도 다른 worker는 계속 진행
```

중요한 원칙은 그대로 유지한다.

```text
실제 삭제 없음
실제 차단 없음
로그인 세션 없음
DC 관리자 API 호출 없음
DB/웹 기록만 저장
```

## 2. 현재 실제 로직 확인 결과

### 2.1 서버 실행 구조

대상 파일:

```text
projects/ai_moderator_dry_run/server.mjs
```

현재 `buildRuntimeConfig()`는 아래 값을 만든다.

```text
GEMINI_COMMAND
GEMINI_ARGS_JSON
GEMINI_TIMEOUT_MS
GEMINI_DISABLE_PERSISTENT_WORKER
DRY_RUN_ITEM_JITTER_MIN_MS
DRY_RUN_ITEM_JITTER_MAX_MS
DRY_RUN_LIVE_POLL_ENABLED
DRY_RUN_LIVE_POLL_INTERVAL_MS
```

하지만 worker 동시 처리 수 설정은 없다.

현재 `DryRunRunner.start()` 흐름:

```text
start()
-> running=true
-> runLoop() 1개만 실행
```

현재 `runLoop()` 흐름:

```text
while !stopRequested
  queue.getNextQueued()
  queue.markRunning(postNo)
  processItem(item)
  waitBetweenItems(postNo)
```

즉, 병렬 worker가 아니라 단일 worker다.

### 2.2 큐 구조

대상 파일:

```text
projects/ai_moderator_dry_run/queue.mjs
```

현재 큐 상태:

```text
queued
running
completed
skipped
failed
```

현재 `getNextQueued()`는 `queued` 항목 중 우선순위가 높은 항목 1개를 반환만 한다.

```text
getNextQueued()
-> queued 목록 filter
-> compareProcessingPriority 정렬
-> 첫 항목 반환
```

그 다음 `server.mjs`에서 별도로 `markRunning(postNo)`를 호출한다.

직렬일 때는 문제가 적지만, 병렬 worker에서는 위험하다.

예시:

```text
worker-1: getNextQueued() -> 1159880 반환
worker-2: getNextQueued() -> 아직 running 표시 전이면 1159880 반환 가능
worker-1: markRunning(1159880)
worker-2: markRunning(1159880)
결과: 같은 글을 2명이 처리할 수 있음
```

따라서 병렬화 전에 큐에는 “가져오기 + running 변경”을 하나의 원자적 동작으로 묶은 `claimNextQueued()`가 필요하다.

### 2.3 Gemini 호출 구조

대상 파일:

```text
projects/ai_moderator_dry_run/judge.mjs
projects/ai_moderator_dry_run/gemini_worker_manager.mjs
```

현재 `judgePost()` 흐름:

```text
prepareJudgeImageInputs()
runJudgeSequence()
  -> runImageAnalysis()
  -> buildDryRunPrompt()
  -> runGeminiCli()
getGeminiWorkerManager(runtimeConfig).runExclusive(runJudgeSequence)
```

핵심은 마지막 줄이다.

`gemini_worker_manager.mjs`의 `runExclusive()`는 내부 큐를 갖고 한 번에 하나의 task만 실행한다.

```text
runExclusive(taskFn)
-> queue.push(task)
-> processQueue()
-> activeExclusiveEntry가 있으면 대기
```

즉, `server.mjs`를 worker 3개로 바꿔도 `judgePost()`가 항상 `runExclusive()`를 타면 Gemini 판정은 다시 직렬이 된다.

현재 `runGeminiCli()` 내부에는 이미 이런 분기가 있다.

```text
if (!packageRoot || runtimeConfig.disablePersistentWorker === true) {
  return runGeminiCliViaSpawn(...)
}
```

하지만 `judgePost()` 바깥에서 이미 `runExclusive()`로 전체 `runJudgeSequence()`를 감싸고 있으므로, `GEMINI_DISABLE_PERSISTENT_WORKER=1`이어도 이미지 분석 + 최종 판정 시퀀스 전체가 전역 직렬 큐에 들어간다.

따라서 실제 병렬화를 하려면 아래 수정이 필요하다.

```text
GEMINI_DISABLE_PERSISTENT_WORKER=1
-> judgePost()는 runExclusive()를 우회
-> runJudgeSequence(null)를 직접 실행
-> 각 worker가 별도 Gemini CLI spawn으로 병렬 실행
```

반대로 persistent worker를 켠 상태에서는 기존처럼 직렬 유지가 안전하다.

### 2.4 DB 저장 구조

대상 파일:

```text
projects/ai_moderator_dry_run/db.mjs
```

현재 `DryRunRecordStore.upsertRecord()`는 메모리 배열에 record를 반영하고 `persist()`로 JSONL 파일을 다시 쓴다.

`persist()`는 `writePromise`로 파일 쓰기를 순서대로 묶는다.

```text
this.writePromise = this.writePromise.then(() => writeFile(...))
await this.writePromise
```

동시 worker가 `upsertRecord()`를 여러 번 호출해도 파일 쓰기 자체는 직렬화된다.

다만 메모리 배열 변경과 `persist()` 호출 사이도 동시에 들어올 수 있으므로, 완전하게 하려면 `upsertRecord()`에도 mutation lock을 두는 편이 더 안전하다.

이번 패치에서 최소 목표는 큐 중복 claim 방지다. DB는 Node 단일 프로세스에서 같은 배열을 쓰고 있고, `upsertRecord()`가 record id 기준으로 덮어쓰기라 중복 record 위험은 낮다. 그래도 안정성을 높이려면 DB에도 같은 `mutationPromise` 구조를 적용할 수 있다.

### 2.5 live polling 구조

현재 `LivePagePoller` 흐름:

```text
start()
-> 10초마다 pollOnce()
-> 첫 poll은 seed만 저장
-> 이후 baselineMaxPostNo보다 큰 새 글만 candidates
-> 기존 record가 없으면 queue.enqueuePosts()
-> runner가 안 돌고 있으면 runner.start()
```

이 구조는 병렬 runner와 충돌하지 않는다.

다만 runner가 실행 중이면 `runner.start()`는 새로 호출되지 않는다. 병렬 worker들이 이미 돌고 있다면 새로 들어온 큐 항목은 남은 worker 또는 빈 worker가 다음 claim 때 가져가면 된다.

## 3. 구현 결론

병렬화는 아래 3개가 같이 들어가야 정상 작동한다.

```text
1. queue.mjs
   claimNextQueued(workerId) 추가
   getNextQueued()+markRunning 분리 제거

2. server.mjs
   DryRunRunner를 N개 worker loop 구조로 변경
   activeWorkers 상태를 API/웹에 노출

3. judge.mjs
   GEMINI_DISABLE_PERSISTENT_WORKER=1일 때 runExclusive 우회
   그래야 Gemini CLI spawn이 실제 병렬 실행됨
```

`server.mjs`만 바꾸면 “겉보기 worker만 병렬”이고, 실제 Gemini는 계속 한 줄로 선다.

## 4. 파일별 패치 계획

### 4.1 `queue.mjs`

추가할 필드:

```js
this.mutationPromise = Promise.resolve();
```

추가할 helper:

```js
async withMutation(mutator) {
  const run = this.mutationPromise.then(async () => {
    await this.init();
    return mutator();
  });
  this.mutationPromise = run.catch(() => {});
  return run;
}
```

이 helper는 `claimNextQueued()`에만 쓰지 말고 큐 상태를 바꾸는 메서드에 공통 적용한다.

적용 대상:

```text
enqueuePosts()
claimNextQueued()
patchItem()
requeueFailedAndSkipped()
```

이유:

```text
live polling enqueue
worker claim
worker markCompleted/markFailed
retry-failed
```

위 작업들이 동시에 들어와도 메모리 배열 변경 순서가 꼬이지 않게 하기 위해서다.

주의할 점:

```text
init()
resetRunningOnStartup()
persist()
```

위 초기화 경로는 `withMutation()`으로 감싸지 않는다.

이유는 `init()` 내부에서 `resetRunningOnStartup()`이 호출되기 때문이다. 만약 `resetRunningOnStartup()`까지 `withMutation()`으로 감싸면 `withMutation() -> init() -> resetRunningOnStartup() -> withMutation()` 재진입 구조가 되어 교착 위험이 생긴다.

정리하면 아래처럼 나눈다.

```text
초기 로딩/복구:
  init()
  resetRunningOnStartup()
  persist()

런타임 큐 변경:
  enqueuePosts()
  claimNextQueued()
  patchItem()
  requeueFailedAndSkipped()
```

추가할 메서드:

```js
async claimNextQueued(workerId = '') {
  return this.withMutation(async () => {
    const item = this.items
      .filter((entry) => entry.status === 'queued')
      .sort(compareProcessingPriority)[0] || null;

    if (!item) {
      return null;
    }

    item.status = 'running';
    item.attemptCount = Math.max(0, Number(item.attemptCount) || 0) + 1;
    item.lastError = '';
    item.workerId = String(workerId || '').trim();
    item.runningStartedAt = new Date().toISOString();
    item.updatedAt = item.runningStartedAt;
    await this.persist();
    return { ...item };
  });
}
```

`normalizeQueueItem()`도 아래 필드를 보존한다.

```text
workerId
runningStartedAt
lastWorkerId
```

terminal 상태로 바뀔 때는 `workerId`를 계속 “현재 작업자”처럼 남기지 않는 편이 낫다.

권장 필드 운용:

```text
running:
  workerId=worker-1
  runningStartedAt=...

completed/skipped/failed:
  lastWorkerId=worker-1
  workerId=''
  runningStartedAt=''
```

이렇게 해야 큐 파일만 봐도 “지금 처리 중인 worker”와 “마지막 처리 worker”가 헷갈리지 않는다.

`requeueFailedAndSkipped()`나 `enqueuePosts(force=true)`로 다시 queued가 될 때도 `workerId`, `runningStartedAt`은 비운다.

기존 `getNextQueued()`는 유지해도 되지만 runner에서는 쓰지 않는다.

`claimNextQueued()`가 이미 `status=running` 변경과 `attemptCount += 1`을 수행하므로, 병렬 runner에서는 절대 `markRunning()`을 한 번 더 호출하지 않는다.

예시:

```text
잘못된 흐름:
claimNextQueued()
markRunning()
-> attemptCount가 2 올라갈 수 있음

올바른 흐름:
claimNextQueued()
processItem()
markCompleted/markSkipped/markFailed
```

예시:

```text
worker-1 claimNextQueued()
-> 1159880을 즉시 running으로 바꿈

worker-2 claimNextQueued()
-> 1159880은 이미 running이므로 1159881을 가져감
```

### 4.2 `server.mjs` runtime config

`buildRuntimeConfig()`에 추가한다.

```js
workerConcurrency: normalizeBoundedPositiveInt(process.env.DRY_RUN_WORKER_CONCURRENCY, 1, 8, 1)
```

추가할 helper:

```js
function normalizeBoundedPositiveInt(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < min) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(numericValue)));
}
```

초기 권장값:

```text
기본값: 1
실시간 테스트: 3
상한: 8
```

이유:

```text
1이면 기존 직렬 동작과 동일해서 rollback이 쉽다.
3이면 Gemini CLI 병렬 효과를 볼 수 있다.
8 이상은 Gemini/네트워크/디시 이미지 fetch 실패가 늘 수 있어 일단 제한한다.
```

`sanitizeRuntimeConfig()`에도 추가한다.

```text
workerConcurrency
```

### 4.3 `server.mjs` DryRunRunner 상태

현재 상태:

```js
this.currentPostNo = '';
```

변경 후:

```js
this.activeWorkers = new Map();
this.completedInRun = 0;
this.failedInRun = 0;
this.skippedInRun = 0;
```

`getStatus()`는 기존 호환 필드도 유지한다.

```js
getStatus() {
  const activeWorkers = [...this.activeWorkers.values()];
  return {
    running: this.running,
    stopRequested: this.stopRequested,
    currentPostNo: activeWorkers.map((entry) => entry.postNo).join(','),
    activeWorkers,
    workerConcurrency: this.config.workerConcurrency,
    effectiveWorkerConcurrency: this.getWorkerCount(),
    parallelGeminiEnabled: this.config.disablePersistentWorker === true,
    completedInRun: this.completedInRun,
    failedInRun: this.failedInRun,
    skippedInRun: this.skippedInRun,
    startedAt: this.startedAt,
    lastUpdatedAt: this.lastUpdatedAt,
    lastMessage: this.lastMessage,
  };
}
```

기존 웹이 `currentPostNo`를 읽어도 깨지지 않게 문자열은 남긴다.

### 4.4 `server.mjs` worker loop

현재:

```text
start()
-> runLoop() 1개
```

변경:

```text
start()
-> runWorkers()
-> workerLoop(worker-1)
-> workerLoop(worker-2)
-> workerLoop(worker-3)
```

구조:

```js
getWorkerCount() {
  const requested = Math.max(1, Number(this.config.workerConcurrency) || 1);
  if (this.config.disablePersistentWorker !== true) {
    return 1;
  }
  return requested;
}

async runWorkers() {
  const workerCount = this.getWorkerCount();
  const workers = Array.from({ length: workerCount }, (_, index) => (
    this.workerLoop(`worker-${index + 1}`)
  ));
  const results = await Promise.allSettled(workers);
  // worker 하나가 throw해도 나머지 결과 정리
}
```

중요:

```text
GEMINI_DISABLE_PERSISTENT_WORKER=0
-> Gemini worker manager가 runExclusive()로 직렬 처리
-> runner worker를 여러 개 띄워도 실제 Gemini는 1개씩만 처리
-> 큐 항목만 여러 개 running으로 잡혀서 오히려 상태가 헷갈림
```

따라서 persistent worker가 켜져 있으면 effective worker count는 1로 강제한다.

예시:

```text
DRY_RUN_WORKER_CONCURRENCY=3
GEMINI_DISABLE_PERSISTENT_WORKER=0
-> requested=3
-> effective=1

DRY_RUN_WORKER_CONCURRENCY=3
GEMINI_DISABLE_PERSISTENT_WORKER=1
-> requested=3
-> effective=3
```

`getStatus()`에는 둘 다 보여주는 것이 좋다.

```text
workerConcurrency: 요청값
effectiveWorkerConcurrency: 실제 실행 worker 수
parallelGeminiEnabled: Gemini CLI 병렬 spawn 가능 여부
```

이 값은 단순 표시용이 아니라 동작 검증에도 필요하다.

예시:

```text
웹에서 workerConcurrency=3, effectiveWorkerConcurrency=1
-> 사용자가 3으로 설정했지만 persistent Gemini worker 때문에 실제 처리는 직렬

웹에서 workerConcurrency=3, effectiveWorkerConcurrency=3
-> Gemini persistent worker를 끄고 CLI spawn 병렬 처리 중
```

worker loop:

```js
async workerLoop(workerId) {
  while (!this.stopRequested) {
    const item = await this.queue.claimNextQueued(workerId);
    if (!item) {
      return;
    }

    this.activeWorkers.set(workerId, {
      workerId,
      postNo: item.postNo,
      startedAt: new Date().toISOString(),
    });

    try {
      const outcome = await this.processItem(item, workerId);
      // outcome: completed | skipped | failed
    } finally {
      this.activeWorkers.delete(workerId);
      this.lastUpdatedAt = new Date().toISOString();
    }

    if (!this.stopRequested) {
      await this.waitBetweenItems(item.postNo, workerId);
    }
  }
}
```

`processItem()`은 현재 return이 없다. 병렬 상태 카운트를 정확히 하려면 결과 문자열을 반환하도록 바꾼다.

```text
정상 판정 완료 -> completed
이미 삭제/접근 불가 -> skipped
Gemini 실패/런타임 실패 -> failed
```

`workerLoop()`는 `processItem()` 결과로 카운터를 올린다.

```text
completed -> completedInRun += 1
skipped -> skippedInRun += 1
failed -> failedInRun += 1
```

`processItem()` 내부에서 예상하지 못한 예외가 밖으로 새면 worker loop가 한 번 더 방어한다.

```js
try {
  const outcome = await this.processItem(item, workerId);
  this.incrementOutcome(outcome);
} catch (error) {
  await this.queue.markFailed(item.postNo, error?.message || String(error));
  this.failedInRun += 1;
  this.lastMessage = `${workerId} 게시글 ${item.postNo} 처리 실패: ${error?.message || String(error)}`;
}
```

예시:

```text
store.upsertRecord() 자체가 파일 권한 문제로 throw
-> processItem() catch도 못 잡고 밖으로 throw
-> workerLoop catch에서 queue는 failed로 정리
-> 다른 worker는 계속 진행
```

### 4.5 stop 동작

현재:

```text
requestStop()
-> stopRequested=true
-> 현재 처리 중인 글 이후 정지 요청됨
```

변경 후도 동일하다.

단, 병렬 worker에서는 “현재 처리 중인 글들 이후 정지”가 된다.

예시:

```text
worker-1: 1159880 처리 중
worker-2: 1159881 처리 중
worker-3: 1159882 처리 중
사용자가 stop
-> 세 worker는 현재 글까지는 마침
-> 새 claim은 하지 않음
```

Gemini CLI child process를 강제 kill하지는 않는다. 현재 구현도 즉시 kill 구조가 아니므로 기존 흐름을 유지한다.

정지 요청의 의미는 “새로 시작하지 않음”이 아니라 “새 claim을 최대한 막음”이다.

이미 `claimNextQueued()`가 끝난 항목은 현재 처리 중인 글로 본다.

예시:

```text
worker-2가 claimNextQueued()로 1159883을 running 처리
그 직후 사용자가 stop
-> 1159883은 이미 현재 처리 중인 글로 간주
-> 1159883까지 끝낸 뒤 worker-2 종료
```

이렇게 잡아야 별도 `releaseClaim()` 없이도 큐 상태가 단순해진다.

### 4.6 `judge.mjs` runExclusive 우회

현재:

```js
const cliResult = await getGeminiWorkerManager(runtimeConfig).runExclusive(runJudgeSequence);
```

변경:

```js
const cliResult = runtimeConfig.disablePersistentWorker === true
  ? await runJudgeSequence(null)
  : await getGeminiWorkerManager(runtimeConfig).runExclusive(runJudgeSequence);
```

이 변경이 실제 병렬화의 핵심이다.

예시:

```text
GEMINI_DISABLE_PERSISTENT_WORKER=1
worker-1 -> Gemini CLI process A spawn
worker-2 -> Gemini CLI process B spawn
worker-3 -> Gemini CLI process C spawn
```

반대로 persistent worker를 켜면:

```text
GEMINI_DISABLE_PERSISTENT_WORKER=0
-> 기존 runExclusive 유지
-> Gemini worker 세션 안전성 우선
-> 사실상 Gemini 판정은 직렬
```

이 우회는 이미지 분석과 최종 판정 전체에 적용된다.

현재 `runJudgeSequence()`는 아래 두 Gemini 호출을 순서대로 수행한다.

```text
1. runImageAnalysis()
2. 최종 dry-run 판정 runGeminiCli()
```

`disablePersistentWorker=true`일 때는 worker마다 자기 시퀀스를 직접 실행한다.

```text
worker-1: 이미지 분석 CLI -> 최종 판정 CLI
worker-2: 이미지 분석 CLI -> 최종 판정 CLI
worker-3: 이미지 분석 CLI -> 최종 판정 CLI
```

한 게시물 안에서는 순서가 유지되고, 게시물끼리만 병렬화된다.

실시간 병렬 dry-run 실행 명령은 아래처럼 둔다.

```bash
cd /mnt/c/users/eorb9/projects/dc_defense_suite_repo/projects/ai_moderator_dry_run
DRY_RUN_LIVE_POLL_ENABLED=1 \
DRY_RUN_WORKER_CONCURRENCY=3 \
GEMINI_DISABLE_PERSISTENT_WORKER=1 \
GEMINI_ARGS_JSON='["--model","gemini-2.5-flash"]' \
node server.mjs
```

### 4.7 실패 record의 `review` 처리

현재 `server.mjs`는 실패/스킵 시 기록을 이렇게 남긴다.

```text
Gemini 실패 -> effectiveDecision=review
runtime 실패 -> effectiveDecision=review
이미 삭제 skip -> effectiveDecision=review
```

최근 목표는 “AI 관리자 대체 dry-run에서 review를 최종 판단으로 남기지 않기”에 가깝다.

하지만 실패와 스킵은 Gemini 판단 결과가 아니라 시스템 상태다.

권장 정리:

```text
completed 판정:
  action 또는 no_action만 사용

failed/skipped:
  status로 실패/스킵을 표현
  effectiveDecision은 no_action으로 두거나 기존 review 유지 여부를 별도 결정
```

이번 병렬화 패치의 필수 범위는 아니다. 다만 웹에서 “검토 필요”가 계속 보이는 원인 중 하나이므로, 병렬화 후 바로 정리하는 것이 좋다.

추천:

```text
이미 삭제 skipped:
  status=skipped
  effectiveDecision=no_action
  decision=deny
  displayDecision=스킵

Gemini 실패 failed:
  status=failed
  effectiveDecision=no_action
  decision=deny
  displayDecision=실패
```

이렇게 해야 “운영자 검토”처럼 보이지 않는다.

### 4.8 runner 종료 직전 live enqueue race 방지

현재 live poller는 새 글을 큐에 추가한 뒤 runner가 꺼져 있을 때만 `runner.start()`를 호출한다.

```js
if (enqueueResult.added > 0 && !this.runner.running) {
  await this.runner.start();
}
```

병렬 runner에서는 아래 경계 상황이 생길 수 있다.

```text
1. 모든 worker가 큐 없음 판단 후 종료 직전
2. 이 순간 runner.running은 아직 true
3. live poller가 새 글 1개를 queue에 추가
4. live poller는 runner.running=true라 start 안 함
5. runner가 바로 running=false로 종료
6. 큐에는 queued 글이 남았지만 새 runner가 없음
```

이 race를 막기 위해 `runWorkers()` finally에서 `running=false`로 내린 뒤 큐를 한 번 더 확인한다.

권장 구조:

```js
async runWorkers() {
  try {
    const workerCount = this.getWorkerCount();
    const workers = Array.from({ length: workerCount }, (_, index) => (
      this.workerLoop(`worker-${index + 1}`)
    ));
    await Promise.allSettled(workers);
  } finally {
    const wasStopRequested = this.stopRequested;
    this.running = false;
    this.activeWorkers.clear();
    this.lastUpdatedAt = new Date().toISOString();

    if (wasStopRequested) {
      this.lastMessage = '정지됨';
      return;
    }

    const summary = await this.queue.getStatusSummary();
    if (summary.queued > 0) {
      this.lastMessage = `종료 직전 queued ${summary.queued}개 감지, runner 재시작`;
      void this.start();
      return;
    }

    this.lastMessage = 'queued 항목 없음';
  }
}
```

예시:

```text
worker들이 다 끝나서 종료하려는 순간 1159890이 큐에 들어옴
-> finally에서 running=false
-> summary.queued=1 확인
-> runner.start() 재호출
-> 1159890 처리 시작
```

이렇게 해야 live polling이 10초마다 계속 들어오는 상황에서도 큐가 고립되지 않는다.

### 4.9 웹 표시 연결

현재 `server.mjs`는 `/dry-run` 렌더링 때 이미 아래 값을 넘긴다.

```js
renderDryRunListPage({
  records,
  nextCursor,
  total,
  stats,
  currentFilter,
  queueStatus,
  runnerStatus,
})
```

하지만 `transparency.mjs`의 `renderTransparencyListPage()`는 현재 `queueStatus`, `runnerStatus`를 destructuring하지 않아서 실제 웹에는 표시되지 않는다.

따라서 웹에서도 병렬 진행 상황을 보려면 아래 패치가 필요하다.

```js
function renderTransparencyListPage({
  records,
  nextCursor,
  total,
  stats = null,
  healthStatus,
  currentFilter = '',
  reporterRanking = [],
  queueStatus = null,
  runnerStatus = null,
}) {
  ...
}
```

그리고 상단 또는 사이드바에 작은 상태 박스를 추가한다.

표시 예시:

```text
큐 상태: queued 4 / running 3 / completed 120 / failed 2
Runner: 실행 중, worker 3개
active: worker-1=1159880, worker-2=1159881, worker-3=1159882
```

이 패치를 안 해도 `/api/status`에서는 확인 가능하지만, 사용자가 웹만 볼 때 병렬 처리 중인지 알기 어렵다.

## 5. 실제 처리 예시

### 5.1 live polling으로 새 글 5개가 들어온 경우

큐:

```text
1159880 queued
1159881 queued
1159882 queued
1159883 queued
1159884 queued
```

workerConcurrency=3:

```text
worker-1 claim -> 1159880 running
worker-2 claim -> 1159881 running
worker-3 claim -> 1159882 running
```

1159881이 먼저 끝나면:

```text
worker-2 markCompleted(1159881)
worker-2 jitter 350~1400ms
worker-2 claim -> 1159883 running
```

1159880이 늦어도 다른 worker는 막히지 않는다.

### 5.2 새 글이 처리 중 계속 올라오는 경우

10초 poll:

```text
poll #1 -> 1159880~1159882 큐 추가
runner start
worker 3개 실행

poll #2 -> 1159883~1159885 큐 추가
runner는 이미 running이라 start 안 함
기존 worker가 다음 claim 때 새 queued 항목을 가져감
```

새 글이 들어와도 별도 runner를 또 만들지 않는다.

### 5.3 서버 재시작

현재 `queue.init()`은 `resetRunningOnStartup()`을 호출한다.

```text
running 상태였던 항목 -> failed
lastError='서버 재시작으로 running 상태 정리'
```

병렬 worker 도입 후에도 그대로 유효하다.

예시:

```text
서버 종료 전:
1159880 running by worker-1
1159881 running by worker-2

서버 재시작:
1159880 failed
1159881 failed

관리자가 retry-failed 호출:
1159880 queued
1159881 queued
```

## 6. 논리 검증 및 엣지케이스

아래 케이스를 패치 전후로 정적 검증한다.

1. 큐가 비어 있으면 worker 1~N 모두 조용히 종료한다.
2. `workerConcurrency=1`이면 기존 직렬 처리와 같은 순서로 동작한다.
3. `workerConcurrency=3`이면 동시에 최대 3개만 `running`이 된다.
4. 두 worker가 같은 글을 claim하지 않는다.
5. `claimNextQueued()` 중 하나가 persist 중이어도 다음 worker가 같은 항목을 가져가지 않는다.
6. `enqueuePosts()`가 running 항목을 force 없이 덮어쓰지 않는다.
7. live polling이 runner 실행 중 새 글을 추가해도 runner를 중복 시작하지 않는다.
8. runner가 이미 running일 때 `/api/run`을 눌러도 새 worker 묶음이 또 생기지 않는다.
9. `/api/stop`은 새 claim만 막고 현재 Gemini CLI 판정은 끝까지 기다린다.
10. worker 하나에서 fetch 404가 나도 다른 worker는 계속 진행한다.
11. fetch 404는 `이미 삭제`로 skipped 처리한다.
12. 이미지 다운로드 실패가 한 worker에서 발생해도 다른 worker 이미지 다운로드와 충돌하지 않는다.
13. `judgeInputDir` 임시 이미지 파일명은 `randomUUID()`라 worker 간 충돌하지 않는다.
14. thumbnail 파일명은 `dryrun-${postNo}.webp`라 같은 postNo만 덮고, 다른 postNo와 충돌하지 않는다.
15. record id도 `dryrun-${postNo}`라 같은 글 재처리 시 최신 결과로 upsert된다.
16. `store.persist()`가 writePromise로 파일 쓰기를 순서대로 처리한다.
17. 큐 파일 쓰기도 writePromise로 순서대로 처리한다.
18. Gemini CLI timeout이 나면 해당 항목만 failed가 되고 worker는 다음 항목으로 넘어간다.
19. `Gemini CLI 출력에서 JSON object를 추출하지 못했습니다`도 해당 항목만 failed가 된다.
20. `GEMINI_DISABLE_PERSISTENT_WORKER=1`일 때 `runExclusive()`를 우회해야 실제 병렬 spawn이 된다.
21. `GEMINI_DISABLE_PERSISTENT_WORKER=0`이면 기존 persistent worker 안전성을 위해 effective worker count를 1로 강제한다.
22. `GEMINI_WORKER_PREWARM_ENABLED=1`이어도 `GEMINI_DISABLE_PERSISTENT_WORKER=1`이면 prewarm은 attempted=false가 된다.
23. confidence threshold 미달 allow는 no_action으로 떨어진다.
24. Gemini가 `policy_ids=[]`를 주면 `NONE`으로 보정되고 deny/no_action이 된다.
25. Gemini가 실수로 `review`를 주면 정책 ID가 있으면 allow 후보, 없으면 deny로 자동 보정된다.
26. `validateJudgeDecision()`의 P15 단독 review 보정은 이후 automation normalization에서 allow로 승격될 수 있다.
27. failed/skipped record가 review로 보이는 기존 문제는 병렬화와 별개로 정리 필요하다.
28. live poll seed 직후에는 현재 1페이지 글을 큐에 넣지 않는다.
29. 서버 재시작 후 seed는 새 기준선을 다시 잡고, 기존 record는 그대로 남긴다.
30. 새 글 번호가 baseline보다 작거나 같으면 큐에 넣지 않는다.
31. 이미 record가 있는 글은 live polling에서 다시 큐에 넣지 않는다.
32. `/api/status`는 기존 필드 `currentPostNo`를 유지해서 웹 호환성을 깨지 않는다.
33. active worker 목록은 추가 필드라 기존 프론트가 무시해도 문제 없다.
34. 너무 높은 동시성은 Gemini CLI/네트워크 실패율을 올릴 수 있으므로 env 상한을 둔다.
35. `DRY_RUN_WORKER_CONCURRENCY`가 잘못된 값이면 기본 1로 떨어져야 한다.
36. worker loop 하나가 예외를 throw해도 `Promise.allSettled()`로 runner 종료 정리를 한다.
37. worker가 `processItem()` finally에서 activeWorkers를 반드시 제거한다.
38. stop 요청 후 worker가 jitter 중이면 다음 claim 전에 빠져나온다.
39. 수동 `/api/scan`으로 1~100페이지를 넣어도 claim 순서는 `createdAt -> page -> postNo` 기준으로 FIFO 유지한다.
40. live polling은 새 글을 큐에 넣은 순서대로 처리되며 최신글 우선으로 뒤집히지 않는다.
41. `resetRunningOnStartup()`은 `init()` 내부에서 호출되므로 `withMutation()`으로 감싸지 않는다.
42. completed/skipped/failed 상태에서는 `workerId`를 비우고 `lastWorkerId`만 남겨 현재 처리 중인 worker와 헷갈리지 않게 한다.
43. runner 종료 직전 live poller가 새 글을 enqueue해도 finally의 queued 재확인으로 runner가 다시 시작된다.
44. live poller가 `runner.running=false`를 본 뒤 start하고, runner finally도 동시에 start하려 해도 `start()`의 running guard로 중복 worker 묶음이 생기지 않는다.
45. `processItem()` 밖으로 예외가 새도 worker loop catch가 해당 item을 failed로 정리한다.
46. `transparency.mjs`는 현재 `queueStatus`, `runnerStatus`를 무시하므로 웹 표시를 원하면 렌더러 destructuring과 상태 박스 추가가 필요하다.
47. `/api/status`에는 active worker가 보이고, `/dry-run` 웹에도 같은 active worker 요약이 보여야 한다.
48. failed/skipped를 no_action으로 정리할 경우 stats의 review 수가 줄고, status는 failed/skipped로 별도 표시되어야 한다.
49. `workerConcurrency=3`이어도 `disablePersistentWorker=false`면 active worker는 최대 1개여야 한다.
50. `workerConcurrency=3`이고 `disablePersistentWorker=true`면 active worker가 최대 3개까지 올라갈 수 있어야 한다.

## 7. 검증 절차

### 7.1 구문 검사

```bash
cd /mnt/c/users/eorb9/projects/dc_defense_suite_repo/projects/ai_moderator_dry_run
npm run check
```

통과 기준:

```text
server.mjs
queue.mjs
judge.mjs
db.mjs
transparency.mjs
모두 SyntaxError 없음
```

### 7.2 큐 중복 claim 정적 테스트

간단한 임시 큐 파일로 아래 시나리오를 확인한다.

```text
queued 5개 생성
Promise.all([
  queue.claimNextQueued('worker-1'),
  queue.claimNextQueued('worker-2'),
  queue.claimNextQueued('worker-3')
])
```

기대값:

```text
반환 postNo 3개가 전부 달라야 함
queue summary:
  running=3
  queued=2
```

### 7.3 실제 live 테스트

실행:

```bash
cd /mnt/c/users/eorb9/projects/dc_defense_suite_repo/projects/ai_moderator_dry_run
DRY_RUN_LIVE_POLL_ENABLED=1 \
DRY_RUN_WORKER_CONCURRENCY=3 \
GEMINI_DISABLE_PERSISTENT_WORKER=1 \
GEMINI_ARGS_JSON='["--model","gemini-2.5-flash"]' \
node server.mjs
```

상태 확인:

```bash
curl -fsS http://127.0.0.1:4327/api/status
```

기대값:

```json
{
  "runner": {
    "running": true,
    "workerConcurrency": 3,
    "effectiveWorkerConcurrency": 3,
    "activeWorkers": [
      { "workerId": "worker-1", "postNo": "..." },
      { "workerId": "worker-2", "postNo": "..." }
    ]
  }
}
```

`activeWorkers.length`는 0~3 사이여야 한다.

큐가 비면:

```text
runner.running=false
runner.lastMessage='queued 항목 없음'
```

### 7.4 웹 확인

주소:

```text
http://127.0.0.1:4327/dry-run
```

확인할 것:

```text
결과 카드가 계속 추가되는지
이미지 썸네일이 깨지지 않는지
AI 조치 대상/문제 없음/실패/스킵 수가 맞는지
같은 postNo가 중복 카드로 생기지 않는지
상태 박스에 queued/running/completed/failed 수가 보이는지
active worker 목록이 worker-1=글번호 형태로 보이는지
```

## 8. 롤백 전략

병렬화 후 문제가 생기면 env만 바꿔 즉시 직렬로 되돌린다.

```bash
DRY_RUN_WORKER_CONCURRENCY=1
```

`judge.mjs`의 `GEMINI_DISABLE_PERSISTENT_WORKER=0`도 기존 persistent worker 직렬 구조로 돌아가는 안전장치다.

즉, 코드 패치 후에도 아래 두 방식으로 보수적으로 운용할 수 있다.

```text
완전 기존식:
DRY_RUN_WORKER_CONCURRENCY=1
GEMINI_DISABLE_PERSISTENT_WORKER=0

직렬 spawn:
DRY_RUN_WORKER_CONCURRENCY=1
GEMINI_DISABLE_PERSISTENT_WORKER=1

병렬 spawn:
DRY_RUN_WORKER_CONCURRENCY=3
GEMINI_DISABLE_PERSISTENT_WORKER=1
```

## 9. 작업 순서

실제 패치 순서는 아래가 안전하다.

1. `queue.mjs`에 `mutationPromise`, `withMutation()`, `claimNextQueued()` 추가.
2. `enqueuePosts()`, `patchItem()`, `requeueFailedAndSkipped()`도 `withMutation()` 경유로 변경.
3. `queue.mjs`의 `normalizeQueueItem()`에 `workerId`, `runningStartedAt`, `lastWorkerId` 보존 추가.
4. `server.mjs`에 `DRY_RUN_WORKER_CONCURRENCY` config와 `normalizeBoundedPositiveInt()` 추가.
5. `DryRunRunner`를 `runWorkers()` + `workerLoop(workerId)` 구조로 변경.
6. `processItem()`이 `completed/skipped/failed` outcome을 반환하게 변경.
7. `getStatus()`에 `activeWorkers`, `workerConcurrency`, `effectiveWorkerConcurrency`, `parallelGeminiEnabled` 추가하되 `currentPostNo` 유지.
8. `disablePersistentWorker=false`일 때 effective worker count를 1로 강제하는 `getWorkerCount()` 추가.
9. `runWorkers()` finally에 `running=false` 후 queued 재확인/재시작 방어를 추가.
10. `judge.mjs`에서 `disablePersistentWorker`일 때 `runExclusive()` 우회.
11. `transparency.mjs`에서 `queueStatus`, `runnerStatus`를 받아 웹 상태 박스를 표시.
12. `npm run check`.
13. 임시 큐 claim 테스트.
14. 실제 `DRY_RUN_WORKER_CONCURRENCY=3` live 테스트.

## 10. 최종 판단

병렬화는 가능하다.

다만 단순히 runner loop만 여러 개 띄우면 안 된다.

반드시 같이 바꿔야 하는 지점:

```text
큐 claim 원자화
Gemini runExclusive 우회
runner active worker 상태 관리
runner 종료 직전 queued 재확인
웹 상태 표시 연결
```

이 다섯 가지가 들어가면 새 글 polling 구조는 그대로 두고도 아래처럼 동작한다.

```text
10초마다 새 글 감지
-> queue에 FIFO로 추가
-> 최대 3개 Gemini CLI가 병렬 판정
-> 결과는 기존 dry-run 웹에 그대로 누적
-> 실제 삭제/차단은 계속 없음
```
