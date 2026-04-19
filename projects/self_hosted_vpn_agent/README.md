# Self-hosted VPN Local Agent

이 폴더는 `특궁 -> background -> localhost agent -> SoftEther VPN Client` 흐름을 위한 로컬 에이전트입니다.

쉽게 예시로 말하면:

- popup에서 raw 릴레이 `121.138.132.127:1698` 를 저장
- 확장이 `POST /v1/vpn/connect` 를 localhost 로 호출
- 이 agent가 `vpncmd.exe` 로 임시 SoftEther 계정을 만들고 연결
- 연결 전후 공인 IP와 기본 route 변화를 다시 읽어 확장 UI에 반환

## 실행

```bash
node projects/self_hosted_vpn_agent/server.mjs
```

기본값:

- 주소: `http://127.0.0.1:8765`
- SoftEther CLI 경로:
  - Windows Node: `C:\Program Files\SoftEther VPN Client\vpncmd.exe`
  - WSL Node: `/mnt/c/Program Files/SoftEther VPN Client/vpncmd.exe`
- 관리용 가상 어댑터 이름: `VPN2`
- 상태 파일: OS temp 디렉터리의 `dc-defense-suite/self-hosted-vpn-agent-state.json`

## 환경변수

- `HOST`
- `PORT`
- `SELF_HOSTED_VPN_TOKEN`
- `SELF_HOSTED_VPN_NIC_NAME`
- `SELF_HOSTED_VPN_STATE_FILE`
- `SELF_HOSTED_VPN_VPNCMD_PATH`

예시:

```bash
SELF_HOSTED_VPN_TOKEN=test-token \
SELF_HOSTED_VPN_NIC_NAME=VPN2 \
node projects/self_hosted_vpn_agent/server.mjs
```

## 주의

- 이 구현은 첫 단계에서 `vpncmd.exe` 기반 래퍼입니다.
- raw 모드에서는 SoftEther temp account를 `DCDSVPNGATE-...` 이름으로 만듭니다.
- 수동으로 연결한 다른 SoftEther account가 이미 `Connected/Connecting` 상태면, 파생 충돌을 피하려고 새 연결을 거부합니다.
- 관리용 NIC는 기본적으로 `VPN2` 를 씁니다. SoftEther Windows NIC 이름은 `VPN`, `VPN2`, `VPN3` 같은 형식만 허용하므로 `DCDSVPN` 같은 이름은 생성 자체가 실패합니다.
- 실제 검증 기준으로 `219.100.37.114:443` raw 릴레이는 local agent 경로에서도 연결과 IP 변경이 확인됐습니다.

## 자체 검사

```bash
node projects/self_hosted_vpn_agent/test_agent.mjs
```

최신 official raw feed 후보를 몇 개 순차 시험하려면:

```bash
node projects/self_hosted_vpn_agent/probe_latest_vpngate_relays.mjs --limit=3
```

local agent 경로로 같은 시험을 하려면, 먼저 server를 띄운 뒤 `--via-agent` 를 붙입니다.

```bash
node projects/self_hosted_vpn_agent/server.mjs
node projects/self_hosted_vpn_agent/probe_latest_vpngate_relays.mjs --via-agent --limit=3
```

이 스크립트는 공식 `xd.x1.client.api.vpngate2.jp` feed를 직접 읽고, 최신 후보를 골라 `VPN2`로 시험 연결한 뒤 성공/실패를 출력합니다.

중요:

- 이 프로브는 `특궁 popup -> local agent` 경로가 아니라 `Node 스크립트 -> vpncmd.exe` 직통 경로입니다.
- `--via-agent` 를 붙이면 `특궁 popup -> local agent -> SoftEther` 와 같은 경로로 시험합니다.
- 그래서 SoftEther Manager 목록은 바뀌어도, 특궁 UI 상태는 자동으로 따라오지 않습니다.
- popup의 `Failed to fetch` 는 거의 항상 `http://127.0.0.1:8765` local agent server가 안 떠 있을 때 발생합니다.
- 실행 순서는 `최신 raw 받기 -> 1개 연결 시도 -> CONNECTED 확인 -> 공인 IP 변경 확인 -> disconnect/delete -> 원래 IP 복귀 확인 -> 다음 후보` 입니다.

쉽게 예시로 말하면:

- `121.142.148.62:995` 성공
  - `1.210.3.152 -> 112.172.66.106`
  - 정리 후 다시 `1.210.3.152`
- `218.148.38.123:995` 실패
  - `15초 동안 Connecting 유지`
  - IP 안 바뀜
- `59.8.22.212:995` 성공
  - `1.210.3.152 -> 220.124.206.43`
  - 정리 후 다시 `1.210.3.152`
- `--via-agent` 경로 성공 예시
  - latest feed 후보 `59.8.22.212:995`
  - local agent status가 `CONNECTING -> CONNECTED -> IDLE` 로 변함
  - 공인 IP `1.210.3.152 -> 220.124.206.43 -> 1.210.3.152`
