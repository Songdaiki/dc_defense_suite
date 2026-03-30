function parseUidWarningAutoBanRows(html) {
  const results = [];
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
    if (!uid) {
      continue;
    }

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
    const writerToken = uid;
    const contentType = decodeHtml(extractAttribute(rowTagHtml, 'data-type'));
    const isPicturePost = contentType === 'icon_pic';

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
      writerKey: makeWriterKey(nick, writerToken),
      writerDisplay: `${nick}(${writerToken})`,
      contentType,
      isPicturePost,
      isFluid: false,
      hasUid: true,
      ip: '',
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
  createUidBanTargetPosts,
  getNewestPostNo,
  getRecentRowsWithinWindow,
  groupRowsByUid,
  parseGallogPrivacy,
  parseGallTimestampKst,
  parseUidWarningAutoBanRows,
};
