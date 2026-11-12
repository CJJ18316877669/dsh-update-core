import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './store.mjs';
import { refreshRunLock, releaseRunLock, touchRunLock } from './run-lock.mjs';

const HELPER = fileURLToPath(new URL('./helper.mjs', import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const helperArgs = process.argv.slice(2);
const helperPath = resolve(arg('helper-path', HELPER));
const resultPath = arg('result');
const lockPath = arg('lock', '');
const runId = arg('run', '');
const exe = arg('exe', '');
const logPath = resultPath ? join(dirname(resultPath), 'helper.log') : '';
let log = null;
let lockHeartbeat = null;

function appendLog(text) {
  if (!log) return;
  try { log.write(`${new Date().toISOString()} ${text}\n`); } catch { /* best effort */ }
}

async function readState() {
  try {
    return JSON.parse(await readFile(resultPath, 'utf8'));
  } catch {
    return null;
  }
}

function terminal(state) {
  return Boolean(state && ['succeeded', 'failed', 'rolled-back'].includes(state.state));
}

function launchHelper(extra = []) {
  return new Promise((resolvePromise) => {
    appendLog(`[supervisor] launching helper ${extra.join(' ')}`.trim());
    const child = spawn(process.execPath, [helperPath, ...helperArgs, ...extra], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      appendLog(`[supervisor] helper exited code=${result.code}${result.error ? ` error=${result.error}` : ''}`);
      resolvePromise(result);
    };
    child.stdout?.on('data', (chunk) => appendLog(`[stdout] ${chunk.toString().trimEnd()}`));
    child.stderr?.on('data', (chunk) => appendLog(`[stderr] ${chunk.toString().trimEnd()}`));
    child.once('error', (error) => finish({ code: -1, error: error.message }));
    child.once('close', (code) => finish({ code: code ?? -1 }));
  });
}

async function relaunchDesktop() {
  if (!exe || !existsSync(exe)) return false;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return new Promise((resolvePromise) => {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true, env });
    const settle = (value) => resolvePromise(value);
    child.once('spawn', () => {
      child.unref();
      settle(true);
    });
    child.once('error', () => settle(false));
  });
}

async function runSupervised() {
  if (!resultPath) throw new Error('supervisor requires --result');
  if (logPath) {
    log = createWriteStream(logPath, { flags: 'a' });
    log.on('error', () => { log = null; });
  }
  if (lockPath && runId) {
    await refreshRunLock(lockPath, runId, { pid: process.pid, role: 'supervisor' });
    lockHeartbeat = setInterval(() => {
      void touchRunLock(lockPath, runId);
    }, 30_000);
    lockHeartbeat.unref?.();
  }

  appendLog(`[supervisor] started pid=${process.pid} run=${runId || 'unknown'}`);
  const first = await launchHelper();
  let state = await readState();
  if (terminal(state)) {
    appendLog(`[supervisor] terminal state=${state.state}`);
    return 0;
  }

  appendLog(`[supervisor] helper ended without terminal state; starting recovery`);
  const recovery = await launchHelper(['--recover-only', '1']);
  state = await readState();
  if (terminal(state)) {
    appendLog(`[supervisor] recovery terminal state=${state.state}`);
    return 0;
  }

  appendLog('[supervisor] recovery failed; writing failed result');
  await writeJson(resultPath, {
    ...(state || {}),
    state: 'failed',
    message: `更新助手与自动恢复均异常退出（${first.code}/${recovery.code}）`,
    rolledBack: false,
    appHealthy: false,
    updatedAt: new Date().toISOString(),
  }).catch(() => {});
  await relaunchDesktop();
  return 1;
}

runSupervised().catch(async (error) => {
  appendLog(`[supervisor] fatal error: ${error instanceof Error ? error.message : String(error)}`);
  if (resultPath) {
    const state = await readState().catch(() => null);
    if (!terminal(state)) {
      await writeJson(resultPath, {
        ...(state || {}),
        state: 'failed',
        message: `更新 supervisor 异常：${error instanceof Error ? error.message : String(error)}`,
        rolledBack: false,
        appHealthy: false,
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }
  await relaunchDesktop();
  process.exitCode = 1;
}).finally(async () => {
  if (lockHeartbeat) clearInterval(lockHeartbeat);
  appendLog('[supervisor] stopped');
  log?.end();
  if (lockPath && runId) await releaseRunLock(lockPath, runId).catch(() => {});
});
