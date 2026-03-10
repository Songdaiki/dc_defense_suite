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
        if (decision === 'review') {
          return record.decision === 'review' || record.status === 'pending';
        }
        return record.decision === decision;
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
    publicTitle: rawTitle || '(제목 없음)',
    publicBody: normalizeOptionalString(input.publicBody) || '',
    reportReason: normalizeOptionalString(input.reportReason),
    decision: normalizeDecision(input.decision),
    confidence: normalizeNullableNumber(input.confidence),
    policyIds: normalizePolicyIds(input.policyIds || input.policy_ids),
    reason: normalizeOptionalString(input.reason),
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

export {
  createModerationRecordStore,
  normalizePublicModerationRecord,
};
