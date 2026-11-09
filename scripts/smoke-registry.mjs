#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NpmBackend, verifyIntegrity } from '../src/backends/npm.mjs';

const home = await mkdtemp(join(tmpdir(), 'dsh-registry-smoke-'));
try {
  const backend = new NpmBackend({ home, timeoutMs: 30000 });
  let release;
  let runtimeBlocked = null;
  try {
    [release] = await backend.check('stable');
  } catch (error) {
    if (error.code !== 'UPD-702') throw error;
    runtimeBlocked = error.message;
    const packument = await backend.fetchPackument(backend.packageName);
    const version = packument['dist-tags'].latest;
    release = {
      version,
      dist: {
        tarball: packument.versions[version].dist.tarball,
        integrity: packument.versions[version].dist.integrity,
      },
    };
  }
  const tarball = await backend.downloadTarball(release);
  if (!verifyIntegrity(tarball, release.dist.integrity)) {
    throw new Error('downloaded tarball failed SRI verification');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: release.version,
    bytes: tarball.length,
    integrity: release.dist.integrity.slice(0, 16),
    runtimeBlocked,
  }, null, 2)}\n`);
} finally {
  await rm(home, { recursive: true, force: true });
}
