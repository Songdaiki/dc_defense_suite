# DC Auto Bot - Transparency Pending 상태 문서

## 목표

이 문서는 transparency 사이트에 `검토중(pending)` 상태를 도입할 때의 동작 원칙을 정리한다.

목표는 아래와 같다.

- 신고가 접수되고 자동 처리 플로우가 시작되면 transparency 사이트에 즉시 흔적이 보이게 한다.
- LLM 판정이 오래 걸릴 때도 사용자가 `지금 검토 중인지`, `아직 기록이 안 만들어진 건지`를 구분할 수 있게 한다.
- 최종 판정이 나오면 같은 레코드를 업데이트해서 `삭제 승인 / 삭제 반려 / 검토 필요`와 `reason`을 채운다.

## 기본 아이디어

```text
신고 감지
-> snapshot 확보
-> pending 레코드 저장
-> transparency 사이트에 즉시 노출
-> LLM 판정 수행
-> 같은 레코드 update
-> 최종 decision / reason 반영
```

즉 transparency 사이트는

- `처리 시작`
- `검토중`
- `최종 판정`

세 단계를 한 레코드 안에서 연속적으로 보여준다.

## 레코드 상태

권장 상태값:

- `pending`
- `completed`
- `failed`

의미:

- `pending`
  - snapshot은 확보했고 LLM 또는 후속 처리 진행 중
- `completed`
  - 최종 판정 확정
- `failed`
  - 시스템 실패, 판정 중단, 저장 실패 등으로 완료되지 못함

## Pending 저장 시점

pending 레코드는 아래 시점에 생성한다.

1. 대상 게시물 view fetch 성공
2. 제목 / 본문 / 이미지 URL 파싱 성공
3. transparency 공개용 snapshot 생성 가능

즉 최소한

- targetUrl
- targetPostNo
- title
- bodyText
- imageUrls
- reportReason

이 확보된 뒤에 `pending`을 저장한다.

## Pending 레코드 필드

최소 예시:

```json
{
  "id": "uuid",
  "createdAt": "2026-03-10T12:34:56.000Z",
  "updatedAt": "2026-03-10T12:34:56.000Z",
  "status": "pending",
  "source": "auto_report",
  "targetUrl": "https://gall.dcinside.com/...",
  "targetPostNo": "1045667",
  "publicTitle": "[일반] 예시 제목",
  "publicBody": "",
  "reportReason": "테스트",
  "imageCount": 1,
  "blurredThumbnailPath": "/transparency-assets/....webp",
  "decision": "",
  "confidence": null,
  "policyIds": [],
  "reason": "검토중"
}
```

핵심은:

- `status = pending`
- `decision` 비움
- `reason = 검토중`

## 최종 업데이트 시점

LLM 판정이 끝나면 같은 `id`로 update 한다.

업데이트 내용:

- `status = completed`
- `decision`
- `confidence`
- `policyIds`
- `reason`
- `updatedAt`

예:

```json
{
  "id": "uuid",
  "status": "completed",
  "decision": "deny",
  "confidence": 0.98,
  "policyIds": ["NONE"],
  "reason": "운영 규정 위반 사항이 없음"
}
```

## 시스템 실패 시

다음 경우는 `failed`로 바꾼다.

- helper 연결 실패
- LLM 응답 파싱 실패
- 이미지 분석 시간 초과
- 기타 치명적 처리 실패

예:

```json
{
  "id": "uuid",
  "status": "failed",
  "reason": "Gemini 이미지 분석 시간 초과"
}
```

## UI 표시 원칙

목록 페이지에서:

- `pending` -> `검토중`
- `completed` -> 기존 `삭제 승인 / 삭제 반려 / 검토 필요`
- `failed` -> `처리 실패`

상세 페이지에서:

- pending이면 `reason` 대신 `검토중`
- completed면 최종 `reason`
- failed면 실패 사유 표시

## 자동 새로고침

pending 상태를 빨리 확인하기 위해 transparency 메인 페이지는 자동 새로고침을 둘 수 있다.

권장:

- `5초` 주기

의도:

- 새 pending 레코드가 올라오면 사용자가 직접 새로고침하지 않아도 빨리 확인 가능
- 최종 판정으로 바뀌는 것도 빠르게 보임

## 주의점

- pending 레코드는 snapshot 확보 후에만 생성한다.
- 링크 파싱 실패, 게시물 fetch 실패 같은 snapshot 이전 실패는 pending을 만들지 않는다.
- pending이 너무 오래 남으면 운영상 혼란을 주므로, timeout/실패 시 `failed`로 전환하는 것이 좋다.

## 구현 순서

1. record 스키마에 `status` 추가
2. snapshot 확보 직후 `pending` upsert
3. 판정 완료 시 같은 id로 `completed` upsert
4. 실패 시 같은 id로 `failed` upsert
5. transparency UI에 `검토중` 배지 추가
6. 메인 페이지 5초 자동 새로고침 추가
