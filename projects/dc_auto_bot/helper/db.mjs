import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const VALID_DECISIONS = new Set(['allow', 'deny', 'review']);
const VALID_STATUSES = new Set(['pending', 'completed', 'failed']);
function createModerationRecordStore(filePath) {
  return new ModerationRecordStore(filePath);
}

class ModerationRecordStore {
  constructor(filePath) {
    this.filePath = resolve(filePath);
    this.records = [];
    this.loaded = false;
    this.writePromise = Promise.resolve();
  }

  async init() {
    if (this.loaded) {
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    let rawText = '';
    try {
      rawText = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    const lines = String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    this.records = lines
      .map((line) => safeParseJson(line))
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => normalizePublicModerationRecord(entry))
      .filter((entry) => entry && isPersistablePublicRecord(entry));

    sortRecordsDescending(this.records);
    this.loaded = true;
  }

  async upsertRecord(input) {
    await this.init();
    const nextRecord = normalizePublicModerationRecord(input);
    if (!nextRecord || !isPersistablePublicRecord(nextRecord)) {
      throw new Error('공개 moderation record 형식이 올바르지 않습니다.');
    }
    const existingIndex = this.records.findIndex((record) => record.id === nextRecord.id);
    let finalRecord = nextRecord;

    if (existingIndex >= 0) {
      const merged = normalizePublicModerationRecord({
        ...this.records[existingIndex],
        ...nextRecord,
        id: this.records[existingIndex].id,
        createdAt: this.records[existingIndex].createdAt || nextRecord.createdAt,
      });
      this.records[existingIndex] = merged;
      finalRecord = merged;
    } else {
      this.records.unshift(nextRecord);
    }

    sortRecordsDescending(this.records);
    await this.persist();
    return finalRecord;
  }

  async getRecord(recordId) {
    await this.init();
    const normalizedId = String(recordId || '').trim();
    if (!normalizedId) {
      return null;
    }

    return this.records.find((record) => record.id === normalizedId) || null;
  }

  async findLatestPendingRecord(filters = {}) {
    await this.init();
    const source = normalizeOptionalString(filters.source) || 'auto_report';
    const targetUrl = normalizeOptionalString(filters.targetUrl);
    const targetPostNo = normalizeOptionalString(filters.targetPostNo);
    const staleBeforeIso = normalizeIsoDate(filters.staleBeforeIso);

    const pendingRecords = this.records.filter((record) => {
      if (normalizeOptionalString(record?.source) !== source) {
        return false;
      }
      if (normalizeStatus(record?.status) !== 'pending') {
        return false;
      }

      const recordUpdatedAt = normalizeIsoDate(record?.updatedAt) || normalizeIsoDate(record?.createdAt);
      if (staleBeforeIso && recordUpdatedAt && recordUpdatedAt < staleBeforeIso) {
        return false;
      }

      const recordTargetUrl = normalizeOptionalString(record?.targetUrl);
      const recordTargetPostNo = normalizeOptionalString(record?.targetPostNo);

      if (targetUrl && recordTargetUrl) {
        return recordTargetUrl === targetUrl;
      }

      if (targetPostNo && recordTargetPostNo) {
        return recordTargetPostNo === targetPostNo;
      }

      return false;
    });

    const latestPendingRecord = pendingRecords[0] || null;
    if (!latestPendingRecord) {
      return null;
    }

    const targetKey = buildRecordTargetKey(latestPendingRecord);
    if (!targetKey) {
      return latestPendingRecord;
    }

    let latestTerminalUpdatedAt = '';
    for (const record of this.records) {
      if (normalizeOptionalString(record?.source) !== source) {
        continue;
      }
      const status = normalizeStatus(record?.status);
      if (status !== 'completed' && status !== 'failed') {
        continue;
      }
      if (buildRecordTargetKey(record) !== targetKey) {
        continue;
      }

      const terminalUpdatedAt = getRecordUpdatedAt(record);
      if (compareRecordTimestamp(terminalUpdatedAt, latestTerminalUpdatedAt) > 0) {
        latestTerminalUpdatedAt = terminalUpdatedAt;
      }
    }

    if (compareRecordTimestamp(latestTerminalUpdatedAt, getRecordUpdatedAt(latestPendingRecord)) >= 0) {
      return null;
    }

    return latestPendingRecord;
  }

  async markStalePendingAsFailed(filters = {}) {
    await this.init();
    const source = normalizeOptionalString(filters.source) || 'auto_report';
    const staleBeforeIso = normalizeIsoDate(filters.staleBeforeIso);
    const reason = normalizeOptionalString(filters.reason) || '자동 처리 중단: stale pending 정리';
    if (!staleBeforeIso) {
      return { updatedCount: 0 };
    }

    let updatedCount = 0;
    this.records = this.records.map((record) => {
      if (normalizeOptionalString(record?.source) !== source) {
        return record;
      }
      if (normalizeStatus(record?.status) !== 'pending') {
        return record;
      }

      const recordUpdatedAt = normalizeIsoDate(record?.updatedAt) || normalizeIsoDate(record?.createdAt);
      if (!recordUpdatedAt || recordUpdatedAt >= staleBeforeIso) {
        return record;
      }

      updatedCount += 1;
      return normalizePublicModerationRecord({
        ...record,
        status: 'failed',
        reason,
        updatedAt: recordUpdatedAt,
      });
    });

    if (updatedCount > 0) {
      sortRecordsDescending(this.records);
      await this.persist();
    }

    return { updatedCount };
  }

  async listRecords(filters = {}) {
    await this.init();
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
    const offset = Math.max(0, Number(filters.cursor) || 0);

    const records = filterRecords(collapseDuplicatePendingForList(this.records), filters);

    const sliced = records.slice(offset, offset + limit);
    const nextCursor = offset + limit < records.length ? String(offset + limit) : '';

    return {
      total: records.length,
      stats: summarizeDecisionCounts(records),
      records: sliced,
      nextCursor,
    };
  }

  async getReporterRanking(limit = 3) {
    await this.init();
    const maxEntries = Math.max(1, Math.min(20, Number(limit) || 3));
    const rankingMap = new Map();

    for (const record of this.records) {
      if (String(record?.source || '').trim() !== 'auto_report') {
        continue;
      }

      const reporterUserId = normalizeOptionalString(record?.reporterUserId);
      if (!reporterUserId) {
        continue;
      }

      const existing = rankingMap.get(reporterUserId) || {
        reporterUserId,
        reporterLabel: '',
        totalReports: 0,
        allowCount: 0,
        lastReportedAt: '',
      };

      existing.totalReports += 1;

      if (
        (
          String(record?.status || '').trim().toLowerCase() === 'completed'
          && String(record?.decision || '').trim().toLowerCase() === 'allow'
        )
        || isLikelyAlreadyProcessedPost(record)
      ) {
        existing.allowCount += 1;
      }

      const candidateLabel = normalizeOptionalString(record?.reporterLabel);
      const candidateTime = normalizeIsoDate(record?.updatedAt) || normalizeIsoDate(record?.createdAt);
      const currentTime = normalizeIsoDate(existing.lastReportedAt);

      if (!existing.reporterLabel || (candidateLabel && candidateTime && candidateTime > (currentTime || ''))) {
        existing.reporterLabel = candidateLabel || existing.reporterLabel || reporterUserId;
      }

      if (!existing.lastReportedAt || (candidateTime && candidateTime > existing.lastReportedAt)) {
        existing.lastReportedAt = candidateTime || existing.lastReportedAt;
      }

      rankingMap.set(reporterUserId, existing);
    }

    return Array.from(rankingMap.values())
      .sort(compareReporterRanking)
      .slice(0, maxEntries);
  }

  async persist() {
    this.records = this.records.filter((record) => isPersistablePublicRecord(record));
    const serialized = this.records.map((record) => JSON.stringify(record)).join('\n');
    this.writePromise = this.writePromise.then(() => writeFile(this.filePath, serialized ? `${serialized}\n` : '', 'utf8'));
    await this.writePromise;
  }
}

function normalizePublicModerationRecord(input) {
  const source = normalizeOptionalString(input.source);
  if (source && source !== 'auto_report' && source !== 'manual_test') {
    return null;
  }

  const createdAt = normalizeIsoDate(input.createdAt) || new Date().toISOString();
  const updatedAt = normalizeIsoDate(input.updatedAt) || new Date().toISOString();
  const rawTitle = normalizeOptionalString(input.publicTitle) || normalizeOptionalString(input.title);

  return {
    id: String(input.id || randomUUID()).trim() || randomUUID(),
    createdAt,
    updatedAt,
    source: source || 'auto_report',
    decisionSource: normalizeOptionalString(input.decisionSource) || 'gemini',
    status: normalizeStatus(input.status) || 'completed',
    targetUrl: normalizeOptionalString(input.targetUrl),
    targetPostNo: normalizeOptionalString(input.targetPostNo),
    reporterUserId: normalizeOptionalString(input.reporterUserId),
    reporterLabel: normalizeOptionalString(input.reporterLabel),
    publicTitle: rawTitle || '(제목 없음)',
    publicBody: normalizeOptionalString(input.publicBody) || '',
    reportReason: normalizeOptionalString(input.reportReason),
    decision: normalizeDecision(input.decision),
    confidence: normalizeNullableNumber(input.confidence),
    policyIds: normalizePolicyIds(input.policyIds || input.policy_ids),
    reason: normalizeOptionalString(input.reason),
    debugFailureType: normalizeOptionalString(input.debugFailureType),
    debugFailureStatus: normalizeNullableNumber(input.debugFailureStatus),
    debugFailureMessage: normalizeOptionalString(input.debugFailureMessage),
    debugFailureRawText: normalizeOptionalString(input.debugFailureRawText),
    debugRecoveryAttempted: input.debugRecoveryAttempted === true,
    debugRecoveredByLoginRetry: input.debugRecoveredByLoginRetry === true,
    blurredThumbnailPath: normalizePublicAssetPath(input.blurredThumbnailPath),
    imageCount: normalizeImageCount(input.imageCount ?? input.imageUrls?.length),
  };
}

function normalizeIsoDate(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString();
}

function normalizeDecision(value) {
  const text = String(value || '').trim().toLowerCase();
  return VALID_DECISIONS.has(text) ? text : '';
}

function normalizeStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  return VALID_STATUSES.has(text) ? text : '';
}

function normalizeOptionalString(value) {
  return String(value || '').trim();
}

function normalizePublicAssetPath(value) {
  const text = normalizeOptionalString(value);
  if (!text.startsWith('/transparency-assets/')) {
    return '';
  }

  return text;
}

function normalizePolicyIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean),
  )];
}

function filterRecords(records, filters = {}) {
  const decision = normalizeOptionalString(filters.decision).toLowerCase();
  const policyId = normalizeOptionalString(filters.policyId).toUpperCase();

  let filtered = Array.isArray(records) ? records : [];
  if (decision) {
    filtered = filtered.filter((record) => {
      if (record.decision === decision) {
        return true;
      }

      if (decision === 'review' && record.status === 'pending') {
        return true;
      }

      return false;
    });
  }
  if (policyId) {
    filtered = filtered.filter((record) => Array.isArray(record.policyIds) && record.policyIds.includes(policyId));
  }
  return filtered;
}

function collapseDuplicatePendingForList(records) {
  const inputRecords = Array.isArray(records) ? records : [];
  const groupMetaMap = new Map();

  for (const record of inputRecords) {
    if (!shouldCollapseAutoReportPending(record)) {
      continue;
    }

    const key = buildRecordTargetKey(record);
    if (!key) {
      continue;
    }

    const meta = groupMetaMap.get(key) || {
      latestPendingId: '',
      latestPendingUpdatedAt: '',
      latestCompletedUpdatedAt: '',
      latestTerminalUpdatedAt: '',
    };
    const status = normalizeStatus(record?.status);
    if (status === 'pending') {
      const candidateUpdatedAt = getRecordUpdatedAt(record);
      if (
        !meta.latestPendingId
        || compareRecordTimestamp(candidateUpdatedAt, meta.latestPendingUpdatedAt) > 0
      ) {
        meta.latestPendingId = String(record?.id || '').trim();
        meta.latestPendingUpdatedAt = candidateUpdatedAt;
      }
    } else if (status === 'completed' || status === 'failed') {
      const terminalUpdatedAt = getRecordUpdatedAt(record);
      if (compareRecordTimestamp(terminalUpdatedAt, meta.latestTerminalUpdatedAt) > 0) {
        meta.latestTerminalUpdatedAt = terminalUpdatedAt;
      }
      if (status === 'completed' && compareRecordTimestamp(terminalUpdatedAt, meta.latestCompletedUpdatedAt) > 0) {
        meta.latestCompletedUpdatedAt = terminalUpdatedAt;
      }
    }

    groupMetaMap.set(key, meta);
  }

  return inputRecords.filter((record) => {
    if (!shouldCollapseAutoReportPending(record)) {
      return true;
    }

    const key = buildRecordTargetKey(record);
    if (!key) {
      return true;
    }

    const status = normalizeStatus(record?.status);
    if (status === 'failed' && isTransientCleanupFailed(record)) {
      const meta = groupMetaMap.get(key);
      if (!meta) {
        return true;
      }
      return !meta.latestCompletedUpdatedAt;
    }

    if (status !== 'pending') {
      return true;
    }

    const meta = groupMetaMap.get(key);
    if (!meta) {
      return true;
    }

    if (compareRecordTimestamp(meta.latestTerminalUpdatedAt, meta.latestPendingUpdatedAt) >= 0) {
      return false;
    }

    return String(record?.id || '').trim() === meta.latestPendingId;
  });
}

function getRecordUpdatedAt(record) {
  if (isTransientCleanupFailed(record)) {
    return normalizeIsoDate(record?.createdAt) || normalizeIsoDate(record?.updatedAt);
  }
  return normalizeIsoDate(record?.updatedAt) || normalizeIsoDate(record?.createdAt);
}

function summarizeDecisionCounts(records) {
  let allow = 0;
  let deny = 0;
  let review = 0;
  let filtered = 0;
  let forced = 0;

  for (const record of records) {
    const status = String(record?.status || '').trim().toLowerCase();
    if (status === 'pending') {
      review += 1;
      continue;
    }
    if (status === 'failed') {
      if (isLikelyAlreadyProcessedPost(record)) {
        allow += 1;
        continue;
      }
      if (isProcessingExcluded(record)) {
        filtered += 1;
        continue;
      }
      if (isInternalErrorFailed(record)) {
        forced += 1;
        continue;
      }
      continue;
    }

    const decision = String(record?.decision || '').trim().toLowerCase();
    if (decision === 'allow') allow += 1;
    else if (decision === 'deny') deny += 1;
    else if (decision === 'review') review += 1;
  }

  return { allow, deny, review, filtered, forced };
}

function isLikelyAlreadyProcessedPost(record) {
  const status = String(record?.status || '').trim().toLowerCase();
  if (status !== 'failed') {
    return false;
  }

  const rawBody = String(record?.publicBody || '').trim();
  if (rawBody) {
    return false;
  }

  const rawReason = String(record?.reason || '').trim();
  return rawReason.startsWith('작성자 판정 실패:')
    && (
      rawReason.includes('본문 작성자 메타를 찾지 못했습니다.')
      || rawReason.includes('작성자 uid/ip를 모두 확인하지 못했습니다.')
    );
}

function isAuthorFilterFailed(record) {
  const rawReason = String(record?.reason || '').trim();
  return rawReason.startsWith('v2 core 작성자 필터 미통과:');
}

function isRecentWindowExcluded(record) {
  const rawReason = String(record?.reason || '').trim();
  return rawReason === '최근 100개 regular row 밖 게시물입니다.';
}

function isProcessingExcluded(record) {
  return isAuthorFilterFailed(record) || isRecentWindowExcluded(record);
}

function isInternalErrorFailed(record) {
  const rawReason = String(record?.reason || '').trim();
  return !isKnownFailedReason(rawReason);
}

function isTransientCleanupFailed(record) {
  const status = String(record?.status || '').trim().toLowerCase();
  if (status !== 'failed') {
    return false;
  }

  const rawReason = String(record?.reason || '').trim();
  return rawReason === '자동 처리 중단: 확장 재시작/중지/abort'
    || rawReason === '자동 처리 중단: stale pending 정리';
}

function isKnownFailedReason(rawReason) {
  if (!rawReason) return false;
  if (rawReason.startsWith('작성자 판정 실패:')) return true;
  if (rawReason.startsWith('v2 core 작성자 필터 미통과:')) return true;
  if (rawReason.startsWith('개념글 판정 실패:')) return true;
  if (rawReason === '개념글은 자동 삭제/차단하지 않습니다.') return true;
  if (rawReason.startsWith('최근 100개 판정 실패:')) return true;
  if (rawReason === '최근 100개 regular row 밖 게시물입니다.') return true;
  if (rawReason === 'CLI helper endpoint 형식이 올바르지 않습니다.') return true;
  if (rawReason === 'CLI helper endpoint는 http://localhost 또는 http://127.0.0.1 주소만 허용됩니다.') return true;
  if (rawReason === 'CLI helper endpoint는 localhost 계열 주소만 허용됩니다.') return true;
  if (rawReason.startsWith('CLI helper 연결 실패:')) return true;
  if (rawReason === 'CLI helper 응답 대기 시간이 초과되었습니다.') return true;
  if (rawReason === 'CLI helper 응답 JSON 파싱 실패') return true;
  if (rawReason === 'decision 값이 올바르지 않습니다.') return true;
  if (rawReason === 'confidence 값이 올바르지 않습니다.') return true;
  if (rawReason === 'policy_ids가 비어 있습니다.') return true;
  if (rawReason === 'policy_ids에 허용되지 않은 값이 포함되어 있습니다.') return true;
  if (rawReason === 'reason 값이 비어 있습니다.') return true;
  if (rawReason === 'policy_ids에 NONE과 다른 정책이 동시에 포함될 수 없습니다.') return true;
  if (rawReason === 'policy_ids가 ["NONE"]이면 decision은 deny여야 합니다.') return true;
  if (rawReason === 'P15 단독 allow는 자동 삭제/차단 대상으로 처리할 수 없습니다.') return true;
  if (rawReason === 'allow 결정에는 최소 1개 이상의 정책 ID가 필요합니다.') return true;
  if (rawReason === 'CLI helper 판정 실패') return true;
  if (rawReason === '자동 처리 중단: 확장 재시작/중지/abort') return true;
  if (rawReason === '자동 처리 중단: stale pending 정리') return true;
  if (rawReason.includes('후 처리 실패:')) return true;
  return false;
}

function shouldCollapseAutoReportPending(record) {
  return normalizeOptionalString(record?.source) === 'auto_report';
}

function buildRecordTargetKey(record) {
  const targetUrl = normalizeOptionalString(record?.targetUrl);
  if (targetUrl) {
    return `url:${targetUrl}`;
  }

  const targetPostNo = normalizeOptionalString(record?.targetPostNo);
  if (targetPostNo) {
    return `post:${targetPostNo}`;
  }

  return '';
}

function compareRecordTimestamp(left, right) {
  const leftTime = Date.parse(String(left || ''));
  const rightTime = Date.parse(String(right || ''));

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    if (leftTime > rightTime) return 1;
    if (leftTime < rightTime) return -1;
    return 0;
  }
  if (Number.isFinite(leftTime)) {
    return 1;
  }
  if (Number.isFinite(rightTime)) {
    return -1;
  }
  return 0;
}

function normalizeNullableNumber(value) {
  if (value === '' || value == null) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeImageCount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }

  return Math.max(0, Math.floor(numericValue));
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sortRecordsDescending(records) {
  records.sort((left, right) => {
    const leftTime = Date.parse(getRecordUpdatedAt(left) || 0);
    const rightTime = Date.parse(getRecordUpdatedAt(right) || 0);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return String(right.id || '').localeCompare(String(left.id || ''));
  });
}

function isPersistablePublicRecord(record) {
  if (!record || !record.id || !record.reason) {
    return false;
  }

  if (record.status === 'pending' || record.status === 'failed') {
    return true;
  }

  return Boolean(record.decision);
}

function compareReporterRanking(left, right) {
  const leftTotalReports = Math.max(0, Number(left?.totalReports) || 0);
  const rightTotalReports = Math.max(0, Number(right?.totalReports) || 0);
  if (rightTotalReports !== leftTotalReports) {
    return rightTotalReports - leftTotalReports;
  }

  const leftAllowCount = Math.max(0, Number(left?.allowCount) || 0);
  const rightAllowCount = Math.max(0, Number(right?.allowCount) || 0);
  if (rightAllowCount !== leftAllowCount) {
    return rightAllowCount - leftAllowCount;
  }

  const leftLastReportedAt = Date.parse(String(left?.lastReportedAt || ''));
  const rightLastReportedAt = Date.parse(String(right?.lastReportedAt || ''));
  if (Number.isFinite(rightLastReportedAt) && Number.isFinite(leftLastReportedAt) && rightLastReportedAt !== leftLastReportedAt) {
    return rightLastReportedAt - leftLastReportedAt;
  }

  if (Number.isFinite(rightLastReportedAt) && !Number.isFinite(leftLastReportedAt)) {
    return 1;
  }

  if (!Number.isFinite(rightLastReportedAt) && Number.isFinite(leftLastReportedAt)) {
    return -1;
  }

  return String(left?.reporterUserId || '').localeCompare(String(right?.reporterUserId || ''));
}

export {
  createModerationRecordStore,
  normalizePublicModerationRecord,
};
