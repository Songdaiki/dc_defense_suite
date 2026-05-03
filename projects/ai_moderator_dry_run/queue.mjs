import { dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const VALID_QUEUE_STATUSES = new Set(['queued', 'running', 'completed', 'skipped', 'failed']);

function createDryRunQueue(filePath) {
  return new DryRunQueue(filePath);
}

class DryRunQueue {
  constructor(filePath) {
    this.filePath = resolve(filePath);
    this.items = [];
    this.loaded = false;
    this.writePromise = Promise.resolve();
    this.mutationPromise = Promise.resolve();
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

    this.items = String(rawText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeParseJson(line))
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => normalizeQueueItem(entry))
      .filter(Boolean);
    this.loaded = true;
    await this.resetRunningOnStartup();
  }

  async enqueuePosts(posts = [], options = {}) {
    return this.withMutation(async () => {
      const force = options.force === true;
      const byPostNo = new Map(this.items.map((item) => [item.postNo, item]));
      let added = 0;
      let updated = 0;
      let skipped = 0;

      for (const post of Array.isArray(posts) ? posts : []) {
        const postNo = String(post?.no || post?.postNo || '').trim();
        if (!/^\d+$/.test(postNo)) {
          skipped += 1;
          continue;
        }

        const existing = byPostNo.get(postNo);
        if (existing && existing.status === 'running') {
          skipped += 1;
          continue;
        }
        if (existing && !force) {
          skipped += 1;
          continue;
        }

        const nextItem = normalizeQueueItem({
          ...existing,
          postNo,
          page: post.page || existing?.page || 0,
          subjectFromList: post.subject || post.subjectFromList || existing?.subjectFromList || '',
          currentHead: post.currentHead || existing?.currentHead || '',
          status: 'queued',
          attemptCount: existing?.attemptCount || 0,
          lastError: '',
          workerId: '',
          runningStartedAt: '',
          lastWorkerId: existing?.lastWorkerId || '',
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        if (existing) {
          Object.assign(existing, nextItem);
          updated += 1;
        } else {
          this.items.push(nextItem);
          byPostNo.set(postNo, nextItem);
          added += 1;
        }
      }

      this.sort();
      await this.persist();
      return { added, updated, skipped, total: this.items.length };
    });
  }

  async getNextQueued() {
    await this.init();
    return this.items
      .filter((item) => item.status === 'queued')
      .sort(compareProcessingPriority)[0] || null;
  }

  async claimNextQueued(workerId = '') {
    return this.withMutation(async () => {
      const item = this.items
        .filter((entry) => entry.status === 'queued')
        .sort(compareProcessingPriority)[0] || null;
      if (!item) {
        return null;
      }

      const now = new Date().toISOString();
      item.status = 'running';
      item.attemptCount = Math.max(0, Number(item.attemptCount) || 0) + 1;
      item.lastError = '';
      item.workerId = String(workerId || '').trim();
      item.runningStartedAt = now;
      item.updatedAt = now;
      await this.persist();
      return { ...item };
    });
  }

  async markRunning(postNo, workerId = '') {
    return this.patchItem(postNo, (item) => ({
      ...item,
      status: 'running',
      attemptCount: Math.max(0, Number(item.attemptCount) || 0) + 1,
      lastError: '',
      workerId: String(workerId || item.workerId || '').trim(),
      runningStartedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  async markCompleted(postNo) {
    return this.patchItem(postNo, (item) => ({
      ...item,
      status: 'completed',
      lastError: '',
      lastWorkerId: item.workerId || item.lastWorkerId || '',
      workerId: '',
      runningStartedAt: '',
      updatedAt: new Date().toISOString(),
    }));
  }

  async markSkipped(postNo, reason = '') {
    return this.patchItem(postNo, (item) => ({
      ...item,
      status: 'skipped',
      lastError: String(reason || ''),
      lastWorkerId: item.workerId || item.lastWorkerId || '',
      workerId: '',
      runningStartedAt: '',
      updatedAt: new Date().toISOString(),
    }));
  }

  async markFailed(postNo, reason = '') {
    return this.patchItem(postNo, (item) => ({
      ...item,
      status: 'failed',
      lastError: String(reason || ''),
      lastWorkerId: item.workerId || item.lastWorkerId || '',
      workerId: '',
      runningStartedAt: '',
      updatedAt: new Date().toISOString(),
    }));
  }

  async requeueFailedAndSkipped() {
    return this.withMutation(async () => {
      let updated = 0;
      for (const item of this.items) {
        if (item.status === 'failed' || item.status === 'skipped') {
          item.status = 'queued';
          item.lastError = '';
          item.workerId = '';
          item.runningStartedAt = '';
          item.updatedAt = new Date().toISOString();
          updated += 1;
        }
      }
      await this.persist();
      return { updated };
    });
  }

  async resetRunningOnStartup() {
    let updated = 0;
    for (const item of this.items) {
      if (item.status === 'running') {
        item.status = 'failed';
        item.lastError = '서버 재시작으로 running 상태 정리';
        item.lastWorkerId = item.workerId || item.lastWorkerId || '';
        item.workerId = '';
        item.runningStartedAt = '';
        item.updatedAt = new Date().toISOString();
        updated += 1;
      }
    }
    if (updated > 0) {
      await this.persist();
    }
    return { updated };
  }

  async getStatusSummary() {
    await this.init();
    const summary = {
      total: this.items.length,
      queued: 0,
      running: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
    };
    for (const item of this.items) {
      if (summary[item.status] != null) {
        summary[item.status] += 1;
      }
    }
    return summary;
  }

  async patchItem(postNo, patcher) {
    return this.withMutation(async () => {
      const normalizedPostNo = String(postNo || '').trim();
      const index = this.items.findIndex((item) => item.postNo === normalizedPostNo);
      if (index < 0) {
        return null;
      }

      const nextItem = normalizeQueueItem(patcher(this.items[index]));
      if (!nextItem) {
        return null;
      }
      this.items[index] = nextItem;
      await this.persist();
      return this.items[index];
    });
  }

  async withMutation(mutator) {
    const run = this.mutationPromise.then(async () => {
      await this.init();
      return mutator();
    });
    this.mutationPromise = run.catch(() => {});
    return run;
  }

  sort() {
    this.items.sort((left, right) => {
      const leftPage = Number(left.page) || 0;
      const rightPage = Number(right.page) || 0;
      if (leftPage !== rightPage) {
        return leftPage - rightPage;
      }
      return Number(right.postNo || 0) - Number(left.postNo || 0);
    });
  }

  async persist() {
    this.sort();
    const serialized = this.items.map((item) => JSON.stringify(item)).join('\n');
    this.writePromise = this.writePromise.then(() => writeFile(
      this.filePath,
      serialized ? `${serialized}\n` : '',
      'utf8',
    ));
    await this.writePromise;
  }
}

function normalizeQueueItem(input = {}) {
  const postNo = String(input.postNo || '').trim();
  if (!/^\d+$/.test(postNo)) {
    return null;
  }
  const status = String(input.status || 'queued').trim().toLowerCase();
  return {
    postNo,
    page: Math.max(0, Math.floor(Number(input.page) || 0)),
    subjectFromList: String(input.subjectFromList || '').trim(),
    currentHead: String(input.currentHead || '').trim(),
    status: VALID_QUEUE_STATUSES.has(status) ? status : 'queued',
    attemptCount: Math.max(0, Math.floor(Number(input.attemptCount) || 0)),
    createdAt: normalizeIsoDate(input.createdAt) || new Date().toISOString(),
    updatedAt: normalizeIsoDate(input.updatedAt) || new Date().toISOString(),
    lastError: String(input.lastError || '').trim(),
    workerId: String(input.workerId || '').trim(),
    runningStartedAt: normalizeIsoDate(input.runningStartedAt) || '',
    lastWorkerId: String(input.lastWorkerId || '').trim(),
  };
}

function compareProcessingPriority(left, right) {
  const leftCreatedAt = Date.parse(left.createdAt || '') || 0;
  const rightCreatedAt = Date.parse(right.createdAt || '') || 0;
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  const leftPage = Number(left.page) || 0;
  const rightPage = Number(right.page) || 0;
  if (leftPage !== rightPage) {
    return leftPage - rightPage;
  }

  return Number(left.postNo || 0) - Number(right.postNo || 0);
}

function normalizeIsoDate(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export {
  createDryRunQueue,
};
