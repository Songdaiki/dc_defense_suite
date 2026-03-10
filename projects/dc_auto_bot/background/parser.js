function isDeletedComment(comment) {
  return comment?.del_yn === 'Y'
    || comment?.is_delete === '1'
    || comment?.is_delete === 1;
}

function normalizeTrustedUsers(trustedUsers = []) {
  const deduped = [];
  const seen = new Set();

  for (const user of Array.isArray(trustedUsers) ? trustedUsers : []) {
    const userId = String(user?.userId || '').trim();
    const label = String(user?.label || '').trim();

    if (!userId || seen.has(userId)) {
      continue;
    }

    seen.add(userId);
    deduped.push({
      userId,
      label: (label || userId).slice(0, 20),
    });
  }

  return deduped;
}

function normalizeReportTarget(reportTarget) {
  const rawValue = String(reportTarget || '').trim();
  if (!rawValue) {
    return {
      success: false,
      message: '신문고 게시물 링크 또는 번호를 입력하세요.',
    };
  }

  if (/^\d+$/.test(rawValue)) {
    return {
      success: true,
      reportTarget: rawValue,
      reportPostNo: rawValue,
      targetGalleryId: '',
    };
  }

  try {
    const url = new URL(rawValue);
    const parsedTarget = extractPostTargetFromUrl(url, rawValue);
    const reportPostNo = parsedTarget.targetPostNo;
    const targetGalleryId = parsedTarget.targetGalleryId;

    if (!/^\d+$/.test(reportPostNo)) {
      return {
        success: false,
        message: '신문고 게시물 링크에서 게시물 번호를 추출하지 못했습니다.',
      };
    }

    return {
      success: true,
      reportTarget: rawValue,
      reportPostNo,
      targetGalleryId,
    };
  } catch {
    return {
      success: false,
      message: '신문고 게시물 링크 형식이 올바르지 않습니다.',
    };
  }
}

function parseTargetUrl(targetUrl) {
  const rawValue = sanitizeExtractedUrl(targetUrl);
  if (!rawValue) {
    return {
      success: false,
      message: '대상 링크가 비어 있습니다.',
    };
  }

  try {
    const url = new URL(rawValue);
    const { targetPostNo, targetGalleryId } = extractPostTargetFromUrl(url, rawValue);

    if (!/^\d+$/.test(targetPostNo)) {
      return {
        success: false,
        message: '대상 링크에서 게시물 번호를 추출하지 못했습니다.',
      };
    }

    return {
      success: true,
      targetPostNo,
      targetGalleryId,
    };
  } catch {
    const fallbackTarget = extractPostTargetFromRawText(rawValue);
    if (/^\d+$/.test(fallbackTarget.targetPostNo)) {
      return {
        success: true,
        targetPostNo: fallbackTarget.targetPostNo,
        targetGalleryId: fallbackTarget.targetGalleryId,
      };
    }

    return {
      success: false,
      message: '대상 링크 형식이 올바르지 않습니다.',
    };
  }
}

function extractPostTargetFromUrl(url, rawValue = '') {
  const targetPostNo = String(url.searchParams.get('no') || '').trim();
  const targetGalleryId = String(url.searchParams.get('id') || '').trim();

  if (/^\d+$/.test(targetPostNo)) {
    return {
      targetPostNo,
      targetGalleryId,
    };
  }

  const pathname = String(url.pathname || '').replace(/\/+$/, '');
  const mobileBoardMatch = pathname.match(/^\/board\/([^/]+)\/(\d+)$/i);

  if (mobileBoardMatch) {
    return {
      targetGalleryId: String(mobileBoardMatch[1] || '').trim(),
      targetPostNo: String(mobileBoardMatch[2] || '').trim(),
    };
  }

  const fallbackTarget = extractPostTargetFromRawText(rawValue || String(url || ''));
  return {
    targetGalleryId: fallbackTarget.targetGalleryId || targetGalleryId,
    targetPostNo: fallbackTarget.targetPostNo || targetPostNo,
  };
}

function extractPostTargetFromRawText(rawText) {
  const text = String(rawText || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  const noMatch = text.match(/[?&]no=(\d+)/i);
  const idMatch = text.match(/[?&]id=([^&#]+)/i);
  const mobileBoardMatch = text.match(/\/board\/([^/?#]+)\/(\d+)/i);

  if (mobileBoardMatch) {
    return {
      targetGalleryId: String(mobileBoardMatch[1] || '').trim(),
      targetPostNo: String(mobileBoardMatch[2] || '').trim(),
    };
  }

  return {
    targetGalleryId: idMatch ? String(idMatch[1] || '').trim() : '',
    targetPostNo: noMatch ? String(noMatch[1] || '').trim() : '',
  };
}

function parseCommandComment(comment, commandPrefix) {
  const rawMemo = String(comment?.memo || '').trim();
  const prefix = String(commandPrefix || '').trim();
  const memo = normalizeCommandMemo(rawMemo);

  if (!memo || !prefix || !memo.includes(prefix)) {
    return {
      success: false,
      reason: '명령어 prefix 없음',
    };
  }

  const targetUrl = extractCommandUrl(memo);
  const reasonMatch = memo.match(/사유\s*:\s*(.+)$/);

  if (!targetUrl) {
    return {
      success: false,
      reason: '링크 없음',
    };
  }

  if (!reasonMatch) {
    return {
      success: false,
      reason: '사유 없음',
    };
  }

  const parsedTarget = parseTargetUrl(targetUrl);
  if (!parsedTarget.success) {
    return {
      success: false,
      reason: parsedTarget.message,
    };
  }

  return {
    success: true,
    targetUrl,
    targetPostNo: parsedTarget.targetPostNo,
    targetGalleryId: parsedTarget.targetGalleryId,
    reasonText: reasonMatch[1].trim(),
    depth: Number(comment?.depth || 0),
    commentNo: String(comment?.no || ''),
    requestUserId: String(comment?.user_id || '').trim(),
  };
}

function buildCommandKey(galleryId, targetGalleryId, targetPostNo) {
  return `${targetGalleryId || galleryId}:${targetPostNo}`;
}

function normalizeCommandMemo(memo) {
  return decodeHtml(String(memo || ''))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[「」『』＂]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCommandUrl(memo) {
  const hrefMatches = memo.matchAll(/href\s*=\s*["']([^"']+)["']/ig);
  for (const hrefMatch of hrefMatches) {
    const candidate = sanitizeExtractedUrl(hrefMatch && hrefMatch[1]);
    if (/^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }

  const quotedMatch = memo.match(/["'](https?:\/\/[^"']+)["']/i);
  if (quotedMatch && quotedMatch[1]) {
    return sanitizeExtractedUrl(quotedMatch[1]);
  }

  const rawMatch = memo.match(/https?:\/\/[^\s<>'"“”‘’「」『』]+/i);
  if (rawMatch && rawMatch[0]) {
    return sanitizeExtractedUrl(rawMatch[0]);
  }

  return '';
}

function sanitizeExtractedUrl(value) {
  return String(value || '')
    .trim()
    .replace(/^[\"'“”‘’「」『』＂]+/, '')
    .replace(/[\"'“”‘’「」『』＂),.;!?]+$/, '')
    .trim();
}

function isTrustedUser(comment, trustedUsers) {
  const userId = String(comment?.user_id || '').trim();
  return normalizeTrustedUsers(trustedUsers).find((entry) => entry.userId === userId) || null;
}

function sortCommentsByNo(comments = []) {
  return [...comments].sort((left, right) => Number(left?.no || 0) - Number(right?.no || 0));
}

function extractPostAuthorMeta(html) {
  const htmlText = String(html || '');
  const tagPattern = /<(div|td)[^>]*class="([^"]*)"[^>]*data-loc="view"[^>]*>/ig;
  let match = null;

  while ((match = tagPattern.exec(htmlText)) !== null) {
    const classText = String(match[2] || '');
    if (classText.includes('gall_writer') && classText.includes('ub-writer')) {
      const writerTag = match[0];
      const nickMatch = writerTag.match(/data-nick="([^"]*)"/i);
      const uidMatch = writerTag.match(/data-uid="([^"]*)"/i);
      const ipMatch = writerTag.match(/data-ip="([^"]*)"/i);

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

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function extractPostContentForLlm(html, baseUrl = 'https://gall.dcinside.com') {
  const htmlText = String(html || '');
  const titleHeadMatch = htmlText.match(/<span class="title_headtext">([\s\S]*?)<\/span>/i);
  const titleMatch = htmlText.match(/<span class="title_subject">([\s\S]*?)<\/span>/i);
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

function extractWriteDivHtml(htmlText) {
  const startMatch = htmlText.match(/<div class="write_div"[^>]*>/i);
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
  const imgPattern = /<img[^>]+src="([^"]+)"[^>]*>/ig;
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
    .replace(/<[^>]+>/g, ' ');
}

export {
  buildCommandKey,
  isDeletedComment,
  isTrustedUser,
  normalizeReportTarget,
  normalizeTrustedUsers,
  parseCommandComment,
  parseTargetUrl,
  sortCommentsByNo,
  extractPostAuthorMeta,
  extractPostContentForLlm,
  parseRegularBoardPosts,
  extractRecommendState,
};
