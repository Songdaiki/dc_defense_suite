# 분탕자동차단 `이거진짜` 본문 링크 삭제 설계

작성일: 2026-04-27

## 목표

`분탕자동차단`은 이미 10초마다 갤러리 1페이지를 확인한다. 이 루프에 아래 조건을 추가한다.

```text
page1 글 제목을 정규화
-> 정규화된 제목에 "이거진짜"가 포함됨
-> 해당 글 본문 HTML을 조회
-> 본문 안에 사용자가 넣은 https:// 링크가 있음
-> 기존 분탕자동차단 차단/삭제 플로우로 처리
```

예시:

```text
제목: 이거 진짜에요
정규화: 이거진짜에요
판정: "이거진짜" 포함 -> 본문 조회

본문: https://example.com/...
판정: 사용자 링크 있음 -> IP차단 + 삭제
```

사용자가 방금 바꾼 기준은 `이거진짜에요` 정확 매치가 아니다. 패턴이 계속 바뀌므로 정규화 후 `이거진짜`가 포함되어 있기만 하면 검사한다.

예시:

```text
이거 진짜에요      -> 이거진짜에요      -> 매치
이거.진짜임        -> 이거진짜임        -> 매치
이거x진짜 봐라     -> 이거진짜봐라      -> 매치
이거 진짜 맞냐     -> 이거진짜맞냐      -> 매치
진짜 이거임        -> 진짜이거임        -> 미매치
```

## 현재 실제 코드 흐름

관련 기능은 `features/uid-warning-autoban`이다.

주요 파일:

```text
features/uid-warning-autoban/scheduler.js
features/uid-warning-autoban/api.js
features/uid-warning-autoban/parser.js
features/uid-warning-autoban/attack-title-cluster.js
features/ip/ban-executor.js
background/background.js
popup/popup.html
popup/popup.js
```

## 2026-04-27 재교차검증 결과

문서 작성 후 실제 코드를 다시 대조하면서 아래 보강점을 확인했다.

```text
1. attack-title-cluster.js의 isAlreadySpamHead는 이미 export되어 있다.
   -> 새로 export할 필요 없이 scheduler.js에서 import만 하면 된다.

2. uid-warning-autoban/api.js의 dcFetchWithRetry는 현재 AbortError를 즉시 중단하지 않는다.
   -> 새 본문 조회 timeout을 정확히 보장하려면 AbortError 즉시 throw와 signal-aware delay 보강이 필요하다.

3. withDcRequestLease는 lease.signal을 work(lease)로 넘긴다.
   -> 다만 현재 dc-session-broker는 active lease를 직접 abort하지 않고 최대 5초 동안 drain만 기다린다.
   -> 따라서 새 본문 조회는 자체 timeout으로 반드시 빨리 끝나야 한다.
   -> timeout signal과 lease.signal은 합치되, 실제 지연 상한은 timeout signal이 책임진다.
   -> 기본 timeout은 broker leaseDrainTimeout 기본값 5초와 맞춘다.

4. 본문 링크 파서가 <a href="..."> 큰따옴표만 보면 부족하다.
   -> 작은따옴표 href와 unquoted href도 처리해야 한다.

5. write_div 종료 marker는 대소문자/속성 변형에 약하면 안 된다.
   -> class 속성의 큰따옴표/작은따옴표/무따옴표 변형을 regex로 찾는 방식으로 구현해야 한다.

6. 링크 확인 실패와 링크 없음은 다르게 취급해야 한다.
   -> fetch 실패는 recent action에 넣지 않는다.
   -> 링크 없음도 recent success가 아니다.
   -> 링크 확인 후 제재 시도까지 간 글만 recent action에 넣는다.

7. UI 문구는 "삭제"보다 "제재"가 맞다.
   -> runtimeDeleteEnabled=false 상태에서는 차단만 수행될 수 있기 때문이다.

8. parser.js의 기존 decodeHtml()은 &#39; 외 numeric entity를 거의 풀지 않는다.
   -> href="https&#58;//..."나 href="https&#x3a;//..."를 링크로 못 볼 수 있다.
   -> 새 링크 판정 helper를 넣을 때 decodeHtml()도 decimal/hex numeric entity를 처리하게 보강한다.

9. runWithTimeoutSignal의 signal은 현재 withDcRequestLease의 gate 대기에는 전달되지 않는다.
   -> requestGateBlocked/switchInProgress 상태에서 acquireDcRequestLease가 기다리는 동안 timeout이 실제로 끊지 못한다.
   -> withDcRequestLease/acquireDcRequestLease/waitUntilDcSessionReady에 optional signal을 추가해야 한다.
   -> 기존 호출은 세 번째 인자를 안 넘기면 그대로 동작하므로 호환된다.
```

위 9개를 반영한 기준으로 아래 구현 문서를 최신 기준으로 본다.

현재 `features/uid-warning-autoban/scheduler.js`의 `runCycle()` 흐름은 아래 순서다.

```js
const html = await this.fetchListHtml(this.config, 1);
const allRows = this.parseImmediateRows(html);
const pageUidRows = allRows.filter((row) => row?.hasUid === true);

const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const processedAttackTitlePostNos = await this.handleAttackTitleClusterRows(
  allRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0)),
  nowMs,
);

const processedPostNos = new Set([
  ...processedImmediatePostNos,
  ...processedAttackTitlePostNos,
]);

await this.handleAttackCommentClusterRows(
  allRows.filter((row) => !processedPostNos.has(Number(row?.no) || 0)),
  html,
  nowMs,
);

const rows = pageUidRows.filter((row) => !processedPostNos.has(Number(row?.no) || 0));
```

의미:

- 10초마다 `/mgallery/board/lists/?id=...&page=1` HTML을 1번 가져온다.
- `parseImmediateRows`는 기본적으로 `parseImmediateTitleBanRows()`이고, 유동글과 고닉글을 모두 파싱한다.
- 제목 직차단이 먼저 돈다.
- 실제공격 제목 군집이 다음에 돈다.
- 실제공격 댓글 군집이 다음에 돈다.
- 마지막으로 UID 기반 분탕 조건을 본다.

새 기능은 `제목 직차단` 다음, `실제공격 제목 군집` 전에 넣는 것이 가장 안전하다.

최종 순서:

```text
page1 HTML fetch
-> 전체 row 파싱
-> 제목 직차단
-> "이거진짜" 제목 + 본문 https 링크 검사
-> 실제공격 제목 군집
-> 실제공격 댓글 군집
-> UID/gallog 기반 분탕차단
```

이 위치가 좋은 이유:

- 제목 직차단이 가장 강한 수동 규칙이므로 최우선으로 유지한다.
- `이거진짜` 링크글은 글 단위로 처리되므로 실제공격 제목/댓글/UID 경로로 중복 처리되지 않게 막을 수 있다.
- 본문 조회가 필요한 기능이라 실제공격 제목 군집보다 약간 비용이 크지만, 제목 후보만 조회하므로 전체 50글을 매번 조회하지 않는다.
- 기존 `executeBanWithDeleteFallback()`을 그대로 타면 삭제 한도 계정전환/ban-only fallback이 유지된다.

## 기존 row 파서 재사용 여부

`features/uid-warning-autoban/parser.js`의 row 구조는 이미 필요한 값을 갖고 있다.

```js
{
  no,
  uid,
  nick,
  title,
  subject,
  commentCount,
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

새 기능에서 필요한 값:

```text
no: 글번호
title/subject: 제목 정규화 대상
currentHead: 이미 도배기탭이면 중복 처리 방지
isFluid/ip: 유동글 제한 및 차단 대상 정보
nick/writerDisplay: 로그/target post 생성용
```

제목 정규화는 기존 `normalizeImmediateTitleValue()`를 그대로 쓴다.

현재 정규화 특징:

- NFKC 정규화
- zero-width/invisible 문자 제거
- 일부 confusable 문자 치환
- 한글과 영문만 남김
- 한글 사이에 낀 영어 filler 제거
- 소문자화

예시:

```text
이거 진짜에요       -> 이거진짜에요
이거ˇ진짜에요       -> 이거진짜에요
이거x진짜에요       -> 이거진짜에요
이거ㅎ진짜에요      -> 이거ㅎ진짜에요
```

## 검사 대상 범위

기본 대상은 `유동글`로 제한한다.

권장 조건:

```js
row?.isFluid === true
```

이유:

- 이 기능은 자동 삭제/차단 기능이다.
- 제목이 `이거 진짜`인 고닉/반고닉 정상 글까지 본문 링크 때문에 삭제하면 무고 가능성이 커진다.
- 기존 실제공격 제목 클러스터도 `row.isFluid === true`만 본다.
- 공격자가 VPN/유동으로 들어오는 현재 방어 목적과 맞다.

추가 스킵 조건:

```text
글번호가 없음
이미 같은 사이클에서 제목 직차단으로 처리됨
이미 도배기탭/currentHead가 도배기 계열임
최근 성공 처리 이력이 있음
```

`currentHead` 도배기탭 판정은 기존 `attack-title-cluster.js` 안의 `isAlreadySpamHead()`를 그대로 import해서 쓴다.

실제 확인 결과 `isAlreadySpamHead`는 이미 export되어 있다.

```js
import {
  ATTACK_TITLE_BAN_HOUR,
  ATTACK_TITLE_BAN_REASON_TEXT,
  EMPTY_ATTACK_TITLE_PATTERN_CORPUS,
  detectAttackTitleClusters,
  isAlreadySpamHead,
  loadBundledAttackTitlePatternCorpus,
} from './attack-title-cluster.js';
```

따라서 이 파일은 새 export 패치가 필요 없다. `scheduler.js` import만 추가하면 된다.

## 본문 조회 API 추가

현재 `uid-warning-autoban/api.js`에는 목록 조회만 있다.

현재:

```js
async function fetchUidWarningAutoBanListHTML(config = {}, page = 1) {
  return withDcRequestLease({ feature: 'uidWarningAutoBan', kind: 'fetchListHTML' }, async () => {
    const resolved = resolveConfig(config);
    const url = new URL('/mgallery/board/lists/', resolved.baseUrl);
    url.searchParams.set('id', resolved.galleryId);
    url.searchParams.set('page', String(page));

    const response = await dcFetchWithRetry(url.toString());
    return response.text();
  });
}
```

새 함수:

```js
async function fetchUidWarningAutoBanPostViewHTML(config = {}, postNo, options = {}) {
  return withDcRequestLease(
    { feature: 'uidWarningAutoBan', kind: 'fetchPostViewHTML' },
    async (lease) => {
      const resolved = resolveConfig(config);
      const normalizedPostNo = Math.max(0, Number(postNo) || 0);
      if (normalizedPostNo <= 0) {
        throw new Error('글번호 없음');
      }

      const url = new URL('/mgallery/board/view/', resolved.baseUrl);
      url.searchParams.set('id', resolved.galleryId);
      url.searchParams.set('no', String(normalizedPostNo));
      url.searchParams.set('page', '1');

      const response = await dcFetchWithRetry(url.toString(), {
        signal: mergeAbortSignals(options.signal, lease.signal),
        headers: {
          Referer: `${resolved.baseUrl}/mgallery/board/lists/?id=${encodeURIComponent(resolved.galleryId)}&page=1`,
        },
      });
      const html = await response.text();
      if (html.includes('정상적인 접근이 아닙니다')) {
        throw new Error('정상적인 접근이 아닙니다');
      }
      return html;
    },
    { signal: options.signal },
  );
}
```

왜 `withDcRequestLease`가 필요한가:

- 계정 전환/삭제한도 fallback 중 요청 충돌을 줄인다.
- 기존 `fetchListHTML`, 갤로그 조회, 댓글 조회와 같은 세션 브로커 흐름에 맞춘다.
- 별도 `fetch()`를 직접 치면 로그인 세션 전환 타이밍에 엇갈릴 수 있다.

### session broker signal 보강

현재 `background/dc-session-broker.js` 흐름:

```js
async function waitUntilDcSessionReady() {
  await initializeDcSessionBroker();

  while (brokerState.switchInProgress || brokerState.requestGateBlocked) {
    if (runtime.pendingSessionAutomationPromise) {
      try {
        await runtime.pendingSessionAutomationPromise;
      } catch {
        // ...
      }
      continue;
    }

    await sleep(100);
  }
}

async function acquireDcRequestLease(meta = {}) {
  await waitUntilDcSessionReady();
  // lease 생성
}

async function withDcRequestLease(meta = {}, work) {
  const lease = await acquireDcRequestLease(meta);
  try {
    return await work(lease);
  } finally {
    lease.release();
  }
}
```

문제:

```text
runWithTimeoutSignal(5000ms)
-> fetchPostViewHtml 호출
-> withDcRequestLease 내부 waitUntilDcSessionReady에서 gate 해제 대기
-> 이 대기 루프는 signal을 보지 않음
-> 5초 timeout이 지나도 실제 Promise가 끝나지 않을 수 있음
```

보강 기준:

```js
async function waitUntilDcSessionReady(options = {}) {
  const signal = options.signal;
  await initializeDcSessionBroker();

  while (brokerState.switchInProgress || brokerState.requestGateBlocked) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    if (runtime.pendingSessionAutomationPromise) {
      try {
        await waitForPromiseOrAbort(runtime.pendingSessionAutomationPromise, signal);
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
      }
      continue;
    }

    await sleep(100, signal);
  }
}

async function acquireDcRequestLease(meta = {}, options = {}) {
  await waitUntilDcSessionReady({ signal: options.signal });
  if (options.signal?.aborted) {
    throw createAbortError();
  }
  // 기존 lease 생성
}

async function withDcRequestLease(meta = {}, work, options = {}) {
  const lease = await acquireDcRequestLease(meta, { signal: options.signal });
  try {
    return await work(lease);
  } finally {
    lease.release();
  }
}
```

`sleep(ms, signal)`, `waitForPromiseOrAbort(promise, signal)`, `createAbortError()`는 optional helper로 추가한다. 기존 호출부는 세 번째 인자를 넘기지 않으므로 동작이 바뀌지 않는다.

helper 기준:

```js
function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function waitForPromiseOrAbort(promise, signal) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise)
      .then((value) => {
        cleanup();
        resolve(value);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}
```

### API abort 보강

현재 `uid-warning-autoban/api.js`의 `dcFetchWithRetry()`는 `comment/api.js`와 달리 AbortError를 즉시 throw하지 않는다.

현재 구조:

```js
} catch (error) {
  lastError = error;
  await delay(1000);
}
```

문제:

```text
runWithTimeoutSignal(5000ms)이 abort
-> fetch가 AbortError 발생
-> dcFetchWithRetry가 catch 후 1초 대기하고 재시도
-> 이미 abort된 signal로 재시도
-> timeout 로그가 5초보다 늦게 나올 수 있음
```

보강 기준:

```js
async function dcFetchWithRetry(url, options = {}, maxRetries = 3) {
  const retries = Math.max(1, Number(maxRetries) || 1);
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        await delay((attempt + 1) * 2000, options.signal);
        continue;
      }

      if (response.status === 403) {
        await delay(5000, options.signal);
        continue;
      }

      return response;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }

      lastError = error;
      await delay(1000, options.signal);
    }
  }

  throw new Error(
    lastError?.message
      ? `최대 재시도 횟수 초과 - ${lastError.message}`
      : '최대 재시도 횟수 초과',
  );
}
```

`delay()`도 기존 호출과 호환되게 `signal`을 optional로 받는다.

```js
async function delay(ms, signal) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  if (signal.aborted) {
    throw createAbortError();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

AbortError 생성은 `features/comment/api.js`의 기존 방식을 맞춘다.

```js
function createAbortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }
}
```

`mergeAbortSignals()`는 timeout signal과 lease signal을 같이 살리기 위한 helper다.

```js
function mergeAbortSignals(...signals) {
  const normalizedSignals = signals.filter(Boolean);
  if (normalizedSignals.length === 0) {
    return undefined;
  }

  if (normalizedSignals.length === 1) {
    return normalizedSignals[0];
  }

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(normalizedSignals);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of normalizedSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}
```

이 보강을 같이 하지 않으면 새 기능 자체는 동작해도 timeout/세션전환 타이밍에서 지연이 생길 수 있다.

## 본문 링크 판정에서 가장 중요한 점

전체 view HTML에서 `https://`를 찾으면 안 된다.

나쁜 구현:

```js
if (viewHtml.includes('https://')) {
  deletePost();
}
```

왜 위험한가:

- 게시글 view HTML에는 광고, 이미지, 스크립트, CDN 주소가 많다.
- 사용자가 링크를 안 넣어도 `https://nstatic.dcinside.com/...` 같은 값이 있을 수 있다.
- 이미지 업로드 글은 `<img src="https://...">`가 본문 안에 들어갈 수 있다.
- 그러면 “이거 진짜” 제목의 정상 이미지 글이 삭제될 수 있다.

따라서 반드시 `본문 영역`만 추출하고, 이미지 `src`는 제외한다.

권장 판정:

```text
1. view HTML에서 write_div 주변 본문 영역만 자른다.
2. 본문 영역에서 <img ...> 태그를 제거한다.
3. <a href="https://..."> 링크를 찾는다.
4. 태그 제거 후 사용자에게 보이는 텍스트에 https://가 있는지 찾는다.
5. 디시 내부 이미지/CDN 주소는 제외한다.
```

예시:

```html
<div class="write_div">
  이거 확인해봐
  <a href="https://example.com">https://example.com</a>
</div>
```

결과:

```text
사용자 링크 있음 -> 삭제/차단
```

이미지 업로드 예시:

```html
<div class="write_div">
  <img src="https://dcimg5.dcinside.com/viewimage.php?...">
</div>
```

결과:

```text
img src는 제외 -> 링크 없음 -> 삭제/차단 안 함
```

일반 텍스트 예시:

```html
<div class="write_div">
  https://example.com/abc
</div>
```

결과:

```text
본문 텍스트에 https:// 있음 -> 삭제/차단
```

## 본문 추출 helper 설계

`parser.js`에 helper를 추가하는 것이 좋다.

추가 함수:

```text
extractPostBodyHtml(viewHtml)
hasUserHttpsLinkInPostBody(viewHtml)
```

권장 구현 방식:

```js
function extractPostBodyHtml(viewHtml) {
  const html = String(viewHtml || '');
  const writeDivMatch = html.match(
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bwrite_div\b[^"]*"|'[^']*\bwrite_div\b[^']*'|[^\s>]*\bwrite_div\b[^\s>]*)[^>]*>/i,
  );
  if (!writeDivMatch) {
    return '';
  }

  const startIndex = writeDivMatch.index;
  const searchStart = startIndex + writeDivMatch[0].length;
  const tailHtml = html.slice(searchStart);
  const markerRegexes = [
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bappending_file_box\b[^"]*"|'[^']*\bappending_file_box\b[^']*'|[^\s>]*\bappending_file_box\b[^\s>]*)[^>]*>/i,
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bview_bottom_btnbox\b[^"]*"|'[^']*\bview_bottom_btnbox\b[^']*'|[^\s>]*\bview_bottom_btnbox\b[^\s>]*)[^>]*>/i,
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bbtn_recommend_box\b[^"]*"|'[^']*\bbtn_recommend_box\b[^']*'|[^\s>]*\bbtn_recommend_box\b[^\s>]*)[^>]*>/i,
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bcomment_wrap\b[^"]*"|'[^']*\bcomment_wrap\b[^']*'|[^\s>]*\bcomment_wrap\b[^\s>]*)[^>]*>/i,
    /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*\bview_comment\b[^"]*"|'[^']*\bview_comment\b[^']*'|[^\s>]*\bview_comment\b[^\s>]*)[^>]*>/i,
    /<\/article>/i,
  ];
  const markerIndexes = markerRegexes
    .map((regex) => {
      const markerMatch = tailHtml.match(regex);
      return markerMatch ? searchStart + markerMatch.index : -1;
    })
    .filter((index) => index > startIndex);

  const endIndex = markerIndexes.length > 0
    ? Math.min(...markerIndexes)
    : Math.min(html.length, startIndex + 100000);

  return html.slice(startIndex, endIndex);
}
```

`DOMParser`는 쓰지 않는 방향이 안전하다.

이유:

- 현재 코드는 background/service worker에서도 동작한다.
- MV3 service worker 환경에서는 DOM API 사용 가능성이 브라우저/문맥에 따라 불안정할 수 있다.
- 기존 파서들도 대부분 문자열 파싱으로 되어 있어 구조 일관성이 맞다.

링크 판정 helper:

```js
function hasUserHttpsLinkInPostBody(viewHtml) {
  const bodyHtml = extractPostBodyHtml(viewHtml);
  if (!bodyHtml) {
    return false;
  }

  const safeBodyHtml = bodyHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<img\b[\s\S]*?>/gi, ' ');

  const anchorHrefMatches = [...safeBodyHtml.matchAll(/<a\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
  const hasAnchorHttps = anchorHrefMatches.some((match) => {
    const href = match[1] || match[2] || match[3] || '';
    return isUserHttpsUrl(decodeHtml(href));
  });
  if (hasAnchorHttps) {
    return true;
  }

  const visibleText = decodeHtml(
    safeBodyHtml.replace(/<[^>]+>/g, ' '),
  );

  return hasUserHttpsUrlText(visibleText);
}
```

URL 판정:

```js
function hasUserHttpsUrlText(value) {
  return /https:\/\//i.test(String(value || ''));
}

function isUserHttpsUrl(value) {
  const url = String(value || '').trim();
  if (!/^https:\/\//i.test(url)) {
    return false;
  }

  return !/^https:\/\/(?:[^/]+\.)?(?:dcinside\.com|dcimg\d*\.dcinside\.com|nstatic\.dcinside\.com|wstatic\.dcinside\.com)\b/i.test(url);
}
```

`decodeHtml()` 보강 기준:

```js
function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : _;
    })
    .replace(/&#(\d+);/g, (_, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : _;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}
```

이 보강이 필요한 예시:

```html
<div class="write_div">
  <a href="https&#58;//example.com">보기</a>
</div>
```

기존 `decodeHtml()` 그대로면 `https&#58;//`라서 `https://`로 못 잡는다. numeric entity를 풀면 `https://example.com`이 되어 정상 매치된다.

주의:

- 텍스트에 보이는 `https://dcinside.com/...`까지 제외할지 여부는 정책 선택이다.
- 이번 목적은 외부 링크 낚시 삭제이므로 anchor href의 디시 내부 링크는 제외하는 편이 안전하다.
- 본문 텍스트에 `https://`가 직접 보이면 일단 잡는다. 공격자가 외부 링크를 텍스트로 뿌리는 경우가 핵심이기 때문이다.

## scheduler 구현 설계

### constructor 추가

`features/uid-warning-autoban/scheduler.js` constructor에 dependency를 추가한다.

```js
this.fetchPostViewHtml = dependencies.fetchPostViewHtml || fetchUidWarningAutoBanPostViewHTML;
```

상태값 추가:

```js
this.lastLinkbaitBodyLinkCandidateCount = 0;
this.lastLinkbaitBodyLinkCheckedCount = 0;
this.lastLinkbaitBodyLinkMatchedCount = 0;
this.lastLinkbaitBodyLinkActionCount = 0;
this.lastLinkbaitBodyLinkRepresentative = '';
this.totalLinkbaitBodyLinkPostCount = 0;
this.recentLinkbaitBodyLinkActions = {};
```

이름 기준:

```text
코드 내부: linkbaitBodyLink
UI/로그: 이거진짜 링크본문
```

### runCycle 삽입

현재:

```js
const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const processedAttackTitlePostNos = await this.handleAttackTitleClusterRows(
  allRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0)),
  nowMs,
);
const processedPostNos = new Set([
  ...processedImmediatePostNos,
  ...processedAttackTitlePostNos,
]);
```

변경:

```js
const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const processedLinkbaitBodyLinkPostNos = await this.handleLinkbaitBodyLinkRows(
  allRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0)),
  nowMs,
);
const processedAttackTitlePostNos = await this.handleAttackTitleClusterRows(
  allRows.filter((row) => {
    const postNo = Number(row?.no) || 0;
    return !processedImmediatePostNos.has(postNo)
      && !processedLinkbaitBodyLinkPostNos.has(postNo);
  }),
  nowMs,
);
const processedPostNos = new Set([
  ...processedImmediatePostNos,
  ...processedLinkbaitBodyLinkPostNos,
  ...processedAttackTitlePostNos,
]);
```

의미:

- 제목 직차단에 걸린 글은 링크본문 검사로 넘어가지 않는다.
- 링크본문 검사로 처리된 글은 실제공격 제목군집/댓글군집/UID로 넘어가지 않는다.
- 본문에 링크가 없거나 조회 실패한 글은 다른 방어 로직이 계속 볼 수 있다.

### 후보 선택

새 helper:

```js
const DEFAULT_LINKBAIT_TITLE_NEEDLE = normalizeImmediateTitleValue('이거 진짜'); // 이거진짜

function getLinkbaitBodyLinkTitleNeedle(config = {}) {
  const normalizedNeedle = normalizeImmediateTitleValue(
    config.linkbaitBodyLinkTitleNeedle || DEFAULT_CONFIG.linkbaitBodyLinkTitleNeedle,
  );
  return normalizedNeedle || DEFAULT_LINKBAIT_TITLE_NEEDLE;
}
```

후보 조건:

```js
function isLinkbaitBodyLinkTitleCandidate(row = {}, config = {}) {
  const postNo = Number(row?.no) || 0;
  if (postNo <= 0) {
    return false;
  }

  if (row?.isFluid !== true) {
    return false;
  }

  if (isAlreadySpamHead(row?.currentHead)) {
    return false;
  }

  const normalizedTitle = normalizeImmediateTitleValue(row?.title || row?.subject || '');
  return normalizedTitle.includes(getLinkbaitBodyLinkTitleNeedle(config));
}
```

주의:

- `linkbaitBodyLinkTitleNeedle`를 config에 넣는다면 후보 판정도 반드시 config 값을 봐야 한다.
- 상수 `DEFAULT_LINKBAIT_TITLE_NEEDLE`만 직접 쓰면 나중에 기본 키워드를 바꿔도 실제 판정이 따라오지 않는다.
- 이번 UI에는 별도 설정을 노출하지 않지만, 내부 config와 후보 판정은 일관되게 연결한다.

예시:

```text
#1001 이거 진짜에요 / 유동 / 도배기탭 아님 -> 후보
#1002 이거 진짜에요 / 고닉 -> 스킵
#1003 이거 진짜에요 / 유동 / 이미 도배기탭 -> 스킵
#1004 진짜 이거임 / 유동 -> 스킵
```

### 본문 조회

`handleLinkbaitBodyLinkRows()` 안에서 후보만 조회한다.

```js
if (!getLinkbaitBodyLinkEnabled(this.config)) {
  return new Set();
}

const processedLinkbaitBodyLinkPostNos = new Set();
const candidates = [];
for (const row of Array.isArray(rows) ? rows : []) {
  const postNo = Math.max(0, Number(row?.no) || 0);
  if (!isLinkbaitBodyLinkTitleCandidate(row, this.config)) {
    continue;
  }

  this.lastLinkbaitBodyLinkCandidateCount += 1;
  const actionKey = buildLinkbaitBodyLinkActionKey(postNo);
  if (
    shouldSkipRecentLinkbaitBodyLinkAction(
      this.recentLinkbaitBodyLinkActions[actionKey],
      nowMs,
      getRetryCooldownMs(this.config),
    )
  ) {
    processedLinkbaitBodyLinkPostNos.add(postNo);
    this.log(`ℹ️ 이거진짜 링크본문 스킵 - #${postNo}는 최근 처리 이력이 있어 건너뜀`);
    continue;
  }

  candidates.push(row);
}

const checkedResults = await mapWithConcurrencyWorkerPool(
  candidates,
  getLinkbaitBodyLinkFetchConcurrency(this.config),
  getLinkbaitBodyLinkFetchRequestDelayMs(this.config),
  async (row) => {
    const postNo = Math.max(0, Number(row?.no) || 0);
    try {
      const viewHtml = await runWithTimeoutSignal(
        getLinkbaitBodyLinkFetchTimeoutMs(this.config),
        (signal) => this.fetchPostViewHtml(this.config, postNo, { signal }),
        '이거진짜 링크본문 조회 시간 초과',
      );

      return {
        row,
        postNo,
        matched: hasUserHttpsLinkInPostBody(viewHtml),
      };
    } catch (error) {
      this.log(`⚠️ 이거진짜 링크본문 조회 실패 - #${postNo}: ${error.message}`);
      return {
        row,
        postNo,
        matched: false,
        failed: true,
      };
    }
  },
  () => this.isRunning,
  this.delayFn,
);

this.lastLinkbaitBodyLinkCheckedCount = candidates.length;
const matchedRows = checkedResults
  .filter((result) => result?.matched === true)
  .map((result) => result.row)
  .filter(Boolean);
this.lastLinkbaitBodyLinkMatchedCount = matchedRows.length;
```

권장 기본값:

```js
linkbaitBodyLinkFetchConcurrency: 10,
linkbaitBodyLinkFetchRequestDelayMs: 100,
linkbaitBodyLinkFetchTimeoutMs: 5 * 1000,
```

timeout은 현재 `dc-session-broker`의 `DEFAULT_LEASE_DRAIN_TIMEOUT_MS` 5초와 맞춘다.

이유:

- broker는 active lease를 직접 abort하지 않고 drain을 기다린다.
- 본문 조회가 15초까지 늘어지면 다른 계정 전환/삭제한도 fallback이 5초 drain timeout에 걸릴 수 있다.
- 5초 안에 view HTML을 못 받으면 이번 사이클에서는 실패 로그만 남기고 다음 사이클에서 다시 보면 된다.

요청량 예시:

```text
page1 글 50개
이 중 제목 정규화 후 "이거진짜" 포함 글 2개
-> view HTML 조회 2번만 추가
```

공격자가 50개 전부 `이거진짜` 제목으로 올린 경우:

```text
동시성 10, worker pool 방식
-> 10개씩 병렬 조회
-> 정상 응답이면 수 초 내 처리
-> 일부 timeout이면 timeout 로그를 남기고 다음 사이클로 넘어감
```

중요:

- `run()`은 사이클이 끝난 뒤 10초를 다시 기다린다.
- 따라서 어떤 사이클이 오래 걸리면 다음 사이클은 밀린다.
- 이 기능은 후보 글만 조회하므로 평상시 지연은 거의 없다.
- timeout은 반드시 로그를 남겨야 한다.

recent action 처리 기준:

```text
본문 조회 실패: recent action 저장 안 함, processedPostNos에 넣지 않음
본문 링크 없음: recent action 저장 안 함, processedPostNos에 넣지 않음
본문 링크 확인 후 제재 시도: 성공/실패 모두 recent action 저장
recent success: 24시간 스킵하고 processedPostNos에 넣음
recent failure: retryCooldownMs 동안 스킵하고 processedPostNos에 넣음
```

예시:

```text
#9001 이거진짜 제목, 본문 링크 있음, 제재 성공
-> recent success 저장
-> 다음 사이클에서 #9001은 재조회하지 않고 다른 방어 경로도 건너뜀

#9002 이거진짜 제목, 본문 조회 timeout
-> recent 저장 안 함
-> 다른 방어 경로는 계속 볼 수 있음

#9003 이거진짜 제목, 본문 링크 있음, API 실패
-> recent failure 저장
-> retryCooldownMs 동안 같은 글을 반복 제재하지 않음
```

### 실행

본문 링크가 확인된 row만 `createImmediateTitleBanTargetPosts()`로 target post를 만든다.

```js
const targetPosts = createImmediateTitleBanTargetPosts(matchedRows);
this.lastLinkbaitBodyLinkRepresentative = summarizeMatchedTitles(
  matchedRows.map((row) => row?.title || row?.subject || ''),
);
```

`matchedRows`가 0개면 실행하지 않고 `processedLinkbaitBodyLinkPostNos`를 그대로 반환한다.

실행은 기존 `executeBanWithDeleteFallback()`을 쓴다.

```js
const result = await this.executeBan({
  feature: 'uidWarningAutoBan',
  config: {
    ...this.config,
    avoidHour: ATTACK_TITLE_BAN_HOUR,
    avoidReason: '0',
    avoidReasonText: ATTACK_TITLE_BAN_REASON_TEXT,
    delChk: true,
    avoidTypeChk: true,
  },
  posts: targetPosts,
  deleteEnabled: this.runtimeDeleteEnabled,
  onDeleteLimitFallbackSuccess: (fallbackResult) => {
    this.log(`🔁 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 같은 run을 이어갑니다.`);
  },
  onDeleteLimitBanOnlyActivated: (message) => {
    this.activateDeleteLimitBanOnly(message);
  },
});

this.lastLinkbaitBodyLinkActionCount += targetPosts.length;
this.totalLinkbaitBodyLinkPostCount += result.successNos.length;
this.totalBannedPostCount += result.successNos.length;
this.totalFailedPostCount += result.failedNos.length;
this.deleteLimitFallbackCount += result.deleteLimitFallbackCount;
if (result.banOnlyFallbackUsed) {
  this.banOnlyFallbackCount += 1;
}
this.runtimeDeleteEnabled = result.finalDeleteEnabled;
```

실행 후 처리:

```js
const actionAt = new Date().toISOString();
const successNos = new Set(result.successNos.map((postNo) => String(postNo)));
for (const targetPost of targetPosts) {
  processedLinkbaitBodyLinkPostNos.add(Number(targetPost.no) || 0);
  this.recentLinkbaitBodyLinkActions[buildLinkbaitBodyLinkActionKey(targetPost.no)] =
    createRecentLinkbaitBodyLinkActionEntry({
      success: successNos.has(String(targetPost.no)),
      nowIso: actionAt,
    });
}

return processedLinkbaitBodyLinkPostNos;
```

중요한 차이:

- 본문 조회 실패, 링크 없음은 `processedLinkbaitBodyLinkPostNos`에 넣지 않는다.
- 링크 확인 후 제재 시도까지 간 글은 성공/실패와 관계없이 넣는다.
- 이렇게 해야 같은 사이클에서 같은 글을 실제공격 제목군집/UID 경로가 중복 제재하지 않는다.

사유:

```text
도배기IP차단(무고한 경우 문의)
```

차단 시간:

```text
6시간
```

정상 모드 결과:

```text
IP차단 + 삭제
```

삭제 한도 보호 모드 결과:

```text
차단만 수행
```

왜 삭제 전용 API를 쓰지 않는가:

- `features/post/api.js`의 삭제 API는 게시글 삭제만 한다.
- 삭제 한도 계정전환 fallback이 붙어 있지 않다.
- 분탕자동차단의 다른 글 제재 흐름과 통계/로그가 달라진다.
- 이 기능은 공격 링크글 방어이므로 기존 `차단/삭제` executor를 타는 것이 맞다.

## recent action 처리

같은 글을 매 사이클마다 다시 조회/차단하지 않기 위해 recent map을 둔다.

```js
this.recentLinkbaitBodyLinkActions = {};
```

key:

```js
function buildLinkbaitBodyLinkActionKey(postNo) {
  return buildImmediatePostActionKey(postNo);
}
```

recent helper는 제목 직차단 helper와 같은 구조를 재사용한다.

```js
function createRecentLinkbaitBodyLinkActionEntry({ success, nowIso }) {
  return createRecentImmediatePostActionEntry({ success, nowIso });
}

function shouldSkipRecentLinkbaitBodyLinkAction(entry, nowMs, retryCooldownMs) {
  return shouldSkipRecentImmediatePostAction(entry, nowMs, retryCooldownMs);
}

function normalizeRecentLinkbaitBodyLinkActions(raw = {}) {
  return normalizeRecentImmediatePostActions(raw);
}

function pruneRecentLinkbaitBodyLinkActions(entries = {}) {
  pruneRecentImmediatePostActions(entries);
}
```

이렇게 맞추면 성공 24시간 보존, 실패 `retryCooldownMs` 보류라는 기존 제목 계열 동작과 동일하게 움직인다.

entry:

```js
{
  lastActionAt: '2026-04-27T...',
  success: true
}
```

skip 기준:

- 성공 처리된 글은 24시간 동안 재시도하지 않는다.
- 실패 처리된 글은 `retryCooldownMs` 동안만 건너뛴다.
- 본문에 링크가 없던 글은 action map에 넣지 않는다.

왜 링크 없는 글은 action map에 넣지 않는가:

- 공격자가 처음엔 링크 없이 올렸다가 수정으로 링크를 넣을 수 있다.
- 또는 첫 조회 시 본문 로딩/파싱이 불완전할 수 있다.
- 링크 없음은 “정상 확정”이 아니라 “이번 사이클에서 삭제 조건 없음”으로만 본다.

## 상태 저장/복원 연결

`saveState()`에 추가:

```js
lastLinkbaitBodyLinkCandidateCount
lastLinkbaitBodyLinkCheckedCount
lastLinkbaitBodyLinkMatchedCount
lastLinkbaitBodyLinkActionCount
lastLinkbaitBodyLinkRepresentative
totalLinkbaitBodyLinkPostCount
recentLinkbaitBodyLinkActions
```

`loadState()`에 추가:

```js
this.lastLinkbaitBodyLinkCandidateCount = Math.max(0, Number(...) || 0);
this.lastLinkbaitBodyLinkCheckedCount = Math.max(0, Number(...) || 0);
this.lastLinkbaitBodyLinkMatchedCount = Math.max(0, Number(...) || 0);
this.lastLinkbaitBodyLinkActionCount = Math.max(0, Number(...) || 0);
this.lastLinkbaitBodyLinkRepresentative = String(... || '');
this.totalLinkbaitBodyLinkPostCount = Math.max(0, Number(...) || 0);
this.recentLinkbaitBodyLinkActions = normalizeRecentLinkbaitBodyLinkActions(...);
```

`getStatus()`에 같은 필드를 추가한다.

`getStatus()` 시작부 prune도 같이 맞춘다.

현재 실제 코드는 `recentUidActions`, `recentAttackTitlePostActions`, `recentAttackCommentActions`를 prune하지만 `recentImmediatePostActions`는 `runCycle()`/`loadState()`에서만 prune한다. 새 기능을 넣을 때 아래처럼 제목 계열 recent map을 함께 정리하는 쪽이 일관적이다.

```js
pruneRecentUidActions(this.recentUidActions);
pruneRecentImmediatePostActions(this.recentImmediatePostActions);
pruneRecentAttackTitlePostActions(this.recentAttackTitlePostActions);
pruneRecentLinkbaitBodyLinkActions(this.recentLinkbaitBodyLinkActions);
pruneRecentAttackCommentActions(this.recentAttackCommentActions);
```

`runCycle()` 시작부에 최근값 초기화:

```js
this.lastLinkbaitBodyLinkCandidateCount = 0;
this.lastLinkbaitBodyLinkCheckedCount = 0;
this.lastLinkbaitBodyLinkMatchedCount = 0;
this.lastLinkbaitBodyLinkActionCount = 0;
this.lastLinkbaitBodyLinkRepresentative = '';
pruneRecentLinkbaitBodyLinkActions(this.recentLinkbaitBodyLinkActions);
```

사이클 완료 로그에 누적값 추가:

```text
... / 이거진짜 링크본문 ${this.totalLinkbaitBodyLinkPostCount}개 / ...
```

## config 연결

`DEFAULT_CONFIG`에 추가한다.

```js
linkbaitBodyLinkEnabled: true,
linkbaitBodyLinkTitleNeedle: '이거 진짜',
linkbaitBodyLinkFetchConcurrency: 10,
linkbaitBodyLinkFetchRequestDelayMs: 100,
linkbaitBodyLinkFetchTimeoutMs: 5 * 1000,
```

`normalizeConfig()`에 추가한다.

```js
linkbaitBodyLinkEnabled: config.linkbaitBodyLinkEnabled === undefined
  ? Boolean(DEFAULT_CONFIG.linkbaitBodyLinkEnabled)
  : Boolean(config.linkbaitBodyLinkEnabled),
linkbaitBodyLinkTitleNeedle: String(config.linkbaitBodyLinkTitleNeedle || DEFAULT_CONFIG.linkbaitBodyLinkTitleNeedle).trim() || DEFAULT_CONFIG.linkbaitBodyLinkTitleNeedle,
linkbaitBodyLinkFetchConcurrency: Math.max(1, Number(config.linkbaitBodyLinkFetchConcurrency) || DEFAULT_CONFIG.linkbaitBodyLinkFetchConcurrency),
linkbaitBodyLinkFetchRequestDelayMs: Math.max(0, Number(config.linkbaitBodyLinkFetchRequestDelayMs) || DEFAULT_CONFIG.linkbaitBodyLinkFetchRequestDelayMs),
linkbaitBodyLinkFetchTimeoutMs: Math.max(1000, Number(config.linkbaitBodyLinkFetchTimeoutMs) || DEFAULT_CONFIG.linkbaitBodyLinkFetchTimeoutMs),
```

UI에서 설정을 따로 노출하지는 않는다.

이유:

- 이번 요청은 분탕자동차단 기본 방어 강화다.
- 관리자에게 새 설정을 강제하면 오히려 켜지지 않은 상태로 배포될 수 있다.
- 값은 코드 기본값으로 고정하고, 필요하면 나중에 UI 옵션으로 빼면 된다.

`buildPersistedConfig()`에는 일단 넣지 않는다.

이유:

- 사용자가 직접 바꿀 UI가 없다.
- 기본값은 코드에서 항상 복구된다.
- 기존 `buildPersistedConfig()`도 gallery/base/immediate rules만 저장하는 구조다.

`popup.js`의 `getFeatureConfigInputs('uidWarningAutoBan')`에도 새 input은 추가하지 않는다.

이유:

- `linkbaitBodyLinkEnabled`, `linkbaitBodyLinkTitleNeedle`, fetch concurrency는 숨은 기본값이다.
- UI input이 없는데 config dirty tracking에만 넣으면 저장/렌더 흐름이 오히려 헷갈린다.
- 나중에 토글을 만들 때 `buildPersistedConfig()`와 `getFeatureConfigInputs()`를 같이 열면 된다.

## background reset 연결

아래 두 곳에 새 상태 초기화를 추가해야 한다.

```text
background/background.js
- resetSchedulerStats(feature === 'uidWarningAutoBan')
- resetUidWarningAutoBanSchedulerState(message)
```

추가 필드:

```js
scheduler.lastLinkbaitBodyLinkCandidateCount = 0;
scheduler.lastLinkbaitBodyLinkCheckedCount = 0;
scheduler.lastLinkbaitBodyLinkMatchedCount = 0;
scheduler.lastLinkbaitBodyLinkActionCount = 0;
scheduler.lastLinkbaitBodyLinkRepresentative = '';
scheduler.totalLinkbaitBodyLinkPostCount = 0;
scheduler.recentLinkbaitBodyLinkActions = {};
```

이걸 빼먹으면:

- 통계 초기화 버튼을 눌러도 새 통계가 남는다.
- 설정 변경 reset 후에도 recent map이 남아 새 글 처리 판단이 꼬일 수 있다.

## popup 표시

`popup/popup.html`의 분탕자동차단 status-grid에 아래 칸을 추가한다.

권장 위치:

- `최근 제목 제재` 다음
- `최근 실제공격 군집` 전

추가 DOM:

```html
<div class="status-item">
  <span class="status-label">최근 링크미끼 후보</span>
  <span id="uidWarningAutoBanLastLinkbaitBodyLinkCandidateCount" class="status-value">0개</span>
</div>
<div class="status-item">
  <span class="status-label">최근 링크미끼 제재</span>
  <span id="uidWarningAutoBanLastLinkbaitBodyLinkActionCount" class="status-value">0개</span>
</div>
<div class="status-item">
  <span class="status-label">최근 링크미끼 제목</span>
  <span id="uidWarningAutoBanLastLinkbaitBodyLinkRepresentative" class="status-value">-</span>
</div>
<div class="status-item">
  <span class="status-label">누적 링크미끼 글</span>
  <span id="uidWarningAutoBanTotalLinkbaitBodyLinkPostCount" class="status-value">0개</span>
</div>
```

`popup/popup.js`의 `FEATURE_DOM.uidWarningAutoBan`에 연결:

```js
lastLinkbaitBodyLinkCandidateCount: document.getElementById('uidWarningAutoBanLastLinkbaitBodyLinkCandidateCount'),
lastLinkbaitBodyLinkActionCount: document.getElementById('uidWarningAutoBanLastLinkbaitBodyLinkActionCount'),
lastLinkbaitBodyLinkRepresentative: document.getElementById('uidWarningAutoBanLastLinkbaitBodyLinkRepresentative'),
totalLinkbaitBodyLinkPostCount: document.getElementById('uidWarningAutoBanTotalLinkbaitBodyLinkPostCount'),
```

`updateUidWarningAutoBanUI()`에 추가:

```js
dom.lastLinkbaitBodyLinkCandidateCount.textContent = `${nextStatus.lastLinkbaitBodyLinkCandidateCount ?? 0}개`;
dom.lastLinkbaitBodyLinkActionCount.textContent = `${nextStatus.lastLinkbaitBodyLinkActionCount ?? 0}개`;
dom.lastLinkbaitBodyLinkRepresentative.textContent = nextStatus.lastLinkbaitBodyLinkRepresentative || '-';
dom.totalLinkbaitBodyLinkPostCount.textContent = `${nextStatus.totalLinkbaitBodyLinkPostCount ?? 0}개`;
```

`buildDefaultUidWarningAutoBanStatus()`에도 같은 필드 기본값을 추가해야 한다.

```js
lastLinkbaitBodyLinkCandidateCount: 0,
lastLinkbaitBodyLinkCheckedCount: 0,
lastLinkbaitBodyLinkMatchedCount: 0,
lastLinkbaitBodyLinkActionCount: 0,
lastLinkbaitBodyLinkRepresentative: '',
totalLinkbaitBodyLinkPostCount: 0,
```

`buildUidWarningAutoBanMetaText()` 우선순위:

```text
삭제한도/ban-only 안내
-> 최근 제목 직차단
-> 최근 이거진짜 링크본문
-> 최근 실제공격 제목군집
-> 최근 실제공격 댓글군집
-> 단일깡계
-> UID burst
```

추가 문구:

```js
if ((status.lastLinkbaitBodyLinkActionCount ?? 0) > 0) {
  return `최근 이거진짜 링크본문 ${status.lastLinkbaitBodyLinkRepresentative || '제목'} / page1 유동글 ${status.lastLinkbaitBodyLinkActionCount ?? 0}개 제재`;
}
```

기본 meta 문구도 바꾼다.

현재:

```text
10초마다 1페이지를 확인해 금칙 제목, 실제공격 제목/댓글 군집, 글댓총합 20 미만 page1 burst 깡계, 방명록 잠금 저활동 깡계를 함께 봅니다.
```

변경:

```text
10초마다 1페이지를 확인해 금칙 제목, 이거진짜 링크본문, 실제공격 제목/댓글 군집, 글댓총합 20 미만 page1 burst 깡계, 방명록 잠금 저활동 깡계를 함께 봅니다.
```

## 로그 설계

후보가 있을 때:

```text
🔎 이거진짜 링크본문 후보 3개 확인 시작
```

조회 실패:

```text
⚠️ 이거진짜 링크본문 조회 실패 - #1134001: 이거진짜 링크본문 조회 시간 초과 (5000ms)
```

본문에 링크 없음:

```text
ℹ️ 이거진짜 링크본문 스킵 - #1134002 본문 사용자 https 링크 없음
```

링크 발견:

```text
🚨 이거진짜 링크본문 "이거 진짜에요" 2개 -> 차단/삭제 시작
```

성공:

```text
⛔ 이거진짜 링크본문 글 2개 차단/삭제 완료
```

삭제 한도:

```text
🧯 이거진짜 링크본문 글 1개는 차단만 수행
```

실패:

```text
⚠️ 이거진짜 링크본문 제재 실패 1개 - 1134003
```

## 실제 플로우 예시

### 예시 1. 공격 링크글

page1:

```text
#9001 유동 제목: 이거 진짜에요
```

본문:

```text
https://example.com/abc
```

흐름:

```text
제목 정규화 -> 이거진짜에요
"이거진짜" 포함 -> view HTML 조회
write_div 본문 추출
본문 텍스트에 https:// 있음
executeBanWithDeleteFallback 호출
도배기IP차단(무고한 경우 문의) / 6시간 / del_chk=1
성공 시 processedPostNos에 #9001 추가
실제공격 제목군집/댓글군집/UID 경로는 #9001을 건너뜀
```

### 예시 2. 제목만 비슷하고 링크 없음

page1:

```text
#9002 유동 제목: 이거 진짜임?
```

본문:

```text
그냥 질문글입니다.
```

흐름:

```text
제목 정규화 -> 이거진짜임
"이거진짜" 포함 -> view HTML 조회
본문 사용자 https 링크 없음
삭제/차단 안 함
processedPostNos에 넣지 않음
다른 방어 로직은 계속 볼 수 있음
```

### 예시 3. 이미지 업로드 글

page1:

```text
#9003 유동 제목: 이거 진짜임
```

본문 HTML:

```html
<img src="https://dcimg5.dcinside.com/viewimage.php?...">
```

흐름:

```text
본문 추출
img 태그 제거
사용자 링크 없음
삭제/차단 안 함
```

### 예시 4. 이미 도배기탭 글

page1:

```text
#9004 유동 제목: 이거 진짜에요
현재 말머리: 도배기
```

흐름:

```text
이미 처리된 글로 보고 스킵
중복 차단/삭제 요청 안 함
```

### 예시 5. 삭제 한도 초과

page1:

```text
#9005 유동 제목: 이거 진짜에요
본문 링크 있음
```

흐름:

```text
executeBanWithDeleteFallback 호출
1번 계정 삭제 한도 초과
dc-session-broker 계정 fallback 요청
2번 계정 전환 성공 시 같은 postNo 재시도
fallback 실패 시 runtimeDeleteEnabled=false
이후 같은 run에서 ban-only 재시도
```

## 정적 검증 케이스

구현 후 최소 아래 케이스를 코드 기준으로 확인한다.

1. `이거 진짜에요` 제목이 `이거진짜에요`로 정규화되어 후보가 된다.
2. `이거.진짜` 제목이 `이거진짜`로 정규화되어 후보가 된다.
3. `이거x진짜` 제목이 한글 사이 영어 filler 제거로 후보가 된다.
4. `이거ˇ진짜` 제목이 기호 제거로 후보가 된다.
5. `진짜 이거` 제목은 순서가 달라 후보가 되지 않는다.
6. 고닉 글은 제목이 맞아도 후보가 되지 않는다.
7. 유동 글은 제목이 맞으면 후보가 된다.
8. 글번호가 0이거나 없으면 후보가 되지 않는다.
9. 이미 제목 직차단으로 처리된 postNo는 후보에서 빠진다.
10. 이미 도배기탭/currentHead인 글은 후보에서 빠진다.
11. recent success가 있는 postNo는 재조회/재처리하지 않는다.
12. recent failure가 있는 postNo는 retryCooldownMs 전에는 재시도하지 않는다.
13. 링크가 없던 글은 recent success로 저장하지 않아 다음 사이클에서 다시 확인 가능하다.
14. view HTML fetch 실패는 로그만 남기고 다른 방어 흐름은 유지된다.
15. view HTML fetch timeout은 `이거진짜 링크본문 조회 시간 초과` 로그를 남긴다.
16. 전체 view HTML의 광고/CDN `https://` 때문에 삭제되지 않는다.
17. `write_div` 본문 안 텍스트 `https://example.com`은 매치된다.
18. `write_div` 본문 안 `<a href="https://example.com">`은 매치된다.
19. `img src="https://dcimg..."`만 있는 글은 매치되지 않는다.
20. `script src="https://..."`는 본문 링크로 보지 않는다.
21. `style` 안 `https://`는 본문 링크로 보지 않는다.
22. 본문 추출 실패 시 삭제하지 않는다.
23. 본문에 `http://`만 있으면 이번 기준에서는 삭제하지 않는다.
24. 본문에 `https://gall.dcinside.com/...`만 anchor href로 있으면 내부 링크 제외 정책에 따라 삭제하지 않는다.
25. 본문 텍스트에 `https://`가 보이면 삭제한다.
26. 여러 후보 중 링크 있는 글만 targetPosts에 들어간다.
27. targetPosts는 글번호 기준으로 dedupe된다.
28. 성공한 글은 `processedPostNos`에 들어가 실제공격 제목군집으로 넘어가지 않는다.
29. 링크 없는 글은 `processedPostNos`에 들어가지 않아 기존 방어가 계속 볼 수 있다.
30. executeBan 성공 시 `totalLinkbaitBodyLinkPostCount`가 증가한다.
31. executeBan 실패 시 `totalFailedPostCount`가 증가한다.
32. 삭제 한도 fallback 성공 시 `deleteLimitFallbackCount`가 증가한다.
33. ban-only fallback 사용 시 `banOnlyFallbackCount`가 증가한다.
34. runtimeDeleteEnabled=false 상태에서는 차단만 수행하고 UI도 `차단만 유지`를 보여준다.
35. 통계 초기화 시 링크미끼 통계와 recent map이 같이 초기화된다.
36. 확장 재시작 후 저장된 recent map이 복원되고 prune된다.
37. popup status-grid에 최근 후보/제재/대표제목/누적값이 표시된다.
38. meta text 우선순위가 제목 직차단보다 낮고 실제공격 제목군집보다 높게 표시된다.
39. `isRunning=false`가 되면 worker pool이 추가 조회를 멈춘다.
40. 후보가 0개면 추가 view HTML 요청은 0번이다.
41. `linkbaitBodyLinkEnabled=false`이면 후보가 있어도 view HTML 요청을 하지 않는다.
42. config의 `linkbaitBodyLinkTitleNeedle`를 바꾸면 후보 판정 needle도 같이 바뀐다.
43. `<a href='https://example.com'>` 작은따옴표 href도 매치된다.
44. `<a href=https://example.com>` unquoted href도 매치된다.
45. `<a href="https&#58;//example.com">` numeric entity href도 매치된다.
46. `<a href="https&#x3a;//example.com">` hex numeric entity href도 매치된다.
47. `AbortError`가 발생하면 `dcFetchWithRetry()`가 재시도하지 않고 즉시 중단한다.
48. 429/403 backoff 중 timeout signal이 abort되면 delay가 즉시 중단된다.
49. session broker가 나중에 lease signal abort를 지원해도 post view fetch가 같이 abort될 수 있게 signal merge가 되어 있다.
50. `fetchUidWarningAutoBanPostViewHTML`이 timeout signal과 lease signal을 merge해서 쓰되, 현재 실제 종료 상한은 timeout signal이 보장한다.
51. `<div class='write_div'>` 작은따옴표 본문 영역도 추출된다.
52. `<div class=write_div>` unquoted 본문 영역도 추출된다.
53. requestGateBlocked 상태에서 post view fetch를 시작하면 withDcRequestLease gate 대기도 5초 timeout으로 중단된다.
54. withDcRequestLease signal 보강 후에도 기존 호출부는 세 번째 인자를 안 넘기므로 기존 기능 동작이 유지된다.

## 구현 순서

1. `background/dc-session-broker.js`

```text
waitUntilDcSessionReady(options = {})에서 options.signal 확인
acquireDcRequestLease(meta, options = {})에서 signal 전달
withDcRequestLease(meta, work, options = {})에서 signal 전달
sleep(ms, signal) optional signal 보강
waitForPromiseOrAbort/createAbortError helper 추가
기존 호출부 호환 유지
```

2. `features/uid-warning-autoban/api.js`

```text
DEFAULT_CONFIG에 linkbaitBodyLink 기본값 추가
dcFetchWithRetry AbortError 즉시 중단 보강
delay(ms, signal) optional signal 보강
mergeAbortSignals helper 추가
fetchUidWarningAutoBanPostViewHTML 추가
export 추가
```

3. `features/uid-warning-autoban/parser.js`

```text
extractPostBodyHtml 추가
hasUserHttpsLinkInPostBody 추가
decodeHtml numeric entity 처리 보강
필요 시 내부 helper decodeHtml/stripTags 재사용
export 추가
```

4. `features/uid-warning-autoban/attack-title-cluster.js`

```text
이미 isAlreadySpamHead가 export되어 있으므로 수정 불필요
scheduler.js import만 추가
```

5. `features/uid-warning-autoban/scheduler.js`

```text
fetchPostViewHtml dependency 추가
hasUserHttpsLinkInPostBody import
isAlreadySpamHead import
상태 필드 추가
runCycle에 handleLinkbaitBodyLinkRows 삽입
handleLinkbaitBodyLinkRows 추가
recent action helper 추가
saveState/loadState/getStatus 연결
normalizeConfig/getter 연결
getStatus prune 연결, 기존 recentImmediatePostActions prune도 같이 보강
사이클 완료 로그 연결
```

6. `background/background.js`

```text
resetSchedulerStats(uidWarningAutoBan) 초기화 필드 추가
resetUidWarningAutoBanSchedulerState 초기화 필드 추가
```

7. `popup/popup.html`

```text
status-grid에 링크미끼 표시칸 추가
기본 meta 문구 수정
```

8. `popup/popup.js`

```text
FEATURE_DOM 연결
buildDefaultUidWarningAutoBanStatus 기본값 추가
updateUidWarningAutoBanUI 렌더 추가
buildUidWarningAutoBanMetaText 문구 추가
```

9. 검증

```text
node --check background/dc-session-broker.js
node --check features/uid-warning-autoban/api.js
node --check features/uid-warning-autoban/parser.js
node --check features/uid-warning-autoban/scheduler.js
node --check background/background.js
node --check popup/popup.js
```

가능하면 목업으로 parser helper를 직접 검증한다.

```text
제목: 이거 진짜에요
본문: <div class="write_div">https://example.com</div>
예상: 후보 + 링크 있음

제목: 이거 진짜에요
본문: <div class="write_div"><img src="https://dcimg5.dcinside.com/a.jpg"></div>
예상: 후보 + 링크 없음
```

추가로 import/export 연결 검증을 한다.

```text
attack-title-cluster.js에서 isAlreadySpamHead named export가 실제로 import되는지 확인
parser.js에서 hasUserHttpsLinkInPostBody named export가 scheduler.js에서 import되는지 확인
api.js에서 fetchUidWarningAutoBanPostViewHTML named export가 scheduler.js에서 import되는지 확인
api.js에서 dcFetchWithRetry가 AbortError를 즉시 throw하는지 확인
api.js에서 fetchUidWarningAutoBanPostViewHTML이 lease.signal과 options.signal을 merge하는지 확인
popup.html에 추가한 id가 popup.js FEATURE_DOM에 모두 존재하는지 확인
```

## 최종 판단

이 기능은 기존 구조에 크게 무리 없이 붙일 수 있다.

핵심은 4가지다.

```text
1. 제목은 기존 normalizeImmediateTitleValue()로 정규화 후 "이거진짜" 포함 검사
2. 본문은 전체 HTML이 아니라 write_div 범위만 검사
3. 삭제/차단은 executeBanWithDeleteFallback()을 써서 기존 계정전환/삭제한도 fallback을 유지
4. 본문 조회 timeout은 fetch뿐 아니라 withDcRequestLease gate 대기에도 적용되게 session broker signal을 보강
```

이렇게 구현하면 10초 루프를 새로 만들지 않고 기존 분탕자동차단 루프에 얹을 수 있다. 평상시에는 제목 후보가 없으므로 추가 요청이 0번이고, 공격 제목이 뜬 경우에만 해당 글 본문 view HTML을 조회한다.
