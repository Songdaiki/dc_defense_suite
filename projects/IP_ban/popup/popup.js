const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const statusText = document.getElementById('statusText');
const currentPosition = document.getElementById('currentPosition');
const totalBanned = document.getElementById('totalBanned');
const activeBanCount = document.getElementById('activeBanCount');
const totalReleased = document.getElementById('totalReleased');
const cycleCount = document.getElementById('cycleCount');
const logList = document.getElementById('logList');
const minPageInput = document.getElementById('minPage');
const maxPageInput = document.getElementById('maxPage');
const requestDelayInput = document.getElementById('requestDelay');
const cycleDelayInput = document.getElementById('cycleDelay');
const releaseScanMaxPagesInput = document.getElementById('releaseScanMaxPages');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const releaseBtn = document.getElementById('releaseBtn');
const resetBtn = document.getElementById('resetBtn');

document.addEventListener('DOMContentLoaded', async () => {
  await refreshStatus();
  setInterval(refreshStatus, 1000);
});

toggleBtn.addEventListener('change', async () => {
  const action = toggleBtn.checked ? 'start' : 'stop';
  const response = await sendMessage({ action });
  if (response?.success) {
    updateUI(response.status);
  }
});

saveConfigBtn.addEventListener('click', async () => {
  const config = {
    minPage: parseOptionalInt(minPageInput.value, 1),
    maxPage: parseOptionalInt(maxPageInput.value, 5),
    requestDelay: parseOptionalInt(requestDelayInput.value, 500),
    cycleDelay: parseOptionalInt(cycleDelayInput.value, 5000),
    releaseScanMaxPages: parseOptionalInt(releaseScanMaxPagesInput.value, 20),
  };

  const response = await sendMessage({ action: 'updateConfig', config });
  if (response?.success) {
    saveConfigBtn.textContent = '✅ 저장됨';
    setTimeout(() => {
      saveConfigBtn.textContent = '설정 저장';
    }, 1500);
  }
});

releaseBtn.addEventListener('click', async () => {
  const response = await sendMessage({ action: 'getStatus' });
  if (!response?.success) {
    return;
  }

  if (response.status.isRunning) {
    alert('자동 차단을 먼저 정지한 뒤 해제를 실행하세요.');
    toggleBtn.checked = true;
    return;
  }

  if (response.status.activeBanCount <= 0) {
    alert('해제할 활성 차단 내역이 없습니다.');
    return;
  }

  if (!confirm(`활성 차단 ${response.status.activeBanCount}건을 해제하시겠습니까?`)) {
    return;
  }

  releaseBtn.disabled = true;
  releaseBtn.textContent = '해제 중...';

  const releaseResponse = await sendMessage({ action: 'releaseTrackedBans' });
  if (releaseResponse?.status) {
    updateUI(releaseResponse.status);
  }

  if (releaseResponse?.success) {
    if (releaseResponse?.message) {
      alert(releaseResponse.message);
    }
  } else if (releaseResponse?.message) {
    alert(releaseResponse.message);
  }

  releaseBtn.disabled = false;
  releaseBtn.textContent = '내가 차단한 대상 해제';
});

resetBtn.addEventListener('click', async () => {
  if (!confirm('통계와 로그를 초기화하시겠습니까?')) {
    return;
  }

  const response = await sendMessage({ action: 'resetStats' });
  if (response?.success) {
    updateUI(response.status);
  }
});

async function refreshStatus() {
  const response = await sendMessage({ action: 'getStatus' });
  if (response?.success) {
    updateUI(response.status);
  }
}

function updateUI(status) {
  toggleBtn.checked = status.isRunning;
  toggleLabel.textContent = status.isRunning ? 'ON' : 'OFF';
  toggleLabel.className = `toggle-label ${status.isRunning ? 'on' : 'off'}`;

  if (status.isReleaseRunning) {
    statusText.textContent = '🟠 해제 중';
    statusText.className = 'status-value status-warn';
  } else if (status.isRunning) {
    statusText.textContent = '🟢 차단 중';
    statusText.className = 'status-value status-on';
  } else {
    statusText.textContent = '🔴 정지';
    statusText.className = 'status-value status-off';
  }

  currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';

  totalBanned.textContent = `${status.totalBanned}건`;
  activeBanCount.textContent = `${status.activeBanCount}건`;
  totalReleased.textContent = `${status.totalReleased}건`;
  cycleCount.textContent = `${status.cycleCount}회`;

  releaseBtn.disabled = status.isRunning || status.isReleaseRunning || status.activeBanCount <= 0;
  if (status.isReleaseRunning) {
    releaseBtn.textContent = '해제 중...';
  } else {
    releaseBtn.textContent = '내가 차단한 대상 해제';
  }

  if (status.config) {
    syncConfigInput(minPageInput, status.config.minPage ?? 1);
    syncConfigInput(maxPageInput, status.config.maxPage ?? 5);
    syncConfigInput(requestDelayInput, status.config.requestDelay ?? 500);
    syncConfigInput(cycleDelayInput, status.config.cycleDelay ?? 5000);
    syncConfigInput(releaseScanMaxPagesInput, status.config.releaseScanMaxPages ?? 20);
  }

  if (status.logs?.length > 0) {
    logList.innerHTML = status.logs
      .map((log) => `<div class="log-entry">${escapeHtml(log)}</div>`)
      .join('');
  } else {
    logList.innerHTML = '<div class="log-empty">로그가 없습니다.</div>';
  }
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[Popup] 메시지 전송 실패:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }

      resolve(response);
    });
  });
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
