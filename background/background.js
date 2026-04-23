import { Scheduler as CommentScheduler } from '../features/comment/scheduler.js';
import { PHASE as COMMENT_MONITOR_PHASE, Scheduler as CommentMonitorScheduler } from '../features/comment-monitor/scheduler.js';
import { COMMENT_ATTACK_MODE, normalizeCommentAttackMode } from '../features/comment/attack-mode.js';
import { Scheduler as ConceptMonitorScheduler } from '../features/concept-monitor/scheduler.js';
import {
  handleConceptRecommendCutCoordinatorAlarm,
  initializeConceptRecommendCutCoordinator,
  resetConceptRecommendCutCoordinator,
} from '../features/concept-monitor/recommend-cut-coordinator.js';
import {
  Scheduler as ConceptPatrolScheduler,
  normalizeConfig as normalizeConceptPatrolConfig,
} from '../features/concept-patrol/scheduler.js';
import {
  Scheduler as HanRefreshIpBanScheduler,
  normalizeConfig as normalizeHanRefreshIpBanConfig,
} from '../features/han-refresh-ip-ban/scheduler.js';
import {
  Scheduler as BumpPostScheduler,
  normalizeConfig as normalizeBumpPostConfig,
} from '../features/bump-post/scheduler.js';
import {
  Scheduler as SinmungoCommentScheduler,
  normalizeConfig as normalizeSinmungoCommentConfig,
} from '../features/sinmungo-comment/scheduler.js';
import { getAgentBaseUrlValidationMessage } from '../features/self-hosted-vpn/api.js';
import {
  Scheduler as SelfHostedVpnScheduler,
  normalizeConfig as normalizeSelfHostedVpnConfig,
} from '../features/self-hosted-vpn/scheduler.js';
import {
  Scheduler as RefluxDatasetCollectorScheduler,
  normalizeConfig as normalizeRefluxDatasetCollectorConfig,
} from '../features/reflux-dataset-collector/scheduler.js';
import { isValidGalleryId as isValidRefluxCollectorGalleryId } from '../features/reflux-dataset-collector/api.js';
import {
  Scheduler as RefluxOverlayCollectorScheduler,
  normalizeConfig as normalizeRefluxOverlayCollectorConfig,
} from '../features/reflux-overlay-collector/scheduler.js';
import {
  clearAllOverlays as clearSemiconductorRefluxOverlays,
  deleteOverlay as deleteSemiconductorRefluxOverlay,
  listOverlayMetas as listSemiconductorRefluxOverlayMetas,
} from '../features/post/semiconductor-reflux-overlay-store.js';
import { parseValidatedViewUrl } from '../features/reflux-overlay-collector/api.js';
import { reloadSemiconductorRefluxEffectiveMatcher } from '../features/post/semiconductor-reflux-effective-matcher.js';
import {
  Scheduler as CommentRefluxCollectorScheduler,
  normalizeConfig as normalizeCommentRefluxCollectorConfig,
} from '../features/comment-reflux-collector/scheduler.js';
import { isValidGalleryId as isValidCommentRefluxCollectorGalleryId } from '../features/comment-reflux-collector/api.js';
import {
  Scheduler as TrustedCommentCommandDefenseScheduler,
  normalizeConfig as normalizeTrustedCommentCommandDefenseConfig,
} from '../features/trusted-comment-command-defense/scheduler.js';
import { parseCommandPostTarget } from '../features/trusted-comment-command-defense/parser.js';
import { Scheduler as PostScheduler } from '../features/post/scheduler.js';
import { ATTACK_MODE as POST_ATTACK_MODE, normalizeAttackMode as normalizePostAttackMode } from '../features/post/attack-mode.js';
import {
  isValidRefluxSearchGalleryId,
  normalizeRefluxSearchGalleryId,
  resolveRefluxSearchGalleryId,
} from '../features/reflux-search-gallery-id.js';
import { Scheduler as SemiPostScheduler } from '../features/semi-post/scheduler.js';
import { Scheduler as IpScheduler } from '../features/ip/scheduler.js';
import {
  Scheduler as UidWarningAutoBanScheduler,
  normalizeConfig as normalizeUidWarningAutoBanConfig,
} from '../features/uid-warning-autoban/scheduler.js';
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
import {
  getUidRatioWarningStatusForActiveTab,
  handleUidRatioWarningTabActivated,
  handleUidRatioWarningTabRemoved,
  handleUidRatioWarningTabUpdated,
  resumeUidRatioWarningForActiveTab,
  toggleUidRatioWarningForActiveTab,
} from './uid-ratio-warning.js';

let trustedCommandDefenseScheduler = null;

const commentScheduler = new CommentScheduler();
const commentMonitorScheduler = new CommentMonitorScheduler({
  commentScheduler,
  isTrustedOwnedFeature: (feature) => trustedCommandDefenseScheduler?.isOwningFeature(feature) === true,
});
const conceptMonitorScheduler = new ConceptMonitorScheduler();
const conceptPatrolScheduler = new ConceptPatrolScheduler({
  conceptMonitorScheduler,
});
const hanRefreshIpBanScheduler = new HanRefreshIpBanScheduler();
const bumpPostScheduler = new BumpPostScheduler();
const sinmungoCommentScheduler = new SinmungoCommentScheduler();
const selfHostedVpnScheduler = new SelfHostedVpnScheduler();
const refluxDatasetCollectorScheduler = new RefluxDatasetCollectorScheduler();
const refluxOverlayCollectorScheduler = new RefluxOverlayCollectorScheduler();
const commentRefluxCollectorScheduler = new CommentRefluxCollectorScheduler();
const postScheduler = new PostScheduler();
const semiPostScheduler = new SemiPostScheduler();
const ipScheduler = new IpScheduler();
trustedCommandDefenseScheduler = new TrustedCommentCommandDefenseScheduler({
  commentScheduler,
  postScheduler,
  ipScheduler,
  shouldAllowPostDefenseStart: () => (
    !isMonitorManagingPostAxis()
    && (!schedulers.post.isRunning || schedulers.trustedCommandDefense.isOwningFeature('post'))
    && (!schedulers.ip.isRunning || schedulers.trustedCommandDefense.isOwningFeature('ip'))
  ),
  shouldAllowCommentDefenseStart: () => (
    !isCommentMonitorManagingCommentAxis()
    && (!schedulers.comment.isRunning || schedulers.trustedCommandDefense.isOwningFeature('comment'))
  ),
});
const uidWarningAutoBanScheduler = new UidWarningAutoBanScheduler();
const monitorScheduler = new MonitorScheduler({
  postScheduler,
  ipScheduler,
  uidWarningAutoBanScheduler,
  isTrustedOwnedFeature: (feature) => trustedCommandDefenseScheduler?.isOwningFeature(feature) === true,
});

const schedulers = {
  comment: commentScheduler,
  commentMonitor: commentMonitorScheduler,
  conceptMonitor: conceptMonitorScheduler,
  conceptPatrol: conceptPatrolScheduler,
  hanRefreshIpBan: hanRefreshIpBanScheduler,
  bumpPost: bumpPostScheduler,
  sinmungoComment: sinmungoCommentScheduler,
  selfHostedVpn: selfHostedVpnScheduler,
  refluxDatasetCollector: refluxDatasetCollectorScheduler,
  refluxOverlayCollector: refluxOverlayCollectorScheduler,
  commentRefluxCollector: commentRefluxCollectorScheduler,
  trustedCommandDefense: trustedCommandDefenseScheduler,
  post: postScheduler,
  semiPost: semiPostScheduler,
  ip: ipScheduler,
  uidWarningAutoBan: uidWarningAutoBanScheduler,
  monitor: monitorScheduler,
};

let resumeAllSchedulersPromise = null;
let initialSchedulerResumeCompleted = false;

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

  handleConceptRecommendCutCoordinatorAlarm(alarm.name)
    .then((handled) => {
      if (handled) {
        return;
      }

      return handleDcSessionBrokerAlarm(alarm.name);
    })
    .catch((error) => {
      console.error('[DefenseSuite] broker/concept cut alarm 처리 실패:', error);
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleDcSessionBrokerTabRemoved(tabId).catch((error) => {
    console.error('[DefenseSuite] broker session tab 제거 처리 실패:', error);
  });
  handleUidRatioWarningTabRemoved(tabId).catch((error) => {
    console.error('[DefenseSuite] uid 경고 탭 제거 정리 실패:', error);
  });
  if (typeof schedulers.sinmungoComment?.handleTrackedTabRemoved === 'function') {
    schedulers.sinmungoComment.handleTrackedTabRemoved(tabId).catch((error) => {
      console.error('[DefenseSuite] 신문고 댓글 인증코드 탭 제거 처리 실패:', error);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  handleUidRatioWarningTabUpdated(tabId, changeInfo, tab).catch((error) => {
    console.error('[DefenseSuite] uid 경고 탭 갱신 처리 실패:', error);
  });
  if (typeof schedulers.sinmungoComment?.handleTrackedTabUpdated === 'function') {
    schedulers.sinmungoComment.handleTrackedTabUpdated(tabId, changeInfo, tab).catch((error) => {
      console.error('[DefenseSuite] 신문고 댓글 인증코드 탭 갱신 처리 실패:', error);
    });
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  handleUidRatioWarningTabActivated(activeInfo).catch((error) => {
    console.error('[DefenseSuite] uid 경고 탭 활성화 처리 실패:', error);
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
  await initializeConceptRecommendCutCoordinator();
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
    await initializeConceptRecommendCutCoordinator();
    await initializeDcSessionBroker();

    await loadSchedulerStateIfIdle(schedulers.comment);
    await loadSchedulerStateIfIdle(schedulers.commentMonitor);
    await loadSchedulerStateIfIdle(schedulers.conceptMonitor);
    await loadSchedulerStateIfIdle(schedulers.conceptPatrol);
    await loadSchedulerStateIfIdle(schedulers.hanRefreshIpBan);
    await loadSchedulerStateIfIdle(schedulers.bumpPost);
    await loadSchedulerStateIfIdle(schedulers.sinmungoComment);
    await loadSchedulerStateIfIdle(schedulers.selfHostedVpn);
    await loadSchedulerStateIfIdle(schedulers.refluxDatasetCollector);
    await loadSchedulerStateIfIdle(schedulers.refluxOverlayCollector);
    await loadSchedulerStateIfIdle(schedulers.commentRefluxCollector);
    await loadSchedulerStateIfIdle(schedulers.trustedCommandDefense);
    await loadSchedulerStateIfIdle(schedulers.post);
    await loadSchedulerStateIfIdle(schedulers.semiPost);
    await loadSchedulerStateIfIdle(schedulers.ip);
    await loadSchedulerStateIfIdle(schedulers.uidWarningAutoBan);
    await loadSchedulerStateIfIdle(schedulers.monitor);

    const trustedCommentDefenseActive = schedulers.trustedCommandDefense.isRunning
      && schedulers.trustedCommandDefense.isCommentDefenseActive();
    const trustedPostDefenseActive = schedulers.trustedCommandDefense.isRunning
      && schedulers.trustedCommandDefense.isPostDefenseActive();

    const commentMonitorOwnsChild = schedulers.commentMonitor.isRunning
      && !trustedCommentDefenseActive
      && (
        schedulers.commentMonitor.managedCommentStarted
        || [COMMENT_MONITOR_PHASE.ATTACKING, COMMENT_MONITOR_PHASE.RECOVERING].includes(schedulers.commentMonitor.phase)
      );
    const commentMonitorAttacking = commentMonitorOwnsChild
      && schedulers.commentMonitor.phase === COMMENT_MONITOR_PHASE.ATTACKING;

    if (trustedCommentDefenseActive) {
      await schedulers.trustedCommandDefense.ensureOwnedDefensesStarted({
        allowPostDefense: false,
        allowCommentDefense: true,
      });
    } else if (commentMonitorAttacking) {
      if (typeof schedulers.comment.setCurrentSource === 'function') {
        schedulers.comment.setCurrentSource('monitor', { logChange: false });
      }
      if (typeof schedulers.comment.setRuntimeAttackMode === 'function') {
        try {
          await schedulers.comment.setRuntimeAttackMode(
            schedulers.commentMonitor.currentManagedAttackMode || COMMENT_ATTACK_MODE.DEFAULT,
            { logChange: false },
          );
        } catch (error) {
          schedulers.commentMonitor.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
          schedulers.commentMonitor.lastManagedAttackModeReason = `${error.message} / 기본 댓글 방어 fallback`;
          await schedulers.comment.setRuntimeAttackMode(COMMENT_ATTACK_MODE.DEFAULT, { logChange: false });
        }
      }
      await schedulers.comment.saveState();
      await resumeStandaloneScheduler(schedulers.comment, '🔁 댓글 감시 자동화 관리 대상 댓글 방어 복원');
    } else if (commentMonitorOwnsChild) {
      await stopDormantCommentMonitorChildScheduler();
    } else {
      await resumeStandaloneScheduler(schedulers.comment, '🔁 저장된 실행 상태 복원');
    }

    const monitorOwnsChildren = schedulers.monitor.isRunning
      && !trustedPostDefenseActive
      && (
        schedulers.monitor.managedPostStarted
        || schedulers.monitor.managedIpStarted
        || [MONITOR_PHASE.ATTACKING, MONITOR_PHASE.RECOVERING].includes(schedulers.monitor.phase)
      );
    const monitorAttacking = monitorOwnsChildren && schedulers.monitor.phase === MONITOR_PHASE.ATTACKING;

    if (trustedPostDefenseActive) {
      await schedulers.trustedCommandDefense.ensureOwnedDefensesStarted({
        allowPostDefense: true,
        allowCommentDefense: false,
      });
    } else if (monitorAttacking) {
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
    await resumeStandaloneScheduler(schedulers.trustedCommandDefense, '🔁 저장된 명령 방어 상태 복원');
    await resumeStandaloneScheduler(schedulers.conceptMonitor, '🔁 저장된 개념글 방어 상태 복원');
    await resumeStandaloneScheduler(schedulers.conceptPatrol, '🔁 저장된 개념글순회 상태 복원');
    await resumeStandaloneScheduler(schedulers.hanRefreshIpBan, '🔁 저장된 도배기 갱신 차단 자동 상태 복원');
    await resumeStandaloneScheduler(schedulers.bumpPost, '🔁 저장된 끌올 자동 상태 복원');
    await resumeStandaloneScheduler(schedulers.sinmungoComment, '🔁 저장된 신문고 댓글 등록 상태 복원');
    await resumeStandaloneScheduler(schedulers.selfHostedVpn, '🔁 저장된 자체 VPN 테스트 상태 복원');
    await resolveUidWarningAutoBanResumeConflict();
    await resumeStandaloneScheduler(schedulers.uidWarningAutoBan, '🔁 저장된 분탕자동차단 상태 복원');
    await resumeUidRatioWarningForActiveTab();

    if (typeof schedulers.conceptMonitor.syncRecommendCutCoordinator === 'function') {
      await schedulers.conceptMonitor.syncRecommendCutCoordinator({ forceKcaptchaRefresh: true });
      await schedulers.conceptMonitor.saveState();
    }

    if (commentMonitorAttacking) {
      await schedulers.commentMonitor.ensureManagedDefenseStarted();
      await schedulers.commentMonitor.saveState();
    }

    if (monitorAttacking) {
      await schedulers.monitor.ensureManagedDefensesStarted();
      await schedulers.monitor.saveState();
    }

    await resumeStandaloneScheduler(schedulers.monitor, '🔁 저장된 자동 감시 상태 복원');
    initialSchedulerResumeCompleted = true;
  })().finally(() => {
    resumeAllSchedulersPromise = null;
  });

  return resumeAllSchedulersPromise;
}

async function ensureSchedulersReadyForMessage() {
  if (resumeAllSchedulersPromise) {
    await resumeAllSchedulersPromise;
    return;
  }

  if (!initialSchedulerResumeCompleted) {
    await resumeAllSchedulers();
  }
}

function getScheduler(feature) {
  return schedulers[feature] || null;
}

async function refreshSelfHostedVpnStatusIfNeeded(options = {}) {
  const scheduler = schedulers.selfHostedVpn;
  if (!scheduler || typeof scheduler.refreshStatusFromAgent !== 'function') {
    return;
  }

  const force = options.force === true;
  if (!force && !shouldAutoRefreshSelfHostedVpnStatus(scheduler)) {
    return;
  }

  await scheduler.refreshStatusFromAgent(options);
}

function shouldAutoRefreshSelfHostedVpnStatus(scheduler) {
  const phase = String(scheduler?.phase || '').trim().toUpperCase();
  const parallelPhase = String(scheduler?.parallelProbe?.phase || '').trim().toUpperCase();
  const lastSyncAt = String(scheduler?.lastSyncAt || '').trim();
  const parallelActive = Boolean(
    scheduler?.parallelProbe?.isRunning
    || ['PREPARING', 'CONNECTING', 'VERIFYING', 'STOPPING'].includes(parallelPhase),
  );

  return Boolean(
    !lastSyncAt
    || scheduler?.agentReachable !== true
    || scheduler?.healthOk !== true
    || scheduler?.isRunning
    || scheduler?.catalogEnabled
    || ['PREPARING', 'READY', 'SWITCHING', 'CONNECTING', 'CONNECTED', 'DISCONNECTING'].includes(phase)
    || parallelActive
  );
}

function getSelfHostedVpnPollingTimeoutMs() {
  const configuredTimeout = Number.parseInt(
    String(schedulers.selfHostedVpn?.config?.requestTimeoutMs ?? ''),
    10,
  );
  const safeDefaultTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 3000;
  return Math.max(safeDefaultTimeout, 3000);
}

function getAllStatuses() {
  return {
    comment: schedulers.comment.getStatus(),
    commentMonitor: schedulers.commentMonitor.getStatus(),
    conceptMonitor: schedulers.conceptMonitor.getStatus(),
    conceptPatrol: schedulers.conceptPatrol.getStatus(),
    hanRefreshIpBan: schedulers.hanRefreshIpBan.getStatus(),
    bumpPost: schedulers.bumpPost.getStatus(),
    sinmungoComment: schedulers.sinmungoComment.getStatus(),
    selfHostedVpn: schedulers.selfHostedVpn.getStatus(),
    refluxDatasetCollector: schedulers.refluxDatasetCollector.getStatus(),
    refluxOverlayCollector: schedulers.refluxOverlayCollector.getStatus(),
    commentRefluxCollector: schedulers.commentRefluxCollector.getStatus(),
    trustedCommandDefense: schedulers.trustedCommandDefense.getStatus(),
    post: schedulers.post.getStatus(),
    semiPost: schedulers.semiPost.getStatus(),
    ip: schedulers.ip.getStatus(),
    uidWarningAutoBan: schedulers.uidWarningAutoBan.getStatus(),
    monitor: schedulers.monitor.getStatus(),
  };
}

async function handleMessage(message) {
  await initializeDcSessionBroker();
  await ensureSchedulersReadyForMessage();

  if (message.action === 'getAllStatus') {
    await refreshSelfHostedVpnStatusIfNeeded({
      timeoutMs: getSelfHostedVpnPollingTimeoutMs(),
    });
    return {
      success: true,
      statuses: getAllStatuses(),
      sessionFallbackStatus: getDcSessionBrokerStatus(),
      uidRatioWarningStatus: await getUidRatioWarningStatusForActiveTab(),
    };
  }

  if (message.action === 'toggleUidRatioWarning') {
    const result = await toggleUidRatioWarningForActiveTab({
      enabled: message.enabled,
      galleryId: schedulers.semiPost.config.galleryId,
    });

    return {
      ...result,
      statuses: getAllStatuses(),
      sessionFallbackStatus: getDcSessionBrokerStatus(),
      uidRatioWarningStatus: result.uidRatioWarningStatus ?? await getUidRatioWarningStatusForActiveTab(),
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

    await applySharedConfig(message.config || {});
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
      if (message.feature === 'selfHostedVpn') {
        const selfHostedVpnStartBlockMessage = getSelfHostedVpnStartBlockMessage();
        if (selfHostedVpnStartBlockMessage) {
          return {
            success: false,
            message: selfHostedVpnStartBlockMessage,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
            sessionFallbackStatus: getDcSessionBrokerStatus(),
          };
        }
      }
      if (message.feature === 'trustedCommandDefense') {
        const trustedCommandDefenseStartBlockMessage = getTrustedCommandDefenseStartBlockMessage();
        if (trustedCommandDefenseStartBlockMessage) {
          return {
            success: false,
            message: trustedCommandDefenseStartBlockMessage,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
          };
        }
      }
      if (typeof scheduler.getStartBlockReason === 'function') {
        const guardedStartBlockReason = scheduler.getStartBlockReason();
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
        const normalizedCommentAttackMode = message.commentAttackMode !== undefined
          ? normalizeCommentAttackMode(message.commentAttackMode)
          : (message.excludePureHangulOnStart === true
            ? COMMENT_ATTACK_MODE.EXCLUDE_PURE_HANGUL
            : COMMENT_ATTACK_MODE.DEFAULT);
        await scheduler.start({
          source: message.source,
          commentAttackMode: normalizedCommentAttackMode,
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
      if (['comment', 'post', 'ip'].includes(message.feature)) {
        await schedulers.trustedCommandDefense.handleOwnedChildStopped(message.feature);
      }
      return { success: true, status: scheduler.getStatus(), statuses: getAllStatuses() };

    case 'refreshManualChallenge':
      if (message.feature !== 'sinmungoComment') {
        return {
          success: false,
          message: '이 기능은 신문고 댓글 수동 인증코드 새로받기를 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      await scheduler.refreshPreparedAnonymousChallenge();
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'submitManualChallenge':
      if (message.feature !== 'sinmungoComment') {
        return {
          success: false,
          message: '이 기능은 신문고 댓글 수동 인증코드 제출을 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      await scheduler.submitPreparedAnonymousCode(message.code, message.name);
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'cancelManualChallenge':
      if (message.feature !== 'sinmungoComment') {
        return {
          success: false,
          message: '이 기능은 신문고 댓글 수동 인증코드 취소를 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      await scheduler.stop('🔴 신문고 댓글 등록을 취소했습니다.');
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'startParallelProbe':
      if (message.feature !== 'selfHostedVpn') {
        return {
          success: false,
          message: '이 기능은 병렬 3슬롯 시험을 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      {
        const selfHostedVpnStartBlockMessage = getSelfHostedVpnStartBlockMessage();
        if (selfHostedVpnStartBlockMessage) {
          return {
            success: false,
            message: selfHostedVpnStartBlockMessage,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
            sessionFallbackStatus: getDcSessionBrokerStatus(),
          };
        }
      }
      await scheduler.startParallelProbe();
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
      };

    case 'stopParallelProbe':
      if (message.feature !== 'selfHostedVpn') {
        return {
          success: false,
          message: '이 기능은 병렬 3슬롯 시험을 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      await scheduler.stopParallelProbe();
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'getStatus':
      if (message.feature === 'selfHostedVpn') {
        await refreshSelfHostedVpnStatusIfNeeded({
          timeoutMs: getSelfHostedVpnPollingTimeoutMs(),
        });
      }
      return { success: true, status: scheduler.getStatus() };

    case 'refreshStatus':
      if (message.feature !== 'selfHostedVpn') {
        return {
          success: false,
          message: '이 기능은 수동 상태 새로고침을 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }

      await refreshSelfHostedVpnStatusIfNeeded({ force: true, logFailures: true });
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'refreshParallelProbeStatus':
      if (message.feature !== 'selfHostedVpn') {
        return {
          success: false,
          message: '이 기능은 병렬 3슬롯 상태 새로고침을 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }

      await refreshSelfHostedVpnStatusIfNeeded({ force: true, logFailures: true });
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'primeCatalogNics':
      if (message.feature !== 'selfHostedVpn') {
        return {
          success: false,
          message: '이 기능은 VPN1~200 준비를 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }

      await scheduler.primeCatalogNics();
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'activateCatalogRelay':
      if (message.feature !== 'selfHostedVpn') {
        return {
          success: false,
          message: '이 기능은 raw 릴레이 클릭 연결을 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      {
        const selfHostedVpnStartBlockMessage = getSelfHostedVpnStartBlockMessage();
        if (selfHostedVpnStartBlockMessage) {
          return {
            success: false,
            message: selfHostedVpnStartBlockMessage,
            status: scheduler.getStatus(),
            statuses: getAllStatuses(),
            sessionFallbackStatus: getDcSessionBrokerStatus(),
          };
        }
      }
      await scheduler.activateCatalogRelay(message.relay || {});
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
      };

    case 'updateConfig': {
      let partialConfigMessage = '';
      if (message.config) {

        if (message.feature === 'post' && message.config.manualAttackMode !== undefined) {
          message.config = {
            ...message.config,
            manualAttackMode: normalizePostManualAttackMode(message.config.manualAttackMode),
          };
        }

        if (
          ['post', 'comment'].includes(message.feature)
          && message.config.refluxSearchGalleryId !== undefined
        ) {
          const trimmedSearchGalleryId = normalizeRefluxSearchGalleryId(message.config.refluxSearchGalleryId);
          if (trimmedSearchGalleryId && !isValidRefluxSearchGalleryId(trimmedSearchGalleryId)) {
            return {
              success: false,
              message: '역류 검색 갤 ID는 영문/숫자/밑줄만 입력하세요.',
              status: scheduler.getStatus(),
              statuses: getAllStatuses(),
            };
          }

          message.config = {
            ...message.config,
            refluxSearchGalleryId: trimmedSearchGalleryId,
          };
        }

        if (
          ['post', 'comment'].includes(message.feature)
          && message.config.useVpnGatePrefixFilter !== undefined
        ) {
          message.config = {
            ...message.config,
            useVpnGatePrefixFilter: Boolean(message.config.useVpnGatePrefixFilter),
          };
        }

        if (message.feature === 'conceptMonitor') {
          const conceptMonitorConfigAdjustment = adjustConceptMonitorConfigUpdateForRunningScheduler(scheduler, message.config);
          message.config = conceptMonitorConfigAdjustment.config;
          partialConfigMessage = conceptMonitorConfigAdjustment.message;
          if (Object.keys(message.config).length <= 0) {
            return {
              success: false,
              message: partialConfigMessage || '저장할 개념글 방어 설정 변경이 없습니다.',
              status: scheduler.getStatus(),
              statuses: getAllStatuses(),
            };
          }
        }

        if (message.feature === 'hanRefreshIpBan') {
          message.config = normalizeHanRefreshIpBanConfig({
            ...scheduler.config,
            ...message.config,
          });
        }

        if (message.feature === 'bumpPost') {
          const rawPostNo = message.config.postNo;
          if (rawPostNo !== undefined) {
            const trimmedPostNo = String(rawPostNo || '').trim();
            if (trimmedPostNo && !/^\d+$/.test(trimmedPostNo)) {
              return {
                success: false,
                message: '게시물 번호는 숫자만 입력하세요.',
                status: scheduler.getStatus(),
                statuses: getAllStatuses(),
              };
            }
          }

          message.config = normalizeBumpPostConfig({
            ...scheduler.config,
            ...message.config,
          });
        }

        if (message.feature === 'sinmungoComment') {
          const rawPostNo = message.config.postNo;
          if (rawPostNo !== undefined) {
            const trimmedPostNo = String(rawPostNo || '').trim();
            if (trimmedPostNo && !/^\d+$/.test(trimmedPostNo)) {
              return {
                success: false,
                message: '게시물 번호는 숫자만 입력하세요.',
                status: scheduler.getStatus(),
                statuses: getAllStatuses(),
              };
            }
          }

          const rawMemo = message.config.memo;
          if (rawMemo !== undefined && !String(rawMemo || '').trim()) {
            return {
              success: false,
              message: '댓글 문구를 입력하세요.',
              status: scheduler.getStatus(),
              statuses: getAllStatuses(),
            };
          }

          message.config = normalizeSinmungoCommentConfig({
            ...scheduler.config,
            ...message.config,
          });

          if (
            message.config.submitMode === 'anonymous'
            && String(message.config.password || '').trim().length < 2
          ) {
            return {
              success: false,
              message: '유동/비회원 테스트 비밀번호는 2자 이상 입력하세요.',
              status: scheduler.getStatus(),
              statuses: getAllStatuses(),
            };
          }
        }

        if (message.feature === 'selfHostedVpn') {
          message.config = normalizeSelfHostedVpnConfig({
            ...scheduler.config,
            ...message.config,
          });

          const agentBaseUrlValidationMessage = getAgentBaseUrlValidationMessage(message.config.agentBaseUrl);
          if (agentBaseUrlValidationMessage) {
            return {
              success: false,
              message: agentBaseUrlValidationMessage,
              status: scheduler.getStatus(),
              statuses: getAllStatuses(),
            };
          }
        }

        if (message.feature === 'refluxDatasetCollector') {
          const rawGalleryId = message.config.galleryId;
          if (rawGalleryId !== undefined) {
            const trimmedGalleryId = String(rawGalleryId || '').trim();
            if (trimmedGalleryId && !isValidRefluxCollectorGalleryId(trimmedGalleryId)) {
              return {
                success: false,
                message: '갤 ID는 영문/숫자/밑줄만 입력하세요.',
                status: scheduler.getStatus(),
                statuses: getAllStatuses(),
              };
            }
          }

          message.config = normalizeRefluxDatasetCollectorConfig({
            ...scheduler.config,
            ...message.config,
          });
        }

        if (message.feature === 'refluxOverlayCollector') {
          const rawViewUrl = String(message.config.viewUrl ?? '').trim();
          if (rawViewUrl) {
            try {
              parseValidatedViewUrl(rawViewUrl);
            } catch (error) {
              return {
                success: false,
                message: error.message,
                status: scheduler.getStatus(),
                statuses: getAllStatuses(),
              };
            }
          }

          message.config = normalizeRefluxOverlayCollectorConfig({
            ...scheduler.config,
            ...message.config,
          });
        }

        if (message.feature === 'commentRefluxCollector') {
          const rawGalleryId = message.config.galleryId;
          if (rawGalleryId !== undefined) {
            const trimmedGalleryId = String(rawGalleryId || '').trim();
            if (trimmedGalleryId && !isValidCommentRefluxCollectorGalleryId(trimmedGalleryId)) {
              return {
                success: false,
                message: '갤 ID는 영문/숫자/밑줄만 입력하세요.',
                status: scheduler.getStatus(),
                statuses: getAllStatuses(),
              };
            }
          }

          message.config = normalizeCommentRefluxCollectorConfig({
            ...scheduler.config,
            ...message.config,
          });
        }

        if (message.feature === 'trustedCommandDefense') {
          const nextGalleryId = String(message.config.galleryId ?? scheduler.config.galleryId ?? '').trim();
          const rawCommandPostTarget = Object.prototype.hasOwnProperty.call(message.config, 'commandPostUrl')
            ? message.config.commandPostUrl
            : (Object.prototype.hasOwnProperty.call(message.config, 'commandPostNo')
              ? message.config.commandPostNo
              : (scheduler.config.commandPostUrl || scheduler.config.commandPostNo || ''));
          const normalizedRawCommandPostTarget = String(rawCommandPostTarget || '').trim();

          if (
            Object.prototype.hasOwnProperty.call(message.config, 'commandPostUrl')
            || Object.prototype.hasOwnProperty.call(message.config, 'commandPostNo')
          ) {
            if (normalizedRawCommandPostTarget) {
              const parsedCommandPostTarget = parseCommandPostTarget(normalizedRawCommandPostTarget, nextGalleryId);
              if (!parsedCommandPostTarget.success) {
                return {
                  success: false,
                  message: parsedCommandPostTarget.message,
                  status: scheduler.getStatus(),
                  statuses: getAllStatuses(),
                };
              }
            }
          }

          message.config = normalizeTrustedCommentCommandDefenseConfig({
            ...scheduler.config,
            ...message.config,
          });

          if (
            message.config.commandGalleryId
            && message.config.galleryId
            && message.config.commandGalleryId !== message.config.galleryId
          ) {
            return {
              success: false,
              message: '명령 게시물은 현재 공통 갤과 같은 갤이어야 합니다.',
              status: scheduler.getStatus(),
              statuses: getAllStatuses(),
            };
          }
        }

        if (message.feature === 'conceptPatrol') {
          message.config = normalizeConceptPatrolConfig({
            ...scheduler.config,
            ...message.config,
          });
        }

        if (message.feature === 'uidWarningAutoBan') {
          message.config = normalizeUidWarningAutoBanConfig({
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
        if (message.feature === 'conceptMonitor'
          && typeof scheduler.syncRecommendCutCoordinator === 'function') {
          await scheduler.syncRecommendCutCoordinator({ forceKcaptchaRefresh: true });
        }
        await scheduler.saveState();
      }
      return {
        success: true,
        message: partialConfigMessage || '',
        status: scheduler.getStatus(),
        config: scheduler.config,
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
      };
    }

    case 'resetStats':
      if (message.feature === 'refluxDatasetCollector' && scheduler.isRunning) {
        return {
          success: false,
          message: 'Local 수집 실행 중에는 통계와 로그를 초기화할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      if (message.feature === 'commentRefluxCollector' && scheduler.isRunning) {
        return {
          success: false,
          message: '역류댓글 수집 실행 중에는 통계와 로그를 초기화할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      if (message.feature === 'sinmungoComment' && (scheduler.isRunning || scheduler.startAbortController)) {
        return {
          success: false,
          message: '신문고 댓글 등록 실행 중에는 통계와 로그를 초기화할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      if (
        message.feature === 'selfHostedVpn'
        && (
          scheduler.isRunning
          || scheduler.parallelProbe?.isRunning
          || scheduler.parallelProbe?.phase === 'STOPPING'
        )
      ) {
        return {
          success: false,
          message: 'VPN 연결 또는 병렬 3슬롯 시험 실행 중에는 상태 기록과 로그를 초기화할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      if (message.feature === 'refluxOverlayCollector' && (scheduler.isRunning || scheduler.startAbortController)) {
        return {
          success: false,
          message: '임시 overlay 수집 실행 중에는 통계와 로그를 초기화할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      if (message.feature === 'trustedCommandDefense' && scheduler.isRunning) {
        return {
          success: false,
          message: '명령 방어 실행 중에는 통계와 로그를 초기화할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      resetSchedulerStats(message.feature, scheduler);
      if (message.feature === 'refluxDatasetCollector'
        && typeof scheduler.clearCollectedData === 'function') {
        await scheduler.clearCollectedData();
      }
      if (message.feature === 'commentRefluxCollector'
        && typeof scheduler.clearCollectedData === 'function') {
        await scheduler.clearCollectedData();
      }
      if (message.feature === 'conceptMonitor'
        && typeof scheduler.syncRecommendCutCoordinator === 'function') {
        await scheduler.syncRecommendCutCoordinator({ forceKcaptchaRefresh: true });
      }
      await scheduler.saveState();
      return {
        success: true,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
        sessionFallbackStatus: getDcSessionBrokerStatus(),
      };

    case 'downloadExportJson':
      if (!['refluxDatasetCollector', 'commentRefluxCollector'].includes(message.feature)
        || typeof scheduler.buildDownloadDescriptor !== 'function') {
        return {
          success: false,
          message: '이 기능은 JSON 다운로드를 지원하지 않습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      return {
        ...(await scheduler.buildDownloadDescriptor()),
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
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

    case 'listOverlays':
      if (message.feature !== 'refluxOverlayCollector') {
        return { success: false, message: 'overlay 목록 조회는 임시 overlay 기능에서만 지원합니다.' };
      }
      return {
        success: true,
        overlays: await listSemiconductorRefluxOverlayMetas(),
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'deleteOverlay':
      if (message.feature !== 'refluxOverlayCollector') {
        return { success: false, message: 'overlay 삭제는 임시 overlay 기능에서만 지원합니다.' };
      }
      if (scheduler.isRunning || scheduler.startAbortController) {
        return {
          success: false,
          message: '임시 overlay 수집 실행 중에는 저장된 overlay를 삭제할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      await deleteSemiconductorRefluxOverlay(message.overlayId);
      const remainingOverlays = await listSemiconductorRefluxOverlayMetas();
      if (String(scheduler.appliedOverlayId || '').trim() === String(message.overlayId || '').trim()) {
        scheduler.appliedOverlayId = remainingOverlays[0]?.overlayId
          ? String(remainingOverlays[0].overlayId).trim()
          : '';
        await scheduler.saveState();
      }
      await reloadSemiconductorRefluxEffectiveMatcher();
      return {
        success: true,
        overlays: remainingOverlays,
        status: scheduler.getStatus(),
        statuses: getAllStatuses(),
      };

    case 'clearAllOverlays':
      if (message.feature !== 'refluxOverlayCollector') {
        return { success: false, message: 'overlay 전체 삭제는 임시 overlay 기능에서만 지원합니다.' };
      }
      if (scheduler.isRunning || scheduler.startAbortController) {
        return {
          success: false,
          message: '임시 overlay 수집 실행 중에는 overlay 전체 삭제를 할 수 없습니다.',
          status: scheduler.getStatus(),
          statuses: getAllStatuses(),
        };
      }
      await clearSemiconductorRefluxOverlays();
      scheduler.appliedOverlayId = '';
      await scheduler.saveState();
      await reloadSemiconductorRefluxEffectiveMatcher();
      return {
        success: true,
        overlays: await listSemiconductorRefluxOverlayMetas(),
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
    scheduler.resetVerificationState();
    if (!scheduler.isRunning) {
      if (typeof scheduler.setCurrentSource === 'function') {
        scheduler.setCurrentSource('', { logChange: false });
      }
      scheduler.currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
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
    scheduler.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
    scheduler.lastManagedAttackModeReason = '';
    scheduler.totalAttackDetected = 0;
    scheduler.totalAttackReleased = 0;
    scheduler.reseedRemaining = 1;
    scheduler.logs = [];
    return;
  }

  if (feature === 'trustedCommandDefense') {
    scheduler.phase = 'IDLE';
    scheduler.pollCount = 0;
    scheduler.startedAt = '';
    scheduler.lastPollAt = '';
    scheduler.seededAt = '';
    scheduler.seeded = false;
    scheduler.lastSeenCommentNo = '';
    scheduler.processedCommandCommentNos = [];
    scheduler.lastCommandType = '';
    scheduler.lastCommandCommentNo = '';
    scheduler.lastCommandUserId = '';
    scheduler.lastCommandAt = '';
    scheduler.postDefenseUntilTs = 0;
    scheduler.commentDefenseUntilTs = 0;
    scheduler.ownedPostScheduler = false;
    scheduler.ownedIpScheduler = false;
    scheduler.ownedCommentScheduler = false;
    scheduler.postDefenseCutoffPostNo = 0;
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

  if (feature === 'conceptPatrol') {
    scheduler.currentPage = 0;
    scheduler.currentPostNo = 0;
    scheduler.cycleCount = 0;
    scheduler.lastPollAt = '';
    scheduler.lastDetectedMaxPage = 0;
    scheduler.lastWindowSize = 0;
    scheduler.lastNewPostCount = 0;
    scheduler.lastCandidateCount = 0;
    scheduler.totalDetectedCount = 0;
    scheduler.totalReleasedCount = 0;
    scheduler.totalFailedCount = 0;
    scheduler.totalUnclearCount = 0;
    scheduler.baselineReady = false;
    scheduler.previousWindowPostNos = [];
    scheduler.previousWindowMeta = {};
    scheduler.baselineVersionKey = '';
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

  if (feature === 'bumpPost') {
    scheduler.cycleCount = 0;
    scheduler.logs = [];
    scheduler.totalBumpedCount = 0;
    scheduler.totalFailedCount = 0;
    scheduler.lastBumpedAt = '';
    scheduler.lastErrorAt = '';
    scheduler.lastErrorMessage = '';
    scheduler.lastBumpedPostNo = '';
    if (!scheduler.isRunning) {
      scheduler.phase = 'IDLE';
      scheduler.startedAt = '';
      scheduler.endsAt = '';
      scheduler.nextRunAt = '';
    }
    return;
  }

  if (feature === 'sinmungoComment') {
    scheduler.logs = [];
    scheduler.totalSubmittedCount = 0;
    scheduler.totalFailedCount = 0;
    scheduler.lastSubmittedAt = '';
    scheduler.lastVerifiedAt = '';
    scheduler.lastSuccessAt = '';
    scheduler.lastErrorAt = '';
    scheduler.lastErrorMessage = '';
    scheduler.lastTargetPostNo = '';
    scheduler.lastSubmittedMemo = '';
    scheduler.lastCommentNo = '';
    if (!scheduler.isRunning) {
      scheduler.phase = 'IDLE';
      scheduler.startedAt = '';
      scheduler.finishedAt = '';
    }
    scheduler.pendingChallenge = null;
    return;
  }

  if (feature === 'selfHostedVpn') {
    scheduler.isRunning = false;
    scheduler.phase = 'IDLE';
    scheduler.catalogEnabled = false;
    scheduler.healthOk = false;
    scheduler.agentReachable = false;
    scheduler.agentVersion = '';
    scheduler.lastSyncAt = '';
    scheduler.lastHealthAt = '';
    scheduler.operationId = '';
    scheduler.activeConnectionMode = 'softether_vpngate_raw';
    scheduler.activeProfileId = '';
    scheduler.activeRelayId = '';
    scheduler.activeRelayIp = '';
    scheduler.activeRelayFqdn = '';
    scheduler.activeSelectedSslPort = 0;
    scheduler.publicIpBefore = '';
    scheduler.publicIpAfter = '';
    scheduler.currentPublicIp = '';
    scheduler.publicIpProvider = '';
    scheduler.ipv4DefaultRouteChanged = false;
    scheduler.ipv6DefaultRouteChanged = false;
    scheduler.dnsChanged = false;
    scheduler.activeAdapterName = '';
    scheduler.connectedAt = '';
    scheduler.lastErrorCode = '';
    scheduler.lastErrorMessage = '';
    scheduler.lastSyncCompletedAtMs = 0;
    scheduler.rawRelayCatalog = {
      phase: 'IDLE',
      startedAt: '',
      completedAt: '',
      sourceHostCount: 0,
      usableRelayCount: 0,
      requestedCandidateCount: 0,
      provisionableSlotCount: 0,
      connectedSlotCount: 0,
      verifiedSlotCount: 0,
      deadSlotCount: 0,
      activeSlotId: '',
      routeOwnerSlotId: '',
      lastVerifiedAt: '',
      lastVerifiedPublicIp: '',
      lastVerifiedPublicIpProvider: '',
      lastErrorCode: '',
      lastErrorMessage: '',
      request: {
        limit: 200,
        preferredCountries: ['KR', 'JP'],
        preferredPorts: [443, 995, 1698, 5555, 992, 1194],
      },
      items: [],
      logs: [],
    };
    scheduler.parallelProbe = {
      isRunning: false,
      phase: 'IDLE',
      startedAt: '',
      completedAt: '',
      lastVerifiedAt: '',
      routeOwnerSlotId: '',
      lastVerifiedPublicIp: '',
      lastVerifiedPublicIpProvider: '',
      lastErrorCode: '',
      lastErrorMessage: '',
      slots: [],
      logs: [],
    };
    scheduler.logs = [];
    return;
  }

  if (feature === 'refluxDatasetCollector') {
    scheduler.runId = '';
    scheduler.phase = scheduler.isRunning ? 'RUNNING' : 'IDLE';
    scheduler.currentPage = 0;
    scheduler.fetchedPageCount = 0;
    scheduler.rawTitleCount = 0;
    scheduler.normalizedTitleCount = 0;
    scheduler.startedAt = '';
    scheduler.finishedAt = '';
    scheduler.lastError = '';
    scheduler.logs = [];
    scheduler.downloadReady = false;
    scheduler.exportVersion = '';
    scheduler.interrupted = false;
    scheduler.collectedGalleryId = '';
    return;
  }

  if (feature === 'refluxOverlayCollector') {
    scheduler.phase = scheduler.isRunning ? 'FETCHING' : 'IDLE';
    scheduler.currentPage = 0;
    scheduler.galleryId = '';
    scheduler.targetPostNo = 0;
    scheduler.foundPage = 0;
    scheduler.totalPageCount = 0;
    scheduler.targetPageCount = 0;
    scheduler.completedPageCount = 0;
    scheduler.failedPageCount = 0;
    scheduler.failedPages = [];
    scheduler.rawTitleCount = 0;
    scheduler.normalizedTitleCount = 0;
    scheduler.startedAt = '';
    scheduler.finishedAt = '';
    scheduler.lastError = '';
    scheduler.logs = [];
    scheduler.interrupted = false;
    return;
  }

  if (feature === 'commentRefluxCollector') {
    scheduler.runId = '';
    scheduler.phase = scheduler.isRunning ? 'RUNNING' : 'IDLE';
    scheduler.currentPage = 0;
    scheduler.currentPostNo = 0;
    scheduler.fetchedPageCount = 0;
    scheduler.processedPostCount = 0;
    scheduler.failedPostCount = 0;
    scheduler.rawCommentCount = 0;
    scheduler.normalizedMemoCount = 0;
    scheduler.startedAt = '';
    scheduler.finishedAt = '';
    scheduler.lastError = '';
    scheduler.logs = [];
    scheduler.downloadReady = false;
    scheduler.exportVersion = '';
    scheduler.interrupted = false;
    scheduler.collectedGalleryId = '';
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

  if (feature === 'uidWarningAutoBan') {
    scheduler.phase = scheduler.isRunning ? 'RUNNING' : 'IDLE';
    scheduler.currentPage = 1;
    scheduler.lastPollAt = '';
    scheduler.nextRunAt = '';
    scheduler.lastTriggeredUid = '';
    scheduler.lastTriggeredPostCount = 0;
    scheduler.lastBurstRecentCount = 0;
    scheduler.lastSingleSightTriggeredUid = '';
    scheduler.lastSingleSightTriggeredPostCount = 0;
    scheduler.lastImmediateTitleBanCount = 0;
    scheduler.lastImmediateTitleBanMatchedTitle = '';
    scheduler.lastPageRowCount = 0;
    scheduler.lastPageUidCount = 0;
    scheduler.totalTriggeredUidCount = 0;
    scheduler.totalSingleSightTriggeredUidCount = 0;
    scheduler.totalImmediateTitleBanPostCount = 0;
    scheduler.totalSingleSightBannedPostCount = 0;
    scheduler.totalBannedPostCount = 0;
    scheduler.totalFailedPostCount = 0;
    scheduler.deleteLimitFallbackCount = 0;
    scheduler.banOnlyFallbackCount = 0;
    scheduler.lastError = '';
    scheduler.cycleCount = 0;
    scheduler.runtimeDeleteModeReason = 'normal';
    scheduler.lastDeleteLimitExceededAt = '';
    scheduler.lastDeleteLimitMessage = '';
    scheduler.runtimeDeleteEnabled = Boolean(scheduler.config?.delChk);
    scheduler.recentUidActions = {};
    scheduler.recentImmediatePostActions = {};
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
    scheduler.managedUidWarningAutoBanBanOnly = false;
    scheduler.logs = [];
  }
}

async function applySharedConfig(config) {
  const galleryId = normalizeSharedString(config.galleryId);
  const headtextId = normalizeSharedString(config.headtextId);
  const galleryChanged = Boolean(galleryId) && (
    schedulers.comment.config.galleryId !== galleryId
    || schedulers.commentMonitor.config.galleryId !== galleryId
    || schedulers.conceptMonitor.config.galleryId !== galleryId
    || schedulers.conceptPatrol.config.galleryId !== galleryId
    || schedulers.hanRefreshIpBan.config.galleryId !== galleryId
    || schedulers.bumpPost.config.galleryId !== galleryId
    || schedulers.sinmungoComment.config.galleryId !== galleryId
    || schedulers.post.config.galleryId !== galleryId
    || schedulers.semiPost.config.galleryId !== galleryId
    || schedulers.ip.config.galleryId !== galleryId
    || schedulers.uidWarningAutoBan.config.galleryId !== galleryId
    || schedulers.monitor.config.galleryId !== galleryId
    || schedulers.trustedCommandDefense.config.galleryId !== galleryId
  );
  const headtextChanged = Boolean(headtextId) && (
    schedulers.post.config.headtextId !== headtextId
    || schedulers.semiPost.config.headtextId !== headtextId
    || schedulers.ip.config.headtextId !== headtextId
    || schedulers.trustedCommandDefense.config.headtextId !== headtextId
  );

  if (galleryId) {
    schedulers.comment.config.galleryId = galleryId;
    schedulers.commentMonitor.config.galleryId = galleryId;
    schedulers.conceptMonitor.config.galleryId = galleryId;
    schedulers.conceptPatrol.config.galleryId = galleryId;
    schedulers.hanRefreshIpBan.config.galleryId = galleryId;
    schedulers.bumpPost.config.galleryId = galleryId;
    schedulers.sinmungoComment.config.galleryId = galleryId;
    schedulers.post.config.galleryId = galleryId;
    schedulers.semiPost.config.galleryId = galleryId;
    schedulers.ip.config.galleryId = galleryId;
    schedulers.uidWarningAutoBan.config.galleryId = galleryId;
    schedulers.monitor.config.galleryId = galleryId;
    schedulers.trustedCommandDefense.config.galleryId = galleryId;
  }

  if (headtextId) {
    schedulers.post.config.headtextId = headtextId;
    schedulers.semiPost.config.headtextId = headtextId;
    schedulers.ip.config.headtextId = headtextId;
    schedulers.ip.config.headtextName = '';
    schedulers.trustedCommandDefense.config.headtextId = headtextId;
  }

  if (galleryChanged) {
    resetCommentSchedulerState(`ℹ️ 공통 설정 변경으로 댓글 방어 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetCommentMonitorSchedulerState(`ℹ️ 공통 설정 변경으로 댓글 감시 자동화 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetConceptMonitorSchedulerState(`ℹ️ 공통 설정 변경으로 개념글 방어 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetConceptPatrolSchedulerState(`ℹ️ 공통 설정 변경으로 개념글순회 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetHanRefreshIpBanSchedulerState(`ℹ️ 공통 설정 변경으로 도배기 갱신 차단 자동 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetBumpPostSchedulerState(`ℹ️ 공통 설정 변경으로 끌올 자동 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetSinmungoCommentSchedulerState(`ℹ️ 공통 설정 변경으로 신문고 댓글 등록 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetPostSchedulerState(`ℹ️ 공통 설정 변경으로 게시글 분류 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetSemiPostSchedulerState(`ℹ️ 공통 설정 변경으로 반고닉 분류 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetIpSchedulerState(`ℹ️ 공통 설정 변경으로 IP 차단 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetUidWarningAutoBanSchedulerState(`ℹ️ 공통 설정 변경으로 분탕자동차단 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetMonitorSchedulerState(`ℹ️ 공통 설정 변경으로 감시 자동화 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    resetTrustedCommandDefenseSchedulerState(`ℹ️ 공통 설정 변경으로 명령 방어 상태를 초기화했습니다. (갤러리: ${galleryId})`);
    await resetConceptRecommendCutCoordinator({ galleryId });
    return;
  }

  if (headtextChanged) {
    resetPostSchedulerState(`ℹ️ 공통 설정 변경으로 게시글 분류 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
    resetSemiPostSchedulerState(`ℹ️ 공통 설정 변경으로 반고닉 분류 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
    resetIpSchedulerState(`ℹ️ 공통 설정 변경으로 IP 차단 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
    resetTrustedCommandDefenseSchedulerState(`ℹ️ 공통 설정 변경으로 명령 방어 상태를 초기화했습니다. (도배기탭 번호: ${headtextId})`);
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

  if (isSchedulerBusy(schedulers.conceptPatrol)) {
    busyFeatures.push('개념글순회');
  }

  if (isSchedulerBusy(schedulers.hanRefreshIpBan)) {
    busyFeatures.push('도배기 갱신 차단 자동');
  }

  if (isSchedulerBusy(schedulers.bumpPost)) {
    busyFeatures.push('끌올 자동');
  }

  if (isSchedulerBusy(schedulers.sinmungoComment)) {
    busyFeatures.push('신문고 댓글 등록');
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

  if (isSchedulerBusy(schedulers.uidWarningAutoBan)) {
    busyFeatures.push('분탕자동차단');
  }

  if (isSchedulerBusy(schedulers.monitor)) {
    busyFeatures.push('감시 자동화');
  }

  if (isSchedulerBusy(schedulers.trustedCommandDefense)) {
    busyFeatures.push('명령 방어');
  }

  if (isSchedulerBusy(schedulers.refluxOverlayCollector)) {
    busyFeatures.push('임시 Overlay 수집');
  }

  return busyFeatures;
}

function isSchedulerBusy(scheduler) {
  return Boolean(scheduler?.isRunning || scheduler?.runPromise || scheduler?.startAbortController);
}

function getSelfHostedVpnBlockingFeatures() {
  const blockingFeatures = [...getBusyFeatures()];

  if (isSchedulerBusy(schedulers.refluxDatasetCollector)) {
    blockingFeatures.push('Local 수집');
  }

  if (isSchedulerBusy(schedulers.commentRefluxCollector)) {
    blockingFeatures.push('역류댓글 수집');
  }

  if (isSchedulerBusy(schedulers.refluxOverlayCollector)) {
    blockingFeatures.push('임시 Overlay 수집');
  }

  return [...new Set(blockingFeatures)];
}

function getSelfHostedVpnStartBlockMessage() {
  const sessionFallbackStatus = getDcSessionBrokerStatus();
  if (sessionFallbackStatus.switchInProgress || sessionFallbackStatus.sessionAutomationInProgress) {
    return '로그인 세션 자동화가 진행 중일 때는 VPN 연결을 시작할 수 없습니다.';
  }

  const busyFeatures = getSelfHostedVpnBlockingFeatures();
  if (busyFeatures.length > 0) {
    return `VPN 연결 전에 먼저 정지하세요: ${busyFeatures.join(', ')}`;
  }

  return '';
}

function isMonitorManagingPostAxis() {
  return schedulers.monitor.isRunning
    && [MONITOR_PHASE.ATTACKING, MONITOR_PHASE.RECOVERING].includes(schedulers.monitor.phase);
}

function isCommentMonitorManagingCommentAxis() {
  return schedulers.commentMonitor.isRunning
    && [COMMENT_MONITOR_PHASE.ATTACKING, COMMENT_MONITOR_PHASE.RECOVERING].includes(schedulers.commentMonitor.phase);
}

function getTrustedCommandDefenseStartBlockMessage() {
  return '';
}

function getConfigUpdateBlockMessage(feature, scheduler, config) {
  const selfHostedVpnParallelActive = feature === 'selfHostedVpn'
    && (
      scheduler.parallelProbe?.isRunning
      || scheduler.parallelProbe?.phase === 'STOPPING'
    );
  if (!scheduler.isRunning && !scheduler.startAbortController && !selfHostedVpnParallelActive) {
    return '';
  }

  if (feature === 'monitor'
    && config.monitorPages !== undefined
    && Number(config.monitorPages) !== Number(scheduler.config.monitorPages)) {
    return '감시 페이지 수는 자동 감시를 정지한 뒤 변경하세요.';
  }

  if (feature === 'monitor'
    && config.initialSweepPages !== undefined
    && Number(config.initialSweepPages) !== Number(scheduler.config.initialSweepPages)) {
    return 'initial sweep 페이지 수는 자동 감시를 정지한 뒤 변경하세요.';
  }

  if (feature === 'commentMonitor'
    && config.monitorPages !== undefined
    && Number(config.monitorPages) !== Number(scheduler.config.monitorPages)) {
    return '댓글 감시 페이지 수는 댓글 감시 자동화를 정지한 뒤 변경하세요.';
  }

  if (feature === 'comment'
    && normalizeCommentAttackMode(scheduler.currentAttackMode) === COMMENT_ATTACK_MODE.COMMENT_REFLUX
    && config.refluxSearchGalleryId !== undefined
    && resolveRefluxSearchGalleryId({
      ...scheduler.config,
      ...config,
    }) !== resolveRefluxSearchGalleryId(scheduler.config)) {
      return '역류 검색 갤 ID는 댓글 역류기 방어를 정지한 뒤 변경하세요.';
  }

  if (feature === 'trustedCommandDefense') {
    const trackedConfigKeys = [
      'commandPostUrl',
      'commandPostNo',
      'commandGalleryId',
      'trustedUsersText',
      'commandPrefix',
      'pollIntervalMs',
      'holdMs',
      'recentCommentPages',
    ];
    const hasChangedConfig = trackedConfigKeys.some((key) => (
      Object.prototype.hasOwnProperty.call(config, key)
      && normalizeComparableConfigValue(config[key]) !== normalizeComparableConfigValue(scheduler.config[key])
    ));
    if (hasChangedConfig) {
      return '명령 방어 설정은 실행이 끝난 뒤 변경하세요.';
    }
  }

  if (feature === 'conceptMonitor'
    && config.testMode !== undefined
    && Boolean(config.testMode) !== Boolean(scheduler.config.testMode)) {
    return '테스트 모드는 개념글 방어를 정지한 뒤 변경하세요.';
  }

  if (feature === 'conceptPatrol'
    && config.patrolPages !== undefined
    && Number(config.patrolPages) !== Number(scheduler.config.patrolPages)) {
    return '순회 페이지 수는 개념글순회를 정지한 뒤 변경하세요.';
  }

  if (feature === 'bumpPost') {
    const postNoChanged = config.postNo !== undefined
      && String(config.postNo || '') !== String(scheduler.config.postNo || '');
    const durationChanged = config.durationMinutes !== undefined
      && Number(config.durationMinutes) !== Number(scheduler.config.durationMinutes);
    const intervalChanged = config.intervalMinutes !== undefined
      && Number(config.intervalMinutes) !== Number(scheduler.config.intervalMinutes);
    if (postNoChanged || durationChanged || intervalChanged) {
      return '끌올 자동 설정은 기능을 정지한 뒤 변경하세요.';
    }
  }

  if (feature === 'sinmungoComment') {
    const trackedConfigKeys = [
      'postNo',
      'memo',
      'submitMode',
      'password',
      'replyNo',
      'name',
      'gallNickName',
      'useGallNick',
      'recommend',
    ];
    const hasChangedConfig = trackedConfigKeys.some((key) => (
      Object.prototype.hasOwnProperty.call(config, key)
      && normalizeComparableConfigValue(config[key]) !== normalizeComparableConfigValue(scheduler.config[key])
    ));
    if (hasChangedConfig) {
      return '신문고 댓글 등록 설정은 실행이 끝난 뒤 변경하세요.';
    }
  }

  if (feature === 'selfHostedVpn') {
    const agentBaseUrlChanged = config.agentBaseUrl !== undefined
      && String(config.agentBaseUrl || '') !== String(scheduler.config.agentBaseUrl || '');
    const authTokenChanged = config.authToken !== undefined
      && String(config.authToken || '') !== String(scheduler.config.authToken || '');
    const connectionModeChanged = config.connectionMode !== undefined
      && String(config.connectionMode || '') !== String(scheduler.config.connectionMode || '');
    const profileIdChanged = config.profileId !== undefined
      && String(config.profileId || '') !== String(scheduler.config.profileId || '');
    const selectedRelayIdChanged = config.selectedRelayId !== undefined
      && String(config.selectedRelayId || '') !== String(scheduler.config.selectedRelayId || '');
    const selectedSslPortChanged = config.selectedSslPort !== undefined
      && Number(config.selectedSslPort) !== Number(scheduler.config.selectedSslPort);
    const relaySnapshotChanged = config.relaySnapshot !== undefined
      && JSON.stringify(config.relaySnapshot || {}) !== JSON.stringify(scheduler.config.relaySnapshot || {});
    const requestTimeoutChanged = config.requestTimeoutMs !== undefined
      && Number(config.requestTimeoutMs) !== Number(scheduler.config.requestTimeoutMs);
    const actionTimeoutChanged = config.actionTimeoutMs !== undefined
      && Number(config.actionTimeoutMs) !== Number(scheduler.config.actionTimeoutMs);
    if (
      agentBaseUrlChanged
      || authTokenChanged
      || connectionModeChanged
      || profileIdChanged
      || selectedRelayIdChanged
      || selectedSslPortChanged
      || relaySnapshotChanged
      || requestTimeoutChanged
      || actionTimeoutChanged
    ) {
      return '자체 VPN 테스트 설정은 연결을 끊은 뒤 변경하세요.';
    }
  }

  if (feature === 'refluxDatasetCollector') {
    const galleryIdChanged = config.galleryId !== undefined
      && String(config.galleryId || '') !== String(scheduler.config.galleryId || '');
    const startPageChanged = config.startPage !== undefined
      && Number(config.startPage) !== Number(scheduler.config.startPage);
    const endPageChanged = config.endPage !== undefined
      && Number(config.endPage) !== Number(scheduler.config.endPage);
    const requestDelayChanged = config.requestDelayMs !== undefined
      && Number(config.requestDelayMs) !== Number(scheduler.config.requestDelayMs);
    const jitterChanged = config.jitterMs !== undefined
      && Number(config.jitterMs) !== Number(scheduler.config.jitterMs);
    if (galleryIdChanged || startPageChanged || endPageChanged || requestDelayChanged || jitterChanged) {
      return 'Local 수집 설정은 기능을 정지한 뒤 변경하세요.';
    }
  }

  if (feature === 'refluxOverlayCollector') {
    const viewUrlChanged = config.viewUrl !== undefined
      && String(config.viewUrl || '') !== String(scheduler.config.viewUrl || '');
    const beforePagesChanged = config.beforePages !== undefined
      && Number(config.beforePages) !== Number(scheduler.config.beforePages);
    const afterPagesChanged = config.afterPages !== undefined
      && Number(config.afterPages) !== Number(scheduler.config.afterPages);
    const requestDelayChanged = config.requestDelayMs !== undefined
      && Number(config.requestDelayMs) !== Number(scheduler.config.requestDelayMs);
    const jitterChanged = config.jitterMs !== undefined
      && Number(config.jitterMs) !== Number(scheduler.config.jitterMs);
    const transportModeChanged = config.transportMode !== undefined
      && String(config.transportMode || '') !== String(scheduler.config.transportMode || '');
    const proxyWorkerCountChanged = config.proxyWorkerCount !== undefined
      && Number(config.proxyWorkerCount) !== Number(scheduler.config.proxyWorkerCount);
    const maxRetriesPerPageChanged = config.maxRetriesPerPage !== undefined
      && Number(config.maxRetriesPerPage) !== Number(scheduler.config.maxRetriesPerPage);
    if (
      viewUrlChanged
      || beforePagesChanged
      || afterPagesChanged
      || requestDelayChanged
      || jitterChanged
      || transportModeChanged
      || proxyWorkerCountChanged
      || maxRetriesPerPageChanged
    ) {
      return '임시 overlay 수집 설정은 기능을 정지한 뒤 변경하세요.';
    }
  }

  if (feature === 'commentRefluxCollector') {
    const galleryIdChanged = config.galleryId !== undefined
      && String(config.galleryId || '') !== String(scheduler.config.galleryId || '');
    const startPageChanged = config.startPage !== undefined
      && Number(config.startPage) !== Number(scheduler.config.startPage);
    const endPageChanged = config.endPage !== undefined
      && Number(config.endPage) !== Number(scheduler.config.endPage);
    const requestDelayChanged = config.requestDelayMs !== undefined
      && Number(config.requestDelayMs) !== Number(scheduler.config.requestDelayMs);
    const cycleDelayChanged = config.cycleDelayMs !== undefined
      && Number(config.cycleDelayMs) !== Number(scheduler.config.cycleDelayMs);
    const postConcurrencyChanged = config.postConcurrency !== undefined
      && Number(config.postConcurrency) !== Number(scheduler.config.postConcurrency);
    const commentPageConcurrencyChanged = config.commentPageConcurrency !== undefined
      && Number(config.commentPageConcurrency) !== Number(scheduler.config.commentPageConcurrency);
    if (
      galleryIdChanged
      || startPageChanged
      || endPageChanged
      || requestDelayChanged
      || cycleDelayChanged
      || postConcurrencyChanged
      || commentPageConcurrencyChanged
    ) {
      return '역류댓글 수집 설정은 기능을 정지한 뒤 변경하세요.';
    }
  }

  if (feature === 'ip'
    && config.includeUidTargetsOnManualStart !== undefined
    && Boolean(config.includeUidTargetsOnManualStart) !== Boolean(scheduler.config.includeUidTargetsOnManualStart)) {
    return '반고닉/고닉 포함 설정은 IP 차단을 정지한 뒤 변경하세요.';
  }

  return '';
}

function normalizeComparableConfigValue(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function getMonitorManualLockMessage(feature, action) {
  const trustedPostActive = schedulers.trustedCommandDefense.isRunning
    && (schedulers.trustedCommandDefense.ownedPostScheduler || schedulers.trustedCommandDefense.ownedIpScheduler);
  const trustedCommentActive = schedulers.trustedCommandDefense.isRunning
    && schedulers.trustedCommandDefense.ownedCommentScheduler;
  const trustedOwnsFeature = schedulers.trustedCommandDefense.isOwningFeature(feature);

  const monitorOwnsUidWarningAutoBanLock = schedulers.monitor.isRunning
    && [MONITOR_PHASE.ATTACKING, MONITOR_PHASE.RECOVERING].includes(schedulers.monitor.phase);

  if (feature === 'monitor'
    && action === 'start'
    && (schedulers.semiPost.isRunning || schedulers.semiPost.runPromise)) {
    return '감시 자동화를 시작하기 전에 반고닉 분류를 먼저 정지하세요.';
  }

  if (feature === 'uidWarningAutoBan'
    && action === 'start'
    && monitorOwnsUidWarningAutoBanLock) {
    return '감시 자동화 공격/복구 중에는 분탕자동차단을 수동으로 시작할 수 없습니다.';
  }

  const baseLockedActions = new Set(['start', 'stop', 'updateConfig', 'resetStats', 'releaseTrackedBans']);
  if (schedulers.monitor.isRunning && ['post', 'semiPost', 'ip'].includes(feature) && baseLockedActions.has(action)) {
    const allowTrustedOwnedStop = action === 'stop'
      && ['post', 'ip'].includes(feature)
      && trustedOwnsFeature;
    if (allowTrustedOwnedStop) {
      return '';
    }
    return '감시 자동화 실행 중에는 게시글 분류 / 반고닉 분류 / IP 차단을 수동으로 조작할 수 없습니다.';
  }

  if (monitorOwnsUidWarningAutoBanLock && feature === 'uidWarningAutoBan' && baseLockedActions.has(action)) {
    return '감시 자동화 실행 중에는 분탕자동차단을 수동으로 조작할 수 없습니다.';
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
    const allowTrustedOwnedStop = action === 'stop' && trustedOwnsFeature;
    if (allowTrustedOwnedStop) {
      return '';
    }
    return '댓글 감시 자동화 실행 중에는 댓글 방어를 수동으로 조작할 수 없습니다.';
  }

  const trustedPostLockedActions = new Set(['start', 'updateConfig', 'resetStats', 'releaseTrackedBans']);
  if (trustedPostActive && ['post', 'ip'].includes(feature) && trustedPostLockedActions.has(action)) {
    return '명령 게시물방어 실행 중에는 게시글 분류 / IP 차단을 수동으로 조작할 수 없습니다.';
  }

  const trustedCommentLockedActions = new Set(['start', 'updateConfig', 'resetStats']);
  if (trustedCommentActive && feature === 'comment' && trustedCommentLockedActions.has(action)) {
    return '명령 댓글방어 실행 중에는 댓글 방어를 수동으로 조작할 수 없습니다.';
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
    if (typeof schedulers.post.releaseAllKnownVpnGatePrefixConsumers === 'function') {
      await schedulers.post.releaseAllKnownVpnGatePrefixConsumers();
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

async function resolveUidWarningAutoBanResumeConflict() {
  if (!schedulers.uidWarningAutoBan.isRunning) {
    return;
  }

  const monitorOwnsUidWarningAutoBanLock = schedulers.monitor.isRunning
    && [MONITOR_PHASE.ATTACKING, MONITOR_PHASE.RECOVERING].includes(schedulers.monitor.phase);

  if (monitorOwnsUidWarningAutoBanLock) {
    let managedBanOnly = false;

    if (schedulers.uidWarningAutoBan.runtimeDeleteModeReason === 'monitor_attack') {
      managedBanOnly = true;
    } else if (typeof schedulers.uidWarningAutoBan.activateMonitorAttackBanOnly === 'function') {
      const switched = schedulers.uidWarningAutoBan.activateMonitorAttackBanOnly();
      managedBanOnly = Boolean(switched);
      if (switched) {
        schedulers.uidWarningAutoBan.log('ℹ️ 감시 자동화 공격/복구 상태 복원으로 분탕자동차단을 차단만 유지 상태로 맞춥니다.');
      }
    }

    schedulers.monitor.managedUidWarningAutoBanBanOnly = managedBanOnly;
    await schedulers.uidWarningAutoBan.saveState();
    await schedulers.monitor.saveState();
  }
}

async function stopDormantCommentMonitorChildScheduler() {
  if (!schedulers.comment.isRunning) {
    return;
  }

  schedulers.comment.isRunning = false;
  if (typeof schedulers.comment.releaseAllKnownVpnGatePrefixConsumers === 'function') {
    await schedulers.comment.releaseAllKnownVpnGatePrefixConsumers();
  }
  if (typeof schedulers.comment.setCurrentSource === 'function') {
    schedulers.comment.setCurrentSource('', { logChange: false });
  }
  schedulers.comment.currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
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
  scheduler.currentAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
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
  scheduler.currentManagedAttackMode = COMMENT_ATTACK_MODE.DEFAULT;
  scheduler.lastManagedAttackModeReason = '';
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

function resetConceptPatrolSchedulerState(message) {
  const scheduler = schedulers.conceptPatrol;
  scheduler.currentPage = 0;
  scheduler.currentPostNo = 0;
  scheduler.cycleCount = 0;
  scheduler.lastPollAt = '';
  scheduler.lastDetectedMaxPage = 0;
  scheduler.lastWindowSize = 0;
  scheduler.lastNewPostCount = 0;
  scheduler.lastCandidateCount = 0;
  scheduler.totalDetectedCount = 0;
  scheduler.totalReleasedCount = 0;
  scheduler.totalFailedCount = 0;
  scheduler.totalUnclearCount = 0;
  scheduler.baselineReady = false;
  scheduler.previousWindowPostNos = [];
  scheduler.previousWindowMeta = {};
  scheduler.baselineVersionKey = '';
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

function resetBumpPostSchedulerState(message) {
  const scheduler = schedulers.bumpPost;
  scheduler.phase = 'IDLE';
  scheduler.cycleCount = 0;
  scheduler.startedAt = '';
  scheduler.endsAt = '';
  scheduler.nextRunAt = '';
  scheduler.lastBumpedAt = '';
  scheduler.lastErrorAt = '';
  scheduler.lastErrorMessage = '';
  scheduler.lastBumpedPostNo = '';
  scheduler.totalBumpedCount = 0;
  scheduler.totalFailedCount = 0;
  scheduler.config.postNo = '';
  scheduler.logs = [];
  scheduler.log(message);
}

function resetSinmungoCommentSchedulerState(message) {
  const scheduler = schedulers.sinmungoComment;
  scheduler.phase = 'IDLE';
  scheduler.startedAt = '';
  scheduler.finishedAt = '';
  scheduler.lastSubmittedAt = '';
  scheduler.lastVerifiedAt = '';
  scheduler.lastSuccessAt = '';
  scheduler.lastErrorAt = '';
  scheduler.lastErrorMessage = '';
  scheduler.lastTargetPostNo = '';
  scheduler.lastSubmittedMemo = '';
  scheduler.lastCommentNo = '';
  scheduler.totalSubmittedCount = 0;
  scheduler.totalFailedCount = 0;
  scheduler.pendingChallenge = null;
  scheduler.config = normalizeSinmungoCommentConfig({
    ...scheduler.config,
    postNo: '',
    submitMode: 'member',
    memo: '처리완료',
    replyNo: '',
    name: 'ㅇㅇ',
    password: '',
    gallNickName: 'ㅇㅇ',
    useGallNick: 'N',
    recommend: 0,
  });
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
    scheduler.resetAutoCutState('ℹ️ 개념컷 자동조절 활성화 - 첫 비교 전까지 현재 개념컷을 유지합니다.');
    return;
  }

  if (currentEnabled && !nextEnabled) {
    scheduler.resetAutoCutState('ℹ️ 개념컷 자동조절 비활성화 - 상태를 초기화했습니다.');
  }
}

function adjustConceptMonitorConfigUpdateForRunningScheduler(scheduler, config) {
  const nextConfig = { ...(config || {}) };
  if (!scheduler?.isRunning || !Object.prototype.hasOwnProperty.call(nextConfig, 'testMode')) {
    return {
      config: nextConfig,
      message: '',
    };
  }

  if (Boolean(nextConfig.testMode) === Boolean(scheduler.config?.testMode)) {
    return {
      config: nextConfig,
      message: '',
    };
  }

  delete nextConfig.testMode;
  return {
    config: nextConfig,
    message: '개념글 방어 실행 중이라 테스트 모드 변경은 저장되지 않았습니다. 나머지 설정만 저장했습니다.',
  };
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
  if (typeof scheduler.resetSearchDuplicateRuntime === 'function') {
    scheduler.resetSearchDuplicateRuntime();
  }
  scheduler.config.cutoffPostNo = 0;
  scheduler.logs = [];
  scheduler.log(message);
}

async function maybeHandleRunningPostModeTransition(scheduler, config) {
  const currentManualAttackMode = normalizePostManualAttackMode(scheduler.config?.manualAttackMode);
  const nextManualAttackMode = config.manualAttackMode === undefined
    ? currentManualAttackMode
    : normalizePostManualAttackMode(config.manualAttackMode);
  const currentRuntimeAttackMode = normalizePostManualAttackMode(scheduler.currentAttackMode);
  const currentEffectiveAttackMode = scheduler.currentSource === 'manual'
    ? currentRuntimeAttackMode
    : currentManualAttackMode;
  const nextMergedConfig = {
    ...scheduler.config,
    ...config,
    manualAttackMode: nextManualAttackMode,
  };
  const currentSearchGalleryId = resolveRefluxSearchGalleryId(scheduler.config);
  const nextSearchGalleryId = resolveRefluxSearchGalleryId(nextMergedConfig);

  if (currentManualAttackMode === nextManualAttackMode) {
    const shouldRestartRunningManualReflux = scheduler.currentSource === 'manual'
      && currentEffectiveAttackMode === POST_ATTACK_MODE.SEMICONDUCTOR_REFLUX
      && currentSearchGalleryId !== nextSearchGalleryId;
    if (!shouldRestartRunningManualReflux) {
      return null;
    }

    try {
      await scheduler.transitionManualRefluxConfigWhileRunning(nextMergedConfig);
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
  return normalizePostAttackMode(value);
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
  scheduler.includeUidTargetsMode = false;
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

function resetUidWarningAutoBanSchedulerState(message) {
  const scheduler = schedulers.uidWarningAutoBan;
  scheduler.phase = 'IDLE';
  scheduler.currentPage = 1;
  scheduler.lastPollAt = '';
  scheduler.nextRunAt = '';
  scheduler.lastTriggeredUid = '';
  scheduler.lastTriggeredPostCount = 0;
  scheduler.lastBurstRecentCount = 0;
  scheduler.lastSingleSightTriggeredUid = '';
  scheduler.lastSingleSightTriggeredPostCount = 0;
  scheduler.lastImmediateTitleBanCount = 0;
  scheduler.lastImmediateTitleBanMatchedTitle = '';
  scheduler.lastPageRowCount = 0;
  scheduler.lastPageUidCount = 0;
  scheduler.totalTriggeredUidCount = 0;
  scheduler.totalSingleSightTriggeredUidCount = 0;
  scheduler.totalImmediateTitleBanPostCount = 0;
  scheduler.totalSingleSightBannedPostCount = 0;
  scheduler.totalBannedPostCount = 0;
  scheduler.totalFailedPostCount = 0;
  scheduler.deleteLimitFallbackCount = 0;
  scheduler.banOnlyFallbackCount = 0;
  scheduler.lastError = '';
  scheduler.cycleCount = 0;
  scheduler.runtimeDeleteEnabled = Boolean(scheduler.config?.delChk);
  scheduler.runtimeDeleteModeReason = 'normal';
  scheduler.lastDeleteLimitExceededAt = '';
  scheduler.lastDeleteLimitMessage = '';
  scheduler.recentUidActions = {};
  scheduler.recentImmediatePostActions = {};
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
  scheduler.managedUidWarningAutoBanBanOnly = false;
  scheduler.totalAttackDetected = 0;
  scheduler.totalAttackReleased = 0;
  scheduler.logs = [];
  scheduler.log(message);
}

function resetTrustedCommandDefenseSchedulerState(message) {
  const scheduler = schedulers.trustedCommandDefense;
  scheduler.phase = 'IDLE';
  scheduler.pollCount = 0;
  scheduler.startedAt = '';
  scheduler.lastPollAt = '';
  scheduler.seededAt = '';
  scheduler.seeded = false;
  scheduler.lastSeenCommentNo = '';
  scheduler.processedCommandCommentNos = [];
  scheduler.lastCommandType = '';
  scheduler.lastCommandCommentNo = '';
  scheduler.lastCommandUserId = '';
  scheduler.lastCommandAt = '';
  scheduler.postDefenseUntilTs = 0;
  scheduler.commentDefenseUntilTs = 0;
  scheduler.ownedPostScheduler = false;
  scheduler.ownedIpScheduler = false;
  scheduler.ownedCommentScheduler = false;
  scheduler.postDefenseCutoffPostNo = 0;
  scheduler.logs = [];
  scheduler.log(message);
}
