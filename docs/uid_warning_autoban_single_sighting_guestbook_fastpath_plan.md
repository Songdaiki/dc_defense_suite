# 분탕자동차단 단일발견 깡계 fast-path 구현 플랜

## 목표

지금 `분탕자동차단`은 이미 두 갈래로 돈다.

1. **제목 직차단 fast-path**
   - 금칙 제목이 정규화 후 포함 매치되면 즉시 차단/삭제
2. **기존 uid burst 깡계 차단**
   - page 1 같은 `uid` 텍스트글 5분 burst 2글 이상
   - 자음 2글자 닉네임
   - `effectivePostRatio >= 90`
   - 갤로그 `게시글 비공개 + 댓글 비공개`

이번 작업은 이 두 갈래를 그대로 유지하고, **세 번째 갈래를 하나 더 추가**하는 것이다.

### 새로 추가할 갈래

**단일발견 깡계 fast-path**

조건:

1. page 1에 같은 `uid` 글이 1개 이상 보임
2. 닉네임이 자음 2글자
3. `effectivePostRatio >= 90`
4. `totalActivityCount < 20`
5. 갤로그가
   - 게시글 비공개
   - 댓글 비공개
   - 방명록 잠금

이 다 맞으면 **5분 burst 2글을 기다리지 않고 바로 차단/삭제**한다.

쉽게 예시로:

- `ㅇㅇ(uid123)`
- page 1에 글 1개만 있음
- 글 5 / 댓글 1 -> 총합 6
- 보정 글비중 100%
- 게시글 비공개
- 댓글 비공개
- 방명록 잠금
- -> **새 fast-path로 바로 차단/삭제**

반대로:

- `ㅇㅇ(uid999)`
- 글 1개
- 보정 글비중 95%
- 게시글/댓글 비공개
- **방명록 공개**
- -> **새 fast-path 미달**

또 예시:

- `ㅇㄴ(uid777)`
- 글 1개
- 보정 글비중 100%
- 게시글/댓글/방명록 잠금
- **글댓 총합 24**
- -> **새 fast-path 미달**

즉 한 줄로:

- 기존 `5분 2글` 로직은 그대로 둔다
- 대신 **글 1개만 보여도 너무 수상한 깡계는 바로 자르는 세 번째 갈래**를 추가한다

---

## 현재 실제 로직 교차검증

### 1. 현재 분탕자동차단은 이미 2갈래 구조다

실제 `runCycle()` 흐름:

1. page 1 HTML fetch
2. **제목 직차단 fast-path** 먼저 실행
3. 제목 직차단이 처리한 `postNo`는 uid 경로에서 제외
4. 남은 uid row만 기존 burst 로직으로 처리

관련 코드:

- scheduler 진입: [features/uid-warning-autoban/scheduler.js](../features/uid-warning-autoban/scheduler.js)
- 제목 직차단 선행: [features/uid-warning-autoban/scheduler.js](../features/uid-warning-autoban/scheduler.js)
- uid row 필터링: [features/uid-warning-autoban/scheduler.js](../features/uid-warning-autoban/scheduler.js)

즉 새 갈래를 넣을 위치는 **제목 직차단 뒤, 기존 burst 판단 앞**이 가장 안전하다.

### 2. 현재 갤로그 비공개 판단은 `게시글/댓글`만 본다

현재 `parseGallogPrivacy()`는 아래만 반환한다.

- `postingPublic`
- `commentPublic`
- `postingPrivate`
- `commentPrivate`
- `fullyPrivate`

즉 현재 `fullyPrivate` 의미는 **게시글 비공개 + 댓글 비공개** 뿐이다.

관련 코드:

- [features/uid-warning-autoban/parser.js](../features/uid-warning-autoban/parser.js)
- [background/uid-gallog-privacy-cache.js](../background/uid-gallog-privacy-cache.js)

이 말은 곧:

- **기존 burst 경로는 지금도 게시글/댓글만 보고 있다**
- 여기에 방명록까지 끼워 넣으면 **기존 동작 의미가 바뀐다**

그래서 새 기능은 `fullyPrivate`를 덮어쓰기보다, **방명록 잠금 전용 플래그를 별도로 추가**하는 게 맞다.

### 2-1. 현재 gallog fetch는 `/{uid}` 한 장만 읽는다

현재 캐시 경로는:

1. `fetchGallogHomeHtml(config, uid)` 호출
2. `https://gallog.dcinside.com/{uid}` HTML 1장 fetch
3. `parseGallogPrivacy(html)`로 게시글/댓글 상태만 파싱

관련 코드:

- [features/uid-warning-autoban/api.js](../features/uid-warning-autoban/api.js)
- [background/uid-gallog-privacy-cache.js](../background/uid-gallog-privacy-cache.js)

즉 지금 구조는 **홈 1장만 읽는 구조**다.

그런데 이번에 확인한 방명록 잠금 샘플은 `docs/html.md`, `docs/html(분탕).md` 기준으로
`guestbook` 페이지 마크업이다.

쉽게 말하면:

- 현재 burst 경로는 `/{uid}` 한 장만 읽음
- 방명록 잠금 확인은 사실상 `/{uid}/guestbook` 정보가 필요함

즉 이번 기능은 구현할 때 아래 둘 중 하나를 선택해야 한다.

1. `fetchGallogHomeHtml()`를 방명록까지 다 보는 통합 fetch로 바꾸기
2. **방명록 전용 fetch를 별도로 추가하기**

여기서 기존 기능 안 깨는 쪽은 **2번**이다.

이유:

- 기존 burst 경로는 게시글/댓글 비공개만 필요함
- 여기에 방명록 page fetch를 억지로 같이 붙이면
  - 기존 burst 경로도 매번 추가 요청 1번이 늘어남
  - 즉 기존 기능이 불필요하게 무거워진다

그래서 문서 기준 권장안은:

- 기존 `getOrFetchUidGallogPrivacy()`는 그대로 유지
- 새로 `getOrFetchUidGallogGuestbookState()`를 추가
- **단일발견 깡계 fast-path에서만** guestbook fetch를 추가로 호출

즉 한 줄로:

- **방명록은 기존 gallog privacy fetch에 억지로 붙이지 말고, 새 fast-path 전용 fetch/cache로 분리하는 게 맞다**

### 2-2. host permission은 이미 있다

현재 manifest에는 이미 아래 권한이 있다.

- `https://gallog.dcinside.com/*`

즉 `/{uid}/guestbook` fetch를 추가해도 **새 host permission은 필요 없다.**

관련 파일:

- [manifest.json](../manifest.json)

쉽게 말하면:

- 이번 기능 때문에 권한 문제로 막히는 건 아니다
- **새로 필요한 건 fetch 함수와 cache helper 추가뿐**이다

### 3. 현재 활동 통계에는 raw 총합과 보정 총합이 둘 다 있다

실제 활동 통계 응답에는:

- `postCount`
- `commentCount`
- `totalActivityCount`
- `effectiveCommentCount`
- `effectiveTotalActivityCount`
- `effectivePostRatio`

가 있다.

관련 코드:

- [features/semi-post/api.js](../features/semi-post/api.js)

이번 새 fast-path의 `글댓총합20미만`은 이름 그대로 **raw 총합 `totalActivityCount < 20`** 으로 가는 게 맞다.

쉽게 예시로:

- 글 18 / 댓글 1 -> 총합 19 -> 통과
- 글 18 / 댓글 3 -> 총합 21 -> 미달

여기서 `effectiveTotalActivityCount`를 쓰면 댓글 2개 차감 때문에 의미가 달라지므로, **총합 상한은 raw 총합을 써야 한다.**

---

## 방명록 잠금 마크업 확인

실제 `docs/html.md`와 `docs/html(분탕).md`를 비교한 결과, 방명록은 게시글/댓글처럼 `bluebox/greybox 공개/비공개` 배지로만 보기보다 **작성 폼 존재 여부와 안내 문구**로 구분하는 게 더 안전하다.

중요한 점:

- 이 샘플들은 `guestbook` 페이지 마크업이다
- 즉 구현은 `/{uid}/guestbook` HTML을 기준으로 해야 한다

### 공개/작성 가능 예시

`docs/html.md` 기준:

- 방명록 메뉴 존재: [docs/html.md](./html.md)
- 방명록 작성 폼 존재:
  - `<form name="gb_form" id="gb_form" ...>`
  - `<textarea name="memo"></textarea>`
  - `등록` 버튼

쉽게 말하면:

- **작성 폼이 보이면 방명록 공개/작성 가능**

### 잠금 예시

`docs/html(분탕).md` 기준:

- 방명록 영역에 아래 문구가 뜬다
  - `허용된 사용자만 방명록을 작성할 수 있습니다.`
- 작성 폼은 없다

핵심 위치:

- [docs/html(분탕).md](./html(분탕).md)

쉽게 말하면:

- **작성 폼이 없고 저 문구가 있으면 방명록 잠금**

### 구현 결론

방명록 판별은 이렇게 두는 게 맞다.

1. `guestbookLocked === true`
   - `허용된 사용자만 방명록을 작성할 수 있습니다.` 문구 존재
2. `guestbookWritable === true`
   - `form#gb_form` 또는 `form[name="gb_form"]` 존재
3. 둘 다 못 잡으면 `success: false`로 두지 말고, 최소한 `guestbookLocked: false`, `guestbookWritable: false`, `guestbookStateKnown: false`처럼 구분할 수 있게 한다

이유:

- 방명록은 게시글/댓글처럼 배지 구조가 아니라서, **잠금 / 작성 가능 / 미확인**을 따로 관리하는 게 안전하다.

---

## 기존 기능을 안 깨는 구현 원칙

### 원칙 1. `fullyPrivate` 의미는 바꾸지 않는다

현재 burst 깡계 조건은 `fullyPrivate === true`를 사용한다.

이걸 `게시글 + 댓글 + 방명록`으로 바꿔버리면:

- 기존 5분 2글 조건이 갑자기 더 엄격해짐
- 즉 **기존 기능이 바뀌어 버린다**

그래서 이렇게 가야 한다.

- 기존 `fullyPrivate`
  - 그대로 `게시글 비공개 + 댓글 비공개`
- 새 필드 추가
  - `guestbookLocked`
  - `guestbookWritable`
  - `fullyPrivateWithGuestbookLocked`

즉 예시:

- 기존 burst 경로: `fullyPrivate` 사용 그대로
- 새 단일발견 경로: `fullyPrivateWithGuestbookLocked` 사용

### 원칙 2. 제목 직차단은 그대로 먼저 돈다

현재 제목 직차단은 uid가 있든 없든 먼저 처리한다.

즉 새 단일발견 깡계 fast-path는:

1. 제목 직차단 뒤
2. 같은 cycle에서 제목 직차단으로 처리되지 않은 uid row만 대상으로
3. 추가 판정

이 순서여야 한다.

안 그러면 예시:

- 제목 금칙어로 이미 잘린 글을
- 단일발견 경로가 또 보게 되어
- 같은 글 중복 제재가 꼬일 수 있다.

### 원칙 3. 기존 burst 경로 우선순위를 유지한다

새 fast-path는 **기존 5분 2글을 대체하는 게 아니라 보강**이다.

그래서 우선순위는 이렇게 두는 게 안전하다.

1. 제목 직차단
2. 기존 burst 조건 확인
3. burst가 안 맞는 uid에 한해 단일발견 깡계 fast-path 확인

쉽게 예시로:

- 같은 uid가 이미 5분 2글 burst를 만족하면
  - **예전 경로 그대로 burst 차단**
- burst는 안 맞지만
  - 방명록까지 잠긴 깡계면
  - **새 fast-path로 차단**

즉 기존꺼를 안 바꾸고, **기존에 못 잡던 케이스만 새 경로가 받는 구조**다.

### 원칙 4. 새 fast-path dedupe는 기존 `recentUidActions`를 재사용한다

현재 uid autoban은 `galleryId::uid` 단위로

- `lastNewestPostNo`
- `lastActionAt`
- `success`

를 저장하고, 같은 `newestPostNo`면 재시도를 건너뛴다.

관련 코드:

- [features/uid-warning-autoban/scheduler.js](../features/uid-warning-autoban/scheduler.js)

이번 새 fast-path도 어차피 **uid 기반**이므로,
제목 직차단처럼 별도 `postNo` dedupe를 새로 만들기보다 **기존 `recentUidActions`를 같이 쓰는 게 맞다.**

쉽게 예시로:

- `uid123` 글 1개가 새 fast-path로 제재됨
- 다음 1분 poll에도 같은 글 1개만 그대로 남아 있음
- 이때 `recentUidActions`를 재사용하면 **같은 newest post no라 재제재 안 함**

즉:

- 제목 직차단: `recentImmediatePostActions`
- uid burst / 단일발견 fast-path: `recentUidActions`

이렇게 가는 게 가장 자연스럽다.

---

## 최종 플로우

### 전체 3갈래 구조

1. **제목 직차단 fast-path**
   - 금칙 제목 포함 매치
   - 즉시 차단/삭제

2. **기존 burst 깡계 차단**
   - page 1 같은 uid 텍스트글 5분 2개 이상
   - 자음 2글자
   - `effectivePostRatio >= 90`
   - 갤로그 `게시글 비공개 + 댓글 비공개`
   - 즉시 차단/삭제

3. **단일발견 깡계 fast-path**
   - page 1 같은 uid 글 1개 이상
   - 자음 2글자
   - `effectivePostRatio >= 90`
   - `totalActivityCount < 20`
   - 갤로그 `게시글 비공개 + 댓글 비공개 + 방명록 잠금`
   - 즉시 차단/삭제

### 실제 순서

1. page 1 HTML fetch
2. 제목 직차단 fast-path
3. 제목 직차단으로 처리된 `postNo` 제외
4. uid row 그룹핑
5. 각 uid마다
   - 자음 2글자 닉네임 확인
   - 5분 burst 계산
6. burst 통과면 기존 burst 경로 처리
7. burst 미통과면
   - stats 조회
   - `effectivePostRatio >= 90`
   - `totalActivityCount < 20`
   - gallog privacy 조회
   - `postingPrivate && commentPrivate && guestbookLocked`
   - 맞으면 단일발견 경로 처리
8. 둘 다 아니면 스킵

쉽게 예시로:

- `uid-a`
  - 제목 금칙어 글 1개
  - -> 1번 경로
- `uid-b`
  - 5분에 텍스트글 2개
  - -> 2번 경로
- `uid-c`
  - 글 1개만 있음
  - 자음2글자, 글비중 95, 총합 8, 게시글/댓글/방명록 잠금
  - -> 3번 경로

---

## 실제 코드 변경 포인트

## 1. `features/uid-warning-autoban/parser.js`

### 추가할 것

1. `parseGallogPrivacy()` 확장
   - 기존 반환값 유지
   - 아래 필드 추가

```js
guestbookLocked
guestbookWritable
guestbookStateKnown
fullyPrivateWithGuestbookLocked
```

2. 방명록 잠금 판별 helper 추가

예시:

- `extractGuestbookAccessState(html)`
  - `form#gb_form` 있으면 `guestbookWritable = true`
  - `허용된 사용자만 방명록을 작성할 수 있습니다.` 있으면 `guestbookLocked = true`

### 왜 필요한가

- 현재 parser는 게시글/댓글 배지만 본다
- 방명록은 다른 마크업이므로 별도 helper가 필요하다

## 2. `background/uid-gallog-privacy-cache.js`

### 추가할 것

cache fallback shape에 새 필드 추가:

```js
guestbookLocked: false,
guestbookWritable: false,
guestbookStateKnown: false,
fullyPrivateWithGuestbookLocked: false,
```

### 왜 필요한가

- scheduler에서 새 fast-path가 이 필드를 바로 보기 때문
- cache miss/failure 기본 shape도 맞춰야 호출부에서 조건문이 안전하다

### 수정 방향 보정

하지만 위 방식으로 기존 cache helper 자체를 확장하면, 기존 burst 경로도 방명록 fetch를 같이 하게 될 수 있다.

그래서 실제 구현 권장안은 아래처럼 분리한다.

1. 기존 [background/uid-gallog-privacy-cache.js](../background/uid-gallog-privacy-cache.js)
   - 그대로 유지
   - `/{uid}` 1장만 읽고 게시글/댓글 비공개만 관리
2. 새 guestbook 전용 cache helper 추가
   - 예: `background/uid-gallog-guestbook-cache.js`
   - `/{uid}/guestbook` fetch
   - `guestbookLocked/guestbookWritable/guestbookStateKnown` 관리

즉:

- **기존 cache helper를 바꾸는 것보다 새 helper를 추가하는 쪽이 기존 흐름을 덜 건드린다**

### 새 helper 권장 시그니처

예시:

```js
async function getOrFetchUidGallogGuestbookState(config = {}, uid = '')
```

반환 shape 예시:

```js
{
  success: true,
  guestbookLocked: true,
  guestbookWritable: false,
  guestbookStateKnown: true,
}
```

실패 fallback 예시:

```js
{
  success: false,
  message: '방명록 상태 파싱 실패',
  guestbookLocked: false,
  guestbookWritable: false,
  guestbookStateKnown: false,
}
```

## 3. `features/uid-warning-autoban/scheduler.js`

### 추가할 것

기존 `runCycle()` uid loop 안에 **단일발견 깡계 fast-path** 분기 추가.

권장 순서:

1. `countableRows` 계산
2. `recentRows` 계산
3. 대표 닉네임 자음2글자 확인
4. `isBurstCandidate = recentRows.length >= threshold`
5. `isSingleSightCandidate = !isBurstCandidate`
6. stats 1회 조회
7. `effectivePostRatio >= 90` 확인
8. `totalActivityCount < 20` 확인
9. 기존 gallog privacy 1회 조회
10. burst면 기존 경로
11. burst는 아니고, `postingPrivate && commentPrivate`가 맞을 때만
12. guestbook state 1회 조회
13. `guestbookLocked === true`면 새 경로
14. 성공/실패 결과를 기존 `recentUidActions[actionKey]`에 기록

### 왜 이렇게 해야 하나

- 같은 uid에 대해 stats/gallog fetch를 중복으로 두 번 하지 않기 위해서
- 기존 burst 경로 우선순위를 유지하기 위해서
- **방명록 fetch를 burst 경로 전체에 강제로 얹지 않기 위해서**
- **같은 단일발견 uid를 다음 cycle에서 또 치지 않기 위해서**

### 새 로그

예시:

- `ℹ️ uid123 스킵 - 글댓총합 24라 단일발견 기준 20 미만 초과`
- `ℹ️ uid123 스킵 - 단일발견 갤로그 필터 미달 (게시글 비공개 / 댓글 비공개 / 방명록 공개)`
- `⚠️ uid123 방명록 잠금 확인 실패 - guestbook page 파싱 실패`
- `🚨 uid123 단일발견 깡계 fast-path / 글비중 100% / 총합 6 / 갤로그 게시글·댓글 비공개 + 방명록 잠금 -> page1 1개 제재 시작`
- `⛔ uid123 단일발견 깡계 글 1개 차단/삭제 완료`

### 새 상태값

uid burst 상태와 섞이지 않게 별도 메타 추가 권장.

예시:

```js
lastSingleSightTriggeredUid
lastSingleSightTriggeredPostCount
totalSingleSightTriggeredUidCount
totalSingleSightBannedPostCount
```

최소 구현으로는 로그만 추가하고 총합 카운트는 공용 `totalBannedPostCount`에 합쳐도 되지만,
popup에서 보기 쉽게 하려면 별도 수치가 더 낫다.

### 상태 저장/초기화 영향

현재 `uidWarningAutoBan`은 이미 아래를 저장/복원한다.

- `lastTriggeredUid`
- `lastTriggeredPostCount`
- `lastBurstRecentCount`
- `recentUidActions`
- `recentImmediatePostActions`

그리고 `resetStats`도 이 상태들을 지운다.

관련 코드:

- [features/uid-warning-autoban/scheduler.js](../features/uid-warning-autoban/scheduler.js)
- [background/background.js](../background/background.js)

즉 새 fast-path 메타를 추가하면:

1. `saveState()`
2. `loadState()`
3. `getStatus()`
4. `resetStats()`

네 군데를 같이 맞춰야 한다.

## 4. `popup/popup.html` / `popup/popup.js`

이번 기능은 사용자 입력 설정이 아니라 고정 조건이므로 **새 입력 UI는 없어도 된다.**

대신 아래는 같이 맞추는 게 좋다.

1. 메타 문구 업데이트
   - 현재는 제목 직차단 + burst 깡계만 설명함
   - 여기에 `단일발견 깡계 fast-path`도 설명 추가

2. 상태값 추가 시 표시 영역 연결
   - 최근 단일발견 uid
   - 누적 단일발견 제재

쉽게 예시로:

현재:
- `금칙 제목 포함 매치 즉시 차단 + 5분 2글 깡계 차단`

패치 후:
- `금칙 제목 포함 매치 즉시 차단 + 5분 2글 깡계 차단 + 방명록까지 잠긴 저활동 깡계 즉시 차단`

---

## 성능/파생 영향 검토

## 1. page 1 fetch는 늘지 않는다

기존에도 page 1 HTML은 1분마다 한 번 받고 있었다.

즉 새 기능 추가로:

- board fetch 추가 없음
- page 2/3 fetch 추가 없음
- 제목 직차단/기존 burst/새 단일발견 fast-path 모두 이 page 1 한 장을 재사용

## 2. stats/gallog 조회는 늘 수 있다

기존에는 burst 후보 uid에 대해서만 stats/gallog를 봤다.

새 fast-path를 넣으면:

- burst 미통과지만
- 자음2글자 닉네임인 uid

에 대해서도 stats/gallog를 볼 수 있다.

즉 예시:

- page 1에 `ㅇㅇ`, `ㅇㄴ`, `ㅋㅋ` uid가 여러 명 있으면
- 이전보다 stats/gallog 확인 대상 수는 늘 수 있다.

다만 완충 장치는 있다.

- page 1 only
- 자음2글자 선필터
- uid stats cache 있음
- gallog privacy cache 있음
- guestbook state도 별도 cache를 두면 반복 fetch를 완충 가능

추가로 중요한 점:

- 새 guestbook fetch는 **burst 미통과 + ratio 통과 + totalActivityCount 20 미만 + 게시글/댓글 비공개**
  까지 온 uid에 대해서만 호출해야 한다

쉽게 예시로:

- `ㅇㅇ` uid가 page 1에 10명 있어도
- 그중 글비중 40%인 애들은 guestbook fetch까지 가지 않음

즉 guestbook fetch를 최대한 뒤로 미뤄야 불필요한 추가 요청을 줄일 수 있다.

즉 **성능 증가는 있지만, 구조상 감당 못 할 정도의 변화는 아니다.**

## 3. 기존 burst 경로 의미는 안 바뀐다

이건 가장 중요하다.

- 기존 `fullyPrivate`는 그대로
- 기존 burst 조건 그대로
- 새 fast-path는 **burst 미통과 uid만 보강**

즉 기존 기능을 덮어쓰는 게 아니라, **패턴 바뀐 깡계를 잡는 보조 경로**다.

---

## 구현 후 반드시 확인할 정적 검증 포인트

1. 방명록 공개 gallog에서 `guestbookWritable === true`
2. 방명록 잠금 gallog에서 `guestbookLocked === true`
3. 게시글/댓글만 비공개고 방명록 공개면 `fullyPrivateWithGuestbookLocked === false`
4. 게시글/댓글/방명록 모두 잠기면 `fullyPrivateWithGuestbookLocked === true`
5. 기존 burst 경로는 여전히 `fullyPrivate`만 보고 동작하는지
6. guestbook state는 `/{uid}/guestbook`에서만 파싱하는지
7. 기존 burst 경로는 guestbook fetch를 추가로 안 하는지
8. 새 fast-path가 제목 직차단 뒤에 실행되는지
9. 제목 직차단된 `postNo`는 새 fast-path에서도 안 보는지
10. burst 통과 uid는 기존 경로만 타고 새 fast-path로 이중 처리 안 되는지
11. burst 미통과 uid만 새 fast-path 후보가 되는지
12. `totalActivityCount < 20` raw 총합 기준이 맞는지
13. `effectivePostRatio >= 90`는 기존 보정 비율을 그대로 쓰는지
14. 방명록 상태 파싱 실패면 새 fast-path는 보수적으로 스킵하는지
15. guestbook cache miss/failure shape가 안전한지
16. popup 메타 문구가 새 경로 설명까지 반영되는지
17. resetStats 시 새 상태값도 같이 지워지는지
18. 단일발견 fast-path 성공 후 `recentUidActions`가 기록되어 다음 cycle 중복 제재를 막는지
19. host permission 추가 없이 `/{uid}/guestbook` fetch가 실제로 가능한지

---

## 교차검증 결론

지금 실제 코드와 마크업을 기준으로 보면, 이 기능은 **기존 2갈래를 안 깨고 3번째 갈래로 추가 가능**하다.

핵심 판단은 이거다.

1. 방명록 잠금은 실제 HTML에서 구분 가능하다.
   - 공개: 작성 폼 존재
   - 잠금: `허용된 사용자만 방명록을 작성할 수 있습니다.` 문구
2. 기존 `fullyPrivate`를 바꾸면 안 된다.
   - 기존 burst 기능 의미가 바뀌기 때문
3. 방명록 상태는 현재 `/{uid}` 한 장 fetch로는 부족하고, **`/{uid}/guestbook` 전용 fetch/cache로 분리하는 게 맞다.**
4. 새 fast-path는 **제목 직차단 뒤, 기존 burst 앞/옆 보강 경로**로 넣는 게 맞다.
5. `글댓총합20미만`은 raw `totalActivityCount < 20`으로 가는 게 맞다.
6. dedupe는 새로 만들기보다 기존 `recentUidActions`를 재사용하는 게 맞다.

한 줄로 최종 정리하면:

- **기존 제목 직차단 유지**
- **기존 5분 2글 burst 유지**
- **추가로 `page1 1글 + 자음2글자 + 글비중90+ + 게시글/댓글 비공개 + 방명록 잠금 + 총합20미만`이면 바로 자르는 세 번째 fast-path를 넣되, 방명록은 `/{uid}/guestbook` 전용 fetch/cache로 분리하는 설계가 가장 안전하다**
