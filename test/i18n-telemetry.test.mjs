import test from 'node:test';
import assert from 'node:assert/strict';
import { I18n, SUPPORTED_LOCALES, CORE_KEYS, CATALOGS, normalizeLocale } from '../src/i18n.mjs';
import { Telemetry, MemorySink, HttpSink, redact } from '../src/telemetry.mjs';
import { UpdateError, asUpdateError, isAbortError, AbortedError, INTERNAL_TO_PUBLIC } from '../src/errors.mjs';

test('i18n: all built-in locales cover core result keys', () => {
  assert.equal(SUPPORTED_LOCALES.length, 8);
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(CATALOGS[locale], `missing catalog ${locale}`);
    for (const key of CORE_KEYS) {
      assert.equal(typeof CATALOGS[locale][key], 'string', `${locale} missing ${key}`);
    }
  }
});

test('i18n: normalization, fallback and placeholders', () => {
  assert.equal(normalizeLocale('zh-cn'), 'zh-CN');
  assert.equal(normalizeLocale('en'), 'en-US');
  assert.equal(normalizeLocale('fr-CA'), 'fr-FR');
  assert.equal(normalizeLocale('xx-YY'), 'en-US');
  assert.equal(normalizeLocale(''), 'zh-CN');

  const zh = new I18n('zh-CN');
  assert.equal(zh.t('message.success', { version: '0.2.3' }), '已更新到 0.2.3。');
  assert.equal(zh.t('message.success'), '已更新到 {version}。');
  assert.equal(zh.t('missing.key'), 'missing.key');
  assert.match(new I18n('fr-FR').error('UPD-101'), /source de mise à jour/);
});

test('i18n: plural picks Intl categories and falls back to other', () => {
  const en = new I18n('en-US');
  assert.equal(en.plural('plugin.updated', 1), '1 plugin updated');
  assert.equal(en.plural('plugin.updated', 2), '2 plugins updated');
  assert.equal(new I18n('zh-CN').plural('plugin.disabled', 3), '3 个插件已禁用');
});

test('telemetry: redacts paths, emails, tokens and URL credentials', () => {
  const home = 'C:\\Users\\alice';
  const input = {
    path: 'C:\\Users\\alice\\profiles\\web',
    mac: '/Users/alice/Library/logs',
    linux: '/home/alice/.dsh/logs',
    email: 'alice@example.com',
    auth: 'Bearer abc.def.ghi',
    query: '?token=supersecret&x=1',
    url: 'https://alice:pw@example.com/tarball.tgz',
    nested: [{ password: 'hunter2' }],
  };
  const output = redact(input, { home });
  assert.equal(output.path, '<home>\\profiles\\web');
  assert.equal(output.mac, '/Users/<user>/Library/logs');
  assert.equal(output.linux, '/home/<user>/.dsh/logs');
  assert.equal(output.email, '<email>');
  assert.equal(output.auth, 'Bearer <redacted>');
  assert.match(output.query, /token=<redacted>/);
  assert.match(output.url, /\/\/<redacted>@example\.com/);
  assert.equal(output.nested[0].password, '<redacted>');
});

test('telemetry: handles cycles and depth limits', () => {
  const node = { name: 'x' };
  node.self = node;
  const output = redact(node);
  assert.equal(output.self, '<circular>');
  const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
  assert.equal(redact(deep).a.b.c.d.e.f.g, '<max-depth>');
});

test('telemetry: sampling, disabled mode and sink failure', () => {
  const sink = new MemorySink();
  let random = 0.4;
  const t = new Telemetry({ sink, sampleRates: { 'update.stage': 0.5 }, random: () => random });
  assert.equal(t.emit('update.stage', { stage: 'download' }), true);
  random = 0.9;
  assert.equal(t.emit('update.stage', { stage: 'verify' }), false);
  assert.equal(t.emit('update.succeeded', {}), true);
  assert.equal(sink.events.length, 2);

  const disabled = new Telemetry({ sink, enabled: false });
  assert.equal(disabled.emit('x', {}), false);

  const failing = new Telemetry({ sink: { write() { throw new Error('boom'); } } });
  assert.equal(failing.emit('x', {}), false);
  assert.equal(failing.failures, 1);
});

test('telemetry: HttpSink is opt-in, batches and drops failures without affecting update', async () => {
  let calls = 0;
  const disabled = new HttpSink({ url: 'https://telemetry.example/v1', fetchImpl: async () => { calls += 1; } });
  disabled.write({ event: 'x' });
  await disabled.flush();
  assert.equal(calls, 0);

  const bodies = [];
  const sink = new HttpSink({
    url: 'https://telemetry.example/v1',
    enabled: true,
    batchSize: 2,
    fetchImpl: async (url, request) => {
      calls += 1;
      bodies.push(JSON.parse(request.body));
      return { ok: true, status: 202 };
    },
  });
  const telemetry = new Telemetry({ sink, sampleRates: { 'update.stage': 1 } });
  telemetry.emit('update.started', { updates: 2, path: '/home/alice/.dsh' });
  telemetry.emit('update.succeeded', { durationMs: 10 });
  await sink.flush();
  assert.equal(calls, 1);
  assert.equal(bodies[0].events.length, 2);
  assert.equal(bodies[0].events[0].path, '/home/<user>/.dsh');

  const failing = new HttpSink({
    url: 'https://telemetry.example/v1',
    enabled: true,
    batchSize: 1,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(await failing.flush(), true);
  assert.equal(await failing.write({ event: 'x' }), false);
  assert.equal(failing.failures, 1);
  assert.equal(failing.dropped, 1);
});

test('telemetry: HttpSink rejects insecure endpoints and credentials', () => {
  assert.throws(() => new HttpSink({ url: 'http://telemetry.example/v1' }), /https/);
  assert.throws(() => new HttpSink({ url: 'https://user:pw@telemetry.example/v1' }), /credentials/);
  assert.throws(() => new HttpSink({ url: 'not a url' }), /valid url/);
});

test('errors: spec fields, wrappers and abort detection', () => {
  const error = new UpdateError('UPD-301');
  assert.equal(error.stage, 'preflight');
  assert.equal(error.retryable, true);
  assert.deepEqual(Object.keys(error.toJSON()).sort(), ['code', 'details', 'message', 'name', 'retryable', 'stage']);

  const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' });
  assert.equal(asUpdateError(enospc).code, 'UPD-301');
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  assert.equal(asUpdateError(eacces).code, 'UPD-302');
  const unknown = asUpdateError(new Error('boom'));
  assert.equal(unknown.code, 'UPD-501');
  assert.equal(unknown.cause.message, 'boom');

  assert.equal(isAbortError(new AbortedError()), true);
  assert.equal(isAbortError(new UpdateError('UPD-401')), false);
  assert.equal(INTERNAL_TO_PUBLIC.E_NO_COMPATIBLE, 'UPD-202');
});
