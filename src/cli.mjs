#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateJournal } from './journal.mjs';
import { Watchdog } from './watchdog.mjs';
import { isUpdateError } from './errors.mjs';
import { DEMO_SCENARIOS, createDemoRuntime } from './demo-runtime.mjs';
import { createDemoServer } from './local-server.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else args[key] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function printState(state, i18n) {
  const line = `[${state.state}] ${state.progress.percent}% ${state.progress.stage || ''}`.trim();
  process.stdout.write(`${line}\n`);
  if (state.state === 'succeeded') {
    const disables = state.result && state.result.disables ? state.result.disables : 0;
    if (disables > 0) {
      process.stdout.write(`${i18n.t('message.partial', { version: state.currentVersion, count: disables })}\n`);
    } else {
      process.stdout.write(`${i18n.t('message.success', { version: state.currentVersion })}\n`);
    }
  }
  if (state.state === 'rolled-back') {
    process.stdout.write(`${i18n.t('message.rolled-back', { version: state.currentVersion })}\n`);
  }
  if (state.state === 'safe-mode') {
    process.stdout.write(`${i18n.t('message.safe-mode')}\n`);
  }
  if (state.state === 'blocked') {
    process.stdout.write(`${i18n.t('message.blocked')}\n`);
  }
}

const SCENARIOS = DEMO_SCENARIOS;

async function runDemo(args) {
  const scenario = typeof args.scenario === 'string' ? args.scenario : 'success';
  if (!SCENARIOS.has(scenario)) {
    process.stderr.write(`unknown scenario: ${scenario}\n`);
    usage();
    return 2;
  }
  const locale = typeof args.lang === 'string' ? args.lang : 'zh-CN';
  const home = typeof args.home === 'string' ? args.home : await mkdtemp(join(tmpdir(), 'dsh-update-'));
  const delayMs = args.fast ? 0 : Number(args.delayMs || 30);
  const runtime = createDemoRuntime({ home, scenario, delayMs, locale });
  const { i18n, telemetry, journal, orchestrator } = runtime;

  process.stdout.write(`home: ${home}\nscenario: ${scenario}\nlocale: ${i18n.locale}\n`);
  const states = [];
  const unsubscribe = orchestrator.subscribe((state) => {
    if (states[states.length - 1] !== state.state) {
      states.push(state.state);
      printState(state, i18n);
    }
  });

  try {
    const checked = await orchestrator.check({ manual: true });
    if (checked.state === 'up-to-date') {
      process.stdout.write(`${i18n.t('message.up-to-date', { version: checked.currentVersion })}\n`);
      return 0;
    }
    if (checked.state === 'blocked') {
      return 2;
    }

    if (scenario === 'cancel') {
      const pending = orchestrator.start({ confirm: true }).catch((error) => error);
      setTimeout(() => { orchestrator.cancel(); }, Math.max(5, delayMs));
      const outcome = await pending;
      const final = orchestrator.getState();
      if (final.state === 'succeeded') {
        process.stdout.write(`${i18n.t('message.success', { version: final.currentVersion })}\n`);
        return 0;
      }
      if (final.result && final.result.cancelled) {
        process.stdout.write(`${i18n.t('message.cancelled')}\n`);
        return 0;
      }
      if (outcome instanceof Error) {
        process.stdout.write(`error: ${outcome.message}\n`);
      }
      return 1;
    }

    await orchestrator.start({ confirm: true });
    if (orchestrator.getState().state === 'succeeded') {
      const j = await journal.read();
      process.stdout.write(`journal: ${journal.path} (${j ? j.state : 'none'})\n`);
      process.stdout.write(`events: ${telemetry.sink ? telemetry.sink.events.length : 0}\n`);
      return 0;
    }
    return 1;
  } catch (error) {
    const state = orchestrator.getState();
    if (isUpdateError(error)) {
      const code = state.state === 'safe-mode' && state.error ? state.error.code : error.code;
      process.stdout.write(`${code} ${i18n.error(code)}\n`);
    } else {
      process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.stdout.write(`final: ${state.state}\n`);
    return state.state === 'safe-mode' ? 3 : 1;
  } finally {
    unsubscribe();
  }
}

async function runStatus(args) {
  const home = typeof args.home === 'string' ? args.home : join(process.cwd(), '.dsh-demo');
  const journal = new UpdateJournal({ home });
  const watchdog = new Watchdog({ home });
  const j = await journal.read();
  const w = await watchdog.read();
  process.stdout.write(`${JSON.stringify({ home, journal: j, watchdog: w }, null, 2)}\n`);
  return 0;
}

async function runUi(args) {
  const scenario = typeof args.scenario === 'string' ? args.scenario : 'success';
  if (!DEMO_SCENARIOS.has(scenario) || scenario === 'cancel') {
    process.stderr.write(`unsupported UI scenario: ${scenario}\n`);
    return 2;
  }
  const port = args.port === undefined ? 0 : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('invalid --port\n');
    return 2;
  }
  const app = await createDemoServer({ port, scenario });
  process.stdout.write(`Live prototype: ${app.url}\nPress Ctrl+C to stop.\n`);
  await new Promise((resolvePromise) => {
    process.once('SIGINT', resolvePromise);
    process.once('SIGTERM', resolvePromise);
  });
  await app.close();
  return 0;
}

function usage() {
  process.stdout.write([
    'Usage:',
    '  node src/cli.mjs demo [--scenario success|partial|blocked|rollback|safe|download-fail|cancel] [--lang zh-CN] [--home DIR] [--fast]',
    '  node src/cli.mjs ui [--scenario success|partial|blocked|rollback|safe|download-fail] [--port 0]',
    '  node src/cli.mjs status [--home DIR]',
    '',
  ].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === 'help' || args.help) {
    usage();
    return 0;
  }
  if (command === 'demo') return runDemo(args);
  if (command === 'ui') return runUi(args);
  if (command === 'status') return runStatus(args);
  usage();
  return 2;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
