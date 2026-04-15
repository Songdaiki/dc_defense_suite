# 댓글 역류기 검색 중복 방어 구현 계획

## 1. 목표

현재 댓글 역류기 방어는 `dataset exact-match`까지만 된다.

즉:

- 댓글 본문이 공용 dataset에 있으면 삭제
- 공용 dataset에 없으면 그냥 통과

이 구조라서, 공격자가 **최근 갤 게시물 제목을 댓글로 복붙**하면 뚫릴 수 있다.

이번 기능의 목표는 이거다.

- `reflux comment = datasetMatch || searchDuplicateMatch`

쉽게 예시로:

- 공격 댓글: `특ᅠ이ᅠ점ᅠ미니갤러리ᅠ이주했으면ᅠㅈ망했음`
- dataset에는 아직 없음
- 하지만 검색 기준 갤의 `getSearch` 결과에
  - `특이점 미니갤러리 이주했으면 ㅈ망했음`
  - 같은 과거 글이 있음
- 그러면 그 댓글은 **역류기 댓글로 삭제 대상**

중요:

- **판정 기준 메인 축은 search duplicate**
- **실행 순서 기준으로는 dataset/cache를 먼저 봐서 부하를 줄임**
- **실제 삭제 호출은 지금처럼 글 단위 batch를 유지**
- **단, dataset/cache obvious hit를 search miss 뒤에 묶어 지연시키지 않도록 즉시 batch와 검색확정 batch를 분리**

즉 한 줄 요약:

- `댓글 -> dataset/cache obvious hit는 즉시 batch -> miss만 검색 -> search positive는 그 글에서 다시 batch`

---

## 2. 실제 코드 교차검증 결과

이번 문서는 아래 실제 로직을 다시 확인한 뒤 작성했다.

### 2.1 현재 댓글 수동 방어

현재 댓글 수동 방어의 핵심 흐름:

1. 게시물 목록 조회
2. 댓글 있는 글만 추림
3. 게시물별 댓글 전체 조회
4. 유동 댓글만 추림
5. 공격 모드 필터 적용
6. 삭제/차단 API 호출
7. 삭제 검증

핵심 위치:

- 목록 조회: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L120)
- 댓글 전체 조회: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L188)
- 유동 댓글 추림: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L221)
- 공격 모드 필터: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L228)
- 삭제 호출: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L242)
- 삭제 검증: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L294)

즉 지금은 `processPost()` 안에서 **한 글의 댓글을 다 본 뒤 한 번에 삭제**하는 구조다.

이 구조는 유지해야 한다.

### 2.2 현재 댓글 역류기 판정

현재 `COMMENT_REFLUX` 모드는 exact-match만 본다.

- 정규화: [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L108)
- dataset 체크: [features/comment/comment-reflux-dataset.js](/home/eorb915/projects/dc_defense_suite/features/comment/comment-reflux-dataset.js#L98)
- 필터 적용: [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L155)

즉 현재는:

- `hasCommentRefluxMemo(comment.memo)`가 true면 삭제
- false면 통과

여기에는 검색 확인이 없다.

### 2.3 현재 자동 댓글 감시

자동 댓글 감시는 child로 `commentScheduler`를 띄운다.

- 공격 진입 후 child 시작: [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L386)
- child 시작 시 attack mode 전달: [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L416)
- 이미 실행 중이면 runtime attack mode 전환: [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L439)

즉 `commentScheduler`의 `COMMENT_REFLUX` 동작만 바꾸면:

- 수동 댓글 방어
- 자동 댓글 감시 child 방어

둘 다 같은 구현을 그대로 탄다.

별도 자동 전용 삭제 엔진을 만들 필요는 없다.

### 2.4 현재 삭제 API 단위

현재 댓글 삭제/차단 API는 이미 **글번호 기준 batch** 구조다.

- 삭제: [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L301)
- 삭제+차단: [features/comment/api.js](/home/eorb915/projects/dc_defense_suite/features/comment/api.js#L352)

API 형태:

- 삭제: `postNo + commentNos[]`
- 삭제+차단: `parent(postNo) + nos[]`

즉 이번 기능도:

- `positive 나오자마자 댓글 1개씩 삭제`

가 아니라

- **그 글에서 최종 확정된 commentNos를 한 번에 묶어서 삭제**

로 가는 게 맞다.

### 2.5 현재 게시물 검색 중복 브로커

게시물 쪽에는 이미 검색 큐 + cache + single worker가 있다.

- 브로커: [features/post/reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js#L1)
- queue 적재: [features/post/reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js#L146)
- worker: [features/post/reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js#L194)
- `getSearch` 호출: [features/post/reflux-search-duplicate-broker.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-broker.js#L288)

이 구조는 재사용 가치가 크다.

다만 댓글에서는 **그대로 복붙하면 안 된다.**

이유는 아래 3장에서 설명한다.

---

## 3. 그대로 복붙하면 안 되는 이유

### 3.1 댓글은 삭제가 scheduler 소유여야 한다

댓글 쪽은 삭제 성공 후 검증 수를 `commentScheduler`가 직접 누적한다.

- 검증 카운트 적립: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L257)
- 최근 삭제 수 조회: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L421)
- comment monitor가 이 수치를 공격 종료 판정에 사용: [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L149)

즉 broker가 직접 삭제해버리면:

- 검증 카운트
- 총 삭제 수
- monitor release 조건

이 전부 연결이 꼬인다.

그래서 원칙은 이거다.

- **broker는 검색 확인만 한다**
- **실제 삭제/검증/통계는 scheduler가 한다**

### 3.2 댓글은 “positive/negative”가 caller 문맥에 따라 달라질 수 있다

게시물 검색 결과에서 `현재 글과 동일한 postNo`는 self-match라서 제외해야 한다.

이 규칙은 댓글에도 그대로 필요하다.

예시:

- 현재 댓글이 달린 글이 `#1001`
- 검색 결과가 `#1001` 한 개만 잡힘
- 이건 “과거 중복”이 아니라 **현재 글 자기 자신 제목**일 수 있다

문제는 같은 댓글 문구가 다른 글 `#1002`에도 달리면:

- `#1001` 입장에서는 self-match라서 negative
- `#1002` 입장에서는 `#1001`이 과거/타글 매치라서 positive

즉:

- 검색 fetch는 `문구 기준`으로 하나로 묶을 수 있지만
- 최종 positive/negative 판정은 `currentPostNo`까지 보고 caller별로 계산해야 한다

그래서 댓글 broker는 **query-level fetch cache**와 **caller-level final decision**을 분리해야 한다.

단순한 `title -> positive cache`만으로는 부족하다.

### 3.3 댓글은 파서에서 비동기 검색을 하면 안 된다

현재 parser의 `filterDeletionTargetComments()`는 완전 동기 함수다.

- 위치: [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L146)

여기에 검색 await를 넣기 시작하면:

- parser 책임이 커지고
- `DEFAULT / EXCLUDE_PURE_HANGUL / COMMENT_REFLUX`
  세 모드가 섞이고
- 테스트 포인트가 흐려진다

그래서 댓글 search duplicate는 parser가 아니라:

- **`commentScheduler.processPost()` 안의 COMMENT_REFLUX 분기**

에 붙는 게 맞다.

---

## 4. 최종 구현 방향

최종 구현 방향은 이거다.

### 4.1 원칙

1. `COMMENT_REFLUX`에서만 search duplicate를 사용한다.
2. dataset hit는 즉시 삭제 후보에 넣는다.
3. dataset miss만 search broker에 물어본다.
4. broker는 검색 확인만 한다.
5. scheduler는 삭제 phase를 직접 관리한다.
6. `dataset hit + search cache positive`는 즉시 batch로 먼저 삭제한다.
7. true miss에서 search positive가 나오면 그 글에서 두 번째 batch로 삭제한다.
8. 자동 댓글 감시 child는 `commentScheduler`를 그대로 쓰므로 별도 삭제 로직을 만들지 않는다.

### 4.2 가장 쉬운 플로우

글 `#1001`의 유동 댓글:

- `11`: dataset hit
- `12`: dataset miss, search positive
- `13`: dataset miss, search negative
- `14`: dataset miss, search positive

그러면 실제 흐름은:

1. `11`은 즉시 delete bucket에 추가
2. `12`, `13`, `14`는 broker에 검색 확인 요청
3. 즉시 delete bucket이 비어 있지 않으면 먼저 한 번 batch 삭제
4. broker 결과가 돌아옴
5. `12`, `14`만 search-confirmed bucket에 추가
6. search-confirmed bucket이 비어 있지 않으면 두 번째 batch 삭제
7. 검증/통계는 두 batch 모두 기존 코드 그대로 누적

즉:

- 검색은 댓글별로 확인될 수 있어도
- 삭제 호출은 **댓글 1개씩 쪼개지지 않고 batch 유지**
- 한 글에서 **최대 2회 batch**는 허용한다

### 4.3 이번 재검토에서 추가로 찾은 핵심 이슈

문서 첫 버전의 “그 글의 delete bucket을 끝까지 모아 마지막에 한 번만 삭제” 설계에는 지연 문제가 있다.

예시:

- 글 `#1001`에 dataset hit 3개
- 같은 글에 dataset miss 15개
- miss 15개가 거의 전부 서로 다른 문구라서 search queue에 15건

이 경우 마지막 한 번만 삭제하는 구조면:

- 이미 확정된 dataset hit 3개도
- miss 15개 search가 다 끝날 때까지 기다리게 된다

댓글 공격 상황에서는 이 지연이 체감될 수 있다.

그래서 이번 문서 기준 최종 권장안은:

1. `dataset hit + search cache positive hit`는 **즉시 batch**
2. `true miss`만 검색 대기
3. 검색에서 나중에 positive가 된 것만 **두 번째 batch**

즉 “댓글을 1개씩 지우지 말자”는 원칙은 유지하되,

- **한 글당 1회 고집은 버리고**
- **한 글당 최대 2회 batch**로 바꾸는 것이 더 안전하다

---

## 5. 권장 모듈 구조

## 5.1 새 공용 정규화 모듈

새 파일 권장:

- `features/reflux-normalization.js`

이유:

- 지금 게시물 검색 정규화 로직은 [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L72)에 들어 있다
- 댓글이 이 파일을 직접 import하면 의미가 이상해진다
- `attack mode`와 `reflux text normalization`은 책임이 다르다

권장 export:

- `buildRefluxSearchQuery(value)`
- `normalizeRefluxCompareKey(value)`

역할:

- 공격자가 넣는 invisible filler 제거/복원
- 검색용 쿼리 만들기
- exact compare용 key 만들기

### 5.2 댓글용 memo wrapper

기존 파일:

- [features/comment/parser.js](/home/eorb915/projects/dc_defense_suite/features/comment/parser.js#L93)

여기에 아래 wrapper 추가 권장:

- `buildCommentRefluxSearchQuery(memo)`
- `normalizeCommentRefluxCompareKey(memo)`

동작:

1. `normalizeCommentMemo(memo)`로 HTML/entity 제거
2. 그 plain text를 shared reflux normalization에 넣음

즉 댓글은 **원문 memo를 바로 검색 정규화하지 말고**

- HTML 제거
- entity decode
- `<br>` 정리

를 끝낸 plain text 기준으로 처리해야 한다.

### 5.3 댓글용 search duplicate broker

새 파일 권장:

- `features/comment/comment-reflux-search-duplicate-broker.js`

역할:

- `getSearch` 요청 single worker
- query-level cache/pending dedupe
- caller-level final decision 계산
- JSONP 응답 파싱은 기존
  [features/post/reflux-search-duplicate-parser.js](/home/eorb915/projects/dc_defense_suite/features/post/reflux-search-duplicate-parser.js)
  를 재사용하는 쪽이 가장 안전하다

중요:

- **이 broker는 직접 삭제하지 않는다**
- **검색 결과를 scheduler에 돌려주기만 한다**
- **pending miss 때문에 obvious hit 삭제가 막히지 않도록, 삭제 phase 제어는 scheduler가 쥔다**

### 5.4 scheduler 내부 COMMENT_REFLUX 전용 분기

수정 파일:

- [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L163)

`processPost()`에서:

- `DEFAULT / EXCLUDE_PURE_HANGUL`은 기존 parser 경로 유지
- `COMMENT_REFLUX`만 별도 async 경로로 분리

권장 함수:

- `planCommentRefluxDeletion(postNo, fluidComments)`
- `resolveDeferredCommentRefluxTargets(postNo, pendingSearchJobs, statsSeed)`
- `executeCommentDeletionBatch(postNo, commentNos, esno, sharedEsno, phaseLabel)`

이 함수들이:

1. immediate batch 후보 생성
2. dataset/cache positive 즉시 batch 실행
3. dataset miss 검색 promise 수집
4. search 결과 회수 후 deferred batch 후보 생성
5. deferred batch 실행
6. 삭제/검증/통계는 기존 코드 재사용

을 담당한다.

---

## 6. 브로커 상세 설계

## 6.1 브로커의 핵심 아이디어

브로커는 두 단계를 분리한다.

### 1단계: query-level fetch

문구 기준으로 검색 fetch를 1회만 수행

예시:

- `특이점 미니갤러리 이주했으면 ㅈ망했음`

이 문구는 여러 댓글에서 반복돼도 `getSearch`는 한 번만 친다.

### 2단계: caller-level final decision

검색 결과 rows를 보고,

- `deleteGalleryId`
- `searchGalleryId`
- `currentPostNo`

를 반영해서 최종적으로 positive/negative를 계산한다.

즉:

- fetch는 문구 기준 공유
- 최종 판정은 호출자별 계산

## 6.2 runtimeState 권장 구조

```js
const runtimeState = {
  loaded: false,
  loadPromise: null,
  cacheMap: new Map(),       // cacheKey -> cached search rows / status
  pendingMap: new Map(),     // cacheKey -> deferred fetch promise
  queue: [],
  workerPromise: null,
  generation: 0,
  logger: null,
};
```

### cacheMap entry 권장 형태

```js
{
  cacheKey,
  searchTargetGalleryId,
  normalizedTitle,
  result: 'success' | 'error',
  checkedAt,
  expiresAt,
  retryAt,
  rows: [
    {
      boardId,
      postNo,
      href,
      normalizedTitle,
    }
  ],
  errorMessage,
}
```

중요:

- post broker처럼 단순 `positive/negative`만 저장하지 말고
- **rows까지 저장**해야 caller별 currentPostNo 판정이 가능하다

## 6.3 브로커 export 권장

- `ensureCommentRefluxSearchDuplicateBrokerLoaded()`
- `resetCommentRefluxSearchDuplicateBrokerRuntime()`
- `setCommentRefluxSearchDuplicateBrokerLogger(logger)`
- `resolveCommentRefluxSearchDuplicateDecision(context)`
- `peekCommentRefluxSearchDuplicateDecision(context)`

### `resolve...` 반환 형태 권장

```js
{
  result: 'positive' | 'negative' | 'error' | 'cancelled',
  source: 'search_cache' | 'search_queue' | 'search_error' | 'cancelled',
  matchedRow: { boardId, postNo, href } | null,
}
```

### `peek...` 역할

- 이미 cache/pending에 있는 것만 즉시 판단
- miss면 enqueue는 하지 않음

이 함수는 로그 통계용으로만 있으면 되고, 구현 단순화를 원하면 생략 가능하다.

## 6.4 enqueue/pending 설계

권장 방식:

- `cacheKey = searchGalleryId + normalizedCompareKey`
- pending도 이 key 기준으로 dedupe
- pending promise의 결과는 **rows**다

즉 같은 문구의 요청이 여러 글에서 와도:

- 모두 같은 pending promise를 await
- 네트워크 fetch는 1회만 수행
- 각 caller가 rows를 받아 자기 postNo 기준으로 최종 decision 계산

이 구조면 broker가 댓글 번호 waiter를 직접 들고 있을 필요가 없다.

그 이유는 실제 삭제를 scheduler가 최종 batch 처리하기 때문이다.

## 6.5 stale/cancel 처리

이건 꼭 필요하다.

브로커 reset 시:

- `generation` 증가
- queue 비움
- pending promise 전부 `cancelled`로 resolve

이걸 안 하면:

- stop 직후에도 `processPost()`가 promise 대기 상태로 남고
- run loop 종료나 mode 전환이 깔끔하게 안 끝날 수 있다

즉 reset 함수는 단순히 `Map.clear()`만 하면 안 된다.

## 6.6 브로커 수명주기 연결

이 부분은 구현 전에 문서로 못 박아야 한다.

현재 post scheduler는 search broker 수명주기를 직접 잡고 있다.

- start 시 load/reset: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L97)
- stop 시 reset: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L132)

댓글도 같은 패턴이 필요하다.

권장 규칙:

1. `commentScheduler.start()`에서 `COMMENT_REFLUX`면 broker load + reset
2. `commentScheduler.stop()`에서 broker reset
3. `setRuntimeAttackMode()`에서 `COMMENT_REFLUX` 진입/이탈 시 broker reset
4. `resumeIfNeeded()`에서 저장된 모드가 `COMMENT_REFLUX`면 broker load + reset

이걸 안 하면 생길 수 있는 문제:

- stop 직후 예전 pending 결과가 늦게 돌아옴
- mode 전환 후 이전 run의 search result가 새 run에 섞임
- extension 재시작 후 stale queue 상태가 복원된 것처럼 보임

---

## 7. scheduler 상세 설계

## 7.1 새 helper 함수

`features/comment/scheduler.js` 안에 아래 helper 추가 권장:

- `planCommentRefluxDeletion(postNo, fluidComments, esno?)`
- `resolveDeferredCommentRefluxTargets(postNo, pendingSearchJobs, statsSeed)`
- `executeCommentDeletionBatch(postNo, commentNos, esno, sharedEsno, phaseLabel)`
- `buildCommentRefluxSearchContext(postNo)`
- `logCommentRefluxFilterSummary(postNo, stats)`

## 7.2 `processPost()` 변경안

현재는 이 코드가 전부다.

- `filterDeletionTargetComments(fluidComments, ...)`

이걸 아래처럼 바꾼다.

### DEFAULT / EXCLUDE_PURE_HANGUL

기존 유지:

```js
const deletionTargets = filterDeletionTargetComments(fluidComments, ...)
```

### COMMENT_REFLUX

새 경로:

```js
const {
  immediateTargets,
  pendingSearchJobs,
  statsSeed,
} = await this.planCommentRefluxDeletion(postNo, fluidComments);

if (immediateTargets.length > 0) {
  await this.executeCommentDeletionBatch(postNo, immediateTargets, esno, sharedEsno, '즉시');
}

const {
  deferredTargets,
  stats,
} = await this.resolveDeferredCommentRefluxTargets(postNo, pendingSearchJobs, statsSeed);

if (deferredTargets.length > 0) {
  await this.executeCommentDeletionBatch(postNo, deferredTargets, esno, sharedEsno, '검색확정');
}
```

그리고 그 아래 삭제/검증 로직은 그대로 재사용한다.

즉 바뀌는 건:

- “삭제 대상 선정”
- “즉시 batch / 검색확정 batch orchestration”

뿐이고,

- 삭제 호출
- 검증
- 통계 적립

은 기존 코드를 최대한 안 건드린다.

## 7.3 `planCommentRefluxDeletion()` 내부 플로우

권장 구현:

```js
async planCommentRefluxDeletion(postNo, fluidComments) {
  const immediateDeleteBucket = new Set();
  const pendingJobs = [];
  const statsSeed = {
    datasetCount: 0,
    searchCachePositiveCount: 0,
    searchPositiveCount: 0,
    searchNegativeCount: 0,
    searchErrorCount: 0,
  };

  for (const comment of fluidComments) {
    if (hasCommentRefluxMemo(comment.memo)) {
      immediateDeleteBucket.add(String(comment.no));
      statsSeed.datasetCount += 1;
      continue;
    }

    const cachedDecision = peekCommentRefluxSearchDuplicateDecision(...);
    if (cachedDecision.result === 'positive') {
      immediateDeleteBucket.add(String(comment.no));
      statsSeed.searchCachePositiveCount += 1;
      continue;
    }

    pendingJobs.push(
      resolveCommentRefluxSearchDuplicateDecision(...)
        .then((decision) => ({ comment, decision }))
    );
  }

  return {
    immediateTargets: [...immediateDeleteBucket],
    pendingSearchJobs,
    statsSeed,
  };
}
```

핵심:

- immediate bucket과 deferred bucket을 분리한다
- dataset/cache positive는 **즉시 phase**
- true miss만 search await
- search positive는 **검색확정 phase**
- 댓글 1개씩 삭제하지 않고 phase별 batch를 유지한다

## 7.4 실제 예시

글 `#1001` 유동 댓글 6개:

- `11`: dataset hit
- `12`: search cache positive
- `13`: dataset miss -> search negative
- `14`: dataset miss -> search positive
- `15`: dataset miss -> error
- `16`: dataset hit

그러면:

- 즉시 batch: `[11, 12, 16]`
- 즉시 삭제 호출:
  - `deleteAndBanComments(config, 1001, ['11', '12', '16'])`
- search 결과 반영 후 deferred batch: `[14]`
- 검색확정 삭제 호출:
  - `deleteAndBanComments(config, 1001, ['14'])`

즉 search는 개별 판정이지만 삭제는 여전히 batch다.
차이는:

- obvious hit를 search miss 때문에 늦추지 않는다는 점이다

---

## 8. 검색 결과 최종 판정 규칙

`findApplicableDuplicateMatch(rows, context)` 같은 helper를 둔다.

입력:

- `rows`
- `deleteGalleryId`
- `searchGalleryId`
- `currentPostNo`
- `normalizedTitle`

판정 규칙:

1. `row.normalizedTitle !== normalizedTitle`면 스킵
2. `row.boardId !== searchGalleryId`면 스킵
3. `searchGalleryId === deleteGalleryId && row.postNo === currentPostNo`면 self-match라서 스킵
4. 그 외 첫 row가 있으면 positive
5. 끝까지 없으면 negative

쉽게 예시:

- 현재 댓글이 달린 글: `#1001`
- 검색 결과 rows:
  - `thesingularity #1001`
  - `thesingularity #998877`

그러면:

- `#1001`은 self-match라 스킵
- `#998877`이 남으므로 positive

반대로 rows가:

- `thesingularity #1001` 하나뿐

이면:

- self-match만 있으므로 negative

---

## 9. 검색 기준 갤 ID 분리

이건 댓글도 꼭 필요하다.

현재 댓글 scheduler config에는 별도 검색 갤 ID가 없다.

- 현재 config 선언: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L54)

권장 추가 필드:

- `refluxSearchGalleryId: ''`

규칙:

- 비어 있으면 `config.galleryId` 사용
- 값이 있으면 그 값을 검색 기준 갤로 사용

쉽게 예시:

- 삭제 대상 갤: `thesingularity`
- 검색 기준 갤: `tsmcsamsungskhynix`

이 경우:

- 댓글 삭제는 특갤에서 수행
- search duplicate는 반도체갤 기준으로 확인

이 분리가 없으면:

- 삭제 대상 갤과 검색 기준 갤을 따로 운영할 수 없다

### 연결 위치

- 댓글 탭 설정 UI에 입력란 추가
- popup save/load 연결
- popup `getFeatureConfigInputs('comment')`에 새 input 추가
- popup `updateCommentUI()`의 `syncFeatureConfigInputs('comment', ...)`에 새 값 추가
- background `comment updateConfig`에서 정규화/검증
- comment scheduler state 저장/복원

현재 실제 코드 기준으로는:

- post 쪽만 `refluxSearchGalleryId` 정규화/검증 분기가 이미 있다
- 위치: [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L543)
- 댓글 탭 HTML 설정 블록에는 아직 검색 갤 ID input이 없다
  - 위치: [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html#L566)
- 댓글 save handler도 현재는 `minPage/maxPage/requestDelay/cycleDelay/postConcurrency/banOnDelete/avoidHour`만 저장한다
  - 위치: [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1332)
- 댓글 상태 UI sync도 현재는 같은 기존 필드만 반영한다
  - 위치: [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2426)
- 댓글 설정 dirty tracking/lock 대상 input 집합은 이미 공용 함수로 묶여 있다
  - dirty tracking: [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3267)
  - comment input 집합: [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3318)
- 즉 새 input을 `getFeatureConfigInputs('comment')`에 넣으면 dirty tracking과 monitor 중 lock은 자동으로 따라온다
- comment 쪽은 현재 실행 중 저장 자체를 background에서 막지 않는다
  - block 정책 진입점: [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1183)
- 즉 새 필드를 그냥 추가만 하면, 실행 중 broker cache/pending 문맥이 섞일 수 있다

즉 댓글 쪽은 이번 패치에서 **동일한 검증 분기**를 새로 넣어야 한다.

추가 권장 정책:

- `commentScheduler`가 실행 중이고 현재 모드가 `COMMENT_REFLUX`일 때
- `refluxSearchGalleryId` 변경은 **정지 후 수정**으로 막는 편이 안전하다

이유:

- cache key에 `searchGalleryId`가 들어가고
- pending search 결과도 그 갤 기준으로 돌아오기 때문에
- 실행 중에 값을 바꾸면 같은 run 안에서 old/new search context가 섞일 수 있다

즉 1차 구현은:

- **실행 중 `refluxSearchGalleryId` 변경 차단**

이 가장 안전하다.

참고용 현재 수동 시작 경로:

- 팝업 댓글 토글: [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1304)
- background comment start: [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L494)
- 댓글 상태 UI 반영: [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L2412)
- feature config input 집합: [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3283)

추가로 이번 재검토에서 찾은 이슈:

- popup/background의 기존 helper 이름이 `normalizePostRefluxSearchGalleryId*`처럼 post 전용이다
- 위치:
  - [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L3010)
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1645)

댓글에도 같은 개념이 필요하므로, 이번 패치에서는 이름을 shared 의미로 바꾸는 편이 맞다.

권장:

- `normalizeRefluxSearchGalleryId`
- `isValidRefluxSearchGalleryId`

추가로 저장/복원 쪽은 과하게 건드릴 필요가 없다.

- `commentScheduler.saveState()`는 `config` 전체를 그대로 저장한다
  - 위치: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L493)
- `commentScheduler.loadState()`도 `config` 전체를 merge 복원한다
  - 위치: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L515)

즉 `refluxSearchGalleryId`를 기본 config에만 추가하면,

- storage persist
- storage restore
- status.config 노출

은 기존 공용 경로가 이미 처리한다.

별도 custom serialize 코드를 새로 만들 필요는 없다.

---

## 10. 자동 댓글 감시와의 연결

이번 기능을 `commentScheduler` 내부에 넣으면 자동 쪽은 큰 수정이 거의 필요 없다.

이유:

- comment monitor는 child로 `commentScheduler.start({ commentAttackMode })`를 호출한다
- `COMMENT_REFLUX` 실제 삭제 대상 결정이 scheduler 안에서 바뀌면
- monitor child도 그대로 그 로직을 탄다

즉:

- **수동 댓글 역류기 모드**
- **자동 댓글 감시가 선택한 COMMENT_REFLUX 모드**

둘 다 같은 코드 경로를 쓴다.

추가 검토 포인트 하나:

- 현재 monitor의 `buildManagedAttackModeDecision()`은 dataset 매치 비율로만 `COMMENT_REFLUX`를 선택한다
- 위치: [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L467)

하지만 이건 지금 당장 blocker는 아니다.

이유:

- 자동 monitor가 `COMMENT_REFLUX`를 못 골라도
- 기본 모드(`DEFAULT`)는 원래 전체 유동 댓글 삭제라서 방어 실패로 바로 이어지지는 않는다

즉 이번 단계에서는:

- scheduler runtime 방어 강화가 우선
- monitor mode decision 고도화는 후속 단계로 미뤄도 된다

---

## 11. 로그/상태 권장 사항

사용자가 흐름을 바로 이해할 수 있게 최소한 아래 로그는 필요하다.

예시:

- `ℹ️ #1001: 유동닉 12개 중 dataset 3 / search positive 2 / search negative 6 / error 1 -> 삭제 대상 5개`
- `🔎 댓글 검색 중복 확인: 특이점 미니갤러리 이주했으면 ㅈ망했음 -> thesingularity #998877`
- `🔎 댓글 검색 미확인: 오늘 5.5라고 ??`
- `⚠️ 댓글 검색 확인 실패: 파딱님아 질문점 - search 응답 실패 (400)`

권장:

- broker logger는 scheduler.log를 주입받아 그대로 사용
- broker는 검색 이벤트만 로그
- scheduler는 글 단위 summary 로그

---

## 12. 엣지케이스

이건 구현 전에 문서로 못 박아야 한다.

1. 댓글이 HTML/entity를 포함해도 검색 비교는 plain text 기준이어야 한다.
2. filler 문자(U+3164, U+2800, ZWSP 등)는 검색 query와 compare key에서 제거/복원 규칙을 공유해야 한다.
3. self-match 한 개만 있으면 negative다.
4. self-match를 건너뛴 뒤 다른 과거 글이 하나라도 있으면 positive다.
5. search error는 삭제 대상에 넣지 않는다.
6. stop/mode change 시 pending promise는 반드시 cancelled로 끝나야 한다.
7. 같은 글 안에서 같은 문구가 여러 댓글로 반복되면 immediate/deferred bucket 각각에서 commentNo만 중복 제거하면 된다.
8. 같은 문구가 여러 글에서 동시에 나오면 fetch는 1회만 하고 caller별 currentPostNo로 다시 판정해야 한다.
9. negative cache TTL은 짧게 유지해야 한다.
10. positive cache는 rows 기반이어야 caller별 판정 재계산이 가능하다.
11. obvious dataset/cache positive는 true miss search 완료까지 지연시키지 말아야 한다.
12. 한 글당 삭제 호출은 1회를 고집하지 말고, 즉시 batch + 검색확정 batch의 최대 2회를 허용하는 편이 안전하다.

---

## 13. 실제 패치 범위

이번 문서 기준 실제 수정 파일 권장 목록:

- 신규: `features/reflux-normalization.js`
- 신규: `features/comment/comment-reflux-search-duplicate-broker.js`
- 수정: `features/comment/parser.js`
- 수정: `features/comment/scheduler.js`
- 수정: `popup/popup.html`
- 수정: `popup/popup.js`
- 수정: `background/background.js`

선택 수정:

- `features/comment/comment-reflux-dataset.js`
  - parser wrapper 이름 변경 영향이 있으면 import/호출부만 맞춘다
- `features/post/attack-mode.js`
  - 기존 정규화 함수들을 shared module import로 교체
- `features/post/reflux-search-duplicate-broker.js`
  - search gallery id helper를 shared 의미 이름으로 정리하고 싶다면 같이 맞춘다

즉 `comment-reflux-dataset.js`는 이번 재검토 기준으로 필수 수정 파일은 아니다.

---

## 14. 구현 순서

권장 순서:

1. shared reflux normalization 모듈 추출
2. comment parser wrapper 추가
3. comment search duplicate broker 추가
4. comment scheduler의 `COMMENT_REFLUX` 분기를 `즉시 batch + 검색확정 batch` 2단계로 변경
5. comment config에 `refluxSearchGalleryId` 추가
6. popup/background 저장/복원 연결 및 helper 이름 shared화
7. broker lifecycle(start/stop/resume/runtime mode transition) 연결
8. 로그/상태 보강
9. 정적 검증 및 mock 시나리오 점검

이 순서가 좋은 이유:

- 정규화 기준부터 통일해야
- broker와 scheduler를 따로 검증할 수 있다

---

## 15. 최종 교차검증 결론

현재 실제 코드와 다시 대조한 결론은 이렇다.

### 하드 blocker

없다.

### 반드시 지켜야 하는 구조

1. broker는 직접 삭제하지 말 것
2. `COMMENT_REFLUX` async 분기는 scheduler 내부에서 처리할 것
3. 삭제는 post 단위 batch 유지하되, one-shot 고집 대신 `즉시 batch + 검색확정 batch` 최대 2회로 설계할 것
4. search fetch cache와 caller final decision을 분리할 것
5. stop/reset 시 pending promise 정리를 넣을 것
6. broker lifecycle을 start/stop/resume/runtime mode transition에 모두 연결할 것
7. `COMMENT_REFLUX` 실행 중 `refluxSearchGalleryId` 변경은 1차에서 차단할 것

### 남은 비-blocker 리스크

1. attack 문구가 거의 전부 unique면 search queue 길이가 길어져 cycle 시간이 늘 수 있다.
2. 이 경우에도 correctness는 깨지지 않지만, deferred batch까지 기다리는 시간이 길어질 수 있다.
3. 이번 문서 기준 해법은 `즉시 batch`로 obvious hit 지연을 먼저 막는 것이고, queue backlog 자체 최적화는 후속 튜닝 범위로 본다.

### 그대로 진행해도 되는 이유

- 기존 삭제/검증/통계 경로를 재사용할 수 있고
- 자동 댓글 감시 child도 같은 scheduler를 쓰며
- search duplicate는 miss 경로에만 붙기 때문에
- 기존 일반 댓글 방어와 한글제외 모드를 깨지 않고 확장 가능하다

즉 이번 문서 기준 구현 방향은:

- **논리적으로 일관되고**
- **현재 코드와 연결도 자연스럽고**
- **바로 패치 들어가도 되는 수준**

이라고 판단한다.
