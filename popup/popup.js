const featureTabs = document.querySelectorAll('.tab-button');
const featurePanels = document.querySelectorAll('.panel');
const sharedGalleryIdInput = document.getElementById('sharedGalleryId');
const sharedHeadtextIdInput = document.getElementById('sharedHeadtextId');
const sharedSaveConfigBtn = document.getElementById('sharedSaveConfigBtn');
const DIRTY_FEATURES = {
  conceptMonitor: false,
  conceptPatrol: false,
  hanRefreshIpBan: false,
  commentMonitor: false,
  comment: false,
  post: false,
  semiPost: false,
  ip: false,
  monitor: false,
};
let sharedConfigDirty = false;
let sessionFallbackDirty = false;
let latestMonitorStatus = null;
let latestConceptMonitorStatus = null;
let latestConceptPatrolStatus = null;
let latestSessionFallbackStatus = null;

const SESSION_FALLBACK_DOM = {
  keepaliveToggle: document.getElementById('sessionFallbackKeepaliveToggle'),
  keepaliveLabel: document.getElementById('sessionFallbackKeepaliveLabel'),
  primaryUserIdInput: document.getElementById('sessionFallbackPrimaryUserId'),
  primaryPasswordInput: document.getElementById('sessionFallbackPrimaryPassword'),
  backupUserIdInput: document.getElementById('sessionFallbackBackupUserId'),
  backupPasswordInput: document.getElementById('sessionFallbackBackupPassword'),
  testSwitchBtn: document.getElementById('sessionFallbackTestSwitchBtn'),
  saveConfigBtn: document.getElementById('sessionFallbackSaveConfigBtn'),
  activeAccountText: document.getElementById('sessionFallbackActiveAccountText'),
  automationStateText: document.getElementById('sessionFallbackAutomationStateText'),
  switchStateText: document.getElementById('sessionFallbackSwitchStateText'),
  loginHealthText: document.getElementById('sessionFallbackLoginHealthText'),
  lastDeleteLimitAccountText: document.getElementById('sessionFallbackLastDeleteLimitAccountText'),
  metaText: document.getElementById('sessionFallbackMetaText'),
};

const FEATURE_DOM = {
  conceptMonitor: {
    toggleBtn: document.getElementById('conceptMonitorToggleBtn'),
    toggleLabel: document.getElementById('conceptMonitorToggleLabel'),
    statusText: document.getElementById('conceptMonitorStatusText'),
    modeText: document.getElementById('conceptMonitorModeText'),
    autoCutStateText: document.getElementById('conceptMonitorAutoCutStateText'),
    lastPollAt: document.getElementById('conceptMonitorLastPollAt'),
    currentPostNo: document.getElementById('conceptMonitorCurrentPostNo'),
    lastScanCount: document.getElementById('conceptMonitorLastScanCount'),
    lastCandidateCount: document.getElementById('conceptMonitorLastCandidateCount'),
    totalDetectedCount: document.getElementById('conceptMonitorTotalDetectedCount'),
    totalReleasedCount: document.getElementById('conceptMonitorTotalReleasedCount'),
    totalFailedCount: document.getElementById('conceptMonitorTotalFailedCount'),
    totalUnclearCount: document.getElementById('conceptMonitorTotalUnclearCount'),
    lastRecommendDelta: document.getElementById('conceptMonitorLastRecommendDelta'),
    lastComparedPostCount: document.getElementById('conceptMonitorLastComparedPostCount'),
    lastCutChangedAt: document.getElementById('conceptMonitorLastCutChangedAt'),
    logList: document.getElementById('conceptMonitorLogList'),
    pollIntervalMsInput: document.getElementById('conceptMonitorPollIntervalMs'),
    snapshotPostLimitInput: document.getElementById('conceptMonitorSnapshotPostLimit'),
    fluidRatioThresholdInput: document.getElementById('conceptMonitorFluidRatioThreshold'),
    testModeInput: document.getElementById('conceptMonitorTestMode'),
    autoCutEnabledInput: document.getElementById('conceptMonitorAutoCutEnabled'),
    autoCutEnabledLabel: document.getElementById('conceptMonitorAutoCutEnabledLabel'),
    autoCutPollIntervalMsInput: document.getElementById('conceptMonitorAutoCutPollIntervalMs'),
    autoCutAttackThresholdInput: document.getElementById('conceptMonitorAutoCutAttackThreshold'),
    autoCutAttackConsecutiveCountInput: document.getElementById('conceptMonitorAutoCutAttackConsecutiveCount'),
    autoCutReleaseThresholdInput: document.getElementById('conceptMonitorAutoCutReleaseThreshold'),
    autoCutReleaseConsecutiveCountInput: document.getElementById('conceptMonitorAutoCutReleaseConsecutiveCount'),
    saveConfigBtn: document.getElementById('conceptMonitorSaveConfigBtn'),
    resetBtn: document.getElementById('conceptMonitorResetBtn'),
  },
  conceptPatrol: {
    toggleBtn: document.getElementById('conceptPatrolToggleBtn'),
    toggleLabel: document.getElementById('conceptPatrolToggleLabel'),
    statusText: document.getElementById('conceptPatrolStatusText'),
    modeText: document.getElementById('conceptPatrolModeText'),
    holdStateText: document.getElementById('conceptPatrolHoldStateText'),
    effectiveRecommendCutText: document.getElementById('conceptPatrolEffectiveRecommendCutText'),
    lastPollAt: document.getElementById('conceptPatrolLastPollAt'),
    currentPosition: document.getElementById('conceptPatrolCurrentPosition'),
    lastDetectedMaxPage: document.getElementById('conceptPatrolLastDetectedMaxPage'),
    lastWindowSize: document.getElementById('conceptPatrolLastWindowSize'),
    lastNewPostCount: document.getElementById('conceptPatrolLastNewPostCount'),
    lastCandidateCount: document.getElementById('conceptPatrolLastCandidateCount'),
    totalDetectedCount: document.getElementById('conceptPatrolTotalDetectedCount'),
    totalReleasedCount: document.getElementById('conceptPatrolTotalReleasedCount'),
    totalFailedCount: document.getElementById('conceptPatrolTotalFailedCount'),
    totalUnclearCount: document.getElementById('conceptPatrolTotalUnclearCount'),
    holdUntilText: document.getElementById('conceptPatrolHoldUntilText'),
    lastCutChangedAt: document.getElementById('conceptPatrolLastCutChangedAt'),
    logList: document.getElementById('conceptPatrolLogList'),
    pollIntervalMsInput: document.getElementById('conceptPatrolPollIntervalMs'),
    patrolPagesInput: document.getElementById('conceptPatrolPages'),
    pageRequestDelayInput: document.getElementById('conceptPatrolPageRequestDelayMs'),
    fluidRatioThresholdInput: document.getElementById('conceptPatrolFluidRatioThreshold'),
    candidateThresholdInput: document.getElementById('conceptPatrolCandidateThreshold'),
    holdMsInput: document.getElementById('conceptPatrolHoldMs'),
    testModeInput: document.getElementById('conceptPatrolTestMode'),
    saveConfigBtn: document.getElementById('conceptPatrolSaveConfigBtn'),
    resetBtn: document.getElementById('conceptPatrolResetBtn'),
  },
  hanRefreshIpBan: {
    toggleBtn: document.getElementById('hanRefreshIpBanToggleBtn'),
    toggleLabel: document.getElementById('hanRefreshIpBanToggleLabel'),
    statusText: document.getElementById('hanRefreshIpBanStatusText'),
    phaseText: document.getElementById('hanRefreshIpBanPhaseText'),
    currentPage: document.getElementById('hanRefreshIpBanCurrentPage'),
    detectedMaxPage: document.getElementById('hanRefreshIpBanDetectedMaxPage'),
    currentCycleScannedRows: document.getElementById('hanRefreshIpBanCurrentCycleScannedRows'),
    currentCycleMatchedRows: document.getElementById('hanRefreshIpBanCurrentCycleMatchedRows'),
    currentCycleBanSuccessCount: document.getElementById('hanRefreshIpBanCurrentCycleBanSuccessCount'),
    currentCycleBanFailureCount: document.getElementById('hanRefreshIpBanCurrentCycleBanFailureCount'),
    lastRunAt: document.getElementById('hanRefreshIpBanLastRunAt'),
    nextRunAt: document.getElementById('hanRefreshIpBanNextRunAt'),
    logList: document.getElementById('hanRefreshIpBanLogList'),
    requestDelayInput: document.getElementById('hanRefreshIpBanRequestDelay'),
    fallbackMaxPageInput: document.getElementById('hanRefreshIpBanFallbackMaxPage'),
    saveConfigBtn: document.getElementById('hanRefreshIpBanSaveConfigBtn'),
    resetBtn: document.getElementById('hanRefreshIpBanResetBtn'),
  },
  commentMonitor: {
    toggleBtn: document.getElementById('commentMonitorToggleBtn'),
    toggleLabel: document.getElementById('commentMonitorToggleLabel'),
    statusText: document.getElementById('commentMonitorStatusText'),
    phaseText: document.getElementById('commentMonitorPhaseText'),
    lastPollAt: document.getElementById('commentMonitorLastPollAt'),
    newCommentCount: document.getElementById('commentMonitorNewCommentCount'),
    verifiedDeletedCount: document.getElementById('commentMonitorVerifiedDeletedCount'),
    changedPostCount: document.getElementById('commentMonitorChangedPostCount'),
    attackHitCount: document.getElementById('commentMonitorAttackHitCount'),
    releaseHitCount: document.getElementById('commentMonitorReleaseHitCount'),
    totalAttackDetected: document.getElementById('commentMonitorTotalAttackDetected'),
    totalAttackReleased: document.getElementById('commentMonitorTotalAttackReleased'),
    logList: document.getElementById('commentMonitorLogList'),
    pollIntervalMsInput: document.getElementById('commentMonitorPollIntervalMs'),
    pagesInput: document.getElementById('commentMonitorPages'),
    attackNewCommentThresholdInput: document.getElementById('commentMonitorAttackNewCommentThreshold'),
    attackChangedPostThresholdInput: document.getElementById('commentMonitorAttackChangedPostThreshold'),
    attackAltNewCommentThresholdInput: document.getElementById('commentMonitorAttackAltNewCommentThreshold'),
    attackAltChangedPostThresholdInput: document.getElementById('commentMonitorAttackAltChangedPostThreshold'),
    attackConsecutiveCountInput: document.getElementById('commentMonitorAttackConsecutiveCount'),
    releaseNewCommentThresholdInput: document.getElementById('commentMonitorReleaseNewCommentThreshold'),
    releaseVerifiedDeleteThresholdInput: document.getElementById('commentMonitorReleaseVerifiedDeleteThreshold'),
    releaseConsecutiveCountInput: document.getElementById('commentMonitorReleaseConsecutiveCount'),
    saveConfigBtn: document.getElementById('commentMonitorSaveConfigBtn'),
    resetBtn: document.getElementById('commentMonitorResetBtn'),
  },
  comment: {
    toggleBtn: document.getElementById('commentToggleBtn'),
    toggleLabel: document.getElementById('commentToggleLabel'),
    statusText: document.getElementById('commentStatusText'),
    currentPosition: document.getElementById('commentCurrentPosition'),
    totalDeleted: document.getElementById('commentTotalDeleted'),
    cycleCount: document.getElementById('commentCycleCount'),
    logList: document.getElementById('commentLogList'),
    minPageInput: document.getElementById('commentMinPage'),
    maxPageInput: document.getElementById('commentMaxPage'),
    requestDelayInput: document.getElementById('commentRequestDelay'),
    cycleDelayInput: document.getElementById('commentCycleDelay'),
    postConcurrencyInput: document.getElementById('commentPostConcurrency'),
    banOnDeleteInput: document.getElementById('commentBanOnDelete'),
    excludePureHangulInput: document.getElementById('commentExcludePureHangul'),
    avoidHourInput: document.getElementById('commentAvoidHour'),
    saveConfigBtn: document.getElementById('commentSaveConfigBtn'),
    resetBtn: document.getElementById('commentResetBtn'),
  },
  post: {
    toggleBtn: document.getElementById('postToggleBtn'),
    toggleLabel: document.getElementById('postToggleLabel'),
    statusText: document.getElementById('postStatusText'),
    currentPosition: document.getElementById('postCurrentPosition'),
    totalClassified: document.getElementById('postTotalClassified'),
    cycleCount: document.getElementById('postCycleCount'),
    logList: document.getElementById('postLogList'),
    minPageInput: document.getElementById('postMinPage'),
    maxPageInput: document.getElementById('postMaxPage'),
    requestDelayInput: document.getElementById('postRequestDelay'),
    cycleDelayInput: document.getElementById('postCycleDelay'),
    cjkModeToggleInput: document.getElementById('postCjkModeToggle'),
    saveConfigBtn: document.getElementById('postSaveConfigBtn'),
    resetBtn: document.getElementById('postResetBtn'),
  },
  semiPost: {
    toggleBtn: document.getElementById('semiPostToggleBtn'),
    toggleLabel: document.getElementById('semiPostToggleLabel'),
    statusText: document.getElementById('semiPostStatusText'),
    currentPosition: document.getElementById('semiPostCurrentPosition'),
    totalClassified: document.getElementById('semiPostTotalClassified'),
    totalSuspiciousUid: document.getElementById('semiPostTotalSuspiciousUid'),
    cycleCount: document.getElementById('semiPostCycleCount'),
    logList: document.getElementById('semiPostLogList'),
    minPageInput: document.getElementById('semiPostMinPage'),
    maxPageInput: document.getElementById('semiPostMaxPage'),
    requestDelayInput: document.getElementById('semiPostRequestDelay'),
    cycleDelayInput: document.getElementById('semiPostCycleDelay'),
    minTotalActivityCountInput: document.getElementById('semiPostMinTotalActivityCount'),
    minPostRatioPercentInput: document.getElementById('semiPostMinPostRatioPercent'),
    saveConfigBtn: document.getElementById('semiPostSaveConfigBtn'),
    resetBtn: document.getElementById('semiPostResetBtn'),
  },
  ip: {
    toggleBtn: document.getElementById('ipToggleBtn'),
    toggleLabel: document.getElementById('ipToggleLabel'),
    statusText: document.getElementById('ipStatusText'),
    currentPosition: document.getElementById('ipCurrentPosition'),
    totalBanned: document.getElementById('ipTotalBanned'),
    activeBanCount: document.getElementById('ipActiveBanCount'),
    totalReleased: document.getElementById('ipTotalReleased'),
    cycleCount: document.getElementById('ipCycleCount'),
    logList: document.getElementById('ipLogList'),
    minPageInput: document.getElementById('ipMinPage'),
    maxPageInput: document.getElementById('ipMaxPage'),
    requestDelayInput: document.getElementById('ipRequestDelay'),
    cycleDelayInput: document.getElementById('ipCycleDelay'),
    releaseScanMaxPagesInput: document.getElementById('ipReleaseScanMaxPages'),
    avoidHourInput: document.getElementById('ipAvoidHour'),
    includeUidTargetsOnManualStartInput: document.getElementById('ipIncludeUidTargetsOnManualStart'),
    includeExistingTargetsOnStartInput: document.getElementById('ipIncludeExistingTargetsOnStart'),
    saveConfigBtn: document.getElementById('ipSaveConfigBtn'),
    releaseBtn: document.getElementById('ipReleaseBtn'),
    resetBtn: document.getElementById('ipResetBtn'),
  },
  monitor: {
    toggleBtn: document.getElementById('monitorToggleBtn'),
    toggleLabel: document.getElementById('monitorToggleLabel'),
    statusText: document.getElementById('monitorStatusText'),
    phaseText: document.getElementById('monitorPhaseText'),
    attackModeText: document.getElementById('monitorAttackModeText'),
    lastPollAt: document.getElementById('monitorLastPollAt'),
    newPostCount: document.getElementById('monitorNewPostCount'),
    newFluidCount: document.getElementById('monitorNewFluidCount'),
    fluidRatio: document.getElementById('monitorFluidRatio'),
    attackHitCount: document.getElementById('monitorAttackHitCount'),
    releaseHitCount: document.getElementById('monitorReleaseHitCount'),
    totalAttackDetected: document.getElementById('monitorTotalAttackDetected'),
    totalAttackReleased: document.getElementById('monitorTotalAttackReleased'),
    logList: document.getElementById('monitorLogList'),
    pollIntervalMsInput: document.getElementById('monitorPollIntervalMs'),
    pagesInput: document.getElementById('monitorPages'),
    attackNewPostThresholdInput: document.getElementById('monitorAttackNewPostThreshold'),
    attackFluidRatioThresholdInput: document.getElementById('monitorAttackFluidRatioThreshold'),
    attackConsecutiveCountInput: document.getElementById('monitorAttackConsecutiveCount'),
    releaseNewPostThresholdInput: document.getElementById('monitorReleaseNewPostThreshold'),
    releaseFluidRatioThresholdInput: document.getElementById('monitorReleaseFluidRatioThreshold'),
    releaseConsecutiveCountInput: document.getElementById('monitorReleaseConsecutiveCount'),
    saveConfigBtn: document.getElementById('monitorSaveConfigBtn'),
    resetBtn: document.getElementById('monitorResetBtn'),
  },
};

document.addEventListener('DOMContentLoaded', async () => {
  bindTabEvents();
  bindFeatureEvents();
  bindSharedConfigEvents();
  await refreshAllStatuses();
  setInterval(refreshAllStatuses, 1000);
});

function bindTabEvents() {
  featureTabs.forEach((button) => {
    button.addEventListener('click', () => {
      const nextFeature = button.dataset.tab;
      setActiveTab(nextFeature);
    });
  });
}

function bindFeatureEvents() {
  bindConfigDirtyTracking('conceptMonitor');
  bindConfigDirtyTracking('conceptPatrol');
  bindConfigDirtyTracking('hanRefreshIpBan');
  bindConfigDirtyTracking('commentMonitor');
  bindConfigDirtyTracking('comment');
  bindConfigDirtyTracking('post');
  bindConfigDirtyTracking('semiPost');
  bindConfigDirtyTracking('ip');
  bindConfigDirtyTracking('monitor');
  bindConceptMonitorEvents();
  bindHanRefreshIpBanEvents();
  bindCommentMonitorEvents();
  bindCommentEvents();
  bindPostEvents();
  bindSemiPostEvents();
  bindIpEvents();
  bindMonitorEvents();
  bindConceptPatrolEvents();
}

function bindSharedConfigEvents() {
  sharedGalleryIdInput.addEventListener('input', () => {
    sharedConfigDirty = true;
  });

  sharedHeadtextIdInput.addEventListener('input', () => {
    sharedConfigDirty = true;
  });

  sharedSaveConfigBtn.addEventListener('click', async () => {
    const galleryId = sharedGalleryIdInput.value.trim();
    const headtextIdValue = sharedHeadtextIdInput.value.trim();

    if (!galleryId) {
      alert('갤러리 ID를 입력하세요.');
      sharedGalleryIdInput.focus();
      return;
    }

    if (/\s/.test(galleryId)) {
      alert('갤러리 ID에는 공백을 넣을 수 없습니다.');
      sharedGalleryIdInput.focus();
      return;
    }

    if (!/^\d+$/.test(headtextIdValue) || Number(headtextIdValue) <= 0) {
      alert('도배기탭 번호는 1 이상의 숫자로 입력하세요.');
      sharedHeadtextIdInput.focus();
      return;
    }

    const config = {
      galleryId,
      headtextId: String(Number(headtextIdValue)),
    };

    const response = await sendMessage({ action: 'updateSharedConfig', config });
    if (!response?.success) {
      alert(response?.message || '공통 설정 저장에 실패했습니다.');
      return;
    }

    sharedConfigDirty = false;
    flashSaved(sharedSaveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    }
  });

  [
    SESSION_FALLBACK_DOM.keepaliveToggle,
    SESSION_FALLBACK_DOM.primaryUserIdInput,
    SESSION_FALLBACK_DOM.primaryPasswordInput,
    SESSION_FALLBACK_DOM.backupUserIdInput,
    SESSION_FALLBACK_DOM.backupPasswordInput,
  ].forEach((input) => {
    input.addEventListener('input', () => {
      sessionFallbackDirty = true;
    });
  });

  SESSION_FALLBACK_DOM.keepaliveToggle.addEventListener('change', async () => {
    if (hasPendingSessionFallbackCredentialEdits()) {
      alert('계정 아이디/비밀번호 변경분이 있으면 먼저 계정 저장을 눌러주세요.');
      revertSessionFallbackKeepaliveToggle();
      return;
    }

    await persistSessionFallbackConfig({
      failureMessage: '로그인 세션 자동화 설정 저장에 실패했습니다.',
      suppressFlash: true,
      revertOnFailure: true,
    });
  });

  SESSION_FALLBACK_DOM.saveConfigBtn.addEventListener('click', async () => {
    await persistSessionFallbackConfig();
  });

  SESSION_FALLBACK_DOM.testSwitchBtn.addEventListener('click', async () => {
    if (sessionFallbackDirty) {
      alert('계정 정보를 먼저 저장하세요.');
      return;
    }

    let response = null;
    setDisabled(SESSION_FALLBACK_DOM.testSwitchBtn, true);
    try {
      response = await sendMessage({ action: 'testSessionFallbackSwitch' });
      if (!response?.success) {
        alert(response?.message || '계정 전환 테스트에 실패했습니다.');
        if (response?.sessionFallbackStatus) {
          updateSessionFallbackUI(response.sessionFallbackStatus);
        }
        if (response?.statuses) {
          applyStatuses(response.statuses);
        }
        return;
      }

      if (response?.sessionFallbackStatus) {
        updateSessionFallbackUI(response.sessionFallbackStatus);
      }
      if (response?.statuses) {
        applyStatuses(response.statuses);
      }
      flashSaved(SESSION_FALLBACK_DOM.testSwitchBtn, '✅ 전환 완료');
      alert(response?.message || '계정 전환 테스트가 완료되었습니다.');
    } finally {
      if (!response?.sessionFallbackStatus?.switchInProgress
        && !response?.sessionFallbackStatus?.sessionAutomationInProgress) {
        setDisabled(SESSION_FALLBACK_DOM.testSwitchBtn, false);
      }
    }
  });
}

function bindConceptMonitorEvents() {
  const dom = FEATURE_DOM.conceptMonitor;

  dom.autoCutEnabledInput.addEventListener('change', () => {
    updateToggle({ toggleBtn: dom.autoCutEnabledInput, toggleLabel: dom.autoCutEnabledLabel }, dom.autoCutEnabledInput.checked);
  });

  dom.toggleBtn.addEventListener('change', async () => {
    if (dom.toggleBtn.checked) {
      if (!latestConceptMonitorStatus) {
        await refreshAllStatuses();
      }

      if (!latestConceptMonitorStatus) {
        alert('개념글 방어 상태를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
        updateToggle(dom, false);
        return;
      }

      if (DIRTY_FEATURES.conceptMonitor) {
        alert('개념글 방어 설정 변경사항을 먼저 저장하세요.');
        updateToggle(dom, false);
        return;
      }

      if (latestConceptMonitorStatus?.config?.testMode === false
        && !confirm('실행 모드에서는 실제로 개념글 해제를 요청합니다. 계속하시겠습니까?')) {
        updateToggle(dom, false);
        return;
      }
    }

    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('conceptMonitor', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptMonitor = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const nextTestMode = dom.testModeInput.checked;
    if (latestConceptMonitorStatus?.config?.testMode === true
      && nextTestMode === false
      && !confirm('테스트 모드를 끄면 실제 개념글 해제를 실행할 수 있습니다. 저장하시겠습니까?')) {
      return;
    }

    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 30000)),
      snapshotPostLimit: Math.max(1, parseOptionalInt(dom.snapshotPostLimitInput.value, 5)),
      fluidRatioThresholdPercent: clampPercent(dom.fluidRatioThresholdInput.value, 90, 0),
      testMode: nextTestMode,
      autoCutEnabled: dom.autoCutEnabledInput.checked,
      autoCutPollIntervalMs: Math.max(1000, parseOptionalInt(dom.autoCutPollIntervalMsInput.value, 30000)),
      autoCutAttackRecommendThreshold: Math.max(0, parseOptionalInt(dom.autoCutAttackThresholdInput.value, 200)),
      autoCutAttackConsecutiveCount: Math.max(1, parseOptionalInt(dom.autoCutAttackConsecutiveCountInput.value, 1)),
      autoCutReleaseRecommendThreshold: Math.max(0, parseOptionalInt(dom.autoCutReleaseThresholdInput.value, 40)),
      autoCutReleaseConsecutiveCount: Math.max(1, parseOptionalInt(dom.autoCutReleaseConsecutiveCountInput.value, 2)),
    };

    const response = await sendFeatureMessage('conceptMonitor', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptMonitor = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('개념글 방어 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('conceptMonitor', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindConceptPatrolEvents() {
  const dom = FEATURE_DOM.conceptPatrol;

  dom.toggleBtn.addEventListener('change', async () => {
    if (dom.toggleBtn.checked) {
      if (!latestConceptPatrolStatus) {
        await refreshAllStatuses();
      }

      if (!latestConceptPatrolStatus) {
        alert('개념글순회 상태를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
        updateToggle(dom, false);
        return;
      }

      if (DIRTY_FEATURES.conceptPatrol) {
        alert('개념글순회 설정 변경사항을 먼저 저장하세요.');
        updateToggle(dom, false);
        return;
      }

      if (latestConceptPatrolStatus?.config?.testMode === false
        && !confirm('실행 모드에서는 실제로 개념글 해제를 요청합니다. 계속하시겠습니까?')) {
        updateToggle(dom, false);
        return;
      }
    }

    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('conceptPatrol', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptPatrol = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const nextTestMode = dom.testModeInput.checked;
    if (latestConceptPatrolStatus?.config?.testMode === true
      && nextTestMode === false
      && !confirm('테스트 모드를 끄면 실제 개념글 해제를 실행할 수 있습니다. 저장하시겠습니까?')) {
      return;
    }

    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 30000)),
      patrolPages: Math.max(1, parseOptionalInt(dom.patrolPagesInput.value, 5)),
      pageRequestDelayMs: Math.max(0, parseOptionalInt(dom.pageRequestDelayInput.value, 500)),
      fluidRatioThresholdPercent: clampPercent(dom.fluidRatioThresholdInput.value, 90, 0),
      patrolDefendingCandidateThreshold: Math.max(1, parseOptionalInt(dom.candidateThresholdInput.value, 2)),
      patrolDefendingHoldMs: Math.max(1000, parseOptionalInt(dom.holdMsInput.value, 300000)),
      testMode: nextTestMode,
    };

    const response = await sendFeatureMessage('conceptPatrol', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptPatrol = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('개념글순회 통계와 baseline, 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('conceptPatrol', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindHanRefreshIpBanEvents() {
  const dom = FEATURE_DOM.hanRefreshIpBan;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('hanRefreshIpBan', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.hanRefreshIpBan = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      requestDelay: Math.max(0, parseOptionalInt(dom.requestDelayInput.value, 500)),
      fallbackMaxPage: Math.max(1, parseOptionalInt(dom.fallbackMaxPageInput.value, 400)),
    };

    const response = await sendFeatureMessage('hanRefreshIpBan', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.hanRefreshIpBan = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('도배기 갱신 차단 자동 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('hanRefreshIpBan', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindCommentMonitorEvents() {
  const dom = FEATURE_DOM.commentMonitor;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('commentMonitor', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.commentMonitor = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 20000)),
      monitorPages: Math.max(1, parseOptionalInt(dom.pagesInput.value, 2)),
      attackNewCommentThreshold: Math.max(1, parseOptionalInt(dom.attackNewCommentThresholdInput.value, 30)),
      attackChangedPostThreshold: Math.max(1, parseOptionalInt(dom.attackChangedPostThresholdInput.value, 20)),
      attackAltNewCommentThreshold: Math.max(1, parseOptionalInt(dom.attackAltNewCommentThresholdInput.value, 50)),
      attackAltChangedPostThreshold: Math.max(1, parseOptionalInt(dom.attackAltChangedPostThresholdInput.value, 9)),
      attackConsecutiveCount: Math.max(1, parseOptionalInt(dom.attackConsecutiveCountInput.value, 2)),
      releaseNewCommentThreshold: Math.max(0, parseOptionalInt(dom.releaseNewCommentThresholdInput.value, 30)),
      releaseVerifiedDeleteThreshold: Math.max(0, parseOptionalInt(dom.releaseVerifiedDeleteThresholdInput.value, 10)),
      releaseConsecutiveCount: Math.max(1, parseOptionalInt(dom.releaseConsecutiveCountInput.value, 3)),
    };

    const response = await sendFeatureMessage('commentMonitor', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.commentMonitor = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('댓글 감시 자동화 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('commentMonitor', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindCommentEvents() {
  const dom = FEATURE_DOM.comment;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const message = action === 'start'
      ? { action, source: 'manual', excludePureHangulOnStart: false }
      : { action };
    const response = await sendFeatureMessage('comment', message);
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });

  dom.excludePureHangulInput.addEventListener('change', async () => {
    const targetEnabled = dom.excludePureHangulInput.checked;
    const statusResponse = await sendFeatureMessage('comment', { action: 'getStatus' });
    if (!statusResponse?.success || !statusResponse.status) {
      await refreshAllStatuses();
      return;
    }

    const currentStatus = statusResponse.status;
    let response = null;

    if (targetEnabled) {
      if (currentStatus.isRunning) {
        if (currentStatus.currentSource === 'manual' && currentStatus.excludePureHangulMode) {
          updateCommentUI(currentStatus);
          return;
        }

        alert('일반 댓글 방어가 이미 실행 중입니다. 먼저 정지한 뒤 한글제외 유동닉댓글 삭제를 켜세요.');
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('comment', {
        action: 'start',
        source: 'manual',
        excludePureHangulOnStart: true,
      });
    } else {
      if (!currentStatus.isRunning || currentStatus.currentSource !== 'manual' || !currentStatus.excludePureHangulMode) {
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('comment', { action: 'stop' });
    }

    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 100),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      postConcurrency: parseOptionalInt(dom.postConcurrencyInput.value, 50),
      banOnDelete: dom.banOnDeleteInput.checked,
      avoidHour: String(Math.max(1, parseOptionalInt(dom.avoidHourInput.value, 1))),
    };

    const response = await sendFeatureMessage('comment', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.comment = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('댓글 방어 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('comment', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });
}

function bindPostEvents() {
  const dom = FEATURE_DOM.post;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('post', action === 'start'
      ? {
        action,
        source: 'manual',
        attackMode: 'default',
      }
      : { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    updatePostUI(response.status);
  });

  dom.cjkModeToggleInput.addEventListener('change', async () => {
    const targetEnabled = dom.cjkModeToggleInput.checked;
    const statusResponse = await sendFeatureMessage('post', { action: 'getStatus' });
    if (!statusResponse?.success || !statusResponse.status) {
      await refreshAllStatuses();
      return;
    }

    const currentStatus = statusResponse.status;
    let response = null;

    if (targetEnabled) {
      if (currentStatus.isRunning) {
        if (currentStatus.currentSource === 'manual' && currentStatus.currentAttackMode === 'cjk_narrow') {
          updatePostUI(currentStatus);
          return;
        }

        alert('일반 게시글 분류가 이미 실행 중입니다. 먼저 정지한 뒤 중국어/한자 공격을 켜세요.');
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('post', {
        action: 'start',
        source: 'manual',
        attackMode: 'cjk_narrow',
      });
    } else {
      if (!currentStatus.isRunning || currentStatus.currentSource !== 'manual' || currentStatus.currentAttackMode !== 'cjk_narrow') {
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('post', { action: 'stop' });
    }

    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updatePostUI(response.status);
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 1),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
    };

    const response = await sendFeatureMessage('post', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.post = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      updatePostUI(response.status);
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('게시글 분류 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('post', { action: 'resetStats' });
    if (response?.success) {
      updatePostUI(response.status);
    }
  });
}

function bindIpEvents() {
  const dom = FEATURE_DOM.ip;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('ip', action === 'start'
      ? {
        action,
        source: 'manual',
        includeExistingTargetsOnStart: false,
      }
      : { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    updateIpUI(response.status);
  });

  dom.includeExistingTargetsOnStartInput.addEventListener('change', async () => {
    const targetEnabled = dom.includeExistingTargetsOnStartInput.checked;
    const statusResponse = await sendFeatureMessage('ip', { action: 'getStatus' });
    if (!statusResponse?.success || !statusResponse.status) {
      await refreshAllStatuses();
      return;
    }

    const currentStatus = statusResponse.status;
    let response = null;

    if (targetEnabled) {
      if (currentStatus.isRunning) {
        if (currentStatus.includeExistingTargetsMode) {
          updateIpUI(currentStatus);
          return;
        }

        alert('일반 IP 차단이 이미 실행 중입니다. 먼저 정지한 뒤 도배기탭 삭제기를 켜세요.');
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('ip', {
        action: 'start',
        source: 'manual',
        includeExistingTargetsOnStart: true,
      });
    } else {
      if (!currentStatus.isRunning || !currentStatus.includeExistingTargetsMode) {
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('ip', { action: 'stop' });
    }

    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateIpUI(response.status);
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      releaseScanMaxPages: parseOptionalInt(dom.releaseScanMaxPagesInput.value, 40),
      avoidHour: String(Math.max(1, parseOptionalInt(dom.avoidHourInput.value, 6))),
      includeUidTargetsOnManualStart: dom.includeUidTargetsOnManualStartInput.checked,
    };

    const response = await sendFeatureMessage('ip', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.ip = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateIpUI(response.status);
  });

  dom.releaseBtn.addEventListener('click', async () => {
    const statusResponse = await sendFeatureMessage('ip', { action: 'getStatus' });
    if (!statusResponse?.success) {
      return;
    }

    if (statusResponse.status.isRunning) {
      alert('IP 차단을 먼저 정지한 뒤 해제를 실행하세요.');
      dom.toggleBtn.checked = true;
      return;
    }

    if (statusResponse.status.activeBanCount <= 0) {
      alert('해제할 활성 차단 내역이 없습니다.');
      return;
    }

    if (!confirm(`활성 차단 ${statusResponse.status.activeBanCount}건을 해제하시겠습니까?`)) {
      return;
    }

    dom.releaseBtn.disabled = true;
    dom.releaseBtn.textContent = '해제 중...';

    const releaseResponse = await sendFeatureMessage('ip', { action: 'releaseTrackedBans' });
    if (releaseResponse?.status) {
      updateIpUI(releaseResponse.status);
    }

    if (releaseResponse?.message) {
      alert(releaseResponse.message);
    }

    dom.releaseBtn.disabled = false;
    dom.releaseBtn.textContent = '내가 차단한 대상 해제';
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('IP 차단 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('ip', { action: 'resetStats' });
    if (response?.success) {
      updateIpUI(response.status);
    }
  });
}

function bindSemiPostEvents() {
  const dom = FEATURE_DOM.semiPost;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('semiPost', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.semiPost = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      minTotalActivityCount: Math.max(1, parseOptionalInt(dom.minTotalActivityCountInput.value, 20)),
      minPostRatioPercent: clampPercent(dom.minPostRatioPercentInput.value, 90, 1),
    };

    const response = await sendFeatureMessage('semiPost', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.semiPost = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('반고닉 분류 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('semiPost', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindMonitorEvents() {
  const dom = FEATURE_DOM.monitor;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('monitor', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.monitor = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 30000)),
      monitorPages: Math.max(1, parseOptionalInt(dom.pagesInput.value, 1)),
      attackNewPostThreshold: Math.max(1, parseOptionalInt(dom.attackNewPostThresholdInput.value, 50)),
      attackFluidRatioThreshold: clampPercent(dom.attackFluidRatioThresholdInput.value, 85, 1),
      attackConsecutiveCount: Math.max(1, parseOptionalInt(dom.attackConsecutiveCountInput.value, 2)),
      releaseNewPostThreshold: Math.max(0, parseOptionalInt(dom.releaseNewPostThresholdInput.value, 10)),
      releaseFluidRatioThreshold: clampPercent(dom.releaseFluidRatioThresholdInput.value, 40, 0),
      releaseConsecutiveCount: Math.max(1, parseOptionalInt(dom.releaseConsecutiveCountInput.value, 3)),
    };

    const response = await sendFeatureMessage('monitor', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.monitor = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('감시 자동화 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('monitor', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

async function refreshAllStatuses() {
  const response = await sendMessage({ action: 'getAllStatus' });
  if (!response?.success || !response.statuses) {
    return;
  }

  applyStatuses(response.statuses);
  updateSessionFallbackUI(response.sessionFallbackStatus);
}

function applyStatuses(statuses) {
  latestMonitorStatus = statuses.monitor || latestMonitorStatus;
  syncSharedConfigInputs(statuses);
  updateConceptMonitorUI(statuses.conceptMonitor);
  updateConceptPatrolUI(statuses.conceptPatrol);
  updateHanRefreshIpBanUI(statuses.hanRefreshIpBan);
  updateCommentMonitorUI(statuses.commentMonitor);
  updateMonitorUI(statuses.monitor);
  updateCommentUI(statuses.comment);
  updatePostUI(statuses.post);
  updateSemiPostUI(statuses.semiPost);
  updateIpUI(statuses.ip);
  applyAutomationLocks(statuses.monitor, statuses.commentMonitor);
}

function updateSessionFallbackUI(status) {
  if (!status) {
    return;
  }

  latestSessionFallbackStatus = status;

  const currentKeepaliveEnabled = sessionFallbackDirty
    ? SESSION_FALLBACK_DOM.keepaliveToggle.checked
    : status.config?.keepaliveEnabled === true;

  if (!sessionFallbackDirty) {
    syncConfigInput(SESSION_FALLBACK_DOM.keepaliveToggle, currentKeepaliveEnabled);
    syncConfigInput(SESSION_FALLBACK_DOM.primaryUserIdInput, status.config?.primaryUserId ?? '');
    syncConfigInput(SESSION_FALLBACK_DOM.primaryPasswordInput, status.config?.primaryPassword ?? '');
    syncConfigInput(SESSION_FALLBACK_DOM.backupUserIdInput, status.config?.backupUserId ?? '');
    syncConfigInput(SESSION_FALLBACK_DOM.backupPasswordInput, status.config?.backupPassword ?? '');
  }

  updateToggle(
    { toggleBtn: SESSION_FALLBACK_DOM.keepaliveToggle, toggleLabel: SESSION_FALLBACK_DOM.keepaliveLabel },
    currentKeepaliveEnabled,
  );
  SESSION_FALLBACK_DOM.activeAccountText.textContent = status.activeAccountLabel || '계정1';
  updateStatusText(
    SESSION_FALLBACK_DOM.automationStateText,
    buildSessionAutomationStateLabel(status),
    status.sessionAutomationInProgress ? 'status-warn' : 'status-on',
  );
  if (status.switchInProgress) {
    updateStatusText(
      SESSION_FALLBACK_DOM.switchStateText,
      status.switchTargetAccountLabel
        ? `🟠 ${status.switchTargetAccountLabel} 전환 중`
        : '🟠 전환 중',
      'status-warn',
    );
  } else {
    updateStatusText(SESSION_FALLBACK_DOM.switchStateText, '🟢 대기', 'status-on');
  }

  updateStatusText(
    SESSION_FALLBACK_DOM.loginHealthText,
    buildSessionFallbackLoginHealthLabel(status),
    getSessionFallbackLoginHealthClassName(status),
  );
  SESSION_FALLBACK_DOM.lastDeleteLimitAccountText.textContent = status.lastDeleteLimitAccountLabel || '-';
  SESSION_FALLBACK_DOM.metaText.textContent = buildSessionFallbackMetaText(status);
  const isAutomationBusy = Boolean(status.switchInProgress || status.sessionAutomationInProgress);
  setDisabled(SESSION_FALLBACK_DOM.primaryUserIdInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.primaryPasswordInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.backupUserIdInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.backupPasswordInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.keepaliveToggle, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.saveConfigBtn, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.testSwitchBtn, isAutomationBusy);
}

function hasPendingSessionFallbackCredentialEdits() {
  const statusConfig = latestSessionFallbackStatus?.config || {};
  return String(SESSION_FALLBACK_DOM.primaryUserIdInput.value.trim()) !== String(statusConfig.primaryUserId ?? '').trim()
    || String(SESSION_FALLBACK_DOM.primaryPasswordInput.value) !== String(statusConfig.primaryPassword ?? '')
    || String(SESSION_FALLBACK_DOM.backupUserIdInput.value.trim()) !== String(statusConfig.backupUserId ?? '').trim()
    || String(SESSION_FALLBACK_DOM.backupPasswordInput.value) !== String(statusConfig.backupPassword ?? '');
}

function revertSessionFallbackKeepaliveToggle() {
  const storedKeepaliveEnabled = latestSessionFallbackStatus?.config?.keepaliveEnabled === true;
  SESSION_FALLBACK_DOM.keepaliveToggle.checked = storedKeepaliveEnabled;
  updateToggle(
    { toggleBtn: SESSION_FALLBACK_DOM.keepaliveToggle, toggleLabel: SESSION_FALLBACK_DOM.keepaliveLabel },
    storedKeepaliveEnabled,
  );
  sessionFallbackDirty = hasPendingSessionFallbackCredentialEdits();
}

async function persistSessionFallbackConfig(options = {}) {
  const {
    failureMessage = '계정 전환 설정 저장에 실패했습니다.',
    suppressFlash = false,
    revertOnFailure = false,
  } = options;

  const config = {
    keepaliveEnabled: SESSION_FALLBACK_DOM.keepaliveToggle.checked,
    primaryUserId: SESSION_FALLBACK_DOM.primaryUserIdInput.value.trim(),
    primaryPassword: SESSION_FALLBACK_DOM.primaryPasswordInput.value,
    backupUserId: SESSION_FALLBACK_DOM.backupUserIdInput.value.trim(),
    backupPassword: SESSION_FALLBACK_DOM.backupPasswordInput.value,
  };

  const response = await sendMessage({ action: 'updateSessionFallbackConfig', config });
  if (!response?.success) {
    alert(response?.message || failureMessage);
    if (revertOnFailure && response?.sessionFallbackStatus) {
      sessionFallbackDirty = false;
      updateSessionFallbackUI(response.sessionFallbackStatus);
    } else if (revertOnFailure) {
      revertSessionFallbackKeepaliveToggle();
    }
    if (response?.statuses) {
      applyStatuses(response.statuses);
    }
    return false;
  }

  sessionFallbackDirty = false;
  if (!suppressFlash) {
    flashSaved(SESSION_FALLBACK_DOM.saveConfigBtn);
  }
  if (response?.sessionFallbackStatus) {
    updateSessionFallbackUI(response.sessionFallbackStatus);
  }
  if (response?.statuses) {
    applyStatuses(response.statuses);
  }
  return true;
}

function updateConceptMonitorUI(status) {
  if (!status) {
    return;
  }

  latestConceptMonitorStatus = status;
  const dom = FEATURE_DOM.conceptMonitor;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getConceptMonitorStatusLabel(status), getConceptMonitorStatusClassName(status));
  dom.modeText.textContent = status.config?.testMode === false ? '실행' : '테스트';
  updateConceptAutoCutStateText(dom.autoCutStateText, status.autoCutState || 'NORMAL');
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.currentPostNo.textContent = status.isRunning && status.currentPostNo > 0
    ? `#${status.currentPostNo}`
    : '-';
  dom.lastScanCount.textContent = `${status.lastScanCount ?? 0}개`;
  dom.lastCandidateCount.textContent = `${status.lastCandidateCount ?? 0}건`;
  dom.totalDetectedCount.textContent = `${status.totalDetectedCount ?? 0}건`;
  dom.totalReleasedCount.textContent = `${status.totalReleasedCount ?? 0}건`;
  dom.totalFailedCount.textContent = `${status.totalFailedCount ?? 0}건`;
  dom.totalUnclearCount.textContent = `${status.totalUnclearCount ?? 0}건`;
  dom.lastRecommendDelta.textContent = `${status.lastRecommendDelta ?? 0}개`;
  dom.lastComparedPostCount.textContent = `${status.lastComparedPostCount ?? 0}개`;
  dom.lastCutChangedAt.textContent = formatTimestamp(status.lastCutChangedAt);

  syncFeatureConfigInputs('conceptMonitor', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 30000],
    [dom.snapshotPostLimitInput, status.config?.snapshotPostLimit ?? 5],
    [dom.fluidRatioThresholdInput, status.config?.fluidRatioThresholdPercent ?? 90],
    [dom.testModeInput, status.config?.testMode === true],
    [dom.autoCutEnabledInput, status.config?.autoCutEnabled === true],
    [dom.autoCutPollIntervalMsInput, status.config?.autoCutPollIntervalMs ?? 30000],
    [dom.autoCutAttackThresholdInput, status.config?.autoCutAttackRecommendThreshold ?? 200],
    [dom.autoCutAttackConsecutiveCountInput, status.config?.autoCutAttackConsecutiveCount ?? 1],
    [dom.autoCutReleaseThresholdInput, status.config?.autoCutReleaseRecommendThreshold ?? 40],
    [dom.autoCutReleaseConsecutiveCountInput, status.config?.autoCutReleaseConsecutiveCount ?? 2],
  ]);
  updateToggle({ toggleBtn: dom.autoCutEnabledInput, toggleLabel: dom.autoCutEnabledLabel }, dom.autoCutEnabledInput.checked);
  updateLogList(dom.logList, status.logs);
}

function updateConceptPatrolUI(status) {
  if (!status) {
    return;
  }

  latestConceptPatrolStatus = status;
  const dom = FEATURE_DOM.conceptPatrol;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getConceptPatrolStatusLabel(status), getConceptPatrolStatusClassName(status));
  dom.modeText.textContent = status.config?.testMode === false ? '실행' : '테스트';
  updateConceptPatrolHoldStateText(dom.holdStateText, status.patrolHoldActive);
  dom.effectiveRecommendCutText.textContent = String(status.effectiveRecommendCut ?? 14);
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}P${status.currentPostNo > 0 ? ` / #${status.currentPostNo}` : ''}`
    : '-';
  dom.lastDetectedMaxPage.textContent = status.lastDetectedMaxPage > 0
    ? `${status.lastDetectedMaxPage}페이지`
    : '-';
  dom.lastWindowSize.textContent = `${status.lastWindowSize ?? 0}개`;
  dom.lastNewPostCount.textContent = `${status.lastNewPostCount ?? 0}건`;
  dom.lastCandidateCount.textContent = `${status.lastCandidateCount ?? 0}건`;
  dom.totalDetectedCount.textContent = `${status.totalDetectedCount ?? 0}건`;
  dom.totalReleasedCount.textContent = `${status.totalReleasedCount ?? 0}건`;
  dom.totalFailedCount.textContent = `${status.totalFailedCount ?? 0}건`;
  dom.totalUnclearCount.textContent = `${status.totalUnclearCount ?? 0}건`;
  dom.holdUntilText.textContent = formatTimestamp(status.patrolHoldUntilTs);
  dom.lastCutChangedAt.textContent = formatTimestamp(status.lastCutChangedAt);

  syncFeatureConfigInputs('conceptPatrol', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 30000],
    [dom.patrolPagesInput, status.config?.patrolPages ?? 5],
    [dom.pageRequestDelayInput, status.config?.pageRequestDelayMs ?? 500],
    [dom.fluidRatioThresholdInput, status.config?.fluidRatioThresholdPercent ?? 90],
    [dom.candidateThresholdInput, status.config?.patrolDefendingCandidateThreshold ?? 2],
    [dom.holdMsInput, status.config?.patrolDefendingHoldMs ?? 300000],
    [dom.testModeInput, status.config?.testMode === true],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateHanRefreshIpBanUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.hanRefreshIpBan;
  updateToggle(dom, status.isRunning);
  updateStatusText(
    dom.statusText,
    getHanRefreshIpBanStatusLabel(status),
    getHanRefreshIpBanStatusClassName(status),
  );
  dom.phaseText.textContent = status.phase || 'IDLE';
  dom.currentPage.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.detectedMaxPage.textContent = status.detectedMaxPage > 0
    ? `${status.detectedMaxPage}페이지`
    : '-';
  dom.currentCycleScannedRows.textContent = `${status.currentCycleScannedRows ?? 0}줄`;
  dom.currentCycleMatchedRows.textContent = `${status.currentCycleMatchedRows ?? 0}줄`;
  dom.currentCycleBanSuccessCount.textContent = `${status.currentCycleBanSuccessCount ?? 0}건`;
  dom.currentCycleBanFailureCount.textContent = `${status.currentCycleBanFailureCount ?? 0}건`;
  dom.lastRunAt.textContent = formatTimestamp(status.lastRunAt);
  dom.nextRunAt.textContent = formatTimestamp(status.nextRunAt);

  syncFeatureConfigInputs('hanRefreshIpBan', [
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.fallbackMaxPageInput, status.config?.fallbackMaxPage ?? 400],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateCommentMonitorUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.commentMonitor;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getCommentMonitorStatusLabel(status), getCommentMonitorStatusClassName(status));
  dom.phaseText.textContent = status.phase || 'SEEDING';
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.newCommentCount.textContent = `${status.lastMetrics?.newCommentCount ?? 0}개`;
  dom.verifiedDeletedCount.textContent = `${status.lastMetrics?.verifiedDeletedCount ?? 0}개`;
  dom.changedPostCount.textContent = `${status.lastMetrics?.changedPostCount ?? 0}개`;
  dom.attackHitCount.textContent = `${status.attackHitCount ?? 0}회`;
  dom.releaseHitCount.textContent = `${status.releaseHitCount ?? 0}회`;
  dom.totalAttackDetected.textContent = `${status.totalAttackDetected ?? 0}회`;
  dom.totalAttackReleased.textContent = `${status.totalAttackReleased ?? 0}회`;

  syncFeatureConfigInputs('commentMonitor', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 20000],
    [dom.pagesInput, status.config?.monitorPages ?? 2],
    [dom.attackNewCommentThresholdInput, status.config?.attackNewCommentThreshold ?? 30],
    [dom.attackChangedPostThresholdInput, status.config?.attackChangedPostThreshold ?? 20],
    [dom.attackAltNewCommentThresholdInput, status.config?.attackAltNewCommentThreshold ?? 50],
    [dom.attackAltChangedPostThresholdInput, status.config?.attackAltChangedPostThreshold ?? 9],
    [dom.attackConsecutiveCountInput, status.config?.attackConsecutiveCount ?? 2],
    [dom.releaseNewCommentThresholdInput, status.config?.releaseNewCommentThreshold ?? 30],
    [dom.releaseVerifiedDeleteThresholdInput, status.config?.releaseVerifiedDeleteThreshold ?? 10],
    [dom.releaseConsecutiveCountInput, status.config?.releaseConsecutiveCount ?? 3],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateCommentUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.comment;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, status.isRunning ? '🟢 실행 중' : '🔴 정지', status.isRunning ? 'status-on' : 'status-off');
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}P / #${status.currentPostNo}`
    : '-';
  dom.totalDeleted.textContent = `${status.totalDeleted}개`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;

  syncFeatureConfigInputs('comment', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 1],
    [dom.requestDelayInput, status.config?.requestDelay ?? 100],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.postConcurrencyInput, status.config?.postConcurrency ?? 50],
    [dom.banOnDeleteInput, status.config?.banOnDelete ?? true],
    [dom.avoidHourInput, status.config?.avoidHour ?? '1'],
  ]);
  dom.excludePureHangulInput.checked = Boolean(
    status.isRunning
    && status.currentSource === 'manual'
    && status.excludePureHangulMode,
  );
  updateLogList(dom.logList, status.logs);
}

function updatePostUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.post;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, status.isRunning ? '🟢 실행 중' : '🔴 정지', status.isRunning ? 'status-on' : 'status-off');
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.totalClassified.textContent = `${status.totalClassified}개`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;

  syncFeatureConfigInputs('post', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 1],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
  ]);
  dom.cjkModeToggleInput.checked = Boolean(
    status.isRunning
    && status.currentSource === 'manual'
    && status.currentAttackMode === 'cjk_narrow',
  );
  updateLogList(dom.logList, status.logs);
}

function updateIpUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.ip;
  updateToggle(dom, status.isRunning);

  if (status.isReleaseRunning) {
    updateStatusText(dom.statusText, '🟠 해제 중', 'status-warn');
  } else if (status.isRunning && status.runtimeDeleteEnabled === false) {
    updateStatusText(dom.statusText, '🟠 차단만 유지 중', 'status-warn');
  } else if (status.isRunning) {
    updateStatusText(dom.statusText, '🟢 차단 중', 'status-on');
  } else {
    updateStatusText(dom.statusText, '🔴 정지', 'status-off');
  }

  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.totalBanned.textContent = `${status.totalBanned}건`;
  dom.activeBanCount.textContent = `${status.activeBanCount}건`;
  dom.totalReleased.textContent = `${status.totalReleased}건`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;
  dom.releaseBtn.disabled = status.isRunning || status.isReleaseRunning || status.activeBanCount <= 0;
  dom.releaseBtn.textContent = status.isReleaseRunning ? '해제 중...' : '내가 차단한 대상 해제';
  dom.includeExistingTargetsOnStartInput.checked = Boolean(status.isRunning && status.includeExistingTargetsMode);

  syncFeatureConfigInputs('ip', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 5],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.releaseScanMaxPagesInput, status.config?.releaseScanMaxPages ?? 40],
    [dom.avoidHourInput, status.config?.avoidHour ?? '6'],
    [dom.includeUidTargetsOnManualStartInput, status.config?.includeUidTargetsOnManualStart === true],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateSemiPostUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.semiPost;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, status.isRunning ? '🟢 실행 중' : '🔴 정지', status.isRunning ? 'status-on' : 'status-off');
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.totalClassified.textContent = `${status.totalClassified}개`;
  dom.totalSuspiciousUid.textContent = `${status.totalSuspiciousUid}명`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;

  syncFeatureConfigInputs('semiPost', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 5],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.minTotalActivityCountInput, status.config?.minTotalActivityCount ?? 20],
    [dom.minPostRatioPercentInput, status.config?.minPostRatioPercent ?? 90],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateMonitorUI(status) {
  if (!status) {
    return;
  }

  latestMonitorStatus = status;
  const dom = FEATURE_DOM.monitor;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getMonitorStatusLabel(status), getMonitorStatusClassName(status));
  dom.phaseText.textContent = status.phase || 'SEEDING';
  dom.attackModeText.textContent = formatAttackModeLabel(status.attackMode);
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.newPostCount.textContent = `${status.lastMetrics?.newPostCount ?? 0}개`;
  dom.newFluidCount.textContent = `${status.lastMetrics?.newFluidCount ?? 0}개`;
  dom.fluidRatio.textContent = `${formatPercent(status.lastMetrics?.fluidRatio)}%`;
  dom.attackHitCount.textContent = `${status.attackHitCount ?? 0}회`;
  dom.releaseHitCount.textContent = `${status.releaseHitCount ?? 0}회`;
  dom.totalAttackDetected.textContent = `${status.totalAttackDetected ?? 0}회`;
  dom.totalAttackReleased.textContent = `${status.totalAttackReleased ?? 0}회`;

  syncFeatureConfigInputs('monitor', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 20000],
    [dom.pagesInput, status.config?.monitorPages ?? 2],
    [dom.attackNewPostThresholdInput, status.config?.attackNewPostThreshold ?? 15],
    [dom.attackFluidRatioThresholdInput, status.config?.attackFluidRatioThreshold ?? 88],
    [dom.attackConsecutiveCountInput, status.config?.attackConsecutiveCount ?? 2],
    [dom.releaseNewPostThresholdInput, status.config?.releaseNewPostThreshold ?? 10],
    [dom.releaseFluidRatioThresholdInput, status.config?.releaseFluidRatioThreshold ?? 30],
    [dom.releaseConsecutiveCountInput, status.config?.releaseConsecutiveCount ?? 3],
  ]);
  updateLogList(dom.logList, status.logs);
}

function applyAutomationLocks(monitorStatus, commentMonitorStatus) {
  const postIpLocked = Boolean(monitorStatus?.isRunning);
  const commentLocked = Boolean(commentMonitorStatus?.isRunning);
  const commentMonitorDom = FEATURE_DOM.commentMonitor;
  const commentDom = FEATURE_DOM.comment;
  const postDom = FEATURE_DOM.post;
  const semiPostDom = FEATURE_DOM.semiPost;
  const ipDom = FEATURE_DOM.ip;

  setDisabled(commentMonitorDom.resetBtn, commentLocked);
  setDisabled(commentDom.toggleBtn, commentLocked);
  setDisabled(commentDom.excludePureHangulInput, commentLocked);
  setDisabled(commentDom.saveConfigBtn, commentLocked);
  setDisabled(commentDom.resetBtn, commentLocked);
  setDisabled(postDom.toggleBtn, postIpLocked);
  setDisabled(postDom.cjkModeToggleInput, postIpLocked);
  setDisabled(postDom.saveConfigBtn, postIpLocked);
  setDisabled(postDom.resetBtn, postIpLocked);
  setDisabled(semiPostDom.toggleBtn, postIpLocked);
  setDisabled(semiPostDom.saveConfigBtn, postIpLocked);
  setDisabled(semiPostDom.resetBtn, postIpLocked);
  setDisabled(ipDom.toggleBtn, postIpLocked);
  setDisabled(ipDom.includeExistingTargetsOnStartInput, postIpLocked);
  setDisabled(ipDom.saveConfigBtn, postIpLocked);
  setDisabled(ipDom.resetBtn, postIpLocked);
  setDisabled(ipDom.releaseBtn, postIpLocked || ipDom.releaseBtn.disabled);

  getFeatureConfigInputs('comment').forEach((input) => setDisabled(input, commentLocked));
  getFeatureConfigInputs('post').forEach((input) => setDisabled(input, postIpLocked));
  getFeatureConfigInputs('semiPost').forEach((input) => setDisabled(input, postIpLocked));
  getFeatureConfigInputs('ip').forEach((input) => setDisabled(input, postIpLocked));
}

function updateToggle(dom, isRunning) {
  dom.toggleBtn.checked = Boolean(isRunning);
  dom.toggleLabel.textContent = isRunning ? 'ON' : 'OFF';
  dom.toggleLabel.className = `toggle-label ${isRunning ? 'on' : 'off'}`;
}

function updateStatusText(node, text, className) {
  node.textContent = text;
  node.className = `status-value ${className}`;
}

function updateLogList(logList, logs) {
  if (logs?.length > 0) {
    logList.innerHTML = logs
      .map((log) => `<div class="log-entry">${escapeHtml(log)}</div>`)
      .join('');
    return;
  }

  logList.innerHTML = '<div class="log-empty">로그가 없습니다.</div>';
}

function syncSharedConfigInputs(statuses) {
  if (sharedConfigDirty) {
    return;
  }

  const galleryId = statuses.comment?.config?.galleryId
    || statuses.hanRefreshIpBan?.config?.galleryId
    || statuses.conceptMonitor?.config?.galleryId
    || statuses.conceptPatrol?.config?.galleryId
    || statuses.commentMonitor?.config?.galleryId
    || statuses.post?.config?.galleryId
    || statuses.semiPost?.config?.galleryId
    || statuses.ip?.config?.galleryId
    || statuses.monitor?.config?.galleryId
    || 'thesingularity';
  const headtextId = statuses.post?.config?.headtextId
    || statuses.semiPost?.config?.headtextId
    || statuses.ip?.config?.headtextId
    || 130;

  syncConfigInput(sharedGalleryIdInput, galleryId);
  syncConfigInput(sharedHeadtextIdInput, headtextId);
}

function bindConfigDirtyTracking(feature) {
  getFeatureConfigInputs(feature).forEach((input) => {
    input.addEventListener('input', () => {
      DIRTY_FEATURES[feature] = true;
    });
  });
}

function syncFeatureConfigInputs(feature, pairs) {
  if (DIRTY_FEATURES[feature]) {
    return;
  }

  pairs.forEach(([input, value]) => syncConfigInput(input, value));
}

function getFeatureConfigInputs(feature) {
  const dom = FEATURE_DOM[feature];
  if (!dom) {
    return [];
  }

  if (feature === 'comment') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
      dom.postConcurrencyInput,
      dom.banOnDeleteInput,
      dom.avoidHourInput,
    ];
  }

  if (feature === 'conceptMonitor') {
    return [
      dom.pollIntervalMsInput,
      dom.snapshotPostLimitInput,
      dom.fluidRatioThresholdInput,
      dom.testModeInput,
      dom.autoCutEnabledInput,
      dom.autoCutPollIntervalMsInput,
      dom.autoCutAttackThresholdInput,
      dom.autoCutAttackConsecutiveCountInput,
      dom.autoCutReleaseThresholdInput,
      dom.autoCutReleaseConsecutiveCountInput,
    ];
  }

  if (feature === 'conceptPatrol') {
    return [
      dom.pollIntervalMsInput,
      dom.patrolPagesInput,
      dom.pageRequestDelayInput,
      dom.fluidRatioThresholdInput,
      dom.candidateThresholdInput,
      dom.holdMsInput,
      dom.testModeInput,
    ];
  }

  if (feature === 'hanRefreshIpBan') {
    return [
      dom.requestDelayInput,
      dom.fallbackMaxPageInput,
    ];
  }

  if (feature === 'commentMonitor') {
    return [
      dom.pollIntervalMsInput,
      dom.pagesInput,
      dom.attackNewCommentThresholdInput,
      dom.attackChangedPostThresholdInput,
      dom.attackAltNewCommentThresholdInput,
      dom.attackAltChangedPostThresholdInput,
      dom.attackConsecutiveCountInput,
      dom.releaseNewCommentThresholdInput,
      dom.releaseVerifiedDeleteThresholdInput,
      dom.releaseConsecutiveCountInput,
    ];
  }

  if (feature === 'post') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
    ];
  }

  if (feature === 'semiPost') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
      dom.minTotalActivityCountInput,
      dom.minPostRatioPercentInput,
    ];
  }

  if (feature === 'ip') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
      dom.releaseScanMaxPagesInput,
      dom.avoidHourInput,
      dom.includeUidTargetsOnManualStartInput,
    ];
  }

  if (feature === 'monitor') {
    return [
      dom.pollIntervalMsInput,
      dom.pagesInput,
      dom.attackNewPostThresholdInput,
      dom.attackFluidRatioThresholdInput,
      dom.attackConsecutiveCountInput,
      dom.releaseNewPostThresholdInput,
      dom.releaseFluidRatioThresholdInput,
      dom.releaseConsecutiveCountInput,
    ];
  }

  return [];
}

function setActiveTab(feature) {
  featureTabs.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === feature);
  });

  featurePanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.feature === feature);
  });
}

function sendFeatureMessage(feature, message) {
  return sendMessage({
    ...message,
    feature,
  });
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[DefenseSuite Popup] 메시지 전송 실패:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }

      resolve(response);
    });
  });
}

function flashSaved(button, successText = '✅ 저장됨') {
  const previousText = button.textContent;
  button.textContent = successText;
  setTimeout(() => {
    button.textContent = previousText;
  }, 1500);
}

function syncConfigInput(input, nextValue) {
  if (input.type === 'checkbox') {
    const nextChecked = Boolean(nextValue);
    if (input.checked !== nextChecked) {
      input.checked = nextChecked;
    }
    return;
  }

  if (document.activeElement === input) {
    return;
  }

  const normalizedValue = String(nextValue ?? '');
  if (input.value !== normalizedValue) {
    input.value = normalizedValue;
  }
}

function parseOptionalInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function formatAttackModeLabel(value) {
  return value === 'cjk_narrow' ? 'CJK_NARROW' : 'DEFAULT';
}

function clampPercent(value, fallback, min) {
  const parsed = parseOptionalInt(value, fallback);
  return Math.min(100, Math.max(min, parsed));
}

function buildSessionFallbackMetaText(status) {
  if (!status) {
    return '계정 설정을 저장하면 다음 삭제 한도 fallback부터 반영됩니다.';
  }

  const parts = [];

  if (status.lastSwitchAt) {
    parts.push(`마지막 전환: ${formatTimestamp(status.lastSwitchAt)}`);
  }

  if (status.loginHealth?.detail) {
    parts.push(`세션 상태: ${status.loginHealth.detail}`);
  }

  if (status.lastSwitchError) {
    parts.push(`최근 전환 상태: ${status.lastSwitchError}`);
  } else if (status.switchInProgress) {
    parts.push('현재 세션 전환이 진행 중입니다.');
  } else if (status.sessionAutomationInProgress) {
    parts.push('현재 로그인 세션 자동화가 진행 중입니다.');
  } else {
    parts.push('계정 설정을 저장하면 다음 삭제 한도 fallback부터 반영됩니다.');
  }

  return parts.join(' / ');
}

function buildSessionAutomationStateLabel(status) {
  if (status?.sessionAutomationInProgress) {
    const kind = String(status.sessionAutomationKind || '').trim();
    switch (kind) {
      case 'login_health':
        return '🟠 로그인 확인 중';
      case 'manual_switch':
        return '🟠 수동 전환 중';
      case 'delete_limit_switch':
        return '🟠 삭제 한도 전환 중';
      default:
        return '🟠 세션 자동화 진행 중';
    }
  }

  return status?.config?.keepaliveEnabled === true
    ? '🟢 대기'
    : '⚪ 비활성화';
}

function buildSessionFallbackLoginHealthLabel(status) {
  const loginHealth = status?.loginHealth || {};
  switch (loginHealth.status) {
    case 'healthy':
      return '🟢 login 연결 정상';
    case 'checking':
      return '🟡 확인 중';
    case 'retrying':
      return '🟡 자동 재로그인 중';
    case 'manual_attention_required':
    case 'wrong_account_or_no_manager':
    case 'credentials_missing':
      return '🔴 점검 필요';
    case 'disabled':
      return '⚪ 비활성화';
    default:
      return '🟡 확인 전';
  }
}

function getSessionFallbackLoginHealthClassName(status) {
  const loginHealth = status?.loginHealth || {};
  switch (loginHealth.status) {
    case 'healthy':
      return 'status-on';
    case 'disabled':
      return '';
    case 'checking':
    case 'retrying':
      return 'status-warn';
    default:
      return 'status-off';
  }
}

function setDisabled(node, disabled) {
  if (!node) {
    return;
  }

  node.disabled = Boolean(disabled);
}

function getMonitorStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (status.phase === 'ATTACKING') {
    return '🟢 공격 대응 중';
  }

  if (status.phase === 'RECOVERING') {
    return '🟠 자동 정리 중';
  }

  if (status.phase === 'SEEDING') {
    return '🟡 기준 수집 중';
  }

  return '🔵 감시 중';
}

function getMonitorStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (status.phase === 'ATTACKING') {
    return 'status-on';
  }

  if (status.phase === 'RECOVERING' || status.phase === 'SEEDING') {
    return 'status-warn';
  }

  return 'status-on';
}

function getConceptMonitorStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  return status.config?.testMode === false ? '🟠 실행 중' : '🟡 테스트 중';
}

function getConceptMonitorStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  return status.config?.testMode === false ? 'status-warn' : 'status-on';
}

function getConceptPatrolStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (Number(status.blockedUntilTs) > Date.now()) {
    return '🧊 쿨다운 중';
  }

  return status.config?.testMode === false ? '🟠 실행 중' : '🟡 테스트 중';
}

function getConceptPatrolStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (Number(status.blockedUntilTs) > Date.now()) {
    return 'status-warn';
  }

  return status.config?.testMode === false ? 'status-warn' : 'status-on';
}

function updateConceptPatrolHoldStateText(node, isActive) {
  const active = Boolean(isActive);
  node.textContent = active ? 'HOLD' : 'NORMAL';
  node.className = `status-value ${active ? 'status-warn' : 'status-on'}`;
}

function getHanRefreshIpBanStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (status.phase === 'WAITING') {
    return '🟡 대기 중';
  }

  return '🟢 실행 중';
}

function getHanRefreshIpBanStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (status.phase === 'WAITING') {
    return 'status-warn';
  }

  return 'status-on';
}

function updateConceptAutoCutStateText(node, state) {
  const normalizedState = state === 'DEFENDING' ? 'DEFENDING' : 'NORMAL';
  node.textContent = normalizedState;
  node.className = `status-value ${normalizedState === 'DEFENDING' ? 'status-warn' : 'status-on'}`;
}

function getCommentMonitorStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (status.phase === 'ATTACKING') {
    return '🟢 댓글 대응 중';
  }

  if (status.phase === 'RECOVERING') {
    return '🟠 자동 정리 중';
  }

  if (status.phase === 'SEEDING') {
    return '🟡 기준 수집 중';
  }

  return '🔵 감시 중';
}

function getCommentMonitorStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (status.phase === 'ATTACKING') {
    return 'status-on';
  }

  if (status.phase === 'RECOVERING' || status.phase === 'SEEDING') {
    return 'status-warn';
  }

  return 'status-on';
}

function formatPercent(value) {
  return Number(value || 0).toFixed(1);
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleTimeString('ko-KR', { hour12: false });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
