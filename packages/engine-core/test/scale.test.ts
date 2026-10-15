/**
 * Global scale (content/scale.json) where baked objects spawn: the file's
 * loading (a bad one refuses boot), and the factor reaching every spawn
 * path -- Transform scale and collision both -- so what the client draws and
 * what blocks the walker always agree.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fnv1a32, parseSpawnTableJSON, type EntitySpawn } from "@mmo-engine/scatter";
import { DEFAULT_SCALE, type ScaleDoc } from "@mmo-engine/scene";
import { CHARACTER_CAPSULE, IntegrateSystem, IntentSystem, PropCollisionSystem, STEP_MS, SimWorld } from "../src/index.js";
import * as C from "../src/components.js";
import { attachDefaultCollider } from "../src/systems.js";
import { CreatureSystem } from "../src/creatures.js";
import { loadGameRules } from "../src/rules/boot.js";
import { loadScale, scaleResolver } from "../src/scale.js";
import { spawnScatterEntity } from "../src/procgen/scatter-spawn.js";
import { spawnScene } from "../src/scene-spawn.js";

const doc = (over: Partial<ScaleDoc>): ScaleDoc => ({ ...DEFAULT_SCALE, ...over });
const game = loadGameRules();
const body = (e: number) => [C.BodyConfig.halfX[e], C.BodyConfig.halfY[e], C.BodyConfig.halfZ[e]].map((v) => Math.round(v * 1e4) / 1e4);
const near = (a: number, b: number, tol = 1e-5) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

describe("loadScale", () => {
  const dir = mkdtempSync(join(tmpdir(), "scale-"));
  const write = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
  it("reads a file; MMO_SCALE names it", () => {
    const f = write("ok.json", JSON.stringify(doc({ global: 2, categories: { tree: 0.5 }, assets: { "a/*": 3 } })));
    near(loadScale(f)("tree", "a/x"), 3);
    process.env.MMO_SCALE = f;
    try { near(loadScale()("building"), 2); } finally { delete process.env.MMO_SCALE; }
  });
  it("a missing default file means no scaling; a missing named file is refused", () => {
    near(loadScale(join(dir, "none.json"), false)("building"), 1);
    assert.throws(() => loadScale(join(dir, "none.json")), /none\.json/);
  });
  it("a bad file refuses boot, naming every problem", () => {
    const f = write("bad.json", JSON.stringify({ version: 1, global: 0, categories: { boulder: 2 }, assets: { x: 99 } }));
    assert.throws(() => loadScale(f), (e: Error) => /global/.test(e.message) && /boulder/.test(e.message) && /assets\.x/.test(e.message));
    assert.throws(() => loadScale(write("junk.json", "{nope")), /junk\.json/);
  });
  it("the shipped content/scale.json loads", () => {
    near(loadScale()("tree"), 1);
    assert.ok(loadScale()("building") > 0);
    rmSync(dir, { recursive: true });
  });
});

describe("scatter and ecology spawns", () => {
  const spawn = (over: Partial<EntitySpawn> & { archetype: EntitySpawn["archetype"] }): EntitySpawn => ({
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, sx: 1.5, sy: 1.5, sz: 1.5, assetId: "pack/Rock_1", assetHash: 7, variant: 0, seed: 1, ...over,
  });
  it("the factor multiplies the instance scale into Transform and into the derived collision", () => {
    const sim = new SimWorld();
    const scale = scaleResolver(doc({ categories: { rock: 2 } }));
    const e = spawnScatterEntity(sim, spawn({ archetype: { asset: "pack/Rock_1", category: "rock", collision: { shape: "box", halfExtents: [1, 0.5, 2], motion: "static" } } }), undefined, scale);
    assert.deepEqual([C.Transform.sx[e], C.Transform.sy[e], C.Transform.sz[e]], [3, 3, 3]);
    assert.deepEqual(body(e), [3, 1.5, 6], "authored x instance x factor");
    const f = spawnScatterEntity(sim, spawn({ archetype: { asset: "pack/Rock_1", category: "rock" } }), () => [4, 6, 2], scale);
    assert.deepEqual(body(f), [6, 18, 3], "bounds x instance x factor, centred on the ground");
  });
  it("the category defaults to prop; an asset entry reaches it", () => {
    const sim = new SimWorld();
    const scale = scaleResolver(doc({ categories: { prop: 2, rock: 5 }, assets: { "pack/Rock_*": 10 } }));
    const a = spawnScatterEntity(sim, spawn({ assetId: "x", archetype: { asset: "x", collision: { shape: "sphere", radius: 1, motion: "static" } } }), undefined, scale);
    near(C.Transform.sx[a], 3);
    near(C.BodyConfig.radius[a], 3);
    const b = spawnScatterEntity(sim, spawn({ archetype: { asset: "pack/Rock_1", category: "rock", collision: { shape: "none", motion: "static" } } }), undefined, scale);
    near(C.Transform.sx[b], 1.5 * 50);
  });
  it("without a resolver nothing changes", () => {
    const e = spawnScatterEntity(new SimWorld(), spawn({ archetype: { asset: "a", collision: { shape: "box", halfExtents: [1, 1, 1], motion: "static" } } }));
    assert.equal(C.Transform.sx[e], 1.5);
    assert.deepEqual(body(e), [1.5, 1.5, 1.5]);
  });
});

const table = parseSpawnTableJSON({ version: 1, archetypes: { oak: { asset: "oak", category: "tree" }, pebble: { asset: "pebble" } } });
const creaturesOf = () => new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
const scene = (nodes: unknown[]) => ({ version: 1, name: "t", kind: "arena", nodes }) as never;
const structure = (id: string, s: Record<string, unknown>, at = [10, 0, 20]) => ({ id, transform: { position: at }, components: { Structure: s } });

describe("scene spawns", () => {
  const setup = (scale: ScaleDoc, bounds?: (id: string) => [number, number, number] | undefined) => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    return { sim, deps: { sim, creatures: creaturesOf(), table: () => table, scale: scaleResolver(scale), bounds } };
  };

  it("a Structure's footprint and Transform are authored x the building factor", () => {
    const { deps } = setup(doc({ global: 2, categories: { building: 0.25, prop: 9 } }));
    const e = spawnScene(scene([structure("s", { kind: "smithy", width: 10, depth: 18, height: 4 })]), deps).spawned[0].entities[0];
    near(C.Transform.sx[e], 0.5);
    assert.deepEqual(body(e), [2.5, 2, 4.5]);
    const { deps: d2 } = setup(doc({ categories: { building: 0.6 } }));
    const f = spawnScene(scene([structure("s", { kind: "smithy", width: 10, depth: 18, height: 4 })]), d2).spawned[0].entities[0];
    near(C.Transform.sx[f], 0.6);
    assert.deepEqual(body(f), [3, 2.4, 5.4]);
  });

  it("a Structure naming a model takes its body from the catalog bounds x scale, else the footprint", () => {
    const bounds = (id: string) => (id === "pack/Smithy_01" ? ([20, 8, 10] as [number, number, number]) : undefined);
    const { deps } = setup(doc({ categories: { building: 0.5 }, assets: { "pack/Smithy_*": 2 } }), bounds);
    const named = { kind: "smithy", asset: "pack/Smithy_01", width: 10, depth: 18, height: 4 };
    const e = spawnScene(scene([structure("a", named)]), deps).spawned[0].entities[0];
    assert.equal(C.AssetRef.assetHash[e], fnv1a32("pack/Smithy_01"));
    near(C.Transform.sx[e], 1);
    assert.deepEqual(body(e), [10, 8, 5], "model size x scale, not the parcel footprint");
    const g = spawnScene(scene([structure("b", { ...named, asset: "pack/Unknown" })]), deps).spawned[0].entities[0];
    near(C.Transform.sx[g], 0.5);
    assert.deepEqual(body(g), [2.5, 2, 4.5], "no catalog entry: the footprint x scale");
  });

  it("prop and Collider nodes get their category's factor times the node's own scale", () => {
    const { deps } = setup(doc({ categories: { tree: 2, prop: 3 } }));
    const r = spawnScene(scene([
      { id: "oak", prefab: "oak", transform: { position: [1, 0, 1], scale: [2, 2, 2] } },
      { id: "pebble", prefab: "pebble", transform: { position: [2, 0, 2] } },
      { id: "block", transform: { position: [3, 0, 3] }, components: { Collider: { shape: "box", hx: 1, hy: 2, hz: 3 } } },
    ]), deps);
    const by = (id: string) => r.spawned.find((s) => s.id === id)!.entities[0];
    near(C.Transform.sx[by("oak")], 4);
    near(C.Transform.sx[by("pebble")], 3);
    assert.deepEqual(body(by("block")), [3, 6, 9], "a standalone Collider is a prop");
    near(C.Transform.sx[by("block")], 3);
  });
});

describe("a scaled wall blocks the walker where the scaled body is", () => {
  const walkTo = (factor: number): number => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    // A 10 m wide wall centred at x = 0; the walker starts at x = -30 and walks +x.
    spawnScene(scene([structure("w", { kind: "wall", width: 10, depth: 10, height: 4 }, [0, 0, 0])]), {
      sim, creatures: creaturesOf(), table: () => table, scale: scaleResolver(doc({ categories: { building: factor } })),
    });
    const p = sim.spawn();
    addComponent(sim.ecs, C.Transform, p);
    C.Transform.px[p] = -30; C.Transform.qw[p] = 1;
    addComponent(sim.ecs, C.PlayerIntent, p);
    attachDefaultCollider(sim, p);
    const systems = [new IntentSystem(), new IntegrateSystem(), new PropCollisionSystem()];
    for (let t = 0; t < 400; t++) {
      C.PlayerIntent.mx[p] = 1;
      C.PlayerIntent.mz[p] = 0;
      for (const s of systems) s.step(sim, STEP_MS / 1000);
    }
    return C.Transform.px[p];
  };
  it("stops at the scaled face, not the authored one", () => {
    const r = CHARACTER_CAPSULE.radius;
    near(walkTo(1), -5 - r, 0.02);
    near(walkTo(0.5), -2.5 - r, 0.02); // the old wall's face (-5) is open ground now
    near(walkTo(2), -10 - r, 0.02);
  });
});
