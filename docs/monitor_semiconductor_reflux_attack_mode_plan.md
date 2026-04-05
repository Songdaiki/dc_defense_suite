# 게시물 자동화 / 수동 게시글 분류 반도체 역류 공격 모드 구현 플랜

## 작성 기준

이 문서는 **2026-04-05 현재 실제 코드 기준**으로 작성했다.

교차 확인한 실제 파일:

- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js)
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js)
- [features/post/parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)
- 기존 중국어 공격 문서: [docs/monitor_unicode_attack_mode_plan.md](/home/eorb915/projects/dc_defense_suite/docs/monitor_unicode_attack_mode_plan.md)

이 문서의 목표는:

- 지금 있는 `중국어/한자/CJK 공격` 모드와 **같은 아키텍처**로
- 새 `반도체 역류 공격` 모드를 추가하되
- **기존 default / cjk 플로우를 안 깨고**
- 나중에 `반도체산업갤러리 제목 Set`만 주입하면 바로 동작하게 만드는 것이다.

---

## 1. 지금 실제 구조

### 1-1. 자동 감시 monitor

현재 `monitor`는 공격 감지 후 아래 구조로 돈다.

1. `pollBoardSnapshot()`으로 `monitorPages` 범위를 읽는다.  
   [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L214)
2. `computeMetrics()`로 새 글 수 / 유동 수 / 유동 비율을 계산한다.  
   [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L247)
3. streak가 쌓이면 `enterAttackMode()`로 진입한다.  
   [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L303)
4. 공격 진입 시 `decideAttackMode(metrics)`로 공격 모드를 고른다.  
   [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L379)
5. 현재 attack mode는 두 개뿐이다.
   - `DEFAULT`
   - `CJK_NARROW`  
   [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L5)
6. `buildInitialSweepPosts(snapshot, attackMode, initialSweepPages)`에서 attack mode에 따라 initial sweep 대상을 좁힌다.  
   [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L978)
7. 그 뒤 child `postScheduler.start({ source:'monitor', attackMode })`로 게시글 분류 child에 같은 mode를 넘긴다.  
   [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L421)

쉽게 예시로:

- 최근 유동글 3개 중 1개라도 한자/CJK 제목이면 `CJK_NARROW`
- 그러면 initial sweep도 한자/CJK 제목만
- 이후 child post 분류도 한자/CJK 제목만

반대로:

- 한자/CJK 글자가 안 보이면 `DEFAULT`
- 그러면 예전처럼 유동글 전체를 본다

### 1-2. 수동 게시글 분류 post

현재 `post`는 수동/자동 child 공용 scheduler다.

- 런타임 source:
  - `manual`
  - `monitor`
- 런타임 attack mode:
  - `DEFAULT`
  - `CJK_NARROW`  
  [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L27)

실제 분류 후보는 여기서 결정된다.

- `fluidPosts`
- `cutoff 이후`
- `isEligibleForAttackMode(post, effectiveAttackMode)`  
  [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L334)

현재 `isEligibleForAttackMode()`는:

- `DEFAULT`면 무조건 true
- `CJK_NARROW`면 `isHanCjkSpamLikePost(post)`일 때만 true  
  [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L584)

### 1-3. 수동 UI

현재 수동 게시글 분류 쪽엔 **좁은 공격 모드용 quick toggle이 하나** 있다.

- `중국어/한자 공격`
- id: `postCjkModeToggle`  
  [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L714)

이 토글은 지금 이렇게 동작한다.

- ON:
  - 수동 분류가 꺼져 있으면 `attackMode='cjk_narrow'`로 바로 시작
  - 일반 수동 분류가 이미 켜져 있으면 “먼저 정지” 경고
- OFF:
  - 현재 manual + `cjk_narrow`로 돌고 있을 때만 stop  
  [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1098)

즉 지금 구조는 **manual attack mode를 설정값으로 고르는 selector**가 아니라,  
**특정 narrow mode 전용 quick toggle** 하나가 붙어 있는 구조다.

### 1-4. 현재 공격 모드 normalization 경로

현재 `background`는 `post.manualAttackMode` 저장값을 이렇게 normalize한다.

- `cjk_narrow`면 `cjk_narrow`
- 아니면 전부 `default`  
  [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1398)

즉 새 mode를 넣으려면 아래 세 군데는 반드시 같이 바꿔야 한다.

- `features/monitor/scheduler.js`
- `features/post/scheduler.js`
- `background/background.js`

popup label helper도 같이 바꿔야 한다.

- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2908)

---

## 2. 이번에 추가할 것

새 attack mode:

- `SEMICONDUCTOR_REFLUX = 'semiconductor_reflux'`

의미:

- 특이점갤 page1 / attack snapshot에서 보이는 제목이
- **미리 수집해둔 반도체산업갤러리 제목 Set**과 매칭되면
- 그 글만 분류/삭제 대상으로 좁히는 모드

즉 최종 모드는 3개가 된다.

- `DEFAULT`
- `CJK_NARROW`
- `SEMICONDUCTOR_REFLUX`

쉽게 예시로:

- 제목 `반도체 업황 바닥 확인`
- 이 제목이 반도체산업갤러리 Set에 있으면
- `SEMICONDUCTOR_REFLUX` 후보

- 제목 `驅籟炡坎翬窕龠`
- Han/CJK 문자면
- `CJK_NARROW` 후보

- 둘 다 아니면
- `DEFAULT`

---

## 3. 제일 중요한 설계 원칙

### 3-1. 30,000개는 배열 순차 비교가 아니라 `Set.has()`로 본다

이건 핵심이다.

하지 말아야 할 방식:

```js
for (const candidate of allDatasetTitles) {
  if (candidate === normalizedTitle) ...
}
```

이렇게 page1 후보마다 3만개를 순차로 도는 방식은 불필요하게 무겁다.

이번 설계는:

1. 반도체 제목 3만개를 **미리 정규화**
2. 메모리 `Set`으로 로드
3. 새 글 제목도 정규화
4. `set.has(normalizedTitle)` 1번으로 판정

즉 예시:

- dataset: `Set(['반도체업황바닥확인', '삼성파운드리적자', ...])`
- 새 글 제목: `삼성 파운드리 적자`
- 정규화 -> `삼성파운드리적자`
- `set.has('삼성파운드리적자') === true`

이 방식이면 **3만개여도 충분히 가볍다.**

### 3-2. 제목 직차단의 aggressive normalize를 그대로 재사용하면 안 된다

`분탕자동차단` 제목 직차단은 매우 공격적으로 정규화한다.

예:

- 공백 제거
- 쉼표 제거
- 특수문자 제거
- 한글/영문만 남김

이건 금칙어 매치용으로는 맞지만,  
**반도체 역류 제목 Set exact match**에는 너무 공격적일 수 있다.

왜냐면:

- 숫자
- 퍼센트
- 종목코드
- 날짜
- 괄호

같은 정보가 제목 구분에 실제로 중요할 수 있기 때문이다.

예시:

- `삼성전자 1분기 영업익`
- `삼성전자 2분기 영업익`

숫자를 다 날려버리면 둘 다 비슷한 key가 될 수 있다.

그래서 이번 모드용 제목 정규화는 **별도 helper**로 가야 한다.

권장:

- `String.normalize('NFKC')`
- invisible 문자 제거
- 영어 lowercase
- 연속 공백 collapse
- 제목 앞뒤 trim
- 필요하면 quote/space 정도만 최소 정리

즉 **정확도 위주 mild normalize**로 간다.

### 3-3. mixed sample은 narrow mode로 가지 말고 `DEFAULT`

이건 실제 운영상 중요하다.

예시:

- 샘플 3개 중
  - 1개는 Han/CJK
  - 1개는 반도체 Set match
  - 1개는 일반글

이 경우:

- `CJK_NARROW`로 가면 역류글을 놓칠 수 있고
- `SEMICONDUCTOR_REFLUX`로 가면 중국어형을 놓칠 수 있다

따라서 mixed sample은 **안전하게 `DEFAULT`**가 맞다.

권장 우선순위:

1. sample 3개 모두 일반형 -> `DEFAULT`
2. sample 중 reflux match만 있고 Han/CJK 없음 -> `SEMICONDUCTOR_REFLUX`
3. sample 중 Han/CJK만 있고 reflux match 없음 -> `CJK_NARROW`
4. 둘 다 섞여 있음 -> `DEFAULT`
5. sample 3개 미만 -> `DEFAULT`

즉 **좁힘은 확실할 때만** 한다.

### 3-4. dataset이 비어 있으면 반도체 역류 모드는 자동으로 비활성

이것도 중요하다.

크롤링/주입은 나중에 할 예정이므로,
초기 구현 시점엔 dataset이 비어 있을 수 있다.

이때 동작:

- 자동 monitor:
  - reflux 판정은 항상 false
  - 즉 `DEFAULT` 또는 `CJK_NARROW`만 나옴
- 수동 post:
  - `반도체 역류 공격`을 켜려고 하면
  - `반도체 역류 제목 데이터셋이 비어 있어 시작할 수 없습니다.` 로 막는 게 맞다

이렇게 해야 **dataset 없는 상태로 잘못 좁혀지는 일**이 없다.

---

## 4. 제목 Set 데이터 구조

이번 단계에선 crawler는 나중에 붙인다.  
하지만 **attack mode 로직이 기대하는 런타임 데이터 구조**는 지금 문서에 고정해야 한다.

권장 모듈:

- `background/semiconductor-reflux-title-set.js`

권장 API:

```js
async function ensureSemiconductorRefluxTitleSetLoaded()
function hasSemiconductorRefluxTitle(normalizedTitle)
function getSemiconductorRefluxTitleSetStatus()
function normalizeSemiconductorRefluxTitle(value)
function replaceSemiconductorRefluxTitleSet(rawTitles, meta = {})
```

런타임 메모리 구조:

```js
{
  loaded: boolean,
  titleCount: number,
  updatedAt: string,
  sourceGalleryId: 'semiconductorindustry',
  normalizedTitleSet: Set<string>,
}
```

storage 구조 권장:

```js
chrome.storage.local['semiconductorRefluxTitleSetState'] = {
  version: '2026-04-05-v1',
  sourceType: 'bundled',
  updatedAt: '...',
  sourceGalleryId: 'semiconductorindustry',
  titles: ['반도체업황바닥확인', ...]
}
```

설명:

- 배포본 JSON dataset이 source-of-truth
- storage는 각 관리자 PC의 local cache
- 런타임에만 `Set`으로 올림
- service worker 재시작 시 lazy-load

중요 운영 규칙:

- dataset 제목을 수정했다면 JSON 안의 `version`도 반드시 같이 올린다
- 예:
  - 기존: `2026-04-05-v1`
  - 제목 수정 후: `2026-04-06-v2`
- 이유:
  - 로더는 `storage.sourceType !== 'bundled'` 이거나
  - `storage.version !== bundled.version` 일 때만
  - 새 배포 dataset으로 local cache를 덮어쓴다

즉 한 줄로:

- **제목만 바꾸고 version을 그대로 두면, 이미 같은 버전이 cache에 있는 관리자는 예전 dataset을 계속 쓸 수 있다**

이 방식이면:

- 나중에 crawler/importer 추가 쉬움
- lookup은 빠름
- monitor/post는 단순 `has()`만 보면 됨

---

## 5. 실제 구현 파일별 계획

## 5-1. 새 shared helper 파일 추가

권장 새 파일:

- `features/post/attack-mode.js`

이유:

- 지금 `ATTACK_MODE`, `normalizeAttackMode`, `formatAttackModeLabel`, `isEligibleForAttackMode`가 monitor/post/popup/background에 흩어져 있다
- 여기에 `SEMICONDUCTOR_REFLUX`를 넣으면 중복 수정 지점이 더 늘어난다

이 파일에 넣을 것:

- `ATTACK_MODE`
  - `DEFAULT`
  - `CJK_NARROW`
  - `SEMICONDUCTOR_REFLUX`
- `normalizeAttackMode(value)`
- `formatAttackModeLabel(value)`
- `buildAttackModeDecision(samplePosts, refluxMatcher)`
- `isEligibleForAttackMode(post, attackMode, refluxMatcher)`
- `normalizeSemiconductorRefluxTitle(value)`
- `isSemiconductorRefluxLikePost(post, refluxMatcher)`

주의:

- monitor/post가 같은 helper를 공유해야 한다
- 그래야 monitor가 `SEMICONDUCTOR_REFLUX`로 판정했는데 post child가 다른 기준으로 필터링하는 불일치가 안 생긴다

## 5-2. `features/post/parser.js`

현재 이 파일엔 `isHanCjkSpamLikePost(post)`만 있다.  
반도체 역류는 parser 자체보다 **title normalization helper**가 중요하다.

권장:

- parser에는 손대지 않거나 최소화
- 반도체 제목 exact match는 새 shared helper에서 처리

즉 예시:

- `isHanCjkSpamLikePost(post)`는 parser 그대로
- `isSemiconductorRefluxLikePost(post, titleSet)`는 shared helper로

이렇게 분리한다.

## 5-3. `features/monitor/scheduler.js`

여기가 자동 공격 모드 핵심이다.

### 추가 상태

지금 상태:

- `attackMode`
- `attackModeReason`
- `attackModeSampleTitles`

이건 그대로 쓰면 된다.

추가로 권장:

- `attackModeMatchedRefluxTitles = []`
  - 선택사항
  - 실제 매치된 반도체 제목 샘플을 로그/디버그용으로 남기기 좋음

최소 구현이면 기존 3개 상태만으로도 충분하다.

### `ATTACK_MODE` 확장

현재:

```js
DEFAULT
CJK_NARROW
```

변경:

```js
DEFAULT
CJK_NARROW
SEMICONDUCTOR_REFLUX
```

### `decideAttackMode(metrics)` 변경

현재:

- `pickAttackModeSamplePosts(metrics)`
- `analyzeHanCjkAttackSample(samplePosts)`

변경 권장:

- `pickAttackModeSamplePosts(metrics)`는 그대로 재사용
- `analyzeAttackSample(samplePosts, refluxMatcher)` 같은 함수로 교체

반환 shape 권장:

```js
{
  attackMode,
  reason,
  sampleCount,
  hanLikeCount,
  refluxMatchCount,
  sampleTitles,
}
```

판정 규칙:

1. 샘플 3개 미만 -> `DEFAULT`
2. `refluxMatchCount > 0 && hanLikeCount === 0` -> `SEMICONDUCTOR_REFLUX`
3. `hanLikeCount > 0 && refluxMatchCount === 0` -> `CJK_NARROW`
4. `refluxMatchCount > 0 && hanLikeCount > 0` -> `DEFAULT`
5. 둘 다 0 -> `DEFAULT`

예시:

- 샘플 3개 중 2개가 반도체 Set 매치, Han/CJK 0개
  - `SEMICONDUCTOR_REFLUX`
- 샘플 3개 중 1개 Han/CJK, reflux 0개
  - `CJK_NARROW`
- 샘플 3개 중 1개 Han/CJK, 1개 reflux
  - `DEFAULT`

### `buildInitialSweepPosts(snapshot, attackMode, initialSweepPages)` 변경

현재:

- `CJK_NARROW`일 때만 `isEligibleForAttackMode()`를 적용
- 아니면 유동글 전체

변경:

- `CJK_NARROW`면 Han/CJK 제목만
- `SEMICONDUCTOR_REFLUX`면 제목 Set 매치만
- `DEFAULT`면 전체

즉 현재 `isEligibleForAttackMode(post, attackMode)`를
**shared helper 버전**으로 바꿔 쓰면 된다.

### `maybeWidenAttackMode(metrics)` 확장

현재는:

- `CJK_NARROW -> DEFAULT` widening만 있다  
  [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L384)

변경:

- `SEMICONDUCTOR_REFLUX -> DEFAULT` widening도 같은 원리로 추가

권장 규칙:

- 이미 narrow mode에 들어간 세션만 widening 허용
- 최신 샘플 3개를 다시 보고
- 현재 narrow family의 match가 0이면 `DEFAULT`로 넓힘
- `DEFAULT -> narrow` 중간 재진입은 하지 않음
- `CJK_NARROW <-> SEMICONDUCTOR_REFLUX` 직접 상호 전환도 하지 않음

즉 중간 전환은 **좁힘이 아니라 넓힘만** 허용한다.

## 5-4. `features/post/scheduler.js`

여기가 수동/자동 child 공용 narrow filter 핵심이다.

### `ATTACK_MODE` 확장

현재 2개 -> 3개로 확장

### `normalizeAttackMode()` 확장

현재는 `cjk_narrow`만 인정한다.  
여기에 `semiconductor_reflux` 추가

### `getAttackModeLabel()` 확장

- `DEFAULT`
- `CJK_NARROW`
- `SEMICONDUCTOR_REFLUX`

### `isEligibleForAttackMode(post, attackMode)` 확장

현재:

- `CJK_NARROW`면 Han/CJK만
- 아니면 전체

변경:

- `CJK_NARROW` -> Han/CJK
- `SEMICONDUCTOR_REFLUX` -> titleSet match
- `DEFAULT` -> 전체

### `shouldApplyCutoffForSource()`는 바꾸지 않는 것이 맞다

현재:

- `monitor` source면 항상 cutoff 적용
- `manual` + `cjk_narrow`면 cutoff 미사용
- `manual` + default면 cutoff 사용  
  [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L562)

여기서 `manual + semiconductor_reflux`를 어떻게 할지 결정해야 한다.

권장:

- `manual + semiconductor_reflux`도 **cutoff 미사용**

이유:

- 현재 중국어 수동 모드는 “현재 설정 페이지의 기존 글을 포함한 한자 제목만 분류” 방식이다
- 반도체 역류 수동도 같은 기대가 자연스럽다

즉:

- 수동 일반 -> cutoff 사용
- 수동 중국어 -> cutoff 미사용
- 수동 반도체 역류 -> cutoff 미사용

예시:

- 파딱이 page 1~5를 지금 바로 훑고 싶어 함
- 반도체 역류 모드 ON
- 기존 글 포함해서 Set match 제목만 분류

### `transitionManualAttackModeWhileRunning()`도 같이 확장

현재는 `cjk_narrow` 고려만 있다.
여기에 `semiconductor_reflux`도 포함해야 한다.

특히:

- `nextAttackMode !== DEFAULT`면 cutoff 미사용
- `DEFAULT`면 새 cutoff 재캡처

이 구조로 일반화하는 게 맞다.

### quick toggle start는 `config.manualAttackMode`가 아니라 `currentAttackMode`를 바로 쓴다

이건 실제 코드 기준으로 꼭 짚고 가야 한다.

현재 수동 중국어 quick toggle은 `updateConfig({ manualAttackMode })`를 먼저 저장하고 시작하는 구조가 아니다.

실제 흐름은:

1. popup toggle ON
2. `sendFeatureMessage('post', { action:'start', source:'manual', attackMode:'cjk_narrow' })`
3. `postScheduler.start()`가 `currentAttackMode`를 직접 세팅
4. running 상태는 `currentSource + currentAttackMode`로 유지

즉 새 반도체 역류 quick toggle도 같은 semantics로 가야 한다.

이 말은 곧:

- dataset empty 차단은 `config.manualAttackMode`만 보고 하면 안 되고
- **`start(options.attackMode)` 경로에서도 직접 검사**해야 한다는 뜻이다

예시:

- idle 상태에서 `반도체 역류 공격` toggle ON
- 아직 `config.manualAttackMode`는 `default`
- 그래도 `start({ attackMode:'semiconductor_reflux' })` 단계에서 dataset empty면 막아야 한다

반대로:

- 실행 중 manual mode 전환은 `transitionManualAttackModeWhileRunning()`이 `manualAttackMode`를 config에 반영하는 경로라
- 이쪽도 dataset empty를 별도로 막아야 한다

즉 구현 체크포인트는 두 군데다.

1. `start(options.attackMode)`
2. `transitionManualAttackModeWhileRunning(nextConfig.manualAttackMode)`

### `start()` / 전환 로그 문구도 일반화해야 한다

이건 실제 코드에서 빠뜨리기 쉬운 포인트다.

현재 `post` scheduler에는 mode가 한자 전용일 때를 가정한 하드코딩 로그가 여럿 있다.

예:

- `수동 게시글 분류 cutoff 미사용 (중국어/한자 공격 수동 모드)`
- `🔁 수동 중국어/한자 공격 모드 적용 - 첫 페이지부터 다시 스캔합니다. (cutoff 미사용)`
- 페이지 로그의 `기존 포함 한자 제목 게시물`

이 상태에서 `SEMICONDUCTOR_REFLUX`만 추가하면,

- 기능은 반도체 역류 모드로 도는데
- 로그/문구는 계속 `중국어/한자 공격`으로 보여서
- 운영 중 판단을 헷갈리게 만든다

따라서 구현 시 아래 문자열은 반드시 mode-aware helper로 바꿔야 한다.

- `start()`의 cutoff 미사용 시작 로그
- `applyPendingRuntimeTransitionIfNeeded()`의 모드 전환 로그
- main loop 페이지 요약 로그
- `classifyPostsOnce()`에 넘기는 `logLabel`

쉽게 예시로:

- 수동 반도체 역류 모드 ON
  - 잘못된 로그: `수동 중국어/한자 공격 모드 적용`
  - 맞는 로그: `수동 반도체 역류 공격 모드 적용`

- 반도체 역류 manual 모드에서 cutoff 미사용 분류
  - 잘못된 label: `1페이지 기존 포함 한자 제목 게시물`
  - 맞는 label: `1페이지 기존 포함 반도체 역류 제목 게시물`

## 5-5. `background/background.js`

필수 수정:

- `normalizePostManualAttackMode()` 확장  
  [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1398)

현재:

- `cjk_narrow`만 인정

변경:

- `cjk_narrow`
- `semiconductor_reflux`
- 아니면 default

추가로 확인할 것:

- `maybeHandleRunningPostModeTransition()`
  - 새 mode도 정상 transition 되게 normalize 확장
- reset helper는 기존 attack mode 문자열에 의존하지 않아서 큰 문제 없음

## 5-6. `popup/popup.html`

### 수동 post 패널

현재:

- quick toggle 1개
  - `중국어/한자 공격`

변경 권장:

- quick toggle 2개
  - `중국어/한자 공격`
  - `반도체 역류 공격`

id 예시:

- `postCjkModeToggle`
- `postSemiconductorRefluxModeToggle`

중요:

- 둘은 **동시에 ON 될 수 없어야 한다**
- currentAttackMode는 1개뿐이기 때문

운영 규칙:

- `중국어 ON` 시 이미 다른 manual mode running이면 stop 요구
- `반도체 ON` 시도 마찬가지
- OFF는 자기 mode로 돌고 있을 때만 stop

즉 지금 중국어 toggle이 하던 quick-toggle semantics를 반도체에도 평행하게 하나 더 추가한다.

### monitor 패널

상태칸 `공격 모드`는 지금 그대로 재사용하면 된다.

다만 label helper가 새 값을 보여줘야 한다.

예:

- `DEFAULT`
- `CJK_NARROW`
- `SEMICONDUCTOR_REFLUX`

추가로 monitor 메타 문구는 선택사항이다.
최소 구현에선 상태 label만 바꿔도 충분하다.

## 5-7. `popup/popup.js`

필수 수정:

- `FEATURE_DOM.post`에 새 toggle DOM 추가
- `bindPostEvents()`에 새 반도체 toggle 이벤트 추가
- `updatePostUI()`에서 두 narrow toggle의 checked 상태 동기화
- `formatAttackModeLabel()` 확장  
  [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2908)

현재 중국어 toggle 로직:

- running default면 경고
- running cjk면 no-op
- off면 cjk running일 때만 stop

새 반도체 toggle도 같은 구조로 가면 된다.

예시:

- 수동 일반 분류 ON 상태에서 반도체 toggle ON
  - `일반 게시글 분류가 이미 실행 중입니다. 먼저 정지한 뒤 반도체 역류 공격을 켜세요.`
- 수동 반도체 역류 모드 running 상태에서 toggle OFF
  - stop

### popup 상태 반영 규칙

예시:

- currentSource=`manual`, currentAttackMode=`semiconductor_reflux`
  - `postSemiconductorRefluxModeToggle = true`
  - `postCjkModeToggle = false`
- currentSource=`manual`, currentAttackMode=`cjk_narrow`
  - 반대로
- currentSource=`monitor`
  - 둘 다 false 유지
  - monitor 패널의 `공격 모드`만 신뢰

즉 manual toggle은 **수동 실행 상태만 반영**해야 한다.

### `applyAutomationLocks()`에도 새 toggle을 같이 걸어야 한다

이것도 실제 코드에서 빠지기 쉬운 연결이다.

현재 자동 잠금은 `postCjkModeToggle`만 직접 disable 한다.

즉 새 toggle만 추가하고 여길 안 건드리면:

- monitor 실행 중
- 일반 post toggle은 잠겨 있는데
- `반도체 역류 공격` toggle만 살아 있는
- 비대칭 UI가 생길 수 있다

따라서 `applyAutomationLocks()`의 `postDom` 처리에

- `postSemiconductorRefluxModeToggle`

도 동일하게 묶어야 한다.

쉽게 예시로:

- 감시 자동화가 도는 중이면
  - 일반 게시글 분류 toggle 잠금
  - `중국어/한자 공격` toggle 잠금
  - `반도체 역류 공격` toggle도 **같이 잠금**

이 세 개가 같이 움직여야 한다.

## 5-8. 새 dataset helper와 연결

권장 새 파일:

- `background/semiconductor-reflux-title-set.js`

이 파일은 지금 단계에서 **실제 crawler 없이도 동작 가능한 placeholder**로 만들 수 있다.

최소 구현:

- storage에 dataset 없으면 empty set
- `hasSemiconductorRefluxTitle()`는 항상 false
- status는 `loaded=false`, `titleCount=0`

나중에 crawler/importer가 생기면:

- 같은 helper에 `replaceSemiconductorRefluxTitleSet(rawTitles)`만 추가하면 된다

즉 이번 모드 구현과 제목 크롤링을 분리할 수 있다.

---

## 6. 자동 판정 세부 규칙

권장 함수:

```js
function analyzeAttackSample(samplePosts, refluxTitleMatcher)
```

반환:

```js
{
  attackMode,
  reason,
  sampleCount,
  hanLikeCount,
  refluxMatchCount,
  sampleTitles,
}
```

권장 reason 예시:

- `샘플 유동글이 3개 미만이라 DEFAULT 유지`
- `새 유동글 샘플 3개 중 2개가 반도체 역류 제목 Set 매치`
- `새 유동글 샘플 3개 중 1개가 Han/CJK 제목`
- `새 유동글 샘플에 Han/CJK와 반도체 역류 제목이 섞여 있어 DEFAULT 유지`
- `새 유동글 샘플 3개 모두 일반 제목이라 DEFAULT 유지`

로그 예시:

- `🧠 공격 모드 판정: SEMICONDUCTOR_REFLUX (새 유동글 샘플 3개 중 2개가 반도체 역류 제목 Set 매치)`
- `🧹 initial sweep 대상 1~2페이지 유동 24개 -> 반도체 역류 제목 필터 후 11개`

---

## 7. initial sweep 페이지 수 정책

현재 monitor엔:

- `monitorPages`
- `중국어 initial sweep 페이지 수(initialSweepPages)`  
  [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L1204)

이 상태에서 반도체 역류 initial sweep 페이지 수를 어떻게 할지가 포인트다.

### 권장 1차안

이번 단계에서는 **별도 `refluxInitialSweepPages`를 추가하지 않는다.**

정책:

- `DEFAULT` -> `monitorPages`
- `CJK_NARROW` -> 기존 `initialSweepPages`
- `SEMICONDUCTOR_REFLUX` -> `monitorPages`

이유:

- 반도체 역류 필터는 exact match 기반이라 이미 충분히 좁다
- 지금 바로 설정칸을 하나 더 늘리면 monitor UI가 더 복잡해진다
- 나중에 실제 운영하다가 “역류기는 5페이지까지 한 번 더 훑고 싶다”가 필요하면 그때 `refluxInitialSweepPages`를 추가해도 된다

즉 1차 구현은 **기능 우선 / UI 증설 최소화**가 맞다.

---

## 8. dataset 미적재 상태에서의 동작

이건 구현 전에 반드시 고정해야 한다.

### 자동 monitor

- dataset 비어 있으면 `refluxMatchCount = 0`
- 따라서 `SEMICONDUCTOR_REFLUX`는 절대 선택되지 않음

즉 dataset import 전엔:

- `DEFAULT`
- `CJK_NARROW`
만 실제로 나온다

### 수동 post

- `반도체 역류 공격` quick toggle ON 시
- dataset 비어 있으면 **start 거부 + alert**

예시 문구:

- `반도체 역류 제목 데이터셋이 비어 있어 시작할 수 없습니다. 먼저 제목 Set을 준비하세요.`

이게 중요한 이유:

- dataset 없는 상태에서 manual reflux mode를 켜면
- 사용자는 좁은 모드라고 생각하는데 실제론 아무것도 안 맞아서 혼란스럽다

중요:

- popup에서 미리 막는 건 **보조 UX**
- 진짜 검증은 **`postScheduler.start()` / `transitionManualAttackModeWhileRunning()` 안에서 다시 해야 한다**

이유:

- popup quick toggle만 있는 게 아니라
- background message를 직접 보내는 경로도 존재하고
- 저장된 상태 복원/실행 중 전환도 scheduler 레벨에서 일어난다

즉 구현 원칙은:

1. popup은 실패 메시지를 빨리 보여주는 편의 장치
2. 실제 dataset empty 차단은 scheduler가 authoritative

예시:

- popup 버그로 잘못 start 요청이 가도
- `manual + semiconductor_reflux + dataset empty`
면 scheduler가 `반도체 역류 제목 데이터셋이 비어 있어 시작할 수 없습니다.` 로 거부해야 한다

---

## 9. 실제 변경 순서

1. 새 shared helper 추가
   - `features/post/attack-mode.js`
   - `ATTACK_MODE`
   - normalize/label
   - Han/CJK / reflux match helper
   - sample analysis helper
2. dataset helper 추가
   - `background/semiconductor-reflux-title-set.js`
   - empty set + lazy load placeholder
3. `features/post/scheduler.js`
   - `ATTACK_MODE` import 전환
   - `isEligibleForAttackMode()` shared helper로 교체
   - `normalizeAttackMode()` / `getAttackModeLabel()` / `shouldApplyCutoffForSource()` 확장
4. `features/monitor/scheduler.js`
   - `ATTACK_MODE` shared helper import
   - `decideAttackMode()`를 shared analysis 기반으로 교체
   - `buildInitialSweepPosts()`를 reflux mode aware하게 변경
   - `maybeWidenAttackMode()`에 reflux widening 추가
5. `background/background.js`
   - `normalizePostManualAttackMode()` 확장
6. `popup/popup.html`
   - `postSemiconductorRefluxModeToggle` 추가
7. `popup/popup.js`
   - 새 toggle DOM/wiring
   - manual toggle exclusivity 반영
   - `formatAttackModeLabel()` 확장
8. 문구/로그 정리
   - monitor attack mode label
   - post manual alert 문구

---

## 10. 테스트 플랜

### 10-1. 회귀

- 일반 manual post 분류는 예전과 동일
- 중국어 manual toggle은 예전과 동일
- monitor default / cjk_narrow는 예전과 동일

### 10-2. dataset 비어 있음

- monitor는 `SEMICONDUCTOR_REFLUX`로 안 들어감
- manual 반도체 toggle은 시작 거부

### 10-3. dataset 로드됨

예시 dataset:

- `삼성파운드리적자`
- `메모리업황바닥`

예시 제목:

- `삼성 파운드리 적자`
  - 정규화 후 match
- `메모리 업황 바닥`
  - match
- `일반 잡담`
  - no match

확인:

- `SEMICONDUCTOR_REFLUX` initial sweep은 매치 글만 남기는지
- post child도 cutoff 이후 매치 글만 분류하는지
- manual 반도체 toggle도 같은 필터를 쓰는지

### 10-4. mixed sample

예시:

- sample 3개 중
  - 1개 Han/CJK
  - 1개 reflux match
  - 1개 일반

확인:

- `DEFAULT`로 남는지

### 10-5. widening

예시:

- 공격 시작은 reflux narrow
- 이후 최신 sample 3개에 reflux match 0개

확인:

- `SEMICONDUCTOR_REFLUX -> DEFAULT` widening 되는지

---

## 11. 최종 판단

이 기능은 **중국어 방어를 갈아엎는 게 아니라, 그 옆에 평행 narrow mode 하나를 더 추가하는 작업**이다.

핵심 판단은 이거다.

- **가능하다**
- **3만개 제목도 Set lookup이면 충분히 빠르다**
- **실제 위험 포인트는 성능보다 mixed sample / dataset empty / 수동 quick toggle 2개 공존 처리 쪽이다**

그리고 지금 실제 코드 기준으로 하드 blocker는 못 찾았다.

중요한 구현 원칙만 지키면 된다.

1. dataset match는 `Set.has()`로
2. 제목 정규화는 title-ban용 aggressive normalize를 그대로 쓰지 말 것
3. mixed sample은 `DEFAULT`
4. dataset empty면 manual reflux mode 시작 차단
5. `DEFAULT / CJK_NARROW / SEMICONDUCTOR_REFLUX`를 monitor / post / background / popup에서 **같은 helper로 공유**

즉, 이 문서 기준이면 **바로 패치 들어갈 수 있다.**
