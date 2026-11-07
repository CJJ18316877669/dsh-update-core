import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compat, pickPluginVersion, PluginGate, JsonPluginStore, isCorePlugin,
} from '../src/plugin-gate.mjs';

test('compat: engines.dsh wins over peers', () => {
  assert.equal(compat({ engines: { dsh: '>=0.2.0' } }, '0.2.3').status, 'ok');
  assert.equal(compat({ engines: { dsh: '>=0.3.0' } }, '0.2.3').status, 'incompatible');
  assert.equal(compat({ engines: { dsh: 'workspace:^' } }, '0.2.3').status, 'invalid');
  assert.equal(compat({ engines: { dsh: '' } }, '0.2.3').status, 'invalid');
  assert.equal(compat({ engines: { dsh: '>=0.2.0' }, peerDependencies: { '@deepseek-ai/dsh': '>=9.0.0' } }, '0.2.3').status, 'ok');
});

test('compat: peer fallback, workspace peer, unknown and malformed', () => {
  assert.equal(compat({ peerDependencies: { '@deepseek-ai/dsh-tool': '>=0.2.0' } }, '0.2.3').status, 'ok');
  assert.equal(compat({ peerDependencies: { '@deepseek-ai/dsh-tool': '>=0.3.0' } }, '0.2.3').status, 'incompatible');
  assert.equal(compat({ peerDependencies: { '@deepseek-ai/dsh-tool': 'workspace:^' } }, '0.2.3').status, 'ok');
  assert.equal(compat({}, '0.2.3').status, 'unknown');
  assert.equal(compat({ engines: [] }, '0.2.3').status, 'invalid');
  assert.equal(compat({ engines: { dsh: 1 } }, '0.2.3').status, 'invalid');
  assert.equal(compat({ peerDependencies: { '@deepseek-ai/dsh': '' } }, '0.2.3').status, 'invalid');
  assert.equal(compat({ engines: { dsh: '>=0.2.0' } }, 'bad').status, 'invalid');
});

test('isCorePlugin: prefix must be dsh or dsh-*', () => {
  assert.equal(isCorePlugin({ name: '@deepseek-ai/dsh' }), true);
  assert.equal(isCorePlugin({ name: '@deepseek-ai/dsh-tool-terminal' }), true);
  assert.equal(isCorePlugin({ name: '@deepseek-ai/other-tool' }), false);
  assert.equal(isCorePlugin({ name: 'dsh-plugin-office' }), false);
  assert.equal(isCorePlugin({ name: 'x', protected: true }), true);
});

test('pickPluginVersion: stable first, skips deprecated, requires compatibility', () => {
  const versions = [
    { version: '1.1.0-rc.1', manifest: { engines: { dsh: '>=0.2.0' } } },
    { version: '1.0.0', manifest: { engines: { dsh: '>=0.2.0' } } },
    { version: '1.2.0', manifest: { engines: { dsh: '>=0.2.0' } }, deprecated: true },
    { version: '1.3.0', manifest: { engines: { dsh: '>=9.0.0' } } },
    { version: 'garbage', manifest: {} },
  ];
  assert.equal(pickPluginVersion(versions, '0.2.3').version, '1.0.0');
  assert.equal(pickPluginVersion([], '0.2.3'), null);
  assert.equal(pickPluginVersion(null, '0.2.3'), null);
});

test('plan: update / keep / disable / block / manual', () => {
  const gate = new PluginGate();
  const installed = [
    { name: 'plugin-update', version: '1.0.0', manifest: { engines: { dsh: '>=0.2.0' } } },
    { name: 'plugin-keep', version: '1.0.0', manifest: { engines: { dsh: '>=0.2.0' } } },
    { name: 'plugin-no-compat', version: '1.0.0', manifest: { engines: { dsh: '>=0.3.0' } } },
    { name: '@deepseek-ai/dsh-core-x', version: '0.2.0', protected: true, manifest: { engines: { dsh: '>=0.3.0' } } },
    { name: 'plugin-local', version: '1.0.0', spec: 'link', manifest: { engines: { dsh: '>=0.2.0' } } },
  ];
  const available = {
    'plugin-update': [{ version: '1.1.0', manifest: { engines: { dsh: '>=0.2.0' } } }],
    'plugin-keep': [{ version: '1.0.0', manifest: { engines: { dsh: '>=0.2.0' } } }],
    'plugin-no-compat': [{ version: '2.0.0', manifest: { engines: { dsh: '>=0.3.0' } } }],
    '@deepseek-ai/dsh-core-x': [],
    'plugin-local': [],
  };
  const plan = gate.plan('0.2.3', installed, available);
  assert.equal(plan.updates, 1);
  assert.equal(plan.keeps, 1);
  assert.equal(plan.disables, 1);
  assert.equal(plan.blocks, 1);
  assert.equal(plan.manuals, 1);
  assert.deepEqual(plan.disabled, ['plugin-no-compat']);
  const blocked = plan.items.find((item) => item.action === 'block');
  assert.equal(blocked.name, '@deepseek-ai/dsh-core-x');
});

test('plan: unknown contract is kept but flagged for staging verification', () => {
  const plan = new PluginGate().plan('0.2.3', [
    { name: 'plugin-unknown', version: '1.0.0', manifest: {} },
  ], {});
  assert.equal(plan.keeps, 1);
  assert.equal(plan.verified, 1);
  assert.equal(plan.items[0].verify, true);
});

test('verify: unknown plugin failure becomes disable, core failure becomes block', async () => {
  const gate = new PluginGate({
    verifier: async (item) => ({ ok: item.name !== 'bad-plugin' && item.name !== 'bad-core' }),
  });
  const plan = gate.plan('0.2.3', [
    { name: 'bad-plugin', version: '1.0.0', manifest: {} },
    { name: 'bad-core', version: '1.0.0', kind: 'core', manifest: {} },
    { name: 'good-plugin', version: '1.0.0', manifest: {} },
  ], {});
  const verified = await gate.verify(plan);
  assert.equal(verified.disables, 1);
  assert.equal(verified.blocks, 1);
  assert.equal(verified.keeps, 1);
  assert.equal(verified.items.find((i) => i.name === 'good-plugin').verify, false);
});

test('JsonPluginStore: disable, list and restore; core cannot be disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gate-'));
  const store = new JsonPluginStore({ file: join(dir, 'plugins.json') });
  const gate = new PluginGate({ store });
  const handle = await gate.disable({ name: 'plugin-a', version: '1.0.0' }, 'no-compatible-version');
  assert.equal(handle.name, 'plugin-a');
  assert.ok((await store.list())['plugin-a']);
  const raw = JSON.parse(await readFile(join(dir, 'plugins.json'), 'utf8'));
  assert.equal(raw.disabled['plugin-a'].reason, 'no-compatible-version');
  await gate.restore(handle);
  assert.equal((await store.list())['plugin-a'], undefined);
  await assert.rejects(() => gate.disable({ name: '@deepseek-ai/dsh-tool', version: '1.0.0' }, 'x'), /core/);
});

test('JsonPluginStore: corrupt file is quarantined instead of silently reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gate-'));
  const file = join(dir, 'plugins.json');
  await writeFile(file, '{broken', 'utf8');
  const store = new JsonPluginStore({ file });
  assert.deepEqual(await store.list(), {});
  const entries = await readdir(dir);
  assert.ok(entries.some((name) => name.includes('.corrupt-')));
});


test('plan: updating to a version without a version contract is flagged for staging', () => {
  const gate = new PluginGate();
  const unknownTarget = gate.plan('0.2.3', [
    { name: 'plugin-unknown', version: '1.0.0', manifest: {} },
  ], {
    'plugin-unknown': [
      { version: '1.0.0', manifest: {} },
      { version: '1.1.0', manifest: {} },
    ],
  });
  assert.equal(unknownTarget.updates, 1);
  assert.equal(unknownTarget.items[0].verify, true);

  const knownTarget = gate.plan('0.2.3', [
    { name: 'plugin-known', version: '1.0.0', manifest: { engines: { dsh: '>=0.2.0' } } },
  ], {
    'plugin-known': [
      { version: '1.1.0', manifest: { engines: { dsh: '>=0.2.0' } } },
    ],
  });
  assert.equal(knownTarget.items[0].verify, false);
});
