/**
 * The real systems answer the ports the gateway asks them for.
 *
 * Two guards, both of which need a system to exist: the compile-time claims
 * that each class conforms to its port, and opening the port table over the
 * systems themselves to see that every member a row names is really there.
 *
 * The rest of the port contract — the interfaces against the table rows, the
 * import list of `net/ports.ts`, and the gateway not drifting back to a class
 * — is the engine's own and lives in `engine-core`'s
 * `test/net/ports-contract.test.ts` (`ES5i`). The behaviour behind the ports
 * is covered where it always was (`gateway-m5`, `strike-duel-gateway`,
 * `gateway.test`), which is what makes this file a guard rather than a test of
 * the systems.
 *
 * `ES5n`: the eight economy and world ports are guarded the same way in
 * `kit-economy`'s own `test/net/gateway-ports.test.ts`, because their systems
 * are that kit's now and this kit imports no other kit. Each half names the
 * other's keys, so a fifteenth port cannot fall through both.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PORTS, openPorts } from "@mmo-engine/sdk";
import { AbilitySystem } from "../../src/abilities.js";
import { BodySystem } from "../../src/body.js";
import { CombatSystem } from "../../src/combat.js";
import { DeathSystem } from "../../src/death.js";
import { DuelSystem } from "../../src/duel.js";
import { MagicSystem } from "../../src/magic.js";
import { StatusSystem } from "../../src/status.js";
import { TelegraphSystem } from "../../src/telegraph.js";
import { type AbilityPort, type BodyPort, type CombatPort, type CombatService, type DuelPort, GATEWAY_PORTS, type GatewayPorts, type LifePort, loadGameRules, type MagicPort, type StatusPort, type TelegraphPort, type TelegraphService } from "@mmo-engine/engine-core";

/** Compile-time: each system still answers the port the gateway asks it for. */
type Conforms<T extends P, P> = true;
const _combat: Conforms<CombatSystem, CombatPort> = true;
const _life: Conforms<DeathSystem, LifePort> = true;
const _abilities: Conforms<AbilitySystem, AbilityPort> = true;
const _telegraphs: Conforms<TelegraphSystem, TelegraphPort> = true;
const _statuses: Conforms<StatusSystem, StatusPort> = true;
const _duels: Conforms<DuelSystem, DuelPort> = true;
void [_combat, _life, _abilities, _telegraphs, _statuses, _duels];
// `ES5f`: the three the engine's own wiring still named. `body` is handed to
// the gateway as an option rather than resolved from the systems list, and
// the host's two demands are narrower than the gateway's, so each is written
// out separately — and each is a claim about the real class.
const _body: Conforms<BodySystem, BodyPort> = true;
const _combatService: Conforms<CombatSystem, CombatService> = true;
const _telegraphService: Conforms<TelegraphSystem, TelegraphService> = true;
const _magic: Conforms<MagicSystem, MagicPort> = true;
void [_body, _combatService, _telegraphService, _magic];

/** Compile-time: the table's keys are exactly the typed map's keys. */
const _keys: readonly (keyof GatewayPorts)[] = [
  "combat",
  "life",
  "abilities",
  "telegraphs",
  "statuses",
  "duels",
  "trade",
  "wallet",
  "auction",
  "vendors",
  "gathering",
  "chests",
  "breaks",
  "residents",
];
void _keys;

/** The system in this kit that answers each port, by prototype so nothing is built. */
const ANSWERED_BY: Readonly<Partial<Record<keyof GatewayPorts, object>>> = {
  combat: CombatSystem.prototype,
  life: DeathSystem.prototype,
  abilities: AbilitySystem.prototype,
  telegraphs: TelegraphSystem.prototype,
  statuses: StatusSystem.prototype,
  duels: DuelSystem.prototype,
};

/**
 * The ports another kit answers. Naming them is what keeps the split honest:
 * a new port that neither half claims fails the completeness check below
 * rather than going unguarded because each kit assumed the other had it.
 */
const ELSEWHERE: readonly (keyof GatewayPorts)[] = [
  "trade",
  "wallet",
  "auction",
  "vendors",
  "gathering",
  "chests",
  "breaks",
  "residents",
];

/** `method`, `getter`, `field` or `missing`, without running a getter. */
function memberKind(proto: object, name: string): string {
  for (let p: object | null = proto; p !== null; p = Object.getPrototypeOf(p) as object | null) {
    const desc = Object.getOwnPropertyDescriptor(p, name);
    if (!desc) continue;
    return typeof desc.value === "function" ? "method" : desc.get ? "getter" : "field";
  }
  return "missing";
}

test("every member the table names is one the answering system has", () => {
  // The table's names are strings, so nothing but this stops a typo in one
  // from rejecting at boot the very system it describes, in a build where
  // every type checks out. A `methods` entry that is really a getter is the
  // same bug: `openPorts` wants a function there.
  for (const decl of GATEWAY_PORTS) {
    const proto = ANSWERED_BY[decl.key as keyof GatewayPorts];
    if (!proto) continue;
    for (const method of decl.methods) {
      assert.equal(
        memberKind(proto, method),
        "method",
        `the "${decl.key}" port calls ${method}, which is not a method of its system`,
      );
    }
    // A field may be a getter, an own field set in the constructor (so not
    // on the prototype at all), or declared on a base.
    for (const field of decl.fields ?? []) {
      assert.notEqual(
        memberKind(proto, field),
        "method",
        `the "${decl.key}" port reads ${field} as data, but it is a method`,
      );
    }
  }
  // Every port is answered by one half or the other, and no key is claimed
  // by both: this kit's six plus the eight `kit-economy` guards are the table.
  const mine = Object.keys(ANSWERED_BY) as (keyof GatewayPorts)[];
  assert.deepEqual(
    [...mine, ...ELSEWHERE].sort(),
    GATEWAY_PORTS.map((d) => d.key).sort(),
    "a port is guarded by neither kit, or by both",
  );
  for (const key of ELSEWHERE) {
    assert.ok(!(key in ANSWERED_BY), `${key} is claimed here and in kit-economy`);
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
  assert.deepEqual(ports.absent, [
    "auction",
    "breaks",
    "chests",
    "gathering",
    "residents",
    "trade",
    "vendors",
    "wallet",
  ]);
  assert.equal(
    ports.summary,
    "ports: 6/14, off: auction, breaks, chests, gathering, residents, trade, vendors, wallet",
  );
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



