# 아키텍처 문서 - DC Post Protect

> 작성일: 2026-03-07
> 방식: 내부 API 직접 호출 (HTTP Request)
> 형태: Chrome Extension (Manifest V3)
> 레퍼런스: dc_comment_potect 프로젝트

---

## 1. 프로젝트 개요

디시인사이드 "특이점이 온다" 마이너 갤러리에서, 유동닉(비로그인)이 작성한 게시글을 자동으로 감지하여 "도배기" 머릿말(탭)로 분류하는 Chrome Extension.

### 기존 프로젝트와의 차이

| 항목 | dc_comment_potect (기존) | dc_post_protect (본 프로젝트) |
|------|--------------------------|------------------------------|
| **대상** | 댓글 | 게시글 |
| **판별 위치** | 게시물 진입 → 댓글 API 호출 | 게시물 **목록 페이지**에서 직접 판별 |
| **동작** | 유동닉 댓글 **삭제** | 유동닉 게시글 **"도배기" 탭으로 분류** |
| **API** | `/board/comment/` + 삭제 API | 목록 HTML 파싱 + **`chg_headtext_batch` 분류 API** |
| **속도** | 게시물마다 진입 필요 (느림) | 목록에서 바로 판별 (빠름) |

---

## 2. 시스템 개요

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chrome Extension                            │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │ popup.js │◄──►│ background.js│◄──►│   DC Internal API     │  │
│  │ (UI)     │    │ (Service     │    │   (fetch + cookie)    │  │
│  │          │    │  Worker)     │    │                       │  │
│  │ - 토글   │    │              │    │ ┌───────────────────┐ │  │
│  │ - 상태   │    │ - 스케줄러   │    │ │ 게시물 목록 HTML  │ │  │
│  │ - 로그   │    │ - HTML 파싱  │    │ │ 머릿말 분류 API   │ │  │
│  │ - 통계   │    │ - 유동닉판별 │    │ └───────────────────┘ │  │
│  └──────────┘    │ - 상태 관리  │    └───────────────────────┘  │
│                  └──────────────┘                               │
│                         │                                       │
│                  ┌──────────────┐                               │
│                  │ storage API  │                               │
│                  │ (설정/로그)  │                               │
│                  └──────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 핵심 동작 흐름

```
[시작] → isRunning 확인
  └── true →
        1. 게시물 목록 페이지 (page=1) HTML 가져오기
           GET /mgallery/board/lists/?id=thesingularity&page={page}
        2. HTML에서 각 게시물 행(<tr class="ub-content">) 파싱
           ├── <td class="gall_writer"> 의 data-ip 속성 확인
           ├── data-ip 값 있음 ("115.4")? → 유동닉! → data-no에서 번호 추출
           ├── data-ip 빈 문자열?         → 고정닉 → 스킵
           └── 이미 "도배기" 머릿말?       → 스킵 (중복 방지)
        3. 유동닉 게시물 번호들을 배치로 분류 API 호출
           POST /ajax/minor_manager_board_ajax/chg_headtext_batch
           Body: ci_t, id, nos[], _GALLTYPE_=M, headtext=130
        4. 다음 페이지 → 2번으로
        5. maxPage까지 완료 → cycleDelay 후 1페이지로
```

### 기존 프로젝트 대비 장점
- **게시물에 진입하지 않음** → 페이지 목록 1회 요청으로 전체 판별
- 목록 HTML `data-ip` 속성으로 즉시 유동닉 판별 ✅ 확인됨
- `nos[]` 배열 파라미터로 한 번에 복수 게시물 분류 가능
- 삭제가 아닌 분류 → 실수해도 원복 가능

---

## 4. 파일 구조

```
dc_post_protect/
├── manifest.json              # Chrome Extension 설정 (Manifest V3)
├── popup/
│   ├── popup.html             # 팝업 UI
│   ├── popup.css              # 팝업 스타일
│   └── popup.js               # 팝업 로직
├── background/
│   ├── background.js          # Service Worker (메인 엔진)
│   ├── api.js                 # 디시인사이드 API 호출 모듈
│   ├── parser.js              # 게시물 HTML 파싱 (유동닉 판별)
│   └── scheduler.js           # 순회 스케줄러
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── docs/
    ├── ARCHITECTURE.md        # 본 문서
    └── SPEC.md                # API 스펙
```

---

## 5. 리버스 엔지니어링 결과 ✅ 완료

### 5.1 게시물 목록에서 유동닉 판별 ✅

`<td class="gall_writer">` 의 `data-ip` 속성으로 판별.

| 속성 | 유동닉 | 고정닉 |
|------|--------|--------|
| `data-ip` | `"115.4"` (값 있음) | `""` (빈 문자열) |
| `data-uid` | `""` (빈 문자열) | `"adjust7431"` (값 있음) |
| `data-nick` | `"ㅇㅇ"` | `"행복한천국으로"` |

게시물 번호: `<tr data-no="1041288">` 에서 추출
현재 머릿말: `<td class="gall_subject">일반</td>` 에서 확인

### 5.2 머릿말(탭) 분류 API ✅

```
POST https://gall.dcinside.com/ajax/minor_manager_board_ajax/chg_headtext_batch
Body:
  ci_t: (ci_c 쿠키값)
  id: thesingularity
  _GALLTYPE_: M
  nos[]: 1040944        ← 게시물 번호 (배열 파라미터)
  headtext: 130         ← 🔑 도배기 머릿말 번호
```

Response: `200 OK`

---

## 6. 재사용 가능한 모듈 (dc_comment_potect에서)

| 모듈 | 재사용 | 변경 사항 |
|------|--------|----------|
| `api.js` | `dcFetch()`, `dcFetchWithRetry()`, `delay()`, `getCiToken()` | `deleteComments()` → `classifyPosts()` 교체, `fetchComments/fetchAllComments` 불필요 |
| `api.js` | `fetchPostList()` 구조 참고 | HTML 파싱을 유동닉 판별(`data-ip`) + 게시물 번호 추출로 변경 |
| `scheduler.js` | 클래스 구조, 상태 저장/복원, 로그 시스템, `ensureRunLoop()`, `resumeIfNeeded()` | `processPost()` → 페이지 단위 배치 처리로 단순화 |
| `background.js` | **그대로 복사** (Service Worker 구조, 메시지 핸들러, keepAlive 알람) | 이름/로그 텍스트만 변경 |
| `popup/` | UI 전체 (토글, 상태, 설정, 로그) | "삭제된 댓글" → "분류된 게시글" 텍스트 변경 |
| `manifest.json` | 구조 동일 | 이름/설명만 변경 |
| `parser.js` | 구조 참고 | 댓글 JSON 파싱 → HTML `data-ip` 파싱으로 완전 변경 |

---

## 7. 다음 단계

1. ✅ 게시물 목록 HTML에서 유동닉 판별 가능 여부 확인 → `data-ip` 속성
2. ✅ 머릿말 분류 API 리버싱 → `chg_headtext_batch`, `headtext=130`
3. ✅ SPEC.md 작성 완료
4. ⬜ 코드 구현 (기존 프로젝트 레퍼런스)
5. ⬜ 테스트
