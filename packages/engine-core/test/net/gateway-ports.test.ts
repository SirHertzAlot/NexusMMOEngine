/**
 * The gateway reads its systems by port, not by class.
 *
 * These are the guards for that: the real systems answer the ports they
 * offer, the table and the typed map agree, and `net/gateway.ts` cannot go
 * back to `instanceof` without failing here. The behaviour behind the ports
 * is covered where it always was (`gateway-m5`, `strike-duel-gateway`,
 * `gateway.test`), which is what makes this file a guard rather than a test
 * of the systems.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PORTS, openPorts } from "@mmo-engine/sdk";
import { AbilitySystem } from "../../src/abilities.js";
import { CombatSystem } from "../../src/combat.js";
import { DeathSystem } from "../../src/death.js";
import { DuelSystem } from "../../src/duel.js";
import { StatusSystem } from "../../src/status.js";
import { TelegraphSystem } from "../../src/telegraph.js";
import { loadGameRules } from "../../src/rules/boot.js";
import {
  GATEWAY_PORTS,
  type AbilityPort,
  type CombatPort,
  type DuelPort,
  type GatewayPorts,
  type LifePort,
  type StatusPort,
  type TelegraphPort,
} from "../../src/net/ports.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "net", "gateway.ts");

/** Compile-time: each system still answers the port the gateway asks it for. */
type Conforms<T extends P, P> = true;
const _combat: Conforms<CombatSystem, CombatPort> = true;
const _life: Conforms<DeathSystem, LifePort> = true;
const _abilities: Conforms<AbilitySystem, AbilityPort> = true;
const _telegraphs: Conforms<TelegraphSystem, TelegraphPort> = true;
const _statuses: Conforms<StatusSystem, StatusPort> = true;
const _duels: Conforms<DuelSystem, DuelPort> = true;
void [_combat, _life, _abilities, _telegraphs, _statuses, _duels];

/** Compile-time: the table's keys are exactly the typed map's keys. */
const _keys: readonly (keyof GatewayPorts)[] = ["combat", "life", "abilities", "telegraphs", "statuses", "duels"];
void _keys;

test("the port table names every port the gateway reads, once", () => {
  const keys = GATEWAY_PORTS.map((d) => d.key);
  assert.deepEqual([...keys].sort(), ["abilities", "combat", "duels", "life", "statuses", "telegraphs"]);
  assert.equal(new Set(keys).size, keys.length);
  for (const decl of GATEWAY_PORTS) {
    assert.ok(decl.methods.length > 0, `${decl.key} declares no methods`);
    assert.ok(decl.what.length > 0, `${decl.key} says nothing about itself`);
  }
});

test("the real systems answer the ports they offer", () => {
  const { hooks } = loadGameRules();
  const systems = [
    new CombatSystem(30),
    new DeathSystem(hooks, 30),
    new AbilitySystem(30),
    new TelegraphSystem(30),
    new StatusSystem(30),
    new DuelSystem(30),
  ];

  // `openPorts` is fail-closed: a renamed method, or a system that stopped
  // declaring its port, ends the boot here rather than in the first tick.
  const ports = openPorts<GatewayPorts>(GATEWAY_PORTS, systems);
  assert.deepEqual(ports.absent, []);
  assert.equal(ports.summary, "ports: 6/6");
  assert.equal(ports.first("combat"), systems[0]);
  assert.equal(ports.first("life"), systems[1]);
  assert.equal(ports.first("abilities"), systems[2]);
  assert.equal(ports.first("telegraphs"), systems[3]);
  assert.equal(ports.first("statuses"), systems[4]);
  assert.equal(ports.first("duels"), systems[5]);

  // Each system offers exactly the port the table expects of it.
  assert.deepEqual(
    systems.map((s) => (s as unknown as Record<PropertyKey, readonly string[]>)[PORTS]),
    [["combat"], ["life"], ["abilities"], ["telegraphs"], ["statuses"], ["duels"]],
  );
});

test("a run with none of these systems opens every port empty", () => {
  // A system of a game's own that offers nothing the gateway reads.
  const ports = openPorts<GatewayPorts>(GATEWAY_PORTS, [{ name: "weather", update: (): void => {} }]);
  assert.deepEqual(ports.absent, ["abilities", "combat", "duels", "life", "statuses", "telegraphs"]);
  assert.equal(ports.summary, "ports: 0/6, off: abilities, combat, duels, life, statuses, telegraphs");
  assert.equal(ports.first("combat"), undefined);
  assert.deepEqual(ports.all("duels"), []);
});

test("gateway.ts finds no system by class", () => {
  const src = readFileSync(SRC, "utf8");
  for (const cls of ["CombatSystem", "DeathSystem", "AbilitySystem", "StatusSystem", "TelegraphSystem", "DuelSystem"]) {
    assert.ok(!src.includes(`instanceof ${cls}`), `gateway.ts still scans for ${cls} by class`);
    assert.ok(
      !new RegExp(`^import \\{[^}]*\\b${cls}\\b`, "m").test(src),
      `gateway.ts still imports ${cls} as a value; a kit cannot own it while it does`,
    );
  }
  // The port lookups it uses instead, so a rewrite that drops them is noticed.
  for (const key of ["combat", "life", "abilities", "telegraphs", "statuses", "duels"]) {
    assert.ok(
      src.includes(`this.ports.all("${key}")`) || src.includes(`this.ports.first("${key}")`),
      `gateway.ts reads no "${key}" port`,
    );
  }
});
