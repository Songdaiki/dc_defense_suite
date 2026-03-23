# 도배기 갱신 차단 자동 기능 스펙 / 구현 플랜

## 목적

`특궁` 안에 새 상단 탭 **`도배기갱신차단자동`** 을 추가하고,
관리내역(차단/해제 기록)을 주기적으로 순회하면서 **제목에 한자(Han)가 2글자 이상 들어간 게시글**을 다시 찾아
관리내역 전용 재차단 API로 **6시간 IP 차단 갱신**을 자동 수행한다.

이 기능의 핵심 목적은:

- 관리내역에 이미 찍혀 있는 한자형 도배 게시글을 다시 훑고
- 해당 글 기준으로 IP 차단을 다시 6시간 갱신해서
- 도배기 재유입을 주기적으로 눌러두는 것이다.

---

## 이번 구현에서 고정하는 스펙

- 탭명: `도배기갱신차단자동`
- 위치: `특궁` 안 **새 상단 탭**
- ON 시 즉시 1회 실행
- 1회 완료 후 **5시간 뒤** 다음 실행
- 관리내역 페이지 범위:
  - `1 ~ detectedMaxPage`
  - 현재 확인된 예시는 `486`
- 관리내역 URL 형식:
  - `https://gall.dcinside.com/mgallery/management/block?id=thesingularity&s=&t=u&p=1`
- row 조건:
  - `게시글` row만
  - 제목에 `Han` 글자가 2개 이상 있는 row만
  - writer token이 IP형인 row만
  - `.blocknum[data-num]`이 유효한 row만
- 차단 시간:
  - `6시간`
- 차단 API:
  - `/ajax/managements_ajax/user_code_avoid`
- 차단 방식:
  - **페이지 단위 batch**
  - 한 페이지에서 조건을 만족한 row를 먼저 전부 모은 뒤
  - `nos[]`를 한 번에 묶어서 요청
- 사유:
  - `avoid_reason = 0`
  - `avoid_reason_txt = 도배기`
- 동일 IP 제한:
  - **두지 않음**
  - 같은 IP가 여러 row에 있으면 row 기준으로 계속 다시 차단 시도

---

## 실제 코드 대조로 추가 확정한 구현 규칙

이번 기능은 문서상 플로우만 맞는다고 끝나는 게 아니라,
실제 앱 구조에 꽂히는 지점이 명확해야 한다.

즉 구현할 때는 아래 규칙을 같이 지켜야 한다.

### 1. 새 기능은 `개념글 방어` 내부 하위 섹션이 아니라 popup의 **새 top-level 탭**이다

현재 popup 구조는 이미 top-level 탭 네비게이션을 기준으로 동작한다.

기준 코드:

- [popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L17)
- [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1)

즉 이번 기능의 `특궁 안 새 상단 탭`이라는 말은
`개념글 방어 패널 안에 버튼 하나 더`가 아니라,
**popup 탭 바에 새 feature 하나를 추가한다**는 뜻으로 고정한다.

### 2. `han_pool_extractor`는 selector / 순회 규칙 reference일 뿐, hidden tab 아키텍처를 그대로 옮기지 않는다

기존 한자 추출기는 독립 확장이라서
background에서 비활성 탭을 열고 `chrome.scripting.executeScript()`로 DOM을 읽는다.

기준 코드:

- [projects/han_pool_extractor/background/background.js](/home/eorb915/projects/dc_defense_suite/projects/han_pool_extractor/background/background.js#L1)

하지만 본 앱은 이미 scheduler 기반 구조이고,
대부분의 기능이 `fetch -> HTML 문자열 parser -> scheduler state 저장` 패턴으로 돌아간다.

즉 이번 기능에서 extractor에서 재사용하는 것은:

- 관리내역 URL 형식
- pagination `page_end`
- `tbody > tr`
- `td.blockcontent em`
- `td.blockcontent a`

이 selector / 순회 규칙뿐이다.

반대로 **그대로 재사용하면 안 되는 것**:

- hidden crawler tab 생성
- popup port 연결 구조
- `chrome.scripting.executeScript()` 전제

이번 기능은 본 앱 패턴대로
`features/<new-feature>/api.js + parser.js + scheduler.js`
형태로 구현하고,
관리내역 HTML은 **fetch로 받아 문자열 parser로 읽는 방식**으로 고정한다.

추가로 상태 저장 방식도 기존 scheduler 패턴을 따른다.

- 저장소는 `chrome.storage.local`
- `STORAGE_KEY`
- `saveState()`
- `loadState()`
- `ensureRunLoop()`

기준 패턴:

- [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L16)
- [features/concept-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/scheduler.js#L16)

### 3. 기존 `features/ip/api.js`의 관리내역 URL builder를 그대로 재사용하면 안 된다

현재 IP 기능의 관리내역 helper는 아래 URL을 만든다.

- [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L61)

하지만 저 helper는:

- query param이 `page`
- `s=&t=u`가 없음

이번 기능이 실제로 순회해야 하는 관리내역 URL은:

- `.../mgallery/management/block?id=<galleryId>&s=&t=u&p=1`

즉 이번 기능은 **전용 URL builder**를 둬야 하고,
`features/ip/api.js`의 `buildBlockListUrl()`을 그대로 쓰면 안 된다.

### 4. `detectedMaxPage` 파싱은 `href` 문자열을 그대로 믿지 말고 HTML entity decode 후 URL 파싱해야 한다

실제 HTML에는 `&amp;`가 포함된 형태로 들어있다.

기준 HTML:

- [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L2286)

즉 구현은 아래 둘 중 하나로 고정한다.

- `DOMParser`로 anchor를 읽고 `href`를 정상 URL로 받는다
- 또는 문자열 parser를 쓴다면 `&amp; -> &` decode 후 `new URL()`을 만든다

이 규칙을 빼먹으면 `p=486` 추출에서 실수가 날 수 있다.

### 5. 새 기능은 shared config에서 `galleryId`만 의존하고 `headtextId`는 사용하지 않는다

현재 공통 설정은 `galleryId` / `headtextId`를 여러 scheduler에 퍼뜨린다.

기준 코드:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L393)

이번 기능은:

- `galleryId`는 shared config를 따른다
- `galleryType`은 로컬 기본값 `M`을 둔다
- `headtextId`는 사용하지 않는다

따라서 구현 시 shared config 연동은 아래처럼 분리한다.

- `galleryId` 변경 시만 상태 reset
- `headtextId` 변경에는 영향 없음

### 6. popup / background / 상태 저장 registry 추가는 기능 스펙의 일부다

이 기능은 새 scheduler 파일만 만든다고 끝나지 않는다.

실제 코드 기준으로 아래 경로를 같이 건드려야 한다.

- popup 탭 / 패널 추가: [popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L17)
- dirty tracking / DOM binding / save button / status update: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1)
- scheduler registry / 상태 조회 / resume / reset / shared config 반영: [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1)

즉 문서상 필수 통합 포인트는 최소 아래다.

- `popup.html`
- `popup.js`
- `popup.css`
- `background/background.js`
- `features/<new-feature>/api.js`
- `features/<new-feature>/parser.js`
- `features/<new-feature>/scheduler.js`

### 7. popup CSS는 현재 탭 7개 고정이라 새 탭 추가 시 같이 수정해야 한다

현재 popup CSS는 탭 바가 `repeat(7, 1fr)`로 고정돼 있다.

기준 코드:

- [popup.css](/home/eorb915/projects/dc_defense_suite/popup/popup.css#L120)

즉 새 top-level 탭을 추가하면
기능은 멀쩡해도 UI가 바로 깨질 수 있으므로,
이번 작업 범위에는 **탭 grid 컬럼 수 조정 또는 wrap 대응 CSS 수정**이 포함된다.

### 8. `5시간 후 재실행`은 단순 `delay(5h)`가 아니라 `nextRunAt` 절대시각 저장으로 구현해야 한다

현재 앱은 service worker 재시작 / keepAlive / 브라우저 시작 시 scheduler 상태를 다시 불러온다.

기준 코드:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1)

즉 이번 기능이 문서대로 동작하려면 아래 상태를 저장해야 한다.

- `isRunning`
- `currentPage`
- `detectedMaxPage`
- `lastRunAt`
- `nextRunAt`
- 현재 사이클 통계
- 최근 로그

그리고 resume 시 동작은 아래로 고정한다.

- `isRunning=false`면 아무 것도 재개하지 않음
- `isRunning=true`이고 `nextRunAt`이 미래면 그 시각까지 대기
- `isRunning=true`이고 `nextRunAt`이 지났으면 즉시 다음 사이클 시작

즉 `5시간 후 재실행`은 **완료 시각 기준 absolute scheduling**이어야 한다.

### 9. manual stop 시 다음 예약도 같이 꺼져야 한다

이번 기능은 ON/OFF 토글형이므로,
사용자가 OFF 하면 현재 in-flight 요청만 정리하고 끝나는 게 아니라
**다음 5시간 예약까지 같이 꺼져야 한다.**

즉 OFF 시점 규칙은 아래로 고정한다.

- 현재 요청은 가능하면 마무리
- 다음 페이지는 진행하지 않음
- `isRunning=false`
- `nextRunAt=''`
- `currentPage=0`

### 10. 1페이지 초기 fetch 실패는 일반 페이지 실패와 다르게 취급해야 한다

일반 페이지 실패는:

- 1회 재시도
- 그래도 실패하면 로그 남기고 다음 페이지 진행

로 충분하다.

하지만 `p=1`은:

- `detectedMaxPage` 계산
- 첫 batch 대상 수집

이 둘을 같이 담당하므로,
초기 `p=1` fetch가 실패하면 사실상 그 사이클 전체가 성립하지 않는다.

따라서 문서상 기본 규칙은 아래로 고정한다.

- 초기 `p=1` fetch는 1회 재시도
- 그래도 실패하면 그 사이클은 오류 종료
- `isRunning`은 유지하고 `nextRunAt`을 다시 잡아 다음 사이클을 기다린다

즉 일반 페이지 skip 규칙과 초기 진입 실패 규칙을 분리해야 한다.

### 11. 기존 `ip` 기능 API helper는 일부만 재사용한다

재사용 가능한 것:

- `dcFetchWithRetry`
- `getCiToken`
- 공통 fetch 헤더 패턴

그대로 재사용하면 안 되는 것:

- `banPosts()`
- `/ajax/minor_manager_board_ajax/update_avoid_list`
- `id` 기반 payload
- `del_chk`, `avoid_type_chk` 전제

이번 기능은 전용 management API helper를 둬서
아래 payload를 보내는 것으로 고정한다.

- `gallery_id`
- `_GALLTYPE_`
- `avoid_hour`
- `avoid_reason`
- `avoid_reason_txt`
- `nos[]`

### 12. 이 기능은 monitor child가 아니므로 manual lock 정책을 별도로 정의해야 한다

현재 `monitor`는 `post / semiPost / ip`를 child처럼 잠그는 로직이 있다.

기준 코드:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L545)
- [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1026)

이번 기능은 monitor child가 아니므로,
기본 정책은 아래로 고정한다.

- `monitor` 실행 여부와 무관하게 독립적으로 ON/OFF 가능
- 다만 **shared config 변경 시에는 busy feature로 간주**해서 저장을 막음

즉 `applyAutomationLocks()`의 수동 잠금과
`getBusyFeatures()`의 공통설정 잠금은 역할을 분리해서 본다.

즉 이 기능은:

- 최신 게시판을 보는 기능이 아니라
- **관리내역을 다시 훑는 주기형 재차단기**
- 그리고 기준은 **한자 제목 + IP형 row**
라고 보면 된다.

---

## 이미 확인된 사실

### 1. 관리내역에서 필요한 값은 이미 읽을 수 있다

기존 한자 추출기 스펙과 실제 관리내역 HTML 기준으로,
관리내역 row에서 아래 값들을 읽을 수 있다.

- row 종류: `td.blockcontent em`
- 제목: `td.blockcontent a`
- 게시글 번호: `td.blockcontent a[href]`
- 관리내역 내부 번호: `.blocknum[data-num]`
- 사유: `td.blockreason`
- writer token: `td.blocknik`

기준 문서:

- [han_pool_extractor_spec.md](/home/eorb915/projects/dc_defense_suite/projects/han_pool_extractor/docs/han_pool_extractor_spec.md)

관련 구현 참고:

- [background.js](/home/eorb915/projects/dc_defense_suite/projects/han_pool_extractor/background/background.js)
- [parser.js](/home/eorb915/projects/dc_defense_suite/features/ip/parser.js)

실제로는 아래 조합이 가장 자연스럽다.

- 관리내역 row 구조 / `blockDataNum` / `writerToken` 파싱:
  - [parseBlockListRows()](/home/eorb915/projects/dc_defense_suite/features/ip/parser.js#L42)
- writer token 정규화:
  - [normalizeWriterToken()](/home/eorb915/projects/dc_defense_suite/features/ip/parser.js#L154)
- 제목 Han 판정:
  - [isHanCjkSpamLikeSubject()](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L158)

즉 새 기능에서 관리내역 row 파싱을 새로 발명할 필요는 없다.

### 1-1. 관리내역 순회 스펙은 기존 한자 추출기 프로젝트를 그대로 레퍼런스로 삼는다

이번 기능의 관리내역 순회 규칙은 아래 프로젝트를 **직접 레퍼런스**로 사용한다.

- [han_pool_extractor](/home/eorb915/projects/dc_defense_suite/projects/han_pool_extractor)

특히 아래 문서를 기준 스펙으로 삼는다.

- [han_pool_extractor_spec.md](/home/eorb915/projects/dc_defense_suite/projects/han_pool_extractor/docs/han_pool_extractor_spec.md)

이번 기능에서 그대로 재사용하는 관리내역 순회 규칙:

- URL 형식은 `.../management/block?...&p=1`
- 관리내역 HTML을 페이지 단위로 순회
- row selector는 `tbody > tr`
- row 종류 판별은 `td.blockcontent em`
- `게시글` row만 포함
- 제목 추출은 `td.blockcontent a`
- 댓글 row는 제외

즉 새 기능은:

- 관리내역 끝 페이지 계산
- 관리내역 페이지 fetch
- `tbody > tr` 순회
- `게시글` row 필터
- 제목 Han 판정

이 부분을 새로 설계하는 게 아니라,
**기존 한자 추출기에서 이미 검증한 관리내역 순회 스펙 위에**
`관리내역 재차단 batch 호출`만 덧붙이는 방식으로 간다.

### 2. 마지막 페이지는 HTML의 `끝` 링크에서 읽을 수 있다

관리내역 HTML 안에 실제로 pagination 링크가 들어 있고,
맨 끝 이동 링크는 아래처럼 `href`를 가진 anchor로 존재한다.

기준 HTML:

- [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L2286)

확인된 형태:

```html
<a href="/mgallery/management/block?id=thesingularity&s=&t=u&amp;p=486" class="sp_pagingicon page_end">끝</a>
```

즉 `detectedMaxPage`는 아래 방식으로 계산하면 된다.

1. `a.page_end` 찾기
2. `href` 읽기
3. `p` 쿼리 파라미터 추출
4. 숫자로 변환

이번 기능은 `1~400 고정`이 아니라,
**관리내역 실제 끝 페이지를 동적으로 읽어서**
`1 ~ detectedMaxPage` 순회하는 방식으로 간다.

### 3. 관리내역 전용 재차단 API는 이미 확인됐다

관리내역 화면에서 체크박스를 여러 개 선택하고
`직접 차단` 확인 버튼을 누를 때 실제로 호출되는 API는 아래다.

- `POST /ajax/managements_ajax/user_code_avoid`

확인 기준:

- 원본 HTML: [html.md](/home/eorb915/projects/dc_defense_suite/docs/html.md#L587)
- 원본 스크립트: `managements.js`

실제 확인한 JS 흐름:

1. 체크된 row를 모음
2. 각 row의 `.blocknum[data-num]` 읽기
3. `data-num - 1` 값을 `nos[]`에 넣음
4. `user_code_avoid` API 호출
5. 성공 시 `ajaxData.result == "success"`
6. 성공하면 `alert('차단되었습니다.')` 후 `location.reload(true)`

중요:

- 여기서 보내는 `nos[]`는 **게시글 postNo가 아니다**
- 관리내역 row의 내부 번호 기반 값이다
- 그리고 JS 기준으로는 **`.blocknum[data-num] - 1`** 을 넣는다

즉 이번 기능은 예전처럼 게시판 목록용 IP 차단 API를 타는 게 아니라,
**관리내역 화면이 원래 쓰는 재차단 API를 그대로 재사용**하는 것이 맞다.

### 4. 제목의 Han 판정 helper도 이미 있다

현재 코드에는 이미 한자(Han) 판정 helper가 있다.

관련 코드:

- [parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L1)
- [parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L158)
- [parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L164)

즉 이번 기능은 “중국어를 해석”하는 게 아니라,
**제목에 Han 글자가 들어있는지**만 보면 된다.

---

## row 포함 조건

관리내역 row는 아래 조건을 **모두** 만족해야 이번 사이클의 차단 대상이 된다.

### 1. `게시글` row

판정 기준:

- `td.blockcontent em` 텍스트가 정확히 `게시글`

즉 `댓글` row는 제외한다.

### 2. 제목에 Han 글자 포함

판정 기준:

- 제목 문자열에 `\p{Script=Han}` 2개 이상

즉:

- 한글만 제목: 제외
- 영어/숫자만 제목: 제외
- 한자가 1글자만 있으면 제외
- 한자가 2글자 이상이면 포함

### 3. writer token이 IP형

기준:

- `writerToken`이 비어 있지 않고
- IP prefix 형태로 정규화 가능한 값

예:

- `(221.161.*.*)` -> 포함
- `(fight2087)` 같은 uid 계열 -> 제외

즉 고정닉/반고닉형 row는 이번 기능 대상이 아니다.

### 4. 관리내역 내부 번호(`data-num`)가 유효해야 한다

이번 기능은 실제 차단 요청에 `nos[] = data-num - 1`을 쓰므로,
아래 조건도 필수다.

- `.blocknum[data-num]`가 존재해야 함
- 숫자로 변환 가능해야 함
- `data-num - 1` 결과가 0보다 커야 함

즉 제목/Han/IP 조건을 만족하더라도
관리내역 내부 번호를 못 읽는 row는 그 페이지에서 스킵한다.

### 5. 상태(`차단 중` / `해제됨`)는 이번 기능의 필터 조건이 아니다

이번 기능은 관리내역을 다시 훑어 **재차단 갱신**하는 목적이므로,
row 상태 텍스트는 필터에 쓰지 않는다.

즉:

- `차단 중`이어도 조건이 맞으면 포함 가능
- `해제됨`이어도 조건이 맞으면 포함 가능

핵심 조건은 상태가 아니라:

- 게시글
- Han 제목
- IP형 writer token
- 유효한 `data-num`

이 4개다.

---

## `detectedMaxPage` 계산 방식

이번 기능은 관리내역 끝 페이지를 아래 우선순위로 계산한다.

### 1순위

`a.page_end`의 `href`에서 `p`를 읽는다.

selector:

- `.bottom_paging_box.iconpaging a.page_end`

예:

- `/mgallery/management/block?id=thesingularity&s=&t=u&p=486`

그러면:

- `detectedMaxPage = 486`

### 2순위

`page_end`가 없으면 pagination 안 숫자 anchor 중 최대 `p` 값을 사용한다.

### 3순위

pagination 박스는 읽히지만

- 숫자 anchor가 하나도 없고
- 현재 페이지 표시만 `1`로 있는 경우

이건 **실제로 관리내역이 1페이지뿐인 상황**으로 본다.

즉 이 경우:

- `detectedMaxPage = 1`

### 4순위

pagination 자체를 못 읽거나,
구조가 바뀌어 `page_end` / 숫자 anchor / 현재 페이지 표기를 모두 정상 해석하지 못할 때만
fallback 기본값을 사용한다.

권장 fallback:

- `400`

즉 최종 순회 범위는:

- `1 ~ detectedMaxPage`
- 실패 시 `1 ~ 400`

---

## 차단 처리 규칙

### 기본 차단 설정

- `avoid_hour = 6`
- `avoid_reason = 0`
- `avoid_reason_txt = 도배기`

즉 이번 기능은:

- 게시물 삭제를 하지 않고
- **관리내역 row 기준 재차단만 6시간 갱신**한다.

### 실제 요청 필드

현재 확인된 batch 요청 필드는 아래다.

- `ci_t`
- `gallery_id`
- `_GALLTYPE_`
- `avoid_hour`
- `avoid_reason`
- `avoid_reason_txt`
- `nos[]`

중요:

- `nos[]`는 관리내역 row 내부 번호 기반 값
- 실제론 `.blocknum[data-num] - 1`

예시 형태:

```text
ci_t=<ci_c 쿠키 값>
gallery_id=thesingularity
_GALLTYPE_=M
avoid_hour=6
avoid_reason=0
avoid_reason_txt=도배기
nos[]=10159649
nos[]=10159647
...
```

### 성공 판정

관리 스크립트 기준 성공 판정은 아래다.

- 응답 JSON의 `result === "success"`

즉 새 기능도 1차 구현에서는 이 기준을 그대로 쓰면 된다.

주의:

- 실제 응답 헤더의 `Content-Type`은 `text/html`로 보일 수 있다
- 따라서 구현은 헤더를 믿고 분기하지 말고
  **응답 body를 text로 읽은 뒤 안전하게 JSON parse**하는 방식이 더 안전하다

즉 site JS의 `dataType: 'json'` 기대만 그대로 믿고
`content-type === application/json` 같은 전제를 두면 안 된다.

### 같은 IP 중복 처리

이번 기능은 **같은 IP 제한을 두지 않는다.**

즉:

- 같은 IP가 관리내역 여러 row에 있으면
- client 쪽에서 same-IP dedupe를 하지 않는다
- row 기준으로 차단 시도를 그대로 진행한다

쉽게 말하면:

- `221.161`이 7줄 있으면
- 그 7줄을 다 차단 시도할 수 있다

이번 기능의 목적이 “이미 찍힌 관리내역 row를 다시 보며 차단 시간을 갱신하는 것”이므로,
의도적으로 same-IP dedupe를 두지 않는다.

중요:

- 다만 완전히 같은 관리내역 내부 번호가 중복으로 들어오는 비정상 상황만 있으면
- 그때는 `nos[]` 값 단위 dedupe 정도는 넣어도 된다
- 하지만 **IP 단위 dedupe는 넣지 않는다**

추가로,
관리내역은 순회 중에도 새 row가 쌓일 수 있어서 페이지 경계가 밀릴 수 있다.
이 경우 같은 관리내역 row가 다음 페이지에서 다시 보일 수 있으므로,
**한 사이클 안에서는 동일 `blockDataNum` / 동일 `nos[]` 값에 한해 dedupe**하는 것은 허용한다.

즉 정리하면:

- 같은 IP라도 **다른 관리 row**면 계속 차단 시도
- 하지만 **완전히 같은 관리 row id**가 페이지 이동 중 다시 보이면 한 번만 처리

### 페이지 단위 batch 처리

이번 기능은 댓글 차단처럼
**한 페이지에서 대상 row를 먼저 전부 체크한 뒤**
그 페이지 대상만 한 번에 API를 호출하는 방식으로 간다.

즉 페이지별 흐름은:

1. 관리내역 한 페이지 fetch
2. 조건 맞는 row를 전부 수집
3. 각 row에서 `data-num - 1` 기반 `nos[]` 생성
4. 그 페이지 대상 `nos[]`를 한 번에 `user_code_avoid`로 전송
5. 다음 페이지로 이동

이유:

- 실제 수동 UI 흐름과 동일하다
- 요청 수를 줄일 수 있다
- 페이지별 로그를 남기기 쉽다

---

## 실행 주기

### ON 시

1. 즉시 1회 실행
2. 완료 시각 기록
3. `5시간 후` 다음 실행 예약

즉 첫 실행은 기다리지 않는다.

### 다음 사이클 기준

이번 기능의 5시간 주기는 **사이클 완료 기준**으로 잡는다.

예:

- 10:00 시작
- 10:07 완료
- 다음 실행은 15:07

이유:

- 관리내역 끝 페이지가 바뀔 수 있고
- 실제 실행 시간도 조금씩 다를 수 있으므로
- 시작 기준보다 완료 기준이 더 직관적이다

---

## 특궁 탭 UI 최소 스펙

탭명:

- `도배기갱신차단자동`

최소 표시 항목:

- ON/OFF 토글
- 현재 상태
- 현재 순회 페이지
- 마지막 감지 최대 페이지
- 이번 사이클 검사 row 수
- 이번 사이클 Han 대상 row 수
- 이번 사이클 차단 성공 수
- 이번 사이클 차단 실패 수
- 마지막 실행 시각
- 다음 실행 예정 시각
- 최근 로그

1차에서 있으면 좋은 설정:

- fallback 최대 페이지 (`400`)
- 요청 딜레이(ms)
- 사이클 딜레이(ms) 대신 고정 `5시간`

하지만 1차는 간단히 가도 된다.

권장 1차 설정:

- 요청 딜레이(ms)
- fallback 최대 페이지

---

## 실제 플로우

아주 쉽게 풀면 이렇다.

### 1. 사용자가 ON

1. `도배기갱신차단자동` 탭에서 토글 ON
2. 즉시 1회 실행 시작

### 2. 첫 페이지 로드 + 마지막 페이지 계산

1. 관리내역 `p=1` HTML fetch
2. pagination에서 `a.page_end` 찾기
3. `href`에서 `p` 추출
4. `detectedMaxPage` 결정
5. 예: `486`

### 3. 페이지 순회

1. `1페이지` 읽기
2. `tbody > tr` 순회
3. 각 row에서 아래 조건 검사
   - `게시글`
   - 제목 Han 포함
   - IP형 writer token 존재
4. 조건 만족 row의 `.blocknum[data-num] - 1` 값을 차단 대상으로 모음
5. `2페이지`, `3페이지` ... `detectedMaxPage`까지 반복

### 4. 페이지 단위 batch 차단 호출

각 페이지에서 조건을 만족한 row들을 전부 모은 뒤,
그 페이지 대상만 **한 번에 batch 요청**으로 보낸다.

기준:

- `user_code_avoid`
- `6시간`
- `avoid_reason = 0`
- `avoid_reason_txt = 도배기`
- 성공 기준은 `result === "success"`

### 5. 끝 페이지 drift 보정 (tail 보정 루프)

관리내역은 우리가 재차단하는 동안에도 앞쪽에 새 row가 쌓여
기존 마지막 페이지가 뒤로 밀릴 수 있다.

따라서 이번 기능은 **처음 감지한 끝 페이지까지만 한 번 돌고 끝내지 않는다.**

실제 루프는 아래처럼 고정한다.

1. 시작 시 `p=1` fetch
2. `a.page_end`에서 `initialDetectedMaxPage` 감지
3. 로그 남김
   - 예: `📚 초기 끝 페이지 감지: 486P`
4. 시작 시 `p=1` HTML에서 **이번 사이클 기준 최대 `blockDataNum` 상한**도 같이 저장
   - 예: `🧷 사이클 기준 row 상한 data-num: 10159650`
5. 이후 스캔/재감지/tail 보정에서는 이 상한을 초과하는 row를 전부 제외
   - 목적: **이번 사이클에서 직접 생성한 새 관리내역 row를 다시 따라가지 않기 위함**
6. `1 ~ initialDetectedMaxPage` 스캔
7. 그 구간이 끝나면 다시 `p=1` fetch
8. 새 `currentDetectedMaxPage` 감지
9. 만약 `currentDetectedMaxPage > previousScanEndPage`면
   - 늘어난 꼬리 구간만 추가 스캔
   - 예: `487 ~ 491`
   - 로그 남김
     - `↗ 끝 페이지 증가 감지: 486P -> 491P`
     - `🔁 tail 보정 스캔: 487P ~ 491P`
10. tail 구간을 다 돌고 나면 다시 `p=1` fetch
11. 더 이상 끝 페이지가 안 늘어나면 종료
   - 예: `✅ 끝 페이지 안정화 확인: 마지막 스캔 491P / 재감지 491P`

즉 구현은:

- `1 ~ initialDetectedMaxPage`
- 이후엔 `previousEndPage + 1 ~ newDetectedMaxPage`

만 반복해서 도는 방식으로 고정한다.

중요:

- 이미 스캔한 앞페이지를 다시 `1부터 재순회`하지 않는다
- 같은 cycle 안에서 같은 `nos[]`를 또 치지 않도록 cycle-level dedupe는 유지한다
- 이번 사이클 시작 이후에 생긴 **새 `blockDataNum` row는 상한 필터로 제외**한다
- tail 보정은 무한 루프를 막기 위해 내부적으로 최대 횟수 제한을 둔다

### 6. 완료 후 대기

1. 끝 페이지가 안정화될 때까지 tail 보정까지 완료하면 사이클 종료
2. 완료 시각 저장
3. `5시간 뒤` 다음 사이클 예약

### 7. 다음 사이클

1. 다시 `p=1`부터 시작
2. 다시 `detectedMaxPage`를 읽음
3. 다시 끝까지 순회 + tail 보정

즉 매 사이클마다:

- 관리내역 현재 끝 페이지를 다시 읽고
- 그 시점 기준 전체 관리내역을 다시 순회한다
- 순회 중 끝 페이지가 뒤로 밀리면 tail 보정까지 포함해 마무리한다

중요:

- 순회 중에도 관리내역 상단에는 새 row가 계속 쌓일 수 있다
- 따라서 `1 -> detectedMaxPage` 정방향 순회 중 페이지 경계가 밀리면
  같은 row가 다른 페이지에서 다시 보이거나,
  일부 row가 그 사이클에서는 뒤로 밀릴 수 있다

이번 기능은 이를 아래처럼 해석한다.

- 같은 row가 다시 보이는 것은 cycle-level `nos[]` dedupe로 막는다
- 새 row 유입으로 뒤로 밀린 row는 **현재 사이클의 tail 보정 루프에서 우선 다시 잡는다**
- 그래도 동시성 때문에 아주 드물게 빠진 row가 남는 것은 **다음 5시간 사이클에서 다시 잡는 것**을 허용한다

즉 이 기능은 실시간 완전일치 snapshot 보장이 아니라,
**tail 보정 + 주기적 전체 재순회를 통한 eventual consistency**를 목표로 한다.

---

## 구현 방향 권장

이번 기능은 `개념글 방어` 자체와는 목적이 다르므로,
기존 `features/concept-monitor/scheduler.js` 안에 직접 섞기보다는
**독립 scheduler 하나를 새로 두고 특궁 UI에서만 같이 노출하는 방식**이 더 안전하다.

권장 예시:

- `features/han-refresh-ip-ban/api.js`
- `features/han-refresh-ip-ban/parser.js`
- `features/han-refresh-ip-ban/scheduler.js`

이유:

- 개념글 방어 로직과 책임이 다름
- 관리내역 순회 / Han row 필터 / 5시간 주기 로직이 별도임
- 나중에 수정할 때 영향 범위를 줄이기 좋음

추가로,
이 새 scheduler의 관리내역 파싱/순회 부분은
`projects/han_pool_extractor`에서 이미 쓴 구조를 최대한 그대로 따라가는 것이 맞다.

즉 구현할 때도 아래 레퍼런스를 우선 참고한다.

- [background.js](/home/eorb915/projects/dc_defense_suite/projects/han_pool_extractor/background/background.js)
- [han_pool_extractor_spec.md](/home/eorb915/projects/dc_defense_suite/projects/han_pool_extractor/docs/han_pool_extractor_spec.md)

UI/배경 연결은 기존 feature 패턴을 그대로 따르면 된다.

연결 참고:

- [background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)
- [popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)

### 실제 수정 파일 체크리스트

구현 시 최소 수정 대상은 아래로 고정한다.

#### popup

- `popup.html`
  - top-level 탭 버튼 추가
  - panel section 추가
  - 상태 카드 / 설정 입력 / 로그 영역 추가
- `popup.css`
  - 탭 grid 컬럼 수 또는 wrap 수정
  - 새 feature header 색상 블록 추가
- `popup.js`
  - `DIRTY_FEATURES` 추가
  - `FEATURE_DOM` 추가
  - `bindFeatureEvents()`에 bind 함수 등록
  - `applyStatuses()`에 UI 갱신 함수 등록
  - `update<Feature>UI()` 추가
  - `getFeatureConfigInputs()`에 입력 목록 추가
  - 필요 시 `applyAutomationLocks()`에 잠금 정책 반영

#### background

- `background/background.js`
  - scheduler import
  - scheduler instance 생성
  - `schedulers` registry 등록
  - `resumeAllSchedulers()` 복원 경로 추가
  - `getAllStatuses()` 상태 노출 추가
  - `applySharedConfig()` galleryId 변경 reset 추가
  - `getBusyFeatures()` busy feature 추가
  - `resetSchedulerStats()` 분기 추가
  - 필요 시 dedicated reset helper 추가

#### feature implementation

- `features/<new-feature>/api.js`
  - management URL builder
  - page fetch
  - `user_code_avoid` POST helper
- `features/<new-feature>/parser.js`
  - `page_end` 파싱
  - management row 추출
  - Han/IP 필터
  - `data-num - 1` 대상 변환
- `features/<new-feature>/scheduler.js`
  - state fields
  - `start() / stop() / run()`
  - `saveState() / loadState() / ensureRunLoop() / getStatus()`
  - cycle/page logs
  - `nextRunAt` 기반 재실행

즉 구현 완료 기준은
`feature 파일 3개만 만든 상태`가 아니라,
**popup + background + 새 scheduler가 모두 연결된 상태**다.

---

## 예외 처리

### 1. `page_end`를 못 찾음

- 숫자 anchor 최댓값 사용
- 그래도 실패하면 fallback `400`

### 2. 특정 페이지 fetch 실패

- 1회 재시도
- 그래도 실패하면 로그 남기고 다음 페이지로 진행

### 3. 특정 페이지 batch 차단 실패

- 1차 batch 실패 시 로그 남김
- 같은 페이지 대상 `nos[]`를 더 작은 묶음으로 1회 이상 분할 재시도하는 것을 권장
- 분할 재시도 후에도 실패한 묶음만 최종 실패로 기록하고 다음 페이지 계속 진행

이유:

- 한 row 또는 한 요청 크기 문제로
  페이지 전체 대상이 통째로 빠지는 걸 줄이기 위함
- 기존 `ip` 기능도 batch 실패 시 더 작은 단위로 나누는 복구 패턴을 가지고 있음

### 4. 중간에 OFF

- 현재 in-flight 요청만 끝내고 다음 페이지로 안 넘어감

### 5. 브라우저/서비스워커 재시작

- `isRunning`
- `currentPage`
- `lastRunAt`
- `nextRunAt`
- `detectedMaxPage`

정도는 저장/복원하는 게 맞다.

---

## 이번 기능의 핵심 요약

이 기능은 결국 아래 한 줄이다.

> 관리내역 끝 페이지를 먼저 알아낸 뒤, `게시글 + Han 2글자 이상 제목 + IP형 row`를 끝까지 다시 훑고, 페이지마다 대상 row를 한 번에 묶어 6시간 재차단을 주기적으로 수행한다.

즉:

- 최신 게시판 감시기가 아니라
- **관리내역 기반 재차단기**
- 그리고 same-IP 제한 없이 row 기준으로 계속 갱신 차단하는 기능이다.
