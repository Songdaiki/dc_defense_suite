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
    const reportPostNo = String(url.searchParams.get('no') || '').trim();
    const targetGalleryId = String(url.searchParams.get('id') || '').trim();

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
  const rawValue = String(targetUrl || '').trim();
  if (!rawValue) {
    return {
      success: false,
      message: '대상 링크가 비어 있습니다.',
    };
  }

  try {
    const url = new URL(rawValue);
    const targetPostNo = String(url.searchParams.get('no') || '').trim();
    const targetGalleryId = String(url.searchParams.get('id') || '').trim();

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
    return {
      success: false,
      message: '대상 링크 형식이 올바르지 않습니다.',
    };
  }
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
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCommandUrl(memo) {
  const hrefMatch = memo.match(/href\s*=\s*["']([^"']+)["']/i);
  if (hrefMatch && hrefMatch[1]) {
    return hrefMatch[1].trim();
  }

  const quotedMatch = memo.match(/["'](https?:\/\/[^"']+)["']/i);
  if (quotedMatch && quotedMatch[1]) {
    return quotedMatch[1].trim();
  }

  const rawMatch = memo.match(/https?:\/\/[^\s<>'"]+/i);
  if (rawMatch && rawMatch[0]) {
    return rawMatch[0].trim();
  }

  return '';
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

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
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
};
