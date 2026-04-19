# 병렬 3슬롯 probe 패치 정적 검증 보고서

> 작성일: 2026-04-19  
> 범위: `selfHostedVpn` single-flow 유지 + `parallel-probe` 별도 계약 추가  
> 목적: 실제 패치 후 변수 연결, 호출선, 상태 직렬화, 엣지 케이스를 다시 훑고 남은 구조 리스크가 있는지 확인한다.

## 1. 이번 패치에서 실제로 바뀐 곳

- scheduler:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js)
- background message router:
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js)
- popup UI:
  - [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html)
  - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js)
- local agent:
  - [projects/self_hosted_vpn_agent/server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs)
  - [projects/self_hosted_vpn_agent/lib/network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs)
  - [projects/self_hosted_vpn_agent/lib/vpngate_feed.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/vpngate_feed.mjs)

## 2. 구문/테스트 결과

실행 명령:

```bash
node --check features/self-hosted-vpn/scheduler.js
node --check background/background.js
node --check popup/popup.js
node --check features/self-hosted-vpn/api.js
node --check projects/self_hosted_vpn_agent/server.mjs
node --check projects/self_hosted_vpn_agent/lib/vpngate_feed.mjs
node features/self-hosted-vpn/test_scheduler_api.mjs
node projects/self_hosted_vpn_agent/test_agent.mjs
```

결과:

- `features/self-hosted-vpn/test_scheduler_api.mjs`
  - `21개` 통과
- `projects/self_hosted_vpn_agent/test_agent.mjs`
  - `91개` 통과
- 추가 syntax check:
  - 전부 통과

## 3. 라인바이라인 확인 포인트

### 3-1. single-flow와 parallel-probe를 물리적으로 분리했는가

- `single`:
  - `/v1/vpn/connect`
  - `/v1/vpn/status`
- `parallel`:
  - `/v1/vpn/parallel-probe/start`
  - `/v1/vpn/parallel-probe/status`
  - `/v1/vpn/parallel-probe/stop`

예시:

- 예전 위험:
  - single `state.accountName` 하나에 3개 slot을 억지로 우겨 넣음
- 지금:
  - agent `state.parallelProbe` 로 분리
  - scheduler `parallelProbe` 로 분리
  - popup도 별도 버튼/별도 상태칸으로 분리

### 3-2. single connect와 parallel start가 서로 동시에 올라가지 않는가

- scheduler:
  - single start 전에 `parallelProbe.isRunning` 차단
  - parallel start 전에 `phase in CONNECTING/CONNECTED/DISCONNECTING` 차단
- agent:
  - single `connect()` 전에 `parallelProbe` active 차단
  - parallel start 전에 single `phase` active 차단

### 3-3. 설정 잠금이 UI/background 양쪽에서 같이 먹는가

- popup:
  - single 또는 parallel 실행 중 config input 잠금
- background:
  - `updateConfig`
  - `resetStats`
  - 둘 다 `parallelProbe` active 시 차단

## 4. 엣지 케이스 정적 검증 37개

1. single VPN이 `CONNECTING` 인데 parallel start를 누르면 차단되는가
2. single VPN이 `CONNECTED` 인데 parallel start를 누르면 차단되는가
3. single VPN이 `DISCONNECTING` 인데 parallel start를 누르면 차단되는가
4. parallel probe가 `PREPARING` 인데 single start를 누르면 차단되는가
5. parallel probe가 `CONNECTING` 인데 single start를 누르면 차단되는가
6. parallel probe가 `VERIFYING` 인데 single start를 누르면 차단되는가
7. parallel probe가 `COMPLETE` 로 살아 있는 동안 single start를 누르면 차단되는가
8. popup에서 dirty config 상태로 parallel start를 누르면 먼저 저장하라고 막는가
9. local agent 주소만 잘못됐을 때 parallel start가 profile/raw 필수값 검사 때문에 잘못 막히지 않는가
10. single-flow `profileId` 미입력 상태여도 parallel probe 자체는 시작 가능한가
11. background polling timeout이 설정값보다 3000ms로 잘리지 않는가
12. `parallel-probe/status` 만 응답해도 scheduler state 직렬화가 깨지지 않는가
13. extension reload 후 `chrome.storage.local` 에서 `parallelProbe` 가 복원되는가
14. old state 파일에 `parallelProbe` 가 없어도 load 시 기본값으로 복원되는가
15. `resetStats` 가 parallel 실행 중에는 차단되는가
16. `resetStats` 후 `parallelProbe` 가 IDLE 기본값으로 초기화되는가
17. popup DOM id와 JS selector 이름이 실제로 일치하는가
18. popup action 이름과 background switch case 이름이 실제로 일치하는가
19. API wrapper path와 local agent endpoint path가 실제로 일치하는가
20. agent start 응답이 `accepted + public state` 로 나가고 scheduler가 그 형태를 그대로 먹는가
21. agent stop 응답이 `accepted + public state` 로 나가고 scheduler가 그 형태를 그대로 먹는가
22. parallel probe internal field `operationId` 가 public status에 노출되지 않는가
23. slot relay 정보가 UI까지 내려갈 때 `id/ip/fqdn/selectedSslPort` 가 보존되는가
24. slot NIC 기본값이 `VPN2/VPN3/VPN4` 순서로 고정되는가
25. slot NIC 이름이 중복 입력돼도 normalize 단계에서 dedupe 되는가
26. probe account prefix가 single managed account prefix와 분리돼 있는가
27. single cleanup helper가 probe account를 잘못 삭제하지 않는가
28. probe cleanup helper가 single managed account를 잘못 삭제하지 않는가
29. metric restore 정보가 baseline rows로 따로 저장되는가
30. route owner 판정 키를 `InterfaceAlias` 문자열이 아니라 `interfaceIndex` 중심으로 잡는가
31. `VPN2` 가 `VPN20` 을 잘못 매칭하는 느슨한 문자열 비교를 피했는가
32. route owner 전환 검증이 fresh IPv4 probe로 새 소켓을 열어 확인하는가
33. probe 종료 시 metric restore -> account cleanup 순서가 유지되는가
34. probe 실패 시 slot/request/log가 통째로 날아가지 않고 원인 추적 정보가 남는가
35. `stop` 직후 늦게 끝난 slot connect/verify 비동기가 idle/error 상태를 다시 덮어쓰지 않는가
36. official DAT fetch가 멈췄을 때 병렬 probe 시작이 무기한 대기하지 않고 timeout으로 표면화되는가
37. SoftEther Manager에 수동/외부 account가 이미 살아 있을 때 병렬 probe가 route 검증을 섞지 않도록 시작 전에 차단되는가

## 5. 이번 검증에서 별도 보정한 항목

### 5-1. parallel start가 single validation을 잘못 타는 문제

원래 위험:

- scheduler의 `startParallelProbe()` 가 `getConfigValidationMessage()` 를 그대로 호출하면
  - `profileId` 없음
  - `raw host` 없음
  - 같은 single-flow validation 때문에 병렬 probe 시작 자체가 막힐 수 있었다

보정:

- parallel start는 `agentBaseUrl` 만 직접 검증하도록 수정했다

쉽게 예시로 말하면:

- 병렬 probe는 agent가 raw feed를 직접 가져오는데
- 예전 코드면 popup raw 입력칸이 비어 있다는 이유로 시작도 못 하는 구조였다
- 지금은 그 경로를 분리했다

### 5-2. `VPN2` 와 `VPN20` 오인 가능성

원래 위험:

- slot interface 탐색에서 `includes("VPN2")` 같은 느슨한 비교는
  - `VPN20 - VPN Client`
  - `VPN21 - VPN Client`
  - 같은 다른 어댑터를 잘못 집을 수 있었다

보정:

- exact / prefix 중심 비교로 조였다

### 5-3. 병렬 stop 도중 늦게 끝난 비동기 결과가 상태를 다시 덮어쓰는 문제

원래 위험:

- `connectParallelProbeSlot()` / `verifyParallelProbeSlot()` 는 여러 `await` 사이를 지나간다
- 그 사이 사용자가 `병렬 시험 종료` 를 누르면
  - stop 쪽은 `parallelProbe` 를 idle 쪽으로 재구성하고
  - 늦게 끝난 기존 async 가 다시 `routeOwnerSlotId`, `lastVerifiedPublicIp`, 성공 로그를 써버릴 수 있었다

쉽게 예시로 말하면:

- 사용자가 `정지` 를 눌러서 실제로는 정리 중인데
- 1.5초 뒤 늦게 돌아온 verify가
- `slot-2 출구 IPv4 확인 - ...` 같은 로그와 값을 다시 써버리면
- UI가 "방금 정지했는데 왜 또 검증 성공이 찍히지?" 상태가 될 수 있었다

보정:

- `operationId` 가 아직 유효한지
- `phase` 가 STOPPING 으로 바뀌지 않았는지
- 를 `route owner 적용 후`, `route settle 대기 후`, `route snapshot 저장 전`, `public IP 반영 전`
- 단계마다 다시 확인하도록 막았다

### 5-4. official DAT fetch 무기한 대기 가능성

원래 위험:

- official DAT feed fetch가 timeout 없이 걸려 있어서
- 네트워크가 먹통이거나 서버 응답이 지연되면
- `병렬 3슬롯 시작` 이 오래 멈춘 것처럼 보일 수 있었다

보정:

- official DAT fetch에 `15000ms` timeout을 추가했다
- abort가 나면 `official DAT fetch timeout (15000ms)` 로 명시적으로 표면화되게 했다

### 5-5. 기존 SoftEther 수동 연결이 살아 있는데 병렬 probe가 같이 시작되는 문제

원래 위험:

- single connect는 이미 `foreign busy account` 를 막고 있었는데
- parallel probe start는 그 검사를 하지 않아
- SoftEther Manager에서 수동 연결이 붙어 있는 상태에서도 probe가 시작될 수 있었다

쉽게 예시로 말하면:

- 사용자가 Manager에서 `VPN Gate Connection` 을 이미 연결해 둔 상태
- 그 위에서 병렬 probe 3개를 또 올리면
- route owner 판정은 사실 기존 수동 연결 영향까지 섞여서
- "어느 slot이 진짜 출구를 잡았는지" 해석이 틀어질 수 있었다

보정:

- parallel probe start도 single connect와 같은 기준으로
  - `foreign busy account`
  - `conflicting managed account`
  - 둘 다 시작 전에 차단하도록 맞췄다

## 6. 남은 비차단 리스크

- 실제 Windows route 수렴 시간은 PC마다 다르므로 `1500ms` settle 값은 추후 실측 튜닝 여지가 있다
- official feed relay 품질이 들쭉날쭉하므로 `3개 모두 CONNECTED` 는 코드가 아니라 외부 릴레이 품질에도 좌우된다
- popup 로그는 single 로그와 parallel 로그를 한 박스에 합쳐 보여 주므로, 시간순 가독성은 추후 별도 패널로 더 다듬을 수 있다

## 7. 결론

현재 패치는 아래 기준에서는 blocking issue 없이 진행 가능한 상태로 판단했다.

- single-flow 계약 유지
- parallel-probe 별도 계약 분리
- UI/background/agent endpoint 이름 일치
- storage 직렬화/복원 포함
- metric switch helper 포함
- 최소 self-test 통과

즉 "문서만 있는 설계" 단계는 넘겼고,  
이제 남은 검증은 **실제 Windows/SoftEther 환경에서 raw 최신 feed 3개를 붙여 보는 런타임 실험** 쪽이다.
