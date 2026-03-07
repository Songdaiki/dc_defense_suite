function parseTargetPosts(html, headtextName = '도배기') {
  const results = [];
  const rowRegex = /<tr[^>]*class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const postNo = parseInt(match[1], 10);
    if (!Number.isFinite(postNo) || postNo <= 0) {
      continue;
    }

    const rowHtml = match[2];
    if (shouldSkipBoardRow(rowHtml)) {
      continue;
    }

    const writerTagMatch = rowHtml.match(/<td[^>]*class="gall_writer[^"]*"[^>]*>/);
    if (!writerTagMatch) {
      continue;
    }

    const writerTag = writerTagMatch[0];
    const ip = extractAttribute(writerTag, 'data-ip');
    if (!ip) {
      continue;
    }

    const nick = decodeHtml(extractAttribute(writerTag, 'data-nick') || 'ㅇㅇ');
    const subject = extractBoardSubject(rowHtml);
    const currentHead = extractCurrentHead(rowHtml);

    if (headtextName && currentHead && !currentHead.includes(headtextName)) {
      continue;
    }

    results.push({
      no: postNo,
      nick,
      ip,
      subject,
      currentHead,
      writerKey: makeWriterKey(nick, ip),
      writerDisplay: `${nick}(${ip})`,
    });
  }

  return results;
}

function parseBlockListRows(html) {
  const results = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1];
    if (!rowHtml.includes('blockcontent') || !rowHtml.includes('blockstate')) {
      continue;
    }

    const postMatch = rowHtml.match(/<td[^>]*class="blockcontent"[\s\S]*?<a[^>]*href="[^"]*\/(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!postMatch) {
      continue;
    }

    const postNo = parseInt(postMatch[1], 10);
    if (!Number.isFinite(postNo) || postNo <= 0) {
      continue;
    }

    const releaseMatch = rowHtml.match(/onclick="set_avoid\([^,]+,\s*'R'\s*,\s*'(\d+)'\s*,\s*(\d+)\)"/i);
    const blockNumberMatch = rowHtml.match(/<td[^>]*class="blocknum"[^>]*data-num="(\d+)"[^>]*>\s*([^<\s]+)\s*<\/td>/i);
    const writerHtmlMatch = rowHtml.match(/<td[^>]*class="blocknik"[^>]*>([\s\S]*?)<\/td>/i);
    const reasonMatch = rowHtml.match(/<td[^>]*class="blockreason"[^>]*>([\s\S]*?)<\/td>/i);
    const durationMatch = rowHtml.match(/<td[^>]*class="blocktime"[^>]*>([\s\S]*?)<\/td>/i);
    const dateMatch = rowHtml.match(/<span[^>]*class="block_date"[^>]*>([\s\S]*?)<\/span>/i);
    const timeMatch = rowHtml.match(/<p[^>]*class="block_time"[^>]*>\s*처리 시간\s*:\s*([\s\S]*?)<\/p>/i);
    const managerMatch = rowHtml.match(/<p[^>]*class="block_conduct"[^>]*>\s*처리자\s*:\s*([\s\S]*?)<\/p>/i);
    const title = decodeHtml(stripTags(postMatch[2]));
    const writerInfo = extractBlockWriterInfo(writerHtmlMatch ? writerHtmlMatch[1] : '');
    const stateText = decodeHtml(stripTags(extractFirstMatch(rowHtml, /<td[^>]*class="blockstate[^"]*"[^>]*>([\s\S]*?)<\/td>/i)));

    results.push({
      postNo,
      title,
      blockDataNum: blockNumberMatch ? blockNumberMatch[1] : '',
      blockDisplayNo: blockNumberMatch ? blockNumberMatch[2] : '',
      reason: decodeHtml(stripTags(reasonMatch ? reasonMatch[1] : '')),
      duration: decodeHtml(stripTags(durationMatch ? durationMatch[1] : '')),
      blockDate: decodeHtml(stripTags(dateMatch ? dateMatch[1] : '')),
      blockTime: decodeHtml(stripTags(timeMatch ? timeMatch[1] : '')),
      manager: decodeHtml(stripTags(managerMatch ? managerMatch[1] : '')),
      stateText,
      releaseId: releaseMatch ? releaseMatch[1] : '',
      ano: releaseMatch ? releaseMatch[2] : '0',
      writerNick: writerInfo.nick,
      writerToken: writerInfo.token,
      writerKey: makeWriterKey(writerInfo.nick, writerInfo.token),
      writerDisplay: writerInfo.display,
      isActive: Boolean(releaseMatch),
      rowHtml: `<tr>${rowHtml}</tr>`,
    });
  }

  return results;
}

function shouldSkipBoardRow(rowHtml) {
  const numberCellMatch = rowHtml.match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  const numberText = decodeHtml(stripTags(numberCellMatch ? numberCellMatch[1] : ''));

  if (numberText && !/^\d+$/.test(numberText)) {
    return true;
  }

  return false;
}

function extractBoardSubject(rowHtml) {
  const titleMatch = rowHtml.match(/<td[^>]*class="gall_tit[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
  return decodeHtml(stripTags(titleMatch ? titleMatch[1] : ''));
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

function extractBlockWriterInfo(writerHtml) {
  const paragraphs = [];
  const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let paragraphMatch;

  while ((paragraphMatch = paragraphRegex.exec(writerHtml)) !== null) {
    const text = decodeHtml(stripTags(paragraphMatch[1]));
    if (text) {
      paragraphs.push(text);
    }
  }

  const text = paragraphs.length > 0
    ? paragraphs
    : decodeHtml(stripTags(writerHtml))
      .split('\n')
      .map((segment) => segment.trim())
      .filter(Boolean);

  const nick = text[0] || '';
  const tokenRaw = text[1] || '';
  const token = normalizeWriterToken(tokenRaw);
  const display = [nick, tokenRaw].filter(Boolean).join(' ');

  return {
    nick,
    token,
    display,
  };
}

function normalizeWriterToken(value) {
  const normalized = String(value || '').replace(/[()]/g, '').trim();
  if (!normalized) {
    return '';
  }

  const prefixMatch = normalized.match(/^(\d+\.\d+)/);
  return prefixMatch ? prefixMatch[1] : normalized;
}

function makeWriterKey(nick, token) {
  return `${String(nick || '').trim()}|${normalizeWriterToken(token)}`;
}

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function extractFirstMatch(value, regex) {
  const match = value.match(regex);
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
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export {
  makeWriterKey,
  normalizeWriterToken,
  parseBlockListRows,
  parseTargetPosts,
};
