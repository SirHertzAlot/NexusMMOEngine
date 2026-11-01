/**
 * Residents' days (R1): the schedule is a pure function of npc, clock and town, stable across calls,
 * with workers at their workplace by day and everyone home at night.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashOf, scheduleAt, SQUARE, type TownView } from "../src/schedule.js";
import type { Npc } from "../src/occupancy.js";

const ARCH: Record<string, string> = { h1: "house", b1: "bakery", c1: "chapel", t1: "tavern", m1: "market" };
const town: TownView = { archetypeOf: (s) => ARCH[s], tavernNear: () => "t1" };
const baker: Npc = { id: "npc_a", household: "hh", home: "h1", cohort: "adult", class: "artisan", role: "worker", workplace: "b1" };
const clerk: Npc = { id: "npc_b", household: "hh", home: "h1", cohort: "adult", class: "clergy", role: "worker", workplace: "c1" };
const child: Npc = { id: "npc_c", household: "hh", home: "h1", cohort: "child", class: "peasant", role: "resident" };
const beggar: Npc = { id: "npc_d", household: null, home: null, cohort: "adult", class: "peasant", role: "beggar" };
const at = (hour: number): number => hour / 24;

describe("scheduleAt", () => {
  it("is deterministic", () => {
    assert.deepEqual(scheduleAt(baker, at(10), town), scheduleAt(baker, at(10), town));
    assert.equal(hashOf("npc_a"), hashOf("npc_a"));
  });

  it("puts workers at the workplace by day (outdoors at a shop front, indoors in a chapel) and home at night", () => {
    assert.deepEqual(scheduleAt(baker, at(12), town), { anchor: "b1", outdoors: true, activity: "work" });
    assert.deepEqual(scheduleAt(clerk, at(12), town), { anchor: "c1", outdoors: false, activity: "work" });
    assert.deepEqual(scheduleAt(baker, at(2), town), { anchor: "h1", outdoors: false, activity: "sleep" });
    assert.deepEqual(scheduleAt(baker, at(23.5), town), { anchor: "h1", outdoors: false, activity: "sleep" });
  });

  it("sends some workers to the tavern of an evening, indoors", () => {
    const evenings = Array.from({ length: 200 }, (_, i) => scheduleAt({ ...baker, id: `npc_${i}` }, at(19), town));
    const tavern = evenings.filter((p) => p.activity === "tavern");
    assert.ok(tavern.length > 40 && tavern.length < 120, `about 40% (${tavern.length})`);
    assert.ok(tavern.every((p) => p.anchor === "t1" && !p.outdoors));
  });

  it("keeps children and the unemployed about the square by day, the homeless there all day, everyone else home at night", () => {
    assert.deepEqual(scheduleAt(child, at(12), town), { anchor: SQUARE, outdoors: true, activity: "idle" });
    assert.equal(scheduleAt(child, at(3), town).anchor, "h1");
    assert.equal(scheduleAt(beggar, at(3), town).anchor, SQUARE);
    assert.equal(scheduleAt(beggar, at(15), town).outdoors, true);
  });

  it("shifts block edges per person so a town does not move in lockstep", () => {
    const outAt8 = Array.from({ length: 100 }, (_, i) => scheduleAt({ ...baker, id: `npc_${i}` }, at(8), town).activity);
    assert.ok(outAt8.includes("work") && outAt8.includes("sleep"), "some are at work and some still home at 08:00");
  });

  it("falls back to the square for an anchor the town does not know", () => {
    assert.equal(scheduleAt({ ...baker, workplace: "gone" }, at(12), town).anchor, SQUARE);
  });

  it("takes the town to church on Sunday morning and keeps workers from work that day", () => {
    const withChurch: TownView = { ...town, churchNear: (home) => (home === "h1" ? "c1" : undefined) };
    const worship = Array.from({ length: 100 }, (_, i) => scheduleAt({ ...baker, id: `npc_${i}` }, at(9.5), withChurch, 0));
    assert.ok(worship.filter((p) => p.activity === "worship").length > 90, "nearly everyone is at worship at 09:30 on a Sunday");
    assert.ok(worship.every((p) => p.activity !== "worship" || (p.anchor === "c1" && !p.outdoors)), "worship is in the church, indoors");
    assert.equal(scheduleAt(baker, at(12), withChurch, 0).activity, "idle", "no work on Sunday");
    assert.equal(scheduleAt(baker, at(12), withChurch, 1).activity, "work", "the next day is a working day");
  });

  it("does not send anyone to worship without a church, and with no day given keeps the ordinary day", () => {
    assert.notEqual(scheduleAt(baker, at(9.5), town, 0).activity, "worship");
    assert.equal(scheduleAt(baker, at(12), town).activity, "work");
  });
});
