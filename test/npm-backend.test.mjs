import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmBackend, verifyIntegrity } from '../src/backends/npm.mjs';

const TARBALL = Buffer.from('fake-tarball-bytes');
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;

async function makeProfile() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-npm-'));
  const profile = join(home, 'profiles', 'web');
  await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'profile-web',
    dependencies: {
      '@deepseek-ai/dsh': '0.2.2-rc.1',
      'dsh-plugin-a': '^1.0.0',
      'dsh-plugin-local': 'link:../local',
    },
  }, null, 2));
  await writeFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.2.2-rc.1', engines: { dsh: '>=0.2.0' },
  }));
  await mkdir(join(profile, 'node_modules', 'dsh-plugin-a'), { recursive: true });
  await writeFile(join(profile, 'node_modules', 'dsh-plugin-a', 'package.json'), JSON.stringify({
    name: 'dsh-plugin-a', version: '1.0.0', engines: { dsh: '>=0.2.0' },
  }));
  return { home, profile };
}

function packument(version) {
  return {
    'dist-tags': { latest: version, nightly: '0.2.3-nightly.1' },
    versions: {
      [version]: {
        version,
        engines: { dsh: '>=0.2.0' },
        dist: { integrity: INTEGRITY, tarball: 'https://registry.example/dsh.tgz', unpackedSize: TARBALL.length },
      },
      '0.2.3-nightly.1': {
        version: '0.2.3-nightly.1',
        engines: { dsh: '>=0.2.0' },
        dist: { integrity: INTEGRITY, tarball: 'https://registry.example/nightly.tgz' },
      },
    },
    time: { [version]: '2026-11-07T00:00:00Z' },
  };
}

function fakeFetch(version = '0.2.3') {
  return async (url) => {
    const target = String(url);
    if (target.endsWith('.tgz')) {
      return { ok: true, arrayBuffer: async () => TARBALL };
    }
    if (target.includes('dsh-plugin-a')) {
      return {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.1.0' },
          versions: {
            '1.0.0': { version: '1.0.0', engines: { dsh: '>=0.2.0' } },
            '1.1.0': { version: '1.1.0', engines: { dsh: '>=0.2.0' } },
          },
        }),
      };
    }
    if (target.includes('dsh-plugin-local')) return { ok: true, json: async () => ({ versions: {} }) };
    return { ok: true, json: async () => packument(version) };
  };
}

test('integrity: verifies sha512 and rejects tampering', () => {
  assert.equal(verifyIntegrity(TARBALL, INTEGRITY), true);
  assert.equal(verifyIntegrity(Buffer.from('tampered'), INTEGRITY), false);
  assert.equal(verifyIntegrity(TARBALL, ''), false);
  assert.equal(verifyIntegrity(TARBALL, 'md5-abc'), false);
  assert.equal(verifyIntegrity(TARBALL, 'sha512-short'), false);
});

test('npm backend: check reads dist-tag and requires integrity', async () => {
  const { home } = await makeProfile();
  const backend = new NpmBackend({ home, fetchImpl: fakeFetch() });
  const releases = await backend.check('stable');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].version, '0.2.3');
  assert.equal(releases[0].dist.integrity, INTEGRITY);

  const nightly = new NpmBackend({ home, fetchImpl: fakeFetch() });
  assert.equal((await nightly.check('nightly'))[0].version, '0.2.3-nightly.1');

  const noTag = new NpmBackend({
    home,
    fetchImpl: async () => ({ ok: true, json: async () => ({ 'dist-tags': {}, versions: {} }) }),
  });
  await assert.rejects(() => noTag.check('stable'), (error) => error.code === 'UPD-103');

  const noIntegrity = new NpmBackend({
    home,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '0.2.3' },
        versions: { '0.2.3': { version: '0.2.3', dist: { tarball: 'https://x/y.tgz' } } },
      }),
    }),
  });
  await assert.rejects(() => noIntegrity.check('stable'), (error) => error.code === 'UPD-402');
});

test('npm backend: reads installed version and plugins', async () => {
  const { home } = await makeProfile();
  const backend = new NpmBackend({ home, fetchImpl: fakeFetch() });
  assert.equal(await backend.getCurrentVersion(), '0.2.2-rc.1');
  const plugins = await backend.listPlugins();
  const names = plugins.map((plugin) => plugin.name).sort();
  assert.deepEqual(names, ['dsh-plugin-a', 'dsh-plugin-local']);
  assert.equal(plugins.find((plugin) => plugin.name === 'dsh-plugin-local').spec, 'link');
});

test('npm backend: prepare, activate, health and rollback', async () => {
  const { home, profile } = await makeProfile();
  const backend = new NpmBackend({
    home,
    fetchImpl: fakeFetch(),
    installer: async ({ cwd, signal }) => {
      if (signal && signal.aborted) throw new Error('aborted');
      const manifestDir = join(cwd, 'node_modules', '@deepseek-ai', 'dsh');
      await mkdir(manifestDir, { recursive: true });
      await writeFile(join(manifestDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh', version: '0.2.3',
      }));
      return { stdout: '', stderr: '' };
    },
  });
  await backend.check('stable');
  const snapshot = await backend.snapshot();
  assert.ok(snapshot.path);

  const plan = {
    targetCore: '0.2.3',
    items: [
      { name: 'dsh-plugin-a', action: 'update', from: '1.0.0', to: '1.1.0' },
      { name: 'dsh-plugin-x', action: 'disable', from: '2.0.0', reason: 'no-compatible-version' },
    ],
  };
  const staged = await backend.prepare(plan, { onProgress() {} });
  const stagedManifest = JSON.parse(await readFile(join(staged.path, 'package.json'), 'utf8'));
  assert.equal(stagedManifest.dependencies['@deepseek-ai/dsh'], '0.2.3');
  assert.equal(stagedManifest.dependencies['dsh-plugin-a'], '1.1.0');
  const stagedPlugins = JSON.parse(await readFile(join(staged.path, 'plugins.json'), 'utf8'));
  assert.equal(stagedPlugins.disabled['dsh-plugin-x'].reason, 'no-compatible-version');

  const handle = await backend.activate(staged);
  const health = await backend.health(handle);
  assert.equal(health.ok, true);

  const journal = { snapshot: snapshot.path, from: '0.2.2-rc.1' };
  const rollback = await backend.rollback(journal);
  assert.equal(rollback.ok, true);
  const restored = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.equal(restored.dependencies['@deepseek-ai/dsh'], '0.2.2-rc.1');
});

test('npm backend: rejects insecure registry and missing version', async () => {
  const { home } = await makeProfile();
  assert.throws(() => new NpmBackend({ home, registry: 'http://registry.example.com' }), /https/);
  assert.throws(() => new NpmBackend({ home, registry: 'https://user:pw@registry.example.com' }), /credentials/);
  const backend = new NpmBackend({ home: join(home, 'empty'), fetchImpl: fakeFetch() });
  await assert.rejects(() => backend.getCurrentVersion(), (error) => error.code === 'UPD-702');
});


test('npm backend: rejects snapshot paths outside the backup root', async () => {
  const { home } = await makeProfile();
  const backend = new NpmBackend({ home, fetchImpl: fakeFetch() });
  const result = await backend.rollback({ snapshot: join(home, 'profiles', 'web') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'snapshot-outside-backup-root');
});

test('npm backend: prepare and activate validate their inputs', async () => {
  const { home } = await makeProfile();
  const backend = new NpmBackend({ home, fetchImpl: fakeFetch() });
  await assert.rejects(() => backend.prepare(null), TypeError);
  await assert.rejects(() => backend.activate({ path: '/tmp/x' }), (error) => error.code === 'UPD-501');
});
