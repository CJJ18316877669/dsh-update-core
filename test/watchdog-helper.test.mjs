import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateJournal } from '../src/journal.mjs';
import { Watchdog } from '../src/watchdog.mjs';
import { parseHelperArgs, supervise, recoverFromJournal } from '../src/watchdog-helper.mjs';

async function homeWithJournal(state = 'applying') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-helper-'));
  const journal = new UpdateJournal({ home });
  await journal.begin({
    from: '0.2.2-rc.1',
    to: '0.2.3',
    channel: 'stable',
    backend: 'profile',
    snapshot: join(home, 'updates', 'backup', 'web-1'),
  });
  if (state === 'verifying') {
    await journal.transition('applying');
    await journal.transition('verifying');
  } else if (state !== 'prepared') {
    await journal.transition(state);
  }
  await new Watchdog({ home }).arm({
    journalId: (await journal.read()).id,
    from: '0.2.2-rc.1',
    to: '0.2.3',
  });
  return { home, journal };
}

test('watchdog-helper: accepts only the four contract arguments and confined paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-helper-args-'));
  const profile = join(root, 'profiles', 'web');
  const journal = join(root, 'updates', 'update-journal.json');
  const parsed = parseHelperArgs(['--journal', journal, '--profile', profile, '--port', '8123', '--timeout', '90000']);
  assert.equal(parsed.profileName, 'web');
  assert.equal(parsed.port, 8123);
  assert.throws(() => parseHelperArgs(['--journal', journal, '--profile', profile, '--port', '1', '--timeout', '1000', '--url', 'http://evil']), /unsupported/);
  assert.throws(() => parseHelperArgs(['--journal', join(root, 'outside.json'), '--profile', profile, '--port', '1', '--timeout', '1000']), /journal/);
  assert.throws(() => parseHelperArgs(['--journal', journal, '--profile', join(root, 'other', 'web'), '--port', '1', '--timeout', '1000']), /profile/);
});

test('watchdog-helper: committed journal wins without requiring HTTP', async () => {
  let reads = 0;
  const result = await supervise({
    journal: 'ignored',
    port: 1,
    timeout: 500,
    deadline: Date.now() + 100,
    interval: 1,
    readJournal: async () => {
      reads += 1;
      return reads === 1 ? { state: 'verifying' } : { state: 'committed' };
    },
    probe: async () => false,
  });
  assert.equal(result.action, 'committed');
});

test('watchdog-helper: an active journal at deadline yields a rollback decision', async () => {
  const result = await supervise({
    journal: 'ignored',
    port: 1,
    timeout: 10,
    deadline: Date.now() + 20,
    interval: 2,
    readJournal: async () => ({ state: 'applying' }),
    probe: async () => false,
  });
  assert.equal(result.action, 'rollback');
  assert.equal(result.reason, 'deadline');
});

test('watchdog-helper: recovery transitions applying journal to rolled-back', async () => {
  const { home } = await homeWithJournal('applying');
  const calls = [];
  const result = await recoverFromJournal({
    home,
    profileName: 'web',
    backend: { rollback: async (journal) => { calls.push(journal.state); return { ok: true }; } },
  });
  assert.equal(result.action, 'rolled-back');
  assert.deepEqual(calls, ['rolling-back']);
  const saved = JSON.parse(await readFile(join(home, 'updates', 'update-journal.json'), 'utf8'));
  assert.equal(saved.state, 'rolled-back');
  assert.equal((await new Watchdog({ home }).read()).state, 'disarmed');
});

test('watchdog-helper: failed rollback records safe mode and keeps journal for diagnosis', async () => {
  const { home } = await homeWithJournal('verifying');
  const result = await recoverFromJournal({
    home,
    profileName: 'web',
    backend: { rollback: async () => ({ ok: false, reason: 'snapshot-missing' }) },
  });
  assert.equal(result.action, 'safe-mode');
  const saved = JSON.parse(await readFile(join(home, 'updates', 'update-journal.json'), 'utf8'));
  assert.equal(saved.state, 'failed');
  assert.equal(saved.safeMode, true);
  assert.equal(saved.rollbackError, 'snapshot-missing');
});

test('watchdog-helper: detached spawn receives no extra command or URL', async () => {
  const watchdog = new Watchdog({ home: 'C:/dsh-test-home', helperPath: 'C:/app/watchdog-helper.mjs' });
  let invocation;
  const child = { exitCode: null, unref() { this.unrefCalled = true; } };
  await watchdog.startHelper({
    journalPath: 'C:/dsh-test-home/updates/update-journal.json',
    profile: 'C:/dsh-test-home/profiles/web',
    port: 8123,
    timeoutMs: 90000,
    spawnImpl: (command, args, options) => { invocation = { command, args, options }; return child; },
  });
  assert.deepEqual(invocation.args.slice(1), [
    '--journal', 'C:/dsh-test-home/updates/update-journal.json',
    '--profile', 'C:/dsh-test-home/profiles/web',
    '--port', '8123',
    '--timeout', '90000',
  ]);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(child.unrefCalled, true);
});
