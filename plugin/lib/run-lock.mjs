import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const RUN_LOCK_TTL_MS = 3 * 60_000;

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM means the process exists but belongs to a more privileged user.
    return true;
  }
}

async function hasTerminalResult(lockPath, run) {
  try {
    const state = JSON.parse(await readFile(join(dirname(lockPath), run, 'result.json'), 'utf8'));
    return ['succeeded', 'failed', 'rolled-back'].includes(state.state);
  } catch {
    return false;
  }
}

async function replaceFile(temp, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export async function readRunLock(lockPath, ttlMs = RUN_LOCK_TTL_MS) {
  try {
    const info = await stat(lockPath);
    const owner = await readOwner(lockPath);
    const ageMs = Date.now() - info.mtimeMs;
    const fresh = ageMs <= ttlMs;
    const ownerAlive = isProcessAlive(owner?.pid);
    return {
      active: fresh && ownerAlive !== false,
      stale: ageMs > ttlMs,
      orphaned: fresh && ownerAlive === false,
      owner,
      ownerAlive,
      ageMs,
    };
  } catch {
    return {
      active: false,
      stale: false,
      orphaned: false,
      owner: null,
      ownerAlive: null,
      ageMs: null,
    };
  }
}

export async function acquireRunLock(lockPath, run, ttlMs = RUN_LOCK_TTL_MS) {
  await mkdir(dirname(lockPath), { recursive: true });
  let recovered = false;
  let recoveredOwner = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({
        run,
        pid: process.pid,
        role: 'plugin',
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      await handle.close();
      return { ok: true, path: lockPath, recovered, recoveredOwner };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!error || error.code !== 'EEXIST') throw error;
      const current = await readRunLock(lockPath, ttlMs);
      const ownerRun = current.owner?.run;
      const recoverable = current.stale
        || current.orphaned
        || (ownerRun && await hasTerminalResult(lockPath, ownerRun));
      if (recoverable) {
        recovered = true;
        recoveredOwner = current.owner || null;
        await unlink(lockPath).catch(() => {});
        continue;
      }
      return { ok: false, owner: current.owner, stale: current.stale, orphaned: current.orphaned };
    }
  }
  return { ok: false, owner: await readOwner(lockPath), stale: false, orphaned: false };
}

/**
 * Transfers lock ownership to the supervisor/helper that is actually running.
 * The write is atomic so readers never observe a truncated owner document.
 */
export async function refreshRunLock(lockPath, run, owner = {}) {
  const current = await readOwner(lockPath);
  if (!current || current.run !== run) return false;
  const temp = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({
      ...current,
      ...owner,
      run,
      pid: owner.pid || process.pid,
      role: owner.role || current.role || 'owner',
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    await replaceFile(temp, lockPath);
    return true;
  } catch {
    await unlink(temp).catch(() => {});
    return false;
  }
}

export async function touchRunLock(lockPath, run) {
  const current = await readOwner(lockPath);
  if (!current || current.run !== run) return false;
  try {
    const now = new Date();
    await utimes(lockPath, now, now);
    return true;
  } catch {
    return false;
  }
}

export async function releaseRunLock(lockPath, run) {
  const owner = await readOwner(lockPath);
  if (owner && run && owner.run !== run) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}
