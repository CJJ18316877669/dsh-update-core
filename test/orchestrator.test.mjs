import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateOrchestrator } from '../src/orchestrator.mjs';
import { UpdateJournal } from '../src/journal.mjs';
import { Watchdog } from '../src/watchdog.mjs';
import { PluginGate } from '../src/plugin-gate.mjs';
import { Telemetry, MemorySink } from '../src/telemetry.mjs';
import { FakeBackend } from '../src/backends/fake.mjs';

async function setup(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-orch-'));
  const backend = new FakeBackend(options.backend || {});
  const journal = new UpdateJournal({ home });
  const watchdog = new Watchdog({ home });
  const gate = new PluginGate();
  const telemetry = new Telemetry({
    sink: new MemorySink(),
    sampleRates: { 'update.stage': 1 },
    home,
  });
  const orchestrator = new UpdateOrchestrator({
    backend,
    gate,
    journal,
    watchdog,
    telemetry,
    home,
    channel: 'stable',
  });
  return { home, backend, journal, watchdog, orchestrator, telemetry };
}

function waitForState(orchestrator, name, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for state ${name}; current=${orchestrator.getState().state}`));
    }, timeoutMs);
    const unsubscribe = orchestrator.subscribe((state) => {
      if (state.state === name) {
        clearTimeout(timer);
        unsubscribe();
        resolve(state);
      }
    });
    if (orchestrator.getState().state === name) {
      clearTimeout(timer);
      unsubscribe();
      resolve(orchestrator.getState());
    }
  });
}

test('orchestrator: check finds a newer compatible release', async () => {
  const { orchestrator, backend } = await setup();
  const state = await orchestrator.check({ manual: true });
  assert.equal(state.state, 'available');
  assert.equal(state.targetVersion, '0.2.3');
  assert.equal(state.plan.updates, 2);
  assert.equal(state.plan.keeps, 2);
  assert.ok(backend.calls.includes('check:stable'));
});

test('orchestrator: full success commits journal and updates version', async () => {
  const { orchestrator, backend, journal, watchdog } = await setup();
  const states = [];
  orchestrator.subscribe((state) => states.push(state.state));
  await orchestrator.check();
  const result = await orchestrator.start({ confirm: true });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.currentVersion, '0.2.3');
  assert.equal(result.result.updates, 2);
  const j = await journal.read();
  assert.equal(j.state, 'committed');
  assert.equal(j.from, '0.2.2-rc.1');
  assert.equal(j.to, '0.2.3');
  assert.ok(backend.calls.indexOf('snapshot') < backend.calls.indexOf('prepare'));
  assert.ok(backend.calls.indexOf('prepare') < backend.calls.indexOf('drain'));
  assert.ok(backend.calls.indexOf('drain') < backend.calls.indexOf('activate'));
  assert.ok(backend.calls.includes('commit'));
  const wd = await watchdog.read();
  assert.equal(wd.state, 'armed');
  assert.equal(wd.heartbeats, 1);
  for (const state of ['preparing', 'downloading', 'verifying', 'staged', 'draining', 'activating', 'succeeded']) {
    assert.ok(states.includes(state), `missing state ${state}`);
  }
});

test('orchestrator: incompatible plugins require confirmation and report partial success', async () => {
  const backendOptions = {
    plugins: [
      { name: 'dsh-plugin-office', version: '1.4.2', manifest: { engines: { dsh: '>=0.2.0' } } },
      { name: 'dsh-plugin-foo', version: '1.2.0', manifest: { engines: { dsh: '>=0.3.0' } } },
      { name: 'dsh-plugin-bar', version: '0.4.1', manifest: { engines: { dsh: '>=0.3.0' } } },
    ],
    available: {
      'dsh-plugin-office': [{ version: '1.4.2', manifest: { engines: { dsh: '>=0.2.0' } } }],
      'dsh-plugin-foo': [],
      'dsh-plugin-bar': [],
    },
  };
  const { orchestrator, journal } = await setup({ backend: backendOptions });
  const checked = await orchestrator.check();
  assert.equal(checked.state, 'available-incompatible');
  assert.equal(checked.plan.disables, 2);

  await assert.rejects(
    () => orchestrator.start(),
    (error) => error.code === 'UPD-201' && error.details.confirmRequired === true,
  );
  const result = await orchestrator.start({ confirm: true });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.result.disables, 2);
  const j = await journal.read();
  assert.equal(j.state, 'committed');
  assert.equal(j.plan.disables, 2);
});

test('orchestrator: core incompatibility blocks before any journal write', async () => {
  const { orchestrator, journal } = await setup({
    backend: {
      plugins: [
        { name: '@deepseek-ai/dsh-tool-terminal', version: '0.2.2', kind: 'core', protected: true, manifest: { engines: { dsh: '>=0.3.0' } } },
      ],
      available: { '@deepseek-ai/dsh-tool-terminal': [] },
    },
  });
  const checked = await orchestrator.check();
  assert.equal(checked.state, 'blocked');
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-202');
  assert.equal(await journal.read(), null);
});

test('orchestrator: download failure leaves version untouched and journal failed', async () => {
  const { orchestrator, journal, backend } = await setup({ backend: { failAt: ['download'] } });
  await orchestrator.check();
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-401');
  const state = orchestrator.getState();
  assert.equal(state.state, 'failed');
  assert.equal(state.currentVersion, '0.2.2-rc.1');
  const j = await journal.read();
  assert.equal(j.state, 'failed');
  assert.ok(!backend.calls.includes('activation:rollback'));
});

test('orchestrator: health failure rolls back to previous version', async () => {
  const { orchestrator, journal, backend, watchdog } = await setup({ backend: { failAt: ['health'] } });
  await orchestrator.check();
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-502');
  const state = orchestrator.getState();
  assert.equal(state.state, 'rolled-back');
  assert.equal(state.currentVersion, '0.2.2-rc.1');
  assert.ok(backend.calls.includes('activation:rollback'));
  const j = await journal.read();
  assert.equal(j.state, 'rolled-back');
  assert.equal((await watchdog.read()).state, 'disarmed');
});

test('orchestrator: rollback failure enters safe mode', async () => {
  const { orchestrator, journal } = await setup({ backend: { failAt: ['health', 'rollback', 'snapshot'] } });
  await orchestrator.check();
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-502');
  const state = orchestrator.getState();
  assert.equal(state.state, 'safe-mode');
  assert.equal(state.error.code, 'UPD-601');
  const j = await journal.read();
  assert.equal(j.state, 'failed');
  assert.equal(j.safeMode, true);
});

test('orchestrator: cancel during download discards journal with zero changes', async () => {
  const { orchestrator, journal } = await setup({ backend: { delayMs: 5 } });
  await orchestrator.check();
  const pending = orchestrator.start({ confirm: true });
  await waitForState(orchestrator, 'downloading');
  const cancelled = await orchestrator.cancel();
  assert.equal(cancelled, true);
  await pending;
  const state = orchestrator.getState();
  assert.equal(state.state, 'available');
  assert.equal(state.result.cancelled, true);
  assert.equal(state.currentVersion, '0.2.2-rc.1');
  assert.equal(await journal.read(), null);
});

test('orchestrator: single flight rejects a concurrent start', async () => {
  const { orchestrator } = await setup({ backend: { delayMs: 3 } });
  await orchestrator.check();
  const pending = orchestrator.start({ confirm: true });
  await waitForState(orchestrator, 'preparing');
  await assert.rejects(
    () => orchestrator.start({ confirm: true }),
    (error) => error.code === 'UPD-303',
  );
  await pending;
});

test('orchestrator: manual rollback after commit', async () => {
  const { orchestrator, journal, backend } = await setup();
  await orchestrator.check();
  await orchestrator.start({ confirm: true });
  assert.equal((await journal.read()).state, 'committed');
  const state = await orchestrator.rollback();
  assert.equal(state.state, 'rolled-back');
  assert.equal(state.currentVersion, '0.2.2-rc.1');
  assert.equal((await journal.read()).state, 'rolled-back');
  assert.ok(backend.calls.includes('rollback'));
});

test('orchestrator: up-to-date and check failure', async () => {
  const up = await setup({ backend: { currentVersion: '0.2.3' } });
  const state = await up.orchestrator.check();
  assert.equal(state.state, 'up-to-date');
  assert.equal(state.result.upToDate, true);
  const noop = await up.orchestrator.start({ confirm: true });
  assert.equal(noop.state, 'up-to-date');

  const failing = await setup({ backend: { failAt: ['check'] } });
  await assert.rejects(() => failing.orchestrator.check(), (error) => error.code === 'UPD-101');
  assert.equal(failing.orchestrator.getState().state, 'failed');
});

test('orchestrator: recovery rolls back an interrupted applying journal', async () => {
  const { orchestrator, journal, backend } = await setup();
  await journal.begin({ from: '0.2.2-rc.1', to: '0.2.3', channel: 'stable', backend: 'profile' });
  await journal.transition('applying');
  const result = await orchestrator.recover({ currentVersion: '0.2.2-rc.1' });
  assert.equal(result.action, 'rolled-back');
  assert.equal(orchestrator.getState().state, 'rolled-back');
  assert.ok(backend.calls.includes('rollback'));
  assert.equal((await journal.read()).state, 'rolled-back');
});


test('orchestrator: repeated start after success is idempotent', async () => {
  const { orchestrator, backend } = await setup();
  await orchestrator.check();
  await orchestrator.start({ confirm: true });
  const again = await orchestrator.start({ confirm: true });
  assert.equal(again.state, 'succeeded');
  assert.equal(backend.calls.filter((call) => call === 'prepare').length, 1);
});

test('orchestrator: switching channel clears the cached plan', async () => {
  const { orchestrator } = await setup();
  await orchestrator.check();
  assert.equal(orchestrator.getState().state, 'available');
  const idle = orchestrator.setChannel('nightly');
  assert.equal(idle.state, 'idle');
  assert.equal(idle.plan, null);
  const checked = await orchestrator.check();
  assert.equal(checked.targetVersion, '0.2.3-nightly.20261107');
  assert.throws(() => orchestrator.setChannel('beta'), /unsupported channel/);
});

test('orchestrator: drain failure fails before activation', async () => {
  const { orchestrator, backend, journal } = await setup({ backend: { failAt: ['drain'] } });
  await orchestrator.check();
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-501');
  assert.equal(orchestrator.getState().state, 'failed');
  assert.ok(!backend.calls.includes('activate'));
  assert.equal((await journal.read()).state, 'failed');
});


test('orchestrator: a failed re-check clears the stale plan', async () => {
  const { orchestrator, backend } = await setup();
  await orchestrator.check();
  assert.equal(orchestrator.getState().state, 'available');
  backend.failAt = new Set(['check']);
  await assert.rejects(() => orchestrator.check(), (error) => error.code === 'UPD-101');
  const state = orchestrator.getState();
  assert.equal(state.state, 'failed');
  assert.equal(state.plan, null);
  assert.equal(state.targetVersion, null);
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-101');
});


test('orchestrator: rejects a malformed gate plan', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-orch-'));
  const backend = new FakeBackend({});
  const orchestrator = new UpdateOrchestrator({
    backend,
    gate: { plan: async () => ({ items: null }) },
    journal: new UpdateJournal({ home }),
    home,
  });
  await assert.rejects(() => orchestrator.check(), (error) => error.code === 'UPD-102');
  assert.equal(orchestrator.getState().state, 'failed');
});


test('orchestrator: activation failure rolls back even without an activation handle', async () => {
  const { orchestrator, journal, backend } = await setup({ backend: { failAt: ['activate'] } });
  await orchestrator.check();
  await assert.rejects(() => orchestrator.start({ confirm: true }), (error) => error.code === 'UPD-501');
  const state = orchestrator.getState();
  assert.equal(state.state, 'rolled-back');
  assert.equal(state.currentVersion, '0.2.2-rc.1');
  assert.ok(backend.calls.includes('rollback'));
  assert.equal((await journal.read()).state, 'rolled-back');
});
