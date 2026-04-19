# 신문고 댓글 등록 API 스펙

## 1. 목적

이 문서는 `신문고 게시물`에 관리자가 처리 결과 댓글을 남길 때 사용하는 실제 댓글 등록 요청 스펙을 정리한 것이다.

중요한 점은 하나다.

- 엔드포인트는 하나다.
- 하지만 폼은 둘이다.
- `고닉/로그인 댓글 폼`과 `유동/비회원 댓글 폼`을 섞으면 실패한다.

이번에 확보된 실요청 기준으로 보면, 댓글 등록은 우리가 기존에 쓰던 관리자 AJAX 삭제 API가 아니라 아래 경로를 사용한다.

- `POST /board/forms/comment_submit`

쉽게 말하면:

- 댓글 삭제: 관리자 전용 `/ajax/minor_manager_board_ajax/...`
- 댓글 등록: 게시글 댓글 작성 폼 전용 `/board/forms/comment_submit`

즉 `처리완료` 댓글 기능은 **전용 comment submit 경로를 정확히 맞춰 호출해야 한다.**

---

## 2. 현재 코드 기준 상태

현재 레포에는 신문고 댓글 등록 전용 구현이 이미 들어가 있다.

- 댓글 목록 조회: [features/comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/comment/api.js)
- 신문고 댓글 등록: [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js)
- 신문고 스케줄러: [features/sinmungo-comment/scheduler.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/scheduler.js)

아직 없는 것:

- 범용 답글 작성
- 댓글 수정

즉 현재는 **신문고 댓글 1회 등록 흐름은 구현됨**,
공용 댓글 작성/답글/수정 API로 일반화하는 작업은 아직 남아 있다.

---

## 3. 실캡처로 확인된 엔드포인트

### 3.1 요청

- Method: `POST`
- URL: `https://gall.dcinside.com/board/forms/comment_submit`
- Content-Type: `application/x-www-form-urlencoded; charset=UTF-8`
- 요청 방식: `XMLHttpRequest`

### 3.2 참조 페이지

- 예시 Referer:  
  `https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1045755&page=1`

즉 대상 게시물 view 페이지를 연 상태에서, 그 페이지에 들어있는 hidden 값들을 꺼내서 댓글 등록 요청을 만드는 구조다.
실제 전송도 배경 fetch보다 **디시 글 페이지 문맥에서 same-origin 요청**으로 보내는 쪽이 실브라우저 요청과 더 가깝다.

예시:

1. 신문고 글 `1045755`를 연다.
2. HTML 안에서 `check_6`, `service_code` 같은 hidden 값을 읽는다.
3. `memo=처리완료`를 넣어 `comment_submit`으로 POST 한다.

---

## 4. 요청 바디 스펙

아래는 이번에 확보된 실요청을 기준으로 정리한 필드다.

| 필드 | 예시 | 의미 | 비고 |
| --- | --- | --- | --- |
| `id` | `thesingularity` | 갤러리 id | 필수 |
| `no` | `1045755` | 게시물 번호 | 필수 |
| `reply_no` | `undefined` 또는 대상 댓글 번호 | 일반 댓글 / 답글 구분 | 이번 실성공 캡처는 최상위 댓글에서도 `undefined`를 사용 |
| `name` | `ㅇㅇ`, `だいき` 등 | 현재 댓글 작성자 표시명 | 로그인 폼은 `label for="user_nick"`를 반드시 읽어야 하며, 없으면 spec mismatch로 중단. 유동 폼은 비회원 닉 |
| `password` | `0989` | 비회원 댓글 비밀번호 | 유동/비회원 폼에서만 사용 |
| `code` | `5` 또는 빈값 | 댓글 인증코드 | 유동/비회원 폼에서만 사용 |
| `memo` | `처리완료` | 댓글 본문 | 필수 |
| `cur_t` | `1776594327` | 현재 시각 epoch seconds | 필수로 보임 |
| `check_6` | 해시값 | 페이지 hidden token | 게시물 HTML에서 추출 |
| `check_7` | 해시값 | 페이지 hidden token | 게시물 HTML에서 추출 |
| `check_8` | 해시값 | 페이지 hidden token | 게시물 HTML에서 추출 |
| `check_9` | 해시값 | 페이지 hidden token | 게시물 HTML에서 추출 |
| `check_10` | 해시값 | 페이지 hidden token | 게시물 HTML에서 추출 |
| `recommend` | `0` | 일반 등록 / 등록+추천 구분 | `0=등록`, 추천 버튼은 추가 확인 필요 |
| `c_r_k_x_z` | 해시값 | 페이지 hidden token | 게시물 HTML에서 추출 |
| `t_vch2` | 빈값 | 캡챠 관련 값으로 추정 | 현재 샘플은 빈값 |
| `t_vch2_chk` | 빈값 | 캡챠 관련 값으로 추정 | 현재 샘플은 빈값 |
| `c_gall_id` | `thesingularity` | 갤러리 id 중복 전달 | `id`와 동일 |
| `c_gall_no` | `1045755` | 게시물 번호 중복 전달 | `no`와 동일 |
| `service_code` | 긴 토큰 | 페이지 hidden token | 게시물 HTML에서 추출 |
| `g-recaptcha-response` | 빈값 | recaptcha | 초기 요청은 빈값. live `comment.js`는 실패 응답이 `false||captcha||v3`일 때 `g-recaptcha-token`을 붙여 재전송하는 분기가 있음 |
| `_GALLTYPE_` | `M` | 마이너 갤러리 타입 | `M` 고정 |
| `headTail` | `""` | 말머리/꼬리 관련 필드로 추정 | 현재 샘플은 빈 문자열 |
| `gall_nick_name` | `ㅇㅇ` | 갤닉 표시값 | 유동/비회원 폼에서만 사용 |
| `use_gall_nick` | `N` | 갤닉 사용 여부 | 유동/비회원 폼에서만 사용 |

---

## 5. 게시물 HTML에서 추출해야 하는 값

이번 캡처와 기존 저장 HTML 기준으로, 아래 값은 게시물 view HTML에 이미 들어 있다.

- `check_6`
- `check_7`
- `check_8`
- `check_9`
- `check_10`
- `c_r_k_x_z`
- `service_code`
- `cur_t`
- `_GALLTYPE_`
- `member_division`
- `comment_code`
- `use_gall_nick`
- `name_<postNo>` hidden input
- `gall_nick_name_<postNo>` input

확인 위치 예시:

- [docs/raw2.md](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/docs/raw2.md)
  - `check_6` ~ `check_10`
  - `c_r_k_x_z`
  - `service_code`
  - `use_gall_nick`

쉽게 말하면:

- `memo`만 내가 넣는 값
- 나머지 보호 토큰은 페이지가 미리 숨겨놓은 값

예시:

```txt
신문고 1045755 글 HTML을 읽는다
-> hidden input에서 check_6, service_code 추출
-> memo=처리완료 세팅
-> comment_submit POST
```

---

## 6. 최소 구현 플로우

### 6.1 일반 댓글 1개 등록

1. 게시물 view HTML 요청
2. 아래 값 추출
   - `id`
   - `no`
   - `check_6` ~ `check_10`
   - `c_r_k_x_z`
   - `service_code`
   - `cur_t`
   - `_GALLTYPE_`
   - `use_gall_nick`
   - `label for="user_nick"` 또는 `gall_nick_name_<postNo>`
3. `memo=처리완료` 세팅
4. 최상위 댓글이면 `reply_no=undefined`, 답글이면 `reply_no=<부모댓글번호>`
5. 고닉/로그인 폼이면 `name=<label for="user_nick">` 값을 사용하고, 이 라벨이 없으면 요청 자체를 중단
6. `recommend=0`
7. 디시 글 페이지 문맥에서 `POST /board/forms/comment_submit`
8. 응답이 숫자 댓글 번호면 1차 성공
9. 가능하면 댓글 목록 재조회로 2차 확인

### 6.2 답글로 달고 싶을 때

- `reply_no`에 부모 댓글 번호를 넣는다.

예시:

```txt
부모 신고 댓글 번호가 555001
-> reply_no=555001
-> memo=처리완료
-> 같은 comment_submit 호출
```

---

## 7. 구현 시 주의점

### 7.1 `reply_no`는 실성공 샘플처럼 맞춘다

이번 실성공 캡처에서는 최상위 댓글도 `reply_no=undefined`로 들어갔다.
현재 구현도 브라우저 성공 샘플에 맞춰 아래처럼 보낸다.

- 최상위 댓글: `reply_no='undefined'`
- 답글: `reply_no='<부모댓글번호>'`

### 7.2 `service_code`와 `check_*`는 캐시하면 안 됨

이 값들은 페이지마다 바뀔 수 있으므로, 댓글 달기 직전에 대상 글 HTML에서 새로 읽는 방식이 안전하다.

쉽게 말하면:

- 위험한 방식: 예전 글에서 뽑은 `service_code` 재사용
- 안전한 방식: 지금 댓글 달 글에서 다시 추출

### 7.3 성공 판정은 숫자 응답 + 목록 재조회 순으로 본다

지금 확보된 샘플에서는 성공 시 응답 바디가 댓글 번호 숫자(`예: 4502229`)로 내려온다.
그래서 구현은 아래 순서로 성공 판정을 잡는 게 맞다.

1. HTTP 상태 확인
2. 예외/차단 메시지 확인
3. 응답 바디가 순수 숫자면 1차 성공 처리
4. 가능하면 댓글 목록 재조회
5. `memo=처리완료` 또는 새 댓글 번호 존재 여부 확인

즉 “200이 왔다”만으로 끝내면 안 되지만,
숫자 댓글 번호 응답은 꽤 강한 성공 신호라서 바로 저장하고 재조회는 보강 확인으로 쓰는 구조가 합리적이다.

### 7.4 쿠키는 세션 그대로 전달돼야 함

이 요청은 익명 외부 API가 아니라, 브라우저 세션 상태를 타는 폼 요청이다.

필수 성격의 쿠키:

- `PHPSESSID`
- `PHPSESSKEY`
- `ci_session`
- `ci_c`
- `service_code`가 들어있는 현재 세션 쿠키 묶음

문서에는 실제 값 저장 금지.

### 7.5 배경 fetch보다 페이지 문맥 전송이 유리함

실패 응답 중에는 아래처럼 “비공식 확장 프로그램” 문구가 보였다.

- `올바른 방법으로 이용해 주세요. 디시인사이드 비공식 확장 프로그램이 실행된 경우 ...`

그래서 현재 구현은:

1. 배경에서 글 HTML을 읽어 토큰 추출
2. 실제 `comment_submit` POST는 디시 글 탭의 메인 문맥에서 전송

이 흐름으로 맞췄다.

---

## 8. 바로 구현할 함수 형태 제안

파일 후보:

- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js)

추가 후보 함수:

```js
async function submitComment(config, {
  submitMode = 'member',
  postNo,
  memo,
  replyNo = '',
  recommend = 0,
  name = 'ㅇㅇ',
  password = '',
  gallNickName = 'ㅇㅇ',
  useGallNick = 'N',
}) {}
```

내부 흐름 예시:

```txt
fetchPostPage()
-> hidden token 추출
-> body 구성
-> 디시 글 탭 메인 문맥에서 POST /board/forms/comment_submit
-> fetchComments() 재호출
-> 새 댓글 존재 확인
```

---

## 9. 요청 예시

### 9.1 고닉/로그인 테스트 예시

```txt
POST /board/forms/comment_submit

id=thesingularity
no=1045755
reply_no=undefined
name=<HTML hidden name>
memo=처리완료
cur_t=<HTML hidden cur_t 또는 현재 epoch 초>
check_6=<HTML에서 추출>
check_7=<HTML에서 추출>
check_8=<HTML에서 추출>
check_9=<HTML에서 추출>
check_10=<HTML에서 추출>
recommend=0
c_r_k_x_z=<HTML에서 추출>
t_vch2=
t_vch2_chk=
c_gall_id=thesingularity
c_gall_no=1045755
service_code=<HTML에서 추출>
g-recaptcha-response=
_GALLTYPE_=M
headTail=""
```

즉 고닉/로그인 테스트는
핵심 토큰 + `name` + `memo` 조합으로 보내고,
비회원 전용 필드(`password`, `code`, `gall_nick_name`, `use_gall_nick`)만 제외하는 쪽이 실성공 샘플과 맞다.

### 9.2 유동/비회원 테스트 예시

```txt
POST /board/forms/comment_submit

id=thesingularity
no=1045755
reply_no=undefined
name=ㅇㅇ
password=1234
code=<인증코드 또는 빈값>
memo=처리완료
cur_t=<HTML hidden cur_t 또는 현재 epoch 초>
check_6=<HTML에서 추출>
check_7=<HTML에서 추출>
check_8=<HTML에서 추출>
check_9=<HTML에서 추출>
check_10=<HTML에서 추출>
recommend=0
c_r_k_x_z=<HTML에서 추출>
t_vch2=
t_vch2_chk=
c_gall_id=thesingularity
c_gall_no=1045755
service_code=<HTML에서 추출>
g-recaptcha-response=
_GALLTYPE_=M
headTail=""
gall_nick_name=ㅇㅇ
use_gall_nick=Y 또는 N
```

즉 유동/비회원 테스트는
비회원 닉/비밀번호/인증코드 묶음이 따로 필요하다.

추가로 live 공식 스크립트를 확인해 보면:

1. `kcaptcha_init(no)`가 댓글 캡차 이미지를 `/kcaptcha/image_v3/...`로 준비한다.
2. 서버가 `false||captcha||v3`를 돌려주면 공식 페이지는 reCAPTCHA v3를 한 번 더 돌리고 재전송한다.

즉 유동/비회원 경로는 단순히 `code`만 넣는 것으로 끝나지 않을 수 있다.

### 9.3 실제 사용 예시

예를 들어 신문고 글 `1045755`에 운영자가 처리 완료 댓글을 남기고 싶다면:

```txt
memo=처리완료
reply_no=undefined
recommend=0
```

답글로 달고 싶으면:

```txt
memo=처리완료
reply_no=555001
recommend=0
```

---

## 10. 아직 추가 확인이 필요한 항목

이번 캡처로 “댓글 등록 엔드포인트” 자체는 확보됐지만, 아래는 한 번 더 검증하면 좋다.

1. 로그인 세션에서 `member_division`이 다른 예외값으로도 내려오는지 추가 샘플 확보
2. 유동/비회원 수동입력모드는 현재 레포에 구현 가능하지만, `false||captcha||v3` 같은 reCAPTCHA 추가 분기까지 같이 처리할지 정책 결정 필요
3. `등록+추천` 버튼이 `recommend=1`만 바꾸면 되는지
4. 답글 작성 시 `reply_no` 외 추가 필드가 더 필요한지
5. 성공/실패 응답 바디 패턴이 갤러리/시간대별로 바뀌는지
6. 매니저 계정 댓글과 비회원 댓글의 body 차이

---

## 11. 결론

결론은 간단하다.

- 댓글 작성 API는 **있다**
- 경로는 `POST /board/forms/comment_submit`
- 하지만 `고닉/로그인`과 `유동/비회원`은 바디를 분리해야 한다
- 실제 POST는 디시 글 페이지 문맥에서 보내는 쪽이 더 안전하다
- 현재 레포는 이 둘을 분리해서 보는 방향이 맞다
- 특히 유동 인증코드 처리는 여기서 억지로 섞지 말고 별도 구현으로 빼는 게 맞다

즉 신문고 처리 플로우는 이렇게 만들 수 있다.

1. 신고 댓글 읽기
2. 관리자 처리 로직 실행
3. 같은 신문고 글에 `처리완료` 댓글 등록
4. 댓글 재조회로 성공 확인
