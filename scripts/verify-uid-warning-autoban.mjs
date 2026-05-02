import {
  Scheduler,
  normalizeConfig as normalizeSchedulerConfig,
} from '../features/uid-warning-autoban/scheduler.js';
import {
  ATTACK_TITLE_CLUSTER_MIN_COUNT,
  MIN_ATTACK_TITLE_LENGTH,
  detectAttackTitleClusters,
  normalizeAttackTitle,
} from '../features/uid-warning-autoban/attack-title-cluster.js';
import {
  getRecentRowsWithinWindow,
  groupRowsByUid,
  normalizeImmediateTitleBanRules,
  normalizeImmediateTitleValue,
  parseImmediateTitleBanRows,
  parseUidWarningAutoBanRows,
} from '../features/uid-warning-autoban/parser.js';

if (!globalThis.chrome) {
  globalThis.chrome = {
    storage: {
      local: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
  };
}

const BASE_TIME_MS = Date.UTC(2026, 3, 9, 12, 0, 0);

const testResults = [];

function record(condition, label, details = '') {
  testResults.push({
    ok: Boolean(condition),
    label: String(label || '').trim(),
    details: String(details || '').trim(),
  });
}

function recordEqual(actual, expected, label) {
  const ok = Object.is(actual, expected);
  record(ok, label, ok ? '' : `expected=${formatValue(expected)} actual=${formatValue(actual)}`);
}

function recordArrayEqual(actual, expected, label) {
  const normalizedActual = JSON.stringify(actual);
  const normalizedExpected = JSON.stringify(expected);
  record(
    normalizedActual === normalizedExpected,
    label,
    normalizedActual === normalizedExpected
      ? ''
      : `expected=${normalizedExpected} actual=${normalizedActual}`,
  );
}

function formatValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toKstTimestamp(ms) {
  const date = new Date(Number(ms) + 9 * 60 * 60 * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function makeRow({
  no,
  uid = '',
  ip = '',
  nick = 'ㅇㅇ',
  title = '',
  currentHead = '',
  createdAtMs = BASE_TIME_MS,
  contentType = '',
  gallNumText,
} = {}) {
  return {
    no,
    uid,
    ip,
    nick,
    title,
    currentHead,
    createdAtMs,
    contentType,
    gallNumText: gallNumText === undefined ? String(no) : String(gallNumText),
  };
}

function buildBoardRowHtml(row = {}) {
  const writerAttributes = [
    'class="gall_writer ub-writer"',
    `data-uid="${escapeHtml(row.uid)}"`,
    `data-ip="${escapeHtml(row.ip)}"`,
    `data-nick="${escapeHtml(row.nick)}"`,
  ].join(' ');

  const trAttributes = [
    'class="ub-content us-post"',
    `data-no="${Number(row.no) || 0}"`,
    row.contentType ? `data-type="${escapeHtml(row.contentType)}"` : '',
  ].filter(Boolean).join(' ');

  return `
    <tr ${trAttributes}>
      <td class="gall_num">${escapeHtml(row.gallNumText)}</td>
      <td class="gall_subject"><span>${escapeHtml(row.currentHead)}</span></td>
      <td class="gall_tit ub-word"><a href="/board/view/?id=test&no=${Number(row.no) || 0}">${row.title}</a></td>
      <td ${writerAttributes}></td>
      <td class="gall_date" title="${escapeHtml(toKstTimestamp(row.createdAtMs))}">방금</td>
    </tr>
  `.trim();
}

function buildBoardHtml(rows = []) {
  return [
    '<table><tbody>',
    ...rows.map((row) => buildBoardRowHtml(row)),
    '</tbody></table>',
  ].join('');
}

function collectSubjects(posts = []) {
  return (Array.isArray(posts) ? posts : []).map((post) => String(post?.subject || '').trim()).sort();
}

function collectNos(posts = []) {
  return (Array.isArray(posts) ? posts : []).map((post) => Number(post?.no) || 0).sort((left, right) => left - right);
}

function createExecuteBanStub(options = {}) {
  const calls = [];
  let callIndex = 0;
  const plan = Array.isArray(options.plan) ? options.plan : [];

  return {
    calls,
    async executeBan(payload = {}) {
      const currentPlan = plan[callIndex] || null;
      callIndex += 1;
      calls.push({
        feature: payload.feature,
        deleteEnabled: payload.deleteEnabled,
        posts: Array.isArray(payload.posts) ? payload.posts.map((post) => ({ ...post })) : [],
      });

      if (currentPlan?.activateBanOnly === true) {
        payload.onDeleteLimitBanOnlyActivated?.(currentPlan.message || '삭제 한도');
      }

      if (currentPlan?.activateDeleteFallback === true) {
        payload.onDeleteLimitFallbackSuccess?.({
          activeAccountLabel: currentPlan.activeAccountLabel || 'fallback-account',
        });
      }

      const successNos = currentPlan?.successNos
        ? [...currentPlan.successNos]
        : collectNos(payload.posts);
      const failedNos = currentPlan?.failedNos ? [...currentPlan.failedNos] : [];

      return {
        successNos,
        failedNos,
        deleteLimitFallbackCount: Number(currentPlan?.deleteLimitFallbackCount) || 0,
        banOnlyFallbackUsed: currentPlan?.banOnlyFallbackUsed === true,
        finalDeleteEnabled: currentPlan?.finalDeleteEnabled === undefined
          ? payload.deleteEnabled !== false
          : Boolean(currentPlan.finalDeleteEnabled),
        banOnlyRetrySuccessCount: Number(currentPlan?.banOnlyRetrySuccessCount) || 0,
      };
    },
  };
}

function buildLargeMockRows() {
  const rows = [];

  rows.push(
    makeRow({
      no: 9101,
      uid: '',
      ip: '1.1.1.*',
      nick: 'ㅇㅇ',
      title: 'Ꭺ\u200BV 속보',
      currentHead: '뉴스',
      createdAtMs: BASE_TIME_MS,
    }),
    makeRow({
      no: 9102,
      uid: 'uid-title-a',
      ip: '',
      nick: 'ㅇㅇ',
      title: '삼성전자 HBM 긴급',
      currentHead: '뉴스',
      createdAtMs: BASE_TIME_MS - 10 * 1000,
    }),
    makeRow({
      no: 9103,
      uid: 'uid-title-b',
      ip: '',
      nick: 'ㅇㅇ',
      title: 'A\u200BV 유출 정리',
      currentHead: '잡담',
      createdAtMs: BASE_TIME_MS - 20 * 1000,
    }),
    makeRow({
      no: 9104,
      uid: '',
      ip: '2.2.2.*',
      nick: 'ㅇㅇ',
      title: '※삼성전자※ 실적',
      currentHead: '정보',
      createdAtMs: BASE_TIME_MS - 30 * 1000,
    }),
    makeRow({
      no: 9105,
      uid: 'uid-notice-skip',
      ip: '',
      nick: 'ㅇㅇ',
      title: '이건 공지라 스킵',
      currentHead: '',
      gallNumText: '공지',
      createdAtMs: BASE_TIME_MS - 40 * 1000,
    }),
  );

  rows.push(
    makeRow({ no: 9201, uid: 'uid-burst-private', nick: 'ㅇㅇ', title: 'burst 1', createdAtMs: BASE_TIME_MS - 60 * 1000 }),
    makeRow({ no: 9202, uid: 'uid-burst-private', nick: 'ㅇㅇ', title: 'burst 2', createdAtMs: BASE_TIME_MS - 90 * 1000 }),
    makeRow({ no: 9203, uid: 'uid-burst-private', nick: 'ㅇㅇ', title: 'burst 3', createdAtMs: BASE_TIME_MS - 120 * 1000 }),
  );

  rows.push(
    makeRow({ no: 9301, uid: 'uid-ratio-low', nick: 'ㄴㄴ', title: 'ratio low 1', createdAtMs: BASE_TIME_MS - 50 * 1000 }),
    makeRow({ no: 9302, uid: 'uid-ratio-low', nick: 'ㄴㄴ', title: 'ratio low 2', createdAtMs: BASE_TIME_MS - 100 * 1000 }),
  );

  rows.push(
    makeRow({ no: 9401, uid: 'uid-single-private-locked', nick: 'ㄱㄱ', title: 'single locked', createdAtMs: BASE_TIME_MS - 70 * 1000 }),
    makeRow({ no: 9501, uid: 'uid-single-open-guestbook', nick: 'ㄷㄷ', title: 'single guestbook open', createdAtMs: BASE_TIME_MS - 80 * 1000 }),
    makeRow({ no: 9601, uid: 'uid-public-gallog', nick: 'ㅂㅂ', title: 'single public gallog', createdAtMs: BASE_TIME_MS - 90 * 1000 }),
    makeRow({ no: 9701, uid: 'uid-activity-high', nick: 'ㅅㅅ', title: 'single high total', createdAtMs: BASE_TIME_MS - 110 * 1000 }),
    makeRow({ no: 9801, uid: 'uid-nick-invalid', nick: '반갤러', title: 'nick invalid 1', createdAtMs: BASE_TIME_MS - 60 * 1000 }),
    makeRow({ no: 9802, uid: 'uid-nick-invalid', nick: '반갤러', title: 'nick invalid 2', createdAtMs: BASE_TIME_MS - 90 * 1000 }),
    makeRow({ no: 9901, uid: 'uid-recent-skip', nick: 'ㅈㅈ', title: 'recent skip 1', createdAtMs: BASE_TIME_MS - 75 * 1000 }),
    makeRow({ no: 9902, uid: 'uid-recent-skip', nick: 'ㅈㅈ', title: 'recent skip 2', createdAtMs: BASE_TIME_MS - 105 * 1000 }),
  );

  for (let index = 0; index < 110; index += 1) {
    rows.push(makeRow({
      no: 10000 + index,
      uid: `uid-filler-${index}`,
      nick: '반갤러',
      title: `filler row ${index}`,
      currentHead: index % 2 === 0 ? '일반' : '',
      createdAtMs: BASE_TIME_MS - (index + 5) * 1000,
    }));
  }

  return rows;
}

async function createSchedulerForRows(rows, dependencyOverrides = {}, configOverrides = {}) {
  const html = buildBoardHtml(rows);
  const executeBanStub = createExecuteBanStub({ plan: dependencyOverrides.executePlan });
  const fetchUidStatsCalls = [];
  const fetchUidGallogPrivacyCalls = [];
  const fetchUidGallogGuestbookStateCalls = [];

  const scheduler = new Scheduler({
    fetchListHtml: async () => html,
    fetchUidStats: async (galleryId, uid) => {
      fetchUidStatsCalls.push({ galleryId, uid });
      if (typeof dependencyOverrides.fetchUidStats === 'function') {
        return dependencyOverrides.fetchUidStats(galleryId, uid);
      }
      return { success: true, effectivePostRatio: 0, totalActivityCount: 999 };
    },
    fetchUidGallogPrivacy: async (config, uid) => {
      fetchUidGallogPrivacyCalls.push({ galleryId: config.galleryId, uid });
      if (typeof dependencyOverrides.fetchUidGallogPrivacy === 'function') {
        return dependencyOverrides.fetchUidGallogPrivacy(config, uid);
      }
      return { success: true, fullyPrivate: false, postingPrivate: false, commentPrivate: false };
    },
    fetchUidGallogGuestbookState: async (config, uid) => {
      fetchUidGallogGuestbookStateCalls.push({ galleryId: config.galleryId, uid });
      if (typeof dependencyOverrides.fetchUidGallogGuestbookState === 'function') {
        return dependencyOverrides.fetchUidGallogGuestbookState(config, uid);
      }
      return { success: true, guestbookLocked: false, guestbookWritable: true };
    },
    executeBan: executeBanStub.executeBan,
    delayFn: async () => {},
  });

  scheduler.config = normalizeSchedulerConfig({
    ...scheduler.config,
    galleryId: 'thesingularity',
    pollIntervalMs: 10000,
    recentWindowMs: 5 * 60 * 1000,
    recentPostThreshold: 2,
    postRatioThresholdPercent: 90,
    retryCooldownMs: 60000,
    delChk: true,
    avoidTypeChk: true,
    immediateTitleBanRules: [],
    ...configOverrides,
  });
  scheduler.isRunning = true;

  return {
    scheduler,
    executeBanCalls: executeBanStub.calls,
    fetchUidStatsCalls,
    fetchUidGallogPrivacyCalls,
    fetchUidGallogGuestbookStateCalls,
  };
}

async function runHelperAssertions() {
  const normalizedAv = normalizeImmediateTitleValue('Ꭺ\u200BV');
  const normalizedSamsung = normalizeImmediateTitleValue('※삼성전자※');
  const normalizedHangulBetweenLatin = normalizeImmediateTitleValue('x권x은 x비x 밀x 본x 꼭x 노 x 영x 상');
  const normalizedLeadingLatin = normalizeImmediateTitleValue('x권은비');
  const normalizedTrailingLatin = normalizeImmediateTitleValue('권은비x');
  const normalizedRules = normalizeImmediateTitleBanRules([' AV ', 'A\u200BV', '삼성전자', '', '삼성전자']);
  const normalizedMixedRules = normalizeImmediateTitleBanRules([
    ' AV ',
    { rawTitle: 'A\u200BV' },
    { type: 'contains', rawTitle: '삼성전자' },
    { type: 'and', rawTitle: '반도체, 용인, 노가다' },
    { type: 'and', rawTitle: '노가다, 반도체, 용인' },
    { type: 'and', rawTitle: '반도체, ,' },
    { type: 'and', rawTokens: ['용인', '반도체', '노가다', '반도체'] },
  ]);
  const grouped = groupRowsByUid([
    { uid: 'u1', createdAtMs: BASE_TIME_MS - 3000, no: 1 },
    { uid: 'u1', createdAtMs: BASE_TIME_MS - 1000, no: 2 },
    { uid: 'u2', createdAtMs: BASE_TIME_MS - 2000, no: 3 },
  ]);
  const recentRows = getRecentRowsWithinWindow([
    { createdAtMs: BASE_TIME_MS, no: 1 },
    { createdAtMs: BASE_TIME_MS - 1000, no: 2 },
    { createdAtMs: BASE_TIME_MS - 2000, no: 3 },
    { createdAtMs: BASE_TIME_MS - 6 * 60 * 1000, no: 4 },
  ], 5 * 60 * 1000, 3);

  const html = buildBoardHtml([
    makeRow({ no: 1, uid: 'uid-1', nick: 'ㅇㅇ', title: '정상 글', createdAtMs: BASE_TIME_MS }),
    makeRow({ no: 2, uid: '', ip: '1.1.*', nick: 'ㅇㅇ', title: '유동 글', createdAtMs: BASE_TIME_MS - 1000 }),
    makeRow({ no: 3, uid: 'uid-3', nick: 'ㅇㅇ', title: '공지 스킵', gallNumText: '공지', createdAtMs: BASE_TIME_MS - 2000 }),
    makeRow({ no: 4, uid: 'uid-4', nick: 'ㅇㅇ', title: '사진 글', contentType: 'icon_pic', createdAtMs: BASE_TIME_MS - 3000 }),
  ]);
  const parsedImmediate = parseImmediateTitleBanRows(html);
  const parsedUid = parseUidWarningAutoBanRows(html);
  const attackIconHtml = buildBoardHtml([
    makeRow({ no: 11, uid: '', ip: '1.1.*', nick: 'ㅇㅇ', title: '<em class="icon_pic">게시글</em>검ˇ열‧떡ˆ밥˳검ˊ열˗잼˳ㅋˋㅋ', createdAtMs: BASE_TIME_MS }),
    makeRow({ no: 12, uid: '', ip: '2.2.*', nick: 'ㅇㅇ', title: '<em class="icon_pic">게시글</em>검¸열˖떡ʹ밥.검ʼ열˗잼·ㅋ˘ㅋ', createdAtMs: BASE_TIME_MS - 1000 }),
    makeRow({ no: 13, uid: '', ip: '3.3.*', nick: 'ㅇㅇ', title: '<em class="icon_pic">게시글</em>검ˇ열ˏ떡˘밥˒검˔열ˈ잼ʹㅋ˗ㅋ', createdAtMs: BASE_TIME_MS - 2000 }),
    makeRow({ no: 14, uid: '', ip: '4.4.*', nick: 'ㅇㅇ', title: '<em class="icon_pic">게시글</em>검;열·떡ˉ밥`검ˌ열˙잼˷ㅋ:ㅋ', createdAtMs: BASE_TIME_MS - 3000 }),
  ]);
  const attackRows = parseImmediateTitleBanRows(attackIconHtml);
  const attackNormalizedTitle = normalizeAttackTitle(attackRows[0]?.title);
  const attackThreeRowClusters = detectAttackTitleClusters(attackRows.slice(0, 3), {
    rawCount: 0,
    patternCount: 0,
    patterns: [],
  });
  const attackClusters = detectAttackTitleClusters(attackRows, {
    rawCount: 0,
    patternCount: 0,
    patterns: [],
  });

  recordEqual(normalizedAv, 'av', '정규화가 confusable AV를 av로 접는지');
  recordEqual(normalizedSamsung, '삼성전자', '정규화가 특수문자를 제거하는지');
  recordEqual(normalizedHangulBetweenLatin, 'x권은비밀본꼭노영상', '정규화가 한글 사이에 낀 영문 filler만 제거하는지');
  recordEqual(normalizedLeadingLatin, 'x권은비', '정규화가 한글 앞 영문은 유지하는지');
  recordEqual(normalizedTrailingLatin, '권은비x', '정규화가 한글 뒤 영문은 유지하는지');
  record(
    normalizedHangulBetweenLatin.includes('권은비밀본꼭노'),
    '한글 사이 영문 filler 제거 뒤 contains 규칙이 다시 매치 가능한지',
  );
  recordEqual(normalizedRules.length, 2, '제목 규칙 정규화가 빈값/중복을 제거하는지');
  recordArrayEqual(normalizedRules.map((rule) => rule.normalizedTitle), ['av', '삼성전자'], '제목 규칙 정규화 결과가 예상과 같은지');
  recordArrayEqual(normalizedRules.map((rule) => rule.type), ['contains', 'contains'], '구버전 제목 규칙이 contains 타입으로 승격되는지');
  recordArrayEqual(normalizedRules.map((rule) => rule.ruleKey), ['contains:av', 'contains:삼성전자'], '구버전 제목 규칙의 ruleKey가 contains 접두사로 만들어지는지');
  recordEqual(normalizedMixedRules.length, 3, 'AND 제목 규칙 정규화가 중복/1토큰 규칙을 제거하는지');
  recordArrayEqual(normalizedMixedRules.map((rule) => rule.type), ['contains', 'contains', 'and'], '제목 규칙 정규화가 contains와 and를 함께 유지하는지');
  recordArrayEqual(
    normalizedMixedRules.map((rule) => rule.ruleKey),
    ['contains:av', 'contains:삼성전자', 'and:노가다|반도체|용인'],
    '제목 규칙 정규화가 ruleKey를 타입 포함 canonical key로 만드는지',
  );
  recordEqual(normalizedMixedRules[2].rawTitle, '반도체, 용인, 노가다', 'AND 규칙은 첫 입력 rawTitle을 유지하는지');
  recordArrayEqual(normalizedMixedRules[2].rawTokens, ['노가다', '반도체', '용인'], 'AND 규칙 rawTokens가 canonical 순서로 저장되는지');
  recordArrayEqual(normalizedMixedRules[2].normalizedTokens, ['노가다', '반도체', '용인'], 'AND 규칙 normalizedTokens가 canonical 순서로 저장되는지');
  recordEqual(normalizedMixedRules[2].normalizedTitle, '노가다|반도체|용인', 'AND 규칙 normalizedTitle이 token join 형태인지');
  recordEqual(normalizedMixedRules[2].ruleKey, 'and:노가다|반도체|용인', 'AND 규칙 ruleKey가 and 접두사를 포함하는지');
  recordEqual(grouped.length, 2, 'uid 그룹핑이 uid별로 묶이는지');
  recordArrayEqual(grouped[0].rows.map((row) => row.no), [2, 1], '같은 uid 행이 최신순으로 정렬되는지');
  recordArrayEqual(recentRows.map((row) => row.no), [1, 2, 3], '5분 burst 탐지가 최근 3글 묶음을 고르는지');
  recordEqual(parsedImmediate.length, 3, '즉시제목 파서는 공지 행을 제외하고 유동도 포함하는지');
  recordEqual(parsedUid.length, 2, 'uid 파서는 공지/무uid 행을 제외하는지');
  recordEqual(parsedUid[0].uid, 'uid-1', 'uid 파서가 uid를 유지하는지');
  recordEqual(parsedImmediate[1].isFluid, true, '즉시제목 파서가 유동 글을 인식하는지');
  recordEqual(parsedImmediate[2].isPicturePost, true, '즉시제목 파서가 사진글 플래그를 유지하는지');
  recordEqual(MIN_ATTACK_TITLE_LENGTH, 5, '실제공격 제목 최소 정규화 길이가 5글자인지');
  recordEqual(ATTACK_TITLE_CLUSTER_MIN_COUNT, 4, '실제공격 제목 군집 최소 개수가 4개인지');
  recordEqual(attackRows[0]?.title, '검ˇ열‧떡ˆ밥˳검ˊ열˗잼˳ㅋˋㅋ', '실제 HTML 아이콘 텍스트 게시글은 제목에서 제거되는지');
  recordEqual(attackNormalizedTitle, '검열떡밥검열잼', '실제공격 정규화가 초성/기호 제거 뒤 7글자 제목을 남기는지');
  recordEqual(attackThreeRowClusters.length, 0, '7글자 실제공격 제목도 3개만 있으면 군집으로 잡지 않는지');
  recordEqual(attackClusters.length, 1, '7글자 실제공격 제목도 4개 이상이면 군집으로 잡히는지');
  recordEqual(attackClusters[0]?.rows?.length, 4, '7글자 실제공격 군집의 대상 글 수가 맞는지');
}

async function runMainScenarioAssertions() {
  const rows = buildLargeMockRows();
  record(rows.length >= 120, '메인 시나리오 mock row가 100개 이상인지', `count=${rows.length}`);

  const statsByUid = new Map([
    ['uid-burst-private', { success: true, effectivePostRatio: 95, totalActivityCount: 5 }],
    ['uid-ratio-low', { success: true, effectivePostRatio: 50, totalActivityCount: 5 }],
    ['uid-single-private-locked', { success: true, effectivePostRatio: 100, totalActivityCount: 3 }],
    ['uid-single-open-guestbook', { success: true, effectivePostRatio: 100, totalActivityCount: 3 }],
    ['uid-public-gallog', { success: true, effectivePostRatio: 100, totalActivityCount: 3 }],
    ['uid-activity-high', { success: true, effectivePostRatio: 95, totalActivityCount: 25 }],
    ['uid-recent-skip', { success: true, effectivePostRatio: 95, totalActivityCount: 5 }],
  ]);
  const gallogByUid = new Map([
    ['uid-burst-private', { success: true, fullyPrivate: true, postingPrivate: true, commentPrivate: true }],
    ['uid-single-private-locked', { success: true, fullyPrivate: true, postingPrivate: true, commentPrivate: true }],
    ['uid-single-open-guestbook', { success: true, fullyPrivate: true, postingPrivate: true, commentPrivate: true }],
    ['uid-public-gallog', { success: true, fullyPrivate: false, postingPrivate: false, commentPrivate: false }],
  ]);
  const guestbookByUid = new Map([
    ['uid-single-private-locked', { success: true, guestbookLocked: true, guestbookWritable: false }],
    ['uid-single-open-guestbook', { success: true, guestbookLocked: false, guestbookWritable: true }],
  ]);

  const {
    scheduler,
    executeBanCalls,
    fetchUidStatsCalls,
    fetchUidGallogPrivacyCalls,
    fetchUidGallogGuestbookStateCalls,
  } = await createSchedulerForRows(
    rows,
    {
      fetchUidStats: async (_galleryId, uid) => statsByUid.get(uid) || { success: true, effectivePostRatio: 30, totalActivityCount: 50 },
      fetchUidGallogPrivacy: async (_config, uid) => gallogByUid.get(uid) || { success: true, fullyPrivate: false, postingPrivate: false, commentPrivate: false },
      fetchUidGallogGuestbookState: async (_config, uid) => guestbookByUid.get(uid) || { success: true, guestbookLocked: false, guestbookWritable: true },
    },
    {
      immediateTitleBanRules: ['AV', '삼성전자'],
    },
  );

  scheduler.recentUidActions['thesingularity::uid-recent-skip'] = {
    lastNewestPostNo: 9902,
    lastActionAt: new Date().toISOString(),
    success: false,
  };

  await scheduler.runCycle();

  recordEqual(scheduler.lastPageRowCount, rows.length - 1, 'page1 snapshot 개수가 공지 1개를 제외한 값과 같은지');
  recordEqual(scheduler.lastImmediateTitleBanCount, 4, '즉시 제목 차단 글 수가 4개인지');
  recordEqual(scheduler.totalImmediateTitleBanPostCount, 4, '누적 제목 직차단 카운트가 4개인지');
  recordEqual(scheduler.totalTriggeredUidCount, 1, 'burst uid 제재가 1명인지');
  recordEqual(scheduler.totalSingleSightTriggeredUidCount, 1, '단일발견 깡계 제재가 1명인지');
  recordEqual(scheduler.totalBannedPostCount, 8, '총 성공 글 수가 즉시4 + burst3 + single1인지');
  recordEqual(executeBanCalls.length, 4, 'executeBan 호출이 제목2 + uid2 총 4번인지');
  recordArrayEqual(collectNos(executeBanCalls[0].posts), [9101, 9103], 'AV 규칙 즉시차단 대상 글번호가 맞는지');
  recordArrayEqual(collectNos(executeBanCalls[1].posts), [9102, 9104], '삼성전자 규칙 즉시차단 대상 글번호가 맞는지');
  recordArrayEqual(collectNos(executeBanCalls[2].posts), [9201, 9202, 9203], 'burst uid 제재 대상 글번호가 맞는지');
  recordArrayEqual(collectNos(executeBanCalls[3].posts), [9401], '단일발견 깡계 제재 대상 글번호가 맞는지');
  recordArrayEqual(collectSubjects(executeBanCalls[0].posts), ['A​V 유출 정리', 'Ꭺ​V 속보'].sort(), 'AV 규칙 즉시차단 제목이 맞는지');
  record(fetchUidStatsCalls.some((entry) => entry.uid === 'uid-burst-private'), 'burst 후보의 활동통계 조회가 실행되는지');
  record(fetchUidStatsCalls.some((entry) => entry.uid === 'uid-ratio-low'), '글비중 미달 후보도 활동통계 조회까지는 가는지');
  record(!fetchUidStatsCalls.some((entry) => entry.uid === 'uid-nick-invalid'), '자음 2글자 닉 필터 미달은 활동통계 조회 전에 걸러지는지');
  record(!fetchUidStatsCalls.some((entry) => entry.uid === 'uid-recent-skip'), 'recent cooldown uid는 활동통계 조회 전에 건너뛰는지');
  recordArrayEqual(
    fetchUidGallogPrivacyCalls.map((entry) => entry.uid).sort(),
    ['uid-burst-private', 'uid-public-gallog', 'uid-single-open-guestbook', 'uid-single-private-locked'].sort(),
    '갤로그 조회 대상 uid가 예상과 같은지',
  );
  recordArrayEqual(
    fetchUidGallogGuestbookStateCalls.map((entry) => entry.uid).sort(),
    ['uid-single-open-guestbook', 'uid-single-private-locked'].sort(),
    '방명록 조회가 단일발견 private 후보에만 가는지',
  );
  recordEqual(scheduler.lastTriggeredUid, 'uid-burst-private', '최근 burst 트리거 uid가 맞는지');
  recordEqual(scheduler.lastSingleSightTriggeredUid, 'uid-single-private-locked', '최근 단일발견 트리거 uid가 맞는지');
}

async function runRecentSkipAssertions() {
  const rows = [
    makeRow({ no: 11001, uid: 'uid-immediate-repeat', nick: 'ㅇㅇ', title: 'AV repeat', createdAtMs: BASE_TIME_MS }),
    makeRow({ no: 11002, uid: 'uid-immediate-repeat', nick: 'ㅇㅇ', title: '일반 글', createdAtMs: BASE_TIME_MS - 1000 }),
    makeRow({ no: 11003, uid: 'uid-burst-repeat', nick: 'ㄱㄱ', title: 'burst repeat 1', createdAtMs: BASE_TIME_MS - 2000 }),
    makeRow({ no: 11004, uid: 'uid-burst-repeat', nick: 'ㄱㄱ', title: 'burst repeat 2', createdAtMs: BASE_TIME_MS - 3000 }),
  ];

  const { scheduler, executeBanCalls, fetchUidStatsCalls } = await createSchedulerForRows(
    rows,
    {
      fetchUidStats: async () => ({ success: true, effectivePostRatio: 100, totalActivityCount: 3 }),
      fetchUidGallogPrivacy: async () => ({ success: true, fullyPrivate: true, postingPrivate: true, commentPrivate: true }),
    },
    {
      immediateTitleBanRules: ['AV'],
      retryCooldownMs: 60000,
    },
  );

  scheduler.recentImmediatePostActions['11001'] = {
    lastActionAt: new Date().toISOString(),
    success: true,
  };
  scheduler.recentUidActions['thesingularity::uid-burst-repeat'] = {
    lastNewestPostNo: 11004,
    lastActionAt: new Date().toISOString(),
    success: false,
  };

  await scheduler.runCycle();

  recordEqual(executeBanCalls.length, 0, '직차단 성공 이력과 uid cooldown이 있으면 제재 호출이 0번인지');
  recordEqual(scheduler.totalImmediateTitleBanPostCount, 0, '직차단 recent skip이면 누적 제목 차단이 증가하지 않는지');
  recordEqual(scheduler.totalTriggeredUidCount, 0, 'uid recent skip이면 uid 제재가 발생하지 않는지');
  recordArrayEqual(fetchUidStatsCalls.map((entry) => entry.uid), ['uid-immediate-repeat'], 'uid recent skip이면 같은 uid의 다른 일반 글만 활동통계 조회되는지');
  record(scheduler.logs.some((entry) => entry.includes('최근 처리 이력이 있어 건너뜀')), 'recent skip 로그가 남는지');
}

async function runAndRuleAssertions() {
  const rows = [
    makeRow({ no: 14001, uid: 'uid-and-primary', nick: 'ㄱㄱ', title: '반도체 용인이나 가서 노가다나 쳐해라', createdAtMs: BASE_TIME_MS }),
    makeRow({ no: 14002, uid: 'uid-and-primary', nick: 'ㄱㄱ', title: '반도체용인노가다', createdAtMs: BASE_TIME_MS - 1000 }),
    makeRow({ no: 14003, uid: 'uid-contains-only', nick: 'ㄴㄴ', title: '반도체 용인 공장 얘기', createdAtMs: BASE_TIME_MS - 2000 }),
    makeRow({ no: 14004, uid: 'uid-and-burst', nick: 'ㄷㄷ', title: '노가다 반도체 용인 집합', createdAtMs: BASE_TIME_MS - 3000 }),
    makeRow({ no: 14005, uid: 'uid-and-burst', nick: 'ㄷㄷ', title: '일반 글', createdAtMs: BASE_TIME_MS - 4000 }),
  ];

  const {
    scheduler,
    executeBanCalls,
    fetchUidStatsCalls,
    fetchUidGallogPrivacyCalls,
    fetchUidGallogGuestbookStateCalls,
  } = await createSchedulerForRows(
    rows,
    {
      fetchUidStats: async () => ({ success: true, effectivePostRatio: 100, totalActivityCount: 50 }),
      fetchUidGallogPrivacy: async () => ({ success: true, fullyPrivate: false, postingPrivate: false, commentPrivate: false }),
      fetchUidGallogGuestbookState: async () => ({ success: true, guestbookLocked: false, guestbookWritable: true }),
    },
    {
      immediateTitleBanRules: [
        '반도체',
        { type: 'and', rawTitle: '반도체, 용인, 노가다' },
      ],
    },
  );

  await scheduler.runCycle();

  recordEqual(executeBanCalls.length, 2, 'AND 규칙 시나리오에서 즉시 제목 제재 호출이 2번인지');
  recordArrayEqual(collectNos(executeBanCalls[0].posts), [14001, 14002, 14004], 'AND 규칙 매치 글이 같은 그룹으로 묶이는지');
  recordArrayEqual(collectNos(executeBanCalls[1].posts), [14003], 'contains 전용 글은 별도 그룹으로 묶이는지');
  recordArrayEqual(
    collectSubjects(executeBanCalls[0].posts),
    ['노가다 반도체 용인 집합', '반도체 용인이나 가서 노가다나 쳐해라', '반도체용인노가다'].sort(),
    'AND 규칙 그룹이 순서가 다른 제목과 붙은 문자열 제목을 함께 잡는지',
  );
  recordArrayEqual(collectSubjects(executeBanCalls[1].posts), ['반도체 용인 공장 얘기'], 'contains 규칙 그룹은 부분 포함 제목만 잡는지');
  recordEqual(scheduler.lastImmediateTitleBanCount, 4, 'AND 규칙 시나리오의 즉시 제목 차단 수가 4개인지');
  recordEqual(scheduler.totalImmediateTitleBanPostCount, 4, 'AND 규칙 시나리오의 누적 제목 차단 수가 4개인지');
  recordEqual(scheduler.totalTriggeredUidCount, 0, 'AND 즉시차단 글은 UID burst 경로로 재진입하지 않는지');
  recordEqual(scheduler.totalSingleSightTriggeredUidCount, 0, 'AND 즉시차단 시나리오에서 단일발견 UID 제재가 추가로 생기지 않는지');
  recordEqual(scheduler.lastImmediateTitleBanMatchedTitle, '반도체, 용인, 노가다 외 1개', '최근 제목 직차단 요약이 AND 규칙 이름을 유지하는지');
  record(fetchUidStatsCalls.some((entry) => entry.uid === 'uid-and-burst'), 'AND 즉시차단 뒤에도 같은 uid의 일반 글 1개는 후속 통계 조회가 가능한지');
  recordEqual(
    fetchUidStatsCalls.filter((entry) => entry.uid === 'uid-and-primary').length,
    0,
    'AND 즉시차단으로 처리된 uid의 글은 UID 통계 조회로 재진입하지 않는지',
  );
  recordEqual(
    fetchUidGallogPrivacyCalls.filter((entry) => entry.uid === 'uid-and-primary').length,
    0,
    'AND 즉시차단으로 처리된 uid는 갤로그 조회로 재진입하지 않는지',
  );
  recordEqual(
    fetchUidGallogGuestbookStateCalls.filter((entry) => entry.uid === 'uid-and-primary').length,
    0,
    'AND 즉시차단으로 처리된 uid는 방명록 조회로 재진입하지 않는지',
  );
  record(scheduler.logs.some((entry) => entry.includes('[AND] 반도체, 용인, 노가다 매치')), 'AND 규칙 로그가 타입 라벨과 함께 남는지');
  record(scheduler.logs.some((entry) => entry.includes('[포함] 반도체 매치')), 'contains 규칙 로그도 타입 라벨과 함께 남는지');
}

async function runFailureAssertions() {
  {
    const rows = [
      makeRow({ no: 12001, uid: 'uid-stats-fail', nick: 'ㄱㄱ', title: 'stats fail 1', createdAtMs: BASE_TIME_MS }),
      makeRow({ no: 12002, uid: 'uid-stats-fail', nick: 'ㄱㄱ', title: 'stats fail 2', createdAtMs: BASE_TIME_MS - 1000 }),
    ];
    const { scheduler } = await createSchedulerForRows(rows, {
      fetchUidStats: async () => ({ success: false, message: 'stats fail' }),
    });
    await scheduler.runCycle();
    recordEqual(scheduler.lastError, '식별코드 활동 통계 조회에 실패해 이번 사이클을 건너뛰었습니다.', '모든 stats 후보 실패 시 lastError가 맞는지');
  }

  {
    const rows = [
      makeRow({ no: 12101, uid: 'uid-gallog-fail', nick: 'ㄴㄴ', title: 'gallog fail 1', createdAtMs: BASE_TIME_MS }),
      makeRow({ no: 12102, uid: 'uid-gallog-fail', nick: 'ㄴㄴ', title: 'gallog fail 2', createdAtMs: BASE_TIME_MS - 1000 }),
    ];
    const { scheduler } = await createSchedulerForRows(rows, {
      fetchUidStats: async () => ({ success: true, effectivePostRatio: 100, totalActivityCount: 3 }),
      fetchUidGallogPrivacy: async () => ({ success: false, message: 'gallog fail' }),
    });
    await scheduler.runCycle();
    recordEqual(scheduler.lastError, '갤로그 공개/비공개 확인에 실패해 이번 사이클을 건너뛰었습니다.', '모든 gallog 후보 실패 시 lastError가 맞는지');
  }

  {
    const rows = [
      makeRow({ no: 12201, uid: 'uid-guestbook-fail', nick: 'ㄷㄷ', title: 'guestbook fail', createdAtMs: BASE_TIME_MS }),
    ];
    const { scheduler } = await createSchedulerForRows(rows, {
      fetchUidStats: async () => ({ success: true, effectivePostRatio: 100, totalActivityCount: 3 }),
      fetchUidGallogPrivacy: async () => ({ success: true, fullyPrivate: true, postingPrivate: true, commentPrivate: true }),
      fetchUidGallogGuestbookState: async () => ({ success: false, message: 'guestbook fail' }),
    });
    await scheduler.runCycle();
    recordEqual(scheduler.lastError, '방명록 잠금 확인에 실패해 단일발견 깡계 판정을 건너뛰었습니다.', '모든 guestbook 후보 실패 시 lastError가 맞는지');
  }
}

async function runDeleteFallbackAssertions() {
  const rows = [
    makeRow({ no: 13001, uid: 'uid-title-del-limit', nick: 'ㅇㅇ', title: 'AV fallback', createdAtMs: BASE_TIME_MS }),
    makeRow({ no: 13002, uid: 'uid-burst-after-fallback', nick: 'ㄱㄱ', title: 'burst after 1', createdAtMs: BASE_TIME_MS - 1000 }),
    makeRow({ no: 13003, uid: 'uid-burst-after-fallback', nick: 'ㄱㄱ', title: 'burst after 2', createdAtMs: BASE_TIME_MS - 2000 }),
  ];

  const { scheduler, executeBanCalls } = await createSchedulerForRows(
    rows,
    {
      fetchUidStats: async (_galleryId, uid) => {
        if (uid === 'uid-burst-after-fallback') {
          return { success: true, effectivePostRatio: 100, totalActivityCount: 5 };
        }
        return { success: true, effectivePostRatio: 100, totalActivityCount: 50 };
      },
      fetchUidGallogPrivacy: async () => ({ success: true, fullyPrivate: true, postingPrivate: true, commentPrivate: true }),
      executePlan: [
        {
          successNos: [13001],
          finalDeleteEnabled: false,
          banOnlyFallbackUsed: true,
          banOnlyRetrySuccessCount: 1,
          activateBanOnly: true,
          message: 'delete limit',
        },
        {
          successNos: [13002, 13003],
          finalDeleteEnabled: false,
        },
      ],
    },
    {
      immediateTitleBanRules: ['AV'],
    },
  );

  await scheduler.runCycle();

  recordEqual(executeBanCalls.length, 2, 'delete fallback 시나리오에서 제재 호출이 2번인지');
  recordEqual(executeBanCalls[0].deleteEnabled, true, '첫 제재는 차단+삭제 모드로 시작하는지');
  recordEqual(executeBanCalls[1].deleteEnabled, false, 'ban-only 전환 뒤 다음 제재는 차단 전용인지');
  recordEqual(scheduler.runtimeDeleteEnabled, false, 'scheduler runtimeDeleteEnabled가 false로 남는지');
  recordEqual(scheduler.banOnlyFallbackCount, 1, 'ban-only 전환 카운트가 1인지');
  record(scheduler.logs.some((entry) => entry.includes('토글 OFF할 때까지 분탕자동차단은 차단만 유지')), 'ban-only 전환 로그가 남는지');
}

async function main() {
  await runHelperAssertions();
  await runMainScenarioAssertions();
  await runRecentSkipAssertions();
  await runAndRuleAssertions();
  await runFailureAssertions();
  await runDeleteFallbackAssertions();

  const passed = testResults.filter((result) => result.ok);
  const failed = testResults.filter((result) => !result.ok);

  console.log(`uid-warning-autoban 검증 결과: ${passed.length}/${testResults.length} PASS`);
  for (const result of testResults) {
    const prefix = result.ok ? 'PASS' : 'FAIL';
    const suffix = result.details ? ` :: ${result.details}` : '';
    console.log(`${prefix} - ${result.label}${suffix}`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
