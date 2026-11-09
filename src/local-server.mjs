import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoRuntime, DEMO_SCENARIOS } from './demo-runtime.mjs';

const MAX_BODY = 4096;
const HOST = '127.0.0.1';
const ALLOWED_SCENARIOS = new Set([...DEMO_SCENARIOS].filter((name) => name !== 'cancel'));
const ALLOWED_FAULTS = new Set(['none', 'check', 'download', 'health', 'rollback-fail']);

function safeError(error) {
  if (!error) return null;
  return {
    code: typeof error.code === 'string' ? error.code : 'UPD-501',
    stage: error.stage,
    retryable: error.retryable === true,
    message: typeof error.message === 'string' ? error.message : 'update failed',
  };
}

function safeState(state) {
  const plan = state.plan ? {
    targetCore: state.plan.targetCore,
    updates: state.plan.updates,
    keeps: state.plan.keeps,
    disables: state.plan.disables,
    blocks: state.plan.blocks,
    manuals: state.plan.manuals,
    items: state.plan.items.map((item) => ({
      name: item.name,
      from: item.from,
      to: item.to,
      core: item.core === true,
      verify: item.verify === true,
      action: item.action,
    })),
  } : null;
  return {
    state: state.state,
    channel: state.channel,
    currentVersion: state.currentVersion,
    targetVersion: state.targetVersion,
    plan,
    progress: state.progress,
    result: state.result,
    error: state.error ? safeError(state.error) : null,
    updatedAt: state.updatedAt,
  };
}

async function readBody(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    const error = new Error('content-type must be application/json');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch {
    const error = new Error('invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function sendJson(res, status, value) {
  const payload = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

class DemoSession {
  constructor(options) {
    this.html = options.html;
    this.token = options.token;
    this.scenario = options.scenario;
    this.locale = options.locale || 'zh-CN';
    this.delayMs = options.delayMs ?? 20;
    this.seq = 0;
    this.listeners = new Set();
    this.commandBusy = null;
    this.cleanupHomes = [];
    this.runtime = null;
  }

  async ensureReady() {
    const terminal = new Set([
      'idle', 'up-to-date', 'available', 'available-incompatible',
      'blocked', 'succeeded', 'rolled-back', 'failed', 'safe-mode',
    ]);
    while (this.commandBusy) {
      if (!terminal.has(this.runtime.orchestrator.getState().state)) {
        const error = new Error('an update command is running');
        error.status = 409;
        throw error;
      }
      await this.commandBusy;
    }
  }

  async reset(scenario = this.scenario) {
    if (!ALLOWED_SCENARIOS.has(scenario)) {
      const error = new Error('unknown demo scenario');
      error.status = 400;
      throw error;
    }
    await this.ensureReady();
    if (this.runtime) this.runtime.unsubscribe();
    if (this.runtime) await rm(this.runtime.home, { recursive: true, force: true }).catch(() => {});
    const home = await mkdtemp(join(tmpdir(), 'dsh-live-'));
    this.cleanupHomes.push(home);
    this.scenario = scenario;
    const runtime = createDemoRuntime({
      home,
      scenario,
      delayMs: this.delayMs,
      locale: this.locale,
    });
    this.runtime = runtime;
    runtime.unsubscribe = runtime.orchestrator.subscribe((state) => {
      this.publish({ type: 'state', state: safeState(state) });
    });
    this.publish({ type: 'reset', scenario });
    return runtime;
  }

  publish(event) {
    this.seq += 1;
    const payload = { ...event, seq: this.seq };
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        // A disconnected client is cleaned up by its request close handler.
      }
    }
  }

  async run(command, options = {}) {
    if (this.commandBusy) {
      const error = new Error('another command is running');
      error.status = 409;
      throw error;
    }
    const task = Promise.resolve().then(command).catch((error) => {
      this.publish({ type: 'error', error: safeError(error) });
    }).finally(() => {
      this.commandBusy = null;
      const backend = this.runtime?.backend;
      if (options.clearFaults && backend && backend.failAt) backend.failAt.clear();
    });
    this.commandBusy = task;
    await task;
  }

  snapshot() {
    return {
      ...safeState(this.runtime.orchestrator.getState()),
      seq: this.seq,
      live: true,
      scenario: this.scenario,
    };
  }

  withFault(fault) {
    if (!ALLOWED_FAULTS.has(fault)) {
      const error = new Error('unknown fault');
      error.status = 400;
      throw error;
    }
    const failAt = this.runtime.backend.failAt;
    if (!failAt) {
      const error = new Error('current backend cannot inject faults');
      error.status = 409;
      throw error;
    }
    failAt.clear();
    if (fault === 'rollback-fail') {
      for (const name of ['health', 'rollback', 'snapshot']) failAt.add(name);
    } else if (fault !== 'none') {
      failAt.add(fault);
    }
    this.publish({ type: 'fault', fault });
  }

  validateStart() {
    const state = this.runtime.orchestrator.getState();
    if (state.state === 'blocked' || (state.plan && state.plan.blocks > 0)) {
      const error = new Error('core plugin incompatible');
      error.status = 409;
      error.code = 'UPD-202';
      throw error;
    }
    if (state.plan && state.plan.disables > 0 && state.state === 'available-incompatible') {
      // The HTTP handler passes the explicit confirmation into start().
      return state.plan;
    }
    return state.plan;
  }
}

export async function createDemoServer(options = {}) {
  const htmlPath = options.htmlPath
    ? resolve(options.htmlPath)
    : fileURLToPath(new URL('../prototype.html', import.meta.url));
  const html = await readFile(htmlPath, 'utf8');
  const token = randomBytes(16).toString('hex');
  const session = new DemoSession({
    html,
    token,
    scenario: options.scenario || 'success',
    locale: options.locale,
    delayMs: options.delayMs,
  });
  await session.reset(session.scenario);
  let port = 0;
  let expectedHost = '';

  const allowedOrigin = (req) => {
    const origin = req.headers.origin;
    return origin === undefined || origin === `http://${expectedHost}`;
  };

  const authorized = (req) => req.headers['x-dsh-update-token'] === token;

  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== expectedHost) {
        return sendJson(res, 421, { error: 'invalid host' });
      }
      if (!allowedOrigin(req)) return sendJson(res, 403, { error: 'invalid origin' });
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/prototype.html')) {
        const body = html.replace('__DSH_UPDATE_TOKEN__', token);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(res, 200, session.snapshot());
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 1000\ndata: ${JSON.stringify({ ...session.snapshot(), type: 'state' })}\n\n`);
        const listener = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        session.listeners.add(listener);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          session.listeners.delete(listener);
        });
        return;
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not found' });
      }
      if (!authorized(req)) return sendJson(res, 403, { error: 'missing update token' });
      const body = await readBody(req);

      if (url.pathname === '/api/check') {
        await session.ensureReady();
        void session.run(() => session.runtime.orchestrator.check({ manual: true }));
        return sendJson(res, 202, { accepted: true });
      }
      if (url.pathname === '/api/start') {
        await session.ensureReady();
        const plan = session.validateStart();
        if (plan && plan.disables > 0 && body.confirm !== true) {
          return sendJson(res, 422, { error: 'confirmation required', code: 'UPD-201', disables: plan.disables });
        }
        void session.run(() => session.runtime.orchestrator.start({ confirm: body.confirm === true }), { clearFaults: true });
        return sendJson(res, 202, { accepted: true });
      }
      if (url.pathname === '/api/cancel') {
        const cancelled = await session.runtime.orchestrator.cancel();
        return sendJson(res, 200, { cancelled });
      }
      if (url.pathname === '/api/rollback') {
        await session.ensureReady();
        void session.run(() => session.runtime.orchestrator.rollback(), { clearFaults: true });
        return sendJson(res, 202, { accepted: true });
      }
      if (url.pathname === '/api/channel') {
        if (!['stable', 'nightly'].includes(body.channel)) {
          return sendJson(res, 400, { error: 'invalid channel' });
        }
        try {
          session.runtime.orchestrator.setChannel(body.channel);
          return sendJson(res, 200, session.snapshot());
        } catch (error) {
          return sendJson(res, 409, { error: safeError(error) });
        }
      }
      if (url.pathname === '/api/demo/fault') {
        session.withFault(body.fault);
        return sendJson(res, 200, { fault: body.fault });
      }
      if (url.pathname === '/api/demo/reset') {
        await session.reset(body.scenario);
        return sendJson(res, 200, session.snapshot());
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, { error: safeError(error), code: error.code });
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, HOST, () => resolvePromise());
  });
  port = server.address().port;
  expectedHost = `${HOST}:${port}`;
  const url = `http://${expectedHost}/`;
  return {
    server,
    url,
    session,
    async close() {
      for (const listener of session.listeners) listener({ type: 'closed' });
      session.listeners.clear();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
      for (const home of session.cleanupHomes) {
        await rm(home, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
