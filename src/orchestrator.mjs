import { compare, parse, sortStableFirstDesc } from './semver.mjs';
import { UpdateError, AbortedError, asUpdateError, isAbortError } from './errors.mjs';
import { I18n } from './i18n.mjs';
import { Telemetry } from './telemetry.mjs';
import { FileLock } from './lock.mjs';

const CHANNELS = new Set(['stable', 'nightly']);

/**
 * 第三方 gate 可能返回不完整对象；在进入流程前统一形状，避免 undefined 计数。
 * @param {any} plan
 * @param {string} targetCore
 */
function normalizePlan(plan, targetCore) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.items)) {
    throw new UpdateError('UPD-102', { message: 'plugin gate returned an invalid plan' });
  }
  const items = plan.items.filter((item) => item && typeof item === 'object');
  const count = (value, predicate) => (Number.isFinite(value) ? value : items.filter(predicate).length);
  const disabled = Array.isArray(plan.disabled)
    ? plan.disabled
    : items.filter((item) => item.action === 'disable').map((item) => item.name);
  return {
    ...plan,
    targetCore,
    items,
    updates: count(plan.updates, (item) => item.action === 'update'),
    keeps: count(plan.keeps, (item) => item.action === 'keep'),
    disables: count(plan.disables, (item) => item.action === 'disable'),
    blocks: count(plan.blocks, (item) => item.action === 'block'),
    manuals: count(plan.manuals, (item) => item.action === 'manual'),
    disabled,
  };
}
const VALID_STATES = new Set([
  'idle', 'checking', 'up-to-date', 'available', 'available-incompatible', 'mandatory',
  'preparing', 'downloading', 'verifying', 'staged', 'draining', 'activating',
  'succeeded', 'rolled-back', 'failed', 'blocked', 'safe-mode',
]);

/**
 * @typedef {Object} Backend
 * @property {'desktop'|'npm-global'|'profile'|'npx'|'source'} kind
 * @property {() => Promise<string>} getCurrentVersion
 * @property {(channel:string) => Promise<Array<Record<string, any>>>} check
 * @property {() => Promise<Array<Record<string, any>>>} listPlugins
 * @property {(release:Record<string, any>, installed:Array<Record<string, any>>) => Promise<any>} [resolvePlugins]
 * @property {() => Promise<any>} [snapshot]
 * @property {(plan:any, ctx:{onProgress:Function, signal:AbortSignal}) => Promise<any>} prepare
 * @property {(staged:any) => Promise<any>} activate
 * @property {(handle:any) => Promise<{ok:boolean, checks?:string[], details?:any}>} health
 * @property {(journal:any) => Promise<{ok:boolean, mode?:string, reason?:string}>} [rollback]
 * @property {() => Promise<void>} [cleanup]
 */

export class UpdateOrchestrator {
  /**
   * @param {{
   *   backend:Backend,
   *   gate:{plan:Function, verify?:Function},
   *   journal:{begin:Function, transition:Function, read:Function, discard?:Function},
   *   watchdog:{arm?:Function, beat?:Function},
   *   telemetry?:Telemetry,
   *   i18n?:I18n,
   *   lock?:FileLock,
   *   home?:string,
   *   channel?:string,
   *   logger?:{info:Function, warn:Function, error:Function},
   *   clock?:()=>number
   * }} options
   */
  constructor(options) {
    if (!options || !options.backend) throw new TypeError('orchestrator requires a backend');
    if (!options.gate || typeof options.gate.plan !== 'function') throw new TypeError('orchestrator requires a plugin gate');
    if (!options.journal) throw new TypeError('orchestrator requires a journal');
    const required = ['getCurrentVersion', 'check', 'listPlugins', 'prepare', 'activate', 'health'];
    for (const method of required) {
      if (typeof options.backend[method] !== 'function') {
        throw new TypeError(`backend.${method} must be a function`);
      }
    }
    if (options.channel && !CHANNELS.has(options.channel)) {
      throw new TypeError(`unsupported channel: ${options.channel}`);
    }

    this.backend = options.backend;
    this.gate = options.gate;
    this.journal = options.journal;
    this.watchdog = options.watchdog || null;
    this.telemetry = options.telemetry || new Telemetry({ enabled: false });
    this.i18n = options.i18n || new I18n('zh-CN');
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.clock = options.clock || Date.now;
    this.stagingVerifier = options.stagingVerifier || null;
    this.stagingTimeoutMs = options.stagingTimeoutMs ?? 30000;
    this.channel = options.channel || 'stable';
    this.lock = options.lock || (options.home ? new FileLock({ home: options.home }) : null);
    this.home = options.home || '';

    /** @type {Set<(state:Record<string, any>)=>void>} */
    this.listeners = new Set();
    this.plan = null;
    this.release = null;
    this.snapshot = null;
    this.staged = null;
    this.activation = null;
    this.abort = null;
    this.running = false;
    this.stage = 'idle';
    this.startedAt = 0;
    this.state = {
      state: 'idle',
      channel: this.channel,
      currentVersion: '',
      targetVersion: null,
      plan: null,
      progress: { percent: 0, stage: '' },
      error: null,
      result: null,
      updatedAt: new Date(this.clock()).toISOString(),
    };
  }

  getState() {
    return { ...this.state, progress: { ...this.state.progress } };
  }

  /** 切换渠道会清空已解析的计划，避免用旧渠道的 release 启动。 */
  setChannel(channel) {
    if (!CHANNELS.has(channel)) throw new TypeError(`unsupported channel: ${channel}`);
    if (this.running) throw new UpdateError('UPD-303', { message: 'update already running' });
    this.channel = channel;
    this.plan = null;
    this.release = null;
    this.setState('idle', {
      channel,
      targetVersion: null,
      plan: null,
      progress: { percent: 0, stage: '' },
      result: null,
      error: null,
    });
    return this.getState();
  }

  /** @param {(state:Record<string, any>)=>void} listener */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @param {string} state @param {Record<string, any>} [patch] */
  setState(state, patch = {}) {
    if (!VALID_STATES.has(state)) throw new Error(`invalid orchestrator state: ${state}`);
    this.state = {
      ...this.state,
      ...patch,
      state,
      channel: this.channel,
      updatedAt: new Date(this.clock()).toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch (error) {
        this.logger.warn('state listener failed', error);
      }
    }
  }

  /** @param {{manual?:boolean}} [options] */
  async check(options = {}) {
    options = options || {};
    if (this.running) throw new UpdateError('UPD-303', { message: 'update already running' });
    this.plan = null;
    this.release = null;
    this.setState('checking', { progress: { percent: 0, stage: 'check' }, error: null, result: null, targetVersion: null });
    this.telemetry.emit('update.check', { manual: options.manual === true, channel: this.channel });

    try {
      const currentVersion = await this.backend.getCurrentVersion();
      if (typeof currentVersion !== 'string' || !parse(currentVersion)) {
        throw new UpdateError('UPD-102', {
          message: `backend returned invalid current version: ${String(currentVersion)}`,
        });
      }
      const releases = await this.backend.check(this.channel);
      if (!Array.isArray(releases)) {
        throw new UpdateError('UPD-102', { message: 'backend.check must return an array' });
      }
      const release = this.pickRelease(releases, currentVersion);
      if (!release) {
        this.plan = null;
        this.release = null;
        this.setState('up-to-date', {
          currentVersion,
          targetVersion: null,
          plan: null,
          progress: { percent: 100, stage: 'done' },
          result: { upToDate: true, version: currentVersion },
        });
        this.telemetry.emit('update.up_to_date', { fromVersion: currentVersion });
        return this.getState();
      }

      const installed = await this.backend.listPlugins();
      if (!Array.isArray(installed)) {
        throw new UpdateError('UPD-102', { message: 'backend.listPlugins must return an array' });
      }
      let available = {};
      if (typeof this.backend.resolvePlugins === 'function') {
        available = await this.backend.resolvePlugins(release, installed);
      }
      if (available && typeof available.then === 'function') {
        available = await available;
      }
      const plan = normalizePlan(await this.gate.plan(release.version, installed, available || {}), release.version);

      this.plan = plan;
      this.release = release;
      const nextState = plan.blocks > 0
        ? 'blocked'
        : plan.disables > 0
          ? 'available-incompatible'
          : 'available';

      this.setState(nextState, {
        currentVersion,
        targetVersion: release.version,
        plan,
        progress: { percent: 0, stage: 'idle' },
        result: {
          currentVersion,
          targetVersion: release.version,
          updates: plan.updates,
          disables: plan.disables,
          blocks: plan.blocks,
          confirmRequired: plan.disables > 0,
        },
      });
      if (nextState === 'blocked') {
        this.telemetry.emit('update.blocked', {
          fromVersion: currentVersion,
          toVersion: release.version,
          blockCount: plan.blocks,
        });
      }
      return this.getState();
    } catch (error) {
      const failure = asUpdateError(error, 'UPD-101');
      this.setState('failed', {
        error: failure.toJSON(),
        plan: null,
        targetVersion: null,
        progress: { percent: 0, stage: 'check' },
      });
      this.telemetry.emit('update.failed', {
        stage: failure.stage,
        code: failure.code,
        message: failure.message,
      });
      throw failure;
    }
  }

  /**
   * @param {Array<Record<string, any>>} releases
   * @param {string} currentVersion
   */
  pickRelease(releases, currentVersion) {
    const candidates = releases.filter((release) => {
      if (!release || typeof release.version !== 'string' || !parse(release.version)) return false;
      if (release.channel && release.channel !== this.channel) return false;
      if (release.deprecated || release.yanked) return false;
      return compare(release.version, currentVersion) > 0;
    });
    if (!candidates.length) return null;
    const sorted = sortStableFirstDesc(candidates.map((release) => release.version));
    const picked = sorted[0];
    return candidates.find((release) => release.version === picked) || null;
  }

  /**
   * @param {{confirm?:boolean}} [options]
   */
  async start(options = {}) {
    options = options || {};
    if (this.running) throw new UpdateError('UPD-303', { message: 'update already running' });
    if (this.state.state === 'succeeded'
      && this.plan
      && this.state.currentVersion === this.plan.targetCore) {
      return this.getState();
    }
    if (!this.plan || !this.release) {
      await this.check();
    }
    if (!this.plan || !this.release) {
      return this.getState();
    }
    if (this.plan.blocks > 0) {
      throw new UpdateError('UPD-202', {
        message: 'core plugin incompatible',
        details: { blocks: this.plan.items.filter((item) => item.action === 'block').map((item) => item.name) },
      });
    }
    if (this.plan.disables > 0 && options.confirm !== true) {
      throw new UpdateError('UPD-201', {
        message: 'confirmation required before disabling plugins',
        details: { confirmRequired: true, disables: this.plan.disabled },
      });
    }

    this.running = true;
    this.abort = new AbortController();
    this.startedAt = this.clock();
    this.stage = 'preparing';
    this.activation = null;
    this.staged = null;
    this.snapshot = null;

    let journal = null;
    try {
      if (this.lock) await this.lock.acquire();
      await this.touchLock();
      this.setState('preparing', {
        error: null,
        result: null,
        progress: { percent: 0, stage: 'preparing' },
      });
      this.telemetry.emit('update.started', {
        fromVersion: this.state.currentVersion,
        toVersion: this.release.version,
        channel: this.channel,
        backend: this.backend.kind,
        updates: this.plan.updates,
        disables: this.plan.disables,
      });

      if (typeof this.backend.snapshot === 'function') {
        this.snapshot = await this.backend.snapshot();
      }

      journal = await this.journal.begin({
        from: this.state.currentVersion,
        to: this.release.version,
        channel: this.channel,
        backend: this.backend.kind,
        plan: {
          updates: this.plan.updates,
          keeps: this.plan.keeps,
          disables: this.plan.disables,
          blocks: this.plan.blocks,
        },
        snapshot: this.snapshot && (this.snapshot.path || this.snapshot.id) || null,
        staging: null,
        pid: process.pid,
      });

      this.throwIfAborted();
      this.stage = 'downloading';
      this.staged = await this.backend.prepare(this.plan, {
        signal: this.abort.signal,
        onProgress: (progress) => this.onProgress(progress),
      });
      if (!this.staged) throw new UpdateError('UPD-501', { message: 'backend.prepare returned nothing' });
      this.stage = 'staging-health';
      this.setState('verifying', { progress: { percent: 100, stage: 'staging-health' } });
      await this.verifyStaging(this.staged, journal);
      await this.touchLock();

      this.stage = 'draining';
      this.setState('draining', { progress: { percent: 100, stage: 'draining' } });
      this.telemetry.emit('update.stage', { stage: 'draining' });
      if (typeof this.backend.drain === 'function') {
        await this.backend.drain({ signal: this.abort.signal });
      }
      this.throwIfAborted();
      await this.touchLock();

      await this.journal.transition('applying', {
        staging: this.staged.path || this.staged.id || null,
      });

      this.stage = 'applying';
      this.setState('activating', { progress: { percent: 100, stage: 'activating' } });
      this.telemetry.emit('update.stage', { stage: 'applying' });

      if (this.watchdog && typeof this.watchdog.arm === 'function') {
        await this.watchdog.arm({
          journalId: journal.id,
          from: journal.from,
          to: journal.to,
        });
      }

      this.activation = await this.backend.activate(this.staged);
      await this.touchLock();
      await this.journal.transition('verifying');
      this.setState('activating', { progress: { percent: 100, stage: 'verifying-install' } });
      this.telemetry.emit('update.stage', { stage: 'verifying-install' });

      const health = await this.backend.health(this.activation);
      if (!health || health.ok !== true) {
        throw new UpdateError('UPD-502', {
          message: 'health check failed',
          details: { checks: health && health.checks, details: health && health.details },
        });
      }

      if (this.activation && typeof this.activation.commit === 'function') {
        await this.activation.commit();
      }
      this.activation = null;
      this.staged = null;
      await this.journal.transition('committed', { health });
      if (this.watchdog && typeof this.watchdog.beat === 'function') {
        await this.watchdog.beat().catch((error) => this.logger.warn('watchdog heartbeat failed', error));
      }
      this.stage = 'committed';
      this.setState('succeeded', {
        currentVersion: this.release.version,
        targetVersion: null,
        progress: { percent: 100, stage: 'done' },
        error: null,
        result: {
          updated: true,
          version: this.release.version,
          updates: this.plan.updates,
          disables: this.plan.disables,
          durationMs: this.clock() - this.startedAt,
        },
      });
      this.telemetry.emit('update.succeeded', {
        fromVersion: journal.from,
        toVersion: journal.to,
        durationMs: this.clock() - this.startedAt,
        updates: this.plan.updates,
        disables: this.plan.disables,
      });
      if (typeof this.backend.cleanup === 'function') {
        await this.backend.cleanup().catch((error) => this.logger.warn('cleanup failed', error));
      }
      return this.getState();
    } catch (error) {
      if (isAbortError(error) || (this.abort && this.abort.signal.aborted)) {
        await this.handleCancel(journal);
        return this.getState();
      }
      const failure = asUpdateError(error);
      this.logger.error('update failed', failure);
      await this.handleFailure(failure, journal);
      throw failure;
    } finally {
      this.running = false;
      this.abort = null;
      if (this.lock) {
        await this.lock.release().catch((error) => this.logger.warn('lock release failed', error));
      }
    }
  }

  async runStagingHealth(staged) {
    if (!this.stagingVerifier && typeof this.backend.stagingHealth !== 'function') {
      return { ok: true, checks: ['not-required'], evidence: {} };
    }
    const controller = new AbortController();
    const parent = this.abort && this.abort.signal;
    const onAbort = () => controller.abort();
    if (parent) parent.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      const operation = Promise.resolve().then(() => this.stagingVerifier
        ? this.stagingVerifier(staged, { signal: controller.signal, plan: this.plan })
        : this.backend.stagingHealth(staged.path, {
          ...staged,
          signal: controller.signal,
          plan: this.plan,
        }));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UpdateError('UPD-502', {
            message: `staging verification timed out after ${this.stagingTimeoutMs}ms`,
          }));
        }, this.stagingTimeoutMs);
      });
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onAbort);
    }
  }

  async verifyStaging(staged, journal) {
    const evidence = [];
    let gateVerified = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.throwIfAborted();
      const health = await this.runStagingHealth(staged);
      evidence.push({
        ok: health && health.ok === true,
        checks: health && health.checks,
        reason: health && health.reason,
        plugin: health && (health.plugin || health.name),
        evidence: health && health.evidence,
      });
      await this.journal.transition('prepared', {
        staging: staged.path || staged.id || null,
        stagingEvidence: evidence,
        plan: {
          updates: this.plan.updates,
          keeps: this.plan.keeps,
          disables: this.plan.disables,
          blocks: this.plan.blocks,
        },
      });

      if (health && health.ok === true) {
        if (!gateVerified && this.plan.items.some((item) => item.verify)) {
          const previous = this.plan;
          const next = typeof this.gate.verify === 'function'
            ? await this.gate.verify(previous)
            : previous;
          gateVerified = true;
          this.plan = next;
          staged.plan = next;
          await this.applyStagingPlanChanges(staged, previous, next);
          if (next.blocks > 0) {
            throw new UpdateError('UPD-202', {
              message: 'core plugin failed staging verification',
              details: { blocks: next.items.filter((item) => item.action === 'block').map((item) => item.name) },
            });
          }
          if (next.disables > previous.disables) continue;
        }
        await this.journal.transition('prepared', {
          plan: {
            updates: this.plan.updates,
            keeps: this.plan.keeps,
            disables: this.plan.disables,
            blocks: this.plan.blocks,
          },
        });
        return health;
      }

      const name = health && (health.plugin || health.name);
      if (!name || typeof this.gate.applyVerificationFailure !== 'function') {
        throw new UpdateError('UPD-502', {
          message: 'staging health check failed',
          details: { reason: health && health.reason, evidence },
        });
      }
      const previous = this.plan;
      const next = this.gate.applyVerificationFailure(
        previous,
        name,
        health.reason || 'staging-health-failed',
      );
      if (next === previous) {
        throw new UpdateError('UPD-502', {
          message: `staging failure named an unknown plugin: ${name}`,
          details: { evidence },
        });
      }
      this.plan = next;
      staged.plan = next;
      await this.applyStagingPlanChanges(staged, previous, next);
      if (next.blocks > 0) {
        throw new UpdateError('UPD-202', {
          message: 'core plugin failed staging verification',
          details: { blocks: next.items.filter((item) => item.action === 'block').map((item) => item.name) },
        });
      }
    }
    throw new UpdateError('UPD-502', {
      message: 'staging verification did not converge',
      details: { evidence },
    });
  }

  async applyStagingPlanChanges(staged, previous, next) {
    if (next.disables <= previous.disables) return;
    if (typeof this.backend.applyStagingDecisions !== 'function') {
      throw new UpdateError('UPD-501', {
        message: 'backend cannot apply staging plugin decisions',
      });
    }
    await this.backend.applyStagingDecisions(staged, previous);
  }

  throwIfAborted() {
    if (this.abort && this.abort.signal.aborted) throw new AbortedError();
  }

  async touchLock() {
    if (this.lock && typeof this.lock.touch === 'function') {
      await this.lock.touch().catch(() => {});
    }
  }

  /** @param {{percent?:number, stage?:string}} progress */
  onProgress(progress) {
    if (!progress || typeof progress !== 'object') return;
    if (!this.running || (this.abort && this.abort.signal.aborted)) return;
    const raw = Number(progress.percent);
    const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
    const stage = typeof progress.stage === 'string' && progress.stage ? progress.stage : this.stage;
    const uiState = stage === 'download' ? 'downloading'
      : stage === 'verify' ? 'verifying'
        : stage === 'stage' ? 'staged'
          : 'preparing';
    this.stage = stage;
    this.setState(uiState, { progress: { percent, stage } });
    this.telemetry.emit('update.stage', { stage, percent });
  }

  /** @param {unknown} journal */
  async handleCancel(journal) {
    this.stage = 'cancelled';
    try {
      if (journal && typeof this.journal.discard === 'function') {
        await this.journal.discard();
      }
    } catch (error) {
      this.logger.warn('failed to discard cancelled journal', error);
    }
    this.setState(this.plan && this.plan.disables > 0 ? 'available-incompatible' : 'available', {
      progress: { percent: 0, stage: 'cancelled' },
      result: { cancelled: true },
      error: null,
    });
    this.telemetry.emit('update.cancelled', {});
  }

  /**
   * @param {UpdateError} failure
   * @param {Record<string, any>|null} journal
   */
  async handleFailure(failure, journal) {
    const current = journal && typeof this.journal.read === 'function'
      ? await this.journal.read().catch(() => journal)
      : journal;
    const journalState = current ? current.state : null;
    if (failure.code === 'UPD-202' && journalState === 'prepared') {
      await this.journal.transition('failed', { error: failure.toJSON() }).catch(() => {});
      this.stage = 'blocked';
      this.setState('blocked', {
        targetVersion: this.release ? this.release.version : this.state.targetVersion,
        progress: { percent: 0, stage: 'blocked' },
        error: failure.toJSON(),
        result: { blocked: true, reason: 'staging-verify-failed' },
      });
      this.telemetry.emit('update.blocked', {
        fromVersion: current.from,
        toVersion: current.to,
        blockCount: this.plan.blocks,
      });
      return;
    }
    const rollbackNeeded = !!this.activation
      || (journalState && ['applying', 'verifying', 'rolling-back'].includes(journalState));

    if (rollbackNeeded) {
      let report;
      try {
        if (current) await this.journal.transition('rolling-back', { error: failure.toJSON() });
        this.stage = 'rolling-back';
        this.setState('activating', {
          progress: { percent: 100, stage: 'rolling-back' },
          error: failure.toJSON(),
        });
        report = await this.performRollback(current);
      } catch (error) {
        report = { ok: false, mode: 'safe-mode', reason: error instanceof Error ? error.message : String(error) };
      }

      if (report.ok) {
        if (current) await this.journal.transition('rolled-back', { error: failure.toJSON() }).catch(() => {});
        if (this.watchdog && typeof this.watchdog.disarm === 'function') {
          await this.watchdog.disarm().catch(() => {});
        }
        this.stage = 'rolled-back';
        this.setState('rolled-back', {
          currentVersion: current ? current.from : this.state.currentVersion,
          targetVersion: null,
          progress: { percent: 100, stage: 'rolled-back' },
          error: failure.toJSON(),
          result: { rolledBack: true, reason: failure.code },
        });
        this.telemetry.emit('update.rolled_back', {
          code: failure.code,
          reason: report.reason || 'health-check-failed',
        });
        return;
      }

      if (current) {
        await this.journal.transition('failed', {
          error: failure.toJSON(),
          safeMode: true,
          rollbackError: report.reason || 'rollback-failed',
        }).catch(() => {});
      }
      if (this.watchdog && typeof this.watchdog.disarm === 'function') {
        await this.watchdog.disarm().catch(() => {});
      }
      this.stage = 'safe-mode';
      this.setState('safe-mode', {
        targetVersion: null,
        progress: { percent: 100, stage: 'safe-mode' },
        error: new UpdateError('UPD-601', {
          message: 'automatic rollback failed',
          details: { cause: report.reason },
        }).toJSON(),
        result: { safeMode: true },
      });
      this.telemetry.emit('update.safe_mode', { code: 'UPD-601', reason: report.reason });
      return;
    }

    if (current) {
      await this.journal.transition('failed', { error: failure.toJSON() }).catch((error) => {
        this.logger.warn('failed to mark journal failed', error);
      });
    }
    this.stage = 'failed';
    this.setState('failed', {
      progress: { percent: 100, stage: 'failed' },
      error: failure.toJSON(),
      result: null,
    });
    this.telemetry.emit('update.failed', {
      stage: failure.stage,
      code: failure.code,
      retryable: failure.retryable,
    });
  }

  /** @param {Record<string, any>|null} journal */
  async performRollback(journal) {
    let lastReason = 'no-rollback-handler';

    if (this.activation && typeof this.activation.rollback === 'function') {
      try {
        await this.activation.rollback();
        return { ok: true, mode: 'rolled-back', reason: 'activation-rollback' };
      } catch (error) {
        lastReason = `activation-rollback:${error instanceof Error ? error.message : String(error)}`;
        this.logger.warn('activation rollback failed, trying backend rollback', error);
      }
    }

    if (typeof this.backend.rollback === 'function') {
      try {
        const report = await this.backend.rollback(journal);
        if (report && report.ok !== false) {
          return { ok: true, mode: 'rolled-back', reason: 'backend-rollback' };
        }
        lastReason = (report && report.reason) || 'backend-rollback-failed';
      } catch (error) {
        lastReason = `backend-rollback:${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (this.snapshot && typeof this.snapshot.restore === 'function') {
      try {
        await this.snapshot.restore();
        return { ok: true, mode: 'rolled-back', reason: 'snapshot-restore' };
      } catch (error) {
        lastReason = `snapshot-restore:${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return { ok: false, mode: 'safe-mode', reason: lastReason };
  }

  /**
   * 用户取消：只在激活前有效。
   * @returns {Promise<boolean>}
   */
  async cancel() {
    if (!this.running || !this.abort) return false;
    if (['applying', 'rolling-back', 'committed'].includes(this.stage)) return false;
    this.abort.abort();
    this.telemetry.emit('update.cancel_requested', { stage: this.stage });
    return true;
  }

  /** 手动回滚最近一次已提交的更新。 */
  async rollback() {
    if (this.running) throw new UpdateError('UPD-303', { message: 'update already running' });
    const journal = await this.journal.read();
    if (!journal || journal.state !== 'committed') {
      throw new UpdateError('UPD-501', { message: 'no committed update to roll back' });
    }
    this.running = true;
    try {
      if (this.lock) await this.lock.acquire();
      await this.journal.transition('rolling-back');
      this.setState('activating', { progress: { percent: 100, stage: 'rolling-back' } });
      const report = await this.performRollback(journal);
      if (!report.ok) {
        await this.journal.transition('failed', { safeMode: true, rollbackError: report.reason }).catch(() => {});
        this.setState('safe-mode', {
          error: new UpdateError('UPD-601', { message: 'rollback failed', details: { cause: report.reason } }).toJSON(),
        });
        this.telemetry.emit('update.safe_mode', { code: 'UPD-601' });
        return this.getState();
      }
      await this.journal.transition('rolled-back');
      this.setState('rolled-back', {
        currentVersion: journal.from,
        targetVersion: null,
        progress: { percent: 100, stage: 'rolled-back' },
        error: null,
        result: { rolledBack: true, manual: true },
      });
      this.telemetry.emit('update.rolled_back', { manual: true });
      return this.getState();
    } finally {
      this.running = false;
      if (this.lock) await this.lock.release().catch(() => {});
    }
  }

  /**
   * 启动恢复入口：读取 journal/watchdog 并给出下一步。
   * @param {{currentVersion?:string, now?:number}} [options]
   */
  async recover(options = {}) {
    if (this.running) throw new UpdateError('UPD-303', { message: 'update already running' });
    this.running = true;
    try {
      return await this.recoverInternal(options || {});
    } finally {
      this.running = false;
    }
  }

  async recoverInternal(options = {}) {
    const currentVersion = options.currentVersion || await this.backend.getCurrentVersion();
    const journalResult = await this.journal.recover({ currentVersion });
    if (journalResult.action === 'rollback' && journalResult.journal) {
      const journal = journalResult.journal;
      try {
        await this.journal.transition('rolling-back');
        const report = await this.performRollback(journal);
        if (report.ok) {
          await this.journal.transition('rolled-back');
          this.setState('rolled-back', { currentVersion: journal.from, targetVersion: null });
          return { action: 'rolled-back', journal: this.journal.read ? await this.journal.read() : journal };
        }
        await this.journal.transition('failed', { safeMode: true, rollbackError: report.reason }).catch(() => {});
        this.setState('safe-mode', {
          error: new UpdateError('UPD-601', { message: 'rollback failed' }).toJSON(),
        });
        return { action: 'safe-mode', journal };
      } catch (error) {
        return { action: 'manual', reason: error instanceof Error ? error.message : String(error), journal };
      }
    }
    return journalResult;
  }
}
