/**
 * The port table and the interfaces beside it (roadmap ES5i).
 *
 * `net/ports.ts` holds two statements of the same thing, written by hand: an
 * interface the gateway's call sites are typed against, and a `PortDecl` row
 * the boot checks a provider against. Nothing but a test makes them say the
 * same thing — a method on one and not the other is either a call no provider
 * has to answer or a demand the boot never enforces — and nothing but a test
 * keeps the gateway asking by port rather than drifting back to a class.
 *
 * These guards were in `kit-combat`'s suite for a day, because they travelled
 * with the file that constructs the nine combat systems (`ES5h`). They are the
 * engine's own contract and they need no system at all, so they live here: a
 * kit holding the gates on the engine's ports is backwards, and the economy
 * ports' rows (`ES5i` put `reconcile` on the wallet and `define` on the
 * vendor) are checked here for the same reason.
 *
 * What stayed in the kit is what needs a real system: the compile-time
 * `Conforms` claims, and opening the ports over the systems themselves.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPorts } from "@mmo-engine/sdk";
import { GATEWAY_PORTS, type GatewayPorts } from "../../src/net/ports.js";

const srcPath = (...parts: string[]): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", ...parts);
const SRC = srcPath("net", "gateway.ts");
const PORTS_SRC = srcPath("net", "ports.ts");

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
    "@mmo-engine/rules",
    "@mmo-engine/sdk",
  ]);
});

test("the engine's own wiring reaches for no kit (ES5f, ES6a)", () => {
  // `server.ts`, `services.ts` and `net/gateway.ts` are the engine's wiring:
  // the three files a kit has to be able to leave behind entirely. They each
  // named a class — `BodySystem`, `MagicSystem`, `CombatSystem`,
  // `TelegraphSystem` — to type what they were handed, and a type import is
  // still a module a kit's package would have to provide. They ask by port
  // now, the nine systems have gone to `@mmo-engine/kit-combat` (ES6a), and
  // what stands here is that this wiring cannot reach after them: not by
  // package name, and not by class either, since naming a class is how the
  // module crept back in last time.
  const CLASSES = [
    "AbilitySystem",
    "BodySystem",
    "CombatSystem",
    "DeathSystem",
    "DuelSystem",
    "MagicSystem",
    "StaminaSystem",
    "StatusSystem",
    "TelegraphSystem",
  ];
  for (const file of ["server.ts", "services.ts", "net/gateway.ts"]) {
    const raw = readFileSync(srcPath(...file.split("/")), "utf8");
    // Prose may say what moved and why; only the code is held to the line.
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const m of text.matchAll(/from "([^"]+)"/g)) {
      assert.doesNotMatch(
        m[1] as string,
        /kit-/,
        `${file} imports ${m[1] as string}; the engine's wiring asks by port, so a kit can own that module`,
      );
    }
    // `import("./magic.js").MagicSystem` is an import too, and it was there.
    assert.doesNotMatch(text, /import\("[^"]*kit-[^"]*"\)/);
    for (const name of CLASSES) {
      assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`), `${file} names ${name}, which is a kit's now`);
    }
  }
});
