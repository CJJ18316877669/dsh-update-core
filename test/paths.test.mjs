import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  resolveDshHome,
  dshHomeDisplay,
  expandHomePath,
  assertSafeProfileName,
  assertSafePathLength,
  resolveInside,
} from '../src/platform/paths.mjs';

test('paths: dsh home follows explicit > DSH_HOME > ~/.dsh', () => {
  const home = resolve('C:/Users/example');
  assert.equal(resolveDshHome({ home, env: {} }), join(home, '.dsh'));
  assert.equal(resolveDshHome({ home, env: { DSH_HOME: '~/custom-dsh' } }), join(home, 'custom-dsh'));
  assert.equal(resolveDshHome({ home, env: { DSH_HOME: '   ' } }), join(home, '.dsh'));
  assert.equal(resolveDshHome({ home, env: { DSH_HOME: '~/x' }, configured: 'C:/explicit' }), resolve('C:/explicit'));
  assert.throws(() => resolveDshHome({ home, env: { DSH_HOME: 'relative/path' } }), /absolute/);
  assert.equal(expandHomePath('~', home), home);
  assert.equal(dshHomeDisplay(join(home, '.dsh'), home), '~/.dsh');
  assert.equal(dshHomeDisplay(resolve('C:/other'), home), '$DSH_HOME');
});

test('paths: profile names cannot alias on case-insensitive filesystems', () => {
  assert.equal(assertSafeProfileName('web'), 'web');
  assert.equal(assertSafeProfileName('team.web-2'), 'team.web-2');
  for (const name of ['Web', 'WEB', '..', '../web', 'web/other', '.hidden', 'web ', 'con', 'desktop']) {
    assert.throws(() => assertSafeProfileName(name), undefined, name);
  }
});

test('paths: Windows path length is checked before writes', () => {
  const long = `C:\\${'a'.repeat(260)}\\profiles\\web`;
  assert.throws(
    () => assertSafePathLength(long, { platform: 'win32' }),
    (error) => error.code === 'UPD-702' && error.details.limit === 240,
  );
  assert.equal(assertSafePathLength(long, { platform: 'linux', limit: 240 }), long);
});

test('paths: derived children cannot escape their root', () => {
  const root = resolve('C:/dsh-home/updates');
  assert.equal(resolveInside(root, 'backup', 'web'), join(root, 'backup', 'web'));
  assert.throws(() => resolveInside(root, '..', 'profiles'), /escapes root/);
});
