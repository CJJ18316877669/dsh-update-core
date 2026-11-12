import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneUpdateArtifacts } from '../plugin/lib/retention.mjs';

test('retention: current rollback point and history are kept, obsolete installers removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retention-'));
  const runs = [
    '2026-11-11T03-00-00-000Z',
    '2026-11-11T02-00-00-000Z',
    '2026-11-11T01-00-00-000Z',
  ];
  try {
    for (const [index, run] of runs.entries()) {
      const dir = join(root, run);
      await mkdir(join(dir, 'profile-backup'), { recursive: true });
      await writeFile(join(dir, 'installer.exe'), `installer-${index}`);
      await writeFile(join(dir, 'rollback-installer.exe'), `rollback-${index}`);
      await writeFile(join(dir, 'profile-backup', 'package.json'), '{}');
      await writeFile(join(dir, 'result.json'), JSON.stringify({ state: 'succeeded', run }));
    }
    await mkdir(join(root, 'rollback'), { recursive: true });
    await writeFile(join(root, 'rollback', 'installer.exe'), 'legacy');

    const current = runs[0];
    const coreState = {
      lastRun: current,
      rollbackInstaller: join(root, current, 'rollback-installer.exe'),
      rollbackPackage: join(root, current, 'profile-backup', 'package.json'),
      profileBackup: join(root, current, 'profile-backup'),
    };
    const dryRun = await pruneUpdateArtifacts(root, { keepRuns: 2, coreState, dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.ok(dryRun.planned.length > 0);
    assert.equal(existsSync(join(root, runs[1], 'installer.exe')), true);
    assert.equal(existsSync(join(root, 'rollback', 'installer.exe')), true);

    const outcome = await pruneUpdateArtifacts(root, { keepRuns: 2, coreState });
    assert.equal(outcome.skipped, null);
    assert.equal(existsSync(join(root, current, 'installer.exe')), true);
    assert.equal(existsSync(join(root, current, 'rollback-installer.exe')), true);
    assert.equal(existsSync(join(root, current, 'profile-backup', 'package.json')), true);
    assert.equal(existsSync(join(root, runs[1], 'result.json')), true);
    assert.equal(existsSync(join(root, runs[1], 'installer.exe')), false);
    assert.equal(existsSync(join(root, runs[1], 'rollback-installer.exe')), false);
    assert.equal(existsSync(join(root, runs[1], 'profile-backup')), false);
    assert.equal(existsSync(join(root, runs[2])), false);
    assert.equal(existsSync(join(root, 'rollback', 'installer.exe')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
