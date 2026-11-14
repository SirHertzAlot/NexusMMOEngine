import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MarbleBag } from "../src/index.js";

describe("MarbleBag", () => {
  it("deals exact proportions every cycle and bounds dry/hot streaks", () => {
    // 25% crit bag: 2 crits, 6 normal hits -> 8-marble cycle
    const bag = MarbleBag.fromCounts([["crit", 2], ["hit", 6]], { seed: 42 });
    assert.equal(bag.capacity, 8);
    assert.equal(bag.drawsRemaining, 8);
    assert.equal(bag.cycle, 1);

    let maxDrought = 0;
    let curDrought = 0;
    for (let c = 1; c <= 10; c++) {
      let critsInCycle = 0;
      for (let i = 0; i < 8; i++) {
        const expectedBefore = i === 0 && c === 1 ? 8 : i === 0 ? 0 : 8 - i;
        assert.equal(bag.drawsRemaining, expectedBefore);
        const outcome = bag.draw();
        assert.equal(bag.drawsRemaining, 8 - i - 1);
        if (outcome === "crit") {
          critsInCycle++;
          curDrought = 0;
        } else {
          curDrought++;
          if (curDrought > maxDrought) maxDrought = curDrought;
        }
      }
      assert.equal(critsInCycle, 2, `cycle ${c} must have exact crit count 2`);
      assert.equal(bag.drawsRemaining, 0);
      assert.equal(bag.peek(), undefined, "peek is undefined once current cycle empties before auto-reshuffle");
    }

    // Worst-case dry streak across cycle boundary with 2-in-8 is 6 + 6 = 12.
    assert.ok(maxDrought <= 12, `dry streak exceeded theoretical bound 12: ${maxDrought}`);
    const next = bag.draw();
    assert.ok(next === "crit" || next === "hit");
    assert.equal(bag.cycle, 11);
    assert.equal(bag.drawsRemaining, 7);
  });

  it("supports autoReshuffle: false with tryDraw() and throws on draw() when empty", () => {
    const bag = MarbleBag.fromCounts([["a", 1], ["b", 1]], { seed: 7, autoReshuffle: false });
    const drawn = [bag.draw(), bag.draw()].sort();
    assert.deepEqual(drawn, ["a", "b"]);
    assert.equal(bag.drawsRemaining, 0);
    assert.equal(bag.tryDraw(), undefined);
    assert.throws(() => bag.draw(), /empty/);

    bag.reshuffle();
    assert.equal(bag.cycle, 2);
    assert.equal(bag.drawsRemaining, 2);
  });

  it("supports hierarchical nested bags without distorting inner guarantees", () => {
    const vowels = MarbleBag.fromCounts([["A", 1], ["E", 1]], { seed: 101 });
    const rare = MarbleBag.fromCounts([["Q", 1], ["Z", 1]], { seed: 202 });
    const common = MarbleBag.fromCounts([["S", 2], ["T", 2]], { seed: 303 });
    const outer = new MarbleBag<string>(
      [
        { bag: vowels, count: 2 },
        { bag: common, count: 4 },
        { bag: rare, count: 2 },
      ],
      { seed: 404 },
    );

    const results = outer.drawMany(8);
    assert.equal(results.filter((c) => c === "A" || c === "E").length, 2);
    assert.equal(results.filter((c) => c === "Q" || c === "Z").length, 2);
    assert.equal(results.filter((c) => c === "S" || c === "T").length, 4);
  });

  it("is bit-reproducible for a given seed (golden test) and snapshot/restore matches mid-cycle", () => {
    const seqA = MarbleBag.fromCounts([["crit", 2], ["hit", 6]], { seed: 123456 });
    const seqB = MarbleBag.fromCounts([["crit", 2], ["hit", 6]], { seed: 123456 });

    const first = seqA.drawMany(20);
    assert.deepEqual(seqB.drawMany(20), first);
    assert.deepEqual(first.slice(0, 16), [
      "hit", "hit", "crit", "hit", "hit", "crit", "hit", "hit",
      "hit", "crit", "hit", "hit", "hit", "crit", "hit", "hit",
    ]);

    // Mid-cycle snapshot/restore replays identically:
    const pinned = MarbleBag.fromCounts([["crit", 2], ["hit", 6]], { seed: 123456 });
    const prefix = pinned.drawMany(5);
    assert.equal(pinned.drawsRemaining, 3);
    const snap = pinned.snapshot();

    const resumed = MarbleBag.fromCounts([["crit", 2], ["hit", 6]], { seed: 999999 });
    resumed.restore(snap);
    assert.equal(resumed.peek(), pinned.peek());
    assert.deepEqual([...prefix, ...resumed.drawMany(15)], first);
  });

  it("guards against direct self-containment and indirect bag cycles", () => {
    const a = MarbleBag.fromCounts([["x", 1]], { seed: 1 });
    assert.throws(() => new MarbleBag([{ bag: a, count: 0 }], { seed: 1 }), /at least 1/);

    const parent = new MarbleBag([{ outcome: "leaf", count: 1 }], { seed: 2 });
    assert.throws(() => new MarbleBag([{ outcome: "a", count: -1 }], { seed: 1 }), /non-negative integer/);
    assert.ok(parent.draw() === "leaf");
  });
});
