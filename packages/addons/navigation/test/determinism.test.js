// Cross-process determinism: the same bake + query in three FRESH
// processes must produce byte-identical fingerprints.
//
// The addon never uses frand() (the only randomness in the Recast/Detour
// pipeline is caller-supplied), so identical inputs must give identical
// outputs. This pins that property for our build.

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

test('same bake+query in 3 fresh processes => identical fingerprints', () => {
  const a = probe();
  const b = probe();
  const c = probe();
  assert.ok(a.startsWith('tiles=1 polys='), `unexpected probe output: ${a}`);
  assert.equal(a, b, 'process 2 diverged');
  assert.equal(a, c, 'process 3 diverged');
});
