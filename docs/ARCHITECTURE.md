# 아키텍처 문서 - DC Comment Protect

> 작성일: 2026-03-07
> 방식: B (내부 API 직접 호출)
> 형태: Chrome Extension (Manifest V3)

---

## 1. 시스템 개요

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chrome Extension                            │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │ popup.js │◄──►│ background.js│◄──►│   DC Internal API     │  │
│  │ (UI)     │    │ (Service     │    │   (fetch + cookie)    │  │
│  │          │    │  Worker)     │    │                       │  │
│  │ - 토글   │    │              │    │ ┌───────────────────┐ │  │
│  │ - 상태   │    │ - 스케줄러   │    │ │ 게시물 목록 API   │ │  │
│  │ - 로그   │    │ - API 호출   │    │ │ 댓글 목록 API     │ │  │
│  │ - 통계   │    │ - 필터링     │    │ │ 댓글 삭제 API     │ │  │
│  └──────────┘    │ - 상태 관리  │    │ └───────────────────┘ │  │
│                  └──────────────┘    └───────────────────────┘  │
│                         │                                       │
│                  ┌──────────────┐                               │
│                  │ storage API  │                               │
│                  │ (설정/로그)  │                               │
│                  └──────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 파일 구조

```
dc_comment_protect/
├── manifest.json              # Chrome Extension 설정 (Manifest V3)
├── popup/
│   ├── popup.html             # 팝업 UI
│   ├── popup.css              # 팝업 스타일
│   └── popup.js               # 팝업 로직 (토글, 상태 표시)
├── background/
│   ├── background.js          # Service Worker (메인 엔진)
│   ├── api.js                 # 디시인사이드 API 호출 모듈
│   ├── parser.js              # 응답 파싱 모듈 (유동닉 필터링)
│   └── scheduler.js           # 순회 스케줄러
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── docs/
│   ├── APPROACH_COMPARISON.md # 접근 방식 비교
│   └── ARCHITECTURE.md        # 본 문서
└── README.md
```

---

## 3. 핵심 모듈 상세

### 3.1 manifest.json

```json
{
  "manifest_version": 3,
  "name": "DC Comment Protect",
  "version": "1.0.0",
  "description": "디시인사이드 유동닉 악성 댓글 자동 삭제",
  "permissions": [
    "storage",
    "alarms",
    "cookies"
  ],
  "host_permissions": [
    "https://gall.dcinside.com/*"
  ],
  "background": {
    "service_worker": "background/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  }
}
```

### 3.2 background.js (Service Worker) - 메인 엔진

핵심 로직이 모두 이곳에서 실행된다.

#### 상태 관리
```javascript
// 전역 상태
const state = {
  isRunning: false,         // 토글 ON/OFF
  currentPage: 1,           // 현재 순회 중인 페이지 (1-5)
  currentPostIndex: 0,      // 현재 페이지 내 게시물 인덱스
  totalDeleted: 0,          // 총 삭제된 댓글 수
  cycleCount: 0,            // 완료된 사이클 수
  lastActivity: null,       // 마지막 활동 시간
  logs: [],                 // 최근 로그 (최대 100개)
  config: {
    galleryId: 'thesingularity',
    galleryType: 'mgallery',     // 마이너 갤러리
    maxPage: 5,                   // 순회할 최대 페이지
    requestDelay: 400,            // API 요청 간 딜레이 (ms)
    cycleDelay: 5000,             // 사이클 간 딜레이 (ms)
    postsPerPage: 50,             // 페이지당 게시물 수
  }
};
```

#### 메인 루프
```
[시작] → isRunning 확인
  ├── false → 대기
  └── true → fetchPostList(page)
                ├── 게시물 목록 획득
                ├── 각 게시물에 대해:
                │     ├── fetchComments(postNo)
                │     ├── filterFluidComments(comments)
                │     ├── 유동닉 댓글 있으면:
                │     │     ├── deleteComments(commentNos)
                │     │     └── 로그 기록
                │     └── 딜레이 (requestDelay)
                ├── 다음 페이지로
                └── 5페이지 완료 → cycleDelay 후 1페이지로
```

### 3.3 api.js - API 호출 모듈

디시인사이드 내부 API 엔드포인트를 추상화.

#### 알려진 API 구조 (리버스 엔지니어링 필요)

> ⚠️ **중요**: 아래 API 엔드포인트는 실제 브라우저 네트워크 탭에서 확인 후 정확한 값으로 교체해야 함.
> 확장 프로그램 최초 실행 시 `API Discovery` 단계를 통해 자동 감지하거나,
> 수동으로 네트워크 탭에서 확인한 값을 설정에 입력

```javascript
const DC_API = {
  // 게시물 목록 (HTML 또는 JSON)
  // 실제 엔드포인트는 네트워크 탭에서 확인 필요
  POST_LIST: (gallId, page) =>
    `https://gall.dcinside.com/mgallery/board/lists/?id=${gallId}&page=${page}`,

  // 댓글 목록 (AJAX 호출)
  // 디시인사이드는 댓글 로딩 시 별도 AJAX 요청 사용
  // e_s_n_o: 암호화된 세션 토큰 (페이지 소스에서 추출)
  COMMENT_LIST: () =>
    `https://gall.dcinside.com/board/comment/`,

  // 댓글 삭제 (매니저/부매니저 권한)
  // 매니저용 삭제 API는 일반 사용자 삭제와 다른 엔드포인트일 수 있음
  COMMENT_DELETE: () =>
    `https://gall.dcinside.com/board/comment/comment_delete_submit`,
};
```

#### API 호출 공통 패턴
```javascript
async function dcFetch(url, options = {}) {
  const defaultHeaders = {
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://gall.dcinside.com/mgallery/board/lists/?id=${CONFIG.galleryId}`,
  };

  const response = await fetch(url, {
    credentials: 'include',     // 쿠키 자동 포함 (로그인 세션)
    headers: { ...defaultHeaders, ...options.headers },
    ...options,
  });

  return response;
}
```

### 3.4 parser.js - 응답 파싱 모듈

#### 게시물 목록 파싱
게시물 목록 API 응답(HTML)에서 게시물 번호(no) 추출.

```javascript
function parsePostList(html) {
  // HTML 응답에서 게시물 번호 추출
  // 예: <tr class="ub-content" data-no="1037600">
  // 또는 URL 패턴: /board/view/?id=thesingularity&no=1037600
  const posts = [];
  // ... 파싱 로직
  return posts; // [{ no: 1037600, title: '...' }, ...]
}
```

#### 유동닉 댓글 필터링
```javascript
function filterFluidComments(comments) {
  // 유동닉 판별 기준:
  // 1. 닉네임에 IP 주소가 포함 → "ㅇㅇ(183.99)" 또는 "닉네임(121.145)"
  // 2. HTML에서 class="ip" 요소가 존재
  // 3. 정규식: /\((\d{1,3}\.\d{1,3})\)/

  const IP_PATTERN = /\((\d{1,3}\.\d{1,3})\)/;

  return comments.filter(comment => {
    return IP_PATTERN.test(comment.nickname);
  });
}
```

### 3.5 scheduler.js - 순회 스케줄러

```javascript
class Scheduler {
  constructor(config) {
    this.config = config;
    this.currentPage = 1;
    this.isRunning = false;
  }

  // 메인 순회 루프
  async run() {
    while (this.isRunning) {
      for (let page = 1; page <= this.config.maxPage; page++) {
        if (!this.isRunning) break;
        this.currentPage = page;

        // 1. 게시물 목록 가져오기
        const posts = await api.fetchPostList(page);

        // 2. 각 게시물의 댓글 처리
        for (const post of posts) {
          if (!this.isRunning) break;

          const comments = await api.fetchComments(post.no);
          const fluidComments = parser.filterFluidComments(comments);

          if (fluidComments.length > 0) {
            await api.deleteComments(post.no, fluidComments);
            this.log(`삭제: 게시물 #${post.no}에서 ${fluidComments.length}개 댓글`);
          }

          // 레이트 리밋 방지 딜레이
          await this.delay(this.config.requestDelay);
        }
      }

      // 사이클 완료 → 잠시 대기 후 다시 시작
      this.log(`사이클 완료. ${this.config.cycleDelay}ms 후 재시작...`);
      await this.delay(this.config.cycleDelay);
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

---

## 4. 팝업 UI 설계

```
┌─────────────────────────────────┐
│  🛡️ DC Comment Protect         │
│─────────────────────────────────│
│                                 │
│  ┌─────────────────────────┐    │
│  │   [=====⚪  OFF  ]      │    │  ← 토글 스위치
│  │   [  ⚪=====  ON   ]    │    │
│  └─────────────────────────┘    │
│                                 │
│  📊 현재 상태                    │
│  ├─ 상태: 🔴 정지 / 🟢 실행 중  │
│  ├─ 현재: 2페이지 / 15번째 글   │
│  ├─ 삭제: 총 142개 댓글         │
│  └─ 사이클: 3회 완료            │
│                                 │
│  ⚙️ 설정                        │
│  ├─ 순회 페이지: [1] ~ [5]     │
│  ├─ 요청 딜레이: [400]ms       │
│  └─ 사이클 딜레이: [5000]ms    │
│                                 │
│  📜 최근 로그                    │
│  ├─ 01:45:23 삭제 3개 (#1037600)│
│  ├─ 01:45:21 삭제 1개 (#1037599)│
│  └─ 01:45:18 스킵 (#1037598)   │
│                                 │
└─────────────────────────────────┘
```

---

## 5. API Discovery (최초 실행 시)

디시인사이드 내부 API 엔드포인트는 공식 문서가 없으므로, **최초 실행 시 네트워크 탭에서 확인**하여 설정해야 한다.

### 확인 방법

1. Chrome 개발자 도구 (F12) → Network 탭 열기
2. 디시인사이드 게시물 페이지 열기
3. 아래 행동을 하면서 XHR/Fetch 요청 관찰:

| 행동 | 관찰할 요청 |
|------|-----------|
| 게시물 페이지 진입 | 초기 로딩 요청, 댓글 목록 AJAX 요청 |
| 댓글 더보기 클릭 | 댓글 페이지네이션 API |
| 댓글 체크 + 삭제 클릭 | 댓글 삭제 API (POST 요청) |

### 확인해야 할 핵심 파라미터

```
1. 댓글 목록 API
   - URL: ?
   - Method: POST
   - Body params:
     - id (갤러리 ID)
     - no (게시물 번호)
     - e_s_n_o (암호화 토큰 - 페이지 소스에서 추출)
     - comment_page (댓글 페이지)
   - Response: JSON/HTML (댓글 목록)

2. 댓글 삭제 API (매니저용)
   - URL: ?
   - Method: POST
   - Body params:
     - id (갤러리 ID)
     - no (게시물 번호)
     - comment_no (댓글 번호, 복수 가능)
     - ci_t (CSRF 토큰?)
   - Response: 성공/실패 상태
```

### e_s_n_o 토큰

디시인사이드는 API 호출 시 `e_s_n_o`라는 암호화된 토큰을 요구할 수 있다.
이 토큰은 보통 페이지 HTML 소스에 JavaScript 변수로 포함되어 있다.

```html
<!-- 페이지 소스 어딘가에 존재 -->
<script>
  var _GALLERY_NO_ = '...';
  var e_s_n_o = '...'; // 이 값을 추출해야 함
</script>
```

**추출 전략:**
1. 게시물 페이지 HTML을 fetch로 가져온다
2. 정규식으로 `e_s_n_o` 값을 추출한다
3. 해당 값을 API 요청에 포함한다

---

## 6. 유동닉 판별 로직

### 디시인사이드 닉네임 유형

| 유형 | 표시 형태 | IP 표시 | 삭제 대상 |
|------|----------|---------|----------|
| 고정닉 (로그인) | `닉네임` | ❌ | ❌ |
| 유동닉 (비로그인) | `ㅇㅇ(123.45)` | ✅ | ✅ |
| 반고정닉 | `닉네임(123.45)` | ✅ | ✅ |

### HTML 구조 (예상, 실제 확인 필요)

```html
<!-- 고정닉 (삭제 안 함) -->
<span class="nickname">
  <em>닉네임</em>
</span>

<!-- 유동닉 (삭제 대상) -->
<span class="nickname">
  <em>ㅇㅇ</em>
  <span class="ip">(123.45)</span>
</span>
```

### 판별 정규식
```javascript
// 유동닉 판별: IP 주소 패턴이 있으면 유동닉
const IS_FLUID_USER = /\((\d{1,3}\.\d{1,3})\)/;

// 닉네임에서 IP 추출
function extractIP(nickname) {
  const match = nickname.match(IS_FLUID_USER);
  return match ? match[1] : null;
}
```

---

## 7. 에러 처리 및 복원력

### 7.1 레이트 리밋 대응

```javascript
async function dcFetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await dcFetch(url, options);

      if (response.status === 429) {
        // Too Many Requests → 딜레이 증가 후 재시도
        const backoff = (i + 1) * 2000; // 2초, 4초, 6초
        log(`레이트 리밋 감지. ${backoff}ms 대기 후 재시도...`);
        await delay(backoff);
        continue;
      }

      if (response.status === 403) {
        // 캡차 또는 차단 → 알림 후 일시 정지
        log('⚠️ 접근 차단 감지. 30초 대기...');
        await delay(30000);
        continue;
      }

      return response;
    } catch (error) {
      log(`네트워크 에러: ${error.message}. 재시도 ${i + 1}/${maxRetries}`);
      await delay(1000);
    }
  }

  throw new Error('최대 재시도 횟수 초과');
}
```

### 7.2 Service Worker 생명주기

Manifest V3의 Service Worker는 **비활성 시 종료**될 수 있다.

**대응 전략:**
- `chrome.alarms` API로 주기적 알람 설정 → Service Worker 활성 유지
- 상태를 `chrome.storage.local`에 주기적으로 저장
- Service Worker 재시작 시 저장된 상태에서 복원

```javascript
// 30초마다 알람으로 Service Worker 활성 유지
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive' && state.isRunning) {
    // 작업 계속 진행
    processNextPost();
  }
});
```

---

## 8. 데이터 흐름도

```
┌──────────────┐
│  사용자       │
│  토글 ON     │
└──────┬───────┘
       │ chrome.runtime.sendMessage({action: 'start'})
       ▼
┌──────────────┐
│ background.js│
│ Scheduler    │
└──────┬───────┘
       │
       ▼
┌──────────────┐     GET /mgallery/board/lists/?id=thesingularity&page=1
│  api.js      │────────────────────────────────────────────────────────►
│ fetchPosts() │◄────────────────────────────────────────────────────────
└──────┬───────┘     Response: HTML (게시물 목록)
       │
       │ [게시물번호: 1037600, 1037599, 1037598, ...]
       ▼
┌──────────────┐     POST /board/comment/
│  api.js      │────────────────────────────────────────────────────────►
│ fetchComments│     Body: { id, no, e_s_n_o, comment_page }
│ (1037600)    │◄────────────────────────────────────────────────────────
└──────┬───────┘     Response: JSON/HTML (댓글 목록)
       │
       │ 댓글: [{nick:"ㅇㅇ(183.99)", no:5001}, {nick:"고닉", no:5002}, ...]
       ▼
┌──────────────┐
│  parser.js   │  → 유동닉 필터링 → [{nick:"ㅇㅇ(183.99)", no:5001}]
│ filterFluid()│
└──────┬───────┘
       │
       │ 유동닉 댓글 발견! (1개)
       ▼
┌──────────────┐     POST /board/comment/comment_delete_submit
│  api.js      │────────────────────────────────────────────────────────►
│ deleteComment│     Body: { id, no, comment_no: 5001, ci_t }
│ (5001)       │◄────────────────────────────────────────────────────────
└──────┬───────┘     Response: { result: 'success' }
       │
       │ ✅ 삭제 성공 → 로그 기록
       │ 400ms 딜레이
       ▼
┌──────────────┐
│  다음 게시물  │ → 같은 과정 반복 → ... → 5페이지까지 → 1페이지 재시작
└──────────────┘
```

---

## 9. 설정 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `galleryId` | `thesingularity` | 대상 갤러리 ID |
| `galleryType` | `mgallery` | 갤러리 타입 (mgallery/board) |
| `maxPage` | `5` | 순회할 최대 페이지 수 |
| `requestDelay` | `400` | API 요청 간 딜레이 (ms) |
| `cycleDelay` | `5000` | 사이클 간 대기 시간 (ms) |
| `maxRetries` | `3` | API 실패 시 최대 재시도 |
| `logMaxSize` | `100` | 최대 로그 보관 수 |

---

## 10. 보안 고려사항

1. **쿠키/세션**: `credentials: 'include'`로 기존 세션 사용, 별도 인증 정보 저장 안 함
2. **CSRF 토큰**: `e_s_n_o`, `ci_t` 등 토큰은 매 요청 시 페이지에서 동적 추출
3. **코드 보안**: Extension은 로컬에서만 실행, 외부 서버 통신 없음
4. **레이트 리밋**: 적절한 딜레이로 계정 차단 방지

---

## 11. 구현 우선순위

### Phase 1: 기본 동작 (MVP)
- [ ] manifest.json 설정
- [ ] API 엔드포인트 리버스 엔지니어링 (네트워크 탭 확인)
- [ ] 게시물 목록 가져오기
- [ ] 댓글 목록 가져오기 + 유동닉 필터링
- [ ] 댓글 삭제 API 호출
- [ ] 기본 팝업 UI (토글 ON/OFF)
- [ ] 순회 스케줄러

### Phase 2: 안정화
- [ ] 에러 처리 및 재시도 로직
- [ ] Service Worker 활성 유지
- [ ] 레이트 리밋 대응
- [ ] 로그 시스템
- [ ] 상태 저장/복원

### Phase 3: 고도화
- [ ] 상세 통계 (시간대별 삭제 현황)
- [ ] IP 대역별 통계
- [ ] 알림 기능 (삭제 발생 시)
- [ ] 삭제 기준 커스터마이징 (특정 IP만, 키워드 포함 등)
- [ ] 화이트리스트 (특정 유동닉 보호)

---

## 12. 다음 단계

1. **API 리버스 엔지니어링**
   - 디시인사이드 게시물 페이지에서 Chrome DevTools → Network 탭으로 실제 API 엔드포인트 확인
   - 댓글 로딩 시 호출되는 XHR 요청 캡처
   - 부매니저로 댓글 삭제 시 호출되는 XHR 요청 캡처
   - 필수 파라미터 (`e_s_n_o`, `ci_t` 등) 확인

2. **Chrome Extension 기본 구조 구현**
   - 확인된 API 정보를 기반으로 구현 시작

---

> **⚠️ 핵심 사전 작업**: Phase 1 구현 전에 반드시 브라우저 네트워크 탭에서 실제 API 엔드포인트와 파라미터를 확인해야 합니다. 이 문서의 API URL과 파라미터는 추정값이며, 실제 값과 다를 수 있습니다.
