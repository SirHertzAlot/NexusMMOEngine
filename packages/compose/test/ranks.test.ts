/**
 * The rank ladder: shares start even (100/N) and tilt so each rank takes
 * less than the one below, always summing to exactly 100; names come
 * from the count; budgets rise; signals switch on up the ladder.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLadder, DEFAULT_LADDER, inferRankNames, ladderProblems, loadLadder, rankBudget, rankShares } from "../src/index.js";

const sum = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe("rank shares", () => {
  it("give five ranks 30/25/20/15/10: legendary 10%", () => {
    assert.deepEqual(rankShares(5), [30, 25, 20, 15, 10]);
    assert.deepEqual(DEFAULT_LADDER.ranks.map((r) => [r.id, r.share]), [["common", 30], ["uncommon", 25], ["rare", 20], ["epic", 15], ["legendary", 10]]);
  });

  it("always sum to exactly 100 and fall strictly, lowest rank most, for any count", () => {
    for (let n = 1; n <= 12; n++) {
      const s = rankShares(n);
      assert.equal(s.length, n);
      assert.equal(sum(s), 100, `${n} ranks: ${s.join(" + ")}`);
      for (let k = 1; k < n; k++) assert.ok(s[k] < s[k - 1], `${n} ranks: rank ${k} below rank ${k - 1}`);
      // The tilt is about the even share: it sits in the middle.
      if (n > 1) assert.ok(s[0] > 100 / n && s[n - 1] < 100 / n);
      for (const x of s) assert.equal(Math.round(x * 100) / 100, x, "to 0.01");
    }
    assert.deepEqual(rankShares(3), [50, 33.33, 16.67]);
  });

  it("take the top rank's share as given, within reason", () => {
    const s = rankShares(5, 5);
    assert.equal(s[4], 5);
    assert.equal(sum(s), 100);
    assert.throws(() => rankShares(5, 20), /below the even share/);
    assert.throws(() => rankShares(5, 0), /above 0/);
    assert.throws(() => rankShares(0), /at least one rank/);
  });
});

describe("the ladder", () => {
  it("infers names from the count, with legendary on top up to five", () => {
    assert.deepEqual(inferRankNames(5), ["common", "uncommon", "rare", "epic", "legendary"]);
    assert.deepEqual(inferRankNames(3), ["common", "rare", "legendary"]);
    assert.equal(inferRankNames(7)[6], "divine");
    assert.deepEqual(inferRankNames(9).slice(7), ["divine-2", "divine-3"]);
    assert.ok(buildLadder(4).ranks.every((r, k, a) => k === 0 || r.share < a[k - 1].share));
  });

  it("raises budgets and signals up the ladder", () => {
    assert.deepEqual(DEFAULT_LADDER.ranks.map((r) => r.budget), [1, 2, 4, 7, 11]);
    for (const n of [2, 3, 7, 10]) {
      const b = Array.from({ length: n }, (_, k) => rankBudget(k, n));
      assert.equal(b[0], 1);
      assert.ok(b[n - 1] >= 11, `${n} ranks: the top can afford everything (${b})`);
      for (let k = 1; k < n; k++) assert.ok(b[k] > b[k - 1], `${n} ranks: rising (${b})`);
    }
    const [common, uncommon, rare, epic, legendary] = DEFAULT_LADDER.ranks.map((r) => r.signals);
    assert.ok(!Object.values(common).some(Boolean), "common: none");
    assert.ok(uncommon.tint && !uncommon.particles);
    assert.ok(rare.particles && !rare.aura);
    assert.ok(epic.aura && epic.runes && !epic.uniqueAbility);
    assert.ok(Object.values(legendary).every(Boolean), "legendary: everything");
  });

  it("checks a tuned ladder: shares falling and summing to 100, budgets rising, names unique", () => {
    const l = buildLadder(3);
    assert.deepEqual(ladderProblems(l), []);
    const bad = { ranks: l.ranks.map((r, k) => ({ ...r, id: k === 2 ? "common" : r.id, share: [40, 45, 16.67][k], budget: [1, 1, 5][k] })) };
    const p = ladderProblems(bad).join("\n");
    assert.match(p, /sum to 101.67%/);
    assert.match(p, /below common's/);
    assert.match(p, /budget \(1\) must be above/);
    assert.match(p, /named twice/);
  });

  it("loads from names or full ranks, listing every problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "ladder-"));
    assert.equal(loadLadder(), DEFAULT_LADDER);
    const names = join(dir, "names.json");
    writeFileSync(names, JSON.stringify({ ranks: ["worn", "fine", "masterwork", "relic"] }));
    const l = loadLadder(names);
    assert.deepEqual(l.ranks.map((r) => r.id), ["worn", "fine", "masterwork", "relic"]);
    assert.equal(sum(l.ranks.map((r) => r.share)), 100);
    const full = join(dir, "full.json");
    writeFileSync(full, JSON.stringify({ ranks: [{ ...l.ranks[0], share: 60 }, { ...l.ranks[1], share: 60 }] }));
    assert.throws(() => loadLadder(full), /sum to 120%/);
  });
});
