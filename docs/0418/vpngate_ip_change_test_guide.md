# VPNGate IP 변경 테스트 가이드

## 한 줄 요약

이 테스트는 **200개 서버 목록을 받아온 뒤**, 사용자가 **공식 클라이언트로 직접 VPN 연결**을 올리고,  
연결 **전/후 공인 IP와 기본 라우트가 바뀌었는지** 확인하는 절차입니다.

중요:

- 이 저장소의 스크립트는 **VPN 연결을 직접 만들지 않습니다.**
- 대신 **연결 전/후 상태를 저장하고 비교**해서, 진짜로 출구 IP가 바뀌었는지 확인합니다.

쉽게 예시로 말하면:

- 연결 전: 내 공인 IP가 `1.210.3.152`
- 공식 클라이언트로 어떤 릴레이에 연결
- 연결 후: 공인 IP가 `219.100.37.13` 으로 보임
- 그러면 "VPN 터널이 올라가서 출구가 바뀌었다" 라고 판단할 수 있습니다.

## 왜 200개 목록만으로 바로 IP가 안 바뀌나

200개 목록은 말 그대로 **후보 서버 목록**입니다.

예시:

- 목록 안에 `219.100.37.13`
- 목록 안에 `219.100.37.114`
- 목록 안에 `59.8.22.212`

이 단계에서는 아직 **전화번호부만 받은 상태**입니다.

실제로 IP가 바뀌려면 그 다음 단계가 있어야 합니다.

1. 클라이언트가 목록에서 서버 하나를 고릅니다.
2. 그 서버와 실제 VPN 세션을 협상합니다.
3. 터널 인터페이스와 기본 라우트가 잡힙니다.
4. 그때부터 외부 사이트에서 보이는 출구 IP가 바뀝니다.

즉:

- `200개 목록 수신` = 아직 IP 안 바뀜
- `그중 1개에 실제 연결 성공` = 그때 IP가 바뀜

## 이번에 만든 확인 스크립트

파일:

- [scripts/check-vpn-egress-state.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/scripts/check-vpn-egress-state.mjs)

이 스크립트가 보는 것:

- 현재 공인 IP
- Windows 네트워크 어댑터 상태
- IPv4 / IPv6 기본 라우트
- `route print` 결과
- VPN처럼 보이는 어댑터 이름

추가로 가능한 것:

- 기준 상태를 저장한 뒤
- 일정 간격으로 계속 확인하면서
- 공인 IP 또는 기본 라우트가 바뀌는 순간 자동 감지

## 바로 해보는 테스트

### 1. 연결 전 상태 저장

```bash
mkdir -p data/vpngate-change-test
node scripts/check-vpn-egress-state.mjs \
  --capture \
  --label before \
  --output data/vpngate-change-test/before.json
```

예시:

```text
VPN 출구 상태 저장 완료
- output: .../before.json
- public_ip: 1.210.3.152
- provider: api64.ipify.org
- ipv4_default_routes: 1
- likely_vpn_adapters: VPN - VPN Client, Tailscale
```

### 2. 공식 클라이언트에서 서버 하나에 직접 연결

여기는 스크립트가 하는 단계가 아니라, **사용자가 수동으로 연결**하는 단계입니다.

쉽게 말하면:

- 200개 목록 중 하나 선택
- 공식 클라이언트에서 연결 버튼
- 연결 완료될 때까지 대기

### 3. 연결 후 상태 저장

```bash
node scripts/check-vpn-egress-state.mjs \
  --capture \
  --label after \
  --output data/vpngate-change-test/after.json
```

### 4. 전/후 비교

```bash
node scripts/check-vpn-egress-state.mjs \
  --compare \
  --before data/vpngate-change-test/before.json \
  --after data/vpngate-change-test/after.json
```

## 더 편한 방법: 바뀔 때까지 자동 감시

이 모드는 질문하신 "바뀔 때까지 테스트"에 더 가깝습니다.

쉽게 예시로 말하면:

- 먼저 지금 상태를 기준으로 저장
- 그다음 3초마다 계속 확인
- 사용자가 공식 클라이언트에서 연결 성공하면
- 그 순간 스크립트가 자동으로 잡아냄

명령:

```bash
node scripts/check-vpn-egress-state.mjs \
  --watch \
  --before data/vpngate-change-test/before.json \
  --output data/vpngate-change-test/after.json \
  --interval 3 \
  --timeout 180
```

의미:

- `--before`: 기준 상태 파일. 없으면 자동으로 새로 만듭니다.
- `--output`: 변화가 감지됐을 때 저장할 현재 상태 파일
- `--interval 3`: 3초마다 확인
- `--timeout 180`: 최대 180초 기다림

실행 흐름:

1. `--watch` 실행
2. 콘솔에 "지금 공식 클라이언트에서 서버 하나에 수동 연결하면 됩니다" 표시
3. 사용자가 공식 클라이언트에서 연결
4. 공인 IP나 기본 라우트가 바뀌면 자동 저장 후 비교 결과 출력

예시:

```text
VPN 출구 변화 감시 시작
- baseline: .../before.json
- output_on_change: .../after.json
- interval_seconds: 3
- timeout_seconds: 180
- 안내: 지금 공식 클라이언트에서 서버 하나에 수동 연결하면 됩니다.
[2026-04-18T14:20:00.000Z] check #1
- current_public_ip: 1.210.3.152
- public_ip_changed: NO
- ipv4_default_route_changed: NO
[2026-04-18T14:20:09.000Z] check #4
- current_public_ip: 219.100.37.13
- public_ip_changed: YES
- ipv4_default_route_changed: YES
변화를 감지했습니다.
```

## 비교 결과 해석

### 경우 1. 진짜로 VPN 출구가 바뀐 경우

예시:

```text
VPN 출구 상태 비교
- before_public_ip: 1.210.3.152
- after_public_ip: 219.100.37.13
- public_ip_changed: YES
- ipv4_default_route_changed: YES
- adapter_status_changes: VPN - VPN Client: Disconnected -> Up
- 판정: 공인 IP 또는 기본 라우트가 바뀌었습니다. VPN 터널 활성화 가능성이 높습니다.
```

의미:

- 외부에서 보이는 IP가 바뀌었고
- 기본 라우트도 바뀌었으므로
- 실제 터널 연결이 올라갔을 가능성이 높습니다.

### 경우 2. 목록만 받았거나, 연결이 실패한 경우

예시:

```text
VPN 출구 상태 비교
- before_public_ip: 1.210.3.152
- after_public_ip: 1.210.3.152
- public_ip_changed: NO
- ipv4_default_route_changed: NO
- adapter_status_changes: -
- 판정: 공인 IP와 기본 라우트 모두 큰 변화가 없습니다.
```

의미:

- 서버 목록은 받아왔을 수 있어도
- 실제 VPN 터널은 안 올라간 상태입니다.

## 실제로 방금 확인된 현재 상태

지금 저장소에서 스크립트를 실행해서 확인한 결과:

- before 공인 IP: `1.210.3.152`
- after 공인 IP: `1.210.3.152`
- 기본 라우트 변화: 없음
- 판정: 아직 출구 IP가 바뀐 상태는 아님

## 실패 사례 참고

공식 SoftEther VPN Gate 플러그인으로 단일 릴레이 `vpn237755744.opengw.net` (`218.148.38.123`) 에 붙어 본 실제 실패 기록은 아래 문서를 보면 된다.

- [docs/0419/vpngate_single_relay_failure_218_148_38_123.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/vpngate_single_relay_failure_218_148_38_123.md)

이 사례에서는 공식 클라이언트가 `218.148.38.123:995` 로 실제 TCP SYN을 보냈지만 SYN-ACK가 돌아오지 않아 TCP 핸드셰이크 이전 단계에서 실패했다.

## 성공 사례 참고

공식 SoftEther VPN Gate 플러그인으로 단일 릴레이 `vpn204414021.opengw.net` (`121.138.132.127`) 에 붙어 본 실제 성공 기록은 아래 문서를 보면 된다.

- [docs/0419/vpngate_single_relay_success_121_138_132_127.md](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/vpngate_single_relay_success_121_138_132_127.md)

이 사례에서는 공식 클라이언트가 raw feed의 `SslPorts=1698` 값과 일치하게 `121.138.132.127:1698` 로 실제 TCP 세션을 열었고, SYN-ACK 이후 양방향 데이터가 지속적으로 오갔다.

즉 현재는:

- 공식 API/목록 해독은 성공
- 200개 목록 파싱도 성공
- 하지만 실제 IP 변경 여부는 **사용자가 수동 연결한 뒤 전/후 비교**를 해야 확정 가능

## 가장 중요한 흐름만 다시 정리

쉽게 예시로 보면:

1. `xd.x1.client.api.vpngate2.jp` 에서 200개 목록을 받음
2. 그중 `219.100.37.13` 같은 후보 하나를 고름
3. 공식 클라이언트가 그 서버와 VPN 터널을 실제로 올림
4. 연결 후 외부에 보이는 공인 IP가 그 릴레이 쪽으로 바뀜

핵심은 이겁니다:

- **목록 수신만으로는 IP가 안 바뀜**
- **실제 VPN 터널 연결이 성공해야 IP가 바뀜**

## 다음에 바로 할 일

추천 순서:

1. `before.json` 저장
2. 공식 클라이언트에서 서버 하나 수동 연결
3. `after.json` 저장
4. `--compare` 실행
5. 결과를 보면 IP 변경 여부를 바로 판정 가능
