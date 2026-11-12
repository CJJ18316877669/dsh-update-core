import { existsSync } from 'node:fs';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from './store.mjs';

/**
 * Profile files that can affect whether plugins load after a core update.
 * node_modules is rebuilt from the lockfile; caches/logs are intentionally
 * excluded.
 */
export const PROFILE_CONFIG_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'cordis.patch.yml',
  'cordis.yml',
  'compatibility.json',
  'pnpm-workspace.yaml',
  '.npmrc',
  'settings.json',
];

export async function backupProfileConfig(profileDir, backupDir) {
  await mkdir(backupDir, { recursive: true });
  const files = [];
  for (const name of PROFILE_CONFIG_FILES) {
    const source = join(profileDir, name);
    if (!existsSync(source)) continue;
    await copyFile(source, join(backupDir, name));
    files.push(name);
  }
  await writeJson(join(backupDir, 'backup-meta.json'), {
    schema: 2,
    files,
    createdAt: new Date().toISOString(),
  });
  return files;
}

export async function restoreProfileConfig(backupDir, profileDir) {
  const meta = await readJson(join(backupDir, 'backup-meta.json'), null);
  const files = Array.isArray(meta?.files)
    ? meta.files.filter((name) => PROFILE_CONFIG_FILES.includes(name))
    : PROFILE_CONFIG_FILES.filter((name) => existsSync(join(backupDir, name)));
  for (const name of PROFILE_CONFIG_FILES) {
    const backup = join(backupDir, name);
    if (files.includes(name) && existsSync(backup)) {
      await copyFile(backup, join(profileDir, name));
    } else if (name !== 'package.json') {
      await unlink(join(profileDir, name)).catch(() => {});
    }
  }
  return files;
}
