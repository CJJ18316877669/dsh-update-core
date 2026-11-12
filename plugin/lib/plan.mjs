import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compare, parse, parseRange, satisfies } from './vendor/semver.mjs';
import { PLUGIN_USER_AGENT } from './version.mjs';

const CORE_PREFIX = '@deepseek-ai/dsh';
const DEFAULT_FEED = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml';
export const DESKTOP_FEEDS = Object.freeze({
  nightly: DEFAULT_FEED,
  // No stable feed has been published yet. Stable installations are kept on
  // their current core until an official stable feed can be configured.
  stable: null,
});
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export function channelForVersion(version) {
  const parsed = parse(version);
  if (!parsed) return null;
  return parsed.prerelease.length > 0 ? 'nightly' : 'stable';
}

export function feedForChannel(channel) {
  return DESKTOP_FEEDS[channel] || null;
}

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
        if (!range) return { status: 'invalid', reason: `invalid-peer:${name}`, range };
        if (range.startsWith('workspace:')) {
          matched ||= range;
          continue;
        }
        if (!parseRange(range)) return { status: 'invalid', reason: `invalid-peer:${name}`, range };
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

export function normalizeRepo(value) {
  if (!value) return null;
  const raw = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' && typeof value.url === 'string' ? value.url : null);
  if (!raw) return null;
  const match = raw.match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[#/].*)?$/i);
  if (match) return `${match[1]}/${match[2]}`.toLowerCase();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return raw.toLowerCase();
  return null;
}

export function repositoryOf(manifest) {
  return normalizeRepo(manifest && manifest.repository);
}

export function githubRepoFromSpec(spec) {
  if (typeof spec !== 'string') return null;
  let value = spec.trim();
  if (value.startsWith('github:')) value = value.slice(7);
  value = value.replace(/^git\+/, '').replace(/^git:/, '');
  if (value.startsWith('https://github.com/') || value.startsWith('http://github.com/')) {
    value = value.replace(/^https?:\/\/github\.com\//, '');
    value = value.replace(/#.*$/, '').replace(/\.git$/, '').replace(/\/$/, '');
    const parts = value.split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`.toLowerCase();
    return null;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/.test(value)) {
    return value.replace(/#.*$/, '').toLowerCase();
  }
  return null;
}

function withGitRef(spec, ref) {
  if (typeof spec !== 'string' || !ref) return spec;
  const base = spec.replace(/#.*$/, '');
  return `${base}#${ref}`;
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
  if (!ranked[0]) return null;
  return {
    ...ranked[0].entry,
    compatibility: ranked[0].rank === 0 ? 'ok' : 'unknown',
  };
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
    headers: { accept: 'application/json', 'user-agent': PLUGIN_USER_AGENT },
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

function normalizeRegistryUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`registry URL 无效：${String(value)}`);
  }
  if (parsed.username || parsed.password) throw new Error('registry URL 不能包含凭据');
  if (parsed.protocol !== 'https:') {
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      throw new Error(`registry 必须使用 HTTPS：${parsed.hostname}`);
    }
  }
  return parsed.toString().replace(/\/+$/, '');
}

export async function resolvePluginVersions(names, registry = DEFAULT_REGISTRY, errors = new Map()) {
  const result = new Map();
  const base = normalizeRegistryUrl(registry);
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor];
      cursor += 1;
      try {
        const packument = await fetchJson(`${base}/${encodeURIComponent(name)}`);
        result.set(name, Object.entries(packument.versions || {}).map(([version, meta]) => ({
          version,
          deprecated: Boolean(meta && meta.deprecated),
          repository: meta?.repository || packument.repository || null,
          manifest: meta ? { engines: meta.engines, peerDependencies: meta.peerDependencies } : null,
        })));
      } catch (error) {
        result.set(name, []);
        errors.set(name, error instanceof Error ? error.message : String(error));
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

function installedCompatibility(manifest, targetCore) {
  if (!manifest) return 'unknown';
  return compat(manifest, targetCore).status;
}

function isVersionUpgrade(candidate, currentVersion) {
  return Boolean(
    candidate
    && typeof candidate.version === 'string'
    && currentVersion
    && parse(currentVersion)
    && compare(candidate.version, currentVersion) > 0,
  );
}

export function createPluginPlan(dependencies, installedManifests, available, targetCore, bundles = new Set(), options = {}) {
  const ignored = options.ignored instanceof Map ? options.ignored : new Map();
  const github = options.github instanceof Map ? options.github : new Map();
  const sourceErrors = options.sourceErrors instanceof Map ? options.sourceErrors : new Map();
  const items = [];
  for (const [name, spec] of Object.entries(dependencies || {})) {
    if (looksLikeCore(name)) continue;
    const manifest = installedManifests.get(name) || null;
    const from = manifest?.version || (typeof spec === 'string' ? spec : '');
    if (!isPluginDependency(name, bundles)) {
      items.push({ name, action: 'keep', from, to: null, reason: 'non-plugin-dependency' });
      continue;
    }
    const sourceError = sourceErrors.get(name);
    if (sourceError) {
      items.push({
        name,
        action: 'keep',
        from,
        to: null,
        reason: 'source-check-failed',
        sourceError,
      });
      continue;
    }
    const registry = typeof spec === 'string'
      && !/^(?:file:|link:|git|github:|https?:|workspace:)/.test(spec);
    const currentVersion = manifest?.version || parseInstalledVersion(spec) || '';
    const installedRepo = repositoryOf(manifest);

    if (!registry) {
      const githubInfo = github.get(name);
      if (!githubInfo || !Array.isArray(githubInfo.versions)) {
        items.push({ name, action: 'keep', from, to: null, reason: 'non-registry-source' });
        continue;
      }
      const specRepo = githubRepoFromSpec(spec);
      if (installedRepo && specRepo && installedRepo !== specRepo) {
        items.push({ name, action: 'keep', from, to: null, reason: 'repository-mismatch' });
        continue;
      }
      const best = pickCompatible(githubInfo.versions, targetCore);
      if (best && best.version === ignored.get(name)) {
        items.push({ name, action: 'keep', from: currentVersion, to: null, reason: 'ignored-version' });
        continue;
      }
      if (best && best.compatibility !== 'ok') {
        if (isVersionUpgrade(best, currentVersion)) {
          items.push({
            name,
            action: 'keep',
            from: currentVersion,
            to: null,
            candidateVersion: best.version,
            compatibility: 'unknown',
            reason: 'unverified-compatibility',
          });
        } else {
          items.push({ name, action: 'keep', from: currentVersion, to: null, reason: 'already-current' });
        }
        continue;
      }
      if (isVersionUpgrade(best, currentVersion)) {
        items.push({
          name,
          action: 'update',
          from: currentVersion,
          to: withGitRef(spec, best.ref || best.version),
          version: best.version,
          source: 'github',
          reason: 'compatible-newer-version',
        });
        continue;
      }
      items.push({
        name,
        action: 'keep',
        from: currentVersion,
        to: null,
        reason: best ? 'already-current' : 'no-compatible-newer-version',
      });
      continue;
    }

    const best = pickCompatible(available.get(name) || [], targetCore);
    if (!best) {
      items.push({ name, action: 'keep', from: currentVersion, to: null, reason: 'no-compatible-newer-version' });
      continue;
    }
    if (best.version === ignored.get(name)) {
      items.push({ name, action: 'keep', from: currentVersion, to: null, reason: 'ignored-version' });
      continue;
    }
    const bestRepo = normalizeRepo(best.repository);
    if (installedRepo && bestRepo && installedRepo !== bestRepo) {
      items.push({ name, action: 'keep', from: currentVersion, to: null, reason: 'repository-mismatch' });
      continue;
    }
    if (best.compatibility !== 'ok') {
      if (isVersionUpgrade(best, currentVersion)) {
        items.push({
          name,
          action: 'keep',
          from: currentVersion,
          to: null,
          candidateVersion: best.version,
          compatibility: 'unknown',
          reason: 'unverified-compatibility',
        });
      } else {
        items.push({ name, action: 'keep', from: currentVersion, to: null, reason: 'already-current' });
      }
      continue;
    }
    if (isVersionUpgrade(best, currentVersion)) {
      items.push({ name, action: 'update', from: currentVersion, to: best.version, source: 'registry', reason: 'compatible-newer-version' });
      continue;
    }
    // Requirement: never disable a plugin merely because its newest release is
    // incompatible. Leave the installed version untouched.
    items.push({
      name,
      action: 'keep',
      from: currentVersion,
      to: null,
      reason: 'already-current',
    });
  }
  for (const item of items) {
    item.installedCompatibility = installedCompatibility(installedManifests.get(item.name), targetCore);
  }
  const sourceWarnings = items
    .filter((item) => item.sourceError)
    .map((item) => ({ name: item.name, message: item.sourceError }));
  const unverifiedTargets = items
    .filter((item) => item.reason === 'unverified-compatibility')
    .map((item) => ({
      name: item.name,
      installed: item.from,
      candidate: item.candidateVersion,
    }));
  return {
    targetCore,
    items,
    sourceWarnings,
    unverifiedTargets,
    updates: items.filter((item) => item.action === 'update').length,
    keeps: items.filter((item) => item.action === 'keep').length,
    disables: 0,
    blocked: 0,
    incompatibleInstalled: items.filter((item) => (
      item.action !== 'update'
      && !looksLikeCore(item.name)
      && isPluginDependency(item.name, bundles)
      && (item.installedCompatibility === 'incompatible' || item.installedCompatibility === 'invalid')
    )).length,
    blockers: items
      .filter((item) => (
        item.action !== 'update'
        && !looksLikeCore(item.name)
        && isPluginDependency(item.name, bundles)
        && (item.installedCompatibility === 'incompatible' || item.installedCompatibility === 'invalid')
      ))
      .map((item) => ({
        name: item.name,
        version: item.from,
        status: item.installedCompatibility,
        reason: 'installed-incompatible',
      })),
  };
}

const githubCache = new Map();

async function readGithubCache(file) {
  if (!file) return { schema: 1, repos: {} };
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && data.schema === 1 && data.repos && typeof data.repos === 'object'
      ? data
      : { schema: 1, repos: {} };
  } catch {
    return { schema: 1, repos: {} };
  }
}

async function writeGithubCache(file, data) {
  if (!file) return;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch { /* cache is best-effort */ }
}

export async function resolveGithubVersions(repo, expectedName, token, cacheFile) {
  if (!repo) return { versions: [] };
  token ||= process.env.DSH_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const cacheKey = `${repo}#${expectedName}`;
  const disk = await readGithubCache(cacheFile);
  const stored = disk.repos[cacheKey] || disk.repos[repo];
  const cached = githubCache.get(cacheKey) || githubCache.get(repo);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  if (!cached && stored && Date.now() - Date.parse(stored.at || '') < 5 * 60_000) {
    githubCache.set(cacheKey, { at: Date.now(), value: stored.value });
    return stored.value;
  }
  const fallback = cached?.value || stored?.value || null;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': PLUGIN_USER_AGENT,
    'x-github-api-version': '2022-11-28',
    ...(stored?.etag ? { 'if-none-match': stored.etag } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let refs = [];
  let etag = stored?.etag || null;
  let catalogSucceeded = false;
  let lastFailure = '';
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers, signal: AbortSignal.timeout(20000),
    });
    if (response.status === 304 && fallback) {
      githubCache.set(cacheKey, { at: Date.now(), value: fallback });
      return fallback;
    }
    if (response.status === 403 && fallback) {
      // Rate limited: keep using the last verified catalog.
      githubCache.set(cacheKey, { at: Date.now(), value: fallback });
      return fallback;
    }
    if (response.ok) {
      catalogSucceeded = true;
      etag = response.headers.get('etag') || etag;
      const releases = await response.json();
      refs = releases
        .filter((release) => !release.draft && !release.prerelease)
        .map((release) => ({ ref: release.tag_name, version: String(release.tag_name || '').replace(/^v/i, '') }))
        .filter((entry) => parse(entry.version));
    } else {
      lastFailure = `GitHub releases HTTP ${response.status}`;
    }
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  }
  if (refs.length === 0) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=30`, {
        headers, signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        catalogSucceeded = true;
        refs = (await response.json()).map((tag) => ({
          ref: tag.name,
          version: String(tag.name || '').replace(/^v/i, ''),
        })).filter((entry) => parse(entry.version));
      } else {
        lastFailure = `GitHub tags HTTP ${response.status}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  if (refs.length === 0 && !catalogSucceeded) {
    if (fallback) {
      githubCache.set(cacheKey, { at: Date.now(), value: fallback });
      return fallback;
    }
    throw new Error(`无法检查 GitHub 插件 ${expectedName}：${lastFailure || 'unknown error'}`);
  }
  const versions = [];
  let rawAttempts = 0;
  let rawResponded = 0;
  let rawFailure = '';
  for (const entry of refs.slice(0, 12)) {
    rawAttempts += 1;
    try {
      const raw = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(entry.ref)}/package.json`, {
        signal: AbortSignal.timeout(15000), headers: { 'user-agent': PLUGIN_USER_AGENT },
      });
      rawResponded += 1;
      if (!raw.ok) continue;
      const manifest = await raw.json();
      if (manifest.name !== expectedName || manifest.version !== entry.version) continue;
      versions.push({ version: entry.version, ref: entry.ref, repository: repo, manifest });
    } catch (error) {
      rawFailure = error instanceof Error ? error.message : String(error);
    }
  }
  if (rawAttempts > 0 && rawResponded === 0) {
    if (fallback) {
      githubCache.set(cacheKey, { at: Date.now(), value: fallback });
      return fallback;
    }
    throw new Error(`无法读取 GitHub 插件 ${expectedName} 的 package.json：${rawFailure || 'unknown error'}`);
  }
  const value = { versions };
  githubCache.set(cacheKey, { at: Date.now(), value });
  await writeGithubCache(cacheFile, {
    schema: 1,
    repos: { ...disk.repos, [cacheKey]: { at: new Date().toISOString(), etag, value } },
  });
  return value;
}

export async function buildPlan({ profileDir, targetCore, registry, ignored = new Map(), githubToken, cacheFile }) {
  const effectiveRegistry = registry || await configuredRegistry(profileDir);
  const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
  const dependencies = profile.dependencies && typeof profile.dependencies === 'object' ? profile.dependencies : {};
  const bundles = new Set(Array.isArray(profile.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []);
  const manifests = new Map();
  await Promise.all(Object.keys(dependencies).map(async (name) => {
    const manifest = await readManifest(profileDir, name);
    if (manifest) manifests.set(name, manifest);
  }));
  const plugins = Object.keys(dependencies).filter((name) => !looksLikeCore(name)
    && isPluginDependency(name, bundles)
    && typeof dependencies[name] === 'string');
  const pluginNames = plugins.filter((name) => !/^(?:file:|link:|git|github:|https?:|workspace:)/.test(dependencies[name]));
  const externalNames = plugins.filter((name) => /^(?:git|github:|https?:)/.test(dependencies[name]));
  const sourceErrors = new Map();
  const available = await resolvePluginVersions(pluginNames, effectiveRegistry, sourceErrors);
  const github = new Map();
  const effectiveCache = cacheFile || join(dirname(dirname(profileDir)), 'updates', 'dsh-update-plugin', 'github-cache.json');
  await Promise.all(externalNames.map(async (name) => {
    const repo = repositoryOf(manifests.get(name)) || githubRepoFromSpec(dependencies[name]);
    if (!repo) return;
    try {
      github.set(name, await resolveGithubVersions(repo, name, githubToken, effectiveCache));
    } catch (error) {
      github.set(name, { versions: [] });
      sourceErrors.set(name, error instanceof Error ? error.message : String(error));
    }
  }));
  return createPluginPlan(dependencies, manifests, available, targetCore, bundles, {
    ignored,
    github,
    sourceErrors,
  });
}

let desktopInfoCache = { at: 0, value: null };

async function queryDesktopInfo() {
  if (desktopInfoCache.value && Date.now() - desktopInfoCache.at < 5_000) {
    return desktopInfoCache.value;
  }
  const script = [
    "$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$items=@(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' })",
    "$rows=@()",
    "foreach($p in $items){ $candidates=@(); if($p.DisplayIcon){$candidates += (($p.DisplayIcon -replace ',\\d+$','').Trim('\"'))}; if($p.InstallLocation){$candidates += (Join-Path $p.InstallLocation 'DeepSeek Harness.exe')}; foreach($c in $candidates){ if(Test-Path -LiteralPath $c){ $v=$null; if($p.DisplayVersion){$v=[string]$p.DisplayVersion}; $rows += [pscustomobject]@{exe=[string]$c;version=$v}; break } } }",
    "$proc=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' })[0]",
    "$runningExe=$null; if($proc){ try { if($proc.Path){$runningExe=[string]$proc.Path} } catch {} }",
    "[pscustomobject]@{runningExe=$runningExe;items=@($rows)} | ConvertTo-Json -Depth 4 -Compress",
  ].join('; ');
  const found = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
    });
  });
  const value = found && typeof found === 'object'
    ? {
      runningExe: typeof found.runningExe === 'string' ? found.runningExe : null,
      items: (Array.isArray(found.items) ? found.items : (found.items ? [found.items] : []))
        .filter((entry) => entry && typeof entry.exe === 'string'),
    }
    : null;
  desktopInfoCache = { at: Date.now(), value };
  return value;
}

export async function findDesktopExe() {
  const explicit = process.env.DSH_DESKTOP_EXE;
  if (explicit && existsSync(explicit)) return explicit;
  const info = await queryDesktopInfo();
  if (info?.runningExe && existsSync(info.runningExe)) return info.runningExe;
  const registered = info?.items?.find((entry) => existsSync(entry.exe));
  if (registered) return registered.exe;
  const candidates = [
    'C:\\DeepSeek Harness\\DeepSeek Harness.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export async function readProductVersion(exe) {
  const escaped = exe.replace(/'/g, "''");
  const script = `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

export function normalizeDesktopVersion(value) {
  const text = String(value || '').trim();
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\.0+)?$/.exec(text);
  if (match) return match[1];
  const prefix = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
  return prefix ? prefix[1] : text;
}

export async function readDesktopVersion(exe) {
  const info = await queryDesktopInfo();
  const normalizedExe = resolve(exe).toLowerCase();
  const registered = info?.items?.find((entry) => resolve(entry.exe).toLowerCase() === normalizedExe);
  const registeredVersion = normalizeDesktopVersion(registered?.version);
  if (registeredVersion && parse(registeredVersion)) return registeredVersion;
  const product = await readProductVersion(exe);
  return normalizeDesktopVersion(product);
}

export function desktopInstallerUrl(version) {
  if (!version || !parse(version)) return null;
  return `https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${version}-win-x64.exe`;
}

function feedValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

export function parseDesktopFeed(text, feedUrl = DEFAULT_FEED) {
  const version = (text.match(/^version:\s*['"]?([^'"\r\n]+)['"]?/m) || [])[1];
  if (!version || !parse(version)) throw new Error('desktop feed has no valid version');
  const files = [];
  let current = null;
  let topSha512 = null;
  let pendingHash = null;
  for (const line of text.split(/\r?\n/)) {
    if (pendingHash) {
      const continued = /^(\s+)(\S.*?)\s*$/.exec(line);
      if (continued && continued[1].length > pendingHash.indent) {
        const value = feedValue(continued[2]);
        if (pendingHash.target === 'top') topSha512 = value;
        else pendingHash.target.sha512 = value;
        pendingHash = null;
        continue;
      }
      pendingHash = null;
    }

    const topHash = /^sha512:\s*(.*?)\s*$/.exec(line);
    if (topHash) {
      const value = feedValue(topHash[1]);
      if (value === '>-' || value === '>') pendingHash = { target: 'top', indent: 0 };
      else topSha512 = value;
      continue;
    }

    const start = /^\s*-\s*url:\s*(.*?)\s*$/.exec(line);
    if (start) {
      const value = feedValue(start[1]);
      current = { url: value === '>-' || value === '>' ? '' : value, sha512: null, block: value === '>-' || value === '>' };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (current.block && !current.url && /^\s{2,}(\S+)\s*$/.test(line)) {
      current.url = feedValue(line);
      current.block = false;
      continue;
    }
    const hash = /^(\s+)sha512:\s*(.*?)\s*$/.exec(line);
    if (hash) {
      const value = feedValue(hash[2]);
      if (value === '>-' || value === '>') pendingHash = { target: current, indent: hash[1].length };
      else current.sha512 = value;
    }
  }
  const installer = files.find((entry) => /\.exe(?:$|\?)/i.test(entry.url) && !/\.blockmap/i.test(entry.url));
  const installerUrl = installer?.url ? new URL(installer.url, feedUrl).toString() : null;
  const sha512 = installer?.sha512 || topSha512;
  if (installerUrl && !sha512) throw new Error('desktop feed has no sha512 for the installer');
  return {
    version: feedValue(version),
    installerUrl,
    sha512,
  };
}

export async function checkDesktop({
  feedUrl,
  currentVersion,
  targetCore,
  channel,
  allowChannelChange = false,
} = {}) {
  const currentChannel = channelForVersion(currentVersion);
  const activeChannel = channel || currentChannel || 'nightly';
  if (channel && currentChannel && channel !== currentChannel && !allowChannelChange) {
    throw new Error(`拒绝跨渠道更新：当前为 ${currentChannel}，请求渠道为 ${channel}`);
  }
  const effectiveFeed = feedUrl || feedForChannel(activeChannel);
  if (!effectiveFeed) {
    return {
      current: currentVersion || null,
      version: currentVersion || null,
      update: false,
      installerUrl: null,
      sha512: null,
      channel: activeChannel,
      feedUnavailable: true,
      reason: `官方 ${activeChannel} 渠道 feed 尚未提供，已拒绝跨渠道更新`,
    };
  }
  let parsedFeed;
  try {
    parsedFeed = new URL(effectiveFeed);
  } catch {
    throw new Error(`desktop feed URL 无效：${effectiveFeed}`);
  }
  if (parsedFeed.protocol !== 'https:') throw new Error('desktop feed 必须使用 HTTPS');
  const response = await fetch(effectiveFeed, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': PLUGIN_USER_AGENT } });
  if (!response.ok) throw new Error(`desktop feed HTTP ${response.status}`);
  const text = await response.text();
  const feed = parseDesktopFeed(text, effectiveFeed);
  const version = feed.version;
  const feedChannel = channelForVersion(version);
  if (currentChannel && feedChannel && feedChannel !== currentChannel && !allowChannelChange) {
    throw new Error(`拒绝跨渠道更新：当前为 ${currentChannel}，feed 返回 ${feedChannel}`);
  }
  if (targetCore && parse(targetCore) && compare(version, targetCore) < 0) {
    throw new Error(`desktop feed version ${version} is older than requested ${targetCore}`);
  }
  const current = currentVersion || null;
  const update = !current || compare(version, current) > 0;
  return {
    current,
    version,
    update,
    installerUrl: feed.installerUrl,
    sha512: feed.sha512,
    channel: activeChannel,
    feedUnavailable: false,
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
