const IMMEDIATE_TITLE_KEEP_REGEX = /[^가-힣a-z]/g;
const INVISIBLE_CHARACTER_REGEX = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
const IMMEDIATE_TITLE_CONFUSABLE_CHAR_MAP = new Map([
  ['Ꭺ', 'a'],
  ['Α', 'a'],
  ['А', 'a'],
  ['ᗅ', 'a'],
  ['ꓮ', 'a'],
  ['Ꭵ', 'v'],
  ['Ꮩ', 'v'],
  ['Ⅴ', 'v'],
  ['Ѵ', 'v'],
  ['ⴸ', 'v'],
  ['ꓦ', 'v'],
]);

function parseUidWarningAutoBanRows(html) {
  return parsePage1BoardRows(html, { requireUid: true });
}

function parseImmediateTitleBanRows(html) {
  return parsePage1BoardRows(html, { requireUid: false });
}

function parsePage1BoardRows(html, options = {}) {
  const results = [];
  const requireUid = options.requireUid === true;
  const rowRegex = /<tr[^>]*class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const rowTagHtml = match[0];
    const postNo = Number(match[1]);
    if (!Number.isFinite(postNo) || postNo <= 0) {
      continue;
    }

    const rowHtml = match[2];
    if (shouldSkipBoardRow(rowHtml)) {
      continue;
    }

    const writerTagMatch = rowHtml.match(/<td[^>]*class="gall_writer[^"]*"[^>]*>/i);
    if (!writerTagMatch) {
      continue;
    }

    const writerTag = writerTagMatch[0];
    const uid = decodeHtml(extractAttribute(writerTag, 'data-uid'));
    if (requireUid && !uid) {
      continue;
    }

    const ip = decodeHtml(extractAttribute(writerTag, 'data-ip'));

    const createdAtText = decodeHtml(extractGallDateTitle(rowHtml));
    if (!createdAtText) {
      continue;
    }

    const createdAtMs = parseGallTimestampKst(createdAtText);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
      continue;
    }

    const nick = decodeHtml(extractAttribute(writerTag, 'data-nick') || 'ㅇㅇ');
    const title = extractBoardTitle(rowHtml);
    const currentHead = extractCurrentHead(rowHtml);
    const writerToken = uid || ip;
    const contentType = decodeHtml(extractAttribute(rowTagHtml, 'data-type'));
    const isPicturePost = contentType === 'icon_pic';
    const hasUid = Boolean(uid);
    const isFluid = Boolean(ip);

    results.push({
      no: postNo,
      uid,
      nick,
      title,
      subject: title,
      currentHead,
      createdAtText,
      createdAtMs,
      writerToken,
      writerKey: makeWriterKey(nick, writerToken || ip || uid),
      writerDisplay: buildWriterDisplay(nick, writerToken),
      contentType,
      isPicturePost,
      isFluid,
      hasUid,
      ip,
    });
  }

  return results;
}

function groupRowsByUid(rows = []) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const uid = String(row?.uid || '').trim();
    if (!uid) {
      continue;
    }

    const existing = grouped.get(uid);
    if (existing) {
      existing.rows.push(row);
      continue;
    }

    grouped.set(uid, {
      uid,
      rows: [row],
    });
  }

  return [...grouped.values()].map((entry) => ({
    ...entry,
    rows: [...entry.rows].sort((left, right) => Number(right.createdAtMs) - Number(left.createdAtMs)),
  }));
}

function getRecentRowsWithinWindow(rows = [], windowMs, threshold = 1) {
  const normalizedRows = (Array.isArray(rows) ? rows : []).filter((row) => {
    const createdAtMs = Number(row?.createdAtMs) || 0;
    return createdAtMs > 0;
  });
  const normalizedWindowMs = Math.max(0, Number(windowMs) || 0);
  const normalizedThreshold = Math.max(1, Number(threshold) || 1);
  let bestRows = [];

  for (let startIndex = 0; startIndex < normalizedRows.length; startIndex += 1) {
    const anchorRow = normalizedRows[startIndex];
    const anchorCreatedAtMs = Number(anchorRow?.createdAtMs) || 0;
    const burstRows = [];

    for (let rowIndex = startIndex; rowIndex < normalizedRows.length; rowIndex += 1) {
      const currentRow = normalizedRows[rowIndex];
      const currentCreatedAtMs = Number(currentRow?.createdAtMs) || 0;
      if (currentCreatedAtMs <= 0) {
        continue;
      }

      if (anchorCreatedAtMs - currentCreatedAtMs > normalizedWindowMs) {
        break;
      }

      burstRows.push(currentRow);
    }

    if (burstRows.length > bestRows.length) {
      bestRows = burstRows;
    }

    if (burstRows.length >= normalizedThreshold) {
      return burstRows;
    }
  }

  return bestRows;
}

function getNewestPostNo(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((maxNo, row) => {
    const postNo = Number(row?.no) || 0;
    return Math.max(maxNo, postNo);
  }, 0);
}

function createUidBanTargetPosts(rows = []) {
  const deduped = [];
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const postNo = Number(row?.no) || 0;
    if (postNo <= 0 || seen.has(postNo)) {
      continue;
    }

    seen.add(postNo);
    deduped.push({
      no: postNo,
      nick: String(row?.nick || '').trim(),
      ip: '',
      uid: String(row?.uid || '').trim(),
      subject: String(row?.title || row?.subject || '').trim(),
      currentHead: String(row?.currentHead || '').trim(),
      isFluid: false,
      hasUid: true,
      writerToken: String(row?.writerToken || row?.uid || '').trim(),
      writerKey: String(row?.writerKey || '').trim(),
      writerDisplay: String(row?.writerDisplay || '').trim(),
    });
  }

  return deduped;
}

function createImmediateTitleBanTargetPosts(rows = []) {
  const deduped = [];
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const postNo = Number(row?.no) || 0;
    if (postNo <= 0 || seen.has(postNo)) {
      continue;
    }

    seen.add(postNo);
    deduped.push({
      no: postNo,
      nick: String(row?.nick || '').trim(),
      ip: String(row?.ip || '').trim(),
      uid: String(row?.uid || '').trim(),
      subject: String(row?.title || row?.subject || '').trim(),
      currentHead: String(row?.currentHead || '').trim(),
      isFluid: Boolean(row?.isFluid),
      hasUid: Boolean(row?.hasUid),
      writerToken: String(row?.writerToken || row?.uid || row?.ip || '').trim(),
      writerKey: String(row?.writerKey || '').trim(),
      writerDisplay: String(row?.writerDisplay || '').trim(),
    });
  }

  return deduped;
}

function normalizeImmediateTitleBanRules(rules = []) {
  const normalizedRules = [];
  const seenRuleKeys = new Set();

  for (const rule of Array.isArray(rules) ? rules : []) {
    const normalizedRule = normalizeImmediateTitleBanRule(rule);
    if (!normalizedRule) {
      continue;
    }

    if (seenRuleKeys.has(normalizedRule.ruleKey)) {
      continue;
    }

    seenRuleKeys.add(normalizedRule.ruleKey);
    normalizedRules.push(normalizedRule);
  }

  return normalizedRules;
}

function normalizeImmediateTitleBanRule(rule) {
  if (typeof rule === 'string') {
    return normalizeImmediateContainsTitleBanRule({ rawTitle: rule });
  }

  if (
    String(rule?.type || '').trim().toLowerCase() === 'and'
    || Array.isArray(rule?.rawTokens)
    || Array.isArray(rule?.normalizedTokens)
  ) {
    return normalizeImmediateAndTitleBanRule(rule);
  }

  return normalizeImmediateContainsTitleBanRule(rule);
}

function normalizeImmediateContainsTitleBanRule(rule = {}) {
  const rawTitle = String(rule?.rawTitle || '').trim();
  if (!rawTitle) {
    return null;
  }

  const normalizedTitle = normalizeImmediateTitleValue(rawTitle);
  if (!normalizedTitle) {
    return null;
  }

  return {
    type: 'contains',
    rawTitle,
    normalizedTitle,
    ruleKey: buildImmediateTitleRuleKey({
      type: 'contains',
      normalizedTitle,
    }),
  };
}

function normalizeImmediateAndTitleBanRule(rule = {}) {
  const rawTokenEntries = normalizeImmediateTitleBanAndTokenEntries(
    Array.isArray(rule?.rawTokens) && rule.rawTokens.length > 0
      ? rule.rawTokens
      : String(rule?.rawTitle || '').trim(),
  );
  if (rawTokenEntries.length < 2) {
    return null;
  }

  const rawTokens = rawTokenEntries.map((entry) => entry.rawToken);
  const normalizedTokens = rawTokenEntries.map((entry) => entry.normalizedToken);
  const normalizedTitle = normalizedTokens.join('|');

  return {
    type: 'and',
    rawTitle: String(rule?.rawTitle || '').trim() || rawTokens.join(', '),
    rawTokens,
    normalizedTokens,
    normalizedTitle,
    ruleKey: buildImmediateTitleRuleKey({
      type: 'and',
      normalizedTitle,
    }),
  };
}

function normalizeImmediateTitleBanAndTokenEntries(value) {
  const entries = [];
  const seenNormalizedTokens = new Set();
  const rawTokens = Array.isArray(value) ? value : String(value || '').split(',');

  for (const rawTokenValue of rawTokens) {
    const rawToken = String(rawTokenValue || '').trim();
    if (!rawToken) {
      continue;
    }

    const normalizedToken = normalizeImmediateTitleValue(rawToken);
    if (!normalizedToken || seenNormalizedTokens.has(normalizedToken)) {
      continue;
    }

    seenNormalizedTokens.add(normalizedToken);
    entries.push({
      rawToken,
      normalizedToken,
    });
  }

  // AND 규칙은 입력 순서와 무관하게 같은 key가 되도록 canonical 순서를 강제한다.
  entries.sort((left, right) => left.normalizedToken.localeCompare(right.normalizedToken, 'ko-KR'));
  return entries;
}

function buildImmediateTitleRuleKey(rule = {}) {
  const normalizedType = String(rule?.type || '').trim().toLowerCase() === 'and'
    ? 'and'
    : 'contains';
  const normalizedTitle = String(rule?.normalizedTitle || '').trim();
  if (!normalizedTitle) {
    return '';
  }

  return `${normalizedType}:${normalizedTitle}`;
}

function normalizeImmediateTitleValue(value) {
  const normalizedSource = String(value || '')
    .normalize('NFKC')
    .replace(INVISIBLE_CHARACTER_REGEX, '');
  let folded = '';

  for (const char of normalizedSource) {
    folded += IMMEDIATE_TITLE_CONFUSABLE_CHAR_MAP.get(char) || char;
  }

  return folded
    .toLowerCase()
    .replace(IMMEDIATE_TITLE_KEEP_REGEX, '')
    .trim();
}

function parseGallogPrivacy(html) {
  const normalizedHtml = String(html || '');
  const postingState = extractGallogPrivacyState(normalizedHtml, 'posting');
  const commentState = extractGallogPrivacyState(normalizedHtml, 'comment');

  if (!postingState.found || !commentState.found) {
    return {
      success: false,
      message: '갤로그 공개/비공개 상태를 파싱하지 못했습니다.',
      postingPublic: false,
      commentPublic: false,
      postingPrivate: false,
      commentPrivate: false,
      fullyPrivate: false,
    };
  }

  return {
    success: true,
    postingPublic: postingState.isPublic,
    commentPublic: commentState.isPublic,
    postingPrivate: postingState.isPrivate,
    commentPrivate: commentState.isPrivate,
    fullyPrivate: postingState.isPrivate && commentState.isPrivate,
  };
}

function parseGallogGuestbookState(html) {
  const normalizedHtml = String(html || '');
  const guestbookLocked = normalizedHtml.includes('허용된 사용자만 방명록을 작성할 수 있습니다.');
  const guestbookWritable = /<form[^>]*(?:name="gb_form"|id="gb_form")[^>]*>/i.test(normalizedHtml);
  const guestbookStateKnown = guestbookLocked || guestbookWritable;

  if (!guestbookStateKnown) {
    return {
      success: false,
      message: '방명록 잠금 상태를 파싱하지 못했습니다.',
      guestbookLocked: false,
      guestbookWritable: false,
      guestbookStateKnown: false,
    };
  }

  return {
    success: true,
    guestbookLocked,
    guestbookWritable,
    guestbookStateKnown: true,
  };
}

function shouldSkipBoardRow(rowHtml) {
  const numberCellMatch = rowHtml.match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  const numberText = decodeHtml(stripTags(numberCellMatch ? numberCellMatch[1] : ''));

  if (numberText && !/^\d+$/.test(numberText)) {
    return true;
  }

  return false;
}

function extractBoardTitle(rowHtml) {
  const titleMatch = rowHtml.match(/<td[^>]*class="gall_tit[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!titleMatch) {
    return '';
  }

  const titleHtml = titleMatch[1]
    .replace(/<em[^>]*class="icon_[^"]*"[\s\S]*?<\/em>/gi, ' ')
    .replace(/<span[^>]*class="reply_num"[\s\S]*?<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtml(titleHtml).replace(/\s+/g, ' ').trim();
}

function extractCurrentHead(rowHtml) {
  const subjectMatch = rowHtml.match(/<td[^>]*class="gall_subject[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!subjectMatch) {
    return '';
  }

  const subjectHtml = subjectMatch[1]
    .replace(/<p[^>]*class="subject_inner"[\s\S]*?<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return decodeHtml(subjectHtml).replace(/\s*,\s*/g, ',').replace(/,+$/g, '');
}

function extractGallDateTitle(rowHtml) {
  const match = rowHtml.match(/<td[^>]*class="gall_date[^"]*"[^>]*title="([^"]+)"[^>]*>/i);
  return match ? match[1] : '';
}

function extractGallogPrivacyState(html, pathSegment) {
  const regex = new RegExp(
    `<h2[^>]*class="tit"[^>]*onclick="location\\.href='\\/[^']*\\/${pathSegment}';"[^>]*>[\\s\\S]*?<\\/h2>\\s*<span class="([^"]+)">\\s*([^<]+?)\\s*<\\/span>`,
    'i',
  );
  const match = html.match(regex);
  if (!match) {
    return {
      found: false,
      isPublic: false,
      isPrivate: false,
    };
  }

  const className = String(match[1] || '').trim().toLowerCase();
  const text = decodeHtml(match[2]).replace(/\s+/g, ' ').trim();
  const isPublic = className.includes('bluebox') && text.includes('공개');
  const isPrivate = className.includes('greybox') && text.includes('비공개');

  return {
    found: true,
    isPublic,
    isPrivate,
  };
}

function buildWriterDisplay(nick, writerToken) {
  const normalizedNick = String(nick || '').trim() || 'ㅇㅇ';
  const normalizedWriterToken = String(writerToken || '').trim();
  return normalizedWriterToken ? `${normalizedNick}(${normalizedWriterToken})` : normalizedNick;
}

function parseGallTimestampKst(value) {
  const match = String(value || '').trim().match(
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) {
    return 0;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    return 0;
  }

  return Date.UTC(year, month - 1, day, hour - 9, minute, second);
}

function makeWriterKey(nick, token) {
  return `${String(nick || '').trim()}|${String(token || '').trim()}`;
}

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function stripTags(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export {
  createImmediateTitleBanTargetPosts,
  createUidBanTargetPosts,
  getNewestPostNo,
  getRecentRowsWithinWindow,
  groupRowsByUid,
  normalizeImmediateTitleBanRules,
  normalizeImmediateTitleValue,
  parseImmediateTitleBanRows,
  parseGallogGuestbookState,
  parseGallogPrivacy,
  parseGallTimestampKst,
  parseUidWarningAutoBanRows,
};
