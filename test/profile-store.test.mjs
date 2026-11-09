import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProfileStore } from '../src/profile-store.mjs';

const fixture = fileURLToPath(new URL('./fixtures/profile-min/cordis.patch.yml', import.meta.url));

async function profile(text) {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-profile-store-'));
  const patch = join(profileDir, 'cordis.patch.yml');
  await writeFile(patch, text ?? await readFile(fixture, 'utf8'), 'utf8');
  return { profileDir, patch, restore: join(profileDir, 'restore.json'), store: new ProfileStore({ profileDir }) };
}

test('profile-store: fixture disable/list/enable restores every byte and keeps node_modules', async () => {
  const { profileDir, patch, restore, store } = await profile();
  const modules = join(profileDir, 'node_modules', 'plugin-alpha');
  await mkdir(modules, { recursive: true });
  await writeFile(join(modules, 'keep.txt'), '不要删除', 'utf8');
  const original = await readFile(patch, 'utf8');

  const handle = await store.disable({ name: 'plugin-alpha', version: '1.2.3' }, 'incompatible');
  assert.equal(handle.name, 'plugin-alpha');
  assert.equal(handle.version, '1.2.3');
  assert.equal(handle.reason, 'incompatible');
  const disabledText = await readFile(patch, 'utf8');
  assert.ok(disabledText.includes('- id: plugin-alpha\n  disabled: true\n  config:'));
  assert.ok(disabledText.includes('# 用户插件配置：请保留中文注释'));
  assert.deepEqual((await store.list())['plugin-alpha'], {
    version: '1.2.3', reason: 'incompatible', disabledAt: handle.disabledAt,
  });
  const backup = JSON.parse(await readFile(restore, 'utf8'));
  assert.equal(backup.disabled['plugin-alpha'].originalText, original);
  assert.equal(backup.disabled['plugin-alpha'].originalEntry, '- id: plugin-alpha\n  config:\n    greeting: "你好"\n\n# 下面使用四空格缩进\n');
  assert.equal(await readFile(join(modules, 'keep.txt'), 'utf8'), '不要删除');

  assert.deepEqual(await store.enable(handle), { name: 'plugin-alpha' });
  assert.equal(await readFile(patch, 'utf8'), original);
  assert.deepEqual(await store.list(), {});
  assert.deepEqual(JSON.parse(await readFile(restore, 'utf8')).disabled, {});
  assert.equal((await readdir(profileDir)).some((name) => name.endsWith('.tmp')), false);
});

test('profile-store: repeated disable is byte-idempotent, including restore metadata', async () => {
  const { patch, restore, store } = await profile();
  const first = await store.disable({ name: 'plugin-alpha', version: '1.0.0' }, 'first');
  const firstPatch = await readFile(patch);
  const firstRestore = await readFile(restore);
  const second = await store.disable({ name: 'plugin-alpha', version: '9.0.0' }, 'second');
  assert.deepEqual(second, first);
  assert.deepEqual(await readFile(patch), firstPatch);
  assert.deepEqual(await readFile(restore), firstRestore);
});

test('profile-store: CRLF, no final newline, Chinese and JSON quoting survive append/remove', async () => {
  const original = '# 中文注释\r\n- id: "other"\r\n    config:\r\n      label: 混合缩进';
  const { patch, store } = await profile(original);
  const name = 'plugin-"\\雪';
  await store.disable({ name }, 'dirty-input');
  const expected = `${original}\r\n- id: ${JSON.stringify(name)}\r\n  disabled: true`;
  assert.equal(await readFile(patch, 'utf8'), expected);
  assert.ok((await store.list())[name]);
  assert.equal(Buffer.from(await readFile(patch)).subarray(0, 3).toString('hex') === 'efbbbf', false);
  await store.enable(name);
  assert.equal(await readFile(patch, 'utf8'), original);
});

test('profile-store: existing false value keeps indentation and inline comments', async () => {
  const original = '- id: plugin-alpha\r\n    disabled: false # 用户注释\r\n    config:\r\n      x: 1';
  const { patch, store } = await profile(original);
  await store.disable({ name: 'plugin-alpha' }, 'false-value');
  assert.equal(await readFile(patch, 'utf8'), original.replace('disabled: false', 'disabled: true'));
  await store.enable('plugin-alpha');
  assert.equal(await readFile(patch, 'utf8'), original);
});

test('profile-store: flow mappings are edited in place and restored exactly', async () => {
  const { patch, store } = await profile();
  const original = await readFile(patch, 'utf8');
  await store.disable({ name: 'plugin-flow' }, 'flow');
  assert.equal(await readFile(patch, 'utf8'), original.replace(
    '- { id: plugin-flow, config: { mode: safe } }',
    '- { id: plugin-flow, config: { mode: safe }, disabled: true }',
  ));
  await store.enable('plugin-flow');
  assert.equal(await readFile(patch, 'utf8'), original);
});

test('profile-store: name is a fallback locator and per-entry indentation is retained', async () => {
  const original = '- name: plugin-by-name\n    config:\n      x: 1\n- id: untouched\n  config:\n    y: 2\n';
  const { patch, store } = await profile(original);
  await store.disable({ name: 'plugin-by-name' }, 'name-fallback');
  assert.equal(await readFile(patch, 'utf8'), original.replace(
    '- name: plugin-by-name\n',
    '- name: plugin-by-name\n    disabled: true\n',
  ));
  await store.enable('plugin-by-name');
  assert.equal(await readFile(patch, 'utf8'), original);
});

test('profile-store: core rejection performs zero writes', async () => {
  const { patch, restore, store } = await profile();
  const original = await readFile(patch);
  await assert.rejects(
    () => store.disable({ name: '@deepseek-ai/dsh-tool-terminal', protected: true }, 'core'),
    /core/,
  );
  assert.deepEqual(await readFile(patch), original);
  await assert.rejects(() => readFile(restore), (error) => error.code === 'ENOENT');
});

test('profile-store: target edits conflict without overwriting either patch or backup', async () => {
  const { patch, restore, store } = await profile();
  await store.disable({ name: 'plugin-alpha' }, 'conflict');
  const changed = (await readFile(patch, 'utf8')).replace('greeting: "你好"', 'greeting: "外部修改"');
  await writeFile(patch, changed, 'utf8');
  const backup = await readFile(restore);
  await assert.rejects(() => store.enable('plugin-alpha'), (error) => error.code === 'PROFILE_CONFLICT');
  assert.equal(await readFile(patch, 'utf8'), changed);
  assert.deepEqual(await readFile(restore), backup);
});

test('profile-store: appended target edits also conflict', async () => {
  const { patch, store } = await profile('- id: existing\n');
  await store.disable({ name: 'new-plugin' }, 'conflict');
  const changed = `${await readFile(patch, 'utf8')}# 外部附加注释\n`;
  await writeFile(patch, changed, 'utf8');
  await assert.rejects(() => store.enable('new-plugin'), /conflict/);
  assert.equal(await readFile(patch, 'utf8'), changed);
});

test('profile-store: unrelated external edits survive a managed restore', async () => {
  const { patch, store } = await profile();
  await store.disable({ name: 'plugin-alpha' }, 'external-elsewhere');
  const changed = (await readFile(patch, 'utf8')).replace('enabled: true', 'enabled: false');
  await writeFile(patch, changed, 'utf8');
  await store.enable('plugin-alpha');
  const restored = await readFile(patch, 'utf8');
  assert.ok(restored.includes('enabled: false'));
  assert.ok(!restored.includes('disabled: true\n  config:\n    greeting'));
});

test('profile-store: a crash after patch restore but before record cleanup is recoverable', async () => {
  const { patch, restore, store } = await profile();
  await store.disable({ name: 'plugin-alpha' }, 'crash-window');
  const backup = JSON.parse(await readFile(restore, 'utf8'));
  await writeFile(patch, backup.disabled['plugin-alpha'].originalText, 'utf8');
  assert.deepEqual(await store.enable('plugin-alpha'), { name: 'plugin-alpha' });
  assert.deepEqual(JSON.parse(await readFile(restore, 'utf8')).disabled, {});
  assert.deepEqual(await store.list(), {});
});

test('profile-store: list uses patch as truth, never restore backup', async () => {
  const { patch, restore, store } = await profile();
  await store.disable({ name: 'plugin-alpha' }, 'truth');
  await writeFile(restore, '{broken', 'utf8');
  assert.ok((await store.list())['plugin-alpha']);
  const enabled = (await readFile(patch, 'utf8')).replace('  disabled: true\n', '');
  await writeFile(patch, enabled, 'utf8');
  assert.deepEqual(await store.list(), {});
});

test('profile-store: unsafe YAML and orphan disabled entries fail without patch changes', async () => {
  const unsupported = '- id: plugin-alpha\n  disabled: maybe\n';
  const first = await profile(unsupported);
  await assert.rejects(() => first.store.disable({ name: 'plugin-alpha' }, 'bad'), /unsupported/);
  assert.equal(await readFile(first.patch, 'utf8'), unsupported);

  const orphan = '- id: user-disabled\n  disabled: true\n';
  const second = await profile(orphan);
  await assert.rejects(() => second.store.enable('user-disabled'), /no restore data/);
  assert.equal(await readFile(second.patch, 'utf8'), orphan);
});

test('profile-store: a missing patch can be appended and restored to empty', async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-profile-store-'));
  const store = new ProfileStore({ profileDir });
  const patch = join(profileDir, 'cordis.patch.yml');
  await store.disable({ name: 'new-plugin' }, 'empty');
  assert.equal(await readFile(patch, 'utf8'), '- id: "new-plugin"\n  disabled: true\n');
  await store.enable('new-plugin');
  assert.equal(await readFile(patch, 'utf8'), '');
  await store.enable('new-plugin');
  assert.equal(await readFile(patch, 'utf8'), '');
});
