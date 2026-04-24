# 0424 댓글 방어 / 게시글 분류 수동 시간제한 구현 문서

작성일: 2026-04-24
기준 브랜치: `agent/manual-defense-time-limit-docs-0424`
목표: 팝업에서 관리자가 직접 켠 `댓글 방어`와 `게시글 분류`에만 기본 30분 시간제한을 걸고, 자동 감시가 공격 대응 중인 실행은 시간제한으로 꺼지지 않게 한다.

## 결론

가능하다. 다만 `currentSource === 'manual'`만 보고 시간제한을 걸면 안 된다.

현재 실제 로직상 `댓글 감시 자동화`와 `게시글 감시 자동화`는 child 스케줄러를 `source: 'monitor'`로 시작하거나 실행 중인 child의 source를 `monitor`로 바꾼다. 이 경우 수동 시간제한이 적용되면 안 된다.

반대로 `명령 방어(trusted-comment-command-defense)`는 child 스케줄러를 `source: 'manual'`로 시작한다. 그래서 source만 보면 "수동"처럼 보이지만, 실제로는 trusted-command가 `ownedPostScheduler`, `ownedCommentScheduler`, `postDefenseUntilTs`, `commentDefenseUntilTs`로 따로 소유하고 10분 유지 시간을 관리한다. 여기에 새 30분 수동 시간제한이 섞이면 기존 명령 방어 로직을 건드릴 수 있다.

따라서 구현 기준은 아래처럼 잡아야 한다.

- 팝업에서 관리자가 직접 켠 실행: `source: 'manual'` + `manualTimeLimit: true`
- 감시 자동화가 켠 실행: `source: 'monitor'` + `manualTimeLimit` 없음
- trusted-command가 켠 실행: `source: 'manual'`이지만 `manualTimeLimit` 없음

예시:

- 13:00에 관리자가 팝업에서 댓글 방어를 켜면 `manualTimeLimitExpiresAt = 13:30`으로 저장한다. 13:30이 지나도 계속 "팝업 수동 실행" 상태면 자동으로 정지한다.
- 13:10에 댓글 감시 자동화가 공격을 감지해서 댓글 방어를 넘겨받으면 `currentSource`가 `monitor`가 되고 수동 시간제한 lease를 지운다. 그래서 13:30이 되어도 공격 대응 중인 댓글 방어는 꺼지지 않는다.
- trusted-command의 `@특갤봇 댓글방어`가 댓글 방어를 켜면 기존처럼 trusted-command의 `holdMs` 기준으로만 꺼진다. 새 30분 수동 시간제한은 적용하지 않는다.

## 2차 논리 검증에서 보강한 결론

문서 초안의 큰 방향은 맞지만, 그대로 구현하면 빠질 수 있는 연결 문제가 있었다. 아래 항목은 구현 시 필수로 반영한다.

1. 만료 정리는 `isRunning = false`와 lease clear만으로 끝내면 안 된다. 기존 `stop()`이 하던 VPNGate consumer 해제, reflux/search runtime reset, pending transition cancel까지 같은 수준으로 정리해야 한다.
2. 댓글 방어는 `processPostsInParallel()` worker가 여러 개라 만료 체크가 동시에 여러 곳에서 걸릴 수 있다. `manualTimeLimitStopping` 같은 idempotent guard 없이 각 worker가 `stop()`을 직접 호출하면 중복 로그/중복 release가 생길 수 있다.
3. 현재 팝업의 댓글/게시글 수동 시작은 dirty 설정을 확인하지 않는다. 관리자가 제한 시간을 바꾸고 저장하지 않은 채 ON 하면 이전 저장값으로 시작한다. 수동 시간제한은 리스크 관리 설정이므로 start 전에 저장 요구 또는 자동 저장이 필요하다. 이 문서는 "저장 먼저 요구" 방식을 권장한다.
4. 실행 중 `manualTimeLimitMinutes` 변경은 현재 실행의 만료시각과 UI 설정값이 달라지는 혼동을 만든다. 이 문서는 댓글/게시글 실행 중에는 시간제한 분 변경을 막고, 정지 후 변경하도록 안내하는 방식을 권장한다.
5. 시간제한 자동 종료는 현재 API 구조상 "협력적 정지"다. 이미 시작된 fetch/delete/classify 요청을 중간 abort하지는 못한다. 만료 직후 새 page/post/batch를 시작하지 않도록 loop 경계마다 체크하되, in-flight 요청 1개는 완료될 수 있음을 검증 문서에 남긴다.
6. `popup/popup.html`은 `<script src="popup.js"></script>`인 일반 script다. popup에서 background/scheduler helper를 import하는 설계는 맞지 않는다. popup clamp helper는 popup 안에 두거나 전역 스크립트 구조를 바꾸지 않는 방식으로 처리한다.

## 현재 실제 로직 요약

### 1. 팝업 수동 시작 경로

`popup/popup.js`

- 기본 댓글 방어 토글은 `source: 'manual'`, `commentAttackMode: 'default'`로 시작한다.
- 댓글 quick mode인 `한글제외 유동닉댓글 삭제`, `역류기 공용 matcher 공격`도 `source: 'manual'`로 시작한다.
- 기본 게시글 분류 토글은 `source: 'manual'`, `attackMode: 'default'`로 시작한다.
- 게시글 quick mode인 `중국어/한자 공격`, `역류기 공격`, `1페이지 전체 검사`도 `source: 'manual'`로 시작한다.

현재 코드 위치:

- `popup/popup.js` `bindCommentEvents()`
  - 기본 댓글 토글: `source: 'manual'`
  - 댓글 quick mode 시작: `source: 'manual'`
- `popup/popup.js` `bindPostEvents()`
  - 기본 게시글 토글: `source: 'manual'`
  - 게시글 quick mode 시작: `source: 'manual'`

여기가 새 플래그를 붙일 위치다.

```js
{
  action: 'start',
  source: 'manual',
  commentAttackMode: 'default',
  manualTimeLimit: true,
}
```

```js
{
  action: 'start',
  source: 'manual',
  attackMode: 'default',
  manualTimeLimit: true,
}
```

### 2. background start 전달 경로

`background/background.js`의 `case 'start'`는 댓글/게시글 start option을 scheduler로 넘긴다.

현재 댓글:

```js
await scheduler.start({
  source: message.source,
  commentAttackMode: normalizedCommentAttackMode,
  excludePureHangulOnStart: message.excludePureHangulOnStart,
});
```

현재 게시글:

```js
await scheduler.start({
  source: message.source,
  attackMode: message.attackMode,
});
```

구현 시 `manualTimeLimit: message.manualTimeLimit === true`를 그대로 전달하면 된다.

### 3. 댓글 방어 scheduler의 source 상태

`features/comment/scheduler.js`

- constructor에서 `this.currentSource = ''`
- `start(options)`에서 `this.currentSource = normalizeRunSource(options.source, 'manual')`
- `stop()`에서 `this.currentSource = ''`
- `setCurrentSource(source)`가 있어서 실행 중인 댓글 방어를 감시 자동화가 `monitor` source로 넘겨받을 수 있다.
- `saveState()` / `loadState()` / `getStatus()`에 `currentSource`, `currentAttackMode`가 이미 포함되어 있다.

중요한 지점:

- `start()`에서 수동 시간제한 lease를 만들 수 있다.
- `stop()`에서 lease를 반드시 지워야 한다.
- `setCurrentSource('monitor')`가 호출될 때 lease를 반드시 지워야 한다.
- `loadState()`에서 만료된 lease가 있으면 복원하지 말고 정지 상태로 정리해야 한다.

### 4. 게시글 분류 scheduler의 source 상태

`features/post/scheduler.js`

- constructor에서 `this.currentSource = 'manual'`
- `start(options)`에서 `normalizeStartOptions(options)` 결과로 `currentSource`, `currentAttackMode`를 세팅한다.
- `setMonitorAttackMode(attackMode)`는 실행 중인 게시글 분류를 감시 자동화 소유로 바꾸면서 `this.currentSource = 'monitor'`로 만든다.
- `clearRuntimeAttackMode()`는 `this.currentSource = 'manual'`, `this.currentAttackMode = DEFAULT`로 되돌린다.
- `saveState()` / `loadState()` / `getStatus()`에 `currentSource`, `currentAttackMode`가 이미 포함되어 있다.

중요한 지점:

- `start()`에서 수동 시간제한 lease를 만들 수 있다.
- `stop()`에서 lease를 반드시 지워야 한다.
- `setMonitorAttackMode()`가 호출될 때 lease를 반드시 지워야 한다.
- `clearRuntimeAttackMode()`에서도 stale lease가 남지 않도록 lease를 지우는 것이 안전하다.

### 5. 감시 자동화 child 시작 경로

댓글 감시 자동화:

`features/comment-monitor/scheduler.js`

- `ensureManagedDefenseStarted()`에서 댓글 방어를 `source: 'monitor'`로 시작한다.
- 이미 댓글 방어가 실행 중이면 `commentScheduler.setCurrentSource('monitor')`로 source를 바꾼다.
- `managedCommentStarted`가 true일 때만 자동 대응 종료 시 child를 stop한다.

게시글 감시 자동화:

`features/monitor/scheduler.js`

- `ensureManagedDefensesStarted()`에서 게시글 분류를 `source: 'monitor'`로 시작한다.
- 이미 게시글 분류가 실행 중이면 `postScheduler.setMonitorAttackMode(this.attackMode)`로 source를 `monitor`로 바꾼다.
- `managedPostStarted`가 true일 때만 자동 대응 종료 시 child를 stop한다.

이 구조 때문에 사용자가 걱정한 "공격을 계속 받는 중인데 수동 30분 타이머가 자동 대응을 꺼버리는 상황"은 피할 수 있다. 단, 구현에서 `monitor`로 넘어가는 순간 기존 수동 lease를 지우는 처리가 반드시 들어가야 한다.

### 6. background 수동 조작 lock

`background/background.js`의 `getMonitorManualLockMessage()`는 감시 자동화 실행 중 수동 start/stop/updateConfig/resetStats를 막고 있다.

- 게시글 감시 자동화 실행 중: `post`, `semiPost`, `ip` 수동 조작 차단
- 댓글 감시 자동화 실행 중: `comment` 수동 조작 차단
- trusted-command가 소유한 경우에는 일부 stop 예외가 있다.

즉 팝업 토글이 자동 대응 중에도 ON처럼 보일 수는 있지만, background lock이 수동 stop을 막는다. 새 시간제한 로직은 이 lock 바깥의 scheduler 내부에서 돌기 때문에 source/lease 구분을 확실히 해야 한다.

### 7. trusted-command 예외

`features/trusted-comment-command-defense/scheduler.js`

- 기본 `holdMs`는 600000ms, 즉 10분이다.
- 게시물방어는 `postScheduler.start({ source: 'manual', ... })`, `ipScheduler.start({ source: 'manual', ... })`로 child를 켠다.
- 댓글방어도 `commentScheduler.start({ source: 'manual', commentAttackMode: 'default' })`로 child를 켠다.
- `postDefenseUntilTs`, `commentDefenseUntilTs`와 `ownedPostScheduler`, `ownedCommentScheduler`로 소유권과 만료를 관리한다.

여기 때문에 `source === 'manual'`만으로 수동 시간제한을 적용하면 안 된다. trusted-command child는 source가 manual이어도 팝업 수동 실행이 아니다.

## 구현 설계

### 새 config

댓글 방어 config:

```js
manualTimeLimitMinutes: 30,
```

게시글 분류 config:

```js
manualTimeLimitMinutes: 30,
```

권장 normalize 규칙:

- 기본값: 30
- 허용 범위: 1분 이상 1440분 이하
- 빈 값/NaN/범위 밖 값: 30으로 fallback

이번 요구사항은 "수동 관리자 리스크 관리"가 목적이므로 0분 무제한 옵션은 기본 구현에 넣지 않는 쪽이 안전하다. 나중에 무제한이 필요하면 명시적으로 `0 = 제한 없음`을 추가하면 된다.

### 새 runtime state

댓글/게시글 scheduler 양쪽에 같은 개념을 둔다.

```js
this.manualTimeLimitRunId = '';
this.manualTimeLimitStartedAt = '';
this.manualTimeLimitExpiresAt = '';
this.manualTimeLimitStopping = false;
```

의미:

- `manualTimeLimitRunId`: 이번 수동 시간제한 실행을 구분하는 id
- `manualTimeLimitStartedAt`: 수동 시간제한이 시작된 시각 ISO string
- `manualTimeLimitExpiresAt`: 자동 정지될 시각 ISO string
- `manualTimeLimitStopping`: 만료 정리 중복 실행 방지 flag

`currentSource`만으로 판단하지 않고, `manualTimeLimitExpiresAt`이 살아 있는지를 함께 본다.

`manualTimeLimitStopping`은 runtime guard라 storage에 저장하지 않는다. `saveState()`에는 `manualTimeLimitRunId`, `manualTimeLimitStartedAt`, `manualTimeLimitExpiresAt`만 저장한다.

### start option

댓글/게시글 scheduler `start(options)`는 아래 option을 받는다.

```js
manualTimeLimit: true
```

시간제한 적용 조건:

```js
const source = normalizeRunSource(options.source, 'manual');
const shouldUseManualTimeLimit = source === 'manual' && options.manualTimeLimit === true;
```

즉 source가 manual이어도 flag가 없으면 시간제한을 만들지 않는다.

게시글 scheduler는 현재 `normalizeStartOptions()`가 raw source 문자열을 그대로 반환한다. 구현 시에는 여기서 source도 정규화하고 `manualTimeLimit`도 같이 normalize하는 편이 안전하다.

```js
function normalizeStartOptions(options = {}) {
  const source = normalizeRunSource(options?.source, 'manual');
  ...
  return {
    source,
    attackMode,
    cutoffPostNo,
    hasExplicitCutoff: hasExplicitCutoff && Number.isFinite(cutoffPostNo),
    manualTimeLimit: options.manualTimeLimit === true,
  };
}
```

댓글 scheduler도 `start()` 안에서 `normalizedSource`를 한 번만 계산하고 그 값을 `currentSource`와 lease 생성에 같이 써야 한다.

`setupManualTimeLimit()` 호출 위치도 중요하다. dataset preload, cutoff capture 같은 start preflight가 모두 성공한 뒤, `isRunning = true`와 `saveState()` 직전에 lease를 만든다. 그래야 start 실패가 stale lease를 남기지 않는다.

### start block guard

댓글/게시글 scheduler는 현재 `start()` 초반에 `this.isRunning`만 본다. 시간제한 만료 직후에는 `stop()`이 `isRunning = false`로 바꿨지만 `runPromise`가 아직 `finally()`까지 끝나지 않은 순간이 생길 수 있다.

background는 이미 start 전에 `scheduler.getStartBlockReason()`이 있으면 호출한다. 댓글/게시글에도 아래 helper를 추가하는 방식이 가장 깔끔하다.

```js
getStartBlockReason() {
  if (this.isRunning) {
    return '이미 실행 중입니다.';
  }

  if (this.runPromise) {
    return '이전 실행을 정리 중입니다. 잠시 후 다시 시도하세요.';
  }

  return '';
}
```

그리고 `start(options)` 안에서도 같은 helper를 확인한다.

```js
async start(options = {}) {
  const startBlockReason = this.getStartBlockReason();
  if (startBlockReason) {
    this.log(`⚠️ ${startBlockReason}`);
    return;
  }

  ...
}
```

예를 들어 13:30에 시간제한으로 자동 정지된 직후 관리자가 바로 ON을 눌렀을 때, 이전 loop가 정리 중이면 background가 `success: false`를 내려주고 popup은 다시 상태를 새로고침한다. 조용히 성공 처리하면 실제 run은 안 붙었는데 토글만 켜진 것처럼 보일 수 있다.

`runPromise` 정리 중에는 start block 로그를 저장하려고 `saveState()`를 또 호출하지 않는 쪽이 안전하다. stop 쪽의 `saveState()`가 아직 진행 중일 수 있기 때문이다.

### helper 함수

댓글/게시글 scheduler에 거의 같은 helper를 추가한다.

```js
setupManualTimeLimit(options = {}) {
  const source = normalizeRunSource(options.source, 'manual');
  if (source !== 'manual' || options.manualTimeLimit !== true) {
    this.clearManualTimeLimit();
    return;
  }

  const now = Date.now();
  const limitMinutes = normalizeManualTimeLimitMinutes(this.config.manualTimeLimitMinutes);
  this.manualTimeLimitRunId = `${now}-${Math.random().toString(36).slice(2)}`;
  this.manualTimeLimitStartedAt = new Date(now).toISOString();
  this.manualTimeLimitExpiresAt = new Date(now + limitMinutes * 60 * 1000).toISOString();
}

clearManualTimeLimit() {
  this.manualTimeLimitRunId = '';
  this.manualTimeLimitStartedAt = '';
  this.manualTimeLimitExpiresAt = '';
  this.manualTimeLimitStopping = false;
}

isManualTimeLimitActive() {
  return Boolean(
    this.isRunning
    && this.currentSource === 'manual'
    && this.manualTimeLimitExpiresAt
  );
}

getManualTimeLimitExpiresAtMs() {
  const parsed = Date.parse(this.manualTimeLimitExpiresAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

isManualTimeLimitExpired(now = Date.now()) {
  const expiresAtMs = this.getManualTimeLimitExpiresAtMs();
  return this.isManualTimeLimitActive() && expiresAtMs > 0 && expiresAtMs <= now;
}

getManualTimeLimitRemainingMs(now = Date.now()) {
  if (!this.isManualTimeLimitActive()) {
    return Infinity;
  }
  const expiresAtMs = this.getManualTimeLimitExpiresAtMs();
  return expiresAtMs > 0 ? Math.max(0, expiresAtMs - now) : 0;
}
```

`Math.random()`을 피하고 싶으면 repo에 이미 id helper가 있는지 먼저 검색해서 그걸 써도 된다. 없으면 위 정도면 scheduler 내부 lease 식별 용도로 충분하다.

만료 정리는 아래처럼 idempotent helper로 한 번만 실행한다.

```js
async stopIfManualTimeLimitExpired(now = Date.now()) {
  if (!this.isManualTimeLimitExpired(now)) {
    return false;
  }

  if (this.manualTimeLimitStopping) {
    return true;
  }

  this.manualTimeLimitStopping = true;
  const limitMinutes = normalizeManualTimeLimitMinutes(this.config.manualTimeLimitMinutes);
  await this.stop(`⏱️ 수동 실행 시간 제한 ${limitMinutes}분이 지나 자동 종료했습니다.`);
  return true;
}
```

댓글 방어는 worker가 여러 개라 같은 순간 여러 worker가 이 helper를 호출할 수 있다. `manualTimeLimitStopping` 없이 `stop()`을 직접 부르면 같은 로그가 여러 번 남거나 release/save가 중복 실행될 수 있다.

### stop reason

현재 댓글/게시글 `stop()`은 고정 로그를 남긴다. 자동 만료 로그를 구분하려면 optional reason을 받게 바꾸는 것이 좋다.

댓글:

```js
async stop(reason = '🔴 자동 삭제 중지.') {
  this.isRunning = false;
  ...
  this.clearManualTimeLimit();
  this.log(reason);
  await this.saveState();
}
```

게시글:

```js
async stop(reason = '🔴 자동 분류 중지.') {
  this.isRunning = false;
  ...
  this.clearManualTimeLimit();
  this.log(reason);
  await this.saveState();
}
```

만료 시 로그 예시:

- 댓글: `⏱️ 수동 실행 시간 제한 30분이 지나 댓글 방어를 자동 종료했습니다.`
- 게시글: `⏱️ 수동 실행 시간 제한 30분이 지나 게시글 분류를 자동 종료했습니다.`

여기서 `...`는 기존 stop 정리를 그대로 보존한다는 뜻이다. 만료 정리용 별도 helper를 만들더라도 아래 side effect는 빠지면 안 된다.

댓글 방어:

- `releaseAllKnownVpnGatePrefixConsumers()`
- `resetCommentRefluxSearchRuntime()`
- `setCommentRefluxSearchDuplicateBrokerLogger(null)`
- `currentSource = ''`
- `currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT`
- `clearManualTimeLimit()`
- `saveState()`

게시글 분류:

- `currentPage = 0`
- `cancelPendingRuntimeTransition(...)`
- `releaseAllKnownVpnGatePrefixConsumers()`
- `clearRuntimeAttackMode()`
- `resetSearchDuplicateRuntime()`
- `clearManualTimeLimit()`
- `saveState()`

특히 게시글 분류는 실행 중 `manualAttackMode` / `refluxSearchGalleryId` 변경이 `pendingRuntimeTransition`을 만들 수 있다. 시간제한 만료가 이 pending promise를 방치하면 popup 저장 요청이 오래 걸리거나 실패 메시지가 애매해질 수 있으므로 기존 stop처럼 반드시 cancel한다.

### run loop 만료 체크

Chrome extension MV3 service worker 환경에서는 긴 `setTimeout`에 의존하지 않는 것이 안전하다. 이미 scheduler들이 state를 저장하고 run loop를 복원하는 구조이므로, `expiresAt`을 저장하고 loop에서 확인하는 방식이 맞다.

이 정지는 hard abort가 아니라 cooperative stop이다. 이미 시작된 `fetchPostList`, `fetchAllComments`, `deleteComments`, `classifyPosts` 같은 in-flight 요청은 중간에 끊지 못하고 await가 끝난 뒤 다음 경계에서 멈춘다. 지금 범위에서는 새 요청을 더 시작하지 않는 것이 목표다. 만료 즉시 네트워크 요청까지 끊어야 한다면 각 API에 AbortController를 전달하는 별도 큰 변경이 필요하다.

댓글 `features/comment/scheduler.js`:

- `run()`의 `while (this.isRunning)` 진입 직후
- page loop의 각 page 처리 직전
- `processPostsInParallel()` worker loop 진입 직후
- `processPostInternal()`에서 긴 검색/삭제 단계로 들어가기 전
- `cycleDelay`, `requestDelay`, error retry delay를 기다리기 전/후

게시글 `features/post/scheduler.js`:

- `run()`의 `while (this.isRunning)` 진입 직후
- page loop의 각 page 처리 직전
- `classifyPostsOnce()` 이후 저장하기 전/후
- `applyPendingRuntimeTransitionIfNeeded()` 직전/직후. 단, 이미 transition 중이면 stop helper가 pending transition을 cancel해야 한다.
- `cycleDelay`, `requestDelay`, error retry delay를 기다리기 전/후

긴 delay overshoot를 줄이려면 `features/bump-post/scheduler.js`의 `delayWhileRunning()` 패턴을 참고해서 delay를 1초 단위 또는 남은 제한 시간 단위로 쪼개는 helper를 둔다.

예시:

```js
async function delayRespectingManualTimeLimit(scheduler, waitMs, delayFn = delay) {
  let remainingWaitMs = Math.max(0, Number(waitMs) || 0);
  while (scheduler.isRunning && remainingWaitMs > 0) {
    if (await scheduler.stopIfManualTimeLimitExpired()) {
      return true;
    }

    const remainingLimitMs = scheduler.getManualTimeLimitRemainingMs();
    const chunkMs = Math.min(1000, remainingWaitMs, remainingLimitMs);
    if (chunkMs <= 0) {
      return scheduler.stopIfManualTimeLimitExpired();
    }

    await delayFn(chunkMs);
    remainingWaitMs -= chunkMs;
  }

  return scheduler.stopIfManualTimeLimitExpired();
}
```

그리고 기존 `await delay(this.config.cycleDelay)` 같은 부분을 아래처럼 바꾼다.

```js
if (await delayRespectingManualTimeLimit(this, this.config.cycleDelay)) {
  break;
}
```

이렇게 해야 관리자가 cycleDelay를 크게 잡아도 30분 제한이 40분, 1시간 뒤에야 반영되는 일을 피할 수 있다.

댓글 worker에서 `await delay(this.config.requestDelay)`를 바꿀 때는 모든 worker가 같은 helper를 호출하므로 위의 `manualTimeLimitStopping` guard가 반드시 필요하다.

### loadState 복원 처리

`saveState()`에는 새 runtime state를 저장한다.

```js
manualTimeLimitRunId: this.manualTimeLimitRunId,
manualTimeLimitStartedAt: this.manualTimeLimitStartedAt,
manualTimeLimitExpiresAt: this.manualTimeLimitExpiresAt,
```

`loadState()`에서는 아래 순서가 안전하다.

1. 기존 `isRunning`, `config`, `currentSource`, `currentAttackMode`를 복원한다.
2. `manualTimeLimit*` 값을 복원한다.
3. source가 `manual`이 아니거나 `isRunning`이 아니면 lease를 지운다.
4. source가 `manual`이고 lease가 만료되어 있으면 stop과 같은 수준의 runtime cleanup을 수행한 뒤 state를 저장한다.

예시:

```js
this.manualTimeLimitRunId = String(schedulerState.manualTimeLimitRunId || '');
this.manualTimeLimitStartedAt = String(schedulerState.manualTimeLimitStartedAt || '');
this.manualTimeLimitExpiresAt = String(schedulerState.manualTimeLimitExpiresAt || '');

if (!this.isRunning || this.currentSource !== 'manual') {
  this.clearManualTimeLimit();
} else if (this.isManualTimeLimitExpired()) {
  await this.cleanupExpiredManualTimeLimitOnLoad();
  this.log('⏱️ 수동 실행 시간 제한이 이미 지나 자동 종료 상태로 복원했습니다.');
  await this.saveState();
}
```

`cleanupExpiredManualTimeLimitOnLoad()`는 `stop()`을 그대로 호출하기보다 loadState 전용 정리 helper로 둔다. `stop()`은 로그/저장/루프 상태를 전제로 한 동작이 섞여 있고, loadState 도중 다시 saveState를 부르는 순서가 꼬일 수 있기 때문이다.

댓글 loadState 만료 정리에서 필요한 최소 작업:

- `isRunning = false`
- `releaseAllKnownVpnGatePrefixConsumers()`
- `resetCommentRefluxSearchRuntime()`
- `setCommentRefluxSearchDuplicateBrokerLogger(null)`
- `currentSource = ''`
- `currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT`
- `clearManualTimeLimit()`

게시글 loadState 만료 정리에서 필요한 최소 작업:

- `isRunning = false`
- `currentPage = 0`
- `cancelPendingRuntimeTransition(...)`
- `releaseAllKnownVpnGatePrefixConsumers()`
- `clearRuntimeAttackMode()`
- `resetSearchDuplicateRuntime()`
- `clearManualTimeLimit()`

댓글/게시글 모두 `loadState()`가 만료 상태를 발견한 뒤에는 `resumeAllSchedulers()`의 `resumeStandaloneScheduler()`가 run loop를 다시 붙이지 않아야 한다. 즉 cleanup 후 `isRunning`이 false인지 확인하는 테스트가 필요하다.

### getStatus

팝업 표시와 테스트 편의를 위해 상태에 아래 값을 포함한다.

```js
const manualTimeLimitRemainingMs = this.getManualTimeLimitRemainingMs();

manualTimeLimitStartedAt: this.manualTimeLimitStartedAt,
manualTimeLimitExpiresAt: this.manualTimeLimitExpiresAt,
manualTimeLimitRemainingMs: Number.isFinite(manualTimeLimitRemainingMs)
  ? manualTimeLimitRemainingMs
  : 0,
manualTimeLimitActive: this.isManualTimeLimitActive(),
```

`getManualTimeLimitRemainingMs()`가 `Infinity`를 반환하는 경우 JSON/status에는 0으로 내려보내는 것이 다루기 쉽다.

UI에도 남은 시간을 보여주는 것이 좋다. 설정값만 보여주면 실행 중 제한값을 바꿨을 때 현재 run의 만료시각과 혼동할 수 있다.

권장 표시:

- 수동 시간제한 실행 중: `13:30:00 자동 종료` 또는 `남은 12분`
- 수동 실행이지만 lease 없음: `-`
- 자동 감시 source: `자동 대응`
- 정지 상태: `-`

## UI 변경

### popup.html

상태 grid에 현재 수동 제한 상태를 보여주는 항목을 추가한다.

댓글:

```html
<div class="status-item">
  <span class="status-label">수동 제한</span>
  <span id="commentManualTimeLimitText" class="status-value">-</span>
</div>
```

게시글:

```html
<div class="status-item">
  <span class="status-label">수동 제한</span>
  <span id="postManualTimeLimitText" class="status-value">-</span>
</div>
```

댓글 방어 설정 section에 숫자 input 추가:

```html
<div class="setting-item">
  <label for="commentManualTimeLimitMinutes">수동 실행 시간 제한(분)</label>
  <input type="number" id="commentManualTimeLimitMinutes" min="1" max="1440" value="30">
</div>
```

게시글 분류 설정 section에 숫자 input 추가:

```html
<div class="setting-item">
  <label for="postManualTimeLimitMinutes">수동 실행 시간 제한(분)</label>
  <input type="number" id="postManualTimeLimitMinutes" min="1" max="1440" value="30">
</div>
```

위치는 각 feature의 기존 settings grid 안이 적절하다.

- 댓글: `commentCycleDelay`, `commentRefluxSearchGalleryId`, `commentPostConcurrency` 근처
- 게시글: `postCycleDelay`, `postRefluxSearchGalleryId` 근처

### popup.js DOM mapping

`FEATURE_DOM.comment`에 추가:

```js
manualTimeLimitText: document.getElementById('commentManualTimeLimitText'),
manualTimeLimitMinutesInput: document.getElementById('commentManualTimeLimitMinutes'),
```

`FEATURE_DOM.post`에 추가:

```js
manualTimeLimitText: document.getElementById('postManualTimeLimitText'),
manualTimeLimitMinutesInput: document.getElementById('postManualTimeLimitMinutes'),
```

`getFeatureConfigInputs()`에도 추가해야 dirty tracking과 자동화 lock이 정상 동작한다.

댓글:

```js
dom.manualTimeLimitMinutesInput,
```

게시글:

```js
dom.manualTimeLimitMinutesInput,
```

### popup.js 설정 저장

댓글 저장 config에 추가:

```js
manualTimeLimitMinutes: clampManualTimeLimitMinutes(dom.manualTimeLimitMinutesInput.value),
```

게시글 저장 config에 추가:

```js
manualTimeLimitMinutes: clampManualTimeLimitMinutes(dom.manualTimeLimitMinutesInput.value),
```

간단 구현:

```js
function clampManualTimeLimitMinutes(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return 30;
  }
  return Math.max(1, Math.min(1440, parsed));
}
```

popup은 일반 script라 background/scheduler module helper를 import할 수 없다. 위 helper는 popup.js 안에 둔다. background와 scheduler에도 같은 범위의 local helper를 두거나, background/scheduler에서만 공유 가능한 별도 module을 만든다.

### popup.js status sync

`updateCommentUI(status)`의 `syncFeatureConfigInputs()` 배열에 추가:

```js
[dom.manualTimeLimitMinutesInput, status.config?.manualTimeLimitMinutes ?? 30],
```

`updatePostUI(status)`도 동일하게 추가한다.

남은 시간 표시도 업데이트한다.

```js
dom.manualTimeLimitText.textContent = formatManualTimeLimitStatus(status);
```

예시 helper:

```js
function formatManualTimeLimitStatus(status = {}) {
  if (!status.isRunning) {
    return '-';
  }

  if (status.currentSource !== 'manual') {
    return '자동 대응';
  }

  if (!status.manualTimeLimitActive || !status.manualTimeLimitExpiresAt) {
    return '-';
  }

  return `${formatTimestamp(status.manualTimeLimitExpiresAt)} 자동 종료`;
}
```

실행 중 설정값 변경은 background에서 막지만, UI에서도 오해를 줄이는 편이 좋다. `applyAutomationLocks(statuses)`에서 기존 lock을 유지하면서 수동 제한 input만 자기 기능 실행 중에도 비활성화한다. 이 코드는 `getFeatureConfigInputs('comment/post').forEach(...)`로 기존 automation lock을 적용한 뒤에 둔다.

```js
setDisabled(
  commentDom.manualTimeLimitMinutesInput,
  commentLocked || Boolean(commentStatus?.isRunning),
);

setDisabled(
  postDom.manualTimeLimitMinutesInput,
  postIpLocked || Boolean(postStatus?.isRunning),
);
```

기존 `getFeatureConfigInputs('comment/post')` 전체를 `status.isRunning`으로 잠그면 기존 실행 중 설정 저장 흐름까지 바뀐다. 이번 변경에서는 `manualTimeLimitMinutesInput`만 별도로 잠그는 것이 안전하다.

### popup.js start message

시간제한은 아래 수동 시작 버튼들에만 붙인다.

댓글:

- 기본 댓글 방어 토글 ON
- 한글제외 유동닉댓글 삭제 ON
- 역류기 공용 matcher 공격 ON

게시글:

- 기본 게시글 분류 토글 ON
- 중국어/한자 공격 ON
- 역류기 공격 ON
- 1페이지 전체 검사 ON

예시:

```js
response = await sendFeatureMessage('comment', {
  action: 'start',
  source: 'manual',
  commentAttackMode: attackMode,
  manualTimeLimit: true,
});
```

```js
response = await sendFeatureMessage('post', {
  action: 'start',
  source: 'manual',
  attackMode,
  manualTimeLimit: true,
});
```

IP 차단, 반고닉 분류, 감시 자동화, trusted-command에는 이번 변경을 적용하지 않는다.

start 전 dirty 설정 확인도 추가한다. 기존 댓글/게시글 토글은 dirty 상태를 보지 않고 바로 시작하므로, 시간제한 값을 바꾸고 저장하지 않은 상태에서 ON 하면 이전 저장값으로 시작한다.

권장 helper:

```js
async function shouldBlockManualStartForDirtyConfig(feature, label) {
  if (!DIRTY_FEATURES[feature]) {
    return false;
  }

  alert(`${label} 설정 변경분을 먼저 저장하세요.`);
  await refreshAllStatuses();
  return true;
}
```

적용 위치:

- 댓글 기본 토글 ON 직전
- 댓글 quick mode ON 직전
- 게시글 기본 토글 ON 직전
- 게시글 quick mode ON 직전

예시:

```js
if (action === 'start' && await shouldBlockManualStartForDirtyConfig('comment', '댓글 방어')) {
  return;
}
```

이 helper는 시간제한 input만 따로 보지 않고 `DIRTY_FEATURES.comment/post` 전체를 기준으로 막는다. 현재 구조에서 field별 dirty를 새로 만들지 않는다면 이 방식이 가장 단순하다. 예를 들어 `cycleDelay`를 10초로 바꾸고 저장하지 않은 채 ON 하는 경우도 이전 저장값으로 실행되므로, 같이 막히는 것이 오히려 일관적이다.

## source 전환 시 lease 정리

가장 중요한 방어선이다.

댓글:

`commentScheduler.setCurrentSource(source)`에서 nextSource가 `manual`이 아니면 `clearManualTimeLimit()`을 호출한다.

```js
const hadManualTimeLimit = Boolean(this.manualTimeLimitExpiresAt);
if (nextSource !== 'manual') {
  this.clearManualTimeLimit();
}

if (this.currentSource === nextSource) {
  return hadManualTimeLimit;
}

this.currentSource = nextSource;
```

핵심은 `currentSource`가 이미 `monitor`라 early return 되더라도 stale lease가 있으면 지우고 `true`를 반환해서 caller가 `saveState()`를 하게 만드는 것이다.

게시글:

`postScheduler.setMonitorAttackMode()`에서 source를 `monitor`로 바꾸기 전에/후에 `clearManualTimeLimit()`을 호출한다.

```js
const hadManualTimeLimit = Boolean(this.manualTimeLimitExpiresAt);
this.currentSource = 'monitor';
this.clearManualTimeLimit();
...
return sourceChanged || modeChanged || hadManualTimeLimit;
```

`postScheduler.clearRuntimeAttackMode()`에서도 `clearManualTimeLimit()`을 호출한다.

```js
clearRuntimeAttackMode() {
  this.currentSource = 'manual';
  this.currentAttackMode = ATTACK_MODE.DEFAULT;
  this.clearManualTimeLimit();
}
```

예시:

- 13:00 관리자가 게시글 분류를 수동 ON, 만료 13:30
- 13:10 게시글 감시 자동화가 공격 감지
- 기존 게시글 분류가 실행 중이라 `setMonitorAttackMode()`로 source가 `monitor`가 됨
- 이때 `clearManualTimeLimit()`이 실행됨
- 13:30에는 꺼지지 않음
- 공격 release 시 `monitor.stopManagedDefenses()`가 기존 자동 대응 규칙대로 꺼줌

## background 전달 변경

`background/background.js` start 분기에서 댓글/게시글에만 `manualTimeLimit`을 전달한다.

댓글:

```js
await scheduler.start({
  source: message.source,
  commentAttackMode: normalizedCommentAttackMode,
  excludePureHangulOnStart: message.excludePureHangulOnStart,
  manualTimeLimit: message.manualTimeLimit === true,
});
```

게시글:

```js
await scheduler.start({
  source: message.source,
  attackMode: message.attackMode,
  manualTimeLimit: message.manualTimeLimit === true,
});
```

이렇게 하면 trusted-command는 영향을 받지 않는다. trusted-command는 background start message를 거치지 않고 scheduler를 직접 호출하며, 새 flag를 넘기지 않기 때문이다.

## config normalize 위치

댓글 scheduler는 현재 constructor config와 `loadState()` merge에서 값들을 normalize한다. `manualTimeLimitMinutes`도 같은 흐름에 넣는다. 추가로 `background/background.js`의 `updateConfig`는 scheduler config를 직접 merge하므로, popup에서 값을 clamp하더라도 background나 scheduler 쪽에서 한 번 더 normalize해야 한다.

권장 함수:

```js
function normalizeManualTimeLimitMinutes(value, fallback = 30) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(1440, parsed));
}
```

댓글:

- constructor 기본 config에 `manualTimeLimitMinutes: 30`
- `loadState()`에서 `this.config.manualTimeLimitMinutes = normalizeManualTimeLimitMinutes(this.config.manualTimeLimitMinutes)`
- `start()`의 `setupManualTimeLimit()`에서 실제 만료시각을 계산할 때도 `normalizeManualTimeLimitMinutes(this.config.manualTimeLimitMinutes)`를 사용한다.

게시글:

- constructor 기본 config에 `manualTimeLimitMinutes: 30`
- `loadState()` config merge에서 `manualTimeLimitMinutes: normalizeManualTimeLimitMinutes(schedulerState?.config?.manualTimeLimitMinutes)`
- `start()`의 `setupManualTimeLimit()`에서 실제 만료시각을 계산할 때도 `normalizeManualTimeLimitMinutes(this.config.manualTimeLimitMinutes)`를 사용한다.

background:

- `message.feature === 'comment'` 또는 `message.feature === 'post'`이고 `message.config.manualTimeLimitMinutes !== undefined`이면 merge 전에 clamp한다.
- 이렇게 해야 popup이 아닌 직접 message에서도 status/config에 999999 같은 값이 남지 않는다.
- 댓글/게시글이 실행 중이고 `manualTimeLimitMinutes`가 기존값과 다르면 updateConfig를 막는다. 현재 실행의 만료시각은 시작 시 계산한 `manualTimeLimitExpiresAt`이라, 실행 중 설정값만 바뀌면 UI의 설정값과 실제 만료시각이 달라진다.

차단 위치는 `getConfigUpdateBlockMessage(feature, scheduler, config)`가 가장 자연스럽다. 이 helper는 이미 `updateConfig` case에서 `maybeHandleRunningPostModeTransition()`보다 먼저 호출되고, 문자열을 반환하면 background가 `success: false` 응답으로 바꿔준다.

예시:

```js
if (
  ['comment', 'post'].includes(feature)
  && scheduler.isRunning
  && config.manualTimeLimitMinutes !== undefined
  && Number(config.manualTimeLimitMinutes) !== Number(scheduler.config.manualTimeLimitMinutes)
) {
  return '수동 실행 시간 제한은 기능을 정지한 뒤 변경하세요.';
}
```

이렇게 해야 게시글 분류 실행 중 설정 저장이 들어왔을 때 시간제한 변경은 바로 거절되고, 공격 모드/역류 갤 변경만 기존 pending transition 흐름을 탄다.

게시글 분류의 `maybeHandleRunningPostModeTransition()`에는 새 시간제한 lease를 만들거나 만료시각을 연장하는 처리를 넣지 않는다. 실행 중 공격 모드/역류 검색 갤 전환이 일어나도 기존 `manualTimeLimitExpiresAt`은 그대로 유지한다.

## 구현 순서

1. `features/comment/scheduler.js`
   - config 기본값 추가
   - runtime field 추가
   - helper 추가
   - `start(options)`에서 preflight 성공 후 `setupManualTimeLimit(options)`
   - `getStartBlockReason()`을 추가하고 `start(options)`에서도 같은 helper를 확인해서 `this.isRunning || this.runPromise`이면 새 run을 만들지 못하게 처리
   - `stop(reason)`에서 기존 stop side effect를 보존하고 `clearManualTimeLimit()`
   - `stopIfManualTimeLimitExpired()`를 idempotent하게 추가
   - `setCurrentSource()`에서 source가 manual이 아니면 lease clear
   - `run()` / `processPostsInParallel()` delay와 loop에 만료 체크 추가
   - `saveState()` / `loadState()` / `getStatus()`에 runtime state 추가

2. `features/post/scheduler.js`
   - config 기본값 추가
   - runtime field 추가
   - helper 추가
   - `normalizeStartOptions()`에서 source와 `manualTimeLimit` normalize
   - `start(options)`에서 preflight 성공 후 `setupManualTimeLimit(normalizedOptions)`
   - `getStartBlockReason()`을 추가하고 `start(options)`에서도 같은 helper를 확인해서 `this.isRunning || this.runPromise`이면 새 run을 만들지 못하게 처리
   - `stop(reason)`에서 기존 stop side effect를 보존하고 `clearManualTimeLimit()`
   - `stopIfManualTimeLimitExpired()`를 idempotent하게 추가
   - `setMonitorAttackMode()` / `clearRuntimeAttackMode()`에서 lease clear
   - `run()` delay와 loop에 만료 체크 추가
   - `saveState()` / `loadState()` / `getStatus()`에 runtime state 추가

3. `background/background.js`
   - 댓글/게시글 start option에 `manualTimeLimit: message.manualTimeLimit === true` 전달
   - 댓글/게시글 updateConfig에서 `manualTimeLimitMinutes`를 1~1440으로 normalize
   - `getConfigUpdateBlockMessage()`에서 댓글/게시글 실행 중 `manualTimeLimitMinutes` 변경은 차단
   - resetStats는 실행 중 lease를 지우지 않는다. 통계 초기화는 실행 자체를 바꾸면 안 된다.

4. `popup/popup.html`
   - 댓글/게시글 설정에 `수동 실행 시간 제한(분)` input 추가
   - 댓글/게시글 status grid에 `수동 제한` 표시 추가

5. `popup/popup.js`
   - DOM mapping 추가
   - config input dirty tracking 추가
   - 설정 저장 config 추가
   - status sync 추가
   - 남은 수동 제한 표시 추가
   - 실행 중에는 `manualTimeLimitMinutesInput`만 비활성화
   - dirty 설정이 있으면 댓글/게시글 수동 start 차단
   - 댓글/게시글 팝업 수동 start message에 `manualTimeLimit: true` 추가

## 구현 후 검증 체크리스트

### 정적 확인

아래 검색으로 source-only 시간제한이 없는지 확인한다.

```bash
rg -n "manualTimeLimit|manualTimeLimitExpiresAt|setMonitorAttackMode|setCurrentSource|source: 'manual'|source: 'monitor'" features popup background
```

확인할 점:

- `manualTimeLimit` flag는 popup의 댓글/게시글 수동 start message에만 붙어야 한다.
- trusted-command의 `postScheduler.start({ source: 'manual' })`, `commentScheduler.start({ source: 'manual' })`에는 flag가 없어야 한다.
- `comment-monitor`와 `monitor`의 `source: 'monitor'` start에는 flag가 없어야 한다.
- source가 `monitor`로 전환되는 함수에서 lease clear가 있어야 한다.
- `stopIfManualTimeLimitExpired()`가 `manualTimeLimitStopping` guard를 써서 중복 stop을 막아야 한다.
- loadState 만료 정리가 기존 stop side effect와 같은 리소스 정리를 해야 한다.
- popup 수동 start 전에 dirty 설정 차단이 있어야 한다.
- 실행 중 `manualTimeLimitMinutes` 변경 차단이 있어야 한다.

### 수동 댓글 방어

1. 댓글 방어 시간제한을 1분으로 저장한다.
2. 팝업 기본 댓글 방어를 ON 한다.
3. status에 `manualTimeLimitActive: true`, `manualTimeLimitExpiresAt`이 보이는지 확인한다.
4. popup의 `수동 제한` 표시가 자동 종료 시각을 보여주는지 확인한다.
5. 1분 후 댓글 방어가 자동 OFF 되는지 확인한다.
6. 만료 직후 이미 진행 중이던 요청 1개가 끝나는 것은 허용하되, 새 page/post 작업을 시작하지 않는지 로그로 확인한다.
7. 로그에 `수동 실행 시간 제한` 문구가 한 번만 남는지 확인한다.

### 수동 댓글 quick mode

1. `한글제외 유동닉댓글 삭제`를 ON 한다.
2. `currentSource === 'manual'`, `currentAttackMode === 'exclude_pure_hangul'`, `manualTimeLimitActive === true`인지 확인한다.
3. 만료 후 자동 OFF 되는지 확인한다.
4. `역류기 공용 matcher 공격`도 같은 방식으로 확인한다.

### 수동 게시글 분류

1. 게시글 분류 시간제한을 1분으로 저장한다.
2. 기본 게시글 분류를 ON 한다.
3. status에 `manualTimeLimitActive: true`, `manualTimeLimitExpiresAt`이 보이는지 확인한다.
4. popup의 `수동 제한` 표시가 자동 종료 시각을 보여주는지 확인한다.
5. 1분 후 게시글 분류가 자동 OFF 되는지 확인한다.
6. pending runtime transition이 있던 경우 만료 시 transition promise가 cancel되는지 확인한다.

### 수동 게시글 quick mode

1. `중국어/한자 공격` ON
2. `역류기 공격` ON
3. `1페이지 전체 검사` ON

각각 `currentSource === 'manual'`, 해당 `currentAttackMode`, `manualTimeLimitActive === true`를 확인하고 만료 후 자동 OFF를 확인한다.

### 자동 댓글 감시

1. 댓글 방어 시간제한을 1분으로 저장한다.
2. 댓글 감시 자동화를 켠다.
3. 공격 조건을 만들어 comment monitor가 댓글 방어를 시작하게 한다.
4. 댓글 방어 status가 `currentSource === 'monitor'`이고 `manualTimeLimitActive === false`인지 확인한다.
5. 1분이 지나도 댓글 방어가 시간제한 때문에 꺼지지 않는지 확인한다.
6. 공격 release 조건이 충족될 때 comment monitor가 기존 로직대로 댓글 방어를 끄는지 확인한다.

### 수동 실행 중 자동 감시가 넘겨받는 경우

이 케이스가 사용자 우려의 핵심이다.

1. 시간제한 1분으로 댓글 방어 또는 게시글 분류를 수동 ON 한다.
2. 만료 전에 감시 자동화가 공격을 감지하도록 만든다.
3. source가 `manual`에서 `monitor`로 바뀌는지 확인한다.
4. 바뀌는 순간 `manualTimeLimitActive === false`가 되는지 확인한다.
5. 처음 수동 ON 기준 1분이 지나도 자동 대응이 꺼지지 않는지 확인한다.

예상 결과:

- 13:00 수동 ON, 만료 예정 13:01
- 13:00:30 자동 감시가 공격 감지, source가 monitor로 변경
- 13:01이 되어도 꺼지지 않음
- 공격 release 때 감시 자동화가 OFF 처리

### trusted-command

1. trusted-command의 hold 시간을 1분으로 설정한다.
2. `댓글방어` 또는 `게시물방어` 명령으로 child를 시작한다.
3. child scheduler의 `currentSource`는 `manual`일 수 있지만 `manualTimeLimitActive`는 false여야 한다.
4. trusted-command의 `commentDefenseUntilTs` / `postDefenseUntilTs` 기준으로만 종료되는지 확인한다.

### dirty 설정과 실행 중 설정 변경

1. 댓글 방어 시간제한 input을 1분으로 바꾸고 저장하지 않은 채 댓글 방어 ON을 누른다.
2. popup이 "설정 변경분을 먼저 저장"류 메시지를 띄우고 start를 보내지 않는지 확인한다.
3. 게시글 분류도 같은 방식으로 확인한다.
4. 댓글 방어 실행 중 시간제한 input을 다른 값으로 저장하려고 하면 background가 차단하는지 확인한다.
5. 게시글 분류 실행 중 시간제한 input을 다른 값으로 저장하려고 하면 background가 차단하는지 확인한다.
6. 실행 중 popup에서는 수동 시간제한 input만 비활성화되고, 기존에 허용되던 다른 설정 흐름은 불필요하게 막히지 않는지 확인한다.

### restart 복원

1. 수동 댓글 방어 시간제한을 2분으로 켠다.
2. 1분 뒤 extension service worker reload 또는 브라우저 재시작을 수행한다.
3. status 복원 후 남은 시간이 대략 1분인지 확인한다.
4. 만료 후 자동 OFF 되는지 확인한다.
5. 이미 만료된 상태로 reload하면 OFF 상태로 복원되는지 확인한다.

게시글 분류도 동일하게 확인한다.

### 빠른 재시작

1. 수동 댓글 방어를 켠다.
2. 시간제한 만료로 OFF 된 직후 바로 ON을 다시 누른다.
3. 이전 run loop의 정리 중 promise 때문에 새 run이 중복 실행되거나 바로 꺼지지 않는지 확인한다.
4. 게시글 분류도 같은 방식으로 확인한다.

## 위험 지점과 대응

### 위험 1. source-only 조건

나쁜 구현:

```js
if (this.currentSource === 'manual') {
  // 30분 후 stop
}
```

문제:

- trusted-command child도 source가 manual이라 같이 꺼질 수 있다.
- 자동 감시가 기존 수동 실행을 넘겨받기 직전 stale timer가 남을 수 있다.

대응:

- `manualTimeLimit: true` flag가 있는 팝업 시작에서만 lease 생성
- source가 `monitor`로 바뀌면 lease clear

### 위험 2. MV3 setTimeout 의존

나쁜 구현:

```js
setTimeout(() => this.stop(), 30 * 60 * 1000);
```

문제:

- service worker가 suspend/reload되면 timer가 사라질 수 있다.

대응:

- `manualTimeLimitExpiresAt`을 storage에 저장
- run loop와 loadState에서 만료 여부 확인

### 위험 3. delay overshoot

나쁜 구현:

```js
await delay(this.config.cycleDelay);
```

문제:

- cycleDelay가 길면 만료 시각을 지나도 delay가 끝날 때까지 멈추지 않는다.

대응:

- `delayRespectingManualTimeLimit()`으로 1초 단위 또는 남은 제한 시간 단위로 쪼개서 대기

### 위험 4. 실행 중 config 변경

실행 중 시간제한 설정을 바꿨을 때 현재 실행의 만료시각까지 바꾸면 관리자가 실수로 현재 run을 갑자기 줄이거나 늘릴 수 있다.

권장:

- 실행 중 `manualTimeLimitMinutes` 변경은 background에서 차단한다.
- 이미 실행 중인 run은 시작 시 계산한 `manualTimeLimitExpiresAt`을 유지한다.

### 위험 5. dirty 설정으로 이전 제한값 사용

나쁜 흐름:

```text
관리자가 수동 실행 시간 제한을 10분으로 입력
-> 설정 저장을 누르지 않음
-> 댓글 방어 ON
-> 실제로는 이전 저장값 30분으로 실행
```

대응:

- 댓글/게시글 수동 start 전에 `DIRTY_FEATURES.comment/post`를 확인한다.
- dirty이면 start를 보내지 않고 먼저 설정 저장을 요구한다.

### 위험 6. worker 동시 만료 처리

댓글 방어는 `processPostsInParallel()`에서 여러 worker가 동시에 돈다. 만료 시각이 지나면 여러 worker가 같은 helper를 거의 동시에 호출할 수 있다.

대응:

- `manualTimeLimitStopping` guard로 만료 stop을 한 번만 실행한다.
- 로그도 한 번만 남는지 검증한다.

### 위험 7. hard abort 오해

시간제한은 현재 구조에서 새 작업 진입을 막는 방식이다. 이미 시작된 HTTP 요청이나 삭제/분류 요청은 중간에 취소하지 않는다.

대응:

- 문구와 검증 기준을 "만료 후 새 page/post/batch를 시작하지 않는다"로 잡는다.
- 진짜 hard abort가 필요하면 각 API에 AbortController를 전달하는 별도 설계가 필요하다.

### 위험 8. runPromise 정리 중 빠른 재시작

기존 start guard는 `isRunning` 중심이라, stop 직후 `runPromise`가 아직 unwind 중인 순간에 새 start가 들어올 수 있다. 시간제한 자동 stop 뒤 바로 다시 ON 하는 UX에서 중복 run loop 위험이 커질 수 있다.

대응:

- 댓글/게시글 scheduler에 `getStartBlockReason()`을 추가해서 `this.isRunning`이면 "이미 실행 중입니다.", `this.runPromise`가 남아 있으면 "이전 실행을 정리 중입니다. 잠시 후 다시 시도하세요."류 메시지를 반환한다.
- background는 이미 start 전에 `scheduler.getStartBlockReason()`을 확인하므로, 이 방식이면 팝업에 `success: false`가 내려간다.
- 단순히 `start()` 안에서 조용히 `return`하면 background가 `success: true`로 응답할 수 있다. 이 경우 실제로는 시작되지 않았는데 팝업이 ON처럼 보일 수 있으므로 피한다.
- 최소한 빠른 OFF->ON 재시작 검증을 추가한다.

## 최종 판단

댓글 방어와 게시글 분류에 기본 30분 수동 시간제한을 넣는 것은 구조상 어렵지 않다. 핵심은 "수동 source"가 아니라 "팝업 수동 시작에서 발급한 시간제한 lease"를 기준으로 삼는 것이다.

이 방식이면 관리자가 실수로 수동 방어를 켜둔 상황은 30분 뒤 자동 종료되어 리스크가 줄고, 자동 감시가 공격 대응 중인 상황은 source가 `monitor`로 전환되거나 처음부터 `monitor`로 시작되므로 시간제한 때문에 꺼지지 않는다.
