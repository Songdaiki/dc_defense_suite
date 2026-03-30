const startPageInput = document.getElementById('startPage');
const endPageInput = document.getElementById('endPage');
const minRepeatCountInput = document.getElementById('minRepeatCount');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const copyButton = document.getElementById('copyButton');
const clearButton = document.getElementById('clearButton');
const statusText = document.getElementById('statusText');
const currentPageText = document.getElementById('currentPageText');
const pagesProcessedText = document.getElementById('pagesProcessedText');
const titleCountText = document.getElementById('titleCountText');
const totalHanCountText = document.getElementById('totalHanCountText');
const repeatedHanCountText = document.getElementById('repeatedHanCountText');
const logArea = document.getElementById('logArea');
const resultArea = document.getElementById('resultArea');

const port = chrome.runtime.connect({ name: 'han-pool-extractor-popup' });

function renderState(state) {
  const statusLabelMap = {
    idle: '대기',
    running: '실행 중',
    stopping: '중지 중',
    stopped: '중지됨',
    completed: '완료',
    error: '오류'
  };

  statusText.textContent = statusLabelMap[state?.status] || '대기';
  const settings = state?.settings || {};
  if (document.activeElement !== startPageInput && settings?.startPage) {
    startPageInput.value = String(settings.startPage);
  }
  if (document.activeElement !== endPageInput && settings?.endPage) {
    endPageInput.value = String(settings.endPage);
  }
  if (document.activeElement !== minRepeatCountInput && settings?.minRepeatCount) {
    minRepeatCountInput.value = String(settings.minRepeatCount);
  }
  currentPageText.textContent = state?.currentPage ? `${state.currentPage}` : '-';
  pagesProcessedText.textContent = String(state?.pagesProcessed || 0);
  titleCountText.textContent = String(state?.totalTitleCount || 0);
  totalHanCountText.textContent = String(state?.totalHanCount || 0);
  repeatedHanCountText.textContent = String(state?.repeatedHanCount || 0);
  logArea.value = Array.isArray(state?.logs) ? state.logs.join('\n') : '';
  resultArea.value = state?.resultText || '';

  const isRunning = state?.status === 'running';
  startButton.disabled = isRunning;
  stopButton.disabled = !isRunning;
  clearButton.disabled = isRunning;
}

async function getCurrentTabUrl() {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  return tabs?.[0]?.url || '';
}

startButton.addEventListener('click', async () => {
  const sourceUrl = await getCurrentTabUrl();
  port.postMessage({
    type: 'start',
    sourceUrl,
    startPage: startPageInput.value,
    endPage: endPageInput.value,
    minRepeatCount: minRepeatCountInput.value
  });
});

minRepeatCountInput.addEventListener('change', () => {
  port.postMessage({
    type: 'setMinRepeatCount',
    minRepeatCount: minRepeatCountInput.value
  });
});

stopButton.addEventListener('click', () => {
  port.postMessage({ type: 'stop' });
});

clearButton.addEventListener('click', () => {
  port.postMessage({ type: 'clear' });
});

copyButton.addEventListener('click', async () => {
  const value = resultArea.value || '';
  if (!value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    copyButton.textContent = '복사 완료';
    setTimeout(() => {
      copyButton.textContent = '결과 복사';
    }, 1200);
  } catch (error) {
    copyButton.textContent = '복사 실패';
    setTimeout(() => {
      copyButton.textContent = '결과 복사';
    }, 1200);
  }
});

port.onMessage.addListener((message) => {
  if (message?.type === 'state') {
    renderState(message.state);
  }
});

port.postMessage({ type: 'getState' });
