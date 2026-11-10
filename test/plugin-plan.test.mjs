import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginPlan, desktopInstallerUrl } from '../plugin/lib/plan.mjs';
import { listHistory, readIgnored, setIgnored } from '../plugin/lib/store.mjs';

const plugin = (version, range) => ({ version, manifest: { engines: { dsh: range } } });

test('plugin plan: updates only plugins to the highest version compatible with the target core', () => {
  const plan = createPluginPlan(
    { 'dsh-a': '1.0.0', 'dsh-b': '1.0.0' },
    new Map([['dsh-a', { version: '1.0.0' }], ['dsh-b', { version: '1.0.0' }]]),
    new Map([
      ['dsh-a', [plugin('1.0.0', '>=0.2.0'), plugin('1.1.0', '>=0.2.0'), plugin('2.0.0', '>=0.3.0')]],
      ['dsh-b', [plugin('1.0.0', '>=0.2.0')]],
    ]),
    '0.2.2-rc.1',
  );
  assert.equal(plan.updates, 1);
  const updated = plan.items.find((item) => item.name === 'dsh-a');
  assert.equal(updated.action, 'update');
  assert.equal(updated.from, '1.0.0');
  assert.equal(updated.to, '1.1.0');
  assert.equal(updated.source, 'registry');
  assert.equal(plan.items.find((item) => item.name === 'dsh-b').action, 'keep');
});

test('plugin plan: keeps the installed plugin when only an incompatible newer version exists', () => {
  const plan = createPluginPlan(
    { 'dsh-a': '1.0.0' },
    new Map([['dsh-a', { version: '1.0.0' }]]),
    new Map([['dsh-a', [plugin('1.0.0', '>=0.2.0'), plugin('2.0.0', '>=0.3.0')]]]),
    '0.2.2-rc.1',
  );
  assert.equal(plan.updates, 0);
  assert.equal(plan.disables, 0);
  assert.equal(plan.items[0].action, 'keep');
  assert.equal(plan.items[0].to, null);
});

test('plugin plan: leaves framework and non-registry dependencies untouched', () => {
  const plan = createPluginPlan(
    { '@deepseek-ai/cordis': '4.0.5', 'dsh-git': 'git+https://example.test/repo.git', 'dsh-a': '1.0.0' },
    new Map([['@deepseek-ai/cordis', { version: '4.0.5' }], ['dsh-git', { version: '1.0.0' }], ['dsh-a', { version: '1.0.0' }]]),
    new Map([['dsh-a', [plugin('1.1.0', '>=0.2.0')]]]),
    '0.2.2-rc.1',
    new Set(['dsh-a']),
  );
  assert.equal(plan.items.find((item) => item.name === '@deepseek-ai/cordis').reason, 'non-plugin-dependency');
  assert.equal(plan.items.find((item) => item.name === 'dsh-git').reason, 'non-registry-source');
  assert.equal(plan.items.find((item) => item.name === 'dsh-a').action, 'update');
});

test('plugin plan: keeps the installed version when the best version is ignored', () => {
  const available = new Map([['dsh-a', [plugin('1.1.0', '>=0.2.0'), plugin('1.2.0', '>=0.2.0')]]]);
  const ignored = new Map([['dsh-a', '1.2.0']]);
  const plan = createPluginPlan(
    { 'dsh-a': '1.0.0' },
    new Map([['dsh-a', { version: '1.0.0' }]]),
    available,
    '0.2.2-rc.1',
    new Set(['dsh-a']),
    { ignored },
  );
  assert.equal(plan.updates, 0);
  assert.equal(plan.items[0].reason, 'ignored-version');
});

test('plugin plan: refuses a same-name package from a different repository', () => {
  const candidate = plugin('1.1.0', '>=0.2.0');
  candidate.repository = 'https://github.com/evil/fake-plugin.git';
  const plan = createPluginPlan(
    { 'dsh-a': '1.0.0' },
    new Map([['dsh-a', { version: '1.0.0', repository: 'https://github.com/good/real-plugin' }]]),
    new Map([['dsh-a', [candidate]]]),
    '0.2.2-rc.1',
    new Set(['dsh-a']),
  );
  assert.equal(plan.updates, 0);
  assert.equal(plan.items[0].reason, 'repository-mismatch');
});

test('plugin plan: updates a GitHub source to a compatible release tag', () => {
  const plan = createPluginPlan(
    { 'dsh-g': 'git+https://github.com/owner/plugin.git' },
    new Map([['dsh-g', { version: '1.0.0', repository: 'https://github.com/owner/plugin' }]]),
    new Map(),
    '0.2.2-rc.1',
    new Set(['dsh-g']),
    {
      github: new Map([['dsh-g', {
        versions: [{ version: '1.1.0', ref: 'v1.1.0', manifest: { engines: { dsh: '>=0.2.0' } } }],
      }]]),
    },
  );
  assert.equal(plan.updates, 1);
  assert.equal(plan.items[0].to, 'git+https://github.com/owner/plugin.git#v1.1.0');
  assert.equal(plan.items[0].version, '1.1.0');
  assert.equal(plan.items[0].source, 'github');
});

test('desktop installer URL follows the official versioned path', () => {
  assert.equal(
    desktopInstallerUrl('0.2.2-rc.1'),
    'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.1-win-x64.exe',
  );
  assert.equal(desktopInstallerUrl('not-a-version'), null);
});

test('ignore store persists and clears exact versions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ignore-'));
  const paths = { home };
  try {
    await setIgnored(paths, 'dsh-a', '1.2.3');
    assert.equal((await readIgnored(paths)).get('dsh-a'), '1.2.3');
    await setIgnored(paths, 'dsh-a', null);
    assert.equal((await readIgnored(paths)).has('dsh-a'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('history reads persisted run results newest first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-history-'));
  const paths = { home };
  try {
    for (const run of ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z']) {
      await mkdir(join(home, 'updates', 'dsh-update-plugin', run), { recursive: true });
      await writeFile(join(home, 'updates', 'dsh-update-plugin', run, 'result.json'), JSON.stringify({
        state: 'succeeded', message: run, updated: [], kept: [], startedAt: run,
      }));
    }
    const history = await listHistory(paths);
    assert.equal(history.length, 2);
    assert.equal(history[0].run, '2026-01-02T00-00-00-000Z');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
