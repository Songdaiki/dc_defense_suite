# 2026-04-19 Raw API 전수 연결성 Survey 진행 보고

기준 시각: `2026-04-19T10:00:12+09:00`

## 목적

최신 raw API snapshot 기준으로 순차시험을 다시 돌려서:

- 실제로 붙는 릴레이와 안 붙는 릴레이를 나누고
- 안 붙는 경우 어느 나라 후보인지와 이유가 무엇인지 기록하고
- 특히 `KR` 후보가 거의 붙는 편인지 확인하는 것

## 이번에 실제로 돌린 것

### 1. local agent 경유 순차시험

다음 명령으로 먼저 local agent 경유 전수시험을 시작했다.

```bash
node projects/self_hosted_vpn_agent/probe_latest_vpngate_relays.mjs --via-agent --limit=200 --nic=VPN2
```

실측 결과:

- 최신 raw snapshot 200개 중 실제 선택 후보는 `166개`
- 하지만 local agent 경유는 후보 1개당 대략 `1분~5분`이 걸렸다
- 따라서 이 경로로 166개 전부를 이 턴 안에 끝내는 것은 현실적으로 불가능했다

쉽게 말하면:

- 성공 후보는 연결 + 상태반영 + cleanup까지 오래 걸림
- 실패 후보는 포트 fallback까지 다 돌면 한 개당 `4~5분`도 걸림

그래서 전수조사용으로는 아래의 direct SoftEther survey를 따로 돌렸다.

### 2. direct SoftEther 연결성 survey

전수조사용으로 다음 스크립트를 추가했다.

- [survey_raw_relay_connectivity.mjs](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/projects/self_hosted_vpn_agent/survey_raw_relay_connectivity.mjs)

실행 명령:

```bash
node projects/self_hosted_vpn_agent/survey_raw_relay_connectivity.mjs --limit=200 --nic=VPN2
```

로그 파일:

- [raw_connectivity_survey_2026-04-19.log](/mnt/c/Users/eorb9/projects/dc_defense_suite_repo/docs/0419/reports/raw_connectivity_survey_2026-04-19.log)

이 survey는 다음 기준으로 본다.

- 최신 raw snapshot을 다시 받아온다
- 정규화 후 실제 시험 후보를 뽑는다
- 각 후보에 대해 SoftEther 계정을 만든다
- raw feed에 있는 SSL 포트 후보를 순서대로 붙여본다
- `AccountList` 기준으로 실제 `Connected`가 되는지 본다
- 실패 이유를 포트별로 남긴다

주의:

- 이 survey는 “전수 연결성 확인”용이다
- 공인 IP 변경까지 매 후보마다 끝까지 기다리는 full egress probe보다 훨씬 무겁지 않게 만들었지만
- 그래도 SoftEther 자체 connect/cleanup 지연 때문에 속도가 느리다

## 현재까지 확정된 결과

이번 direct survey 실행 시점 기준:

- raw hosts: `200`
- 실제 선택 후보: `164`

현재 로그로 끝까지 확인된 후보는 `1~8번`, 전부 `KR`이었다.

### KR 부분 결과

| index | IP | 국가 | 결과 | 이유 |
| --- | --- | --- | --- | --- |
| 1 | `121.164.146.116` | KR | 성공 | `995`에서 바로 Connected |
| 2 | `125.129.85.155` | KR | 성공 | `995`에서 바로 Connected |
| 3 | `121.139.2.155` | KR | 성공 | `995`에서 바로 Connected |
| 4 | `59.5.141.18` | KR | 성공 | `995`에서 바로 Connected |
| 5 | `39.122.7.147` | KR | 실패 | `995/465/1195/1493/9008` 전부 `connect-timeout` |
| 6 | `175.206.178.132` | KR | 성공 | `995`에서 바로 Connected |
| 7 | `59.4.178.139` | KR | 성공 | `995`에서 바로 Connected |
| 8 | `211.224.76.33` | KR | 실패 | `995/465/1195/1435/9008` 전부 `connect-timeout` |

정리하면 현재까지의 KR 초반 8개는:

- 성공 `6`
- 실패 `2`
- 부분 성공률 `75%`

## 현재까지 보인 실패 유형

### 유형 1. 전 포트 `Connecting` timeout

현재까지 확인된 실패 2건은 둘 다 이 유형이었다.

예시:

- `39.122.7.147` / KR
  - `995`
  - `465`
  - `1195`
  - `1493`
  - `9008`
  - 전부 `connect-timeout`

- `211.224.76.33` / KR
  - `995`
  - `465`
  - `1195`
  - `1435`
  - `9008`
  - 전부 `connect-timeout`

이건 “한국이라서 실패”라기보다, 그 릴레이 개별 상태가 현재 시점에 좋지 않은 것으로 보는 게 맞다.

## 왜 전수 완료가 아직 안 됐는가

실측 기준으로:

- 성공 후보 1개도 보통 `67~69초`
- 실패 후보 중 “전 포트 timeout”은 `287~289초`

즉 전량 `164개`를 같은 방식으로 끝까지 도는 데는 수 시간이 걸린다.

쉽게 예시로 말하면:

- 성공 1개 = 약 1분+
- 실패 1개 = 약 5분

이 속도에서는 이 턴 안에 honest하게 “전부 다 해봤다”고 말할 수 없었다.

## 현재 판단

현재까지 확인된 범위에서 보면:

- `KR` 후보가 전부 무너지는 상태는 아니다
- 오히려 초반부는 `6/8`이 붙어서 “꽤 붙는 편”이라고 볼 수 있다
- 실패한 KR 두 건도 공통적으로 “모든 raw 포트가 timeout”인 릴레이 품질 문제로 보인다

다만 아직 `KR` 전체와 `JP/US/RU/VN/...` 전체 전수 완료는 아니다.

## 이어서 돌릴 명령

전량 결과를 끝까지 채우려면 아래 명령을 그대로 다시 돌리면 된다.

```bash
node projects/self_hosted_vpn_agent/survey_raw_relay_connectivity.mjs --limit=200 --nic=VPN2 2>&1 | tee docs/0419/reports/raw_connectivity_survey_2026-04-19.log
```

## 정리 상태

중단 직후 남아 있던 `SURVEY-221-155-210-148-...` 임시 계정은 삭제했다.

현재 SoftEther 계정 상태:

- `VPNMANUAL1`만 `Offline`
- survey 계정 잔여 없음
