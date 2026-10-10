/** Combat moves from content: the server's boot load, and an edited hit frame moving the blow. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent } from "bitecs";
import { combatMove, DEFAULT_COMBAT_MOVES, IntentButton, Move, setCombatMoves, type CombatMove } from "@mmo-engine/protocol";
import { SimWorld } from "../src/world.js";
import * as C from "../src/components.js";
import { CombatSystem, type Weapon } from "../src/combat.js";
import { IntegrateSystem, IntentSystem } from "../src/systems.js";
import { loadGameRules } from "../src/rules/boot.js";
import { DEFAULT_COMBAT_FILE, loadCombatContent } from "../src/combat-content.js";

const DT = 1 / 30;
const { hooks } = loadGameRules();
const SWORD: Weapon = { technique: "cut", item: { mass: 1.2, edge: 0.8, point: 0.3, hardness: 0.6 }, reach: 0.9 };

/** Ticks of holding Attack until the first hit on a target one metre ahead; null if none within 3 s. */
function firstHitTick(): number | null {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const make = (comps: object[], z: number): number => {
    const e = sim.spawn();
    for (const c of comps) {
      addComponent(sim.ecs, c, e);
      for (const store of Object.values(c) as unknown as Array<{ [i: number]: number }>) store[e] = 0;
    }
    C.Transform.qw[e] = 1;
    C.Transform.pz[e] = z;
    return e;
  };
  const e = make([C.Transform, C.Velocity, C.PlayerIntent, C.Action, C.Health], 0);
  const t = make([C.Transform, C.Health], 1);
  C.Health.current[e] = C.Health.max[e] = C.Health.current[t] = C.Health.max[t] = 100;
  const combat = new CombatSystem(30, undefined, { hooks, weaponOf: () => SWORD });
  const systems = [new IntentSystem(), combat, new IntegrateSystem()];
  for (let tick = 1; tick <= 90; tick++) {
    sim.queueIntent(e, { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: IntentButton.Attack });
    sim.beginTick(tick);
    for (const s of systems) s.step(sim, DT);
    sim.endTick();
    if (combat.drainHits().length > 0) return tick;
  }
  return null;
}

describe("combat content on the server", () => {
  afterEach(() => setCombatMoves({ version: 1, moves: [...DEFAULT_COMBAT_MOVES] }));

  it("the repo's moves.json loads", () => {
    assert.match(loadCombatContent()!, /combat: 8 moves/);
  });

  it("a missing file keeps the built-in moves; a bad one stops the server with the problem named", () => {
    assert.equal(loadCombatContent(join(tmpdir(), "no-such-moves.json")), null);
    const dir = mkdtempSync(join(tmpdir(), "mmo-combat-"));
    const doc = JSON.parse(readFileSync(DEFAULT_COMBAT_FILE, "utf8")) as { moves: CombatMove[] };
    doc.moves[0].hitAt = 9;
    writeFileSync(join(dir, "moves.json"), JSON.stringify(doc));
    assert.throws(() => loadCombatContent(join(dir, "moves.json")), /moves\[0\]\.hitAt/);
    assert.equal(combatMove(Move.SwordA)!.hitAt, 0.2, "nothing changed");
    rmSync(dir, { recursive: true });
  });

  it("an edited hit frame moves the blow", () => {
    const before = firstHitTick();
    assert.equal(before, 1 + Math.round(0.2 * 30));
    const dir = mkdtempSync(join(tmpdir(), "mmo-combat-"));
    const doc = JSON.parse(readFileSync(DEFAULT_COMBAT_FILE, "utf8")) as { moves: CombatMove[] };
    doc.moves.find((m) => m.id === Move.SwordA)!.hitAt = 0.3;
    writeFileSync(join(dir, "moves.json"), JSON.stringify(doc));
    loadCombatContent(join(dir, "moves.json"));
    assert.equal(firstHitTick(), 1 + Math.round(0.3 * 30));
    rmSync(dir, { recursive: true });
  });
});
