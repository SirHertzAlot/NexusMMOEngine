/**
 * Farm yard dressing (WL1): a farm homestead's scene carries a tool stand, a produce pile and a well beside
 * the house, outside its footprint and on the house's own turn. A ranch gets none, and the scene stays valid.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScene, type SceneNode } from "@mmo-engine/scene";
import { placesScene, type Place, type PlacesPlan } from "../src/index.js";

function plan(places: Place[]): PlacesPlan {
  return { places, routes: [], counts: {} } as unknown as PlacesPlan;
}

const kids = (scene: ReturnType<typeof placesScene>): SceneNode[] => scene.nodes[0]!.children!;

describe("farm yard dressing in the places scene", () => {
  const farm: Place = { id: "h1", kind: "homestead", x: 100, z: 100, works: "farm", family: 4 };
  const ranch: Place = { id: "h2", kind: "homestead", x: 300, z: 100, works: "ranch", family: 4 };

  it("puts a tool stand, a produce pile and a well beside a farm house, and nothing beside a ranch", () => {
    const scene = placesScene(plan([farm, ranch]));
    assert.deepEqual(validateScene(scene), []);
    const names = kids(scene).map((n) => n.id);
    for (const k of ["farm_tools", "farm_produce", "farm_yard"]) assert.ok(names.includes(`h1-${k}`), `the farm has ${k}`);
    assert.equal(names.filter((n) => n.startsWith("h2-") && /farm_/.test(n)).length, 0, "a ranch has no farm dressing");
  });

  it("keeps the dressing clear of the house footprint (10 by 8 m, centred on the house)", () => {
    const scene = placesScene(plan([farm]));
    const house = kids(scene).find((n) => n.id === "h1")!;
    for (const n of kids(scene).filter((n) => n.id.startsWith("h1-farm_"))) {
      const np = n.transform!.position!;
      const hp = house.transform!.position!;
      const dx = Math.abs(np[0] - hp[0]);
      const dz = Math.abs(np[2] - hp[2]);
      assert.ok(dx > 5 || dz > 4, `${n.id} at ${dx},${dz} m from the house centre is outside its footprint`);
    }
  });
});
