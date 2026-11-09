import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
}

test('CLI contract: seven scenarios preserve exit codes and terminal states', { timeout: 60000 }, async () => {
  const expected = {
    success: [0, '[succeeded]', 'journal:'],
    partial: [0, '[succeeded]', '2 个插件已禁用'],
    blocked: [2, '[blocked]', '核心插件不兼容'],
    rollback: [1, '[rolled-back]', 'UPD-502'],
    safe: [3, '[safe-mode]', 'UPD-601'],
    'download-fail': [1, '[failed]', 'UPD-401'],
    cancel: [0, '已取消', '未做任何更改'],
  };
  const homes = [];
  try {
    for (const [scenario, [code, ...needles]] of Object.entries(expected)) {
      const result = run(['demo', '--scenario', scenario, '--fast']);
      assert.equal(result.status, code, `${scenario}: ${result.stderr}`);
      for (const needle of needles) {
        assert.ok(result.stdout.includes(needle), `${scenario} missing ${needle}\n${result.stdout}`);
      }
      const home = /^home: (.+)$/m.exec(result.stdout)?.[1];
      if (home) homes.push(home);
      if (scenario === 'success') {
        const status = run(['status', '--home', home]);
        assert.equal(status.status, 0, status.stderr);
        const parsed = JSON.parse(status.stdout);
        assert.equal(parsed.journal.state, 'committed');
        assert.equal(parsed.watchdog.state, 'armed');
        assert.ok(parsed.watchdog.heartbeats >= 1);
      }
    }
  } finally {
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }).catch(() => {})));
  }
});

test('CLI contract: help and unknown commands use documented codes', () => {
  assert.equal(run(['help']).status, 0);
  assert.equal(run(['not-a-command']).status, 2);
  assert.equal(run(['demo', '--scenario', 'not-a-scenario']).status, 2);
});
