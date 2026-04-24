# 분탕자동차단 page1 유동 댓글 군집 IP차단+삭제 설계

작성일: 2026-04-24

## 목표

`분탕자동차단`은 이미 10초마다 1페이지 HTML을 확인한다. 이 흐름에 댓글 1페이지 조회를 붙여서, 현재 page1에 남아 있는 글들의 유동 댓글 중 정규화 후 같은 댓글이 10개 이상 쌓이면 해당 댓글을 IP차단+삭제한다.

원하는 동작은 아래와 같다.

```text
10초마다 page1 HTML 확인
-> page1 글 중 댓글이 있는 글만 댓글 1페이지 조회
-> 유동 댓글만 추출
-> 댓글 본문 정규화
-> 현재 page1 댓글 스냅샷 전체에서 같은 정규화 댓글 10개 이상
-> 게시물 번호별로 update_avoid_list 기반 댓글 IP차단+삭제 배치 호출
```

중요한 기준:

- `10초 안에 10개`가 아니다.
- `현재 page1에 남아 있는 글들의 댓글 스냅샷 기준으로 10개`다.
- page1에서 글이 사라지면 그 글의 댓글 스냅샷도 제거한다.
- 댓글 조회는 1페이지만 한다.
- 처리는 댓글 IP차단+삭제 API를 쓴다.
- 사유는 `도배기IP차단(무고한 경우 문의)`, 시간은 6시간으로 고정한다.

## 현재 실제 코드 확인

### 1. 분탕자동차단 10초 루프

파일: `features/uid-warning-autoban/scheduler.js`

현재 `runCycle()`은 매 사이클마다 page1 HTML을 한 번 가져온다.

```js
const html = await this.fetchListHtml(this.config, 1);
const allRows = this.parseImmediateRows(html);
const pageUidRows = allRows.filter((row) => row?.hasUid === true);
```

확인 위치:

```text
features/uid-warning-autoban/scheduler.js:192
features/uid-warning-autoban/scheduler.js:204
features/uid-warning-autoban/scheduler.js:205
```

현재 순서:

```text
page1 HTML fetch
-> 전체 row 파싱
-> 제목 직차단
-> 실제공격 제목 클러스터
-> UID 기반 분탕차단
```

처음 초안에서는 댓글 군집 삭제를 제목 직차단보다 먼저 두는 안을 생각했지만, 실제 코드 흐름을 다시 보면 이 순서는 좋지 않다.

문제:

```text
댓글 1페이지 조회가 먼저 실행됨
-> 제목 직차단/실제공격 제목 삭제가 늦어짐
-> 급한 게시물 삭제가 댓글 조회 때문에 지연될 수 있음
```

따라서 최종 권장 위치는 `제목 직차단`, `실제공격 제목 클러스터`를 먼저 처리한 뒤다.

```text
page1 HTML fetch
-> 전체 row 파싱
-> 제목 직차단
-> 실제공격 제목 클러스터
-> 댓글 군집 스냅샷 갱신/삭제
-> UID 기반 분탕차단
```

이유:

- 제목/실제공격 제목 삭제가 댓글 조회 때문에 늦어지지 않는다.
- 이미 글 단위로 제재한 postNo는 댓글 조회 대상에서 제외할 수 있어 API 호출을 줄인다.
- 글 제재로 삭제될 글의 댓글을 또 조회/삭제하지 않아 중복 작업이 줄어든다.
- 댓글 삭제가 실패해도 기존 제목/UID 방어는 계속 진행할 수 있다.

### 2. page1 row 파서

파일: `features/uid-warning-autoban/parser.js`

현재 `parseImmediateTitleBanRows()`는 `requireUid:false`라서 유동글까지 포함해 row를 만든다.

현재 row 구조:

```js
{
  no,
  uid,
  nick,
  title,
  subject,
  currentHead,
  createdAtText,
  createdAtMs,
  writerToken,
  writerKey,
  writerDisplay,
  contentType,
  isPicturePost,
  isFluid,
  hasUid,
  ip,
}
```

확인 위치:

```text
features/uid-warning-autoban/parser.js:26
features/uid-warning-autoban/parser.js:76
```

문제:

- 현재 parser는 제목에서 `<span class="reply_num">[3]</span>`을 제거한다.
- 하지만 댓글 수를 `commentCount`로 보관하지 않는다.
- 새 기능은 `commentCount > 0`인 글만 댓글 API를 호출해야 하므로 `commentCount` 필드를 추가해야 한다.

수정 방향:

```js
const commentCount = extractCommentCount(rowHtml);

results.push({
  ...
  commentCount,
});
```

`extractCommentCount(rowHtml)`는 기존 댓글방어의 목록 파싱 방식을 참고한다.

현재 댓글방어는 아래 위치에서 댓글 수를 가져온다. 다만 기존 정규식은 `class="reply_num"` exact 형태라 class 속성 변형에 약하다.

확인 위치:

```text
features/comment/api.js:108
```

새 기능에서는 아래처럼 더 넓게 잡는다.

```js
const replyMatch = rowHtml.match(/<span[^>]*class="[^"]*reply_num[^"]*"[^>]*>\[(\d+)\]<\/span>/i);
const commentCount = replyMatch ? parseInt(replyMatch[1], 10) : 0;
```

### 3. 댓글 조회 API

파일: `features/comment/api.js`

댓글 1페이지 조회 함수 자체는 이미 `fetchComments(config, postNo, esno, commentPage)`가 있다.

```js
async function fetchComments(config = {}, postNo, esno, commentPage = 1, options = {}) {
  const url = `${resolved.baseUrl}/board/comment/`;
  ...
  comment_page: String(commentPage),
}
```

확인 위치:

```text
features/comment/api.js:202
```

하지만 구현에서 `fetchComments()`를 직접 호출하는 것은 피하는 편이 낫다.

이유:

- `fetchComments()`는 실제 1페이지 조회 함수지만, 자체적으로 `withDcRequestLease()`를 잡지 않는다.
- 기존 `fetchAllComments()`와 `fetchRecentComments()`가 바깥에서 `withDcRequestLease()`를 잡고 `fetchComments()`를 호출하는 구조다.
- 계정 전환/세션 전환 중 요청 drain과 충돌하지 않으려면 lease를 잡는 wrapper를 써야 한다.

따라서 이번 기능에서는 `fetchRecentComments(config, postNo, esno, 1)`를 사용한다.

```text
사용: fetchRecentComments(config, postNo, esno, 1)
미사용: fetchAllComments()
```

이유:

- 이번 기능은 page1 댓글만 보면 된다.
- `fetchRecentComments(..., 1)`은 내부적으로 `comment_page=1`만 조회한다.
- `fetchRecentComments()`는 `withDcRequestLease()`로 감싸져 있어 세션 브로커와 연결이 맞다.
- 모든 댓글 페이지를 긁으면 상시 10초 루프에서 요청량이 커진다.
- 공격 댓글은 보통 최신 댓글 1페이지에 쌓이므로 1페이지만으로도 목적에 맞다.

`e_s_n_o`는 page1 HTML에서 한 번 추출해서 공유한다. 기존 댓글방어의 `fetchPostList()`도 목록 HTML에서 `extractEsno(html)`를 호출한다.

확인 위치:

```text
features/comment/api.js:91
features/comment/api.js:98
features/comment/api.js:173
```

권장 연결:

```js
import {
  extractEsno,
  fetchRecentComments,
  deleteAndBanComments,
} from '../comment/api.js';
```

삭제/조회 사이의 delay는 `features/uid-warning-autoban/api.js`에서 이미 가져오는 `delay` 또는 scheduler의 `this.delayFn`를 쓴다. `comment/api.js`의 `delay`를 별칭으로 다시 import할 필요는 없다.

### 4. 유동 댓글 필터

파일: `features/comment/parser.js`

기존 유동 댓글 판정은 `ip !== ''`다.

```js
function isFluidUser(comment) {
  return comment.ip !== '';
}
```

삭제 대상 필터는 이미 있다.

```js
function filterFluidComments(comments) {
  return comments.filter(comment => {
    if (shouldSkip(comment)) return false;
    return isFluidUser(comment);
  });
}
```

확인 위치:

```text
features/comment/parser.js:38
features/comment/parser.js:70
```

새 기능도 이 함수를 그대로 쓴다.

### 5. 댓글 IP차단+삭제 API

파일: `features/comment/api.js`

댓글 IP차단+삭제는 이미 `deleteAndBanComments(config, postNo, commentNos)`가 있다.

```js
async function deleteAndBanComments(config = {}, postNo, commentNos) {
  const normalizedCommentNos = normalizeCommentNos(commentNos);
  ...
  const commentNoChunks = chunkArray(normalizedCommentNos, COMMENT_ACTION_BATCH_LIMIT);
  ...
}
```

확인 위치:

```text
features/comment/api.js:396
```

실제 엔드포인트:

```text
POST /ajax/minor_manager_board_ajax/update_avoid_list
Body: ci_t, id, nos[], parent, avoid_hour, avoid_reason, avoid_reason_txt, del_chk, _GALLTYPE_, avoid_type_chk
```

확인 위치:

```text
features/comment/api.js:573
```

중요한 제약:

- `parent`가 필수다.
- 따라서 여러 게시물에 흩어진 같은 댓글 군집은 감지는 합산하되 삭제는 게시물별로 나눠야 한다.
- `deleteAndBanComments()` 내부에서 댓글 번호 50개 단위 chunk 처리를 이미 한다.
- `avoid_reason_txt`는 `도배기IP차단(무고한 경우 문의)`로 보낸다.

## 구현 설계

### 새 모듈

권장 파일:

```text
features/uid-warning-autoban/attack-comment-cluster.js
```

역할:

- 댓글 본문 정규화
- 유동 댓글 candidate 생성
- 같은 정규화 댓글 군집 탐지
- 게시물별 삭제 계획 생성

권장 export:

```js
const ATTACK_COMMENT_CLUSTER_MIN_COUNT = 10;
const ATTACK_COMMENT_MIN_NORMALIZED_LENGTH = 6;

function normalizeAttackComment(value) {}
function buildAttackCommentCandidates(snapshotEntries) {}
function detectAttackCommentClusters(snapshotEntries, options = {}) {}
function buildDeletePlanByPostNo(cluster) {}
```

### 댓글 정규화 기준

기반은 기존 댓글 HTML 정리 + 제목 공격 정규화 재사용이다.

사용할 함수:

```text
features/comment/parser.js
- normalizeCommentMemo()

features/uid-warning-autoban/parser.js
- normalizeImmediateTitleValue()
```

권장 구현:

```js
function normalizeAttackComment(value) {
  return normalizeImmediateTitleValue(normalizeCommentMemo(value))
    .replace(/[a-z]+/g, '')
    .trim();
}
```

의미:

- HTML 태그 제거
- HTML entity decode
- 공백 정리
- NFKC 정규화
- zero-width/invisible 문자 제거
- 이모티콘/기호/특수문자 제거
- 한글 사이에 끼운 영문 제거
- 남은 영문도 제거

예시:

```text
원본1: 안ˇ녕 오♡늘 공 격
원본2: 안녕오늘공격
원본3: 안x녕오x늘공격
정규화: 안녕오늘공격
```

짧은 댓글 오탐 방지:

```text
정규화 후 6자 미만은 군집 후보 제외
```

예시:

```text
ㅋㅋ
ㄹㅇ
굿
```

이런 댓글은 10개가 있어도 일반 반응일 수 있어서 기본 제외한다.

### Scheduler 상태 추가

파일: `features/uid-warning-autoban/scheduler.js`

constructor에 추가:

```js
this.commentSnapshotByPostNo = {};
this.recentAttackCommentActions = {};
this.lastAttackCommentClusterCount = 0;
this.lastAttackCommentClusterDeleteCount = 0;
this.lastAttackCommentClusterPostCount = 0;
this.lastAttackCommentClusterRepresentative = '';
this.totalAttackCommentClusterDeleteCount = 0;
```

스냅샷 entry 구조:

```js
{
  postNo: 901,
  commentCount: 3,
  lastCheckedAt: '2026-04-24T...',
  comments: [
    {
      postNo: 901,
      no: '158333',
      ip: '220.87',
      name: 'ㅇㅇ',
      memoPreview: '원본 댓글 앞부분',
      normalizedMemo: '정규화댓글',
    },
  ],
}
```

주의:

- 원본 댓글 전문을 계속 저장하지 않는다.
- `chrome.storage.local`에 저장될 수 있으므로 `memoPreview`는 120자 정도로 자른다.
- 군집 판단에는 `normalizedMemo`만 필요하다.
- popup/log 대표 문구도 `normalizedMemo` 또는 짧은 preview만 쓴다.

recent action 구조:

```js
{
  '901::158333': {
    postNo: 901,
    commentNo: '158333',
    normalizedMemo: '정규화댓글',
    lastActionAt: '2026-04-24T...',
    success: true,
  }
}
```

recent action이 필요한 이유:

- 삭제 응답 성공 후 검증 없이도 같은 댓글을 다음 사이클에 다시 삭제 시도하지 않게 막는다.
- 이미 삭제된 댓글이 API 응답 캐시에 잠깐 남는 경우에도 중복 호출을 줄인다.

보관 시간:

```text
10분
```

상태 생명주기:

```text
start(): commentSnapshotByPostNo는 새로 비운다.
resumeIfNeeded(): 실행 중 저장 상태 복원 시에는 snapshot을 복원해도 된다.
stop(): commentSnapshotByPostNo는 비운다.
resetStats/resetUidWarningAutoBanSchedulerState(): snapshot/recent action/댓글 군집 통계를 모두 비운다.
galleryId 변경 reset: snapshot/recent action을 반드시 비운다.
```

이유:

- 정지 후 다시 켰을 때 이전 page1 댓글이 남아 있으면 첫 사이클 전 popup/status에 오래된 값이 보일 수 있다.
- 실행 중 service worker가 재시작된 경우에는 다음 사이클에서 page1 기준 prune을 하므로 snapshot 복원이 가능하다.
- 갤러리 변경 시에는 postNo/commentNo가 다른 갤러리와 섞이면 안 된다.

### Config 기본값

`DEFAULT_CONFIG`에 추가:

```js
attackCommentClusterEnabled: true,
attackCommentClusterMinCount: 10,
attackCommentMinNormalizedLength: 6,
attackCommentFetchConcurrency: 10,
attackCommentFetchRequestDelayMs: 100,
attackCommentFetchTimeoutMs: 15 * 1000,
attackCommentDeleteDelayMs: 100,
attackCommentDeleteTimeoutMs: 15 * 1000,
attackCommentSnapshotTtlMs: 30 * 1000,
```

의미:

- `attackCommentClusterEnabled`: 기능 ON/OFF. 기본은 ON.
- `attackCommentClusterMinCount`: 같은 댓글 몇 개부터 삭제할지. 기본 10개.
- `attackCommentMinNormalizedLength`: 너무 짧은 댓글 제외. 기본 6자.
- `attackCommentFetchConcurrency`: 댓글 API 게시물 단위 worker 수. 기본 10.
- `attackCommentFetchRequestDelayMs`: 댓글방어 `requestDelay`처럼 worker가 게시물 하나를 끝낸 뒤 다음 게시물을 잡기 전 대기. 기본 100ms.
- `attackCommentFetchTimeoutMs`: 게시물 1개 댓글 조회가 멈췄을 때 다음 cycle이 무한히 밀리지 않게 끊는 timeout. 기본 15초.
- `attackCommentDeleteDelayMs`: 게시물별 차단/삭제 호출 간격. 기본 100ms.
- `attackCommentDeleteTimeoutMs`: 게시물 1개 댓글 차단/삭제 호출이 멈췄을 때 끊는 timeout. 기본 15초.
- `attackCommentSnapshotTtlMs`: 댓글 수가 안 바뀐 글도 너무 오래 방치하지 않기 위한 재확인 간격. 기본 30초.

사용자가 말한 기준 반영:

```text
댓글방어는 100ms / 동시성 50도 문제 없었음
-> 새 기능은 상시 감시라 worker 10 / worker 후속 작업 대기 100ms로 조금만 보수적으로 시작
```

설정 저장 기준:

- 위 값들은 우선 내부 기본값으로만 둔다.
- 별도 UI 입력을 만들지 않는다면 `buildPersistedConfig()`에 저장할 필요는 없다.
- 나중에 popup에서 threshold/concurrency를 조정하게 만들 경우에만 `buildPersistedConfig()`, `readPersistedConfig()`, popup config input 연결을 추가한다.

### runCycle 삽입 흐름

권장 코드 흐름:

```js
const html = await this.fetchListHtml(this.config, 1);
const allRows = this.parseImmediateRows(html);
const pageUidRows = allRows.filter((row) => row?.hasUid === true);

const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const processedAttackTitlePostNos = await this.handleAttackTitleClusterRows(...);
const processedPostNos = new Set([
  ...processedImmediatePostNos,
  ...processedAttackTitlePostNos,
]);

await this.handleAttackCommentClusterRows(
  allRows.filter((row) => !processedPostNos.has(Number(row?.no) || 0)),
  html,
  nowMs,
);
```

`handleAttackCommentClusterRows()`는 실패해도 throw하지 않는 것이 좋다.

```js
try {
  await this.handleAttackCommentClusterRows(
    allRows.filter((row) => !processedPostNos.has(Number(row?.no) || 0)),
    html,
    nowMs,
  );
} catch (error) {
  this.log(`⚠️ 실제공격 댓글 군집 확인 실패 - ${error.message}`);
}
```

이유:

- 댓글 군집 확인 실패 때문에 기존 제목/UID 방어가 멈추면 안 된다.
- 댓글 API가 일시 실패해도 다음 10초 사이클에서 다시 보면 된다.
- `handleAttackCommentClusterRows()`에는 제목 직차단/실제공격 제목으로 이미 처리된 postNo를 제외한 rows만 넘긴다.
- 이 rows를 기준으로 스냅샷을 prune해야 한다. 즉, 글 단위로 제재된 postNo도 댓글 스냅샷에서 제거된다.

### 댓글방어 실행 중 중복 호출 방지

기존 댓글방어가 켜져 있으면 이미 page1 글의 유동 댓글을 훨씬 강하게 처리한다. 이때 새 댓글 군집 스캐너까지 같이 돌면 같은 댓글 API와 차단/삭제 API를 중복 호출할 수 있다.

따라서 `UidWarningAutoBanScheduler`에 optional dependency를 추가한다.

```js
this.isCommentDefenseRunning = dependencies.isCommentDefenseRunning || (() => false);
```

background 생성 시점에는 `commentScheduler`가 이미 있으므로 아래처럼 연결 가능하다.

```js
const uidWarningAutoBanScheduler = new UidWarningAutoBanScheduler({
  isCommentDefenseRunning: () => commentScheduler.isRunning,
});
```

동작:

```text
댓글방어 OFF -> 댓글 군집 스캔 실행
댓글방어 ON -> 현재 page1 기준 스냅샷 prune 후 댓글 군집 스캔 스킵, 기존 댓글방어에 맡김
```

이유:

- API 호출량을 줄인다.
- 같은 댓글을 두 기능이 동시에 삭제하려는 상황을 줄인다.
- 분탕자동차단의 제목/UID 방어는 그대로 계속 돈다.
- 댓글방어가 오래 켜져 있어도 이전 page1 스냅샷이 stale 상태로 남지 않는다.

## 세부 플로우

### 1. page1 글 기준 스냅샷 정리

매 사이클마다 현재 page1 글번호 set을 만든다.

```js
const pagePostNos = new Set(allRows.map((row) => String(row.no)));
```

그리고 스냅샷에서 page1에 없는 글을 제거한다.

```text
이전 스냅샷: 901, 902, 903
현재 page1: 902, 903, 904
삭제: 901 snapshot 제거
유지: 902, 903
신규: 904
```

이 처리가 핵심이다.

이걸 하지 않으면 page1에서 사라진 오래된 글 댓글이 계속 군집 계산에 남아 오탐이 생긴다.

### 2. 댓글 조회 후보 선정

후보 조건:

```text
commentCount > 0
그리고 아래 중 하나:
1. 스냅샷에 없는 새 글
2. 이전 스냅샷보다 commentCount가 바뀐 글
3. 마지막 확인 후 30초 이상 지난 글
```

예시:

```text
현재 page1:
901 댓글 3개
902 댓글 0개
903 댓글 8개
904 댓글 2개
```

첫 실행이면 스냅샷이 비어 있으므로:

```text
조회 대상: 901, 903, 904
스킵: 902
```

다음 사이클:

```text
901 댓글 3개 그대로
903 댓글 10개로 증가
904 page1에서 사라짐
905 새 글 댓글 4개
```

처리:

```text
904 snapshot 제거
903 재조회
905 조회
901은 댓글 수 그대로라 스킵
```

### 3. 댓글 API 호출

호출 함수:

```js
fetchRecentComments(this.config, postNo, esno, 1)
```

동시 처리:

```text
concurrency = 10
worker request delay = 100ms
```

구현 방식:

```js
await mapWithConcurrencyWorkerPool(
  candidates,
  getAttackCommentFetchConcurrency(this.config),
  getAttackCommentFetchRequestDelayMs(this.config),
  async (row) => {
    const { comments } = await fetchRecentComments(this.config, row.no, esno, 1);
    ...
  },
);
```

`mapWithConcurrencyWorkerPool`은 댓글방어 `processPostsInParallel()`처럼 scheduler 내부 helper로 둔다.

각 댓글 조회는 `AbortController` 기반 timeout을 같이 건다.

```text
fetchRecentComments(..., { signal })
15초 안에 끝나지 않으면 해당 글 조회만 실패 처리
다른 worker와 다음 cycle은 계속 진행
```

권장 helper 동작:

```text
worker 수는 concurrency로 제한
처음 worker들은 즉시 시작
worker가 candidate 하나를 끝낸 뒤 requestDelayMs만큼 쉬고 다음 candidate를 잡음
작업 중 this.isRunning === false가 되면 남은 candidate는 처리하지 않음
작업 중 댓글방어가 ON으로 바뀌면 남은 candidate는 처리하지 않음
개별 실패는 결과 객체로 수집하고 전체 Promise를 깨지 않음
```

예시:

```text
candidate 50개 / concurrency 10 / requestDelay 100ms
0~9번은 즉시 시작
먼저 끝난 worker가 100ms 쉰 뒤 10번 이후를 순서대로 처리
즉 시작 간격을 강제로 0,100,200ms로 벌리는 구조가 아니라 댓글방어와 같은 worker pool 구조
```

중요:

- 댓글 조회는 1페이지뿐이다.
- `fetchRecentComments()`는 반드시 `maxPages=1`로 호출한다.
- `fetchAllComments()`는 사용하지 않는다.
- 각 댓글 조회 직전에도 `this.isRunning`과 `this.isCommentDefenseRunning()`을 다시 확인한다.
- 각 댓글 조회/차단삭제는 timeout signal을 넘겨 한 요청이 멈춰도 전체 cycle이 무한 대기하지 않게 한다.
- 현재 `uid-warning-autoban` run loop는 `runCycle()` 완료 시각 기준으로 다음 10초 대기를 잡는다. 댓글 조회가 길어지면 다음 page1 HTML fetch도 그만큼 밀린다.
- 그래서 긴급 글 제재인 제목 직차단/실제공격 제목 클러스터를 먼저 실행하고, 댓글 조회는 그 뒤에 둔다.
- 초기 스냅샷은 page1 댓글 있는 글을 모두 조회할 수 있어 1회 지연이 생길 수 있다. 이후부터는 새 글/댓글 수 변경/30초 TTL 대상만 조회하므로 지연이 줄어든다.
- page1 후보는 보통 최대 50개 수준이므로 `concurrency=10`, `requestDelay=100ms`면 댓글방어와 같은 방식으로 초기 스냅샷을 병렬 처리한다.

### 4. 스냅샷 갱신

댓글 조회 결과는 유동 댓글만 저장한다.

```js
const fluidComments = filterFluidComments(comments);
```

각 댓글에 정규화값을 붙인다.

```js
const normalizedMemo = normalizeAttackComment(comment.memo);
```

스냅샷 저장:

```js
this.commentSnapshotByPostNo[postNo] = {
  postNo,
  commentCount: row.commentCount,
  lastCheckedAt: new Date().toISOString(),
  comments: fluidComments
    .map(...)
    .filter((comment) => comment.normalizedMemo.length >= minLength),
};
```

댓글 조회 실패 시:

```text
기존 snapshot이 있으면 유지
기존 snapshot이 없으면 빈 상태로 둠
로그만 남기고 기존 방어 계속 진행
```

이유:

- 일시 API 실패로 전체 군집 판단을 초기화하면 공격 감지가 늦어질 수 있다.
- 하지만 page1에서 사라진 글은 이미 앞 단계에서 제거했으므로 오래된 글이 무한히 남지는 않는다.

### 5. 군집 계산

스냅샷 전체에서 댓글을 모은다.

```js
const snapshotComments = Object.values(this.commentSnapshotByPostNo)
  .flatMap((entry) => entry.comments);
```

recent action 성공 댓글은 제외한다.

```text
이미 삭제 성공한 901::158333은 군집 계산 제외
```

정규화값 기준으로 group한다.

```text
normalizedMemo = "안녕오늘공격"
901 댓글 3개
903 댓글 4개
905 댓글 3개
=> 총 10개, 군집 성립
```

군집 조건:

```text
유동 댓글
정규화 후 6자 이상
같은 normalizedMemo 10개 이상
```

여러 군집이 동시에 잡힐 수 있다.

처리 순서:

```text
큰 군집 우선
동일 개수면 최신 댓글 번호가 큰 군집 우선
```

### 6. 삭제 계획 생성

차단/삭제 API가 `parent`를 요구하므로 게시물별로 묶는다.

```js
const deletePlanByPostNo = new Map();

for (const comment of cluster.comments) {
  const key = String(comment.postNo);
  if (!deletePlanByPostNo.has(key)) {
    deletePlanByPostNo.set(key, []);
  }
  deletePlanByPostNo.get(key).push(comment.no);
}
```

예시:

```text
정규화 댓글 A 10개:
901에 3개
903에 4개
905에 3개
```

차단/삭제 호출:

```text
deleteAndBanComments(config, 901, [댓글 3개])
100ms 대기
deleteAndBanComments(config, 903, [댓글 4개])
100ms 대기
deleteAndBanComments(config, 905, [댓글 3개])
```

`deleteAndBanComments()` 내부에서 댓글 번호 50개 chunk 처리를 하므로, 같은 게시물에 50개가 넘어도 별도 처리할 필요 없다.
호출 config는 `avoid_hour=6`, `avoid_reason=0`, `avoid_reason_txt=도배기IP차단(무고한 경우 문의)`, `del_chk=1`, `avoid_type_chk=1`로 보정한다.

삭제 직전 재확인:

```text
this.isRunning === false -> 남은 삭제 중단
this.isCommentDefenseRunning() === true -> 남은 삭제 중단
```

이유:

- 사용자가 댓글방어를 켠 뒤에도 새 스캐너가 계속 차단/삭제 API를 보내는 중복 상황을 줄인다.
- 정지 버튼을 누른 뒤 남은 차단/삭제 호출이 계속 이어지는 상황을 줄인다.

### 7. 차단/삭제 후 스냅샷 반영

차단/삭제 성공 시:

```text
recentAttackCommentActions에 성공 기록
commentSnapshotByPostNo에서 해당 cmtNo 제거
totalAttackCommentClusterDeleteCount 증가
```

차단/삭제 실패 시:

```text
recent action 성공 기록 안 함
스냅샷도 제거하지 않음
다음 사이클에서 재시도 가능
로그 남김
```

부분 성공/부분 실패 시:

```text
예: 10개 군집 중 901 글 3개 차단/삭제 성공, 902/903 글 7개 차단/삭제 실패
-> 901 성공 댓글은 recent success로 표시
-> 스냅샷은 아직 전체 군집을 유지
-> 901 글 댓글 수가 0으로 보여도 direct recent success가 있으므로 재시도 기준용 스냅샷은 유지
-> 같은 정규화 댓글의 recent success가 남아 있는 동안에는 댓글 수가 10에서 7로 줄어도 새 스냅샷으로 덮어쓰지 않음
-> 다음 사이클에서 군집 총 10개 기준은 유지
-> recent success 3개는 차단/삭제 대상에서 제외
-> 실패했던 7개만 다시 deleteAndBanComments 호출
-> 실패분까지 모두 성공하면 군집 스냅샷 전체 제거
```

이유:

- 성공분을 즉시 스냅샷에서 빼면 남은 실패분이 10개 미만이 되어 재시도에서 빠질 수 있다.
- recent success를 같이 보관하면 성공분은 중복 삭제하지 않으면서 군집 기준만 유지할 수 있다.
- page1 댓글 수가 성공 삭제분만큼 줄어도 recent success가 남아 있고 TTL 전이면 스냅샷을 덮어쓰지 않는다.
  예를 들어 901 댓글 3개는 삭제 성공, 902/903 댓글 7개는 실패한 상태에서 다음 page1에 901 댓글 수가 0으로 보이면, 901 스냅샷을 즉시 지우지 않고 10개 군집 기준을 유지해 902/903의 실패분 7개만 다시 삭제한다.

검증 조회는 하지 않는다.

이유:

- 댓글 삭제 후 검증까지 하면 게시물별로 추가 comment API가 발생한다.
- 이번 기능은 상시 10초 루프에 붙기 때문에, 다음 사이클의 댓글 조회가 자연스러운 검증 역할을 한다.
- 기존 댓글방어의 `executeCommentDeletionBatch()`는 검증까지 포함하지만, 새 기능은 요청량을 줄이기 위해 `deleteAndBanComments()`를 직접 쓰는 게 낫다.

## 실제 예시

### 첫 사이클

```text
page1:
901 댓글 3개
902 댓글 0개
903 댓글 8개
904 댓글 2개
```

조회:

```text
901, 903, 904 댓글 1페이지 조회
```

스냅샷:

```text
901 -> 유동 댓글 3개
903 -> 유동 댓글 8개
904 -> 유동 댓글 2개
```

군집:

```text
"안녕오늘공격" 7개
"다른댓글" 2개
```

결과:

```text
10개 미만이라 삭제 없음
```

### 다음 사이클

```text
page1:
901 댓글 3개 그대로
903 댓글 10개로 증가
904 page1에서 사라짐
905 새 글 댓글 4개
```

스냅샷 정리:

```text
904 제거
```

조회:

```text
903 재조회
905 조회
901 스킵
```

군집:

```text
901 기존 스냅샷에서 "안녕오늘공격" 3개
903 새 스냅샷에서 "안녕오늘공격" 4개
905 새 스냅샷에서 "안녕오늘공격" 3개
총 10개
```

삭제:

```text
deleteAndBanComments(901, [3개])
deleteAndBanComments(903, [4개])
deleteAndBanComments(905, [3개])
```

성공 후:

```text
스냅샷에서 삭제된 댓글 제거
최근 처리 기록 저장
로그: 실제공격 댓글 군집 "안녕오늘공격" 10개 / 3글 -> IP차단+삭제 완료
```

## UI 표시

새 설정 UI는 당장 필수는 아니다. 기본값으로 켜두고, 상태 표시만 추가하는 편이 빠르다.

권장 표시 항목:

```text
최근 댓글 군집: 0개
최근 댓글 차단/삭제: 0개
최근 댓글 군집 문구: -
누적 댓글 군집 차단/삭제: 0개
```

문구 예시:

```text
최근 실제공격 댓글 군집 안녕오늘공격 / 유동댓글 10개 차단/삭제
```

기존 meta text도 갱신한다.

현재 문구:

```text
10초마다 1페이지를 확인해 금칙 제목, 실제공격 제목 유동 3개 이상 군집, ...
```

변경 문구:

```text
10초마다 1페이지를 확인해 금칙 제목, 실제공격 제목/댓글 군집, 글댓총합 20 미만 burst 깡계, 방명록 잠금 저활동 깡계를 함께 처리합니다.
```

## 구현 파일별 작업 목록

### `features/uid-warning-autoban/parser.js`

작업:

- `extractCommentCount(rowHtml)` 추가
- row 객체에 `commentCount` 추가
- export는 필요 없다. 내부 helper로 충분하다.

검증:

```text
댓글 수 있음: <span class="reply_num">[12]</span> -> 12
댓글 수 없음 -> 0
대댓글/아이콘 포함 제목 -> 제목 파싱 기존 동작 유지
```

### `features/uid-warning-autoban/attack-comment-cluster.js`

작업:

- 새 파일 추가
- `normalizeAttackComment()`
- `detectAttackCommentClusters()`
- `buildAttackCommentDeletePlanByPostNo()`

검증:

```text
기호 삽입 댓글들이 같은 normalizedMemo로 묶이는지
영문 filler가 제거되는지
짧은 댓글은 제외되는지
서로 다른 게시물 댓글이 한 군집으로 합산되는지
```

### `features/uid-warning-autoban/scheduler.js`

작업:

- comment API/parser import 추가: `extractEsno`, `fetchRecentComments`, `deleteAndBanComments`, `filterFluidComments`
- constructor 상태 추가
- constructor dependency 추가: `isCommentDefenseRunning`
- `start()`에서 `commentSnapshotByPostNo = {}`로 초기화
- `stop()`에서 `commentSnapshotByPostNo = {}`로 정리
- `runCycle()`에서 제목/실제공격 제목 처리 후 `handleAttackCommentClusterRows(commentRows, html, nowMs)` 호출
- `handleAttackCommentClusterRows()` 추가
- `pruneCommentSnapshotsToPageRows()` 추가
- `selectAttackCommentFetchCandidates()` 추가
- `refreshAttackCommentSnapshots()` 추가
- `deleteAttackCommentCluster()` 추가
- recent action normalize/prune helper 추가
- saveState/loadState/getStatus 연결
- cycle 완료 로그에 댓글 군집 삭제 수 추가

주의:

- 댓글 군집 실패가 전체 `runCycle()` 실패로 번지면 안 된다.
- 댓글방어가 이미 실행 중이면 댓글 군집 스캔은 스킵한다.
- 처리는 `deleteAndBanComments()`만 호출한다.
- 댓글 군집은 항상 `도배기IP차단(무고한 경우 문의)` / 6시간 / 삭제 포함으로 처리한다.
- 삭제 후 별도 검증 조회는 하지 않는다.
- page1에서 사라진 postNo는 반드시 스냅샷에서 제거한다.
- 댓글방어 실행 중이거나 기능이 disabled여도 snapshot prune/reset은 stale 방지를 위해 먼저 처리한다.

### `background/background.js`

작업:

- `new UidWarningAutoBanScheduler({ isCommentDefenseRunning: () => commentScheduler.isRunning })`로 생성자 연결
- `resetSchedulerStats('uidWarningAutoBan')`에서 댓글 군집 통계 초기화
- `resetUidWarningAutoBanSchedulerState()`에서 댓글 군집 상태 초기화

확인 위치:

```text
background/background.js:1687
background/background.js:2731
```

### `popup/popup.html`

작업:

- 분탕자동차단 status grid에 댓글 군집 표시칸 추가
- meta text 갱신

확인 위치:

```text
popup/popup.html:1656
popup/popup.html:1777
```

### `popup/popup.js`

작업:

- `FEATURE_DOM.uidWarningAutoBan`에 새 DOM 연결
- `updateUidWarningAutoBanUI()`에서 값 렌더
- `buildDefaultUidWarningAutoBanStatus()` 기본값 추가
- `buildUidWarningAutoBanMetaText()`에서 최근 댓글 군집 문구 추가

확인 위치:

```text
popup/popup.js:483
popup/popup.js:4171
popup/popup.js:6106
popup/popup.js:6207
```

## 엣지케이스 검증 목록

1. page1에 댓글 있는 글이 0개면 API 호출 없이 종료.
2. page1에서 글이 사라지면 해당 댓글 스냅샷 제거.
3. 댓글 수가 그대로인 글은 30초 TTL 전까지 조회 스킵.
4. 댓글 수가 늘어난 글은 즉시 재조회.
5. 댓글 수가 줄어든 글도 재조회해서 삭제/관리자 조치 반영.
   단, 부분 삭제 성공 직후 recent success가 있는 스냅샷은 TTL 전까지 재조회하지 않아 실패분 재시도 기준을 유지.
6. 새 글은 댓글 수가 1개 이상이면 즉시 조회.
7. `e_s_n_o` 추출 실패 시 댓글 군집 기능만 스킵하고 기존 방어 계속 진행.
8. 개별 댓글 API 실패 시 기존 스냅샷 유지.
9. 신규 글 댓글 API 실패 시 빈 스냅샷으로 오판하지 않음.
10. 고닉 댓글은 `ip === ''`라 제외.
11. 삭제된 댓글은 `del_yn`/`is_delete` 기준으로 제외.
12. 댓글돌이/시스템 댓글은 제외.
13. 정규화 후 빈 문자열은 제외.
14. 정규화 후 6자 미만은 제외.
15. 이모티콘/기호만 다른 같은 댓글은 같은 군집으로 묶임.
16. 한글 사이 영문 filler가 들어간 댓글도 같은 군집으로 묶임.
17. 서로 다른 게시물에 흩어진 같은 댓글 10개는 군집 성립.
18. 같은 게시물 안에만 10개 있어도 군집 성립.
19. 같은 댓글이 9개면 삭제하지 않음.
20. 여러 군집이 동시에 10개 이상이면 큰 군집부터 삭제.
21. 한 댓글이 여러 군집에 중복 포함되지 않음.
22. 군집 삭제가 전체 성공하면 해당 군집 댓글은 스냅샷에서 제거.
23. 삭제 실패 댓글은 스냅샷에 남겨 다음 사이클 재시도 가능.
24. 같은 `(postNo, cmtNo)` 성공 기록은 10분 동안 재시도 제외.
25. 부분 성공 군집은 같은 정규화 댓글의 recent success가 남아 있는 동안 새 스냅샷으로 덮어쓰지 않아 실패분 재시도 기준을 유지.
26. 직접 성공 기록이 있는 글은 댓글 수가 0으로 보여도 실패분 재시도 기준을 잃지 않도록 스냅샷을 임시 유지.
27. 차단/삭제 API는 게시물별로 호출.
28. 같은 게시물 댓글 50개 초과는 `deleteAndBanComments()` 내부 chunk에 맡김.
29. 차단/삭제 호출 사이에 100ms delay 적용.
30. 댓글 조회 동시성은 기본 10을 넘지 않음.
31. 댓글 조회 시작은 100ms 간격으로 stagger.
32. 댓글 군집 기능 오류가 제목 직차단/UID 방어를 중단시키지 않음.
33. 통계 초기화 시 댓글 군집 통계도 초기화.
34. service worker 재시작 후 저장된 스냅샷/최근 처리 기록 복원.
35. 오래된 recent action은 prune되어 저장소가 커지지 않음.
36. popup status에 값이 없어도 기본값으로 안전 표시.
37. 댓글방어가 실행 중이면 댓글 군집 스캔은 스킵되어 중복 API 호출이 생기지 않음.
38. 댓글 조회는 `fetchRecentComments(..., 1)`로 호출되어 `withDcRequestLease()` 흐름을 탐.
39. `fetchComments()`를 직접 호출하지 않아 세션 전환 drain과 충돌 가능성을 줄임.
40. 제목 직차단/실제공격 제목 처리가 댓글 조회보다 먼저 실행되어 긴급 글 삭제가 지연되지 않음.
41. 제목/실제공격 제목으로 처리된 postNo는 댓글 스냅샷에서도 제거됨.
42. stop 후 다시 start하면 이전 댓글 스냅샷이 남지 않음.
41. runCycle이 길어진 경우 다음 poll은 완료 시각 기준으로 잡히지만, 초기 스냅샷 이후 delta/TTL만 조회해 지연이 줄어듦.
42. 댓글 조회/삭제 도중 댓글방어가 ON으로 바뀌면 남은 댓글 군집 작업을 중단함.
43. 댓글 조회/삭제 도중 분탕자동차단이 OFF로 바뀌면 남은 댓글 군집 작업을 중단함.
44. 부분 삭제 성공/부분 실패 시 성공 댓글은 recent success로만 표시하고 스냅샷 군집 기준은 유지해 실패분만 재시도함.
45. 부분 성공 후 page1 댓글 수가 줄어도 TTL 전이면 recent success가 포함된 스냅샷을 유지해 10개 군집 기준이 깨지지 않음.

## 재검증 중 발견해 반영한 이슈

1. 댓글 군집을 제목 직차단보다 먼저 실행하면 긴급 게시물 삭제가 늦어진다.

수정:

```text
제목 직차단
-> 실제공격 제목 클러스터
-> 댓글 군집 스캔
-> UID 기반 분탕차단
```

2. `fetchComments()`를 직접 호출하면 `withDcRequestLease()`를 잡지 않는다.

수정:

```text
fetchComments 직접 호출 금지
fetchRecentComments(config, postNo, esno, 1) 사용
```

3. 기존 댓글방어가 실행 중일 때 새 스캐너까지 돌면 중복 API 호출이 생긴다.

수정:

```text
isCommentDefenseRunning dependency 추가
댓글방어 실행 중이면 댓글 군집 스캔 스킵
```

4. page1 row 파서의 댓글 수 정규식이 너무 딱 맞으면 class 속성 변형에 약하다.

수정:

```js
/<span[^>]*class="[^"]*reply_num[^"]*"[^>]*>\[(\d+)\]<\/span>/i
```

5. 정지 후 재시작 시 이전 스냅샷이 남으면 popup/status에 오래된 값이 보일 수 있다.

수정:

```text
start/stop/reset/gallery 변경 reset에서 commentSnapshotByPostNo 정리
```

6. 현재 run loop는 `runCycle()` 완료 후 다음 poll을 잡으므로 댓글 조회가 길면 page1 재확인이 밀린다.

수정:

```text
긴급 글 제재 먼저 실행
초기 1회만 전체 snapshot 허용
이후 새 글/댓글 수 변경/30초 TTL 대상만 조회
```

## 구현 전 최종 판단

구현 난이도는 중간이다.

쉬운 부분:

- page1 HTML은 이미 10초마다 가져온다.
- 댓글 조회 API가 이미 있다.
- 유동 댓글 필터가 이미 있다.
- 댓글 IP차단+삭제 API가 이미 있다.
- 게시물별 댓글 배치 삭제도 이미 구현되어 있다.

주의할 부분:

- `uid-warning-autoban` parser에 `commentCount`를 추가해야 한다.
- 댓글 조회를 page1 전체에 무작정 매번 호출하면 안 된다.
- 스냅샷에서 page1 이탈 글을 반드시 제거해야 한다.
- 감지는 전체 스냅샷 기준, 처리는 `parent`별 기준이라는 차이를 지켜야 한다.
- 댓글 군집 실패가 기존 분탕자동차단 전체 실패로 번지면 안 된다.

이 설계대로 구현하면 기존 플로우를 크게 바꾸지 않고, `분탕자동차단`의 10초 page1 감시 흐름에 댓글 군집 IP차단+삭제를 안전하게 추가할 수 있다.
