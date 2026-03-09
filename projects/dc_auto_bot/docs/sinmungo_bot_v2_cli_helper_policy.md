# DC Auto Bot - 신문고 봇 v2 CLI Helper 정책

## 1. 목표

이 문서는 `API 기반 Gemini 직접 호출`이 아니라, **로컬 CLI helper + Gemini CLI**를 이용해 신문고 봇 v2 판단 기능을 구현하는 정책을 정리한다.

공개형 투명성 웹사이트 스펙은 아래 문서를 따른다.

- [신문고 봇 v2 투명성 웹사이트 스펙](./sinmungo_bot_v2_transparency_site_spec.md)

핵심 목표:
- 확장프로그램은 게시물 파싱과 운영 정책 제어를 담당한다.
- 로컬 CLI helper는 Gemini CLI를 실행하는 중간 계층이다.
- 확장프로그램은 helper로부터 JSON 결과만 받아 실제 삭제/차단 여부를 결정한다.

즉 구조는 다음과 같다.

```text
DC Auto Bot 확장
-> localhost CLI helper 호출
-> Gemini CLI (이미 로그인된 상태)
-> JSON 결과 수집
-> 확장으로 반환
```

## 2. 왜 이 구조를 쓰는가

이 구조는 아래 요구사항을 만족하기 위해 선택한다.

- API key 직접 사용을 피하고 싶다.
- OAuth client / project 설정 부담을 줄이고 싶다.
- 사용자는 Gemini CLI 로그인만 유지하면 된다.
- 확장프로그램은 localhost JSON만 다루게 하고 싶다.
- Gemini 웹 자동화보다 조금 더 안정적인 구조를 원한다.

즉 비용을 아끼고, OAuth/API 설정 복잡도를 줄이는 대신 helper 실행을 허용하는 방향이다.

## 3. 전체 구조

### 3.1 확장프로그램 역할

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
- localhost helper 호출
- helper 응답 JSON 검증
- 최종 삭제/차단 실행 여부 결정

즉 확장은 **파싱기 + 정책 엔진**이다.

### 3.2 CLI helper 역할

CLI helper는 아래를 담당한다.

- 확장으로부터 JSON payload 수신
- LLM 프롬프트 조합
- Gemini CLI 실행
- CLI 출력에서 JSON 블록 추출
- 확장으로 결과 반환

즉 helper는 **Gemini CLI 실행기 + 응답 파서**다.

### 3.3 Gemini CLI 역할

Gemini CLI는 아래를 담당한다.

- 프롬프트 입력 수신
- 정책 `P1 ~ P15`에 대한 판정
- `decision / confidence / policy_ids / reason` 반환

즉 실제 LLM 판단은 Gemini CLI가 수행한다.

## 4. 기본 전제

CLI helper를 호출하기 전에 아래는 확장에서 이미 처리되어 있어야 한다.

1. 신뢰 사용자 `user_id` 검증 통과
2. 명령 문법 파싱 통과
3. 링크 dedupe 통과
4. 일일 2회 제한 통과
5. v2 core 작성자 필터 통과
   - 유동 또는 깡계(`< 100`)
6. 대상 게시물이 `전체글 기준 최근 100개 regular row` 안에 있음
7. 대상 게시물이 개념글이 아님
8. 대상 게시물 제목 / 본문 / 이미지 URL 파싱 완료

즉 helper는 **파싱기**가 아니라 **판정 호출기**다.

여기서 `최근 100개 regular row`는 다음처럼 정의한다.

- `전체글` 목록을 최신순으로 읽는다.
- `공지`, `설문`, 숫자 아닌 `gall_num` row는 제외한다.
- 제외 후 남는 일반 사용자 게시물 row를 `regular row`로 본다.
- 이 `regular row` 최신 100건만 자동 삭제 후보로 본다.
- 개념글 row는 recent 100 계산에서도 제외한다.

개념글 판정은 다음처럼 정의한다.

- 대상 게시물 view HTML의 `#recommend` hidden input 값이 `K`면 개념글로 본다.
- 개념글이면 helper 결과와 무관하게 자동 삭제/차단하지 않는다.
- 위 판정이 불가능하면 fail-safe로 자동 실행하지 않는다.

## 5. 실제 플로우

### 5.1 확장이 게시물 파싱

신문고 명령 또는 수동 테스트 링크가 들어오면 확장은 아래를 파싱한다.

- 제목
- 본문
- 이미지 URL 목록
- 작성자 메타

그리고 v2 core 필터도 먼저 적용한다.

- 유동인지
- 깡계(`<100`)인지
- 최근 100개 regular row 안에 있는지
- 개념글이 아닌지

즉 helper에 보내기 전에 대상이 최소한 자동 처리 후보인지 1차 확인한다.

### 5.2 확장이 helper 호출

확장은 로컬 helper에 요청한다.

예:

```text
POST http://127.0.0.1:4317/judge
```

payload 예시:

```json
{
  "targetUrl": "https://gall.dcinside.com/...",
  "title": "게시물 제목",
  "bodyText": "정제된 본문 텍스트",
  "imageUrls": ["https://dcimg..."],
  "reportReason": "신고 사유",
  "requestLabel": "だいき",
  "authorFilter": "fluid"
}
```

### 5.3 helper가 Gemini CLI에 프롬프트 전달

helper는 이 payload를 받아서:
- 프롬프트를 조합하고
- Gemini CLI를 실행한다

예를 들면 내부적으로:

```bash
gemini -p "<프롬프트>"
```

같은 형태가 될 수 있다.

### 5.4 이미지 처리 정책

현재 정책에서는 **`v2.0 URL-only`로 고정**한다.

- helper는 이미지 URL 목록만 Gemini CLI 프롬프트에 포함한다.
- helper가 이미지를 다운로드하거나 임시 파일로 저장하지 않는다.
- Gemini CLI에 로컬 파일 경로를 넘기는 방식은 이번 범위에 포함하지 않는다.

즉 현재 구현 범위의 이미지는 **`이미지 URL 전달 전용`**이다.

### 5.5 Gemini CLI 응답 수집

helper는 CLI 출력에서 JSON 블록만 추출한다.

예:

```json
{
  "decision": "deny",
  "confidence": 0.95,
  "policy_ids": ["NONE"],
  "reason": "정상 의견"
}
```

### 5.6 helper가 확장에 JSON 반환

helper는 이 JSON을 그대로 확장에 돌려준다.

예:

```json
{
  "success": true,
  "decision": "deny",
  "confidence": 0.95,
  "policy_ids": ["NONE"],
  "reason": "정상 의견",
  "rawText": "..."
}
```

### 5.7 확장이 결과 해석

확장은 문서대로 판정한다.

- 최근 100개 regular row 밖이면 실행 안 함
- 개념글이면 실행 안 함
- `policy_ids=["NONE"]`이면 `decision`은 반드시 `deny`
- `allow + confidence >= 기준`일 때만 실제 삭제/차단
- 그 외는 실행 안 함

## 6. 수동 테스트 모드

처음엔 자동 연결 말고 아래처럼 수동 테스트로 쓴다.

1. 확장에서 링크 입력
2. `LLM 테스트`
3. helper 호출
4. Gemini 판단 결과 표시
5. 운영자가 결과 품질 확인

수동 테스트 모드에서는:

- `allow / deny / review` 판단 결과와 근거 JSON만 표시한다.
- 실제 삭제/차단은 실행하지 않는다.
- 자동 명령 처리와 연결하지 않는다.
- 최근 100개 / 개념글 삭제 금지 가드는 수동 테스트에 적용하지 않는다.

즉 수동 테스트는 **판단을 잘하는지 여부만 확인하는 검증 모드**다.

## 7. 나중에 자동화 붙이면

수동 테스트가 안정화되면 그 다음 단계로:

1. 신문고 댓글 명령 수신
2. 대상 링크 파싱
3. v2 core 작성자 필터
4. 최근 100개 regular row / 개념글 여부 판정
5. helper 판단
6. `allow + confidence >= threshold`면 삭제/차단

으로 연결한다.

## 8. 장점

- API key 직접 안 씀
- OAuth client / project 설정 안 해도 됨
- Gemini 웹 자동화보다 안정적
- 확장은 localhost JSON만 다루면 됨
- 사용자는 Gemini CLI 로그인만 유지하면 됨

## 9. 단점

- helper는 켜져 있어야 함
- CLI 출력 형식이 바뀌면 파서가 깨질 수 있음
- CLI 로그인 세션이 만료되면 다시 로그인해야 함
- URL-only 이미지 판정은 실제 이미지 내용을 직접 읽는 방식보다 한계가 있을 수 있음

즉 **비용을 아끼는 대신, helper 의존성과 출력 파싱 리스크를 감수하는 구조**다.

## 10. 권장 helper 구현체

권장 구현체:
- Node.js

이유:
- 확장과 JSON 주고받기 쉬움
- `child_process`로 CLI 실행이 쉬움
- localhost HTTP 서버 구현이 간단함

## 11. helper 통신 스펙

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
  "reason": "정상 의견",
  "rawText": "..."
}
```

## 12. 실패 시 정책

아래 경우는 모두 **삭제 실행 금지**다.

- helper 미실행
- helper 연결 실패
- Gemini CLI 로그인 안 됨
- Gemini CLI 응답 대기 타임아웃
- JSON 파싱 실패
- `decision/confidence/policy_ids/reason` 필수값 누락
- `policy_ids=["NONE"]`인데 `decision!=deny`

즉 오류 시 기본값은 항상 `실행 안 함`이다.

## 13. 구현 순서 권장안

1. v2 core 작성자 필터 먼저 구현
2. 제목/본문/이미지 URL 파서 구현
3. CLI helper 입출력 스펙 고정
4. 수동 테스트 모드 구현
5. 로그 기준으로 프롬프트/임계치 튜닝
6. 필요하면 자동 삭제 연결

## 14. 구현 전 최종 확인 필요 사항

- helper 포트를 몇 번으로 둘지
- Gemini CLI 실행 명령 형식을 어떻게 고정할지
- confidence threshold를 몇으로 둘지

현재 단계에선 이 문서를 기준으로 **CLI helper 방식의 정책과 흐름은 충분히 정리된 상태**이고, 다음 구현은 helper 프로토타입부터 시작하면 된다.
