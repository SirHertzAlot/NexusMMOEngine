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
import { AuctionSystem } from "../../src/economy/auction.js";
import { TradeSystem } from "../../src/economy/trade.js";
import { VendorSystem } from "../../src/economy/vendor.js";
import { WalletSystem } from "../../src/economy/wallet.js";
import { GatheringSystem } from "../../src/gathering/index.js";
import { BreakSystem, ChestSystem } from "../../src/interact/index.js";
import { ResidentSystem } from "../../src/residents/index.js";
import { loadGameRules } from "../../src/rules/boot.js";
import {
  GATEWAY_PORTS,
  type AbilityPort,
  type AuctionPort,
  type BreakPort,
  type ChestPort,
  type CombatPort,
  type DuelPort,
  type GatewayPorts,
  type GatheringPort,
  type LifePort,
  type ResidentPort,
  type StatusPort,
  type TelegraphPort,
  type TradePort,
  type VendorPort,
  type WalletPort,
} from "../../src/net/ports.js";

const srcPath = (...parts: string[]): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", ...parts);
const SRC = srcPath("net", "gateway.ts");
const PORTS_SRC = srcPath("net", "ports.ts");

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

test("the port table names every port the gateway reads, once", () => {
  const keys = GATEWAY_PORTS.map((d) => d.key);
  assert.deepEqual([...keys].sort(), [
    "abilities",
    "auction",
    "breaks",
    "chests",
    "combat",
    "duels",
    "gathering",
    "life",
    "residents",
    "statuses",
    "telegraphs",
    "trade",
    "vendors",
    "wallet",
  ]);
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

test("a run with none of these systems opens every port empty", () => {
  // A system of a game's own that offers nothing the gateway reads.
  const ports = openPorts<GatewayPorts>(GATEWAY_PORTS, [{ name: "weather", update: (): void => {} }]);
  assert.equal(ports.absent.length, GATEWAY_PORTS.length);
  assert.match(ports.summary, /^ports: 0\/14, off: abilities, auction, breaks, /);
  assert.equal(ports.first("combat"), undefined);
  assert.equal(ports.first("vendors"), undefined);
  assert.deepEqual(ports.all("duels"), []);
  assert.deepEqual(ports.all("trade"), []);
});

test("gateway.ts finds no system by class", () => {
  const src = readFileSync(SRC, "utf8");
  const classes = [
    "CombatSystem",
    "DeathSystem",
    "AbilitySystem",
    "StatusSystem",
    "TelegraphSystem",
    "DuelSystem",
    "TradeSystem",
    "WalletSystem",
    "AuctionSystem",
    "VendorSystem",
    "GatheringSystem",
    "ChestSystem",
    "BreakSystem",
    "ResidentSystem",
  ];
  for (const cls of classes) {
    assert.ok(!src.includes(`instanceof ${cls}`), `gateway.ts still scans for ${cls} by class`);
    assert.ok(
      !new RegExp(`^import \\{[^}]*\\b${cls}\\b`, "m").test(src),
      `gateway.ts still imports ${cls} as a value; a kit cannot own it while it does`,
    );
  }
  // The port lookups it uses instead, so a rewrite that drops them is noticed.
  for (const key of GATEWAY_PORTS.map((d) => d.key)) {
    assert.ok(
      src.includes(`this.ports.all("${key}")`) || src.includes(`this.ports.first("${key}")`),
      `gateway.ts reads no "${key}" port`,
    );
  }
});

/** The interface that types each port, by the key a system offers it under. */
const PORT_INTERFACE: Readonly<Record<keyof GatewayPorts, string>> = {
  combat: "CombatPort",
  life: "LifePort",
  abilities: "AbilityPort",
  telegraphs: "TelegraphPort",
  statuses: "StatusPort",
  duels: "DuelPort",
  trade: "TradePort",
  wallet: "WalletPort",
  auction: "AuctionPort",
  vendors: "VendorPort",
  gathering: "GatheringPort",
  chests: "ChestPort",
  breaks: "BreakPort",
  residents: "ResidentPort",
};

/**
 * The members an interface declares, read from the source.
 *
 * A member sits at one indent: `name(...)`, `name(` opening a signature that
 * runs over several lines, or `readonly name: T`. Continuation lines and the
 * closing brace of a nested object type are deeper or start with punctuation,
 * so neither is mistaken for one.
 */
function declaredMembers(text: string, name: string): string[] {
  const open = text.indexOf(`export interface ${name} {`);
  assert.notEqual(open, -1, `net/ports.ts should declare ${name}`);
  const body = text.slice(text.indexOf("\n", open) + 1);
  const end = body.indexOf("\n}\n");
  assert.notEqual(end, -1, `${name} should be closed`);
  const members: string[] = [];
  for (const line of body.slice(0, end).split("\n")) {
    const m = /^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\s*[(:]/.exec(line);
    if (m) members.push(m[1] as string);
  }
  return members;
}

test("each port's interface and its table row name the same members", () => {
  // The interface is what the gateway's call sites are typed against; the
  // table is what the boot checks a provider against. They are written by
  // hand in one file and nothing but this makes them say the same thing, so
  // a method added to one and not the other would be either a call no
  // provider has to answer or a demand the boot never enforces.
  const text = readFileSync(PORTS_SRC, "utf8");
  for (const decl of GATEWAY_PORTS) {
    const name = PORT_INTERFACE[decl.key as keyof GatewayPorts];
    const declared = declaredMembers(text, name).sort();
    const tabled = [...decl.methods, ...(decl.fields ?? [])].sort();
    assert.deepEqual(declared, tabled, `${name} and the "${decl.key}" row disagree`);
  }
  assert.deepEqual(Object.keys(PORT_INTERFACE).sort(), GATEWAY_PORTS.map((d) => d.key).sort());
});

test("net/ports.ts names no system, of the engine's or a kit's", () => {
  // The point of the whole change (`ES4c`, `ES4d`, `ES5b`, `ES5d`): the
  // gateway's demands are written in shared vocabulary, the protocol's wire
  // views and the engine's own world. A system module creeping back into
  // this import list would tie the gateway to a class again, which is what
  // keeps the combat and economy systems from leaving for a kit.
  const specs = [...readFileSync(PORTS_SRC, "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual([...specs].sort(), [
    "../vocabulary.js",
    "../world.js",
    "@mmo-engine/protocol",
    "@mmo-engine/sdk",
  ]);
});
