# VPNGate Exact-IP 선제 차단 전용 탭 사양 문서

> 작성일: 2026-04-18  
> 문서 성격: 사용자 요청안을 그대로 정리한 운영/구현 사양 초안  
> 목적: VPNGate 풀을 선제적으로 exact IP 차단에 반영하기 위한 전용 탭 구조 문서화

## 1. 목표

이 문서의 목표는 아래 운영안을 그대로 정리하는 것이다.

1. 공격자가 사용하는 VPNGate 풀을 선제적으로 막는다.
2. `123.45.**.**` 같은 마스킹 대역 차단이 아니라 **정확히 같은 IP만** 차단 대상으로 만든다.
3. 일반 갤러리 글/댓글 흐름을 더럽히지 않도록 **완전히 별도 목적의 전용 탭**으로만 처리한다.
4. 작업 대상은 **지정한 옛날 게시물 URL 1개**로 제한한다.
5. 생성 작업과 정리 작업을 **서로 다른 탭**으로 분리한다.
6. 기존 `분탕경고`, `분탕자동차단`, `게시물 감시`, `댓글 감시`와는 연결하지 않고 **완전히 독립 기능**으로 둔다.

## 2. 전제

이 사양은 아래 전제를 둔다.

1. 공격자는 VPNGate 풀을 사용한다.
2. 갤러리 UI에서는 보통 마스킹된 대역만 보여서 exact IP 후조치가 어렵다.
3. exact IP를 차단용으로 확보하려면 댓글 생성 -> 차단 기록 반영 같은 우회 절차가 필요하다.
4. 일반 게시물/일반 댓글 흐름과 섞이면 운영 로그가 더러워질 수 있으므로, 전용 작업 흐름으로 분리해야 한다.

## 3. 운영 개념

운영 개념은 dataset 운영과 비슷하게 잡는다.

1. 처음에는 VPNGate 풀을 한 번 선제적으로 막아 base처럼 사용한다.
2. 이후 새로 보이는 exact IP가 있으면 overlay처럼 추가 갱신한다.
3. 한 번 쌓아 둔 exact IP 차단 데이터는 계속 재사용한다.

쉽게 말하면:

- 제목 dataset:
  - 예전에 모아둔 제목들을 계속 재사용
- exact IP 차단셋:
  - 예전에 확보한 VPNGate exact IP를 계속 재사용
  - 새로 생긴 exact IP만 추가 반영

## 4. 탭 분리 구조

구조는 반드시 아래처럼 분리한다.

### 4.1 생성 탭

역할:

- 지정한 옛날 게시물 URL 하나에서만
- exact IP 차단 갱신용 댓글을 생성한다.

핵심 조건:

1. 일반 게시물 작성 금지
2. 일반 댓글 작성 금지
3. 반드시 사용자가 입력한 **옛날 게시물 URL 1개**에서만 동작
4. 댓글 내용은 전부 식별 가능한 고정 패턴만 사용

예시 댓글:

- `차단갱신중1`
- `차단갱신중2`
- `차단갱신중3`

즉 생성 탭은 “차단 갱신용 마커 댓글”만 달아야 한다.

### 4.2 정리 탭

역할:

- 생성 탭이 사용한 같은 옛날 게시물 URL에 대해
- `차단갱신중` 키워드가 포함된 댓글만 찾아서
- 삭제 및 IP 차단 정리 작업만 수행한다.

핵심 조건:

1. 지정한 게시물 URL 1개에서만 동작
2. `차단갱신중` 포함 댓글만 처리
3. 일반 댓글은 절대 건드리지 않음
4. 삭제 대상과 IP 차단 대상은 오직 전용 마커 댓글만

예시:

- 처리 대상:
  - `차단갱신중1`
  - `차단갱신중25`
- 처리 제외:
  - 일반 유저 댓글
  - 다른 키워드 댓글
  - 다른 게시물의 댓글

## 5. 생성 탭 상세 사양

### 5.1 입력값

생성 탭은 최소한 아래 입력값을 가진다.

1. 대상 게시물 URL
2. 시작 번호
3. 종료 번호 또는 생성 개수
4. 댓글 접두어

기본 접두어 예시:

- `차단갱신중`

최종 생성 문자열 예시:

- `차단갱신중1`
- `차단갱신중2`
- `차단갱신중3`

### 5.2 실행 규칙

1. 반드시 대상 게시물 URL 1개에 대해서만 실행
2. 순차적으로 댓글 생성
3. 일반 방어 기능과 별도 로그로 기록
4. 일반 댓글 방어/게시물 방어 로직과 섞지 않음

### 5.3 금지사항

1. 새 게시물 작성 금지
2. 여러 게시물에 분산 작성 금지
3. 일반 문구 댓글 금지
4. 마커 규칙 외 임의 문자열 사용 금지

## 6. 정리 탭 상세 사양

### 6.1 입력값

정리 탭은 최소한 아래 입력값을 가진다.

1. 대상 게시물 URL
2. 필터 키워드

기본 필터 키워드:

- `차단갱신중`

### 6.2 필터 조건

정리 탭은 아래 조건을 모두 만족하는 댓글만 처리한다.

1. 대상 게시물 URL의 댓글일 것
2. 댓글 내용에 `차단갱신중`이 포함될 것

즉 아래처럼 동작한다.

- `차단갱신중14`
  - 처리
- `차단갱신중-테스트`
  - 처리
- `안녕하세요`
  - 미처리
- 다른 글의 `차단갱신중7`
  - 미처리

### 6.3 실행 동작

1. 대상 댓글 식별
2. 해당 댓글 삭제
3. 해당 댓글에 연결된 exact IP 차단 반영
4. 일반 댓글에는 영향 없음

## 7. 분리 원칙

이 기능은 반드시 일반 방어 로직과 분리해야 한다.

분리 원칙:

1. 전용 탭으로만 진입
2. 전용 URL 입력으로만 동작
3. 전용 키워드 댓글만 생성
4. 전용 키워드 댓글만 정리
5. 일반 게시물/일반 댓글 흐름과 섞지 않음
6. 전용 로그/전용 상태/전용 통계로 관리
7. 기존 `분탕경고`, `분탕자동차단`, `감시 자동화` 쪽 상태/토글/설정과 공유하지 않음

쉽게 말하면:

- 일반 자동화:
  - 갤러리 전체를 보는 방어 기능
- 이번 기능:
  - 특정 옛날 글 1개를 exact IP 차단 갱신용 작업장으로 쓰는 전용 기능

## 8. 다른 이용자 영향 최소화 원칙

이 기능은 일반 이용자에게 영향이 가지 않도록 아래 원칙을 반드시 지켜야 한다.

### 8.1 범위 최소화

1. 작업 대상은 항상 **사용자가 직접 지정한 옛날 게시물 URL 1개**다.
2. 해당 URL 밖의 댓글/게시물은 조회는 가능해도 처리 대상이 아니다.
3. 일반 갤러리 페이지 전체를 돌면서 생성/삭제 작업을 하지 않는다.
4. 전용 작업은 “특정 작업장 게시물 1개” 안에서만 끝나야 한다.

쉽게 말하면:

- 허용:
  - `옛날 게시물 A` 안에서만 `차단갱신중N` 댓글 생성/정리
- 금지:
  - 다른 게시물로 퍼짐
  - 일반 최신 글에 마커 댓글 생성
  - 갤러리 전체 댓글 일괄 정리

### 8.2 처리 대상 최소화

1. 생성 탭은 `차단갱신중` 접두어를 가진 전용 댓글만 만든다.
2. 정리 탭은 `차단갱신중` 포함 댓글만 처리한다.
3. 일반 사용자가 단 댓글은 절대 처리 대상이 아니다.
4. 제목, 닉네임, 작성 시각 등이 비슷해도 `차단갱신중` 키워드가 없으면 건드리지 않는다.

예시:

- `차단갱신중17`
  - 처리 가능
- `차단갱신중_테스트`
  - 처리 가능
- `차단 갱신 중`
  - 기본 규칙과 다르면 미처리
- `안녕하세요`
  - 미처리
- `vpn gate 왜 안됨?`
  - 미처리

즉 이 기능은 “전용 마커 댓글만 생성하고 전용 마커 댓글만 정리”하는 구조여야 한다.

### 8.3 운영 흔적 최소화

이 문서에서 말하는 “조용히”의 의미는 아래처럼 정리한다.

1. 갤러리 전체 흐름에 섞이지 않게 한다.
2. 일반 사용자 댓글/일반 게시물과 분리된 별도 작업장 게시물에서만 수행한다.
3. 일반 방어 탭과 로그, 상태, 버튼을 섞지 않는다.
4. 생성 탭과 정리 탭도 서로 분리해 역할을 명확히 나눈다.

즉 목표는 “갤러리 전체에 퍼지지 않게 하고, 다른 사용자가 보는 일반 흐름에 영향을 최소화하는 것”이다.

## 9. 오동작 차단 조건

이 기능은 아래 조건이 하나라도 깨지면 실행을 막는 식으로 설계하는 것을 전제로 한다.

1. 대상 게시물 URL이 비어 있으면 실행 금지
2. 대상 URL이 허용된 형식이 아니면 실행 금지
3. 접두어가 `차단갱신중` 규칙과 다르면 생성 금지
4. 정리 탭에서 필터 키워드가 비어 있으면 실행 금지
5. 정리 대상 댓글에 `차단갱신중`이 없으면 삭제/IP차단 금지
6. 다른 게시물의 댓글이면 처리 금지
7. 일반 댓글이 섞여 있으면 전용 댓글만 부분 처리

예시:

- 상황:
  - 대상 글에 댓글 10개 존재
  - 그중 3개만 `차단갱신중`
- 기대 결과:
  - 3개만 처리
  - 나머지 7개는 그대로 유지

즉 정리 탭은 “해당 게시물 전체 댓글 정리”가 아니라 “해당 게시물 안의 전용 댓글만 정리”여야 한다.

## 10. 데이터 운영 개념

이 기능으로 얻는 exact IP 차단 결과는 “한 번 만들고 계속 쓰는 기본 풀” 개념으로 본다.

운영 개념:

1. 처음 구축한 차단 풀
  - base 성격
2. 이후 추가 갱신한 차단 풀
  - overlay 성격
3. 실제 런타임에서는 둘을 합쳐 exact IP 차단에 사용

즉 구조적으로는 아래 개념이다.

- base:
  - 초기에 막아 둔 VPNGate exact IP 묶음
- overlay:
  - 나중에 추가로 갱신한 exact IP 묶음

## 11. UI 문구 예시

### 생성 탭 예시 문구

- `대상 게시물 URL`
- `댓글 접두어`
- `시작 번호`
- `끝 번호`
- `차단 갱신 댓글 생성 시작`

### 정리 탭 예시 문구

- `대상 게시물 URL`
- `필터 키워드`
- `차단갱신중 댓글만 삭제/IP차단`
- `정리 시작`

## 12. 실행 예시

예시 1. 생성 탭

입력:

- 대상 URL: `https://.../board/view/?id=...&no=123`
- 접두어: `차단갱신중`
- 시작 번호: `1`
- 끝 번호: `3`

실행 결과:

- `차단갱신중1`
- `차단갱신중2`
- `차단갱신중3`

이 3개만 해당 게시물에 순차 생성

예시 2. 정리 탭

입력:

- 대상 URL: `https://.../board/view/?id=...&no=123`
- 필터 키워드: `차단갱신중`

실행 결과:

- `차단갱신중1` 삭제/처리
- `차단갱신중2` 삭제/처리
- 일반 댓글은 유지

## 13. 구현 범위 분해

다른 에이전트가 구현할 때는 기능을 아래 4덩어리로 쪼개서 본다.

1. popup UI
   - 입력 폼
   - 버튼
   - 진행 상태
   - 로그 표시
2. background 상태 관리자
   - 저장/복원
   - start/stop/reset
   - 실행 상태 전이
3. exact IP 데이터 관리자
   - base/overlay 메타데이터
   - dedupe
   - enable/disable
   - export
4. 외부 실행 인터페이스
   - 생성 계획 실행기
   - 정리 계획 실행기

여기서 popup/background/state/data manager는 다른 에이전트가 바로 구현 가능한 공통 코드로 잡고,
외부 실행부는 별도 executor 인터페이스 뒤로 숨긴다.

## 14. 권장 파일 분리

아래는 구현 시 권장 파일 분리안이다.

### 14.1 popup 쪽

- `popup/popup.js`
  - 탭 이벤트 바인딩
  - 입력값 검증
  - 상태 렌더링
- `popup/vpngate-exact-ip-tabs.js`
  - 생성 탭/정리 탭 전용 UI 로직 분리

### 14.2 background 쪽

- `background/background.js`
  - 메시지 라우팅만 담당
- `features/vpngate-exact-ip/generation-controller.js`
  - 생성 탭 상태관리
- `features/vpngate-exact-ip/cleanup-controller.js`
  - 정리 탭 상태관리
- `features/vpngate-exact-ip/storage.js`
  - storage read/write
- `features/vpngate-exact-ip/exact-ip-dataset.js`
  - base/overlay merge, dedupe, export
- `features/vpngate-exact-ip/executor-interface.js`
  - 실제 외부 실행부를 감싸는 인터페이스

주의:

- 이 기능은 `features/uid-warning-autoban/*`
- `features/monitor/*`
- `features/comment/*`

같은 기존 방어 모듈 안에 끼워 넣지 않고,
`features/vpngate-exact-ip/*` 아래의 **완전 독립 네임스페이스**로 두는 것을 전제로 한다.

### 14.3 문서 기준 책임 분리

- controller:
  - 상태 전이
  - 로그 기록
  - saveState 호출
- storage:
  - schema normalize
  - migration
- dataset:
  - exact IP 엔트리 합치기
  - JSON import/export
- executor interface:
  - 계획(plan)을 받아 실행 결과(result)만 반환

## 15. UI 상세 스펙

### 15.1 생성 탭 입력 폼

필수 입력:

1. `대상 게시물 URL`
2. `댓글 접두어`
3. `시작 번호`
4. `끝 번호`

선택 입력:

1. `중복 허용 여부`
2. `dry-run`
3. `실행 메모`

권장 기본값:

- 댓글 접두어: `차단갱신중`
- 시작 번호: `1`
- 끝 번호: `10`
- 중복 허용 여부: `false`
- dry-run: `false`

버튼:

1. `설정 저장`
2. `생성 시작`
3. `중지`
4. `통계 초기화`
5. `계획 미리보기`

표시 필드:

1. 현재 상태
2. 대상 URL
3. 마지막 실행 시각
4. 마지막 처리 번호
5. 누적 계획 개수
6. 누적 성공 개수
7. 누적 실패 개수

### 15.2 정리 탭 입력 폼

필수 입력:

1. `대상 게시물 URL`
2. `필터 키워드`

선택 입력:

1. `dry-run`
2. `실행 메모`

권장 기본값:

- 필터 키워드: `차단갱신중`
- dry-run: `false`

버튼:

1. `설정 저장`
2. `정리 시작`
3. `중지`
4. `통계 초기화`
5. `대상 미리보기`

표시 필드:

1. 현재 상태
2. 대상 URL
3. 마지막 실행 시각
4. 마지막 처리 댓글 수
5. 누적 처리 개수
6. 누적 exact IP 반영 개수
7. 누적 실패 개수

## 16. 상태값 설계

### 16.1 생성 탭 상태

권장 상태 enum:

- `IDLE`
- `READY`
- `RUNNING`
- `WAITING`
- `COMPLETED`
- `FAILED`
- `STOPPED`

상태 의미:

- `IDLE`
  - 아직 설정 미저장
- `READY`
  - 설정 저장 완료, 시작 가능
- `RUNNING`
  - 현재 계획 실행 중
- `WAITING`
  - 다음 순번 대기
- `COMPLETED`
  - 계획한 번호 범위 처리 완료
- `FAILED`
  - 실행 실패
- `STOPPED`
  - 사용자가 중지

### 16.2 정리 탭 상태

권장 상태 enum:

- `IDLE`
- `READY`
- `SCANNING`
- `RUNNING`
- `COMPLETED`
- `FAILED`
- `STOPPED`

상태 의미:

- `SCANNING`
  - 정리 대상 댓글 목록 식별 중
- `RUNNING`
  - 정리 실행 중

## 17. storage 키 설계

권장 storage 키:

- `vpngateExactIpGenerationState`
- `vpngateExactIpCleanupState`
- `vpngateExactIpBaseDataset`
- `vpngateExactIpOverlayDataset`

### 17.1 생성 탭 상태 스키마 예시

```json
{
  "phase": "READY",
  "isRunning": false,
  "config": {
    "targetPostUrl": "",
    "markerPrefix": "차단갱신중",
    "startIndex": 1,
    "endIndex": 10,
    "allowDuplicates": false,
    "dryRun": false,
    "memo": ""
  },
  "lastRunAt": "",
  "lastProcessedIndex": 0,
  "totalPlannedCount": 0,
  "totalSuccessCount": 0,
  "totalFailureCount": 0,
  "logs": []
}
```

### 17.2 정리 탭 상태 스키마 예시

```json
{
  "phase": "READY",
  "isRunning": false,
  "config": {
    "targetPostUrl": "",
    "filterKeyword": "차단갱신중",
    "dryRun": false,
    "memo": ""
  },
  "lastRunAt": "",
  "lastMatchedCount": 0,
  "totalProcessedCount": 0,
  "totalExactIpAppliedCount": 0,
  "totalFailureCount": 0,
  "logs": []
}
```

### 17.3 exact IP dataset 스키마 예시

```json
{
  "version": 1,
  "updatedAt": "2026-04-18T00:00:00.000Z",
  "entries": [
    {
      "ip": "1.2.3.4",
      "source": "vpngate_preblock",
      "layer": "base",
      "enabled": true,
      "addedAt": "2026-04-18T00:00:00.000Z",
      "note": ""
    }
  ]
}
```

## 18. message action 설계

popup <-> background 메시지는 아래처럼 분리하는 것을 권장한다.

### 18.1 생성 탭 액션

- `getVpnGateExactIpGenerationStatus`
- `updateVpnGateExactIpGenerationConfig`
- `startVpnGateExactIpGeneration`
- `stopVpnGateExactIpGeneration`
- `resetVpnGateExactIpGenerationStats`
- `previewVpnGateExactIpGenerationPlan`

### 18.2 정리 탭 액션

- `getVpnGateExactIpCleanupStatus`
- `updateVpnGateExactIpCleanupConfig`
- `startVpnGateExactIpCleanup`
- `stopVpnGateExactIpCleanup`
- `resetVpnGateExactIpCleanupStats`
- `previewVpnGateExactIpCleanupTargets`

### 18.3 dataset 액션

- `getVpnGateExactIpDatasetStatus`
- `importVpnGateExactIpBaseDataset`
- `importVpnGateExactIpOverlayDataset`
- `exportVpnGateExactIpBaseDataset`
- `exportVpnGateExactIpOverlayDataset`
- `mergeVpnGateExactIpDatasets`
- `toggleVpnGateExactIpEntryEnabled`

## 19. 로그 포맷

다른 에이전트가 구현할 때는 popup에 이미 쓰는 시간표기/상태표기 스타일과 비슷하게만 맞추고,
기능적으로는 기존 스케줄러와 독립 로그로 구현하는 것을 전제로 한다.

예시:

- `[오전 03:12:01] 🟢 생성 준비 완료`
- `[오전 03:12:05] 📌 대상 게시물 확인 완료`
- `[오전 03:12:08] 🧾 계획 10건 생성`
- `[오전 03:12:15] ✅ 1번 계획 처리 완료`
- `[오전 03:13:22] ⚠️ 4번 계획 처리 실패 - ...`
- `[오전 03:14:00] 🧹 정리 대상 12건 식별`
- `[오전 03:14:20] ✅ exact IP 9건 반영`

로그 원칙:

1. URL 전체를 반복 출력하지 않는다.
2. 일반 댓글 내용은 로그에 풀텍스트로 남기지 않는다.
3. 전용 마커 번호나 처리 건수 중심으로 남긴다.

## 20. 검증 규칙

### 20.1 생성 탭 검증

1. URL이 비어 있으면 실패
2. URL이 게시물 view 형식이 아니면 실패
3. 접두어가 비어 있으면 실패
4. 접두어가 허용 규칙과 다르면 실패
5. 시작 번호가 1 미만이면 실패
6. 끝 번호가 시작 번호보다 작으면 실패

### 20.2 정리 탭 검증

1. URL이 비어 있으면 실패
2. URL이 게시물 view 형식이 아니면 실패
3. 필터 키워드가 비어 있으면 실패
4. 필터 키워드가 전용 마커 규칙과 다르면 실패

### 20.3 dataset 검증

1. IP 형식이 아니면 import 제외
2. 중복 exact IP는 마지막 엔트리 우선 또는 base 우선 정책 중 하나로 통일
3. `enabled=false`는 런타임 Set에 넣지 않음

## 21. base / overlay merge 규칙

권장 규칙:

1. base 먼저 읽기
2. overlay 다음 읽기
3. 같은 IP가 겹치면 overlay가 최신 상태를 덮어씀
4. 최종적으로 `enabled=true`만 Set에 넣음

예시:

- base:
  - `1.2.3.4 enabled=true`
- overlay:
  - `1.2.3.4 enabled=false`
  - `5.6.7.8 enabled=true`

최종 runtime Set:

- `5.6.7.8`만 포함

## 22. executor interface 경계

외부 실행부는 다른 에이전트가 채우더라도 controller가 직접 외부 세부 구현을 알지 않도록 인터페이스 경계를 둔다.

권장 인터페이스 예시:

```js
async function previewGenerationPlan(config) {}
async function runGenerationPlan(config, handlers = {}) {}
async function previewCleanupTargets(config) {}
async function runCleanupPlan(config, handlers = {}) {}
```

controller가 기대하는 것은 아래뿐이다.

1. 계획 목록 반환
2. 진행 콜백
3. 성공/실패 결과 반환

즉 controller는 “어떻게 실행되는지”가 아니라 “무슨 결과가 돌아오는지”만 알게 만든다.

## 23. 다른 에이전트용 구현 순서

다른 에이전트는 아래 순서로 구현하면 된다.

1. storage schema 추가
2. popup 탭 UI 추가
3. background 메시지 라우팅 추가
4. generation/cleanup controller 추가
5. dataset merge/export 추가
6. preview 액션부터 먼저 연결
7. start/stop/reset 액션 연결
8. 마지막에 executor interface 구현 연결

쉽게 말하면:

- 1차:
  - UI + 상태 저장 + preview
- 2차:
  - start/stop + 로그
- 3차:
  - dataset merge/export
- 4차:
  - 외부 실행부 연결

## 24. 최종 요약

이 문서를 구현 문서로 읽을 때 핵심은 아래 7줄이다.

1. 생성 탭과 정리 탭은 완전히 분리한다.
2. 작업 범위는 항상 사용자가 지정한 게시물 URL 1개다.
3. 전용 마커 댓글만 생성하고 전용 마커 댓글만 정리한다.
4. popup/background/storage/dataset/executor를 역할별로 나눈다.
5. controller는 상태 전이와 로그만 담당한다.
6. exact IP 데이터는 base/overlay 구조로 저장하고 runtime에서는 Set으로 합친다.
7. 외부 실행 세부 로직은 executor interface 뒤로 숨긴다.
