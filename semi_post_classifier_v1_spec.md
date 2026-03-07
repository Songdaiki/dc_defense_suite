# DC Defense Suite - 반고닉 도배기 분류기 수동 v1 구현 스펙

## 1. 목표

이 문서는 `DC Defense Suite`에 `반고닉 도배기 분류기` 수동 v1 기능을 추가하기 위한 구현 스펙이다.

목표는 다음과 같다.

- 게시글 목록을 페이지 범위 기준으로 수동 순회한다.
- 작성자 `식별코드(data-uid)`가 있는 게시물만 후보로 본다.
- 후보 작성자별 누적 `글 수 / 댓글 수`를 조회한다.
- `게시물 비율`이 비정상적으로 높은 작성자를 도배기 후보로 판정한다.
- 판정된 작성자가 쓴 게시물을 기존 `도배기탭(headtextId)`으로 자동 분류한다.

v1은 `자동 감시`가 아니라 `수동 토글 기반 분류기`다.

즉 구조는 다음과 같다.

- 시작/정지: 사용자가 직접 토글
- 스캔 대상: `minPage ~ maxPage`
- 판정 기준: `식별코드 작성자 누적 게시물 비율`
- 대응: 기존 게시글 분류 API 재사용

---

## 2. v1에서 반고닉의 정의

v1은 디시 내부의 엄밀한 고닉/반고닉 구분을 시도하지 않는다.

대신 **목록 row에 `data-uid`가 존재하는 작성자**를 `식별코드 작성자`로 취급하고, 이 집합을 v1 대상군으로 본다.

이유:

- 현재 확보된 목록 HTML에는 `data-uid`, `data-nick`, `data-ip`가 들어간다.
- 반고닉/식별코드 기반 작성자 추적은 `data-uid`가 핵심이다.
- 운영 목적상 필요한 것은 “IP 유동이 아닌, 식별 가능한 작성자”를 추적하는 것이므로 v1에서는 이 수준으로 충분하다.

즉 v1 후보 조건은 다음과 같다.

- `data-uid !== ''`
- `게시물 번호가 있는 일반 row`
- 이미 `도배기` 탭인 글은 제외

주의:

- v1은 `data-uid`가 있는 모든 작성자를 대상으로 하므로, 후속 버전에서 필요하면 `고닉/반고닉 세부 구분` 필터를 추가할 수 있다.

---

## 3. 현재 코드/실페이지 기준으로 확인된 사실

이 섹션은 실제 구현에 필요한 전제 중 이미 확인된 사실만 정리한다.

### 3.1 게시글 목록 HTML에서 확보 가능한 값

현재 목록 HTML의 작성자 셀은 아래 형태를 가진다.

```html
<td class="gall_writer ub-writer" data-nick="특갤전용기계" data-uid="near1254" data-ip="" data-loc="list">
```

즉 목록 HTML만으로 다음 값은 이미 얻을 수 있다.

- `nick`
- `uid`
- `ip`

현재 `features/post/parser.js`는 `uid`를 아직 반환하지 않지만, HTML상 값은 존재한다.

### 3.2 기존 게시글 분류 API는 그대로 재사용 가능

현재 `features/post/api.js`의 `classifyPosts(config, postNos)`는 아래 API를 사용한다.

- `POST /ajax/minor_manager_board_ajax/chg_headtext_batch`

body 핵심 필드:

- `ci_t`
- `id`
- `_GALLTYPE_=M`
- `headtext=<도배기탭 번호>`
- `nos[]`

즉 반고닉 분류기는 **판정만 새로 만들고**, 실제 분류는 기존 `classifyPosts()`를 그대로 재사용하면 된다.

### 3.3 작성자 클릭 레이어는 별도 API로 글/댓글 수를 가져온다

실페이지 공용 스크립트 `https://gall.dcinside.com/_js/common.js?v=250515` 기준으로, 작성자 클릭 레이어는 아래 요청을 보낸다.

- `POST /api/gallog_user_layer/gallog_content_reple/`

요청 파라미터:

- `ci_t = ci_c 쿠키값`
- `user_id = data-uid`

응답 처리 방식:

```js
var tempData = data.split(',');
tempData[0] // 글 수
tempData[1] // 댓글 수
```

즉 반고닉 분류기 v1은 **작성자 클릭 UI를 흉내 낼 필요 없이**, 같은 endpoint를 직접 호출해서 `글 수 / 댓글 수`를 가져오면 된다.

---

## 4. v1 정책

### 4.1 판정 기준

v1의 핵심 판정은 다음과 같다.

```txt
postRatio = postCount / (postCount + commentCount)
```

기본 판정 조건:

- `totalActivityCount >= minTotalActivityCount`
- `postRatio >= minPostRatioPercent`

기본값 추천:

- `minTotalActivityCount = 20`
- `minPostRatioPercent = 90`

예시:

- 글 `886`, 댓글 `47`
  - 총 활동 `933`
  - 게시물 비율 `94.96%`
  - 기준 `90%`면 도배기 후보
- 글 `200`, 댓글 `5`
  - 총 활동 `205`
  - 게시물 비율 `97.56%`
  - 도배기 후보
- 글 `89`, 댓글 `220`
  - 총 활동 `309`
  - 게시물 비율 `28.80%`
  - 정상 활동 가능성이 높음

### 4.2 대응 정책

v1 대응은 **도배기탭 분류**만 수행한다.

즉:

- 판정된 작성자가 쓴 현재 스캔 범위 내 게시물만
- 기존 `headtextId`의 도배기탭으로 이동

v1에서 하지 않는 것:

- 자동 감시
- 자동 IP 차단
- 차단/해제
- 글/댓글 비율 변화 추적
- 글 제목 유사도 분석

---

## 5. 전체 플로우

수동 v1 전체 플로우는 아래와 같다.

1. 사용자가 `반고닉 도배기 분류기` 토글을 켠다.
2. `minPage ~ maxPage` 목록 HTML을 순회한다.
3. 각 페이지에서 `uid`가 있는 일반 게시물만 후보로 수집한다.
4. 같은 `uid`는 한 번만 묶는다.
5. 각 `uid`에 대해 `gallog_content_reple` API를 호출한다.
6. `글 수`, `댓글 수`, `게시물 비율`을 계산한다.
7. 기준을 넘는 `uid`를 도배기 작성자로 판정한다.
8. 그 `uid`가 쓴 게시물 번호를 모은다.
9. 기존 `classifyPosts()`로 도배기탭 분류를 실행한다.
10. 다음 페이지로 이동한다.
11. 페이지 범위를 끝까지 돌면 `cycleDelay` 후 다시 시작한다.

즉 `유동 도배기 분류기(post)`와의 차이는 한 단계뿐이다.

기존 유동 분류기:

- 목록 row -> 유동 여부 판정 -> 분류

반고닉 분류기 v1:

- 목록 row -> uid 추출 -> uid 글/댓글 통계 조회 -> 비율 판정 -> 분류

---

## 6. 구현 파일 구조

### 6.1 새로 추가할 파일

- `features/semi-post/api.js`
  - `gallog_content_reple` 호출 담당
- `features/semi-post/scheduler.js`
  - 반고닉 도배기 수동 분류 메인 스케줄러

### 6.2 기존 파일 수정 대상

- `features/post/parser.js`
  - `uid` 추출 추가
  - `uid` 기준 후보 추출 함수 추가
- `background/background.js`
  - `semiPost` feature 라우팅 추가
- `popup/popup.html`
  - 새 탭/패널 추가
- `popup/popup.js`
  - 새 탭 상태/설정/토글/로그 처리
- `popup/popup.css`
  - 새 탭 스타일 추가

### 6.3 내부 feature 이름

내부 feature 이름은 `semiPost`로 고정한다.

사용자 표시명은 `반고닉 도배기` 또는 `반고닉 분류`로 붙이면 된다.

---

## 7. background 통합 구조

현재 suite는 다음 feature를 가진다.

- `comment`
- `commentMonitor`
- `post`
- `ip`
- `monitor`

v1 구현 시 아래를 추가한다.

```js
const semiPostScheduler = new SemiPostScheduler();

const schedulers = {
  comment: commentScheduler,
  commentMonitor: commentMonitorScheduler,
  post: postScheduler,
  semiPost: semiPostScheduler,
  ip: ipScheduler,
  monitor: monitorScheduler,
};
```

`semiPost`는 독립 수동 feature다.

즉:

- `monitor`의 child가 아니다.
- `commentMonitor`의 child가 아니다.
- `post`와 비슷한 독립 수동 엔진으로 취급한다.

---

## 8. parser 변경 스펙

### 8.1 현재 문제

현재 `features/post/parser.js`의 `extractWriterMeta()`는 아래만 반환한다.

```js
{
  ip,
  nick,
}
```

즉 `uid`가 빠져 있다.

### 8.2 수정 방향

`extractWriterMeta()`가 아래를 반환하도록 확장한다.

```js
{
  uid,
  ip,
  nick,
}
```

추출 방식:

```js
const uidMatch = writerTag.match(/data-uid="([^"]*)"/);
```

### 8.3 collectBoardPosts() 반환 형태 확장

기존:

```js
{
  no,
  nick,
  ip,
  isFluid,
  subject,
  currentHead,
}
```

변경 후:

```js
{
  no,
  uid,
  nick,
  ip,
  isFluid,
  hasUid,
  subject,
  currentHead,
}
```

정의:

- `hasUid = Boolean(uid)`

### 8.4 새 파서 함수

`features/post/parser.js`에 아래를 추가한다.

```js
function parseUidBearingPosts(html, targetHeadName = '도배기') {
  return collectBoardPosts(html).filter((post) => {
    if (!post.hasUid) {
      return false;
    }

    if (targetHeadName && post.currentHead.includes(targetHeadName)) {
      return false;
    }

    return true;
  });
}
```

이 함수는:

- `uid` 없는 IP 유동 제외
- 이미 `도배기` 탭인 글 제외
- 일반 게시물 row만 대상으로 함

---

## 9. gallog API 스펙

### 9.1 endpoint

- `POST /api/gallog_user_layer/gallog_content_reple/`

### 9.2 요청 파라미터

```txt
ci_t=<ci_c 쿠키값>
user_id=<data-uid>
```

### 9.3 응답 형식

현재 확인된 형식:

```txt
886,4783
```

즉:

- 첫 번째 값: `postCount`
- 두 번째 값: `commentCount`

### 9.4 파서 규칙

v1 파서는 다음처럼 구현한다.

```js
const parts = String(responseText || '').trim().split(',');
const postCount = parseInt(parts[0] || '0', 10);
const commentCount = parseInt(parts[1] || '0', 10);
```

규칙:

- 숫자 변환 실패 시 `NaN`이면 해당 uid는 실패 처리
- 음수면 실패 처리
- `postCount + commentCount === 0`이면 표본 부족으로 스킵

### 9.5 요청 헤더

v1은 기존 suite fetch 스타일을 따른다.

권장:

- `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`
- `X-Requested-With: XMLHttpRequest`
- `Referer: https://gall.dcinside.com/mgallery/board/lists/?id=<galleryId>`
- `Origin: https://gall.dcinside.com`
- `credentials: include`

### 9.6 ci_t 확보

기존 `post/api.js`가 `chrome.cookies.get({ name: 'ci_c' })`로 `ci_t`를 확보하는 구조를 이미 가지고 있으므로, `semi-post/api.js`도 같은 방식으로 구현한다.

---

## 10. Scheduler 상태 모델

### 10.1 config

`semiPost.config`

```js
{
  galleryId: 'thesingularity',
  headtextId: '130',
  minPage: 1,
  maxPage: 5,
  requestDelay: 500,
  cycleDelay: 1000,

  minTotalActivityCount: 20,
  minPostRatioPercent: 90,
}
```

설명:

- `galleryId`
  - shared config에서 동기화
- `headtextId`
  - shared config에서 동기화
- `minPage`, `maxPage`, `requestDelay`, `cycleDelay`
  - 기존 `post`와 동일한 운영 설정
- `minTotalActivityCount`
  - 글/댓글 합계 최소 기준
- `minPostRatioPercent`
  - 게시물 비율 최소 기준

### 10.2 runtime state

```js
{
  isRunning: false,
  runPromise: null,
  currentPage: 0,
  totalClassified: 0,
  totalSuspiciousUid: 0,
  cycleCount: 0,
  logs: [],
}
```

### 10.3 storage key

- `semiPostSchedulerState`

---

## 11. 페이지 처리 알고리즘

### 11.1 한 페이지 처리 순서

1. `fetchPostListHTML(config, page)`
2. `extractHeadtextName(html, headtextId)`
3. `parseUidBearingPosts(html, targetHeadName)`
4. 후보 게시물을 `uid`별로 group
5. 각 `uid`에 대해 `fetchUserActivityStats(uid)`
6. 기준 만족 uid만 suspicious set에 등록
7. suspicious uid가 쓴 게시물 번호 추출
8. `classifyPosts(config, postNos)`

### 11.2 uid group 구조

예상 형태:

```js
Map<string, {
  uid: 'near1254',
  nick: '특갤전용기계',
  posts: [
    { no: 1024419, subject: '...', currentHead: '일반' },
    { no: 1024420, subject: '...', currentHead: '일반' },
  ],
}>
```

즉 같은 uid는 페이지 안에서 한 번만 API를 조회한다.

### 11.3 의심 작성자 판정

```js
const totalActivityCount = postCount + commentCount;
const postRatio = totalActivityCount > 0
  ? (postCount / totalActivityCount) * 100
  : 0;

const isSuspicious =
  totalActivityCount >= config.minTotalActivityCount &&
  postRatio >= config.minPostRatioPercent;
```

### 11.4 분류 대상 게시물 추출

기준을 넘는 uid에 대해:

```js
const postNos = suspiciousGroups
  .flatMap((group) => group.posts.map((post) => String(post.no)));
```

그 후 `classifyPosts()` 재사용.

---

## 12. 캐시 정책

v1은 복잡한 영속 캐시를 두지 않는다.

대신 **페이지/사이클 단위 dedupe**만 필수로 한다.

필수 규칙:

- 같은 페이지 처리 중 동일 `uid`는 1회만 조회
- 같은 사이클에서 이미 조회한 `uid`면 재사용 가능

권장 추가:

```js
this.uidStatsCache = new Map();
```

값 예시:

```js
{
  uid: 'near1254',
  postCount: 886,
  commentCount: 47,
  totalActivityCount: 933,
  postRatio: 94.96,
  fetchedAt: 1770000000000,
}
```

v1 TTL 권장:

- `uidStatsCacheTtlMs = 10 * 60 * 1000`

단, TTL 캐시는 **선택 사항**이다.

즉 구현 우선순위는:

1. 페이지/사이클 dedupe
2. 필요하면 메모리 TTL cache

영속 storage cache는 v1 범위에서 제외한다.

---

## 13. 로그 정책

로그는 현재 suite 스타일을 그대로 따른다.

예시:

```txt
[19:10:03] 🟢 반고닉 도배기 분류 시작!
[19:10:04] 📄 1페이지: uid 작성자 12개 발견
[19:10:04] 👤 near1254: 글 886 / 댓글 47 / 게시물비율 95.0%
[19:10:04] 🚨 near1254 판정 - 기준 초과
[19:10:05] 🏷️ 4개 게시물 도배기 분류 중...
[19:10:06] ✅ 4개 분류 완료 (총 4개)
```

실패 예시:

```txt
[19:10:04] ⚠️ semester0653: 활동 통계 조회 실패 - 응답 파싱 실패
[19:10:04] ⚠️ 1페이지: 도배기탭 번호 130 라벨 추출 실패, 페이지 스킵
```

---

## 14. UI 스펙

### 14.1 새 탭

사용자 탭 이름 후보:

- `반고닉 도배기`
- `반고닉 분류`

v1은 수동 기능이므로 자동화 계열 색이 아니라 manual 계열과 같은 그룹으로 둔다.

### 14.2 상태 카드

- 상태
- 현재 페이지
- 총 분류
- 판정 UID 수
- 완료 사이클

### 14.3 설정 항목

- 시작 페이지
- 끝 페이지
- 요청 딜레이(ms)
- 사이클 딜레이(ms)
- 최소 총 활동수
- 최소 게시물 비율(%)

공통 설정에서 가져오는 값:

- 갤러리 ID
- 도배기탭 번호

즉 별도로 다시 입력받지 않는다.

---

## 15. background 수동 잠금 정책

v1은 수동 feature다.

즉 아래 정책을 따른다.

- `monitor` 실행 중에는 `post/ip`처럼 이 feature도 같이 막을지 여부를 정해야 함
- `commentMonitor`와는 직접 충돌 없음

권장:

- `monitor` 실행 중 `semiPost.start/stop/updateConfig/resetStats` 차단

이유:

- monitor가 이미 `post/ip` child를 관리 중이므로, 수동 분류기까지 동시에 돌리면 운영 의미가 겹치고 요청량만 커진다.

즉 `background/background.js`의 `getMonitorManualLockMessage()`에 `semiPost`도 추가하는 쪽을 권장한다.

---

## 16. 엣지 케이스

### 16.1 uid 없는 유동

- `data-uid === ''`
- 대상 아님
- 스킵

### 16.2 이미 도배기탭인 글

- `currentHead.includes(targetHeadName)`
- 재분류 금지
- 스킵

### 16.3 동일 uid가 여러 글을 올린 경우

- API 조회는 한 번만
- 판정되면 그 uid의 현재 스캔 범위 내 모든 글을 분류

### 16.4 활동 수가 너무 적은 uid

예:

- 글 1, 댓글 0

게시물 비율은 100%지만 표본이 너무 작다.

따라서:

- `totalActivityCount < minTotalActivityCount`
- 스킵

### 16.5 gallog 응답 파싱 실패

예:

- 빈 문자열
- 숫자가 아닌 응답
- 콤마 개수 이상

처리:

- 해당 uid 실패 로그
- 그 uid는 이번 사이클에서 판정 제외
- 페이지 전체 실패로 보지 않음

### 16.6 ci_t 토큰 없음

- 로그인/관리자 세션 문제
- 해당 페이지/사이클 실패
- 사용자에게 명확히 로그 남김

### 16.7 403/429

기존 `dcFetchWithRetry()` 패턴을 재사용한다.

즉:

- 429 -> backoff 후 재시도
- 403 -> 충분한 대기 후 재시도

---

## 17. 구현 순서

1. `features/post/parser.js`
   - `uid` 추출 추가
   - `parseUidBearingPosts()` 추가

2. `features/semi-post/api.js`
   - `fetchUserActivityStats(config, uid)`
   - `getCiToken()` 재사용 또는 동일 구현

3. `features/semi-post/scheduler.js`
   - 상태/로그/페이지 순회
   - uid group
   - 활동 통계 조회
   - 비율 판정
   - `classifyPosts()` 호출

4. `background/background.js`
   - `semiPost` 등록
   - 메시지 라우팅
   - monitor 실행 중 manual lock 추가

5. `popup/*`
   - 탭/패널/설정/상태/로그 추가

6. 정적 검증
   - `node --check`
   - uid 파싱 샘플 검증
   - gallog 응답 파싱 검증
   - suspicious uid grouping 검증
   - 동일 uid 다중 게시물 분류 검증

---

## 18. 구현 완료 후 정적 검증 체크리스트

### 18.1 parser 검증

- `data-uid`가 정상 추출되는가
- uid 없는 row는 `hasUid=false`인가
- `parseUidBearingPosts()`가 이미 도배기탭 글을 제외하는가
- 공지/설문 row가 제외되는가

### 18.2 gallog API 파서 검증

입력:

- `"886,4783"` -> 정상
- `"89,220"` -> 정상
- `""` -> 실패
- `"abc,220"` -> 실패
- `"89"` -> 실패 또는 commentCount 0 허용 정책 중 하나로 고정 필요

권장:

- v1은 두 값 모두 숫자여야만 성공 처리

### 18.3 비율 판정 검증

- `post=200 comment=5 total=205 ratio=97.56` -> suspicious
- `post=89 comment=220 total=309 ratio=28.80` -> not suspicious
- `post=1 comment=0 total=1` + `minTotalActivityCount=20` -> not suspicious

### 18.4 분류 대상 추출 검증

동일 uid가 3개 글을 쓴 경우:

- API 조회 1회
- 분류 대상 게시물 3개

### 18.5 background/popup 연결 검증

- `start`
- `stop`
- `getStatus`
- `updateConfig`
- `resetStats`

모두 `semiPost` feature로 정상 라우팅되는가

### 18.6 monitor lock 검증

- `monitor` 실행 중 `semiPost.start`가 거부되는가
- popup 버튼/설정 저장도 잠기는가

---

## 19. v1 범위 밖

이 문서는 아래를 포함하지 않는다.

- 자동 감시/자동 진입
- 반고닉 IP 차단 자동화
- 반고닉 도배기 자동 해제
- 제목/본문 유사도 분석
- 누적 글/댓글 비율 외의 행동 패턴 모델링
- `data-uid` 기반 세밀한 고닉/반고닉 세분화

즉 v1의 범위는 명확하다.

**수동 페이지 순회 + 식별코드 작성자 누적 게시물 비율 판정 + 도배기탭 분류**

---

## 20. 교차 검증 결론

현재 코드와 실페이지 기준으로, 이 스펙은 바로 구현 가능한 수준이다.

이 결론의 근거는 다음과 같다.

- 목록 HTML에 `data-uid`가 실제로 존재한다.
- 기존 `post` 기능이 목록 fetch와 `도배기탭 분류` API를 이미 가지고 있다.
- 작성자 레이어의 `글/댓글 수`는 별도 API endpoint와 파라미터가 확인됐다.
- 즉 v1에서 새로 필요한 핵심은 `uid 추출`, `gallog 통계 조회`, `비율 판정`, `기존 classifyPosts 재사용`뿐이다.

따라서 다음 단계는 문서 보강이 아니라 바로 코드 구현으로 넘어가면 된다.
