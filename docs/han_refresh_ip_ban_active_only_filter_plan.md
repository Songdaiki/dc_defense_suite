# 도배기갱신차단자동 active-only 필터 보강 플랜

## 결론

이번 보강은 **큰 구조변경 없이 가능하다.**

실제 코드 기준으로 `도배기갱신차단자동`은 이미 관리내역 row마다:

- `stateText`
- `releaseId`
- `isActive`

를 파싱하고 있다.

즉 새 API나 새 storage schema가 필요한 작업이 아니라,
**대상 row 선정 단계에서 `차단 중(isActive=true)` row만 통과시키는 필터 보강**으로 처리할 수 있다.

핵심 구현 포인트는:

1. `parseBlockListRows()`가 이미 만든 `row.isActive`를 그대로 사용
2. `extractActionableManagementRows()`에서 `!row.isActive`면 스킵
3. 관련 문구 / 로그 / 문서를 `관리내역 전체`가 아니라 `차단 중인 관리내역 row` 기준으로 정리

즉 이 작업은 **기능 추가라기보다 대상 필터를 좁히는 보강**에 가깝다.

---

## 실제 코드 기준 현재 상태

### 1. 상태 정보는 이미 파싱되고 있다

기준 코드:

- [features/ip/parser.js](/home/eorb915/projects/dc_defense_suite/features/ip/parser.js#L58)

현재 `parseBlockListRows()`는 관리내역 row에서:

- `releaseMatch`
- `releaseId`
- `ano`
- `stateText`
- `isActive`

를 이미 만든다.

여기서 `isActive`는
`해제 버튼 onclick="set_avoid(..., 'R', ...)"` 존재 여부 기반이다.

즉 텍스트 `차단 중`, `해제됨`을 새로 다시 파싱할 필요 없이,
**이미 더 신뢰할 수 있는 active 플래그가 있다.**

### 2. 현재는 active 여부를 필터에 쓰지 않는다

기준 코드:

- [features/han-refresh-ip-ban/parser.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/parser.js#L63)

현재 `extractActionableManagementRows()`는 아래만 본다.

- 게시글 row
- 제목 Han 2글자 이상
- writer token이 IP형
- `blockDataNum` / `avoidNo` 유효성
- 같은 `avoidNo` 중복 방지
- baseline max row 상한

반대로 **`row.isActive`는 현재 전혀 안 본다.**

즉 지금은:

- `차단 중` row도 대상
- `해제됨` row도 대상

으로 같이 재차단 후보가 된다.

### 3. scheduler / API는 row 상태와 무관하게 `avoidNo`만 재차단한다

기준 코드:

- [features/han-refresh-ip-ban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/scheduler.js#L194)
- [features/han-refresh-ip-ban/api.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/api.js#L110)

현재 scheduler는 `extractActionableManagementRows()`에서 넘어온 `avoidNo`만 모아
`user_code_avoid`로 넘긴다.

즉 active-only 보강은 scheduler나 API 쪽의 구조변경이 아니라,
**parser 단계에서 대상을 한 번 더 거르면 끝나는 형태**다.

---

## 왜 이 보강이 필요한가

현재 스펙은 관리내역을 “재차단 갱신” 대상으로 보고 있어서
`해제됨` row도 다시 태울 수 있게 돼 있다.

하지만 운영 의도가:

- **현재 차단 중인 row만 갱신 유지**
- 이미 해제된 과거 row는 다시 건드리지 않음

이라면 지금 스펙은 넓다.

쉽게 말하면 현재는:

1. 예전에 차단했다가 해제된 Han 게시글 row
2. 관리내역에 남아 있음
3. 이번 자동 순회가 다시 발견
4. 다시 6시간 재차단

이 가능하다.

원하는 동작은:

1. 현재 관리내역에서 아직 `차단 중`인 Han 게시글 row만
2. 재차단으로 갱신

이므로, active-only 필터가 맞다.

---

## 구현 방향

## 1. parser에서 `row.isActive` 필터 추가

가장 직접적인 수정 지점:

- [features/han-refresh-ip-ban/parser.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/parser.js#L63)

현재 루프에서 아래 조건을 추가한다.

```js
if (!row.isActive) {
  continue;
}
```

위치는 추천상:

- `게시글 row` 확인 후
- `Han 제목` 확인 전 또는 직후

둘 중 어디든 가능하다.

다만 의미상으론:

1. 게시글 row
2. active row
3. Han 제목
4. IP형 writer token

순으로 읽히게 두는 게 가장 명확하다.

## 2. `stateText`가 아니라 `isActive`를 기준으로 쓴다

이 작업에서 중요한 건
`차단 중` 문자열 비교를 새로 넣지 않는 것이다.

이유:

- 현재 `stateText`는 UI 텍스트라서 표현이 바뀔 수 있다
- `isActive`는 해제 버튼 존재 기반이라 현재 구조상 더 안정적이다

즉 이 보강은 반드시:

- `row.isActive === true`

를 기준으로 고정한다.

## 3. scheduler / API / storage는 바꾸지 않는다

이번 작업은 아래를 바꾸지 않아도 된다.

- `features/han-refresh-ip-ban/scheduler.js`
- `features/han-refresh-ip-ban/api.js`
- `STORAGE_KEY` 구조
- popup 저장 config schema

이유:

- 대상 row만 줄어들 뿐
- 그 뒤 파이프라인은 이미 `avoidNo[] -> user_code_avoid`로 정상 동작한다

즉 **새 스펙/새 상태 저장 없이 parser 필터 보강으로 충분하다.**

---

## 문서 / UI / 로그 보정 포인트

코드만 바꾸면 동작은 맞출 수 있지만,
문서와 UI가 그대로면 의미가 달라져 혼선을 만든다.

### 1. 기존 메인 문서의 상태 조건을 수정해야 한다

현재 문서는 아래처럼 되어 있다.

- [docs/concept_han_refresh_ip_ban_plan.md](/home/eorb915/projects/dc_defense_suite/docs/concept_han_refresh_ip_ban_plan.md#L486)

현재 서술:

- 상태(`차단 중` / `해제됨`)는 필터 조건이 아니다

이건 보강 후엔 틀린 문장이 된다.

따라서 이 문서는 아래로 수정하는 게 맞다.

- 상태는 필터 조건이다
- `isActive=true`인 row만 포함
- `해제됨` row는 제외

### 2. popup 설명 문구도 실제 의미에 맞추는 게 좋다

현재 popup 설명:

- [popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L426)

현재 문구는:

- `관리내역 전체를 주기적으로 훑어 ... 다시 갱신 차단`

active-only 보강 후에는 더 정확한 표현이:

- `관리내역의 차단 중 게시글을 주기적으로 훑어 ... 다시 갱신 차단`

정도다.

필수는 아니지만,
운영자가 기능 오해를 안 하게 하려면 바꾸는 쪽이 좋다.

### 3. 로그의 “대상 row” 의미도 active-only가 된다

현재 scheduler 로그:

- [features/han-refresh-ip-ban/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/scheduler.js#L242)

여기서 `대상 N줄`은 보강 후

- `게시글 + Han + IP형 + 차단 중`

을 뜻하게 된다.

즉 로그 포맷은 그대로 둬도 되지만,
문서상 의미는 갱신해야 한다.

---

## 추가 스펙이 필요한가

## 결론: 거의 필요 없다

이번 보강은 **새 플래그나 새 UI 설정 없이도 가능**하다.

즉 선택지는 둘이다.

### 권장안: 고정 필터로 간다

- active row만 재차단
- 해제된 row는 무조건 제외
- 추가 설정 없음

이 경우 구현과 운영이 가장 단순하다.

### 비권장안: ON/OFF 설정으로 만든다

이건 technically 가능하지만, 지금 요구 수준엔 과하다.

필요해지는 추가 범위:

- popup checkbox
- config schema
- background updateConfig wiring
- status 표시
- 문서 추가

현재 요구는 “차단 중인 것만 재차단하자”이므로,
굳이 설정화할 이유가 없다.

따라서 **고정 필터**가 맞다.

---

## 실제 구현 시 영향 범위

최소 구현 범위:

1. [features/han-refresh-ip-ban/parser.js](/home/eorb915/projects/dc_defense_suite/features/han-refresh-ip-ban/parser.js)
2. [docs/concept_han_refresh_ip_ban_plan.md](/home/eorb915/projects/dc_defense_suite/docs/concept_han_refresh_ip_ban_plan.md)
3. [popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)

즉 기능 변경치고는 작다.

API / scheduler / storage migration까지 건드릴 필요는 없다.

---

## 구현 체크리스트

1. `extractActionableManagementRows()`에 `if (!row.isActive) continue;` 추가
2. 정적 검증:
   - active row + Han + IP형 -> 포함
   - released row + Han + IP형 -> 제외
   - active row + Han 아님 -> 제외
   - active row + uid형 -> 제외
3. 기존 same-avoidNo dedupe 유지 확인
4. tail 보정 / baseline max row 상한 로직 영향 없음 확인
5. 메인 문서의 “상태는 필터 조건이 아니다” 문장 수정
6. popup 설명 문구를 `관리내역 전체`가 아니라 `차단 중인 관리내역 게시글` 의미로 보정
7. 가능하면 parser-level 정적 검증 케이스 추가

---

## 최종 판단

이번 요구는 **구조변경 작업이 아니다.**

실제 코드 기준으로는:

- 상태 정보가 이미 파싱돼 있고
- scheduler/API는 `avoidNo[]`만 쓰고
- 현재 빠져 있는 건 `isActive` 필터 한 줄뿐이다

즉 **큰 스펙 확장 없이, active-only 필터 보강으로 바로 가는 게 맞다.**
