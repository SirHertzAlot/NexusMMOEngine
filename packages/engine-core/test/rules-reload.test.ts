/**
 * Rules hot reload (ED1): a valid save is held until the next tick and then
 * applied, a bad one is refused and the running rules stay; the hooks
 * delegate swaps, and creatures, loot and item physics take the new tables.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addComponent } from "bitecs";
import { engineDefaults, type RuleHooks } from "@mmo-engine/rules";
import * as C from "../src/components.js";
import { SimWorld } from "../src/world.js";
import { CreatureSystem } from "../src/creatures.js";
import { PLAYER_SPEED } from "../src/systems.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../src/items/index.js";
import { DEFAULT_RULES_DIR, loadGameRules, type GameRules } from "../src/rules/boot.js";
import { HooksDelegate, RulesReloader } from "../src/rules/reload.js";

let dir = "";
const file = (name: string): string => path.join(dir, name);
const readJson = (name: string): any => JSON.parse(fs.readFileSync(file(name), "utf8"));
const writeJson = (name: string, v: unknown): void => fs.writeFileSync(file(name), JSON.stringify(v, null, 2));

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-reload-"));
  fs.cpSync(DEFAULT_RULES_DIR, dir, { recursive: true });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function reloader(): { r: RulesReloader; applied: GameRules[]; logs: string[] } {
  const applied: GameRules[] = [];
  const logs: string[] = [];
  const r = new RulesReloader(dir, (g) => applied.push(g), { log: (l) => logs.push(l) });
  return { r, applied, logs };
}

describe("RulesReloader", () => {
  it("holds a valid change until the next step, then applies it once", () => {
    const loot = readJson("loot.json");
    writeJson("loot.json", { ...loot, pickupRange: 4 });
    const { r, applied } = reloader();
    assert.equal(r.reload(), true);
    assert.equal(r.hasPending, true);
    assert.equal(applied.length, 0, "nothing applies outside the tick");
    const sim = new SimWorld();
    r.step(sim, 1 / 30);
    r.step(sim, 1 / 30);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].rules.loot.pickupRange, 4);
    assert.equal(r.hasPending, false);
    writeJson("loot.json", loot);
  });

  it("refuses bad JSON and bad values, keeping the running rules", () => {
    const creatures = fs.readFileSync(file("creatures.json"), "utf8");
    const { r, applied, logs } = reloader();

    fs.writeFileSync(file("creatures.json"), "{ not json");
    assert.equal(r.reload(), false);
    const bad = JSON.parse(creatures);
    bad.creatures.goblin.weapons = ["no-such-base"];
    writeJson("creatures.json", bad);
    assert.equal(r.reload(), false);

    assert.equal(r.hasPending, false);
    r.step(new SimWorld(), 1 / 30);
    assert.equal(applied.length, 0);
    assert.equal(logs.length, 2);
    assert.match(logs[1], /reload refused, keeping the running rules/);
    fs.writeFileSync(file("creatures.json"), creatures);
    assert.equal(r.reload(), true);
  });

  it("a refused save does not drop an accepted one still waiting", () => {
    const { r, applied } = reloader();
    assert.equal(r.reload(), true);
    const creatures = fs.readFileSync(file("creatures.json"), "utf8");
    fs.writeFileSync(file("creatures.json"), "[");
    assert.equal(r.reload(), false);
    fs.writeFileSync(file("creatures.json"), creatures);
    r.step(new SimWorld(), 1 / 30);
    assert.equal(applied.length, 1);
  });

  it("watches the folder and reloads after a save settles", async () => {
    const loot = readJson("loot.json");
    const watched = new RulesReloader(dir, () => {}, { debounceMs: 20, log: () => {} });
    watched.watch();
    try {
      writeJson("loot.json", { ...loot, despawnSeconds: 123 });
      for (let i = 0; i < 100 && !watched.hasPending; i++) await new Promise((res) => setTimeout(res, 20));
      assert.equal(watched.hasPending, true);
    } finally {
      watched.close();
      writeJson("loot.json", loot);
    }
  });
});

describe("HooksDelegate", () => {
  it("forwards to whatever is current", () => {
    const a = loadGameRules(dir).hooks;
    const calls: string[] = [];
    const b = new Proxy(a, {
      get: (t, k) => (...args: unknown[]) => {
        calls.push(String(k));
        return (t as any)[k](...args);
      },
    }) as RuleHooks;
    const d = new HooksDelegate(a);
    d.current = b;
    d.skillGain({ skill: "swords", level: 0, difficulty: 0 } as unknown as Parameters<RuleHooks["skillGain"]>[0]);
    assert.deepEqual(calls, ["skillGain"]);
  });
});

describe("reload targets", () => {
  it("CreatureSystem.setRules: new speed and respawn delay for the living, removed kinds idle", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const game = loadGameRules(dir);
    const cs = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
    const e = cs.spawn(sim, "goblin", 0, 0);
    const goblin = { ...game.rules.creatures.creatures.goblin, chaseSpeed: 2, respawnSeconds: 5 };
    cs.setRules({ goblin }, game.rules.items.bases);
    assert.ok(Math.abs(C.NavAgent.speed[e] - 2 * PLAYER_SPEED) < 1e-5);
    assert.equal(cs.respawnSeconds(e), 5);

    cs.setRules({}, game.rules.items.bases);
    const p = sim.spawn();
    for (const c of [C.Transform, C.Health, C.CharacterRef]) addComponent(sim.ecs, c, p);
    C.Health.current[p] = 100;
    C.Transform.px[p] = 1;
    sim.beginTick(1);
    cs.step(sim);
    sim.endTick();
    assert.equal(C.PlayerIntent.mx[e], 0, "a removed kind stands idle");
    assert.equal(C.PlayerIntent.buttons[e], 0);
    assert.equal(cs.respawnSeconds(e), undefined);
  });

  it("ItemService.setLoot: a new drop takes the new ownership and despawn times", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    sim.beginTick(1);
    const rules = engineDefaults();
    const pool: PoolItemLike[] = [{
      id: "a", rank: "common", source: "mob", item: "sword", seed: 0,
      bundle: { Identity: { id: "a", name: "a", base: "sword" }, Rank: { id: "common", color: "#fff" }, Stats: {} },
    }];
    const defs = new ItemDefs(pool, rules);
    const loot = { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 3, maxGroundItems: 100 };
    const items = new ItemService({ defs, loot, tickHz: 30 });
    const first = items.spawnDrop(sim, 0, 0, 0, 7).eid;
    assert.equal(C.WorldItem.ownedUntil[first], 1 + 30 * 30);
    items.setLoot({ ...loot, ownershipSeconds: 1, despawnSeconds: 2 });
    const second = items.spawnDrop(sim, 0, 0, 0, 7).eid;
    assert.equal(C.WorldItem.ownedUntil[second], 1 + 30);
    assert.equal(C.WorldItem.despawnAt[second], 1 + 60);
  });

  it("ItemDefs.applyRules: physics, technique and model follow the base in place", () => {
    const rules = engineDefaults();
    rules.items.bases.sword = { ...rules.items.fallback, mass: 1, technique: "cut", hand: "main", models: ["m/A"] };
    const pool: PoolItemLike[] = [{
      id: "a", rank: "common", source: "mob", item: "sword", seed: 0,
      bundle: { Identity: { id: "a", name: "a", base: "sword" }, Rank: { id: "common", color: "#fff" }, Stats: { power: 9 } },
    }];
    const defs = new ItemDefs(pool, rules);
    const mass = defs.mass;
    assert.equal(defs.models[0], "m/A");
    rules.items.bases.sword = { ...rules.items.bases.sword, mass: 2.5, technique: "thrust", models: [] };
    defs.applyRules(rules);
    assert.equal(defs.mass, mass, "same arrays, updated in place");
    assert.equal(defs.mass[0], 2.5);
    assert.equal(defs.technique[0], "thrust");
    assert.equal(defs.models[0], "");
    assert.equal(defs.assetHash[0], 0);
    assert.equal(defs.power[0], 9, "pool stats are not rules");
  });
});
