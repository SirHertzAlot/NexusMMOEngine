/**
 * Property lines (SG12): a fence along each line two neighbouring plots share, back to front less the setback, and
 * nowhere else.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, generateSettlement, settlementScene, scaledLayout } from "../src/index.js";

const must = (r: ReturnType<typeof generateSettlement>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.manifest;
};
const town = must(generateSettlement({ settlementId: "0001", seed: 1234, population: 668 }));
const fences = town.props.filter((p) => p.kind === "fence");
const F = BUILTIN_RULES.props!.fences;
const [pw, pd] = scaledLayout(BUILTIN_RULES, 1).parcelMm;
const parcels = new Map(town.parcels.map((p) => [p.id, p]));
const archetype = new Map(town.structures.map((s) => [s.parcel, s.archetype]));
/** The street's side of a plot: the unit vector from its centre toward the street, and along it. */
const axes = (facing: number) => {
  const out: [number, number] = facing === 0 ? [0, 1] : facing === 90 ? [1, 0] : facing === 180 ? [0, -1] : [-1, 0];
  return { out, along: [out[1], -out[0]] as [number, number] };
};

describe("property fences", () => {
  it("fence the shared lines between homes, six pieces a line, and the town still passes every gate", () => {
    assert.ok(fences.length > 0);
    const lines = new Map<string, number>();
    for (const f of fences) lines.set(f.parcel!, (lines.get(f.parcel!) ?? 0) + 1);
    const per = Math.floor((pd - F.frontSetbackMm) / F.pieceMm);
    for (const [, n] of lines) assert.equal(n, per, "every line has the same number of pieces");
    assert.deepEqual(town.validation.filter((g) => !g.ok), []);
  });

  it("stand on the boundary between two plots of the same street, never on a plot's own ground", () => {
    for (const f of fences) {
      const p = parcels.get(f.parcel!)!;
      const { along } = axes(p.facing);
      const across = (f.center.x - p.center.x) * along[0] + (f.center.z - p.center.z) * along[1];
      assert.ok(Math.abs(across - pw / 2) < 1, `on the line half a plot along the street (${across})`);
      const q = town.parcels.find((o) => Math.abs(o.center.x - (p.center.x + along[0] * pw)) < 1 && Math.abs(o.center.z - (p.center.z + along[1] * pw)) < 1);
      assert.ok(q && q.facing === p.facing && q.kind === "housing", "a plot of the same street on the far side");
    }
  });

  it("leave the street frontage open: the setback from the street, and a piece never past the plot's back", () => {
    for (const f of fences) {
      const p = parcels.get(f.parcel!)!;
      const { out } = axes(p.facing);
      const toStreet = (f.center.x - p.center.x) * out[0] + (f.center.z - p.center.z) * out[1];
      const edge = toStreet + F.pieceMm / 2; // the piece's end nearest the street
      assert.ok(edge <= pd / 2 - F.frontSetbackMm + 1, `clear of the street by the setback (${edge})`);
      assert.ok(toStreet - F.pieceMm / 2 >= -pd / 2 - 1, "inside the plot's back");
    }
  });

  it("each line is drawn once, and never between two open plots", () => {
    const seen = new Set<string>();
    for (const f of fences) {
      const k = `${f.center.x},${f.center.z}`;
      assert.ok(!seen.has(k), "no piece twice");
      seen.add(k);
    }
    const open = new Set([BUILTIN_RULES.openGround?.park, BUILTIN_RULES.openGround?.lot, "garden"]);
    for (const f of fences) {
      const p = parcels.get(f.parcel!)!;
      const { along } = axes(p.facing);
      const q = town.parcels.find((o) => Math.abs(o.center.x - (p.center.x + along[0] * pw)) < 1 && Math.abs(o.center.z - (p.center.z + along[1] * pw)) < 1)!;
      assert.ok(!open.has(archetype.get(p.id) ?? "") || !open.has(archetype.get(q.id) ?? ""), "at least one side is lived in");
    }
  });

  it("run along the line: the piece is long across the street, not along it", () => {
    for (const f of fences.slice(0, 40)) {
      const p = parcels.get(f.parcel!)!;
      // facing 0 and 180 plots run their lines along z, so the piece's long side is turned a quarter
      assert.equal(f.yawDeg % 180 === 90, p.facing % 180 === 0);
      assert.deepEqual(f.sizeMm, [F.pieceMm, BUILTIN_RULES.props!.sizesMm.fence[1]]);
    }
  });

  it("can be turned off, and reach the scene as a Structure of their own kind", () => {
    const off = must(generateSettlement({ settlementId: "0001", seed: 1234, population: 668, rules: { ...BUILTIN_RULES, props: { ...BUILTIN_RULES.props!, fences: { ...F, enabled: false } } } }));
    assert.equal(off.props.filter((p) => p.kind === "fence").length, 0);
    const scene = settlementScene(town, BUILTIN_RULES, { origin: [0, 0] });
    const nodes = scene.nodes[0]!.children!.filter((n) => (n.components!.Structure as { kind: string }).kind === "fence");
    assert.equal(nodes.length, fences.length);
    const s = nodes[0]!.components!.Structure as { width: number; depth: number; height: number };
    assert.ok(Math.abs(s.width - F.pieceMm / 1000) < 1e-9 && s.height === BUILTIN_RULES.props!.sizesMm.fence[2] / 1000);
  });
});
