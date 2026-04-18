# VPNGate 공식 DAT 해독 정리

## 1. 한 줄 결론

VPNGate 공식 클라이언트가 받는 목록은 공개 CSV가 아니라 **raw DAT payload**다.  
이 DAT를 그대로 읽으면 개수를 정확히 알 수 없고, 아래 순서로 풀어야 실제 서버 레코드가 나온다.

1. raw DAT에서 `header20` 20바이트를 읽는다.
2. `SHA1(header20)`을 만든다.
3. 그 해시값을 RC4 키로 사용해 body를 복호화한다.
4. 복호화 결과의 **outer PACK**에서 `data`를 꺼낸다.
5. 그 `data`를 **inner PACK**으로 다시 읽으면 `NumHosts`, `IP`, `CountryShort` 같은 실제 필드가 나온다.

쉽게 말하면:

- 잘못된 방식: `DAT를 그냥 열어 보고 대충 개수 추정`
- 맞는 방식: `header20 -> SHA1 -> RC4 -> PACK 2단계 파싱`


## 2. 왜 "92개" 같은 이상한 숫자가 나왔는가

문제는 **서버 목록이 평문으로 바로 들어 있지 않다**는 점이다.

예시:

- raw DAT 파일 크기: `75672 bytes`
- 이 숫자는 그냥 파일 크기일 뿐이다.
- HTTP `Content-Length`도 파일 크기일 뿐이다.
- outer PACK 안에는 실제 목록이 아니라 `data`, `sign`, `timestamp`, `compressed` 같은 래퍼 필드가 먼저 있다.

즉, 중간 단계에서 멈추면:

- "몇 bytes 받았는지"는 알 수 있지만
- "서버가 몇 개인지"는 모른다

이번 샘플에서는 최종 inner PACK까지 들어가서 확인했고, 그 값이 `NumHosts = 200` 이었다.


## 3. 이번에 확인한 실제 요청/응답

Wireshark에서 잡힌 핵심 흐름:

- DNS: `xd.x1.client.api.vpngate2.jp`
- HTTP GET: `http://xd.x1.client.api.vpngate2.jp/api/?session_id=...`
- 응답 `Content-Type`: `application/octet-stream`

예시 요청:

```http
GET /api/?session_id=14075046875061338458 HTTP/1.1
Host: xd.x1.client.api.vpngate2.jp
Accept-Language: ja
Cache-Control: no-cache
Pragma: no-cache
User-Agent: Mozilla/5.0 (Windows NT 6.3; WOW64; rv:29.0) Gecko/20100101 Firefox/29.0
```

예시 응답 시작:

```text
[VPNGate Data File]
20260418_132309.114

<SOAP_URL>http://list-server-tmp-2.vpngate.net/vpngate.asmx?op=GetVpnGateHostList</SOAP_URL>
```


## 4. raw DAT 파일 구조

이번 샘플(`/tmp/vpngate-fetch.raw.dat`) 기준:

- 전체 파일 크기: `75672`
- 헤더 종료 / payload 시작 오프셋: `240 (0xF0)`
- payload 크기: `75432`

구조는 이렇게 보면 된다.

```text
0x000 ~ 0x0EF : ASCII 헤더
0x0F0 ~ 0x103 : header20 (20 bytes)
0x104 ~ end   : RC4 대상 body
```

이번 샘플의 `header20`:

```text
69e3512c1ec70604dddb95a96bb3ebc69a9c5ace
```

이 20바이트를 그대로 RC4 키로 쓰는 게 아니라, 아래처럼 한 번 더 SHA-1 한다.

```text
SHA1(header20) = 17488804bf0c8eaa36099a70e2208ea1535bce9f
```


## 5. 실제 해독 알고리즘

### 5-1. 복호화 순서

실제 복호화 순서는 아래와 같다.

1. raw DAT 파일을 읽는다.
2. `0xF0 ~ 0x103` 구간 20바이트를 `header20`으로 잡는다.
3. `0x104 ~ end` 구간을 암호화된 body로 잡는다.
4. `SHA1(header20)`을 만든다.
5. `SHA1(header20)`을 RC4 키로 사용해 body를 복호화한다.
6. 복호화 결과를 **outer PACK**으로 파싱한다.
7. outer PACK의 `data` 필드를 꺼낸다.
8. `compressed != 0`이면 압축 해제한다.
9. 그 결과를 **inner PACK**으로 파싱한다.
10. inner PACK의 `NumHosts`, `IP`, `CountryShort`, `Fqdn`, `HostName` 등을 읽는다.

### 5-2. outer PACK에서 확인한 필드

이번 샘플의 outer PACK은 총 6개 element였다.

- `data`
- `data_size`
- `sign`
- `soap_url`
- `timestamp`
- `compressed`

실제 값:

- `compressed = 0`
- `data_size = 75061`
- `timestamp = 1776486189113`
- `timestampIso = 2026-04-18T04:23:09.113Z`

즉 이번 샘플은 **압축이 없어서** outer `data`를 바로 inner PACK으로 읽으면 됐다.


## 6. 실제 해독 결과

이번 샘플 기준 최종 결과는 아래다.

### 6-1. 전체 개수

- `NumHosts = 200`
- `IP 레코드 수 = 200`
- `고유 IP 수 = 199`
- 중복 IP 1개: `114.183.136.251` 2회

### 6-2. 국가 분포

- `JP`: 104
- `KR`: 62
- `RU`: 13
- `TH`: 12
- `VN`: 5
- `AU`: 1
- `PA`: 1
- `US`: 1
- `RO`: 1

### 6-3. 한국(KR) 개수

- `KR = 62`

예시:

- `59.8.22.212`
- `121.159.129.220`
- `121.165.121.91`
- `175.202.155.37`
- `222.235.78.80`

### 6-4. 첫 번째 서버 예시

첫 번째 서버 레코드는 이렇게 복원된다.

```json
{
  "Name": "public-vpn-51",
  "IP": "219.100.37.13",
  "CountryShort": "JP",
  "CountryFull": "Japan",
  "Fqdn": "public-vpn-51.opengw.net",
  "HostName": "public-vpn-01-13.vpngate.v4.open.ad.jp",
  "SslPorts": "443",
  "UdpPort": 38033
}
```


## 7. 실제로 만든 스크립트

이번 분석 결과를 바탕으로, raw DAT를 재현 가능하게 읽는 스크립트 2개를 만들었다.

### 7-1. `scripts/parse-vpngate-dat.mjs`

역할:

- raw DAT를 strict하게 읽는다.
- 헤더, payload offset, payload size, SHA-256 같은 **메타 정보**를 뽑는다.
- fallback 없이 raw DAT만 기준으로 본다.

이 스크립트는 "정말 DAT가 맞는지", "payload가 어디서 시작하는지"를 확인할 때 쓴다.

예시:

```bash
node scripts/parse-vpngate-dat.mjs \
  --input /tmp/vpngate-fetch.raw.dat \
  --output /tmp/vpngate-dat-parsed.json \
  --payload-output /tmp/vpngate-payload-from-script.bin
```

이번 샘플에서 나온 핵심 값:

- `payloadOffset = 240`
- `payloadSize = 75432`
- `payloadPreviewHex = 69e3512c1ec70604dddb95a96bb3ebc69a9c5ace...`

즉 preview 앞 20바이트가 `header20`이라는 뜻이다.

### 7-2. `scripts/decode-vpngate-official-dat.mjs`

역할:

- raw DAT 전체를 받아서
- `header20 -> SHA1 -> RC4`
- outer PACK
- inner PACK

까지 끝까지 복원해서 **실제 서버 목록 JSON**을 만든다.

예시:

```bash
node scripts/decode-vpngate-official-dat.mjs \
  --input /tmp/vpngate-fetch.raw.dat \
  --output /tmp/vpngate-official-feed.json
```

이번 샘플 실행 결과:

```text
공식 VPNGate DAT 복원 완료
- source: /tmp/vpngate-fetch.raw.dat
- hosts: 200
- request_ip: 184.98.2.238
- rc4_key_sha1: 17488804bf0c8eaa36099a70e2208ea1535bce9f
- output: /tmp/vpngate-official-feed.json
- first_host: public-vpn-51 / 219.100.37.13 / JP
```


## 8. 결과 JSON에서 바로 볼 수 있는 것

`decode-vpngate-official-dat.mjs` 결과 JSON에는 아래가 들어 있다.

- `dat`: 원본 파일 정보
- `payload.header20Hex`
- `payload.rc4KeySha1Hex`
- `outer`: outer PACK 정보
- `feed.numHosts`
- `feed.globals`
- `feed.hostFieldNames`
- `feed.hosts[]`

즉 나중에는 이 JSON만 보면:

- 전체 서버 수
- IP 목록
- 국가 코드
- 포트
- FQDN
- HostName

을 바로 쓸 수 있다.


## 9. 왜 CSV / HTML fallback을 섞으면 안 되는가

목표가 "공식 클라이언트가 지금 실제로 주는 exact 목록"이면, CSV나 HTML fallback을 섞으면 안 된다.

이유는 간단하다.

- CSV는 공개용 포맷이라 개수가 다를 수 있다.
- HTML은 페이지 노출용이라 필터가 다를 수 있다.
- DAT는 실제 클라이언트가 직접 받는 포맷이다.

예시:

- 우리가 원하는 값: `지금 클라이언트가 받는 200개`
- fallback이 섞인 값: `웹 공개 페이지 기준 일부/별도 기준 개수`

그래서 이번 스크립트는 둘 다 **strict DAT only**로 맞춰 두었다.


## 10. 이번 샘플 기준 체크포인트

나중에 같은 문제를 다시 볼 때는 아래 순서로 점검하면 된다.

1. raw DAT를 잡았는가  
   예시: `/tmp/vpngate-fetch.raw.dat`

2. `parse-vpngate-dat.mjs`로 `payloadOffset = 240` 근처가 맞는가

3. payload preview 앞 20바이트가 `header20`처럼 보이는가

4. `SHA1(header20)` 값을 RC4 키로 써서 outer PACK이 정상 파싱되는가

5. outer PACK에 아래 6개가 보이는가
   - `data`
   - `data_size`
   - `sign`
   - `soap_url`
   - `timestamp`
   - `compressed`

6. inner PACK에 `NumHosts`, `IP`, `CountryShort`, `Fqdn`이 보이는가

7. 최종 `NumHosts`가 실제 레코드 개수와 맞는가


## 11. 이번 분석에서 확정된 값 요약

- raw DAT endpoint:
  - `http://xd.x1.client.api.vpngate2.jp/api/?session_id=...`
- 실제 포맷:
  - DAT header + 20-byte header20 + encrypted body
- 실제 키 도출:
  - `RC4 key = SHA1(header20)`
- 실제 목록 위치:
  - outer PACK의 `data`
- 이번 샘플 실제 목록 수:
  - `200`
- 이번 샘플 한국 IP 수:
  - `62`


## 12. 한 번에 이해하는 예시

예를 들어 이번 파일을 그냥 열면:

- `[VPNGate Data File]`
- timestamp
- SOAP_URL
- 뒤에는 이상한 바이너리

만 보인다.

여기서 멈추면 "아직 서버 목록을 본 게 아니다".

반대로 복호화까지 끝내면:

- outer PACK: `data`, `timestamp`, `compressed`
- inner PACK: `NumHosts = 200`, `IP[0] = 219.100.37.13`, `CountryShort[0] = JP`

이렇게 실제 레코드를 읽게 된다.


## 13. 관련 파일

- 캡처: `docs/0418/1.pcapng`
- 캡처 이미지: `docs/0418/image.png`
- 관련 계획 문서: `docs/0418/vpngate_exact_ip_preblock_tabs_plan.md`
- strict DAT 메타 파서: `scripts/parse-vpngate-dat.mjs`
- 공식 DAT 복원기: `scripts/decode-vpngate-official-dat.mjs`

