import { join } from 'node:path';
import { UpdateJournal } from './journal.mjs';
import { Watchdog } from './watchdog.mjs';
import { PluginGate } from './plugin-gate.mjs';
import { UpdateOrchestrator } from './orchestrator.mjs';
import { FakeBackend } from './backends/fake.mjs';
import { I18n } from './i18n.mjs';
import { Telemetry, MemorySink } from './telemetry.mjs';

export const DEMO_SCENARIOS = new Set([
  'success', 'partial', 'blocked', 'rollback', 'safe', 'download-fail', 'cancel',
]);

function plugin(name, version, engines, extra = {}) {
  return {
    name,
    version,
    kind: extra.kind || 'plugin',
    protected: extra.protected || false,
    spec: extra.spec || 'registry',
    manifest: engines === null ? {} : { engines: { dsh: engines } },
  };
}

export function scenarioBackend(scenario, delayMs = 0) {
  if (scenario === 'partial') {
    return new FakeBackend({
      delayMs,
      plugins: [
        plugin('dsh-plugin-office', '1.4.2', '>=0.2.0'),
        plugin('dsh-plugin-git-review', '0.9.1', '>=0.2.0'),
        plugin('dsh-plugin-foo', '1.2.0', '>=0.3.0'),
        plugin('dsh-plugin-bar', '0.4.1', '>=0.3.0'),
        plugin('@deepseek-ai/dsh-tool-terminal', '0.2.2-rc.1', '>=0.2.0', { kind: 'core', protected: true }),
      ],
      available: {
        'dsh-plugin-office': [{ version: '1.4.2', manifest: { engines: { dsh: '>=0.2.0' } } }],
        'dsh-plugin-git-review': [
          { version: '0.9.1', manifest: { engines: { dsh: '>=0.2.0' } } },
          { version: '1.0.0', manifest: { engines: { dsh: '>=0.2.0' } } },
        ],
        'dsh-plugin-foo': [],
        'dsh-plugin-bar': [],
        '@deepseek-ai/dsh-tool-terminal': [{ version: '0.2.3', manifest: { engines: { dsh: '>=0.2.0' } } }],
      },
    });
  }
  if (scenario === 'blocked') {
    return new FakeBackend({
      delayMs,
      plugins: [
        plugin('dsh-plugin-office', '1.4.2', '>=0.2.0'),
        plugin('@deepseek-ai/dsh-tool-terminal', '0.2.2-rc.1', '>=0.3.0', { kind: 'core', protected: true }),
      ],
      available: {
        'dsh-plugin-office': [{ version: '1.4.2', manifest: { engines: { dsh: '>=0.2.0' } } }],
        '@deepseek-ai/dsh-tool-terminal': [],
      },
    });
  }
  if (scenario === 'rollback') return new FakeBackend({ delayMs, failAt: ['health'] });
  if (scenario === 'safe') return new FakeBackend({ delayMs, failAt: ['health', 'rollback', 'snapshot'] });
  if (scenario === 'download-fail') return new FakeBackend({ delayMs, failAt: ['download'] });
  if (scenario === 'cancel') return new FakeBackend({ delayMs: delayMs || 40 });
  return new FakeBackend({ delayMs });
}

export function createDemoRuntime({ home, scenario = 'success', delayMs = 20, locale = 'zh-CN' } = {}) {
  if (!home) throw new TypeError('demo runtime requires home');
  if (!DEMO_SCENARIOS.has(scenario)) throw new ValueError(`unknown scenario: ${scenario}`);
  const i18n = new I18n(locale);
  const backend = scenarioBackend(scenario, delayMs);
  const journal = new UpdateJournal({ home });
  const watchdog = new Watchdog({ home });
  const telemetry = new Telemetry({
    sink: new MemorySink(),
    home,
    sampleRates: { 'update.stage': 1 },
  });
  const gate = new PluginGate();
  const orchestrator = new UpdateOrchestrator({
    backend,
    gate,
    journal,
    watchdog,
    telemetry,
    i18n,
    home,
    channel: 'stable',
    logger: { info() {}, warn() {}, error() {} },
  });
  return {
    home,
    scenario,
    i18n,
    backend,
    journal,
    watchdog,
    telemetry,
    gate,
    orchestrator,
    journalPath: journal.path,
    statePath: join(home, 'updates'),
  };
}

class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}
