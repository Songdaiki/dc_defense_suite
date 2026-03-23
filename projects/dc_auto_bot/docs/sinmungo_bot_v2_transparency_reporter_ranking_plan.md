# DC Auto Bot - 공개 투명성 사이트 `특갤봇 랭킹` 구현 계획

## 1. 목표

이 문서는 공개 transparency 사이트에 **신고자 활동 랭킹**을 추가할 때의 구현 계획을 정리한다.

표시 이름은 아래로 고정한다.

- `특갤봇 랭킹`

이 랭킹의 목적은 단순 장식이 아니다.

- 누가 실제로 신고 활동을 많이 했는지 공개한다.
- 누가 실제로 삭제 승인까지 많이 연결했는지 공개한다.
- 신뢰할 수 있는 신고 참여를 더 활발하게 만든다.

## 2. 중요한 전제

### 2.1 지금 record만으로는 과거 랭킹 불가

현재 공개 transparency record에는 아래 필드만 저장된다.

- `createdAt`
- `targetPostNo`
- `publicTitle`
- `reportReason`
- `decision`
- `reason`

하지만 **누가 신고했는지**를 식별하는 필드는 저장되지 않는다.

즉:

- 지금까지 이미 저장된 transparency record만으로는 신고자 랭킹을 만들 수 없다.
- 랭킹은 **새 필드 추가 이후부터 쌓이는 record 기준**으로만 가능하다.

이건 현재 실제 저장 스키마 기준 사실이다.

- `helper/db.mjs`의 `normalizePublicModerationRecord()`
- `background/scheduler.js`의 `buildTransparencyRecord()`
- `background/background.js`의 `buildTransparencyRecord()`

### 2.2 그래도 구현 비용은 낮다

신고자 정보는 이미 런타임에서 알고 있다.

자동 신고 처리 흐름에서 각 명령 댓글은 먼저 **신뢰된 신고자(trusted user)** 인지 확인된다.

이때 이미 아래 값이 있다.

- `trustedUser.userId`
- `trustedUser.label`

즉 필요한 건 새로운 fetch가 아니라:

1. 기존 런타임 값 저장
2. helper DB에 필드 추가
3. transparency UI에서 집계/렌더

정도다.

## 3. 실제 코드 기준 현재 상태

### 3.1 신고자 식별값은 이미 런타임에 존재

자동 댓글 처리 루프에서:

- `isTrustedUser(comment, this.config.trustedUsers)`로 신고자 매칭
- 결과로 `trustedUser.userId`, `trustedUser.label` 확보

관련 파일:

- `projects/dc_auto_bot/background/parser.js`
- `projects/dc_auto_bot/background/scheduler.js`

### 3.2 transparency record 생성 시 현재는 신고자 정보를 버림

현재 record 생성부는 아래 정보만 넣고 있다.

- `source`
- `status`
- `targetUrl`
- `targetPostNo`
- `reportReason`
- `title`
- `bodyText`
- `imageUrls`
- `decision`
- `confidence`
- `policyIds`
- `reason`

즉 `reporterUserId`, `reporterLabel`이 없다.

관련 파일:

- `projects/dc_auto_bot/background/scheduler.js`
- `projects/dc_auto_bot/background/background.js`
- `projects/dc_auto_bot/helper/db.mjs`

### 3.3 transparency 목록 페이지는 현재 랭킹 UI가 없음

현재 공개 페이지는 아래만 렌더한다.

- 상단 요약 통계
- 판정 필터 탭
- 처리 목록 테이블
- 우측 sidebar 요약

관련 파일:

- `projects/dc_auto_bot/helper/transparency.mjs`
- `projects/dc_auto_bot/helper/server.mjs`

즉 랭킹 UI는 새로 추가해야 한다.

## 4. 무엇을 랭킹으로 볼 것인가

이번 기능은 **작성자 랭킹**이 아니라 **신고자 랭킹**이다.

집계 대상:

- `source === "auto_report"` record만 포함

제외 대상:

- `manual_test`
- 내부 디버그용 테스트 record

이유:

- 수동 LLM 테스트는 실제 신고 활동이 아니다.
- 랭킹 취지와 안 맞는다.

## 5. 랭킹 키 설계

### 5.1 집계 키는 `reporterUserId`

집계 키를 `reporterLabel`로 쓰면 안 된다.

이유:

- 표시 이름은 바뀔 수 있다.
- 같은 사람이 label을 바꾸면 기록이 둘로 찢어진다.

따라서:

- 내부 집계 키: `reporterUserId`
- 화면 표시용 이름: `reporterLabel`

으로 분리한다.

### 5.2 표시 이름은 최신 label 우선

같은 `reporterUserId`에 여러 label이 섞일 수 있다.

이번 구현에서는 아래 규칙을 권장한다.

1. 같은 `reporterUserId`의 record를 시간순으로 본다.
2. 가장 최근 record의 `reporterLabel`을 표시 이름으로 쓴다.
3. 비어 있으면 `reporterUserId`를 대신 표시한다.

## 6. record 스키마 추가 필드

공개 transparency record에 아래 두 필드를 추가한다.

```json
{
  "reporterUserId": "trusted_user_id",
  "reporterLabel": "상냥한에옹"
}
```

의미:

- `reporterUserId`
  - 내부 집계 기준 키
- `reporterLabel`
  - 공개 페이지 표시명

## 7. 저장 경로 변경

### 7.1 자동 신고 흐름

자동 신고 처리에서 아래 지점마다 `buildTransparencyRecord()` 호출이 있다.

대표 흐름:

1. pending record 저장
2. 작성자 판정 실패 record 저장
3. 자동 처리 제외 record 저장
4. 개념글 제외 record 저장
5. LLM 결과 저장
6. 최종 처리 성공/실패 record 저장

이 모든 경로에 아래 필드를 같이 넣어야 한다.

- `reporterUserId: trustedUser.userId`
- `reporterLabel: trustedUser.label`

즉 어떤 상태로 끝나든, auto_report record에는 신고자 메타가 남아야 한다.

### 7.2 수동 테스트 흐름

`manual_test`는 랭킹 대상이 아니므로 아래처럼 비워도 된다.

- `reporterUserId: ''`
- `reporterLabel: ''`

또는 필드 자체를 생략해도 된다.

단, normalize 단계에서는 빈 문자열을 안전하게 허용해야 한다.

## 8. helper DB 변경

`projects/dc_auto_bot/helper/db.mjs`

`normalizePublicModerationRecord()`에 아래 필드를 추가한다.

- `reporterUserId`
- `reporterLabel`

둘 다 `normalizeOptionalString()`으로 정규화한다.

주의:

- 기존 레코드에는 필드가 없으므로 빈 문자열로 들어와도 정상 동작해야 한다.
- 즉 이 기능은 **하위 호환**이어야 한다.

## 9. 랭킹 집계 방식

### 9.1 집계 대상

아래 조건을 모두 만족하는 record만 랭킹 집계 대상:

- `source === "auto_report"`
- `reporterUserId` 존재

### 9.2 집계 항목

각 신고자별로 최소 아래 값을 계산한다.

- `totalReports`
- `allowCount`

이번 1차 UI에서는 아래 두 값만 실제로 노출한다.

- `기여횟수 = totalReports`
- `승인 수 = allowCount`

정의:

- `totalReports`
  - `source === "auto_report"` 이고 `reporterUserId`가 있는 record 수
- `allowCount`
  - 그중 `status === "completed"` 이고 `decision === "allow"` 인 record 수

중요:

- auto_report는 먼저 `pending` record를 저장하고
- 나중에 같은 `recordId`로 `completed` 또는 `failed`로 다시 upsert 된다

즉 집계는 **row 추가가 아니라 같은 record 갱신** 기준으로 움직여야 한다.

그래서:

- 신고가 처음 들어오면 `기여횟수` 후보가 생기고
- 최종 판정이 `allow`로 끝나면 그 record가 갱신되면서 `승인 수`에 반영된다

별도 이중 집계 보정 로직은 필요 없다.

### 9.3 정렬 기준

기본 정렬 기준:

1. `totalReports` 내림차순
2. 동률이면 `allowCount` 내림차순
3. 동률이면 최근 활동 시각(`lastReportedAt`) 내림차순

이유:

- “많이 활동한 사람” 기준을 가장 직관적으로 만족
- 같은 활동량이면 실제 삭제 승인까지 많이 이어진 사람이 위

## 10. UI 설계

### 10.1 이름

랭킹 섹션 이름은 고정:

- `특갤봇 랭킹`

### 10.2 위치

1차 구현 위치는 아래로 고정한다.

- `/transparency` 메인 페이지 우측 sidebar
- 기존 `운영 정책 요약` 박스 바로 아래

이유:

- 현재 목록 페이지 구조를 크게 깨지 않는다.
- 공개 페이지 진입 즉시 바로 볼 수 있다.
- 기존 sidebar box와 같은 계열 UI로 넣기 쉽다.

### 10.3 표시 항목

각 row는 아래 형식으로 고정한다.

- 순위
- 신고자 이름
- 기여횟수
- 승인 수

예:

```text
1등 상냥한에옹 기여횟수: 153 승인 수: 121
2등 특붕이A 기여횟수: 87 승인 수: 64
3등 특붕이B 기여횟수: 61 승인 수: 43
```

### 10.4 노출 개수

1차는 아래로 고정한다.

- 상위 3명만 노출
- 표시는 `1등`, `2등`, `3등`처럼 순위가 바로 보이게 한다

필요하면 나중에만 `/transparency/ranking` 별도 페이지를 추가한다.

### 10.5 UI 스타일

랭킹 박스는 현재 sidebar의 기존 박스와 최대한 비슷한 결로 맞춘다.

즉:

- `sidebar-box`
- `sidebar-box-title`
- `sidebar-box-body`

같은 계열 구조를 재사용한다.

랭킹 row는 너무 복잡하게 만들지 않고 한 줄 중심으로 간다.

예:

```text
1등 상냥한에옹 기여횟수: 153 승인 수: 121
```

즉 카드형 새 컴포넌트를 크게 만드는 게 아니라,

- 기존 sidebar box 내부에
- 3개의 ranking row를 쌓는 형태

로 간다.

## 11. 라우팅 / API

### 11.1 1차는 별도 API 없이 서버 렌더로 충분

현재 helper는 `store.listRecords()`로 목록 페이지를 렌더한다.

1차 구현은 여기서:

1. records 전체를 한 번 읽고
2. reporter ranking을 계산한 뒤
3. `renderTransparencyListPage()`에 같이 넘기는 방식

으로 충분하다.

즉 별도 `/api/reporter-ranking` 없이도 구현 가능하다.

### 11.2 이후 확장용 API

나중에 필요하면 아래 API를 추가할 수 있다.

```text
GET /api/transparency-reporter-ranking
```

하지만 1차는 오버엔지니어링이다.

## 12. 기존 record와 소급 집계

중요:

- 기존 레코드는 `reporterUserId`, `reporterLabel`이 없다.
- 따라서 랭킹은 **필드 추가 이후 생성되는 auto_report record 기준**으로만 계산된다.

운영 문구로도 이 점을 명확히 해야 한다.

예:

- `랭킹은 신고자 기록 저장 도입 이후의 데이터만 반영됩니다.`

## 13. 실제 구현 순서

1. `background/scheduler.js`
   - auto_report record 생성부에 `reporterUserId`, `reporterLabel` 추가
2. `background/background.js`
   - manual_test record 빌더는 빈 reporter 필드 허용
3. `helper/db.mjs`
   - 공개 record normalize 스키마 확장
4. `helper/server.mjs`
   - `/transparency` 렌더 직전 reporter ranking 계산
5. `helper/transparency.mjs`
   - 메인 페이지 `운영 정책 요약` 아래에 `특갤봇 랭킹` sidebar block 추가
6. 문서 업데이트
   - transparency site spec에 reporter field / ranking 노출 반영

## 14. 파생 이슈

### 14.1 label 변경

같은 사람이 label을 바꾸면 화면 표시명이 바뀔 수 있다.

해결:

- 집계는 `reporterUserId`
- 표시명은 최신 `reporterLabel`

### 14.2 탈퇴/신뢰목록 제거

trustedUsers 설정에서 제거되더라도 과거 record는 남는다.

이건 문제 아님.

- 랭킹은 “과거 실제 신고 활동 기록”을 보여주는 것이기 때문

### 14.3 수동 테스트 오염

`manual_test`를 랭킹에 포함하면 안 된다.

반드시 `source === auto_report`만 집계한다.

### 14.4 승인율 왜곡

1차 UI에는 승인율을 노출하지 않는다.

이유:

- 화면이 불필요하게 복잡해진다.
- 기여횟수 / 승인 수만으로도 충분히 직관적이다.

필요하면 나중에만 추가 검토한다.

## 15. 결론

이 기능은 구현 가능하다.

핵심 이유:

- 신고자 식별값은 이미 자동 신고 런타임에서 확보하고 있다.
- 현재 부족한 건 **그 값을 transparency record에 저장하지 않는 것**뿐이다.

즉 실제 작업은:

- record 스키마 2필드 추가
- helper 집계 함수 추가
- transparency 메인 페이지에 `특갤봇 랭킹` block 추가

로 정리된다.

과거 기록 소급은 안 되지만,

- **앞으로 쌓이는 신고 활동 기준 랭킹**

으로는 충분히 성립한다.
