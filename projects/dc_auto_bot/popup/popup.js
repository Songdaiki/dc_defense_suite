const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const loginAutomationToggle = document.getElementById('loginAutomationToggle');
const loginAutomationLabel = document.getElementById('loginAutomationLabel');
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
const cliHelperEndpointInput = document.getElementById('cliHelperEndpointInput');
const cliHelperTimeoutInput = document.getElementById('cliHelperTimeoutInput');
const llmConfidenceThresholdInput = document.getElementById('llmConfidenceThresholdInput');
const dcLoginUserIdInput = document.getElementById('dcLoginUserIdInput');
const dcLoginPasswordInput = document.getElementById('dcLoginPasswordInput');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const saveLoginAutomationBtn = document.getElementById('saveLoginAutomationBtn');
const trustedUserIdInput = document.getElementById('trustedUserIdInput');
const trustedUserLabelInput = document.getElementById('trustedUserLabelInput');
const addTrustedUserBtn = document.getElementById('addTrustedUserBtn');
const trustedUserList = document.getElementById('trustedUserList');
const logList = document.getElementById('logList');
const resetBtn = document.getElementById('resetBtn');
const llmAuthStatus = document.getElementById('llmAuthStatus');
const llmAuthEmail = document.getElementById('llmAuthEmail');
const loginAuthStatus = document.getElementById('loginAuthStatus');
const loginAuthDetail = document.getElementById('loginAuthDetail');
const llmTestTargetInput = document.getElementById('llmTestTargetInput');
const llmTestReasonInput = document.getElementById('llmTestReasonInput');
const runLlmTestBtn = document.getElementById('runLlmTestBtn');
const llmLastTestAt = document.getElementById('llmLastTestAt');
const llmTestStatus = document.getElementById('llmTestStatus');
const llmTestResult = document.getElementById('llmTestResult');

let currentStatus = null;
let configDirty = false;
let loginConfigDirty = false;
const LOGIN_BROKER_MESSAGE = '특궁 세션 브로커에서 로그인 세션을 관리합니다.';

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

    loginConfigDirty = false;
    applyStatus(response.status);
  });

  loginAutomationToggle.addEventListener('change', async () => {
    const response = await sendMessage({
      action: 'updateLoginAutomation',
      config: buildLoginAutomationConfig(loginAutomationToggle.checked),
    });
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
      cliHelperEndpoint: cliHelperEndpointInput.value.trim(),
      cliHelperTimeoutMs: Math.max(1000, parseInt(cliHelperTimeoutInput.value || '240000', 10) || 240000),
      llmConfidenceThreshold: Math.min(1, Math.max(0, Number(llmConfidenceThresholdInput.value || '0.85'))),
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

  saveLoginAutomationBtn.addEventListener('click', async () => {
    const response = await sendMessage({
      action: 'updateLoginAutomation',
      config: buildLoginAutomationConfig(loginAutomationToggle.checked),
    });
    if (!response?.success) {
      alert(response?.message || '로그인 자동화 저장에 실패했습니다.');
      await refreshStatus();
      return;
    }

    loginConfigDirty = false;
    flashSaved(saveLoginAutomationBtn);
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
  const helperHealth = llm.helperHealth || {};
  const login = status.login || {};
  const loginHealth = login.health || {};

  toggleBtn.checked = Boolean(status.isRunning);
  toggleLabel.textContent = status.isRunning ? 'ON' : 'OFF';
  loginAutomationToggle.checked = false;
  loginAutomationLabel.textContent = login.managedByBroker ? '특궁' : (login.enabled === true ? 'ON' : 'OFF');
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
    cliHelperEndpointInput.value = llm.config?.cliHelperEndpoint || '';
    cliHelperTimeoutInput.value = String(llm.config?.cliHelperTimeoutMs || 240000);
    llmConfidenceThresholdInput.value = String(
      Number.isFinite(Number(llm.config?.llmConfidenceThreshold))
        ? Number(llm.config.llmConfidenceThreshold)
        : 0.85,
    );
  }

  if (!loginConfigDirty) {
    dcLoginUserIdInput.value = '';
    dcLoginPasswordInput.value = '';
  }

  llmAuthStatus.textContent = formatHelperHealthStatus(helperHealth, llm.config?.cliHelperEndpoint);
  llmAuthEmail.textContent = formatHelperHealthDetail(helperHealth, llm.config?.cliHelperEndpoint);
  loginAuthStatus.textContent = formatLoginHealthStatus(loginHealth, login.enabled, login.credentialsConfigured, login.managedByBroker);
  loginAuthDetail.textContent = formatLoginHealthDetail(loginHealth, login.enabled, login.credentialsConfigured, login.managedByBroker);
  llmLastTestAt.textContent = formatTimestamp(llm.lastTestAt);
  llmTestStatus.textContent = llm.isTesting ? '실행 중' : (llm.lastTestResult ? (llm.lastTestResult.success ? '완료' : '실패') : '대기');
  llmTestResult.textContent = llm.lastTestResult ? JSON.stringify(llm.lastTestResult, null, 2) : '결과가 없습니다.';

  renderTrustedUsers(config.trustedUsers || []);
  renderLogs(status.logs || []);
  applyRunningLocks(Boolean(status.isRunning), Boolean(llm.isTesting));
  applyLoginOwnershipLocks(Boolean(login.managedByBroker));
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
}

function applyLoginOwnershipLocks(isManagedByBroker) {
  loginAutomationToggle.disabled = isManagedByBroker;
  dcLoginUserIdInput.disabled = isManagedByBroker;
  dcLoginPasswordInput.disabled = isManagedByBroker;
  saveLoginAutomationBtn.disabled = isManagedByBroker;
  if (isManagedByBroker) {
    saveLoginAutomationBtn.textContent = '특궁에서 관리';
  }
}

function bindConfigDirtyHandlers() {
  const inputs = [
    galleryIdInput,
    reportTargetInput,
    pollIntervalInput,
    dailyLimitInput,
    cliHelperEndpointInput,
    cliHelperTimeoutInput,
    llmConfidenceThresholdInput,
  ];
  for (const input of inputs) {
    input.addEventListener('input', () => {
      configDirty = true;
    });
  }

  for (const input of [dcLoginUserIdInput, dcLoginPasswordInput]) {
    input.addEventListener('input', () => {
      loginConfigDirty = true;
    });
  }
}

function flashSaved(button) {
  const originalText = button.textContent;
  button.textContent = '저장됨';
  button.disabled = true;
  setTimeout(() => {
    button.textContent = originalText;
    if (button === saveLoginAutomationBtn) {
      button.disabled = false;
      return;
    }

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

function formatHelperHealthStatus(helperHealth, endpoint) {
  if (!endpoint) {
    return '⚪ localhost helper 미설정';
  }

  switch (helperHealth.status) {
    case 'healthy':
      return '🟢 helper 실행 중';
    case 'misconfigured':
      return '⚪ helper 설정 오류';
    case 'invalid_response':
      return '🟠 helper 응답 이상';
    case 'gemini_unavailable':
      return '🟠 Gemini CLI 확인 필요';
    case 'dependency_error':
      return '🟠 helper 의존성 오류';
    case 'unreachable':
      return '🔴 helper 연결 실패';
    default:
      return '🟡 helper 상태 확인 중';
  }
}

function formatHelperHealthDetail(helperHealth, endpoint) {
  if (!endpoint) {
    return '-';
  }

  if (helperHealth.status === 'healthy') {
    return '';
  }

  return helperHealth.message || '';
}

function formatLoginHealthStatus(loginHealth, enabled, credentialsConfigured, managedByBroker) {
  if (managedByBroker) {
    return '🟢 특궁 broker 관리 중';
  }

  if (!enabled) {
    return '⚪ login 자동화 비활성화';
  }

  if (!credentialsConfigured) {
    return '⚪ login 계정 미설정';
  }

  switch (loginHealth.status) {
    case 'healthy':
      return '🟢 login 연결 정상';
    case 'checking':
      return '🟡 login 상태 확인 중';
    case 'retrying':
      return '🟡 login 자동 재로그인 중';
    case 'disabled':
      return '⚪ login 자동화 비활성화';
    default:
      return '🔴 login 연결실패';
  }
}

function formatLoginHealthDetail(loginHealth, enabled, credentialsConfigured, managedByBroker) {
  if (managedByBroker) {
    return LOGIN_BROKER_MESSAGE;
  }

  if (!enabled) {
    return '자동화 OFF';
  }

  if (!credentialsConfigured) {
    return '디시 아이디/비밀번호를 입력하세요.';
  }

  const detail = String(loginHealth.detail || '').trim();
  if (detail) {
    return detail;
  }

  return String(loginHealth.message || '').trim() || '-';
}

function buildLoginAutomationConfig(enabled) {
  return {
    loginAutomationEnabled: enabled === true,
    dcLoginUserId: dcLoginUserIdInput.value.trim(),
    dcLoginPassword: dcLoginPasswordInput.value,
  };
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}
