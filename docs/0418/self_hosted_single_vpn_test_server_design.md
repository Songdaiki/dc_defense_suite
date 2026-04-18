# 자체 테스트 VPN 서버 1개 기준 설계 + 구현 전 검증판

## 한 줄 결론

`공인 IP가 진짜 한 번 바뀌는 걸 보고 싶다`가 목표면,  
가장 짧은 길은 **내가 제어하는 VPN 서버 1개**를 두고,  
내 PC가 그 서버로 **실제 터널 연결**을 하게 만드는 것입니다.

쉽게 예시로 말하면:

- 연결 전 공인 IP: `1.210.3.152`
- 내가 준비한 테스트 서버 공인 IP: `203.0.113.10`
- 연결 후 공인 IP: `203.0.113.10`

이렇게 되면 `목록을 읽어서` IP가 바뀌는 게 아니라,  
`터널이 실제로 올라가고 라우트가 바뀌어서` IP가 바뀐다는 걸 바로 확인할 수 있습니다.

## 이번 문서에서 검증한 것

이번에는 단순 아이디어 정리가 아니라,  
**현재 리포 구조와 실제 구현 흐름에 맞는지**를 같이 검토했습니다.

검증 결과:

- 새 탭 추가 자체는 가능
- `localhost` 통신도 현재 manifest 기준 가능
- 하지만 `팝업이 직접 연결 엔진을 오래 붙잡는 구조`는 현재 코드 패턴과 맞지 않음
- 실제 터널 생성은 반드시 **로컬 에이전트**가 맡아야 함
- connect/disconnect는 **직렬화** 해야 함
- Windows에서는 **관리자 권한/서비스 실행** 문제가 빠지면 실제로 막힘
- 서버 쪽에서는 **포워딩/NAT/방화벽**이 빠지면 "연결은 됐는데 인터넷이 안 되는" 상태가 생김
- full tunnel 테스트라면 **IPv4만이 아니라 IPv6/DNS**도 같이 봐야 함

단:

- 현재 manifest에는 `http://127.0.0.1/*`, `http://localhost/*`, `http://[::1]/*` 만 들어 있음
- 즉 local agent를 **HTTPS localhost** 로 열 계획이면 manifest 권한도 같이 수정해야 함
- local agent 주소 입력값은 `http://127.0.0.1:8765` 같은 형태만 허용하는 게 안전함
  - `?query`, `#hash`, `username:password@host` 같은 값은 막는 편이 맞음

## 리포 구조 대조 결과

현재 코드베이스는 이런 구조입니다.

1. 팝업 탭 버튼은 `popup/popup.html` 에서 정의
2. 탭 전환은 `popup/popup.js` 의 `setActiveTab()` 으로 처리
3. 팝업은 `sendMessage()` 로 background에 요청
4. background는 `handleMessage()` 에서 feature별 상태를 관리
5. 팝업은 `getAllStatus` 를 1초마다 polling 해서 화면을 갱신

즉 현재 리포 패턴에 맞는 구조는 이겁니다.

- `popup -> background -> local agent -> OS 네트워크 -> 테스트 서버`

반대로 이 구조는 권장하지 않습니다.

- `popup -> 직접 localhost long request -> 터널 제어`

이유:

- 팝업은 닫히면 없어지는 UI
- 현재 리포의 다른 기능들도 popup이 직접 장기 실행을 소유하지 않음
- 장기 상태는 background / scheduler 쪽에서 관리하는 패턴이 이미 있음

### 실제 코드 근거

- 탭 버튼과 패널은 popup HTML에 있음
- 탭 전환은 `setActiveTab()` 으로 처리됨
- popup은 로드 후 `refreshAllStatuses()` 를 호출하고 1초 polling 함
- popup의 개별 기능 버튼은 `sendFeatureMessage()` 로 background에 메시지를 보냄
- background는 `handleMessage()` 에서 메시지를 받고 `getAllStatus()` 로 전체 상태를 되돌림

즉 새 기능도 이 흐름을 따라야 기존 구조와 충돌이 적습니다.

주의:

- 현재 popup은 `getAllStatus` 를 1초마다 호출함
- 따라서 새 기능 상태를 여기에 붙일 경우 local agent 조회는 짧은 timeout/cached snapshot 기준으로 처리하는 게 안전함
- 매 1초마다 무거운 localhost 호출을 직접 넣으면 전체 popup 상태 갱신이 느려질 수 있음

## 왜 이 방식이 제일 쉬운가

지금까지 헷갈렸던 포인트는 이겁니다.

- `서버 목록 200개 받기`는 주소록 보기
- `IP 바꾸기`는 실제 길을 새로 만드는 것

즉:

- 목록 복호화만으로는 IP가 안 바뀜
- 실제 VPN 터널이 올라가야만 IP가 바뀜

그래서 가장 쉬운 검증은:

1. 후보 서버 200개를 다루지 않는다
2. 내가 아는 서버 1개만 쓴다
3. 그 서버로 진짜 연결해본다
4. 연결 전/후 공인 IP를 비교한다

## 추천 방식

초보자 기준으로는 **WireGuard 계열 구조**가 가장 단순합니다.

이유:

- 서버 1대, 클라이언트 1대 구조가 단순함
- 설정 항목이 비교적 적음
- 성공/실패 판정이 명확함

다만 여기서 바로 빠지기 쉬운 함정이 있습니다.

### 빠진 전제 1. Windows에서 관리자 권한이 필요할 수 있음

가상 인터페이스 생성, 라우트 변경, DNS 적용은  
일반 사용자 프로세스로는 막히는 경우가 많습니다.

쉽게 예시로 말하면:

- UI 버튼은 눌림
- 로컬 에이전트도 실행됨
- 그런데 실제 인터페이스 생성이나 라우트 변경에서 실패

그래서 로컬 에이전트는 보통 아래 둘 중 하나가 필요합니다.

- 관리자 권한으로 실행
- 서비스 형태로 설치

### 빠진 전제 2. 서버에서 포워딩/NAT가 켜져 있어야 함

서버가 터널만 받고 인터넷으로 다시 내보내지 못하면 이런 상태가 됩니다.

- 연결은 성공처럼 보임
- 클라이언트 터널 IP도 받음
- 그런데 웹사이트 접속이 안 됨

쉽게 말하면:

- 터널은 생겼는데 출구문이 안 열린 상태

그래서 서버에는 최소한 아래가 필요합니다.

- IP forwarding
- egress NAT/masquerade
- 해당 UDP 포트 오픈
- 클라우드 보안그룹/방화벽 허용

### 빠진 전제 3. full tunnel 테스트면 IPv6/DNS도 같이 처리해야 함

문서 초안에서는 `0.0.0.0/0` 만 설명했는데,  
실제로는 이걸로 끝나지 않을 수 있습니다.

예시:

- IPv4 트래픽은 VPN으로 감
- IPv6 트래픽은 원래 회선으로 나감
- DNS도 ISP DNS를 계속 씀

그러면:

- "IP가 바뀐 것 같기도 하고 아닌 것 같기도 한" 애매한 상태
- 일부 사이트만 우회되고 일부는 그대로

초보자 테스트에서 이런 혼선을 줄이려면,  
**처음엔 full tunnel + DNS 강제 + IPv6 정책 포함 여부를 명확히** 정해야 합니다.

## 전체 구조

부품은 4개가 필요합니다.

1. **테스트 서버 1대**
2. **내 PC**
3. **로컬 연결 에이전트**
4. **특궁 탭 UI**

쉽게 비유하면:

- 서버 = 목적지
- 내 PC = 실제 사용자 장비
- 로컬 에이전트 = 엔진
- 특궁 탭 = 리모컨

## 각 부품이 하는 일

### 1. 테스트 서버

역할:

- 외부에 보이는 새로운 출구 IP 제공
- VPN 터널 종착점 역할

최소 조건:

- 공인 IP 1개
- Linux 서버 1대
- VPN 서버 설정 가능
- forwarding 가능
- NAT/masquerade 가능
- 외부에서 접근 가능한 UDP 포트 1개

예시:

- 서버 공인 IP: `203.0.113.10`
- 서버 포트: `51820/udp`

### 2. 내 PC

역할:

- 터널을 실제로 올리는 쪽
- 연결 전후 IP 변화를 확인하는 쪽

여기서 실제 변화가 일어납니다.

예시:

- 연결 전: 집 인터넷 그대로 사용
- 연결 후: 인터넷이 테스트 서버를 통해 나감

주의:

- 이미 실행 중인 다른 VPN/Tailscale/기업 VPN이 있으면 라우트 충돌이 날 수 있음
- 테스트 전에 기존 VPN 어댑터와 기본 라우트를 확인하는 게 좋음

## 3. 로컬 연결 에이전트

이게 핵심입니다.

브라우저 확장만으로는 이런 걸 못 합니다.

- 가상 네트워크 인터페이스 생성
- 라우트 변경
- DNS 변경
- 실제 VPN 터널 연결

그래서 내 PC 안에서 따로 도는 **로컬 프로그램**이 필요합니다.

쉽게 말하면:

- 특궁 탭이 "연결해"라고 말함
- 로컬 에이전트가 진짜 OS 네트워크를 바꿈

### 여기서 빠지면 안 되는 조건

1. **권한**
- 관리자 권한 또는 서비스 실행 경로 필요

2. **보안**
- `127.0.0.1` 에만 bind
- 인증 토큰 필요
- 아무 요청이나 `connect` 를 때릴 수 있으면 안 됨
- private key 같은 민감한 값은 가능하면 extension이 아니라 local agent 쪽에 보관

3. **동시성**
- 활성 연결은 기본적으로 1개만 허용
- 이미 연결 중인데 또 `connect` 가 오면 명확한 응답 필요
- `connect` 처리 중 곧바로 `disconnect` 가 겹치면 상태 경합이 날 수 있으므로
- 확장/background/local agent 중 최소 1곳에서는 요청 직렬화가 필요

4. **비동기 처리**
- `connect` 는 오래 걸릴 수 있으므로 동기 long request보다
- `accepted -> polling status` 구조가 안전

5. **정리**
- disconnect 시 라우트/DNS/어댑터 정리가 확실해야 함
- 실패 후 반쯤 연결된 상태를 정리할 복구 로직이 필요

## 4. 특궁 탭 UI

역할:

- 상태 보여주기
- 연결 버튼 누르기
- 끊기 버튼 누르기
- 현재 공인 IP 확인하기

즉 특궁 탭은 **직접 IP를 바꾸는 게 아니라**,  
로컬 에이전트에게 명령을 보내는 앞화면입니다.

중요:

- 특궁 탭은 popup이므로 장기 실행 주체가 되면 안 됨
- 상태는 background 또는 local agent 기준으로 다시 읽어와야 함

## 진짜로 IP가 바뀌는 순간

IP가 바뀌는 건 **목록을 받을 때**가 아니라  
**내 PC의 기본 라우트가 VPN 인터페이스 쪽으로 바뀌고, DNS/IPv6 정책까지 맞을 때**입니다.

순서를 쉽게 쓰면:

1. 특궁 탭에서 `연결` 클릭
2. popup이 background에 메시지 전송
3. background가 local agent에 `connect` 요청
4. local agent가 실제 VPN 연결 시작
5. 내 PC에 가상 인터페이스 생성
6. 기본 라우트와 DNS가 VPN 쪽으로 이동
7. 외부 사이트에서 보이는 공인 IP가 서버 IP로 바뀜

예시:

- 원래: `1.210.3.152`
- 연결 후: `203.0.113.10`

## 최소 스펙

### 서버 쪽 필수 스펙

- 서버 공인 IP
- 서버 공개키
- 서버 포트
- 터널 네트워크 대역
- 클라이언트에 줄 터널 IP
- DNS 정책
- forwarding 활성화
- NAT/masquerade 활성화
- 방화벽/보안그룹 허용

예시:

- `server_public_ip`: `203.0.113.10`
- `server_port`: `51820`
- `tunnel_subnet`: `10.77.0.0/24`
- `client_tunnel_ip`: `10.77.0.2/32`

### 클라이언트 쪽 필수 스펙

- 클라이언트 개인키
- 클라이언트 공개키
- 어떤 대역을 터널로 보낼지
- DNS
- 로컬 에이전트가 사용할 연결 엔진
- 관리자 권한/서비스 경로
- 민감한 키를 어디에 저장할지

예시:

- IPv4 full tunnel: `0.0.0.0/0`
- IPv6 full tunnel이면 추가: `::/0`

초보자 테스트 목적이면:

- **처음엔 full tunnel 을 기본**
- 단, IPv6를 그대로 둘지 차단할지 정책을 문서에서 명확히 정해야 함

### 아직 결정이 필요한 스펙

이 항목들은 아직 "무조건 이 값"으로 확정된 게 아닙니다.

- 연결 엔진을 무엇으로 할지
- 로컬 에이전트를 서비스로 설치할지
- DNS를 서버로 강제할지
- IPv6를 함께 터널링할지, 아니면 초기에는 차단할지
- MTU 기본값을 둘지 자동 탐지할지
- private key를 agent 내부에 둘지, 외부 파일로 둘지

이건 구현 시작 전에 반드시 확정해야 합니다.

## 현재 리포에 맞는 구현 구조

현재 코드베이스 패턴에 맞추면 새 기능 구조는 이렇게 가는 게 맞습니다.

1. `popup/popup.html`
- 새 탭 버튼 추가
- 새 패널 추가

2. `popup/popup.js`
- 새 feature DOM 바인딩
- 버튼 클릭 시 `sendFeatureMessage()` 호출
- 기존처럼 1초 polling status 반영

3. `background/background.js`
- `handleMessage()` 에 새 feature action 추가
- 상태 객체를 다른 feature처럼 반환
- popup에서 직접 long-running 작업을 하지 않도록 중간 브리지 역할

주의:

- background는 MV3 service worker라서 장기 polling 주체로 과하게 의존하면 애매해질 수 있음
- 장기 연결 상태의 진실 소스는 local agent 쪽에 두고
- background는 `요청 전달 / 현재 상태 조회 / 저장된 상태 반환` 쪽에 가깝게 쓰는 것이 안전
- 현재 `getAllStatuses()` 패턴은 메모리의 scheduler 상태를 바로 모아주는 형태라서
- 새 기능 상태를 local agent에서 매번 비동기로 가져올지, background가 마지막 snapshot을 캐시할지 먼저 정해야 함

4. `features/self-hosted-vpn/`
- scheduler 또는 controller 역할 모듈
- 상태 저장 / 복원 / getStatus 형태로 맞추는 게 유지보수상 유리

### 왜 popup 직통보다 background 경유가 맞는가

현재 리포의 실제 패턴이 그렇기 때문입니다.

- popup은 `sendMessage()`
- background는 `handleMessage()`
- popup은 `getAllStatus` polling

즉 새 기능만 따로 `popup -> direct localhost` 로 빼면:

- 상태 관리 위치가 따로 놈
- UI 갱신 방식이 따로 놈
- 나중에 유지보수 시 한 기능만 예외 구조가 됨

### 새 feature 추가 시 실제로 건드려야 하는 위치

기존 코드 패턴상 아래를 한 세트로 맞춰야 합니다.

1. `popup/popup.html`
- 탭 버튼
- 패널

2. `popup/popup.js`
- `DIRTY_FEATURES`
- `FEATURE_DOM`
- `bindFeatureEvents()`
- `applyStatuses()`
- `update...UI()`
- `getFeatureConfigInputs()`

3. `background/background.js`
- scheduler import
- `schedulers` 등록
- `resumeAllSchedulers()` 등록
- `getAllStatuses()` 등록
- `handleMessage()` action 처리

4. `features/self-hosted-vpn/`
- 상태 저장/복원/getStatus 형식

쉽게 말하면:

- 버튼만 추가하면 되는 구조가 아님
- popup / background / feature 모듈이 같이 맞아야 함

## 로컬 에이전트 API 초안

초안은 이렇게 수정하는 게 안전합니다.

### `POST /v1/vpn/connect`

설명:

- 연결 시작 요청만 받음
- 바로 끝나는 요청이어야 함
- 실제 연결 완료 여부는 status polling으로 본다

예시 요청:

```json
{
  "profileId": "my-test-server"
}
```

설명:

- 확장은 `profileId` 만 넘기는 쪽이 안전함
- private key 전체를 popup/background가 매번 들고 다니는 구조는 피하는 게 좋음

예시 응답:

```json
{
  "accepted": true,
  "operationId": "op-20260418-001",
  "phase": "CONNECTING"
}
```

### `POST /v1/vpn/disconnect`

예시 응답:

```json
{
  "accepted": true,
  "phase": "DISCONNECTING"
}
```

### `GET /v1/vpn/status`

이건 최소한 이 정보는 있어야 합니다.

```json
{
  "phase": "CONNECTED",
  "profileId": "my-test-server",
  "operationId": "op-20260418-001",
  "publicIpBefore": "1.210.3.152",
  "publicIpAfter": "203.0.113.10",
  "ipv4DefaultRouteChanged": true,
  "ipv6DefaultRouteChanged": true,
  "dnsChanged": true,
  "activeAdapterName": "WireGuard Tunnel",
  "connectedAt": "2026-04-18T15:00:00.000Z",
  "lastErrorCode": "",
  "lastErrorMessage": ""
}
```

### `GET /v1/vpn/egress`

예시 응답:

```json
{
  "publicIp": "203.0.113.10",
  "provider": "api64.ipify.org"
}
```

### `GET /v1/health`

예시 응답:

```json
{
  "ok": true,
  "agentVersion": "0.1.0"
}
```

## 특궁 탭에서 보일 최소 UI

처음엔 복잡하게 갈 필요 없습니다.

이 8개면 충분합니다.

- 현재 상태
- 연결 전 IP
- 연결 후 IP
- IPv4 라우트 변경 여부
- IPv6/DNS 상태
- 연결 버튼
- 끊기 버튼
- 최근 로그

예시 화면:

- 상태: `CONNECTED`
- 연결 전 IP: `1.210.3.152`
- 연결 후 IP: `203.0.113.10`
- 최근 로그: `기본 라우트 변경 감지`, `DNS 전환 확인`, `출구 IP 변경 확인`

## 가장 쉬운 1차 목표

처음부터 특궁 탭 자동 연결까지 다 하려고 하면 복잡합니다.

그래서 1차 목표는 이걸 추천합니다.

1. 테스트 서버 1개 준비
2. 내 PC에서 수동으로 한 번 연결
3. 연결 전/후 공인 IP와 라우트 확인
4. "IP가 바뀌는 원리"를 먼저 체감

쉽게 말하면:

- 먼저 엔진이 진짜 도는지 확인
- 그 다음에 탭 버튼을 붙이는 게 맞습니다

## 2단계 목표: 로컬 에이전트 만들기

목표:

- 특궁 없이 `connect / disconnect / status` 가 되는 것

성공 기준:

- `connect` 후 공인 IP가 바뀜
- IPv4 라우트가 의도대로 바뀜
- IPv6/DNS 정책도 의도대로 동작
- `disconnect` 후 원래 상태로 돌아옴

## 3단계 목표: 특궁 탭 연동

목표:

- 특궁에서 버튼 한 번으로 로컬 에이전트 제어

성공 기준:

- 특궁 탭에서 상태가 보임
- 연결/끊기 가능
- popup을 닫았다 열어도 상태가 다시 보임

## 구현 전에 반드시 체크할 리스크

### 리스크 1. 관리자 권한 누락

증상:

- 연결 요청은 감
- 하지만 인터페이스/라우트 생성 실패

### 리스크 2. 서버 NAT/포워딩 누락

증상:

- 연결은 된 것처럼 보임
- 인터넷 접속이 안 됨

### 리스크 3. IPv6 누수

증상:

- 어떤 사이트는 바뀐 IP
- 어떤 사이트는 원래 IP

### 리스크 4. DNS 누수

증상:

- 출구 IP는 바뀌었는데 DNS는 ISP를 계속 씀

### 리스크 5. 기존 VPN 충돌

증상:

- 라우트 우선순위가 꼬임
- 연결/해제 후 원복이 깔끔하지 않음

### 리스크 6. local agent 무인증

증상:

- localhost API 자체가 위험해짐

### 리스크 7. popup 수명 의존

증상:

- 팝업 닫으면 진행 상태가 끊겨 보임
- 연결 작업이 UI 생명주기에 묶임

### 리스크 8. 기존 자동화 기능과 동시 실행

증상:

- VPN 연결/해제 중 기존 자동화 요청이 실패하거나 흔들림
- 세션/쿠키/요청 IP가 중간에 바뀌면서 동작이 애매해짐

의미:

- 새 연결 기능은 기존 scheduler들과 **동시 실행 금지 또는 별도 락 정책**이 필요할 가능성이 큼

권장:

- 연결 시작 전 busy feature 검사
- 연결 중에는 다른 자동화 기능 start/stop/config 변경 제한 여부 결정
- 최소한 `connect / disconnect` 중에는 기존 네트워크 의존 기능을 건드리지 않는 쪽이 안전

## 이 리포에서 같이 쓸 수 있는 검증 도구

이미 만든 이 스크립트는 계속 활용 가능합니다.

- `scripts/check-vpn-egress-state.mjs`

이 스크립트로 확인할 수 있는 것:

- 현재 공인 IP
- IPv4 기본 라우트
- IPv6 기본 라우트
- VPN처럼 보이는 어댑터 변화

주의:

- 현재 compare 요약 판정은 **공인 IP + IPv4 기본 라우트 + 어댑터 상태** 중심입니다
- IPv6/DNS 정보는 스냅샷에 수집되지만, 현재 스크립트가 DNS 변경 여부를 별도 판정해주지는 않습니다
- 즉 IPv6/DNS는 지금 단계에서는 "수집은 됨, 자동 판정은 아직 약함" 으로 보는 게 정확합니다
- `watch` 모드 안내 문구는 아직 "공식 클라이언트에서 연결" 기준으로 적혀 있어, self-hosted 흐름에 맞게 wording 정리는 나중에 필요합니다

즉:

- 실제 연결 엔진이 따로 있어도
- 연결 전/후 검증은 이 스크립트로 계속 확인 가능

## 작업 시작 전 최종 체크리스트

아래가 모두 `YES` 가 되면 구현을 시작해도 됩니다.

1. 테스트 서버 공인 IP와 포트를 알고 있다
2. 서버에서 forwarding/NAT가 켜져 있다
3. 내 PC에서 쓸 연결 엔진을 정했다
4. 로컬 에이전트 권한 모델을 정했다
5. full tunnel / split tunnel 정책을 정했다
6. IPv6 처리 정책을 정했다
7. DNS 처리 정책을 정했다
8. local agent 인증 방식을 정했다
9. `popup -> background -> local agent` 흐름으로 구현하기로 확정했다

## 현재 기준 결론

이 문서대로 가려면, 초안 때 빠졌던 조건을 꼭 포함해야 합니다.

필수 보강 사항:

- popup 직통이 아니라 background 경유
- 관리자 권한/서비스 모델 명시
- 서버 NAT/포워딩 명시
- IPv6/DNS 정책 명시
- local agent 인증 명시
- 비동기 connect/status polling 구조 명시

쉽게 말하면:

- `서버 1개로 IP 바뀌는 원리 보기` 자체는 충분히 가능
- 다만 문서 초안 그대로 시작하면 중간에 막힐 확률이 높았고
- 위 보강 사항까지 넣어야 실제 구현 문서로 쓸 수 있습니다

## 다음에 바로 할 일

추천 순서:

1. 연결 엔진 후보를 1개로 확정
2. 권한 모델을 확정
3. 서버 설정 체크리스트를 별도 문서로 쪼개기
4. 그다음 특궁 새 탭 mock UI와 background feature 뼈대 추가
