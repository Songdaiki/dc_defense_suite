# kcaptcha recom_cnt 자동 연동 구현 계획

> 작성일: 2026-04-16
> 목적: 개념컷 자동조절에서 DEFENDING/NORMAL 전환 시 kcaptcha 개념글 추천 기준(recom_cnt)을 함께 변경

## 목적

현재 공용 개념컷 coordinator가 DEFENDING → 컷 100, NORMAL → 컷 14로 전환할 때,
kcaptcha의 `recom_cnt`(개념글 추천 기준)도 함께 움직이게 해야 한다.

- 컷 100 (DEFENDING) → `recom_cnt = 8`
- 컷 14 (NORMAL) → `recom_cnt = 2`

핵심 원칙: **`recom_cnt`만 변경하고, 나머지 kcaptcha 파라미터는 기존 값을 유지한다.**

## 2026-04-16 구현 반영 현황

이 문서 기준 패치는 이미 반영되었다.

- `features/concept-monitor/api.js`
  - `syncKcaptchaRecomCnt()` high-level helper 추가
  - management 페이지 GET / shape check / kcaptcha parser / update helper 추가
- `features/concept-monitor/recommend-cut-coordinator.js`
  - kcaptcha 상태 저장값 추가
  - `reconcileRecommendCutCoordinator()`에서 개념컷 성공 후 kcaptcha 연동 추가
  - patrol hold 만료 alarm 복귀 누락 버그 수정

이번 검증에서 추가로 발견되어 같이 수정한 버그:

- 기존 `handleConceptRecommendCutCoordinatorAlarm()`는 expired hold가 initialize 단계에서 먼저 `0`으로 정리되면 reconcile 없이 끝날 수 있었다
- 그 결과 remote 개념컷 `100` / kcaptcha `8`이 그대로 남을 수 있었다
- 현재는 해당 분기에서도 `reconcileRecommendCutCoordinator()`를 다시 호출하도록 수정했다

- 갤러리 변경 시 `resetConceptRecommendCutCoordinator()`가 concept cut은 이미 `14`가 적용된 것처럼(`lastRecommendCutApplySucceeded = true`) 남기고,
  kcaptcha만 unknown으로 남겨서 다음 reconcile에서 concept cut은 스킵되고 kcaptcha만 먼저 적용될 수 있었다
- 현재는 reset 이후 concept cut도 `lastRecommendCutApplySucceeded = false`로 남겨서,
  다음 reconcile에서 concept cut `14`와 kcaptcha `2`가 같이 확정 동기화되도록 수정했다

현재까지 끝낸 검증:

- `api.js`, `recommend-cut-coordinator.js` 문법 체크 통과
- synthetic HTML 기준 parser 정적 검증 통과
- coordinator 흐름 정적 검증 통과
- 실제 caller 경로(`concept-monitor`, `concept-patrol`, `background`) 재확인 완료

아직 남아 있는 실운영 확인:

- 실제 DC management 페이지 raw HTML과 parser 대조
- 실서버에서 1회 monitored run으로 실제 field 구조 확인

---

## 실제로 확인한 사실

### 1. 현재 개념컷 변경/재동기화 경로는 auto-cut 하나만 있는 게 아니다 (코드 검증 완료)

현재 `effectiveRecommendCut` 재계산과 remote sync 진입 경로는 최소 3갈래다.

1. concept monitor sync 경로

이 경로는 단순 auto-cut cycle만이 아니라 아래 caller들을 포함한다.

- `start()`
- `stop()`
- auto-cut cycle 완료 후
- service worker 복원 후 background 재동기화
- concept monitor `updateConfig`
- concept monitor `resetStats`

공통 흐름:

```
concept-monitor/scheduler.js:syncRecommendCutCoordinator()
    ↓
recommend-cut-coordinator.js:syncConceptMonitorRecommendCutState()
    ↓
recommend-cut-coordinator.js:reconcileRecommendCutCoordinator()
```

그중 auto-cut cycle은 이 상위 흐름으로 들어오는 한 caller일 뿐이다:

```
concept-monitor/scheduler.js:evaluateAutoCutState()
    ↓
concept-monitor/scheduler.js:runAutoCutCycleIfDue()
    ↓
concept-monitor/scheduler.js:syncRecommendCutCoordinator()
```

2. 개념글순회 patrol hold 트리거 경로

```
concept-patrol/scheduler.js:triggerConceptPatrolRecommendCutHold()
    ↓
recommend-cut-coordinator.js:triggerConceptPatrolRecommendCutHold()
    ↓
recommend-cut-coordinator.js:reconcileRecommendCutCoordinator()
```

3. patrol hold 만료 alarm 경로

```
background/background.js:onAlarm
    ↓
recommend-cut-coordinator.js:handleConceptRecommendCutCoordinatorAlarm()
    ↓
recommend-cut-coordinator.js:reconcileRecommendCutCoordinator()
```

즉 **kcaptcha 연동은 auto-cut 전용 분기나 patrol 전용 분기에 붙이면 안 되고, 반드시 `reconcileRecommendCutCoordinator()` 안에서 처리해야 한다.**

특히 빠뜨리기 쉬운 경로:

- `concept-monitor/scheduler.js:stop()`도 `syncRecommendCutCoordinator()`를 호출한다
- patrol hold는 시작뿐 아니라 **만료 alarm**에서도 해제 방향 reconcile이 돈다
- `resetStats`는 sync를 호출하지만, 상황에 따라 baseline guard 때문에 실제 remote write는 건너뛸 수 있다

검증 위치:
- `features/concept-monitor/scheduler.js#start()/stop()/runAutoCutCycleIfDue()`
- `features/concept-monitor/scheduler.js#syncRecommendCutCoordinator()`
- `features/concept-patrol/scheduler.js#triggerConceptPatrolRecommendCutHold()`
- `features/concept-monitor/recommend-cut-coordinator.js#syncConceptMonitorRecommendCutState()`
- `features/concept-monitor/recommend-cut-coordinator.js#triggerConceptPatrolRecommendCutHold()`
- `features/concept-monitor/recommend-cut-coordinator.js#handleConceptRecommendCutCoordinatorAlarm()`
- `features/concept-monitor/recommend-cut-coordinator.js#reconcileRecommendCutCoordinator()`
- `background/background.js#onAlarm/resumeAllSchedulers()`
- `background/background.js#handleMessage(updateConfig/resetStats)`

### 2. auto-cut 활성화 직후에는 baseline 확보 전까지 remote 값을 건드리지 않는다 (코드 검증 완료)

현재 `concept-monitor/scheduler.js`는 auto-cut이 켜져 있고 `lastRecommendSnapshot`이 비어 있으면,
`syncRecommendCutCoordinator()`에서 coordinator status만 읽고 실제 sync는 건너뛴다.

즉 실제 동작은:

- 개념글 방어 시작
- auto-cut ON
- 아직 첫 비교 전 baseline 없음
- **현재 개념컷을 유지**

이다.

이건 코드와 로그 메시지가 일치한다:

- `start()`에서 `resetAutoCutState('첫 비교 전까지 현재 개념컷 유지')`
- 이후 `syncRecommendCutCoordinator()`가 early return

따라서 kcaptcha도 이 예외를 그대로 따라야 한다.
즉 **auto-cut 켠 직후 바로 `recom_cnt=2` 또는 `8`로 밀어넣으면 현재 동작과 어긋난다.**

검증 위치:
- `features/concept-monitor/scheduler.js#start()`
- `features/concept-monitor/scheduler.js#syncRecommendCutCoordinator()`

### 3. reconcile 함수의 핵심 동작 (코드 검증 완료)

`reconcileRecommendCutCoordinator()` (L.151-197):

```javascript
const desiredRecommendCut = getConceptRecommendCutCoordinatorStatus().effectiveRecommendCut;
if (state.lastAppliedRecommendCut === desiredRecommendCut && state.lastRecommendCutApplySucceeded) {
  return; // 이미 적용됨 → 스킵
}
// → updateRecommendCut() 호출
```

**이 함수가 kcaptcha도 같이 호출해야 하는 삽입 지점이다.**

조건:

- `desiredRecommendCut !== state.lastAppliedRecommendCut` 이거나
- `state.lastRecommendCutApplySucceeded === false`

즉 **컷이 바뀌었을 때뿐 아니라, 같은 컷이라도 이전 apply가 실패했으면 재시도한다.**

### 4. 현재 kcaptcha 관련 구현은 없다 (검증 완료)

- `grep "kcaptcha" *.js` → 0건
- `grep "update_kcaptcha" *.js` → 0건
- `grep "recom_cnt" *.js` → 0건

즉 완전히 새로 구현해야 한다.

### 5. kcaptcha API 스펙 (스크린샷 + 개념코드SPEC.md 검증 완료)

엔드포인트:
```
POST https://gall.dcinside.com/ajax/managements_ajax/update_kcaptcha
```

Payload (전체 파라미터):
```
ci_t=<ci_c 쿠키값>
gallery_id=thesingularity
_GALLTYPE_=M
use_ips=0
write_cnt=3
comment_cnt=1
recom_cnt=2        ← 이것만 변경 (2 or 8)
use_write=1
use_comment=1
use_recom=1
use_recom_r=1
use_recom_n=1
```

Headers:
```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Origin: https://gall.dcinside.com
Referer: https://gall.dcinside.com/mgallery/management/gallery?id=thesingularity
```

성공 응답: HTTP 200 + Content-Length: 20 (JSON `{"result":"success"}` 추정)

스크린샷 검증:
- `media__1776292353589.png`: recom_cnt=2 (NORMAL) Payload 캡처
- `media__1776292371429.png`: recom_cnt=8 (DEFENDING) Payload 캡처
- `media__1776292340974.png`: 응답 Headers (200 OK)

### 6. API 호출 시 나머지 파라미터도 전부 보내야 한다

`update_kcaptcha`는 **모든 kcaptcha 설정을 한 번에 덮어쓰는 API**다.
`recom_cnt`만 보내면 나머지 값이 기본값으로 리셋될 수 있다.

따라서 **현재 설정을 먼저 읽어서, `recom_cnt`만 교체하고 나머지는 그대로 전달**해야 한다.

### 7. 현재 설정 파서는 "관리 페이지 kcaptcha 영역"에 고정되어야 한다

관리 페이지 HTML을 GET으로 가져와서 **kcaptcha 설정 영역 내부만** 파싱해야 한다.

URL:
```
GET https://gall.dcinside.com/mgallery/management/gallery?id=thesingularity
```

파싱 대상 (관리 페이지 kcaptcha 폼 내부):
- `input[name="use_ips"]` 또는 해당 checkbox/select
- `input[name="write_cnt"]`
- `input[name="comment_cnt"]`
- `input[name="recom_cnt"]`
- `input[name="use_write"]`
- `input[name="use_comment"]`
- `input[name="use_recom"]`
- `input[name="use_recom_r"]`
- `input[name="use_recom_n"]`

중요:

- repo 안의 기존 raw HTML(`docs/raw.md`, `docs/raw2.md`, `projects/dc_auto_bot/docs/개념글(추천수65).md`)에는
  `kcaptcha_use`, `comment_cnt` hidden input이 보이지만, 이건 **게시물 view 페이지** 자료다
- 여기서 보이는 `comment_cnt=32`, `36`, `47` 같은 값은 **현재 글 댓글 수**이지 kcaptcha 관리값이 아니다
- 따라서 `parseKcaptchaSettings()`가 단순히 문서 전체에서 `input[name="comment_cnt"]`를 전역 검색하면
  전혀 다른 값을 집을 위험이 있다

결론:

- `fetchManagementGalleryHTML()`는 **관리 페이지 shape 검증**이 필요하다
- `parseKcaptchaSettings()`는 **kcaptcha 폼/섹션을 먼저 좁힌 뒤 그 안에서만** 필드를 읽어야 한다

> ⚠️ 관리 페이지의 정확한 HTML 구조(input id/name/type)는 실제 페이지를 한 번 캡처해서 확인해야 한다.
> 현재 docs에는 kcaptcha 관련 관리 페이지 HTML 캡처가 없다.
> 즉 이 부분은 아직 "구현 전 필수 확인" 단계다.

### 8. 기존 API 패턴은 "고수준 sync helper"에서 재사용하면 된다 (코드 검증 완료)

`api.js`의 기존 패턴:
```javascript
// L.165-216: updateRecommendCut()
return withDcRequestLease({ feature: leaseFeature, kind: '...' }, async () => {
  const resolved = resolveConfig(config);
  const ciToken = await getCiToken(resolved.baseUrl);
  // ... body 구성, dcFetchWithRetry() 호출, parseJsonResponse()
});
```

정리:

- `syncKcaptchaRecomCnt()` 같은 **고수준 sync helper**는 이 lease 패턴을 그대로 재사용하면 된다
- 반대로 `fetchManagementGalleryHTML()` / `updateKcaptchaSettings()` 같은 **저수준 helper**는
  상위 helper 내부에서만 호출되도록 lease-less 내부 함수로 두는 편이 안전하다

### 9. coordinator 상태 구조 (코드 검증 완료)

`recommend-cut-coordinator.js` state (L.19-31):
```javascript
const state = {
  config: { galleryId, galleryType, baseUrl },
  conceptMonitorProducerEnabled: false,
  conceptMonitorAutoCutState: AUTO_CUT_STATE.NORMAL,
  patrolHoldUntilTs: 0,
  lastAppliedRecommendCut: NORMAL_RECOMMEND_CUT,    // 14 or 100
  lastRecommendCutApplySucceeded: true,
  lastCutChangedAt: '',
};
```

여기에 kcaptcha 관련 상태를 추가해야 한다.

### 10. 상수값 (코드 검증 완료)

```javascript
const NORMAL_RECOMMEND_CUT = 14;      // L.8
const DEFENDING_RECOMMEND_CUT = 100;  // L.9
```

새로 추가할 상수:

```javascript
const NORMAL_KCAPTCHA_RECOM_CNT = 2;
const DEFENDING_KCAPTCHA_RECOM_CNT = 8;
const UNKNOWN_KCAPTCHA_RECOM_CNT = 0; // 아직 동기화 안 됨
```

### 11. 현재 설계대로 "1회 읽고 영구 캐시"하면 stale overwrite 위험이 있다 (사전 논리 검증)

문서 초안은 `lastKcaptchaSettings`를 첫 호출 때 한 번 읽고, 이후 전환에서는 계속 재사용하는 방식이었다.
하지만 실제 운영에선 이 방식이 위험하다.

예시:

1. 확장이 한번 `use_comment=1`, `use_recom=1` 상태를 읽어 캐시함
2. 사용자가 나중에 DC 관리 페이지에서 `use_comment=0`으로 수동 변경함
3. 이후 DEFENDING/NORMAL 전환 발생
4. 확장이 예전 캐시를 그대로 POST
5. `recom_cnt`만 바꾸려던 의도와 달리 `use_comment=1`까지 되돌려버림

즉 `lastKcaptchaSettings`를 authoritative source처럼 다루면 안 된다.

정리:

- `lastKcaptchaSettings`는 있어도 **마지막으로 관측/적용한 스냅샷** 정도로만 써야 한다
- 실제 apply 직전엔 **관리 페이지를 fresh-read** 하는 쪽이 안전하다
- 개념컷 전환 빈도는 높지 않으므로, 이 추가 GET 비용은 감수할 만하다

### 12. 기존 recommend-cut도 remote drift 문제를 이미 갖고 있다 (범위 메모)

현재 coordinator는 `lastAppliedRecommendCut`를 로컬 state 기준으로만 관리하고,
서버의 현재 개념컷을 다시 읽는 read helper는 없다.

즉 사람이 관리 페이지에서 개념컷을 수동 변경하면,
확장이 다음 write를 하기 전까지는 로컬 상태와 서버 상태가 잠시 어긋날 수 있다.

이번 kcaptcha 설계는 이 기존 문제를 직접 해결하지는 않지만,
적어도 **kcaptcha 쪽까지 같은 stale-state 문제를 새로 늘리면 안 된다.**

### 13. `GET → parse → POST`는 한 번의 high-level request lease 안에서 묶는 게 안전하다 (사전 논리 검증)

현재 `withDcRequestLease()`는 "세션 전환 중 새 요청 차단 + in-flight lease drain" 용도이지,
요청 전체를 전역 mutex처럼 순차 실행해 주는 구조는 아니다.

즉 문서 초안처럼:

1. `fetchManagementGalleryHTML()`에서 lease 획득 후 GET
2. lease 해제
3. `updateKcaptchaSettings()`에서 다시 lease 획득 후 POST

로 나누면, **GET과 POST 사이 빈 구간**이 생긴다.

이 틈에서 실제로 문제 되는 건 **세션 전환 gap**이다.

- `withDcRequestLease()`는 세션 전환 중 새 요청 차단 / in-flight lease drain 용도다
- 하지만 GET helper에서 lease를 풀고, 나중에 POST helper에서 다시 잡으면
  그 사이엔 세션 전환이 시작될 수 있다

예시:

1. 확장이 관리 페이지를 GET해서 `use_comment=0`, `recom_cnt=2`를 읽음
2. lease 해제
3. 그 사이 세션 전환 진행
4. 다시 lease를 잡고 예전 스냅샷으로 POST

그래서 kcaptcha 쪽은 **"GET → parse → 필요 시 POST" 전체를 한 번의 high-level request lease 안에서 처리하는 helper**로 설계하는 편이 맞다.

정리:

- `fetchManagementGalleryHTML()` / `updateKcaptchaSettings()`를 각각 독립 public API로 둘 수는 있다
- 하지만 실제 `applyKcaptchaRecomCnt()` 구현은 **별도 상위 helper가 lease를 한 번만 잡고 전체를 감싸는 구조**가 더 안전하다
- 최소한 문서 예시처럼 GET helper와 POST helper가 각자 lease를 따로 잡는 형태를 그대로 구현하면 안 된다

### 14. 파싱 누락 시 `?? 기본값`으로 body를 채우면 안 된다 (사전 논리 검증)

문서 초안의 `updateKcaptchaSettings()` 예시는 아래처럼 기본값 fallback을 넣고 있었다.

```javascript
body.set('use_ips', String(settings.use_ips ?? 0));
body.set('write_cnt', String(settings.write_cnt ?? 3));
body.set('comment_cnt', String(settings.comment_cnt ?? 1));
```

이 방식은 위험하다.

예시:

1. 관리 페이지 HTML 구조가 살짝 바뀜
2. parser가 `use_comment`를 못 읽음
3. 코드가 조용히 `1` 같은 기본값으로 채워서 POST
4. 원래 서버 값과 상관없이 설정을 덮어씀

즉 이건 "값 보존"이 아니라 "파싱 실패를 숨기고 기본값으로 overwrite"가 된다.

정리:

- `updateKcaptchaSettings()`는 **모든 필수 필드가 이미 채워진 settings만 받는다**
- 필드 하나라도 없으면 POST하지 말고 즉시 실패해야 한다
- 기본값 fallback은 운영 로직에서 쓰면 안 된다

### 15. 기존 hold alarm handler에는 "expired hold 정리만 하고 reconcile은 안 도는" 버그가 있었다 (코드 검증 완료)

실제 코드 검증 중 추가로 확인한 사실:

1. `handleConceptRecommendCutCoordinatorAlarm()`는 시작 시 `initializeConceptRecommendCutCoordinator()`를 호출한다
2. 그런데 기존 `initialize...()`는 `patrolHoldUntilTs`가 이미 지난 상태면
   그 값을 `0`으로 바꾸고 alarm도 지워버린다
3. 그 다음 `handleConceptRecommendCutCoordinatorAlarm()`는 `state.patrolHoldUntilTs <= 0` 분기에서 그냥 return 한다
4. 결과적으로 **hold는 만료됐는데 remote 개념컷 100 / kcaptcha 8이 그대로 남을 수 있었다**

예:

- concept monitor는 꺼져 있음
- patrol hold 때문에 현재 remote는 100 / 8
- hold 만료 시각 도달
- alarm은 왔지만 initialize가 만료 hold를 먼저 0으로 정리
- handler는 reconcile 없이 종료

즉 이건 이번 kcaptcha 기능만의 문제가 아니라,
**기존 recommend-cut coordinator 자체의 hold expiry 복귀 누락 버그**였다.

그래서 구현 시 `handleConceptRecommendCutCoordinatorAlarm()`의
`state.patrolHoldUntilTs <= 0` 분기에서도 `reconcileRecommendCutCoordinator()`를 다시 호출하도록 같이 고쳐야 한다.

---

## 구현 계획

### 수정 파일 목록

| 파일 | 변경 내용 |
|------|----------|
| `features/concept-monitor/api.js` | management 페이지 GET/shape check + kcaptcha 파싱/update helper + high-level sync helper 추가 |
| `features/concept-monitor/recommend-cut-coordinator.js` | kcaptcha 상태 추가 + reconcile에서 연동 호출 |

이번 1차 범위:

- popup 표시 추가 없음
- concept monitor / concept patrol scheduler의 별도 runtime 필드 추가 없음
- 필요 상태는 coordinator status 내부에만 둔다

### Step 1: `api.js`에 low-level helper + high-level sync helper 추가

#### 1-1. `fetchManagementGalleryHTML(config)`

관리 페이지 HTML을 GET으로 가져오는 **low-level helper**다.
여기서는 lease를 잡지 않고, 상위 sync helper가 한 번만 lease를 잡아 전체를 감싼다.

```javascript
async function fetchManagementGalleryHTML(config = {}) {
  const resolved = resolveConfig(config);
  const url = new URL('/mgallery/management/gallery', resolved.baseUrl);
  url.searchParams.set('id', resolved.galleryId);

  const response = await dcFetchWithRetry(url.toString());
  const html = await response.text();
  assertValidHtmlResponse(response, html, {
    label: '관리 페이지',
    shapeCheck: looksLikeManagementGalleryHtml, // 실제 캡처 후 마커 확정
  });

  return html;
}
```

#### 1-2. `parseKcaptchaSettings(html)`

관리 페이지 HTML에서 kcaptcha 폼 값을 파싱한다.

```javascript
function parseKcaptchaSettings(html) {
  const text = String(html || '');

  // 중요: 전체 문서 전역 검색이 아니라 kcaptcha 설정 섹션 내부만 파싱해야 한다.
  const kcaptchaSectionHtml = extractKcaptchaSectionHtml(text);
  if (!kcaptchaSectionHtml) {
    throw new Error('kcaptcha 설정 영역을 찾지 못했습니다.');
  }

  return {
    use_ips: parseFieldValue(kcaptchaSectionHtml, 'use_ips'),
    write_cnt: parseFieldValue(kcaptchaSectionHtml, 'write_cnt'),
    comment_cnt: parseFieldValue(kcaptchaSectionHtml, 'comment_cnt'),
    recom_cnt: parseFieldValue(kcaptchaSectionHtml, 'recom_cnt'),
    use_write: parseFieldValue(kcaptchaSectionHtml, 'use_write'),
    use_comment: parseFieldValue(kcaptchaSectionHtml, 'use_comment'),
    use_recom: parseFieldValue(kcaptchaSectionHtml, 'use_recom'),
    use_recom_r: parseFieldValue(kcaptchaSectionHtml, 'use_recom_r'),
    use_recom_n: parseFieldValue(kcaptchaSectionHtml, 'use_recom_n'),
  };
}
```

보조 helper도 필요하다:

```javascript
function looksLikeManagementGalleryHtml(htmlText) {}
function extractKcaptchaSectionHtml(htmlText) {}
function parseFieldValue(sectionHtml, fieldName) {}
function assertCompleteKcaptchaSettings(settings) {}
```

> 참고: 구현은 이미 들어갔지만, repo 안에는 여전히 실제 management 페이지 raw HTML이 없다.
> 현재 파서는 `update_kcaptcha` anchor + form/field score 기반으로 방어적으로 작성했고,
> 실페이지 구조가 다르면 fail-fast 하도록 되어 있다.
> 즉 잘못된 값을 조용히 덮어쓰기보다, 파싱 실패로 멈추는 쪽을 우선한 상태다.

#### 1-3. `updateKcaptchaSettings(config, settings)`

kcaptcha 설정을 POST하는 **low-level helper**다.
여기서도 lease를 새로 잡지 않고, 받은 `settings`가 완전한지 먼저 검증한다.

```javascript
async function updateKcaptchaSettings(config = {}, settings = {}) {
  const resolved = resolveConfig(config);
  const ciToken = await getCiToken(resolved.baseUrl);

  if (!ciToken) {
    return {
      success: false,
      status: 0,
      result: '',
      rawText: '',
      rawSummary: 'ci_t 토큰(ci_c 쿠키)을 찾지 못했습니다.',
    };
  }

  assertCompleteKcaptchaSettings(settings);

  const body = new URLSearchParams();
  body.set('ci_t', ciToken);
  body.set('gallery_id', resolved.galleryId);
  body.set('_GALLTYPE_', resolved.galleryType);
  body.set('use_ips', String(settings.use_ips));
  body.set('write_cnt', String(settings.write_cnt));
  body.set('comment_cnt', String(settings.comment_cnt));
  body.set('recom_cnt', String(settings.recom_cnt));
  body.set('use_write', String(settings.use_write));
  body.set('use_comment', String(settings.use_comment));
  body.set('use_recom', String(settings.use_recom));
  body.set('use_recom_r', String(settings.use_recom_r));
  body.set('use_recom_n', String(settings.use_recom_n));

  const response = await dcFetchWithRetry(
    `${resolved.baseUrl}/ajax/managements_ajax/update_kcaptcha`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': resolved.baseUrl,
        'Referer': `${resolved.baseUrl}/mgallery/management/gallery?id=${encodeURIComponent(resolved.galleryId)}`,
      },
      body: body.toString(),
    },
    1,
  );

  const rawText = await response.text();
  const parsed = parseJsonResponse(rawText);
  const result = String(parsed?.result || '').trim();

  return {
    success: response.status === 200 && result === 'success',
    status: response.status,
    result,
    rawText,
    rawSummary: summarizeResponseText(rawText),
  };
}
```

#### 1-4. `syncKcaptchaRecomCnt(config, desiredRecomCnt)`

실제 운영에 쓰는 **high-level helper**다.
한 번의 lease 안에서 `GET → parse → 필요 시 POST`를 전부 처리한다.

```javascript
async function syncKcaptchaRecomCnt(config = {}, desiredRecomCnt, leaseFeature = 'conceptRecommendCut') {
  return withDcRequestLease({ feature: leaseFeature, kind: 'syncKcaptchaRecomCnt' }, async () => {
    const html = await fetchManagementGalleryHTML(config);
    const currentSettings = parseKcaptchaSettings(html);
    assertCompleteKcaptchaSettings(currentSettings);

    if (Number(currentSettings.recom_cnt) === Number(desiredRecomCnt)) {
      return {
        success: true,
        skipped: true,
        currentSettings,
        appliedSettings: currentSettings,
      };
    }

    const nextSettings = {
      ...currentSettings,
      recom_cnt: desiredRecomCnt,
    };

    const updateResult = await updateKcaptchaSettings(config, nextSettings);
    return {
      ...updateResult,
      skipped: false,
      currentSettings,
      appliedSettings: nextSettings,
    };
  });
}
```

export는 최소화한다:
```javascript
export {
  // 기존...
  syncKcaptchaRecomCnt,
};
```

`fetchManagementGalleryHTML()` / `parseKcaptchaSettings()` / `updateKcaptchaSettings()`는
현재 범위에선 `api.js` 내부 helper로만 유지하는 편이 낫다.
이렇게 해야 나중에 다른 모듈이 lease-less 저수준 helper를 직접 호출하는 실수를 줄일 수 있다.

### Step 2: `recommend-cut-coordinator.js` 수정

#### 2-1. import 추가

```javascript
import {
  DEFAULT_CONFIG,
  updateRecommendCut,
  syncKcaptchaRecomCnt,          // 새로 추가
} from './api.js';
```

#### 2-2. 상수 추가

```javascript
const NORMAL_KCAPTCHA_RECOM_CNT = 2;
const DEFENDING_KCAPTCHA_RECOM_CNT = 8;
const UNKNOWN_KCAPTCHA_RECOM_CNT = 0;
```

#### 2-3. state에 kcaptcha 상태 추가

```javascript
const state = {
  // 기존 필드 유지...
  config: { ... },
  conceptMonitorProducerEnabled: false,
  conceptMonitorAutoCutState: AUTO_CUT_STATE.NORMAL,
  patrolHoldUntilTs: 0,
  lastAppliedRecommendCut: NORMAL_RECOMMEND_CUT,
  lastRecommendCutApplySucceeded: true,
  lastCutChangedAt: '',

  // 새로 추가
  lastAppliedKcaptchaRecomCnt: UNKNOWN_KCAPTCHA_RECOM_CNT,
  lastKcaptchaApplySucceeded: false,
  lastKcaptchaSettings: null,   // 마지막으로 관측/적용한 스냅샷 (authoritative source 아님)
};
```

#### 2-4. `reconcileRecommendCutCoordinator()` 수정

핵심 변경: 개념컷 변경 성공 후 kcaptcha도 변경

중요:

- **기존 함수 맨 앞의 early return을 그대로 두면 안 된다**
- 현재 구현은 `lastAppliedRecommendCut === desiredRecommendCut && lastRecommendCutApplySucceeded`면 즉시 return 한다
- 그런데 kcaptcha는 `개념컷은 같지만 아직 unknown`, `이전 kcaptcha apply 실패`, `사람이 밖에서 수동 변경` 같은 경우에도 다시 확인해야 한다
- 따라서 새 구현은 함수 초반 unconditional return을 제거하고,
  `개념컷 변경 branch`와 `kcaptcha 동기화 branch`를 각각 따로 판단해야 한다

```javascript
async function reconcileRecommendCutCoordinator() {
  await initializeConceptRecommendCutCoordinator();
  const task = async () => {
    const desiredRecommendCut = getConceptRecommendCutCoordinatorStatus().effectiveRecommendCut;
    const desiredKcaptchaRecomCnt = desiredRecommendCut === DEFENDING_RECOMMEND_CUT
      ? DEFENDING_KCAPTCHA_RECOM_CNT
      : NORMAL_KCAPTCHA_RECOM_CNT;

    // 1. 개념컷 변경 (기존 로직 유지)
    if (state.lastAppliedRecommendCut !== desiredRecommendCut || !state.lastRecommendCutApplySucceeded) {
      let updateResult = null;
      try {
        updateResult = await updateRecommendCut(state.config, desiredRecommendCut);
      } catch (_error) {
        state.lastRecommendCutApplySucceeded = false;
        await saveState();
        return getConceptRecommendCutCoordinatorStatus();
      }

      if (updateResult.success) {
        state.lastAppliedRecommendCut = desiredRecommendCut;
        state.lastRecommendCutApplySucceeded = true;
        state.lastCutChangedAt = new Date().toISOString();
        await saveState();
      } else {
        state.lastRecommendCutApplySucceeded = false;
        await saveState();
        return getConceptRecommendCutCoordinatorStatus();
      }
    }

    // 2. kcaptcha recom_cnt 동기화 (새 로직)
    if (state.lastAppliedKcaptchaRecomCnt !== desiredKcaptchaRecomCnt || !state.lastKcaptchaApplySucceeded) {
      try {
        await applyKcaptchaRecomCnt(desiredKcaptchaRecomCnt);
      } catch (_error) {
        // kcaptcha 실패는 로그만 남기고 진행 (보조 기능)
        console.error('[RecommendCutCoordinator] kcaptcha recom_cnt 변경 실패:', _error.message);
        state.lastKcaptchaApplySucceeded = false;
        await saveState();
      }
    }

    return getConceptRecommendCutCoordinatorStatus();
  };

  // 기존 직렬화 로직 유지 (reconcilePromise 체인)
  // ...
}
```

#### 2-4-a. `handleConceptRecommendCutCoordinatorAlarm()`도 같이 보정

기존 버그 때문에 아래 early return 분기도 그대로 두면 안 된다.

```diff
 async function handleConceptRecommendCutCoordinatorAlarm(alarmName) {
   if (alarmName !== HOLD_ALARM_NAME) {
     return false;
   }
 
   await initializeConceptRecommendCutCoordinator();
   if (state.patrolHoldUntilTs <= 0) {
-    return true;
+    await reconcileRecommendCutCoordinator();
+    return true;
   }
   // ...
 }
```

이유:

- initialize 단계에서 이미 expired hold가 0으로 정리될 수 있다
- 그래도 이 alarm은 "hold expiry 관련 alarm"이므로
  **현재 desired 상태와 remote applied 상태를 한 번 더 reconcile해야** 복귀 누락이 없다

#### 2-5. 새 helper 함수 `applyKcaptchaRecomCnt()`

```javascript
async function applyKcaptchaRecomCnt(desiredRecomCnt) {
  const result = await syncKcaptchaRecomCnt(state.config, desiredRecomCnt);

  if (result.success) {
    state.lastAppliedKcaptchaRecomCnt = desiredRecomCnt;
    state.lastKcaptchaApplySucceeded = true;
    state.lastKcaptchaSettings = result.appliedSettings || null;
    await saveState();
  } else {
    state.lastKcaptchaApplySucceeded = false;
    await saveState();
    throw new Error(`kcaptcha update 실패: ${result.rawSummary}`);
  }
}
```

#### 2-6. saveState / loadState / reset 반영

**saveState (L.199-211)**: kcaptcha 필드 추가

```diff
 await chrome.storage.local.set({
   [STORAGE_KEY]: {
     config: state.config,
     conceptMonitorProducerEnabled: state.conceptMonitorProducerEnabled,
     conceptMonitorAutoCutState: state.conceptMonitorAutoCutState,
     patrolHoldUntilTs: state.patrolHoldUntilTs,
     lastAppliedRecommendCut: state.lastAppliedRecommendCut,
     lastRecommendCutApplySucceeded: state.lastRecommendCutApplySucceeded,
     lastCutChangedAt: state.lastCutChangedAt,
+    lastAppliedKcaptchaRecomCnt: state.lastAppliedKcaptchaRecomCnt,
+    lastKcaptchaApplySucceeded: state.lastKcaptchaApplySucceeded,
+    lastKcaptchaSettings: state.lastKcaptchaSettings,
   },
 });
```

**initializeConceptRecommendCutCoordinator() (L.33-71)**: 복원 시 kcaptcha 필드 로드

```diff
 if (savedState) {
   // ...기존 복원...
+  state.lastAppliedKcaptchaRecomCnt = normalizeStoredKcaptchaRecomCnt(savedState.lastAppliedKcaptchaRecomCnt);
+  state.lastKcaptchaApplySucceeded = savedState.lastKcaptchaApplySucceeded === true;
+  state.lastKcaptchaSettings = savedState.lastKcaptchaSettings || null;
 }
```

**resetConceptRecommendCutCoordinator() (L.115-127)**: 초기화 시 kcaptcha 필드 리셋

```diff
+  state.lastAppliedKcaptchaRecomCnt = UNKNOWN_KCAPTCHA_RECOM_CNT;
+  state.lastKcaptchaApplySucceeded = false;
+  state.lastKcaptchaSettings = null;
```

#### 2-7. getConceptRecommendCutCoordinatorStatus() 에 kcaptcha 상태 노출

```diff
 return {
   // ...기존...
+  lastAppliedKcaptchaRecomCnt: state.lastAppliedKcaptchaRecomCnt,
+  lastKcaptchaApplySucceeded: state.lastKcaptchaApplySucceeded,
 };
```

#### 2-8. normalizeStoredKcaptchaRecomCnt() 추가

```javascript
function normalizeStoredKcaptchaRecomCnt(value) {
  if (Number(value) === NORMAL_KCAPTCHA_RECOM_CNT) {
    return NORMAL_KCAPTCHA_RECOM_CNT;
  }

  return Number(value) === DEFENDING_KCAPTCHA_RECOM_CNT
    ? DEFENDING_KCAPTCHA_RECOM_CNT
    : UNKNOWN_KCAPTCHA_RECOM_CNT;
}
```

#### 2-9. export는 현 단계에선 추가하지 않는다

이 상수들은 현재 coordinator 내부 전용이면 충분하다.
외부 모듈이 직접 참조하지 않으므로 export 범위를 불필요하게 넓히지 않는 편이 낫다.

---

## 호출 체인 전체 (수정 후)

### auto-cut 경로

```
scheduler.js:evaluateAutoCutState()
    ↓ DEFENDING or NORMAL 판정
scheduler.js:syncRecommendCutCoordinator()
    ↓
coordinator.js:syncConceptMonitorRecommendCutState()
    ↓
coordinator.js:reconcileRecommendCutCoordinator()
    ↓
    ├── api.js:updateRecommendCut()          → 개념컷 변경 (14 ↔ 100)
    │
    └── coordinator.js:applyKcaptchaRecomCnt()
         └── api.js:syncKcaptchaRecomCnt()
              ├── request lease 1회 획득
              ├── api.js:fetchManagementGalleryHTML()  → 현재 kcaptcha 설정 fresh-read
              ├── api.js:parseKcaptchaSettings()       → kcaptcha 섹션만 파싱
              ├── api.js:assertCompleteKcaptchaSettings()
              ├── 현재 recom_cnt가 이미 desired면 POST 생략
              └── api.js:updateKcaptchaSettings()      → recom_cnt만 교체 후 POST
```

### patrol hold 경로

```
concept-patrol/scheduler.js:triggerConceptPatrolRecommendCutHold()
    ↓
recommend-cut-coordinator.js:triggerConceptPatrolRecommendCutHold()
    ↓
recommend-cut-coordinator.js:reconcileRecommendCutCoordinator()
    ↓
    ├── updateRecommendCut()
    └── applyKcaptchaRecomCnt()
```

### background 복원/설정 저장 경로

- service worker 복원 후 `background.js`가 `conceptMonitor.syncRecommendCutCoordinator()`를 다시 호출
- concept monitor `updateConfig`, `resetStats` 후에도 같은 sync 경로를 탄다
- 단, `resetStats`가 `lastRecommendSnapshot = []`를 비운 직후 `isRunning && autoCutEnabled` 상태면
  기존 baseline guard 때문에 여기서는 실제 remote write가 바로 일어나지 않을 수 있다

### concept monitor stop 경로

```
concept-monitor/scheduler.js:stop()
    ↓
concept-monitor/scheduler.js:syncRecommendCutCoordinator()
    ↓
recommend-cut-coordinator.js:syncConceptMonitorRecommendCutState()
    ↓
recommend-cut-coordinator.js:reconcileRecommendCutCoordinator()
```

예:

- auto-cut이 DEFENDING이라 개념컷 100 / kcaptcha 8 상태
- patrol hold 없음
- 사용자가 concept monitor를 stop

이 경우엔 공용 coordinator 기준 desired가 NORMAL로 바뀌므로,
**개념컷 14 / recom_cnt 2 복귀 경로도 구현에 포함되어야 한다.**

### patrol hold 만료 alarm 경로

```
background.js:onAlarm
    ↓
recommend-cut-coordinator.js:handleConceptRecommendCutCoordinatorAlarm()
    ↓
recommend-cut-coordinator.js:reconcileRecommendCutCoordinator()
```

즉 patrol hold는 "감지 시 100으로 올리는 경로"만 있는 게 아니라,
**시간 만료 후 다시 내리는 경로**도 coordinator 내부에 이미 존재한다.

주의:

- 기존 구현은 initialize가 만료 hold를 먼저 0으로 정리하면 handler가 reconcile 없이 끝나는 버그가 있었다
- 이번 패치에선 `state.patrolHoldUntilTs <= 0` 분기에서도 reconcile을 한 번 더 돌려 이 구멍을 막는다

---

## 주요 설계 결정

### 1. kcaptcha 실패는 개념컷 전환을 막지 않는다

kcaptcha 변경은 **보조 기능**이다.
개념컷 변경(14↔100)이 성공하면 그 자체로 방어는 작동한다.
kcaptcha 변경 실패 시 개념컷 상태는 유지하고, 다음 reconcile에서 재시도한다.

### 2. 관리 페이지 GET은 kcaptcha apply 직전에 매번 fresh-read 한다

이번 기능의 위험은 "GET이 하나 더 늘어나는 것"보다 "예전 캐시로 다른 설정까지 덮어쓰는 것"이 더 크다.
그래서 `lastKcaptchaSettings`는 참고 스냅샷만 저장하고,
실제 apply 직전엔 항상 관리 페이지를 다시 읽는다.

장점:

- 사용자가 수동으로 바꾼 `use_comment`, `use_recom` 등을 덜 덮어쓴다
- service worker 재시작 후에도 stale cache 의존이 줄어든다
- fresh-read 결과 이미 `recom_cnt`가 원하는 값이면 POST를 생략할 수 있다

### 3. baseline 전 early return은 그대로 유지한다

현재 auto-cut은 baseline이 없을 때 remote 개념컷을 건드리지 않는다.
kcaptcha도 같은 guard 아래 있어야 한다.

예:

- 개념글 방어 시작 직후
- auto-cut ON
- 아직 첫 비교 전

이 상태에선 **개념컷도 kcaptcha도 둘 다 건드리지 않는다.**

### 4. resetConceptRecommendCutCoordinator 시 kcaptcha 상태는 "unknown"으로 초기화

갤러리 변경, 전체 리셋 시:

- `lastAppliedRecommendCut = 14`
- `lastRecommendCutApplySucceeded = false`
- `lastAppliedKcaptchaRecomCnt = UNKNOWN_KCAPTCHA_RECOM_CNT`
- `lastKcaptchaApplySucceeded = false`
- `lastKcaptchaSettings = null`

로 두는 편이 안전하다.

이유:

- concept cut도 새 갤 remote 상태를 실제로는 모르는 상태이므로, 다음 reconcile에서 한 번은 `14`를 다시 확정 적용하는 편이 안전하다
- 리셋 직후 서버 상태를 모르는 걸 `2`로 단정하면 drift를 숨긴다
- unknown 상태로 남겨 두면 다음 유효 reconcile 때 fresh-read 후 정확히 판단할 수 있다

### 5. kcaptcha sync는 single high-level lease로 처리한다

`fetchManagementGalleryHTML()`와 `updateKcaptchaSettings()`가 각각 lease를 따로 잡는 구조는 피한다.
실제 운영 경로는 `syncKcaptchaRecomCnt()`가 lease를 한 번 잡고 끝까지 처리한다.

예:

1. lease 획득
2. 관리 페이지 GET
3. kcaptcha 섹션 파싱 + 필수 필드 검증
4. 필요 시 POST
5. lease 해제

### 6. 필수 필드 누락 시 fail-fast 한다

`comment_cnt`, `use_comment` 같은 값이 하나라도 파싱되지 않으면
기본값으로 채워 넣지 말고 즉시 실패해야 한다.

예:

- 잘못된 방식: `settings.use_comment ?? 1`
- 맞는 방식: `use_comment`가 없으면 에러 발생 후 POST 중단

### 7. export surface는 최소화한다

현재 coordinator가 실제로 필요한 건 `syncKcaptchaRecomCnt()` 하나다.
저수준 helper까지 export해 두면 나중에 다른 모듈이 request lease 없이 직접 호출할 위험이 생긴다.

그래서 이번 범위에선:

- export: `syncKcaptchaRecomCnt()`
- 내부 helper: `fetchManagementGalleryHTML()`, `parseKcaptchaSettings()`, `updateKcaptchaSettings()`

구조가 더 안전하다.

---

## 실운영 전 추가 확인 사항

### ⚠️ 관리 페이지 HTML 구조 캡처 필요

현재 docs에는 kcaptcha 설정 영역의 실제 management page raw HTML이 없다.

구현은 완료됐지만, 운영 안정성 확인을 위해 아래를 추가로 해야 한다:

1. `https://gall.dcinside.com/mgallery/management/gallery?id=thesingularity` 접속
2. kcaptcha 설정 영역의 HTML을 캡처
3. 각 input의 `name`, `id`, `type` (checkbox/radio/select/number) 확인
4. 현재 `parseKcaptchaSettings()` 로직이 실구조와 정확히 맞는지 대조
5. 첫 운영 시도에서는 console 로그와 네트워크 payload를 같이 확인

**대안**: 만약 관리 페이지 HTML 파싱이 아직 불안정하더라도, 운영 기본값 하드코딩은 권장하지 않는다.

이 방식은:

- 관리 페이지에서 사람이 바꾼 값
- 갤마다 다른 kcaptcha 운영값

을 전부 덮어쓸 수 있기 때문이다.

정말 임시 테스트용 fallback이 필요하면 아래 값을 쓸 수는 있지만, **운영 기본 설계로 채택하면 안 된다**:

- 기존 값을 **고정 기본값**으로 하드코딩 (스펙에서 확인된 값 사용)
  ```javascript
  const KCAPTCHA_DEFAULTS = {
    use_ips: 0,
    write_cnt: 3,
    comment_cnt: 1,
    recom_cnt: 2,     // 이것만 변경
    use_write: 1,
    use_comment: 1,
    use_recom: 1,
    use_recom_r: 1,
    use_recom_n: 1,
  };
  ```
- 이 경우 관리 페이지 GET이 필요 없어져서 구현은 단순해진다
- 하지만 사용자가 관리 페이지에서 다른 값을 수동으로 바꾸면 그대로 덮어써진다
- 따라서 이 fallback은 raw 캡처 전 임시 디버깅용 정도로만 제한한다

---

## 검증 체크리스트

### 이번 패치에서 정적 검증으로 완료한 항목

1. [x] `syncKcaptchaRecomCnt()`가 GET→parse→POST 전체를 한 번의 request lease 안에서 처리하는지 확인
2. [x] 전역 `input[name="comment_cnt"]` 탐색 같은 잘못된 파서가 섞이지 않았는지 확인
3. [x] 필수 필드 하나라도 누락되면 기본값으로 채우지 않고 POST를 중단하는지 확인
4. [x] 개념컷 변경 실패 시 kcaptcha도 시도하지 않음
5. [x] fresh-read 결과 현재 `recom_cnt`가 이미 desired면 POST를 생략하는지 확인
6. [x] resetConceptRecommendCutCoordinator 호출 시 kcaptcha 상태가 unknown으로 초기화되는지
7. [x] patrol hold 만료 alarm 경로에서도 reconcile이 다시 도는지 확인
8. [x] expired hold가 initialize 단계에서 먼저 0으로 정리되는 케이스에서도 remote 복귀 경로가 호출되는지 확인
9. [x] background 복원 / conceptMonitor updateConfig / resetStats 경로 caller 재검증

### 아직 실운영 확인이 필요한 항목

### 기능 검증

1. [ ] NORMAL → DEFENDING 전환 시 개념컷 100 + recom_cnt 8 동시 적용
2. [ ] DEFENDING → NORMAL 전환 시 개념컷 14 + recom_cnt 2 동시 적용
3. [ ] 개념컷 변경 성공 + kcaptcha 실패 시 다음 cycle에서 kcaptcha 재시도
4. [ ] 관리 페이지에서 kcaptcha 값을 정확히 파싱하는지 확인
5. [ ] recom_cnt 외 나머지 파라미터가 변경되지 않는지 확인

### 상태 관리 검증

6. [ ] service worker 재시작 후 kcaptcha 상태가 올바르게 복원되는지
7. [ ] patrol hold에 의한 컷 변경에서도 kcaptcha 연동이 작동하는지
8. [ ] auto-cut ON 직후 baseline 전에는 kcaptcha를 건드리지 않는지
9. [ ] concept monitor `stop()` 경로에서 100→14 복귀 시 kcaptcha도 8→2로 같이 복귀하는지

### 에지 케이스

10. [ ] kcaptcha API가 403/429 반환 시 개념컷 방어는 정상 동작
11. [ ] ci_c 쿠키 없을 때 graceful 실패
12. [ ] 관리 페이지 HTML 구조 변경 시 파싱 실패 → 로그 남기고 진행
13. [ ] 사용자가 관리 페이지에서 수동 변경한 값이 stale cache 때문에 덮어써지지 않는지 확인
14. [ ] `resetStats` 직후 baseline guard 때문에 immediate no-op가 나는 케이스를 의도대로 받아들이는지 확인

---

## 구현 순서

1. 관리 페이지 HTML 캡처 및 kcaptcha 폼 구조 확인
2. `api.js` 내부 helper로 `fetchManagementGalleryHTML()` + `looksLikeManagementGalleryHtml()` + `extractKcaptchaSectionHtml()` + `parseKcaptchaSettings()` + `assertCompleteKcaptchaSettings()` + `updateKcaptchaSettings()` 추가
3. `api.js` export 대상으로 single-lease high-level helper `syncKcaptchaRecomCnt()` 추가
4. `recommend-cut-coordinator.js`에 상수/상태/applyKcaptchaRecomCnt 추가
5. `reconcileRecommendCutCoordinator()`에서 개념컷 성공 후 kcaptcha 동기화 연결
6. `handleConceptRecommendCutCoordinatorAlarm()`의 expired hold early return 버그도 같이 수정
7. reset/load/save/status를 unknown/fresh-read 정책에 맞게 수정
8. 검증: auto-cut baseline 전 no-op / patrol hold / hold expiry alarm / concept monitor stop / NORMAL→DEFENDING→NORMAL / background 복원 경로 / 필수 필드 누락 fail-fast 확인
