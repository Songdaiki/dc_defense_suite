# AI 관리자 전수 판정 dry-run 웹 설계서

작성일: 2026-05-03

## 1. 목표

이 문서는 기존 특궁/신문고봇 운영 확장을 절대 건드리지 않고, 별도 Node 프로젝트로 `AI 관리자 전수 판정 데모`를 만드는 실행 설계서다.

목표는 실제 삭제/차단이 아니라, 1~20페이지 게시글을 Gemini CLI로 전수 판정했을 때 얼마나 많은 글이 `AI 기준 조치 대상`이 되는지 웹으로 보여주는 것이다.

예시:

```text
최근 1~20페이지 987개 글 전수 판정
- AI 조치 대상: 143개
- 사람 검토 필요: 221개
- 문제 없음: 623개

이 결과는 실제 삭제/차단이 아니라 dry-run 시뮬레이션입니다.
```

## 2. 결론

확장은 필요 없다.

새 프로젝트는 아래처럼 별도 Node 로컬 웹으로 만든다.

```text
projects/ai_moderator_dry_run/
```

이유:

1. 게시글 목록/본문 HTML은 공개 URL에서 Node `fetch()`로 가져올 수 있다.
2. 게시글 번호 파싱, 제목/본문/이미지 파싱은 브라우저 API 없이 문자열 처리로 가능하다.
3. Gemini CLI helper, worker, JSONL DB, transparency 웹 구조는 기존 `projects/dc_auto_bot` 레퍼런스를 가져오면 된다.
4. 삭제/차단/로그인/쿠키/확장 메시지 연결은 이번 목적에 필요 없고, 오히려 위험하다.

## 3. 절대 원칙

새 프로젝트에는 실제 조치 경로가 들어가면 안 된다.

포함 금지:

```text
update_avoid_list
delete_list
delete_comment
executeDeleteAndBan
ensureLoginSession
chrome.cookies
chrome.runtime
로그인 자동화
관리자 세션 확인
세션 recovery
```

예시:

```text
Gemini decision = action
-> 의미: AI 관리자였다면 조치했을 글
-> 실제 삭제: 안 함
-> 실제 차단: 안 함
-> DB/웹 기록만 저장
```

## 4. 기존 코드 레퍼런스

### 4.1 가져와도 되는 것

게시글 목록/본문 fetch 구조:

- `projects/dc_auto_bot/background/api.js`
- 참고 함수:
  - `fetchPostPage()`
  - `fetchPostListHTML()`

주의:

기존 파일 전체를 그대로 import하면 `chrome.cookies`와 삭제/차단 함수가 같은 파일 안에 섞여 있으므로 위험하다.

따라서 새 프로젝트에서는 아래 함수만 Node용으로 다시 작성한다.

```js
async function fetchPostListHtml({ baseUrl, boardPath, galleryId, page, signal }) {
  const path = normalizeBoardPath(boardPath || 'mgallery');
  const url = `${baseUrl}/${path}/board/lists/?id=${encodeURIComponent(galleryId)}&page=${page}`;
  const response = await fetch(url, { signal, headers: buildDcHtmlHeaders(baseUrl) });
  return response.text();
}

async function fetchPostPageHtml({ baseUrl, boardPath, galleryId, postNo, signal }) {
  const path = normalizeBoardPath(boardPath || 'mgallery');
  const url = `${baseUrl}/${path}/board/view/?id=${encodeURIComponent(galleryId)}&no=${encodeURIComponent(postNo)}`;
  const response = await fetch(url, { signal, headers: buildDcHtmlHeaders(baseUrl) });
  return response.text();
}
```

현재 `projects/dc_auto_bot/background/api.js`의 실제 함수도 `/mgallery/board/lists`, `/mgallery/board/view`에 고정되어 있다. 따라서 이번 dry-run 1차 구현 대상은 `thesingularity` 마이너 갤러리 기준으로 `BOARD_PATH=mgallery`가 맞다.

나중에 일반 갤러리나 미니 갤러리까지 넓히려면 board path를 아래처럼 분리해야 한다.

```text
마이너 갤러리: BOARD_PATH=mgallery
일반 갤러리: BOARD_PATH=board
미니 갤러리: BOARD_PATH=mini/board
```

이번 문서의 구현 범위는 마이너 갤러리 dry-run이다.

목록 파싱/본문 파싱:

- `projects/dc_auto_bot/background/parser.js`
- 참고 함수:
  - `parseRegularBoardPosts()`
  - `extractPostContentForLlm()`
  - `extractPostAuthorMeta()`
  - `extractRecommendState()`

이 파일은 대부분 순수 문자열 파서라 복사해서 새 프로젝트에 맞게 정리 가능하다.

Gemini CLI/worker:

- `projects/dc_auto_bot/helper/server.mjs`
- 참고 함수:
  - `runGeminiCli()`
  - `parseGeminiCliJson()`
  - `validateJudgeDecision()`
  - `prepareJudgeImageInputs()`
  - `cleanupPreparedJudgeImageInputs()`
  - `createBlurredThumbnail()`

웹 렌더링:

- `projects/dc_auto_bot/helper/transparency.mjs`
- 참고 함수:
  - `renderTransparencyListPage()`
  - `renderTransparencyDetailPage()`

DB:

- `projects/dc_auto_bot/helper/db.mjs`
- 참고 구조:
  - JSONL 파일 저장
  - `upsertRecord()`
  - `listRecords()`
  - `getRecord()`

### 4.2 가져오면 안 되는 것

삭제/차단 API:

- `projects/dc_auto_bot/background/api.js`의 `executeDeleteAndBan()`
- `/ajax/minor_manager_board_ajax/update_avoid_list` 호출

신문고 scheduler의 실제 조치 구간:

- `projects/dc_auto_bot/background/scheduler.js`
- 위험 흐름:

```text
Gemini allow
-> confidence threshold 통과
-> ensureLoginSessionForAction()
-> executeDeleteAndBanWithRecovery()
-> executeDeleteAndBan()
```

새 프로젝트에는 이 흐름을 만들지 않는다.

### 4.3 실제 코드 대조 결과

기존 코드를 읽어본 결과, 단순 복사하면 바로 문제가 생기는 지점이 있다.

1. 기존 helper DB는 `source`를 `auto_report` 또는 `manual_test`만 허용한다.
   - 위치: `projects/dc_auto_bot/helper/db.mjs`
   - `source: "ai_moderator_dry_run"`을 그대로 넣으면 record가 `null` 처리될 수 있다.
   - 새 `db.mjs`에서는 `ai_moderator_dry_run`을 허용하도록 반드시 수정한다.

2. 기존 helper prompt에는 신고 사유와 신고자 정보가 들어간다.
   - 위치: `projects/dc_auto_bot/helper/server.mjs`의 `buildGeminiCliPrompt()`
   - dry-run은 신고 댓글 기반이 아니므로 `신고 사유`, `신고자 label`, `작성자 필터 결과`를 prompt에서 제거해야 한다.

3. 기존 helper prompt와 `/judge` route에는 특정 닉네임 강제 allow 분기가 있다.
   - 위치: `FORCE_ALLOW_AUTHOR_NICK = "상냥한에옹"`
   - dry-run 목적은 전수 판정이므로 특정 작성자 강제 승인/강제 조치 분기는 제거해야 한다.

4. 기존 transparency 문구는 실제 신고/삭제 운영용이다.
   - `삭제 승인`
   - `삭제 반려`
   - `신고 사유`
   - `삭제/차단 응답 디버그 보기`
   - 새 웹에서는 전부 dry-run 문구로 바꾼다.

5. 기존 `api.js`는 안전한 fetch 함수와 위험한 삭제/차단 함수가 같은 파일에 있다.
   - 전체 import 금지.
   - 필요한 fetch/header 로직만 새 `fetcher.mjs`로 직접 옮긴다.

예시:

```text
나쁜 방식:
import { fetchPostPage, executeDeleteAndBan } from "../dc_auto_bot/background/api.js"

좋은 방식:
fetchPostPageHtml()만 새 프로젝트에 직접 구현
executeDeleteAndBan 이름 자체가 새 프로젝트에 존재하지 않게 함
```

## 5. 새 프로젝트 구조

권장 구조:

```text
projects/ai_moderator_dry_run/
  package.json
  README.md
  server.mjs
  scanner.mjs
  queue.mjs
  fetcher.mjs
  parser.mjs
  prompt.mjs
  judge.mjs
  gemini_worker_manager.mjs
  gemini_worker.mjs
  db.mjs
  transparency.mjs
  docs/
    thesingularity_gallery_policy.md
  public/
    dry-run.css
    bot-icon.png
    gemini-icon.webp
  data/
    dry-run-records.jsonl
    dry-run-queue.jsonl
    transparency-assets/
    gemini-inputs/
```

역할:

```text
server.mjs
-> 로컬 웹/API 서버

scanner.mjs
-> 1~20페이지 목록 수집 후 queue 적재

queue.mjs
-> queued/running/completed/skipped/failed 상태 관리

fetcher.mjs
-> 디시 목록/본문 HTML fetch

parser.mjs
-> 게시글 번호, 제목, 본문, 이미지 URL, 작성자 메타 파싱

prompt.mjs
-> dry-run 전용 Gemini prompt 생성

judge.mjs
-> Gemini CLI 직렬 실행

gemini_worker_manager.mjs
-> 기존 helper의 persistent Gemini worker 재사용

gemini_worker.mjs
-> worker thread에서 실제 Gemini CLI runtime 호출

db.mjs
-> JSONL 기반 결과 저장

transparency.mjs
-> 기존 느낌의 결과 목록/상세 웹 렌더링
```

주의:

기존 `runGeminiCli()`는 `projects/dc_auto_bot/helper/gemini_worker_manager.mjs`에 의존하고, `gemini_worker_manager.mjs`는 다시 `gemini_worker.mjs`를 worker script로 로드한다. 두 파일을 같이 복사하지 않으면 import 또는 worker 생성이 깨진다.

`gemini_worker.mjs`는 내부에서 Gemini CLI package root의 `dist/src/...` 모듈을 동적 import한다. 따라서 새 프로젝트는 Gemini CLI가 기존처럼 설치되어 있고 `GEMINI_COMMAND` 또는 기본 `gemini` 명령으로 package root를 찾을 수 있어야 한다.

선택지는 두 가지다.

```text
권장:
gemini_worker_manager.mjs + gemini_worker.mjs까지 복사해서 기존 worker 구조 유지

단순 구현:
worker를 제거하고 spawn-only runGeminiCli()로 축소
```

이번 기능은 1~20페이지 장시간 판정이므로 worker를 복사하는 쪽이 낫다. 단, queue 자체는 계속 `concurrency=1`로 둔다.

## 6. 실행 플로우

### 6.1 시작

```text
node server.mjs
```

기본 주소:

```text
http://127.0.0.1:4327
```

환경 변수 예시:

```text
PORT=4327
GALLERY_ID=thesingularity
BOARD_PATH=mgallery
PAGE_FROM=1
PAGE_TO=20
GEMINI_ARGS_JSON='["--model","gemini-2.5-flash"]'
GEMINI_TIMEOUT_MS=240000
LLM_CONFIDENCE_THRESHOLD=0.85
```

### 6.2 스캔

사용자가 웹에서 `1~20페이지 스캔 시작`을 누르거나 CLI로 실행한다.

```text
POST /api/scan
```

동작:

```text
for page = 1..20
  목록 HTML fetch
  parseRegularBoardPosts()
  공지/설문/숫자 아닌 row 제외
  post_no 중복 제거
  queue에 queued로 upsert
```

중복 처리:

```text
이미 completed인 post_no
-> 기본 스캔에서는 재큐잉하지 않음
-> 사용자가 force=true를 준 경우만 재큐잉

이미 queued/failed/skipped인 post_no
-> 사용자가 force=true를 준 경우만 재큐잉

이미 running인 post_no
-> 처리 중인 항목이므로 force=true여도 건드리지 않음
```

### 6.3 큐 처리

병렬 처리하지 않는다.

```text
while running
  next = queue에서 가장 오래된 queued 1개
  next.status = running
  게시글 HTML fetch
  실패하면 skipped 또는 failed 저장
  제목/본문/이미지 추출
  Gemini CLI 판정
  실제 자동화 기준으로 effective decision 계산
  결과 저장
  next.status = completed
  다음 글 처리
```

예시:

```text
1155301 판정 시작
-> Gemini 응답 완료
-> DB 저장
-> 1155302 판정 시작
```

이렇게 해야 Gemini CLI worker/session이 꼬이지 않고, 진행 로그도 설명하기 쉽다.

### 6.3.1 실제 자동화 기준 effective decision

기존 신문고봇은 Gemini 응답을 받은 뒤에도 바로 조치하지 않는다.

실제 흐름:

```text
Gemini decision
-> helper에서 review + 정책 3개 이상이면 allow로 승격
-> scheduler에서 decision이 allow인지 확인
-> confidence가 threshold 이상인지 확인
-> 그때만 삭제/차단 실행
```

dry-run도 “AI 관리자였다면 실제로 조치했을 글”을 보여주는 목적이므로 이 기준을 반영해야 한다.

저장할 값:

```text
rawDecision
-> Gemini가 처음 낸 decision

normalizedDecision
-> 기존 helper의 normalizeJudgeDecisionForAutomation() 규칙 적용 후 decision

effectiveDecision
-> threshold까지 반영한 최종 dry-run 표시값
```

예시:

```text
rawDecision=allow, confidence=0.91
-> normalizedDecision=allow
-> threshold=0.85 통과
-> effectiveDecision=action
-> 웹 표시: AI 조치 대상

rawDecision=allow, confidence=0.62
-> normalizedDecision=allow
-> threshold=0.85 미달
-> effectiveDecision=review
-> 웹 표시: 사람 검토 필요(신뢰도 부족)

rawDecision=review, policyIds=["P3","P6","P14"], confidence=0.88
-> normalizedDecision=allow
-> threshold=0.85 통과
-> effectiveDecision=action
-> 웹 표시: AI 조치 대상

rawDecision=deny, policyIds=["NONE"], confidence=0.95
-> normalizedDecision=deny
-> effectiveDecision=no_action
-> 웹 표시: 문제 없음
```

구현 의사코드:

```js
function applyDryRunDecisionPolicy(parsed, threshold) {
  const rawDecision = parsed.decision;
  const policyIds = Array.isArray(parsed.policy_ids) ? parsed.policy_ids : [];
  const promotablePolicyCount = policyIds.filter((id) => id !== 'NONE').length;
  const normalizedDecision = rawDecision === 'review' && promotablePolicyCount >= 3
    ? 'allow'
    : rawDecision;

  if (normalizedDecision !== 'allow') {
    return {
      rawDecision,
      normalizedDecision,
      effectiveDecision: normalizedDecision === 'review' ? 'review' : 'no_action',
      decision: normalizedDecision === 'review' ? 'review' : 'deny',
      thresholdBlocked: false,
    };
  }

  if (Number(parsed.confidence) < threshold) {
    return {
      rawDecision,
      normalizedDecision,
      effectiveDecision: 'review',
      decision: 'review',
      thresholdBlocked: true,
    };
  }

  return {
    rawDecision,
    normalizedDecision,
    effectiveDecision: 'action',
    decision: 'allow',
    thresholdBlocked: false,
  };
}
```

중요:

웹 통계에서 `AI 조치 대상`은 단순 `rawDecision=allow`가 아니라 `effectiveDecision=action` 기준으로 세야 한다.

### 6.4 skip 기준

아래는 실패가 아니라 `skipped`로 기록한다.

```text
목록에서 post_no가 비어 있음
게시글이 삭제되어 본문 HTML이 없음
성인/차단/접근 제한 등으로 정상 본문을 못 가져옴
title/body 둘 다 비어 있음
```

title은 있는데 body가 비어 있으면 skipped가 아니라 title-only 판정으로 진행한다.

```text
title 있음 + body 없음
-> bodyText="(본문 없음)"
-> contentCompleteness="title_only"
-> Gemini 판정 진행
```

아래는 `failed`로 기록한다.

```text
디시 HTML fetch 네트워크 오류
Gemini CLI 실행 오류
Gemini JSON 파싱 실패
예상하지 못한 내부 예외
```

## 7. 판정값 설계

기존 신문고봇은 `allow | deny | review`를 사용한다.

dry-run 웹에서는 사용자에게 더 명확하게 보여주기 위해 내부 또는 표시값을 아래처럼 쓴다.

```text
action
-> AI 관리자였다면 조치했을 글

no_action
-> AI 기준 문제없음

review
-> AI도 애매해서 사람 검토 필요
```

구현 방식은 두 가지가 있다.

1. Gemini 출력 자체를 `action | no_action | review`로 받는다.
2. Gemini 출력은 기존 validator 호환을 위해 `allow | deny | review`로 받고 웹 표시만 바꾼다.

권장:

처음 구현은 2번이 안전하다.

이유:

기존 `validateJudgeDecision()`은 `allow | deny | review`를 검증한다. Gemini raw 출력은 이 값을 유지하고, 웹 라벨은 effective decision 계산 후 아래처럼 바꾼다.

```text
effectiveDecision=action    -> AI 조치 대상
effectiveDecision=no_action -> 문제 없음
effectiveDecision=review    -> 사람 검토 필요
```

단순히 Gemini `allow`만 보고 `AI 조치 대상`으로 세면 기존 자동화와 달라진다. 실제 자동화는 `allow + confidence threshold 통과`까지 봐야 조치한다.

## 8. dry-run 전용 프롬프트

기존 신문고봇 prompt에서 신고 사유/신고자/작성자 필터/강제 승인 규칙을 제거한다.

새 prompt 원칙:

```text
신고 사유 없음
신고자 없음
작성자 필터 없음
관리자 fast path 없음
특정 작성자 강제 승인 없음
삭제/차단 진행 문구 없음
오직 제목/본문/이미지/운영규정만 기준
```

기존 helper와 맞출 입력 제한:

```text
title: 최대 300자
bodyText: 최대 4000자
imageUrls: 최대 8개
image download: 파일당 최대 8MB
image download timeout: 10초
Gemini timeout: 기본 240초
```

이 제한을 문서화하는 이유는 dry-run 결과가 기존 helper와 너무 달라지지 않게 하기 위해서다.

초안:

```text
다음 디시인사이드 게시글이 갤러리 운영 규정 P1~P15 중 어디에 해당하는지 판단해라.

이 요청은 실제 삭제/차단을 수행하지 않는 dry-run 시뮬레이션이다.
신고 사유, 신고자 주장, 작성자 신뢰도 정보는 제공되지 않는다.
오직 게시글 제목, 본문, 첨부 이미지, 갤러리 운영 방침 원문만 기준으로 판단해라.

반드시 JSON object 하나만 출력해라.

decision:
- allow: AI 관리자라면 조치 대상으로 볼 정도로 규정 위반이 명확함
- deny: 조치 대상으로 보기 어려움
- review: 애매해서 사람 검토 필요

출력 형식:
{
  "decision": "allow|deny|review",
  "confidence": 0.0,
  "policy_ids": ["P3"],
  "reason": "짧은 판정 사유"
}

강제 규칙:
- policy_ids가 ["NONE"]이면 decision은 반드시 "deny"여야 한다.
- allow는 최소 1개 이상의 P1~P15 위반이 명확할 때만 사용한다.
- 개념글 제한만 필요한 경우처럼 자동 조치와 맞지 않는 경우는 review를 사용한다.
- 단순 의견, 후기, 정보 공유, 기술 비판은 과잉 조치하지 마라.
- 애매하면 allow가 아니라 review를 사용한다.
- 이미지가 있으면 제목/본문과 함께 보조 근거로 확인한다.
- 이미지 내용을 충분히 확인하지 못하면 review를 사용한다.

대상 게시물 URL:
...

제목:
...

본문:
...

첨부 이미지 파일:
...

첨부 이미지 URL:
...
```

운영 방침 원문은 기존 `projects/dc_auto_bot/docs/thesingularity_gallery_policy.md`를 새 프로젝트의 `projects/ai_moderator_dry_run/docs/thesingularity_gallery_policy.md`로 복사해서 source of truth로 넣는다.

이유:

```text
기존 helper의 상대 경로:
projects/dc_auto_bot/helper/server.mjs
-> ../docs/thesingularity_gallery_policy.md

새 프로젝트에서 그대로 쓰면:
projects/ai_moderator_dry_run/server.mjs
-> ../docs/thesingularity_gallery_policy.md
```

새 프로젝트 위치가 다르기 때문에 상대 경로가 깨질 수 있다. 따라서 정책 문서는 새 프로젝트 내부 `docs/`에 복사하고 `prompt.mjs`에서 그 경로를 읽는다.

## 9. 이미지 처리

기존 구조를 그대로 가져간다.

판정용:

```text
imageUrls 최대 8개
-> Node helper가 Referer: 대상 게시물 URL로 이미지 다운로드
-> PNG로 normalize
-> Gemini CLI에 @파일경로로 전달
-> 판정 후 즉시 삭제
```

공개 웹용:

```text
첫 번째 다운로드 가능한 이미지
-> resize
-> blur
-> webp 저장
-> /transparency-assets/<recordId>.webp 로 노출
```

원본 이미지는 보관하지 않는다.

## 10. DB/파일 설계

JSONL로 시작한다. SQLite는 나중에 필요할 때 바꾼다.

### 10.1 queue record

파일:

```text
data/dry-run-queue.jsonl
```

필드:

```json
{
  "postNo": "1155307",
  "page": 1,
  "subjectFromList": "GPT-5.5 성능 후기",
  "status": "queued",
  "attemptCount": 0,
  "createdAt": "2026-05-03T00:00:00.000Z",
  "updatedAt": "2026-05-03T00:00:00.000Z",
  "lastError": ""
}
```

상태:

```text
queued
running
completed
skipped
failed
```

서버 시작 시 복구:

```text
running 상태가 남아 있으면 failed로 바꾸거나 queued로 되돌린다.
권장: failed로 바꾸고 사용자가 retry를 누를 수 있게 한다.
```

### 10.2 result record

파일:

```text
data/dry-run-records.jsonl
```

필드:

```json
{
  "id": "dryrun-1155307",
  "source": "ai_moderator_dry_run",
  "status": "completed",
  "targetUrl": "https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1155307",
  "targetPostNo": "1155307",
  "publicTitle": "[일반] GPT-5.5 성능 후기",
  "publicBody": "본문 일부...",
  "contentCompleteness": "full",
  "authorNick": "ㅇㅇ",
  "authorUid": "",
  "authorIp": "1.2",
  "decision": "allow",
  "rawDecision": "allow",
  "normalizedDecision": "allow",
  "effectiveDecision": "action",
  "thresholdBlocked": false,
  "confidenceThreshold": 0.85,
  "displayDecision": "AI 조치 대상",
  "confidence": 0.91,
  "policyIds": ["P3"],
  "reason": "특정 모델 이용자를 조롱하는 표현으로 분탕 가능성이 큼",
  "imageCount": 1,
  "blurredThumbnailPath": "/transparency-assets/dryrun-1155307.webp",
  "dryRun": true,
  "actualAction": "none",
  "createdAt": "2026-05-03T00:00:00.000Z",
  "updatedAt": "2026-05-03T00:00:00.000Z"
}
```

### 10.3 기존 DB 복사 시 필수 수정

기존 `projects/dc_auto_bot/helper/db.mjs`를 그대로 복사하면 아래 검증 때문에 dry-run record가 저장되지 않을 수 있다.

```js
if (source && source !== 'auto_report' && source !== 'manual_test') {
  return null;
}
```

새 프로젝트에서는 아래처럼 바꾼다.

```js
const VALID_SOURCES = new Set(['ai_moderator_dry_run']);

function normalizeDryRunSource(value) {
  const source = String(value || '').trim();
  return VALID_SOURCES.has(source) ? source : 'ai_moderator_dry_run';
}
```

또는 더 단순하게 dry-run 전용 DB에서는 source 검증 자체를 아래처럼 고정한다.

```js
source: 'ai_moderator_dry_run'
```

판정값은 기존 validator 호환을 위해 `allow | deny | review`를 유지한다.

```text
allow  -> 저장 가능, 화면에서는 AI 조치 대상
deny   -> 저장 가능, 화면에서는 문제 없음
review -> 저장 가능, 화면에서는 사람 검토 필요
```

주의:

`action | no_action | review`로 Gemini 출력값을 바꾸려면 `validateJudgeDecision()`, stats 계산, CSS badge, 필터 링크를 모두 같이 바꿔야 한다. 첫 구현에서는 불필요한 변경 범위가 커지므로 하지 않는다.

상태값도 수정해야 한다.

기존 helper DB는 아래 상태만 허용한다.

```js
const VALID_STATUSES = new Set(['pending', 'completed', 'failed']);
```

dry-run result에는 `skipped`도 필요하다. 새 DB에서는 아래처럼 둔다.

```js
const VALID_STATUSES = new Set(['completed', 'skipped', 'failed']);
```

`pending`은 queue의 `running` 상태로 충분하므로 result record에는 저장하지 않는다.

예시:

```text
게시글 fetch 성공 + Gemini 판정 완료
-> result.status=completed

게시글 삭제됨/본문 없음/접근 제한
-> result.status=skipped

네트워크 오류/Gemini 오류/JSON 파싱 실패
-> result.status=failed
```

기존 `sanitizeRecordRequest()`도 `source`, `status`를 제한하므로 그대로 복사하지 않는다. dry-run에서는 외부 `/record` endpoint를 만들지 않고, 내부 runner가 `db.upsertRecord()`를 직접 호출하는 구조가 안전하다.

## 11. 웹 페이지

기존 transparency 느낌을 유지하되 문구를 dry-run용으로 바꾼다.

### 11.1 목록

표시 항목:

```text
상단 안내:
AI 관리자 전수 판정 dry-run입니다. 실제 삭제/차단은 수행하지 않았습니다.

통계:
- 전체
- AI 조치 대상
- 사람 검토 필요
- 문제 없음
- 스킵
- 실패

테이블:
- 게시물 번호
- 제목
- AI 판정
- 정책
- 신뢰도
- 날짜
```

필터:

```text
전체
AI 조치 대상: effectiveDecision=action
사람 검토 필요: effectiveDecision=review
문제 없음: effectiveDecision=no_action
스킵/실패
```

### 11.2 상세

표시 항목:

```text
제목
게시물 번호
원본 링크
본문
블러 썸네일
AI 판정
정책 ID
신뢰도
판정 이유
dry-run 안내
```

상세 페이지 상단에는 항상 아래 문구를 넣는다.

```text
이 페이지는 AI 관리자 전수 판정 시뮬레이션입니다.
실제 게시물 삭제 또는 IP/계정 차단은 수행하지 않았습니다.
```

### 11.3 기존 transparency 문구 치환표

기존 웹을 복사할 때 아래 문구는 그대로 두면 안 된다.

```text
삭제 승인
-> AI 조치 대상

삭제 반려
-> 문제 없음

검토 필요
-> 사람 검토 필요

신고 사유
-> 판정 기준

신고 사유와 Gemini 판정 이유를 누구나 확인할 수 있는 공개 페이지
-> AI 전수 판정 결과와 Gemini 판정 이유를 확인하는 dry-run 페이지

삭제/차단 응답 디버그 보기
-> 판정 디버그 보기
```

예시:

```text
기존 신문고봇:
삭제 승인 12건 / 삭제 반려 35건 / 신고 사유: 분탕

dry-run:
AI 조치 대상 12건 / 문제 없음 35건 / 판정 기준: 운영 규정 P1~P15
```

기존 transparency에서 제거하거나 의미를 바꿔야 하는 블록:

```text
특갤봇 랭킹 / reporterRanking
-> dry-run에는 신고자가 없으므로 제거

처리 불가 / 강제 승인 stats
-> skipped / failed stats로 교체

pending 최신 기록 API
-> dry-run에는 pending record를 저장하지 않으므로 제거

자동 새로고침 10초
-> 유지 가능. 단, 실행 중 진행률 표시용으로만 사용
```

예시:

```text
기존:
삭제 승인 4 / 삭제 반려 8 / 처리 불가 2 / 강제 승인 1 / 특갤봇 랭킹

dry-run:
AI 조치 대상 4 / 문제 없음 8 / 사람 검토 필요 1 / 스킵 2 / 실패 0
```

## 12. API

로컬 전용 API:

```text
GET /
-> /dry-run 으로 redirect

GET /dry-run
-> 결과 목록

GET /dry-run/:id
-> 결과 상세

GET /api/status
-> 큐/러너 상태

POST /api/scan
-> 1~20페이지 스캔 후 queue 적재

POST /api/run
-> 직렬 큐 처리 시작

POST /api/stop
-> 현재 처리 후 중지 또는 AbortController로 중단

POST /api/retry-failed
-> failed/skipped 재큐잉 옵션

GET /api/records
-> JSON 결과 목록
```

외부 공개 도메인으로 올릴 때 허용할 endpoint:

```text
GET /dry-run
GET /dry-run/:id
GET /dry-run.css
GET /transparency-assets/*
GET /api/records
```

`GET /api/records`는 공개용으로 sanitize된 값만 반환한다.

반환 가능:

```text
id
targetUrl
targetPostNo
title
publicBody
thumbnailUrl
imageCount
rawDecision
normalizedDecision
effectiveDecision
confidence
confidenceThreshold
thresholdBlocked
policyIds
reason
createdAt
completedAt
contentCompleteness
```

반환 금지:

```text
Gemini rawText 원문
prompt 원문
로컬 이미지 파일 경로
gemini-inputs 임시 경로
debugFailureRawText
stack trace
내부 queue 파일 경로
```

예를 들어 Gemini가 긴 설명을 stdout에 섞어 뱉은 실패 건은 로컬 디버그용으로는 저장할 수 있지만, 공개 `/api/records`에는 `failureType`, `reason` 정도만 노출한다.

외부에서 막아야 할 endpoint:

```text
POST /api/scan
POST /api/run
POST /api/stop
POST /api/retry-failed
POST /judge
```

### 12.1 외부 공개 시 API 차단

로컬에서만 쓸 때는 `127.0.0.1`로 충분하다. 나중에 도메인에 올릴 경우에는 `GET` 공개 페이지와 asset만 열고, queue를 움직이는 `POST` API는 차단한다.

차단 기준 예시:

```js
function isLocalRequest(request) {
  const host = String(request.headers.host || '');
  const remote = request.socket?.remoteAddress || '';
  return host.startsWith('127.0.0.1:')
    || host.startsWith('localhost:')
    || remote === '127.0.0.1'
    || remote === '::1';
}

if (request.method === 'POST' && !isLocalRequest(request)) {
  writeJson(response, 403, { success: false, message: 'local only endpoint' });
  return;
}
```

외부 공개 서버에서 실수로 `/api/run`이 열리면 누군가가 Gemini 비용/시간을 소모시킬 수 있다. 실제 삭제/차단은 없더라도 운영상 위험하므로 막는다.

## 13. 러너 정책

### 13.1 직렬 처리

병렬 없음.

```text
concurrency = 1
```

이유:

1. Gemini CLI worker/session이 꼬일 가능성을 낮춘다.
2. 중간 중단/재시작 복구가 쉽다.
3. 보여주기용이라 속도보다 일관성이 중요하다.

### 13.2 진행 상태

서버 상태:

```json
{
  "running": true,
  "currentPostNo": "1155307",
  "queued": 712,
  "completed": 134,
  "skipped": 4,
  "failed": 2,
  "startedAt": "...",
  "lastUpdatedAt": "..."
}
```

### 13.3 중단

중단 버튼을 누르면:

```text
현재 Gemini 작업이 끝나면 정지
```

강제 abort는 옵션으로만 둔다.

이유:

Gemini CLI 작업 중간 abort는 rawText/결과가 애매하게 남을 수 있다. 보여주기용에서는 안전하게 현재 건 완료 후 중지가 낫다.

## 14. 구현 순서

### 14.1 1단계: 프로젝트 스캐폴딩

```text
projects/ai_moderator_dry_run/package.json
projects/ai_moderator_dry_run/server.mjs
projects/ai_moderator_dry_run/scanner.mjs
projects/ai_moderator_dry_run/queue.mjs
projects/ai_moderator_dry_run/fetcher.mjs
projects/ai_moderator_dry_run/parser.mjs
projects/ai_moderator_dry_run/prompt.mjs
projects/ai_moderator_dry_run/judge.mjs
projects/ai_moderator_dry_run/gemini_worker_manager.mjs
projects/ai_moderator_dry_run/gemini_worker.mjs
projects/ai_moderator_dry_run/db.mjs
projects/ai_moderator_dry_run/transparency.mjs
projects/ai_moderator_dry_run/public/dry-run.css
projects/ai_moderator_dry_run/docs/thesingularity_gallery_policy.md
```

`package.json`은 기존 helper를 참고한다.

```json
{
  "type": "module",
  "scripts": {
    "start": "cross-env GEMINI_ARGS_JSON=[\\\"--model\\\",\\\"gemini-2.5-flash\\\"] node server.mjs"
  },
  "dependencies": {
    "sharp": "^0.34.5"
  },
  "devDependencies": {
    "cross-env": "^10.1.0"
  }
}
```

주의:

`package.json` 안에서는 JSON 문자열 안에 다시 JSON 배열을 넣기 때문에 `GEMINI_ARGS_JSON=[\\\"--model\\\",\\\"gemini-2.5-flash\\\"]`처럼 escape가 필요하다. 터미널에서 직접 실행할 때는 `GEMINI_ARGS_JSON='["--model","gemini-2.5-flash"]' node server.mjs`처럼 쓰면 된다.

### 14.2 2단계: parser/fetcher

새 `fetcher.mjs`:

```text
fetchPostListHtml()
fetchPostPageHtml()
buildPostUrl()
buildDcHtmlHeaders()
fetchHtmlWithRetry()
```

fetcher 구현 규칙:

```text
baseUrl 기본값: https://gall.dcinside.com
boardPath 기본값: mgallery
galleryId 기본값: thesingularity
429 응답: 짧은 backoff 후 재시도
403 응답: 한 번 더 재시도 후 failed
"정상적인 접근이 아닙니다" 포함: 접근 차단으로 failed
```

Node fetch는 브라우저 쿠키 jar가 없으므로 `credentials: include`를 써도 기존 확장과 동일하게 동작하지 않는다. 이번 기능은 공개 목록/본문만 대상으로 하므로 쿠키 없이 진행한다.

헤더 예시:

```js
function buildDcHtmlHeaders(baseUrl) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${String(baseUrl || 'https://gall.dcinside.com').replace(/\/$/, '')}/`,
  };
}
```

실제 기존 `api.js`의 `dcFetchWithRetry()`는 429/403 재시도를 한다. dry-run fetcher도 같은 성격의 재시도를 넣어야 20페이지 스캔 중 일시 실패가 전체 중단으로 번지지 않는다.

새 `parser.mjs`:

```text
parseRegularBoardPosts()
extractPostContentForLlm()
extractPostAuthorMeta()
extractRecommendState()
```

### 14.3 3단계: queue/store

새 `queue.mjs`:

```text
enqueuePosts()
getNextQueued()
markRunning()
markCompleted()
markSkipped()
markFailed()
resetRunningOnStartup()
```

새 `db.mjs`:

```text
upsertRecord()
listRecords()
getRecord()
getStats()
```

### 14.4 4단계: prompt/judge

새 `prompt.mjs`:

```text
buildDryRunPrompt()
```

새 `judge.mjs`:

```text
prepareJudgeImageInputs()
runGeminiCli()
parseGeminiCliJson()
judgePost()
```

기존 prompt를 그대로 복사하지 말고, dry-run 전용 prompt로 축소한다.

기존 `server.mjs`에서 `runGeminiCli()`, `parseGeminiCliJson()`, `validateJudgeDecision()`, `prepareJudgeImageInputs()`만 부분 복사하면 내부 의존 함수가 많아 깨질 수 있다.

기존 `projects/dc_auto_bot/helper/server.mjs`를 직접 import해서 쓰는 방식은 피한다.

이유:

```text
1. top-level에서 기존 policy/css/icon 파일을 readFileSync로 바로 읽는다.
2. buildRuntimeConfig()의 helperRootDir, recordsFilePath, judgeInputDir 기본값이 기존 helper 경로를 가리킨다.
3. workerSessionScope 기본값이 moderation-main이라 기존 helper worker 세션과 논리적으로 섞인다.
4. /judge, /record, force allow, 신고 사유 prompt 같은 기존 기능이 같이 따라온다.
```

따라서 필요한 함수 체인을 새 프로젝트 내부로 복사한 뒤 dry-run 전용으로 줄인다.

따라서 구현 시에는 아래 둘 중 하나로 한다.

```text
방법 A:
기존 helper/server.mjs에서 Gemini 실행/이미지 처리 관련 함수 의존 체인을 통째로 복사한 뒤 불필요 route 제거

방법 B:
judge.mjs를 spawn-only로 새로 단순 구현하고 이미지 다운로드/JSON parse/validator만 직접 작성
```

권장:

```text
방법 A
```

이유는 기존 Gemini worker, timeout, stdin fallback, 이미지 normalize 로직이 이미 검증되어 있기 때문이다. 단, `/judge` HTTP route, `/record`, force allow, 신고 사유 prompt는 제거한다.

새 `buildRuntimeConfig()`의 worker 관련 기본값:

```text
helperRootDir: projects/ai_moderator_dry_run/
recordsFilePath: projects/ai_moderator_dry_run/data/dry-run-records.jsonl
judgeInputDir: projects/ai_moderator_dry_run/data/gemini-inputs
assetsDir: projects/ai_moderator_dry_run/data/transparency-assets
workerSessionScope: ai-moderator-dry-run
```

특히 `workerSessionScope`는 기존 `moderation-main`을 그대로 쓰지 않는다. 예를 들어 기존 특갤봇 helper와 dry-run을 동시에 켰을 때 같은 fingerprint로 판단되면 worker 재사용/압축 타이밍이 섞일 수 있으므로 dry-run 전용 scope로 분리한다.

기존 helper에서 반드시 제거할 분기:

```text
isForceAllowAuthorNick()
buildForceAllowAuthorDecision()
FORCE_ALLOW_AUTHOR_NICK
상냥한에옹
신고 사유
신고자 label
작성자 필터 결과
```

기존 `/judge` HTTP route를 그대로 복사하는 것도 권장하지 않는다.

권장 구조:

```text
server.mjs
-> queue runner 호출

judge.mjs
-> judgePost(postContent)
-> prepareJudgeImageInputs()
-> runGeminiCli(buildDryRunPrompt())
-> parseGeminiCliJson()
-> validateJudgeDecision()
```

즉, dry-run 내부 함수로만 Gemini를 부르고 외부 `/judge` API는 만들지 않는다. 나중에 테스트용으로 필요하면 `127.0.0.1`에서만 열어야 한다.

### 14.5 5단계: 웹/API

새 `server.mjs`:

```text
GET /dry-run
GET /dry-run/:id
GET /dry-run.css
GET /transparency-assets/*
GET /api/status
GET /api/records
POST /api/scan
POST /api/run
POST /api/stop
```

`transparency.mjs`를 참고해 복사할 때 기존 HTML의 `<link rel="stylesheet" href="/transparency.css">`는 반드시 `/dry-run.css`로 바꾼다. 파일도 `public/dry-run.css`로 둔다.

`GET /api/records`는 웹 목록과 같은 sanitize 레이어를 거친다. 내부 저장 record를 그대로 JSON으로 내보내면 `debugFailureRawText`, Gemini 원문, 로컬 파일 경로가 노출될 수 있다.

### 14.6 6단계: 안전성 검사

새 프로젝트에서 아래 문자열이 검색되면 실패로 본다.

```bash
rg -n "update_avoid_list|delete_list|delete_comment|executeDeleteAndBan|executeDeleteAndBanWithRecovery|ensureLoginSession|chrome\\.cookies|chrome\\.runtime|FORCE_ALLOW_AUTHOR_NICK|상냥한에옹" projects/ai_moderator_dry_run
```

정상 기대:

```text
검색 결과 없음
```

UI 문구 검사:

```bash
rg -n "삭제 승인|삭제 반려|신고 사유|삭제/차단|신고자 label|작성자 필터|강제 승인|특갤봇 랭킹|reporterRanking" projects/ai_moderator_dry_run
```

정상 기대:

```text
검색 결과 없음
```

단, 문서나 README에서 위험 문자열을 설명용으로 적은 경우는 제외하고 코드/웹 템플릿 기준으로 본다.

## 15. 엣지케이스

1. 1~20페이지 중 일부 페이지가 403/429를 반환한다.
   - 해당 page scan 실패로 기록하고 다음 페이지 진행.

2. 목록 row에 post_no가 없다.
   - queue에 넣지 않음.

3. 공지/설문 row다.
   - 기존 parser처럼 제외.

4. 동일 post_no가 여러 페이지에서 중복 발견된다.
   - 하나만 queue에 유지.

5. 스캔 후 글이 삭제됐다.
   - skipped.

6. 본문 `write_div`를 찾지 못한다.
   - title도 없으면 skipped.
   - title만 있으면 `bodyText=(본문 없음)`, `contentCompleteness=title_only`로 판정한다.

7. 이미지 다운로드가 실패한다.
   - 텍스트만으로 판정 진행.

8. 이미지가 너무 크다.
   - 기존 제한처럼 8MB 초과는 건너뜀.

9. Gemini CLI가 timeout 난다.
   - failed로 기록.
   - 실제 조치 fallback은 절대 하지 않음.

10. Gemini가 JSON이 아닌 답을 준다.
    - failed로 기록한다.
    - rawText는 로컬 디버그 필드로만 최대 길이를 제한해 저장한다.
    - 공개 `/api/records`와 공개 상세 페이지에는 rawText 원문을 노출하지 않는다.

11. 서버가 꺼졌다 켜진다.
    - completed는 유지.
    - queued는 유지.
    - running은 failed 또는 queued로 정리.
    - 권장: failed로 두고 retry 버튼으로 재시도.

12. 사용자가 다시 scan을 누른다.
    - completed는 유지.
    - 새 글만 queued.

13. 기존 결과를 모두 지우고 새로 하고 싶다.
    - `/api/reset` 같은 destructive endpoint는 처음 구현에서는 넣지 않는다.
    - 필요하면 CLI에서 data 파일 삭제로 처리.

14. 외부 공개 도메인으로 띄운다.
    - POST API는 외부 차단.
    - GET 공개 페이지와 asset만 허용.

15. 판정 결과가 실제 운영 결과처럼 오해된다.
    - 모든 페이지에 `dry-run, 실제 조치 없음` 배너를 고정 표시.

16. 기존 DB source 제한을 그대로 복사했다.
    - `source: "ai_moderator_dry_run"` record가 저장되지 않는다.
    - dry-run 전용 DB에서 source를 고정하거나 허용값을 수정한다.

17. 기존 helper의 강제 allow 닉네임 분기를 그대로 복사했다.
    - 특정 작성자 글이 무조건 `allow`가 되어 데모가 왜곡된다.
    - `FORCE_ALLOW_AUTHOR_NICK` 관련 코드를 제거한다.

18. 기존 transparency 문구를 그대로 복사했다.
    - 사용자가 실제 삭제/차단한 결과로 오해한다.
    - `삭제 승인`을 `AI 조치 대상`으로 바꾸고 dry-run 배너를 고정한다.

19. Node fetch에 브라우저 쿠키가 없어서 일부 페이지가 다르게 보인다.
    - 공개 목록/본문 기준이면 문제 없다.
    - 나중에 쿠키가 필요한 페이지를 다룰 때도 `chrome.cookies`가 아니라 명시적 `COOKIE` 환경 변수만 사용한다.

20. `/judge` endpoint를 외부에 열어뒀다.
    - 누군가 임의 prompt를 계속 보내 Gemini CLI를 소모시킬 수 있다.
    - 외부에는 `/dry-run`, asset, read-only JSON만 공개한다.

21. Gemini가 `allow`를 줬지만 confidence가 threshold 미만이다.
    - `AI 조치 대상`으로 세면 실제 자동화와 달라진다.
    - `effectiveDecision=review`, `thresholdBlocked=true`로 저장한다.

22. Gemini가 `review`를 줬지만 정책 ID가 3개 이상이다.
    - 기존 helper는 `normalizeJudgeDecisionForAutomation()`으로 allow 승격한다.
    - dry-run도 실제 특갤봇 기준을 보여주려면 같은 승격을 적용하고 rawDecision을 별도 보관한다.

23. `gemini_worker_manager.mjs` 또는 `gemini_worker.mjs`를 복사하지 않았다.
    - 기존 `runGeminiCli()` import 또는 worker 생성이 깨진다.
    - worker 관련 두 파일을 같이 복사하거나 spawn-only judge로 단순화한다.

24. 정책 문서 상대 경로가 틀렸다.
    - 기존 경로는 `projects/dc_auto_bot/docs/thesingularity_gallery_policy.md`다.
    - 새 프로젝트 내부 `docs/`로 복사하고 그 경로를 읽는다.

25. `BOARD_PATH`를 빼고 `/mgallery`를 코드 곳곳에 하드코딩했다.
    - 이번 구현은 동작해도 나중에 일반/미니 갤러리 확장이 어려워진다.
    - `buildPostUrl()`에서만 boardPath를 조립한다.

## 16. 검증 체크리스트

구현 후 필수 확인:

```bash
node --check projects/ai_moderator_dry_run/server.mjs
node --check projects/ai_moderator_dry_run/scanner.mjs
node --check projects/ai_moderator_dry_run/judge.mjs
node --check projects/ai_moderator_dry_run/parser.mjs
node --check projects/ai_moderator_dry_run/db.mjs
```

금지 API 검색:

```bash
rg -n "update_avoid_list|delete_list|delete_comment|executeDeleteAndBan|executeDeleteAndBanWithRecovery|ensureLoginSession|chrome\\.cookies|chrome\\.runtime|FORCE_ALLOW_AUTHOR_NICK|상냥한에옹" projects/ai_moderator_dry_run
```

기존 운영 문구 잔존 검색:

```bash
rg -n "삭제 승인|삭제 반려|신고 사유|삭제/차단 응답|신고자 label|작성자 필터|강제 승인|특갤봇 랭킹|reporterRanking" projects/ai_moderator_dry_run
```

필수 파일 확인:

```bash
test -f projects/ai_moderator_dry_run/gemini_worker_manager.mjs
test -f projects/ai_moderator_dry_run/gemini_worker.mjs
test -f projects/ai_moderator_dry_run/docs/thesingularity_gallery_policy.md
test -f projects/ai_moderator_dry_run/public/dry-run.css
```

DB 검증값 확인:

```bash
rg -n "ai_moderator_dry_run|VALID_STATUSES|skipped|effectiveDecision|rawDecision|normalizedDecision|thresholdBlocked" projects/ai_moderator_dry_run/db.mjs projects/ai_moderator_dry_run/transparency.mjs
```

기대:

```text
source=ai_moderator_dry_run 허용
status=completed/skipped/failed 허용
effectiveDecision 기준 통계 표시
```

공개 JSON sanitize 확인:

```bash
rg -n "debugFailureRawText|rawText|gemini-inputs|\\.png|\\.webp" projects/ai_moderator_dry_run/server.mjs projects/ai_moderator_dry_run/transparency.mjs
```

기대:

```text
내부 저장/로컬 디버그용 코드는 허용
GET /api/records 응답 생성 코드에는 rawText/debugFailureRawText/로컬 파일 경로 직접 노출 없음
```

decision 정책 단위 테스트:

```text
raw allow + confidence 0.91 + threshold 0.85
-> effectiveDecision=action

raw allow + confidence 0.62 + threshold 0.85
-> effectiveDecision=review, thresholdBlocked=true

raw review + policyIds 3개 + confidence 0.90
-> normalizedDecision=allow, effectiveDecision=action

raw deny + NONE
-> effectiveDecision=no_action
```

큐 직렬성 확인:

```text
동시에 running 상태인 queue item이 2개 이상이면 실패
```

웹 확인:

```text
GET /dry-run
GET /dry-run/:id
GET /api/status
```

샘플 dry-run:

```text
PAGE_FROM=1 PAGE_TO=1 node server.mjs
POST /api/scan
POST /api/run
```

기대:

```text
삭제/차단 요청 없음
결과 record 생성
effectiveDecision 기준 집계 표시
상세 페이지에서 dry-run 안내 표시
```

## 17. 실제 구현 시 가장 중요한 판단

이 기능의 목적은 AI 관리자를 실제로 도입하는 것이 아니라, 전수 적용 시 과잉 조치 가능성을 보여주는 것이다.

따라서 UX 문구는 `삭제 승인` 같은 실제 운영 용어보다 아래가 낫다.

```text
effectiveDecision=action    -> AI 조치 대상
effectiveDecision=no_action -> 문제 없음
effectiveDecision=review    -> 사람 검토 필요
```

예시:

```text
제목: GPT-5.5 후기
AI 판정: AI 조치 대상
정책: P3
신뢰도: 0.88
이유: 특정 모델 이용자를 조롱하는 표현으로 분탕 가능성이 있다고 판단
실제 조치: 없음
```

이렇게 보여줘야 딴지 걸렸을 때도 설명이 쉽다.

## 18. 실제 코드 교차검증 결론

이번 문서 작성 중 실제 코드를 다시 확인한 결론은 아래와 같다.

### 18.1 안전하게 가져갈 수 있는 흐름

```text
목록 HTML fetch
-> parseRegularBoardPosts()
-> 게시글 HTML fetch
-> extractPostContentForLlm()
-> 이미지 다운로드/blur thumbnail 생성
-> Gemini CLI 실행
-> raw/normalized/effective decision 계산
-> JSONL record 저장
-> transparency 스타일 웹 렌더링
```

이 흐름은 기존 신문고봇에서 이미 쓰고 있는 구조라 새 프로젝트에서도 재사용 가능하다.

예시:

```text
게시글 1155307
-> 제목/본문/이미지 추출
-> Gemini decision=allow
-> confidence threshold 통과 확인
-> dry-run record 저장
-> 웹에는 "AI 조치 대상"으로 표시
-> 실제 삭제/차단 없음
```

### 18.2 그대로 가져오면 안 되는 흐름

```text
Gemini allow
-> confidence threshold 통과
-> ensureLoginSessionForAction()
-> executeDeleteAndBanWithRecovery()
-> executeDeleteAndBan()
```

이 흐름은 기존 신문고봇의 실제 운영 조치 경로다. dry-run 프로젝트에서는 함수명도, API URL도, 로그인 세션 확인도 존재하면 안 된다.

### 18.3 구현 전 반드시 고쳐야 하는 복사 지점

```text
db.mjs
-> source 허용값을 ai_moderator_dry_run으로 변경
-> status 허용값에 skipped 추가
-> effectiveDecision/rawDecision/normalizedDecision 필드 추가

server.mjs/prompt.mjs
-> 신고 사유, 신고자 label, 작성자 필터, 강제 allow 닉네임 제거
-> 정책 문서 경로를 새 프로젝트 내부 docs/로 변경

transparency.mjs
-> 삭제 승인/삭제 반려/신고 사유 문구 제거
-> 통계는 rawDecision이 아니라 effectiveDecision 기준으로 계산
-> CSS 링크는 /transparency.css가 아니라 /dry-run.css로 변경
-> 공개 페이지/JSON에서 rawText, debugFailureRawText, 로컬 파일 경로 노출 금지

api/fetcher
-> chrome.cookies 없이 Node fetch로 공개 HTML만 요청
-> BOARD_PATH=mgallery 기본값 사용

judge.mjs
-> gemini_worker_manager.mjs/gemini_worker.mjs 의존 파일 포함
-> normalizeJudgeDecisionForAutomation() 동등 규칙과 confidence threshold 반영
-> workerSessionScope는 ai-moderator-dry-run으로 분리

server.mjs
-> 기존 helper/server.mjs 직접 import 금지
-> 필요한 함수 체인을 새 프로젝트 내부에 복사 후 dry-run 전용으로 축소
```

### 18.4 논리적으로 문제없다고 본 이유

1. 기존 프로젝트를 수정하지 않고 `projects/ai_moderator_dry_run`을 새로 만들기 때문에 기존 자동화와 상태 충돌이 없다.
2. 실제 조치 함수와 관리자 세션 함수를 아예 가져오지 않으므로 실수로 삭제/차단될 경로가 없다.
3. queue는 `concurrency=1`이라 Gemini CLI worker가 동시에 여러 글을 처리하다 꼬일 가능성이 낮다.
4. raw 판정과 effective 판정을 분리하므로 “Gemini가 이렇게 말함”과 “기존 자동화 기준이면 실제 조치 대상임”을 동시에 설명할 수 있다.
5. 게시글 번호 기준으로 queue/result를 저장하므로 중단 후 재시작, 실패 재시도, completed 중복 방지가 쉽다.
6. 외부 공개 시 POST API를 막는 설계를 넣었으므로 웹 공개 후에도 임의 사용자가 새 판정을 돌리는 것을 막을 수 있다.

남은 구현 리스크:

```text
디시 HTML 구조가 바뀌면 parser 보정 필요
Gemini CLI 응답이 JSON을 자주 깨면 retry/repair 정책 추가 필요
20페이지 전체 판정은 시간이 오래 걸리므로 진행률 UI가 필요
```

이 리스크들은 기존 운영 기능을 망가뜨리는 리스크가 아니라 dry-run 품질/편의성 리스크다.

## 19. 최종 구현 방향 요약

```text
새 확장 만들지 않음
기존 확장 건드리지 않음
Node 단독 프로젝트 생성
기존 helper/web/parser 레퍼런스 재사용
프롬프트는 dry-run 전용으로 새로 작성
queue는 무조건 직렬 처리
Gemini raw 판정과 effective 판정을 분리 저장
게시물 no 기준으로 중단/재시작 가능
삭제/차단 API는 프로젝트에 아예 넣지 않음
결과는 로컬 JSONL + 기존 느낌 웹으로 표시
```

이 설계대로 구현하면 기존 운영 기능과 파생 충돌 없이 바로 작업 가능하다.
