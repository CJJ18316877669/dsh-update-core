import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import {
  assertExpectedPluginName,
  assertSafeProfileName,
  backupCandidatePaths,
  resolvePluginDestination,
} from '../scripts/install-plugin-lib.mjs';

test('install plugin: package name is fixed and profile names cannot escape', () => {
  assert.equal(assertExpectedPluginName('dsh-update-core-plugin'), 'dsh-update-core-plugin');
  assert.throws(() => assertExpectedPluginName('../../victim'), /unexpected plugin package name/);
  assert.equal(assertSafeProfileName('desktop'), 'desktop');
  assert.throws(() => assertSafeProfileName('../desktop'), /unsafe profile name/);
  assert.throws(() => assertSafeProfileName('Desktop'), /unsafe profile name/);
});

test('install plugin: destination is confined to node_modules', () => {
  const profile = 'C:\\Users\\test\\.dsh\\profiles\\desktop';
  const destination = resolvePluginDestination(profile, 'dsh-update-core-plugin');
  assert.equal(destination.toLowerCase(), win32.join(profile, 'node_modules', 'dsh-update-core-plugin').toLowerCase());
  assert.throws(
    () => resolvePluginDestination(profile, '../../victim'),
    /unexpected plugin package name/,
  );
});

test('install plugin: pnpm .ignored relocation is included in backup recovery paths', () => {
  const nodeModules = 'C:\\Users\\test\\.dsh\\profiles\\desktop\\node_modules';
  const paths = backupCandidatePaths(nodeModules, 'dsh-update-core-plugin.dsh-install-backup-1');
  assert.equal(paths.length, 2);
  assert.equal(paths[0].toLowerCase(), win32.join(nodeModules, 'dsh-update-core-plugin.dsh-install-backup-1').toLowerCase());
  assert.equal(paths[1].toLowerCase(), win32.join(nodeModules, '.ignored', 'dsh-update-core-plugin.dsh-install-backup-1').toLowerCase());
  assert.throws(() => backupCandidatePaths(nodeModules, '../escape'), /unsafe backup name/);
});
