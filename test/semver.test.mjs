import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, parse, satisfies, parseRange, maxSatisfying, sortStableFirstDesc } from '../src/semver.mjs';

test('parse: strict semver, prerelease and build metadata', () => {
  assert.equal(parse('1.2.3').major, 1);
  assert.equal(parse('v1.2.3').patch, 3);
  assert.deepEqual(parse('1.2.3-rc.1').prerelease, ['rc', '1']);
  assert.equal(parse('1.2.3+build.5').prerelease.length, 0);
  assert.equal(parse('1.2'), null);
  assert.equal(parse('not-a-version'), null);
  assert.equal(parse('1.2.3.4'), null);
  assert.equal(parse('01.2.3'), null);
  assert.equal(parse('1.2.3-01'), null);
});

test('compare: prerelease ordering', () => {
  assert.equal(compare('1.0.0', '1.0.0'), 0);
  assert.equal(compare('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compare('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  assert.equal(compare('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compare('1.0.0-alpha.1', '1.0.0-beta'), -1);
  assert.equal(compare('2.0.0', '10.0.0'), -1);
  assert.throws(() => compare('bad', '1.0.0'), TypeError);
});

test('satisfies: caret, tilde, comparators and unions', () => {
  assert.equal(satisfies('0.2.3', '^0.2.0'), true);
  assert.equal(satisfies('0.3.0', '^0.2.0'), false);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.9.9', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.5.0', '>=1.2.0 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
  assert.equal(satisfies('3.1.0', '1.x || >=3.0.0'), true);
  assert.equal(satisfies('1.2.3', '1.2.3 - 1.5.0'), true);
  assert.equal(satisfies('1.5.1', '1.2.3 - 1.5.0'), false);
  assert.equal(satisfies('1.2.3', '*'), true);
  assert.equal(satisfies('1.2.3', ''), true);
  assert.equal(satisfies('1.5.0', '>= 1.2.0 < 2.0.0'), true);
  assert.equal(satisfies('2.1.0', '>= 1.2.0 < 2.0.0'), false);
  assert.equal(satisfies('1.2.9', '~ 1.2.3'), true);
});

test('satisfies: prerelease opt-in and invalid ranges', () => {
  assert.equal(satisfies('0.2.3-nightly.1', '>=0.2.0', { includePrerelease: true }), true);
  assert.equal(satisfies('0.2.3-nightly.1', '>=0.2.0', { includePrerelease: false }), false);
  assert.equal(satisfies('0.2.3-nightly.1', '>=0.2.3-nightly.0', { includePrerelease: false }), true);
  assert.equal(satisfies('1.2.3', 'not-a-range'), false);
  assert.equal(parseRange('not-a-range'), null);
});

test('maxSatisfying and stable-first sorting', () => {
  assert.equal(maxSatisfying(['1.0.0', '1.2.0', '2.0.0'], '^1.0.0'), '1.2.0');
  assert.deepEqual(
    sortStableFirstDesc(['1.0.0', '1.1.0-rc.1', '1.1.0']),
    ['1.1.0', '1.0.0', '1.1.0-rc.1'],
  );
});

test('satisfies: partial versions behave like ranges', () => {
  assert.equal(satisfies('1.2.9', '1.2'), true);
  assert.equal(satisfies('1.3.0', '1.2'), false);
  assert.equal(satisfies('1.9.9', '1'), true);
  assert.equal(satisfies('2.0.0', '1'), false);
  assert.equal(satisfies('1.2.9', '<=1.2'), true);
  assert.equal(satisfies('1.3.0', '<=1.2'), false);
  assert.equal(satisfies('1.2.1', '>1.2'), false);
  assert.equal(satisfies('1.3.0', '>1.2'), true);
  assert.equal(satisfies('2.0.0', '>1'), true);
  assert.equal(satisfies('1.9.9', '>1'), false);
  assert.equal(satisfies('1.9.9', '1.2 - 1.9'), true);
  assert.equal(satisfies('2.0.0', '1.2 - 1.9'), false);
  assert.equal(satisfies('01.2.3', '^1.0.0'), false);
});
