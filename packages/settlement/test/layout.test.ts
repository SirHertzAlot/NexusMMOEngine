/**
 * The town's layout: a street grid (roads as a connected graph), blocks split
 * between the four district kinds, and a parcel on every block plot. All
 * geometry is integer millimetres, and the same seed lays out the same town.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, DISTRICT_KINDS, layOut, streams } from "../src/index.js";

const lay = (households: number, seed = 1) => layOut("0182", households, BUILTIN_RULES, streams(seed));

describe("layOut", () => {
  const town = lay(136);
  const [bw, bd] = BUILTIN_RULES.layout.block;

  it("gives enough parcels for the households, in whole blocks", () => {
    assert.ok(town.parcels.length >= Math.ceil((136 * BUILTIN_RULES.layout.parcelsPerHouseholdPermille) / 1000));
    assert.equal(town.parcels.length, town.blocks * town.blocks * bw * bd);
  });

  it("splits the blocks between the district kinds as the shares say, none left over", () => {
    assert.deepEqual(town.districts.map((d) => d.kind).sort(), [...DISTRICT_KINDS].sort());
    assert.equal(town.districts.reduce((a, d) => a + d.blocks, 0), town.blocks * town.blocks);
    const housing = town.districts.find((d) => d.kind === "housing")!;
    const shopping = town.districts.find((d) => d.kind === "shopping")!;
    assert.ok(housing.blocks > shopping.blocks);
  });

  it("puts every parcel in one district, with integer-millimetre geometry and road frontage", () => {
    const ids = new Set(town.districts.map((d) => d.id));
    for (const p of town.parcels) {
      assert.ok(ids.has(p.district));
      assert.ok(Number.isInteger(p.center.x) && Number.isInteger(p.center.z));
      assert.equal(p.areaM2, (BUILTIN_RULES.layout.parcelSizeMm[0] * BUILTIN_RULES.layout.parcelSizeMm[1]) / 1_000_000);
      assert.equal(p.roadFrontage, true);
    }
    assert.equal(new Set(town.parcels.map((p) => p.id)).size, town.parcels.length);
  });

  it("builds a sparse street grid that is connected, with primary roads through the middle", () => {
    const n = town.blocks;
    assert.equal(town.roads.nodes.length, (n + 1) * (n + 1));
    assert.equal(town.roads.edges.length, 2 * n * (n + 1));
    assert.ok(town.roads.edges.some((e) => e.roadClass === "primary_town_road"));
    assert.ok(town.roads.edges.some((e) => e.roadClass === "secondary_street"));
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

  it("is deterministic per seed, and the seed moves the outer districts", () => {
    assert.deepEqual(lay(136, 5), lay(136, 5));
    const kindsAt = (seed: number) => JSON.stringify(lay(136, seed).parcels.map((p) => [p.gx, p.gz, p.kind]));
    assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(kindsAt)).size > 1);
  });
});
