import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readDesktopVersion,
} from './plan.mjs';
import { readJson, writeJson } from './store.mjs';
import {
  decideRollbackOutcome,
  normalizeProductVersion,
  rollbackMessage,
  startupLogFailures,
  versionMatches,
} from './helper-core.mjs';
import { parse } from './vendor/semver.mjs';
import { backupProfileConfig, restoreProfileConfig } from './profile-backup.mjs';

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
const backupDir = arg('backup', '');
const rollbackMode = arg('rollback-only', '') === '1';
const profileOnly = arg('profile-only', '') === '1';
const recoverOnly = arg('recover-only', '') === '1';
const rollbackVersion = arg('rollback-version', '');
const rollbackPackage = arg('rollback-package', '');
const runId = arg('run', '');
const configuredPnpm = arg('pnpm', '');
const pnpmPath = configuredPnpm || (profileDir ? join(profileDir, 'node_modules', '.bin', 'pnpm.cjs') : '');

const INSTALL_TIMEOUT_MS = 20 * 60_000;
const PNPM_TIMEOUT_MS = 15 * 60_000;
const CLOSE_TIMEOUT_MS = 45_000;
const STARTUP_LOG_WATCH_MS = 45_000;
const STARTUP_LOG_POLL_MS = 1_000;

let coreMutated = false;
let profileMutated = false;
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
  Object.assign(result, extra, {
    coreMutated,
    profileMutated,
    updatedAt: new Date().toISOString(),
  });
  if (!resultPath) throw new Error('helper requires --result');
  await writeJson(resultPath, result);
  return result;
}

function appendTail(current, chunk) {
  return `${current}${chunk.toString()}`.slice(-64_000);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const child = spawn(command, args, {
      windowsHide: true,
      env: options.env || process.env,
      cwd: options.cwd,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let treeKilled = false;
    const timeoutMessage = `command timed out after ${timeoutMs} ms`;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout,
        stderr: `${stderr}${extra}`,
        timedOut,
      });
    };
    const finishTimeout = () => {
      if (!childClosed || !treeKilled) return;
      finish(124, timeoutMessage);
    };
    const terminateTree = async () => {
      try { child.kill(); } catch { /* best effort */ }
      if (process.platform !== 'win32' || !child.pid) {
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
        treeKilled = true;
        const guard = setTimeout(finishTimeout, 1_000);
        guard.unref?.();
        return;
      }
      await new Promise((done) => {
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
        let completed = false;
        const complete = () => {
          if (completed) return;
          completed = true;
          clearTimeout(guard);
          done();
        };
        const guard = setTimeout(complete, 10_000);
        guard.unref?.();
        killer.once('error', complete);
        killer.once('close', complete);
      }).finally(() => {
        treeKilled = true;
        // The close notification should follow; bound the wait if Windows
        // delays it so recovery is never blocked indefinitely.
        const guard = setTimeout(finishTimeout, 2_000);
        guard.unref?.();
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateTree()
        .catch(() => { treeKilled = true; })
        .finally(finishTimeout);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once('error', (error) => finish(-1, error.message));
    child.once('close', (code) => {
      childClosed = true;
      if (timedOut) finishTimeout();
      else finish(code ?? -1);
    });
  });
}

function appStartupLogPath() {
  return resultPath ? join(dirname(resultPath), 'app-start.log') : '';
}

async function launchDesktop(logPath = '') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  let fd = null;
  if (logPath) {
    try { fd = openSync(logPath, 'w'); } catch { fd = null; }
  }
  let child;
  try {
    child = spawn(exe, [], {
      detached: true,
      stdio: fd === null ? 'ignore' : ['ignore', fd, fd],
      windowsHide: true,
      env,
    });
  } finally {
    if (fd !== null) closeSync(fd);
  }
  await new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise);
    child.once('error', reject);
  });
  child.unref();
}

async function desktopProcesses() {
  const escaped = exe.replace(/'/g, "''");
  const script = [
    `$target=[IO.Path]::GetFullPath('${escaped}')`,
    "$p=@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { try { [IO.Path]::GetFullPath($_.Path) -ieq $target } catch { $false } })",
    '@($p | ForEach-Object { $_.Id }) | ConvertTo-Json -Compress',
  ].join('; ');
  const listing = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 30_000,
  });
  if (listing.code !== 0) {
    return { ok: false, error: listing.stderr || `process query exit ${listing.code}` };
  }
  const text = listing.stdout.trim();
  if (!text) return { ok: true, pids: [] };
  try {
    const parsed = JSON.parse(text);
    const pids = (Array.isArray(parsed) ? parsed : [parsed])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0 && value !== process.pid);
    return { ok: true, pids };
  } catch {
    return { ok: false, error: `cannot parse process list: ${text}` };
  }
}

async function waitForDesktopExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processes = await desktopProcesses();
    if (!processes.ok) return processes;
    if (processes.pids.length === 0) return { ok: true, pids: [] };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return desktopProcesses();
}

async function closeDesktop() {
  const initial = await desktopProcesses();
  if (!initial.ok) return { code: 1, stderr: initial.error };
  if (initial.pids.length === 0) return { code: 0, stdout: '', stderr: '' };

  const ids = initial.pids.join(',');
  await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ids=@(${ids}); foreach($id in $ids){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){ [void]$p.CloseMainWindow() } }`,
  ], { timeoutMs: 20_000 });

  const graceful = await waitForDesktopExit(10_000);
  if (!graceful.ok) return { code: 1, stderr: graceful.error };
  if (graceful.pids.length === 0) return { code: 0, stdout: '', stderr: '' };

  for (const pid of graceful.pids) {
    await run('taskkill', ['/F', '/T', '/PID', String(pid)], { timeoutMs: 20_000 });
  }
  const forced = await waitForDesktopExit(Math.max(5_000, CLOSE_TIMEOUT_MS - 10_000));
  if (!forced.ok) return { code: 1, stderr: forced.error };
  return forced.pids.length === 0
    ? { code: 0, stdout: '', stderr: '' }
    : { code: 1, stdout: '', stderr: `still running: ${forced.pids.join(',')}` };
}

async function installedCoreVersion() {
  try {
    return await readDesktopVersion(exe);
  } catch {
    return '';
  }
}

async function waitVersion(expected, timeoutMs = 120_000) {
  if (!parse(expected)) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await installedCoreVersion();
    if (versionMatches(current, expected)) return normalizeProductVersion(current);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  }
  return null;
}

async function waitHeartbeat(launchedAt, timeoutMs = 120_000, path = heartbeatPath, expectedRun = runId) {
  if (!path) return { ok: false, reason: 'heartbeat path missing' };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const heartbeat = JSON.parse(await readFile(path, 'utf8'));
      const at = Date.parse(heartbeat.updatedAt || '');
      const runMatches = !expectedRun || heartbeat.run === expectedRun;
      if (
        Number.isFinite(at)
        && at >= launchedAt
        && heartbeat.state === 'settled'
        && Number.isInteger(heartbeat.pid)
        && heartbeat.pid !== process.pid
        && runMatches
      ) {
        return { ok: true, heartbeat };
      }
    } catch {
      // The restarted app has not written its heartbeat yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  }
  return { ok: false, reason: 'heartbeat timeout' };
}

/**
 * Watch the relaunched desktop's captured stdout/stderr until it reports a
 * plugin failure or stays clean for the whole settle window. A single read right
 * after the heartbeat races with the host: a bundle rejected by the dsh
 * compatibility gate is reported only once the profile loads, and the host may
 * exit with code 1 seconds later.
 * @param {string} logPath
 * @returns {Promise<string[]>} failure lines, empty when the window stays clean
 */
async function watchStartupLog(logPath) {
  const deadline = Date.now() + STARTUP_LOG_WATCH_MS;
  for (;;) {
    let text = '';
    try { text = await readFile(logPath, 'utf8'); } catch { /* log is best effort */ }
    const failures = startupLogFailures(text);
    if (failures.length > 0) return failures;
    if (Date.now() >= deadline) return [];
    await new Promise((resolvePromise) => setTimeout(resolvePromise, STARTUP_LOG_POLL_MS));
  }
}

async function launchAndVerify() {
  const launchedAt = Date.now();
  const logPath = appStartupLogPath();
  await launchDesktop(logPath);
  const heartbeat = await waitHeartbeat(launchedAt);
  if (!heartbeat.ok) return heartbeat;
  if (logPath) {
    const failures = await watchStartupLog(logPath);
    if (failures.length > 0) {
      return {
        ok: false,
        reason: 'startup log reports plugin activation failures',
        failures,
        logPath,
      };
    }
  }
  return { ...heartbeat, startupLog: logPath ? 'ok' : 'unavailable' };
}

async function pnpmInstall(options = {}) {
  if (!pnpmPath) return { code: -1, stdout: '', stderr: 'pnpm path missing', timedOut: false };
  const args = [
    pnpmPath,
    'install',
    '--ignore-scripts',
    options.frozen ? '--frozen-lockfile' : '--no-frozen-lockfile',
  ];
  if (options.offline) args.push('--offline');
  return run(process.execPath, args, {
    cwd: profileDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    timeoutMs: options.timeoutMs ?? PNPM_TIMEOUT_MS,
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

async function verifyAllDependencies() {
  const failures = [];
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
    for (const name of Object.keys(manifest.dependencies || {})) {
      if (!existsSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))) {
        failures.push(`${name}: dependency is not installed`);
      }
    }
  } catch (error) {
    failures.push(`profile package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures;
}

async function backupProfileFiles(destination) {
  return backupProfileConfig(profileDir, destination);
}

async function restoreProfileBackup() {
  const candidates = [
    rollbackPackage,
    backupDir ? join(backupDir, 'package.json') : '',
  ].filter(Boolean);
  const sourcePackage = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePackage) return { ok: false, detail: 'profile backup is missing' };
  const source = dirname(sourcePackage);
  try {
    await restoreProfileConfig(source, profileDir);
    const frozen = ['pnpm-lock.yaml', 'package-lock.json'].some((name) => (
      existsSync(join(profileDir, name))
    ));
    let install = await pnpmInstall({
      frozen,
      offline: true,
      timeoutMs: 5 * 60_000,
    });
    const offlineSucceeded = install.code === 0;
    if (!offlineSucceeded) {
      install = await pnpmInstall({ frozen, offline: false });
    }
    if (install.code !== 0) {
      return {
        ok: false,
        detail: (install.stderr || install.stdout).slice(-4000) || `pnpm exit ${install.code}`,
      };
    }
    const missing = await verifyAllDependencies();
    if (missing.length > 0) return { ok: false, detail: missing.join('\n') };
    return { ok: true, offline: offlineSucceeded };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function updatePlugins(plan) {
  const updates = (plan.items || []).filter((item) => item.action === 'update' && item.to);
  result.kept = (plan.items || []).filter((item) => item.action === 'keep').map((item) => ({
    name: item.name,
    version: item.from,
    reason: item.reason,
  }));
  if (updates.length === 0) return { ok: true, skipped: true };

  const manifestPath = join(profileDir, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') {
    return { ok: false, detail: 'profile package.json has no dependencies' };
  }
  for (const item of updates) manifest.dependencies[item.name] = item.to;
  await writeJson(manifestPath, manifest);
  const install = await pnpmInstall();
  if (install.code !== 0) {
    return {
      ok: false,
      detail: (install.stderr || install.stdout).slice(-4000) || `pnpm exit ${install.code}`,
    };
  }
  const failures = [...await verifyInstalled(plan), ...await verifyAllDependencies()];
  if (failures.length > 0) return { ok: false, detail: failures.join('\n') };
  result.updated = updates.map((item) => ({
    name: item.name,
    from: item.from,
    to: item.version || item.to,
  }));
  return { ok: true };
}

async function rollbackCore() {
  if (!rollbackInstaller || !existsSync(rollbackInstaller)) {
    return { ok: false, reason: 'no-rollback-installer' };
  }
  const closed = await closeDesktop();
  if (closed.code !== 0) {
    return { ok: false, reason: 'close-desktop-failed', detail: (closed.stderr || '').slice(-1000) };
  }
  const installed = await run(rollbackInstaller, ['/S', '--updated'], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (installed.code !== 0) {
    return {
      ok: false,
      reason: installed.timedOut ? 'installer-timeout' : `installer-exit-${installed.code}`,
      detail: (installed.stderr || installed.stdout).slice(-2000),
    };
  }
  const version = await waitVersion(rollbackVersion || '');
  if (!version) return { ok: false, reason: 'rollback-version-not-observed' };
  result.coreVersion = version;
  return { ok: true, version };
}

async function failWithRollback(message, detail = '', options = {}) {
  if (!coreMutated && !profileMutated) {
    let healthy = { ok: false };
    if (options.relaunch !== false) {
      healthy = await launchAndVerify().catch((error) => ({ ok: false, reason: error.message }));
    }
    await save({
      state: 'failed',
      message,
      detail,
      appHealthy: healthy.ok,
      startupLog: healthy.startupLog || null,
      startupLogDetail: healthy.failures || null,
      healthDetail: healthy.reason || null,
    });
    return;
  }

  await save({ state: 'rolling-back', message: `更新失败，正在回滚：${message}`, detail });
  let coreRolledBack = null;
  let coreRollbackDetail = null;
  if (coreMutated) {
    const core = await rollbackCore();
    coreRolledBack = core.ok === true;
    if (!core.ok) coreRollbackDetail = core;
  }
  let profileRestored = null;
  let profileDetail = null;
  if (profileMutated) {
    const restored = await restoreProfileBackup();
    profileRestored = restored.ok === true;
    if (!restored.ok) profileDetail = restored.detail;
  }

  let healthy = { ok: false };
  if (options.relaunch !== false) {
    healthy = await launchAndVerify().catch((error) => ({ ok: false, reason: error.message }));
  }
  const outcome = decideRollbackOutcome({
    appHealthy: healthy.ok,
    coreMutated,
    coreRolledBack,
    profileMutated,
    profileRestored,
  });
  await save({
    state: outcome.state,
    message: outcome.rolledBack
      ? `已回滚：${message}`
      : rollbackMessage({
        complete: outcome.rolledBack,
        coreMutated,
        coreRolledBack,
        profileMutated,
        profileRestored,
        appHealthy: healthy.ok,
      }),
    detail,
    rolledBack: outcome.rolledBack,
    coreRolledBack,
    coreRollbackDetail,
    profileRestored,
    profileDetail,
    appHealthy: healthy.ok,
    startupLog: healthy.startupLog || null,
    startupLogDetail: healthy.failures || null,
    healthDetail: healthy.reason || null,
  });
}

async function rollbackOnly() {
  await save({ state: 'closing', message: '正在关闭 DeepSeek Harness…' });
  const closed = await closeDesktop();
  if (closed.code !== 0) {
    await save({
      state: 'failed',
      message: `无法安全关闭 DeepSeek Harness：${closed.stderr || 'unknown error'}`,
      rolledBack: false,
      appHealthy: false,
    });
    return;
  }

  const current = await installedCoreVersion();
  const coreRequired = !profileOnly && Boolean(
    rollbackVersion
    && parse(rollbackVersion)
    && !versionMatches(current, rollbackVersion),
  );
  const hasProfileBackup = Boolean(
    (rollbackPackage && existsSync(rollbackPackage))
    || (backupDir && existsSync(join(backupDir, 'package.json'))),
  );
  coreMutated = coreRequired;
  profileMutated = hasProfileBackup;

  await save({ state: 'rolling-back', message: `正在回滚到 ${rollbackVersion || '上一版本'}…` });
  let coreRolledBack = null;
  let coreRollbackDetail = null;
  if (coreRequired) {
    const core = await rollbackCore();
    coreRolledBack = core.ok === true;
    if (!core.ok) coreRollbackDetail = core;
  }
  let profileRestored = null;
  let profileDetail = null;
  if (hasProfileBackup) {
    const restored = await restoreProfileBackup();
    profileRestored = restored.ok === true;
    if (!restored.ok) profileDetail = restored.detail;
  }

  const healthy = await launchAndVerify().catch((error) => ({ ok: false, reason: error.message }));
  const outcome = decideRollbackOutcome({
    appHealthy: healthy.ok,
    coreMutated,
    coreRolledBack,
    profileMutated,
    profileRestored,
  });
  await save({
    state: outcome.state,
    message: outcome.rolledBack
      ? (profileOnly
        ? '插件 profile 已回滚；核心保持当前版本，应用已重新启动'
        : '回滚完成：应用已重新启动，启动日志与更新插件心跳验证通过')
      : rollbackMessage({
        complete: outcome.rolledBack,
        coreMutated,
        coreRolledBack,
        profileMutated,
        profileRestored,
        appHealthy: healthy.ok,
      }),
    rolledBack: outcome.rolledBack,
    profileOnly,
    coreRolledBack,
    coreRollbackDetail,
    profileRestored,
    profileDetail,
    appHealthy: healthy.ok,
    startupLog: healthy.startupLog || null,
    startupLogDetail: healthy.failures || null,
    healthDetail: healthy.reason || null,
  });
}

async function updateFlow() {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  result.targetCore = plan.targetCore;
  await save({ state: 'closing', message: '正在关闭 DeepSeek Harness…' });
  const closed = await closeDesktop();
  if (closed.code !== 0) {
    await failWithRollback(
      `无法安全关闭 DeepSeek Harness：${closed.stderr || 'unknown error'}`,
      '',
      { relaunch: false },
    );
    return;
  }

  if (installerPath) {
    coreMutated = true;
    await save({ state: 'installing-core', message: `正在安装 DeepSeek Harness ${plan.targetCore}…` });
    const installed = await run(installerPath, ['/S', '--updated'], { timeoutMs: INSTALL_TIMEOUT_MS });
    if (installed.code !== 0) {
      await failWithRollback(
        installed.timedOut ? '核心安装超时' : `核心安装失败（exit ${installed.code}）`,
        (installed.stderr || installed.stdout).slice(-4000),
      );
      return;
    }
    const version = await waitVersion(plan.targetCore);
    if (!version) {
      await failWithRollback(`安装后未检测到精确版本 ${plan.targetCore}`);
      return;
    }
    result.coreVersion = version;
  }

  const willUpdatePlugins = (plan.items || []).some((item) => item.action === 'update');
  if (willUpdatePlugins) profileMutated = true;
  await save({ state: 'updating-plugins', message: '正在安装兼容插件…' });
  const plugins = await updatePlugins(plan);
  if (!plugins.ok) {
    await failWithRollback('插件更新或静态健康检查失败', plugins.detail);
    return;
  }

  await save({ state: 'verifying-app', message: '正在启动并验证新的 DeepSeek Harness…' });
  const healthy = await launchAndVerify().catch((error) => ({ ok: false, reason: error.message }));
  if (!healthy.ok) {
    await failWithRollback(`新版本启动后未通过启动健康验证：${healthy.reason || 'unknown'}`, (healthy.failures || []).join('\n'));
    return;
  }
  result.coreVersion = result.coreVersion || await installedCoreVersion();
  await save({
    state: 'succeeded',
    message: '更新完成：应用已稳定运行，启动日志无插件激活失败，更新插件心跳与 profile 依赖完整性检查通过',
    appHealthy: true,
    startupLog: healthy.startupLog || null,
    profileDependencies: 'ok',
  });
  if (installerPath) await unlink(installerPath).catch(() => {});
}

async function recoverAfterCrash() {
  const previous = await readJson(resultPath, null);
  if (previous && ['succeeded', 'failed', 'rolled-back'].includes(previous.state)) return;
  coreMutated = previous?.coreMutated === true;
  profileMutated = previous?.profileMutated === true;
  const previousState = previous?.state || 'unknown';
  result.targetCore = previous?.targetCore || result.targetCore;
  result.coreVersion = previous?.coreVersion || result.coreVersion;
  result.recoveredFrom = previousState;
  const detail = `supervisor detected an abnormal helper exit while state=${previousState}`;
  await failWithRollback('更新助手异常退出，已触发自动恢复', detail);
}

async function main() {
  if (!exe || !profileDir || !resultPath) throw new Error('helper requires --exe, --profile and --result');
  if (recoverOnly) return recoverAfterCrash();
  if (rollbackMode) return rollbackOnly();
  return updateFlow();
}

const isMain = Boolean(process.argv[1])
  && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  main().catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    await failWithRollback('helper 异常', detail).catch(async () => {
      await save({ state: 'failed', message: detail, appHealthy: false }).catch(() => {});
      if (exe) launchDesktop().catch(() => {});
    });
    process.exitCode = 1;
  });
}

export {
  backupProfileFiles,
  closeDesktop,
  failWithRollback,
  launchAndVerify,
  launchDesktop,
  restoreProfileBackup,
  run,
  updatePlugins,
  updateFlow,
  waitHeartbeat,
  waitVersion,
};
