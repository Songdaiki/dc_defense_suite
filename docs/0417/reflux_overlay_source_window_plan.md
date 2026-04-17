# 역류기 Source Window Overlay 수집/적용 문서

> 작성일: 2026-04-17  
> 기준 코드: `working tree` (`HEAD 80bb436` + 로컬 `page-locator.js` 존재)  
> 목표 범위: `view URL -> page locate -> 주변 페이지 수집 -> 로컬 overlay 저장 -> 게시물/댓글 공용 matcher 반영`  
> 제외 범위: source gallery 자동 추정, LLM 기반 판정, 배포 bundled dataset 재생성, getSearch/proxy-search duplicate 규칙 변경

## 0. 한 줄 결론

질문한 방향은 맞다.

- **`view URL` 하나로 원본 페이지를 찾은 뒤**
- **그 페이지 주변 `±N페이지`를 빠르게 수집해서**
- **관리자 로컬 overlay dataset으로 저장하고**
- **기존 post/comment 역류 matcher가 `base dataset + overlay`를 같이 보게**
- 만들면 된다.

다만 중요한 전제가 하나 있다.

- **overlay 저장/적용 로직은 지금 repo만으로 바로 구현 가능하다.**
- **10프록시 병렬 수집은 “extension 단독”으로는 아직 안 된다.**
- 이유는 현재 repo 안 프록시 코드는 `Node test script`에만 있고,
  extension background는 `node:http` 방식 Webshare HTTP proxy를 직접 못 쓰기 때문이다.

쉽게 말하면:

- `overlay feature` 자체는 바로 패치 가능
- `10프록시 병렬 transport`는 **브리지/어댑터 전제**
- 따라서 문서 기준 구현은 아래처럼 나누는 게 맞다

1. **1차 필수**: direct fetch 기반 overlay 수집/적용 구조 완성
2. **2차 선택**: proxy bridge transport를 꽂아 10개 병렬로 가속

이 문서는 그 둘을 분리해서, **지금 바로 패치 가능한 구조**와
**프록시가 붙을 때 어디를 바꾸면 되는지**까지 확정한다.

---

## 1. 실제 코드 교차검증 결과

이 문서는 아래 실제 파일을 다시 읽고 교차검증한 뒤 작성했다.

- 페이지 탐색:
  - [features/reflux-dataset-collector/page-locator.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/page-locator.js)
- 기존 역류기글 수집기:
  - [features/reflux-dataset-collector/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/api.js)
  - [features/reflux-dataset-collector/parser.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/parser.js)
  - [features/reflux-dataset-collector/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/scheduler.js)
  - [features/reflux-dataset-collector/store.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/store.js)
- 공용 title-set / matcher:
  - [features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js)
  - [features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js)
- 게시물/댓글 호출부:
  - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js)
  - [features/monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js)
  - [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js)
  - [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js)
  - [features/reflux-four-step-filter.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-four-step-filter.js)
- background / popup 연결:
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js)
  - [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html)
  - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js)
- 프록시 테스트/제약:
  - [scripts/test-proxy-search-duplicate.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/scripts/test-proxy-search-duplicate.mjs)
  - [docs/0417/proxy_search_duplicate_defense_status.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0417/proxy_search_duplicate_defense_status.md)

### 1.1 `view URL -> page` 찾는 모듈은 이미 있다

[features/reflux-dataset-collector/page-locator.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/page-locator.js:58) 기준:

- `parseBoardViewUrl(viewUrl)`가 `id`, `no`를 뽑고
- [page-locator.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/page-locator.js:185)의 `parseListPageInfo()`가
  - 공지 제외
  - 일반글 번호 범위(`newestNo`, `oldestNo`)
  - exact row
  - totalPageCount
  를 파싱한다.

[page-locator.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/page-locator.js:305) 기준:

- `locateBoardListPageByPostNo()`
  - page 1 bootstrap
  - binary search
  - candidate page
  - neighbor scan
  구조로 끝난다.

즉 **원본 페이지 찾기 자체는 이미 구현 완료 상태**다.

다만 여기서 문서상 고정해야 할 제한이 하나 있다.

- 현재 `parseBoardViewUrl()`는 사실상 `id/no`만 검사한다
- 즉 `regular gallery`, `mini gallery`, 심지어 다른 URL에 `id/no`만 붙어 있어도 통과할 수 있다
- 반면 실제 목록 fetch는 [page-locator.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/page-locator.js:89)의 `buildListUrl()` 기준 `mgallery/board/lists`로 고정돼 있다

따라서 1차 구현 문서에서는 scope를 아래로 명시적으로 제한한다.

- 입력 `viewUrl`은 `https://gall.dcinside.com/mgallery/board/view/?id=...&no=...`
- 즉 **마이너 갤 view URL만 지원**

이 검증을 안 넣으면:

- regular gallery view URL을 넣어도 시작은 되는데
- 내부는 mgallery 목록을 찾으려 해서
- 운영자가 이해하기 어려운 locate 실패가 난다

### 1.2 현재 역류기글 수집기는 완전 순차형이다

[features/reflux-dataset-collector/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/scheduler.js:126) 기준:

- `for (page = startPage; page <= endPage; page++)`
- 매 페이지마다
  - [api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/api.js:53)의 `fetchBoardListHtml()`
  - [parser.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/parser.js:3)의 `parseRefluxCollectorTitles()`
  - 제목 정규화 + dedupe
  - IndexedDB append
  - delay
  를 순차로 탄다.

즉 지금 collector는:

- **page range 수집**
- **배포용 JSON export**
- **순차 처리**

에 최적화돼 있고,

- `view URL anchor`
- `±N페이지 one-shot`
- `overlay live apply`
- `proxy worker 병렬`

용 구조는 아니다.

### 1.3 프록시 코드는 지금 Node 테스트 스크립트에만 있다

[scripts/test-proxy-search-duplicate.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/scripts/test-proxy-search-duplicate.mjs:226) 기준:

- `httpGetViaProxy()`는 `node:http`로 HTTP proxy 요청을 보낸다.
- [scripts/test-proxy-search-duplicate.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/scripts/test-proxy-search-duplicate.mjs:266)에서 Webshare API로 프록시 목록을 받는다.
- [scripts/test-proxy-search-duplicate.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/scripts/test-proxy-search-duplicate.mjs:294)에서 라운드로빈으로 프록시를 고른다.

즉 **프록시 로직의 알고리즘/파라미터 예시는 이미 있다.**

하지만 이건 **Node 스크립트**다.

### 1.4 extension background는 Webshare HTTP proxy를 직접 못 쓴다

[docs/0417/proxy_search_duplicate_defense_status.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0417/proxy_search_duplicate_defense_status.md:359) 기준:

- `fetch()`로는 HTTP proxy를 직접 못 쓴다
- browser fetch는 시스템 프록시 또는 `chrome.proxy` API를 탄다
- 즉 현재 extension background에서 `node:http` 스타일 Webshare 요청을 그대로 옮길 수 없다

그리고 실제 repo 검색 기준으로:

- `chrome.proxy`
- `proxy.settings`
- `nativeMessaging`
- `localhost proxy bridge`

는 지금 구현돼 있지 않다.

즉 **“프록시 IP 10개 병렬”이라는 아이디어 자체는 맞지만, 현재 repo 단독으로는 transport가 비어 있다.**

이건 문서 기준으로 반드시 고정해야 하는 사실이다.

### 1.5 `replaceSemiconductorRefluxTitleSet()`를 overlay 용도로 쓰면 안 된다

[features/post/semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js:51) 기준:

- `ensureSemiconductorRefluxTitleSetLoaded()`는 bundled dataset을 source-of-truth로 본다
- [semiconductor-reflux-title-set.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-title-set.js:237)의 `replaceSemiconductorRefluxTitleSet()`는 로컬 교체 경로다
- 주석에도 다음 배포에서 bundled가 다시 덮는다고 적혀 있다

즉 이 함수는:

- “기본 dataset + overlay”가 아니라
- “기본 dataset 대신 로컬 교체”

성격에 가깝다.

따라서 **overlay는 별도 storage / 별도 runtime으로 분리해야 한다.**

### 1.6 현재 2-parent는 bundled dataset에 강하게 묶여 있다

[features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js:47) 기준:

- `titleSetStatus.sourceType !== 'bundled'`면
  - `twoParentIndexReady = false`
  - 이유: bundled index만 지원

[semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js:294) 기준:

- bundled manifest를 읽고
- `datasetVersion`, `titleCount`가 맞을 때만
- bundled 2-parent index를 사용한다

즉 **title-set을 overlay로 덮어써 버리면 2-parent가 바로 꺼진다.**

이건 이번 설계에서 가장 중요한 연결 제약이다.

### 1.7 게시물/댓글은 결국 공용 matcher 루트를 공유한다

게시물:

- [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:793)
  - `inspectRefluxFourStepCandidate()`
  - `matchesDataset: hasSemiconductorRefluxPostTitle`

댓글:

- [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:387)
  - `inspectRefluxFourStepCandidate()`
  - `matchesDataset: (comment) => hasCommentRefluxMemo(comment.memo)`

그리고 [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js:145) 기준:

- `hasCommentRefluxMemo()`는
  - base title-set exact/permutation/containment
  - bundled 2-parent
  를 재사용한다.

즉 **overlay matcher를 root matcher 경로에 제대로 붙이면 post/comment는 같이 반영된다.**

다만 여기서 한 단계 더 봐야 한다.

- `monitor/scheduler.js`는 post/comment wrapper만 타는 게 아니라
- 역류 matcher를 직접 읽는 분기가 따로 있다

실제 확인된 포인트:

- [features/monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:108)
  - preload
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:455)
  - initial sweep용 dataset miss 계산
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:472)
  - initial sweep local hit
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:500)
  - 공격 모드 샘플 판정
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:528)
  - 공격 모드 샘플 local hit
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:558)
  - cheap attack mode decision
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:655)
  - attacking 중 managed child 보정 preload
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:1072)
  - loadState 후 preload
- [monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/monitor/scheduler.js:1223)
  - initial sweep post filter

즉 문서 기준 구현은 **post/comment만이 아니라 monitor direct caller도 같이 교체**해야 “기존 플로우대로” 맞는다.

### 1.8 background/popup 쪽 scheduler 패턴은 재사용 가능하다

background:

- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:486)
  - `start / stop / getStatus / updateConfig / resetStats / downloadExportJson`
  공통 패턴이 이미 있다
- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:191)
  - 재기동 시 `loadSchedulerStateIfIdle()` + `resumeStandaloneScheduler()` 패턴이 이미 있다

popup:

- [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html:716) 이후의 collector 패널 구조
- [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:155) 이후의 DOM 바인딩
- [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:937) 이후의 collector 이벤트 바인딩

즉 새 기능도 **새 scheduler feature 하나 추가하는 방식**이 가장 자연스럽다.

다만 여기서 중요한 현실 제약이 하나 더 있다.

- background/popup는 “feature key 하나만 추가하면 자동 연결” 구조가 아니다
- 실제로는 아래를 각각 수동 등록해야 한다
  - `background/background.js`
    - scheduler 인스턴스 생성
    - `schedulers` 맵 추가
    - `resumeAllSchedulers()`
    - `getAllStatuses()`
    - `updateConfig` validation branch
    - `resetStats` branch
    - custom action branch
  - `popup/popup.js`
    - `DIRTY_FEATURES`
    - `FEATURE_DOM`
    - `bindFeatureEvents()`
    - 개별 `bind...Events()`
    - `applyStatuses()`
    - 개별 `update...UI()`
    - `buildDefault...Status()`
    - `getFeatureConfigInputs()`

즉 문서상 “새 scheduler 추가”는 맞지만,
실제 패치는 **수동 touchpoint 여러 군데를 같이 채우는 작업**으로 봐야 한다.

---

## 2. 최종 구현 방향

최종 구현 방향은 아래로 고정한다.

### 2.1 기존 `refluxDatasetCollector`는 건드리지 않는다

이유:

- 현재 collector는 full range export 용도다
- live overlay apply가 목적이 아니다
- 순차 처리 구조라 page locate / window collect / active overlay 관리와 맞지 않는다
- 기존 배포 dataset 제작 플로우를 건드리면 파생 리스크가 커진다

따라서 **새 feature를 별도로 만든다.**

### 2.2 새 feature 이름은 `refluxOverlayCollector`로 둔다

역할:

1. `view URL` 입력
2. 원본 page locate
3. `anchorPage ± N` 수집
4. normalize + dedupe
5. overlay 저장
6. matcher runtime 즉시 반영

### 2.3 transport와 overlay를 분리한다

이 설계의 핵심은 둘을 섞지 않는 것이다.

- **overlay logic**
  - 지금 repo만으로 바로 구현 가능
- **proxy transport**
  - 현재 repo 밖의 bridge / adapter 전제

즉 collector는 반드시 아래 인터페이스를 기준으로 짜야 한다.

```ts
type ListPageTransport = {
  fetchBoardListHtml(galleryId: string, page: number, options?: {
    signal?: AbortSignal;
    maxRetries?: number;
  }): Promise<string>;
};
```

1차:

- direct transport
- 기존 [features/reflux-dataset-collector/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/reflux-dataset-collector/api.js:53)의 `fetchBoardListHtml()` 재사용

2차:

- proxy bridge transport
- 같은 시그니처만 맞춰서 주입

이렇게 해야 overlay feature 자체를 지금 바로 붙일 수 있다.

### 2.4 overlay는 “기본 dataset + 로컬 추가분”으로 본다

최종 matcher는 아래 의미가 된다.

```text
effective matcher
  = bundled base dataset
  + local overlay dataset(0개 이상)
```

정확히는:

1. base exact/permutation/containment
2. overlay exact/permutation/containment
3. base 2-parent
4. overlay 2-parent
5. base/overlay 혼합 2-parent

까지 본다.

이걸 빼면,

- 새 source gallery 옛글 2개를 섞은 공격

을 overlay로 수집해도 local에서 계속 놓친다.

즉 **mixed base+overlay 2-parent까지 지원하는 게 맞다.**

---

## 3. 실제 패치 범위

## 3.1 신규 파일

### A. 새 feature 폴더

- `features/reflux-overlay-collector/api.js`
- `features/reflux-overlay-collector/scheduler.js`
- `features/reflux-overlay-collector/transport.js`

### B. overlay storage/runtime

- `features/post/semiconductor-reflux-overlay-store.js`
- `features/post/semiconductor-reflux-effective-matcher.js`

## 3.2 수정 파일

- `background/background.js`
- `popup/popup.html`
- `popup/popup.js`
- `features/post/scheduler.js`
- `features/monitor/scheduler.js`
- `features/post/semiconductor-reflux-post-title-matcher.js`
- `features/comment/comment-reflux-dataset.js`
- `manifest.json` (`proxy_bridge` 2차 연결 시 host permission 필요)

주의:

- `features/post/semiconductor-reflux-title-set.js`는 이번 기능의 base source-of-truth 규칙을 유지해야 하므로,
  overlay 때문에 runtime semantics를 바꾸지 않는다
- `features/post/semiconductor-reflux-post-title-matcher.js`도 base bundled 2-parent loader는 유지한다
- 즉 1차 구현은 **기존 base matcher를 건드리기보다, 그 바깥에 effective matcher 레이어를 하나 더 두는 쪽**이 기준이다

## 3.3 재사용 파일

- `features/reflux-dataset-collector/page-locator.js`
- `features/reflux-dataset-collector/parser.js`
- `features/post/attack-mode.js`
- `features/reflux-normalization.js`
- `features/post/semiconductor-reflux-title-set.js`
- `features/post/semiconductor-reflux-post-title-matcher.js`

---

## 4. 모듈별 책임

### 4.1 `features/reflux-overlay-collector/api.js`

역할:

- config normalize
- `viewUrl`, `beforePages`, `afterPages`, `requestDelayMs`, `jitterMs` 검증
- queue 정렬 helper

기본 config:

```js
{
  viewUrl: '',
  beforePages: 30,
  afterPages: 30,
  requestDelayMs: 500,
  jitterMs: 100,
  transportMode: 'direct', // 'direct' | 'proxy_bridge'
  proxyWorkerCount: 10,
  maxRetriesPerPage: 2,
}
```

검증 규칙:

- `viewUrl`: `page-locator.parseBoardViewUrl()`에 통과해야 함
- `viewUrl`: host/path도 같이 검사해서 `gall.dcinside.com/mgallery/board/view`만 허용
- `beforePages/afterPages`: `0 이상`
- `requestDelayMs`: `500 이상`
- `jitterMs`: `0 이상`
- `proxyWorkerCount`: `1~10`

예:

- 허용: `https://gall.dcinside.com/mgallery/board/view/?id=war&no=3147472`
- 차단: `https://gall.dcinside.com/board/view/?id=war&no=3147472`

차단 이유는 “regular gallery를 지원 안 해서”가 아니라,
**현재 locate/fetch 구현이 mgallery lists 경로를 전제로 묶여 있기 때문**이다.

### 4.2 `features/reflux-overlay-collector/transport.js`

역할:

- collector가 transport 구현을 직접 몰라도 되게 함

반드시 아래 2개를 제공한다.

```js
function createDirectListPageTransport()
function createProxyBridgeListPageTransport(deps)
```

#### direct transport

- 기존 `fetchBoardListHtml()` 래핑
- 지금 repo만으로 바로 구현 가능
- **workerCount는 강제로 1로 둔다**

이유:

- direct mode에서 병렬 burst를 만들 이유가 없다
- 현재 확장 전체의 기본 정책(`500ms + jitter`)과도 맞지 않는다
- speed-up은 proxy bridge mode에서만 가져간다

#### proxy bridge transport

- 실제 Webshare proxy는 여기서 숨김
- collector는 `fetchBoardListHtml()` 시그니처만 본다

중요:

- **Node 테스트 스크립트의 `httpGetViaProxy()`를 extension 안으로 그대로 옮기지 않는다**
- 이유: extension background는 `node:http`가 없다

즉 proxy bridge transport는 아래 둘 중 하나가 전제다.

1. 외부 HTTP proxy bridge 서비스
2. 로컬 Node bridge (`localhost`)

문서 기준 1차 패치에서는:

- 인터페이스만 만들고
- 실제 기본 동작은 direct transport
- bridge 구현이 이미 있으면 그때 adapter만 꽂는다

### 4.3 `features/reflux-overlay-collector/scheduler.js`

역할:

1. `viewUrl` 파싱
2. page locate
3. target page queue 생성
4. transport worker 병렬 수집
5. 결과 normalize + dedupe
6. overlay store save
7. effective matcher reload

phase:

```js
IDLE
LOCATING
FETCHING
SAVING
COMPLETED
INTERRUPTED
FAILED
```

status 필드:

- `viewUrl`
- `galleryId`
- `targetPostNo`
- `foundPage`
- `totalPageCount`
- `targetPageCount`
- `completedPageCount`
- `failedPageCount`
- `rawTitleCount`
- `normalizedTitleCount`
- `appliedOverlayId`
- `startedAt`
- `finishedAt`
- `lastError`
- `logs`

중요 구현 결정:

- page queue는 `anchor` 근처부터 처리한다

예:

```text
anchor=24163, before=3, after=3
수집 순서:
24163, 24164, 24162, 24165, 24161, 24166, 24160
```

이유:

- 중간에 끊겨도 anchor 근처 페이지가 먼저 들어온다
- 공격 대응 가치가 높은 페이지가 먼저 overlay에 반영된다

### 4.4 `features/post/semiconductor-reflux-overlay-store.js`

역할:

- overlay metadata 저장
- overlay title 저장
- active overlay 목록 조회
- 개별/전체 삭제
- runtime reload용 flattened title list 반환

저장소는 2단으로 둔다.

#### A. `chrome.storage.local`

- 작은 metadata만 저장
- key 예: `semiconductorRefluxOverlayMetaState`

형태:

```js
{
  overlays: [
    {
      overlayId: 'war::3147472::24133::24193',
      galleryId: 'war',
      anchorPostNo: 3147472,
      anchorPage: 24163,
      startPage: 24133,
      endPage: 24193,
      pageCount: 61,
      completedPageCount: 59,
      failedPages: [24151, 24177],
      titleCount: 1824,
      createdAt: '2026-04-17T12:35:30.000Z',
      sourceType: 'window_overlay',
      active: true,
    }
  ],
  updatedAt: '...'
}
```

#### B. IndexedDB

- 실제 normalized titles 저장
- 이유: overlay가 여러 개 쌓이면 `chrome.storage.local`만으로는 불안하다

DB 예:

```text
DB_NAME = 'semiconductorRefluxOverlayDb'
stores:
  overlays
  titles
```

`titles` store row:

```js
{
  key: `${overlayId}::${title}`,
  overlayId,
  title,
}
```

지원 API:

- `saveOverlay(overlayMeta, normalizedTitles)`
- `listOverlayMetas()`
- `loadActiveOverlayTitles()`
- `deleteOverlay(overlayId)`
- `clearAllOverlays()`

중요 구현 규칙:

- `chrome.storage.local` + IndexedDB는 하나의 transaction으로 묶이지 않는다
- 그래서 저장/삭제 순서를 명시적으로 정해야 한다

권장 순서:

1. IDB에 새 overlay titles 임시 저장
2. 성공하면 metadata 갱신
3. 마지막에 이전 overlay titles 정리

삭제 권장 순서:

1. IDB titles 삭제
2. 성공하면 metadata 삭제

실패 시 처리:

- metadata만 있고 IDB titles가 없는 orphan
- IDB titles만 있고 metadata가 없는 orphan

둘 다 생길 수 있으므로,
`listOverlayMetas()` / `loadActiveOverlayTitles()` 초기화 시 간단한 orphan 정리 루틴을 두는 게 맞다.

쉽게 말하면:

- 저장소가 2개라서 “한쪽만 저장됨”이 가능하다
- 이걸 문서상 인정하고 정리 정책까지 같이 가져가야 한다

### 4.5 `features/post/semiconductor-reflux-effective-matcher.js`

이 파일이 이번 설계의 핵심이다.

역할:

- base dataset 로드
- overlay dataset 로드
- bundled 2-parent 로드
- overlay local 2-parent 로드
- 최종 `effective matcher` 노출

왜 별도 파일이 필요한가:

- 현재 base title-set은 bundled source-of-truth 전제다
- 현재 bundled 2-parent는 base title-set version/titleCount에 강하게 묶여 있다
- 그 위에 overlay를 얹으려면 **레이어 하나를 더 두는 게 가장 안전하다**

노출 함수:

```js
ensureSemiconductorRefluxEffectiveMatcherLoaded()
getSemiconductorRefluxEffectiveMatcherStatus()
hasSemiconductorRefluxEffectivePostTitle(title)
hasNormalizedSemiconductorRefluxEffectiveTitle(normalizedTitle)
```

추가 상태 함수도 두는 편이 안전하다.

```js
isSemiconductorRefluxEffectiveMatcherReady()
reloadSemiconductorRefluxEffectiveMatcher()
```

이유:

- 현재 post/comment 호출부는 local hit 함수를 **동기**로 쓴다
- 즉 `has...()` 안에서 IndexedDB를 읽는 식의 lazy load는 구조상 불가능하다

정답은 아래다.

- preload / save / delete 시점에는 비동기 `ensure/reload`
- 실제 hit 시점에는 메모리 runtime만 보는 동기 함수

#### 내부 동작 순서

1. base exact/permutation/containment
2. overlay exact/permutation/containment
3. base 2-parent
4. overlay/mixed 2-parent

#### overlay exact/permutation/containment

overlay titles를 normalize해서 별도 runtime set을 만든다.

- `overlayTitleSet`
- `overlayPermutationSignatureSet`
- `overlayContainmentSignatureSet`

#### overlay 2-parent

overlay titles는 local에서 직접 postings map을 만든다.

```js
overlayChunkPostingMap: Map<chunk, number[]>
```

titleId는 overlay local id로 충분하다.

예:

```text
o:0, o:1, o:2 ...
```

#### mixed base+overlay 2-parent

이 부분을 빼면 안 된다.

구현 방식:

- left/right candidate count를 셀 때 source를 namespace로 분리한다

예:

```text
bundled parent 123  -> "b:123"
overlay parent 7    -> "o:7"
```

그다음 `hasTwoParentCandidatePair()`는

- `leftKey !== rightKey`
- leak 조건
- single parent dominating both sides 차단

만 보면 된다.

즉 candidate key를 숫자가 아니라 **source namespaced key**로 바꾸면
base/overlay 혼합 pair도 한 경로에서 처리 가능하다.

이게 이번 문서의 최종 구현안이다.

다만 여기서 실제 코드 기준 추가 이슈가 2개 있다.

#### A. base bundled postings를 외부에서 그대로 못 본다

현재 [features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js) 는

- bundled 2-parent를 메모리에 로드하지만
- `chunkPostingMap` 같은 내부 runtime을 외부에 공개하지 않는다

즉 effective matcher가 mixed pair를 만들려면,
아래 둘 중 하나가 추가로 필요하다.

1. **권장**
   - base matcher에 read-only helper export 추가
   - 예: `getSemiconductorRefluxBundledTwoParentIndexSnapshot()`
2. 비권장
   - effective matcher가 bundled index 로더를 다시 중복 구현

문서 기준 1차 구현은 **1번 권장안**으로 고정한다.

이유:

- loader 중복 구현은 version/titleCount 정합성 로직을 두 군데서 따로 관리하게 된다
- 메모리도 중복으로 먹고, 나중에 drift가 난다

#### B. 기존 후보 정렬 helper는 숫자 ID 전제다

현재 base matcher의 내부 후보 정렬은 titleId를 숫자로 보고 비교한다.

그런데 mixed pair에서 key가

- `123`
- 가 아니라
- `"b:123"`, `"o:7"`

이렇게 문자열이 되면,
기존 numeric sort를 그대로 재사용하면 안 된다.

따라서 effective matcher 쪽 mixed candidate selection은

- `count desc`
- 동률이면 `String(key)` 기준 lexicographic compare

로 따로 구현한다고 문서상 고정한다.

쉽게 말하면:

- “key만 문자열로 바꾸면 끝”이 아니다
- **후보 정렬 helper도 string key 안전하게 바꿔야 한다**

추가로 구현 시 반드시 맞춰야 할 정책 상수:

- base 2-parent 정책은 현재 [features/post/semiconductor-reflux-post-title-matcher.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/semiconductor-reflux-post-title-matcher.js:16) 기준
  - `TWO_PARENT_MIN_TITLE_LENGTH = 26`
  - `DEFAULT_CHUNK_LENGTHS = [3, 4]`
  - `TWO_PARENT_MIN_SIDE_MATCH_COUNT = 2`
  - `TWO_PARENT_MAX_OPPOSITE_LEAK_COUNT = 1`

overlay/mixed 2-parent도 이 상수와 의미를 맞춰야 한다.

예:

- base는 `26자 이상`인데 overlay만 `20자 이상`으로 풀리면
  - 게시물/댓글에서 source마다 hit 기준이 달라지고
  - 운영자가 설명 가능한 정책이 깨진다

따라서 1차 구현은 **base와 overlay가 같은 2-parent gate를 공유한다**고 문서상 고정한다.

그리고 `ready` 의미도 base와 맞춘다.

- `effective matcher ready`
  - base exact 계열 또는 overlay exact 계열을 동기 hit 가능한 상태
- `effective twoParent ready`
  - base/overlay/mixed 2-parent까지 가능한 상태

즉:

- `twoParentReady = false`면 degraded warning만 띄우고 single-title local hit는 계속 써야 함
- `ready`가 false일 때의 동작은 **기존 caller 의미를 유지**해야 함

현재 실제 caller 의미:

- post/manual, monitor
  - hard block보다는 degraded 쪽에 가깝다
- comment/manual
  - matcher 준비 실패 시 시작 단계에서 에러를 올릴 수 있다
- commentMonitor
  - matcher 실패 시 fallback/default 판단으로 간다

이 의미를 바꾸면:

- 게시글 감시 자동화 시작/복원
- 댓글 방어 시작 조건
- 댓글 감시 자동화의 degraded 경고
- popup status 문구

가 전부 꼬인다.

#### runtime 캐시 / reload 규칙

effective matcher는 아래 패턴으로 가져간다.

- `runtimeState.loaded`
- `runtimeState.loadingPromise`
- `runtimeState.overlayVersionKey`

그리고 reload 시에는

1. next overlay runtime을 지역 변수로 전부 빌드
2. 완료되면 `runtimeState`를 한 번에 swap

순서로 처리한다.

이유:

- async reload 중에 기존 runtime 객체를 부분 수정하면
- 그 사이 post/comment sync hit가 중간 상태를 볼 수 있다

즉 **in-place mutate 금지, atomic swap**이 문서 기준이다.

### 4.6 overlay 재수집 정책

overlay는 “매번 새로 append”가 아니라 **동일 range key 기준 replace**로 간다.

range key:

```text
${galleryId}::${anchorPostNo}::${startPage}::${endPage}
```

즉 같은 `viewUrl + beforePages + afterPages`로 다시 수집하면:

- 기존 overlay metadata 갱신
- 기존 overlay titles 삭제 후 재저장

으로 처리한다.

이유:

- 같은 source window가 여러 번 쌓여 중복 관리되는 걸 막는다
- 삭제 UI도 단순해진다
- 운영자 입장에서도 “같은 source overlay를 최신 상태로 교체”가 더 자연스럽다

1차 구현에서는 `active/inactive toggle`은 두지 않는다.

- 저장된 overlay는 전부 active
- 비활성화가 필요하면 삭제 후 다시 수집

이유:

- 1차 구현에서 toggle까지 넣으면
  - metadata 상태
  - runtime reload
  - list UI
  - status 문구

  가 한 번에 복잡해진다

즉 `active: true`는 내부 표현으로 둘 수 있지만,
운영 기능은 **저장/삭제만 제공**한다고 고정한다.

---

## 5. 게시물/댓글 호출부 연결 방식

### 5.1 게시물

[features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:35)와
[features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:793) 기준:

- 현재는 `hasSemiconductorRefluxPostTitle`
- 이걸 `hasSemiconductorRefluxEffectivePostTitle`로 교체한다

그리고 preload도:

- `ensureSemiconductorRefluxPostTitleMatcherLoaded()`
- 대신 `ensureSemiconductorRefluxEffectiveMatcherLoaded()`

로 바꾼다.

중요:

- 이 파일은 교체 지점이 한 군데가 아니다
- 실제 확인된 포인트는 최소 아래다
  - import 구간
    - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:35)
  - start 시 preload
    - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:98)
  - 실행 중 manual mode transition preload
    - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:279)
  - 실행 중 reflux config transition preload
    - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:332)
  - 페이지 필터링 시 `isSemiconductorRefluxDatasetReady / matchesSemiconductorRefluxTitle`
    - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:462)
  - 상태 복원 후 preload
    - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:604)
  - four-step local dataset hit
    - [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:793)

즉 `post/scheduler.js`는 단순 import 교체가 아니라,
**preload/ready/match 3축을 전부 effective matcher 기준으로 맞추는 작업**이다.

그러면 post 쪽 `4단계 필터`는 그대로 두고,
**1단계 local matcher 품질만 effective matcher로 올라간다.**

### 5.1-bis 자동 감시

`monitor/scheduler.js`도 같이 봐야 한다.

이유:

- 이 파일은 역류기 공격 판정용 샘플 검사
- initial sweep 후보 선정
- attacking 중 managed child 보정

에서 base matcher를 직접 읽는다.

따라서 아래도 같이 교체해야 한다.

- `ensureSemiconductorRefluxPostTitleMatcherLoaded()`
  - -> `ensureSemiconductorRefluxEffectiveMatcherLoaded()`
- `hasSemiconductorRefluxPostTitle`
  - -> `hasSemiconductorRefluxEffectivePostTitle`
- `isSemiconductorRefluxPostTitleMatcherReady()`
  - -> `isSemiconductorRefluxEffectiveMatcherReady()`

쉽게 말하면:

- post scheduler만 바꾸면 “수동 게시글 분류”만 올라가고
- monitor scheduler를 안 바꾸면
  - 자동 공격 모드 판정
  - initial sweep

  은 옛 matcher를 계속 보게 된다

그래서 **기존 플로우 보존 기준으로는 monitor도 수정 파일에 포함하는 게 맞다.**

### 5.2 댓글

[features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js:145) 기준:

- 현재 `hasCommentRefluxMemo()`는
  - base title-set
  - bundled 2-parent
  경로를 직접 탄다

이걸 effective matcher 기반으로 바꾼다.

즉:

- `ensureCommentRefluxMatcherLoaded()`
  - 내부에서 effective matcher preload
- `hasCommentRefluxMemo()`
  - normalized memo를 effective matcher에 넘김

그러면 댓글 쪽도:

- exact/permutation/containment
- 2-parent
- overlay

가 같이 들어간다.

결과:

- 게시물 역류기 local matcher
- 댓글 삭제 local matcher
- 댓글 감시의 sample 판정

이 전부 한 번에 올라간다.

댓글 쪽은 post보다 교체 지점이 적지만,
실제로는 아래 의미를 같이 맞춰야 한다.

- [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js:46)
  - preload를 effective matcher 기준으로
- [comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js:103)
  - status/reason 문구를 bundled only가 아니라 effective matcher 기준으로
- [comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js:145)
  - local hit 경로를 effective matcher로

즉 댓글 스케줄러 본체를 크게 뜯지 말고,
**wrapper 파일 하나에서 effective matcher를 감싸는 방식**이 가장 안전하다.

그리고 상태 필드 영향 범위도 같이 본다.

- [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:925)
  - popup에 `commentRefluxMatcherReady`, `commentRefluxTwoParentReady`, `commentRefluxMatcherReason`를 노출
- [features/comment-monitor/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment-monitor/scheduler.js:913)
  - 댓글 감시 자동화도 `refluxMatcherReady`, `refluxTwoParentReady`, `refluxMatcherReason`를 노출

즉 effective matcher status 의미를 바꾸면,
댓글 삭제만이 아니라 **댓글 감시 자동화 status/log 해석까지 같이 바뀐다**.

---

## 6. popup / background 설계

### 6.1 feature key

새 feature key는 아래로 고정한다.

```text
refluxOverlayCollector
```

### 6.2 popup UI

새 탭 1개 추가:

- 탭 라벨: `임시 Overlay`
- `popup/popup.html`에
  - `<button data-tab="refluxOverlayCollector">`
  - `<section data-feature="refluxOverlayCollector">`
  둘 다 추가

이 둘의 문자열은 반드시 같아야 한다.

이유:

- [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:3736)의 `setActiveTab()`은
  - `button.dataset.tab`
  - `panel.dataset.feature`
  의 **완전 일치**로 탭 전환을 한다

즉 이름 하나라도 다르면,

- 탭은 눌리는데 패널이 안 열리거나
- 패널은 있는데 탭 active가 안 맞는 상태

가 바로 난다

설정 입력:

- `viewUrl`
- `beforePages`
- `afterPages`
- `requestDelayMs`
- `jitterMs`
- `transportMode`
- `proxyWorkerCount`

상태 표시:

- `phase`
- `galleryId`
- `targetPostNo`
- `foundPage`
- `progress`
- `normalizedTitleCount`
- `appliedOverlayId`
- `lastError`

행동 버튼:

- `시작`
- `중지`
- `최근 로그 초기화`
- `overlay 전체 삭제`

overlay 목록:

- `galleryId`
- `anchorPostNo`
- `page range`
- `titleCount`
- `createdAt`
- `삭제`

중요:

- overlay 목록은 `getAllStatus` 1초 폴링에 억지로 실어 보내지 않는다
- 이유: popup은 [popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1990) 기준 1초마다 status를 갱신한다
- overlay 목록을 여기서 매번 IDB/local storage와 같이 읽으면 불필요한 비용이 커진다

권장 정책:

- 탭 진입 시 1회 `listOverlays`
- `save / delete / clearAll` 직후 1회 `listOverlays`
- 나머지 1초 폴링은 status만 갱신

쉽게 말하면:

- “상태”는 자주 갱신
- “목록”은 필요할 때만 갱신

### 6.3 background

[background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:486) 기준 공통 scheduler 패턴을 따른다.

필수 액션:

- `start`
- `stop`
- `getStatus`
- `updateConfig`
- `resetStats`

추가 커스텀 액션:

- `listOverlays`
- `deleteOverlay`
- `clearAllOverlays`

중요:

- 새 scheduler는 `schedulers` 맵에 추가
- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:191)의 `resumeAllSchedulers()`에도 추가
- `proxy_bridge` 실제 연결 시 `manifest.json`에 bridge host 권한을 추가

그리고 이번 feature는 기존 collector와 성격이 다르므로,
아래 점도 문서상 고정한다.

- `downloadExportJson` branch를 그대로 재사용하지 않는다
- overlay feature의 핵심 액션은 `listOverlays / deleteOverlay / clearAllOverlays`다
- 즉 background 메시지 분기에서도 기존 dataset collector처럼 “다운로드 중심”으로 만들지 않는다

추가 확인 포인트:

- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:1138)의 `getBusyFeatures()`에는 현재 collector류가 안 들어 있다
- overlay collector도 session/shared-config 변경 시 막을지, 허용할지 정책을 명시해야 한다

문서 기준 1차 권장안:

- overlay collector가 실행 중이면 `busy`로 본다

이유:

- 같은 service worker에서 네트워크 작업이 돌고 있을 때
- 세션 전환/공통 설정 변경이 겹치면
- 운영자가 상태를 해석하기 더 어려워진다

예:

- `http://127.0.0.1:4317/*`
- 또는 외부 bridge URL

---

## 7. 실제 실행 플로우

## 7.1 overlay 수집

```text
popup.start
  -> background.refluxOverlayCollector.start()
    -> parseBoardViewUrl(viewUrl)
    -> locateBoardListPageFromViewUrl()
    -> anchorPage 산출
    -> targetPages(distance-sorted) 생성
    -> worker N개 시작
    -> 각 worker:
         delay + jitter
         transport.fetchBoardListHtml(galleryId, page)
         parseRefluxCollectorTitles(html)
         normalizeSemiconductorRefluxTitle(title)
         shared Set dedupe
    -> 부분 실패 페이지는 retry queue
    -> 끝나면 saveOverlay(meta, normalizedTitles)
    -> reload effective matcher runtime
    -> completed
```

보완 포인트:

- 현재 page-locator는 내부 page cache를 가지지만 HTML 자체를 외부에 넘기지 않는다
- 그래서 1차 구현은 anchor page를 locate 때 한 번, fetch 때 한 번 더 받을 수 있다

이건 1차에선 허용 가능하지만,
문서상 아래 둘 중 하나로 명시해야 한다.

1. 단순 구현:
   - anchor page 중복 fetch를 허용
2. 최적화 구현:
   - page-locator가 anchor page HTML/parsed rows를 선택적으로 반환하도록 확장

문서 기준 1차는 **1번 허용**, 2차 최적화 후보로 둔다.

## 7.2 게시물/댓글 방어 적용

```text
post/comment scheduler cycle
  -> inspectRefluxFourStepCandidate()
    -> matchesDataset = effective matcher
      -> base exact/permutation/containment
      -> overlay exact/permutation/containment
      -> base 2-parent
      -> overlay/mixed 2-parent
```

즉 overlay를 저장하는 즉시,

- 다음 cycle부터는 post/comment가 같이 본다
- scheduler 재시작은 필요 없다

---

## 8. 구현 시 반드시 막아야 할 이슈

### 8.1 `replaceSemiconductorRefluxTitleSet()` 재사용 금지

이걸 쓰면:

- overlay가 base를 대체하게 되고
- bundled 2-parent readiness가 깨진다

즉 이번 기능에서는 사용 금지다.

### 8.2 proxy 실패 시 direct fallback 금지

테스트 스크립트는 [scripts/test-proxy-search-duplicate.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/scripts/test-proxy-search-duplicate.mjs:333)에서 proxy 실패 후 direct fallback을 한다.

이건 테스트에선 괜찮았지만,
overlay collector production path에서는 금지하는 게 맞다.

이유:

- local IP 노출
- 사용자 IP 차단 회피 목적 상실
- transport 의미가 흐려짐

정답:

- proxy transport 실패
  -> 해당 page를 retry queue로 이동
  -> 다른 worker/proxy가 재시도

### 8.3 partial 성공을 실패로 취급하지 않는다

예:

- `61페이지` 중 `58페이지 성공`
- `3페이지 실패`

이 경우 공격 대응 관점에서는:

- `overlay 0개`보다
- `partial overlay 58페이지분`이 낫다

따라서:

- `normalizedTitles.length > 0`이면 저장
- metadata에 `failedPages[]`만 남긴다

### 8.4 anchor range는 전체 페이지 수로 clamp해야 한다

예:

- anchor가 `page 2`
- `beforePages = 30`

이면 시작 페이지는 `1`로 clamp

반대로 끝페이지도 `totalPageCount`로 clamp해야 한다.

### 8.5 overlay list 삭제 시 runtime 즉시 반영

`deleteOverlay()` / `clearAllOverlays()` 후에는

- 저장소 삭제
- effective matcher runtime reload

를 즉시 같이 해야 한다.

안 그러면:

- storage에는 지워졌는데
- 메모리 matcher가 계속 잡는 상태

가 남는다.

### 8.6 comment 상태 문구는 “bundled only” 표현을 정리해야 한다

현재 [features/comment/comment-reflux-dataset.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/comment-reflux-dataset.js:166) 쪽 문구는
공용 bundled dataset 중심이다.

overlay가 들어가면 status/reason도 아래 의미로 바꿔야 한다.

- base ready
- overlay active count
- effective matcher ready

### 8.7 sync hit 경로에서 storage 접근 금지

현재 post/comment 로컬 hit 경로는 전부 sync다.

예:

- [features/post/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/post/scheduler.js:793)
- [features/comment/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/comment/scheduler.js:387)

따라서 아래 구현은 금지다.

- `hasSemiconductorRefluxEffectivePostTitle()` 안에서 IndexedDB 읽기
- `hasCommentRefluxMemo()` 안에서 overlay metadata 비동기 복원

정답:

- scheduler start/loadState/save/delete 시 async ensure/reload
- 실제 `has...()`는 메모리 runtime만 조회

### 8.8 mixed 2-parent 구현용 helper export가 없으면 중복 로더를 만들게 된다

이건 1차 패치 전에 문서상 먼저 고정해야 한다.

- effective matcher가 base bundled postings를 봐야 mixed pair가 가능
- 그런데 지금은 base matcher가 그 내부 상태를 안 내보낸다

그래서 1차 구현 선행 조건:

- `semiconductor-reflux-post-title-matcher.js`에 read-only snapshot/helper export 추가

이걸 안 정하면 구현 단계에서

- base loader 복제
- 메모리 중복
- version drift

가 바로 생긴다.

### 8.9 monitor direct caller 누락 금지

문서 기준 가장 놓치기 쉬운 연결부다.

`monitor/scheduler.js`를 안 바꾸면:

- 수동 게시글 분류는 overlay를 보는데
- 게시글 감시 자동화의
  - attack mode decision
  - initial sweep
  - managed child 보정

은 예전 bundled matcher를 계속 본다.

즉 운영자는 “overlay 저장했는데 왜 자동 감시는 반응이 다르지?” 상태가 된다.

따라서 1차 패치에서는 **monitor direct caller까지 반드시 포함**해야 한다.

---

## 9. 1차 구현 순서

실제 패치는 아래 순서로 넣는 게 맞다.

1. `refluxOverlayCollector` scheduler/additional popup/background skeleton 추가
2. `overlay-store` 추가
3. `effective-matcher` 추가
4. post/comment 호출부 effective matcher로 교체
5. direct transport로 overlay 수집 완료
6. overlay list 조회/삭제 UI 추가
7. 마지막으로 proxy bridge transport adapter 연결

이 순서가 좋은 이유:

- 1~6까지는 현재 repo만으로 검증 가능
- 7은 환경 의존(proxy bridge)만 별도로 붙이면 됨

---

## 10. 정적 검증 체크리스트

패치 전에 이 문서 기준으로 확인해야 할 항목:

1. `viewUrl`에 `id/no`가 없으면 start 차단
2. locate 실패 시 FETCHING 단계 진입 금지
3. `beforePages=0`, `afterPages=0`이면 anchor page 1장만 수집
4. anchor가 1페이지 근처일 때 start clamp
5. anchor가 끝페이지 근처일 때 end clamp
6. page queue가 anchor 근처 우선 순서로 생성되는지
7. direct transport에서도 기존 collector와 같은 제목 파서를 쓰는지
8. overlay 저장 후 popup 새로고침 없이 status가 보이는지
9. overlay 저장 후 running post scheduler가 재시작 없이 local hit를 보는지
10. overlay 저장 후 running comment scheduler도 같은 local hit를 보는지
11. overlay 삭제 후 post/comment가 즉시 빠지는지
12. base dataset만 있는 경우 기존 동작이 바뀌지 않는지
13. overlay 0개일 때 effective matcher가 base matcher와 완전히 같게 동작하는지
14. bundled 2-parent가 준비 안 된 경우에도 base/overlay exact 계열은 계속 동작하는지
15. overlay 2-parent만 있는 경우 title length 26 gate가 유지되는지
16. base+overlay mixed pair가 실제로 true로 올라오는지
17. partial 실패 overlay 저장 시 failedPages가 metadata에 남는지
18. `clearAllOverlays()`가 base dataset에는 손대지 않는지
19. popup resetStats가 overlay data 삭제를 의미하지 않도록 분리됐는지
20. service worker 재기동 후 overlay runtime이 다시 hydrate되는지
21. `transportMode='proxy_bridge'`인데 bridge가 없으면 start 단계에서 명확히 막는지
22. manifest에 proxy host 권한을 추가하더라도 direct 모드 동작에 부작용이 없는지
23. comment monitor sample hit가 effective matcher를 타는지
24. four-step filter stage 명칭은 그대로 유지되는지
25. overlay가 여러 개일 때 dedupe가 overlay 간에도 되는지
26. overlay 삭제가 개별 삭제/전체 삭제 둘 다 되는지
27. overlay metadata list와 IDB title store 사이 orphan이 안 남는지
28. worker 중단 시 phase가 `INTERRUPTED`로 남고 부분 결과 처리 정책이 일관적인지
29. 같은 `viewUrl`을 다시 수집했을 때 overlayId 충돌이 없는지
30. 동일 overlay 재수집 시 “새 overlay 추가”로 갈지 “기존 overlay 교체”로 갈지 정책이 문서대로 일치하는지
31. `post/scheduler.js`의 preload/ready/match 교체 포인트가 누락 없이 전부 바뀌었는지
32. `popup/popup.js`의 `DIRTY_FEATURES`, `FEATURE_DOM`, `bindFeatureEvents`, `applyStatuses`, `getFeatureConfigInputs`에 새 feature가 모두 등록됐는지
33. `background/background.js`의 scheduler 생성/맵/resume/status/updateConfig/resetStats/custom action 분기에 새 feature가 모두 등록됐는지
34. overlay feature가 기존 `downloadExportJson` 흐름을 억지로 재사용하지 않는지
35. overlay/mixed 2-parent가 base와 같은 `26자 / 3,4글자 / leak` 정책으로 동작하는지
36. `viewUrl` 검증이 `id/no`만이 아니라 `mgallery/board/view` scope까지 같이 검사하는지
37. mixed 2-parent 구현 시 base matcher 내부 postings를 보기 위한 read-only export/helper가 정의됐는지
38. mixed candidate key가 문자열(`b:123`, `o:7`)일 때 정렬 helper가 numeric sort를 쓰지 않는지
39. effective matcher reload가 in-place mutate가 아니라 next runtime build 후 atomic swap으로 처리되는지
40. sync hit 함수 안에서 IndexedDB/chrome.storage.local 접근이 완전히 배제됐는지
41. overlay 목록 조회가 `getAllStatus` 1초 폴링에 묶이지 않고 on-demand로만 갱신되는지
42. overlay save/delete 중 한쪽 저장소만 성공했을 때 orphan 정리 정책이 실제 구현과 일치하는지
43. anchor page를 locate/fetch에서 중복 요청해도 허용할지, 아니면 page-locator 반환 확장으로 줄일지 정책이 문서와 일치하는지
44. `getBusyFeatures()`에 overlay collector를 포함할지 여부가 문서와 구현에서 일치하는지
45. `monitor/scheduler.js`의 preload/sample decision/initial sweep/direct local hit 호출이 effective matcher 기준으로 전부 교체됐는지
46. `ready` 의미가 caller별 기존 동작을 깨지 않는지

---

## 11. 최종 결론

문서 기준 최종 결론은 아래다.

- **문제 정의는 끝났다.**
- **`view URL -> locate -> window collect -> overlay save -> effective matcher` 흐름은 실제로 바로 구현 가능한 수준이다.**
- **현재 repo에서 비어 있는 건 proxy bridge transport뿐이다.**

따라서 “지금 바로 패치 가능” 범위는 정확히 아래다.

1. 새 overlay collector feature
2. overlay storage
3. effective matcher
4. post/comment 공용 반영
5. direct transport 기반 동작

그리고 “10프록시 병렬”은 아래 전제로만 추가하면 된다.

6. bridge/adapter transport 연결

즉 이 문서대로 가면:

- 프록시가 아직 없어도 feature 전체 구조는 먼저 완성 가능
- 프록시가 준비되면 collector transport만 갈아끼워 바로 가속 가능

이게 현재 코드와 가장 충돌이 적고, 파생 리스크도 가장 낮은 구현안이다.
