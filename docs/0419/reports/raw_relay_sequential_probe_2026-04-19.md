# 2026-04-19 Raw Relay 순차 시험 보고서

기준 시각: `2026-04-19T09:17:04+09:00`

## 목적

최신 공식 raw DAT 200개 snapshot 기준으로 `특궁 -> local agent -> SoftEther` 경로가 실제로 얼마나 붙는지 순차 시험했다.

쉽게 말하면:

- 목록 200개를 다시 받아온다.
- 상위 후보를 하나씩 붙여본다.
- 실제 공인 IP가 바뀌는지 본다.
- 끊은 뒤 원래 IP로 복구되는지도 같이 본다.

## 이번 패치

1. `projects/self_hosted_vpn_agent/server.mjs:939`
   raw 연결 중 추적 중이던 SoftEther account가 사라졌을 때, 이전에는 조용히 `IDLE`로 돌아갈 수 있었다.
   이제는 `CONNECT_ACCOUNT_MISSING` 오류로 남긴다.

예시:

- 원래: 계정이 사라짐 -> UI 입장에서는 그냥 멈춘 것처럼 보임
- 지금: 계정이 사라짐 -> `ERROR / CONNECT_ACCOUNT_MISSING`

2. `projects/self_hosted_vpn_agent/probe_latest_vpngate_relays.mjs:601`
   probe가 agent 상태를 볼 때 `operationId`도 같이 본다.
   연결 요청이 끝나서 `IDLE`로 돌아왔는데도 괜히 오래 기다리는 경우를 줄이기 위한 보강이다.

## 검증

- `node --check projects/self_hosted_vpn_agent/server.mjs`
- `node --check projects/self_hosted_vpn_agent/probe_latest_vpngate_relays.mjs`
- `node --check features/self-hosted-vpn/api.js`
- `node projects/self_hosted_vpn_agent/test_agent.mjs` -> `84개 self-test 통과`
- `node features/self-hosted-vpn/test_scheduler_api.mjs` -> `15개 api/scheduler test 통과`

## 순차 시험 결과 1차

조건:

- 최신 공식 raw DAT 200개 snapshot
- 국가 우선순위 기본값 `KR,JP`
- 포트 우선순위 기본값 `443,995,1698,5555,992,1194`
- local agent 경유
- NIC: `VPN2`
- 시험 개수: 상위 10개

결과: `8 / 10 성공 = 80%`

| No | Relay | 결과 | 바뀐 출구 IP | 비고 |
| --- | --- | --- | --- | --- |
| 1 | `125.129.85.155:995` | 성공 | `121.130.125.143` | cleanup 후 원복 |
| 2 | `121.139.2.155:995` | 성공 | `211.252.14.246` | cleanup 후 원복 |
| 3 | `59.5.141.18:995` | 성공 | `118.32.109.80` | cleanup 후 원복 |
| 4 | `112.166.227.144:995` | 실패 | - | `agent 연결 timeout (lastPhase=CONNECTING)` |
| 5 | `61.84.19.133:995` | 실패 | - | `agent 연결 timeout (lastPhase=IDLE)` |
| 6 | `211.34.170.219:995` | 성공 | `14.35.21.141` | cleanup 후 원복 |
| 7 | `39.122.7.147:995` | 성공 | `39.122.7.119` | cleanup 후 원복 |
| 8 | `121.164.146.116:995` | 성공 | `222.120.20.69` | cleanup 후 원복 |
| 9 | `1.238.166.231:995` | 성공 | `1.237.182.174` | cleanup 후 원복 |
| 10 | `175.206.178.132:995` | 성공 | `121.187.231.105` | cleanup 후 원복 |

## 순차 시험 결과 2차 재시험

같은 흐름으로 상위 5개를 다시 돌렸다.

결과: `4 / 5 성공 = 80%`

| No | Relay | 결과 | 바뀐 출구 IP | 비고 |
| --- | --- | --- | --- | --- |
| 1 | `125.129.85.155:995` | 성공 | `121.130.125.143` | 안정적 |
| 2 | `121.139.2.155:995` | 성공 | `211.252.14.246` | 안정적 |
| 3 | `59.5.141.18:995` | 성공 | `118.32.109.80` | 안정적 |
| 4 | `112.166.227.144:995` | 실패 | - | 다시 `CONNECTING` timeout |
| 5 | `61.84.19.133:995` | 성공 | `121.168.52.11` | 1차 실패 후 재시험 성공 |

## 실패 원인 분해

### 1. `112.166.227.144`는 실제 릴레이 불안정으로 판단

이 후보는 raw feed에 있는 SSL 포트 전체를 직접 분해 시험했다.

- `995` -> `connect timeout last=Connecting`
- `465` -> `connect timeout last=Connecting`
- `1195` -> `connect timeout last=Connecting`
- `1807` -> `connect timeout last=Connecting`
- `9008` -> `connect timeout last=Connecting`

각 포트는 대략 `72~74초` 동안 `Connecting` 상태에 머물렀다.

즉 결론은 이렇다.

- 이 후보는 "selected 포트만 죽은 경우"가 아니다.
- 현재 시점에는 raw feed에 나온 SSL 포트 전체가 실제 세션 수립을 완료하지 못한다.
- local agent 파서/상태머신 문제가 아니라, 릴레이 자체 상태 문제로 보는 게 맞다.

### 2. `61.84.19.133`는 릴레이 변동성 케이스로 판단

1차에서는 `lastPhase=IDLE` timeout으로 실패했지만 2차에서는 정상 연결되어 출구 IP가 바뀌었다.

쉽게 말하면:

- 1차: 서버가 응답을 끊거나 세션이 중간에 내려감
- 2차: 같은 raw 정보로도 정상 연결됨

이건 코드보다는 공용 릴레이 특유의 변동성 영향이 더 크다.

## 이번 결과에서 확인된 것

1. 최신 raw snapshot만으로도 실제 IP 변경은 가능하다.
2. local agent가 연결 후 cleanup까지 수행하면서 원래 공인 IP로 복구되는 것도 확인했다.
3. 성공률을 막는 가장 큰 요인은 현재 시점의 공용 릴레이 품질이다.
4. local agent 쪽은 이번 패치로 "조용히 IDLE 복귀" 같은 애매한 실패를 오류로 남기게 됐다.

## 남은 과제

1. `112.166.227.144` 같은 `all ports CONNECTING timeout` 릴레이는 조기 배제 규칙을 둘 수 있다.
2. 순차 라운드 모드에서 실패한 릴레이를 일정 시간 cooldown 처리하면 전체 체감 성공률이 더 올라간다.
3. UI 쪽에는 "현재 실제로 연결된 SoftEther account 이름"과 "마지막 실패 유형"을 더 강하게 보여주는 보강이 필요하다.

## 최종 판단

현재 기준으로는 "latest raw 200 snapshot 기반 순차 연결"이 완전히 막힌 상태는 아니다.

예시로:

- 1차 `8/10`
- 2차 `4/5`

즉 로컬 엔진 경로는 실제 IP 변경까지 되는 상태이고, 남은 실패 대부분은 특정 공용 릴레이 품질 문제로 보는 게 맞다.
