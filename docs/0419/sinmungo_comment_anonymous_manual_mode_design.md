# 신문고 댓글 유동 수동입력모드 설계서

## 1. 목적

이 문서는 신문고 댓글 기능에 `유동/비회원 + 수동 인증코드 입력` 모드를 붙일 때,
지금 레포 구조에서 **어디를 어떻게 바꾸면 되는지**를 바로 작업 가능한 수준으로 정리한 설계서다.

쉽게 말하면 목표는 이거다.

1. 신문고 글 번호와 댓글 문구를 저장한다.
2. `유동/비회원 테스트`를 고른다.
3. 토글 ON을 누른다.
4. 확장프로그램이 실제 글 페이지에서 캡차 이미지를 준비한다.
5. popup에 이미지가 뜬다.
6. 사람이 코드를 보고 입력한다.
7. 확장프로그램이 같은 글 문맥에서 `comment_submit`을 보낸다.
8. 성공하면 댓글 번호를 기록하고 OFF로 끝낸다.

예시:

```txt
1045755 글에 "처리완료"를 유동으로 달고 싶다
-> 토글 ON
-> popup에 인증코드 이미지가 뜬다
-> 사람이 7KQ2를 입력한다
-> 확장프로그램이 code=7KQ2 포함해서 comment_submit 전송
-> 응답이 4502229 같은 숫자면 성공
```

---

## 2. 이번에 실제 코드와 대조해서 확인한 사실

### 2.1 현재 신문고 댓글 기능은 1회성 즉시 제출 구조다

현재 진입점은 아래 파일들이다.

- [popup/popup.html](../../popup/popup.html)
- [popup/popup.js](../../popup/popup.js)
- [background/background.js](../../background/background.js)
- [features/sinmungo-comment/scheduler.js](../../features/sinmungo-comment/scheduler.js)
- [features/sinmungo-comment/api.js](../../features/sinmungo-comment/api.js)

현재 구조를 아주 단순하게 쓰면 이렇다.

```txt
popup 토글 ON
-> background start
-> scheduler.start()
-> scheduler.run()
-> api.submitComment()
-> 바로 comment_submit
-> 성공/실패 저장
-> 자동 OFF
```

즉 지금 구조는 `준비 -> 사람 입력 대기 -> 제출` 3단계를 들고 있을 수 없고,
처음부터 끝까지 한 번에 끝내는 구조다.

### 2.2 현재 scheduler는 중간 대기 상태를 유지할 수 없다

[features/sinmungo-comment/scheduler.js](../../features/sinmungo-comment/scheduler.js)의 현재 상태는 아래 성격이다.

1. `PHASE`가 `IDLE / SUBMITTING / SUCCESS / ERROR` 네 개뿐이다.
2. `run()`은 끝나면 `finally`에서 항상 `isRunning=false`로 내려간다.
3. `saveState()`와 `getStatus()`에도 캡차 대기 상태나 준비된 challenge 정보가 없다.

즉 지금 코드에 `code 입력창만 추가`해서는 안 된다.
`WAITING_CODE` 같은 중간 상태를 scheduler가 직접 들고 있어야 한다.

### 2.3 현재 popup도 유동 수동입력 UI가 없다

[popup/popup.html](../../popup/popup.html)과 [popup/popup.js](../../popup/popup.js)를 보면 지금 신문고 탭에는 아래만 있다.

1. 게시물 번호
2. 테스트 모드 선택
3. 댓글 문구
4. 유동 비밀번호
5. 저장 버튼
6. 토글

없는 것:

1. 캡차 이미지
2. 코드 입력칸
3. 새 코드 받기 버튼
4. 수동 제출 버튼
5. `지금은 코드 입력 대기 중` 같은 상태 문구

즉 popup도 구조 추가가 필요하다.

### 2.4 현재 background에는 신문고 전용 수동입력 action이 없다

[background/background.js](../../background/background.js)는 지금 신문고에 대해 사실상 아래 공용 action만 처리한다.

1. `start`
2. `stop`
3. `updateConfig`
4. `resetStats`

`prepareManualChallenge`, `refreshManualChallenge`, `submitManualChallenge` 같은 전용 action은 아직 없다.

즉 popup에서 버튼을 눌러도 지금 구조로는 사람이 입력한 코드를 재개 제출할 통로가 없다.

### 2.5 현재 API는 captcha가 필요하면 "지원 안 함"으로 끝난다

[features/sinmungo-comment/api.js](../../features/sinmungo-comment/api.js)의 현재 `submitComment()`는:

1. HTML에서 토큰을 읽고
2. body를 만들고
3. 디시 글 탭 메인 문맥에서 `comment_submit`을 보내며
4. 응답이 숫자면 성공으로 본다

여기까지는 맞다.

하지만 `submitMode=anonymous`이고 `comment_code=Y`인데 `code`가 비어 있으면
지금은 `challenge_required` 실패로 끝난다.

즉 현재 API는 "유동 + 캡차 필요" 상황을 **지원 안 함으로 종료**하는 상태다.

---

## 3. 저장된 실제 HTML 기준으로 확인한 유동 폼 구조

[docs/raw2.md](../raw2.md)에는 유동 댓글 폼의 핵심 단서가 이미 있다.

### 3.1 실제로 kcaptcha 스크립트가 로드된다

`docs/raw2.md`에는 아래 스크립트가 있다.

```html
<script src="/_js/kcaptcha.js?v=260112" ...></script>
```

즉 캡차 이미지는 단순 고정 파일이 아니라, 페이지 스크립트가 관여하는 구조다.

추가로 live 스크립트를 확인해 보니:

- `https://gall.dcinside.com/_js/kcaptcha.js?v=260112`
- `https://gall.dcinside.com/_js/comment.js?v=260211`

에서 실제 댓글 캡차 초기화가 다음처럼 동작한다.

1. `comment.js`가 댓글/답글 폼 생성 직후 `kcaptcha_init(no)`를 호출
2. `kcaptcha.js`가 `setTimeout(..., 100)` 뒤 `.kcaptcha[data-type="comment"]`를 자동 클릭
3. 그 클릭 핸들러가 이미지 `src`를 아래 경로로 바꿈

```txt
/kcaptcha/image_v3/?gall_id=<갤ID>&kcaptcha_type=comment&time=<timestamp>&_GALLTYPE_=<타입>
```

즉 준비 단계는 그냥 `img.src`를 읽는 것만으로 끝내면 안 되고,
필요하면 `kcaptcha_init(postNo)` 또는 `img.kcaptcha.click()`까지 다시 호출할 수 있어야 안전하다.

### 3.2 유동 댓글 폼에는 실제 코드 입력칸과 comment_code가 있다

저장 HTML에 아래 요소가 확인된다.

```html
<input type="text" id="code_1037424" placeholder="코드 입력">
<img src="https://nstatic.dcinside.com/dc/w/images/kcap_none.png" id="kcaptcha_1037424" class="kcaptcha" data-type="comment">
<input type="hidden" name="comment_code" id="comment_code_1037424" value="Y">
```

이건 의미가 명확하다.

1. 이 글은 댓글 인증코드가 필요한 상태다.
2. 비회원 댓글 폼에는 별도 코드 입력칸이 있다.
3. popup에 보여줄 대상은 결국 `img.kcaptcha`다.

### 3.3 `use_gall_nick`, `gall_nick_name`, `name`, `password`도 같이 내려온다

저장 HTML에는 아래 구조도 있다.

```html
<input id="gall_nick_name_1037424" type="text" name="gall_nick_name" value="ㅇㅇ" readonly>
<input type="text" id="name_1037424" name="name" ... style="display:none">
<input type="password" id="password_1037424" name="password" ...>
<input type="hidden" name="use_gall_nick" id="use_gall_nick" value="Y">
```

즉 유동 모드 body는 그냥 고정값으로 보내면 안 되고,
**그 순간 페이지가 어떤 비회원 폼 상태로 내려왔는지**를 그대로 따라가야 한다.

예시:

```txt
use_gall_nick=Y
-> 공식 스크립트는 name 필드도 같이 실어 보내지만, 실질 표시값은 gall_nick_name 쪽을 따른다

use_gall_nick=N
-> gall_nick_name 대신 사람이 입력한 name 쪽을 보낸다
```

그리고 live `comment.js` 기준으로 비회원 폼은 아래 규칙도 갖고 있다.

1. `password_<postNo>` input이 존재하면 비밀번호를 비워서 보낼 수 없다.
2. 비밀번호 길이도 최소 2자 이상이어야 한다.
3. 즉 유동 모드에서 비밀번호는 사실상 필수 입력이다.

### 3.4 중요한 포인트: 저장 HTML의 캡차 이미지는 placeholder다

저장된 HTML을 보면 `img.kcaptcha`의 `src`는 실제 코드 이미지가 아니라:

```txt
https://nstatic.dcinside.com/dc/w/images/kcap_none.png
```

이다.

이 말은 아주 중요하다.

정적 HTML만 fetch해서는 사람이 읽을 실제 인증코드 이미지를 얻을 수 없다.
즉 수동입력모드는 **반드시 실제 글 탭을 열고, 페이지 JS가 돈 뒤의 live DOM**을 봐야 한다.

하지만 live 스크립트를 확인한 결과, 실제 최종 캡차 이미지는 `nstatic`이 아니라
같은 사이트 경로인 `/kcaptcha/image_v3/...`로 다시 바뀐다.

쉽게 말하면:

```txt
정적 저장 HTML
-> kcap_none.png

실제 live page
-> /kcaptcha/image_v3/?gall_id=...&_GALLTYPE_=...
```

즉 "placeholder 때문에 live DOM을 봐야 한다"는 결론은 그대로 맞고,
추가로 "실제 이미지 host는 gall.dcinside.com same-origin 쪽"이라는 점까지 확인됐다.

### 3.5 kcaptcha만이 아니라 reCAPTCHA 추가 분기도 있다

live `comment.js`를 보면 공식 스크립트는 댓글 등록 실패 응답이 아래처럼 오면:

```txt
false||captcha||v3
```

바로 실패 종료하지 않고:

1. `grecaptcha` 스크립트를 로드하고
2. `grecaptcha.execute(..., { action: 'comment_submit' })`
3. `g-recaptcha-token`을 붙여 재전송

하는 분기를 탄다.

이건 설계에서 아주 중요하다.

즉 유동 수동입력모드는 `code=<사람이 읽은 kcaptcha>`만 처리하면 끝이 아닐 수 있다.
서버가 추가 reCAPTCHA를 요구하면 공식 페이지는 한 번 더 보강 제출을 시도한다.

그래서 구현 전 기준으로는 아래 둘 중 하나를 분명히 정해야 한다.

1. 1차 구현에서는 `false||captcha||v3`를 만나면 "추가 reCAPTCHA가 필요한 글"로 명확히 실패 처리
2. 또는 공식 스크립트처럼 reCAPTCHA 토큰 취득 후 재전송까지 구현

현재 레포에는 이 2차 분기가 아직 없다.

---

## 4. 결론: 유동 수동입력모드는 "실제 글 탭 기반 2단계"로 가야 한다

가장 안전한 구현은 아래다.

### 4.1 준비 단계

1. 비활성 글 탭을 연다.
2. 페이지 로딩 완료를 기다린다.
3. 메인 문맥에서 비회원 댓글 폼 상태를 읽는다.
4. `img.kcaptcha`가 placeholder가 아닌 실제 이미지로 바뀔 때까지 잠깐 기다린다.
5. 필요하면 `kcaptcha_init(postNo)` 또는 `.kcaptcha[data-type="comment"]` click을 다시 호출한다.
6. popup에 보여줄 challenge 정보를 만든다.

### 4.2 제출 단계

1. 사람이 popup에서 코드를 입력한다.
2. background가 아까 준비한 같은 글 탭에서 다시 메인 문맥 스크립트를 실행한다.
3. 그 시점 DOM 기준 토큰과 폼 상태를 다시 읽거나, 준비 당시 값을 재검증한다.
4. `POST /board/forms/comment_submit`를 보낸다.
5. 응답 숫자 또는 댓글 재조회로 성공을 판정한다.
6. 끝나면 탭을 닫고 상태를 정리한다.

이 방식이 좋은 이유는 단순하다.

1. 캡차 endpoint를 역으로 추측할 필요가 없다.
2. `kcaptcha.js`가 만든 실제 DOM 상태를 그대로 쓸 수 있다.
3. `service_code`, `c_r_k_x_z`, `use_gall_nick`, `comment_code`를 같은 문맥에서 맞출 수 있다.
4. 지금 이미 있는 `chrome.tabs + chrome.scripting.executeScript + MAIN world` 패턴을 재사용할 수 있다.

---

## 5. 권장 상태 머신

현재 `IDLE / SUBMITTING / SUCCESS / ERROR`만으로는 부족하다.
유동 수동입력모드에서는 아래 상태가 필요하다.

```txt
IDLE
PREPARING_CHALLENGE
WAITING_CODE
SUBMITTING
SUCCESS
ERROR
```

의미는 이렇게 잡으면 된다.

1. `IDLE`
   - 아무 작업 없음
2. `PREPARING_CHALLENGE`
   - 비활성 글 탭 열고 유동 폼과 캡차 준비 중
3. `WAITING_CODE`
   - popup에 이미지가 떠 있고, 사람 입력 대기 중
4. `SUBMITTING`
   - code를 받아 실제 submit 전송 중
5. `SUCCESS`
   - 성공
6. `ERROR`
   - 실패

### 토글 동작도 이 상태에 맞춰 바꿔야 한다

지금은 ON하면 바로 달고 OFF로 끝난다.
수동모드에서는 이게 아니라:

```txt
ON
-> PREPARING_CHALLENGE
-> WAITING_CODE 상태로 유지
-> 사람이 코드 제출
-> 성공/실패 후 OFF
```

가 맞다.

즉 `WAITING_CODE` 동안 토글은 ON으로 유지되어야 한다.
그래야 설정값도 잠그고, 사용자가 "아 지금 코드 입력만 하면 되는 상태구나"를 이해할 수 있다.

---

## 6. 파일별 구현 포인트

## 6.1 `features/sinmungo-comment/api.js`

여기가 가장 중요하다.

현재 `submitComment()`는 "즉시 제출"만 한다.
수동모드용으로 아래 helper를 분리하는 게 가장 깔끔하다.

### 추가 권장 함수

1. `prepareAnonymousManualChallenge(config, options)`
2. `submitAnonymousManualChallenge(config, challenge, options)`
3. `cancelAnonymousManualChallenge(challenge)`
4. `readAnonymousCommentFormFromPage(tabId, postNo)`
5. `waitForLiveCaptchaImage(tabId, postNo)`

### `prepareAnonymousManualChallenge()`가 해야 할 일

1. 대상 글 비활성 탭 생성
2. 로딩 완료 대기
3. 메인 문맥에서 아래 확인
   - `member_division === 'N'`
   - `comment_code === 'Y'`
   - `use_gall_nick`
   - `gall_nick_name_<postNo>`
   - `name_<postNo>` 표시 상태
   - `password_<postNo>`
   - `img#kcaptcha_<postNo>`
4. 캡차 이미지가 placeholder가 아니게 될 때까지 짧게 polling
5. 아래 challenge payload 반환

예시 구조:

```js
{
  challengeId: "smc-1712345678901-abcd",
  tabId: 123,
  postNo: "1045755",
  preparedAt: "2026-04-19T21:00:00.000Z",
  captchaImageUrl: "https://gall.dcinside.com/kcaptcha/image_v3/?gall_id=thesingularity&kcaptcha_type=comment&time=1712345678901&_GALLTYPE_=M",
  useGallNick: "Y",
  gallNickName: "ㅇㅇ",
  anonymousNameVisible: false,
  requiresCode: true
}
```

### `submitAnonymousManualChallenge()`가 해야 할 일

1. challenge의 `tabId`가 아직 살아 있는지 확인
2. 같은 탭 메인 문맥에서 다시 폼 상태를 읽음
3. 사람이 입력한 `code`를 body에 넣음
4. `POST /board/forms/comment_submit`
5. 응답 숫자면 1차 성공
6. 필요하면 댓글 목록 재조회

중요:

- `service_code`, `check_6~10`, `c_r_k_x_z`, `cur_t`는 submit 직전에 다시 읽는 쪽이 더 안전하다.
- 즉 prepare 단계에서 "이미지/폼 종류"만 준비하고, submit 단계에서 보호 토큰은 재확인하는 식이 가장 덜 깨진다.

## 6.2 `features/sinmungo-comment/scheduler.js`

현재 scheduler는 1회성 run-only 구조라서 아래 필드가 추가돼야 한다.

### 추가 상태 필드

1. `pendingChallengeId`
2. `pendingChallengePreparedAt`
3. `pendingChallengeImageUrl`
4. `pendingChallengePostNo`
5. `pendingChallengeUseGallNick`
6. `pendingChallengeDisplayName`
7. `pendingChallengeTabAlive`

### 런타임 전용 필드

storage에 다 넣을 필요는 없고, 메모리 전용으로 아래 정도를 둔다.

1. `pendingChallengeTabId`
2. `pendingChallengeRuntimeKey`

### scheduler 메서드도 분리해야 한다

1. `start()`
   - member 모드면 기존처럼 즉시 run
   - anonymous 모드면 먼저 prepare branch 진입
2. `prepareAnonymousChallenge()`
3. `submitPreparedAnonymousCode(code)`
4. `refreshPreparedAnonymousChallenge()`
5. `clearPreparedChallenge()`

핵심은 이거다.

현재 `run()`의 `finally`에서 무조건 `isRunning=false`로 내리는 로직을 그대로 두면,
`WAITING_CODE` 상태를 유지할 수 없다.

즉 유동 수동입력모드는 scheduler를 "즉시 완료 함수"가 아니라
"잠깐 멈춰 서 있을 수 있는 상태 머신"으로 바꾸는 작업이 필요하다.

추가로 현재 실제 코드 기준으로는 아래도 꼭 바뀌어야 한다.

1. `loadState()`가 `isRunning=true` 상태를 읽으면 무조건 `isRunning=false`로 강제 종료한다.
2. `resumeStandaloneScheduler()`는 `isRunning=true`면 `ensureRunLoop()`를 다시 건다.

즉 지금 상태 그대로는 service worker가 재시작되거나 상태를 다시 읽는 순간
`WAITING_CODE`를 유지할 수 없다.

예시:

```txt
유동 수동입력 준비 완료
-> phase=WAITING_CODE, isRunning=true
-> service worker 재시작
-> loadState()가 "1회성 작업"으로 보고 강제 해제
-> 사람이 코드 입력하려고 돌아왔는데 상태가 풀려 있음
```

따라서 manual mode를 넣을 때는 최소한 아래 중 하나가 필요하다.

1. `WAITING_CODE`는 자동 해제 예외로 남긴다
2. 또는 재시작 시 항상 challenge를 만료시키고 사용자에게 다시 준비시키는 정책을 문서/로그/UI에 명확히 남긴다

## 6.3 `background/background.js`

현재 공용 action만 있으므로 아래 action을 추가하는 게 맞다.

1. `prepareManualChallenge`
2. `refreshManualChallenge`
3. `submitManualChallenge`
4. `cancelManualChallenge`

popup에서 예상 흐름은 이렇게 된다.

```txt
toggle ON
-> action=start
-> anonymous + comment_code=Y 이면 WAITING_CODE 로 전환

새 코드 받기
-> action=refreshManualChallenge

코드 제출
-> action=submitManualChallenge { code }

취소
-> action=cancelManualChallenge
```

추가로 현재 `chrome.tabs.onRemoved`는 broker/uid 경고만 처리하고 있어서,
manual challenge용 hidden 탭이 사용 중 닫혀도 신문고 상태가 자동 정리되지 않는다.

즉 아래 정리도 필요하다.

1. pending challenge tab id를 추적
2. 사용자가 탭을 직접 닫으면 `WAITING_CODE`를 깨고 오류 로그 남김
3. submit 직전 `chrome.tabs.get(tabId)`로 살아 있는지 재확인

## 6.4 `popup/popup.html`

현재 신문고 탭에는 수동입력 영역이 없다.
아래 영역을 새로 추가하면 된다.

### 추가 권장 DOM

1. `sinmungoCommentChallengeSection`
2. `sinmungoCommentCaptchaImage`
3. `sinmungoCommentCaptchaPreparedAt`
4. `sinmungoCommentCodeInput`
5. `sinmungoCommentRefreshCaptchaBtn`
6. `sinmungoCommentSubmitCaptchaBtn`
7. `sinmungoCommentCancelCaptchaBtn`
8. `sinmungoCommentAnonymousName`

UI 예시는 이렇게 잡으면 된다.

```txt
[유동 수동입력 준비됨]
인증코드 이미지: [  이미지  ]
닉네임(필요 시): [      ]
코드 입력: [      ]
[새 코드 받기] [댓글 등록] [취소]
```

여기서 `닉네임(필요 시)`가 필요한 이유는 실제 공식 스크립트가
`use_gall_nick=Y`면 `gall_nick_name`을 쓰고,
`use_gall_nick!=Y`면 `name_<postNo>` 입력값을 요구하기 때문이다.

현재 popup에는 유동 비밀번호는 있어도 비회원 닉네임 입력칸이 없다.
즉 robust 구현을 하려면 아래 둘 중 하나를 골라야 한다.

1. 비회원 닉네임 입력칸을 추가한다
2. 1차 구현은 `use_gall_nick=Y`인 경우만 허용하고, `N`이면 명확히 중단한다

## 6.5 `popup/popup.js`

아래 작업이 필요하다.

1. `FEATURE_DOM.sinmungoComment`에 challenge DOM 추가
2. `buildDefaultSinmungoCommentStatus()`에 challenge 상태 추가
3. `updateSinmungoCommentUI()`가 `WAITING_CODE`를 그릴 수 있게 수정
4. `bindSinmungoCommentEvents()`에
   - 새 코드 받기 버튼
   - 제출 버튼
   - 취소 버튼
   이벤트 추가
5. `buildSinmungoCommentMetaText()`가 상태별로 설명을 다르게 출력

예시:

```txt
PREPARING_CHALLENGE
-> "유동 댓글 인증코드를 준비하는 중입니다."

WAITING_CODE
-> "인증코드 이미지를 확인한 뒤 코드를 입력하고 댓글 등록을 누르세요."
```

그리고 실제 현재 코드 기준으로는 아래 함정도 피해야 한다.

1. `getFeatureConfigInputs('sinmungoComment')`는 지금 `postNo/submitMode/memo/password`만 config input으로 취급한다.
2. `background.js`도 `code`를 일반 설정값처럼 trackedConfigKey로 보고 있다.

즉 수동입력용 code를 기존 `config.code`에 얹어버리면:

1. 예전 captcha code가 storage에 남을 수 있고
2. dirty tracking에 엮여 start/save 동작이 꼬이고
3. 실행 중 설정 변경 차단 로직에도 걸릴 수 있다

그래서 manual mode의 `captcha code`는 **설정값이 아니라 일회성 제출값**으로 분리해야 한다.
즉 popup 입력칸은 있어도 `saveConfig` 대상에는 넣지 않는 게 맞다.

---

## 7. 팝업에 캡차 이미지를 어떻게 보여줄지

이 부분은 구현 전에 논리 정리가 꼭 필요하다.

### 가장 단순한 1차안

prepare 단계에서 live DOM의 `img.kcaptcha.src`를 읽고,
popup의 `<img>`에 그대로 넣는다.

장점:

1. 구현이 가장 단순하다.
2. 정확한 캡차 endpoint를 몰라도 된다.
3. `kcaptcha.js`가 최종적으로 넣은 실제 URL만 받으면 된다.

주의:

1. popup이 원격 이미지를 직접 못 띄우는 환경이면 실패할 수 있다.
2. 다만 live `kcaptcha.js` 기준 실제 이미지는 `https://gall.dcinside.com/kcaptcha/image_v3/...`라서 현재 `manifest.json` host permission 범위 안에 있다.
3. 그래도 popup 직결 표시가 막히면 page-context/background에서 data URL로 넘기는 fallback을 두는 게 안전하다.

### 더 안전한 2차안

background 또는 page context에서 이미지를 fetch해서 `data:` URL로 바꾼 뒤 popup에 준다.

장점:

1. popup 표시가 더 안정적이다.
2. 나중에 수동 OCR 테스트를 붙일 때도 재사용 가능하다.

단점:

1. 구현이 조금 더 길다.
2. 이미지 직렬화와 수명 관리가 더 필요하다.

### 권장 결론

첫 구현은 `img.src 직결`로 가고,
popup 표시가 막히면 그때 `data:` URL 변환으로 올리는 게 현실적이다.

---

## 8. 실제 제출 플로우 예시

## 8.1 유동 + 캡차 필요한 글

예시 글 번호: `1045755`

```txt
1. 설정 저장
   - postNo=1045755
   - submitMode=anonymous
   - memo=처리완료
   - password=0989

2. 토글 ON
   - scheduler.phase=PREPARING_CHALLENGE

3. hidden 탭에서 글 열기
   - member_division=N 확인
   - comment_code=Y 확인
   - kcaptcha_use=Y 확인
   - use_gall_nick 확인
   - kcaptcha 이미지 준비

4. popup에 이미지 표시
   - scheduler.phase=WAITING_CODE

5. 사람이 code 입력
   - 예: 7KQ2

6. 같은 hidden 탭에서 submit
   - id=thesingularity
   - no=1045755
   - reply_no=undefined
   - memo=처리완료
   - password=0989
   - code=7KQ2
   - use_gall_nick=Y 또는 N
   - service_code, c_r_k_x_z 등은 submit 직전에 다시 읽음

7. 응답 확인
   - 4502229 같은 숫자면 성공
   - `false||captcha||v3`면 reCAPTCHA 추가 분기 여부 판단
   - 필요시 댓글 목록 재조회

8. 성공 후 정리
   - hidden 탭 닫기
   - scheduler.phase=SUCCESS
   - toggle OFF
```

## 8.2 유동 + 캡차 필요 없는 글

이 경우는 더 간단하다.

```txt
submitMode=anonymous
comment_code=N
-> 수동입력 UI로 갈 필요 없음
-> 지금 있는 submitComment() 직접 호출
```

즉 "유동 모드 전체를 전부 수동입력으로 강제"할 필요는 없다.
`comment_code=Y`일 때만 수동입력 브랜치로 보내면 된다.

---

## 9. 왜 이 설계가 현재 코드와 가장 잘 맞는가

## 9.1 지금 이미 live tab + MAIN world submit 패턴이 있다

[features/sinmungo-comment/api.js](../../features/sinmungo-comment/api.js)는 이미:

1. 디시 글 탭 생성
2. `chrome.scripting.executeScript`
3. `world: 'MAIN'`
4. 같은 문맥에서 `comment_submit`

패턴을 쓰고 있다.

즉 manual mode는 새 엔진을 따로 만드는 게 아니라
**기존 same-origin page-context 패턴을 2단계로 쪼개는 작업**에 가깝다.

## 9.2 정적 HTML만 믿는 방식보다 훨씬 덜 깨진다

저장 HTML의 `img.kcaptcha.src`는 placeholder다.
즉 "HTML fetch + regex"만으로는 캡차 이미지를 못 얻는다.

그래서 live DOM 기준 설계가 맞다.

## 9.3 `use_gall_nick`와 이름 처리도 live DOM 기준이 더 안전하다

현재 `submitComment()`도 `use_gall_nick` hidden 값을 읽는 쪽으로 이미 보강돼 있다.
manual mode에서도 그 철학을 그대로 가져가야 한다.

즉:

1. 사람이 `ㅇㅇ`라고 생각해도 페이지가 `use_gall_nick=Y`면 그 규칙을 따라야 한다.
2. 고정 fallback name을 억지로 넣지 말고, 현재 폼 상태를 우선해야 한다.

---

## 10. 구현 전에 꼭 알고 가야 할 제약

1. 유동 수동입력모드는 "토글 ON 후 바로 끝"이 아니라 "준비 후 사람 입력 대기"가 들어간다.
2. 그래서 현재 scheduler 구조를 조금은 바꿔야 한다.
3. 현재 `loadState()`는 실행 중 상태를 자동 해제하므로, service worker 재시작 정책을 따로 정해야 한다.
4. 이 경우 popup에는 "challenge가 만료됐으니 새로 준비하세요" 또는 "기존 tab 재연결 시도" 중 하나를 분명히 안내해야 한다.
5. 캡차 이미지는 정적 HTML이 아니라 live DOM에서 확보해야 한다.
6. 실제 live 이미지 경로는 `/kcaptcha/image_v3/...` 이다.
7. `service_code`, `c_r_k_x_z`, `check_*`는 오래 캐시하면 안 된다.
8. 따라서 submit 직전 재확인이 안전하다.
9. `withDcRequestLease`는 댓글 요청 직전/직후 짧게만 잡아야 한다. 준비 후 사람 입력을 기다리는 전체 시간 동안 lease를 잡아두면 다른 디시 요청도 불필요하게 막힌다.
10. 공식 스크립트는 필요 시 reCAPTCHA v3/v2 재전송 분기를 탄다. 즉 kcaptcha만으로 100% 끝난다고 보면 안 된다.
11. hidden 탭을 기다리는 동안 사용자가 그 탭을 닫거나 다른 URL로 이동시킬 수 있다. submit 전에 탭 상태를 꼭 다시 확인해야 한다.
12. 현재 reset 동작은 `postNo`, `submitMode`, `memo`, `password`까지 초기화한다. manual mode를 넣으면 reset이 "통계만 초기화"인지 "대기 challenge까지 모두 폐기"인지 의미를 다시 정해야 한다.

---

## 11. 정적 검증 체크리스트

아래 항목이 전부 맞아야 "구조상 큰 구멍 없이 구현됐다"고 볼 수 있다.

1. `postNo`가 비어 있으면 시작 전 차단되는가
2. `memo`가 비어 있으면 시작 전 차단되는가
3. `submitMode=member` 기존 경로가 깨지지 않는가
4. `submitMode=anonymous`에서 `member_division !== N`이면 즉시 중단하는가
5. `submitMode=member`인데 `member_division=N`이면 mode mismatch로 중단하는가
6. `comment_code=N`이면 수동입력 UI 없이 바로 submit 하는가
7. `comment_code=Y`이면 `WAITING_CODE`로 들어가는가
8. hidden 탭 생성 실패 시 명확한 오류를 남기는가
9. hidden 탭 로딩 timeout 시 정리되는가
10. `img.kcaptcha.src`가 계속 `kcap_none.png`면 새로 준비하라고 안내하는가
11. `use_gall_nick=Y`일 때 `name` field 정책을 official payload와 같은 방식으로 정했는가
12. `use_gall_nick=N`이면 비회원 닉 입력값을 보내는가
13. 유동 비밀번호가 비어 있으면 시작 전에 막는가
14. code 입력 없이 제출 버튼을 누르면 막는가
15. `use_gall_nick=N`일 때 닉네임 입력 source가 있는가
16. 닉네임 입력 source가 없으면 명확한 오류로 중단하는가
17. 최상위 댓글일 때 `reply_no=undefined`를 유지하는가
18. 답글 모드면 숫자 `reply_no`를 유지하는가
19. submit 직전에 `service_code`, `c_r_k_x_z`, `check_*`, `cur_t`를 다시 읽는가
20. 응답이 숫자면 즉시 성공으로 기록하는가
21. 숫자 응답 후 댓글 재조회가 실패해도 1차 성공 기록을 보존할지 정책이 정리돼 있는가
22. 응답이 `false||captcha||v3`일 때 reCAPTCHA 추가 처리 또는 명확한 실패 안내가 있는가
23. 응답에 `captcha` 문구가 오면 code 오류와 reCAPTCHA 오류를 구분하는가
24. 응답에 `올바른 방법으로 이용해 주세요`가 오면 guard 오류로 분류하는가
25. 응답에 로그인/권한 문구가 오면 auth 오류로 분류하는가
26. `WAITING_CODE` 중 popup을 닫았다 다시 열어도 상태가 보이는가
27. `WAITING_CODE` 중 토글 OFF를 누르면 hidden 탭이 정리되는가
28. `WAITING_CODE` 중 설정 저장을 막는가
29. 제출 버튼 연타 시 중복 submit을 막는가
30. 새 코드 받기 버튼이 이전 challenge를 무효화하는가
31. service worker 재시작 뒤 옛 challenge 제출 시 "다시 준비"로 유도하는가
32. hidden 탭이 수동으로 닫히거나 다른 URL로 이동되면 상태가 깨끗하게 ERROR/IDLE로 정리되는가
33. popup에서 캡차 이미지 직결 표시가 막히면 data URL fallback이 있는가
34. manual waiting 동안 `withDcRequestLease`가 계속 점유되지 않는가
35. 성공 후 `lastCommentNo`, `lastSubmittedAt`, `lastVerifiedAt`, `totalSubmittedCount`가 정상 갱신되는가

---

## 14. 이번 교차검증으로 추가 확인된 실제 이슈

아래는 문서 초안 이후, 실제 코드와 live DC 스크립트를 다시 대조하면서 새로 확정한 이슈다.

### 14.1 현재 구조 그대로면 manual waiting 상태는 저장/복원되지 않는다

- [features/sinmungo-comment/scheduler.js](../../features/sinmungo-comment/scheduler.js)
  - `loadState()`는 `isRunning=true`를 읽으면 자동으로 해제한다.
  - 지금은 "1회성 작업" 가정이 강하게 박혀 있다.

결론:

- manual mode를 넣을 때 가장 먼저 부딪히는 구조 문제다.

### 14.2 현재 status 문구는 `WAITING_CODE`를 전혀 표현하지 못한다

- [popup/popup.js](../../popup/popup.js)
  - `getSinmungoCommentStatusLabel()`
  - `buildSinmungoCommentMetaText()`
  - `updateSinmungoCommentUI()`

현재는 `isRunning=true`면 무조건:

```txt
🟡 댓글 등록 중
댓글 1개를 등록하고, 목록 재조회로 실제 생성 여부를 확인하는 중
```

으로 보인다.

결론:

- `WAITING_CODE`에서는 완전히 다른 문구가 필요하다.

### 14.3 `config.code`를 그대로 쓰면 stale captcha 재사용 문제가 생긴다

- [features/sinmungo-comment/api.js](../../features/sinmungo-comment/api.js)
- [background/background.js](../../background/background.js)

현재 구조상 `code`는 일반 config field처럼 취급된다.

결론:

- manual mode의 code는 절대 장기 저장 설정값으로 두면 안 된다.
- 1회 제출용 transient input으로 분리해야 한다.

### 14.4 현재 anonymous 기본 검증은 공식 폼 검증보다 느슨하다

- [features/sinmungo-comment/scheduler.js](../../features/sinmungo-comment/scheduler.js)
- [popup/popup.js](../../popup/popup.js)
- live `comment.js`

현재 실제 코드 기준:

1. 시작 전 검증은 `postNo`, `memo`만 본다.
2. popup 저장도 유동 비밀번호를 필수로 검사하지 않는다.
3. API도 비밀번호가 비어 있으면 그냥 `password` field를 빼고 보낸다.

하지만 공식 스크립트는 비회원 폼에서:

1. 비밀번호가 비어 있으면 중단
2. 2자 미만이어도 중단

을 한다.

결론:

- manual mode를 넣기 전에 anonymous 시작 검증에 비밀번호 필수/최소 길이 규칙을 먼저 맞추는 게 안전하다.

### 14.5 유동 닉네임 입력 source가 현재 UI에 없다

- [popup/popup.html](../../popup/popup.html)
- [popup/popup.js](../../popup/popup.js)

현재 유동 모드 설정은 비밀번호만 있고 닉네임 입력칸이 없다.

결론:

- `use_gall_nick=Y`만 허용할지
- 아니면 닉네임 입력칸을 새로 추가할지

이걸 구현 전에 정해야 한다.

### 14.6 anonymous `name` field 처리도 공식 스크립트와 완전히 같지는 않다

- [features/sinmungo-comment/api.js](../../features/sinmungo-comment/api.js)
- live `comment.js`

현재 확장 구현은:

1. `use_gall_nick=Y`면 `name` field를 아예 생략
2. `gall_nick_name`, `use_gall_nick`만 보냄

공식 스크립트는:

1. `use_gall_nick=Y`여도 `name=<name input value>`를 같이 붙인다
2. 추가로 `gall_nick_name`, `use_gall_nick`를 붙인다

결론:

- 서버가 `name=` 빈값과 `name` field 생략을 다르게 볼 가능성을 완전히 배제할 수 없다.
- manual mode 구현 시에는 official payload와 동일하게 `name` key를 항상 넣을지 다시 결정해야 한다.

### 14.7 공식 스크립트는 reCAPTCHA 분기가 있다

- live `comment.js`

현재 확장 구현은:

```txt
false||captcha||v3
-> 실패
```

인데 공식 페이지는:

```txt
false||captcha||v3
-> grecaptcha.execute(...)
-> 재전송
```

을 한다.

결론:

- 이 분기를 빼고 구현하면 "왜 브라우저 수동 댓글은 되는데 확장은 안 되지?" 상황이 다시 날 수 있다.

### 14.8 manual challenge tab 생명주기 관리가 필요하다

현재는 신문고 기능 쪽에서:

- 탭 수동 종료
- 탭 URL 변경
- 탭 discard/reload

를 감시하는 훅이 없다.

결론:

- pending challenge tab이 깨졌을 때의 정리 로직이 반드시 필요하다.

---

## 12. 최종 권장 구현 순서

1. `api.js`에 manual challenge prepare / submit helper 추가
2. `scheduler.js`를 `WAITING_CODE` 상태를 들 수 있게 확장
3. `background.js`에 수동입력 action 추가
4. `popup.html / popup.js`에 캡차 이미지와 입력 UI 추가
5. 숫자 응답 성공 + verify + 실패 분기까지 다시 점검

이 순서가 좋은 이유는 간단하다.

`popup부터 먼저 만들면` 실제로 준비/제출할 백엔드 흐름이 없어서 다시 뜯어야 하고,
`api/scheduler부터 먼저 만들면` UI는 그 상태를 그냥 그리기만 하면 되기 때문이다.

---

## 13. 이번 문서 기준 결론

지금 레포 상태에서 유동 수동입력모드는 **구현 가능하다.**
다만 "댓글 body에 code만 하나 더 붙이면 끝" 수준은 아니고,
반드시 아래 3개가 같이 들어가야 한다.

1. live 글 탭 기반 challenge 준비
2. scheduler의 `WAITING_CODE` 상태 추가
3. popup의 캡차 표시 + 수동 제출 UI

반대로 말하면,
정확한 캡차 endpoint를 몰라도 되고,
OCR이나 Tesseract를 붙이지 않아도 되고,
지금 이미 있는 `디시 글 탭 메인 문맥 submit` 패턴을 확장하면 충분하다.

즉 이번 작업의 핵심은 "역공학"이 아니라,
**현재 코드 구조를 1회성 즉시 제출에서 2단계 수동 제출로 바꾸는 설계 정리**다.
