# VPNGate Global Delta Overlay 세션 누적 설계

## 1. 문서 목적

이 문서는 기존 [vpngate_default_prefix_filter_integration_plan.md](/home/eorb915/projects/dc_defense_suite/docs/0419/vpngate_default_prefix_filter_integration_plan.md)의
`KR overlay만 누적` 정책을 덮어쓰는 후속 설계다.

이번에 확정하려는 것은 단 하나다.

- 현재는 `live snapshot + KR overlay`
- 앞으로는 `live snapshot + global overlay`

즉, 10분마다 받은 VPNGate feed에서 **한국만 따로 누적하지 말고**
그 시점에 보인 **전세계 prefix(A.B) 전체를 세션 동안 delta 누적**한다.

중요:

- 이 누적은 **영구 저장**이 아니다.
- 게시글/댓글 쪽에서 VPNGate prefix filter를 더 이상 쓰지 않으면 runtime state는 통째로 삭제된다.
- 따라서 이번 변경은 `TTL 없는 세션 캐시 확장`으로 보면 된다.

예시:

- 01:00 feed:
  - `175.201`, `219.100`, `91.23`
- 01:10 feed:
  - `219.100`, `45.66`
- 기존 KR overlay 정책:
  - 한국 prefix만 계속 남고, `91.23` 같은 해외 prefix는 feed에서 빠지면 같이 사라짐
- 이번 global overlay 정책:
  - `175.201`, `219.100`, `91.23`, `45.66` 전부 세션 동안 유지

즉 공격자가 해외 exit를 한 번 썼다가 10분 뒤 feed에서 빠져도,
그 세션이 살아 있는 동안은 다시 잡을 수 있게 만든다.

---

## 2. 현재 실제 코드 재확인

이번 문서는 아래 실제 코드와 다시 대조해서 작성했다.

- VPNGate runtime 상태:
  - [features/vpngate-prefix/runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js)
- prefix 정규화:
  - [features/vpngate-prefix/prefix-normalization.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/prefix-normalization.js)
- 게시글 DEFAULT 필터 적용:
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js)
- 댓글 DEFAULT 필터 적용:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js)
- service worker 복원:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)

### 2-1. 현재 runtime 상태 구조

현재 `vpngatePrefixRuntimeState`는 다음 필드를 가진다.

- `liveSnapshotPrefixes`
- `krOverlayPrefixes`
- `effectivePrefixes`
- `activeConsumers`

근거:

- 상태 초기화: [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L20)
- sanitize/clone: [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L37)

즉 현재 구조는 이름 자체가 `KR overlay` 전용이다.

### 2-2. 현재 refresh 로직

현재 refresh는 이렇게 동작한다.

1. feed에서 받은 host 전체를 돌며 `liveSnapshotPrefixes`를 만든다.
2. `CountryShort === 'KR'`인 host만 `krOverlayPrefixes`에 누적한다.
3. 마지막에 `effectivePrefixes = liveSnapshotPrefixes ∪ krOverlayPrefixes`

근거:

- fetch/refresh 시작: [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L183)
- KR만 누적하는 분기: [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L215)
- effective 계산: [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L226)

쉽게 말하면 현재는:

- `지금 보이는 전세계 목록`은 즉시 사용
- `예전에 봤던 것 중 계속 남겨두는 건 한국만`

이다.

### 2-3. 실제 필터 적용 위치

게시글과 댓글 모두 VPNGate prefix filter는 `DEFAULT`일 때만 탄다.

게시글:

- 조건 체크: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L167)
- 실제 적용: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L197)
- run loop 연결: [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L542)

댓글:

- 조건 체크: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L139)
- 실제 적용: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L169)
- run loop 연결: [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L333)

즉 이번 변경은 UI나 scheduler 분기 변경이 아니라,
**runtime prefix 공급 정책만 KR-only에서 global로 넓히는 패치**다.

### 2-4. 실제 세션 종료/삭제 조건

여기가 이번 문서에서 제일 중요하다.

runtime state는 “체크박스 OFF를 background가 직접 받아서 즉시 clear”하는 구조가 아니다.
실제 삭제 조건은 **active consumer가 0명**이 되는 시점이다.

근거:

- consumer 제거 후 0명이면 storage key 삭제:
  - [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L331)

consumer 해제는 아래 경로에서 일어난다.

게시글:

- stop 시 전부 해제:
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L146)
- DEFAULT가 아니면 filter 진입 시 tracked consumer 해제:
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L197)
- monitor mode 전환 중 DEFAULT가 아니게 되면 해제:
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L303)
- 상태 복원 시 scheduler가 꺼져 있으면 해제:
  - [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L680)

댓글:

- stop 시 전부 해제:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L122)
- DEFAULT가 아니면 filter 진입 시 tracked consumer 해제:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L169)
- runtime attack mode가 DEFAULT가 아니게 되면 해제:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L909)
- 상태 복원 시 scheduler가 꺼져 있으면 해제:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L955)

즉 정확한 의미는 이렇다.

- “둘 다 OFF면 무조건 즉시 삭제”가 아니라
- “게시글/댓글 어느 쪽에서도 DEFAULT VPNGate filter consumer가 안 남으면 삭제”

하지만 여기서도 “저장 버튼을 누르는 순간 동기적으로 clear된다”라고 이해하면 안 된다.
실제 정리는 release 경로를 타는 다음 시점에 일어난다.

운영 관점에서는 거의 이렇게 이해해도 된다.

- 게시글/댓글 VPNGate filter를 다 끄거나
- 둘 다 DEFAULT가 아니게 되거나
- 둘 다 정지되면
- runtime state는 결국 지워진다

예시:

1. 게시글 DEFAULT ON, 댓글 OFF
- consumer 1개 유지
- state 유지

2. 게시글 OFF로 저장, 댓글도 OFF
- 다음 run turn 또는 stop 경로에서 consumer 해제
- 결국 active consumer 0
- state 삭제

3. 둘 다 꺼진 뒤 다시 ON
- 빈 state에서 새로 feed 받아 시작

그래서 이번 global overlay는 **세션 누적**이지 **영구 누적**이 아니다.

### 2-5. 댓글 쪽 source 전환 nuance

게시글과 댓글은 consumer release 타이밍이 완전히 같지는 않다.

게시글은 monitor 쪽으로 source가 바뀌는 순간,
`setMonitorAttackMode()` 안에서 source change만으로도 tracked consumer release를 건다.

근거:

- [features/post/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/post/scheduler.js#L303)

반면 댓글은 `setCurrentSource()`가 source 값만 바꾸고 끝난다.
즉 source 전환 자체만으로는 consumer release가 일어나지 않는다.

근거:

- source만 바꾸는 함수:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L896)
- 댓글 monitor 복원 경로가 먼저 `setCurrentSource('monitor')`를 호출:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L240)
- 댓글 쪽 release는 `setRuntimeAttackMode()`가 non-default일 때, 또는 다음 filter/stop/loadState 경로에서 일어남:
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L169)
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L909)
  - [features/comment/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment/scheduler.js#L955)

예시:

1. 댓글 수동 DEFAULT가 이미 돌아가서 `comment_manual_default` consumer가 붙어 있음
2. comment monitor가 takeover 하면서 `setCurrentSource('monitor')`
3. 이 순간 old manual consumer가 즉시 떨어지는 것은 아님
4. 이후 monitor run에서 `comment_monitor_default`가 추가될 수 있음
5. 나중에 non-default 전환, stop, loadState 정리 경로에서 둘 다 정리됨

즉 현재 comment 쪽 `activeConsumers`는
“지금 당장 실제로 쓰는 consumer 딱 1개”라기보다
“아직 명시적으로 release되지 않은 consumer id 집합”
으로 이해하는 편이 정확하다.

이번 global overlay 문서는 이 nuance를 전제로 작성해야 한다.
그래야 “왜 토글 껐는데 즉시 clear 안 됐지?” 같은 오해를 막을 수 있다.

### 2-6. 수동 저장값은 monitor-owned child에도 그대로 적용된다

이 부분도 실제 연결 기준으로 확인했다.

popup에서는 댓글/게시글 각각의 `VPNGate prefix filter 저장` 버튼이
그 feature의 `updateConfig`만 보낸다.

근거:

- 댓글 popup 저장:
  - [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1678)
- 게시글 popup 저장:
  - [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L1855)

background는 그 값을 해당 scheduler의 `config`에 그대로 merge 저장한다.

근거:

- boolean normalize:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L650)
- 실제 config merge/save:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L818)

그리고 monitor/comment-monitor는 별도 복제 config를 들고 있는 게 아니라
같은 child scheduler 인스턴스를 잡아서 `start()` 또는 attack mode/source만 바꿔서 재사용한다.

근거:

- 게시글 child 시작/재사용:
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L641)
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L663)
- 댓글 child 시작/재사용:
  - [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L430)
  - [features/comment-monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/comment-monitor/scheduler.js#L459)

즉 예시로:

1. popup에서 게시글 `VPNGate prefix filter = ON` 저장
2. background가 `postScheduler.config.useVpnGatePrefixFilter = true`로 저장
3. 나중에 monitor가 공격 감지 후 `postScheduler.start({ source: 'monitor', attackMode: 'default' })`
4. 그 monitor-owned run도 같은 `postScheduler.config`를 읽으므로 VPNGate filter가 그대로 적용됨

댓글도 동일하다.

따라서 이번 문서에서 “UI 변경 없음”이라고 해도,
의미는 “새 토글을 더 만들 필요가 없다”는 뜻이지
“자동화와 분리된 별도 설정”이라는 뜻이 아니다.

---

## 3. 이번 변경에서 확정하는 결정

### 3-1. TTL은 넣지 않는다

이번 변경에서는 TTL을 넣지 않는다.

이유:

1. runtime state는 active consumer 0이면 통째로 삭제된다.
2. 즉 장기 보존 DB가 아니라, 필터가 실제로 켜져 있는 동안만 유지되는 세션 캐시다.
3. 이번 목적은 “feed에서 잠깐 보였다 사라진 해외 exit도 그 세션 안에서는 다시 잡기”이므로 TTL이 오히려 목적을 깎는다.

예시:

- 01:00에 `91.23`이 feed에 있었음
- 01:10에 빠짐
- 01:25에 공격자가 `91.23`으로 다시 옴
- TTL이 없으면 잡힘
- 짧은 TTL이면 놓칠 수 있음

### 3-2. KR overlay를 global overlay로 넓힌다

현재:

- `krOverlayPrefixes`

변경 후:

- `overlayPrefixes`

의미:

- 더 이상 `CountryShort === 'KR'` 조건을 두지 않는다.
- refresh 때 보인 모든 prefix를 overlay에 누적한다.

### 3-3. live snapshot은 그대로 남긴다

`liveSnapshotPrefixes`는 유지한다.

이유:

1. 현재 feed에 실제로 뭐가 보였는지 로그/디버깅 가시성이 좋다.
2. overlay가 세션 누적이고, live snapshot은 현재 시점 상태라 역할이 다르다.
3. 나중에 “현재 feed와 누적분을 분리해서 보기”가 가능하다.

즉 구조는 유지하되, 정책만 바꾼다.

현재:

- `effective = liveSnapshot ∪ krOverlay`

변경 후:

- `effective = liveSnapshot ∪ overlay`

실제로는 overlay가 현재 live를 계속 흡수하므로 시간이 지나면 overlay가 더 큰 superset이 되지만,
구조와 로그는 그대로 두는 편이 구현/디버깅이 쉽다.

### 3-4. UI / 조건 / 주기 변경은 없다

이번 패치에서 바꾸지 않는 것:

- popup 토글 구조
- `useVpnGatePrefixFilter` 저장 방식
- `DEFAULT에서만 적용` 조건
- 10분 refresh 주기
- post/comment 개별 설정 구조

즉 사용자는 지금과 똑같이 보되,
내부 runtime 누적 범위만 한국 전용에서 전세계 세션 누적으로 바뀐다.

---

## 4. 실제 패치 범위

이번 변경의 중심은 [features/vpngate-prefix/runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js)이지만,
최종적으로는 background dormant cleanup 경로도 같이 손봐야 문서 의미와 실제 동작이 완전히 맞는다.

실제 수정 파일은 이렇게 잡는 게 맞다.

### 필수 수정

- [features/vpngate-prefix/runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js)
- [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js)

### 문서 수정

- 이 문서 추가
- 기존 [vpngate_default_prefix_filter_integration_plan.md](/home/eorb915/projects/dc_defense_suite/docs/0419/vpngate_default_prefix_filter_integration_plan.md) 상단에
  “overlay 정책은 이 문서를 따른다” 우선순위 note 추가

### 수정 불필요

- `popup/popup.html`
- `popup/popup.js`
- `features/post/scheduler.js`
- `features/comment/scheduler.js`
- `features/monitor/scheduler.js`
- `features/comment-monitor/scheduler.js`

이유:

- 필터가 언제 켜지고 꺼지는지
- 어떤 mode에서만 쓰는지
- 어떤 release 경로에서 state가 정리되는지

는 이미 현재 코드가 맞게 처리하고 있다.
다만 comment 쪽은 source 전환만으로 consumer를 떼지 않으므로,
이 문서와 구현은 “즉시 clear”가 아니라 “다음 release 경로에서 clear”를 기준으로 이해해야 한다.
그리고 background의 dormant child 정리 경로는 예외적으로 보강이 필요하다.

---

## 5. 바로 패치 가능한 상세 변경안

## 5-1. 상태 필드 이름 정리

`krOverlayPrefixes`는 이름과 의미가 어긋나므로 `overlayPrefixes`로 바꾼다.

변경안:

- `createEmptyRuntimeState()`
  - `krOverlayPrefixes` -> `overlayPrefixes`
- `cloneRuntimeState()`
  - 동일 변경
- `sanitizeRuntimeState()`
  - 동일 변경

### 중요한 migration 요구사항

배포 직후 기존 storage에는 아직 `krOverlayPrefixes`가 남아 있을 수 있다.
그래서 `sanitizeRuntimeState()`는 아래처럼 읽어야 한다.

1. `rawState.overlayPrefixes`가 있으면 그것을 우선 사용
2. `rawState.krOverlayPrefixes`가 있으면 같이 합친다
3. 최종 결과를 `overlayPrefixes`로 저장한다
4. `effectivePrefixes`는 저장된 값을 그대로 신뢰하지 말고, merge된 `liveSnapshotPrefixes ∪ overlayPrefixes`로 재계산한다

예시:

기존 저장값:

```json
{
  "liveSnapshotPrefixes": ["219.100", "175.201"],
  "krOverlayPrefixes": ["175.201", "121.170"],
  "effectivePrefixes": ["219.100", "175.201", "121.170"]
}
```

새 버전 로드 후 내부 normalize:

```json
{
  "liveSnapshotPrefixes": ["219.100", "175.201"],
  "overlayPrefixes": ["175.201", "121.170"],
  "effectivePrefixes": ["219.100", "175.201", "121.170"]
}
```

즉 **기존 사용자 세션을 깨지 않는 migration**이 필요하다.

왜 재계산이 필요하냐면,
구버전 storage의 `effectivePrefixes`는 `krOverlayPrefixes` 기준으로 저장된 값이다.
새 버전에서 overlay merge를 끝낸 뒤에도 old `effectivePrefixes`를 그대로 들고 오면
`liveSnapshotPrefixes/overlayPrefixes`와 `effectivePrefixes`가 어긋난 상태가 남을 수 있다.

예시:

```json
{
  "liveSnapshotPrefixes": ["219.100"],
  "krOverlayPrefixes": ["175.201"],
  "effectivePrefixes": ["219.100"]
}
```

이런 상태를 새 sanitize가 그대로 믿으면 잘못이다.
정답은 새 구조 기준으로 다시 계산해서:

```json
{
  "liveSnapshotPrefixes": ["219.100"],
  "overlayPrefixes": ["175.201"],
  "effectivePrefixes": ["175.201", "219.100"]
}
```

이 되어야 한다.

## 5-2. refresh 정책 변경

현재 `buildRuntimeStateFromHosts()` 안에는 한국만 누적하는 분기가 있다.

현재:

- `const krOverlaySet = new Set(state.krOverlayPrefixes);`
- `CountryShort === 'KR'`일 때만 overlay에 추가

변경 후:

- `const overlaySet = new Set(state.overlayPrefixes);`
- 모든 host에 대해 prefix가 있으면 overlay에 추가
- 국가 분기 제거

즉 의사코드는 이렇게 바뀌면 된다.

```js
const livePrefixSet = new Set();
const overlaySet = new Set(state.overlayPrefixes);

for (const host of hosts) {
  const ip = String(host?.IP || '').trim();
  if (!ip) continue;

  const prefix = normalizeVpnGatePrefix(ip);
  if (!prefix) continue;

  livePrefixSet.add(prefix);
  overlaySet.add(prefix);
}

const liveSnapshotPrefixes = sortUniqueStrings([...livePrefixSet]);
const overlayPrefixes = sortUniqueStrings([...overlaySet]);
const effectivePrefixes = sortUniqueStrings([
  ...liveSnapshotPrefixes,
  ...overlayPrefixes,
]);
```

이렇게 하면

- 이번 refresh에서 새로 본 prefix는 전부 overlay에 쌓이고
- 이전 refresh에서만 보였던 prefix도 세션 동안 유지된다

## 5-3. 로그 문구 수정

현재 로그:

- `live X개 / KR overlay Y개 / effective Z개`

변경 후:

- `live X개 / overlay Y개 / effective Z개`

근거:

- 지금 로그 문구는 정책을 그대로 반영하므로, 문구를 안 바꾸면 디버깅할 때 혼동된다.

수정 위치:

- [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L261)

## 5-4. meta 필드 정리

`meta.krUniqueIpCount`는 더 이상 의미가 없다.

이번 문서에서는 여기서도 선택지를 남기지 않고 한 방향으로 확정한다.

확정안:

- `krUniqueIpCount`는 제거한다
- `overlayPrefixCount`를 추가한다
- `sanitizeRuntimeState()`는 구버전 `krUniqueIpCount`가 있더라도 읽기만 하고,
  새 state를 저장할 때는 `overlayPrefixCount` 기준으로 normalize한다

이렇게 고정하는 이유:

1. 정책은 이미 global overlay인데 통계 이름만 `KR`로 남겨 두면 의미가 어긋난다
2. 이 meta는 runtime.js 안에서만 관리되고 실제 필터 로직이 의존하지 않으므로 지금 같이 정리하는 비용이 작다
3. 배포 후 storage snapshot을 봤을 때 이름과 의미가 바로 맞는다

즉 이번 패치 스펙에서는 meta도 같이 정리하는 쪽으로 간다.

---

## 6. 실제 패치 시 주의할 연결 포인트

이번 패치는 범위가 작지만, 아래 6가지는 놓치면 안 된다.

### 6-1. sanitize migration 누락 금지

가장 중요한 부분이다.

만약 `krOverlayPrefixes` -> `overlayPrefixes` 이름만 바꾸고 migration을 안 넣으면,
배포 직후 기존 사용자의 저장 state를 읽을 때 누적값이 통째로 사라진다.

이건 기능상 치명적이진 않아도 사용자 입장에서는 “왜 갑자기 필터 범위가 줄었지?”로 보일 수 있다.

### 6-2. clear 조건은 건드리지 않는다

이번 요구사항의 핵심은:

- `TTL 없이 세션 동안 누적`
- `consumer 0이면 clear`

이다.

따라서 `releaseVpnGatePrefixRuntimeConsumer()`나 `clearRuntimeState()` 조건은 바꾸지 않는다.

이 부분은 현재 이미 맞다.

단, 구현 설명에서는 반드시
“토글 OFF 직후 즉시 clear”
라고 쓰지 말고
“다음 release 경로(run/stop/loadState/non-default 전환)에서 clear”
라고 적어야 한다.

### 6-3. DEFAULT-only 조건은 건드리지 않는다

이번 변경은 누적 정책만 넓히는 것이다.

따라서:

- 게시글 `DEFAULT`에서만 사용
- 댓글 `DEFAULT`에서만 사용

이 조건은 그대로 두어야 한다.

### 6-4. refresh 실패 fallback은 그대로 둔다

현재 refresh 실패 시 동작:

1. 기존 `effectivePrefixes`가 있으면 stale cache로 계속 진행
2. 기존 값이 없으면 기존 DEFAULT로 fallback

근거:

- [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js#L245)

이 정책은 이번 요구와 충돌하지 않으므로 그대로 두는 것이 맞다.

### 6-5. comment source 전환은 수정 대상이 아니지만 문서에서는 정확히 써야 한다

이번 패치는 comment scheduler의 source 전환 로직을 바꾸는 작업이 아니다.
즉 아래 사실을 전제로만 간다.

- `setCurrentSource('monitor')`는 source 값만 바꾼다
- non-default 전환, 다음 filter 진입, stop, loadState가 실제 release 시점이다

이 점을 문서에 안 써 두면,
나중에 runtime 상태가 바로 안 지워졌을 때
global overlay 패치가 원인처럼 오해될 수 있다.

### 6-6. background dormant child cleanup은 실제 수정이 필요하다

여기가 이번 최종 재검증에서 새로 잡힌 실제 연결 포인트다.

현재 service worker 복원 경로에는
“monitor가 child를 들고 있었지만 지금은 attacking이 아님”
상태를 정리하는 함수가 있다.

근거:

- 게시글/IP child dormant 정리:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1706)
- 댓글 child dormant 정리:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L1757)

문제는 이 함수들이 지금은:

- `isRunning = false`
- `clearRuntimeAttackMode()` 또는 `setCurrentSource('')`
- `saveState()`

만 하고 끝난다는 점이다.

예시:

1. service worker가 죽기 전 child scheduler가 DEFAULT + VPNGate filter consumer를 runtime state에 등록해 둠
2. service worker가 다시 뜸
3. `loadState()`는 child scheduler가 `isRunning: true`로 저장돼 있었기 때문에 release를 안 함
4. 그런데 곧바로 background dormant cleanup이 `isRunning = false`만 찍고 저장
5. 결과적으로 `vpngatePrefixRuntimeState.activeConsumers`에는 old consumer id가 남을 수 있음

즉 정상 런타임의 `stop()` 경로는 맞지만,
resume 시 dormant child 정리 경로는 `releaseAllKnownVpnGatePrefixConsumers()`를 안 타므로
세션 종료 의미가 한 템포 늦어질 수 있다.

따라서 이번 패치 스펙에서는 background에 아래 보강이 필요하다.

- `stopDormantMonitorChildSchedulers()`에서 post child를 내릴 때
  `await schedulers.post.releaseAllKnownVpnGatePrefixConsumers?.()` 호출
- `stopDormantCommentMonitorChildScheduler()`에서 comment child를 내릴 때
  `await schedulers.comment.releaseAllKnownVpnGatePrefixConsumers?.()` 호출

이 보강까지 들어가야
문서의 “consumer 0이면 clear”가 resume/dormant cleanup 경로에서도 정확히 성립한다.

---

## 7. 정적 검증 체크리스트

패치 후 아래 항목을 실제 코드 기준으로 확인하면 된다.

### 상태 구조

- `createEmptyRuntimeState()`에 `overlayPrefixes`가 존재한다
- `krOverlayPrefixes` 직접 참조가 runtime.js에서 사라진다
- `sanitizeRuntimeState()`가 구버전 `krOverlayPrefixes`를 읽어 `overlayPrefixes`로 흡수한다
- `sanitizeRuntimeState()`가 `effectivePrefixes`를 저장값 그대로 두지 않고 `liveSnapshotPrefixes ∪ overlayPrefixes`로 재계산한다

### refresh 동작

- 한국 조건 분기가 제거된다
- 모든 host prefix가 overlay에 누적된다
- `liveSnapshotPrefixes`는 현재 refresh 결과만 유지한다
- `effectivePrefixes`는 누적된 overlay를 포함한다

### lifecycle

- post/comment 둘 다 consumer 0이면 clear되는 기존 경로가 그대로 살아 있다
- stop/loadState/non-default 전환 시 release 경로가 기존대로 유지된다
- comment는 source 전환만으로는 release되지 않는 현재 동작을 문서가 정확히 반영한다
- background dormant child cleanup이 known consumer release까지 수행하도록 보강된다

### 로그

- `KR overlay` 문구가 `overlay`로 바뀐다

---

## 8. 샘플 시나리오 검증

패치 후 기대 결과는 아래와 같다.

### 시나리오 A. 해외 exit가 한 번 보였다가 사라지는 경우

1. 01:00 feed:
   - `91.23`, `219.100`
2. 01:10 feed:
   - `219.100`만 남음
3. 01:20 공격자가 `91.23.*.*`로 옴

기대 결과:

- 기존 KR overlay 정책:
  - `91.23`은 잡히지 않을 수 있음
- 새 global overlay 정책:
  - `91.23`은 overlay에 남아 있으므로 잡힘

### 시나리오 B. 두 필터를 전부 끄는 경우

1. 게시글 DEFAULT 필터 ON
2. 댓글 DEFAULT 필터 ON
3. 둘 다 OFF 또는 둘 다 정지

기대 결과:

- 저장 직후 동기 clear를 가정하지 않는다
- 각 scheduler가 다음 run/stop/loadState release 경로를 타며 consumer 수가 0이 됨
- runtime storage key 삭제
- 다음에 다시 켜면 빈 상태에서 새로 feed refresh

### 시나리오 C. 댓글만 계속 켜 두는 경우

1. 게시글 필터 OFF
2. 댓글 필터 ON

기대 결과:

- state 유지
- overlay 계속 누적

### 시나리오 D. service worker 재시작 직후 dormant child 정리

1. 이전 worker에서 post/comment child가 DEFAULT + VPNGate filter consumer를 등록해 둠
2. worker 재시작 후 `loadState()` 시점에는 child가 아직 `isRunning: true`라 release 안 함
3. monitor/comment-monitor가 attacking이 아니라서 dormant child cleanup 수행

기대 결과:

- background cleanup에서 known consumer release까지 수행
- child scheduler를 `isRunning: false`로 저장
- active consumer가 0이면 runtime storage key 즉시 정리

이 시나리오가 빠지면,
세션 overlay가 의도보다 길게 남을 수 있다.

즉 clear 조건은 “체크박스 2개가 모두 false”라는 UI 상태 자체가 아니라,
실제 consumer 수다.
하지만 운영상으론 거의 같은 방향으로 이해하면 된다.

---

## 9. 최종 결론

이번 변경은 **어렵지 않은 축의 패치**다.

이유:

1. 핵심 로직이 거의 [runtime.js](/home/eorb915/projects/dc_defense_suite/features/vpngate-prefix/runtime.js) 한 파일에 모여 있다.
2. 다만 background dormant cleanup 경로는 release 보강이 한 번 필요하다.
3. 그 외 post/comment/monitor/popup 연결은 이번 변경 요구를 처리하기에 이미 충분하다.
4. 바꿔야 하는 것은 “누적 대상 국가 조건”, “state 필드 이름/migration”, “resume 시 stale consumer 정리”다.

단, comment 쪽 source 전환 nuance, sanitize 재계산 요구사항, background dormant cleanup 보강은 문서에 반드시 명시되어야 한다.

실제 구현 지침을 한 줄로 요약하면 이렇다.

- `KR overlay 전용 누적`을 제거하고
- `전세계 prefix delta를 세션 동안 overlay로 누적`
- `consumer 0이면 clear`
- `TTL 없음`
- `DEFAULT-only / UI / refresh 주기 / fallback 정책은 그대로`

이 상태면 다음 패치 턴에서 다른 설계 재논의 없이 바로 구현해도 된다.
