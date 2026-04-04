# 수동 끌올 자동화 구현 플랜

## 목표

새 탭 하나를 추가해서, 사용자가 아래 3개를 입력하고 ON 하면 지정한 글을 일정 시간 동안 주기적으로 자동 끌올하게 만든다.

1. 게시물 번호
2. 지속 시간(분)
3. 끌올 주기(분)

예시:

- 게시물 번호: `1087122`
- 지속 시간: `60`
- 끌올 주기: `1`

그러면 동작은 이렇게 된다.

1. `끌올 자동` ON
2. `1087122` 글을 바로 1회 끌올
3. 그 뒤 `1분마다 1회` 다시 끌올
4. 총 `60분` 지나면 자동 정지

쉽게 말하면:

- 운영 중 수동으로 올려둔 안내글 하나를
- 정해진 시간 동안만
- 자동으로 올려주는 전용 탭이다


## 사용자 기준 기대 동작

### 기본 예시

- 글 번호 `1087122`
- 지속 시간 `60분`
- 주기 `1분`

사용자가 `설정 저장` 후 ON 하면:

1. 바로 `1087122` 끌올 1회
2. `13:01`, `13:02`, `13:03`처럼 1분 간격으로 계속 실행
3. `14:00`이 지나면 자동 OFF

### 짧은 지속시간 예시

- 글 번호 `1087122`
- 지속 시간 `3분`
- 주기 `5분`

이 경우도 시작 즉시 1회는 수행하고, 다음 예약 시점이 지속시간을 넘기면 추가 실행 없이 자동 정지하는 쪽이 맞다.

즉:

1. 시작 직후 1회 끌올
2. 다음 실행 예정 시각이 종료 시각을 넘음
3. 그대로 자동 정지

쉽게 말하면:

- 시작하면 무조건 한 번은 올리고
- 이후 반복은 `끝나는 시각 안쪽에 들어오는 예약`만 수행한다


## 현재 코드 기준 교차검증

이번 기능은 기존 feature를 변형하는 것보다 **새 standalone scheduler**로 추가하는 게 맞다.

### 1. background는 이미 standalone feature 여러 개를 generic하게 관리한다

현재 `background/background.js`는 feature별 scheduler를 registry에 넣고 아래 공용 action을 처리한다.

- `start`
- `stop`
- `getStatus`
- `updateConfig`
- `resetStats`

관련 코드:

- scheduler registry: [background/background.js](../background/background.js)
- generic message routing: [background/background.js](../background/background.js)

즉 새 feature도 아래 패턴으로 붙이면 된다.

1. import
2. 인스턴스 생성
3. `schedulers`에 등록
4. `getAllStatuses()`에 포함
5. shared config/gallery reset wiring에 포함
6. `getBusyFeatures()`에 포함
7. `loadSchedulerStateIfIdle()` 대상에 포함
8. `resumeStandaloneScheduler()` 대상에 포함

### 2. popup 탭은 현재 5칸 grid다

현재 탭 CSS는 `20`칸 grid에 각 버튼이 `4칸`씩 먹어서 **한 줄에 5개**가 놓인다.

관련 코드:

- [popup/popup.css](../popup/popup.css)

현재 탭 수는 10개다.

- 1행 5개
- 2행 5개

여기서 버튼을 하나 더 추가하면 **11번째 버튼이 3번째 줄 첫 칸**으로 간다.

현재 2행 첫 칸이 `댓글 방어`이므로,
새 버튼을 마지막에 추가하면 **시각적으로 `댓글 방어` 바로 아래 3번째 줄 첫 칸**에 들어간다.

즉 사용자 요청한 위치와 맞는다.

관련 코드:

- 탭 DOM: [popup/popup.html](../popup/popup.html)
- 탭 CSS: [popup/popup.css](../popup/popup.css)

### 3. 공용 갤러리 변경 시 feature 상태 초기화 패턴이 이미 있다

현재 shared config의 `galleryId`가 바뀌면 각 scheduler 상태를 reset 하고 새 갤러리 값을 주입한다.

관련 코드:

- [background/background.js](../background/background.js)

즉 새 끌올 feature도:

1. `config.galleryId`를 공용 갤러리와 같이 들고 가고
2. 갤러리 변경 시 state reset 대상에 포함

하면 기존 패턴과 맞다.

중요한 점:

현재 shared config 저장은 먼저 `getBusyFeatures()`로 실행 중 feature가 있는지 확인하고, busy feature가 있으면 저장 자체를 막는다.

즉 새 feature도 `getBusyFeatures()`에 넣어야:

- 끌올 자동 실행 중에는 공통 갤러리 변경이 먼저 차단되고
- 사용자가 OFF 후 갤러리를 바꾸는 흐름

으로 현재 앱 전체 UX와 맞출 수 있다.

추가로 이 기능은 `postNo`가 갤러리 의미에 직접 묶인다.

예시:

- `thesingularity`의 `1087122`
- 다른 갤의 `1087122`

는 전혀 다른 글일 수 있다.

그래서 새 feature는 gallery change 반영 시 단순 state reset만 하지 말고, **안전하게 `config.postNo`도 비우는 쪽**이 맞다.

### 4. 요청 직렬화는 세션 broker lease를 재사용하면 된다

현재 도배기 분류, 삭제, IP 차단, 분탕자동차단 fetch는 모두 `withDcRequestLease()`를 통해 요청 gate를 탄다.

관련 코드:

- broker: [background/dc-session-broker.js](../background/dc-session-broker.js)
- 예시 API: [features/post/api.js](../features/post/api.js)

즉 새 끌올도:

```js
withDcRequestLease({ feature: 'bumpPost', kind: 'updateBump' }, async () => ...)
```

형태로 감싸면,

- 계정 전환 중 대기
- 요청 중복 직렬화
- 세션 gate 일관성

을 그대로 재사용할 수 있다.

### 5. 권한은 이미 충분하다

현재 manifest에는 이미 아래 host permission이 있다.

- `https://gall.dcinside.com/*`
- `cookies`

관련 파일:

- [manifest.json](../manifest.json)

즉 이번 기능 때문에 새 권한을 추가로 붙일 필요는 없다.


## 실제 스펙 확인

### 1. endpoint

문서 [끌올.md](./끌올.md) 기준 요청 endpoint는 아래다.

```text
POST https://gall.dcinside.com/ajax/minor_manager_board_ajax/update_bump
```

### 2. payload

문서 캡처 기준 payload는 아래다.

- `ci_t`
- `id`
- `_GALLTYPE_`
- `nos[]`

즉 예시:

```text
ci_t=...
id=thesingularity
_GALLTYPE_=M
nos[]=1087148
```

### 3. 끌올 버튼 존재 근거

실제 관리자 글 보기 샘플 HTML에도 아래 버튼이 존재한다.

```html
<button type="button" class="btn_user_control" onclick ="update_bump(1044701)" >끌올</button>
```

근거 샘플:

- [projects/dc_auto_bot/docs/post_html.md](../projects/dc_auto_bot/docs/post_html.md)
- [projects/dc_auto_bot/docs/normal.md](../projects/dc_auto_bot/docs/normal.md)
- [projects/dc_auto_bot/docs/개념글(추천수65).md](../projects/dc_auto_bot/docs/%EA%B0%9C%EB%85%90%EA%B8%80%28%EC%B6%94%EC%B2%9C%EC%88%9865%29.md)

쉽게 말하면:

- 이 기능은 임의의 공개 API가 아니라
- **운영진 권한이 있는 글 보기 화면의 관리 버튼 동작을 자동화**하는 구조다

### 4. response 특성

`끌올.md` 캡처상 response body는 비어 있거나 DevTools에서 내용을 못 읽은 상태고, 응답 `Content-Type`은 `text/html; charset=UTF-8`이다.

즉 현재 스펙 기준으로는:

- JSON 성공 응답을 기대하면 안 된다
- 성공 판정은 **HTTP status + 본문 에러 키워드 부재** 기준으로 가는 게 안전하다

권장 성공 판정:

1. `response.ok === true`
2. 본문에 아래 패턴이 없을 것
   - `정상적인 접근이 아닙니다`
   - `권한`
   - `로그인`
   - `forbidden`
   - `denied`
   - `ci_t`

이 키워드 패턴은 현재 다른 관리 API에서 이미 쓰는 방식과 맞춘다.

관련 코드:

- [features/post/api.js](../features/post/api.js)
- [features/ip/api.js](../features/ip/api.js)


## 구현 방향

### feature id

권장 feature id:

```text
bumpPost
```

이 이름으로 가면 background generic routing, popup DOM, storage key가 다 일관되다.

### 새로 추가할 파일

1. `features/bump-post/api.js`
2. `features/bump-post/scheduler.js`

### 수정할 파일

1. `background/background.js`
2. `popup/popup.html`
3. `popup/popup.js`

필요하면:

4. `popup/popup.css`


## UI 설계

### 탭

새 탭 이름 권장:

```text
끌올 자동
```

배치는 `nav.tabs`의 **11번째 버튼**으로 추가한다.

그렇게 하면 현재 grid 구조상:

- 3번째 줄 첫 칸
- 시각적으로 `댓글 방어` 아래

에 온다.

현재 탭 전환 JS는 `button.dataset.tab`과 `panel.dataset.feature`를 generic하게 비교한다.

즉 새 탭은:

- 버튼 `data-tab="bumpPost"`
- 패널 `data-feature="bumpPost"`

만 맞추면, 탭 전환 자체를 위해 별도 switch 문을 추가할 필요는 없다.

관련 코드:

- [popup/popup.js](../popup/popup.js)

### 패널

`data-feature="bumpPost"` 패널을 추가한다.

권장 입력값 3개:

1. `게시물 번호`
2. `지속 시간 (분)`
3. `끌올 주기 (분)`

권장 버튼:

1. ON/OFF 토글
2. `설정 저장`
3. `통계 초기화`

권장 상태칸:

1. 상태
2. 대상 게시물
3. 시작 시각
4. 종료 예정
5. 다음 끌올 예정
6. 최근 성공
7. 최근 실패
8. 누적 끌올 성공
9. 누적 실패
10. 완료 사이클

권장 메타 문구 예시:

```text
지정한 글 번호를 현재 갤러리 기준으로 일정 시간 동안 주기적으로 끌올합니다. 시작 즉시 1회 실행 후, 설정한 분 간격으로 반복하다가 지속 시간이 끝나면 자동 정지합니다.
```


## 설정값 / 상태값 설계

### config

권장 config shape:

```js
{
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  postNo: '1087122',
  durationMinutes: 60,
  intervalMinutes: 1,
}
```

### runtime state

권장 state:

```js
isRunning
runPromise
cycleCount
startedAt
endsAt
nextRunAt
lastBumpedAt
lastErrorAt
lastErrorMessage
lastBumpedPostNo
totalBumpedCount
totalFailedCount
logs
```

쉽게 말하면:

- config는 “무엇을 얼마나 자주 얼마나 오래 할지”
- state는 “지금 어디까지 했는지”

를 나눈다.


## API 구현 상세

## 1. `features/bump-post/api.js`

### 기본 설정

`resolveConfig()` 구조는 `features/post/api.js` 패턴을 그대로 재사용하면 된다.

권장 기본값:

```js
galleryId: 'thesingularity'
galleryType: 'M'
baseUrl: 'https://gall.dcinside.com'
postNo: ''
durationMinutes: 60
intervalMinutes: 1
```

### `getCiToken()`

현재 다른 관리 API처럼 `ci_c` 쿠키를 읽어서 `ci_t`로 사용한다.

관련 코드:

- [features/post/api.js](../features/post/api.js)

즉 새 api에서도 아래를 그대로 재사용하면 된다.

```js
chrome.cookies.get({ url: baseUrl, name: 'ci_c' })
```

### `bumpPost(config, postNo, options = {})`

권장 구현:

1. `withDcRequestLease({ feature: 'bumpPost', kind: 'updateBump' }, ...)`
2. `ci_t` 쿠키 읽기
3. urlencoded body 구성
4. `POST /ajax/minor_manager_board_ajax/update_bump`
5. 성공/실패 판정

권장 body:

```text
ci_t=...
id={galleryId}
_GALLTYPE_={galleryType}
nos[]={postNo}
```

권장 headers:

- `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`
- `X-Requested-With: XMLHttpRequest`
- `Origin: https://gall.dcinside.com`
- `Referer: https://gall.dcinside.com/mgallery/board/view/?id={galleryId}&no={postNo}&page=1`

여기서 `Referer`는 `끌올.md` 캡처와 실제 버튼 위치 기준으로 **글 보기 페이지**가 맞다.

### 응답 판정

문서 스펙상 JSON 보장이 없으므로 아래처럼 처리하는 게 안전하다.

1. `response.status === 429`
   - backoff 후 재시도
2. `response.status === 403`
   - 로그인/권한 문제 로그
3. `response.ok !== true`
   - 실패
4. `response.text()`에서 금지 키워드 검사
5. 나머지는 성공

권장 반환 shape:

```js
{
  success: true,
  postNo: '1087122',
  message: '',
}
```

실패 예시:

```js
{
  success: false,
  postNo: '1087122',
  message: 'ci_t 토큰(ci_c 쿠키) 없음. 로그인 상태를 확인하세요.',
  failureType: 'auth',
}
```

권장 `failureType` 예시:

- `auth`
- `forbidden`
- `rate_limit`
- `network`
- `unknown`


## Scheduler 구현 상세

## 1. `features/bump-post/scheduler.js`

권장 storage key:

```text
bumpPostSchedulerState
```

### normalizeConfig()

반드시 export 한다.

이유:

- background `updateConfig`에서 저장 직전 normalize를 태우기 위해서다.

권장 normalize 규칙:

1. `postNo`는 trim만 하고 **숫자만 허용 검증**
2. `durationMinutes` 최소 `1`
3. `intervalMinutes` 최소 `1`
4. 비정상 값이면 기본값 fallback

예시:

- `1087122 ` -> `1087122`
- `1087abc122` -> **저장 거부**
- `0분` -> `1분`
- `-5분` -> `1분`

중요한 이유:

- `postNo`는 숫자 계산값이 아니라 **대상 글 식별자**다
- 그래서 `숫자만 남기기` 식으로 정규화하면 사용자가 잘못 입력한 값이 **조용히 다른 글 번호로 바뀔 수 있다**

예시:

- `1087abc122`를 `1087122`로 바꾸면
- 사용자는 오타를 냈는데도 전혀 다른 글을 끌올할 수 있다

즉 이 기능은:

- 공백 trim 정도만 허용
- 그 외 숫자 아닌 문자가 섞이면 **저장 실패**

가 안전하다

### start()

권장 동작:

1. 이미 실행 중이면 경고 로그 후 return
2. `postNo` 없으면 시작 거부
3. `startedAt = now`
4. `endsAt = now + durationMinutes`
5. `nextRunAt = now`
6. 즉시 `ensureRunLoop()`

즉 시작하면 **첫 실행을 기다리지 않고 바로 한번** 들어가게 한다.

### run()

권장 흐름:

1. `nextRunAt`이 미래면 wait
2. 시간이 되면 `runCycle()`
3. 성공/실패와 무관하게 `cycleCount += 1`
4. `now + intervalMinutes`를 다음 실행 시각으로 잡음
5. 다음 실행 시각이 `endsAt`를 넘으면 자동 stop

여기서 다음 실행 시각은 **cycle 완료 시각 기준**으로 잡는 쪽이 안전하다.

이유:

- 엄격한 wall-clock 기준으로 잡으면 느린 요청과 겹칠 수 있고
- 끌올 요청이 오래 걸릴 때 run loop overlap 위험이 생긴다

즉 예시:

- 13:00:00 실행 시작
- 13:00:08 완료
- interval 1분

이면 다음 실행은 `13:01:08`처럼 잡는 쪽이 자연스럽다.

### runCycle()

권장 흐름:

1. `now > endsAt`면 바로 stop
2. `postNo` 유효성 재확인
3. `bumpPost(config, postNo)` 호출
4. 성공이면
   - `lastBumpedAt`
   - `lastBumpedPostNo`
   - `totalBumpedCount`
   - 성공 로그
5. 실패면
   - `lastErrorAt`
   - `lastErrorMessage`
   - `totalFailedCount`
   - 실패 로그

### resetStats 정책

이 feature는 `startedAt / endsAt / nextRunAt`가 실제 예약 상태라서, 통계 초기화가 이 값을 건드리면 안 된다.

권장 동작:

- **실행 중 resetStats**
  - `cycleCount`
  - `logs`
  - `totalBumpedCount`
  - `totalFailedCount`
  - `lastBumpedAt`
  - `lastErrorAt`
  - `lastErrorMessage`
  - `lastBumpedPostNo`
  만 초기화
  - `isRunning / startedAt / endsAt / nextRunAt`는 유지

- **정지 중 resetStats**
  - 위 통계 필드만 초기화
  - config와 예약 관련 시각은 빈 값 유지

쉽게 말하면:

- 통계 초기화는 기록만 비우는 기능
- 이미 돌아가고 있는 끌올 예약까지 끊으면 안 된다

### 자동 정지 시점

권장 규칙:

- `runCycle()` 시작 전 `now >= endsAt`면 stop
- 실행 후 계산한 `nextRunAt > endsAt`면 다음 대기 없이 stop

즉:

- 지속시간 안쪽에 들어오는 시도만 수행
- 끝나는 시각을 넘기는 예약은 만들지 않는다

### 실패 정책

기본 권장안:

- 실패해도 **그 즉시 자동 OFF하지 않는다**
- 다음 주기까지 계속 유지
- 지속시간이 끝날 때까지만 재시도

이유:

- 로그인 세션/일시 네트워크/요청 gate 대기처럼 일시 오류일 수 있기 때문이다

예시:

- 13:10 한 번 실패
- 13:11 다시 시도
- 13:12 성공

이 흐름이 가능해야 한다.

다만 문서 기준으로는 아래는 로그를 강하게 남겨야 한다.

- `ci_t` 없음
- 권한/로그인 키워드 감지
- 403

쉽게 말하면:

- 일단은 duration 끝날 때까지 재시도
- 실패 원인은 로그에 최대한 명확히 남김

### saveState / loadState / getStatus

기존 standalone scheduler 패턴을 그대로 따라간다.

참고 패턴:

- [features/han-refresh-ip-ban/scheduler.js](../features/han-refresh-ip-ban/scheduler.js)
- [features/comment/scheduler.js](../features/comment/scheduler.js)

`getStatus()`에는 최소한 아래가 있어야 popup이 충분히 표시 가능하다.

```js
{
  isRunning,
  config,
  cycleCount,
  startedAt,
  endsAt,
  nextRunAt,
  lastBumpedAt,
  lastErrorAt,
  lastErrorMessage,
  lastBumpedPostNo,
  totalBumpedCount,
  totalFailedCount,
  logs,
}
```

### 워커 재시작 복원

service worker 재시작 후에도:

- `isRunning === true`
- `endsAt`가 아직 미래

이면 run loop가 다시 살아나야 한다.

반대로:

- 저장 상태는 실행 중이었지만
- `endsAt`가 이미 과거

이면 load 후 자동으로 정지 상태로 정리하는 게 맞다.

즉 `loadState()`에는 아래 경계가 필요하다.

1. `isRunning === true`
2. `endsAt`가 유효
3. `Date.now() >= endsAt`

이면

- `isRunning = false`
- `nextRunAt = ''`

로 정리하고, 필요하면 로그 1줄을 남기는 쪽이 안전하다.


## popup 구현 상세

## 1. `popup/popup.html`

추가할 것:

1. 탭 버튼
2. `data-feature="bumpPost"` 패널
3. 상태칸
4. 설정 입력 3개
5. `설정 저장`
6. `통계 초기화`
7. 최근 로그

`postNo` 입력은 `type="number"`보다 아래가 안전하다.

```html
<input type="text" inputmode="numeric" ...>
```

이유:

- `postNo`는 수치 계산값이 아니라 식별자라서
- `number` 입력의 wheel 증가/감소, `e` 표기, 브라우저별 파싱 차이를 피하는 게 낫다

쉽게 말하면:

- `지속 시간`, `주기`는 숫자 설정값이라 `number`가 맞고
- `게시물 번호`는 대상 식별자라 `text + inputmode=numeric`이 더 안전하다

### 위치

권장:

- 탭 버튼은 현재 10개 뒤에 **11번째**로 추가
- 패널 DOM은 `comment` 패널 다음에 두는 쪽이 유지보수상 자연스럽다

쉽게 말하면:

- 버튼은 3번째 줄 첫 칸
- 패널 코드는 댓글 방어 근처

## 2. `popup/popup.js`

추가할 것:

1. `DIRTY_FEATURES.bumpPost`
2. `FEATURE_DOM.bumpPost`
3. `bindConfigDirtyTracking('bumpPost')`
4. `getFeatureConfigInputs('bumpPost')`
5. toggle/start/stop handler
6. saveConfig handler
7. resetStats handler
8. `updateBumpPostUI(status)`
9. `applyStatuses()` 연결
10. `flashSaved(dom.saveConfigBtn)` 성공 피드백 재사용

권장 입력값 읽기:

```js
postNo
durationMinutes
intervalMinutes
```

그리고 ON 핸들러는 start 전에 아래를 먼저 확인해야 한다.

1. `DIRTY_FEATURES.bumpPost === true`면 저장 먼저 요구
2. `postNo`가 비어 있거나 숫자가 아니면 시작 거부

즉 기존 feature들처럼 **저장 안 한 입력값으로 바로 시작하지 않게** 막아야 한다.

### 실행 중 수정 정책

이 feature는 **실행 중 대상 글 번호/주기/지속시간이 바뀌면 의미가 크게 바뀌는 기능**이라서,
실행 중 `updateConfig`는 막는 게 맞다.

즉 popup에서도:

- 실행 중이면 입력창 + 저장 버튼 disable

background에서도:

- 실행 중 config 변경 거부

둘 다 들어가야 한다.

중요한 점:

현재 `applyAutomationLocks()`는 주로 feature 간 충돌 락만 다룬다.

즉 새 feature가 **자기 자신이 실행 중일 때 자기 입력을 잠그는 것**은 자동으로 안 된다.

그래서 새 feature는 아래 두 경로를 같이 가져가야 한다.

1. background `getConfigUpdateBlockMessage()`에서 실행 중 저장 거부
2. `updateBumpPostUI()`에서 `status.isRunning`이면 입력창/저장 버튼 disable


## background 구현 상세

## 1. `background/background.js`

추가할 것:

1. import
2. `const bumpPostScheduler = new BumpPostScheduler();`
3. `schedulers.bumpPost = bumpPostScheduler`
4. `loadSchedulerStateIfIdle(schedulers.bumpPost)`
5. `resumeStandaloneScheduler(schedulers.bumpPost, '...복원')`
6. `getAllStatuses()`에 `bumpPost`
7. `updateConfig` normalize branch
8. `resetSchedulerStats('bumpPost')`
9. `applySharedConfig()`에서 galleryId 변경 시 반영/reset
10. `getBusyFeatures()`에 포함
11. `getAllStatuses()`에 `bumpPost` 노출

### monitor/manual lock

권장 판단:

- 이 feature는 `monitor`, `ip`, `uidWarningAutoBan`처럼 특별 충돌 락을 둘 필요는 없다
- 이유는 분류/삭제/차단처럼 정책 충돌을 만드는 기능이 아니라 **단일 끌올 POST 요청 반복 기능**이기 때문이다

즉:

- 강한 manual lock은 추가하지 않음
- 대신 **요청 직렬화는 broker lease**에 맡긴다

쉽게 말하면:

- `monitor`나 `ip`처럼 정책 충돌을 만드는 기능은 아니라서
- `감시 자동화 실행 중에는 못 켠다` 같은 별도 락은 필요 없고
- 세션 요청만 직렬화하면 된다

### resetStats

새 feature는 최소한 아래를 지워야 한다.

- `cycleCount`
- `logs`
- `totalBumpedCount`
- `totalFailedCount`
- `lastBumpedAt`
- `lastErrorAt`
- `lastErrorMessage`
- `lastBumpedPostNo`

### gallery 변경

공통 갤러리 변경 시:

1. `config.galleryId` 갱신
2. `config.postNo`를 빈값으로 정리
3. 현재 실행 상태/통계/log reset

이 패턴을 따라야 한다.

이유:

- 글 번호는 갤러리와 세트 의미라서
- 갤러리가 바뀌면 기존 `postNo`는 다른 대상이 될 수 있다

즉 갤러리 변경 시에는 **안전하게 상태 reset**이 맞다.


## 기존 기능 안 깨는 구현 원칙

### 원칙 1. 기존 feature와 공용 API를 억지로 섞지 않는다

끌올은 기존 `post`, `ip`, `uidWarningAutoBan`과 목적이 다르다.

즉:

- `post/api.js`에 끼워 넣기보다
- **`features/bump-post/api.js` 별도 파일**로 가는 게 맞다

### 원칙 2. shared config는 gallery만 공유한다

이 feature가 공용으로 따라가야 하는 값은:

- `galleryId`
- `galleryType`
- `baseUrl`

정도다.

`headtextId`는 전혀 필요 없다.

쉽게 말하면:

- 도배기 탭 번호가 바뀌어도 이 기능 의미는 안 바뀐다
- 갤러리만 바뀌면 대상 글 번호 의미가 달라지므로 그때만 reset이 필요하다

### 원칙 3. 실행 중 설정 변경은 막는다

예시:

- 현재 `1087122 / 60 / 1`로 돌고 있는데
- 실행 중에 `1090000 / 180 / 5`로 저장

이런 건 사용자가 의도했는지 애매하고, runtime도 헷갈린다.

그래서:

- 실행 중 설정 변경 금지
- 바꾸려면 OFF 후 저장 후 ON

으로 가는 게 맞다.

### 원칙 4. 통계 초기화는 스케줄을 건드리지 않는다

이 기능은 다른 수동 feature와 달리 `끝나는 시각` 자체가 동작 의미다.

즉 resetStats가:

- `startedAt`
- `endsAt`
- `nextRunAt`

까지 지워버리면 실행 중 스케줄이 깨진다.

그래서 새 feature는 **resetStats가 기록만 지우고 예약은 유지**하는 쪽으로 분리해야 한다.

### 원칙 5. 응답 body를 과신하지 않는다

현재 스펙은 body shape가 불명확하다.

그래서:

- JSON 파싱 전제 금지
- status + 에러 키워드 기반 판정

으로 가야 한다.


## 예상 edge case

1. `postNo`가 비어 있음
2. `postNo`에 숫자 아닌 문자가 섞임
3. `durationMinutes=0`
4. `intervalMinutes=0`
5. `intervalMinutes > durationMinutes`
6. 시작 직후 즉시 1회는 성공했지만 다음 예약은 종료시각을 넘음
7. `ci_c` 쿠키 없음
8. 403 응답
9. 429 응답
10. 네트워크 오류
11. 서비스 워커 재시작 후 복원
12. 복원 시 `endsAt` 이미 만료
13. popup 닫았다 다시 열어도 상태 유지
14. gallery 변경 시 자동 reset
15. shared config 저장 중 새 feature가 busy feature 목록에 포함되는지
16. 실행 중 설정 저장이 거부되는지
17. ON 연타 시 중복 run loop 안 생기는지
18. OFF 직후 waiting timer가 남지 않는지
19. 실패 로그가 너무 길지 않은지
20. 요청이 오래 걸려도 다음 주기와 겹치지 않는지


## 실제 구현 순서 권장

1. `features/bump-post/api.js`
2. `features/bump-post/scheduler.js`
3. `background/background.js` 등록/상태/reset/shared config 연결
4. `popup/popup.html` 탭/패널 추가
5. `popup/popup.js` DOM/save/reset/status wiring
6. `popup/popup.css` 필요 시 색상 변수/미세 스타일 추가
7. 정적 검증
8. 실제 수동 테스트


## 정적 검증 체크리스트

구현 후 최소 확인 항목:

1. `node --check`
   - `features/bump-post/api.js`
   - `features/bump-post/scheduler.js`
   - `background/background.js`
   - `popup/popup.js`
2. `git diff --check`
3. `npm`/브라우저 없이 가능한 순수 scheduler 시뮬레이션
4. start 직후 즉시 1회 실행 확인
5. interval 반복 확인
6. duration 만료 후 자동 stop 확인
7. save/load 복원 확인
8. gallery 변경 reset 확인
9. 실행 중 설정 변경 거부 확인
10. `ci_t` 없음 / 403 / 429 / network 오류 로그 분기 확인


## 최종 판단

현재 코드베이스 기준으로 이 기능은 **새 standalone scheduler로 추가하는 게 가장 안전하고**, 실제 구현도 바로 들어갈 수 있다.

핵심은 세 가지다.

1. **`update_bump`는 별도 API 모듈로 분리**
2. **start 즉시 1회 + interval 반복 + duration 만료 자동 정지**
3. **popup 저장/복원/background shared reset까지 기존 feature 패턴을 그대로 재사용**

쉽게 말하면:

- 새 기능 하나를 독립 탭으로 추가하되
- 세션/저장/복원은 지금 프로젝트 방식 그대로 따라가면 된다
- 즉 **문서 기준 바로 구현 들어갈 수 있는 상태**다
