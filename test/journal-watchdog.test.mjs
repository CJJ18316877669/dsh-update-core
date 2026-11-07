import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateJournal } from '../src/journal.mjs';
import { Watchdog } from '../src/watchdog.mjs';
import { FileLock } from '../src/lock.mjs';

async function home() {
  return mkdtemp(join(tmpdir(), 'dsh-journal-'));
}

test('journal: begin, transitions and committed terminal', async () => {
  const dir = await home();
  const journal = new UpdateJournal({ home: dir });
  const created = await journal.begin({
    from: '0.2.2-rc.1', to: '0.2.3', channel: 'stable', backend: 'profile',
  });
  assert.equal(created.state, 'prepared');
  const applying = await journal.transition('applying', { staging: '/tmp/staging' });
  assert.equal(applying.state, 'applying');
  assert.equal(applying.staging, '/tmp/staging');
  await journal.transition('verifying');
  const committed = await journal.transition('committed', { health: { ok: true } });
  assert.equal(committed.state, 'committed');
  await assert.rejects(() => journal.transition('verifying'), /committed -> verifying|invalid journal transition/);
});

test('journal: terminal journal is archived before a new run starts', async () => {
  const dir = await home();
  const journal = new UpdateJournal({ home: dir });
  const first = await journal.begin({ from: '0.2.2', to: '0.2.3', channel: 'stable', backend: 'profile' });
  await journal.transition('applying');
  await journal.transition('verifying');
  await journal.transition('committed');
  const second = await journal.begin({ from: '0.2.3', to: '0.2.4', channel: 'stable', backend: 'profile' });
  assert.notEqual(first.id, second.id);
  const archived = await readdir(join(dir, 'updates', 'history'));
  assert.ok(archived.some((name) => name === `${first.id}.json`));
});

test('journal: manual rollback from committed is allowed', async () => {
  const dir = await home();
  const journal = new UpdateJournal({ home: dir });
  await journal.begin({ from: '0.2.2', to: '0.2.3', channel: 'stable', backend: 'profile' });
  await journal.transition('applying');
  await journal.transition('verifying');
  await journal.transition('committed');
  const rolling = await journal.transition('rolling-back');
  assert.equal(rolling.state, 'rolling-back');
  const rolled = await journal.transition('rolled-back');
  assert.equal(rolled.state, 'rolled-back');
});

test('journal: active journal blocks a second begin', async () => {
  const dir = await home();
  const journal = new UpdateJournal({ home: dir });
  await journal.begin({ from: '0.2.2', to: '0.2.3', channel: 'stable', backend: 'profile' });
  await assert.rejects(
    () => journal.begin({ from: '0.2.2', to: '0.2.4', channel: 'stable', backend: 'profile' }),
    (error) => error.code === 'UPD-303',
  );
});

test('journal: corrupt file is quarantined and treated as absent', async () => {
  const dir = await home();
  const journal = new UpdateJournal({ home: dir });
  await journal.begin({ from: '0.2.2', to: '0.2.3', channel: 'stable', backend: 'profile' });
  await writeFile(journal.path, '{broken json', 'utf8');
  assert.equal(await journal.read(), null);
  const entries = await readdir(join(dir, 'updates'));
  assert.ok(entries.some((name) => name.includes('.corrupt-')));
});

test('journal: recover decisions for applying/committed', async () => {
  const dir = await home();
  const journal = new UpdateJournal({ home: dir });
  await journal.begin({ from: '0.2.2', to: '0.2.3', channel: 'stable', backend: 'profile' });
  await journal.transition('applying');

  assert.equal((await journal.recover({ currentVersion: '0.2.2' })).action, 'rollback');
  assert.equal((await journal.recover({ currentVersion: '0.2.3' })).action, 'verify');

  const dir2 = await home();
  const journal2 = new UpdateJournal({ home: dir2 });
  await journal2.begin({ from: '0.2.2', to: '0.2.3', channel: 'stable', backend: 'profile' });
  await journal2.transition('applying');
  await journal2.transition('verifying');
  await journal2.transition('committed');
  assert.equal((await journal2.recover({ currentVersion: '0.2.3' })).action, 'cleanup');
});

test('watchdog: waiting, heartbeat, healthy and deadline', async () => {
  const dir = await home();
  let now = 1_700_000_000_000;
  const wd = new Watchdog({ home: dir, clock: () => now });
  await wd.arm({ journalId: 'j1', from: '0.2.2', to: '0.2.3', deadlineMs: 1000, maxBoots: 3 });

  const waiting = await wd.evaluate({ currentVersion: '0.2.3', boot: true });
  assert.equal(waiting.action, 'waiting');
  assert.equal(waiting.state.boots, 1);

  await wd.beat();
  const healthy = await wd.evaluate({ currentVersion: '0.2.3' });
  assert.equal(healthy.action, 'healthy');

  await wd.arm({ journalId: 'j2', from: '0.2.2', to: '0.2.3', deadlineMs: 1000 });
  now += 1001;
  const rollback = await wd.evaluate({ currentVersion: '0.2.3' });
  assert.equal(rollback.action, 'rollback');
  assert.equal(rollback.reason, 'deadline');
});

test('watchdog: previous version, version mismatch and boot loop', async () => {
  const dir = await home();
  let now = 1_700_000_000_000;
  const wd = new Watchdog({ home: dir, clock: () => now });

  await wd.arm({ journalId: 'j1', from: '0.2.2', to: '0.2.3', deadlineMs: 60000 });
  assert.equal((await wd.evaluate({ currentVersion: '0.2.2' })).action, 'rolled-back');

  await wd.arm({ journalId: 'j2', from: '0.2.2', to: '0.2.3', deadlineMs: 60000 });
  assert.equal((await wd.evaluate({ currentVersion: '0.9.9' })).action, 'safe-mode');

  await wd.arm({ journalId: 'j3', from: '0.2.2', to: '0.2.3', deadlineMs: 60000, maxBoots: 1 });
  assert.equal((await wd.evaluate({ currentVersion: '0.2.3', boot: true })).action, 'waiting');
  const loop = await wd.evaluate({ currentVersion: '0.2.3', boot: true });
  assert.equal(loop.action, 'rollback');
  assert.equal(loop.reason, 'boot-loop');
});

test('lock: single flight, release and stale takeover', async () => {
  const dir = await home();
  let now = 1_700_000_000_000;
  const first = new FileLock({ home: dir, clock: () => now, staleMs: 1000 });
  const second = new FileLock({ home: dir, clock: () => now, staleMs: 1000 });
  await first.acquire();
  await assert.rejects(() => second.acquire(), (error) => error.code === 'UPD-303');
  await first.release();

  const third = new FileLock({ home: dir, clock: () => now, staleMs: 1000 });
  await third.acquire();
  now += 2000;
  const fourth = new FileLock({ home: dir, clock: () => now, staleMs: 1000 });
  await fourth.acquire();
  await fourth.release();
  await third.release();
});
