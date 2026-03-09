# DC Auto Bot - 신문고 봇 v2 웹 자동화 정책

## 1. 목표

이 문서는 `API 기반 Gemini 호출`이 아니라, **Gemini 웹 UI와 상호작용하는 웹 자동화 helper 호출기**를 이용해 신문고 봇 v2 판단 기능을 구현하는 정책을 정리한다.

핵심 목표:
- 확장프로그램은 게시물 파싱과 운영 정책 제어를 담당한다.
- 별도 웹 자동화 helper는 Gemini 웹에 접속해 프롬프트를 입력하고 답변을 읽는다.
- 확장프로그램은 helper로부터 JSON 결과만 받아 실제 삭제/차단 여부를 결정한다.

즉 구조는 다음과 같다.

```text
DC Auto Bot 확장
-> localhost helper 호출
-> Gemini 웹 로그인 세션이 열린 브라우저 자동 조작
-> JSON 결과 수집
-> 확장으로 반환
```

## 2. 왜 이 구조를 쓰는가

이 구조는 다음 요구사항을 만족하기 위해 선택한다.

- 유료 API key 사용을 피하고 싶다.
- OAuth client / project 설정을 최소화하고 싶다.
- 사용자는 Gemini 웹에 로그인된 상태만 유지하면 된다.
- 운영자는 확장프로그램 안에서 버튼만 눌러 테스트/판정을 실행하고 싶다.

단, 이 구조는 API 방식보다 불안정하다는 점을 전제로 한다.

## 3. 기본 전제

웹 자동화 helper를 호출하기 전에 아래는 확장에서 이미 처리되어 있어야 한다.

1. 신뢰 사용자 `user_id` 검증 통과
2. 명령 문법 파싱 통과
3. 링크 dedupe 통과
4. 일일 2회 제한 통과
5. v2 core 작성자 필터 통과
   - 유동 또는 깡계(`< 100`) 또는 글편중(`글 비중 >= 0.9`)
6. 대상 게시물 제목 / 본문 / 이미지 URL 파싱 완료

즉 helper는 **파싱기**가 아니라 **Gemini 웹 상호작용기**다.

## 4. 전체 구조

### 4.1 확장프로그램 역할

확장프로그램은 아래를 담당한다.

- 신문고 댓글 폴링
- 신뢰 사용자 관리
- 링크 dedupe / 일일 제한
- 대상 게시물 파싱
  - 제목
  - 본문 텍스트
  - 이미지 URL 목록
  - 작성자 메타
- v2 core 작성자 필터
- helper 호출
- helper 응답 JSON 검증
- 최종 삭제/차단 실행 여부 결정

### 4.2 웹 자동화 helper 역할

helper는 아래를 담당한다.

- Gemini 웹 접속 상태 확인
- 로그인 세션 확인
- 프롬프트 입력
- 응답이 끝날 때까지 대기
- 응답 텍스트 수집
- JSON 블록 추출
- 확장프로그램에 결과 반환

즉 helper는 **UI 자동 조작 + 응답 읽기**에 집중한다.

### 4.3 권장 구현체

권장 구현체:
- Playwright

이유:
- 브라우저 제어 안정성이 비교적 높음
- headful/headless 전환 쉬움
- DOM 대기 / 텍스트 추출 / 재시도 로직이 편함

Puppeteer도 가능하지만, 문서 기준 권장안은 Playwright다.

## 5. 입력 데이터 정책

확장에서 helper로 넘기는 기본 입력은 아래다.

```json
{
  "targetUrl": "https://gall.dcinside.com/...",
  "title": "게시물 제목",
  "bodyText": "정제된 본문 텍스트",
  "imageUrls": ["https://dcimg..."],
  "reportReason": "신고 댓글의 사유 텍스트",
  "requestLabel": "EXERCENS",
  "authorFilter": "fluid|low_activity|normal"
}
```

### 5.1 본문 파싱 기준

확장에서 파싱하는 권장 selector:
- 제목: `.title_subject`
- 본문: `.writing_view_box .write_div`
- 이미지: `.writing_view_box img`

정제 규칙:
- HTML 제거
- 연속 공백 축약
- 본문 길이 제한
- 중복 이미지 URL 제거

### 5.2 이미지 정책

웹 자동화 helper 기준으로도 현재 이미지 정책은 **`v2.0 URL-only`로 고정**한다.

- 프롬프트에 이미지 URL 목록만 포함한다.
- helper가 이미지를 다운로드하거나 업로드하지 않는다.
- OCR 보조 텍스트를 붙이지 않는다.

즉 현재 범위의 이미지는 **URL 전달 전용**이다.

## 6. Gemini 프롬프트 정책

Gemini에 넣는 프롬프트는 확장에서 미리 완성해서 helper에 넘기거나, helper에서 조합할 수 있다.

권장 출력 형식은 JSON 고정:

```json
{
  "decision": "allow" | "deny" | "review",
  "confidence": 0.0,
  "policy_ids": ["P3", "P14"],
  "reason": "짧은 판정 사유"
}
```

강제 의미:
- `allow`
  - 운영 규정 위반이 명확하여 자동 삭제/차단 가능
- `deny`
  - 운영 규정 위반이 아니거나 자동 삭제하면 안 됨
- `review`
  - 위반 가능성은 있으나 운영진 검토 필요

추가 규칙:
- `policy_ids = ["NONE"]` 이면 `decision`은 반드시 `deny`
- `allow`는 최소 1개 이상의 `P1~P15` 위반이 명확할 때만 허용

## 7. helper 호출 방식

권장 통신 방식:
- 확장 -> `http://127.0.0.1:<port>`
- helper는 로컬 포트에서만 수신

권장 endpoint:

```text
POST /judge
```

요청 예시:

```json
{
  "targetUrl": "...",
  "title": "...",
  "bodyText": "...",
  "imageUrls": ["..."],
  "reportReason": "...",
  "requestLabel": "...",
  "authorFilter": "fluid"
}
```

응답 예시:

```json
{
  "success": true,
  "decision": "deny",
  "confidence": 0.95,
  "policy_ids": ["NONE"],
  "reason": "정상 의견"
}
```

## 8. 웹 자동화 플로우

1. 확장이 helper에 `/judge` 요청
2. helper가 Gemini 웹 탭/세션 확인
3. 로그인 안 되어 있으면 에러 반환
4. 프롬프트 입력창 찾기
5. 제목/본문/이미지 URL 포함 프롬프트 입력
6. 전송
7. 응답 완료까지 대기
8. 응답 텍스트에서 JSON 블록 추출
9. JSON 파싱
10. 확장에 반환

## 9. 로그인 정책

웹 자동화 helper 방식에서는 **Gemini 웹에 사람이 미리 로그인해 두는 것**을 기본 전제로 한다.

즉:
- 확장에서 Google 로그인 버튼을 누르지 않는다.
- helper가 로그인 페이지를 대신 처리하지 않는다.
- 사용자가 브라우저에서 Gemini 웹 로그인 상태를 유지해야 한다.

이유:
- 웹 로그인 자동화는 2FA/보안 정책 때문에 깨질 가능성이 높음
- 첫 단계에선 판정 품질 확인이 목적이므로 로그인 자체는 수동으로 두는 것이 안전하다

## 10. 실패 시 정책

아래 경우는 모두 **삭제 실행 금지**다.

- helper 미실행
- helper 연결 실패
- Gemini 웹 로그인 안 됨
- Gemini 응답 대기 타임아웃
- JSON 파싱 실패
- `decision/confidence/policy_ids/reason` 필수값 누락
- `policy_ids=["NONE"]`인데 `decision!=deny`

즉 오류 시 기본값은 항상 `실행 안 함`이다.

## 11. 비용 관점

이 구조의 장점:
- API key 비용 없음
- OAuth client/project 설정 부담 없음
- 사용자는 Gemini 웹 로그인만 유지하면 됨

이 구조의 단점:
- 웹 UI가 바뀌면 깨질 수 있음
- 속도가 느릴 수 있음
- 브라우저 세션/탭 상태에 영향 받음
- 유지보수 난이도가 높음

즉 **비용을 아끼는 대신 안정성을 희생**하는 방향이다.

## 12. 수동 테스트 우선 정책

첫 단계는 자동 실행이 아니라 **수동 테스트 모드**를 우선한다.

권장 흐름:
1. 운영자가 링크 입력
2. 확장이 제목/본문/이미지 URL 파싱
3. helper 호출
4. Gemini 판단 결과 JSON 확인
5. 운영자가 결과 품질을 검토

수동 테스트 단계에서는:

- `allow / deny / review`와 근거 JSON만 확인한다.
- 실제 삭제/차단은 실행하지 않는다.
- 자동 명령 처리와 연결하지 않는다.

즉 수동 테스트는 **판단 잘하는지 여부만 확인하는 검증 단계**다.

## 13. 나중에 자동화로 올리는 흐름

수동 테스트가 안정화되면 그 다음 단계로:

1. 신문고 댓글 명령 수신
2. v2 core 작성자 필터 통과
3. helper 판단
4. `allow + confidence >= threshold`일 때만 실제 삭제/차단

즉 자동화는 **수동 테스트 검증 뒤**에만 붙인다.

## 14. 구현 전 최종 확인 필요 사항

- helper를 어떤 언어/런타임으로 만들지
  - 권장: Playwright + Node.js
- 로컬 포트를 몇 번으로 둘지
- Gemini 웹 셀렉터가 안정적인지
- confidence threshold를 몇으로 둘지

현재 단계에선 이 문서를 기준으로 **웹 자동화 helper 방식의 정책/흐름은 충분히 정리된 상태**이고, 실제 구현은 helper 프로토타입부터 시작하면 된다.
