# 분탕경고 page1 자동 차단/삭제 구현 플랜

## 목표

기존 `분탕경고`는 **현재 내가 보고 있는 페이지에 경고 배지 `- 분탕주의`를 붙이는 수동 시각 경고 기능**이다.

이번 확장은 그 위에 **자동 제재 기능**을 추가하는 것이다.

v1 목표는 아래처럼 단순하게 고정한다.

1. **게시판 1페이지를 1분마다 폴링**
2. 같은 `uid`가 **최근 5분 안에 글을 2개 이상** 올렸고
3. 그 `uid`의 전체 활동 통계에서 **글 비중(`effectivePostRatio`)이 90% 이상**이고
4. 그 `uid`의 갤로그가 **게시글 비공개 + 댓글 비공개**이면
5. **현재 page 1에 보이는 그 uid 글 전부**를
   - `6시간 차단`
   - `삭제(del_chk=1)`
   로 처리한다
6. 삭제 한도 초과가 나면 기존 **계정 전환 fallback**을 재사용한다

즉 한 줄로 말하면:

- `분탕경고` 기준으로도 위험한 `uid`
- 그것도 **page 1에서 5분 내 2글 이상**
- 그리고
  - **글 비중 90% 이상**
  - **갤로그 게시글/댓글이 둘 다 비공개**
  를 둘 다 만족하면
- **page 1에 보이는 그 uid 글을 한 번에 6시간 차단 + 삭제**


## 사용자 기준 기대 동작

예시:

1. `scatter6268`가 특이점 갤 page 1에서
   - 11:16
   - 11:14
   - 11:12
   에 글을 올림
2. 11:16 기준으로 보면 최근 5분 안에 이미 2글 이상이다
3. 이 `uid`의 전체 활동 통계를 조회했더니
   - 게시물 55
   - 댓글 5
   - 글 비중 91.67%
4. 갤로그를 확인했더니
   - 게시글 `비공개`
   - 댓글 `비공개`
5. 그러면 1분 poll 시점에
   - page 1에 현재 보이는 `scatter6268` 글들을 전부 모아
   - `6시간 차단 + 삭제`
   한다

비공개 갤로그 예시:

1. `decided5206`가 page 1에서 최근 5분 안에 2글 이상 올림
2. 갤로그를 확인했더니
   - 게시글 `비공개`
   - 댓글 `비공개`
3. 그런데 글 비중이 70%면 아직 trigger 아님
4. 즉 **5분 2글**을 기본 전제로 두고,
   - `글 비중 90% 이상`
   - `갤로그 게시글/댓글 비공개`
   를 **둘 다 만족해야** 자동 제재한다

중요:

- 이번 v1은 **page 1 기준**이다
- “갤 전체 모든 페이지의 같은 uid 글 전부”가 아니라
- **현재 poll 시점의 page 1에 보이는 그 uid 글 전부**를 제재한다

즉 사용자가 말한 “전부보다는 사실상 1페이지 컷”을 그대로 구현 대상으로 잡는다.


## 왜 page 1만으로 가능한가

`[html.md](./html.md)`를 보면, page 1 list HTML 한 장 안에 필요한 정보가 이미 다 있다.

### 1. 글 번호

예:

- `<tr class="ub-content us-post" data-no="1077335" ...>`

즉 각 글 row에서 `postNo`를 바로 뽑을 수 있다.

### 2. 식별코드 uid

예:

- `<td class="gall_writer ub-writer" data-nick="ㅇㅇ" data-uid="scatter6268" data-ip="" data-loc="list">`

즉 row마다 `uid`를 바로 뽑을 수 있다.

### 3. 정확한 작성 시각

예:

- `<td class="gall_date" title="2026-03-29 11:16:36">11:16</td>`

즉 “최근 5분 이내인지”를 분 단위가 아니라 **초 단위 풀타임스탬프**로 판정할 수 있다.

### 4. 실제 분탕 예시가 같은 page 1 안에 반복해서 존재

`html.md` 예시에선 같은 `uid=scatter6268`가 page 1 한 장 안에서 여러 번 반복된다.

예:

- 11:16:36
- 11:14:08
- 11:12:40

즉 “최근 5분 내 2글 이상”은 page 1 한 번 fetch한 HTML만으로도 판정 가능하다.


## 갤로그 비공개 필터 근거

`[html.md](./html.md)`와 `[html(분탕).md](./html(분탕).md)`를 비교하면,
갤로그 공개/비공개 상태를 마크업으로 안정적으로 구분할 수 있다.

### 1. 일반 갤로그

- 게시글 섹션: `<span class="bluebox">공개</span>`
- 댓글 섹션: `<span class="bluebox">공개</span>`

실제 예시:

- [html.md](./html.md#L288)
- [html.md](./html.md#L330)

### 2. 분탕성 비공개 갤로그

- 게시글 섹션: `<span class="greybox">비공개</span>`
- 댓글 섹션: `<span class="greybox">비공개</span>`

실제 예시:

- [html(분탕).md](./html(분탕).md#L288)
- [html(분탕).md](./html(분탕).md#L308)

중요:

- `게시글이 없습니다`, `댓글이 없습니다` 텍스트만 보면 안 된다
- 공개 상태인데 진짜 글/댓글이 0개여도 empty 텍스트는 나올 수 있다
- 따라서 **핵심 판별은 `bluebox/greybox`와 `공개/비공개` 라벨**이다

문서 기준 비공개 분탕 필터는 아래처럼 정의한다.

1. 갤로그 홈 HTML fetch
2. 게시글 섹션 상태 확인
3. 댓글 섹션 상태 확인
4. 둘 다 `greybox 비공개`면 `gallogPrivate = true`

즉 한 줄로:

- **게시글 비공개 + 댓글 비공개** 조합이면 “분탕용 비공개 갤로그” 신호로 본다


## 이번 문서의 범위

이번 문서는 아래만 다룬다.

1. `분탕경고` 탭 안의 **새 자동 제재 기능**
2. **page 1** 기준 uid burst 감지
3. 기존 `IP차단/삭제`의 **차단 + 삭제 + 삭제한도 계정전환 fallback** 재사용

이번 문서에서 의도적으로 제외하는 것:

1. page 2 이상 스캔
2. 댓글까지 포함한 burst 판정
3. 수동 `분탕경고` 배지 기능 변경
4. “갤 전체에 남아있는 해당 uid 글 전부” 삭제


## 기존 기능과 관계

### 1. 현재 `분탕경고` 수동 배지 기능

현재는 아래 문서/코드가 존재한다.

- 수동 경고 플랜:
  - [uid_post_ratio_warning_badge_plan.md](./uid_post_ratio_warning_badge_plan.md)
- background:
  - [background/uid-ratio-warning.js](../background/uid-ratio-warning.js)
- DOM helper:
  - [features/semi-post/uid-warning.js](../features/semi-post/uid-warning.js)

이 기능은:

- 현재 탭에서 `data-uid`를 수집하고
- `effectivePostRatio >= 90`이면
- 빨간 `- 분탕주의` 배지를 붙인다

즉 **시각 경고용**이다.

중요:

- 현재 수동 `분탕경고`는 이미 **댓글 2개 차감 보정**이 들어간 `effectivePostRatio`를 사용한다
- 따라서 새 `분탕자동차단`도 같은 기준을 유지해야, 화면 경고와 자동 제재 기준이 서로 어긋나지 않는다

### 2. 새 기능은 별도 자동 제재 기능이어야 한다

이번 확장은 성격이 다르다.

- 수동 배지:
  - 현재 페이지에 배지만 붙임
- 새 자동 제재:
  - background poll
  - page 1 HTML fetch
  - 조건 만족 시 6시간 차단 + 삭제 실행

그래서 **현재 수동 `uidRatioWarning`에 기능을 덕지덕지 붙이면 안 된다**.

권장 구조:

- `분탕경고` 탭은 유지
- 현재 보이는 **가시 경고 기능은 그대로 둔다**
- 그 아래에 **독립 기능 토글 `분탕자동차단`** 을 새로 둔다

즉 화면 구조는 이렇게 간다.

1. 위 카드:
   - 현재처럼 `분탕경고`
   - 현재 페이지 uid 경고 배지 표시용
2. 아래 카드:
   - `분탕자동차단`
   - page 1 1분 poll 자동 제재용

예시:

- 지금처럼 위 카드 ON이면 페이지에 `- 분탕주의`가 보임
- 아래 `분탕자동차단`도 ON이면, 별도로 page 1을 감시해서 조건 만족 uid를 자동 차단/삭제

즉 **가시 경고와 자동 제재를 한 카드에 섞지 않고, 위아래로 분리**하는 구조다.

추가로 `분탕자동차단`은 성격상 수동 utility가 아니라 **저장형 자동 기능**으로 보는 것이 맞다.

즉 문서 기준 기대 동작은:

- 브라우저 재시작 후에도 ON 유지
- 확장 새로고침 후에도 ON 유지
- `chrome.storage.local` 기반 상태 복원

이다.

그리고 popup wiring도 아래처럼 분리하는 것이 맞다.

- 기존 수동 `분탕경고` card DOM/state는 그대로 유지
- 새 `분탕자동차단`은 별도 `FEATURE_DOM` 항목 추가
- `DIRTY_FEATURES`에도 별도 key 추가
- 수동 `분탕경고` 상태 렌더링 함수와 자동 제재 상태 렌더링 함수를 분리

즉 popup에서도 **manual utility와 scheduler feature를 섞지 않는 구조**가 맞다.


## 기존 코드에서 재사용 가능한 것

## 1. uid 활동 통계 API

이미 반고닉 분류/분탕경고가 아래 API를 사용한다.

- [features/semi-post/api.js](../features/semi-post/api.js)

핵심 함수:

- `fetchUserActivityStats(config, uid)`

반환값:

- `postCount`
- `commentCount`
- `effectiveCommentCount`
- `totalActivityCount`
- `effectiveTotalActivityCount`
- `effectivePostRatio`
- `postRatio`

즉 **글 비중 90% 판정**은 새로 만들 필요가 없다.


## 1-1. 갤로그 HTML fetch / 비공개 파서

현재 구현 기준 갤로그 비공개 필터는 아래 helper 조합으로 처리한다.

- `features/uid-warning-autoban/api.js`
  - `fetchGallogHomeHtml(uid)`
- `features/uid-warning-autoban/parser.js`
  - `parseGallogPrivacy(html)`

권장 구현 메모:

- `fetchGallogHomeHtml(uid)`도 기존 list/stats fetch처럼 `withDcRequestLease(...)`를 타는 쪽이 안전하다
- `403/429` backoff 규칙도 기존 fetch helper와 같은 성격으로 맞추는 것이 좋다

권장 반환 shape:

```js
{
  success: true,
  postingPublic: true,
  commentPublic: true,
  postingPrivate: false,
  commentPrivate: false,
  fullyPrivate: false,
}
```

`fullyPrivate` 판정 기준:

- 게시글 `greybox 비공개`
- 댓글 `greybox 비공개`

둘 다 만족할 때만 `true`

예시:

- `author5184` -> `fullyPrivate: false`
- `decided5206` -> `fullyPrivate: true`


## 1-2. `gallog.dcinside.com` host permission 유지 필요

갤로그 비공개 필터는 `https://gallog.dcinside.com/<uid>` HTML fetch가 전제다.

현재 구현 기준으로는 `manifest.json`에 아래 host permission이 포함돼 있어야 한다.

- `https://gallog.dcinside.com/*`

쉽게 예시로 말하면:

1. `decided5206`가 최근 5분 2글 조건을 만족
2. 다음 단계로 `https://gallog.dcinside.com/decided5206`를 확인해야 함
3. 이 host permission이 빠지면 여기서 실제 기능이 멈춤

즉 **갤로그 비공개 필터는 이 권한이 유지돼 있어야 한다.**


## 2. 게시판 목록 HTML fetch

이미 일반 게시판 list fetch 함수가 있다.

- [features/post/api.js](../features/post/api.js)

핵심 함수:

- `fetchPostListHTML(config, page = 1)`

이번 기능은 v1이 page 1 고정이므로, 이 함수를 그대로 재사용하면 된다.


## 3. 차단 + 삭제 API

이미 `IP차단/삭제` 기능에서 아래 API를 쓴다.

- [features/ip/api.js](../features/ip/api.js)

핵심 함수:

- `banPosts(config, postNos)`

이 API는 이미:

- `avoid_hour`
- `del_chk`
- `avoid_type_chk`
- `nos[]`

형태로 차단/삭제를 같이 처리한다.

즉 **6시간 차단 + 글 삭제** 자체는 새 API가 필요 없다.

다만 그대로 쓰면 현재 기본 reason text가:

- `도배기로 인한 해당 유동IP차단`

이라서 `uid` 제재 의미와 안 맞는다.

따라서 새 기능은 실행 시 아래를 명시적으로 override하는 것이 맞다.

- `avoidHour: '6'`
- `delChk: true`
- `avoidTypeChk: true`
- `avoidReasonText: '깡계분탕'`

`avoidReason` 숫자값은 기존 운영 기본값을 유지해도 되지만,
최소한 `avoidReasonText`는 새 기능 의미에 맞게 바꾸는 것이 안전하다.


## 4. 삭제 한도 계정전환 fallback

이미 아래 broker가 있다.

- [background/dc-session-broker.js](../background/dc-session-broker.js)

핵심 함수:

- `requestDeleteLimitAccountFallback(options)`

즉 삭제 한도 초과 시

1. 계정 전환 시도
2. 같은 run에서 재시도

이 흐름 자체는 이미 존재한다.

## 5. uid 통계 cache는 공용 helper를 유지한다

현재 구현 기준 uid 활동 통계는 아래 공용 helper를 탄다.

- [background/uid-stats-cache.js](../background/uid-stats-cache.js)

즉 수동 `분탕경고`와 `분탕자동차단`이 같은 uid 통계를 볼 때, 이미 같은 TTL cache를 재사용하는 구조다.


## 5-1. 갤로그 비공개 판정도 cache를 둔다

현재 구현 기준 갤로그 비공개 판정은 아래 공용 cache helper를 둔다.

- `background/uid-gallog-privacy-cache.js`

이유는 단순하다.

1. page 1에서 최근 5분 2글 후보를 잡고
2. `effectivePostRatio >= 90`를 확인한 다음
3. 갤로그 비공개 여부까지 봐야 한다

이때 같은 uid가 page 1에 계속 남아 있으면, 매 1분 poll마다 같은 갤로그를 다시 읽지 않게 해야 한다.

권장 cache shape:

```js
{
  'decided5206': {
    fullyPrivate: true,
    postingPrivate: true,
    commentPrivate: true,
    expiresAt: 1774751000000,
  }
}
```

권장 TTL:

- `2분` 또는 `5분`

권장 순서:

1. 최근 5분 2글 후보 uid 추림
2. uid stats cache 확인 / 필요시 fetch
3. `effectivePostRatio >= 90` 통과 uid만
4. gallog privacy cache 확인 / 필요시 fetch

즉 **갤로그 fetch는 ratio 통과 뒤에만**, 그리고 **cache를 둔 상태로** 수행하는 쪽이 안전하다.


## 현재 코드에서 바로 못 쓰는 것

## 1. 현재 `분탕경고`는 “최근 5분 2글” 정보를 모른다

현재 `fetchUserActivityStats()`는 전체 활동 통계만 돌려준다.

즉 아래 정보는 준다.

- 게시물 55
- 댓글 5
- 글 비중 91.67%

하지만 아래 정보는 안 준다.

- 최근 5분 안에 글을 몇 개 썼는지
- 그 글 번호가 무엇인지

그래서 **recent burst 판정은 page 1 HTML parser를 새로 만들어야 한다.**


## 2. `ipScheduler.banPostsOnce()`는 삭제한도 계정전환 fallback을 안 탄다

기존 `IP차단/삭제`에서 실제 delete-limit fallback을 타는 건

- [features/ip/scheduler.js](../features/ip/scheduler.js)

의 `processBanCandidates()`다.

반면 `banPostsOnce()`는 1회성 차단만 하고, delete-limit fallback을 같이 안 돈다.

즉 이번 기능에서 **그냥 `banPostsOnce()`를 호출하면 사용자 요구를 만족하지 못한다.**

필요한 방향은 둘 중 하나다.

1. `processBanCandidates()`에서 delete-limit fallback 부분을 **공용 helper로 추출**
2. 새 자동 제재 기능이 그 공용 helper를 재사용

권장안은 `1`이다.

이유:

- `IP차단/삭제`
- 새 `분탕경고 자동 제재`

둘 다 같은 정책을 써야 하기 때문이다.

다만 공용 executor를 뽑을 때 **IP scheduler의 `activeBans` 추적 목록까지 새 기능과 공유할지**는 별도 결정이 필요하다.

이건 실제 연결 문제다.

### 선택지 A. 새 자동 제재도 IP `activeBans`에 넣기

장점:

- 기존 `IP차단/삭제 > 수동 해제` 흐름과 합쳐 보일 수 있다
- writerKey 기준 중복 차단 갱신 로직을 공유할 수 있다

단점:

- `IP차단/삭제`와 `분탕자동차단`이 같은 추적 목록을 함께 만지게 된다
- ownership이 섞여서 release / 통계 / log 의미가 흐려질 수 있다

### 선택지 B. 새 자동 제재는 별도 추적 상태를 둔다

장점:

- 기존 `IP차단/삭제` 동작을 덜 건드린다
- ownership이 명확하다

단점:

- 기존 IP 수동 해제 버튼에서 새 자동 제재 기록은 바로 안 보일 수 있다

v1 권장안:

- **기존 `IP차단/삭제`의 `activeBans`는 건드리지 않는다**
- 새 기능은 **자기 dedupe/cooldown 상태만 별도로 가진다**
- 자동 제재는 `6시간` 만료형이라, v1은 수동 release UI 통합까지 욕심내지 않는다

즉 v1 목표는 **안전한 자동 컷**이고, `IP차단/삭제`의 tracked-ban UI와 완전 통합은 2차 범위로 둔다.


## 최종 구조 제안

## 1. 새 feature는 `분탕자동차단`으로 분리

현재 코드베이스에는 아래 모듈이 이미 있다.

- `features/uid-warning-autoban/scheduler.js`
- `features/uid-warning-autoban/parser.js`
- `features/ip/ban-executor.js`

즉 이번 작업은 **새 파일을 처음 만드는 것보다, 이미 있는 `분탕자동차단` 구현을 문서 기준으로 보강하는 작업**에 가깝다.

역할:

- `uid-warning-autoban/scheduler.js`
  - 1분 loop
  - page 1 fetch
  - burst 판정
  - 제재 실행
- `uid-warning-autoban/parser.js`
  - page 1 row에서 `postNo/uid/nick/subject/currentHead/timestamp` 파싱
- `ip/ban-executor.js`
  - 기존 IP 차단 로직에서 delete-limit fallback 포함 실행 경로를 공용화
  - 이건 이미 추출되어 있고, 새 조건에 맞게 호출부만 유지/보강하면 된다


## 2. `분탕경고` 탭 안에 하단 독립 카드 추가

UI 예시:

- 카드 1: `현재 페이지 경고`
  - 기존 수동 토글
- 카드 2: `분탕자동차단`
  - ON/OFF 토글
  - 상태
  - 최근 트리거 uid
  - 최근 제재 게시물 수
  - 최근 실행 시각

기본 설정 v1:

- poll 주기: `60000ms`
- 최근 글 윈도우: `5분`
- 최소 글 수: `2`
- 글 비중 기준: `90%`
- 차단 시간: `6시간`
- 삭제: `ON` 고정

즉 1차는 **설정 자유도보다 단순 고정값 우선**이 맞다.

중요:

- 카드 1 `분탕경고`는 그대로 둔다
- 카드 2 `분탕자동차단`만 새로 추가한다
- 두 기능은 같은 탭 안에 있어도 **토글/상태/로그를 서로 분리**한다


## 3. background registry에 새 scheduler 등록

현재 background는 기존 feature scheduler들을 registry처럼 관리한다.

새 기능도 같은 방식으로 별도 scheduler로 등록하는 것이 맞다.

이유:

- 이건 이미 “수동 현재 탭 배지 기능”이 아니라
- **장기 poll 자동화**이기 때문이다

즉 수동 `uidRatioWarning` top-level action과는 별도로,

- 새 `uidWarningAutoBanScheduler`

를 background 수준에서 관리해야 한다.

추가로 실제 연결 포인트는 여기까지 같이 필요하다.

- `background/background.js`의 `schedulers` registry 추가
- `getAllStatuses()` 노출
- `resumeAllSchedulers()` 복원 연결
- `getBusyFeatures()` 포함
- `updateSharedConfig()`에서 gallery 변경 시 reset 연결

예시:

1. 운영자가 갤러리 ID를 바꿈
2. 기존 자동 기능들은 상태를 초기화함
3. `분탕자동차단`만 예전 갤러리 상태를 들고 있으면 잘못된 갤을 계속 보게 됨

그래서 새 기능도 **공통 설정 변경 시 reset되는 기존 자동 기능 패턴**을 따라야 한다.

추가로 현재 실제 코드 기준으론 `게시물 자동화(monitor)`와의 공존 정책도 유지해야 한다.

현재 동작은 blanket lock이 아니라 아래와 같다.

1. `monitor`가 **평소 NORMAL**이면 `분탕자동차단`과 공존 가능
2. `monitor`가 **ATTACKING/RECOVERING**이면 `분탕자동차단` 자동 일시정지
3. 공격이 끝나면 `분탕자동차단` 자동 복원
4. `ip` 실행 중일 때만 `분탕자동차단` start/수동조작 금지

쉽게 예시로 말하면:

1. `게시물 자동화` ON, 지금 평온한 상태
2. `분탕자동차단`도 ON
3. 공격 들어옴
4. `분탕자동차단` 자동 일시정지
5. 공격 끝남
6. `분탕자동차단` 자동 복원

즉 이번 구현도 아래 원칙을 따라야 한다.

- `monitor`가 켜져 있다는 이유만으로 새 기능을 막지 않는다
- **ATTACKING/RECOVERING일 때만** 자동 일시정지
- `ip` 실행 중일 때는 계속 start/수동조작 금지


## page 1 HTML parser 설계

## 1. 입력

- `fetchPostListHTML(config, 1)` 로 가져온 page 1 HTML

## 2. 출력 row shape

권장 출력:

```js
{
  no: 1077335,
  uid: 'scatter6268',
  nick: 'ㅇㅇ',
  subject: '일반',
  currentHead: '일반',
  title: '오픈ai 팬 류튜브 보니까 기능이 많던데 저대로',
  createdAtText: '2026-03-29 11:16:36',
  createdAtMs: 1774750596000,
  writerToken: 'scatter6268',
  writerKey: 'ㅇㅇ|scatter6268',
  writerDisplay: 'ㅇㅇ(scatter6268)',
}
```

## 3. row 필터

아래는 제외한다.

1. 공지 / 설문 / 숫자 아닌 row
2. `data-no` 없는 row
3. `data-uid` 없는 row
4. timestamp `title` 없는 row
5. 파싱 실패 row

중요:

- 이번 기능은 **uid만 대상**이다
- 유동(`data-ip`)은 대상이 아니다

## 4. timestamp 파싱

`gall_date[title]` 값은 `YYYY-MM-DD HH:mm:ss` 형태다.

예:

- `2026-03-29 11:16:36`

이건 `Date.parse()`에 그냥 던지지 말고, **로컬 시간(KST) 기준으로 안전하게 파싱하는 helper**를 두는 게 맞다.

이유:

- 브라우저/환경에 따라 문자열 파싱 차이가 날 수 있다
- 분 단위 경계 판단이 핵심이므로 파싱을 명시적으로 해야 한다

권장:

- 정규식 분해
- `new Date(year, monthIndex, day, hour, minute, second).getTime()`


## burst 판정 로직

## 1. page 1 rows를 uid별로 group

예:

- `scatter6268` -> 8개
- `serious5963` -> 1개
- `halt3917` -> 1개

## 2. 각 uid에 대해 최근 5분 window 계산

기준 시각:

- poll 시점 `now`

판정:

- `now - createdAtMs <= 5분`

인 row만 최근 window로 본다.

## 3. trigger 조건

아래를 동시에 만족하면 trigger:

1. 최근 5분 row 수 `>= 2`
2. `fetchUserActivityStats(uid)` 성공 + `effectivePostRatio >= 90`
3. `gallog fullyPrivate === true`

예시:

- 최근 5분 row 4개
- effectivePostRatio 91.67
- 갤로그 `게시글 비공개 + 댓글 비공개`

-> trigger

예시:

- 최근 5분 row 4개
- effectivePostRatio 70
- 갤로그 `게시글 비공개 + 댓글 비공개`

-> trigger 아님

예시:

- 최근 5분 row 4개
- effectivePostRatio 95
- 갤로그 공개

-> trigger 아님

예시:

- effectivePostRatio 95
- 최근 5분 row 1개

-> trigger 아님

중요:

- 최근 글 수 기준은 **2글 이상**으로 고정해야 한다
- 기본값/설명/로그 문구도 이 기준과 같이 움직여야 운영 중 혼선이 없다


## 제재 범위

이번 v1 제재 범위는 **trigger 순간 page 1에 보이는 같은 uid 글 전부**로 한다.

즉 최근 5분 2글을 만족하게 만든 2개만이 아니라,

- 그 poll 시점 page 1에서
- 같은 uid인 row를 전부 모아
- 그 번호 전체를 삭제/차단한다

예시:

page 1에 `scatter6268` 글이 6개 보이고,
그 중 최근 5분 글이 2개 이상이면,

- 그 6개를 전부 차단/삭제

이 정책이 사용자 의도인 “그 페이지에 그 uid 글 다 날리기”와 가장 가깝다.


## 왜 page 1만 스캔하나

사용자 기준으로는 “전부보다는 사실상 1페이지에서 컷”이다.

이 정책의 장점:

1. 구현 단순
2. 요청량 적음
3. 1분 poll 기준 빠르게 컷 가능

주의:

- 분탕이 너무 빠르게 써서 일부 글이 page 2로 밀리면 v1은 그걸 못 잡을 수 있다
- 이건 **page 1 only 설계의 의도된 한계**로 문서에 명시한다


## 제재 실행 경로

## 1. 직접 `banPosts()`만 부르면 안 된다

이유:

- 삭제 한도 초과 시 계정전환 fallback까지 사용자 요구가 포함되어 있기 때문이다

따라서 실행부는 아래처럼 가야 한다.

1. 공용 `ban executor`가
2. `banPosts(...)`
3. `delete_limit_exceeded` 감지
4. `requestDeleteLimitAccountFallback(...)`
5. 같은 run 재시도
6. fallback 끝까지 실패하면 최종 보루로 `ban-only`

이 흐름을 수행

즉 **기존 IP scheduler의 delete-limit handling을 공용화해서 재사용**해야 한다.

## 2. 권장 공용 helper 형태

예:

```js
executeBanWithDeleteFallback({
  config,
  posts,
  deleteEnabled: true,
  logger,
  onSuccess,
  onDeleteLimitBanOnlyActivated,
})
```

이 helper는 아래를 공통 처리한다.

1. 초기 `banPosts`
2. delete-limit 감지
3. broker 계정전환 요청
4. 같은 run 재시도
5. 마지막 ban-only fallback

그리고 결과로:

- `successNos`
- `failedNos`
- `deleteLimitFallbackUsed`
- `banOnlyFallbackUsed`

같은 집계를 돌려준다.

중요:

이 helper만 재사용한다고 끝이 아니다.

현재 기존 `IP차단/삭제`는 delete-limit가 반복되면

- `runtimeDeleteEnabled = false`

로 내려가서, **토글 OFF 전까지 차단만 유지**한다.

새 `분탕자동차단`도 같은 보호가 필요하다.

이유:

- 이 기능은 1분 poll이기 때문에
- delete-limit 이후 별도 hold 상태가 없으면
- 다음 1분마다 다시 `삭제 -> delete-limit -> 계정전환 시도`
를 반복할 수 있다

즉 v1에는 아래 상태를 기능 state에 같이 둬야 한다.

```js
{
  runtimeDeleteEnabled: true,
  lastDeleteLimitExceededAt: '',
  lastDeleteLimitMessage: '',
}
```

정책:

1. delete-limit fallback이 최종 실패하거나 loop guard에 걸리면
2. 새 기능도 `runtimeDeleteEnabled = false`
3. 이후에는 **토글 OFF 또는 운영자가 다시 켤 때까지 ban-only**

즉 “한 run 안의 무한루프 방지”뿐 아니라, **다음 1분 cycle들의 반복 전환까지 막는 hold 상태**가 필요하다.

그리고 이 hold 상태는 **저장/복원**돼야 한다.

예시:

1. 11:16에 delete-limit 발생
2. fallback 끝까지 실패해서 ban-only hold 진입
3. 11:17에 확장 새로고침
4. 11:18 poll에서 또 삭제를 재시도하면 안 됨

그래서 `runtimeDeleteEnabled=false` hold는 **chrome.storage.local 복원 대상**이어야 한다.

## 3. post object shape

새 기능에서 executor에 넘길 post row는 최소한 아래를 맞춘다.

```js
{
  no,
  nick,
  ip: '',
  uid,
  subject: title,
  currentHead,
  isFluid: false,
  hasUid: true,
  writerToken: uid,
  writerKey,
  writerDisplay,
}
```

즉 기존 `IP차단/삭제` 성공 기록/로그 흐름과 충돌하지 않게, `uid` target도 동일 shape를 맞춘다.


## 중복 제재 방지

이 부분은 필수다.

그냥 1분마다 page 1을 보고 조건을 만족한다고 매번 다시 제재하면 불필요한 중복 요청이 난다.

권장 상태:

```js
recentUidActions = {
  'thesingularity::scatter6268': {
    lastActionAt: '2026-03-29T11:16:50.000Z',
    lastNewestPostNo: '1077335',
    success: true,
  }
}
```

## 기본 정책

1. 같은 `galleryId::uid`가 이미 **성공 제재**됐고
2. 그 후 page 1에서 **더 새로운 postNo가 안 나타났으면**
3. 다시 제재하지 않는다

즉:

- 같은 분탕 잔재를 1분마다 계속 두드리지 않게 한다

권장 dedupe key:

- `galleryId::uid`

보조 비교값:

- `lastNewestPostNo`
- `lastActionAt`
- `runtimeDeleteEnabled`

예시:

1. `scatter6268`를 11:16에 page1 글 6개로 처리
2. 11:17에도 page1에 같은 6개가 그대로 남아 있음
3. 최신 글번호가 그대로면 다시 안 침
4. 11:18에 새 글 `1077340`이 추가로 올라오면 다시 trigger 가능

## 실패 시 정책

1. 전체 실패면 짧은 retry cooldown
   - 예: `60초`
2. delete-limit fallback 후에도 일부 실패면
   - 다음 poll에서 새 글이 있거나 retry cooldown이 끝났을 때 재시도


## 상태 / 로그 제안

`분탕자동차단` 상태에는 최소한 아래가 필요하다.

```js
{
  isRunning: false,
  currentPage: 1,
  lastPollAt: '',
  lastTriggeredUid: '',
  lastTriggeredPostCount: 0,
  lastBurstRecentCount: 0,
  totalTriggeredUidCount: 0,
  totalBannedPostCount: 0,
  totalFailedPostCount: 0,
  deleteLimitFallbackCount: 0,
  banOnlyFallbackCount: 0,
  lastError: '',
}
```

예시 로그:

- `📄 page1 uid snapshot 37개 / uid 25명`
- `🚨 scatter6268 최근 5분 4글 / 글비중 91.67% / 갤로그 게시글·댓글 비공개 -> 제재 시작`
- `🚨 decided5206 최근 5분 2글 / 글비중 93.10% / 갤로그 게시글·댓글 비공개 -> 제재 시작`
- `⛔ scatter6268 page1 글 6개 차단/삭제 완료`
- `🔁 삭제 한도 계정 전환 성공 - 부계정으로 같은 run 이어감`
- `🧯 삭제 한도 초과로 2개는 차단만 수행`


## popup UI 제안

`분탕경고` 탭 안에 새 하단 카드:

- 제목: `분탕자동차단`
- 설명:
  - `1분마다 1페이지를 확인해, 5분 안에 2글 이상 + 글비중 90% + 갤로그 게시글·댓글 비공개 uid를 6시간 차단/삭제합니다`

상태 항목 예시:

- 실행
- 최근 폴링
- 최근 트리거 uid
- 최근 트리거 글수
- 누적 제재 uid
- 누적 삭제/차단 글수
- 삭제한도 폴백 횟수

중요:

- 기존 수동 `분탕경고` 토글과는 분리해야 한다
- 즉 같은 탭 안이더라도
  - 위: `분탕경고`
  - 아래: `분탕자동차단`
  두 개의 독립 영역으로 둔다

그리고 이 자동 카드의 ON/OFF는 수동 경고와 달리 **저장형 scheduler 토글**로 다뤄야 한다.

즉 popup 연결도 manual utility가 아니라 일반 feature처럼:

- `feature: 'uidWarningAutoBan'`
- `action: 'start' | 'stop' | 'getStatus' | 'updateConfig'`

흐름으로 넣는 편이 맞다.


## 구현 정렬 포인트

실제 코드와 문서를 맞출 때 꼭 같이 봐야 할 포인트는 아래다.

1. `분탕자동차단` 기본값/문구/로그를 모두 **5분 2글 기준**으로 맞춘다
2. `gallog fullyPrivate` 판정을 **필수 필터**로 넣는다
3. 수동 `분탕경고`와 같은 `effectivePostRatio` 기준을 유지한다
4. `게시물 자동화`와는 **공격 시 자동 일시정지/복원** 정책을 유지한다

즉 이번 작업은 “새 기능을 처음부터 추가”라기보다,
**이미 있는 `분탕자동차단` 구현을 문서 기준으로 보강/정렬하는 작업**으로 보는 게 정확하다.


## 실제 구현 순서 권장

## 1단계: page 1 parser 보강

현재 parser:

- `features/uid-warning-autoban/parser.js`

보강 내용:

- page 1 HTML -> uid row 목록 파싱 유지
- timestamp/title/postNo 추출 유지
- 공지/설문/비uid row 제외 유지
- 필요시 gallog 관련 보조 키를 scheduler가 쓰기 좋게 정리

## 2단계: scheduler 조건 보강

현재 scheduler:

- `features/uid-warning-autoban/scheduler.js`

보강 내용:

- 1분 loop 유지
- page 1 fetch 유지
- uid group 유지
- 최근 5분 **2글 이상**으로 기준 변경
- `effectivePostRatio >= 90` + `gallog fullyPrivate` 체크 추가

## 3단계: 공용 ban executor는 재사용 유지

현재 공용 executor:

- `features/ip/ban-executor.js`

이건 이미 추출되어 있고, 기존 IP scheduler도 사용 중이다.

따라서 이번 작업에선:

- 기존 IP scheduler
- `분탕자동차단`

둘 다 **같은 helper를 계속 쓰도록 유지**하는 것이 맞다.

즉 여기서 또 새 executor를 만들거나, 기존 delete-limit semantics를 건드리는 건 피하는 쪽이 안전하다.

## 4단계: popup/background wiring

추가:

- top-level feature registry
- popup 패널 카드
- 상태 렌더링
- ON/OFF
- `getAllStatus` 노출

## 5단계: dedupe/cooldown

추가:

- uid 재제재 방지
- 실패 retry cooldown

## 6단계: 문서/로그 정리

추가:

- popup 문구
- 상태 텍스트
- 관련 구현 문서


## 엣지 케이스

v1에서 반드시 정리해야 하는 케이스:

1. page 1에 같은 uid가 2글 있지만 6분 전에 쓴 글이면 trigger 아님
2. page 1에 같은 uid가 1글만 있으면 trigger 아님
3. 5분 내 2글이지만 `effectivePostRatio < 90`이면 갤로그가 비공개여도 trigger 아님
4. 5분 내 2글이고 `effectivePostRatio >= 90`이어도 갤로그가 공개면 trigger 아님
5. page 1에 같은 uid 글이 6개면 6개 전부 제재
6. 공지/설문 row는 무시
7. 유동(`data-ip`)만 있는 row는 무시
8. timestamp title 없는 row는 무시
9. `fetchUserActivityStats()` 403/429는 기존 backoff를 그대로 탐
10. uid stats 실패면 갤로그 비공개여도 trigger 아님
11. delete-limit 발생 시 계정전환 후 같은 run 재시도
12. 계정전환 실패 시 ban-only 최종 보루
13. 같은 uid가 같은 page1 rows로 1분 뒤 다시 보이더라도 중복 제재 방지
14. 새 postNo가 추가되면 같은 uid라도 다시 제재 가능
15. page 1만 보기 때문에 page 2로 밀린 글은 v1 범위 밖
16. polling 중 OFF하면 다음 cycle부터 중단
17. 브라우저 재시작 후 ON 상태 복원
18. delete-limit loop guard 발동 후에는 다음 minute poll에서도 다시 계정전환을 반복하지 않고 ban-only hold 유지
19. 갤로그 fetch 실패면 trigger 아님
20. uid stats와 갤로그 둘 중 하나라도 실패하면 그 uid는 그 cycle 스킵
21. 갤로그 비공개 판정은 `empty 텍스트`가 아니라 `greybox 비공개`로 본다


## 이 설계가 기존 플로우를 덜 깨는 이유

1. 수동 `분탕경고` 배지는 그대로 둔다
2. 새 자동 제재는 별도 scheduler로 분리한다
3. 차단/삭제 실행은 기존 IP delete-limit fallback 경로를 재사용한다
4. page 1 fetch 1회 + uid stats 조회만 추가하므로 구조가 단순하다

즉 기존 기능을 망가뜨리기보다,

- `분탕경고` 탭에 자동 제재를 하나 더 얹고
- `IP차단/삭제`의 검증된 실행 경로를 재사용하는 방향이다


## 최종 권장안

이번 구현은 아래처럼 가는 것이 가장 안전하다.

1. `분탕경고` 탭 유지
2. 수동 경고 기능은 그대로 유지
3. 새 `분탕자동차단` 하단 카드 추가
4. 1분마다 page 1만 fetch
5. uid별 최근 5분 2글 + `effectivePostRatio 90%` + `갤로그 게시글/댓글 비공개` 판정
6. 현재 page 1에 보이는 그 uid 글 전부 6시간 차단 + 삭제
7. delete-limit는 기존 broker fallback 재사용
8. 같은 uid 반복 제재는 cooldown/dedupe로 억제

한 줄로 정리하면:

- **“위에는 가시 경고를 그대로 두고, 아래 `분탕자동차단`이 page 1 분탕 uid를 1분 안에 잡아 차단/삭제하는 구조”**
- **이때 분탕 판단은 `글 비중 90%`와 `갤로그 게시글/댓글 비공개`를 둘 다 만족해야 한다**

이게 이번 v1의 정확한 목표다.
