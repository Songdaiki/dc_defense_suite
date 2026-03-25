const PAGE_END_LINK_REGEX = /<a[^>]*(?:class="[^"]*\bpage_end\b[^"]*"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="[^"]*\bpage_end\b[^"]*")/i;
const PAGE_ANCHOR_REGEX = /<a[^>]*href="([^"]*?[?&](?:p|page)=\d+[^"]*)"[^>]*>\s*(\d+)\s*<\/a>/gi;
const CURRENT_PAGE_REGEX = /<(?:em|strong|b|span)[^>]*>\s*1\s*<\/(?:em|strong|b|span)>/i;
const PAGING_BOX_REGEX = /<div[^>]*class="[^"]*(?:\bbottom_paging_box\b[^"]*\biconpaging\b|\biconpaging\b[^"]*\bbottom_paging_box\b)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

function parseConceptListPosts(html, limit = 20) {
  return parseConceptListPagePosts(html).slice(0, Math.max(0, Number(limit) || 0));
}

function parseConceptListPagePosts(html) {
  const results = [];
  const seen = new Set();
  const rowPattern = /<tr[^>]*class="[^"]*ub-content[^"]*"[^>]*>([\s\S]*?)<\/tr>/ig;
  let match = null;

  while ((match = rowPattern.exec(String(html || ''))) !== null) {
    const rowHtml = String(match[1] || '');
    const postNo = extractPostNo(rowHtml);
    if (!postNo) {
      continue;
    }

    const currentHead = extractCurrentHead(rowHtml);
    if (isExcludedBoardHead(currentHead) || seen.has(postNo)) {
      continue;
    }

    seen.add(postNo);
    results.push({
      no: postNo,
      currentHead,
      subject: extractSubject(rowHtml),
      rowHtml,
    });
  }

  return results;
}

function parseBoardRecommendSnapshot(html) {
  const results = [];
  const seen = new Set();
  const rowPattern = /<tr[^>]*class="[^"]*ub-content[^"]*"[^>]*>([\s\S]*?)<\/tr>/ig;
  let match = null;

  while ((match = rowPattern.exec(String(html || ''))) !== null) {
    const rowHtml = String(match[1] || '');
    const postNo = extractPostNo(rowHtml);
    if (!postNo || seen.has(postNo)) {
      continue;
    }

    const currentHead = extractCurrentHead(rowHtml);
    if (isExcludedBoardHead(currentHead)) {
      continue;
    }

    const recommendCount = extractRecommendCount(rowHtml);
    if (!Number.isInteger(recommendCount) || recommendCount < 0) {
      continue;
    }

    seen.add(postNo);
    results.push({
      no: postNo,
      currentHead,
      subject: extractSubject(rowHtml),
      recommendCount,
    });
  }

  return results;
}

function parseConceptListDetectedMaxPage(html, fallbackMaxPage = 1) {
  const normalizedFallback = Math.max(1, Number(fallbackMaxPage) || 1);
  const rawHtml = String(html || '');
  const decodedHtml = decodeHtmlAttribute(rawHtml);
  const pagingHtmlCandidates = extractPagingHtmlCandidates(decodedHtml);

  for (const pagingHtml of pagingHtmlCandidates) {
    const pageEndMatch = pagingHtml.match(PAGE_END_LINK_REGEX);
    if (!pageEndMatch) {
      continue;
    }

    const pageFromEndLink = extractPageNumberFromHref(pageEndMatch[1] || pageEndMatch[2]);
    if (pageFromEndLink > 0) {
      return {
        detectedMaxPage: pageFromEndLink,
        source: 'page_end',
      };
    }
  }

  let maxNumericPage = 0;
  for (const pagingHtml of pagingHtmlCandidates) {
    PAGE_ANCHOR_REGEX.lastIndex = 0;
    let pageMatch = null;
    while ((pageMatch = PAGE_ANCHOR_REGEX.exec(pagingHtml)) !== null) {
      const pageNumber = extractPageNumberFromHref(pageMatch[1]) || Number(pageMatch[2]) || 0;
      if (pageNumber > maxNumericPage) {
        maxNumericPage = pageNumber;
      }
    }
  }

  if (maxNumericPage > 0) {
    return {
      detectedMaxPage: maxNumericPage,
      source: 'numeric_anchor',
    };
  }

  for (const pagingHtml of pagingHtmlCandidates) {
    if (pagingHtml && CURRENT_PAGE_REGEX.test(pagingHtml)) {
      return {
        detectedMaxPage: 1,
        source: 'single_page',
      };
    }
  }

  return {
    detectedMaxPage: normalizedFallback,
    source: 'fallback',
  };
}

function extractConceptPostMetrics(html, options = {}) {
  const htmlText = String(html || '');
  const postNoHint = String(options.postNoHint || '').trim();
  const recommendState = extractInputValueById(htmlText, 'recommend');
  const legacyCounts = extractLegacyRecommendCounts(htmlText);
  const fallbackCounts = legacyCounts ? null : extractTextFallbackRecommendCounts(htmlText);
  const counts = legacyCounts || fallbackCounts;
  const debugSummary = buildConceptViewDebugSummary(htmlText);

  if (!counts) {
    return {
      success: false,
      message: '총 추천 수를 찾지 못했습니다.',
      debugSummary,
    };
  }

  let normalizedRecommendState = recommendState === null
    ? ''
    : String(recommendState).trim();
  const recommendStateInferred = recommendState === null && options.assumeConcept === true;
  if (recommendStateInferred) {
    normalizedRecommendState = 'K';
  }

  if (recommendState === null && !recommendStateInferred) {
    return {
      success: false,
      message: '게시물 recommend 상태를 찾지 못했습니다.',
      debugSummary,
    };
  }

  const totalRecommendCount = counts.totalRecommendCount;
  const fixedNickRecommendCount = counts.fixedNickRecommendCount;

  if (!Number.isInteger(totalRecommendCount) || totalRecommendCount < 0) {
    return {
      success: false,
      message: '총 추천 수 파싱 실패',
      debugSummary,
    };
  }

  if (!Number.isInteger(fixedNickRecommendCount) || fixedNickRecommendCount < 0) {
    return {
      success: false,
      message: '고정닉 추천 수 파싱 실패',
      debugSummary,
    };
  }

  const postNo = String(counts.postNo || postNoHint).trim();

  return {
    success: true,
    postNo,
    recommendState: normalizedRecommendState,
    isConcept: normalizedRecommendState === 'K',
    totalRecommendCount,
    fixedNickRecommendCount,
    recommendStateInferred,
    countSource: legacyCounts ? 'legacy' : 'text',
  };
}

function extractLegacyRecommendCounts(htmlText) {
  const totalMatch = String(htmlText || '').match(/id=["']recommend_view_up_(\d+)["'][^>]*>([\s\S]*?)<\/p>/i);
  const fixedMatch = String(htmlText || '').match(/id=["']recommend_view_up_fix_(\d+)["'][^>]*>([\s\S]*?)<\/span>/i);
  if (!totalMatch || !fixedMatch) {
    return null;
  }

  return {
    postNo: String(totalMatch[1] || fixedMatch[1] || '').trim(),
    totalRecommendCount: parseCountText(totalMatch[2]),
    fixedNickRecommendCount: parseCountText(fixedMatch[2]),
  };
}

function extractTextFallbackRecommendCounts(htmlText) {
  const normalizedText = normalizeText(
    String(htmlText || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
  const match = normalizedText.match(/추천 비추천\s*([\d,]+)(?:\s+\S+){0,8}\s+고정닉\s*([\d,]+)/);
  if (!match) {
    return null;
  }

  return {
    postNo: '',
    totalRecommendCount: parseCountText(match[1]),
    fixedNickRecommendCount: parseCountText(match[2]),
  };
}

function extractInputValueById(htmlText, inputId) {
  const inputPattern = new RegExp(`<input[^>]*id=["']${escapeRegExp(inputId)}["'][^>]*>`, 'i');
  const inputMatch = String(htmlText || '').match(inputPattern);
  if (!inputMatch) {
    return null;
  }

  const valueMatch = String(inputMatch[0]).match(/value=["']([^"']*)["']/i);
  if (!valueMatch) {
    return '';
  }

  return valueMatch[1];
}

function extractPostNo(rowHtml) {
  const match = String(rowHtml || '').match(/<td[^>]*class="gall_num[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!match) {
    return '';
  }

  const value = normalizeText(String(match[1] || '').replace(/<[^>]+>/g, ' '));
  return /^\d+$/.test(value) ? value : '';
}

function extractSubject(rowHtml) {
  const match = String(rowHtml || '').match(/<td[^>]*class="gall_tit[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!match) {
    return '';
  }

  return normalizeText(
    String(match[1] || '')
      .replace(/<em[^>]*class="icon_[^"]*"[\s\S]*?<\/em>/gi, ' ')
      .replace(/<span[^>]*class="reply_num"[\s\S]*?<\/span>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function extractCurrentHead(rowHtml) {
  const match = String(rowHtml || '').match(/<td[^>]*class="gall_subject[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!match) {
    return '';
  }

  return normalizeText(
    String(match[1] || '')
      .replace(/<p[^>]*class="subject_inner"[\s\S]*?<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s*,\s*/g, ',')
    .replace(/,+$/g, '');
}

function extractRecommendCount(rowHtml) {
  const match = String(rowHtml || '').match(/<td[^>]*class="gall_recommend[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  if (!match) {
    return NaN;
  }

  return parseCountText(match[1]);
}

function isExcludedBoardHead(currentHead) {
  const normalized = String(currentHead || '').replace(/\s+/g, ' ').trim();
  return normalized === '공지' || normalized === '설문';
}

function parseCountText(text) {
  const normalized = normalizeText(String(text || '').replace(/<[^>]+>/g, ' ')).replace(/,/g, '');
  if (!/^-?\d+$/.test(normalized)) {
    return NaN;
  }
  return parseInt(normalized, 10);
}

function normalizeText(text) {
  return decodeHtml(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function decodeHtmlAttribute(value) {
  return decodeHtml(String(value || '')).trim();
}

function extractPagingHtmlCandidates(decodedHtml) {
  const candidates = [];
  const html = String(decodedHtml || '');
  let match = null;

  PAGING_BOX_REGEX.lastIndex = 0;
  while ((match = PAGING_BOX_REGEX.exec(html)) !== null) {
    candidates.push(match[1] || '');
  }

  return candidates;
}

function extractPageNumberFromHref(rawHref) {
  const href = decodeHtmlAttribute(rawHref);
  if (!href) {
    return 0;
  }

  try {
    const parsed = new URL(href, 'https://gall.dcinside.com');
    const pageValue = parsed.searchParams.get('p') || parsed.searchParams.get('page') || '';
    const pageNumber = Number.parseInt(pageValue, 10);
    return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 0;
  } catch (_error) {
    return 0;
  }
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildConceptViewDebugSummary(htmlText) {
  const normalizedText = normalizeText(
    String(htmlText || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
  const preview = normalizedText.slice(0, 120);

  return [
    `recommendInput=${hasText(htmlText, 'id="recommend"') || hasText(htmlText, "id='recommend'")}`,
    `legacyTotal=${/id=["']recommend_view_up_/i.test(htmlText)}`,
    `legacyFixed=${/id=["']recommend_view_up_fix_/i.test(htmlText)}`,
    `textVote=${normalizedText.includes('추천 비추천')}`,
    `textFixed=${normalizedText.includes('고정닉')}`,
    `textConcept=${normalizedText.includes('개념 추천')}`,
    `preview=${preview || '<empty>'}`,
  ].join(', ');
}

function hasText(text, pattern) {
  return String(text || '').includes(pattern);
}

export {
  extractConceptPostMetrics,
  extractPageNumberFromHref,
  parseBoardRecommendSnapshot,
  parseConceptListDetectedMaxPage,
  parseConceptListPagePosts,
  parseConceptListPosts,
};
