import {
  DEFAULT_CONFIG,
  banPosts,
  delay,
  fetchBlockListHTML,
  fetchTargetListHTML,
  releaseBan,
} from './api.js';

import {
  parseBlockListRows,
  parseTargetPosts,
} from './parser.js';
import { parseBoardPosts } from '../post/parser.js';

const STORAGE_KEY = 'ipBanSchedulerState';

class Scheduler {
  constructor() {
    this.isRunning = false;
    this.isReleaseRunning = false;
    this.runPromise = null;
    this.currentPage = 0;
    this.totalBanned = 0;
    this.totalReleased = 0;
    this.cycleCount = 0;
    this.logs = [];
    this.currentRunId = '';
    this.activeBans = [];

    this.config = {
      galleryId: DEFAULT_CONFIG.galleryId,
      galleryType: DEFAULT_CONFIG.galleryType,
      headtextId: DEFAULT_CONFIG.headtextId,
      headtextName: DEFAULT_CONFIG.headtextName,
      minPage: 1,
      maxPage: 5,
      requestDelay: 500,
      cycleDelay: 1000,
      cutoffPostNo: 0,
      banBatchSize: DEFAULT_CONFIG.banBatchSize,
      releaseScanMaxPages: 40,
      releaseRequestDelay: 100,
      avoidHour: DEFAULT_CONFIG.avoidHour,
      avoidReason: DEFAULT_CONFIG.avoidReason,
      avoidReasonText: DEFAULT_CONFIG.avoidReasonText,
      delChk: DEFAULT_CONFIG.delChk,
      avoidTypeChk: DEFAULT_CONFIG.avoidTypeChk,
    };
  }

  async start(options = {}) {
    if (this.isRunning) {
      this.log('⚠️ 이미 실행 중입니다.');
      return;
    }

    const normalizedOptions = normalizeStartOptions(options);
    const cutoffPostNo = normalizedOptions.hasExplicitCutoff
      ? normalizedOptions.cutoffPostNo
      : await this.captureCutoffPostNoWithRetry();

    if (normalizedOptions.source === 'monitor' && cutoffPostNo <= 0) {
      throw new Error('IP 차단 cutoff snapshot 추출에 실패했습니다.');
    }

    this.currentPage = 0;
    this.config.cutoffPostNo = cutoffPostNo;
    this.config.delChk = normalizedOptions.delChk;
    this.isRunning = true;
    this.currentRunId = createRunId();
    this.log(`🧷 ${getCutoffSourceLabel(normalizedOptions.source)} cutoff 저장 (#${cutoffPostNo})`);
    this.log(`🗑️ 게시물 삭제 요청 설정: del_chk=${this.config.delChk ? '1' : '0'}`);
    this.log(`🟢 자동 차단 시작! (runId=${this.currentRunId})`);
    await this.saveState();
    this.ensureRunLoop();
  }

  async stop() {
    this.isRunning = false;
    this.currentPage = 0;
    this.log('🔴 자동 차단 중지.');
    await this.saveState();
  }

  async captureCutoffPostNo() {
    let maxPostNo = 0;
    const [minPage, maxPage] = getNormalizedPageRange(this.config);

    for (let page = minPage; page <= maxPage; page += 1) {
      const html = await fetchTargetListHTML(this.config, page);
      const posts = parseBoardPosts(html);
      maxPostNo = Math.max(maxPostNo, getMaxPostNo(posts));
    }

    return maxPostNo;
  }

  async captureCutoffPostNoWithRetry() {
    try {
      const cutoffPostNo = await this.captureCutoffPostNo();
      if (cutoffPostNo > 0) {
        return cutoffPostNo;
      }

      this.log('⚠️ IP 차단 cutoff snapshot 추출 실패, 1000ms 후 1회 재시도');
      await delay(1000);
      return await this.captureCutoffPostNo();
    } catch (error) {
      this.log(`⚠️ IP 차단 cutoff snapshot 추출 오류, 1000ms 후 1회 재시도 - ${error.message}`);
      await delay(1000);
      return await this.captureCutoffPostNo();
    }
  }

  async releaseTrackedBans(options = {}) {
    if (this.isRunning) {
      return {
        success: false,
        message: '자동 차단 실행 중에는 해제를 시작할 수 없습니다.',
      };
    }

    if (this.isReleaseRunning) {
      return {
        success: false,
        message: '이미 해제 작업이 진행 중입니다.',
      };
    }

    this.expireStaleBans();
    const normalizedOptions = normalizeReleaseOptions(options);
    const targets = this.activeBans.filter((entry) => {
      if (!isBanActive(entry)) {
        return false;
      }

      if (!normalizedOptions.runId) {
        return true;
      }

      return entry.runId === normalizedOptions.runId;
    });
    if (targets.length === 0) {
      this.log(
        normalizedOptions.runId
          ? `ℹ️ runId=${normalizedOptions.runId} 해제 대상이 없습니다.`
          : 'ℹ️ 해제할 활성 차단 내역이 없습니다.',
      );
      await this.saveState();
      return {
        success: true,
        releasedCount: 0,
        missingCount: 0,
      };
    }

    this.isReleaseRunning = true;
    await this.saveState();

    try {
      this.log(
        normalizedOptions.runId
          ? `🔍 runId=${normalizedOptions.runId} 활성 차단 ${targets.length}건 해제용 내부 ID 탐색 시작`
          : `🔍 활성 차단 ${targets.length}건 해제용 내부 ID 탐색 시작`,
      );
      const matchResult = await this.findReleaseTargets(targets);
      const matches = matchResult.matches;
      const missingEntries = matchResult.missingEntries;

      if (missingEntries.length > 0) {
        this.log(`⚠️ 해제 ID를 못 찾은 대상 ${missingEntries.length}건`);
      }

      let releasedCount = 0;
      let failedReleaseCount = 0;

      for (const match of matches) {
        const result = await releaseBan(this.config, {
          releaseId: match.releaseId,
          ano: match.row.ano,
        });
        if (result.success) {
          this.markBanReleased(match.entry.id, match.releaseId);
          releasedCount += 1;
          this.totalReleased += 1;
          this.log(`✅ 해제 완료 #${match.entry.postNo} -> ${match.releaseId}`);
        } else {
          failedReleaseCount += 1;
          this.log(`❌ 해제 실패 #${match.entry.postNo} -> ${result.message}`);
        }

        await this.saveState();

        if (this.config.releaseRequestDelay > 0) {
          await delay(this.config.releaseRequestDelay);
        }
      }

      if (releasedCount === 0 && missingEntries.length === 0) {
        this.log('ℹ️ 해제 가능한 활성 차단이 없었습니다.');
      }

      return {
        success: failedReleaseCount === 0 && missingEntries.length === 0,
        releasedCount,
        failedReleaseCount,
        missingCount: missingEntries.length,
        message: summarizeReleaseResult(releasedCount, failedReleaseCount, missingEntries.length),
      };
    } finally {
      this.isReleaseRunning = false;
      await this.saveState();
    }
  }

  async run() {
    while (this.isRunning) {
      try {
        this.expireStaleBans();
        const [minPage, maxPage] = getNormalizedPageRange(this.config);
        const startPage = this.currentPage > 0 ? this.currentPage : minPage;

        for (let page = startPage; page <= maxPage; page += 1) {
          if (!this.isRunning) {
            break;
          }

          this.currentPage = page;
          await this.saveState();

          this.log(`📄 대상 탭 ${page}페이지 로딩...`);
          const html = await fetchTargetListHTML(this.config, page);
          const posts = parseTargetPosts(html, this.config.headtextName || '');
          const uniquePosts = dedupeBanCandidates(posts);
          const cutoffPosts = uniquePosts.filter((post) => isPostAfterCutoff(post, this.config.cutoffPostNo));
          const candidates = cutoffPosts.filter((post) => !this.hasActiveBanForPost(post));

          this.log(
            `📄 ${page}페이지: 유동 ${posts.length}개, 고유 후보 ${uniquePosts.length}개, `
            + `cutoff 이후 ${cutoffPosts.length}개, 신규 차단 후보 ${candidates.length}개`,
          );

          if (candidates.length > 0) {
            await this.processBanCandidates(candidates);
          }

          await this.saveState();

          if (this.config.requestDelay > 0) {
            await delay(this.config.requestDelay);
          }
        }

        if (this.isRunning) {
          this.cycleCount += 1;
          this.currentPage = 0;
          this.log(`🔄 사이클 #${this.cycleCount} 완료. ${this.config.cycleDelay}ms 후 재시작...`);
          await this.saveState();
          await delay(this.config.cycleDelay);
        }
      } catch (error) {
        this.log(`❌ 오류 발생: ${error.message}`);
        console.error('[Scheduler] run error:', error);
        await this.saveState();

        if (this.isRunning) {
          this.log('⏳ 10초 후 재시도...');
          await delay(10000);
        }
      }
    }

    await this.saveState();
  }

  async processBanCandidates(posts) {
    const postMap = new Map(posts.map((post) => [String(post.no), post]));
    const result = await banPosts(this.config, posts.map((post) => post.no));

    for (const successNo of result.successNos) {
      const post = postMap.get(String(successNo));
      if (!post) {
        continue;
      }

      const upsertResult = this.upsertBanEntry(post);
      if (upsertResult === 'inserted') {
        this.totalBanned += 1;
      }
    }

    if (result.successNos.length > 0) {
      this.log(`⛔ ${result.successNos.length}개 차단 완료 (총 ${this.totalBanned}건)`);
    }

    if (result.failedNos.length > 0) {
      this.log(`⚠️ ${result.failedNos.length}개 차단 실패 - ${result.failedNos.join(', ')}`);
      if (result.message) {
        this.log(`⚠️ 상세: ${result.message}`);
      }
    }
  }

  async findReleaseTargets(entries) {
    const pending = new Map();
    for (const entry of entries) {
      pending.set(String(entry.postNo), entry);
    }

    const matches = [];
    const seenPageSignatures = new Set();

    for (let page = 1; page <= this.config.releaseScanMaxPages; page += 1) {
      if (pending.size === 0) {
        break;
      }

      this.log(`🔍 차단 목록 ${page}페이지 스캔 중...`);
      const html = await fetchBlockListHTML(this.config, page);
      const rows = parseBlockListRows(html).filter((row) => row.releaseId);

      if (rows.length === 0) {
        break;
      }

      const signature = rows
        .slice(0, 5)
        .map((row) => `${row.postNo}:${row.releaseId}`)
        .join('|');

      if (seenPageSignatures.has(signature)) {
        break;
      }
      seenPageSignatures.add(signature);

      for (const row of rows) {
        const entry = pending.get(String(row.postNo));
        if (!entry) {
          continue;
        }

        if (entry.writerKey && row.writerKey && entry.writerKey !== row.writerKey) {
          continue;
        }

        matches.push({
          entry,
          releaseId: row.releaseId,
          row,
        });
        pending.delete(String(row.postNo));
      }
    }

    return {
      matches,
      missingEntries: [...pending.values()],
    };
  }

  hasActiveBanForPost(post) {
    this.expireStaleBans();
    const writerKey = String(post?.writerKey || '').trim();
    if (writerKey) {
      return this.activeBans.some(
        (entry) => isBanActive(entry) && entry.writerKey === writerKey,
      );
    }

    return this.activeBans.some(
      (entry) => isBanActive(entry) && String(entry.postNo) === String(post?.no),
    );
  }

  upsertBanEntry(post) {
    this.expireStaleBans();
    const nextEntry = createBanEntry(this.config, this.currentRunId, post);
    let replacedExisting = false;

    this.activeBans = this.activeBans.map((entry) => {
      const sameWriter = post.writerKey
        && entry.writerKey
        && entry.writerKey === post.writerKey
        && isBanActive(entry);

      if (!sameWriter) {
        return entry;
      }

      replacedExisting = true;
      return {
        ...entry,
        postNo: nextEntry.postNo,
        subject: nextEntry.subject,
        writerKey: nextEntry.writerKey,
        writerDisplay: nextEntry.writerDisplay,
        avoidHour: nextEntry.avoidHour,
        avoidReason: nextEntry.avoidReason,
        delChk: nextEntry.delChk,
        bannedAt: nextEntry.bannedAt,
        expiresAt: nextEntry.expiresAt,
        runId: nextEntry.runId,
        status: 'active',
        releaseId: '',
        releasedAt: '',
      };
    });

    if (!replacedExisting) {
      this.activeBans.unshift(nextEntry);
      return 'inserted';
    }

    this.log(`♻️ 중복 차단 갱신 #${post.no} (${post.writerDisplay})`);
    return 'updated';
  }

  markBanReleased(entryId, releaseId) {
    this.activeBans = this.activeBans.map((entry) => {
      if (entry.id !== entryId) {
        return entry;
      }

      return {
        ...entry,
        status: 'released',
        releaseId: String(releaseId),
        releasedAt: new Date().toISOString(),
      };
    });
  }

  expireStaleBans() {
    const now = Date.now();
    let expiredCount = 0;

    this.activeBans = this.activeBans.map((entry) => {
      if (!isBanActive(entry, now)) {
        if (entry.status === 'active') {
          expiredCount += 1;
          return {
            ...entry,
            status: 'expired',
          };
        }
      }
      return entry;
    });

    const normalized = normalizeTrackedBans(this.activeBans);
    if (normalized.changed) {
      this.activeBans = normalized.entries;
    }

    if (expiredCount > 0) {
      this.log(`ℹ️ 만료된 차단 내역 ${expiredCount}건을 정리했습니다.`);
    }

    if (normalized.collapsedCount > 0) {
      this.log(`ℹ️ 중복 활성 차단 ${normalized.collapsedCount}건을 최신 기록으로 정리했습니다.`);
    }
  }

  log(message) {
    const now = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    const entry = `[${now}] ${message}`;

    console.log(`[Scheduler] ${message}`);
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
          isReleaseRunning: this.isReleaseRunning,
          currentPage: this.currentPage,
          totalBanned: this.totalBanned,
          totalReleased: this.totalReleased,
          cycleCount: this.cycleCount,
          currentRunId: this.currentRunId,
          activeBans: this.activeBans,
          logs: this.logs.slice(0, 50),
          config: this.config,
        },
      });
    } catch (error) {
      console.error('[Scheduler] 상태 저장 실패:', error.message);
    }
  }

  async loadState() {
    try {
      const { [STORAGE_KEY]: schedulerState } = await chrome.storage.local.get(STORAGE_KEY);
      if (!schedulerState) {
        return;
      }

      this.isRunning = Boolean(schedulerState.isRunning);
      this.isReleaseRunning = false;
      this.currentPage = schedulerState.currentPage || 0;
      this.totalBanned = schedulerState.totalBanned || 0;
      this.totalReleased = schedulerState.totalReleased || 0;
      this.cycleCount = schedulerState.cycleCount || 0;
      this.currentRunId = schedulerState.currentRunId || '';
      this.activeBans = Array.isArray(schedulerState.activeBans) ? schedulerState.activeBans : [];
      this.logs = Array.isArray(schedulerState.logs) ? schedulerState.logs : [];
      this.config = { ...this.config, ...(schedulerState.config || {}) };
      this.expireStaleBans();
    } catch (error) {
      console.error('[Scheduler] 상태 복원 실패:', error.message);
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
      this.log('🔁 저장된 실행 상태 복원');
      this.ensureRunLoop();
    }
  }

  getStatus() {
    this.expireStaleBans();
    const activeBanCount = this.activeBans.filter((entry) => isBanActive(entry)).length;

    return {
      isRunning: this.isRunning,
      isReleaseRunning: this.isReleaseRunning,
      currentPage: this.currentPage,
      totalBanned: this.totalBanned,
      totalReleased: this.totalReleased,
      activeBanCount,
      cycleCount: this.cycleCount,
      currentRunId: this.currentRunId,
      logs: this.logs.slice(0, 20),
      config: this.config,
    };
  }
}

function createRunId() {
  return `run_${Date.now()}`;
}

function normalizeStartOptions(options = {}) {
  const source = String(options?.source || 'manual').trim() || 'manual';
  const rawCutoffPostNo = options?.cutoffPostNo;
  const hasExplicitCutoff = rawCutoffPostNo !== undefined && rawCutoffPostNo !== null && String(rawCutoffPostNo).trim() !== '';
  const cutoffPostNo = hasExplicitCutoff ? Number(rawCutoffPostNo) : 0;
  const hasExplicitDelChk = options?.delChk !== undefined;

  return {
    source,
    cutoffPostNo,
    hasExplicitCutoff: hasExplicitCutoff && Number.isFinite(cutoffPostNo),
    delChk: hasExplicitDelChk ? Boolean(options.delChk) : true,
  };
}

function getCutoffSourceLabel(source) {
  return source === 'monitor' ? '감시 자동화' : '수동 IP 차단';
}

function getNormalizedPageRange(config = {}) {
  const minPage = Math.max(1, Number(config.minPage) || 1);
  const maxPage = Math.max(minPage, Number(config.maxPage) || minPage);
  return [minPage, maxPage];
}

function getMaxPostNo(posts) {
  return posts.reduce((maxPostNo, post) => Math.max(maxPostNo, Number(post?.no) || 0), 0);
}

function isPostAfterCutoff(post, cutoffPostNo) {
  return Number(post?.no) > (Number(cutoffPostNo) || 0);
}

function normalizeReleaseOptions(options) {
  const runId = String(options?.runId || '').trim();
  return {
    runId,
  };
}

function createBanEntry(config, runId, post) {
  const now = new Date().toISOString();
  const expiresAt = computeExpiryAt(now, config.avoidHour);

  return {
    id: `ban_${Date.now()}_${post.no}`,
    runId,
    galleryId: config.galleryId,
    postNo: post.no,
    subject: post.subject,
    writerKey: post.writerKey,
    writerDisplay: post.writerDisplay,
    avoidHour: String(config.avoidHour),
    avoidReason: String(config.avoidReason),
    delChk: config.delChk ? 1 : 0,
    bannedAt: now,
    expiresAt,
    status: 'active',
    releaseId: '',
    releasedAt: '',
  };
}

function computeExpiryAt(bannedAtIso, avoidHour) {
  const start = new Date(bannedAtIso).getTime();
  const hours = Number(avoidHour) || 1;
  return new Date(start + hours * 60 * 60 * 1000).toISOString();
}

function isBanActive(entry, now = Date.now()) {
  if (!entry || entry.status !== 'active') {
    return false;
  }

  if (!entry.expiresAt) {
    return true;
  }

  const expiry = new Date(entry.expiresAt).getTime();
  if (Number.isNaN(expiry)) {
    return true;
  }

  return expiry > now;
}

function summarizeReleaseResult(releasedCount, failedReleaseCount, missingCount) {
  return `해제 ${releasedCount}건, 실패 ${failedReleaseCount}건, 미매칭 ${missingCount}건`;
}

function dedupeBanCandidates(posts) {
  const results = [];
  const seen = new Set();

  for (const post of posts) {
    const dedupeKey = getBanCandidateDedupeKey(post);
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    results.push(post);
  }

  return results;
}

function getBanCandidateDedupeKey(post) {
  if (post?.writerKey) {
    return `writer:${post.writerKey}`;
  }

  return `post:${String(post?.no ?? '')}`;
}

function normalizeTrackedBans(entries) {
  const nextEntries = [];
  const activeEntryIndexByWriter = new Map();
  let collapsedCount = 0;

  for (const entry of entries) {
    const dedupeKey = getActiveBanDedupeKey(entry);
    if (!dedupeKey) {
      nextEntries.push(entry);
      continue;
    }

    const existingIndex = activeEntryIndexByWriter.get(dedupeKey);
    if (existingIndex === undefined) {
      activeEntryIndexByWriter.set(dedupeKey, nextEntries.length);
      nextEntries.push(entry);
      continue;
    }

    nextEntries[existingIndex] = pickLatestBanEntry(nextEntries[existingIndex], entry);
    collapsedCount += 1;
  }

  return {
    entries: nextEntries,
    collapsedCount,
    changed: collapsedCount > 0,
  };
}

function getActiveBanDedupeKey(entry) {
  if (!entry || entry.status !== 'active' || !entry.writerKey) {
    return '';
  }

  return `writer:${entry.writerKey}`;
}

function pickLatestBanEntry(left, right) {
  const leftTime = getComparableTimestamp(left?.bannedAt);
  const rightTime = getComparableTimestamp(right?.bannedAt);

  if (rightTime > leftTime) {
    return right;
  }

  if (leftTime > rightTime) {
    return left;
  }

  return String(right?.postNo ?? '') >= String(left?.postNo ?? '') ? right : left;
}

function getComparableTimestamp(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export { Scheduler };
