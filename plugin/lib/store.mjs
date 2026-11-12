import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'w');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, file);
        break;
      } catch (error) {
        const retryable = error && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
        if (!retryable || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export function stateDir(paths) {
  return join(paths.home, 'updates', 'dsh-update-plugin');
}

export async function readIgnored(paths) {
  const data = await readJson(join(stateDir(paths), 'ignored.json'), null);
  const versions = data && data.schema === 1 && data.versions && typeof data.versions === 'object'
    ? data.versions
    : {};
  return new Map(Object.entries(versions).filter(([, version]) => typeof version === 'string'));
}

export async function setIgnored(paths, name, version) {
  const ignored = await readIgnored(paths);
  if (version === null) ignored.delete(name);
  else ignored.set(name, version);
  await writeJson(join(stateDir(paths), 'ignored.json'), {
    schema: 1,
    versions: Object.fromEntries(ignored),
    updatedAt: new Date().toISOString(),
  });
  return ignored;
}

export async function readCoreState(paths) {
  const data = await readJson(join(stateDir(paths), 'core-state.json'), null);
  if (!data || data.schema !== 1) return null;
  return data;
}

export async function writeCoreState(paths, state) {
  await writeJson(join(stateDir(paths), 'core-state.json'), {
    schema: 1,
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

export async function readHeartbeat(paths) {
  return readJson(join(stateDir(paths), 'heartbeat.json'), null);
}

export async function writeHeartbeat(paths, data) {
  await writeJson(join(stateDir(paths), 'heartbeat.json'), {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function listHistory(paths, limit = 20) {
  const root = stateDir(paths);
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 100)));
  const history = [];
  for (const run of runs) {
    const result = await readJson(join(root, run, 'result.json'), null);
    if (!result) continue;
    const plan = await readJson(join(root, run, 'plan.json'), null);
    history.push({
      run,
      state: result.state,
      message: result.message || '',
      targetCore: result.targetCore || plan?.targetCore || null,
      coreVersion: result.coreVersion || null,
      updated: Array.isArray(result.updated) ? result.updated : [],
      kept: Array.isArray(result.kept) ? result.kept.length : 0,
      rolledBack: result.rolledBack === true,
      startedAt: result.startedAt || null,
      updatedAt: result.updatedAt || null,
    });
  }
  return history;
}

export async function writeLastPlan(paths, run, plan) {
  await writeJson(join(stateDir(paths), 'last-plan.json'), { schema: 1, run, plan, updatedAt: new Date().toISOString() });
}

export async function readLastPlan(paths) {
  return readJson(join(stateDir(paths), 'last-plan.json'), null);
}

export { readJson, writeJson };
