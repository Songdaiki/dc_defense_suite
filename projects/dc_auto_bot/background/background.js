import { Scheduler } from './scheduler.js';
import { callGeminiModeration, fetchPostPage, resolveConfig } from './api.js';
import { extractPostContentForLlm, normalizeReportTarget, parseTargetUrl } from './parser.js';

const scheduler = new Scheduler();
const LLM_STORAGE_KEY = 'reportBotLlmState';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'openid',
  'email',
].join(' ');

const llmState = {
  accessToken: '',
  expiresAt: 0,
  accountEmail: '',
  lastTestResult: null,
  lastTestAt: '',
  isTesting: false,
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
      return { success: true, status: buildCombinedStatus() };

    case 'start':
      await scheduler.start();
      return { success: true, status: buildCombinedStatus() };

    case 'stop':
      await scheduler.stop();
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

    case 'loginGoogle':
      return loginGoogle();

    case 'logoutGoogle':
      return logoutGoogle();

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
      isAuthenticated: hasValidAccessToken(),
      accountEmail: llmState.accountEmail,
      expiresAt: llmState.expiresAt,
      lastTestAt: llmState.lastTestAt,
      lastTestResult: llmState.lastTestResult,
      isTesting: llmState.isTesting,
      config: {
        googleOAuthClientId: scheduler.config.googleOAuthClientId || '',
        googleCloudProjectId: scheduler.config.googleCloudProjectId || '',
        geminiModel: scheduler.config.geminiModel || 'gemini-2.5-flash',
      },
    },
  };
}

async function loadLlmState() {
  const stored = await chrome.storage.local.get(LLM_STORAGE_KEY);
  const state = stored[LLM_STORAGE_KEY] || {};
  llmState.accessToken = String(state.accessToken || '');
  llmState.expiresAt = Number(state.expiresAt || 0);
  llmState.accountEmail = String(state.accountEmail || '');
  llmState.lastTestResult = state.lastTestResult || null;
  llmState.lastTestAt = String(state.lastTestAt || '');
  llmState.isTesting = false;
}

async function saveLlmState() {
  await chrome.storage.local.set({
    [LLM_STORAGE_KEY]: {
      accessToken: llmState.accessToken,
      expiresAt: llmState.expiresAt,
      accountEmail: llmState.accountEmail,
      lastTestResult: llmState.lastTestResult,
      lastTestAt: llmState.lastTestAt,
    },
  });
}

function hasValidAccessToken() {
  return Boolean(llmState.accessToken) && Number(llmState.expiresAt || 0) > Date.now() + 30000;
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
  nextConfig.googleOAuthClientId = String(nextConfig.googleOAuthClientId || '').trim();
  nextConfig.googleCloudProjectId = String(nextConfig.googleCloudProjectId || '').trim();
  nextConfig.geminiModel = String(nextConfig.geminiModel || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash';

  const reportTargetChanged = previousReportTarget !== nextConfig.reportTarget;
  const galleryChanged = previousGalleryId !== nextConfig.galleryId;

  scheduler.config = nextConfig;

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

async function loginGoogle() {
  const clientId = String(scheduler.config.googleOAuthClientId || '').trim();
  if (!clientId) {
    return {
      success: false,
      message: 'Google OAuth Client ID를 먼저 설정하세요.',
      status: buildCombinedStatus(),
    };
  }

  const redirectUri = chrome.identity.getRedirectURL('oauth2');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  const redirectUrl = new URL(redirect);
  const fragment = new URLSearchParams((redirectUrl.hash || '').replace(/^#/, ''));
  const accessToken = String(fragment.get('access_token') || '').trim();
  const expiresIn = Number(fragment.get('expires_in') || 0);

  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return {
      success: false,
      message: 'OAuth access token을 받지 못했습니다.',
      status: buildCombinedStatus(),
    };
  }

  llmState.accessToken = accessToken;
  llmState.expiresAt = Date.now() + (expiresIn * 1000);
  llmState.accountEmail = await fetchGoogleAccountEmail(accessToken);
  await saveLlmState();
  return { success: true, status: buildCombinedStatus() };
}

async function logoutGoogle() {
  llmState.accessToken = '';
  llmState.expiresAt = 0;
  llmState.accountEmail = '';
  llmState.lastTestResult = null;
  llmState.lastTestAt = '';
  await saveLlmState();
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

async function fetchGoogleAccountEmail(accessToken) {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    return String(data.email || '');
  } catch {
    return '';
  }
}

async function runLlmTest(targetUrl, reportReason) {
  if (!String(scheduler.config.googleCloudProjectId || '').trim()) {
    return { success: false, message: 'Google Cloud Project ID를 먼저 설정하세요.', status: buildCombinedStatus() };
  }

  if (llmState.isTesting) {
    return { success: false, message: '이미 LLM 테스트가 진행 중입니다.', status: buildCombinedStatus() };
  }

  if (!hasValidAccessToken()) {
    return { success: false, message: 'Google 로그인이 필요합니다.', status: buildCombinedStatus() };
  }

  const parsedTarget = parseTargetUrl(targetUrl);
  if (!parsedTarget.success) {
    return { success: false, message: parsedTarget.message, status: buildCombinedStatus() };
  }

  llmState.isTesting = true;
  llmState.lastTestAt = new Date().toISOString();
  llmState.lastTestResult = null;
  await saveLlmState();

  try {
    const llmConfig = resolveConfig({
      ...scheduler.config,
      galleryId: parsedTarget.targetGalleryId || scheduler.config.galleryId,
    });
    const authorCheck = await scheduler.evaluateTargetAuthor(parsedTarget.targetPostNo);
    const authorFilter = mapAuthorFilterResult(authorCheck);
    const pageHtml = await fetchPostPage(llmConfig, parsedTarget.targetPostNo);
    const content = extractPostContentForLlm(pageHtml, llmConfig.baseUrl);
    const result = await callGeminiModeration(
      llmConfig,
      llmState.accessToken,
      {
        targetUrl,
        title: content.title,
        bodyText: content.bodyText,
        imageUrls: content.imageUrls,
        reportReason,
        requestLabel: 'manual_test',
        authorFilter,
      },
    );

    llmState.lastTestResult = {
      targetUrl,
      reportReason,
      title: content.title,
      bodyText: content.bodyText,
      imageUrls: content.imageUrls,
      authorCheck,
      authorFilter,
      ...result,
    };
    llmState.lastTestAt = new Date().toISOString();
    await saveLlmState();
    return { success: true, status: buildCombinedStatus() };
  } catch (error) {
    llmState.lastTestResult = {
      targetUrl,
      success: false,
      message: error.message,
    };
    llmState.lastTestAt = new Date().toISOString();
    await saveLlmState();
    return { success: false, message: error.message, status: buildCombinedStatus() };
  } finally {
    llmState.isTesting = false;
    await saveLlmState();
  }
}
