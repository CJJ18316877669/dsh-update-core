import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateOrchestrator } from '../src/orchestrator.mjs';
import { UpdateJournal } from '../src/journal.mjs';
import { Watchdog } from '../src/watchdog.mjs';
import { PluginGate } from '../src/plugin-gate.mjs';
import { NpmBackend } from '../src/backends/npm.mjs';

const TARBALL = Buffer.from('integration-tarball');
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;

async function profile() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-e2e-'));
  const dir = join(home, 'profiles', 'web');
  await mkdir(join(dir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'dsh-plugin-a'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'profile-web',
    dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.1', 'dsh-plugin-a': '^1.0.0' },
  }));
  await writeFile(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.2.2-rc.1',
  }));
  await writeFile(join(dir, 'node_modules', 'dsh-plugin-a', 'package.json'), JSON.stringify({
    name: 'dsh-plugin-a', version: '1.0.0', engines: { dsh: '>=0.2.0' },
  }));
  return { home, dir };
}

function fetchImpl(url) {
  const target = String(url);
  if (target.endsWith('.tgz')) return { ok: true, arrayBuffer: async () => TARBALL };
  if (target.includes('dsh-plugin-a')) {
    return {
      ok: true,
      json: async () => ({
        versions: {
          '1.0.0': { version: '1.0.0', engines: { dsh: '>=0.2.0' } },
          '1.1.0': { version: '1.1.0', engines: { dsh: '>=0.2.0' } },
        },
      }),
    };
  }
  return {
    ok: true,
    json: async () => ({
      'dist-tags': { latest: '0.2.3' },
      versions: {
        '0.2.3': {
          version: '0.2.3',
          dist: { integrity: INTEGRITY, tarball: 'https://registry.example/dsh.tgz' },
        },
      },
    }),
  };
}

async function installer({ cwd }) {
  const dshDir = join(cwd, 'node_modules', '@deepseek-ai', 'dsh');
  const pluginDir = join(cwd, 'node_modules', 'dsh-plugin-a');
  await mkdir(dshDir, { recursive: true });
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.3' }));
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-a', version: '1.1.0', engines: { dsh: '>=0.2.0' },
  }));
}

test('integration: npm backend + orchestrator update and manual rollback', async () => {
  const { home, dir } = await profile();
  const backend = new NpmBackend({ home, fetchImpl, installer });
  const journal = new UpdateJournal({ home });
  const watchdog = new Watchdog({ home });
  const orchestrator = new UpdateOrchestrator({
    backend,
    gate: new PluginGate(),
    journal,
    watchdog,
    home,
  });

  const checked = await orchestrator.check();
  assert.equal(checked.state, 'available');
  assert.equal(checked.targetVersion, '0.2.3');
  assert.equal(checked.plan.updates, 1);
  assert.equal(checked.plan.items.find((item) => item.name === 'dsh-plugin-a').to, '1.1.0');

  const done = await orchestrator.start({ confirm: true });
  assert.equal(done.state, 'succeeded');
  assert.equal(await backend.getCurrentVersion(), '0.2.3');
  assert.equal((await journal.read()).state, 'committed');
  const installed = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(installed.dependencies['@deepseek-ai/dsh'], '0.2.3');
  assert.equal(installed.dependencies['dsh-plugin-a'], '1.1.0');

  const rolled = await orchestrator.rollback();
  assert.equal(rolled.state, 'rolled-back');
  assert.equal(await backend.getCurrentVersion(), '0.2.2-rc.1');
  assert.equal((await journal.read()).state, 'rolled-back');
  const restored = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(restored.dependencies['@deepseek-ai/dsh'], '0.2.2-rc.1');
});
