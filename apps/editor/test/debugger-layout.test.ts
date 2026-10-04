import { test } from "node:test";
import assert from "node:assert/strict";
import { DEBUGGER_PANELS, debuggerLayoutDefaults } from "../src/debugger-layout.js";

test("debugger panels start inside the game view, tools on the right", () => {
  const vp = { width: 836, height: 600 };
  const l = debuggerLayoutDefaults(vp);
  assert.equal(l.hidden, false);
  assert.deepEqual(Object.keys(l.panels), [...DEBUGGER_PANELS]);
  for (const p of Object.values(l.panels)) {
    assert.ok(p.x >= 0 && p.x + p.w <= vp.width, `x ${p.x} w ${p.w}`);
    assert.ok(p.y >= 0 && p.y < vp.height);
  }
  assert.equal(l.panels.tools.x + l.panels.tools.w, vp.width - 12);
  assert.equal(l.panels.controls.open, false);
  // Status and performance don't overlap at the top left.
  assert.ok(l.panels.perf.y > l.panels.status.y + 100);
});

test("a view narrower than a panel keeps it at the margin", () => {
  const l = debuggerLayoutDefaults({ width: 200, height: 100 });
  assert.equal(l.panels.tools.x, 12);
  assert.equal(l.panels.controls.y, 12);
});
