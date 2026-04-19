# 0419 VPNGate 200 Slot True Parallel Prepare Plan

## 목표

이번 단계 목표는 `selfHostedVpn` raw live pool 준비를 아래처럼 바꾸는 것이다.

1. 토글 `ON`
2. official raw feed 후보 `200`개를 받는다
3. 후보 `200`개를 **200 logical slot** 으로 바로 만든다
4. NIC 준비 단계와 연결 단계, 검증 단계를 분리한다
5. 연결 단계는 **진짜 병렬** 로 돌린다
6. 검증 단계는 route/public IP 공유 자원 때문에 **직렬** 로 유지한다
7. usable relay는 검증 통과 슬롯만 남긴다
8. 사용자는 목록에서 verified slot을 클릭해서 빠르게 owner만 전환한다

쉽게 예시로 보면:

- 요청 후보 `200`
- logical slot `200`
- 실제 NIC 준비 성공 `143`
- 연결 성공 `61`
- 검증 통과 `39`
- popup에는 `39`개 usable slot이 보인다
- `slot-037` 사용 중일 때 `slot-084` 클릭
- 새 연결을 처음부터 만드는 게 아니라 owner만 바꾼다

## 이번 문서의 핵심 결론

### 1. 지금 느린 이유는 `8 worker` 때문이 아니라 `vpncmd 단일 직렬 queue` 때문이다

현재 `SoftEtherCli.run()` 은 인스턴스 내부 `this.queue` 로 모든 `vpncmd` 호출을 직렬화한다.

- `NicCreate`
- `AccountCreate`
- `AccountAnonymousSet`
- `AccountRetrySet`
- `AccountServerCertDisable`
- `AccountDetailSet`
- `AccountConnect`
- `AccountList`

이 명령들이 모두 같은 줄에 서기 때문에,

- 겉으로는 `slot-001 ~ slot-008` 이 동시에 시작된 것처럼 보여도
- 실제 `vpncmd` 는 하나씩만 처리된다

즉 지금 구조는 **가짜 병렬** 이다.

### 2. 지금 `슬롯 126` 은 feed 제한이 아니라 로컬 NIC 후보 제한이다

현재 슬롯 수는 아래 경로로 잘린다.

- `buildSoftEtherNicCandidateList()`
- `buildRawCatalogSlotNicNames()`
- `provisionableSlotCount = min(slotNicNames.length, relayCandidates.length)`

현재 코드상 NIC 이름 후보는 `VPN2 ~ VPN127` 까지만 허용한다.
관리용 NIC 1개를 제외하면 실제 raw live pool 에 쓸 수 있는 좌석은 `126` 이다.

즉 지금 화면의

- `후보 200 / 슬롯 126`

는 버그가 아니라 **현재 구현의 로컬 좌석 상한** 이다.

### 3. `200 후보를 모두 독립 작업으로 던지는 방향` 은 맞다

다만 이건 **연결 단계** 에 적용해야 한다.

검증 단계는 안 된다.

이유는 간단하다.

- 연결 단계: 각 slot이 자기 NIC / 자기 account / 자기 relay 로 독립적이다
- 검증 단계: route owner 와 public IP 는 이 PC 전체에서 하나만 확인 가능하다

쉽게 말하면:

- 연결 단계는 `200명 면접장에 동시에 들여보내도 됨`
- 검증 단계는 `운전대는 한 명만 잡을 수 있음`

따라서 정답 구조는:

- `연결 = 병렬`
- `검증 = 직렬`

이다.

### 4. `200 physical slot` 은 바로 단정하면 안 된다

`200 logical slot` 은 바로 가능하다.

하지만 `200 physical NIC / 200 simultaneous connected slot` 은 별도 검증이 필요하다.

이유:

- 현재 코드는 `VPN127` 까지만 허용한다
- 이 제한이 단순 우리 코드 제한인지
- SoftEther / Windows 가 실제로 그 이상 NIC를 만들 수 없는지
아직 증명되지 않았다

따라서 이번 문서는 아래 두 층으로 설계한다.

1. **필수 단계**
   - `200 logical slot`
   - 진짜 병렬 준비
   - NIC 준비/연결/검증 분리
2. **실험 단계**
   - `VPN128 ~ VPN200` 생성 가능 여부 검증
   - 가능하면 physical capacity도 `200` 쪽으로 확장
   - 불가능하면 `logical 200 / live capacity N` 으로 운영

이렇게 해야 구현도 진행 가능하고, 실패 조건도 숨기지 않는다.

## 현재 실제 코드 기준 문제 정리

### A. `softether_cli.mjs`

문제 지점:

- `SOFTETHER_MAX_REGULATED_NIC_INDEX = 127`
- `buildSoftEtherNicCandidateList()`
- `SoftEtherCli.run()` 의 전역 직렬 queue

현재 의미:

- NIC 후보 수를 `127` 규격 안으로 제한
- 같은 agent 인스턴스의 모든 `vpncmd` 호출을 직렬화

실제 영향:

- `slot-001 ~ slot-008` 로그는 빨리 찍혀도 실제 명령은 줄 서서 늦게 처리됨
- `NicCreate` 실패가 연결 단계 안에서 늦게 튀어나옴
- `AccountList polling` 도 같은 queue 를 먹어서 더 느려짐

### B. `server.mjs`

문제 지점:

- `executeRawRelayCatalogPrepare()`
- `connectRawRelayCatalogSlots()`
- `connectRawRelayCatalogSlot()`
- `waitForAccountConnectedPhase()`
- `verifyRawRelayCatalogSlot()`
- `buildRawCatalogSlotNicNames()`

현재 의미:

1. feed `200`
2. NIC 후보 수만큼 slot 자름
3. `connectRawRelayCatalogSlots()` 로 worker `8`개
4. 각 slot에서 `ensureSpecificNic() -> create account -> connect -> per-slot polling`
5. 연결된 슬롯만 순차 검증

실제 영향:

- NIC 생성 실패와 relay 연결 실패가 같은 hot path 에 섞임
- slot별 polling 때문에 `AccountList` 호출이 많이 발생
- worker 8개라도 내부 `vpncmd` 직렬 queue 때문에 체감 병렬성 낮음
- 검증은 연결 뒤에 순차로 돌아서 준비 시간이 길어짐

### C. `scheduler.js`

현재 의미:

- `start()` 는 raw prepare body를 보냄
- `activateCatalogRelay()` 는 owner switch 로 잘 바뀌어 있음

여기서 부족한 점:

- 현재 prepare body는 여전히 `limit=200` 중심이고
- `logicalSlotCount`
- `requestedPhysicalNicCount`
- `connectConcurrency`
- `nicPrepareConcurrency`
- `verifyConcurrency`
같은 파라미터가 없음

즉 지금은 agent가 어떤 병렬 정책으로 준비할지 세밀하게 전달하지 않는다.

### D. `popup.js`

현재 의미:

- raw 목록 상태는 보여준다
- owner switch 도 이미 들어가 있다

여기서 부족한 점:

- `후보 200 / 슬롯 126 / 연결 0 / 검증 0`
정도만 보이면 왜 늦은지 이해가 안 된다
- `logical slot`
- `live NIC capacity`
- `NIC prepared`
- `connect attempted`
- `capacity deferred`
같은 준비 단계 summary 가 없다

## 목표 아키텍처

이번 단계 이후 구조는 아래처럼 고정한다.

### 1. slot 개념을 `logical slot` 과 `physical NIC capacity` 로 분리

새 summary 필드:

- `requestedCandidateCount`
- `logicalSlotCount`
- `requestedPhysicalNicCount`
- `detectedPhysicalNicCapacity`
- `preparedNicCount`
- `connectAttemptedCount`
- `connectedSlotCount`
- `verifiedSlotCount`
- `failedSlotCount`
- `capacityDeferredSlotCount`

쉽게 예시로 보면:

- 후보 `200`
- logical slot `200`
- physical NIC capacity `126`
- NIC 준비 `126`
- 연결 시도 `126`
- 연결 성공 `61`
- 검증 통과 `39`
- capacity deferred `74`

여기서 중요한 건,

- `slot` 은 `200`
- 실제 동시에 붙일 수 있는 좌석은 `126`

이 둘을 분리해서 보이게 해야 한다는 점이다.

### 2. 준비 파이프라인을 4단계로 쪼갠다

#### 단계 1. feed 수집

- official raw feed 에서 후보 `200`개 수집
- `slot-001 ~ slot-200` logical slot 생성

이 단계에서는 아직 NIC도 account도 만들지 않는다.

#### 단계 2. NIC warmup

- 사용할 NIC 이름 목록을 먼저 만든다
- 가능한 것들을 먼저 `NicCreate` 한다
- 성공/실패를 이 단계에서 확정한다

이 단계에서 `NicCreate VPN15` 실패 같은 로컬 문제를 먼저 잡아야 한다.

즉 이후 연결 단계에서는 더 이상 `NicCreate` 를 하지 않는다.

#### 단계 3. 연결 단계

- 준비된 NIC를 기준으로 slot connect worker 들을 돌린다
- slot별 relay 연결 성공/실패만 빠르게 판정한다

이 단계는 병렬이어야 한다.

#### 단계 4. 검증 단계

- `CONNECTED` 된 slot만 verification queue에 넣는다
- route owner 전환
- settle
- public IP 확인
- 성공 시 `VERIFIED`

이 단계는 직렬이어야 한다.

## 정확한 구현 원칙

### 원칙 1. `vpncmd` 는 완전 무제한 병렬이 아니라 `역할별 분리`로 간다

지금처럼 전역 단일 queue는 제거한다.

하지만 아무 생각 없이 모든 `vpncmd` 를 완전 무제한 병렬로 풀지도 않는다.

정답은 아래다.

#### A. route/teardown 전용 직렬 CLI

용도:

- route owner switch
- metric 복구
- 전체 disconnect / cleanup

이건 글로벌 상태를 건드리므로 직렬 유지.

#### B. slot provisioning CLI pool

용도:

- `NicCreate`
- `AccountCreate`
- account option 세팅
- `AccountConnect`

특징:

- slot마다 account/nic 이름이 다르므로 병렬 허용
- pool size만 제한한다

#### C. read-only status CLI

용도:

- `AccountList`
- `NicList`
- 필요 시 `AccountStatusGet`

특징:

- 중앙 poller가 주기적으로 1번씩만 읽는다
- slot별 polling을 없앤다

쉽게 말하면:

- 지금은 `모든 명령이 줄 1개`
- 바뀐 뒤에는
  - `전환/정리 줄 1개`
  - `slot 연결 작업자 여러 명`
  - `상태 조회자 1명`

구조다.

### 원칙 2. `waitForAccountConnectedPhase()` 는 hot path에서 제거한다

현재는 slot 하나가 자기 account 연결 상태를 기다리기 위해
반복해서 `AccountList` 를 읽는다.

이 구조는 worker 수가 늘수록 비효율적이다.

바꾼 뒤에는:

- 중앙 status poller가 `AccountList` 를 1초마다 1회 읽는다
- 각 slot worker는 공용 상태 map만 본다
- `CONNECTED`, `CONNECT_FAILED`, `TIMEOUT` 중 하나가 되면 종료

이렇게 간다.

추가로 중요한 점:

현재 agent background monitor는 mutation 중에는 실제 SoftEther 조회를 건너뛴다.

즉 prepare 중 상세 상태 갱신은

- background monitor가 아니라
- 중앙 status poller + worker saveState

가 직접 책임져야 한다.

### 원칙 3. `200 logical slot` 은 무조건 만들고, live capacity는 별도로 둔다

즉 raw feed 후보 `200`개를 받았으면:

- UI slot 번호는 `200`개 모두 만든다
- 다만 실제 NIC가 `126`개면
  - 연결 작업에 바로 들어가는 건 capacity 안쪽 slot
  - 남는 slot은 `CAPACITY_DEFERRED`

상태로 둔다.

이렇게 해야:

- 문서상 `200 slot`
- 실제 화면상 `200 logical slot`
- 로컬 하드 한계도 동시에 표현

이 가능하다.

### 원칙 3-1. `slot 소유 NIC` 에서 `NIC lease` 모델로 바꿔야 한다

현재 코드는 사실상 slot과 nic가 1:1 고정이다.

예시:

- `slot-001 -> VPN3`
- `slot-002 -> VPN4`

하지만 `200 logical slot / physical NIC 126` 구조에서는 이 모델이 유지될 수 없다.

새 구조 예시:

- `slot-001 ~ slot-126` 은 처음부터 NIC lease를 하나씩 잡고 시작
- `slot-127 ~ slot-200` 은 처음에는 NIC가 없다
- 앞쪽 slot이 실패하면 비는 NIC lease를 뒤쪽 deferred slot이 이어받는다

즉 새 구조에서는

- `slotId` 는 논리 좌석
- `nicName` 은 현재 할당된 물리 NIC lease

라는 점을 문서에 명시해야 한다.

초기 패치에서는 아래처럼 가는 게 가장 단순하다.

- item의 `nicName` 은 현재 할당 NIC 의미로 유지
- 필요 시 디버그용으로만 `preferredNicName` 또는 `leaseState` 추가

### 원칙 4. `200 physical NIC` 확장은 실험 플래그로 간다

바로 하드코딩으로 `VPN200` 까지 여는 건 위험하다.

정확한 진행 순서는:

1. 코드상 upper bound를 configurable 하게 바꾼다
2. `NicCreate VPN128 ~ VPN200` survey 를 따로 돌린다
3. 성공한 최종 인덱스를 실제 capacity 로 확정한다

예시:

- `VPN128 ~ VPN152` 성공
- `VPN153` 부터 연속 실패
- 그러면 detected capacity를 `152` 기반으로 잘라서 운영

즉 `200 physical slot` 은 "목표" 이고,
실제 사용 가능한 upper bound는 survey 결과로 결정한다.

### 원칙 4-1. 현재 코드에는 `NIC 삭제` 경로가 없다

현재 코드상 확인된 NIC 관련 동작은 아래뿐이다.

- `NicList`
- `NicCreate`

반대로 `NicDelete` wrapper 나 NIC cleanup 경로는 아직 없다.

즉 `VPN128 ~ VPN200` 실험은 지금 기준으로는

- 생성 가능한 NIC를 점진적으로 늘리는 실험
- 실패하면 자동으로 NIC를 롤백하는 실험

이 아니다.

그래서 실험 단계는 아래처럼 적는 게 안전하다.

1. 기존 NIC 목록을 먼저 읽는다
2. 없는 NIC만 추가 생성한다
3. 성공한 NIC는 capacity 자원으로 계속 재사용한다
4. 정말 NIC 삭제까지 하고 싶으면 그때 별도 cleanup helper를 추가한다

## 실제 패치 설계

### 1. `projects/self_hosted_vpn_agent/lib/softether_cli.mjs`

#### 변경 목표

- 전역 직렬 queue 제거
- queue policy를 역할별로 선택 가능하게 변경
- NIC 후보 upper bound를 외부에서 주입 가능하게 변경

#### 구체 변경

1. `SOFTETHER_MAX_REGULATED_NIC_INDEX` 상수 고정 사용 제거
2. 아래 새 함수 시그니처로 변경

```js
function isSoftEtherNicName(value, options = {})
function buildSoftEtherNicName(index)
function buildSoftEtherNicCandidateList(preferredName = '', options = {})
```

`options.maxNicIndex` 를 받을 수 있게 한다.

3. `SoftEtherCli` 생성자에 새 옵션 추가

```js
{
  serializeCommands: true | false,
}
```

4. `run()` 은 아래 정책으로 변경

- `serializeCommands === true`
  - 기존 queue 유지
- `serializeCommands === false`
  - queue 없이 바로 `execFileAsync`

#### 새 인스턴스 정책

- `routeCli`: `serializeCommands=true`
- `statusCli`: `serializeCommands=false`
- `slotProvisionCliPool`: 각 인스턴스 `serializeCommands=false`

#### 중요한 연결 규칙

지금 agent 전체는 `this.softEtherCli` 단일 인스턴스를 광범위하게 공유한다.

따라서 실제 패치에서는 새 CLI를 만들기만 하면 안 되고,
각 코드 경로가 어떤 CLI를 써야 하는지 같이 바꿔야 한다.

- `refreshState()`, `syncRawRelayCatalogStatuses()`, 중앙 poller: `statusCli`
- route owner 전환 / metric 원복 / disconnect / cleanup: `routeCli`
- NIC warmup / account create / account connect: `slotProvisionCliPool`

이걸 문서에 못 박아야
`새 인스턴스는 만들었는데 실제 호출 대부분은 예전 this.softEtherCli를 계속 쓰는 반쪽 패치`
를 막을 수 있다.

### 2. `projects/self_hosted_vpn_agent/server.mjs`

#### 새 상수

```js
const DEFAULT_RAW_LIVE_POOL_CANDIDATE_LIMIT = 200;
const DEFAULT_RAW_LIVE_POOL_LOGICAL_SLOT_COUNT = 200;
const DEFAULT_RAW_LIVE_POOL_REQUESTED_NIC_COUNT = 200;
const DEFAULT_RAW_LIVE_POOL_NIC_PREPARE_CONCURRENCY = 8;
const DEFAULT_RAW_LIVE_POOL_CONNECT_CONCURRENCY = 24;
const DEFAULT_RAW_LIVE_POOL_STATUS_POLL_INTERVAL_MS = 1000;
const DEFAULT_RAW_LIVE_POOL_VERIFY_CONCURRENCY = 1;
const DEFAULT_RAW_LIVE_POOL_CONNECT_TIMEOUT_MS = 45000;
const DEFAULT_RAW_LIVE_POOL_EXPERIMENTAL_MAX_NIC_INDEX = 200;
```

#### 새 상태 필드

`rawRelayCatalog` 안에 아래 필드를 추가한다.

- `logicalSlotCount`
- `requestedPhysicalNicCount`
- `detectedPhysicalNicCapacity`
- `preparedNicCount`
- `connectAttemptedCount`
- `failedSlotCount`
- `capacityDeferredSlotCount`
- `stage`
  - `FETCHING_FEED`
  - `PREPARING_NICS`
  - `CONNECTING_SLOTS`
  - `VERIFYING_SLOTS`
  - `READY`
- `availableNicNames`
- `preparedNicNames`
- `slotQueue`
  - 디버그용 간단 snapshot만 보관

#### 기존 summary 필드는 compatibility alias로 유지하는 게 낫다

현재 scheduler/popup/agent public state는 이미 아래 필드에 의존한다.

- `provisionableSlotCount`
- `connectedSlotCount`
- `verifiedSlotCount`
- `deadSlotCount`

그래서 첫 패치에서는 새 필드를 추가하더라도 기존 필드를 바로 없애지 않는다.

권장 매핑:

- `provisionableSlotCount = detectedPhysicalNicCapacity`
- `connectedSlotCount = 현재 CONNECTED/VERIFYING/VERIFIED 수`
- `verifiedSlotCount = VERIFIED 수`
- `deadSlotCount = ERROR/DEAD 수`

즉 새 구조를 넣더라도 기존 필드는 호환용 숫자 창구로 계속 채운다.

각 item에는 아래 상태를 추가한다.

- `poolState`
  - `PENDING`
  - `CAPACITY_DEFERRED`
  - `NIC_PREPARING`
  - `NIC_READY`
  - `CONNECTING`
  - `CONNECTED`
  - `VERIFYING`
  - `VERIFIED`
  - `ERROR`
- `connectAttempted`
- `capacityDeferred`

#### 새 helper

1. `buildRawLogicalSlotItems(relayCandidates, logicalSlotCount)`
2. `detectRawLivePoolNicCapacity(options)`
3. `prepareRawLivePoolNics(operationId, options)`
4. `runRawLivePoolConnectPhase(operationId, options)`
5. `startRawLivePoolStatusPoller(operationId, options)`
6. `waitForSlotTerminalState(operationId, slotId, options)`
7. `runRawLivePoolVerifyPhase(operationId, options)`

#### 요청 파싱 경로도 같이 바꿔야 한다

현재 `normalizeRawRelayCatalogPrepareRequest()` 는 아래 3개만 받는다.

- `limit`
- `preferredCountries`
- `preferredPorts`

즉 scheduler가 body에 다른 필드를 더 실어 보내도 지금 agent는 무시한다.

그래서 초기 패치에는 반드시 이 함수부터 확장해야 한다.

추가 대상:

- `logicalSlotCount`
- `requestedPhysicalNicCount`
- `connectConcurrency`
- `nicPrepareConcurrency`
- `verifyConcurrency`
- `experimentalMaxNicIndex`
- `statusPollIntervalMs`
- `connectTimeoutMs`

쉽게 말하면:

- 지금은 `후보 200명만 보내주세요`
- 바뀐 뒤에는 `후보 200명, 논리좌석 200, NIC 목표 200, 연결 작업자 24` 까지 같이 보내는 구조다.

#### 재준비 정책도 명시적으로 정해야 한다

현재 `prepareRawRelayCatalog()` 는 아래 조건이면 기존 catalog를 그대로 반환한다.

- `catalogEnabled === true`
- phase가 `PREPARING / READY / SWITCHING / CONNECTED`
- `rawRelayCatalog.items.length > 0`

즉 지금은 토글 ON 상태에서 다시 prepare를 눌러도 새 빌드를 안 하고 기존 상태를 재사용한다.

이번 패치 첫 단계에서는 이 정책을 단순하게 가져간다.

- **stop -> start 일 때만 새로 200 slot rebuild**
- 토글 ON 상태 재호출은 기존처럼 재사용 유지

이유:

- 범위를 불필요하게 넓히지 않기 위해서
- 먼저 `200 logical slot + true parallel prepare` 구조를 안정화해야 하기 때문

나중에 필요하면 별도 `forceRebuild` 플래그를 추가한다.

#### `executeRawRelayCatalogPrepare()` 변경 후 흐름

```text
captureBaseline
-> fetchOfficialVpnGateRelayCatalog(limit=200)
-> build 200 logical slots
-> detect/prep NICs
-> connect phase (true parallel)
-> verify phase (serial)
-> READY or ERROR
```

#### 가장 중요한 hot path 변경

현재:

- `connectRawRelayCatalogSlot()`
  - `ensureSpecificNic()` 를 여기서 호출

변경 후:

- `prepareRawLivePoolNics()` 에서 NIC를 먼저 만든다
- `connectRawRelayCatalogSlot()` 에서는
  - 이미 준비된 `nicName` 만 사용
  - `NicCreate` 호출 금지

그리고 더 중요한 점:

현재 `ensureSpecificNic()` 는 slot마다

- `NicList`
- 없으면 `NicCreate`
- 다시 `NicList`

를 반복한다.

즉 `NicCreate` 만 바깥으로 옮기는 걸로는 부족하다.

새 warmup helper는 아래처럼 동작해야 한다.

1. NIC 목록 1회 읽기
2. 목표 NIC 집합 계산
3. 없는 NIC만 batch로 생성
4. 결과를 공용 map으로 보관

즉 `ensureSpecificNic()` 반복 호출을 다른 위치로 옮기는 게 아니라,
**배치 NIC 준비 단계로 구조 자체를 바꾸는 것** 이 핵심이다.

즉 `NicCreate VPN15 실패` 같은 문제는
연결 단계가 아니라 NIC 준비 단계 로그로만 보여야 한다.

#### 상태 polling 변경

현재:

- slot마다 `waitForAccountConnectedPhase()`

변경 후:

- 중앙 status poller 1개가 `AccountList` 를 주기적으로 한 번만 읽음
- accountName -> status map 갱신
- 각 slot worker는 이 map을 보고 종결

즉 worker 수를 올려도 `AccountList` 남발이 생기지 않는다.

#### connect phase 정확한 알고리즘

1. logical slot `200` 생성
2. prepared NIC가 `N`개면
   - 앞 `N`개는 connect queue에 즉시 투입
   - 나머지는 `CAPACITY_DEFERRED`
3. connect worker가 slot을 집음
4. 각 slot에 대해:
   - `AccountCreate`
   - account option 세팅
   - `AccountConnect`
   - 중앙 status poller 기준으로 `CONNECTED / FAIL / TIMEOUT`
5. 성공 slot은 NIC를 계속 점유
6. 실패 slot은 NIC lease 반환
7. 반환된 NIC가 있으면 다음 deferred slot 즉시 투입

이렇게 하면:

- physical NIC가 `126`이어도
- 실패 slot이 많을 경우 200 후보를 계속 뒤까지 시도할 수 있다

중요:

- 성공 slot이 `126`개 꽉 차면 이후 slot은 더 못 붙는다
- 이 경우 남은 slot은 `CAPACITY_DEFERRED` 로 유지

즉:

- `200 logical slot` 은 항상 유지
- `200 simultaneous connected` 는 NIC capacity가 허락할 때만 가능

### 3. `features/self-hosted-vpn/api.js`

#### 초기 패치에서는 큰 수정이 필요 없다

현재 `prepareRawRelayCatalog(config, options)` 는 `options.body` 를 그대로 agent에 전달한다.

즉 아래 body를 scheduler가 넘기기만 하면 된다.

```js
{
  limit: 200,
  logicalSlotCount: 200,
  requestedPhysicalNicCount: 200,
  connectConcurrency: 24,
  nicPrepareConcurrency: 8,
  verifyConcurrency: 1,
  experimentalMaxNicIndex: 200,
  statusPollIntervalMs: 1000,
  connectTimeoutMs: 45000,
}
```

따라서 초기 단계에서 핵심 변경점은 `api.js` 가 아니라 **agent request parser** 와 `scheduler.js` 다.

`api.js` 수정이 필요한 경우는 나중에 UI 설정값을 config로 승격시킬 때뿐이다.

### 4. `features/self-hosted-vpn/scheduler.js`

#### 변경 목표

- prepare body 확장
- 새 summary 필드 normalize
- popup에 보낼 상태 shape 확장

#### 구체 변경

1. `start()` 의 raw prepare body를 확장
2. `buildDefaultRawRelayCatalogStatus()` 에 새 summary 필드 추가
3. `normalizeRawRelayCatalogStatus()` 에 새 필드 추가
4. 로그 문구 변경
5. test fixture/body expectation도 같이 갱신

예시:

- 기존: `후보 200 / 슬롯 126 / 연결 0 / 검증 0`
- 변경: `후보 200 / logical 200 / NIC 126 / NIC준비 126 / 연결시도 48 / 연결 21 / 검증 9 / 보류 74`

### 5. `popup/popup.js` / `popup/popup.html`

#### 변경 목표

- 왜 느린지/어디까지 됐는지 사용자가 바로 이해하게 만들기

#### UI 문구 변경

현재 카드 문구는 너무 뭉뚱그려져 있다.

새 메타 문구 예시:

- `후보 200개를 200 logical slot으로 만들고 있습니다.`
- `로컬 NIC 준비 126/126 완료, 현재 24개 연결 시도 중입니다.`
- `연결 성공 17개, 검증 통과 6개입니다.`
- `NIC capacity 때문에 74개 slot은 대기 중입니다.`

#### 목록 렌더링 변경

각 row에 아래 상태를 보여준다.

- `NIC_READY`
- `CONNECTING`
- `CONNECTED`
- `VERIFYING`
- `VERIFIED`
- `CAPACITY_DEFERRED`
- `ERROR`

예시:

- `slot-084 VERIFIED 121.142.148.62:995 exit=1.2.3.4`
- `slot-125 CONNECTING 175.193.219.57:995`
- `slot-173 CAPACITY_DEFERRED NIC capacity wait`

중요:

현재 popup 목록 렌더러는 사실상

- `VERIFIED`
- `isActive`
- `routeOwned`

만 보여준다.

즉 이 필터를 그대로 두면

- `NIC_READY`
- `CONNECTING`
- `CAPACITY_DEFERRED`

는 summary에 숫자만 있고 목록에는 안 보이게 된다.

그래서 첫 패치에서는 적어도 `PREPARING` 동안은 중간 상태 row도 렌더링하도록 필터를 넓혀야 한다.

## 구현 순서

### 1단계. `vpncmd` 역할 분리

먼저 이걸 해야 한다.

이 단계 없이 worker 수만 올리면,

- 느림은 여전하고
- race 위험만 커진다

완료 조건:

- route/cleanup 직렬 CLI 1개
- read-only status CLI 1개
- provisioning CLI pool 동작

### 2단계. NIC warmup 분리

완료 조건:

- `NicCreate` 가 connect hot path 에서 사라짐
- `NicCreate 실패` 는 연결 실패가 아니라 `NIC 준비 실패` 로만 표기

### 3단계. 중앙 status poller 도입

완료 조건:

- `waitForAccountConnectedPhase()` 가 raw live pool connect path 에서 제거됨
- `AccountList` 는 주기적 1회 수집으로 통합

### 4단계. 200 logical slot 도입

완료 조건:

- raw feed 200 -> slot 200
- `logicalSlotCount` summary 표시
- capacity deferred 상태 표시

### 5단계. 실험 NIC 200 확장

완료 조건:

- `VPN128 ~ VPN200` survey 가능
- 감지된 최대 NIC 인덱스를 runtime capacity 로 반영

## 새 테스트/검증 계획

### 단위 테스트

수정 대상:

- `projects/self_hosted_vpn_agent/test_agent.mjs`
- `features/self-hosted-vpn/test_scheduler_api.mjs`

꼭 같이 바꿔야 하는 테스트 포인트:

- `normalizeRawRelayCatalogPrepareRequest()` 가 새 필드를 파싱하는지
- `prepareRawRelayCatalog()` 재호출 시 기존 재사용 정책이 유지되는지
- scheduler가 확장된 body를 보내는지
- public status normalize가 새 summary 필드를 잃지 않는지

### 새 테스트 스크립트 권장

1. `projects/self_hosted_vpn_agent/test_softether_nic_capacity.mjs`
   - `VPN128 ~ VPN200` `NicCreate` survey
2. `projects/self_hosted_vpn_agent/test_raw_live_pool_status_poller.mjs`
   - 중앙 `AccountList` poller 동작 검증
3. `projects/self_hosted_vpn_agent/test_raw_live_pool_connect_queue.mjs`
   - deferred slot 재투입 검증

## 정적 검증 체크리스트

아래 40개를 통과해야 패치 완료로 본다.

1. raw feed `200`일 때 logical slot이 `200` 생성되는가
2. raw feed가 `173`개면 logical slot이 `173`으로 줄어드는가
3. `requestedCandidateCount` 가 유지되는가
4. `logicalSlotCount` 가 summary에 노출되는가
5. `requestedPhysicalNicCount` 가 summary에 노출되는가
6. `detectedPhysicalNicCapacity` 가 summary에 노출되는가
7. `preparedNicCount` 가 summary에 노출되는가
8. `connectAttemptedCount` 가 summary에 노출되는가
9. `capacityDeferredSlotCount` 가 summary에 노출되는가
10. `failedSlotCount` 가 summary에 노출되는가
11. `SoftEtherCli.run()` 이 role별 serialize policy를 지원하는가
12. route 전환 경로는 여전히 직렬인가
13. read-only status poller는 queue를 먹지 않는가
14. provisioning CLI pool은 독립 프로세스로 동작하는가
15. NIC warmup 이후 connect hot path에 `NicCreate` 가 없는가
16. `NicCreate 실패` 가 slot connect failure로 잘못 잡히지 않는가
17. `AccountConnect 실패` 는 NIC lease를 즉시 반환하는가
18. lease 반환 후 deferred slot이 재투입되는가
19. 성공 slot은 NIC를 유지하는가
20. capacity가 꽉 차면 남은 slot은 `CAPACITY_DEFERRED` 인가
21. 중앙 poller 1회가 여러 slot 상태를 동시에 갱신하는가
22. slot별 busy polling이 제거됐는가
23. connect timeout 후 slot이 `ERROR` 로 가는가
24. timeout 후 NIC lease가 반환되는가
25. 연결 성공 후 slot이 `CONNECTED` 로 가는가
26. 검증 시작 시 `VERIFYING` 으로 가는가
27. 검증 성공 후 `VERIFIED` 로 가는가
28. 검증 실패 후 account가 정리되는가
29. 검증 실패 후 NIC lease 처리 정책이 명확한가
30. popup summary가 `후보/slot/NIC/연결/검증/보류` 를 모두 보이는가
31. popup row가 `CAPACITY_DEFERRED` 를 보여주는가
32. scheduler 기본 state와 agent public state shape가 일치하는가
33. background reset state도 새 필드를 포함하는가
34. stop 시 전체 raw live pool teardown이 정상인가
35. stop 후 deferred/connected/verified 상태가 모두 정리되는가
36. owner switch는 verified slot만 허용하는가
37. owner switch 기존 복구 분기는 그대로 사는가
38. `VPN128 ~ VPN200` survey 실패 시 fallback capacity가 정상 계산되는가
39. experimental NIC 확장을 끄면 기존 safe mode로 동작하는가
40. 준비 시간/성공률/usable 수가 popup 로그에서 설명 가능하게 보이는가
41. `normalizeRawRelayCatalogPrepareRequest()` 가 새 필드를 누락 없이 파싱하는가
42. 토글 ON 중 재호출은 기존 catalog 재사용으로 유지되는가
43. stop 후 start 하면 새 `200 logical slot` rebuild가 되는가

## 최종 구현 판단 기준

이번 패치가 성공했다고 보려면 아래 4개가 동시에 만족해야 한다.

1. 시작 직후 `slot-001 ~ slot-024` 정도가 바로 연결 단계에 들어간다
2. `NicCreate` 실패가 더 이상 연결 도중 뒤늦게 섞여 나오지 않는다
3. `AccountList` polling이 slot별 중복 호출이 아니라 중앙 poller 1회로 통합된다
4. 화면에서 `후보 200 / logical 200 / NIC capacity N / usable M` 이 한눈에 이해된다

## 한 줄 결론

이번 단계에서 바로 해야 하는 건 **`worker 수` 를 억지로 올리는 게 아니라** 아래 3개다.

1. `vpncmd 전역 직렬 queue` 제거
2. `NIC warmup` 과 `connect hot path` 분리
3. `200 logical slot + 중앙 status poller + 직렬 verify queue` 구조로 재작성

이렇게 해야 속도도 올라가고, 성공률도 올라가고, `200 slot` 이라는 개념도 실제 운영에서 이해 가능한 형태가 된다.

## 이번 재검토에서 추가로 확인한 구현상 제약

### 1. top-level phase는 그대로 두고 세부 단계는 `rawRelayCatalog.stage` 로 넣어야 한다

현재 scheduler/popup/agent는 top-level phase를 아래 값 위주로 해석한다.

- `PREPARING`
- `READY`
- `SWITCHING`
- `CONNECTED`
- `DISCONNECTING`
- `ERROR`

여기에 새 top-level phase를 함부로 추가하면

- scheduler `normalizePhase()`
- popup 상태 문구
- 버튼 lock 조건

이 전부 어긋난다.

따라서 첫 패치는 이렇게 간다.

- top-level `phase` 는 기존 coarse 상태 유지
- 세부 진행률은 `rawRelayCatalog.stage` 로만 확장

예시:

- top-level: `PREPARING`
- detail stage: `PREPARING_NICS`

### 2. public state -> scheduler -> popup -> persisted state 전 구간을 같이 늘려야 한다

지금 새 필드를 한 군데만 추가하면 바로 사라진다.

함께 수정해야 하는 지점:

1. agent `buildInitialRawRelayCatalogState()`
2. agent `normalizeRawRelayCatalogState()`
3. agent `buildPublicRawRelayCatalogState()`
4. scheduler `buildDefaultRawRelayCatalogStatus()`
5. scheduler `normalizeRawRelayCatalogStatus()`
6. popup `normalizeSelfHostedVpnRawRelayCatalogStatus()`
7. popup 초기 fallback rawRelayCatalog default object
8. `chrome.storage.local` 저장/복원 snapshot

이 중 하나라도 빠지면 새 필드는 저장/복원/렌더 중간에 증발한다.

추가로 item 필드도 같은 규칙을 적용해야 한다.

함께 수정해야 하는 지점:

1. agent `normalizeRawRelayCatalogItem()`
2. scheduler `normalizeRawRelayCatalogItem()`
3. popup `normalizeSelfHostedVpnRawRelayCatalogItem()`

예를 들어 아래 같은 item 필드를 넣는다면:

- `capacityDeferred`
- `leaseState`
- `preferredNicName`
- `connectAttemptedAt`

이 3군데를 같이 안 늘리면 summary는 맞아도 row 단위 정보는 중간에서 증발한다.

쉽게 말하면:

- summary 숫자 경로
- slot row 상세 경로

를 따로 본다고 생각해야 한다.

### 3. activate 조건과 verified 완료 시점은 같이 맞아야 한다

현재 activate는 아래 조건이 동시에 맞아야 통과한다.

- `poolState === VERIFIED`
- `accountStatusKind === CONNECTED`

즉 새 구조에서도 verified 표시는 너무 빨리 올리면 안 된다.

예시:

- route/IP 검증만 끝났는데
- account status map 갱신이 아직 늦어서 `MISSING`

이면 popup에서 눌러도 409가 난다.

그래서 verified 종결 시점은

- slot 자체 검증 성공
- account status도 여전히 `CONNECTED`

가 보장되는 시점으로 맞추는 게 안전하다.

### 4. agent `saveState()` 는 현재 파일 전체를 바로 써서 true parallel과 충돌할 수 있다

현재 agent `saveState()` 는 state file 전체 JSON을 바로 `writeFile()` 한다.

즉 true parallel worker들이 아래처럼 동시에 저장을 치면:

1. worker A가 오래된 snapshot으로 `saveState()`
2. worker B가 더 최신 상태로 `saveState()`
3. 파일 쓰기 완료 순서가 뒤집히면
4. A가 더 늦게 끝나면서 최신 상태를 다시 덮어씀

이 문제가 생길 수 있다.

쉽게 예시로 보면:

- `slot-021 CONNECTED` 까지 반영된 최신 state가 이미 있었는데
- 조금 먼저 떠놓은 `slot-017 CONNECTING` 시점 snapshot이 나중에 디스크에 써지면
- 파일상 상태가 과거로 돌아간다

그래서 첫 패치에는 아래 중 하나를 반드시 넣어야 한다.

1. agent state flush queue를 따로 둬서 파일 저장만 직렬화
2. `scheduleStateFlush()` 같은 coalesced 저장기로 100~300ms 단위 묶음 저장
3. worker/poller는 메모리 state만 갱신하고, 저장은 중앙 progress publisher만 담당

핵심은:

- `vpncmd` 병렬화와
- `state file 저장`

을 같은 직렬화 정책으로 보면 안 된다는 점이다.

### 5. slot 객체 참조를 오래 들고 있으면 stale reference가 된다

현재 코드에는 아래 패턴이 실제로 있다.

1. `const slot = this.findRawRelayCatalogItem({ slotId })`
2. `await ...`
3. 중간 helper가 `this.state.rawRelayCatalog.items = items.map(...)` 로 배열 전체를 새 객체로 교체
4. 이후 로컬 변수 `slot` 을 계속 사용

이 경우 `slot` 은 더 이상 현재 배열 안의 최신 객체가 아니다.

실제 코드 예시:

- `refreshRawRelayCatalogRouteSnapshot()` 은 `items.map(...)` 으로 모든 item을 새 객체로 갈아낀다
- 그런데 `verifyRawRelayCatalogSlot()` 은 그 뒤에도 처음 잡아둔 `slot.routeOwned` 를 바로 읽는다

즉 true parallel 재작성 때는 아래 규칙을 문서 수준에서 고정해야 한다.

1. `await` 를 넘길 때 slot 객체 reference를 장시간 들고 가지 않는다
2. `items.map(...)` 나 `syncRawRelayCatalogStatuses()` 후에는 `slotId` 로 다시 lookup 한다
3. 더 안전하게는 `mutateRawRelayCatalogItem(slotId, updater)` 같은 helper 하나로만 item 갱신

쉽게 말하면:

- `slot 객체를 손에 들고 계속 수정` 하는 방식이 아니라
- `slotId를 들고 다니면서 필요할 때 최신 객체를 다시 찾는 방식`

으로 바꿔야 한다.

### 6. collapse / inactive 경로도 새 필드 기준으로 같이 검토해야 한다

현재 agent와 scheduler에는 둘 다 아래 경로가 있다.

- `shouldCollapseRawRelayCatalogState()`
- `buildInactiveRawRelayCatalogState()` / `buildInactiveRawRelayCatalogStatus()`

현재 이 경로들은 사실상

- 기존 old summary 필드
- `request`
- `logs`

위주로만 판단/보존한다.

즉 새 필드를 넣고도 여기 업데이트를 안 하면 이런 일이 생길 수 있다.

예시:

- `logicalSlotCount=200`
- `detectedPhysicalNicCapacity=126`
- `capacityDeferredSlotCount=74`

까지는 메모리에 있었는데

- toggle OFF
- agent unavailable
- error fallback

같은 경로에서 inactive/collapse가 타면서

- request와 logs만 남고
- 새 summary는 싹 기본값으로 돌아간다

첫 패치에서 의도가

- OFF면 어차피 전부 비워도 된다

라면 여기서 새 필드를 굳이 보존하지 않아도 된다.

반대로 의도가

- 최근 준비 결과를 OFF 직후에도 카드에서 잠깐 보여주고 싶다
- agent unavailable/error 복구 시 마지막 logical/NIC 통계를 유지하고 싶다

라면 아래를 같이 만져야 한다.

1. collapse 조건
2. inactive builder
3. scheduler 쪽 inactive builder

즉 이 부분은 “버그” 라기보다
**새 필드를 OFF/오류 후에도 보여줄지 말지에 대한 정책 결정 지점** 이다.
