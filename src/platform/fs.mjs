import { createHash, randomBytes } from 'node:crypto';
import { access, cp, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const DEFAULT_BACKOFF = [50, 150, 400];
const PAUSE = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {unknown} error */
export function isRetryableRenameError(error) {
  return Boolean(error && typeof error === 'object' && RETRYABLE.has(/** @type {any} */ (error).code));
}

/**
 * Rename with bounded backoff. EXDEV is surfaced immediately: retrying cannot
 * move a directory between volumes and callers must use copyFallback.
 * @param {string} source
 * @param {string} target
 * @param {{fs?:{rename:Function}, backoff?:number[], pause?:Function}} [options]
 */
export async function renameWithRetry(source, target, options = {}) {
  const renameImpl = options.fs?.rename || rename;
  const backoff = options.backoff || DEFAULT_BACKOFF;
  const pause = options.pause || PAUSE;
  let lastError;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    try {
      await renameImpl(source, target);
      return { attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (/** @type {any} */ (error)?.code === 'EXDEV') throw error;
      if (!isRetryableRenameError(error) || attempt === backoff.length) throw error;
      await pause(backoff[attempt]);
    }
  }
  throw lastError;
}

async function hashTree(root) {
  const hash = createHash('sha256');
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      hash.update(relative(root, full));
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) hash.update(`link:${await readFile(full, 'utf8').catch(() => '')}`);
      else hash.update(await readFile(full));
    }
  }
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`copy verification requires a directory: ${root}`);
  await walk(root);
  return hash.digest('hex');
}

/** Verify that a copied tree is structurally and byte-identical. */
export async function verifyTreeCopy(source, target) {
  const [left, right] = await Promise.all([hashTree(source), hashTree(target)]);
  if (left !== right) throw new Error('copied profile failed integrity verification');
  return right;
}

/**
 * EXDEV degradation: copy beside the destination, verify every byte, then
 * rename the verified copy into place. Existing target must have been moved by
 * the caller; this function never deletes a recovery point.
 * @param {string} source
 * @param {string} target
 * @param {{fs?:{cp?:Function,rm?:Function,rename?:Function}, id?:string}} [options]
 */
export async function copyFallback(source, target, options = {}) {
  const id = options.id || `${process.pid}-${Date.now()}`;
  const incoming = `${target}.incoming-${id}`;
  const fs = options.fs || {};
  try {
    await (fs.cp || cp)(source, incoming, { recursive: true, force: true, dereference: true });
    await verifyTreeCopy(source, incoming);
    await renameWithRetry(incoming, target, options);
    return { copied: true, target, verified: true };
  } catch (error) {
    await (fs.rm || rm)(incoming, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** @param {string} path */
export async function pathExists(path, fs = {}) {
  try {
    await (fs.access || access)(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Durable atomic text write. The file is fsynced before a bounded rename retry;
 * callers either observe the previous bytes or the complete new bytes.
 * @param {string} file
 * @param {string} payload
 * @param {{mode?:number, fs?:Record<string, Function>, backoff?:number[]}} [options]
 */
export async function writeFileAtomic(file, payload, options = {}) {
  const fs = options.fs || {};
  const mkdirImpl = fs.mkdir || mkdir;
  const openImpl = fs.open || open;
  const unlinkImpl = fs.unlink || unlink;
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await mkdirImpl(dirname(file), { recursive: true });
  let handle;
  try {
    handle = await openImpl(temp, 'wx', options.mode ?? 0o600);
    await handle.writeFile(payload, 'utf8');
    if (typeof handle.sync === 'function') await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temp, file, { fs, backoff: options.backoff });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await (fs.unlink || unlink)(temp).catch(() => {});
    throw error;
  }
}

/**
 * Retry unlink only for sharing violations seen on Windows.
 * @param {string} file
 * @param {{fs?:{unlink?:Function}, backoff?:number[]}} [options]
 */
export async function unlinkWithRetry(file, options = {}) {
  const unlinkImpl = options.fs?.unlink || unlink;
  const backoff = options.backoff || DEFAULT_BACKOFF;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    try {
      await unlinkImpl(file);
      return true;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return false;
      if (!isRetryableRenameError(error) || attempt === backoff.length) throw error;
      await PAUSE(backoff[attempt]);
    }
  }
  return false;
}

export { hashTree };
