/**
 * StatusSystem: buffs and debuffs — stacking, refresh modes, modifiers,
 * DoT/HoT ticks, expiry, and cleansing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatusSystem } from "../src/status.js";

const HZ = 30;
const ticks = (ms: number): number => Math.round((ms / 1000) * HZ);

function setup(sinks?: { damage: Array<[number, number]>; heal: Array<[number, number]> }): StatusSystem {
  const s = new StatusSystem(
    HZ,
    (t, amount) => sinks?.damage.push([t, amount]),
    (t, amount) => sinks?.heal.push([t, amount]),
  );
  s.define({
    id: "rage",
    kind: "buff",
    durationMs: 10000,
    maxStacks: 1,
    refresh: "refresh",
    dispellable: false,
    mods: [{ stat: "power", mode: "mul", value: 0.2 }],
  });
  s.define({
    id: "poison",
    kind: "debuff",
    durationMs: 6000,
    maxStacks: 3,
    refresh: "accumulate",
    dispellable: true,
    mods: [{ stat: "speed", mode: "mul", value: -0.1 }],
    dot: { perSecond: 6, intervalMs: 1000 },
  });
  s.define({
    id: "regen",
    kind: "buff",
    durationMs: 4000,
    maxStacks: 1,
    refresh: "ignore",
    dispellable: true,
    mods: [],
    hot: { perSecond: 10, intervalMs: 1000 },
  });
  return s;
}

describe("StatusSystem", () => {
  it("a buff's multiplicative modifier combines per stack", () => {
    const s = setup();
    assert.deepEqual(s.modifier(1, "power"), { add: 0, mul: 1 });
    s.apply(1, "rage", 2, 10);
    assert.deepEqual(s.modifier(1, "power"), { add: 0, mul: 1.2 });
    // maxStacks 1 + refresh: re-applying restarts the duration, not the stacks.
    s.apply(1, "rage", 2, 20);
    assert.equal(s.active(1, 20)[0].stacks, 1);
    assert.equal(s.active(1, 20)[0].expiresIn, ticks(10000));
  });

  it("a debuff accumulates stacks to its cap and slows the target", () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.apply(1, "poison", 2, 10 + i);
    const m = s.modifier(1, "speed");
    assert.equal(m.mul, 0.9 * 0.9 * 0.9, "three stacks of -10% multiply");
    assert.equal(s.active(1, 10)[0].stacks, 3, "capped at maxStacks");
  });

  it("statuses expire and report their remaining time", () => {
    const s = setup();
    s.apply(1, "rage", 2, 10);
    assert.equal(s.active(1, 10)[0].expiresIn, ticks(10000));
    s.step(10 + ticks(10000) + 1);
    assert.deepEqual(s.active(1, 10 + ticks(10000) + 1), [], "expired");
    assert.deepEqual(s.modifier(1, "power"), { add: 0, mul: 1 }, "modifier gone with it");
  });

  it("DoT and HoT tick on their interval, scaled by stacks", () => {
    const sinks = { damage: [] as Array<[number, number]>, heal: [] as Array<[number, number]> };
    const s = setup(sinks);
    s.apply(1, "poison", 2, 10);
    s.apply(1, "poison", 2, 11); // 2 stacks
    s.apply(1, "regen", 1, 10);
    s.step(10 + ticks(1000));
    assert.equal(sinks.damage.length, 1);
    assert.equal(sinks.damage[0][0], 1);
    assert.ok(Math.abs(sinks.damage[0][1] - 12) < 1e-6, `2 stacks x 6 dps x 1s = 12, got ${sinks.damage[0][1]}`);
    assert.equal(sinks.heal.length, 1);
    assert.ok(Math.abs(sinks.heal[0][1] - 10) < 1e-6, `10 hps x 1s = 10, got ${sinks.heal[0][1]}`);
  });

  it("cleanse removes dispellable statuses and leaves the rest", () => {
    const s = setup();
    s.apply(1, "rage", 2, 10); // not dispellable
    s.apply(1, "poison", 2, 10); // dispellable
    const removed = s.cleanse(1, 10);
    assert.deepEqual(removed, ["poison"]);
    assert.deepEqual(
      s.active(1, 10).map((a) => a.id),
      ["rage"],
    );
  });

  it("unknown statuses are refused", () => {
    const s = setup();
    assert.equal(s.apply(1, "nope", 2, 10), false);
    assert.deepEqual(s.active(1, 10), []);
  });
});
