import { Scheduler } from './scheduler.js';
import { normalizeReportTarget } from './parser.js';

const scheduler = new Scheduler();

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
      return { success: true, status: scheduler.getStatus() };

    case 'start':
      await scheduler.start();
      return { success: true, status: scheduler.getStatus() };

    case 'stop':
      await scheduler.stop();
      return { success: true, status: scheduler.getStatus() };

    case 'updateConfig':
      return updateConfig(message.config || {});

    case 'resetStats':
      if (scheduler.isRunning) {
        return {
          success: false,
          message: '실행 중에는 통계를 초기화할 수 없습니다.',
          status: scheduler.getStatus(),
        };
      }

      scheduler.resetStats();
      await scheduler.saveState();
      return { success: true, status: scheduler.getStatus() };

    case 'addTrustedUser':
      return addTrustedUser(message.userId, message.label);

    case 'removeTrustedUser':
      scheduler.removeTrustedUser(String(message.userId || '').trim());
      await scheduler.saveState();
      return { success: true, status: scheduler.getStatus() };

    default:
      return { success: false, message: `알 수 없는 action: ${message.action}` };
  }
}

async function updateConfig(config) {
  if (scheduler.isRunning) {
    return {
      success: false,
      message: '실행 중에는 설정을 변경할 수 없습니다.',
      status: scheduler.getStatus(),
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
      status: scheduler.getStatus(),
    };
  }

  if (normalization.targetGalleryId && normalization.targetGalleryId !== nextConfig.galleryId) {
    return {
      success: false,
      message: '신문고 게시물 링크의 갤러리 ID가 현재 갤러리 설정과 다릅니다.',
      status: scheduler.getStatus(),
    };
  }

  nextConfig.reportTarget = normalization.reportTarget;
  nextConfig.reportPostNo = normalization.reportPostNo;
  nextConfig.pollIntervalMs = Math.max(1000, Number(nextConfig.pollIntervalMs) || 60000);
  nextConfig.dailyLimitPerUser = Math.max(1, Number(nextConfig.dailyLimitPerUser) || 2);
  nextConfig.commandPrefix = String(nextConfig.commandPrefix || '@특갤봇').trim() || '@특갤봇';
  nextConfig.avoidHour = String(nextConfig.avoidHour || '6');
  nextConfig.avoidReason = String(nextConfig.avoidReason || '4');
  nextConfig.avoidTypeChk = nextConfig.avoidTypeChk !== false;
  nextConfig.deleteTargetPost = nextConfig.deleteTargetPost !== false;

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
  return { success: true, status: scheduler.getStatus() };
}

async function addTrustedUser(userId, label) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedLabel = String(label || '').trim();

  if (!normalizedUserId) {
    return {
      success: false,
      message: 'user_id를 입력하세요.',
      status: scheduler.getStatus(),
    };
  }

  if (!normalizedLabel) {
    return {
      success: false,
      message: 'label을 입력하세요.',
      status: scheduler.getStatus(),
    };
  }

  if (normalizedLabel.length > 20) {
    return {
      success: false,
      message: 'label은 20자 이하로 입력하세요.',
      status: scheduler.getStatus(),
    };
  }

  scheduler.addTrustedUser(normalizedUserId, normalizedLabel);
  await scheduler.saveState();
  return { success: true, status: scheduler.getStatus() };
}
