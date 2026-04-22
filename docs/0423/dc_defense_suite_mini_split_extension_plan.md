# 0423 DC Defense Suite Mini 분리 확장 설계

## 1. 목표

이번 문서의 목표는 현재 루트 확장프로그램을 그대로 보존한 채,  
`미니갤 전용 별도 확장프로그램`을 `projects/` 아래에 새로 만드는 방향을 실제 코드 기준으로 고정하는 것이다.

쉽게 말하면 이렇게 간다.

- 지금 루트 확장:
  - `마이너 갤 전용 안정판`
- 새 확장:
  - `미니 갤 전용 분리판`

예시:

- 지금 쓰는 특궁은 그대로 둔다
- 새로 `특궁-mini`를 만든다
- 미니갤에서는 `특궁-mini`만 켜서 쓴다
- 기존 특궁은 손대지 않는다

이 방식의 핵심은 `드롭다운 하나 추가`가 아니라,  
아예 **미니 전용 제품 경계**를 따로 만드는 것이다.

---

## 2. 한 줄 결론

지금 범위가 아래 전체를 포함하므로:

- 도배기 분류
- 게시물 삭제
- IP 차단
- 댓글 방어
- 세션 확인
- 로컬 수집 / dataset 수집

`기존 특궁 내부에 minor/mini 분기를 조금씩 박는 방식`보다  
`projects/dc_defense_suite_mini` 별도 확장으로 복제 후 미니 전용으로 고치는 방식이 더 작고 안전하다.

왜냐하면 현재 코드는 `mgallery` + `_GALLTYPE_='M'` 전제가 한 군데가 아니라 **여러 기능 체인 전체**에 박혀 있기 때문이다.

예시:

- 게시물만 미니로 바꾸는 것은 쉬워 보인다
- 그런데 댓글 삭제 referer, IP 차단 관리 URL, 세션 확인 탭 URL, Local 수집 URL도 전부 `mgallery` 쪽으로 고정돼 있다
- 결국 UI 한 군데가 아니라 기능 사슬 전체를 같이 바꿔야 한다

즉 이번 단계에서는:

1. 기존 루트 확장은 그대로 둔다
2. 새 폴더에 확장을 복제한다
3. 복제본을 `mini 전용`으로 바꾼다

가 맞다.

---

## 3. 이번 문서에서 확정하는 결정

### 3-1. 새 확장은 `projects/` 아래에 만든다

권장 경로:

- `/home/eorb915/projects/dc_defense_suite/projects/dc_defense_suite_mini`

이유:

1. 현재 repo 안에 이미 독립 서브프로젝트들이 `projects/` 아래에 있다
2. 루트 확장을 안 건드리고 같은 repo 안에서 비교/diff 하기 쉽다
3. 별도 repo로 먼저 빼는 것보다 초기 작업 속도가 빠르다

예시 구조:

```text
/home/eorb915/projects/dc_defense_suite/
  manifest.json
  background/
  features/
  popup/
  icons/
  projects/
    dc_defense_suite_mini/
      manifest.json
      background/
      features/
      popup/
      icons/
```

### 3-2. 초기에는 코드 공유를 하지 않는다

1차는 공통 코어 추출을 하지 않는다.

즉:

- 루트와 미니판이 같은 파일을 import 공유하지 않게 한다
- 일단 복제 후 미니 전용으로 바꾼다

이유:

1. 지금은 속도가 중요하다
2. 중간에 공통 모듈을 억지로 뽑으면 어디가 minor 전용이고 어디가 mini 전용인지 더 빨리 꼬인다
3. 먼저 미니판이 실전에서 돌아가야 한다

예시:

- 나중에 `buildBoardListUrl()` 같은 공통 helper를 뽑는 것은 가능
- 하지만 지금 처음부터 그걸 하려고 하면 minor까지 같이 흔들린다

### 3-3. 루트 확장은 그대로 둔다

루트의:

- `manifest.json`
- `background/`
- `features/`
- `popup/`

는 이번 설계 기준으로 건드리지 않는 쪽이 맞다.

목표는 `특궁-mini`를 빠르게 붙이는 것이지,  
기존 마이너 전용 안정판을 같이 리팩터링하는 것이 아니다.

### 3-4. 초기 복제 범위는 런타임 파일만 복제한다

복제 대상:

- `manifest.json`
- `background/`
- `features/`
- `popup/`
- `icons/`
- `data/`

복제하지 않아도 되는 것:

- `docs/`
- `scripts/`
- `node_modules/`
- `projects/`

이유:

1. 현재 확장은 별도 build pipeline 없이 바로 로드되는 MV3 구조다
2. 런타임은 사실상 위 6개 영역이 전부다
3. `package.json`도 실질적인 빌드 의존성이 없다

중요한 수정:

- 처음 문서 초안에서는 `data/`를 복제 제외로 적었지만, 이건 실제 코드 기준으로 틀렸다
- 현재 런타임은 번들 dataset JSON을 `chrome.runtime.getURL('data/...')` 로 직접 읽는다

근거:

- `features/post/semiconductor-reflux-title-set.js:33`
  - `BUNDLED_DATASET_PATH = 'data/reflux-title-set-unified.json'`
- `features/post/semiconductor-reflux-post-title-matcher.js:12`
  - `BUNDLED_TWO_PARENT_INDEX_PATH = 'data/reflux-two-parent-index.json'`
- 두 파일 모두 내부에서 `chrome.runtime.getURL(datasetPath)` 후 `fetch()` 한다
  - `semiconductor-reflux-title-set.js:458-467`
  - `semiconductor-reflux-post-title-matcher.js:475-484`

즉 `data/`를 안 복제하면:

- 게시물 matcher
- 댓글 역류 dataset
- monitor 쪽 matcher 연동

이 번들 dataset 의존 경로가 런타임에서 바로 깨질 수 있다

쉽게 예시를 들면:

- mini 확장을 `background/`, `features/`, `popup/`, `icons/`만 복제해서 로드함
- 게시물 분류가 matcher를 쓰는 순간 `data/reflux-title-set-unified.json` fetch 시도
- 그런데 mini 확장 패키지 안에 그 파일이 없어서 `HTTP 404`
- 그러면 mini판이 “UI는 뜨는데 matcher 계열만 비정상”인 상태가 된다

참고:

- 루트 `manifest.json`은 MV3 직접 로드형 구조다
- 루트 `package.json`은 사실상 비어 있다

즉 이 프로젝트는 `복제 -> 이름 변경 -> 경로 수정 -> 언팩 로드` 흐름이 가능하다.

실무적으로는 1차에 아래처럼 가는 게 제일 안전하다.

- 안전 우선:
  - `data/` 전체를 같이 복제
- 나중에 슬림화:
  - `data/past/`, 측정 산출물, 테스트 산출물 제거 검토

즉 지금 단계에서는 용량보다 누락 리스크가 더 크므로, `data/`는 같이 복제하는 쪽이 맞다.

---

## 4. 왜 “Local 수집에 드롭다운 추가”가 아니라 “mini 분리판”인가

이 질문은 이미 방향이 정리됐지만, 구현 전에 다시 고정할 필요가 있다.

`Local 수집` 하나만 미니 지원시키는 것은 쉽다.

예시:

- 지금: `/mgallery/board/lists/?id=...`
- 바꾸면: `/mini/board/lists/?id=...`

하지만 사용자가 원하는 범위는 여기서 끝이 아니다.

실제 요구 범위:

- 게시물 도배기 분류
- 게시물 삭제
- 게시물 IP 차단
- 댓글 삭제/차단
- 세션 로그인 확인
- 로컬 수집
- dataset overlay 수집

즉 `수집기만` 미니가 아니라, **운영 체인 전체가 미니를 타야 한다**.

그래서 드롭다운 접근은 이렇게 된다.

- `Local 수집`에 갤 종류 드롭다운 추가
- 그 다음 `게시물 API`에도 갤 종류 추가
- `댓글 API`에도 갤 종류 추가
- `IP 차단 API`에도 갤 종류 추가
- `dc-session-broker`에도 갤 종류 추가
- `concept-monitor`에도 갤 종류 추가

이렇게 되면 결국 루트 확장 전체를 건드리게 된다.

반대로 분리판은:

- 루트는 minor 전용으로 남음
- mini판은 처음부터 `mini 기준 기본값`으로 고정

이므로 설계가 더 단순하다.

---

## 5. 실제 코드 기준 교차검증 결과

아래 내용은 실제 코드와 다시 대조해 확인한 결과다.

### 5-1. 세션 확인 탭부터 이미 `mgallery` 고정이다

파일:

- `background/dc-session-broker.js`

확인 포인트:

- `buildSessionCheckListUrl()`  
  - `dc-session-broker.js:1184-1187`
  - `https://gall.dcinside.com/mgallery/board/lists/?id=...` 고정
- `buildGalleryListUrl()`  
  - `dc-session-broker.js:1189-1192`
  - 동일하게 `mgallery`
- 관리자 버튼 확인 selector  
  - `dc-session-broker.js:1411-1415`
  - `"/mgallery/management?id=..."` 를 직접 찾는다

의미:

- 미니판에서는 세션 확인 URL부터 바뀌어야 한다
- 단순히 목록 URL만 바꾸면 안 되고, DOM에서 찾는 관리자 버튼 경로도 다시 맞춰야 한다

쉽게 예시를 들면:

- 지금은 로그인 확인 시 “특갤 관리 버튼”을 찾을 때  
  `onclick*="/mgallery/management?id=..."` 를 찾는다
- 미니판에서 관리 버튼이 `/mini/management?id=...` 형태면 지금 로직은 무조건 실패 판정이 난다

### 5-2. 게시물 방어는 목록/분류/삭제가 전부 minor 전제다

파일:

- `features/post/api.js`

확인 포인트:

- 기본 타입:
  - `post/api.js:13-19`
  - `galleryType: 'M'`
- 목록 조회:
  - `post/api.js:100-107`
  - `/mgallery/board/lists/`
- 분류:
  - `post/api.js:309-339`
  - `/ajax/minor_manager_board_ajax/chg_headtext_batch`
  - referer `/mgallery/board/lists/?id=...`
  - `_GALLTYPE_=${galleryType}`
- 삭제:
  - `post/api.js:359-405`
  - `/ajax/minor_manager_board_ajax/delete_list`
  - referer `/mgallery/board/lists/?id=...`
  - `_GALLTYPE_=${galleryType}`

의미:

- 게시물 쪽은 “목록 경로만 mini로 바꾸기”로 끝나지 않는다
- 분류/삭제 관리 AJAX와 referer, `_GALLTYPE_`까지 같이 본다

예시:

- mini 목록은 열리는데
- 분류 버튼 누르면 `_GALLTYPE_='M'` 으로 날아감
- 또는 referer가 `/mgallery/...` 로 찍힘
- 그러면 mini판이더라도 관리 요청이 틀어질 수 있다

### 5-3. 댓글 방어도 minor 전제가 깊게 박혀 있다

파일:

- `features/comment/api.js`

핵심 확인 포인트:

- 기본 타입:
  - `galleryType: 'M'`
- 글 목록 HTML:
  - `/mgallery/board/lists/`
- 글 view:
  - `/mgallery/board/view/`
- 댓글 조회:
  - `/board/comment/`
  - referer는 `/mgallery/board/view/?id=...&no=...`
- 댓글 삭제:
  - `/ajax/minor_manager_board_ajax/delete_comment`
  - referer는 mgallery view
- 댓글 삭제+차단:
  - `/ajax/minor_manager_board_ajax/update_avoid_list`
  - `_GALLTYPE_` 포함

의미:

- 댓글 방어는 view/list/referer/관리 AJAX가 같이 묶여 있다
- mini판에서는 “댓글 API만 조금 수정”으로는 부족하다

예시:

- 댓글 조회는 되는데
- 삭제 referer가 여전히 `mgallery/view`
- 그러면 실제 삭제 단계에서 실패할 수 있다

### 5-4. IP 차단도 minor 전제다

파일:

- `features/ip/api.js`

확인 포인트:

- 기본 타입:
  - `galleryType: 'M'`
- 대상 게시물 목록:
  - `/mgallery/board/lists/`
- 차단 목록/관리 페이지:
  - `/mgallery/management/block`
- 차단/해제 AJAX:
  - `_GALLTYPE_` 포함

의미:

- 미니판의 `게시물 -> IP 차단` 체인도 같이 바뀌어야 한다

예시:

- 미니 게시물 번호는 잘 잡았는데
- 차단 관리 페이지 진입이 `mgallery/management/block` 로 가면
- 여기서부터는 미니판이 아니라 마이너판 기준으로 흘러버린다

### 5-5. 개념/관리 계열도 minor 고정이다

파일:

- `features/concept-monitor/api.js`

확인 포인트:

- 기본 타입 `galleryType: 'M'`
- 목록 조회 `/mgallery/board/lists/`
- view `/mgallery/board/view/`
- 관리 페이지 `/mgallery/management/gallery`
- 추천/개념 해제/보안문자 설정 관련 AJAX가 minor 관리자 경로를 전제

의미:

- 미니판에서 개념 관련 기능까지 쓸 생각이면 이 파일도 같이 봐야 한다

추가로 이번 재검증에서 확인된 점:

- 개념글 목록 shape check:
  - `concept-monitor/api.js:375-393`
  - `'/mgallery/board/lists/?id='` 를 직접 마커로 본다
- 게시물 view shape check:
  - `concept-monitor/api.js:395-404`
  - `'/mgallery/board/view/?id='` 를 직접 마커로 본다
- 관리 페이지 shape check:
  - `concept-monitor/api.js:477-485`
  - `'/mgallery/management/gallery?id='` 를 직접 마커로 본다

즉 이 파일은 단순히 fetch URL만 `mgallery` 인 것이 아니다.

- HTML을 받아도
- 내부 검증 함수가 `mgallery` 흔적을 못 찾으면
- mini HTML을 정상 응답으로 받아도 실패 처리할 수 있다

예시:

- mini 관리 페이지를 정상으로 가져옴
- 그런데 HTML 안 링크가 `/mini/management/gallery?id=...`
- 현재 `looksLikeManagementGalleryHtml()` 는 `/mgallery/management/gallery?id=` 만 찾음
- 결과적으로 fetch는 성공했는데도 “형태 검증 실패”로 죽을 수 있다

### 5-6. 공통 설정과 기본 galleryId seed도 같이 정리해야 한다

파일:

- `popup/popup.html`
- `popup/popup.js`
- `background/background.js`

확인 포인트:

- 공통 설정 문구:
  - `popup/popup.html:2035-2048`
  - 설명이 `마이너갤 전용 범용화` 로 적혀 있다
- 공통 설정 입력 기본값:
  - `popup/popup.html:2046-2048`
  - `sharedGalleryId` 기본값이 `thesingularity`
- 공통 저장 payload:
  - `popup/popup.js:620-647`
  - 저장하는 값은 `galleryId`, `headtextId` 뿐이다
- 공통 설정 동기화 fallback:
  - `popup/popup.js:5915-5927`
  - 상태에서 값을 못 찾으면 다시 `thesingularity` 로 채운다
- background 적용 범위:
  - `background/background.js:1612-1679`
  - 실제로 여러 scheduler에 `galleryId` 와 `headtextId` 는 퍼뜨리지만
  - `galleryType` 은 전혀 바꾸지 않는다

의미:

- mini 분리판에서 popup 문구만 바꾸는 걸로 끝나지 않는다
- `shared save` 를 눌러도 `galleryType` 이 mini용으로 바뀌는 구조가 아니다
- 따라서 mini판은 각 feature의 기본 `galleryType`, 기본 `galleryId` seed를 따로 정리해야 한다

쉽게 예시를 들면:

- mini판 popup에서 갤러리 ID만 `ryosanzirai2` 로 저장함
- 그런데 어떤 API 파일 기본값은 여전히 `galleryType: 'M'`
- shared save는 그 값을 안 건드린다
- 그러면 겉으로는 mini 갤 ID를 쓰는데 실제 관리자 요청은 여전히 minor 타입으로 날 수 있다

또 다른 예시:

- popup 상태 동기화가 실패하거나 초기 상태일 때
- `sharedGalleryId` 입력칸이 다시 `thesingularity` 로 보인다
- 사용자가 그 상태로 저장하면 mini판인데도 특갤 ID가 다시 퍼질 수 있다

즉 mini판은 아래 둘을 같이 해야 한다.

1. 공통 설정 UI 문구/기본값 수정
2. 각 feature/scheduler/API 기본 seed 수정

### 5-7. Local 수집은 현재 `mgallery`만 돈다

파일:

- `features/reflux-dataset-collector/api.js`
- `popup/popup.html`
- `popup/popup.js`

확인 포인트:

- 수집 URL builder:
  - `reflux-dataset-collector/api.js:46-50`
  - `/mgallery/board/lists/`
- UI:
  - `popup/popup.html:725-824`
  - 설정은 `갤 ID / 시작 페이지 / 끝 페이지 / 간격 / 지터`만 있음
- 저장 로직:
  - `popup/popup.js:1631-1715`
  - `galleryKind` 같은 값은 전혀 없음

의미:

- 루트에서 minor/mini 드롭다운을 넣지 않아도 된다
- mini 분리판에서는 그냥 이 collector 기본 경로를 `/mini/...` 로 바꾸면 된다

예시:

- 루트 특궁:
  - 마이너 Local 수집
- mini 특궁:
  - 같은 UI
  - 하지만 내부 list URL만 `/mini/board/lists/` 로 다름

추가로 이번 재검증에서 확인된 점:

- overlay collector URL 입력 placeholder:
  - `popup/popup.html:895-897`
  - 예시 URL이 `/mgallery/board/view/` 로 박혀 있다

의미:

- 미니판에서 기능은 제대로 바꿔도
- UI 예시가 계속 `mgallery` 이면 테스트할 때 사용자가 잘못된 주소를 넣기 쉽다

### 5-8. overlay/dataset 보조 수집도 `mgallery` 전제다

파일:

- `features/reflux-overlay-collector/api.js`
- `features/reflux-dataset-collector/page-locator.js`
- `features/comment-reflux-collector/api.js`

확인 포인트:

- overlay collector는 현재 `/mgallery/board/view/` 만 허용
- page locator도 `/mgallery/board/lists/` 기준
- comment reflux collector도 `/mgallery/board/lists/`, `/mgallery/board/view/`, `galleryType: 'M'`

의미:

- dataset 계열도 미니판에서는 같이 바뀌어야 한다

### 5-9. 일부 파서는 이미 mini 링크를 받아들인다

파일:

- `features/post/reflux-search-duplicate-parser.js`

확인 포인트:

- `normalizeHref()` 쪽에서 `/mini/`도 디시 글 링크로 처리하는 로직이 이미 있다

의미:

- 모든 코드가 완전히 minor-only 인 것은 아니다
- 링크 파서나 일부 범용 유틸은 그대로 재사용될 가능성이 있다

즉 이번 분리판 패치는 “전부 새로 만들기”가 아니라,  
**minor 전제 하드코딩이 박힌 파일만 집중적으로 바꾸는 작업**이다.

### 5-10. 신문고 댓글과 한글 리프레시 IP 차단도 minor 전제다

파일:

- `features/sinmungo-comment/api.js`
- `features/han-refresh-ip-ban/api.js`
- `features/han-refresh-ip-ban/parser.js`

확인 포인트:

- 신문고 댓글:
  - `sinmungo-comment/api.js:4-17`
  - 기본값이 `galleryId: 'thesingularity'`, `galleryType: 'M'`
- 한글 리프레시 IP 차단:
  - `han-refresh-ip-ban/api.js:3-13`
  - 기본값이 `galleryId: 'thesingularity'`, `galleryType: 'M'`
  - `buildManagementBlockUrl()` 는 `/mgallery/management/block`
    - `han-refresh-ip-ban/api.js:75-83`
  - 재차단 요청은 `_GALLTYPE_` 와 management referer를 같이 쓴다
    - `han-refresh-ip-ban/api.js:184-205`
  - parser shape check도 `/mgallery/management/block` 를 본다
    - `han-refresh-ip-ban/parser.js:200-206`

의미:

- mini판이 “게시물/댓글/IP차단”만 맞는다고 끝이 아니다
- 현재 운영에서 신문고 댓글, 도배기 갱신 차단까지 쓰면 이쪽도 같이 minor 전제에서 풀어야 한다

예시:

- mini판에서 게시물 삭제와 댓글 삭제는 맞춰 놓음
- 그런데 한글 리프레시 IP 차단은 계속 `/mgallery/management/block` 로 들어감
- 그러면 평소엔 안 보이다가 실제 갱신 차단 루틴에서만 터질 수 있다

또는:

- mini 관리 block HTML을 정상으로 가져옴
- 그런데 parser가 `/mgallery/management/block` 흔적만 찾음
- 그 결과 fetch는 성공했는데 parser 단계에서 비정상 HTML로 떨어질 수 있다

즉 이 둘은 “나중에 보면 되는 부가기능”이 아니라,
mini판 운영 범위에 넣을 거면 문서 단계에서 같이 잡아야 한다

### 5-11. 번들 dataset도 런타임 의존성이라 같이 복제해야 한다

파일:

- `features/post/semiconductor-reflux-title-set.js`
- `features/post/semiconductor-reflux-post-title-matcher.js`

확인 포인트:

- 번들 title-set manifest:
  - `semiconductor-reflux-title-set.js:33`
  - `data/reflux-title-set-unified.json`
- 번들 2-parent index manifest:
  - `semiconductor-reflux-post-title-matcher.js:12`
  - `data/reflux-two-parent-index.json`
- 두 파일 모두 실제 런타임 fetch:
  - `semiconductor-reflux-title-set.js:458-467`
  - `semiconductor-reflux-post-title-matcher.js:475-484`

의미:

- `data/`는 단순 문서/산출물 폴더가 아니다
- 최소한 reflux 번들 dataset JSON들은 확장 런타임이 직접 읽는다

예시:

- mini판에서 post/comment/monitor matcher를 그대로 쓸 생각이면
- `data/reflux-title-set-unified.json` 과 shard 파일들
- `data/reflux-two-parent-index.json` 과 bucket 파일들

이 모두 mini 확장 패키지 안에 있어야 한다

즉 이번 mini 분리판은 “런타임 파일만 복제”가 맞지만,
여기서 말하는 런타임 파일 안에는 `data/`도 포함된다

---

## 6. `_GALLTYPE_` 는 public surface 기준으로 확인됐고, 관리 AJAX는 아직 “실측 확인 필요”다

이 부분은 가장 중요하다.

mini public HTML 기준으로는 `MI` 가 이미 확인됐다.

근거:

- `https://gall.dcinside.com/mini/board/lists/?id=ryosanzirai2`
  - `var _GALLERY_TYPE_ = "MI";`
- `https://gall.dcinside.com/mini/board/view/?id=ryosanzirai2&no=9170&page=1`
  - `var _GALLERY_TYPE_ = "MI";`
  - hidden input `_GALLTYPE_ value="MI"`
  - hidden `view_url = /mini/board/view/...`
  - hidden `list_url = /mini/board/lists/...`

즉 아래 둘은 이제 public surface 기준으로 확정해도 된다.

예시:

- public list/view 경로는 `/mini/board/...`
- public mini gallery type 값은 `MI`

하지만 이것만으로 아래를 확정하면 안 된다.

- mini 관리 AJAX도 `_GALLTYPE_='MI'` 인지
- endpoint가 여전히 `minor_manager_board_ajax/*` 인지
- authenticated manager 기준 referer / management path가 최종적으로 무엇인지

즉 지금 확정 가능한 것은:

- mini public surface는 `MI + /mini/board/...` 조합이다

지금 확정하면 안 되는 것은:

- mini 게시물 분류/삭제/댓글삭제/IP차단의 관리 endpoint 최종형

그래서 미니판 1차 패치 전에 **반드시 실측 캡처 1회**가 필요하다.

필수 캡처 대상:

1. mini 갤 게시물 머릿말 변경 1회
2. mini 갤 게시물 삭제 1회
3. mini 갤 댓글 삭제 1회
4. mini 갤 IP 차단 1회

여기서 확인할 것:

- 요청 URL
- referer
- `_GALLTYPE_`
- `id`
- `nos[]` / `comment[]` / 차단 파라미터 shape

쉽게 예시:

- 만약 DevTools에서 mini 머릿말 변경 요청이
  - URL: `/ajax/minor_manager_board_ajax/chg_headtext_batch`
  - `_GALLTYPE_=MI`
  - referer: `/mini/board/lists/?id=...`
  라면
- 미니판에서는 endpoint는 그대로 두고 `_GALLTYPE_` 와 referer만 바꾸면 된다

반대로:

- URL 자체가 `/ajax/mini_manager_board_ajax/...`
  라면
- endpoint도 함께 갈아야 한다

추가 확인:

- 비로그인 상태에서 `/mgallery/management/...` 와 `/mini/management/...` 는 둘 다 `200 + 홈 리다이렉트 스크립트` 응답이 왔다
- 즉 두 management path가 모두 존재할 가능성은 보였지만,
- 실제 로그인된 mini 관리자 요청 기준으로 어느 path / referer가 최종형인지는 아직 실측이 필요하다

---

## 7. 새 확장 폴더 구성안

권장 1차 생성 구조:

```text
/home/eorb915/projects/dc_defense_suite/projects/dc_defense_suite_mini/
  manifest.json
  background/
  features/
  popup/
  icons/
  data/
```

1차는 루트에서 아래만 복제하면 된다.

- `/home/eorb915/projects/dc_defense_suite/manifest.json`
- `/home/eorb915/projects/dc_defense_suite/background`
- `/home/eorb915/projects/dc_defense_suite/features`
- `/home/eorb915/projects/dc_defense_suite/popup`
- `/home/eorb915/projects/dc_defense_suite/icons`
- `/home/eorb915/projects/dc_defense_suite/data`

복제하지 않는 것:

- `/home/eorb915/projects/dc_defense_suite/docs`
- `/home/eorb915/projects/dc_defense_suite/scripts`
- `/home/eorb915/projects/dc_defense_suite/projects`

---

## 8. 구현 순서

이번 문서는 `바로 작업 가능한 순서`까지 고정한다.

### 단계 1. 새 미니 확장 폴더 생성

작업:

1. `projects/dc_defense_suite_mini` 생성
2. 루트 런타임 파일 복제
3. 새 확장을 브라우저에서 별도 언팩 확장으로 로드 가능하게 준비

이 단계에서 바꿀 것:

- `manifest.json`
  - `name`을 `DC Defense Suite Mini` 등으로 변경
  - 필요하면 `description`도 mini 전용으로 변경

예시:

- 루트:
  - `DC Defense Suite`
- 미니판:
  - `DC Defense Suite Mini`

### 단계 2. public list/view 경로를 mini 기준으로 고정

이 단계는 “누가 봐도 확정”인 public URL만 먼저 바꾸는 단계다.

대표 대상:

- `background/dc-session-broker.js`
- `features/post/api.js`
- `features/comment/api.js`
- `features/ip/api.js`
- `features/concept-monitor/api.js`
- `features/reflux-dataset-collector/api.js`
- `features/reflux-overlay-collector/api.js`
- `features/reflux-dataset-collector/page-locator.js`
- `features/comment-reflux-collector/api.js`
- `features/uid-warning-autoban/api.js`
- `features/bump-post/api.js`
- `features/semi-post/api.js`
- `features/sinmungo-comment/api.js`
- `features/han-refresh-ip-ban/api.js`

그리고 이번 재검증 기준으로, 이 단계에서 같이 잡아야 하는 것이 하나 더 있다.

- 각 feature/scheduler/API의 기본 `galleryId: 'thesingularity'` seed 정리

예시:

- URL은 `/mini/board/lists/` 로 바꿨는데
- `DEFAULT_CONFIG.galleryId` 는 계속 `thesingularity`
- 그러면 초기 상태나 일부 fallback에서 mini판인데도 특갤 ID가 살아날 수 있다

변경 예시:

- `/mgallery/board/lists/` -> `/mini/board/lists/`
- `/mgallery/board/view/` -> `/mini/board/view/`

주의:

- 이 단계는 `list/view/session surface` 까지만 먼저 고정하는 단계다
- `/mgallery/management/...` 같은 관리 경로는 실측 전엔 일괄 치환하지 않는다
- 관리 경로는 4단계에서 `_GALLTYPE_`, endpoint, referer와 함께 확정한다

이 단계 목표:

- 목록 읽기
- 글 보기
- 세션 확인 탭 열기

까지는 mini surface 기준으로 돌아가게 하는 것

### 단계 3. popup 문구와 기본값을 mini 전용으로 정리

대표 대상:

- `popup/popup.html`
- `popup/popup.js`
- `background/background.js`

바꿔야 하는 것:

- “특갤”, “마이너 갤” 같은 문구가 있으면 mini에 맞는 표현으로 조정
- Local 수집 도움말 문구가 mgallery 전제를 암시하면 정리
- overlay URL placeholder 같은 예시 입력도 mini 기준으로 조정
- `sharedGalleryId` 기본값과 fallback도 mini 기준으로 조정

중요:

- `sharedSaveConfig` 는 `galleryId`, `headtextId` 만 저장한다
- `galleryType` 은 저장도 안 하고 background에서 퍼뜨리지도 않는다

즉 popup 쪽을 정리하면서 동시에 문서상으로 아래를 고정해야 한다.

1. mini판에서 기본 `galleryId` seed를 무엇으로 둘지
2. 빈 상태를 허용할지, mini 예시 ID를 둘지
3. `galleryType` 은 shared save가 아니라 각 feature 기본값에서 따로 관리한다는 점

중요:

- 이번 분리판에서는 `갤 종류 드롭다운`을 만들 필요가 없다
- mini 전용판이므로 UI는 그대로 두고 동작 경로만 mini로 고정하면 된다

### 단계 4. 관리 요청 `_GALLTYPE_` / endpoint / referer를 mini 기준으로 실측 후 반영

이 단계가 핵심이다.

수정 대상 후보:

- `features/post/api.js`
- `features/comment/api.js`
- `features/ip/api.js`
- `features/concept-monitor/api.js`
- `features/sinmungo-comment/api.js`
- `features/han-refresh-ip-ban/api.js`
- 기타 관리 AJAX를 보내는 모든 모듈

실측 후 확정할 값:

- `_GALLTYPE_`
- endpoint
- referer

이 단계는 “문자열 일괄치환”이 아니라,  
mini 실제 요청을 본 뒤 맞춰 넣어야 한다.

### 단계 5. mini판 최소 운영 검증

최소 검증 순서:

1. 세션 브로커 healthy 판정 확인
2. 게시물 목록 1페이지 HTML 정상 조회
3. 댓글 API 정상 조회
4. 게시물 분류 1건
5. 게시물 삭제 1건
6. 댓글 삭제 1건
7. IP 차단 1건
8. Local 수집 2~3페이지 정상 다운로드

예시:

- mini 갤 ID 하나 정함
- Local 수집으로 페이지 1~3만 돌려봄
- 게시물/댓글 수동 1건씩만 실험
- 그 다음 자동화 연결

---

## 9. 1차 수정 대상 파일 목록

아래는 “이번 분리판 작업에서 우선순위가 높은 실제 파일” 목록이다.

### A. 최우선

- `background/dc-session-broker.js`
- `background/background.js`
- `features/post/api.js`
- `features/comment/api.js`
- `features/ip/api.js`
- `features/sinmungo-comment/api.js`
- `features/han-refresh-ip-ban/api.js`
- `features/han-refresh-ip-ban/parser.js`
- `popup/popup.html`
- `popup/popup.js`
- `features/reflux-dataset-collector/api.js`
- `features/post/scheduler.js`
- `features/comment/scheduler.js`
- `features/monitor/scheduler.js`
- `features/comment-monitor/scheduler.js`
- `features/semi-post/scheduler.js`

이유:

- 세션 확인
- 게시물 분류/삭제
- 댓글 삭제
- IP 차단
- 신문고/갱신 차단
- Local 수집
- 기본 seed/fallback 정리

이 다섯 축이 mini판 핵심 운영 기능이기 때문이다.

### B. 바로 다음

- `features/concept-monitor/api.js`
- `features/reflux-overlay-collector/api.js`
- `features/reflux-dataset-collector/page-locator.js`
- `features/comment-reflux-collector/api.js`
- `features/uid-warning-autoban/api.js`
- `features/bump-post/api.js`
- `features/semi-post/api.js`

이유:

- 부가 기능이지만 minor 경로 하드코딩이 남아 있으면 나중에 미니판에서 뒤늦게 터진다

### C. 대부분 그대로 둘 가능성이 있는 영역

- 제목 정규화 / matcher
- search duplicate parser 일부
- dataset 문자열 처리 로직

이유:

- 이쪽은 gallery 종류보다 텍스트 로직 비중이 높기 때문이다

단, 링크 파싱이 들어간 부분은 다시 보는 것이 안전하다.

---

## 10. 바로 구현해도 되는 것과 아직 안 되는 것

### 10-1. 지금 바로 구현해도 되는 것

1. `projects/dc_defense_suite_mini` 폴더 생성
2. 런타임 파일 복제
3. `manifest.json` 이름 변경
4. `data/` 번들 dataset까지 같이 들어갔는지 확인
5. list/view/session surface URL을 mini 기준으로 바꾸는 작업
6. `thesingularity` 기본 seed와 shared config fallback 정리
7. popup/help text/placeholder 정리
8. Local 수집을 mini list 기준으로 돌리기

### 10-2. 실측 없이 바로 확정하면 안 되는 것

1. mini 관리자 AJAX endpoint 문자열
2. mini 관리자 referer 최종형
3. mini 관리자 버튼 selector 최종형
4. mini 관리 페이지 세부 DOM 차이
5. shared save만 누르면 galleryType까지 정리된다고 가정하는 것

반대로 지금 바로 확정해도 되는 것:

- public list/view 경로는 `/mini/board/...`
- public mini gallery type은 `MI`

즉 “확실한 public URL”과 “실제 관리자 요청 payload”를 분리해야 한다.

---

## 11. 검증 체크리스트

문서대로 패치한 뒤 아래를 체크하면 된다.

### 체크 1. 루트 확장은 전혀 안 깨졌는가

- 루트 특궁 로드 정상
- 기존 마이너 갤 기능 정상

### 체크 2. 미니판이 별도 확장으로 로드되는가

- 이름이 `Mini` 로 구분되는가
- popup이 정상 열리는가
- background service worker가 뜨는가

### 체크 3. public surface가 mini로 바뀌었는가

- session check 탭이 `/mini/board/lists/` 로 여는가
- Local 수집 요청 URL이 `/mini/board/lists/` 인가
- 게시물 view referer가 `/mini/board/view/` 인가
- overlay 입력 placeholder도 `/mini/board/view/` 예시로 바뀌었는가

### 체크 3-1. shared 설정이 특갤 값으로 되돌아가지 않는가

- `sharedGalleryId` 기본값이 여전히 `thesingularity` 인가
- 상태 동기화 fallback이 `thesingularity` 를 다시 넣는가
- mini판에서 공통 저장 후 scheduler 값이 전부 mini ID로 유지되는가

### 체크 4. 관리 요청이 mini에 맞는가

- 분류 요청 endpoint
- 삭제 요청 endpoint
- 댓글 삭제 endpoint
- IP 차단 endpoint
- `_GALLTYPE_`

모두 DevTools에서 다시 확인

주의:

- 여기서 `galleryId` 는 mini로 잘 바뀌었는데
- `_GALLTYPE_` 만 `M` 으로 남는 케이스가 제일 놓치기 쉽다
- shared save가 이를 해결해주지 않기 때문이다

### 체크 5. 자동화 전 수동 1건씩 확인했는가

- 게시물 분류 수동 1건
- 게시물 삭제 수동 1건
- 댓글 삭제 수동 1건
- IP 차단 수동 1건

이 단계를 건너뛰고 바로 자동화로 가면,  
실패 원인이 `mini endpoint 차이`인지 `자동화 로직 문제`인지 분리가 안 된다.

---

## 12. 운영 주의점

### 12-1. 루트 확장과 mini 확장을 동시에 같은 타겟 페이지에 켜지 않는 것이 안전하다

이유:

- 둘 다 같은 페이지에서 분류/삭제/차단을 동시에 때리면 중복 처리될 수 있다

예시:

- 루트 특궁도 ON
- mini 특궁도 ON
- 같은 미니갤 페이지에서 둘 다 동작

이 상태는 피하는 게 좋다.

### 12-2. 1차는 “빠르게 분리판 만들기”가 목표다

이번 단계에서 하지 않는 것:

- minor/mini 공통 코어 추출
- 단일 확장에서 갤 종류 드롭다운 공통화
- shared module 재편

그건 미니판이 실제로 안정화된 다음에 해도 늦지 않다.

---

## 13. 최종 정리

이번 0423 기준 결론은 아래와 같다.

1. `특궁-mini`는 **별도 확장으로 분리**하는 것이 맞다
2. 위치는 `projects/dc_defense_suite_mini` 가 가장 안전하다
3. 초기에는 `manifest.json`, `background/`, `features/`, `popup/`, `icons/`, `data/`를 같이 복제하면 된다
4. 현재 코드에는 `mgallery` + `galleryType: 'M'` + minor 관리 endpoint 전제가 넓게 박혀 있다
5. 거기에 더해 `thesingularity` 기본값과 shared 설정 fallback도 여러 군데 박혀 있다
6. 그리고 matcher가 번들 dataset JSON을 `data/`에서 직접 읽으므로 `data/`도 런타임 복제 대상이다
7. 그래서 Local 수집 하나만 고치는 방식보다 mini 전용 분리판이 훨씬 맞다
8. public `MI` 값과 `/mini/board/...` surface는 확인됐지만, 관리 AJAX endpoint와 referer는 mini 실제 요청을 한 번 더 캡처한 뒤 확정해야 한다

쉽게 한 문장으로 끝내면:

- **지금은 루트 특궁을 건드리지 말고, `projects/dc_defense_suite_mini`를 만들어 미니 전용으로 빠르게 붙이는 게 정답이다.**

---

## 14. 0423 실제 패치 후 정적 검증 기록

이번 절은 "설계 문서"가 아니라,  
실제로 mini 분리판을 만든 뒤 다시 코드와 대조해서 적은 검증 메모다.

쉽게 말하면:

- 어디까지는 코드상 확정
- 어디부터는 실제 mini 관리자 계정으로 1건 확인이 필요한지

를 분리해서 적는다.

### 14-1. 이번에 코드상 확정된 것

아래는 실제 mini 분리판 코드에서 다시 확인한 내용이다.

- `manifest.json` 이름이 `DC Defense Suite Mini` 로 바뀌었는가
- popup 제목/문구/placeholder/default gallery가 mini 기준으로 바뀌었는가
- session broker 기본 갤러리 ID가 `ryosanzirai2` 인가
- session broker의 목록 확인 URL이 `/mini/board/lists/` 를 쓰는가
- 게시물 API 기본 `galleryType` 이 `MI` 인가
- 댓글 API 기본 `galleryType` 이 `MI` 인가
- IP 차단 API 기본 `galleryType` 이 `MI` 인가
- 개념글 monitor/patrol 기본 `galleryType` 이 `MI` 인가
- Local/Dataset/댓글 reflux 수집 URL이 `/mini/board/...` 를 쓰는가
- shared save 이후 scheduler에 퍼지는 `galleryId` 가 mini 확장 기본 흐름과 충돌하지 않는가

예시:

- 예전 minor 전용판에서는
  - 게시물을 mini URL로 열더라도
  - 댓글 삭제 referer가 `/mgallery/board/view/` 로 남을 수 있었다
- 지금 mini 분리판에서는
  - 댓글 조회/삭제/차단 referer가 `/mini/board/view/` 로 맞춰져 있다

### 14-2. 잔존 minor 문자열 재검색 결과

mini 분리판 런타임 코드에서 아래 문자열을 다시 검색했다.

- `thesingularity`
- `/mgallery/board/lists/`
- `/mgallery/board/view/`
- `galleryType: 'M'`
- `galleryType: "M"`
- `특갤`
- `마이너`

결과:

- 런타임 코드 기준 잔존 매치 없음
- 즉 public surface 기준으로는 `minor 기본값 잔존`이 다시 보이지 않았다

주의:

- `/mgallery/management/...` 문자열은 일부 남아 있다
- 하지만 이건 active fetch target이 아니라 **관리 페이지 shape-check 호환 fallback** 용도다

예시:

- `mini 관리 HTML` 이 정상으로 오면 그대로 통과
- 혹시 디시가 내부적으로 `mgallery 관리 경로`를 섞어서 보여주는 경우도 버티도록 fallback marker를 같이 둔 상태다

### 14-3. caller / 설정 전파 재검증 결과

이번엔 "파일 한 개만 고쳤는가"가 아니라  
"그 파일을 호출하는 쪽이 다시 예전 값을 덮어쓰지 않는가"를 봤다.

검증 포인트:

- popup shared save는 여전히 `galleryId`, `headtextId` 만 저장한다
- background `applySharedConfig()` 도 `galleryId`, `headtextId` 만 scheduler에 퍼뜨린다
- 대신 mini 분리판의 각 feature API 기본값이 이미 `galleryType: 'MI'` 로 바뀌어 있다

즉 현재 mini 분리판 구조에서는:

- shared save가 `galleryType` 을 직접 안 만져도
- 기본 API 값이 이미 `MI` 라서
- `ID만 mini로 저장되고 type은 M으로 남는` 흐름이 루트판보다 훨씬 작다

예시:

- 사용자가 공통 설정에서 `ryosanzirai2` 를 저장함
- background가 comment/post/ip/concept scheduler의 `galleryId` 를 전부 바꿈
- 각 scheduler가 실제 호출할 때는 자기 API 기본값 `MI` 를 그대로 씀
- 그래서 `mini ID + minor type` 조합으로 새로 어긋날 가능성이 줄어든다

### 14-4. data/ 번들 의존성 재확인

`data/` 는 그냥 참고 파일이 아니라 런타임 의존성이다.

실제 검증한 이유:

- 게시물 matcher 계열은 번들 dataset을 `data/...json` 에서 직접 읽는다
- 그래서 `data/` 누락 시 UI는 살아도 matcher 준비가 실패할 수 있다

예시:

- mini 확장에 `features/` 만 복제함
- popup은 뜸
- 그런데 게시물 분류가 matcher를 로드하려는 순간 `data/reflux-title-set-unified.json` 이 없음
- 결과적으로 "켜지긴 켜지는데 탐지 성능만 이상한" 반쯤 죽은 상태가 된다

그래서 이번 검증 기준으로는:

- `data/` 복제는 선택이 아니라 필수로 본다

### 14-5. 34개 정적 엣지케이스 점검 목록

이번 턴에서 다시 본 정적 케이스는 총 34개다.

#### 묶음 A. 기본값 / fallback / seed (6개)

1. popup title이 mini용으로 보이는가
2. popup subtitle이 mini 운영 설명으로 바뀌었는가
3. overlay placeholder가 `/mini/board/view/` 예시인가
4. shared gallery 기본값이 `ryosanzirai2` 인가
5. popup 상태 동기화 fallback이 `thesingularity` 로 돌아가지 않는가
6. session broker 기본 gallery seed가 `ryosanzirai2` 인가

#### 묶음 B. shared 설정 전파 (5개)

7. shared save가 빈 `galleryId` 를 막는가
8. shared save가 공백 포함 ID를 막는가
9. shared save가 `headtextId` 숫자 검증을 유지하는가
10. `applySharedConfig()` 가 comment/post/ip/concept 관련 scheduler에 galleryId를 모두 퍼뜨리는가
11. gallery 변경 시 각 scheduler 상태 reset 로그/초기화가 이어지는가

#### 묶음 C. session / login / DOM 감지 (6개)

12. session check list URL이 `/mini/board/lists/` 인가
13. login redirect target도 mini list로 가는가
14. logout redirect target도 mini list로 가는가
15. session check tab hash 유지로 기존 탭 재사용이 깨지지 않는가
16. 관리자 버튼 selector가 `/mini/management?id=` 를 우선 잡는가
17. mgallery selector는 fallback로만 남아 있는가

#### 묶음 D. 게시물 / 댓글 / IP / 신문고 체인 (9개)

18. 게시물 목록 fetch가 `/mini/board/lists/` 인가
19. 게시물 분류 body의 `_GALLTYPE_` 가 `MI` 인가
20. 게시물 삭제 body의 `_GALLTYPE_` 가 `MI` 인가
21. 댓글 목록 fetch가 `/mini/board/lists/` 인가
22. 댓글 view fetch와 referer가 `/mini/board/view/` 인가
23. 댓글 삭제 body의 `_GALLTYPE_` 가 `MI` 인가
24. 댓글 삭제+차단 body의 `_GALLTYPE_` 가 `MI` 인가
25. 게시물 IP 차단용 board list가 `/mini/board/lists/` 인가
26. 관리 block list가 `/mini/management/block` 인가

#### 묶음 E. 개념글 / 수집기 / parser / data 의존성 (8개)

27. concept list fetch가 `/mini/board/lists/` 인가
28. concept view fetch가 `/mini/board/view/` 인가
29. concept management page fetch가 `/mini/management/gallery` 인가
30. concept management referer도 mini 관리 경로인가
31. management gallery shape-check가 mini marker를 통과시키는가
32. han-refresh parser가 `/mini/management/block` marker를 인정하는가
33. dataset collector page locator가 mini list URL을 만드는가
34. comment/dataset overlay collector가 mini list/view URL을 쓰는가

추가로 이번 재검증 중 실제 수정한 항목:

- `sinmungo-comment/api.js` 내부 페이지 파서 fallback이 원래 `|| 'M'` 으로 남아 있었음
- 이 상태면 mini 페이지에서 `_GALLTYPE_` hidden input 파싱이 실패했을 때만 조용히 minor 타입으로 내려갈 수 있음
- mini 분리판에서는 이를 `DEFAULT_CONFIG.galleryType` fallback으로 바꿔 `MI` 로 맞춤

### 14-6. 지금도 남아 있는 리스크

여기서 제일 중요하다.

코드상으로는 많이 정리됐지만, 아래는 아직 "실제 mini 관리자 계정"으로 1건씩 찍어봐야 최종 확정된다.

- 게시물 분류 POST endpoint/referer
- 게시물 삭제 POST endpoint/referer
- 댓글 삭제 POST endpoint/referer
- IP 차단 POST endpoint/referer

이유:

- public mini HTML에서는 `_GALLTYPE_='MI'`, `/mini/board/...` 가 이미 확인됐다
- 게시물 분류는 실제 요청 캡처 기준으로 `/ajax/mini_manager_board_ajax/chg_headtext_batch` 가 확인됐다
- 게시물 삭제는 실제 요청 캡처 기준으로 `/ajax/mini_manager_board_ajax/delete_list` 가 확인됐다
- 댓글 삭제는 실제 요청 캡처 기준으로 `/ajax/mini_manager_board_ajax/delete_comment` 가 확인됐다
- 게시물 삭제+IP 차단은 실제 요청 캡처 기준으로 `/ajax/mini_manager_board_ajax/update_avoid_list` 가 확인됐다
- 하지만 관리자 AJAX는 디시가 `minor_manager_board_ajax` 와 `managements_ajax` 를 혼용하는 부분이 있어
- "mini도 같은 endpoint를 받되 `_GALLTYPE_=MI` 만 바꾸면 되는지"
- 아니면 "mini 관리자 referer / endpoint가 일부 다르게 요구되는지"

는 실제 요청 1건이 제일 정확하다

쉽게 예시를 들면:

- 코드상으로는 `delete_comment + _GALLTYPE_=MI + mini view referer`
- 이 조합이 논리상 맞아 보인다
- 그런데 디시 서버가 mini에서는 다른 referer를 강제하면
- 이건 정적 검증만으로는 못 잡는다

즉 현재 상태를 한 문장으로 요약하면:

- **public surface와 기본 config 전파는 정적으로 많이 정리됐고**
- **관리 AJAX 최종 규약만 실측 1건이 더 필요하다**
