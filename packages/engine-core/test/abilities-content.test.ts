/**
 * The placeholder ability set (content/combat/abilities.json) run through
 * AbilitySystem at the 30 Hz tick: each value must behave as written.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AbilitySystem } from "../src/abilities.js";
import type { SimWorld } from "../src/world.js";

const HZ = 30;
const ticks = (ms: number): number => Math.round((ms / 1000) * HZ);
const simAt = (tick: number): SimWorld => ({ currentTick: tick }) as SimWorld;
const file = fileURLToPath(new URL("../../../../content/combat/abilities.json", import.meta.url));

type Def = { id: string; gcdMs: number; cooldownMs: number; castMs: number };
const defs: Def[] = (JSON.parse(readFileSync(file, "utf8")) as { abilities: Def[] }).abilities;

describe("content/combat/abilities.json (placeholder starter set)", () => {
  it("names unique ids and whole-tick timings", () => {
    const ids = defs.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const d of defs) {
      assert.ok(Number.isInteger(ticks(d.gcdMs)) && ticks(d.gcdMs) > 0, `${d.id} gcd`);
      assert.equal(ticks(d.castMs) * 1000 / HZ, d.castMs, `${d.id} cast lands on a tick`);
      assert.ok(d.cooldownMs >= 0);
    }
  });

  it("strike fires at once, heal casts for its ticks, a press in the cast queues, and guard then fires after the GCD", () => {
    const fired: string[] = [];
    const s = new AbilitySystem(HZ, (_e, id) => fired.push(id));
    for (const d of defs) s.define(d);
    const byId = (id: string): Def => defs.find((d) => d.id === id)!;
    const heal = byId("heal");
    const gcd = ticks(byId("strike").gcdMs);
    const castTicks = ticks(heal.castMs);

    assert.equal(s.trigger(1, "strike", 0), "fired");
    assert.deepEqual(fired, ["strike"]);

    assert.equal(s.trigger(1, "heal", gcd), "fired"); // GCD lifts at tick 30, the cast starts
    assert.equal(s.trigger(1, "guard", gcd + 1), "queued"); // pressed mid-cast

    for (let t = gcd; t < gcd + castTicks; t++) s.step(simAt(t), 1 / HZ);
    assert.deepEqual(fired, ["strike"], "heal has not landed before its cast time");
    s.step(simAt(gcd + castTicks), 1 / HZ);
    assert.deepEqual(fired, ["strike", "heal"], "heal lands exactly after its cast ticks");

    const landed = gcd + castTicks;
    for (let t = landed; t < landed + gcd; t++) s.step(simAt(t), 1 / HZ);
    assert.deepEqual(fired, ["strike", "heal"], "the queued guard waits out the GCD");
    s.step(simAt(landed + gcd), 1 / HZ);
    assert.deepEqual(fired, ["strike", "heal", "guard"]);

    // Guard's cooldown runs from when it fired.
    assert.equal(s.trigger(1, "guard", landed + gcd + ticks(1000)), "rejected");
  });
});

describe("the placeholder effects match the existing balance", () => {
  const rule = (f: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../content/rules/${f}`, import.meta.url)), "utf8"));
  const effectOf = (id: string): { kind: string; amount: number; reachM?: number } | undefined =>
    (defs as Array<Def & { effect?: { kind: string; amount: number; reachM?: number } }>).find((d) => d.id === id)?.effect;

  it("strike does one blow's base damage (content/rules/combat.json)", () => {
    const combat = rule("combat.json") as { damage: { base: number } };
    assert.deepEqual(effectOf("strike"), { kind: "damage", amount: combat.damage.base, reachM: 2.5 });
  });

  it("heal restores what Mend restores (content/rules/spells.json)", () => {
    const spells = rule("spells.json") as { spells: Array<{ id: string; effect: { kind: string; amount: number } }> };
    const mend = spells.spells.find((x) => x.id === "mend")!;
    assert.deepEqual(effectOf("heal"), { kind: "heal", amount: mend.effect.amount });
  });

  it("guard lasts the Guard move and takes the share of a blow a failed block lets through", () => {
    const moves = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/combat/moves.json", import.meta.url)), "utf8")) as { moves: Array<{ name: string; duration: number }> };
    const guardMove = moves.moves.find((m) => m.name === "guard")!;
    const combat = rule("combat.json") as { defence: { failedLetsThrough: number } };
    const statusFile = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/combat/abilities.json", import.meta.url)), "utf8")) as { statuses: Array<{ id: string; durationMs: number; mods: Array<{ stat: string; mode: string; value: number }> }> };
    const guarded = statusFile.statuses.find((x) => x.id === "guarded")!;
    assert.equal(guarded.durationMs, guardMove.duration * 1000);
    const armour = guarded.mods.find((m) => m.stat === "armour" && m.mode === "mul")!;
    assert.equal(1 + armour.value, combat.defence.failedLetsThrough);
  });
});
