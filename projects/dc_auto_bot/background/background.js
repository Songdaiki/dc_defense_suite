import { Scheduler } from './scheduler.js';
import { callCliHelperJudge, fetchPostPage, normalizeCliHelperEndpoint, resolveConfig } from './api.js';
import { extractPostContentForLlm, normalizeReportTarget, parseTargetUrl } from './parser.js';

const scheduler = new Scheduler();
const LLM_STORAGE_KEY = 'reportBotLlmState';
const HELPER_HEALTH_CACHE_MS = 1500;
const HELPER_HEALTH_TIMEOUT_MS = 3000;

const llmState = {
  lastTestResult: null,
  lastTestAt: '',
  isTesting: false,
};

const helperHealthState = {
  status: 'unknown',
  checkedAt: '',
  message: 'helper 상태를 아직 확인하지 않았습니다.',
  endpoint: '',
  responseTimeMs: 0,
  details: null,
  pendingPromise: null,
  lastCheckAtMs: 0,
};

void initialize();

chrome.runtime.onInstalled.addListener(async () => {
  await resumeScheduler();
});

self.addEventListener('activate', async () => {
  await resumeScheduler();
});

chrome.runtime.onStartup.addListener(async () => {
  await resumeScheduler();
});

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepAlive') {
    return;
  }

  resumeScheduler().catch((error) => {
    console.error('[ReportBot] keepAlive 복원 실패:', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error('[ReportBot] 메시지 처리 실패:', error);
      sendResponse({ success: false, message: error.message });
    });

  return true;
});

async function initialize() {
  await loadLlmState();
  await resumeScheduler();
}

async function resumeScheduler() {
  if (!scheduler.runPromise) {
    await scheduler.loadState();
  }

  scheduler.ensureRunLoop();
}

async function handleMessage(message) {
  switch (message.action) {
    case 'getStatus':
      await refreshHelperHealth();
      return { success: true, status: buildCombinedStatus() };

    case 'start':
      return startAutomation();

    case 'stop':
      await scheduler.stop();
      return { success: true, status: buildCombinedStatus() };

    case 'refreshHelperHealth':
      await refreshHelperHealth(true);
      return { success: true, status: buildCombinedStatus() };

    case 'updateConfig':
      return updateConfig(message.config || {});

    case 'resetStats':
      if (scheduler.isRunning) {
        return {
          success: false,
          message: '실행 중에는 통계를 초기화할 수 없습니다.',
          status: buildCombinedStatus(),
        };
      }

      scheduler.resetStats();
      await scheduler.saveState();
      return { success: true, status: buildCombinedStatus() };

    case 'addTrustedUser':
      return addTrustedUser(message.userId, message.label);

    case 'removeTrustedUser':
      scheduler.removeTrustedUser(String(message.userId || '').trim());
      await scheduler.saveState();
      return { success: true, status: buildCombinedStatus() };

    case 'runLlmTest':
      return runLlmTest(message.targetUrl || '', message.reportReason || '');

    default:
      return { success: false, message: `알 수 없는 action: ${message.action}` };
  }
}

function buildCombinedStatus() {
  const schedulerStatus = scheduler.getStatus();
  return {
    ...schedulerStatus,
    llm: {
      lastTestAt: llmState.lastTestAt,
      lastTestResult: llmState.lastTestResult,
      isTesting: llmState.isTesting,
      helperEndpoint: scheduler.config.cliHelperEndpoint || '',
      helperTimeoutMs: scheduler.config.cliHelperTimeoutMs || 90000,
      helperHealth: getHelperHealthSnapshot(),
      config: {
        cliHelperEndpoint: scheduler.config.cliHelperEndpoint || '',
        cliHelperTimeoutMs: scheduler.config.cliHelperTimeoutMs || 90000,
        llmConfidenceThreshold: getConfidenceThresholdValue(scheduler.config.llmConfidenceThreshold),
      },
    },
  };
}

async function loadLlmState() {
  const stored = await chrome.storage.local.get(LLM_STORAGE_KEY);
  const state = stored[LLM_STORAGE_KEY] || {};
  llmState.lastTestResult = state.lastTestResult || null;
  llmState.lastTestAt = String(state.lastTestAt || '');
  llmState.isTesting = false;
}

async function saveLlmState() {
  await chrome.storage.local.set({
    [LLM_STORAGE_KEY]: {
      lastTestResult: llmState.lastTestResult,
      lastTestAt: llmState.lastTestAt,
    },
  });
}

async function updateConfig(config) {
  if (scheduler.isRunning) {
    return {
      success: false,
      message: '실행 중에는 설정을 변경할 수 없습니다.',
      status: buildCombinedStatus(),
    };
  }

  const previousGalleryId = String(scheduler.config.galleryId || '').trim();
  const previousReportTarget = String(scheduler.config.reportTarget || '').trim();

  const nextConfig = {
    ...scheduler.config,
    ...config,
  };

  nextConfig.galleryId = String(nextConfig.galleryId || '').trim();

  const normalization = normalizeReportTarget(nextConfig.reportTarget);
  if (!normalization.success) {
    return {
      success: false,
      message: normalization.message,
      status: buildCombinedStatus(),
    };
  }

  if (normalization.targetGalleryId && normalization.targetGalleryId !== nextConfig.galleryId) {
    return {
      success: false,
      message: '신문고 게시물 링크의 갤러리 ID가 현재 갤러리 설정과 다릅니다.',
      status: buildCombinedStatus(),
    };
  }

  nextConfig.reportTarget = normalization.reportTarget;
  nextConfig.reportPostNo = normalization.reportPostNo;
  nextConfig.pollIntervalMs = Math.max(1000, Number(nextConfig.pollIntervalMs) || 60000);
  nextConfig.dailyLimitPerUser = Math.max(1, Number(nextConfig.dailyLimitPerUser) || 2);
  nextConfig.commandPrefix = String(nextConfig.commandPrefix || '@특갤봇').trim() || '@특갤봇';
  nextConfig.avoidHour = String(nextConfig.avoidHour || '6');
  nextConfig.avoidReason = String(nextConfig.avoidReason || '0');
  nextConfig.avoidTypeChk = nextConfig.avoidTypeChk !== false;
  nextConfig.deleteTargetPost = nextConfig.deleteTargetPost !== false;
  nextConfig.applyAuthorFilter = nextConfig.applyAuthorFilter !== false;
  nextConfig.lowActivityThreshold = Math.max(1, Number(nextConfig.lowActivityThreshold) || 100);
  nextConfig.cliHelperTimeoutMs = Math.max(1000, Number(nextConfig.cliHelperTimeoutMs) || 90000);
  nextConfig.llmConfidenceThreshold = clampConfidenceThreshold(nextConfig.llmConfidenceThreshold);

  const helperEndpoint = normalizeCliHelperEndpoint(nextConfig.cliHelperEndpoint);
  if (!helperEndpoint.success) {
    return {
      success: false,
      message: helperEndpoint.message,
      status: buildCombinedStatus(),
    };
  }
  nextConfig.cliHelperEndpoint = helperEndpoint.endpoint;

  const reportTargetChanged = previousReportTarget !== nextConfig.reportTarget;
  const galleryChanged = previousGalleryId !== nextConfig.galleryId;

  scheduler.config = nextConfig;
  invalidateHelperHealth();

  if (reportTargetChanged || galleryChanged) {
    scheduler.phase = 'IDLE';
    scheduler.lastPollAt = '';
    scheduler.pollCount = 0;
    scheduler.totalProcessedCommands = 0;
    scheduler.totalAttemptedCommands = 0;
    scheduler.totalSucceededCommands = 0;
    scheduler.totalFailedCommands = 0;
    scheduler.lastSeenCommentNo = '0';
    scheduler.processedCommandKeys = [];
    scheduler.processedTargetPostNos = [];
    scheduler.logs = [];
    scheduler.seeded = false;
  }

  await scheduler.saveState();
  await refreshHelperHealth(true);
  return { success: true, status: buildCombinedStatus() };
}

async function startAutomation() {
  const helperHealth = await refreshHelperHealth(true);
  if (!helperHealth.isHealthy) {
    return {
      success: false,
      message: `CLI helper 상태를 확인하세요. ${helperHealth.message}`,
      status: buildCombinedStatus(),
    };
  }

  await scheduler.start();
  return { success: true, status: buildCombinedStatus() };
}

async function addTrustedUser(userId, label) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedLabel = String(label || '').trim();

  if (!normalizedUserId) {
    return { success: false, message: 'user_id를 입력하세요.', status: buildCombinedStatus() };
  }
  if (!normalizedLabel) {
    return { success: false, message: 'label을 입력하세요.', status: buildCombinedStatus() };
  }
  if (normalizedLabel.length > 20) {
    return { success: false, message: 'label은 20자 이하로 입력하세요.', status: buildCombinedStatus() };
  }

  scheduler.addTrustedUser(normalizedUserId, normalizedLabel);
  await scheduler.saveState();
  return { success: true, status: buildCombinedStatus() };
}

function mapAuthorFilterResult(authorCheck) {
  if (!authorCheck || authorCheck.success === false) {
    return 'unknown';
  }

  const message = String(authorCheck.message || '');
  if (message.startsWith('유동(')) {
    return 'fluid';
  }
  if (message.startsWith('깡계(')) {
    return 'low_activity';
  }
  if (message.startsWith('일반 계정(')) {
    return 'normal';
  }
  return authorCheck.allowed ? 'allowed' : 'review';
}

async function runLlmTest(targetUrl, reportReason) {
  if (llmState.isTesting) {
    return { success: false, message: '이미 LLM 테스트가 진행 중입니다.', status: buildCombinedStatus() };
  }

  const helperEndpoint = normalizeCliHelperEndpoint(scheduler.config.cliHelperEndpoint);
  if (!helperEndpoint.success) {
    return { success: false, message: helperEndpoint.message, status: buildCombinedStatus() };
  }

  const parsedTarget = parseTargetUrl(targetUrl);
  if (!parsedTarget.success) {
    return { success: false, message: parsedTarget.message, status: buildCombinedStatus() };
  }

  const helperHealth = await refreshHelperHealth(true);
  if (!helperHealth.isHealthy) {
    return {
      success: false,
      message: `CLI helper 상태를 확인하세요. ${helperHealth.message}`,
      status: buildCombinedStatus(),
    };
  }

  llmState.isTesting = true;
  llmState.lastTestAt = new Date().toISOString();
  llmState.lastTestResult = null;
  await saveLlmState();

  const llmConfig = resolveConfig({
    ...scheduler.config,
    galleryId: parsedTarget.targetGalleryId || scheduler.config.galleryId,
  });
  let responseSuccess = false;
  let responseMessage = '';

  try {
    const pageHtml = await fetchPostPage(llmConfig, parsedTarget.targetPostNo);
    const content = extractPostContentForLlm(pageHtml, llmConfig.baseUrl);
    const authorCheck = await scheduler.evaluateTargetAuthorFromPageHtml(pageHtml, llmConfig);
    const authorFilter = mapAuthorFilterResult(authorCheck);

    if (!authorCheck.success) {
      const message = `작성자 판정 실패: ${authorCheck.message}`;
      llmState.lastTestResult = {
        success: false,
        targetUrl,
        reportReason,
        helperEndpoint: helperEndpoint.endpoint,
        authorCheck,
        authorFilter,
        message,
      };
      llmState.lastTestAt = new Date().toISOString();
      await saveLlmState();
      responseMessage = message;
    } else if (!authorCheck.allowed) {
      const message = `v2 core 작성자 필터 미통과: ${authorCheck.message}`;
      llmState.lastTestResult = {
        success: false,
        targetUrl,
        reportReason,
        helperEndpoint: helperEndpoint.endpoint,
        authorCheck,
        authorFilter,
        message,
      };
      llmState.lastTestAt = new Date().toISOString();
      await saveLlmState();
      responseMessage = message;
    } else {
      const result = await callCliHelperJudge(llmConfig, {
        targetUrl,
        title: content.title,
        bodyText: content.bodyText,
        imageUrls: content.imageUrls,
        reportReason,
        requestLabel: 'manual_test',
        authorFilter,
      });

      llmState.lastTestResult = {
        targetUrl,
        reportReason,
        helperEndpoint: helperEndpoint.endpoint,
        title: content.title,
        bodyText: content.bodyText,
        imageUrls: content.imageUrls,
        authorCheck,
        authorFilter,
        ...result,
      };
      llmState.lastTestAt = new Date().toISOString();
      await saveLlmState();
      if (!result.success) {
        responseMessage = result.message || 'CLI helper 판정 실패';
      } else {
        responseSuccess = true;
      }
    }
  } catch (error) {
    llmState.lastTestResult = {
      targetUrl,
      reportReason,
      helperEndpoint: helperEndpoint.endpoint,
      success: false,
      message: error.message,
    };
    llmState.lastTestAt = new Date().toISOString();
    await saveLlmState();
    responseMessage = error.message;
  } finally {
    llmState.isTesting = false;
    await saveLlmState();
  }

  return {
    success: responseSuccess,
    message: responseSuccess ? '' : responseMessage,
    status: buildCombinedStatus(),
  };
}

function clampConfidenceThreshold(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0.85;
  }

  return Math.min(1, Math.max(0, numericValue));
}

function getConfidenceThresholdValue(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0.85;
}

function getHelperHealthSnapshot() {
  return {
    status: helperHealthState.status,
    isHealthy: helperHealthState.status === 'healthy',
    checkedAt: helperHealthState.checkedAt,
    message: helperHealthState.message,
    endpoint: helperHealthState.endpoint,
    responseTimeMs: helperHealthState.responseTimeMs,
    details: helperHealthState.details,
  };
}

function invalidateHelperHealth() {
  helperHealthState.status = 'unknown';
  helperHealthState.checkedAt = '';
  helperHealthState.message = 'helper 상태를 아직 확인하지 않았습니다.';
  helperHealthState.endpoint = '';
  helperHealthState.responseTimeMs = 0;
  helperHealthState.details = null;
  helperHealthState.lastCheckAtMs = 0;
  helperHealthState.pendingPromise = null;
}

async function refreshHelperHealth(force = false) {
  const endpointResult = normalizeCliHelperEndpoint(scheduler.config.cliHelperEndpoint);
  if (!endpointResult.success) {
    setHelperHealthState({
      status: 'misconfigured',
      message: endpointResult.message,
      endpoint: '',
      responseTimeMs: 0,
      details: null,
    });
    return getHelperHealthSnapshot();
  }

  const healthUrl = buildHelperHealthUrl(endpointResult.endpoint);
  const now = Date.now();
  const isCacheValid = helperHealthState.endpoint === healthUrl
    && (now - helperHealthState.lastCheckAtMs) < HELPER_HEALTH_CACHE_MS;

  if (!force && isCacheValid) {
    return getHelperHealthSnapshot();
  }

  if (helperHealthState.pendingPromise && helperHealthState.endpoint === healthUrl) {
    return helperHealthState.pendingPromise;
  }

  helperHealthState.endpoint = healthUrl;
  helperHealthState.pendingPromise = (async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, HELPER_HEALTH_TIMEOUT_MS);

    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      const responseTimeMs = Date.now() - startedAt;
      const responseText = await response.text();
      const parsed = safeParseJson(responseText);

      if (!response.ok) {
        setHelperHealthState({
          status: 'unreachable',
          message: `health check HTTP ${response.status}`,
          endpoint: healthUrl,
          responseTimeMs,
          details: parsed,
        });
        return getHelperHealthSnapshot();
      }

      if (!parsed || typeof parsed !== 'object') {
        setHelperHealthState({
          status: 'invalid_response',
          message: 'helper health 응답 형식이 올바르지 않습니다.',
          endpoint: healthUrl,
          responseTimeMs,
          details: parsed,
        });
        return getHelperHealthSnapshot();
      }

      if (parsed.success !== true) {
        setHelperHealthState({
          status: String(parsed.status || 'dependency_error'),
          message: String(parsed.message || 'helper health 확인 실패'),
          endpoint: healthUrl,
          responseTimeMs,
          details: parsed,
        });
        return getHelperHealthSnapshot();
      }

      setHelperHealthState({
        status: 'healthy',
        message: 'helper 실행 중',
        endpoint: healthUrl,
        responseTimeMs,
        details: {
          geminiCommand: parsed.geminiCommand || '',
          promptMode: parsed.promptMode || '',
          timeoutMs: Number(parsed.timeoutMs || 0),
          serverStatus: parsed.status || 'ok',
        },
      });
      return getHelperHealthSnapshot();
    } catch (error) {
      const responseTimeMs = Date.now() - startedAt;
      const message = error?.name === 'AbortError'
        ? `health check timeout (${HELPER_HEALTH_TIMEOUT_MS}ms)`
        : `helper 연결 실패: ${error.message}`;
      setHelperHealthState({
        status: 'unreachable',
        message,
        endpoint: healthUrl,
        responseTimeMs,
        details: null,
      });
      return getHelperHealthSnapshot();
    } finally {
      clearTimeout(timeoutId);
      helperHealthState.pendingPromise = null;
    }
  })();

  return helperHealthState.pendingPromise;
}

function setHelperHealthState(nextState) {
  helperHealthState.status = String(nextState.status || 'unknown');
  helperHealthState.checkedAt = new Date().toISOString();
  helperHealthState.message = String(nextState.message || '');
  helperHealthState.endpoint = String(nextState.endpoint || '');
  helperHealthState.responseTimeMs = Math.max(0, Number(nextState.responseTimeMs) || 0);
  helperHealthState.details = nextState.details && typeof nextState.details === 'object'
    ? nextState.details
    : null;
  helperHealthState.lastCheckAtMs = Date.now();
}

function buildHelperHealthUrl(judgeEndpoint) {
  const url = new URL(judgeEndpoint);
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
