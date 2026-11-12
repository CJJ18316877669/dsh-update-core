import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAuthorizedRequest,
  isLoopbackAddress,
  mountRoutes,
  parseAllowedHost,
  PLUGIN_VERSION,
} from '../plugin/lib/index.js';
import { SerialJsonWriter } from '../plugin/lib/state-writer.mjs';
import { UpdateGate } from '../plugin/lib/gate.mjs';
import { writeJson } from '../plugin/lib/store.mjs';

function request(overrides = {}) {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:12345',
      'x-dsh-update-token': 'test-token',
    },
    ...overrides,
  };
}

test('plugin version: source constant matches package.json', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../plugin/package.json', import.meta.url), 'utf8'));
  assert.equal(PLUGIN_VERSION, packageJson.version);
});

test('plugin API security: loopback host, origin and token are all enforced', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.8'), false);
  assert.equal(parseAllowedHost('localhost:1234')?.hostname, 'localhost');
  assert.equal(parseAllowedHost('evil.example:1234'), null);
  assert.equal(isAuthorizedRequest(request(), 'test-token'), true);
  assert.equal(isAuthorizedRequest(request({ socket: { remoteAddress: '10.0.0.2' } }), 'test-token'), false);
  assert.equal(isAuthorizedRequest(request({ headers: { host: 'evil.example', 'x-dsh-update-token': 'test-token' } }), 'test-token'), false);
  assert.equal(isAuthorizedRequest(request({ headers: { ...request().headers, origin: 'https://evil.example' } }), 'test-token'), false);
  assert.equal(isAuthorizedRequest(request({ headers: { ...request().headers, origin: 'http://127.0.0.1:12345' } }), 'test-token'), true);
  assert.equal(isAuthorizedRequest(request({ headers: { host: '127.0.0.1:12345', 'x-dsh-update-token': 'wrong' } }), 'test-token'), false);
});

test('update gate: acquisition is synchronous and only the owner releases it', () => {
  const gate = new UpdateGate();
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false);
  assert.equal(gate.busy, true);
  gate.release();
  assert.equal(gate.tryAcquire(), true);
});

test('serial JSON writer: overlapping progress updates never corrupt the result file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-state-writer-'));
  const file = join(home, 'result.json');
  try {
    const writer = new SerialJsonWriter(file, writeJson);
    for (let index = 0; index < 40; index += 1) {
      void writer.write({ state: 'downloading-core', index, payload: 'x'.repeat(1024) });
    }
    await writer.flush();
    const result = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(result.index, 39);
    assert.equal(result.state, 'downloading-core');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function harness() {
  const routes = new Map();
  const server = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  return { routes, server };
}

function responseCapture() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

test('plugin settings page: inline script parses and includes the token placeholder', async () => {
  const html = await readFile(new URL('../plugin/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /name="dsh-update-token" content="__DSH_UPDATE_TOKEN__"/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script[1]));
});

test('plugin routes: page injects a token and write APIs reject unauthenticated or non-JSON requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-routes-'));
  const { routes, server } = harness();
  mountRoutes(server, { home, profile: 'desktop', autoCheckHours: 0, desktopExe: process.execPath });
  try {
    const page = responseCapture();
    await routes.get('/dsh-update/')({
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:12345' },
    }, page);
    assert.equal(page.status, 200);
    const token = (page.body.match(/name="dsh-update-token" content="([a-f0-9]+)"/) || [])[1];
    assert.ok(token && token.length >= 32);

    const denied = responseCapture();
    await routes.get('/dsh-update/api/update')({
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:12345', 'content-type': 'text/plain' },
    }, denied);
    assert.equal(denied.status, 403);

    const wrongType = responseCapture();
    await routes.get('/dsh-update/api/update')({
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: '127.0.0.1:12345',
        'x-dsh-update-token': token,
        'content-type': 'text/plain',
      },
    }, wrongType);
    assert.equal(wrongType.status, 415);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
