// Cross-process determinism: the same physics scene stepped in FRESH processes
// must produce byte-identical float fingerprints, with the single-threaded job
// system and with a thread pool.
//
// Jolt is deterministic given the same binary and the same mutating-API call
// order (Jolt Docs/Architecture.md, "Deterministic Simulation"). This test pins
// that property for our build: insertion order is ascending wire id, the scene is
// fully specified (no Math.random, no Date), and the fingerprint is exact f32 bits,
// not rounded text. It covers dynamic bodies and every body of the rigs.

'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const child = path.join(__dirname, 'determinism-child.js');

// 6 dynamic bodies and 32 rig bodies (2 full at 11 each, 2 light at 5 each), 13
// f32 words per body: position, rotation, linear and angular velocity.
const DYNAMIC_BODIES = 6;
const RIG_BODIES = 2 * 11 + 2 * 5;

function probe(threads) {
  const args = threads === undefined ? [] : [String(threads)];
  return execFileSync(process.execPath, [child, ...args], {
    encoding: 'utf8',
    timeout: 120000,
  }).trim();
}

test('single thread: same scene in 3 fresh processes => identical fingerprints', () => {
  const a = probe(0);
  const b = probe(0);
  const c = probe(0);
  assert.ok(a.startsWith(`bodies=8 rigBodies=${RIG_BODIES} fp=`), `unexpected probe output: ${a}`);
  assert.strictEqual(b, a, 'process 2 diverged from process 1');
  assert.strictEqual(c, a, 'process 3 diverged from process 1');
});

test('thread pool of 4: same scene in 3 fresh processes => identical fingerprints', () => {
  const a = probe(4);
  const b = probe(4);
  const c = probe(4);
  assert.ok(a.startsWith(`bodies=8 rigBodies=${RIG_BODIES} fp=`), `unexpected probe output: ${a}`);
  assert.strictEqual(b, a, 'thread pool process 2 diverged from process 1');
  assert.strictEqual(c, a, 'thread pool process 3 diverged from process 1');
});

test('0 and 4 threads give the same bits on this scene', () => {
  assert.strictEqual(probe(4), probe(0), 'the thread pool changed the bits of the single-threaded run');
});

test('fingerprint is a full-precision hex digest covering rigs, not rounded text', () => {
  const out = probe(0);
  const fp = out.split('fp=')[1];
  // Four dynamic sections and the rig section.
  assert.strictEqual(fp.split('|').length, 5);
  assert.ok(/^[0-9a-f|]+$/.test(fp), 'fingerprint must be hex only');
  const words = fp.replace(/\|/g, '').length / 8;
  assert.strictEqual(words, (DYNAMIC_BODIES + RIG_BODIES) * 13, `expected ${(DYNAMIC_BODIES + RIG_BODIES) * 13} f32 words, got ${words}`);
});
