import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { UpdateError, AbortedError } from '../errors.mjs';
import { looksLikeCore } from '../plugin-gate.mjs';
import { parse } from '../semver.mjs';
import { runCommand, killTree } from '../platform/process.mjs';
import { ProfileStore } from '../profile-store.mjs';

/**
 * 校验 npm dist.integrity（SRI，通常是 sha512-<base64>）。
 * @param {Buffer} buffer
 * @param {string} integrity
 * @returns {boolean}
 */
export function verifyIntegrity(buffer, integrity) {
  if (!Buffer.isBuffer(buffer) || typeof integrity !== 'string' || integrity.trim() === '') return false;
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/.exec(token);
    if (!match) continue;
    const algorithm = match[1];
    const expected = Buffer.from(match[2], 'base64');
    const actual = createHash(algorithm).update(buffer).digest();
    if (expected.length !== actual.length) continue;
    if (timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function evidenceTail(text, maxLines = 200) {
  return String(text || '').split(/\r?\n/).slice(-maxLines).join('\n');
}

async function copyIfPresent(source, target) {
  if (!(await exists(source))) return false;
  await cp(source, target, { force: true, dereference: true });
  return true;
}

function assertSafeRegistry(registry) {
  let url;
  try {
    url = new URL(registry);
  } catch {
    throw new TypeError(`invalid registry URL: ${registry}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.username || url.password) throw new TypeError('registry URL must not contain credentials');
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TypeError('registry must use https (http is only allowed for localhost)');
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * 真实 npm 后端：读取 registry、校验完整性、在 staging 安装、原子切换 profile。
 * installer 可注入，便于离线测试；默认执行 npm install --ignore-scripts。
 */
export class NpmBackend {
  /**
   * @param {{
   *   home:string, profileName?:string, registry?:string, packageName?:string,
   *   channelTags?:Record<string,string>, fetchImpl?:Function, installer?:Function,
   *   healthCheck?:Function, timeoutMs?:number, clock?:()=>number
   * }} options
   */
  constructor(options) {
    if (!options || !options.home) throw new TypeError('NpmBackend requires home');
    this.kind = 'npm-global';
    this.home = options.home;
    this.profileName = options.profileName || 'web';
    this.registry = assertSafeRegistry(options.registry || 'https://registry.npmjs.org');
    this.packageName = options.packageName || '@deepseek-ai/dsh';
    this.channelTags = options.channelTags || { stable: 'latest', nightly: 'nightly' };
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.installer = options.installer || ((ctx) => runCommand(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'],
      ctx,
    ));
    this.healthCheck = options.healthCheck || null;
    this.stagingHealthCheck = options.stagingHealthCheck || null;
    this.stagingReadyMs = options.stagingReadyMs ?? 3000;
    this.profileStoreFactory = options.profileStoreFactory
      || ((profileDir) => new ProfileStore({ profileDir }));
    this.timeoutMs = options.timeoutMs || 20000;
    this.clock = options.clock || Date.now;
    this.profileDir = join(this.home, 'profiles', this.profileName);
    this.stagingRoot = join(this.home, 'updates', 'staging');
    this.backupRoot = join(this.home, 'updates', 'backup');
    this.release = null;
    this.releases = new Map();
  }

  /** @param {string} path */
  async fetchJson(path) {
    if (typeof this.fetchImpl !== 'function') {
      throw new UpdateError('UPD-101', { message: 'no fetch implementation available' });
    }
    const url = `${this.registry}/${path}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-update-core/0.1.0' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new UpdateError('UPD-101', { message: `registry request failed: ${url}`, cause: error });
    }
    if (!response || response.ok === false) {
      throw new UpdateError('UPD-101', {
        message: `registry responded ${response ? response.status : 'no response'} for ${path}`,
      });
    }
    try {
      return await response.json();
    } catch (error) {
      throw new UpdateError('UPD-102', { message: `registry returned invalid JSON for ${path}`, cause: error });
    }
  }

  /** @param {string} name */
  async fetchPackument(name) {
    return this.fetchJson(encodeURIComponent(name));
  }

  async getCurrentVersion() {
    const manifestPath = join(this.profileDir, 'node_modules', ...this.packageName.split('/'), 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // fall through to profile package.json
    }
    const profile = await this.readProfileManifest();
    const pinned = profile.dependencies && profile.dependencies[this.packageName];
    if (typeof pinned === 'string' && parse(pinned)) return pinned;
    throw new UpdateError('UPD-702', {
      message: `cannot determine installed version of ${this.packageName}`,
      details: { profile: this.profileDir },
    });
  }

  async readProfileManifest() {
    const file = join(this.profileDir, 'package.json');
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return data && typeof data === 'object' ? data : { dependencies: {} };
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { dependencies: {} };
      throw new UpdateError('UPD-102', { message: `invalid profile package.json: ${file}`, cause: error });
    }
  }

  async listPlugins() {
    const profile = await this.readProfileManifest();
    const dependencies = profile.dependencies
      && typeof profile.dependencies === 'object'
      && !Array.isArray(profile.dependencies)
      ? profile.dependencies
      : {};
    const plugins = [];
    for (const [name, range] of Object.entries(dependencies)) {
      if (name === this.packageName) continue;
      let manifest = null;
      try {
        manifest = JSON.parse(await readFile(join(this.profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
      } catch {
        manifest = null;
      }
      const rawRange = typeof range === 'string' ? range : '';
      const spec = rawRange.startsWith('link:') ? 'link'
        : rawRange.startsWith('file:') ? 'file'
          : /^(git|github|https?:)/.test(rawRange) ? 'git'
            : 'registry';
      const version = manifest && typeof manifest.version === 'string'
        ? manifest.version
        : (parse(rawRange) ? rawRange : '');
      plugins.push({
        name,
        version,
        kind: looksLikeCore(name) ? 'core' : 'plugin',
        protected: looksLikeCore(name),
        spec,
        manifest: manifest ? { engines: manifest.engines, peerDependencies: manifest.peerDependencies } : null,
      });
    }
    return plugins;
  }

  async check(channel) {
    const tag = this.channelTags[channel];
    if (!tag) throw new UpdateError('UPD-103', { message: `unsupported channel: ${channel}` });
    const packument = await this.fetchPackument(this.packageName);
    const version = packument && packument['dist-tags'] && packument['dist-tags'][tag];
    if (typeof version !== 'string' || !parse(version)) {
      throw new UpdateError('UPD-103', { message: `dist-tag ${tag} is missing or invalid` });
    }
    const entry = packument.versions && packument.versions[version];
    if (!entry) throw new UpdateError('UPD-102', { message: `release ${version} missing from packument` });
    const integrity = entry.dist && entry.dist.integrity;
    if (typeof integrity !== 'string' || !/^sha(256|384|512)-/.test(integrity)) {
      throw new UpdateError('UPD-402', { message: `release ${version} has no usable integrity` });
    }
    const release = {
      version,
      channel,
      dist: {
        tarball: entry.dist.tarball,
        integrity,
        size: entry.dist.unpackedSize || entry.dist.size || null,
      },
      engines: entry.engines,
      publishedAt: packument.time && packument.time[version],
    };
    this.release = release;
    this.releases.set(release.version, release);
    while (this.releases.size > 10) {
      this.releases.delete(this.releases.keys().next().value);
    }
    return [release];
  }

  /**
   * 并行拉取插件版本清单；单个失败不阻断整体（交由 gate 判定禁用/阻断）。
   * @param {Record<string, any>} release
   * @param {Array<Record<string, any>>} installed
   */
  async resolvePlugins(release, installed) {
    const out = {};
    const queue = installed.filter((plugin) => plugin.spec === 'registry' && !looksLikeCore(plugin.name));
    const concurrency = 4;
    let index = 0;
    const worker = async () => {
      while (index < queue.length) {
        const current = queue[index];
        index += 1;
        try {
          const packument = await this.fetchPackument(current.name);
          const versions = Object.entries(packument.versions || {}).map(([version, meta]) => ({
            version,
            deprecated: Boolean(meta && meta.deprecated),
            yanked: false,
            manifest: meta ? { engines: meta.engines, peerDependencies: meta.peerDependencies } : null,
          }));
          out[current.name] = versions;
        } catch {
          out[current.name] = [];
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return out;
  }

  async snapshot() {
    if (!(await exists(this.profileDir))) return null;
    const id = `${this.clock()}-${randomBytes(3).toString('hex')}`;
    const path = join(this.backupRoot, `${this.profileName}-${id}`);
    await mkdir(this.backupRoot, { recursive: true });
    await cp(this.profileDir, path, { recursive: true, force: true });
    return {
      id,
      path,
      restore: async () => {
        const failed = `${this.profileDir}.failed-${id}`;
        if (await exists(this.profileDir)) await rename(this.profileDir, failed);
        await cp(path, this.profileDir, { recursive: true, force: true });
      },
    };
  }

  /**
   * @param {Record<string, any>} plan
   * @param {{onProgress?:Function, signal?:AbortSignal}} ctx
   */
  async prepare(plan, ctx = {}) {
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.items)) {
      throw new TypeError('prepare requires a plan with items');
    }
    const release = this.releases.get(plan.targetCore) || this.release;
    if (!release) throw new UpdateError('UPD-103', { message: 'call check() before prepare()' });
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : () => {};
    const id = `${this.clock()}-${randomBytes(3).toString('hex')}`;
    const stagingHome = join(this.stagingRoot, id, 'home');
    const staging = join(stagingHome, 'profiles', this.profileName);
    await mkdir(join(staging, '.artifacts'), { recursive: true });

    try {
      onProgress({ percent: 5, stage: 'download' });
      const tarball = await this.downloadTarball(release, ctx.signal);
      onProgress({ percent: 40, stage: 'download' });
      await writeFile(join(staging, '.artifacts', 'dsh.tgz'), tarball);
      if (!verifyIntegrity(tarball, release.dist.integrity)) {
        throw new UpdateError('UPD-402', { message: 'integrity check failed' });
      }
      if (ctx.signal && ctx.signal.aborted) throw new AbortedError();
      onProgress({ percent: 60, stage: 'verify' });

      const profile = await this.readProfileManifest();
      for (const file of [
        'cordis.patch.yml', 'restore.json', 'compatibility.json',
        'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      ]) {
        await copyIfPresent(join(this.profileDir, file), join(staging, file));
      }
      const dependencies = { ...(profile.dependencies || {}) };
      dependencies[this.packageName] = release.version;
      for (const item of plan.items || []) {
        if (item.action === 'update' && item.to) dependencies[item.name] = item.to;
      }
      const nextManifest = {
        ...profile,
        name: profile.name || `dsh-profile-${this.profileName}`,
        private: true,
        dependencies,
      };
      await writeFile(join(staging, 'package.json'), `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
      await writeFile(join(staging, 'plugins.json'), `${JSON.stringify({
        schema: 1,
        disabled: Object.fromEntries((plan.items || [])
          .filter((item) => item.action === 'disable')
          .map((item) => [item.name, { version: item.from, reason: item.reason || 'no-compatible-version', disabledAt: new Date().toISOString() }])),
      }, null, 2)}\n`, 'utf8');

      onProgress({ percent: 70, stage: 'stage' });
      await this.installer({
        cwd: staging,
        signal: ctx.signal,
        timeoutMs: 180000,
        packageName: this.packageName,
        version: release.version,
      });
      await this.applyStagingDecisions({ path: staging, plan });
      onProgress({ percent: 95, stage: 'stage' });
      return { id, path: staging, home: stagingHome, plan };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * 将新的禁用决定写入 staging patch；不触碰正式 profile。
   * @param {{path:string, plan:Record<string, any>}} staged
   * @param {Record<string, any>|null} [previousPlan]
   */
  async applyStagingDecisions(staged, previousPlan = null) {
    const previous = new Set((previousPlan?.items || [])
      .filter((item) => item.action === 'disable').map((item) => item.name));
    const store = this.profileStoreFactory(staged.path);
    const handles = [];
    for (const item of staged.plan.items || []) {
      if (item.action !== 'disable' || previous.has(item.name)) continue;
      handles.push(await store.disable(
        { name: item.name, version: item.from, kind: item.core ? 'core' : 'plugin', protected: item.core },
        item.reason || 'staging-verify-failed',
      ));
    }
    return handles;
  }

  /**
   * staging 的版本、组合配置与短时启动探测。所有命令都使用隔离 DSH_HOME。
   * @param {string} profilePath
   * @param {{home?:string, plan?:Record<string, any>, signal?:AbortSignal}} [ctx]
   */
  async stagingHealth(profilePath, ctx = {}) {
    if (this.stagingHealthCheck) return this.stagingHealthCheck(profilePath, ctx);
    const home = ctx.home || join(profilePath, '..', '..', '..');
    const bin = join(profilePath, 'node_modules', ...this.packageName.split('/'), 'lib', 'bin.js');
    const evidence = { version: '', dumpConfig: '', bootLog: '' };
    try {
      if (!(await exists(bin))) throw new Error(`dsh launcher missing: ${bin}`);
      const version = await runCommand(process.execPath, [bin, '--version'], {
        cwd: home,
        signal: ctx.signal,
        timeoutMs: Math.min(this.timeoutMs, 30000),
      });
      evidence.version = evidenceTail(`${version.stdout}\n${version.stderr}`);
      const expected = ctx.plan && ctx.plan.targetCore;
      if (expected && !version.stdout.includes(expected)) {
        return { ok: false, reason: `staging version mismatch: expected ${expected}`, checks: ['version'], evidence };
      }
      const dump = await runCommand(process.execPath, [bin, '--profile', this.profileName, '--dump-config'], {
        cwd: home,
        signal: ctx.signal,
        timeoutMs: Math.min(this.timeoutMs, 30000),
        env: { DSH_HOME: home },
      });
      evidence.dumpConfig = evidenceTail(`${dump.stdout}\n${dump.stderr}`);
      const boot = await this.probeStagingBoot(bin, home, ctx.signal);
      evidence.bootLog = evidenceTail(`${boot.stdout}\n${boot.stderr}`);
      const result = {
        ok: boot.ok,
        reason: boot.ok ? undefined : `staging boot exited with ${boot.code}`,
        checks: ['version', 'dump-config', 'boot'],
        evidence,
      };
      const candidates = (ctx.plan?.items || []).filter((item) => item.verify);
      if (!boot.ok && candidates.length === 1) result.plugin = candidates[0].name;
      return result;
    } catch (error) {
      const result = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        checks: ['version', 'dump-config', 'boot'],
        evidence,
      };
      const candidates = (ctx.plan?.items || []).filter((item) => item.verify);
      if (candidates.length === 1) result.plugin = candidates[0].name;
      return result;
    }
  }

  async probeStagingBoot(bin, home, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, '--profile', this.profileName], {
        cwd: home,
        env: { ...process.env, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = async (ok, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (code === null) await killTree(child, { graceMs: 250 }).catch(() => {});
        resolve({ ok, code, stdout: evidenceTail(stdout), stderr: evidenceTail(stderr) });
      };
      const onAbort = () => {
        void finish(false, null).then(() => reject(new AbortedError()));
      };
      const timer = setTimeout(() => { void finish(true, null); }, this.stagingReadyMs);
      child.stdout.on('data', (chunk) => { stdout = evidenceTail(stdout + chunk.toString()); });
      child.stderr.on('data', (chunk) => { stderr = evidenceTail(stderr + chunk.toString()); });
      child.once('error', (error) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => { void finish(code === 0, code); });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (signal && signal.aborted) onAbort();
    });
  }

  /** @param {Record<string, any>} release @param {AbortSignal} [signal] */
  async downloadTarball(release, signal) {
    const url = release && release.dist && release.dist.tarball;
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      throw new UpdateError('UPD-402', { message: 'release tarball must be an https URL' });
    }
    const response = await this.fetchImpl(url, {
      headers: { 'user-agent': 'dsh-update-core/0.1.0' },
      signal: signal || AbortSignal.timeout(this.timeoutMs * 6),
    });
    if (!response || response.ok === false) {
      throw new UpdateError('UPD-401', { message: `tarball download failed: ${url}` });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new UpdateError('UPD-401', { message: 'tarball is empty' });
    return buffer;
  }

  async drain(ctx = {}) {
    if (ctx.signal && ctx.signal.aborted) throw new AbortedError();
    return { ok: true, tasks: 0 };
  }

  /** @param {{id:string, path:string, plan:Record<string, any>}} staged */
  async activate(staged) {
    if (!staged || typeof staged.path !== 'string'
      || !staged.plan || typeof staged.plan.targetCore !== 'string') {
      throw new UpdateError('UPD-501', { message: 'invalid staged update' });
    }
    const previous = `${this.profileDir}.old-${staged.id}`;
    let moved = false;
    try {
      if (await exists(this.profileDir)) {
        await rename(this.profileDir, previous);
        moved = true;
      }
      await rename(staged.path, this.profileDir);
    } catch (error) {
      if (moved) await rename(previous, this.profileDir).catch(() => {});
      throw new UpdateError('UPD-501', { message: 'failed to activate staged profile', cause: error });
    }
    return {
      id: staged.id,
      plan: staged.plan,
      commit: async () => {
        await rm(previous, { recursive: true, force: true }).catch(() => {});
      },
      rollback: async () => {
        if (await exists(this.profileDir)) {
          await rename(this.profileDir, `${this.profileDir}.failed-${staged.id}`).catch(() => {});
        }
        if (moved) {
          await rename(previous, this.profileDir);
        } else {
          // 首次安装没有上一版：回滚即移除新 profile。
          await rm(this.profileDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  }

  async health(handle) {
    if (this.healthCheck) return this.healthCheck(handle);
    const target = handle && handle.plan && handle.plan.targetCore;
    const checks = [];
    let versionOk = false;
    try {
      const manifest = JSON.parse(await readFile(
        join(this.profileDir, 'node_modules', ...this.packageName.split('/'), 'package.json'),
        'utf8',
      ));
      versionOk = !target || manifest.version === target;
      checks.push(`version:${manifest.version}`);
    } catch (error) {
      checks.push('version:missing');
    }
    let pluginsOk = true;
    try {
      await this.profileStoreFactory(this.profileDir).list();
      checks.push('plugins:patch-readable');
    } catch {
      pluginsOk = false;
      checks.push('plugins:patch-invalid');
    }
    return { ok: versionOk && pluginsOk, checks };
  }

  /** @param {Record<string, any>} journal */
  async rollback(journal) {
    const snapshot = journal && journal.snapshot;
    if (typeof snapshot !== 'string' || !(await exists(snapshot))) {
      return { ok: false, mode: 'safe-mode', reason: 'snapshot-missing' };
    }
    const backupRoot = resolve(this.backupRoot) + sep;
    if (!resolve(snapshot).startsWith(backupRoot)) {
      return { ok: false, mode: 'safe-mode', reason: 'snapshot-outside-backup-root' };
    }
    try {
      const failed = `${this.profileDir}.failed-${this.clock()}`;
      if (await exists(this.profileDir)) await rename(this.profileDir, failed);
      await cp(snapshot, this.profileDir, { recursive: true, force: true });
      return { ok: true, mode: 'rolled-back', reason: 'snapshot-restored' };
    } catch (error) {
      return { ok: false, mode: 'safe-mode', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async cleanup() {
    const cutoff = this.clock() - 7 * 24 * 60 * 60 * 1000;
    try {
      const { readdir, stat } = await import('node:fs/promises');
      const entries = await readdir(this.stagingRoot, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        const path = join(this.stagingRoot, entry.name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
        } catch {
          // ignore races
        }
      }));
    } catch {
      // staging may not exist
    }
  }
}
