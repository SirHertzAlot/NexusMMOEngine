/**
 * Composing entities by WFC: every slot fits the base, the kind and the
 * rank; nothing twice, nothing a part excludes; signals match the
 * entity's elements; spending stays within the rank's budget and above
 * the rank below; higher ranks come out stronger; the bundle and prefab
 * say it all; the same inputs give the same entity.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_CATALOG, buildLadder, composeCreature, composeItem, DEFAULT_LADDER, elementOf, loadCatalog, SIGNAL_SLOTS,
  type Composition, type CreatureBase,
} from "../src/index.js";

const CREATURES: CreatureBase[] = [
  { id: "fiend", name: "Fiend", tags: ["demon", "fire"], stats: { health: 120, power: 14 } },
  { id: "lich", name: "Lich", tags: ["undead"], stats: { health: 90, spell: 20 } },
  { id: "troll", name: "Troll", tags: ["organic"], stats: { health: 200, power: 16 } },
  { id: "elemental-shard", name: "Elemental shard", tags: ["otherworldly", "frost"], stats: { health: 70 } },
];
const RANKS = DEFAULT_LADDER.ranks.map((r) => r.id);

function* everything(seeds = 6): Generator<[string, Composition]> {
  for (const rank of RANKS) {
    for (let seed = 1; seed <= seeds; seed++) {
      for (const item of Object.keys(BUILTIN_CATALOG.items)) yield [`${item} ${rank} #${seed}`, composeItem(item, rank, { seed })];
      for (const c of CREATURES) yield [`${c.id} ${rank} #${seed}`, composeCreature(c, rank, { seed })];
    }
  }
}

describe("compose: the rules hold", () => {
  it("for every item type and creature, at every rank", () => {
    let n = 0;
    for (const [at, x] of everything()) {
      n++;
      const rankIndex = x.bundle.Rank.index;
      const rank = DEFAULT_LADDER.ranks[rankIndex];
      const comps = x.parts.map((p) => BUILTIN_CATALOG.components[p.id]);
      assert.deepEqual(x.relaxed, [], `${at}: nothing relaxed`);
      // Each part is of its slot, for this kind, at this rank.
      x.parts.forEach((p, i) => {
        assert.equal(comps[i].slot, p.slot, `${at}: ${p.id} in a ${p.slot} slot`);
        assert.ok(comps[i].for.includes(x.bundle.Identity.kind), `${at}: ${p.id} is for ${x.bundle.Identity.kind}s`);
        assert.ok(rankIndex >= comps[i].minRank, `${at}: ${p.id} from rank ${comps[i].minRank}`);
      });
      assert.equal(new Set(x.parts.map((p) => p.id)).size, x.parts.length, `${at}: nothing twice`);
      // Nothing excluded by anything else on the entity.
      const baseTags = [
        x.bundle.Identity.kind,
        ...(BUILTIN_CATALOG.items[x.bundle.Identity.base]?.tags ?? CREATURES.find((c) => c.id === x.bundle.Identity.base)!.tags),
      ];
      comps.forEach((c, i) => {
        const others = [...baseTags, ...comps.filter((_, j) => j !== i).flatMap((o) => o.tags)];
        for (const t of c.excludes) assert.ok(!others.includes(t), `${at}: ${x.parts[i].id} excludes ${t}, which is there`);
      });
      // Signals are the rank's, and elemental ones match an element the entity has.
      const signals = x.parts.filter((p) => SIGNAL_SLOTS.includes(p.slot));
      assert.equal(!!x.bundle.Signals.aura, rank.signals.aura, `${at}: aura as the rank says`);
      assert.equal(!!x.bundle.Signals.tint, rank.signals.tint, `${at}: tint as the rank says`);
      const body = new Set([...x.tags.filter(() => true)]);
      for (const sg of signals) {
        const e = elementOf(BUILTIN_CATALOG.components[sg.id]);
        if (!e) continue;
        const has = comps.some((c) => !SIGNAL_SLOTS.includes(c.slot) && c.tags.includes(e)) || CREATURES.find((c) => c.id === x.bundle.Identity.base)?.tags.includes(e);
        assert.ok(has && body.has(e), `${at}: ${sg.id} matches an element the entity has`);
      }
      // One element at most across the parts, and it's the entity's.
      const partElements = new Set(comps.map((c) => elementOf(c)).filter(Boolean));
      assert.ok(partElements.size <= 1, `${at}: one element (${[...partElements]})`);
      if (partElements.size) assert.equal(x.bundle.Element, [...partElements][0], `${at}: the entity's element`);
      // Within the budget, above the rank below.
      assert.ok(x.cost <= rank.budget, `${at}: cost ${x.cost} within ${rank.budget}`);
      if (rankIndex > 0 && !x.tags.includes("food")) assert.ok(x.cost > DEFAULT_LADDER.ranks[rankIndex - 1].budget, `${at}: cost ${x.cost} above the rank below`);
      assert.equal(x.bundle.Abilities.filter((a) => BUILTIN_CATALOG.components[a].slot === "unique").length, rank.signals.uniqueAbility && !x.tags.includes("food") ? 1 : 0, `${at}: unique ability at the top only`);
    }
    assert.ok(n > 500);
  });

  it("never puts holy on demons or the undead, nor frost on a fire demon", () => {
    for (const rank of RANKS) {
      for (let seed = 1; seed <= 30; seed++) {
        const fiend = composeCreature(CREATURES[0], rank, { seed });
        const lich = composeCreature(CREATURES[1], rank, { seed });
        assert.ok(!fiend.tags.includes("holy") && !fiend.tags.includes("frost"), `fiend ${rank}: ${fiend.parts.map((p) => p.id)}`);
        assert.ok(fiend.bundle.Element === "fire" || fiend.bundle.Element === null, `a fire demon's element is fire (${fiend.bundle.Element})`);
        assert.ok(!lich.tags.includes("holy") && !lich.tags.includes("nature"), `lich ${rank}: ${lich.parts.map((p) => p.id)}`);
      }
    }
  });

  it("fits materials to their base: metals on blades, woods on staves, gems on rings", () => {
    for (const rank of RANKS) {
      assert.ok(BUILTIN_CATALOG.components[composeItem("sword", rank).bundle.Material!].fits.includes("metal"));
      assert.ok(BUILTIN_CATALOG.components[composeItem("staff", rank).bundle.Material!].fits.includes("wood"));
      assert.ok(BUILTIN_CATALOG.components[composeItem("ring", rank).bundle.Material!].fits.includes("jewel"));
      assert.equal(composeCreature(CREATURES[2], rank).bundle.Material, null, "creatures have no material");
    }
  });
});

describe("compose: stronger by rank", () => {
  it("spends more, and has more parts and power, up the ladder", () => {
    const total = (x: Composition): number => Object.values(x.bundle.Stats).reduce((a, b) => a + b, 0);
    for (const item of ["sword", "staff", "cuirass", "amulet"]) {
      const avg = RANKS.map((rank) => {
        const xs = Array.from({ length: 8 }, (_, s) => composeItem(item, rank, { seed: s + 1 }));
        return { cost: xs.reduce((t, x) => t + x.cost, 0) / 8, stats: xs.reduce((t, x) => t + total(x), 0) / 8, parts: xs[0].parts.length };
      });
      for (let k = 1; k < avg.length; k++) {
        assert.ok(avg[k].cost > avg[k - 1].cost, `${item}: ${RANKS[k]} spends more`);
        assert.ok(avg[k].stats > avg[k - 1].stats, `${item}: ${RANKS[k]} is stronger (${avg[k].stats} vs ${avg[k - 1].stats})`);
        assert.ok(avg[k].parts > avg[k - 1].parts, `${item}: ${RANKS[k]} has more parts`);
      }
    }
  });

  it("works on any ladder", () => {
    const seven = buildLadder(7);
    for (const r of seven.ranks) {
      const x = composeItem("greatsword", r.id, { ladder: seven, seed: 3 });
      assert.ok(x.cost <= r.budget);
      assert.equal(x.bundle.Rank.id, r.id);
    }
    const two = buildLadder(2);
    assert.ok(composeCreature(CREATURES[2], "legendary", { ladder: two }).bundle.Signals.aura, "a two-rank ladder's top still shines");
  });
});

describe("compose: the bundle", () => {
  it("is deterministic, and different per seed", () => {
    assert.deepEqual(composeItem("sword", "epic", { seed: 5 }), composeItem("sword", "epic", { seed: 5 }));
    const ids = new Set(Array.from({ length: 20 }, (_, s) => composeItem("sword", "epic", { seed: s }).bundle.Identity.id));
    assert.ok(ids.size > 10, `varied: ${ids.size} distinct of 20`);
  });

  it("names things, and gives the top rank a proper name", () => {
    const common = composeItem("sword", "common", { seed: 2 });
    assert.match(common.bundle.Identity.name, /Sword$/);
    const legendary = composeItem("sword", "legendary", { seed: 2 });
    assert.match(legendary.bundle.Identity.name, /^[A-Z][a-z]+, .*Sword/);
    assert.match(composeCreature(CREATURES[2], "legendary", { seed: 2 }).bundle.Identity.name, /^[A-Z][a-z]+ the .*Troll/);
  });

  it("carries the ECS components and the client prefab", () => {
    const x = composeCreature(CREATURES[0], "legendary", { seed: 9 });
    const b = x.bundle;
    assert.equal(b.Identity.kind, "creature");
    assert.equal(b.Prefab.base, "fiend");
    assert.equal(b.Rank.color, DEFAULT_LADDER.ranks[4].color);
    assert.ok(b.Stats.health > 120 && b.Stats.power > 14, "base stats scaled up by rank");
    for (const kind of ["aura", "runes", "particles", "tint", "transform"] as const) {
      assert.ok(b.Signals[kind], `legendary has ${kind}`);
      assert.ok(b.Prefab.attach.some((a) => a.kind === kind && a.id === b.Signals[kind]));
    }
    const aura = b.Prefab.attach.find((a) => a.kind === "aura")!;
    assert.match(String(aura.params.color), /^#/);
    const sword = composeItem("sword", "rare", { seed: 1 });
    assert.match(sword.bundle.Prefab.color ?? "", /^#/, "the material's colour");
  });

  it("follows a bias: a molten dungeon's creatures lean to fire", () => {
    let fire = 0, plain = 0;
    for (let seed = 1; seed <= 40; seed++) {
      if (composeCreature(CREATURES[2], "rare", { seed, bias: { fire: 6 } }).tags.includes("fire")) fire++;
      if (composeCreature(CREATURES[2], "rare", { seed }).tags.includes("fire")) plain++;
    }
    assert.ok(fire > plain + 8, `fire: ${fire} with the bias, ${plain} without`);
  });
});

describe("the catalog", () => {
  it("merges a game's file and lists every problem", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-"));
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ items: { scythe: { name: "Scythe", tags: ["weapon", "melee", "metal"], prefab: "scythe" } }, components: { reaping: { slot: "affix", prefix: "Reaping", stats: { power: 2 } } } }));
    const c = loadCatalog(good);
    assert.ok(c.items.scythe && c.items.sword && c.components.reaping && c.components.flaming);
    const x = composeItem("scythe", "rare", { catalog: c });
    assert.equal(x.bundle.Identity.base, "scythe");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ components: { odd: { slot: "aura", cost: 2, prefix: "Odd" } } }));
    assert.throws(() => loadCatalog(bad), (e: Error) => /only affixes have a prefix/.test(e.message) && /signals cost nothing/.test(e.message));
    assert.throws(() => composeItem("halberd", "rare"), /no item "halberd"/);
    assert.throws(() => composeItem("sword", "mythic"), /no rank "mythic"/);
  });
});
