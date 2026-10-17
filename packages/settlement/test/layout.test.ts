/**
 * The town's layout: a street grid (roads as a connected graph) round a town
 * square, in quarters (civic, market, entertainment, education, housing), a
 * wall with gates and towers round a town big enough, the craft quarter and
 * the farms outside along the roads out of the gates, and every plot facing
 * its street. All geometry is integer millimetres, and the same seed lays out
 * the same town.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, DISTRICT_KINDS, fortificationGate, layOut, quartersGate, scaledFortification, streams, townHalfExtentM, type Layout } from "../src/index.js";

const lay = (households: number, seed = 1) => layOut("0182", households, BUILTIN_RULES, streams(seed));
const [bw, bd] = BUILTIN_RULES.layout.block;
const inner = (l: Layout) => l.parcels.filter((p) => p.kind !== "agriculture" && p.kind !== "manufacturing");
const farms = (l: Layout) => l.parcels.filter((p) => p.kind === "agriculture");
const crafts = (l: Layout) => l.parcels.filter((p) => p.kind === "manufacturing");
/** The gates that read only the layout. */
const layoutGates = (l: Layout) => ({ fortification: fortificationGate(l), district_quarters: quartersGate(l, BUILTIN_RULES) });

describe("layOut", () => {
  const town = lay(136);

  it("gives enough parcels for the households: every block inside but the square, farms outside to feed everyone", () => {
    assert.ok(inner(town).length + crafts(town).length >= Math.ceil((136 * BUILTIN_RULES.layout.parcelsPerHouseholdPermille) / 1000) - farms(town).length);
    assert.equal(inner(town).length, (town.blocks * town.blocks - 1) * bw * bd);
    const people = Math.ceil((136 * BUILTIN_RULES.demographics.householdSizeX10) / 10);
    assert.ok(farms(town).length * BUILTIN_RULES.archetypes.farmstead!.feeds >= people, "farm plots enough to feed the town");
  });

  it("has every district, its area its plots", () => {
    assert.deepEqual(town.districts.map((d) => d.kind).sort(), [...DISTRICT_KINDS].sort());
    const [pw, pd] = BUILTIN_RULES.layout.parcelSizeMm;
    for (const d of town.districts) {
      const own = town.parcels.filter((p) => p.district === d.id);
      // A farm district is its holdings' land, the rest their plots.
      const area = d.kind === "agriculture" ? own.reduce((a, p) => a + p.holding!.areaM2, 0) : (own.length * pw * pd) / 1_000_000;
      assert.ok(Math.abs(d.areaM2 - area) < 1e-3, d.kind);
    }
    const plots = (k: string) => town.parcels.filter((p) => p.kind === k).length;
    assert.ok(plots("housing") > plots("shopping") && plots("shopping") > plots("civic"));
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

  it("leaves the block at the crossing of the main roads open as the town square, on the primary roads", () => {
    for (const households of [25, 136, 400]) {
      const l = lay(households);
      assert.ok(l.square, "a square (a green, for a village)");
      const sq = l.square!;
      assert.ok(!l.parcels.some((p) => Math.abs(p.center.x - sq.center.x) < sq.widthMm / 2 && Math.abs(p.center.z - sq.center.z) < sq.depthMm / 2), "no plot on the square");
      const primary = new Set(l.roads.edges.filter((e) => e.roadClass === "primary_town_road").flatMap((e) => [e.from, e.to]));
      const s = BUILTIN_RULES.layout.streetWidthMm;
      const corners = l.roads.nodes.filter((n) => primary.has(n.id) && Math.abs(Math.abs(n.x - sq.center.x) - (sq.widthMm + s) / 2) <= 1 && Math.abs(Math.abs(n.z - sq.center.z) - (sq.depthMm + s) / 2) <= 1);
      assert.ok(corners.length >= 1, `${households}: the square is on the main roads`);
    }
  });

  it("sets the civic quarter and the market round the square, and every plot of a quarter's block nearest the square is the quarter's", () => {
    const l = lay(136);
    const sq = l.square!;
    const d = (p: { center: { x: number; z: number } }) => Math.hypot(p.center.x - sq.center.x, p.center.z - sq.center.z);
    const near = (k: string) => Math.min(...inner(l).filter((p) => p.kind === k).map(d));
    const homes = Math.max(...inner(l).filter((p) => p.kind === "housing").map(d));
    for (const k of ["civic", "shopping"]) assert.ok(near(k) < (BUILTIN_RULES.layout.block[0] + 1) * BUILTIN_RULES.layout.parcelSizeMm[0], `${k} on the square`);
    assert.ok(near("civic") < homes);
  });

  it("puts the craft quarter outside the town on one road out, nearest the wall, the farms beyond it", () => {
    for (const seed of [1, 2, 3, 4]) {
      const l = lay(136, seed);
      const c = crafts(l);
      assert.ok(c.length > 0);
      const roads = new Set(c.map((p) => (-p.gz / 1000 - 1) % 4));
      assert.equal(roads.size, 1, "one road");
      const road = [...roads][0]!;
      for (const f of farms(l).filter((p) => (-p.gz / 1000 - 1) % 4 === road)) assert.ok(c.filter((p) => p.gz === f.gz).every((p) => p.gx < f.gx), "farms on the craft road start beyond the crafts");
    }
  });

  it("keeps the quarters off wet ground when it knows where the water is, and puts the crafts on the driest road", () => {
    // The sea covers the east half (+x from the town's centre).
    const dry = (dx: number) => dx < 0;
    const l = layOut("0182", 136, BUILTIN_RULES, streams(2), 1, 0, dry);
    const [pw, pd] = BUILTIN_RULES.layout.parcelSizeMm;
    const centre = { x: (l.blocks * ((BUILTIN_RULES.layout.block[0] * pw) + BUILTIN_RULES.layout.streetWidthMm) - BUILTIN_RULES.layout.streetWidthMm) / 2 };
    const east = (p: { center: { x: number } }) => p.center.x + pw / 2 > centre.x;
    for (const k of ["civic", "entertainment", "education"]) assert.ok(inner(l).filter((p) => p.kind === k).some((p) => !east(p)), `${k} on the dry side`);
    assert.ok(crafts(l).every((p) => !east(p)), "the craft road is a dry one");
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

  it("sets the farms and crafts beyond the wall, along both sides of the roads, each facing its road", () => {
    const xs = town.fortifications.map((p) => p.center.x);
    const zs = town.fortifications.map((p) => p.center.z);
    for (const f of [...farms(town), ...crafts(town)]) assert.ok(f.center.x < Math.min(...xs) || f.center.x > Math.max(...xs) || f.center.z < Math.min(...zs) || f.center.z > Math.max(...zs));
    assert.deepEqual([...new Set(farms(town).map((f) => f.facing))].sort((a, b) => a - b), [0, 90, 180, 270], "farms on all four roads, both sides");
  });

  it("measures the walled town for site selection, wall included", () => {
    const n = town.blocks;
    const [pw, pd] = BUILTIN_RULES.layout.parcelSizeMm;
    const pitch = Math.max(bw * pw, bd * pd) + BUILTIN_RULES.layout.streetWidthMm;
    assert.equal(townHalfExtentM(136, BUILTIN_RULES), Math.ceil((n * pitch + BUILTIN_RULES.layout.streetWidthMm + 2 * (w.setbackMm + w.thicknessMm)) / 2000));
  });
});
