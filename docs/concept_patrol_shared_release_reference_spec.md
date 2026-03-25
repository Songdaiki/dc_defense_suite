# 개념글순회 공용 판정/해제 참조 스펙

## 목적

`개념글순회(conceptPatrol)`는 신규 진입 감지 방식은 새로 정의하지만,
실제 게시물 판정/해제 규칙은 가능한 한 기존 `개념글 방어(conceptMonitor)`와
같은 계약을 재사용해야 한다.

이 문서는 `conceptPatrol`이 **기존 `conceptMonitor`에서 그대로 가져와야 하는 공용 스펙**만 따로 고정한다.

즉:

- `concept_window_snapshot_patrol_plan.md`
  - 신규 진입 감지 / window snapshot / patrol hold
- 본 문서
  - 게시물 inspect / 해제 / 재확인 / 실패 처리 공용 계약

으로 책임을 나눈다.

## 왜 분리해야 하는가

`conceptPatrol`은 결국 아래를 기존 `conceptMonitor`와 동일하게 써야 한다.

- 개별 글 view HTML에서 추천 수 파싱
- 현재 개념글 여부 판정
- 유동 추천 비율 기준
- 해제 API
- 해제 후 재확인
- 차단/403 대응

이걸 메인 문서 안에 흩어 적으면,

- 어느 부분이 `conceptPatrol` 고유 규칙인지
- 어느 부분이 `conceptMonitor`와 공용 규칙인지

가 섞여서 구현 drift가 생기기 쉽다.

따라서 공용 계약을 별도 참조 문서로 고정한다.

## 참조 원본

공용 계약의 1차 기준은 아래다.

- 기존 스펙: [concept_recommend_attack_defense_spec.md](/home/eorb915/projects/dc_defense_suite/docs/concept_recommend_attack_defense_spec.md)
- 기존 구현:
  - [scheduler.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/scheduler.js)
  - [api.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/api.js)
  - [parser.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/parser.js)

## `conceptPatrol`이 그대로 재사용해야 하는 계약

### 1. 개별 게시물 inspect 입력

`conceptPatrol`은 신규 진입 `postNo`를 찾은 뒤,
개별 게시물 inspect는 기존 `conceptMonitor.inspectPost()`와 같은 의미를 따라야 한다.

필수 입력:

- `postNo`
- 가능하면 `currentHead`
- 가능하면 `subject`

view fetch:

- `fetchConceptPostViewHTML(config, postNo)` 계약 재사용

### 2. 머릿말 필터

후보 판정 대상은 기존과 동일하게:

- `일반`

머릿말만 본다.

즉:

- `정보,뉴스`
- `자료실`
- `사용후기`

등 `일반`이 아닌 머릿말은 해제 후보 검사 없이 스킵한다.

근거:

- [features/concept-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/scheduler.js#L248)

### 3. 현재 개념글 여부 판정

개별 글 view HTML의 hidden input `#recommend` 기준:

- `#recommend === "K"` 이면 현재 개념글
- 아니면 해제 대상 아님

근거:

- [features/concept-monitor/parser.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/parser.js#L63)

### 4. 추천 수 계산 규칙

기존과 동일하게:

- `totalRecommendCount = 총 추천 수`
- `fixedNickRecommendCount = 고정닉 추천 수`
- `fluidRecommendCount = totalRecommendCount - fixedNickRecommendCount`
- `fluidRatio = fluidRecommendCount / totalRecommendCount`

비정상 값 처리도 동일하다.

- `totalRecommendCount <= 0` 이면 스킵
- `fixedNickRecommendCount > totalRecommendCount` 이면 실패/경고

근거:

- [features/concept-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/scheduler.js#L276)

### 5. 해제 후보 기준

기본 후보 기준은 기존과 동일하다.

- `fluidRatio >= threshold`
- 기본 threshold `90%`

즉 `conceptPatrol`은 신규 진입을 찾는 방식만 다르고,
“이 글을 실제 조작 해제 후보로 볼지”는 기존 `conceptMonitor`와 동일하게 판단한다.

### 6. 테스트 모드 정책

기존과 동일하게:

- 테스트 모드 ON
  - 후보 로그만 남김
  - 실제 해제 API 호출 안 함
- 테스트 모드 OFF
  - 실제 해제 시도

### 7. 해제 API 계약

기존과 동일하게:

- endpoint:
  - `POST /ajax/minor_manager_board_ajax/set_recommend`
- form:
  - `ci_t=<ci_c cookie>`
  - `id=<galleryId>`
  - `nos[]=<postNo>`
  - `_GALLTYPE_=M`
  - `mode=REL`

즉 `conceptPatrol`은 해제 API를 새로 정의하지 않는다.

근거:

- [features/concept-monitor/api.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/api.js#L112)

### 8. 해제 성공 판정

기존과 동일하게:

1. 해제 API HTTP `200`
2. 대상 글 view 재조회
3. `#recommend !== "K"` 이면 성공

즉 응답 body만으로 성공 판정하지 않는다.

근거:

- [features/concept-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/scheduler.js#L324)

### 9. 이미 수동 해제된 경우 fallback

기존 `conceptMonitor.skipIfAlreadyReleasedBySomeoneElse()` 정책을 그대로 따른다.

즉:

- 해제 요청 실패
- 또는 재확인 실패

후 짧게 다시 확인했을 때 이미 개념글이 아니면
수동 해제로 보고 성공/skip처럼 다음 글로 진행한다.

근거:

- [features/concept-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/scheduler.js#L489)

### 10. 차단/403 대응

기존과 동일하게:

- `HTTP 403`
- `HTTP 429`
- `정상적인 접근이 아닙니다`

계열 응답은 block signal로 보고 cooldown에 들어간다.

즉 `conceptPatrol`도 기존 `conceptMonitor`와 유사한 `BLOCK_COOLDOWN_MS`를 가져야 한다.

근거:

- [features/concept-monitor/api.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/api.js#L24)
- [features/concept-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/concept-monitor/scheduler.js#L107)

## `conceptPatrol`이 그대로 가져오면 안 되는 것

### 1. page 1 최신 snapshot 대상 선정

이건 기존 `conceptMonitor` 고유 규칙이다.

- page 1만
- 최신 snapshot 기본 5개

`conceptPatrol`은 이 규칙을 재사용하면 안 된다.

대신:

- `1~N페이지 통합 window snapshot`
- `newPostNos`만 inspect

를 써야 한다.

### 2. auto-cut owner

기존 `conceptMonitor`는 추천 증가량 기반 producer다.

`conceptPatrol`은 추천컷 owner를 가져오면 안 된다.

즉:

- `conceptPatrol`
  - hold 신호만 올림
- `conceptMonitor`
  - 추천 증가량 기반 상태만 계산
- 실제 `100 / 14` 적용은
  - 두 기능이 공통으로 쓰는 **shared recommend-cut coordinator/helper**
  가 담당

### 3. 전체 신규 진입 글 전부 deep inspect

`conceptPatrol`은 window 기반 신규 진입 글만 본다.

즉 기존 개념글 전체를 매번 다시 deep inspect하는 기능으로 바뀌면 안 된다.

## 구현 지침

실제 구현은 아래 방향이 맞다.

1. `features/concept-monitor`에서
   - inspect / release / recheck 관련 공용 helper를 분리하거나
   - 새 feature가 import 가능한 형태로 노출
   - 특히 `conceptPatrol`은
     - **후보 검사**
     - **실제 해제**
     두 단계를 분리 호출할 수 있어야 한다
2. `conceptPatrol`은
   - 대상 수집만 새로 구현
   - 나머지 공용 판정/해제는 재사용
   - 단, 기존 `conceptMonitor`와는 달리
     - 신규 진입 글을 **하나씩 검사**
     - 조작 누적이 threshold에 도달하는 순간 patrol hold를 즉시 올리고
     - 같은 loop 안에서 해제를 수행하되
     - 글 사이엔 500ms 텀을 둔다
3. 동일 post를 `conceptMonitor`와 `conceptPatrol`이 동시에 때리지 않도록
   - page 1 최신 snapshot 범위는
     - `conceptMonitor.isRunning === true`
     - `conceptMonitor.blockedUntilTs <= now`
     일 때만 `conceptMonitor` 우선
   - `conceptMonitor`가 OFF이거나 block cooldown 중이면
     - `conceptPatrol`이 page 1 최신 snapshot 범위도 직접 검사

## 한 줄 정리

`conceptPatrol`은

- **신규 진입 감지 방식만 새로 구현**
- **게시물 판정/해제 계약은 기존 `conceptMonitor`를 그대로 재사용**

하는 구조로 고정한다.
