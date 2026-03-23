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

  async listRecords(filters = {}) {
    await this.init();
    const decision = normalizeOptionalString(filters.decision).toLowerCase();
    const policyId = normalizeOptionalString(filters.policyId).toUpperCase();
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
    const offset = Math.max(0, Number(filters.cursor) || 0);

    let records = this.records;
    if (decision) {
      records = records.filter((record) => {
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
      records = records.filter((record) => Array.isArray(record.policyIds) && record.policyIds.includes(policyId));
    }

    const sliced = records.slice(offset, offset + limit);
    const nextCursor = offset + limit < records.length ? String(offset + limit) : '';

    return {
      total: records.length,
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

      if (String(record?.status || '').trim().toLowerCase() === 'completed'
        && String(record?.decision || '').trim().toLowerCase() === 'allow') {
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
    const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
    const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
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
