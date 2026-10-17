/**
 * The town's layout: a street grid (roads as a connected graph) in quarters,
 * a wall with gates and towers round a town big enough, farms outside along
 * the roads out of the gates, and every plot facing its street. All geometry
 * is integer millimetres, and the same seed lays out the same town.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, DISTRICT_KINDS, fortificationGate, layOut, quartersGate, scaledFortification, streams, townHalfExtentM, type Layout } from "../src/index.js";

const lay = (households: number, seed = 1) => layOut("0182", households, BUILTIN_RULES, streams(seed));
const [bw, bd] = BUILTIN_RULES.layout.block;
const inner = (l: Layout) => l.parcels.filter((p) => p.kind !== "agriculture");
const farms = (l: Layout) => l.parcels.filter((p) => p.kind === "agriculture");
/** The gates that read only the layout. */
const layoutGates = (l: Layout) => ({ fortification: fortificationGate(l), district_quarters: quartersGate(l, BUILTIN_RULES) });

describe("layOut", () => {
  const town = lay(136);

  it("gives enough parcels for the households: whole blocks inside, farms outside to feed everyone", () => {
    assert.ok(inner(town).length >= Math.ceil((136 * BUILTIN_RULES.layout.parcelsPerHouseholdPermille) / 1000) - farms(town).length);
    assert.equal(inner(town).length, town.blocks * town.blocks * bw * bd);
    const people = Math.ceil((136 * BUILTIN_RULES.demographics.householdSizeX10) / 10);
    assert.ok(farms(town).length * BUILTIN_RULES.archetypes.farmstead!.feeds >= people, "farm plots enough to feed the town");
  });

  it("splits the blocks inside between housing, shopping and manufacturing, none left over", () => {
    assert.deepEqual(town.districts.map((d) => d.kind).sort(), [...DISTRICT_KINDS].sort());
    const blocks = (k: string) => town.districts.find((d) => d.kind === k)!.blocks;
    assert.equal(blocks("housing") + blocks("shopping") + blocks("manufacturing"), town.blocks * town.blocks);
    assert.ok(blocks("housing") > blocks("shopping"));
  });

  it("puts every parcel in one district, with integer-millimetre geometry, road frontage and a facing", () => {
    const ids = new Set(town.districts.map((d) => d.id));
    for (const p of town.parcels) {
      assert.ok(ids.has(p.district));
      assert.ok(Number.isInteger(p.center.x) && Number.isInteger(p.center.z));
      assert.equal(p.areaM2, (BUILTIN_RULES.layout.parcelSizeMm[0] * BUILTIN_RULES.layout.parcelSizeMm[1]) / 1_000_000);
      assert.equal(p.roadFrontage, true);
      assert.ok([0, 90, 180, 270].includes(p.facing));
    }
    assert.equal(new Set(town.parcels.map((p) => p.id)).size, town.parcels.length);
  });

  it("turns each block's front row to the street before it and its back row to the street behind", () => {
    for (const p of inner(town)) assert.equal(p.facing, p.gz % bd < bd / 2 ? 180 : 0);
  });

  it("builds a connected street grid, primary roads through the middle and out of town as country roads", () => {
    const n = town.blocks;
    const streets = town.roads.edges.filter((e) => e.roadClass !== "country_road");
    assert.equal(streets.length, 2 * n * (n + 1));
    assert.ok(streets.some((e) => e.roadClass === "primary_town_road"));
    assert.ok(streets.some((e) => e.roadClass === "secondary_street"));
    assert.equal(town.roads.edges.filter((e) => e.roadClass === "country_road").length, town.walled ? 8 : 4, "four roads out, each through its gate");
    const seen = new Set([town.roads.nodes[0]!.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of town.roads.edges) {
        if (seen.has(e.from) !== seen.has(e.to)) {
          seen.add(e.from).add(e.to);
          grew = true;
        }
      }
    }
    assert.equal(seen.size, town.roads.nodes.length);
  });

  it("is deterministic per seed, and the seed moves the craft quarter", () => {
    assert.deepEqual(lay(136, 5), lay(136, 5));
    const kindsAt = (seed: number) => JSON.stringify(lay(136, seed).parcels.map((p) => [p.gx, p.gz, p.kind]));
    assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(kindsAt)).size > 1);
  });
});

describe("quarters", () => {
  it("keeps each district inside the walls to one connected group of blocks, the market at the centre", () => {
    for (const households of [25, 60, 136, 230, 400]) {
      for (const seed of [1, 2, 3, 4]) {
        const l = lay(households, seed);
        assert.ok(layoutGates(l).district_quarters!.ok, `${households}/${seed}: ${layoutGates(l).district_quarters!.detail}`);
      }
    }
    const l = lay(136);
    const mid = (l.blocks * bw) / 2;
    const market = inner(l).filter((p) => p.kind === "shopping").map((p) => Math.abs(p.gx + 0.5 - mid));
    const homes = inner(l).filter((p) => p.kind === "housing").map((p) => Math.abs(p.gx + 0.5 - mid));
    assert.ok(Math.max(...market) <= Math.max(...homes), "the market quarter is nearer the centre than the edge of town");
  });

  it("puts the craft quarter on one side of town, next to a road out", () => {
    const l = lay(136, 2);
    const craft = inner(l).filter((p) => p.kind === "manufacturing");
    const xs = craft.map((p) => Math.floor(p.gx / bw));
    const zs = craft.map((p) => Math.floor(p.gz / bd));
    const edge = [Math.min(...xs) === 0, Math.max(...xs) === l.blocks - 1, Math.min(...zs) === 0, Math.max(...zs) === l.blocks - 1];
    assert.ok(edge.some(Boolean), "it reaches the town's edge");
  });
});

describe("the town wall", () => {
  const town = lay(136);
  const w = scaledFortification(BUILTIN_RULES);

  it("walls a town of minHouseholds or more, and leaves a smaller village open", () => {
    assert.equal(town.walled, true);
    const village = lay(BUILTIN_RULES.fortification.minHouseholds - 1);
    assert.equal(village.walled, false);
    assert.deepEqual(village.fortifications, []);
    assert.ok(layoutGates(village).fortification!.ok);
    assert.ok(farms(village).length > 0, "a village has its farms too");
  });

  it("is a closed ring with four gates, towers at the corners, and every street plot inside and farm outside", () => {
    const g = layoutGates(town).fortification!;
    assert.ok(g.ok, g.detail);
    const gates = town.fortifications.filter((p) => p.kind === "town_gate");
    assert.equal(gates.length, 4);
    for (const gate of gates) assert.equal(gate.lengthMm, w.gateMm, "an opening as wide as the road plus a metre each side");
  });

  it("flanks every gate with a tower each side, and keeps towers within towerSpacingMm of each other", () => {
    const sides = new Map<string, typeof town.fortifications>();
    for (const p of town.fortifications) {
      const k = p.yawDeg === 0 ? `z${p.center.z}` : `x${p.center.x}`;
      sides.set(k, [...(sides.get(k) ?? []), p]);
    }
    for (const pieces of sides.values()) {
      const along = (p: (typeof pieces)[number]) => (p.yawDeg === 0 ? p.center.x : p.center.z);
      const run = [...pieces].sort((a, b) => along(a) - along(b));
      const g = run.findIndex((p) => p.kind === "town_gate");
      assert.equal(run[g - 1]!.kind, "wall_tower");
      assert.equal(run[g + 1]!.kind, "wall_tower");
      let since = 0;
      for (const p of run) {
        if (p.kind === "town_wall") {
          assert.ok(p.lengthMm <= w.pieceMm, `a wall piece of ${p.lengthMm} mm, longer than a model's run`);
          since += p.lengthMm;
          assert.ok(since <= w.towerSpacingMm + w.towerMm, `${since} mm of wall without a tower`);
        } else since = 0;
      }
    }
  });

  it("sets the farms beyond the wall, along both sides of the roads, each facing its road", () => {
    const xs = town.fortifications.map((p) => p.center.x);
    const zs = town.fortifications.map((p) => p.center.z);
    for (const f of farms(town)) assert.ok(f.center.x < Math.min(...xs) || f.center.x > Math.max(...xs) || f.center.z < Math.min(...zs) || f.center.z > Math.max(...zs));
    assert.deepEqual([...new Set(farms(town).map((f) => f.facing))].sort((a, b) => a - b), [0, 90, 180, 270], "farms on all four roads, both sides");
  });

  it("measures the walled town for site selection, wall included", () => {
    const n = town.blocks;
    const [pw, pd] = BUILTIN_RULES.layout.parcelSizeMm;
    const pitch = Math.max(bw * pw, bd * pd) + BUILTIN_RULES.layout.streetWidthMm;
    assert.equal(townHalfExtentM(136, BUILTIN_RULES), Math.ceil((n * pitch + BUILTIN_RULES.layout.streetWidthMm + 2 * (w.setbackMm + w.thicknessMm)) / 2000));
  });
});
