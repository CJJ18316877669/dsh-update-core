import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const exe = arg('exe');
const profileDir = arg('profile');
const planPath = arg('plan');
const resultPath = arg('result');
const installerPath = arg('installer', '');
const pnpmPath = arg('pnpm', join(profileDir, 'node_modules', '.bin', 'pnpm.cjs'));

const result = {
  state: 'starting',
  message: '',
  targetCore: null,
  updated: [],
  kept: [],
  startedAt: new Date().toISOString(),
};

async function save(extra = {}) {
  Object.assign(result, extra, { updatedAt: new Date().toISOString() });
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function launchDesktop() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
}

async function closeDesktop() {
  const ps = [
    `$exe = '${exe.replace(/'/g, "''")}'`,
    `$self = ${process.pid}`,
    `$targets = @(Get-Process | Where-Object { $_.Path -eq $exe -and $_.Id -ne $self })`,
    `if ($targets.Count -eq 0) { exit 0 }`,
    `$targets | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`,
    `Start-Sleep -Seconds 8`,
    `$left = @(Get-Process | Where-Object { $_.Path -eq $exe -and $_.Id -ne $self })`,
    `if ($left.Count -gt 0) { $left | Stop-Process -Force -ErrorAction SilentlyContinue }`,
    `exit 0`,
  ].join('; ');
  return run('powershell.exe', ['-NoProfile', '-Command', ps]);
}

async function waitVersion(expected, timeoutMs = 90000) {
  const escaped = exe.replace(/'/g, "''");
  const command = `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await run('powershell.exe', ['-NoProfile', '-Command', command]);
    if (current.code === 0 && current.stdout.trim().startsWith(expected)) return current.stdout.trim();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

async function updatePlugins(plan) {
  const updates = (plan.items || []).filter((item) => item.action === 'update' && item.to);
  result.updated = updates.map((item) => ({ name: item.name, from: item.from, to: item.to }));
  result.kept = (plan.items || []).filter((item) => item.action === 'keep').map((item) => ({
    name: item.name, version: item.from, reason: item.reason,
  }));
  if (updates.length === 0) return { ok: true, skipped: true };
  const manifestPath = join(profileDir, 'package.json');
  const original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  const backupDir = join(dirname(planPath), `backup-${Date.now()}`);
  await mkdir(backupDir, { recursive: true });
  await copyFile(manifestPath, join(backupDir, 'package.json'));
  for (const name of ['pnpm-lock.yaml', 'package-lock.json']) {
    try { await copyFile(join(profileDir, name), join(backupDir, name)); } catch { /* optional */ }
  }
  for (const item of updates) {
    manifest.dependencies[item.name] = item.to;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const install = await run(process.execPath, [pnpmPath, 'install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  });
  if (install.code === 0) return { ok: true, backupDir };
  await writeFile(manifestPath, original, 'utf8');
  await run(process.execPath, [pnpmPath, 'install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  });
  return { ok: false, backupDir, detail: (install.stderr || install.stdout).slice(-2000) };
}

async function main() {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  result.targetCore = plan.targetCore;
  await save({ state: 'closing', message: '正在关闭 DeepSeek Harness…' });
  await closeDesktop();

  if (installerPath) {
    await save({ state: 'installing-core', message: `正在安装 DeepSeek Harness ${plan.targetCore}…` });
    const installed = await run(installerPath, ['/S', '--updated']);
    if (installed.code !== 0) {
      await save({ state: 'failed', message: `核心安装失败（exit ${installed.code}）` });
      launchDesktop();
      return;
    }
    const version = await waitVersion(plan.targetCore.replace(/-.*$/, ''));
    if (!version) {
      await save({ state: 'failed', message: `安装后未检测到版本 ${plan.targetCore}` });
      launchDesktop();
      return;
    }
    result.coreVersion = version;
  }

  await save({ state: 'updating-plugins', message: '正在安装兼容插件…' });
  const plugins = await updatePlugins(plan);
  if (!plugins.ok) {
    await save({ state: 'failed', message: '插件更新失败，已恢复原 package.json', detail: plugins.detail });
    launchDesktop();
    return;
  }

  await save({ state: 'restarting', message: '更新完成，正在重启…' });
  launchDesktop();
  await save({ state: 'succeeded', message: '更新完成' });
}

main().catch(async (error) => {
  await save({ state: 'failed', message: error instanceof Error ? error.message : String(error) }).catch(() => {});
  if (exe) launchDesktop();
  process.exitCode = 1;
});
