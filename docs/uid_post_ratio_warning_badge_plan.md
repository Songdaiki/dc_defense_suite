# 식별코드 글댓비 경고 배지 수동 토글 구현 플랜

## 목표

현재 사용자가 보고 있는 디시인사이드 페이지에서, 작성자 식별코드(`data-uid`)의 활동 통계를 조회해 **글 비중이 90% 이상**이면 작성자 UI 옆에 빨간 경고 배지 `- 분탕주의`를 표시한다.

이 기능은 **수동 토글형**으로 구현한다.

- popup `분탕경고` 탭에서 토글 ON
- ON 상태는 유지되고, 활성 DC 탭이 바뀌거나 새로고침되면 해당 탭에 다시 적용
- 브라우저 재시작 / 확장 service worker 재기동 뒤에도 ON 상태를 복원
- 현재 페이지에 보이는 식별코드 작성자만 조회
- 조건 충족 작성자 옆에 빨간 경고 배지 삽입
- 토글 OFF 시 확장이 배지를 붙였던 탭들에서 전부 제거

## 사용자 기준 기대 동작

예시:

1. 사용자가 디시 게시글 목록 페이지 또는 본문 페이지를 보고 있음
2. popup `분탕경고` 탭에서 토글 ON
3. 확장이 현재 페이지의 `data-uid` 작성자들을 수집
4. 각 uid의 활동 통계를 조회
5. `postRatio >= 90`이면 해당 작성자명 옆에 `- 분탕주의`를 빨간색으로 표시
6. 같은 uid가 페이지에 여러 번 보이면 모두 표시
7. 탭을 옮기면 새 활성 탭에도 다시 적용
8. 브라우저를 다시 켜도 ON 상태면 현재 활성 탭에 다시 적용
9. 토글 OFF 시 확장이 넣은 배지를 제거

즉, **내가 보고 있는 웹페이지 UI 옆에 실제로 `- 분탕주의`가 보이게 하는 기능**이다.

## 기존 스펙 / 실제 코드 재사용 포인트

이 기능은 신규 판정 로직을 만들 필요가 없다.

### 1. uid 추출

게시판 row 파서는 이미 `data-uid`, `data-ip`, `data-nick`를 파싱한다.

- [features/post/parser.js](../features/post/parser.js)

실제 HTML 스펙에도 `gall_writer ub-writer`에 `data-uid`가 존재한다.

- [docs/raw.md](./raw.md)
- [docs/raw2.md](./raw2.md)

### 2. uid 활동 통계 조회

반고닉 분류가 이미 uid 활동 통계를 조회한다.

- [features/semi-post/api.js](../features/semi-post/api.js)

핵심 함수:

- `fetchUserActivityStats(config, uid)`

반환값:

- `postCount`
- `commentCount`
- `totalActivityCount`
- `postRatio`

### 3. 90% 이상 판정 기준

반고닉 분류가 이미 `postRatio >= minPostRatioPercent` 판정을 사용한다.

- [features/semi-post/scheduler.js](../features/semi-post/scheduler.js)

즉 본 기능도 같은 기준을 그대로 재사용하면 된다.

## 구현 방향

## 1. popup에 수동 토글 추가

새 UI는 독립 top-level 탭 `분탕경고`로 둔다.

중요:

- 이 기능은 **새 scheduler 토글이 아니다**
- popup 안에서는 **독립 top-level 탭**으로 보이되, 동작은 수동 DOM 주입형 유틸로 유지한다

이유:

- 현재 popup의 메인 토글들은 전부 background scheduler의 `isRunning` 상태와 연결돼 있다
- 본 기능은 장기 실행 loop가 아니라 **현재 탭에 즉시 적용/제거하는 수동 액션**
- 따라서 generic `feature + start/stop/updateConfig` 흐름에 억지로 넣으면 기존 자동화 토글 의미와 충돌한다

실제 구조상 이 기능은 아래처럼 가는 것이 안전하다.

- `분탕경고` top-level 탭
- 전용 수동 토글 카드
- background custom message
- custom status sync

예상 문구:

- 라벨: `현재 페이지 식별코드 경고`
- 설명: `현재 보고 있는 디시 페이지에서 글 비중 90% 이상 식별코드에 빨간 경고를 붙입니다`

성격:

- 저장형 자동 기능이 아니라 **수동 토글**
- ON 상태는 유지되고, 현재 활성 탭을 기준으로 작동
- ON 여부는 브라우저 재시작 뒤에도 복원

권장 동작:

- ON: 현재 활성 탭에 즉시 적용, 이후 탭 이동/새로고침/브라우저 재시작 시 다시 적용
- OFF: 확장이 배지를 붙였던 탭들에서 제거

### 수동 유틸 카드 디자인

사용자 요청 기준으로, 이 영역은 기존 자동화 토글들과 **색을 다르게** 가져가야 한다.

권장 디자인:

- `분탕경고` 전용 패널 카드
- 자동화 토글의 청록/기본 계열과 분리
- **적갈/붉은 경고 계열** 또는 **주황-적색 계열** accent 사용
- 카드 제목에 `수동 경고`
- 본문에 `현재 페이지 한정`

즉 보자마자 `경고성 수동 기능`임이 바로 보여야 한다.

### 중요: popup은 1초마다 상태를 다시 그린다

현재 popup은 `refreshAllStatuses()`를 1초마다 호출해 토글과 상태를 다시 렌더링한다.

- [popup/popup.js](../popup/popup.js)

즉 이 기능을 진짜 **수동 토글**처럼 보이게 하려면, background가 **전역 ON 상태 + 현재 활성 탭 기준 상태**를 들고 있어야 한다.

권장 상태:

```js
{
  enabled: false,
  applying: false,
  tabId: 123,
  pageUrl: 'https://gall.dcinside.com/...',
  matchedUidCount: 0,
  warnedUidCount: 0,
  lastAppliedAt: 0,
  lastError: ''
}
```

즉 1차는 **저장형 scheduler config가 아니라 background의 ephemeral state**로 관리하는 것이 맞다.

### 중요: `semiPost` scheduler config/state에 넣으면 안 된다

이 기능은 `분탕경고` 탭으로 분리하더라도, 성격은 기존 `semiPost` 자동 분류와 다르다.

기존 `semiPost`는:

- `saveState()/loadState()`
- `isRunning`
- `config`
- 감시 자동화 락

구조를 갖는 **지속형 scheduler**다.

이번 기능은:

- 현재 탭 한 장만
- 수동 ON/OFF
- 화면 배지 주입

이 목적이라서 `semiPost.config`에 섞으면 안 된다.

즉 문서상 원칙은:

- **UI 위치는 `분탕경고` top-level 탭**
- **상태 저장은 `semiPost` scheduler와 분리**
- **background 별도 상태 객체로 관리**

가 맞다.

## 2. background 메시지 액션 추가

popup이 background에 예를 들어 아래 액션을 보낸다.

- `toggleUidRatioWarning`

payload 예시:

```js
{
  action: 'toggleUidRatioWarning',
  enabled: true
}
```

background 역할:

1. 현재 활성 탭 조회
2. DC 페이지인지 확인
3. ON이면 페이지에서 uid 수집
4. uid별 통계 조회
5. 경고 대상 uid 목록 계산
6. 해당 탭 DOM에 경고 배지 주입
7. OFF면 해당 탭 DOM에서 기존 배지 제거

추가로 상태 조회 액션도 필요하다.

- `getUidRatioWarningStatus`

또는 `getAllStatus` 응답에 아래 상태를 포함시킨다.

- `uidRatioWarningStatus`

그래야 popup 토글이 background의 현재 탭 상태와 계속 동기화된다.

실제 구조상 이쪽이 더 맞다.

- 기존 popup은 이미 `getAllStatus` 1회 응답으로 모든 상태를 갱신함
- 따라서 새 액션을 따로 계속 부르기보다
- `getAllStatus`에 `uidRatioWarningStatus`를 추가하는 편이 연결이 단순하다

중요:

- 이 액션은 기존 `feature + start/stop/updateConfig` generic scheduler 라우팅에 태우지 않는다
- `background.handleMessage()` 상단에서 별도 top-level action으로 처리하는 것이 맞다

그래야 `알 수 없는 feature` 경로와 감시 자동화용 수동락에 불필요하게 걸리지 않는다.

## 3. 현재 페이지 DOM 수집 스크립트

`chrome.scripting.executeScript()`로 현재 탭 DOM을 직접 읽는다.

수집 대상:

- `.gall_writer[data-uid]`

수집 정보:

- `uid`
- `nick`
- 요소 식별용 최소 위치 정보

여기서는 **페이지에 실제로 보이는 uid만** 모은다.

중요:

- 이 기능은 **기존 HTML parser를 직접 재사용하지 않는다**
- parser는 서버에서 받은 HTML 문자열용이고
- 본 기능은 **현재 브라우저 탭의 live DOM**에서 직접 uid를 읽는 방향이 맞다

즉 `features/post/parser.js`는 구조/selector 참고용이고, 실제 수집은 injected DOM 스크립트가 담당한다.

중복 uid는 background에서 dedupe한다.

주의:

- `data-uid`가 없는 유동(`data-ip`)은 본 기능 대상이 아니다
- 리스트 페이지 / 본문 페이지 모두 `gall_writer` 기반으로 우선 지원
- 댓글 영역은 1차 범위에서 제외 가능

실제 우선 selector:

- `.gall_writer.ub-writer[data-uid]`

이렇게 좁히는 쪽이 안전하다.

## 4. uid 활동 통계 조회 및 판정

background가 dedupe된 uid 목록에 대해 기존 API를 호출한다.

재사용 함수:

- `fetchUserActivityStats(config, uid)`

판정 기준:

- `stats.success === true`
- `stats.totalActivityCount > 0`
- `stats.postRatio >= 90`

1차는 고정값 90으로 간다.

나중에 필요하면 popup 설정으로 뺄 수 있다.

### 속도 / 실패 처리 주의

기존 `fetchUserActivityStats()`는 `429`, `403`에서 재시도와 backoff가 있다.

- [features/semi-post/api.js](../features/semi-post/api.js)

즉 한 페이지 uid가 많으면 수동 토글 한 번에 꽤 오래 걸릴 수 있다.

1차 권장 원칙:

- uid는 dedupe 후 **순차 조회**
- uid 1건 실패가 전체를 깨지 않게 **best-effort** 처리
- 실패 uid는 건너뛰고 나머지는 계속 진행

권장 보강:

- background에 **짧은 TTL uid stats cache** 추가
- 예: `uid + galleryId` 기준 1~3분 캐시

이렇게 해야 같은 페이지에서 ON/OFF/재적용을 반복할 때 DC API를 과하게 다시 치지 않는다.

## 5. 경고 배지 DOM 주입

경고 대상 uid 목록이 계산되면 다시 `chrome.scripting.executeScript()`로 현재 탭에 주입한다.

주입 규칙:

- 해당 uid의 `.gall_writer[data-uid="..."]` 옆에만 표시
- 텍스트: `- 분탕주의`
- 색상: 빨간색
- 확장 주입 요소임을 식별할 수 있게 `data-defense-warning-badge="uid-ratio"` 속성 부여

중복 주입 방지:

- 기존 배지가 있으면 다시 만들지 않음

OFF 처리:

- `data-defense-warning-badge="uid-ratio"` 요소 전부 제거

권장 구현:

- 경고 적용 전에 현재 탭의 기존 `uid-ratio` 배지를 먼저 정리
- 그 뒤 최신 경고 대상만 다시 주입

즉 **재적용은 replace 방식**으로 가는 것이 가장 안전하다.

## 5-1. ON/OFF 도중 경쟁 상태 방지

수동 토글이지만, ON 직후 popup을 닫거나 OFF를 빠르게 누를 수 있다.

그래서 background에는 탭별 실행 세대(`generation`) 또는 scan token이 필요하다.

예시:

1. ON -> scanGeneration = 3
2. uid 통계 조회 중
3. 사용자가 OFF
4. background는 generation 4로 바꾸고 배지 제거
5. 늦게 끝난 generation 3 결과는 **주입하지 않고 폐기**

즉 OFF 후 늦게 끝난 이전 스캔이 다시 배지를 붙이는 경쟁 상태를 막아야 한다.

참고:

- 1차에 API fetch 자체의 즉시 abort까지는 없어도 된다
- 대신 **결과 반영 차단**은 반드시 필요하다

## 6. 토글 상태 범위

1차는 **현재 탭 수동 표시기**로 한정한다.

즉:

- ON 했을 때 그 순간 활성 탭에만 적용
- 탭 이동/새 페이지 이동 후 자동 재주입은 1차 범위 밖
- 새 페이지에서 다시 보고 싶으면 사용자가 수동으로 다시 ON

이렇게 해야 구현이 단순하고 기존 scheduler와 안 엉킨다.

### 탭 이동 / 새로고침 처리

페이지 이동 후 자동 재주입을 하지 않을 거라면, background가 들고 있는 이 토글 상태도 같이 정리해야 한다.

권장:

- `tabs.onUpdated`에서 URL이 바뀌거나 loading이 시작되면 해당 탭 상태를 `enabled=false`로 초기화
- `tabs.onRemoved`에서도 해당 탭 상태 제거

이렇게 해야 popup을 다시 열었을 때 예전 페이지 기준 ON 상태가 남지 않는다.

추가 확인:

- 현재 manifest에는 `tabs`, `scripting` 권한이 이미 있으므로 구현 자체는 가능
- 별도 content script 등록은 필요 없다

## 실제 호출 흐름

### ON

1. popup 토글 ON
2. background `toggleUidRatioWarning(enabled=true)` 호출
3. 활성 탭 조회
4. 해당 탭에서 `data-uid` 작성자 목록 수집
5. uid dedupe
6. `fetchUserActivityStats()` 반복 호출
7. `postRatio >= 90` uid 목록 생성
8. 해당 uid 요소 옆에 `- 분탕주의` 주입
9. popup에 성공/실패 메시지 표시

### OFF

1. popup 토글 OFF
2. background `toggleUidRatioWarning(enabled=false)` 호출
3. 활성 탭 조회
4. 현재 탭에서 확장 주입 배지 제거
5. popup에 성공/실패 메시지 표시

### popup UX 권장

토글 ON 직후에는 background 상태를 바탕으로 아래처럼 보이는 것이 좋다.

- `검사 중`
- `경고 0명`
- `경고 4명`
- `오류`

즉 단순 ON/OFF만이 아니라 **현재 탭 경고 적용 상태 텍스트**도 같이 두는 것이 UX상 안전하다.

### 자동화 락과 분리

현재 popup에는 감시 자동화 실행 시 `post/semiPost/ip`를 막는 UI 락이 있다.

- [popup/popup.js](../popup/popup.js)

이번 기능은:

- 게시글 분류/반고닉 분류/IP 차단을 조작하는 기능이 아니라
- **현재 탭 화면 경고 표시기**

이므로 기존 `applyAutomationLocks()`의 semiPost 락에 같이 묶지 않는 것이 맞다.

즉:

- `반고닉 분류` 패널 안에 있더라도
- **기존 semiPost toggle/save/reset과 별개로 동작**

해야 한다.

## 왜 기존 반고닉 분류와 분리하는가

기존 `semiPost` scheduler는:

- 여러 페이지 순회
- uid 그룹별 판정
- 도배기 분류 API 호출

을 수행하는 자동 기능이다.

이번 기능은:

- 현재 보는 페이지 한 장만
- uid 통계 조회
- 화면 경고 배지 표시

가 목적이다.

즉 판정 데이터는 재사용하지만, **운영 형태는 별도 수동 UI 기능**으로 분리하는 것이 맞다.

## 엣지 케이스

### 1. uid가 없는 유동/고정닉

- 경고 대상 아님
- 무시

### 2. 동일 uid가 페이지에 여러 번 등장

- 통계 조회는 1회만
- 표시만 여러 곳에 반영

### 3. 통계 조회 실패

- 해당 uid는 표시하지 않음
- popup 또는 로그에 실패 수만 간단히 남김

### 4. 현재 탭이 DC 페이지가 아님

- 기능 실행 차단
- `디시 페이지에서만 사용할 수 있습니다.` 메시지 반환

### 5. 현재 페이지에 uid 작성자가 없음

- `표시할 식별코드 작성자가 없습니다.` 반환

### 6. 토글 ON 상태에서 다시 ON

- 중복 주입 없이 재계산/재주입만 수행하거나 no-op 처리

### 7. popup을 닫았다 다시 열었을 때

- background가 현재 탭 임시 상태를 들고 있으면
- 같은 탭/같은 페이지에서는 토글 상태를 다시 복원할 수 있어야 한다

즉 **popup local state가 아니라 background source of truth**여야 한다.

### 8. 현재 탭이 감시 자동화/수동 분류와 동시에 열려 있을 때

이 기능은 화면 경고 배지 표시만 하는 수동 기능이므로

- `semiPost` scheduler 실행 여부와는 별도로 작동 가능
- 단, uid 통계 조회 API는 공유하므로 요청이 오래 걸릴 수는 있다

따라서 1차는 **별도 락 없이 best-effort**로 두되, background log에만 남기는 방향이 적절하다.

### 9. 기존 background generic feature route에 넣지 않기

현재 `background/background.js`는 scheduler feature만 아래 흐름으로 받는다.

- `feature`
- `start`
- `stop`
- `updateConfig`
- `resetStats`

본 기능은 여기에 얹는 것보다 아래처럼 custom action으로 빼는 편이 안전하다.

- `toggleUidRatioWarning`
- `getAllStatus` 안의 `uidRatioWarningStatus`

즉 `semiPost`의 `isRunning`이나 `config`와 섞지 않는 것이 기존 플로우 보존에 유리하다.

## 1차 비범위

아래는 1차 범위에서 제외한다.

- 댓글 작성자 경고
- 탭 이동 시 자동 재주입
- 페이지 변경 감지 자동 반영
- 임계값 사용자 설정화
- 경고 클릭 시 상세 통계 팝오버

## 구현 파일 범위

예상 수정 범위:

- [popup/popup.html](../popup/popup.html)
- [popup/popup.js](../popup/popup.js)
- [background/background.js](../background/background.js)
- 신규 helper 또는 background 내부 DOM 주입 함수
- 필요 시 신규 문서 보강

기존 재사용:

- [features/semi-post/api.js](../features/semi-post/api.js)
- [features/post/parser.js](../features/post/parser.js)

## 검증 포인트

1. 목록 페이지에서 uid 작성자 옆에만 배지가 붙는지
2. 같은 uid가 여러 글에 있어도 전부 붙는지
3. `postRatio >= 90`만 경고가 붙는지
4. OFF 시 확장 주입 배지만 제거되는지
5. 유동(`data-ip`) 글에는 안 붙는지
6. DC 외 페이지에서는 실행 차단되는지
7. 통계 조회 실패 uid가 전체 기능을 깨지 않는지

## 최종 판단

이 기능은 **기존 반고닉 분류 스펙과 실제 코드만으로 충분히 구현 가능**하다.

신규로 필요한 것은:

- popup 수동 토글
- 현재 탭 DOM 수집
- 현재 탭 DOM 경고 배지 주입

뿐이다.

즉, **판정 로직은 재사용하고 표시만 현재 웹페이지 UI에 붙이는 기능**으로 보는 게 맞다.
