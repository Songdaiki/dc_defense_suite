import { normalizeCommentMemo } from '../comment/parser.js';
import { normalizeImmediateTitleValue } from './parser.js';

const ATTACK_COMMENT_CLUSTER_MIN_COUNT = 10;
const ATTACK_COMMENT_MIN_NORMALIZED_LENGTH = 6;
const ATTACK_COMMENT_MEMO_PREVIEW_LENGTH = 120;

function normalizeAttackComment(value) {
  return normalizeImmediateTitleValue(normalizeCommentMemo(value))
    .replace(/[a-z]+/g, '')
    .trim();
}

function createAttackCommentSnapshotComments(comments = [], options = {}) {
  const postNo = Math.max(0, Number(options.postNo) || 0);
  const minNormalizedLength = getMinNormalizedLength(options.minNormalizedLength);
  if (postNo <= 0) {
    return [];
  }

  const snapshotComments = [];
  const seenCommentNos = new Set();
  for (const comment of Array.isArray(comments) ? comments : []) {
    const commentNo = String(comment?.no || '').trim();
    if (!commentNo || seenCommentNos.has(commentNo)) {
      continue;
    }

    const normalizedMemo = normalizeAttackComment(comment?.memo);
    if (normalizedMemo.length < minNormalizedLength) {
      continue;
    }

    seenCommentNos.add(commentNo);
    snapshotComments.push({
      postNo,
      no: commentNo,
      ip: String(comment?.ip || '').trim(),
      name: String(comment?.name || comment?.nick || '').trim(),
      memoPreview: normalizeCommentMemo(comment?.memo).slice(0, ATTACK_COMMENT_MEMO_PREVIEW_LENGTH),
      normalizedMemo,
    });
  }

  return snapshotComments;
}

function detectAttackCommentClusters(snapshotEntries = [], options = {}) {
  const minCount = Math.max(
    2,
    Number(options.minCount) || ATTACK_COMMENT_CLUSTER_MIN_COUNT,
  );
  const candidates = buildAttackCommentCandidates(snapshotEntries, options);
  if (candidates.length < minCount) {
    return [];
  }

  const groupMap = new Map();
  for (const candidate of candidates) {
    const groupKey = candidate.normalizedMemo;
    const existing = groupMap.get(groupKey);
    if (existing) {
      existing.push(candidate);
      continue;
    }

    groupMap.set(groupKey, [candidate]);
  }

  const clusters = [];
  for (const comments of groupMap.values()) {
    if (comments.length < minCount) {
      continue;
    }

    const cluster = buildAttackCommentCluster(comments);
    if (cluster.comments.length <= 0) {
      continue;
    }

    clusters.push(cluster);
  }

  clusters.sort((left, right) => {
    if (right.comments.length !== left.comments.length) {
      return right.comments.length - left.comments.length;
    }

    if (right.postCount !== left.postCount) {
      return right.postCount - left.postCount;
    }

    return right.newestPostNo - left.newestPostNo;
  });

  return clusters;
}

function buildAttackCommentCandidates(snapshotEntries = [], options = {}) {
  const minNormalizedLength = getMinNormalizedLength(options.minNormalizedLength);
  const recentActions = options.recentActions || {};
  const candidates = [];
  const seenCommentKeys = new Set();

  for (const entry of Array.isArray(snapshotEntries) ? snapshotEntries : []) {
    const postNo = Math.max(0, Number(entry?.postNo) || 0);
    if (postNo <= 0) {
      continue;
    }

    for (const comment of Array.isArray(entry?.comments) ? entry.comments : []) {
      const commentNo = String(comment?.no || '').trim();
      const normalizedMemo = String(comment?.normalizedMemo || '').trim();
      if (!commentNo || normalizedMemo.length < minNormalizedLength) {
        continue;
      }

      const actionKey = buildAttackCommentActionKey(postNo, commentNo);
      if (seenCommentKeys.has(actionKey)) {
        continue;
      }

      seenCommentKeys.add(actionKey);
      candidates.push({
        postNo,
        no: commentNo,
        ip: String(comment?.ip || '').trim(),
        name: String(comment?.name || '').trim(),
        memoPreview: String(comment?.memoPreview || '').trim(),
        normalizedMemo,
        recentActionSuccess: recentActions[actionKey]?.success === true,
      });
    }
  }

  return candidates;
}

function buildAttackCommentDeletePlanByPostNo(cluster = {}) {
  const plan = new Map();
  for (const comment of Array.isArray(cluster?.comments) ? cluster.comments : []) {
    const postNo = Math.max(0, Number(comment?.postNo) || 0);
    const commentNo = String(comment?.no || '').trim();
    if (postNo <= 0 || !commentNo) {
      continue;
    }

    const postKey = String(postNo);
    const existing = plan.get(postKey);
    if (existing) {
      if (!existing.includes(commentNo)) {
        existing.push(commentNo);
      }
      continue;
    }

    plan.set(postKey, [commentNo]);
  }

  return plan;
}

function buildAttackCommentActionKey(postNo, commentNo) {
  const normalizedPostNo = Math.max(0, Number(postNo) || 0);
  const normalizedCommentNo = String(commentNo || '').trim();
  return `${normalizedPostNo}::${normalizedCommentNo}`;
}

function buildAttackCommentCluster(comments = []) {
  const normalizedMemo = chooseRepresentativeMemo(comments);
  const allComments = comments.slice().sort(compareAttackComments);
  const pendingComments = allComments.filter((comment) => comment.recentActionSuccess !== true);
  const postNos = new Set(pendingComments.map((comment) => String(comment.postNo)));
  return {
    representative: normalizedMemo,
    normalizedMemo,
    comments: pendingComments,
    allComments,
    totalCommentCount: allComments.length,
    recentSuccessCount: allComments.length - pendingComments.length,
    postCount: postNos.size,
    newestPostNo: comments.reduce((maxPostNo, comment) => Math.max(maxPostNo, Number(comment.postNo) || 0), 0),
  };
}

function compareAttackComments(left, right) {
  if (right.postNo !== left.postNo) {
    return right.postNo - left.postNo;
  }

  return (Number(right.no) || 0) - (Number(left.no) || 0);
}

function chooseRepresentativeMemo(comments = []) {
  const counts = new Map();
  for (const comment of comments) {
    const normalizedMemo = String(comment?.normalizedMemo || '').trim();
    if (!normalizedMemo) {
      continue;
    }

    const existing = counts.get(normalizedMemo);
    if (existing) {
      existing.count += 1;
      existing.maxPostNo = Math.max(existing.maxPostNo, Number(comment?.postNo) || 0);
      continue;
    }

    counts.set(normalizedMemo, {
      normalizedMemo,
      count: 1,
      maxPostNo: Number(comment?.postNo) || 0,
    });
  }

  const [first] = [...counts.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    if (right.normalizedMemo.length !== left.normalizedMemo.length) {
      return right.normalizedMemo.length - left.normalizedMemo.length;
    }

    return right.maxPostNo - left.maxPostNo;
  });

  return first?.normalizedMemo || '';
}

function getMinNormalizedLength(value) {
  return Math.max(1, Number(value) || ATTACK_COMMENT_MIN_NORMALIZED_LENGTH);
}

export {
  ATTACK_COMMENT_CLUSTER_MIN_COUNT,
  ATTACK_COMMENT_MEMO_PREVIEW_LENGTH,
  ATTACK_COMMENT_MIN_NORMALIZED_LENGTH,
  buildAttackCommentActionKey,
  buildAttackCommentCandidates,
  buildAttackCommentDeletePlanByPostNo,
  createAttackCommentSnapshotComments,
  detectAttackCommentClusters,
  normalizeAttackComment,
};
