# AI 관리자 전수 판정 dry-run

기존 운영 확장과 분리된 로컬 웹입니다. 1~20페이지 게시글을 Gemini CLI로 직렬 판정하고, 결과만 JSONL과 웹 페이지에 남깁니다.

```bash
npm install
npm start
```

기본 주소는 `http://127.0.0.1:4327/dry-run`입니다.

환경 변수 예시:

```bash
PORT=4327
GALLERY_ID=thesingularity
BOARD_PATH=mgallery
PAGE_FROM=1
PAGE_TO=20
GEMINI_ARGS_JSON='["--model","gemini-2.5-flash"]'
GEMINI_TIMEOUT_MS=240000
LLM_CONFIDENCE_THRESHOLD=0.85
```

실제 운영 조치는 수행하지 않습니다. 결과의 `AI 조치 대상`은 “AI 관리자라면 조치 대상으로 봤을 글”이라는 dry-run 표시값입니다.
