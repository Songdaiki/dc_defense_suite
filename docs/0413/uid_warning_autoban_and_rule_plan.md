# 분탕자동차단 제목 직차단 AND 규칙 구현 계획

## 1. 목표

현재 `분탕자동차단`의 제목 직차단은 **정규화된 단일 문자열 포함 매치**만 지원한다.

예시:

- 등록 규칙: `AV`
- 글 제목: `A​V 유출 정리`
- 정규화 후 `av` 포함 -> 직차단

하지만 아래 같은 **키워드 분산형 분탕 제목**은 현재 놓친다.

예시:

- 등록하고 싶은 의도: `반도체`, `용인`, `노가다`가 **전부 들어간 글**
- 실제 글 제목: `반도체 용인이나 가서 노가다나 쳐해라 병신들아`
- 현재 방식:
  - 규칙을 `반도체용인노가다`로 넣으면
  - 제목 정규화 결과가 `반도체용인이나가서노가다나쳐해라병신들아`
  - `반도체용인노가다`가 **연속 문자열로 포함되지 않아서** 미매치

원하는 동작:

- 규칙을 `반도체, 용인, 노가다` 같은 **AND 키워드 규칙**으로 넣고
- 제목 안에 이 키워드 3개가 **모두 포함**되면
- 지금 직차단과 똑같이 `page1 차단/삭제`까지 수행

한 줄 요약:

- **기존 `단일 포함 규칙`은 유지**
- **새 `AND 키워드 규칙`을 추가**
- **둘 다 같은 10초 cycle 안에서 같이 검사**

---

## 2. 현재 실제 로직

### 2.1 분탕자동차단 cycle

현재 `분탕자동차단`은 10초마다 `page1`을 읽고, 그 안에서 제목 직차단을 먼저 본다.

관련 코드:

- 기본 주기: [api.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/api.js#L7)
- cycle 시작: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L173)
- `page1` fetch: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L181)
- 제목 직차단 처리: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L188)

실제 순서는 이렇다.

1. `page1` HTML을 한 번 읽는다.
2. 전체 row를 파싱한다.
3. 제목 직차단을 먼저 수행한다.
4. 제목 직차단에서 처리된 글번호를 `processedImmediatePostNos`에 담는다.
5. 그 글번호를 뺀 UID 글만 나머지 UID 분탕 판단으로 넘긴다.

중요한 점:

- **AND 규칙을 붙여도 추가 네트워크 요청은 없다**
- 이미 읽은 `page1` row를 대상으로 **로컬 문자열 매칭만 늘어나면 된다**

즉:

- 지금도 `page1` HTML은 한 번 읽고 있다
- 여기에 `contains`만 보던 것을
- `contains + and` 둘 다 보게 바꾸면 된다

---

### 2.2 현재 제목 직차단 규칙 구조

현재 규칙 정규화는 문자열 하나 기준이다.

관련 코드:

- 규칙 정규화: [parser.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/parser.js#L229)
- 제목 정규화: [parser.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/parser.js#L256)
- 매칭 함수: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L984)

현재 규칙 shape:

```js
{
  rawTitle: 'AV',
  normalizedTitle: 'av',
}
```

현재 매칭 방식:

```js
title.includes(normalizedRule)
```

즉 예시:

- 규칙: `삼성전자`
- 제목: `삼성전자 HBM 긴급`
- 정규화 후 `삼성전자` 포함 -> 매치

반대로:

- 규칙: `반도체용인노가다`
- 제목: `반도체 용인이나 가서 노가다나 쳐해라`
- 정규화 후 연속 포함 아님 -> 미매치

---

### 2.3 현재 popup 입력 구조

현재 popup은 직차단 규칙을 hidden JSON 배열로 관리한다.

관련 코드:

- add 버튼: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1862)
- hidden JSON 파서: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3456)
- 리스트 렌더링: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3499)
- 입력 UI: [popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L1346)

즉 지금은 popup도 **단일 문자열 규칙만 상정**한다.

---

### 2.4 실제 코드와 문서를 대조하면서 추가로 발견된 포인트

이번 설계에서 그냥 넘어가면 안 되는 부분들이다.

1. 현재 `matchedGroups`의 key는 `matchedRule.normalizedTitle`이다.
   관련 코드: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L494)
   이 상태로 `AND`를 붙이면, `contains` 규칙과 `and` 규칙이 우연히 같은 문자열 key를 만들 때 그룹/삭제/중복 처리 충돌 가능성이 있다.
   결론: **매칭용 값과 그룹 key를 분리**해야 한다.

2. 현재 popup 파서는 `rule.rawTitle`만 읽고 다시 `normalizedTitle`을 만든다.
   관련 코드: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3466)
   즉 새로 `type`, `rawTokens`, `normalizedTokens`를 넣어도 지금 구조로는 저장/복원 시 날아간다.
   결론: **popup parser/renderer와 parser.js 정규화는 같이 바뀌어야 한다.**

3. 현재 `processedImmediatePostNos.add(postNo)`는 recent-skip 체크보다 먼저 실행된다.
   관련 코드: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L480)
   즉 제목 직차단 글이 최근 처리 이력 때문에 이번 cycle에서 스킵되더라도, **그 글번호 자체는 UID 경로로 다시 들어가지 않는다.**
   이건 현재 동작이며, AND 규칙 추가 후에도 그대로 유지하는 게 안전하다.

4. popup 비활성화 경로는 현재 `addImmediateTitleRuleBtn` 하나만 잠근다.
   관련 코드: [popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2712)
   새 `AND 키워드 추가` 버튼을 넣으면 이 잠금 경로도 같이 수정해야 한다.

5. 현재 로그 문구는 `포함 매치`로 고정돼 있다.
   관련 코드: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L520)
   AND 규칙까지 붙인 뒤에도 그대로 두면 로그가 오해를 만든다.
   결론: **로그 문구는 `직차단 매치` 또는 타입 표시 포함 로그로 일반화**해야 한다.

6. AND 규칙은 논리적으로 순서가 없다.
   예시:
   - `반도체, 용인, 노가다`
   - `노가다, 용인, 반도체`
   이 둘은 같은 규칙이어야 한다.
   결론: **AND 규칙 dedupe key는 토큰 순서를 정규화한 canonical key**여야 한다.

7. AND 규칙에서 유효 토큰이 1개만 남으면 의미상 contains와 같다.
   예시:
   - 입력: `반도체, ,`
   - 정규화 후 유효 토큰: `반도체` 1개
   이건 AND 규칙으로 저장하면 사용자가 헷갈린다.
   결론: **AND 버튼은 정규화 후 토큰이 2개 이상일 때만 저장**해야 한다.

위 7개는 문서 반영 전 기준으로 실제 코드와 문서 사이의 빈틈이었다.
이 문서에서는 이 부분을 모두 반영한 상태로 정리한다.

---

## 3. 가장 좋은 설계

결론:

- **규칙 타입을 2종으로 늘리는 게 가장 좋다**
- 하나는 기존 `contains`
- 하나는 새 `and`
- 같은 배열 `immediateTitleBanRules` 안에 같이 저장한다

이 방식이 좋은 이유:

1. 기존 저장 키 `immediateTitleBanRules`를 그대로 쓴다.
2. 기존 scheduler 흐름을 거의 안 바꾼다.
3. 직차단 이후 처리도 그대로 재사용한다.
4. 10초 cycle 안에서 로컬 매칭만 늘어나므로 네트워크 증가는 없다.

한 줄로:

- **새 feature를 만드는 게 아니라, 기존 `immediateTitleBanRules`를 확장하는 방식**이 가장 자연스럽다

---

## 4. 권장 데이터 구조

핵심은 **매칭용 값**과 **식별용 key**를 분리하는 것이다.

### 4.1 기존 포함 규칙

```js
{
  type: 'contains',
  rawTitle: '삼성전자',
  normalizedTitle: '삼성전자',
  ruleKey: 'contains:삼성전자',
}
```

여기서:

- `normalizedTitle`은 실제 `includes()` 매칭용
- `ruleKey`는 dedupe/group/remove용

### 4.2 새 AND 규칙

```js
{
  type: 'and',
  rawTitle: '반도체, 용인, 노가다',
  rawTokens: ['반도체', '용인', '노가다'],
  normalizedTokens: ['노가다', '반도체', '용인'],
  normalizedTitle: '노가다|반도체|용인',
  ruleKey: 'and:노가다|반도체|용인',
}
```

여기서:

- `rawTokens`는 popup 표시용 원본
- `normalizedTokens`는 **공백 제거, confusable 정규화, 중복 제거 후 canonical 순서로 정렬된 토큰 배열**
- `normalizedTitle`은 사람이 보기 쉬운 요약 문자열
- `ruleKey`는 중복/삭제/그룹 key

중요:

- AND 규칙은 **정규화 후 토큰 2개 이상일 때만 유효**
- AND dedupe는 입력 순서가 아니라 `normalizedTokens`의 canonical 결과로 본다

예시:

- 입력 1: `반도체, 용인, 노가다`
- 입력 2: `노가다,반도체,용인`
- 둘 다 `ruleKey = and:노가다|반도체|용인`
- 즉 **같은 규칙으로 본다**

---

## 5. popup UI 설계

### 5.1 입력 방식

가장 단순하고 안전한 방식:

- 기존 입력창은 그대로 사용
- 버튼을 2개로 분리

예시:

- `금칙 제목 추가`
  - 기존 `contains` 규칙 추가
- `AND 키워드 추가`
  - 쉼표로 분리된 토큰 규칙 추가

입력 예시:

- contains:
  - 입력: `AV`
  - 버튼: `금칙 제목 추가`
- and:
  - 입력: `반도체, 용인, 노가다`
  - 버튼: `AND 키워드 추가`

이 방식이 좋은 이유:

- 기존 규칙과 의미가 안 섞인다
- 사용자가 “쉼표가 포함된 일반 제목”을 실수로 AND로 저장하는 일을 줄인다
- popup 복잡도가 작다

### 5.2 리스트 표시

현재 리스트에 타입 라벨만 하나 더 붙이면 된다.

예시:

- `[포함] AV`
- `[포함] 삼성전자`
- `[AND] 반도체, 용인, 노가다`
  - 정규화: `노가다 | 반도체 | 용인`

### 5.3 popup parser가 꼭 지켜야 할 하위 호환

popup hidden JSON 파서는 아래 3가지를 전부 읽을 수 있어야 한다.

1. 문자열

```js
['AV', '삼성전자']
```

2. 구버전 object

```js
[
  { rawTitle: 'AV', normalizedTitle: 'av' },
  { rawTitle: '삼성전자', normalizedTitle: '삼성전자' },
]
```

3. 신버전 object

```js
[
  { type: 'contains', rawTitle: 'AV', normalizedTitle: 'av', ruleKey: 'contains:av' },
  {
    type: 'and',
    rawTitle: '반도체, 용인, 노가다',
    rawTokens: ['반도체', '용인', '노가다'],
    normalizedTokens: ['노가다', '반도체', '용인'],
    normalizedTitle: '노가다|반도체|용인',
    ruleKey: 'and:노가다|반도체|용인',
  },
]
```

즉 popup은 저장값을 읽을 때도 **구버전 -> contains 승격**, **신버전 -> 필드 보존**이 동시에 돼야 한다.

---

## 6. 런타임 매칭 규칙

### 6.1 contains

현재와 동일:

```js
normalizedTitle.includes(rule.normalizedTitle)
```

예시:

- 규칙: `삼성전자`
- 제목: `삼성전자 HBM 긴급`
- 매치

### 6.2 and

새 규칙:

```js
rule.normalizedTokens.every((token) => normalizedTitle.includes(token))
```

예시:

- 규칙: `반도체, 용인, 노가다`
- 제목: `반도체 용인이나 가서 노가다나 쳐해라`
- `반도체` 포함
- `용인` 포함
- `노가다` 포함
- 전부 만족 -> 매치

반대로:

- 제목: `반도체 용인 공장 얘기`
- `노가다` 없음
- 미매치

### 6.3 어떤 규칙이 우선하냐

한 제목에 여러 규칙이 동시에 맞을 수 있다.

예시:

- contains 규칙: `반도체`
- and 규칙: `반도체, 용인, 노가다`
- 제목: `반도체 용인이나 가서 노가다나 쳐해라`

이 경우 기준은:

- **더 구체적인 규칙 하나만 선택**

권장 specificity score:

- contains: `normalizedTitle.length`
- and: `normalizedTokens 길이 합 + 토큰 개수 가산`

예시:

- contains `반도체` 길이 3
- and `노가다|반도체|용인` 길이 합 8 + 토큰 3개
- and 규칙이 더 구체적 -> and 선택

이유:

- 로그에 더 정확한 규칙이 남는다
- 한 제목이 여러 rule group에 중복 집계되는 걸 막는다

---

## 7. 기존 플로우와의 연결에서 절대 바꾸면 안 되는 점

핵심은 **`handleImmediateTitleBanRows()`만 확장하되, 기존 흐름의 보호 장치는 그대로 유지**하는 것이다.

관련 코드:

- 직차단 진입: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L459)
- 현재 매칭 함수: [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/uid-warning-autoban/scheduler.js#L984)

현재:

1. 규칙 정규화
2. row 제목 정규화
3. `findImmediateTitleMatchedRule()`로 하나 찾음
4. `processedImmediatePostNos`에 넣음
5. recent-skip 확인
6. group에 모음
7. `executeBan()` 실행

바뀐 뒤에도 유지해야 하는 점:

1. 규칙 정규화 단계만 `contains + and`로 확장
2. 매칭 함수만 `contains + and` 평가로 확장
3. **`processedImmediatePostNos.add(postNo)`의 위치는 그대로 유지**
4. group key만 `matchedRule.ruleKey`로 교체
5. 이후 `executeBan()` 경로는 그대로 재사용

중요한 이유:

- 제목 직차단 글은 UID 경로로 중복 진입하면 안 된다
- 심지어 recent-skip으로 이번 cycle 제재를 안 하더라도, **그 글 자체를 UID 경로로 다시 흘리는 건 현재 설계와 다르다**
- 이 부분을 건드리면 기존 보호 흐름이 바뀐다

쉽게 말하면:

- `AND`는 **새 매칭 타입**이지
- **새 후속 처리 플로우**가 아니다

---

## 8. 수정 대상 파일과 실제 변경 범위

### 8.1 `features/uid-warning-autoban/parser.js`

수정 내용:

- `normalizeImmediateTitleBanRules()`를 구조화
- 문자열, 구버전 object, 신버전 object를 모두 정규화 가능하게 확장
- 새 helper 추가

추천 helper:

- `normalizeImmediateTitleBanRule(rawRule)`
- `normalizeImmediateTitleBanAndTokens(rawTitleOrTokens)`
- `buildImmediateTitleRuleKey(rule)`

주의:

- AND token dedupe는 **정규화 후** 해야 한다
- AND token sort도 **정규화 후** canonical 순서로 해야 한다

### 8.2 `features/uid-warning-autoban/scheduler.js`

수정 내용:

- `findImmediateTitleMatchedRule()`를 구조화
- `contains`/`and` 둘 다 평가
- specificity score로 우선순위 선택
- `matchedGroups` key를 `ruleKey`로 변경
- 로그 문구를 타입 중립적으로 변경

추천 helper:

- `matchesImmediateTitleRule(rule, normalizedTitle)`
- `getImmediateTitleRuleSpecificity(rule)`
- `getImmediateTitleRuleLogLabel(rule)`

### 8.3 `popup/popup.html`

수정 내용:

- 기존 `금칙 제목 추가` 옆에
- `AND 키워드 추가` 버튼 하나 추가
- 도움말 문구에 AND 예시 추가

예시 문구:

- `AND 규칙은 쉼표(,)로 구분된 키워드가 제목에 모두 포함될 때 매치됩니다.`
- `예: 반도체, 용인, 노가다`

### 8.4 `popup/popup.js`

수정 내용:

- `parseUidWarningAutoBanImmediateTitleRulesValue()` 확장
- `buildUidWarningAutoBanImmediateTitleRulesValue()` 확장
- `updateUidWarningAutoBanImmediateTitleRulesEditor()` 확장
- 리스트 렌더링에 type badge 추가
- 새 `AND 키워드 추가` 버튼 이벤트 추가
- lock/unlock 경로에 새 버튼 연결

중요:

- **기존 저장값은 그대로 읽혀야 한다**
- **신규 필드(`type`, `rawTokens`, `normalizedTokens`, `ruleKey`)는 저장/복원에서 유지돼야 한다**
- 삭제 버튼의 비교 키도 `normalizedTitle`이 아니라 `ruleKey`여야 안전하다

### 8.5 `background/background.js`

큰 로직 변경은 필요 없다.

이유:

- `uidWarningAutoBan`의 `updateConfig`는 현재 `immediateTitleBanRules`를 그대로 scheduler config에 넣는다
- 정규화는 scheduler/parser 쪽에서 처리 가능하다

즉 background는 caller 그대로 유지 가능하다.

---

## 9. 하위 호환

반드시 유지해야 한다.

현재 저장값 예시:

```js
[
  { "rawTitle": "AV", "normalizedTitle": "av" },
  { "rawTitle": "삼성전자", "normalizedTitle": "삼성전자" }
]
```

이건 새 코드에서 자동으로:

```js
{
  type: 'contains',
  rawTitle: 'AV',
  normalizedTitle: 'av',
  ruleKey: 'contains:av',
}
```

처럼 읽히게 하면 된다.

즉:

- 예전 데이터 -> 그대로 동작
- 새 AND 데이터 -> 추가 기능으로 동작
- 저장/복원/삭제/렌더링에서도 기존 규칙이 사라지면 안 된다

---

## 10. 성능과 요청 영향

이 기능은 **네트워크를 더 때리지 않는다.**

이유:

- 이미 `page1` HTML은 읽고 있다
- 직차단은 현재도 그 HTML row를 한 번 순회한다
- 여기에 규칙 평가만 조금 더 늘어난다

예시:

- 기존:
  - 제목 40개 x 규칙 20개
  - `contains` 비교
- 변경 후:
  - 제목 40개 x 규칙 20개
  - 규칙에 따라 `contains` 또는 `every(token)`

즉:

- **10초 주기에서 요청 수 증가는 0**
- **CPU 문자열 비교량만 조금 증가**

현실적으로 page1 row 수가 적어서 부담은 작다.

---

## 11. 작업 전 정적 검토 체크리스트

아래가 전부 만족되면, 문서 기준 설계상 남는 blocker는 없다.

1. 문자열 규칙이 그대로 `contains`로 승격되는가
2. 구버전 object 규칙이 그대로 `contains`로 승격되는가
3. 신버전 object 규칙이 필드 손실 없이 유지되는가
4. `contains` 규칙과 `and` 규칙이 같은 `normalizedTitle`을 만들더라도 `ruleKey`로 충돌이 막히는가
5. AND 규칙 토큰 순서가 달라도 같은 규칙으로 dedupe되는가
6. AND 규칙에서 중복 토큰이 제거되는가
7. AND 규칙에서 공백 토큰이 제거되는가
8. AND 규칙에서 정규화 후 1개 토큰만 남으면 저장이 거부되는가
9. `contains` 규칙은 현재처럼 `includes()`만 타는가
10. `and` 규칙은 `every(token)`만 타는가
11. contains + and 동시 매치 시 더 구체적인 규칙 하나만 선택되는가
12. `processedImmediatePostNos.add(postNo)` 위치가 유지되는가
13. recent-skip 직차단 글이 UID 경로로 다시 들어가지 않는가
14. `matchedGroups` key가 `ruleKey` 기반으로 바뀌는가
15. remove 버튼 비교 키도 `ruleKey`로 바뀌는가
16. popup save/load에서 새 필드가 유실되지 않는가
17. popup lock/unlock 상태에서 새 버튼도 같이 잠기는가
18. 상태 UI의 규칙 개수 표시는 contains + and 전체 수를 그대로 세는가
19. 로그 문구가 contains 전용 표현으로 남지 않는가
20. background 쪽은 새 구조를 그대로 전달해도 깨지지 않는가

---

## 12. 구현 후 필수 검증 시나리오

### 12.1 기본 시나리오

1. 기존 contains 규칙이 그대로 동작하는지
2. AND 규칙이 모두 포함일 때만 동작하는지
3. AND 규칙에서 1개라도 빠지면 미동작하는지
4. contains + and 동시 매치 시 더 구체적인 규칙이 선택되는지
5. 기존 저장 규칙(JSON) 호환되는지
6. recent post action dedupe가 그대로 유지되는지
7. `processedImmediatePostNos`가 AND 직차단 글도 UID 경로에서 제외하는지

### 12.2 예시 테스트 케이스

- 규칙: `AV`
- 제목: `A​V 유출`
- 결과: 매치

- 규칙: `반도체, 용인, 노가다`
- 제목: `반도체 용인이나 가서 노가다나 쳐해라`
- 결과: 매치

- 규칙: `반도체, 용인, 노가다`
- 제목: `반도체 용인 공장 얘기`
- 결과: 미매치

- 규칙: `반도체,용인,노가다`
- 제목: `용인 반도체 노가다`
- 결과: 순서 달라도 매치

- 규칙: `반도체, 용인, 노가다`
- 제목: `반도체용인노가다`
- 결과: 매치

- 규칙: `반도체`
- 규칙: `반도체, 용인, 노가다`
- 제목: `반도체 용인이나 가서 노가다나 쳐해라`
- 결과: AND 규칙 우선

- AND 입력: `반도체, ,`
- 결과: 저장 거부

- AND 입력: `노가다, 반도체, 용인`
- AND 입력: `반도체, 용인, 노가다`
- 결과: 같은 규칙으로 dedupe

---

## 13. 결론

실제 코드 기준으로 다시 대조해보면, **이 기능은 분탕자동차단 안에 가장 자연스럽게 붙는다.**

쉽게 말하면:

- 새 fetch 없음
- 새 scheduler 없음
- 새 feature 없음
- **기존 `immediateTitleBanRules`를 `contains + and` 규칙으로 확장하면 된다**

다만 패치 전에 반드시 문서대로 지켜야 하는 조건이 있다.

- `ruleKey`를 분리할 것
- popup parser/save/load를 같이 바꿀 것
- recent-skip 시 `processedImmediatePostNos` 흐름을 건드리지 않을 것
- AND 토큰은 canonical dedupe/sort를 할 것

이 조건까지 포함하면, 현재 코드 기준으로 보이는 구조적 blocker는 없다.
