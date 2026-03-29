import { banPosts } from './api.js';
import {
  requestDeleteLimitAccountFallback,
} from '../../background/dc-session-broker.js';

async function executeBanWithDeleteFallback(options = {}) {
  const targetPosts = dedupePostsByNo(options.posts);
  if (targetPosts.length === 0) {
    return {
      successNos: [],
      failedNos: [],
      messages: [],
      deleteLimitFallbackCount: 0,
      banOnlyRetrySuccessCount: 0,
      banOnlyFallbackUsed: false,
      finalDeleteEnabled: Boolean(options.deleteEnabled),
      latestDeleteLimitMessage: '',
    };
  }

  const config = { ...(options.config || {}) };
  const deleteEnabled = Boolean(options.deleteEnabled);
  const feature = String(options.feature || 'ip').trim() || 'ip';
  const onRecordSuccesses = typeof options.onRecordSuccesses === 'function'
    ? options.onRecordSuccesses
    : () => {};
  const onDeleteLimitFallbackSuccess = typeof options.onDeleteLimitFallbackSuccess === 'function'
    ? options.onDeleteLimitFallbackSuccess
    : () => {};
  const onDeleteLimitBanOnlyActivated = typeof options.onDeleteLimitBanOnlyActivated === 'function'
    ? options.onDeleteLimitBanOnlyActivated
    : () => {};

  const postMap = new Map(targetPosts.map((post) => [String(post.no), post]));
  const aggregate = {
    successNos: [],
    failedNos: [],
    messages: [],
    deleteLimitFallbackCount: 0,
    banOnlyRetrySuccessCount: 0,
    banOnlyFallbackUsed: false,
    finalDeleteEnabled: deleteEnabled,
    latestDeleteLimitMessage: '',
  };

  const collectResult = (result, deleteEnabledForResult) => {
    const successNos = dedupePostNos(result?.successNos);
    if (successNos.length > 0) {
      onRecordSuccesses(postMap, successNos, deleteEnabledForResult);
      aggregate.successNos.push(...successNos);
    }
    if (result?.message) {
      aggregate.messages.push(String(result.message));
    }
  };

  const initialResult = await banPosts(
    { ...config, delChk: deleteEnabled },
    targetPosts.map((post) => post.no),
  );
  collectResult(initialResult, deleteEnabled);

  let pendingDeleteLimitNos = dedupePostNos(initialResult.deleteLimitExceededNos);
  aggregate.latestDeleteLimitMessage = String(initialResult.message || '').trim();
  aggregate.failedNos.push(
    ...dedupePostNos(
      (Array.isArray(initialResult.failedNos) ? initialResult.failedNos : [])
        .filter((postNo) => !pendingDeleteLimitNos.includes(String(postNo))),
    ),
  );

  while (aggregate.finalDeleteEnabled && pendingDeleteLimitNos.length > 0) {
    const fallbackResult = await requestDeleteLimitAccountFallback({
      feature,
      reason: 'delete_limit_exceeded',
      message: aggregate.latestDeleteLimitMessage,
    });

    if (!fallbackResult.success) {
      aggregate.finalDeleteEnabled = false;
      aggregate.banOnlyFallbackUsed = true;
      onDeleteLimitBanOnlyActivated(fallbackResult.message || aggregate.latestDeleteLimitMessage);
      break;
    }

    aggregate.deleteLimitFallbackCount += 1;
    onDeleteLimitFallbackSuccess(fallbackResult);
    const retryResult = await banPosts(
      { ...config, delChk: true },
      pendingDeleteLimitNos,
    );
    collectResult(retryResult, true);
    aggregate.latestDeleteLimitMessage = String(retryResult.message || '').trim();

    const retryDeleteLimitNos = dedupePostNos(retryResult.deleteLimitExceededNos);
    aggregate.failedNos.push(
      ...dedupePostNos(
        (Array.isArray(retryResult.failedNos) ? retryResult.failedNos : [])
          .filter((postNo) => !retryDeleteLimitNos.includes(String(postNo))),
      ),
    );
    pendingDeleteLimitNos = retryDeleteLimitNos;
  }

  if (pendingDeleteLimitNos.length > 0 && aggregate.finalDeleteEnabled === false) {
    const retryResult = await banPosts(
      { ...config, delChk: false },
      pendingDeleteLimitNos,
    );
    collectResult(retryResult, false);
    aggregate.failedNos.push(...dedupePostNos(retryResult.failedNos));
    aggregate.banOnlyRetrySuccessCount = dedupePostNos(retryResult.successNos).length;
  } else if (pendingDeleteLimitNos.length > 0) {
    aggregate.failedNos.push(...pendingDeleteLimitNos);
  }

  aggregate.successNos = dedupePostNos(aggregate.successNos);
  aggregate.failedNos = dedupePostNos(aggregate.failedNos);

  return aggregate;
}

function dedupePostsByNo(posts) {
  const uniquePosts = [];
  const seen = new Set();

  for (const post of Array.isArray(posts) ? posts : []) {
    const postNo = String(post?.no || '').trim();
    if (!/^\d+$/.test(postNo) || seen.has(postNo)) {
      continue;
    }

    seen.add(postNo);
    uniquePosts.push(post);
  }

  return uniquePosts;
}

function dedupePostNos(postNos) {
  return [...new Set(
    (Array.isArray(postNos) ? postNos : [])
      .map((postNo) => String(postNo || '').trim())
      .filter((postNo) => /^\d+$/.test(postNo)),
  )];
}

export {
  executeBanWithDeleteFallback,
};
