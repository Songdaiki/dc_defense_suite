import { Scheduler as CommentScheduler } from '../features/comment/scheduler.js';
import { PHASE as COMMENT_MONITOR_PHASE, Scheduler as CommentMonitorScheduler } from '../features/comment-monitor/scheduler.js';
import { Scheduler as ConceptMonitorScheduler } from '../features/concept-monitor/scheduler.js';
import {
  Scheduler as HanRefreshIpBanScheduler,
  normalizeConfig as normalizeHanRefreshIpBanConfig,
} from '../features/han-refresh-ip-ban/scheduler.js';
import { Scheduler as PostScheduler } from '../features/post/scheduler.js';
import { Scheduler as SemiPostScheduler } from '../features/semi-post/scheduler.js';
import { Scheduler as IpScheduler } from '../features/ip/scheduler.js';
import { PHASE as MONITOR_PHASE, Scheduler as MonitorScheduler } from '../features/monitor/scheduler.js';
import {
  getDcSessionBrokerStatus,
  handleDcSessionBrokerAlarm,
  handleDcSessionBrokerTabRemoved,
  initializeDcSessionBroker,
  requestManualSessionSwitch,
  syncDcSessionBrokerSharedConfig,
  updateDcSessionBrokerConfig,
} from './dc-session-broker.js';

const commentScheduler = new CommentScheduler();
const commentMonitorScheduler = new CommentMonitorScheduler({
  commentScheduler,
});
const conceptMonitorScheduler = new ConceptMonitorScheduler();
const hanRefreshIpBanScheduler = new HanRefreshIpBanScheduler();
const postScheduler = new PostScheduler();
const semiPostScheduler = new SemiPostScheduler();
const ipScheduler = new IpScheduler();
const monitorScheduler = new MonitorScheduler({
  postScheduler,
  ipScheduler,
});

const schedulers = {
  comment: commentScheduler,
  commentMonitor: commentMonitorScheduler,
  conceptMonitor: conceptMonitorScheduler,
  hanRefreshIpBan: hanRefreshIpBanScheduler,
  post: postScheduler,
  semiPost: semiPostScheduler,
  ip: ipScheduler,
  monitor: monitorScheduler,
};

let resumeAllSchedulersPromise = null;

void initializeApp();

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
  if (alarm.name === 'keepAlive') {
    resumeAllSchedulers().catch((error) => {
      console.error('[DefenseSuite] keepAlive 복원 실패:', error);
    });
    return;
  }

  handleDcSessionBrokerAlarm(alarm.name).catch((error) => {
    console.error('[DefenseSuite] broker alarm 처리 실패:', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleDcSessionBrokerTabRemoved(tabId).catch((error) => {
    console.error('[DefenseSuite] broker session tab 제거 처리 실패:', error);
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

async function initializeApp() {
  await initializeDcSessionBroker();
  await resumeAllSchedulers();
}

async function loadAllSchedulers() {
  await Promise.all(Object.values(schedulers).map((scheduler) => scheduler.loadState()));
}

function ensureAllRunLoops() {
  Object.values(schedulers).forEach((scheduler) => scheduler.ensureRunLoop());
}

async function resumeAllSchedulers() {
  if (resumeAllSchedulersPromise) {
    return resumeAllSchedulersPromise;
  }

  resumeAllSchedulersPromise = (async () => {
    await initializeDcSessionBroker();

  await loadSchedulerStateIfIdle(schedulers.comment);
  await loadSchedulerStateIfIdle(schedulers.commentMonitor);
  await loadSchedulerStateIfIdle(schedulers.conceptMonitor);
  await loadSchedulerStateIfIdle(schedulers.hanRefreshIpBan);
  await loadSchedulerStateIfIdle(schedulers.post);
  await loadSchedulerStateIfIdle(schedulers.semiPost);
  await loadSchedulerStateIfIdle(schedulers.ip);
  await loadSchedulerStateIfIdle(schedulers.monitor);

  const commentMonitorOwnsChild = schedulers.commentMonitor.isRunning;
  const commentMonitorAttacking = commentMonitorOwnsChild
    && schedulers.commentMonitor.phase === COMMENT_MONITOR_PHASE.ATTACKING;

  if (commentMonitorAttacking) {
    if (typeof schedulers.comment.setCurrentSource === 'function') {
      schedulers.comment.setCurrentSource('monitor', { logChange: false });
      await schedulers.comment.saveState();
    }
    await resumeStandaloneScheduler(schedulers.comment, '🔁 댓글 감시 자동화 관리 대상 댓글 방어 복원');
  } else if (commentMonitorOwnsChild) {
    await stopDormantCommentMonitorChildScheduler();
  } else {
    await resumeStandaloneScheduler(schedulers.comment, '🔁 저장된 실행 상태 복원');
  }

  const monitorOwnsChildren = schedulers.monitor.isRunning;
  const monitorAttacking = monitorOwnsChildren && schedulers.monitor.phase === MONITOR_PHASE.ATTACKING;

  if (monitorAttacking) {
    // 공격 중 복원은 monitor가 initial sweep 순서를 보장하면서 child를 다시 붙인다.
  } else if (monitorOwnsChildren) {
    await stopDormantMonitorChildSchedulers();
  } else {
    await resumeStandaloneScheduler(schedulers.post, '🔁 저장된 실행 상태 복원');
    await resumeStandaloneScheduler(schedulers.ip, '🔁 저장된 실행 상태 복원');
  }

  if (monitorOwnsChildren) {
    await stopDormantSemiPostScheduler();
  } else {
    await resumeStandaloneScheduler(schedulers.semiPost, '🔁 저장된 실행 상태 복원');
  }

  await resumeStandaloneScheduler(schedulers.commentMonitor, '🔁 저장된 댓글 감시 자동화 상태 복원');
  await resumeStandaloneScheduler(schedulers.conceptMonitor, '🔁 저장된 개념글 방어 상태 복원');
  await resumeStandaloneScheduler(schedulers.hanRefreshIpBan, '🔁 저장된 도배기 갱신 차단 자동 상태 복원');

  if (commentMonitorAttacking) {
    await schedulers.commentMonitor.ensureManagedDefenseStarted();
    await schedulers.commentMonitor.saveState();
  }

  if (monitorAttacking) {
    await schedulers.monitor.ensureManagedDefensesStarted();
    await schedulers.monitor.saveState();
  }

  await resumeStandaloneScheduler(schedulers.monitor, '🔁 저장된 자동 감시 상태 복원');
  })().finally(() => {
    resumeAllSchedulersPromise = null;
  });

  return resumeAllSchedulersPromise;
}

function getScheduler(feature) {
  return schedulers[feature] || null;
}

function getAllStatuses() {
  return {
    comment: schedulers.comment.getStatus(),
    commentMonitor: schedulers.commentMonitor.getStatus(),
    conceptMonitor: schedulers.conceptMonitor.getStatus(),
    hanRefreshIpBan: schedulers.hanRefreshIpBan.getStatus(),
    post: schedulers.post.getStatus(),
    semiPost: schedulers.semiPost.getStatus(),
    ip: schedulers.ip.getStatus(),
    monitor: schedulers.monitor.getStatus(),
  };
}

async function handleMessage(message) {
  await initializeDcSessionBroker();

  if (message.action === 'getAllStatus') {
    return {
      success: true,
      statuses: getAllStatuses(),
      sessionFallbackStatus: getDcSessionBrokerStatus(),
    };
  }

  if (message.action === 'getSessionFallbackStatus') {
    return {
      success: true,
      sessionFallbackStatus: getDcSessionBrokerStatus(),
    };
  }

  if (message.action === 'updateSessionFallbackConfig') {
    const validationMessage = validateSessionFallbackConfig(message.config || {});
    if (validationMessage) {
      return {
        success: false,
        message: validationMessage,
        sessionFallbackStatus: getDcSessionBrokerStatus(),
        statuses: getAllStatuses(),
      };
    }

    const currentSessionFallbackStatus = getDcSessionBrokerStatus();
    if (currentSessionFallbackStatus.switchInProgress || currentSessionFallbackStatus.sessionAutomationInProgress) {
      return {
        success: false,
        message: '세션 자동화가 진행 중일 때는 계정 전환 설정을 저장할 수 없습니다.',
        sessionFallbackStatus: currentSessionFallbackStatus,
        statuses: getAllStatuses(),
      };
    }

    const busyFeatures = getBusyFeatures();
    if (busyFeatures.length > 0) {
      return {
        success: false,
        message: `계정 전환 설정을 바꾸기 전에 먼저 정지하세요: ${busyFeatures.join(', ')}`,
        sessionFallbackStatus: getDcSessionBrokerStatus(),
        statuses: getAllStatuses(),
      };
    }

    const updatedSessionFallbackStatus = await updateDcSessionBrokerConfig(message.config || {});
    return {
      success: true,
      sessionFallbackStatus: updatedSessionFallbackStatus,
      statuses: getAllStatuses(),
    };
  }

  if (message.action === 'testSessionFallbackSwitch') {
    const sessionFallbackStatus = getDcSessionBrokerStatus();
    if (sessionFallbackStatus.switchInProgress || sessionFallbackStatus.sessionAutomationInProgress) {
      return {
        success: false,
        message: '세션 자동화가 진행 중일 때는 계정 전환 테스트를 시작할 수 없습니다.',
        sessionFallbackStatus,
        statuses: getAllStatuses(),
      };
    }

    const busyFeatures = getBusyFeatures();
    if (busyFeatures.length > 0) {
      return {
        success: false,
        message: `계정 전환 테스트 전에 먼저 정지하세요: ${busyFeatures.join(', ')}`,
        sessionFallbackStatus: getDcSessionBrokerStatus(),
        statuses: getAllStatuses(),
      };
    }

    const switchResult = await requestManualSessionSwitch();
    return {
      ...switchResult,
      sessionFallbackStatus: getDcSessionBrokerStatus(),
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

    const sessionFallbackStatus = getDcSessionBrokerStatus();
    if (sessionFallbackStatus.switchInProgress || sessionFallbackStatus.sessionAutomationInProgress) {
      return {
        success: false,
        message: '세션 자동화가 진행 중일 때는 공통 설정을 저장할 수 없습니다.',
        statuses: getAllStatuses(),
        sessionFallbackStatus,
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
    await syncDcSessionBrokerSharedConfig({ galleryId: message.config?.galleryId });
    await Promise.all(Object.values(schedulers).map((scheduler) => scheduler.saveState()));
    return {
      success: true,
      statuses: getAllStatuses(),
      sessionFallbackStatus: getDcSessionBrokerStatus(),
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
    maybeLogIpIncludeExistingTargetsFailure(scheduler, message, monitorManualLockMessage);
    return {
      success: false,
      message: monitorManualLockMessage,
      status: scheduler.getStatus(),
      statuses: getAllStatuses(),
    };
  }

  switch (message.action) {
    case 'start':
      if (message.feature === 'monitor' || message.feature === 'commentMonitor') {
        const schedulerWithStartGuard = message.feature === 'monitor'
          ? schedulers.monitor
          : schedulers.commentMonitor;
        const guardedStartBlockReason = schedulerWithStartGuard.getStartBlockReason();
        if (guardedStartBlockReason) {
          return {
            success: false,
            message: guardedStartBlockReason,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
          };
        }
      }
      if (message.feature === 'comment') {
        await scheduler.start({
          source: message.source,
          excludePureHangulOnStart: message.excludePureHangulOnStart,
        });
      } else if (message.feature === 'post') {
        await scheduler.start({
          source: message.source,
          attackMode: message.attackMode,
        });
      } else if (message.feature === 'ip') {
        await scheduler.start({
          source: message.source,
          includeExistingTargetsOnStart: message.includeExistingTargetsOnStart,
        });
      } else {
        await scheduler.start();
      }
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
      };

    case 'stop':
      await scheduler.stop();
      return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };

    case 'getStatus':
      return { success: true, status: scheduler.getStatus() };

    case 'updateConfig':
      if (message.config) {
        if (message.feature === 'post' && message.config.manualAttackMode !== undefined) {
          message.config = {
            ...message.config,
            manualAttackMode: normalizePostManualAttackMode(message.config.manualAttackMode),
          };
        }

        if (message.feature === 'hanRefreshIpBan') {
          message.config = normalizeHanRefreshIpBanConfig({
            ...scheduler.config,
            ...message.config,
          });
        }

        const configUpdateBlockMessage = getConfigUpdateBlockMessage(message.feature, scheduler, message.config);
        if (configUpdateBlockMessage) {
          maybeLogIpIncludeExistingTargetsFailure(scheduler, message, configUpdateBlockMessage);
          return {
            success: false,
            message: configUpdateBlockMessage,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
          };
        }

        if (message.feature === 'post' && scheduler.isRunning && scheduler.currentSource === 'manual') {
          const runningPostModeTransitionResponse = await maybeHandleRunningPostModeTransition(scheduler, message.config);
          if (runningPostModeTransitionResponse) {
            return runningPostModeTransitionResponse;
          }
        }

        if (message.feature === 'conceptMonitor') {
          applyConceptMonitorConfigUpdate(scheduler, message.config);
        }

        if (message.feature === 'ip') {
          maybeLogIpIncludeExistingTargetsToggleChange(scheduler, message.config);
        }
        scheduler.config = { ...scheduler.config, ...message.config };
        await scheduler.saveState();
      }
      return {
        success: true,
        status: scheduler.getStatus(),
        config: scheduler.config,
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
      };

    case 'resetStats':
      resetSchedulerStats(message.feature, scheduler);
      await scheduler.saveState();
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
      };

    case 'releaseTrackedBans':
      if (message.feature !== 'ip') {
        return { success: false, message: 'IP 차단 기능에서만 해제를 지원합니다.' };
      }
      return {
        ...(await scheduler.releaseTrackedBans()),
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
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
    scheduler.resetVerificationState();
    if (!scheduler.isRunning) {
      if (typeof scheduler.setCurrentSource === 'function') {
        scheduler.setCurrentSource('', { logChange: false });
      }
      scheduler.excludePureHangulMode = false;
    }
    return;
  }

  if (feature === 'commentMonitor') {
    scheduler.phase = COMMENT_MONITOR_PHASE.SEEDING;
    scheduler.currentPollPage = 0;
    scheduler.cycleCount = 0;
    scheduler.attackHitCount = 0;
    scheduler.releaseHitCount = 0;
    scheduler.lastPollAt = '';
    scheduler.lastMetrics = {
      snapshotPostCount: 0,
      changedPostCount: 0,
      newCommentCount: 0,
      verifiedDeletedCount: 0,
      topChangedPosts: [],
    };
    scheduler.lastSnapshot = [];
    scheduler.attackSessionId = '';
    scheduler.managedCommentStarted = false;
    scheduler.totalAttackDetected = 0;
    scheduler.totalAttackReleased = 0;
    scheduler.reseedRemaining = 1;
    scheduler.logs = [];
    return;
  }

  if (feature === 'conceptMonitor') {
    scheduler.currentPostNo = 0;
    scheduler.lastPollAt = '';
    scheduler.lastConceptPollAt = '';
    scheduler.lastAutoCutPollAt = '';
    scheduler.cycleCount = 0;
    scheduler.lastScanCount = 0;
    scheduler.lastCandidateCount = 0;
    scheduler.totalDetectedCount = 0;
    scheduler.totalReleasedCount = 0;
    scheduler.totalFailedCount = 0;
    scheduler.totalUnclearCount = 0;
    scheduler.autoCutState = 'NORMAL';
    scheduler.autoCutAttackHitCount = 0;
    scheduler.autoCutReleaseHitCount = 0;
    scheduler.lastRecommendDelta = 0;
    scheduler.lastComparedPostCount = 0;
    scheduler.lastCutChangedAt = '';
    scheduler.lastRecommendSnapshot = [];
    scheduler.lastAppliedRecommendCut = 14;
    scheduler.lastRecommendCutApplySucceeded = true;
    scheduler.blockedUntilTs = 0;
    scheduler.logs = [];
    return;
  }

  if (feature === 'hanRefreshIpBan') {
    scheduler.currentCycleScannedRows = 0;
    scheduler.currentCycleMatchedRows = 0;
    scheduler.currentCycleBanSuccessCount = 0;
    scheduler.currentCycleBanFailureCount = 0;
    scheduler.cycleCount = 0;
    scheduler.logs = [];
    if (!scheduler.isRunning) {
      scheduler.phase = 'IDLE';
      scheduler.currentPage = 0;
      scheduler.detectedMaxPage = 0;
      scheduler.lastRunAt = '';
      scheduler.nextRunAt = '';
    }
    return;
  }

  if (feature === 'post') {
    scheduler.totalClassified = 0;
    if (typeof scheduler.cancelPendingRuntimeTransition === 'function') {
      scheduler.cancelPendingRuntimeTransition('게시글 분류 통계 초기화로 모드 전환을 취소했습니다.');
    }
    if (!scheduler.isRunning) {
      scheduler.clearRuntimeAttackMode();
    }
    return;
  }

  if (feature === 'semiPost') {
    scheduler.totalClassified = 0;
    scheduler.totalSuspiciousUid = 0;
    scheduler.suspiciousUidSet = new Set();
    return;
  }

  if (feature === 'ip') {
    scheduler.totalBanned = 0;
    scheduler.totalReleased = 0;
    scheduler.lastDeleteLimitExceededAt = '';
    scheduler.lastDeleteLimitMessage = '';
    scheduler.runtimeDeleteEnabled = Boolean(scheduler.config?.delChk);
    return;
  }

  if (feature === 'monitor') {
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
    scheduler.totalAttackDetected = 0;
    scheduler.totalAttackReleased = 0;
    scheduler.attackCutoffPostNo = 0;
    scheduler.attackMode = 'default';
    scheduler.attackModeReason = '';
    scheduler.attackModeSampleTitles = [];
    scheduler.initialSweepCompleted = false;
    scheduler.pendingInitialSweepPostNos = [];
    scheduler.pendingInitialSweepPosts = [];
    scheduler.pendingManagedIpBanOnlyPosts = [];
    scheduler.managedPostStarted = false;
    scheduler.managedIpStarted = false;
    scheduler.managedIpDeleteEnabled = true;
    scheduler.logs = [];
  }
}

function applySharedConfig(config) {
  const galleryId = normalizeSharedString(config.galleryId);
  const headtextId = normalizeSharedString(config.headtextId);
  const galleryChanged = Boolean(galleryId) && (
    schedulers.comment.config.galleryId !== galleryId
    || schedulers.commentMonitor.config.galleryId !== galleryId
    || schedulers.conceptMonitor.config.galleryId !== galleryId
    || schedulers.hanRefreshIpBan.config.galleryId !== galleryId
    || schedulers.post.config.galleryId !== galleryId
    || schedulers.semiPost.config.galleryId !== galleryId
    || schedulers.ip.config.galleryId !== galleryId
    || schedulers.monitor.config.galleryId !== galleryId
  );
  const headtextChanged = Boolean(headtextId) && (
    schedulers.post.config.headtextId !== headtextId
    || schedulers.semiPost.config.headtextId !== headtextId
    || schedulers.ip.config.headtextId !== headtextId
  );

  if (galleryId) {
    schedulers.comment.config.galleryId = galleryId;
    schedulers.commentMonitor.config.galleryId = galleryId;
    schedulers.conceptMonitor.config.galleryId = galleryId;
    schedulers.hanRefreshIpBan.config.galleryId = galleryId;
    schedulers.post.config.galleryId = galleryId;
    schedulers.semiPost.config.galleryId = galleryId;
    schedulers.ip.config.galleryId = galleryId;
    schedulers.monitor.config.galleryId = galleryId;
  }

  if (headtextId) {
    schedulers.post.config.headtextId = headtextId;
    schedulers.semiPost.config.headtextId = headtextId;
    schedulers.ip.config.headtextId = headtextId;
    schedulers.ip.config.headtextName = '';
  }

  if (galleryChanged) {
    resetCommentSchedulerState(`ℹ️ 공통 설정 변경으로 댓글 방어 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetCommentMonitorSchedulerState(`ℹ️ 공통 설정 변경으로 댓글 감시 자동화 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetConceptMonitorSchedulerState(`ℹ️ 공통 설정 변경으로 개념글 방어 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetHanRefreshIpBanSchedulerState(`ℹ️ 공통 설정 변경으로 도배기 갱신 차단 자동 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetPostSchedulerState(`ℹ️ 공통 설정 변경으로 게시글 분류 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetSemiPostSchedulerState(`ℹ️ 공통 설정 변경으로 반고닉 분류 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetIpSchedulerState(`ℹ️ 공통 설정 변경으로 IP 차단 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetMonitorSchedulerState(`ℹ️ 공통 설정 변경으로 감시 자동화 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    return;
  }

  if (headtextChanged) {
    resetPostSchedulerState(`ℹ️ 공통 설정 변경으로 게시글 분류 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
    resetSemiPostSchedulerState(`ℹ️ 공통 설정 변경으로 반고닉 분류 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
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

function validateSessionFallbackConfig(config) {
  const primaryUserId = String(config.primaryUserId || '').trim();
  const primaryPassword = String(config.primaryPassword || '');
  const backupUserId = String(config.backupUserId || '').trim();
  const backupPassword = String(config.backupPassword || '');

  if ((primaryUserId && !primaryPassword) || (!primaryUserId && primaryPassword)) {
    return '계정1 아이디와 비밀번호를 모두 입력하세요.';
  }

  if ((backupUserId && !backupPassword) || (!backupUserId && backupPassword)) {
    return '계정2 아이디와 비밀번호를 모두 입력하세요.';
  }

  return '';
}

function getBusyFeatures() {
  const busyFeatures = [];

  if (isSchedulerBusy(schedulers.comment)) {
    busyFeatures.push('댓글 방어');
  }

  if (isSchedulerBusy(schedulers.commentMonitor)) {
    busyFeatures.push('댓글 감시 자동화');
  }

  if (isSchedulerBusy(schedulers.conceptMonitor)) {
    busyFeatures.push('개념글 방어');
  }

  if (isSchedulerBusy(schedulers.hanRefreshIpBan)) {
    busyFeatures.push('도배기 갱신 차단 자동');
  }

  if (isSchedulerBusy(schedulers.post)) {
    busyFeatures.push('게시글 분류');
  }

  if (isSchedulerBusy(schedulers.semiPost)) {
    busyFeatures.push('반고닉 분류');
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
  if (!scheduler.isRunning) {
    return '';
  }

  if (feature === 'monitor'
    && config.monitorPages !== undefined
    && Number(config.monitorPages) !== Number(scheduler.config.monitorPages)) {
    return '감시 페이지 수는 자동 감시를 정지한 뒤 변경하세요.';
  }

  if (feature === 'commentMonitor'
    && config.monitorPages !== undefined
    && Number(config.monitorPages) !== Number(scheduler.config.monitorPages)) {
    return '댓글 감시 페이지 수는 댓글 감시 자동화를 정지한 뒤 변경하세요.';
  }

  if (feature === 'conceptMonitor'
    && config.testMode !== undefined
    && Boolean(config.testMode) !== Boolean(scheduler.config.testMode)) {
    return '테스트 모드는 개념글 방어를 정지한 뒤 변경하세요.';
  }

  return '';
}

function getMonitorManualLockMessage(feature, action) {
  if (feature === 'monitor'
    && action === 'start'
    && (schedulers.semiPost.isRunning || schedulers.semiPost.runPromise)) {
    return '감시 자동화를 시작하기 전에 반고닉 분류를 먼저 정지하세요.';
  }

  const baseLockedActions = new Set(['start', 'stop', 'updateConfig', 'resetStats', 'releaseTrackedBans']);
  if (schedulers.monitor.isRunning && ['post', 'semiPost', 'ip'].includes(feature) && baseLockedActions.has(action)) {
    return '감시 자동화 실행 중에는 게시글 분류 / 반고닉 분류 / IP 차단을 수동으로 조작할 수 없습니다.';
  }

  if (schedulers.monitor.isRunning
    && feature === 'monitor'
    && action === 'resetStats') {
    return '감시 자동화 실행 중에는 통계와 로그를 초기화할 수 없습니다.';
  }

  if (schedulers.commentMonitor.isRunning && feature === 'commentMonitor' && action === 'resetStats') {
    return '댓글 감시 자동화 실행 중에는 통계와 로그를 초기화할 수 없습니다.';
  }

  const commentMonitorLockedActions = new Set(['start', 'stop', 'updateConfig', 'resetStats']);
  if (schedulers.commentMonitor.isRunning && feature === 'comment' && commentMonitorLockedActions.has(action)) {
    return '댓글 감시 자동화 실행 중에는 댓글 방어를 수동으로 조작할 수 없습니다.';
  }

  return '';
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
    if (typeof schedulers.post.cancelPendingRuntimeTransition === 'function') {
      schedulers.post.cancelPendingRuntimeTransition('감시 자동화 child 정리로 게시글 분류 모드 전환을 취소했습니다.');
    }
    schedulers.post.clearRuntimeAttackMode();
    await schedulers.post.saveState();
  }

  if (schedulers.ip.isRunning) {
    schedulers.ip.isRunning = false;
    await schedulers.ip.saveState();
  }
}

async function stopDormantSemiPostScheduler() {
  if (!schedulers.semiPost.isRunning) {
    return;
  }

  await schedulers.semiPost.stop();
}

async function stopDormantCommentMonitorChildScheduler() {
  if (!schedulers.comment.isRunning) {
    return;
  }

  schedulers.comment.isRunning = false;
  if (typeof schedulers.comment.setCurrentSource === 'function') {
    schedulers.comment.setCurrentSource('', { logChange: false });
  }
  await schedulers.comment.saveState();
}

function resetCommentSchedulerState(message) {
  const scheduler = schedulers.comment;
  scheduler.currentPage = 0;
  scheduler.currentPostNo = 0;
  scheduler.totalDeleted = 0;
  scheduler.cycleCount = 0;
  scheduler.resetVerificationState();
  if (typeof scheduler.setCurrentSource === 'function') {
    scheduler.setCurrentSource('', { logChange: false });
  }
  scheduler.logs = [];
  scheduler.log(message);
}

function resetCommentMonitorSchedulerState(message) {
  const scheduler = schedulers.commentMonitor;
  scheduler.phase = COMMENT_MONITOR_PHASE.SEEDING;
  scheduler.currentPollPage = 0;
  scheduler.cycleCount = 0;
  scheduler.attackHitCount = 0;
  scheduler.releaseHitCount = 0;
  scheduler.lastPollAt = '';
  scheduler.lastMetrics = {
    snapshotPostCount: 0,
    changedPostCount: 0,
    newCommentCount: 0,
    verifiedDeletedCount: 0,
    topChangedPosts: [],
  };
  scheduler.lastSnapshot = [];
  scheduler.attackSessionId = '';
  scheduler.managedCommentStarted = false;
  scheduler.totalAttackDetected = 0;
  scheduler.totalAttackReleased = 0;
  scheduler.reseedRemaining = 1;
  scheduler.logs = [];
  scheduler.log(message);
}

function resetConceptMonitorSchedulerState(message) {
  const scheduler = schedulers.conceptMonitor;
  scheduler.currentPostNo = 0;
  scheduler.lastPollAt = '';
  scheduler.lastConceptPollAt = '';
  scheduler.lastAutoCutPollAt = '';
  scheduler.cycleCount = 0;
  scheduler.lastScanCount = 0;
  scheduler.lastCandidateCount = 0;
  scheduler.totalDetectedCount = 0;
  scheduler.totalReleasedCount = 0;
  scheduler.totalFailedCount = 0;
  scheduler.totalUnclearCount = 0;
  scheduler.autoCutState = 'NORMAL';
  scheduler.autoCutAttackHitCount = 0;
  scheduler.autoCutReleaseHitCount = 0;
  scheduler.lastRecommendDelta = 0;
  scheduler.lastComparedPostCount = 0;
  scheduler.lastCutChangedAt = '';
  scheduler.lastRecommendSnapshot = [];
  scheduler.lastAppliedRecommendCut = 14;
  scheduler.lastRecommendCutApplySucceeded = true;
  scheduler.blockedUntilTs = 0;
  scheduler.logs = [];
  scheduler.log(message);
}

function resetHanRefreshIpBanSchedulerState(message) {
  const scheduler = schedulers.hanRefreshIpBan;
  scheduler.phase = 'IDLE';
  scheduler.currentPage = 0;
  scheduler.detectedMaxPage = 0;
  scheduler.currentCycleScannedRows = 0;
  scheduler.currentCycleMatchedRows = 0;
  scheduler.currentCycleBanSuccessCount = 0;
  scheduler.currentCycleBanFailureCount = 0;
  scheduler.cycleCount = 0;
  scheduler.lastRunAt = '';
  scheduler.nextRunAt = '';
  scheduler.logs = [];
  scheduler.log(message);
}

function applyConceptMonitorConfigUpdate(scheduler, config) {
  if (!scheduler || !config) {
    return;
  }

  const currentEnabled = Boolean(scheduler.config?.autoCutEnabled);
  const nextEnabled = config.autoCutEnabled === undefined
    ? currentEnabled
    : Boolean(config.autoCutEnabled);

  if (!currentEnabled && nextEnabled) {
    scheduler.resetAutoCutState('ℹ️ 개념컷 자동조절 활성화 - NORMAL 기준으로 감시를 시작합니다.');
    return;
  }

  if (currentEnabled && !nextEnabled) {
    scheduler.resetAutoCutState('ℹ️ 개념컷 자동조절 비활성화 - 상태를 초기화했습니다.');
  }
}

function resetPostSchedulerState(message) {
  const scheduler = schedulers.post;
  scheduler.currentPage = 0;
  scheduler.totalClassified = 0;
  scheduler.cycleCount = 0;
  if (typeof scheduler.cancelPendingRuntimeTransition === 'function') {
    scheduler.cancelPendingRuntimeTransition('게시글 분류 상태 초기화로 모드 전환을 취소했습니다.');
  }
  scheduler.clearRuntimeAttackMode();
  scheduler.config.cutoffPostNo = 0;
  scheduler.logs = [];
  scheduler.log(message);
}

async function maybeHandleRunningPostModeTransition(scheduler, config) {
  const currentManualAttackMode = normalizePostManualAttackMode(scheduler.config?.manualAttackMode);
  const nextManualAttackMode = config.manualAttackMode === undefined
    ? currentManualAttackMode
    : normalizePostManualAttackMode(config.manualAttackMode);

  if (currentManualAttackMode === nextManualAttackMode) {
    return null;
  }

  try {
    await scheduler.transitionManualAttackModeWhileRunning({
      ...config,
      manualAttackMode: nextManualAttackMode,
    });
    return {
      success: true,
      status: scheduler.getStatus(),
      config: scheduler.config,
      statuses: getAllStatuses(),
    };
  } catch (error) {
    return {
      success: false,
      message: error.message,
      status: scheduler.getStatus(),
      statuses: getAllStatuses(),
    };
  }
}

function normalizePostManualAttackMode(value) {
  return value === 'cjk_narrow' ? 'cjk_narrow' : 'default';
}

function resetSemiPostSchedulerState(message) {
  const scheduler = schedulers.semiPost;
  scheduler.currentPage = 0;
  scheduler.totalClassified = 0;
  scheduler.totalSuspiciousUid = 0;
  scheduler.suspiciousUidSet = new Set();
  scheduler.cycleCount = 0;
  scheduler.logs = [];
  scheduler.log(message);
}

function maybeLogIpIncludeExistingTargetsToggleChange(scheduler, config = {}) {
  if (config.includeExistingTargetsOnStart === undefined) {
    return;
  }

  const currentValue = Boolean(scheduler.config?.includeExistingTargetsOnStart);
  const nextValue = Boolean(config.includeExistingTargetsOnStart);
  if (currentValue === nextValue) {
    return;
  }

  scheduler.log(
    nextValue
      ? '🧹 도배기탭 삭제기 ON - 다음에 수동 IP차단을 시작하면, 이미 올라와 있던 도배기탭 글도 같이 처리합니다.'
      : '📭 도배기탭 삭제기 OFF - 다음에 수동 IP차단을 시작하면, 새로 올라온 도배기탭 글만 처리합니다.',
  );
}

function maybeLogIpIncludeExistingTargetsFailure(scheduler, message = {}, errorMessage = '') {
  if (!scheduler || message.feature !== 'ip') {
    return;
  }

  const includeExistingTouched = message.action === 'start'
    || message.config?.includeExistingTargetsOnStart !== undefined;
  if (!includeExistingTouched) {
    return;
  }

  const normalizedMessage = String(errorMessage || '').trim();
  if (!normalizedMessage) {
    return;
  }

  scheduler.log(`⚠️ 도배기탭 삭제기 반영 실패 - ${normalizedMessage}`);
}

function resetIpSchedulerState(message) {
  const scheduler = schedulers.ip;
  scheduler.currentPage = 0;
  scheduler.totalBanned = 0;
  scheduler.totalReleased = 0;
  scheduler.cycleCount = 0;
  scheduler.currentRunId = '';
  scheduler.currentSource = 'manual';
  scheduler.includeExistingTargetsMode = false;
  scheduler.activeBans = [];
  scheduler.isReleaseRunning = false;
  scheduler.runtimeDeleteEnabled = false;
  scheduler.lastDeleteLimitExceededAt = '';
  scheduler.lastDeleteLimitMessage = '';
  scheduler.config.cutoffPostNo = 0;
  scheduler.config.delChk = false;
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
  scheduler.attackCutoffPostNo = 0;
  scheduler.attackMode = 'default';
  scheduler.attackModeReason = '';
  scheduler.attackModeSampleTitles = [];
  scheduler.initialSweepCompleted = false;
  scheduler.pendingInitialSweepPostNos = [];
  scheduler.pendingInitialSweepPosts = [];
  scheduler.pendingManagedIpBanOnlyPosts = [];
  scheduler.managedPostStarted = false;
  scheduler.managedIpStarted = false;
  scheduler.managedIpDeleteEnabled = true;
  scheduler.totalAttackDetected = 0;
  scheduler.totalAttackReleased = 0;
  scheduler.logs = [];
  scheduler.log(message);
}
