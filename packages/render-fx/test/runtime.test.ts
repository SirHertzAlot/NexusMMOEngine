import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEffectRuntime, migrateAsset } from "../src/index.js";

const CHARGED_SHOT = migrateAsset(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/vfx/charged-shot.json", import.meta.url)), "utf8")),
);
const FORCE_SHIELD = migrateAsset(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/vfx/force-shield.json", import.meta.url)), "utf8")),
);
const MEND_AURA = migrateAsset(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../../content/vfx/mend-aura.json", import.meta.url)), "utf8")),
);

describe("ManagedEffectRuntime", () => {
  it("registers assets, spawns within tier slot caps, and resolves $param indirection", () => {
    const spawned: number[] = [];
    const rt = createEffectRuntime({
      initialTier: "medium",
      hooks: { onSpawn: (inst) => spawned.push(inst.handle) },
    });
    rt.registerAsset(CHARGED_SHOT);
    rt.registerAsset(FORCE_SHIELD);
    rt.registerAsset(MEND_AURA);

    const h = rt.spawn("fx.charged-shot", { kind: "entity", entityId: "42" }, { params: { bodyColor: "#00ffcc", charge01: 2.5 } });
    assert.ok(h !== null);
    assert.deepEqual(spawned, [h]);
    const inst = rt.getInstance(h!)!;
    assert.equal(inst.params.charge01, 1.0, "clamped to max=1");
    assert.equal(inst.moduleParams[0]!.rimColor, "#00ffcc", "$bodyColor resolved");

    // Low tier disables charged-shot (minTier: medium) and force-shield (slotCaps.low = 0), but allows mend-aura (slotCaps.low = 4).
    rt.setQuality("low");
    assert.equal(rt.activeCount, 0, "disallowed active effects disposed when tier drops to low");
    assert.equal(rt.spawn("fx.charged-shot", { kind: "entity", entityId: "42" }), null);
    assert.equal(rt.spawn("fx.force-shield", { kind: "entity", entityId: "42" }), null);
    assert.ok(rt.spawn("fx.mend-aura", { kind: "entity", entityId: "42" }) !== null);
  });

  it("handles authoritative 0x28 FxSpawn / FxUpdate / FxKill with dedupe, (tick, seq) ordering, and startAge seek", () => {
    const hits: Array<[number, number, number]> = [];
    const rt = createEffectRuntime({
      initialTier: "high",
      hooks: { onHit: (_inst, hit) => hits.push(hit.pos) },
    });
    rt.registerAsset(CHARGED_SHOT);
    rt.registerAsset(FORCE_SHIELD);

    // Spawn 15 ticks late at 30 Hz -> startAge = 0.5s
    const h = rt.applyFxMessage(
      {
        kind: "fx-spawn",
        fxId: "cast:10:100",
        tick: 100,
        seq: 1,
        assetId: "fx.charged-shot",
        assetVersion: 1,
        seed: 7,
        binding: { kind: "entity", entityId: "10" },
        phase: "charge",
        params: { charge01: 0.25 },
      },
      115,
      30,
    );
    assert.ok(h !== null);
    assert.ok(Math.abs(rt.getInstance(h!)!.age - 0.5) < 1e-6);

    // Duplicate fxId is ignored
    assert.equal(
      rt.applyFxMessage(
        {
          kind: "fx-spawn",
          fxId: "cast:10:100",
          tick: 100,
          seq: 2,
          assetId: "fx.charged-shot",
          assetVersion: 1,
          seed: 7,
          binding: { kind: "entity", entityId: "10" },
          phase: "charge",
        },
        115,
        30,
      ),
      null,
    );

    // Out-of-order update (tick 99 < 100) is ignored
    assert.equal(
      rt.applyFxMessage({ kind: "fx-update", fxId: "cast:10:100", tick: 99, seq: 9, params: { charge01: 0.9 } }, 116, 30),
      null,
    );
    assert.equal(rt.getInstance(h!)!.params.charge01, 0.25);

    // In-order update advances phase and params
    rt.applyFxMessage({ kind: "fx-update", fxId: "cast:10:100", tick: 105, seq: 1, phase: "release", params: { charge01: 1.0 } }, 116, 30);
    assert.equal(rt.getInstance(h!)!.phase, "release");
    assert.equal(rt.getInstance(h!)!.params.charge01, 1.0);

    // Shield hit recording and FxKill fade
    const sh = rt.applyFxMessage(
      {
        kind: "fx-spawn",
        fxId: "shield:10",
        tick: 110,
        seq: 1,
        assetId: "fx.force-shield",
        assetVersion: 1,
        seed: 3,
        binding: { kind: "entity", entityId: "10" },
        phase: "active",
      },
      110,
      30,
    )!;
    rt.applyFxMessage({ kind: "fx-update", fxId: "shield:10", tick: 112, seq: 1, hit: { pos: [0, 1, 1] } }, 112, 30);
    assert.deepEqual(hits, [[0, 1, 1]]);

    rt.applyFxMessage({ kind: "fx-kill", fxId: "shield:10", tick: 120, seq: 1, fade: 0.2 }, 120, 30);
    assert.equal(rt.getInstance(sh)!.state, "interrupting");
    rt.update(0.25, null);
    assert.equal(rt.getInstance(sh), undefined, "disposed after fade completes");
  });

  it("applies onOrphan rules (detach, fade, kill) when a bound entity leaves", () => {
    const rt = createEffectRuntime({ initialTier: "high" });
    rt.registerAsset(CHARGED_SHOT); // onOrphan: detach
    rt.registerAsset(FORCE_SHIELD); // onOrphan: fade

    const hDetach = rt.spawn("fx.charged-shot", { kind: "entity", entityId: "99" })!;
    const hFade = rt.spawn("fx.force-shield", { kind: "entity", entityId: "99" })!;
    rt.orphanEntity("99", [12, 1, 34]);

    assert.equal(rt.getInstance(hDetach)!.binding.kind, "world");
    assert.deepEqual(rt.getInstance(hDetach)!.binding.pos, [12, 1, 34]);
    assert.equal(rt.getInstance(hFade)!.state, "interrupting");
  });
});
