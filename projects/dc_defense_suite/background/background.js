import { Scheduler as CommentScheduler } from '../features/comment/scheduler.js';
import { Scheduler as PostScheduler } from '../features/post/scheduler.js';
import { Scheduler as IpScheduler } from '../features/ip/scheduler.js';
import { PHASE as MONITOR_PHASE, Scheduler as MonitorScheduler } from '../features/monitor/scheduler.js';

const commentScheduler = new CommentScheduler();
const postScheduler = new PostScheduler();
const ipScheduler = new IpScheduler();
const monitorScheduler = new MonitorScheduler({
  postScheduler,
  ipScheduler,
});

const schedulers = {
  comment: commentScheduler,
  post: postScheduler,
  ip: ipScheduler,
  monitor: monitorScheduler,
};

void initializeSchedulers();

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[DefenseSuite] 설치됨');
  await resumeAllSchedulers();
});

self.addEventListener('activate', async () => {
  console.log('[DefenseSuite] Service Worker 활성화');
  await resumeAllSchedulers();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[DefenseSuite] 브라우저 시작');
  await resumeAllSchedulers();
});

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepAlive') {
    return;
  }

  resumeAllSchedulers().catch((error) => {
    console.error('[DefenseSuite] keepAlive 복원 실패:', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error('[DefenseSuite] 메시지 처리 실패:', error);
      sendResponse({ success: false, message: error.message });
    });

  return true;
});

async function initializeSchedulers() {
  await resumeAllSchedulers();
}

async function loadAllSchedulers() {
  await Promise.all(Object.values(schedulers).map((scheduler) => scheduler.loadState()));
}

function ensureAllRunLoops() {
  Object.values(schedulers).forEach((scheduler) => scheduler.ensureRunLoop());
}

async function resumeAllSchedulers() {
  await loadSchedulerStateIfIdle(schedulers.comment);
  await loadSchedulerStateIfIdle(schedulers.post);
  await loadSchedulerStateIfIdle(schedulers.ip);
  await loadSchedulerStateIfIdle(schedulers.monitor);

  await resumeStandaloneScheduler(schedulers.comment, '🔁 저장된 실행 상태 복원');

  const monitorOwnsChildren = schedulers.monitor.isRunning;
  const monitorAttacking = monitorOwnsChildren && schedulers.monitor.phase === MONITOR_PHASE.ATTACKING;

  if (monitorAttacking) {
    await resumeStandaloneScheduler(schedulers.post, '🔁 감시 자동화 관리 대상 게시글 분류 복원');
    await resumeStandaloneScheduler(schedulers.ip, '🔁 감시 자동화 관리 대상 IP 차단 복원');
  } else if (monitorOwnsChildren) {
    await stopDormantMonitorChildSchedulers();
  } else {
    await resumeStandaloneScheduler(schedulers.post, '🔁 저장된 실행 상태 복원');
    await resumeStandaloneScheduler(schedulers.ip, '🔁 저장된 실행 상태 복원');
  }

  await resumeStandaloneScheduler(schedulers.monitor, '🔁 저장된 자동 감시 상태 복원');

  if (monitorAttacking) {
    await schedulers.monitor.ensureManagedDefensesStarted();
    await schedulers.monitor.saveState();
  }
}

function getScheduler(feature) {
  return schedulers[feature] || null;
}

function getAllStatuses() {
  return {
    comment: schedulers.comment.getStatus(),
    post: schedulers.post.getStatus(),
    ip: schedulers.ip.getStatus(),
    monitor: schedulers.monitor.getStatus(),
  };
}

async function handleMessage(message) {
  if (message.action === 'getAllStatus') {
    return {
      success: true,
      statuses: getAllStatuses(),
    };
  }

  if (message.action === 'updateSharedConfig') {
    const validationMessage = validateSharedConfig(message.config || {});
    if (validationMessage) {
      return {
        success: false,
        message: validationMessage,
        statuses: getAllStatuses(),
      };
    }

    const busyFeatures = getBusyFeatures();
    if (busyFeatures.length > 0) {
      return {
        success: false,
        message: `공통 설정을 바꾸기 전에 먼저 정지하세요: ${busyFeatures.join(', ')}`,
        statuses: getAllStatuses(),
      };
    }

    applySharedConfig(message.config || {});
    await Promise.all(Object.values(schedulers).map((scheduler) => scheduler.saveState()));
    return {
      success: true,
      statuses: getAllStatuses(),
    };
  }

  const scheduler = getScheduler(message.feature);
  if (!scheduler) {
    return {
      success: false,
      message: `알 수 없는 feature: ${message.feature}`,
    };
  }

  const monitorManualLockMessage = getMonitorManualLockMessage(message.feature, message.action);
  if (monitorManualLockMessage) {
    return {
      success: false,
      message: monitorManualLockMessage,
      status: scheduler.getStatus(),
      statuses: getAllStatuses(),
    };
  }

  switch (message.action) {
    case 'start':
      if (message.feature === 'monitor') {
        const startBlockReason = schedulers.monitor.getStartBlockReason();
        if (startBlockReason) {
          return {
            success: false,
            message: startBlockReason,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
          };
        }
      }
      await scheduler.start();
      return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };

    case 'stop':
      await scheduler.stop();
      return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };

    case 'getStatus':
      return { success: true, status: scheduler.getStatus() };

    case 'updateConfig':
      if (message.config) {
        const configUpdateBlockMessage = getConfigUpdateBlockMessage(message.feature, scheduler, message.config);
        if (configUpdateBlockMessage) {
          return {
            success: false,
            message: configUpdateBlockMessage,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
          };
        }

        scheduler.config = { ...scheduler.config, ...message.config };
        await scheduler.saveState();
      }
      return { success: true, status: scheduler.getStatus(), config: scheduler.config, statuses: getAllStatuses() };

    case 'resetStats':
      resetSchedulerStats(message.feature, scheduler);
      await scheduler.saveState();
      return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };

    case 'releaseTrackedBans':
      if (message.feature !== 'ip') {
        return { success: false, message: 'IP 차단 기능에서만 해제를 지원합니다.' };
      }
      return {
        ...(await scheduler.releaseTrackedBans()),
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    default:
      return { success: false, message: `알 수 없는 action: ${message.action}` };
  }
}

function resetSchedulerStats(feature, scheduler) {
  scheduler.cycleCount = 0;
  scheduler.logs = [];

  if (feature === 'comment') {
    scheduler.totalDeleted = 0;
    return;
  }

  if (feature === 'post') {
    scheduler.totalClassified = 0;
    return;
  }

  if (feature === 'ip') {
    scheduler.totalBanned = 0;
    scheduler.totalReleased = 0;
    return;
  }

  if (feature === 'monitor') {
    scheduler.cycleCount = 0;
    scheduler.attackHitCount = 0;
    scheduler.releaseHitCount = 0;
    scheduler.lastMetrics = {
      snapshotPostCount: 0,
      newPostCount: 0,
      newFluidCount: 0,
      fluidRatio: 0,
      newPosts: [],
    };
    scheduler.totalAttackDetected = 0;
    scheduler.totalAttackReleased = 0;
    scheduler.logs = [];
  }
}

function applySharedConfig(config) {
  const galleryId = normalizeSharedString(config.galleryId);
  const headtextId = normalizeSharedString(config.headtextId);
  const galleryChanged = Boolean(galleryId) && (
    schedulers.comment.config.galleryId !== galleryId
    || schedulers.post.config.galleryId !== galleryId
    || schedulers.ip.config.galleryId !== galleryId
    || schedulers.monitor.config.galleryId !== galleryId
  );
  const headtextChanged = Boolean(headtextId) && (
    schedulers.post.config.headtextId !== headtextId
    || schedulers.ip.config.headtextId !== headtextId
  );

  if (galleryId) {
    schedulers.comment.config.galleryId = galleryId;
    schedulers.post.config.galleryId = galleryId;
    schedulers.ip.config.galleryId = galleryId;
    schedulers.monitor.config.galleryId = galleryId;
  }

  if (headtextId) {
    schedulers.post.config.headtextId = headtextId;
    schedulers.ip.config.headtextId = headtextId;
    schedulers.ip.config.headtextName = '';
  }

  if (galleryChanged) {
    resetCommentSchedulerState(`ℹ️ 공통 설정 변경으로 댓글 방어 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetPostSchedulerState(`ℹ️ 공통 설정 변경으로 게시글 분류 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetIpSchedulerState(`ℹ️ 공통 설정 변경으로 IP 차단 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetMonitorSchedulerState(`ℹ️ 공통 설정 변경으로 감시 자동화 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    return;
  }

  if (headtextChanged) {
    resetPostSchedulerState(`ℹ️ 공통 설정 변경으로 게시글 분류 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
    resetIpSchedulerState(`ℹ️ 공통 설정 변경으로 IP 차단 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
  }
}

function normalizeSharedString(value) {
  return String(value ?? '').trim();
}

function validateSharedConfig(config) {
  const galleryId = normalizeSharedString(config.galleryId);
  if (!galleryId) {
    return '갤러리 ID를 입력하세요.';
  }

  if (/\s/.test(galleryId)) {
    return '갤러리 ID에는 공백을 넣을 수 없습니다.';
  }

  const headtextId = normalizeSharedString(config.headtextId);
  if (!/^\d+$/.test(headtextId) || Number(headtextId) <= 0) {
    return '도배기탭 번호는 1 이상의 숫자로 입력하세요.';
  }

  return '';
}

function getBusyFeatures() {
  const busyFeatures = [];

  if (isSchedulerBusy(schedulers.comment)) {
    busyFeatures.push('댓글 방어');
  }

  if (isSchedulerBusy(schedulers.post)) {
    busyFeatures.push('게시글 분류');
  }

  if (isSchedulerBusy(schedulers.ip) || schedulers.ip.isReleaseRunning) {
    busyFeatures.push('IP 차단');
  }

  if (isSchedulerBusy(schedulers.monitor)) {
    busyFeatures.push('감시 자동화');
  }

  return busyFeatures;
}

function isSchedulerBusy(scheduler) {
  return Boolean(scheduler?.isRunning || scheduler?.runPromise);
}

function getConfigUpdateBlockMessage(feature, scheduler, config) {
  if (feature !== 'monitor' || !scheduler.isRunning) {
    return '';
  }

  if (config.monitorPages !== undefined && Number(config.monitorPages) !== Number(scheduler.config.monitorPages)) {
    return '감시 페이지 수는 자동 감시를 정지한 뒤 변경하세요.';
  }

  return '';
}

function getMonitorManualLockMessage(feature, action) {
  if (!schedulers.monitor.isRunning) {
    return '';
  }

  if (!['post', 'ip'].includes(feature)) {
    return '';
  }

  const lockedActions = new Set(['start', 'stop', 'updateConfig', 'releaseTrackedBans']);
  if (!lockedActions.has(action)) {
    return '';
  }

  return '감시 자동화 실행 중에는 게시글 분류 / IP 차단을 수동으로 조작할 수 없습니다.';
}

async function loadSchedulerStateIfIdle(scheduler) {
  if (scheduler.runPromise) {
    return;
  }

  await scheduler.loadState();
}

async function resumeStandaloneScheduler(scheduler, message) {
  if (!scheduler.isRunning || scheduler.runPromise) {
    return;
  }

  scheduler.log(message);
  scheduler.ensureRunLoop();
}

async function stopDormantMonitorChildSchedulers() {
  if (schedulers.post.isRunning) {
    schedulers.post.isRunning = false;
    await schedulers.post.saveState();
  }

  if (schedulers.ip.isRunning) {
    schedulers.ip.isRunning = false;
    await schedulers.ip.saveState();
  }
}

function resetCommentSchedulerState(message) {
  const scheduler = schedulers.comment;
  scheduler.currentPage = 0;
  scheduler.currentPostNo = 0;
  scheduler.totalDeleted = 0;
  scheduler.cycleCount = 0;
  scheduler.logs = [];
  scheduler.log(message);
}

function resetPostSchedulerState(message) {
  const scheduler = schedulers.post;
  scheduler.currentPage = 0;
  scheduler.totalClassified = 0;
  scheduler.cycleCount = 0;
  scheduler.logs = [];
  scheduler.log(message);
}

function resetIpSchedulerState(message) {
  const scheduler = schedulers.ip;
  scheduler.currentPage = 0;
  scheduler.totalBanned = 0;
  scheduler.totalReleased = 0;
  scheduler.cycleCount = 0;
  scheduler.currentRunId = '';
  scheduler.activeBans = [];
  scheduler.isReleaseRunning = false;
  scheduler.logs = [];
  scheduler.log(message);
}

function resetMonitorSchedulerState(message) {
  const scheduler = schedulers.monitor;
  scheduler.phase = MONITOR_PHASE.SEEDING;
  scheduler.currentPollPage = 0;
  scheduler.cycleCount = 0;
  scheduler.attackHitCount = 0;
  scheduler.releaseHitCount = 0;
  scheduler.lastPollAt = '';
  scheduler.lastMetrics = {
    snapshotPostCount: 0,
    newPostCount: 0,
    newFluidCount: 0,
    fluidRatio: 0,
    newPosts: [],
  };
  scheduler.lastSnapshot = [];
  scheduler.attackSessionId = '';
  scheduler.managedPostStarted = false;
  scheduler.managedIpStarted = false;
  scheduler.managedIpRunId = '';
  scheduler.totalAttackDetected = 0;
  scheduler.totalAttackReleased = 0;
  scheduler.logs = [];
  scheduler.log(message);
}
