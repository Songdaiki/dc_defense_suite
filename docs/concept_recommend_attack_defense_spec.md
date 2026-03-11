# 개념글 주작기 방어 스펙

## 목적

특이점 갤러리의 개념글 목록이 유동 추천 테러로 오염되는 상황을 자동으로 탐지하고,
부매니저 권한으로 개념글 해제를 수행하는 보조 자동화를 정의한다.

이 기능의 목적은 다음과 같다.

- 개념글 목록의 최신 글을 주기적으로 점검한다.
- 총 추천 수 대비 고정닉 추천 비율이 지나치게 낮은 글을 찾는다.
- 1차 기본 운영은 **테스트 모드**로 두고, 기준을 넘는 글은 우선 식별/로그한다.
- 실행 모드에서는 기준을 넘는 글에 대해 개념글 해제를 시도한다.
- 성공/실패를 내부 로그에 남긴다.

이 문서는 로그인 자동화와 분리해서, 개념글 주작기 방어 기능만 다룬다.

## 배경 근거

현재 저장된 HTML 기준으로 개념글 주작기 방어에 필요한 데이터는 이미 확인된다.

- 개념글 목록 URL은 `exception_mode=recommend` 이다.
  - 근거: [개념글(추천수65).md](../projects/dc_auto_bot/docs/개념글(추천수65).md)
- 개별 글 view HTML에는 총 추천 수와 고정닉 추천 수가 존재한다.
  - 총 추천 수: `recommend_view_up_<postNo>`
  - 고정닉 추천 수: `recommend_view_up_fix_<postNo>`
- 개별 글 view HTML에는 현재 개념글 여부를 나타내는 hidden input `#recommend` 가 존재한다.
  - `value="K"` 이면 현재 개념글
- 매니저 권한 view HTML에는 `개념글 해제` 버튼이 존재한다.
  - 버튼 클릭 스크립트: `update_recom('REL', postNo);`
- 실제 해제 요청은 내부 API로 확인되었다.
  - `POST /ajax/minor_manager_board_ajax/set_recommend`
  - `mode=REL` 이면 해제
  - `mode=SET` 이면 등록
- `set_recommend`의 raw HAR/응답 파일은 현재 repo에 별도 보관하지 않는다.
  - 다만 이 문서는 기존 캡처/검증 결과를 정리한 **구현 계약 문서**로 간주한다.
  - 1차 구현은 본 문서의 endpoint / payload / 성공 판정 규칙을 기준으로 진행한다.

## 구현하고자 하는 플로우

1. 자동화가 켜져 있으면 주기적으로 개념글 목록 page 1을 조회한다.
2. 개념글 목록에서 실제 게시물 row의 게시물 번호를 최신순으로 최대 5개 추출한다.
3. 각 게시물의 view 페이지를 순회한다.
4. 각 글에서 아래 값을 읽는다.
   - 현재 개념글 여부
   - 총 추천 수
   - 고정닉 추천 수
5. 유동 추천 수와 유동 추천 비율을 계산한다.
6. 해제 기준을 만족하면 후보로 기록한다.
7. 테스트 모드면 식별/로그만 남기고, 실행 모드면 개념글 해제를 시도한다.
8. 해제 후 대상 글 view 를 다시 조회해 실제 개념글 해제 여부를 재확인한다.
9. 성공/실패를 내부 로그에 남긴다.
10. 다음 주기에 반복한다.

## 확정된 스펙

### 1. 검사 대상

- URL:
  - `https://gall.dcinside.com/mgallery/board/lists/?id=thesingularity&exception_mode=recommend`
- 검사 범위:
  - 개념글 목록 page 1의 최신 게시물 5개
- 목록에서 `공지`, `설문`, 숫자 글번호가 아닌 row는 제외하고 **실제 게시물 row만** 센다.
- 즉, DOM 상단 5줄이 아니라 필터링 후 최신 게시물 5개를 snapshot 대상으로 본다.

### 2. 현재 개념글 여부

- 개별 글 view HTML에서 hidden input `#recommend` 를 읽는다.
- `#recommend === "K"` 인 경우만 실제 해제 후보로 본다.

### 3. 추천 수 계산

- `totalRecommendCount = 총 추천 수`
- `fixedNickRecommendCount = 고정닉 추천 수`
- `fluidRecommendCount = totalRecommendCount - fixedNickRecommendCount`
- `fluidRatio = fluidRecommendCount / totalRecommendCount`

### 4. 해제 기준

- **유동 추천 비율이 90% 이상이면 개념글 해제**
- 즉:
  - `fluidRatio >= 0.9`

### 5. 최소 추천 수 예외

- 별도 최소 추천 수 예외는 두지 않는다.
- 이유:
  - 개념글 목록에 이미 올라왔다는 것은 개념글 컷을 넘은 상태이기 때문이다.

### 6. 실행 주기

- 기본 주기: `30초`

주기 30초를 기본값으로 두는 이유:

- 개념글 목록 조회 1회
- 게시물 view 최대 5회
- 해제 실행 시도
를 한 cycle 안에서 처리해야 한다.

현재 구현은 cycle 시작 시각 기준으로 다음 cycle을 맞추고,
5개 검사 사이에 약 `5초 ± 0.5초`의 간격을 둬서 한 번에 몰아치지 않도록 한다.

1분은 너무 촘촘해서 불필요한 재조회와 중복 시도가 늘 수 있고,
2분 이상은 대응이 늦어질 수 있으므로 1차 기본값은 30초로 잡는다.

추가 운영 원칙:

- **1차 기본 운영 모드는 테스트 모드 ON**
- 테스트 모드에서는 해제 후보 식별과 내부 로그 기록만 수행한다.
- 테스트 모드에서는 `set_recommend(mode=REL)` 요청을 보내지 않는다.
- 실행 모드는 운영자가 명시적으로 테스트 모드를 끈 뒤에만 사용한다.

### 7. 중복 시도 정책

- 별도 cooldown 정책은 두지 않는다.
- 이유:
  - 개념글 해제에 성공하면 해당 글은 개념글 목록에서 사라진다.
- 단, 해제 실패 시에는 다음 cycle에서 다시 시도할 수 있다.

### 8. 실패 정책

- 개념글 해제 실패 시:
  - 내부 로그에 경고를 남긴다.
  - 다음 cycle에서 다시 검사/재시도한다.
- 실패 응답 메시지 분류가 아직 확정되지 않은 경우:
  - 응답 body / 파싱 결과 / HTTP status에서 확보 가능한 **raw 에러 정보 그대로** 내부 로그에 남긴다.
  - 운영 중 실제 샘플이 쌓이면 이후 버전에서 `관리권한 없음`, `정상적인 접근이 아닙니다`, `이미 해제됨`, `삭제됨` 등으로 후분류한다.

### 9. Cycle 처리 정책

- 각 cycle 시작 시 개념글 목록 page 1을 한 번 조회해 대상 postNo 최대 5개를 확정한다.
- 해당 cycle에서는 **처음 확보한 5개 snapshot 기준으로 순차 처리**한다.
- cycle 도중 개념글 해제에 성공해도 즉시 목록을 다시 읽지 않는다.
- 다음 cycle 시작 시 최신 개념글 목록을 다시 조회한다.

이 규칙을 두는 이유:

- 구현 단순성 유지
- 동일 cycle 안에서 목록 재정렬/사라짐으로 인한 인덱스 꼬임 방지
- 내부 로그와 재현성 유지

### 10. 해제 요청 스펙

개념글 해제는 내부 API로 아래와 같이 호출한다.

- Method:
  - `POST`
- URL:
  - `https://gall.dcinside.com/ajax/minor_manager_board_ajax/set_recommend`
- Content-Type:
  - `application/x-www-form-urlencoded; charset=UTF-8`
- 필수 form data:
  - `ci_t=<ci_c cookie 값>`
  - `id=thesingularity`
  - `nos[]=<postNo>`
  - `_GALLTYPE_=M`
  - `mode=REL`
- 필수 헤더:
  - `X-Requested-With: XMLHttpRequest`
  - `Origin: https://gall.dcinside.com`
  - `Referer: https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=<postNo>&page=<n>`

등록은 같은 endpoint를 사용하고, `mode=SET` 만 다르다.

이 기능은 해제만 다루므로 1차 구현에서는 `mode=REL`만 사용한다.

### 11. 해제 성공 판정

응답 body는 비어 있을 수 있으므로, success body에 의존하지 않는다.

1차 구현의 성공 판정은 아래 순서로 한다.

1. 해제 API 요청의 HTTP status가 `200` 이다.
2. 대상 글 view HTML을 다시 조회한다.
3. `#recommend !== "K"` 이면 해제 성공으로 본다.

보조 확인:

- 필요하면 개념글 목록 page 1을 다시 조회해 해당 postNo가 사라졌는지도 확인할 수 있다.

### 12. 예외 / 방어 규칙

- `totalRecommendCount <= 0` 이면 ratio 계산을 하지 않고 스킵한다.
- `fixedNickRecommendCount > totalRecommendCount` 같은 비정상 값이 오면
  - 로그 경고
  - 해당 cycle 스킵
- 대상 글 view 조회 실패
  - 로그 경고
  - 다음 cycle 재시도
- 해제 요청 후 재확인 실패
  - `해제 결과 불명확` 경고 로그
  - 다음 cycle 재시도 가능
- 해제는 1차 구현에서 **한 번에 한 게시물씩** 실행한다.
  - `nos[]`가 배열 형식이라 batch도 가능하지만,
  - 로그/실패 추적을 단순하게 유지하기 위해 1건씩 처리한다.

### 13. UI 범위

1차 자동화 탭에는 아래 설정만 둔다.

- ON/OFF
- 검사 주기
- 유동 추천 비율 threshold
- 테스트 모드 ON/OFF

UI 안전장치:

- 테스트 모드가 꺼져 있으면 상태를 `실행 모드`로 명확히 표시한다.
- 테스트 모드에서 실행 모드로 바꾸는 저장 동작은 사용자 확인을 한 번 더 거친다.
- 실행 모드에서 ON 할 때도 사용자 확인을 한 번 더 거친다.

### 14. 로그 정책

- 1차는 공개 transparency 사이트에는 연결하지 않는다.
- 내부 로그만 남긴다.

예시 로그:

- `개념글 해제 후보 #104xxxx - 총추천 17, 고정닉 0, 유동비율 1.00`
- `개념글 해제 실행 #104xxxx`
- `개념글 해제 완료 #104xxxx`
- `개념글 해제 실패 #104xxxx - 관리권한 없음`
- `개념글 해제 결과 불명확 #104xxxx - 재확인 실패`
- `개념글 해제 실패 #104xxxx - HTTP 200 / raw: {"msg":"관리권한이 없습니다"}`
- `개념글 해제 실패 #104xxxx - HTTP 403 / raw: 정상적인 접근이 아닙니다`

### 15. 구현 방식

- **내부 API 기반으로 구현한다.**

이 repo는 이미 여러 기능을 내부 AJAX endpoint 기반으로 구현하고 있다.

예:

- `features/ip/api.js`
- `features/post/api.js`
- `features/comment/api.js`

따라서 개념글 해제도 프로젝트 스타일에 맞게 내부 API 기반으로 구현하는 것이 맞다.

## 추후 보강 가능 정보

### 1. 실패 응답 형태

내부 API 요청 계약은 이미 확보되었지만, 실패 응답 body가 비어 있는지, 메시지가 별도 반환되는지까지는 상황별 수집이 더 필요하다.

확인 필요:

- 관리권한 없음
- 정상적인 접근이 아닙니다
- 이미 해제됨
- 게시물 삭제됨

이 정보는 **1차 구현의 blocker가 아니다.**

1차 구현 방침:

- 실패 시 응답 raw를 그대로 내부 로그에 남긴다.
- 운영 중 실제 샘플이 확보되면 패턴별 사용자 친화 메시지 매핑을 추가한다.

### 2. 증거 보관 형태

- 현재 repo에는 `set_recommend` raw 요청/응답 캡처 파일을 별도 artifact로 저장하지 않는다.
- 대신 본 문서와 저장된 HTML 근거를 구현 기준 문서로 사용한다.
- 따라서 추가 raw 캡처가 없더라도 1차 구현 진행에는 문제가 없다.

## 1차 구현 범위

1차 구현에서는 아래까지를 목표로 한다.

1. 개념글 목록 최신 5개 추출
2. 각 글의 총 추천 수 / 고정닉 추천 수 / 개념글 여부 확인
3. `fluidRatio >= 0.9` 조건 판정
4. 테스트 모드 기본값 ON 상태로 해제 후보 식별/로그
5. 내부 API 기반 개념글 해제 실행 경로 준비
6. 해제 후 view 재조회 기반 성공/실패 재확인
7. 성공/실패 내부 로그 기록
8. 새 자동화 탭에서 ON/OFF, 주기, threshold, 테스트 모드 설정

## 구현 전 최종 체크리스트

- [ ] 개념글 목록 page 1에서 게시물 번호 5개 추출 가능
- [ ] 개별 글 view HTML에서 총 추천 수 추출 가능
- [ ] 개별 글 view HTML에서 고정닉 추천 수 추출 가능
- [ ] `#recommend === "K"` 확인 가능
- [x] `update_recom('REL', postNo)` 내부 API 요청 구조 확보 완료
- [x] `mode=REL|SET`, `ci_t`, `id`, `nos[]`, `_GALLTYPE_=M` 확인 완료
- [x] `Referer`, `Origin`, `X-Requested-With` 패턴 확인 완료
- [x] 실패 응답 미분류 시 raw 그대로 내부 로그에 남기는 1차 정책 확정
