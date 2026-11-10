import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compare, parse, parseRange, satisfies } from './vendor/semver.mjs';

const CORE_PREFIX = '@deepseek-ai/dsh';
const DEFAULT_FEED = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export function looksLikeCore(name) {
  return typeof name === 'string' && (name === CORE_PREFIX || name.startsWith(`${CORE_PREFIX}-`));
}

export function compat(manifest, targetCore) {
  const target = parse(targetCore);
  if (!target) return { status: 'invalid', reason: 'invalid-target-core' };
  if (!manifest || typeof manifest !== 'object') return { status: 'unknown', reason: 'missing-manifest' };
  if (manifest.engines && typeof manifest.engines === 'object' && manifest.engines.dsh !== undefined) {
    const range = typeof manifest.engines.dsh === 'string' ? manifest.engines.dsh.trim() : '';
    if (!range || range.startsWith('workspace:') || !parseRange(range)) {
      return { status: 'invalid', reason: 'invalid-engines-dsh', range };
    }
    return satisfies(target, range, { includePrerelease: true })
      ? { status: 'ok', range }
      : { status: 'incompatible', reason: 'range-not-satisfied', range };
  }
  const peers = manifest.peerDependencies;
  if (peers && typeof peers === 'object') {
    const entries = Object.entries(peers).filter(([name]) => looksLikeCore(name));
    if (entries.length > 0) {
      let matched = '';
      for (const [name, value] of entries) {
        const range = typeof value === 'string' ? value.trim() : '';
        if (!range || range.startsWith('workspace:') || !parseRange(range)) {
          return { status: 'invalid', reason: `invalid-peer:${name}`, range };
        }
        if (!satisfies(target, range, { includePrerelease: true })) {
          return { status: 'incompatible', reason: `peer-not-satisfied:${name}`, range };
        }
        matched ||= range;
      }
      return { status: 'ok', range: matched };
    }
  }
  return { status: 'unknown', reason: 'no-version-contract' };
}

function pickCompatible(versions, targetCore) {
  const ranked = [];
  for (const entry of versions || []) {
    if (!entry || typeof entry.version !== 'string' || !parse(entry.version) || entry.deprecated) continue;
    const state = compat(entry.manifest, targetCore);
    if (state.status !== 'ok' && state.status !== 'unknown') continue;
    ranked.push({ entry, rank: state.status === 'ok' ? 0 : 1 });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const av = parse(a.entry.version);
    const bv = parse(b.entry.version);
    if (!av || !bv) return 0;
    if ((av.prerelease.length === 0) !== (bv.prerelease.length === 0)) {
      return av.prerelease.length === 0 ? -1 : 1;
    }
    return compare(bv, av);
  });
  return ranked[0] ? ranked[0].entry : null;
}

function parseInstalledVersion(spec) {
  if (typeof spec !== 'string') return null;
  if (parse(spec)) return spec;
  return null;
}

async function readManifest(profileDir, name) {
  try {
    return JSON.parse(await readFile(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function fetchJson(url, timeoutMs = 20000) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-update-core-plugin/0.1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}: ${url}`);
  return response.json();
}

async function readRegistry(file) {
  try {
    const text = await readFile(file, 'utf8');
    const match = text.match(/^\s*registry\s*=\s*(\S+)\s*$/m);
    return match ? match[1].replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

export async function configuredRegistry(profileDir) {
  if (process.env.DSH_UPDATE_REGISTRY) return process.env.DSH_UPDATE_REGISTRY;
  if (process.env.npm_config_registry) return process.env.npm_config_registry;
  for (const file of [join(profileDir, '.npmrc'), join(homedir(), '.npmrc')]) {
    const registry = await readRegistry(file);
    if (registry) return registry;
  }
  return DEFAULT_REGISTRY;
}

export async function resolvePluginVersions(names, registry = DEFAULT_REGISTRY) {
  const result = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor];
      cursor += 1;
      try {
        const packument = await fetchJson(`${registry}/${encodeURIComponent(name)}`);
        result.set(name, Object.entries(packument.versions || {}).map(([version, meta]) => ({
          version,
          deprecated: Boolean(meta && meta.deprecated),
          manifest: meta ? { engines: meta.engines, peerDependencies: meta.peerDependencies } : null,
        })));
      } catch {
        result.set(name, []);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
  return result;
}

function isPluginDependency(name, bundles) {
  if (bundles.has(name)) return true;
  return /^(?:@[^/]+\/)?dsh-/.test(name);
}

export function createPluginPlan(dependencies, installedManifests, available, targetCore, bundles = new Set()) {
  const items = [];
  for (const [name, spec] of Object.entries(dependencies || {})) {
    if (looksLikeCore(name)) continue;
    const from = installedManifests.get(name)?.version || (typeof spec === 'string' ? spec : '');
    if (!isPluginDependency(name, bundles)) {
      items.push({ name, action: 'keep', from, to: null, reason: 'non-plugin-dependency' });
      continue;
    }
    const registry = typeof spec === 'string'
      && !/^(?:file:|link:|git|github:|https?:|workspace:)/.test(spec);
    if (!registry) {
      items.push({ name, action: 'keep', from, to: null, reason: 'non-registry-source' });
      continue;
    }
    const manifest = installedManifests.get(name) || null;
    const currentVersion = manifest?.version || parseInstalledVersion(spec) || '';
    const best = pickCompatible(available.get(name) || [], targetCore);
    if (best && currentVersion && parse(currentVersion) && compare(best.version, currentVersion) > 0) {
      items.push({ name, action: 'update', from: currentVersion, to: best.version, reason: 'compatible-newer-version' });
      continue;
    }
    // Requirement: never disable a plugin merely because its newest release is
    // incompatible. Leave the installed version untouched.
    items.push({
      name,
      action: 'keep',
      from: currentVersion,
      to: null,
      reason: best ? 'already-current' : 'no-compatible-newer-version',
    });
  }
  return {
    targetCore,
    items,
    updates: items.filter((item) => item.action === 'update').length,
    keeps: items.filter((item) => item.action === 'keep').length,
    disables: 0,
    blocked: 0,
  };
}

export async function buildPlan({ profileDir, targetCore, registry }) {
  const effectiveRegistry = registry || await configuredRegistry(profileDir);
  const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
  const dependencies = profile.dependencies && typeof profile.dependencies === 'object' ? profile.dependencies : {};
  const bundles = new Set(Array.isArray(profile.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []);
  const pluginNames = Object.keys(dependencies).filter((name) => !looksLikeCore(name)
    && isPluginDependency(name, bundles)
    && typeof dependencies[name] === 'string'
    && !/^(?:file:|link:|git|github:|https?:|workspace:)/.test(dependencies[name]));
  const available = await resolvePluginVersions(pluginNames, effectiveRegistry);
  const manifests = new Map();
  await Promise.all(Object.keys(dependencies).map(async (name) => {
    const manifest = await readManifest(profileDir, name);
    if (manifest) manifests.set(name, manifest);
  }));
  return createPluginPlan(dependencies, manifests, available, targetCore, bundles);
}

export async function findDesktopExe() {
  const explicit = process.env.DSH_DESKTOP_EXE;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    'C:\\DeepSeek Harness\\DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const script = "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'DeepSeek Harness' } | Select-Object -First 1; if($p){Join-Path $p.InstallLocation 'DeepSeek Harness.exe'}";
  const found = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : stdout.trim());
    });
  });
  return found && existsSync(found) ? found : null;
}

export async function readProductVersion(exe) {
  const escaped = exe.replace(/'/g, "''");
  const script = `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

export async function readDesktopVersion(exe) {
  const script = "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'DeepSeek Harness' } | Select-Object -First 1; if($p){$p.DisplayVersion}";
  const registry = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, DSH_DESKTOP_EXE: exe },
    }, (error, stdout) => resolve(error ? '' : stdout.trim()));
  });
  if (registry && parse(registry)) return registry;
  const product = await readProductVersion(exe);
  const match = product.match(/^(\d+\.\d+\.\d+)/);
  return match ? match[1] : product;
}

export async function checkDesktop({ feedUrl = DEFAULT_FEED, currentVersion, targetCore } = {}) {
  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'dsh-update-core-plugin/0.1.0' } });
  if (!response.ok) throw new Error(`desktop feed HTTP ${response.status}`);
  const text = await response.text();
  const version = (text.match(/^version:\s*['"]?([^'"\r\n]+)['"]?/m) || [])[1];
  const url = (text.match(/^\s*-\s*url:\s*>-\s*\r?\n\s*(\S+)/m) || text.match(/^\s*-\s*url:\s*(\S+)/m) || [])[1];
  if (!version || !parse(version)) throw new Error('desktop feed has no valid version');
  if (targetCore && parse(targetCore) && compare(version, targetCore) < 0) {
    throw new Error(`desktop feed version ${version} is older than requested ${targetCore}`);
  }
  const current = currentVersion || null;
  const update = !current || compare(version, current) > 0;
  return {
    current,
    version,
    update,
    installerUrl: url || null,
    channel: 'nightly',
  };
}

export function defaultPaths(config = {}) {
  const home = config.home || process.env.DSH_HOME || join(homedir(), '.dsh');
  const profileName = config.profile || 'desktop';
  return {
    home,
    profileName,
    profileDir: join(home, 'profiles', profileName),
    updatesDir: join(home, 'updates', 'dsh-update-plugin'),
  };
}

export const DEFAULT_DESKTOP_FEED = DEFAULT_FEED;
export const DEFAULT_NPM_REGISTRY = DEFAULT_REGISTRY;
