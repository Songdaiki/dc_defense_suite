# 개념글순회 window snapshot 방어 계획

## 목적

기존 `개념글 방어`는 개념글 page 1의 최신 snapshot 몇 개만 빠르게 검사한다.
이 방식은 최신 개념글 오염 대응에는 유리하지만,

- 예전에 추천을 올려둔 오래된 글이
- 추천컷이 다시 낮아진 시점에
- 개념글 뒤페이지(`2~5페이지` 등)로 새로 진입하는 공격

을 놓칠 수 있다.

이번 기능은 이 사각지대를 메우기 위해,

- **기존 `개념글 방어`와 별개 탭**
- **개념글 1~5페이지 통합 window snapshot**
- **이전 window에 없던 postNo만 추가 검사**

를 수행하는 저속 순회형 보조 자동화를 정의한다.

탭명은 `개념글순회` 로 고정한다.
코드 내부 feature id는 `conceptPatrol` 로 고정한다.

공용 판정/해제 계약은 아래 참조 스펙을 따른다.

- [concept_patrol_shared_release_reference_spec.md](/home/eorb915/projects/dc_defense_suite/docs/concept_patrol_shared_release_reference_spec.md)

## 실제 구현 전 추가로 고정해야 하는 운영 원칙

이 문서는 바로 패치 가능한 수준까지 가려면 아래 원칙도 같이 고정해야 한다.

- 기존 `개념글 방어`와 **동시에 켜질 수는 있지만**
  - **page 1 최신 snapshot 범위는 기존 `개념글 방어`가 running이고 block cooldown 중이 아닐 때만 우선 담당**한다
- 순회 cycle 중 `page 1~5` 중 **하나라도 fetch 실패하면**
  - 그 cycle 결과로 baseline을 갱신하지 않는다
- 수동으로 새로 ON 한 경우 첫 cycle은 항상 **fresh baseline-only**
- service worker 재시작 복원은
  - 실행 중이던 상태라면 저장된 baseline을 그대로 재사용
- 공통 설정의 `galleryId` 변경이나 `patrolPages` 변경 시
  - 기존 baseline은 무효화하고 다시 baseline-only부터 시작
- 공통 설정의 `galleryId` 변경 시
  - `conceptPatrol` baseline뿐 아니라
  - shared recommend-cut coordinator의 patrol hold state도 같이 초기화한다
- 개념글 목록 차단/403이 발생하면
  - 기존 `conceptMonitor`와 비슷한 block cooldown을 둔다
- 추천컷 실제 API 적용은 기존 `conceptMonitor` private method에 묶지 않는다
  - 새 `conceptPatrol`은 추천컷을 직접 소유하지 않고
  - **방어 hold 요청**만 올린다
  - 실제 `100 / 14` 적용은 두 기능이 공용으로 쓰는
    **shared recommend-cut coordinator/helper**가 담당한다

추가로 아래 숨은 이슈를 구현 전에 같이 고정해야 한다.

- `conceptMonitor`가 꺼져 있거나 `autoCutEnabled=false`여도
  - `conceptPatrol`은 독립 동작할 수 있어야 한다
- 따라서 “추천컷 owner”는 **기존 `conceptMonitor` scheduler run loop 자체**가 아니라
  - 두 기능이 공통으로 호출할 수 있는 **shared recommend-cut coordinator/helper**
  - 또는 동등한 공용 owner 계층
  로 정리하는 편이 안전하다
- `conceptMonitor`의 `autoCutEnabled`는
  - **board page 1 추천 증가량 기반 방어 ON/OFF**
  만 담당한다
- 따라서 `autoCutEnabled=false`여도
  - `conceptPatrol` hold가 걸리면
  - shared recommend-cut coordinator는 `100` 적용을 수행할 수 있어야 한다
- `conceptMonitor.resetStats`, `galleryId` 변경, auto-cut ON/OFF 변경이
  - `conceptPatrol`의 hold state를 실수로 덮어쓰지 않도록
  - 추천컷 상태 저장은 feature별 state와 별도로 관리하는 편이 낫다
- 따라서 `conceptMonitor.resetStats`는
  - `conceptMonitor` 통계/로그와 auto-cut 내부 카운터만 초기화하고
  - patrol hold state는 건드리지 않는 편이 맞다
- 반대로 `conceptPatrol.resetStats`도
  - 자기 baseline/통계/로그만 초기화하고
  - `conceptMonitor` auto-cut 공격 히트 카운터는 건드리지 않는 편이 맞다
- shared recommend-cut coordinator 상태는
  - explicit shared reset
  - 또는 `galleryId` 변경
  에서만 초기화하는 것이 안전하다
- `patrolPages` 변경은 baseline 의미를 깨므로
  - 실행 중 변경 허용보다 **정지 후 변경**이 1차 구현에 더 안전하다
- `testMode=true`여도
  - 실제 조작 후보 판정 자체는 수행되므로
  - patrol hold는 **테스트 모드에서도 활성화**되는 편이 운영상 맞다
- 현재 실제 구현에는
  - `fetchConceptListHTML(config)`만 있고 `page` 인자가 없으며
  - pagination에서 `detectedMaxPage`를 파싱하는 helper도 없다
- 따라서 `conceptPatrol` 구현 전에는
  - `fetchConceptListPageHTML(config, page)`
  - `parseConceptListDetectedMaxPage(html)`
  두 계약을 새로 명시적으로 추가해야 한다
- popup/background wiring도 새로 필요하다
  - popup top-level tab 추가
  - `background` scheduler registry 추가
  - `getAllStatuses()` 응답에 `conceptPatrol` 상태 포함
  - `applySharedConfig()` gallery reset 경로에 `conceptPatrol` state reset 포함
  - `getBusyFeatures()`와 running config guard에 `conceptPatrol` 포함

## 기존 로직의 한계

현재 `features/concept-monitor`는 아래 구조다.

- 개념글 release cycle:
  - 개념글 목록 page 1만 조회
  - `snapshotPostLimit` 기본 `5`
- 자동 추천컷:
  - 전체글 page 1 추천 증가량만 비교

즉 현재 구현은 실제로

- `개념글 전체 오염 감시`
가 아니라
- `개념글 page 1 최신부 빠른 감시`

에 가깝다.

이 구조에서는

- page 1 최신 5개 바깥으로 밀려 있는 개념글
- 뒤페이지에서 새로 window 안으로 들어온 오래된 글

이 기본적으로 검사 대상이 아니다.

또한 기존 `conceptMonitor`의 auto-cut은

- 전체글 page 1 추천 증가량
- `NORMAL / DEFENDING`

만 기준으로 움직인다.

즉 새 `conceptPatrol`이 뒤페이지 조작을 감지했을 때
상태 공유 없이 따로 `개념컷 100`만 올리면,
기존 `conceptMonitor`가 다음 cycle에서 다시 `14`로 내릴 수 있다.

따라서 새 기능의 “컷 100 방어 트리거”는
기존 `conceptMonitor` auto-cut 상태와 **충돌 없이 결합**되어야 한다.

## 새 기능의 위치

이번 기능은 `개념글 방어` 내부 옵션이 아니다.

- popup top-level 탭에 **새 feature 하나를 추가**
- 위치는 `개념글 방어` 바로 옆
- 기존 `conceptMonitor`와 scheduler / parser / state / UI를 섞지 않는다

즉 구조는:

- 기존 `conceptMonitor`
  - 최신 page 1 빠른 lane
- 새 `conceptPatrol`
  - 1~5페이지 통합 snapshot 순회 lane

로 분리한다.

## 핵심 아이디어

### 1. page별 snapshot이 아니라 window snapshot을 쓴다

단순히 page 1, page 2, page 3을 각각 따로 snapshot 비교하면,

- 신규 개념글 1개가 page 1 맨 위에 생길 때
- 기존 page 1 마지막 글이 page 2로 밀리고
- page 2 마지막 글이 page 3으로 밀리는 식의 **연쇄 이동**

까지 모두 “새 글”처럼 보일 수 있다.

그래서 비교 기준은

- `page 1~5` 전체를 합친 **통합 window**
- 즉 최대 `250개 postNo`

여야 한다.

### 2. 검사 대상은 “현재 window에 새로 들어온 postNo”만 본다

매 cycle마다:

1. 개념글 `page 1~5` list HTML을 읽는다
2. 실제 게시물 row에서 `postNo`를 추출한다
3. `currentWindowPostNos`를 만든다
4. `newPostNos = currentWindowPostNos - previousWindowPostNos`
5. **`newPostNos`만 view fetch / 해제 후보 판정**
6. cycle 끝에 `previousWindowPostNos = currentWindowPostNos`

이렇게 가면

- page 이동으로 밀린 기존 글
- page 1에서 page 2로 내려간 글
- page 3에서 page 4로 내려간 글

은 새로 들어온 글로 오인하지 않는다.

## 예시

이전 window:

- `A, B, C, D, ... Y, Z`

다음 window:

- `N, A, B, C, D, ... X, Y`

여기서 실제 변화는:

- 새로 window 안에 들어온 글: `N`
- window 밖으로 밀려난 글: `Z`

검사 대상은:

- `N` 하나만

이다.

`A`, `B`, `C`가 page 1/2/3 안에서 위치가 바뀌더라도 검사 대상이 아니다.

## 초기 baseline 정책

첫 실행에서는 기존 1~5페이지 window 전체가 전부 “새 글”처럼 보일 수 있다.

그래서 **초기 1회는 baseline만 저장**한다.

즉:

1. 첫 실행
2. `page 1~5` 통합 window snapshot 생성
3. `previousWindowPostNos` 저장
4. **inspect는 하지 않음**
5. 다음 cycle부터 `newPostNos`만 검사

이 규칙을 고정한다.

이렇게 해야 최초 ON 직후 오래된 개념글 250개를 한 번에 다 두드리는 사고를 막을 수 있다.

추가 원칙:

- 사용자가 수동으로 OFF 후 다시 ON 한 경우도
  - **새 실행으로 보고 baseline-only부터 다시 시작**
- 단, service worker 재시작 복원처럼
  - **기능이 계속 running 상태였던 복원**은
  - 저장된 baseline을 유지하고 즉시 다음 cycle을 진행한다

즉:

- `manual fresh start` = baseline-only
- `runtime resume` = saved baseline reuse

로 구분한다.

## 검사 범위

### 1. 기본 범위

- 개념글 목록 `page 1~5`
- 각 페이지 기본 `50개 row`
- 최대 window `250개 postNo`

실제 fetch 범위는 아래처럼 고정한다.

- page 1에서 pagination을 읽어 `detectedMaxPage`를 파악
- 실순회 범위는 `1 ~ min(patrolPages, detectedMaxPage)`

즉 갤러리의 실제 개념글 페이지 수가 5보다 작으면
존재하는 페이지까지만 순회한다.

### 2. 추출 대상

- `공지`, `설문`, 숫자 글번호가 아닌 row 제외
- 실제 게시물 row만 추출
- 현재 row의 `postNo`
- 가능하면 `currentHead`, `subject`도 같이 저장

### 3. 부가 저장 정보

로그와 운영 가시성을 위해 아래 정보를 같이 저장하는 편이 좋다.

- `postNo -> firstSeenAt`
- `postNo -> detectedPage`
- `postNo -> currentHead`
- `postNo -> subject`

이러면 로그를:

- `📥 개념글 신규 진입 감지 #104xxxx (3페이지)`

처럼 남길 수 있다.

## 실제 검사 플로우

### 1. 순회 cycle

1. `page=1` fetch
2. page 1에서 `detectedMaxPage` 계산
3. `page=2 ... page=min(5, detectedMaxPage)` fetch
4. 모든 대상 페이지 fetch가 **전부 성공했을 때만**
5. 실제 게시물 row의 `postNo`를 합친다
6. `currentWindowPostNos` 생성
7. 저장된 `previousWindowPostNos`와 비교
8. `newPostNos` 계산
9. 초기 baseline 미구축 상태면 저장만 하고 종료
10. baseline이 있으면 `newPostNos`만 inspect
11. inspect 종료 후 baseline 갱신

중요:

- page fetch가 하나라도 실패하면
  - **그 cycle은 baseline commit 없이 종료**
  - 다음 cycle 재시도

이 규칙이 없으면 불완전한 window snapshot으로 baseline이 오염될 수 있다.

### 2. inspect 단계

`newPostNos`에 대해서만:

1. 개별 view HTML fetch
2. 현재 개념글 여부 확인
3. 총추천 / 고정닉 추천 수 파싱
4. 유동 추천 비율 계산
5. 기준 충족 시 후보 기록
6. 테스트 모드면 로그만
7. 실제 모드면 `set_recommend(mode=REL)` 해제 시도
8. 재확인 view fetch

즉 기존 `conceptMonitor.inspectPost()` 계열 판정 로직은 가능한 한 재사용하고,
**대상 수집 방식만 새 window-snapshot 방식으로 분리**한다.

### 3. 기존 `개념글 방어`와 중복 방지

`개념글 방어`는 page 1 최신 snapshot 기본 5개를 이미 빠르게 검사한다.

따라서 새 `개념글순회`는 중복 요청을 줄이기 위해,
`currentWindow` 안의 `newPostNos` 중에서도

- **page 1**
- 그리고 **기존 `개념글 방어` snapshot 범위 안**

에 들어가는 글은 아래 조건이 모두 맞을 때만 기본적으로 스킵한다.

- `conceptMonitor.isRunning === true`
- `conceptMonitor.blockedUntilTs <= now`
- `conceptMonitor`가 실제로 쓰는 `snapshotPostLimit` 범위 안

즉 새 기능의 주된 담당은:

- page 1 snapshot 바깥의 신규 진입 글
- page 2~5 신규 진입 글

이다.

즉:

- `conceptMonitor.isRunning === true`
  - 그리고 `blockedUntilTs <= now`
  - page 1 최신 snapshot 범위는 `conceptMonitor` 우선
- `conceptMonitor.isRunning === false`
  - `conceptPatrol`이 page 1 신규 진입 글도 직접 검사
- `conceptMonitor.isRunning === true`
  - 하지만 block cooldown 중이면
  - `conceptPatrol`이 page 1 최신 snapshot 범위도 직접 검사

추가 원칙:

- 이 overlap skip 판단은 저장된 과거 값이 아니라
  - 매 cycle의 **실시간 `conceptMonitor` status**
  - 특히 `snapshotPostLimit`, `isRunning`, `blockedUntilTs`
  를 기준으로 계산해야 한다
- 이유:
  - 현재 `conceptMonitor`는 실행 중에도 일부 설정 변경이 가능하고
  - `snapshotPostLimit`도 live config로 바뀔 수 있기 때문이다

이 규칙을 두는 이유:

- 같은 글을 두 scheduler가 동시에 inspect/release 하는 중복을 줄이기 위함
- page 1 최신부는 기존 빠른 lane에 맡기고
- 새 기능은 뒤페이지 보강 lane 역할에 집중하기 위함

## 기존 개념글 방어와 역할 분리

### 기존 `개념글 방어`

- page 1 빠른 감시
- 최신부 오염 빠른 대응
- auto recommend cut 조절

### 새 `개념글순회`

- 1~5페이지 느린 순회
- window 신규 진입 글 감지
- 뒤페이지 개념글 신규 진입 탐지
- 오래된 글의 delayed concept 진입 대응
- 뒤페이지 조작 신규 진입 다발 감지 시 개념컷 100 방어 hold 요청

즉 새 기능은 `개념글 방어`를 대체하는 게 아니라,
**기존 빠른 lane의 사각지대를 메우는 느린 lane**이다.

## 조작 다발 감지 시 개념컷 100 연동

사용자 운영 의도는 아래 흐름으로 고정한다.

예시:

1. 처음 1회 `1~5페이지` baseline만 저장
2. 이후 주기마다 `1~5페이지` 순회
3. `250개 window` 안의 신규 진입 글만 검사
4. 검사 결과 실제 조작으로 확인된 글은 개념글 해제
5. **한 cycle 안에서 조작 확인 2건 이상이면 개념컷 100 방어 hold**
6. **5분 후 복귀 시도**
7. 단, 기존 `개념글 방어`의 auto-cut 상태가 `NORMAL`이 아니면
   - 즉 여전히 공격 증가량 상태면
   - `14`로 복귀하지 않음

이 요구사항은 채택한다.

### 1. 왜 직접 `updateRecommendCut(100)`만 때리면 안 되는가

현재 기존 `conceptMonitor`는:

- `autoCutState`
- `ensureRecommendCutApplied(state)`

를 통해 추천컷 owner처럼 동작한다.

즉 새 기능이 아무 상태 공유 없이 직접 `100`을 올려도,
기존 `conceptMonitor`가 다음 auto-cut cycle에서

- `NORMAL`
- `lastAppliedRecommendCut = 14`

라고 판단하면 다시 `14`를 적용할 수 있다.

하지만 실제 코드 기준으로는 여기서 한 단계 더 분리해야 한다.

- `conceptMonitor`가 OFF일 수 있음
- `autoCutEnabled=false`일 수 있음
- `resetConceptMonitorSchedulerState()`가 현재 auto-cut 관련 값을 직접 초기화함
- 공통 설정의 `galleryId` 변경도 `conceptMonitor` 상태 전체를 리셋함

따라서 1차 구현 원칙은:

- **추천컷 실제 API 적용 owner는 기존 `conceptMonitor` scheduler private state가 아니라**
  - 두 기능이 공용으로 부를 수 있는 coordinator/helper로 둔다
- 기존 `conceptMonitor`는
  - board page 1 추천 증가량을 바탕으로
  - coordinator에 자기 `autoCutState`를 반영하는 producer 중 하나가 된다
- 새 `conceptPatrol`은
  - `forceDefendingUntilTs`
  - 또는 동등한 **patrol defense hold state**
  를 올리는 방식

으로 고정한다.

### 2. 추천컷 최종 상태 계산

공용 recommend-cut coordinator는 아래 두 입력을 함께 봐야 한다.

1. 기존 auto-cut 상태
   - `NORMAL`
   - `DEFENDING`
2. 새 `conceptPatrol` hold 상태
   - `forceDefendingUntilTs > now`

여기서 `autoCutState`는 `conceptMonitor` scheduler private field를 직접 읽는 구조보다
공용 coordinator state에 반영된 최종 입력으로 보는 편이 안전하다.

최종 추천컷 상태는 아래처럼 계산한다.

```txt
if (autoCutState === DEFENDING) => 100
else if (patrolForceDefendingActive) => 100
else => 14
```

즉:

- patrol이 hold를 걸었으면
  - auto-cut이 NORMAL이어도 100 유지
- patrol hold가 만료됐더라도
  - auto-cut이 아직 DEFENDING이면 100 유지
- 둘 다 아니어야만 14 복귀

추가 원칙:

- `conceptMonitor`가 완전히 OFF여도
  - patrol hold가 active면 `100` 유지 가능해야 한다
- `conceptMonitor.autoCutEnabled=false`여도
  - patrol hold가 active면 `100` 유지 가능해야 한다
- 사용자가 `conceptMonitor`를 OFF로 내려도
  - active patrol hold는 즉시 사라지지 않고
  - hold 만료 또는 explicit shared reset 전까지 유지되는 편이 안전하다

### 3. patrol hold 트리거

한 cycle 안에서:

- `newPostNos` 중 실제 조작으로 확인되어
- 해제 후보로 판정된 글 수가
- `>= 2`

면 patrol hold를 건다.

기본값:

- `patrolDefendingCandidateThreshold = 2`
- `patrolDefendingHoldMs = 300000` (5분)

이 threshold 판정은 **테스트 모드 여부와 무관하게**
실제 조작 후보로 판정된 개수 기준으로 계산한다.

### 4. hold 시점

hold는 “신규 진입 검사 cycle” 안에서 아래 시점에 건다.

- 신규 진입 글 inspect 완료
- candidate 수 집계 완료
- threshold 이상이면
  - `forceDefendingUntilTs = now + 5분`
  - 즉시 기존 `conceptMonitor` owner에게 추천컷 재평가 요청

### 5. hold 만료 후 복귀

hold 만료 시점에 바로 14로 내리는 게 아니라,
공용 recommend-cut coordinator가 최종 상태를 다시 계산한다.

즉:

- `forceDefendingUntilTs <= now`
- 하지만 `conceptMonitor.autoCutState === DEFENDING`
  - 여전히 100 유지
- `forceDefendingUntilTs <= now`
- 그리고 `conceptMonitor.autoCutState === NORMAL`
  - 그때만 14 복귀 가능

즉 복귀도 `conceptMonitor.ensureRecommendCutApplied()`에 의존하지 않고,
공용 coordinator가 최종 상태 계산 후 직접 적용하는 형태가 더 안전하다.

추가 원칙:

- `conceptPatrol`을 OFF로 내렸다고 해서
  - 이미 active한 patrol hold를 즉시 해제할지
  - 만료 시점까지 유지할지는 정책으로 먼저 고정해야 한다
- 1차 권장값은:
  - **OFF 이후에도 이미 올라간 hold는 만료 시점까지 유지**
  - 이유는 방금 감지한 공격 신호를 사용자가 기능을 끈 순간 즉시 풀어버리면
    보호 효과가 과도하게 사라질 수 있기 때문이다

### 6. 연장 정책

hold가 이미 걸려 있는 동안 또 threshold 이상 cycle이 나오면:

- `forceDefendingUntilTs = now + 5분`

으로 **뒤로 연장**한다.

즉 조작 신규 진입이 계속 나오면 hold가 자연스럽게 연장된다.

## 주기 정책

이 기능은 page 1만 보는 기존 개념글 방어보다 느리게 돌려야 한다.

권장 기본값:

- `pollIntervalMs = 180000` (3분)

이유:

- 개념글 `1~5페이지` list HTML fetch 5회
- `newPostNos`가 있을 때만 추가 view fetch
- page 1 빠른 lane과 충돌하지 않게 충분히 여유를 둠

1차 기본 운영은:

- `3분`
- 테스트 모드 ON

으로 둔다.

사용자 예시는 30초였지만,
기본값은 `3분`을 권장한다.

다만 UI에서는 `pollIntervalMs`를 editable로 두고,
운영자가 `30초`까지 낮추는 것은 허용한다.

반면 `patrolPages`는 UI editable로 두되,
1차 구현에서는 실행 중 변경 시 baseline 일관성이 깨지기 쉬우므로
**정지 후 변경만 허용**하는 편이 맞다.

이는 실제 메인 background가 `conceptMonitor`의 일부 설정만 실행 중 변경을 제한하고 있고,
새 `conceptPatrol`에는 별도 running change guard를 새로 넣어야 하기 때문이다.

추가 운영 원칙:

- 차단/403 응답 감지 시
  - 기존 `conceptMonitor`처럼 block cooldown을 둔다
- 기본 권장값:
  - `BLOCK_COOLDOWN_MS = 30분`

즉 이 기능도 “느리지만 계속 시도”가 아니라,
차단 신호가 오면 과감히 식혀야 한다.

## 저장 상태

별도 feature state를 둔다.

예시:

```js
{
  isRunning: false,
  cycleCount: 0,
  lastPollAt: '',
  lastWindowSize: 0,
  lastNewPostCount: 0,
  totalDetectedCount: 0,
  totalReleasedCount: 0,
  totalFailedCount: 0,
  logs: [],
  baselineReady: false,
  previousWindowPostNos: [],
  previousWindowMeta: {
    "1046651": { page: 1, subject: "...", currentHead: "일반", firstSeenAt: "..." }
  },
  config: {
    galleryId: 'thesingularity',
    pollIntervalMs: 180000,
    patrolPages: 5,
    fluidRatioThresholdPercent: 90,
    patrolDefendingCandidateThreshold: 2,
    patrolDefendingHoldMs: 300000,
    testMode: true,
  }
}
```

추가 상태가 필요하다.

```js
{
  blockedUntilTs: 0,
  lastDetectedMaxPage: 0,
  baselineVersionKey: 'thesingularity:5',
  forceDefendingUntilTs: 0,
  lastPatrolCandidateCountForCut: 0,
}
```

`baselineVersionKey`는 최소한 아래가 바뀌면 새 baseline으로 취급하기 위한 키다.

- `galleryId`
- `patrolPages`

## parser / API 방향

### 1. list-only parser 추가

새 기능은 기존 `parseConceptListPosts(html, limit)`와는 역할이 다르다.

필요한 것은:

- 특정 page의 개념글 list HTML 전체에서
- 실제 게시물 row 전부를 추출하는 parser

이다.

예시:

- `parseConceptListPagePosts(html)`

반환값:

```js
[
  {
    no: '1046651',
    currentHead: '일반',
    subject: '...',
    sourcePage: 1,
  }
]
```

### 2. page fetch API 추가

현재 `fetchConceptListHTML(config)`는 page 1만 본다.

새 기능용 API는:

- `fetchConceptListHTML(config, page)`

또는 별도 함수

- `fetchConceptListPageHTML(config, page)`

로 가는 게 맞다.

이 API는:

- `exception_mode=recommend`
- `page=<n>`

을 함께 붙여야 한다.

추가로 page 1 HTML에서 실제 순회 상한을 잡기 위해

- `parseConceptListDetectedMaxPage(html)`

또는 동등한 pagination parser가 필요하다.

## 비교 정책

### 1. 기준은 set difference

비교는 page별 순번이 아니라

- `Set(postNo)`

기준으로 한다.

### 2. 신규 진입 후보

```js
newPostNos = currentWindowPostNos - previousWindowPostNos
```

### 3. window 이탈 글

```js
removedPostNos = previousWindowPostNos - currentWindowPostNos
```

`removedPostNos`는 기본적으로 운영 로그용이다.
이탈 자체로는 해제/검사 트리거로 쓰지 않는다.

## baseline 무효화 정책

아래 경우 기존 baseline은 그대로 쓰면 안 된다.

1. `galleryId` 변경
2. `patrolPages` 변경
3. 수동 OFF 후 다시 ON
4. 사용자가 명시적으로 통계/상태 초기화

이 경우:

- `baselineReady = false`
- `previousWindowPostNos = []`
- 다음 cycle은 baseline-only

로 처리한다.

반면 아래 경우에는 baseline을 유지한다.

1. service worker 재시작 복원
2. popup 닫았다 다시 열기
3. 단순 status refresh

즉 “실행이 끊긴 새 시작”과 “러닝 상태 복원”을 구분해야 한다.

## 로그 정책

예시:

- `🧭 개념글순회 시작! (테스트 모드)`
- `🗂️ 개념글 window snapshot 250개 확보 (1~5페이지)`
- `🧱 초기 baseline 저장 완료 - 이번 cycle은 신규 검사 없음`
- `📥 개념글 신규 진입 감지 #104xxxx (3페이지)`
- `🎯 신규 개념글 해제 후보 #104xxxx - 총추천 31, 고정닉 0, 유동비율 1.00`
- `🧪 테스트 모드 - 해제 미실행 #104xxxx`
- `✅ 개념글 해제 완료 #104xxxx`

## UI 최소 스펙

탭명:

- `개념글순회`

상태:

- ON/OFF
- 최근 폴링
- 최근 detected max page
- 최근 window 크기
- 최근 신규 진입 수
- 누적 후보 수
- 누적 해제 수
- 누적 실패 수
- patrol 방어 hold 상태
- patrol 방어 hold 만료 시각

설정:

- 검사 주기
- 순회 페이지 수 (기본 5)
- 유동 추천 비율 기준
- 조작 다발 threshold (기본 2)
- patrol hold 시간 ms (기본 300000)
- 테스트 모드

## 구현 범위

이번 작업 범위는 아래를 포함한다.

1. popup top-level 탭 추가
2. background feature registry 추가
3. `features/concept-window-patrol/` 또는 동등한 새 feature 폴더 추가
4. 개념글 page fetch API 추가
5. list-only page parser 추가
6. 통합 window snapshot 비교 로직 추가
7. 초기 baseline 저장 로직 추가
8. 신규 진입 post만 inspect / release 로직 연결
9. save/load/resume 지원
10. 기존 `conceptMonitor`와 상태/로그/설정 완전 분리
11. 공통 설정 `galleryId` 변경 시 baseline reset 연결
12. page fetch 일부 실패 시 baseline commit 금지
13. page 1 빠른 lane와의 중복 방지 연결
14. popup top-level 탭 추가에 따른 tab grid / panel wiring 수정
15. `conceptMonitor`와 patrol hold state 연동
16. patrol hold 만료 시 기존 auto-cut 상태와 함께 최종 추천컷 재평가
17. 공용 recommend-cut coordinator/helper 추가 또는 동등한 owner 분리
18. `conceptMonitor` OFF 시 page 1 신규 진입을 `conceptPatrol`이 직접 담당하는 조건 분기
19. `testMode`에서도 patrol hold가 동작하도록 후보 카운트와 해제 실행을 분리
20. `patrolPages` 실행 중 변경 차단 또는 atomic baseline reset 처리

## 의도적으로 하지 않는 것

1차에서는 아래는 하지 않는다.

- page 1~5의 기존 250개 전체를 매번 deep inspect
- page 이동만으로 발생한 기존 글 재검사
- page 6 이후 전범위 순회
- 개념컷 auto-cut 로직을 새 기능에 섞기
- 기존 `conceptMonitor` 안에 옵션 하나 더 추가해서 억지로 통합하기

즉 “개념컷 조절 owner” 자체를 새 기능으로 옮기지는 않는다.
새 기능은 hold 신호를 올리고,
최종 owner는 기존 `conceptMonitor`를 유지한다.

## 한 줄 정리

새 `개념글순회`는

- 개념글 `1~5페이지`
- 통합 `250개 window snapshot`
- **이전 window에 없던 postNo만 검사**
- 첫 실행은 baseline만 저장

하는 저속 보조 감시 lane으로 구현한다.
