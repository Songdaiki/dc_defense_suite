# 신문고 유동 수동입력모드 교차검증

## 1. 목적

이 문서는 `sinmungo_comment_anonymous_manual_mode_design.md`에 적힌 설계가
현재 실제 코드와 어디까지 맞고, 어디서부터 구조 변경이 필요한지
`popup -> background -> scheduler -> api -> live page script` 순서로 대조한 기록이다.

쉽게 말하면:

- 이미 재사용 가능한 부분
- 그대로 쓰면 깨지는 부분
- 패치 전에 정책 결정을 먼저 해야 하는 부분

을 구분해 두는 문서다.

---

## 2. 실제 호출 체인 검증

## 2.1 popup 시작/정지 이벤트

확인 파일:

- [popup/popup.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1078)

현재 실제 흐름:

1. 토글 ON/OFF는 `bindSinmungoCommentEvents()`에서 처리
2. ON이면 `start`, OFF면 `stop`
3. start 전 popup 쪽 선검증은
   - 게시물 번호 존재
   - 게시물 번호 숫자 여부
   - 댓글 문구 존재
   만 본다
4. 이후 `sendFeatureMessage('sinmungoComment', { action })`

판정:

- 문서의 “토글 ON이 시작점” 설명은 맞다.
- 하지만 유동 수동입력모드에 필요한
  - 비밀번호 필수 검사
  - code 입력 대기 UI
  - refresh/submit/cancel action
  은 아직 없다.

즉 결론:

- popup 시작점은 재사용 가능
- 유동 수동입력 대기용 이벤트는 새로 추가 필요

## 2.2 popup 상태 렌더링

확인 파일:

- [popup/popup.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:3083)
- [popup/popup.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:5049)
- [popup/popup.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:5688)

현재 실제 흐름:

1. `updateSinmungoCommentUI()`는
   - `statusText`
   - `phaseText`
   - 대상 게시물
   - 최근 등록/검증/댓글 번호
   - 성공/실패 카운트
   - 로그
   만 그린다
2. `getSinmungoCommentStatusLabel()`은
   - `isRunning=true`면 무조건 `🟡 댓글 등록 중`
   - `phase=SUCCESS`면 성공
   - `phase=ERROR`면 실패
3. `buildSinmungoCommentMetaText()`도
   - 실행 중이면 무조건 “댓글 1개 등록하고 목록 재조회 중”
   로만 나온다
4. config input 락 대상은
   - `postNo`
   - `submitMode`
   - `memo`
   - `password`
   뿐이다

판정:

- 문서의 “현재 UI는 WAITING_CODE를 표현 못 한다”는 주장은 정확하다.
- `WAITING_CODE`, `PREPARING_CHALLENGE`, `reCAPTCHA 필요` 같은 상태는 새 문구/새 DOM이 꼭 필요하다.

즉 결론:

- 기존 상태 카드 틀은 재사용 가능
- 상태 문구와 challenge 영역은 반드시 확장 필요

## 2.3 background action 분기

확인 파일:

- [background/background.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/background/background.js:564)
- [background/background.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/background/background.js:839)

현재 실제 흐름:

1. `start`는 공통 분기에서 `scheduler.start()` 호출
2. `stop`은 `scheduler.stop()` 호출
3. `updateConfig`에서 신문고 전용 정규화/검증 수행
4. `getStatus`, `refreshStatus` 같은 별도 action은 selfHostedVpn 쪽 위주

없는 것:

1. `prepareManualChallenge`
2. `refreshManualChallenge`
3. `submitManualChallenge`
4. `cancelManualChallenge`

판정:

- 문서의 “background action을 새로 만들어야 한다”는 주장은 정확하다.
- 지금 구조로는 popup에서 code 입력 후 재개 제출할 통로가 없다.

## 2.4 config 변경 차단 로직

확인 파일:

- [background/background.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/background/background.js:1793)

현재 실제 흐름:

신문고 실행 중에는 아래 key가 바뀌면 저장을 막는다.

- `postNo`
- `memo`
- `submitMode`
- `password`
- `replyNo`
- `name`
- `code`
- `gallNickName`
- `useGallNick`
- `recommend`

판정:

- 문서의 “manual code를 config에 올리면 안 된다”는 주장은 정확하다.
- 이유는 실제 코드가 `code`를 일반 설정값처럼 다루고 있기 때문이다.

즉 결론:

- captcha code는 저장 설정이 아니라 일회성 submit payload로 분리해야 한다.

## 2.5 reset 동작

확인 파일:

- [background/background.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/background/background.js:2199)

현재 실제 흐름:

`resetSinmungoCommentSchedulerState()`는 통계만 지우는 게 아니라:

1. `phase`
2. 최근 성공/실패 시각
3. 최근 댓글 번호
4. `config.postNo`
5. `config.submitMode`
6. `config.memo`
7. `config.password`

까지 같이 초기화한다.

판정:

- 문서의 “manual mode에서 reset 의미를 재정의해야 한다”는 주장은 정확하다.

예시:

```txt
지금 WAITING_CODE 상태에서 reset
-> 통계만 초기화할지
-> 대기 challenge까지 폐기할지
현재 로직만으로는 후자에 가깝게 흘러갈 가능성이 큼
```

## 2.6 scheduler 상태 전이

확인 파일:

- [features/sinmungo-comment/scheduler.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/scheduler.js:10)
- [features/sinmungo-comment/scheduler.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/scheduler.js:54)
- [features/sinmungo-comment/scheduler.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/scheduler.js:108)
- [features/sinmungo-comment/scheduler.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/scheduler.js:159)
- [features/sinmungo-comment/scheduler.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/scheduler.js:193)

현재 실제 흐름:

1. phase enum은 `IDLE / SUBMITTING / SUCCESS / ERROR`
2. `start()`는 곧바로 `phase=SUBMITTING`, `isRunning=true`
3. `ensureRunLoop()`는 바로 `run()` 실행
4. `run()`의 `finally`에서 항상
   - `isRunning=false`
   - `startAbortController=null`
5. `loadState()`는 저장 상태에서 `isRunning=true`를 읽더라도
   - 강제로 `isRunning=false`
   - `phase=SUCCESS 또는 IDLE`
   로 바꾸고
   - “1회성 작업이라 자동 복원 안 함” 로그를 남긴다

판정:

- 문서의 “현재 scheduler는 WAITING_CODE를 유지할 수 없다”는 주장은 정확하다.

즉 결론:

- manual mode를 넣으려면 scheduler는 단순 1회성 runner가 아니라 상태 머신으로 바뀌어야 한다.

## 2.7 API 입력/정규화

확인 파일:

- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:4)
- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:27)

현재 실제 흐름:

config에는 이미 아래 필드가 있다.

- `submitMode`
- `postNo`
- `memo`
- `replyNo`
- `name`
- `password`
- `code`
- `gallNickName`
- `useGallNick`
- `recommend`

판정:

- 문서의 “manual mode에 필요한 비회원 필드는 이미 일부 존재한다”는 점은 맞다.
- 하지만 이 중 `code`는 저장 config로 유지되면 stale risk가 있다.

## 2.8 API submit 본체

확인 파일:

- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:84)
- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:117)
- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:182)
- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:196)

현재 실제 흐름:

1. `withDcRequestLease`로 submit 전체를 감싼다
2. 게시물 HTML GET
3. hidden token 추출
4. `member_division`, `comment_code`, `use_gall_nick` 판별
5. mode mismatch 선차단
6. `anonymous && comment_code=Y && code 없음`이면 즉시 `challenge_required`
7. body 조립
8. page-context submit
9. 숫자 응답 또는 댓글 목록 재조회로 성공 판정

판정:

- 문서의 “현재 API는 captcha 필요 시 지원 안 함으로 끝난다”는 주장은 정확하다.
- 문서의 “lease를 기다림 전체에 잡으면 안 된다”는 주장도 정확하다.

이유:

```txt
지금 submitComment()
-> withDcRequestLease 내부에서
   HTML GET + token 추출 + submit + verify

manual mode를 여기 그대로 얹으면
-> 사람 입력 대기 시간까지 request lease를 잡게 될 위험이 큼
```

## 2.9 anonymous body와 공식 스크립트 차이

확인 파일:

- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:129)
- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:223)
- live `comment.js` 1408~1561 근처

현재 실제 흐름:

확장 구현은:

1. `useGallNick !== 'Y'`일 때만 `name`을 보냄
2. 비밀번호가 비어 있으면 `password` key를 생략
3. code가 비어 있으면 `code` key를 생략

공식 스크립트는:

1. 비회원 폼에 password input이 있으면 비밀번호를 비워서 보낼 수 없음
2. 길이 2 미만도 안 됨
3. `use_gall_nick=Y`여도 `name=` key 자체는 같이 붙임
4. 추가로 `gall_nick_name`, `use_gall_nick`를 붙임

판정:

- manual mode 구현 시 official payload와 완전히 같게 맞출지 다시 결정해야 한다.
- 적어도 비밀번호 필수 규칙은 지금보다 엄격하게 맞추는 쪽이 안전하다.

## 2.10 page-context submit 방식

확인 파일:

- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:414)
- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:771)
- [features/sinmungo-comment/api.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/features/sinmungo-comment/api.js:809)

현재 실제 흐름:

1. 비활성 디시 글 탭 생성
2. 탭 complete 대기
3. `MAIN` world에서 `fetch('/board/forms/comment_submit')`
4. 완료 후 탭 바로 닫음

판정:

- 문서의 “same-origin page-context 패턴은 재사용 가능”은 맞다.
- 문서의 “manual mode에서는 탭을 바로 닫지 말고 유지해야 한다”도 맞다.

즉 결론:

- 지금 helper는 `즉시 제출용`으로는 적합
- `준비 -> 대기 -> 제출`용으로는 분리 필요

## 2.11 service worker 복원/재개

확인 파일:

- [background/background.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/background/background.js:1986)
- [background/background.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/background/background.js:1994)

현재 실제 흐름:

1. `loadSchedulerStateIfIdle()`는 `runPromise`만 없으면 load
2. `resumeStandaloneScheduler()`는 `isRunning=true`일 때 `ensureRunLoop()` 다시 실행

하지만 신문고 scheduler는 `loadState()`에서 이미 `isRunning`을 강제로 내리므로,
결국 manual waiting 상태는 복원되지 못한다.

판정:

- 문서의 “service worker 재시작 정책을 따로 정해야 한다”는 주장은 정확하다.

## 2.12 popup polling

확인 파일:

- [popup/popup.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:521)
- [popup/popup.js](/mnt/c/users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:526)

현재 실제 흐름:

1. popup 열리면 즉시 `refreshAllStatuses()`
2. 이후 1초마다 전체 상태 polling

판정:

- manual mode에서도 popup을 닫았다 다시 열면 상태를 다시 그릴 수 있는 기반은 있다.
- 대신 challenge 이미지 URL이나 pending state가 status payload에 없으면, 1초 polling 구조만으로는 UI가 복원되지 않는다.

즉 결론:

- manual challenge 표시 정보는 scheduler status에 실어야 한다.

---

## 3. live 공식 스크립트 대조 결과

확인 소스:

- `https://gall.dcinside.com/_js/kcaptcha.js?v=260112`
- `https://gall.dcinside.com/_js/comment.js?v=260211`

확정된 사실:

1. `kcaptcha_init(no)`가 `.kcaptcha[data-type="comment"]`를 자동 클릭한다.
2. 최종 캡차 이미지는 `/kcaptcha/image_v3/?...`로 세팅된다.
3. 비회원 댓글은 password와 code를 공식 스크립트 레벨에서 검사한다.
4. 실패 응답이 `false||captcha||v3`면 reCAPTCHA v3를 추가로 돌린다.

판정:

- 문서의 live tab 기반 설계는 맞다.
- 하지만 “kcaptcha만 처리하면 끝”은 아니다.

---

## 4. 패치 전 확정 이슈

### 높음

1. `WAITING_CODE` 상태를 현재 scheduler가 유지/복원하지 못함
2. `withDcRequestLease`를 기다림 전체에 잡으면 다른 요청까지 막힘
3. reCAPTCHA 추가 분기(`false||captcha||v3`)가 현재 없음

### 중간

1. anonymous 비밀번호 필수 검증이 현재 공식 폼보다 느슨함
2. anonymous `name` field 처리 방식이 official payload와 완전히 같지 않음
3. hidden challenge tab 생명주기 정리 훅이 없음
4. reset 의미가 manual mode와 충돌할 수 있음
5. popup 상태 문구가 `WAITING_CODE`를 표현하지 못함

### 낮음

1. challenge 이미지 URL/준비 시각/탭 생존 여부를 status payload에 실어야 popup polling 복원이 자연스러움

---

## 5. 지금 기준 결론

문서 방향 자체는 맞다.

정확히 말하면:

1. `popup -> background -> scheduler -> api -> page context submit` 재사용 방향은 맞다
2. 하지만 현재 구현은 “1회성 즉시 submit”에 강하게 묶여 있다
3. 그래서 manual mode는 단순 필드 추가가 아니라
   - scheduler 상태 머신 확장
   - background action 추가
   - anonymous 검증 강화
   - live script 분기(reCAPTCHA 포함) 정책 결정
   가 같이 필요하다

즉 지금 상태에서 “문서대로 가면 구조적으로 어디가 깨지는지”는 충분히 드러났고,
패치 전 체크 포인트는 더 이상 큰 덩어리로 남아 있지 않다.
