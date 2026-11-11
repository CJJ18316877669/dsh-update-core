import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
          repository: meta?.repository || packument.repository || null,
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

export function createPluginPlan(dependencies, installedManifests, available, targetCore, bundles = new Set(), options = {}) {
  const ignored = options.ignored instanceof Map ? options.ignored : new Map();
  const github = options.github instanceof Map ? options.github : new Map();
  const items = [];
  for (const [name, spec] of Object.entries(dependencies || {})) {
    if (looksLikeCore(name)) continue;
    const manifest = installedManifests.get(name) || null;
    const from = manifest?.version || (typeof spec === 'string' ? spec : '');
    if (!isPluginDependency(name, bundles)) {
      items.push({ name, action: 'keep', from, to: null, reason: 'non-plugin-dependency' });
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
      if (best && currentVersion && parse(currentVersion) && compare(best.version, currentVersion) > 0) {
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
    if (currentVersion && parse(currentVersion) && compare(best.version, currentVersion) > 0) {
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
  return {
    targetCore,
    items,
    updates: items.filter((item) => item.action === 'update').length,
    keeps: items.filter((item) => item.action === 'keep').length,
    disables: 0,
    blocked: 0,
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
  const disk = await readGithubCache(cacheFile);
  const stored = disk.repos[repo];
  const cached = githubCache.get(repo);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  if (!cached && stored && Date.now() - Date.parse(stored.at || '') < 5 * 60_000) {
    githubCache.set(repo, { at: Date.now(), value: stored.value });
    return stored.value;
  }
  const fallback = cached?.value || stored?.value || null;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-update-core-plugin/0.2.6',
    'x-github-api-version': '2022-11-28',
    ...(stored?.etag ? { 'if-none-match': stored.etag } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let refs = [];
  let etag = stored?.etag || null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers, signal: AbortSignal.timeout(20000),
    });
    if (response.status === 304 && fallback) {
      githubCache.set(repo, { at: Date.now(), value: fallback });
      return fallback;
    }
    if (response.status === 403 && fallback) {
      // Rate limited: keep using the last verified catalog.
      githubCache.set(repo, { at: Date.now(), value: fallback });
      return fallback;
    }
    if (response.ok) {
      etag = response.headers.get('etag') || etag;
      const releases = await response.json();
      refs = releases
        .filter((release) => !release.draft && !release.prerelease)
        .map((release) => ({ ref: release.tag_name, version: String(release.tag_name || '').replace(/^v/i, '') }))
        .filter((entry) => parse(entry.version));
    }
  } catch { /* tags fallback below */ }
  if (refs.length === 0) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=30`, {
        headers, signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        refs = (await response.json()).map((tag) => ({
          ref: tag.name,
          version: String(tag.name || '').replace(/^v/i, ''),
        })).filter((entry) => parse(entry.version));
      }
    } catch { /* keep empty */ }
  }
  const versions = [];
  for (const entry of refs.slice(0, 12)) {
    try {
      const raw = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(entry.ref)}/package.json`, {
        signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'dsh-update-core-plugin/0.2.6' },
      });
      if (!raw.ok) continue;
      const manifest = await raw.json();
      if (manifest.name !== expectedName || manifest.version !== entry.version) continue;
      versions.push({ version: entry.version, ref: entry.ref, repository: repo, manifest });
    } catch { /* skip malformed tag */ }
  }
  const value = { versions };
  githubCache.set(repo, { at: Date.now(), value });
  await writeGithubCache(cacheFile, {
    schema: 1,
    repos: { ...disk.repos, [repo]: { at: new Date().toISOString(), etag, value } },
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
  const available = await resolvePluginVersions(pluginNames, effectiveRegistry);
  const github = new Map();
  const effectiveCache = cacheFile || join(dirname(dirname(profileDir)), 'updates', 'dsh-update-plugin', 'github-cache.json');
  await Promise.all(externalNames.map(async (name) => {
    const repo = repositoryOf(manifests.get(name)) || githubRepoFromSpec(dependencies[name]);
    if (!repo) return;
    github.set(name, await resolveGithubVersions(repo, name, githubToken, effectiveCache));
  }));
  return createPluginPlan(dependencies, manifests, available, targetCore, bundles, { ignored, github });
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

export function desktopInstallerUrl(version) {
  if (!version || !parse(version)) return null;
  return `https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${version}-win-x64.exe`;
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
