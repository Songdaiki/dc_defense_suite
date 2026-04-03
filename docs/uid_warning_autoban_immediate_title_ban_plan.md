# 분탕자동차단 제목 직차단 구현 플랜

## 목표

기존 `분탕자동차단`은 아래 조건을 모두 만족할 때만 동작한다.

1. page 1에서 같은 `uid`가 5분 burst 기준을 만족
2. `effectivePostRatio >= 90`
3. 갤로그가 게시글 비공개 + 댓글 비공개

이번 작업은 **이 기존 uid 기반 흐름은 그대로 유지**하고, 그 앞단에 **제목 기반 즉시 차단 fast-path**를 하나 더 붙이는 것이다.

즉 한 줄로 말하면:

- 지금 있는 `분탕자동차단`은 그대로 둔다
- 같은 1분 poll 안에서
- **금칙 제목이 정규화 후 포함 매치되는 page 1 글은 uid 조건과 무관하게 바로 차단/삭제**
- 그 뒤 나머지 글은 예전처럼 uid burst 로직을 계속 탄다


## 사용자 기준 기대 동작

예시:

1. page 1에 아래 제목 글이 보인다
   - `AV`
   - `신작Ꭺ᠎Ꮩ᠎`
   - `권 은 비`
   - `"배민,상품권"`
2. `분탕자동차단`이 1분 poll을 돈다
3. 제목을 정규화해서 금칙 제목 목록과 비교한다
4. 아래처럼 정규화된다
   - `AV` -> `av`
   - `신작Ꭺ᠎Ꮩ᠎` -> `신작av`
   - `권 은 비` -> `권은비`
   - `"배민,상품권"` -> `배민상품권`
5. 금칙 제목 목록에 있으면 **uid burst / 글비중 / 갤로그 비공개를 안 보고 바로 차단/삭제**
6. 그다음 page 1 나머지 글은 기존 uid 분탕자동차단 로직이 그대로 돈다

쉽게 말하면:

- `AV`, `권은비`, `배민상품권` 같은 건 **제목만 맞으면 바로**
- 그 외 나머지 분탕은 **기존 uid 조건으로**


## 왜 기존 기능과 분리해서 붙여야 하는가

현재 `분탕자동차단`은 page 1 HTML을 통째로 받아온 뒤,
`uid` 기준으로 묶어서 burst/글비중/갤로그 비공개를 본다.

관련 코드:

- fetch: [features/uid-warning-autoban/api.js](../features/uid-warning-autoban/api.js)
- parser: [features/uid-warning-autoban/parser.js](../features/uid-warning-autoban/parser.js)
- scheduler: [features/uid-warning-autoban/scheduler.js](../features/uid-warning-autoban/scheduler.js)

즉 현재 구조는:

1. page 1 HTML fetch
2. row 파싱
3. uid별 그룹핑
4. burst 판정
5. 글비중 판정
6. 갤로그 비공개 판정
7. 제재

그런데 이번 기능은 성격이 다르다.

- uid가 없어도 제목만 맞으면 바로 자르고 싶다
- gallog/stats 조회까지 기다릴 필요가 없다
- 한 번의 poll에서 최대한 빨리 처리하고 싶다

그래서 **uid loop 안에 억지로 끼우면 안 되고**, page 1 row 파싱 직후에 **제목 직차단 fast-path**를 하나 더 두는 게 맞다.


## 현재 구현 기준에서 꼭 알아야 하는 제약

### 1. 지금 parser는 uid 없는 row를 버린다

현재 `parseUidWarningAutoBanRows()`는 `data-uid`가 없으면 row를 버린다.

즉 예시:

- `uid 있는 반고닉/고닉 글` -> 현재 parser에 들어감
- `uid 없는 순수 IP 글` -> 현재 parser에 안 들어감

이번 제목 직차단은 **제목만 보고 바로 자르는 기능**이므로,
이 경로를 진짜로 붙이려면 `uid` 없는 row도 제목 판정 대상으로 볼 수 있어야 한다.

권장 방향:

1. 기존 `parseUidWarningAutoBanRows()`는 유지
2. 별도 `parseImmediateTitleBanRows()`를 추가하거나
3. 더 좋게는 공용 `parseBoardRowsForPage1()`를 만든 뒤
   - uid autoban 경로는 `hasUid === true`만 사용
   - 제목 직차단 경로는 page 1 일반 row 전체 사용

즉 **기존 uid 전용 parser를 망가뜨리지 않고, 제목 fast-path용 row 범위만 넓게 가져가는 구조**가 맞다.

### 2. 지금 `분탕자동차단`은 사용자 설정 UI가 없다

현재 popup 카드에는:

- ON/OFF 토글
- 통계 초기화

만 있고,

- 금칙 제목 추가/삭제
- 설정 저장

은 없다.

관련 UI:

- [popup/popup.html](../popup/popup.html)
- [popup/popup.js](../popup/popup.js)

즉 이번 작업은 제목 필터만 추가하는 게 아니라,
**금칙 제목 리스트를 관리하는 UI/저장/복원까지 같이 들어가야 한다.**

### 3. 지금 `분탕자동차단`은 숨은 config를 일부러 안 저장한다

현재 `buildPersistedConfig()`는 아래만 저장한다.

- `galleryId`
- `galleryType`
- `baseUrl`

즉 예전 hidden threshold가 다시 덮어쓰는 문제를 막으려고, 사용자에게 노출되지 않는 값은 일부러 저장에서 뺐다.

그래서 이번에 **사용자가 직접 추가하는 금칙 제목 목록**을 넣으려면,
이건 hidden default가 아니라 **명시적 사용자 설정**이므로 별도로 persisted config에 포함해야 한다.

즉 문서 기준 원칙은:

- burst threshold 같은 숨은 기준값은 여전히 저장하지 않음
- **제목 직차단 리스트처럼 사용자가 직접 넣는 설정만 저장함**

### 4. 지금 popup에는 `분탕자동차단` 설정 저장 wiring 자체가 없다

현재 popup에서 `분탕자동차단`은:

- ON/OFF 토글
- 통계 초기화

만 있다.

즉 지금은:

- 금칙 제목 추가/삭제
- 설정 저장
- 입력 중 dirty tracking

을 처리하는 경로가 없다.

실제 코드 기준으로 같이 필요한 것:

1. `DIRTY_FEATURES.uidWarningAutoBan`
2. `getFeatureConfigInputs('uidWarningAutoBan')`
3. `syncFeatureConfigInputs('uidWarningAutoBan', ...)`
4. popup save 버튼
5. `applyAutomationLocks()`에서 add/remove/save 버튼 disable 처리

쉽게 말하면:

- 리스트 UI만 만들면 끝이 아니고
- **저장, 새로고침 후 복원, 실행 중 잠금까지 같이 붙어야 한다**

### 5. 지금 background `updateConfig`에는 uid autoban normalize branch가 없다

현재 background는 `updateConfig`를 generic하게 처리하지만,
feature별로 필요하면 저장 전에 normalize를 먼저 태운다.

예시:

- `hanRefreshIpBan`
- `conceptPatrol`

그런데 `uidWarningAutoBan`은 지금 별도 normalize branch가 없다.

즉 제목 리스트를 그대로 넣어버리면:

- 공백만 있는 항목
- 정규화 후 빈 문자열이 되는 항목
- 같은 `normalizedTitle` 중복

같은 게 **저장 직후 런타임 config에 그대로 들어갈 수 있다.**

권장 방향:

1. `features/uid-warning-autoban/scheduler.js`의 `normalizeConfig()`를 export
2. background `updateConfig`에서 `uidWarningAutoBan`도 저장 전에 normalize

쉽게 말하면:

- 재시작 후 `loadState()`에서만 정리되게 두지 말고
- **저장 직후부터 바로 정상화된 config를 쓰게 해야 한다**

### 6. 현재 status 필드는 uid 중심이라 제목 직차단 메타를 그대로 담기 어렵다

현재 status 필드는 이름부터 uid 기준이다.

예시:

- `lastTriggeredUid`
- `lastTriggeredPostCount`
- `lastBurstRecentCount`
- `totalTriggeredUidCount`

그런데 제목 직차단은:

- uid가 없을 수도 있고
- 한 번에 여러 제목이 섞일 수도 있고
- uid trigger와 의미가 다르다

그래서 권장 방향은:

1. 기존 uid 메타는 유지
2. 제목 직차단용 메타를 별도로 추가

예시:

```js
lastImmediateTitleBanCount
lastImmediateTitleBanMatchedTitle
totalImmediateTitleBanPostCount
recentImmediatePostActions
```

즉 **제목 직차단을 기존 uid 메타에 억지로 우겨 넣지 말고, 별도 상태로 관리**하는 게 맞다

### 7. `resetStats`도 제목 직차단 상태를 같이 지워야 한다

현재 background의 `uidWarningAutoBan resetStats`는:

- logs
- recentUidActions
- uid 관련 카운트

만 초기화한다.

제목 직차단을 넣으면 아래도 같이 초기화해야 한다.

- `recentImmediatePostActions`
- 제목 직차단 관련 last/total 카운트

즉 안 그러면:

- 통계는 초기화했는데
- 제목 직차단 dedupe만 남아서
- 다음 poll에서 왜 안 치는지 헷갈릴 수 있다

### 8. 현재 `createUidBanTargetPosts()`는 uid 없는 글에 그대로 쓰면 안 된다

현재 target builder는 사실상 uid autoban 전용이다.

예시:

- `hasUid: true`
- `uid`
- `writerToken = uid`

를 전제로 만든다.

그런데 제목 직차단은:

- `uid 없는 IP 글`
- 또는 `uid 정보가 없는 일반 row`

도 대상으로 잡을 수 있어야 한다.

즉 권장 방향은:

1. `createUidBanTargetPosts()`는 그대로 두고
2. 제목 직차단용 `createImmediateTitleBanTargetPosts()`를 별도로 만든다

쉽게 말하면:

- 현재 빌더를 억지로 재사용해서 `hasUid: true`인 척 만드는 것보다
- **제목 직차단용 target builder를 따로 두는 게 안전하다**

### 9. background는 이미 `uidWarningAutoBan updateConfig`도 잠글 수 있다

현재 background 수동 잠금 로직은 `start/stop/resetStats`만 막는 게 아니라,
`updateConfig`도 같이 막는다.

즉 예시:

- 감시 자동화가 공격 중
- 또는 IP 차단 실행 중

이면 제목 리스트 저장도 background에서 거절될 수 있다.

이건 장점이기도 하다.

즉 문서 기준 권장 방향은:

1. popup에서 save/add/remove 버튼을 disable 처리해 사용자에게 먼저 막아주고
2. background는 기존 `updateConfig` 잠금으로 한 번 더 보호

쉽게 말하면:

- **UI 잠금 + background 잠금 둘 다 맞춰야 한다**


## 원하는 UX

`분탕자동차단` 카드 안에, `신문고 봇`의 `신뢰 사용자`처럼 리스트형 UI를 둔다.

예시:

1. 입력창에 `AV`
2. `금칙 제목 추가` 버튼 클릭
3. 아래 리스트에 `AV`가 보임
4. 입력창에 `배민상품권`
5. 추가
6. 리스트에 `AV`, `배민상품권` 두 개가 보임
7. 필요 없으면 각 항목 오른쪽 `삭제` 버튼으로 제거

권장 UI:

1. `분탕자동차단` 카드 하단에 `<details>` 섹션 추가
2. 제목:
   - `제목 직차단 금칙어`
3. 입력:
   - `금칙 제목 입력`
   - `추가` 버튼
4. 리스트:
   - 등록된 금칙 제목 목록
   - 각 항목별 `삭제`
5. 안내 문구:
   - `띄어쓰기/쉼표/따옴표 등을 제거하고 한글/영문 기준 포함 매치로 비교합니다.`

즉 사용자 체감은 `신문고 봇 신뢰 사용자`와 비슷하게 간다.


## 금칙 제목 비교 규칙

### 목표

제목에 들어간:

- 띄어쓰기
- 쉼표
- 따옴표
- 마침표
- 특수문자
- zero-width/invisible 문자

같은 걸 최대한 제거하고,
**한글/영문 기준으로 정규화한 뒤 포함 매치** 한다.

### 권장 정규화 순서

1. 원본 제목을 문자열로 받는다
2. `NFKC` 정규화
3. zero-width / formatting 문자 제거
4. 영문은 소문자화
5. 자주 보이는 `A/V` 혼동문자는 ASCII로 치환
6. 마지막으로 `가-힣`, `a-z`만 남기고 전부 제거

예시:

- `AV` -> `av`
- `A V` -> `av`
- `"A,V"` -> `av`
- `권 은 비` -> `권은비`
- `"배민,상품권"` -> `배민상품권`
- `신작Ꭺ᠎Ꮩ᠎` -> `신작av`

### 왜 `A/V` 혼동문자 치환이 필요한가

`신작Ꭺ᠎Ꮩ᠎` 같은 케이스는
그냥 공백/쉼표만 제거하면 `신작av`가 안 된다.

즉 이 기능에서 중요한 건:

- 단순 문장부호 제거만으로 끝내지 말고
- `AV` 계열에 자주 섞이는 혼동문자도 최소한의 매핑을 둬야 한다

권장 v1:

- `A` 계열 혼동문자 몇 개
- `V` 계열 혼동문자 몇 개

만 먼저 소규모 표로 매핑한다.

즉 예시:

- `Ꭺ` -> `a`
- `Ꮩ` -> `v`

나중에 공격 패턴이 늘어나면 이 표를 확장한다.

### 비교 방식

v1은 **정규화 후 substring 포함 검사**로 시작한다.

예시:

- 금칙 제목 `권은비`
- `권 은 비` -> `권은비` -> 매치
- `권은비짤` -> `권은비짤` -> **미매치**

이유:

- 처음부터 contains로 가면 오탐이 너무 커질 수 있다
- 정규화 후 포함 매치면 지금 요청한 유형을 바로 잡을 수 있다


## 설정 데이터 형태

권장 저장 구조:

```js
immediateTitleBanRules: [
  {
    rawTitle: 'AV',
    normalizedTitle: 'av',
  },
  {
    rawTitle: '배민상품권',
    normalizedTitle: '배민상품권',
  },
]
```

원칙:

1. `rawTitle`
   - 사용자가 입력한 원문
   - UI에 그대로 보여주기용
2. `normalizedTitle`
   - 실제 비교용 canonical key
3. 중복 판정은 `normalizedTitle` 기준

예시:

- `AV`
- `A V`
- `"A,V"`

이 셋은 모두 `normalizedTitle = 'av'`가 되므로,
리스트에는 **1개만 남긴다.**


## scheduler에 붙이는 위치

가장 자연스러운 위치는 `runCycle()` 초반이다.

현재 흐름:

1. page 1 HTML fetch
2. rows 파싱
3. uid 그룹핑
4. uid loop

권장 변경 후:

1. page 1 HTML fetch
2. **제목 직차단용 rows 파싱**
3. **금칙 제목 immediate ban 후보 선별**
4. **즉시 차단/삭제 1회 실행**
5. 즉시 처리한 postNo는 제외
6. 남은 rows로 기존 uid autoban 흐름 계속

즉 예시:

- page 1에 `AV` 글 2개가 있음
- 먼저 그 2개를 즉시 제재
- 그리고 나머지 row만 가지고
  - 5분 burst
  - 글비중
  - 갤로그 비공개
  를 본다

이렇게 하면 같은 사이클에서 같은 글을 두 번 치지 않는다.


## 왜 같은 사이클 중복 제재를 막아야 하는가

예시:

1. `AV` 글이 금칙 제목이라 immediate ban 경로에 걸림
2. 그런데 그 글의 uid가 기존 burst 조건도 만족함
3. 그러면 immediate path와 uid path가 같은 postNo를 둘 다 제재하려고 할 수 있음

이건 로그도 더러워지고, 같은 API를 같은 글에 또 치는 꼴이 된다.

권장 방식:

1. immediate ban 성공/실패 여부와 관계없이
2. 그 사이클에서 이미 fast-path로 본 `postNo`를 `processedImmediatePostNos`에 넣고
3. uid autoban용 rows는 `processedImmediatePostNos`를 제외한 뒤 그룹핑

즉 같은 poll 안에서는 제목 직차단과 uid 직차단이 서로 겹치지 않게 한다.


## 중복 재시도 방지

현재 uid autoban에는 `recentUidActions`가 있다.
하지만 제목 직차단은 `uid`가 아니라 **postNo** 기준으로 막는 게 더 자연스럽다.

권장 추가 상태:

```js
recentImmediatePostActions: {
  "1079551": {
    success: true,
    actedAt: "2026-04-03T10:22:00.000Z",
  }
}
```

예시:

1. 12:00 poll에서 `AV` 글 `#1079551` 제재
2. 12:01에도 page 1에 아직 남아 있음
3. 같은 글번호면 다시 안 침

반대로:

1. 12:02에 `AV` 새 글 `#1079569` 올라옴
2. 새 글번호니까 다시 immediate ban 대상

즉 제목 직차단은 **postNo 단위 dedupe**가 맞다.


## 제재 방식

제재 자체는 새 API를 만들지 않고,
기존 `executeBanWithDeleteFallback()`를 그대로 쓴다.

즉 예시:

- immediate title ban 3건 잡힘
- posts 배열로 한 번에 executor 호출
- 삭제 한도 걸리면 기존처럼
  - 계정 전환 fallback
  - 안 되면 ban-only

즉 기존 검증된 삭제/차단 경로를 재사용한다.

### reason 문구

v1은 기존 `분탕자동차단`의 reason 문구를 그대로 재사용하는 걸 권장한다.

현재 기본값:

- `깡계분탕`

이유:

- 제목 직차단만 별도 reason을 또 노출하면 UI가 불필요하게 커진다
- 같은 feature 안의 immediate path이므로 우선 같은 사유를 재사용해도 충분하다


## page 1 HTML 정보 활용 범위

제목 직차단은 page 1 HTML을 이미 가져온 뒤, 그 안의 row 정보를 재사용하면 된다.

즉 추가 fetch는 필요 없다.

활용 필드:

- `postNo`
- `title`
- `data-type`
- `uid`
- `nick`
- `gall_date title`

중요:

- 즉시 제목 차단은 `icon_pic` 여부와 무관하게 제목만 본다
- 즉 이미지글이라도 제목이 금칙어면 바로 제재 대상이 될 수 있다

예시:

- 이미지글 제목이 `권은비`
- `icon_pic`
- 그래도 제목 직차단 대상

즉 `icon_pic 제외`는 기존 uid burst 계산에만 남기고,
제목 직차단은 **제목만 본다.**


## popup 구현 방향

### 권장 UI 배치

현재 `분탕자동차단` 카드 안에 아래를 추가한다.

1. `<details>` 제목:
   - `제목 직차단 금칙어`
2. 입력창 1:
   - `금칙 제목`
3. 버튼:
   - `추가`
4. 리스트:
   - 등록된 금칙 제목
   - 각 항목 `삭제`
5. 저장 버튼:
   - `분탕자동차단 설정 저장`

즉 `신문고 봇 신뢰 사용자` UX를 거의 그대로 가져가되,
대상만 `user_id + label` 대신 `rawTitle`로 바꾼다.

### popup 상태 표시

권장 추가 메타:

- `제목 직차단 금칙어 N개`

예시:

- 금칙 제목 4개 등록됨
- 상태 문구: `제목 직차단 금칙어 4개 / 기존 uid 분탕자동차단 동시 적용`

### popup에서 같이 반영해야 하는 실제 포인트

실제 코드 기준으로 아래도 같이 건드려야 한다.

1. `FEATURE_DOM.uidWarningAutoBan`에
   - 입력창
   - 추가 버튼
   - 저장 버튼
   - 리스트 DOM
   - 새 카운트/메타 DOM
   를 추가
2. `updateUidWarningAutoBanUI()`가 새 상태값을 렌더
3. `buildDefaultUidWarningAutoBanStatus()`에 새 기본 필드 추가
4. `buildUidWarningAutoBanMetaText()` 문구를 기존 uid 조건 + 제목 직차단 조건을 둘 다 설명하도록 수정

쉽게 말하면:

- UI를 붙이면 끝이 아니라
- **상태 기본값, 렌더 함수, 메타 문구도 같이 따라와야 한다**


## background wiring

현재 `uidWarningAutoBan`은 popup에서

- `start`
- `stop`
- `resetStats`

만 쓰고 있다.

즉 이번 작업엔 `updateConfig` UI 경로를 추가해야 한다.

필요한 것:

1. popup save 버튼
2. `sendFeatureMessage('uidWarningAutoBan', { action: 'updateConfig', config })`
3. background에서 `uidWarningAutoBan` config normalize branch 추가
4. `saveState()`로 persisted config 반영

### 왜 normalize branch가 필요한가

현재 background `updateConfig`는 feature마다 필요하면 normalize를 먼저 태운다.

예시:

- `hanRefreshIpBan`
- `conceptPatrol`

같은 feature는 저장 전에 normalize를 탄다.

`uidWarningAutoBan`도 사용자 리스트 입력이 들어오면:

- 배열 정리
- 문자열 trim
- normalizedTitle dedupe
- 빈값 제거

를 background 쪽에서 한 번 정리해주는 게 맞다.

### 실제 코드 기준으로 이미 있는 경로

중요:

- 새 action을 만들 필요는 없다
- 현재 background generic `updateConfig` 경로를 그대로 재사용하면 된다

즉 이번 작업에서 필요한 건:

1. popup save 버튼
2. `sendFeatureMessage('uidWarningAutoBan', { action: 'updateConfig', config })`
3. background `uidWarningAutoBan` normalize branch

이지,

- 별도 message action을 새로 만드는 것

까지는 아니다


## 저장/복원 원칙

중요:

- 현재 `uidWarningAutoBan`은 숨은 threshold를 저장하지 않는 구조가 맞다
- 그 원칙은 유지한다

대신 이번에 추가하는 건 **사용자가 직접 넣은 제목 리스트**이므로,
이건 persisted config에 포함해야 한다.

즉 저장 원칙은:

1. 기존 hidden default:
   - 저장 안 함
2. 사용자 추가 금칙 제목:
   - 저장함

권장 persisted config 예시:

```js
{
  galleryId,
  galleryType,
  baseUrl,
  immediateTitleBanRules,
}
```

그리고 runtime state 쪽엔 아래가 추가로 필요하다.

```js
recentImmediatePostActions
lastImmediateTitleBanCount
totalImmediateTitleBanPostCount
```

즉 **config와 runtime state를 섞지 말고 분리**하는 게 맞다.


## 권장 구현 단계

### 1단계. parser 기반 만들기

1. page 1 일반 row 전체를 다루는 공용 parser 추가
2. uid autoban 전용 parser는 그 위에서 `hasUid === true`만 쓰도록 유지

### 2단계. normalization helper 추가

1. `normalizeImmediateTitleBanValue(rawTitle)`
2. `normalizeImmediateTitleBanRules(rules)`
3. `buildImmediateTitleBanKey(title)`

### 3단계. scheduler fast-path 추가

1. page 1 rows 파싱
2. 제목 직차단 후보 추림
3. executor 호출
4. 처리한 postNo 제외
5. 기존 uid 흐름 계속

### 4단계. popup UI 추가

1. 입력창
2. 추가 버튼
3. 리스트 렌더
4. 삭제 버튼
5. 설정 저장 버튼

### 5단계. background 저장/복원 연결

1. `updateConfig`
2. normalize
3. persisted config 확장


## 예시 동작

예시 A:

- 금칙 제목 목록:
  - `AV`
  - `배민상품권`
- page 1 제목:
  - `A V`
  - `배민,상품권`
  - `일반글`

결과:

- `A V` -> `av` -> 즉시 차단/삭제
- `배민,상품권` -> `배민상품권` -> 즉시 차단/삭제
- `일반글` -> 기존 uid autoban 흐름으로만 감시

예시 B:

- 금칙 제목 목록:
  - `신작AV`
- page 1 제목:
  - `신작Ꭺ᠎Ꮩ᠎`

결과:

- 혼동문자 치환 후 `신작av`
- 즉시 차단/삭제

예시 C:

- 금칙 제목 목록:
  - `권은비`
- page 1 제목:
  - `권은비짤`

결과:

- 정규화 후 `권은비짤`
- 포함 매치 아님
- 즉시 차단 안 함


## 엣지케이스

1. 금칙 제목 리스트가 비어 있으면 immediate path는 no-op
2. 같은 제목을 다른 표기(`AV`, `A V`, `"A,V"`)로 여러 번 넣으면 1개만 유지
3. 금칙 제목으로 즉시 처리한 글은 같은 사이클에서 uid autoban이 다시 안 건드림
4. 같은 postNo가 다음 1분 poll에도 남아 있으면 postNo dedupe로 재처리 안 함
5. 새 글번호로 다시 올라오면 다시 immediate 대상
6. `uid` 없는 글도 제목 직차단 대상에 포함할 수 있어야 함
7. `icon_pic`는 제목 직차단에서 제외하지 않음
8. 삭제 한도 걸리면 기존처럼 ban-only로 내려감
9. 즉시 제목 차단과 기존 uid autoban이 동시에 켜져도 토글은 여전히 하나
10. 제목 직차단 실패가 나도 그 사이클 uid autoban은 계속 돈다


## 실제 코드 대조 기준 최종 확인사항

구현 전에 실제 코드와 대조해서 걸리는 포인트를 다시 정리하면 이렇다.

1. **parser 분리 필요**
   - 현재 uid parser는 `uid` 없는 row를 버리므로 제목 직차단용 row parser가 별도로 필요하다
2. **popup 저장 경로 추가 필요**
   - 지금은 토글/초기화만 있어서 제목 리스트를 저장할 수 없다
3. **background normalize 필요**
   - 저장 직후 런타임 config를 바로 정상화해야 한다
4. **status 필드 분리 필요**
   - uid 카운트와 제목 직차단 카운트를 같은 필드에 섞지 않는 게 맞다
5. **same-cycle 중복 제재 방지 필요**
   - immediate path에서 처리한 `postNo`는 uid path에서 제외해야 한다
6. **resetStats 범위 확장 필요**
   - 제목 직차단 dedupe/state도 같이 비워야 한다
7. **target builder 분리 필요**
   - uid 전용 target builder를 그대로 쓰면 `hasUid: true` 같은 잘못된 값이 들어갈 수 있다
8. **설명 문구 갱신 필요**
   - popup 카드 설명과 meta 문구가 새 fast-path를 설명해야 한다
9. **UI 잠금과 background 잠금 동기화 필요**
   - popup에서 save/add/remove를 막아도 background `updateConfig` 잠금 기준과 맞아야 한다

한 줄로:

- **제목 직차단 기능 자체는 현재 구조에 무리 없이 붙일 수 있다**
- 다만 실제 코드 기준으로는
  - parser
  - popup save wiring
  - background normalize
  - runtime state 분리
  - target builder 분리
  이 다섯 축을 같이 손봐야 반쪽짜리 구현이 안 된다


## 권장 결론

이번 기능은 **새 토글을 또 만드는 게 아니라**, 기존 `분탕자동차단` 안에 **제목 직차단 fast-path를 하나 추가하는 방식**이 가장 맞다.

즉 최종 구조는:

1. `분탕자동차단` ON
2. page 1 HTML fetch
3. **금칙 제목 immediate ban 먼저**
4. 남은 글에 대해 **기존 uid burst/gallog/autoban 그대로**

그리고 UI는 `신문고 봇 신뢰 사용자`처럼

- 입력
- 추가
- 목록
- 삭제

형태로 가는 게 가장 직관적이다.

한 줄로 정리하면:

- **기존 uid 분탕자동차단은 그대로 유지**
- **그 앞에 제목 포함-매치 직차단을 추가**
- **금칙 제목은 사용자가 popup에서 직접 추가/삭제**
- **동일 page 1 poll 안에서 먼저 제목 직차단, 그다음 기존 uid 차단**
