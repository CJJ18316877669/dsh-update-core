import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/platform/process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/process-tree.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await pause(25);
  }
  return false;
}

async function startTree(mode) {
  const cwd = await mkdtemp(join(tmpdir(), `dsh-process-${mode}-`));
  const pidFile = join(cwd, 'pids.json');
  const controller = new AbortController();
  const pending = runCommand(process.execPath, [fixture, pidFile], {
    cwd,
    signal: controller.signal,
    timeoutMs: mode === 'timeout' ? 150 : 20000,
  });
  assert.equal(await waitFor(async () => {
    try {
      await readFile(pidFile, 'utf8');
      return true;
    } catch {
      return false;
    }
  }), true, 'child tree did not start');
  const pids = JSON.parse(await readFile(pidFile, 'utf8'));
  if (mode === 'abort') controller.abort();
  return { cwd, pending, pids };
}

for (const mode of ['abort', 'timeout']) {
  test(`process: ${mode} terminates the complete child tree`, { timeout: 15000 }, async (t) => {
    const { cwd, pending, pids } = await startTree(mode);
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await assert.rejects(pending, (error) => mode === 'abort'
      ? error.name === 'AbortedError'
      : error.code === 'UPD-501' && /timed out/.test(error.message));
    assert.equal(await waitFor(() => !processExists(pids.parent) && !processExists(pids.child)), true,
      `residual process(es): ${JSON.stringify(pids)}`);
  });
}

test('process: npm launches without a shell-injection-prone command string', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-process-npm-'));
  try {
    const result = await runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
      cwd,
      timeoutMs: 20000,
    });
    assert.match(result.stdout, /\d+\.\d+\.\d+/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('process: non-zero exits retain stderr tail and public error code', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.stderr.write("x".repeat(2100)); process.exit(7)'], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    }),
    (error) => error.code === 'UPD-501'
      && error.details.stderr.length === 2000
      && error.details.stderr === 'x'.repeat(2000),
  );
});
