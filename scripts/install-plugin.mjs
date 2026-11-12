import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { findDesktopExe } from '../plugin/lib/plan.mjs';
import {
  assertInside,
  assertSafeProfileName,
  backupCandidatePaths,
  resolvePluginDestination,
} from './install-plugin-lib.mjs';

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
const nodeModules = join(profileDir, 'node_modules');

if (!existsSync(packageFile)) {
  console.error(`plugin package not found: ${packageFile}`);
  process.exit(2);
}
const pkg = JSON.parse(await readFile(packageFile, 'utf8'));

let destination;
try {
  // The package name is used in a recursive cleanup path below. Never accept an
  // arbitrary manifest name or a path that escapes the profile's node_modules.
  assertSafeProfileName(profile);
  destination = resolvePluginDestination(profileDir, pkg.name);
  assertInside(nodeModules, destination);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

async function findCli() {
  const explicit = get('cli', process.env.DSH_CLI);
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    'C:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ];
  const desktop = await findDesktopExe().catch(() => null);
  if (desktop) {
    const custom = join(dirname(desktop), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (existsSync(custom)) return custom;
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const cli = await findCli();
if (!cli) {
  console.error('dsh CLI not found; pass --cli <path to dsh.cmd>');
  process.exit(2);
}

const defaultHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const allowRunning = args.includes('--allow-running');
const isolatedHome = resolve(home) !== resolve(defaultHome);
if (allowRunning && !isolatedHome) {
  console.error('--allow-running requires an explicit isolated --home');
  process.exit(2);
}

try {
  if (allowRunning && isolatedHome) {
    console.log(`isolated home ${home}; skipping global Desktop process check`);
  } else {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$p=Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue; if($p){'running'}",
    ], { encoding: 'utf8' }).trim();
    if (output === 'running') {
      console.error('DeepSeek Harness is running. Quit it completely before reinstalling the plugin.');
      process.exit(3);
    }
  }
} catch {
  // Process probing is best-effort; the dsh CLI will fail with its own lock error.
}

const suffix = `${process.pid}-${Date.now()}`;
const destinationBackup = `${destination}.dsh-install-backup-${suffix}`;
const backupCandidates = backupCandidatePaths(nodeModules, basename(destinationBackup));
const profileFiles = ['package.json', 'pnpm-lock.yaml', 'package-lock.json'];
const destinationOriginallyExisted = existsSync(destination);
let profileBackup = '';
let destinationMoved = false;
let profileBackedUp = false;
let installAttempted = false;
const backedUpProfileFiles = new Set();

function findBackup() {
  return backupCandidates.find((candidate) => existsSync(candidate)) || null;
}

async function removeBackupPaths() {
  for (const candidate of backupCandidates) {
    await rm(candidate, { recursive: true, force: true }).catch(() => {});
  }
}

async function backupProfileFiles() {
  profileBackup = await mkdtemp(join(tmpdir(), 'dsh-plugin-install-'));
  for (const name of profileFiles) {
    const source = join(profileDir, name);
    if (existsSync(source)) {
      await copyFile(source, join(profileBackup, name));
      backedUpProfileFiles.add(name);
    }
  }
  profileBackedUp = true;
}

async function restore() {
  if (destinationMoved) {
    const backup = findBackup();
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    if (backup) {
      await rename(backup, destination).catch(() => {});
    } else {
      console.error('previous plugin backup was not found; keeping the installed directory');
    }
  } else if (installAttempted && !destinationOriginallyExisted) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
  }
  if (profileBackedUp) {
    for (const name of profileFiles) {
      const backup = join(profileBackup, name);
      if (backedUpProfileFiles.has(name) && existsSync(backup)) {
        await copyFile(backup, join(profileDir, name)).catch(() => {});
      } else if (name !== 'package.json') {
        await rm(join(profileDir, name), { force: true }).catch(() => {});
      }
    }
  }
}

try {
  await mkdir(nodeModules, { recursive: true });
  await backupProfileFiles();
  if (existsSync(destination)) {
    await rename(destination, destinationBackup);
    destinationMoved = true;
    console.log(`backed up stale ${destination}`);
  }

  installAttempted = true;
  const installScript = [
    '$ErrorActionPreference="Stop"',
    '& $env:DSH_INSTALL_CLI plugin --profile $env:DSH_INSTALL_PROFILE add ("file:" + $env:DSH_INSTALL_PLUGIN_DIR)',
    'exit $LASTEXITCODE',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    installScript,
  ], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_INSTALL_CLI: cli,
      DSH_INSTALL_PROFILE: profile,
      DSH_INSTALL_PLUGIN_DIR: pluginDir,
    },
  });
  if (result.status !== 0) {
    await restore();
    console.error(`dsh plugin add failed with exit code ${result.status}; previous installation restored`);
    process.exit(result.status || 1);
  }

  const installedFile = join(destination, 'package.json');
  const installed = existsSync(installedFile)
    ? JSON.parse(await readFile(installedFile, 'utf8'))
    : null;
  if (!installed || installed.name !== pkg.name) {
    await restore();
    console.error('dsh plugin add reported success but the installed package is missing or invalid');
    process.exit(1);
  }

  if (destinationMoved) await removeBackupPaths();
  await rm(profileBackup, { recursive: true, force: true }).catch(() => {});
  console.log(`installed ${pkg.name}@${installed.version || pkg.version} into ${profileDir}`);
  console.log('Restart DeepSeek Harness, then open Settings → 一键更新.');
} catch (error) {
  await restore();
  console.error(`plugin installation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
