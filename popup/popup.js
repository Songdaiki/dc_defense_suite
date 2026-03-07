const featureTabs = document.querySelectorAll('.tab-button');
const featurePanels = document.querySelectorAll('.panel');
const sharedGalleryIdInput = document.getElementById('sharedGalleryId');
const sharedHeadtextIdInput = document.getElementById('sharedHeadtextId');
const sharedSaveConfigBtn = document.getElementById('sharedSaveConfigBtn');
const DIRTY_FEATURES = {
  commentMonitor: false,
  comment: false,
  post: false,
  semiPost: false,
  ip: false,
  monitor: false,
};
let sharedConfigDirty = false;
let latestMonitorStatus = null;

const FEATURE_DOM = {
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
    saveConfigBtn: document.getElementById('ipSaveConfigBtn'),
    releaseBtn: document.getElementById('ipReleaseBtn'),
    resetBtn: document.getElementById('ipResetBtn'),
  },
  monitor: {
    toggleBtn: document.getElementById('monitorToggleBtn'),
    toggleLabel: document.getElementById('monitorToggleLabel'),
    statusText: document.getElementById('monitorStatusText'),
    phaseText: document.getElementById('monitorPhaseText'),
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
  bindConfigDirtyTracking('commentMonitor');
  bindConfigDirtyTracking('comment');
  bindConfigDirtyTracking('post');
  bindConfigDirtyTracking('semiPost');
  bindConfigDirtyTracking('ip');
  bindConfigDirtyTracking('monitor');
  bindCommentMonitorEvents();
  bindCommentEvents();
  bindPostEvents();
  bindSemiPostEvents();
  bindIpEvents();
  bindMonitorEvents();
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
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 30000)),
      monitorPages: Math.max(1, parseOptionalInt(dom.pagesInput.value, 2)),
      attackNewCommentThreshold: Math.max(1, parseOptionalInt(dom.attackNewCommentThresholdInput.value, 250)),
      attackConsecutiveCount: Math.max(1, parseOptionalInt(dom.attackConsecutiveCountInput.value, 2)),
      releaseNewCommentThreshold: Math.max(0, parseOptionalInt(dom.releaseNewCommentThresholdInput.value, 50)),
      releaseVerifiedDeleteThreshold: Math.max(0, parseOptionalInt(dom.releaseVerifiedDeleteThresholdInput.value, 50)),
      releaseConsecutiveCount: Math.max(1, parseOptionalInt(dom.releaseConsecutiveCountInput.value, 2)),
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
    const response = await sendFeatureMessage('comment', { action });
    if (response?.success) {
      updateCommentUI(response.status);
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 100),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      postConcurrency: parseOptionalInt(dom.postConcurrencyInput.value, 50),
    };

    const response = await sendFeatureMessage('comment', { action: 'updateConfig', config });
    if (response?.success) {
      DIRTY_FEATURES.comment = false;
      flashSaved(dom.saveConfigBtn);
      updateCommentUI(response.status);
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('댓글 방어 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('comment', { action: 'resetStats' });
    if (response?.success) {
      updateCommentUI(response.status);
    }
  });
}

function bindPostEvents() {
  const dom = FEATURE_DOM.post;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('post', { action });
    if (response?.success) {
      updatePostUI(response.status);
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
    };

    const response = await sendFeatureMessage('post', { action: 'updateConfig', config });
    if (response?.success) {
      DIRTY_FEATURES.post = false;
      flashSaved(dom.saveConfigBtn);
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
    const response = await sendFeatureMessage('ip', { action });
    if (response?.success) {
      updateIpUI(response.status);
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      releaseScanMaxPages: parseOptionalInt(dom.releaseScanMaxPagesInput.value, 40),
    };

    const response = await sendFeatureMessage('ip', { action: 'updateConfig', config });
    if (response?.success) {
      DIRTY_FEATURES.ip = false;
      flashSaved(dom.saveConfigBtn);
      updateIpUI(response.status);
    }
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
}

function applyStatuses(statuses) {
  latestMonitorStatus = statuses.monitor || latestMonitorStatus;
  syncSharedConfigInputs(statuses);
  updateCommentMonitorUI(statuses.commentMonitor);
  updateMonitorUI(statuses.monitor);
  updateCommentUI(statuses.comment);
  updatePostUI(statuses.post);
  updateSemiPostUI(statuses.semiPost);
  updateIpUI(statuses.ip);
  applyAutomationLocks(statuses.monitor, statuses.commentMonitor);
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
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 30000],
    [dom.pagesInput, status.config?.monitorPages ?? 2],
    [dom.attackNewCommentThresholdInput, status.config?.attackNewCommentThreshold ?? 250],
    [dom.attackConsecutiveCountInput, status.config?.attackConsecutiveCount ?? 2],
    [dom.releaseNewCommentThresholdInput, status.config?.releaseNewCommentThreshold ?? 50],
    [dom.releaseVerifiedDeleteThresholdInput, status.config?.releaseVerifiedDeleteThreshold ?? 50],
    [dom.releaseConsecutiveCountInput, status.config?.releaseConsecutiveCount ?? 2],
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
    [dom.maxPageInput, status.config?.maxPage ?? 5],
    [dom.requestDelayInput, status.config?.requestDelay ?? 100],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.postConcurrencyInput, status.config?.postConcurrency ?? 50],
  ]);
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
    [dom.maxPageInput, status.config?.maxPage ?? 5],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
  ]);
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

  syncFeatureConfigInputs('ip', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 5],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.releaseScanMaxPagesInput, status.config?.releaseScanMaxPages ?? 40],
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
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.newPostCount.textContent = `${status.lastMetrics?.newPostCount ?? 0}개`;
  dom.newFluidCount.textContent = `${status.lastMetrics?.newFluidCount ?? 0}개`;
  dom.fluidRatio.textContent = `${formatPercent(status.lastMetrics?.fluidRatio)}%`;
  dom.attackHitCount.textContent = `${status.attackHitCount ?? 0}회`;
  dom.releaseHitCount.textContent = `${status.releaseHitCount ?? 0}회`;
  dom.totalAttackDetected.textContent = `${status.totalAttackDetected ?? 0}회`;
  dom.totalAttackReleased.textContent = `${status.totalAttackReleased ?? 0}회`;

  syncFeatureConfigInputs('monitor', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 30000],
    [dom.pagesInput, status.config?.monitorPages ?? 1],
    [dom.attackNewPostThresholdInput, status.config?.attackNewPostThreshold ?? 50],
    [dom.attackFluidRatioThresholdInput, status.config?.attackFluidRatioThreshold ?? 85],
    [dom.attackConsecutiveCountInput, status.config?.attackConsecutiveCount ?? 2],
    [dom.releaseNewPostThresholdInput, status.config?.releaseNewPostThreshold ?? 10],
    [dom.releaseFluidRatioThresholdInput, status.config?.releaseFluidRatioThreshold ?? 40],
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
  setDisabled(commentDom.saveConfigBtn, commentLocked);
  setDisabled(commentDom.resetBtn, commentLocked);
  setDisabled(postDom.toggleBtn, postIpLocked);
  setDisabled(postDom.saveConfigBtn, postIpLocked);
  setDisabled(postDom.resetBtn, postIpLocked);
  setDisabled(semiPostDom.toggleBtn, postIpLocked);
  setDisabled(semiPostDom.saveConfigBtn, postIpLocked);
  setDisabled(semiPostDom.resetBtn, postIpLocked);
  setDisabled(ipDom.toggleBtn, postIpLocked);
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
    ];
  }

  if (feature === 'commentMonitor') {
    return [
      dom.pollIntervalMsInput,
      dom.pagesInput,
      dom.attackNewCommentThresholdInput,
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

function flashSaved(button) {
  const previousText = button.textContent;
  button.textContent = '✅ 저장됨';
  setTimeout(() => {
    button.textContent = previousText;
  }, 1500);
}

function syncConfigInput(input, nextValue) {
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

function clampPercent(value, fallback, min) {
  const parsed = parseOptionalInt(value, fallback);
  return Math.min(100, Math.max(min, parsed));
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
