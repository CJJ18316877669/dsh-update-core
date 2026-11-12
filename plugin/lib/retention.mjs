import { readdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { readJson } from './store.mjs';
import { readRunLock } from './run-lock.mjs';

const RUN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const TERMINAL = new Set(['succeeded', 'failed', 'rolled-back']);
const LARGE_ARTIFACTS = ['installer.exe', 'rollback-installer.exe'];

function confined(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  return !rel.startsWith('..') && rel !== '' ? target : null;
}

async function removeFile(root, target, removed, planned, dryRun) {
  const safe = confined(root, target);
  if (!safe) return;
  const name = relative(root, safe);
  if (dryRun) {
    planned.push(name);
    return;
  }
  try {
    await unlink(safe);
    removed.push(name);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function removeDir(root, target, removed, planned, dryRun) {
  const safe = confined(root, target);
  if (!safe) return;
  const name = `${relative(root, safe)}/`;
  if (dryRun) {
    planned.push(name);
    return;
  }
  try {
    await rm(safe, { recursive: true, force: true });
    removed.push(name);
  } catch { /* best effort; do not block plugin startup */ }
}

/**
 * Keeps result/plan/log history but releases multi-hundred-MB installers and
 * profile backups that are no longer referenced by the current rollback point.
 */
export async function pruneUpdateArtifacts(updatesDir, options = {}) {
  const root = resolve(updatesDir);
  const keepRuns = options.keepRuns ?? 30;
  const dryRun = options.dryRun === true;
  const coreState = options.coreState || null;
  const removed = [];
  const planned = [];
  const lock = await readRunLock(join(root, 'update.lock'));
  if (lock.active) return { skipped: 'active-lock', dryRun, removed, planned };

  const active = await readJson(join(root, 'active-run.json'), null);
  if (active?.run && RUN_RE.test(active.run)) {
    try {
      const state = await readJson(join(root, active.run, 'result.json'), null);
      if (!state || !TERMINAL.has(state.state)) return { skipped: 'active-run', dryRun, removed, planned };
    } catch {
      return { skipped: 'active-run', dryRun, removed, planned };
    }
  }

  const preserveRun = typeof coreState?.lastRun === 'string' && RUN_RE.test(coreState.lastRun)
    ? coreState.lastRun
    : null;
  const preserveFiles = new Set(
    [
      coreState?.rollbackInstaller,
      coreState?.rollbackPackage,
      coreState?.profileBackup ? join(coreState.profileBackup, 'package.json') : '',
    ]
      .filter(Boolean)
      .map((value) => confined(root, value))
      .filter(Boolean),
  );

  const preservedBackupDir = coreState?.profileBackup
    ? resolve(coreState.profileBackup)
    : null;
  const entries = await readdir(root, { withFileTypes: true });
  const runs = entries
    .filter((entry) => entry.isDirectory() && RUN_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const runDir = join(root, run);
    if (run === preserveRun) continue;
    if (index >= keepRuns) {
      await removeDir(root, runDir, removed, planned, dryRun);
      continue;
    }
    for (const name of LARGE_ARTIFACTS) {
      const target = join(runDir, name);
      if (!preserveFiles.has(resolve(target))) {
        await removeFile(root, target, removed, planned, dryRun);
      }
    }
    const backupDir = join(runDir, 'profile-backup');
    if (resolve(backupDir) !== preservedBackupDir) {
      await removeDir(root, backupDir, removed, planned, dryRun);
    }
  }

  const legacyRollback = join(root, 'rollback', 'installer.exe');
  const legacyDir = dirname(legacyRollback);
  const legacyDirReferenced = [...preserveFiles].some((file) => {
    const rel = relative(resolve(legacyDir), file);
    return rel !== '' && !rel.startsWith('..');
  });
  if (!preserveFiles.has(resolve(legacyRollback))) {
    await removeFile(root, legacyRollback, removed, planned, dryRun);
    if (!legacyDirReferenced) await removeDir(root, legacyDir, removed, planned, dryRun);
  }

  for (const entry of entries.filter((value) => value.isFile() && value.name.endsWith('.tmp'))) {
    await removeFile(root, join(root, entry.name), removed, planned, dryRun);
  }

  return { skipped: null, dryRun, removed, planned };
}
