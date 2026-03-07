# DC Post Protect - API 스펙 문서

> 작성일: 2026-03-07
> 상태: 게시물 목록 유동닉 판별 ✅ 확인 완료 / 머릿말 분류 API ❌ 리버싱 필요
> 갤러리: 특이점이 온다 (thesingularity) - 마이너 갤러리

---

## 1. 게시물 목록 API ✅ (확인 완료)

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
- 게시물 행에서 작성자 정보 파싱 가능

### 유동닉 판별 (목록 HTML에서) ✅ 확인 완료

#### 게시물 행 HTML 구조

**유동닉 게시물 (삭제 대상):**
```html
<tr class="ub-content us-post" data-no="1041288" data-type="icon_txt">
  <td class="gall_chk">...</td>
  <td class="gall_num">1041288</td>
  <td class="gall_subject">일반</td>
  <td class="gall_tit ub-word">...</td>
  <td class="gall_writer ub-writer"
      data-nick="ㅇㅇ"
      data-uid=""              ← 빈 문자열 (계정 없음)
      data-ip="115.4"          ← 🔑 IP 있음 → 유동닉!
      data-loc="list">
    ...
  </td>
  <td class="gall_date" title="2026-03-07 12:35:00">12:35</td>
  <td class="gall_count">94</td>
  <td class="gall_recommend">0</td>
</tr>
```

**고정닉 게시물 (보존):**
```html
<tr class="ub-content us-post" data-no="1041284" data-type="icon_pic">
  <td class="gall_chk">...</td>
  <td class="gall_num">1041284</td>
  <td class="gall_subject">일반</td>
  <td class="gall_tit ub-word">...</td>
  <td class="gall_writer ub-writer"
      data-nick="행복한천국으로"
      data-uid="adjust7431"    ← 계정 ID 있음
      data-ip=""               ← 빈 문자열 → 고정닉
      data-loc="list">
    <span class="nickname in" title="행복한천국으로" style="">
      <em>행복한천국으로</em>
    </span>
    <a class="writer_nikcon">...</a>
  </td>
  <td class="gall_date" title="2026-03-07 12:31:04">12:31</td>
  <td class="gall_count">359</td>
  <td class="gall_recommend">3</td>
</tr>
```

#### 판별 로직 (확정)

| 속성 | 유동닉 | 고정닉 |
|------|--------|--------|
| `data-ip` | `"115.4"` (값 있음) | `""` (빈 문자열) |
| `data-uid` | `""` (빈 문자열) | `"adjust7431"` (값 있음) |
| `data-nick` | `"ㅇㅇ"` | `"행복한천국으로"` |

```javascript
// ✅ 확정된 유동닉 판별 로직
function isFluidPost(writerTd) {
    const ip = writerTd.getAttribute('data-ip');
    return ip !== null && ip !== '';  // IP 있으면 유동닉
}
```

#### 게시물 번호 추출

```javascript
// <tr> 태그의 data-no 속성에서 추출
const postNo = tr.getAttribute('data-no');  // "1041288"
```

#### 현재 머릿말 확인

```javascript
// <td class="gall_subject">에서 현재 머릿말 텍스트 확인
const currentHead = tr.querySelector('.gall_subject').textContent;  // "일반"
```

> ⚡ **핵심**: 게시물에 진입할 필요 없이 목록 HTML만으로 유동닉 판별 가능!

---

## 2. 머릿말(탭) 분류 API ✅ 확인 완료

### 엔드포인트

```
POST https://gall.dcinside.com/ajax/minor_manager_board_ajax/chg_headtext_batch
```

### Form Data (확정)

| 파라미터 | 값 예시 | 설명 |
|---------|---------|------|
| `ci_t` | `51cb08156bd7078a...` | CSRF 토큰 (`ci_c` 쿠키값) |
| `id` | `thesingularity` | 갤러리 ID |
| `nos[]` | `1040944` | 게시물 번호 (배열 파라미터) |
| `_GALLTYPE_` | `M` | 마이너 갤러리 |
| `headtext` | `130` | 🔑 **도배기 머릿말 번호** |

### Request Headers

```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Referer: https://gall.dcinside.com/mgallery/board/lists/?id=thesingularity
Origin: https://gall.dcinside.com
```

### Response

- Status: `200 OK`
- Content-Type: `text/html; charset=UTF-8`
- Body: 새로고침으로 인해 본문 캡처 불가, 하지만 200 OK → 정상 동작 확인

### 구현 예시

```javascript
async function classifyAsSpam(postNos) {
    const ciToken = await getCiToken();
    
    const bodyParts = [
        `ci_t=${encodeURIComponent(ciToken)}`,
        `id=${encodeURIComponent('thesingularity')}`,
        `_GALLTYPE_=M`,
        `headtext=130`,  // 도배기
    ];
    
    // nos[]는 배열 파라미터
    for (const no of postNos) {
        bodyParts.push(`nos%5B%5D=${encodeURIComponent(String(no))}`);
    }
    
    const response = await fetch(
        'https://gall.dcinside.com/ajax/minor_manager_board_ajax/chg_headtext_batch',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Referer': 'https://gall.dcinside.com/mgallery/board/lists/?id=thesingularity',
                'Origin': 'https://gall.dcinside.com',
            },
            body: bodyParts.join('&'),
        }
    );
    
    return response.ok;
}
```

---

## 3. 도배기 머릿말 번호 ✅ 확인 완료

- **도배기 = `130`**
- §2 머릿말 분류 API의 `headtext` 파라미터에서 확인됨

---

## 4. ci_t 토큰 ✅ (기존 프로젝트에서 확인 완료)

- `ci_t` = `ci_c` 쿠키 값
- Chrome Extension에서 `chrome.cookies.get()` 으로 추출 가능

```javascript
async function getCiToken() {
  const cookie = await chrome.cookies.get({
    url: 'https://gall.dcinside.com',
    name: 'ci_c',
  });
  return cookie ? cookie.value : null;
}
```

---

## 5. TODO (리버싱 작업 목록)

### 필수 확인
- [x] 게시물 목록 HTML에서 유동닉 IP 표시 구조 확인 → **`data-ip` 속성으로 판별 확정**
- [x] 머릿말 분류 API 엔드포인트 캡처 → **`chg_headtext_batch`**
- [x] 머릿말 분류 API 파라미터 확인 → **ci_t, id, nos[], _GALLTYPE_, headtext**
- [x] "도배기" 머릿말 번호 확인 → **`130`**
- [x] 분류 API Response 형태 확인 → **200 OK**

### 선택 확인
- [x] 한 번에 복수 게시물 분류 가능한지 → **`nos[]` 배열 파라미터로 가능 (추정)**
- [ ] 이미 도배기로 분류된 게시물 재분류 시 에러 여부
- [ ] 레이트 리밋 정책

---

> ✅ **리버싱 완료!** 필수 항목 모두 확인됨. 구현 준비 완료.

