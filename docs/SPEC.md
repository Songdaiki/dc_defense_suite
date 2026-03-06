# DC Comment Protect - API 스펙 문서

> 작성일: 2026-03-07
> 상태: 댓글 목록 API ✅ 확인 완료 / 댓글 삭제 API ✅ 확인 완료
> 갤러리: 특이점이 온다 (thesingularity) - 마이너 갤러리

---

## 1. 댓글 목록 API ✅ (확인 완료)

### 엔드포인트

```
POST https://gall.dcinside.com/board/comment/
```

### Request Headers

```
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Referer: https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no={게시물번호}
```

### Request Body (Form Data)

| 파라미터 | 값 예시 | 설명 | 필수 |
|---------|---------|------|------|
| `id` | `thesingularity` | 갤러리 ID | ✅ |
| `no` | `1037528` | 게시물 번호 | ✅ |
| `cmt_id` | `thesingularity` | 댓글 갤러리 ID (= id와 동일) | ✅ |
| `cmt_no` | `1037528` | 댓글 게시물 번호 (= no와 동일) | ✅ |
| `e_s_n_o` | `3eabc219ebdd65fe3eef85e4` | 🔑 암호화 토큰 (페이지 소스에서 추출) | ✅ |
| `comment_page` | `1` | 댓글 페이지 번호 | ✅ |
| `sort` | `D` | 정렬 (D=최신순) | ✅ |
| `_GALLTYPE_` | `M` | 갤러리 타입 (M=마이너) | ✅ |

### Response (JSON)

```json
{
  "total_cnt": 23,           // 전체 댓글 수
  "comment_cnt": 0,          // (용도 미확인)
  "comments": [ ... ],       // 댓글 배열
  "pagination": "...",       // 페이지네이션 HTML
  "allow_reply": 1,          // 답글 허용 여부
  "comment_view_cnt": 3,     // (용도 미확인)
  "nft": false               // NFT 관련
}
```

### 댓글 객체 구조

```json
{
  "no": "4122459",           // 🔑 댓글 고유번호 (삭제 시 필요)
  "parent": "1037631",       // 게시물 번호
  "user_id": "nyannyanchung",// 회원 ID (유동닉은 빈 문자열 "")
  "name": "댕댕충",           // 닉네임 (Unicode 인코딩)
  "ip": "",                  // 🔑 IP 주소 (유동닉만 값 있음, 고정닉은 "")
  "reg_date": "03.07 02:08:07", // 등록 일시
  "nicktype": "20",          // 닉네임 타입 (아래 표 참조)
  "t_ch1": "0",              // (용도 미확인)
  "t_ch2": "0",              // (용도 미확인)
  "vr_type": "",             // VR 타입
  "voice": null,             // 음성 댓글
  "rcnt": "2",               // 대댓글 수
  "c_no": 0,                 // 부모 댓글 번호 (대댓글인 경우)
  "depth": 0,                // 깊이 (0=원댓글, 1=대댓글)
  "del_yn": "N",             // 삭제 여부
  "is_delete": "0",          // 삭제 상태
  "password_pop": "Y",       // 비밀번호 팝업 여부
  "copy_no": null,           // (용도 미확인)
  "memo": "댓글 내용",       // 댓글 본문 (HTML 포함 가능)
  "my_cmt": "N",             // 내 댓글 여부
  "del_btn": "Y",            // 🔑 삭제 버튼 표시 여부 (부매니저 권한 확인)
  "mod_btn": "N",            // 수정 버튼 표시 여부
  "a_my_cmt": "N",           // (용도 미확인)
  "reply_w": "Y",            // 답글 작성 가능 여부
  "gallog_icon": "...",      // 닉네임 HTML (갤로그 아이콘 포함)
  "vr_player": false,        // VR 플레이어
  "vr_player_tag": ""        // VR 플레이어 태그
}
```

---

## 2. 유동닉 판별 로직 ✅ (확인 완료)

### 핵심 판별 조건

```javascript
// ✅ 확정된 유동닉 판별 로직 (가장 간단하고 정확)
function isFluidUser(comment) {
  return comment.ip !== "";
}
```

> **근거**: 실제 API 응답에서 확인
> - 고정닉(로그인): `ip: ""` (빈 문자열)
> - 유동닉(비로그인): `ip: "220.87"` 등 IP 값 존재

### 검증된 실제 데이터

#### 고정닉 (삭제 안 함)
```json
{
  "no": "4122459",
  "user_id": "nyannyanchung",    // ✅ 계정 ID 있음
  "name": "댕댕충",
  "ip": "",                       // ✅ IP 없음 (빈 문자열)
  "nicktype": "20"                // ✅ 고정닉 타입
}
```

#### 유동닉 (삭제 대상)
```json
{
  "no": "4122461",
  "user_id": "",                  // ❌ 계정 ID 없음
  "name": "ㅇㅇ",
  "ip": "112.144",                // 🔴 IP 있음 → 유동닉!
  "nicktype": "02"                // 유동닉 타입
}
```

### 필터링 시 제외 대상

```javascript
// 댓글돌이(광고)는 필터링에서 제외
function shouldSkip(comment) {
  return comment.nicktype === "COMMENT_BOY"  // 댓글돌이 (광고)
      || comment.no === 0;                    // 시스템 댓글 (no가 0)
}
```

---

## 3. 닉네임 타입 (nicktype) ✅ (확인 완료)

| nicktype | 의미 | ip 필드 | user_id | 삭제 대상 |
|----------|------|---------|---------|-----------|
| `"00"` | 유동닉 (일반) | IP 있음 | `""` | ✅ 삭제 |
| `"02"` | 유동닉 (글쓴이) | IP 있음 | `""` | ✅ 삭제 |
| `"20"` | 고정닉 (로그인) | `""` | 계정ID | ❌ 보존 |
| `"COMMENT_BOY"` | 댓글돌이 (광고) | `""` | `""` | ❌ 무시 |

> **참고**: nicktype `"02"`는 해당 게시물의 글쓴이가 유동닉으로 댓글을 달았을 때 표시됨.
> HTML에 `<span class="font_grey">글쓴</span>` 라벨과 함께 표시됨.

---

## 4. e_s_n_o 토큰 🔑

### 설명
- 디시인사이드 API 호출 시 필수 토큰
- 매 페이지마다 새로운 값이 발행됨
- 게시물 페이지 HTML 소스에서 추출해야 함

### 추출 방법 (추정, 실제 확인 필요)
```javascript
// 게시물 페이지 HTML에서 e_s_n_o 값 추출
async function extractToken(postPageHtml) {
  // 방법 1: JavaScript 변수에서 추출
  const match = postPageHtml.match(/e_s_n_o\s*=\s*['"]([^'"]+)['"]/);
  if (match) return match[1];

  // 방법 2: hidden input에서 추출
  const inputMatch = postPageHtml.match(/name=['"]e_s_n_o['"][^>]*value=['"]([^'"]+)['"]/);
  if (inputMatch) return inputMatch[1];

  return null;
}
```

### 확인된 값 예시
```
e_s_n_o = "3eabc219ebdd65fe3eef85e4"
```
- 24자리 16진수 문자열
- 페이지 로드 시마다 갱신됨 (세션/시간 기반 추정)

---

## 5. 게시물 목록 API ✅ (확인 완료)

### 엔드포인트

```
GET https://gall.dcinside.com/mgallery/board/lists/?id={갤러리ID}&page={페이지}
```

### 파라미터

| 파라미터 | 값 예시 | 설명 |
|---------|---------|------|
| `id` | `thesingularity` | 갤러리 ID |
| `page` | `1` | 페이지 번호 (1~) |

### Response
- HTML 응답
- 게시물 목록에서 `data-no` 속성 또는 URL 패턴으로 게시물 번호 추출
- 게시물 행: `<tr class="ub-content" data-no="1037600">`

---

## 6. 댓글 삭제 API ✅ (확인 완료)

> 부매니저/매니저 전용 삭제 엔드포인트. 일반 유저 삭제 API와 별도.

### 엔드포인트

```
POST https://gall.dcinside.com/ajax/minor_manager_board_ajax/delete_comment
```

> ⚠️ 이 엔드포인트는 **마이너 갤러리** 전용. 일반 갤러리는 다른 엔드포인트일 수 있음.

### Request Headers

```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
Referer: https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no={게시물번호}
Origin: https://gall.dcinside.com
```

### Request Body (Form Data)

| 파라미터 | 값 예시 | 설명 | 필수 |
|---------|---------|------|------|
| `ci_t` | `fcb96095bc59a2ea0879d04fed327f9f` | 🔑 CSRF 토큰 (`ci_c` 쿠키값과 **동일**) | ✅ |
| `id` | `thesingularity` | 갤러리 ID | ✅ |
| `_GALLTYPE_` | `M` | 갤러리 타입 (M=마이너) | ✅ |
| `pno` | `1037498` | 게시물 번호 (**`no`가 아니라 `pno`**) | ✅ |
| `cmt_nos[]` | `4117646` | 🔑 삭제할 댓글 번호 (**배열! 복수 삭제 가능**) | ✅ |

### 핵심 발견

1. **`ci_t` = `ci_c` 쿠키 값**
   - 쿠키에서 `ci_c` 값을 읽으면 됨 → 별도 추출 불필요!
   - Chrome Extension에서는 `chrome.cookies.get()` 또는 쿠키 헤더에서 추출

2. **`cmt_nos[]`는 배열 파라미터**
   - 한 번의 요청으로 **여러 댓글 일괄 삭제 가능**
   - 요청 body: `cmt_nos[]=4117646&cmt_nos[]=4117647&cmt_nos[]=4117648`
   - 댓글 하나씩 삭제할 필요 없이, 유동닉 댓글을 모아서 한 번에 삭제!

3. **`pno` 파라미터명 주의**
   - 댓글 목록 API에서는 `no`를 사용하지만
   - 삭제 API에서는 `pno` (post number)를 사용

4. **`e_s_n_o` 토큰 불필요**
   - 삭제 API에는 `e_s_n_o` 토큰이 필요 없음! (댓글 목록 API에만 필요)

### 실제 cURL 예시 (확인됨)

```bash
curl 'https://gall.dcinside.com/ajax/minor_manager_board_ajax/delete_comment' \
  -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
  -H 'X-Requested-With: XMLHttpRequest' \
  -H 'Origin: https://gall.dcinside.com' \
  -H 'Referer: https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1037498&page=3' \
  --data-raw 'ci_t=fcb96095bc59a2ea0879d04fed327f9f&id=thesingularity&_GALLTYPE_=M&pno=1037498&cmt_nos%5B%5D=4117646'
```

### Response (추정, 확인 필요)

```json
{"result": "success"}  // 또는 유사한 성공/실패 응답
```

---

## 7. gallog_icon HTML 구조 ✅ (확인 완료)

### 고정닉 HTML
```html
<span class='nickname in' title='댕댕충' style=''>
  <em>댕댕충</em>
</span>
<a class='writer_nikcon'>
  <img src='https://nstatic.dcinside.com/dc/w/images/fix_nik.gif' ...>
</a>
```
- `class="nickname in"` → 고정닉
- `fix_nik.gif` 아이콘

### 유동닉 HTML
```html
<span class="nickname">
  <em title="ㅇㅇ">ㅇㅇ</em>
  <span class="ip">(220.87)</span>
</span>
```
- `class="nickname"` (in 클래스 없음)
- `<span class="ip">` 로 IP 표시

### 유동닉 (글쓴이) HTML
```html
<span class="nickname me">
  <em title="ㅇㅇ">
    <span class="font_grey">글쓴</span>
    ㅇㅇ
  </em>
  <span class="ip">(112.144)</span>
</span>
```
- `class="nickname me"` → 해당 게시물 작성자
- `<span class="font_grey">글쓴</span>` 라벨

---

## 8. 구현 시 주의사항

### 8.1 댓글 페이지네이션
- `total_cnt`로 전체 댓글 수 확인
- 한 페이지당 댓글 수는 약 20-25개 (정확한 수치 확인 필요)
- `comment_page` 파라미터로 페이지 이동
- `pagination` 필드에 페이지네이션 HTML 포함

### 8.2 대댓글 처리
- `depth: 0` → 원댓글
- `depth: 1` → 대댓글
- `c_no` → 부모 댓글 번호
- **대댓글도 유동닉이면 삭제 대상**

### 8.3 Unicode 인코딩
- 닉네임, 댓글 내용이 Unicode escaped 형태로 전달됨
- 예: `\u3147\u3147` → `ㅇㅇ`
- JSON.parse() 시 자동 디코딩됨

### 8.4 del_btn 필드
- `"Y"` → 삭제 버튼 표시 (= 삭제 권한 있음)
- 부매니저 로그인 시 모든 댓글에 `del_btn: "Y"`
- 권한 없으면 `"N"`으로 표시될 것으로 예상

---

## 9. TODO (남은 확인 작업)

- [x] 댓글 삭제 API 엔드포인트 및 파라미터 확인 → **`/ajax/minor_manager_board_ajax/delete_comment`**
- [ ] e_s_n_o 토큰 추출 위치 확인 (게시물 페이지 HTML 소스)
- [x] ci_t 토큰 존재 여부 및 추출 방법 확인 → **`ci_c` 쿠키값과 동일**
- [ ] 한 페이지당 정확한 댓글 수 확인
- [ ] 레이트 리밋 정책 확인 (몇 초 간격이 안전한지)
- [x] 매니저/부매니저 전용 삭제 API가 별도로 있는지 확인 → **있음! 일반 삭제와 별도 엔드포인트**
- [ ] 삭제 API Response 형태 확인
