import {
  delay as apiDelay,
  fetchConceptPostViewHTML,
  releaseConceptPost,
} from './api.js';
import { extractConceptPostMetrics } from './parser.js';

const DEFAULT_FLUID_RATIO_THRESHOLD_PERCENT = 90;
const FALLBACK_RECHECK_DELAY_MS = 1000;
const BLOCK_COOLDOWN_MS = 30 * 60 * 1000;

async function inspectAndMaybeReleaseConceptPost(options = {}) {
  const {
    config = {},
    post = {},
    progressLabel = '검사',
    log = () => {},
    delayFn = apiDelay,
    fetchConceptPostViewHTMLFn = fetchConceptPostViewHTML,
    releaseConceptPostFn = releaseConceptPost,
    extractConceptPostMetricsFn = extractConceptPostMetrics,
  } = options;

  const postNo = String(post?.no || '').trim();
  if (!postNo) {
    return createResult();
  }

  const currentHead = normalizeBoardHead(post?.currentHead);
  if (!isGeneralBoardHead(currentHead)) {
    log(`ℹ️ ${progressLabel} #${postNo} 스킵 - 머릿말 ${formatBoardHeadLabel(currentHead)}는 일반 글이 아님`);
    return createResult();
  }

  let viewHtml = '';
  try {
    viewHtml = await fetchConceptPostViewHTMLFn(config, postNo);
  } catch (error) {
    log(`⚠️ #${postNo} view 조회 실패 - ${error.message}`);
    if (isConceptBlockSignalMessage(error?.message)) {
      throw error;
    }
    return createResult({ failedCount: 1 });
  }

  const metrics = extractConceptPostViewMetrics(extractConceptPostMetricsFn, viewHtml, postNo, true);
  if (!metrics.success) {
    log(`⚠️ #${postNo} 파싱 실패 - ${metrics.message}${metrics.debugSummary ? ` / debug: ${metrics.debugSummary}` : ''}`);
    return createResult({ failedCount: 1 });
  }

  if (!metrics.isConcept) {
    log(`ℹ️ ${progressLabel} #${postNo} 정상 통과 - 현재 개념글 아님`);
    return createResult();
  }

  if (metrics.totalRecommendCount <= 0) {
    log(`ℹ️ ${progressLabel} #${postNo} 정상 통과 - 총추천 0`);
    return createResult();
  }

  if (metrics.fixedNickRecommendCount > metrics.totalRecommendCount) {
    log(`⚠️ #${postNo} 비정상 추천값 - 총추천 ${metrics.totalRecommendCount}, 고정닉 ${metrics.fixedNickRecommendCount}`);
    return createResult({ failedCount: 1 });
  }

  const fluidRecommendCount = metrics.totalRecommendCount - metrics.fixedNickRecommendCount;
  const fluidRatio = fluidRecommendCount / metrics.totalRecommendCount;
  const thresholdRatio = getFluidRatioThreshold(config);

  if (fluidRatio < thresholdRatio) {
    log(
      `ℹ️ ${progressLabel} #${postNo} 정상 통과 - 총추천 ${metrics.totalRecommendCount}, 고정닉 ${metrics.fixedNickRecommendCount}, 유동비율 ${fluidRatio.toFixed(2)}`,
    );
    return createResult();
  }

  log(
    `🎯 ${progressLabel} 개념글 해제 후보 #${postNo} - 총추천 ${metrics.totalRecommendCount}, 고정닉 ${metrics.fixedNickRecommendCount}, 유동비율 ${fluidRatio.toFixed(2)}`,
  );

  if (config.testMode !== false) {
    log(`🧪 테스트 모드 - 해제 미실행 #${postNo}`);
    return createResult({ candidateCount: 1 });
  }

  log(`⚙️ 개념글 해제 실행 #${postNo}`);

  let releaseResult;
  try {
    releaseResult = await releaseConceptPostFn(config, postNo);
  } catch (error) {
    if (await skipIfAlreadyReleasedBySomeoneElse({
      config,
      postNo,
      contextMessage: `해제 요청 실패 (${error.message})`,
      log,
      delayFn,
      fetchConceptPostViewHTMLFn,
      extractConceptPostMetricsFn,
    })) {
      return createResult({ candidateCount: 1 });
    }

    log(`❌ 개념글 해제 실패 #${postNo} - ${error.message}`);
    if (isConceptBlockSignalMessage(error?.message)) {
      throw error;
    }
    return createResult({ candidateCount: 1, failedCount: 1 });
  }

  if (releaseResult.status !== 200) {
    if (await skipIfAlreadyReleasedBySomeoneElse({
      config,
      postNo,
      contextMessage: `해제 응답 HTTP ${releaseResult.status}`,
      log,
      delayFn,
      fetchConceptPostViewHTMLFn,
      extractConceptPostMetricsFn,
    })) {
      return createResult({ candidateCount: 1 });
    }

    log(`❌ 개념글 해제 실패 #${postNo} - HTTP ${releaseResult.status} / raw: ${releaseResult.rawSummary}`);
    return createResult({ candidateCount: 1, failedCount: 1 });
  }

  let recheckHtml = '';
  try {
    recheckHtml = await fetchConceptPostViewHTMLFn(config, postNo);
  } catch (error) {
    if (await skipIfAlreadyReleasedBySomeoneElse({
      config,
      postNo,
      contextMessage: `재확인 조회 실패 (${error.message})`,
      log,
      delayFn,
      fetchConceptPostViewHTMLFn,
      extractConceptPostMetricsFn,
    })) {
      return createResult({ candidateCount: 1 });
    }

    log(`⚠️ 개념글 해제 결과 불명확 #${postNo} - 재확인 실패 (${error.message}) / raw: ${releaseResult.rawSummary}`);
    if (isConceptBlockSignalMessage(error?.message)) {
      throw error;
    }
    return createResult({ candidateCount: 1, unclearCount: 1 });
  }

  const rechecked = extractConceptPostViewMetrics(extractConceptPostMetricsFn, recheckHtml, postNo, false);
  if (!rechecked.success) {
    log(`⚠️ 개념글 해제 결과 불명확 #${postNo} - 재확인 파싱 실패${rechecked.debugSummary ? ` / debug: ${rechecked.debugSummary}` : ''} / raw: ${releaseResult.rawSummary}`);
    return createResult({ candidateCount: 1, unclearCount: 1 });
  }

  if (!rechecked.isConcept) {
    log(`✅ 개념글 해제 완료 #${postNo}`);
    return createResult({ candidateCount: 1, releasedCount: 1 });
  }

  log(`❌ 개념글 해제 실패 #${postNo} - HTTP 200 / raw: ${releaseResult.rawSummary}`);
  return createResult({ candidateCount: 1, failedCount: 1 });
}

async function skipIfAlreadyReleasedBySomeoneElse(options = {}) {
  const {
    config = {},
    postNo = '',
    contextMessage = '',
    log = () => {},
    delayFn = apiDelay,
    fetchConceptPostViewHTMLFn = fetchConceptPostViewHTML,
    extractConceptPostMetricsFn = extractConceptPostMetrics,
  } = options;

  try {
    await delayFn(FALLBACK_RECHECK_DELAY_MS);
    const latestHtml = await fetchConceptPostViewHTMLFn(config, postNo);
    const latestMetrics = extractConceptPostViewMetrics(extractConceptPostMetricsFn, latestHtml, postNo, false);

    if (latestMetrics.success && !latestMetrics.isConcept) {
      const suffix = contextMessage ? ` (${contextMessage})` : '';
      log(`ℹ️ #${postNo} 이미 개념글 아님 - 수동 해제로 보고 다음 글로 진행${suffix}`);
      return true;
    }
  } catch (error) {
    if (isConceptBlockSignalMessage(error?.message)) {
      throw error;
    }
  }

  return false;
}

function extractConceptPostViewMetrics(extractConceptPostMetricsFn, html, postNo, assumeConcept) {
  return extractConceptPostMetricsFn(html, {
    postNoHint: postNo,
    assumeConcept,
  });
}

function getFluidRatioThreshold(config = {}) {
  const configuredThreshold = Number(config.fluidRatioThresholdPercent);
  const thresholdPercent = Number.isFinite(configuredThreshold)
    ? configuredThreshold
    : DEFAULT_FLUID_RATIO_THRESHOLD_PERCENT;
  return Math.max(0, Math.min(100, thresholdPercent)) / 100;
}

function createResult({
  candidateCount = 0,
  releasedCount = 0,
  failedCount = 0,
  unclearCount = 0,
} = {}) {
  return {
    candidateCount,
    releasedCount,
    failedCount,
    unclearCount,
  };
}

function isConceptBlockSignalMessage(message) {
  const normalizedMessage = String(message || '');
  return /접근 차단 응답|HTTP 403|HTTP 429|빈 응답|정상적인 접근이 아닙니다|<empty>/i.test(normalizedMessage);
}

function normalizeBoardHead(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isGeneralBoardHead(currentHead) {
  return normalizeBoardHead(currentHead) === '일반';
}

function formatBoardHeadLabel(currentHead) {
  const normalized = normalizeBoardHead(currentHead);
  return normalized || '(없음)';
}

export {
  BLOCK_COOLDOWN_MS,
  getFluidRatioThreshold,
  inspectAndMaybeReleaseConceptPost,
  isConceptBlockSignalMessage,
};
