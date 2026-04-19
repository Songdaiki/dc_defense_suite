# 0419 VPNGate Raw Catalog Click Connect Plan

## 목표

이번 단계 목표는 아래 4가지를 한 흐름으로 묶는 것이다.

1. `selfHostedVpn` 토글을 `ON` 하면
2. official raw feed 기준 릴레이 목록을 받아
3. SoftEther 계정으로 `Offline` 상태까지 미리 적재하고
4. popup 목록에서 하나를 클릭하면 그 계정만 `Connected` 시도 후 UI에 반영

쉽게 예시로 보면:

- 토글 `ON`
- `219.100.37.12:443`, `219.100.37.188:443`, `121.138.132.127:1698` 같은 raw 릴레이가 SoftEther 계정으로 미리 생성됨
- Manager에는 전부 `Offline`
- 특궁 popup 목록에도 전부 보임
- 사용자가 `219.100.37.188:443` 클릭
- 그 계정만 `AccountConnect`
- 성공하면 popup 상태 카드가 해당 릴레이 기준으로 바뀜

## 현재 실제 코드 기준 동작

### 1. popup은 아직 `relay 1개 수동 입력` 구조다

- `popup/popup.html`
  - `raw relay ID`
  - `raw relay FQDN`
  - `raw relay IP`
  - `raw SSL 포트`
  입력칸만 있다.
- `popup/popup.js`
  - `bindSelfHostedVpnEvents()` 에서 토글 `ON` 은 무조건 `action: 'start'` 를 보낸다.
  - 설정 저장도 `selectedRelayId + relaySnapshot + selectedSslPort` 단일 값만 보낸다.

즉 현재 popup은

- raw 릴레이 목록을 읽지 못하고
- 사용자가 1개를 직접 입력해야 하고
- 클릭 가능한 catalog UI 자체가 없다.

### 2. background는 `start / stop / refresh / updateConfig` 정도만 안다

- `background/background.js`
  - `start`
  - `stop`
  - `refreshStatus`
  - `startParallelProbe`
  - `stopParallelProbe`
  - `updateConfig`
  만 `selfHostedVpn` 전용으로 처리한다.

즉 현재는

- `catalog 준비`
- `catalog 항목 클릭 연결`
- `catalog 새로동기화`

같은 별도 액션이 없다.

### 3. scheduler는 지금 `단일 연결 상태기계`다

- `features/self-hosted-vpn/scheduler.js`
  - phase는 `IDLE / CONNECTING / CONNECTED / DISCONNECTING / AGENT_UNAVAILABLE / ERROR`
  - `start()` 는 결국 `connectVpn(this.config)` 로 간다.
  - `applyAgentStatus()` 는 agent status를 받아 `phase` 와 `activeRelay*` 를 덮는다.

즉 현재 토글 `ON` 의미는

- “목록 준비”
가 아니라
- “바로 연결 시작”

이다.

### 4. local agent는 raw 1개 연결 엔진은 이미 있다

- `projects/self_hosted_vpn_agent/server.mjs`
  - `connect()` 에서 `normalizeConnectRequest(payload)` 후
  - `connectProfile()` 또는 `connectRawRelay()` 로 분기한다.
  - `connectRawRelay()` 는
    - raw relay 정보 1개를 받아
    - managed account를 만들고
    - `AccountConnect`
    - `CONNECTED` 대기
    - route / public IP refresh
    를 한다.

즉 “raw 엔진” 자체가 없는 게 아니다.

없는 것은 아래 둘이다.

1. raw feed 전체를 `catalog` 로 들고 있는 상태
2. raw `catalog account` 를 재사용하는 클릭 연결 흐름

### 5. parallel probe는 이 목표와 다르다

- `parallelProbe` 는 3개를 병렬 Connected 후 route owner와 출구 IP를 검증하는 별도 상태다.
- `popup` 도 `parallelProbe` 를 별도 카드처럼 그린다.

즉 이번 작업은 `parallelProbe` 확장이 아니라,

- `selfHostedVpn` 단일 카드 안에
- `raw catalog 준비 + 선택 연결`

을 넣는 일이다.

## 이번 단계에서 실제로 바꿀 구조

## A. phase를 `PREPARING`, `READY` 까지 넓힌다

기존 phase:

- `IDLE`
- `CONNECTING`
- `CONNECTED`
- `DISCONNECTING`
- `AGENT_UNAVAILABLE`
- `ERROR`

추가 phase:

- `PREPARING`
- `READY`

의미는 아래처럼 잡는다.

- `PREPARING`
  - raw feed를 받아 SoftEther offline cache 계정을 만드는 중
- `READY`
  - 목록은 준비됐고 아직 실제 터널은 안 붙은 상태

쉽게 예시:

- 토글 `ON` 직후: `PREPARING`
- 계정 168개 생성 끝: `READY`
- 목록 클릭 후 연결 시작: `CONNECTING`
- 실제 연결 완료: `CONNECTED`

이걸 넣어야 하는 이유는 간단하다.

- 토글이 켜졌는데도 phase가 `IDLE` 이면 popup이 계속 `정지`로 보인다.
- 지금 사용자가 원하는 건 “연결 중은 아니지만 준비는 된 상태”다.

## B. agent state에 `rawRelayCatalog` 를 넣는다

새 state 블록:

- `catalogEnabled`
- `rawRelayCatalog`

`rawRelayCatalog` 안에는 최소 아래가 필요하다.

- `phase`
- `startedAt`
- `completedAt`
- `lastErrorCode`
- `lastErrorMessage`
- `sourceHostCount`
- `usableRelayCount`
- `items`

`items[]` 각 항목은 최소 아래를 가진다.

- `id`
- `ip`
- `fqdn`
- `countryShort`
- `countryFull`
- `selectedSslPort`
- `sslPorts`
- `udpPort`
- `hostUniqueKey`
- `score`
- `verifyDate`
- `accountName`
- `accountStatusKind`
- `accountStatusText`
- `nicName`
- `isActive`

쉽게 예시 item:

```json
{
  "id": "18786933",
  "ip": "121.138.132.127",
  "fqdn": "vpn204414021.opengw.net",
  "countryShort": "KR",
  "selectedSslPort": 1698,
  "sslPorts": [1698, 995, 443],
  "accountName": "DCDSVPNRAWCACHE-18786933-1698",
  "accountStatusKind": "DISCONNECTED",
  "nicName": "VPN2",
  "isActive": false
}
```

## C. raw feed fetch는 `top 3` 가 아니라 `usable snapshot` 전체로 바꾼다

현재 `lib/vpngate_feed.mjs` 의 `fetchOfficialVpnGateRelays()` 는

- 기본적으로 상위 후보를 정렬해서
- 제한 개수만 돌려준다.

catalog 용은 다르다.

- official DAT snapshot 기준 전체 host 수
- 그중 연결 가능한 usable raw relay 수
- usable relay 목록

을 따로 받아야 한다.

그래서 feed 쪽은 아래 식으로 확장한다.

- `fetchOfficialVpnGateRelayCatalog()`

반환 예:

```json
{
  "totalHosts": 200,
  "usableRelayCount": 168,
  "relays": [...]
}
```

여기서 `200` 은 raw snapshot 전체 행 수,
`168` 은 실제 `IP + selectedSslPort` 가 있어 SoftEther 계정화 가능한 수다.

## D. SoftEther 계정은 새 `cache prefix` 로 따로 만든다

현재 raw 단일 연결은 `MANAGED_ACCOUNT_PREFIX` 기반 임시 계정을 만들어 붙이고, disconnect 후 삭제한다.

catalog는 반대로 가야 한다.

- 계정 이름은 안정적이어야 하고
- disconnect 후에도 남아 있어야 하고
- `Offline` 캐시처럼 재사용해야 한다.

그래서 새 prefix를 분리한다.

예:

- `DCDSVPNRAWCACHE-18786933-1698`
- `DCDSVPNRAWCACHE-219-100-37-188-443`

이 prefix를 쓰면 아래를 분리할 수 있다.

- 기존 단발성 managed raw 계정
- catalog cached raw 계정
- parallel probe 계정

## E. 토글 ON은 `prepare catalog` 로 바꾼다

이번 단계에서 raw mode의 토글 `ON` 의미는:

- “바로 연결”
가 아니라
- “catalog 준비 시작”

이다.

실제 흐름:

1. popup toggle `ON`
2. scheduler.start()
3. raw mode면 `connectVpn()` 대신 `prepareRawRelayCatalog()`
4. agent가 background로 DAT fetch + SoftEther offline account sync
5. 완료 후 phase `READY`

profile mode는 기존처럼 유지한다.

즉:

- `connectionMode=profile` 이면 기존 start/connect 그대로
- `connectionMode=softether_vpngate_raw` 이면 start=prepare catalog

## F. 클릭 연결은 별도 action으로 뺀다

이 부분이 중요하다.

기존 방식대로 하면 클릭 시

1. `updateConfig`
2. `start`

두 단계를 거쳐야 한다.

그런데 scheduler/background는 실행 중 config 변경을 막는다.
그래서 클릭 연결은 별도 action으로 빼는 게 안전하다.

이번 단계의 권장 action:

- background message: `activateCatalogRelay`
- scheduler method: `activateCatalogRelay(relay)`
- agent endpoint: `POST /v1/vpn/catalog/activate`

이 action은

- relay catalog item 1개를 받아
- 해당 cache account를 찾고
- `AccountConnect`
- 성공 시 `CONNECTED`
- 실패 시 `ERROR`

로 간다.

## G. 첫 단계에서는 `cache account 재사용`을 기본으로 한다

클릭 연결 시 새 계정을 만들지 않는다.

흐름:

1. catalog item 선택
2. item.accountName 확인
3. 계정이 있으면 그대로 connect
4. 없거나 손상됐으면 그 계정만 다시 생성 후 connect

이렇게 해야

- Manager에서 `Offline -> Connected`
- 사용자 눈으로 추적 가능
- 어떤 raw 값이 어떤 SoftEther 계정인지 매핑이 고정

된다.

## H. disconnect 후에는 `IDLE` 이 아니라 `READY` 로 돌아가야 한다

raw catalog를 켜둔 상태에서 릴레이 하나를 연결했다가 끊으면,

사용자 기대는 보통 이렇다.

- 목록은 그대로 남아 있고
- 다른 릴레이를 다시 고를 수 있어야 한다.

그래서 raw catalog enabled 상태에서 disconnect cleanup 후에는

- `phase = READY`

로 복귀해야 한다.

반대로 토글 `OFF` 를 누르면

- `catalogEnabled = false`
- `phase = IDLE`

로 내려간다.

## 실제 패치 범위

## 1. agent

파일:

- `projects/self_hosted_vpn_agent/server.mjs`
- `projects/self_hosted_vpn_agent/lib/vpngate_feed.mjs`
- `projects/self_hosted_vpn_agent/lib/softether_cli.mjs`

추가/수정:

- `PREPARING`, `READY` phase
- `rawRelayCatalog` state
- cache account prefix / name builder / detector
- official raw catalog fetch helper
- `prepareRawRelayCatalog()`
- `executeRawRelayCatalogPrepare()`
- `activateCatalogRelay()`
- catalog item status refresh helper
- `/v1/vpn/catalog/prepare`
- `/v1/vpn/catalog/activate`
- `/v1/vpn/status` 응답에 `rawRelayCatalog`

## 2. scheduler/api/background

파일:

- `features/self-hosted-vpn/api.js`
- `features/self-hosted-vpn/scheduler.js`
- `background/background.js`

추가/수정:

- API helper
  - `prepareRawRelayCatalog`
  - `activateCatalogRelay`
- scheduler
  - raw mode `start()` 를 catalog prepare로 분기
  - `activateCatalogRelay()` 추가
  - status snapshot / load / getStatus 에 `rawRelayCatalog`
  - `READY`, `PREPARING` 상태 처리
- background
  - 새 action 분기 추가
  - selfHostedVpn config lock와 충돌하지 않게 catalog click action 별도 처리

## 3. popup

파일:

- `popup/popup.html`
- `popup/popup.js`
- `popup/popup.css`

추가/수정:

- raw relay catalog 섹션 추가
- 각 item에
  - host
  - country
  - ssl port
  - account status
  - connect button
  표시
- status 기본값에 `rawRelayCatalog`
- `updateSelfHostedVpnUI()` 에 목록 렌더링 추가
- 클릭 시 `activateCatalogRelay`
- `PREPARING`, `READY` 라벨 추가

## 정적 검증 포인트

이번 패치에서 특히 놓치면 안 되는 부분은 아래다.

1. `popup buildDefaultSelfHostedVpnStatus()`
   - 기본값에 `rawRelayCatalog` 없으면 popup reopen 시 목록이 깨진다.
2. `scheduler buildStateSnapshot() / loadState() / getStatus()`
   - 셋 중 하나라도 빠지면 저장/복원/응답이 어긋난다.
3. `background resetStats(feature === selfHostedVpn)`
   - 새 상태 초기화 누락 시 이전 catalog가 유령처럼 남을 수 있다.
4. `agent refreshState()`
   - 계정이 없다고 무조건 `IDLE` 로 내려가면 `READY` 가 사라진다.
5. `disconnect cleanup`
   - raw catalog enabled 인데 `transitionToIdle()` 로 바로 가면 toggle ON 의미가 깨진다.
6. `cache account prefix 분리`
   - 임시 managed raw 계정과 catalog cache 계정을 같은 prefix로 섞으면 stale cleanup가 cache를 지워버릴 수 있다.
7. `click action은 updateConfig와 분리`
   - running 중 config lock 때문에 목록 클릭이 막히는 문제를 피해야 한다.

## 이번 단계 구현 완료 기준

이번 단계는 아래가 되면 성공이다.

1. popup에서 `connectionMode=SoftEther VPNGate raw`
2. toggle `ON`
3. status가 `PREPARING -> READY`
4. SoftEther Manager에 raw snapshot usable relay 계정이 `Offline` 으로 다수 생김
5. popup 목록에도 같은 릴레이들이 보임
6. 목록 클릭
7. 해당 계정만 `Connected` 시도
8. 성공 시 popup 상태 카드에
   - 활성 릴레이
   - SSL 포트
   - 활성 어댑터
   - 연결 후 IP
   가 반영됨

## 이번 단계에서 일부러 미루는 것

이번 단계에서는 아래를 필수 범위에서 뺀다.

- 여러 Connected 계정 사이 자동 route switch
- 클릭 한 번으로 기존 연결을 끊고 다른 릴레이로 seamless handoff
- country 필터 / 정렬 / 검색 UI
- stale relay 자동 재검증 배치

즉 이번 단계는

- `catalog 준비`
- `목록 표시`
- `offline cached account 재사용 연결`

여기까지를 first milestone으로 본다.
