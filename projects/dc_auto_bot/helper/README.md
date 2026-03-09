# DC Auto Bot CLI Helper

```bash
cd projects/dc_auto_bot/helper
npm run start
```

기본값:

- `HOST=127.0.0.1`
- `PORT=4317`
- `GEMINI_COMMAND=gemini` (`win32`에서는 내부 기본값 `gemini.cmd`)
- `GEMINI_PROMPT_MODE=arg` (`win32`에서는 내부 기본값 `stdin`)
- `GEMINI_PROMPT_FLAG=-p`
- `GEMINI_TIMEOUT_MS=90000`

선택 환경 변수:

- `GEMINI_ARGS_JSON`
  - 예: `["--model","gemini-2.5-flash"]`
- `GEMINI_PROMPT_MODE`
  - `arg` 또는 `stdin`

endpoint:

- `GET /health`
- `POST /judge`

`POST /judge` 요청 예시:

```json
{
  "targetUrl": "https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1044753",
  "title": "게시물 제목",
  "bodyText": "본문",
  "imageUrls": ["https://example.com/image.jpg"],
  "reportReason": "분탕",
  "requestLabel": "manual_test",
  "authorFilter": "fluid"
}
```
