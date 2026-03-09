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
- `GEMINI_TIMEOUT_MS=240000`
- `TRANSPARENCY_THUMBNAIL_WIDTH=360`
- `TRANSPARENCY_THUMBNAIL_BLUR_SIGMA=18`
- `TRANSPARENCY_THUMBNAIL_WEBP_QUALITY=64`

선택 환경 변수:

- `GEMINI_ARGS_JSON`
  - 예: `["--model","gemini-2.5-flash"]`
- `GEMINI_PROMPT_MODE`
  - `arg` 또는 `stdin`
- `TRANSPARENCY_RECORDS_FILE`
- `TRANSPARENCY_ASSETS_DIR`

endpoint:

- `GET /health`
- `POST /judge`
- `POST /record`
- `GET /api/moderation-records`
- `GET /api/moderation-records/:id`
- `GET /transparency`
- `GET /transparency/:id`
- `GET /transparency-assets/:filename`

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

`POST /record` 요청 예시:

```json
{
  "source": "auto_report",
  "targetUrl": "https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1044753",
  "targetPostNo": "1044753",
  "title": "홍보성 게시물 제목 예시",
  "imageUrls": ["https://dcimg8.dcinside.co.kr/viewimage.php?id=..."],
  "reportReason": "홍보",
  "decision": "allow",
  "confidence": 0.93,
  "policyIds": ["P14"],
  "reason": "갤러리 주제와 무관한 홍보성 게시물로 판단"
}
```

공개 transparency 사이트 규칙:

- auto_report와 manual_test 둘 다 공개 기록으로 저장 가능
- 제목은 helper가 `말머리 + 제목` 표시값 그대로 저장
- 본문은 helper가 공개용 `publicBody`로 저장해 상세 페이지에 표시
- 이미지가 있으면 helper가 블러 썸네일만 저장
- 원본 이미지 URL과 rawText는 공개하지 않음
