function parseRegularBoardPosts(html) {
  const htmlText = String(html || '');
  const results = [];
  const rowPattern = /<tr[^>]*class="ub-content[^"]*"[^>]*>([\s\S]*?)<\/tr>/ig;
  let match = null;

  while ((match = rowPattern.exec(htmlText)) !== null) {
    const rowHtml = String(match[1] || '');
    const gallNumMatch = rowHtml.match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const postNo = decodeHtml(String(gallNumMatch?.[1] || '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    const currentHead = extractBoardRowHead(rowHtml);

    if (!postNo || !isRegularBoardRow(rowHtml) || isExcludedBoardHead(currentHead)) {
      continue;
    }

    results.push({
      no: postNo,
      subject: extractBoardRowSubject(rowHtml),
      currentHead,
    });
  }

  return results;
}

function isRegularBoardRow(rowHtml) {
  const gallNumMatch = String(rowHtml || '').match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!gallNumMatch) {
    return false;
  }

  const gallNumText = decodeHtml(String(gallNumMatch[1] || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return /^\d+$/.test(gallNumText);
}

function extractBoardRowSubject(rowHtml) {
  const titleMatch = String(rowHtml || '').match(/<td[^>]*class="gall_tit[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!titleMatch) {
    return '';
  }

  return decodeHtml(String(titleMatch[1] || ''))
    .replace(/<em[^>]*class="icon_[^"]*"[\s\S]*?<\/em>/gi, ' ')
    .replace(/<span[^>]*class="reply_num"[\s\S]*?<\/span>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBoardRowHead(rowHtml) {
  const subjectMatch = String(rowHtml || '').match(/<td[^>]*class="gall_subject[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!subjectMatch) {
    return '';
  }

  return decodeHtml(String(subjectMatch[1] || ''))
    .replace(/<p[^>]*class="subject_inner"[\s\S]*?<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/,+$/g, '')
    .trim();
}

function isExcludedBoardHead(currentHead) {
  const normalizedHead = String(currentHead || '').replace(/\s+/g, ' ').trim();
  return normalizedHead === '공지' || normalizedHead === '설문';
}

function extractPostContentForLlm(html, baseUrl = 'https://gall.dcinside.com') {
  const htmlText = String(html || '');
  const titleHeadMatch = htmlText.match(/<span[^>]*class=["']title_headtext["'][^>]*>([\s\S]*?)<\/span>/i);
  const titleMatch = htmlText.match(/<span[^>]*class=["']title_subject["'][^>]*>([\s\S]*?)<\/span>/i);
  const titleHead = decodeHtml(stripTags((titleHeadMatch && titleHeadMatch[1]) || '')).replace(/\s+/g, ' ').trim();
  const titleSubject = decodeHtml(stripTags((titleMatch && titleMatch[1]) || '')).replace(/\s+/g, ' ').trim();
  const title = [titleHead, titleSubject].filter(Boolean).join(' ').trim();

  const writeDivHtml = extractWriteDivHtml(htmlText);
  const imageUrls = extractImageUrls(writeDivHtml, baseUrl);
  const bodyText = decodeHtml(stripTags(writeDivHtml))
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title,
    bodyText,
    imageUrls,
  };
}

function extractPostAuthorMeta(html) {
  const htmlText = String(html || '');
  const tagPattern = /<(div|td)[^>]*class=["']([^"']*)["'][^>]*data-loc=["']view["'][^>]*>/ig;
  let match = null;

  while ((match = tagPattern.exec(htmlText)) !== null) {
    const classText = String(match[2] || '');
    if (classText.includes('gall_writer') && classText.includes('ub-writer')) {
      const writerTag = match[0];
      const nickMatch = writerTag.match(/data-nick=["']([^"']*)["']/i);
      const uidMatch = writerTag.match(/data-uid=["']([^"']*)["']/i);
      const ipMatch = writerTag.match(/data-ip=["']([^"']*)["']/i);

      return {
        success: true,
        nick: decodeHtml((nickMatch && nickMatch[1]) || ''),
        uid: String((uidMatch && uidMatch[1]) || '').trim(),
        ip: String((ipMatch && ipMatch[1]) || '').trim(),
      };
    }
  }

  return {
    success: false,
    message: '본문 작성자 메타를 찾지 못했습니다.',
  };
}

function extractRecommendState(html) {
  const htmlText = String(html || '');
  const recommendMatch = htmlText.match(/<input[^>]*id=["']recommend["'][^>]*value=["']([^"']*)["']/i);
  if (!recommendMatch) {
    return {
      success: false,
      message: '게시물 recommend 상태를 찾지 못했습니다.',
      recommendState: '',
      isConcept: false,
    };
  }

  const recommendState = String(recommendMatch[1] || '').trim();
  return {
    success: true,
    recommendState,
    isConcept: recommendState === 'K',
  };
}

function extractWriteDivHtml(htmlText) {
  const startMatch = String(htmlText || '').match(/<div class=["']write_div["'][^>]*>/i);
  if (!startMatch) {
    return '';
  }

  let index = startMatch.index + startMatch[0].length;
  let depth = 1;
  const tagPattern = /<\/?div\b[^>]*>/ig;
  tagPattern.lastIndex = index;
  let match = null;

  while ((match = tagPattern.exec(htmlText)) !== null) {
    if (match[0].startsWith('</div')) {
      depth -= 1;
      if (depth === 0) {
        return htmlText.slice(index, match.index);
      }
    } else {
      depth += 1;
    }
  }

  return '';
}

function extractImageUrls(htmlText, baseUrl) {
  const urls = [];
  const seen = new Set();
  const imgPattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/ig;
  let match = null;

  while ((match = imgPattern.exec(String(htmlText || ''))) !== null) {
    const rawUrl = decodeHtml(match[1] || '').trim();
    if (!rawUrl) {
      continue;
    }

    const absoluteUrl = normalizeAbsoluteUrl(rawUrl, baseUrl);
    if (!absoluteUrl || seen.has(absoluteUrl)) {
      continue;
    }

    seen.add(absoluteUrl);
    urls.push(absoluteUrl);
  }

  return urls;
}

function normalizeAbsoluteUrl(url, baseUrl) {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw;
  }

  if (raw.startsWith('//')) {
    return `https:${raw}`;
  }

  if (raw.startsWith('/')) {
    return `${String(baseUrl || '').replace(/\/$/, '')}${raw}`;
  }

  return raw;
}

function stripTags(text) {
  return String(text || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : _;
    });
}

export {
  decodeHtml,
  extractPostAuthorMeta,
  extractPostContentForLlm,
  extractRecommendState,
  parseRegularBoardPosts,
};
