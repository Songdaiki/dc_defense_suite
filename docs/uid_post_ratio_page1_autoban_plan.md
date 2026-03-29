# 분탕경고 page1 자동 차단/삭제 구현 플랜

## 목표

기존 `분탕경고`는 **현재 내가 보고 있는 페이지에 경고 배지 `- 분탕주의`를 붙이는 수동 시각 경고 기능**이다.

이번 확장은 그 위에 **자동 제재 기능**을 추가하는 것이다.

v1 목표는 아래처럼 단순하게 고정한다.

1. **게시판 1페이지를 1분마다 폴링**
2. 같은 `uid`가 **최근 5분 안에 글을 3개 이상** 올렸고
3. 그 `uid`의 전체 활동 통계에서 **글 비중(`postRatio`)이 90% 이상**이면
4. **현재 page 1에 보이는 그 uid 글 전부**를
   - `6시간 차단`
   - `삭제(del_chk=1)`
   로 처리한다
5. 삭제 한도 초과가 나면 기존 **계정 전환 fallback**을 재사용한다

즉 한 줄로 말하면:

- `분탕경고`가 붙을 정도의 `uid`
- 그것도 **page 1에서 5분 내 3글 이상**
- 이 조건이면 **page 1에 보이는 그 uid 글을 한 번에 6시간 차단 + 삭제**


## 사용자 기준 기대 동작

예시:

1. `scatter6268`가 특이점 갤 page 1에서
   - 11:16
   - 11:14
   - 11:12
   에 글을 올림
2. 11:16 기준으로 보면 최근 5분 안에 이미 3글 이상이다
3. 이 `uid`의 전체 활동 통계를 조회했더니
   - 게시물 55
   - 댓글 5
   - 글 비중 91.67%
4. 그러면 1분 poll 시점에
   - page 1에 현재 보이는 `scatter6268` 글들을 전부 모아
   - `6시간 차단 + 삭제`
   한다

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

즉 “최근 5분 내 3글 이상”은 page 1 한 번 fetch한 HTML만으로도 판정 가능하다.


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
- `postRatio >= 90`이면
- 빨간 `- 분탕주의` 배지를 붙인다

즉 **시각 경고용**이다.

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
- `totalActivityCount`
- `postRatio`

즉 **글 비중 90% 판정**은 새로 만들 필요가 없다.


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
- `avoidReasonText: '매일 오는 gdp틀딱 (자동차단)'`

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

## 5. uid 통계 cache는 공용화하는 편이 좋다

현재 수동 `분탕경고`는

- [background/uid-ratio-warning.js](../background/uid-ratio-warning.js)

안에서 module-local `uidStatsCache`를 따로 들고 있다.

새 자동 제재도 같은 `fetchUserActivityStats()`를 1분마다 칠 예정이라,

- 수동 경고 ON
- page1 자동 제재 ON

이 둘이 같이 켜지면 **같은 uid 통계를 중복 조회**할 수 있다.

권장 방향:

1. 현재 수동 `분탕경고`의 uid stats cache를 공용 helper로 추출하거나
2. 새 자동 제재도 같은 TTL 규칙을 재사용하도록 맞춘다

즉 이 기능은 **API 로직은 재사용 가능하지만, cache는 지금 그대로 자동 공유되진 않는다**는 점을 문서에 명시한다.


## 현재 코드에서 바로 못 쓰는 것

## 1. 현재 `분탕경고`는 “최근 5분 3글” 정보를 모른다

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

권장 신규 모듈:

- `features/uid-warning-autoban/scheduler.js`
- `features/uid-warning-autoban/parser.js`

필요시:

- `features/ip/ban-executor.js`

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
- 최소 글 수: `3`
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

추가로 v1은 아래 start/lock 정책까지 같이 두는 것이 안전하다.

- `monitor` 실행 중에는 `분탕자동차단` start 금지
- `ip` 실행 중에는 `분탕자동차단` start 금지
- 반대로 `분탕자동차단` 실행 중이면 `monitor` 시작도 막는 방향 권장

이유:

- 둘 다 차단/삭제를 수행한다
- delete-limit fallback ownership이 섞일 수 있다
- 같은 시점에 서로 다른 자동화가 같은 page 1 / 같은 uid를 동시에 건드리면 추적이 불분명해진다

즉 v1은 **동시 공격형 자동 제재 기능끼리 병행 실행을 허용하지 않는 쪽**이 안전하다.


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

1. 최근 5분 row 수 `>= 3`
2. `fetchUserActivityStats(uid)` 성공
3. `postRatio >= 90`

예시:

- 최근 5분 row 4개
- postRatio 91.67

-> trigger

예시:

- 최근 5분 row 4개
- postRatio 70

-> trigger 아님

예시:

- postRatio 95
- 최근 5분 row 2개

-> trigger 아님


## 제재 범위

이번 v1 제재 범위는 **trigger 순간 page 1에 보이는 같은 uid 글 전부**로 한다.

즉 최근 5분 3글을 만족하게 만든 3개만이 아니라,

- 그 poll 시점 page 1에서
- 같은 uid인 row를 전부 모아
- 그 번호 전체를 삭제/차단한다

예시:

page 1에 `scatter6268` 글이 6개 보이고,
그 중 최근 5분 글이 3개 이상이면,

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
- `🚨 scatter6268 최근 5분 4글 / 글비중 91.67% -> 제재 시작`
- `⛔ scatter6268 page1 글 6개 차단/삭제 완료`
- `🔁 삭제 한도 계정 전환 성공 - 부계정으로 같은 run 이어감`
- `🧯 삭제 한도 초과로 2개는 차단만 수행`


## popup UI 제안

`분탕경고` 탭 안에 새 하단 카드:

- 제목: `분탕자동차단`
- 설명:
  - `1분마다 1페이지를 확인해, 5분 안에 3글 이상 + 글비중 90% uid를 6시간 차단/삭제합니다`

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


## 실제 구현 순서 권장

## 1단계: page 1 parser 추가

새 parser 추가:

- `features/uid-warning-autoban/parser.js`

기능:

- page 1 HTML -> uid row 목록
- timestamp/title/postNo 추출
- 공지/설문/비uid row 제외

## 2단계: scheduler 골격 추가

새 scheduler:

- `features/uid-warning-autoban/scheduler.js`

기능:

- 1분 loop
- page 1 fetch
- uid group
- 최근 5분 3글 이상 판정
- `postRatio >= 90` 체크

## 3단계: 공용 ban executor 추출

기존:

- `features/ip/scheduler.js` 내부 `processBanCandidates()`

여기서 delete-limit fallback 포함 실행부를 분리해:

- `features/ip/ban-executor.js`

로 추출

그리고:

- 기존 IP scheduler
- 새 page1 auto-ban

둘 다 그 helper를 쓰게 만든다.

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

1. page 1에 같은 uid가 3글 있지만 6분 전에 쓴 글이면 trigger 아님
2. page 1에 같은 uid가 2글만 있으면 trigger 아님
3. 5분 내 3글이지만 `postRatio < 90`이면 trigger 아님
4. page 1에 같은 uid 글이 6개면 6개 전부 제재
5. 공지/설문 row는 무시
6. 유동(`data-ip`)만 있는 row는 무시
7. timestamp title 없는 row는 무시
8. `fetchUserActivityStats()` 403/429는 기존 backoff를 그대로 탐
9. uid stats 전체 실패 시 그 cycle은 스킵
10. delete-limit 발생 시 계정전환 후 같은 run 재시도
11. 계정전환 실패 시 ban-only 최종 보루
12. 같은 uid가 같은 page1 rows로 1분 뒤 다시 보이더라도 중복 제재 방지
13. 새 postNo가 추가되면 같은 uid라도 다시 제재 가능
14. page 1만 보기 때문에 page 2로 밀린 글은 v1 범위 밖
15. polling 중 OFF하면 다음 cycle부터 중단
16. 브라우저 재시작 후 ON 상태 복원
17. delete-limit loop guard 발동 후에는 다음 minute poll에서도 다시 계정전환을 반복하지 않고 ban-only hold 유지


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
5. uid별 최근 5분 3글 + 글비중 90% 판정
6. 현재 page 1에 보이는 그 uid 글 전부 6시간 차단 + 삭제
7. delete-limit는 기존 broker fallback 재사용
8. 같은 uid 반복 제재는 cooldown/dedupe로 억제

한 줄로 정리하면:

- **“위에는 가시 경고를 그대로 두고, 아래 `분탕자동차단`이 page 1 분탕 uid를 1분 안에 잡아 차단/삭제하는 구조”**

이게 이번 v1의 정확한 목표다.
