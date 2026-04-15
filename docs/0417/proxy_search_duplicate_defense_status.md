# 프록시 + 통합검색 역류 방어 — 준비 현황 (2026-04-17)

## 1. 현재 상태 (커밋 `6aa7191`)

### 1-1. getSearch JSONP 방식 (이미 머지됨 ✅)

| 파일 | 역할 |
|------|------|
| `features/post/reflux-search-duplicate-broker.js` | 검색 큐 + 캐시 + 워커 (단일 worker, 비동기 큐) |
| `features/post/reflux-search-duplicate-parser.js` | getSearch JSONP 응답 파서 |
| `features/post/attack-mode.js` | `normalizeSemiconductorRefluxTitle()`, `buildSemiconductorRefluxSearchQuery()` |
| `background/background.js` | broker 초기화, 세션 제어 |
| `popup/popup.html + popup.js` | 역류 검색 갤 ID 설정 UI |
| `manifest.json` | `search.dcinside.com` 호스트 권한 추가 |

**동작 흐름:**
```
유동글 수집 → normalizeTitle → 로컬캐시/dataset 먼저 확인
  ↓ miss
enqueueRefluxSearchDuplicate() → 큐 적재
  ↓
워커: sleepWithJitter(100ms, 30ms) → fetchSearchRows()
  → getSearch JSONP (search.dcinside.com/ajax/getSearch/...)
  → parseRefluxSearchDuplicateJsonp()
  → findDuplicateMatch() (같은 갤 + 같은 정규화 제목 + 다른 번호)
  ↓
positive → 캐시 24h → 역류 판정
negative → 캐시 60s → 다음 폴링에 재검사
error    → 쿨다운 30s → 재시도
```

**한계점:**
- getSearch는 **확장 프로그램 내부 fetch** 사용 → 사용자 IP 그대로 노출
- IP 차단 당하면 검색 자체가 불가
- 결과가 부정확하거나 빈 배열인 경우 있음 (JSONP 구조 변동 가능)

---

### 1-2. 통합검색 HTML + 프록시 방식 (테스트 완료 ✅, 미구현)

테스트 스크립트: `scripts/test-proxy-search-duplicate.mjs`

**테스트 결과 (2026-04-16 05:14 KST):**

| 항목 | 결과 |
|------|------|
| 프록시 획득 | ✅ Webshare API → 10개 유효 프록시 (GB/US/JP/DE) |
| 갤러리 파싱 | ✅ 50개 전체, 9개 유동글 |
| 통합검색 HTML 파싱 | ✅ `sch_result_list > li` 에서 boardId, postNo, title, gallName, datetime 추출 |
| 프록시 라운드로빈 | ✅ 9건 × 9개 다른 프록시 IP |
| 응답 속도 | 2~3초/건 (프록시 경유) |
| 정상 검색 | 7/9건 성공 (200 OK, 12~20건 파싱) |
| 오류 | 2/9건 → 괄호 `()` URL 인코딩 누락으로 400 에러 (패치 완료) |

**상세 로그 (발췌):**
```
"덕테이프로 만든 스포츠카드들" → 프록시 응답: 200, body길이=55129, 파싱결과: 20건
  → [thesingularity] #1110326 "덕테이프로 만든 스포츠카드들" ← 자기자신
  → [thesingularity] #1110318 "마스킹테잎으로 만든 스포츠카드" ← 같은 갤 다른 글
  → [zuttomayo] #406781 "로킹 온 재팬..." ← 다른 갤

"절ᅠ반ᅠ만 맞다는 건 반으로 잘라버려도 된다는ᅠ뜻이지?" → 파싱결과: 12건
  → [thesingularity] #1110267 "절반만 맞다는 건 반으로 잘라버려도 된다는 뜻이지?"
  ↑ 한글 필러(ᅠ) 제거 후 동일 제목 → DUPLICATE 판정해야 함
```

---

## 2. 발견된 버그 & 패치 (패치 적용 완료)

### 버그 1: 괄호 URL 인코딩 누락 → DC 서버 400

**원인:** `encodeURIComponent`는 `( ) ! * '` 를 인코딩하지 않음  
**증상:** 제목에 `)`나 `(`가 있으면 DC 서버가 400 반환  
**패치:**
```javascript
function dcUrlEncode(text) {
  let encoded = encodeURIComponent(text);
  // encodeURIComponent가 빠뜨리는 문자들 수동 인코딩
  encoded = encoded
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27');
  // %XX → .XX 로 변환 (DC 전용 형식)
  return encoded.replace(/%/g, '.');
}
```

### 버그 2: 한글 필러(ᅠ) 우회 → 중복 못 잡음

**원인:** 역류기가 제목에 `ᅠ`(U+3164) 끼워넣어 정규화 우회  
**증상:** `"절ᅠ반ᅠ만 맞다는..."` ≠ `"절반만 맞다는..."` → UNIQUE 판정  
**패치:**
```javascript
function normalizeForDup(text) {
  return normalizeText(text)
    .replace(/[\u3164\uFFA0]/g, '')           // 한글 필러
    .replace(/[\u115F\u1160]/g, '')           // 초성/중성 필러
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, '')  // Zero-Width
    .replace(/\s+/g, ' ')
    .trim();
}
```

> ⚠️ **이 normalizeForDup은 기존 `normalizeSemiconductorRefluxTitle()`에도 반영해야 함**  
> 현재 `attack-mode.js`의 정규화 함수에 필러 제거가 빠져있을 수 있음 → 확인 필요

---

## 3. 아키텍처: 통합검색 HTML 프록시 방식 (향후 붙일 때)

### 3-1. URL 형식

```
https://search.dcinside.com/combine/q/{dcUrlEncode(제목)}
```

DC 전용 인코딩: UTF-8 바이트 각각을 `.XX` 형태로 (% 대신 .)
```
"씨드림" → .EC.94.A8.EB.93.9C.EB.A6.BC
"5.0"   → 5.2E0
"?"     → .3F
```

### 3-2. 응답 HTML 파싱 구조

```html
<ul class="sch_result_list">
  <li>
    <a href="https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1108445"
       class="tit_txt"><b>씨드림</b> <b>5.0</b> <b>좆된</b><b>거</b> <b>아니냐</b>? ㅋㅋ</a>
    <p class="link_dsc_txt">본문 요약...</p>
    <p class="link_dsc_txt dsc_sub">
      <a class="sub_txt">특이점이 온다 갤러리</a>
      <span class="date_time">2026.04.15 21:18</span>
    </p>
  </li>
</ul>
```

**추출 코드:**
```javascript
function parseSearchResults(html) {
  const results = [];
  const listMatch = html.match(/<ul\s+class="sch_result_list">([\s\S]*?)<\/ul>/);
  if (!listMatch) return results;

  const liRegex = /<li>([\s\S]*?)<\/li>/g;
  let match;

  while ((match = liRegex.exec(listMatch[1])) !== null) {
    const liHtml = match[1];

    // 제목 + 링크
    const titleMatch = liHtml.match(/<a\s+href="([^"]*)"[^>]*class="tit_txt"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    const href = decodeHtml(titleMatch[1]);
    const title = normalizeText(titleMatch[2].replace(/<[^>]*>/g, ''));

    // URL에서 id, no 추출
    const idMatch = href.match(/[?&]id=([^&]+)/);
    const noMatch = href.match(/[?&]no=(\d+)/);
    const boardId = idMatch ? idMatch[1] : '';
    const postNo = noMatch ? parseInt(noMatch[1], 10) : 0;

    // 갤러리 이름
    const gallNameMatch = liHtml.match(/<a[^>]*class="sub_txt"[^>]*>([\s\S]*?)<\/a>/);
    const gallName = gallNameMatch ? normalizeText(gallNameMatch[1]) : '';

    // 날짜
    const dateMatch = liHtml.match(/<span\s+class="date_time">([\s\S]*?)<\/span>/);
    const datetime = dateMatch ? normalizeText(dateMatch[1]) : '';

    results.push({ title, boardId, postNo, gallName, datetime, href });
  }
  return results;
}
```

### 3-3. Webshare 프록시 API

```
GET https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100
Authorization: Token {WEBSHARE_API_KEY}

응답:
{
  "results": [{
    "proxy_address": "31.59.20.176",
    "port": 6754,
    "username": "xrsyzbko",
    "password": "0xp5mk5kq95p",
    "valid": true,
    "country_code": "GB"
  }, ...]
}
```

**프록시를 통한 HTTP 요청 (HTTP proxy 방식):**
```javascript
function httpGetViaProxy(targetUrl, proxy) {
  const parsed = new URL(targetUrl);
  const proxyAuth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');

  const options = {
    hostname: proxy.host,
    port: proxy.port,
    path: targetUrl,        // 전체 URL을 path로 (HTTP proxy 방식)
    method: 'GET',
    headers: {
      'Host': parsed.hostname,
      'Proxy-Authorization': `Basic ${proxyAuth}`,
      'User-Agent': 'Mozilla/5.0 ...',
      'Accept-Encoding': 'identity',
    }
  };

  // http.request (NOT https) — HTTP proxy는 http 모듈 사용
  return http.request(options, ...);
}
```

> ⚠️ **HTTPS CONNECT 방식은 Webshare 무료 플랜에서 402 반환됨**  
> HTTP proxy 방식으로 HTTPS URL을 path에 넣는 방식이 동작함

### 3-4. 중복 판정 로직

```javascript
function checkDuplicates(currentPost, searchResults) {
  const currentNorm = normalizeForDup(currentPost.subject);

  for (const result of searchResults) {
    const resultNorm = normalizeForDup(result.title);

    if (result.boardId === SEARCH_TARGET_GALLERY_ID  // 같은 갤
        && resultNorm === currentNorm                 // 같은 제목 (필러 제거)
        && result.postNo !== currentPost.no) {        // 다른 번호
      return result; // DUPLICATE
    }
  }
  return null; // UNIQUE
}
```

---

## 4. 교체 분석: getSearch → 통합검색+프록시 전환 시 코드 플로우

### 4-1. 현재 전체 실행 체인 (코드 추적)

```
scheduler.js  L.398: run() 메인루프
  │
  ├─ L.433: parseFluidPosts(html) → 유동글 파싱
  │
  ├─ L.439: shouldUseSearchDuplicate = true  (수동 + 역류기 모드일 때)
  │    └─ L.441: filterRefluxCandidatePosts(basePosts, context)
  │
  ▼
scheduler.js  L.748-831: filterRefluxCandidatePosts()
  │
  ├─ L.768: getRefluxSearchDuplicatePositiveDecision() → hotset 확인 (메모리)
  ├─ L.778: hasSemiconductorRefluxTitle() → dataset 확인
  ├─ L.784: getRefluxSearchDuplicateDecision() → cache 확인 (positive/negative/pending/error)
  └─ L.817: enqueueRefluxSearchDuplicate() → ⭐ 큐 적재
  │
  ▼
broker.js  L.146: enqueueRefluxSearchDuplicate()
  → 큐에 push → ensureWorkerRunning()
  │
  ▼
broker.js  L.194: runWorker() → processQueueItem()
  │
  ▼
broker.js  L.288: fetchSearchRows()  ← ⭐⭐⭐ 교체 지점 (여기만 바꾸면 됨)
  │  현재: getSearch JSONP URL 생성
  │  현재: fetch(searchUrl, { credentials: 'include' })  ← 사용자 IP 노출
  │  현재: parseRefluxSearchDuplicateJsonp(responseText)
  │
  ▼
broker.js  L.311: findDuplicateMatch(searchRows, queueItem)
  → 같은 갤 + 같은 normalizedTitle + 다른 postNo → positive/negative
  │
  ▼
broker.js  L.226-261: 캐시 저장
  → positive: 24h TTL
  → negative: 60s TTL
  → error: 30s 쿨다운
```

### 4-2. 교체 대상과 유지 대상

**교체해야 하는 것 (최소 범위):**

| 파일 | 위치 | 변경 내용 |
|------|------|----------|
| `broker.js` | `fetchSearchRows()` L.288-308 | URL을 `/combine/q/`로, fetch를 프록시 경유로, 파서를 HTML 파서로 |
| `parser.js` | 신규 함수 추가 | `parseSearchResultsHtml()` — `sch_result_list > li` HTML 파싱 |
| 신규 모듈 | `proxy-manager.js` 등 | 프록시 리스트 관리, 라운드로빈, 주기적 갱신 |
| `manifest.json` | 호스트 권한 | `proxy.webshare.io` 추가 |

**안 바꿔도 되는 것 (인터페이스 동일):**

| 유지 대상 | 이유 |
|-----------|------|
| `scheduler.js` **전체** | broker API(`enqueue/getDecision/shouldEnqueue`)가 안 바뀜 |
| `filterRefluxCandidatePosts()` | broker 함수 호출만 하므로 변경 없음 |
| 캐시 로직 전체 | positive/negative/error TTL 그대로 |
| `findDuplicateMatch()` | 입력이 `{normalizedTitle, boardId, postNo}` — 파서만 이 형태로 내보내면 됨 |
| `encodeSearchKeywordPath()` | 이미 `.XX` 형태 DC 인코딩 → combine URL에도 그대로 사용 가능 |
| 큐/워커/generation 관리 | 교체와 무관 |
| UI (popup) | 설정 저장 구조 동일 |

### 4-3. fetchSearchRows() 교체 before/after

```javascript
// ─── BEFORE: getSearch JSONP (broker.js L.288-308) ─────────────
async function fetchSearchRows(queueItem) {
  const callbackName = `jsonpCallback_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const encodedTitle = encodeSearchKeywordPath(queueItem.searchQuery);
  const searchUrl = `${SEARCH_BASE_URL}/ajax/getSearch/p/1/n/${SEARCH_RESULT_PAGE_SIZE}/q/${encodedTitle}?jsoncallback=${callbackName}`;

  return withDcRequestLease({ feature: 'post', kind: 'searchDuplicate' }, async (lease) => {
    const response = await fetch(searchUrl, {      // ← 사용자 IP
      credentials: 'include',
      signal: lease.signal,
    });
    const responseText = await response.text();
    return parseRefluxSearchDuplicateJsonp(responseText);  // ← JSONP 파서
  });
}

// ─── AFTER: 통합검색 HTML + 프록시 ─────────────────────────────
async function fetchSearchRows(queueItem) {
  const encodedTitle = encodeSearchKeywordPath(queueItem.searchQuery);
  const searchUrl = `${SEARCH_BASE_URL}/combine/q/${encodedTitle}`;  // ← 통합검색 URL
  const proxy = proxyManager.getNextProxy();                          // ← 프록시 라운드로빈

  const responseText = await fetchViaProxy(searchUrl, proxy);        // ← 프록시 경유
  return parseSearchResultsHtml(responseText);                        // ← HTML 파서
}
```

**핵심**: `fetchSearchRows()`의 **반환 형태**가 동일하면 됨:
```typescript
// 두 파서 모두 이 형태의 배열을 반환해야 함
{ normalizedTitle: string, boardId: string, postNo: number, href: string }[]
```

`findDuplicateMatch()`가 이 형태를 입력으로 받으므로, 파서 출력만 맞추면 체인 전체가 동작함.

### 4-4. 크롬 확장프로그램에서 프록시 사용 시 주의점

확장프로그램 background(service worker)에서 프록시를 경유하려면:

1. **`fetch()`로는 HTTP 프록시를 직접 쓸 수 없음** — 브라우저 fetch는 시스템 프록시 or `chrome.proxy` API만 사용
2. **방법 A**: `chrome.proxy.settings`로 전역 프록시 설정 → 부작용 큼 (다른 탭도 영향)
3. **방법 B (권장)**: background에서 **외부 프록시 서비스의 HTTP API**를 직접 호출
   - Webshare는 `http://username:password@proxy_address:port` 형태
   - background fetch에서 직접 HTTPS 타겟으로 요청하되, 프록시 미들웨어를 거치게 구성
4. **방법 C**: Node.js 로컬 프록시 브릿지를 별도로 띄우고, 확장에서 localhost:PORT로 요청

> ⚠️ 실제 구현 시 방법 B 또는 C 중 택 1 결정 필요

---

## 5. 향후 전환 시나리오

### 시나리오 A: getSearch 유지 + 통합검색 fallback

```
유동글 제목 → getSearch JSONP (현재 방식, 브라우저 fetch)
  ↓ 실패 or IP 차단
통합검색 HTML + 프록시 (fallback)
```

- 장점: 평소에는 가볍고, 차단 시에만 프록시 사용
- 단점: 두 파서 관리

### 시나리오 B: 통합검색 HTML + 프록시 전환

```
유동글 제목 → background에서 프록시 경유 통합검색 HTML
  → parseSearchResults() → 중복 판정
```

- 장점: IP 차단 원천 차단
- 단점: 프록시 비용 (250GB bandwidth), 응답 2~3초

### 붙일 때 TODO

1. `reflux-search-duplicate-broker.js`의 `fetchSearchRows()` L.288-308 교체
2. `reflux-search-duplicate-parser.js`에 `parseSearchResultsHtml()` 함수 추가
3. `proxy-manager.js` 신규 모듈 — Webshare API 호출 + 라운드로빈 + 주기적 갱신
4. `normalizeForDup()` (필러 제거)를 `normalizeSemiconductorRefluxTitle()`에 반영
5. manifest에 `proxy.webshare.io` 호스트 권한 추가
6. 프록시 API key를 `chrome.storage.sync` 또는 설정에서 관리
7. 크롬 확장 background에서 프록시 경유 방식 결정 (§4-4 참조)

---

## 6. 테스트 스크립트 사용법

```bash
# 실행 (Node.js 18+)
node scripts/test-proxy-search-duplicate.mjs

# 설정 변경 (스크립트 상단)
WEBSHARE_API_KEY = '...'        # Webshare API 키
GALLERY_ID = 'thesingularity'   # 대상 갤러리 ID
MAX_SEARCH_TITLES = 50          # 테스트할 제목 수
REQUEST_DELAY_MS = 100          # 요청 간 딜레이
```

---

## 7. 파일 목록

| 파일 | 상태 | 용도 |
|------|------|------|
| `features/post/reflux-search-duplicate-broker.js` | ✅ 머지됨 | getSearch JSONP 브로커 |
| `features/post/reflux-search-duplicate-parser.js` | ✅ 머지됨 | getSearch JSONP 파서 |
| `features/post/attack-mode.js` | ✅ 머지됨 | 정규화 + 쿼리 빌더 |
| `scripts/test-proxy-search-duplicate.mjs` | 🧪 테스트 | 통합검색 HTML + 프록시 테스트 |
| `docs/0416/reflux_search_duplicate_fallback_plan.md` | 📋 설계 | 전체 설계 계획 |
| `docs/0417/proxy_search_duplicate_defense_status.md` | 📋 현황 | **이 문서** |
