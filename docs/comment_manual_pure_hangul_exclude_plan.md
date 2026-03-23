# 댓글 방어 수동 전용 순수 한글 제외 토글 구현 플랜

## 목적

`댓글 방어` 수동 기능에만 **`한글제외 유동닉댓글 삭제`** 토글을 추가한다.

토글이 `OFF` 이면 현재와 동일하게:

- 유동닉 댓글을 전부 삭제

토글이 `ON` 이면:

- 유동닉 댓글 중에서
- **순수 한글만으로 이루어진 댓글은 삭제 대상에서 제외**
- 한글 외 문자가 하나라도 섞인 댓글만 삭제

중요:

- 이번 작업은 **수동 댓글 방어에만 적용**
- **댓글 자동화(`commentMonitor`)에는 적용하지 않음**

---

## 왜 비용이 거의 없는가

현재 댓글 방어는 이미 댓글 API 응답에서 `comments` 배열 전체를 받고 있고,
각 댓글 객체의 `memo` 본문도 이미 메모리 안에 있다.

기준 코드:

- 댓글 조회: [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L192)
- 응답 사용: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L166)
- `memo` 사용 흔적: [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L80)

즉 이 기능은:

- 새로운 fetch 추가 없음
- 댓글 API 추가 호출 없음
- 이미 받은 `comment.memo` 문자열에 **로컬 필터 1회** 추가하는 수준

따라서 네트워크 비용은 사실상 증가하지 않는다.

---

## 순수 한글의 정의

이번 1차 구현에서는 **아주 보수적으로** 정의한다.

순수 한글 댓글:

- 공백 제거 후 비어 있지 않고
- 남은 모든 문자가 `한글(Hangul)` 또는 공백뿐인 경우

즉:

- `안녕하세요` -> 순수 한글
- `안 녕 하 세 요` -> 순수 한글
- `ㅋㅋㅋㅋ` -> 순수 한글
- `한글123` -> 순수 한글 아님
- `한글!` -> 순수 한글 아님
- `漢字` -> 순수 한글 아님
- `가漢나` -> 순수 한글 아님
- `abc` -> 순수 한글 아님

이 정의를 쓰는 이유:

- 오탐/누락 논쟁이 적음
- 규칙이 단순하고 설명 가능함
- “순수 한글만 제외”라는 요구와 가장 가깝다

---

## 실제 구조상 주의할 점

### 1. `filterFluidComments()`를 전역으로 바꾸면 안 됨

현재 댓글 방어는 이 공용 필터를 쓴다.

- [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L54)

그리고 삭제 검증도 다시 이 필터를 사용한다.

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L294)

만약 `filterFluidComments()` 자체에 “순수 한글 제외”를 넣어버리면:

- 실제로는 안 지워진 순수 한글 댓글도
- 검증 단계에서 “대상 아님”으로 빠져
- **삭제된 것처럼 오판**할 수 있다

따라서 이번 기능은 절대 이렇게 구현하면 안 된다.

### 2. 별도 후보 필터를 추가해야 함

즉 구조는 이렇게 분리해야 한다.

- 기존 `filterFluidComments()`는 그대로 유지
- 새 helper 예시:
  - `filterDeletionTargetComments(comments, options)`
  - 또는 `excludePureHangulComments(comments)`

실제 삭제 대상 선정 지점에서만 이 helper를 추가로 태운다.

기준 지점:

- 삭제 대상 선정: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L199)

즉:

1. `comments`
2. `filterFluidComments(comments)`
3. 수동 토글 ON이면 `excludePureHangulComments(...)`
4. `extractCommentNos(...)`

이 순서로 가야 한다.

### 3. 삭제 대상이 0개가 되는 케이스를 따로 처리해야 함

현재 `processPost()`는:

- 유동 댓글이 0개면 바로 종료
- 유동 댓글이 있으면 곧바로 `extractCommentNos(...)` 후 삭제 API 호출

기준:

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L199)
- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L211)

이번 토글이 들어가면 새 케이스가 생긴다.

예:

- 유동 댓글 12개 존재
- 그런데 12개가 전부 순수 한글
- 토글 ON
- 실제 삭제 대상은 `0개`

이 경우:

- `fluidComments.length === 0`는 아니므로 기존 early return이 안 걸림
- 그대로 두면 빈 `commentNos`로 삭제 API를 호출할 수 있음

따라서 꼭:

1. `fluidComments`
2. `deletionTargets`
3. `if (deletionTargets.length === 0) return true`

이 분기를 따로 넣어야 한다.

그리고 로그도:

- `유동닉 12개 중 순수 한글 제외로 삭제 대상 0개`

처럼 남기는 것이 좋다.

---

## 수동 전용으로 제한하려면 필요한 구조 변경

여기가 이번 문서의 핵심이다.

현재 `댓글 자동화`는 별도 삭제 로직을 가진 게 아니라,
공격 감지 시 **같은 `commentScheduler`** 를 켠다.

기준 코드:

- [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L372)

즉 `commentScheduler.config`에 토글만 추가하면,
`commentMonitor`가 켰을 때도 같은 설정이 적용될 수 있다.

그래서 “수동 전용”을 지키려면 아래 둘 중 하나가 필요하다.

### 권장안: runtime source 추가

`commentScheduler`에 실행 출처를 넣는다.

예시:

- `currentSource = 'manual' | 'monitor'`

그리고:

- popup에서 `comment start`는 `manual`
- `commentMonitor.ensureManagedDefenseStarted()`에서 켜는 `comment start`는 `monitor`

실제 적용 조건:

- `config.excludePureHangulManualOnly === true`
- 그리고 `currentSource === 'manual'`

일 때만 순수 한글 제외 필터를 적용한다.

이때 `currentSource`는 단순 runtime 값만 두면 부족하다.

이유:

- background 재시작 시 `commentScheduler.loadState()`가 먼저 복원됨
- 이후 `commentMonitor`가 공격 중이면 child ownership을 다시 붙인다

기준:

- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L90)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L104)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L134)

즉 구현 시에는 아래 둘 중 적어도 하나가 필요하다.

1. `currentSource`를 `saveState/loadState`에 저장
2. `commentMonitor.ensureManagedDefenseStarted()`가 child가 이미 running 이어도 source를 `monitor`로 재주입

권장안은 **둘 다**다.

그래야:

- 수동 실행 후 브라우저 재시작
- 자동 공격 중 복원
- 자동 child 재점유

이 경로에서 source가 꼬이지 않는다.

이 방식이 좋은 이유:

- 설정은 하나로 저장 가능
- 자동/수동 분기가 명확
- popup에서도 현재 출처를 상태로 표시 가능

### 비권장안: 수동용 임시 플래그를 외부에서 매번 덮기

이건 background에서 수동 start 전에 켜고 monitor start 전에 끄는 식인데,
공용 scheduler를 같이 쓰는 현재 구조에서는 꼬이기 쉽다.

이번 작업은 이 방식을 권장하지 않는다.

---

## UI 스펙

위치:

- `댓글 방어` 패널 설정 영역

기준 파일:

- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L378)

추가 항목:

- label: `한글제외 유동닉댓글 삭제`
- control: checkbox
- 기본값: `OFF`

설명 문구 예시:

- `ON 시 순수 한글만으로 된 유동닉 댓글은 삭제 대상에서 제외합니다. 수동 댓글 방어에만 적용됩니다.`

popup 바인딩:

- 저장 시 `comment` feature `updateConfig`로 전송

기준:

- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L541)

추가로 실제 구현 때 같이 바꿔야 하는 지점:

- `FEATURE_DOM.comment`에 checkbox element 추가
- `updateCommentUI()`의 `syncFeatureConfigInputs()` 목록에 새 checkbox 추가

기준:

- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L99)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1000)

이걸 빼먹으면:

- 저장은 됐는데 새로고침 시 토글이 원래대로 보이거나
- background 상태와 popup 표시가 어긋날 수 있다.

참고:

- `commentMonitor`가 실행 중이면 popup에서 `comment` 패널 입력이 이미 잠긴다

기준:

- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1149)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L607)

즉 수동 전용 토글이 자동 실행 도중 수정되는 충돌은 현재 구조상 비교적 잘 막혀 있다.

---

## config 스펙

`features/comment/scheduler.js` 기본 config에 추가:

- `excludePureHangulManualOnly: false`

기준 위치:

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L43)

그리고 runtime source 필드도 추가한다.

- `currentSource: '' | 'manual' | 'monitor'`

저장/복원은 기존 `saveState/loadState` 구조를 그대로 확장한다.

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L411)
- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L431)

그리고 `stop()` 시에는 `currentSource`를 비워야 한다.

이걸 안 하면:

- 과거 수동 실행 흔적이 남아
- 다음 자동 실행에서 source가 stale 상태로 보일 수 있다

기준 stop 위치:

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L76)

즉 신규 저장소는 필요 없지만,
**기존 state 구조에 config + currentSource 둘 다 넣는 쪽으로 가야 안전하다.**

---

## parser/helper 스펙

새 helper 예시:

- `normalizeCommentMemo(memo)`
- `isPureHangulCommentMemo(memo)`
- `filterDeletionTargetComments(comments, { excludePureHangul = false })`

권장 규칙:

1. `memo`를 문자열로 정규화
2. HTML entity decode
3. 공백 collapse + trim
4. 비어 있으면 “순수 한글”로 보지 않음
5. 정규식은 보수적으로

예시 정규식:

```js
/^[\\p{Script=Hangul}\\s]+$/u
```

주의:

- `ㅋㅋ`, `ㅎㅎ`, `ㅁㅊ` 같은 것도 Hangul로 잡힘
- 이건 이번 요구사항상 허용

이 helper는 `features/comment/parser.js`에 두는 게 자연스럽다.

이유:

- 댓글 API 응답 필터 로직이 이미 그 파일에 모여 있음
- scheduler는 조합만 담당하면 됨

---

## scheduler 적용 지점

### 삭제 대상 선정

현재:

- `const fluidComments = filterFluidComments(comments);`

기준:

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L199)

변경 후 권장 형태:

1. `const fluidComments = filterFluidComments(comments);`
2. `const deletionTargets = shouldExcludePureHangulForCurrentRun()`
   - `? excludePureHangulComments(fluidComments)`
   - `: fluidComments`
3. `const commentNos = extractCommentNos(deletionTargets);`
4. `if (deletionTargets.length === 0) return true;`

그리고 로그도 대상 수 기준으로 바꿔야 한다.

즉:

- 전체 유동 수
- 실제 삭제 대상 수

를 구분해 보여주는 게 좋다.

예:

- `🗑️ #1045732: 유동닉 12개 중 삭제 대상 5개 삭제 중...`

### 검증 로직은 건드리지 않음

여기가 중요하다.

검증 단계는 이미 실제로 삭제 요청한 `commentNos`를 기준으로 확인한다.

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L259)

따라서:

- 검증용 `filterFluidComments()`는 그대로 두고
- 삭제 대상 선정 로직에만 새 필터를 넣는다

이렇게 해야 오판이 없다.

---

## background / start source 스펙

현재 background는 `feature === 'comment'`면 그냥 `scheduler.start()`를 부른다.

- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L217)

이번 작업에서 필요한 확장:

1. `comment` start 메시지에 선택적으로 `source` 전달 가능
2. popup 수동 start는 `source: 'manual'`
3. `commentMonitor`가 child를 켤 때는 `source: 'monitor'`
4. `commentScheduler.start({ source })` 또는 동등한 setter 구조 추가

현재 실제 코드상:

- popup 수동 start는 `sendFeatureMessage('comment', { action })`
- `commentMonitor` child start도 `this.commentScheduler.start()`를 직접 호출

기준:

- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L544)
- [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L377)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L217)

즉 이 작업을 하려면 **popup 쪽 start payload와 commentMonitor child start 둘 다** 손봐야 한다.

그리고 background의 공용 `start` 라우팅은 지금 `scheduler.start()`를 인자 없이 호출한다.

즉 구현 시에는:

- `handleMessage()`가 `message.source`를 그대로 넘기거나
- `comment` feature만 별도 분기해서 `scheduler.start({ source: message.source })`

로 확장해야 한다.

그리고 `getStatus()`에도 현재 source를 노출하면 디버깅이 쉬워진다.

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L478)

또 하나:

- `resetStats`는 현재 `totalDeleted`와 검증 상태만 초기화한다

기준:

- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L304)

따라서 이번 기능에서는 `resetStats`가 runtime source를 건드리지 않도록 유지하는 편이 맞다.
실행 중 통계 초기화가 source까지 지우면 디버깅이 오히려 어려워질 수 있다.

다만 아래 두 경로는 별도로 손봐야 한다.

1. background의 dormant child 정리 helper
2. gallery 공통설정 변경으로 댓글 방어 상태를 초기화하는 helper

기준:

- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L656)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L665)

현재 이 경로들은 `commentScheduler`의 카운터/실행 플래그만 정리하고,
향후 추가될 `currentSource`는 건드리지 않는다.

즉 구현 시에는:

- `stopDormantCommentMonitorChildScheduler()`에서 stale source 정리
- `resetCommentSchedulerState()`에서도 비실행 상태라면 stale source 정리

를 같이 넣어야 한다.

---

## 실제 플로우

### 수동 댓글 방어 + 토글 OFF

1. 사용자가 `댓글 방어` 실행
2. 게시물 목록 fetch
3. 댓글 fetch
4. 유동닉 댓글 필터
5. 유동닉 댓글 전부 삭제

### 수동 댓글 방어 + 토글 ON

1. 사용자가 `댓글 방어` 실행
2. 실행 source는 `manual`
3. 게시물 목록 fetch
4. 댓글 fetch
5. 유동닉 댓글 필터
6. `memo`가 순수 한글인 댓글 제외
7. 남은 댓글만 삭제

### 댓글 자동화

1. `commentMonitor`가 공격 감지
2. child `commentScheduler` 시작
3. 실행 source는 `monitor`
4. 순수 한글 제외 토글은 **무시**
5. 기존과 동일하게 유동닉 댓글 전부 삭제

즉 자동에는 영향이 없다.

---

## 검증 체크리스트

구현 후 최소 확인 항목:

1. 토글 OFF일 때 기존 댓글 방어 결과가 완전히 동일한가
2. 토글 ON + 수동 실행 시 순수 한글 댓글이 남는가
3. 토글 ON + 수동 실행 시 한자/영문/숫자/기호 섞인 댓글은 삭제되는가
4. `commentMonitor` 경유 자동 실행에서는 토글이 무시되는가
5. 검증 단계에서 삭제 안 한 순수 한글 댓글을 “삭제됨”으로 오판하지 않는가
6. popup 저장/복원에서 토글 상태가 유지되는가
7. background resume 후 source/state가 꼬이지 않는가
8. 유동 댓글은 있지만 순수 한글 제외 후 삭제 대상이 0개일 때 삭제 API를 치지 않는가
9. `commentMonitor` 공격 중 복원 시 child source가 `monitor`로 다시 맞춰지는가
10. `commentMonitor` 실행 중에는 수동 토글 저장/UI 조작이 잠겨 있는가
11. dormant child 정리 후 `currentSource`가 stale로 남지 않는가
12. gallery 공통설정 변경으로 댓글 방어 상태 초기화 시 `currentSource`도 정리되는가

---

## 한 줄 결론

이 기능은 **비용 거의 없이 구현 가능**하다.

다만 안전하게 하려면:

- 공용 `filterFluidComments()`는 그대로 두고
- 수동 삭제 대상 선정 지점에만 새 필터를 얹고
- `commentScheduler` 실행 source를 `manual/monitor`로 구분해
- **수동 실행일 때만** 순수 한글 제외 토글을 적용해야 한다.
