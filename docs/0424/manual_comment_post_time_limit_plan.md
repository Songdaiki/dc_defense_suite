# 댓글 방어 / 게시글 분류 수동 실행 시간제한 구현 스펙

작성일: 2026-04-24

## 목표

`댓글 방어`와 `게시글 분류`를 관리자가 직접 켰을 때만 기본 30분 뒤 자동 종료되게 한다.

공격 자동화가 켠 실행은 시간제한을 적용하지 않는다. 공격 중인데 수동 제한 타이머 때문에 방어가 꺼지는 상황을 막는 것이 핵심이다.

쉬운 예시는 아래와 같다.

```text
관리자가 댓글 방어 ON
-> 30분 뒤 자동 OFF

댓글 자동화가 공격 감지 후 댓글 방어 ON
-> 30분 제한 무시
-> 댓글 자동화의 공격 종료 조건이 맞을 때 OFF

관리자가 게시글 분류 ON
-> 30분 뒤 자동 OFF

게시물 자동화가 공격 감지 후 게시글 분류 ON
-> 30분 제한 무시
-> 게시물 자동화의 공격 종료 조건이 맞을 때 OFF
```

## 결론

구현은 어렵지 않다. 다만 `source === 'manual'`만 보고 시간제한을 걸면 안 된다.

현재 코드에서 `source: 'manual'`은 두 의미로 쓰인다.

1. 팝업에서 관리자가 직접 켠 수동 실행
2. `명령 방어`가 소유한 child 실행

따라서 수동 시간제한은 `source: 'manual'`에 바로 붙이지 말고, 팝업 수동 토글이 보낸 명시 플래그에만 붙여야 한다.

권장 플래그:

```js
manualTimeLimit: true
```

권장 런타임 상태:

```js
manualTimeLimitRunId
manualTimeLimitStartedAt
manualTimeLimitExpiresAt
```

## 현재 로직 확인

### 댓글 방어 scheduler

파일: `features/comment/scheduler.js`

현재 `comment` scheduler는 `start(options)`에서 `options.source`를 `currentSource`에 저장한다.

```js
this.currentSource = normalizeRunSource(options.source, 'manual');
this.currentAttackMode = normalizeRequestedCommentAttackMode(options);
this.isRunning = true;
```

확인 위치:

- `constructor`: `isRunning`, `currentSource`, `config` 초기화
- `start()`: `currentSource` 설정 후 실행 시작
- `stop()`: `currentSource = ''`, `currentAttackMode = DEFAULT`
- `saveState()`: `currentSource`, `currentAttackMode`, `config` 저장
- `loadState()`: 저장된 실행 상태 복원
- `getStatus()`: popup이 `currentSource`를 볼 수 있음

중요한 점:

- 댓글 자동화도 같은 `commentScheduler`를 켠다.
- 댓글 자동화는 `source: 'monitor'`로 켠다.
- popup 수동 토글은 `source: 'manual'`로 켠다.

### 게시글 분류 scheduler

파일: `features/post/scheduler.js`

현재 `post` scheduler도 `start(options)`에서 `source`를 저장한다.

```js
const normalizedOptions = normalizeStartOptions(options);
this.currentSource = normalizedOptions.source;
this.currentAttackMode = normalizedOptions.attackMode;
this.isRunning = true;
```

확인 위치:

- `constructor`: `currentSource = 'manual'`
- `start()`: `source`, `attackMode`, `cutoffPostNo` 설정
- `stop()`: `clearRuntimeAttackMode()` 호출
- `setMonitorAttackMode()`: 실행 중 monitor 소유로 전환
- `saveState()` / `loadState()` / `getStatus()`: runtime 상태 저장과 popup 표시

중요한 점:

- 게시물 자동화도 같은 `postScheduler`를 켠다.
- 게시물 자동화는 `source: 'monitor'`로 켠다.
- popup 수동 토글과 quick mode는 `source: 'manual'`로 켠다.

### 댓글 자동화

파일: `features/comment-monitor/scheduler.js`

댓글 자동화는 공격 상태 진입 후 `commentScheduler.start({ source: 'monitor' })`를 호출한다.

```js
await this.commentScheduler.start({
  source: 'monitor',
  commentAttackMode: attackMode,
});
```

또 이미 댓글 방어가 실행 중이면 `setCurrentSource('monitor')`로 자동화 소유 상태에 맞춘다.

```js
const sourceChanged = this.commentScheduler.setCurrentSource('monitor');
```

종료는 `managedCommentStarted`가 true일 때만 `commentScheduler.stop()`으로 정리한다.

```js
const shouldStopComment = this.managedCommentStarted;
if (shouldStopComment && this.commentScheduler.isRunning) {
  await this.commentScheduler.stop();
}
```

이 구조 때문에 수동 시간제한이 `source: 'monitor'` 실행에 적용되면 안 된다.

### 게시물 자동화

파일: `features/monitor/scheduler.js`

게시물 자동화는 공격 상태에서 `postScheduler.start({ source: 'monitor' })`를 호출한다.

```js
await this.postScheduler.start({
  cutoffPostNo: this.attackCutoffPostNo,
  attackMode: this.attackMode,
  source: 'monitor',
});
```

이미 실행 중이면 `setMonitorAttackMode()`로 monitor 소유 상태에 맞춘다.

```js
await this.postScheduler.setMonitorAttackMode(this.attackMode)
```

종료는 `managedPostStarted`가 true일 때만 `postScheduler.stop()`으로 정리한다.

```js
const shouldStopPost = this.managedPostStarted;
if (shouldStopPost && this.postScheduler.isRunning) {
  await this.postScheduler.stop();
}
```

이 구조 때문에 `post` child 내부의 수동 제한 타이머가 monitor 실행을 끄면 안 된다.

### background 라우팅과 잠금

파일: `background/background.js`

popup에서 `start` 메시지가 오면 background가 scheduler로 전달한다.

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

자동화 실행 중 수동 조작 잠금도 이미 있다.

```js
if (schedulers.monitor.isRunning && ['post', 'semiPost', 'ip'].includes(feature)) {
  return '감시 자동화 실행 중에는 게시글 분류 / 반고닉 분류 / IP 차단을 수동으로 조작할 수 없습니다.';
}

if (schedulers.commentMonitor.isRunning && feature === 'comment') {
  return '댓글 감시 자동화 실행 중에는 댓글 방어를 수동으로 조작할 수 없습니다.';
}
```

이 잠금은 그대로 둔다. 시간제한은 잠금을 대체하지 않는다.

### popup 수동 시작

파일: `popup/popup.js`

현재 댓글 기본 토글은 아래 메시지를 보낸다.

```js
{ action: 'start', source: 'manual', commentAttackMode: 'default' }
```

댓글 quick mode도 `source: 'manual'`로 시작한다.

```js
{
  action: 'start',
  source: 'manual',
  commentAttackMode: attackMode,
}
```

현재 게시글 기본 토글은 아래 메시지를 보낸다.

```js
{
  action: 'start',
  source: 'manual',
  attackMode: 'default',
}
```

게시글 quick mode도 `source: 'manual'`로 시작한다.

따라서 popup에서 직접 시작하는 모든 `comment` / `post` start 메시지에 `manualTimeLimit: true`를 붙이면 된다.

### 명령 방어의 예외

파일: `features/trusted-comment-command-defense/scheduler.js`

명령 방어도 child scheduler를 `source: 'manual'`로 켠다.

```js
await this.postScheduler.start({
  source: 'manual',
  attackMode: 'default',
  cutoffPostNo: this.postDefenseCutoffPostNo,
});

await this.commentScheduler.start({
  source: 'manual',
  commentAttackMode: 'default',
});
```

하지만 명령 방어는 별도 ownership과 `holdMs`가 이미 있다.

```js
postDefenseUntilTs
commentDefenseUntilTs
ownedPostScheduler
ownedIpScheduler
ownedCommentScheduler
```

만료 처리도 이미 별도 로직으로 한다.

```js
if (this.postDefenseUntilTs > 0 && this.postDefenseUntilTs <= now) {
  await this.stopOwnedPostDefense(...);
}
```

따라서 명령 방어 child에는 새 수동 시간제한을 적용하면 안 된다.

이게 `source === 'manual'`만으로 판단하면 안 되는 가장 중요한 이유다.

## 요구 동작 표

| 케이스 | start 호출 | 시간제한 적용 | 이유 |
| --- | --- | --- | --- |
| popup 댓글 기본 토글 | `source: 'manual', manualTimeLimit: true` | 적용 | 관리자가 직접 켠 실행 |
| popup 댓글 quick mode | `source: 'manual', manualTimeLimit: true` | 적용 | 관리자가 직접 켠 실행 |
| popup 게시글 기본 토글 | `source: 'manual', manualTimeLimit: true` | 적용 | 관리자가 직접 켠 실행 |
| popup 게시글 quick mode | `source: 'manual', manualTimeLimit: true` | 적용 | 관리자가 직접 켠 실행 |
| 댓글 자동화 child | `source: 'monitor'` | 미적용 | 공격 종료 조건이 부모에 있음 |
| 게시물 자동화 child | `source: 'monitor'` | 미적용 | 공격 종료 조건이 부모에 있음 |
| 명령 방어 child | `source: 'manual'` but no flag | 미적용 | 명령 방어가 자체 hold를 관리 |
| legacy/manual API 호출 | `source: 'manual'` but no flag | 미적용 | 안전한 backward compatibility |

## 구현 설계

### 1. 공통 개념

두 scheduler에 같은 개념을 넣는다.

```js
manualTimeLimitRunId: ''
manualTimeLimitStartedAt: ''
manualTimeLimitExpiresAt: ''
```

config 기본값:

```js
manualTimeLimitMinutes: 30
```

시간제한 활성 조건:

```js
source === 'manual' && options.manualTimeLimit === true
```

시간제한 비활성 조건:

```js
source !== 'manual'
options.manualTimeLimit !== true
```

즉 `source: 'manual'`이어도 `manualTimeLimit: true`가 없으면 만료 시각을 만들지 않는다.

### 2. 수동 lease 생성 helper

두 scheduler에 같은 helper를 두되, 중복이 싫으면 나중에 공용 helper로 뺄 수 있다. 첫 구현은 파일별 helper가 더 안전하다.

```js
function createManualTimeLimitRun(feature, minutes) {
  const now = Date.now();
  const normalizedMinutes = normalizeManualTimeLimitMinutes(minutes);
  return {
    runId: `${feature}_manual_${now}_${Math.random().toString(36).slice(2, 10)}`,
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + normalizedMinutes * 60 * 1000).toISOString(),
  };
}

function normalizeManualTimeLimitMinutes(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30;
  }
  return Math.min(720, Math.max(1, parsed));
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
```

추천 상한은 720분이다. 이미 댓글 IP 차단 시간 input도 720 같은 긴 상한을 쓰고 있어서 UI 감각이 어긋나지 않는다.

### 3. scheduler runtime helper

두 scheduler에 아래 메서드를 둔다.

```js
setupManualTimeLimitForStart(options, source) {
  if (source !== 'manual' || options.manualTimeLimit !== true) {
    this.clearManualTimeLimit();
    return;
  }

  const lease = createManualTimeLimitRun('comment', this.config.manualTimeLimitMinutes);
  this.manualTimeLimitRunId = lease.runId;
  this.manualTimeLimitStartedAt = lease.startedAt;
  this.manualTimeLimitExpiresAt = lease.expiresAt;
  this.log(`⏱️ 수동 실행 시간제한 설정 - ${formatManualTimeLimitMinutes(this.config.manualTimeLimitMinutes)}분, ${formatTimestamp(lease.expiresAt)} 자동 종료 예정`);
}

clearManualTimeLimit() {
  this.manualTimeLimitRunId = '';
  this.manualTimeLimitStartedAt = '';
  this.manualTimeLimitExpiresAt = '';
}

isManualTimeLimitActive() {
  return Boolean(
    this.isRunning
    && this.currentSource === 'manual'
    && this.manualTimeLimitRunId
    && parseTimestamp(this.manualTimeLimitExpiresAt) > 0
  );
}

isManualTimeLimitExpired(now = Date.now()) {
  if (!this.isManualTimeLimitActive()) {
    return false;
  }
  return now >= parseTimestamp(this.manualTimeLimitExpiresAt);
}

async stopIfManualTimeLimitExpired() {
  if (!this.isManualTimeLimitExpired()) {
    return false;
  }

  const expiredAt = this.manualTimeLimitExpiresAt;
  await this.stop(`⏹️ 수동 실행 시간제한이 끝나 자동 종료했습니다. (${formatTimestamp(expiredAt)})`);
  return true;
}
```

`comment`에서는 feature prefix를 `comment`, `post`에서는 `post`로 바꾼다.

### 4. `setTimeout`을 쓰지 않는다

Chrome MV3 service worker는 중간에 내려갔다 다시 뜰 수 있다. `setTimeout` 기반 구현은 background가 재시작되면 사라진다.

그래서 만료 시각을 `chrome.storage.local`에 저장하고, scheduler loop와 `loadState()`에서 확인한다.

쉬운 예시:

```text
10:00 수동 ON -> expiresAt 10:30 저장
10:15 background service worker 내려감
10:35 background 다시 뜸
loadState()에서 expiresAt이 이미 지난 걸 확인
-> 실행 복원하지 않고 정지 상태로 저장
```

### 5. `start()` 변경

댓글:

```js
this.currentSource = normalizeRunSource(options.source, 'manual');
this.currentAttackMode = normalizeRequestedCommentAttackMode(options);
this.setupManualTimeLimitForStart(options, this.currentSource);
this.isRunning = true;
```

게시글:

```js
this.currentSource = normalizedOptions.source;
this.currentAttackMode = normalizedOptions.attackMode;
this.setupManualTimeLimitForStart(options, this.currentSource);
this.isRunning = true;
```

주의:

- `setupManualTimeLimitForStart()`는 `isRunning = true` 전에도 동작해야 한다.
- 로그는 start 로그 전후 어느 쪽이든 가능하지만, 시작 흐름을 읽기 쉽게 하려면 `🟢 자동 삭제 시작` / `🟢 자동 분류 시작` 직후가 낫다.

### 6. `stop()` 변경

현재 `stop()`은 reason을 받지 않는다. reason을 선택 인자로 바꾼다.

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

기존 호출부는 인자를 안 넘겨도 그대로 동작한다.

### 7. `run()` 만료 체크 위치

댓글 `run()`:

```js
while (this.isRunning) {
  if (await this.stopIfManualTimeLimitExpired()) {
    break;
  }

  ...

  for (let page = startPage; page <= this.config.maxPage; page++) {
    if (!this.isRunning) break;
    if (await this.stopIfManualTimeLimitExpired()) break;
    ...
  }

  if (this.isRunning) {
    ...
    await delay(this.config.cycleDelay);
  }
}
```

게시글 `run()`도 같은 위치에 넣는다.

정확히 초 단위로 멈춰야 하는 기능은 아니다. 하지만 `cycleDelay`가 최대 60초라서 만료 후 최대 1분 정도 늦게 멈출 수 있다. 더 정확하게 하고 싶으면 `delay()` 대신 `delayUntilManualTimeLimitOrDelay()` helper를 추가하면 된다.

이번 기능의 목적은 관리자 리스크 관리이므로 cycle/page 경계 체크면 충분하다.

### 8. `loadState()` 만료 처리

저장된 상태 복원 중 만료가 이미 지난 경우 실행을 복원하지 않는다.

댓글:

```js
this.manualTimeLimitRunId = String(schedulerState.manualTimeLimitRunId || '');
this.manualTimeLimitStartedAt = String(schedulerState.manualTimeLimitStartedAt || '');
this.manualTimeLimitExpiresAt = String(schedulerState.manualTimeLimitExpiresAt || '');

if (this.isRunning && this.isManualTimeLimitExpired()) {
  this.isRunning = false;
  this.currentPage = 0;
  this.currentPostNo = 0;
  this.clearManualTimeLimit();
  this.currentSource = '';
  this.currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
  this.log('ℹ️ 저장된 수동 댓글 방어 시간제한이 이미 끝나 자동 복원을 건너뜁니다.');
  await this.saveState();
}
```

게시글:

```js
this.manualTimeLimitRunId = String(schedulerState.manualTimeLimitRunId || '');
this.manualTimeLimitStartedAt = String(schedulerState.manualTimeLimitStartedAt || '');
this.manualTimeLimitExpiresAt = String(schedulerState.manualTimeLimitExpiresAt || '');

if (this.isRunning && this.isManualTimeLimitExpired()) {
  this.isRunning = false;
  this.currentPage = 0;
  this.clearManualTimeLimit();
  this.clearRuntimeAttackMode();
  this.log('ℹ️ 저장된 수동 게시글 분류 시간제한이 이미 끝나 자동 복원을 건너뜁니다.');
  await this.saveState();
}
```

`bump-post`가 이미 같은 패턴을 쓴다.

```js
if (this.isRunning && hasExpired(this.endsAt)) {
  this.isRunning = false;
  this.phase = PHASE.IDLE;
  this.nextRunAt = '';
  this.log('ℹ️ 저장된 끌올 자동 지속 시간이 이미 끝나 자동 복원을 건너뜁니다.');
  await this.saveState();
}
```

### 9. monitor 전환 시 수동 제한 clear

이 부분이 매우 중요하다.

댓글 자동화는 실행 중 child를 `setCurrentSource('monitor')`로 바꿀 수 있다. 이때 예전 수동 제한 정보가 남아 있으면 안 된다.

댓글 `setCurrentSource()`에 추가:

```js
if (nextSource !== 'manual') {
  this.clearManualTimeLimit();
}
```

게시글 `setMonitorAttackMode()`에 추가:

```js
this.clearManualTimeLimit();
```

게시글 `clearRuntimeAttackMode()`에도 추가:

```js
this.clearManualTimeLimit();
```

이렇게 하면 source가 monitor로 넘어가는 순간 수동 제한 lease는 사라진다.

### 10. saveState / getStatus 추가

댓글 `saveState()`에 추가:

```js
manualTimeLimitRunId: this.manualTimeLimitRunId,
manualTimeLimitStartedAt: this.manualTimeLimitStartedAt,
manualTimeLimitExpiresAt: this.manualTimeLimitExpiresAt,
```

게시글도 동일하게 추가한다.

`getStatus()`에도 동일하게 넣는다.

popup은 이 값을 보고 "수동 종료 예정"을 표시한다.

### 11. background 변경

파일: `background/background.js`

댓글 start 전달값에 추가:

```js
await scheduler.start({
  source: message.source,
  commentAttackMode: normalizedCommentAttackMode,
  excludePureHangulOnStart: message.excludePureHangulOnStart,
  manualTimeLimit: message.manualTimeLimit === true,
});
```

게시글 start 전달값에 추가:

```js
await scheduler.start({
  source: message.source,
  attackMode: message.attackMode,
  manualTimeLimit: message.manualTimeLimit === true,
});
```

이렇게 해야 popup이 명시한 수동 시작에만 lease가 생긴다.

### 12. popup HTML 변경

파일: `popup/popup.html`

댓글 상태 grid에 하나 추가:

```html
<div class="status-item">
  <span class="status-label">수동 종료 예정</span>
  <span id="commentManualTimeLimitExpiresAt" class="status-value">-</span>
</div>
```

댓글 설정 grid에 하나 추가:

```html
<div class="setting-item">
  <label for="commentManualTimeLimitMinutes">수동 실행 제한 (분)</label>
  <input type="number" id="commentManualTimeLimitMinutes" min="1" max="720" value="30">
</div>
```

게시글 상태 grid에 하나 추가:

```html
<div class="status-item">
  <span class="status-label">수동 종료 예정</span>
  <span id="postManualTimeLimitExpiresAt" class="status-value">-</span>
</div>
```

게시글 설정 grid에 하나 추가:

```html
<div class="setting-item">
  <label for="postManualTimeLimitMinutes">수동 실행 제한 (분)</label>
  <input type="number" id="postManualTimeLimitMinutes" min="1" max="720" value="30">
</div>
```

### 13. popup JS 변경

파일: `popup/popup.js`

`FEATURE_DOM.comment`:

```js
manualTimeLimitExpiresAtText: document.getElementById('commentManualTimeLimitExpiresAt'),
manualTimeLimitMinutesInput: document.getElementById('commentManualTimeLimitMinutes'),
```

`FEATURE_DOM.post`:

```js
manualTimeLimitExpiresAtText: document.getElementById('postManualTimeLimitExpiresAt'),
manualTimeLimitMinutesInput: document.getElementById('postManualTimeLimitMinutes'),
```

댓글 기본 토글 start 메시지:

```js
{ action, source: 'manual', commentAttackMode: 'default', manualTimeLimit: true }
```

댓글 quick mode start 메시지:

```js
{
  action: 'start',
  source: 'manual',
  commentAttackMode: attackMode,
  manualTimeLimit: true,
}
```

게시글 기본 토글 start 메시지:

```js
{
  action,
  source: 'manual',
  attackMode: 'default',
  manualTimeLimit: true,
}
```

게시글 quick mode start 메시지:

```js
{
  action: 'start',
  source: 'manual',
  attackMode,
  manualTimeLimit: true,
}
```

댓글 설정 저장:

```js
manualTimeLimitMinutes: clampManualTimeLimitMinutes(dom.manualTimeLimitMinutesInput.value),
```

게시글 설정 저장:

```js
manualTimeLimitMinutes: clampManualTimeLimitMinutes(dom.manualTimeLimitMinutesInput.value),
```

config sync:

```js
[dom.manualTimeLimitMinutesInput, status.config?.manualTimeLimitMinutes ?? 30],
```

dirty tracking:

```js
dom.manualTimeLimitMinutesInput
```

`getFeatureConfigInputs('comment')`와 `getFeatureConfigInputs('post')`에 위 input을 추가한다.

### 14. popup 표시 helper

추천 helper:

```js
function formatManualTimeLimitStatus(status) {
  const expiresAt = String(status?.manualTimeLimitExpiresAt || '').trim();
  if (!status?.isRunning || !expiresAt) {
    return '-';
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return '-';
  }

  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs <= 0) {
    return '만료 처리 중';
  }

  return `${formatTimestamp(expiresAt)} (${formatRemainingMinutes(remainingMs)} 남음)`;
}
```

예시 표시:

```text
2026. 4. 24. 21:30:00 (27분 남음)
```

자동화 실행이나 명령 방어 실행은 lease가 없으므로 `-`로 표시한다.

### 15. resetStats 처리

통계 초기화는 실행 상태를 건드리지 않는 것이 기존 방향이다.

그래서 `resetStats`에서 시간제한 lease를 지우면 안 된다. 실행 중이면 예정 종료가 그대로 남아야 한다.

예시:

```text
10:00 수동 댓글 방어 ON
10:10 통계 초기화
10:30 시간제한으로 자동 OFF
```

단, 정지 상태에서 resetStats를 누르는 경우는 이미 stop에서 lease가 지워졌으므로 따로 할 일이 없다.

### 16. 설정 변경 정책

이번 구현은 "시작 시 저장된 설정"을 적용한다.

예시:

```text
10:00 수동 ON, 당시 설정 30분
10:10 설정을 60분으로 저장
-> 현재 실행은 10:30에 종료
-> 다음 수동 ON부터 60분 적용
```

이 정책이 가장 단순하고 안전하다. 실행 중 설정 변경이 현재 lease를 연장하면 관리자가 의도치 않게 방어를 오래 켜둘 수 있다.

나중에 현재 실행까지 연장하고 싶으면 별도 버튼 또는 "저장 시 현재 실행에도 적용" 확인창을 추가하는 편이 낫다.

## 구현 순서

1. `features/comment/scheduler.js`
   - config `manualTimeLimitMinutes: 30` 추가
   - runtime fields 3개 추가
   - manual time limit helpers 추가
   - `start()`에서 `options.manualTimeLimit === true`일 때 lease 생성
   - `stop(reason)`에서 lease clear
   - `run()`에서 만료 체크
   - `loadState()`에서 이미 만료된 저장 실행 복원 방지
   - `saveState()` / `getStatus()`에 fields 추가
   - `setCurrentSource()`가 monitor/empty로 바뀌면 lease clear

2. `features/post/scheduler.js`
   - comment와 같은 runtime/config fields 추가
   - `start()`에서 lease 생성
   - `stop(reason)`에서 lease clear
   - `run()`에서 만료 체크
   - `loadState()`에서 이미 만료된 저장 실행 복원 방지
   - `saveState()` / `getStatus()`에 fields 추가
   - `setMonitorAttackMode()`와 `clearRuntimeAttackMode()`에서 lease clear

3. `background/background.js`
   - comment/post start forwarding에 `manualTimeLimit: message.manualTimeLimit === true` 추가
   - lock 로직은 변경하지 않음

4. `popup/popup.html`
   - comment/post 상태 grid에 "수동 종료 예정" 추가
   - comment/post 설정 grid에 "수동 실행 제한 (분)" input 추가

5. `popup/popup.js`
   - DOM refs 추가
   - popup 직접 start 메시지에 `manualTimeLimit: true` 추가
   - config 저장/sync/dirty tracking에 input 추가
   - status 표시 helper 추가

6. README 또는 간단 운영 문서 업데이트는 선택이다.
   - 이번 작업 범위가 구현 문서와 실제 UI 변화라면 README 한 줄 정도가 충분하다.

## 교차검증 체크리스트

### 정적 확인

- `rg "source: 'monitor'" features/comment-monitor features/monitor`로 자동화 start가 `manualTimeLimit`을 넘기지 않는지 확인
- `rg "manualTimeLimit" background popup features/comment features/post`로 popup -> background -> scheduler 경로가 이어지는지 확인
- `rg "source: 'manual'" features/trusted-comment-command-defense`로 명령 방어 child에 `manualTimeLimit`이 붙지 않았는지 확인
- `saveState()`와 `loadState()` 양쪽에 같은 field 이름이 있는지 확인
- `getStatus()`에 field가 있어 popup 표시가 가능한지 확인

### 수동 시나리오

1. 댓글 방어 기본 토글
   - 수동 실행 제한을 1분으로 저장
   - 댓글 방어 ON
   - `수동 종료 예정`이 표시되는지 확인
   - 1분 뒤 OFF 되는지 확인

2. 댓글 quick mode
   - `한글제외 유동닉댓글 삭제` ON
   - `manualTimeLimitExpiresAt`이 생기는지 확인
   - 만료 후 OFF 되는지 확인

3. 게시글 분류 기본 토글
   - 수동 실행 제한을 1분으로 저장
   - 게시글 분류 ON
   - 1분 뒤 OFF 되는지 확인

4. 게시글 quick mode
   - `중국어/한자 공격` 또는 `역류기 공격` ON
   - 1분 뒤 OFF 되는지 확인

### 자동화 보호 시나리오

1. 댓글 자동화 공격 진입
   - `comment.currentSource === 'monitor'`
   - `comment.manualTimeLimitRunId === ''`
   - `comment.manualTimeLimitExpiresAt === ''`
   - 30분 설정과 무관하게 댓글 자동화 종료 조건 전까지 child가 꺼지지 않아야 함

2. 게시물 자동화 공격 진입
   - `post.currentSource === 'monitor'`
   - `post.manualTimeLimitRunId === ''`
   - `post.manualTimeLimitExpiresAt === ''`
   - 30분 설정과 무관하게 monitor가 `stopManagedDefenses()`를 호출할 때까지 child가 유지되어야 함

3. 명령 방어
   - 명령 댓글방어 / 게시물방어 실행
   - child `currentSource`는 `manual`이어도 `manualTimeLimitRunId`가 없어야 함
   - 명령 방어의 `commentDefenseUntilTs` / `postDefenseUntilTs`로만 만료되어야 함

### 재시작 시나리오

1. 댓글 방어 수동 1분 실행 후 background 재시작
   - 만료 전이면 복원됨
   - 만료 후면 복원하지 않고 OFF 저장

2. 게시글 분류 수동 1분 실행 후 background 재시작
   - 만료 전이면 복원됨
   - 만료 후면 복원하지 않고 OFF 저장

## 위험 지점과 방지책

### 위험 1. 자동 공격 대응 중 30분 뒤 child가 꺼짐

원인:

```js
source === 'manual'
```

만으로 시간제한을 걸었을 때.

방지:

```js
source === 'manual' && options.manualTimeLimit === true
```

로만 lease 생성.

### 위험 2. 명령 방어 child가 새 제한에 걸림

원인:

명령 방어가 child를 `source: 'manual'`로 켠다.

방지:

명령 방어는 `manualTimeLimit: true`를 넘기지 않는다. 새 기능은 플래그 없으면 적용하지 않는다.

### 위험 3. service worker 재시작으로 타이머 유실

원인:

`setTimeout`만 쓰면 background가 내려갔을 때 타이머가 사라진다.

방지:

`manualTimeLimitExpiresAt`를 저장하고 `loadState()`에서 만료 여부를 확인한다.

### 위험 4. source 전환 후 예전 lease가 남음

예시:

```text
수동 실행 lease가 남아 있음
자동화 복원 경로가 source를 monitor로 전환
예전 lease가 나중에 monitor 실행을 끔
```

방지:

- `comment.setCurrentSource('monitor')`에서 lease clear
- `post.setMonitorAttackMode()`에서 lease clear
- `post.clearRuntimeAttackMode()`에서 lease clear

## 최종 판단

댓글 방어와 게시글 분류에 기본 30분 수동 실행 제한을 넣는 것은 현재 구조와 잘 맞는다.

단, 구현 기준은 아래 한 줄이어야 한다.

```text
수동 시간제한은 "source manual"이 아니라 "popup이 직접 켠 manual lease"에만 적용한다.
```

이 조건만 지키면 자동 댓글 방어, 게시물 자동화, 명령 방어와 섞여서 공격 중 방어가 꺼지는 문제를 피할 수 있다.
