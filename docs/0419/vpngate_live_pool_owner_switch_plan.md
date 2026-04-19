# 0419 VPNGate Live Pool Owner Switch Plan

## 목표

이번 단계 목표는 `selfHostedVpn` 탭을 아래 흐름으로 바꾸는 것이다.

1. 토글 `ON`
2. official raw feed 기준 후보 `200`개를 읽는다
3. 가능한 후보를 실제 `Connected` 까지 올린다
4. route / public IP 검증을 통과한 슬롯만 `live pool` 로 남긴다
5. popup 목록에 `검증 통과 슬롯` 들을 표시한다
6. 사용자가 목록의 다른 릴레이를 클릭하면
7. **새 연결을 만드는 게 아니라**
8. 기존 owner metric을 올리고 새 owner metric을 낮춰
9. `1~2초 settle -> public IP 확인`
10. 성공하면 새 슬롯을 active로 반영한다

쉽게 예시로 보면:

- 토글 `ON`
- 후보 `200`
- 슬롯 가능 `126`
- 실제 연결 성공 `110`
- 검증 통과 `96`
- popup에 `96`개가 보임
- 지금 `37번` 이 active
- 사용자가 `84번` 클릭
- `37번 metric 50`, `84번 metric 1`
- `1~2초` 대기
- 공인 IP 확인
- 성공하면 `84번` 이 새 active

## 한 줄 결론

지금 구조에서 진행 가능하다.

다만 핵심은 이거다.

- 새 기능을 하나 더 붙이는 게 아니다
- 기존 `raw catalog` 흐름의 의미를 바꿔야 한다

즉 현재:

- `prepareRawRelayCatalog()` = Offline 계정 캐시 준비
- `activateCatalogRelay()` = 클릭 시 실제 첫 연결

을 아래처럼 바꿔야 한다.

- `prepareRawRelayCatalog()` = live pool 준비
- `activateCatalogRelay()` = owner switch

가장 크게 바뀌는 곳은 아래 3개다.

- `projects/self_hosted_vpn_agent/server.mjs`
- `features/self-hosted-vpn/scheduler.js`
- `popup/popup.js`

## 현재 실제 코드 기준 확인 결과

### 1. popup은 이미 `토글 ON -> catalog 준비`, `목록 클릭 -> 액션 전송` 구조다

- `popup/popup.html`
  - `자체 VPN 테스트` 탭 카드가 이미 있고
  - `raw catalog list` 영역이 이미 있다
  - 병렬 probe 카드도 같은 탭 안에 같이 있다
- `popup/popup.js`
  - 토글 `ON` -> `sendFeatureMessage('selfHostedVpn', { action: 'start' })`
  - 목록 row 클릭 -> `sendFeatureMessage('selfHostedVpn', { action: 'activateCatalogRelay', relay })`

즉 UI 이벤트 자체는 새로 만들 필요가 없다.

없는 것은 아래 둘이다.

- 목록 아이템이 `Offline cache` 가 아니라 `live pool item` 으로 보이게 하는 렌더링
- `CONNECTED` 상태에서도 다른 row 클릭을 허용하는 전환 흐름

여기서 실제로 더 확인된 충돌점은 3개다.

1. `renderSelfHostedVpnCatalogList()` 안에 `connectedLock` 이 따로 있다
   - 현재는 `status.phase === CONNECTED` 이면
   - popup이 row 버튼을 전부 `대기 / disabled` 로 막는다
   - 즉 scheduler/agent만 풀어도 popup에서 다시 막힌다
2. row lookup이 현재 `relayId` 하나만 쓴다
   - 클릭 시 `data-relay-id`
   - 이후 `catalog.items.find((item) => item.id === relayId)`
   - 현재 official feed 선택 로직은 host당 `selectedSslPort` 1개만 뽑으니 당장은 동작 가능하다
   - 하지만 나중에 같은 host/id에 대해 여러 포트를 pool에 넣고 싶으면 이 구조는 깨진다
   - 그 경우 lookup key를 `id + selectedSslPort` 로 바꿔야 한다
3. 토글 `ON` 전에 `DIRTY_FEATURES.selfHostedVpn` 이면 start가 막힌다
   - 즉 새 설정 필드를 추가하면
   - `popup.html`
   - `popup.js saveConfig`
   - `popup.js syncFeatureConfigInputs`
   - dirty tracking 경로
   를 같이 고치지 않으면 저장 안 된 값 때문에 시작이 막힌다

### 2. background 액션 라우팅은 그대로 재사용 가능하다

- `background/background.js`
  - `start`
  - `stop`
  - `refreshStatus`
  - `activateCatalogRelay`
  - `updateConfig`
  이미 `selfHostedVpn` 전용으로 처리한다

즉 이번 단계에서는 background에 **새 액션을 추가할 필요가 없다**.

바꿔야 하는 것은 action 의미뿐이다.

- `start`
  - 기존: raw catalog offline 준비
  - 변경: live pool 준비
- `activateCatalogRelay`
  - 기존: 선택 relay에 대해 첫 연결
  - 변경: 선택 relay로 owner switch

다만 background 쪽에도 그대로 넘어가면 생기는 제약이 있다.

- `getSelfHostedVpnStartBlockMessage()`
  - 로그인 세션 자동화 중
  - 다른 blocking feature 동작 중
  이면 `start` 뿐 아니라 `activateCatalogRelay` 도 막는다
- `getConfigUpdateBlockMessage()`
  - 현재는 기존 설정 필드들만 비교한다
  - live-pool 전용 설정을 추가하면 여기 비교 항목도 같이 늘려야 한다
- 상태 초기화 기본 shape도 background에 하드코딩돼 있다
  - rawRelayCatalog summary 필드를 추가하면
  - background reset default도 같이 수정해야 한다

### 3. scheduler는 현재 `CONNECTED 상태 클릭 금지`가 가장 큰 충돌점이다

- `features/self-hosted-vpn/scheduler.js`
  - `start()` 는 raw mode일 때 `prepareRawRelayCatalogRequest(this.config)` 로 간다
  - `activateCatalogRelay()` 는 현재 `phase === CONNECTED` 이면 예외를 던진다
  - 현재 raw catalog item 모델은 `Offline cache` 기준이다

즉 지금 코드에서는

- `37번 active`
- `84번 클릭`

을 허용하지 않는다.

이번 단계에서 scheduler 쪽 핵심 수정은 딱 3개다.

1. `CONNECTED` 상태 차단 제거
2. raw catalog item/status 모델을 live pool 기준으로 확장
3. 메타 문구와 상태 라벨을 `offline cache` 기준에서 `live pool` 기준으로 변경

추가로 실제 코드상 확인된 점은 아래다.

- `start()` 는 현재 `PREPARING/READY/CONNECTING/CONNECTED/DISCONNECTING` 이면
  - 새 prepare를 다시 쏘지 않고
  - `이미 연결 상태` 로그만 남기고 리턴한다
- 즉 지금 구조에는 `catalog rebuild` 나 `pool rebuild` 액션이 따로 없다
- 1차 구현 문서에서는 이 정책을 명확히 고정해야 한다
  - `재구축 = stop -> start`
  - 혹은 `force rebuild` 액션을 새로 추가
- `buildDefaultRawRelayCatalogStatus()` 도 scheduler 내부에 별도 정의가 있다
  - summary 필드 추가 시
  - popup default
  - scheduler default
  - background reset default
  - agent normalize/default
  를 다 같이 맞춰야 한다

### 4. local agent는 이미 필요한 부품 절반 이상을 갖고 있다

- `projects/self_hosted_vpn_agent/server.mjs`
  - `prepareRawRelayCatalog()`
  - `activateCatalogRelay()`
  - `disconnect()`
  - `executeRawRelayCatalogPrepare()`
  - `executeCatalogRelayConnect()`
- 같은 파일 안의 parallel probe 로직
  - `executeParallelProbeStart()`
  - `connectParallelProbeSlot()`
  - `verifyParallelProbeSlot()`
  - `applyParallelProbeRouteOwner()`
  - `refreshParallelProbeRouteSnapshot()`

즉 필요한 핵심 엔진은 이미 있다.

없는 것은 아래다.

1. `raw catalog` 쪽에서 parallel probe 로직을 재사용할 공용 helper 분리
2. `live pool` 상태 저장
3. 클릭 시 `AccountConnect` 대신 `route owner switch` 로 동작 변경

그리고 여기서 문서에 꼭 반영해야 하는 실제 충돌점이 많다.

1. `prepareRawRelayCatalog()` 는 현재 `catalogEnabled && phase in [PREPARING, READY] && items.length > 0` 이면
   - 기존 catalog를 그대로 반환한다
   - 즉 agent 레벨에서도 재구축이 없다
2. 현재 raw catalog는 `single shared NIC cache` 구조다
   - `executeRawRelayCatalogPrepare()`
   - `ensureManagedNic()`
   - `provisionRawCatalogAccount(relayItem, adapterName, relayItem.accountName)`
   - 이 흐름이라 모든 cache account가 사실상 한 managed NIC 기준으로 준비된다
   - 즉 지금 cache account를 그대로 `live slot` 으로 해석하면 안 된다
3. `findForeignBusyAccount()` 는 `isRawCatalogAccountName(row.name)` 를 아예 제외한다
   - 지금은 raw cache account가 offline cache라는 가정이라 괜찮다
   - 하지만 live pool에서 raw account가 여러 개 `CONNECTED` 상태가 되면
   - state 유실/재시작 시 conflict guard가 그걸 바쁜 연결로 안 볼 수 있다
4. `findConflictingManagedBusyAccounts()` 는 단일 managed account만 본다
   - raw live pool 계정은 여기에도 안 걸린다
   - 즉 live pool 도입 후에는 conflict/recovery 기준을 다시 정의해야 한다
5. `buildPublicRawRelayCatalogState()` 는 `state.accountName` 하나만 보고 `isActive` 를 계산한다
   - live pool에서는
   - `isRouteOwner`
   - `isConnected`
   - `poolState`
   가 별도로 필요하다
   - 기존 `isActive` 하나로는 부족하다
6. `finishDisconnectCleanup()` / `transitionToCatalogReady()` 는
   - 끊은 뒤 catalog를 유지하고 `READY` 로 돌아가는 구조다
   - live pool 문서대로 가려면 이 경로를 바꿔서
   - `전체 teardown -> IDLE`
   로 끝내야 한다

### 5. 현재 구조에서 가장 중요한 실제 제약은 NIC 슬롯 수다

- `projects/self_hosted_vpn_agent/lib/softether_cli.mjs`
  - `SOFTETHER_MAX_REGULATED_NIC_INDEX = 127`
- `projects/self_hosted_vpn_agent/server.mjs`
  - parallel probe 기본 NIC는 `VPN2`, `VPN3`, `VPN4`

즉 지금 코드 그대로는 **200 full live slot을 보장하지 못한다**.

여기서 중요한 결론은 이거다.

- 문서 목표는 `후보 200개` 가 맞다
- 하지만 구현은 반드시
  - `requestedCandidateCount`
  - `provisionableSlotCount`
  를 분리해서 보여줘야 한다

쉽게 예시로 보면:

- 후보는 `200`
- 실제 NIC/SoftEther 한계로 연결 시도 가능한 슬롯은 `126`
- 연결 성공 `98`
- 검증 통과 `81`

이렇게 나올 수 있다.

이걸 숨기면 안 된다.

추가 제약도 있다.

- 현재 `ensureSpecificNic()` 는 특정 NIC 이름 하나를 보장하는 helper다
- 즉 126 슬롯을 쓰려면
  - slot 이름 목록 생성
  - 생성 실패/disabled NIC 집계
  - provisionable count 계산
  가 새 orchestrator에서 필요하다
- 그리고 `buildSoftEtherNicCandidateList()` 는 이미 softether_cli 쪽에 있으니
  - slot 후보 이름 생성은 이 helper 기준으로 맞추는 게 안전하다

## 추가로 확인된 핵심 이슈

이 문서는 처음엔 "지금 구조에서 가능"에 초점을 뒀는데, 실제 코드 재확인 후 아래 9개는 구현 전에 반드시 고정해야 하는 이슈로 판단했다.

### A. 현재 `parallel probe` 는 이름과 달리 실제 연결을 병렬로 올리지 않는다

- `executeParallelProbeStart()` 는
  - `for (const slot of preparedSlots)`
  - `await this.connectParallelProbeSlot(...)`
  순서라서 슬롯 연결을 순차로 돈다
- 즉 지금 있는 probe orchestrator를 그대로 가져와서는
  - `200 후보`
  - `controlled concurrency 8`
  같은 설계를 만족할 수 없다

결론:

- 재사용 대상은 probe orchestrator가 아니다
- `connect slot`
- `verify slot`
- `route owner 전환`
- `route snapshot refresh`
  같은 low-level helper만 뽑아야 한다

### B. live pool용 account naming 정책이 아직 문서에 없었다

현재는

- raw catalog account = relay 기준 deterministic 이름
- parallel probe account = slot + timestamp 기반 임시 이름

이다.

live pool에서는 둘 다 그대로 쓰기 애매하다.

이유:

- relay 기준 이름은 slot 개념이 없다
- timestamp 기반 이름은 복원/재조회/전환 매핑이 불안정하다

1차 문서 기준 권장 정책:

- `slot` 기준 deterministic 이름 사용
- 예시: `DCDSVPNLIVE-SLOT-001`
- slot에 현재 relay 정보가 붙는 구조

이렇게 해야

- status 복원
- owner switch
- teardown
- 실패 slot 재할당

이 쉬워진다.

### C. `prepare` request schema는 지금 문서보다 좁다

현재 end-to-end로 실제 받는 값은 아래뿐이다.

- `limit`
- `preferredCountries`
- `preferredPorts`

즉 문서 초안에 적혀 있던

- `connectConcurrency`
- `verifyOnPrepare`
- `requestedCandidateCount`

같은 필드는 아직 실제 schema에 없다.

따라서 1차 구현 문서에서는 아래처럼 가는 게 맞다.

- 외부 request schema는 우선 기존 3개만 유지
- `candidate target = limit`
- `connectConcurrency` 같은 값은 agent 내부 상수 또는 별도 2차 schema 확장으로 분리

만약 1차부터 request field를 늘릴 거면 같이 고쳐야 하는 곳:

- `features/self-hosted-vpn/api.js`
- `features/self-hosted-vpn/scheduler.js`
- `popup/popup.js`
- `background/background.js` reset/default
- `projects/self_hosted_vpn_agent/server.mjs`
  - `normalizeRawRelayCatalogPrepareRequest()`

### D. route/IP 검증은 반드시 fresh path를 써야 한다

현재 병렬 probe 검증은 `probeFreshPublicIpv4()` 를 쓴다.

반대로 일반 status 경로 일부는 `NetworkObserver` 캐시를 쓸 수 있다.

즉 owner switch 성공 판정은 아래처럼 고정해야 한다.

- route owner 변경
- settle
- route snapshot refresh
- fresh public IP probe

여기서 stale cache를 쓰면 안 된다.

### E. popup의 `relayId only` lookup은 1차 범위를 넘으면 바로 깨질 수 있다

현재 official feed 선택은 host당 한 개 `selectedSslPort` 를 고른다.
그래서 지금 popup이 `relayId` 하나만 들고 가도 대체로 맞는다.

하지만 아래를 나중에 하려면 반드시 바꿔야 한다.

- 같은 host의 여러 포트 동시 pool
- 같은 id인데 다른 port가 따로 보이는 목록

그때는 lookup key를 아래처럼 바꾸는 게 안전하다.

- `relayId:selectedSslPort`
  또는
- `buildRawRelayCatalogLookupKey()` 와 동일한 키

### F. 이 기능에는 현재 long-running health refill loop가 없다

- scheduler `ensureRunLoop()` 는 비어 있다
- MV3 재조회 시점에 agent status를 읽는 구조다

즉 1차 구현에서는 아래를 약속하면 안 된다.

- background에서 자동으로 dead slot 보충
- 시간이 지나면 pool이 저절로 재충전

1차 문서 기준으로는

- 수동 준비
- 수동 owner switch
- 필요 시 stop -> start 재구축

까지만 정의하는 게 정확하다.

### G. `CONNECTED 차단`은 세 군데를 같이 풀어야 한다

현재 막는 곳은 세 군데다.

1. popup `renderSelfHostedVpnCatalogList()` 의 `connectedLock`
2. scheduler `activateCatalogRelay()`
3. agent `activateCatalogRelay()`

하나만 풀면 동작하지 않는다.

### H. 현재 `start()` 는 prepare request body를 실제로 보내지 않는다

문서만 보면

- `limit = 200`
- `preferredCountries = KR, JP`
- `preferredPorts = ...`

를 scheduler가 agent에 보낼 수 있을 것처럼 보이는데, 현재 실제 호출은 그렇지 않다.

- scheduler `start()` 는 `prepareRawRelayCatalogRequest(this.config)` 만 호출한다
- 그런데 api `prepareRawRelayCatalog(config, options)` 는
  - 첫 번째 인자는 agent base URL / timeout 용 config
  - 실제 POST body는 `options.body`
  로 나뉘어 있다
- 지금 scheduler는 `options.body` 를 안 넘기므로 실제 요청 body는 `{}` 다
- 그래서 현재 prepare는 agent 기본값만 쓴다

쉽게 예시로 보면:

- 문서에서 `limit=200, KR/JP` 라고 써도
- 지금 코드 그대로면 scheduler는 그냥 빈 body `{}` 를 보낸다
- agent가 내부 기본값 `200/KR,JP/기본포트` 를 쓰는 구조다

즉 1차 구현에서 선택지는 둘 중 하나다.

1. 아예 문서대로 `고정 기본값` 으로 간다
2. 아니면 scheduler가 `prepareRawRelayCatalogRequest(this.config, { body: ... })` 형태로 명시적으로 보내게 바꾼다

### I. slot 기준 owner switch를 하려면 `activate` request schema도 같이 넓혀야 한다

현재 popup click handler는 catalog item 전체를 잡아도

- api `activateCatalogRelay(config, relay)` 에서
- body는 `id / fqdn / ip / selectedSslPort / sslPorts / udpPort / hostUniqueKey`
  만 남기고
- `slotId`, `accountName`, `nicName`, `poolState` 같은 값은 전부 버린다

즉 문서처럼 live pool item이

- `slot-37`
- `slot-84`

같이 slot이 진짜 source of truth가 되면, 지금 request schema는 부족하다.

추가로 더 중요한 점:

- scheduler `activateCatalogRelay()` 는 요청 전에 `this.config.selectedRelayId / selectedSslPort / relaySnapshot` 을 target으로 덮어쓴다
- 반면 `applyActiveRelayConfig()` 는 status에 active relay 정보가 없으면 config fallback을 쓴다

쉽게 예시로 보면:

- 현재 active는 `37`
- 사용자가 `84` 클릭
- scheduler가 config를 먼저 `84` 로 덮어씀
- 그런데 switch가 실패했는데 status 응답에 active relay 필드가 비어 있으면
- scheduler는 config fallback 때문에 `84` 를 현재 relay처럼 표시할 수 있다

결론:

- live pool에서는 config를 `현재 owner` source of truth로 쓰면 안 된다
- `activateCatalogRelay` 요청도 `relay snapshot` 만이 아니라
  - `slotId`
  - 또는 최소 `lookupKey`
  를 명시적으로 보내는 쪽이 안전하다

## 목표 동작 정의

### 토글 ON

토글 `ON` 의 의미를 아래처럼 고정한다.

- official raw feed에서 `200` 후보를 받음
- 가능한 슬롯 수를 계산함
- 슬롯별 계정/NIC를 준비함
- 실제 연결을 올림
- route owner를 돌려가며 순차 검증함
- 검증 통과한 것만 `VERIFIED` 로 남김
- top-level phase를 `READY` 로 바꿈

예시:

- 후보 `200`
- 슬롯 가능 `126`
- 연결 성공 `143` 는 불가능하다
- 실제로는 `connectable <= provisionable`

즉 이 문서 기준 구현에서는 summary를 아래처럼 분리한다.

- `requestedCandidateCount = 200`
- `provisionableSlotCount = 126`
- `connectedSlotCount = 110`
- `verifiedSlotCount = 96`

### 목록 클릭

목록 클릭의 의미를 아래처럼 고정한다.

- 지금 owner가 없으면
  - target만 metric `1`
  - settle
  - public IP 검증
- 지금 owner가 있으면
  - old owner metric `50`
  - new owner metric `1`
  - settle
  - public IP 검증

성공 시:

- `activeSlotId = targetSlotId`
- `activeRelayId` 등 top-level active 필드 갱신
- top-level phase = `CONNECTED`

실패 시:

- old owner를 복구할지 여부를 정책으로 명확히 결정
- target slot은 `DEAD` 또는 `ERROR` 로 떨어뜨림

이번 단계 기본 정책은 아래로 간다.

- 기존 owner가 있으면 **실패 시 기존 owner 복구 시도**
- 복구 성공 시 top-level active는 유지
- target slot만 `ERROR`

여기서 검증 방식도 문서에 명확히 고정한다.

- owner switch 성공 판정은 `fresh public IP probe` 기준
- 단순 cached status refresh만으로 성공 처리하지 않는다

쉽게 예시로 보면:

- 현재 `37`
- `84` 클릭
- `84` 검증 실패
- 다시 `37` metric `1` 복귀
- 화면상 active는 계속 `37`

### 토글 OFF

토글 `OFF` 는 아래 의미로 바꾼다.

- active owner만 끊는 게 아니다
- current live pool 전체를 정리한다
- 모든 pool account disconnect/delete
- baseline metric 복구
- phase = `IDLE`

즉 `disconnect()` 의 의미도 raw live-pool 기준으로 확장되어야 한다.

## 상태 모델 변경안

### top-level phase

기존 phase는 유지하되, 이번 흐름에서 실제로 쓰는 의미를 아래처럼 고정한다.

- `IDLE`
  - 아무 pool도 없음
- `PREPARING`
  - 후보 수집 / NIC 준비 / 계정 생성 / 연결 / 검증 중
- `READY`
  - live pool 준비 완료, 아직 owner 없음
- `SWITCHING`
  - owner 전환 중
- `CONNECTED`
  - active owner 검증 완료
- `DISCONNECTING`
  - live pool 전체 정리 중
- `ERROR`
  - 마지막 작업 실패
- `AGENT_UNAVAILABLE`
  - local agent 미응답

주의:

- 기존 코드에는 `SWITCHING` 이 없다
- 이번 단계에서는 `normalizePhase()` 와 popup label mapping에 `SWITCHING` 을 추가하는 게 맞다

이유는 간단하다.

- `CONNECTING` 은 지금까지 “첫 연결” 의미였다
- 이번 구조에서는 클릭 전환이 더 자주 일어난다
- `CONNECTING` 과 `owner switch` 를 같은 phase로 두면 로그/메타/UI가 헷갈린다

### rawRelayCatalog 확장

현재 `rawRelayCatalog.items[]` 는 offline cache 기준 필드만 있다.

이번 단계에서는 각 item에 최소 아래가 필요하다.

- `slotId`
- `poolState`
  - `PROVISIONING`
  - `CONNECTING`
  - `CONNECTED`
  - `VERIFYING`
  - `VERIFIED`
  - `ERROR`
  - `DEAD`
- `interfaceAlias`
- `interfaceIndex`
- `routeOwned`
- `routeReady`
- `connectedAt`
- `lastVerifiedAt`
- `exitPublicIp`
- `exitPublicIpProvider`
- `lastErrorCode`
- `lastErrorMessage`

그리고 summary에는 최소 아래가 필요하다.

- `requestedCandidateCount`
- `provisionableSlotCount`
- `connectedSlotCount`
- `verifiedSlotCount`
- `deadSlotCount`
- `activeSlotId`
- `routeOwnerSlotId`
- `lastVerifiedPublicIp`
- `lastVerifiedPublicIpProvider`

예시 item:

```json
{
  "slotId": "slot-84",
  "id": "18786933",
  "ip": "121.138.132.127",
  "selectedSslPort": 1698,
  "accountName": "DCDSVPNLIVE-18786933-1698",
  "nicName": "VPN84",
  "poolState": "VERIFIED",
  "interfaceIndex": 92,
  "routeOwned": false,
  "connectedAt": "2026-04-19T12:30:00.000Z",
  "lastVerifiedAt": "2026-04-19T12:31:10.000Z",
  "exitPublicIp": "219.100.37.240"
}
```

## 파일별 수정 계획

### 1. `popup/popup.html`

이번 단계에서 HTML은 새 탭을 만들 필요가 없다.

수정 방향:

- 기존 catalog count / status / meta 문구를 live-pool 기준으로 바꾼다
- `병렬 3슬롯` 카드는 실험 기능으로 남기되
  - 메인 플로우 설명과 시각적으로 분리한다
- catalog row에 아래 정보가 보이게 한다
  - `poolState`
  - `slotId`
  - `active`
  - `exitPublicIp`
  - `lastErrorMessage`

예시 문구:

- `후보 200 / 슬롯 가능 126 / 연결 성공 110 / 검증 통과 96`
- `현재 active: slot-37 / 219.100.37.240`

### 2. `popup/popup.js`

핵심 변경점:

1. `getSelfHostedVpnStatusLabel()` / `getSelfHostedVpnStatusClassName()`
   - `SWITCHING` 지원
2. `buildSelfHostedVpnCatalogMetaText()` 계열 문구
   - `Offline cache` 문구 제거
   - `live pool` 기준으로 변경
3. `renderSelfHostedVpnCatalogList()`
   - item별 `poolState`, `active`, `verified ip`, `error` 표시
4. click handler는 유지
   - 여전히 `activateCatalogRelay`
   - 다만 row 식별자는 `relay.id` 하나가 아니라 `slotId` 또는 `lookupKey` 기준으로 바꾼다

중요:

- popup 이벤트 구조는 이미 충분하다
- 이 단계에서는 이벤트 종류를 새로 만들 필요는 없지만
  - `data-relay-id`
  - `catalog.items.find((item) => item.id === relayId)`
  이 부분은 slot 기준으로 바꿔야 한다

### 3. `background/background.js`

이번 단계에서는 새 액션 추가 없이 진행한다.

유지:

- `start`
- `stop`
- `refreshStatus`
- `activateCatalogRelay`

추가 수정은 최소화:

- start block 문구만 필요하면 조정
- `activateCatalogRelay` 는 `CONNECTED` 상태에서도 정상 허용되도록 scheduler 결과만 그대로 통과

즉 background는 큰 구조 변경 대상이 아니다.

### 4. `features/self-hosted-vpn/api.js`

기존 endpoint는 재사용 가능하다.

- `POST /v1/vpn/catalog/prepare`
- `POST /v1/vpn/catalog/activate`
- `POST /v1/vpn/disconnect`
- `GET /v1/vpn/status`
- `GET /v1/vpn/egress`

다만 1차 구현 기준으로는 `prepareRawRelayCatalog()` body를 과하게 넓히지 않는 게 맞다.

1차 구현 추천 body:

```json
{
  "limit": 200,
  "preferredCountries": ["KR", "JP"],
  "preferredPorts": [443, 995, 1698, 5555, 992, 1194]
}
```

중요:

- `prepareRawRelayCatalog()` 는 실제로 body를 비워 보내고 있으므로
  - scheduler에서 명시적으로 `options.body` 를 넘기거나
  - 1차는 agent 기본값 고정 정책으로 간다
- `activateCatalogRelay()` 는 relay snapshot만으로도 동작 가능한 구조는 만들 수 있지만
  - live pool source of truth가 slot이면
  - `slotId` 또는 최소 `lookupKey` 를 body에 같이 보내는 쪽이 더 안전하다
- agent는 `slotId / lookupKey -> verified slot` 을 먼저 찾고
  - 그 다음 owner switch 수행

주의:

- 현재 popup click은 `relay.id` 만 들고 간다
- 현재 api는 relay snapshot에서 `slotId` 같은 필드를 버린다
- 그래서 live pool이 slot 단위가 되면
  - popup
  - api request schema
  - agent lookup
  를 같이 바꿔야 한다

### 5. `features/self-hosted-vpn/scheduler.js`

이번 단계 핵심 수정점:

1. `PHASE` 에 `SWITCHING` 추가
2. `activateCatalogRelay()` 의 `phase === CONNECTED` 차단 제거
3. `rawRelayCatalog` default / normalize 모델 확장
4. `start()` 메타 로그와 안내를 live-pool 기준으로 변경
5. `stop()` 의 의미를 live pool teardown 기준으로 해석

중요한 로직 변경:

- 현재 `activateCatalogRelay()` 는 `CONNECTED` 일 때 에러
- 변경 후:
  - `PREPARING`, `DISCONNECTING` 만 차단
  - `READY`, `CONNECTED`, `SWITCHING` 복구 후 클릭 재시도 정책은 agent 결과에 맞춰 처리

추천 top-level state 규칙:

- `PREPARING` 중 row 클릭 차단
- `READY` 에서 row 클릭 허용
- `CONNECTED` 에서 다른 row 클릭 허용
- `SWITCHING` 중 추가 클릭 차단

추가로 문서에 정책을 명확히 적어야 하는 부분:

- 1차 구현에서 rebuild는 `stop -> start` 로 한다
- `READY` 상태에서 start를 다시 눌러도 즉시 rebuild되지 않는다
- 새 `force rebuild` 액션을 넣지 않는 한 이 정책으로 유지한다

### 6. `projects/self_hosted_vpn_agent/server.mjs`

이번 단계 최대 수정 파일이다.

#### 6-1. `prepareRawRelayCatalog()` / `executeRawRelayCatalogPrepare()`

현재 의미:

- relay 목록 수집
- raw cache account provisioning
- `READY`

변경 의미:

- relay 목록 수집
- slot capacity 계산
- slot별 account provisioning
- 실제 연결
- 검증
- verified slot만 live pool 등록
- `READY`

즉 이 함수는 사실상 아래를 하게 된다.

1. feed fetch
2. `requestedCandidateCount = 200`
3. `provisionableSlotCount = min(요청수, SoftEther/NIC 가능 수)`
4. relay -> slot 매핑
5. 계정 생성
6. controlled concurrency로 `AccountConnect`
7. 연결된 슬롯만 순차 검증
8. verified slot summary 계산

주의:

- 현재 raw catalog prepare는 `single shared NIC cache` 흐름이다
- 그래서 여기서는
  - slot 배열
  - slot별 NIC
  - slot별 deterministic accountName
  를 새로 도입하는 재구성이 필요하다

#### 6-2. `activateCatalogRelay()`

현재 의미:

- 클릭한 relay가 아직 offline 또는 missing이면
- 그 계정을 연결 시도

변경 의미:

- 클릭한 relay에 대응되는 `VERIFIED` slot 탐색
- 현재 owner와 target owner 비교
- delta metric plan 적용
- settle
- public IP 검증
- 성공 시 active 교체

즉 `executeCatalogRelayConnect()` 는 이름부터 바꾸는 게 맞다.

추천 새 이름:

- `executeCatalogRelaySwitch()`

#### 6-3. parallel probe helper 재사용

이번 단계에서 병렬 probe 자체를 삭제할 필요는 없다.

대신 아래 helper를 raw live-pool 전용 공용 함수로 뽑는다.

- `connectParallelProbeSlot()`
- `verifyParallelProbeSlot()`
- `applyParallelProbeRouteOwner()`
- `refreshParallelProbeRouteSnapshot()`

추천 방향:

- `connectProbeStyleSlot()`
- `verifyProbeStyleSlot()`
- `applyRouteOwner()`
- `refreshRouteSnapshotForSlots()`

이 공용 helper를

- parallel probe
- raw live pool

둘 다 쓰게 만드는 게 맞다.

이유:

- 지금 raw catalog와 parallel probe가 서로 다른 상태기계를 들고 있어도
- 실제 SoftEther/NIC/metric/public IP 검증 방식은 같다
- 하지만 probe orchestrator 자체는 재사용하면 안 된다
  - 현재 연결을 순차로 돌고
  - 상태 저장도 `this.state.parallelProbe` 에 고정돼 있기 때문이다

#### 6-4. `disconnect()`

현재는 tracked account 기준 disconnect cleanup 흐름이다.

이번 단계에서는

- live pool active일 때
- `disconnect()` 가 active account만 끊으면 안 된다

필요 동작:

1. owner 포함 live pool account 전부 disconnect
2. inactive 확인
3. live pool account 전부 delete
4. metric baseline 복구
5. rawRelayCatalog inactive collapse
6. `IDLE`

여기서 실제 수정 포인트는 아래 함수들이다.

- `finishDisconnectCleanup()`
- `transitionToCatalogReady()`
- `transitionToIdle()`

live pool 기준에서는 `catalog 유지 READY` 경로를 기본으로 두면 안 된다.

### 7. `projects/self_hosted_vpn_agent/lib/network_state.mjs`

현재 `applyInterfaceMetricPlan()` 은 여러 interface metric을 한 번에 바꿀 수 있다.

이번 단계에서 추천하는 추가 helper:

- `applyRouteOwnerDelta(oldIfIndex, newIfIndex, oldMetric = 50, newMetric = 1)`

이유:

- 200 슬롯 live pool이면 매 전환마다 200개 전체를 다시 쓰는 것보다
- owner 2개만 바꾸는 delta switch가 더 명확하다
- 현재 `applyParallelProbeRouteOwner()` 는 연결된 슬롯 전부를 다시 쓴다
- 즉 그대로 쓰면 된다가 아니라 delta helper 추가가 맞다

예시:

- old owner `ifIndex=92`
- new owner `ifIndex=105`
- 실행:
  - `92 -> 50`
  - `105 -> 1`

### 8. `projects/self_hosted_vpn_agent/lib/softether_cli.mjs`

여기서 확인/수정할 항목은 2개다.

1. `SOFTETHER_MAX_REGULATED_NIC_INDEX = 127`
2. 실제 SoftEther Windows NIC upper bound가 그 이상 가능한지 확인

정책:

- 실제 upper bound 검증 전까지는 문서/구현 모두 `requested=200`, `provisionable=실제 감지치` 로 간다
- 즉 이번 문서 기준 구현은 **200을 요청하되, 불가능한 수는 거짓으로 채우지 않는다**

## 구현 순서

### 0단계

먼저 아래 3개를 고정한다.

1. 1차 request schema는 `limit / preferredCountries / preferredPorts` 만 쓴다
2. live pool account naming은 `slot 기준 deterministic 이름` 으로 간다
3. rebuild 정책은 `stop -> start` 로 간다

이 3개가 안 정해지면 이후 함수 수정 범위가 계속 흔들린다

### 1단계

- `server.mjs`
  - raw live-pool 상태 모델 추가
  - prepare/activate 의미 변경
- `scheduler.js`
  - `CONNECTED` 상태 클릭 허용
  - `SWITCHING` 추가

### 2단계

- `popup.js` / `popup.html`
  - catalog/live-pool UI 렌더링 변경
  - 문구 변경

### 3단계

- `network_state.mjs`
  - delta route switch helper
- `softether_cli.mjs`
  - NIC capacity 검증/확장

### 4단계

- test 추가
  - scheduler
  - local agent
  - static verification

## 반드시 지켜야 할 구현 원칙

1. **200 요청과 실제 provision 가능 수를 분리해서 표시한다**
2. `CONNECTED` 상태에서도 row 클릭을 허용한다
3. 검증은 순차다
4. 실패 시 기존 owner 복구를 우선 시도한다
5. `stop()` 은 active만 끊지 말고 live pool 전체 teardown이다
6. parallel probe 코드를 복붙하지 말고 공용 helper로 뽑는다
7. `offline cache` 문구를 남기지 않는다
8. `parallel probe` 이름만 보고 병렬 orchestrator를 재사용하지 않는다
9. `CONNECTED 차단` 은 popup / scheduler / agent 3군데를 같이 푼다
10. 1차 구현에서 자동 refill을 약속하지 않는다

## 예상 파생 이슈와 처리

### 1. 준비 시간이 길어진다

이건 정상이다.

예시:

- 토글 `ON`
- 200 후보 준비
- 연결/검증까지 수십 초

그래서 popup에는 반드시 준비 summary를 단계별로 보여줘야 한다.

- `후보 수집 중`
- `슬롯 준비 중`
- `연결 중`
- `검증 중`
- `검증 통과 N개`

### 2. 200 전부 live가 안 될 수 있다

이건 실패가 아니라 실제 capacity 반영이다.

예시:

- 후보 200
- 슬롯 가능 126
- 검증 통과 81

화면에 그대로 보여주면 된다.

### 3. owner switch 실패

기본 정책:

- 기존 owner가 있으면 복구 시도
- target slot은 `ERROR`
- active는 유지

그리고 성공/실패 판정은 fresh public IP probe 기준으로 한다.

### 4. popup/service worker 재기동

현재 scheduler는 MV3 long-running poll이 아니라

- storage state
- 새로고침 시 agent status 재조회

구조다.

즉 live pool 실제 소유권은 **agent state file 쪽이 기준** 이어야 한다.

이번 단계에서 기준 저장소는 아래다.

- extension storage: UI cache
- agent state file: 실제 slot/owner source of truth

추가로 주의:

- state file 복원 시 raw live-pool account가 여러 개 살아 있으면
- 기존 conflict 함수들이 이를 benign cache로 오판하지 않도록 보정이 필요하다

### 5. 설정 필드 추가 시 저장 경로 누락

새 live-pool 설정 필드를 넣는다면 아래를 같이 갱신해야 한다.

- `popup/popup.html`
- `popup/popup.js` save/sync/render
- `features/self-hosted-vpn/api.js` config normalize
- `background/background.js` config change block
- default status/reset state

## 테스트 계획

### 정적/계약 테스트

1. `start()` raw mode가 `prepare` 요청으로 가는가
2. `CONNECTED` 상태에서도 `activateCatalogRelay()` 가 차단되지 않는가
3. `PREPARING` 중 클릭은 차단되는가
4. `DISCONNECTING` 중 클릭은 차단되는가
5. `SWITCHING` 중 중복 클릭은 차단되는가
6. `SWITCHING` phase가 popup label에 정상 반영되는가
7. `rawRelayCatalog` summary 필드 normalize가 깨지지 않는가
8. 오래된 storage 상태를 load해도 기본값이 안전한가
9. popup의 `connectedLock` 이 제거되어도 `PREPARING/SWITCHING` 잠금은 유지되는가
10. 새 summary 필드가 popup/scheduler/background/agent 기본값에서 모두 맞는가

### agent 테스트

11. prepare 요청 시 requested/provisionable/connected/verified가 모두 계산되는가
12. feed 200, provisionable 126일 때 summary가 정확한가
13. 연결 실패 slot이 `ERROR` 로 떨어지는가
14. 검증 실패 slot이 `DEAD` 또는 `ERROR` 로 떨어지는가
15. verified slot만 live pool로 남는가
16. owner 없는 상태에서 첫 클릭이 성공하는가
17. owner 있는 상태에서 다른 클릭이 성공하는가
18. switch 실패 시 기존 owner 복구를 시도하는가
19. 복구 성공 시 active 유지되는가
20. 복구 실패 시 top-level error가 정확히 남는가
21. stop 시 모든 pool account가 disconnect/delete 되는가
22. stop 시 metric baseline이 원복되는가
23. agent restart 후 state file에서 live pool 상태를 복원하는가
24. popup refresh 후 active slot이 다시 보이는가
25. stray raw live-pool account가 남아 있을 때 conflict/recovery 로직이 이를 감지하는가
26. owner switch 검증이 stale cache가 아니라 fresh IP probe로 판정되는가

### UI 테스트

27. catalog meta에 후보/슬롯가능/연결성공/검증통과 수가 정확한가
28. row active 표기가 바뀌는가
29. row exit public IP가 보이는가
30. row error 메시지가 보이는가
31. `READY` 문구가 더 이상 Offline cache 기준이 아닌가
32. `CONNECTED` 상태에서 다른 row 버튼이 눌리는가
33. `SWITCHING` 중 버튼이 잠기는가
34. stop 후 목록이 inactive 상태로 내려가는가
35. 새 설정 필드를 넣었을 때 저장 후 start 경로가 dirty 상태 때문에 막히지 않는가

### 엣지 케이스

36. verified slot이 0개면 `READY` 가 아니라 `ERROR` 로 가는가
37. active slot이 죽었을 때 다음 refresh에서 표시가 정리되는가
38. relay id 중복/host 중복이 있으면 slot mapping이 안정적인가
39. NIC 생성 실패 시 provisionableSlotCount가 줄어드는가
40. requestTimeout과 actionTimeout이 긴 prepare 단계와 충돌하지 않는가
41. `READY` 상태에서 다시 start 했을 때 rebuild가 안 되는 정책이 사용자 메시지와 맞는가
42. 나중에 multi-port host를 열 경우 popup lookup key 충돌이 없는가

## 작업 전 최종 확인 결론

이 문서 기준으로 진행하면 가장 중요한 연결 문제는 아래처럼 정리된다.

- popup 액션 체계: 재사용 가능
- background 라우팅: 재사용 가능
- scheduler: `CONNECTED 클릭 금지` 해제와 상태 모델 확장 필요
- agent: prepare/activate 의미를 live-pool 기준으로 재작성 필요
- network_state: delta switch helper 추가 권장
- softether_cli: 200 요청 대비 실제 NIC capacity 노출 필요
- parallel probe: 이름만 믿고 재사용하면 안 되고 helper만 추출해야 함
- rebuild 정책: 1차는 `stop -> start`
- request schema: 1차는 기존 3필드 유지가 안전

즉 이번 작업은

- 새 탭 추가 작업이 아니라
- 기존 `selfHostedVpn raw catalog` 흐름을
- `live pool + owner switch` 흐름으로 바꾸는 작업

으로 정의하면 된다.
