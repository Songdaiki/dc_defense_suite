import { parseBlockListRows, normalizeWriterToken } from '../ip/parser.js';
import { getHanScriptCharCount } from '../post/parser.js';

const PAGE_END_LINK_REGEX = /<a[^>]*(?:class="[^"]*\bpage_end\b[^"]*"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="[^"]*\bpage_end\b[^"]*")/i;
const PAGE_ANCHOR_REGEX = /<a[^>]*href="([^"]*?[?&](?:p|page)=\d+[^"]*)"[^>]*>\s*(\d+)\s*<\/a>/gi;
const CURRENT_PAGE_REGEX = /<(?:em|strong|b|span)[^>]*>\s*1\s*<\/(?:em|strong|b|span)>/i;
const PAGING_BOX_REGEX = /<div[^>]*class="[^"]*(?:\bbottom_paging_box\b[^"]*\biconpaging\b|\biconpaging\b[^"]*\bbottom_paging_box\b)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
const MIN_HAN_CHAR_COUNT = 2;
const MATCH_KIND = {
  HAN_TITLE: 'han_title',
  DOBAE_REASON: 'dobae_reason',
};

function parseDetectedMaxPage(html, fallbackMaxPage = 400) {
  const normalizedFallback = Math.max(1, Number(fallbackMaxPage) || 400);
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

function extractActionableManagementRows(html, options = {}) {
  const rows = parseBlockListRows(html);
  const seenAvoidNos = options.seenAvoidNos instanceof Set
    ? options.seenAvoidNos
    : new Set();
  const maxAllowedBlockDataNum = Number(options.maxAllowedBlockDataNum) || 0;
  const actionableRows = [];

  for (const row of rows) {
    if (!isPostBlockRow(row)) {
      continue;
    }

    if (!row.isActive) {
      continue;
    }

    if (!isIpLikeWriterToken(row.writerToken)) {
      continue;
    }

    const matchKind = getActionableMatchKind(row);
    if (!matchKind) {
      continue;
    }

    const blockDataNum = toBlockDataNum(row.blockDataNum);
    if (maxAllowedBlockDataNum > 0 && blockDataNum > maxAllowedBlockDataNum) {
      continue;
    }

    const avoidNo = toAvoidNo(blockDataNum);
    if (avoidNo <= 0) {
      continue;
    }

    const avoidNoKey = String(avoidNo);
    if (seenAvoidNos.has(avoidNoKey)) {
      continue;
    }

    seenAvoidNos.add(avoidNoKey);
    actionableRows.push({
      ...row,
      avoidNo,
      matchKind,
    });
  }

  return {
    rows,
    actionableRows,
  };
}

function extractMaxBlockDataNum(html) {
  const rows = parseBlockListRows(html);
  let maxBlockDataNum = 0;

  for (const row of rows) {
    const blockDataNum = toBlockDataNum(row.blockDataNum);
    if (blockDataNum > maxBlockDataNum) {
      maxBlockDataNum = blockDataNum;
    }
  }

  return maxBlockDataNum;
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

function isPostBlockRow(row) {
  return /<em>\s*게시글\s*<\/em>/i.test(String(row?.rowHtml || ''));
}

function isIpLikeWriterToken(value) {
  return /^\d+\.\d+$/.test(normalizeWriterToken(value));
}

function getActionableMatchKind(row) {
  if (getHanScriptCharCount(row?.title || '') >= MIN_HAN_CHAR_COUNT) {
    return MATCH_KIND.HAN_TITLE;
  }

  if (hasDobaeReason(row?.reason || '')) {
    return MATCH_KIND.DOBAE_REASON;
  }

  return '';
}

function hasDobaeReason(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  return normalized.includes('도배');
}

function toAvoidNo(blockDataNum) {
  const blockNumber = toBlockDataNum(blockDataNum);
  if (!Number.isFinite(blockNumber) || blockNumber <= 1) {
    return 0;
  }

  return blockNumber - 1;
}

function toBlockDataNum(blockDataNum) {
  const parsed = Number.parseInt(String(blockDataNum || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isLikelyManagementBlockHtml(html) {
  const normalizedHtml = String(html || '');
  return normalizedHtml.includes('해제된 목록은 30일 동안 보관됩니다.')
    || normalizedHtml.includes('blockcontent')
    || normalizedHtml.includes('bottom_paging_box')
    || normalizedHtml.includes('/mgallery/management/block');
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, '\'')
    .trim();
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

export {
  extractActionableManagementRows,
  extractMaxBlockDataNum,
  extractPageNumberFromHref,
  hasDobaeReason,
  isIpLikeWriterToken,
  isLikelyManagementBlockHtml,
  isPostBlockRow,
  MATCH_KIND,
  parseDetectedMaxPage,
  toAvoidNo,
};
