import { withDcRequestLease } from '../../background/dc-session-broker.js';
import { extractEsno, fetchComments } from '../comment/api.js';

const DEFAULT_CONFIG = {
  galleryId: 'thesingularity',
  galleryType: 'M',
  baseUrl: 'https://gall.dcinside.com',
  submitMode: 'member',
  postNo: '',
  memo: '처리완료',
  replyNo: '',
  name: 'ㅇㅇ',
  password: '',
  gallNickName: 'ㅇㅇ',
  useGallNick: 'N',
  recommend: 0,
};

const COMMENT_SUBMIT_PATH = '/board/forms/comment_submit';
const TAB_LOAD_TIMEOUT_MS = 15000;
const CAPTCHA_READY_TIMEOUT_MS = 5000;
const CAPTCHA_READY_INTERVAL_MS = 150;

function resolveConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
  };
}

function normalizeConfig(config = {}) {
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    submitMode: normalizeSubmitMode(config.submitMode),
    postNo: normalizePostNo(config.postNo),
    memo: normalizeMemo(config.memo || DEFAULT_CONFIG.memo),
    replyNo: normalizeReplyNo(config.replyNo),
    name: normalizeDisplayName(config.name || DEFAULT_CONFIG.name),
    password: String(config.password || '').trim(),
    gallNickName: normalizeDisplayName(config.gallNickName || DEFAULT_CONFIG.gallNickName),
    useGallNick: normalizeUseGallNick(config.useGallNick),
    recommend: normalizeRecommend(config.recommend),
  };
}

function normalizePostNo(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function normalizeReplyNo(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function normalizeMemo(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function normalizeDisplayName(value) {
  const normalized = String(value || '').trim();
  return normalized || 'ㅇㅇ';
}

function normalizeChallengeCode(value) {
  return String(value || '').trim();
}

function normalizeUseGallNick(value) {
  return String(value || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N';
}

function normalizeRecommend(value) {
  return Number.parseInt(String(value || 0), 10) === 1 ? 1 : 0;
}

function normalizeSubmitMode(value) {
  return String(value || '').trim().toLowerCase() === 'anonymous'
    ? 'anonymous'
    : 'member';
}

function normalizeMemberDivision(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeCurrentUnixTime(value) {
  const normalized = String(value || '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function resolveRequest(config = {}, options = {}) {
  const resolved = normalizeConfig(resolveConfig(config));
  return {
    resolved,
    submitMode: normalizeSubmitMode(options.submitMode ?? resolved.submitMode),
    postNo: normalizePostNo(options.postNo ?? resolved.postNo),
    memo: normalizeMemo(options.memo ?? resolved.memo),
    replyNo: normalizeReplyNo(options.replyNo ?? resolved.replyNo),
    requestedName: normalizeDisplayName(options.name ?? resolved.name),
    requestedPassword: String(options.password ?? resolved.password ?? '').trim(),
    requestedCode: normalizeChallengeCode(options.code ?? ''),
    requestedGallNickName: normalizeDisplayName(
      options.gallNickName ?? resolved.gallNickName ?? resolved.name,
    ),
    recommend: normalizeRecommend(options.recommend ?? resolved.recommend),
    signal: options.signal,
  };
}

function buildValidationFailure(postNo, message) {
  return {
    success: false,
    postNo: String(postNo || '').trim(),
    message,
    failureType: 'validation',
  };
}

function getRequestValidationFailure(request) {
  if (!request.postNo) {
    return buildValidationFailure('', '게시물 번호는 숫자만 입력하세요.');
  }

  if (!request.memo) {
    return buildValidationFailure(request.postNo, '댓글 문구를 입력하세요.');
  }

  if (request.submitMode === 'anonymous' && String(request.requestedPassword || '').trim().length < 2) {
    return buildValidationFailure(request.postNo, '유동/비회원 테스트 비밀번호는 2자 이상 입력하세요.');
  }

  return null;
}

async function submitComment(config = {}, options = {}) {
  const request = resolveRequest(config, options);
  const validationFailure = getRequestValidationFailure(request);
  if (validationFailure) {
    return validationFailure;
  }

  if (request.submitMode === 'anonymous') {
    const prepared = await prepareAnonymousManualChallenge(request.resolved, {
      postNo: request.postNo,
      signal: request.signal,
      requestedName: request.requestedName,
    });

    if (!prepared?.success) {
      return prepared;
    }

    if (prepared.challenge?.requiresCode && !request.requestedCode) {
      await cancelManualChallenge(prepared.challenge);
      return {
        success: false,
        postNo: request.postNo,
        message: '이 글은 댓글 인증코드가 필요한 상태입니다. 토글 ON 뒤 표시된 이미지를 보고 코드를 입력해 제출하세요.',
        failureType: 'challenge_required',
      };
    }

    return submitPreparedAnonymousChallenge(request.resolved, prepared.challenge, {
      postNo: request.postNo,
      memo: request.memo,
      replyNo: request.replyNo,
      name: request.requestedName,
      password: request.requestedPassword,
      code: request.requestedCode,
      gallNickName: request.requestedGallNickName,
      recommend: request.recommend,
      signal: request.signal,
      closeTab: true,
    });
  }

  return submitMemberComment(request);
}

async function submitMemberComment(request) {
  return withDcRequestLease({ feature: 'sinmungoComment', kind: 'submitComment' }, async () => {
    const beforeHtml = await fetchPostPageHtml(request.resolved, request.postNo, request.signal);
    const tokens = extractCommentSubmitTokens(beforeHtml);
    const memberDivision = normalizeMemberDivision(tokens.memberDivision);
    const requiresChallengeCode = String(tokens.commentCodeRequired || '').trim().toUpperCase() === 'Y';
    const pageHasAnonymousCommentForm = memberDivision === 'N';
    const memberName = extractCommentAuthorName(beforeHtml);
    const missingTokenKeys = getMissingRequiredTokenKeys(tokens);

    if (!memberName) {
      missingTokenKeys.push('user_nick_label');
    }

    if (missingTokenKeys.length > 0) {
      return {
        success: false,
        postNo: request.postNo,
        message: `댓글 작성 토큰 추출 실패: ${missingTokenKeys.join(', ')}`,
        failureType: 'spec',
      };
    }

    if (pageHasAnonymousCommentForm) {
      return {
        success: false,
        postNo: request.postNo,
        message: buildCommentModeMismatchMessage('member', requiresChallengeCode),
        failureType: 'mode_mismatch',
      };
    }

    const beforeComments = await fetchCommentsSnapshot(
      request.resolved,
      request.postNo,
      beforeHtml,
      request.signal,
    );
    const beforeCommentNos = createCommentNoSet(beforeComments.comments);
    const currentUnixTime = normalizeCurrentUnixTime(tokens.currentUnixTime)
      || String(Math.floor(Date.now() / 1000));
    const requestBody = buildMemberSubmitBody({
      galleryId: request.resolved.galleryId,
      galleryType: tokens.galleryType || request.resolved.galleryType,
      postNo: request.postNo,
      replyNo: request.replyNo,
      memo: request.memo,
      memberName,
      currentUnixTime,
      tokens,
      recommend: request.recommend,
    });

    let response = null;
    let responseText = '';
    let postTransportError = null;

    try {
      const submitResult = await submitCommentViaPageContext(
        request.resolved,
        request.postNo,
        requestBody.toString(),
        request.signal,
      );
      response = {
        status: Number(submitResult?.status || 0),
        ok: Boolean(submitResult?.ok),
      };
      responseText = String(submitResult?.responseText || '');
      const failureType = inferCommentSubmitFailureType(response, responseText);
      if (failureType) {
        return {
          success: false,
          postNo: request.postNo,
          message: buildFailureMessage(response, responseText, failureType),
          failureType,
          responseText,
        };
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
      postTransportError = error;
    }

    return verifySubmittedComment({
      resolvedConfig: request.resolved,
      postNo: request.postNo,
      memo: request.memo,
      beforeCommentNos,
      responseText,
      postTransportError,
      signal: request.signal,
    });
  });
}

async function prepareAnonymousManualChallenge(config = {}, options = {}) {
  const resolved = normalizeConfig(resolveConfig(config));
  const postNo = normalizePostNo(options.postNo ?? resolved.postNo);
  const signal = options.signal;
  const requestedName = normalizeDisplayName(options.requestedName ?? resolved.name);
  if (!postNo) {
    return buildValidationFailure('', '게시물 번호는 숫자만 입력하세요.');
  }

  throwIfAborted(signal);
  const targetUrl = `${resolved.baseUrl}/mgallery/board/view/?id=${resolved.galleryId}&no=${postNo}&page=1`;
  const createdTab = await chrome.tabs.create({
    url: targetUrl,
    active: false,
  });
  const tabId = Math.max(0, Number(createdTab?.id) || 0);
  let keepPreparedTab = false;
  if (tabId <= 0) {
    return {
      success: false,
      postNo,
      message: '유동 댓글 준비용 디시 탭을 만들지 못했습니다.',
      failureType: 'tab_create',
    };
  }

  try {
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    throwIfAborted(signal);

    const formState = await readAnonymousCommentFormFromPage(resolved, tabId, postNo);
    if (!formState?.ok) {
      return {
        success: false,
        postNo,
        message: String(formState?.message || '유동 댓글 폼을 읽지 못했습니다.'),
        failureType: String(formState?.failureType || 'spec'),
      };
    }

    const memberDivision = normalizeMemberDivision(formState.memberDivision);
    const requiresCode = String(formState.commentCodeRequired || '').trim().toUpperCase() === 'Y';
    if (memberDivision && memberDivision !== 'N') {
      return {
        success: false,
        postNo,
        message: buildCommentModeMismatchMessage('anonymous', requiresCode),
        failureType: 'mode_mismatch',
      };
    }

    if (requiresCode && !String(formState.captchaImageUrl || '').trim()) {
      return {
        success: false,
        postNo,
        message: '댓글 인증코드 이미지를 live DOM에서 준비하지 못했습니다. 다시 시도하세요.',
        failureType: 'captcha_prepare',
      };
    }

    const useGallNick = normalizeUseGallNick(formState.useGallNick || resolved.useGallNick);
    const gallNickName = normalizeDisplayName(
      formState.gallNickName
      || resolved.gallNickName
      || requestedName,
    );
    const anonymousName = normalizeDisplayName(
      formState.anonymousName
      || requestedName
      || gallNickName,
    );
    const preparedAt = new Date().toISOString();
    const challenge = {
      challengeId: createChallengeId(),
      tabId,
      tabUrl: String(formState.tabUrl || targetUrl),
      postNo,
      galleryId: String(formState.galleryId || resolved.galleryId).trim() || resolved.galleryId,
      galleryType: String(formState.galleryType || resolved.galleryType).trim() || resolved.galleryType,
      baseUrl: resolved.baseUrl,
      preparedAt,
      captchaImageUrl: String(formState.captchaImageUrl || '').trim(),
      requiresCode,
      useGallNick,
      gallNickName,
      anonymousName,
      anonymousNameVisible: Boolean(formState.anonymousNameVisible),
      nameEditable: useGallNick !== 'Y',
      passwordRequired: Boolean(formState.passwordRequired),
      passwordMinLength: Boolean(formState.passwordRequired) ? 2 : 0,
    };
    keepPreparedTab = true;

    return {
      success: true,
      postNo,
      challenge,
      requiresManualCode: requiresCode,
      message: requiresCode
        ? '유동 댓글 인증코드 이미지를 준비했습니다.'
        : '유동 댓글 폼을 준비했습니다. 인증코드 없이 바로 제출할 수 있습니다.',
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    return {
      success: false,
      postNo,
      message: String(error?.message || '유동 댓글 준비 중 알 수 없는 오류가 발생했습니다.'),
      failureType: 'prepare_error',
    };
  } finally {
    if (signal?.aborted || !keepPreparedTab) {
      await removeTabQuietly(tabId);
    }
  }
}

async function refreshAnonymousManualChallenge(config = {}, challenge = {}, options = {}) {
  await cancelManualChallenge(challenge);
  return prepareAnonymousManualChallenge(config, options);
}

async function cancelManualChallenge(challenge = {}) {
  const tabId = Number(challenge?.tabId || 0);
  if (tabId > 0) {
    await removeTabQuietly(tabId);
  }
}

async function submitPreparedAnonymousChallenge(config = {}, challenge = {}, options = {}) {
  const resolved = normalizeConfig(resolveConfig({
    ...config,
    galleryId: challenge.galleryId || config.galleryId,
    galleryType: challenge.galleryType || config.galleryType,
    baseUrl: challenge.baseUrl || config.baseUrl,
  }));
  const postNo = normalizePostNo(options.postNo ?? challenge.postNo ?? resolved.postNo);
  const memo = normalizeMemo(options.memo ?? resolved.memo);
  const replyNo = normalizeReplyNo(options.replyNo ?? resolved.replyNo);
  const requestedName = normalizeDisplayName(options.name ?? resolved.name);
  const requestedPassword = String(options.password ?? resolved.password ?? '').trim();
  const requestedCode = normalizeChallengeCode(options.code ?? '');
  const recommend = normalizeRecommend(options.recommend ?? resolved.recommend);
  const signal = options.signal;
  const closeTab = options.closeTab !== false;
  const validationFailure = getRequestValidationFailure({
    postNo,
    memo,
    submitMode: 'anonymous',
    requestedPassword,
  });
  if (validationFailure) {
    if (closeTab) {
      await cancelManualChallenge(challenge);
    }
    return validationFailure;
  }

  const tabValidation = await ensureChallengeTabUsable(challenge, resolved, postNo, signal);
  if (!tabValidation.ok) {
    if (closeTab) {
      await cancelManualChallenge(challenge);
    }
    return {
      success: false,
      postNo,
      message: tabValidation.message,
      failureType: tabValidation.failureType,
    };
  }

  try {
    return await withDcRequestLease({ feature: 'sinmungoComment', kind: 'submitPreparedAnonymousChallenge' }, async () => {
      const beforeHtml = await fetchPostPageHtml(resolved, postNo, signal);
      const beforeComments = await fetchCommentsSnapshot(resolved, postNo, beforeHtml, signal);
      const beforeCommentNos = createCommentNoSet(beforeComments.comments);

      const submitResult = await submitPreparedAnonymousCommentViaPageContext(
        resolved,
        tabValidation.tabId,
        postNo,
        {
          memo,
          replyNo,
          name: requestedName,
          password: requestedPassword,
          code: requestedCode,
          recommend,
        },
        signal,
      );

      const response = {
        status: Number(submitResult?.status || 0),
        ok: Boolean(submitResult?.ok),
      };
      const responseText = String(submitResult?.responseText || '');
      const failureType = submitResult?.failureType
        || inferCommentSubmitFailureType(response, responseText);
      if (failureType) {
        return {
          success: false,
          postNo,
          message: buildFailureMessage(response, responseText, failureType),
          failureType,
          responseText,
        };
      }

      return verifySubmittedComment({
        resolvedConfig: resolved,
        postNo,
        memo,
        beforeCommentNos,
        responseText,
        postTransportError: null,
        signal,
      });
    });
  } finally {
    if (closeTab) {
      await cancelManualChallenge(challenge);
    }
  }
}

async function verifySubmittedComment({
  resolvedConfig,
  postNo,
  memo,
  beforeCommentNos,
  responseText,
  postTransportError,
  signal,
}) {
  const responseCommentNo = parseCommentSubmitSuccessCommentNo(responseText);
  if (responseCommentNo) {
    let verifyMessageSuffix = '';

    try {
      const afterHtml = await fetchPostPageHtml(resolvedConfig, postNo, signal);
      const afterComments = await fetchCommentsSnapshot(resolvedConfig, postNo, afterHtml, signal);
      const normalizedTargetMemo = normalizeMemo(memo);
      const matchedComment = (afterComments.comments || []).find((comment) => {
        const commentNo = getCommentNo(comment);
        if (commentNo === responseCommentNo) {
          return true;
        }
        return normalizeMemo(getCommentMemo(comment)) === normalizedTargetMemo;
      });
      if (matchedComment) {
        return {
          success: true,
          postNo,
          memo,
          commentNo: getCommentNo(matchedComment) || responseCommentNo,
          verifiedAt: new Date().toISOString(),
          message: `댓글 등록 응답에서 댓글 번호 ${responseCommentNo}를 받았고 목록 재조회도 확인했습니다.`,
          responseText,
        };
      }
      verifyMessageSuffix = ' 목록 재조회에서는 아직 같은 댓글을 확인하지 못했지만, 서버 응답상 등록은 성공입니다.';
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
      verifyMessageSuffix = ` 목록 재조회는 건너뛰었습니다. (${error.message})`;
    }

    return {
      success: true,
      postNo,
      memo,
      commentNo: responseCommentNo,
      verifiedAt: new Date().toISOString(),
      message: `댓글 등록 응답에서 댓글 번호 ${responseCommentNo}를 받았습니다.${verifyMessageSuffix}`,
      responseText,
    };
  }

  const afterHtml = await fetchPostPageHtml(resolvedConfig, postNo, signal);
  const afterComments = await fetchCommentsSnapshot(resolvedConfig, postNo, afterHtml, signal);
  const normalizedTargetMemo = normalizeMemo(memo);
  const candidateNewComments = (afterComments.comments || []).filter((comment) => {
    const commentNo = getCommentNo(comment);
    return commentNo && !beforeCommentNos.has(commentNo);
  });
  const newlyDetectedComment = candidateNewComments.find(
    (comment) => normalizeMemo(getCommentMemo(comment)) === normalizedTargetMemo,
  );

  if (newlyDetectedComment) {
    return {
      success: true,
      postNo,
      memo,
      commentNo: getCommentNo(newlyDetectedComment),
      verifiedAt: new Date().toISOString(),
      message: postTransportError
        ? '댓글 응답 수신은 실패했지만, 목록 재조회에서 동일 문구 댓글 생성을 확인했습니다.'
        : (summarizeResponseText(responseText) || '댓글 등록 후 목록 재조회까지 확인했습니다.'),
      responseText,
    };
  }

  if (postTransportError) {
    return {
      success: false,
      postNo,
      message: `댓글 요청 응답을 받지 못했고, 목록 재조회에서도 동일 문구 댓글을 확인하지 못했습니다. (${postTransportError.message})`,
      failureType: 'network_verify',
      responseText,
    };
  }

  if (candidateNewComments.length > 0) {
    return {
      success: false,
      postNo,
      message: buildVerifyFailureMessage(
        '새 댓글은 감지됐지만 요청한 문구와 일치하는 댓글이 확인되지 않아 성공으로 확정하지 않았습니다.',
        responseText,
      ),
      failureType: 'verify',
      responseText,
    };
  }

  return {
    success: false,
    postNo,
    message: buildVerifyFailureMessage(
      '댓글 요청은 전송됐지만 새 댓글이 목록에서 확인되지 않았습니다.',
      responseText,
    ),
    failureType: 'verify',
    responseText,
  };
}

async function fetchCommentsSnapshot(resolvedConfig, postNo, html, signal) {
  const esno = extractEsno(html);
  if (!esno) {
    return {
      esno: '',
      comments: [],
    };
  }

  const commentsResult = await fetchComments({
    galleryId: resolvedConfig.galleryId,
    galleryType: resolvedConfig.galleryType,
    baseUrl: resolvedConfig.baseUrl,
  }, postNo, esno, 1, { signal });

  return {
    esno,
    comments: Array.isArray(commentsResult?.comments) ? commentsResult.comments : [],
  };
}

async function fetchPostPageHtml(resolvedConfig, postNo, signal) {
  const url = `${resolvedConfig.baseUrl}/mgallery/board/view/?id=${resolvedConfig.galleryId}&no=${postNo}`;
  const response = await dcFetchWithRetry(url, {
    method: 'GET',
    headers: {
      Referer: `${resolvedConfig.baseUrl}/mgallery/board/lists/?id=${resolvedConfig.galleryId}`,
    },
    signal,
  });
  const html = await response.text();
  if (html.includes('정상적인 접근이 아닙니다')) {
    throw new Error('게시물 페이지 접근 차단 응답을 받았습니다.');
  }
  return html;
}

async function submitCommentViaPageContext(resolvedConfig, postNo, requestBody, signal) {
  throwIfAborted(signal);

  const targetUrl = `${resolvedConfig.baseUrl}/mgallery/board/view/?id=${resolvedConfig.galleryId}&no=${postNo}&page=1`;
  const createdTab = await chrome.tabs.create({
    url: targetUrl,
    active: false,
  });
  const tabId = Math.max(0, Number(createdTab?.id) || 0);
  if (tabId <= 0) {
    throw new Error('댓글 등록용 디시 탭을 만들지 못했습니다.');
  }

  try {
    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    throwIfAborted(signal);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: submitCommentFromPageContext,
      args: [COMMENT_SUBMIT_PATH, requestBody],
    });
    const result = results?.[0]?.result;
    if (!result || typeof result !== 'object') {
      throw new Error('페이지 댓글 제출 결과를 받지 못했습니다.');
    }
    if (!result.ok && !result.status && result.errorMessage) {
      throw new Error(result.errorMessage);
    }
    return result;
  } finally {
    await removeTabQuietly(tabId);
  }
}

async function ensureChallengeTabUsable(challenge, resolvedConfig, postNo, signal) {
  const tabId = Number(challenge?.tabId || 0);
  if (tabId <= 0) {
    return {
      ok: false,
      message: '준비된 인증코드 탭 정보가 없어 다시 준비해야 합니다.',
      failureType: 'challenge_expired',
    };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status !== 'complete') {
      await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    }
    throwIfAborted(signal);

    const currentTab = await chrome.tabs.get(tabId);
    const currentUrl = String(currentTab?.url || currentTab?.pendingUrl || challenge?.tabUrl || '').trim();
    if (!isExpectedChallengeTabUrl(currentUrl, resolvedConfig.galleryId, postNo)) {
      return {
        ok: false,
        message: '준비한 인증코드 탭이 다른 페이지로 바뀌었습니다. 토글 ON으로 다시 준비하세요.',
        failureType: 'challenge_tab_moved',
      };
    }

    return {
      ok: true,
      tabId,
    };
  } catch (error) {
    return {
      ok: false,
      message: '준비한 인증코드 탭이 이미 닫혀 다시 준비가 필요합니다.',
      failureType: 'challenge_expired',
      error,
    };
  }
}

function isExpectedChallengeTabUrl(url = '', galleryId = '', postNo = '') {
  try {
    const parsedUrl = new URL(String(url || ''));
    const normalizedGalleryId = String(galleryId || '').trim();
    const normalizedPostNo = String(postNo || '').trim();
    if (!/\/(?:m?gallery)\/board\/view\/?/i.test(parsedUrl.pathname)) {
      return false;
    }
    if (normalizedGalleryId && parsedUrl.searchParams.get('id') !== normalizedGalleryId) {
      return false;
    }
    if (normalizedPostNo && parsedUrl.searchParams.get('no') !== normalizedPostNo) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function readAnonymousCommentFormFromPage(resolvedConfig, tabId, postNo) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: prepareAnonymousChallengeFromPageContext,
    args: [
      postNo,
      resolvedConfig.galleryId,
      resolvedConfig.galleryType,
      CAPTCHA_READY_TIMEOUT_MS,
      CAPTCHA_READY_INTERVAL_MS,
    ],
  });

  return results?.[0]?.result || null;
}

async function submitPreparedAnonymousCommentViaPageContext(
  resolvedConfig,
  tabId,
  postNo,
  payload,
  signal,
) {
  throwIfAborted(signal);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: submitAnonymousCommentFromPageContext,
    args: [
      postNo,
      {
        galleryId: resolvedConfig.galleryId,
        galleryType: resolvedConfig.galleryType,
        memo: payload.memo,
        replyNo: payload.replyNo,
        name: payload.name,
        password: payload.password,
        code: payload.code,
        recommend: payload.recommend,
        submitPath: COMMENT_SUBMIT_PATH,
      },
    ],
  });
  const result = results?.[0]?.result;
  if (!result || typeof result !== 'object') {
    throw new Error('페이지 유동 댓글 제출 결과를 받지 못했습니다.');
  }
  if (!result.ok && !result.status && result.errorMessage) {
    return {
      ok: false,
      status: 0,
      responseText: '',
      errorMessage: result.errorMessage,
      failureType: result.failureType || 'spec',
    };
  }
  return result;
}

function buildMemberSubmitBody({
  galleryId,
  galleryType,
  postNo,
  replyNo,
  memo,
  memberName,
  currentUnixTime,
  tokens,
  recommend,
}) {
  const body = new URLSearchParams();
  body.set('id', galleryId);
  body.set('no', postNo);
  body.set('reply_no', buildReplyNoFieldValue(replyNo));
  body.set('name', memberName);
  body.set('memo', memo);
  body.set('cur_t', currentUnixTime);
  body.set('check_6', tokens.check6);
  body.set('check_7', tokens.check7);
  body.set('check_8', tokens.check8);
  body.set('check_9', tokens.check9);
  body.set('check_10', tokens.check10);
  body.set('recommend', String(recommend));
  body.set('c_r_k_x_z', tokens.commentToken);
  body.set('t_vch2', '');
  body.set('t_vch2_chk', '');
  body.set('c_gall_id', galleryId);
  body.set('c_gall_no', postNo);
  body.set('service_code', tokens.serviceCode);
  body.set('g-recaptcha-response', '');
  body.set('_GALLTYPE_', galleryType || DEFAULT_CONFIG.galleryType);
  body.set('headTail', '""');
  return body;
}

function buildReplyNoFieldValue(replyNo) {
  const normalized = normalizeReplyNo(replyNo);
  return normalized || 'undefined';
}

function getMissingRequiredTokenKeys(tokens = {}) {
  const requiredTokens = {
    check6: tokens.check6,
    check7: tokens.check7,
    check8: tokens.check8,
    check9: tokens.check9,
    check10: tokens.check10,
    commentToken: tokens.commentToken,
    serviceCode: tokens.serviceCode,
  };
  return Object.entries(requiredTokens)
    .filter(([, value]) => !String(value || '').trim())
    .map(([key]) => key);
}

function createCommentNoSet(comments = []) {
  return new Set((comments || [])
    .map((comment) => getCommentNo(comment))
    .filter(Boolean));
}

async function dcFetch(url, options = {}) {
  return fetch(url, {
    credentials: 'include',
    headers: options.headers || {},
    ...options,
  });
}

async function dcFetchWithRetry(url, options = {}, maxRetries = 2) {
  const retries = Math.max(1, Number(maxRetries) || 1);
  let lastError = null;
  let lastResponse = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await dcFetch(url, options);
      lastResponse = response;

      if (response.status === 429 && attempt < retries - 1) {
        await delay((attempt + 1) * 2000, options.signal);
        continue;
      }

      if (response.status === 403 && attempt < retries - 1) {
        await delay((attempt + 1) * 3000, options.signal);
        continue;
      }

      return response;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
      lastError = error;
      if (attempt < retries - 1) {
        await delay((attempt + 1) * 1000, options.signal);
      }
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw new Error(lastError?.message || '댓글 등록 요청 재시도 한도를 초과했습니다.');
}

function extractCommentSubmitTokens(html = '') {
  return {
    check6: extractHiddenInputValue(html, 'check_6'),
    check7: extractHiddenInputValue(html, 'check_7'),
    check8: extractHiddenInputValue(html, 'check_8'),
    check9: extractHiddenInputValue(html, 'check_9'),
    check10: extractHiddenInputValue(html, 'check_10'),
    commentToken: extractHiddenInputValue(html, 'c_r_k_x_z'),
    serviceCode: extractHiddenInputValue(html, 'service_code'),
    currentUnixTime: extractHiddenInputValue(html, 'cur_t'),
    galleryType: extractHiddenInputValue(html, '_GALLTYPE_'),
    memberDivision: extractHiddenInputValue(html, 'member_division'),
    commentCodeRequired: extractHiddenInputValue(html, 'comment_code'),
    useGallNick: extractHiddenInputValue(html, 'use_gall_nick'),
  };
}

function extractHiddenInputValue(html = '', inputName = '') {
  const escapedName = escapeRegExp(String(inputName || '').trim());
  if (!escapedName) {
    return '';
  }

  const inputFirst = new RegExp(`name=['"]${escapedName}['"][^>]*value=['"]([^'"]*)['"]`, 'i');
  const valueFirst = new RegExp(`value=['"]([^'"]*)['"][^>]*name=['"]${escapedName}['"]`, 'i');
  const match = html.match(inputFirst) || html.match(valueFirst);
  return match ? String(match[1] || '').trim() : '';
}

function extractCommentAuthorName(html = '') {
  const labelPatterns = [
    /<label[^>]*for=['"]user_nick['"][^>]*class=['"](?![^'"]*blind)[^'"]*['"][^>]*>([\s\S]*?)<\/label>/i,
    /<label[^>]*for=['"]user_nick['"](?![^>]*class=['"][^'"]*blind)[^>]*>([\s\S]*?)<\/label>/i,
  ];

  for (const pattern of labelPatterns) {
    const match = html.match(pattern);
    const normalizedText = normalizeInlineHtmlText(match?.[1]);
    if (
      normalizedText
      && normalizedText !== '닉네임'
      && !normalizedText.includes('${')
      && !normalizedText.includes('}')
    ) {
      return normalizedText;
    }
  }

  return '';
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeInlineHtmlText(value = '') {
  return decodeHtmlEntities(
    String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function buildCommentModeMismatchMessage(submitMode, requiresChallengeCode) {
  if (submitMode === 'anonymous') {
    return '현재 페이지가 고닉/로그인 댓글 폼으로 내려와서 유동용 테스트와 맞지 않습니다. 유동용 테스트는 비회원 댓글 폼이 보이는 상태에서만 실행하세요.';
  }

  if (requiresChallengeCode) {
    return '현재 페이지가 유동/비회원 댓글 폼으로 내려왔고 인증코드까지 필요한 상태입니다. 즉 확장 프로그램 요청 기준 로그인 세션이 안 잡혔습니다. 고닉용 테스트는 여기서 중단합니다.';
  }

  return '현재 페이지가 유동/비회원 댓글 폼으로 내려왔습니다. 즉 확장 프로그램 요청 기준 로그인 세션이 안 잡혔습니다. 고닉용 테스트는 여기서 중단합니다.';
}

function inferCommentSubmitFailureType(response, responseText) {
  if (response.status === 429) {
    return 'rate_limit';
  }

  if (response.status === 403) {
    return 'forbidden';
  }

  if (!response.ok) {
    return 'http';
  }

  const normalizedText = String(responseText || '').trim();
  if (!normalizedText) {
    return '';
  }

  if (/^false\|\|captcha\|\|v\d+/i.test(normalizedText)) {
    return 'recaptcha';
  }

  if (/(정상적인 접근이 아닙니다|잘못된 접근|비정상적인 접근|올바른 방법으로 이용해 주세요|비공식 확장 프로그램)/i.test(normalizedText)) {
    return 'guard';
  }

  if (/(captcha|자동 입력 방지)/i.test(normalizedText)) {
    return 'captcha';
  }

  if (/(로그인|권한|forbidden|denied)/i.test(normalizedText)) {
    return 'auth';
  }

  if (/(실패|error|fail)/i.test(normalizedText)) {
    return 'unknown';
  }

  return '';
}

function buildFailureMessage(response, responseText, failureType) {
  const summary = summarizeResponseText(responseText);
  if (failureType === 'rate_limit') {
    return summary || '댓글 요청이 너무 많아 잠시 후 다시 시도해야 합니다.';
  }
  if (failureType === 'forbidden') {
    return summary || '댓글 등록 권한이 없거나 접근이 거부되었습니다.';
  }
  if (failureType === 'guard') {
    return summary || '댓글 등록 보호 로직에 걸렸습니다. 페이지 토큰을 다시 읽어야 합니다.';
  }
  if (failureType === 'captcha') {
    return summary || '인증코드가 틀렸거나 만료돼 댓글 등록에 실패했습니다.';
  }
  if (failureType === 'recaptcha') {
    return summary || '서버가 추가 reCAPTCHA 검증을 요구했습니다. 현재 패치는 여기까지 자동 처리하지 않습니다.';
  }
  if (failureType === 'auth') {
    return summary || '로그인 또는 권한 문제로 댓글 등록에 실패했습니다.';
  }
  if (failureType === 'http') {
    return summary || `댓글 등록 실패 (HTTP ${response.status})`;
  }
  return summary || '댓글 등록 응답이 비정상이라 실패로 처리했습니다.';
}

function buildVerifyFailureMessage(baseMessage, responseText) {
  const summary = summarizeResponseText(responseText);
  if (!summary) {
    return baseMessage;
  }
  return `${baseMessage} 응답 요약: ${summary}`;
}

function summarizeResponseText(responseText) {
  return String(responseText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function parseCommentSubmitSuccessCommentNo(responseText) {
  const normalizedText = String(responseText || '').trim();
  return /^\d+$/.test(normalizedText) ? normalizedText : '';
}

function getCommentNo(comment = {}) {
  const candidates = [
    comment.no,
    comment.comment_no,
    comment.c_no,
    comment.reply_no,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function getCommentMemo(comment = {}) {
  const candidates = [
    comment.memo,
    comment.comment_memo,
    comment.content,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function createChallengeId() {
  const randomSegment = Math.random().toString(36).slice(2, 8);
  return `smc-${Date.now()}-${randomSegment}`;
}

function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));

    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', handleAbort);
      }
    };

    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true });
    }
  });
}

function createAbortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  const existingTab = await chrome.tabs.get(tabId);
  if (existingTab?.status === 'complete') {
    return existingTab;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(new Error(`댓글 등록용 탭 로딩 timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    function handleUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }

      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(tab);
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);
  });
}

async function removeTabQuietly(tabId) {
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // 이미 닫힌 탭은 무시한다.
  }
}

async function submitCommentFromPageContext(submitPath, requestBody) {
  try {
    const response = await fetch(submitPath, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: String(requestBody || ''),
    });
    const responseText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      responseText,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      responseText: '',
      errorMessage: String(error?.message || '페이지 문맥 댓글 요청 실패'),
    };
  }
}

async function prepareAnonymousChallengeFromPageContext(
  postNo,
  fallbackGalleryId,
  fallbackGalleryType,
  timeoutMs,
  intervalMs,
) {
  const normalizedPostNo = String(postNo || '').trim();
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  const findInputById = (baseId) => {
    if (!baseId) {
      return null;
    }
    return document.getElementById(`${baseId}_${normalizedPostNo}`)
      || document.getElementById(baseId);
  };
  const findNamedInput = (name) => document.querySelector(`input[name="${name}"]`);
  const readValue = (element) => String(element?.value || '').trim();
  const readUpperValue = (element) => readValue(element).toUpperCase();
  const toAbsoluteUrl = (value) => {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return '';
    }
    try {
      return new URL(normalizedValue, window.location.href).toString();
    } catch {
      return normalizedValue;
    }
  };
  const isCaptchaReady = (value) => {
    const normalizedValue = String(value || '').trim();
    return Boolean(normalizedValue) && !/kcap_none\.png/i.test(normalizedValue);
  };
  const computeVisible = (element) => {
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };

  try {
    const memberDivisionInput = findNamedInput('member_division') || findInputById('member_division');
    const commentCodeInput = findNamedInput('comment_code') || findInputById('comment_code');
    const useGallNickInput = findNamedInput('use_gall_nick') || findInputById('use_gall_nick');
    const galleryTypeInput = findNamedInput('_GALLTYPE_') || findInputById('_GALLTYPE_');
    const gallNickInput = findInputById('gall_nick_name') || findNamedInput('gall_nick_name');
    const nameInput = findInputById('name') || findNamedInput('name');
    const passwordInput = findInputById('password') || findNamedInput('password');
    const codeInput = findInputById('code') || findNamedInput('code');
    const captchaImage = document.getElementById(`kcaptcha_${normalizedPostNo}`)
      || document.querySelector(`img.kcaptcha[data-type="comment"]`);
    const searchParams = new URLSearchParams(window.location.search);
    const galleryId = String(searchParams.get('id') || fallbackGalleryId || '').trim();
    const galleryType = String(readValue(galleryTypeInput) || fallbackGalleryType || '').trim();
    const memberDivision = readUpperValue(memberDivisionInput) || (passwordInput ? 'N' : '');
    const requiresCode = readUpperValue(commentCodeInput) === 'Y' || Boolean(codeInput);
    const useGallNick = readUpperValue(useGallNickInput) || (gallNickInput ? 'Y' : 'N');
    const gallNickName = readValue(gallNickInput);
    const anonymousName = readValue(nameInput);

    let captchaImageUrl = toAbsoluteUrl(captchaImage?.currentSrc || captchaImage?.src || captchaImage?.getAttribute('src'));
    if (requiresCode && captchaImage && !isCaptchaReady(captchaImageUrl)) {
      try {
        if (typeof window.kcaptcha_init === 'function') {
          window.kcaptcha_init(normalizedPostNo);
        }
      } catch {
        // 초기화 실패는 아래 polling 결과로 판단한다.
      }

      try {
        captchaImage.dispatchEvent(new window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      } catch {
        // click 실패도 polling 결과로 판단한다.
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < Math.max(1000, Number(timeoutMs) || 0)) {
        await sleep(intervalMs);
        captchaImageUrl = toAbsoluteUrl(captchaImage.currentSrc || captchaImage.src || captchaImage.getAttribute('src'));
        if (isCaptchaReady(captchaImageUrl)) {
          break;
        }
      }
    }

    return {
      ok: true,
      tabUrl: window.location.href,
      galleryId,
      galleryType,
      memberDivision,
      commentCodeRequired: requiresCode ? 'Y' : 'N',
      useGallNick,
      gallNickName,
      anonymousName,
      anonymousNameVisible: computeVisible(nameInput),
      passwordRequired: Boolean(passwordInput),
      captchaImageUrl: isCaptchaReady(captchaImageUrl) ? captchaImageUrl : '',
    };
  } catch (error) {
    return {
      ok: false,
      failureType: 'spec',
      message: String(error?.message || '유동 댓글 폼 읽기 실패'),
    };
  }
}

async function submitAnonymousCommentFromPageContext(postNo, payload = {}) {
  const normalizedPostNo = String(postNo || '').trim();
  const findInputById = (baseId) => {
    if (!baseId) {
      return null;
    }
    return document.getElementById(`${baseId}_${normalizedPostNo}`)
      || document.getElementById(baseId);
  };
  const findNamedInput = (name) => document.querySelector(`input[name="${name}"]`);
  const readValue = (element) => String(element?.value || '').trim();
  const readUpperValue = (element) => readValue(element).toUpperCase();

  try {
    const memberDivisionInput = findNamedInput('member_division') || findInputById('member_division');
    const commentCodeInput = findNamedInput('comment_code') || findInputById('comment_code');
    const useGallNickInput = findNamedInput('use_gall_nick') || findInputById('use_gall_nick');
    const galleryTypeInput = findNamedInput('_GALLTYPE_') || findInputById('_GALLTYPE_');
    const curTInput = findNamedInput('cur_t') || findInputById('cur_t');
    const gallNickInput = findInputById('gall_nick_name') || findNamedInput('gall_nick_name');
    const nameInput = findInputById('name') || findNamedInput('name');
    const passwordInput = findInputById('password') || findNamedInput('password');
    const codeInput = findInputById('code') || findNamedInput('code');
    const searchParams = new URLSearchParams(window.location.search);
    const galleryId = String(searchParams.get('id') || payload.galleryId || '').trim();
    const galleryType = String(readValue(galleryTypeInput) || payload.galleryType || '').trim() || 'M';
    const memberDivision = readUpperValue(memberDivisionInput) || (passwordInput ? 'N' : '');
    const requiresCode = readUpperValue(commentCodeInput) === 'Y' || Boolean(codeInput);
    const useGallNick = readUpperValue(useGallNickInput) || (gallNickInput ? 'Y' : 'N');
    const gallNickName = readValue(gallNickInput);
    const pageNameValue = readValue(nameInput);
    const requestedName = String(payload.name || '').trim();
    const password = String(payload.password || '').trim();
    const code = String(payload.code || '').trim();

    if (memberDivision && memberDivision !== 'N') {
      return {
        ok: false,
        status: 0,
        responseText: '',
        errorMessage: '현재 페이지가 비회원 댓글 폼이 아닙니다.',
        failureType: 'mode_mismatch',
      };
    }

    const tokens = {
      check6: readValue(findNamedInput('check_6')),
      check7: readValue(findNamedInput('check_7')),
      check8: readValue(findNamedInput('check_8')),
      check9: readValue(findNamedInput('check_9')),
      check10: readValue(findNamedInput('check_10')),
      commentToken: readValue(findNamedInput('c_r_k_x_z')),
      serviceCode: readValue(findNamedInput('service_code')),
    };
    const missingTokenKeys = Object.entries(tokens)
      .filter(([, value]) => !String(value || '').trim())
      .map(([key]) => key);
    if (missingTokenKeys.length > 0) {
      return {
        ok: false,
        status: 0,
        responseText: '',
        errorMessage: `댓글 작성 토큰 추출 실패: ${missingTokenKeys.join(', ')}`,
        failureType: 'spec',
      };
    }

    const effectiveName = useGallNick === 'Y'
      ? (pageNameValue || gallNickName)
      : (requestedName || pageNameValue);
    if (!effectiveName) {
      return {
        ok: false,
        status: 0,
        responseText: '',
        errorMessage: useGallNick === 'Y'
          ? '페이지에서 비회원 닉네임 표시값을 읽지 못했습니다.'
          : '비회원 닉네임을 입력하세요.',
        failureType: 'validation',
      };
    }

    if (passwordInput && password.length < 2) {
      return {
        ok: false,
        status: 0,
        responseText: '',
        errorMessage: '유동 비밀번호는 2자 이상 입력하세요.',
        failureType: 'validation',
      };
    }

    if (requiresCode && !code) {
      return {
        ok: false,
        status: 0,
        responseText: '',
        errorMessage: '인증코드를 입력하세요.',
        failureType: 'validation',
      };
    }

    const body = new URLSearchParams();
    body.set('id', galleryId);
    body.set('no', normalizedPostNo);
    body.set('reply_no', String(payload.replyNo || '').trim() || 'undefined');
    body.set('name', effectiveName);
    body.set('memo', String(payload.memo || '').trim());
    body.set('cur_t', readValue(curTInput) || String(Math.floor(Date.now() / 1000)));
    body.set('check_6', tokens.check6);
    body.set('check_7', tokens.check7);
    body.set('check_8', tokens.check8);
    body.set('check_9', tokens.check9);
    body.set('check_10', tokens.check10);
    body.set('recommend', String(Number.parseInt(String(payload.recommend || 0), 10) === 1 ? 1 : 0));
    body.set('c_r_k_x_z', tokens.commentToken);
    body.set('t_vch2', readValue(findNamedInput('t_vch2')));
    body.set('t_vch2_chk', readValue(findNamedInput('t_vch2_chk')));
    body.set('c_gall_id', galleryId);
    body.set('c_gall_no', normalizedPostNo);
    body.set('service_code', tokens.serviceCode);
    body.set('g-recaptcha-response', '');
    body.set('_GALLTYPE_', galleryType);
    body.set('headTail', '""');
    if (useGallNick === 'Y') {
      body.set('gall_nick_name', gallNickName || effectiveName);
    }
    if (passwordInput || password) {
      body.set('password', password);
    }
    if (requiresCode || code) {
      body.set('code', code);
    }
    body.set('use_gall_nick', useGallNick);

    const response = await fetch(String(payload.submitPath || COMMENT_SUBMIT_PATH), {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
    const responseText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      responseText,
      submittedName: effectiveName,
      useGallNick,
      gallNickName: gallNickName || effectiveName,
      memberDivision,
      commentCodeRequired: requiresCode ? 'Y' : 'N',
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      responseText: '',
      errorMessage: String(error?.message || '유동 댓글 페이지 문맥 요청 실패'),
      failureType: 'network',
    };
  }
}

export {
  DEFAULT_CONFIG,
  cancelManualChallenge,
  normalizeConfig,
  normalizeMemo,
  normalizePostNo,
  normalizeSubmitMode,
  prepareAnonymousManualChallenge,
  refreshAnonymousManualChallenge,
  submitComment,
  submitPreparedAnonymousChallenge,
};
