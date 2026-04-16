# kcaptcha recom_cnt 검증 완료 구현 문서

> 작성일: 2026-04-16
> 상태: 검증 완료 / 현재 코드 반영 기준 문서
> 성격: 계획 문서가 아니라, 지금 바로 이어서 작업하거나 점검할 수 있는 운영 기준 문서
> 참고: 기존 `kcaptcha_recom_cnt_auto_adjust_plan.md`는 설계 초안이고, 이 문서가 현재 기준의 우선 문서다.

## 1. 한 줄 결론

`update_kcaptcha`는 `recom_cnt`만 바꾸는 전용 API가 아니다.
실제로는 **도배 방지 코드 설정 전체 저장 API**라서, `recom_cnt`만 바꾸고 싶어도 현재 `write_cnt`, `comment_cnt`, `use_write`, `use_comment`, `use_recom` 같은 값도 같이 보내야 한다.

쉬운 예시:

- 바꾸고 싶은 값: `recom_cnt = 2 -> 8`
- 서버가 같이 요구하는 값: `write_cnt=3`, `comment_cnt=1`, `use_write=1`, `use_comment=1`, `use_recom=1` ...

즉 실제 구현 흐름은 아래가 맞다.

1. 관리 페이지 GET
2. kcaptcha 설정 박스만 파싱
3. `recom_cnt`만 원하는 값으로 교체
4. 전체 kcaptcha payload POST

---

## 2. 오늘 교차검증한 근거

이 문서는 아래 4가지를 서로 대조해서 작성했다.

1. 실제 캡처 스펙
   - `docs/개념코드SPEC.md:1-18`
   - 실제 POST payload 예시가 들어 있다.
2. 관리 페이지 HTML 샘플
   - `docs/html.md:780-955`
   - kcaptcha UI 구조와 `name` 값이 들어 있다.
3. 실서비스 JS
   - 2026-04-16에 아래 명령으로 확인:

```bash
curl -L 'https://gall.dcinside.com/_js/managements.js?v=260415' | nl -ba | sed -n '1610,1668p'
```

   - 여기서 실제 `update_kcaptcha()`가 어떤 필드를 읽고 어떤 이름으로 POST하는지 확인했다.
4. 현재 repo 코드
   - `features/concept-monitor/api.js`
   - `features/concept-monitor/recommend-cut-coordinator.js`
   - `features/concept-monitor/scheduler.js`
   - `features/concept-patrol/scheduler.js`
   - `background/background.js`
   - `features/concept-monitor/kcaptcha-partial-probe.js`

---

## 3. 실제로 확정된 사실

### 3-1. partial POST는 실패한다

이미 실험 응답으로 아래가 확인됐다.

- `write_cnt` 필수
- `comment_cnt` 필수
- `use_ips` 필수
- `use_write` 필수
- `use_comment` 필수
- `use_recom` 필수

즉 `recom_cnt`만 보내는 요청은 실패한다.

쉬운 예시:

- 틀린 방식: `{ recom_cnt: 8 }`
- 맞는 방식: `{ use_ips, write_cnt, comment_cnt, recom_cnt, use_write, use_comment, use_recom, use_recom_r, use_recom_n }`

이 결론은 `features/concept-monitor/kcaptcha-partial-probe.js:31-53` 구조와, 실제 실패 응답이 서로 일치한다.

### 3-2. 관리 페이지의 필드 이름과 서버 POST 필드 이름은 다르다

이 부분이 가장 중요하다.

관리 페이지 HTML은 화면용 이름을 쓰고, 서버는 API용 이름을 받는다.

예시:

- 화면 HTML: `name="recom_kcaptcha_cnt"`
- 서버 POST: `recom_cnt`

실서비스 JS `update_kcaptcha()`는 정확히 이 번역을 수행한다.
확인 근거:

- live `managements.js` 1616-1642행
- `docs/html.md:815-946`

매핑 표:

| 화면에서 읽는 값 | 실서비스 JS가 읽는 이름 | 서버로 보내는 이름 |
|---|---|---|
| 전체/특정 IP | `use_ips` | `use_ips` |
| 글쓰기 자리수 | `write_kcaptcha_cnt` | `write_cnt` |
| 댓글쓰기 자리수 | `comment_kcaptcha_cnt` | `comment_cnt` |
| 개념글 추천 자리수 | `recom_kcaptcha_cnt` | `recom_cnt` |
| 글쓰기 사용 여부 | `use_write_kcaptcha` | `use_write` |
| 댓글쓰기 사용 여부 | `use_comment_kcaptcha` | `use_comment` |
| 개념글 추천 사용 여부 | `use_recom_kcaptcha` | `use_recom` |
| 추천 체크박스 | `chk_recom_use` | `use_recom_r` |
| 비추천 체크박스 | `chk_non_recom_use` | `use_recom_n` |

실서비스 JS 근거:

- `write_kcaptcha_cnt -> write_cnt`: live `managements.js` 1617, 1640행
- `comment_kcaptcha_cnt -> comment_cnt`: 1618, 1640행
- `recom_kcaptcha_cnt -> recom_cnt`: 1619, 1640행
- `use_write_kcaptcha -> use_write`: 1620, 1641행
- `use_comment_kcaptcha -> use_comment`: 1621, 1641행
- `use_recom_kcaptcha -> use_recom`: 1622, 1641행
- `chk_recom_use -> use_recom_r`: 1623, 1642행
- `chk_non_recom_use -> use_recom_n`: 1624, 1642행

### 3-3. 파서는 kcaptcha 박스만 파싱해야 한다

문서 전체를 전역 검색하면 잘못된 값을 집을 수 있다.

대표적인 함정 2개:

1. `docs/html.md:988`
   - 개념 추천 설정 박스의 `input name="recom_cnt"` 값은 `100`이다.
   - 이건 kcaptcha 추천 자리수가 아니라, 개념글 선정 추천수다.
2. 게시물 view HTML의 `comment_cnt`
   - 댓글 개수 hidden input일 수 있다.
   - kcaptcha 댓글 자리수와 전혀 다른 의미다.

반대로 kcaptcha 박스는 `docs/html.md:780-955`다.

즉 파싱 범위는 반드시 이 박스여야 한다.

쉬운 예시:

- 잡아야 하는 값: `docs/html.md:924`의 `recom_kcaptcha_cnt = 2`
- 잡으면 안 되는 값: `docs/html.md:988`의 `recom_cnt = 100`

### 3-4. GET과 POST는 한 번의 high-level lease 안에서 처리하는 편이 맞다

이유는 단순하다.

- GET만 lease
- lease 해제
- 나중에 POST에서 다시 lease

이렇게 나누면 사이에 세션 전환이나 상태 변화가 끼어들 수 있다.

그래서 실제 운영 helper는 아래처럼 한 번에 감싸는 구조가 맞다.

```text
withDcRequestLease(...)
  -> management GET
  -> kcaptcha parse
  -> 필요 시 update_kcaptcha POST
```

현재 코드도 이렇게 되어 있다.

- `syncKcaptchaRecomCnt()`: `features/concept-monitor/api.js:292-325`
- 내부 GET: `features/concept-monitor/api.js:406-419`
- 내부 POST: `features/concept-monitor/api.js:421-474`

### 3-5. 파싱 실패 시 기본값으로 메우면 안 된다

이 로직은 “보존”이 목적이지 “추정”이 목적이 아니다.

예시:

1. HTML 구조가 바뀌어서 `use_comment`를 못 읽음
2. 코드가 조용히 `use_comment=1`로 기본값을 넣음
3. 사용자가 실제로는 `0`으로 꺼둔 설정을 덮어써버림

그래서 현재 구현은 fail-fast가 맞다.

- 필수 필드 누락 시 즉시 실패: `features/concept-monitor/api.js:671-679`
- toggle/숫자 값 해석 실패 시 즉시 실패: `features/concept-monitor/api.js:671-717`

---

## 4. 현재 코드에 실제로 반영된 내용

### 4-1. API 레이어

파일: `features/concept-monitor/api.js`

현재 들어가 있는 핵심 구조:

1. kcaptcha management 이름 매핑
   - `features/concept-monitor/api.js:30-79`
2. 관리 페이지 GET helper
   - `features/concept-monitor/api.js:406-419`
3. 전체 payload POST helper
   - `features/concept-monitor/api.js:421-474`
4. kcaptcha section parser
   - `features/concept-monitor/api.js:491-871`
5. high-level sync helper
   - `features/concept-monitor/api.js:292-325`

핵심 구현 포인트:

- `KCAPTCHA_MANAGEMENT_FIELD_CANDIDATES`
  - 화면 이름과 API 이름을 연결한다.
  - 그리고 지금은 `primary` / `fallback`을 분리해서, 화면 전용 이름을 먼저 읽고 API 이름 fallback은 맨 마지막에만 읽는다.
- `extractKcaptchaSectionHtml()`
  - `.set_content prevent_code` 영역을 먼저 찾는다.
- `parseKcaptchaManagementFieldValue()`
  - primary direct field, `ul_selectric(...)`, result text, API-name fallback 순서로 값을 찾는다.
- `assertCompleteKcaptchaSettings()`
  - 하나라도 비면 POST 전에 막는다.

2026-04-16 추가 보강:

- `recom_cnt`도 `recom_kcaptcha_cnt`뿐 아니라 direct `recom_cnt` 이름 fallback을 같이 받도록 보강했다.
- 위치: `features/concept-monitor/api.js:30-67`
- 이유: 현재 문서 HTML은 `recom_kcaptcha_cnt` script 기반이지만, 실제 관리 페이지 변형에서 direct field가 노출되면 기존 코드가 못 읽을 수 있었기 때문이다.
- 다만 fallback 우선순위는 맨 뒤로 내렸다.
  - 이유: 넓은 fallback section에서 개념컷 박스의 `recom_cnt=100`을 먼저 집어버리면 오동작이 나기 때문이다.
- `extractNearestFormGroupAroundMarker()`도 exact 문자열 `<div class="form_group">` 매칭이 아니라,
  class 안에 `form_group`이 포함된 `<div>`를 찾도록 보강했다.
  - 위치: `features/concept-monitor/api.js:546-579`
  - 이유: 실제 HTML은 `class="form_group set_content prevent_code"`라서 exact match로는 section 추출이 거의 항상 실패했다.
- 이 두 수정은 실제 재현 케이스로 확인했다.
  - 잘못된 이전 케이스 예시:
    - kcaptcha block 안 실제 값: `recom_kcaptcha_cnt=2`
    - 바깥 concept box 값: `recom_cnt=100`
    - 이전 fallback 파서는 경우에 따라 `100`을 집을 수 있었다
  - 현재는 같은 synthetic HTML에서 `2`로 안정적으로 파싱된다.

#### 4-1-a. 왜 `ul_selectric(...)`까지 읽어야 하나

`docs/html.md`에는 실제 `<select name="write_kcaptcha_cnt">`가 보이지 않고,
대신 아래 스크립트만 있다.

- `docs/html.md:868`
- `docs/html.md:896`
- `docs/html.md:924`

예:

```html
<script>ul_selectric($('.select_box'), 'recom_kcaptcha_cnt', '2'); </script>
```

즉 문서 HTML 기준으로는 count 값이 script 인자 안에 들어 있으므로,
파서가 이 경로도 읽을 수 있어야 한다.

현재 구현:

- `parseUlSelectricSelectionValue()`: `features/concept-monitor/api.js:805-812`

#### 4-1-b. 체크박스가 해제된 경우도 처리한다

실서비스 JS는 추천/비추천 체크가 둘 다 해제되면 `0`으로 바꿔 검사한다.

- live `managements.js` 1626-1633행

현재 파서도 checkbox가 unchecked면 `0`으로 해석한다.

- `features/concept-monitor/api.js:839-865`

즉 아래 상태가 정상 처리된다.

- `use_recom=1`
- `use_recom_r=0`
- `use_recom_n=0`

단, 서버/화면 단에서는 추천/비추천 둘 다 `0`이면 저장 거부가 날 수 있으므로,
이 상태는 “파싱은 가능하지만 운영상 허용 상태는 아님”으로 보는 게 맞다.

### 4-2. coordinator 레이어

파일: `features/concept-monitor/recommend-cut-coordinator.js`

현재 반영 내용:

1. kcaptcha 전용 상수 추가
   - `NORMAL_KCAPTCHA_RECOM_CNT = 2`
   - `DEFENDING_KCAPTCHA_RECOM_CNT = 8`
   - `UNKNOWN_KCAPTCHA_RECOM_CNT = 0`
   - 위치: `features/concept-monitor/recommend-cut-coordinator.js:9-13`
2. 저장 상태 추가
   - `lastAppliedKcaptchaRecomCnt`
   - `lastKcaptchaApplySucceeded`
   - `lastKcaptchaSettings`
   - 위치: `features/concept-monitor/recommend-cut-coordinator.js:23-38`
3. reconcile에서 개념컷 성공 후 kcaptcha도 동기화
   - 위치: `features/concept-monitor/recommend-cut-coordinator.js:176-214`
4. 적용 helper
   - `applyKcaptchaRecomCnt()`
   - 위치: `features/concept-monitor/recommend-cut-coordinator.js:254-266`
5. 저빈도 이벤트용 kcaptcha refresh invalidation helper
   - `invalidateKcaptchaRecomCntState()`
   - 위치: `features/concept-monitor/recommend-cut-coordinator.js:116-123`

핵심 동작:

- 목표 개념컷이 `100`이면 kcaptcha `8`
- 목표 개념컷이 `14`면 kcaptcha `2`
- 개념컷 apply 실패 시 kcaptcha는 시도하지 않음
- kcaptcha apply 실패는 로그만 남기고 다음 reconcile에서 재시도 가능

추가 정적 시뮬레이션 검증 결과:

- reset 직후 NORMAL reconcile 1회:
  - 호출 순서 `recommend:14 -> kcaptcha:2`
- 그 다음 reconcile 1회:
  - 추가 호출 없음
- DEFENDING 전환에서 첫 kcaptcha apply 실패:
  - 첫 reconcile 호출 `recommend:100 -> kcaptcha:8`
  - 다음 reconcile 호출 `kcaptcha:8`만 재시도

즉 아래 두 가지는 실제 코드 흐름으로도 확인됐다.

1. state가 이미 `14/2 success`라고 믿고 있으면 다음 reconcile은 아무 것도 안 한다
2. concept cut은 성공했고 kcaptcha만 실패한 경우, 다음 reconcile은 kcaptcha만 다시 시도한다

쉬운 예시:

1. 현재 상태: concept cut 14, kcaptcha 2
2. 공격 감지로 DEFENDING
3. coordinator가 먼저 concept cut 100 적용
4. 성공하면 kcaptcha 8 적용

### 4-3. baseline guard는 그대로 유지된다

파일: `features/concept-monitor/scheduler.js`

현재 자동조절은 baseline 없을 때 remote write를 건드리지 않는다.

- baseline reset: `features/concept-monitor/scheduler.js:82-84`
- baseline 미확보 시 early return: `features/concept-monitor/scheduler.js:227-232`
- force refresh invalidation + coordinator sync guard: `features/concept-monitor/scheduler.js:330-347`

즉 auto-cut ON 직후 바로 `recom_cnt=2` 또는 `8`을 밀어넣지 않는다.

쉬운 예시:

1. 사용자가 auto-cut ON
2. 아직 첫 비교 전
3. 현재 개념컷과 kcaptcha 값 유지
4. 다음 snapshot 비교부터 변경 가능

추가 확인:

- `start()`와 `stop()`은 `forceKcaptchaRefresh: true`로 sync를 호출한다.
  - `features/concept-monitor/scheduler.js:77-108`
- 하지만 baseline guard는 그 뒤에 그대로 살아 있으므로,
  **auto-cut baseline 전에는 invalidate만 되고 실제 remote sync는 건너뛴다.**
- 정적 시뮬레이션 기준:
  - `start(autoCutEnabled=true, baseline empty)` -> `invalidateKcaptchaRecomCntState()`만 수행 후 guard return
  - `stop(isRunning=true)` -> `invalidateKcaptchaRecomCntState()` 후 정상 reconcile 진행

### 4-4. patrol hold 경로도 포함된다

파일: `features/concept-patrol/scheduler.js`

patrol에서 조작 후보가 threshold 이상이면 hold를 건다.

- hold trigger: `features/concept-patrol/scheduler.js:260-267`
- coordinator entry: `features/concept-monitor/recommend-cut-coordinator.js:125-133`

즉 kcaptcha 연동은 auto-cut 전용이 아니라 patrol hold 전환도 포함한다.

### 4-5. background 복원/설정 변경 경로도 포함된다

파일: `background/background.js`

현재 아래 경로에서 coordinator sync가 다시 돈다.

1. service worker 복원
   - `background/background.js:192-291`
   - `background/background.js:270-273`
2. alarm 처리
   - `background/background.js:125-143`
3. concept monitor 설정 저장
   - `background/background.js:707-712`
4. concept monitor 통계 초기화
   - `background/background.js:750-754`

즉 단순 auto-cut cycle만 보는 문서는 실제 운영 경로를 반만 본 셈이다.

2026-04-16 추가 보강:

- 위 1, 3, 4 경로는 이제 `forceKcaptchaRefresh: true`로 coordinator sync를 호출한다.
- 즉 resume / updateConfig / resetStats 같은 저빈도 이벤트에서는
  kcaptcha 상태를 한 번 더 “재확인 필요”로 표시하고 다음 reconcile에서 fresh-read 기회를 만든다.

---

## 5. hold expiry 관련 버그와 현재 상태

기존에는 patrol hold가 만료된 뒤에도 remote가 100/8로 남을 수 있는 구멍이 있었다.

원인:

1. initialize 단계에서 expired hold를 먼저 `0`으로 정리
2. alarm handler가 그 상태를 보고 그냥 종료
3. reconcile이 한 번도 안 돎

현재는 이 분기에서도 reconcile을 다시 호출한다.

- 수정 위치: `features/concept-monitor/recommend-cut-coordinator.js:153-173`

쉬운 예시:

- 이전:
  - hold 끝남
  - 로컬만 hold 해제
  - 서버는 100/8 그대로 남을 수 있음
- 현재:
  - hold 끝남
  - reconcile 재실행
  - 필요하면 14/2로 복귀

---

## 6. 실제 필드 파싱 기준

문서 HTML 기준으로 현재 파서는 아래 값을 읽어야 맞다.

기준 근거:

- `docs/html.md:815-946`

기대 파싱 결과:

```json
{
  "use_ips": "0",
  "write_cnt": "3",
  "comment_cnt": "1",
  "recom_cnt": "2",
  "use_write": "1",
  "use_comment": "1",
  "use_recom": "1",
  "use_recom_r": "1",
  "use_recom_n": "1"
}
```

이 검증은 실제로 통과했다.

추가로 체크박스 둘 다 해제한 synthetic HTML에서도 아래처럼 읽히는 것을 확인했다.

```json
{
  "use_recom": "1",
  "use_recom_r": "0",
  "use_recom_n": "0"
}
```

즉 현재 파서는 적어도 문서 HTML 수준에서는 아래 두 가지를 모두 만족한다.

1. `recom_kcaptcha_cnt=2`를 정확히 집는다
2. 뒤쪽 `concept_range`의 `recom_cnt=100`은 집지 않는다

---

## 7. 실제 호출 흐름

### 7-1. NORMAL -> DEFENDING

```text
concept-monitor/scheduler.js
  -> syncRecommendCutCoordinator()
  -> recommend-cut-coordinator.js: reconcileRecommendCutCoordinator()
  -> updateRecommendCut(100)
  -> syncKcaptchaRecomCnt(8)
     -> management GET
     -> parse current settings
     -> recom_cnt only replace
     -> update_kcaptcha POST
```

### 7-2. DEFENDING -> NORMAL

같은 흐름으로 아래만 바뀐다.

- concept cut: `100 -> 14`
- kcaptcha recom_cnt: `8 -> 2`

### 7-3. concept monitor stop

`features/concept-monitor/scheduler.js:96-107`

monitor stop도 reconcile을 탄다.
따라서 patrol hold가 없고 DEFENDING이 해제되면 `14 / 2` 복귀 경로에 포함된다.

### 7-4. patrol hold

`features/concept-patrol/scheduler.js:260-267`

patrol이 hold를 걸면 공용 coordinator의 목표값이 DEFENDING으로 바뀌고,
결과적으로 concept cut 100 + kcaptcha 8 유지 요청이 같이 걸린다.

### 7-5. service worker resume

`background/background.js:270-273`

복원 직후에도 concept monitor가 coordinator를 한 번 더 sync한다.
다만 이건 “재동기화 시도”이지, 9-1에서 설명한 remote drift까지 항상 다시 읽는다는 뜻은 아니다.

---

## 8. 진단용 partial probe의 의미

파일: `features/concept-monitor/kcaptcha-partial-probe.js`

이 도구는 원래 “`recom_cnt`만 보내면 되는가?”를 확인하려고 만든 실험 도구다.

- 기본 body: `ci_t`, `gallery_id`, `_GALLTYPE_`, `recom_cnt`
- 위치: `features/concept-monitor/kcaptcha-partial-probe.js:31-39`

이 probe에서 실패 메시지로 필수값 누락이 확인됐기 때문에,
운영 로직은 partial POST가 아니라 full payload POST로 가는 게 맞다고 결론 낸 것이다.

즉 이 probe는 이제 “운영 구현”이 아니라 “왜 partial POST가 틀렸는지 보여주는 진단 도구”로 보는 게 맞다.

---

## 9. 현재 기준 남아 있는 구조적 한계

### 9-1. 수동 remote drift는 현재 자동 교정되지 않을 수 있다

이건 이번 점검에서 추가로 확인한 핵심 한계였고,
현재는 일부 경로에서만 완화됐다.

현재 coordinator는 kcaptcha 동기화를 아래 조건에서만 탄다.

- `state.lastAppliedKcaptchaRecomCnt !== desiredKcaptchaRecomCnt`
- 또는 `state.lastKcaptchaApplySucceeded === false`

근거:

- `features/concept-monitor/recommend-cut-coordinator.js:206-214`

즉 로컬 state가 아래처럼 남아 있으면:

```text
lastAppliedKcaptchaRecomCnt = 2
lastKcaptchaApplySucceeded = true
desiredKcaptchaRecomCnt = 2
```

그 다음 reconcile에서는 `syncKcaptchaRecomCnt()` 자체를 호출하지 않는다.

쉬운 예시:

1. 확장이 예전에 `recom_cnt=2`를 성공 적용
2. 사용자가 DC 관리 페이지에서 수동으로 `recom_cnt=8`로 바꿈
3. concept cut desired는 여전히 NORMAL이라 목표값은 계속 `2`
4. 다음 reconcile에서 로컬 state는 이미 `2/성공`이라고 믿고 있으므로 GET을 안 함
5. 결과적으로 remote drift가 바로 교정되지 않을 수 있음

중요한 해석:

- 현재 구현은 “apply 직전 stale overwrite”는 줄였다
- 그리고 아래 저빈도 이벤트에서는 kcaptcha state를 일부러 dirty로 만들어 재확인 기회를 만든다.
  - service worker resume: `background/background.js:270-273`
  - concept monitor start/stop: `features/concept-monitor/scheduler.js:77-108`
  - concept monitor updateConfig/resetStats: `background/background.js:707-712`, `750-753`
- 하지만 **steady-state no-op reconcile**까지 항상 remote를 다시 읽는 구조는 아직 아니다

더 강한 보장을 원하면 선택지는 아래 3개다.

1. every reconcile마다 management GET을 수행한다
2. startup/resume/주기적 health check 시 remote read를 강제로 1회 수행한다
3. 특정 이벤트 후 `lastAppliedKcaptchaRecomCnt`를 unknown으로 내려서 재확인을 강제한다

### 9-2. concept cut과 kcaptcha는 아직 하나의 원자적 작업이 아니다

이것도 버그라기보다는 현재 구조의 한계다.

`reconcileRecommendCutCoordinator()`는 아래 두 작업을 순서대로 호출한다.

1. `updateRecommendCut()`
2. `syncKcaptchaRecomCnt()`

근거:

- `features/concept-monitor/recommend-cut-coordinator.js:176-214`

그런데 두 helper는 각각 자기 lease를 따로 잡는다.

- concept cut write: `features/concept-monitor/api.js:239-290`
- kcaptcha sync: `features/concept-monitor/api.js:292-325`
- broker lease 성격: `background/dc-session-broker.js:380-418`

즉 아래처럼 될 수 있다.

1. concept cut 100 적용
2. 첫 lease 해제
3. 그 사이 세션 전환 시작
4. 두 번째 lease에서 kcaptcha GET/POST 진행 또는 실패

실무적으로는 큰 문제가 아닐 수도 있다.
그래도 “concept cut과 kcaptcha가 반드시 같은 세션/같은 high-level transaction에서 붙어야 한다”는 요구가 있으면 현재 구조는 그 수준의 보장을 하지 않는다.

필요하면 상위에서 아래처럼 묶는 설계가 필요하다.

```text
withDcRequestLease(...)
  -> updateRecommendCut()
  -> syncKcaptchaRecomCnt() 내부 GET/POST
```

### 9-3. `use_recom=0`일 때도 hidden recom_cnt는 동기화된다

현재 구현은 `use_recom` 값을 보존하면서 `recom_cnt`만 목표값으로 바꾼다.

근거:

- `features/concept-monitor/api.js:312-322`
- `features/concept-monitor/api.js:439-446`

예:

```text
현재 remote:
use_recom = 0
recom_cnt = 5

DEFENDING 전환 후:
use_recom = 0
recom_cnt = 8
```

즉 “개념글 추천 kcaptcha가 꺼져 있어도 저장된 recom_cnt 숫자는 바뀐다”.

이건 코드상 버그는 아니다.
왜냐하면 현재 목적이 “나머지 설정을 보존한 채 recom_cnt 값을 맞춘다”이기 때문이다.

다만 제품 요구가 아래와 같다면 해석이 달라진다.

- “`use_recom=0`이면 hidden recom_cnt도 건드리지 말자”

이 요구라면 현재 동작은 맞지 않는다.
즉 이건 **로직 오류라기보다 정책 결정 포인트**다.

---

## 10. 바로 실행 가능한 검증 절차

### 10-1. 실서비스 JS 기준 필드 매핑 재확인

```bash
curl -L 'https://gall.dcinside.com/_js/managements.js?v=260415' | nl -ba | sed -n '1610,1668p'
```

여기서 확인할 포인트:

- 읽는 이름이 `write_kcaptcha_cnt`, `comment_kcaptcha_cnt`, `recom_kcaptcha_cnt`
- 보내는 이름이 `write_cnt`, `comment_cnt`, `recom_cnt`

### 10-2. 문서 HTML 기준 파서 결과 재확인

아래 명령으로 현재 `parseKcaptchaSettings()`가 문서 HTML에서 무엇을 읽는지 바로 확인할 수 있다.

```bash
node --input-type=module <<'NODE'
import fs from 'fs';
import vm from 'vm';

let source = fs.readFileSync('features/concept-monitor/api.js', 'utf8');
source = source.replace(/^import .*?;\n/m, '');
source = source.replace(
  /export \{[\s\S]*?\};\s*$/m,
  'globalThis.__exports = { parseKcaptchaSettings, assertCompleteKcaptchaSettings };',
);

const context = {
  console,
  fetch: () => { throw new Error('fetch should not run'); },
  chrome: { cookies: { get: async () => null } },
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  withDcRequestLease: async (_meta, fn) => fn(),
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);

const html = fs.readFileSync('docs/html.md', 'utf8');
const parsed = context.__exports.assertCompleteKcaptchaSettings(
  context.__exports.parseKcaptchaSettings(html),
);
console.log(JSON.stringify(parsed, null, 2));
NODE
```

기대 결과:

- `write_cnt=3`
- `comment_cnt=1`
- `recom_cnt=2`
- `use_recom_r=1`
- `use_recom_n=1`

### 10-3. partial POST 실패 재현

popup의 KCPT probe로 아래처럼 보내면 된다.

- `recom_cnt=8`
- 추가 필드 비움

기대 결과:

- 서버가 필수 필드 누락 메시지 반환
- 즉 partial POST가 운영 경로로 부적합하다는 점이 다시 확인됨

### 10-4. 실운영 1회 검증 순서

1. 로그인된 상태에서 extension 실행
2. concept cut이 실제로 14 또는 100인지 확인
3. 관리 페이지에서 현재 도배 방지 코드 설정을 눈으로 확인
4. DEFENDING 또는 NORMAL 전환 1회 유도
5. 네트워크 탭에서 `update_kcaptcha` payload 확인
6. `recom_cnt`만 2 또는 8로 바뀌고 나머지 필드는 기존값 유지인지 확인

---

## 11. 아직 남은 실운영 확인 항목

현재까지는 코드와 문서 스펙, live JS, synthetic HTML까지 교차검증됐다.
그리고 2026-04-16 최종 점검에서 아래 48개 정적 검증도 추가로 통과했다.

- parser 20건
- coordinator 13건
- scheduler/background caller 15건

검증에 포함한 대표 케이스:

- 문서 HTML 실파싱
- unchecked checkbox / hidden fallback
- script value / result text fallback
- broad fallback section에서 `recom_cnt=100` 오인 파싱 방지
- reset -> NORMAL reconcile -> no-op 재호출
- DEFENDING 전환 -> kcaptcha 실패 -> 다음 reconcile 재시도
- baseline guard + force refresh 조합
- start / stop / resume / updateConfig / resetStats caller 경로 점검

다만 아래 둘은 별개로 남아 있다.

1. 로그인된 실제 관리 페이지 GET/POST 1회 검증
2. 9절에 적은 구조적 한계를 받아들일지, 추가 보강할지 결정

남은 체크:

1. 실제 management GET이 redirect 없이 열리는지
2. 실제 페이지 HTML이 `docs/html.md`와 동일 계열 구조인지
3. `update_kcaptcha` 성공 후 서버 응답이 계속 `{"result":"success"}` 형태인지
4. 특정 갤에서 `set_enable` 영역이 동적으로 더 변형돼 있지 않은지

중요한 해석:

- 지금 문서는 “구현 방향 추측” 문서가 아니다.
- 다만 현재 상태를 가장 정확히 말하면 아래다.
- “구현과 정적 검증은 완료”
- “실운영 1회 검증은 아직 남음”
- “manual drift / lease 경계 / disabled recom 정책은 구조적 한계 또는 정책 포인트로 남아 있음”

---

## 12. 지금 바로 이어서 작업할 때의 기준

앞으로 이 기능을 손댈 때는 아래 6가지를 깨면 안 된다.

1. `update_kcaptcha`에 partial POST를 다시 도입하지 말 것
2. kcaptcha 파서는 문서 전체 전역 검색이 아니라 kcaptcha 박스 안에서만 동작할 것
3. 화면용 이름과 API용 이름의 매핑을 섞지 말 것
4. GET -> parse -> POST는 가능하면 한 번의 lease 안에서 처리할 것
5. 파싱 실패를 기본값으로 덮지 말고 fail-fast 할 것
6. “manual drift를 자동 교정할지”와 “concept cut + kcaptcha를 원자적으로 묶을지”는 별도 정책 결정으로 취급할 것

이 기준을 지키면 “개념글 코드만 바꾸려다 다른 도배 방지 설정을 덮어쓰는” 사고는 크게 줄어든다.
