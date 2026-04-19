# 신문고 댓글 유동 수동입력 패치 정적 검증 보고서

작성일: 2026-04-19

대상 파일:

- [features/sinmungo-comment/api.js](../../features/sinmungo-comment/api.js)
- [features/sinmungo-comment/scheduler.js](../../features/sinmungo-comment/scheduler.js)
- [background/background.js](../../background/background.js)
- [popup/popup.html](../../popup/popup.html)
- [popup/popup.js](../../popup/popup.js)

## 1. 결론

이번 패치는 문서 목표대로 `유동/비회원 + 수동 인증코드 입력` 흐름을 실제 코드에 붙였다.

쉽게 말하면 원래는 이랬다.

```txt
토글 ON
-> 바로 comment_submit
-> 인증코드가 필요하면 실패
```

지금은 이렇게 바뀌었다.

```txt
토글 ON
-> 실제 글 탭에서 유동 댓글 폼/캡차 준비
-> popup에 이미지 표시
-> 사람이 코드 입력
-> 같은 글 탭 문맥에서 comment_submit
-> 댓글 번호/목록 재조회로 성공 확인
```

정적 검증 기준 결론은 아래와 같다.

1. `popup -> background -> scheduler -> page-context submit -> verify -> status restore` 흐름은 논리적으로 이어진다.
2. 문서에서 요구한 `PREPARING_CHALLENGE -> WAITING_CODE -> SUBMITTING` 3단계가 실제 scheduler 상태로 들어갔다.
3. live DOM 토큰을 다시 읽고 같은 탭 MAIN world 에서 제출하는 요구사항도 코드에 반영됐다.
4. 추가 점검 중 발견한 파생 이슈 2건도 같이 수정했다.
   - 토글 ON 직후 즉시 OFF 했을 때 제출이 계속될 수 있는 경쟁 조건
   - reset 후 유동 닉/추천 관련 숨은 설정값이 남는 문제

현 시점 판정:

- 구조상 바로 진행 가능한 상태
- 다만 실서비스 정책상 `false||captcha||v3` reCAPTCHA 추가 요구는 아직 자동 처리하지 않는다

## 2. 원래와 지금 차이

### 2.1 원래

예시:

```txt
1045755 글
댓글 문구 = 처리완료
모드 = 유동

토글 ON
-> submitComment()
-> code 없음
-> challenge_required 실패
```

원인은 간단했다.

1. scheduler가 중간 대기 상태를 보관하지 못했다.
2. popup에 캡차 이미지/코드 입력칸이 없었다.
3. background에 수동 제출 전용 action이 없었다.
4. API도 "준비 후 사람 입력 대기"가 아니라 "즉시 제출"만 지원했다.

### 2.2 지금

예시:

```txt
1045755 글
댓글 문구 = 처리완료
모드 = 유동
비밀번호 = 0989

토글 ON
-> hidden 탭 생성
-> live DOM에서 member_division/comment_code/use_gall_nick/captcha image 준비
-> popup에 이미지 표시
-> 사람이 코드 7KQ2 입력
-> submitPreparedAnonymousChallenge()
-> 숫자 댓글 번호 응답 + 목록 재조회 확인
-> 성공 종료
```

## 3. 코드 흐름 대조

### 3.1 popup 입력과 수동입력 UI

UI 추가 위치:

- 유동 기본 닉 입력: [popup/popup.html:1137](../../popup/popup.html#L1137)
- 수동입력 섹션: [popup/popup.html:1150](../../popup/popup.html#L1150)
- 캡차 이미지: [popup/popup.html:1170](../../popup/popup.html#L1170)
- 인증코드 입력칸: [popup/popup.html:1180](../../popup/popup.html#L1180)
- 새 코드/제출/취소 버튼: [popup/popup.html:1185](../../popup/popup.html#L1185)

이벤트 바인딩:

- 저장/토글/수동입력 버튼 연결: [popup/popup.js:1093](../../popup/popup.js#L1093)
- 상태 렌더링: [popup/popup.js:3194](../../popup/popup.js#L3194)
- 수동입력 섹션 렌더링: [popup/popup.js:3248](../../popup/popup.js#L3248)

검증 결과:

1. 유동 모드 선택 시에만 `유동 닉네임 기본값`, `유동 비밀번호`가 열린다.
2. 저장 전과 시작 전 모두 비밀번호 2자 미만을 막는다.
3. `WAITING_CODE` 상태가 아니면 코드 입력칸/제출 버튼은 비활성화된다.
4. challenge id가 바뀔 때만 code 입력칸을 비워서, 같은 challenge 렌더 재호출로 입력값이 날아가지 않게 했다.

### 3.2 background 메시지 라우팅

탭 추적 연결:

- 탭 닫힘 감시: [background/background.js:171](../../background/background.js#L171)
- 탭 이동 감시: [background/background.js:185](../../background/background.js#L185)

새 action:

- `refreshManualChallenge`: [background/background.js:638](../../background/background.js#L638)
- `submitManualChallenge`: [background/background.js:654](../../background/background.js#L654)
- `cancelManualChallenge`: [background/background.js:670](../../background/background.js#L670)

설정 검증:

- 신문고 설정 숫자/공백/비밀번호 검증: [background/background.js:901](../../background/background.js#L901)
- 실행 중 config 변경 차단: [background/background.js:1814](../../background/background.js#L1814)
- reset 시 전체 feature-specific config 초기화: [background/background.js:2281](../../background/background.js#L2281)

검증 결과:

1. popup이 아니라 background로 직접 메시지를 보내도 `postNo`, `memo`, `anonymous password` 검증이 다시 걸린다.
2. 실행 중에는 `postNo`, `memo`, `submitMode`, `password`, `name`, `replyNo`, `recommend` 등 추적 키 변경을 막는다.
3. 수동입력용 hidden tab이 닫히거나 다른 글로 이동하면 scheduler가 바로 실패 처리한다.

### 3.3 scheduler 상태 흐름

상태 정의:

- [features/sinmungo-comment/scheduler.js:14](../../features/sinmungo-comment/scheduler.js#L14)

핵심 함수:

- 시작: [features/sinmungo-comment/scheduler.js:72](../../features/sinmungo-comment/scheduler.js#L72)
- 정지: [features/sinmungo-comment/scheduler.js:103](../../features/sinmungo-comment/scheduler.js#L103)
- 유동 준비: [features/sinmungo-comment/scheduler.js:182](../../features/sinmungo-comment/scheduler.js#L182)
- 코드 제출: [features/sinmungo-comment/scheduler.js:219](../../features/sinmungo-comment/scheduler.js#L219)
- 코드 새로받기: [features/sinmungo-comment/scheduler.js:294](../../features/sinmungo-comment/scheduler.js#L294)
- 탭 제거 대응: [features/sinmungo-comment/scheduler.js:367](../../features/sinmungo-comment/scheduler.js#L367)
- 탭 이동 대응: [features/sinmungo-comment/scheduler.js:384](../../features/sinmungo-comment/scheduler.js#L384)
- captcha 실패 재준비: [features/sinmungo-comment/scheduler.js:408](../../features/sinmungo-comment/scheduler.js#L408)
- 상태 복원: [features/sinmungo-comment/scheduler.js:507](../../features/sinmungo-comment/scheduler.js#L507)

변수 연결은 아래처럼 이어진다.

```txt
config.postNo
-> start()
-> lastTargetPostNo
-> prepareAnonymousRun()
-> prepareAnonymousManualChallenge(postNo)
-> challenge.postNo
-> submitPreparedAnonymousChallenge(postNo)
-> verifySubmittedComment(postNo)

config.memo
-> start()
-> lastSubmittedMemo
-> submitPreparedAnonymousChallenge(memo)
-> verifySubmittedComment(memo)

prepared.challenge
-> scheduler.pendingChallenge
-> popup 렌더
-> submitPreparedAnonymousCode()
-> submitPreparedAnonymousChallenge(challenge, code, name)
```

검증 결과:

1. 유동 모드일 때는 바로 제출하지 않고 `PREPARING_CHALLENGE` 로 들어간다.
2. 캡차가 필요하면 `pendingChallenge` 를 저장한 뒤 `WAITING_CODE` 로 멈춘다.
3. 코드 입력 후에는 `SUBMITTING` 으로 전환하고, 성공/실패가 끝나면 `pendingChallenge` 를 비운다.
4. background 재시작 시 예전 challenge는 그대로 복원하지 않고 만료 처리한다. 이건 안전한 쪽 설계다.

### 3.4 API 준비/제출/검증

핵심 함수:

- 기본 config: [features/sinmungo-comment/api.js:4](../../features/sinmungo-comment/api.js#L4)
- 공용 submit 진입점: [features/sinmungo-comment/api.js:140](../../features/sinmungo-comment/api.js#L140)
- 유동 준비: [features/sinmungo-comment/api.js:283](../../features/sinmungo-comment/api.js#L283)
- 유동 제출: [features/sinmungo-comment/api.js:414](../../features/sinmungo-comment/api.js#L414)
- 성공 검증: [features/sinmungo-comment/api.js:511](../../features/sinmungo-comment/api.js#L511)
- live DOM 준비 함수: [features/sinmungo-comment/api.js:1253](../../features/sinmungo-comment/api.js#L1253)
- live DOM 제출 함수: [features/sinmungo-comment/api.js:1368](../../features/sinmungo-comment/api.js#L1368)

유동 준비 단계에서 실제로 읽는 값:

1. `member_division`
2. `comment_code`
3. `use_gall_nick`
4. `gall_nick_name`
5. `name`
6. `password` input 존재 여부
7. `kcaptcha` 이미지 src

유동 제출 단계에서 실제로 다시 읽는 값:

1. `check_6 ~ check_10`
2. `c_r_k_x_z`
3. `service_code`
4. `cur_t`
5. `_GALLTYPE_`
6. `use_gall_nick`
7. `gall_nick_name`
8. `name`
9. `password` input 존재 여부
10. `comment_code`

검증 결과:

1. 수동 모드에서도 토큰을 prepare 시점의 캐시값으로 재사용하지 않고, 제출 직전에 live DOM에서 다시 읽는다.
2. `withDcRequestLease` 는 실제 submit 구간만 감싸고 있고, prepare 단계는 길게 lease를 잡지 않는다.
3. `use_gall_nick=Y` 일 때도 `name` 과 `gall_nick_name` 을 같이 실어 보낸다.
4. `comment_code=Y` 이고 code가 없으면 제출 전에 validation 실패시킨다.
5. 응답이 숫자 댓글 번호면 1차 성공으로 보고, 이후 목록 재조회까지 한다.
6. 숫자 응답이 없어도 after comment list 에서 새 댓글 번호와 memo가 맞으면 성공으로 본다.

## 4. 이번에 추가로 잡은 파생 이슈 2건

### 4.1 ON 직후 바로 OFF 했을 때 제출이 계속될 수 있는 경쟁 조건

원래:

```txt
start()
-> isRunning = true
-> ensureRunLoop()

run() 안에서 나중에 AbortController 생성

그 사이 stop()
-> 아직 controller 없음
-> abort 못 함
-> run은 계속 진행 가능
```

지금:

- [features/sinmungo-comment/scheduler.js:86](../../features/sinmungo-comment/scheduler.js#L86) 에서 `startAbortController` 를 start 단계에서 먼저 만든다.
- [features/sinmungo-comment/scheduler.js:134](../../features/sinmungo-comment/scheduler.js#L134) 에서 run이 그 controller를 재사용한다.

즉 예시로:

```txt
토글 ON 바로 직후 OFF
-> stop() 가 이미 생성된 controller를 abort
-> prepare/submit 진입 전부터 중단 가능
```

### 4.2 reset 후 유동 관련 숨은 값이 남는 문제

원래:

```txt
resetStats
-> postNo, memo, submitMode, password 정도만 초기화
-> name / gallNickName / useGallNick / recommend / replyNo 는 남을 수 있음
```

지금:

- [background/background.js:2297](../../background/background.js#L2297) 에서 `normalizeSinmungoCommentConfig(...)` 로 feature 관련 값을 한 번에 다시 정규화한다.

즉 예시로:

```txt
이전 실행에서 name=테스트닉, recommend=1 이었어도
reset 후
-> name=ㅇㅇ
-> recommend=0
-> replyNo=''
-> useGallNick='N'
로 돌아감
```

## 5. 라인 단위 논리 검증

### 5.1 저장 -> 시작 -> 대기

1. popup 저장 시 `postNo`, `memo`, `submitMode`, `name`, `password` 만 보낸다.
2. background는 그 값을 `normalizeSinmungoCommentConfig` 로 정규화한다.
3. scheduler `start()` 는 `config.postNo`, `config.memo`, `config.password` 를 다시 검사한다.
4. 유동이면 phase를 `PREPARING_CHALLENGE` 로 설정한다.
5. `prepareAnonymousRun()` 은 `config.name` 을 `requestedName` 으로 넘겨 live DOM 준비 함수에 전달한다.
6. 준비 결과의 `challenge` 는 `pendingChallenge` 로 저장되고 popup status에 그대로 노출된다.

### 5.2 대기 -> 제출

1. popup submit 버튼은 현재 `latestSinmungoCommentStatus.pendingChallenge` 기준으로 code/name 필수 여부를 본다.
2. background `submitManualChallenge` 는 `scheduler.submitPreparedAnonymousCode(code, name)` 로 넘긴다.
3. scheduler는 `WAITING_CODE` 상태인지 확인한다.
4. `pendingChallenge` 와 사람이 입력한 `code/name` 을 합쳐 `submitPreparedAnonymousChallenge` 로 넘긴다.
5. API는 challenge tab 유효성부터 다시 확인한다.
6. 그 탭의 MAIN world 에서 live hidden input을 읽고 `comment_submit` 을 보낸다.

### 5.3 제출 -> 검증 -> 종료

1. 응답 텍스트가 숫자면 댓글 번호로 본다.
2. 그 뒤 게시물 HTML/댓글 목록을 다시 읽는다.
3. 응답 숫자 댓글 번호와 맞거나, 같은 memo를 가진 새 댓글이 생겼으면 성공이다.
4. captcha 실패면 새 challenge를 자동 재준비하고 다시 `WAITING_CODE` 로 돌아간다.
5. reCAPTCHA 요구면 `recaptcha` 실패로 종료한다.
6. 성공/실패 모두 popup 상태, 로그, 최근 댓글 번호, 최근 오류 시각에 반영된다.

## 6. 정적 엣지케이스 검증 36건

1. 게시물 번호 공란 저장 시 popup이 차단하는가
2. 게시물 번호 문자 입력 시 popup이 차단하는가
3. 게시물 번호 공란 시작 시 popup이 차단하는가
4. memo 공란 저장 시 popup이 차단하는가
5. memo 공란 updateConfig 직접 호출 시 background가 다시 차단하는가
6. 유동 비밀번호 1자일 때 popup 저장이 차단되는가
7. 유동 비밀번호 1자일 때 popup 시작이 차단되는가
8. 유동 비밀번호 1자일 때 background updateConfig가 다시 차단하는가
9. 실행 중 다시 start 했을 때 runPromise 중복 생성이 없는가
10. ON 직후 즉시 OFF 했을 때 abort 경합이 없는가
11. 유동 준비 중 stop 하면 hidden tab이 닫히는가
12. `WAITING_CODE` 상태에서 stop 하면 pendingChallenge가 비워지는가
13. challenge tab을 사용자가 직접 닫으면 ERROR로 가는가
14. challenge tab이 다른 글로 이동하면 ERROR로 가는가
15. background 재시작 뒤 예전 challenge를 재사용하지 않는가
16. popup 재렌더만으로 code 입력칸이 불필요하게 지워지지 않는가
17. 새로운 challenge가 왔을 때만 code 입력칸이 초기화되는가
18. `use_gall_nick=Y` 일 때 닉 입력칸이 숨겨지는가
19. `use_gall_nick=N` 일 때 닉 입력칸이 보이는가
20. `use_gall_nick=Y` 일 때 `name` 과 `gall_nick_name` 이 둘 다 body에 들어가는가
21. `comment_code=Y` 인데 code 공란이면 submit 전에 막히는가
22. `comment_code=N` 이면 코드 없이 바로 submit 경로로 가는가
23. password input이 존재하는데 password가 2자 미만이면 submit 전에 막히는가
24. member 폼 페이지인데 anonymous 모드로 돌리면 mode mismatch로 중단하는가
25. anonymous 폼 페이지인데 member 모드로 돌리면 mode mismatch로 중단하는가
26. hidden token 하나라도 빠지면 spec 실패로 중단하는가
27. captcha image가 끝까지 `kcap_none.png` 면 prepare 실패로 중단하는가
28. submit 응답이 숫자 댓글 번호일 때 verify가 이어지는가
29. 응답 숫자 번호가 있지만 목록 재조회 실패면 success + verifyMessageSuffix로 남기는가
30. 응답 숫자가 없어도 after 목록에서 같은 memo 새 댓글이 잡히면 성공으로 보는가
31. 새 댓글은 생겼지만 memo가 다르면 verify 실패로 남기는가
32. transport error가 있어도 after 목록에서 같은 memo 새 댓글이 보이면 성공으로 보는가
33. transport error이고 after 목록에도 없으면 network_verify 실패로 남기는가
34. `false||captcha||v3` 응답이 recaptcha 실패로 분류되는가
35. captcha 오답 응답은 새 코드 재준비 흐름으로 이어지는가
36. reset 후 `postNo`, `submitMode`, `memo`, `replyNo`, `name`, `password`, `gallNickName`, `useGallNick`, `recommend` 가 모두 기본값으로 돌아가는가

정적 판정:

- 위 36건 모두 현재 코드 경로상 방어 로직이 존재하거나, 의도된 결과로 수렴한다.

## 7. 남은 리스크

1. `false||captcha||v3` 는 아직 자동 reCAPTCHA 풀이를 붙이지 않았다.
   - 즉 유동 수동입력모드는 `일반 댓글 캡차` 까지는 처리하지만, 서버가 추가 reCAPTCHA 를 요구하는 경우는 별도 단계다.

2. live DOM 구조가 바뀌면 `prepareAnonymousChallengeFromPageContext` 와 `submitAnonymousCommentFromPageContext` 의 selector를 다시 맞춰야 한다.

3. 댓글 성공 판정은 `응답 숫자 댓글 번호` 또는 `after comment list` 기준으로 충분히 보수적으로 되어 있지만, 디시 응답 포맷 자체가 바뀌면 검증 조건을 다시 맞춰야 한다.

## 8. 최종 판단

이번 패치는 "유동이면 사람 코드 입력까지 포함한 실제 usable flow" 기준으로는 구조가 맞다.

예시로 다시 요약하면:

```txt
원래:
유동 글 + 캡차 필요
-> 그냥 실패

지금:
유동 글 + 캡차 필요
-> 이미지 준비
-> popup 표시
-> 코드 입력
-> 같은 글 탭 문맥에서 제출
-> 댓글 번호/목록 재조회 확인
```

즉 이번 단계에서 필요한 핵심은 충족됐다.

- 문서 설계 반영됨
- 호출 연결 반영됨
- 중간 대기 상태 반영됨
- 파생 경쟁 조건/초기화 누수도 같이 정리됨

남은 건 구조 문제가 아니라 실서비스 정책 대응 범위다.
현재 기준으로는 `일반 유동 수동입력 댓글 등록` 까지는 바로 다음 단계 실환경 검증으로 넘겨도 되는 상태다.
