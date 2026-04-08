# 댓글 역류기 방어 구현 계획

## 목표

반도체산업갤 등에서 수집한 **댓글 dataset**을 기준으로,

1. **수동 댓글 방어**에서 `역류기 댓글 공격` 모드를 추가하고
2. 이후 필요하면 **자동 댓글 감시**에서도 같은 dataset을 참고해 `역류기 댓글 공격` 모드로 좁혀서 대응한다.

쉽게 예시로:

- dataset 안에 `hbm은 삼성이 한다`
- 특이점갤 댓글에 `HBM은 삼성이 한다`
- 정규화 후 같으면 **삭제 대상**

즉 개념은 제목 역류기 방어와 같고,
비교 대상만 **게시물 제목 -> 댓글 본문**으로 바뀌는 구조다.

---

## 현재 실제 코드 구조

### 1. 수동 댓글 방어

현재 수동 댓글 방어는:

1. 페이지별 게시물 목록 조회
2. 댓글 있는 게시물만 고름
3. 게시물별 댓글 전체 조회
4. 유동 댓글만 추림
5. 필요하면 `순수 한글 제외` 필터 적용
6. 남은 댓글 삭제

핵심 위치:

- 목록 조회: `features/comment/scheduler.js:113`
- 댓글 전체 조회: `features/comment/scheduler.js:181`
- 유동 댓글 추림: `features/comment/scheduler.js:214`
- 삭제 대상 필터: `features/comment/scheduler.js:221`
- 실제 필터 함수: `features/comment/parser.js:121`

쉽게 예시로:

- 지금은 `순수 한글 제외` ON이면
  - `안녕하세요` -> 제외
  - `HBM은 삼성이 한다` -> 삭제 대상

즉 현재 삭제 대상 필터는 **한글 제외 1종류**만 있다.

추가로 실제 제어/상태 연결은 이렇게 되어 있다.

- popup 수동 기본 toggle start: `popup/popup.js:1135`
- popup 한글 제외 quick toggle start: `popup/popup.js:1157`
- background comment start 분기: `background/background.js:472`
- comment scheduler 현재 상태 저장:
  - `currentSource`: `features/comment/scheduler.js:472`
  - `excludePureHangulMode`: `features/comment/scheduler.js:473`
- popup 상태 반영:
  - `excludePureHangulMode` 표시: `popup/popup.js:2222`
  - monitor 잠금 시 disable: `popup/popup.js:2458`

즉 지금 댓글 수동 quick mode는

- popup 토글
- background `start({ source, excludePureHangulOnStart })`
- comment scheduler 내부 불리언 상태

이 3단계로 이어져 있다.

### 2. 자동 댓글 감시

현재 자동 댓글 감시는:

- 최근 poll 간
  - 새 댓글 수
  - 변화 글 수
  - 실제 삭제 수
를 보고 공격 상태를 판정한다.

핵심 위치:

- 댓글 스냅샷 수집: `features/comment-monitor/scheduler.js:202`
- 공격 판정: `features/comment-monitor/scheduler.js:298`
- 공격 진입 후 댓글 방어 시작: `features/comment-monitor/scheduler.js:372`

중요:

지금 자동 댓글 감시는 **댓글 내용 자체를 안 본다.**

쉽게 예시로:

- 새 댓글 80개 / 변화 글 12개
- 이 수치만 보고 공격으로 본다
- 그 댓글이 반도체 역류 댓글인지, 일반 욕설 테러인지는 아직 구분하지 않는다

추가로 실제 child start 연결도 확인했다.

- 공격 진입: `features/comment-monitor/scheduler.js:357`
- child comment scheduler 시작: `features/comment-monitor/scheduler.js:372`

즉 지금 자동 댓글 감시는 결국

- 공격 감지
- `commentScheduler.start({ source:'monitor' })`

까지만 하고,
**어떤 댓글 공격 모드인지**는 child scheduler에 넘기지 않는다.

쉽게 예시로:

- 지금은 댓글 폭주가 와도
- `역류기 댓글 공격`
- `한글제외 유동닉댓글 삭제`
- `일반 댓글 방어`

이 셋 중 무엇으로 좁힐지 자체를 아직 결정하지 않는다.

### 3. 제목 역류기 방어

게시물 쪽은 이미 역류기 방어 구조가 있다.

- dataset 로더: `features/post/semiconductor-reflux-title-set.js`
- attack mode helper: `features/post/attack-mode.js`
- 수동/자동 게시물 분류에서 같은 `Set.has()` matcher 사용

즉 댓글 방어도 가장 자연스러운 구현은

- **댓글용 dataset 로더**
- **댓글용 normalizer**
- **댓글용 mode 분기**

를 같은 방식으로 추가하는 것이다.

---

## 실제 구현 원칙

이번 문서 기준 구현 원칙은 이거다.

1. **수동 1차는 기존 댓글 방어 구조를 최대한 유지**
2. **자동 2차는 comment monitor가 attack mode를 child comment scheduler에 넘기도록 확장**
3. **댓글 dataset은 제목 dataset과 별도 로더로 분리**
4. **큰 댓글 dataset은 처음부터 shard manifest 구조를 전제**

쉽게 예시로:

- 제목 역류기 방어가 이미 있다고 해서
- 댓글 방어가 제목 dataset 로더를 그대로 재사용하면
- 나중에
  - 정규화 기준
  - key 이름
  - 로그 문구
가 다 꼬인다

그래서:

- 제목은 제목대로
- 댓글은 댓글대로

별도 로더를 두는 게 맞다.

### 이번 교차검증 결론

실제 코드와 다시 대조한 기준으로는 **하드 blocker는 없다.**

다만 구현 들어갈 때 아래 네 개는 반드시 같이 바꿔야 한다.

1. comment 수동 quick mode를 boolean이 아니라 `currentAttackMode` enum 기준으로 정리
2. background `comment start` 경로가 `commentAttackMode`를 scheduler까지 전달
3. popup 새 quick toggle을 `이벤트 / 상태반영 / automation lock` 세 군데에 모두 연결
4. 자동 2차는 단순 toggle 추가가 아니라, monitor 안에 **댓글 샘플링 기반 mode 판정 단계**를 새로 추가

쉽게 예시로:

- 토글만 하나 더 붙이고 `excludePureHangulOnStart` boolean만 재활용하면
- 처음엔 돌아가는 것처럼 보여도
- 저장 상태, UI 표시, 자동 monitor 전환 시점에서 금방 의미가 꼬인다

즉 이번 문서 기준으로는

- **수동 1차는 바로 구현 가능**
- **자동 2차도 방향은 명확하지만 mode 판정 단계 추가가 핵심**

이렇게 보는 게 맞다.

---

## 권장 구현 범위

### 1차

**수동 댓글 역류기 방어만 먼저 구현**

이유:

- 현재 댓글 방어 구조 위에 가장 작게 붙는다
- 운영하면서 오탐/미탐 감이 바로 나온다
- 자동 댓글 감시까지 한 번에 넣는 것보다 리스크가 적다

### 2차

**자동 댓글 역류기 감지/전환 추가**

이유:

- 자동은 “공격 감지”와 “댓글 내용 샘플링”을 같이 바꿔야 해서 범위가 커진다
- 1차에서 수동 검증을 먼저 거친 뒤 붙이는 게 안전하다

즉 한 줄로:

- **1차는 수동**
- **2차는 자동**

---

## 1차 구현안: 수동 댓글 역류기 방어

## 동작 목표

기존 수동 댓글 방어 토글 옆에

- `역류기 댓글 공격`

토글을 추가한다.

이 토글 ON이면:

1. 유동 댓글을 가져오고
2. 댓글 본문을 정규화하고
3. 댓글 dataset `Set.has()`로 확인하고
4. **매치되는 댓글만 삭제**

쉽게 예시로:

- dataset: `["hbm은 삼성이 한다", "트럼프가 반도체 산업 다 망침"]`
- 댓글:
  - `HBM은 삼성이 한다`
  - `ㅇㅇ 개추`
  - `트럼프가 반도체 산업 다 망침`
- 결과:
  - 1, 3번만 삭제
  - `ㅇㅇ 개추`는 유지

### 구현 위치

#### A. 댓글 dataset 로더 추가

새 파일 권장:

- `features/comment/comment-reflux-dataset.js`

역할:

- bundled dataset manifest + shard 로드
- runtime `Set` 생성
- `ensureCommentRefluxDatasetLoaded()`
- `isCommentRefluxDatasetReady()`
- `hasCommentRefluxMemo(memo)`
- `getCommentRefluxDatasetStatus()`

구현 방식은 제목 dataset 로더와 최대한 동일하게 간다.

참고 원본:

- `features/post/semiconductor-reflux-title-set.js`

필수 export 권장:

```js
ensureCommentRefluxDatasetLoaded()
getCommentRefluxDatasetStatus()
isCommentRefluxDatasetReady()
hasCommentRefluxMemo()
replaceCommentRefluxDataset()
```

권장 runtime 상태:

```js
{
  loaded: false,
  memoSet: new Set(),
  memoCount: 0,
  updatedAt: '',
  sourceGalleryId: '',
  sourceGalleryIds: [],
  version: '',
  sourceType: ''
}
```

권장 storage key:

- `commentRefluxDatasetState`

쉽게 예시로:

- 배포본 manifest version이 `2026-04-08-v1`
- 관리자의 local cache version이 `2026-04-08-v0`
- 첫 로드 때 v1로 자동 덮어쓰기

이 구조는 제목 dataset 로더와 동일하게 간다.

중요:

- 댓글 dataset은 제목 dataset보다 더 커질 가능성이 높다
- 그래서 **처음부터 단일 큰 JSON보다 manifest + shard 구조**를 전제로 가는 게 맞다

쉽게 예시로:

- 진짜 배포용 manifest:
  - `data/comment-reflux-set-unified.json`
- 실제 shard:
  - `data/comment-reflux-set-unified.part01.json`
  - `data/comment-reflux-set-unified.part02.json`

#### B. 댓글 본문 정규화 함수 분리

현재 댓글 파서엔 이미 기본 정규화가 있다.

- `features/comment/parser.js:90`

현재 함수:

- HTML entity decode
- `<br>` 제거
- 태그 제거
- 공백 정리

이걸 기반으로 **역류기 비교용 정규화 함수**를 따로 두는 게 좋다.

권장 새 함수:

- `normalizeCommentRefluxMemo()`

권장 위치:

- `features/comment/parser.js`
또는
- `features/comment/comment-reflux-dataset.js`

권장 정규화 수준:

1. `normalizeCommentMemo()` 먼저
2. `String.prototype.normalize('NFKC')`
3. invisible char 제거
4. 소문자화
5. 공백 collapse

제목 역류기처럼 **너무 공격적으로 문자 삭제**는 하지 않는 쪽이 안전하다.

쉽게 예시로:

- `HBM은 삼성이 한다`
- `hbm은   삼성이  한다`
- `HBM은\u200b 삼성이 한다`

이 세 개는 같게 보고,

- `hbm은 삼성이 안한다`

는 다르게 보는 식이다.

권장 함수 시그니처:

```js
function normalizeCommentRefluxMemo(memo) {}
```

권장 구현 기준:

1. `normalizeCommentMemo(memo)` 먼저 호출
2. `normalize('NFKC')`
3. invisible chars 제거
4. lowercase
5. 공백 collapse
6. trim

즉 제목 역류기 normalizer와 비슷하지만,
**댓글은 HTML 정리부터 먼저**라는 점이 다르다.

#### C. 댓글 삭제 대상 필터 옵션 확장

현재:

- `filterDeletionTargetComments(comments, { excludePureHangul })`

권장 변경:

- `filterDeletionTargetComments(comments, { excludePureHangul, refluxOnly, matchesCommentRefluxMemo })`

또는 더 명확하게:

- `filterDeletionTargetCommentsByMode(comments, { mode, ... })`

하지만 현재 코드 구조에 최소 침투로 가려면
기존 함수 확장이 낫다.

권장 동작:

1. `refluxOnly === false` 이고 `excludePureHangul === false`
   - 지금과 동일
2. `excludePureHangul === true`
   - 지금과 동일
3. `refluxOnly === true`
   - `matchesCommentRefluxMemo(comment.memo)` 인 댓글만 통과

권장 최종 시그니처:

```js
filterDeletionTargetComments(comments, {
  excludePureHangul,
  attackMode,
  matchesCommentRefluxMemo,
})
```

예시 attackMode:

- `default`
- `exclude_pure_hangul`
- `comment_reflux`

권장 우선순위:

1. `comment_reflux`면 dataset 매치만 통과
2. `exclude_pure_hangul`이면 순수 한글 제외
3. `default`면 현재와 동일

이렇게 하면 불리언 2개 조합보다 훨씬 덜 헷갈린다.

실제 코드 기준으로도 이 방향이 맞다.

현재는:

- `start(options)` 에서 `excludePureHangulOnStart` 불리언만 받음: `features/comment/scheduler.js:67`
- popup도 같은 불리언만 보냄: `popup/popup.js:1135`, `popup/popup.js:1157`
- background도 같은 불리언만 전달: `background/background.js:472`

즉 역류기 댓글 모드를 넣으려면
지금 boolean 하나 더 붙이는 식보다
아예 `currentAttackMode` enum으로 정리하는 게 낫다.

주의:

`한글 제외`와 `역류기 댓글 공격`을 동시에 켜는 조합은 1차에선 **금지**하는 게 낫다.

쉽게 예시로:

- 둘 다 켜면
  - 필터 우선순위
  - UI 의미
가 헷갈린다

1차는:

- 일반 댓글 방어
- 한글 제외 댓글 방어
- 역류기 댓글 방어

세 개 중 **하나만 수동 모드로 선택**

이게 가장 안전하다.

#### D. comment scheduler 상태 확장

현재 상태:

- `currentSource`
- `excludePureHangulMode`

권장 추가:

- `currentAttackMode`

예시 값:

- `default`
- `exclude_pure_hangul`
- `comment_reflux`

권장 이유:

- 지금 `excludePureHangulMode`는 불리언이라 확장성이 낮다
- 역류기 댓글 모드를 넣으면 상태 표현이 애매해진다

즉 1차에서도 가능하면:

- `excludePureHangulMode` 유지 + `currentAttackMode` 병행

보다는 아예

- `currentAttackMode`

기준으로 정리하는 편이 좋다.

단, 최소 수정으로 가고 싶으면 임시로:

- `excludePureHangulMode`
- `refluxOnlyMode`

2불리언도 가능은 하다

하지만 장기적으로는 `currentAttackMode` enum이 낫다.

권장 실제 변경:

현재:

```js
this.currentSource = '';
this.excludePureHangulMode = false;
```

변경 후:

```js
this.currentSource = '';
this.currentAttackMode = 'default';
```

그리고 `excludePureHangulMode`는 제거하거나,
최소한 계산용 derived 값으로만 남기는 게 낫다.

왜냐면 지금도 popup 상태 반영이 `excludePureHangulMode` 불리언에 묶여 있어서,
역류기 모드를 넣으면 상태 표현이 애매해진다.

실제 영향 위치:

- start: `features/comment/scheduler.js:73`
- stop: `features/comment/scheduler.js:91`
- `shouldExcludePureHangulForCurrentRun()`: `features/comment/scheduler.js:434`
- `setCurrentSource()`: `features/comment/scheduler.js:439`
- saveState: `features/comment/scheduler.js:459`
- loadState: `features/comment/scheduler.js:481`
- getStatus: `features/comment/scheduler.js:535`

여기서 실제로 중요한 점이 하나 더 있다.

현재 코드는:

- `shouldExcludePureHangulForCurrentRun()` 에서 `currentSource === 'manual'` 일 때만 필터를 켠다
- `setCurrentSource('monitor')` 가 되면 `excludePureHangulMode = false` 로 내려버린다

즉 지금 구조 그대로면
자동 2차에서 `exclude_pure_hangul` 이든 `comment_reflux` 든
**monitor source 상태에선 실제 필터가 안 먹을 수 있다.**

쉽게 예시로:

- 자동 댓글 감시가 공격 감지
- child comment scheduler를 `source:'monitor'` 로 켬
- 그 뒤 `comment_reflux` 로 전환하고 싶어도
- 현재 구조는 수동용 boolean에 묶여 있어서 의미가 안 맞는다

그래서 문서 기준 구현에선

- `currentSource`
- `currentAttackMode`

를 분리하고,
실제 삭제 필터는 **source가 아니라 attack mode** 기준으로 판단하게 바꾸는 게 맞다.

예시:

- popup checked 상태는
  - `currentSource === 'manual' && currentAttackMode === 'comment_reflux'`
  처럼 보여주기만 하고
- 실제 필터링은
  - `currentAttackMode === 'comment_reflux'`
  만 보면 된다

#### E. 수동 start 옵션 추가

현재 background는 comment feature start 때:

- `source`
- `excludePureHangulOnStart`

만 넘긴다.

위치:

- `background/background.js:472`

권장 변경:

- `commentAttackMode`

를 start 옵션으로 넘기게 확장

예시:

- 일반 시작
  - `{ action:'start', source:'manual', commentAttackMode:'default' }`
- 한글 제외
  - `{ ..., commentAttackMode:'exclude_pure_hangul' }`
- 역류기 댓글 공격
  - `{ ..., commentAttackMode:'comment_reflux' }`

실제 수정 위치:

- popup start 메시지: `popup/popup.js:1135`
- popup 한글 제외 quick toggle: `popup/popup.js:1157`
- background comment start 분기: `background/background.js:472`
- comment scheduler `start(options)`: `features/comment/scheduler.js:67`

권장 background 분기 예시:

```js
if (message.feature === 'comment') {
  await scheduler.start({
    source: message.source,
    commentAttackMode: message.commentAttackMode,
  });
}
```

실제 코드 확인 결과, 이 부분은 지금 아직 없다.

- background start는 `excludePureHangulOnStart`만 넘긴다: `background/background.js:472`
- comment scheduler `start()`도 `commentAttackMode`를 아직 읽지 않는다: `features/comment/scheduler.js:67`

즉 문서대로 구현할 때 이 start 옵션 경로를 **반드시 같이** 바꿔야 한다.

추가로 background lock 정책은 이미 큰 틀에서 맞다.

- `commentMonitor` running 중
- `comment` feature의 `start/stop/updateConfig/resetStats`
를 막는 분기가 이미 있다: `background/background.js:1190`

즉 새 `역류기 댓글 공격` quick toggle도
결국 `comment start/stop` 액션을 쓰는 한
background 측 추가 lock 분기는 크게 필요 없고,
popup 쪽 UI disable만 같이 맞추면 된다.

#### F. popup 토글 추가

현재 댓글 패널에는:

- 기본 댓글 방어 toggle
- `한글제외 유동닉댓글 삭제` toggle

가 있다.

위치:

- `popup/popup.html:524`
- `popup/popup.js:1157`

여기에 같은 급의 토글을 하나 더 둔다.

예시 문구:

- 제목: `역류기 댓글 공격`
- 설명: `ON 시 바로 시작해서 dataset에 있는 역류기 댓글만 처리, OFF 시 중지합니다.`

권장 UX:

- 일반 댓글 방어 ON 중엔 역류기 토글 ON 금지
- 한글 제외 ON 중엔 역류기 토글 ON 금지
- 역류기 ON 중엔 다른 두 수동 토글 ON 금지

즉 지금 `한글 제외` 토글이 하는 방식과 동일한 quick toggle 패턴으로 간다.

실제 DOM 확장 위치:

- `popup/popup.html:524`
- `popup/popup.js:205`

권장 추가 DOM:

- `commentRefluxModeToggleInput`

권장 추가 FEATURE_DOM 필드:

```js
commentRefluxModeInput: document.getElementById('commentRefluxModeToggle')
```

권장 popup handler 구조:

- `bindCommentQuickAttackModeToggle(toggleInput, attackMode, modeLabel)`

즉 post quick toggle 구조를 재사용하는 방식이 가장 자연스럽다.

참고 원본:

- `popup/popup.js:1326` (`bindPostQuickAttackModeToggle`)

권장 이유:

- 지금 comment와 post UI가 모두 quick toggle 패턴을 이미 쓰고 있다
- comment도 같은 유틸로 맞추면 구현이 덜 꼬인다

실제 교차검증 결과, 새 토글 추가 시 같이 바꿔야 할 곳은 이 셋이다.

1. 이벤트 바인딩
   - `popup/popup.js:1133`
2. 상태 반영
   - `popup/popup.js:2204`
3. monitor lock 시 disable
   - `popup/popup.js:2457`

쉽게 예시로:

- 토글만 HTML에 추가하고
- `updateCommentUI()` 에 checked 상태를 안 넣으면
- 실제 running 상태와 토글 UI가 어긋난다

- 토글만 추가하고
- `applyAutomationLocks()` 에 안 넣으면
- monitor running 중 새 토글만 살아 있는 비대칭 UI가 생긴다

---

## 1차 실제 변경 파일 목록

1. `features/comment/comment-reflux-dataset.js`
   - 새 파일
2. `features/comment/parser.js`
   - `normalizeCommentRefluxMemo()`
   - `filterDeletionTargetComments()` mode 확장
3. `features/comment/scheduler.js`
   - `currentAttackMode`
   - dataset preload
   - manual start guard
   - 삭제 대상 필터에 matcher 전달
4. `background/background.js`
   - comment start 옵션 `commentAttackMode` 전달
   - 필요 시 normalize helper 추가
5. `popup/popup.html`
   - `역류기 댓글 공격` quick toggle 추가
6. `popup/popup.js`
   - toggle 이벤트
   - 상태 반영
   - automation lock 연결

즉 1차는 이 6파일이 핵심이다.

---

## 2차 구현안: 자동 댓글 역류기 방어

## 목표

자동 댓글 감시가 공격을 감지했을 때,
무조건 일반 댓글 방어를 켜지 말고
**댓글 내용 샘플을 보고 역류기 댓글 공격인지 먼저 판정**한다.

쉽게 예시로:

- 최근 poll에서 새 댓글 80개
- 변화 글 12개
- 상위 변화 글 몇 개의 유동 댓글을 샘플링해 보니
- dataset 매치 댓글이 다수
- 그러면 자동 댓글 감시가 `COMMENT_REFLUX` 모드로 진입

### 필요한 추가 단계

현재 자동 댓글 감시는 댓글 개수 변화만 본다.

- `features/comment-monitor/scheduler.js:232`

즉 자동 역류기 모드를 넣으려면
공격 감지 직후 아래 단계가 더 필요하다.

1. `topChangedPosts` 상위 N개 선택
2. 각 게시물 댓글 fetch
3. 유동 댓글만 추림
4. 댓글 본문 정규화
5. dataset 매치 수 계산
6. 샘플 기준치 넘으면 `COMMENT_REFLUX`

권장 자동 판정 기준은 이번 검토 기준으로 아래처럼 확정하는 게 맞다.

1. 변화량 상위 게시물 **5개** 선택
2. 그 5개 글의 유동 댓글을 샘플링
3. 샘플 유동 댓글이 **최소 20개 이상**일 때만 모드 판정
4. 우선순위:
   - `dataset 매치 / 샘플 유동 댓글 >= 70%` -> `comment_reflux`
   - 아니고 `비순수한글 댓글 / 샘플 유동 댓글 >= 70%` -> `exclude_pure_hangul`
   - 둘 다 아니면 `default`

쉽게 예시로:

- 샘플 유동 댓글 30개
- dataset 매치 23개 -> `76.7%`
- 비순수한글 27개 -> `90%`
- 이 경우는 **역류기 댓글 공격 우선**

반대로:

- 샘플 유동 댓글 30개
- dataset 매치 8개 -> `26.7%`
- 비순수한글 24개 -> `80%`
- 이 경우는 **한글제외 유동닉댓글 삭제**

이 우선순위가 맞는 이유:

- dataset 매치는 더 구체적이고 신뢰도가 높다
- 역류기 댓글도 영문/숫자 섞인 경우가 있어 `한글 제외` 조건에도 같이 걸릴 수 있다
- 그래서 더 넓은 규칙인 `한글 제외`보다 **역류기 댓글**을 먼저 봐야 한다

mixed 정책도 이 기준이면 자연스럽다.

- dataset 70% 미만
- 비순수한글 70% 미만
- -> 일반 댓글 방어 유지

### 자동 child scheduler 전달

현재 comment monitor는 공격 진입 시:

- `this.commentScheduler.start({ source:'monitor' })`

만 보낸다.

위치:

- `features/comment-monitor/scheduler.js:377`

권장 변경:

- `this.commentScheduler.start({ source:'monitor', commentAttackMode:'comment_reflux' })`

또는

- `default`

를 명시적으로 넘기게 변경

즉 monitor와 comment scheduler 사이에도
attack mode 개념을 연결해야 한다.

실제 수정 위치:

- `features/comment-monitor/scheduler.js:377`
- `features/comment-monitor/scheduler.js:384`

권장 변경:

```js
await this.commentScheduler.start({
  source: 'monitor',
  commentAttackMode: attackMode,
});
```

그리고 이미 실행 중이면

```js
this.commentScheduler.setCurrentSource('monitor');
this.commentScheduler.setRuntimeAttackMode(attackMode);
```

같은 식으로 mode도 같이 전파하는 구조가 필요하다.

실제 코드 기준으로 지금 빠져 있는 부분은 둘이다.

1. monitor는 현재 `metrics.topChangedPosts`까지만 만들고, 댓글 본문 샘플링을 안 한다
   - `features/comment-monitor/scheduler.js:232`
2. child comment scheduler를 시작/전환할 때 attack mode를 넘기지 않는다
   - `features/comment-monitor/scheduler.js:372`
   - `features/comment-monitor/scheduler.js:384`

즉 자동 2차 구현은 단순 토글 추가가 아니라,
**monitor 안에 새 판정 단계가 하나 더 생기는 작업**이라고 보는 게 맞다.

---

## dataset 형식 권장

댓글 dataset도 제목 dataset과 같은 패턴을 권장한다.

### manifest

예:

```json
{
  "_comment": "실제 댓글 본문은 shard 파일들에 나뉘어 저장된다.",
  "version": "2026-04-08-001500",
  "updatedAt": "2026-04-08T00:15:00.000Z",
  "sourceGalleryIds": ["tsmcsamsungskhynix"],
  "memoCount": 1823401,
  "shards": [
    { "path": "data/comment-reflux-set-unified.part01.json", "memoCount": 700000 },
    { "path": "data/comment-reflux-set-unified.part02.json", "memoCount": 623401 }
  ]
}
```

### shard

예:

```json
{
  "memos": [
    "hbm은 삼성이 한다",
    "트럼프가 반도체 산업 다 망침"
  ]
}
```

주의:

- key 이름을 `titles`로 재활용하지 말고
- 댓글 dataset은 `memos` 또는 `comments`
같이 더 명확하게 두는 게 좋다

권장 파일명:

- manifest: `data/comment-reflux-set-unified.json`
- shard:
  - `data/comment-reflux-set-unified.part01.json`
  - `data/comment-reflux-set-unified.part02.json`

즉 제목 dataset과 이름 규칙은 맞추되,
**title / memo만 구분**하는 편이 가장 직관적이다.

---

## 왜 제목 dataset 로더를 그대로 재사용하지 않냐

이름만 바꿔서 재사용해도 기술적으로는 가능하지만,
댓글은 의미가 다르다.

차이:

1. 정규화 함수가 다르다
2. key 이름이 다르다
3. 로그/상태 라벨이 다르다
4. 데이터 크기 증가 속도가 더 빠르다

즉:

- 공통 helper 일부 재사용
- 로더 파일은 별도

가 더 안전하다.

쉽게 예시로:

- 제목은 `normalizeSemiconductorRefluxTitle()`
- 댓글은 `normalizeCommentRefluxMemo()`

이렇게 따로 두는 편이 유지보수에 낫다.

---

## 구현 순서 권장

### 1단계

댓글 dataset 로더 추가

- `features/comment/comment-reflux-dataset.js`

### 2단계

댓글 정규화 + matcher 추가

- `normalizeCommentRefluxMemo()`
- `hasCommentRefluxMemo()`

### 3단계

수동 댓글 방어 quick toggle 추가

- popup 토글
- background start 옵션
- comment scheduler state/mode 추가

### 4단계

실제 삭제 필터 연결

- `filterDeletionTargetComments()` 확장

### 5단계

수동 로그/상태/UI 정리

예시:

- `🧠 수동 댓글 분류 모드: COMMENT_REFLUX`
- `역류기 댓글 필터 후 23개`

### 6단계

자동 댓글 감시에 샘플링 기반 mode 판정 추가

- 이건 1차 운영 검증 뒤

---

## 실제 구현 시 주의점

### 1. comment scheduler는 지금 request lease를 강하게 쓴다

현재 댓글 API는 대부분 `withDcRequestLease`를 탄다.

- `features/comment/api.js:8`
- `features/comment/api.js:89`
- `features/comment/api.js:150`
- `features/comment/api.js:241`
- `features/comment/api.js:302`

이건 **방어 기능에는 맞다.**

즉 댓글 역류기 방어 런타임은 현재 lease 구조를 그대로 쓰는 게 맞고,
수집기는 별도 collector에서 lease 없이 가는 게 맞다.

### 2. 자동 댓글 감지 샘플링은 2차로 미루는 게 맞다

지금 monitor는 poll마다 게시물 목록만 본다.
댓글 내용까지 보면 요청이 갑자기 늘어난다.

예시:

- 지금: 목록 1~2페이지 GET
- 자동 역류기 감지 추가 후: 변화 글 몇 개의 댓글 API까지 추가 호출

그래서 1차는 수동만 구현하는 게 실제로 더 안전하다.

추가로 실제 코드상 자동은 지금 `topChangedPosts`를 이미 **5개**까지만 잘라서 보존한다.

- `features/comment-monitor/scheduler.js:260`

즉 네가 말한

- “감지됐을 때 5개 게시물 댓글 확인”

기준은 현재 구조와도 자연스럽게 맞는다.

쉽게 예시로:

- 현재 monitor가 이미 변화량 상위 5개를 들고 있음
- 자동 2차에선 이 5개에 대해서만 댓글 샘플 API를 더 붙이면 된다

### 3. popup lock도 같이 봐야 한다

현재 댓글 패널은 monitor가 돌 때 toggle이 잠긴다.

- `popup/popup.js:2457`

새 `역류기 댓글 공격` 토글도
여기 lock 그룹에 같이 넣어야 한다.

안 그러면 예시로:

- monitor running 중
- 기존 comment toggle은 잠김
- 새 역류기 toggle만 살아 있음

같은 비대칭 UI가 생긴다.

### 4. `setCurrentSource()`만으로는 자동 모드 전환이 부족하다

현재 monitor가 child comment scheduler를 이미 켜둔 상태에선

- `setCurrentSource('monitor')`

만 호출한다.

위치:

- `features/comment-monitor/scheduler.js:384`

즉 자동 2차에서 attack mode를 바꾸려면

- `setCurrentAttackMode(nextMode)`
- 또는 `setRuntimeAttackMode(nextMode)`

같은 전용 setter가 comment scheduler에 추가로 필요하다.

쉽게 예시로:

- 이미 댓글 방어가 monitor source로 실행 중
- 이번 poll에서 역류기 댓글 70% 이상 확인
- 이때 source는 그대로 `monitor`인데
- **공격 모드만 `default -> comment_reflux` 로 바꿔야 한다**

그래서 source setter만으로는 부족하다.

### 5. `resetStats`와 상태 복원도 attack mode 기준으로 같이 바뀌어야 한다

현재 comment reset은:

- not running일 때
  - `setCurrentSource('', { logChange:false })`
  - `excludePureHangulMode = false`

만 한다.

위치:

- `background/background.js:694`

즉 `currentAttackMode`를 도입하면 아래 둘도 같이 맞춰야 한다.

1. `resetStats`
   - not running이면 `currentAttackMode = 'default'`
2. `loadState()`
   - 저장된 attack mode를 같이 복원

쉽게 예시로:

- 수동 `역류기 댓글 공격`으로 돌리다 정지
- `통계 초기화`
- 다시 popup 열었는데 이전 mode가 남아 있으면 안 된다

그래서 reset/save/load/getStatus 네 군데를 같이 보는 게 맞다.

---

## 엣지 케이스

1. dataset 비어 있으면 수동 역류기 댓글 공격 start 거부
2. 자동 감시에선 dataset 비어 있으면 그냥 일반 댓글 방어 유지
3. 댓글 본문이 빈 문자열이면 매치 false
4. HTML 태그/엔티티 포함 댓글도 정규화 후 비교
5. 삭제된 댓글(`del_yn`, `is_delete`)은 dataset 비교 전에 스킵
6. 광고 댓글(`COMMENT_BOY`)은 dataset 비교 전에 스킵
7. 순수 한글 제외 모드와 역류기 모드는 동시에 켜지지 않게 제한
8. monitor source일 땐 수동 전용 토글 상태를 강제로 false로 보이게 유지
9. shard 로드 실패 시 수동 주입 dataset fallback 유지
10. 대형 dataset은 `storage.local`에 원문 전부 저장하지 말고 메타만 저장
11. 자동 샘플 유동 댓글이 20개 미만이면 역류기/한글제외 모드 판정 없이 기본 모드 유지
12. 자동 샘플에서 dataset 70%와 비순수한글 70%가 둘 다 넘으면 `comment_reflux` 우선
13. 이미 monitor source로 running 중일 때 source는 유지하고 attack mode만 바뀌어야 함
14. popup 새 quick toggle은 `updateCommentUI()` 와 `applyAutomationLocks()` 둘 다 연결되어야 함
15. 실제 삭제 필터는 `currentSource === 'manual'` 이 아니라 `currentAttackMode` 기준으로 작동해야 함

---

## 검증 포인트

구현 후 정적 검증 체크리스트:

1. 수동 `역류기 댓글 공격` ON 시 `commentScheduler.start({ commentAttackMode:'comment_reflux' })`로 가는지
2. manual start 전에 dataset ready 체크하는지
3. 일반 댓글 방어 ON 중 역류기 토글 ON이 차단되는지
4. 한글 제외 ON 중 역류기 토글 ON이 차단되는지
5. `filterFluidComments()` 이후 `filterDeletionTargetComments()` 에서 dataset 매치만 남는지
6. `normalizeCommentRefluxMemo()` 가 HTML entity, `<br>`, 공백을 안정적으로 정리하는지
7. dataset 샘플 댓글 exact match가 실제 true가 되는지
8. auto comment monitor는 아직 mode 미구현이면 기존 일반 동작을 안 깨는지
9. 저장/복원 시 `commentAttackMode` 상태가 유지되는지
10. popup 상태 반영이 토글 상태와 일치하는지

추가 체크:

11. `comment currentAttackMode`가 save/load/getStatus에 모두 반영되는지
12. `background start`가 `commentAttackMode`를 scheduler까지 그대로 전달하는지
13. `monitor -> comment child start`도 같은 attack mode를 전달하는지
14. `commentMonitor`가 미구현 상태일 때는 기존 일반 동작을 그대로 유지하는지
15. 새 dataset 로더가 shard manifest + shard 파일을 모두 읽어 `Set`을 만드는지
16. dataset version 변경 시 local cache 메타가 새 버전으로 덮어써지는지
17. 자동 감지 시 변화량 상위 5개 글만 샘플링하는지
18. 자동 모드 판정 분모가 `샘플 유동 댓글 전체`인지
19. 자동 모드 판정 최소 표본 `20개` guard가 있는지
20. 자동 모드 우선순위가 `comment_reflux -> exclude_pure_hangul -> default` 순서인지
21. child comment scheduler가 이미 running일 때 source가 아니라 attack mode도 같이 전환되는지
22. `resetStats` 가 not running일 때 `currentAttackMode`를 `default`로 되돌리는지
23. `loadState()` / `getStatus()` / popup 상태 반영이 같은 attack mode 값을 보고 있는지

---

## 결론

쉽게 말하면:

- **수동 댓글 역류기 방어는 지금 댓글 방어 구조에 비교적 쉽게 붙는다**
- 핵심은
  - 댓글 dataset 로더
  - 댓글 정규화 함수
  - `Set.has()` 기반 삭제 필터
  - 수동 quick toggle
  이 네 개다
- **자동 댓글 역류기 방어는 가능하지만**, 댓글 내용 샘플링으로 공격 모드를 판정하는 단계가 추가로 필요하므로 2차로 가는 게 맞다
- 자동 2차의 추천 기준은
  - **변화량 상위 5개 글**
  - **샘플 유동 댓글 최소 20개**
  - **dataset 70%면 역류기**
  - **아니고 비순수한글 70%면 한글제외**
  - **둘 다 아니면 기본 모드**
  이다

예시로 구현 순서를 다시 말하면:

1. 댓글 dataset 로더 추가
2. 수동 `역류기 댓글 공격` 토글 추가
3. dataset 매치 댓글만 삭제되게 연결
4. 충분히 검증한 뒤 자동 댓글 감시에 mode 판정 추가

즉 지금 기준 가장 좋은 방향은:

- **수동 먼저**
- **자동은 그 다음**
