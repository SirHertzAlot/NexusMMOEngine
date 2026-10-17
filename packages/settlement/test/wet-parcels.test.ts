/**
 * A town beside water: parcels whose footprint is not dry (a shore parcel, a river or lake cell,
 * under water) are dropped before the structures are solved, and the grid grows a block row at a time
 * to make up for them; the town is built on what is dry or fails saying why, never half-drowned.
 * `site` is where the town will stand (the scene's origin) and the world's own dryness test
 * (engine-core habitat.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_RULES, generateSettlement, settlementScene, townCentreMm } from "../src/index.js";

const base = { settlementId: "0182", seed: 1234, population: 600 };
const plain = generateSettlement(base);
if (!plain.ok) throw new Error(plain.error.message);

describe("settlements beside water", () => {
  const origin: [number, number] = [1000, 2000];
  /** The sea fills the south-east corner: dry unless east of x = 960 and south of z = 1960 (the town spans about +-150 m). */
  const dry = (x: number, z: number): boolean => !(x > origin[0] - 40 && z > origin[1] - 40);
  const r = generateSettlement({ ...base, site: { origin, dry } });

  it("drops the parcels that are not dry, grows a block row to make up, and builds on what is left", () => {
    assert.ok(r.ok, r.ok ? "" : r.error.message);
    assert.ok(r.events.some((e) => e.event === "wet_parcels_dropped" && (e.data as { extraBlocks: number }).extraBlocks >= 1), "this shore needed a bigger grid");
    assert.equal(r.manifest.structures.length, r.manifest.parcels.length, "a structure on every parcel that is left");
    const c = townCentreMm(r.manifest.roads.nodes);
    for (const p of r.manifest.parcels) assert.ok(dry(origin[0] + (p.center.x - c.x) / 1000, origin[1] + (p.center.z - c.z) / 1000), `${p.id} is dry`);
  });

  it("the scene has a node per structure and none of its footprints (corners included) touches the water", () => {
    assert.ok(r.ok);
    const scene = settlementScene(r.manifest, BUILTIN_RULES, { origin });
    const kids = scene.nodes[0]!.children!;
    assert.equal(kids.length, r.manifest.structures.length + r.manifest.fortifications.length, "a node per building and per wall piece left standing");
    assert.ok(r.manifest.wallOpenToWater > 0, "the wall is not built in the sea: it is open to the water");
    for (const n of kids) {
      const [px, , pz] = n.transform!.position!;
      const s = n.components!.Structure!;
      for (const dx of [-0.5, 0.5]) for (const dz of [-0.5, 0.5]) assert.ok(dry(origin[0] + (px as number) + dx * (s.width as number), origin[1] + (pz as number) + dz * (s.depth as number)), `${n.id} corner dry`);
    }
  });

  it("a dry site changes nothing: the same town as with no site", () => {
    const allDry = generateSettlement({ ...base, site: { origin, dry: () => true } });
    assert.ok(allDry.ok);
    assert.equal(allDry.manifest.hash, plain.manifest.hash);
  });

  it("is deterministic for the same site", () => {
    const again = generateSettlement({ ...base, site: { origin, dry } });
    assert.ok(again.ok && r.ok);
    assert.equal(again.manifest.hash, r.manifest.hash);
  });

  it("fails with a clear message when the site is too wet to house and serve the town", () => {
    const wetEast = generateSettlement({ ...base, site: { origin, dry: (x) => x < origin[0] - 30 } });
    assert.equal(wetEast.ok, false);
    if (!wetEast.ok) {
      assert.equal(wetEast.error.stage, "structures");
      assert.match(wetEast.error.message, /too wet.*parcels are not dry.*choose a drier site/);
    }
  });
});
