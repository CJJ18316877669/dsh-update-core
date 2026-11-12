import { compare, parse } from './vendor/semver.mjs';

/**
 * Windows ProductVersion commonly has four numeric parts (0.2.2.0) even when
 * the application version is semver (0.2.2 or 0.2.2-rc.1). Normalise only the
 * harmless trailing zero; never silently replace a prerelease with stable.
 */
export function normalizeProductVersion(value) {
  const text = String(value || '').trim();
  const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\.0+)?$/.exec(text);
  return match ? match[1] : text;
}

/**
 * Prerelease builds must be verified exactly. The four-part ProductVersion
 * fallback loses the prerelease suffix, so it can only prove a stable release.
 */
export function versionMatches(actualVersion, expectedVersion) {
  const actual = parse(normalizeProductVersion(actualVersion));
  const expected = parse(expectedVersion);
  if (!actual || !expected) return false;
  return compare(actual, expected) === 0;
}

/**
 * A run is rolled back only when every mutation was reversed AND the restarted
 * application is healthy. "Core or profile succeeded" is not enough.
 */
export function decideRollbackOutcome({
  appHealthy,
  coreMutated,
  coreRolledBack,
  profileMutated,
  profileRestored,
}) {
  const coreSafe = !coreMutated || coreRolledBack === true;
  const profileSafe = !profileMutated || profileRestored === true;
  const complete = appHealthy === true && coreSafe && profileSafe;
  return {
    state: complete ? 'rolled-back' : 'failed',
    rolledBack: complete,
    coreSafe,
    profileSafe,
    appHealthy: appHealthy === true,
  };
}

export function rollbackMessage({
  complete,
  coreMutated,
  coreRolledBack,
  profileMutated,
  profileRestored,
  appHealthy,
}) {
  if (complete) return '已回滚，应用已通过启动健康检查';
  const problems = [];
  if (coreMutated && !coreRolledBack) problems.push('核心未能回滚');
  if (profileMutated && !profileRestored) problems.push('插件 profile 未能完整恢复');
  if (!appHealthy) problems.push('应用未通过启动健康检查');
  return `回滚未完整完成：${problems.join('；') || '存在未恢复的变更'}`;
}

/**
 * DSH writes activation warnings to the Desktop stdout/stderr stream. The
 * updater already knows its own plugin loaded; these warnings are the only
 * host-side signal currently available for other plugins.
 */
export function startupLogFailures(text) {
  const patterns = [
    /(?:^|\n).*dsh: warning:.*did not activate/i,
    /(?:^|\n).*pending \(waiting for service:/i,
    /(?:^|\n).*did not activate.*(?:plugin|entry|dsh-)/i,
    // dsh >= 0.2.2 rejects a profile bundle whose exact peer requirements do not
    // match the running core: it skips the bundle while loading the profile and
    // the desktop host then exits with code 1, so the app is unusable.
    /(?:^|\n).*dsh: skipping profile bundle/i,
    /(?:^|\n).*is incompatible with dsh \d/i,
  ];
  const lines = String(text || '').split(/\r?\n/);
  const failures = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (patterns.some((pattern) => pattern.test(`\n${line}`)) && !failures.includes(line.trim())) {
      failures.push(line.trim());
    }
  }
  return failures.slice(0, 12);
}
