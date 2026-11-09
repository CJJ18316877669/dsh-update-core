import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { UpdateError } from '../errors.mjs';

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function expandHomePath(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  return path;
}

/**
 * Official dsh precedence: explicit path > non-blank DSH_HOME > ~/.dsh.
 * @param {{configured?:string, env?:Record<string,string|undefined>, home?:string}} [options]
 */
export function resolveDshHome(options = {}) {
  const env = options.env || process.env;
  const home = options.home || homedir();
  const configured = options.configured;
  const fromEnv = env.DSH_HOME;
  const selected = configured != null
    ? configured
    : (typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(home, '.dsh'));
  const expanded = expandHomePath(selected, home);
  if (!isAbsolute(expanded)) throw new TypeError(`DSH_HOME must be absolute: ${selected}`);
  return resolve(expanded);
}

/** User-visible symbolic form; never prints the machine home. */
export function dshHomeDisplay(resolvedHome, home = homedir()) {
  return resolvedHome === resolve(join(home, '.dsh')) ? '~/.dsh' : '$DSH_HOME';
}

/**
 * Validate a profile directory name before it participates in a filesystem
 * operation. Lowercase-only prevents NTFS/APFS case collisions.
 * @param {unknown} name
 */
export function assertSafeProfileName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    throw new TypeError('profileName must be a non-empty string of at most 64 characters');
  }
  if (name !== name.toLowerCase()) {
    throw new TypeError('profileName must be lowercase to avoid case-insensitive path collisions');
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name)) {
    throw new TypeError(`invalid profileName: ${name}`);
  }
  if (WINDOWS_RESERVED.has(name.split('.')[0])) {
    throw new TypeError(`profileName is reserved on Windows: ${name}`);
  }
  if (name === 'desktop') {
    throw new TypeError('profile "desktop" is reserved for the Electron application');
  }
  return name;
}

/**
 * Reject a path that is likely to exceed the legacy Windows MAX_PATH even
 * with node_modules descendants. Callers surface this before writes begin.
 * @param {string} path
 * @param {{platform?:string, limit?:number}} [options]
 */
export function assertSafePathLength(path, options = {}) {
  const platform = options.platform || process.platform;
  const limit = options.limit ?? 240;
  if (platform === 'win32' && path.length > limit) {
    throw new UpdateError('UPD-702', {
      message: `profile path is too long for Windows: ${path.length} > ${limit}`,
      details: { length: path.length, limit },
    });
  }
  return path;
}

/**
 * Resolve a child and prove it stays under a root.
 * @param {string} root
 * @param {...string} segments
 */
export function resolveInside(root, ...segments) {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, ...segments);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new TypeError(`path escapes root: ${target}`);
  }
  return target;
}
