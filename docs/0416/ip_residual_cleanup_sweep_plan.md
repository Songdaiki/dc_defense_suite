# IP 차단 30사이클 잔여 도배기탭 청소 스윕 계획

## 1. 목표

현재 `IP 차단`은 새로 들어온 도배기탭 글을 빠르게 잡는 데에는 유리하지만,
같은 유동이 여러 글을 올렸을 때 일부 글이 페이지에 남는 경우가 있다.

예시:

- `ㅇㅇ(175.215)`가 도배기탭 글 4개를 올림
- 현재 루프는 그 writer를 대표하는 글 1개만 차단/삭제 시도
- 같은 writer의 나머지 글이 어떤 이유로 남아도
- 이후 루프에서는 `이미 처리한 writer`로 보고 다시 잘 안 건드릴 수 있음

원하는 동작:

- 평소 빠른 루프는 그대로 유지
- 대신 **30사이클마다 한 번**
- 현재 설정된 페이지 범위 안에 **아직 남아 있는 도배기탭 글**을 다시 확인
- 특히 **이미 active ban 상태인 writer의 잔여 글**을 `delete-only`로 한 번 더 정리

이번 1차 범위는 **수동 IP 차단 흐름을 우선 보정**하는 데 초점을 둔다.

즉:

- monitor가 관리하는 child IP 흐름까지 확장하지 않고
- **`currentSource === 'manual'`일 때만 residual cleanup sweep을 돈다**

로 문서 기준을 잡는다.

한 줄 요약:

- **기존 새 후보 탐지 로직은 그대로 유지**
- **30사이클마다 잔여 글 보정 청소 스윕을 추가**
- **최소 패치로 남은 도배기탭 글을 줄인다**

---

## 2. 현재 실제 로직

### 2.1 평소 스캔 루프

현재 `IP 차단`은 `minPage~maxPage`를 순회하면서 도배기탭 목록을 읽고, 후보를 차단/삭제한다.

관련 코드:

- 루프 시작: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L249)
- 페이지 fetch: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L265)
- 후보 파싱: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L266)
- cutoff 이후 필터: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L272)
- active ban 제외: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L273)
- 실제 차단/삭제: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L282)

실제 순서는 이렇다.

1. `도배기탭 목록 HTML`을 읽는다.
2. `parseTargetPosts()`로 대상 글을 뽑는다.
3. 같은 writer는 먼저 dedupe한다.
4. `cutoffPostNo` 이후 글만 남긴다.
5. 이미 active ban이 있는 writer는 다시 후보에서 뺀다.
6. 남은 글만 `차단+삭제` 또는 `차단만` 수행한다.

즉 현재는:

- **새로 잡히는 writer를 빠르게 제재하는 루프**
- 에 최적화되어 있다.

반대로:

- **이미 차단한 writer의 남은 글을 다시 청소하는 루프**
- 는 별도로 없다.

---

### 2.2 잔여 글이 남는 핵심 원인

현재 잔여 글이 남을 수 있는 핵심 포인트는 두 군데다.

#### A. writer 기준 dedupe

관련 코드:

- dedupe: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L834)
- dedupe key: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L851)

현재는 `postNo` 기준이 아니라 `writerKey` 기준으로 후보를 줄인다.

예시:

- `ㅇㅇ(175.215)` 글 4개
- 페이지상 후보는 4개여도
- dedupe 후 1개만 남을 수 있음

#### B. 이미 active ban인 writer는 다시 후보에서 제외

관련 코드:

- active ban 체크: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L495)

예시:

- 첫 번째 글은 차단 성공
- 두 번째 글은 삭제가 꼬여서 페이지에 남음
- 다음 루프에서 같은 writer는 `이미 active ban`이라 후보에서 빠짐

즉 지금 남는 문제는

- `페이지를 못 봐서`라기보다는
- **이미 처리한 writer라고 간주해서 다시 안 건드리는 문제**

에 가깝다.

사용자 설명:

- `1~2페이지 안에서 도배기탭 글이 남아 있는데도 가끔 안 지워짐`

이 설명과 현재 코드가 잘 맞는다.

---

## 3. 왜 30사이클 보정 스윕이 맞는가

이 문제를 해결하는 가장 작은 변경은
`평소 루프`를 뜯는 게 아니라
`주기적인 residual cleanup sweep`을 하나 얹는 것이다.

예시:

- 평소 1~2페이지를 계속 돌면서 새 도배 유동을 빠르게 잡음
- 그런데 같은 writer 잔여 글 2개가 남음
- 30사이클째 보정 스윕에서 현재 1~2페이지를 다시 읽음
- 이미 차단된 writer의 남은 글번호만 모아서 `삭제만` 재시도

이 방식이 좋은 이유:

1. 기존 새 후보 탐지 흐름을 거의 안 건드린다.
2. 지금 실제 문제인 `이미 처리한 writer의 잔여 글`을 정확히 겨냥한다.
3. 추가 네트워크 비용이 작다.
4. UI/설정 변경 없이 scheduler 쪽 최소 수정으로 갈 수 있다.

---

## 4. 구현하고자 하는 동작

### 4.1 기본 원칙

기존 동작은 유지한다.

- 평소 사이클:
  - 기존과 동일
  - 새 writer 대상 `차단+삭제` 중심

- 보정 스윕:
  - **30사이클마다 한 번**
  - 현재 `minPage~maxPage` 범위만 다시 확인
  - 현재 페이지에 남아 있는 도배기탭 글 중
  - **이미 active ban인 writer의 잔여 글만 `delete-only`**

핵심은 이거다.

- 평소 루프는 `writer 기준 제재`
- 보정 스윕은 `page 기준 잔여 청소`

---

### 4.2 보정 스윕 상세 플로우

관련 구현 예상 위치:

- 메인 루프: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L249)
- post 삭제 API 재사용: [deletePosts()](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L170)

보정 스윕 플로우는 이렇게 간다.

1. `currentSource === 'manual'`인지 먼저 확인
2. `runtimeDeleteEnabled === true`인지 확인
3. `cycleCount`가 30의 배수인지 확인
4. 세 조건 중 하나라도 아니면 아무것도 안 함
5. 조건을 만족하면 현재 설정된 `minPage~maxPage`를 다시 순회
6. 각 페이지에서 `parseTargetPosts()`로 현재 보이는 도배기탭 글을 다시 읽음
   - 이때 `includeUidTargets: this.includeUidTargetsMode`도 기존 manual 모드 의미대로 그대로 넘긴다
7. 이때는 `writer dedupe`를 하지 않음
8. 각 글을 보면서:
   - 기존 `hasActiveBanForPost(post)` 또는 동일 writerKey 판정을 재사용
   - 해당 writer가 active ban이면 `residualDeleteTargets`에 `postNo` 추가
   - active ban이 아니면 여기서는 무시
9. 모은 `postNo`를 dedupe한 뒤 `deletePosts()`로 삭제 재시도
10. 성공/실패/삭제한도 로그를 남김

보정 스윕의 active ban 판정은
기존 루프와 같은 `writerKey` 의미를 그대로 따라야 한다.

관련 코드:

- writerKey 생성: [parser.js](/home/eorb915/projects/dc_defense_suite/features/ip/parser.js#L53)
- active ban 판정: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L495)

즉:

- 보정 스윕도 별도 writer 판정 규칙을 새로 만들지 않고
- **현재 `writerKey` 기준 active ban 의미를 그대로 재사용**하는 것이 맞다

또 하나 중요한 점:

- 평소 사이클 완료 직후에는 `currentPage=0` 상태로 쉬는 흐름이 자연스럽다
- 그런데 보정 스윕이 내부에서 다시 페이지를 순회하면 UI에 현재 페이지가 보정 스윕 페이지로 보일 수 있다

따라서 최소 패치에서도:

- 스윕 종료 후 `currentPage`는 다시 `0`으로 복원
- 필요하면 마지막에 `saveState()` 1회 추가
- 스윕 중간 페이지는 **런타임 표시용으로만 쓰고**
- `chrome.storage.local` 재개 체크포인트로는 저장하지 않는다

를 문서 기준 동작으로 잡는 것이 안전하다.

이유:

- 보조 청소 스윕은 `resume` 기준점이 아니다
- 만약 스윕 도중의 `currentPage`를 저장해버리면
- service worker가 그 순간 재시작됐을 때
- 다음 실행이 `보조 청소 페이지`부터 재개되는 혼선이 생길 수 있다

중요:

- **이 스윕은 `새 writer 탐지`용이 아니다**
- **이미 차단된 writer의 찌꺼기 글 청소용이다**
- **그리고 1차 범위에서는 `manual` source에만 적용한다**

즉 최소 패치 기준에서는
`보정 스윕이 새 writer까지 다시 차단하지는 않는다.`

그 이유는:

- 새 writer까지 다시 다루기 시작하면 기존 루프와 책임이 겹친다.
- 최소 패치 범위를 벗어난다.

---

### 4.3 예시

#### 예시 1. 지금 문제를 해결하는 경우

- 설정: `1~2페이지`
- `ㅇㅇ(175.215)`가 도배기탭 글 3개 올림
- 평소 루프에서 첫 글 1개는 차단/삭제 성공
- 나머지 2개는 페이지에 남음
- 이후 평소 루프는 같은 writer라 다시 잘 안 건드림

30사이클 보정 스윕:

- 현재 1~2페이지를 다시 읽음
- `ㅇㅇ(175.215)`는 이미 active ban 상태
- 남은 글 2개의 `postNo`를 모음
- `deletePosts()`로 삭제-only 수행

결과:

- 이미 차단된 유동의 남은 도배기탭 글이 정리됨

#### 예시 2. 새 writer는 평소 루프가 처리

- `ㅇㅇ(121.191)`가 새로 도배기탭 글 올림
- active ban 없음
- 보정 스윕은 이 writer를 직접 건드리지 않음
- 다음 평소 루프에서 기존 방식대로 `차단+삭제`

즉:

- 새 writer는 평소 루프 담당
- 남은 찌꺼기 글은 보정 스윕 담당

역할이 안 겹친다.

#### 예시 3. cutoff 의미가 일부 넓어지는 경우

- 수동 IP 차단을 `includeExistingTargetsOnStart=false`로 시작
- 시작 시점 이전에 이미 있던 도배기탭 글 1개가 페이지에 남아 있음
- 이후 같은 writer가 새 글을 올려 active ban 상태가 됨
- 30사이클 보정 스윕이 돌 때 그 writer의 예전 잔여 글도 같이 보일 수 있음

이 경우 보정 스윕은 cutoff를 직접 보지 않으므로,
**현재 페이지에 남아 있는 같은 writer의 예전 글도 삭제-only 대상이 될 수 있다.**

이건 기존 `cutoff 이후 새 글만 처리` 의미를 보정 스윕에서 약간 넓히는 동작이다.

하지만 이번 요구사항 자체가

- `도배기탭에 남아 있는 글을 주기적으로 싹 한 번 더 정리`

이므로,
이 의미 변화는 **의도된 trade-off**로 본다.

#### 예시 4. manual full mode일 때 UID 잔여 글도 같이 청소

- 수동 IP 차단을 `includeUidTargetsOnManualStart=true`로 사용 중
- 현재 파서는 `includeUidTargets: true`일 때 UID writer도 대상에 포함한다
- 이미 active ban 상태인 UID writer의 도배기탭 글이 남아 있음

이 경우 residual cleanup sweep도
**기존 manual full mode 의미를 그대로 따라**
UID writer 잔여 글을 delete-only 대상으로 포함해야 한다.

즉 1차 구현은:

- `수동 일반 모드`면 유동 잔여 글만
- `수동 전체 처리 모드`면 유동 + UID 잔여 글

을 그대로 따라가는 것이 맞다.

---

## 5. 최소 패치 기준 필요한 스펙

### 5.1 새 상수

예상:

```js
const RESIDUAL_CLEANUP_SWEEP_INTERVAL_CYCLES = 30;
```

의미:

- `IP 차단` 사이클 30번마다 한 번
- residual cleanup sweep 실행

추가 설정 UI는 만들지 않는다.

이유:

- 지금 목적은 기능 실험과 증상 완화
- 최소 패치가 우선
- monitor child IP까지 건드리면 파급범위가 커진다

---

### 5.2 새 메서드

예상 메서드:

```js
async runResidualCleanupSweep()
```

책임:

1. 현재 설정된 페이지 범위 재조회
2. 도배기탭 현재 목록 파싱
3. active ban writer의 잔여 글 `postNo` 수집
4. `deletePosts()`로 삭제-only 실행
5. 결과 로그 기록

추가로 있으면 좋은 작은 헬퍼:

```js
collectResidualDeleteTargets(posts)
```

또는

```js
getResidualCleanupCandidates(posts)
```

하지만 이것도 꼭 별도 함수로 뺄 필요는 없다.
최소 패치면 `runResidualCleanupSweep()` 내부에서 끝내도 된다.

---

### 5.3 기존 루프 연결 위치

연결 위치는 [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L292) 근처가 가장 자연스럽다.

즉:

1. 평소 페이지 순회 완료
2. `cycleCount += 1`
3. `if (this.currentSource === 'manual' && this.cycleCount % 30 === 0) await this.runResidualCleanupSweep();`
4. 그 다음 `cycleDelay`

이 위치가 좋은 이유:

- 한 사이클의 정상 동작이 끝난 뒤 실행되므로 흐름이 자연스럽다.
- 페이지 순회 중간에 끼워 넣지 않아 기존 루프를 덜 흔든다.
- monitor source를 건드리지 않아 기존 감시 child flow 파급을 줄인다.

---

### 5.4 삭제 API

삭제-only는 [deletePosts()](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L170)를 재사용한다.

이유:

- 이미 게시물 삭제용 API가 있다.
- 별도 새 엔드포인트를 만들 필요가 없다.
- `withDcRequestLease`를 이미 타므로 공통 요청 lease와도 맞는다.

주의:

- 이 경로는 `IP 차단 ban executor`처럼 계정 전환 fallback을 붙여 쓰는 구조는 아니다.
- 즉 residual cleanup에서 삭제 한도가 걸리면 **로그만 남기고 종료하는 최소 패치**로 가는 것이 맞다.

이건 의도된 제한이다.

이유:

- residual cleanup은 핵심 실시간 방어 루프가 아니라 보정 루프다.
- 여기까지 계정 전환 fallback을 넓히면 최소 패치 범위를 벗어난다.

추가로 명확히 할 점:

- 이 경로에서 `delete_limit_exceeded`가 나와도
- **즉시 `runtimeDeleteEnabled=false`로 전환하지 않는다**
- **계정 전환 fallback도 여기서 직접 호출하지 않는다**

즉 최소 패치 기준 동작은:

1. 보정 스윕 삭제 실패 로그 기록
2. 현재 보정 스윕만 종료 또는 다음 페이지/다음 postNo 처리 중단
3. 이후 정상 `ban executor` 경로가 필요한 시점에
   기존 삭제한도 fallback 로직을 그대로 맡긴다

이렇게 해야 보정 스윕이 메인 삭제/차단 상태기를 건드리지 않는다.

---

## 6. 서버 부담 검토

결론:

- **부담은 낮은 편**
- 현재 구조 대비 추가 비용은 매우 작다

예시:

- 설정이 `1~2페이지`
- 평소 1사이클당 목록 GET 2번
- 30사이클이면 목록 GET 60번

보정 스윕 추가 후:

- 30사이클마다 목록 GET 2번 추가
- 총 `60 -> 62`

즉 목록 조회 기준 약 `3.3%` 증가다.

삭제 요청도:

- 잔여 글이 실제로 있을 때만
- `postNo`를 dedupe해서 batch delete로 1~몇 번 더 날리는 수준

따라서:

- 디시 서버에 과한 수준은 아니다
- 특히 `30사이클마다 1회`면 보수적이다

---

## 7. 안전장치

최소 패치라도 아래 조건은 넣는 것이 안전하다.

### 7.1 `runtimeDeleteEnabled === false`면 스윕 생략

이유:

- 이미 삭제 한도 초과로 `차단만 유지` 상태면
- residual cleanup을 돌려도 삭제 성공 확률이 낮다
- 괜히 추가 요청만 만들 수 있다

따라서:

- `runtimeDeleteEnabled`가 `false`면
- residual cleanup sweep은 건너뛴다

### 7.1-b `currentSource !== 'manual'`면 스윕 생략

이유:

- 이번 요구사항은 수동 IP 차단에서 남는 도배기탭 보정이 출발점이다
- monitor child IP까지 바로 확장하면 기존 자동화 흐름 검증 범위가 커진다

따라서 1차 구현은:

- `manual` source에만 residual cleanup sweep 적용
- `monitor` source는 기존 흐름 그대로 유지

### 7.2 `isRunning` 중단 시 바로 탈출

스윕도 루프 일부이므로,
중간에 정지되면 바로 빠져야 한다.

### 7.3 로그는 명확히 분리

예시 로그:

- `🧹 30사이클 잔여 도배기탭 청소 스윕 시작`
- `🧹 1페이지 잔여 글 3개 발견`
- `✅ 잔여 도배기탭 3개 삭제 완료`
- `⚠️ 잔여 도배기탭 삭제 실패 - ...`

평소 루프 로그와 섞여도 의미가 바로 보여야 한다.

### 7.4 스윕 종료 후 `currentPage` 복원

이유:

- 평소 루프는 사이클 완료 후 `currentPage=0`으로 쉬는 상태를 저장한다
- 보정 스윕 중 `currentPage`를 다시 1, 2로 바꾸면
- UI가 `아직 평소 스캔 중`처럼 보일 수 있다

따라서:

- 스윕이 끝나면 `currentPage=0`으로 복원
- 마지막에 상태 저장으로 마무리

이걸 문서 기준 동작으로 고정한다.

### 7.5 `cycleCount`는 워커 재시작 후에도 이어진다

관련 코드:

- 저장: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L618)
- 복원: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L648)

즉 30사이클 residual cleanup sweep은:

- 탭을 계속 켜 둔 연속 30번만 의미하는 게 아니라
- **service worker 재시작 후에도 이어지는 누적 cycleCount 기준**

이다.

예시:

- 29사이클 상태에서 워커 재시작
- 다음 정상 사이클이 30번째면 바로 보정 스윕 실행 가능

이건 허용 가능한 동작이다.

이유:

- residual cleanup은 실시간 즉시 대응이 아니라 best-effort 청소 루프다
- 정확한 wall-clock 주기보다 낮은 코드 변경과 단순성이 더 중요하다

### 7.6 스윕은 active ban writer의 잔여 글만 다룬다

이유:

- 새 writer까지 다시 건드리기 시작하면 기존 평소 루프와 책임이 겹친다
- 중복 차단/중복 로그/책임 혼선 가능성이 생긴다

따라서:

- 새 writer 탐지는 계속 기존 평소 루프가 담당
- 보정 스윕은 이미 active ban writer의 잔여 글만 delete-only

으로 범위를 고정하는 것이 맞다.

---

## 8. 문서화 시점 기준 실제 코드와의 연결 검증

이 문서는 실제 코드 기준으로 아래를 전제로 한다.

1. 잔여 글 문제의 주 원인은 `writer dedupe + active ban skip` 조합이다.
   관련 코드:
   - [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L271)
   - [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L273)
   - [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L495)
   - [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L834)

2. 보정 스윕은 기존 도배기탭 파서 재사용이 가능하다.
   관련 코드:
   - [parseTargetPosts()](/home/eorb915/projects/dc_defense_suite/features/ip/parser.js#L1)

3. 삭제-only API는 이미 있다.
   관련 코드:
   - [deletePosts()](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L170)

4. 요청은 공통 lease를 타므로 동시성 제어를 새로 만들 필요가 없다.
   관련 코드:
   - [withDcRequestLease()](/home/eorb915/projects/dc_defense_suite/background/dc-session-broker.js#L418)

5. 최소 패치 기준으로는 UI 변경이 필요 없다.
   - 새 설정값 없음
   - 새 토글 없음
   - scheduler 내부 상수만 추가
   - background message routing 변경 없음
   - popup lock/UI 상태 계산 변경 없음

6. `cycleCount`는 이미 storage에 저장/복원된다.
   관련 코드:
   - [saveState()](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L609)
   - [loadState()](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L636)
   따라서 `30사이클마다`는 워커 재시작 후에도 이어지는 누적 count 기준으로 구현 가능하다.

7. `currentPage`도 상태에 저장되므로 보정 스윕이 이 값을 건드리면 UI 표시가 달라질 수 있다.
   관련 코드:
   - [saveState()](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L615)
   - [getStatus()](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L697)
   따라서 스윕 종료 후 `currentPage=0` 복원이 필요하다.

8. `deletePosts()`는 게시물 삭제 API이지만, IP ban executor처럼 삭제한도 fallback을 같이 품고 있지는 않다.
   관련 코드:
   - [deletePosts()](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L170)
   - [requestDeleteLimitAccountFallback()](/home/eorb915/projects/dc_defense_suite/background/dc-session-broker.js#L460)
   따라서 residual cleanup은 최소 패치 기준으로 `로그 + 종료` 쪽이 더 안전하다.

9. `parseTargetPosts()`는 `includeUidTargets` 옵션에 따라 UID writer 포함 여부가 달라진다.
   관련 코드:
   - [parseTargetPosts()](/home/eorb915/projects/dc_defense_suite/features/ip/parser.js#L1)
   - [includeUidTargetsMode 상태](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L624)
   따라서 residual cleanup도 기존 manual full mode 의미를 유지하려면 `includeUidTargetsMode`를 그대로 전달해야 한다.

10. active ban writer 판정은 기존 `hasActiveBanForPost()` 의미를 재사용하는 편이 안전하다.
    관련 코드:
    - [hasActiveBanForPost()](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L495)
    별도 writer 판정 함수를 새로 복제하면 active/expired 의미가 어긋날 수 있다.

---

## 9. 이번 문서 기준 권장 구현 범위

이번 1차 구현 범위는 여기까지로 제한한다.

포함:

- 30사이클 residual cleanup sweep
- `currentSource === 'manual'`일 때만 실행
- 현재 `minPage~maxPage` 재조회
- active ban writer의 잔여 글 delete-only
- `runtimeDeleteEnabled === false`면 스킵
- `includeUidTargetsMode` 의미 유지
- 스윕 종료 후 `currentPage=0` 복원
- 전용 로그 추가

제외:

- monitor child IP source까지 sweep 확장
- 새 writer까지 보정 스윕에서 재차단
- 삭제-only에도 계정 전환 fallback 추가
- UI 설정 추가
- sweep 페이지 범위 별도 설정 추가

이렇게 해야 이번 목적에 맞는 **최소 패치**가 된다.

---

## 10. 최종 결론

지금 증상에 가장 맞는 해결책은:

- **30사이클마다**
- **현재 설정된 1~2페이지 같은 범위만 다시 보고**
- **이미 차단된 writer의 남은 도배기탭 글을 delete-only로 한 번 더 치우는 것**

이 방식은:

1. 현재 놓침 원인을 직접 찌르고
2. 기존 빠른 새 후보 탐지 루프를 거의 안 건드리며
3. 서버 부담도 낮고
4. 최소 패치로 구현 가능하다

한 줄로 요약:

- **새 도배범 잡기는 기존 루프**
- **남은 도배기탭 찌꺼기 청소는 30사이클 residual cleanup sweep**
