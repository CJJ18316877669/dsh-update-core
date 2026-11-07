import { join } from 'node:path';
import { readJson, writeJsonAtomic, quarantine } from './json-store.mjs';

const SCHEMA = 1;

/**
 * 独立 watchdog 的持久状态。
 * 真实实现由 detached helper 写；这里把判定逻辑抽成可测试的纯状态机。
 */
export class Watchdog {
  /**
   * @param {{home:string, clock?:()=>number}} options
   */
  constructor(options) {
    this.home = options.home;
    this.clock = options.clock || (() => Date.now());
    this.path = join(this.home, 'updates', 'watchdog.json');
  }

  /** @returns {Promise<Record<string, any>|null>} */
  async read() {
    let data;
    try {
      data = await readJson(this.path);
    } catch {
      await quarantine(this.path, this.clock());
      return null;
    }
    if (data === null) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.schema !== SCHEMA) {
      return null;
    }
    return /** @type {Record<string, any>} */ (data);
  }

  /**
   * @param {{journalId:string, from:string, to:string, deadlineMs?:number, maxBoots?:number}} input
   */
  async arm(input) {
    if (!input || typeof input.journalId !== 'string' || !input.journalId
      || typeof input.from !== 'string' || typeof input.to !== 'string') {
      throw new TypeError('watchdog.arm requires journalId, from and to');
    }
    const now = this.clock();
    const state = {
      schema: SCHEMA,
      state: 'armed',
      journalId: input.journalId,
      from: input.from,
      to: input.to,
      armedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + (input.deadlineMs ?? 90000)).toISOString(),
      maxBoots: input.maxBoots ?? 3,
      boots: 0,
      heartbeats: 0,
      updatedAt: new Date(now).toISOString(),
    };
    await writeJsonAtomic(this.path, state);
    return state;
  }

  async beat() {
    const data = await this.read();
    if (!data || data.state !== 'armed') return null;
    const updated = {
      ...data,
      heartbeats: (data.heartbeats || 0) + 1,
      updatedAt: new Date(this.clock()).toISOString(),
    };
    await writeJsonAtomic(this.path, updated);
    return updated;
  }

  async disarm() {
    const data = await this.read();
    if (!data) return null;
    const updated = { ...data, state: 'disarmed', updatedAt: new Date(this.clock()).toISOString() };
    await writeJsonAtomic(this.path, updated);
    return updated;
  }

  /**
   * 新进程启动时调用。只返回判定，不执行回滚。
   * @param {{currentVersion:string, now?:number, boot?:boolean}} input
   * @returns {Promise<{action:'none'|'waiting'|'healthy'|'rolled-back'|'rollback'|'safe-mode', reason?:string, state?:Record<string, any>}>}
   */
  async evaluate(input) {
    const data = await this.read();
    if (!data) return { action: 'none' };
    if (data.state !== 'armed') return { action: 'none', state: data };

    const currentVersion = input.currentVersion;
    if (typeof currentVersion !== 'string' || currentVersion === '') {
      return { action: 'safe-mode', reason: 'missing-current-version', state: data };
    }
    if (currentVersion === data.from) {
      const state = { ...data, state: 'rolled-back', updatedAt: new Date(this.clock()).toISOString() };
      await writeJsonAtomic(this.path, state);
      return { action: 'rolled-back', reason: 'already-on-previous-version', state };
    }
    if (currentVersion !== data.to) {
      return { action: 'safe-mode', reason: 'version-mismatch', state: data };
    }
    if ((data.heartbeats || 0) > 0) {
      const state = { ...data, state: 'healthy', updatedAt: new Date(this.clock()).toISOString() };
      await writeJsonAtomic(this.path, state);
      return { action: 'healthy', state };
    }

    const now = input.now ?? this.clock();
    const deadline = Date.parse(data.deadlineAt);
    if (Number.isFinite(deadline) && now >= deadline) {
      return { action: 'rollback', reason: 'deadline', state: data };
    }

    // boots 只在“新进程启动”时递增；轮询 evaluate 不应把正常进程误判成 boot loop。
    const boots = (data.boots || 0) + (input.boot === true ? 1 : 0);
    if (input.boot === true && boots > (data.maxBoots ?? 3)) {
      return { action: 'rollback', reason: 'boot-loop', state: data };
    }
    const state = { ...data, boots, updatedAt: new Date(now).toISOString() };
    await writeJsonAtomic(this.path, state);
    return { action: 'waiting', state };
  }
}
