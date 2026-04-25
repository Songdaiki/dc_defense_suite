# 신문고봇 관리자 fast path 구현 문서

작성일: 2026-04-25

## 1. 목표

신문고봇은 현재 `신뢰 사용자`가 명령을 달아도 바로 Gemini helper로 넘기지 않는다. 먼저 작성자 필터, 최근 100개 필터 같은 운영 안전 필터를 통과해야 Gemini 판정으로 넘어간다.

이번 기능은 `관리자 사용자`를 별도로 등록하고, 관리자 명령은 아래 최소 필터만 확인한 뒤 바로 Gemini helper로 넘기는 것이다.

관리자 fast path:

```txt
댓글 폴링
→ 명령 파싱: @특갤봇 + 대상 링크 + 사유:
→ 관리자 user_id인지 확인
→ 다른 갤 링크가 아닌지 확인
→ 개념글이 아닌지 확인
→ Gemini helper 판정
→ allow + confidence 통과
→ 로그인 세션 확인
→ 삭제/차단 실행
```

기존 신뢰 사용자 path:

```txt
댓글 폴링
→ 신뢰 사용자 user_id인지 확인
→ 명령 파싱
→ 중복 링크 확인
→ 일일 사용 제한 확인
→ 다른 갤 링크 확인
→ 작성자 필터
→ 개념글 제외
→ 최근 100개 필터
→ Gemini helper 판정
→ allow + confidence 통과
→ 로그인 세션 확인
→ 삭제/차단 실행
```

즉 기존 신뢰 사용자 로직은 그대로 유지하고, 관리자만 별도 분기로 빠르게 Gemini helper까지 보낸다.

## 2. 실제 코드 확인 결과

대상 프로젝트는 원본 신문고봇 확장인 `projects/dc_auto_bot`이다. 메인 특궁 확장에 붙어 있는 `features/trusted-comment-command-defense`가 아니라 독립 신문고봇 쪽을 수정한다.

확인한 핵심 파일:

- `projects/dc_auto_bot/background/api.js`
- `projects/dc_auto_bot/background/parser.js`
- `projects/dc_auto_bot/background/scheduler.js`
- `projects/dc_auto_bot/background/background.js`
- `projects/dc_auto_bot/popup/popup.html`
- `projects/dc_auto_bot/popup/popup.js`
- `projects/dc_auto_bot/popup/popup.css`
- `projects/dc_auto_bot/helper/server.mjs`

현재 config 기본값은 `projects/dc_auto_bot/background/api.js`의 `DEFAULT_CONFIG`에 있다.

```js
trustedUsers: [],
dailyLimitPerUser: 2,
commandPrefix: '@특갤봇',
avoidHour: '6',
avoidReason: '0',
avoidTypeChk: true,
deleteTargetPost: true,
applyAuthorFilter: true,
lowActivityThreshold: 100,
```

현재 사용자 normalize/판정은 `projects/dc_auto_bot/background/parser.js`에 있다.

- `normalizeTrustedUsers(trustedUsers)`
- `isTrustedUser(comment, trustedUsers)`

현재 댓글 처리 진입점은 `projects/dc_auto_bot/background/scheduler.js`의 `processComment(comment, signal)`이다.

현재 `processComment()` 주요 순서:

```txt
1. trustedUsers 확인
2. parseCommandComment()
3. commandKey 생성
4. hasProcessedCommandKey() 중복 확인
5. isDailyLimitExceeded() 일일 제한 확인
6. 다른 갤 링크 확인
7. markCommandSeen()
8. 대상 게시물 HTML fetch
9. transparency pending record 생성
10. evaluateTargetAuthorFromPageHtml()
11. extractRecommendState()
12. getRecentRegularPosts()
13. callCliHelperJudge()
14. confidence 검사
15. ensureLoginSessionForAction()
16. executeDeleteAndBanWithRecovery()
```

## 3. 현재 필터 상세

현재 일반 신뢰 사용자에게 적용되는 필터는 다음과 같다.

1. 신뢰 사용자 필터
   - `isTrustedUser(comment, this.config.trustedUsers)`
   - 등록되지 않은 `user_id`는 무시한다.

2. 명령 형식 필터
   - `parseCommandComment(comment, this.config.commandPrefix)`
   - `@특갤봇`, 대상 링크, `사유:`가 필요하다.

3. 중복 링크 필터
   - `hasProcessedCommandKey(commandKey)`
   - 같은 갤의 같은 게시물 번호는 다시 처리하지 않는다.

4. 일일 제한 필터
   - `isDailyLimitExceeded(trustedUser.userId)`
   - 기본값은 사용자당 하루 2회다.

5. 다른 갤 링크 필터
   - `parsedCommand.targetGalleryId !== this.config.galleryId`
   - 현재 설정 갤이 아닌 링크는 실패 처리한다.

6. 작성자 필터
   - `evaluateTargetAuthorFromPageHtml(pageHtml, this.config, signal)`
   - 통과 조건은 유동, 깡계, 글편중이다.
   - 일반 계정은 Gemini helper까지 가지 않고 제외된다.

7. 개념글 필터
   - `extractRecommendState(pageHtml)`
   - `recommend === 'K'`면 개념글로 보고 제외한다.

8. 최근 100개 필터
   - `getRecentRegularPosts(signal)`
   - 전체글 regular row 기준 최근 100개 밖이면 제외한다.

9. Gemini helper 판정
   - `callCliHelperJudge()`
   - `allow | deny | review`를 받는다.

10. confidence 필터
    - `helperResult.confidence < llmConfidenceThreshold`면 제외한다.

11. 로그인 세션 필터
    - `ensureLoginSessionForAction()`
    - 성공해야 삭제/차단을 실행한다.

## 4. 신규 동작 정의

### 4.1 관리자 사용자

새 config 필드:

```js
adminUsers: []
```

형식은 기존 `trustedUsers`와 같다.

```js
{
  userId: 'image8481',
  label: 'だいき'
}
```

관리자 목록은 기존 신뢰 사용자 목록과 별도다. 같은 `user_id`가 양쪽에 모두 있으면 관리자 권한이 우선한다.

### 4.2 관리자 명령의 필터

관리자 명령은 아래만 확인한다.

```txt
1. 명령 파싱 성공
2. adminUsers에 등록된 user_id
3. 다른 갤 링크가 아님
4. 개념글이 아님
5. Gemini helper allow + confidence 통과
6. 로그인 세션 정상
7. 삭제/차단 성공
```

실제 코드 구현에서는 로그 폭주를 막기 위해 사용자 확인을 명령 파싱보다 먼저 해도 된다. 현재 기존 코드도 `trustedUsers`에 등록된 댓글만 `parseCommandComment()`를 호출한다. 즉 논리 조건은 `명령 형식 + 관리자 user_id` 둘 다 필요하다는 뜻이고, 물리적 코드 순서는 아래처럼 두어도 동일하다.

```txt
admin/trusted 사용자 확인
→ 등록된 사용자의 댓글만 parseCommandComment()
→ 관리자면 관리자 path, 아니면 기존 trusted path
```

관리자가 건너뛰는 필터:

```txt
- 작성자 필터
- 유동/깡계/글편중/일반계정 판정
- gallog 글합수/댓글합수 조회
- 최근 100개 필터
- 일일 사용 제한
- helper force-allow fallback
```

`helper force-allow fallback`은 기존 일반 신뢰 사용자 path에는 유지하되, 관리자 fast path에서는 사용하지 않는다. 관리자는 운영방침이 애매한 글을 Gemini 판사에게 바로 넘기는 목적이므로, helper timeout/internal error를 삭제 승인처럼 처리하면 요구와 충돌한다.

관리자 fast path에서 helper가 실패하면 결과는 실패다.

```txt
Gemini helper timeout
→ 삭제/차단하지 않음
→ failed transparency record
```

중복 링크 처리는 관리자 전용으로 분리한다.

이유:

현재 `markCommandSeen()`은 실제 삭제 성공 전에도 실행된다. 예를 들어 일반 신뢰 사용자가 먼저 같은 링크를 올렸는데 작성자 필터에서 실패하면, 현재 구조에서는 그 링크가 이미 `processedCommandKeys`에 들어간다. 그 뒤 관리자가 같은 링크를 올려도 기존 중복 필터에 막힐 수 있다.

따라서 관리자 fast path는 기존 `processedCommandKeys`만 보지 말고 `processedAdminCommandKeys`를 별도로 봐야 한다.

관리자 중복 정책:

```txt
일반 신뢰 사용자 실패 이력 있음
→ 관리자 명령은 통과 가능

관리자 명령이 Gemini helper의 유효 응답을 받은 이력 있음
→ 같은 링크의 관리자 재명령은 중복으로 무시

관리자 명령이 Gemini helper의 유효 응답을 받으면
→ 일반 신뢰 사용자 중복 방지를 위해 기존 processedCommandKeys에도 기록
```

예시:

```txt
1. 일반 신뢰 사용자 A가 #100 신고
2. #100 작성자가 일반 계정이라 기존 path에서 실패
3. 관리자 B가 #100 신고
4. 관리자 전용 중복키에는 없으므로 개념글 확인 후 Gemini helper로 이동
```

관리자 전용 중복키는 `다른 갤 링크 아님`, `게시물 HTML 조회 성공`, `개념글 아님`, `Gemini helper 유효 응답`까지 통과한 뒤 기록하는 것이 안전하다. 그래야 링크 오타, 다른 갤 링크, 게시물 접근 실패, 개념글, helper 연결 실패 같은 사전 차단/장애 케이스가 관리자 재시도까지 막지 않는다.

기존 일반 신뢰 사용자 path의 `markCommandSeen()` 시점은 가능한 한 유지한다. 이 문서의 관리자 중복키 정책은 관리자 fast path에만 적용한다.

## 5. 구현 계획

### 5.1 `api.js`

파일: `projects/dc_auto_bot/background/api.js`

변경:

```js
const DEFAULT_CONFIG = {
  ...
  trustedUsers: [],
  adminUsers: [],
  ...
};
```

주의:

- `resolveConfig()`는 `DEFAULT_CONFIG`를 spread하므로 새 필드 추가만으로 기본값 병합은 된다.
- helper API 요청 형식은 변경하지 않는다.

### 5.2 `parser.js`

파일: `projects/dc_auto_bot/background/parser.js`

기존 `normalizeTrustedUsers()`와 `isTrustedUser()`를 그대로 재사용한다.

관리자도 `{ userId, label }` 구조가 같으므로 새 normalize 함수를 만들 필요가 없다. 다만 이름이 어색하면 아래 wrapper만 추가할 수 있다.

```js
function normalizeAdminUsers(adminUsers = []) {
  return normalizeTrustedUsers(adminUsers);
}

function isAdminUser(comment, adminUsers) {
  return isTrustedUser(comment, adminUsers);
}
```

권장안:

- 함수 중복을 피하려면 `normalizeTrustedUsers()`를 범용 사용자 normalize로 그대로 사용한다.
- export 이름은 늘리지 않아도 된다.

### 5.3 `scheduler.js` 상태 저장/복원

파일: `projects/dc_auto_bot/background/scheduler.js`

필드 추가:

```js
this.processedAdminCommandKeys = [];
```

`loadState()`에서 추가:

```js
this.config = {
  ...DEFAULT_CONFIG,
  ...(state.config || {}),
  trustedUsers: normalizeTrustedUsers(state.config?.trustedUsers || []),
  adminUsers: normalizeTrustedUsers(state.config?.adminUsers || []),
};
this.processedAdminCommandKeys = normalizeStringArray(state.processedAdminCommandKeys);
```

`saveState()`에서 추가:

```js
config: {
  ...this.config,
  trustedUsers: normalizeTrustedUsers(this.config.trustedUsers),
  adminUsers: normalizeTrustedUsers(this.config.adminUsers),
},
processedAdminCommandKeys: trimRecentArray(this.processedAdminCommandKeys, 5000),
```

`getStatus()`에서 추가:

```js
config: {
  ...this.config,
  trustedUsers: normalizeTrustedUsers(this.config.trustedUsers),
  adminUsers: normalizeTrustedUsers(this.config.adminUsers),
},
adminUserCount: normalizeTrustedUsers(this.config.adminUsers).length,
```

`start()`에서 추가:

```js
this.config.trustedUsers = normalizeTrustedUsers(this.config.trustedUsers);
this.config.adminUsers = normalizeTrustedUsers(this.config.adminUsers);
```

`resetStats()`에서 추가:

```js
this.processedAdminCommandKeys = [];
```

### 5.4 `scheduler.js` 사용자 관리 메서드

파일: `projects/dc_auto_bot/background/scheduler.js`

추가:

```js
addAdminUser(userId, label) {
  this.config.adminUsers = normalizeTrustedUsers([
    ...this.config.adminUsers,
    { userId, label },
  ]);
}

removeAdminUser(userId) {
  this.config.adminUsers = normalizeTrustedUsers(
    this.config.adminUsers.filter((entry) => entry.userId !== userId),
  );
}

hasProcessedAdminCommandKey(commandKey) {
  return this.processedAdminCommandKeys.includes(String(commandKey));
}

markAdminCommandSeen(commandKey, targetPostNo) {
  if (!this.hasProcessedAdminCommandKey(commandKey)) {
    this.processedAdminCommandKeys.push(String(commandKey));
    this.processedAdminCommandKeys = trimRecentArray(this.processedAdminCommandKeys, 5000);
  }

  this.markCommandSeen(commandKey, targetPostNo);
}
```

주의:

- `markAdminCommandSeen()`은 함수만 만들어두고, 호출 위치는 Gemini helper가 `success=true` 유효 응답을 반환한 직후로 둔다.
- 일반 path의 `markCommandSeen()` 호출 위치는 기존 동작을 유지한다.
- 관리자 path에서 다른 갤 링크, 게시물 HTML 조회 실패, 개념글 제외, helper 연결 실패로 끝나면 `processedAdminCommandKeys`에는 넣지 않는다.

### 5.5 `processComment()` 분기

파일: `projects/dc_auto_bot/background/scheduler.js`

현재:

```js
const trustedUser = isTrustedUser(comment, this.config.trustedUsers);
if (!trustedUser) {
  return;
}
```

변경:

```js
const adminUser = isTrustedUser(comment, this.config.adminUsers);
const trustedUser = adminUser || isTrustedUser(comment, this.config.trustedUsers);
const isAdminFastPath = Boolean(adminUser);
if (!trustedUser) {
  return;
}
const displayLabel = isAdminFastPath ? `관리자 ${trustedUser.label}` : trustedUser.label;
```

중복/일일 제한:

```js
if (isAdminFastPath) {
  if (this.hasProcessedAdminCommandKey(commandKey)) {
    this.addLog(`↩️ [관리자 ${trustedUser.label}] 중복 링크 무시 #${parsedCommand.targetPostNo}`);
    return;
  }
} else {
  if (this.hasProcessedCommandKey(commandKey)) {
    this.addLog(`↩️ [${trustedUser.label}] 중복 링크 무시 #${parsedCommand.targetPostNo}`);
    return;
  }

  if (this.isDailyLimitExceeded(trustedUser.userId)) {
    this.addLog(`⛔ [${trustedUser.label}] 일일 ${getDailyLimitLabel(this.config.dailyLimitPerUser)}회 제한 초과`);
    return;
  }
}
```

카운터는 기존 의미를 유지한다. 중복/일일 제한을 통과한 명령은 관리자/일반 모두 접수된 명령으로 보고, `다른 갤 링크` 실패도 기존처럼 attempted/failed에 잡히게 한다.

```js
this.totalProcessedCommands += 1;
this.totalAttemptedCommands += 1;
```

일반 신뢰 사용자 명령 접수 기록:

```js
if (!isAdminFastPath) {
  this.markCommandSeen(commandKey, parsedCommand.targetPostNo);
}
```

관리자 중복키 기록은 뒤에서 개념글 필터와 Gemini helper 유효 응답까지 통과한 뒤 한다.

작성자 필터:

```js
let authorCheck = {
  success: true,
  allowed: true,
  message: '관리자 fast path',
  authorNick: '',
  adminFastPath: true,
};

if (!isAdminFastPath) {
  authorCheck = await this.evaluateTargetAuthorFromPageHtml(pageHtml, this.config, signal);
  // 기존 실패/allowed=false 처리 그대로 유지
}
```

개념글 필터는 관리자/일반 공통으로 유지한다.

```js
const recommendState = extractRecommendState(pageHtml);
if (!recommendState.success) {
  ...
}
if (recommendState.isConcept) {
  ...
}
```

최근 100개 필터:

```js
if (!isAdminFastPath) {
  const recentRegularPosts = await this.getRecentRegularPosts(signal);
  const isWithinRecentWindow = recentRegularPosts.some(...);
  if (!isWithinRecentWindow) {
    ...
  }
}
```

Gemini helper input:

```js
const helperResult = await callCliHelperJudge(
  this.config,
  {
    targetUrl: parsedCommand.targetUrl,
    title: content.title,
    bodyText: content.bodyText,
    imageUrls: content.imageUrls,
    reportReason: parsedCommand.reasonText,
    requestLabel: isAdminFastPath ? `관리자:${trustedUser.label}` : trustedUser.label,
    authorNick: authorCheck.authorNick || '',
    authorFilter: isAdminFastPath ? 'admin_fast_path' : mapAuthorFilterResult(authorCheck),
  },
  signal,
);
```

`projects/dc_auto_bot/helper/server.mjs`는 `authorFilter`를 40자 문자열로 그대로 prompt에 넣는다. 따라서 `admin_fast_path` 같은 새 문자열을 보내도 helper 파싱은 깨지지 않는다.

helper 실패 처리:

기존 일반 path는 `getHelperForceAllowFallback()`를 유지한다.

관리자 path는 helper 실패 시 force-allow fallback을 사용하지 않는다.

```js
if (!helperResult.success) {
  if (!isAdminFastPath) {
    const helperForceAllowFallback = getHelperForceAllowFallback(helperResult, content);
    if (helperForceAllowFallback) {
      // 기존 fallback 처리
    }
  }

  this.totalFailedCommands += 1;
  this.addLog(`❌ [${displayLabel}] LLM helper 실패 #${parsedCommand.targetPostNo} - ${helperResult.message || '응답 확인 실패'}`);
  await persistActiveTransparencyRecord({
    status: 'failed',
    reason: helperResult.message || 'CLI helper 판정 실패',
  }, { terminal: true });
  return;
}
```

관리자 중복키 기록:

```js
if (isAdminFastPath) {
  this.markAdminCommandSeen(commandKey, parsedCommand.targetPostNo);
}
```

이 위치는 `helperResult.success` 확인 뒤, `decision !== 'allow'`와 confidence 검사 전이다. 즉 Gemini가 deny/review/low confidence를 돌려준 경우도 유효 판정으로 보고 같은 관리자 재명령을 막는다. 반대로 helper timeout/연결 실패는 중복키에 기록하지 않아 관리자 재시도가 가능하다.

실제 삽입 위치는 기존 `await persistActiveTransparencyRecord({ status: 'completed', ... })`보다 앞이 안전하다. helper 유효 응답을 이미 받았다면 transparency 저장이 일시 실패하거나 abort되더라도 관리자 중복키 정책은 일관되게 유지되어야 하기 때문이다.

일일 사용량 증가:

기존에는 Gemini 보류, confidence 부족, 삭제 성공 등에서 `incrementDailyUsage(trustedUser.userId)`가 호출된다. 관리자 fast path는 일일 제한을 적용하지 않으므로 increment도 하지 않는다.

변경 예시:

```js
if (!isAdminFastPath) {
  this.incrementDailyUsage(trustedUser.userId);
}
```

적용 위치:

- helper fallback 성공. 단 관리자 path는 fallback 자체를 쓰지 않는다.
- helper `decision !== 'allow'`
- confidence 부족
- 최종 삭제/차단 성공

성공 로그:

기존:

```txt
✅ [EXERCENS] 처리 완료 #123 (...)
```

관리자:

```txt
✅ [관리자 だいき] 처리 완료 #123 (관리자 fast path / allow 0.92 / ...)
```

### 5.6 `background.js` 메시지 액션

파일: `projects/dc_auto_bot/background/background.js`

`updateConfig()`에서 관리자 목록을 정규화하려면 `parser.js` import에 `normalizeTrustedUsers`를 추가한다.

```js
import {
  extractPostContentForLlm,
  normalizeReportTarget,
  normalizeTrustedUsers,
  parseTargetUrl,
} from './parser.js';
```

`handleMessage()`에 추가:

```js
case 'addAdminUser':
  return addAdminUser(message.userId, message.label);

case 'removeAdminUser':
  scheduler.removeAdminUser(String(message.userId || '').trim());
  await scheduler.saveState();
  return { success: true, status: buildCombinedStatus() };
```

사용자 추가 검증은 현재 `addTrustedUser()`에 inline으로 들어 있다. 관리자 추가도 같은 검증을 써야 하므로, 구현할 때 먼저 공통 helper를 만든다.

```js
function validateUserInput(userId, label) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedLabel = String(label || '').trim();

  if (!normalizedUserId) {
    return { success: false, message: 'user_id를 입력하세요.' };
  }
  if (!normalizedLabel) {
    return { success: false, message: 'label을 입력하세요.' };
  }
  if (normalizedLabel.length > 20) {
    return { success: false, message: 'label은 20자 이하로 입력하세요.' };
  }

  return { success: true, userId: normalizedUserId, label: normalizedLabel };
}
```

그 다음 기존 `addTrustedUser()`도 이 helper를 쓰도록 바꾼다. 이렇게 해야 trusted/admin 검증 문구와 제한이 갈라지지 않는다.

새 함수:

```js
async function addAdminUser(userId, label) {
  const validation = validateUserInput(userId, label);
  if (!validation.success) {
    return { success: false, message: validation.message, status: buildCombinedStatus() };
  }

  scheduler.addAdminUser(validation.userId, validation.label);
  await scheduler.saveState();
  return { success: true, status: buildCombinedStatus() };
}
```

### 5.7 `popup.html` UI

파일: `projects/dc_auto_bot/popup/popup.html`

현재 신뢰 사용자 section 뒤에 관리자 section을 추가한다.

```html
<details class="admin-users-section">
  <summary>관리자 사용자</summary>
  <div class="section-header">
    <p>관리자는 작성자/최근100개 필터 없이 Gemini 판정으로 바로 보냅니다.</p>
  </div>

  <div class="settings-grid">
    <div class="setting-item">
      <label for="adminUserIdInput">user_id</label>
      <input type="text" id="adminUserIdInput" placeholder="image8481">
    </div>
    <div class="setting-item">
      <label for="adminUserLabelInput">label</label>
      <input type="text" id="adminUserLabelInput" maxlength="20" placeholder="だいき">
    </div>
    <button id="addAdminUserBtn" class="btn btn-primary">관리자 사용자 추가</button>
  </div>

  <div id="adminUserList" class="trusted-user-list">
    <div class="list-empty">등록된 관리자 사용자가 없습니다.</div>
  </div>
</details>
```

`popup.js`에서 `adminUserCountText`를 참조하므로 상태 grid에 관리자 수 항목은 반드시 추가한다.

```html
<div class="status-item">
  <span class="status-label">관리자 사용자</span>
  <span id="adminUserCountText" class="status-value">0명</span>
</div>
```

### 5.8 `popup.js` UI 연결

파일: `projects/dc_auto_bot/popup/popup.js`

DOM 참조 추가:

```js
const adminUserCountText = document.getElementById('adminUserCountText');
const adminUserIdInput = document.getElementById('adminUserIdInput');
const adminUserLabelInput = document.getElementById('adminUserLabelInput');
const addAdminUserBtn = document.getElementById('addAdminUserBtn');
const adminUserList = document.getElementById('adminUserList');
```

이벤트 추가:

```js
addAdminUserBtn.addEventListener('click', async () => {
  const userId = adminUserIdInput.value.trim();
  const label = adminUserLabelInput.value.trim();
  // trusted user와 동일 검증
  const response = await sendMessage({ action: 'addAdminUser', userId, label });
  ...
});
```

상태 반영:

```js
adminUserCountText.textContent = `${status.adminUserCount || 0}명`;
renderAdminUsers(config.adminUsers || []);
```

목록 렌더링:

```js
function renderAdminUsers(users) {
  renderUserList({
    users,
    listEl: adminUserList,
    emptyText: '등록된 관리자 사용자가 없습니다.',
    removeAction: 'removeAdminUser',
    removeFailText: '관리자 사용자 삭제에 실패했습니다.',
  });
}
```

현재 `renderTrustedUsers()`와 거의 동일하므로 중복을 줄이려면 `renderUserList()` 공통 함수로 빼는 것이 좋다.

### 5.9 `popup.css`

파일: `projects/dc_auto_bot/popup/popup.css`

현재 CSS는 `.trusted-users-section`에만 details 스타일을 주고 있다. 관리자 section을 같은 스타일로 보이게 하려면 selector에 `.admin-users-section`을 추가한다.

수정 대상:

```css
.trusted-users-section
.trusted-users-section summary
.trusted-users-section summary::after
.trusted-users-section:not([open]) summary::after
.trusted-users-section summary::-webkit-details-marker
```

변경 예:

```css
.trusted-users-section,
.admin-users-section,
...
```

목록 item은 기존 `.trusted-user-list`, `.trusted-user-item`를 재사용하면 CSS를 거의 추가하지 않아도 된다.

## 6. 논리 검증

### 6.1 일반 신뢰 사용자는 기존과 동일

일반 신뢰 사용자는 기존 `trustedUsers`에만 등록되어 있다.

```txt
trustedUsers: [A]
adminUsers: []
```

결과:

```txt
A 댓글
→ 기존 path
→ 작성자 필터, 최근 100개 필터, 일일 제한 모두 적용
```

### 6.2 관리자는 fast path

```txt
trustedUsers: []
adminUsers: [B]
```

결과:

```txt
B 댓글
→ 관리자 path
→ 작성자 필터/최근100개/일일 제한 스킵
→ 개념글만 아니면 Gemini helper로 이동
```

### 6.3 양쪽에 모두 있으면 관리자 우선

```txt
trustedUsers: [B]
adminUsers: [B]
```

결과:

```txt
B 댓글
→ adminUser가 먼저 잡힘
→ 관리자 path
```

### 6.4 일반 사용자 실패 후 관리자 재신고

```txt
1. A가 #100 신고
2. #100은 일반 계정이라 작성자 필터 실패
3. B가 #100 신고
```

기존 `processedCommandKeys`만 쓰면 3번이 막힐 수 있다. 그래서 관리자는 `processedAdminCommandKeys`를 별도로 본다.

결과:

```txt
B #100 신고
→ processedAdminCommandKeys에는 없으므로 진행
→ Gemini helper로 이동
```

### 6.5 관리자 중복 신고

```txt
1. B가 #100 신고
2. B가 다시 #100 신고
```

결과:

```txt
1번째: 처리
2번째: 관리자 중복키에 걸려 무시
```

### 6.6 관리자가 다른 갤 링크 신고

```txt
관리자 B가 다른 갤러리 링크 신고
```

결과:

```txt
다른 갤 링크 실패
Gemini helper로 가지 않음
```

### 6.7 관리자가 개념글 신고

```txt
관리자 B가 개념글 링크 신고
```

결과:

```txt
개념글 자동 처리 제외
Gemini helper로 가지 않음
```

### 6.8 관리자가 일반 고닉 글 신고

```txt
관리자 B가 글합수 높은 일반 고닉 글 신고
```

결과:

```txt
작성자 필터 스킵
최근 100개 필터 스킵
Gemini helper로 이동
```

### 6.9 Gemini deny

```txt
관리자 B 신고
Gemini decision = deny
```

결과:

```txt
삭제/차단 실행 안 함
관리자 일일 사용량 증가 없음
로그에는 LLM 보류로 남김
```

### 6.10 Gemini allow but confidence 낮음

```txt
관리자 B 신고
decision = allow
confidence = 0.4
threshold = 0.85
```

결과:

```txt
삭제/차단 실행 안 함
관리자 일일 사용량 증가 없음
```

### 6.11 Gemini allow + confidence 통과

```txt
관리자 B 신고
decision = allow
confidence = 0.92
```

결과:

```txt
로그인 세션 확인
삭제/차단 실행
성공 로그
```

### 6.12 로그인 세션 실패

```txt
관리자 B 신고
Gemini 통과
로그인 세션 실패
```

결과:

```txt
삭제/차단 실행 안 함
failed transparency record 저장
```

### 6.13 삭제/차단 중 세션 실패

```txt
관리자 B 신고
삭제/차단 요청이 권한/세션 실패
```

결과:

```txt
executeDeleteAndBanWithRecovery()
→ 기존 세션 재검증/재시도 로직 그대로 사용
```

### 6.14 helper timeout

```txt
관리자 B 신고
helper timeout
```

결과:

```txt
관리자용 helper 실패 처리
삭제/차단 실행 안 함
force-allow fallback 사용 안 함
```

### 6.15 기존 신뢰 사용자 일일 제한 유지

```txt
일반 신뢰 사용자 A가 하루 제한 초과
```

결과:

```txt
기존처럼 Gemini 전에 차단
```

### 6.16 관리자 일일 제한 미적용

```txt
관리자 B가 여러 건 신고
```

결과:

```txt
일일 제한 검사 없음
incrementDailyUsage() 호출 없음
```

### 6.17 기존 transparency record 유지

관리자 fast path도 기존 `activePendingRecord` 생성, heartbeat, completed/failed 저장 로직을 그대로 쓴다.

차이:

```txt
reporterLabel = 관리자 label
authorFilter = admin_fast_path
```

### 6.18 helper prompt 호환

helper는 `authorFilter`를 enum으로 강제하지 않고 40자 문자열로 prompt에 넣는다. `admin_fast_path`는 호환된다.

### 6.19 실행 중 UI 변경 제한

현재 신문고봇은 실행 중 `updateConfig`를 막는다. 관리자 사용자 추가/삭제는 현재 trusted user 추가/삭제처럼 별도 action으로 실행 중에도 가능하다.

운영적으로 실행 중 추가를 허용하면 즉시 다음 poll부터 반영된다. 기존 신뢰 사용자 동작과 맞추기 위해 관리자도 실행 중 추가/삭제 허용이 자연스럽다.

### 6.20 확장 재시작 복원

`adminUsers`와 `processedAdminCommandKeys`를 storage에 저장하면 확장 재시작 후에도 관리자 목록과 관리자 중복 이력이 유지된다.

### 6.21 관리자 댓글에 링크가 없음

```txt
관리자 B 댓글: @특갤봇 사유: 애매함
```

결과:

```txt
parseCommandComment() 실패
Gemini helper로 가지 않음
```

### 6.22 관리자 댓글에 사유가 없음

```txt
관리자 B 댓글: @특갤봇 https://gall.dcinside.com/...
```

결과:

```txt
parseCommandComment() 실패
Gemini helper로 가지 않음
```

### 6.23 관리자 댓글에 prefix가 없음

```txt
관리자 B 댓글: https://gall.dcinside.com/... 사유: 애매함
```

결과:

```txt
parseCommandComment() 실패
Gemini helper로 가지 않음
```

### 6.24 관리자 user_id가 비어 있음

```txt
comment.user_id = ''
```

결과:

```txt
adminUsers/trustedUsers 어느 쪽에도 매칭되지 않음
무시
```

### 6.25 삭제된 댓글

`pollOnce()`는 `isDeletedComment()`로 삭제 댓글을 이미 걸러낸다. 삭제 댓글은 `processComment()`까지 오지 않는다.

### 6.26 관리자 목록 중복 등록

```txt
adminUsers: [
  { userId: 'image8481', label: 'A' },
  { userId: 'image8481', label: 'B' }
]
```

결과:

```txt
normalizeTrustedUsers()가 userId 기준으로 dedupe
첫 항목만 유지
```

### 6.27 관리자 label 공백

```txt
adminUsers: [{ userId: 'image8481', label: '' }]
```

결과:

```txt
normalizeTrustedUsers()가 label fallback을 userId로 잡음
```

### 6.28 설정 저장 시 관리자 목록 보존

`background.js`의 `updateConfig()`는 `nextConfig = { ...scheduler.config, ...config }` 구조다. popup에서 일반 설정만 저장해도 기존 `adminUsers`는 유지된다.

그래도 저장 직전에는 방어적으로 정규화한다.

```js
nextConfig.trustedUsers = normalizeTrustedUsers(nextConfig.trustedUsers || []);
nextConfig.adminUsers = normalizeTrustedUsers(nextConfig.adminUsers || []);
```

### 6.29 갤러리 ID 변경

갤러리 ID 또는 신문고 target이 바뀌면 기존 코드가 통계, processed key, seed를 초기화한다. 관리자 목록은 config에 남아야 한다.

기대 결과:

```txt
adminUsers 유지
processedAdminCommandKeys 초기화 권장
lastSeenCommentNo 초기화
seeded false
```

`updateConfig()`에서 gallery/report target 변경 시 `processedAdminCommandKeys = []`도 같이 초기화하는 것이 안전하다.

### 6.30 helper force-allow fallback

기존 코드에는 helper 실패 일부 케이스에서 `getHelperForceAllowFallback()` 경로가 있다. 이 경로는 일반 신뢰 사용자 path에만 유지한다.

결과:

```txt
일반 신뢰 사용자:
fallback action 성공 시 삭제/차단 가능

관리자:
fallback 사용 안 함
helper 실패 시 삭제/차단 안 함
```

### 6.31 관리자 삭제/차단 성공 후 일반 신뢰 사용자 재신고

```txt
1. 관리자 B가 #100 처리
2. 일반 신뢰 사용자 A가 #100 재신고
```

결과:

```txt
관리자 처리 때 markCommandSeen()도 호출했으므로 일반 path는 중복 링크로 무시
```

### 6.32 일반 신뢰 사용자 처리 성공 후 관리자 재신고

```txt
1. 일반 신뢰 사용자 A가 #100 처리 성공
2. 관리자 B가 #100 재신고
```

결과:

```txt
processedAdminCommandKeys에는 없으므로 관리자 path는 시도 가능
다만 실제 게시물이 이미 삭제되어 fetchPostPage()나 삭제/차단 단계에서 실패할 수 있음
```

이 동작은 의도적으로 허용한다. 관리자는 일반 중복키를 override할 수 있어야 하기 때문이다.

### 6.33 commandPrefix 변경

관리자 fast path도 기존 `commandPrefix`를 그대로 사용한다.

```txt
commandPrefix = '@특갤봇'
```

이면 `@특갤봇`만 인식한다. prefix를 바꾸면 관리자/신뢰 사용자 모두 같은 새 prefix를 따른다.

### 6.34 helper prompt authorFilter

관리자 fast path는 helper에 `authorFilter: 'admin_fast_path'`를 보낸다.

helper는 `authorFilter`를 enum으로 검증하지 않고 문자열로 prompt에 넣으므로 깨지지 않는다.

### 6.35 transparency ranking

관리자도 기존 `reporterUserId`, `reporterLabel`, `reportReason` 필드로 기록된다. 단, pending record 재사용 시에는 이전 신고자의 label/reason을 그대로 두지 말고 현재 관리자 명령자의 값을 우선해야 한다.

결과:

```txt
관리자 처리도 auto_report record로 남음
관리자 fast path는 현재 관리자 userId/label/reason으로 기록됨
기존 ranking/공개 기록 구조와 호환
```

## 7. 구현 순서

1. `api.js`
   - `DEFAULT_CONFIG.adminUsers = []` 추가

2. `scheduler.js`
   - `adminUsers` load/save/getStatus/start normalize 추가
   - `adminUserCount` status 추가
   - `processedAdminCommandKeys` 필드 추가
   - add/remove admin method 추가
   - admin 중복 method 추가
   - `processComment()`에서 admin/trusted 분기 추가
   - admin이면 작성자 필터, 최근100개 필터, 일일 제한/increment 스킵
   - 개념글 필터, helper, confidence, 로그인, 삭제/차단은 공통 유지

3. `background.js`
   - `addAdminUser`, `removeAdminUser` action 추가
   - user input 검증 공통화 또는 trusted와 동일하게 구현

4. `popup.html`
   - 관리자 사용자 section 추가
   - status grid에 관리자 수 추가

5. `popup.js`
   - 관리자 DOM 참조 추가
   - add/remove 이벤트 추가
   - `renderAdminUsers()` 추가
   - `adminUserCount` 반영

6. `popup.css`
   - `.admin-users-section`을 기존 details selector에 추가
   - 목록은 기존 trusted user class 재사용

## 8. 패치 시 주의점

1. `trustedUser` 변수명을 그대로 쓰면 관리자 로그가 헷갈릴 수 있다. 내부적으로는 `actorUser` 또는 `commandUser`로 바꾸는 것이 안전하다.

2. `processedCommandKeys`는 기존 신뢰 사용자 중복 방지용으로 유지한다. 관리자 override를 위해 별도 `processedAdminCommandKeys`를 둔다.

3. 관리자 fast path도 `markCommandSeen()`을 같이 호출해야 이후 일반 신뢰 사용자의 같은 링크 재처리를 막을 수 있다.

   실제 `markCommandSeen()`은 `processedCommandKeys`뿐 아니라 `processedTargetPostNos`도 같이 갱신한다. 따라서 관리자 처리도 기존 status의 `processedTargetCount`에 반영된다.

4. 일반 신뢰 사용자 로직의 순서와 실패 메시지는 최대한 변경하지 않는다.

5. helper failure fallback (`getHelperForceAllowFallback`)은 기존 일반 신뢰 사용자 path에만 유지한다. 관리자 fast path에서는 Gemini helper가 `allow + confidence`를 반환한 경우에만 삭제/차단해야 하므로 fallback을 쓰면 안 된다.

6. 관리자 fast path 성공 로그에서 `authorCheck.message`는 `관리자 fast path`로 들어가야 한다. 기존 success log 템플릿을 그대로 써도 의미가 맞다.

7. 관리자 fast path에서 `getRecentRegularPosts()`를 호출하지 않아야 한다. 이것이 핵심 성능/운영 차이다.

8. 관리자 fast path에서 `fetchUserActivityStats()`도 호출되지 않아야 한다. 글합수/댓글합수 필터를 완전히 건너뛰기 위함이다.

9. 개념글 판정을 위해 `fetchPostPage()`와 `extractRecommendState()`는 계속 필요하다.

10. 관리자 목록 UI는 기존 신뢰 사용자 UI를 복사하되, action 이름만 `addAdminUser/removeAdminUser`로 분리한다.

11. 관리자 fast path에서 pending record를 재사용할 때 기존 pending record의 `reporterUserId`, `reporterLabel`, `reportReason`을 그대로 우선하면 이전 일반 신뢰 사용자 label/reason이 남을 수 있다. 관리자 fast path에서는 현재 관리자 명령자의 `userId/label/reason`을 우선 기록해야 한다.

예:

```js
reporterUserId: isAdminFastPath
  ? trustedUser.userId
  : (String(reusePendingRecord?.reporterUserId || '').trim() || trustedUser.userId),
reporterLabel: isAdminFastPath
  ? trustedUser.label
  : (String(reusePendingRecord?.reporterLabel || '').trim() || trustedUser.label),
reportReason: isAdminFastPath
  ? parsedCommand.reasonText
  : (String(reusePendingRecord?.reportReason || '').trim() || parsedCommand.reasonText),
```

12. `displayLabel` 같은 표시용 문자열을 만들어 로그 중복을 줄인다.

예:

```js
const displayLabel = isAdminFastPath ? `관리자 ${trustedUser.label}` : trustedUser.label;
```

`displayLabel`은 로그용으로만 쓴다. `executeDeleteAndBanWithRecovery()`에는 기존처럼 `trustedUser.label`을 넘긴다. 이 함수는 최종 차단 사유를 `label + 특갤봇차단 + 사유` 형태로 20자 안에 맞추기 때문에, `관리자 だいき` 같은 표시 문자열을 넘기면 차단 사유가 불필요하게 길어지고 잘릴 수 있다.

13. `processComment()`는 pending heartbeat, pending record persist, abort finalize 같은 지역 helper를 많이 가진 큰 함수다. 이번 패치에서 이 함수를 크게 쪼개면 파생 리스크가 커진다. 우선은 기존 함수 안에서 `isAdminFastPath` 조건만 걸어 흐름을 나누는 방식이 안전하다.

14. 관리자 path에서 `markAdminCommandSeen()`은 Gemini helper가 `success=true` 유효 응답을 반환한 직후에 호출한다. 하지만 `totalProcessedCommands`, `totalAttemptedCommands`는 기존 의미를 유지하기 위해 중복/일일 제한 통과 직후에 올린다.

15. 관리자 path가 helper 연결 실패/timeout으로 끝나면 `processedAdminCommandKeys`를 기록하지 않는다. helper 장애 복구 후 관리자가 같은 링크를 다시 명령할 수 있어야 하기 때문이다. 반대로 Gemini가 `deny/review/allow but low confidence`처럼 유효 응답을 준 경우는 판정이 완료된 것이므로 관리자 중복키에 기록한다.

## 9. 실제 코드 교차검증 결과

문서와 실제 코드 흐름을 다시 대조하면서 발견한 구현 위험과 반영한 결론이다.

1. helper fallback 충돌
   - 실제 코드에는 `getHelperForceAllowFallback()`가 있다.
   - 관리자는 Gemini `allow + confidence` 판정이 핵심이므로, 관리자 path에서는 fallback을 쓰면 안 된다.
   - 문서에 관리자 helper 실패 시 삭제/차단하지 않도록 명시했다.

2. 일반 신뢰 사용자 실패 후 관리자 override
   - 실제 코드의 `markCommandSeen()`은 삭제 성공 전에도 실행된다.
   - 기존 키만 쓰면 일반 신뢰 사용자 실패가 관리자 재시도를 막을 수 있다.
   - 문서에 `processedAdminCommandKeys` 분리를 명시했다.

3. 관리자 중복키 기록 시점
   - 너무 일찍 기록하면 링크 오타, 다른 갤 링크, 개념글 같은 경우도 재시도가 막힌다.
   - helper 호출 직전에 기록하면 helper 장애도 재시도가 막힌다.
   - 결론은 `게시물 HTML 조회 성공 + 개념글 아님 + Gemini helper 유효 응답` 이후다.

4. pending record reporter 문제
   - 실제 코드는 pending record 재사용 시 기존 `reporterUserId/reporterLabel`을 우선한다.
   - 관리자 override에서는 이전 일반 신뢰 사용자 label과 신고 사유가 기록될 수 있다.
   - 문서에 관리자 path는 현재 관리자 userId/label/reason을 우선 기록하도록 명시했다.

5. 카운터 시점
   - 실제 코드에서는 command 접수 후 foreign gallery 실패도 attempted에 포함된다.
   - 관리자 path에서 중복키 기록을 뒤로 미뤄도 카운터는 기존 의미를 유지해야 한다.
   - 문서에 카운터 증가 위치를 별도로 명시했다.

6. 큰 함수 분리 리스크
   - `processComment()`는 pending heartbeat와 transparency record 상태가 지역 변수로 얽혀 있다.
   - 큰 구조분리는 이번 기능 범위를 넘어서며 abort/finalize 누락 위험이 있다.
   - 문서에 조건 분기 중심의 최소 패치를 권장했다.

7. UI/storage 연결
   - 기존 trusted user 추가/삭제는 실행 중에도 별도 action으로 동작한다.
   - 관리자도 같은 패턴으로 별도 action을 추가하면 실행 중 다음 poll부터 반영된다.
   - `updateConfig()`에는 방어적 normalize와 갤/신문고 변경 시 `processedAdminCommandKeys` 초기화를 넣는 것으로 정리했다.

## 10. 최종 기대 동작 예시

예시 1: 일반 신뢰 사용자

```txt
댓글: @특갤봇 https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=100 사유: 운영방침 애매
작성자: 활동 많은 일반 고닉

결과:
일반 계정 작성자 필터 실패
Gemini helper로 가지 않음
```

예시 2: 관리자 사용자

```txt
댓글: @특갤봇 https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=100 사유: 운영방침 애매
작성자: 활동 많은 일반 고닉

결과:
작성자 필터 스킵
최근 100개 필터 스킵
개념글만 아니면 Gemini helper로 이동
Gemini allow + confidence 통과 시 삭제/차단
```

예시 3: 관리자지만 개념글

```txt
댓글: @특갤봇 https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=200 사유: 애매함
대상: 개념글

결과:
개념글 자동 처리 제외
Gemini helper로 가지 않음
```

## 11. 결론

구현은 가능하고 구조 변경도 크지 않다. 핵심은 `processComment()`에서 관리자와 일반 신뢰 사용자를 나누고, 관리자 fast path에서는 작성자 필터와 최근 100개 필터를 건너뛰는 것이다.

기존 신뢰 사용자 플로우는 그대로 유지한다. 관리자 fast path만 별도 중복키와 별도 사용자 목록을 가진다. 이 방식이면 기존 운영 안정성은 유지하면서, 관리자들이 운영방침이 애매한 글을 Gemini 판사에게 바로 넘기는 요구를 만족할 수 있다.
