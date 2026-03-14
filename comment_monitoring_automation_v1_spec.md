# DC Defense Suite - 댓글 감시 자동화 v1 구현 스펙

## 1. 목표

이 문서는 `DC Defense Suite`에 `댓글 감시 자동화` 기능을 추가하기 위한 v1 구현 스펙이다.

목표는 다음과 같다.

- 평시에는 낮은 트래픽으로 댓글 도배 징후만 감시한다.
- 비정상적인 댓글 폭주가 감지되면 기존 `댓글 방어` 엔진을 자동으로 켠다.
- 댓글 폭주가 잦아들면 기존 `댓글 방어` 엔진을 자동으로 끈다.
- 공격 진입은 `reply_num` 순증가를 기준으로 판단한다.
- 공격 종료는 `reply_num` 순증가와 `실제 검증된 삭제 수`를 함께 기준으로 판단한다.
- v1에서는 댓글 본문 샘플링이나 유동 비율 계산은 하지 않는다.

이 문서는 현재 코드베이스를 기준으로 바로 구현 가능한 수준의 설계를 제공한다.

---

## 2. 현재 코드에서 재사용 가능한 로직

### 2.1 background 라우팅 구조
- 파일: `background/background.js`
- 현재 구조:
  - feature별 scheduler 인스턴스 보유
  - `start / stop / getStatus / updateConfig / resetStats` 공통 라우팅
  - `getAllStatus`, `updateSharedConfig` 지원

즉, 댓글 감시기도 같은 형태의 scheduler-like 객체로 추가하면 현재 구조를 그대로 재사용할 수 있다.

### 2.2 댓글 방어 엔진
- 파일: `features/comment/scheduler.js`
- 현재 기능:
  - 게시물 목록을 순회
  - 댓글이 있는 글만 병렬 처리
  - `e_s_n_o` 확보
  - 댓글 전체 페이지 조회
  - 유동 댓글만 삭제

댓글 감시 자동화는 이 엔진을 다시 구현하지 않고, 공격 중에만 자동으로 켜고 끄는 오케스트레이터로 간다.

단, 자동 종료를 위해서는 기존 댓글 방어 엔진에 아래 값이 추가로 필요하다.

- 최근 poll/window 동안의 `실제 검증 삭제 수`
- 마지막 삭제 사이클의 검증 결과

즉, 댓글 감시 자동화 구현 전에 댓글 방어 엔진은 "성공 응답 기준 추정 삭제 수"가 아니라, `재조회 또는 삭제 상태 판정`을 통해 `실제 검증된 삭제 수`를 상태로 노출하도록 선행 보강되어야 한다.

### 2.3 댓글 수 스냅샷에 필요한 목록 API
- 파일: `features/comment/api.js`
- 함수: `fetchPostList(config, page)`
- 현재 반환:

```js
{
  posts: [
    { no: 1024419, commentCount: 34 },
    ...
  ],
  esno,
}
```

중요한 점:
- `reply_num`이 이미 여기서 `commentCount`로 파싱된다.
- 댓글 감시기는 게시물 상세나 댓글 API를 볼 필요 없이, 이 함수만 재사용하면 된다.

### 2.4 공통 설정
- 현재 `shared config`는 `galleryId`, `headtextId`를 관리한다.
- 댓글 감시는 `galleryId`만 필요하다.
- `headtextId`는 댓글 감시에 직접 사용하지 않는다.

---

## 3. v1 설계 방향

댓글 감시 자동화는 `실제 댓글 총량`을 맞히는 기능이 아니라, `상단 1~2페이지 게시물의 reply_num 순증가`를 이용한 이상 징후 감지기로 설계한다.

즉 v1의 핵심은 다음과 같다.

- `reply_num` 순증가만 본다.
- `1~2페이지` 같은 작은 범위만 본다.
- 평시 트래픽은 `목록 GET` 수준으로 유지한다.
- 공격 시에만 기존 `댓글 방어` 엔진을 켠다.
- 공격 종료는 `reply_num` 순증가와 `실제 검증 삭제 수`를 같이 본다.
- 종료 후에는 다음 1 poll을 기준 스냅샷 재수집(`reseed`)에 사용한다.

이 설계는 다음 trade-off를 전제로 한다.

- 실제 댓글 총량보다 작게 잡힐 수 있다.
- 이미 삭제된 댓글은 순증가에서 상쇄될 수 있다.
- 1~2페이지 밖으로 밀려난 글의 댓글 증가는 잡지 못할 수 있다.

하지만 운영 목적상 중요한 것은 `정확한 총량`이 아니라 `비정상적인 급증 신호를 안정적으로 잡는 것`이므로, v1에서는 이 방법이 가장 실용적이다.

---

## 4. 구현 파일 구조

### 4.1 새로 추가할 파일

- `features/comment-monitor/scheduler.js`
  - 댓글 감시 자동화 메인 오케스트레이터

### 4.2 기존 파일 수정 대상

- `background/background.js`
  - `commentMonitor` feature 추가
  - scheduler 인스턴스 생성 및 라우팅 추가
  - `getAllStatus`에 포함
  - `updateSharedConfig` 시 `galleryId` 동기화
  - `busyFeatures` 및 manual lock 로직 추가

- `popup/popup.html`
  - 새 탭 `댓글 감시 자동화` 추가

- `popup/popup.js`
  - 댓글 감시 자동화 탭 상태/설정/토글/로그 처리
  - comment monitor 실행 중 comment 수동 조작 잠금

- `popup/popup.css`
  - 새 탭 스타일 추가

---

## 5. feature 이름과 생성 구조

feature 이름은 `commentMonitor`로 고정한다.

예상 생성 구조:

```js
const commentScheduler = new CommentScheduler();
const postScheduler = new PostScheduler();
const ipScheduler = new IpScheduler();
const monitorScheduler = new MonitorScheduler({ postScheduler, ipScheduler });
const commentMonitorScheduler = new CommentMonitorScheduler({ commentScheduler });

const schedulers = {
  comment: commentScheduler,
  post: postScheduler,
  ip: ipScheduler,
  monitor: monitorScheduler,
  commentMonitor: commentMonitorScheduler,
};
```

핵심:
- `commentMonitor`는 `commentScheduler` 인스턴스를 주입받는다.
- 독립 comment engine을 새로 만들지 않는다.

---

## 6. 상태 모델

### 6.1 config

`commentMonitor.config`

```js
{
  galleryId: 'thesingularity',
  monitorPages: 2,
  pollIntervalMs: 20000,

  attackNewCommentThreshold: 30,
  attackChangedPostThreshold: 20,
  attackConsecutiveCount: 2,

  releaseNewCommentThreshold: 30,
  releaseVerifiedDeleteThreshold: 10,
  releaseConsecutiveCount: 3,
  reseedPollCountAfterRelease: 1,
}
```

설명:
- `galleryId`
  - shared config에서 동기화
- `monitorPages`
  - 감시 대상 페이지 수
  - v1 기본값은 `2`
- `pollIntervalMs`
  - 감시 주기
- `attackNewCommentThreshold`
  - 1 poll 구간 동안 감지된 `reply_num 순증가 합계`
- `attackChangedPostThreshold`
  - 1 poll 구간 동안 댓글 수가 증가한 게시물 수
- `attackConsecutiveCount`
  - 공격 감지 연속 횟수
- `releaseNewCommentThreshold`
  - 공격 종료 후보 기준
- `releaseVerifiedDeleteThreshold`
  - 공격 종료 후보 기준인 `실제 검증 삭제 수`
- `releaseConsecutiveCount`
  - 종료 연속 횟수
- `reseedPollCountAfterRelease`
  - 자동 종료 직후 기준 스냅샷 재수집에 사용하는 poll 수
  - v1 기본값은 `1`

중요:
- 모든 값은 UI에서 설정 가능해야 한다.
- v1에서는 `유동 비율` 설정이 없다.

### 6.2 runtime state

```js
{
  isRunning: false,
  runPromise: null,
  phase: 'SEEDING' | 'NORMAL' | 'ATTACKING' | 'RECOVERING',
  currentPollPage: 0,
  cycleCount: 0,

  attackHitCount: 0,
  releaseHitCount: 0,

  lastPollAt: '',
  lastMetrics: {
    snapshotPostCount: 0,
    changedPostCount: 0,
    newCommentCount: 0,
    verifiedDeletedCount: 0,
    topChangedPosts: [],
  },

  lastSnapshot: [
    {
      postNo: 1024419,
      commentCount: 34,
    }
  ],

  attackSessionId: '',
  managedCommentStarted: false,
  totalAttackDetected: 0,
  totalAttackReleased: 0,
  reseedRemaining: 0,
  logs: [],
}
```

### 6.3 storage key

- `commentMonitorSchedulerState`

---

## 7. 스냅샷 방식

### 7.1 스냅샷 수집

각 poll마다 `1 ~ monitorPages`의 게시물 목록을 읽는다.

재사용 함수:
- `features/comment/api.js`
- `fetchPostList(config, page)`

각 페이지에서 다음만 수집한다.

```js
{
  postNo: post.no,
  commentCount: post.commentCount,
}
```

페이지 간 중복은 `postNo` 기준으로 dedupe한다.

결과 스냅샷 형태:

```js
[
  { postNo: 1030001, commentCount: 12 },
  { postNo: 1030002, commentCount: 5 },
  ...
]
```

### 7.2 새 댓글 수 계산

기준:
- 이전 스냅샷에 없던 글은 `commentCount 전체`를 새 댓글로 본다.
- 이전보다 `commentCount`가 늘어난 글은 증가분만 더한다.
- 이전보다 줄어든 경우는 `0`으로 본다.

공식:

```js
delta = Math.max(0, current.commentCount - previous.commentCount)
newCommentCount = sum(delta)
changedPostCount = count(delta > 0)
```

예시:

이전:

```js
#1001 = 12
#1002 = 5
#1003 = 0
```

현재:

```js
#1001 = 40
#1002 = 2
#1003 = 8
#1004 = 10
```

계산:

```js
#1001 -> +28
#1002 -> +0
#1003 -> +8
#1004 -> +10
합계 = 46
changedPostCount = 3
```

### 7.3 이 방식의 의미

이 값은 `실제 전체 댓글 작성량`이 아니라 `상단 감시 범위 내 visible net delta`다.

즉:
- 실총량보다 작을 수 있다.
- 도배와 삭제가 동시에 일어나면 순증가가 상쇄될 수 있다.
- 이건 의도된 특성이며, v1은 이 값을 `공격 진입 신호`로 사용한다.
- 공격 종료는 이 값만으로 판단하지 않고, `실제 검증 삭제 수`를 함께 본다.

---

## 8. 상태 머신

### 8.1 `SEEDING`

- 시작 직후 첫 스냅샷 수집 전 상태
- 첫 poll 결과는 baseline으로만 저장
- 공격 판정 안 함

동작:

1. 게시물 목록 1~`monitorPages` 읽기
2. `lastSnapshot = currentSnapshot`
3. `lastMetrics.snapshotPostCount = currentSnapshot.length`
4. `phase = NORMAL`
5. 로그:
   - `🌱 기준 스냅샷 저장 완료 (100개 게시물)`

### 8.2 `NORMAL`

조건:
- 평시 감시 상태

동작:

1. `currentSnapshot` 수집
2. `newCommentCount` 계산
3. `newCommentCount >= attackNewCommentThreshold` 이고 `changedPostCount >= attackChangedPostThreshold`면 `attackHitCount += 1`
4. 아니면 `attackHitCount = 0`
5. `attackHitCount >= attackConsecutiveCount`면 `ATTACKING` 진입

로그 예시:
- `📡 새 댓글 180개 / 변화 글 22개`
- `🚨 댓글 공격 감지 streak 1/2`

### 8.3 `ATTACKING`

진입 시:

1. `phase = ATTACKING`
2. `attackSessionId = attack_<timestamp>`
3. `attackHitCount = 0`
4. `releaseHitCount = 0`
5. `totalAttackDetected += 1`
6. 기존 `commentScheduler.start()` 호출
7. `managedCommentStarted = true`

공격 중:

1. 계속 poll
2. 댓글 방어 엔진의 최근 `실제 검증 삭제 수`를 읽는다.
3. 아래 두 조건을 동시에 만족하면 `releaseHitCount += 1`
   - `newCommentCount <= releaseNewCommentThreshold`
   - `verifiedDeletedCount <= releaseVerifiedDeleteThreshold`
4. 둘 중 하나라도 만족하지 않으면 `releaseHitCount = 0`
5. `releaseHitCount >= releaseConsecutiveCount`면 `RECOVERING`

로그 예시:
- `🚨 댓글 공격 상태 진입 (attack_1772899000000)`
- `🛡️ 댓글 방어 자동 대응 ON`
- `🧊 댓글 종료 감지 streak 1/3 (새 댓글 42 / 실제 삭제 18)`

### 8.4 `RECOVERING`

종료 확정 상태

동작:

1. `phase = RECOVERING`
2. 기존 `commentScheduler.stop()` 호출
3. child run loop가 완전히 끝날 때까지 대기
4. `managedCommentStarted = false`
5. `totalAttackReleased += 1`
6. `attackSessionId = ''`
7. `reseedRemaining = reseedPollCountAfterRelease`
8. `phase = SEEDING`

중요:
- 댓글 삭제는 되돌릴 수 없으므로 IP monitor와 달리 자동 해제 단계가 없다.
- 종료 직후 바로 `NORMAL`로 돌아가지 않고, 최소 1 poll 동안 기준 스냅샷을 다시 잡는다.
- 이유:
  - 댓글 방어가 켜져 있는 동안 `reply_num` 순증가가 삭제로 상쇄될 수 있음
  - 자동 종료 직후 stale snapshot으로 다시 오탐하는 것을 줄이기 위함

로그 예시:
- `🧊 댓글 공격 종료 확정. 댓글 방어 자동 종료 시작`
- `🛑 댓글 방어 자동 대응 OFF`
- `🌱 댓글 감시 기준 스냅샷 재수집 예정 (1 poll)`
- `🌱 기준 스냅샷 재수집 완료 후 NORMAL 복귀`

---

## 9. 임계치 비교 규칙

### 9.1 공격 진입

공격 진입은 `>=`를 사용한다.

```js
attackCondition =
  newCommentCount >= attackNewCommentThreshold
  && changedPostCount >= attackChangedPostThreshold
```

예:
- threshold = 250
- 250이면 공격 감지 1회
- 299면 감지 안 함

### 9.2 공격 종료

공격 종료는 `새 댓글 수`와 `실제 검증 삭제 수` 두 조건을 함께 사용한다.

```js
releaseCondition =
  newCommentCount <= releaseNewCommentThreshold &&
  verifiedDeletedCount <= releaseVerifiedDeleteThreshold
```

예:
- `newCommentCount = 42`, `verifiedDeletedCount = 18`
  - 종료 감지 1회
- `newCommentCount = 42`, `verifiedDeletedCount = 72`
  - 종료 감지 안 함
- `newCommentCount = 80`, `verifiedDeletedCount = 18`
  - 종료 감지 안 함

v1에서 댓글 쪽은 각 임계치에 대해 `<=`를 명시적으로 사용한다.
이유:
- 운영자가 이해하기 쉽다.
- `새 댓글 50 이하 + 실제 삭제 50 이하 3회` 같은 정책 문구와 실제 동작이 일치한다.

---

## 10. 기본 정책값

기본값은 다음으로 둔다.

```js
monitorPages: 2
pollIntervalMs: 20000

attackNewCommentThreshold: 30
attackChangedPostThreshold: 20
attackConsecutiveCount: 2

releaseNewCommentThreshold: 30
releaseVerifiedDeleteThreshold: 10
releaseConsecutiveCount: 3
reseedPollCountAfterRelease: 1
```

이 값은 하드코딩이 아니라 UI 설정값이다.

근거:
- 삭제내역 관찰상 상단 visible delta는 `200` 수준으로도 잡힐 수 있음
- 공격 초반에는 `1500` 수준도 가능함
- 댓글 방어가 잘 먹히는 동안에는 `reply_num` 순증가가 빠르게 줄어들 수 있음
- 따라서 `높은 진입 임계치 + 낮은 종료 임계치`의 단계형 정책이 적합함
- 종료 판단은 `reply_num 단독`이 아니라 `실제 검증 삭제 수`와 결합해야 함

---

## 11. background 통합 정책

### 11.1 manual lock

`commentMonitor` 실행 중에는 `comment` feature에 대해 다음 수동 조작을 잠근다.

- `start`
- `stop`
- `updateConfig`

잠금 메시지 예시:

`댓글 감시 자동화 실행 중에는 댓글 방어를 수동으로 조작할 수 없습니다.`

### 11.2 start block

`commentScheduler`가 이미 실행 중이면 `commentMonitor.start()`를 막는다.

메시지:

`댓글 감시 자동화를 시작하기 전에 댓글 방어를 먼저 정지하세요.`

이유:
- 누가 child를 소유하는지 명확히 해야 함

### 11.3 shared config

`updateSharedConfig`에서 `galleryId` 변경 시 `commentMonitor.config.galleryId`도 같이 바뀌어야 한다.

그리고 gallery 변경 시:
- `lastSnapshot`
- `attackHitCount`
- `releaseHitCount`
- `attackSessionId`
- `logs`

를 초기화한다.

---

## 12. popup/UI 요구사항

새 탭 이름:
- `댓글 감시 자동화`

표시 항목:
- 상태
- 현재 단계
- 최근 폴링
- 새 댓글
- 실제 검증 삭제 수
- 변화 글 수
- 공격 감지 streak
- 종료 감지 streak
- 누적 공격 감지
- 누적 자동 종료

설정 항목:
- 감시 페이지 수
- 감시 폴링 시간(ms)
- 공격 감지 새 댓글 수
- 공격 감지 변화 글 수
- 공격 감지 연속 횟수
- 공격 종료 새 댓글 수
- 공격 종료 실제 삭제 수
- 공격 종료 연속 횟수

---

## 13. 구현 선행 조건

댓글 감시 자동화는 아래 선행 작업 없이는 바로 구현하면 안 된다.

1. `features/comment/scheduler.js`
   - 최근 poll/window 기준 `실제 검증 삭제 수`를 상태로 저장해야 한다.
2. `features/comment/api.js` / `features/comment/parser.js`
   - 삭제 성공 판정을 낙관적으로 하지 않고, 재조회 또는 삭제 상태 필드 기반으로 `실제 삭제 수`를 검증해야 한다.
3. `commentMonitor`는 종료 시 `commentScheduler`의 검증된 수치만 사용해야 한다.

즉, 댓글 감시 자동화의 auto-stop은 현재 댓글 방어 엔진의 추정치가 아니라 `검증된 삭제 수`를 전제로 한다.

버튼:
- 토글 ON/OFF
- 통계 초기화

별도 수동 해제 버튼은 없음.

---

## 13. 구현 순서

1. `features/comment-monitor/scheduler.js` 추가
2. background에 `commentMonitor` 인스턴스 추가
3. manual lock / start block 추가
4. popup에 새 탭 추가
5. status UI 연결
6. 설정 저장/초기화 연결
7. 정적 시뮬레이션
8. 실브라우저 테스트

---

## 14. 정적 검증 체크리스트

구현 후 반드시 확인할 항목:

1. `node --check`
   - `background/background.js`
   - `features/comment-monitor/scheduler.js`
   - `popup/popup.js`

2. 스냅샷 계산 시뮬레이션
   - 새 글 없는 경우
   - `commentCount` 감소한 경우
   - 새 글 등장한 경우
   - 2페이지 중복 postNo

3. 상태 전환 시뮬레이션
   - `SEEDING -> NORMAL`
   - `NORMAL -> ATTACKING`
   - `ATTACKING -> RECOVERING -> NORMAL`

4. child scheduler 연동
   - 공격 진입 시 `commentScheduler.start()` 1회만 호출
   - 공격 종료 시 `commentScheduler.stop()` 호출
   - run loop 종료 대기 확인

5. background 잠금
   - comment monitor 실행 중 `comment.start/stop/updateConfig` 차단
   - comment scheduler 실행 중 `commentMonitor.start()` 차단

6. popup DOM 검증
   - 새 탭 id 누락 없음

---

## 15. v1 범위 밖

이번 문서에서 의도적으로 제외하는 것:

- 댓글 유동 비율 계산
- 댓글 본문 샘플링 기반 공격 판정
- 중국어/깨진문자 패턴 판정
- 특정 글만 선택적 대응
- 자동 임계치 학습

이건 v2 이후 확장으로 분리한다.

---

## 16. 결론

v1 댓글 감시 자동화는 다음 원칙으로 구현한다.

- 평시엔 목록 `reply_num`만 감시
- 상단 1~2페이지 visible net delta만 사용
- 공격이면 기존 댓글 방어 엔진 ON
- 잠잠해지면 기존 댓글 방어 엔진 OFF
- 댓글은 파괴적 삭제이므로 별도 자동 해제는 없음

즉, 이 기능은 `정밀한 총량 측정기`가 아니라 `낮은 트래픽의 댓글 도배 이상징후 감지기`로 정의한다.
