export const STORAGE_KEY = 'hanPoolExtractorState';
export const SETTINGS_STORAGE_KEY = 'hanPoolExtractorSettings';
export const DEFAULT_START_PAGE = 1;
export const DEFAULT_END_PAGE = 400;
export const DEFAULT_PAGE_DELAY_MS = 500;
export const MAX_LOG_LINES = 500;
export const MIN_REPEAT_COUNT = 2;

const HAN_CHAR_REGEX = /\p{Script=Han}/u;

export function createIdleState() {
  return {
    status: 'idle',
    phase: 'idle',
    sourceUrl: '',
    startPage: DEFAULT_START_PAGE,
    endPage: DEFAULT_END_PAGE,
    currentPage: 0,
    lastCompletedPage: 0,
    pagesProcessed: 0,
    totalRowCount: 0,
    totalBoardRowCount: 0,
    totalTitleCount: 0,
    totalHanCount: 0,
    uniqueHanCount: 0,
    repeatedHanCount: 0,
    resultText: '',
    logs: [],
    pageDelayMs: DEFAULT_PAGE_DELAY_MS,
    minRepeatCount: MIN_REPEAT_COUNT,
    crawlerTabId: null,
    stopRequested: false,
    retryCount: 0,
    errorMessage: '',
    frequencyMap: {}
  };
}

export function createDefaultSettings() {
  return {
    startPage: DEFAULT_START_PAGE,
    endPage: DEFAULT_END_PAGE,
    minRepeatCount: MIN_REPEAT_COUNT
  };
}

export function clampPageValue(value, fallback) {
  const numberValue = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return fallback;
  }

  return numberValue;
}

export function clampMinRepeatCount(value, fallback = MIN_REPEAT_COUNT) {
  const numberValue = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numberValue) || numberValue < 2) {
    return fallback;
  }

  return numberValue;
}

export function normalizeSettings(value) {
  const fallbackSettings = createDefaultSettings();
  return {
    startPage: clampPageValue(value?.startPage, fallbackSettings.startPage),
    endPage: clampPageValue(value?.endPage, fallbackSettings.endPage),
    minRepeatCount: clampMinRepeatCount(value?.minRepeatCount, fallbackSettings.minRepeatCount)
  };
}

export function isSupportedManagementUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.origin === 'https://gall.dcinside.com' && url.pathname === '/mgallery/management/block';
  } catch (error) {
    return false;
  }
}

export function buildManagementPageUrl(sourceUrl, page) {
  const url = new URL(sourceUrl);
  url.searchParams.set('p', String(page));
  return url.toString();
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function isBoardRowType(value) {
  return normalizeText(value) === '게시글';
}

export function extractHanChars(text) {
  const chars = [];
  for (const char of String(text ?? '')) {
    if (HAN_CHAR_REGEX.test(char)) {
      chars.push(char);
    }
  }
  return chars;
}

export function accumulateHanCounts(titles, previousMap = new Map()) {
  const nextMap = previousMap instanceof Map ? new Map(previousMap) : plainObjectToMap(previousMap);
  let addedTitleCount = 0;
  let addedHanCount = 0;

  for (const rawTitle of titles ?? []) {
    const title = normalizeText(rawTitle);
    if (!title) {
      continue;
    }

    addedTitleCount += 1;
    const hanChars = extractHanChars(title);
    for (const char of hanChars) {
      nextMap.set(char, (nextMap.get(char) || 0) + 1);
      addedHanCount += 1;
    }
  }

  return {
    counts: nextMap,
    addedTitleCount,
    addedHanCount
  };
}

export function buildRepeatedEntries(countMap, minCount = MIN_REPEAT_COUNT) {
  const map = countMap instanceof Map ? countMap : plainObjectToMap(countMap);
  return Array.from(map.entries())
    .filter(([, count]) => count >= minCount)
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return (left[0].codePointAt(0) || 0) - (right[0].codePointAt(0) || 0);
    })
    .map(([char, count]) => ({ char, count }));
}

export function buildResultString(repeatedEntries) {
  return (repeatedEntries ?? []).map((entry) => entry.char).join(',');
}

export function mapToPlainObject(map) {
  const plainObject = {};
  for (const [key, value] of map.entries()) {
    plainObject[key] = value;
  }
  return plainObject;
}

export function plainObjectToMap(value) {
  const nextMap = new Map();
  for (const [key, count] of Object.entries(value || {})) {
    nextMap.set(key, Number(count));
  }
  return nextMap;
}

export function buildPublicState(state) {
  return {
    status: state.status,
    phase: state.phase,
    sourceUrl: state.sourceUrl,
    startPage: state.startPage,
    endPage: state.endPage,
    currentPage: state.currentPage,
    lastCompletedPage: state.lastCompletedPage,
    pagesProcessed: state.pagesProcessed,
    totalRowCount: state.totalRowCount,
    totalBoardRowCount: state.totalBoardRowCount,
    totalTitleCount: state.totalTitleCount,
    totalHanCount: state.totalHanCount,
    uniqueHanCount: state.uniqueHanCount,
    repeatedHanCount: state.repeatedHanCount,
    resultText: state.resultText,
    logs: Array.isArray(state.logs) ? state.logs : [],
    pageDelayMs: state.pageDelayMs,
    minRepeatCount: state.minRepeatCount,
    stopRequested: Boolean(state.stopRequested),
    errorMessage: state.errorMessage || ''
  };
}

export function appendLogLine(logs, line) {
  const nextLogs = Array.isArray(logs) ? [...logs] : [];
  nextLogs.push(line);
  if (nextLogs.length > MAX_LOG_LINES) {
    return nextLogs.slice(-MAX_LOG_LINES);
  }
  return nextLogs;
}

export function formatLogLine(message, date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}] ${message}`;
}
