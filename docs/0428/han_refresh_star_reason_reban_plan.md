# 도배기갱신차단자동 `*` 사유 갱차 분기 구현 문서

## 목표

`도배기갱신차단자동`의 기존 기능은 그대로 둔다.

추가로, 관리내역 차단 사유에 ASCII `*` 문자가 들어간 row는 작성자가 유동 IP인지, 고닉/반고닉 식별코드인지와 상관없이 `*` 사유로 6시간 재차단한다.

예시:

```text
관리내역 row
- 종류: 게시글
- 상태: 차단 중
- 작성자: helmet9281
- 사유: *

결과
- user_code_avoid 재차단
- avoid_hour=6
- avoid_reason=0
- avoid_reason_txt=*
```

```text
관리내역 row
- 종류: 댓글
- 상태: 차단 중
- 작성자: 118.235
- 사유: 신고*

결과
- user_code_avoid 재차단
- avoid_hour=6
- avoid_reason=0
- avoid_reason_txt=*
```

기존 도배기 갱신 예시:

```text
관리내역 row
- 종류: 게시글
- 상태: 차단 중
- 작성자: 118.235
- 사유: 도배기IP차단(무고한 경우 문의)

결과
- 기존 로직 그대로
- avoid_reason_txt=도배기IP차단(무고한 경우 문의)
```

중요한 정정:

- `*` 사유 분기는 IP형 유동 필터를 타면 안 된다.
- `*` 사유 분기는 고닉/반고닉도 포함해야 한다.
- 기존 한자 제목/도배 사유 갱신은 현재처럼 IP형 유동만 대상으로 유지한다.

## 현재 실제 코드 구조

관련 파일:

- `features/han-refresh-ip-ban/parser.js`
- `features/han-refresh-ip-ban/scheduler.js`
- `features/han-refresh-ip-ban/api.js`
- `features/ip/parser.js`

현재 background 연결:

- `background/background.js`에서 `HanRefreshIpBanScheduler`를 생성한다.
- popup의 `도배기갱신차단자동` 토글은 `hanRefreshIpBan` feature의 `start/stop/updateConfig/resetStats`로 연결된다.

현재 UI 설정:

- 요청 딜레이
- fallback 최대 페이지

차단 시간/사유는 UI 입력이 아니라 코드 기본값으로 처리된다.

## 호출 연결부 재검증

패치 전 실제 연결 흐름을 다시 확인했다.

### popup

`popup/popup.js`의 `bindHanRefreshIpBanEvents()`는 아래 action만 보낸다.

```text
toggle ON  -> sendFeatureMessage('hanRefreshIpBan', { action: 'start' })
toggle OFF -> sendFeatureMessage('hanRefreshIpBan', { action: 'stop' })
설정 저장 -> sendFeatureMessage('hanRefreshIpBan', { action: 'updateConfig', config: { requestDelay, fallbackMaxPage } })
통계 초기화 -> sendFeatureMessage('hanRefreshIpBan', { action: 'resetStats' })
```

따라서 `*` 사유 갱차는 새 UI 입력이 아니라 scheduler 내부 자동 분기로 들어가는 것이 맞다.

### background

`background/background.js`는 `hanRefreshIpBan` feature를 `schedulers.hanRefreshIpBan`에 연결한다.

```text
start      -> scheduler.start()
stop       -> scheduler.stop()
updateConfig -> normalizeHanRefreshIpBanConfig({ ...scheduler.config, ...message.config })
getAllStatus -> schedulers.hanRefreshIpBan.getStatus()
```

이번 변경은 `scheduler.config`의 저장 항목을 늘리지 않는다.

따라서 background message action을 추가할 필요가 없다.

### scheduler

실제 실행 흐름:

```text
start()
-> ensureRunLoop()
-> run()
-> runCycle()
-> scanPageRange()
-> processPage()
-> extractActionableManagementRows()
-> rebanManagementRows()
```

변경 지점은 `processPage()` 안에서 대상 row를 두 그룹으로 나누는 부분이다.

```text
star_reason rows   -> * config로 rebanManagementRows()
legacy rows        -> 기존 this.config로 rebanManagementRows()
```

### api

`api.js`의 `rebanManagementRows()`는 내부에서 `withDcRequestLease()`를 탄다.

```text
rebanManagementRows()
-> withDcRequestLease({ feature: 'hanRefreshIpBan', kind: 'rebanManagementRows' })
-> rebanManagementRowsWithFallback()
-> rebanManagementRowBatch()
-> POST /ajax/managements_ajax/user_code_avoid
```

한 페이지에서 요청이 2번으로 나뉘어도 둘 다 같은 lease 흐름을 순차적으로 탄다.

동시 요청으로 바뀌는 것이 아니므로 기존 세션 브로커 흐름을 깨지 않는다.

### 상태/통계 연결

popup이 보여주는 값은 기존 status 필드다.

```text
currentCycleScannedRows
currentCycleMatchedRows
currentCycleBanSuccessCount
currentCycleBanFailureCount
logs
```

새 분기 전용 상태값은 필수가 아니다.

`*사유` 대상 수는 로그에 표시하고, 전체 성공/실패는 기존 count에 합산한다.

## 현재 관리내역 파싱 흐름

`features/han-refresh-ip-ban/parser.js`는 `features/ip/parser.js`의 `parseBlockListRows()`를 재사용한다.

`parseBlockListRows()`가 뽑는 핵심 값:

```text
postNo
title
blockDataNum
reason
duration
stateText
releaseId
ano
writerNick
writerToken
isActive
rowHtml
```

`isActive` 기준:

```text
onclick="set_avoid(..., 'R', ...)"
```

즉 해제 버튼이 있는 row만 `차단 중`으로 본다.

현재 재차단에 쓰는 `avoidNo`:

```text
avoidNo = blockDataNum - 1
```

중요:

- `avoidNo`는 게시글 번호가 아니다.
- 관리내역 row 내부 번호 기반 값이다.
- 실제 API payload의 `nos[]`에 들어간다.

## 현재 기존 대상 조건

현재 `extractActionableManagementRows()`는 아래 순서로 row를 거른다.

```text
1. 게시글/댓글 row인가
2. 차단 중인가
3. writerToken이 IP형 유동인가
4. 제목에 Han 글자 2개 이상이거나 사유에 "도배"가 있는가
5. blockDataNum 상한 이내인가
6. avoidNo가 유효한가
7. 같은 사이클에서 이미 처리한 avoidNo가 아닌가
```

현재 문제 지점:

```js
if (!isIpLikeWriterToken(row.writerToken)) {
  continue;
}
```

이 조건 때문에 기존 파이프라인에 `*` 조건만 추가하면 고닉/반고닉은 빠진다.

따라서 `*` 사유 분기는 이 IP형 유동 필터보다 먼저 또는 별도 경로에서 판단해야 한다.

## 구현 원칙

### 1. matchKind를 3개로 확장

현재:

```js
const MATCH_KIND = {
  HAN_TITLE: 'han_title',
  DOBAE_REASON: 'dobae_reason',
};
```

변경:

```js
const MATCH_KIND = {
  STAR_REASON: 'star_reason',
  HAN_TITLE: 'han_title',
  DOBAE_REASON: 'dobae_reason',
};
```

의미:

```text
star_reason
  사유에 ASCII *가 들어간 row
  작성자 토큰이 IP인지 UID인지 보지 않음

han_title
  기존 조건
  IP형 유동만 대상

dobae_reason
  기존 조건
  IP형 유동만 대상
```

### 2. `*` 사유 판정 helper 추가

추가 함수:

```js
function hasStarReason(value) {
  return String(value || '').includes('*');
}
```

범위:

- ASCII `*`만 본다.
- 전각 `＊`는 이번 스펙에 포함하지 않는다.
- 공백 정규화는 필수는 아니지만 기존 `hasDobaeReason()`처럼 trim 정도는 해도 된다.

### 3. matchKind 우선순위

`*` 사유가 최우선이다.

```text
사유: 도배*
제목: 漢字 포함
작성자: 118.235

결과:
star_reason 으로만 처리
* 사유로 6시간 재차단
기존 도배기 사유 그룹에는 넣지 않음
```

`*` 자체도 ASCII `*`를 포함한다.

따라서 한 번 `*`로 재차단된 row는 다음 사이클에도 `STAR_REASON` 대상이다.

예시:

```text
1회차:
  사유: *
  -> * / 6시간 재차단

2회차:
  사유: *
  -> 다시 * / 6시간 재차단
```

이 동작은 자동 갱신 목적에 맞다. 별도 TTL이나 제외 조건을 두지 않는다.

권장 구현:

```js
function getActionableMatchKind(row) {
  if (hasStarReason(row?.reason || '')) {
    return MATCH_KIND.STAR_REASON;
  }

  if (!isIpLikeWriterToken(row?.writerToken)) {
    return '';
  }

  if (getHanScriptCharCount(row?.title || '') >= MIN_HAN_CHAR_COUNT) {
    return MATCH_KIND.HAN_TITLE;
  }

  if (hasDobaeReason(row?.reason || '')) {
    return MATCH_KIND.DOBAE_REASON;
  }

  return '';
}
```

이렇게 하면 `extractActionableManagementRows()` 안의 기존 IP형 필터를 제거하거나, `getActionableMatchKind()` 안으로 옮겨야 한다.

금지할 형태:

```js
if (!isIpLikeWriterToken(row.writerToken)) {
  continue;
}

const matchKind = getActionableMatchKind(row);
```

이 형태는 `*` 사유 고닉/반고닉을 계속 누락한다.

### 4. row 공통 필터는 유지

`*` 분기도 아래 조건은 그대로 지켜야 한다.

```text
게시글/댓글 row
차단 중 row
blockDataNum 유효
avoidNo 유효
이번 사이클 seenAvoidNos 중복 아님
사이클 시작 기준 maxAllowedBlockDataNum 이하
```

즉 아래 row는 `*`가 있어도 제외한다.

```text
해제됨 row
공지/관리내역 아닌 이상한 row
blockDataNum 없음
blockDataNum <= 1
이번 사이클 시작 이후 새로 생긴 row
이미 같은 사이클에서 처리한 row
```

## API 요청 구조

현재 재차단 API:

```text
POST /ajax/managements_ajax/user_code_avoid

ci_t=<ci_c 쿠키>
gallery_id=<galleryId>
_GALLTYPE_=<galleryType>
avoid_hour=<시간>
avoid_reason=<사유 코드>
avoid_reason_txt=<직접 입력 사유>
nos[]=<avoidNo>
```

현재 `rebanManagementRows(config, avoidNos, refererPage)`는 config의 아래 값을 그대로 사용한다.

```text
avoidHour
avoidReason
avoidReasonText
```

따라서 `*`는 API helper를 새로 만들 필요가 없다.

같은 API를 이렇게 config override로 재사용하면 된다.

```js
const starReasonConfig = {
  ...this.config,
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: '*',
};

await this.rebanManagementRows(starReasonConfig, starAvoidNos, page);
```

기존 그룹은 그대로:

```js
await this.rebanManagementRows(this.config, defaultAvoidNos, page);
```

## scheduler 분기 설계

현재 `processPage()`는 모든 대상 row의 avoidNo를 하나로 묶어 한 번만 요청한다.

현재:

```js
const hanTitleMatchCount = actionableRows.filter((row) => row.matchKind === 'han_title').length;
const dobaeReasonMatchCount = actionableRows.filter((row) => row.matchKind === 'dobae_reason').length;
const avoidNos = actionableRows.map((row) => row.avoidNo);

result = await this.rebanManagementRows(this.config, avoidNos, page);
```

변경 후:

```js
const starReasonRows = actionableRows.filter((row) => row.matchKind === MATCH_KIND.STAR_REASON);
const defaultRows = actionableRows.filter((row) => row.matchKind !== MATCH_KIND.STAR_REASON);

const starAvoidNos = starReasonRows.map((row) => row.avoidNo);
const defaultAvoidNos = defaultRows.map((row) => row.avoidNo);
```

요청은 최대 2번:

```text
1. starAvoidNos -> * / 6시간
2. defaultAvoidNos -> 기존 사유 / 6시간
```

`*` 사유가 없으면 기존처럼 요청 1번만 발생한다.

한 페이지에 `*` 사유만 있으면 기존 그룹 요청은 하지 않는다.

한 페이지에 기존 대상만 있으면 `*` 요청은 하지 않는다.

### 그룹 호출 중지 조건

기존 코드는 재차단 요청 전에 한 번만 `this.isRunning`을 확인한다.

변경 후에는 한 페이지에서 요청이 최대 2개로 늘 수 있으므로, 그룹 사이에도 `this.isRunning`을 다시 확인해야 한다.

예시:

```text
12페이지 대상:
- *사유 3개
- 기존 도배사유 4개

진행:
1. * 3개 요청 시작
2. 사용자가 토글 OFF
3. * 요청은 이미 시작했으므로 결과만 집계
4. 기존 도배사유 4개 요청은 새로 시작하지 않음
```

권장 흐름:

```js
const groupResults = [];

if (starAvoidNos.length > 0 && this.isRunning) {
  groupResults.push(await runRebanGroup(
    this,
    page,
    starReasonRows,
    buildStarReasonRebanConfig(this.config),
    '*',
  ));
}

if (defaultAvoidNos.length > 0 && this.isRunning) {
  groupResults.push(await runRebanGroup(
    this,
    page,
    defaultRows,
    this.config,
    '기존갱차',
  ));
}
```

이렇게 해야 사용자가 중지했는데도 같은 페이지의 두 번째 배치가 추가로 나가는 일을 막는다.

### 그룹 실패 처리

한 그룹이 실패해도 다른 그룹은 가능하면 시도한다.

예시:

```text
* 그룹: HTTP 403 실패
기존갱차 그룹: 성공 가능
```

이때 `processPage()` 전체를 바로 throw로 끝내면 기존갱차 대상이 처리되지 않는다.

따라서 `runRebanGroup()`은 예외를 잡아서 아래 형태로 반환하는 것이 안전하다.

```js
{
  successNos: [],
  failedNos: avoidNos,
  message: '* 요청 실패 - HTTP 403'
}
```

`rebanManagementRows()`가 throw하지 않고 실패 result를 반환하는 경우도 있으므로, 성공/실패 집계는 항상 `successNos`, `failedNos` 배열 기준으로 한다.

## 로그 설계

현재 로그:

```text
✅ 12페이지: 검사 30줄, 대상 5줄 (한자 2 / 도배사유 3), 재차단 5건
```

변경 권장 로그:

```text
✅ 12페이지: 검사 30줄, 대상 7줄 (*사유 2 / 한자 2 / 도배사유 3), 재차단 7건
```

실패 포함:

```text
⚠️ 12페이지: 검사 30줄, 대상 7줄 (*사유 2 / 한자 2 / 도배사유 3), 성공 6건 / 실패 1건
```

그룹별 상세 실패가 필요하면:

```text
⚠️ 12페이지 * 상세: HTTP 403 / ...
⚠️ 12페이지 기존갱차 상세: HTTP 403 / ...
```

로그에서 `*사유` count가 보여야 실제로 새 분기가 작동했는지 운영 중 확인 가능하다.

## 통계 설계

기존 상태값:

```text
currentCycleScannedRows
currentCycleMatchedRows
currentCycleBanSuccessCount
currentCycleBanFailureCount
```

필수 추가 상태값은 없다.

이유:

- popup은 기존 `대상 row`, `성공`, `실패`만 보여줘도 된다.
- 새 기능은 기존 기능 안의 분기다.
- UI를 새로 만들 필요가 없다.

선택 추가:

```text
currentCycleStarReasonMatchedRows
```

하지만 이번 요구사항에는 필수는 아니다. 로그에 `*사유 N`이 남으면 운영 확인은 가능하다.

## 함수 변경안

### `features/han-refresh-ip-ban/parser.js`

변경 대상:

```text
MATCH_KIND
extractActionableManagementRows()
getActionableMatchKind()
hasStarReason()
export 목록
```

권장 흐름:

```js
function extractActionableManagementRows(html, options = {}) {
  const rows = parseBlockListRows(html);
  ...

  for (const row of rows) {
    if (!isRebannableBlockRow(row)) continue;
    if (!row.isActive) continue;

    const blockDataNum = toBlockDataNum(row.blockDataNum);
    if (maxAllowedBlockDataNum > 0 && blockDataNum > maxAllowedBlockDataNum) continue;

    const avoidNo = toAvoidNo(blockDataNum);
    if (avoidNo <= 0) continue;

    const matchKind = getActionableMatchKind(row);
    if (!matchKind) continue;

    const avoidNoKey = String(avoidNo);
    if (seenAvoidNos.has(avoidNoKey)) continue;

    seenAvoidNos.add(avoidNoKey);
    actionableRows.push({ ...row, avoidNo, matchKind });
  }
}
```

주의:

- `matchKind`보다 `avoidNo` 계산을 먼저 해도 된다.
- 핵심은 `isIpLikeWriterToken()`이 `STAR_REASON` 앞에서 전체 row를 탈락시키면 안 된다는 점이다.

### `features/han-refresh-ip-ban/scheduler.js`

변경 대상:

```text
import MATCH_KIND
processPage()
```

상단 import:

```js
import {
  extractActionableManagementRows,
  extractMaxBlockDataNum,
  isLikelyManagementBlockHtml,
  MATCH_KIND,
  parseDetectedMaxPage,
} from './parser.js';
```

상수:

```js
const STAR_REASON_REBAN_CONFIG = {
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: '*',
};
```

또는 함수:

```js
function buildStarReasonRebanConfig(config = {}) {
  return {
    ...config,
    avoidHour: '6',
    avoidReason: '0',
    avoidReasonText: '*',
  };
}
```

상수만 단독으로 `rebanManagementRows()`에 넘기면 안 된다.

잘못된 예:

```js
await this.rebanManagementRows(STAR_REASON_REBAN_CONFIG, starAvoidNos, page);
```

이렇게 하면 `galleryId`, `galleryType`, `baseUrl`을 `DEFAULT_CONFIG`에 의존하게 된다. 공통 설정으로 다른 갤러리를 쓰는 경우 잘못된 갤러리에 요청할 수 있다.

반드시 현재 scheduler config를 먼저 펼친 뒤 사유만 덮어쓴다.

```js
await this.rebanManagementRows(
  buildStarReasonRebanConfig(this.config),
  starAvoidNos,
  page,
);
```

요청 helper 권장:

```js
async function runRebanGroup(scheduler, page, rows, config, label) {
  const avoidNos = rows.map((row) => row.avoidNo);
  if (avoidNos.length <= 0) {
    return {
      successNos: [],
      failedNos: [],
      message: '',
    };
  }

  try {
    return await scheduler.rebanManagementRows(config, avoidNos, page);
  } catch (error) {
    return {
      successNos: [],
      failedNos: avoidNos,
      message: `${label} 요청 실패 - ${error.message}`,
    };
  }
}
```

다만 현재 `processPage()` 내부만 작게 고쳐도 된다. 별도 helper는 중복을 줄이기 위한 선택이다.

### 최종 `processPage()` 권장 구조

구현 시 흐름은 아래 순서가 안전하다.

```text
1. extractActionableManagementRows()로 rows/actionableRows 획득
2. match count 계산
   - starReasonMatchCount
   - hanTitleMatchCount
   - dobaeReasonMatchCount
3. currentCycleScannedRows/currentCycleMatchedRows 증가
4. actionableRows가 0이면 로그 후 종료
5. starReasonRows/defaultRows 분리
6. this.isRunning이면 * 그룹 호출
7. this.isRunning이면 기존갱차 그룹 호출
8. 모든 group result의 successNos/failedNos를 합산
9. currentCycleBanSuccessCount/currentCycleBanFailureCount 반영
10. 그룹별 message가 있으면 상세 로그 출력
11. saveState()
```

중요:

- `this.isRunning`이 false가 된 뒤 새 그룹 요청을 시작하면 안 된다.
- 이미 시작한 요청은 중간 취소하지 않는다. 기존 코드도 fetch 중간 취소 구조가 없다.
- 그룹 하나가 실패해도 다른 그룹은 시도한다.
- 최종 페이지 로그는 두 그룹 결과를 합산해서 한 번 남긴다.

## 처리 예시

### 예시 1. 고닉 `*` 사유

```text
row:
  종류: 게시글
  상태: 차단 중
  writerToken: helmet9281
  reason: *

판정:
  isRebannableBlockRow: true
  isActive: true
  hasStarReason: true
  isIpLikeWriterToken: 검사하지 않음
  matchKind: star_reason

요청:
  avoid_reason_txt=*
```

### 예시 2. 반고닉 `신고*`

```text
row:
  종류: 댓글
  상태: 차단 중
  writerToken: rebel2146
  reason: 신고*

결과:
  star_reason
  * 6시간
```

### 예시 3. IP형 유동 기존 도배기 사유

```text
row:
  종류: 게시글
  상태: 차단 중
  writerToken: 118.235
  reason: 도배기IP차단(무고한 경우 문의)

결과:
  dobae_reason
  기존 사유 6시간
```

### 예시 4. 고닉 기존 도배기 사유

```text
row:
  종류: 게시글
  상태: 차단 중
  writerToken: helmet9281
  reason: 도배기IP차단(무고한 경우 문의)

결과:
  대상 아님
```

기존 기능 의미를 유지해야 하므로 고닉 기존 도배기 사유는 새로 확대하지 않는다.

### 예시 5. `도배*`

```text
row:
  종류: 게시글
  상태: 차단 중
  writerToken: 118.235
  reason: 도배*

결과:
  star_reason 우선
  * 6시간
```

한 row를 두 사유로 두 번 재차단하지 않는다.

## 논리 검증

### 기존 기능 보존

기존 조건:

```text
IP형 유동 + 한자 제목
IP형 유동 + 도배 사유
```

이 조건은 그대로 유지된다.

수정 후에도 `*`가 없는 고닉/반고닉은 기존 로직 대상이 아니다.

### 새 기능 확장

새 조건:

```text
사유에 * 포함
```

이 조건은 writerToken 종류를 보지 않는다.

따라서 아래 모두 가능하다.

```text
118.235
helmet9281
rebel2146
빈 writerToken
```

빈 writerToken은 일반적으로 관리내역 row가 정상이라면 거의 없지만, API는 `avoidNo` 기반이라 writerToken은 payload에 쓰지 않는다. 따라서 `*` 사유가 있고 active row라면 writerToken 누락만으로 제외하지 않는다.

### 중복 방지

현재 `seenAvoidNos`는 한 사이클 안에서 같은 `avoidNo`를 한 번만 처리하게 한다.

수정 후에도 유지한다.

결과:

```text
같은 row가 페이지 밀림으로 두 번 보임
-> 첫 번째만 처리
-> 두 번째는 seenAvoidNos로 제외
```

### tail 보정 유지

현재 사이클 시작 시 1페이지에서 `currentCycleBaselineMaxBlockDataNum`을 잡는다.

수정 후에도 `*` 사유 row에 동일하게 적용한다.

목적:

```text
이번 사이클에서 재차단하면서 새로 생긴 관리내역 row를 같은 사이클에서 다시 따라가지 않기
```

### 요청 수 증가

한 페이지에 `*` 대상과 기존 대상이 섞이면 요청이 최대 2번으로 늘어난다.

예시:

```text
page 12
- * 대상 3개
- 기존 대상 4개

요청:
1. * 3개 batch
2. 기존 사유 4개 batch
```

이는 사유가 다르기 때문에 필요한 분리다.

`*` 대상만 있거나 기존 대상만 있으면 요청은 1번이다.

## 엣지케이스 체크리스트

1. 사유가 `*`인 IP형 유동 게시글은 `*` 대상이다.
2. 사유가 `*`인 IP형 유동 댓글은 `*` 대상이다.
3. 사유가 `*`인 고닉 게시글은 `*` 대상이다.
4. 사유가 `*`인 고닉 댓글은 `*` 대상이다.
5. 사유가 `신고*`인 반고닉 게시글은 `*` 대상이다.
6. 사유가 `신고*`인 반고닉 댓글은 `*` 대상이다.
7. 사유가 `도배*`인 IP형 유동 row는 `*` 우선이다.
8. 사유가 `도배*`인 고닉 row는 `*` 대상이다.
9. 사유가 `도배기IP차단(무고한 경우 문의)`인 IP형 유동 row는 기존 대상이다.
10. 사유가 `도배기IP차단(무고한 경우 문의)`인 고닉 row는 대상이 아니다.
11. 제목에 한자 2개 이상인 IP형 유동 row는 기존 대상이다.
12. 제목에 한자 2개 이상인 고닉 row는 `*`가 없으면 대상이 아니다.
13. 제목에 한자 2개 이상이고 사유가 `*`인 고닉 row는 `*` 대상이다.
14. 제목에 한자 2개 이상이고 사유가 `*`인 IP형 유동 row는 `*` 우선이다.
15. 해제됨 row는 `*`가 있어도 제외한다.
16. `게시글/댓글`이 아닌 row는 `*`가 있어도 제외한다.
17. `blockDataNum`이 없으면 제외한다.
18. `blockDataNum`이 숫자가 아니면 제외한다.
19. `blockDataNum <= 1`이면 avoidNo가 유효하지 않아 제외한다.
20. `maxAllowedBlockDataNum`보다 큰 row는 `*`가 있어도 제외한다.
21. 같은 avoidNo가 같은 사이클에서 두 번 보이면 한 번만 처리한다.
22. 한 페이지에 `*` 대상만 있으면 `*` 요청만 발생한다.
23. 한 페이지에 기존 대상만 있으면 기존 요청만 발생한다.
24. 한 페이지에 둘 다 있으면 요청이 2번 발생한다.
25. `*` 요청 실패, 기존 요청 성공이면 성공/실패 count가 합산되어야 한다.
26. `*` 요청 성공, 기존 요청 실패이면 성공/실패 count가 합산되어야 한다.
27. `ci_c` 쿠키가 없으면 두 그룹 모두 실패 처리될 수 있다.
28. 한 그룹 batch 실패 시 기존 fallback split은 그대로 동작한다.
29. `*` 대상 1개 batch 실패 시 failedNos에 해당 avoidNo가 남는다.
30. 기존 대상 1개 batch 실패 시 기존 실패 처리와 동일하다.
31. requestDelay는 페이지 사이에만 적용되고 그룹 두 개 사이에는 별도 delay가 없다. 필요하면 나중에 추가한다.
32. popup 설정 저장은 기존처럼 requestDelay/fallbackMaxPage만 저장한다.
33. 상태 복원은 기존 config normalize를 타므로 새 상수는 저장하지 않아도 된다.
34. 로그에 `*사유 N`이 보여야 운영 중 새 분기 작동 여부를 확인할 수 있다.
35. 전각 `＊`는 이번 구현 대상이 아니다.
36. `*` 그룹 처리 후 토글 OFF가 되면 기존갱차 그룹은 새로 시작하지 않는다.
37. `*` 그룹이 실패해도 아직 실행 중이면 기존갱차 그룹은 시도한다.
38. 기존갱차 그룹이 실패해도 이미 성공한 `*` 결과는 성공 count로 유지한다.
39. `STAR_REASON_REBAN_CONFIG`만 단독 전달하지 않고 반드시 `this.config`를 펼쳐 갤러리 설정을 보존한다.
40. 사유가 이미 `*`인 row도 다음 사이클에서 다시 `*` 대상이다.

## 실제 코드 대조 결과

2026-04-28 기준 실제 코드와 문서를 다시 대조했다.

### 확인 1. 현재 parser는 `*` 고닉을 누락한다

현재 `features/han-refresh-ip-ban/parser.js` 흐름:

```text
isRebannableBlockRow(row)
-> row.isActive
-> isIpLikeWriterToken(row.writerToken)
-> getActionableMatchKind(row)
```

따라서 아래 row는 현재 코드에서 대상이 아니다.

```text
종류: 게시글
상태: 차단 중
writerToken: helmet9281
reason: *
```

이유:

```text
helmet9281은 /^\d+\.\d+$/ 형식이 아니므로 isIpLikeWriterToken=false
getActionableMatchKind()까지 도달하지 못함
```

문서의 변경안처럼 `hasStarReason()`을 먼저 보고, 기존 IP형 유동 필터는 한자/도배 사유 분기 안으로 내려야 한다.

### 확인 2. `reason`은 이미 일반 문자열이다

`features/ip/parser.js`의 `parseBlockListRows()`는 `blockreason`을 아래처럼 처리한다.

```js
reason: decodeHtml(stripTags(reasonMatch ? reasonMatch[1] : '')),
```

따라서 `hasStarReason(row.reason)`은 HTML 태그가 섞인 값을 직접 보는 것이 아니다.

예시:

```html
<td class="blockreason">신고*</td>
```

파싱 결과:

```text
row.reason = 신고*
```

그래서 `String(row.reason).includes('*')`로 충분하다.

### 확인 3. API는 config override로 충분하다

`features/han-refresh-ip-ban/api.js`의 `rebanManagementRowBatch()`는 아래 값을 그대로 body에 넣는다.

```js
body.set('avoid_hour', String(config.avoidHour));
body.set('avoid_reason', String(config.avoidReason));
body.set('avoid_reason_txt', config.avoidReasonText || '');
```

따라서 `*`용 endpoint를 새로 만들 필요가 없다.

필요한 것은 scheduler에서 이 config를 넘기는 것뿐이다.

```js
{
  ...this.config,
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: '*',
}
```

### 확인 4. background/popup 연결 변경은 필수가 아니다

`hanRefreshIpBan`은 이미 `background/background.js`에서 scheduler config를 normalize해서 넘긴다.

이번 기능은 새 UI 설정이 아니라 기존 자동 작업 안의 내부 분기다.

따라서 필수 패치 범위는 아래 2개 파일이다.

```text
features/han-refresh-ip-ban/parser.js
features/han-refresh-ip-ban/scheduler.js
```

`api.js`, `background.js`, `popup.js`, `popup.html`은 필수 변경 대상이 아니다.

### 확인 5. 실제 파서 출력 기준 모의 검증

파일을 수정하지 않고, 현재 `parseBlockListRows()`가 뽑는 값 위에 문서의 미래 match 로직을 얹어 확인했다.

목업 row:

```text
고닉 / 사유:*                    -> star_reason
반고닉 / 사유:신고*              -> star_reason
IP형 유동 / 사유:도배기IP차단... -> dobae_reason
고닉 / 사유:도배기IP차단...      -> 제외
IP형 유동 / 제목:漢字테스트      -> han_title
고닉 / 제목:漢字테스트           -> 제외
해제됨 / 사유:*                  -> 제외
```

결과는 문서 설계와 일치했다.

## 테스트 계획

### 구문 검사

```bash
node --check features/han-refresh-ip-ban/parser.js
node --check features/han-refresh-ip-ban/scheduler.js
node --check features/han-refresh-ip-ban/api.js
git diff --check -- features/han-refresh-ip-ban/parser.js features/han-refresh-ip-ban/scheduler.js features/han-refresh-ip-ban/api.js
```

### parser 목업 테스트

관리내역 row HTML을 만들어 아래 결과를 확인한다.

```text
IP + *        -> star_reason
UID + *       -> star_reason
IP + 도배     -> dobae_reason
UID + 도배    -> 제외
IP + 한자     -> han_title
UID + 한자    -> 제외
해제됨 + *    -> 제외
```

### scheduler 목업 테스트

`Scheduler`에 mock dependency를 넣는다.

```js
const calls = [];
const scheduler = new Scheduler({
  fetchManagementBlockHTML: async () => html,
  rebanManagementRows: async (config, avoidNos, page) => {
    calls.push({ config, avoidNos, page });
    return { successNos: avoidNos, failedNos: [], message: '' };
  },
});
```

확인:

```text
calls[0].config.avoidReasonText === '*'
calls[0].avoidNos === star avoidNos
calls[1].config.avoidReasonText === '도배기IP차단(무고한 경우 문의)'
calls[1].avoidNos === existing avoidNos
```

실행 중 `*` 대상과 기존 대상이 같은 페이지에 섞였을 때 요청이 2개로 분리되는지 본다.

## 실제 패치 순서

1. `parser.js`
   - `MATCH_KIND.STAR_REASON` 추가
   - `hasStarReason()` 추가
   - `getActionableMatchKind()`에서 `*` 우선 처리
   - 기존 `isIpLikeWriterToken()` 필터를 `getActionableMatchKind()` 내부의 legacy 조건으로 이동
   - `hasStarReason` export 추가

2. `scheduler.js`
   - `MATCH_KIND` import 추가
   - `buildStarReasonRebanConfig(this.config)` 추가
   - `processPage()`에서 `starReasonRows/defaultRows` 분리
   - `*` 그룹과 기존 그룹을 각각 `rebanManagementRows()`로 호출
   - 그룹 사이 `this.isRunning` 재확인
   - 그룹별 실패가 전체 페이지 처리를 끊지 않도록 result 형태로 흡수
   - 성공/실패 count 합산
   - 로그에 `*사유` count 추가

3. `api.js`
   - 필수 변경 없음
   - 현재 `rebanManagementRows()`는 config override만으로 다른 사유 전송 가능

4. popup/background
   - 필수 변경 없음
   - UI 설정 추가 없이 자동 분기로 동작

## 최종 결론

구현 가능하다.

핵심은 기존 `도배기/한자 갱신` 조건을 넓히는 것이 아니라, `* 사유 갱차`를 별도 matchKind로 추가하는 것이다.

기존 기능:

```text
IP형 유동 + 한자 제목/도배 사유 -> 기존 사유로 6시간 갱신
```

새 기능:

```text
사유에 * 포함 + 차단 중 게시글/댓글 row -> 작성자 종류 무관하게 *로 6시간 갱신
```

이렇게 분리하면 고닉/반고닉도 `*` 사유 갱신 대상에 포함하면서, 기존 도배기갱신차단자동의 운영 범위는 깨지지 않는다.
