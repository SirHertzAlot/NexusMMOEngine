/**
 * The dungeon run's combat slot (roadmap ES5e).
 *
 * A run used to build `CombatSystem`, `DeathSystem` and `StaminaSystem`
 * itself, which is the last thing that kept those three inside
 * `engine-core`: the region gateway had already stopped naming a system
 * class (`ES4c`, `ES4d`), but you cannot ask for a system by port and also
 * be the one who decides how it is built.
 *
 * Now the run declares a slot and a game fills it, and the three systems
 * have left the engine for this kit (`ES6a`). These are the guards for that:
 * the kit's factory still returns the same three, wired the same way and
 * offering the ports the run's gateway reads; a run with no factory has no
 * fighting rather than a broken one; and the engine's `instance.ts` cannot go
 * back to constructing them without failing here.
 *
 * What the three systems *do* is covered where it always was (`body`,
 * `combat`, `death`, `stamina` and the gateway suites), which is what makes
 * this file a guard rather than a second test of combat.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openPorts } from "@mmo-engine/sdk";
import { type DungeonCombatContext, GATEWAY_PORTS, type GatewayPorts, loadGameRules, NO_DUNGEON_COMBAT, type SimSystem } from "@mmo-engine/engine-core";
import { defaultDungeonCombat } from "../../src/dungeons/default-combat.js";

/** This kit's own sources, from `dist/test/dungeons/`. */
const kitSrc = (...parts: string[]): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", ...parts);

/** The engine's sources, which the guards below read but must not import. */
const engineSrc = (...parts: string[]): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "engine-core", "src", ...parts);

const game = loadGameRules();

/** A context that answers everything and records what the factory asked. */
function context(overrides: Partial<DungeonCombatContext> = {}): DungeonCombatContext {
  return {
    tickHz: 30,
    rules: game.rules,
    hooks: game.hooks,
    weaponOf: () => null,
    armourOf: () => 1,
    isCreature: () => false,
    place: () => true,
    respawnSeconds: () => undefined,
    onDeath: () => {},
    ...overrides,
  };
}

describe("ES5e: a dungeon run's fighting comes from its game", () => {
  it("the kit's factory still returns combat, death and stamina, in that order", () => {
    const fighting = defaultDungeonCombat(context());
    assert.deepEqual(
      fighting.systems.map((s: SimSystem) => s.name),
      ["combat", "death", "stamina"],
      "the order the run spliced them in before the slot existed",
    );
  });

  it("offers the ports the run's own gateway reads", () => {
    // The run has a Gateway like the region's, so the systems the factory
    // returns have to be findable the same way: by port, not by class.
    const fighting = defaultDungeonCombat(context());
    const ports = openPorts<GatewayPorts>(GATEWAY_PORTS, fighting.systems);
    assert.ok(ports.has("combat"), "the run's gateway would find no combat port");
    assert.ok(ports.has("life"), "the run's gateway would find no life port");
    assert.equal(ports.first("combat"), fighting.systems[0]);
    assert.equal(ports.first("life"), fighting.systems[1]);
  });

  it("answers lastAttacker from the combat system it built", () => {
    // The run asks twice — a kill's loot and a broken barrel's both go to
    // whoever struck last — and `NO_DUNGEON_COMBAT` has to answer it too.
    const fighting = defaultDungeonCombat(context());
    assert.equal(fighting.lastAttacker(1234), undefined, "nobody has struck 1234");
    assert.equal(NO_DUNGEON_COMBAT.lastAttacker(1234), undefined);
    assert.deepEqual([...NO_DUNGEON_COMBAT.systems], [], "no factory means no fighting, not a broken one");
  });

  it("reads the rules and hooks it was handed, not a module's own", () => {
    // A game opens a run with the rules it loaded; the factory must build
    // from those. Combat reads its tuning lazily, so the proof is that a
    // context with no techniques at all still builds, and the systems it
    // returns are fresh objects per run rather than module-level state.
    const bare = defaultDungeonCombat(
      context({ rules: { ...game.rules, combat: { ...game.rules.combat, techniques: {} } } }),
    );
    assert.equal(bare.systems.length, 3);
    const second = defaultDungeonCombat(context());
    for (let i = 0; i < 3; i++) {
      assert.notEqual(bare.systems[i], second.systems[i], `system ${i} is shared between runs`);
    }
  });

  it("the engine's dungeon code never reaches for this kit", () => {
    // The whole point: these modules are what the kit had to be able to leave
    // behind. Naming the kit here, or building one of its systems, would put
    // the fighting back inside the engine by the other door.
    for (const file of ["instance.ts", "manager.ts"]) {
      const text = readFileSync(engineSrc("dungeons", file), "utf8");
      assert.doesNotMatch(text, /kit-combat/, `dungeons/${file} names @mmo-engine/kit-combat`);
      for (const name of ["CombatSystem", "DeathSystem", "StaminaSystem"]) {
        assert.doesNotMatch(text, new RegExp(`new ${name}\\b`), `dungeons/${file} still builds a ${name}`);
      }
    }
  });

  it("the kit's default-combat.ts is what builds them, and the slot names nothing", () => {
    const text = readFileSync(kitSrc("dungeons", "default-combat.ts"), "utf8");
    for (const name of ["CombatSystem", "DeathSystem", "StaminaSystem"]) {
      assert.match(text, new RegExp(`new ${name}\\b`), `default-combat.ts should build a ${name}`);
    }
    // The slot itself names no system, so a kit can implement it.
    const slot = readFileSync(engineSrc("dungeons", "combat-slot.ts"), "utf8");
    const specs = [...slot.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string).sort();
    assert.deepEqual(specs, ["../systems.js", "../vocabulary.js", "../world.js", "@mmo-engine/rules"]);
  });
});
