import { UpdateError, AbortedError } from '../errors.mjs';

const DEFAULT_PLUGINS = [
  {
    name: 'dsh-plugin-office',
    version: '1.4.2',
    kind: 'plugin',
    spec: 'registry',
    manifest: { engines: { dsh: '>=0.2.0' } },
  },
  {
    name: 'dsh-plugin-git-review',
    version: '0.9.1',
    kind: 'plugin',
    spec: 'registry',
    manifest: { engines: { dsh: '>=0.2.0' } },
  },
  {
    name: '@deepseek-ai/dsh-tool-terminal',
    version: '0.2.2-rc.1',
    kind: 'core',
    protected: true,
    spec: 'registry',
    manifest: { engines: { dsh: '>=0.2.0' } },
  },
  {
    name: 'dsh-plugin-legacy-notes',
    version: '0.4.1',
    kind: 'plugin',
    spec: 'registry',
    manifest: {},
  },
];

const DEFAULT_AVAILABLE = {
  'dsh-plugin-office': [{ version: '1.4.2', manifest: { engines: { dsh: '>=0.2.0' } } }],
  'dsh-plugin-git-review': [
    { version: '0.9.1', manifest: { engines: { dsh: '>=0.2.0' } } },
    { version: '1.0.0', manifest: { engines: { dsh: '>=0.2.0' } } },
  ],
  '@deepseek-ai/dsh-tool-terminal': [{ version: '0.2.3', manifest: { engines: { dsh: '>=0.2.0' } } }],
  'dsh-plugin-legacy-notes': [{ version: '0.4.1', manifest: {} }],
};

/**
 * 内存后端：用于测试 OR 演示，不触碰真实文件系统。
 * 故障注入覆盖检查、下载、校验、切换、自检、回滚。
 */
export class FakeBackend {
  /**
   * @param {{
   *   currentVersion?:string,
   *   releases?:Array<Record<string, any>>,
   *   plugins?:Array<Record<string, any>>,
   *   available?:Record<string, Array<Record<string, any>>>,
   *   failAt?:string|null,
   *   delayMs?:number,
   *   kind?:string,
   *   snapshotPath?:string
   * }} [options]
   */
  constructor(options = {}) {
    this.kind = options.kind || 'profile';
    this.currentVersion = options.currentVersion || '0.2.2-rc.1';
    this.previousVersion = this.currentVersion;
    this.releases = options.releases || [
      { version: '0.2.3', channel: 'stable', dist: { integrity: 'sha512-demo', tarball: 'https://example.invalid/dsh-0.2.3.tgz' } },
      { version: '0.2.3-nightly.20261107', channel: 'nightly', dist: { integrity: 'sha512-demo', tarball: 'https://example.invalid/dsh-nightly.tgz' } },
    ];
    this.plugins = options.plugins || DEFAULT_PLUGINS;
    this.available = options.available || DEFAULT_AVAILABLE;
    const failures = options.failAt
      ? (Array.isArray(options.failAt) ? options.failAt : [options.failAt])
      : [];
    this.failAt = new Set(failures);
    this.delayMs = options.delayMs ?? 0;
    this.snapshotPath = options.snapshotPath || null;
    this.calls = [];
    this.stagedPlan = null;
    this.stagingDecisions = [];
    this.stagingHealthResult = options.stagingHealth || null;
    this.committed = false;
  }

  async getCurrentVersion() {
    this.calls.push('getCurrentVersion');
    return this.currentVersion;
  }

  async check(channel) {
    this.calls.push(`check:${channel}`);
    if (this.failAt.has('check')) throw new UpdateError('UPD-101', { message: 'fake check failure' });
    return this.releases.filter((release) => !release.channel || release.channel === channel);
  }

  async listPlugins() {
    this.calls.push('listPlugins');
    return this.plugins.map((plugin) => ({ ...plugin }));
  }

  async resolvePlugins() {
    this.calls.push('resolvePlugins');
    return this.available;
  }

  async snapshot() {
    this.calls.push('snapshot');
    const path = this.snapshotPath;
    return {
      id: 'snapshot-1',
      path,
      restore: async () => {
        this.calls.push('snapshot:restore');
        if (this.failAt.has('snapshot')) throw new Error('fake snapshot restore failure');
        this.currentVersion = this.previousVersion;
      },
    };
  }

  async prepare(plan, ctx = {}) {
    this.calls.push('prepare');
    this.previousVersion = this.currentVersion;
    this.stagedPlan = plan;
    const signal = ctx.signal;
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : () => {};

    for (let percent = 0; percent <= 100; percent += 10) {
      if (signal && signal.aborted) throw new AbortedError();
      onProgress({ percent, stage: 'download' });
      if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failAt.has('download')) throw new UpdateError('UPD-401', { message: 'fake download failure' });
    if (signal && signal.aborted) throw new AbortedError();

    onProgress({ percent: 100, stage: 'verify' });
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failAt.has('verify')) throw new UpdateError('UPD-402', { message: 'fake integrity failure' });
    if (this.failAt.has('prepare')) throw new UpdateError('UPD-501', { message: 'fake prepare failure' });

    onProgress({ percent: 100, stage: 'stage' });
    return { id: 'staged-1', path: this.snapshotPath ? `${this.snapshotPath}.staging` : null, plan };
  }

  async stagingHealth() {
    this.calls.push('stagingHealth');
    if (typeof this.stagingHealthResult === 'function') return this.stagingHealthResult();
    if (this.stagingHealthResult) return this.stagingHealthResult;
    return { ok: true, checks: ['version', 'dump-config', 'boot'], evidence: { bootLog: 'fake ready' } };
  }

  async applyStagingDecisions(staged, previousPlan = null) {
    this.calls.push('applyStagingDecisions');
    const previous = new Set((previousPlan?.items || [])
      .filter((item) => item.action === 'disable').map((item) => item.name));
    const handles = staged.plan.items
      .filter((item) => item.action === 'disable' && !previous.has(item.name))
      .map((item) => ({ name: item.name, version: item.from, reason: item.reason }));
    this.stagingDecisions.push(...handles);
    return handles;
  }

  async drain(ctx = {}) {
    this.calls.push('drain');
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (ctx.signal && ctx.signal.aborted) throw new AbortedError();
    if (this.failAt.has('drain')) throw new UpdateError('UPD-501', { message: 'fake drain failure' });
    return { ok: true };
  }

  async activate(staged) {
    this.calls.push('activate');
    if (this.failAt.has('activate')) throw new UpdateError('UPD-501', { message: 'fake activate failure' });
    const targetVersion = staged && staged.plan ? staged.plan.targetCore : '0.2.3';
    return {
      id: 'activation-1',
      plan: staged ? staged.plan : null,
      commit: async () => {
        this.calls.push('commit');
        this.committed = true;
        this.currentVersion = targetVersion;
      },
      rollback: async () => {
        this.calls.push('activation:rollback');
        if (this.failAt.has('rollback')) throw new Error('fake rollback failure');
        this.currentVersion = this.previousVersion;
        this.committed = false;
      },
    };
  }

  async health() {
    this.calls.push('health');
    if (this.failAt.has('health')) {
      return { ok: false, checks: ['version', 'plugins'], details: { message: 'fake health failure' } };
    }
    return { ok: true, checks: ['version', 'plugins', 'boot-log'] };
  }

  async rollback(journal) {
    this.calls.push('rollback');
    if (this.failAt.has('rollback')) {
      return { ok: false, mode: 'safe-mode', reason: 'fake rollback failure' };
    }
    this.currentVersion = journal && journal.from ? journal.from : this.previousVersion;
    return { ok: true, mode: 'rolled-back', reason: 'fake rollback' };
  }

  async cleanup() {
    this.calls.push('cleanup');
  }
}
