import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { AbortedError, UpdateError } from '../errors.mjs';

const execFileAsync = promisify(execFile);
const PACKAGE_MANAGER_COMMANDS = new Set(['npm', 'npm.cmd', 'pnpm', 'pnpm.cmd']);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path);
      return path;
    } catch {
      // 尝试下一个已知安装位置。
    }
  }
  return null;
}

async function resolvePackageManagerCli(manager) {
  const candidates = [];
  if (process.env.npm_execpath && process.env.npm_execpath.toLowerCase().includes(manager)) {
    candidates.push(process.env.npm_execpath);
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', manager, 'bin', manager === 'npm' ? 'npm-cli.js' : 'pnpm.cjs'));
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', manager, 'bin', manager === 'npm' ? 'npm-cli.js' : 'pnpm.cjs'));
  }
  for (const entry of (process.env.PATH || '').split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    if (manager === 'pnpm') candidates.push(join(directory, 'pnpm.cjs'));
    candidates.push(join(directory, 'node_modules', manager, 'bin', manager === 'npm' ? 'npm-cli.js' : 'pnpm.cjs'));
    if (manager === 'pnpm') candidates.push(join(directory, '..', 'pnpm', 'bin', 'pnpm.cjs'));
  }
  return firstExisting(candidates);
}

async function resolveLaunch(command, args) {
  if (process.platform !== 'win32' || !PACKAGE_MANAGER_COMMANDS.has(command.toLowerCase())) {
    return { command, args, shell: false };
  }
  const manager = command.toLowerCase().startsWith('pnpm') ? 'pnpm' : 'npm';
  const cli = await resolvePackageManagerCli(manager);
  if (cli) {
    return { command: process.execPath, args: [cli, ...args], shell: false };
  }
  // 只允许包管理器自身的受控 shell 退路；参数仍是数组，不拼命令字符串。
  return { command, args, shell: true };
}

async function windowsProcessExists(pid) {
  const { stdout } = await execFileAsync('tasklist', [
    '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH',
  ], { windowsHide: true });
  return new RegExp(`^"[^"]*","${pid}",`, 'm').test(stdout);
}

async function posixGroupExists(pgid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pgid=']);
    return stdout.split(/\r?\n/).some((line) => line.trim() === String(pgid));
  } catch {
    // ps 不可用时仍以进程组查询为准，不因辅助命令失败而跳过清理。
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false;
      throw error;
    }
  }
}

async function waitForGone(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await check()) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return true;
}

/**
 * 终止 child 及其后代；重复调用或进程已退出时保持幂等。
 * @param {import('node:child_process').ChildProcess} child
 * @param {{graceMs?:number}} [options]
 */
export async function killTree(child, { graceMs = 1000 } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;

  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.once('error', reject);
      killer.once('close', () => resolve());
    });
    await waitForGone(() => windowsProcessExists(pid), 5000);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error;
  }
  if (await waitForGone(() => posixGroupExists(pid), graceMs)) return;

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error;
  }
  await waitForGone(() => posixGroupExists(pid), 5000);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd:string, signal?:AbortSignal, timeoutMs?:number}} options
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
export async function runCommand(command, args, options) {
  if (options.signal && options.signal.aborted) throw new AbortedError();
  const label = options.label || 'command';
  const launch = await resolveLaunch(command, args);
  if (options.signal && options.signal.aborted) throw new AbortedError();

  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: launch.shell,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.env || {}),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    });
    let stderr = '';
    let stdout = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const terminate = async (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await killTree(child, { graceMs: 250 });
      } catch {
        // 保留超时/取消的公开错误语义；残留由系统状态测试约束。
      }
      reject(error);
    };
    const onAbort = () => { void terminate(new AbortedError()); };
    const timer = setTimeout(() => {
      void terminate(new UpdateError('UPD-501', {
        message: `${label} timed out after ${options.timeoutMs || 180000}ms`,
      }));
    }, options.timeoutMs || 180000);

    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-8000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.on('error', (error) => {
      finish(new UpdateError('UPD-501', { message: `${label} failed: ${error.message}`, cause: error }));
    });
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new UpdateError('UPD-501', {
        message: `${label} exited with ${code}`,
        details: { stderr: stderr.slice(-2000) },
      }));
    });
  });
}
