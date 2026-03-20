# 감시 자동화 IP 차단 삭제 한도 초과 대응 플랜

## 목적

감시 자동화(`features/monitor`)가 공격 중 `IP 차단 + 게시물 삭제`를 수행할 때,
DC 응답이 아래처럼 오면 지금은 같은 대상 전체가 실패로 남는다.

- 예시:
  - `상세: 일일 삭제 횟수가 초과되어 삭제할 수 없습니다. 추가 삭제가 필요한 경우 신고 게시판에 문의해주시기 바랍니다.`

원하는 동작은 이거다.

1. 공격 중 삭제 한도 초과가 한 번이라도 확인되면
2. 그 공격 세션이 끝날 때까지는
3. `del_chk=0`으로 **IP 차단만** 계속 수행한다
4. 공격이 끝나면 세션 상태를 초기화한다
5. 다음 공격 세션에서는 다시 기본값 `del_chk=1`부터 시작한다

즉 쉽게 말하면:

- 지금: `삭제+차단 시도 -> 한도 초과 -> 계속 실패`
- 목표: `삭제+차단 시도 -> 한도 초과 확인 -> 그 공격 동안은 차단만 유지`

## 현재 구현 상태 (2026-03-21)

현재 코드는 이 문서의 1차 구현안까지 반영된 상태다.

- `features/post/api.js`
  - `delete_list` 경로에서도 삭제 한도 초과를 별도 감지한다.
  - 삭제 한도 초과는 split 재귀 대상에서 제외한다.
- `features/ip/api.js`
  - `update_avoid_list` 실패를 `delete_limit_exceeded`로 구분한다.
  - 삭제 한도 초과는 split 재귀 대상에서 제외한다.
- `features/ip/scheduler.js`
  - monitor 소유 run에서 삭제 한도 초과가 뜨면 현재 cycle 즉시 `del_chk=0`으로 재시도한다.
  - 그 뒤 runtime 상태를 ban-only로 유지한다.
- `features/monitor/scheduler.js`
  - 공격 세션 상태로 `managedIpDeleteEnabled`를 관리한다.
  - initial sweep 삭제에서 삭제 한도 초과가 뜨면 pending post를 queue에 담고 ban-only로 전환한다.
  - 이미 running 중인 ip child에도 ban-only 상태를 다시 주입한다.
- `background/background.js`
  - reset/save/load 복원 경로에서 새 runtime/session 필드를 같이 초기화한다.
- `popup/popup.js`
  - monitor 소유 ip child가 ban-only 상태면 `차단만 유지 중`으로 표시한다.

## 현재 실제 로직

### monitor가 ip child를 어떻게 켜는지

- 공격 확정:
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L266)
- ip child 시작:
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L338)

현재 monitor는 공격 상태일 때 ip scheduler를 이렇게 시작한다.

```js
await this.ipScheduler.start({
  cutoffPostNo: this.attackCutoffPostNo,
  delChk: this.managedIpDeleteEnabled,
  source: 'monitor',
});
```

즉 monitor 자동 공격은 **기본값은 `delChk=true`로 시작하지만**,
공격 세션 중 삭제 한도 초과를 감지하면 `managedIpDeleteEnabled=false`로 내려간다.

### ip scheduler가 실제로 무엇을 하는지

- 시작 시 `delChk` 저장:
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L52)
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L69)
- 대상 후보 처리:
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L217)
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L277)
- 실제 차단/삭제 API:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L97)
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L174)

현재 `banPostBatch()`는 body에:

- `del_chk = config.delChk ? '1' : '0'`

를 넣어서 `update_avoid_list`로 보낸다.

즉 지금 구조상:

- `delChk=true`면 **차단 + 삭제**
- `delChk=false`면 **차단 only**

### 지금 왜 원하는 동작이 안 되는지

현재 `banPosts()`는 실패 원인을 세분화하지 않는다.

- 성공 판정:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L289)
- 실패 메시지 요약:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L341)
- split 여부:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L305)

즉 지금 반환값은 대충 이 정도다.

- `success`
- `successNos`
- `failedNos`
- `message`

문제는:

1. 삭제 한도 초과인지
2. 권한 실패인지
3. 로그인 실패인지
4. 그냥 일시 오류인지

를 **구분해서 위로 올려주지 않는다**는 점이다.

게다가 현재 `shouldSplitBanFailure()`는 삭제 한도 초과를 모른다.

- [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L305)

그래서 지금은:

1. `del_chk=1` 배치 요청 실패
2. 삭제 한도 초과인데도
3. 배치를 계속 쪼개 본다
4. 결국 1개씩 다시 실패한다

즉 **쓸데없는 실패 요청을 더 많이 보내는 구조**가 된다.

## 구현 시 가장 중요한 연결 문제

이건 구현 전에 꼭 알아야 하는 핵심이다.

### 문제 1. ip scheduler 안에서만 `delChk=false`로 바꾸면 안 됨

monitor는 ATTACKING 동안 매 poll마다 `ensureManagedDefensesStarted()`를 돈다.

- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L296)

여기서 ip scheduler가 이미 켜져 있으면:

- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L348)
- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L356)

현재 코드가 이렇게 되어 있다.

```js
if (!this.ipScheduler.config.delChk) {
  this.ipScheduler.config.delChk = true;
  ipStateChanged = true;
}
```

즉 ip scheduler 안에서 `delChk=false`로 뒤집어도,
다음 monitor poll에서 **다시 true로 강제로 덮어쓴다.**

그래서 이 기능은 `ipScheduler` 단독 수정으로는 안 된다.

반드시 monitor 쪽에도

- `이번 공격 세션은 delete=false, ban-only mode`

상태를 같이 들고 있어야 한다.

### 문제 2. 이 상태는 공격 세션 상태여야 함

이 기능은 수동 IP 차단 전체에 퍼지면 안 된다.

원하는 건:

- 감시 자동화 공격 세션 중
- 삭제 한도 초과가 발생한 경우에만
- 남은 공격 시간 동안 ban-only

이기 때문이다.

즉 이 상태는 persisted config가 아니라 **세션 상태**가 맞다.

예시:

- 좋은 방식:
  - `monitor.managedIpBanOnly = true/false`
- 나쁜 방식:
  - `ipScheduler.config.delChk = false`를 저장값처럼 영구 변경

영구 변경으로 가면 다음 수동 실행에도 남을 수 있다.

### 문제 3. `delete_limit_exceeded`를 split 대상으로 두면 안 됨

현재 `features/ip/api.js`는 실패 시 `shouldSplitBanFailure()`를 보고
배치를 계속 반으로 쪼갠다.

- split 판정:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L305)
- 재귀 fallback:
  - [features/ip/api.js](/home/eorb915/projects/dc_defense_suite/features/ip/api.js#L144)

즉 지금은 삭제 한도 초과를 모르면:

1. `del_chk=1` 배치 실패
2. 반으로 쪼개서 다시 실패
3. 또 쪼개서 1개씩 실패

가 된다.

이건 완전히 불필요한 실패 요청이다.

그래서 구현 시에는 반드시:

- `delete_limit_exceeded`를 별도 `failureType`으로 분류하고
- `shouldSplitBanFailure()`에서는 split하지 않게 막아야 한다

### 문제 4. initial sweep 삭제도 먼저 같은 한도 문제를 만날 수 있음

감시 자동화는 ip child를 켜기 전에,
먼저 initial sweep에서 게시물 삭제를 한 번 수행한다.

- initial sweep 삭제 호출:
  - [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L398)
- 실제 delete_list API:
  - [features/post/api.js](/home/eorb915/projects/dc_defense_suite/features/post/api.js#L315)

즉 공격 시작 직후 첫 번째 삭제는 `features/ip/api.js`가 아니라
`features/post/api.js` 경로를 탄다.

그래서 삭제 한도 초과가 이미 걸린 상태면:

1. initial sweep `delete_list`가 먼저 실패
2. 그 다음 ip child가 `del_chk=1`로 또 실패

가 될 수 있다.

즉 구현을 깔끔하게 하려면:

- initial sweep 삭제 실패 메시지에서도 삭제 한도 문구를 탐지하고
- 그 즉시 `managedIpDeleteEnabled=false`로 내려주는 게 좋다

이건 필수는 아니지만, 안 넣으면 첫 공격 cycle에서 쓸데없는 실패가 한 번 더 남는다.

### 문제 5. monitor가 다음 poll에 알기 전까지 현재 ip cycle은 계속 `del_chk=1`일 수 있음

현재 monitor는 20초마다 한 번씩 `ensureManagedDefensesStarted()`를 돈다.

- [features/monitor/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/monitor/scheduler.js#L160)

반면 ip scheduler는 자기 run loop 안에서 여러 페이지/후보를 계속 처리한다.

- [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L217)

즉 구현을 monitor가 “다음 attacking poll에서 상태를 보고 `managedIpDeleteEnabled=false`로 바꾼다” 방식으로만 하면:

1. 이번 cycle 초반에 삭제 한도 초과 발생
2. 하지만 monitor는 아직 모름
3. 그 사이 ip scheduler는 같은 cycle의 남은 후보에도 계속 `del_chk=1`을 보낼 수 있음

그래서 실제로는 아래 둘 다 필요하다.

1. ip scheduler가 **즉시** 현재 run의 runtime delete mode를 끄기
2. monitor가 다음 poll에서 그 상태를 받아서 세션 상태로 굳히기

즉 “현재 cycle 즉시 전환”과 “세션 상태 유지”를 둘 다 챙겨야 한다.

### 문제 6. 임시 ban-only 상태를 ip `config`의 영구 설정처럼 쓰면 안 됨

현재 ip scheduler는 `config`를 저장/복원한다.

- 저장:
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L476)
- 복원:
  - [features/ip/scheduler.js](/home/eorb915/projects/dc_defense_suite/features/ip/scheduler.js#L497)

즉 `config.delChk=false`를 임시 ban-only 상태의 유일한 source of truth로 써버리면,
상태가 꼬였을 때 다음 standalone resume에 새어 나갈 수 있다.

안전한 방향은:

- monitor 세션 상태:
  - `managedIpDeleteEnabled`
- ip runtime 상태:
  - `runtimeDeleteEnabled`

처럼 **임시 상태를 별도 필드로 관리**하고,
실제 API 호출 직전에만

- `banPosts({ ...config, delChk: runtimeDeleteEnabled }, postNos)`

처럼 주입하는 방식이다.

즉 `config.delChk`는 저장용 기본값에 가깝게 두고,
세션 중 일시 전환은 runtime field가 소유하는 편이 안전하다.

## 권장 구현 방향

### 1. monitor 세션 상태 추가

`features/monitor/scheduler.js`에 아래 상태 추가:

- `managedIpDeleteEnabled` 또는 `managedIpBanOnly`

권장 이름:

- `managedIpDeleteEnabled`
  - `true`: 삭제+차단
  - `false`: 차단 only

초기값:

- 공격 시작 전: `true`
- 공격 종료 후 초기화: 기본값으로 복귀

필요 위치:

- constructor
- `start()`
- `clearAttackSession()`
- `saveState()`
- `loadState()`
- `getStatus()`
- `resetMonitorSchedulerState()`
- `resetSchedulerStats(feature === 'monitor')`

### 2. monitor가 ip child를 켤 때 `delChk`를 세션 상태로 주입

현재:

```js
delChk: true
```

변경 후:

```js
delChk: this.managedIpDeleteEnabled
```

그리고 이미 ip child가 켜져 있는 경우에도

```js
if (Boolean(this.ipScheduler.config.delChk) !== Boolean(this.managedIpDeleteEnabled)) {
  this.ipScheduler.config.delChk = this.managedIpDeleteEnabled;
  ipStateChanged = true;
}
```

처럼 monitor 세션 상태를 기준으로 동기화해야 한다.

즉 현재의:

```js
if (!this.ipScheduler.config.delChk) {
  this.ipScheduler.config.delChk = true;
}
```

강제 true 코드는 없어져야 한다.

### 3. ip/api가 삭제 한도 초과를 명시적으로 분류하도록 변경

`features/ip/api.js`에서 `banPostBatch()` 또는 그 아래 helper가
다음 추가 정보를 돌려줘야 한다.

- `failureType`
  - `delete_limit_exceeded`
  - `manager_permission_denied`
  - `session_access_denied`
  - `unknown`
- `rawText`
- `message`

최소한 지금 필요한 건:

- 삭제 한도 초과 문구 탐지

예시 패턴:

- `일일 삭제 횟수가 초과되어 삭제할 수 없습니다`
- `추가 삭제가 필요한 경우 신고 게시판에 문의`

### 4. 삭제 한도 초과일 때 monitor 세션을 ban-only로 전환

위치는 `features/ip/scheduler.js#processBanCandidates()` 또는 그 바로 아래 helper가 적당하다.

지금은 `banPosts()` 결과를 받아서:

- 성공 수
- 실패 수
- 로그

만 처리한다.

여기서 필요한 변경:

1. 실패 결과 중 `delete_limit_exceeded` 감지
2. 현재 실행이 `source === 'monitor'`이고 `config.delChk === true`일 때만
3. monitor에 “이제 ban-only” 신호 전달
4. 다음 cycle부터는 `delChk=0`

권장 방식은 ip scheduler가 직접 monitor를 알지 않게 하는 것이다.

즉 더 자연스러운 구조는:

- `banPosts()`가 `deleteLimitExceeded` 같은 플래그를 돌려주고
- `monitor.ensureManagedDefensesStarted()`가 아니라
- `monitor`가 ip 결과를 직접 알 수 있게 하거나
- `ipScheduler`에 `setDeleteEnabledForManagedRun(false)` 같은 좁은 런타임 setter를 추가

실무적으로는 다음 둘 중 하나다.

#### A. monitor -> ip 단방향 유지형

- ip scheduler에
  - `source`
  - `managedDeleteEnabled`
  - `lastDeleteLimitExceededAt`
  같은 runtime field 추가
- `processBanCandidates()`가 delete limit 감지 시
  - 자기 내부 `managedDeleteEnabled=false`
  - saveState
- monitor는 다음 poll에서
  - `ipScheduler.config.delChk = this.managedIpDeleteEnabled`
  대신
  - `ipScheduler.getManagedDeleteEnabled()`를 보고 따라감

단점:
- monitor/ip 책임이 조금 섞인다

#### B. monitor 소유형

- ip scheduler가 `delete_limit_exceeded`를 status/log/state로 남김
- monitor가 다음 attacking poll에서 그 상태를 읽고
  - `managedIpDeleteEnabled=false`
로 전환

장점:
- 세션 소유권이 monitor에 남음

1차 구현은 **B를 기본으로 하되, ip scheduler의 즉시 runtime 전환을 같이 넣는 혼합형**이 더 안전하다.

### 5. ATTACKING 복원 경로까지 같이 묶어야 함

background는 service worker 재시작 후 저장된 상태를 다시 붙인다.

- monitor ATTACKING 복원:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L105)
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L131)
- dormant child 정지:
  - [background/background.js](/home/eorb915/projects/dc_defense_suite/background/background.js#L565)

즉 `managedIpDeleteEnabled` 같은 세션 필드를

- `monitor.saveState()`
- `monitor.loadState()`
- `monitor.getStatus()`

에 안 넣으면,
service worker가 중간에 재시작됐을 때 다시 `del_chk=true` broad 모드로 돌아갈 수 있다.

이건 구현 전에 반드시 막아야 하는 연결 문제다.

## 추천 1차 스펙

복잡도를 줄이려면 1차는 이렇게 가는 게 좋다.

1. 공격 세션 시작 시:
   - `managedIpDeleteEnabled = true`
2. ip 차단 중 삭제 한도 초과 감지 시:
   - `managedIpDeleteEnabled = false`
   - 로그:
     - `⚠️ 삭제 한도 초과 감지 - 이번 공격 세션 동안 IP 차단만 유지`
3. ATTACKING 동안:
   - monitor는 `delChk = managedIpDeleteEnabled`로 ip child를 계속 동기화
   - ip scheduler는 현재 run에서도 즉시 `runtimeDeleteEnabled=false`로 전환
4. 공격 종료 시:
   - 자동 post/ip 대응 정지
   - `managedIpDeleteEnabled = true`로 초기화
5. 다음 공격 세션:
   - 다시 삭제+차단부터 시작

즉 이건:

- `한도 걸리면 공격 끝날 때까지 0으로 유지`

를 그대로 구현한 스펙이다.

### 권장 보강

가능하면 아래 보강도 같이 넣는 걸 권장한다.

1. initial sweep `deletePosts()` 실패 메시지에서도 삭제 한도 초과를 탐지
2. 그 즉시 `managedIpDeleteEnabled=false`
3. 이후 ip child는 첫 시작부터 `del_chk=0`

이렇게 하면 공격 시작 직후 같은 한도 실패를 한 번 덜 맞는다.

## 왜 이 방식이 좋은가

쉬운 설명:

- 지금은 삭제가 막혀도 계속 “삭제도 해볼까?”를 반복해서 서버를 더 때림
- 바꾸면 한 번 막힌 뒤에는 “오늘 이 공격 동안은 삭제 포기, 차단만 하자”로 단순화됨

장점:

- 실패 요청 수 감소
- 불필요한 split 재귀 감소
- 공격 중 차단은 계속 유지
- monitor 세션이라는 기존 구조와 잘 맞음

## 주의점

### 1. 공격 중간에 삭제 가능 상태로 돌아와도, 이번 공격 동안은 삭제 안 함

이건 의도된 tradeoff다.

장점:
- 구현 단순
- 실패 요청 감소

단점:
- 공격 중간에 삭제가 다시 가능해져도 놓침

만약 이게 아쉬우면 2차에서:

- `ban-only 전환 후 N분마다 1회만 delChk=1 재시험`

을 붙일 수 있다.

하지만 1차는 세션 끝까지 ban-only가 더 단순하고 안전하다.

### 2. 수동 IP 차단에는 영향 주면 안 됨

반드시 monitor source에만 한정해야 한다.

즉:

- `source === 'monitor'`
- `managedIpStarted === true`

같은 조건으로만 동작해야 한다.

### 3. popup/status 표시를 안 넣으면 운영자가 헷갈릴 수 있음

현재 ip UI는:

- `🟢 차단 중`
- `🟠 해제 중`
- `🔴 정지`

만 보여준다.

- [popup/popup.js](/home/eorb915/projects/dc_defense_suite/popup/popup.js#L908)

즉 구현 후에도 표시를 안 바꾸면,

- 지금 공격 세션이 `삭제+차단`인지
- `차단만 유지`인지

운영자가 상태를 바로 알 수 없다.

1차는 로그만으로도 운영 가능하지만,
가능하면 아래 둘 중 하나는 같이 넣는 게 좋다.

1. monitor 로그:
   - `⚠️ 삭제 한도 초과 감지 - 이번 공격 세션은 차단만 유지`
2. status 노출:
   - `삭제+차단 중`
   - `차단만 유지 중`

## 구현 체크리스트

- [ ] `features/ip/api.js`
  - 삭제 한도 초과 failureType 분류 추가
- [ ] `features/ip/api.js`
  - delete-limit failure는 split 대상에서 제외
- [ ] `features/post/api.js`
  - initial sweep delete 실패 메시지에서도 삭제 한도 초과 탐지 가능하게 준비
- [ ] `features/monitor/scheduler.js`
  - `managedIpDeleteEnabled` 세션 상태 추가
- [ ] `features/monitor/scheduler.js`
  - ip child start/update 시 `delChk`를 세션 상태로 주입
- [ ] `features/monitor/scheduler.js`
  - 공격 종료 시 세션 상태 초기화
- [ ] `features/monitor/scheduler.js`
  - initial sweep 삭제 실패에서도 delete-limit면 ban-only 전환
- [ ] `features/ip/scheduler.js`
  - delete-limit 감지 결과를 monitor가 읽을 수 있게 status/state/log로 노출
- [ ] `features/ip/scheduler.js`
  - 현재 run에서 즉시 `runtimeDeleteEnabled=false` 전환
- [ ] `background/background.js`
  - monitor/ip reset 경로에서 관련 runtime 상태 초기화
- [ ] `background/background.js`
  - ATTACKING 복원 시 세션 상태가 다시 주입되도록 save/load/getStatus 연결
- [ ] popup/status
  - 필요하면 `삭제+차단` / `차단만` 상태를 로그로 보이게 함

## 최종 판단

이 기능은 **가능하고, 특궁 구조와도 잘 맞는다.**

다만 그냥 `del_chk=0`만 한 줄로 바꾸면 안 된다.
실제로는 아래 2개를 같이 해야 한다.

1. 삭제 한도 초과를 명시적으로 분류
2. monitor가 ATTACKING 세션 동안 `delChk` 모드를 소유

즉 문서화 후 구현하는 게 맞는 작업이다.
