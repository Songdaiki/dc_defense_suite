# 댓글 IP 차단 기능 스펙

> 작성일: 2026-03-14
> 상태: 스펙 확정 (구현 전)

## 1. 목적

현재 댓글 방어는 **삭제만** 수행한다. (`delete_comment` API)
유동닉 댓글을 삭제할 때 **IP 차단도 함께** 수행하도록 변경한다.

## 2. API 스펙 (실제 네트워크 캡처 기반)

### 2.1 기존: 댓글 삭제만

```
POST /ajax/minor_manager_board_ajax/delete_comment

파라미터:
  ci_t        = <ci_c 쿠키>
  id          = thesingularity
  _GALLTYPE_  = M
  pno         = <게시물 번호>
  cmt_nos[]   = <댓글 번호>  (복수 가능)
```

### 2.2 신규: 댓글 삭제 + IP 차단 (동시)

```
POST /ajax/minor_manager_board_ajax/update_avoid_list

파라미터:
  ci_t            = <ci_c 쿠키>
  id              = thesingularity
  nos[]           = <댓글 번호>       ← 게시물 번호가 아님!
  parent          = <게시물 번호>     ← 댓글이 속한 게시물
  avoid_hour      = 1                ← 차단 시간 (시)
  avoid_reason    = 0                ← "기타"
  avoid_reason_txt = 도배기로 인한 해당 유동IP차단
  del_chk         = 1                ← 삭제도 함께
  _GALLTYPE_      = M
  avoid_type_chk  = 1                ← IP 차단

응답 (성공):
  {"result":"success","msg":"차단 및 삭제되었습니다."}
```

### 2.3 게시물 차단과의 차이

| 필드 | 게시물 차단 | 댓글 차단 |
|------|-----------|----------|
| `nos[]` | 게시물 번호 | **댓글 번호** |
| `parent` | `''` (빈값) | **게시물 번호** |
| 나머지 | 동일 | 동일 |

## 3. 영향 범위

### 3.1 수정 대상 파일

| 파일 | 변경 내용 |
|------|----------|
| `features/comment/api.js` | `deleteAndBanComments()` 함수 추가 |
| `features/comment/scheduler.js` | 삭제 시 차단 옵션 분기 |
| `popup/popup.html` | 댓글 방어 설정에 "IP 차단" 체크박스 추가 |
| `popup/popup.js` | 설정 저장/로드 로직 추가 |

### 3.2 수정하지 않는 파일

| 파일 | 이유 |
|------|------|
| `features/comment-monitor/scheduler.js` | comment scheduler를 제어만 함 → scheduler에 차단이 붙으면 자동 적용 |
| `features/ip/api.js` | 게시물 차단 전용, 댓글과 별개 |

## 4. 상세 설계

### 4.1 새 API 함수: `deleteAndBanComments()`

```javascript
async function deleteAndBanComments(config, postNo, commentNos) {
  // config에서 필요한 값:
  //   avoidHour (기본 1)
  //   avoidReason (기본 '0')
  //   avoidReasonText (기본 '도배기로 인한 해당 유동IP차단')
  //   delChk (기본 true)
  //   avoidTypeChk (기본 true)

  const body = new URLSearchParams();
  body.set('ci_t', ciToken);
  body.set('id', config.galleryId);
  body.set('parent', String(postNo));           // ← 게시물 번호
  body.set('avoid_hour', String(config.avoidHour));
  body.set('avoid_reason', String(config.avoidReason));
  body.set('avoid_reason_txt', config.avoidReasonText);
  body.set('del_chk', config.delChk ? '1' : '0');
  body.set('_GALLTYPE_', config.galleryType);
  body.set('avoid_type_chk', config.avoidTypeChk ? '1' : '0');

  for (const cno of commentNos) {
    body.append('nos[]', String(cno));          // ← 댓글 번호
  }

  // POST /ajax/minor_manager_board_ajax/update_avoid_list
}
```

### 4.2 Scheduler 설정 추가

```javascript
this.config = {
  // ... 기존 설정 ...
  banOnDelete: false,           // IP 차단 동시 수행 여부
  avoidHour: '1',               // 차단 시간
  avoidReason: '0',             // 차단 사유 코드 (기타)
  avoidReasonText: '도배기로 인한 해당 유동IP차단',
  avoidTypeChk: true,           // IP 차단 (true)
};
```

### 4.3 Scheduler 삭제 로직 분기

```
processPost() 내부:

  if (config.banOnDelete) {
    deleteAndBanComments(config, postNo, commentNos)
    // → 삭제 + IP 차단 동시
  } else {
    deleteComments(config, postNo, commentNos)
    // → 기존: 삭제만
  }
```

### 4.4 팝업 UI 추가

댓글 방어 설정 섹션에:
- [x] 삭제 시 IP 차단 (`banOnDelete`)
- 차단 시간: [1] 시간 (`avoidHour`)

## 5. 병렬 처리 영향

### 5.1 현재 병렬 구조 (유지)

```
페이지 1~5 순차
  └─ 50개 게시물 병렬
       └─ 4페이지 댓글 병렬 조회
            └─ 유동닉 필터 → 삭제(+차단)
```

### 5.2 주의사항

- `update_avoid_list`는 **배치 처리 가능** (nos[]에 여러 댓글 번호)
- 단, 한 요청의 `parent`는 **하나의 게시물**이므로 게시물 단위 배치는 유지
- 기존 `delete_comment`도 배치였으므로 API 호출 수는 동일
- **레이트 리밋 위험:** 차단 API가 삭제보다 레이트 리밋이 엄격할 수 있음 → 필요 시 `requestDelay` 조정

## 6. TODO (구현 순서)

- [ ] `features/comment/api.js` — `deleteAndBanComments()` 추가
- [ ] `features/comment/scheduler.js` — config 추가 + 분기 처리
- [ ] `popup/popup.html` — IP 차단 설정 UI
- [ ] `popup/popup.js` — 설정 저장/로드
- [ ] `background/background.js` — 메시지 핸들러에 새 config 반영
- [ ] 테스트: 수동 모드에서 삭제+차단 동작 확인
- [ ] 테스트: 자동화 모드에서 자동 시작 시 삭제+차단 동작 확인
