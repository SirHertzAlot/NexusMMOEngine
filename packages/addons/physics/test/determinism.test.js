// Cross-process determinism: the same physics scene stepped in three
// FRESH processes must produce byte-identical float fingerprints.
//
// Jolt is deterministic given the same binary and the same
// mutating-API call order (Jolt Docs/Architecture.md). This test pins
// that property for our build: insertion order is ascending wire id,
// the scene is fully specified (no Math.random, no Date), and the
// fingerprint is exact f32 bits, not rounded text.

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const child = path.join(__dirname, 'determinism-child.js');

function probe() {
  return execFileSync(process.execPath, [child], {
    encoding: 'utf8',
    timeout: 120000,
  }).trim();
}

test('same scene in 3 fresh processes => identical fingerprints', () => {
  const a = probe();
  const b = probe();
  const c = probe();
  assert.ok(a.startsWith('bodies=8 fp='), `unexpected probe output: ${a}`);
  assert.strictEqual(b, a, 'process 2 diverged from process 1');
  assert.strictEqual(c, a, 'process 3 diverged from process 1');
});

test('fingerprint is a full-precision hex digest, not rounded text', () => {
  const out = probe();
  const fp = out.split('fp=')[1];
  // 6 dynamic bodies x (3 pos + 4 quat + 3 lin + 3 ang) f32 = 78 words
  assert.strictEqual(fp.split('|').length, 4);
  assert.ok(/^[0-9a-f|]+$/.test(fp), 'fingerprint must be hex only');
  const words = fp.replace(/\|/g, '').length / 8;
  assert.strictEqual(words, 78, `expected 78 f32 words, got ${words}`);
});
