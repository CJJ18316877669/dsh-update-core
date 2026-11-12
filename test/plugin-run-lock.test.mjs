import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRunLock,
  isProcessAlive,
  readRunLock,
  refreshRunLock,
  releaseRunLock,
  touchRunLock,
} from '../plugin/lib/run-lock.mjs';

test('run lock: cross-process acquisition is atomic and ownership-scoped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-run-lock-'));
  const lock = join(home, 'update.lock');
  try {
    const first = await acquireRunLock(lock, 'run-a');
    assert.equal(first.ok, true);
    const second = await acquireRunLock(lock, 'run-b');
    assert.equal(second.ok, false);
    assert.equal(second.owner.run, 'run-a');
    assert.equal(await releaseRunLock(lock, 'run-b'), false);
    assert.equal((await readRunLock(lock)).active, true);
    assert.equal(await releaseRunLock(lock, 'run-a'), true);
    assert.equal((await readRunLock(lock)).active, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('run lock: a terminal result releases a stale lock left by a crashed parent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-run-lock-terminal-'));
  const lock = join(home, 'update.lock');
  const run = '2026-11-11T10-00-00-000Z';
  try {
    await mkdir(join(home, run), { recursive: true });
    await writeFile(join(home, run, 'result.json'), JSON.stringify({ state: 'succeeded' }));
    await writeFile(lock, JSON.stringify({ run, pid: 1 }));
    const next = await acquireRunLock(lock, '2026-11-11T11-00-00-000Z');
    assert.equal(next.ok, true);
    const owner = JSON.parse(await readFile(lock, 'utf8'));
    assert.equal(owner.run, '2026-11-11T11-00-00-000Z');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('run lock: locks older than the TTL are reclaimed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-run-lock-stale-'));
  const lock = join(home, 'update.lock');
  try {
    await writeFile(lock, JSON.stringify({ run: 'old-run', pid: 1 }));
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await utimes(lock, old, old);
    const next = await acquireRunLock(lock, '2026-11-11T11-00-00-000Z');
    assert.equal(next.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('run lock: dead owner is detected and the lock is reclaimed immediately', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-run-lock-dead-'));
  const lock = join(home, 'update.lock');
  try {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(999999), false);
    await writeFile(lock, JSON.stringify({ run: 'dead-run', pid: 999999, role: 'supervisor' }));
    const observed = await readRunLock(lock);
    assert.equal(observed.active, false);
    assert.equal(observed.orphaned, true);
    const next = await acquireRunLock(lock, '2026-11-11T12-00-00-000Z');
    assert.equal(next.ok, true);
    assert.equal(next.recovered, true);
    assert.equal(next.recoveredOwner.role, 'supervisor');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('run lock: ownership can transfer to the supervisor and heartbeat refreshes mtime', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-run-lock-refresh-'));
  const lock = join(home, 'update.lock');
  const run = '2026-11-11T13-00-00-000Z';
  try {
    assert.equal((await acquireRunLock(lock, run)).ok, true);
    assert.equal(await refreshRunLock(lock, run, { pid: process.pid, role: 'supervisor' }), true);
    const owner = JSON.parse(await readFile(lock, 'utf8'));
    assert.equal(owner.role, 'supervisor');
    const old = new Date(Date.now() - 30_000);
    await utimes(lock, old, old);
    assert.equal(await touchRunLock(lock, run), true);
    assert.equal((await readRunLock(lock)).active, true);
    assert.equal(await refreshRunLock(lock, 'different-run'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
