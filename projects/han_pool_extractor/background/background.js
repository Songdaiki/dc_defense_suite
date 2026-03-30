import {
  STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  DEFAULT_PAGE_DELAY_MS,
  DEFAULT_START_PAGE,
  DEFAULT_END_PAGE,
  MIN_REPEAT_COUNT,
  accumulateHanCounts,
  appendLogLine,
  buildManagementPageUrl,
  buildPublicState,
  buildRepeatedEntries,
  buildResultString,
  clampMinRepeatCount,
  clampPageValue,
  createDefaultSettings,
  createIdleState,
  formatLogLine,
  isBoardRowType,
  isSupportedManagementUrl,
  mapToPlainObject,
  normalizeSettings,
  plainObjectToMap
} from './core.mjs';

let state = createIdleState();
let settings = createDefaultSettings();
let popupPort = null;
let stateLoaded = false;
let startJobInFlight = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureStateLoaded() {
  if (stateLoaded) {
    return;
  }

  const [storedStateResult, storedSettingsResult] = await Promise.all([
    chrome.storage.session.get(STORAGE_KEY),
    chrome.storage.local.get(SETTINGS_STORAGE_KEY)
  ]);

  settings = normalizeSettings(storedSettingsResult?.[SETTINGS_STORAGE_KEY]);
  state = {
    ...createIdleState(),
    ...settings,
    ...(storedStateResult?.[STORAGE_KEY] || {})
  };
  stateLoaded = true;
}

async function persistState() {
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
}

async function persistSettings() {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

function getCountMap() {
  return plainObjectToMap(state.frequencyMap);
}

async function updateCountsAndResult(nextMap) {
  const repeatedEntries = buildRepeatedEntries(nextMap, state.minRepeatCount || MIN_REPEAT_COUNT);
  state.frequencyMap = mapToPlainObject(nextMap);
  state.uniqueHanCount = nextMap.size;
  state.repeatedHanCount = repeatedEntries.length;
  state.resultText = buildResultString(repeatedEntries);
}

async function applyMinRepeatCount(nextMinRepeatCount, options = {}) {
  const minRepeatCount = clampMinRepeatCount(nextMinRepeatCount, state.minRepeatCount || MIN_REPEAT_COUNT);
  state.minRepeatCount = minRepeatCount;
  settings.minRepeatCount = minRepeatCount;
  await updateCountsAndResult(getCountMap());
  await Promise.all([persistState(), persistSettings()]);
  notifyPopup();

  if (!options.silent) {
    await pushLog(`최소 반복 횟수를 ${minRepeatCount}회 이상으로 변경`);
  }
}

async function pushLog(message) {
  state.logs = appendLogLine(state.logs, formatLogLine(message));
  await persistState();
  notifyPopup();
}

function notifyPopup() {
  if (!popupPort) {
    return;
  }

  try {
    popupPort.postMessage({
      type: 'state',
      state: {
        ...buildPublicState(state),
        settings: { ...settings }
      }
    });
  } catch (error) {
    popupPort = null;
  }
}

async function setState(patch) {
  state = {
    ...state,
    ...patch
  };
  await persistState();
  notifyPopup();
}

async function clearFinishedState() {
  const preservedMinRepeatCount = state.minRepeatCount || MIN_REPEAT_COUNT;
  state = createIdleState();
  state.startPage = settings.startPage || DEFAULT_START_PAGE;
  state.endPage = settings.endPage || DEFAULT_END_PAGE;
  state.minRepeatCount = preservedMinRepeatCount;
  await persistState();
  notifyPopup();
}

async function closeCrawlerTab(tabId = state.crawlerTabId) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // 이미 닫혔으면 무시
  }
}

function scrapeCurrentManagementPage() {
  const tbody = document.querySelector('tbody');
  if (!tbody) {
    return {
      ok: false,
      rowCount: 0,
      rows: [],
      locationHref: window.location.href,
      error: 'tbody를 찾지 못함'
    };
  }

  const rows = Array.from(tbody.querySelectorAll('tr'));
  const extractedRows = rows.map((row) => {
    const typeText = row.querySelector('td.blockcontent em')?.textContent?.trim() || '';
    const titleText = row.querySelector('td.blockcontent a')?.textContent?.trim() || '';
    return {
      typeText,
      titleText
    };
  });

  return {
    ok: true,
    rowCount: rows.length,
    rows: extractedRows,
    locationHref: window.location.href
  };
}

async function retryOrSkipCurrentPage(reason) {
  if (state.retryCount < 1) {
    state.retryCount += 1;
    state.phase = 'loading_page';
    await persistState();
    notifyPopup();
    await pushLog(`${state.currentPage}페이지 처리 실패, 1회 재시도: ${reason}`);
    try {
      await chrome.tabs.reload(state.crawlerTabId);
    } catch (error) {
      await failJob(`재시도 reload 실패: ${error.message}`);
    }
    return;
  }

  await pushLog(`${state.currentPage}페이지 재시도도 실패, 다음 페이지로 건너뜀: ${reason}`);
  state.retryCount = 0;
  await persistState();
  notifyPopup();
  await moveToNextPageOrFinish();
}

async function finishJob(finalStatus, message) {
  const closingTabId = state.crawlerTabId;
  await setState({
    status: finalStatus,
    phase: 'finished',
    stopRequested: false,
    crawlerTabId: null,
    errorMessage: finalStatus === 'error' ? message : ''
  });
  await pushLog(message);
  await closeCrawlerTab(closingTabId);
}

async function failJob(message) {
  await finishJob('error', `오류로 중단: ${message}`);
}

async function stopJob() {
  await ensureStateLoaded();
  if (state.status !== 'running') {
    return;
  }

  await setState({
    stopRequested: true
  });
  await pushLog('중지 요청을 받음. 현재 페이지 처리 후 종료 예정');
}

async function moveToNextPageOrFinish() {
  if (state.stopRequested) {
    await finishJob('stopped', '사용자 요청으로 중지됨');
    return;
  }

  if (state.currentPage >= state.endPage) {
    await finishJob(
      'completed',
      `분석 완료: ${state.pagesProcessed}페이지, 제목 ${state.totalTitleCount}건, 중복 한자 ${state.repeatedHanCount}종`
    );
    return;
  }

  const nextPage = state.currentPage + 1;
  await pushLog(`${state.currentPage}페이지 완료. ${state.pageDelayMs}ms 대기 후 ${nextPage}페이지로 이동`);
  await sleep(state.pageDelayMs);

  if (state.stopRequested) {
    await finishJob('stopped', '사용자 요청으로 중지됨');
    return;
  }

  state.currentPage = nextPage;
  state.retryCount = 0;
  state.phase = 'loading_page';
  await persistState();
  notifyPopup();

  try {
    await chrome.tabs.update(state.crawlerTabId, {
      url: buildManagementPageUrl(state.sourceUrl, nextPage)
    });
  } catch (error) {
    await failJob(`다음 페이지 이동 실패: ${error.message}`);
  }
}

async function processLoadedPage() {
  if (state.status !== 'running' || state.phase !== 'loading_page') {
    return;
  }

  await setState({ phase: 'scraping_page' });

  let scrapeResult;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: state.crawlerTabId },
      func: scrapeCurrentManagementPage
    });
    scrapeResult = results?.[0]?.result;
  } catch (error) {
    await retryOrSkipCurrentPage(`스크립트 실행 실패: ${error.message}`);
    return;
  }

  if (!scrapeResult || scrapeResult.ok === false || !Array.isArray(scrapeResult.rows)) {
    if (scrapeResult?.locationHref && !isSupportedManagementUrl(scrapeResult.locationHref)) {
      await failJob(`관리기록 페이지가 아닌 곳으로 이동됨: ${scrapeResult.locationHref}`);
      return;
    }
    await retryOrSkipCurrentPage('페이지 구조를 읽지 못함');
    return;
  }

  const boardTitles = [];
  let boardRowCount = 0;
  for (const row of scrapeResult.rows) {
    if (isBoardRowType(row?.typeText)) {
      boardRowCount += 1;
      if (row.titleText) {
        boardTitles.push(row.titleText);
      }
    }
  }

  const countResult = accumulateHanCounts(boardTitles, getCountMap());
  await updateCountsAndResult(countResult.counts);

  state.pagesProcessed += 1;
  state.lastCompletedPage = state.currentPage;
  state.totalRowCount += scrapeResult.rowCount;
  state.totalBoardRowCount += boardRowCount;
  state.totalTitleCount += countResult.addedTitleCount;
  state.totalHanCount += countResult.addedHanCount;
  state.retryCount = 0;
  await persistState();
  notifyPopup();

  await pushLog(
    `${state.currentPage}페이지 수집 완료: 전체 row ${scrapeResult.rowCount}개 / 게시글 row ${boardRowCount}개 / 제목 ${countResult.addedTitleCount}개 / 한자 ${countResult.addedHanCount}개 / 누적 중복 ${state.repeatedHanCount}종`
  );

  await moveToNextPageOrFinish();
}

async function startJob(payload) {
  if (startJobInFlight) {
    await ensureStateLoaded();
    await pushLog('이미 실행 중이라 새 작업을 시작할 수 없음');
    return;
  }

  startJobInFlight = true;
  try {
    await ensureStateLoaded();
    if (state.status === 'running') {
      await pushLog('이미 실행 중이라 새 작업을 시작할 수 없음');
      return;
    }

    const sourceUrl = String(payload?.sourceUrl || '');
    if (!isSupportedManagementUrl(sourceUrl)) {
      state = createIdleState();
      await setState({
        status: 'error',
        phase: 'idle',
        errorMessage: '관리기록 차단 페이지에서만 실행할 수 있음'
      });
      await pushLog('실패: 현재 탭 URL이 관리기록 차단 페이지가 아님');
      return;
    }

    const startPage = clampPageValue(payload?.startPage, DEFAULT_START_PAGE);
    const endPage = clampPageValue(payload?.endPage, DEFAULT_END_PAGE);
    const minRepeatCount = clampMinRepeatCount(payload?.minRepeatCount, state.minRepeatCount || MIN_REPEAT_COUNT);
    if (startPage > endPage) {
      state = createIdleState();
      state.startPage = settings.startPage || DEFAULT_START_PAGE;
      state.endPage = settings.endPage || DEFAULT_END_PAGE;
      state.minRepeatCount = minRepeatCount;
      await setState({
        status: 'error',
        phase: 'idle',
        errorMessage: '시작 페이지가 끝 페이지보다 큼'
      });
      await pushLog('실패: 시작 페이지는 끝 페이지보다 작거나 같아야 함');
      return;
    }

    const initialUrl = buildManagementPageUrl(sourceUrl, startPage);
    let crawlerTab;
    try {
      crawlerTab = await chrome.tabs.create({
        url: initialUrl,
        active: false
      });
    } catch (error) {
      await failJob(`수집 탭 생성 실패: ${error.message}`);
      return;
    }

    settings.startPage = startPage;
    settings.endPage = endPage;
    settings.minRepeatCount = minRepeatCount;

    state = createIdleState();
    state.status = 'running';
    state.phase = 'loading_page';
    state.sourceUrl = sourceUrl;
    state.startPage = startPage;
    state.endPage = endPage;
    state.currentPage = startPage;
    state.pageDelayMs = DEFAULT_PAGE_DELAY_MS;
    state.minRepeatCount = minRepeatCount;
    state.crawlerTabId = crawlerTab.id;
    state.logs = [];

    await Promise.all([persistState(), persistSettings()]);
    notifyPopup();
    await pushLog(`작업 시작: ${startPage}페이지 ~ ${endPage}페이지, 페이지 간 대기 ${DEFAULT_PAGE_DELAY_MS}ms, 최소 반복 ${minRepeatCount}회 이상`);

    try {
      const createdTab = await chrome.tabs.get(crawlerTab.id);
      if (createdTab?.status === 'complete') {
        await processLoadedPage();
      }
    } catch (error) {
      await failJob(`수집 탭 상태 확인 실패: ${error.message}`);
    }
  } finally {
    startJobInFlight = false;
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await ensureStateLoaded();
  if (state.status !== 'running') {
    return;
  }
  if (tabId !== state.crawlerTabId) {
    return;
  }
  if (changeInfo.status !== 'complete') {
    return;
  }

  await processLoadedPage();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureStateLoaded();
  if (state.status !== 'running') {
    return;
  }
  if (tabId !== state.crawlerTabId) {
    return;
  }

  await failJob('수집 탭이 닫힘');
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'han-pool-extractor-popup') {
    return;
  }

  popupPort = port;
  ensureStateLoaded().then(() => {
    notifyPopup();
  });

  port.onDisconnect.addListener(() => {
    if (popupPort === port) {
      popupPort = null;
    }
  });

  port.onMessage.addListener(async (message) => {
    try {
      if (message?.type === 'getState') {
        await ensureStateLoaded();
        notifyPopup();
        return;
      }

      if (message?.type === 'start') {
        await startJob(message);
        return;
      }

      if (message?.type === 'stop') {
        await stopJob();
        return;
      }

      if (message?.type === 'setMinRepeatCount') {
        await ensureStateLoaded();
        await applyMinRepeatCount(message.minRepeatCount);
        return;
      }

      if (message?.type === 'clear') {
        if (state.status === 'running') {
          await pushLog('실행 중에는 초기화할 수 없음');
          return;
        }
        await clearFinishedState();
      }
    } catch (error) {
      await failJob(`메시지 처리 실패: ${error.message}`);
    }
  });
});
