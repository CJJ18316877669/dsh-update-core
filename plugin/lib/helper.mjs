import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const exe = arg('exe');
const profileDir = arg('profile');
const planPath = arg('plan', '');
const resultPath = arg('result');
const installerPath = arg('installer', '');
const rollbackInstaller = arg('rollback-installer', '');
const heartbeatPath = arg('heartbeat', '');
const rollbackMode = arg('rollback-only', '') === '1';
const rollbackVersion = arg('rollback-version', '');
const rollbackPackage = arg('rollback-package', '');
const pnpmPath = arg('pnpm', join(profileDir, 'node_modules', '.bin', 'pnpm.cjs'));

let mutated = false;
const result = {
  state: 'starting',
  message: '',
  targetCore: null,
  coreVersion: null,
  updated: [],
  kept: [],
  rolledBack: false,
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

async function desktopPids() {
  const image = `${exe.split(/[\\/]/).pop()}`;
  const listing = await run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
  const pids = [];
  for (const line of listing.stdout.split(/\r?\n/)) {
    const fields = line.split('","').map((part) => part.replace(/^"|"$/g, ''));
    const pid = Number(fields[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function closeDesktop() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const pids = (await desktopPids()).filter((pid) => pid !== process.pid);
    if (pids.length === 0) return { code: 0, stdout: '', stderr: '' };
    for (const pid of pids) {
      await run('taskkill', ['/F', '/PID', String(pid)]);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const left = (await desktopPids()).filter((pid) => pid !== process.pid);
  return left.length === 0
    ? { code: 0, stdout: '', stderr: '' }
    : { code: 1, stdout: '', stderr: `still running: ${left.join(',')}` };
}

async function productVersion() {
  const escaped = exe.replace(/'/g, "''");
  const current = await run('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`]);
  return current.code === 0 ? current.stdout.trim() : '';
}

async function waitVersion(expected, timeoutMs = 90000) {
  const base = String(expected || '').replace(/-.*$/, '');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await productVersion();
    if (current && (!base || current.startsWith(base))) return current;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

async function waitHeartbeat(startedAt, timeoutMs = 90000) {
  if (!heartbeatPath) return true;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const heartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8'));
      const at = Date.parse(heartbeat.updatedAt || '');
      if (Number.isFinite(at) && at >= startedAt - 2000) return true;
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function launchAndVerify(startedAt) {
  launchDesktop();
  return waitHeartbeat(startedAt);
}

async function pnpmInstall() {
  return run(process.execPath, [pnpmPath, 'install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
  });
}

async function verifyInstalled(plan) {
  const failures = [];
  for (const item of (plan.items || []).filter((entry) => entry.action === 'update')) {
    const expectedVersion = item.version || item.to;
    const manifestPath = join(profileDir, 'node_modules', ...item.name.split('/'), 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.version !== expectedVersion) {
        failures.push(`${item.name}: expected ${expectedVersion}, got ${manifest.version}`);
        continue;
      }
      const root = dirname(manifestPath);
      const entry = typeof manifest.main === 'string'
        ? manifest.main
        : (manifest.exports && typeof manifest.exports === 'object' && typeof manifest.exports['.'] === 'string'
          ? manifest.exports['.']
          : null);
      if (entry && !existsSync(join(root, entry))) failures.push(`${item.name}: entry missing (${entry})`);
      if (manifest.dsh?.bundle?.patch && !existsSync(join(root, manifest.dsh.bundle.patch))) {
        failures.push(`${item.name}: bundle patch missing`);
      }
    } catch (error) {
      failures.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

async function updatePlugins(plan) {
  const updates = (plan.items || []).filter((item) => item.action === 'update' && item.to);
  result.updated = updates.map((item) => ({ name: item.name, from: item.from, to: item.version || item.to }));
  result.kept = (plan.items || []).filter((item) => item.action === 'keep').map((item) => ({
    name: item.name, version: item.from, reason: item.reason,
  }));
  if (updates.length === 0) return { ok: true, skipped: true };
  const manifestPath = join(profileDir, 'package.json');
  const original = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  const backupDir = join(dirname(resultPath), `backup-${Date.now()}`);
  await mkdir(backupDir, { recursive: true });
  await copyFile(manifestPath, join(backupDir, 'package.json'));
  for (const name of ['pnpm-lock.yaml', 'package-lock.json']) {
    try { await copyFile(join(profileDir, name), join(backupDir, name)); } catch { /* optional */ }
  }
  for (const item of updates) manifest.dependencies[item.name] = item.to;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const install = await pnpmInstall();
  if (install.code !== 0) {
    await writeFile(manifestPath, original, 'utf8');
    await pnpmInstall();
    result.updated = [];
    return { ok: false, detail: (install.stderr || install.stdout).slice(-2000) };
  }
  const failures = await verifyInstalled(plan);
  if (failures.length > 0) {
    await writeFile(manifestPath, original, 'utf8');
    await pnpmInstall();
    result.updated = [];
    return { ok: false, detail: failures.join('\n') };
  }
  result.updated = updates.map((item) => ({ name: item.name, from: item.from, to: item.version || item.to }));
  return { ok: true, backupDir };
}

async function restorePackage() {
  if (!rollbackPackage || !existsSync(rollbackPackage)) return false;
  await copyFile(rollbackPackage, join(profileDir, 'package.json'));
  for (const name of ['pnpm-lock.yaml', 'package-lock.json']) {
    const backup = join(dirname(rollbackPackage), name);
    if (existsSync(backup)) await copyFile(backup, join(profileDir, name));
  }
  await pnpmInstall();
  return true;
}

async function rollbackCore() {
  if (!rollbackInstaller || !existsSync(rollbackInstaller)) {
    return { ok: false, reason: 'no-rollback-installer' };
  }
  const closed = await closeDesktop();
  if (closed.code !== 0) {
    return { ok: false, reason: 'close-desktop-failed', detail: (closed.stderr || '').slice(-1000) };
  }
  const installed = await run(rollbackInstaller, ['/S', '--updated']);
  if (installed.code !== 0) {
    return { ok: false, reason: `installer-exit-${installed.code}`, detail: (installed.stderr || installed.stdout).slice(-1000) };
  }
  const version = await waitVersion(rollbackVersion || '');
  if (!version) return { ok: false, reason: 'rollback-version-not-observed' };
  result.coreVersion = version;
  return { ok: true, version };
}

async function failWithRollback(message, detail = '') {
  if (!mutated) {
    const startedAt = Date.now();
    const healthy = await launchAndVerify(startedAt);
    await save({ state: 'failed', message, detail, appHealthy: healthy });
    return;
  }
  await save({ state: 'rolling-back', message: `更新失败，正在回滚：${message}`, detail });
  let coreRolledBack = false;
  let coreRollbackDetail = null;
  if (rollbackInstaller && existsSync(rollbackInstaller)) {
    const core = await rollbackCore();
    coreRolledBack = core.ok === true;
    if (!core.ok) coreRollbackDetail = core;
  }
  const profileRestored = await restorePackage();
  const startedAt = Date.now();
  const healthy = await launchAndVerify(startedAt);
  await save({
    state: coreRolledBack || profileRestored ? 'rolled-back' : 'failed',
    message: coreRolledBack || profileRestored
      ? `已回滚：${message}`
      : `更新失败且回滚未完成：${message}`,
    detail,
    rolledBack: coreRolledBack || profileRestored,
    coreRolledBack,
    coreRollbackDetail,
    profileRestored,
    appHealthy: healthy,
  });
}

async function rollbackOnly() {
  mutated = true;
  await save({ state: 'closing', message: '正在关闭 DeepSeek Harness…' });
  await closeDesktop();
  await save({ state: 'rolling-back', message: `正在回滚到 ${rollbackVersion || '上一版本'}…` });
  const core = await rollbackCore();
  const profileRestored = await restorePackage();
  const startedAt = Date.now();
  const healthy = await launchAndVerify(startedAt);
  await save({
    state: core.ok || profileRestored ? 'rolled-back' : 'failed',
    message: core.ok || profileRestored ? '回滚完成' : '没有可用的回滚点',
    rolledBack: core.ok || profileRestored,
    coreRolledBack: core.ok === true,
    coreRollbackDetail: core.ok ? null : core,
    profileRestored,
    appHealthy: healthy,
  });
}

async function updateFlow() {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  result.targetCore = plan.targetCore;
  await save({ state: 'closing', message: '正在关闭 DeepSeek Harness…' });
  await closeDesktop();

  if (installerPath) {
    mutated = true;
    await save({ state: 'installing-core', message: `正在安装 DeepSeek Harness ${plan.targetCore}…` });
    const installed = await run(installerPath, ['/S', '--updated']);
    if (installed.code !== 0) {
      await failWithRollback(`核心安装失败（exit ${installed.code}）`, (installed.stderr || installed.stdout).slice(-2000));
      return;
    }
    const version = await waitVersion(plan.targetCore);
    if (!version) {
      await failWithRollback(`安装后未检测到版本 ${plan.targetCore}`);
      return;
    }
    result.coreVersion = version;
  }

  await save({ state: 'updating-plugins', message: '正在安装兼容插件…' });
  if ((plan.items || []).some((item) => item.action === 'update')) mutated = true;
  const plugins = await updatePlugins(plan);
  if (!plugins.ok) {
    await failWithRollback('插件更新或静态健康检查失败', plugins.detail);
    return;
  }

  await save({ state: 'verifying-app', message: '正在启动并验证新的 DeepSeek Harness…' });
  const startedAt = Date.now();
  const healthy = await launchAndVerify(startedAt);
  if (!healthy) {
    await failWithRollback('新版本启动后未收到插件心跳');
    return;
  }
  await save({ state: 'succeeded', message: '更新完成，应用已通过启动健康检查' });
}

async function main() {
  if (rollbackMode) return rollbackOnly();
  return updateFlow();
}

main().catch(async (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  await failWithRollback('helper 异常', detail).catch(async () => {
    await save({ state: 'failed', message: detail }).catch(() => {});
    if (exe) launchDesktop();
  });
  process.exitCode = 1;
});
