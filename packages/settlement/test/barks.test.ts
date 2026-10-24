/**
 * Generated barks (R5): the same npc says the same thing all day and something else another day;
 * the hour, the work, the age and a raid shape what is said; nothing is authored per npc.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { barkFor, partOfDay } from "../src/barks.js";
import type { Npc } from "../src/occupancy.js";

const baker: Npc = { id: "npc_a", household: "h", home: "h1", cohort: "adult", class: "artisan", role: "worker", workplace: "b1" };

describe("barkFor", () => {
  it("is the same all day for one npc and varies across days and people", () => {
    const at = (day: number, tod = 0.5): string => barkFor(baker, { timeOfDay: tod, day, workplace: "bakery" });
    assert.equal(at(3, 0.55), at(3, 0.6), "same day, same part of the day");
    const days = new Set(Array.from({ length: 20 }, (_, d) => at(d)));
    assert.ok(days.size > 3, `varies by day (${days.size})`);
    const people = new Set(Array.from({ length: 30 }, (_, i) => barkFor({ ...baker, id: `npc_${i}` }, { timeOfDay: 0.5, day: 1, workplace: "bakery" })));
    assert.ok(people.size > 3, `varies by person (${people.size})`);
  });

  it("greets by the hour, talks shop by workplace, and speaks to the young and the poor in their own way", () => {
    assert.deepEqual(["morning", "day", "evening", "night"], [0.25, 0.5, 0.75, 0.02].map(partOfDay));
    const bake = barkFor(baker, { timeOfDay: 0.5, day: 2, workplace: "bakery" });
    assert.match(bake, /bread|flour|loaves/i);
    const smith = barkFor({ ...baker, id: "npc_s" }, { timeOfDay: 0.5, day: 2, workplace: "smithy" });
    assert.match(smith, /forge|iron|spark|horse/i);
    const kid = new Set(Array.from({ length: 30 }, (_, d) => barkFor({ ...baker, id: "kid", cohort: "child", workplace: undefined }, { timeOfDay: 0.5, day: d })));
    assert.ok([...kid].some((l) => /sweets|play|strangers|found/.test(l)));
    const poor = barkFor({ ...baker, id: "beg", role: "beggar", workplace: undefined }, { timeOfDay: 0.5, day: 5 });
    assert.match(poor, /coin|helps|Bless/);
  });

  it("has raid lines of its own, and the same one however late", () => {
    const raid = barkFor(baker, { timeOfDay: 0.5, day: 1, raid: true, workplace: "bakery" });
    assert.match(raid, /Raiders|Run|terrible|Bar the doors/);
    assert.equal(raid, barkFor(baker, { timeOfDay: 0.1, day: 1, raid: true }));
  });
});
