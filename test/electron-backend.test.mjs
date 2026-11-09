import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElectronUpdaterBackend } from '../src/backends/electron-updater.mjs';
import { UpdateOrchestrator } from '../src/orchestrator.mjs';
import { UpdateJournal } from '../src/journal.mjs';
import { Watchdog } from '../src/watchdog.mjs';
import { PluginGate } from '../src/plugin-gate.mjs';

class FakeUpdater extends EventEmitter {
  constructor(version = '0.2.3') {
    super();
    this.version = version;
    this.downloaded = 0;
    this.installed = 0;
  }

  async checkForUpdates() {
    return { updateInfo: { version: this.version, releaseDate: '2026-11-07', files: [] } };
  }

  async downloadUpdate() {
    this.downloaded += 1;
    this.emit('download-progress', { total: 100, transferred: 40 });
    this.emit('download-progress', { total: 100, transferred: 100 });
  }

  quitAndInstall() {
    this.installed += 1;
  }
}

test('electron backend: check, download progress and install handoff', async () => {
  const updater = new FakeUpdater();
  const backend = new ElectronUpdaterBackend({ autoUpdater: updater, currentVersion: '0.2.2-rc.1' });
  const releases = await backend.check('stable');
  assert.equal(releases[0].version, '0.2.3');
  assert.equal(releases[0].channel, 'stable');

  const progress = [];
  const staged = await backend.prepare({ targetCore: '0.2.3' }, {
    onProgress: (p) => progress.push(p.percent),
  });
  assert.equal(staged.id, 'desktop-staged');
  assert.deepEqual(progress, [40, 100, 100]);
  assert.equal(updater.downloaded, 1);

  const handle = await backend.activate(staged);
  assert.equal(updater.installed, 1);
  assert.equal((await backend.health(handle)).ok, true);
  const rollback = await backend.rollback();
  assert.equal(rollback.ok, false);
  assert.equal(rollback.mode, 'safe-mode');
});

test('electron backend: delegated health never commits before the restarted host verifies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-electron-'));
  const updater = new FakeUpdater();
  let healthy = false;
  const coordinator = {
    health: async () => healthy
      ? { ok: true, checks: ['version', 'plugins'] }
      : { ok: true, delegated: true, checks: ['delegated-to-desktop'] },
    drain: async () => ({ ok: true, tasks: 0 }),
    quitAndInstall: async () => { updater.installed += 1; },
  };
  const backend = new ElectronUpdaterBackend({
    autoUpdater: updater,
    currentVersion: '0.2.2-rc.1',
    coordinator,
  });
  const journal = new UpdateJournal({ home });
  const orchestrator = new UpdateOrchestrator({
    backend,
    gate: new PluginGate(),
    journal,
    watchdog: new Watchdog({ home }),
    home,
  });
  const state = await orchestrator.start({ confirm: true });
  assert.equal(state.state, 'activating');
  assert.equal(state.result.delegated, true);
  assert.equal((await journal.read()).state, 'verifying');

  healthy = true;
  const restarted = new UpdateOrchestrator({
    backend,
    gate: new PluginGate(),
    journal,
    watchdog: new Watchdog({ home }),
    home,
  });
  const recovered = await restarted.recover({ currentVersion: '0.2.3' });
  assert.equal(recovered.action, 'committed');
  assert.equal((await journal.read()).state, 'committed');
  assert.equal(restarted.getState().state, 'succeeded');
});

test('electron backend: missing capabilities map to UPD-702', async () => {
  const backend = new ElectronUpdaterBackend({ autoUpdater: {}, currentVersion: '0.2.2' });
  await assert.rejects(() => backend.check('stable'), (error) => error.code === 'UPD-702');
  await assert.rejects(() => backend.prepare({}), (error) => error.code === 'UPD-702');
  await assert.rejects(() => backend.activate({}), (error) => error.code === 'UPD-702');
});

test('electron backend: requires autoUpdater and currentVersion', () => {
  assert.throws(() => new ElectronUpdaterBackend({}), /autoUpdater/);
  assert.throws(() => new ElectronUpdaterBackend({ autoUpdater: {} }), /currentVersion/);
});
