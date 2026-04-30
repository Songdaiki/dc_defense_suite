# 분탕자동차단 광고 닉네임 fast-path 구현 문서

## 목표

`분탕자동차단`이 10초마다 1페이지 HTML을 보는 흐름에 작성자 닉네임 기반 광고 차단 분기를 추가한다.

대상 닉네임 6개:

```text
유서닝
유서니
혜서닝
혜서니
혜비니
혜비닝
```

조건:

```text
page1 게시글 작성자 닉네임이 위 6개 중 하나와 매칭
```

동작:

```text
차단 시간: 6시간
차단 사유: *광고
삭제 여부: 삭제 + 차단
대상: 게시글 작성자
본문 조회: 하지 않음
제목 검사: 하지 않음
UID/IP 조건: 보지 않음
```

예시:

```text
page1 row
- 글번호: 123456
- 닉네임: 유서니
- uid: minute2134
- 제목: 배민, 김티, 3만, 공짜

결과
- /ajax/minor_manager_board_ajax/update_avoid_list 호출
- nos[]=123456
- avoid_hour=6
- avoid_reason=0
- avoid_reason_txt=*광고
- del_chk=1
- avoid_type_chk=1
```

비매칭 예시:

```text
닉네임: 유서니팬
결과: 통과
이유: 정확히 일치하지 않음
```

## 현재 실제 코드 구조

관련 파일:

```text
features/uid-warning-autoban/api.js
features/uid-warning-autoban/parser.js
features/uid-warning-autoban/scheduler.js
features/ip/ban-executor.js
features/ip/api.js
background/background.js
popup/popup.html
popup/popup.js
```

현재 10초 주기:

```text
features/uid-warning-autoban/api.js
DEFAULT_CONFIG.pollIntervalMs = 10000
```

현재 list fetch:

```text
fetchUidWarningAutoBanListHTML(config, 1)
-> GET /mgallery/board/lists/?id={galleryId}&page=1
```

현재 page1 row 파싱:

```text
parseImmediateTitleBanRows(html)
-> parsePage1BoardRows(html, { requireUid: false })
```

중요한 점:

```text
parseImmediateTitleBanRows()는 uid 없는 순수 유동글도 포함한다.
광고 닉네임 fast-path도 이 allRows를 그대로 쓰면 된다.
```

## 현재 파서 검증

`features/uid-warning-autoban/parser.js`의 `parsePage1BoardRows()`는 row마다 아래 값을 이미 만든다.

```text
no
uid
nick
title
subject
commentCount
currentHead
createdAtMs
writerToken
writerKey
writerDisplay
contentType
hasImageIcon
isPicturePost
isFluid
hasUid
ip
```

작성자 닉네임은 아래 흐름이다.

```text
writerTag = <td class="gall_writer ...">
nick = decodeHtml(extractAttribute(writerTag, 'data-nick') || 'ㅇㅇ')
```

따라서 목록 HTML에 아래처럼 있으면:

```html
<td class="gall_writer ub-writer" data-nick="유서니" data-uid="minute2134" data-ip="" data-loc="list">
```

파서 결과는:

```js
{
  no: 123456,
  nick: '유서니',
  uid: 'minute2134',
  ip: '',
  writerToken: 'minute2134',
  hasUid: true,
  isFluid: false
}
```

화면에는 `유서니 님`처럼 보일 수 있지만, 실제 비교 대상은 `data-nick="유서니"`다.

## 현재 scheduler 실행 순서

현재 `runCycle()` 흐름:

```text
1. page1 HTML fetch
2. allRows = parseImmediateRows(html)
3. pageUidRows = allRows.filter(row.hasUid)
4. 제목 직차단
5. 이거진짜 링크본문
6. 실제공격 제목 군집
7. 실제공격 댓글 군집
8. uid 기반 burst/활동비율/방명록 검사
```

현재 중복 방지:

```text
processedImmediatePostNos
processedLinkbaitBodyLinkPostNos
processedAttackTitlePostNos
processedPostNos
```

새 광고 닉네임 분기는 `allRows` 직후, 제목 직차단보다 앞에 둔다.

패치 후 순서:

```text
1. page1 HTML fetch
2. allRows = parseImmediateRows(html)
3. 광고 닉네임 fast-path
4. 제목 직차단
5. 이거진짜 링크본문
6. 실제공격 제목 군집
7. 실제공격 댓글 군집
8. uid 기반 burst/활동비율/방명록 검사
```

이 순서가 맞는 이유:

```text
광고 닉네임은 본문 조회가 필요 없다.
광고 닉네임은 제목 패턴보다 더 강한 신호다.
먼저 처리하면 같은 글이 링크본문/군집/uid 경로로 중복 처리되지 않는다.
```

중요한 연결 주의:

```text
processedPostNos는 실제공격 제목 군집 처리 뒤에 만들어진다.
따라서 광고 닉네임 처리 글을 제목 직차단/링크본문에서만 빼면 부족하다.
실제공격 제목 군집에 넘기는 rows filter에도 processedAdNickBanPostNos를 직접 넣어야 한다.
```

## 구현 설계

### 1. 기본 설정 추가

위치:

```text
features/uid-warning-autoban/api.js
```

`DEFAULT_CONFIG`에 추가한다.

```js
adNickBanEnabled: true,
adNickBanNicknames: ['유서닝', '유서니', '혜서닝', '혜서니', '혜비니', '혜비닝'],
adNickBanAvoidHour: '6',
adNickBanAvoidReason: '0',
adNickBanAvoidReasonText: '*광고',
```

UI 저장값으로는 일단 넣지 않는다.

이유:

```text
현재 분탕자동차단은 제목 직차단 규칙만 사용자가 저장한다.
이거진짜 링크본문, 실제공격 군집, 댓글군집은 대부분 DEFAULT_CONFIG 기반이다.
이번 광고 닉네임 6개도 같은 성격의 운영용 fast-path다.
```

### 2. scheduler 상태값 추가

위치:

```text
features/uid-warning-autoban/scheduler.js
```

constructor에 추가:

```js
this.lastAdNickBanMatchedNick = '';
this.lastAdNickBanCount = 0;
this.totalAdNickBanPostCount = 0;
this.recentAdNickBanPostActions = {};
```

`runCycle()` 시작부 reset:

```js
this.lastAdNickBanMatchedNick = '';
this.lastAdNickBanCount = 0;
```

`saveState()`에 저장:

```js
lastAdNickBanMatchedNick
lastAdNickBanCount
totalAdNickBanPostCount
recentAdNickBanPostActions
```

`loadState()`에서 복원:

```js
this.lastAdNickBanMatchedNick = String(...)
this.lastAdNickBanCount = Math.max(0, Number(...) || 0)
this.totalAdNickBanPostCount = Math.max(0, Number(...) || 0)
this.recentAdNickBanPostActions = normalizeRecentAdNickBanPostActions(...)
```

`getStatus()`에 포함:

```js
lastAdNickBanMatchedNick
lastAdNickBanCount
totalAdNickBanPostCount
```

`resetStats` 흐름에서 초기화:

```text
background/background.js의 uidWarningAutoBan reset branch
background/background.js의 resetUidWarningAutoBanSchedulerState()
```

초기화 대상:

```js
scheduler.lastAdNickBanMatchedNick = '';
scheduler.lastAdNickBanCount = 0;
scheduler.totalAdNickBanPostCount = 0;
scheduler.recentAdNickBanPostActions = {};
```

두 곳이 모두 필요한 이유:

```text
resetSchedulerStats(feature, scheduler)의 uidWarningAutoBan branch
-> popup의 통계 초기화 버튼에서 탄다.

resetUidWarningAutoBanSchedulerState(message)
-> 공통 갤러리 변경 등 scheduler 상태를 강제 초기화할 때 탄다.
```

### 3. 최근 처리 dedupe 추가

기존 post-level dedupe helper를 재사용한다.

```js
function buildAdNickBanPostActionKey(postNo) {
  return buildImmediatePostActionKey(postNo);
}

function createRecentAdNickBanPostActionEntry({ success, nowIso }) {
  return createRecentImmediatePostActionEntry({ success, nowIso });
}

function shouldSkipRecentAdNickBanPostAction(entry, nowMs, retryCooldownMs) {
  return shouldSkipRecentImmediatePostAction(entry, nowMs, retryCooldownMs);
}

function normalizeRecentAdNickBanPostActions(raw = {}) {
  return normalizeRecentImmediatePostActions(raw);
}

function pruneRecentAdNickBanPostActions(entries = {}) {
  pruneRecentImmediatePostActions(entries);
}
```

이유:

```text
광고 닉네임 제재도 글번호 기준 post-level action이다.
성공한 글은 24시간 재시도하지 않는다.
실패한 글은 retryCooldownMs 안에서는 재시도하지 않는다.
```

### 4. 닉네임 정규화 추가

광고 닉네임은 제목처럼 공격자가 중간에 다른 문자를 넣는 패턴이 아니라, 실제 닉네임 값 자체를 보는 기능이다.

따라서 과격한 정규화는 하지 않는다.

권장 정규화:

```js
const AD_NICK_INVISIBLE_CHARACTER_REGEX = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

function normalizeAdNickBanNickname(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(AD_NICK_INVISIBLE_CHARACTER_REGEX, '')
    .replace(/\s+/g, '')
    .trim();
}
```

매칭 방식:

```text
정규화 후 exact match
includes 금지
```

예시:

```text
유서니 -> 유서니 -> 매칭
유 서 니 -> 유서니 -> 매칭
유서니팬 -> 유서니팬 -> 비매칭
혜비닝​ -> 혜비닝 -> 매칭
```

정규화를 너무 강하게 하지 않는 이유:

```text
닉네임은 제목/본문과 달리 짧고 오탐 위험이 높다.
혜서니팬 같은 정상 닉을 includes로 잡으면 안 된다.
```

### 5. config normalize 추가

`normalizeConfig()`에 추가:

```js
adNickBanEnabled: config.adNickBanEnabled === undefined
  ? Boolean(DEFAULT_CONFIG.adNickBanEnabled)
  : Boolean(config.adNickBanEnabled),
adNickBanNicknames: normalizeAdNickBanNicknames(config.adNickBanNicknames),
adNickBanAvoidHour: String(config.adNickBanAvoidHour || DEFAULT_CONFIG.adNickBanAvoidHour).trim()
  || DEFAULT_CONFIG.adNickBanAvoidHour,
adNickBanAvoidReason: String(config.adNickBanAvoidReason || DEFAULT_CONFIG.adNickBanAvoidReason).trim()
  || DEFAULT_CONFIG.adNickBanAvoidReason,
adNickBanAvoidReasonText: String(config.adNickBanAvoidReasonText || DEFAULT_CONFIG.adNickBanAvoidReasonText).trim()
  || DEFAULT_CONFIG.adNickBanAvoidReasonText,
```

`normalizeAdNickBanNicknames()`:

```js
function normalizeAdNickBanNicknames(value = []) {
  const rawNicknames = Array.isArray(value) && value.length > 0
    ? value
    : DEFAULT_CONFIG.adNickBanNicknames;
  const seen = new Set();
  const result = [];
  for (const rawNickname of rawNicknames) {
    const normalizedNickname = normalizeAdNickBanNickname(rawNickname);
    if (!normalizedNickname || seen.has(normalizedNickname)) {
      continue;
    }
    seen.add(normalizedNickname);
    result.push(normalizedNickname);
  }
  return result;
}
```

`buildPersistedConfig()`에는 추가하지 않는다.

이유:

```text
이번 6개 닉은 운영 기본값이다.
UI 저장/복원과 섞으면 사용자가 저장 버튼을 눌렀을 때 숨은 기본값이 덮이는지까지 관리해야 한다.
지금은 코드 기본값으로 두는 것이 안전하다.
```

### 6. 광고 닉네임 제재 config builder 추가

```js
function buildAdNickBanConfig(config = {}) {
  return {
    ...config,
    avoidHour: String(config.adNickBanAvoidHour || '6'),
    avoidReason: String(config.adNickBanAvoidReason || '0'),
    avoidReasonText: String(config.adNickBanAvoidReasonText || '*광고'),
    delChk: true,
    avoidTypeChk: true,
  };
}
```

중요:

```text
deleteEnabled은 runtimeDeleteEnabled를 따른다.
```

즉 평상시:

```text
runtimeDeleteEnabled=true
-> 차단 + 삭제
```

삭제 한도 보호 상태:

```text
runtimeDeleteEnabled=false
-> 차단만 수행
```

이건 기존 제목직차단, 링크본문, 실제공격 군집과 같은 정책이다.

### 7. handler 추가

새 메서드:

```js
async handleAdNickBanRows(rows = [], nowMs = Date.now()) {
  const processedAdNickBanPostNos = new Set();
  if (this.config.adNickBanEnabled === false) {
    return processedAdNickBanPostNos;
  }

  const targetNicknameSet = new Set(normalizeAdNickBanNicknames(this.config.adNickBanNicknames));
  if (targetNicknameSet.size <= 0) {
    return processedAdNickBanPostNos;
  }

  const matchedRows = [];
  const matchedNicknames = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const postNo = Number(row?.no) || 0;
    if (postNo <= 0) {
      continue;
    }

    const normalizedNick = normalizeAdNickBanNickname(row?.nick || '');
    if (!targetNicknameSet.has(normalizedNick)) {
      continue;
    }

    processedAdNickBanPostNos.add(postNo);

    const actionKey = buildAdNickBanPostActionKey(postNo);
    if (
      shouldSkipRecentAdNickBanPostAction(
        this.recentAdNickBanPostActions[actionKey],
        nowMs,
        getRetryCooldownMs(this.config),
      )
    ) {
      this.log(`ℹ️ 광고 닉네임 스킵 - #${postNo} ${normalizedNick}는 최근 처리 이력이 있어 건너뜀`);
      continue;
    }

    matchedRows.push(row);
    matchedNicknames.push(normalizedNick);
  }

  if (matchedRows.length <= 0) {
    return processedAdNickBanPostNos;
  }

  if (!this.isRunning) {
    return processedAdNickBanPostNos;
  }

  const targetPosts = createImmediateTitleBanTargetPosts(matchedRows);
  if (targetPosts.length <= 0) {
    this.log('ℹ️ 광고 닉네임 스킵 - page1 대상 글번호를 만들지 못함');
    return processedAdNickBanPostNos;
  }

  const representativeNick = summarizeMatchedTitles(matchedNicknames);
  this.lastAdNickBanMatchedNick = representativeNick;
  this.lastAdNickBanCount += targetPosts.length;
  this.log(`🚨 광고 닉네임 ${representativeNick || '닉네임'} 매치 -> page1 ${targetPosts.length}개 차단/삭제 시작`);

  const result = await this.executeBan({
    feature: 'uidWarningAutoBan',
    config: buildAdNickBanConfig(this.config),
    posts: targetPosts,
    deleteEnabled: this.runtimeDeleteEnabled,
    onDeleteLimitFallbackSuccess: (fallbackResult) => {
      this.log(`🔁 삭제 한도 계정 전환 성공 - ${fallbackResult.activeAccountLabel}로 같은 run을 이어갑니다.`);
    },
    onDeleteLimitBanOnlyActivated: (message) => {
      this.activateDeleteLimitBanOnly(message);
    },
  });

  this.totalAdNickBanPostCount += result.successNos.length;
  this.totalBannedPostCount += result.successNos.length;
  this.totalFailedPostCount += result.failedNos.length;
  this.deleteLimitFallbackCount += result.deleteLimitFallbackCount;
  if (result.banOnlyFallbackUsed) {
    this.banOnlyFallbackCount += 1;
  }
  this.runtimeDeleteEnabled = result.finalDeleteEnabled;

  if (result.successNos.length > 0) {
    this.log(`⛔ 광고 닉네임 글 ${result.successNos.length}개 차단${result.finalDeleteEnabled ? '/삭제' : ''} 완료`);
  }

  if (result.banOnlyRetrySuccessCount > 0) {
    this.log(`🧯 광고 닉네임 글 ${result.banOnlyRetrySuccessCount}개는 차단만 수행`);
  }

  if (result.failedNos.length > 0) {
    this.log(`⚠️ 광고 닉네임 제재 실패 ${result.failedNos.length}개 - ${result.failedNos.join(', ')}`);
  }

  const actionAt = new Date().toISOString();
  const successNos = new Set(result.successNos.map((postNo) => String(postNo)));
  for (const targetPost of targetPosts) {
    this.recentAdNickBanPostActions[buildAdNickBanPostActionKey(targetPost.no)] =
      createRecentAdNickBanPostActionEntry({
        success: successNos.has(String(targetPost.no)),
        nowIso: actionAt,
      });
  }

  await this.saveState();
  return processedAdNickBanPostNos;
}
```

### 8. runCycle 연결

현재:

```js
const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const processedLinkbaitBodyLinkPostNos = await this.handleLinkbaitBodyLinkRows(
  allRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0)),
  nowMs,
);
```

변경:

```js
const processedAdNickBanPostNos = await this.handleAdNickBanRows(allRows, nowMs);
const processedImmediatePostNos = await this.handleImmediateTitleBanRows(
  allRows.filter((row) => !processedAdNickBanPostNos.has(Number(row?.no) || 0)),
  nowMs,
);
const processedLinkbaitBodyLinkPostNos = await this.handleLinkbaitBodyLinkRows(
  allRows.filter((row) => {
    const postNo = Number(row?.no) || 0;
    return !processedAdNickBanPostNos.has(postNo)
      && !processedImmediatePostNos.has(postNo);
  }),
  nowMs,
);
const processedAttackTitlePostNos = await this.handleAttackTitleClusterRows(
  allRows.filter((row) => {
    const postNo = Number(row?.no) || 0;
    return !processedAdNickBanPostNos.has(postNo)
      && !processedImmediatePostNos.has(postNo)
      && !processedLinkbaitBodyLinkPostNos.has(postNo);
  }),
  nowMs,
);
```

`processedPostNos` 생성에도 추가:

```js
const processedPostNos = new Set([
  ...processedAdNickBanPostNos,
  ...processedImmediatePostNos,
  ...processedLinkbaitBodyLinkPostNos,
  ...processedAttackTitlePostNos,
]);
```

### 9. 완료 로그 확장

현재 완료 로그:

```text
제목 직차단 / 이거진짜 링크본문 / 실제공격 / 댓글군집 / 단일깡계
```

추가:

```text
광고닉 {this.totalAdNickBanPostCount}개
```

예시:

```text
✅ 사이클 #12 완료 - page1 글 50개 / uid 38명 / 광고닉 14개 / 제목 직차단 0개 / 이거진짜 링크본문 0개 / 실제공격 0개 / 댓글군집 0개 / 단일깡계 0개
```

### 10. popup 표시

필수는 아니지만 운영 확인을 위해 상태 카드 3개를 추가하는 쪽이 좋다.

`popup/popup.html`에 추가:

```html
<div class="status-item">
  <span class="status-label">최근 광고닉</span>
  <span id="uidWarningAutoBanLastAdNickBanMatchedNick" class="status-value">-</span>
</div>
<div class="status-item">
  <span class="status-label">최근 광고닉 제재</span>
  <span id="uidWarningAutoBanLastAdNickBanCount" class="status-value">0개</span>
</div>
<div class="status-item">
  <span class="status-label">누적 광고닉</span>
  <span id="uidWarningAutoBanTotalAdNickBanPostCount" class="status-value">0개</span>
</div>
```

`popup/popup.js`의 `FEATURE_DOM.uidWarningAutoBan`에 추가:

```js
lastAdNickBanMatchedNick: document.getElementById('uidWarningAutoBanLastAdNickBanMatchedNick'),
lastAdNickBanCount: document.getElementById('uidWarningAutoBanLastAdNickBanCount'),
totalAdNickBanPostCount: document.getElementById('uidWarningAutoBanTotalAdNickBanPostCount'),
```

상태 렌더링 기본값에 추가:

```js
lastAdNickBanMatchedNick: '',
lastAdNickBanCount: 0,
totalAdNickBanPostCount: 0,
```

`updateUidWarningAutoBanUI()`에 추가:

```js
dom.lastAdNickBanMatchedNick.textContent = nextStatus.lastAdNickBanMatchedNick || '-';
dom.lastAdNickBanCount.textContent = `${nextStatus.lastAdNickBanCount ?? 0}개`;
dom.totalAdNickBanPostCount.textContent = `${nextStatus.totalAdNickBanPostCount ?? 0}개`;
```

메타 텍스트 우선순위:

```text
기존 runtimeDeleteEnabled=false 경고가 더 중요하다.
따라서 광고 닉네임 최근 제재 문구는 삭제한도/차단만 경고 블록 뒤,
기존 제목 직차단 최근 제재 문구 앞에 넣는다.
```

```js
if ((status.lastAdNickBanCount ?? 0) > 0) {
  return `최근 광고 닉네임 ${status.lastAdNickBanMatchedNick || '닉네임'} / page1 글 ${status.lastAdNickBanCount ?? 0}개 제재`;
}
```

기능 설명 문구:

```text
10초마다 1페이지를 확인해 광고 닉네임, 제목 직차단, 이거진짜 링크본문, 실제공격 제목/댓글 군집, ...
```

## API 호출 검증

실제 제재 함수:

```text
features/ip/ban-executor.js
executeBanWithDeleteFallback()
```

내부 호출:

```text
features/ip/api.js
banPosts()
-> banPostsWithFallback()
-> banPostBatch()
-> POST /ajax/minor_manager_board_ajax/update_avoid_list
```

payload:

```text
ci_t={ci_c 쿠키}
id={galleryId}
nos[]=글번호
parent=
avoid_hour=6
avoid_reason=0
avoid_reason_txt=*광고
del_chk=1
_GALLTYPE_=M
avoid_type_chk=1
```

삭제 한도 fallback:

```text
executeBanWithDeleteFallback()
-> banPosts(delChk=true)
-> delete_limit_exceeded 감지
-> requestDeleteLimitAccountFallback()
-> 성공하면 새 계정으로 같은 nos 재시도
-> 실패하면 runtimeDeleteEnabled=false 전환 후 delChk=false로 차단만 재시도
```

따라서 광고 닉네임 분기도 기존 삭제 한도 폴백을 그대로 탄다.

## 플로우 예시

### 예시 1. 광고 닉 12개 출현

```text
page1에 유서니 5개, 혜서니 4개, 혜비닝 3개
```

처리:

```text
1. allRows 파싱
2. 광고 닉네임 분기에서 12개 매칭
3. update_avoid_list 한 번 또는 batchSize 기준 여러 번 호출
4. 사유는 전부 *광고
5. 12개 글번호는 processedPostNos에 들어감
6. 기존 제목/본문/군집/uid 경로는 이 12개를 건드리지 않음
```

### 예시 2. 같은 글이 다음 cycle에도 남아 있음

```text
이전 cycle에서 #123456 성공
다음 cycle에도 #123456이 page1에 남아 있음
```

처리:

```text
recentAdNickBanPostActions[#123456].success=true
-> 광고 닉네임 스킵 로그
-> processedAdNickBanPostNos에는 포함
-> 다른 분기로 중복 제재하지 않음
```

### 예시 3. 삭제 한도 발생

```text
유서니 광고글 30개 처리 중 삭제 한도 초과
```

처리:

```text
1. executeBanWithDeleteFallback이 delete_limit_exceeded 감지
2. 계정 fallback 요청
3. fallback 성공 시 나머지 글을 새 계정으로 삭제/차단
4. fallback 실패 시 runtimeDeleteEnabled=false
5. 남은 글은 delChk=false로 차단만 재시도
```

### 예시 4. 정상 유저가 비슷한 닉네임

```text
닉네임: 혜서니팬
```

처리:

```text
normalizeAdNickBanNickname('혜서니팬') = '혜서니팬'
대상 set에는 '혜서니'만 있음
exact match 실패
-> 광고 닉네임 분기 통과
```

## 논리 검증

1. `pollIntervalMs=10000`이므로 기존 10초 루프에 추가된다.
2. `parseImmediateTitleBanRows()`는 `requireUid=false`라 uid 없는 row도 포함한다.
3. 광고 닉네임은 UID/IP 조건을 보지 않으므로 `allRows`를 써야 한다.
4. `pageUidRows`를 쓰면 순수 유동 광고를 놓칠 수 있으므로 금지다.
5. `row.nick`은 `data-nick`에서 나오므로 화면의 `님` 접미사와 무관하다.
6. `유서니 님` 화면표시는 `data-nick="유서니"`로 비교된다.
7. exact match라 `유서니팬`은 잡지 않는다.
8. exact match라 `혜서니123`도 잡지 않는다.
9. 공백 제거 정규화로 `혜 서 니`는 잡을 수 있다.
10. zero-width 제거로 숨은 문자 삽입 닉도 잡을 수 있다.
11. NFKC로 호환문자 변형을 일부 흡수한다.
12. 제목은 검사하지 않는다.
13. 본문은 조회하지 않는다.
14. 이미지 여부는 검사하지 않는다.
15. 댓글수는 검사하지 않는다.
16. currentHead는 검사하지 않는다.
17. 이미 도배기탭 분류된 글도 닉네임 조건이면 제재 대상이다.
18. `isAlreadySpamHead()`를 광고 닉네임 분기에 넣으면 광고를 놓칠 수 있으므로 넣지 않는다.
19. 광고 닉네임 분기는 제목 직차단보다 먼저 돈다.
20. 먼저 돈 글번호는 `processedAdNickBanPostNos`와 `processedPostNos`로 다음 분기에서 제외된다.
21. 같은 cycle 중복 제재가 없다.
22. 성공 글은 최근 처리 캐시로 다음 cycle 재시도하지 않는다.
23. 실패 글은 `retryCooldownMs` 동안 재시도하지 않는다.
24. retry cooldown 이후 실패 글은 다시 시도될 수 있다.
25. 삭제 한도 fallback은 기존 `executeBanWithDeleteFallback`을 그대로 탄다.
26. fallback 성공 시 계정 전환 로그가 기존과 동일하게 남는다.
27. fallback 실패 시 차단만 모드로 전환된다.
28. `runtimeDeleteEnabled=false`일 때는 광고 닉네임도 차단만 수행한다.
29. stop 중이면 handler loop는 `this.isRunning` 확인으로 중단 가능해야 한다.
30. `createImmediateTitleBanTargetPosts()`를 쓰면 uid/ip/닉 정보가 기존 제재 포맷과 맞다.
31. postNo 없는 row는 버린다.
32. 같은 postNo가 중복 row로 나오면 targetPosts에서 dedupe된다.
33. `buildPersistedConfig()`에 숨은 설정을 저장하지 않아도 DEFAULT_CONFIG로 동작한다.
34. 사용자가 제목 직차단 저장 버튼을 눌러도 광고 닉네임 기본값은 사라지지 않는다.
35. background `updateConfig`가 `normalizeUidWarningAutoBanConfig()`를 타므로 새 config 필드는 정상화된다.
36. popup에 상태 필드를 추가하지 않아도 기능은 동작하지만, 운영 확인용으로 추가하는 것이 좋다.
37. popup 상태 필드를 추가하면 `getStatus()`에도 해당 값이 있어야 한다.
38. resetStats를 누르면 광고 닉네임 누적/최근 값도 같이 초기화되어야 한다.
39. 공통 갤러리 변경으로 `resetUidWarningAutoBanSchedulerState()`가 호출되어도 광고 닉네임 상태가 같이 초기화되어야 한다.
40. 로그가 남으므로 실제 공격 시 어떤 닉이 걸렸는지 확인 가능하다.
41. 기존 uid 기반 깡계 로직은 광고 닉네임에서 처리되지 않은 row만 받는다.
42. 기존 이거진짜 링크본문 로직은 광고 닉네임 처리 글을 다시 본문조회하지 않는다.
43. 기존 실제공격 제목 군집은 광고 닉네임 처리 글을 군집 계산에서 제외한다.
44. 기존 댓글 군집은 광고 닉네임 처리 글을 제외하고 댓글 조회 후보를 만든다.
45. 기존 총 성공/실패 카운트에 합산되므로 전체 통계가 어긋나지 않는다.
46. 광고 닉네임 처리 뒤 사용자가 토글 OFF를 누른 경우, 제재 API 시작 전 `this.isRunning`을 다시 확인해야 한다.
47. `processedPostNos` 생성 전에 실행되는 실제공격 제목 군집 filter에도 광고 닉네임 processed set을 직접 넣어야 한다.

## 구현 순서

1. `api.js` `DEFAULT_CONFIG`에 광고 닉네임 기본값 6개와 사유 설정 추가.
2. `scheduler.js` constructor에 최근/누적 광고닉 상태 추가.
3. `scheduler.js` `runCycle()` reset과 prune에 광고닉 상태 추가.
4. `scheduler.js` `handleAdNickBanRows()` 추가.
5. `scheduler.js` `runCycle()`에서 광고닉 handler를 제목 직차단보다 먼저 호출.
6. `scheduler.js` `processedPostNos`에 광고닉 처리 글번호 포함.
7. `scheduler.js` `saveState/loadState/getStatus`에 광고닉 상태 추가.
8. `scheduler.js` post-level recent action helper 추가.
9. `background/background.js` `resetSchedulerStats()`의 uidWarningAutoBan branch에 광고닉 상태 초기화 추가.
10. `background/background.js` `resetUidWarningAutoBanSchedulerState()`에 광고닉 상태 초기화 추가.
11. `popup/popup.html` 상태 카드에 최근 닉/최근 건수/누적 광고닉 표시 추가.
12. `popup/popup.js` DOM/status/meta/render에 광고닉 표시 추가.
13. `node --check`로 수정 파일 문법 확인.
14. mock HTML로 6개 닉 매칭/비매칭 확인.
15. 삭제 한도 mock으로 fallback 경로가 기존과 동일한지 확인.

## 테스트 계획

### 문법 검사

```bash
node --check features/uid-warning-autoban/api.js
node --check features/uid-warning-autoban/parser.js
node --check features/uid-warning-autoban/scheduler.js
node --check background/background.js
node --check popup/popup.js
```

### 정적 mock 테스트

테스트 row:

```js
[
  { no: 1, nick: '유서닝', uid: 'a1', title: '광고1' },
  { no: 2, nick: '유서니', uid: 'a2', title: '광고2' },
  { no: 3, nick: '혜서닝', uid: 'a3', title: '광고3' },
  { no: 4, nick: '혜서니', uid: 'a4', title: '광고4' },
  { no: 5, nick: '혜비니', uid: 'a5', title: '광고5' },
  { no: 6, nick: '혜비닝', uid: 'a6', title: '광고6' },
  { no: 7, nick: '혜서니팬', uid: 'a7', title: '정상' },
]
```

기대:

```text
제재 대상: 1,2,3,4,5,6
제외 대상: 7
avoid_reason_txt=*광고
avoid_hour=6
del_chk=1
```

### 실제 HTML 기반 테스트

`docs/html.md` 또는 새 캡처 HTML의 `data-nick`를 임시로 바꾼다.

```html
data-nick="유서니"
```

기대:

```text
parseImmediateTitleBanRows(html) 결과에 nick='유서니'
handleAdNickBanRows() 결과 processed set에 해당 글번호 포함
executeBan mock payload reasonText='*광고'
```

## 최종 판단

이 기능은 기존 `분탕자동차단` 구조에 잘 맞는다.

이유:

```text
이미 10초마다 page1 HTML을 받고 있다.
이미 parser가 data-nick을 뽑고 있다.
이미 게시글 차단/삭제 API와 삭제한도 fallback이 있다.
새로 필요한 것은 row.nick exact match 분기뿐이다.
```

가장 안전한 구현은:

```text
광고 닉네임 6개를 DEFAULT_CONFIG 기본값으로 둔다.
본문 조회 없이 page1 row.nick만 exact match한다.
제목 직차단보다 먼저 처리한다.
처리된 글번호는 기존 분기에서 제외한다.
사유는 *광고, 시간은 6시간으로 고정한다.
```
