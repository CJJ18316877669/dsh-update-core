import { writeFile } from 'node:fs/promises';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const resultPath = arg('result');
const recovery = arg('recover-only') === '1';
const crash = arg('fake-crash') === '1';
const startedAt = new Date().toISOString();

const state = recovery
  ? {
    state: 'rolled-back',
    message: 'fake recovery complete',
    coreMutated: true,
    profileMutated: true,
    rolledBack: true,
    appHealthy: true,
    startedAt,
  }
  : crash
    ? {
      state: 'installing-core',
      message: 'fake helper crashed',
      coreMutated: true,
      profileMutated: true,
      rolledBack: false,
      startedAt,
    }
    : {
      state: 'succeeded',
      message: 'fake helper succeeded',
      coreMutated: false,
      profileMutated: false,
      startedAt,
    };

await writeFile(resultPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
process.exit(crash ? 3 : 0);
