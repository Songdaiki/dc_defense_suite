# VPNGate raw 1개 릴레이 연결용 SoftEther 오픈소스 재사용 구현 스펙

> 작성일: 2026-04-19  
> 목적: `특궁에서 클릭 -> local agent -> VPNGate raw 1개 릴레이 연결 -> 실제 출구 IP 변경 확인` 흐름을, **지금 바로 구현 시작 가능한 수준**으로 문서화한다.  
> 교차검증 기준:
- 현재 저장소의 VPNGate raw 복호/표시 코드
- 현재 저장소의 `selfHostedVpn` local agent 계약
- 공식 SoftEther 오픈소스 스냅샷 `SoftEtherVPN_Stable` commit `ed17437af9719ac66acab30faa29e375d613c35f`
- 실제 릴레이 성공/실패 캡처 문서

## 1. 한 줄 결론

지금 상태에서 **오픈소스 재사용 방식으로는 진행 가능**하다.

2026-04-19 현재 실제 패치 반영 기준으로는, 첫 런타임은 아래 경로에 들어갔다.

- local agent 구현:
  - [projects/self_hosted_vpn_agent/server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs)
- SoftEther CLI 래퍼:
  - [projects/self_hosted_vpn_agent/lib/softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs)
- 네트워크 상태 관찰:
  - [projects/self_hosted_vpn_agent/lib/network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs)
- 자체 정적 검사:
  - [projects/self_hosted_vpn_agent/test_agent.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/test_agent.mjs)

이번 패치는 문서의 7-2에 가까운 **`vpncmd.exe` 기반 local agent** 다.
즉 최종 추천인 RPC 래퍼보다 한 단계 아래지만, 현재 저장소와 사용자 로컬 환경에서 **실제로 바로 띄워서 extension과 붙일 수 있는 형태** 로 먼저 들어갔다.

추가로 이번 실제 패치에서는 파생 충돌을 줄이기 위해 정책을 하나 더 고정했다.

- 기존 수동 SoftEther 계정과 분리하려고 관리용 NIC 기본값을 `VPN2` 로 둔다
- SoftEther Windows NIC 이름은 `VPN`, `VPN2` ... `VPN127` 형식만 허용하므로 `DCDSVPN` 같은 이름은 쓰지 않는다
- 수동 계정이 이미 `Connected/Connecting` 상태면 raw connect를 `409` 로 거부한다

쉽게 예시로 말하면:

- 기존 사용자가 Manager에서 `VPN Gate Connection` 을 수동 연결 중
- agent가 그걸 멋대로 끊고 덮어쓰지 않는다
- 대신 `먼저 수동 연결을 끊으세요` 라고 거부한다

다만 이번 재검증으로, 아래 전제를 만족할 때만 "바로 패치 시작 가능"하다고 정리하는 게 맞다.

- 첫 MVP 목표는 `TCP only` 다. 즉 설계상 `PortUDP = 0`, `NoUdpAcceleration = true` 로 둔다. 단, 이 문서는 목표 스펙이고 현재 저장소는 아직 이 두 입력을 실제로 surface하지 않았다.
- `DeviceName = VPN` 을 서버 스펙처럼 고정하지 말고, 로컬 어댑터 선점 상태를 먼저 본다.
- temp account는 매 연결마다 새로 만들고, 정리는 `Disconnect -> inactive 확인 -> DeleteAccount` 순서로 한다.
- headless agent는 `CheckServerCert = false`, `ProxyType = PROXY_DIRECT` 를 명시한다.
- SoftEther 기본 GUI 편의값인 `NumRetry = INFINITE` 를 그대로 복사하지 말고, agent 정책값으로 관리한다.

단, 추천 경로는 이거다.

- `특궁 UI -> background -> local agent -> SoftEther Client RPC/계정 생성 -> 로컬 가상 어댑터 -> 공용 릴레이`

반대로 이 경로는 지금 바로 들어가면 위험하다.

- `특궁 UI -> SoftEther 프로토콜 clean-room 직접 구현 -> 자체 가상 어댑터/라우팅 엔진`

쉽게 예시로 말하면:

- 가능한 것:
  - raw 한 줄에서 `121.138.132.127:1698` 를 뽑음
  - local agent가 SoftEther 계정을 임시 생성
  - `VPNGATE` 허브에 익명 접속
  - 연결되면 내 공인 IP가 릴레이 쪽 출구 IP로 바뀜
- 아직 비추천인 것:
  - SoftEther의 TLS/Hello/Login/추가 세션/가상 어댑터/라우팅까지 전부 새로 짜는 것

즉 결론은 이겁니다.

**"오픈소스라서 가능하냐?"에 대한 답은 `예`다. 다만 `SoftEther 코어/클라이언트 계층을 재사용하되, 연결 정책은 우리 agent가 더 보수적으로 다시 잡아야 한다`가 정확한 표현이다.**

## 1-1. 2026-04-19 실제 구현/검증 결과 요약

이번 turn에서 문서와 실제 구현을 다시 맞춰 보면서, 아래 2가지를 분리해서 확정했다.

- 코드 계약 이슈:
  - 해결됨
- 현재 PC 환경 이슈:
  - 1개 남아 있음

### 코드 계약 이슈는 이렇게 정리됐다

- `connect/disconnect` 는 이제 **즉시 `accepted` 를 반환하고**, 실제 SoftEther 작업은 백그라운드에서 돈다.
- `status/egress` 는 이제 **캐시 우선** 으로 응답해서 extension timeout 계약을 맞춘다.
- raw connect 실패 후 state에 이름만 남아도, `disconnect` 가 현재 `AccountList` 와 대조해서 **없는 account면 바로 idle 정리** 한다.
- 연결 자체는 성공했는데 route/public IP 관측만 실패한 경우, 그걸 무조건 "연결 실패"로 치지 않도록 fallback 경로를 넣었다.

쉽게 예시로 말하면:

- 예전:
  - `status` 누를 때마다 로컬 route/DNS/public IP 측정을 다 기다림
  - popup/background timeout과 충돌할 수 있었음
- 지금:
  - 일단 마지막 상태를 바로 반환
  - 느린 관측은 백그라운드에서 갱신

### 실측값은 이렇게 나왔다

- `GET /v1/vpn/status`
  - 기존 약 `2.3s`
  - 수정 후 약 `0.45s`
- `GET /v1/vpn/egress`
  - 기존 약 `2.3s`
  - 수정 후 약 `0.45s`
- `POST /v1/vpn/connect` with missing profile
  - 약 `0.69s`
- `POST /v1/vpn/disconnect` when stale/missing managed account
  - 즉시 idle 정리 확인

즉 extension 쪽 기본 설정과 비교하면:

- `requestTimeoutMs = 800`
- `background` 안전 상한 = `1200ms`

현재 `status/egress` 는 이 범위 안으로 들어왔다.

### 현재 PC 환경 검증 결과는 이렇게 정리된다

이번 재검증으로 환경 blocker는 해소됐다. 초기 실패 원인은 설치 불량이 아니라 아래 2개였다.

- SoftEther Windows NIC 이름 규칙 오해
  - `DCDSVPN` 은 불가
  - `VPN2` 는 정상 생성/사용 가능
- local agent 내부 버그
  - account 생성 전 monitor가 먼저 돌면서 `CONNECTING -> IDLE` 로 되돌리는 레이스
  - `vpncmd /CMD` 를 한 문자열로 넘겨 `AccountCreate` 자체를 못 알아먹는 호출 방식

실제 성공 케이스:

- raw relay:
  - IP `219.100.37.114`
  - FQDN `public-vpn-142.opengw.net`
  - SSL port `443`
- local agent connect:
  - `POST /v1/vpn/connect`
  - phase `CONNECTED`
  - account `DCDSVPNGATE-raw-test-21910037114-443-443-...`
  - adapter `VPN2`
- 실제 공인 IP:
  - 연결 전 `1.210.3.152`
  - 연결 후 `219.100.37.240`
  - disconnect 후 다시 `1.210.3.152`

쉽게 예시로 말하면:

- 예전 실패:
  - 버튼 클릭
  - agent가 너무 빨리 상태를 초기화하거나 `AccountCreate` 명령을 잘못 보냄
  - 터널 생성 단계까지 못 감
- 지금 성공:
  - 버튼 클릭
  - agent가 `VPN2` 에 temp account 생성
  - `219.100.37.114:443` 로 세션 수립
  - 약 10초 내 외부 IP가 `219.100.37.240` 으로 바뀜

즉 지금 남은 이슈는 "raw 1개 자동 연결이 되느냐"가 아니라, 이후 extension UI에 어떤 진행 상태와 지연 안내를 어떻게 보여줄지 쪽이다.

### 1-2. 최신 official 200 feed 순차 probe 결과와 UI 불일치 이유

2026-04-19 재실행 기준으로, [projects/self_hosted_vpn_agent/probe_latest_vpngate_relays.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/probe_latest_vpngate_relays.mjs) 는 아래 순서로 다시 검증됐다.

- official DAT fetch:
  - `xd.x1.client.api.vpngate2.jp/api/?session_id=...`
  - host 수 `200`
- 후보 1:
  - `121.142.148.62:995`
  - 성공
  - 공인 IP `1.210.3.152 -> 112.172.66.106`
  - cleanup 후 다시 `1.210.3.152`
- 후보 2:
  - `218.148.38.123:995`
  - 실패
  - 예전처럼 즉시 `Error code 37` 로 끊지 않고, `15초 동안 Connecting 유지` 후 timeout
  - 즉 이 후보는 "아예 붙지 않은 것"으로 봐도 된다
- 후보 3:
  - `59.8.22.212:995`
  - 성공
  - 공인 IP `1.210.3.152 -> 220.124.206.43`
  - cleanup 후 다시 `1.210.3.152`

쉽게 예시로 말하면:

- 지금 probe는 `릴레이 A 연결 -> 출구 IP 바뀜 확인 -> 원복 -> 릴레이 B 시도` 순서다
- 즉 고정 sleep만 두고 다음 후보로 넘기는 스크립트가 아니라, 실제 연결/복구 여부를 보고 다음 후보로 넘어간다

또 하나 중요한 점은, 이 probe가 곧바로 특궁 UI를 바꾸는 것은 아니라는 점이다.

- probe 스크립트는 `Node -> vpncmd.exe` 직통이다
- 특궁 UI는 SoftEther Manager 목록을 직접 읽지 않는다
- 실제 UI는 [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js) 의 `/v1/vpn/status`, `/v1/vpn/egress` 와 [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js) 의 `applyAgentStatus()` 결과만 본다

즉 Manager에 `VPNLATEST-*` 행이 보여도 popup이 그대로라면 이상한 게 아니다.

- Manager:
  - SoftEther 실제 계정/세션 표시
- 특궁 popup:
  - local agent가 반환한 상태 표시

그래서 popup까지 같이 움직이게 하려면 다음 단계는 이 둘 중 하나다.

- `probe_latest...` 를 local agent HTTP 경유로 바꾸기
- 혹은 local agent가 `VPNLATEST-*` 같은 out-of-band 계정도 관찰해서 상태에 반영하게 만들기

### 1-3. 2026-04-19 추가 교차검증: popup 오류 원인과 agent 경로 성공 케이스

이번 재검증에서 popup의 반복 오류도 원인이 분리됐다.

- popup의 `local agent 요청 실패 - Failed to fetch`
  - 원인: `http://127.0.0.1:8765` server 미기동
- popup이 SoftEther Manager 행을 직접 따라가지 않음
  - 원인: popup은 local agent `/v1/vpn/status`, `/v1/vpn/egress` 결과만 본다
- agent 경로의 raw connect가 느리게 보이는 이유
  - 원인: 이 PC 환경에 SoftEther 어댑터가 많이 남아 있어서 baseline/state 반영과 계정 전환이 수십 초까지 늘어날 수 있음

이번 turn에서 추가로 반영한 보정은 아래 3개다.

- idle 상태에서 popup 일반 새로고침만 했을 때는, agent 미기동이어도 `AGENT_UNAVAILABLE` 를 매번 크게 띄우지 않게 완화
- local agent가 실제 SoftEther 명령 체인을 수행 중일 때, 외부 status polling이 중간에 `listAccounts/listNics` 를 계속 끼워 넣지 않게 완화
- latest feed 시험 스크립트에 `--via-agent` 와 더 긴 `agent connect/idle timeout` 을 추가

그리고 agent 경로에서도 실제 성공 케이스를 다시 확보했다.

- latest feed relay:
  - `59.8.22.212:995`
  - FQDN `vpn270057496.opengw.net`
- local agent status:
  - `CONNECTING -> CONNECTED -> DISCONNECTING -> IDLE`
- 실제 공인 IP:
  - 연결 전 `1.210.3.152`
  - 연결 중 `220.124.206.43`
  - 정리 후 다시 `1.210.3.152`
- SoftEther AccountList:
  - 연결 중 `DCDSVPNGATE-manual-agent-59-8-22-212-995-... , Connected`
  - 정리 후 관리용 account 삭제 완료

쉽게 예시로 말하면:

- 예전:
  - popup은 계속 `Failed to fetch`
  - direct CLI는 붙어도 popup은 그대로
- 지금:
  - server만 켜 두면 popup은 agent status를 받을 수 있음
  - latest raw relay 1개는 agent 경로에서도 실제 IP 변경까지 확인됨

## 2. 이번에 실제로 다시 대조한 대상

현재 저장소 쪽:

- 공식 DAT 복호/런타임:
  - [features/vpngate-prefix/dat-decode.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/vpngate-prefix/dat-decode.js)
  - [features/vpngate-prefix/runtime.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/vpngate-prefix/runtime.js)
- 현재 local agent 계약:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js)
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js)
  - [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html:1647)
  - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1016)
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:1540)

이미 확보된 분석 문서:

- [docs/0418/vpngate_official_200_feed_documentation.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0418/vpngate_official_200_feed_documentation.md)
- [docs/0419/vpngate_single_relay_failure_218_148_38_123.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/vpngate_single_relay_failure_218_148_38_123.md)
- [docs/0419/vpngate_single_relay_success_121_138_132_127.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/vpngate_single_relay_success_121_138_132_127.md)

공식 SoftEther 오픈소스 스냅샷:

- local clone: `/tmp/SoftEtherVPN_Stable`
- inspected commit: `ed17437af9719ac66acab30faa29e375d613c35f`

## 3. 지금 확정된 사실

### 3-1. 공식 VPN Gate Client는 목록을 주기적으로 갱신한다

공식 경고 문구에서 이미 이렇게 적혀 있다.

- [warning_en.txt](/tmp/SoftEtherVPN_Stable/src/bin/hamcore/warning_en.txt:128)

핵심 뜻:

- VPN Gate Client plug-in이 있으면 인터넷상의 현재 릴레이 목록을 받아올 수 있다
- 그 목록은 주기적으로 최신 상태를 유지한다

이건 우리 쪽 관찰과도 맞는다.

- 현재 저장소의 runtime은 `xd.x1.client.api.vpngate2.jp/api/?session_id=...` 를 호출한다:
  - [features/vpngate-prefix/runtime.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/vpngate-prefix/runtime.js:9)

### 3-2. 공용 릴레이는 `VPNGATE` 허브 + `VPN` 사용자 + 익명 접속 모델이다

강한 근거는 3개다.

- 공식 경고 문구:
  - [warning_en.txt](/tmp/SoftEtherVPN_Stable/src/bin/hamcore/warning_en.txt:99)
- 허브 상수:
  - [VG.h](/tmp/SoftEtherVPN_Stable/src/Cedar/VG.h:108)
- 실제 Manager 실패 캡처 문서:
  - [vpngate_single_relay_failure_218_148_38_123.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/vpngate_single_relay_failure_218_148_38_123.md)

이 문장들의 의미는 단순하지 않다.

- 허브 이름은 `VPNGATE`
- 기본 공개 사용자 이름은 `VPN`
- 그 사용자는 anonymous 접속을 허용한다

쉽게 예시로 말하면:

- 서버 건물 이름 = `VPNGATE`
- 출입문 기본 계정 = `VPN`
- 비밀번호 없는 출입 방식 = anonymous

### 3-3. raw feed의 `IP + SslPorts` 는 실제 연결 대상이다

이건 이미 캡처로 확인됐다.

실패 케이스:

- raw: `218.148.38.123`, `SslPorts = "465 995 1195 1487 9008"`
- 실제 공식 클라이언트: `218.148.38.123:995`
- 문서:
  - [vpngate_single_relay_failure_218_148_38_123.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/vpngate_single_relay_failure_218_148_38_123.md)

성공 케이스:

- raw: `121.138.132.127`, `SslPorts = "1698"`
- 실제 공식 클라이언트: `121.138.132.127:1698`
- 문서:
  - [vpngate_single_relay_success_121_138_132_127.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/vpngate_single_relay_success_121_138_132_127.md)

즉 raw 한 줄은 그냥 보기용 데이터가 아니다.

- `IP` 는 실제 접속 주소
- `SslPorts` 는 실제 후보 포트

### 3-4. SoftEther core에는 "클라이언트 계정 -> 세션 -> 연결 -> 로그인 패킷" 경로가 그대로 있다

이건 이번 문서의 핵심이다.

VPN Gate 전용 `src/VGate` 가 비어 있어도, **실제 연결 엔진은 Cedar core 쪽에 살아 있다.**

## 4. 공식 SoftEther 실제 연결 로직 맵

아래는 이번에 실제로 다시 연 순서다.

| 단계 | 실제 위치 | 의미 |
| --- | --- | --- |
| 목록 갱신 설명 | [warning_en.txt](/tmp/SoftEtherVPN_Stable/src/bin/hamcore/warning_en.txt:128) | VPN Gate Client가 릴레이 목록을 주기 갱신한다 |
| 허브 상수 | [VG.h](/tmp/SoftEtherVPN_Stable/src/Cedar/VG.h:108) | 공개 릴레이 허브 이름은 `VPNGATE` |
| 기본 계정 생성 | [PcAccountCreate](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:4217) | `Hostname`, `Port`, `HubName`, `DeviceName`, `Username`, `AuthType=ANONYMOUS` 로 계정을 만든다 |
| 익명 인증 강제 | [PcAccountAnonymousSet](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:4625) | 이미 만든 계정도 anonymous 로 바꿀 수 있다 |
| connect RPC 구조 | [RPC_CLIENT_CREATE_ACCOUNT](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.h:337) | account payload 안에 `ClientOption` / `ClientAuth` 전체가 들어간다 |
| RPC option 필드 | [InRpcClientOption / OutRpcClientOption](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:4601) | `PortUDP`, `NoUdpAcceleration`, `HostUniqueKey` 까지 RPC로 실어 보낼 수 있다 |
| config 적재 | [CiLoadClientOption](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:9584) | `@vpn_client.config` 에서 `Hostname`, `Port`, `PortUDP`, `HubName`, `DeviceName`, `NoUdpAcceleration`, `HostUniqueKey` 를 읽는다 |
| config 저장 | [CiWriteClientOption](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:10125) | 위 필드들을 설정 파일로 다시 쓴다 |
| 계정 영구화 | [CtCreateAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:7417) | account를 client account list에 넣고 config에 저장한다 |
| 연결 시작 | [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6613) | 연결 시 가상 어댑터가 없으면 `VPN` 이름으로 자동 생성 시도 후 `NewClientSessionEx` 를 연다 |
| 세션 시작 | [NewClientSessionEx](/tmp/SoftEtherVPN_Stable/src/Cedar/Session.c:1962) | `ClientOption` / `ClientAuth` 를 세션에 복사하고 client thread를 시작한다 |
| 서버명/포트 복사 | [NewClientConnectionEx](/tmp/SoftEtherVPN_Stable/src/Cedar/Connection.c:3669) | 실제 소켓 연결 대상은 `ClientOption.Hostname` / `ClientOption.Port` 다 |
| 소켓 연결 | [ClientConnectGetSocket](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:7577) | `PortUDP == 0` 이면 TCP, 아니면 R-UDP direct 경로가 가능하다 |
| SSL 시작 | [ClientConnectToServer](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:7514) | TCP connect 후 `StartSSLEx` 로 VPN 세션을 시작한다 |
| 협상 시작 | [ClientConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:5650) | signature 업로드, hello 다운로드, 이후 로그인으로 이어진다 |
| 익명 로그인 팩 | [PackLoginWithAnonymous 호출](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:6829) | 실제 로그인은 `HubName + Username + AuthType=ANONYMOUS` 로 만들어진다 |
| 로그인 패킷 내용 | [PackLoginWithAnonymous](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:8443) | `method=login`, `hubname`, `username`, `authtype=anonymous` 를 PACK에 넣는다 |

이걸 쉽게 순서로 풀면 이렇다.

1. local agent가 계정 데이터를 만든다.
2. SoftEther client가 그 계정을 저장한다.
3. connect를 호출하면 세션이 뜬다.
4. 세션이 `Hostname` 과 `Port` 로 실제 소켓을 연다.
5. SSL 시작 후 `hubname` 과 `username` 을 넣은 anonymous login PACK을 보낸다.
6. 서버가 받으면 터널이 성립한다.

즉 우리가 필요한 것은 "프로토콜 역추측"이 아니라,
**이미 있는 계정/세션/연결 경로에 raw 값을 정확히 꽂아 넣는 것**이다.

## 5. raw feed -> SoftEther 필드 매핑

이번 재검증으로 매핑을 두 층으로 나눠야 한다.

- 1차 확정값: 지금 바로 연결에 써도 되는 값
- 2차 실험값: 구조체엔 들어가지만, 지금 바로 꽂으면 연결 경로가 달라질 수 있는 값

| raw/local 값 | SoftEther 목적지 | MVP 필수 여부 | 현재 판단 | 설명 |
| --- | --- | --- | --- | --- |
| `IP` | `ClientOption.Hostname` | 필수 | 확정 | 실제 캡처가 IP로 직접 붙었다. FQDN보다 IP 우선이 맞다 |
| 선택한 `SslPorts` 1개 | `ClientOption.Port` | 필수 | 확정 | 성공/실패 케이스 모두 실제 접속 포트와 일치했다 |
| 고정값 `VPNGATE` | `ClientOption.HubName` | 필수 | 확정 | [warning_en.txt](/tmp/SoftEtherVPN_Stable/src/bin/hamcore/warning_en.txt:99) 와 [VG.h](/tmp/SoftEtherVPN_Stable/src/Cedar/VG.h:108) 가 일치한다 |
| 고정값 `VPN` | `ClientAuth.Username` | 필수 | 높음 | 공식 문구에서 공개 user가 `VPN` 이다 |
| `AuthType = anonymous` | `ClientAuth.AuthType` | 필수 | 확정 | [PackLoginWithAnonymous](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:8443) 경로가 그대로 있다 |
| 로컬 생성명 | `ClientOption.AccountName` | 필수 | 확정 | temp account 이름은 agent 정책으로 정하면 된다 |
| 로컬 선택 어댑터명 | `ClientOption.DeviceName` | 필수 | 조건부 | 필수 필드이긴 하지만 raw에서 오는 값이 아니다. 로컬 어댑터 선점 상태를 보고 정해야 한다 |
| 고정값 `PROXY_DIRECT` | `ClientOption.ProxyType` | 필수 | 확정 | [Cedar.h](/tmp/SoftEtherVPN_Stable/src/Cedar/Cedar.h:354) 기준 direct 연결을 명시하는 게 맞다 |
| 고정값 `false` | `CheckServerCert` | 필수 | 조건부 | headless MVP에서는 인증서 UI/확인 흐름을 피하려면 명시적으로 false가 안전하다 |
| agent 정책값 | `ClientOption.NumRetry` | 필수 | 조건부 | 공식 GUI 기본값은 무한 재시도지만, local agent MVP는 제어 가능한 값으로 다시 정해야 한다 |
| agent 정책값 | `ClientOption.RetryInterval` | 필수 | 조건부 | retry를 쓸 때만 의미가 있다. agent 재시도 정책과 같이 설계해야 한다 |
| 고정값 `true` | `ClientOption.NoUdpAcceleration` | 필수 | 조건부 | 첫 MVP를 엄격한 TCP-only로 유지하려면 명시적으로 true가 안전하다 |
| `UdpPort` | `ClientOption.PortUDP` | 비필수 | 미확정 | 구조체에는 있지만, 지금 바로 넣으면 TCP 경로가 아니라 R-UDP direct 경로로 바뀐다 |
| `HostUniqueKey` | `ClientOption.HostUniqueKey` | 비필수 | 미확정 | 필드/직렬화 경로는 있으나, 현재 확인한 connect path에서 직접 소비 지점은 못 찾았다 |
| `OpenVpnUdpPorts` | 매핑 없음 | 불필요 | 확정 | 이름 그대로 OpenVPN 전용이다. SoftEther `PortUDP` 로 넣으면 안 된다 |

### 5-1. 이번 재검증에서 수정된 핵심 주장

#### `raw.UdpPort -> ClientOption.PortUDP` 는 지금 바로 직결하면 안 된다

이건 이번 문서에서 가장 크게 수정된 부분이다.

- 구조체 설명:
  - [Connection.h](/tmp/SoftEtherVPN_Stable/src/Cedar/Connection.h:160)
- 실제 분기:
  - [ClientConnectGetSocket](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:7577)

실제 로직은 이렇다.

- `PortUDP == 0` 이면 TCP connect 경로로 간다
- `PortUDP != 0` 이면 `NewRUDPClientDirect(...)` 경로로 간다

쉽게 예시로 말하면:

- 우리가 확인한 성공 케이스는 `121.138.132.127:1698/tcp`
- 그런데 `PortUDP = 34429` 를 그대로 넣으면 "같은 서버로 TCP"가 아니라 "UDP direct 모드"로 성격이 바뀔 수 있다

즉 `raw.UdpPort` 는 "있으니 그냥 넣자"가 아니라,
**"나중에 별도 실험할 선택 필드"** 로 내려야 한다.

MVP 권장값은 이거다.

```json
{
  "Port": 1698,
  "PortUDP": 0,
  "NoUdpAcceleration": true
}
```

이 값을 같이 묶어야 하는 이유:

- [ClientConnectGetSocket](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:7642) 기준 `PortUDP != 0` 이면 아예 R-UDP direct 분기로 간다
- [ClientConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:5703) 기준 `NoUdpAcceleration == false` 면 TCP 세션에서도 UDP acceleration 초기화를 시도할 수 있다

즉 **진짜 TCP-only MVP** 라면 `PortUDP = 0` 하나만으로는 충분하지 않고,
`NoUdpAcceleration = true` 까지 같이 고정하는 편이 더 안전하다.

#### `DeviceName = VPN` 은 원격 릴레이 스펙이 아니라 로컬 어댑터 정책값이다

관련 코드:

- 자동 생성 시도:
  - [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6613)
- 잘못된 어댑터명 정규화:
  - [CiNormalizeAccountVLan](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:9128)
- 첫 번째 기존 어댑터 선택:
  - [CiGetFirstVLan](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:7976)
- Windows 허용 이름 규칙:
  - [CiIsValidVLanRegulatedName](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3127)
- 어댑터 생성:
  - [CtCreateVLan](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:8373)

실제 의미:

- 어댑터가 아예 0개면 SoftEther가 `VPN` 생성 시도를 한다
- 하지만 어댑터가 하나라도 있으면, `VPN` 을 무조건 새로 만드는 게 아니다
- 계정의 `DeviceName` 이 유효하지 않으면 기존 첫 어댑터명으로 덮어쓸 수 있다
- 첫 어댑터를 새로 설치한 직후 총 VLan 수가 1개면, SoftEther가 **기존 모든 account의 `DeviceName` 을 그 어댑터명으로 맞춰 버릴 수 있다**:
  - [CtCreateVLan](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:8562)
- 이미 다른 active account가 같은 어댑터를 쓰고 있으면 `ERR_VLAN_FOR_ACCOUNT_USED` 로 실패한다:
  - [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6760)

즉 `DeviceName = "VPN"` 은 "항상 맞는 값"이 아니라,
**"로컬에 비어 있으면 쓰고, 아니면 다른 free 어댑터를 골라야 하는 후보 이름"** 이다.

예시:

- 내 PC에 어댑터가 하나도 없음 -> `VPN` 생성/사용
- 이미 `VPN` 이 있고 비어 있음 -> `VPN` 사용
- `VPN` 이 다른 세션에서 사용 중 -> `VPN2` 같은 별도 어댑터 필요
- SoftEther Client에 사용자 기존 account가 있고 첫 VLan을 지금 처음 설치함 -> unrelated account의 `DeviceName` 도 같이 바뀔 수 있으므로 주의

#### `CheckServerCert` 는 headless agent에서 명시적으로 다뤄야 한다

관련 코드:

- [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6777)

실제 로직:

- `CheckServerCert == true` 면 `CheckCertProc` 를 붙인다
- `false` 면 붙이지 않는다

공식 CLI 생성 코드는 `Zero(...)` 이후 필요한 값만 채우므로, 결과적으로 기본은 false 쪽에 가깝다:

- [PcAccountCreate](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:4217)

따라서 headless local agent MVP는 이 값을 명시적으로 `false` 로 두는 게 안전하다.
나중에 pinned cert나 TOFU 설계를 넣을 수는 있지만, 그건 2차 범위다.

#### 계정 재사용보다 "매번 새 temp account"가 더 안전하다

관련 코드:

- active account 삭제 금지:
  - [CtDeleteAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:7156)
- active account 재설정은 허용되지만 다음 연결부터 반영:
  - [CtSetAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:7300)
- connect/disconnect RPC:
  - [CcConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3711)
  - [CcDisconnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3739)

이 뜻은 단순하다.

- 같은 account 이름을 계속 덮어써도, 현재 살아 있는 세션에 즉시 반영된다고 보면 안 된다
- 살아 있는 account는 바로 삭제도 안 된다

그래서 안전한 lifecycle은 이 순서다.

1. temp account 새로 생성
2. connect
3. disconnect
4. inactive 상태 확인
5. delete

### 5-2. 성공 릴레이 기준 "안전한 MVP" 예시

이미 성공 캡처가 있던 릴레이를 예로 들면 raw는 이렇다.

```json
{
  "ID": 18786933,
  "Fqdn": "vpn204414021.opengw.net",
  "IP": "121.138.132.127",
  "SslPorts": "1698",
  "UdpPort": 34429,
  "HostUniqueKey": "E8FD31EE814ABD78B33361B0A625667518EE2D50"
}
```

하지만 첫 구현용 temp account는 이렇게 잡는 편이 더 안전하다.

```json
{
  "CheckServerCert": false,
  "ClientOption": {
    "AccountName": "vpngate-18786933-1698-001",
    "Hostname": "121.138.132.127",
    "Port": 1698,
    "PortUDP": 0,
    "NoUdpAcceleration": true,
    "ProxyType": 0,
    "HubName": "VPNGATE",
    "DeviceName": "VPN",
    "UseEncrypt": true,
    "UseCompress": false,
    "MaxConnection": 1,
    "AdditionalConnectionInterval": 1,
    "NumRetry": 0,
    "RetryInterval": 15
  },
  "ClientAuth": {
    "AuthType": "ANONYMOUS",
    "Username": "VPN"
  }
}
```

여기서 중요한 차이는 6개다.

- `PortUDP` 는 일단 `0`
- `NoUdpAcceleration` 도 일단 `true`
- `ProxyType` 는 명시적으로 direct
- `CheckServerCert` 는 명시적으로 false
- `UseCompress` 는 기본 false 그대로 유지
- `AdditionalConnectionInterval` 은 최소 1초로 명시
- `NumRetry` 는 첫 MVP에서 `0` 으로 두어 한 번 실패했을 때 agent가 제어권을 잡게 한다

왜 `NumRetry = 0` 이냐면:

- 공식 GUI/CLI 기본 생성은 `INFINITE` 다:
  - [PcAccountCreate](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:4252)
- 하지만 실제 세션 루프는 `NumRetry` 를 기준으로 재시도한다:
  - [Session.c](/tmp/SoftEtherVPN_Stable/src/Cedar/Session.c:1605)

즉 공식 GUI 편의 기본값을 local agent MVP에 그대로 들고 오면,
실패 후에도 SoftEther 내부가 계속 재시도하면서 우리 쪽 `start/stop/cleanup` 제어가 오히려 더 어려워질 수 있다.

주의:

- 위 예시의 `DeviceName = "VPN"` 은 "이 이름이 비어 있을 때"만 맞다
- 실제 agent는 먼저 free adapter를 고른 뒤 그 값을 넣어야 한다

### 5-3. 나중에 2차 실험으로 올릴 수 있는 필드

아래는 "지금 막 첫 연결"에는 안 넣어도 되지만, 이후 성공률 개선 실험 대상으로 남겨둘 값이다.

- `ClientOption.HostUniqueKey`
- `ClientOption.PortUDP`
- `ClientOption.NoUdpAcceleration = false` 허용 여부

다만 현재 확인 기준으로는:

- `HostUniqueKey` 는 RPC/config 직렬화 경로는 분명히 있다:
  - [InRpcClientOption / OutRpcClientOption](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:4602)
  - [CiLoadClientOption / CiWriteClientOption](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:9584)
- 그런데 지금 확인한 connect path 안에서 직접 소비되는 지점은 못 찾았다

그래서 이 값은
**"넣을 수는 있지만, 안 넣는다고 당장 막히는 blocker는 아니다"** 로 보는 게 맞다.

## 6. 현재 저장소 기준으로 어디를 바꿔야 하는가

현재 저장소는 이미 `selfHostedVpn` feature 안에 **raw 모드 1차 확장**이 들어가 있다.

즉 지금 기준의 핵심 문제는

- popup이 raw 입력을 못 받는가
- background가 raw 요청을 못 보내는가

가 아니라,

- local agent가 현재 extension 계약을 정확히 만족하는가
- SoftEther 계정/어댑터/cleanup 정책을 그 계약 안에 어떻게 녹이는가

쪽이다.

좋은 점도 분명하다.

- 기존 scheduler는 connect/disconnect를 이미 직렬화한다:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:364)
- 상태 조회도 최소 간격을 둔다:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:23)

즉 `selfHostedVpn` 틀을 재사용해도
`연결 버튼 연타로 요청이 꼬이는 문제` 나 `상태 polling 과다` 는 기본 골격에서 이미 어느 정도 막고 있다.

### 6-1. 현재 저장소는 이미 raw 모드 입력/저장/전송을 안다

현재 상태:

- API config 정규화가 이미 raw 필드를 보존한다:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:26)
- connect body도 이미 `mode + relay + profileId(호환용)` union 형태로 만든다:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:89)
- raw 모드 start guard는 `profileId` 대신 `raw host + selectedSslPort` 기준으로 검증한다:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:144)
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:67)
- popup은 이미 raw 입력칸을 갖고 있다:
  - [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html:1739)
  - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1026)
- background의 설정 변경 잠금도 이미 `connectionMode`, `selectedRelayId`, `selectedSslPort`, `relaySnapshot` 을 비교한다:
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:1545)

즉 과거처럼 "`profileId` 밖에 못 넣는 구조"는 더 이상 아니다.
지금은 **extension 쪽 1차 raw-aware 계약은 이미 들어가 있고, local agent만 그 계약을 받아 줄 준비가 덜 된 상태** 로 보는 게 맞다.

### 6-2. 현재 extension이 실제로 보내는 connect payload

현재 raw 모드 connect body는 이 형태에 가깝다.

```json
POST /v1/vpn/connect
{
  "mode": "softether_vpngate_raw",
  "profileId": "vpngate-18786933-1698",
  "relay": {
    "id": 18786933,
    "fqdn": "vpn204414021.opengw.net",
    "ip": "121.138.132.127",
    "selectedSslPort": 1698,
    "udpPort": 34429,
    "hostUniqueKey": "E8FD31EE814ABD78B33361B0A625667518EE2D50"
  }
}
```

기존 profile 모드는 그대로 유지된다.

```json
POST /v1/vpn/connect
{
  "mode": "profile",
  "profileId": "test-profile-01"
}
```

즉 local agent는 첫 구현부터 **2모드 union contract** 를 받아야 한다.

여기서 추가로 주의할 점 2개:

- `relay.id` 는 digit-only 문자열이면 request body에서 숫자로 직렬화될 수 있다
- 현재 contract는 `selectedSslPort` 1개만 보내며, 원본 `SslPorts` 전체 리스트는 보내지 않는다

즉 local agent는

- `relay.id` 를 string/number 둘 다 받아야 하고
- 첫 구현에서는 "1 relay + 1 chosen SSL port" 만 처리한다고 보는 게 맞다

자동 포트 fallback까지 하고 싶다면,
extension contract를 넓혀 `SslPorts[]` 전체 후보를 넘기거나 agent 측 재시도 정책을 별도로 설계해야 한다.

현재 저장소 쪽 config는 이 형태를 이미 담을 수 있다.

```json
{
  "agentBaseUrl": "http://127.0.0.1:8765",
  "authToken": "",
  "connectionMode": "softether_vpngate_raw",
  "profileId": "",
  "selectedRelayId": "18786933",
  "selectedSslPort": 1698,
  "relaySnapshot": {
    "id": 18786933,
    "fqdn": "vpn204414021.opengw.net",
    "ip": "121.138.132.127",
    "udpPort": 34429,
    "hostUniqueKey": "E8FD31EE814ABD78B33361B0A625667518EE2D50"
  },
  "requestTimeoutMs": 800,
  "actionTimeoutMs": 3000
}
```

핵심은 이거다.

- `profileId` 모드는 유지 가능
- raw 모드에서는 `relaySnapshot + selectedSslPort` 가 진실 소스다
- 다만 현재 extension은 raw 모드에서도 **호환용 `profileId`** 를 함께 만들어 쓰므로, agent도 이 필드를 무시하지 않는 편이 더 안전하다

추가로 현재 extension validation은 raw 모드에서 `relaySnapshot.ip` 가 비어 있어도 `fqdn` 만 있으면 start를 허용한다.

이건 문서의 "첫 MVP는 raw.ip 우선" 정책과 살짝 어긋난다.

따라서 첫 구현 전에 둘 중 하나를 명확히 정해야 한다.

1. local agent가 `relay.ip` 가 없어도 `relay.fqdn` fallback을 지원한다
2. 아니면 나중 패치에서 extension validation/start guard를 더 엄격하게 바꿔 raw 모드 첫 MVP는 IP를 필수로 만든다

지금 문서 기준으로는 1번보다 2번이 더 보수적이지만,
현재 저장소 계약 그대로라면 agent가 `fqdn` fallback을 해 두는 편이 실사용 혼선을 줄인다.

그리고 extension 쪽 입력 검증은 여기서 끝이다.

- relay host는 "비어 있지 않은 문자열" 정도만 본다
- IP 형식 유효성, FQDN 형식 유효성, 포트 조합의 실제 연결 가능성은 여기서 보지 않는다

따라서 local agent는 raw 모드에서 최소한 아래 검증은 자체 수행해야 한다.

1. `relay.ip` 가 있으면 IPv4/IPv6 literal로 해석 가능한지
2. `relay.fqdn` fallback을 쓸 거면 허용할 hostname 패턴인지
3. `selectedSslPort` 가 1~65535 인지
4. `hostUniqueKey` 가 있으면 20바이트 hex decode가 가능한지

### 6-3. 현재 저장소 호출 체인 재검증 결과

현재 selfHostedVpn 흐름은 아래처럼 이어진다.

1. popup toggle / save / refresh:
   - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1026)
2. background message router:
   - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:534)
3. scheduler.start / stop / refreshStatus:
   - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:71)
4. local agent HTTP 호출:
   - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:72)

즉 패치가 "local agent 연결 엔진"에서만 끝나는 구조는 아니다.
하지만 반대로 말하면, **extension 쪽은 이미 요청/상태 틀이 있으니 local agent와 문서 계약만 정확히 맞추면 UI부터 다시 뜯을 필요는 없다.**

#### local agent 주소는 현재 `HTTP localhost` 만 허용된다

관련 코드:

- [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:321)

현재 확장은 아래만 허용한다.

- `http://127.0.0.1:8765`
- `http://localhost:8765`
- `http://[::1]:8765`

허용되지 않는 것:

- `https://...`
- 원격 사설망 주소
- 원격 공인 IP
- query/hash/userinfo 가 붙은 URL

즉 첫 구현은 무조건 **같은 PC에서 도는 local agent** 기준이어야 한다.
remote daemon, HTTPS reverse proxy, 다른 호스트의 agent는 지금 문서 범위를 벗어난다.

#### auth token을 켜면 header가 2개 같이 나간다

관련 코드:

- [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:194)

현재 확장은 token이 있으면 아래 둘을 같이 보낸다.

- `Authorization: Bearer <token>`
- `X-DefenseSuite-Token: <token>`

따라서 local agent는 아래 둘 중 하나만 받아도 되지만,
실무적으로는 둘 다 허용하는 편이 가장 무난하다.

#### 현재 stop/disconnect 흐름은 "단일 active VPN 세션"을 전제로 한다

관련 코드:

- disconnect body:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:81)
- scheduler 상태:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:35)

현재 구조는:

- `disconnect` 요청 body가 빈 객체다
- scheduler도 `operationId`, `activeProfileId`, `activeRelayId` 를 1개만 들고 있다

즉 이 기능은 원래부터
**"동시에 여러 VPN 세션을 관리하는 구조가 아니라, 현재 활성 터널 1개만 관리하는 구조"** 다.

따라서 local agent 구현도 첫 단계에서는 반드시 singleton 으로 맞춰야 한다.

예시:

- 허용: 현재 연결 1개, 새 connect 요청 오면 이전 것이 완전히 내려간 뒤 시작
- 비허용: temp account 여러 개를 동시에 띄우고 UI가 그중 하나만 끊는 구조

#### connect / disconnect 는 둘 다 "빠르게 accepted 후 비동기 진행" 계약이어야 한다

관련 코드:

- connect action timeout 기본값:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:22)
- start 직후 강제 status refresh:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:137)
- stop 직후 강제 status refresh:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:174)

현재 확장 흐름은 이렇다.

1. `POST /v1/vpn/connect` 또는 `POST /v1/vpn/disconnect`
2. 응답이 오면 곧바로 `refreshStatusFromAgent(force=true)`
3. 거기서 `GET /v1/health`, `GET /v1/vpn/status`, `GET /v1/vpn/egress` 를 동시에 친다

즉 local agent가 connect/disconnect 요청을 오래 물고 있으면 안 된다.

첫 구현에서 필요한 계약은 이거다.

- `/v1/vpn/connect` 는 빠르게 `accepted=true` 로 반환
- `/v1/vpn/disconnect` 도 빠르게 `accepted=true` 로 반환
- 실제 SoftEther 연결/해제/account cleanup은 agent 내부에서 비동기로 진행
- `/v1/vpn/status` 는 곧바로 `CONNECTING`, `DISCONNECTING`, `CONNECTED`, `IDLE`, `ERROR` 중 하나를 반환

여기서 `disconnect` 는 **idempotent** 하게 다루는 편이 안전하다.

예시:

- 이미 idle인데 stop을 눌렀다 -> agent가 에러 대신 `accepted=true`, 이후 status=`IDLE` 반환
- disconnect cleanup이 아직 도는 중이다 -> `accepted=true`, status=`DISCONNECTING`

안 그러면 scheduler는 stop 실패로 되돌아가면서
UI에 불필요한 `DISCONNECT_REQUEST_FAILED` 를 띄울 수 있다.

#### disconnect 직후 agent가 사라지면 extension은 "정지 완료"로 정리할 수 있다

관련 코드:

- [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:176)

현재 stop 흐름에는 이런 분기가 있다.

- disconnect 요청은 accepted 됨
- 직후 status refresh에서 agent가 안 잡힘
- scheduler는 "종료 요청 이후 agent 응답이 끊겼다"고 보고 local 상태를 정지로 정리할 수 있다

이 말은 곧,

- agent가 disconnect cleanup 도중 재시작되거나
- status endpoint가 잠깐 내려가거나
- disconnect accepted 직후 프로세스가 죽는 경우

extension은 실제 SoftEther 세션이 아직 남아 있어도 **UI상 IDLE로 믿어 버릴 위험** 이 있다는 뜻이다.

따라서 첫 agent 구현 규칙은 이거다.

1. disconnect accepted 이후에는 cleanup 완료 전까지 `/v1/vpn/status` 를 계속 살려 둔다
2. 프로세스가 재시작돼도 가능한 한 현재 cleanup/connection 상태를 복원한다
3. 최소한 `/v1/vpn/status` 에서 `DISCONNECTING` -> `IDLE` 전환을 다시 계산할 수 있어야 한다

#### `/v1/vpn/status` 는 보조가 아니라 필수 source of truth다

관련 코드:

- [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:220)
- [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:281)

중요한 점:

- `GET /v1/health` 만 성공해도 충분하지 않다
- `GET /v1/vpn/status` 가 실패하면 scheduler는 phase를 `ERROR` 또는 `AGENT_UNAVAILABLE` 쪽으로 몰아갈 수 있다
- `GET /v1/vpn/egress` 는 보조 정보지만, `/v1/vpn/status` 는 상태 자체를 결정한다

즉 local agent는 최소한 아래 endpoint를 안정적으로 제공해야 한다.

- `/v1/health`
- `/v1/vpn/status`
- `/v1/vpn/egress`

그리고 `/v1/vpn/status` 최소 응답은 이 정도가 가장 안전하다.

```json
{
  "phase": "CONNECTING",
  "operationId": "op-20260419-001",
  "connectionMode": "softether_vpngate_raw",
  "profileId": "vpngate-18786933-1698",
  "activeRelayId": "18786933",
  "activeRelayIp": "121.138.132.127",
  "activeRelayFqdn": "vpn204414021.opengw.net",
  "activeSelectedSslPort": 1698,
  "activeAdapterName": "VPN"
}
```

왜냐하면 현재 scheduler는 이 값들을 받아서

- phase
- profile/식별자
- 활성 릴레이
- 활성 포트
- 활성 어댑터

를 바로 UI에 반영하기 때문이다.

추가로 중요한 해석 규칙이 하나 더 있다.

- scheduler는 `phase` 또는 `status` 문자열을 읽어 정규화한다
- 여기서 인식하지 못하는 문자열은 사실상 `IDLE` 로 떨어질 수 있다:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:585)

즉 local agent는 아래처럼 **확장 고유 phase 문자열** 을 마음대로 만들면 안 된다.

- 나쁜 예: `SOFTETHER_CONNECTING_STAGE2`
- 나쁜 예: `CONNECTED_SOFTETHER`
- 좋은 예: `CONNECTING`, `CONNECTED`, `DISCONNECTING`, `IDLE`, `ERROR`

### 6-3-1. `/v1/health` 도 최소 계약을 맞추는 편이 안전하다

관련 코드:

- [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:235)
- [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:3574)

현재 popup의 agent 상태는 `health.ok` 를 직접 본다.

즉 `/v1/health` 가 200을 주더라도 아래처럼 `ok` 가 없으면:

```json
{
  "version": "0.1.0"
}
```

UI는 "응답은 오지만 일부 비정상"처럼 보일 수 있다.

따라서 첫 구현에서는 최소한 이 정도가 안전하다.

```json
{
  "ok": true,
  "agentVersion": "0.1.0"
}
```

#### 일반 status polling은 최대 1200ms로 잘린다

관련 코드:

- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:340)

`getAllStatus` 나 `getStatus` 경로에서는 polling timeout이 최대 `1200ms` 로 제한된다.

즉 agent의 아래 endpoint는 빠르게 응답해야 한다.

- `/v1/health`
- `/v1/vpn/status`
- `/v1/vpn/egress`

쉽게 말하면:

- "manual refresh 눌렀을 땐 잘 되는데 popup 열 때는 자꾸 unavailable 뜬다"
- 이런 일이 생기면 원인은 대개 `/v1/vpn/status` 또는 `/v1/vpn/egress` 가 느린 것이다

#### 이 기능은 background 지속 루프형이 아니라 "poll-on-demand" 에 가깝다

관련 코드:

- selfHostedVpn run loop:
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:471)
- popup open 시 status refresh:
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:375)

실제 상태:

- background는 저장된 selfHostedVpn 상태를 복원하긴 한다
- 하지만 `ensureRunLoop()` 는 현재 빈 함수다
- extension은 주로 `popup open`, `manual refresh`, `start/stop` 시점에만 agent 상태를 읽는다

무슨 뜻이냐면:

- local agent는 "extension이 계속 heartbeat를 보내 줄 것"을 기대하면 안 된다
- connect 이후 터널 유지, disconnect 처리, 상태 보존은 agent가 스스로 책임져야 한다
- popup을 닫아도 VPN 연결은 살아 있어야 한다

특히 agent 프로세스가 재시작될 수 있는 구조라면,
메모리 변수만 믿지 말고 **실제 SoftEther client 상태를 다시 읽어서 현재 active tunnel을 재구성** 할 수 있어야 한다.

예시:

- extension popup을 닫은 상태에서 VPN은 계속 연결 중
- local agent 프로세스만 재시작됨
- popup을 다시 열었을 때 `/v1/vpn/status` 가 in-memory state를 잃어버리면 `IDLE` 로 보일 수 있음

그래서 첫 구현에서도 아래 둘 중 하나는 필요하다.

1. agent 자체 state persistence
2. SoftEther RPC 재조회 기반 상태 재구성

#### 시작 자체가 다른 기능/세션 자동화에 의해 막힐 수 있다

관련 코드:

- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:1474)
- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:1456)

현재는 아래가 돌고 있으면 VPN 시작이 막힐 수 있다.

- 로그인 세션 자동화
- 감시 자동화
- 게시글 분류
- 반고닉 분류
- IP 차단
- 분탕자동차단
- Local 수집
- 역류댓글 수집
- 임시 Overlay 수집

즉 local agent 구현만 끝났다고 해서 "언제든 start 가능"은 아니다.
실사용 테스트 플로우에도 이 잠금 규칙을 반영해야 한다.

### 6-4. 호환용 `profileId` 는 지금도 살아 있고, 첫 패치에서도 유지하는 편이 안전하다

관련 코드:

- 자동 생성:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:120)
- popup 표기:
  - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:3659)

현재 raw 모드에서 `profileId` 를 비워 두면,
extension은 relay id / host / ssl port를 조합해 호환용 식별자를 자동 만든다.

예시:

- relay id=`18786933`
- selected ssl port=`1698`
- 자동 식별자=`vpngate-18786933-1698`

따라서 첫 raw 패치에서는 이 전략이 가장 안전하다.

1. 실제 agent 처리 기준값은 `mode + relay`
2. 동시에 호환용 `profileId` 도 같이 유지
3. status/connect 응답에도 가능하면 같은 `profileId` 를 되돌려 준다

이렇게 가면 기존 로그/메타/UI 문구가 덜 흔들린다.

### 6-5. 나중에 상태 필드를 더 늘릴 때 같이 손봐야 하는 곳

현재는 아래 상태 필드가 이미 들어가 있다.

- `activeConnectionMode`
- `activeRelayId`
- `activeRelayIp`
- `activeRelayFqdn`
- `activeSelectedSslPort`
- `activeAdapterName`

따라서 예전처럼 이 필드를 새로 심을 필요는 없다.

대신 앞으로 아래 같은 필드를 더 넣고 싶어질 수 있다.

- `activeAccountName`
- `underlayProtocol`
- `lastSoftEtherError`
- `softEtherSessionStatus`

이때는 아래를 같이 봐야 한다.

1. scheduler constructor / `buildStateSnapshot()` / `getStatus()`
2. scheduler `loadState()`
3. popup `buildDefaultSelfHostedVpnStatus()`
4. popup `updateSelfHostedVpnUI()`
5. background `resetStats(feature === selfHostedVpn)`

이 중 하나라도 빠지면

- 저장 상태엔 있는데 UI 기본값엔 없거나
- reset 후 일부 필드만 남거나
- popup reopen 시 값이 반쯤 사라지는

식의 어정쩡한 상태가 된다.

### 6-6. 나중에 설정 입력칸을 더 늘릴 때 같이 손봐야 하는 곳

현재 popup은 이미 아래 입력을 안다.

- `agentBaseUrl`
- `authToken`
- `connectionMode`
- `profileId`
- `selectedRelayId`
- `relaySnapshot.fqdn`
- `relaySnapshot.ip`
- `selectedSslPort`
- `relaySnapshot.udpPort`
- `relaySnapshot.hostUniqueKey`
- `requestTimeoutMs`
- `actionTimeoutMs`

따라서 첫 raw 패치에서 이 입력칸들을 새로 만들 필요는 없다.

대신 앞으로 아래 같은 추가 옵션을 붙일 수 있다.

- `adapterOverride`
- `strictTcpOnly`
- `numRetry`
- `retryInterval`
- `checkServerCert`

이 경우엔 아래를 같이 바꿔야 한다.

1. `features/self-hosted-vpn/api.js`
   - `DEFAULT_CONFIG`
   - `normalizeConfig()`
   - `buildConnectRequestBody()`
   - `getConfigValidationMessage()`
2. `popup/popup.js`
   - save handler
   - `getFeatureConfigInputs('selfHostedVpn')`
   - `updateSelfHostedVpnUI()` 내부 `syncFeatureConfigInputs(...)`
3. `background/background.js`
   - running 중 config lock 비교식

안 그러면:

- 새 입력칸은 저장 dirty 체크가 안 되고
- 연결 중 disable도 안 되고
- status refresh 때 값 동기화도 안 되고
- background에서는 running 중 변경을 못 막는

상태가 된다.

## 7. local agent 구현 방식 권장안

### 7-1. 최종 추천: SoftEther Client RPC/구조체 래퍼 방식

가장 맞는 방식은 이거다.

1. Windows에 SoftEther VPN Client와 가상 어댑터 드라이버를 설치한다.
2. local agent는 SoftEther Client 서비스에 붙는다.
3. 먼저 현재 VLan 목록을 조회해서 free adapter를 고른다.
4. `RPC_CLIENT_CREATE_ACCOUNT` payload를 직접 만든다.
5. raw relay 값을 `ClientOption` / `ClientAuth` 에 채우되, 첫 MVP는 `PortUDP = 0`, `NoUdpAcceleration = true`, `CheckServerCert = false`, `ProxyType = PROXY_DIRECT` 로 간다.
6. temp account를 `CreateAccount` RPC로 생성한다.
7. `Connect` RPC를 호출한다.
8. 연결 후 egress IP와 route 변화를 확인한다.
9. 끊을 때는 `Disconnect` 후 inactive 상태를 확인한 다음 temp account를 삭제한다.

이 방식이 좋은 이유:

- SoftEther 프로토콜을 새로 짤 필요가 없다
- `PortUDP`, `HostUniqueKey`, `NoUdpAcceleration` 같은 숨은 필드도 실을 수 있다
- 현재 저장소의 local agent 패턴과도 잘 맞는다
- 어댑터 생성/점유, 세션 생성, 로그인 PACK, reconnect 동작을 검증된 코어에 맡길 수 있다

실제 RPC entry:

- account 생성:
  - [CcCreateAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3384)
- account 수정:
  - [CcSetAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3540)
- connect:
  - [CcConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3711)
- disconnect:
  - [CcDisconnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3738)

### 7-1-1. 실제 구현에 필요한 최소 RPC surface

local agent가 바로 쓰게 될 최소 집합은 아래 정도면 충분하다.

1. 관리 RPC attach:
   - [CcConnectRpc](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:5834)
2. 어댑터 목록 조회:
   - [CcEnumVLan](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3279)
3. 어댑터 생성:
   - [CcCreateVLan](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3152)
4. temp account 생성:
   - [CcCreateAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3384)
5. account 재조회/수정:
   - [CcGetAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3566)
   - [CcSetAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3540)
6. 연결/해제:
   - [CcConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3711)
   - [CcDisconnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3739)
7. 상태 polling:
   - [CcEnumAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3410)
   - [CcGetAccountStatus](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3767)
8. cleanup:
   - [CcDeleteAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:3514)

쉽게 예시로 말하면:

- `ConnectRpc` = SoftEther Client service에 로그인
- `EnumVLan` = 지금 로컬에 쓸 수 있는 VPN NIC가 있는지 보기
- `CreateAccount` = raw 1개를 SoftEther account로 만들기
- `Connect` = 그 account로 실제 터널 올리기
- `EnumAccount/GetAccountStatus` = 지금 붙는 중인지, 붙었는지, 내려갔는지 보기
- `Disconnect/DeleteAccount` = 세션과 temp account 정리

### 7-1-2. polling은 `EnumAccount + GetAccountStatus` 를 같이 쓰는 게 안전하다

이 부분은 이번 재검증에서 새로 문서에 못 박아야 하는 포인트다.

- `EnumAccount` 는 account가 inactive여도 리스트에 남아 있으면 `Active=false`, `Connected=false` 로 보인다:
  - [CtEnumAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:7232)
- `GetAccountStatus` 는 `ClientSession != NULL` 일 때만 rich status를 채우고, 세션이 없으면 구조체를 거의 비운 채 반환한다:
  - [CtGetAccountStatus](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6231)
  - [CiGetSessionStatus](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6082)

즉 구현 규칙은 이렇게 잡는 게 맞다.

1. temp account 이름으로 `EnumAccount` 에서 먼저 대상을 찾는다.
2. item이 없으면:
   - 이미 delete 된 상태거나 아직 create 전이다.
3. item이 있고 `Active=true`, `Connected=false` 면:
   - extension phase는 `CONNECTING` 으로 본다.
4. item이 있고 `Active=true`, `Connected=true` 면:
   - extension phase는 `CONNECTED` 이다.
   - 이때만 `GetAccountStatus` 를 추가로 불러서 `SessionStatus`, `ServerName`, `ServerPort`, `UnderlayProtocol` 같은 rich field를 채운다.
5. item이 있고 `Active=false`, `Connected=false` 면:
   - 마지막 요청이 `disconnect` 였으면 `IDLE`
   - 마지막 요청이 `connect` 였고 아직 한 번도 `Connected=true` 를 못 찍었으면 `ERROR`

이렇게 하면 왜 좋냐면:

- `GetAccountStatus` 단독 polling은 inactive 완료 후 account name조차 다시 안 채워 줄 수 있다
- `EnumAccount` 는 inactive 판별에 강하고
- `GetAccountStatus` 는 active 세션 metadata에 강하다

둘을 역할 분리하는 게 실제 코드 구조와 가장 잘 맞는다.

### 7-1-3. local agent가 바로 만들 temp account 최소 스펙

첫 구현에서는 아래 값을 명시적으로 넣는 편이 안전하다.

```json
{
  "CheckServerCert": false,
  "ClientOption": {
    "AccountName": "vpngate-18786933-1698-001",
    "Hostname": "121.138.132.127",
    "Port": 1698,
    "PortUDP": 0,
    "ProxyType": 0,
    "NumRetry": 0,
    "RetryInterval": 15,
    "HubName": "VPNGATE",
    "MaxConnection": 1,
    "UseEncrypt": true,
    "UseCompress": false,
    "HalfConnection": false,
    "NoRoutingTracking": false,
    "DeviceName": "VPN",
    "AdditionalConnectionInterval": 1,
    "NoUdpAcceleration": true
  },
  "ClientAuth": {
    "AuthType": "ANONYMOUS",
    "Username": "VPN"
  }
}
```

위 값의 근거는 여기다.

- CLI 기본 생성값:
  - [PcAccountCreate](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:4217)
- account payload 구조:
  - [RPC_CLIENT_CREATE_ACCOUNT](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.h:337)
- option 직렬화:
  - [OutRpcClientCreateAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:4806)
  - [OutRpcClientOption](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:4642)

주의:

- `Hostname` 은 첫 MVP에서 `raw.ip` 우선이 더 안전하다
- `PortUDP = 0` 만 넣고 `NoUdpAcceleration = false` 로 두면 "엄격한 TCP-only"가 깨질 수 있다
- `DeviceName = VPN` 은 예시일 뿐이고, 실제 agent는 preflight에서 free adapter를 골라 넣어야 한다

### 7-2. 임시 POC 가능: `vpncmd` 쉘 호출 방식

이건 빠른 proof-of-life 용으로는 가능하다.

예를 들면:

1. `AccountCreate`
2. `AccountAnonymousSet`
3. `AccountConnect`

하지만 한계가 있다.

- public CLI 명령에서 `PortUDP` / `HostUniqueKey` 설정 경로를 이번 조사에서 찾지 못했다
- `AccountDetailSet` 도 `MAXTCP`, `INTERVAL`, `TTL`, `HALF`, `BRIDGE`, `MONITOR`, `NOTRACK`, `NOQOS` 정도만 보인다:
  - [PcAccountDetailSet](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:5641)
- `AccountCreate` 기본값이 GUI 친화적이라 `NumRetry = INFINITE` 다:
  - [PcAccountCreate](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:4252)

즉 `vpncmd` 만으로는 "최종 구현"이 아니라 "빠른 접속 실험기"에 더 가깝다.

### 7-3. 비추천: clean-room 자체 연결 엔진

이게 당장 어려운 이유는 명확하다.

- `src/VGate/VGate.c` 는 사실상 비어 있다:
  - [src/VGate/VGate.c](/tmp/SoftEtherVPN_Stable/src/VGate/VGate.c:111)
- `src/Cedar/VG.c` 도 스텁이다:
  - [src/Cedar/VG.c](/tmp/SoftEtherVPN_Stable/src/Cedar/VG.c:108)
- 즉 plugin UI/리스트 전용 구현은 현재 스냅샷에 충분히 안 남아 있다
- 반면 실제 연결 엔진은 core에 흩어져 있다
- 여기에 Windows 가상 어댑터, route 변경, DNS 변경, reconnect, additional connection, UDP accel까지 직접 다시 만들면 범위가 너무 커진다

이건 "불가능"이 아니라 "지금 첫 패치 경로로 틀렸다"에 가깝다.

## 8. raw 1개로 실제 IP가 바뀌는 플로우를 쉽게 설명하면

사용자 기준으로는 이 흐름이다.

1. 목록에서 릴레이 1개를 고른다.
2. 그 릴레이의 `IP` 와 `SSL 포트` 로 SoftEther 연결 계정을 만든다.
3. local PC에 가상 VPN 어댑터가 붙는다.
4. 연결이 성공하면 인터넷 기본 경로가 그 어댑터 쪽으로 바뀐다.
5. 이후 웹사이트로 나가는 패킷은 내 집 인터넷이 아니라 **그 릴레이 호스트를 거쳐서** 나간다.
6. 그래서 외부 사이트가 보는 출구 IP도 바뀐다.

예시:

- 연결 전 출구 IP: `1.210.3.152`
- 선택 릴레이: `121.138.132.127:1698`
- 연결 성공 후 외부 사이트가 보는 IP: 릴레이 호스트 쪽 출구 IP

즉 "200개 목록이 바로 IP를 바꾸는 것"이 아니라,

- 목록 = 후보 전화번호부
- SoftEther 터널 연결 = 실제 전화 연결
- 연결 후 라우트 변경 = 앞으로 그 전화선을 통해 나감

이렇게 이해하면 된다.

## 9. 지금 스펙으로 바로 구현 가능한 범위

### 9-1. 바로 가능한 것

- raw feed에서 릴레이 1개 선택
- `IP + 선택 SSL 포트` 중심으로 연결 프로필 생성
- `UdpPort`, `HostUniqueKey` 는 원본 보관만 하고 첫 연결에는 강제 투입하지 않음
- local agent가 임시 SoftEther account 생성
- anonymous 접속 시도
- 연결 상태 polling
- 연결 전후 공인 IP / route / DNS 변화 표시
- disconnect + temp account 정리

### 9-2. 아직 미정이지만 blocker는 아닌 것

- 공식 plugin이 여러 `SslPorts` 중 어떤 규칙으로 우선 선택하는지
  - 해결: 우리 구현은 일단 `selectedSslPort` 를 명시적으로 고르게 하면 된다
- 공식 plugin의 temp account naming 규칙
  - 해결: 우리 agent naming을 독자 규칙으로 정하면 된다
- `HostUniqueKey` 의 실사용 지점
  - 조사 범위에서 active use는 못 찾았지만, 계정/RPC/config 구조에는 들어간다
- `PortUDP` 를 넣었을 때 public relay 성공률이 얼마나 오르는지
  - TCP MVP는 이 값 없이도 시작 가능
- official GUI 기본값과 local agent 정책값 차이
  - 해결: retry, cert check, adapter 선택은 agent 기준으로 보수적으로 재정의하면 된다

## 10. 구현 시작 전 주의점

### 10-1. `OpenVpnUdpPorts` 를 잘못 쓰면 안 된다

이 필드는 이름 그대로 OpenVPN 용이다.

- `OpenVpnUdpPorts = "1736"`
- 이걸 SoftEther `PortUDP` 로 넣는 건 잘못이다

SoftEther 쪽에서 대응 후보는 raw의 `UdpPort` 다.

### 10-2. `UdpPort` 도 지금은 그대로 넣지 않는다

이 부분은 위에서 강조했지만, 구현 전에 다시 한 번 못 박아야 한다.

- `UdpPort` 가 있다고 해서 `ClientOption.PortUDP` 로 곧장 복사하면 안 된다
- 그 순간 [ClientConnectGetSocket](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:7577) 가 TCP 대신 R-UDP direct 경로를 탈 수 있다

즉 첫 구현 기준 규칙은 이거다.

- raw에 `UdpPort` 가 있어도 저장만 한다
- connect payload의 `PortUDP` 는 `0`
- TCP 경로가 안정화된 다음에만 별도 실험한다

### 10-3. `HostUniqueKey` 는 hex 문자열 그대로 넣는 게 아니다

예시:

- raw: `"E8FD31EE814ABD78B33361B0A625667518EE2D50"`
- agent 내부: 20바이트 binary

즉 agent에서 hex decode가 필요하다.

### 10-4. local adapter 이름 `VPN` 은 "서버 인증값"이 아니라 "로컬 NIC 이름"이다

이건 헷갈리기 쉽다.

- `VPNGATE` = 원격 서버의 Virtual Hub
- `VPN` user = 원격 접속 사용자명
- `VPN` adapter = 내 PC 안의 로컬 가상 어댑터 이름

같은 문자열이라도 역할이 다르다.

### 10-5. 어댑터 선점 상태를 먼저 봐야 한다

실패 조건이 이미 코드에 있다.

- 어댑터 없음:
  - [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6718)
- 어댑터 비활성:
  - [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6725)
- 같은 어댑터를 다른 active account가 사용 중:
  - [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6760)

그래서 agent는 connect 전에 최소한 아래를 해야 한다.

1. 현재 VLan 목록 조회
2. `VPN` 이 없으면 생성 시도
3. `VPN` 이 있으면 enabled 여부 확인
4. 이미 active session이 쓰고 있으면 다른 free adapter 선택 또는 생성

여기서 중요한 미묘한 점이 하나 더 있다.

- [CtConnect](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6628) 의 자동 생성은 **시스템 전체 VLan 수가 0개일 때만** `VPN` 생성 시도를 한다
- 즉 `VPN` 이 없더라도 다른 VLan이 하나라도 있으면, SoftEther가 내 target adapter를 대신 만들어 주지 않는다

예시:

- 시스템에 VLan이 0개 -> `CtConnect` 가 `VPN` 자동 생성 시도 가능
- 시스템에 `VPN3` 하나만 있고 내가 `VPN` 으로 연결하려 함 -> 자동 생성 아님, 그대로 `ERR_VLAN_FOR_ACCOUNT_NOT_FOUND` 가능

따라서 agent는 **"연결 전에 target adapter 존재 여부를 직접 보장"** 해야 한다.

### 10-6. `Disconnect` 직후 바로 `DeleteAccount` 하면 실패할 수 있다

관련 코드:

- [CtDeleteAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:7156)

실제론 active account면 `ERR_ACCOUNT_ACTIVE` 다.

즉 정리 순서는 이거다.

1. disconnect RPC
2. account/session inactive polling
3. delete RPC

### 10-7. retry 정책은 agent가 다시 정의해야 한다

관련 코드:

- 공식 CLI 기본값:
  - [PcAccountCreate](/tmp/SoftEtherVPN_Stable/src/Cedar/Command.c:4252)
- 실제 session retry 루프:
  - [Session.c](/tmp/SoftEtherVPN_Stable/src/Cedar/Session.c:1605)

실무적으로는 이렇게 보는 게 맞다.

- 공식 GUI/CLI는 사용자가 눈으로 보는 도구라 `INFINITE` 가 편하다
- local agent는 API로 start/stop/cleanup을 다뤄야 하므로, 첫 MVP는 `NumRetry = 0` 이 더 예측 가능하다

쉽게 예시로 말하면:

- GUI 기본값: 실패하면 계속 다시 붙어 보려고 함
- local agent MVP: 실패하면 한 번 결과를 반환하고, 다음 액션은 특궁이 결정함

### 10-8. 첫 패치는 "호환용 profileId 유지"가 더 안전하다

이건 연결 엔진 문제가 아니라, 현재 확장 구조의 의존성 문제다.

지금 코드 기준으로 `profileId` 는 아래 역할을 동시에 하고 있다.

- start guard 입력값
- connect request body
- 상태 표시 텍스트
- meta 문구
- log 문구
- 저장된 config 기본 식별자

그래서 첫 raw 모드 패치에서는 아래 전략이 더 안전하다.

1. 내부 실제 connect payload는 `mode + relay` 로 확장한다
2. 동시에 호환용 `profileId` 도 함께 채운다
3. UI가 전부 raw-aware 로 바뀐 뒤에야 `profileId` 의 의미를 줄인다

예시:

```json
{
  "mode": "softether_vpngate_raw",
  "profileId": "vpngate-18786933-1698",
  "relay": {
    "id": 18786933,
    "ip": "121.138.132.127",
    "selectedSslPort": 1698
  }
}
```

이렇게 가면 기존 로그의 `profileId=...` 문구도 당장 안 깨지고,
raw 모드 payload도 따로 보낼 수 있다.

### 10-9. local agent는 첫 단계에서 singleton 이어야 한다

현재 확장 쪽 stop/status 계약이 singleton 이다.

- stop은 target 없는 global disconnect
- scheduler 상태도 active tunnel 1개만 저장

따라서 첫 구현 규칙은 이거다.

- active VPN 세션은 1개만 허용
- 새 connect 요청이 오면 기존 연결이 완전히 내려간 뒤에만 새 연결 시작
- temp account 여러 개를 병렬로 띄우는 구조는 첫 패치 범위에서 제외

### 10-10. 첫 VLan 설치는 기존 account 설정까지 건드릴 수 있다

관련 코드:

- [CtCreateVLan](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:8562)

실제 동작:

- 새 VLan 설치 후 시스템에 VLan이 정확히 1개뿐이면
- SoftEther가 기존 모든 account의 `DeviceName` 을 그 이름으로 맞춰 준다

쉽게 예시로 말하면:

- 사용자가 원래 `회사VPN`, `집VPN` account를 들고 있었음
- agent가 지금 처음으로 `VPN` 어댑터를 설치함
- 그러면 기존 account의 `DeviceName` 도 `VPN` 으로 정규화될 수 있다

그래서 첫 구현은 아래 중 하나가 더 안전하다.

1. agent 전용 SoftEther Client 환경을 쓴다
2. 최소한 기존 account 존재 여부를 먼저 감지하고 경고한다
3. 첫 VLan 설치가 필요한 환경은 실험기/전용 PC에서만 먼저 검증한다

### 10-11. `GetAccountStatus` 만으로 inactive 완료를 판단하면 안 된다

관련 코드:

- [CtGetAccountStatus](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:6231)
- [CtEnumAccount](/tmp/SoftEtherVPN_Stable/src/Cedar/Client.c:7232)

핵심은 이거다.

- `GetAccountStatus` 는 active session이 있을 때는 풍부한 정보를 준다
- 하지만 inactive가 되면 구조체를 거의 비워서 반환할 수 있다
- 반면 `EnumAccount` 는 해당 account가 살아 있는지, active인지, connected인지 판별하기 좋다

그래서 disconnect 정리 순서는:

1. `Disconnect`
2. `EnumAccount` 에서 해당 temp account의 `Active=false` 확인
3. 그 다음 `DeleteAccount`

이 순서가 가장 안전하다.

### 10-12. 나중에 `PortUDP` 실험을 할 때는 `Hostname` 도 같이 재점검해야 한다

관련 코드:

- [ClientConnectGetSocket](/tmp/SoftEtherVPN_Stable/src/Cedar/Protocol.c:7659)

여기서는 direct R-UDP 분기에서 `StrToIP(&ip, o->Hostname)` 를 쓴다.

즉 나중에 `PortUDP != 0` 실험을 할 때는:

- `Hostname = raw.fqdn` 이 아니라
- `Hostname = raw.ip`

형태가 더 안전하다.

첫 MVP에서 IP를 우선값으로 잡는 이유도 이 판단과 일관된다.

## 11. 현재 기준 추천 구현 순서

1. `selfHostedVpn` connect payload에 `mode` 와 `relay` 를 추가한다.
2. local agent에 `softether_vpngate_raw` 분기를 추가한다.
3. agent가 temp account 이름 규칙을 정한다.
   - 예: `vpngate-${id}-${selectedSslPort}-${sequence}`
4. agent가 먼저 free adapter를 고른다.
   - 예: `VPN` -> 사용 중이면 `VPN2`
5. `Hostname`, `Port`, `HubName=VPNGATE`, `Username=VPN`, `AuthType=ANONYMOUS`, `ProxyType=PROXY_DIRECT`, `CheckServerCert=false`, `PortUDP=0`, `NoUdpAcceleration=true` 로 TCP MVP 연결을 만든다.
6. `NumRetry` 는 첫 MVP에서 `0` 으로 둬서 SoftEther 내부 무한 재시도를 끈다.
7. 연결 성공 시 `publicIpBefore/publicIpAfter/currentPublicIp/activeAdapterName/route changed` 를 지금 scheduler 상태 모델에 그대로 채운다.
8. disconnect 후 inactive 확인 뒤 temp account를 삭제한다.
9. 성공 릴레이 1개와 실패 릴레이 1개로 회귀 테스트한다.
10. 그 다음 단계에서만 `HostUniqueKey` pass-through 와 `PortUDP`/`NoUdpAcceleration` 완화 실험을 다시 진행한다.

구현 순서를 코드로 적으면 거의 이렇게 보면 된다.

```text
startRawVpn(relay):
  rc = ConnectRpc("localhost")
  adapters = EnumVLan(rc)
  adapterName = chooseFreeAdapter(adapters)
  if adapterName does not exist:
    CreateVLan(rc, adapterName)

  accountName = makeTempAccountName(relay.id, relay.selectedSslPort)
  CreateAccount(rc, {
    Hostname = relay.ip,
    Port = relay.selectedSslPort,
    PortUDP = 0,
    NoUdpAcceleration = true,
    HubName = "VPNGATE",
    Username = "VPN",
    AuthType = ANONYMOUS,
    ProxyType = PROXY_DIRECT,
    CheckServerCert = false,
    NumRetry = 0,
    DeviceName = adapterName
  })

  Connect(rc, accountName)

  loop:
    item = find EnumAccount(accountName)
    if item.Active && item.Connected:
      rich = GetAccountStatus(accountName)
      return CONNECTED(rich)
    if item.Active:
      continue CONNECTING
    return ERROR

stopRawVpn(accountName):
  Disconnect(rc, accountName)
  wait until EnumAccount(accountName).Active == false
  DeleteAccount(rc, accountName)
  return IDLE
```

이 pseudocode 수준까지 내려오면 구현자가 더 이상 문서를 "설명서"가 아니라 "체크리스트"처럼 사용할 수 있다.

## 12. 최종 판단

이번 교차검증 기준으로 최종 판단은 아래와 같다.

### 가능한 것

- **SoftEther 오픈소스 재사용형 local agent 구현**
- **raw 1개 릴레이를 특궁에서 클릭해서 실제 연결 시도**
- **연결 전후 공인 IP 변화 확인**

### 아직 첫 단계로 비추천인 것

- **SoftEther/VPN Gate clean-room 자체 연결 엔진**

가장 실무적인 표현으로 정리하면:

**지금 문서 기준으로는 "특궁 -> local agent -> SoftEther Client RPC/임시 account -> 공용 릴레이 1개 연결" 구현 착수 자체는 가능하다. 다만 현재 저장소는 아직 `PortUDP` / `NoUdpAcceleration` 입력을 local agent가 실제로 surface하지 않았으므로, 여기서 말하는 `PortUDP=0 + NoUdpAcceleration=true` 는 "현재 보장값"이 아니라 "패치 목표값"으로 읽어야 한다. 즉 착수 조건은 `free adapter preflight + fresh temp account + explicit cleanup` 이고, TCP-only 보장은 먼저 옵션 입력 경로를 추가한 뒤에야 성립한다.**

그리고 이 구현은 "역공학으로 프로토콜을 새로 짜는 것"이 아니라,
**공식 오픈소스 코어가 이미 제공하는 계정/세션/연결 경로를 raw feed와 연결하는 작업**이다.

## 13. 병렬 3터널 Connected + route 전환 설계 검증

이 섹션은 사용자가 바로 다음 단계로 원한 아래 설계를, **현재 저장소 코드 + 공식 SoftEther 오픈소스 + 2026-04-19 실측** 으로 다시 검증한 결과다.

- 1. `VPN2/VPN3/VPN4` 같은 별도 NIC에 raw 릴레이 3개를 병렬로 `Connected` 까지 올림
- 2. 실제 출구 IP 확인은 하나씩 route 우선순위를 바꿔가며 새 요청으로 검증
- 3. 확인이 끝나면 원래 route 우선순위를 복구

쉽게 예시로 말하면:

- 지금 1개 연결은 `하나 붙이고 IP 확인`
- 이번 확장 설계는 `3개를 먼저 붙여 놓고, 어느 터널을 기본 출구로 쓸지만 바꿔 가며 확인`

### 13-1. 이번 추가 결론

결론부터 말하면, **구조적으로는 가능** 하다. 다만 **현재 `selfHostedVpn` 단일 상태기계에 작은 패치 1개 넣는 수준은 아니다.**

이번 추가 검증으로 확정된 사실은 이렇다.

- 현재 repo의 local agent / scheduler / popup은 끝까지 **단일 터널 상태 모델** 이다.
- 공식 SoftEther 클라이언트는 실제로 **OS route를 만지는 로직** 을 갖고 있다.
- 그런데 account detail의 `/NOTRACK:yes` 옵션을 쓰면, **물리 default route를 지우지 않고도 VPN default route가 같이 살아남는 케이스** 를 이번 PC에서 실제로 확인했다.
- 같은 방식으로 `VPN3`, `VPN4` 2개를 동시에 올렸을 때도 **두 VPN default route가 공존** 하는 것을 실제로 확인했다.

즉 이번 turn 기준으로 더 정확한 표현은 이거다.

- `병렬 3개 Connected`:
  - 가능성이 아니라 **현실적인 설계 후보**
- `route metric만 바꿔서 서로 다른 출구 IP 2개를 눈으로 교차 확인`:
  - 아직 이 turn에서 최종 실측 완료까지는 못 갔다
- `현재 single-agent 계약을 거의 안 건드리고 바로 붙이기`:
  - 불가

### 13-2. 현재 저장소 line-by-line 대조 결과

#### 13-2-1. local agent는 현재 single-slot 상태기계다

[projects/self_hosted_vpn_agent/server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:54) 에서 agent는 `managedNicName` 1개만 들고 시작하고, [server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:65) 에서 state도 `buildInitialState(this.managedNicName)` 1개로 만든다.

[server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:1285) 의 초기 state 필드는 아래처럼 전부 1개씩이다.

- `phase`
- `operationId`
- `profileId`
- `accountName`
- `activeRelayId`
- `activeRelayIp`
- `activeRelayFqdn`
- `activeSelectedSslPort`
- `activeAdapterName`
- `baseline`

쉽게 예시로 말하면:

- 지금 구조는 `주차칸 1개` 다
- 우리가 하려는 건 `주차칸 3개 + 현재 출차 중인 칸 1개 표시` 다

#### 13-2-2. connect/disconnect 흐름도 1개 account만 가정한다

[server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:276) 의 `connectProfile()` 과 [server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:314) 의 `connectRawRelay()` 는 둘 다 아래 패턴이다.

- `operationId` 1개 세팅
- `phase` 1개 세팅
- `accountName` 1개 세팅
- `activeAdapterName` 1개 세팅
- `baseline` 1개 세팅

[server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:393) 이후 raw connect 본문도 최종적으로 `accountName`, `activeAdapterName`, `activeSelectedSslPort` 를 단일 값으로 덮어쓴다.

즉 지금 `POST /v1/vpn/connect` 를 3번 병렬 호출하면, 마지막 호출이 이전 상태를 덮어쓰는 방향으로 깨질 가능성이 높다.

#### 13-2-3. 네트워크 레이어는 지금 read-only다

[projects/self_hosted_vpn_agent/lib/network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs:110) 부터 보면 현재 observer는 아래만 읽는다.

- `Get-NetAdapter`
- `Get-NetIPConfiguration`
- `Get-NetRoute -AddressFamily IPv4`
- `Get-NetRoute -AddressFamily IPv6`

[network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs:253) 의 `compareBaseline()` 도 결국 `route key가 바뀌었는지` 만 비교한다.

중요한 점은, 현재 repo에는 아래가 없다.

- `Set-NetIPInterface`
- `New-NetRoute`
- `Remove-NetRoute`
- `route add/change/delete`

즉 지금은 `길을 읽는 망원경` 만 있고, `길을 바꾸는 핸들` 은 없다.

#### 13-2-4. SoftEther CLI 래퍼도 multi-slot coordinator는 없다

[projects/self_hosted_vpn_agent/lib/softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:364) 의 `run()` 은 내부 queue로 `vpncmd` 호출을 직렬화한다.

[softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:418), [softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:431), [softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:488), [softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:536), [softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:540), [softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:544) 는 계정/어댑터 CRUD primitive는 제공하지만, 아래는 없다.

- slot 개념
- 3개 account 생명주기 관리
- route owner 개념
- metric restore 개념
- 검증 라운드 개념

즉 부품은 있는데, 3슬롯 orchestration이 없다.

#### 13-2-5. scheduler와 popup도 single-card UI다

[features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:35) 부터 보면 scheduler도 아래 값을 단일 필드로 유지한다.

- `phase`
- `operationId`
- `activeProfileId`
- `activeRelayId`
- `activeRelayIp`
- `activeRelayFqdn`
- `activeSelectedSslPort`
- `activeAdapterName`
- `connectedAt`

[scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:291) 의 `applyAgentStatus()` 도 status 객체 1개만 먹는다.

[popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:167) 에서 popup DOM 역시 `activeAdapterText`, `relayText`, `currentPublicIpText` 같은 단일 텍스트 칸 1세트만 들고, [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:2725) 의 `updateSelfHostedVpnUI()` 도 그 1세트만 채운다.

즉 연결 엔진만 3개로 바꾸면 끝나는 게 아니라, 최소한 test mode에서는 status contract도 따로 만들어야 한다.

### 13-3. 공식 SoftEther 오픈소스 실제 로직 대조

이번 turn에서 공식 `SoftEtherVPN_Stable` 저장소를 다시 받아서 commit `ed17437af9719ac66acab30faa29e375d613c35f` 기준으로 확인했다.

#### 13-3-1. `AccountCreate` 는 원래부터 NIC 지정형이다

공식 source의 `PcAccountCreate` 는 아래를 직접 받는다.

- `SERVER`
- `HUB`
- `USERNAME`
- `NICNAME`

참고:

- `src/Cedar/Command.c:4217-4266`
- GitHub: <https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/ed17437af9719ac66acab30faa29e375d613c35f/src/Cedar/Command.c#L4217-L4266>

이 함수는 내부 기본값도 같이 넣는다.

- `NumRetry = INFINITE`
- `RetryInterval = 15`
- `MaxConnection = 1`
- `UseEncrypt = true`
- `AdditionalConnectionInterval = 1`
- `DeviceName = NICNAME`

즉 공식 구현 관점에서도 `relay 1개 = account 1개 = NIC 1개` 모델은 자연스럽다.

#### 13-3-2. 공식 클라이언트는 실제로 OS route를 만진다

공식 `ROUTE_TRACKING` 구조체에는 아래가 들어 있다.

- `RouteToServer`
- `DefaultGatewayByVLan`
- `RouteToDefaultDns`
- `RouteToEight`
- `RouteToNatTServer`
- `DeletedDefaultGateway`

참고:

- `src/Cedar/VLanWin32.h:117-138`
- GitHub: <https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/ed17437af9719ac66acab30faa29e375d613c35f/src/Cedar/VLanWin32.h#L117-L138>

`RouteTrackingStart()` 는 실제로 아래를 수행한다.

- 서버 IP로 가는 static route 추가
- DNS route 추가
- Azure real server route 추가
- DHCP release/renew
- DNS cache flush

참고:

- `src/Cedar/VLanWin32.c:584-799`
- GitHub: <https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/ed17437af9719ac66acab30faa29e375d613c35f/src/Cedar/VLanWin32.c#L584-L799>

`RouteTrackingMain()` 은 더 직접적이다.  
`0.0.0.0/0` default gateway를 스캔한 뒤, 자기 VLAN이 default gateway가 되어야 한다고 판단하면 **다른 interface의 default gateway를 지운다.**

참고:

- `src/Cedar/VLanWin32.c:366-537`
- GitHub: <https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/ed17437af9719ac66acab30faa29e375d613c35f/src/Cedar/VLanWin32.c#L366-L537>

`RouteTrackingStop()` 은 세션 종료 시 삭제해 둔 default gateway를 복구하려고 시도한다.

참고:

- `src/Cedar/VLanWin32.c:801-990`
- GitHub: <https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/ed17437af9719ac66acab30faa29e375d613c35f/src/Cedar/VLanWin32.c#L801-L990>

즉 중요한 해석은 이거다.

- `VPNGate 목록 -> 2차 API로 route 바꾸기` 가 아니다
- **SoftEther 클라이언트 세션 자체가 로컬 Windows route를 조정한다**

### 13-4. `/NOTRACK=yes` 가 이번 설계의 핵심 실마리다

공식 help text에는 `/NOTRACK:yes` 가 이렇게 설명된다.

- `"Specify \"yes\" will disable the adjustments of routing table. Normally \"no\" is specified."`

참고:

- `src/bin/hamcore/strtable_en.stb:6658-6668`
- GitHub: <https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/ed17437af9719ac66acab30faa29e375d613c35f/src/bin/hamcore/strtable_en.stb#L6658-L6668>

또 공식 `Session.c` 에서는 `NoRoutingTracking` 이 켜지면 `ClientModeAndUseVLan` 을 false로 내린다.

참고:

- `src/Cedar/Session.c:2015-2020`
- GitHub: <https://github.com/SoftEtherVPN/SoftEtherVPN_Stable/blob/ed17437af9719ac66acab30faa29e375d613c35f/src/Cedar/Session.c#L2015-L2020>

처음에는 이걸 보고 "`NOTRACK=yes` 면 route도 안 생기고 그냥 unusable 아닐까?" 를 의심하는 게 맞다.

그런데 이번 PC 실측은 오히려 설계 쪽에 좋은 결과가 나왔다.

#### 13-4-1. 실측 1: `NOTRACK=yes` 단일 account

실험 조건:

- relay:
  - `219.100.37.114:443`
- NIC:
  - `VPN3`
- account detail:
  - `/NOTRACK:yes`

실측 결과:

- account 상태:
  - `Connected`
- 공인 IPv4:
  - 연결 전 `1.210.3.152`
  - 연결 후 `219.100.37.240`
- IPv4 default route:
  - 연결 전:
    - `이더넷` 1개
  - 연결 후:
    - `이더넷`
    - `VPN3 - VPN Client`

쉽게 예시로 말하면:

- `NOTRACK=no` 는 공식 SoftEther가 다른 default gateway를 밀어내며 길을 정리하려 드는 모드
- `NOTRACK=yes` 단일 실측은 `기존 길은 남기고, VPN 길도 하나 더 생긴 상태` 로 보였다

이건 병렬 다중 터널 설계에 유리하다.

#### 13-4-2. 실측 2: `NOTRACK=yes` 2개 동시 account

실험 조건:

- relay:
  - 둘 다 `219.100.37.114:443`
- NIC:
  - `VPN3`
  - `VPN4`
- account detail:
  - 둘 다 `/NOTRACK:yes`

실측 결과:

- `VPN3` account:
  - `Connected`
- `VPN4` account:
  - `Connected`
- route table:
  - `이더넷`
  - `VPN3 - VPN Client`
  - `VPN4 - VPN Client`

중요한 해석은 이거다.

- 적어도 이번 PC와 이 릴레이 기준에서는
- **`NOTRACK=yes` 2개 동시 연결이 서로의 default route를 즉시 삭제하지 않았다**

즉 `3개를 먼저 Connected까지 올려 놓는` 설계가 공상은 아니다.

#### 13-4-3. 아직 남아 있는 실측 공백

이번 turn에서 **서로 다른 출구 IP를 가진 2개 릴레이를 동시에 올린 뒤, metric 전환만으로 IP가 A -> B로 바뀌는 것** 까지는 최종 완료하지 못했다.

그래서 문서상 최종 정리는 이렇게 해야 맞다.

- `병렬 connected 자체`:
  - 실측으로 상당 부분 뒷받침됨
- `metric 전환만으로 exit IP 교차 검증`:
  - 아직 마지막 1회 direct proof는 남음

이걸 숨기고 "완전히 끝났다"고 쓰면 과장이다.

### 13-5. 구현 권장 방향

현재 single-agent를 바로 뜯지 말고, **병렬 테스트 전용 coordinator** 를 먼저 따로 두는 게 맞다.

권장 1차 구조는 이거다.

```json
{
  "phase": "MULTI_PROBE",
  "slotCount": 3,
  "slots": [
    {
      "slotId": "slot-1",
      "nicName": "VPN2",
      "interfaceAlias": "VPN2 - VPN Client",
      "accountName": "DCDSVPNGATE-...",
      "relay": {
        "id": "...",
        "ip": "...",
        "fqdn": "...",
        "selectedSslPort": 443
      },
      "phase": "CONNECTED",
      "connectedAt": "2026-04-19T...",
      "lastErrorCode": "",
      "lastErrorMessage": ""
    }
  ],
  "routeOwnerSlotId": "slot-2",
  "verification": {
    "preferredFamily": "ipv4",
    "provider": "api.ipify.org"
  }
}
```

핵심은 `single connect status` 와 `multi probe status` 를 분리하는 것이다.

예를 들면:

- 기존:
  - `/v1/vpn/connect`
  - `/v1/vpn/status`
- 신규 test mode:
  - `/v1/vpn/parallel-probe/start`
  - `/v1/vpn/parallel-probe/status`
  - `/v1/vpn/parallel-probe/stop`

이렇게 나누면 기존 popup 흐름을 깨지 않고 실험할 수 있다.

2026-04-19 현재 실제 패치 기준 구현 위치는 아래다.

- local agent endpoint:
  - [projects/self_hosted_vpn_agent/server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs)
  - `GET /v1/vpn/parallel-probe/status`
  - `POST /v1/vpn/parallel-probe/start`
  - `POST /v1/vpn/parallel-probe/stop`
- extension scheduler/API:
  - [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js)
  - [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js)
- popup/background 액션:
  - [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js)
  - [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js)
  - [popup/popup.html](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.html)

쉽게 예시로 말하면:

- 기존 toggle:
  - 단일 `/v1/vpn/connect` 용
- 새 버튼 3개:
  - `병렬 3슬롯 시작`
  - `병렬 상태 새로고침`
  - `병렬 시험 종료`

즉 single-flow는 그대로 두고, parallel-probe만 옆으로 새 계약을 붙인 형태다.

### 13-6. route 전환은 이렇게 잡는 게 제일 현실적이다

이번 turn에서 Windows cmdlet 존재도 다시 확인했다.

- `Get-NetIPInterface`
- `Set-NetIPInterface`
- `Get-NetRoute`

따라서 1차 구현은 `default route add/delete` 를 직접 흉내 내기보다, **interface metric 우선순위 전환 + route 수렴 확인** 으로 가는 게 맞다.

쉽게 예시로 말하면:

- baseline:
  - `이더넷 = 25`
  - `VPN2 = 1`
  - `VPN3 = 1`
  - `VPN4 = 1`
- slot-2 검증:
  - `이더넷 = 50`
  - `VPN2 = 60`
  - `VPN3 = 5`
  - `VPN4 = 60`
- 새 IPv4 요청 전송
- 결과 저장
- 다음 slot으로 metric 재조정

여기서 중요한 건 2개다.

- 반드시 **새 요청** 이어야 한다
- metric 변경 후 **실제 route table 재조회** 가 필요하다

왜냐하면 기존 소켓은 이전 route를 계속 쓸 수 있기 때문이다.

### 13-7. egress 검증은 기존 `/v1/vpn/egress` 를 그대로 쓰면 안 된다

[projects/self_hosted_vpn_agent/server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:165) 의 `/v1/vpn/egress` 는 stale cache 우선이고, [projects/self_hosted_vpn_agent/lib/network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs:10) 의 public IP cache TTL도 `5000ms` 다.

또 [network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs:291) 의 provider 순서는 `api64.ipify.org` -> `api.ipify.org` -> `ifconfig.me` 라서, 환경에 따라 IPv6가 먼저 잡힐 수도 있다.

그래서 병렬 route-switch 검증용 helper는 따로 두는 게 맞다.

권장 조건:

- IPv4 강제
- stale cache 금지
- slot 전환 직후 새 TCP/TLS 연결 사용

쉽게 예시로 말하면:

- 기존 status card용:
  - `최근 상태를 빨리 보여주는 캐시 응답`
- 병렬 전환 검증용:
  - `metric 바꾼 뒤 진짜로 어느 출구가 타는지 확인하는 fresh IPv4 probe`

### 13-8. 지금 바로 패치할 때의 권장 순서

1. 기존 `/v1/vpn/connect` / popup 계약은 그대로 둔다.
2. 병렬 실험 전용 coordinator를 별도 파일로 만든다.
3. 고정 NIC pool `VPN2`, `VPN3`, `VPN4` 를 slot에 바인딩한다.
4. slot account 생성 시 첫 버전은 `/NOTRACK:yes` 로 둔다.
5. `Connected` 판정은 `AccountList + AccountStatusGet` 둘 다 본다.
6. route baseline은 `Get-NetIPInterface + Get-NetRoute` 둘 다 저장한다.
7. slot별 검증 때만 metric을 바꾼다.
8. 검증 직후 fresh IPv4 probe를 날린다.
9. 결과를 slot별로 기록한다.
10. 끝나면 metric restore 후 모든 temp account를 정리한다.

### 13-9. 이번 설계에서 특히 조심할 점

#### 13-9-1. `NOTRACK=yes` 는 유력한 실마리지만 만능이라고 단정하면 안 된다

이번 PC 실측에서는 잘 나왔지만, 공식 source상 `NoRoutingTracking` 은 `ClientModeAndUseVLan` 분기에 직접 걸린다.

즉 안전한 표현은 이거다.

- `이번 환경에서는 1개/2개 동시 연결에 유리하게 나왔다`
- `모든 릴레이/모든 NIC/모든 Windows 상태에서 항상 동일하다고 단정하면 안 된다`

#### 13-9-2. 서로 다른 릴레이 2개의 exit IP 교차 증명은 아직 마지막 1회가 남았다

이번 turn에서 확보한 건:

- 단일 `/NOTRACK=yes` 실측 성공
- 2개 동시 `/NOTRACK=yes` 실측 성공

아직 남은 건:

- `slot A metric 우선 -> exit IP A`
- `slot B metric 우선 -> exit IP B`

이건 다음 patch 직전 마지막 현장 검증 항목으로 남기는 게 맞다.

#### 13-9-3. popup 기존 카드에 바로 억지로 넣으면 오히려 더 헷갈린다

현재 popup은 single-card다.  
그러니 multi probe를 넣는 첫 화면은 아래 중 하나가 맞다.

- 별도 test panel
- 별도 report export
- 기존 카드 아래 slot list 추가

지금 카드 1장에 `현재 active slot`, `3개 connected slot`, `route owner`, `검증 결과` 를 한꺼번에 구겨 넣으면 사용자가 더 헷갈린다.

#### 13-9-4. 현재 저장소 구현은 아직 `TCP-only` 를 실제로 강제하지 않는다

문서 앞부분에서는 첫 MVP 목표를 `PortUDP=0 + NoUdpAcceleration=true` 로 잡았지만, **현재 repo 구현은 아직 그 목표를 코드로 강제하지 않는다.**

현재 local wrapper를 실제로 보면:

- [projects/self_hosted_vpn_agent/lib/softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:488) 의 `createAccount()` 는 `SERVER/HUB/USERNAME/NICNAME` 만 넣는다.
- [softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:513) 의 `setAccountDetails()` 는 `/MAXTCP`, `/INTERVAL`, `/TTL`, `/NOTRACK`, `/NOQOS` 까지만 넣고, `PortUDP` 나 `NoUdpAcceleration` 은 건드리지 않는다.
- 반대로 [softether_cli.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/softether_cli.mjs:477) 은 `UDP Acceleration is Active` 를 읽어서 상태값으로 노출한다.
- 실제 실측에서도 `AccountStatusGet` 결과가 `UDP Acceleration is Active = Yes` 로 나왔다.

공식 source는 이 필드를 실제로 갖고 있다.

- `src/Cedar/Connection.h`:
  - `PortUDP`
  - `NoUdpAcceleration`
- `src/Cedar/Client.c`:
  - RPC pack/unpack에 `PortUDP`, `NoUdpAcceleration` 존재
- `src/Cedar/Protocol.c`:
  - `PortUDP != 0` 이면 R-UDP direct 경로 가능
  - `NoUdpAcceleration == false` 면 UDP acceleration 초기화 가능

즉 지금 정확한 표현은 이거다.

- 문서의 `TCP-only` 는 **설계 목표**
- 현재 저장소 raw connect는 **아직 그 목표를 보장하지 않는 구현**

쉽게 예시로 말하면:

- 문서 초안:
  - `첫 버전은 고속도로로 안 빠지고 일반도로(TCP)만 탄다`
- 현재 코드:
  - `목적지는 맞게 넣지만, 고속도로 진입 차단 장치는 아직 안 달려 있다`

그래서 이후 성공률/실패율을 해석할 때도 "`지금 구현이 strict TCP-only였는데도 안 붙는다`" 라고 단정하면 안 된다.

#### 13-9-5. route 전환/복구의 기준 키는 `InterfaceAlias` 가 아니라 `ifIndex` 여야 한다

[projects/self_hosted_vpn_agent/lib/network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs:120) 부터 보면 현재 observer는 `InterfaceAlias` 와 `InterfaceIndex` 를 같이 읽고, [network_state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/lib/network_state.mjs:191) 의 `normalizeRoute()` 도 `ifIndex` 와 `interfaceAlias` 를 둘 다 유지한다.

이건 좋은 출발점이지만, 병렬 route-switch 쪽에서는 **표시용 이름과 제어용 키를 분리** 해야 한다.

왜냐하면:

- `InterfaceAlias` 는 로컬 언어 영향을 받는다
- PowerShell -> JSON -> WSL/Node 경로에서 한글 alias가 깨질 수 있다
- 사용자가 NIC 이름을 바꿀 수도 있다

반면 `ifIndex` 는 route/metric 조작의 기준 키로 훨씬 안정적이다.

그래서 권장 기준은 이거다.

- UI 표시:
  - `InterfaceAlias`
- 내부 restore / 비교 / slot binding:
  - `ifIndex`

쉽게 예시로 말하면:

- 화면에는 `이더넷`, `VPN3 - VPN Client` 를 보여줘도 된다
- 실제 route owner 판정은 `ifIndex=18`, `ifIndex=42` 같은 숫자로 잡아야 덜 깨진다

#### 13-9-6. 기존 single-agent cleanup/refresh helper를 그대로 재사용하면 multi-slot을 스스로 깨뜨릴 수 있다

현재 single-agent helper 중에는 **병렬 slot과 직접 충돌하는 함수** 가 이미 있다.

- [projects/self_hosted_vpn_agent/server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:656) 의 `cleanupManagedInactiveAccounts()`:
  - disconnected managed account를 전역으로 훑어서 삭제한다
- [server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:923) 의 `performRefresh()`:
  - tracked account가 없는데 active managed account가 여러 개면 `MULTIPLE_MANAGED_ACCOUNTS` 로 본다
- [server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:1045) 의 `resolveTrackedAccount()`:
  - `managed_raw` 이면 첫 번째 active managed account 하나만 택한다

즉 지금 helper를 그대로 가져다 쓰면 이런 일이 생길 수 있다.

- slot-1, slot-2, slot-3 를 올려 둠
- single refresh가 들어옴
- `첫 번째 active managed account` 하나만 tracked로 잡힘
- 나머지는 `unexpected multiple` 또는 cleanup 대상으로 오인됨

쉽게 예시로 말하면:

- 원래 helper는 `주차칸 1개 건물 관리인`
- 우리가 하려는 건 `주차칸 3개를 번호표로 따로 관리하는 주차타워`

그래서 결론은 분명하다.

- multi-probe coordinator는 기존 `selfHostedVpn` state와 **저장 키부터 분리**
- account cleanup도 **slot scope** 로 제한
- tracked account도 `global 1개` 가 아니라 `slot별 1개`

#### 13-9-7. background의 "상태 복원" 로그는 실제 reconnect/resume을 의미하지 않는다

[background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:1714) 의 `resumeStandaloneScheduler()` 는 로그를 남긴 뒤 `ensureRunLoop()` 를 호출한다.  
그런데 [features/self-hosted-vpn/scheduler.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/scheduler.js:481) 의 `ensureRunLoop()` 는 실제로 비어 있다.

즉 현재 self-hosted-vpn에서의 "상태 복원" 은 정확히 말하면:

- 저장된 상태를 읽음
- UI에 지난 상태를 다시 보여줄 수 있음
- 하지만 연결 작업이나 probe 라운드를 재개하지는 않음

이 차이를 문서에 명확히 적어 두지 않으면, 나중에 이런 오해가 생긴다.

- popup 로그:
  - `저장된 자체 VPN 테스트 상태 복원`
- 개발자 해석:
  - `아, background가 probe를 다시 돌리나 보다`
- 실제:
  - `아니다. 저장 상태만 복원했고 long-running loop는 재개하지 않았다`

그래서 병렬 probe는 반드시 아래 중 하나를 택해야 한다.

- 명시적 재시작 API
- 재개 가능한 coordinator 상태기계
- 아니면 cold restart를 정상 정책으로 문서화

#### 13-9-8. 현재 raw 입력의 `udpPort` / `hostUniqueKey` 는 UI와 API를 지나가지만 실제 연결에는 아직 반영되지 않는다

현재 호출 체인을 그대로 따라가 보면:

- [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1071) 에서 `relaySnapshot.udpPort`, `relaySnapshot.hostUniqueKey` 를 저장한다
- [features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:113) 의 `buildConnectRequestBody()` 도 이 값을 `relay` payload에 넣는다
- [projects/self_hosted_vpn_agent/server.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:1375) 의 `normalizeConnectRequest()` 도 이 값을 파싱해 state에 싣는다

그런데 실제 raw 연결을 만드는 [executeRawRelayConnect()](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:436) 는:

- `serverHost`
- `serverPort`
- `hubName=VPNGATE`
- `username=VPN`
- `nicName`

까지만 `AccountCreate` 에 넣고, 이후 [setAccountDetails()](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/server.mjs:452) 에서도 `udpPort` / `hostUniqueKey` 를 쓰지 않는다.

즉 지금 정확한 상태는 이거다.

- UI 입력:
  - 있음
- API payload:
  - 있음
- agent normalize:
  - 있음
- 실제 SoftEther account 설정:
  - 아직 없음

쉽게 예시로 말하면:

- 현재는 `택배 송장에 참고 메모를 적어 놓기만 한 상태`
- 실제 배송 기사에게 그 메모를 읽혀서 경로를 바꾸는 단계는 아직 안 붙어 있다

그래서 지금 raw 성공/실패를 해석할 때도:

- `udpPort를 넣었는데도 안 붙는다`
- `hostUniqueKey를 넣었는데도 반영이 안 된다`

가 아니라, **현재 구현은 애초에 그 두 값을 연결 엔진에 전달하지 않는다** 고 보는 게 맞다.

#### 13-9-9. popup의 일반 상태조회 경로는 사용자가 저장한 `requestTimeoutMs` 를 끝까지 존중하지 않는다

[features/self-hosted-vpn/api.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/features/self-hosted-vpn/api.js:52) 는 저장값 `requestTimeoutMs` 를 config에 넣고, [popup/popup.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/popup/popup.js:1078) 도 이 값을 저장한다.

그런데 background의 일반 상태조회 경로를 보면:

- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:340) 의 `getSelfHostedVpnPollingTimeoutMs()` 는 설정값을 읽은 뒤
- [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:348) 에서 `Math.min(..., 3000)` 으로 다시 잘라 버린다
- 그래서 [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:375) 의 `getAllStatus` 나 [background/background.js](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/background/background.js:595) 의 `getStatus` 경로는 결국 `3000ms` 상한으로 polling 한다

즉 사용자가 popup에서 예를 들어:

- `requestTimeoutMs = 5000`

을 저장해도, 일반 상태조회 경로는 실제로는:

- `3000ms` 까지만 기다린다

이건 사용자가 봤던 아래 증상과도 직접 연결된다.

- `최근 오류: local agent 요청 시간 초과 (3000ms)`
- `AGENT_UNAVAILABLE`

쉽게 예시로 말하면:

- 설정 화면:
  - `5초까지 기다려 주세요`
- 일반 polling 코드:
  - `아니, 3초만 기다릴게`

그래서 병렬 probe와 상관없이, **현재 single-flow 상태 UI도 timeout 튜닝 체감이 제한되는 구조** 다.

### 13-10. 정적 검증 체크리스트

아래는 실제 patch 전에 line-by-line로 다시 볼 항목들이다.

- slot 3개가 같은 `managedNicName` 을 공유하지 않는가
- slot state와 global state가 서로 덮어쓰지 않는가
- `operationId` 가 slot별/round별로 분리되는가
- temp account 이름 충돌이 없는가
- 같은 relay IP에 다른 port일 때도 slot key가 구분되는가
- 같은 relay를 서로 다른 NIC에 붙일 때 cleanup 충돌이 없는가
- `AccountList` 에는 있는데 `AccountStatusGet` 이 잠깐 실패하는 케이스를 재시도하는가
- `Connected` 직후 `activeAdapterName` 대신 실제 Windows `InterfaceAlias` 를 별도로 수집하는가
- `VPN3` 와 `VPN3 - VPN Client` 를 혼동하지 않는가
- `Get-NetRoute` 결과가 1개 object와 array 사이를 오갈 때 정상 파싱되는가
- route metric과 interface metric을 따로 저장하는가
- restore 시 `AutomaticMetric Enabled/Disabled` 원래 상태를 복원하는가
- 물리 NIC metric을 올린 뒤 원복 실패하면 안전하게 복구하는가
- IPv4 route만 바꾸고 IPv6 probe가 응답해 버리는 경우를 막는가
- egress probe가 stale cache를 읽지 않는가
- egress probe가 keep-alive 재사용으로 이전 route를 타지 않는가
- metric 변경 직후 route table 수렴 시간을 기다리는가
- 수렴 전 probe를 쏘지 않는가
- slot A가 connected인데도 default route가 안 생긴 경우를 감지하는가
- slot B가 connected인데도 default route가 안 생긴 경우를 감지하는가
- 하나의 slot만 실패했을 때 나머지 slot을 유지하는가
- 한 slot cleanup 실패가 전체 round를 망치지 않는가
- `vpncmd` queue 직렬화 때문에 polling이 너무 빽빽해지지 않는가
- background resume 로그가 병렬 probe 로그를 덮어쓰지 않는가
- popup 새로고침이 병렬 probe 상태를 단일 상태로 오해하지 않는가
- scheduler 저장 포맷과 multi probe 저장 포맷이 같은 키를 공유하지 않는가
- 현재 wrapper가 `PortUDP` / `NoUdpAcceleration` 을 실제로 세팅하지 않는다는 점을 성공률 해석에 반영했는가
- route/metric restore 키를 `InterfaceAlias` 문자열이 아니라 `ifIndex` 중심으로 잡았는가
- 기존 `cleanupManagedInactiveAccounts()` / `performRefresh()` / `resolveTrackedAccount()` 를 병렬 slot에 재사용하지 않는가
- "상태 복원" 로그와 실제 probe 재개를 혼동하지 않는가
- `relay.udpPort` / `relay.hostUniqueKey` 가 실제 연결 엔진까지 전달되는지와, 단지 payload에만 있는 상태인지를 구분했는가
- 일반 popup polling이 `requestTimeoutMs` 를 3000ms로 다시 clamp한다는 점을 장애 해석에 반영했는가
- report에 slot별 relay/IP/port/error가 모두 남는가
- exit IP 검증 실패 시 route snapshot이 같이 남는가
- restore 후 실제 default route가 baseline으로 돌아왔는지 재확인하는가
- test 도중 사용자가 수동으로 Manager에서 account를 건드렸을 때 감지하는가
- NIC가 disabled 상태면 slot을 즉시 fail-fast 하는가
- `Set-NetIPInterface` 권한 오류를 명확히 surface 하는가
- 같은 국가 relay끼리 출구 IP가 비슷해서 사람이 오해하지 않도록 raw IP를 그대로 남기는가
- relay 1개가 오래된 snapshot이라 실패해도 전체 설계를 실패로 오판하지 않는가
- 10분 feed 갱신 중 relay 정보가 바뀌어도 현재 round는 snapshot 기준으로 유지하는가
- disconnect 후 temp account 삭제가 누락되지 않는가
- temp account 삭제는 했지만 default route restore가 안 된 상태를 잡아내는가

### 13-11. 이번 추가 섹션 기준 Go / No-Go

이번 추가 검증 기준으로는 이렇게 정리하는 게 맞다.

- Go:
  - `병렬 3슬롯 test coordinator` 설계/패치 시작
  - 첫 버전은 `/NOTRACK:yes` 기반
  - first-class 목표는 `3개 Connected 유지 + route owner 전환 기록`
- Conditional Go:
  - `서로 다른 두 exit IP를 metric 전환만으로 확실히 교차 확인`
  - 이건 첫 patch 직후 바로 실측
- No-Go:
  - 기존 single `/v1/vpn/connect` 계약 위에 억지로 3개 병렬 state를 덮어씌우는 것

가장 쉬운 예시로 정리하면 이렇다.

- 하면 되는 것:
  - `multi-probe 전용 모드` 를 새로 만든다
  - `VPN2/VPN3/VPN4` 에 `/NOTRACK=yes` raw account를 올린다
  - slot별로 metric을 바꿔가며 fresh IPv4 요청으로 출구를 본다
- 지금 하면 안 되는 것:
  - 기존 `selfHostedVpn` 단일 카드에 3개 state를 그대로 우겨 넣는다
  - 기존 `/v1/vpn/status` 1개 응답으로 multi-slot을 억지로 표현한다
