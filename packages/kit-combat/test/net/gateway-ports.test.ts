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
import { type AbilityPort, type AuctionPort, type BodyPort, type BreakPort, type ChestPort, type CombatPort, type CombatService, type DuelPort, GATEWAY_PORTS, type GatewayPorts, type GatheringPort, type LifePort, loadGameRules, type MagicPort, type ResidentPort, type StatusPort, type TelegraphPort, type TelegraphService, type TradePort, type VendorPort, type WalletPort } from "@mmo-engine/engine-core";
import { AuctionSystem } from "@mmo-engine/engine-core/dist/src/economy/auction.js";
import { TradeSystem } from "@mmo-engine/engine-core/dist/src/economy/trade.js";
import { VendorSystem } from "@mmo-engine/engine-core/dist/src/economy/vendor.js";
import { WalletSystem } from "@mmo-engine/engine-core/dist/src/economy/wallet.js";
import { GatheringSystem } from "@mmo-engine/engine-core/dist/src/gathering/index.js";
import { BreakSystem, ChestSystem } from "@mmo-engine/engine-core/dist/src/interact/index.js";
import { ResidentSystem } from "@mmo-engine/engine-core/dist/src/residents/index.js";

/** Compile-time: each system still answers the port the gateway asks it for. */
type Conforms<T extends P, P> = true;
const _combat: Conforms<CombatSystem, CombatPort> = true;
const _life: Conforms<DeathSystem, LifePort> = true;
const _abilities: Conforms<AbilitySystem, AbilityPort> = true;
const _telegraphs: Conforms<TelegraphSystem, TelegraphPort> = true;
const _statuses: Conforms<StatusSystem, StatusPort> = true;
const _duels: Conforms<DuelSystem, DuelPort> = true;
// These eight were `Pick<>` of their system until `ES5d`, so conformance was
// true by construction and needed no line here. Now they are written out, and
// these lines are what makes a hand-written signature a claim the compiler
// checks: drop a method, rename a parameter's type, demand something the
// system does not have, and the build fails on the port, not on a tick.
const _trade: Conforms<TradeSystem, TradePort> = true;
const _wallet: Conforms<WalletSystem, WalletPort> = true;
const _auction: Conforms<AuctionSystem, AuctionPort> = true;
const _vendors: Conforms<VendorSystem, VendorPort> = true;
const _gathering: Conforms<GatheringSystem, GatheringPort> = true;
const _chests: Conforms<ChestSystem, ChestPort> = true;
const _breaks: Conforms<BreakSystem, BreakPort> = true;
const _residents: Conforms<ResidentSystem, ResidentPort> = true;
void [_combat, _life, _abilities, _telegraphs, _statuses, _duels];
void [_trade, _wallet, _auction, _vendors, _gathering, _chests, _breaks, _residents];
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

/** The system that answers each port today, by prototype so nothing is built. */
const ANSWERED_BY: Readonly<Record<keyof GatewayPorts, object>> = {
  combat: CombatSystem.prototype,
  life: DeathSystem.prototype,
  abilities: AbilitySystem.prototype,
  telegraphs: TelegraphSystem.prototype,
  statuses: StatusSystem.prototype,
  duels: DuelSystem.prototype,
  trade: TradeSystem.prototype,
  wallet: WalletSystem.prototype,
  auction: AuctionSystem.prototype,
  vendors: VendorSystem.prototype,
  gathering: GatheringSystem.prototype,
  chests: ChestSystem.prototype,
  breaks: BreakSystem.prototype,
  residents: ResidentSystem.prototype,
};

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
    assert.ok(proto, `no system is mapped for the "${decl.key}" port`);
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
  assert.deepEqual(Object.keys(ANSWERED_BY).sort(), GATEWAY_PORTS.map((d) => d.key).sort());
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




/**
 * The members an interface declares, read from the source.
 *
 * A member sits at one indent: `name(...)`, `name(` opening a signature that
 * runs over several lines, or `readonly name: T`. Continuation lines and the
 * closing brace of a nested object type are deeper or start with punctuation,
 * so neither is mistaken for one.
 */



