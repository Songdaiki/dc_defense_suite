# 신문고 Gemini Worker 내부 설계

## 목표
- 신고 1건마다 외부 `gemini` 프로세스를 새로 `spawn()`하는 비용을 줄인다.
- sparse traffic에서도 Gemini 실행기를 계속 유지한다.
- moderation 세션 문맥을 여러 신고에 걸쳐 누적한다.
- 누적 문맥은 일정 횟수마다 강제 압축해 계속 유지한다.
- helper의 `/judge` 요청은 순서를 보장하는 queue로 처리한다.

## 핵심 결정

### 1. shared process, shared moderation session
- 유지하는 것은 Gemini 실행용 worker thread와 `Config/GeminiClient` 인스턴스다.
- moderation 요청은 같은 `sessionId`와 같은 chat history를 계속 재사용한다.
- 따라서 이전 신고의 판정 문맥이 다음 신고 판단에 참고 문맥으로 남는다.
- 이 동작은 의도된 정책이다.

### 2. queue concurrency = 1
- `/judge` 요청은 helper 내부 queue에 직렬로 넣는다.
- 한 번에 하나의 요청만 worker를 사용한다.
- 같은 요청 안의 이미지 분석과 최종 판정도 같은 queue 슬롯 안에서 처리한다.
- 이렇게 해야 `withRemainingJudgeBudget()`이 다른 요청 때문에 소모되지 않는다.

### 3. external CLI spawn 대신 private CLI API 사용
- worker는 Gemini CLI 내부 모듈을 직접 import 해서 `runNonInteractive()`를 호출한다.
- 사용하는 내부 API:
  - `dist/src/config/settings.js`
  - `dist/src/config/config.js`
  - `dist/src/nonInteractiveCli.js`
- 이는 공개 API가 아니므로 CLI 버전 고정이 필수다.
- `general.enableAutoUpdate=false`가 전제다.

### 4. idle recycle 대신 장기 유지 + 주기적 강제 압축
- 기본값에서는 worker를 idle timeout으로 종료하지 않는다.
- 기본값에서는 `maxJobsPerWorker` 강제 recycle도 하지 않는다.
- 대신 moderation 메인 판정이 일정 횟수(`GEMINI_WORKER_COMPRESS_AFTER_JOBS`) 누적되면
  `config.getGeminiClient().tryCompressChat(..., true)`를 강제로 호출한다.
- image analysis prompt는 shared session에 남기되, 압축 카운트에는 포함하지 않는다.

### 5. self-test는 shared moderation session 밖으로 분리
- `/self-test-image` 같은 진단 요청은 shared moderation session에 섞이지 않게 한다.
- self-test는 기존 외부 `spawn()` 경로를 사용한다.
- 따라서 운영 판정 문맥이 self-test 프롬프트로 오염되지 않는다.

## 구성 요소

### `helper/gemini_worker.mjs`
- worker thread 엔트리
- Gemini CLI 내부 모듈 dynamic import
- runtime 최초 1회만 `loadCliConfig() -> config.initialize() -> refreshAuth()` 실행
- 이후 각 job마다 같은 `config/settings`로 `runNonInteractive()` 호출
- 성공한 moderation 메인 판정이 N회 쌓이면 `tryCompressChat(force=true)` 호출
- job 실패 시 runtime을 폐기해 orphan user turn이 다음 판정에 섞이지 않게 유지

### `helper/gemini_worker_manager.mjs`
- worker lifecycle 관리
- 요청 queue 관리
- runtime fingerprint 관리
- worker crash/timeout 처리
- 기본값은 idle 종료 없음, max jobs recycle 없음

### `helper/server.mjs`
- 기존 `/judge` 흐름 유지
- Gemini 실행 경로만 worker manager로 위임
- self-test는 `disablePersistentWorker=true`로 기존 `spawn()` 경로 강제
- worker 사용이 불가능한 경우에도 기존 external `spawn()` fallback 사용

## 실행 흐름

1. `/judge` 요청 수신
2. helper가 queue에 "이 요청 전체"를 넣음
3. queue turn을 얻으면 persistent worker 확보
4. 필요 시 이미지 분석 실행
5. 같은 queue 슬롯 안에서 최종 판정 실행
6. 최종 판정 성공 시 압축 카운터 증가
7. 카운터가 기준 이상이면 shared moderation session 강제 압축
8. 결과 반환

## 안전장치
- queue concurrency는 항상 1
- worker timeout 시 worker terminate 후 재생성
- worker runtime error 시 runtime 폐기
- private CLI API import 실패 시 기존 `spawn()` fallback
- self-test는 shared session을 사용하지 않음

## 운영 전제
- Gemini CLI 버전 고정
- Gemini CLI auto-update 비활성화
- helper 재시작 시 shared moderation session도 새로 시작

## 의도적으로 하지 않는 것
- 신고별 fresh session 분리
- queue drain 시 idle 종료
- moderation worker에 self-test 문맥 혼합
- multi-worker 병렬 판정
