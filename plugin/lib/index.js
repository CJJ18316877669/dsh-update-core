import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  buildPlan,
  checkDesktop,
  defaultPaths,
  desktopInstallerUrl,
  findDesktopExe,
  readDesktopVersion,
} from './plan.mjs';
import {
  listHistory,
  readCoreState,
  readHeartbeat,
  readIgnored,
  readJson,
  readLastPlan,
  setIgnored,
  stateDir,
  writeCoreState,
  writeHeartbeat,
  writeJson,
  writeLastPlan,
} from './store.mjs';
import { SerialJsonWriter } from './state-writer.mjs';
import { UpdateGate } from './gate.mjs';
import { parse } from './vendor/semver.mjs';
import { acquireRunLock, readRunLock, refreshRunLock, releaseRunLock, touchRunLock } from './run-lock.mjs';
import { backupProfileConfig } from './profile-backup.mjs';
import { pruneUpdateArtifacts } from './retention.mjs';
import { PLUGIN_VERSION, PLUGIN_USER_AGENT } from './version.mjs';

export const name = 'dsh-update-core-plugin';
export const inject = ['webServer'];
export { PLUGIN_VERSION };
const PAGE = fileURLToPath(new URL('../public/index.html', import.meta.url));
const SUPERVISOR = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));
const CACHE_MS = 30_000;
const MAX_BODY = 64 * 1024;
const ACTIVE_RUN_TTL_MS = 2 * 60 * 60_000;
const ORPHAN_RECOVERY_GRACE_MS = 60_000;
const MAX_DOWNLOAD_MS = 30 * 60_000;
const RUN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'rolled-back']);
const INSTALLER_HOSTS = new Set(['download.deepseek.com']);

function send(response, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(payload),
    ...extra,
  });
  response.end(payload);
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

async function readBody(request) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(type)) throw httpError('content-type must be application/json', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw httpError('request body too large', 413);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    throw httpError('invalid JSON body', 400);
  }
}

function normalizeRemoteAddress(address) {
  return String(address || '').toLowerCase().replace(/^::ffff:/, '');
}

export function isLoopbackAddress(address) {
  const value = normalizeRemoteAddress(address);
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

export function parseAllowedHost(hostHeader) {
  try {
    const parsed = new URL(`http://${String(hostHeader || '')}`);
    if (parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAuthorizedRequest(request, token, options = {}) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = parseAllowedHost(request.headers?.host);
  if (!host) return false;
  const origin = request.headers?.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      if (parsed.host.toLowerCase() !== String(request.headers.host).toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  if (options.requireToken === false) return true;
  const supplied = Buffer.from(String(request.headers?.['x-dsh-update-token'] || ''));
  const expected = Buffer.from(token || '');
  if (!token || supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

async function verifySignature(file) {
  const escaped = file.replace(/'/g, "''");
  const script = [
    `$s=Get-AuthenticodeSignature -LiteralPath '${escaped}'`,
    '[pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress',
  ].join('; ');
  const parsed = await new Promise((resolvePromise, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 30_000,
    }, (error, stdout) => {
      if (error) reject(error);
      else {
        try {
          resolvePromise(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`无法解析安装包签名结果：${stdout.trim()}`));
        }
      }
    });
  });
  if (parsed?.status !== 'Valid') throw new Error(`安装包签名无效：${parsed?.status || 'Unknown'}`);
  if (!/CN="?Hangzhou DeepSeek Artificial Intelligence Co\., Ltd\./i.test(parsed.subject || '')) {
    throw new Error(`安装包签名主体不是 DeepSeek 官方：${parsed.subject || 'unknown'}`);
  }
  return parsed;
}

function assertInstallerUrl(raw, options = {}) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`安装包地址无效：${raw}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`安装包地址必须使用 HTTPS：${raw}`);
  if (!options.redirect && !INSTALLER_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`安装包域名不在白名单：${parsed.hostname}`);
  }
  return parsed;
}

async function fetchInstaller(url, signal) {
  let current = assertInstallerUrl(url);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { 'user-agent': PLUGIN_USER_AGENT },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error(`安装包下载重定向缺少 location：HTTP ${response.status}`);
    current = assertInstallerUrl(new URL(location, current).toString(), { redirect: true });
    if (response.body) await response.body.cancel().catch(() => {});
  }
  throw new Error('安装包下载重定向次数过多');
}

function digestMatches(expected, digest) {
  const value = String(expected || '').trim().replace(/^sha512-/i, '');
  if (!value) return false;
  if (/^[a-f0-9]{128}$/i.test(value)) return value.toLowerCase() === digest.hex;
  return value === digest.base64;
}

async function download(url, destination, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_DOWNLOAD_MS);
  timer.unref?.();
  try {
    const response = await fetchInstaller(url, controller.signal);
    if (!response.ok || !response.body) throw new Error(`installer download HTTP ${response.status}`);
    await mkdir(dirname(destination), { recursive: true });
    const total = Number(response.headers.get('content-length')) || 0;
    const hash = createHash('sha512');
    let received = 0;
    let last = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        if (Date.now() - last > 500) {
          last = Date.now();
          onProgress?.({ received, total, percent: total ? Math.min(100, received / total * 100) : undefined });
        }
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination));
    const bytes = hash.digest();
    onProgress?.({ received, total, percent: 100 });
    return { base64: bytes.toString('base64'), hex: bytes.toString('hex'), received };
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadVerified(url, destination, expectedSha512, onProgress) {
  if (!url) throw new Error('安装包地址为空');
  if (!expectedSha512) throw new Error('缺少安装包 sha512，拒绝下载');
  const digest = await download(url, destination, onProgress);
  if (!digestMatches(expectedSha512, digest)) {
    await unlink(destination).catch(() => {});
    throw new Error('安装包 sha512 校验失败');
  }
  await verifySignature(destination);
  return destination;
}

async function downloadRollbackVerified(url, destination, onProgress) {
  if (!url) return '';
  await download(url, destination, onProgress);
  await verifySignature(destination);
  return destination;
}

function pnpmPath(paths, exe) {
  const candidates = [
    join(paths.profileDir, 'node_modules', '.bin', 'pnpm.cjs'),
    join(dirname(exe), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function helperExecutable(desktopExe) {
  const bundledNode = join(dirname(desktopExe), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
  if (existsSync(bundledNode)) return bundledNode;
  return process.execPath;
}

async function spawnHelper(args, desktopExe, lockContext = {}) {
  const runner = helperExecutable(desktopExe);
  const child = spawn(runner, [SUPERVISOR, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  });
  await new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', reject);
  });
  if (lockContext.lockPath && lockContext.run && child.pid) {
    await refreshRunLock(lockContext.lockPath, lockContext.run, {
      pid: child.pid,
      role: 'supervisor',
    }).catch(() => {});
  }
  child.unref();
  return child;
}

function validRunId(run) {
  return typeof run === 'string' && RUN_RE.test(run);
}

function safePackageName(value) {
  return typeof value === 'string'
    && value.length <= 214
    && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value);
}

function rollbackCapabilities(coreState) {
  return {
    core: Boolean(
      coreState?.rollbackInstaller
      && parse(coreState?.currentBefore)
      && existsSync(coreState.rollbackInstaller),
    ),
    profile: Boolean(
      (coreState?.rollbackPackage && existsSync(coreState.rollbackPackage))
      || (coreState?.profileBackup && existsSync(join(coreState.profileBackup, 'package.json'))),
    ),
  };
}

export function mountRoutes(webServer, config = {}) {
  const paths = defaultPaths(config);
  const updatesDir = paths.updatesDir;
  const lockPath = join(updatesDir, 'update.lock');
  const token = randomBytes(24).toString('hex');
  const gate = new UpdateGate();
  let cache = null;
  let cacheAt = 0;

  function startLockHeartbeat(run) {
    const timer = setInterval(() => {
      void touchRunLock(lockPath, run);
    }, 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  function canReclaimActiveRun(active, lock) {
    if (!active || active.stale) return true;
    return lock.recovered
      && (active.ageMs ?? Number.POSITIVE_INFINITY) > ORPHAN_RECOVERY_GRACE_MS;
  }

  async function readActiveRun() {
    try {
      const active = await readJson(join(updatesDir, 'active-run.json'), null);
      if (!active || !validRunId(active.run)) return null;
      let state = null;
      try {
        state = JSON.parse(await readFile(join(updatesDir, active.run, 'result.json'), 'utf8'));
      } catch {
        // The run was created but the helper has not written its first result.
      }
      const startedAt = Date.parse(state?.startedAt || state?.updatedAt || active.startedAt || '');
      const age = Number.isFinite(startedAt) ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
      if (state && TERMINAL_RUN_STATES.has(state.state)) return null;
      return {
        run: active.run,
        ...(state || {}),
        startedAt: state?.startedAt || active.startedAt || null,
        stale: age > ACTIVE_RUN_TTL_MS,
        ageMs: Number.isFinite(age) ? age : null,
      };
    } catch {
      return null;
    }
  }

  async function status(force = false) {
    if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
    const exe = config.desktopExe || await findDesktopExe();
    if (!exe) throw new Error('未找到已安装的 DeepSeek Harness Desktop');
    const current = await readDesktopVersion(exe);
    const core = await checkDesktop({ currentVersion: current, feedUrl: config.feedUrl });
    const targetCore = core.update ? core.version : current;
    const ignored = await readIgnored(paths);
    const plan = await buildPlan({
      profileDir: paths.profileDir,
      targetCore,
      registry: config.registry || process.env.DSH_UPDATE_REGISTRY || undefined,
      ignored,
      githubToken: config.githubToken,
      cacheFile: join(updatesDir, 'github-cache.json'),
    });
    const [history, coreState, heartbeat, activeRunValue, processLock] = await Promise.all([
      listHistory(paths, 12),
      readCoreState(paths),
      readHeartbeat(paths),
      readActiveRun(),
      readRunLock(lockPath),
    ]);
    const activeRun = activeRunValue;
    if (activeRun && processLock.orphaned) {
      // A supervisor is normally already recovering. Keep the UI busy during a
      // short grace window to prevent a concurrent update; after that, expose
      // the orphan so the user can start a new run.
      activeRun.orphaned = true;
      if ((activeRun.ageMs ?? Number.POSITIVE_INFINITY) > ORPHAN_RECOVERY_GRACE_MS) {
        activeRun.stale = true;
      }
    }
    const compatibilityRisks = plan.blockers || [];
    const rollback = rollbackCapabilities(coreState);
    cache = {
      exe,
      current,
      core,
      plan,
      profile: paths.profileName,
      ignored: Object.fromEntries(ignored),
      history,
      coreState,
      rollback,
      processLock,
      heartbeat,
      activeRun,
      compatibilityRisks,
      blocked: false,
      blockReason: compatibilityRisks.length > 0
        ? `以下已安装插件与目标核心不兼容：${compatibilityRisks.map((item) => item.name).join(', ')}`
        : null,
      sourceWarnings: plan.sourceWarnings || [],
      unverifiedTargets: plan.unverifiedTargets || [],
      autoCheckHours: Number(config.autoCheckHours ?? 6),
      autoApply: config.autoApply === true,
      checkedAt: new Date().toISOString(),
      updateAvailable: (core.update || plan.updates > 0),
      running: gate.busy || processLock.active || Boolean(activeRun && !activeRun.stale),
    };
    cacheAt = Date.now();
    return cache;
  }

  async function startUpdate(options = {}) {
    if (!gate.tryAcquire()) throw httpError('更新或回滚已在进行中', 409);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let lockHeld = false;
    let stopLockHeartbeat = null;
    try {
      const lock = await acquireRunLock(lockPath, stamp);
      if (!lock.ok) {
        throw httpError(`已有更新进程正在运行${lock.owner?.run ? `（${lock.owner.run}）` : ''}`, 409);
      }
      lockHeld = true;
      stopLockHeartbeat = startLockHeartbeat(stamp);
      const active = await readActiveRun();
      if (active && !canReclaimActiveRun(active, lock)) {
        throw httpError('已有更新正在进行，请等待完成', 409);
      }
      const snapshot = await status(true);
      if (snapshot.compatibilityRisks.length > 0 && options.acceptIncompatible !== true) {
        throw httpError(snapshot.blockReason, 409);
      }
      if (!snapshot.updateAvailable) throw httpError('已经是最新版本，无需更新', 409);

      const runDir = join(updatesDir, stamp);
      const backupDir = join(runDir, 'profile-backup');
      await mkdir(backupDir, { recursive: true });
      const planPath = join(runDir, 'plan.json');
      const resultPath = join(runDir, 'result.json');
      const startedAt = new Date().toISOString();
      const writer = new SerialJsonWriter(resultPath, writeJson);
      const writeResult = (extra) => writer.write({
        startedAt,
        ...extra,
        updatedAt: new Date().toISOString(),
      });

      await writeResult({ state: 'preparing', message: '正在准备更新…' });
      await writer.flush();
      await writeJson(join(updatesDir, 'active-run.json'), {
        run: stamp,
        resultPath,
        startedAt,
      });
      cache = null;

      const prepare = async () => {
        let installer = '';
        let rollbackInstaller = '';
        try {
          if (snapshot.core.update) {
            if (!snapshot.core.installerUrl) throw new Error('官方 feed 没有安装包地址');
            if (!snapshot.core.sha512) throw new Error('官方 feed 没有安装包 sha512');
            installer = await downloadVerified(
              snapshot.core.installerUrl,
              join(runDir, 'installer.exe'),
              snapshot.core.sha512,
              ({ received, total, percent }) => {
                void writeResult({
                  state: 'downloading-core',
                  message: '正在下载核心安装包…',
                  received,
                  total,
                  percent,
                });
              },
            );
            const rollbackUrl = desktopInstallerUrl(snapshot.current);
            if (rollbackUrl) {
              try {
                rollbackInstaller = await downloadRollbackVerified(
                  rollbackUrl,
                  join(runDir, 'rollback-installer.exe'),
                  ({ received, total, percent }) => {
                    void writeResult({
                      state: 'downloading-rollback',
                      message: '正在下载回滚安装包…',
                      received,
                      total,
                      percent,
                    });
                  },
                );
              } catch {
                // A local/unsigned build may not have an official rollback installer.
                rollbackInstaller = '';
              }
            }
          }

          await backupProfileConfig(paths.profileDir, backupDir);
          await writeCoreState(paths, {
            currentBefore: snapshot.current,
            targetVersion: snapshot.plan.targetCore,
            rollbackExe: snapshot.exe,
            rollbackInstaller: snapshot.core.update ? (rollbackInstaller || null) : null,
            rollbackPackage: join(backupDir, 'package.json'),
            profileBackup: backupDir,
            lastRun: stamp,
          });
          await writeJson(planPath, snapshot.plan);
          await writeResult({ state: 'starting', message: '安装包已就绪，正在关闭 Desktop 并启动更新…' });
          await writer.flush();
          await writeLastPlan(paths, stamp, snapshot.plan);
          const helper = await spawnHelper([
            '--run', stamp,
            '--exe', snapshot.exe,
            '--profile', paths.profileDir,
            '--plan', planPath,
            '--result', resultPath,
            '--pnpm', pnpmPath(paths, snapshot.exe),
            '--heartbeat', join(stateDir(paths), 'heartbeat.json'),
            '--backup', backupDir,
            '--lock', lockPath,
            '--rollback-package', join(backupDir, 'package.json'),
            '--rollback-version', snapshot.current,
            ...(installer ? ['--installer', installer] : []),
            ...(rollbackInstaller ? ['--rollback-installer', rollbackInstaller] : []),
          ], snapshot.exe, { lockPath, run: stamp });
          stopLockHeartbeat?.();
          stopLockHeartbeat = null;
          helper.once('exit', (code) => {
            setTimeout(async () => {
              const state = await readJson(resultPath, null);
              gate.release();
              await releaseRunLock(lockPath, stamp).catch(() => {});
              if (state && TERMINAL_RUN_STATES.has(state.state)) return;
              await writeResult({
                state: 'failed',
                message: `更新助手提前退出（exit ${code ?? 'unknown'}）`,
              });
              await writer.flush().catch(() => {});
            }, 300);
          });
        } catch (error) {
          stopLockHeartbeat?.();
          stopLockHeartbeat = null;
          gate.release();
          cache = null;
          await releaseRunLock(lockPath, stamp).catch(() => {});
          await writeResult({
            state: 'failed',
            message: `更新准备失败：${error instanceof Error ? error.message : String(error)}`,
          });
          await writer.flush().catch(() => {});
        }
      };
      void prepare();
      return { accepted: true, resultPath, runDir, run: stamp };
    } catch (error) {
      stopLockHeartbeat?.();
      gate.release();
      cache = null;
      if (lockHeld) await releaseRunLock(lockPath, stamp).catch(() => {});
      throw error;
    }
  }

  async function startRollback() {
    if (!gate.tryAcquire()) throw httpError('更新或回滚已在进行中', 409);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let lockHeld = false;
    let stopLockHeartbeat = null;
    try {
      const lock = await acquireRunLock(lockPath, stamp);
      if (!lock.ok) {
        throw httpError(`已有更新进程正在运行${lock.owner?.run ? `（${lock.owner.run}）` : ''}`, 409);
      }
      lockHeld = true;
      stopLockHeartbeat = startLockHeartbeat(stamp);
      const active = await readActiveRun();
      if (active && !canReclaimActiveRun(active, lock)) {
        throw httpError('已有更新正在进行，请等待完成', 409);
      }
      const coreState = await readCoreState(paths);
      if (!coreState) throw httpError('没有可用的回滚点', 409);
      const available = rollbackCapabilities(coreState);
      if (!available.core && !available.profile) throw httpError('回滚点文件已缺失', 409);
      const targetExe = coreState.rollbackExe || config.desktopExe || await findDesktopExe();
      if (!targetExe) throw httpError('找不到 Desktop 可执行文件', 500);

      const runDir = join(updatesDir, stamp);
      await mkdir(runDir, { recursive: true });
      const resultPath = join(runDir, 'result.json');
      const startedAt = new Date().toISOString();
      await writeJson(resultPath, { state: 'starting', message: '正在回滚…', startedAt });
      await writeJson(join(updatesDir, 'active-run.json'), { run: stamp, resultPath, startedAt });
      cache = null;
      const helper = await spawnHelper([
        '--run', stamp,
        '--exe', targetExe,
        '--profile', paths.profileDir,
        '--result', resultPath,
        '--pnpm', pnpmPath(paths, targetExe),
        '--heartbeat', join(stateDir(paths), 'heartbeat.json'),
        '--lock', lockPath,
        '--rollback-only', '1',
        ...(available.core ? [] : ['--profile-only', '1']),
        '--rollback-version', coreState.currentBefore,
        ...(available.core ? ['--rollback-installer', coreState.rollbackInstaller] : []),
        ...(coreState.rollbackPackage && existsSync(coreState.rollbackPackage)
          ? ['--rollback-package', coreState.rollbackPackage]
          : []),
        ...(coreState.profileBackup && existsSync(join(coreState.profileBackup, 'package.json'))
          ? ['--backup', coreState.profileBackup]
          : []),
      ], targetExe, { lockPath, run: stamp });
      stopLockHeartbeat?.();
      stopLockHeartbeat = null;
      helper.once('exit', (code) => {
        setTimeout(async () => {
          const state = await readJson(resultPath, null);
          gate.release();
          await releaseRunLock(lockPath, stamp).catch(() => {});
          if (state && TERMINAL_RUN_STATES.has(state.state)) return;
          await writeJson(resultPath, {
            ...state,
            state: 'failed',
            message: `回滚助手提前退出（exit ${code ?? 'unknown'}）`,
            updatedAt: new Date().toISOString(),
          }).catch(() => {});
        }, 300);
      });
      return { accepted: true, resultPath, runDir, run: stamp };
    } catch (error) {
      stopLockHeartbeat?.();
      gate.release();
      cache = null;
      if (lockHeld) await releaseRunLock(lockPath, stamp).catch(() => {});
      throw error;
    }
  }

  function authorize(request, response, options = {}) {
    if (!isAuthorizedRequest(request, token, options)) {
      send(response, 403, { error: 'forbidden' });
      return false;
    }
    return true;
  }

  const routes = [
    ...['/dsh-update', '/dsh-update/'].map((path) => ({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        if (request.method !== 'GET') return send(response, 405, { error: 'method not allowed' });
        if (!authorize(request, response, { requireToken: false })) return;
        const template = await readFile(PAGE, 'utf8');
        send(
          response,
          200,
          template.replaceAll('__DSH_UPDATE_TOKEN__', token),
          'text/html; charset=utf-8',
          {
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
          },
        );
      },
    })),
    {
      kind: 'exact',
      path: '/dsh-update/api/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') return send(response, 405, { error: 'method not allowed' });
        if (!authorize(request, response)) return;
        try {
          send(response, 200, await status(false));
        } catch (error) {
          send(response, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-update/api/history',
      handler: async (request, response) => {
        if (request.method !== 'GET') return send(response, 405, { error: 'method not allowed' });
        if (!authorize(request, response)) return;
        try {
          send(response, 200, {
            history: await listHistory(paths, 30),
            lastPlan: await readLastPlan(paths),
            coreState: await readCoreState(paths),
          });
        } catch (error) {
          send(response, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-update/api/ignore',
      handler: async (request, response) => {
        if (request.method !== 'POST') return send(response, 405, { error: 'method not allowed' });
        if (!authorize(request, response)) return;
        try {
          const body = await readBody(request);
          if (!safePackageName(body.name)) return send(response, 400, { error: 'valid package name required' });
          if (body.clear === true) await setIgnored(paths, body.name, null);
          else if (typeof body.version === 'string' && body.version) await setIgnored(paths, body.name, body.version);
          else return send(response, 400, { error: 'version required' });
          cache = null;
          send(response, 200, await status(true));
        } catch (error) {
          send(response, error?.status || 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-update/api/update',
      handler: async (request, response) => {
        if (request.method !== 'POST') return send(response, 405, { error: 'method not allowed' });
        if (!authorize(request, response)) return;
        try {
          const body = await readBody(request);
          if (body.confirm !== true) return send(response, 422, { error: 'confirmation required' });
          send(response, 202, await startUpdate({
            acceptIncompatible: body.acceptIncompatible === true,
          }));
        } catch (error) {
          send(response, error?.status || 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-update/api/rollback',
      handler: async (request, response) => {
        if (request.method !== 'POST') return send(response, 405, { error: 'method not allowed' });
        if (!authorize(request, response)) return;
        try {
          const body = await readBody(request);
          if (body.confirm !== true) return send(response, 422, { error: 'confirmation required' });
          send(response, 202, await startRollback());
        } catch (error) {
          send(response, error?.status || 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-update/api/result',
      handler: async (request, response) => {
        if (request.method !== 'GET') return send(response, 405, { error: 'method not allowed' });
        if (!authorize(request, response)) return;
        const run = new URL(request.url, 'http://localhost').searchParams.get('run');
        if (!validRunId(run)) return send(response, 400, { error: 'invalid run id' });
        try {
          send(response, 200, JSON.parse(await readFile(join(updatesDir, run, 'result.json'), 'utf8')));
        } catch {
          send(response, 404, { error: 'result not found' });
        }
      },
    },
  ];

  const hours = Number(config.autoCheckHours ?? 6);
  let initialTimer = null;
  const tick = async () => {
    const snapshot = await status(true);
    if (
      config.autoApply === true
      && snapshot.updateAvailable
      && !snapshot.running
      && (snapshot.compatibilityRisks || []).length === 0
      && (snapshot.sourceWarnings || []).length === 0
    ) {
      await startUpdate();
    }
  };
  if (Number.isFinite(hours) && hours > 0) {
    initialTimer = setTimeout(() => { tick().catch(() => {}); }, 15_000);
    initialTimer.unref?.();
    const timer = setInterval(() => { tick().catch(() => {}); }, Math.max(1, hours) * 3_600_000);
    timer.unref?.();
    const disposers = routes.map((route) => webServer.register(route));
    return [...disposers, () => {
      clearInterval(timer);
      if (initialTimer) clearTimeout(initialTimer);
    }];
  }
  return routes.map((route) => webServer.register(route));
}

export async function apply(ctx, config = {}) {
  const paths = defaultPaths(config);
  const active = await readJson(join(stateDir(paths), 'active-run.json'), null).catch(() => null);
  const heartbeat = {
    pid: process.pid,
    version: PLUGIN_VERSION,
    state: 'loaded',
    run: active?.run || null,
  };
  await writeHeartbeat(paths, heartbeat).catch(() => {});
  const settleTimer = setTimeout(() => {
    void writeHeartbeat(paths, { ...heartbeat, state: 'settled' }).catch(() => {});
  }, 10_000);
  settleTimer.unref?.();
  const cleanupTimer = setTimeout(() => {
    void (async () => {
      try {
        const coreState = await readCoreState(paths);
        const report = await pruneUpdateArtifacts(paths.updatesDir, {
          coreState,
          dryRun: config.pruneOldArtifacts !== true,
        });
        await writeJson(join(paths.updatesDir, 'cleanup-report.json'), {
          ...report,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Cleanup is best-effort and must never block plugin startup.
      }
    })();
  }, 5_000);
  cleanupTimer.unref?.();
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = mountRoutes(host.webServer, config);
      return () => { for (const dispose of disposers) dispose(); };
    }, 'dsh-update-core-plugin: routes');
  });
}
