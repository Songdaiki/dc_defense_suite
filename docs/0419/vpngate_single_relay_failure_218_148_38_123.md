# VPNGate 단일 릴레이 실패 기록: `vpn237755744.opengw.net` (`218.148.38.123`)

> 작성일: 2026-04-19  
> 목적: 공용 VPN Gate 릴레이 1개를 공식 SoftEther VPN Gate 플러그인으로 직접 연결해 보고, 실패 시점에 어떤 값이 실제로 드러나는지 고정 저장한다.

## 한 줄 요약

이번 시도에서는 공식 클라이언트가 **`218.148.38.123:995` 로 실제 TCP 연결을 시도했다.**
하지만 **SYN 재전송만 반복되고 SYN-ACK가 오지 않아** TCP 핸드셰이크 단계에서 막혔다.
따라서 이번 케이스는 **TLS/SoftEther 본문 해석 단계까지 가지 못한 실패**다.

쉽게 말하면:

- 전화번호부(raw feed)에서 서버 하나를 골랐다.
- 공식 클라이언트가 그 서버의 `995` 포트로 전화를 걸었다.
- 상대가 전화를 안 받았다.
- 그래서 그 뒤 대화 내용은 애초에 존재하지 않았다.

## 1. 선택한 raw 서버 정보

공식 DAT 복호 스냅샷에서 확인한 서버 원본:

- source DAT API: [snapshot-7-20260418-233455.json](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/data/vpngate-change-test-20260418-230451/snapshot-7-20260418-233455.json:10)
- 선택 서버 객체: [snapshot-7-20260418-233455.json](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/data/vpngate-change-test-20260418-230451/snapshot-7-20260418-233455.json:1396)

핵심 필드:

```json
{
  "Fqdn": "vpn237755744.opengw.net",
  "IP": "218.148.38.123",
  "Name": "vpn237755744",
  "HostUniqueKey": "0327ECB6D37C31332FA12EEEFF7E3A19E235BD6B",
  "SslPorts": "465 995 1195 1487 9008",
  "OpenVpnUdpPorts": "1195 1204",
  "UdpPort": 41439,
  "CountryFull": "Korea Republic of",
  "Score": 1462716
}
```

의미:

- 이 서버는 `443`형이 아니라 **여러 SSL 포트 후보**를 광고한다.
- 그중 공식 클라이언트가 이번 시도에서 실제로 고른 포트는 **`995`** 였다.

## 2. SoftEther Manager에서 드러난 값

사용자 캡처 기준으로 공식 플러그인은 연결 시도 직전에 아래 정보를 화면에 노출했다.

- 표시 이름: `VPN Gate Connection`
- 상태: `Connecting`
- VPN Server Hostname: `218.148.38.123 (Direct TCP/IP Conn...)`
- Virtual Hub: `VPNGATE`
- Virtual Network Adapter: `VPN`

이 정보는 중요하다.

왜냐면 raw feed에는 `Virtual Hub` 값이 없는데, 공식 클라이언트 화면에서는 **`VPNGATE` 허브를 사용하려고 시도한 흔적**이 보이기 때문이다.

쉽게 말하면:

- raw feed가 알려준 것: `IP`, `포트 후보`, `FQDN`
- 공식 플러그인이 추가로 채운 것: **`Virtual Hub = VPNGATE`**

즉, "raw 한 줄 -> SoftEther 연결 프로필" 변환 규칙의 일부가 실제로 드러났다.

## 3. 공식 클라이언트 오류 메시지

사용자 캡처 기준 팝업 메시지:

- 제목: `Connect Error - VPN Gate Connection`
- 본문: `Connection to the VPN Server failed. Check network connection and make sure that address and port number of destination server are correct.`
- Error Code: `1`

해석:

- 인증 실패나 허브 이름 오류까지 간 것이 아니라,
- **목적지 IP/포트 도달성 자체가 문제일 가능성**이 높다.

이번 Wireshark 결과와도 일치한다.

## 4. Wireshark 관측 결과

사용자 캡처 기준 핵심 관측:

- 로컬 공인 IP: `1.210.3.152`
- 목적지 IP: `218.148.38.123`
- 사용 포트: `995`
- 첫 시도 예시: `51801 -> 995 [SYN]`
- 이후 `51804 -> 995 [SYN]`, `58008 -> 995 [SYN]` 등으로 재시도
- 다수의 `TCP Retransmission`
- **서버 쪽 SYN-ACK 응답은 보이지 않음**

결론:

- 공식 클라이언트는 이번 서버에 대해 **`995/tcp`를 실제 SSL-VPN 시도 포트로 선택**했다.
- 하지만 **TCP 3-way handshake 자체가 성립하지 않았다.**
- 따라서 SoftEther/SSL/TLS 협상 본문은 아직 시작되지 않았다.

## 5. 패킷 본문이 필요한가

이번 실패 케이스에서는 **대체로 필요 없다.**

이유:

- TCP SYN만 갔고
- SYN-ACK가 안 왔고
- TLS ClientHello나 SoftEther 상위 레벨 페이로드가 시작되지 않았다.

즉, 안쪽 본문을 더 까봐야 할 상황이 아니라,
**핸드셰이크 이전 단계에서 막힌 상태**다.

쉽게 예시로 말하면:

- 문을 두드렸는데 문이 안 열림
- 그러면 집 안 대화를 녹음할 내용도 없음

이번 단계에서 중요한 건:

- 어느 IP로 갔는지
- 어느 포트로 갔는지
- 응답이 있었는지

이 3개면 충분하다.

## 6. `vpncmd` 조회 결과

실패 직후 `vpncmd`로 로컬 VPN Client 서비스에 조회한 결과:

```text
AccountList
-> 비어 있음

AccountGet "VPN Gate Connection"
-> Error code 36
-> The specified VPN Connection Setting does not exist.

AccountExport "VPN Gate Connection"
-> Error code 36
-> The specified VPN Connection Setting does not exist.
```

의미:

- Manager 화면에는 `VPN Gate Connection` 이 보였지만
- 그 엔트리가 **일반적인 영구 계정(Account)로 저장되지는 않았을 가능성**이 높다.

가능한 해석은 2가지다.

1. 플러그인이 실패 시 임시 연결 엔트리를 메모리에서만 관리한다.
2. 영구 저장 전에 연결 실패가 나서 `vpncmd`가 보는 계정 저장소까지 내려오지 못했다.

이 차이는 이후 성공 케이스를 한 번 더 잡아보면 비교 가능하다.

## 7. 이번 실패에서 확정된 사실

- 공식 DAT raw 안에 이 서버가 실제로 존재한다.
- 공식 SoftEther VPN Gate 플러그인은 이 raw 후보를 사용해 실제 접속 시도를 한다.
- 이번 서버에 대해 플러그인은 **`995/tcp`** 로 붙으려 했다.
- 화면상 `Virtual Hub` 는 **`VPNGATE`** 로 보인다.
- 실패는 인증 이후가 아니라 **네트워크 도달성/TCP handshake 이전 단계**에 가깝다.
- 실패 시도만으로는 `vpncmd`에서 재사용 가능한 영구 Account가 남지 않았다.

## 8. 구현 관점에서 의미

이 실패는 헛수고가 아니다.

오히려 아래 사실을 고정해 준다.

- raw feed의 `SslPorts`는 실제 접속 후보 포트 집합이다.
- 공식 클라이언트는 그중 하나를 골라 TCP 연결을 시도한다.
- `Virtual Hub = VPNGATE` 라는 고정값 후보가 보인다.
- 실패 시에는 local agent가 그대로 재생할 수 있는 완성된 account를 못 얻을 수 있다.

즉, local agent 재현 관점에서 지금 필요한 다음 단계는:

1. **성공하는 릴레이 1개**를 잡는다.
2. 그 성공 케이스에서 `vpncmd AccountGet/Export` 또는 설정 파일 비교를 시도한다.
3. 그러면 raw -> account 생성 규칙을 더 많이 복원할 수 있다.

## 9. 다음 시도 권장

- `443` 단일 또는 `443` 우선 서버를 먼저 시도
- 점수가 높고 `NumClients`가 너무 많지 않은 서버 우선
- 실패 시에도 이번 문서처럼 `실제 목적지 포트`를 먼저 고정
- 성공 케이스가 나오면 즉시 `vpncmd`, `vpn_client.config`, `client_log` 비교

## 10. 이번 실패의 최소 결론

이번 한 번의 시도만으로도 아래는 이미 확인됐다.

- 공식 플러그인은 단순히 목록만 보여주는 게 아니라 **실제 릴레이 연결 시도까지 수행**한다.
- raw feed만으로도 **어느 서버를 고를지**는 정해지지만,
- **성공 재현용 스펙 추출**은 실패 케이스보다 성공 케이스에서 훨씬 잘 나온다.

따라서 다음 액션은 "패킷 본문 더 해독"보다
**성공 릴레이 1개를 잡아서 account/설정값을 추출하는 것**이 더 우선이다.
