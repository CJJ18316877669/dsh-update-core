#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDemoServer } from '../src/local-server.mjs';
import { killTree } from '../src/platform/process.mjs';

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if ([
          'Runtime.exceptionThrown', 'Log.entryAdded', 'Runtime.consoleAPICalled',
          'Network.requestWillBeSent', 'Network.responseReceived',
        ].includes(message.method)) {
          this.events.push(message);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() { this.socket.close(); }
}

async function waitFor(cdp, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await pause(100);
  }
  const diagnostic = await cdp.evaluate(`({
    devState: document.getElementById('devState')?.value,
    devMode: document.getElementById('devMode')?.textContent,
    title: document.querySelector('#updateCard h2')?.textContent,
    badge: document.getElementById('badge')?.textContent,
    toast: document.getElementById('toast')?.textContent,
    body: document.body.innerText.slice(0, 500),
    es: window.__esEvents,
    pageErrors: window.__pageErrors
  })`).catch(() => null);
  const apiProbe = await cdp.evaluate(`(() => {
    const token = document.querySelector('meta[name="dsh-update-token"]').content;
    return fetch('/api/check', {method:'POST', headers:{'content-type':'application/json','x-dsh-update-token':token}, body:'{}'})
      .then(async r => r.status + ' ' + await r.text());
  })()`).catch((error) => String(error));
  await pause(500);
  const stateAfterProbe = await cdp.evaluate("document.getElementById('devState')?.value").catch(() => null);
  throw new Error(`timeout waiting for: ${expression}\n${JSON.stringify({
    diagnostic,
    apiProbe,
    stateAfterProbe,
    events: cdp.events.slice(-30).map((event) => ({
      method: event.method,
      url: event.params?.request?.url,
      status: event.params?.response?.status,
      text: event.params?.entry?.text || event.params?.exceptionDetails?.text,
    })),
  }, null, 2)}`);
}

async function capture(cdp, path) {
  await cdp.evaluate("document.getElementById('toast').classList.remove('show')").catch(() => {});
  await pause(300);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  process.stdout.write(`captured ${path}\n`);
}

async function main() {
  const app = await createDemoServer({ delayMs: 12 });
  const debugPort = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'dsh-edge-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--window-size=1080,1100',
    app.url,
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    let target;
    for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
      await pause(100);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = targets.find((entry) => entry.type === 'page');
      } catch {
        // Edge has not opened the debugger yet.
      }
    }
    if (!target) throw new Error('Edge DevTools endpoint did not become ready');
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1080, height: 1100, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__esEvents = [];
        window.__pageErrors = [];
        addEventListener('error', (event) => window.__pageErrors.push(String(event.error && event.error.stack || event.message)));
        const NativeEventSource = EventSource;
        window.EventSource = class extends NativeEventSource {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', (event) => window.__esEvents.push(event.data.slice(0, 1000)));
            this.addEventListener('error', () => window.__esEvents.push('__SSE_ERROR__'));
          }
        };
      `,
    });
    await cdp.send('Page.navigate', { url: app.url });
    await waitFor(cdp, "document.getElementById('devMode')?.textContent === 'LIVE'");
    await waitFor(cdp, "document.getElementById('devState')?.value === 'available'");

    await capture(cdp, resolve('preview.png'));
    await cdp.evaluate("document.getElementById('primaryBtn').click()");
    await waitFor(cdp, "!document.getElementById('modal').hidden");
    await capture(cdp, resolve('preview-modal.png'));
    await cdp.evaluate("document.getElementById('confirmBtn').click()");
    await waitFor(cdp, "document.getElementById('devState')?.value === 'succeeded'", 12000);
    await capture(cdp, resolve('preview-success.png'));

    await app.session.reset('partial');
    await waitFor(cdp, "document.getElementById('devState')?.value === 'available-incompatible'", 8000);
    await capture(cdp, resolve('preview-incompatible.png'));
    await cdp.evaluate("document.getElementById('primaryBtn').click()");
    await waitFor(cdp, "!document.getElementById('modal').hidden");
    await capture(cdp, resolve('preview-modal-incompatible.png'));

    await cdp.evaluate("document.getElementById('closeModal').click()");
    await app.session.reset('rollback');
    await waitFor(cdp, "document.getElementById('devState')?.value === 'available'", 8000);
    await cdp.evaluate("document.getElementById('primaryBtn').click()");
    await cdp.evaluate("document.getElementById('confirmBtn').click()");
    await waitFor(cdp, "document.getElementById('devState')?.value === 'rolled-back'", 12000);
    await capture(cdp, resolve('preview-rolledback.png'));
  } finally {
    if (cdp) cdp.close();
    await killTree(edge, { graceMs: 300 }).catch(() => {});
    await app.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
