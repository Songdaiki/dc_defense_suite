# `/NOTRACK=yes` 병렬 연결 가능성 실측 보고서

> 작성일: 2026-04-19  
> 목적: `병렬 3터널 Connected 후 route 우선순위 전환` 설계의 선행 조건인 `/NOTRACK=yes` 동작을 실제 PC에서 검증한다.

## 1. 요약

이번 turn에서 확인된 건 아래 2개다.

- `/NOTRACK=yes` 단일 raw account는 실제로 `Connected` 까지 올라갔고, 출구 IPv4도 바뀌었다.
- `/NOTRACK=yes` 2개 raw account를 동시에 올렸을 때, `VPN3` 와 `VPN4` default route가 동시에 살아 있는 것을 확인했다.

이번 turn에서 **아직 최종 완료하지 못한 것** 은 아래 1개다.

- 서로 다른 2개 exit relay를 동시에 올린 뒤, metric 전환만으로 `exit IP A -> exit IP B` 를 직접 교차 확인하는 최종 1회 증명

즉 결론은 이거다.

- `병렬 connected` 는 현실적이다.
- `route 전환만으로 출구 IP가 바뀌는 최종 실측` 은 다음 patch 직후 마지막 검증 항목으로 남긴다.

## 2. 실험 1: 단일 account + `/NOTRACK=yes`

조건:

- relay:
  - `219.100.37.114:443`
- NIC:
  - `VPN3`
- account:
  - `DCDS-NOTRACK-mo5ak4d3`
- detail:
  - `noRoutingTracking = true`

관측:

- 연결 전 IPv4:
  - `1.210.3.152`
- 연결 후 IPv4:
  - `219.100.37.240`
- `AccountList`:
  - `Connected`
- `AccountStatusGet`:
  - `Session Established`
  - `Physical Underlay Protocol = Standard TCP/IP (IPv4)`
  - `UDP Acceleration is Active = Yes`

IPv4 default route 관측:

- 연결 전:
  - `이더넷`, next hop `1.210.3.129`, route metric `0`, interface metric `25`
- 연결 후:
  - `이더넷`, next hop `1.210.3.129`, route metric `0`, interface metric `25`
  - `VPN3 - VPN Client`, next hop `10.240.254.254`, route metric `1`, interface metric `1`

해석:

- `/NOTRACK=yes` 라고 해서 tunnel이 unusable 한 건 아니었다.
- 오히려 이번 환경에서는 `물리 default route를 남긴 채 VPN default route가 추가` 되는 모습이 나왔다.
- 다만 같은 실험에서 `UDP Acceleration is Active = Yes` 도 같이 보였으므로, 이 결과를 `현재 저장소가 strict TCP-only로도 성공했다` 라고 해석하면 안 된다.

## 3. 실험 2: 동시 2 account + `/NOTRACK=yes`

조건:

- relay:
  - 둘 다 `219.100.37.114:443`
- NIC:
  - `VPN3`
  - `VPN4`
- accounts:
  - `DCDS-NTRK-A-mo5alnfn`
  - `DCDS-NTRK-B-mo5alnfo`
- detail:
  - 둘 다 `noRoutingTracking = true`

관측:

- `VPN3` account:
  - `Connected`
- `VPN4` account:
  - `Connected`
- 각 account의 `AccountStatusGet`:
  - 둘 다 `Session Established`
  - 둘 다 `Standard TCP/IP (IPv4)`
  - 둘 다 `UDP Acceleration is Active = Yes`

IPv4 default route 관측:

- `이더넷`, next hop `1.210.3.129`, route metric `0`, interface metric `25`
- `VPN3 - VPN Client`, next hop `10.240.254.254`, route metric `1`, interface metric `1`
- `VPN4 - VPN Client`, next hop `10.240.254.254`, route metric `1`, interface metric `1`

해석:

- 적어도 이번 PC에서는 `/NOTRACK=yes` 2개 동시 연결이 서로의 default route를 바로 지우지 않았다.
- 즉 `3개를 먼저 Connected까지 올리고, 그 다음 route owner를 바꿔 가며 보는 구조` 가 설계상 충분히 현실적이다.

## 3-1. 이번 보고서를 읽을 때 같이 붙여야 하는 caveat

이 보고서는 `/NOTRACK=yes` 의 가능성을 확인한 것이다.  
반대로 아래 3가지는 **이미 해결된 문제** 가 아니라 **같이 안고 가야 하는 주의사항** 이다.

- 현재 local agent wrapper는 `PortUDP` / `NoUdpAcceleration` 입력을 아직 세팅하지 않는다.
- 현재 repo의 `selfHostedVpn` state는 single-slot 기준이라, 병렬 probe에 기존 refresh/cleanup helper를 그대로 재사용하면 충돌할 수 있다.
- route 전환/복구는 표시 문자열 `InterfaceAlias` 보다 `ifIndex` 를 기준 키로 잡는 편이 안전하다.

쉽게 예시로 말하면:

- 이번 보고서가 말해 주는 것:
  - `병렬로 붙여 둘 수 있는지`
- 이번 보고서가 아직 말해 주지 않는 것:
  - `현재 코드가 이미 multi-slot용으로 정리되어 있는지`
  - `현재 코드가 이미 strict TCP-only인지`

## 4. 아직 남은 최종 검증

다음 1회만 더 보면 문서상 핵심 주장을 거의 닫을 수 있다.

1. 서로 다른 exit relay 두 개를 준비한다.
2. 둘 다 `/NOTRACK=yes` 로 `Connected` 까지 올린다.
3. `Set-NetIPInterface` 로 `VPN3` metric을 가장 낮게 만든다.
4. fresh IPv4 probe를 날려 exit IP A를 기록한다.
5. `VPN4` metric을 가장 낮게 만든다.
6. fresh IPv4 probe를 날려 exit IP B를 기록한다.

이때 꼭 같이 남겨야 하는 값:

- slot별 relay IP / port
- slot별 nicName / interfaceAlias
- metric 변경 전후 `Get-NetIPInterface`
- metric 변경 전후 `Get-NetRoute 0.0.0.0/0`
- probe 결과 IPv4

## 5. 패치 판단

이번 보고서 기준으로는 아래 판단이 맞다.

- 지금 시작해도 되는 것:
  - `병렬 3슬롯 test coordinator`
  - `/NOTRACK=yes` 기반 slot provisioning
  - route metric switching helper
  - fresh IPv4 probe helper
- 아직 문서상 미완으로 남겨야 하는 것:
  - `서로 다른 두 exit를 metric 전환만으로 직접 교차 확인했다` 는 문장

즉, 패치를 막을 blocker는 아니다.  
다만 patch 직후의 첫 현장 검증 항목은 분명하게 남아 있고, 현재 wrapper/state 한계도 같이 정리한 뒤 진행해야 한다.
