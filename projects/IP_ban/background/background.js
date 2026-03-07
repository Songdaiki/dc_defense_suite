import { Scheduler } from './scheduler.js';

const scheduler = new Scheduler();

void initializeScheduler();

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] DC IP Ban 설치됨');
  await scheduler.loadState();
  scheduler.ensureRunLoop();
});

self.addEventListener('activate', async () => {
  console.log('[Background] Service Worker 활성화');
  await scheduler.resumeIfNeeded();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Background] 브라우저 시작');
  await scheduler.resumeIfNeeded();
});

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepAlive') {
    return;
  }

  scheduler.resumeIfNeeded().catch((error) => {
    console.error('[Background] keepAlive 복원 실패:', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error('[Background] 메시지 처리 실패:', error);
      sendResponse({ success: false, message: error.message });
    });

  return true;
});

async function initializeScheduler() {
  await scheduler.resumeIfNeeded();
}

async function handleMessage(message) {
  switch (message.action) {
    case 'start':
      await scheduler.start();
      return { success: true, status: scheduler.getStatus() };

    case 'stop':
      await scheduler.stop();
      return { success: true, status: scheduler.getStatus() };

    case 'getStatus':
      return { success: true, status: scheduler.getStatus() };

    case 'updateConfig':
      if (message.config) {
        scheduler.config = { ...scheduler.config, ...message.config };
        await scheduler.saveState();
      }
      return { success: true, config: scheduler.config };

    case 'releaseTrackedBans': {
      const result = await scheduler.releaseTrackedBans();
      return { ...result, status: scheduler.getStatus() };
    }

    case 'resetStats':
      scheduler.totalBanned = 0;
      scheduler.totalReleased = 0;
      scheduler.cycleCount = 0;
      scheduler.logs = [];
      await scheduler.saveState();
      return { success: true, status: scheduler.getStatus() };

    default:
      return { success: false, message: `알 수 없는 action: ${message.action}` };
  }
}
