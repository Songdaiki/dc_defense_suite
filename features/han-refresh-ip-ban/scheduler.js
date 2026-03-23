import {
  DEFAULT_CONFIG,
  delay,
  fetchManagementBlockHTML,
  rebanManagementRows,
} from './api.js';
import {
  extractActionableManagementRows,
  extractMaxBlockDataNum,
  isLikelyManagementBlockHtml,
  parseDetectedMaxPage,
} from './parser.js';

const STORAGE_KEY = 'hanRefreshIpBanSchedulerState';
const MAX_TAIL_EXPANSION_ROUNDS = 10;
const PHASE = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
};

class Scheduler {
  constructor(dependencies = {}) {
    this.fetchManagementBlockHTML = dependencies.fetchManagementBlockHTML || fetchManagementBlockHTML;
    this.rebanManagementRows = dependencies.rebanManagementRows || rebanManagementRows;
    this.extractActionableManagementRows = dependencies.extractActionableManagementRows || extractActionableManagementRows;
    this.extractMaxBlockDataNum = dependencies.extractMaxBlockDataNum || extractMaxBlockDataNum;
    this.isLikelyManagementBlockHtml = dependencies.isLikelyManagementBlockHtml || isLikelyManagementBlockHtml;
    this.parseDetectedMaxPage = dependencies.parseDetectedMaxPage || parseDetectedMaxPage;
    this.delayFn = dependencies.delayFn || delay;

    this.isRunning = false;
    this.runPromise = null;
    this.phase = PHASE.IDLE;
    this.currentPage = 0;
    this.detectedMaxPage = 0;
    this.currentCycleScannedRows = 0;
    this.currentCycleMatchedRows = 0;
    this.currentCycleBanSuccessCount = 0;
    this.currentCycleBanFailureCount = 0;
    this.currentCycleBaselineMaxBlockDataNum = 0;
    this.cycleCount = 0;
    this.lastRunAt = '';
    this.nextRunAt = '';
    this.logs = [];

    this.config = {
      galleryId: DEFAULT_CONFIG.galleryId,
      galleryType: DEFAULT_CONFIG.galleryType,
      baseUrl: DEFAULT_CONFIG.baseUrl,
      requestDelay: DEFAULT_CONFIG.requestDelay,
      fallbackMaxPage: DEFAULT_CONFIG.fallbackMaxPage,
      cycleIntervalMs: DEFAULT_CONFIG.cycleIntervalMs,
      avoidHour: DEFAULT_CONFIG.avoidHour,
      avoidReason: DEFAULT_CONFIG.avoidReason,
      avoidReasonText: DEFAULT_CONFIG.avoidReasonText,
    };
  }

  async start() {
    if (this.isRunning) {
      this.log('⚠️ 이미 도배기 갱신 차단 자동이 실행 중입니다.');
      return;
    }

    this.isRunning = true;
    this.phase = PHASE.RUNNING;
    this.currentPage = 0;
    this.nextRunAt = '';
    this.log('🟢 도배기 갱신 차단 자동 시작!');
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    if (!this.isRunning) {
      this.log('⚠️ 이미 도배기 갱신 차단 자동이 정지 상태입니다.');
      await this.saveState();
      return;
    }

    this.isRunning = false;
    this.phase = PHASE.IDLE;
    this.currentPage = 0;
    this.nextRunAt = '';
    this.log('🔴 도배기 갱신 차단 자동 중지.');
    await this.saveState();
  }

  async run() {
    while (this.isRunning) {
      const nextRunAtMs = parseTimestamp(this.nextRunAt);
      if (nextRunAtMs > Date.now()) {
        if (this.phase !== PHASE.WAITING) {
          this.phase = PHASE.WAITING;
          this.currentPage = 0;
          await this.saveState();
        }

        await delayWhileRunning(this, nextRunAtMs - Date.now());
        continue;
      }

      try {
        this.phase = PHASE.RUNNING;
        await this.saveState();
        await this.runCycle();

        if (!this.isRunning) {
          break;
        }

        const completedAt = Date.now();
        this.cycleCount += 1;
        this.lastRunAt = new Date(completedAt).toISOString();
        this.nextRunAt = new Date(completedAt + getCycleIntervalMs(this.config)).toISOString();
        this.phase = PHASE.WAITING;
        this.currentPage = 0;
        this.log(
          `✅ 사이클 #${this.cycleCount} 완료 - 검사 ${this.currentCycleScannedRows}줄 / 대상 ${this.currentCycleMatchedRows}줄 / 성공 ${this.currentCycleBanSuccessCount}건 / 실패 ${this.currentCycleBanFailureCount}건`,
        );
        this.log(`⏳ 다음 실행 예정: ${formatTimestamp(this.nextRunAt)}`);
        await this.saveState();
      } catch (error) {
        this.phase = PHASE.WAITING;
        this.currentPage = 0;
        this.log(`❌ 도배기 갱신 차단 자동 오류 - ${error.message}`);
        console.error('[HanRefreshIpBanScheduler] run error:', error);

        if (this.isRunning) {
          this.nextRunAt = new Date(Date.now() + getCycleIntervalMs(this.config)).toISOString();
          this.log(`⏳ 오류로 이번 사이클 종료 - 다음 실행 예정: ${formatTimestamp(this.nextRunAt)}`);
        }

        await this.saveState();
      }
    }

    this.phase = PHASE.IDLE;
    await this.saveState();
  }

  async runCycle() {
    const seenAvoidNos = new Set();
    resetCycleMetrics(this);

    const initialPageResult = await this.fetchDetectedMaxPageWithHtml('관리내역 1페이지 로딩 실패');
    if (!this.isRunning) {
      return;
    }

    this.detectedMaxPage = initialPageResult.detectedMaxPage;
    this.currentCycleBaselineMaxBlockDataNum = this.extractMaxBlockDataNum(initialPageResult.html);
    this.log(`📚 초기 끝 페이지 감지: ${this.detectedMaxPage}P (${initialPageResult.source})`);
    if (this.currentCycleBaselineMaxBlockDataNum > 0) {
      this.log(`🧷 사이클 기준 row 상한 data-num: ${this.currentCycleBaselineMaxBlockDataNum}`);
    }
    await this.saveState();

    let scanStartPage = 1;
    let scanEndPage = this.detectedMaxPage;
    let cachedFirstPageHtml = initialPageResult.html;
    let tailExpansionRounds = 0;

    while (this.isRunning && scanStartPage <= scanEndPage) {
      await this.scanPageRange(scanStartPage, scanEndPage, seenAvoidNos, cachedFirstPageHtml);
      if (!this.isRunning) {
        break;
      }

      const completedEndPage = scanEndPage;
      cachedFirstPageHtml = '';

      const refreshedPageResult = await this.tryRefreshDetectedMaxPage();
      if (!refreshedPageResult) {
        break;
      }

      this.detectedMaxPage = refreshedPageResult.detectedMaxPage;
      await this.saveState();

      if (refreshedPageResult.detectedMaxPage <= completedEndPage) {
        this.log(`✅ 끝 페이지 안정화 확인: 마지막 스캔 ${completedEndPage}P / 재감지 ${refreshedPageResult.detectedMaxPage}P`);
        await this.saveState();
        break;
      }

      tailExpansionRounds += 1;
      if (tailExpansionRounds > MAX_TAIL_EXPANSION_ROUNDS) {
        this.log(`⚠️ tail 보정 한도 초과 - 마지막 스캔 ${completedEndPage}P / 재감지 ${refreshedPageResult.detectedMaxPage}P`);
        await this.saveState();
        break;
      }

      const expandedEndPage = refreshedPageResult.detectedMaxPage;
      this.log(`↗ 끝 페이지 증가 감지: ${completedEndPage}P -> ${expandedEndPage}P`);
      this.log(`🔁 tail 보정 스캔: ${completedEndPage + 1}P ~ ${expandedEndPage}P`);
      await this.saveState();

      scanStartPage = completedEndPage + 1;
      scanEndPage = expandedEndPage;
    }
  }

  async processPage(page, html, seenAvoidNos) {
    const { rows, actionableRows } = this.extractActionableManagementRows(html, {
      seenAvoidNos,
      maxAllowedBlockDataNum: this.currentCycleBaselineMaxBlockDataNum,
    });
    const avoidNos = actionableRows.map((row) => row.avoidNo);

    this.currentCycleScannedRows += rows.length;
    this.currentCycleMatchedRows += actionableRows.length;

    if (!this.isRunning) {
      await this.saveState();
      return;
    }

    if (avoidNos.length === 0) {
      this.log(`📄 ${page}페이지: 검사 ${rows.length}줄, 대상 0줄`);
      await this.saveState();
      return;
    }

    let result = null;
    try {
      result = await this.rebanManagementRows(this.config, avoidNos, page);
    } catch (error) {
      this.currentCycleBanFailureCount += avoidNos.length;
      this.log(`❌ ${page}페이지 재차단 요청 실패 - ${error.message}`);
      await this.saveState();
      return;
    }

    const successCount = result.successNos?.length || 0;
    const failureCount = result.failedNos?.length || 0;
    this.currentCycleBanSuccessCount += successCount;
    this.currentCycleBanFailureCount += failureCount;

    if (failureCount <= 0) {
      this.log(`✅ ${page}페이지: 검사 ${rows.length}줄, 대상 ${avoidNos.length}줄, 재차단 ${successCount}건`);
    } else {
      this.log(`⚠️ ${page}페이지: 검사 ${rows.length}줄, 대상 ${avoidNos.length}줄, 성공 ${successCount}건 / 실패 ${failureCount}건`);
      if (result.message) {
        this.log(`⚠️ ${page}페이지 상세: ${result.message}`);
      }
    }

    await this.saveState();
  }

  async scanPageRange(startPage, endPage, seenAvoidNos, firstPageHtml = '') {
    for (let page = startPage; page <= endPage; page += 1) {
      if (!this.isRunning) {
        break;
      }

      this.currentPage = page;
      await this.saveState();

      let pageHtml = '';
      if (page === 1 && firstPageHtml) {
        pageHtml = firstPageHtml;
      } else {
        try {
          pageHtml = await this.fetchManagementBlockHTML(this.config, page, 2);
        } catch (error) {
          this.log(`⚠️ ${page}페이지 로딩 실패 - ${error.message}`);
          continue;
        }
      }

      await this.processPage(page, pageHtml, seenAvoidNos);

      if (!this.isRunning || page >= endPage) {
        continue;
      }

      const requestDelay = getRequestDelayMs(this.config);
      if (requestDelay > 0) {
        await delayWhileRunning(this, requestDelay);
      }
    }
  }

  async fetchDetectedMaxPageWithHtml(errorPrefix) {
    let firstPageHtml = '';
    try {
      firstPageHtml = await this.fetchManagementBlockHTML(this.config, 1, 2);
    } catch (error) {
      throw new Error(`${errorPrefix} - ${error.message}`);
    }

    if (!this.isLikelyManagementBlockHtml(firstPageHtml)) {
      throw new Error('관리내역 페이지 구조를 찾지 못했습니다.');
    }

    const maxPageResult = this.parseDetectedMaxPage(firstPageHtml, this.config.fallbackMaxPage);
    return {
      html: firstPageHtml,
      detectedMaxPage: normalizeDetectedMaxPage(maxPageResult?.detectedMaxPage, this.config.fallbackMaxPage),
      source: maxPageResult?.source || 'fallback',
    };
  }

  async tryRefreshDetectedMaxPage() {
    try {
      return await this.fetchDetectedMaxPageWithHtml('끝 페이지 재감지 실패');
    } catch (error) {
      this.log(`⚠️ ${error.message}`);
      await this.saveState();
      return null;
    }
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[HanRefreshIpBanScheduler] ${message}`);

    this.logs.unshift(entry);
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(0, 100);
    }
  }

  async saveState() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          isRunning: this.isRunning,
          phase: this.phase,
          currentPage: this.currentPage,
          detectedMaxPage: this.detectedMaxPage,
          currentCycleScannedRows: this.currentCycleScannedRows,
          currentCycleMatchedRows: this.currentCycleMatchedRows,
          currentCycleBanSuccessCount: this.currentCycleBanSuccessCount,
          currentCycleBanFailureCount: this.currentCycleBanFailureCount,
          currentCycleBaselineMaxBlockDataNum: this.currentCycleBaselineMaxBlockDataNum,
          cycleCount: this.cycleCount,
          lastRunAt: this.lastRunAt,
          nextRunAt: this.nextRunAt,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[HanRefreshIpBanScheduler] 상태 저장 실패:', error.message);
    }
  }

  async loadState() {
    try {
      const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
      if (!schedulerState) {
        return;
      }

      this.isRunning = Boolean(schedulerState.isRunning);
      this.phase = normalizePhase(schedulerState.phase);
      this.currentPage = Number(schedulerState.currentPage) || 0;
      this.detectedMaxPage = Number(schedulerState.detectedMaxPage) || 0;
      this.currentCycleScannedRows = Number(schedulerState.currentCycleScannedRows) || 0;
      this.currentCycleMatchedRows = Number(schedulerState.currentCycleMatchedRows) || 0;
      this.currentCycleBanSuccessCount = Number(schedulerState.currentCycleBanSuccessCount) || 0;
      this.currentCycleBanFailureCount = Number(schedulerState.currentCycleBanFailureCount) || 0;
      this.currentCycleBaselineMaxBlockDataNum = Number(schedulerState.currentCycleBaselineMaxBlockDataNum) || 0;
      this.cycleCount = Number(schedulerState.cycleCount) || 0;
      this.lastRunAt = schedulerState.lastRunAt || '';
      this.nextRunAt = schedulerState.nextRunAt || '';
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = normalizeConfig({
        ...this.config,
        ...(schedulerState.config || {}),
      });
    } catch (error) {
      console.error('[HanRefreshIpBanScheduler] 상태 복원 실패:', error.message);
    }
  }

  ensureRunLoop() {
    if (!this.isRunning || this.runPromise) {
      return;
    }

    this.runPromise = this.run().finally(() => {
      this.runPromise = null;
    });
  }

  async resumeIfNeeded() {
    if (this.runPromise) {
      return;
    }

    await this.loadState();
    if (this.isRunning) {
      this.log('🔁 저장된 도배기 갱신 차단 자동 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      phase: this.phase,
      currentPage: this.currentPage,
      detectedMaxPage: this.detectedMaxPage,
      currentCycleScannedRows: this.currentCycleScannedRows,
      currentCycleMatchedRows: this.currentCycleMatchedRows,
      currentCycleBanSuccessCount: this.currentCycleBanSuccessCount,
      currentCycleBanFailureCount: this.currentCycleBanFailureCount,
      currentCycleBaselineMaxBlockDataNum: this.currentCycleBaselineMaxBlockDataNum,
      cycleCount: this.cycleCount,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }
}

function resetCycleMetrics(scheduler) {
  scheduler.currentPage = 0;
  scheduler.detectedMaxPage = 0;
  scheduler.currentCycleScannedRows = 0;
  scheduler.currentCycleMatchedRows = 0;
  scheduler.currentCycleBanSuccessCount = 0;
  scheduler.currentCycleBanFailureCount = 0;
  scheduler.currentCycleBaselineMaxBlockDataNum = 0;
}

function normalizeDetectedMaxPage(value, fallbackMaxPage) {
  const page = Number(value) || 0;
  if (page > 0) {
    return page;
  }

  return Math.max(1, Number(fallbackMaxPage) || DEFAULT_CONFIG.fallbackMaxPage);
}

function normalizeConfig(config = {}) {
  const normalizedAvoidReasonText = normalizeAvoidReasonText(config.avoidReasonText);
  return {
    galleryId: String(config.galleryId || DEFAULT_CONFIG.galleryId).trim() || DEFAULT_CONFIG.galleryId,
    galleryType: String(config.galleryType || DEFAULT_CONFIG.galleryType).trim() || DEFAULT_CONFIG.galleryType,
    baseUrl: String(config.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    requestDelay: getRequestDelayMs(config),
    fallbackMaxPage: Math.max(1, Number(config.fallbackMaxPage) || DEFAULT_CONFIG.fallbackMaxPage),
    cycleIntervalMs: getCycleIntervalMs(config),
    avoidHour: String(config.avoidHour || DEFAULT_CONFIG.avoidHour),
    avoidReason: String(config.avoidReason || DEFAULT_CONFIG.avoidReason),
    avoidReasonText: normalizedAvoidReasonText,
  };
}

function normalizeAvoidReasonText(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '도배' || normalized === '도배기') {
    return DEFAULT_CONFIG.avoidReasonText;
  }
  return normalized;
}

function getRequestDelayMs(config = {}) {
  return Math.max(0, Number(config.requestDelay) || 0);
}

function getCycleIntervalMs(config = {}) {
  return Math.max(1000, Number(config.cycleIntervalMs) || DEFAULT_CONFIG.cycleIntervalMs);
}

function normalizePhase(value) {
  return Object.values(PHASE).includes(value) ? value : PHASE.IDLE;
}

function parseTimestamp(value) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTimestamp(value) {
  const parsed = parseTimestamp(value);
  if (parsed <= 0) {
    return '-';
  }

  return new Date(parsed).toLocaleString('ko-KR', { hour12: false });
}

async function delayWhileRunning(scheduler, waitMs) {
  const remainingMs = Math.max(0, Number(waitMs) || 0);
  if (remainingMs <= 0) {
    return;
  }

  let elapsedMs = 0;
  while (scheduler.isRunning && elapsedMs < remainingMs) {
    const chunkMs = Math.min(1000, remainingMs - elapsedMs);
    await scheduler.delayFn(chunkMs);
    elapsedMs += chunkMs;
  }
}

export {
  PHASE,
  Scheduler,
  normalizeConfig,
  normalizeDetectedMaxPage,
  parseTimestamp,
  resetCycleMetrics,
};
