#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('../test/', import.meta.url));
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => fileURLToPath(new URL(`../test/${name}`, import.meta.url)));
if (files.length === 0) throw new Error('no test files found');
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  windowsHide: true,
});
process.exitCode = result.status === null ? 1 : result.status;
