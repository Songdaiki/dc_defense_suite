import { normalizeCommentRefluxMemo, shouldSkip } from '../comment/parser.js';

function parseCollectorPostEntries(html) {
  const entries = [];
  const rowRegex = /<tr class="ub-content[^"]*"[^>]*data-no="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let match;

  while ((match = rowRegex.exec(String(html || ''))) !== null) {
    const no = Number.parseInt(match[1], 10);
    if (!Number.isFinite(no) || no <= 0) {
      continue;
    }

    const rowHtml = match[2];
    const replyMatch = rowHtml.match(/<span class="reply_num">\[(\d+)\]<\/span>/);
    const commentCount = replyMatch ? Number.parseInt(replyMatch[1], 10) || 0 : 0;
    entries.push({
      no,
      commentCount,
    });
  }

  if (entries.length <= 0) {
    const dataNoRegex = /data-no="(\d+)"/g;
    while ((match = dataNoRegex.exec(String(html || ''))) !== null) {
      const no = Number.parseInt(match[1], 10);
      if (!Number.isFinite(no) || no <= 0) {
        continue;
      }
      // 목록 row 구조가 변해서 댓글 수를 읽지 못한 경우엔, collector가 0건으로 끝나지 않도록
      // data-no만 있는 글도 한 번은 댓글 조회 대상으로 태운다.
      entries.push({ no, commentCount: 1 });
    }
  }

  return dedupeCollectorPostEntries(entries);
}

function collectNormalizedCommentRefluxMemos(comments) {
  const memoSet = new Set();
  (Array.isArray(comments) ? comments : []).forEach((comment) => {
    if (shouldSkip(comment)) {
      return;
    }

    const normalizedMemo = normalizeCommentRefluxMemo(comment?.memo);
    if (!normalizedMemo) {
      return;
    }

    memoSet.add(normalizedMemo);
  });

  return [...memoSet];
}

function dedupeCollectorPostEntries(entries) {
  const dedupedEntries = [];
  const seen = new Map();

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const postNo = Number(entry?.no) || 0;
    const commentCount = Math.max(0, Number(entry?.commentCount) || 0);
    if (postNo <= 0) {
      return;
    }

    if (!seen.has(postNo)) {
      seen.set(postNo, dedupedEntries.length);
      dedupedEntries.push({
        no: postNo,
        commentCount,
      });
      return;
    }

    const index = seen.get(postNo);
    dedupedEntries[index].commentCount = Math.max(dedupedEntries[index].commentCount, commentCount);
  });

  return dedupedEntries;
}

export {
  collectNormalizedCommentRefluxMemos,
  parseCollectorPostEntries,
};
