#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NpmBackend } from '../src/backends/npm.mjs';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 9)) {
  throw new Error(`acceptance requires Node.js 24.9+, running ${process.versions.node}`);
}
const home = resolve(process.env.ACCEPTANCE_HOME || '.acceptance/home');
const resultFile = resolve(process.env.ACCEPTANCE_RESULT || '.acceptance/real-staging-result.json');
const backend = new NpmBackend({
  home,
  profileName: 'web',
  timeoutMs: 120000,
  installTimeoutMs: 600000,
  stagingReadyMs: 5000,
});

const [release] = await backend.check('stable');
process.stdout.write(`release ${release.version} ${release.dist.integrity.slice(0, 20)}\n`);
const staged = await backend.prepare(
  { targetCore: release.version, items: [] },
  { onProgress: (progress) => process.stdout.write(`${progress.percent}% ${progress.stage}\n`) },
);
const health = await backend.stagingHealth(staged.path, {
  home: staged.home,
  plan: staged.plan,
});
const report = {
  node: process.versions.node,
  release: { version: release.version, integrity: release.dist.integrity },
  staging: { id: staged.id, path: staged.path },
  health,
};
await mkdir(resolve(resultFile, '..'), { recursive: true });
await writeFile(resultFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!health.ok) process.exitCode = 1;
