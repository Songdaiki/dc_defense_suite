# 역류댓글 dataset 수집 탭 구현 플랜

## 작성 기준

이 문서는 **2026-04-08 현재 실제 코드 기준**으로 작성했다.

교차 확인한 실제 파일:

- [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js)
- [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js)
- [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js)
- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js)
- [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js)
- [features/reflux-dataset-collector/api.js](/home/eorb915/projects/dc_defense_suite/features/reflux-dataset-collector/api.js)
- [features/reflux-dataset-collector/store.js](/home/eorb915/projects/dc_defense_suite/features/reflux-dataset-collector/store.js)
- [features/reflux-dataset-collector/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/reflux-dataset-collector/scheduler.js)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)
- [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json)
- [comment_reflux_defense_plan.md](/home/eorb915/projects/dc_defense_suite/docs/0408/comment_reflux_defense_plan.md)
- 현재 runtime 댓글 dataset manifest: [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json)

이 문서의 목표는:

- popup 안에 **`역류댓글 수집` 탭**을 추가하고
- 사용자가 입력한 `galleryId`의 게시물 목록을 순차로 훑되
- 각 페이지 안 게시물/댓글 페이지는 병렬로 수집해서
- **댓글 dataset source 파일들**을 manifest + shard 형태로 다운로드하고
- 사용자는 그 source 파일들을 `data/merge-comment-reflux-datasets.mjs` 같은 merge/build 스크립트에 넣어
- 최종 runtime dataset [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json) 으로 빌드한 뒤 커밋/배포만 하게 만드는 것이다.

즉 한 줄로:

- **수집은 UI에서 편하게**
- **실전 런타임 dataset은 merge/build 단계에서 따로 만든다**

이 분리가 중요하다.

쉽게 예시로:

- 반도체산업갤 source 수집: `comment-reflux-source-tsmcsamsungskhynix-2026-04-08-231500.json + partNN`
- 특갤 source 수집: `comment-reflux-source-thesingularity-2026-04-09-010000.json + partNN`
- 나중에 merge/build:
  - 최종 runtime용 [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json)
  - 실제 part 파일들

중요:

이 문서는 **1차 구현을 마이너갤/미니갤 계열 URL 구조 전제**로 잡는다.

이유:

현재 댓글 방어 실제 코드가

- `/mgallery/board/lists/`
- `/mgallery/board/view/`
- `_GALLTYPE_ = 'M'`

전제로 짜여 있기 때문이다.  
[features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L14)

쉽게 예시로:

- `tsmcsamsungskhynix`
- `thesingularity`

같은 현재 운용 대상엔 맞지만,
정규 갤러리까지 범용 수집기로 넓히는 건 1차 범위 밖이다.

---

## 1. 왜 title collector를 그대로 복사하면 안 되는가

현재 title collector는 비교적 단순하다.

1. list HTML 1페이지 fetch
2. 제목 추출
3. 정규화 + dedupe
4. IndexedDB 저장
5. 완료 후 popup에서 JSON 다운로드  
   [features/reflux-dataset-collector/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/reflux-dataset-collector/scheduler.js)

댓글은 구조가 다르다.

1. 목록 페이지에서 **댓글 있는 게시물**을 찾아야 하고
2. 각 게시물 view에서 `e_s_n_o` 토큰을 구해야 하고
3. 댓글 API를 여러 페이지 돌면서 댓글을 모아야 한다  
   [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js)

쉽게 예시로:

- 제목 수집:
  - `page=12` HTML 한 번
  - 제목 50개 추출

- 댓글 수집:
  - `page=12` HTML 한 번
  - 댓글 있는 글 20개 발견
  - 그 20개 글 각각에서
    - view HTML 한 번
    - 댓글 API 여러 번

즉 댓글 수집은 **팬아웃이 훨씬 크다.**

또 하나 더 중요하다.

현재 [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js) 의

- `fetchPostList`
- `fetchPostPage`
- `fetchAllComments`
- `deleteComments`
- `deleteAndBanComments`

는 전부 `withDcRequestLease(...)`와 묶여 있다.  
[features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L7)

이건 댓글 방어/삭제에는 맞지만, **밤새 수집기**에는 맞지 않는다.

쉽게 예시로:

- 댓글 방어는 관리자 세션 보호가 중요해서 lease가 맞음
- 댓글 수집기는 read-only 대량 크롤링이라 lease를 잡고 오래 달리면
  - 댓글 방어
  - 게시물 분류
  - IP 차단
같은 다른 기능과 괜히 엮일 수 있다

즉 한 줄로:

- **댓글 수집기는 기존 comment API fetch/delete 경로를 그대로 재사용하면 안 된다**
- **lease 없는 collector 전용 API 경로가 필요하다**

---

## 2. 현재 실제 코드가 이미 말해주는 제약

### 2-1. runtime 댓글 역류기 방어는 이미 exact-match `Set.has()` 구조다

실제 삭제 판정은

- 댓글 본문 정규화: [normalizeCommentRefluxMemo()](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L96)
- dataset matcher: [hasCommentRefluxMemo()](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L153)

로 돈다.

쉽게 예시로:

- 댓글 `HBM&nbsp;<br>삼성이 한다`
- 정규화 -> `hbm 삼성이 한다`
- dataset `Set` 안에 있으면 삭제

즉 collector도 **반드시 같은 정규화 함수**를 써야 한다.

이걸 어기면:

- collector는 `HBM은 삼성이 한다`
- runtime은 `hbm은 삼성이 한다`

처럼 서로 다른 기준으로 저장/비교해서 오동작한다.

### 2-2. runtime 댓글 dataset은 이미 manifest + shard 구조를 전제로 해도 된다

현재 [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json) 은

- `memoCount`
- `shards`

를 들고 있고,
로더도 shard 구조를 읽는다.  
[features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L44)  
[features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L262)

즉 collector가 나중에 최종 runtime dataset을 만들 때도 **shard 구조**로 가는 것이 이미 자연스럽다.

### 2-3. title collector의 single-file popup 다운로드 방식은 댓글에 그대로 쓰면 위험하다

현재 title collector popup은

- background에서 작은 descriptor만 받고
- popup이 IndexedDB에서 `getAll(runId)`로 제목을 다 읽은 뒤
- 한 번에 JSON.stringify 해서 Blob 다운로드한다.  
[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L986)  
[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3312)

제목은 이게 버틸 수 있지만, 댓글은 훨씬 크다.

쉽게 예시로:

- 제목 2만개는 single-file도 버틸 수 있음
- 댓글 200만개, 500만개는 popup 한 번에 `getAll + stringify` 하면 다시 터질 수 있음

즉 댓글 collector는 **처음부터 cursor 기반 streaming export + shard 다운로드**로 가야 한다.

---

## 3. 최종 방향

### 결론

댓글 collector는 **새 standalone feature**로 가야 한다.

권장 feature key:

- `commentRefluxCollector`

권장 새 파일:

- `features/comment-reflux-collector/api.js`
- `features/comment-reflux-collector/parser.js`
- `features/comment-reflux-collector/store.js`
- `features/comment-reflux-collector/scheduler.js`

그리고 연결 수정 파일:

- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)
- [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json)

후속 merge/build 도구:

- `data/merge-comment-reflux-datasets.mjs`

쉽게 예시로:

- `역류기글 수집` = 제목용 standalone feature
- `역류댓글 수집` = 댓글용 standalone feature

둘 다 구조는 비슷하지만,
댓글 쪽은 **request graph가 더 크고 export가 훨씬 무거워서** 구현 세부는 달라져야 한다.

---

## 4. UI에서 필요한 입력값

탭 이름:

- `역류댓글 수집`

권장 입력값:

1. `갤 ID`
2. `시작 페이지`
3. `끝 페이지`
4. `요청 간격 (ms)`
5. `사이클 간격 (ms)`
6. `동시 처리 수`

이건 사용자가 준 [image.png](/home/eorb915/projects/dc_defense_suite/docs/0408/image.png) 설정 감각과 맞춘 구성이다.

쉽게 예시로:

- 갤 ID: `tsmcsamsungskhynix`
- 시작 페이지: `1`
- 끝 페이지: `500`
- 요청 간격: `100`
- 사이클 간격: `5000`
- 동시 처리 수: `8`

의미는 이렇게 본다.

- 목록 페이지는 `1 -> 2 -> 3` 순차
- 각 페이지 안 게시물은 최대 8개씩 병렬
- 각 worker는 게시물 하나 끝낼 때마다 100ms 쉼
- 페이지 하나 끝나면 5000ms 쉬고 다음 목록 페이지로 감

### 왜 이 값 구성이 맞는가

현재 댓글 방어 scheduler도

- 게시물 worker별 `requestDelay`
- 사이클 간 `cycleDelay`
- 게시물 병렬 수 `postConcurrency`
- 댓글 페이지 병렬 수 `commentPageConcurrency`

를 따로 가진다.  
[features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L48)

collector는 UI를 너무 복잡하게 만들지 않기 위해,

- user-facing concurrency는 하나만 두고
- 댓글 페이지 병렬 수는 내부 고정값으로 두는 게 안전하다.

권장 내부값:

- `commentPageConcurrency = 4`

이 값은 현재 댓글 방어 기본값과도 맞다.  
[features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L56)

즉 한 줄로:

- **UI엔 동시 처리 수 1개만**
- **댓글 페이지 병렬은 내부 고정 4**

가 1차 구현으로 제일 안전하다.

---

## 5. collector API는 어떻게 나누는가

### 핵심 원칙

- `fetchPostList`, `fetchPostPage`, `fetchAllComments`는 재사용하지 않는다
- 이유: lease가 묶여 있기 때문

대신 전용 collector API에서

1. 목록 HTML GET
2. 게시물 view HTML GET
3. 댓글 페이지 POST

를 lease 없이 구현한다.

권장 파일:

- `features/comment-reflux-collector/api.js`

### 여기서 재사용 가능한 것

현재 댓글 API에서 **pure helper**로 재사용 가능한 건 있다.

- `extractEsno(html)`  
  [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L160)
- `fetchComments(config, postNo, esno, commentPage)`  
  [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L196)

중요:

- `fetchComments` 자체는 lease를 안 잡는다
- lease는 `fetchAllComments` 바깥 래퍼 쪽에만 있다  
  [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L231)

즉 collector는

- `extractEsno`는 그대로 재사용 가능
- `fetchComments`도 재사용 가능
- 하지만 `fetchPostList`, `fetchPostPage`, `fetchAllComments`는 collector 전용으로 다시 두는 게 맞다

쉽게 예시로:

- 목록 GET / view GET은 새 collector API
- 댓글 POST body shape는 기존 `fetchComments`를 써도 됨

주의:

이 reuse도 현재는 `galleryType='M'` 전제에서만 안전하다.

즉 1차 collector는

- `mgallery`
- `galleryType = 'M'`

고정 기준으로 문서화하는 것이 맞다.

### 권장 함수 목록

`features/comment-reflux-collector/api.js`

- `DEFAULT_CONFIG`
- `normalizeConfig(config)`
- `normalizeGalleryId(value)`
- `isValidGalleryId(value)`
- `buildListUrl(galleryId, page)`
- `buildViewUrl(galleryId, postNo)`
- `fetchCollectorPostListHtml(galleryId, page, options)`
- `fetchCollectorPostViewHtml(galleryId, postNo, options)`
- `fetchCollectorCommentsPage(config, postNo, esno, page)`
- `fetchAllCollectorComments(config, postNo, esno, pageConcurrency = 4)`
- `delay(ms)`

### 요청 모델

#### 목록 페이지

- `GET https://gall.dcinside.com/mgallery/board/lists/?id=<galleryId>&page=<page>`
- `credentials: include`
- `Accept: text/html...`

#### 게시물 view

- `GET https://gall.dcinside.com/mgallery/board/view/?id=<galleryId>&no=<postNo>`
- 여기서 `e_s_n_o` 추출

#### 댓글

- 기존 comment API와 같은 `/board/comment/` POST body 재사용  
  [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L204)

즉 collector는 **삭제/차단 없이 read-only 요청만** 한다.

### 재시도 정책

권장:

- 429: backoff 후 재시도
- 403: 30초 대기 후 재시도
- 네트워크 에러: 1초, 2초, 3초 순 재시도

이 기준은 현재 comment API `dcFetchWithRetry()`와 동일 계열로 맞추는 게 자연스럽다.  
[features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L45)

---

## 6. 목록 parser와 댓글 parser는 어떻게 두는가

권장 파일:

- `features/comment-reflux-collector/parser.js`

### 6-1. 목록 parser

현재 [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L88) 안의 list row 파싱은 fetch 함수 안에 내장돼 있다.

이걸 바로 공용화하려고 live comment API를 크게 건드리는 것보단,
collector parser에 **같은 row 추출 로직을 얇게 복사**하는 게 1차로 더 안전하다.

권장 함수:

- `parseCollectorPostEntries(html)`

반환 형태:

```js
[
  { no: 12345, commentCount: 17 },
  { no: 12344, commentCount: 0 },
]
```

그리고 scheduler에서는

- `commentCount > 0`

인 글만 대상으로 잡으면 된다.

쉽게 예시로:

- page1 목록 50개
- 댓글 있는 글 14개
- collector는 14개만 실제 댓글 API를 탄다

### 6-2. 댓글 memo parser

댓글 dataset용으로는 기존 댓글 파서의 helper를 최대한 재사용해야 한다.

이미 있는 것:

- 삭제/system/comment-boy 제외 판단: [shouldSkip()](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L44)
- 댓글 본문 정규화: [normalizeCommentRefluxMemo()](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L96)

collector parser 권장 함수:

- `collectNormalizedCommentRefluxMemos(comments)`

동작:

1. `shouldSkip(comment)`면 제외
2. `comment.memo`를 `normalizeCommentRefluxMemo()`로 정규화
3. 빈 문자열이면 제외
4. 나머지 memo를 배열로 반환

중요:

여기서는 **유동 댓글만 따로 거르지 않는다.**

이유:

- runtime 삭제는 대상 갤에서 **유동 댓글**만 지운다
- 하지만 source dataset은 공격자가 복붙해 오는 원문 집합이라
- source 갤에서 고정닉이 쓴 댓글이라도 재사용될 수 있다

쉽게 예시로:

- 반도체갤 고정닉 댓글 `hbm은 삼성이 한다`
- 특갤 유동 공격자가 그대로 복붙
- source dataset에 들어 있어야 런타임 exact-match가 된다

즉 collector는

- **source 쪽에서는 고정닉/유동닉을 따지지 않고**
- **삭제/시스템/광고 댓글만 제외**

가 맞다.

---

## 7. 저장은 어떻게 하는가

### 결론

- 큰 memo 데이터: `IndexedDB`
- 작은 상태: `chrome.storage.local`

권장 파일:

- `features/comment-reflux-collector/store.js`

권장 DB 설계:

- DB 이름: `commentRefluxCollectorDb`
- store 이름: `memos`
- keyPath: `key`
- index: `runId`

entry 예시:

```js
{
  key: "run-20260408153000::hbm은 삼성이 한다",
  runId: "run-20260408153000",
  memo: "hbm은 삼성이 한다"
}
```

이 구조 장점:

- runId별 격리 가능
- 같은 run 안 중복 memo는 key 충돌로 자연 dedupe
- popup 다운로드도 runId 기준으로 읽으면 됨

### 권장 store 함수

- `clearAllCollectorMemos()`
- `appendCollectorMemos(runId, memos)`
- `iterateCollectorMemosByRun(runId, visitor)`
- `countCollectorMemosByRun(runId)`

중요:

- **`getAll(runId)`는 피하는 것이 좋다**
- 댓글은 title보다 훨씬 커서, popup에서 한 번에 전부 읽는 구조는 다시 무거워질 수 있다

즉 popup export는

- `IDB cursor`
- 또는 `iterateCollectorMemosByRun`

로 **streaming** 해야 한다.

---

## 8. scheduler는 어떤 상태를 가져야 하는가

권장 파일:

- `features/comment-reflux-collector/scheduler.js`

phase는 title collector와 같은 계열이 맞다.

권장:

- `IDLE`
- `RUNNING`
- `WAITING`
- `COMPLETED`
- `INTERRUPTED`

### config

권장 기본값:

```js
{
  galleryId: '',
  startPage: 1,
  endPage: 100,
  requestDelayMs: 100,
  cycleDelayMs: 5000,
  postConcurrency: 8,
  commentPageConcurrency: 4, // 내부 고정 또는 숨은 설정
}
```

### runtime state

권장 필드:

- `isRunning`
- `phase`
- `runId`
- `currentPage`
- `currentPostNo`
- `fetchedPageCount`
- `processedPostCount`
- `failedPostCount`
- `rawCommentCount`
- `normalizedMemoCount`
- `startedAt`
- `finishedAt`
- `lastError`
- `downloadReady`
- `exportVersion`
- `interrupted`
- `collectedGalleryId`
- `logs`

예시:

- `currentPage = 127`
- `currentPostNo = 934521`
- `processedPostCount = 2817`
- `rawCommentCount = 412340`
- `normalizedMemoCount = 183922`

### run loop

권장 흐름:

1. 시작 block reason 확인
2. 이전 run 데이터 clear
3. `runId` 생성
4. `page = startPage ~ endPage` 순차 반복
5. 각 page마다:
   - 목록 HTML fetch
   - `parseCollectorPostEntries(html)`
   - `commentCount > 0`인 post만 추림
   - concurrency worker로 post 처리
6. page 하나 끝날 때
   - `phase = WAITING`
   - `cycleDelayMs` 대기
7. 전부 끝나면
   - `downloadReady = normalizedMemoCount > 0`
   - `exportVersion` 생성
   - `phase = COMPLETED`

### post 처리

한 post에 대한 권장 흐름:

1. `fetchCollectorPostViewHtml(galleryId, postNo)`
2. `extractEsno(html)`
3. `fetchAllCollectorComments(config, postNo, esno, 4)`
4. `collectNormalizedCommentRefluxMemos(comments)`
5. IDB append
6. counters/log 갱신
7. worker당 `requestDelayMs` 대기

쉽게 예시로:

- page1에서 댓글 있는 글 20개
- postConcurrency 8이면
  - 8개 병렬
  - 끝나는 worker가 다음 글 하나 가져감
- 각 글 안에서 댓글 6페이지면
  - page1 받고
  - 2~6페이지는 내부 병렬 4

즉 전체 모델은:

- **목록 페이지는 순차**
- **한 페이지 안 글은 병렬**
- **한 글 안 댓글페이지도 병렬**

---

## 9. popup / background wiring은 어떻게 가는가

### feature key

- `commentRefluxCollector`

### background

기존 title collector pattern을 그대로 따라가면 된다.  
[background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L25)  
[background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L575)  
[background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L677)

수정 위치:

1. import
2. scheduler 인스턴스 생성
3. `schedulers` 등록
4. `resumeAllSchedulers()`에 load 추가
5. `getAllStatuses()`에 status 추가
6. `updateConfig`에서 config normalize/검증 추가
7. `resetStats` 처리 추가
8. `downloadExportJson` 액션 분기 추가
9. `getConfigUpdateBlockMessage()`에 실행 중 저장 차단 추가
10. `resetSharedConfig()` / `applySharedConfig()` / `syncSharedConfigInputs()` 대상에는 **절대 넣지 않기**
11. `loadSchedulerStateIfIdle()` 대상에는 넣되 `resumeStandaloneScheduler()` 대상에는 넣지 않기

중요:

- `commentRefluxCollector`는 **공통 갤러리(shared gallery)** 와 분리해야 한다
- `getBusyFeatures()`에도 넣지 않는 것이 맞다

쉽게 예시로:

- 공통 갤러리 `thesingularity`
- collector 입력 `galleryId=tsmcsamsungskhynix`
- 이때 collector는 반도체갤을 그대로 수집해야 한다

실제 title collector도 이 패턴을 따른다.

- state는 background 초기화 시 읽는다  
  [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L194)
- 하지만 standalone auto-resume은 하지 않는다  
  [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L240)

즉 comment collector도 같은 정책이 맞다.

- **state는 복원**
- **자동 재시작은 안 함**

### popup

기존 title collector wiring을 그대로 따라간다.  
[popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L711)  
[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L900)

수정 위치:

1. 새 탭 버튼 추가
2. 새 panel 추가
3. `DIRTY_FEATURES.commentRefluxCollector`
4. `FEATURE_DOM.commentRefluxCollector`
5. `bindCommentRefluxCollectorEvents()`
6. `updateCommentRefluxCollectorUI()`
7. `applyStatuses()`에 status 렌더 연결
8. `bindConfigDirtyTracking('commentRefluxCollector')`
9. `syncSharedConfigInputs()` 대상에는 넣지 않기

권장 표시 항목:

- 실행
- 상태
- 수집 갤 ID
- 현재 페이지/현재 게시물
- 처리 글 수
- 원본 댓글 수
- 정규화 고유 댓글 수
- 시작 시각
- 종료 시각
- export version
- 최근 오류
- 최근 로그

주의:

현재 popup의 공용 갤러리 동기화는 일반 방어 기능들의 `galleryId`만 보고 상단 입력값을 갱신한다.  
[popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2917)

여기에 collector 입력칸까지 묶으면

- 운영용 공통 갤러리 값
- 수집용 collector `galleryId`

가 서로 덮어쓸 수 있다.

즉 comment collector도 title collector와 똑같이
**popup shared sync 대상이 아니어야 한다.**

---

## 10. 다운로드는 어떻게 해야 하는가

### 결론

댓글 collector는 **single-file JSON 다운로드로 시작하면 안 된다.**

대신:

- popup이 run descriptor만 받고
- IDB cursor로 memo를 순차 읽어서
- **gallery-scoped source manifest + shard 파일 여러 개**를 다운로드해야 한다

### 왜 이렇게 해야 하는가

title collector는 한 번에 제목을 다 읽어서 single JSON으로 다운받는다.

그 구조가 커졌을 때 이미 popup 쪽에서 부담이 생겼다.

댓글은 제목보다 훨씬 클 가능성이 높으니,
처음부터 아래 구조로 가는 것이 맞다.

1. IDB cursor로 memo streaming
2. `maxShardBytes` 기준으로 현재 shard 메모 배열 쌓기
3. shard 하나 완성되면 바로 JSON 파일 다운로드
4. 다음 shard로 넘어감
5. 마지막에 manifest 다운로드

### 권장 출력 형식

manifest 파일:

```json
{
  "_comment": "이 파일은 gallery source export manifest다. 최종 runtime dataset이 아니라 merge/build 입력이다.",
  "_comment_update_rule": "source export를 다시 수집했다면 version을 새로 찍는다.",
  "version": "2026-04-08-231500",
  "updatedAt": "2026-04-08T23:15:00.000Z",
  "sourceGalleryIds": ["tsmcsamsungskhynix"],
  "memoCount": 183922,
  "shards": [
    {
      "path": "comment-reflux-source-tsmcsamsungskhynix-2026-04-08-231500.part01.json",
      "memoCount": 50000
    }
  ]
}
```

part 파일:

```json
{
  "memos": [
    "hbm은 삼성이 한다",
    "트럼프가 반도체 산업 다 망침"
  ]
}
```

### 파일명 규칙

권장:

- manifest:
  - `comment-reflux-source-<galleryId>-<version>.json`
- shard:
  - `comment-reflux-source-<galleryId>-<version>.part01.json`
  - `comment-reflux-source-<galleryId>-<version>.part02.json`

이 naming이 중요한 이유:

- raw source export와
- 최종 runtime dataset [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json)

을 헷갈리지 않게 하기 위해서다.

### popup 다운로드 구현 방식

권장:

- `"downloads"` permission 추가  
  [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json)
- popup에서 `Blob -> objectURL`
- `chrome.downloads.download()`로 각 part/manifest 저장

이유:

- 댓글 collector는 **여러 파일 다운로드**가 기본이다
- anchor click 연속 호출보다 downloads API가 더 안정적이다

주의:

- background service worker에서는 `URL.createObjectURL()`이 없다
- 따라서 **export blob 생성은 popup 쪽**이 맞다

쉽게 예시로:

- background는 `runId`, `version`, `galleryId`, `memoCount`만 반환
- popup은 그 descriptor로 IDB를 읽고 shard를 만들어서 바로 다운로드

### title collector와 달라지는 점

title collector:

- `getAll(runId)` + `JSON.stringify` + 1파일 다운로드

comment collector:

- `cursor(iterate)` + shard마다 다운로드 + 마지막 manifest 다운로드

즉 댓글 collector는 **popup export 경로도 새로 구현**해야 한다.

---

## 11. merge/build는 어떻게 이어지는가

collector의 출력은 **최종 runtime dataset이 아니라 source export**다.

즉 후속으로 아래 스크립트가 필요하다.

- `data/merge-comment-reflux-datasets.mjs`

역할:

1. source manifest 여러 개 읽기
2. 각 source shard의 memos 읽기
3. `normalizeCommentRefluxMemo()` 재적용으로 안전하게 dedupe
4. 필요하면 후처리 필터 적용
5. 최종 runtime dataset
   - [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json)
   - `.partNN.json`
   로 출력

쉽게 예시로:

- source 1:
  - `comment-reflux-source-tsmcsamsungskhynix-...`
- source 2:
  - `comment-reflux-source-thesingularity-...`
- merge/build 결과:
  - [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json)
  - `comment-reflux-set-unified.part01.json`
  - `comment-reflux-set-unified.part02.json`

즉 collector 탭은 **수집기**, merge script는 **배포기**라고 보면 된다.

---

## 12. 자동/수동 댓글 방어와 collector의 연결 관계

collector는 방어 기능과 직접 섞이면 안 된다.

즉:

- collector가 dataset을 local test용으로 잠깐 넣어주는 기능은 있어도 되고
- 없어도 된다

하지만 1차 구현에선 **local import/즉시 적용 기능은 빼는 게 안전하다.**

이유:

- collector source export와
- runtime unified dataset은 역할이 다르다
- 여기서 둘을 섞으면 다시 dataset 경로가 헷갈린다

쉽게 예시로:

- collector로 반도체 source 수집 완료
- 그 결과를 바로 runtime dataset처럼 쓰게 하면
  - 제목 collector 때와 비슷한 “어느 파일이 진짜냐” 문제가 다시 생긴다

따라서 1차 정책은:

- collector는 source export만 다운로드
- runtime 댓글 방어는 여전히 [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json) 만 읽음

이게 맞다.

---

## 13. restart / reset / shared config / busy feature 정책

### restart

title collector와 동일하게,

- 완료된 run은 유지
- 실행 중이던 run은 loadState 시 `INTERRUPTED`
- 자동 resume 없음

이게 맞다.  
[features/reflux-dataset-collector/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/reflux-dataset-collector/scheduler.js#L240)

쉽게 예시로:

- 밤새 수집 중 브라우저 종료
- 다음 실행 시 자동으로 이어서 돌지 않음
- `중단됨` 상태로 보여주고 재시작은 사용자가 결정

### 새 run 시작 시 기존 collector 데이터

title collector와 같은 정책으로 가는 것이 맞다.

- 새 run 시작 시 collector IDB를 clear
- collector는 현재 run을 내려받기 전까지 임시 보관하는 작업장으로 본다

쉽게 예시로:

- 반도체 source 수집 완료 후 다운로드
- 다음에 특갤 source 수집 시작
- 이때 collector 내부 IDB는 새 run 기준으로 갈아엎는다

즉 여러 run을 collector 내부에 계속 쌓아두는 구조는 1차 구현에서 불필요하다.

### reset

- 실행 중에는 `resetStats` 거부
- 정지 상태에서만
  - logs
  - counters
  - downloadReady
  - exportVersion
  - runId
  - IDB run data
를 지운다

### shared config

- collector는 shared gallery 대상 아님
- 공통 갤러리 변경에 따라 collector `galleryId`를 덮으면 안 됨

### busy feature

- collector는 read-only 수집이므로 `getBusyFeatures()`에 넣지 않는다
- 댓글 방어/게시글 분류를 억지로 막지 않는다

다만 네트워크 부하는 collector 설정으로 조절한다.

---

## 14. 구현 중 반드시 주의할 문제

### 14-1. `fetchComments`는 재사용해도 되지만 `fetchAllComments`는 재사용하면 안 됨

이건 실제 코드에서 헷갈리기 쉽다.

- `fetchComments`는 lease 없음
- `fetchAllComments`는 lease 있음

즉 collector는

- `fetchComments` 재사용 가능
- `fetchAllComments` 재사용 금지

### 14-2. `getAll(runId)` 기반 다운로드 금지

댓글은 너무 커질 수 있다.

예시:

- 반도체 댓글 50만개
- 특갤 댓글 200만개

이걸 popup에서 `getAll` 한 번에 읽으면 다시 무거워진다.

반드시 cursor/iterator 방식으로 가야 한다.

### 14-3. collector는 busy feature에 넣지 않는 것이 맞다

현재 background `getBusyFeatures()`는

- 댓글 방어
- 댓글 감시 자동화
- 게시글 분류
- IP 차단

같은 실운영 기능만 묶고,
title collector는 넣지 않는다.  
[background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1050)

comment collector도 같은 정책이 맞다.

이유:

- collector는 read-only 장기 수집 작업이고
- 다른 방어 기능을 막는 쪽이 더 운영상 불편하다

쉽게 예시로:

- 밤새 역류댓글 수집 중이어도
- 파딱은 댓글 방어/게시글 분류를 계속 써야 한다

### 14-4. source export와 runtime unified dataset 이름을 혼동하면 안 됨

권장 naming:

- source export:
  - `comment-reflux-source-<galleryId>-<version>.json`
- runtime unified:
  - [comment-reflux-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/comment-reflux-set-unified.json)

### 14-5. collector는 댓글 방어 dataset 로더를 직접 덮어쓰면 안 됨

현재 runtime 댓글 dataset 로더는 [comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js) 하나만 본다.

collector는 source export tool이지,
runtime dataset 교체기가 아니다.

즉 1차 구현에서

- `replaceCommentRefluxDataset(...)` 자동 호출

같은 건 넣지 않는 것이 맞다.

### 14-6. 댓글은 제목보다 흔한 짧은 문장이 훨씬 많다

이건 collector 설계에서 꼭 의식해야 한다.

쉽게 예시로:

- 제목 dataset에 `삼성 파운드리 적자`가 들어가는 건 비교적 안전하다
- 댓글 dataset에 `ㅇㅇ`, `ㄹㅇ`, `개추`, `맞음` 같은 게 들어가면
  - 나중에 runtime exact-match에서 너무 많은 일반 댓글을 잡을 수 있다

그래서 collector는 **source export**만 만들고,
최종 runtime unified dataset을 만들 때는 merge/build 단계에서

- 최소 길이 필터
- 너무 흔한 short memo blacklist
- 필요시 gallery별 제외 규칙

을 적용할 수 있게 해두는 편이 맞다.

즉 1차 collector 정책은:

- 삭제/system/comment-boy/빈 memo만 제외
- source export는 가능한 한 원문을 많이 보존

그리고 2차 merge/build 정책은:

- 실제 방어에 쓰기 전에 위험한 generic memo를 추려냄

이렇게 역할을 분리하는 게 안전하다.

---

## 15. 구현 순서

### 1단계

새 collector feature 뼈대

- `features/comment-reflux-collector/api.js`
- `features/comment-reflux-collector/parser.js`
- `features/comment-reflux-collector/store.js`
- `features/comment-reflux-collector/scheduler.js`

### 2단계

background wiring

- scheduler 등록
- loadState / getStatus / updateConfig / resetStats / downloadExportJson

### 3단계

popup 탭/UI

- 탭 버튼
- panel
- 설정 입력
- 시작/중지
- 로그
- 다운로드

### 4단계

popup export streaming

- IDB cursor
- shard 생성
- multi-download

### 5단계

후속 merge/build script

- `data/merge-comment-reflux-datasets.mjs`

즉 1차 완성 기준은:

- **수집 탭이 실제 댓글을 모아서 source manifest + shard를 내려받는다**

까지다.

---

## 16. 구현 후 체크리스트

1. `galleryId`가 shared gallery에 안 묶이는지
2. running 중 config 저장이 막히는지
3. running 중 reset이 막히는지
4. page 순차 / post 병렬 / comment page 병렬 구조가 맞는지
5. `extractEsno` 실패한 post가 전체 run을 죽이지 않고 skip되는지
6. deleted/system/comment-boy 댓글이 dataset에 안 들어가는지
7. `normalizeCommentRefluxMemo()`와 collector 저장 기준이 같은지
8. runId별 IDB 분리가 되는지
9. completed run은 재시작 후도 다운로드 가능한지
10. interrupted run은 auto resume 안 하는지
11. popup이 `getAll` 대신 cursor 기반 streaming으로 export하는지
12. source export와 runtime unified dataset 이름이 혼동되지 않는지
13. `"downloads"` permission 추가 후 multi-download가 정상 동작하는지
14. merge/build script가 source manifest를 문제없이 읽을 수 있는지

---

## 최종 결론

지금 실제 코드 기준으로 보면,
댓글 collector는 **그냥 title collector를 복사하는 방식**이 아니라

- **lease 없는 collector 전용 API**
- **목록 순차 + 글 병렬 + 댓글페이지 병렬**
- **IndexedDB runId 저장**
- **popup cursor streaming export**
- **source manifest + shard 다운로드**
- **후속 merge/build script**

로 가는 것이 맞다.

쉽게 예시로:

- `반도체산업갤 1~1000페이지`
- 목록은 하나씩
- 각 페이지 글은 8개씩 병렬
- 글마다 댓글은 내부 4개 페이지씩 병렬
- memo 정규화 후 dedupe
- 완료 후 `comment-reflux-source-tsmcsamsungskhynix-...json + partNN` 다운로드
- 나중에 다른 갤 source와 합쳐 최종 runtime dataset 빌드

즉 한 줄로:

- **댓글 collector는 standalone source-export 도구로 구현하는 게 맞고**
- **이 문서 기준이면 바로 구현 착수 가능한 수준으로 정리된 상태**다.
