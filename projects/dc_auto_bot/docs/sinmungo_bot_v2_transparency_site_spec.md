# DC Auto Bot - 신문고 봇 v2 공개형 투명성 웹사이트 스펙

## 1. 목표

이 문서는 신문고 봇 v2에서 **공개형 투명성 웹사이트**를 구축할 때 필요한 스펙을 정리한다.

목표는 아래와 같다.

- 신고받은 게시물이 어떤 이유로 삭제 승인/반려/검토 판정을 받았는지 공개한다.
- 운영자가 내부적으로만 보는 대시보드가 아니라, **누구나 볼 수 있는 공개 페이지**를 만든다.
- 운영 판단 근거를 공개해 권력 남용이라는 의심을 줄인다.
- 단, 공개에 적합하지 않은 민감정보와 내부 운영용 데이터는 노출하지 않는다.

즉 투명성 사이트의 역할은 **공개 설명 페이지**다.

## 2. 기본 원칙

- 이 사이트는 기본적으로 **공개형**이다.
- 운영자용 내부 대시보드는 이번 범위에 포함하지 않는다.
- 공개 사이트에는 **공개용 레코드만** 노출한다.
- helper는 내부 snapshot을 받아도, 공개 사이트에는 비공개 필드를 제거한 **공개용 projection**만 저장/노출한다.
- `Gemini reason`과 `reportReason`은 공개한다.
- 제목은 일부 마스킹한다.
- 원본 이미지 URL은 공개하지 않는다.
- 원본 이미지 파일도 공개하지 않는다.
- 공개용 이미지는 **블러/모자이크 처리된 썸네일**만 사용한다.

## 3. 왜 공개형이어야 하는가

투명성 사이트를 공개형으로 두는 이유:

- 운영자가 디시 내부에서 직접 확인하는 것은 따로 가능하다.
- 문제는 운영자 내부 검토가 아니라, 외부 이용자 입장에서 **왜 이 글이 문제였는지 납득 가능한 설명**이 필요하다는 점이다.
- 따라서 이 기능은 내부용 기록실보다 **공개용 설명 페이지**가 핵심이다.

즉 이 사이트는 운영 편의보다 **외부 신뢰 확보**가 목적이다.

## 4. 전체 구조

```text
DC Auto Bot 확장
-> helper로 snapshot 전달
-> Gemini CLI 판정
-> helper가 공개용 record 생성
-> helper가 블러 썸네일 생성
-> 공개형 transparency 웹사이트 제공
```

### 4.1 확장 역할

확장은 아래를 담당한다.

- 대상 게시물 view HTML fetch
- 제목 / 본문 / 이미지 URL 파싱
- reportReason 전달
- helper에 snapshot 전달

즉 확장은 **snapshot 수집자**다.

### 4.2 helper 역할

helper는 아래를 담당한다.

- Gemini CLI 판정 수행
- 공개용 record 생성
- 이미지 블러 썸네일 생성
- 공개 API 제공
- 공개 웹 UI 제공

즉 helper는 **판정기 + 공개 record 생성기 + 공개 사이트 서버**다.

## 5. 공개 범위

### 5.1 공개할 필드

- 시간
- 게시물 번호
- 게시물 링크
- 제목 일부 마스킹 값
- `reportReason`
- `decision`
  - 삭제 승인 / 삭제 반려 / 검토 필요
- `confidence`
- `policyIds`
- `Gemini reason`
- 블러/모자이크 처리된 썸네일

### 5.2 공개하지 않을 필드

- `requestLabel`
- `rawText`
- 원본 이미지 URL
- 원본 이미지 파일
- 실제 삭제했는지 여부
- 최근 100개 체크 결과
- 개념글 체크 결과
- 내부 skip reason 코드
- 내부 action message
- 작성자 식별에 도움이 되는 민감 메타

즉 공개 사이트는 **판정 설명에 필요한 최소 필드만 공개**한다.

## 6. 공개용 레코드 스키마

공개 사이트에 노출할 최소 레코드는 아래를 권장한다.

```json
{
  "id": "uuid",
  "createdAt": "2026-03-09T12:34:56.000Z",
  "targetUrl": "https://gall.dcinside.com/...",
  "targetPostNo": "1045190",
  "publicTitle": "애초에 디시 전체에서 GPT빠는갤이 여...",
  "reportReason": "홍보",
  "decision": "allow | deny | review",
  "confidence": 0.91,
  "policyIds": ["P14"],
  "reason": "갤러리 주제와 무관한 홍보성 게시물로 판단",
  "blurredThumbnailPath": "/transparency-assets/rec-1045190-thumb.webp",
  "imageCount": 1
}
```

### 6.1 필드 의미

- `publicTitle`
  - 원문 제목을 일부 마스킹한 공개용 제목
- `reportReason`
  - 사람이 신고할 때 넣은 사유
- `reason`
  - Gemini가 판정 근거로 남긴 설명
- `blurredThumbnailPath`
  - 원본이 아닌 블러/모자이크 처리 썸네일 경로
- `imageCount`
  - 첨부 이미지 수

## 7. 내부 데이터와 공개 데이터 분리

helper는 입력으로 full snapshot을 받을 수 있다.

예:

- full title
- full bodyText
- imageUrls
- requestLabel
- rawText

하지만 공개 사이트에는 이를 그대로 쓰지 않는다.

원칙:

1. helper는 full snapshot을 받는다.
2. helper는 공개용 record를 별도로 만든다.
3. 공개 사이트와 공개 API는 공개용 record만 사용한다.

즉 **공개 사이트가 내부 snapshot 원문을 직접 읽으면 안 된다.**

## 8. 이미지 처리 정책

공개형 transparency 사이트에서 이미지 처리 원칙은 아래와 같다.

1. helper가 이미지 URL을 일시적으로 다운로드한다.
2. 작은 썸네일 크기로 리사이즈한다.
3. 블러 또는 모자이크 처리를 한다.
4. 블러된 썸네일만 저장한다.
5. 원본 파일은 즉시 삭제한다.
6. 공개 레코드에는 `blurredThumbnailPath`만 저장한다.

즉:

- 원본 이미지 URL: 비공개
- 원본 이미지 파일: 보관하지 않음
- 공개 사이트: 블러 썸네일만 노출

### 8.1 구현 방식 권장

권장:

- `sharp`

이유:

- 리사이즈가 쉽다
- blur 처리 구현이 쉽다
- webp 저장이 쉽다
- Node helper에 붙이기 쉽다

대안:

- canvas 기반 모자이크

다만 첫 구현은 `sharp`가 현실적이다.

### 8.2 referer 정책

dcimg 계열 이미지는 referer가 필요할 수 있으므로:

- helper 다운로드 시 대상 게시물 URL을 referer로 함께 보낸다.

즉 공개형 transparency를 위해서는 helper에 **이미지 다운로드 단계**가 필요하다.

## 9. 저장 방식

권장 저장 방식:

1. `SQLite`
2. `JSONL`

첫 구현 권장:

- `SQLite`

이유:

- 공개 레코드 목록/상세 조회가 쉽다
- 정렬과 pagination이 쉽다
- 나중에 공개 export가 쉬워진다
- 썸네일 경로와 메타를 같이 다루기 좋다

## 10. helper API 스펙

### 10.1 판정 API

기존 API:

```text
POST /judge
```

유지한다.

### 10.2 공개 record 저장 API

권장 endpoint:

```text
POST /record
```

역할:

- helper가 full snapshot을 받아 공개용 record를 생성/저장
- 또는 `/judge` 내부에서 판정 후 공개용 record를 저장
- 공개 대상은 실제 신고 자동 처리(`auto_report`)에서 생성된 Gemini 판정 레코드로 한정한다.
- 수동 `LLM 테스트` 결과는 공개 transparency 사이트에 저장하지 않는다.

### 10.3 공개 record 목록 API

권장 endpoint:

```text
GET /api/moderation-records
```

기능:

- 최신순 목록
- 공개용 레코드만 반환

### 10.4 공개 record 상세 API

권장 endpoint:

```text
GET /api/moderation-records/:id
```

기능:

- 공개용 단건 상세 반환

## 11. 웹 UI 스펙

### 11.1 목록 페이지

권장 경로:

```text
GET /transparency
```

표시 항목:

- 시간
- 일부 마스킹된 제목
- 블러 썸네일
- `decision`
  - 삭제 승인 / 삭제 반려 / 검토 필요
- `reportReason`
- `Gemini reason`

즉 한 화면에서:

- 게시물
- 신고 사유
- Gemini 판정
- Gemini 이유

만 직관적으로 보이면 된다.

### 11.2 상세 페이지

권장 경로:

```text
GET /transparency/:id
```

표시 항목:

- 게시물 링크
- 게시물 번호
- 일부 마스킹된 제목
- 블러 썸네일
- `reportReason`
- `decision`
- `confidence`
- `policyIds`
- `Gemini reason`

### 11.3 UI 방향

UI는 단순해야 한다.

- 검색/고급 필터는 우선순위가 낮다.
- 표형 관리 대시보드보다 카드형 공개 페이지가 맞다.
- 핵심은 “왜 승인/반려됐는지 바로 이해되는가”다.

즉 첫 구현은 **카드형 공개 페이지**를 우선한다.

## 12. 보안/공개 정책

공개형이므로 기본 전제는:

- 누구나 읽을 수 있다.
- 따라서 helper 내부 원문 데이터를 그대로 노출하면 안 된다.

공개 시 금지:

- requestLabel 공개
- rawText 공개
- 원본 이미지 URL 공개
- 원본 이미지 파일 공개
- 내부 운영 플래그 공개

공개 허용:

- reportReason
- Gemini reason
- decision
- policyIds
- confidence
- 블러 썸네일

## 13. 구현 순서 권장안

1. 공개 record 스키마 구현
2. 이미지 다운로드 + 블러 썸네일 저장 구현
3. `/record` 저장 로직 구현
4. `/api/moderation-records` 구현
5. `/transparency` 공개 카드형 페이지 구현
6. 상세 페이지 구현

## 14. 구현 전 최종 확인 필요 사항

- 제목 마스킹 길이를 몇 자로 할지
- 본문은 공개하지 않을지
- 블러 강도를 어느 정도로 할지
- 썸네일 크기를 몇 px로 할지
- 공개 record와 내부 원문 데이터를 완전히 분리 저장할지

현재 기준 권장:

- 제목 일부 마스킹
- 본문 비공개
- reportReason 공개
- Gemini reason 공개
- 블러 썸네일 공개
- 원본 URL/원본 이미지/내부 메타 비공개
