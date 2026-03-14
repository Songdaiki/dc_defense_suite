# DC Defense Suite - 감시 자동화 v2 구현 스펙

## 1. 목표

이 문서는 `DC Defense Suite`에 `감시 자동화` 기능을 추가하기 위한 구현 스펙이다.

목표는 다음과 같다.

- 게시글 목록을 주기적으로 감시한다.
- 비정상적인 게시글 도배 공격을 감지하면 자동으로 대응 상태로 전환한다.
- 대응 상태에서는 기존 `게시글 분류`, `IP 차단` 기능을 자동으로 켠다.
- 공격 종료가 확인되면 기존 기능을 자동으로 끄고, 자동 대응 중 생성한 IP 차단만 자동 해제한다.

이 문서는 현재 코드베이스를 기준으로 바로 구현 가능한 수준의 설계를 제공한다.

---

## 2. 현재 코드에서 재사용 가능한 로직

현재 suite 기준으로 이미 확보된 로직은 다음과 같다.

### 2.1 배경/라우팅 구조
- 파일: `background/background.js`
- 현재 구조:
  - feature별 scheduler 인스턴스 보유
  - `start / stop / getStatus / updateConfig / resetStats` 공통 라우팅
  - `getAllStatus`, `updateSharedConfig` 지원

즉, 감시기도 같은 형태의 scheduler-like 객체로 추가하면 현재 라우팅 구조를 그대로 재사용할 수 있다.

### 2.2 게시글 목록 HTML 조회
- 재사용 대상: `features/post/api.js`
- 함수: `fetchPostListHTML(config, page)`
- 특징:
  - `search_head` 없는 일반 목록 페이지를 읽는다.
  - 감시 자동화가 필요한 “전체 게시글 목록” 감시에 바로 재사용 가능하다.

### 2.3 게시글 row 파싱 기반 로직
- 재사용 대상: `features/post/parser.js`
- 현재 확보된 사실:
  - `postNo`는 `data-no`
  - 유동 여부는 `gall_writer data-ip`
  - 현재 머릿말은 `gall_subject`
- 단, 현재 함수 `parseFluidPosts()`는 “유동만” 반환하므로 감시 자동화엔 부족하다.
- 감시용으로는 “모든 일반 게시글 row”를 반환하는 새 파서가 필요하다.

### 2.4 게시글 자동 분류
- 재사용 대상: `features/post/scheduler.js`, `features/post/api.js`
- 현재 기능:
  - 설정된 `galleryId`, `headtextId` 기준으로 일반 목록을 훑고
  - 유동 게시글을 대상 탭(`headtextId`)으로 분류
- 감시 자동화는 이 scheduler를 “직접 구현”하지 않고, 기존 scheduler를 자동 제어하는 쪽으로 간다.

### 2.5 IP 자동 차단
- 재사용 대상: `features/ip/scheduler.js`, `features/ip/api.js`
- 현재 기능:
  - 대상 탭(`search_head=headtextId`)을 순회
  - 유동 게시물 작성자를 1시간 차단
  - `activeBans` 추적
  - 수동 해제 가능
- 감시 자동화는 이 scheduler를 공격 중에만 자동으로 켜고 끄는 방식으로 사용한다.

### 2.6 IP 차단 자동 해제 기반
- 재사용 대상: `features/ip/scheduler.js`
- 현재 기능:
  - 차단 목록 HTML 파싱
  - `set_avoid(..., 'R', 'releaseId', ano)` 기반 해제
- 다만 현재 `releaseTrackedBans()`는 `활성 차단 전체`를 해제한다.
- 감시 자동화용으로는 `특정 runId만 해제`하도록 확장해야 한다.

---

## 3. v2 설계 방향

감시 자동화는 “새로운 대응 엔진”이 아니라 “기존 엔진을 제어하는 오케스트레이터”로 구현한다.

즉 구조는 다음과 같다.

- 감시기:
  - 게시글 목록 폴링
  - 공격 감지/종료 판정
  - 게시글 분류 scheduler 제어
  - IP 차단 scheduler 제어
  - 자동 해제 실행
- 기존 기능:
  - 댓글 방어: 그대로 독립
  - 게시글 분류: 감시기가 켜고 끔
  - IP 차단: 감시기가 켜고 끔, 종료 시 해제도 트리거

---

## 4. 구현 파일 구조

### 4.1 새로 추가할 파일

- `features/monitor/scheduler.js`
  - 감시 자동화 메인 오케스트레이터
  - 현재 background 라우팅에 맞는 scheduler 인터페이스 구현

### 4.2 기존 파일 수정 대상

- `background/background.js`
  - `monitor` feature 추가
  - scheduler 인스턴스 생성 방식 수정
  - `getAllStatus`에 monitor 포함
  - `updateSharedConfig` 시 monitor에도 `galleryId` 반영
  - busy feature 체크에 monitor 포함

- `features/post/parser.js`
  - 감시용 일반 게시글 파서 추가
  - 예: `parseBoardPosts(html)`

- `features/ip/scheduler.js`
  - `releaseTrackedBans(options = {})`로 확장
  - `runId` 기준 필터 해제 지원

- `popup/popup.html`
  - 감시 자동화 탭 추가

- `popup/popup.js`
  - 감시 자동화 탭 상태/설정/토글/로그 처리
  - monitor 실행 중 기존 post/ip 수동 토글 잠금

- `popup/popup.css`
  - monitor 탭 스타일 추가

---

## 5. background 통합 구조

현재 `background/background.js`는 comment/post/ip를 직접 생성한다.

v2에서는 아래 순서로 생성한다.

1. `commentScheduler`
2. `postScheduler`
3. `ipScheduler`
4. `monitorScheduler`

`monitorScheduler`는 생성자에서 다음 의존성을 받는다.

- `postScheduler`
- `ipScheduler`

예상 형태:

```js
const commentScheduler = new CommentScheduler();
const postScheduler = new PostScheduler();
const ipScheduler = new IpScheduler();
const monitorScheduler = new MonitorScheduler({
  postScheduler,
  ipScheduler,
});

const schedulers = {
  comment: commentScheduler,
  post: postScheduler,
  ip: ipScheduler,
  monitor: monitorScheduler,
};
```

이 방식으로 가야 monitor가 기존 scheduler 인스턴스를 중복 생성하지 않고, 실제 운영 중인 객체를 제어할 수 있다.

---

## 6. monitor feature 상태 모델

### 6.1 config

`monitor.config`

```js
{
  galleryId: 'thesingularity',
  monitorPages: 2,
  pollIntervalMs: 20000,

  attackNewPostThreshold: 15,
  attackFluidRatioThreshold: 88,
  attackConsecutiveCount: 2,

  releaseNewPostThreshold: 10,
  releaseFluidRatioThreshold: 30,
  releaseConsecutiveCount: 3,
}
```

설명:

- `galleryId`
  - shared config에서 동기화
- `monitorPages`
  - 감시 대상 페이지 수
- `pollIntervalMs`
  - 감시 주기
- `attack*`
  - 공격 감지 조건
- `release*`
  - 공격 종료 조건

### 6.2 runtime state

```js
{
  isRunning: false,
  phase: 'SEEDING' | 'NORMAL' | 'ATTACKING' | 'RECOVERING',
  currentPollPage: 0,
  cycleCount: 0,

  attackHitCount: 0,
  releaseHitCount: 0,

  lastPollAt: '',
  lastMetrics: {
    snapshotPostCount: 0,
    newPostCount: 0,
    newFluidCount: 0,
    fluidRatio: 0,
  },

  lastSnapshot: [
    {
      postNo: 1024419,
      isFluid: true,
      nick: 'ㅇㅇ',
      ip: '211.233',
      subject: '갤 뭐임?',
      currentHead: '일반',
    }
  ],

  attackSessionId: '',
  managedPostStarted: false,
  managedIpStarted: false,
  managedIpRunId: '',

  totalAttackDetected: 0,
  totalAttackReleased: 0,
  logs: [],
}
```

### 6.3 storage key

- `monitorSchedulerState`

---

## 7. phase 정의

### `SEEDING`
- 시작 직후 첫 스냅샷 수집 전 상태
- 아직 diff 계산 불가
- 첫 poll 결과는 baseline으로만 저장

### `NORMAL`
- 감시 중
- 공격 미감지 상태

### `ATTACKING`
- 공격 감지 상태
- 게시글 분류 / IP 차단 자동 대응 활성

### `RECOVERING`
- 종료 조건 충족 후
- 게시글 분류 OFF
- IP 차단 OFF
- 자동 해제 수행 중

---

## 8. 수동 기능과의 충돌 정책

이 부분은 구현 전에 반드시 고정해야 한다.

### v2 정책

감시 자동화가 켜져 있는 동안 `게시글 분류`와 `IP 차단`은 감시기가 독점 제어한다.

즉:

- monitor 실행 중에는
  - post 수동 토글 비활성화
  - ip 수동 토글 비활성화
  - ip 수동 해제 버튼 비활성화

background에서도 방어적으로 막는다.

- monitor가 `isRunning === true`이면
  - `feature=post/ip`에 대한 `start/stop/updateConfig/releaseTrackedBans` 수동 요청을 거부한다.

이렇게 해야 다음 문제가 안 생긴다.

- monitor가 켠 post/ip를 사용자가 임의로 꺼버림
- monitor가 자동 해제해야 할 IP 차단에 수동 차단이 섞임
- 현재 공격 세션과 수동 운영 세션의 `runId`가 뒤엉킴

### monitor 시작 조건

monitor 시작 시 아래 조건을 만족해야 한다.

- post가 정지 상태
- ip가 정지 상태
- ip 해제 작업 중 아님

하나라도 만족하지 않으면 monitor 시작을 거부한다.

이 정책을 쓰면 감시 자동화가 post/ip를 “깨끗한 세션”으로 시작할 수 있고,
IP 자동 해제도 `managedIpRunId` 기준으로 안전하게 수행 가능하다.

---

## 9. 감시용 게시글 파서

현재 `features/post/parser.js`에는 `parseFluidPosts()`만 있다.

감시 자동화에는 모든 일반 게시글 row가 필요하므로 아래 함수를 추가한다.

### 새 함수

```js
function parseBoardPosts(html)
```

### 반환 형태

```js
[
  {
    no: 1024419,
    nick: 'ㅇㅇ',
    ip: '211.233',
    isFluid: true,
    subject: '갤 뭐임?',
    currentHead: '일반',
  },
]
```

### 포함 규칙

- 일반 게시글 row만 포함
- `공지`, `설문`, 숫자 아닌 `gall_num` row는 제외
- 유동/고정닉 모두 포함
- `data-ip` 있으면 `isFluid = true`
- `data-ip` 없으면 `isFluid = false`

### 재사용 가능한 내부 기준

현재 `features/post/parser.js`에서 이미 있는 로직:

- `data-no` 파싱
- `gall_writer` 파싱
- `extractCurrentHead()`

이를 그대로 재사용하거나 공통 helper로 분리한다.

---

## 10. 새 게시글 수 / 유동 비율 계산 방식

### 10.1 현재 poll

`monitorPages` 범위의 일반 목록 페이지를 읽는다.

예:

- `page=1`
- `page=2`
- ...

### 10.2 current snapshot 생성

각 페이지에서 `parseBoardPosts(html)`를 실행하고, `postNo` 기준 dedupe 한다.

### 10.3 baseline 비교

`newPosts = currentSnapshot - lastSnapshot`

기준:

- 현재 스냅샷에는 있음
- 직전 스냅샷에는 없음

### 10.4 지표 계산

```js
newPostCount = newPosts.length
newFluidCount = newPosts.filter(post => post.isFluid).length
fluidRatio = newPostCount > 0 ? (newFluidCount / newPostCount) * 100 : 0
```

### 10.5 첫 poll 처리

첫 poll은 baseline seed만 수행한다.

- `lastSnapshot` 저장
- `phase = NORMAL`
- 공격 판정하지 않음

---

## 11. 공격 감지 / 종료 알고리즘

### 11.1 공격 감지 조건

```js
attackCondition =
  newPostCount >= config.attackNewPostThreshold &&
  fluidRatio >= config.attackFluidRatioThreshold
```

### 11.2 공격 감지 streak

`NORMAL` 상태에서:

- `attackCondition === true`
  - `attackHitCount += 1`
- else
  - `attackHitCount = 0`

`attackHitCount >= config.attackConsecutiveCount`이면 `enterAttackMode()`

### 11.3 공격 종료 조건

```js
releaseCondition =
  newPostCount < config.releaseNewPostThreshold &&
  fluidRatio < config.releaseFluidRatioThreshold
```

### 11.4 공격 종료 streak

`ATTACKING` 상태에서:

- `releaseCondition === true`
  - `releaseHitCount += 1`
- else
  - `releaseHitCount = 0`

`releaseHitCount >= config.releaseConsecutiveCount`이면 `enterRecoveringMode()`

---

## 12. 자동 대응 진입 플로우

### `enterAttackMode()`

1. `phase = ATTACKING`
2. `attackSessionId = attack_${Date.now()}`
3. `attackHitCount = 0`
4. `releaseHitCount = 0`
5. `totalAttackDetected += 1`
6. `logs` 기록
7. `ensureManagedDefensesStarted()`

### `ensureManagedDefensesStarted()`

목표:
- 게시글 분류 ON
- IP 차단 ON

세부 규칙:

1. post가 정지 상태면 `postScheduler.start()`
2. 성공 시 `managedPostStarted = true`
3. ip가 정지 상태면 `ipScheduler.start()`
4. 성공 시 `managedIpStarted = true`
5. ip start 직후 `managedIpRunId = ipScheduler.currentRunId`

중요:

- monitor는 post/ip가 이미 실행 중인 상태에서 시작할 수 없으므로,
  여기서 얻는 `managedIpRunId`는 감시 자동화 전용 runId로 볼 수 있다.

실패 처리:

- start 실패 시 로그 기록
- `ATTACKING`은 유지
- 다음 poll마다 `ensureManagedDefensesStarted()`를 다시 호출해 누락된 기능 재시도

---

## 13. 공격 종료 / 자동 해제 플로우

### `enterRecoveringMode()`

1. `phase = RECOVERING`
2. `releaseHitCount = 0`
3. 로그 기록
4. `stopManagedDefenses()`
5. `releaseManagedIpBans()`
6. 성공/실패 로그 기록
7. `totalAttackReleased += 1`
8. `phase = NORMAL`
9. `attackSessionId = ''`
10. `managedPostStarted = false`
11. `managedIpStarted = false`
12. `managedIpRunId = ''`

### `stopManagedDefenses()`

- `managedPostStarted === true`면 `postScheduler.stop()`
- `managedIpStarted === true`면 `ipScheduler.stop()`

### `releaseManagedIpBans()`

현재 구현 그대로는 사용하지 않는다.

현재 `ipScheduler.releaseTrackedBans()`는 활성 차단 전체를 풀기 때문이다.

v2에서는 아래 확장이 필요하다.

```js
ipScheduler.releaseTrackedBans({ runId: managedIpRunId })
```

필터 규칙:

- `entry.status === 'active'`
- `entry.runId === managedIpRunId`

이렇게 해야 자동 대응 세션에서 생성한 IP 차단만 해제한다.

---

## 14. IP scheduler 수정 사양

### 대상 파일
- `features/ip/scheduler.js`

### 기존 함수

```js
async releaseTrackedBans()
```

### 변경 후

```js
async releaseTrackedBans(options = {})
```

### 옵션

```js
{
  runId?: string
}
```

### 동작

- `options.runId`가 없으면 기존과 동일
  - 활성 차단 전체 해제
- `options.runId`가 있으면
  - `entry.runId === options.runId`인 활성 차단만 해제

### 수동 UI 영향

- 기존 IP 탭 수동 해제 버튼은 옵션 없이 호출
- 따라서 현재 수동 동작은 그대로 유지된다.

### monitor 영향

- monitor는 `managedIpRunId`를 넘겨 자기 세션 차단만 해제한다.

---

## 15. monitor scheduler 인터페이스

`features/monitor/scheduler.js`는 기존 scheduler와 동일한 인터페이스를 제공한다.

필수 메서드:

- `start()`
- `stop()`
- `run()`
- `saveState()`
- `loadState()`
- `resumeIfNeeded()`
- `ensureRunLoop()`
- `getStatus()`
- `log(message)`

추가 내부 메서드:

- `pollBoardSnapshot()`
- `computeMetrics(currentSnapshot)`
- `evaluateNormalState(metrics)`
- `evaluateAttackingState(metrics)`
- `enterAttackMode()`
- `enterRecoveringMode()`
- `ensureManagedDefensesStarted()`
- `stopManagedDefenses()`
- `releaseManagedIpBans()`

---

## 16. monitor `run()` 루프

`run()`의 기본 흐름은 아래와 같다.

```js
while (isRunning) {
  try {
    const currentSnapshot = await pollBoardSnapshot();
    const metrics = computeMetrics(currentSnapshot);

    if (phase === 'SEEDING') {
      lastSnapshot = currentSnapshot;
      phase = 'NORMAL';
      saveState();
      await delay(config.pollIntervalMs);
      continue;
    }

    if (phase === 'NORMAL') {
      await evaluateNormalState(metrics);
    } else if (phase === 'ATTACKING') {
      await ensureManagedDefensesStarted();
      await evaluateAttackingState(metrics);
    } else if (phase === 'RECOVERING') {
      // 일반적으로 enterRecoveringMode 내부에서 바로 NORMAL로 복귀
    }

    lastSnapshot = currentSnapshot;
    lastMetrics = metrics;
    cycleCount += 1;
    saveState();
    await delay(config.pollIntervalMs);
  } catch (error) {
    log(`❌ 감시 오류 - ${error.message}`);
    saveState();
    await delay(10000);
  }
}
```

---

## 17. popup UI 사양

감시 자동화는 새로운 탭으로 추가한다.

### 탭명
- `감시 자동화`

### 표시 항목

- 상태
  - `SEEDING`
  - `NORMAL`
  - `ATTACKING`
  - `RECOVERING`
- 최근 폴링 시각
- 새 게시글 수
- 새 유동 게시글 수
- 최근 유동 비율
- 공격 감지 streak
- 종료 감지 streak
- 누적 공격 감지 횟수
- 누적 자동 종료 횟수

### 설정 항목

- 감시 폴링 시간(ms)
- 감시 페이지 수
- 공격 감지 새 게시글 수
- 공격 감지 유동 비율(%)
- 공격 감지 연속 횟수
- 공격 종료 새 게시글 수
- 공격 종료 유동 비율(%)
- 공격 종료 연속 횟수

### 버튼

- 자동 감시 ON/OFF 토글
- 통계 초기화

### 잠금 규칙

monitor가 실행 중이면 popup에서:

- post toggle disabled
- ip toggle disabled
- ip release button disabled

---

## 18. background 메시지 라우팅 변경점

`background/background.js`는 `monitor` feature를 기존 feature와 동일하게 라우팅한다.

즉 아래 액션을 그대로 지원한다.

- `start`
- `stop`
- `getStatus`
- `updateConfig`
- `resetStats`

추가 변경점:

- `getAllStatus()`에 `monitor` 포함
- `updateSharedConfig()` 시 `monitor.config.galleryId`도 동기화
- `getBusyFeatures()`에 monitor 포함

---

## 19. shared config 반영 정책

현재 shared config는:

- `galleryId`
- `도배기탭 번호`

를 관리한다.

monitor는 여기서 `galleryId`만 사용한다.

정책:

- shared config 변경 시 monitor가 실행 중이면 저장 거부
- galleryId 변경 시 monitor state도 reset

reset 항목:

- `phase = SEEDING`
- `currentPollPage = 0`
- `attackHitCount = 0`
- `releaseHitCount = 0`
- `lastSnapshot = []`
- `lastMetrics = 기본값`
- `attackSessionId = ''`
- `managedPostStarted = false`
- `managedIpStarted = false`
- `managedIpRunId = ''`
- `logs = []`

---

## 20. 실패/예외 처리 정책

### 첫 poll
- 감지하지 않음
- baseline seed만 저장

### network 오류
- streak 증가/감소하지 않음
- lastSnapshot 유지
- 10초 후 재시도

### post start 실패
- ATTACKING 유지
- 다음 poll에서 재시도

### ip start 실패
- ATTACKING 유지
- 다음 poll에서 재시도

### 자동 해제 실패
- 로그 기록
- phase는 `NORMAL`로 복귀
- `managedIpRunId`는 비우되,
  `ip.activeBans`는 그대로 남을 수 있음
- 사용자는 기존 IP 탭 수동 해제로 후속 정리 가능

### releaseId 일부 미매칭
- 기존 ip scheduler 결과를 그대로 로그에 반영
- 전체 자동화 실패로 간주하지 않고 warning 처리

---

## 21. 구현 순서

### 1단계
- `features/post/parser.js`
  - `parseBoardPosts(html)` 추가

### 2단계
- `features/ip/scheduler.js`
  - `releaseTrackedBans({ runId })` 지원

### 3단계
- `features/monitor/scheduler.js` 추가
  - 상태 모델
  - polling
  - attack/release streak
  - post/ip 제어

### 4단계
- `background/background.js`
  - monitor scheduler 연결
  - 수동 post/ip 조작 잠금
  - shared config 연동

### 5단계
- `popup/*`
  - monitor 탭 UI 추가
  - post/ip 제어 잠금 UI 반영

### 6단계
- 정적 검증
  - monitor 시작/정지
  - first poll seed
  - 2회 연속 감지 -> ATTACKING
  - 3회 연속 종료 -> RECOVERING -> NORMAL
  - runId 기반 자동 해제

---

## 22. 구현 후 정적 검증 체크리스트

- monitor가 켜진 상태에서 첫 poll은 공격 판정하지 않는가
- newPostCount가 직전 snapshot diff로 계산되는가
- fluidRatio가 newPosts 기준인가
- 2회 연속 감지 전에는 ATTACKING으로 안 가는가
- ATTACKING 진입 시 post/ip가 자동 start 되는가
- monitor 실행 중 post/ip 수동 조작이 차단되는가
- 종료 조건 3회 연속 전에는 자동 해제가 안 되는가
- 종료 시 post/ip가 stop 되는가
- 자동 해제가 `managedIpRunId` 기준으로만 동작하는가
- shared config 변경 시 monitor 포함 전체 state reset/거부가 맞는가

---

## 23. 현재 기준으로 구현 가능한가

가능하다.

이유:

- 게시글 목록 fetch는 이미 있음
- 분류 API는 이미 있음
- IP 차단 API는 이미 있음
- IP 해제 API도 이미 있음
- 통합 background 라우팅 구조가 이미 있음
- popup 탭 구조도 이미 있음

즉 v2에서 새로 만드는 것은 “감지/상태 전환/기존 엔진 제어” 계층이지,
핵심 대응 API를 새로 reverse-engineering 해야 하는 상황은 아니다.

남아 있는 구현 포인트는 주로 아래다.

- 일반 게시글 전체 파서 추가
- monitor scheduler 추가
- ip release `runId` 필터 확장
- popup/busy lock 연결

이 문서 기준으로 바로 구현을 시작해도 된다.
