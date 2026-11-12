import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideRollbackOutcome,
  normalizeProductVersion,
  rollbackMessage,
  startupLogFailures,
  versionMatches,
} from '../plugin/lib/helper-core.mjs';

test('helper startup log: activation warnings fail health while normal logs pass', () => {
  assert.deepEqual(startupLogFailures([
    'Checking for update',
    'dsh web: http://127.0.0.1:1234/?token=redacted',
    '[hub] routes mounted',
  ].join('\n')), []);
  const failures = startupLogFailures([
    'Checking for update',
    'dsh: warning: 1 entry did not activate',
    'dsh-plugin-x (dsh-plugin-x): pending (waiting for service: webServer)',
  ].join('\n'));
  assert.equal(failures.length, 2);
  assert.match(failures[0], /did not activate/);
  assert.match(failures[1], /pending \(waiting for service/);
});

test('helper version verification: ProductVersion fallback is normalised but prereleases stay exact', () => {
  assert.equal(normalizeProductVersion('0.2.2.0'), '0.2.2');
  assert.equal(normalizeProductVersion('0.2.2-rc.1'), '0.2.2-rc.1');
  assert.equal(versionMatches('0.2.2.0', '0.2.2'), true);
  assert.equal(versionMatches('0.2.2.0', '0.2.2-rc.1'), false);
  assert.equal(versionMatches('0.2.2-rc.1', '0.2.2-rc.1'), true);
  assert.equal(versionMatches('0.2.2-rc.2', '0.2.2-rc.1'), false);
  assert.equal(versionMatches('0.2.20.0', '0.2.2'), false);
});

test('helper module imports without launching an update', async () => {
  const module = await import('../plugin/lib/helper.mjs');
  assert.equal(typeof module.updateFlow, 'function');
  assert.equal(typeof module.restoreProfileBackup, 'function');
});

test('helper run: timeout waits for process-tree termination before resolving', async () => {
  const module = await import('../plugin/lib/helper.mjs');
  const outcome = await module.run(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 250 },
  );
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.code, 124);
});

test('helper heartbeat: requires a fresh settled heartbeat bound to the run', async () => {
  const module = await import('../plugin/lib/helper.mjs');
  const root = await mkdtemp(join(tmpdir(), 'dsh-heartbeat-'));
  const file = join(root, 'heartbeat.json');
  try {
    await writeFile(file, JSON.stringify({
      pid: process.pid + 1,
      state: 'loaded',
      run: 'run-a',
      updatedAt: new Date().toISOString(),
    }));
    const stale = await module.waitHeartbeat(Date.now() - 1_000, 100, file, 'run-a');
    assert.equal(stale.ok, false);
    await writeFile(file, JSON.stringify({
      pid: process.pid + 1,
      state: 'settled',
      run: 'run-a',
      updatedAt: new Date().toISOString(),
    }));
    const healthy = await module.waitHeartbeat(Date.now() - 1_000, 1_000, file, 'run-a');
    assert.equal(healthy.ok, true);
    const wrongRun = await module.waitHeartbeat(Date.now() - 1_000, 100, file, 'run-b');
    assert.equal(wrongRun.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollback outcome: every mutation and app health must be restored', () => {
  const successful = decideRollbackOutcome({
    appHealthy: true,
    coreMutated: true,
    coreRolledBack: true,
    profileMutated: true,
    profileRestored: true,
  });
  assert.equal(successful.state, 'rolled-back');
  assert.equal(successful.rolledBack, true);

  const missingCoreInstaller = decideRollbackOutcome({
    appHealthy: true,
    coreMutated: true,
    coreRolledBack: false,
    profileMutated: true,
    profileRestored: true,
  });
  assert.equal(missingCoreInstaller.state, 'failed');
  assert.equal(missingCoreInstaller.rolledBack, false);
  assert.equal(missingCoreInstaller.coreSafe, false);

  const unhealthy = decideRollbackOutcome({
    appHealthy: false,
    coreMutated: false,
    coreRolledBack: null,
    profileMutated: true,
    profileRestored: true,
  });
  assert.equal(unhealthy.state, 'failed');
  assert.equal(unhealthy.rolledBack, false);

  const pluginOnly = decideRollbackOutcome({
    appHealthy: true,
    coreMutated: false,
    coreRolledBack: null,
    profileMutated: true,
    profileRestored: true,
  });
  assert.equal(pluginOnly.state, 'rolled-back');
  assert.equal(pluginOnly.rolledBack, true);
});

test('rollback message names the layers that failed', () => {
  const message = rollbackMessage({
    complete: false,
    coreMutated: true,
    coreRolledBack: false,
    profileMutated: true,
    profileRestored: false,
    appHealthy: false,
  });
  assert.match(message, /核心未能回滚/);
  assert.match(message, /插件 profile 未能完整恢复/);
  assert.match(message, /应用未通过启动健康检查/);
});
