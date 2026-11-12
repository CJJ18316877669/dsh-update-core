import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  channelForVersion,
  checkDesktop,
  compat,
  createPluginPlan,
  desktopInstallerUrl,
  feedForChannel,
  normalizeDesktopVersion,
  parseDesktopFeed,
  readDesktopVersion,
  resolvePluginVersions,
} from '../plugin/lib/plan.mjs';
import { listHistory, readIgnored, setIgnored } from '../plugin/lib/store.mjs';

const plugin = (version, range) => ({ version, manifest: { engines: { dsh: range } } });

test('plugin plan: a newer version without a compatibility contract is kept for staging', () => {
  const plan = createPluginPlan(
    { 'dsh-a': '2.3.6' },
    new Map([['dsh-a', { version: '2.3.6' }]]),
    new Map([['dsh-a', [{ version: '2.3.9', manifest: {} }]]]),
    '0.2.2-rc.2',
    new Set(['dsh-a']),
  );
  assert.equal(plan.updates, 0);
  assert.equal(plan.items[0].action, 'keep');
  assert.equal(plan.items[0].reason, 'unverified-compatibility');
  assert.equal(plan.items[0].candidateVersion, '2.3.9');
  assert.equal(plan.unverifiedTargets.length, 1);
});

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

test('plugin plan: an unknown-contract candidate at the installed version is not a warning', () => {
  const plan = createPluginPlan(
    { 'dsh-a': '1.0.0' },
    new Map([['dsh-a', { version: '1.0.0' }]]),
    new Map([['dsh-a', [{ version: '1.0.0', manifest: {} }]]]),
    '0.2.2-rc.2',
    new Set(['dsh-a']),
  );
  assert.equal(plan.items[0].reason, 'already-current');
  assert.equal(plan.unverifiedTargets.length, 0);
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

test('plugin plan: workspace peers retain source compatibility semantics', () => {
  const state = compat({
    peerDependencies: { '@deepseek-ai/dsh': 'workspace:^' },
  }, '0.2.2-rc.1');
  assert.equal(state.status, 'ok');
  assert.equal(state.range, 'workspace:^');
});

test('desktop feed: accepts the folded URL and sha512 blocks used by the official feed', () => {
  const feed = parseDesktopFeed([
    'version: 0.2.2-rc.2',
    'files:',
    '  - url: >-',
    '      https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.2-win-x64.exe',
    '    sha512: >-',
    '      ZmlsZS1oYXNoLXZhbHVl',
    '    size: 299659528',
    'path: >-',
    '  https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.2-win-x64.exe',
    'sha512: >-',
    '  ZmlsZS1oYXNoLXZhbHVl',
  ].join('\n'), 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml');
  assert.equal(feed.installerUrl, 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.2-win-x64.exe');
  assert.equal(feed.sha512, 'ZmlsZS1oYXNoLXZhbHVl');
});

test('desktop installer URL follows the official versioned path', () => {
  assert.equal(
    desktopInstallerUrl('0.2.2-rc.1'),
    'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.1-win-x64.exe',
  );
  assert.equal(desktopInstallerUrl('not-a-version'), null);
});

test('desktop channel: prerelease is nightly, stable never falls back to nightly', async () => {
  assert.equal(channelForVersion('0.2.2-rc.1'), 'nightly');
  assert.equal(channelForVersion('0.2.2'), 'stable');
  assert.equal(feedForChannel('stable'), null);
  const stable = await checkDesktop({ currentVersion: '0.2.2', targetCore: '0.2.2' });
  assert.equal(stable.channel, 'stable');
  assert.equal(stable.update, false);
  assert.equal(stable.feedUnavailable, true);
  await assert.rejects(
    checkDesktop({ currentVersion: '0.2.2-rc.1', channel: 'stable' }),
    /拒绝跨渠道更新/,
  );
});

test('plugin plan: source check failures keep a compatible installed version and remain visible', () => {
  const plan = createPluginPlan(
    { 'dsh-a': '1.0.0' },
    new Map([['dsh-a', { version: '1.0.0', engines: { dsh: '>=0.2.0' } }]]),
    new Map(),
    '0.2.2-rc.1',
    new Set(['dsh-a']),
    { sourceErrors: new Map([['dsh-a', 'offline']]) },
  );
  assert.equal(plan.items[0].action, 'keep');
  assert.equal(plan.items[0].reason, 'source-check-failed');
  assert.equal(plan.items[0].sourceError, 'offline');
  assert.equal(plan.sourceWarnings.length, 1);
  assert.equal(plan.blockers.length, 0);
});

test('plugin plan: an incompatible installed plugin blocks unsafe core updates', () => {
  const plan = createPluginPlan(
    { 'dsh-a': '1.0.0' },
    new Map([['dsh-a', { version: '1.0.0', engines: { dsh: '<0.2.0' } }]]),
    new Map([['dsh-a', []]]),
    '0.3.0',
  );
  assert.equal(plan.blockers.length, 1);
  assert.equal(plan.blockers[0].name, 'dsh-a');
  assert.equal(plan.blockers[0].status, 'incompatible');
  assert.equal(plan.items[0].installedCompatibility, 'incompatible');
});

test('plugin plan: registry failure is surfaced per plugin instead of becoming a silent empty catalog', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const errors = new Map();
    const available = await resolvePluginVersions(['dsh-a'], 'https://registry.npmjs.org', errors);
    assert.deepEqual(available.get('dsh-a'), []);
    assert.match(errors.get('dsh-a'), /offline/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('plugin plan: insecure or credential-bearing registries are rejected', async () => {
  await assert.rejects(
    resolvePluginVersions(['dsh-a'], 'http://registry.example.com'),
    /registry 必须使用 HTTPS/,
  );
  await assert.rejects(
    resolvePluginVersions(['dsh-a'], 'https://user:secret@registry.example.com'),
    /不能包含凭据/,
  );
});

test('desktop feed: resolves relative installer URL and requires sha512', () => {
  const feed = parseDesktopFeed([
    'version: 0.2.2-rc.1',
    'files:',
    '  - url: deepseek-harness-0.2.2-rc.1-win-x64.exe.blockmap',
    '    sha512: blockmap-hash',
    '  - url: deepseek-harness-0.2.2-rc.1-win-x64.exe',
    '    sha512: installer-hash',
  ].join('\n'), 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml');
  assert.equal(feed.version, '0.2.2-rc.1');
  assert.equal(feed.installerUrl, 'https://download.deepseek.com/dsh-desk/feeds/win-x64/deepseek-harness-0.2.2-rc.1-win-x64.exe');
  assert.equal(feed.sha512, 'installer-hash');
  assert.throws(
    () => parseDesktopFeed('version: 0.2.2\nfiles:\n  - url: app.exe\n', 'https://download.deepseek.com/nightly.yml'),
    /no sha512/,
  );
});

test('desktop version: four-part ProductVersion normalises without hiding a prerelease', () => {
  assert.equal(normalizeDesktopVersion('0.2.2.0'), '0.2.2');
  assert.equal(normalizeDesktopVersion('0.2.2-rc.1'), '0.2.2-rc.1');
  assert.equal(normalizeDesktopVersion('v0.2.2'), '0.2.2');
});

test('desktop version: reader works for an executable without matching uninstall metadata', { skip: process.platform !== 'win32' }, async () => {
  const version = await readDesktopVersion(process.execPath);
  assert.match(version, /^\d+\.\d+\.\d+/);
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
