import { parseBlockListRows, normalizeWriterToken } from '../ip/parser.js';
import { hasHanScriptText } from '../post/parser.js';

const PAGE_END_LINK_REGEX = /<a[^>]*(?:class="[^"]*\bpage_end\b[^"]*"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="[^"]*\bpage_end\b[^"]*")/i;
const PAGE_ANCHOR_REGEX = /<a[^>]*href="([^"]*?[?&](?:p|page)=\d+[^"]*)"[^>]*>\s*(\d+)\s*<\/a>/gi;
const CURRENT_PAGE_REGEX = /<(?:em|strong|b|span)[^>]*>\s*1\s*<\/(?:em|strong|b|span)>/i;
const PAGING_BOX_REGEX = /<div[^>]*class="[^"]*(?:\bbottom_paging_box\b[^"]*\biconpaging\b|\biconpaging\b[^"]*\bbottom_paging_box\b)[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

function parseDetectedMaxPage(html, fallbackMaxPage = 400) {
  const normalizedFallback = Math.max(1, Number(fallbackMaxPage) || 400);
  const rawHtml = String(html || '');
  const decodedHtml = decodeHtmlAttribute(rawHtml);
  const pagingHtml = extractPagingHtml(decodedHtml);
  const pageEndMatch = pagingHtml.match(PAGE_END_LINK_REGEX);

  if (pageEndMatch) {
    const pageFromEndLink = extractPageNumberFromHref(pageEndMatch[1] || pageEndMatch[2]);
    if (pageFromEndLink > 0) {
      return {
        detectedMaxPage: pageFromEndLink,
        source: 'page_end',
      };
    }
  }

  const numericPages = [];
  let pageMatch = null;
  while ((pageMatch = PAGE_ANCHOR_REGEX.exec(pagingHtml)) !== null) {
    const pageNumber = extractPageNumberFromHref(pageMatch[1]) || Number(pageMatch[2]) || 0;
    if (pageNumber > 0) {
      numericPages.push(pageNumber);
    }
  }

  if (numericPages.length > 0) {
    return {
      detectedMaxPage: Math.max(...numericPages),
      source: 'numeric_anchor',
    };
  }

  if (pagingHtml && CURRENT_PAGE_REGEX.test(pagingHtml)) {
    return {
      detectedMaxPage: 1,
      source: 'single_page',
    };
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
  const actionableRows = [];

  for (const row of rows) {
    if (!isPostBlockRow(row)) {
      continue;
    }

    if (!hasHanScriptText(row.title || '')) {
      continue;
    }

    if (!isIpLikeWriterToken(row.writerToken)) {
      continue;
    }

    const avoidNo = toAvoidNo(row.blockDataNum);
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
    });
  }

  return {
    rows,
    actionableRows,
  };
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

function toAvoidNo(blockDataNum) {
  const blockNumber = Number.parseInt(String(blockDataNum || '').trim(), 10);
  if (!Number.isFinite(blockNumber) || blockNumber <= 1) {
    return 0;
  }

  return blockNumber - 1;
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

function extractPagingHtml(decodedHtml) {
  const match = String(decodedHtml || '').match(PAGING_BOX_REGEX);
  return match ? match[1] : '';
}

export {
  extractActionableManagementRows,
  extractPageNumberFromHref,
  isIpLikeWriterToken,
  isLikelyManagementBlockHtml,
  isPostBlockRow,
  parseDetectedMaxPage,
  toAvoidNo,
};
