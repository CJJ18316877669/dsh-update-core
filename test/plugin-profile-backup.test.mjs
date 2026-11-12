import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupProfileConfig, restoreProfileConfig } from '../plugin/lib/profile-backup.mjs';

test('profile backup: restores settings and removes config created during a failed update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-backup-'));
  const profile = join(root, 'profile');
  const backup = join(root, 'backup');
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'package.json'), '{"dependencies":{}}');
    await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    await writeFile(join(profile, 'cordis.patch.yml'), 'original patch');
    await writeFile(join(profile, 'compatibility.json'), '{"original":true}');

    const files = await backupProfileConfig(profile, backup);
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('cordis.patch.yml'));
    assert.ok(files.includes('compatibility.json'));

    await writeFile(join(profile, 'package.json'), '{"dependencies":{"bad":"1"}}');
    await writeFile(join(profile, 'cordis.patch.yml'), 'migrated patch');
    await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages: []');
    await restoreProfileConfig(backup, profile);

    assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), '{"dependencies":{}}');
    assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), 'original patch');
    assert.equal(await readFile(join(profile, 'compatibility.json'), 'utf8'), '{"original":true}');
    assert.equal(existsSync(join(profile, 'pnpm-workspace.yaml')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
