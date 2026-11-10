import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginPlan } from '../plugin/lib/plan.mjs';

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
  assert.deepEqual(plan.items.find((item) => item.name === 'dsh-a'), {
    name: 'dsh-a', action: 'update', from: '1.0.0', to: '1.1.0', reason: 'compatible-newer-version',
  });
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
