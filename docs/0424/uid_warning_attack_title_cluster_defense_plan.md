# 분탕자동차단 실제공격 제목 클러스터 방어 설계

작성일: 2026-04-24

## 목표

오늘 들어온 공격은 같은 제목 문장 사이에 `˔`, `¸`, `;`, `ʼ`, `∙` 같은 기호를 끼워 넣어 일반 금칙어/중복 판정을 우회하는 형태다.

예시:

```text
지'피˔티¸최;단˜퇴`클˕로˒드ˆ미ˍ만°잡ʼㅋ˘ㅋ˕ㅋ˗ㅋ,ㅋˆㅋˊㅋ´ㅋㅋ
```

기존 정규화 기준으로 보면 위 제목은 아래처럼 줄어든다.

```text
지피티최단퇴클로드미만잡
```

원하는 동작은 `분탕자동차단`이 이미 10초마다 page1을 보는 흐름에, 유동글 제목 클러스터 판정을 하나 더 끼우는 것이다.

최종 조건:

```text
page1 유동글 중 정규화 후 95% 이상 비슷한 제목이 3개 이상이면
그 글 전부를 도배기IP차단(무고한 경우 문의) 사유로 6시간 차단/삭제
```

## 현재 실제 코드 흐름 확인

관련 진입점은 `features/uid-warning-autoban/scheduler.js`다.

현재 `runCycle()` 순서는 다음과 같다.

```js
const html = await this.fetchListHtml(this.config, 1);
const allRows = this.parseImmediateRows(html);
const pageUidRows = allRows.filter((row) => row?.hasUid === true);
...
const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const rows = pageUidRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0));
const groupedRows = groupRowsByUid(rows);
```

확인 결과:

- `fetchListHtml(this.config, 1)`은 10초마다 `/mgallery/board/lists/?id=...&page=1` HTML을 가져온다.
- `parseImmediateRows`의 기본 구현은 `parseImmediateTitleBanRows()`다.
- `parseImmediateTitleBanRows()`는 `requireUid:false`라서 유동글과 고닉글을 모두 파싱한다.
- `pageUidRows`는 UID가 있는 글만 남기기 때문에 기존 깡계 로직은 유동글을 처리하지 않는다.
- 즉 새 기능은 `allRows`에서 `row.isFluid === true`인 글만 뽑아 처리하면 된다.
- 추가 네트워크 요청은 필요 없다. 이미 받은 page1 HTML만 재사용하면 된다.

현재 row 구조는 `features/uid-warning-autoban/parser.js`에서 만들어진다.

```js
{
  no,
  uid,
  nick,
  title,
  subject,
  currentHead,
  createdAtText,
  createdAtMs,
  writerToken,
  writerKey,
  writerDisplay,
  contentType,
  isPicturePost,
  isFluid,
  hasUid,
  ip,
}
```

새 기능에서 필요한 값은 `no`, `title`, `subject`, `currentHead`, `isFluid`, `ip`다.

차단 실행은 기존 `features/ip/ban-executor.js`의 `executeBanWithDeleteFallback()`을 그대로 쓴다.

확인 결과:

- 인자로 받은 `posts`는 글번호 기준으로 dedupe된다.
- 실제 API 호출은 `features/ip/api.js`의 `banPosts()`로 이어진다.
- `banPostBatch()`는 `avoid_hour`, `avoid_reason_txt`, `del_chk`, `_GALLTYPE_`, `avoid_type_chk`, `nos[]`를 보낸다.
- 따라서 새 기능은 `config`만 override해서 넘기면 기존 계정 폴백/삭제한도 폴백을 그대로 쓸 수 있다.

## 실제공격 패턴 파일 확인

현재 공격 샘플 파일:

```text
docs/실제공격_게시글본문_파싱.txt
```

확인 결과:

- 총 335줄이다.
- 기존 `normalizeImmediateTitleValue()`만 적용해도 삽입 기호 대부분이 제거된다.
- 영어 꼬리값까지 제거한 한글 기준으로는 7개 군집으로 정리된다.

상위 군집 예시:

```text
오푸스한테벤치따잇: 144개
지피티최단퇴클로드미만잡: 53개
결국오푸스미만잡이네: 44개
오푸스오늘도승추가욧: 43개
지피티출시전에나온오푸스한테따잇: 28개
씹피티환각퍼레전드: 22개
```

의미:

- 공격자는 제목마다 기호를 다르게 섞었지만 핵심 한글 문장은 거의 같다.
- page1에서 같은 정규화 제목이 3개 이상 나오면 공격으로 보기 충분하다.
- `95% 유사도` 조건은 삽입기호 제거 후에도 살짝 다른 변형을 잡기 위한 보정으로 쓰면 된다.

## 구현 방향

새 기능 이름은 코드 안에서 `attackTitleCluster`로 둔다.

사용자에게 보이는 로그 이름은 `실제공격 제목 클러스터`로 둔다.

추가 파일:

```text
features/uid-warning-autoban/attack-title-cluster.js
data/uid-warning-attack-title-patterns-20260424.txt
```

`docs/실제공격_게시글본문_파싱.txt`는 근거 문서라서 런타임에서 직접 읽지 않는다. 확장 프로그램이 안정적으로 읽게 하려면 `data/` 아래에 번들 데이터로 복사해야 한다.

데이터 로딩 방식은 기존 title-set 로딩 방식과 맞춘다.

```js
const datasetUrl = chrome.runtime?.getURL
  ? chrome.runtime.getURL(datasetPath)
  : datasetPath;
const response = await fetch(datasetUrl);
```

이 방식은 이미 `features/post/semiconductor-reflux-title-set.js`에서 쓰고 있다.

## 실제 코드 재검증 결과

2026-04-24 기준으로 문서와 실제 코드를 다시 대조한 결과, 구현 전에 반드시 지켜야 할 연결 조건은 아래와 같다.

```text
features/uid-warning-autoban/scheduler.js
- constructor: 상태 필드와 dependency injection 추가 위치
- runCycle: 제목 직차단 직후, UID 그룹핑 직전이 새 기능 삽입 위치
- handleImmediateTitleBanRows: recent-skip이어도 processed set에 넣는 패턴을 새 기능도 따라야 함
- saveState/loadState/getStatus: popup과 background reset에 노출될 새 상태 연결 필요

features/uid-warning-autoban/parser.js
- parseImmediateTitleBanRows: 유동글 포함 파싱 가능
- createImmediateTitleBanTargetPosts: 유동글 post target 생성에 재사용 가능
- normalizeImmediateTitleValue: 삽입문자 제거 기반으로 재사용 가능

features/ip/ban-executor.js + features/ip/api.js
- executeBanWithDeleteFallback: 기존 삭제한도/계정전환 흐름 재사용 가능
- banPostBatch: minor manager update_avoid_list API에 postNo 배열로 차단/삭제 요청

background/background.js
- resetSchedulerStats(uidWarningAutoBan)와 resetUidWarningAutoBanSchedulerState 두 곳 모두 새 상태 초기화 필요

popup/popup.html + popup/popup.js
- status-grid DOM 추가
- FEATURE_DOM 연결
- updateUidWarningAutoBanUI 갱신
- buildDefaultUidWarningAutoBanStatus 기본값 추가
- buildUidWarningAutoBanMetaText 문구 우선순위 추가
```

라인 단위 대조표:

```text
features/uid-warning-autoban/scheduler.js
- 39~88: constructor. 새 상태값, corpus loader dependency, executeBan dependency가 같이 들어가야 함.
- 175~192: runCycle 초반. page1 fetch 후 제목 직차단과 UID 그룹핑 사이에 새 핸들러를 넣어야 함.
- 204~447: 기존 UID 제재 loop. 새 기능이 처리한 postNo는 이 loop로 넘어가지 않게 해야 함.
- 461~575: 제목 직차단 핸들러. recent-skip 처리 방식과 executor 호출 방식을 새 핸들러가 참고해야 함.
- 631~667: saveState. 새 카운터와 recent map 저장 필요.
- 674~727: loadState. 새 카운터와 recent map 복원 및 prune 필요.
- 754~788: getStatus. popup 노출 필드 추가 필요.
- 923~985: recent action helper. 새 recentAttackTitle helper를 같은 패턴으로 추가해야 함.

features/uid-warning-autoban/parser.js
- 18~24: UID 전용/전체 row 파서 분리. 새 기능은 전체 row 파서 사용.
- 26~96: row 파싱. isFluid/ip/title/currentHead가 이미 존재함.
- 201~228: createImmediateTitleBanTargetPosts. 유동글 target 생성에 재사용 가능.
- 356~372: normalizeImmediateTitleValue. 새 normalizeAttackTitle의 기반 함수.

features/ip/ban-executor.js
- 6~120: executeBanWithDeleteFallback. 기존 삭제한도/ban-only fallback을 그대로 타야 함.

features/ip/api.js
- 110~180: banPosts. postNo chunk 처리와 delete_limit 결과 반환.
- 234~275: banPostBatch. avoid_hour/reason/del_chk/nos[] 전송.

background/background.js
- 1687~1717: resetSchedulerStats(uidWarningAutoBan). 통계 초기화 버튼 경로.
- 2722~2755: resetUidWarningAutoBanSchedulerState. 공통 설정 변경 reset 경로.

popup/popup.html
- 1674~1759: 분탕자동차단 status-grid. 새 표시칸 추가 위치.

popup/popup.js
- 483~516: FEATURE_DOM.uidWarningAutoBan. 새 DOM id 연결 위치.
- 4167~4219: updateUidWarningAutoBanUI. 새 상태값 렌더 위치.
- 6100~6130: buildDefaultUidWarningAutoBanStatus. 새 기본값 추가 위치.
- 6165~6208: buildUidWarningAutoBanMetaText. 최근 실제공격 문구 우선순위 추가 위치.
```

재검증 중 발견한 보강사항:

- `knownPattern` 후보와 `sameCycleCluster` 후보를 따로 만들면 같은 postNo가 두 군집에 중복 포함될 수 있다. 따라서 최종 cluster는 union-find로 한 번만 만들고, 실행 직전에도 `assignedPostNos`로 글번호 1회 처리를 강제한다.
- data 파일을 10초마다 fetch하면 불필요하다. pattern corpus는 service worker 생존 동안 memoized promise로 한 번만 로딩하고, 실패 메시지는 같은 메시지를 반복 로그하지 않게 저장한다.
- `recentAttackTitlePostActions`를 추가하면 `prune`, `saveState`, `loadState`, `getStatus`, background reset 두 군데를 모두 연결해야 한다. 한 군데라도 빠지면 popup 표시와 재시도 방지가 어긋난다.
- `attackTitleBanConfig`는 `this.config`를 직접 바꾸지 않고 얕은 복사 override만 써야 한다. 직접 변경하면 기존 깡계 사유 `깡계분탕`이 도배기 사유로 오염될 수 있다.

## 정규화 규칙

새 모듈의 기본 정규화는 기존 `normalizeImmediateTitleValue()`를 재사용한다.

현재 기존 함수가 하는 일:

- `NFKC` 정규화
- invisible character 제거
- 일부 confusable 문자 접기
- 소문자화
- 한글 완성형과 영문만 남김
- 한글 사이에 끼운 영문 filler 제거

새 기능에서는 여기에 공격 제목 클러스터용 후처리를 추가한다.

```js
const MAX_ATTACK_TITLE_LENGTH = 120;

function normalizeAttackTitle(value) {
  const normalized = normalizeImmediateTitleValue(value);
  return normalized
    .replace(/[a-z]+/g, '')
    .trim()
    .slice(0, MAX_ATTACK_TITLE_LENGTH);
}
```

이유:

- 실제공격 샘플에 `오푸스한테벤치따잇hgwqfpyb`처럼 끝에 랜덤 영문이 붙은 변형이 있다.
- 기존 함수는 끝 영문을 보존하므로 같은 공격인데 서로 다른 제목처럼 보일 수 있다.
- 이 기능은 “유동 공격 제목 클러스터” 전용이므로 한글 핵심만 비교하는 편이 맞다.

예시:

```text
오˗푸ˋ스.한ˏ테ˆ벤ˆ치˛따´잇˜hgwqfpyb
-> normalizeImmediateTitleValue: 오푸스한테벤치따잇hgwqfpyb
-> normalizeAttackTitle: 오푸스한테벤치따잇
```

최소 길이 제한도 둔다.

```js
const MIN_ATTACK_TITLE_LENGTH = 8;
const MAX_ATTACK_TITLE_LENGTH = 120;
```

이유:

- `ㅋㅋㅋㅋ`, `안녕`, `질문` 같은 짧은 제목이 여러 개 겹쳐도 차단되면 안 된다.
- 실제 공격 핵심 문장은 모두 8자 이상이다.
- 비정상적으로 긴 제목은 유사도 계산 비용과 오탐 위험이 커지므로 120자까지만 비교한다. 초과분은 잘라서 비교하되 로그에는 원문 제목을 그대로 남긴다.

## 유사도 판정

상수:

```js
const ATTACK_TITLE_CLUSTER_MIN_COUNT = 3;
const ATTACK_TITLE_SIMILARITY_THRESHOLD = 0.95;
const MIN_ATTACK_TITLE_LENGTH = 8;
const MAX_ATTACK_TITLE_LENGTH = 120;
const ATTACK_TITLE_BAN_REASON_TEXT = '도배기IP차단(무고한 경우 문의)';
const ATTACK_TITLE_BAN_HOUR = '6';
const ATTACK_TITLE_PATTERN_DATASET_PATH = 'data/uid-warning-attack-title-patterns-20260424.txt';
```

유사도 함수는 Levenshtein 기반으로 둔다.

```js
similarity = 1 - distance / Math.max(left.length, right.length)
```

예시:

```text
지피티최단퇴클로드미만잡
지피티최단퇴클로드미만잡
=> 100%

지피티최단퇴클로드미만잡
지피티최단퇴클로드미만잡네
=> 약 92~96% 사이, 길이에 따라 판정
```

단, 이번 공격은 삽입 기호 제거 후 거의 exact match로 떨어진다. 유사도 95%는 우회 변형이 조금 남았을 때의 안전장치다.

## 탐지 알고리즘

함수 형태:

```js
function detectAttackTitleClusters(rows, patternCorpus, options = {}) {
  const candidates = [];

  for (const row of rows) {
    if (row?.isFluid !== true) continue;
    if (isAlreadySpamHead(row?.currentHead)) continue;

    const normalizedTitle = normalizeAttackTitle(row?.title || row?.subject || '');
    if (normalizedTitle.length < MIN_ATTACK_TITLE_LENGTH) continue;

    candidates.push({
      row,
      normalizedTitle,
      matchedPattern: findBestPatternMatch(normalizedTitle, patternCorpus),
    });
  }

  return buildAttackTitleClusterComponents(candidates);
}
```

처리 순서:

1. `allRows`에서 유동글만 남긴다.
2. 이미 `도배기` 말머리인 row는 중복 처리 방지를 위해 제외한다.
3. 제목을 `normalizeAttackTitle()`로 정규화한다.
4. 길이 8 미만은 제외한다.
5. 번들 패턴 파일과 95% 이상 유사하면 `knownPattern` 후보가 된다.
6. page1 안에서 서로 95% 이상 유사한 유동글도 `sameCycleCluster` 후보가 된다.
7. 후보들을 union-find로 합쳐 최종 connected component를 만든다.
8. 같은 component 안에 3개 이상 모이면 차단/삭제 대상이 된다.
9. component 정렬은 `최신 글번호 내림차순` 또는 `첫 발견 순서`로 고정한다.
10. 최종 실행 직전 `assignedPostNos`로 이미 다른 component에 들어간 글번호를 제외한다.

union-find를 쓰는 이유:

```text
A와 B가 96% 유사
B와 C가 96% 유사
A와 C가 94% 유사
```

이 경우 단순 greedy 비교면 A-C가 떨어져 다른 군집으로 갈 수 있다. 하지만 B를 매개로 같은 공격 변형일 가능성이 높으므로 connected component로 묶는 편이 안정적이다.

중복 방지 예시:

```js
const assignedPostNos = new Set();
const finalClusters = [];

for (const component of components) {
  const rows = component.rows.filter((row) => {
    const postNo = Number(row?.no) || 0;
    return postNo > 0 && !assignedPostNos.has(postNo);
  });

  if (rows.length < ATTACK_TITLE_CLUSTER_MIN_COUNT) {
    continue;
  }

  for (const row of rows) {
    assignedPostNos.add(Number(row.no));
  }

  finalClusters.push({ ...component, rows });
}
```

`knownPattern`과 `sameCycleCluster`를 같이 쓰는 이유:

- `knownPattern`: 오늘 수집한 실제공격 문구를 확실히 잡는다.
- `sameCycleCluster`: 공격자가 문장을 약간 바꿔도 “page1에 유동이 같은 제목 3개 이상”이면 잡는다.

단, 최종 대상은 반드시 유동글만이다.

패턴 파일을 못 읽어도 전체 기능을 멈추지는 않는다.

```text
patternCorpus 정상:
knownPattern + sameCycleCluster 둘 다 사용

patternCorpus 로딩 실패:
sameCycleCluster만 사용하고 경고 로그 1회 기록
```

이유는 실제 목표가 “page1 유동글 제목 3개 이상 95% 중복”이기 때문이다. pattern corpus는 오늘 공격 문구를 더 잘 잡기 위한 보조 데이터고, page1 자체 군집 판정이 핵심이다.

## Scheduler 연결 위치

현재:

```js
const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const rows = pageUidRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0));
```

변경 후:

```js
const processedImmediatePostNos = await this.handleImmediateTitleBanRows(allRows, nowMs);
const processedAttackTitlePostNos = await this.handleAttackTitleClusterRows(
  allRows.filter((row) => !processedImmediatePostNos.has(Number(row?.no) || 0)),
  nowMs,
);

const processedPostNos = new Set([
  ...processedImmediatePostNos,
  ...processedAttackTitlePostNos,
]);

const rows = pageUidRows.filter((row) => !processedPostNos.has(Number(row?.no) || 0));
```

이 위치가 맞는 이유:

- 제목 직차단은 사용자가 직접 등록한 규칙이라 가장 우선이다.
- 실제공격 제목 클러스터는 유동글 대상이라 UID 깡계 로직보다 먼저 처리해야 한다.
- 이후 UID 로직은 이미 처리된 글번호를 제외하고 돌면 중복 제재가 없다.

## 새 핸들러 설계

추가 메서드:

```js
async handleAttackTitleClusterRows(rows = [], nowMs = Date.now()) {
  const processedAttackTitlePostNos = new Set();
  const patternCorpus = await this.getAttackTitlePatternCorpus();
  const clusters = this.detectAttackTitleClusters(rows, patternCorpus);

  for (const cluster of clusters) {
    if (!this.isRunning) {
      break;
    }

    const targetRows = [];

    for (const row of cluster.rows) {
      const postNo = Number(row?.no) || 0;
      if (postNo <= 0) continue;

      processedAttackTitlePostNos.add(postNo);

      const actionKey = buildAttackTitlePostActionKey(postNo);
      if (shouldSkipRecentAttackTitlePostAction(
        this.recentAttackTitlePostActions[actionKey],
        nowMs,
        getRetryCooldownMs(this.config),
      )) {
        this.log(`ℹ️ 실제공격 제목 클러스터 스킵 - #${postNo}는 최근 처리 이력이 있어 건너뜀`);
        continue;
      }

      targetRows.push(row);
    }

    if (targetRows.length <= 0) continue;

    const targetPosts = createImmediateTitleBanTargetPosts(targetRows);
    if (targetPosts.length <= 0) {
      this.log(`ℹ️ 실제공격 제목 클러스터 스킵 - page1 대상 글번호를 만들지 못함`);
      continue;
    }

    ...
  }

  return processedAttackTitlePostNos;
}
```

중요한 점:

- recent-skip이어도 `processedAttackTitlePostNos`에는 넣는다.
- 그래야 같은 글이 뒤쪽 로직으로 다시 흘러가지 않는다.
- 이번 대상은 유동글이라 UID 로직에는 원래 안 들어가지만, 구조상 즉시차단과 동일하게 맞추는 편이 안전하다.

## 차단 config override

현재 `분탕자동차단` 기본 사유는 `깡계분탕`이다. 새 기능은 도배기 유동 공격 대응이므로 사유를 따로 고정한다.

```js
const attackTitleBanConfig = {
  ...this.config,
  avoidHour: '6',
  avoidReason: '0',
  avoidReasonText: '도배기IP차단(무고한 경우 문의)',
  delChk: true,
  avoidTypeChk: true,
};
```

실행:

```js
const result = await this.executeBan({
  feature: 'uidWarningAutoBan',
  config: attackTitleBanConfig,
  posts: targetPosts,
  deleteEnabled: this.runtimeDeleteEnabled,
  onDeleteLimitFallbackSuccess: ...,
  onDeleteLimitBanOnlyActivated: ...,
});
```

주의:

- `config.delChk`는 true로 넘기지만 실제 삭제 여부는 `deleteEnabled`가 최종 제어한다.
- 현재 구조상 게시물 자동화 공격 중이면 `runtimeDeleteEnabled === false`가 되어 차단만 수행한다.
- 기존 설계를 깨지 않으려면 이 동작은 유지한다.
- 즉 평상시에는 `차단/삭제`, 삭제한도나 monitor ban-only 상태에서는 `차단만`이다.

예시:

```text
평상시:
유동글 3개 매치 -> 6시간 IP차단 + 삭제

삭제한도 초과 상태:
유동글 3개 매치 -> 6시간 IP차단만 수행
```

## 상태값 추가

`Scheduler` 생성자에 추가:

```js
this.lastAttackTitleClusterCount = 0;
this.lastAttackTitleClusterPostCount = 0;
this.lastAttackTitleClusterRepresentative = '';
this.totalAttackTitleClusterPostCount = 0;
this.recentAttackTitlePostActions = {};
this.attackTitlePatternLoadError = '';
this.attackTitlePatternCorpusPromise = null;
this.lastAttackTitlePatternLoadErrorLog = '';
```

`attackTitlePatternCorpusPromise`와 `lastAttackTitlePatternLoadErrorLog`는 런타임 캐시라서 `chrome.storage.local`에 저장하지 않는다.

`runCycle()` 시작 시 초기화:

```js
this.lastAttackTitleClusterCount = 0;
this.lastAttackTitleClusterPostCount = 0;
this.lastAttackTitleClusterRepresentative = '';
```

`saveState()` 저장:

```js
lastAttackTitleClusterCount
lastAttackTitleClusterPostCount
lastAttackTitleClusterRepresentative
totalAttackTitleClusterPostCount
recentAttackTitlePostActions
attackTitlePatternLoadError
```

`loadState()` 복원:

```js
this.lastAttackTitleClusterCount = Math.max(0, Number(...) || 0);
this.lastAttackTitleClusterPostCount = Math.max(0, Number(...) || 0);
this.lastAttackTitleClusterRepresentative = String(... || '');
this.totalAttackTitleClusterPostCount = Math.max(0, Number(...) || 0);
this.recentAttackTitlePostActions = normalizeRecentAttackTitlePostActions(...);
this.attackTitlePatternLoadError = String(... || '');
```

`getStatus()` 반환:

```js
pruneRecentAttackTitlePostActions(this.recentAttackTitlePostActions);

lastAttackTitleClusterCount
lastAttackTitleClusterPostCount
lastAttackTitleClusterRepresentative
totalAttackTitleClusterPostCount
attackTitlePatternLoadError
```

reset 함수도 같이 수정해야 한다.

대상:

- `background/background.js`의 `resetSchedulerStats(feature)` 안 `uidWarningAutoBan` 분기
- `background/background.js`의 `resetUidWarningAutoBanSchedulerState(message)`
- `popup/popup.js`의 `buildDefaultUidWarningAutoBanStatus()`

누락 시 증상:

- `resetSchedulerStats`만 수정하고 `resetUidWarningAutoBanSchedulerState`를 빼먹으면 공통 설정 변경 후 이전 실제공격 통계가 남는다.
- `saveState/loadState`에서 recent map을 빼먹으면 확장 재시작 후 같은 글을 다시 시도할 수 있다.
- `getStatus`에서 새 필드를 빼먹으면 popup은 항상 0으로 보이고 실제 동작 여부를 확인하기 어렵다.

## Popup 표시

기능 자체는 별도 토글을 만들지 않는다.

이유:

- 사용자가 원하는 건 `분탕자동차단`이 10초마다 보는 김에 같이 처리하는 것이다.
- 별도 토글을 만들면 켰는지 안 켰는지 혼동될 수 있다.
- 기존 `분탕자동차단` ON이면 같이 동작하는 것이 제일 단순하다.

대신 상태 표시만 추가한다.

`popup/popup.html`의 분탕자동차단 status-grid에 추가:

```html
<div class="status-item">
  <span class="status-label">최근 실제공격 군집</span>
  <span id="uidWarningAutoBanLastAttackTitleClusterCount" class="status-value">0개</span>
</div>
<div class="status-item">
  <span class="status-label">최근 실제공격 제재</span>
  <span id="uidWarningAutoBanLastAttackTitleClusterPostCount" class="status-value">0개</span>
</div>
<div class="status-item">
  <span class="status-label">최근 실제공격 기준</span>
  <span id="uidWarningAutoBanLastAttackTitleClusterRepresentative" class="status-value">-</span>
</div>
<div class="status-item">
  <span class="status-label">누적 실제공격 글</span>
  <span id="uidWarningAutoBanTotalAttackTitleClusterPostCount" class="status-value">0개</span>
</div>
```

`popup/popup.js`의 `FEATURE_DOM.uidWarningAutoBan`에도 같은 ID를 연결한다.

`updateUidWarningAutoBanUI()`에서 갱신:

```js
dom.lastAttackTitleClusterCount.textContent = `${nextStatus.lastAttackTitleClusterCount ?? 0}개`;
dom.lastAttackTitleClusterPostCount.textContent = `${nextStatus.lastAttackTitleClusterPostCount ?? 0}개`;
dom.lastAttackTitleClusterRepresentative.textContent = nextStatus.lastAttackTitleClusterRepresentative || '-';
dom.totalAttackTitleClusterPostCount.textContent = `${nextStatus.totalAttackTitleClusterPostCount ?? 0}개`;
```

meta 문구도 바꾼다.

현재:

```text
10초마다 1페이지를 확인해 금칙 제목 포함 매치는 즉시 차단하고, 나머지는 글댓총합 20 미만인 5분 2글 burst 깡계와 방명록까지 잠긴 저활동 깡계를 함께 6시간 차단/삭제합니다.
```

변경:

```text
10초마다 1페이지를 확인해 금칙 제목, 실제공격 제목 유동 군집, 글댓총합 20 미만 burst 깡계, 방명록 잠금 저활동 깡계를 함께 6시간 차단/삭제합니다.
```

최근 매치가 있으면 meta 우선순위는 제목 직차단 다음에 둔다.

```js
if ((status.lastAttackTitleClusterPostCount ?? 0) > 0) {
  return `최근 실제공격 제목 군집 ${status.lastAttackTitleClusterRepresentative || '패턴'} / page1 유동글 ${status.lastAttackTitleClusterPostCount ?? 0}개`;
}
```

## 로그 설계

정상 탐지:

```text
🚨 실제공격 제목 클러스터 "지피티최단퇴클로드미만잡" 1개 군집 / 유동글 5개 / 유사도 100.0% -> 제재 시작
⛔ 실제공격 제목 클러스터 글 5개 차단/삭제 완료
```

삭제한도 폴백:

```text
🔁 삭제 한도 계정 전환 성공 - 계정2로 같은 run을 이어갑니다.
```

ban-only 전환:

```text
🧯 실제공격 제목 클러스터 글 5개는 차단만 수행
```

스킵:

```text
ℹ️ 실제공격 제목 클러스터 스킵 - 후보 2개라 기준 3개 미달
ℹ️ 실제공격 제목 클러스터 스킵 - #123456는 최근 처리 이력이 있어 건너뜀
```

데이터 로딩 실패:

```text
⚠️ 실제공격 제목 패턴 로딩 실패 - HTTP 404, 이번 사이클은 page1 자체 군집만 봅니다.
```

## 중복 처리 방지

새 recent map:

```js
recentAttackTitlePostActions
```

구조는 기존 `recentImmediatePostActions`와 동일하게 둔다.

```js
{
  [postNo]: {
    lastActionAt: '2026-04-24T...',
    success: true
  }
}
```

재사용 가능한 헬퍼:

```js
buildAttackTitlePostActionKey(postNo)
createRecentAttackTitlePostActionEntry({ success, nowIso })
shouldSkipRecentAttackTitlePostAction(entry, nowMs, retryCooldownMs)
normalizeRecentAttackTitlePostActions(raw)
pruneRecentAttackTitlePostActions(entries)
```

retention은 기존과 같이 24시간을 쓴다.

이유:

- 삭제/차단 성공한 글은 다시 처리할 필요가 없다.
- 실패한 글은 `retryCooldownMs` 이후 재시도 가능해야 한다.

## 데이터 파일 반영 방식

구현 시 첫 패치에서 다음 파일을 만든다.

```text
data/uid-warning-attack-title-patterns-20260424.txt
```

내용은 현재 파일에서 빈 줄 제거 후 그대로 복사한다.

원본 근거:

```text
docs/실제공격_게시글본문_파싱.txt
```

빌드/패키징 관점:

- Chrome extension은 `data/` 파일을 번들에 포함하고 있다.
- `chrome.runtime.getURL()`로 읽으면 background service worker에서도 접근 가능하다.
- `docs/`는 문서용이라 런타임 의존을 만들지 않는다.

## 테스트 계획

구문 검사:

```bash
node --check features/uid-warning-autoban/attack-title-cluster.js
node --check features/uid-warning-autoban/parser.js
node --check features/uid-warning-autoban/scheduler.js
node --check background/background.js
node --check popup/popup.js
```

패턴 정규화 확인:

```bash
node --input-type=module <<'NODE'
import fs from 'fs';
import { normalizeAttackTitle } from './features/uid-warning-autoban/attack-title-cluster.js';

const lines = fs.readFileSync('data/uid-warning-attack-title-patterns-20260424.txt', 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const counts = new Map();
for (const line of lines) {
  const normalized = normalizeAttackTitle(line);
  counts.set(normalized, (counts.get(normalized) || 0) + 1);
}

console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
NODE
```

기대:

```text
오푸스한테벤치따잇 100개 이상
지피티최단퇴클로드미만잡 50개 이상
결국오푸스미만잡이네 40개 이상
```

HTML 시뮬레이션:

```bash
node --input-type=module <<'NODE'
import fs from 'fs';
import { parseImmediateTitleBanRows } from './features/uid-warning-autoban/parser.js';
import {
  loadAttackTitlePatternCorpusFromText,
  detectAttackTitleClusters,
} from './features/uid-warning-autoban/attack-title-cluster.js';

const html = fs.readFileSync('docs/html.md', 'utf8');
const patternText = fs.readFileSync('data/uid-warning-attack-title-patterns-20260424.txt', 'utf8');
const corpus = loadAttackTitlePatternCorpusFromText(patternText);
const rows = parseImmediateTitleBanRows(html);
const clusters = detectAttackTitleClusters(rows, corpus);

console.log({
  rows: rows.length,
  fluidRows: rows.filter((row) => row.isFluid).length,
  clusters: clusters.map((cluster) => ({
    representative: cluster.representative,
    count: cluster.rows.length,
    postNos: cluster.rows.map((row) => row.no),
  })),
});
NODE
```

주의:

- 현재 `docs/html.md`에 실제 오늘 공격 row가 없다면 cluster는 0개가 맞다.
- 실제공격 HTML을 저장해 넣으면 3개 이상 cluster가 나와야 한다.

## 정적 검증 체크리스트

1. page1 HTML fetch는 기존 1회만 사용한다.
2. 새 기능 때문에 추가 DC 요청이 생기지 않는다.
3. `allRows`는 유동/UID 전체 row라서 새 기능 대상 확보 가능하다.
4. `pageUidRows`는 기존 UID 로직용으로 계속 유지된다.
5. 제목 직차단이 새 기능보다 먼저 돈다.
6. 제목 직차단으로 처리된 글은 실제공격 클러스터에서 제외된다.
7. 실제공격 클러스터로 처리된 글번호는 UID 로직에서 제외된다.
8. 유동글만 대상이라 고닉/반고닉 정상글은 잡지 않는다.
9. `isPicturePost === true`도 제목 공격이면 잡을지 결정해야 한다. 기본은 제목 기준이므로 포함 가능하다.
10. 이미 `도배기` 말머리인 글은 중복 처리 방지를 위해 제외한다.
11. 제목 정규화 결과 길이 8 미만은 제외한다.
12. 삽입 기호만 다른 제목은 같은 normalized title로 묶인다.
13. 랜덤 영어 꼬리가 붙어도 한글 핵심 기준으로 묶인다.
14. 영문만 있는 제목은 normalized title이 비거나 짧아져 제외된다.
15. 숫자만 다른 공격 제목은 숫자 제거 후 묶인다.
16. cluster 3개는 기준 미달이라 제재하지 않는다.
17. cluster 3개는 제재한다.
18. cluster 5개 이상은 한 번에 같은 executor로 넘긴다.
19. 같은 postNo 중복 row는 `createImmediateTitleBanTargetPosts()`에서 dedupe된다.
20. 성공한 postNo는 recent map에 저장되어 다시 처리하지 않는다.
21. 실패한 postNo는 cooldown 이후 재시도 가능하다.
22. 패턴 파일 로딩 실패가 전체 scheduler 오류로 번지지 않는다.
23. 패턴 파일 로딩 실패 시 로그를 남긴다.
24. `sameCycleCluster`는 패턴 파일 없이도 page1 내부 유사 제목 3개를 잡는다.
25. `knownPattern`은 실제공격 corpus와 95% 이상 유사해야 후보가 된다.
26. 삭제한도 폴백은 기존 계정 전환 로직을 그대로 탄다.
27. 삭제한도 폴백 실패 시 ban-only로 전환되는 기존 안전장치를 유지한다.
28. monitor attack ban-only 상태에서는 차단만 수행한다.
29. `runtimeDeleteEnabled` 업데이트는 기존과 같이 `result.finalDeleteEnabled`를 반영한다.
30. `totalBannedPostCount`와 `totalFailedPostCount`가 새 기능 결과도 포함한다.
31. 새 전용 누적값 `totalAttackTitleClusterPostCount`도 성공 수만 반영한다.
32. reset 버튼은 새 카운터와 recent map도 초기화한다.
33. 공통 설정 변경 reset도 새 카운터와 recent map을 초기화한다.
34. popup 기본 status에 새 필드가 없어도 `?? 0` fallback으로 깨지지 않는다.
35. 로그 100개 제한은 기존 그대로 유지된다.
36. helper export는 테스트 가능한 함수만 노출하고 scheduler 내부 전용 함수는 과도하게 export하지 않는다.
37. data 파일은 UTF-8 텍스트로 저장한다.
38. 주석은 필요할 때만 한글 UTF-8로 짧게 둔다.

## 구현 순서

1. `data/uid-warning-attack-title-patterns-20260424.txt`를 만든다.
2. `features/uid-warning-autoban/attack-title-cluster.js`를 만든다.
3. 정규화, corpus 로딩, 유사도, cluster detect 함수를 구현한다.
4. `scheduler.js`에 import와 dependency injection을 추가한다.
5. `Scheduler` 상태 필드와 recent map을 추가한다.
6. `runCycle()`에서 제목 직차단 다음에 `handleAttackTitleClusterRows()`를 호출한다.
7. `handleAttackTitleClusterRows()`를 구현한다.
8. `saveState()`, `loadState()`, `getStatus()`에 새 상태를 연결한다.
9. `background/background.js` reset 분기 2곳에 새 상태 초기화를 추가한다.
10. `popup/popup.html`에 상태 row 4개를 추가한다.
11. `popup/popup.js` DOM 연결, UI 갱신, 기본 status, meta 문구를 수정한다.
12. 구문 검사와 패턴 정규화 스크립트를 실행한다.
13. 가능하면 `docs/html.md` 또는 별도 fixture로 탐지 시뮬레이션을 실행한다.

## 예상 변경 파일

```text
data/uid-warning-attack-title-patterns-20260424.txt
features/uid-warning-autoban/attack-title-cluster.js
features/uid-warning-autoban/scheduler.js
background/background.js
popup/popup.html
popup/popup.js
docs/0424/uid_warning_attack_title_cluster_defense_plan.md
```

## 최종 패치 전 연결 검증

2026-04-24 패치 직전 기준으로 한 번 더 실제 호출 경로를 확인했다.

결론:

- `runCycle()`은 page1 HTML을 한 번만 가져오므로 새 기능을 넣어도 DC list 요청 수는 늘지 않는다.
- `allRows`는 이미 유동글을 포함하고 있으므로 새 parser를 만들 필요가 없다.
- `createImmediateTitleBanTargetPosts()`는 유동글의 `ip`, `uid`, `subject`, `currentHead`를 그대로 담을 수 있으므로 새 target builder를 만들 필요가 없다.
- `executeBanWithDeleteFallback()`은 `options.config`를 복사해서 쓰므로 `attackTitleBanConfig` override가 기존 scheduler config를 오염시키지 않는다.
- `features/ip/api.js`의 `banPostBatch()`는 `galleryId`, `galleryType`, `avoidHour`, `avoidReasonText`, `delChk`, `avoidTypeChk`, `nos[]`만 필요로 하므로 새 기능 대상도 기존 게시글 IP차단/삭제 API로 처리 가능하다.
- monitor 공격 상태에서 `runtimeDeleteEnabled === false`이면 새 기능도 차단만 수행한다. 기존 게시물 자동화와의 안전장치를 유지하는 것이므로 문서상 의도와 맞다.
- popup은 새 토글 없이 status만 추가하면 된다. 별도 설정 저장 흐름은 필요 없다.
- `buildPersistedConfig()`는 새 기능 설정을 저장하지 않아도 된다. 새 기능은 상수 기반 기본 동작이고 사용자 입력값이 아니기 때문이다.
- reset 경로는 두 개다. 통계 초기화 버튼은 `resetSchedulerStats()`, 공통 갤러리 변경은 `resetUidWarningAutoBanSchedulerState()`를 타므로 둘 다 수정해야 한다.
- service worker가 재시작되면 pattern corpus는 다시 로딩된다. data 파일은 작고 1회 로딩이라 문제 없다.

패치 시 반드시 지킬 순서:

1. `attack-title-cluster.js`를 먼저 만들고 node에서 helper export를 확인한다.
2. `scheduler.js`에 import/dependency/state만 먼저 연결한다.
3. `runCycle()` 연결은 마지막에 넣는다. 그래야 중간 패치 상태에서 cycle이 깨질 가능성이 낮다.
4. `background/background.js` reset 2곳을 즉시 같이 수정한다.
5. `popup` DOM과 JS 연결을 같은 커밋 안에서 같이 수정한다.
6. `data/uid-warning-attack-title-patterns-20260424.txt`를 만든 뒤 패턴 정규화 테스트를 먼저 돌린다.
7. 구문 검사 후 `docs/html.md` 시뮬레이션을 돌린다.

최종 판단:

```text
구조 변경으로 기존 flow가 깨질 가능성은 낮다.
주의할 부분은 새 상태값 연결 누락과 cluster 중복 처리뿐이고,
문서에 반영한 union-find + assignedPostNos + reset 2곳 수정으로 제어 가능하다.
```

## 논리 결론

이 기능은 기존 구조를 크게 바꾸지 않고 붙일 수 있다.

핵심 이유:

- page1 HTML은 이미 10초마다 한 번 받고 있다.
- 유동 row는 이미 `parseImmediateTitleBanRows()`에서 파싱된다.
- 차단/삭제 executor는 postNo 배열만 있으면 기존 minor manager API로 처리 가능하다.
- 새 기능은 “정규화 + 클러스터 판정”만 추가하면 된다.

가장 중요한 연결점은 `runCycle()`의 제목 직차단 직후다.

예시 흐름:

```text
10초 tick
-> page1 HTML fetch
-> row 50개 파싱
-> 제목 직차단 먼저 처리
-> 남은 유동글 제목 정규화
-> "지피티최단퇴클로드미만잡" 유동글 5개 발견
-> 5개를 도배기IP차단(무고한 경우 문의) / 6시간 / 삭제 포함으로 executor 호출
-> 성공 글번호 recent map 저장
-> UID 깡계 로직은 나머지 UID 글만 검사
```

파생 위험은 제한적이다.

- 네트워크 부하는 증가하지 않는다.
- page1 row 수 기준 O(n²) 유사도 비교라 n이 작아 성능 부담은 낮다.
- false positive는 “유동글만”, “길이 8 이상”, “3개 이상”, “95% 유사”로 줄인다.
- 기존 삭제한도/ban-only 안전장치를 그대로 타므로 계정 폴백 흐름도 깨지지 않는다.
