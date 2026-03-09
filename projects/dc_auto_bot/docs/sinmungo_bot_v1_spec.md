# DC Auto Bot - 신문고 봇 v1 구현 스펙

## 1. 목표

이 문서는 `신문고 게시물`의 댓글 명령을 읽어, 신뢰된 사용자의 요청만 자동 처리하는 `신문고 봇 v1` 구현 스펙이다.

v1의 목표:

- 특정 `신문고 게시물`의 댓글을 1분 주기로 폴링한다.
- 확장 프로그램에 등록된 `신뢰 사용자(user_id)`가 남긴 명령 댓글만 처리한다.
- 댓글에서 대상 게시물 링크와 명령 형식을 파싱한다.
- 대상 게시물을 `삭제 + 6시간 차단` 처리한다.
- 신뢰 사용자 1명당 하루 `2회`까지만 사용 가능하게 제한한다.
- 같은 대상 링크는 중복 처리하지 않는다.
- 처리 결과를 로컬 로그와 상태에 남긴다.

v1은 자동 감시가 아니라, 특정 신문고 게시물에 달린 명령 댓글을 수동 토글 기반으로 감시하는 운영 보조 봇이다.

## 2. 현재 확보된 스펙

### 2.1 일반 게시물 댓글 읽기 스펙은 이미 있음

`신문고 게시물`은 별도 구조가 아니라 그냥 일반 게시물이다.

현재 댓글 읽기 구현:

- 게시물 HTML 로드: `dc_defense_suite/features/comment/api.js`
  - `fetchPostPage(config, postNo)`
- `e_s_n_o` 추출:
  - `extractEsno(html)`
- 댓글 조회:
  - `fetchComments(config, postNo, esno, commentPage = 1)`
  - `POST /board/comment/`
- 최근 댓글 페이지 조회:
  - `fetchComments(config, postNo, esno, commentPage = 1)`
  - `commentPage=1,2`를 읽어서 최근 1~2페이지 댓글만 감시

즉 신문고 봇은 기존 댓글 API를 재사용하되, 전체 댓글이 아니라 최근 1~2페이지 댓글만 폴링한다.

### 2.2 댓글 응답에 신뢰 사용자 식별값이 직접 들어옴

`projects/dc_auto_bot/docs/respone.md`에 저장한 실제 `/board/comment/` 응답 샘플 기준으로, 댓글 객체에 아래 필드가 직접 존재한다.

- `no`
- `user_id`
- `name`
- `ip`
- `nicktype`
- `memo`
- `depth`
- `c_no`
- `del_yn`
- `is_delete`

실샘플 예시:

- `user_id: "exercens02"`, `name: "EXERCENS"`, `ip: ""`
- `user_id: "kwo1256"`, `name: "서벌멍멍이"`, `ip: ""`
- `user_id: "mode0729"`, `name: "꿀바나나"`, `ip: ""`

즉 신문고 봇 v1의 신뢰 사용자 화이트리스트는 `user_id` 기준으로 바로 구현 가능하다.

v1 기준:

- 내부 식별 키: `user_id`
- 표시용 라벨: `label`
- `name`은 참고용 raw 데이터
- `ip`는 fallback 식별 키로 쓰지 않는다.

### 2.3 삭제 + 차단 통합 액션 경로가 확인됨

관리 화면 실캡처 기준으로 아래 요청이 확인되었다.

- `POST /ajax/minor_manager_board_ajax/update_avoid_list`

확인된 payload 예시:

```txt
ci_t=...
id=thesingularity
nos[]=1044265
parent=
avoid_hour=1
avoid_reason=0
avoid_reason_txt=
del_chk=1
_GALLTYPE_=M
avoid_type_chk=1
```

즉 `update_avoid_list` 하나로 아래 조합이 가능한 경로가 실제로 존재한다.

- 게시물 삭제
- 운영 차단

따라서 신문고 봇 v1은 게시물 삭제 단독 API를 별도로 쓰지 않고, `update_avoid_list + del_chk=1` 경로를 기본으로 사용한다.

### 2.4 삭제 단독 API도 별도로 존재함

추가로 아래 게시물 삭제 단독 API도 확인되었다.

- `POST /ajax/minor_manager_board_ajax/delete_list`

payload 예시:

```txt
ci_t=...
id=thesingularity
nos[]=1044313
_GALLTYPE_=M
```

다만 v1은 `삭제 + 6시간 차단`을 한 번에 처리하는 것이 목표이므로, 기본 구현은 `update_avoid_list(del_chk=1)`를 사용한다. `delete_list`는 fallback 참고 스펙으로만 둔다.


## 2.5 v2 Core 확장: 삭제 전 작성자 필터

운영 회의 기준으로 v2의 1차 확장은 **신문고 명령을 바로 삭제로 보내지 않고, 대상 게시물 작성자를 먼저 판별**하는 것이다.

v2 core 삭제 전 필터 정책:

1. 대상 게시물 작성자가 `유동`이면 삭제 + 6시간 차단 허용
2. 대상 게시물 작성자가 `식별코드/고정닉 계열`이면 작성자 누적 `글 + 댓글 총합`을 조회
3. 누적 총합 `< 100`이면 `깡계`로 간주하고 삭제 + 6시간 차단 허용
4. 누적 총합이 `>= 100`이어도 `글 / (글 + 댓글) >= 0.9`이면 `글편중`으로 간주하고 삭제 + 6시간 차단 허용
5. 위 두 조건을 모두 만족하지 않으면 자동 처리하지 않고 로그만 남김

### 2.5.1 v2 core 구현 경로

현재 레퍼런스 기준으로 재사용 가능한 경로는 다음과 같다.

- 대상 게시물 HTML 조회
  - 이미 `fetchPostPage(config, postNo)` 스펙이 있음
- 식별코드 작성자 누적 `글/댓글 수` 조회
  - `POST /api/gallog_user_layer/gallog_content_reple/`
  - 기존 `semi_post_classifier_v1_spec.md`에서 확인됨

즉 v2 core 흐름은 다음과 같다.

1. 신문고 댓글 명령에서 `targetPostNo` 추출
2. 대상 게시물 HTML 조회
3. 게시물 작성자 메타를 파싱
   - 최소 필요값: `data-uid`, `data-ip`, `data-nick`
4. 판정
   - `data-ip`가 있고 `data-uid`가 비면 `유동`으로 간주
   - `data-uid`가 있으면 `gallog_content_reple(user_id=data-uid)` 호출
5. `postCount + commentCount < 100`이면 `깡계`로 간주
6. `postCount / (postCount + commentCount) >= 0.9`이면 `글편중`으로 간주
7. `유동 또는 깡계 또는 글편중`일 때만 기존 `update_avoid_list(del_chk=1, avoid_hour=6)` 실행
8. 아니면 자동 처리하지 않고 `자동 차단 조건 미충족` 로그만 남김

### 2.5.2 v2 core에서 실제로 확인된 view HTML 작성자 메타

`projects/dc_auto_bot/docs/post_html.md`에 저장한 실제 게시물 view HTML 기준으로, 본문 작성자 블록에 아래 메타가 직접 존재한다.

확인된 예시:

```html
<div class="gall_writer ub-writer" data-nick="ㅇㅇ" data-uid="bracelet0963" data-ip="" data-loc="view">
```

즉 본문 view HTML에서도 다음 값을 직접 파싱할 수 있다.

- `data-nick`
- `data-uid`
- `data-ip`
- `data-loc="view"`

추가로 같은 문서 안에는 아래 값도 같이 보인다.

- `window.open('//gallog.dcinside.com/bracelet0963')`
- `author.url = "https://gallog.dcinside.com/bracelet0963"`

따라서 v2 core는 대상 게시물 HTML에서 작성자 `user_id`를 별도 레이어 요청 없이 직접 얻을 수 있다.

### 2.5.3 `gallog_content_reple` 응답 확정

실제 확인된 요청:

- `POST /api/gallog_user_layer/gallog_content_reple/`
- `user_id=bracelet0963`

실제 응답 예시:

```txt
[758, 1856, 0, 0,
```

v2 core는 여기서 앞의 두 숫자만 사용한다.

- 첫 번째 숫자: `postCount`
- 두 번째 숫자: `commentCount`

즉 예시 게시물의 작성자는:

- `uid = bracelet0963`
- `postCount = 758`
- `commentCount = 1856`
- `totalActivity = 2614`

이 케이스는 `깡계(<100)`가 아니므로, v2 core 기준 자동 삭제 대상이 아니다.

### 2.5.4 v2 자동 삭제 추가 가드: 최근 100개 / 개념글 제외

레퍼런스 프로젝트의 게시물 snapshot 규칙 기준으로, v2 자동 삭제에는 아래 운영 가드를 추가한다.

#### 최근 100개 정의

- 기준 목록은 `전체글`이다.
- `공지`, `설문`, 숫자 아닌 `gall_num` row는 제외한다.
- 제외 후 남는 일반 사용자 게시물 row를 `regular row`로 본다.
- `regular row`를 최신순으로 모은 뒤 앞 100건만 `최근 100개 게시물`로 본다.
- 개념글 row는 recent 100 계산에서도 제외한다.

즉 `최근 100개`는 **전체글의 최신 100 regular row**다.

#### 개념글 판정

개념글 판정 신호는 두 단계로 본다.

1. 목록 row 기준
   - `gall_num`이 숫자가 아니고 `crt_icon`인 row는 개념글 row로 본다.
2. view HTML 기준
   - `#recommend` hidden input 값이 `K`면 개념글로 본다.

실행 가드에는 view HTML 기준 판정을 우선 사용한다.

#### 자동 삭제 실행 조건

신문고 자동 삭제는 아래를 모두 만족할 때만 진행한다.

1. 신뢰 사용자 명령
2. 링크 dedupe 통과
3. 일일 제한 통과
4. v2 core 작성자 필터 통과
5. 대상 게시물이 최근 100개 regular row 안에 있음
6. 대상 게시물이 개념글이 아님
7. 그 뒤 LLM helper가 `allow + confidence >= threshold`

즉 `최근 100개 밖` 또는 `개념글`이면 자동 삭제/차단하지 않는다.

#### Fail-safe

아래 경우는 모두 자동 실행하지 않는다.

- 전체글 목록 fetch 실패
- recent 100 계산 실패
- 대상 게시물 row 미발견
- 개념글 여부 판정 실패

즉 이 가드는 **실행 허용 조건**이지, 공격적으로 추정해서 실행하는 조건이 아니다.

추가 실확인 예시:

- 대상 게시물: `1044708`
- view HTML 작성자 메타:
  - `data-uid = adjust7431`
  - `data-ip = ""`
  - `data-nick = 행복한천국으로`
- `gallog_content_reple(user_id=adjust7431)` 응답:
  - `1652,22699,0,0,best_t`
- 해석:
  - `postCount = 1652`
  - `commentCount = 22699`
  - `totalActivity = 24351`

이 케이스도 `깡계(<100)`가 아니므로, v2 core 기준 자동 삭제 대상이 아니다.

### 2.5.5 v2 core 기본 판정 예시

- 유동 게시물
  - `data-uid = ''`
  - `data-ip = '121.140'`
  - 즉시 삭제 + 6시간 차단 허용

- 식별코드 게시물
  - `data-uid = 'near1254'`
  - `gallog_content_reple -> postCount=12, commentCount=4`
  - 총합 `16 < 100`
  - 삭제 + 6시간 차단 허용

- 일반 활동 계정
  - `data-uid = 'normaluser01'`
  - `gallog_content_reple -> postCount=89, commentCount=220`
  - 총합 `309 >= 100`
  - 자동 처리 안 함, 로그만 남김

## 3. v1 정책

### 3.1 감시 대상

- 갤러리: `galleryId`
- 게시물: 설정에서 입력하는 `reportTarget` (신문고 게시물 링크 또는 게시물 번호)

### 3.2 폴링 주기

- 기본값: `60000ms` (1분)

### 3.2.1 신문고 게시물 설정 방식

v1은 신문고 게시물을 하드코딩하지 않는다. 운영자가 확장 설정에서 아래 둘 중 하나를 넣을 수 있어야 한다.

- 전체 링크
- 게시물 번호만 입력

예:

```text
https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1044313
```

또는

```text
1044313
```

정규화 규칙:

1. 숫자만 들어오면 그대로 `reportPostNo`로 사용한다.
2. 링크가 들어오면 `no` 파라미터에서 게시물 번호를 추출한다.
3. 추출 실패 시 설정 저장을 거부한다.
4. 가능하면 `id` 파라미터도 읽어서 현재 `galleryId`와 비교한다.
5. `id`가 다르면 설정 저장을 거부한다.

즉 내부 실행은 항상 `reportPostNo`를 기준으로 하지만, UI 입력은 링크/번호 둘 다 허용한다. 단, 링크를 넣는 경우 현재 갤러리 ID와 일치하는 신문고 게시물만 허용한다.

여기서 `설정 저장`은 확장 설정값(`reportTarget`)을 저장하는 뜻이다. 중복 처리 방지용 실행 키 저장과는 다른 개념이다.

### 3.3 신뢰 사용자 등록 정책

신뢰 사용자는 하드코딩하지 않는다.

운영자가 확장 UI에서 직접 아래 값을 등록/삭제한다.

- `user_id`
- `label`

예:

```json
{
  "userId": "exercens02",
  "label": "EXERCENS"
}
```

설명:

- `userId`
  - 댓글 API 응답의 `user_id`와 직접 비교하는 내부 키
- `label`
  - 사람이 보는 식별 이름
  - 실제 차단 사유 문자열 생성에 사용

### 3.4 명령 사용자 조건

명령 댓글은 아래 조건을 모두 만족해야 한다.

- 신뢰 사용자 화이트리스트에 등록된 `user_id`
- 하루 사용 횟수 `2회 미만`
- 명령 파싱 성공
- 아직 같은 대상 링크를 처리한 적 없음

원댓글/대댓글은 구분하지 않는다.

즉 `depth === 0`만 허용하는 정책이 아니라, 댓글/대댓글 모두 허용한다.

### 3.5 명령 문법

v1 기본 문법:

```text
@특갤봇 "링크" 사유:광고
```

허용 목표:

- 대상 게시물 링크 1개
- `@특갤봇` prefix 존재
- 큰따옴표 안 링크 1개
- `사유:` 구문 존재

주의:

- v1은 `사유:` 뒤 텍스트를 차단 payload의 자유사유로 그대로 쓰지 않는다.
- `사유:` 구문은 명령 유효성 확인용으로만 사용한다.
- 실제 `avoid_reason_txt`는 등록된 신뢰 사용자의 `label`로 만든다.

v1 파싱 결과:

- `targetUrl`
- `targetPostNo`
- `reasonText`
- `depth`
- `commentNo`
- `requestUserId`

### 3.6 처리 액션

신문고 명령 유효 시 v1 액션:

1. 대상 게시물 삭제
2. 대상 게시물 작성자 6시간 차단

기본 차단 시간:

- `6시간`

기본 사유:

- 운영자가 선택한 고정 사유 코드 사용
- `avoid_reason_txt`는 신뢰 사용자 등록 정보의 `label`을 사용해 아래 형식으로 만든다.

```text
<label> 특갤봇차단
```

예:

```text
EXERCENS 특갤봇차단
```

### 3.6.1 `avoid_reason_txt` 20자 제한 방어 정책

디시 관리자 UI의 `직접 입력` 사유는 20자 제한이 있으므로, v1은 매우 보수적으로 문자열 길이를 계산한다.

원칙:

- 공백도 1글자로 계산한다.
- `:`도 1글자로 계산한다.
- 한글/영문/숫자/기호를 모두 그대로 길이에 포함한다.
- 문서 표기용 `< >`, 따옴표는 실제 payload에 넣지 않는다.

사유 생성 우선순위:

1. 1차 후보: `<label> 특갤봇차단:<A>`
2. 20자를 넘으면 `A`를 먼저 자른다.
3. 그래도 20자를 넘으면 A를 완전히 버리고 `<label> 특갤봇차단`만 쓴다.
4. 그것도 20자를 넘으면 label도 잘라서 20자 이하가 되게 맞춘다.

즉, v1은 어떤 경우에도 20자를 넘는 `avoid_reason_txt`를 보내지 않는다.

추가 이중 방어 규칙:

- UI에서 `label` 입력 길이는 20자로 제한한다.
- 하지만 UI 제한만 믿지 않고, 실제 실행 직전에도 다시 총 길이를 계산한다.
- 즉 UI validation과 런타임 문자열 축약을 둘 다 적용한다.

운영 정책:

- 신뢰 사용자에게는 `사유:` 뒤 텍스트를 2~3글자로 짧게 쓰도록 안내한다.
- 하지만 봇은 그 입력을 신뢰하지 않고, 항상 최종 payload를 20자 이하로 강제 보정한다.
- 전체 `사유 A` 원문은 payload가 아니라 로컬 로그에 full text로 저장한다.

v1 기본 실행 방식:

- `update_avoid_list`
- `del_chk=1`
- `avoid_hour=6`
- `avoid_type_chk=1`
- `avoid_reason=0`

`avoid_type_chk=1`은 기존 관리자 UI에서 확인된 `식별 코드의 IP 차단` 체크값이며, 신문고 봇 v1 기본값으로 고정한다.

### 3.7 일일 사용 제한

- 기준 키: `requestUserId`
- 날짜 기준: `KST YYYY-MM-DD`
- 제한: `1인당 일일 2회`

중요:

- 성공 여부와 무관하게 실제 액션 시도 자체를 1회로 카운트한다.
- 즉 응답이 모호하거나 페이지 리다이렉트 때문에 성공 판정이 흐려져도, 액션을 시도했다면 차감한다.

### 3.8 재시도 정책

- 실패한 명령도 다음 poll에서 재시도하지 않는다.
- 한 번 액션 시도한 명령은 그 시점에서 처리 종료로 본다.

이 정책을 택하는 이유:

- 디시 관리자 요청은 응답이 모호하거나 페이지 이동 때문에 명확한 성공 판정이 어려울 수 있다.
- 재시도를 허용하면 같은 링크가 중복 삭제/중복 차단될 위험이 커진다.

### 3.9 중복 처리 정책

v1에서 가장 중요한 중복 방지 기준은 댓글 번호가 아니라 대상 링크다.

정책:

- 같은 대상 `postNo`는 중복 처리하지 않는다.
- 댓글 번호는 직접 dedupe key로 저장하지 않고, `lastSeenCommentNo` 기준으로 새로움만 판정한다.

이유:

- 1분 폴링 중 댓글 상태가 꼬이거나, 운영자가 댓글을 지우거나, 목록이 변해도 같은 링크를 다시 처리하지 않게 해야 한다.
- 댓글 번호만 기준으로 삼으면 이상한 polling race에서 시도 횟수만 차감되고 같은 대상이 다시 처리될 수 있다.
- 링크 안 `id`가 현재 `galleryId`와 다른 경우도 실행하지 않지만, 같은 잘못된 링크가 계속 올라올 수 있으므로 dedupe key는 저장한다.

v1 권장 dedupe key:

```text
<galleryId>:<targetPostNo>
```

보조 저장값:

- `processedCommandKeys`
- `processedTargetPostNos`

핵심 중복 방지는 `lastSeenCommentNo` + `processedCommandKeys/processedTargetPostNos` 조합으로 한다.

## 4. v1 전체 플로우

1. 사용자가 `신문고 봇` 토글을 켠다.
2. 봇은 설정의 `reportTarget`을 정규화해서 `reportPostNo`를 만든 뒤, 해당 게시물 HTML을 읽고 `e_s_n_o`를 확보한다.
3. `comment_page=1,2`를 읽어서 최근 1~2페이지 댓글만 가져온다.
4. 최근 1~2페이지에서 가장 큰 댓글 번호를 `currentMaxCommentNo`로 계산한다.
5. 아직 시드가 없다면 `lastSeenCommentNo = currentMaxCommentNo`로 저장하고, 기존 댓글은 처리하지 않는다.
6. 시드가 있으면 `comment.no > lastSeenCommentNo`인 댓글만 새 댓글로 본다.
7. 새 댓글 각각에 대해:
   - 삭제된 댓글인지 확인
   - 신뢰 사용자(`user_id`)인지 확인
   - 명령 파싱 성공 여부 확인
   - 같은 대상 링크를 이미 처리했는지 확인
   - 일일 제한 초과 여부 확인
8. 조건을 통과한 댓글이면 대상 게시물 번호를 추출한다.
9. 링크의 `id`가 현재 `galleryId`와 다르면:
   - 실제 액션은 수행하지 않는다.
   - 대신 `다른 갤 링크` 로그를 남긴다.
   - 같은 링크가 반복되지 않도록 dedupe key는 저장한다.
   - 일일 사용 횟수도 1회 차감한다.
10. 정상 대상이면 액션 실행 직전 같은 트랜잭션 단계에서:
   - dedupe key 저장
   - 일일 사용 횟수 차감
11. 대상 게시물에 대해:
   - `update_avoid_list(del_chk=1, avoid_hour=6, avoid_type_chk=1)` 실행
12. 성공/실패 여부와 무관하게 해당 명령은 재시도하지 않는다.
13. 결과 로그를 남긴다.
14. 이번에 본 최근 1~2페이지 댓글 중 최대 번호를 `lastSeenCommentNo`로 갱신한다.
15. `pollIntervalMs` 후 다시 반복한다.

## 5. 구현 범위

### 5.1 v1에서 포함

- 수동 시작/정지
- 신문고 게시물 댓글 폴링
- 신뢰 사용자 검증
- 링크/사유 파싱
- 일일 사용 제한
- 링크 기준 중복 처리 방지
- 삭제 + 6시간 차단 액션
- 로그/통계
- UI에서 `trustedUsers(user_id + label)` 등록/삭제

### 5.2 v1에서 제외

- 자동 감시
- 여러 신문고 게시물 동시 감시
- 댓글로 결과 답글 달기
- 첨부 이미지/파일 기반 명령
- 자연어 명령 다중 포맷 지원
- 관리자 부재 시간대 스케줄링
- 최근 댓글 작성자 목록에서 자동 선택 UI

## 6. 구현 파일 구조

### 6.1 새 feature 이름

- 내부 feature 이름: `reportBot`

### 6.2 새 파일

- `projects/dc_auto_bot/background/api.js`
- `projects/dc_auto_bot/background/parser.js`
  - 명령 파싱
  - `@특갤봇` / 링크 / `사유:` 판정
  - `user_id`, `name`, `depth`, `c_no` 추출 정규화
- `projects/dc_auto_bot/background/scheduler.js`
- `projects/dc_auto_bot/background/background.js`
- `projects/dc_auto_bot/popup/popup.html`
- `projects/dc_auto_bot/popup/popup.js`
- `projects/dc_auto_bot/popup/popup.css`
- `projects/dc_auto_bot/manifest.json`

### 6.3 재사용 가능한 기존 레퍼런스

- 댓글 읽기:
  - `dc_defense_suite/features/comment/api.js`
- 운영 차단 / 삭제+차단:
  - `dc_defense_suite/features/ip/api.js`
- 상태/토글/popup 구조:
  - `dc_defense_suite/background/background.js`
  - `dc_defense_suite/popup/*`

## 7. 설정 스키마

`reportBot.config`

```js
{
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  reportTarget: '',
  reportPostNo: 0,
  pollIntervalMs: 60000,
  trustedUsers: [],
  dailyLimitPerUser: 2,
  commandPrefix: '@특갤봇',
  avoidHour: '6',
  avoidReason: '0',
  deleteTargetPost: true,
  avoidTypeChk: true,
}
```

`trustedUsers` v1 형식:

```js
[
  {
    userId: 'exercens02',
    label: 'EXERCENS'
  }
]
```

등록 방식:

- 하드코딩하지 않는다.
- 프로그램 UI에서 운영자가 직접 `user_id`와 `label`을 입력해 등록/삭제할 수 있어야 한다.

신문고 게시물도 하드코딩하지 않는다.

- 프로그램 UI에서 운영자가 `reportTarget`에 링크 또는 게시물 번호를 직접 입력한다.
- 저장 시 내부에서 `reportPostNo`로 정규화한다.

## 8. 저장 상태 스키마

`reportBotSchedulerState`

```js
{
  isRunning: false,
  lastPollAt: '',
  pollCount: 0,
  totalProcessedCommands: 0,
  totalAttemptedCommands: 0,
  totalSucceededCommands: 0,
  totalFailedCommands: 0,
  currentPhase: 'IDLE',
  lastSeenCommentNo: '0',
  processedCommandKeys: [],
  processedTargetPostNos: [],
  dailyUsage: {
    'exercens02': {
      '2026-03-09': 1
    }
  },
  logs: []
}
```

설명:

- `lastSeenCommentNo`
  - 댓글 새로움 판정의 핵심 기준
  - 최근 1~2페이지를 읽고, 그 안에서 가장 큰 `comment.no`를 저장한다
  - 다음 poll에서는 `comment.no > lastSeenCommentNo`인 댓글만 새 댓글로 처리한다
- `processedCommandKeys`
  - 핵심 중복 처리 방지 키
  - 기본 형식: `<galleryId>:<targetPostNo>`
- `processedTargetPostNos`
  - UI/통계용 빠른 참조 집합
- `processedCommandKeys` / `processedTargetPostNos`는 최근 처리한 링크 dedupe용 보조 저장값이며, 댓글 새로움 판정 자체는 `lastSeenCommentNo`가 담당한다.
- `lastSeenCommentNo`
  - 최근 1~2페이지 기준으로 마지막으로 본 최대 댓글 번호
  - `comment.no > lastSeenCommentNo` 인 댓글만 새 댓글로 본다
- `dailyUsage`
  - 사용자별 일일 사용 횟수
  - 성공이 아니라 시도 기준으로 증가

## 9. 댓글 명령 파싱 스펙

### 9.1 기본 포맷

```text
@특갤봇 "https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=12345" 사유:광고
```

### 9.2 파싱 규칙

- prefix는 문자열 시작이 아니어도 된다.
- 링크는 큰따옴표 안 URL을 우선 지원한다.
- `사유:` 뒤 텍스트는 줄 끝까지 읽는다.
- `depth`와 무관하게 댓글/대댓글 모두 파싱 대상이다.

### 9.3 추출 결과

```js
{
  prefixMatched: true,
  targetUrl: 'https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=12345',
  targetPostNo: '12345',
  reasonText: '광고',
  requestUserId: 'exercens02',
  requestLabel: 'EXERCENS'
}
```

### 9.4 실패 조건

- prefix 없음
- 링크 없음
- postNo 추출 실패
- 사유 없음
- 등록되지 않은 `user_id`

실패 시 처리:

- 실행 안 함
- 로그만 남김
- 일일 사용 횟수 차감 안 함
- dedupe key 저장 안 함

## 10. 신뢰 사용자 검증 정책

v1은 댓글 작성자의 `user_id`가 신뢰 목록에 있는지를 본다.

검증 절차:

1. 댓글 객체에서 `user_id` 추출
2. `trustedUsers[].userId`와 비교
3. 일치하면 통과

v1은 `uid`, `name + ip` fallback을 사용하지 않는다.

즉 신뢰 사용자 검증의 단일 기준은 `user_id`다.

## 11. 삭제 + 6시간 차단 액션 스펙

### 11.1 v1 기본안: 기존 `update_avoid_list` 재사용

현재는 이 안을 v1 기본 구현안으로 채택한다.

```txt
POST /ajax/minor_manager_board_ajax/update_avoid_list

ci_t=...
id=<galleryId>
nos[]=<targetPostNo>
parent=
avoid_hour=6
avoid_reason=<reasonCode>
avoid_reason_txt=<label> 특갤봇차단
del_chk=1
_GALLTYPE_=M
avoid_type_chk=1
```

현재까지 확인된 사실:

- `del_chk=1` payload가 실제 관리자 액션에서 전송됨
- 따라서 `삭제 + 6시간 차단`을 한 endpoint에서 처리하는 방향이 가장 유력함

### 11.2 fallback안: 게시물 삭제 API 별도 사용

예외적으로 `del_chk=1`이 일부 상황에서 게시물 삭제를 수행하지 않는다면 다음 fallback이 필요하다.

- 게시물 삭제 전용 API `delete_list`
- 그 다음 기존 `update_avoid_list`로 6시간 차단

단, 현재 v1의 1차 구현 목표는 fallback이 아니라 `update_avoid_list` 단일 경로다.

## 12. 확정된 운영 정책

1. `avoid_type_chk` 기본값은 `1`이다.
2. 실패한 명령도 다음 poll에서 재시도하지 않는다.
3. 같은 링크는 중복 처리하지 않는다.
   - 중복 기준은 댓글 번호가 아니라 대상 `postNo`다.
4. 일일 2회 카운트는 성공 여부와 무관하게 실제 시도 기준으로 차감한다.
5. 신뢰 사용자는 확장에서 운영자가 직접 `user_id + label`을 입력해 등록한다.
6. 실제 `avoid_reason_txt`는 기본적으로 `<label> 특갤봇차단` 형식으로 만들고, `사유 A`가 있으면 20자 제한 안에서만 뒤에 붙인다.
7. `avoid_reason_txt`는 공백/기호를 포함해 항상 20자 이하로 강제 보정한다.
8. 댓글 번호는 직접 dedupe key로 저장하지 않고, `lastSeenCommentNo` 기준으로 새로움만 판정한다.
9. 최근 1~2페이지를 다시 읽더라도 `lastSeenCommentNo`보다 작은 예전 댓글은 재처리하지 않는다.

## 13. 권장 추가 검증

1. 여유 있으면 `avoid_hour=6` 실캡처 한 번 더 확인
2. 가능하면 `update_avoid_list(del_chk=1)`의 성공/실패 응답 패턴 추가 확보

현재 상태에선 바로 v1 구현에 들어갈 수 있다.

## 14. 구현 순서

1. `reportBot` parser 작성
   - 명령 파서
   - 링크/사유 파서
2. `reportBot` scheduler 작성
   - 폴링
   - 신뢰 사용자 검증
   - 일일 제한
   - 링크 기준 중복 처리 방지
3. `reportBot` action 작성
   - `update_avoid_list(del_chk=1, avoid_hour=6, avoid_type_chk=1)`
4. popup/manifest/background 연결
5. 실제 신문고 게시물에서 테스트

## 15. 구현 완료 기준

다음이 되면 v1 완료로 본다.

- 신문고 게시물 링크 또는 번호를 설정할 수 있다.
- 1분 폴링이 돌아간다.
- 신뢰 사용자 댓글만 처리한다.
- 링크/사유 파싱이 된다.
- 사용자당 일일 2회 제한이 걸린다.
- `user_id` 기준 신뢰 사용자만 처리된다.
- 댓글/대댓글 모두 명령으로 처리된다.
- 같은 대상 링크는 중복 처리되지 않는다.
- 대상 게시물에 대해 `update_avoid_list(del_chk=1, avoid_hour=6, avoid_type_chk=1)`가 실행된다.
- `avoid_reason_txt`에 `<label> 특갤봇차단` 형식이 들어간다.
- 성공/실패 로그가 남는다.
