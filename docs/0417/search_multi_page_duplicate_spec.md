# 검색 다중 페이지 중복 탐지 확장 스펙

> 작성일: 2026-04-16
> 선행 문서:
> - `docs/0416/reflux_search_duplicate_fallback_plan.md` (1차 수동 역류기 메인 계획)
> - `docs/0416/monitor_reflux_search_duplicate_integration_plan.md` (감시 자동화 연동 계획)

## 1. 문제

현재 검색 중복 탐지는 **page 1만 조회**한다.

검증 코드:
- `features/post/reflux-search-duplicate-broker.js` L.316:
  ```javascript
  const searchUrl = `${SEARCH_BASE_URL}/ajax/getSearch/p/1/n/${SEARCH_RESULT_PAGE_SIZE}/q/${encodedTitle}?jsoncallback=${callbackName}`;
  ```
- `features/comment/comment-reflux-search-duplicate-broker.js` L.270:
  ```javascript
  const searchUrl = `${SEARCH_BASE_URL}/ajax/getSearch/p/1/n/${SEARCH_RESULT_PAGE_SIZE}/q/${encodedTitle}?jsoncallback=${callbackName}`;
  ```
- `SEARCH_RESULT_PAGE_SIZE = 20` (post L.10, comment L.11)

즉 둘 다 `p/1/n/20`으로 고정되어 있다.

---

## 2. 실제 사례

통합검색 결과에서 중복 글이 1페이지에 안 나오고 **2페이지 이상에만 있는 경우**가 실제로 존재한다.

### 사례: "딥시크발 현 상황 정리"

- 1페이지 URL:
  ```
  https://search.dcinside.com/post/sort/latest/q/.EB.94.A5.EC.8B.9C.ED.81.AC.EB.B0.9C.20.ED.98.84.20.EC.83.81.ED.99.A9.20.EC.A0.95.EB.A6.AC
  ```

- 2페이지 URL:
  ```
  https://search.dcinside.com/post/p/2/sort/latest/q/.EB.94.A5.EC.8B.9C.ED.81.AC.EB.B0.9C.20.ED.98.84.20.EC.83.81.ED.99.A9.20.EC.A0.95.EB.A6.AC
  ```

- 스크린샷 확인: 1페이지에는 결과가 별로 없고, 2페이지에 중복 글이 존재
- 더 뒤 페이지까지 넘어서 있는 케이스도 있음

### 왜 이런 일이 생기는가

DC 통합검색은 갤 전체를 대상으로 한다.
같은 제목이지만 **타 갤 결과가 page 1을 채울 수 있다.**

예시:

- 검색어: `딥시크발 현 상황 정리`
- page 1: 반도체 갤, IT 갤, 뉴스 갤 등 타 갤 결과 20건
- page 2: 특이점 갤 결과 (검색 기준 갤 일치) → 여기에 duplicate가 있음

즉 `board_id` 필터를 `page 1` 결과에만 적용하면,
**검색 기준 갤의 과거 글이 타 갤 결과에 밀려서 탐지 실패**할 수 있다.

---

## 3. 현재 1차 문서의 관련 언급

`reflux_search_duplicate_fallback_plan.md` L.716:
```
- 1차 구현은 page 1만 조회하고, 같은 제목이 page 2에만 있는 케이스는 추가 스펙 확보 뒤 확장한다
```

`reflux_search_duplicate_fallback_plan.md` L.1303-1311:
```
- 필수 10: page 2 이상 호출 시 응답 구조가 page 1과 동일한 케이스
- 있으면 좋은 것 3: 같은 제목인데 첫 페이지에는 target gallery가 없고 2페이지에는 있는 케이스
- 있으면 좋은 것 4: meta.pageCount가 실제 "페이지 수"가 아니라 "총 row 수"처럼 보이는지 확인 가능한 샘플
```

즉 1차 문서에서 이미 한계를 인지하고 있었지만, 구체적 확장 설계는 미정이었다.

---

## 4. 확장 설계 방향

### 4.1 기본 원리: target gallery match가 나올 때까지 다음 페이지 조회

page 1 결과에서 `board_id === searchTargetGalleryId`인 row가 하나도 없으면,
page 2를 조회해서 다시 확인한다.

종료 조건:

1. target gallery match를 찾았다 → 더 이상 다음 페이지 불필요
2. 최대 페이지 수에 도달했다 → 중단, negative 처리
3. 해당 페이지에 결과가 0건이다 → 마지막 페이지, 중단
4. API 에러/차단 → 중단

### 4.2 최대 페이지 제한

무한히 페이지를 넘기면 요청 부하가 커진다.

권장 초기값:

- `MAX_SEARCH_PAGES = 3`

이유:

- 실제 관찰 기준 2페이지에서 대부분 잡힌다
- 3페이지까지면 row 60건까지 커버 (20 × 3)
- 그 이상은 비용 대비 효과가 급감한다

### 4.3 조기 종료 최적화

page 1에서 이미 target gallery match가 있으면 page 2를 안 봐도 된다.

즉 실제 추가 요청은:

- **page 1에 target gallery match가 없을 때만** 발생
- 대부분의 검색에서는 page 1에 결과가 있으므로 추가 요청 0회

이게 핵심이다. **매번 여러 페이지를 읽는 게 아니라, 1페이지에 target gallery가 안 보일 때만 추가 확인하는 것.**

### 4.4 구현 방향: `fetchSearchRows()` 확장

현재:
```javascript
async function fetchSearchRows(queueItem) {
  // p/1 고정
  const searchUrl = `${SEARCH_BASE_URL}/ajax/getSearch/p/1/n/${SEARCH_RESULT_PAGE_SIZE}/q/${encodedTitle}?jsoncallback=${callbackName}`;
  // ...
}
```

확장 후:
```javascript
async function fetchSearchRows(queueItem) {
  const allRows = [];

  for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
    const searchUrl = `${SEARCH_BASE_URL}/ajax/getSearch/p/${page}/n/${SEARCH_RESULT_PAGE_SIZE}/q/${encodedTitle}?jsoncallback=${callbackName}`;
    
    const pageRows = await fetchSingleSearchPage(searchUrl, lease);
    allRows.push(...pageRows);
    
    // 조기 종료: target gallery match 발견
    if (hasTargetGalleryMatch(pageRows, queueItem.searchGalleryId)) {
      break;
    }
    
    // 마지막 페이지 도달 (결과 0건 또는 page size 미만)
    if (pageRows.length < SEARCH_RESULT_PAGE_SIZE) {
      break;
    }
    
    // 다음 페이지 전 짧은 delay (rate limit 보호)
    if (page < MAX_SEARCH_PAGES) {
      await delay(INTER_PAGE_DELAY_MS);
    }
  }
  
  return allRows;
}
```

### 4.5 페이지 간 delay

같은 검색어로 연속 페이지를 조회하면 rate limit 위험이 있다.

권장:

- `INTER_PAGE_DELAY_MS = 100`
- 기존 request delay와 합치면 충분한 간격이 확보됨

### 4.6 comment broker에도 동일 적용

comment broker (`comment-reflux-search-duplicate-broker.js`)도 `p/1` 고정이다.
같은 확장이 필요하다.

---

## 5. 확인이 필요한 스펙

이 확장을 실제로 구현하기 전에 아래를 확인해야 한다.

### 필수

1. `getSearch` AJAX API에서 `p/2`, `p/3`을 호출했을 때 응답 구조가 page 1과 동일한지
2. 마지막 페이지를 넘겨서 호출하면 빈 배열이 오는지, 에러가 오는지
3. `meta.pageCount` 또는 `meta.total` 같은 전체 결과 수/페이지 수 메타 정보가 있는지
4. sort 파라미터 (`sort/latest`)가 AJAX API에도 적용 가능한지
   - 현재 AJAX URL에는 sort가 없다
   - web URL에는 `sort/latest`가 있다
   - AJAX에도 넣으면 최신순 정렬이 되는지 확인 필요

### 있으면 좋은 것

5. 같은 제목인데 page 1에는 target gallery 없고 page 2에 있는 실제 AJAX 응답 샘플
6. page 2 이상에서 rate limit / 403 / 429가 page 1보다 더 빨리 걸리는지
7. `n` 파라미터를 20보다 크게 (예: 50, 100) 설정하면 더 많은 결과가 오는지
   - 이게 되면 페이지네이션 대신 `n`을 늘려서 1페이지로 해결할 수도 있다

---

## 6. 대안: `n` 파라미터 확대

만약 `n=50` 또는 `n=100`이 동작한다면,
페이지네이션 대신 **한 번에 더 많은 결과를 받는 방식**이 더 단순하다.

현재: `p/1/n/20` → 20건
대안: `p/1/n/100` → 100건 (확인 필요)

장점:

- 요청 1회로 끝남
- 페이지 간 delay 불필요
- 구현이 단순함

단점:

- 서버가 실제로 `n > 20`을 허용하는지 확인해야 함
- 응답 크기가 커질 수 있음

**이 대안이 가능하면 다중 페이지보다 우선 채택해야 한다.**

---

## 7. 적용 대상

| 파일 | 현재 | 확장 |
|------|------|------|
| `features/post/reflux-search-duplicate-broker.js` L.316 | `p/1/n/20` 고정 | 다중 페이지 또는 `n` 확대 |
| `features/comment/comment-reflux-search-duplicate-broker.js` L.270 | `p/1/n/20` 고정 | 동일 확장 |

---

## 8. 우선순위

1. 먼저 `n` 파라미터 확대가 되는지 테스트
2. 안 되면 다중 페이지 조회 구현
3. 조기 종료 최적화 (`target gallery match 시 중단`)
4. `MAX_SEARCH_PAGES` 초기값 3으로 시작

---

## 9. Daum 검색 Fallback 전략

### 9.1 왜 필요한가

DC 검색의 다중 페이지 확장(Section 4)은 **페이지 수가 합리적일 때만** 유효하다.

실제 사례 (raw.md 기반):

- 검색어: `먹을수있는HBM나옴`
- DC 검색 결과: **120페이지** (page 120까지 페이징 존재)
- page 1~120 전체가 타 갤러리 결과(역류성식도염, 하데스, 팩토리오, 타르코프, FC 온라인 등)
- target gallery(예: 반도체 갤)의 결과가 어디에도 없거나, 훨씬 뒤 페이지에 묻혀 있음

이 경우 `MAX_SEARCH_PAGES = 3` 내에서는 절대 target gallery match를 찾을 수 없고,
그렇다고 120페이지를 전부 조회하면 **rate limit / IP 차단 위험**이 극도로 높다.

→ **외부 검색 엔진(Daum)을 통한 우회 탐지**가 필요하다.

### 9.2 Daum 검색의 장점

Daum은 DC갤러리 게시물을 크롤링/인덱싱한다.

URL 포맷:
```
https://search.daum.net/search?w=tot&q={검색어}&DA=DID
```

예시:
```
https://search.daum.net/search?w=tot&q=%EB%A8%B9%EC%9D%84%EC%88%98%EC%9E%88%EB%8A%94HBM%EB%82%98%EC%98%B4&DA=DID
```

Daum 검색의 특징:

1. **DC 갤러리와 무관한 자체 인덱스** — DC 검색과 결과 순서/구성이 다름
2. **갤러리명이 결과에 노출** — "gall.dcinside.com/mgallery/board/view/?id=XXX"에서 갤 ID 추출 가능
3. **DC 검색과 다른 rate limit 체계** — DC AJAX API 차단과 독립
4. **한 번의 요청으로 다양한 갤러리의 결과를 볼 수 있음**

### 9.3 발동 조건 (Daum Fallback Trigger)

Daum Fallback은 **무조건 실행하는 것이 아니라**, 아래 조건이 동시에 만족될 때만:

1. DC 검색 다중 페이지 조회 완료 (`MAX_SEARCH_PAGES`까지 조회함)
2. target gallery match가 **하나도 없음** (전체 페이지에서 board_id 일치 없음)
3. 조회한 최대 페이지에서 결과가 아직 있음 (`pageRows.length >= SEARCH_RESULT_PAGE_SIZE`)
   → 즉, "아직 더 있는데 우리가 안 봤을 뿐"인 상태

이 3가지가 모두 참이면:
- "DC 검색만으로는 확인 불가, Daum으로 확장 확인" 판정
- Daum 검색 실행

### 9.4 Daum 검색 판정 로직

```
[Daum 검색 결과에서]
  → DC 게시물 링크 추출 (gall.dcinside.com/**/board/view/?id=XXX&no=YYY)
  → URL에서 gallery_id 파싱
  → gallery_id가 target gallery인 게시물이 있는가?
    → YES: 해당 게시물의 제목과 원본 제목 비교
      → 일치하면 duplicate 확정 → 삭제 대상
    → NO: Daum에서도 target gallery 결과 없음 → negative 처리
```

핵심:

- Daum 결과에서 **target gallery의 게시물이 나오면**, 다른 갤러리에도 같은 제목이 존재한다는 뜻
- 그 게시물의 URL에서 `id=` 파라미터로 갤러리 ID, `no=` 파라미터로 글번호를 추출 가능
- **현재 처리 중인 글과 다른 갤의 같은 제목 글이 Daum에 보이면 → 역류기 패턴 확정**

### 9.5 Daum 검색 URL 구성

```javascript
const DAUM_SEARCH_BASE = 'https://search.daum.net/search';

function buildDaumSearchUrl(title) {
  const encodedTitle = encodeURIComponent(title);
  return `${DAUM_SEARCH_BASE}?w=tot&q=${encodedTitle}&DA=DID`;
}
```

### 9.6 Daum 응답 파싱

Daum 검색 결과는 **HTML 페이지**이다. AJAX JSON이 아님.

파싱 방법:

1. HTML 응답을 가져온다
2. 정규식 또는 DOM 파싱으로 DC 게시물 링크를 추출한다

정규식 예시:
```javascript
const DC_LINK_REGEX = /https?:\/\/gall\.dcinside\.com\/(mgallery\/|mini\/)?board\/view\/\?id=([a-zA-Z0-9_]+)&(?:amp;)?no=(\d+)/g;
```

추출 결과:
```javascript
// match[2] = gallery_id
// match[3] = post_no
```

갤러리 종류별 URL 패턴:
- 일반갤: `gall.dcinside.com/board/view/?id=XXX`
- 마이너갤: `gall.dcinside.com/mgallery/board/view/?id=XXX`
- 미니갤: `gall.dcinside.com/mini/board/view/?id=XXX`

### 9.7 판정 기준

```javascript
function isDaumDuplicate(daumResults, currentPost, targetGalleryId) {
  for (const result of daumResults) {
    // 현재 처리 중인 글 자체는 제외
    if (result.galleryId === targetGalleryId && result.postNo === currentPost.no) {
      continue;
    }
    
    // 다른 갤러리에 같은 제목의 글이 존재
    if (result.galleryId !== targetGalleryId) {
      // 제목 유사도 확인 (정확 일치 또는 high similarity)
      if (isTitleMatch(result.title, currentPost.title)) {
        return {
          isDuplicate: true,
          sourceGallery: result.galleryId,
          sourcePostNo: result.postNo
        };
      }
    }
  }
  
  return { isDuplicate: false };
}
```

### 9.8 Rate Limit 및 안전장치

| 항목 | 값 | 이유 |
|------|-----|------|
| Daum 요청 간 delay | `300ms + 50ms jitter` | Daum 검색은 DC보다 보수적으로 |
| 동일 제목 Daum 캐시 TTL | `5분` | 같은 역류기 공격 내 반복 방지 |
| Daum 요청 실패 시 | skip, DC 결과만으로 판정 | Daum은 보조 수단, 실패해도 전체 중단 안 함 |
| Daum 연속 실패 3회 이상 | Daum Fallback 비활성화 (세션 내) | IP 차단 가능성 대비 |

### 9.9 전체 의사결정 플로우

```
1. DC 검색 page 1 조회
   ├── target gallery match 있음 → duplicate 판정 완료
   └── target gallery match 없음 → page 2 조회
       ├── target gallery match 있음 → duplicate 판정 완료
       └── target gallery match 없음 → page 3 조회
           ├── target gallery match 있음 → duplicate 판정 완료
           └── target gallery match 없음
               ├── page 3에 결과 < PAGE_SIZE → 마지막 페이지, negative
               └── page 3에 결과 >= PAGE_SIZE → "더 있을 수 있음"
                   └── Daum Fallback 실행
                       ├── target gallery 외 갤에 같은 제목 있음 → duplicate
                       ├── Daum에서도 없음 → negative
                       └── Daum 요청 실패 → negative (안전하게)
```

---

## 10. 실사례 증거

### 10.1 DC 검색 120페이지 사례

검색어: `먹을수있는HBM나옴`

- raw.md 소스에서 확인된 페이징 HTML:
  ```
  page 111, 112, 113, ... 120 (현재 페이지)
  ```
- page 120에도 결과가 존재하며 target gallery(반도체 갤) 결과는 보이지 않음
- 25건 모두 타 갤러리: 역류성식도염, 하데스, 프로미스나인, 팩토리오 등
- **이 사례는 다중 페이지 3페이지 확장만으로 해결 불가능** → Daum Fallback 필요성 입증

### 10.2 DC 검색 2페이지 사례

검색어: `딥시크발 현 상황 정리` (Section 2에서 기술)

- page 1에 target gallery 결과 없음
- page 2에 target gallery 결과 존재
- **이 사례는 다중 페이지 확장으로 해결 가능**

---

## 11. 전체 플로우 요약

```
[게시물 제목으로 DC 검색]
  │
  ├─ Step 1: n 파라미터 확대 가능? (Section 6)
  │   ├── YES → p/1/n/100으로 1회 조회, 이하 동일
  │   └── NO → Step 2로
  │
  ├─ Step 2: 다중 페이지 조회 (Section 4)
  │   ├── page 1 → target match? → YES → done
  │   ├── page 2 → target match? → YES → done
  │   ├── page 3 → target match? → YES → done
  │   └── 3페이지까지 target match 없음
  │       ├── 결과 부족 (< PAGE_SIZE) → negative, done
  │       └── 결과 충분 (>= PAGE_SIZE) → Step 3으로
  │
  └─ Step 3: Daum Fallback (Section 9)
      ├── Daum 검색 실행
      ├── DC 게시물 링크 추출
      ├── target gallery 외 갤에 같은 제목 → duplicate 확정
      ├── 없음 → negative
      └── 실패 → negative (안전하게)
```

---

## 12. 구현 우선순위 (최종)

1. `n` 파라미터 확대 테스트 (가능하면 가장 간단한 해결)
2. 다중 페이지 조회 구현 (`MAX_SEARCH_PAGES = 3`)
3. 조기 종료 최적화
4. Daum Fallback 구현 (HTML 파싱 + 링크 추출)
5. Daum 캐시 + 실패 카운터 + 자동 비활성화
