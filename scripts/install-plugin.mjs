import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const home = get('home', process.env.DSH_HOME || join(homedir(), '.dsh'));
const profile = get('profile', 'desktop');
const pluginDir = resolve(get('plugin', join(process.cwd(), 'plugin')));
const packageFile = join(pluginDir, 'package.json');
const profileDir = join(home, 'profiles', profile);

if (!existsSync(packageFile)) {
  console.error(`plugin package not found: ${packageFile}`);
  process.exit(2);
}
const pkg = JSON.parse(await readFile(packageFile, 'utf8'));

function findCli() {
  const explicit = get('cli', process.env.DSH_CLI);
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    'C:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const cli = findCli();
if (!cli) {
  console.error('dsh CLI not found; pass --cli <path to dsh.cmd>');
  process.exit(2);
}

try {
  const output = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "$p=Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue; if($p){'running'}",
  ], { encoding: 'utf8' }).trim();
  if (output === 'running') {
    console.error('DeepSeek Harness is running. Quit it completely before reinstalling the plugin.');
    process.exit(3);
  }
} catch {
  // Process probing is best-effort; the dsh CLI will fail with its own lock error.
}

const destination = join(profileDir, 'node_modules', pkg.name);
if (existsSync(destination)) {
  await rm(destination, { recursive: true, force: true });
  console.log(`removed stale ${destination}`);
}

const command = `"${cli}" plugin --profile "${profile}" add "file:${pluginDir}"`;
const result = spawnSync(command, {
  stdio: 'inherit',
  shell: true,
  windowsHide: true,
});
if (result.status !== 0) {
  console.error(`dsh plugin add failed with exit code ${result.status}`);
  process.exit(result.status || 1);
}

const installedFile = join(destination, 'package.json');
const installed = existsSync(installedFile)
  ? JSON.parse(await readFile(installedFile, 'utf8'))
  : null;
console.log(`installed ${pkg.name}@${installed?.version || pkg.version} into ${profileDir}`);
console.log('Restart DeepSeek Harness, then open Settings → 一键更新.');
