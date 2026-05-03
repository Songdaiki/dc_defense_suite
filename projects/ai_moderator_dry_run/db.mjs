import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const VALID_DECISIONS = new Set(['allow', 'deny', 'review']);
const VALID_EFFECTIVE_DECISIONS = new Set(['action', 'no_action', 'review']);
const VALID_STATUSES = new Set(['completed', 'skipped', 'failed']);
const SOURCE = 'ai_moderator_dry_run';

function createDryRunRecordStore(filePath) {
  return new DryRunRecordStore(filePath);
}

class DryRunRecordStore {
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

    this.records = String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeParseJson(line))
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => normalizeDryRunRecord(entry))
      .filter(Boolean);

    sortRecordsDescending(this.records);
    this.loaded = true;
  }

  async upsertRecord(input) {
    await this.init();
    const nextRecord = normalizeDryRunRecord(input);
    if (!nextRecord) {
      throw new Error('dry-run record 형식이 올바르지 않습니다.');
    }

    const existingIndex = this.records.findIndex((record) => record.id === nextRecord.id);
    let finalRecord = nextRecord;
    if (existingIndex >= 0) {
      finalRecord = normalizeDryRunRecord({
        ...this.records[existingIndex],
        ...nextRecord,
        id: this.records[existingIndex].id,
        createdAt: this.records[existingIndex].createdAt || nextRecord.createdAt,
      });
      this.records[existingIndex] = finalRecord;
    } else {
      this.records.unshift(nextRecord);
    }

    sortRecordsDescending(this.records);
    await this.persist();
    return finalRecord;
  }

  async getRecord(recordId) {
    await this.init();
    const id = String(recordId || '').trim();
    return this.records.find((record) => record.id === id) || null;
  }

  async findByPostNo(postNo) {
    await this.init();
    const normalizedPostNo = String(postNo || '').trim();
    return this.records.find((record) => record.targetPostNo === normalizedPostNo) || null;
  }

  async listRecords(filters = {}) {
    await this.init();
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 50));
    const offset = Math.max(0, Number(filters.cursor) || 0);
    const filtered = sortRecordsForList(filterRecords(this.records, filters));
    const sliced = filtered.slice(offset, offset + limit);

    return {
      total: filtered.length,
      stats: summarizeRecords(this.records),
      records: sliced,
      nextCursor: offset + limit < filtered.length ? String(offset + limit) : '',
    };
  }

  async getStats() {
    await this.init();
    return summarizeRecords(this.records);
  }

  async persist() {
    const serialized = this.records
      .map((record) => JSON.stringify(record))
      .join('\n');
    this.writePromise = this.writePromise.then(() => writeFile(
      this.filePath,
      serialized ? `${serialized}\n` : '',
      'utf8',
    ));
    await this.writePromise;
  }
}

function normalizeDryRunRecord(input = {}) {
  const now = new Date().toISOString();
  const status = normalizeStatus(input.status) || 'completed';
  const targetPostNo = normalizeString(input.targetPostNo);
  const reason = normalizeString(input.reason) || status;
  if (!targetPostNo && !normalizeString(input.targetUrl)) {
    return null;
  }
  if (!reason) {
    return null;
  }

  const rawDecision = normalizeDecision(input.rawDecision) || normalizeDecision(input.decision);
  const normalizedDecision = normalizeDecision(input.normalizedDecision) || rawDecision;
  const effectiveDecision = normalizeEffectiveDecision(input.effectiveDecision)
    || decisionToEffectiveDecision(normalizedDecision);
  const decision = normalizeDecision(input.decision)
    || effectiveDecisionToDecision(effectiveDecision)
    || rawDecision
    || 'review';

  return {
    id: normalizeString(input.id) || buildRecordId(targetPostNo),
    source: SOURCE,
    status,
    targetUrl: normalizeString(input.targetUrl),
    targetPostNo,
    publicTitle: normalizeString(input.publicTitle || input.title) || '(제목 없음)',
    publicBody: normalizeString(input.publicBody || input.bodyText),
    contentCompleteness: normalizeString(input.contentCompleteness) || 'unknown',
    authorNick: normalizeString(input.authorNick),
    authorUid: normalizeString(input.authorUid),
    authorIp: normalizeString(input.authorIp),
    decision,
    rawDecision: rawDecision || decision,
    normalizedDecision: normalizedDecision || decision,
    effectiveDecision,
    thresholdBlocked: input.thresholdBlocked === true,
    confidenceThreshold: normalizeNullableNumber(input.confidenceThreshold),
    displayDecision: normalizeString(input.displayDecision) || getEffectiveDecisionLabel(effectiveDecision, status),
    confidence: normalizeNullableNumber(input.confidence),
    policyIds: normalizePolicyIds(input.policyIds || input.policy_ids),
    reason,
    imageCount: normalizeNonNegativeInt(input.imageCount, 0),
    imageDownloadedCount: normalizeNonNegativeInt(input.imageDownloadedCount, 0),
    imageAnalysis: normalizeString(input.imageAnalysis).slice(0, 4000),
    blurredThumbnailPath: normalizePublicAssetPath(input.blurredThumbnailPath),
    dryRun: true,
    actualAction: 'none',
    debugFailureType: normalizeString(input.debugFailureType),
    debugFailureMessage: normalizeString(input.debugFailureMessage).slice(0, 1000),
    debugFailureRawText: normalizeString(input.debugFailureRawText).slice(0, 4000),
    createdAt: normalizeIsoDate(input.createdAt) || now,
    updatedAt: normalizeIsoDate(input.updatedAt) || now,
  };
}

function sanitizePublicRecord(record) {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    source: record.source,
    status: record.status,
    targetUrl: record.targetUrl,
    targetPostNo: record.targetPostNo,
    publicTitle: record.publicTitle,
    publicBody: record.publicBody,
    contentCompleteness: record.contentCompleteness,
    authorNick: record.authorNick,
    authorUid: record.authorUid,
    authorIp: record.authorIp,
    decision: record.decision,
    rawDecision: record.rawDecision,
    normalizedDecision: record.normalizedDecision,
    effectiveDecision: record.effectiveDecision,
    thresholdBlocked: record.thresholdBlocked,
    confidenceThreshold: record.confidenceThreshold,
    displayDecision: record.displayDecision,
    confidence: record.confidence,
    policyIds: record.policyIds,
    reason: record.reason,
    imageCount: record.imageCount,
    imageDownloadedCount: record.imageDownloadedCount,
    imageAnalysis: record.imageAnalysis,
    blurredThumbnailPath: record.blurredThumbnailPath,
    dryRun: true,
    actualAction: 'none',
    debugFailureType: record.debugFailureType,
    debugFailureMessage: record.debugFailureMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function filterRecords(records, filters = {}) {
  let filtered = Array.isArray(records) ? records : [];
  const effectiveDecision = normalizeEffectiveDecision(filters.effectiveDecision || filters.decision);
  const status = normalizeStatus(filters.status);
  const policyId = normalizeString(filters.policyId).toUpperCase();

  if (effectiveDecision) {
    filtered = filtered.filter((record) => record.effectiveDecision === effectiveDecision);
  }
  if (status) {
    filtered = filtered.filter((record) => record.status === status);
  }
  if (policyId) {
    filtered = filtered.filter((record) => Array.isArray(record.policyIds) && record.policyIds.includes(policyId));
  }
  return filtered;
}

function summarizeRecords(records = []) {
  const stats = {
    total: 0,
    action: 0,
    review: 0,
    no_action: 0,
    skipped: 0,
    failed: 0,
  };

  for (const record of Array.isArray(records) ? records : []) {
    stats.total += 1;
    if (record.status === 'skipped') {
      stats.skipped += 1;
      continue;
    }
    if (record.status === 'failed') {
      stats.failed += 1;
      continue;
    }
    if (record.effectiveDecision === 'action') stats.action += 1;
    else if (record.effectiveDecision === 'review') stats.review += 1;
    else stats.no_action += 1;
  }

  return stats;
}

function getEffectiveDecisionLabel(effectiveDecision, status = 'completed') {
  if (status === 'skipped') return '스킵';
  if (status === 'failed') return '실패';
  if (effectiveDecision === 'action') return 'AI 조치 대상';
  if (effectiveDecision === 'review') return '사람 검토 필요';
  return '문제 없음';
}

function decisionToEffectiveDecision(decision) {
  if (decision === 'allow') return 'action';
  if (decision === 'review') return 'review';
  if (decision === 'deny') return 'no_action';
  return '';
}

function effectiveDecisionToDecision(effectiveDecision) {
  if (effectiveDecision === 'action') return 'allow';
  if (effectiveDecision === 'review') return 'review';
  if (effectiveDecision === 'no_action') return 'deny';
  return '';
}

function buildRecordId(postNo) {
  const normalizedPostNo = normalizeString(postNo).replace(/[^0-9]/g, '');
  return normalizedPostNo ? `dryrun-${normalizedPostNo}` : `dryrun-${randomUUID()}`;
}

function normalizeDecision(value) {
  const text = normalizeString(value).toLowerCase();
  return VALID_DECISIONS.has(text) ? text : '';
}

function normalizeEffectiveDecision(value) {
  const text = normalizeString(value).toLowerCase();
  return VALID_EFFECTIVE_DECISIONS.has(text) ? text : '';
}

function normalizeStatus(value) {
  const text = normalizeString(value).toLowerCase();
  return VALID_STATUSES.has(text) ? text : '';
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeNullableNumber(value) {
  if (value === '' || value == null) {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeNonNegativeInt(value, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }
  return Math.floor(numericValue);
}

function normalizePolicyIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean),
  )];
}

function normalizeIsoDate(value) {
  const text = normalizeString(value);
  if (!text) {
    return '';
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizePublicAssetPath(value) {
  const text = normalizeString(value);
  return text.startsWith('/transparency-assets/') ? text : '';
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

function sortRecordsForList(records) {
  return [...records].sort((left, right) => {
    const leftPostNo = Number(left.targetPostNo) || 0;
    const rightPostNo = Number(right.targetPostNo) || 0;
    if (rightPostNo !== leftPostNo) {
      return rightPostNo - leftPostNo;
    }

    const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
    const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return String(right.id || '').localeCompare(String(left.id || ''));
  });
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export {
  createDryRunRecordStore,
  getEffectiveDecisionLabel,
  normalizeDryRunRecord,
  sanitizePublicRecord,
  summarizeRecords,
};
