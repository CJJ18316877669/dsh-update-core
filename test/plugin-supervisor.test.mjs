import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRunLock } from '../plugin/lib/run-lock.mjs';

const supervisor = fileURLToPath(new URL('../plugin/lib/supervisor.mjs', import.meta.url));
const fakeHelper = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url));

test('supervisor: helper crash starts one recovery run and writes a terminal result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-supervisor-'));
  const run = '2026-11-11T12-00-00-000Z';
  const runDir = join(root, run);
  const resultPath = join(runDir, 'result.json');
  const lockPath = join(root, 'update.lock');
  try {
    await mkdir(runDir, { recursive: true });
    assert.equal((await acquireRunLock(lockPath, run)).ok, true);
    const result = spawnSync(process.execPath, [
      supervisor,
      '--helper-path', fakeHelper,
      '--result', resultPath,
      '--run', run,
      '--lock', lockPath,
      '--fake-crash', '1',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const state = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(state.state, 'rolled-back');
    assert.equal(state.rolledBack, true);
    assert.equal(state.message, 'fake recovery complete');
    assert.equal(existsSync(join(runDir, 'helper.log')), true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
