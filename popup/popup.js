/**
 * DC Comment Protect - Popup 로직
 * 
 * background(Service Worker)와 메시지 통신으로
 * 토글 ON/OFF, 상태 표시, 설정 저장, 로그 표시를 처리합니다.
 */

// ============================================================
// DOM 요소
// ============================================================
const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const statusText = document.getElementById('statusText');
const currentPosition = document.getElementById('currentPosition');
const totalDeleted = document.getElementById('totalDeleted');
const cycleCount = document.getElementById('cycleCount');
const logList = document.getElementById('logList');
const minPageInput = document.getElementById('minPage');
const maxPageInput = document.getElementById('maxPage');
const requestDelayInput = document.getElementById('requestDelay');
const cycleDelayInput = document.getElementById('cycleDelay');
const postConcurrencyInput = document.getElementById('postConcurrency');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const resetBtn = document.getElementById('resetBtn');

// ============================================================
// 초기화
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    await refreshStatus();

    // 1초마다 상태 갱신
    setInterval(refreshStatus, 1000);
});

// ============================================================
// 이벤트 핸들러
// ============================================================

// 토글 ON/OFF
toggleBtn.addEventListener('change', async () => {
    const action = toggleBtn.checked ? 'start' : 'stop';
    const response = await sendMessage({ action });

    if (response && response.success) {
        updateUI(response.status);
    }
});

// 설정 저장
saveConfigBtn.addEventListener('click', async () => {
    const minPage = parseOptionalInt(minPageInput.value, 1);
    const maxPage = parseOptionalInt(maxPageInput.value, 5);
    const requestDelay = parseOptionalInt(requestDelayInput.value, 100);
    const cycleDelay = parseOptionalInt(cycleDelayInput.value, 5000);
    const postConcurrency = parseOptionalInt(postConcurrencyInput.value, 8);

    const config = {
        minPage,
        maxPage,
        requestDelay,
        cycleDelay,
        postConcurrency,
    };

    const response = await sendMessage({ action: 'updateConfig', config });

    if (response && response.success) {
        saveConfigBtn.textContent = '✅ 저장됨';
        setTimeout(() => { saveConfigBtn.textContent = '설정 저장'; }, 1500);
    }
});

// 통계 초기화
resetBtn.addEventListener('click', async () => {
    if (confirm('통계와 로그를 초기화하시겠습니까?')) {
        const response = await sendMessage({ action: 'resetStats' });
        if (response && response.success) {
            updateUI(response.status);
        }
    }
});

// ============================================================
// 상태 갱신
// ============================================================

async function refreshStatus() {
    const response = await sendMessage({ action: 'getStatus' });
    if (response && response.success) {
        updateUI(response.status);
    }
}

function updateUI(status) {
    // 토글
    toggleBtn.checked = status.isRunning;
    toggleLabel.textContent = status.isRunning ? 'ON' : 'OFF';
    toggleLabel.className = `toggle-label ${status.isRunning ? 'on' : 'off'}`;

    // 상태
    if (status.isRunning) {
        statusText.textContent = '🟢 실행 중';
        statusText.className = 'status-value status-on';
    } else {
        statusText.textContent = '🔴 정지';
        statusText.className = 'status-value status-off';
    }

    // 현재 위치
    if (status.isRunning && status.currentPage > 0) {
        currentPosition.textContent = `${status.currentPage}P / #${status.currentPostNo}`;
    } else {
        currentPosition.textContent = '-';
    }

    // 통계
    totalDeleted.textContent = `${status.totalDeleted}개`;
    cycleCount.textContent = `${status.cycleCount}회`;

    // 설정
    if (status.config) {
        syncConfigInput(minPageInput, status.config.minPage ?? 1);
        syncConfigInput(maxPageInput, status.config.maxPage ?? 5);
        syncConfigInput(requestDelayInput, status.config.requestDelay ?? 100);
        syncConfigInput(cycleDelayInput, status.config.cycleDelay ?? 5000);
        syncConfigInput(postConcurrencyInput, status.config.postConcurrency ?? 8);
    }

    // 로그
    if (status.logs && status.logs.length > 0) {
        logList.innerHTML = status.logs
            .map(log => `<div class="log-entry">${escapeHtml(log)}</div>`)
            .join('');
    } else {
        logList.innerHTML = '<div class="log-empty">로그가 없습니다.</div>';
    }
}

// ============================================================
// 유틸리티
// ============================================================

function sendMessage(message) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[Popup] 메시지 전송 실패:', chrome.runtime.lastError.message);
                resolve(null);
            } else {
                resolve(response);
            }
        });
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
