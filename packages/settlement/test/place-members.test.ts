/**
 * The people of the places between the towns (SG7, RS4): derived from the place id alone, so the same
 * homestead has the same family on every bake and no random stream moves.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { placeMembers } from "../src/places.js";

describe("placeMembers", () => {
  it("makes a homestead's family: its size, a grown head, the grown on the holding, the young and old about the house", () => {
    const fam = placeMembers({ id: "P0001", kind: "homestead", family: 8, works: "farm" });
    assert.equal(fam.length, 8);
    assert.deepEqual([fam[0]!.cohort, fam[0]!.role, fam[0]!.workplace], ["adult", "farmer", "P0001-farm"]);
    assert.equal(new Set(fam.map((m) => m.id)).size, 8, "ids are unique");
    assert.ok(fam.every((m) => m.home === "P0001" && m.household === "P0001"));
    for (const m of fam) {
      if (m.cohort === "child" || m.cohort === "elder") assert.equal(m.workplace, undefined, `${m.cohort} stays about the house`);
      else assert.equal(m.workplace, "P0001-farm");
    }
    assert.deepEqual(placeMembers({ id: "P0001", kind: "homestead", family: 8, works: "farm" }), fam, "the same every time");
    assert.equal(placeMembers({ id: "P0002", kind: "homestead", family: 4, works: "ranch" })[0]!.role, "rancher");
  });

  it("spreads ages like a town across many families", () => {
    const all = Array.from({ length: 200 }, (_, i) => placeMembers({ id: `P${i}`, kind: "homestead", family: 10, works: "farm" })).flat();
    const share = (c: string): number => all.filter((m) => m.cohort === c).length / all.length;
    assert.ok(share("child") > 0.2 && share("child") < 0.35, `children ${share("child")}`);
    assert.ok(share("elder") > 0.08 && share("elder") < 0.2, `elders ${share("elder")}`);
    assert.ok(share("adult") > 0.35, `adults ${share("adult")}`);
  });

  it("gives an inn its keeper and an outpost its guards, and a shack nobody", () => {
    assert.deepEqual(placeMembers({ id: "P9", kind: "inn" }).map((m) => m.role), ["innkeeper", "inn hand"]);
    const guards = placeMembers({ id: "P8", kind: "guard_outpost" });
    assert.equal(guards.length, 3);
    assert.ok(guards.every((g) => g.class === "guard" && g.workplace === "P8"));
    assert.deepEqual(placeMembers({ id: "P7", kind: "shack" }), []);
  });
});
