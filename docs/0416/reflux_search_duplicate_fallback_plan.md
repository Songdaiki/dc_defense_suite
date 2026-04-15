# 역류기 게시물 검색 API 중복 메인 계획

## 1. 목표

현재 게시물 역류기 방어는 `dataset exact-match`에는 강하다.

하지만 공격자가:

- 최근 갤 제목을 새로 긁어서 쓰거나
- dataset에 아직 안 들어간 제목을 쓰거나
- 예전에 갤에 있었지만 현재 검색 노출/수집 상태가 애매한 제목을 쓰면

`dataset`만으로는 빈 구간이 생긴다.

그래서 이번 기능의 핵심은:

- **잡는 기준은 검색 기반 duplicate를 메인으로 두고**
- **dataset은 빠른 로컬 보조 판정과 옛 데이터 보강용으로 유지하는 것**

이다.

최종 판정식은 이렇게 본다.

`reflux = searchDuplicateMatch || datasetMatch`

쉽게 예시로:

- 현재 새 유동글 제목: `덕 테이프 버전별 차이가 뭐임?`
- 이 제목이 dataset에는 아직 없음
- 그런데 통합검색 결과에 **검색 기준 갤(기본값은 현재 갤)**의 과거 동일 제목 글이 있음
- 그러면 이 새 글은 역류 후보다

반대로:

- 통합검색에는 안 잡히는데
- 예전에 미리 합쳐 둔 dataset에는 있음
- 그러면 그건 dataset 보강 매치로 역류 후보다

중요:

- **판정 커버리지 기준 메인은 검색 duplicate다**
- **실행 순서 기준으로는 로컬 cache/dataset을 먼저 본다**
- 즉 `무엇이 더 많이 잡히는가`와 `무엇을 먼저 확인해 부하를 줄이는가`는 다른 문제다
- 이번 1차 범위는 **수동 게시글 분류에서 역류기 수동토글 ON일 때만** 붙인다
- monitor child run까지 한 번에 확장하지 않고, **수동 역류기 모드 한정**으로 시작한다

---

## 2. 왜 바로 붙이면 위험한가

어려운 이유는 기능이 불가능해서가 아니라, **검색 요청 형태를 잘못 잡으면 무거워지기 때문**이다.

현재 댓글 방어는 겉보기엔 빠르지만 실제 구조가 가볍다.

- 목록 조회 횟수가 적고
- 댓글 있는 글만 대상으로 삼고
- 공식 댓글 JSON API를 쓰고
- 삭제/차단은 batch로 모은다

처음에는 통합검색 `document HTML`만 보였기 때문에:

- `제목 1개 = 검색 결과 document HTML 1회`

구조가 된다.

예시:

- 새 제목 12개가 보였다
- 제목마다 바로 통합검색을 치면 document 요청 12회다

이건 댓글 방어와 같은 느낌으로 보면 안 된다.

하지만 추가 확인 결과, 지금은 더 좋은 후보가 보인다.

- `https://search.dcinside.com/ajax/getSearch/...`
- JSONP 형태
- `board_id`, `title`, `url`, `url_param.no`, `gall_name`, `datetime` 제공

즉 이번 설계의 핵심은:

1. **판정 메인은 검색 duplicate로 잡되**
2. **메인 분류 루프에서 검색을 직접 await하지 않고**
3. **queue + cache + single worker로 검색 요청을 브로커화하고**
4. **dataset과 search-confirmed cache로 먼저 최대한 소화한 뒤**
5. **정말 모르는 제목만 천천히 검색하되, 1차는 `getSearch JSONP`를 우선 쓰는 것**

이다.

즉 정리하면:

- 방어 커버리지의 메인: `검색 duplicate`
- 런타임 부하 제어의 메인: `cache/dataset shortcut`
- 네트워크 주 경로: `getSearch JSONP`
- 무거운 HTML 검색: `연구 참고용`이며 런타임 사용 대상이 아님

이다.

---

## 3. 현재 실제 코드 구조

### 3.1 게시물 분류 루프

현재 게시물 분류는:

1. 목록 HTML 조회
2. 유동 글 파싱
3. 제목 추출
4. attack mode 필터
5. 도배기 분류

핵심 위치:

- 시작 시 dataset 로드: [semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L33)
- 목록 조회: [api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L100)
- 제목 파싱: [parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L104)
- 메인 루프: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L337)
- 유동 후보 추출: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L350)
- 역류기 dataset 필터 적용: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L357)
- 실제 도배기 분류: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L384)

즉 지금은:

- `hasSemiconductorRefluxTitle(post.subject)`

만 통과하면 역류기 후보로 잡는다.

문제는:

- dataset에 없는 최근 제목
- dataset에 아직 반영 안 된 제목

은 여기서 바로 빠진다는 점이다.

### 3.2 현재 수동 역류기 토글 경로

이번 1차에서 중요한 건 monitor가 아니라 **수동 게시글 분류 토글**이다.

현재 수동 게시글 분류는:

- 팝업 `역류기 공격` 토글을 켜면 바로 `start({ source: 'manual', attackMode: 'semiconductor_reflux' })`를 보낸다
- 실행 시 `source === 'manual'`인지 확인하고
- 현재 코드는 수동 역류기 모드면 dataset 준비 상태를 검사한다
- 저장 버튼은 현재 `minPage`, `maxPage`, `requestDelay`, `cycleDelay`만 저장한다
- 즉 **현재는 역류 검색 기준 갤을 따로 저장할 자리가 없다**

핵심 위치:

- 팝업 일반 시작 토글: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1446)
- 팝업 역류기 quick 토글: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1467)
- 팝업 저장 버튼: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1469)
- 공통 설정 저장: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L441)
- 수동 attack mode 기본 설정: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L68)
- 수동 실행 옵션 정규화: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L564)
- 수동 역류기 dataset 준비 확인: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L541)
- 현재 effective attack mode 계산: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L219)
- 공통 갤 ID를 모든 기능에 같이 반영: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1007)

즉 이번 문서 기준 연결 대상은:

- **수동 게시글 분류 + 역류기 토글 ON**

뿐이다.

중요:

- 현재 UI 계약은 "`역류기 토글` = 저장된 모드 선택"이 아니라 "**즉시 실행용 quick toggle**"이다
- 그래서 1차 패치도 이 UX를 유지하는 게 맞다
- 나중에 persistent selector UI를 따로 만들기 전까지는, 이번 기능 설명도 quick toggle 기준으로 써야 한다
- 또 현재 [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L541)는 dataset이 비어 있으면 start를 막는데,
- 이번 문서 논리대로라면 **search duplicate가 메인 축이므로 이 시작 가드는 완화 대상**이다
- 즉 1차 패치에서는 "`dataset 비어 있음` = 시작 불가" 대신,
- "`검색 모듈/권한은 준비돼 있다고 보고 시작은 허용하고, dataset은 있으면 보조 사용`" 쪽으로 정리해야 논리 일치가 맞다
- 시작 시점에 search live preflight를 한 번 더 치는 구조는 불필요하며, 실제 검색 실패는 broker 로그/캐시 상태에서 다루는 게 맞다

### 3.2.1 왜 `refluxSearchGalleryId`를 공통 설정에 두면 안 되는가

현재 공통 설정의 `galleryId`는 의미가 분명하다.

- 목록을 어디서 읽을지
- 삭제/분류를 어느 갤에 적용할지
- 다른 자동화들이 어느 갤을 볼지

실제 경로:

- 공통 설정 입력: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L441)
- 공통 설정 저장 메시지: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L468)
- background 적용: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L423)
- 모든 feature의 `galleryId` 일괄 변경: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1029)

즉 지금 공통 `galleryId`는:

- **삭제/분류 대상 갤**

이다.

그런데 네가 말한 케이스는 다르다.

- 삭제 대상 갤: `thesingularity`
- 검색 기준 갤: `galaxy`

이 경우 공통 `galleryId`에 `galaxy`를 넣으면 안 된다.
왜냐면 그러면 특갤 삭제가 아니라 **목록 조회 자체가 galaxy로 바뀌기 때문**이다.

그래서 1차 패치에서 필요한 건:

- `post.config.galleryId`: 삭제/분류 대상 갤
- `post.config.refluxSearchGalleryId`: 역류 검색 기준 갤

두 값을 분리하는 것이다.

UI도 공통 설정이 아니라:

- **게시글 분류 탭 설정 영역**에 `refluxSearchGalleryId` 입력란 추가

가 맞다.

권장 UX:

- 라벨: `역류 검색 갤 ID`
- 도움말: `비우면 공통 갤 ID 사용`

즉 기본값은 기존 동작과 같고,
필요할 때만 다른 갤 기준 duplicate를 켤 수 있게 한다.

설정 저장 경로도 분리하는 게 맞다.

- 공통 설정 `updateSharedConfig`에는 넣지 않는다
- 게시글 분류 `updateConfig`에만 넣는다

즉 영향 범위는:

- **post feature 한정**

이어야 한다.

여기서 실제 구현 때 빠지기 쉬운 연결 포인트가 있다.

- post DOM 바인딩: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L255)
- 저장 버튼: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1467)
- post UI 상태 반영: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2442)
- post dirty tracking 입력 목록: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3353)

현재 실제 코드는:

- `FEATURE_DOM.post`에 기존 4개 input과 quick toggle만 연결돼 있다
- 저장 버튼이 `minPage`, `maxPage`, `requestDelay`, `cycleDelay`만 `updateConfig`로 보낸다
- `updatePostUI(...)`도 저 4개만 다시 input에 채운다
- `getFeatureConfigInputs('post')`도 저 4개만 dirty tracking 대상으로 본다

즉 문서대로 패치하려면 **연결 포인트 여러 군데를 같이 바꿔야 한다.**

1. popup HTML에 input 추가
2. `FEATURE_DOM.post`에 DOM ref 추가
3. 저장 payload에 `refluxSearchGalleryId` 추가
4. `updatePostUI(...)`의 `syncFeatureConfigInputs('post', ...)`에 같은 값 추가
5. `getFeatureConfigInputs('post')`에도 같은 input 추가

쉽게 예시로:

- 입력칸만 추가하면 저장이 안 될 수 있다
- HTML에만 추가하고 `FEATURE_DOM.post`에 안 꽂으면 JS에서 항상 `undefined`가 된다
- 저장만 되게 하면 새로고침 후 input에 값이 안 보일 수 있다
- dirty tracking에 안 넣으면 값을 바꿔도 저장 버튼 상태가 어색할 수 있다

입력 검증도 같이 분리하는 게 맞다.

- 빈값: 허용
- 값이 있으면: `영문/숫자/밑줄`만 허용

즉 popup 선검증 + background 재검증을 둘 다 둬야 한다.

실행 중 변경 원칙도 같이 정리해 두는 게 좋다.

- `refluxSearchGalleryId` 변경 시 comment/ip/monitor는 건드리지 않는다
- post 수동 역류기 실행 중이었다면, runtime search queue/hotset을 비우고 첫 페이지부터 다시 스캔한다
- cutoff 없는 narrow mode라는 현재 성질은 그대로 유지한다

여기서 한 가지 더 중요하다.

- 현재 background의 running post 특례는 [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L649)에서 `manualAttackMode` 변경만 별도 처리한다
- 즉 `refluxSearchGalleryId`만 바꾸면 지금 구조상 그냥 `scheduler.config`에 merge되고 끝날 가능성이 높다

그래서 1차 패치에는 반드시 아래 둘 중 하나가 들어가야 한다.

1. `maybeHandleRunningPostModeTransition(...)`를 확장해서 `refluxSearchGalleryId` 변경도 런타임 전환으로 처리
2. 또는 post 전용 `maybeHandleRunningPostSearchTargetTransition(...)` 같은 별도 hook 추가

핵심은 **실행 중 config merge만 하고 runtime queue/hotset을 그대로 두는 구조는 틀리다**는 점이다.

### 3.3 monitor 연동은 왜 1차에서 제외하는가

monitor는 샘플 유동글 제목을 보고 역류기 공격 여부를 판단한 뒤 child post scheduler를 실행한다.

관련 위치:

- attack mode helper: [attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L84)
- 역류기 샘플 매치: [attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L97)
- 역류기 모드 진입 후 child post scheduler 시작: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L435)

여기까지 같이 묶으면 한 번에 검증해야 할 게 늘어난다.

- 검색 queue 상태
- child scheduler 재시작 시 cache 인계
- attack/recover 전환 시점

그래서 1차는:

- **수동 역류기 토글 ON 시에만 검색 duplicate 판정 적용**

으로 범위를 제한하는 게 맞다.

### 3.4 현재 dataset 로더의 역할

게시물/댓글 공용 역류 dataset은 현재:

- `data/reflux-title-set-unified.json`

를 읽는다.

핵심 위치:

- 번들 dataset 경로: [semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L20)
- normalized set 매치: [semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L176)

여기서 dataset 역할은 이제 이렇게 정의하는 게 맞다.

1. 검색 전에 빠르게 local hit를 내는 shortcut
2. 통합검색에 잘 안 잡히는 옛 제목 보강
3. search-confirmed 결과를 장기적으로 흡수하기 전까지의 방어 버퍼

즉 dataset은 버리는 게 아니라,

- **메인 커버리지를 맡는 통합검색을 보조하는 로컬 세트**

로 본다.

중요:

- 현재 [semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L167)의 `hasSemiconductorRefluxTitle(title)`은 `galleryId`를 받지 않는다
- 즉 **기존 dataset exact-match는 갤러리 무관 통합 세트 매치**다
- 이번 1차 패치도 이 기존 dataset 동작은 그대로 유지하는 게 맞다
- 대신 새로 추가하는 **search positive cache / duplicate 판정만 검색 기준 갤(`refluxSearchGalleryId`) 기준으로 스코프**를 잡아야 한다

---

## 4. HTML 스펙 확인 결과

### 4.1 현재 게시판 목록 HTML

현재 글 제목은 목록 HTML에서 이미 안정적으로 뽑고 있다.

문서 기준 예시:

- row: [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L1670)
- 제목 anchor: [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L1675)
- writer/ip: [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L1680)

예시 제목:

- `덕 테이프 버전별 차이가 뭐임?`

즉 현재 방어 대상 제목 추출은 이미 해결돼 있다.

### 4.2 갤 내부 검색 HTML

갤 내부 검색 결과는 일단 HTML만으로도 충분히 읽힌다.

문서 기준 예시:

- 갤 검색 파라미터: [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L1458)
- 검색 결과 링크: [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L1548)
- 다음 검색 링크: [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L2009)

즉 HTML만으로도:

1. 결과 제목
2. 결과 링크
3. `id`, `no`
4. `search_pos`

정도는 뽑을 수 있다.

다만 이 HTML 경로는 **런타임 방어 경로로는 사용하지 않는다**.
이유는 요청량이 조금만 늘어도 IP 차단 리스크가 커지기 때문이다.

### 4.3 실제로 찾은 검색 결과 API

갤 검색 페이지 스크립트를 다시 확인한 결과, 결과 데이터용으로 쓸 만한 경로가 보였다.

- `GET https://search.dcinside.com/ajax/getSearch/p/{page}/n/20/q/{keyword}?jsoncallback=?`
- 페이지 내 함수 `ajax_list_search(page)`가 사용
- 응답은 JSONP

실제 확인된 응답 필드:

1. `board_id`
2. `title`
3. `url`
4. `url_param.id`
5. `url_param.no`
6. `gall_name`
7. `datetime`

즉 이 API가 있으면:

- 굳이 document HTML 전체를 다시 받아서 파싱하지 않아도 되고
- `board_id === searchTargetGalleryId`로 바로 **검색 기준 갤 일치 여부**를 확인할 수 있다
- 여기서 `searchTargetGalleryId`는 삭제 대상 갤이 아니라 **역류 검색 기준 갤(`refluxSearchGalleryId`)**로 보는 게 맞다

쉽게 예시로:

- 현재 새 글: `thesingularity / #1110282 / 씨드림 5.0 좆된거 아니냐? ㅋㅋ`
- 검색 결과 item: `thesingularity / #1108445 / 씨드림 5.0 좆된거 아니냐? ㅋㅋ`

그러면:

- 같은 갤
- 같은 제목
- 다른 글번호

이므로 duplicate 양성이다.

즉 여기서는:

- `통합검색으로 어떤 갤인지 본 뒤 다시 갤내검색`

이 아니라

- **`getSearch` 한 번 호출 후 `board_id` 필터**

가 더 낫다.

### 4.4 `gallery_search_log`와 `search_date`의 의미

검색 관련 보조 요청도 확인됐다.

- `gallery_search_log/`
- `/ajax/search_ajax/search_date/`

해석은 이렇게 두는 게 맞다.

- `gallery_search_log/`는 결과 데이터가 아니라 로그용에 가깝다
- `search_date/`는 특정 날짜에 대응하는 `search_pos` 계산 helper다

직접 확인한 결과:

- `search_date/` 응답은 `{"result":"success","data":"-1092471"}` 같은 형태였다
- 즉 결과 목록을 주는 API가 아니라 위치 계산용이다

따라서 1차 주 경로는:

- `getSearch JSONP`

가 맞고,

- `gallery_search_log/`
- `search_date/`
- document HTML

은 각각 로그/보조 helper/연구 참고용으로 분리해서 봐야 한다.

### 4.5 HTML 경로를 왜 런타임에서 버리는가

Network 캡처 기준으로 통합검색 결과는 별도 result API가 아니라
**메인 document HTML 전체**가 내려온다.

실무적으로 확인된 사실:

- 응답 `Type`: `document`
- 응답 `Content-Type`: `text/html; charset=UTF-8`
- 응답 body는 [html(통합).md](/home/eorb915/projects/dc_defense_suite/docs/html(통합).md)처럼 **문서 전체 HTML**

즉 구현 관점에서 이 경로는:

- 스펙 확인용
- 수동 분석용

으로만 두고,

- **runtime duplicate 판정 경로에서는 제외**

하는 게 맞다.

---

## 5. 이번 1차 구현 범위

이번 1차 범위는 **작고 안전하게** 간다.

### 포함

- **수동 게시글 분류에서 역류기 토글 ON일 때만** 검색 duplicate 판정 추가
- `getSearch` 응답 parser 추가
- 검색 queue/cache 브로커 추가
- search-confirmed positive cache 추가
- 현재 글 자기 자신 제외 로직 추가
- manifest host permission에 `search.dcinside.com` 추가

### 제외

- 평시 default 모드에서 모든 유동글 검색
- monitor child run에 search duplicate 붙이기
- 댓글 방어에 검색 duplicate 붙이기
- popup에 복잡한 검색 통계/설정 UI 추가
- 여러 검색 worker 병렬화
- live set과 search duplicate를 같은 1차 패치에서 동시에 넣기
- 갤 검색 HTML 런타임 사용
- 통합검색 HTML 런타임 사용

즉 이번 문서 기준 1차 목표는:

- **수동 역류기 토글 ON일 때만**
- **search-confirmed cache를 우선 재사용하고**
- **dataset으로 빠른 local shortcut을 보고**
- **정말 모르는 제목만 queue로 보내고**
- **`getSearch` 기반 duplicate를 최종 커버리지 메인으로 쓰는 것**

이다.

---

## 6. 권장 아키텍처

### 6.1 새 모듈 구성

권장 파일:

- `features/post/reflux-search-duplicate-parser.js`
- `features/post/reflux-search-duplicate-broker.js`

#### A. parser

역할:

- `getSearch JSONP` 응답에서 게시물 result를 파싱
- JSONP wrapper를 벗기고 payload를 안전하게 파싱
- callback 이름이 고정 문자열이라고 가정하지 않고, 첫 `(`와 마지막 `)` 기준으로 wrapper를 벗긴다
- `title`의 `<b>...</b>` 강조 태그를 제거한 뒤 제목만 남김
- `&amp;`, `&quot;` 같은 HTML entity도 디코드해서 실제 제목 문자열로 맞춘다
- 제목 정규화는 [attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L69)의 `normalizeSemiconductorRefluxTitle`를 그대로 재사용
- `url_param.no`는 문자열/숫자 혼용에 대비해 숫자로 안전하게 변환
- 각 row마다 아래 정보 반환

반환 예시:

```js
{
  title: '씨드림 5.0 좆된거 아니냐? ㅋㅋ',
  normalizedTitle: '씨드림 5.0 좆된거 아니냐? ㅋㅋ',
  boardId: 'thesingularity',
  galleryName: '특이점이 온다',
  postNo: 1108445,
  href: 'https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1108445',
  datetime: '2026.04.15 04:15'
}
```

#### B. broker

역할:

- 검색 결과 캐시
- pending queue
- 단일 worker
- delay + jitter
- cache hit 즉시 응답
- cache miss는 background에서 천천히 조회
- 주 요청은 `getSearch JSONP`
- 검색 요청도 [dc-session-broker.js](/home/eorb915/projects/dc_defense_suite/background/dc-session-broker.js#L418)의 `withDcRequestLease(...)` 아래에서 실행
- 실제 fetch 옵션도 기존 post/comment API와 마찬가지로 `credentials: 'include'` + `lease.signal` 전달을 기준으로 잡는 게 안전하다

즉 post scheduler는 검색을 직접 때리지 않고,

- `이 제목이 이미 duplicate로 확인됐는가`

만 broker에 묻는 구조로 가야 한다.

#### C. duplicate 판정 helper

핵심 조건은 이 세 개다.

1. `boardId === searchTargetGalleryId`
2. `normalizeSemiconductorRefluxTitle(result.title) === normalizeSemiconductorRefluxTitle(currentTitle)`
3. `searchTargetGalleryId === deleteTargetGalleryId`일 때만 `result.postNo !== currentPostNo`

쉽게 실제 예시로:

- 삭제 대상 글: `thesingularity / #1110282 / 씨드림 5.0 좆된거 아니냐? ㅋㅋ`
- 검색 기준 갤: `thesingularity`
- 검색 결과: `thesingularity / #1108445 / 씨드림 5.0 좆된거 아니냐? ㅋㅋ`

그러면 duplicate 양성이다.

반대로:

- 검색 결과가 `#1110282` 자기 자신이면 제외

여기서 `postNo 다름` 체크가 필수다.

하지만 분리 케이스에서는 조건이 달라진다.

- 삭제 대상 글: `thesingularity / #1110282 / 같은 제목`
- 검색 기준 갤: `galaxy`
- 검색 결과: `galaxy / #1110282 / 같은 제목`

이건 다른 갤 결과이므로 자기 자신이 아니다.
즉 **검색 기준 갤과 삭제 대상 갤이 다를 때는 `postNo` 같음만으로 제외하면 안 된다.**

정리:

- **같은 갤 검색**: exact title + same board + different postNo
- **다른 갤 검색**: exact title + same search board

### 6.2 캐시 구조

storage key 예시:

- `refluxSearchDuplicateCacheState`

entry 예시:

```js
{
  cacheKey: 'galaxy::씨드림 5.0 좆된거 아니냐? ㅋㅋ',
  deleteTargetGalleryId: 'thesingularity',
  searchTargetGalleryId: 'galaxy',
  normalizedTitle: '씨드림 5.0 좆된거 아니냐? ㅋㅋ',
  checkedAt: '2026-04-16T03:10:00.000Z',
  retryAt: '', // negative/error cooldown일 때만 사용
  result: 'positive', // positive | negative | error | pending
  matchedGalleryId: 'galaxy',
  matchedPostNo: 1108445,
  matchedHref: 'https://gall.dcinside.com/mgallery/board/view/?id=galaxy&no=1108445',
  source: 'getSearch'
}
```

권장 원칙:

- cache/hotset key는 **`searchGalleryId + normalizedTitle` 조합**으로 잡는다
- positive cache TTL: 길게
- negative cache TTL: 짧게
- pending는 런타임 전용
- error는 **짧은 retry cooldown**과 함께 보관

권장 초기값:

- positive TTL: `24시간`
- negative TTL: `60초`
- error retry cooldown: `30초`
- cache entry max count: `2000~5000`

이유:

- 같은 제목이라도 갤이 다르면 duplicate 정의가 달라진다
- search duplicate positive는 방어 가치가 높다
- negative는 나중에 검색 반영이 늦게 들어올 수 있으니 오래 믿으면 안 된다
- 특히 같은 제목이 반복될 때, 첫 검색 miss 뒤 몇십 초 내에 search가 따라붙을 수 있어서 negative TTL이 너무 길면 blind spot이 커진다
- 반대로 search 요청이 잠깐 실패할 때는 같은 제목을 매 사이클 다시 넣으면 안 되므로 error도 짧게 cooldown을 둬야 한다

쉽게 예시로:

- `thesingularity / "HBM4e B_die는 TSMC N5 or N3 둘중에 하나"` 양성
- `tsmcsamsungskhynix / "HBM4e B_die는 TSMC N5 or N3 둘중에 하나"`는 아직 미확인

이때 key를 제목만으로 잡으면:

- 특갤에서 확인한 positive가 반갤에도 그대로 새어 나간다

그래서 1차도 최소한:

- `cacheKey = ${searchGalleryId}::${normalizedTitle}`

형태로 가는 게 맞다.

여기서 `searchGalleryId`는:

- `post.config.refluxSearchGalleryId || post.config.galleryId`

로 계산하는 게 맞다.

즉:

- 입력을 비우면 기존처럼 삭제 대상 갤 기준 검색
- 입력을 채우면 그 갤 기준 검색

negative TTL 예시도 쉽게 보면:

- 03:00:00 첫 검색 miss
- 03:00:20 같은 제목이 또 올라옴
- 03:00:40 search에는 이제 과거/직전 글이 잡히기 시작함

이때 negative TTL이 `10분`이면:

- 03:10:00 전까지 재검색을 못 해서 너무 늦다

반대로 `60초`면:

- 03:01:00쯤 다시 검색 가능 상태가 되고
- 같은 제목 반복 공격을 따라잡을 수 있다

### 6.3 요청 제어

검색 브로커는 댓글 방어와 같은 "병렬 느낌"이 아니라,
**느리더라도 안전하게 제한된 흐름**으로 가야 한다.

즉:

- 메인 루프 inline 검색 금지
- 동시성 `1`
- 요청 간 랜덤 지연
- 같은 제목 재검색 금지
- 한 사이클 enqueue 수 제한
- 검색 요청도 `withDcRequestLease({ feature: 'post', kind: 'searchDuplicate' }, ...)` 아래에서만 실행
- 1차 구현은 **page 1만 조회**하고, 같은 제목이 page 2에만 있는 케이스는 추가 스펙 확보 뒤 확장한다

테스트 시작값:

- worker concurrency: `1`
- request base delay: `100ms`
- jitter: `30ms`
- 한 사이클 enqueue 최대 제목 수: `2~3개`

예시:

- 새 제목 9개 발생
- 그중 search-confirmed cache hit 2개
- dataset hit 1개
- 나머지 6개 중 중복 제거 후 3개
- 이번 사이클에서는 2개만 queue에 넣고 1개는 다음 사이클로 넘긴다

이렇게 해야 `제목 수만큼 즉시 검색`이 되는 걸 막을 수 있다.

여기서 핵심은:

- **계속 보이는 옛 제목을 매번 검색하는 구조가 아니어야 한다**
- **정규화 제목 기준으로 "처음 보는 제목"만 검색 후보가 된다**

즉 같은 제목이 30번 반복돼도:

- 첫 1번만 queue로 가고
- positive가 확인되면 이후 29번은 local positive hit로 끝난다

이게 요청 수를 줄이는 핵심이다.

추가로 1차는 아래 우선순위로 간다.

1. `getSearch JSONP`
2. local positive cache / hotset 재사용
3. dataset 보강
4. `getSearch` 응답은 그대로 기록해 두고 테스트 판단 자료로 본다

### 6.4 search-confirmed hotset

실제로는 dataset과 별도로 **런타임 search positive 세트**가 하나 더 있는 게 좋다.

예시:

- 어제 search duplicate로 잡힌 제목 A
- 오늘 같은 제목 A가 또 옴
- 그럼 굳이 다시 search하지 말고 local positive hotset에서 바로 역류 처리

즉 런타임 판정 순서는:

1. `search positive hotset / cache`
2. `dataset`
3. `unknown 제목만 queue`

으로 가는 게 좋다.

이 순서는 "dataset이 메인"이라는 뜻이 아니라,
**이미 알고 있는 로컬 정보부터 먼저 써서 검색 요청을 줄인다**는 뜻이다.

### 6.5 왜 요청 수가 실제로 줄어드는가

말만 cache라고 하면 감이 안 오기 쉬우니, 실제로는 아래 세 가지 때문에 줄어든다.

#### A. 같은 제목 중복 enqueue 금지

예시:

- 10초 동안 `HBM4e B_die는 TSMC N5 or N3 둘중에 하나`가 8번 올라옴

이때 하면 안 되는 방식:

- 글 8개를 보고 검색 8번

이번 구조:

- 첫 번째 제목만 queue 등록
- 나머지 7개는 `already pending`으로 추가 검색 안 함
- 검색 1번 결과가 positive면 이후는 전부 local positive 처리

즉:

- **같은 제목 8개 = 검색 1번**

이 된다.

#### B. 이미 양성 확인된 제목은 재검색 금지

예시:

- 새벽 2시에 제목 A를 검색 API로 확인해서 positive가 났다
- 새벽 3시에 제목 A가 또 올라왔다
- 새벽 4시에도 제목 A가 또 올라왔다

이때:

- 제목 A는 이미 `search positive cache/hotset`에 있으므로
- 3시, 4시에는 검색 0번
- 둘 다 local hit로 즉시 역류 처리

즉:

- **반복 공격일수록 검색 API 호출 횟수는 오히려 줄어든다**

#### C. 음성도 아주 짧게만 재사용

예시:

- 제목 B를 10:00에 검색했는데 아직 통합검색에 안 잡힘

그럼:

- 10:01에 또 같은 제목 B가 와도 바로 재검색하지 않고
- negative TTL 동안은 잠깐 보류

하지만:

- negative TTL이 지나면 다시 검색 가능 상태로 돌린다

이렇게 해야:

- 지금 막 검색에 안 뜬 제목을 같은 분 안에 계속 두드리지 않고
- 검색 반영이 조금 늦게 되는 경우도 나중에 다시 따라갈 수 있다

즉:

- **positive는 오래 기억**
- **negative는 짧게만 기억**

이 원칙이 필요하다.

### 6.6 시간축 예시

쉽게 실제 흐름으로 보면 이렇다.

#### 예시 1. 공격자가 같은 옛 제목 20개를 빠르게 도배

제목:

- `덕 테이프 버전별 차이가 뭐임?`

발생:

- 00초, 03초, 05초, 08초, 12초 ... 총 20개

잘못된 구조:

- 글 20개 -> 검색 20번

이번 구조:

1. 첫 글이 들어옴
2. hotset miss
3. dataset miss
4. queue 등록
5. worker가 검색 1번 수행
6. duplicate positive 확인
7. 제목이 hotset에 올라감
8. 이후 같은 제목 19개는 검색 없이 local hit

즉 결과는:

- **글 20개**
- **검색 1번**

이다.

#### 예시 2. 공격자가 서로 다른 최신 제목 10개를 섞어서 도배

제목:

- A, B, C, D, E, F, G, H, I, J

이 경우는 당연히 같은 제목 반복 공격보다 검색이 더 필요하다.

그래도 이번 구조는:

1. 한 사이클 enqueue 예산을 `2~3개`로 제한
2. 나머지는 다음 사이클로 넘김
3. 이미 queue에 있는 제목은 중복 등록 안 함
4. positive가 난 제목부터 local hotset 처리

즉:

- **새 제목 10개가 보여도 바로 검색 10번은 하지 않는다**
- **이번 사이클 2~3번만 검색하고, 나머지는 순차 소화한다**

이게 `검색 예산` 개념이다.

#### 예시 3. 옛날 제목이 며칠 뒤 다시 올라오는 경우

제목:

- `삼성 3나노 수율 결국 터졌네`

이 제목이 어제 positive였으면:

- 오늘 다시 올라와도 검색 없이 hotset/cache hit

만약 hotset은 메모리라 worker 재기동으로 날아갔어도:

- storage positive cache가 남아 있으면 재검색 없이 바로 처리 가능

그래서 persistent positive cache가 중요하다.

### 6.7 요약

`요청 수를 적게, 중복 없이, 캐시 중심으로`의 실제 뜻은 이거다.

1. **같은 제목은 한 번만 검색한다**
2. **positive가 난 제목은 다시 검색하지 않는다**
3. **negative도 짧게만 재사용해서 같은 분 안에 재검색 폭주를 막는다**
4. **모르는 제목도 한 사이클 예산만큼만 검색한다**
5. **그래서 반복 공격일수록 검색 수는 제목 수보다 훨씬 적어진다**

---

## 7. 실제 판정 로직

### 7.1 최종 판정 순서

수동 게시글 분류에서 `SEMICONDUCTOR_REFLUX` 토글이 켜졌을 때만 아래 순서로 간다.

1. 현재 제목 정규화
2. `search positive cache/hotset` 확인
3. hit면 즉시 역류
4. 없으면 `dataset exact-match` 확인
5. dataset hit면 즉시 역류
6. 둘 다 miss면 search broker cache 조회
7. cache positive면 역류
8. cache negative면 이번 사이클은 통과
9. cache pending이면 이번 사이클은 통과
10. cache error면 cooldown 동안은 통과
11. broker가 `shouldEnqueue(...) === true`라고 판단하는 miss/title만 queue에 넣고 이번 사이클은 일단 통과

즉 1차 구현은 **검색 결과를 기다리며 메인 루프를 멈추지 않는다.**

이유:

- 메인 루프를 검색 대기로 묶으면 분류 속도가 확 떨어진다
- 검색이 느리거나 실패하면 전체 방어가 흔들린다

쉽게 예시로:

- 제목 A: `thesingularity::제목A` search positive hotset hit -> 즉시 도배기 분류
- 제목 B: hotset miss, dataset hit -> 즉시 도배기 분류
- 제목 C: 둘 다 miss, broker cache positive -> 즉시 도배기 분류
- 제목 D: 둘 다 miss, broker cache miss -> 이번엔 queue만 넣고 다음 사이클부터 반영
- 제목 E: 직전 search error 기록이 있고 retry cooldown 안 지남 -> 이번 사이클 재요청 안 함

### 7.2 왜 이 구조가 맞는가

이 구조는 네가 말한 논리를 그대로 유지한다.

- **실제 커버리지 메인 = `getSearch` 기반 검색 duplicate**
- **dataset = 초반 로컬 확인용 + 옛 제목 보강**

즉:

- 잡는 논리는 `searchDuplicate OR dataset`
- 실행 순서는 `known local first, unknown search later`

다.

예시로 풀면:

- 최근 글을 공격자가 새로 긁어서 도배했다
- dataset에는 아직 없을 수 있다
- 그래도 `getSearch` 결과에 과거 글이 남아 있으면 search duplicate로 잡힌다

반대로:

- 너무 오래된 글이라 `getSearch` 결과에서 잘 안 보인다
- 그래도 dataset에 이미 넣어 둔 제목이면 local hit로 잡힌다

이 두 축을 같이 써야 빈틈이 줄어든다.

여기서 차이를 분리해서 이해해야 한다.

- **search duplicate**: 역류 검색 기준 갤(`refluxSearchGalleryId`) 기준
- **기존 dataset exact-match**: 현재 구현 그대로면 갤 무관 통합 세트 기준

즉 1차 패치 목적은:

- search 쪽을 좁고 안전하게 **검색 기준 갤 duplicate**로 두되
- 기존 dataset 보강 범위는 회귀 없이 유지하는 것

---

## 8. `searchDuplicateMatch` 정의

이번 1차 구현에서는 **역류 검색 기준 갤의 과거 동일 제목**만 duplicate로 인정하는 것을 권장한다.

이유:

- 현재 문제 정의가 "검색 기준 갤의 옛 제목을 새로 복붙해 올리는 경우"에 가깝다
- 다른 갤까지 다 열면 짧은 일반 제목 오탐이 급격히 늘 수 있다

즉 1차 duplicate 조건은:

1. `getSearch` 결과 제목 정규화가 현재 제목과 정확히 같음
2. 결과 링크의 `galleryId`가 현재 `refluxSearchGalleryId`와 같음
3. `refluxSearchGalleryId === deleteGalleryId`일 때만 결과 `postNo`가 현재 글 `postNo`와 달라야 함

쉽게 예시로:

- 삭제 대상 글: `thesingularity / #1110096 / 덕 테이프 버전별 차이가 뭐임?`
- 검색 기준 갤: `galaxy`
- 검색 결과:
  - `galaxy / #1110096 / 덕 테이프 버전별 차이가 뭐임?` -> 다른 갤 결과이므로 duplicate 인정 가능
  - `thesingularity / #1109157 / 덕 테이프 버전별 차이가 뭐임?` -> search target이 galaxy면 이번 판정에서는 제외

같은 갤 기준 검색일 때만:

- `thesingularity / #1110096 / ...` -> 자기 자신, 제외
- `thesingularity / #1109157 / ...` -> duplicate 인정

이게 1차로 가장 안전하다.

### 향후 확장

2차 이후에는 선택적으로 확장 가능하다.

- configured source gallery allowlist
- 같은 갤이 아니어도 특정 원본 갤 duplicate 인정

하지만 이건 1차에 넣지 않는 게 맞다.

---

## 9. scheduler 연결 방식

### 9.1 연결 위치

현재 연결 포인트는 여기다.

- [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L357)

지금은:

```js
const candidatePosts = basePosts.filter((post) => isEligibleForAttackMode(...))
```

이 구조인데, 이번 1차에서는 **수동 역류기 모드일 때만** 이 분기를 조금 세분화해야 한다.

권장 구조:

1. `DEFAULT`, `CJK_NARROW`는 기존 그대로
2. `SEMICONDUCTOR_REFLUX`라도 `currentSource !== 'manual'`이면 기존 dataset-only 유지
3. `SEMICONDUCTOR_REFLUX` + `currentSource === 'manual'`일 때만 별도 helper 사용

중요:

- 현재 [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L357)는 `Array.filter(...)` 기반 동기 분기다
- 반면 search broker는 `enqueue`, cache 조회, 로그 집계가 필요하다
- 그래서 1차 구현은 `isEligibleForAttackMode(...)`를 억지로 비동기로 바꾸는 방식보다,
- **수동 역류기 모드일 때만 별도 `filterRefluxCandidatePosts(...)` helper로 우회**하는 게 안전하다
- 즉 기존 `DEFAULT`, `CJK_NARROW`, monitor 흐름은 건드리지 않고, manual reflux branch만 분리한다
- 그리고 시작 전 readiness 체크도 같이 손봐야 한다
- 현재는 `assertManualAttackModeReady(...)`가 dataset 비어 있으면 예외를 던지는데,
- 이 체크는 [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L76)의 `start(...)`와 [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L234)의 `transitionManualAttackModeWhileRunning(...)` 양쪽에서 다 밟는다
- 1차 패치 뒤에는 **manual reflux 시작 자체는 허용하고, 실제 검색 실패는 broker/runtime 로그에서 처리**하는 쪽이 맞다
- 또 이 helper는 `deleteTargetGalleryId`와 `searchTargetGalleryId`를 둘 다 받아야 한다
- 기본값은 `searchTargetGalleryId = config.refluxSearchGalleryId || config.galleryId` 로 계산하면 된다

예시 helper:

```js
async function filterRefluxCandidatePosts(posts, context) {
  const immediateMatches = [];

  for (const post of posts) {
    const hotsetDecision = searchBroker.getPositiveDecision({
      searchGalleryId: context.searchGalleryId,
      title: post.subject,
    });
    if (hotsetDecision === 'positive') {
      immediateMatches.push(post);
      continue;
    }

    if (datasetHit(post.subject)) {
      immediateMatches.push(post);
      continue;
    }

    const cacheDecision = searchBroker.getDecision({
      searchGalleryId: context.searchGalleryId,
      title: post.subject,
    });
    if (cacheDecision === 'positive') {
      immediateMatches.push(post);
      continue;
    }

    if (searchBroker.shouldEnqueue({
      searchGalleryId: context.searchGalleryId,
      title: post.subject,
    })) {
      searchBroker.enqueue({
        deleteGalleryId: context.deleteGalleryId,
        searchGalleryId: context.searchGalleryId,
        postNo: post.no,
        title: post.subject,
      });
    }
  }

  return immediateMatches;
}
```

핵심:

- 메인 분류기 안에서 검색 fetch를 직접 await하지 않는다
- 수동 역류기 토글이 꺼져 있으면 search broker도 전혀 건드리지 않는다

### 9.2 로그

최소한 로그는 구분돼야 한다.

예시:

- `search duplicate cache 매치 2개`
- `dataset 보강 매치 1개`
- `search duplicate 신규 queue 2개`

이게 있어야 나중에 실제 운영 중:

- 왜 잡혔는지
- 왜 아직 안 잡혔는지
- 지금 search 메인이 실제로 얼마나 기여하는지

를 볼 수 있다.

### 9.3 broker lifecycle

실제 코드 기준으로 여기까지 확인해야 구조변경 후 파생 문제가 줄어든다.

관련 위치:

- post stop: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L116)
- post 상태 복원: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L471)
- scheduler 자동 복원 진입: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L186)
- worker resume 후 post 재기동: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L245)
- post resetStats: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L680)
- 공통 갤 변경 시 post 상태 초기화: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1057)

권장 원칙:

1. **stop 시 pending queue는 비우고 worker는 멈춘다**
2. **in-memory hotset/pending/error cooldown은 stop 시 비워도 된다**
3. **storage positive/negative cache는 stop/resetStats에서 지우지 않는다**
4. **공통 갤 변경 시 runtime queue/hotset은 비운다**
5. **service worker resume 시 storage cache는 다시 읽고, in-memory queue는 빈 상태에서 다시 시작한다**
6. **stop/설정변경 직전에 날아간 in-flight search 응답은 generation 토큰으로 무시한다**

쉽게 예시로:

- 사용자가 역류기 수동토글을 켰다가 5초 뒤 껐다
- 그동안 queue에 제목 2개가 남아 있었다

이때 하면 안 되는 구조:

- post scheduler는 멈췄는데 broker worker는 계속 search를 때림

맞는 구조:

- stop과 함께 pending queue는 정리
- 다만 이미 저장된 positive cache는 그대로 남겨서 다음 시작 때 재활용
- 이미 날아간 옛 worker 응답이 늦게 돌아오더라도, 현재 generation과 다르면 runtime hotset/log에는 반영하지 않음

또 다른 예시:

- service worker가 잠들었다가 다시 살아남
- post scheduler는 [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L245) 경로로 복원됨

이때 맞는 구조:

- storage cache는 다시 hydrate
- in-memory hotset/pending은 새로 시작
- 그래서 "이전에 양성 확인된 제목"은 다시 쓰되, "이전에 대기 중이던 queue"는 다시 무조건 재생하지 않는다

즉 1차 패치에서는 broker 상태를 두 층으로 나눠야 한다.

- **영속층**: positive/negative/error timestamp cache
- **런타임층**: pending queue, active worker, hotset

여기서 실제 코드 기준으로 하나 더 중요하다.

- 지금 `resumeAllSchedulers()`는 scheduler들만 복원한다
- 새 search broker는 이 목록에 자동으로 들어오지 않는다

즉 1차 구현에서는 아래 둘 중 하나가 필요하다.

1. broker public method(`getDecision`, `enqueue`, `getPositiveDecision` 등) 진입 시 idempotent `ensureLoaded()`로 storage cache hydrate
2. 또는 background 초기화 경로에 broker initialize를 명시적으로 추가

권장 쪽은 1번이다.

이유:

- scheduler resume 순서와 강결합되지 않는다
- service worker가 다시 떠도 broker가 실제로 필요할 때만 안전하게 hydrate된다
- 중복 초기화도 막기 쉽다

그리고 `resetStats`의 의미도 분리해야 한다.

- 현재 [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L697)는 post의 통계/로그만 초기화한다
- 현재 [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L908) 근처 post reset 로직도 `totalClassified`와 pending mode transition만 건드리고, 실행 중 search state를 날리는 구조는 아니다
- 그러므로 1차 패치에서도 `resetStats`는 **검색 캐시를 지우는 버튼이 아니어야 하고, 실행 중 broker queue/hotset도 건드리지 않는 쪽이 기존 의미와 더 가깝다**
- 캐시 삭제가 필요하면 나중에 별도 action/UI로 분리하는 게 맞다

---

## 10. manifest 변경

`search.dcinside.com`의 `getSearch` 요청을 확장 런타임에서 직접 하려면 host permission이 필요하다.

현재는 `search.dcinside.com`이 없다.

따라서 1차 구현에는 아래가 포함돼야 한다.

```json
"https://search.dcinside.com/*"
```

이건 필수다.

---

## 11. 최소 구현 단계

### 1단계

- `getSearch JSONP` parser 추가
- fixture JSONP body 기준 static parse 검증
- `<b>` 태그 제거 + 제목 정규화 + `board_id`/`url_param.no` 파싱 검증

### 2단계

- search broker 추가
- runtime queue + in-memory cache
- `withDcRequestLease` 연동

### 3단계

- `chrome.storage.local` 영속 cache 추가
- TTL 적용

### 4단계

- popup 입력란/저장/dirty tracking/status sync + background 검증 추가
- 실행 중 `refluxSearchGalleryId` 변경 runtime transition 연결

### 5단계

- post scheduler `수동 역류기 모드`에만 search duplicate 연결

### 6단계

- log 문구 / 상태 문구 정리

이 순서가 좋은 이유:

- 파서
- 브로커
- 스케줄러 연결

을 분리하면 디버깅이 쉽다.

---

## 12. 필요한 추가 스펙

네가 최대한 가져와야 할 스펙은 이거다.

### 필수

1. `getSearch` 결과 0건 케이스
2. `getSearch` 결과 여러 건 케이스
3. 같은 제목이 자기 자신만 뜨는 케이스
4. 같은 제목이 과거 글까지 같이 뜨는 케이스
5. `title`에 `<b>` 강조가 여러 군데 들어간 케이스
6. 짧은 흔한 제목 검색 결과
7. `board_id`가 target gallery 결과보다 타 갤 결과가 먼저 많이 뜨는 케이스
8. 오래된 제목인데 `getSearch`에는 안 보이고 dataset에는 있는 케이스
9. `url_param.no`가 문자열로 오는 케이스
10. page 2 이상 호출 시 응답 구조가 page 1과 동일한 케이스

### 있으면 좋은 것

1. 검색 페이지에서 차단/에러 시 JSONP가 어떻게 오는지
2. search domain 요청이 많을 때 403/429/빈 body/깨진 JSONP 중 무엇으로 오는지
3. 같은 제목인데 첫 페이지에는 target gallery가 없고 2페이지에는 있는 케이스
4. `meta.pageCount`가 실제 "페이지 수"가 아니라 "총 row 수"처럼 보이는지 확인 가능한 샘플

---

## 13. 현재 결론

이번 기능은 **어렵지만 가능** 쪽이다.

정확히 말하면:

- 논리 자체는 명확하다
- `getSearch` 응답 스펙은 이미 1차 구현에 충분하다
- 진짜 어려운 부분은 `판정 정의`가 아니라 `요청 제어`다
- 실제 코드 기준으로도 연결 지점은 명확하다
- 다만 **manual reflux는 현재 quick toggle 실행 경로**이므로, 문서/구현 모두 그 UX를 기준으로 맞춰야 한다
- 또 search 요청은 기존 요청 게이트와 분리하지 말고 `withDcRequestLease` 아래에 넣는 게 맞다

그래서 이번 1차 구현은 반드시 아래 원칙을 지켜야 한다.

1. **커버리지 메인은 `getSearch` 기반 검색 duplicate**
2. `dataset`은 초반 로컬 확인용 + 옛 제목 보강
3. **1차는 수동 `SEMICONDUCTOR_REFLUX` 토글에서만 사용**
4. `queue + cache + single worker`
5. 검색 결과는 **`searchTargetGalleryId` 일치 + exact title**, 그리고 **`searchTargetGalleryId === deleteGalleryId`일 때만 다른 `postNo` 요구**
6. 메인 분류 루프는 검색 응답을 기다리지 않는다
7. HTML 경로는 runtime에서 쓰지 않는다
8. 테스트 시작값은 `100ms + 30ms jitter`

한 줄 요약:

- **네 말대로 전부 공격을 막는 축은 검색 API 쪽이 메인이다**
- **dataset은 버리는 게 아니라 빠른 local 보조와 옛 제목 보강용이다**
- **다만 runtime에서는 `getSearch`만 queue + cache + single worker로 눌러서 쓰고, 1차 테스트 시작값은 `100ms + 30ms jitter`다**
