import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import {
  buildPlan,
  checkDesktop,
  defaultPaths,
  findDesktopExe,
  readDesktopVersion,
} from './plan.mjs';

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

export function mountRoutes(webServer, config = {}) {
  const paths = defaultPaths(config);
  let cache = null;
  let cacheAt = 0;
  let running = false;

  async function status(force = false) {
    if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
    const exe = config.desktopExe || await findDesktopExe();
    if (!exe) throw new Error('未找到已安装的 DeepSeek Harness Desktop');
    const current = await readDesktopVersion(exe);
    const core = await checkDesktop({ currentVersion: current, feedUrl: config.feedUrl });
    const targetCore = core.update ? core.version : current;
    const plan = await buildPlan({
      profileDir: paths.profileDir,
      targetCore,
      registry: config.registry || process.env.DSH_UPDATE_REGISTRY || undefined,
    });
    cache = {
      exe,
      current,
      core,
      plan,
      profile: paths.profileName,
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
    const runDir = join(paths.updatesDir, stamp);
    await mkdir(runDir, { recursive: true });
    const planPath = join(runDir, 'plan.json');
    const resultPath = join(runDir, 'result.json');
    let installer = '';
    if (snapshot.core.update && snapshot.core.installerUrl) {
      installer = join(runDir, 'installer.exe');
      await download(snapshot.core.installerUrl, installer);
      const signature = await verifySignature(installer);
      if (signature !== 'Valid') {
        running = false;
        throw Object.assign(new Error(`安装包签名无效：${signature}`), { status: 500 });
      }
    }
    await writeFile(planPath, `${JSON.stringify(snapshot.plan, null, 2)}\n`, 'utf8');
    await writeFile(resultPath, `${JSON.stringify({ state: 'starting', message: '正在启动更新…' }, null, 2)}\n`, 'utf8');
    const pnpmCandidates = [
      join(paths.profileDir, 'node_modules', '.bin', 'pnpm.cjs'),
      join(dirname(snapshot.exe), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
    ];
    const pnpm = pnpmCandidates.find((candidate) => existsSync(candidate)) || pnpmCandidates[0];
    const args = [
      HELPER,
      '--exe', snapshot.exe,
      '--profile', paths.profileDir,
      '--plan', planPath,
      '--result', resultPath,
      '--pnpm', pnpm,
      ...(installer ? ['--installer', installer] : []),
    ];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    });
    child.unref();
    return { accepted: true, resultPath, runDir };
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
      path: '/dsh-update/api/result',
      handler: async (request, response) => {
        if (request.method !== 'GET') return send(response, 405, { error: 'method not allowed' });
        const run = new URL(request.url, 'http://localhost').searchParams.get('run');
        const root = paths.updatesDir;
        if (!run || !/^[0-9TZ:.-]+$/.test(run)) return send(response, 400, { error: 'invalid run id' });
        try {
          send(response, 200, JSON.parse(await readFile(join(root, run, 'result.json'), 'utf8')));
        } catch {
          send(response, 404, { error: 'result not found' });
        }
      },
    },
  ];

  return routes.map((route) => webServer.register(route));
}

export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = mountRoutes(host.webServer, config);
      return () => { for (const dispose of disposers) dispose(); };
    }, 'dsh-update-core-plugin: routes');
  });
}
