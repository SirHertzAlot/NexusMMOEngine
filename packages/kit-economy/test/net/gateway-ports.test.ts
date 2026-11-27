/**
 * This kit's systems answer the ports the gateway asks them for.
 *
 * The other half of `kit-combat`'s `test/net/gateway-ports.test.ts`. The port
 * table is the engine's and spans fourteen ports, but the systems answering
 * them are split between two kits now (`ES5n`), and a kit imports no other
 * kit — so each kit guards its own six or eight, and each names the other's
 * keys so a fifteenth port cannot fall through both.
 *
 * Two guards, neither of which runs a tick: the compile-time claims that each
 * class conforms to its port, and reading the port table over the systems'
 * prototypes to see that every member a row names is really there. Nothing is
 * constructed here. The behaviour behind these ports is covered where it
 * always was — `gateway-economy`, `gateway-auction`, `gateway-vendor`,
 * `gateway-chests`, `gateway-gathering` and the residents suite — which is
 * what makes this file a guard rather than a test of the systems.
 *
 * The rest of the port contract — the interfaces against the table rows, the
 * import list of `net/ports.ts`, and the gateway not drifting back to a class
 * — is the engine's own and lives in `engine-core`'s
 * `test/net/ports-contract.test.ts` (`ES5i`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type AuctionPort,
  type BreakPort,
  type ChestPort,
  GATEWAY_PORTS,
  type GatewayPorts,
  type GatheringPort,
  type ResidentPort,
  type TradePort,
  type VendorPort,
  type WalletPort,
} from "@mmo-engine/engine-core";
import { AuctionSystem } from "../../src/auction.js";
import { BreakSystem } from "../../src/breaks.js";
import { ChestSystem } from "../../src/chests.js";
import { GatheringSystem } from "../../src/gathering.js";
import { ResidentSystem } from "../../src/resident-system.js";
import { TradeSystem } from "../../src/trade.js";
import { VendorSystem } from "../../src/vendor.js";
import { WalletSystem } from "../../src/wallet.js";

/**
 * Compile-time: each system still answers the port the gateway asks it for.
 *
 * These eight were `Pick<>` of their system until `ES5d`, so conformance was
 * true by construction and needed no line here. Now they are written out, and
 * these lines are what makes a hand-written signature a claim the compiler
 * checks: drop a method, rename a parameter's type, demand something the
 * system does not have, and the build fails on the port, not on a tick.
 */
type Conforms<T extends P, P> = true;
const _trade: Conforms<TradeSystem, TradePort> = true;
const _wallet: Conforms<WalletSystem, WalletPort> = true;
const _auction: Conforms<AuctionSystem, AuctionPort> = true;
const _vendors: Conforms<VendorSystem, VendorPort> = true;
const _gathering: Conforms<GatheringSystem, GatheringPort> = true;
const _chests: Conforms<ChestSystem, ChestPort> = true;
const _breaks: Conforms<BreakSystem, BreakPort> = true;
const _residents: Conforms<ResidentSystem, ResidentPort> = true;
void [_trade, _wallet, _auction, _vendors, _gathering, _chests, _breaks, _residents];

/** The system in this kit that answers each port, by prototype so nothing is built. */
const ANSWERED_BY: Readonly<Partial<Record<keyof GatewayPorts, object>>> = {
  trade: TradeSystem.prototype,
  wallet: WalletSystem.prototype,
  auction: AuctionSystem.prototype,
  vendors: VendorSystem.prototype,
  gathering: GatheringSystem.prototype,
  chests: ChestSystem.prototype,
  breaks: BreakSystem.prototype,
  residents: ResidentSystem.prototype,
};

/**
 * The ports another kit answers. Naming them is what keeps the split honest:
 * a new port that neither half claims fails the completeness check below
 * rather than going unguarded because each kit assumed the other had it.
 */
const ELSEWHERE: readonly (keyof GatewayPorts)[] = [
  "combat",
  "life",
  "abilities",
  "telegraphs",
  "statuses",
  "duels",
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
  // Every port is answered by one half or the other, and no key is claimed by
  // both: this kit's eight plus the six `kit-combat` guards are the table.
  const mine = Object.keys(ANSWERED_BY) as (keyof GatewayPorts)[];
  assert.deepEqual(
    [...mine, ...ELSEWHERE].sort(),
    GATEWAY_PORTS.map((d) => d.key).sort(),
    "a port is guarded by neither kit, or by both",
  );
  for (const key of ELSEWHERE) {
    assert.ok(!(key in ANSWERED_BY), `${key} is claimed here and in kit-combat`);
  }
});
