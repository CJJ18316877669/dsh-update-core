import { isAbsolute, relative, resolve, join } from 'node:path';

export const EXPECTED_PLUGIN_NAME = 'dsh-update-core-plugin';

export function assertExpectedPluginName(name, expected = EXPECTED_PLUGIN_NAME) {
  if (name !== expected) {
    throw new Error(`unexpected plugin package name: ${JSON.stringify(name)}; expected ${expected}`);
  }
  return name;
}

export function assertSafeProfileName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(`unsafe profile name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function assertInside(root, candidate) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes its root: ${absoluteCandidate}`);
  }
  return absoluteCandidate;
}

export function resolvePluginDestination(profileDir, packageName, expected = EXPECTED_PLUGIN_NAME) {
  assertExpectedPluginName(packageName, expected);
  const nodeModules = resolve(profileDir, 'node_modules');
  return assertInside(nodeModules, join(nodeModules, ...packageName.split('/')));
}

export function backupCandidatePaths(nodeModules, backupName) {
  if (!backupName || backupName.includes('..') || backupName.includes('/') || backupName.includes('\\')) {
    throw new Error(`unsafe backup name: ${JSON.stringify(backupName)}`);
  }
  const root = resolve(nodeModules);
  return [
    assertInside(root, join(root, backupName)),
    assertInside(root, join(root, '.ignored', backupName)),
  ];
}
