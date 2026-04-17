# 0417 Reflux Overlay Webshare Proxy Bridge 구현 문서

## 0. 문서 목적

이 문서는 `임시 overlay 수집`의 `proxy_bridge`를 **실제로 바로 패치 가능한 수준**으로 고정한 구현 문서다.

이번 문서에서 확정하는 범위는 아래 둘이다.

1. 확장 `refluxOverlayCollector`가 `proxy_bridge` 모드로 실제 동작하게 만들기
2. Webshare 프록시를 **확장 내부가 아니라 localhost Node bridge**를 통해 사용하게 만들기

이번 문서는 “아이디어 메모”가 아니라, **어느 파일을 어떻게 바꾸고 왜 그렇게 해야 하는지**를 실제 코드 기준으로 적는다.

---

## 1. 결론 요약

최종 구현안은 아래 한 줄이다.

`popup transport=proxy_bridge` -> `background scheduler` -> `localhost bridge (127.0.0.1:4318)` -> `Webshare proxy` -> `DC 목록 HTML`

즉, 확장 서비스워커가 Webshare HTTP 프록시를 직접 다루는 방식이 아니라,
**로컬 Node bridge가 프록시 인증과 라운드로빈을 맡고**, 확장은 localhost JSON만 호출한다.

이렇게 정한 이유는 단순하다.

1. 현재 확장 코드에서 `proxy_bridge`는 placeholder라서 바로 예외를 던진다.
2. 브라우저 `fetch()`는 Node처럼 요청마다 `Proxy-Authorization` 붙여 HTTP proxy를 직접 타는 구조가 아니다.
3. Webshare는 실제로 동작한다는 걸 이미 실검증했다.
4. 기존 코드에도 localhost helper 보안 패턴이 이미 있다.

예시:

- 지금 상태: `proxy_bridge` 선택 -> 시작 버튼 누름 -> 바로 “아직 연결되지 않았습니다.”
- 패치 후: `proxy_bridge` 선택 + 로컬 bridge 실행 -> anchor locate부터 페이지 수집까지 Webshare 경유

---

## 2. 실제 코드 기준 현재 상태

### 2.1 이미 있는 것

아래는 이미 구현되어 있다.

1. popup에 `transportMode`와 `proxyWorkerCount` 입력이 있다.
   - `popup/popup.html:907-915`
   - `popup/popup.js:1173-1182`
   - `popup/popup.js:2571-2578`
2. overlay collector 설정에는 이미 `transportMode`, `proxyWorkerCount`가 있다.
   - `features/reflux-overlay-collector/api.js:3-12`
   - `features/reflux-overlay-collector/api.js:17-27`
3. background에는 overlay scheduler가 이미 등록되어 있고 상태 복원 경로도 이미 연결되어 있다.
   - `background/background.js:86-106`
   - `background/background.js:204-220`
4. overlay collector는 이미 `busy feature` 목록에도 들어 있다.
   - `background/background.js:1265-1316`
5. popup은 실행 중일 때 overlay 설정 입력을 비활성화한다.
   - `popup/popup.js:2571-2579`
   - `popup/popup.js:3791-3800`

즉, UI와 설정 저장선은 이미 절반 깔려 있다.

### 2.2 아직 안 된 것

아래는 아직 구현되어 있지 않다.

1. `proxy_bridge` transport는 실제 fetch를 안 하고 바로 throw 한다.
   - `features/reflux-overlay-collector/transport.js:15-23`
2. scheduler는 시작 전에 `proxy_bridge`를 강제로 막는다.
   - `features/reflux-overlay-collector/scheduler.js:67-79`
3. scheduler run 본문에서도 `proxy_bridge`면 다시 throw 한다.
   - `features/reflux-overlay-collector/scheduler.js:173-176`
4. 현재 페이지 수집은 무조건 순차 `for` 루프다.
   - `features/reflux-overlay-collector/scheduler.js:178-219`
5. root manifest에는 localhost host permission이 없다.
   - `manifest.json:15-21`
6. overlay 설정에는 `maxRetriesPerPage`가 있지만 popup에는 입력칸이 없다.
   - `features/reflux-overlay-collector/api.js:11`
   - `popup/popup.js:3117-3125`

### 2.3 이번 검토에서 새로 확인한 필수 보정 포인트

이번 문서를 실제 코드와 다시 대조하면서, 아래 4개는 **문서에 반드시 반영해야 하는 이슈**로 확정했다.

1. 병렬 worker가 각자 `saveState()`를 치면 `chrome.storage.local.set()`가 서로 덮어써서 최신 카운트/로그가 역주행할 수 있다.
   - 현재 `saveState()`는 순차 루프 전제라 병렬 보호가 없다.
   - `features/reflux-overlay-collector/scheduler.js:293-321`
2. `stop()`은 지금 단순히 `isRunning=false`만 바꾸므로, proxy mode에서 여러 in-flight fetch가 동시에 떠 있으면 즉시 멈추지 못한다.
   - `features/reflux-overlay-collector/scheduler.js:120-131`
   - `features/reflux-overlay-collector/scheduler.js:178-219`
3. locate 쪽과 bridge 쪽이 동시에 retry를 가지면 `maxRetries`가 곱연산처럼 중첩될 수 있다.
   - `features/reflux-dataset-collector/page-locator.js:229-274`
   - `features/reflux-overlay-collector/api.js:11`
4. background에는 overlay 전용 `updateConfig` running block이 아직 없다.
   - popup은 막고 있지만, background API 자체는 막지 않는다.
   - `background/background.js:644-724`
   - `background/background.js:1323-1430`
5. `AbortController`를 넣을 경우, `AbortError`를 일반 실패로 누적하면 안 된다.
   - 현재 구조에서는 locate abort가 outer catch로 바로 떨어지면 `FAILED`로 끝날 수 있다.
   - `features/reflux-overlay-collector/scheduler.js:134-282`

### 2.4 이번에 추가로 발견한 중요한 연결 이슈

이게 제일 중요하다.

현재 overlay 수집은 “목록 수집 부분만” 문제가 있는 게 아니다.
그 전에 도는 `anchor page locate`도 현재는 direct fetch 기반이다.

근거:

1. scheduler는 locate 단계에서 바로 `locateBoardListPageFromViewUrl()`를 호출한다.
   - `features/reflux-overlay-collector/scheduler.js:142-150`
2. page locator 내부는 `fetchBoardListHtml()`로 목록 HTML을 가져온다.
   - `features/reflux-dataset-collector/page-locator.js:323-346`
3. 그 `fetchBoardListHtml()` 기본 구현은 결국 `globalThis.fetch` direct 호출이다.
   - `features/reflux-dataset-collector/page-locator.js:229-274`

즉, transport만 바꾸고 locate는 그대로 두면 아래처럼 된다.

- anchor locate: direct
- target page window 수집: proxy

이건 반쪽짜리 구현이다.

이번 패치는 **locate 단계까지 proxy bridge로 태워야 완성**이다.

---

## 3. 외부 사실 실검증 결과

2026-04-17 기준, 제공된 Webshare API 정보로 아래를 실검증했다.

1. Webshare proxy list API 호출 성공
   - 공식 문서: `https://apidocs.webshare.io/proxy-list/list`
   - 결과: `200 OK`
   - 결과 count: `10`
   - 첫 프록시 상태: `valid=true`, `proxy_address/port/username/password` 전부 존재
2. Webshare direct proxy를 통한 DC 목록 HTML 요청 성공
   - 대상: `https://gall.dcinside.com/mgallery/board/lists/?id=war&page=1`
   - 결과: `200 OK`
   - body 길이 약 `196418`
   - 목록 HTML signature 확인: `gall_list`, `ub-content` 존재

이 말은 곧 아래가 사실이라는 뜻이다.

1. API 키 자체는 유효하다.
2. Webshare proxy list API에서 바로 프록시 인증정보를 받아올 수 있다.
3. Node `http.request()` + `Proxy-Authorization` 방식으로 DC 목록 HTML을 실제로 가져올 수 있다.
4. 따라서 문제는 Webshare가 아니라 **확장과 Node bridge 연결부 미구현**이다.

추가 메모:

Webshare proxy list 응답 자체에 `username`, `password`가 들어오므로,
이번 구현에서 screenshot의 프록시 ID/PW를 popup에 따로 입력받을 필요는 없다.

---

## 4. 최종 설계 결정

### 4.1 왜 localhost bridge로 가는가

이번 구현은 `localhost bridge`로 고정한다.

이유:

1. Webshare는 HTTP proxy 방식이다.
2. 현재 확장 background fetch는 Node처럼 요청마다 임의 proxy host와 `Proxy-Authorization`를 넣어 직접 보내는 구조가 아니다.
3. API 키를 확장 안에 넣으면 보안상 바로 나빠진다.
4. 반대로 localhost bridge는 API 키를 로컬 Node 프로세스에만 두고, 확장은 `http://127.0.0.1:4318`만 호출하면 된다.

쉽게 말하면:

- 나쁜 구조: 확장 안에 Webshare 비밀키와 proxy 비밀번호 넣기
- 좋은 구조: 확장은 localhost에 “이 페이지 HTML 좀 가져와”만 요청하고, 비밀 정보는 bridge가 들고 있기

### 4.2 포트는 왜 4318인가

`projects/dc_auto_bot` helper는 이미 기본 포트 `4317`을 쓴다.

근거:

- `projects/dc_auto_bot/helper/server.mjs:13-14`
- `projects/dc_auto_bot/background/api.js:17`

그래서 이번 bridge는 기본 포트를 `4318`로 고정한다.

이유는 단순하다.

- `4317` 재사용 시 기존 helper와 충돌 가능
- 충돌 나면 어떤 helper가 죽었는지 운영자가 바로 구분하기도 어려움

### 4.3 이번 패치에서 의도적으로 안 하는 것

이번 패치에서는 아래는 하지 않는다.

1. Webshare API 키를 확장 설정 UI에 저장하기
2. bridge 프로세스를 확장이 자동 실행하기
3. 외부 공개 bridge 운영하기

이유:

1. 비밀키를 확장 storage에 넣는 건 보안상 불리하다.
2. 크롬 확장이 로컬 Node 프로세스를 스스로 안전하게 띄우는 구조는 별도 런처 문제가 생긴다.
3. 이번 목표는 “`proxy_bridge` 연결”이지 “로컬 프로세스 매니저”가 아니다.

---

## 5. 실제 패치 범위

이번 패치에서 바꾸는 파일과 역할은 아래로 고정한다.

### 5.1 수정 파일

1. `manifest.json`
   - localhost host permission 추가
2. `features/reflux-dataset-collector/page-locator.js`
   - locate 단계도 custom board-list fetch를 주입받을 수 있게 확장
3. `features/reflux-overlay-collector/transport.js`
   - proxy bridge transport 실제 구현
4. `features/reflux-overlay-collector/scheduler.js`
   - `proxy_bridge` 차단 제거
   - start 시 bridge readiness 확인
   - locate 단계에 proxy transport 연결
   - proxy mode에서 worker pool 기반 병렬 수집
   - 병렬 `saveState()` 직렬화
   - stop 시 abort controller 정리
5. `background/background.js`
   - overlay 실행 중 설정 변경 차단 추가

### 5.2 신규 파일

1. `scripts/reflux-overlay-proxy-bridge.mjs`
   - Webshare proxy list fetch
   - proxy round-robin
   - DC 목록 HTML proxy fetch
   - localhost JSON API 서버

### 5.3 의도적으로 안 건드리는 파일

아래는 이번 패치에서 그대로 둔다.

1. `popup/popup.html`
2. `popup/popup.js`
3. `features/reflux-overlay-collector/api.js`

이유:

1. `transportMode`와 `proxyWorkerCount` UI는 이미 있음
2. overlay scheduler 등록/복원선도 이미 있음
3. `maxRetriesPerPage`는 hidden internal default로 유지해도 1차 구현은 가능함
4. fixed localhost endpoint를 쓰면 popup에 bridge URL 입력칸을 새로 만들 필요가 없음
5. 구조 변경 범위를 줄이면 파생 리스크가 적음

즉, 이번 패치는 **기존 UI 위에 실제 동작만 붙이는 최소 변경**으로 간다.

---

## 6. 구현 상세

## 6.1 bridge 서버 스펙

파일:

- `scripts/reflux-overlay-proxy-bridge.mjs`

기본 실행:

```bash
node scripts/reflux-overlay-proxy-bridge.mjs
```

환경변수 override 예시:

```bash
WEBSHARE_API_KEY=... node scripts/reflux-overlay-proxy-bridge.mjs
```

기본 바인딩:

- host: `127.0.0.1`
- port: `4318`

루프백만 허용한다.

이유:

1. 로컬 전용 bridge다.
2. 외부 바인딩하면 Webshare 키를 가진 프록시 relay가 되어버린다.

예시:

- 허용: `127.0.0.1:4318`
- 허용: `localhost:4318`
- 금지: `0.0.0.0:4318`

bridge는 JSON API로 동작하므로 아래도 같이 넣는다.

1. `Content-Type: application/json`
2. `Access-Control-Allow-Origin: *`
3. `OPTIONS` 처리

이유:

1. 확장 background fetch에서는 보통 큰 문제 없더라도,
2. 로컬 테스트와 후속 확장 시 불필요한 preflight/CORS 이슈를 줄일 수 있다.

### 6.1.1 bridge endpoint

1. `GET /health`
2. `POST /reflux-overlay/fetch-board-list`

#### `GET /health`

응답 예시:

```json
{
  "success": true,
  "status": "ok",
  "proxyCount": 10,
  "lastProxyRefreshAt": "2026-04-17T10:15:00.000Z"
}
```

용도:

1. start 직전 readiness 확인
2. 실제 사용 가능한 프록시 수 확인

#### `POST /reflux-overlay/fetch-board-list`

요청 예시:

```json
{
  "galleryId": "war",
  "page": 40,
  "maxRetries": 2
}
```

성공 응답 예시:

```json
{
  "success": true,
  "galleryId": "war",
  "page": 40,
  "statusCode": 200,
  "html": "<!doctype html>..."
}
```

실패 응답 예시:

```json
{
  "success": false,
  "message": "모든 프록시 시도 실패",
  "lastError": "프록시 요청 타임아웃",
  "attemptCount": 3
}
```

주의:

응답에는 프록시 `username/password`를 절대 넣지 않는다.

### 6.1.2 bridge 내부 동작

bridge는 아래 순서로 동작한다.

1. `WEBSHARE_API_KEY`로 Webshare proxy list 조회
2. `valid=true` 프록시만 필터
3. 메모리에 proxy pool 캐시
4. 요청이 오면 round-robin으로 프록시 선택
5. `http.request()`로 target list URL 요청
6. 응답 HTML이 `gall_list` 또는 `ub-content` 같은 최소 signature를 만족하는지 검사
7. 실패 시 다른 프록시로 재시도
8. 성공 HTML 반환

proxy list 캐시는 예를 들어 `10분` TTL로 둔다.

이유:

1. 매 요청마다 Webshare API를 다시 치면 불필요하게 무겁다.
2. 그래도 너무 오래 캐시하면 죽은 프록시를 오래 붙들 수 있다.

### 6.1.3 bridge가 써야 하는 실제 request 방식

이 부분은 이미 `scripts/test-proxy-search-duplicate.mjs`에 working reference가 있다.

- `scripts/test-proxy-search-duplicate.mjs:226-263`
- `scripts/test-proxy-search-duplicate.mjs:266-291`

즉, 이번 bridge는 저 로직을 “검색 테스트 스크립트”에서 “overlay용 공용 bridge”로 옮기는 형태가 된다.

단, 저 파일의 네트워크 로직만 참고하고,
**비밀키를 코드에 하드코딩하는 방식은 bridge 본 구현에 가져오지 않는다.**

---

## 6.2 manifest 변경

root manifest에 아래 host permission을 추가한다.

1. `http://127.0.0.1/*`
2. `http://localhost/*`
3. `http://[::1]/*`

근거:

- 현재 root `manifest.json:15-21`에는 localhost 권한이 없다.
- 반면 localhost helper를 쓰는 다른 프로젝트는 이미 이 3개를 넣고 있다.
  - `projects/dc_auto_bot/manifest.json:14-20`

이 변경이 없으면 background/service worker가 localhost bridge를 호출할 권한이 없다.

---

## 6.3 page locator 변경

이 부분이 이번 문서의 핵심 교정 포인트다.

현재 locate 단계는 transport를 안 타고 direct fetch를 탄다.

그래서 `features/reflux-dataset-collector/page-locator.js`의 `fetchBoardListHtml()`를 아래처럼 확장해야 한다.

현재:

- `dependencies.fetchImpl || globalThis.fetch`

변경:

1. `dependencies.fetchBoardListHtmlImpl`가 있으면 그걸 최우선 사용
2. custom impl이 있으면 **page-locator 내부 retry 루프는 더 돌리지 않고 바로 위임**
3. 없으면 기존 direct fetch 경로 유지

의도:

- direct mode는 기존과 완전히 동일
- proxy mode만 locate 단계에서 bridge fetch를 사용
- retry 책임이 이중으로 겹치지 않게 한다

예시:

```javascript
const html = await fetchBoardListHtml(
  galleryId,
  normalizedPage,
  normalizedConfig,
  {
    ...dependencies,
    fetchBoardListHtmlImpl: transport.fetchBoardListHtml.bind(transport),
  },
);
```

이렇게 해야 아래가 전부 proxy 경유가 된다.

1. 첫 1페이지 bootstrap 확인
2. binary probe
3. neighbor scan
4. 실제 target window 수집

즉, “찾는 단계는 direct, 수집만 proxy”라는 반쪽 연결을 없앤다.

추가로, locate 단계에는 기존 API가 이미 받는 `options.signal`과 `dependencies.delayFn`을 같이 연결한다.

이유:

1. stop 시 locate 중인 요청도 abort할 수 있어야 한다.
2. locate 대기 구간도 scheduler 정지 상태를 빨리 반영해야 한다.

---

## 6.4 transport 변경

`features/reflux-overlay-collector/transport.js`는 아래 구조로 바꾼다.

### 6.4.1 direct transport

그대로 둔다.

- `mode='direct'`
- `workerCount=1`
- 기존 `fetchBoardListHtml()` 그대로

### 6.4.2 proxy bridge transport

추가 기능:

1. `ensureReady()`
   - `GET http://127.0.0.1:4318/health`
   - bridge 실행 여부 확인
   - 사용 가능한 프록시 수 저장
2. `getEffectiveWorkerCount()`
   - `min(config.proxyWorkerCount, availableProxyCount, targetPageCount)`
3. `fetchBoardListHtml(galleryId, page, options)`
   - `POST /reflux-overlay/fetch-board-list`
   - 성공 시 `html`만 반환
4. `fetchBoardListHtml()`는 `options.signal`을 받아 extension fetch abort를 지원
5. proxy transport 자체는 별도 재시도 루프를 중복으로 돌리지 않고,
   bridge가 받은 `maxRetries` 정책을 1차 retry owner로 삼는다

여기서 중요한 점:

`proxyWorkerCount`는 단순 희망값이다.

실제 worker 수는 `health.proxyCount`보다 크면 안 된다.

예시:

- 설정값 10
- 현재 유효 프록시 4개
- 실제 worker 수 = 4

이렇게 해야 프록시 1개에 여러 worker가 무의미하게 몰리지 않는다.

---

## 6.5 scheduler 변경

`features/reflux-overlay-collector/scheduler.js`는 아래 순서로 바꾼다.

### 6.5.1 시작 차단 로직 수정

현재는 `transportMode === 'proxy_bridge'`면 무조건 막는다.

- `features/reflux-overlay-collector/scheduler.js:74-76`

이건 제거한다.

대신 정책을 이렇게 바꾼다.

1. `getStartBlockReason()`은 순수 config validation만 담당
2. 실제 bridge 연결 여부는 `start()` 안에서 `await transport.ensureReady()`로 검사
3. preflight에 성공한 transport는 `this.activeTransport`로 저장해서 같은 run에서 재사용한다
4. 이 preflight는 `isRunning=true`로 올리기 전에 끝내고, 실패 시 `lastError/log/saveState`를 남긴 뒤 rethrow 한다

이렇게 하는 이유:

1. background 공용 start guard는 sync 성격이다.
2. bridge readiness는 네트워크 I/O라 async다.
3. 그래서 “설정 형식 오류”와 “bridge 미실행”을 분리하는 게 맞다.
4. preflight를 running 전으로 당겨야 “실패했는데 running 상태만 남는” 꼬임을 막을 수 있다
5. transport를 저장해 두면 health를 불필요하게 두 번 치지 않아도 된다
6. `handleMessage()`의 top-level catch는 `statuses`를 붙여주지 않으므로, throw 전에 state/log를 남겨야 popup refresh에서 원인을 확인할 수 있다

예시:

- view URL 비정상 -> 시작 버튼 즉시 거부
- bridge 미실행 -> start 내부에서 `127.0.0.1:4318 응답 없음`으로 실패

### 6.5.2 locate 단계도 transport 사용

현재:

- `locateBoardListPageFromViewUrl(this.config.viewUrl, { ... })`

변경:

- transport 생성 후
- locate 호출에도 `fetchBoardListHtmlImpl` dependency 주입

즉 순서는 아래다.

1. `const transport = this.activeTransport || this.createTransport(this.config)`
2. preflight transport가 없을 때만 `ensureReady()`를 수행
3. locate 전용 `AbortController`와 stoppable `delayFn` 준비
4. `locateBoardListPageFromViewUrl(..., ..., { fetchBoardListHtmlImpl: transport.fetchBoardListHtml.bind(transport), delayFn, signal })`

direct mode에서는 아무 문제 없다.
proxy mode에서만 locate가 bridge를 타게 된다.

### 6.5.3 target page 수집 루프를 mode별로 분리

현재는 무조건 순차 `for` 루프다.

- `features/reflux-overlay-collector/scheduler.js:178-219`

변경 후:

1. direct mode
   - 기존 순차 루프 유지
2. proxy_bridge mode
   - worker pool 병렬 수집

worker pool 동작:

1. 공유 queue에서 다음 page 하나 가져옴
2. queue 순서는 기존 `targetPages` 배열 순서 그대로 유지해서 anchor-first 우선순위를 살린다
3. worker별로 자기 요청 간격만 `requestDelayMs + jitterMs` 적용
4. worker별로 `AbortController`를 하나씩 들고 요청한다
5. 완료/실패 카운트는 기존 필드에 누적
6. `runtimeTitleSet`은 그대로 공용 Set 사용

예시:

- target pages: `40, 41, 39, 42, 38, ...`
- worker 3개일 때
  - worker1: 40 -> 42 -> 37
  - worker2: 41 -> 38 -> 36
  - worker3: 39 -> 43 -> 35

주의:

`currentPage`는 병렬 모드에서는 “현재 진행 중 유일 페이지” 의미가 아니라,
**가장 최근에 할당된 페이지** 정도의 의미로 바뀐다.

이건 허용한다.

이유:

1. 기존 status schema를 안 깨는 게 더 중요하다.
2. 실제 진행률은 `completedPageCount / targetPageCount`가 더 중요하다.

### 6.5.4 병렬 상태 저장 직렬화

이건 이번 검토에서 새로 확정된 필수 항목이다.

현재 `saveState()`는 순차 루프 기준이라 문제가 없지만,
병렬 worker가 각자 `await saveState()`를 때리면 오래된 snapshot이 나중에 저장되면서 최신 값이 덮일 수 있다.

예시:

1. worker A가 `completedPageCount=3` 상태로 저장 시작
2. 직후 worker B가 `completedPageCount=4`로 증가 후 저장 시작
3. B가 먼저 끝나고, A가 나중에 끝나면 storage에는 다시 `3`이 남을 수 있다

그래서 scheduler에는 아래 둘 중 하나가 필수다.

1. `queueStateSave()`로 storage write를 직렬화
2. 또는 일정 주기/단계에서만 최신 state를 한 번씩 flush

이번 문서 기준 권장안은 `queueStateSave()`다.

이유:

1. 기존 status schema를 안 바꾸고 적용 가능
2. 병렬 worker 수가 늘어도 state 역주행을 막기 쉽다

### 6.5.5 stop / abort 처리

현재 `stop()`은 `isRunning=false`만 바꾼다.

직렬 수집에서는 그나마 감당되지만,
proxy mode에서는 여러 page fetch가 동시에 떠 있을 수 있으므로 이 상태로는 stop 체감이 나빠진다.

그래서 proxy mode 패치에는 아래가 같이 들어가야 한다.

1. locate 전용 `AbortController`
2. worker별 `AbortController`
3. `stop()`에서 현재 살아 있는 controller 전부 `abort()`
4. bridge 쪽도 client disconnect/abort를 감지하면 upstream proxy request를 정리
5. run 종료 시 `activeTransport`와 controller registry를 비운다

이렇게 해야 stop 후 `workerCount * timeout`만큼 질질 끌리는 상황을 막을 수 있다.

추가로, abort가 실제로 발생했을 때는 아래 정책을 같이 적용해야 한다.

1. `isRunning=false` 상태에서 발생한 `AbortError`는 `failedPages`에 넣지 않는다
2. locate 단계 abort도 `FAILED`가 아니라 `INTERRUPTED`로 정리한다
3. 사용자 stop으로 생긴 abort는 `⚠️ n페이지 수집 실패` 로그 대신 중단 로그 흐름으로 흡수한다

이걸 안 하면 stop을 눌렀는데 “실패 페이지 다수 발생”처럼 보이는 잘못된 상태가 남는다.

### 6.5.6 direct 모드는 완전히 보존

이건 꼭 지켜야 한다.

`transportMode='direct'`일 때는 기존 순차 동작, 기존 지연, 기존 로그 의미를 그대로 유지한다.

즉 이번 패치는 direct mode 성능/동작에 영향이 없어야 한다.

---

## 7. bridge 예외 처리 정책

bridge는 아래 예외를 명확히 구분해야 한다.

1. API 키 없음
   - 기본 내장키와 `WEBSHARE_API_KEY` override가 둘 다 비어 있을 때만 발생
   - `500`
   - 메시지: `WEBSHARE_API_KEY가 설정되지 않았습니다.`
2. proxy list 조회 실패
   - `502`
   - 메시지: `Webshare proxy list 조회 실패`
3. 유효 프록시 0개
   - `503`
   - 메시지: `사용 가능한 Webshare 프록시가 없습니다.`
4. 개별 proxy fetch 실패
   - 내부 retry 후 최종 실패 시 `502`
5. 잘못된 galleryId/page
   - `400`
6. HTML 구조 검증 실패
   - `502`
   - 메시지: `목록 HTML 검증 실패`
7. localhost 외 host bind 시도
   - 프로세스 시작 자체를 거부

확장 transport는 JSON 실패 응답을 그대로 사용자 친화적 에러로 바꿔 던진다.

예시:

- bridge down -> `proxy bridge 연결 실패`
- Webshare 응답 불량 -> `proxy bridge 프록시 준비 실패`
- 프록시는 응답했지만 목록 HTML이 아니면 -> `목록 HTML 검증 실패`
- 개별 페이지만 실패 -> 기존처럼 `failedPages`에만 누적

---

## 8. 보안/비밀정보 정책

이번 구현에서 지켜야 할 원칙은 아래다.

1. 공용 관리자용 기본키는 bridge script 안에만 둔다.
2. 필요하면 `WEBSHARE_API_KEY` 환경변수로 기본키를 override할 수 있다.
3. 확장 storage, popup, manifest, background에는 API 키를 저장하지 않는다.
4. bridge 응답에 프록시 비밀번호를 절대 넣지 않는다.
5. bridge는 loopback only로 바인딩한다.

이유를 쉽게 말하면 이렇다.

- 확장 안에 키를 넣으면 “확장 파일을 보는 순간 비밀이 보이는 구조”가 된다.
- localhost bridge에만 키를 두면 “로컬 실행자만 키를 갖는 구조”가 된다.

추가 메모:

이번 구현은 운영 편의를 위해 bridge script에 공용 기본키를 내장한다.
다만 관리자별 별도 키를 써야 할 때는 `process.env.WEBSHARE_API_KEY`가 우선한다.

---

## 9. 파생 문제 검토

이번 설계가 기존 플로우를 깨지 않는지 실제 코드 기준으로 검토한 결과는 아래다.

### 9.1 popup / config 저장선

대체로 문제 없지만, background running guard는 보강이 필요하다.

이유:

1. popup은 이미 `transportMode`, `proxyWorkerCount`를 저장한다.
2. overlay API는 이미 그 둘을 normalize한다.
3. background updateConfig 분기도 이미 overlay collector config merge 경로가 있다.
4. 다만 `getConfigUpdateBlockMessage()`에는 overlay 전용 running block이 없다.

근거:

- `popup/popup.html:907-915`
- `popup/popup.js:1173-1182`
- `features/reflux-overlay-collector/api.js:17-27`
- `background/background.js:644-662`
- `background/background.js:1323-1430`

정리:

- popup만 보면 실행 중 설정 변경이 막혀 보인다
- 하지만 background API는 아직 overlay 실행 중 config 변경을 거부하지 않는다

그래서 이번 패치에는 `background/background.js`에 아래와 같은 guard를 같이 넣는 쪽으로 문서를 수정한다.

- viewUrl / beforePages / afterPages / requestDelayMs / jitterMs / transportMode / proxyWorkerCount / maxRetriesPerPage 변경 시
- `임시 overlay 수집 설정은 기능을 정지한 뒤 변경하세요.`

### 9.2 scheduler 등록 / 상태복원선

문제 없음.

이유:

1. scheduler는 이미 `schedulers` 맵에 들어 있다.
2. `resumeAllSchedulers()`도 이미 overlay collector를 로드한다.
3. 그런데 overlay collector는 loadState 시 “실행 중이면 interrupted로 바꾸고 자동 복원 안 함” 정책이다.

이 정책은 proxy bridge가 외부 프로세스라는 점과 잘 맞는다.

즉 service worker가 재시작돼도,
“갑자기 bridge 연결 없는 상태에서 몰래 재개” 같은 일이 없다.

근거:

- `background/background.js:204-226`
- `features/reflux-overlay-collector/scheduler.js:324-361`

추가 메모:

`busy feature` 등록은 이미 되어 있으므로,
이번 패치에서 background 쪽에 새로 넣어야 하는 건 `running config update guard` 한 가지다.

### 9.3 page 범위 underflow / overflow

문제 없음.

현재 `buildTargetPages()`가 이미 `1`과 `totalPageCount`로 clamp 한다.

근거:

- `features/reflux-overlay-collector/api.js:65-91`

예시:

- anchor page가 `40`
- before/after가 `50`
- 총 페이지가 `63`

결과:

- 실제 요청 범위는 `1~63`
- `0페이지`나 `64페이지` 요청은 발생하지 않음

### 9.4 direct mode 회귀 가능성

회귀 리스크는 낮다.

이유:

1. direct transport 구현은 그대로 둔다.
2. scheduler도 direct branch는 기존 순차 루프 유지다.
3. page locator 확장은 “custom fetch가 있으면 사용, 없으면 기존 direct path” 구조다.

즉 direct mode는 fallback이 아니라 **기존 기본 경로 그대로 유지**다.

### 9.5 hidden retry 설정

`maxRetriesPerPage`는 현재 popup에 입력칸이 없고 hidden internal default로만 존재한다.

이건 당장 치명적인 문제는 아니다.

이유:

1. live smoke 기준 기본값 `2`는 프록시 상태에 따라 흔들릴 수 있었고, `5`는 바로 안정화됐다.
2. 운영자가 매번 값을 손댈 필요가 있는 구조는 아니다.

다만 문서 기준 정책은 아래로 고정한다.

- popup은 그대로 둔다
- retry 세부 조정은 추후 필요할 때만 UI로 승격한다
- 이번 patch에서는 hidden default를 `5`로 높이고 `double retry`만 막는다

### 9.6 parser / 저장 / 반영 플로우 보존 여부

이 부분은 구조변경의 핵심 안전장치라서 별도로 확인했다.

현재 overlay 적용의 끝단은 아래 순서다.

1. 목록 HTML -> `parseRefluxCollectorTitles()`
   - `features/reflux-dataset-collector/parser.js:3-7`
2. 정규화 + dedupe -> runtime set 누적
   - `features/reflux-overlay-collector/scheduler.js:196-208`
   - `features/reflux-overlay-collector/scheduler.js:413-426`
3. `saveOverlay()`로 IndexedDB/meta 저장
   - `features/post/semiconductor-reflux-overlay-store.js:33-76`
4. `reloadSemiconductorRefluxEffectiveMatcher()`로 overlay dataset 재로딩
   - `features/post/semiconductor-reflux-effective-matcher.js:45-59`
   - `features/post/semiconductor-reflux-effective-matcher.js:139-169`

즉 이번 패치가 건드리는 건 “HTML을 어디서 가져오느냐”이고,
아래는 그대로 보존된다.

1. HTML 파서
2. 정규화 방식
3. overlay 저장 schema
4. effective matcher 재로딩 방식

쉽게 말하면:

- 기존: direct fetch한 목록 HTML -> 파서 -> overlay 저장
- 패치 후: proxy bridge로 받은 목록 HTML -> 같은 파서 -> 같은 overlay 저장

그래서 bridge가 **동일한 목록 HTML만 반환하면**, 저장과 matcher 반영 쪽 파생 문제는 작다.

---

## 10. 정적 논리검증 체크리스트

패치 전에 문서 기준으로 미리 체크해야 할 항목을 적는다.

1. `proxy_bridge` 선택 시 시작 전 무조건 차단 문구가 더 이상 나오지 않아야 한다.
2. bridge 미실행 상태에서는 start가 명확한 에러로 실패해야 한다.
3. bridge health가 `proxyCount=0`이면 start가 실패해야 한다.
4. direct mode는 bridge가 없어도 기존처럼 동작해야 한다.
5. locate 단계 첫 요청도 proxy mode에서는 bridge를 타야 한다.
6. binary probe도 proxy mode에서는 bridge를 타야 한다.
7. neighbor scan도 proxy mode에서는 bridge를 타야 한다.
8. target pages fetch도 proxy mode에서는 bridge를 타야 한다.
9. `proxyWorkerCount=10`이어도 실제 유효 프록시가 4개면 worker는 4개만 떠야 한다.
10. `proxyWorkerCount=1`이면 proxy mode여도 순차와 거의 같은 의미로 동작해야 한다.
11. `currentPage` 단일 필드는 병렬 모드에서 마지막 할당 페이지 의미로 써도 status schema가 깨지지 않아야 한다.
12. `failedPages`는 중복 없이 정렬된 배열이어야 한다.
13. 일부 페이지 실패가 있어도 `runtimeTitleSet`이 비어 있지 않으면 overlay 저장은 계속되어야 한다.
14. 전 페이지 실패로 `runtimeTitleSet.size===0`이면 기존처럼 저장 실패가 나야 한다.
15. bridge가 429/502를 받았을 때 다른 프록시로 retry해야 한다.
16. Webshare API 호출 실패 시 proxy pool stale cache만 무한 재사용하면 안 된다.
17. bridge 응답 JSON에 proxy 비밀번호가 노출되면 안 된다.
18. bridge는 `0.0.0.0` 바인딩을 막아야 한다.
19. manifest에 localhost host permission이 빠지면 background fetch가 실패하므로 반드시 추가해야 한다.
20. service worker 재시작 후 overlay job이 자동 재개되지 않는 기존 정책이 유지되어야 한다.
21. reset stats를 눌러도 config 값 자체는 보존되어야 한다.
22. `beforePages=0`, `afterPages=0`이면 anchor page 1장만 수집되어야 한다.
23. galleryId/page validation 실패는 bridge에서 400으로 끝나야 한다.
24. Webshare proxy list API가 빈 배열이면 overlay 수집을 시작하지 않아야 한다.
25. popup의 `proxyWorkerCount` 입력은 여전히 `1~10` 범위로 clamp되어야 한다.
26. page locator 캐시는 기존처럼 동일 page 재요청을 줄여야 한다.
27. 병렬 수집 중 stop을 누르면 worker loop가 다음 대기 지점에서 빠지는 수준이 아니라, in-flight bridge fetch도 abort되어야 한다.
28. locate 단계 stop도 binary/neighbor 탐색이 끝날 때까지 질질 끌면 안 된다.
29. 병렬 수집 로그는 페이지 완료 순서가 섞여도 카운트가 맞아야 한다.
30. direct mode의 `requestDelayMs/jitterMs` 의미는 변하면 안 된다.
31. proxy mode에서도 각 worker 내부에는 요청 간 delay가 살아 있어야 한다.
32. 병렬 worker가 동시에 저장해도 `completedPageCount`, `failedPages`, `logs`가 storage에서 역주행하지 않아야 한다.
33. custom locator fetch를 붙였을 때 retry가 page-locator와 bridge에서 이중으로 중첩되지 않아야 한다.
34. bridge는 `200 OK`여도 HTML이 목록 구조가 아니면 성공으로 취급하면 안 된다.
35. overlay 실행 중 `updateConfig` 메시지가 직접 들어와도 background에서 거부되어야 한다.
36. start preflight가 실패했을 때 popup alert만 뜨고 status/log가 비어 있으면 안 된다.

위 36개가 문서 기준 사전 검토 항목이다.

---

## 11. 실제 패치 순서

패치는 아래 순서가 제일 안전하다.

1. `scripts/reflux-overlay-proxy-bridge.mjs` 추가
2. bridge 단독 `GET /health`, `POST /reflux-overlay/fetch-board-list` 스모크 테스트
3. `manifest.json` localhost host permission 추가
4. `page-locator.js`에 custom board-list fetch 주입점 추가
5. `transport.js` proxy bridge transport 구현
6. `background/background.js` overlay running config guard 추가
7. `scheduler.js` start preflight / locate / fetching / abort / state-save flow 연결
8. direct mode 회귀 확인
9. proxy mode 스모크 테스트

이 순서로 가야 원인 분리가 쉽다.

예:

- bridge를 먼저 띄워두면
- transport 에러가 “bridge 문제”인지 “extension 문제”인지 바로 나뉜다.

---

## 12. 스모크 테스트 계획

### 12.1 bridge 단독

1. `GET /health`
   - 기대: `success=true`, `proxyCount>0`
2. `POST /reflux-overlay/fetch-board-list`
   - 예시 body: `{"galleryId":"war","page":1,"maxRetries":2}`
   - 기대: `success=true`, `html` 길이 충분, `ub-content` 포함

### 12.2 extension direct mode

1. `transport=direct`
2. 기존처럼 overlay 수집 1회
3. 기대: 이전과 동일

### 12.3 extension proxy mode

1. bridge 실행
2. popup에서 `transport=proxy_bridge`, `proxyWorkerCount=10`
3. overlay 수집 시작
4. 기대:
   - 시작 차단 문구 없음
   - locate 성공
   - page 수집 진행
   - overlay 저장 완료

### 12.4 경계 테스트

1. anchor가 1페이지 근처일 때
2. anchor가 마지막 페이지 근처일 때
3. before/after가 0일 때
4. 일부 proxy fail이 섞일 때
5. bridge 미실행일 때

---

## 13. 이번 문서 기준 최종 판단

이번 구현 방향은 논리적으로 맞다.

이유:

1. Webshare 자체는 이미 실동작 검증이 끝났다.
2. 현재 막혀 있는 지점은 `proxy_bridge` placeholder와 localhost permission 부재다.
3. 추가로 빠져 있던 핵심 연결점인 `anchor locate direct 경로`도 이번 문서에서 보정했다.
4. 병렬화에서 새로 생기는 `storage race`, `stop abort`, `double retry`, `running config update` 이슈도 이번 문서에서 같이 보정했다.
5. popup/config/background의 기존 흐름은 대부분 유지하되, background는 overlay running guard 한 줄기를 보강하는 쪽이 더 안전하다.
6. direct mode 회귀 없이 proxy mode만 붙이는 최소 변경으로 설계 가능하다.

즉, 이번 문서 기준 구현은 “새 구조를 크게 엎는 작업”이 아니라,
**이미 만들어 둔 overlay collector에 Webshare bridge를 정확히 꿰는 패치**다.

남은 필수 구현 포인트는 아래 7개다.

1. localhost bridge 파일 추가
2. manifest localhost 권한 추가
3. page locator custom fetch 주입점 추가
4. bridge 쪽 HTML signature 검증 추가
5. overlay scheduler의 proxy mode 실제 연결 및 worker pool 구현
6. scheduler abort / serialized state-save 보강
7. background overlay running config guard 추가

이 7개를 문서대로 넣으면 `proxy_bridge transport는 아직 연결되지 않았습니다.` 상태를 넘어서,
실제 운영에서 꼬일 만한 연결 이슈까지 같이 막을 수 있다.
