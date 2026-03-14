import { Scheduler } from './scheduler.js';
import { callCliHelperJudge, callCliHelperRecord, fetchPostPage, normalizeCliHelperEndpoint, resolveConfig } from './api.js';
import { extractPostContentForLlm, normalizeReportTarget, parseTargetUrl } from './parser.js';

const scheduler = new Scheduler();
const LLM_STORAGE_KEY = 'reportBotLlmState';
const LOGIN_AUTOMATION_RUNTIME_KEY = 'reportBotLoginAutomationRuntime';
const HELPER_HEALTH_CACHE_MS = 1500;
const HELPER_HEALTH_TIMEOUT_MS = 3000;
const LOGIN_CHECK_ALARM_NAME = 'loginSessionCheck';
const LOGIN_CHECK_INTERVAL_MINUTES = 0.5;
const LOGIN_HEALTH_CACHE_MS = 25000;
const LOGIN_CHECK_TIMEOUT_MS = 15000;
const LOGIN_RETRY_MAX = 3;
const LOGIN_RETRY_BASE_MS = 60000;
const LOGIN_RETRY_JITTER_MS = 20000;
const LOGIN_COOLDOWN_MS = 10 * 60 * 1000;
const LOGIN_NOTIFICATION_ID = 'report-bot-login-automation';
const SESSION_CHECK_TAB_HASH = '#dc-auto-bot-session-check';
const LOGIN_FAILURE_URL_TOKEN = '/login/member_check';
const LOGIN_PROMPT_TEXT = '로그인해 주세요.';
const LOGIN_ACCESS_FAILURE_MESSAGES = ['정상적인접근이아닙니다', '관리권한이없습니다'];

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

const loginAutomationState = {
  status: 'disabled',
  checkedAt: '',
  message: '로그인 세션 자동화가 비활성화되었습니다.',
  detail: '',
  sessionCheckTabId: 0,
  pendingPromise: null,
  lastCheckAtMs: 0,
  retryCount: 0,
  nextRetryAtMs: 0,
  cooldownUntilMs: 0,
  lastAttemptAt: '',
};

scheduler.ensureLoginSession = ensureLoginSessionBeforeAction;
scheduler.recoverLoginSession = recoverLoginSessionAfterAccessFailure;
scheduler.handleLoginAccessFailure = handleLoginAccessFailure;

void initialize();

chrome.runtime.onInstalled.addListener(async () => {
  await resumeScheduler();
  await reconcileLoginAutomation();
});

self.addEventListener('activate', async () => {
  await resumeScheduler();
  await reconcileLoginAutomation();
});

chrome.runtime.onStartup.addListener(async () => {
  await resumeScheduler();
  await reconcileLoginAutomation();
});

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    resumeScheduler().catch((error) => {
      console.error('[ReportBot] keepAlive 복원 실패:', error);
    });
    return;
  }

  if (alarm.name === LOGIN_CHECK_ALARM_NAME) {
    refreshLoginHealth(true, { allowAutoLogin: true, reason: 'alarm' }).catch((error) => {
      console.error('[ReportBot] login session check 실패:', error);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== loginAutomationState.sessionCheckTabId) {
    return;
  }

  loginAutomationState.sessionCheckTabId = 0;
  void saveLoginAutomationRuntime();

  if (!scheduler.config.loginAutomationEnabled) {
    return;
  }

  ensureSessionCheckTab({ forceCreate: true })
    .then(() => refreshLoginHealth(true, { allowAutoLogin: true, reason: 'tab_removed' }))
    .catch((error) => {
      console.error('[ReportBot] 세션 체크 탭 재생성 실패:', error);
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
  await loadLoginAutomationRuntime();
  await reconcileLoginAutomation();
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

    case 'updateLoginAutomation':
      return updateLoginAutomation(message.config || {});

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
      helperTimeoutMs: scheduler.config.cliHelperTimeoutMs || 240000,
      helperHealth: getHelperHealthSnapshot(),
      config: {
        cliHelperEndpoint: scheduler.config.cliHelperEndpoint || '',
        cliHelperTimeoutMs: scheduler.config.cliHelperTimeoutMs || 240000,
        llmConfidenceThreshold: getConfidenceThresholdValue(scheduler.config.llmConfidenceThreshold),
      },
    },
    login: {
      enabled: scheduler.config.loginAutomationEnabled === true,
      userId: scheduler.config.dcLoginUserId || '',
      password: scheduler.config.dcLoginPassword || '',
      credentialsConfigured: Boolean(
        String(scheduler.config.dcLoginUserId || '').trim()
        && String(scheduler.config.dcLoginPassword || ''),
      ),
      health: getLoginHealthSnapshot(),
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
  const previousLoginAutomationEnabled = scheduler.config.loginAutomationEnabled === true;
  const previousDcLoginUserId = String(scheduler.config.dcLoginUserId || '').trim();
  const previousDcLoginPassword = String(scheduler.config.dcLoginPassword || '');

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
  nextConfig.cliHelperTimeoutMs = Math.max(1000, Number(nextConfig.cliHelperTimeoutMs) || 240000);
  nextConfig.llmConfidenceThreshold = clampConfidenceThreshold(nextConfig.llmConfidenceThreshold);
  nextConfig.loginAutomationEnabled = nextConfig.loginAutomationEnabled === true;
  nextConfig.dcLoginUserId = String(nextConfig.dcLoginUserId || '').trim();
  nextConfig.dcLoginPassword = String(nextConfig.dcLoginPassword || '');

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
  if (
    previousLoginAutomationEnabled !== nextConfig.loginAutomationEnabled
    || previousDcLoginUserId !== nextConfig.dcLoginUserId
    || previousDcLoginPassword !== nextConfig.dcLoginPassword
    || previousGalleryId !== nextConfig.galleryId
  ) {
    await reconcileLoginAutomation();
  }
  await refreshHelperHealth(true);
  return { success: true, status: buildCombinedStatus() };
}

async function updateLoginAutomation(config) {
  const nextEnabled = config.loginAutomationEnabled === true;
  const nextUserId = String(config.dcLoginUserId || '').trim();
  const nextPassword = String(config.dcLoginPassword || '');

  scheduler.config = {
    ...scheduler.config,
    loginAutomationEnabled: nextEnabled,
    dcLoginUserId: nextUserId,
    dcLoginPassword: nextPassword,
  };

  await scheduler.saveState();
  await reconcileLoginAutomation();
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

  if (scheduler.config.loginAutomationEnabled) {
    await refreshLoginHealth(true, { allowAutoLogin: true, reason: 'start' });
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
  if (message.startsWith('글편중(')) {
    return 'post_dominant';
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
  const recordId = createRecordId();
  let responseSuccess = false;
  let responseMessage = '';

  try {
    const pageHtml = await fetchPostPage(llmConfig, parsedTarget.targetPostNo);
    const content = extractPostContentForLlm(pageHtml, llmConfig.baseUrl);
    await persistTransparencyRecordBestEffort(llmConfig, buildTransparencyRecord({
      id: recordId,
      source: 'manual_test',
      status: 'pending',
      targetUrl,
      targetPostNo: parsedTarget.targetPostNo,
      reportReason,
      title: content.title,
      bodyText: content.bodyText,
      imageUrls: content.imageUrls,
      reason: '검토중',
    }));
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
      await persistTransparencyRecordBestEffort(llmConfig, buildTransparencyRecord({
        id: recordId,
        source: 'manual_test',
        status: 'failed',
        targetUrl,
        targetPostNo: parsedTarget.targetPostNo,
        reportReason,
        title: content.title,
        bodyText: content.bodyText,
        imageUrls: content.imageUrls,
        reason: message,
      }));
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
      await persistTransparencyRecordBestEffort(llmConfig, buildTransparencyRecord({
        id: recordId,
        source: 'manual_test',
        status: 'failed',
        targetUrl,
        targetPostNo: parsedTarget.targetPostNo,
        reportReason,
        title: content.title,
        bodyText: content.bodyText,
        imageUrls: content.imageUrls,
        reason: message,
      }));
      responseMessage = message;
    } else {
      const result = await callCliHelperJudge(llmConfig, {
        targetUrl,
        title: content.title,
        bodyText: content.bodyText,
        imageUrls: content.imageUrls,
        reportReason,
        requestLabel: 'manual_test',
        authorNick: authorCheck.authorNick || '',
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
        await persistTransparencyRecordBestEffort(llmConfig, buildTransparencyRecord({
          id: recordId,
          source: 'manual_test',
          status: 'failed',
          targetUrl,
          targetPostNo: parsedTarget.targetPostNo,
          reportReason,
          title: content.title,
          bodyText: content.bodyText,
          imageUrls: content.imageUrls,
          reason: result.message || 'CLI helper 판정 실패',
        }));
        responseMessage = result.message || 'CLI helper 판정 실패';
      } else {
        const recordSaveResult = await persistTransparencyRecordBestEffort(llmConfig, buildTransparencyRecord({
          id: recordId,
          source: 'manual_test',
          status: 'completed',
          targetUrl,
          targetPostNo: parsedTarget.targetPostNo,
          reportReason,
          title: content.title,
          bodyText: content.bodyText,
          imageUrls: content.imageUrls,
          decision: result.decision || '',
          confidence: result.confidence ?? null,
          policyIds: result.policy_ids || [],
          reason: result.reason || '',
        }));
        llmState.lastTestResult = {
          ...llmState.lastTestResult,
          transparencyRecordSaved: recordSaveResult.success,
          transparencyRecordMessage: recordSaveResult.success ? '' : recordSaveResult.message,
        };
        llmState.lastTestAt = new Date().toISOString();
        await saveLlmState();
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

function buildTransparencyRecord(input) {
  return {
    id: String(input.id || createRecordId()),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: String(input.source || 'manual_test'),
    status: String(input.status || 'completed'),
    decisionSource: String(input.decisionSource || 'gemini'),
    targetUrl: String(input.targetUrl || ''),
    targetPostNo: String(input.targetPostNo || ''),
    reportReason: String(input.reportReason || ''),
    title: String(input.title || ''),
    bodyText: String(input.bodyText || ''),
    imageUrls: Array.isArray(input.imageUrls) ? input.imageUrls : [],
    decision: String(input.decision || ''),
    confidence: input.confidence ?? null,
    policyIds: Array.isArray(input.policyIds) ? input.policyIds : [],
    reason: String(input.reason || ''),
  };
}

async function persistTransparencyRecordBestEffort(config, record) {
  if (!record) {
    return { success: false, message: '저장할 transparency record가 없습니다.' };
  }

  try {
    const result = await callCliHelperRecord(config, record);
    if (!result.success) {
      console.warn('[ReportBot] transparency record 저장 실패:', result.message);
      return {
        success: false,
        message: result.message || 'transparency record 저장 실패',
      };
    }
    return { success: true, id: result.id || '' };
  } catch (error) {
    console.warn('[ReportBot] transparency record 저장 예외:', error.message);
    return {
      success: false,
      message: error.message,
    };
  }
}

function createRecordId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `record_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
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

async function loadLoginAutomationRuntime() {
  const stored = await chrome.storage.local.get(LOGIN_AUTOMATION_RUNTIME_KEY);
  const state = stored[LOGIN_AUTOMATION_RUNTIME_KEY] || {};
  loginAutomationState.status = String(state.status || 'disabled');
  loginAutomationState.checkedAt = String(state.checkedAt || '');
  loginAutomationState.message = String(state.message || '로그인 세션 자동화가 비활성화되었습니다.');
  loginAutomationState.detail = String(state.detail || '');
  loginAutomationState.sessionCheckTabId = Number(state.sessionCheckTabId || 0);
  loginAutomationState.retryCount = Math.max(0, Number(state.retryCount || 0));
  loginAutomationState.nextRetryAtMs = Math.max(0, Number(state.nextRetryAtMs || 0));
  loginAutomationState.cooldownUntilMs = Math.max(0, Number(state.cooldownUntilMs || 0));
  loginAutomationState.lastAttemptAt = String(state.lastAttemptAt || '');
  loginAutomationState.lastCheckAtMs = Date.now();
}

async function saveLoginAutomationRuntime() {
  await chrome.storage.local.set({
    [LOGIN_AUTOMATION_RUNTIME_KEY]: {
      status: loginAutomationState.status,
      checkedAt: loginAutomationState.checkedAt,
      message: loginAutomationState.message,
      detail: loginAutomationState.detail,
      sessionCheckTabId: loginAutomationState.sessionCheckTabId,
      retryCount: loginAutomationState.retryCount,
      nextRetryAtMs: loginAutomationState.nextRetryAtMs,
      cooldownUntilMs: loginAutomationState.cooldownUntilMs,
      lastAttemptAt: loginAutomationState.lastAttemptAt,
    },
  });
}

function getLoginHealthSnapshot() {
  return {
    status: loginAutomationState.status,
    checkedAt: loginAutomationState.checkedAt,
    message: loginAutomationState.message,
    detail: loginAutomationState.detail,
    sessionCheckTabId: loginAutomationState.sessionCheckTabId,
    retryCount: loginAutomationState.retryCount,
    nextRetryAt: loginAutomationState.nextRetryAtMs ? new Date(loginAutomationState.nextRetryAtMs).toISOString() : '',
    cooldownUntil: loginAutomationState.cooldownUntilMs ? new Date(loginAutomationState.cooldownUntilMs).toISOString() : '',
    lastAttemptAt: loginAutomationState.lastAttemptAt,
  };
}

function setLoginHealthState(nextState, { notify = false } = {}) {
  const previousStatus = loginAutomationState.status;
  const previousMessage = loginAutomationState.message;
  loginAutomationState.status = String(nextState.status || 'disabled');
  loginAutomationState.checkedAt = new Date().toISOString();
  loginAutomationState.message = String(nextState.message || '');
  loginAutomationState.detail = String(nextState.detail || '');
  loginAutomationState.lastCheckAtMs = Date.now();
  void saveLoginAutomationRuntime();

  if (
    notify
    && (previousStatus !== loginAutomationState.status || previousMessage !== loginAutomationState.message)
  ) {
    void chrome.notifications.create(LOGIN_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '신문고 봇 로그인 상태',
      message: loginAutomationState.message || '로그인 상태를 확인하세요.',
      priority: 2,
    });
  }
}

function resetLoginRetryState() {
  loginAutomationState.retryCount = 0;
  loginAutomationState.nextRetryAtMs = 0;
  loginAutomationState.cooldownUntilMs = 0;
  loginAutomationState.lastAttemptAt = '';
}

function invalidateLoginHealth() {
  resetLoginRetryState();
  loginAutomationState.status = scheduler.config.loginAutomationEnabled
    ? 'checking'
    : 'disabled';
  loginAutomationState.checkedAt = '';
  loginAutomationState.message = scheduler.config.loginAutomationEnabled
    ? '로그인 세션 상태를 아직 확인하지 않았습니다.'
    : '로그인 세션 자동화가 비활성화되었습니다.';
  loginAutomationState.detail = '';
  loginAutomationState.lastCheckAtMs = 0;
  loginAutomationState.pendingPromise = null;
  void saveLoginAutomationRuntime();
}

async function reconcileLoginAutomation() {
  configureLoginAutomationAlarm();

  if (!scheduler.config.loginAutomationEnabled) {
    await closeSessionCheckTab();
    invalidateLoginHealth();
    setLoginHealthState({
      status: 'disabled',
      message: '로그인 세션 자동화가 비활성화되었습니다.',
      detail: '',
    });
    return;
  }

  invalidateLoginHealth();
  await ensureSessionCheckTab();
  await refreshLoginHealth(true, { allowAutoLogin: true, reason: 'reconcile' });
}

function configureLoginAutomationAlarm() {
  if (!scheduler.config.loginAutomationEnabled) {
    chrome.alarms.clear(LOGIN_CHECK_ALARM_NAME);
    return;
  }

  chrome.alarms.create(LOGIN_CHECK_ALARM_NAME, { periodInMinutes: LOGIN_CHECK_INTERVAL_MINUTES });
}

function buildSessionCheckListUrl(galleryId = scheduler.config.galleryId) {
  const normalizedGalleryId = String(galleryId || scheduler.config.galleryId || 'thesingularity').trim() || 'thesingularity';
  return `https://gall.dcinside.com/mgallery/board/lists/?id=${encodeURIComponent(normalizedGalleryId)}${SESSION_CHECK_TAB_HASH}`;
}

function buildGalleryListUrl(galleryId = scheduler.config.galleryId) {
  const normalizedGalleryId = String(galleryId || scheduler.config.galleryId || 'thesingularity').trim() || 'thesingularity';
  return `https://gall.dcinside.com/mgallery/board/lists/?id=${encodeURIComponent(normalizedGalleryId)}`;
}

function buildDefaultLoginUrl(galleryId = scheduler.config.galleryId) {
  const targetUrl = buildGalleryListUrl(galleryId);
  return `https://sign.dcinside.com/login?s_url=${encodeURIComponent(targetUrl)}`;
}

async function closeSessionCheckTab() {
  const tabId = Number(loginAutomationState.sessionCheckTabId || 0);
  if (tabId > 0) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // 탭이 이미 닫힌 경우는 무시한다.
    }
  }

  loginAutomationState.sessionCheckTabId = 0;
  await saveLoginAutomationRuntime();
}

async function ensureSessionCheckTab({ forceCreate = false } = {}) {
  const targetUrl = buildSessionCheckListUrl();
  const currentTabId = Number(loginAutomationState.sessionCheckTabId || 0);
  if (currentTabId > 0 && !forceCreate) {
    try {
      const currentTab = await chrome.tabs.get(currentTabId);
      if (currentTab?.id) {
        return currentTab;
      }
    } catch {
      loginAutomationState.sessionCheckTabId = 0;
    }
  }

  const existingTabs = await chrome.tabs.query({
    url: [
      'https://gall.dcinside.com/*',
      'https://sign.dcinside.com/*',
    ],
  });
  const existingTab = existingTabs.find((tab) => isSessionCheckTab(tab, targetUrl));
  if (existingTab?.id) {
    loginAutomationState.sessionCheckTabId = existingTab.id;
    await saveLoginAutomationRuntime();
    return existingTab;
  }

  const createdTab = await chrome.tabs.create({
    url: targetUrl,
    active: false,
    pinned: true,
  });
  loginAutomationState.sessionCheckTabId = createdTab.id || 0;
  await saveLoginAutomationRuntime();
  return createdTab;
}

async function waitForTabComplete(tabId, timeoutMs = LOGIN_CHECK_TIMEOUT_MS) {
  const existingTab = await chrome.tabs.get(tabId);
  if (existingTab.status === 'complete') {
    return existingTab;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(new Error(`탭 로딩 timeout (${timeoutMs}ms)`));
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

async function reloadSessionCheckTab(tabId) {
  await chrome.tabs.reload(tabId, { bypassCache: true });
  return waitForTabComplete(tabId);
}

async function refreshSessionCheckSurface(tabId, galleryId) {
  const targetUrl = buildSessionCheckListUrl(galleryId);
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return navigateTab(tabId, targetUrl);
  }

  const currentUrl = String(tab?.url || '');
  if (currentUrl === targetUrl) {
    return reloadSessionCheckTab(tabId);
  }

  return navigateTab(tabId, targetUrl);
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, {
    url,
    active: false,
  });
  return waitForTabComplete(tabId);
}

async function executeScriptInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });

  return results?.[0]?.result;
}

async function inspectSessionPage(tabId, galleryId) {
  const result = await executeScriptInTab(tabId, inspectSessionPageDom, [galleryId, LOGIN_PROMPT_TEXT]);
  if (!result || typeof result !== 'object') {
    return {
      success: false,
      state: 'manual_attention_required',
      message: '세션 확인 페이지 DOM 검사에 실패했습니다.',
      detail: '',
      loginUrl: '',
    };
  }

  if (result.hasManagerButton) {
    return {
      success: true,
      state: 'healthy',
      message: 'login 연결 정상',
      detail: '특갤 관리자 권한 확인 완료',
      loginUrl: '',
    };
  }

  if (result.hasLoginPrompt) {
    return {
      success: false,
      state: 'logged_out',
      message: '로그아웃 상태입니다.',
      detail: '특갤 페이지에서 로그인 유도 요소가 확인되었습니다.',
      loginUrl: result.loginUrl || buildDefaultLoginUrl(galleryId),
    };
  }

  return {
    success: false,
    state: 'wrong_account_or_no_manager',
    message: '관리자 권한 버튼을 찾지 못했습니다.',
    detail: result.hasForeignManagerButton
      ? '현재 갤러리용 관리자 버튼이 아니라 다른 관리자 버튼만 확인되었습니다.'
      : '로그인 상태이지만 특갤 관리 권한이 없거나 다른 계정일 수 있습니다.',
    loginUrl: '',
  };
}

async function attemptAutoLogin(tabId, loginUrl, galleryId) {
  const userId = String(scheduler.config.dcLoginUserId || '').trim();
  const password = String(scheduler.config.dcLoginPassword || '');

  if (!userId || !password) {
    return {
      success: false,
      state: 'manual_attention_required',
      message: '로그인 자동화 계정 정보를 입력하세요.',
      detail: '디시 아이디/비밀번호가 비어 있습니다.',
    };
  }

  const navigateResult = await navigateTab(tabId, loginUrl || buildDefaultLoginUrl(galleryId));
  const loginPageResult = await executeScriptInTab(tabId, fillAndSubmitLoginForm, [userId, password]);
  if (!loginPageResult?.success) {
    return {
      success: false,
      state: 'manual_attention_required',
      message: loginPageResult?.message || '로그인 폼을 찾지 못했습니다.',
      detail: '',
    };
  }

  const waitResult = await waitForLoginSubmissionResult(tabId, galleryId);
  if (waitResult.state === 'credentials_invalid') {
    return {
      success: false,
      state: 'credentials_invalid',
      message: '식별 코드 또는 비밀번호를 확인해 주세요.',
      detail: 'login/member_check 응답을 받았습니다.',
    };
  }

  if (waitResult.state === 'manual_attention_required') {
    return {
      success: false,
      state: 'manual_attention_required',
      message: waitResult.message,
      detail: '',
    };
  }

  await navigateTab(tabId, buildSessionCheckListUrl(galleryId));
  const sessionResult = await inspectSessionPage(tabId, galleryId);
  if (sessionResult.success) {
    return {
      success: true,
      state: 'healthy',
      message: '자동 로그인 성공',
      detail: sessionResult.detail,
    };
  }

  return {
    success: false,
    state: sessionResult.state === 'wrong_account_or_no_manager'
      ? 'wrong_account_or_no_manager'
      : 'manual_attention_required',
    message: sessionResult.message,
    detail: sessionResult.detail,
  };
}

async function waitForLoginSubmissionResult(tabId, galleryId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOGIN_CHECK_TIMEOUT_MS) {
    await sleep(500);

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return {
        state: 'manual_attention_required',
        message: '로그인 체크 탭을 찾지 못했습니다.',
      };
    }

    const currentUrl = String(tab.url || '');
    if (currentUrl.includes(LOGIN_FAILURE_URL_TOKEN)) {
      return {
        state: 'credentials_invalid',
      };
    }

    if (currentUrl.startsWith(buildGalleryListUrl(galleryId))) {
      return {
        state: 'redirected',
      };
    }
  }

  return {
    state: 'manual_attention_required',
    message: '로그인 제출 결과를 확인하지 못했습니다.',
  };
}

async function refreshLoginHealth(force = false, options = {}) {
  const { allowAutoLogin = false, reason = 'status', passive = false } = options;
  const automationEnabled = scheduler.config.loginAutomationEnabled === true;
  if (!automationEnabled && !passive) {
    setLoginHealthState({
      status: 'disabled',
      message: '로그인 세션 자동화가 비활성화되었습니다.',
      detail: '',
    });
    return getLoginHealthSnapshot();
  }

  const now = Date.now();
  const isCacheValid = (now - loginAutomationState.lastCheckAtMs) < LOGIN_HEALTH_CACHE_MS;
  if (!force && isCacheValid) {
    return getLoginHealthSnapshot();
  }

  if (loginAutomationState.pendingPromise) {
    return loginAutomationState.pendingPromise;
  }

  loginAutomationState.pendingPromise = (async () => {
    try {
      setLoginHealthState({
        status: 'checking',
        message: '로그인 상태 확인 중입니다.',
        detail: '',
      });

      const tab = await ensureSessionCheckTab();
      await refreshSessionCheckSurface(tab.id, scheduler.config.galleryId);
      const sessionResult = await inspectSessionPage(tab.id, scheduler.config.galleryId);

      if (sessionResult.success) {
        resetLoginRetryState();
        setLoginHealthState({
          status: 'healthy',
          message: 'login 연결 정상',
          detail: sessionResult.detail,
        });
        return getLoginHealthSnapshot();
      }

      if (sessionResult.state !== 'logged_out' || !allowAutoLogin || !automationEnabled) {
        setLoginHealthState({
          status: sessionResult.state,
          message: mapLoginStateMessage(sessionResult.state, sessionResult.message),
          detail: sessionResult.detail,
        }, { notify: sessionResult.state !== 'logged_out' });
        return getLoginHealthSnapshot();
      }

      const bypassRetryWindow = reason === 'pre_action' || reason === 'access_failure';
      const retryWindowResult = evaluateLoginRetryWindow(bypassRetryWindow);
      if (!retryWindowResult.canAttempt) {
        setLoginHealthState({
          status: retryWindowResult.status,
          message: retryWindowResult.message,
          detail: retryWindowResult.detail,
        }, { notify: true });
        return getLoginHealthSnapshot();
      }

      loginAutomationState.lastAttemptAt = new Date().toISOString();
      await saveLoginAutomationRuntime();
      setLoginHealthState({
        status: 'retrying',
        message: '자동 로그인 시도 중입니다.',
        detail: `재시도 ${loginAutomationState.retryCount + 1}/${LOGIN_RETRY_MAX}`,
      });

      const loginResult = await attemptAutoLogin(tab.id, sessionResult.loginUrl, scheduler.config.galleryId);
      if (loginResult.success) {
        resetLoginRetryState();
        setLoginHealthState({
          status: 'healthy',
          message: 'login 연결 정상',
          detail: '자동 로그인에 성공했습니다.',
        });
        return getLoginHealthSnapshot();
      }

      registerLoginRetryFailure();
      setLoginHealthState({
        status: loginResult.state,
        message: mapLoginStateMessage(loginResult.state, loginResult.message),
        detail: loginResult.detail || formatRetryDetail(loginResult.state),
      }, { notify: true });
      return getLoginHealthSnapshot();
    } catch (error) {
      setLoginHealthState({
        status: 'manual_attention_required',
        message: `login 상태 확인 실패: ${error.message}`,
        detail: '',
      }, { notify: true });
      return getLoginHealthSnapshot();
    } finally {
      loginAutomationState.pendingPromise = null;
    }
  })();

  return loginAutomationState.pendingPromise;
}

function evaluateLoginRetryWindow(bypassRetryWindow) {
  const now = Date.now();
  if (loginAutomationState.cooldownUntilMs > now) {
    return {
      canAttempt: false,
      status: 'manual_attention_required',
      message: '자동 로그인 재시도 한도 초과',
      detail: `다음 시도 가능: ${formatTimestamp(new Date(loginAutomationState.cooldownUntilMs).toISOString())}`,
    };
  }

  if (!bypassRetryWindow && loginAutomationState.nextRetryAtMs > now) {
    return {
      canAttempt: false,
      status: 'retrying',
      message: '자동 로그인 재시도 대기 중입니다.',
      detail: `다음 재시도: ${formatTimestamp(new Date(loginAutomationState.nextRetryAtMs).toISOString())}`,
    };
  }

  return {
    canAttempt: true,
  };
}

function registerLoginRetryFailure() {
  const jitter = getRetryJitterMs();
  loginAutomationState.retryCount += 1;
  loginAutomationState.nextRetryAtMs = Date.now() + LOGIN_RETRY_BASE_MS + jitter;
  if (loginAutomationState.retryCount >= LOGIN_RETRY_MAX) {
    loginAutomationState.cooldownUntilMs = Date.now() + LOGIN_COOLDOWN_MS;
  }
  void saveLoginAutomationRuntime();
}

function getRetryJitterMs() {
  const randomOffset = Math.floor(Math.random() * ((LOGIN_RETRY_JITTER_MS * 2) + 1));
  return randomOffset - LOGIN_RETRY_JITTER_MS;
}

function formatRetryDetail(state) {
  if (state === 'manual_attention_required' && loginAutomationState.cooldownUntilMs > 0) {
    return `재시도 ${LOGIN_RETRY_MAX}회 실패, 10분 cooldown 적용 중`;
  }

  if (loginAutomationState.nextRetryAtMs > 0) {
    return `다음 재시도: ${formatTimestamp(new Date(loginAutomationState.nextRetryAtMs).toISOString())}`;
  }

  return '';
}

function mapLoginStateMessage(state, fallbackMessage) {
  switch (state) {
    case 'healthy':
      return 'login 연결 정상';
    case 'logged_out':
      return '로그아웃 상태입니다.';
    case 'wrong_account_or_no_manager':
      return '관리자 권한 버튼을 찾지 못했습니다.';
    case 'credentials_invalid':
      return '식별 코드 또는 비밀번호를 확인해 주세요.';
    case 'retrying':
      return '자동 로그인 재시도 중입니다.';
    case 'manual_attention_required':
      return fallbackMessage || '로그인 페이지를 수동으로 확인해 주세요.';
    default:
      return fallbackMessage || 'login 연결실패';
  }
}

async function ensureLoginSessionBeforeAction() {
  if (!scheduler.config.loginAutomationEnabled) {
    return { success: true };
  }

  const snapshot = await refreshLoginHealth(true, { allowAutoLogin: true, reason: 'pre_action' });
  if (snapshot.status === 'healthy') {
    return { success: true };
  }

  return {
    success: false,
    message: snapshot.message || 'login 연결실패',
  };
}

async function handleLoginAccessFailure(payload) {
  return recoverLoginSessionAfterAccessFailure(payload);
}

async function recoverLoginSessionAfterAccessFailure(payload) {
  if (!scheduler.config.loginAutomationEnabled) {
    return {
      attempted: false,
      success: false,
      status: 'disabled',
      message: '로그인 세션 자동화가 비활성화되어 있습니다.',
      detail: '',
    };
  }

  const normalizedFailure = normalizeLoginAccessFailurePayload(payload);
  if (!shouldRecoverLoginFromFailure(normalizedFailure)) {
    return {
      attempted: false,
      success: false,
      status: 'ignored',
      message: '세션 재검증 대상 실패가 아닙니다.',
      detail: '',
    };
  }

  invalidateLoginHealth();
  const snapshot = await refreshLoginHealth(true, {
    allowAutoLogin: true,
    passive: false,
    reason: 'access_failure',
  });

  return {
    attempted: true,
    success: snapshot.status === 'healthy',
    status: snapshot.status,
    message: snapshot.message || 'login 연결실패',
    detail: snapshot.detail || '',
  };
}

function shouldRecoverLoginFromFailure({ normalizedMessage = '', failureType = '' } = {}) {
  const normalizedFailureType = String(failureType || '').trim();
  if (['manager_permission_denied', 'session_access_denied', 'ci_token_missing'].includes(normalizedFailureType)) {
    return true;
  }

  return LOGIN_ACCESS_FAILURE_MESSAGES.some((keyword) => normalizedMessage.includes(keyword));
}

function normalizeLoginAccessFailurePayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      normalizedMessage: normalizeLoginAccessFailureMessage(payload.message),
      failureType: String(payload.failureType || '').trim(),
    };
  }

  return {
    normalizedMessage: normalizeLoginAccessFailureMessage(payload),
    failureType: '',
  };
}

function normalizeLoginAccessFailureMessage(message) {
  return String(message || '').replace(/\s+/g, '').trim();
}

function isSessionCheckTab(tab, targetUrl) {
  const tabId = Number(tab?.id || 0);
  if (!tabId) {
    return false;
  }

  const currentUrl = String(tab?.url || '');
  if (!currentUrl) {
    return false;
  }

  if (currentUrl === targetUrl) {
    return true;
  }

  return currentUrl.includes(SESSION_CHECK_TAB_HASH)
    && (
      currentUrl.startsWith(buildGalleryListUrl())
      || currentUrl.startsWith(buildDefaultLoginUrl())
      || currentUrl.startsWith('https://sign.dcinside.com/login/')
    );
}

function inspectSessionPageDom(galleryId, loginPromptText) {
  const normalizedGalleryId = String(galleryId || '').trim();
  const expectedAdminButtonSelector = `button.btn_useradmin_go[onclick*="/mgallery/management?id=${normalizedGalleryId}"]`;
  const adminButton = document.querySelector(expectedAdminButtonSelector)
    || document.querySelector(`button.btn_useradmin_go[onclick*="id=${normalizedGalleryId}"]`);
  const anyAdminButton = document.querySelector('button.btn_useradmin_go');
  const loginPrompt = [...document.querySelectorAll('strong[onclick]')].find((element) => {
    const text = String(element.textContent || '').trim();
    const onclick = String(element.getAttribute('onclick') || '');
    return text.includes(loginPromptText) && onclick.includes('sign.dcinside.com/login');
  });

  let loginUrl = '';
  if (loginPrompt) {
    const onclick = String(loginPrompt.getAttribute('onclick') || '');
    const match = onclick.match(/location\s*=\s*['"]([^'"]+)['"]/i);
    if (match) {
      loginUrl = match[1];
    }
  }

  return {
    currentUrl: location.href,
    hasManagerButton: Boolean(adminButton),
    hasForeignManagerButton: Boolean(anyAdminButton) && !adminButton,
    hasLoginPrompt: Boolean(loginPrompt),
    loginUrl,
  };
}

function fillAndSubmitLoginForm(userId, password) {
  const idInput = document.querySelector('#id') || document.querySelector('input[name="user_id"]');
  const passwordInput = document.querySelector('#pw') || document.querySelector('input[name="pw"]');
  const submitButton = document.querySelector('button[type="submit"]')
    || document.querySelector('button.btn_blue.small.btn_wfull');

  if (!idInput || !passwordInput || !submitButton) {
    return {
      success: false,
      message: '로그인 페이지 selector를 찾지 못했습니다. 2차 인증/캡차/페이지 변경 가능성이 있습니다.',
    };
  }

  idInput.value = String(userId || '');
  idInput.dispatchEvent(new Event('input', { bubbles: true }));
  idInput.dispatchEvent(new Event('change', { bubbles: true }));

  passwordInput.value = String(password || '');
  passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
  passwordInput.dispatchEvent(new Event('change', { bubbles: true }));

  submitButton.click();
  return { success: true };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
