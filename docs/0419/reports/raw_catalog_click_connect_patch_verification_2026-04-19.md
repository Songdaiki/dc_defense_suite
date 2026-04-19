# raw catalog click-connect 1차 패치 검증

## 목표

- `자체 VPN 테스트` 토글을 `ON` 하면:
  - official raw feed를 받아 usable relay를 SoftEther offline 계정으로 캐시한다.
  - popup 안에서 raw 릴레이 목록을 바로 본다.
  - 목록의 1개를 클릭하면 그 릴레이만 `Connected` 를 시도한다.
- 아직 하지 않은 범위:
  - 200개를 동시에 다 `Connected` 로 유지하는 병렬 운영 UI
  - route owner를 바꿔가며 실시간 출구 IP를 돌리는 전환 UI

## 원래 문제

- agent/server 쪽은 raw catalog 개념이 일부 들어가 있었지만,
  popup 쪽에는 `rawRelayCatalog` 를 그릴 DOM/렌더러가 없었다.
- background 쪽에는 `activateCatalogRelay` 액션 라우팅이 없어서,
  popup에서 특정 raw 릴레이를 눌러도 실제 연결 요청을 보낼 경로가 없었다.
- scheduler 쪽은 `PREPARING`, `READY` phase를 완전히 이해하지 못해서,
  catalog 모드가 `IDLE/ERROR` 처럼 보이거나 `catalogEnabled` 가 false로 돌아오지 않는 문제가 있었다.

## 이번 패치

### 1. agent API/상태 모델

- `projects/self_hosted_vpn_agent/lib/vpngate_feed.mjs`
  - official raw host feed를 catalog 형태로 정규화하는 함수 추가
- `projects/self_hosted_vpn_agent/lib/softether_cli.mjs`
  - raw catalog 전용 계정 prefix와 계정명 builder 추가
- `projects/self_hosted_vpn_agent/server.mjs`
  - `POST /v1/vpn/catalog/prepare`
  - `POST /v1/vpn/catalog/activate`
  - `rawRelayCatalog` public state
  - `PREPARING`, `READY` phase

예시:

- 전:
  - UI가 `219.100.37.114` 를 보고 있어도 눌러서 연결할 수 없었음
- 후:
  - UI가 `219.100.37.114:443` 행을 보여주고
  - 클릭하면 `/v1/vpn/catalog/activate` 로 relay payload를 보냄

### 2. scheduler 정합성 수정

- `features/self-hosted-vpn/scheduler.js`
  - raw mode `start()` 는 `connectVpn()` 대신 `prepareRawRelayCatalog()` 호출
  - `normalizePhase()` 가 `PREPARING`, `READY` 를 인식
  - `applyAgentStatus()` 가 explicit `catalogEnabled: false` 를 받으면 진짜로 catalog 모드를 해제
  - agent status fetch 실패 시에도 `catalogEnabled`/`PREPARING`/`READY` 상태를 보존
  - raw catalog 준비 중에는 병렬 3슬롯 시작을 막음

예시:

- 전:
  - agent가 `catalogEnabled=false` 를 줘도 scheduler가 예전 `true` 를 계속 들고 갈 수 있었음
- 후:
  - agent가 false를 주면 popup도 바로 `catalog off` 로 내려감

### 3. background 메시지 라우팅

- `background/background.js`
  - `activateCatalogRelay` 메시지 액션 추가
  - `resetStats` 시 `catalogEnabled`/`rawRelayCatalog` 도 함께 초기화

예시:

- popup 클릭
  - 전: background가 이해 못함
  - 후: `scheduler.activateCatalogRelay(relay)` 호출

### 4. popup UI

- `popup/popup.html`
  - raw 릴레이 목록 카드 추가
- `popup/popup.css`
  - 목록 카드/행/버튼 스타일 추가
- `popup/popup.js`
  - raw catalog DOM 바인딩
  - 목록 상태/카운트/메타/행 렌더링
  - 각 행 `연결` 버튼 클릭 이벤트
  - `PREPARING`, `READY` 상태 라벨/색상 반영
  - log merge 대상에 `rawRelayCatalog.logs` 포함

예시:

- 전:
  - 토글 ON 후에도 popup에는 `최근 오류`, `정지`, `수동 raw 입력칸` 위주만 보임
- 후:
  - `목록 상태=준비 중/준비 완료`
  - `usable/source = 57 / 200`
  - `121.142.148.62:995 / KR / VPN2 / 연결 버튼`

## 호출 플로우 검증

1. popup toggle `ON`
   - `sendFeatureMessage('selfHostedVpn', { action: 'start' })`
2. background
   - `scheduler.start()`
3. scheduler raw mode
   - `prepareRawRelayCatalogRequest(this.config)`
4. agent server
   - `/v1/vpn/catalog/prepare`
   - official feed fetch
   - usable relay 선정
   - SoftEther offline 계정 캐시
   - `phase=READY`, `catalogEnabled=true`, `rawRelayCatalog.items=[...]`
5. popup polling
   - `refreshStatusFromAgent()`
   - 목록 렌더링
6. popup list row click
   - `sendFeatureMessage('selfHostedVpn', { action: 'activateCatalogRelay', relay })`
7. background
   - `scheduler.activateCatalogRelay(relay)`
8. scheduler
   - `activateCatalogRelayRequest(this.config, relay)`
9. agent server
   - `/v1/vpn/catalog/activate`
   - 해당 cached account만 `Connected` 시도
10. popup refresh
   - `phase=CONNECTING/CONNECTED`
   - active relay / adapter / public IP 반영

## 정적 검증 포인트

- `PREPARING -> READY` 가 popup 상태 라벨에 반영됨
- `READY` 상태에서도 toggle은 `ON` 으로 유지됨
- raw catalog 준비 완료 후 config 입력은 잠겨서 catalog 중간 변경을 막음
- `CONNECTED` 상태에서 다른 row를 다시 누르면 scheduler가 거부함
- `parallelProbe` 실행 중에는 raw row 클릭 연결을 막음
- `resetStats` 하면 raw catalog 목록/카운트/로그도 같이 비워짐
- `AGENT_UNAVAILABLE` 시 버튼은 막히고 최근 오류 문구가 남음
- log panel에는 single logs + raw catalog logs + parallel probe logs가 같이 보임

## 2차 교차검증에서 추가로 발견해 수정한 문제

### 문제 1. catalog usable 개수가 limit 이후를 반영하지 못하던 문제

- 증상
  - `buildRelayCatalog()` 가 relay를 모으다가 `limit` 에 도달하면 바로 루프를 멈추고 있었다.
  - 그래서 `usableRelayCount` 가 "전체 usable 개수"가 아니라 "지금 잘라서 보여주는 개수"가 될 수 있었다.
- 왜 문제인가
  - 문서상 의미는
    - `sourceHostCount = snapshot 전체 host 수`
    - `usableRelayCount = snapshot 전체 usable relay 수`
    인데,
  - 실제 값은 `limit=50` 이면 usable도 최대 50처럼 보일 수 있었다.
- 수정
  - 전체 candidate를 먼저 만든 다음 정렬하고,
  - `usableRelayCount` 는 전체 candidate 길이로 계산하고,
  - 마지막에만 `slice(0, limit)` 하도록 바꿨다.
- 결과
  - popup 카드의 `usable/source` 가 문서 의미와 실제 값이 맞아졌다.

쉽게 예시:

- host 전체 200개
- usable 전체 143개
- 화면에는 상위 50개만 보여주고 싶음
- 수정 전: `usable=50`
- 수정 후: `usable=143`, `items.length=50`

### 문제 2. agent-owned raw account가 이미 여러 개 살아 있는 비정상 상태를 prepare/activate가 충분히 막지 못하던 문제

- 증상
  - `prepareRawRelayCatalog()` 와 `activateCatalogRelay()` 는 foreign account는 막았지만,
    이미 살아 있는 `DCDSVPNGATE-*` / `DCDSVPNRAWCACHE-*` agent 계정이 여러 개인 상황을 강하게 차단하지 못했다.
- 왜 문제인가
  - 문서상 전제는 "단일 연결 기준 catalog 준비/선택 연결" 인데,
  - 실제 SoftEther 쪽에 agent-owned 연결이 여러 개 살아 있으면
    다음 prepare/activate가 꼬인 상태 위에서 실행될 수 있었다.
- 수정
  - 두 경로 모두 `findConflictingManagedBusyAccounts()` 로 agent-owned active account를 먼저 검사하고,
  - 남아 있으면 409로 차단하도록 바꿨다.
- 결과
  - 비정상 상태를 무시하고 새 prepare/connect를 얹는 경로를 닫았다.

쉽게 예시:

- 이미 `DCDSVPNRAWCACHE-relay-1-443` Connected
- 또 `DCDSVPNGATE-relay-2-443-abc` Connected
- 이 상태에서 새 catalog prepare/activate 요청
- 수정 전: 일부 경로에서 그냥 진행 가능
- 수정 후: `agent 관리용 SoftEther 연결이 이미 살아 있습니다` 로 즉시 차단

### 문제 3. catalog prepare 요청이 agent에 수락되기 전에 실패해도 toggle이 계속 ON처럼 남을 수 있던 문제

- 증상
  - scheduler `start()` 에서 raw catalog prepare 요청이 네트워크 오류/timeout 등으로 즉시 실패하면
    `preserveRunning: true` 경로 때문에 `catalogEnabled/isRunning` 이 계속 살아남을 수 있었다.
- 왜 문제인가
  - 실제로는 agent가 prepare를 시작하지도 못했는데,
  - popup 입장에서는 toggle이 계속 켜진 듯 보이고 설정 잠금도 남을 수 있다.
- 수정
  - raw catalog prepare request failure / rejected 는
    - `catalogEnabled=false`
    - `isRunning=false`
    - `rawRelayCatalog.phase=ERROR`
    로 정리하도록 바꿨다.

쉽게 예시:

- agent 꺼져 있음
- toggle ON
- 수정 전: 최근 오류가 나도 ON처럼 남을 수 있음
- 수정 후: `ERROR + 정지` 로 남고 다시 설정 수정/재시도가 가능

### 문제 4. row 클릭 연결 요청이 agent에 수락되기 전에 실패하면 READY catalog가 ERROR처럼 뭉개질 수 있던 문제

- 증상
  - popup에서 특정 row를 눌렀는데 agent 요청 자체가 실패하면,
    기존 catalog는 살아 있는데 phase가 바로 `ERROR` 쪽으로 몰릴 수 있었다.
- 왜 문제인가
  - 의미상으로는
    - catalog는 그대로 READY
    - 방금 클릭한 connect 요청만 실패
    가 맞다.
- 수정
  - 클릭 연결 request failure / rejected 는
    - `phase=READY`
    - `catalogEnabled=true`
    - `isRunning=true`
    - active item clear
    - recent error 유지
    로 되돌리도록 바꿨다.
  - popup 상태 라벨도 `READY + lastError` 면 `준비 완료 (최근 오류)` 로 보이게 맞췄다.

쉽게 예시:

- 목록 50개는 이미 준비 완료
- `121.142.148.62:995` 클릭
- agent timeout
- 수정 전: 전체 상태가 그냥 `ERROR` 처럼 보여 catalog 자체가 죽은 것처럼 보일 수 있음
- 수정 후: `준비 완료 (최근 오류)` 로 남아서 다른 row 재시도나 새로고침이 가능

## 엣지케이스 정리

1. local agent URL 비어 있음
2. local agent URL 형식 오류
3. auth token 있음
4. auth token 없음
5. raw mode 아님
6. raw mode인데 toggle ON
7. raw mode인데 목록 아직 없음
8. 목록 준비 중 재클릭
9. READY 상태 재토글 ON
10. READY 상태에서 row 클릭
11. CONNECTING 상태에서 다른 row 클릭
12. CONNECTED 상태에서 다른 row 클릭
13. DISCONNECTING 상태에서 row 클릭
14. parallel probe 실행 중 row 클릭
15. parallel probe 실행 중 toggle ON
16. background blocking feature 존재
17. catalog prepare HTTP timeout
18. catalog activate HTTP timeout
19. agent health만 되고 status 실패
20. health/status 다 실패
21. status는 오는데 egress 실패
22. catalogEnabled=false explicit 반환
23. rawRelayCatalog 누락된 오래된 응답
24. usableRelayCount=0
25. sourceHostCount>0, usable=0
26. accountStatusKind=MISSING
27. accountStatusKind=DISCONNECTED
28. active item 있음
29. active item + CONNECTED
30. active item + CONNECTING
31. relay id는 있으나 fqdn 없음
32. ip만 있고 fqdn 없음
33. fqdn만 있고 ip 없음
34. sslPorts 배열 비어 있음
35. udpPort 없음
36. `limit < usable 전체 개수` 일 때 usable count 왜곡
37. agent-owned raw 계정이 2개 이상 active 인 비정상 상태
38. prepare request 즉시 실패 후 toggle/lock 잔류
39. row connect request 즉시 실패 후 READY catalog 의미 손실

## 문서-코드 대응표

- 문서 `토글 ON = catalog 준비`
  - 코드: `features/self-hosted-vpn/scheduler.js` 의 `start()`
  - raw mode일 때 `prepareRawRelayCatalogRequest(this.config)` 호출
- 문서 `row 클릭 = 특정 relay 연결`
  - 코드: `popup/popup.js` 의 catalog click handler
  - background `activateCatalogRelay`
  - scheduler `activateCatalogRelay(relay)`
  - agent `/v1/vpn/catalog/activate`
- 문서 `source/usable 표시`
  - 코드: `projects/self_hosted_vpn_agent/lib/vpngate_feed.mjs` 의 `buildRelayCatalog()`
- 문서 `비정상 다중 agent account 차단`
  - 코드: `projects/self_hosted_vpn_agent/server.mjs`
  - `prepareRawRelayCatalog()`
  - `activateCatalogRelay()`
  - `findConflictingManagedBusyAccounts()`

## 3차 라인별 재검증

이번 턴에서는 "함수가 호출된다" 수준이 아니라,

- 어떤 입력값이 다음 단계로 넘어가는지
- 어느 단계에서 phase / catalogEnabled / isRunning / activeRelay 값이 바뀌는지
- 실패 시 어떤 값이 유지되고 어떤 값이 비워지는지

를 실제 코드 줄 기준으로 다시 확인했다.

### 1. 토글 ON -> catalog READY 경로

- `popup/popup.js:1041-1064`
  - 토글 ON이면 `sendFeatureMessage('selfHostedVpn', { action: 'start' })` 를 보낸다.
  - 저장 안 된 설정이 있으면 여기서 먼저 차단한다.
- `background/background.js:535-588`
  - `selfHostedVpn` 전용 start block 검사 후 `scheduler.start()` 를 호출한다.
  - 즉 popup이 바로 agent를 때리는 구조가 아니라 background를 거쳐 직렬화된다.
- `features/self-hosted-vpn/scheduler.js:117-144`
  - raw mode면 시작 즉시
    - `isRunning = true`
    - `phase = PREPARING`
    - `catalogEnabled = true`
    - `rawRelayCatalog.phase = PREPARING`
    로 먼저 잡는다.
  - 즉 아직 agent 응답이 없어도 popup은 "목록 준비 중"으로 보일 수 있는 구조다.
- `features/self-hosted-vpn/scheduler.js:146-171`
  - prepare 요청이 아예 전송되기 전에 실패하면
    - `catalogEnabled = false`
    - `isRunning = false`
    - `rawRelayCatalog.phase = ERROR`
    로 정리한 뒤 `handleActionFailure()` 로 마무리한다.
  - 예시:
    - agent가 꺼져 있을 때 토글 ON
    - 예전에는 ON처럼 남을 수 있었지만
    - 지금은 `ERROR + 정지` 로 끝난다.
- `projects/self_hosted_vpn_agent/server.mjs:303-389`
  - agent는 prepare 시작 전에
    - 병렬 probe 중인지
    - 이미 연결 중인지
    - foreign account가 살아 있는지
    - agent 관리 account가 여러 개 살아 있는지
    를 먼저 확인한다.
  - 이 preflight를 통과해야만 `catalogEnabled = true`, `phase = PREPARING` 상태로 들어간다.
- `projects/self_hosted_vpn_agent/server.mjs:827-918`
  - agent 실제 prepare 단계에서
    - NIC 확보
    - official DAT fetch
    - relay item 계산
    - stale raw cache account 정리
    - relay별 offline account provision
    - 최종 `phase = READY`
    - `usableRelayCount`, `sourceHostCount`, `items` 기록
    까지 한 번에 끝낸다.
  - 여기서 READY가 된 뒤에만 popup row 연결이 가능하다.
- `features/self-hosted-vpn/scheduler.js:528-660`
  - scheduler는 agent status를 받을 때
    - explicit `catalogEnabled`
    - `phase`
    - `rawRelayCatalog`
    - active relay 정보
    를 그대로 반영한다.
  - 특히 `catalogEnabled: false` 를 agent가 주면 옛값을 붙잡지 않는다.
- `popup/popup.js:2844-2899`, `3684-3754`, `4145-4204`
  - READY면 popup이
    - 상단 상태를 `목록 준비 완료`
    - catalog count를 `usable / source`
    - 각 row를 `연결` 버튼으로 렌더한다.

정리 예시:

- 전파 순서:
  - toggle ON
  - background start
  - scheduler PREPARING 저장
  - agent prepare
  - agent READY 응답
  - scheduler/applyAgentStatus
  - popup READY 렌더

### 2. row 클릭 -> CONNECTING / CONNECTED 경로

- `popup/popup.js:1129-1170`
  - popup은 현재 catalog에서 `relayId` 로 item을 다시 찾고,
    못 찾으면 오래된 화면으로 보고 재새로고침을 요구한다.
  - 즉 버튼 dataset만 믿지 않고 현재 상태를 다시 대조한다.
- `background/background.js:681-708`
  - `activateCatalogRelay` 는 `selfHostedVpn` 에서만 허용된다.
  - start와 동일한 block message도 다시 확인한다.
- `features/self-hosted-vpn/scheduler.js:317-383`
  - scheduler는 row 클릭 시
    - `config.selectedRelayId`
    - `config.selectedSslPort`
    - `config.relaySnapshot`
    를 클릭한 row 값으로 덮어쓴다.
  - 이어서
    - `phase = CONNECTING`
    - `catalogEnabled = true`
    - `activeRelay*` 필드 세팅
    - `rawRelayCatalog.items[].isActive` 표시
    를 먼저 저장한다.
  - 즉 popup이 "어느 row를 눌렀는지"는 agent 응답 전에도 알 수 있다.
- `features/self-hosted-vpn/scheduler.js:385-447`
  - agent 요청이 전송되기 전에 실패하거나 거절되면
    - `phase = READY`
    - `catalogEnabled = true`
    - active relay / adapter / connectedAt 초기화
    - active item clear
    - 최근 오류만 유지
    로 되돌린다.
  - 예시:
    - 목록은 살아 있는데 방금 누른 1개만 timeout
    - popup은 `준비 완료 (최근 오류)` 로 남고 다른 row 재시도가 가능하다.
- `projects/self_hosted_vpn_agent/server.mjs:392-481`
  - agent는 activate 전에
    - parallel probe 실행 중인지
    - 현재 PREPARING / CONNECTING / DISCONNECTING / CONNECTED 인지
    - catalog가 실제로 준비됐는지
    - 클릭한 relay가 현재 catalog에 존재하는지
    - foreign / conflicting managed account가 살아 있는지
    를 전부 다시 확인한다.
  - 여기서 popup이 잘못된 row를 보내거나 stale row를 보내도 최종 방어가 한 번 더 있다.
- `projects/self_hosted_vpn_agent/server.mjs:976-1029`
  - agent 실제 connect 단계는
    - NIC 확보
    - 필요한 경우 account 재provision
    - baseline 캡처
    - `connectAccount`
    - SoftEther Connected 대기
    - connected context 적용
    - catalog active item 갱신
    순서다.
  - 즉 "클릭 -> 바로 IP 변경"이 아니라,
    먼저 SoftEther 세션이 `Connected` 가 되어야 네트워크 차이를 계산한다.
- `projects/self_hosted_vpn_agent/server.mjs:1894-1946`
  - refresh 단계에서 tracked account를 다시 읽어
    - `CONNECTED` 면 connected 상태 업데이트
    - `CONNECTING` 면 phase 유지
    - `DISCONNECTED` 면 실패 처리 또는 READY/IDLE 복귀
    한다.
  - 그래서 connectAccount 직후와 popup 반영 사이의 비동기 gap도 상태기로 흡수한다.

쉽게 예시:

- `121.142.148.62:995` row 클릭
- scheduler가 먼저 "이 row 선택됨" 저장
- agent가 SoftEther account connect
- 실제로 account가 Connected가 되면
  - phase = CONNECTED
  - active relay = `121.142.148.62:995`
  - adapter / public IP diff 갱신
- 실패하면 catalog는 남기고 오류만 남긴다

### 3. refresh / 복원 / UI 잠금 경로

- `features/self-hosted-vpn/scheduler.js:494-580`
  - 상태 새로고침은 health/status/egress/parallel status를 `Promise.allSettled` 로 모은다.
  - status만 실패해도 health/egress 결과로 agentReachable 판단을 보완한다.
  - `catalogEnabled` 상태일 때 agent 일시 불능이면 `keepRunning` 을 유지해 catalog 의미를 날리지 않는다.
- `features/self-hosted-vpn/scheduler.js:711-839`
  - 저장/복원 snapshot에
    - `catalogEnabled`
    - `rawRelayCatalog`
    - `parallelProbe`
    - `activeRelay*`
    - `lastError*`
    가 모두 포함된다.
  - 그래서 popup 재오픈이나 service worker 재기동 뒤에도 catalog 맥락을 복원할 수 있다.
- `popup/popup.js:2838-2925`
  - popup 렌더는 `latestSelfHostedVpnStatus` 전체를 기준으로
    - 상단 상태
    - relay 정보
    - adapter
    - route/DNS 변화
    - catalog meta / list
    를 한 번에 다시 그린다.
  - config 잠금은 `nextStatus.isRunning || parallelProbe.isRunning` 기준이라
    catalog 준비 중간 수정도 막는다.
- `popup/popup.js:4145-4204`
  - row 버튼 잠금은
    - parallel probe 실행
    - PREPARING/CONNECTING/DISCONNECTING
    - raw mode 아님
    - agent unavailable
    에서 막힌다.
  - 반대로 `ERROR + catalog alive` 상태에서는 다시 누를 수 있게 열어둔다.

예시:

- row 하나 실패해서 상단이 주황색 오류처럼 보이더라도
- catalog item이 남아 있고 agent가 살아 있으면
- 버튼은 다시 눌릴 수 있다.

### 4. stop / disconnect / catalog 유지/해제 경로

- `features/self-hosted-vpn/scheduler.js:216-269`
  - stop은 현재 phase와 관계없이 agent `disconnect` 요청을 보낸다.
  - disconnect 요청 자체가 실패하면 이전 phase/isRunning 값을 복구한다.
  - 요청 후 agent가 끊겨도 마지막에 강제로 정지 상태 정리를 한 번 더 한다.
- `projects/self_hosted_vpn_agent/server.mjs:2126-2138`
  - disconnect cleanup에서
    - catalogEnabled=true 이면 `transitionToCatalogReady()`
    - 아니면 `transitionToIdle()`
    로 간다.
  - 즉 raw catalog 모드에서 1개 연결을 끊으면
    목록 전체를 다시 fetch하지 않고 READY로 복귀하는 설계다.
- `projects/self_hosted_vpn_agent/server.mjs:2234-2260`
  - `transitionToCatalogReady()` 는
    - phase READY
    - catalogEnabled true
    - active relay / adapter / connectedAt / route / DNS / publicIpAfter 초기화
    - active item clear
    로 정리한다.
  - 이 값들이 비워져야 popup이 "방금 연결했던 행"을 계속 connected처럼 잘못 그리지 않는다.
- `projects/self_hosted_vpn_agent/server.mjs:2205-2232`
  - 완전 idle로 내려갈 때만 `catalogEnabled = false` 로 바꾼다.
  - 그래서 OFF는 catalog 해제, connect 후 disconnect는 READY 복귀라는 의미 차이가 유지된다.

## 호출자/피호출자 정합성 추가 결론

- popup은 relay id를 현재 catalog에서 다시 찾고 보낸다.
- background는 selfHostedVpn 전용 액션만 통과시킨다.
- scheduler는 UI 임시 상태를 먼저 저장하고 agent 수락 여부에 따라 READY/ERROR를 정리한다.
- agent는 실제 SoftEther 상태를 다시 조회해 popup이 놓친 race condition을 최종 교정한다.
- refresh는 저장된 snapshot과 실제 agent 상태를 다시 맞춰준다.

즉 이번 패치 경로는 "한 군데만 맞는 구조"가 아니라,

- popup 방어
- background 라우팅
- scheduler 상태기
- agent preflight
- SoftEther 재조회

가 계단식으로 들어가 있어서 한 단계 stale/misclick가 나도 다음 단계에서 한 번 더 교정된다.

## 실행 결과

- `node --check features/self-hosted-vpn/scheduler.js`
- `node --check popup/popup.js`
- `node --check background/background.js`
- `node --check projects/self_hosted_vpn_agent/server.mjs`
- `node features/self-hosted-vpn/test_scheduler_api.mjs`
  - `27개 api/scheduler test 통과`
- `node projects/self_hosted_vpn_agent/test_agent.mjs`
  - `99개 self-test 통과`
- 참고
  - 두 테스트 실행 중 `MODULE_TYPELESS_PACKAGE_JSON` 경고가 1회 보였음
  - 이는 Node가 ESM으로 재해석하면서 내는 성능 경고이고, 현재 패치의 기능 오류는 아님

## 결론

- 1차 목표인 `토글 ON -> raw 목록 준비 -> popup 목록 표시 -> 1개 클릭 연결` 까지는 코드 경로가 연결되었다.
- 이번 3차 재검증에서는 수정된 함수 앞뒤 호출부까지 다시 따라가며
  - 변수 전파
  - phase 전이
  - catalog 유지/해제
  - 실패 복구
  - UI 잠금
  을 줄 단위로 대조했다.
- 이번 재검증 범위 안에서는 새로 발견된 코드 레벨 불일치는 없었다.
- 지금 단계에서 UI가 해야 할 일은:
  - 목록을 보여주고
  - 원하는 row를 눌러 1개 Connected 시도하고
  - 연결 후 public IP / adapter / route 변화를 보여주는 것
- 다음 단계는 이 기반 위에:
  - bulk pre-register
  - 병렬 Connected 유지
  - route owner 전환
  - 성공률 survey/report
  를 확장하면 된다.
