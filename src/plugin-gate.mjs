import { parse, compare, satisfies, parseRange, sortStableFirstDesc } from './semver.mjs';
import { readJson, writeJsonAtomic, quarantine } from './json-store.mjs';

export const CORE_PREFIX = '@deepseek-ai/dsh';

/** @param {string} name */
export function looksLikeCore(name) {
  return typeof name === 'string'
    && (name === CORE_PREFIX || name.startsWith(`${CORE_PREFIX}-`));
}

/**
 * @param {{manifest?:Record<string, any>|null, protected?:boolean, kind?:string, name?:string}} plugin
 */
export function isCorePlugin(plugin) {
  return plugin.protected === true
    || plugin.kind === 'core'
    || looksLikeCore(plugin.name || '');
}

/**
 * 四层契约中的版本层：engines.dsh 优先；否则看 @deepseek-ai/dsh* peer。
 * @param {Record<string, any>|null|undefined} manifest
 * @param {string} targetCore
 * @returns {{status:'ok'|'unknown'|'incompatible'|'invalid', range?:string, reason?:string}}
 */
export function compat(manifest, targetCore) {
  const target = parse(targetCore);
  if (!target) return { status: 'invalid', reason: 'invalid-target-core' };
  if (!manifest || typeof manifest !== 'object') return { status: 'unknown', reason: 'missing-manifest' };

  const engines = manifest.engines;
  if (engines !== undefined) {
    if (!engines || typeof engines !== 'object' || Array.isArray(engines)) {
      return { status: 'invalid', reason: 'engines-not-object' };
    }
    if (engines.dsh !== undefined) {
      if (typeof engines.dsh !== 'string') {
        return { status: 'invalid', reason: 'engines-dsh-not-string' };
      }
      const range = engines.dsh.trim();
      if (range === '') return { status: 'invalid', reason: 'empty-range' };
      if (range.startsWith('workspace:')) return { status: 'invalid', reason: 'workspace-range' };
      if (!parseRange(range)) return { status: 'invalid', reason: 'invalid-range' };
      return satisfies(target, range, { includePrerelease: true })
        ? { status: 'ok', range }
        : { status: 'incompatible', range, reason: 'range-not-satisfied' };
    }
  }

  const peers = manifest.peerDependencies;
  if (peers !== undefined) {
    if (!peers || typeof peers !== 'object' || Array.isArray(peers)) {
      return { status: 'invalid', reason: 'peer-dependencies-not-object' };
    }
    const dshPeers = Object.entries(peers).filter(([name]) => looksLikeCore(name));
    if (dshPeers.length > 0) {
      let matchedRange = '';
      for (const [name, range] of dshPeers) {
        if (typeof range !== 'string' || range.trim() === '') {
          return { status: 'invalid', reason: `empty-peer-range:${name}` };
        }
        const trimmed = range.trim();
        if (trimmed.startsWith('workspace:')) {
          matchedRange = matchedRange || trimmed;
          continue;
        }
        if (!parseRange(trimmed)) {
          return { status: 'invalid', reason: `invalid-peer-range:${name}` };
        }
        if (!satisfies(target, trimmed, { includePrerelease: true })) {
          return { status: 'incompatible', range: trimmed, reason: `peer-not-satisfied:${name}` };
        }
        matchedRange = matchedRange || trimmed;
      }
      return { status: 'ok', range: matchedRange };
    }
  }

  return { status: 'unknown', reason: 'no-version-contract' };
}

/**
 * @typedef {{
 *   name:string, version:string, manifest?:Record<string, any>|null,
 *   kind?:'core'|'plugin', protected?:boolean, spec?:'registry'|'link'|'file'|'git',
 *   deprecated?:boolean, yanked?:boolean
 * }} VersionEntry
 */

/**
 * 选取最高兼容版本：稳定版优先于预发布；unknown 契约排在后。
 * @param {VersionEntry[]} versions
 * @param {string} targetCore
 * @returns {VersionEntry|null}
 */
export function pickPluginVersion(versions, targetCore) {
  if (!Array.isArray(versions)) return null;
  const ranked = [];
  for (const entry of versions) {
    if (!entry || typeof entry.version !== 'string' || !parse(entry.version)) continue;
    if (entry.deprecated || entry.yanked) continue;
    const status = compat(entry.manifest ?? entry, targetCore).status;
    if (status !== 'ok' && status !== 'unknown') continue;
    ranked.push({ entry, rank: status === 'ok' ? 0 : 1 });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const pa = parse(a.entry.version);
    const pb = parse(b.entry.version);
    if (!pa || !pb) return 0;
    if ((pa.prerelease.length === 0) !== (pb.prerelease.length === 0)) {
      return pa.prerelease.length === 0 ? -1 : 1;
    }
    return compare(pb, pa);
  });
  return ranked.length ? ranked[0].entry : null;
}

/**
 * @param {Array<Record<string, any>>} installed
 * @param {Record<string, VersionEntry[]>|Map<string, VersionEntry[]>} available
 * @returns {Map<string, VersionEntry[]>}
 */
function normalizeAvailable(available) {
  if (available instanceof Map) return available;
  const map = new Map();
  if (available && typeof available === 'object') {
    for (const [name, versions] of Object.entries(available)) {
      if (Array.isArray(versions)) map.set(name, /** @type {VersionEntry[]} */ (versions));
    }
  }
  return map;
}

export class PluginGate {
  /**
   * @param {{store?:{disable:Function, enable:Function}, verifier?:(item:Record<string, any>)=>Promise<boolean|{ok:boolean,reason?:string}>}} [options]
   */
  constructor(options = {}) {
    this.store = options.store || null;
    this.verifier = options.verifier || null;
  }

  /**
   * @param {string} targetCore
   * @param {Array<Record<string, any>>} installed
   * @param {Record<string, VersionEntry[]>|Map<string, VersionEntry[]>} [available]
   */
  plan(targetCore, installed, available = {}) {
    if (!parse(targetCore)) throw new TypeError(`invalid target core version: ${targetCore}`);
    if (!Array.isArray(installed)) throw new TypeError('installed must be an array');
    const versionsByName = normalizeAvailable(available);
    const items = [];
    const seen = new Set();

    for (const plugin of installed) {
      if (!plugin || typeof plugin.name !== 'string' || plugin.name === '') continue;
      const name = plugin.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const version = typeof plugin.version === 'string' ? plugin.version : '';
      const core = isCorePlugin(plugin);
      const current = compat(plugin.manifest, targetCore);
      const base = { name, from: version, to: null, core, verify: false };

      if (plugin.spec && plugin.spec !== 'registry') {
        const blocked = core && (current.status === 'incompatible' || current.status === 'invalid');
        items.push({
          ...base,
          action: blocked ? 'block' : 'manual',
          reason: blocked ? 'manual-core-incompatible' : `manual:${plugin.spec}`,
        });
        continue;
      }

      const best = pickPluginVersion(versionsByName.get(name) || [], targetCore);
      const currentComparable = parse(version);

      if (best && currentComparable && compare(best.version, currentComparable) > 0) {
        const bestStatus = compat(best.manifest ?? best, targetCore).status;
        items.push({
          ...base,
          action: 'update',
          to: best.version,
          reason: 'compatible-newer-version',
          verify: bestStatus === 'unknown',
        });
        continue;
      }
      if (best && !currentComparable) {
        const bestStatus = compat(best.manifest ?? best, targetCore).status;
        items.push({
          ...base,
          action: 'update',
          to: best.version,
          reason: 'current-version-invalid',
          verify: bestStatus === 'unknown',
        });
        continue;
      }

      if (current.status === 'ok') {
        items.push({ ...base, action: 'keep', to: version, reason: 'already-compatible' });
        continue;
      }
      if (current.status === 'unknown') {
        items.push({ ...base, action: 'keep', to: version, reason: 'no-version-contract', verify: true });
        continue;
      }

      // incompatible / invalid
      if (core) {
        items.push({ ...base, action: 'block', reason: current.reason || 'core-incompatible' });
      } else {
        items.push({ ...base, action: 'disable', reason: current.reason || 'no-compatible-version' });
      }
    }

    return summarize(targetCore, items);
  }

  /**
   * staging 自检回填：未声明范围的插件必须通过验证，否则禁用/阻断。
   * @param {ReturnType<PluginGate['plan']>} plan
   */
  async verify(plan) {
    if (!this.verifier) return plan;
    const items = [];
    for (const item of plan.items) {
      if (!item.verify) {
        items.push(item);
        continue;
      }
      let result;
      try {
        result = await this.verifier(item);
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const ok = result === true || (result && typeof result === 'object' && result.ok === true);
      if (ok) {
        items.push({ ...item, verify: false, reason: 'verified-in-staging' });
      } else if (item.core) {
        items.push({ ...item, action: 'block', verify: false, reason: 'staging-verify-failed' });
      } else {
        items.push({
          ...item,
          action: 'disable',
          verify: false,
          reason: `staging-verify-failed${result && result.reason ? `:${result.reason}` : ''}`,
        });
      }
    }
    return summarize(plan.targetCore, items);
  }

  /**
   * @param {Record<string, any>} plugin
   * @param {string} reason
   */
  async disable(plugin, reason) {
    if (isCorePlugin(plugin)) throw new Error('refusing to disable a core plugin');
    if (!this.store) throw new Error('no plugin store configured');
    return this.store.disable(plugin, reason);
  }

  /** @param {unknown} handle */
  async restore(handle) {
    if (!this.store) throw new Error('no plugin store configured');
    return this.store.enable(handle);
  }
}

/**
 * @param {string} targetCore
 * @param {Array<Record<string, any>>} items
 */
export function summarize(targetCore, items) {
  return {
    targetCore,
    items,
    updates: items.filter((i) => i.action === 'update').length,
    keeps: items.filter((i) => i.action === 'keep').length,
    disables: items.filter((i) => i.action === 'disable').length,
    blocks: items.filter((i) => i.action === 'block').length,
    manuals: items.filter((i) => i.action === 'manual').length,
    verified: items.filter((i) => i.verify).length,
    disabled: items.filter((i) => i.action === 'disable').map((i) => i.name),
  };
}

/**
 * 参考 profile 存储：只记录 disabled 名称与恢复信息，不改用户 node_modules。
 */
export class JsonPluginStore {
  /** @param {{file:string}} options */
  constructor(options) {
    this.file = options.file;
  }

  async read() {
    let data;
    try {
      data = await readJson(this.file);
    } catch {
      await quarantine(this.file).catch(() => {});
      data = null;
    }
    if (!data) return { schema: 1, disabled: {} };
    if (typeof data !== 'object' || data.schema !== 1 || typeof data.disabled !== 'object') {
      await quarantine(this.file).catch(() => {});
      return { schema: 1, disabled: {} };
    }
    return data;
  }

  /**
   * @param {{name:string, version?:string}} plugin
   * @param {string} reason
   */
  async disable(plugin, reason) {
    const data = await this.read();
    const disabledAt = new Date().toISOString();
    data.disabled[plugin.name] = {
      version: plugin.version || '',
      reason,
      disabledAt,
    };
    await writeJsonAtomic(this.file, data);
    return { name: plugin.name, version: plugin.version || '', reason, disabledAt };
  }

  /** @param {{name:string}|string} handle */
  async enable(handle) {
    const name = typeof handle === 'string' ? handle : handle && handle.name;
    if (!name) throw new TypeError('enable requires a plugin name');
    const data = await this.read();
    delete data.disabled[name];
    await writeJsonAtomic(this.file, data);
    return { name };
  }

  async list() {
    const data = await this.read();
    return data.disabled;
  }
}

export { sortStableFirstDesc };
