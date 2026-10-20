/**
 * Baked props get a collider from their real size, not a unit box: the
 * shape is derived from the model's bounds (art catalog / PICG cook) x the
 * instance's scale, an explicit spawn-table shape overrides, and
 * PropCollisionSystem reads the very BodyConfig the spawn wrote (the Jolt
 * body and the nav obstacle read it too).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasComponent, addComponent } from "bitecs";
import { fnv1a32, type EntitySpawn } from "@mmo-engine/scatter";
import {
  BodyConfig,
  IntegrateSystem,
  IntentSystem,
  PlayerIntent,
  PropCollisionSystem,
  ShapeKind,
  SimWorld,
  Transform,
  attachDefaultCollider,
  spawnScatterEntity,
} from "../../src/index.js";
import { loadEcologyPlan } from "../../src/procgen/ecology.js";
import { catalogBounds, pcgBounds, type ModelBounds } from "../../src/procgen/prop-shape.js";
import { PcgAssetLibrary } from "../../src/pcg/asset-library.js";
import { DEFAULT_PCG_ASSETS, loadNativeCooker } from "../../src/pcg/boot.js";
import { loadScatterContent } from "../../src/index.js";

type Col = NonNullable<EntitySpawn["archetype"]["collision"]>;

function spawn(asset: string, scale: number, collision?: Col, yaw = 0): EntitySpawn {
  return {
    x: 10, y: 3, z: 10, yaw, pitch: 0, roll: 0, sx: scale, sy: scale, sz: scale,
    assetId: asset, assetHash: fnv1a32(asset), variant: 0, seed: 1,
    archetype: { asset, ...(collision ? { collision } : {}) },
  };
}

const sizes: Record<string, [number, number, number]> = { tree: [4, 30, 4], flower: [0.2, 0.2, 0.2], rock: [2, 1, 3] };
const bounds: ModelBounds = (id) => sizes[id];

test("a 30 m tree is not a unit box: the box takes the model's height and a trunk's share of its width", () => {
  const w = new SimWorld();
  const e = spawnScatterEntity(w, spawn("tree", 1.5, { shape: "box", motion: "static", fit: 0.5 }), bounds);
  assert.equal(BodyConfig.shapeKind[e], ShapeKind.Box);
  assert.ok(Math.abs(BodyConfig.halfY[e] - 45) < 1e-4, `halfY ${BodyConfig.halfY[e]}: the scaled height`);
  assert.ok(Math.abs(BodyConfig.halfX[e] - 1.5) < 1e-4, "half the footprint x fit x scale");
});

test("with no collision spec, a model of known size still gets a box of that size", () => {
  const w = new SimWorld();
  const e = spawnScatterEntity(w, spawn("rock", 2), bounds);
  assert.ok(Math.abs(BodyConfig.halfX[e] - 2) < 1e-4);
  assert.ok(Math.abs(BodyConfig.halfZ[e] - 3) < 1e-4);
  assert.ok(Math.abs(BodyConfig.halfY[e] - 2) < 1e-4);
});

test("an explicit shape overrides the bounds (authored at scale 1, scaled with the instance)", () => {
  const w = new SimWorld();
  const e = spawnScatterEntity(w, spawn("tree", 2, { shape: "box", motion: "static", halfExtents: [0.4, 2.5, 0.4] }), bounds);
  assert.ok(Math.abs(BodyConfig.halfY[e] - 5) < 1e-4);
  assert.ok(Math.abs(BodyConfig.halfX[e] - 0.8) < 1e-4);
  const s = spawnScatterEntity(w, spawn("tree", 2, { shape: "sphere", motion: "static", radius: 0.5 }), bounds);
  assert.equal(BodyConfig.shapeKind[s], ShapeKind.Sphere);
  assert.ok(Math.abs(BodyConfig.radius[s] - 1) < 1e-4);
});

test("a sphere without a radius takes it from the footprint", () => {
  const w = new SimWorld();
  const e = spawnScatterEntity(w, spawn("rock", 1, { shape: "sphere", motion: "static" }), bounds);
  assert.equal(BodyConfig.shapeKind[e], ShapeKind.Sphere);
  assert.ok(Math.abs(BodyConfig.radius[e] - 1.5) < 1e-4);
});

test("a prop you step over (a 0.2 m flower, leaf litter) gets no body; unknown models keep the default box", () => {
  const w = new SimWorld();
  const f = spawnScatterEntity(w, spawn("flower", 1), bounds);
  assert.ok(!hasComponent(w.ecs, BodyConfig, f));
  const u = spawnScatterEntity(w, spawn("mystery", 1), bounds);
  assert.ok(hasComponent(w.ecs, BodyConfig, u));
  assert.equal(BodyConfig.halfY[u], 0.5);
});

test("PropCollisionSystem stops a walker at the derived, yawed box (the BodyConfig the Jolt body and nav obstacle share)", () => {
  const w = new SimWorld();
  // 2 x 30 x 8 m wall, turned a quarter: it is 8 m wide along x, 2 m deep along z.
  const wall = spawnScatterEntity(w, spawn("wall", 1, undefined, Math.PI / 2), (id) => (id === "wall" ? [2, 30, 8] : undefined));
  const eid = w.spawn();
  addComponent(w.ecs, Transform, eid);
  Transform.px[eid] = 10 + 3.5; Transform.py[eid] = 3; Transform.pz[eid] = 10 - 6;
  Transform.qw[eid] = 1;
  addComponent(w.ecs, PlayerIntent, eid);
  attachDefaultCollider(w, eid);
  const systems = [new IntentSystem(), new IntegrateSystem(), new PropCollisionSystem()];
  for (let t = 0; t < 120; t++) {
    PlayerIntent.mx[eid] = 0; PlayerIntent.mz[eid] = 1;
    for (const s of systems) s.step(w, 1 / 30);
  }
  // Walking +z along the wall's long (now x) side must be blocked before z = 10 - 1 - capsule radius.
  assert.ok(Transform.pz[eid] < 10 - 1 + 0.01, `walked into the wall: z=${Transform.pz[eid]} (box ${BodyConfig.halfX[wall]}x${BodyConfig.halfZ[wall]})`);
});

// ---- the shipped content --------------------------------------------------

const catalogFile = fileURLToPath(new URL("../../../../../assets/catalog.json", import.meta.url));
const wildsFile = fileURLToPath(new URL("../../../content/ecology/wilds.ecology.json", import.meta.url));

/** Walk-through decoration: ground cover and shrubs you push through. Anything else must block. */
const DECORATION = new Set([
  "understory", "edgeShrubs", "rockGrass", "pebbles", "meadowPatch", "wildflowers", "strayFlowers", "grass", "reedbed", "reeds", "lilies",
]);

test("every non-decoration ecology layer blocks, and every decoration layer is a known one", () => {
  const { plan } = loadEcologyPlan(wildsFile);
  for (const l of plan.layers) {
    const shape = l.collision?.shape ?? "box";
    if (shape === "none") assert.ok(DECORATION.has(l.id), `layer "${l.id}" is walk-through: add it to DECORATION on purpose`);
    else assert.ok(!DECORATION.has(l.id), `decoration layer "${l.id}" has a collider`);
  }
});

test("every blocking ecology asset has a collider within 3x of its visual bounds at both ends of its scale range", { skip: !existsSync(catalogFile) }, () => {
  const b = catalogBounds(catalogFile);
  const { plan } = loadEcologyPlan(wildsFile);
  let checked = 0;
  const each = (o: unknown, f: (a: { asset: string; scale?: [number, number] }) => void): void => {
    if (o && typeof o === "object") {
      const a = o as { asset?: unknown };
      if (typeof a.asset === "string" && a.asset) f(a as { asset: string; scale?: [number, number] });
      for (const v of Object.values(o)) each(v, f);
    }
  };
  for (const l of plan.layers) {
    if (l.collision?.shape === "none") continue;
    each(l, (a) => {
      const size = b(a.asset);
      assert.ok(size, `layer "${l.id}": ${a.asset} is not in the art catalog`);
      for (const sc of a.scale ?? l.scale) {
        const w = new SimWorld();
        const e = spawnScatterEntity(w, { ...spawn(a.asset, sc, l.collision), sx: sc, sy: sc, sz: sc }, b);
        if (!hasComponent(w.ecs, BodyConfig, e)) {
          assert.ok(size[1] * sc < 0.5, `layer "${l.id}": ${a.asset} x${sc} has no body but is ${size[1] * sc} m tall`);
          continue;
        }
        const half = BodyConfig.shapeKind[e] === ShapeKind.Sphere
          ? [BodyConfig.radius[e], BodyConfig.radius[e], BodyConfig.radius[e]]
          : [BodyConfig.halfX[e], BodyConfig.halfY[e], BodyConfig.halfZ[e]];
        // Boxes stand on the ground centred there: halfY covers the height, so compare to the full height.
        const visual = [size[0] * sc / 2, size[1] * sc, size[2] * sc / 2];
        half.forEach((h, i) => {
          if (BodyConfig.shapeKind[e] === ShapeKind.Sphere && i === 1) return;
          assert.ok(h > 0, `${a.asset} x${sc}: half extent ${i} is ${h}`);
          assert.ok(h <= visual[i] * 3 && h >= visual[i] / 3, `layer "${l.id}": ${a.asset} x${sc} axis ${i}: collider ${h.toFixed(2)} vs visual ${visual[i].toFixed(2)}`);
        });
        checked++;
      }
    });
  }
  assert.ok(checked > 50, `only ${checked} asset ends checked`);
});

test("every PICG tree in the forest table has a collider within 3x of its cooked mesh", async (t) => {
  const { cooker } = loadNativeCooker();
  if (!cooker) return t.skip("native picg addon not built");
  const b = await pcgBounds(PcgAssetLibrary.load(DEFAULT_PCG_ASSETS, cooker));
  const table = loadScatterContent().table;
  for (const [id, arch] of Object.entries(table.archetypes)) {
    const size = b(id);
    assert.ok(size, `${id}: no cooked bounds`);
    for (const sc of [0.7, 1.4]) {
      const w = new SimWorld();
      const e = spawnScatterEntity(w, { ...spawn(id, sc, arch.collision), assetId: id }, b);
      assert.ok(hasComponent(w.ecs, BodyConfig, e), `${id} must block`);
      const visual = [(size[0] * sc) / 2, size[1] * sc, (size[2] * sc) / 2];
      [BodyConfig.halfX[e], BodyConfig.halfY[e], BodyConfig.halfZ[e]].forEach((h, i) =>
        assert.ok(h <= visual[i] * 3 && h >= visual[i] / 3, `${id} x${sc} axis ${i}: ${h} vs ${visual[i]}`));
    }
  }
});

test("the catalog bounds reader returns model sizes by id", { skip: !existsSync(catalogFile) }, () => {
  const raw = JSON.parse(readFileSync(catalogFile, "utf8")) as { models: Array<{ id: string; size: number[] }> };
  const m = raw.models.find((x) => x.size?.length === 3)!;
  assert.deepEqual(catalogBounds(catalogFile)(m.id), m.size);
  assert.equal(catalogBounds(catalogFile)("no-such-model"), undefined);
});
