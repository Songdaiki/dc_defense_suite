# DC Auto Bot - 공개형 투명성 사이트 무료 배포 가이드

## 1. 목적

이 문서는 신문고 봇 v2의 공개형 transparency 사이트를 **무료 호스팅**으로 안전하게 공개할 때의 배포 원칙을 정리한다.

핵심 목표:

- 누구나 볼 수 있는 공개 transparency 사이트를 만든다.
- Gemini 판정 결과와 reason, 신고 사유를 공개한다.
- helper의 비공개 기능(`/judge`, `/record`, `/health`)은 외부에 노출하지 않는다.
- 무료 호스팅을 사용하되, 현재 구조와 충돌하지 않게 안전하게 분리한다.

## 2. 결론

현재 구조 기준으로 가장 안전하고 현실적인 무료 공개 방식은 아래와 같다.

```text
확장 + helper (비공개, 로컬/내부 전용)
-> 공개용 record + 블러 썸네일 생성
-> 정적 사이트로 export
-> GitHub Pages 또는 Cloudflare Pages로 공개
```

즉:

- **helper는 비공개**
- **공개 사이트는 정적(static)으로 배포**

이 구조를 기본 권장안으로 삼는다.

## 3. 왜 helper를 직접 공개하면 안 되는가

현재 helper에는 공개되면 안 되는 endpoint가 있다.

- `POST /judge`
- `POST /record`
- `GET /health`

이 endpoint들을 인터넷에 그대로 열면 아래 문제가 생긴다.

1. 외부 사용자가 Gemini CLI를 임의로 호출할 수 있다.
2. 외부 사용자가 공개 record를 임의로 저장할 수 있다.
3. `/record`가 이미지 URL을 내려받아 썸네일을 만들기 때문에 SSRF 위험이 생긴다.
4. `/health`에서 런타임 정보가 노출된다.

따라서 **현재 helper 서버를 도메인에 그대로 연결하는 방식은 금지**한다.

## 4. 무료 배포 권장안

### 4.1 1순위: GitHub Pages

권장 이유:

- public repository 기준 무료 사용 가능
- 정적 사이트 배포에 적합
- custom domain 지원
- HTTPS 지원
- GitHub Actions와 궁합이 좋음

적합한 경우:

- transparency 페이지를 정적 HTML/JSON/asset으로 export할 수 있을 때
- 운영자가 GitHub repo 기반 배포에 익숙할 때

### 4.2 2순위: Cloudflare Pages

권장 이유:

- Free plan에서 사용 가능
- custom domain 연결이 쉬움
- Git provider 연동 또는 direct upload 가능
- 정적 사이트 배포에 적합

적합한 경우:

- GitHub Pages 대신 Cloudflare 대시보드 중심으로 관리하고 싶을 때
- 추후 edge 쪽 기능을 조금 붙일 가능성이 있을 때

### 4.3 비권장: helper 자체를 무료 Node 호스팅에 그대로 올리기

예:

- Render
- Fly.io
- Railway
- VPS 직접 오픈

이 방식은 helper를 공개 앱으로 착각하기 쉬워서, `/judge`, `/record`, `/health` 차단을 누락할 가능성이 크다.

현재 단계의 권장안이 아니다.

## 5. 공개 배포 아키텍처

권장 구조:

```text
[운영 PC]
Chrome 확장
-> localhost helper
-> 공개용 record 생성
-> 블러 썸네일 생성
-> static export 디렉터리 생성

[공개 호스팅]
GitHub Pages 또는 Cloudflare Pages
-> export된 HTML/CSS/JSON/WebP만 서빙
```

이때 공개 호스팅에는 다음만 올라간다.

- `index.html`
- `records/*.json` 또는 통합 `records.json`
- `transparency-assets/*.webp`
- `styles.css`

공개 호스팅에는 올라가지 않는 것:

- helper 서버 코드
- Gemini CLI
- 원본 이미지 URL
- rawText
- requestLabel
- internal log
- recent100 / concept check 결과

## 6. 공개 데이터 규칙

공개 사이트에 올리는 필드:

- `createdAt`
- `targetUrl`
- `targetPostNo`
- `publicTitle`
- `publicBody`
- `reportReason`
- `decision`
- `confidence`
- `policyIds`
- `reason`
- `blurredThumbnailPath`
- `imageCount`
- `source`
  - `auto_report | manual_test`

공개 사이트에 올리면 안 되는 필드:

- `requestLabel`
- `rawText`
- `authorFilter`
- `authorCheckMessage`
- `recentWindowCheck`
- `conceptPostCheck`
- `actionTaken`
- `actionResult`
- `skipReason`
- `actionMessage`
- 원본 이미지 URL

현재 helper 기준으로는 입력 `bodyText`를 공개용 `publicBody`로 저장해 상세 페이지에 노출한다.
즉 공개 범위 기준은 `bodyText` 자체를 무조건 숨기는 것이 아니라, `rawText`, 내부 운영 메타, 원본 이미지 URL/파일을 제외하는 것이다.

## 7. 정적 export 방식

무료 공개 호스팅을 위해서는 helper가 만든 공개 record를 **정적 산출물**로 바꾸는 단계가 필요하다.

권장 export 결과:

```text
public-transparency/
  index.html
  records.json
  transparency-assets/
    record-1.webp
    record-2.webp
  transparency.css
```

### 7.1 최소 MVP

- `index.html`
  - 카드형 목록
- `records.json`
  - 공개 record 배열
- `transparency-assets/*.webp`
  - 블러 썸네일
- `transparency.css`

### 7.2 권장 동작

1. helper가 공개 record를 저장한다.
2. export 스크립트가 공개 record를 읽는다.
3. 정적 HTML/JSON/assets를 생성한다.
4. 공개 repo 또는 Pages project에 push/deploy한다.

## 8. GitHub Pages 배포 방식

가장 단순한 무료 공개 방식은 아래 둘 중 하나다.

### 8.1 project site

예:

```text
https://<owner>.github.io/<repo>
```

적합:

- 기존 repo 안에서 project site로 운영할 때

### 8.2 별도 public repo

예:

```text
https://<owner>.github.io
```

또는 custom domain

적합:

- transparency 사이트를 메인 공개 사이트처럼 따로 운영하고 싶을 때

권장:

- transparency 전용 public repo를 하나 따로 두는 편이 관리가 쉽다.

## 9. Cloudflare Pages 배포 방식

Cloudflare Pages를 쓸 경우:

1. public repo를 연결하거나
2. export 결과를 direct upload 한다.

권장:

- transparency 전용 repo 하나를 Cloudflare Pages 프로젝트에 연결

장점:

- custom domain 연결이 편하다
- Free plan에서도 충분히 시작 가능하다

## 10. custom domain 권장안

공개 transparency 사이트는 전용 도메인을 따로 두는 편이 좋다.

예:

- `transparency.example.com`
- `bot-log.example.com`
- `report.example.com`

장점:

- 본 사이트와 역할이 분리된다.
- 공개 기록 페이지라는 인식이 명확해진다.

## 11. HTTPS 원칙

공개 사이트는 반드시 HTTPS를 사용한다.

이유:

- 링크 신뢰성
- 중간 변조 방지
- 공개 사이트 기본 위생

## 12. 현재 프로젝트 기준 권장 운영안

현재 프로젝트에서 가장 맞는 운영안은 아래다.

### 12.1 1차 권장안

- helper는 운영 PC에서만 실행
- helper는 계속 `127.0.0.1:4317`
- 공개 record와 블러 썸네일을 export
- GitHub Pages로 정적 공개

이 방식이 좋은 이유:

- 현재 helper 코드를 크게 바꾸지 않아도 됨
- 보안 경계가 명확함
- 무료로 시작 가능함

### 12.2 2차 권장안

- helper는 운영 PC에서만 실행
- 공개 export를 Cloudflare Pages로 배포

이 방식이 좋은 이유:

- custom domain 연결이 편함
- GitHub Pages 대안으로 충분히 좋음

## 13. 금지 사항

아래 배포 방식은 현재 단계에서 금지한다.

1. helper 서버를 그대로 퍼블릭 도메인에 바인딩
2. `/judge`를 인터넷에 공개
3. `/record`를 인터넷에 공개
4. `/health`를 인터넷에 공개
5. 원본 이미지 URL을 공개 사이트에 포함
6. rawText를 공개 사이트에 포함

## 14. 구현 체크리스트

무료 공개 배포 전 체크:

1. 공개 record만 export되는가
2. 제목이 말머리 포함 표시값 그대로 export되는가
3. 이미지가 블러 썸네일만 공개되는가
4. rawText가 빠졌는가
5. requestLabel이 빠졌는가
6. 실제 삭제 여부가 빠졌는가
7. helper endpoint가 외부에 노출되지 않는가
8. 공개 URL이 HTTPS로 열리는가

## 15. 추천 결정

현재 기준 최종 추천:

1. **GitHub Pages**
2. **Cloudflare Pages**

이유:

- 둘 다 무료 시작이 쉽다.
- 정적 공개 사이트에 적합하다.
- helper를 비공개로 유지하기 쉽다.

## 16. 참고 링크

- GitHub Pages 소개: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- GitHub Pages HTTPS: https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
- Cloudflare Pages 개요: https://developers.cloudflare.com/pages/
- Cloudflare Pages 제한: https://developers.cloudflare.com/pages/platform/limits/
