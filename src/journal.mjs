import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic, quarantine, removeFile } from './json-store.mjs';
import { UpdateError } from './errors.mjs';

export const JOURNAL_SCHEMA = 1;
export const JOURNAL_STATES = [
  'prepared', 'applying', 'verifying', 'committed', 'rolling-back', 'rolled-back', 'failed',
];
export const ACTIVE_STATES = ['prepared', 'applying', 'verifying', 'rolling-back'];

/** @type {Record<string, string[]>} */
export const ALLOWED_TRANSITIONS = {
  prepared: ['applying', 'rolling-back', 'failed'],
  applying: ['verifying', 'rolling-back', 'failed'],
  verifying: ['committed', 'rolling-back', 'failed'],
  'rolling-back': ['rolled-back', 'failed'],
  committed: ['rolling-back'],
  'rolled-back': [],
  failed: [],
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isJournal(value) {
  if (!value || typeof value !== 'object') return false;
  const j = /** @type {Record<string, any>} */ (value);
  return j.schema === JOURNAL_SCHEMA
    && typeof j.id === 'string' && j.id.length > 0
    && typeof j.from === 'string'
    && typeof j.to === 'string'
    && typeof j.state === 'string'
    && JOURNAL_STATES.includes(j.state)
    && typeof j.startedAt === 'string'
    && typeof j.updatedAt === 'string';
}

function makeId(now, random) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${random}`;
}

export class UpdateJournal {
  /**
   * @param {{home:string, clock?:()=>Date, idFactory?:()=>string}} options
   */
  constructor(options) {
    this.home = options.home;
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || (() => randomBytes(2).toString('hex'));
    this.path = join(this.home, 'updates', 'update-journal.json');
  }

  /** @returns {Promise<Record<string, any>|null>} */
  async read() {
    let data;
    try {
      data = await readJson(this.path);
    } catch {
      await quarantine(this.path, this.clock().getTime());
      return null;
    }
    if (data === null) return null;
    if (!isJournal(data)) {
      await quarantine(this.path, this.clock().getTime());
      return null;
    }
    return data;
  }

  /**
   * @param {{from:string, to:string, channel:string, backend:string, plan?:Record<string, unknown>, snapshot?:string|null, staging?:string|null, pid?:number}} input
   */
  async begin(input) {
    if (!input || typeof input.from !== 'string' || typeof input.to !== 'string'
      || typeof input.channel !== 'string' || typeof input.backend !== 'string') {
      throw new TypeError('journal.begin requires from, to, channel and backend');
    }
    const existing = await this.read();
    if (existing && ACTIVE_STATES.includes(existing.state)) {
      throw new UpdateError('UPD-303', {
        message: `journal already active: ${existing.state}`,
        details: { journalId: existing.id, state: existing.state },
      });
    }
    if (existing) {
      // 终端 journal 先归档，避免覆盖掉回滚点与审计信息。
      await writeJsonAtomic(join(this.home, 'updates', 'history', `${existing.id}.json`), existing);
    }
    const now = this.clock();
    const journal = {
      schema: JOURNAL_SCHEMA,
      id: makeId(now, this.idFactory()),
      from: input.from,
      to: input.to,
      channel: input.channel,
      backend: input.backend,
      state: 'prepared',
      plan: input.plan || {},
      snapshot: input.snapshot || null,
      staging: input.staging || null,
      pid: input.pid ?? process.pid,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      health: null,
      error: null,
    };
    await writeJsonAtomic(this.path, journal);
    return journal;
  }

  /**
   * @param {string} next
   * @param {Record<string, unknown>} [patch]
   */
  async transition(next, patch = {}) {
    const current = await this.read();
    if (!current) {
      throw new Error('journal not found; cannot transition');
    }
    if (!JOURNAL_STATES.includes(next)) {
      throw new Error(`invalid journal state: ${next}`);
    }
    if (next === current.state) {
      return current;
    }
    const allowed = ALLOWED_TRANSITIONS[current.state] || [];
    if (!allowed.includes(next)) {
      throw new Error(`invalid journal transition: ${current.state} -> ${next}`);
    }
    const updated = {
      ...current,
      ...patch,
      state: next,
      updatedAt: this.clock().toISOString(),
    };
    if (!isJournal(updated)) {
      throw new Error('refusing to write invalid journal');
    }
    await writeJsonAtomic(this.path, updated);
    return updated;
  }

  async discard() {
    await removeFile(this.path);
  }

  /**
   * 启动恢复：只读判断下一步，真正的回滚由调用方执行。
   * @param {{currentVersion?:string}} [options]
   * @returns {Promise<{action:'none'|'cleanup'|'rollback'|'verify'|'manual', journal:Record<string, any>|null}>}
   */
  async recover(options = {}) {
    const journal = await this.read();
    if (!journal) return { action: 'none', journal: null };
    const currentVersion = options.currentVersion;
    switch (journal.state) {
      case 'applying':
      case 'verifying':
        if (currentVersion && currentVersion === journal.to) {
          return { action: 'verify', journal };
        }
        return { action: 'rollback', journal };
      case 'rolling-back':
        return { action: 'rollback', journal };
      case 'prepared':
      case 'committed':
        return { action: 'cleanup', journal };
      case 'failed':
        return { action: 'manual', journal };
      case 'rolled-back':
        return { action: 'none', journal };
      default:
        return { action: 'manual', journal };
    }
  }
}
