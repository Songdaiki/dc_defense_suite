# 역류기 dataset 수집 탭 구현 플랜

## 작성 기준

이 문서는 **2026-04-05 현재 실제 코드 기준**으로 작성했다.

교차 확인한 실제 파일:

- [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js)
- [features/post/semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js)
- [features/post/parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js)
- [features/post/api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)
- [popup/popup.html](/home/eorb915/projects/dc_defense_suite/popup/popup.html)
- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js)
- 반도체 역류 모드 문서: [monitor_semiconductor_reflux_attack_mode_plan.md](/home/eorb915/projects/dc_defense_suite/docs/monitor_semiconductor_reflux_attack_mode_plan.md)
- 현재 최종 통합 dataset 파일: [reflux-title-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.json)

이 문서의 목표는:

- 확장 UI 안에 **`역류기글 수집` 탭**을 추가하고
- 사용자가 입력한 `galleryId`의 목록 페이지를 **순차 수집**해서
- 현재 역류 방어가 바로 읽을 수 있는 dataset 규격 JSON으로 **다운로드**하고
- 사용자는 그 JSON을 repo dataset 파일에 붙여넣은 뒤 **커밋/배포**만 하게 만드는 것이다.

즉 한 줄로:

- **수집은 UI에서 편하게**
- **배포 기준은 repo dataset 파일 하나로 유지**

---

## 1. 왜 이 방식이 맞는가

지금 역류기 방어는 이미 이렇게 만들어져 있다.

1. 배포본 dataset 파일이 source-of-truth
2. 각 관리자 PC의 `chrome.storage.local`은 캐시
3. 실제 매칭은 런타임 `Set.has()`  
   [semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js)

쉽게 예시로:

- dataset 파일에 제목 3만개를 넣고 배포
- 관리자 A/B/C가 확장 업데이트
- 각자 local cache는 같은 dataset version으로 자동 갱신

반대로 dataset을 확장 local storage에만 채우면:

- 관리자 A는 오늘 수집
- 관리자 B는 예전 dataset
- 관리자 C는 비어 있음

이렇게 운영 기준이 갈라질 수 있다.

그래서 수집 기능은 **local test/import 도구**가 아니라,

- UI에서 수집
- JSON 다운로드
- repo dataset 파일 반영
- 커밋/배포

흐름으로 가는 게 맞다.

---

## 2. 수집 대상과 URL 스펙

이 수집기는 **고정 갤 전용이 아니라 `galleryId` 입력형**으로 가는 것이 맞다.

예시:

- `tsmcsamsungskhynix`
- `thesingularity`

실제 목록 URL:

- 1페이지: `https://gall.dcinside.com/mgallery/board/lists?id=tsmcsamsungskhynix`
- 2페이지 이상: `https://gall.dcinside.com/mgallery/board/lists/?id=tsmcsamsungskhynix&page=2`

즉 구현은 입력한 `galleryId`와 page parameter만 바꿔서 순차 수집하면 된다.

권장 요청 URL 생성 규칙:

```js
const url = new URL('/mgallery/board/lists/', 'https://gall.dcinside.com');
url.searchParams.set('id', galleryId);
url.searchParams.set('page', String(page));
```

예시:

- `page=1` -> `...?id=tsmcsamsungskhynix&page=1`
- `page=250` -> `...?id=tsmcsamsungskhynix&page=250`
- `galleryId='thesingularity', page=20` -> `...?id=thesingularity&page=20`

실제 서버는 `page=1`을 붙여도 정상 응답하므로, 구현은 page를 항상 붙이는 방식이 단순하다.

### 입력 검증

`galleryId`는 자유입력이지만 최소 검증은 필요하다.

권장:

- trim 후 비어 있으면 거부
- `/^[a-z0-9_]+$/i` 정도로 제한

예시:

- `tsmcsamsungskhynix` -> 허용
- `thesingularity` -> 허용
- `semi-gall` -> 거부
- 공백만 -> 거부

---

## 3. 제목 추출은 이미 가능한가

가능하다.

현재 [features/post/parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js) 에는 이미 목록 HTML에서 제목을 꺼내는 로직이 있다.

핵심:

- row 수집: `collectBoardPosts(html)`  
  [features/post/parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L33)
- 제목 추출: `extractSubject(rowHtml)`  
  [features/post/parser.js](/home/eorb915/projects/dc_defense_suite/features/post/parser.js#L95)

이 함수는:

- `tr.ub-content[data-no]`
- `td.gall_tit`
- 공지/설문 같은 비정규 row 제외
- 아이콘/댓글수 제거

까지 이미 하고 있다.

쉽게 예시로:

- 목록에 `일반 / 삼성 파운드리 적자`
- parser 결과의 `subject`는 그냥 `삼성 파운드리 적자`

즉 현재 HTML 스펙상 title 파싱은 blocker가 없다.

### 권장

수집기는 **기존 `parseBoardPosts(html)` 재사용**으로 시작하는 것이 맞다.

이유:

- 이미 운영 중인 목록 parser다
- row 필터가 일관된다
- 제목 정리도 현재 코드 기준과 어긋나지 않는다

주의:

- 이 parser는 writer meta가 없는 비정규 row를 버린다
- 일반적인 마이너갤/미니갤 list row엔 writer meta가 있으므로 보통 문제 없다

즉 1차 구현은:

- `parseBoardPosts(html).map((post) => post.subject)`

로 충분하다.

---

## 4. 수집기는 어떤 구조가 맞는가

### 결론

**새 standalone collector scheduler**가 맞다.

이유:

- 여러 페이지를 순차로 돌면서
- 진행률, 중지, 오류, 다운로드 준비 상태를 들고 있어야 하고
- popup이 닫혀도 background에서 계속 돌아야 하기 때문이다.

즉 `manual bump`, `uid autoban`처럼 **background 중심 기능**으로 가야 한다.

중요:

- 이 기능은 **공통 갤러리 설정(shared gallery)** 과 묶이면 안 된다
- 사용자가 입력한 `galleryId`를 그대로 써야 한다

쉽게 예시로:

- 공통 갤러리 설정이 `thesingularity`
- 수집 탭 입력 `galleryId=tsmcsamsungskhynix`
- 이때 수집기는 **반도체갤을 그대로 긁어야** 맞다
- 공통 설정 저장 때문에 `thesingularity`로 덮이면 안 된다

즉 구현 시:

- `background.applySharedConfig()` 대상에 넣지 않는다
- `syncSharedConfigInputs()` 기준 갤러리 계산에도 넣지 않는다
- 공통 갤러리 변경으로 collector state를 같이 reset하지 않는다

이건 실제 코드 기준으로 꽤 중요하다.
현재 shared config 전파는 [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L849) 에서 기능별로 직접 넣고 있으므로,
collector를 새로 추가할 때 여기에 무심코 끼워 넣으면 **입력한 `galleryId`가 공통 갤러리 값으로 오염될 수 있다.**

권장 새 파일:

- `features/reflux-dataset-collector/api.js`
- `features/reflux-dataset-collector/parser.js`
- `features/reflux-dataset-collector/scheduler.js`

예시 역할:

- `api.js`
  - 입력한 `galleryId`의 list HTML fetch
- `parser.js`
  - `parseBoardPosts(html)` 재사용 또는 thin wrapper
- `scheduler.js`
  - 시작/중지/진행률/지터/다운로드 payload 관리

---

## 5. UI에서 필요한 입력값

탭 이름:

- `역류기글 수집`

권장 입력값:

1. `갤 ID`
2. `시작 페이지`
3. `끝 페이지`
4. `요청 간격(ms)`
5. `지터(ms)`

예시:

- 갤 ID: `tsmcsamsungskhynix`
- 시작 페이지: `1`
- 끝 페이지: `300`
- 요청 간격: `1200`
- 지터: `400`

의미:

- 각 페이지 fetch 후
- 기본 1200ms 쉬고
- 여기에 0~400ms 랜덤 지터를 더한다

즉 예시로 실제 대기는:

- 1218ms
- 1432ms
- 1310ms

같이 조금씩 달라진다.

### 왜 지터가 필요한가

네 말대로 이건 병렬로 한 번에 쏘는 게 아니라 **순차 + 텀 + 지터**가 맞다.

하지 말아야 할 예시:

- 300페이지를 `Promise.all`로 한 번에 요청

이건 너무 공격적이고 실패/차단 확률도 높다.

권장 예시:

1. page1 fetch
2. 1.2초 + 랜덤 0.4초 대기
3. page2 fetch
4. 반복

즉 **작업은 느려도 안정적으로** 가는 게 맞다.

---

## 6. 실제 수집 플로우

권장 플로우는 이거다.

1. 사용자가 `역류기글 수집` 탭에서 `galleryId`, 페이지 범위, 간격을 입력
2. `수집 시작` 클릭
3. scheduler가 입력한 `galleryId`로 `page=startPage`부터 `endPage`까지 순차 fetch
4. 각 페이지 HTML을 `parseBoardPosts()`로 파싱
5. `subject`만 뽑아서 누적
6. 각 제목에 `normalizeSemiconductorRefluxTitle()` 적용  
   [features/post/attack-mode.js](/home/eorb915/projects/dc_defense_suite/features/post/attack-mode.js#L68)
7. 정규화된 제목을 `Set`으로 dedupe
8. 끝나면 아래 형식의 JSON export payload 생성
9. 사용자가 `JSON 다운로드` 클릭
10. 내려받은 JSON을 repo의 [reflux-title-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.json) 에 반영 후 커밋/배포

쉽게 예시로:

- `galleryId=tsmcsamsungskhynix`
- 원본 제목 28,412개 수집
- 정규화 후 고유 제목 24,913개
- export JSON엔 `titles: [ ...24913개 ]`

---

## 7. export JSON 형식

지금 runtime loader가 기대하는 형식은 이미 정해져 있다.

참조:

- [reflux-title-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.json)
- [semiconductor-reflux-title-set.js](/home/eorb915/projects/dc_defense_suite/features/post/semiconductor-reflux-title-set.js#L99)

다운로드 형식은 아래 그대로 맞추는 것이 좋다.

```json
{
  "_comment": "JSON은 일반 주석을 지원하지 않아서 안내를 _comment 필드로 남긴다.",
  "_comment_update_rule": "titles를 수정했다면 version도 반드시 같이 올려야 한다. version이 그대로면 기존 관리자 local cache가 유지될 수 있다.",
  "_comment_example": "예: 제목을 추가/삭제했다면 version을 2026-04-05-v1 -> 2026-04-06-v2 같이 올린다.",
  "version": "2026-04-05-v1",
  "updatedAt": "2026-04-05T12:34:56.000Z",
  "sourceGalleryIds": ["tsmcsamsungskhynix"],
  "titles": [
    "삼성 파운드리 적자",
    "메모리 업황 바닥"
  ]
}
```

주의:

- `titles`에는 **이미 정규화된 제목**을 넣는다
- 즉 export는 원문 제목이 아니라 `normalizeSemiconductorRefluxTitle()` 결과를 담는 것이 맞다

예시:

- 원문: `삼성   파운드리   적자`
- export titles: `삼성 파운드리 적자`

### version 생성 규칙

이건 수동 입력보다 자동 생성이 낫다.

권장:

- `YYYY-MM-DD-HHmmss`

예시:

- `2026-04-05-231500`

이유:

- 나중에 네가 “dataset 다시 만들어”라고 시켜도
- export 시점 기준으로 자동 version을 붙이면 실수로 version을 안 올릴 일이 줄어든다

---

## 8. storage에 뭘 남길 것인가

수집 기능은 배포용 JSON을 만드는 게 목적이지만, **작은 상태와 큰 제목 데이터는 저장소를 나눠야 한다.**

### 결론

- **작은 상태**: `chrome.storage.local`
- **큰 제목 집합 / export 원본 데이터**: `IndexedDB`

이유:

- popup은 1초마다 `getAllStatus`를 호출한다  
  [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1631)
- scheduler 상태는 `chrome.storage.local`에 그대로 저장하는 패턴이다  
  예: [features/bump-post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/bump-post/scheduler.js#L194)

그런데 이 collector는 예시로:

- `397페이지`면 몇 만 제목
- `17512페이지`면 수십만 제목

까지 갈 수 있다.

이 큰 `titles` 배열이나 `exportPayload`를 매 페이지마다 `chrome.storage.local`에 통째로 저장하면:

- write amplification이 커지고
- 상태 저장이 느려지고
- payload가 커질수록 popup 상태 응답도 무거워질 수 있다

즉 한 줄로:

- **진행률/카운트/에러만 local storage**
- **제목 Set과 export 원본은 IndexedDB**

가 맞다.

권장 state:

```js
{
  isRunning: false,
  runId: '',
  galleryId: '',
  startPage: 1,
  endPage: 300,
  requestDelayMs: 1200,
  jitterMs: 400,
  currentPage: 0,
  fetchedPageCount: 0,
  rawTitleCount: 0,
  normalizedTitleCount: 0,
  startedAt: '',
  finishedAt: '',
  lastError: '',
  logs: [],
  downloadReady: false,
  exportVersion: '',
  interrupted: false
}
```

설명:

- `rawTitleCount`
  - 정규화 전 전체 수집 개수
- `normalizedTitleCount`
  - 정규화 후 unique 개수
- `runId`
  - 현재 수집 작업을 구분하는 키
- `downloadReady`
  - IndexedDB 안에 export 가능한 제목 집합이 준비됐는지
- `exportVersion`
  - 다운로드 시 쓸 버전 문자열
- `interrupted`
  - 브라우저 재시작/worker 재시작으로 작업이 중간에 끊겼는지

중요:

- `logs`는 무한히 쌓으면 안 된다
- 현재 다른 scheduler들도 보통
  - 메모리 로그는 100개 안쪽
  - 저장 상태는 최근 50개
  - popup 노출은 최근 20개
  정도로 자른다

예시:

- `17512페이지`를 밤새 수집
- 페이지마다 로그를 1개씩 남김
- 이걸 안 자르면 `logs` 배열만 수천~수만 줄이 될 수 있다

그래서 collector도 같은 패턴이 맞다.

- runtime `this.logs`는 `slice(0, 100)` 정도로 cap
- `saveState()`에는 최근 50개만
- `getStatus()`에는 최근 20개만

즉 한 줄로:

- **큰 제목 데이터는 IndexedDB**
- **작은 상태여도 logs는 cap**

즉 예시로:

- 원문 제목 100개 수집
- 정규화 후 unique 80개
- 사용자에겐 `원본 100 / 정규화 고유 80`으로 보여준다
- 실제 제목 80개 배열은 IndexedDB에 있고, popup 상태 응답에는 안 싣는다

### 왜 `runId`가 필요한가

예시:

- 어제 `galleryId=tsmcsamsungskhynix`로 1~300페이지 수집
- 오늘 `galleryId=thesingularity`로 1~500페이지 수집

이때 같은 IndexedDB key를 그대로 재사용하면

- 어제 반도체 제목
- 오늘 특갤 제목

이 섞일 수 있다.

그래서 시작할 때마다:

- 새 `runId` 생성
- 그 `runId` 기준으로 임시 제목 집합 저장
- 완료 후 export도 그 `runId`를 기준으로 조립

이 구조가 맞다.

### 왜 `exportPayload`를 status에 직접 싣지 말아야 하나

지금 popup은 전체 상태를 1초마다 다시 읽는다.

예시:

- 제목 50,000개가 들어 있는 `exportPayload`
- 이걸 `getAllStatus` 응답에 실으면
- 매 초마다 큰 객체를 popup으로 복사하게 된다

그래서 올바른 구조는:

- 상태 응답엔 `downloadReady`, `normalizedTitleCount`, `exportVersion` 정도만
- `JSON 다운로드`를 눌렀을 때만 background가 IndexedDB에서 읽어 **그때 한 번만** export JSON을 조립

이게 현재 popup/background 구조와도 가장 잘 맞다.

---

## 9. background / popup 연결 계획

### 9-1. background

새 feature key 권장:

- `refluxDatasetCollector`

필요한 background 연결:

- scheduler 등록
- `start`
- `stop`
- `getStatus`
- `resetStats`
- `downloadExportJson` 같은 on-demand export action
- `loadStateIfIdle`
- `resumeStandaloneScheduler`는 **불필요**

그리고 추가로 중요:

- `getAllStatuses()`에는 넣어야 popup이 상태를 그림
- 하지만 `getBusyFeatures()`에는 **1차에 넣지 않는 쪽이 낫다**
- `applySharedConfig()`에도 넣지 않는다

이유:

- collector는 공통 갤러리와 독립된 도구이고
- 수집 중이라고 해서 session fallback/shared gallery 저장을 굳이 막을 필요가 없다
- auth가 필요한 관리 작업도 아니기 때문이다

중요:

이 기능은 장기 자동화가 아니라 **수동 수집 작업**이므로,

- 브라우저 재시작 후 자동 resume까지는 1차에 안 넣는 것이 안전하다

단, 이 경우 `loadState()`는 꼭 이렇게 처리해야 한다.

예시:

- 어제 밤 수집 중에 브라우저 종료
- 저장 상태엔 `isRunning=true`
- 그런데 auto resume은 안 할 것

이 경우 `loadState()`에서:

- `isRunning=false`
- `interrupted=true`
- 로그에 `중단된 수집 작업이 있어 자동 복원을 건너뜁니다`

처럼 내려줘야 한다.

안 그러면:

- background가 상태만 `running`으로 복원하고
- 실제 loop는 안 도는 **유령 실행 상태**가 될 수 있다

이건 현재 `resumeStandaloneScheduler()`를 안 쓰는 기능에서 특히 중요하다.

예시:

- 수집 중 브라우저가 꺼지면
- 다음 실행 때 “중단됨”으로 보여주고
- 다시 시작하게 하는 편이 낫다

### 9-2. popup

새 탭:

- `역류기글 수집`

필요 UI:

- 갤 ID
- 시작 페이지
- 끝 페이지
- 요청 간격(ms)
- 지터(ms)
- `수집 시작`
- `수집 중지`
- `JSON 다운로드`
- 진행률
- 로그
- 통계 초기화

시작 중에는:

- 입력 잠금
- 다운로드는 완료 후에만 활성화

예시:

- 1~300 수집 중
- 현재 127/300
- 원본 제목 12,330
- 정규화 고유 10,912

---

## 10. API / parser 구현 계획

### 10-1. api

새 API는 `features/post/api.js` 패턴을 그대로 가져가면 된다.

권장:

- base URL 고정: `https://gall.dcinside.com`
- gallery id는 입력값 사용
- **`withDcRequestLease`는 쓰지 않는다**

즉 이 기능은:

- 공통 갤러리 설정은 따르지 않지만
- **사용자가 입력한 `galleryId`는 그대로 사용**

`withDcRequestLease`를 안 쓰는 이유는 단순하다.

예시:

- 분류/삭제/차단은 관리자 세션 보호가 중요
- 하지만 목록 수집은 공개 GET 요청이다
- 이 collector를 `17512페이지` 밤새 돌리는데 lease까지 잡아버리면
- 다른 관리 기능이 괜히 대기할 수 있다

즉 collector fetch는:

- 공개 list GET
- 순차 + delay + jitter
- lease 없음

이 더 맞다.

예시:

- `galleryId=tsmcsamsungskhynix`
- `galleryId=thesingularity`

### 10-2. parser

1차 구현은 새 parser를 따로 크게 만들 필요 없이,

- `parseBoardPosts(html)`
- `post.subject`

재사용이 맞다.

thin wrapper 예시:

```js
import { parseBoardPosts } from '../post/parser.js';

function parseSemiconductorListTitles(html) {
  return parseBoardPosts(html)
    .map((post) => post.subject)
    .filter(Boolean);
}
```

이유:

- 이미 운영 중인 HTML parser를 재사용
- 제목 추출 품질도 일관

---

## 11. 다운로드 방식

popup에서 권장 방식:

1. popup이 `downloadExportJson` 같은 on-demand action 호출
2. background/scheduler가 IndexedDB에서 현재 제목 집합을 읽어 export JSON 조립
3. popup은 받은 payload를 `JSON.stringify(payload, null, 2)`로 직렬화
4. `Blob`
5. `URL.createObjectURL`
6. `<a download=...>`
7. 클릭 트리거 후 revoke

권장 파일명:

- `semiconductor-reflux-title-set-2026-04-05-231500.json`

이 방식이 좋은 이유:

- manifest에 아직 `downloads` permission은 없다  
  [manifest.json](/home/eorb915/projects/dc_defense_suite/manifest.json)
- popup Blob download는 추가 권한 없이 바로 가능하다
- 큰 export 데이터도 **상시 상태 응답이 아니라 다운로드 시점에만** 다루게 된다

즉 예시:

- 수집 완료
- `JSON 다운로드`
- 파일 저장
- 그 파일 내용을 repo dataset 파일에 붙여넣기

---

## 12. 꼭 넣어야 할 안전장치

### 12-1. 병렬 요청 금지

이 기능은 `Promise.all` 금지.

반드시:

- 1페이지 fetch
- parse
- delay + jitter
- 다음 페이지

순차로 간다.

### 12-2. 진행 중 stop 지원

각 페이지 루프 직전에:

- `if (!this.isRunning) break`

검사 필요

예시:

- 1~500 수집 중
- 사용자가 120페이지에서 `중지`
- 그 시점까지만 저장하고 종료

### 12-3. 최소/최대 입력 보정

권장:

- `startPage >= 1`
- `endPage >= startPage`
- `requestDelayMs >= 500`
- `jitterMs >= 0`

예시:

- 사용자가 `delay=0`을 넣어도
- 실제론 `500ms` 이상으로 보정

### 12-4. export 전에 version 자동 생성

사용자가 version을 직접 입력하게 하지 말고,

- export payload 생성 시 자동 생성

이게 안전하다.

### 12-5. 저장 중복 제거

누적 구조는:

- 원본 title 배열 누적이 아니라
- 중간부터 바로 `Set` 누적이 더 낫다
- 다만 실제 저장소는 **IndexedDB의 key-value/배치 구조**가 더 낫다

예시:

- page10에서 이미 본 제목
- page11에서 다시 나옴
- 즉시 dedupe

### 12-6. 로그 cap 필수

이건 실제 코드 기준으로 빠지기 쉬운 포인트다.

현재 주요 scheduler들은 모두 최근 로그 개수를 잘라서 저장/응답한다.

예시:

- [features/bump-post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/bump-post/scheduler.js#L291)
- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L444)
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L761)

collector도 같은 방식으로 가야 한다.

권장:

- 메모리 로그 cap: 100
- `saveState()` 로그 cap: 50
- `getStatus()` 로그 cap: 20

이유:

- 긴 수집에서 `logs`가 계속 불어나면
- 제목 데이터는 IndexedDB로 빼더라도
- 작은 상태 저장 자체가 다시 무거워질 수 있다

### 12-5-1. 새 수집 시작 시 이전 run 데이터 정리

예시:

- 어제 반도체갤 1~300 수집
- 오늘 특갤 1~500 수집

이때 시작 전에 이전 run의 임시 제목 집합을 안 지우면 안 된다.

권장:

- `start()` 직전 새 `runId` 생성
- 이전 임시 run 데이터 clear
- 상태도 `downloadReady=false`, `finishedAt=''`, `lastError=''`로 초기화

완성본 JSON을 내려받은 뒤에도, 다음 run 시작 시에는 **이전 임시 IDB 데이터는 새 run 기준으로 갈아끼우는 구조**가 안전하다.

### 12-6. 긴 수집은 `storage.local`에 큰 배열 저장 금지

예시:

- 50,000개 제목
- 100,000개 제목

이걸 매 페이지마다 `chrome.storage.local.set({ exportPayload })`로 저장하면 너무 무겁다.

권장:

- 메모리 `Set` + 주기적 IndexedDB flush
- local storage엔 카운트/진행률/에러만

### 12-7. restart 복원 정책은 “resume”이 아니라 “interrupted” 처리

예시:

- page 8000 수집 중 브라우저 종료
- 다음 실행 때 자동 재개는 안 함
- 대신 `8000페이지까지 수집 후 중단됨` 상태를 보여주고
- 사용자가 다시 시작할지 판단하게 한다

즉 이 기능은 1차에서 **resume 없는 수동 도구**로 설계하는 게 맞다.

---

## 13. 실제 구현 파일 권장안

### 새 파일

- `features/reflux-dataset-collector/api.js`
- `features/reflux-dataset-collector/idb.js`
- `features/reflux-dataset-collector/scheduler.js`

### 재사용 파일

- `features/post/parser.js`
- `features/post/attack-mode.js`

### 수정 파일

- `background/background.js`
- `popup/popup.html`
- `popup/popup.js`

선택:

- `popup/popup.css`  
  새 카드/로그 레이아웃이 필요하면

---

## 14. 구현 후 검증 체크리스트

최소 검증은 이 정도가 필요하다.

1. `1~3페이지` 수집 시 순차 요청만 나가는지
2. `delay + jitter`가 실제로 적용되는지
3. `중지` 클릭 시 다음 페이지 진입 전에 멈추는지
4. `parseBoardPosts()`가 입력한 갤 title도 정상 추출하는지
5. 원본 제목 수 / 정규화 고유 수가 맞는지
6. export JSON이 현재 dataset loader 규격과 맞는지
7. 다운로드 파일을 [reflux-title-set-unified.json](/home/eorb915/projects/dc_defense_suite/data/reflux-title-set-unified.json)에 붙여넣고 배포했을 때 loader가 정상 반영하는지
8. dataset `version`만 다르면 local cache가 자동 갱신되는지
9. dataset 비어 있을 때 수동 reflux mode는 계속 거부되는지
10. dataset 채운 뒤엔 manual/auto reflux mode가 바로 살아나는지
11. collector가 공통 갤러리 설정 변경에 의해 `galleryId`가 덮이지 않는지
12. collector가 `withDcRequestLease` 없이도 정상 수집되는지
13. 긴 수집 중 제목 집합이 `chrome.storage.local`이 아니라 IndexedDB에만 크게 쌓이는지
14. 브라우저 재시작 시 “자동 resume” 대신 “중단됨”으로 떨어지는지
15. 새 수집 시작 시 이전 run 제목 데이터가 섞이지 않는지

---

## 15. 구현 순서 추천

1. collector scheduler 골격
2. 입력형 `galleryId` list fetch API
3. `parseBoardPosts()` 재사용한 제목 추출
4. 순차 loop + delay + jitter + stop
5. export payload 생성
6. popup 탭/UI
7. JSON 다운로드
8. 정적 검증

---

## 16. 최종 요약

이 기능은 이렇게 이해하면 된다.

예시:

1. `역류기글 수집` 탭에서 `galleryId=tsmcsamsungskhynix`, `1~300페이지`, `1200ms`, `400ms jitter` 입력
2. 수집 시작
3. 확장이 해당 갤 목록을 **한 페이지씩 천천히** 긁음
4. 제목만 추출
5. 현재 역류 방어가 쓰는 정규화 규칙으로 dedupe
6. dataset 규격 JSON 다운로드
7. 그 파일을 repo dataset 파일에 붙여넣고 커밋/배포

즉 한 줄로:

- **확장 UI는 수집기 역할만 하고**
- **실제 운영 dataset 원본은 계속 repo 파일로 유지하는 구조**다.

그리고 구현상 중요한 한 줄은 이거다.

- **입력한 `galleryId`는 shared config와 분리**
- **긴 제목 집합은 IndexedDB**
- **download는 on-demand JSON 생성**

이게 지금 구조에서 가장 안전하고 운영하기 편한 방식이다.
