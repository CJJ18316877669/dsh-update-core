#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpdateJournal } from './journal.mjs';
import { Watchdog } from './watchdog.mjs';
import { NpmBackend } from './backends/npm.mjs';

const PAUSE = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function parseHelperArgs(argv) {
  const allowed = new Set(['journal', 'profile', 'port', 'timeout']);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`unsupported option: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  if (!values.journal || !values.profile || !values.port || !values.timeout) {
    throw new Error('usage: watchdog-helper --journal <file> --profile <dir> --port <port> --timeout <ms>');
  }
  const profile = resolve(values.profile);
  const journal = resolve(values.journal);
  const home = resolve(profile, '..', '..');
  const profileRoot = resolve(home, 'profiles') + sep;
  const updateRoot = resolve(home, 'updates') + sep;
  if (!`${profile}${sep}`.startsWith(profileRoot)) throw new Error('profile must be inside DSH_HOME/profiles');
  if (!journal.startsWith(updateRoot)) throw new Error('journal must be inside DSH_HOME/updates');
  const port = Number(values.port);
  const timeout = Number(values.timeout);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 600000) {
    throw new Error('timeout must be between 1000 and 600000 ms');
  }
  return {
    journal,
    profile,
    home,
    profileName: basename(profile),
    port,
    timeout,
  };
}

async function readJournal(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function probeHttp(port, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'manual',
    });
    return Boolean(response && response.status < 500);
  } catch {
    return false;
  }
}

/**
 * Wait for the new host to commit, or return a rollback decision at deadline.
 * The orchestrator commits the journal; the helper never treats HTTP alone as
 * commit because the host may still be in startup verification.
 */
export async function supervise(options) {
  const deadline = options.deadline || (Date.now() + options.timeout);
  const interval = options.interval ?? 100;
  const read = options.readJournal || (() => readJournal(options.journal));
  const probe = options.probe || (() => probeHttp(options.port, options.fetchImpl));
  while (Date.now() < deadline) {
    const journal = await read();
    if (!journal) return { action: 'error', reason: 'journal-missing' };
    if (journal.state === 'committed') return { action: 'committed', journal };
    if (journal.state === 'rolled-back') return { action: 'rolled-back', journal };
    if (journal.state === 'failed') return { action: 'safe-mode', journal };
    if (journal.state === 'verifying' && await probe()) {
      return { action: 'healthy-uncommitted', journal };
    }
    await PAUSE(interval);
  }
  const journal = await read();
  if (!journal) return { action: 'error', reason: 'journal-missing' };
  if (journal.state === 'committed' || journal.state === 'rolled-back' || journal.state === 'failed') {
    return { action: journal.state, journal };
  }
  return { action: 'rollback', reason: 'deadline', journal };
}

export async function recoverFromJournal(options) {
  const journalStore = new UpdateJournal({ home: options.home });
  let journal = await journalStore.read();
  if (!journal) return { ok: false, reason: 'journal-missing' };
  if (journal.state === 'committed' || journal.state === 'rolled-back') {
    return { ok: true, action: journal.state, journal };
  }
  if (journal.state === 'failed') return { ok: true, action: 'safe-mode', journal };
  const backend = options.backend || new NpmBackend({
    home: options.home,
    profileName: options.profileName,
  });
  if (!['applying', 'verifying', 'rolling-back'].includes(journal.state)) {
    return { ok: true, action: 'no-action', journal };
  }
  if (journal.state !== 'rolling-back') journal = await journalStore.transition('rolling-back');
  const report = await backend.rollback(journal);
  if (report.ok) {
    await journalStore.transition('rolled-back', { error: { code: 'UPD-601', message: 'watchdog deadline' } });
    await new Watchdog({ home: options.home }).disarm().catch(() => {});
    return { ok: true, action: 'rolled-back', report };
  }
  await journalStore.transition('failed', {
    safeMode: true,
    rollbackError: report.reason || 'watchdog-rollback-failed',
  }).catch(() => {});
  await new Watchdog({ home: options.home }).disarm().catch(() => {});
  return { ok: false, action: 'safe-mode', report };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseHelperArgs(argv);
  const result = await supervise(options);
  if (result.action === 'rollback') {
    const recovery = await recoverFromJournal(options);
    return recovery.ok ? 2 : 3;
  }
  if (result.action === 'safe-mode') return 3;
  if (result.action === 'error') return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
