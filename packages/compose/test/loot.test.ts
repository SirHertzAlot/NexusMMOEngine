/**
 * The loot pool: exact counts per rank (and per source within a rank), one
 * of a kind at the top, held items kept through a rebake, and a report
 * whose numbers follow from the pool.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apportion, bakeLootPool, buildLadder, DEFAULT_LADDER, DEFAULT_SOURCES, reportMarkdown } from "../src/index.js";

describe("apportion", () => {
  it("splits exactly, by weight, largest remainder first", () => {
    assert.deepEqual(apportion(10, [1, 1, 1]), [4, 3, 3]);
    assert.deepEqual(apportion(1000, [30, 25, 20, 15, 10]), [300, 250, 200, 150, 100]);
    for (let total = 0; total < 60; total++) assert.equal(apportion(total, [0.3, 2, 0.01, 5]).reduce((a, b) => a + b, 0), total);
    assert.deepEqual(apportion(5, [0, 0]), [5, 0], "no weights: all to the first");
  });
});

describe("bakeLootPool", () => {
  const pool = bakeLootPool({ size: 400, seed: 3 });

  it("holds exactly each rank's share", () => {
    assert.equal(pool.items.length, 400);
    const want = apportion(400, DEFAULT_LADDER.ranks.map((r) => r.share));
    DEFAULT_LADDER.ranks.forEach((r, k) => {
      assert.equal(pool.items.filter((i) => i.rank === r.id).length, want[k], r.id);
      assert.equal(pool.report.byRank[r.id].count, want[k]);
    });
    assert.equal(pool.items.filter((i) => i.rank === "legendary").length, 40, "10% legendary");
    for (const i of pool.items) assert.equal(i.bundle.Rank.id, i.rank);
  });

  it("gives low ranks to mobs and high ranks to bosses", () => {
    const b = pool.report.bySource;
    assert.ok(b.common.mob > b.common.boss);
    assert.ok(b.legendary.boss > b.legendary.mob);
  });

  it("makes every top-rank item one of a kind, and is deterministic", () => {
    const top = pool.items.filter((i) => i.rank === "legendary").map((i) => i.id);
    assert.equal(new Set(top).size, top.length);
    assert.deepEqual(bakeLootPool({ size: 400, seed: 3 }).items.map((i) => i.id), pool.items.map((i) => i.id));
  });

  it("keeps held items through a rebake, still at the exact counts", () => {
    const held = pool.items.filter((i) => i.rank === "legendary").slice(0, 5).concat(pool.items.filter((i) => i.rank === "common").slice(0, 3));
    const again = bakeLootPool({ size: 400, seed: 99, held });
    for (const h of held) assert.ok(again.items.some((i) => i.id === h.id && i.source === h.source), `${h.id} kept`);
    assert.equal(again.report.kept, 8);
    assert.equal(again.items.filter((i) => i.rank === "legendary").length, 40);
    const top = again.items.filter((i) => i.rank === "legendary").map((i) => i.id);
    assert.equal(new Set(top).size, top.length, "new legendaries don't copy held ones");
    assert.throws(() => bakeLootPool({ size: 10, held: pool.items.filter((i) => i.rank === "legendary").slice(0, 5) }), /more held legendary/);
  });

  it("reports hours to obtain from the pool and the drop rates", () => {
    const r = pool.report;
    const mobItems = pool.items.filter((i) => i.source === "mob").length;
    const mobRate = DEFAULT_SOURCES.find((s) => s.id === "mob")!.dropsPerHour;
    const expected = Math.round(((mobItems / r.bySource.common.mob) / mobRate) * 100) / 100;
    assert.equal(r.hoursToObtain.common.mob, expected);
    for (const rank of DEFAULT_LADDER.ranks) {
      const hours = Object.values(r.hoursToObtain[rank.id]).filter((h): h is number => h !== null);
      assert.equal(r.fastestHours[rank.id], Math.min(...hours));
    }
    assert.ok(r.fastestHours.legendary! > r.fastestHours.common!, "the top rank takes longest");
    const md = reportMarkdown(r);
    assert.match(md, /\| Legendary \| 40 \| 10% \| 40 \|/);
  });

  it("works on any ladder", () => {
    const three = buildLadder(3);
    const p = bakeLootPool({ size: 90, ladder: three });
    assert.deepEqual(three.ranks.map((r) => p.report.byRank[r.id].count), apportion(90, three.ranks.map((r) => r.share)));
    assert.throws(() => bakeLootPool({ size: 0 }), /positive whole number/);
  });
});
