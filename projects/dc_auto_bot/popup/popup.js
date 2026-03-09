const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const statusText = document.getElementById('statusText');
const phaseText = document.getElementById('phaseText');
const lastPollAtText = document.getElementById('lastPollAtText');
const trustedUserCountText = document.getElementById('trustedUserCountText');
const totalAttemptedText = document.getElementById('totalAttemptedText');
const totalSucceededText = document.getElementById('totalSucceededText');
const totalFailedText = document.getElementById('totalFailedText');
const processedTargetCountText = document.getElementById('processedTargetCountText');
const galleryIdInput = document.getElementById('galleryIdInput');
const reportTargetInput = document.getElementById('reportTargetInput');
const pollIntervalInput = document.getElementById('pollIntervalInput');
const dailyLimitInput = document.getElementById('dailyLimitInput');
const googleOAuthClientIdInput = document.getElementById('googleOAuthClientIdInput');
const googleCloudProjectIdInput = document.getElementById('googleCloudProjectIdInput');
const geminiModelInput = document.getElementById('geminiModelInput');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const trustedUserIdInput = document.getElementById('trustedUserIdInput');
const trustedUserLabelInput = document.getElementById('trustedUserLabelInput');
const addTrustedUserBtn = document.getElementById('addTrustedUserBtn');
const trustedUserList = document.getElementById('trustedUserList');
const logList = document.getElementById('logList');
const resetBtn = document.getElementById('resetBtn');
const loginGoogleBtn = document.getElementById('loginGoogleBtn');
const logoutGoogleBtn = document.getElementById('logoutGoogleBtn');
const llmAuthStatus = document.getElementById('llmAuthStatus');
const llmAuthEmail = document.getElementById('llmAuthEmail');
const llmTestTargetInput = document.getElementById('llmTestTargetInput');
const llmTestReasonInput = document.getElementById('llmTestReasonInput');
const runLlmTestBtn = document.getElementById('runLlmTestBtn');
const llmLastTestAt = document.getElementById('llmLastTestAt');
const llmTestStatus = document.getElementById('llmTestStatus');
const llmTestResult = document.getElementById('llmTestResult');

let currentStatus = null;
let configDirty = false;

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await refreshStatus();
  setInterval(refreshStatus, 1000);
});

function bindEvents() {
  bindConfigDirtyHandlers();

  toggleBtn.addEventListener('change', async () => {
    const action = toggleBtn.checked ? 'start' : 'stop';
    const response = await sendMessage({ action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshStatus();
      return;
    }

    applyStatus(response.status);
  });

  saveConfigBtn.addEventListener('click', async () => {
    const config = {
      galleryId: galleryIdInput.value.trim(),
      reportTarget: reportTargetInput.value.trim(),
      pollIntervalMs: Math.max(1000, parseInt(pollIntervalInput.value || '60000', 10) || 60000),
      dailyLimitPerUser: Math.max(1, parseInt(dailyLimitInput.value || '2', 10) || 2),
      googleOAuthClientId: googleOAuthClientIdInput.value.trim(),
      googleCloudProjectId: googleCloudProjectIdInput.value.trim(),
      geminiModel: geminiModelInput.value.trim(),
    };

    if (!config.galleryId) {
      alert('갤러리 ID를 입력하세요.');
      galleryIdInput.focus();
      return;
    }

    if (!config.reportTarget) {
      alert('신문고 링크 또는 게시물 번호를 입력하세요.');
      reportTargetInput.focus();
      return;
    }

    const response = await sendMessage({ action: 'updateConfig', config });
    if (!response?.success) {
      alert(response?.message || '설정 저장에 실패했습니다.');
      await refreshStatus();
      return;
    }

    configDirty = false;
    flashSaved(saveConfigBtn);
    applyStatus(response.status);
  });

  addTrustedUserBtn.addEventListener('click', async () => {
    const userId = trustedUserIdInput.value.trim();
    const label = trustedUserLabelInput.value.trim();

    if (!userId) {
      alert('user_id를 입력하세요.');
      trustedUserIdInput.focus();
      return;
    }

    if (!label) {
      alert('label을 입력하세요.');
      trustedUserLabelInput.focus();
      return;
    }

    if (label.length > 20) {
      alert('label은 20자 이하로 입력하세요.');
      trustedUserLabelInput.focus();
      return;
    }

    const response = await sendMessage({ action: 'addTrustedUser', userId, label });
    if (!response?.success) {
      alert(response?.message || '신뢰 사용자 등록에 실패했습니다.');
      await refreshStatus();
      return;
    }

    trustedUserIdInput.value = '';
    trustedUserLabelInput.value = '';
    applyStatus(response.status);
  });

  loginGoogleBtn.addEventListener('click', async () => {
    const response = await sendMessage({ action: 'loginGoogle' });
    if (!response?.success) {
      alert(response?.message || 'Google 로그인에 실패했습니다.');
      await refreshStatus();
      return;
    }
    applyStatus(response.status);
  });

  logoutGoogleBtn.addEventListener('click', async () => {
    const response = await sendMessage({ action: 'logoutGoogle' });
    if (!response?.success) {
      alert(response?.message || '로그아웃에 실패했습니다.');
      await refreshStatus();
      return;
    }
    applyStatus(response.status);
  });

  runLlmTestBtn.addEventListener('click', async () => {
    const targetUrl = llmTestTargetInput.value.trim();
    const reportReason = llmTestReasonInput.value.trim();
    if (!targetUrl) {
      alert('테스트 링크를 입력하세요.');
      llmTestTargetInput.focus();
      return;
    }

    const response = await sendMessage({ action: 'runLlmTest', targetUrl, reportReason });
    if (!response?.success && !response?.status) {
      alert(response?.message || 'LLM 테스트 실행에 실패했습니다.');
      await refreshStatus();
      return;
    }

    applyStatus(response.status || currentStatus);
    if (!response?.success && response?.message) {
      alert(response.message);
    }
  });

  resetBtn.addEventListener('click', async () => {
    const response = await sendMessage({ action: 'resetStats' });
    if (!response?.success) {
      alert(response?.message || '통계 초기화에 실패했습니다.');
      await refreshStatus();
      return;
    }

    applyStatus(response.status);
  });
}

async function refreshStatus() {
  const response = await sendMessage({ action: 'getStatus' });
  if (!response?.success) {
    return;
  }

  applyStatus(response.status);
}

function applyStatus(status) {
  if (!status) {
    return;
  }

  currentStatus = status;
  const config = status.config || {};
  const llm = status.llm || {};

  toggleBtn.checked = Boolean(status.isRunning);
  toggleLabel.textContent = status.isRunning ? 'ON' : 'OFF';
  statusText.textContent = status.isRunning ? '🟢 실행 중' : '🔴 정지';
  statusText.classList.toggle('status-off', !status.isRunning);
  phaseText.textContent = status.phase || 'IDLE';
  lastPollAtText.textContent = formatTimestamp(status.lastPollAt);
  trustedUserCountText.textContent = `${status.trustedUserCount || 0}명`;
  totalAttemptedText.textContent = `${status.totalAttemptedCommands || 0}회`;
  totalSucceededText.textContent = `${status.totalSucceededCommands || 0}회`;
  totalFailedText.textContent = `${status.totalFailedCommands || 0}회`;
  processedTargetCountText.textContent = `${status.processedTargetCount || 0}건`;

  if (!configDirty) {
    galleryIdInput.value = config.galleryId || '';
    reportTargetInput.value = config.reportTarget || '';
    pollIntervalInput.value = String(config.pollIntervalMs || 60000);
    dailyLimitInput.value = String(config.dailyLimitPerUser || 2);
    googleOAuthClientIdInput.value = llm.config?.googleOAuthClientId || '';
    googleCloudProjectIdInput.value = llm.config?.googleCloudProjectId || '';
    geminiModelInput.value = llm.config?.geminiModel || 'gemini-2.5-flash';
  }

  llmAuthStatus.textContent = llm.isAuthenticated ? '🟢 로그인됨' : '⚪ 로그인 안 됨';
  llmAuthEmail.textContent = llm.accountEmail || '-';
  llmLastTestAt.textContent = formatTimestamp(llm.lastTestAt);
  llmTestStatus.textContent = llm.isTesting ? '실행 중' : (llm.lastTestResult ? (llm.lastTestResult.success ? '완료' : '실패') : '대기');
  llmTestResult.textContent = llm.lastTestResult ? JSON.stringify(llm.lastTestResult, null, 2) : '결과가 없습니다.';

  renderTrustedUsers(config.trustedUsers || []);
  renderLogs(status.logs || []);
  applyRunningLocks(Boolean(status.isRunning), Boolean(llm.isTesting));
}

function renderTrustedUsers(users) {
  if (!users.length) {
    trustedUserList.innerHTML = '<div class="list-empty">등록된 신뢰 사용자가 없습니다.</div>';
    return;
  }

  trustedUserList.innerHTML = '';
  for (const user of users) {
    const item = document.createElement('div');
    item.className = 'trusted-user-item';

    const meta = document.createElement('div');
    meta.className = 'trusted-user-meta';

    const label = document.createElement('span');
    label.className = 'trusted-user-label';
    label.textContent = user.label;

    const userId = document.createElement('span');
    userId.className = 'trusted-user-id';
    userId.textContent = user.userId;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '삭제';
    removeBtn.addEventListener('click', async () => {
      const response = await sendMessage({ action: 'removeTrustedUser', userId: user.userId });
      if (!response?.success) {
        alert(response?.message || '신뢰 사용자 삭제에 실패했습니다.');
        await refreshStatus();
        return;
      }
      applyStatus(response.status);
    });

    meta.appendChild(label);
    meta.appendChild(userId);
    item.appendChild(meta);
    item.appendChild(removeBtn);
    trustedUserList.appendChild(item);
  }
}

function renderLogs(logs) {
  if (!logs.length) {
    logList.innerHTML = '<div class="log-empty">로그가 없습니다.</div>';
    return;
  }

  logList.innerHTML = '';
  for (const entry of logs) {
    const item = document.createElement('div');
    item.className = 'log-entry';
    item.textContent = entry;
    logList.appendChild(item);
  }
}

function applyRunningLocks(isRunning, isTesting) {
  resetBtn.disabled = isRunning || isTesting;
  saveConfigBtn.disabled = isRunning || isTesting;
  runLlmTestBtn.disabled = isTesting;
  loginGoogleBtn.disabled = isTesting;
  logoutGoogleBtn.disabled = isTesting;
}

function bindConfigDirtyHandlers() {
  const inputs = [
    galleryIdInput,
    reportTargetInput,
    pollIntervalInput,
    dailyLimitInput,
    googleOAuthClientIdInput,
    googleCloudProjectIdInput,
    geminiModelInput,
  ];
  for (const input of inputs) {
    input.addEventListener('input', () => {
      configDirty = true;
    });
  }
}

function flashSaved(button) {
  const originalText = button.textContent;
  button.textContent = '저장됨';
  button.disabled = true;
  setTimeout(() => {
    button.textContent = originalText;
    button.disabled = Boolean(currentStatus?.isRunning) || Boolean(currentStatus?.llm?.isTesting);
  }, 1200);
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }

  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}
