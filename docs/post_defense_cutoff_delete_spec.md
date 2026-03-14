# DC Defense Suite - 게시물 방어 cutoff/delete 정책 스펙

## 1. 목적

이 문서는 `게시글 분류`, `IP 차단`, `게시물 자동화`를 현재 방식 그대로 두지 않고,
`방어 시작 시점 이후에 올라온 게시물만 대응`하도록 바꾸기 위한 델타 스펙이다.

이번 변경의 핵심 목표는 다음과 같다.

- 수동/자동 게시물 방어 모두 `시작 시점 snapshot postNo`를 저장한다.
- 저장된 `postNo`보다 큰 게시물만 이후 대응 대상으로 본다.
- 자동 게시물방어는 공격 확정 직후 현재 1~2페이지 유동글을 먼저 도배기탭으로 보내고,
  그 이후 새 글만 `도배기탭 분류 -> IP 차단 + 게시물 삭제`로 처리한다.
- 수동 IP 차단도 도배기탭의 기존 글 전체를 다시 훑지 않고,
  ON 이후 새로 들어온 도배기탭 글만 `IP 차단 + 삭제`한다.

이 문서는 기존 `monitoring_automation_v2_spec.md`를 대체하지 않는다.
기존 문서 위에 덮는 “정책 변경 스펙”으로 본다.

---

## 2. 왜 별도 스펙이 필요한가

이번 변경은 단순 옵션 추가가 아니다.

- `게시글 분류`의 처리 기준이 바뀐다.
- `IP 차단`의 처리 기준이 바뀐다.
- `게시물 자동화`의 공격 진입 플로우가 바뀐다.
- `IP 차단`에서 `삭제(del_chk)`를 실제로 켜는 파괴적 동작이 포함된다.
- service worker 재시작 후에도 cutoff 기준을 유지해야 한다.

즉, 구현 파일은 적어도 아래 3군데가 같이 바뀐다.

- `features/post/*`
- `features/ip/*`
- `features/monitor/*`

이 정도면 “바로 구현”보다 먼저 cutoff 의미와 자동/수동 경계를 고정하는 짧은 스펙이 필요하다.

결론:

- 대형 신규 설계 문서까지는 불필요
- 하지만 이번 문서 같은 짧은 델타 스펙 1개는 필요

---

## 3. 현재 구현 기준 문제점

### 3.1 게시글 분류

현재 `postScheduler`는 설정된 페이지 범위 안의 유동글을 매 사이클 모두 분류한다.

즉:

- 시작 전에 이미 있던 글도 다시 대상이 된다.
- “방어 시작 이후 새 글만 대응”이 아니다.

### 3.2 IP 차단

현재 `ipScheduler`는 도배기탭의 유동글을 매 사이클 모두 차단 후보로 본다.

즉:

- ON 전부터 도배기탭에 있던 글도 다시 대상이 된다.
- cutoff 기준이 없다.

### 3.3 게시물 자동화

현재 `monitorScheduler`는 공격 감지 시 기존 scheduler를 그냥 ON만 한다.

즉:

- 자동 공격 감지 시점의 경계 postNo가 없다.
- “현재 감지된 공격 이전 글은 분류만, 이후 새 글은 차단+삭제” 같은 2단계 처리 불가

### 3.4 삭제 동작

현재 IP 차단 API는 `update_avoid_list` 요청 body에 `del_chk`를 넣는다.

실제 payload 기준 의미는 아래와 같다.

- `del_chk=1`
  - 게시물 차단과 함께 대상 게시물 삭제를 요청
- `del_chk=0`
  - 게시물 차단만 요청

현재 suite 코드는 내부 config에서는 boolean인 `config.delChk`를 쓰고,
실제 전송 시점에만 `true -> '1'`, `false -> '0'`으로 직렬화한다.

즉 아래 두 표현은 같은 뜻이다.

- 내부 config 표현: `delChk = true`
- 실제 payload 표현: `del_chk=1`

하지만 아직 고정되지 않은 점이 있다.

- `del_chk=1`이 실제로 게시물 삭제까지 확실히 수행하는지 운영 갤 기준 검증 안 됨
- 현재 suite는 게시물 삭제 검증 로직이 없음
- 즉 “호출은 가능”과 “실제로 안정 동작”은 다르다

### 3.5 댓글 삭제와의 구분

댓글 삭제는 `del_chk`와 무관하다.

- 댓글 삭제
  - 별도 API: `/ajax/minor_manager_board_ajax/delete_comment`
  - payload: `ci_t`, `id`, `_GALLTYPE_`, `pno`, `cmt_nos[]`
  - `del_chk` 없음

- 게시물 차단/삭제
  - API: `/ajax/minor_manager_board_ajax/update_avoid_list`
  - payload에 `del_chk=1/0` 포함

즉 이번 문서에서 다루는 `del_chk`는 게시물 차단 요청에 붙는 삭제 옵션이고,
댓글 삭제 경로를 뜻하지 않는다.

---

## 4. 용어 정의

### 4.1 cutoffPostNo

방어 시작 시점에 저장한 기준 게시물 번호.

- 이후 대응 대상은 `post.no > cutoffPostNo`
- `post.no <= cutoffPostNo` 는 기존 글로 보고 무시

### 4.2 initial sweep

자동 게시물방어에서만 쓰는 1회성 사전 분류 단계.

- 공격 확정 직후
- 현재 감시 범위(기본 1~2페이지)에 있는 유동글을
- 우선 도배기탭으로 1회 분류한다
- 이어서 같은 대상 게시물을 1회 삭제한다
- 이 단계에서는 운영 차단은 하지 않는다

### 4.3 defense window

`cutoffPostNo` 이후에 올라온 새 글의 집합.

실제 강한 대응(`IP 차단 + 삭제`)은 이 defense window에만 적용한다.

---

## 5. 목표 동작

## 5.1 자동 게시물방어

자동 게시물방어에서 공격이 확정되면 아래 순서로 간다.

1. 공격 확정 poll의 일반탭 snapshot을 확보한다.
2. 그 snapshot의 최대 `postNo`를 `attackCutoffPostNo`로 저장한다.
3. 같은 snapshot 안의 유동글을 1회성으로 도배기탭 분류한다.
4. 같은 snapshot 안의 유동글을 1회성으로 삭제한다.
5. 이후 `postScheduler`는 `post.no > attackCutoffPostNo` 인 글만 분류한다.
6. 이후 `ipScheduler`는 도배기탭에서 `post.no > attackCutoffPostNo` 인 글만 차단한다.
7. 이때 `ipScheduler`는 실제 요청 payload에 `del_chk=1`을 넣어 차단+삭제를 같이 수행한다.
8. 공격 종료 시 기존처럼 monitor가 자기 runId 차단만 자동 해제한다.

정리:

- 공격 확정 이전에 이미 있던 글: 자동 분류 + 1회 삭제
- 공격 확정 이후 새 글: 자동 분류 + 자동 차단 + `del_chk=1` 삭제 요청

### 자동 게시물방어의 이유

사용자 의도는 다음 두 단계를 분리하는 것이다.

- 현재 공격면에 이미 깔린 글 정리: 빠른 도배기탭 이동
- 현재 공격면에 이미 깔린 글 1회 삭제
- 공격 진입 후 새로 쏟아지는 글 대응: 차단 + `del_chk=1` 삭제 요청

즉 자동 모드는 단순 `post/ip ON`이 아니라,
`initial sweep -> cutoff 이후 새 글 대응` 구조여야 한다.

## 5.2 수동 게시글 분류

수동 `게시글 분류` ON 순간 일반탭 기준 snapshot을 잡는다.

규칙:

1. ON 시점 일반탭 범위에서 최대 `postNo`를 `manualPostCutoffPostNo`로 저장
2. 이후 `post.no > manualPostCutoffPostNo` 인 글만 분류
3. 기존 글은 건드리지 않음

즉 수동 게시글 분류도 “지금부터 들어오는 새 글만 분류” 모드가 된다.

## 5.3 수동 IP 차단

수동 `IP 차단` ON 순간 도배기탭 기준 snapshot을 잡는다.

규칙:

1. ON 시점 도배기탭 범위에서 최대 `postNo`를 `manualIpCutoffPostNo`로 저장
2. 이후 도배기탭에서 `post.no > manualIpCutoffPostNo` 인 글만 차단
3. 수동 IP 차단은 이번 정책에서 실제 요청 payload에 `del_chk=1`을 같이 넣어 차단+삭제 수행

즉 수동 IP 차단도 “지금부터 새로 들어온 도배기 글만 `del_chk=1`로 차단+삭제” 모드가 된다.

---

## 6. 명시적으로 제외할 것

이번 변경 범위에서 아래는 제외한다.

- 댓글 방어 / 댓글 자동화
- 반고닉 분류
- 도배기탭 외 다른 머릿말 대응
- 게시물 삭제 성공 여부를 재조회로 검증하는 별도 엔진

즉 이번 단계는 게시물 방어 계열(`post`, `ip`, `monitor`)만 바꾼다.

---

## 7. 구현 설계

## 7.1 postScheduler 변경

필요 변경:

- cutoff 기준 저장 필드 추가
- cutoff 이하 글 스킵 로직 추가
- 자동모드용 1회성 분류 helper 추가

권장 필드:

```js
config: {
  ...,
  cutoffPostNo: 0,
}
```

또는 runtime field로 둬도 되지만, service worker 재시작 복원을 생각하면 저장 상태에 같이 넣는 편이 안전하다.

권장 동작:

- `start(options = {})`
  - `cutoffPostNo`
  - `source = 'manual' | 'monitor'`
- run loop에서 `post.no <= cutoffPostNo` 이면 건너뜀

추가 helper:

```js
classifyPostsOnce(postNos)
```

이 helper는 monitor가 자동 공격 확정 직후 `initial sweep` 용도로 사용한다.
이 단계는 연속 scheduler run과 분리해야 한다.

이 helper가 필요한 이유:

- 단순히 scheduler를 바로 켜면 기존 글 전체를 다시 분류할 수 있음
- `initial sweep`과 `cutoff 이후 새 글 대응`은 같은 동작이 아님

## 7.2 ipScheduler 변경

필요 변경:

- cutoff 기준 저장 필드 추가
- cutoff 이하 글 스킵
- 내부 config `delChk`를 실행 시점에 켜고, 실제 요청에서는 `del_chk=1`이 나가게 하는 동작 추가

권장 필드:

```js
config: {
  ...,
  cutoffPostNo: 0,
  delChk: true/false,
}
```

주의:

- 위 `delChk`는 내부 config 이름이다.
- 실제 네트워크 요청에서는 `del_chk=1/0`으로 전송된다.
- 문서상 동작 판정은 payload 의미인 `del_chk=1/0` 기준으로 본다.

권장 동작:

- `start(options = {})`
  - `cutoffPostNo`
  - `delChk`
  - `source = 'manual' | 'monitor'`
- run loop에서 `post.no <= cutoffPostNo` 이면 스킵

이번 정책에서는 아래처럼 쓴다.

- 수동 IP 차단: 내부 config `delChk = true`, 실제 payload `del_chk=1`
- 자동 게시물방어: 내부 config `delChk = true`, 실제 payload `del_chk=1`

반대로 내부 config `delChk = false`이면 실제 payload는 `del_chk=0`이고, 차단만 수행한다.

즉 이번 범위 안에서는 `IP 차단 = 차단 + 삭제`로 보되,
실제 네트워크 의미는 항상 `del_chk=1`이다.

## 7.3 monitorScheduler 변경

필요 변경:

- 공격 확정 시점 cutoff 저장
- initial sweep 수행
- managed post/ip start에 cutoff 전달

권장 runtime state:

```js
{
  ...,
  attackCutoffPostNo: 0,
  initialSweepCompleted: false,
}
```

권장 플로우:

1. `enterAttackMode(currentSnapshot)` 호출
2. `attackCutoffPostNo = max(currentSnapshot.postNo)`
3. `initialSweepPosts = currentSnapshot.filter(post => post.isFluid)`
4. `postScheduler.classifyPostsOnce(initialSweepPosts)`
5. `postScheduler.start({ cutoffPostNo: attackCutoffPostNo, source: 'monitor' })`
6. `ipScheduler.start({ cutoffPostNo: attackCutoffPostNo, delChk: true, source: 'monitor' })`
   - 실제 요청 payload에서는 `del_chk=1`

주의:

- initial sweep는 현재 monitor snapshot을 재사용하는 편이 낫다
- attack 진입 직후 다시 목록을 한 번 더 읽으면 race가 생길 수 있다

## 7.4 snapshot max postNo helper

`parseBoardPosts()`나 `parseTargetPosts()` 결과에서 최대 `postNo`를 구하는 helper가 필요하다.

예:

```js
function getMaxPostNo(posts) {
  return posts.reduce((max, post) => Math.max(max, Number(post.no) || 0), 0);
}
```

일반탭과 도배기탭 모두 동일한 기준을 쓴다.

---

## 8. 상태 저장 / 복원 정책

cutoff 방식은 재시작 복원 정책이 중요하다.

반드시 저장해야 하는 값:

- `postScheduler.config.cutoffPostNo`
- `ipScheduler.config.cutoffPostNo`
- `ipScheduler.config.delChk`
- `monitorScheduler.attackCutoffPostNo`
- `monitorScheduler.initialSweepCompleted`

이 값이 없으면 service worker 재시작 후 예전 글까지 다시 차단할 수 있다.

---

## 9. UI 정책

이번 단계에서 UI는 크게 늘리지 않아도 된다.

최소 요구사항:

- 로그에 snapshot cutoff postNo를 남긴다
- 자동 공격 진입 로그에 `attackCutoffPostNo`를 남긴다
- 수동 post/ip ON 시 cutoff postNo를 로그에 남긴다

선택 사항:

- 상태창에 `기준 postNo` 노출

이번 단계에서는 로그만으로도 충분하다.

---

## 10. 구현 전에 반드시 확인할 점

## 10.1 `del_chk=1` 실제 동작 확인

현재 코드상 게시물 차단 요청 body에는 `del_chk`가 이미 있다.

하지만 구현 전 또는 구현 직후 실제 운영 대상에서 확인해야 한다.

확인 항목:

- `del_chk=1` 이 실제로 게시물 삭제까지 수행하는가
- 응답 성공이지만 삭제는 실패하는 케이스가 있는가
- 차단은 성공, 삭제만 실패하는 반쪽 성공이 가능한가

만약 반쪽 성공이 존재하면, 추후 별도 검증/로그 정책이 필요하다.

## 10.2 initial sweep 범위

현재 사용자 의도는 “현재 1~2페이지 유동글”이다.

즉 자동모드 initial sweep 범위는:

- monitor의 `currentSnapshot`
- 또는 `monitorPages`

로 고정하는 것이 맞다.

여기서 post 수동 설정의 `maxPage`를 initial sweep에 그대로 쓰면 의미가 달라질 수 있으므로,
자동 initial sweep는 monitor snapshot 기준으로 고정하는 편이 안전하다.

## 10.3 수동 post / 수동 ip를 따로 켰을 때 순서

정책상 허용은 되지만 의미는 다르다.

- post 먼저 ON: 이후 새 일반글이 분류됨
- ip 먼저 ON: 이후 새 도배기탭 글만 차단+삭제됨

즉 운영 가이드는 `post 먼저, ip 나중`이 자연스럽다.

이번 단계에서는 이 순서를 강제하지는 않는다.

---

## 11. 테스트 체크리스트

- 수동 게시글 분류 ON 직후 기존 일반글은 분류되지 않는가
- 수동 게시글 분류 ON 이후 새 일반글만 분류되는가
- 수동 IP 차단 ON 직후 기존 도배기탭 글은 차단되지 않는가
- 수동 IP 차단 ON 이후 새 도배기탭 글만 차단되는가
- 수동 IP 차단 시 실제 요청 payload에 `del_chk=1`이 함께 전송되는가
- 수동 IP 차단에서 `del_chk=0`일 때는 차단만 되고 삭제는 일어나지 않는가
- 자동 공격 감지 직후 현재 monitor snapshot 유동글이 먼저 도배기탭으로 가는가
- 자동 공격 감지 이후 새 글만 `del_chk=1`로 차단+삭제되는가
- 자동 종료 시 기존처럼 managed runId만 해제되는가
- service worker 재시작 후 cutoff 기준이 유지되는가

---

## 12. 최종 판단

이번 변경은 “스펙이 하나도 필요 없는” 수준은 아니다.

이유:

- 자동/수동 의미가 모두 바뀜
- destructive action(`삭제`)이 들어감
- cutoff 기준 저장/복원이 필요함
- initial sweep와 cutoff 이후 대응이 분리되어야 함

다만 대규모 재설계 문서까지는 필요 없고,
현재 문서 1개면 구현 착수에 충분하다.

즉 최종 결론은 다음과 같다.

- 별도 스펙 문서: 필요
- 문서 개수: 1개면 충분
- 구현 전 추가로 꼭 필요한 것: `del_chk` 실제 동작 확인
