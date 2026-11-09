import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { UpdateOrchestrator } from '../src/orchestrator.mjs';
import { UpdateJournal } from '../src/journal.mjs';
import { Watchdog } from '../src/watchdog.mjs';
import { PluginGate } from '../src/plugin-gate.mjs';
import { FakeBackend } from '../src/backends/fake.mjs';
import { NpmBackend } from '../src/backends/npm.mjs';

const TARBALL = Buffer.from('staging-tarball');
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;

async function setup(backendOptions = {}, gateOptions = {}, orchestratorOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-staging-'));
  const backend = new FakeBackend(backendOptions);
  const journal = new UpdateJournal({ home });
  const orchestrator = new UpdateOrchestrator({
    backend,
    gate: new PluginGate(gateOptions),
    journal,
    watchdog: new Watchdog({ home }),
    home,
    ...orchestratorOptions,
  });
  await orchestrator.check();
  return { home, backend, journal, orchestrator };
}

async function treeHash(dir) {
  const hash = createHash('sha256');
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      hash.update(relative(dir, full));
      if (entry.isDirectory()) await walk(full);
      else hash.update(await readFile(full));
    }
  }
  await walk(dir);
  return hash.digest('hex');
}

test('staging: healthy profile reaches applying and keeps evidence in committed journal', async () => {
  const { journal, orchestrator, backend } = await setup({}, {}, { stagingTimeoutMs: 1000 });
  let calls = 0;
  orchestrator.stagingVerifier = async () => {
    calls += 1;
    return {
      ok: true,
      checks: ['version', 'dump-config', 'boot'],
      evidence: { version: '0.2.3', dumpConfig: '- id: plugin', bootLog: 'ready' },
    };
  };
  const state = await orchestrator.start({ confirm: true });
  assert.equal(state.state, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(backend.calls.includes('stagingHealth'), false);
  assert.ok(backend.calls.indexOf('prepare') < backend.calls.indexOf('drain'));
  assert.ok(backend.calls.indexOf('drain') < backend.calls.indexOf('activate'));
  const saved = await journal.read();
  assert.equal(saved.state, 'committed');
  assert.equal(saved.stagingEvidence[0].evidence.bootLog, 'ready');
});

test('staging: an optional plugin that fails import is disabled in staging', async () => {
  const { orchestrator, backend, journal } = await setup({
    plugins: [
      { name: 'dsh-plugin-unknown', version: '1.0.0', kind: 'plugin', manifest: {} },
    ],
    available: { 'dsh-plugin-unknown': [{ version: '1.0.0', manifest: {} }] },
  }, {
    verifier: async () => ({ ok: false, reason: 'Cannot find module broken-entry' }),
  });
  orchestrator.stagingVerifier = async () => ({ ok: true, checks: ['boot'], evidence: { bootLog: 'started' } });
  const state = await orchestrator.start({ confirm: true });
  assert.equal(state.state, 'succeeded');
  assert.equal(state.result.disables, 1);
  assert.deepEqual(backend.stagingDecisions.map((handle) => handle.name), ['dsh-plugin-unknown']);
  assert.equal((await journal.read()).plan.disables, 1);
});

test('staging: a core plugin failure blocks before activation and writes no success', async () => {
  const { orchestrator, backend, journal } = await setup({
    plugins: [
      { name: '@deepseek-ai/dsh-tool-broken', version: '0.2.2', kind: 'core', protected: true, manifest: {} },
    ],
    available: { '@deepseek-ai/dsh-tool-broken': [{ version: '0.2.2', manifest: {} }] },
  }, {
    verifier: async () => ({ ok: false, reason: 'fatal import' }),
  });
  orchestrator.stagingVerifier = async () => ({ ok: true, checks: ['boot'], evidence: { bootLog: 'started' } });
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-202');
  assert.equal(orchestrator.getState().state, 'blocked');
  assert.equal(backend.calls.includes('activate'), false);
  assert.equal((await journal.read()).state, 'failed');
  assert.equal(await backend.getCurrentVersion(), '0.2.2-rc.1');
});

test('staging: timeout is bounded and never activates', async () => {
  const { orchestrator, backend, journal } = await setup({}, {}, { stagingTimeoutMs: 25 });
  orchestrator.stagingVerifier = async () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(
    () => orchestrator.start({ confirm: true }),
    (error) => error.code === 'UPD-502' && /timed out/.test(error.message),
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(backend.calls.includes('activate'), false);
  assert.equal((await journal.read()).state, 'failed');
});

test('staging: a failed staging boot leaves the formal profile byte-identical', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-staging-real-'));
  const profile = join(home, 'profiles', 'web');
  await mkdir(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'profile-web',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.1' },
  }));
  await writeFile(join(profile, 'cordis.patch.yml'), '# keep me\n- id: user-entry\n  config:\n    x: 1\n');
  await writeFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.2.2-rc.1',
  }));
  await writeFile(join(profile, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), `
if (process.argv.includes('--version')) console.log('9.9.9');
else if (process.argv.includes('--dump-config')) console.log('- id: broken');
else process.exit(4);
`);
  const fetchImpl = async (url) => String(url).endsWith('.tgz')
    ? { ok: true, arrayBuffer: async () => TARBALL }
    : {
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '0.2.3' },
        versions: {
          '0.2.3': {
            version: '0.2.3',
            engines: { dsh: '>=0.2.0' },
            dist: { integrity: INTEGRITY, tarball: 'https://registry.example/dsh.tgz' },
          },
        },
      }),
    };
  const installer = async ({ cwd }) => {
    const dsh = join(cwd, 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(join(dsh, 'lib'), { recursive: true });
    await writeFile(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3' }));
    await writeFile(join(dsh, 'lib', 'bin.js'), "if (process.argv.includes('--version')) console.log('9.9.9'); else process.exit(4);");
  };
  const before = await treeHash(profile);
  const backend = new NpmBackend({ home, fetchImpl, installer, stagingReadyMs: 20 });
  const journal = new UpdateJournal({ home });
  const orchestrator = new UpdateOrchestrator({
    backend,
    gate: new PluginGate(),
    journal,
    watchdog: new Watchdog({ home }),
    home,
    stagingTimeoutMs: 2000,
  });
  await orchestrator.check();
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-502');
  assert.equal(await treeHash(profile), before);
  assert.equal((await journal.read()).state, 'failed');
  assert.equal(await backend.getCurrentVersion(), '0.2.2-rc.1');
  const staged = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(staged.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
});
