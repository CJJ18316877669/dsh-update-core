import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoServer } from '../src/local-server.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForState(base, token, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}api/state`, {
      headers: { 'x-dsh-update-token': token },
    });
    const state = await response.json();
    if (expected.includes(state.state)) return state;
    await pause(20);
  }
  throw new Error(`state did not become ${expected.join('|')}`);
}

function post(base, token, path = 'api/check', body = {}, extra = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-update-token': token,
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

async function server(t) {
  const app = await createDemoServer({ delayMs: 2 });
  t.after(() => app.close());
  const html = await (await fetch(app.url)).text();
  const token = /<meta name="dsh-update-token" content="([^"]+)">/.exec(html)?.[1];
  assert.ok(token);
  return { app, base: app.url, token, html };
}

test('local server: same-origin shell injects a token and enforces CSRF/origin/content-type', async (t) => {
  const { base, token, html } = await server(t);
  assert.ok(!html.includes('__DSH_UPDATE_TOKEN__'));
  const response = await fetch(base);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await post(base, '')).status, 403);
  assert.equal((await post(base, token, 'api/check', {}, { origin: 'https://evil.example' })).status, 403);
  const wrongType = await fetch(`${base}api/check`, {
    method: 'POST',
    headers: { 'x-dsh-update-token': token, 'content-type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);
});

test('local server: check, start, rollback and partial confirmation use the real orchestrator', async (t) => {
  const { base, token } = await server(t);
  assert.equal((await post(base, token, 'api/check')).status, 202);
  const available = await waitForState(base, token, ['available']);
  assert.equal(available.plan.targetCore, '0.2.3');

  assert.equal((await post(base, token, 'api/start', { confirm: true })).status, 202);
  const succeeded = await waitForState(base, token, ['succeeded']);
  assert.equal(succeeded.result.version, '0.2.3');

  assert.equal((await post(base, token, 'api/rollback')).status, 202);
  const rolled = await waitForState(base, token, ['rolled-back']);
  assert.equal(rolled.currentVersion, '0.2.2-rc.1');

  const reset = await post(base, token, 'api/demo/reset', { scenario: 'partial' });
  assert.equal(reset.status, 200);
  await post(base, token, 'api/check');
  const risky = await waitForState(base, token, ['available-incompatible']);
  assert.equal(risky.plan.disables, 2);
  assert.equal((await post(base, token, 'api/start', { confirm: false })).status, 422);
  assert.equal((await post(base, token, 'api/start', { confirm: true })).status, 202);
  const partial = await waitForState(base, token, ['succeeded']);
  assert.equal(partial.result.disables, 2);
});

test('local server: fault injection is bounded to known values and cleared after one run', async (t) => {
  const { base, token } = await server(t);
  assert.equal((await post(base, token, 'api/demo/fault', { fault: 'download' })).status, 200);
  assert.equal((await post(base, token, 'api/demo/fault', { fault: 'arbitrary' })).status, 400);
  await post(base, token, 'api/check');
  await waitForState(base, token, ['available']);
  await post(base, token, 'api/start', { confirm: true });
  const failed = await waitForState(base, token, ['failed']);
  assert.equal(failed.error.code, 'UPD-401');
  await post(base, token, 'api/check');
  await waitForState(base, token, ['available']);
  await post(base, token, 'api/start', { confirm: true });
  const succeeded = await waitForState(base, token, ['succeeded']);
  assert.equal(succeeded.state, 'succeeded');
});

test('local server: SSE sends an immediate snapshot and state updates', async (t) => {
  const { base, token } = await server(t);
  const controller = new AbortController();
  const response = await fetch(`${base}api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (fragment) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !buffer.includes(fragment)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  };
  assert.match(await readUntil('"live":true'), /"state":"idle"/);
  await post(base, token, 'api/check');
  assert.match(await readUntil('"state":"available"'), /"type":"state"/);
  controller.abort();
});
