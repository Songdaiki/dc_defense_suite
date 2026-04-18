# VPNGate DEFAULT Prefix Filter 통합 설계

> 주의:
> 이 문서의 기본 구조/연결 설명은 아직 유효하지만,
> overlay 누적 정책은 후속 문서인
> [vpngate_global_delta_overlay_session_plan.md](/home/eorb915/projects/dc_defense_suite/docs/0419/vpngate_global_delta_overlay_session_plan.md)를 우선 기준으로 본다.
> 즉 `KR overlay 누적`이 아니라 `global overlay 세션 누적`이 최신 스펙이다.

## 1. 목표

이번 패치의 목적은 `DEFAULT` 방어에서 무고한 유동 피해를 조금이라도 줄이기 위해,  
`현재 VPNGate 공개 feed에 잡히는 prefix(A.B)`를 1차 필터로 거르는 옵션을 추가하는 것이다.

중요한 점은 이 로직이 **기존 DEFAULT를 대체하는 메인 방어축이 아니라**,  
`원할 때만 켜는 보조 narrowing filter`라는 점이다.

예시:

- 체크박스 `OFF`
  - 지금과 완전히 동일하게 동작
  - DEFAULT면 기존처럼 유동 전체를 후보로 본다
- 체크박스 `ON`
  - DEFAULT일 때만 먼저 VPNGate prefix와 맞는 유동만 남긴다
  - 그 뒤의 삭제/분류 로직은 기존 그대로 탄다

즉 이 기능은:

- `VPNGate 기반 공격일 때는 무고한 유동 희생을 줄이는 데 도움`
- `공격자가 다른 VPN/직접망으로 바꾸면 OFF로 돌리거나 기존 DEFAULT 그대로 사용`

이라는 성격으로 두는 것이 맞다.

---

## 2. 이번 문서에서 확정하는 결정

### 2-1. 설정은 반드시 옵션형으로 둔다

강제 ON으로 넣지 않는다.

이유:

1. 지금 공격자가 VPNGate를 쓰더라도 나중에 다른 VPN이나 일반망으로 바꾸면, 강제 prefix 필터가 오히려 탐지 범위를 좁혀서 놓칠 수 있다.
2. 사용자가 상황에 따라 `정밀 모드(ON)` / `전체 모드(OFF)`를 직접 고를 수 있어야 한다.

### 2-2. 전역 1개 토글보다 post/comment 개별 토글이 더 안전하다

실제 코드 구조상 설정은 feature별로 따로 들고 있다.

- 게시글 분류: `features/post/scheduler.js`
- 댓글 방어: `features/comment/scheduler.js`

둘 다 `config`를 자기 스케줄러가 직접 저장/복원한다.

그래서 1차 패치는 아래처럼 가는 게 가장 저위험이다.

- 게시글 분류 설정:
  - `useVpnGatePrefixFilter`
- 댓글 방어 설정:
  - `useVpnGatePrefixFilter`

예시:

- 게시글만 ON, 댓글은 OFF
  - 게시글 DEFAULT만 VPNGate prefix로 좁힘
  - 댓글 DEFAULT는 기존 그대로
- 둘 다 ON
  - 게시글/댓글 DEFAULT 둘 다 prefix 기반 narrowing 적용

전역 공통 토글로 만들 수도는 있지만, 그 경우 popup/background/config 저장 경로를 한 번 더 비틀어야 해서 이번 목적 기준으로는 불필요하게 범위가 커진다.

---

## 3. 실제 코드 기준 현재 흐름 확인

이 문서는 아래 실제 파일과 라인을 다시 대조해서 작성했다.

- 게시글 분류: `features/post/scheduler.js`
- 게시글 자동화: `features/monitor/scheduler.js`
- 댓글 방어: `features/comment/scheduler.js`
- 댓글 자동화: `features/comment-monitor/scheduler.js`
- service worker 복원: `background/background.js`
- popup 설정 저장: `popup/popup.js`, `popup/popup.html`
- 공격 mode 정의: `features/post/attack-mode.js`, `features/comment/attack-mode.js`
- prefix 정규화 참고: `features/ip/parser.js`
- VPNGate 측정 스크립트: `scripts/measure-vpngate-feed-changes.mjs`
- 기존 VPNGate 문서: `docs/0418/*`

### 3-1. 게시글 분류 현재 실제 흐름

핵심 구간:

- `features/post/scheduler.js:71-81`
  - 게시글 분류 config를 스케줄러 내부에서 직접 보관
- `features/post/scheduler.js:432-464`
  - 한 페이지 HTML 로드
  - `parseFluidPosts()`로 유동 게시글 추출
  - cutoff 적용 여부 결정
  - `basePosts` 생성
  - 역류기 모드면 `filterRefluxCandidatePosts()`
  - 아니면 `isEligibleForAttackMode()`로 필터
- `features/post/scheduler.js:493-499`
  - 최종 후보를 `classifyPostsOnce()`로 보냄

현재 DEFAULT에서는 사실상:

1. 유동 글 파싱
2. cutoff 이후 글만 남김
3. 그대로 후보로 분류

예시:

- 1페이지 유동 글 20개
- cutoff 이후 12개
- DEFAULT면 12개가 그대로 `classifyPostsOnce()`로 들어감

따라서 VPNGate prefix 필터를 붙일 위치는 **`basePosts` 다음, 기존 DEFAULT 후보 결정 전에** 두는 것이 맞다.

### 3-2. 게시글 자동화 현재 실제 흐름

핵심 구간:

- `features/monitor/scheduler.js:334-388`
  - 공격 감지 후 attack mode 결정
- `features/monitor/scheduler.js:498-554`
  - 자동화의 attack mode 판정은 dataset + search duplicate까지 포함
- `features/monitor/scheduler.js:599-624`
  - `maybeWidenAttackMode()`가 실행 중 attack mode를 넓힐 수 있음
- `features/monitor/scheduler.js:641-675`
  - 자동화 child post scheduler를 `source: 'monitor'`로 시작/복원

중요:

- 자동화가 popup 토글을 직접 만지는 구조가 아니다.
- 자동화는 결국 **같은 post scheduler를 child로 돌린다**.
- 그리고 공격 시작 시점에 정한 mode로 끝까지 고정되는 구조도 아니다.

예시:

- 처음 공격 감지 시 `SEMICONDUCTOR_REFLUX`
- 몇 사이클 뒤 widened mode가 `DEFAULT`
- 이때 child scheduler를 껐다 켜지 않아도 VPNGate filter가 새로 붙어야 한다

즉 게시글 자동화에 VPNGate prefix filter를 붙이려면 popup 쪽이 아니라 **post scheduler 공용 경로**에 붙여야 하고,  
`시작 시점만 등록`이 아니라 **실행 중 mode 변화도 같이 봐야 한다.**

### 3-3. 댓글 방어 현재 실제 흐름

핵심 구간:

- `features/comment/scheduler.js:69-84`
  - 댓글 방어 config를 자체 보관
- `features/comment/scheduler.js:242-243`
  - `filterFluidComments()`로 유동 댓글만 추림
- `features/comment/scheduler.js:249-308`
  - 역류기 댓글 모드면 dataset/cache/search 4단계 플로우
- `features/comment/scheduler.js:311-314`
  - 일반 모드면 `filterDeletionTargetComments()`
- `features/comment/scheduler.js:325-335`
  - 배치 삭제 실행
- `features/comment/scheduler.js:576-657`
  - 삭제 응답 후 `verifyDeletedComments()`로 다시 조회
  - 내부에서 `extractCommentNos(filterFluidComments(comments))` 기준으로 남은 번호를 확인

현재 DEFAULT에서는 사실상:

1. 댓글 API 조회
2. 유동 댓글만 추림
3. DEFAULT면 전부 삭제 대상 후보

예시:

- 한 게시물에 유동 댓글 15개
- 현재 DEFAULT면 15개 전부 삭제 후보

따라서 댓글 쪽 VPNGate prefix 필터 위치는 **`filterFluidComments()` 직후, `filterDeletionTargetComments()` 전에** 넣는 게 맞다.

중요:

- 이 필터는 후보 선정용이다.
- 삭제 후 “아직 남아 있나”를 재확인하는 검증 경로까지 넣으면 안 된다.

예시:

- 댓글 번호 3개를 삭제 대상으로 이미 골랐음
- 그 뒤 prefix set이 바뀜
- 검증 단계에도 prefix filter를 걸면 “안 보인다 = 삭제됐다”로 오판할 수 있음

그래서 댓글 쪽은 **후보 선정 경로에만 적용**해야 한다.

### 3-4. 댓글 자동화 현재 실제 흐름

핵심 구간:

- `features/comment-monitor/scheduler.js:423-480`
  - child comment scheduler를 `source: 'monitor'`로 시작/복원
  - 이미 실행 중인 child가 있으면 `setRuntimeAttackMode(attackMode)`로 mode만 갱신
- `features/comment-monitor/scheduler.js:483-560`
  - 자동 공격 mode는 `DEFAULT / COMMENT_REFLUX / EXCLUDE_PURE_HANGUL`

중요:

- 댓글 자동화도 popup과 별개다.
- 결국 같은 comment scheduler를 child로 사용한다.
- 그리고 child를 재시작하지 않고 mode만 바꾸는 경로가 있다.

예시:

- 처음엔 `COMMENT_REFLUX`
- 다음 판단에서 `DEFAULT`
- child를 새로 만들지 않아도, 그 시점부터 VPNGate filter가 활성화되어야 한다

즉 댓글 자동화도 **comment scheduler 공용 DEFAULT 경로**에 붙여야 하고,  
`start/stop만 보면 된다`는 식으로 구현하면 누락이 생긴다.

### 3-5. service worker 복원 현재 실제 흐름

핵심 구간:

- `background/background.js:211-314`
  - 모든 scheduler 상태 로드
  - comment monitor가 child를 소유 중이면 child comment scheduler를 `monitor` source로 복원
  - monitor가 child를 소유 중이면 child post/ip scheduler를 다시 붙임

의미:

- VPNGate prefix 상태를 메모리에만 두면 service worker가 죽었다 살아났을 때 날아간다.
- 따라서 prefix runtime 상태는 별도 storage key로 저장해야 한다.
- 그리고 복원 순서상 “monitor가 먼저 VPNGate runtime을 준비해 줄 것”이라고 가정하면 안 된다.

즉 안전한 방식은:

1. scheduler 상태 복원
2. monitor/comment-monitor가 child runtime mode 재주입
3. 공용 scheduler 루프에서 lazy하게 VPNGate runtime 준비 보장

이다.

여기서 popup 쪽도 같이 보면 더 명확하다.

- popup UI sync는 결국 scheduler status의 `config`를 그대로 읽는다
- 즉 이 boolean은 storage에만 저장되는 값이 아니라
- **각 scheduler `getStatus().config`까지 자연스럽게 흘러야 한다**

### 3-6. popup 저장 구조 현재 실제 흐름

핵심 구간:

- 댓글 설정 저장:
  - `popup/popup.html:567-603`
  - `popup/popup.js:1662-1697`
- 게시글 설정 저장:
  - `popup/popup.html:1122-1147`
  - `popup/popup.js:1808-1838`
- 저장된 config 반영:
  - `popup/popup.js:2941-2961` 댓글
  - `popup/popup.js:2978-3000` 게시글
- feature DOM 연결:
  - `popup/popup.js:299-319` 댓글 `FEATURE_DOM.comment`
  - `popup/popup.js:320-338` 게시글 `FEATURE_DOM.post`
- dirty / 자동 sync 입력 집합:
  - `popup/popup.js:4209-4219` 댓글 `getFeatureConfigInputs('comment')`
  - `popup/popup.js:4271-4278` 게시글 `getFeatureConfigInputs('post')`
- background updateConfig merge:
  - `background/background.js:619-823`
  - 최종적으로 `scheduler.config = { ...scheduler.config, ...message.config }`

의미:

- 새 boolean config 필드는 별도 특수 처리 없이도 merge 저장이 가능하다.
- 그런데 **HTML만 추가하면 끝이 아니다.**

반드시 같이 들어가야 하는 것:

1. HTML checkbox 추가
2. `FEATURE_DOM`에 ref 추가
3. save payload 추가
4. `getFeatureConfigInputs()`에 추가
5. UI 복원 / sync 반영

예시:

- checkbox를 HTML에만 추가
- 저장은 되는데 status 갱신 후 체크가 되돌아가 보임
- 원인은 `getFeatureConfigInputs()` 등록 누락

그래서 popup 쪽은 이 5개를 한 세트로 문서화해야 한다.

추가로 현재 `scheduler.config = { ...scheduler.config, ...message.config }` 구조이기 때문에  
**설정 저장 후 재시작 강제는 불필요**하다.

예시:

- 게시글 분류 실행 중 checkbox ON 저장
- 다음 페이지 처리 / 다음 loop에서 새 config가 바로 읽힘

즉 이 옵션은 “저장 후 다음 사이클 반영” 기준으로 구현하면 된다.

보충:

- popup은 별도 `...Effective` status 필드를 기다리는 구조가 아니다
- 실제로는 `getStatus().config.useVpnGatePrefixFilter` 값이 그대로 `syncFeatureConfigInputs()`로 들어간다
- 그래서 save payload만 넣고 scheduler `config` 저장/복원이 안 맞으면 UI도 바로 틀어진다

### 3-7. prefix 정규화는 기존 표현과 맞춘다

- `features/ip/parser.js:181-188`
  - `normalizeWriterToken()`이 IP성 토큰을 `A.B` prefix로 자른다.

예시:

- `175.201.151.172` -> `175.201`

이 형식은 현재 운영 화면에서 보이는 유동 IP 표기와도 맞는다.  
VPNGate filter도 같은 `A.B` 기준으로 맞추는 것이 가장 자연스럽다.

다만 실제 구현에서는 `features/ip/parser.js`를 직접 import해서 재사용하기보다는  
**prefix 전용 소형 helper를 따로 두는 편이 더 안전하다.**

권장 파일:

- `features/vpngate-prefix/prefix-normalization.js`

이유:

- `features/ip/parser.js`는 writer HTML 파싱 문맥이 같이 섞여 있다
- post/comment/VPNGate runtime이 공통으로 쓰는 건 결국 `A.B` 추출 규칙 하나뿐이다
- 필요한 부분만 분리해 두는 쪽이 의존성이 더 깔끔하다

---

## 4. 범위

### 4-1. 이번 1차 패치에 포함

- 게시글 분류 `DEFAULT`
  - 수동 시작
  - 게시글 자동화 child 시작
- 댓글 방어 `DEFAULT`
  - 수동 시작
  - 댓글 자동화 child 시작
- popup 설정에서 ON/OFF 가능
- VPNGate DAT feed 10분 refresh
- KR overlay 누적
- service worker 복원 대응

### 4-2. 이번 1차 패치에서 제외

- 게시글 `CJK_NARROW`
- 게시글 `SEMICONDUCTOR_REFLUX`
- 게시글 `PAGE1_NO_CUTOFF`
- 댓글 `COMMENT_REFLUX`
- 댓글 `EXCLUDE_PURE_HANGUL`

이유는 단순하다.

이 기능의 목적은 `DEFAULT 전체 모드에서 collateral을 줄이는 것`이지,  
이미 좁혀진 공격 모드 위에 또 다른 조건을 섞는 것이 아니다.

추가 확인:

- 게시글 자동 공격 판정은 실제로 `DEFAULT / CJK_NARROW / SEMICONDUCTOR_REFLUX`만 고른다
  - `features/post/attack-mode.js:93-159`
- `PAGE1_NO_CUTOFF`는 자동 판정 시작점이 아니라 수동 보조 mode다
- 댓글 자동 공격 판정은 `DEFAULT / COMMENT_REFLUX / EXCLUDE_PURE_HANGUL`만 고른다

즉 이번 기능의 적용 범위를 `DEFAULT`로 한정해도, 자동화의 실제 mode 분기 구조와 충돌하지 않는다.

---

## 5. 최종 동작 정책

### 5-1. 체크박스 이름 / 의미

권장 문구:

- 게시글:
  - `VPNGate prefix 필터 사용`
- 댓글:
  - `VPNGate prefix 필터 사용`

설명 문구:

- `ON 시 DEFAULT 모드에서 현재 VPNGate 공개 prefix와 맞는 유동만 1차 후보로 처리합니다. OFF 시 기존 DEFAULT 전체 처리로 동작합니다.`

### 5-2. 기본값

- 둘 다 `false`

즉 설치/업데이트 후에도 기존 동작이 깨지지 않는다.

### 5-3. 실패 정책

이번 기능은 **보조 narrowing filter**다.  
따라서 feed fetch/decode에 실패했다고 전체 방어가 멈추면 안 된다.

정책:

- 체크박스 ON인데 refresh 실패
  - 이미 성공해 둔 `effectivePrefixes` 캐시가 있으면 그 값을 계속 사용
  - 경고 로그 남김
- refresh 실패 + 쓸 캐시도 없음
  - 그 사이클은 기존 DEFAULT 로직으로 fallback

예시:

- 게시글 DEFAULT + VPNGate ON
- 10분 갱신 시도 실패
- 직전 성공 캐시가 있으면:
  - `⚠️ VPNGate prefix refresh 실패 - 직전 캐시로 계속 진행`
- 직전 캐시마저 없으면:
  - `⚠️ VPNGate prefix refresh 실패 - 기존 DEFAULT로 계속 진행`

이렇게 해야 “보조 필터 실패 때문에 메인 방어가 죽는” 문제가 없다.

---

## 6. VPNGate runtime 상태 설계

### 6-1. 왜 별도 runtime 모듈이 필요한가

이 로직은 단순 boolean이 아니다.

필요한 상태가 있다.

1. 최신 200-host snapshot prefix
2. KR overlay 누적 prefix
3. 마지막 refresh 시각
4. 현재 누가 이 runtime을 쓰는지
5. 마지막으로 실제 비교에 쓰는 `effectivePrefixes`

그래서 별도 모듈로 분리하는 것이 맞다.

권장 파일:

- `features/vpngate-prefix/runtime.js`
- `features/vpngate-prefix/prefix-normalization.js`

권장 export:

- `ensureVpnGatePrefixRuntimeReady(consumerId, options)`
- `releaseVpnGatePrefixRuntimeConsumer(consumerId)`
- `filterPostsByVpnGatePrefixes(posts, effectivePrefixSet)`
- `filterCommentsByVpnGatePrefixes(comments, effectivePrefixSet)`
- `normalizeVpnGatePrefix(value)`
- `getVpnGatePrefixRuntimeStatus()`

### 6-2. storage key

권장 key:

- `vpngatePrefixRuntimeState`

권장 저장 구조:

```json
{
  "liveSnapshotPrefixes": ["175.201", "219.100", "..."],
  "krOverlayPrefixes": ["175.201", "121.170", "..."],
  "effectivePrefixes": ["175.201", "219.100", "121.170", "..."],
  "lastRefreshAt": "2026-04-19T14:10:00.000Z",
  "lastSuccessfulDatSource": "http://xd.x1.client.api.vpngate2.jp/api/?session_id=...",
  "meta": {
    "hostCount": 200,
    "uniqueIpCount": 199,
    "krUniqueIpCount": 72
  },
  "activeConsumers": [
    "post_manual_default",
    "comment_monitor_default"
  ]
}
```

### 6-3. 왜 liveSnapshot + krOverlay 두 층이 필요한가

사용자가 이미 확인한 핵심 포인트:

- VPNGate 200개 목록은 10분 단위로 바뀐다
- 그런데 공격자는 직전 KR IP를 계속 사용할 수도 있다

그래서 매 refresh마다 `전면 교체만` 하면 놓칠 수 있다.

정책:

- `liveSnapshotPrefixes`
  - 매 refresh 성공 시 최신값으로 교체
- `krOverlayPrefixes`
  - 활성 중에는 `KR prefix만 누적`
- `effectivePrefixes`
  - `liveSnapshotPrefixes ∪ krOverlayPrefixes`

예시:

1. 14:00 snapshot KR = `{175.201, 121.170}`
2. 14:10 snapshot KR = `{121.170, 59.12}`
3. effective = `{175.201, 121.170, 59.12}`

이렇게 하면 14:00에 잡혔다가 14:10 snapshot에서 빠진 KR prefix도  
공격자가 계속 쓰는 동안은 필터 집합에 남는다.

### 6-4. refresh 실패 시 stale cache 유지

여기서 중요한 건 “실패하면 무조건 버린다”가 아니라는 점이다.

동작:

1. 새 refresh 성공
  - `liveSnapshot`, `krOverlay`, `effectivePrefixes` 갱신
2. 새 refresh 실패 + 이전 `effectivePrefixes` 존재
  - 이전 값 유지
3. 새 refresh 실패 + 이전 `effectivePrefixes` 없음
  - fallback to 기존 DEFAULT

즉 stale cache는 임시 방어막 역할을 한다.

### 6-5. 언제 누적을 비우는가

지속 백그라운드 서비스로 계속 유지할 필요는 없다.

이번 정책:

- `DEFAULT + VPNGate ON` 소비자가 1명이라도 있으면 유지
- 마지막 소비자가 빠지면 runtime state 초기화

즉:

- 게시글/댓글 수동 OFF
- 자동화 공격 종료
- 더 이상 이 기능을 쓰는 소비자가 없으면
  - live snapshot
  - kr overlay
  - effectivePrefixes
  - activeConsumers
  - 전부 비움

이 구조가 가장 단순하고, 오래된 prefix가 무한 누적되는 문제도 막는다.

---

## 7. feed 갱신 정책

### 7-1. refresh 주기

기존 0418 분석 및 측정 기준으로 10분 refresh를 표준으로 둔다.

참고:

- `scripts/measure-vpngate-feed-changes.mjs`
- `docs/0418/vpngate_official_200_feed_10min_refresh_guide.md`

운영 정책:

- stale 기준: `10분`
- `DEFAULT + VPNGate ON` 경로 진입 시
  - 마지막 refresh가 10분 이상 지났으면 새로 갱신
  - 아니면 캐시 사용

### 7-2. permanent background worker는 두지 않는다

지금 단계에서는 별도 alarm/주기 worker를 두지 않는다.

그 대신:

- 게시글 DEFAULT ON 루프
- 댓글 DEFAULT ON 루프

이 실제 소비 시점에서만 lazy refresh 한다.

예시:

- 아무 방어도 안 켜져 있음
  - VPNGate 요청 0건
- 게시글 DEFAULT + VPNGate ON 실행 중
  - 10분 지났을 때 다음 루프에서 refresh

이게 가장 깔끔하다.

### 7-3. KR 변화량은 overlay 누적으로 처리한다

`measure-vpngate-feed-changes.mjs`는 이미 `--country-short KR` 옵션을 지원한다.

- `scripts/measure-vpngate-feed-changes.mjs:50-55`
- `scripts/measure-vpngate-feed-changes.mjs:192-215`

이 측정 스크립트는 분석용이고, 런타임에서는 아래 정책만 쓰면 된다.

- 공식 200-host feed refresh
- 그 중 KR prefix 추출
- KR prefix는 overlay에 add-only
- 소비자 0명이 되면 overlay 초기화

---

## 8. 확장 권한 / DAT decode 주의점

### 8-1. manifest host permission 추가가 필요하다

현재 `manifest.json`에는 VPNGate host permission이 없다.

- `manifest.json:15-24`

현재 허용:

- dcinside
- localhost

없음:

- `xd.x1.client.api.vpngate2.jp`

따라서 1차 패치에는 아래 host permission 추가가 필요하다.

예시:

```json
"http://xd.x1.client.api.vpngate2.jp/*"
```

필요 시 mirror를 더 붙일 수 있지만, 1차는 공식 DAT 엔드포인트 기준으로 간다.

### 8-2. Node 스크립트를 extension runtime에서 직접 재사용할 수는 없다

현재 공식 DAT decode reference는 Node helper 기반이다.

- `scripts/decode-vpngate-official-dat.mjs`
- `scripts/measure-vpngate-feed-changes.mjs`

하지만 background service worker는 Node API를 못 쓴다.  
즉 런타임에는 브라우저용 decode 구현이 별도로 필요하다.

문서 기준 구현 원칙:

1. DAT raw fetch
2. header/payload 분리
3. RC4 decrypt
4. outer pack / inner pack decode
5. host list 추출
6. `IP`, `CountryShort`만 runtime에 저장

주의:

- WebCrypto는 RC4를 지원하지 않으므로, 소형 RC4 구현을 로컬 JS로 넣어야 한다.

---

## 9. 게시글 분류 통합 방식

### 9-1. 붙일 위치

정확한 삽입 지점:

- `features/post/scheduler.js:447-464`

현재:

1. `fluidPosts`
2. `basePosts`
3. reflux 전용이면 `filterRefluxCandidatePosts`
4. 아니면 `isEligibleForAttackMode`

변경 후:

1. `fluidPosts`
2. `basePosts`
3. `effectiveAttackMode === DEFAULT && config.useVpnGatePrefixFilter === true`
   - VPNGate prefix filter 적용
4. 그 결과를 기존 DEFAULT 흐름으로 계속 보냄
5. reflux / narrow 계열은 기존 그대로

### 9-2. 의사코드

```js
const effectiveAttackMode = this.getEffectiveAttackMode();
const shouldApplyVpnGatePrefixFilter =
  effectiveAttackMode === ATTACK_MODE.DEFAULT
  && this.config.useVpnGatePrefixFilter === true;

const vpnFilteredBasePosts = shouldApplyVpnGatePrefixFilter
  ? await filterBasePostsWithVpnGatePrefixes(basePosts, consumerId)
  : basePosts;

const refluxFilterResult = shouldUseSearchDuplicate
  ? await filterRefluxCandidatePosts(vpnFilteredBasePosts, ...)
  : null;

const candidatePosts = refluxFilterResult
  ? refluxFilterResult.candidatePosts
  : vpnFilteredBasePosts.filter((post) => isEligibleForAttackMode(post, effectiveAttackMode, ...));
```

### 9-3. consumer id

게시글 쪽 consumer id는 아래 2개면 충분하다.

- 수동 DEFAULT:
  - `post_manual_default`
- 자동화 child DEFAULT:
  - `post_monitor_default`

중요:

- 이 consumer는 `시작할 때 한 번 등록`으로 끝나면 안 된다.
- 실행 중 attack mode가 `DEFAULT`로 바뀌는 순간에도 등록되어야 한다.
- 반대로 `DEFAULT`에서 다른 mode로 빠지면 즉시 해제되어야 한다.

### 9-4. 예시

예시 1:

- basePosts = 14개
- VPNGate effective prefix set = `{175.201, 121.170, 59.12}`
- 작성자 prefix가 맞는 글 = 5개

결과:

- OFF면 14개가 기존처럼 후보
- ON이면 5개만 후보

즉 “분류/삭제 엔진은 그대로, 후보 풀만 좁힘”이다.

---

## 10. 댓글 방어 통합 방식

### 10-1. 붙일 위치

정확한 삽입 지점:

- `features/comment/scheduler.js:242-314`

현재:

1. `filterFluidComments(comments)`
2. 역류기 댓글 모드면 전용 4단계 플로우
3. 아니면 `filterDeletionTargetComments(fluidComments, ...)`

변경 후:

1. `fluidComments`
2. `currentAttackMode === DEFAULT && config.useVpnGatePrefixFilter === true`
   - prefix filter 적용
3. 그 결과를 기존 DEFAULT 삭제 플로우로 보냄
4. comment reflux / pure-hangul 모드는 기존 그대로

### 10-2. 의사코드

```js
const fluidComments = filterFluidComments(comments);

if (this.shouldFilterCommentRefluxForCurrentRun()) {
  // 기존 역류기 댓글 플로우 유지
}

const shouldApplyVpnGatePrefixFilter =
  this.currentAttackMode === COMMENT_ATTACK_MODE.DEFAULT
  && this.config.useVpnGatePrefixFilter === true;

const vpnFilteredComments = shouldApplyVpnGatePrefixFilter
  ? await filterFluidCommentsWithVpnGatePrefixes(fluidComments, consumerId)
  : fluidComments;

const deletionTargets = filterDeletionTargetComments(vpnFilteredComments, {
  attackMode: this.currentAttackMode,
  matchesCommentRefluxMemo: hasCommentRefluxMemo,
});
```

### 10-3. consumer id

- 수동 DEFAULT:
  - `comment_manual_default`
- 자동화 child DEFAULT:
  - `comment_monitor_default`

중요:

- comment child도 mode 변경이 재시작 없이 일어나므로
- `DEFAULT 진입 시 등록`, `DEFAULT 이탈 시 해제`를 런타임에서 계속 확인해야 한다.

### 10-4. 검증 경로 제외

댓글 쪽은 반드시 아래 원칙을 지킨다.

- 후보 선정:
  - VPNGate prefix filter 적용
- 삭제 후 재확인:
  - VPNGate prefix filter 미적용

예시:

- 유동 댓글 10개 중 prefix hit 3개를 삭제 대상으로 선택
- 삭제 후 해당 번호가 아직 남았는지 재확인
- 이 재확인 단계에서는 prefix filter를 다시 걸지 않는다

이렇게 해야 “필터 때문에 안 보이는 것”과 “실제로 삭제된 것”을 헷갈리지 않는다.

### 10-5. 예시

예시 1:

- 한 게시물 유동 댓글 11개
- VPNGate effective prefix set과 맞는 댓글 4개

결과:

- OFF면 11개가 기존 DEFAULT 삭제 대상
- ON이면 4개만 삭제 대상 후보

---

## 11. 자동화와의 연결 방식

### 11-1. 게시글 자동화

게시글 자동화는 이미 child post scheduler를 `source: 'monitor'`로 돌린다.

- `features/monitor/scheduler.js:641-675`

따라서 별도 monitor 전용 구현이 필요 없다.

조건:

- 현재 attack mode가 `DEFAULT`
- post config의 `useVpnGatePrefixFilter === true`

이면 child scheduler가 공용 경로에서 자동으로 VPNGate filter를 사용한다.

여기서 “공격 감지 후”만 보면 반쪽 설명이다.

실제 구현 기준으로는 아래도 포함해야 한다.

- child가 이미 도는 중
- narrow/reflux에서 `DEFAULT`로 widened 됨

이 경우도 같은 공용 경로에서 바로 VPNGate filter가 붙어야 한다.

구현상 함수 이름은 post/comment가 다르다.

- 게시글 child mode 전환:
  - `features/monitor/scheduler.js:663`
  - `postScheduler.setMonitorAttackMode(...)`
- 댓글 child mode 전환:
  - `features/comment-monitor/scheduler.js:459-466`
  - `commentScheduler.setRuntimeAttackMode(...)`

즉 개념은 둘 다 “실행 중 runtime mode 전환”이지만,  
실제 패치 때는 함수 이름을 구분해서 연결해야 한다.

### 11-2. 댓글 자동화

댓글 자동화도 동일하다.

- `features/comment-monitor/scheduler.js:423-480`

조건:

- 현재 attack mode가 `DEFAULT`
- comment config의 `useVpnGatePrefixFilter === true`

이면 child comment scheduler가 공용 경로에서 자동으로 VPNGate filter를 사용한다.

여기도 마찬가지다.

- child가 이미 실행 중인 상태에서
- `COMMENT_REFLUX -> DEFAULT` 또는 `EXCLUDE_PURE_HANGUL -> DEFAULT`

로 바뀌는 순간에도 공용 경로에서 즉시 반영되어야 한다.

### 11-3. 왜 monitor config에 따로 안 넣는가

이미 자동화는 child scheduler의 config를 재사용한다.

즉:

- 게시글 자동화에서 필요한 건 post child config
- 댓글 자동화에서 필요한 건 comment child config

여기에 다시 monitor 전용 toggle을 만들면 오히려 설정 축이 늘어나서 헷갈린다.

---

## 12. popup / config 저장 구현 계획

### 12-1. popup HTML

#### 댓글 방어 설정

현재 위치:

- `popup/popup.html:567-603`

여기에 setting item 추가:

```html
<div class="setting-item">
  <label for="commentUseVpnGatePrefixFilter">VPNGate prefix 필터 사용</label>
  <input type="checkbox" id="commentUseVpnGatePrefixFilter">
</div>
```

#### 게시글 분류 설정

현재 위치:

- `popup/popup.html:1122-1147`

여기에 setting item 추가:

```html
<div class="setting-item">
  <label for="postUseVpnGatePrefixFilter">VPNGate prefix 필터 사용</label>
  <input type="checkbox" id="postUseVpnGatePrefixFilter">
  <small>ON 시 DEFAULT 모드에서 VPNGate 공개 prefix와 맞는 유동만 먼저 처리합니다.</small>
</div>
```

### 12-2. popup JS 저장

#### 댓글

- `popup/popup.js:1669-1678`

`config`에 추가:

```js
useVpnGatePrefixFilter: dom.useVpnGatePrefixFilterInput.checked,
```

#### 게시글

- `popup/popup.js:1815-1821`

`config`에 추가:

```js
useVpnGatePrefixFilter: dom.useVpnGatePrefixFilterInput.checked,
```

### 12-3. popup JS 상태 반영

#### 댓글

- `popup/popup.js:2941-2950`

`syncFeatureConfigInputs()`에 checkbox 반영 추가

#### 게시글

- `popup/popup.js:2978-2984`

동일하게 checkbox 반영 추가

### 12-4. popup DOM / dirty tracking 추가

HTML과 save payload만 추가하면 부족하다.

#### 댓글

- `popup/popup.js:299-319`
  - `FEATURE_DOM.comment.useVpnGatePrefixFilterInput` 추가
- `popup/popup.js:4209-4219`
  - `getFeatureConfigInputs('comment')` 반환 목록에 추가

#### 게시글

- `popup/popup.js:320-338`
  - `FEATURE_DOM.post.useVpnGatePrefixFilterInput` 추가
- `popup/popup.js:4271-4278`
  - `getFeatureConfigInputs('post')` 반환 목록에 추가

예시:

- 저장 직후엔 체크되어 보이는데
- status polling 한 번 돌고 나면 체크가 되돌아감
- 이런 류의 문제는 대개 DOM ref / dirty input 등록 누락에서 난다

그래서 popup 구현은 이 부분까지 문서에 명시해 둔다.

### 12-5. background updateConfig

새 필드는 generic merge가 가능하다.

- `background/background.js:808-813`

따라서 boolean validation만 필요하면 추가하고, 아니면 그대로 merge 저장해도 된다.

권장:

- `Boolean(message.config.useVpnGatePrefixFilter)`로 정규화

중요:

- 지금 구조에서는 config merge가 live로 반영된다.
- 즉 이 옵션은 “저장 후 반드시 재시작” 구조로 만들 필요가 없다.

예시:

- 게시글 분류 실행 중 checkbox ON 저장
- 다음 page 처리 / 다음 loop에서 `this.config.useVpnGatePrefixFilter`가 바로 보인다

즉 구현은 restart 강제가 아니라, **다음 사이클 반영** 기준으로 두는 게 맞다.

---

## 13. 런타임 필터 구현 상세

### 13-1. 게시글 prefix 추출

게시글은 writer token이 HTML에서 들어온다.  
현재 IP parser와 같은 기준으로 `A.B` prefix를 뽑는다.

참고:

- `features/ip/parser.js:181-188`

권장:

- 공용 helper로 빼서 post/comment/VPNGate runtime이 같은 정규화 함수를 공유한다.
- 구현 파일은 `features/vpngate-prefix/prefix-normalization.js`처럼 prefix 전용으로 둔다.

예시:

- `(175.201.*.*)` -> `175.201`
- `175.201.151.172` -> `175.201`
- `반갤러` 같은 non-IP token -> `''`

### 13-2. 댓글 prefix 추출

댓글 API 쪽 `comment.ip`는 이미 `A.B` 또는 유사 형태로 들어온다.

예시:

- `175.201`
- `121.170`

따라서 댓글은 더 단순하다.

```js
const prefix = normalizeVpnGatePrefix(comment.ip);
```

### 13-3. effective set

최종 비교는 항상 `Set<string>`로 한다.

```js
effectivePrefixSet = new Set([
  ...liveSnapshotPrefixes,
  ...krOverlayPrefixes,
]);
```

비교 비용은 작다.

예시:

- prefix set 300개
- 댓글 20개
- 게시글 15개

모두 `Set.has(prefix)` 한 번씩이면 끝이다.

---

## 14. 소비자 등록 / 해제 규칙

### 14-1. 등록 시점

아래 조건을 만족하면 등록:

- feature가 실행 중
- 현재 공격 모드가 `DEFAULT`
- config의 `useVpnGatePrefixFilter`가 true

그리고 이 판정은 `start()` 한 번으로 끝내지 않는다.

- page 처리 시작 전
- comment process 시작 전
- mode 변경 직후
- config 변경 후 다음 루프

같이 **실행 중에도 반복 확인**하는 구조로 둔다.

### 14-2. 해제 시점

아래 상황에서 해제:

- scheduler stop
- runtime attack mode가 DEFAULT에서 다른 모드로 바뀜
- 설정에서 checkbox를 OFF로 바꿈
- monitor 공격 종료로 child scheduler가 내려감

즉 해제도 stop 전용이 아니라,  
**DEFAULT 조건이 깨지는 순간 바로 해제**가 원칙이다.

### 14-3. last consumer 정리

`activeConsumers.size === 0`이면:

- live snapshot clear
- kr overlay clear
- effectivePrefixes clear
- meta clear
- storage clear

예시:

- 게시글 ON, 댓글 OFF
- 게시글 분류 종료
- activeConsumers 0
- VPNGate runtime 상태 비움

---

## 15. service worker 복원 설계

현재 복원 구조상 runtime state는 storage에 남아 있어야 한다.

핵심:

- `background/background.js:211-314`

복원 원칙:

1. scheduler 상태 복원
2. 각 scheduler가 실제 실행 중인지 확인
3. monitor / comment-monitor가 child runtime mode를 다시 주입
4. `DEFAULT + VPNGate ON` 소비자가 있으면 runtime state 로드
5. stale면 다음 루프에서 refresh

즉 service worker가 꺼졌다 살아나도,

- 당장 다시 DAT를 새로 받아야만 하는 구조로 두지 않고
- 저장된 runtime state를 먼저 읽고
- 필요 시 다음 루프에서 10분 stale 체크 후 refresh

로 두는 편이 안전하다.

주의:

- 여기서 말하는 “consumer state 복원”은 background가 post/comment용 consumer 문자열을 직접 재조립한다는 뜻은 아니다
- 실제 구조는 background가 scheduler 실행 상태와 child mode를 복원하고
- 그 다음 공용 scheduler 루프가 현재 `mode + config`를 다시 평가해서 필요한 consumer를 재등록하는 쪽이 맞다

주의:

- 복원 순서상 “monitor가 먼저 VPNGate runtime을 준비해 줄 것”이라고 가정하면 안 된다.
- child scheduler가 먼저 한 사이클을 돌 수도 있으므로,
- **공용 scheduler 경로에서 lazy하게 runtime 준비를 보장**하는 쪽이 안전하다.

---

## 16. 구현해야 할 파일 목록

### 신규 파일

- `features/vpngate-prefix/runtime.js`
- `features/vpngate-prefix/prefix-normalization.js`
- 필요 시:
  - `features/vpngate-prefix/rc4.js`
  - `features/vpngate-prefix/dat-decode.js`

### 수정 파일

- `manifest.json`
- `features/post/scheduler.js`
- `features/comment/scheduler.js`
- `popup/popup.html`
- `popup/popup.js`
- `background/background.js`

---

## 17. 구현 순서 권장안

### Step 1. feed/runtime 모듈부터 만든다

먼저 아래가 준비되어야 한다.

- DAT fetch
- decode
- live snapshot set
- KR overlay set
- effectivePrefixes 계산
- storage save/load
- consumer register/release

이게 먼저 없으면 post/comment 쪽은 붙일 수 없다.

### Step 2. post scheduler DEFAULT 경로에 붙인다

이때 확인 포인트:

- DEFAULT만 적용되는지
- reflux/narrow/page1_no_cutoff에는 안 붙는지
- monitor child에도 그대로 먹는지
- 실행 중 `DEFAULT` 진입에도 바로 붙는지

### Step 3. comment scheduler DEFAULT 경로에 붙인다

이때 확인 포인트:

- comment reflux / pure hangul 모드에 안 섞이는지
- monitor child에도 그대로 먹는지
- 실행 중 `DEFAULT` 진입에도 바로 붙는지
- delete verification 경로에는 안 섞이는지

### Step 4. popup 토글을 붙인다

이때 확인 포인트:

- 저장/복원 되는지
- `FEATURE_DOM` 등록이 맞는지
- `getFeatureConfigInputs()` 반영이 맞는지
- UI status refresh 때 checkbox가 틀어지지 않는지

### Step 5. service worker 복원 확인

확인 포인트:

- 실행 중 worker reload
- status 복원
- consumer state 복원
- stale refresh 동작

### Step 6. refresh 실패 / stale cache 확인

확인 포인트:

- 캐시가 있을 때 refresh 실패
  - stale cache 유지되는지
- 캐시가 없을 때 refresh 실패
  - 기존 DEFAULT fallback 되는지

---

## 18. 예시 플로우

### 18-1. 게시글 수동 DEFAULT + VPNGate ON

1. 사용자가 게시글 설정에서 `VPNGate prefix 필터 사용` 체크
2. 설정 저장
3. 게시글 분류 ON
4. post scheduler가 `DEFAULT + useVpnGatePrefixFilter=true` 확인
5. VPNGate runtime refresh 필요 시 DAT 갱신
6. basePosts 중 prefix 맞는 글만 남김
7. 그 글들만 기존 분류 로직으로 처리

예시:

- 유동 글 18개
- prefix hit 6개
- 최종 분류 후보 6개

### 18-2. 댓글 자동화 공격 진입 + child DEFAULT + VPNGate ON

1. 댓글 자동화가 공격 감지
2. attack mode가 `DEFAULT`로 결정
3. child comment scheduler를 `source: 'monitor'`로 시작
4. child config에 `useVpnGatePrefixFilter=true`
5. 유동 댓글 중 prefix hit만 남김
6. 그 댓글만 기존 DEFAULT 삭제 배치로 처리

예시:

- 유동 댓글 12개
- prefix hit 3개
- 3개만 삭제 배치로 감

### 18-3. 실행 중 mode가 DEFAULT로 바뀌는 경우

1. 게시글 자동화가 처음에는 `SEMICONDUCTOR_REFLUX`
2. 몇 사이클 뒤 `maybeWidenAttackMode()`로 `DEFAULT` 전환
3. child post scheduler는 재시작 없이 계속 도는 중
4. 그 다음 루프부터 VPNGate prefix filter가 붙음

예시:

- widened 전: basePosts 10개 전부 기존 narrow 규칙
- widened 후: basePosts 10개 중 prefix hit 4개만 DEFAULT 후보

---

## 19. 논리 검증 포인트

이번 설계는 아래 이유로 기존 플로우를 망가뜨리지 않는다.

### 19-1. 기존 narrow/reflux 모드에 손대지 않는다

이미 특수 모드인:

- post `CJK_NARROW`
- post `SEMICONDUCTOR_REFLUX`
- post `PAGE1_NO_CUTOFF`
- comment `COMMENT_REFLUX`
- comment `EXCLUDE_PURE_HANGUL`

은 전부 기존 그대로 둔다.

즉 영향 범위를 `DEFAULT`로 한정했다.

### 19-2. 자동화는 공용 scheduler 재사용 구조와 맞는다

monitor/comment-monitor 모두 child scheduler를 재사용한다.

즉 popup/monitor 양쪽에 중복 구현하지 않고,  
공용 scheduler DEFAULT 경로에만 붙이면 manual + monitor 둘 다 커버된다.

### 19-3. 설정도 현재 저장 구조와 맞는다

popup -> background `updateConfig` -> scheduler.config merge -> saveState

이 현재 구조와 충돌하지 않는다.

추가로 현재 merge가 live 반영이기 때문에,

- ON 저장 후 재시작 강제 없음
- OFF 저장 후 다음 루프부터 해제 가능

이라는 점도 구조와 맞다.

### 19-4. service worker sleep/wake에도 대응 가능하다

runtime state를 별도 storage key로 두면 복원 가능하다.

### 19-5. 후보 선정 경로와 검증 경로를 분리하면 부작용을 줄일 수 있다

이 필터는 **후보를 줄이는 용도**다.

그래서 아래 검증 성격 경로에는 넣지 않는 것이 맞다.

- 댓글 삭제 후 남아있는지 재확인하는 경로
- 이미 삭제 대상으로 잡아둔 번호가 아직 존재하는지 검사하는 경로

예시:

- 댓글 A가 이미 삭제 대상으로 선택됨
- 그 뒤 VPNGate set이 갱신되어 prefix가 빠짐
- 검증 단계까지 prefix filter를 걸면 “없어진 것처럼” 잘못 볼 수 있다

따라서 prefix filter는 `candidate selection`에만 쓴다.

### 19-6. 공격자가 VPNGate를 안 쓰기 시작해도 손실이 제한된다

왜냐하면:

- 기본값 OFF
- 필요 시 OFF로 바로 복귀 가능
- ON이어도 refresh 실패 시 stale cache 또는 기존 DEFAULT fallback

이기 때문이다.

---

## 20. 구현 전 발견된 주의점

### 20-1. 이 기능은 잡아내는 기능이 아니라 좁히는 기능이다

즉 detection boost가 아니라 collateral reduction 보조 장치다.

따라서 문서/코드/로그 모두에서 이 의미를 분명히 해야 한다.

권장 로그 예시:

- `🧭 VPNGate prefix 필터 ON - 유동 14개 중 prefix hit 5개`
- `⚠️ VPNGate prefix refresh 실패 - 직전 캐시로 계속 진행`
- `⚠️ VPNGate prefix refresh 실패 - 기존 DEFAULT 경로로 계속 진행`

### 20-2. prefix 기준이라 완전 정확한 exact IP 방어는 아니다

예시:

- `175.201.*.*` 안의 일반 사용자도 걸릴 수 있다

그래도 현재 DEFAULT 전체 삭제보다 좁혀지는 방향이므로,  
“무고한 유동 피해를 줄이는 보조 필터”라는 목적에는 부합한다.

### 20-3. KR overlay는 활성 중 누적이므로 메모리/저장 상태가 조금씩 늘 수 있다

하지만:

- 소비자 0명이 되면 초기화
- 값 자체가 `A.B` prefix set

이라 크기 부담은 크지 않다.

### 20-4. 시작 시점만 보면 된다고 생각하면 누락이 생긴다

이번 기능에서 가장 위험한 구현 실수는 이것이다.

- start 때만 consumer 등록
- stop 때만 consumer 해제

이렇게 해두면 아래가 빠진다.

- monitor가 실행 중 `DEFAULT`로 widened 되는 경우
- comment child가 재시작 없이 mode 변경되는 경우
- 실행 중 checkbox 저장값이 바뀌는 경우

그래서 기준은 단순하다.

- **현재 mode**
- **현재 config**
- **현재 consumer 상태**

를 공용 루프에서 계속 맞춰 주는 방식으로 가야 한다.

---

## 21. 패치 체크리스트

1. `manifest.json`에 VPNGate host permission 추가
2. browser용 DAT decode/runtime 모듈 추가
3. runtime storage key / consumer 관리 구현
4. prefix 전용 normalization helper 추가
5. post config에 `useVpnGatePrefixFilter` 추가
6. comment config에 `useVpnGatePrefixFilter` 추가
7. popup HTML checkbox 2개 추가
8. popup JS 저장 payload 반영
9. popup `FEATURE_DOM` / `getFeatureConfigInputs()` 반영
10. popup JS 상태 반영 로직 추가
11. post scheduler DEFAULT 경로에 prefix filter 삽입
12. comment scheduler DEFAULT 경로에 prefix filter 삽입
13. stop / mode switch / checkbox OFF 시 consumer 해제
14. worker 복원 시 runtime state load 확인
15. refresh 실패 시 stale cache 유지 또는 DEFAULT fallback 로그 확인
16. manual DEFAULT ON/OFF 테스트
17. monitor DEFAULT ON/OFF 테스트
18. comment delete verification 경로 비오염 확인
19. non-default mode 영향 없음 확인

---

## 22. 결론

이번 0419 패치 방향은 다음으로 확정한다.

1. VPNGate prefix filter는 `옵션형`으로 넣는다.
2. 전역 공통 토글이 아니라 `게시글 / 댓글 각각의 설정 checkbox`로 둔다.
3. 적용 범위는 `DEFAULT`만이다.
4. 게시글은 `basePosts` 이후 공용 경로에 붙인다.
5. 댓글은 `filterFluidComments()` 다음 공용 경로에 붙인다.
6. 자동화는 child scheduler 재사용 구조라 별도 monitor 전용 구현이 필요 없다.
7. 다만 자동화는 실행 중 mode가 바뀔 수 있으므로 start/stop뿐 아니라 runtime mode switch도 같이 본다.
8. runtime은 `10분 refresh + live snapshot + KR overlay 누적 + stale effective cache 유지` 구조로 간다.
9. 마지막 소비자가 사라지면 runtime state를 비운다.
10. feed 실패 시에는 먼저 stale cache를 쓰고, 그것도 없을 때만 기존 DEFAULT로 fallback 한다.
11. popup 구현은 HTML만이 아니라 `FEATURE_DOM / getFeatureConfigInputs / save payload / UI sync`까지 한 세트로 반영한다.
12. 댓글 쪽은 후보 선정에만 prefix filter를 쓰고, 삭제 검증 경로에는 넣지 않는다.

이렇게 하면:

- 기존 플로우를 거의 안 깨고
- 수동/자동 양쪽에 같은 논리로 붙고
- VPNGate 공격 시에는 무고한 유동 희생을 줄일 수 있고
- 공격자가 다른 VPN으로 바꾸면 checkbox OFF로 즉시 원복 가능하다.
