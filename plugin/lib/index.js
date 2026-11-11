import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
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
  readLastPlan,
  setIgnored,
  stateDir,
  writeCoreState,
  writeHeartbeat,
  writeLastPlan,
} from './store.mjs';

export const name = 'dsh-update-core-plugin';
export const inject = ['webServer'];

const PAGE = fileURLToPath(new URL('../public/index.html', import.meta.url));
const HELPER = fileURLToPath(new URL('./helper.mjs', import.meta.url));
const CACHE_MS = 30_000;

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) throw new Error('request body too large');
  }
  return body ? JSON.parse(body) : {};
}

async function verifySignature(file) {
  const escaped = file.replace(/'/g, "''");
  const script = `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000), headers: { 'user-agent': 'dsh-update-core-plugin/0.1.0' } });
  if (!response.ok || !response.body) throw new Error(`installer download HTTP ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function downloadVerified(url, destination) {
  await download(url, destination);
  const signature = await verifySignature(destination);
  if (signature !== 'Valid') throw new Error(`安装包签名无效：${signature}`);
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
  if (process.execPath.toLowerCase().endsWith('node.exe')) return process.execPath;
  return process.execPath;
}

async function spawnHelper(args, desktopExe) {
  const runner = helperExecutable(desktopExe);
  const child = spawn(runner, [HELPER, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  });
  child.unref();
}

export function mountRoutes(webServer, config = {}) {
  const paths = defaultPaths(config);
  const updatesDir = paths.updatesDir;
  let cache = null;
  let cacheAt = 0;
  let running = false;
  let timer = null;

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
    const [history, coreState, heartbeat] = await Promise.all([
      listHistory(paths, 12),
      readCoreState(paths),
      readHeartbeat(paths),
    ]);
    cache = {
      exe,
      current,
      core,
      plan,
      profile: paths.profileName,
      ignored: Object.fromEntries(ignored),
      history,
      coreState,
      heartbeat,
      autoCheckHours: Number(config.autoCheckHours ?? 6),
      autoApply: config.autoApply === true,
      checkedAt: new Date().toISOString(),
      updateAvailable: core.update || plan.updates > 0,
      running,
    };
    cacheAt = Date.now();
    return cache;
  }

  async function startUpdate() {
    if (running) throw Object.assign(new Error('更新已在进行中'), { status: 409 });
    const snapshot = await status(true);
    if (!snapshot.updateAvailable) throw Object.assign(new Error('已经是最新版本，无需更新'), { status: 409 });
    running = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = join(updatesDir, stamp);
    const rollbackDir = join(updatesDir, 'rollback');
    await mkdir(runDir, { recursive: true });
    await mkdir(rollbackDir, { recursive: true });
    const planPath = join(runDir, 'plan.json');
    const resultPath = join(runDir, 'result.json');
    const statePath = join(runDir, 'state.json');
    let installer = '';
    let rollbackInstaller = '';
    try {
      if (snapshot.core.update) {
        if (!snapshot.core.installerUrl) throw new Error('官方 feed 没有安装包地址');
        installer = await downloadVerified(snapshot.core.installerUrl, join(runDir, 'installer.exe'));
        const rollbackUrl = desktopInstallerUrl(snapshot.current);
        if (rollbackUrl) {
          try {
            rollbackInstaller = await downloadVerified(rollbackUrl, join(rollbackDir, 'installer.exe'));
          } catch {
            // A local/unsigned build may not have an official rollback installer.
            // Continue, but expose that the core rollback point is unavailable.
            rollbackInstaller = '';
          }
        }
      }
      const profilePackage = join(paths.profileDir, 'package.json');
      await copyFile(profilePackage, join(rollbackDir, 'package.json'));
      for (const name of ['pnpm-lock.yaml', 'package-lock.json']) {
        try { await copyFile(join(paths.profileDir, name), join(rollbackDir, name)); } catch { /* optional */ }
      }
      await writeCoreState(paths, {
        currentBefore: snapshot.current,
        targetVersion: snapshot.plan.targetCore,
        rollbackExe: snapshot.exe,
        rollbackInstaller: snapshot.core.update ? (rollbackInstaller || null) : null,
        rollbackPackage: join(rollbackDir, 'package.json'),
        lastRun: stamp,
      });
      await writeFile(planPath, `${JSON.stringify(snapshot.plan, null, 2)}\n`, 'utf8');
      await writeFile(statePath, `${JSON.stringify({ run: stamp, coreRollback: rollbackInstaller || null }, null, 2)}\n`, 'utf8');
      await writeFile(resultPath, `${JSON.stringify({ state: 'starting', message: '正在启动更新…', startedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      await writeLastPlan(paths, stamp, snapshot.plan);
      await spawnHelper([
        '--exe', snapshot.exe,
        '--profile', paths.profileDir,
        '--plan', planPath,
        '--result', resultPath,
        '--pnpm', pnpmPath(paths, snapshot.exe),
        '--heartbeat', join(stateDir(paths), 'heartbeat.json'),
        ...(installer ? ['--installer', installer] : []),
        ...(rollbackInstaller ? ['--rollback-installer', rollbackInstaller] : []),
      ], snapshot.exe);
      return { accepted: true, resultPath, runDir, run: stamp };
    } catch (error) {
      running = false;
      throw error;
    }
  }

  async function startRollback() {
    if (running) throw Object.assign(new Error('更新已在进行中'), { status: 409 });
    const coreState = await readCoreState(paths);
    if (!coreState) throw Object.assign(new Error('没有可用的回滚点'), { status: 409 });
    running = true;
    const targetExe = coreState.rollbackExe || (config.desktopExe || await findDesktopExe());
    if (!targetExe) {
      running = false;
      throw Object.assign(new Error('找不到 Desktop 可执行文件'), { status: 500 });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = join(updatesDir, stamp);
    await mkdir(runDir, { recursive: true });
    const resultPath = join(runDir, 'result.json');
    await writeFile(resultPath, `${JSON.stringify({ state: 'starting', message: '正在回滚…', startedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    await spawnHelper([
      '--exe', targetExe,
      '--profile', paths.profileDir,
      '--result', resultPath,
      '--pnpm', pnpmPath(paths, targetExe),
      '--heartbeat', join(stateDir(paths), 'heartbeat.json'),
      '--rollback-only', '1',
      '--rollback-version', coreState.currentBefore,
      ...(coreState.rollbackInstaller ? ['--rollback-installer', coreState.rollbackInstaller] : []),
      '--rollback-package', coreState.rollbackPackage,
    ], targetExe);
    return { accepted: true, resultPath, runDir, run: stamp };
  }

  const routes = [
    ...['/dsh-update', '/dsh-update/'].map((path) => ({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        if (request.method !== 'GET') return send(response, 405, { error: 'method not allowed' });
        send(response, 200, await readFile(PAGE, 'utf8'), 'text/html; charset=utf-8');
      },
    })),
    {
      kind: 'exact',
      path: '/dsh-update/api/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') return send(response, 405, { error: 'method not allowed' });
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
        send(response, 200, {
          history: await listHistory(paths, 30),
          lastPlan: await readLastPlan(paths),
          coreState: await readCoreState(paths),
        });
      },
    },
    {
      kind: 'exact',
      path: '/dsh-update/api/ignore',
      handler: async (request, response) => {
        if (request.method !== 'POST') return send(response, 405, { error: 'method not allowed' });
        try {
          const body = await readBody(request);
          if (typeof body.name !== 'string' || body.name.trim() === '') {
            return send(response, 400, { error: 'name required' });
          }
          if (body.clear === true) await setIgnored(paths, body.name, null);
          else if (typeof body.version === 'string' && body.version) await setIgnored(paths, body.name, body.version);
          else return send(response, 400, { error: 'version required' });
          cache = null;
          send(response, 200, await status(true));
        } catch (error) {
          send(response, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-update/api/update',
      handler: async (request, response) => {
        if (request.method !== 'POST') return send(response, 405, { error: 'method not allowed' });
        try {
          const body = await readBody(request);
          if (body.confirm !== true) return send(response, 422, { error: 'confirmation required' });
          send(response, 202, await startUpdate());
        } catch (error) {
          running = false;
          send(response, error && error.status ? error.status : 500, {
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
        try {
          const body = await readBody(request);
          if (body.confirm !== true) return send(response, 422, { error: 'confirmation required' });
          send(response, 202, await startRollback());
        } catch (error) {
          running = false;
          send(response, error && error.status ? error.status : 500, {
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
        const run = new URL(request.url, 'http://localhost').searchParams.get('run');
        if (!run || !/^[0-9TZ:.-]+$/.test(run)) return send(response, 400, { error: 'invalid run id' });
        try {
          send(response, 200, JSON.parse(await readFile(join(updatesDir, run, 'result.json'), 'utf8')));
        } catch {
          send(response, 404, { error: 'result not found' });
        }
      },
    },
  ];

  const hours = Number(config.autoCheckHours ?? 6);
  const tick = async () => {
    const snapshot = await status(true);
    if (config.autoApply === true && snapshot.updateAvailable && !running) {
      await startUpdate();
    }
  };
  if (Number.isFinite(hours) && hours > 0) {
    const delay = setTimeout(() => { tick().catch(() => {}); }, 15_000);
    delay.unref?.();
    timer = setInterval(() => { tick().catch(() => {}); }, Math.max(1, hours) * 3_600_000);
    timer.unref?.();
  }

  const disposers = routes.map((route) => webServer.register(route));
  return [...disposers, () => {
    if (timer) clearInterval(timer);
  }];
}

export async function apply(ctx, config = {}) {
  const paths = defaultPaths(config);
  await writeHeartbeat(paths, {
    pid: process.pid,
    version: '0.2.6',
    state: 'loaded',
  }).catch(() => {});
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = mountRoutes(host.webServer, config);
      return () => { for (const dispose of disposers) dispose(); };
    }, 'dsh-update-core-plugin: routes');
  });
}
