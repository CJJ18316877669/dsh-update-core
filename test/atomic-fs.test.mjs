import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmBackend } from '../src/backends/npm.mjs';
import { copyFallback, renameWithRetry, verifyTreeCopy, writeFileAtomic } from '../src/platform/fs.mjs';

function codedError(code) {
  const error = new Error(`injected ${code}`);
  error.code = code;
  return error;
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-atomic-'));
  const profile = join(home, 'profiles', 'web');
  const stagedPath = join(home, 'updates', 'staging', 'id', 'home', 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  await mkdir(stagedPath, { recursive: true });
  await writeFile(join(profile, 'version.txt'), 'old');
  await writeFile(join(stagedPath, 'version.txt'), 'new');
  const staged = { id: 'id', path: stagedPath, plan: { targetCore: '0.2.3', items: [] } };
  return { home, profile, stagedPath, staged };
}

function backendWithRename(home, renameImpl) {
  return new NpmBackend({
    home,
    fsOps: { rename: renameImpl },
    renameBackoff: [0, 0, 0],
  });
}

test('atomic swap: transient EPERM is retried and completes without degradation', async () => {
  const { home, profile, staged } = await setup();
  let failures = 2;
  const backend = backendWithRename(home, async (source, target) => {
    if (failures > 0) {
      failures -= 1;
      throw codedError('EPERM');
    }
    return rename(source, target);
  });
  const handle = await backend.activate(staged);
  assert.equal(handle.degraded, false);
  assert.equal(await readFile(join(profile, 'version.txt'), 'utf8'), 'new');
  await handle.commit();
});

test('atomic swap: persistent EPERM never removes the old profile', async () => {
  const { home, profile, staged, stagedPath } = await setup();
  const backend = backendWithRename(home, async () => { throw codedError('EPERM'); });
  await assert.rejects(
    () => backend.activate(staged),
    (error) => error.code === 'UPD-501' && error.details.rollbackFailed === false,
  );
  assert.equal(await readFile(join(profile, 'version.txt'), 'utf8'), 'old');
  assert.equal(await readFile(join(stagedPath, 'version.txt'), 'utf8'), 'new');
});

test('atomic swap: EXDEV degrades to verified copy and marks the handle', async () => {
  const { home, profile, stagedPath, staged } = await setup();
  const backend = backendWithRename(home, async (source, target) => {
    if (source === stagedPath) throw codedError('EXDEV');
    return rename(source, target);
  });
  const handle = await backend.activate(staged);
  assert.equal(handle.degraded, true);
  assert.equal(await readFile(join(profile, 'version.txt'), 'utf8'), 'new');
  await handle.commit();
});

test('atomic swap: rollback surfaces the recovery path instead of swallowing rename errors', async () => {
  const { home, staged } = await setup();
  let failProfileMove = false;
  const backend = backendWithRename(home, async (source, target) => {
    if (failProfileMove && source.endsWith(`${join('profiles', 'web')}`)) throw codedError('EPERM');
    return rename(source, target);
  });
  const handle = await backend.activate(staged);
  failProfileMove = true;
  await assert.rejects(
    () => handle.rollback(),
    (error) => /failed profile/.test(error.message) && error.failedPath.includes('.failed-'),
  );
});

test('atomic swap: non-retryable rename errors fail immediately', async () => {
  let calls = 0;
  await assert.rejects(
    () => renameWithRetry('a', 'b', {
      fs: { rename: async () => { calls += 1; throw codedError('ENOENT'); } },
      backoff: [0, 0, 0],
    }),
    (error) => error.code === 'ENOENT',
  );
  assert.equal(calls, 1);
});

test('atomic write: transient sharing violation never exposes a partial file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-'));
  const file = join(root, 'state.json');
  let failures = 2;
  await writeFileAtomic(file, '{"new":true}\n', {
    backoff: [0, 0, 0],
    fs: {
      rename: async (source, target) => {
        if (failures > 0) {
          failures -= 1;
          throw codedError('EBUSY');
        }
        return rename(source, target);
      },
    },
  });
  assert.equal(await readFile(file, 'utf8'), '{"new":true}\n');
});

test('atomic swap: copy fallback verifies bytes before and after replacing the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-copy-'));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'a.txt'), 'payload');
  await writeFile(join(source, 'nested.txt'), 'nested-payload');
  const target = join(root, 'target');
  const report = await copyFallback(source, target, { id: 'test', backoff: [0] });
  assert.equal(report.verified, true);
  assert.equal(await readFile(join(target, 'a.txt'), 'utf8'), 'payload');
  assert.equal(await verifyTreeCopy(source, target), await verifyTreeCopy(source, source));
  await writeFile(join(target, 'a.txt'), 'tampered');
  await assert.rejects(() => verifyTreeCopy(source, target), /integrity verification/);
});
