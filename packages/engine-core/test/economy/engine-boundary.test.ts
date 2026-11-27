/**
 * The engine does not have an economy (roadmap `ES5i`–`ES5n`).
 *
 * This file has been the running record of one boundary being drawn, and the
 * shape of it changed with `ES5n`. It began as a list of the three places that
 * still *constructed* an economy system, and shrank: `ES5j` took the dungeon
 * run's, `ES5k` gathering, `ES5l` the chests and breakables, `ES5m` the last
 * import. Each of those left the code where it was and moved only the asking.
 *
 * `ES5n` moved the code. The eleven modules and the run's own wiring are
 * `@mmo-engine/kit-economy` now, so there is no longer a list of files to
 * watch — there is a line, and this test is what holds it:
 *
 * 1. None of what moved is back in `src`.
 * 2. Nothing in `src` imports a kit, by package name or by any other route.
 * 3. Nothing in `src` names one of their classes in code.
 * 4. The terms both sides speak are still declared where neither owns them.
 *
 * A kit may import the engine. The engine may not import a kit, and may not
 * know a kit's names — that is the whole difference between a game built on
 * this engine and a game built into it.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

/**
 * What moved into `@mmo-engine/kit-economy`, by the path it used to have.
 *
 * Kept as the old paths on purpose: the failure this guards against is
 * someone re-adding one of these here rather than in the kit, and the message
 * that names the path it used to live at is the useful one.
 */
const MOVED = [
  "economy/auction.ts",
  "economy/trade.ts",
  "economy/vendor.ts",
  "economy/wallet.ts",
  "economy/wallet-store.ts",
  "gathering/gathering.ts",
  "gathering/gathering-store.ts",
  "gathering/index.ts",
  "interact/breaks.ts",
  "interact/chests.ts",
  "residents/resident-system.ts",
  "residents/lessons.ts",
  "residents/index.ts",
  "dungeons/default-world.ts",
];

/**
 * Their exports, which nothing in the engine should be able to name.
 *
 * `lessonTerms` is deliberately not in this list, though the kit exports it:
 * `server.ts` carries `stores.lessonTerms` — the host's own key for what a
 * module handed back, which names the thing rather than reaching for it. A
 * key cannot import anything, and the import itself is what the test above
 * catches.
 */
const NAMES = [
  "AuctionSystem",
  "BreakSystem",
  "ChestSystem",
  "GatheringSystem",
  "ResidentSystem",
  "SqliteGatheringStore",
  "SqliteWalletStore",
  "TradeSystem",
  "VendorSystem",
  "WalletSystem",
  "breakDefsOf",
  "defaultDungeonWorld",
  "loadLessons",
  "materialCountsOf",
  "nodeStocksOf",
];

/** Every `.ts` under `src`, relative and posix. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".ts")) out.push(relative(SRC, abs).split("\\").join("/"));
    }
  };
  walk(SRC);
  return out.sort();
}

/** A file's text with comments stripped: prose may name what moved, and does. */
function code(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("none of what moved into the kit is back in the engine", () => {
  const back = MOVED.filter((rel) => existsSync(join(SRC, rel)));
  assert.deepEqual(back, [], "these belong in packages/kit-economy/src, not in the engine");
});

test("nothing in the engine imports a kit", () => {
  // Any kit, not just this one: the engine is what a kit is built on, so an
  // import in this direction is a cycle as well as a leak.
  const offenders: string[] = [];
  for (const rel of sources()) {
    const specs = [...code(rel).matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
    const kits = specs.filter((s) => s.startsWith("@mmo-engine/kit-") || /(^|\/)kit-[a-z]+\//.test(s));
    if (kits.length > 0) offenders.push(`${rel} imports ${kits.join(", ")}`);
  }
  assert.deepEqual(offenders, [], "the engine may not import a kit");
});

test("nothing in the engine names one of the kit's classes", () => {
  const offenders: string[] = [];
  for (const rel of sources()) {
    const text = code(rel);
    const named = NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    if (named.length > 0) offenders.push(`${rel} (names ${named.join(", ")})`);
  }
  assert.deepEqual(offenders, [], "a name here is a module the engine cannot do without");
});

test("the vocabulary carries what both sides need instead", () => {
  // The terms the gateway and a kit speak are declared where neither owns
  // them, and `vocabulary.ts` imports nothing of the engine's so that a kit
  // can depend on it without depending on the engine's internals.
  const vocab = readFileSync(join(SRC, "vocabulary.ts"), "utf8");
  for (const name of ["ResourceNodeSpec", "LessonTerms", "LessonOffer", "ChestSpec", "ChestCheck", "ChestResult"]) {
    // Some are interfaces and some are unions of result shapes; either way
    // the point is that the declaration is here.
    assert.match(vocab, new RegExp(`export (?:interface|type) ${name}\\b`), `${name} should be shared vocabulary`);
  }
  const specs = [...vocab.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual([...new Set(specs)], ["@mmo-engine/rules"], "vocabulary.ts may import the rules and nothing else");

  // And the three ways a host reaches what a kit built, each still declared
  // on this side: the gateway's ports, the registry's services, and the
  // dungeon run's two slots.
  for (const port of ["AuctionPort", "BreakPort", "ChestPort", "GatheringPort", "ResidentPort", "TradePort", "VendorPort", "WalletPort"]) {
    assert.match(code("net/ports.ts"), new RegExp(`\\b${port}\\b`), `the gateway should still ask for ${port}`);
  }
  for (const svc of ["gathering: GatheringService", "chests: ChestService", "breaks: BreakService"]) {
    assert.match(code("services.ts"), new RegExp(svc), `the registry should still carry "${svc}"`);
  }
  assert.match(code("dungeons/world-slot.ts"), /export type DungeonWorldFactory/, "the run should still have a world slot");
  assert.match(code("dungeons/instance.ts"), /from "\.\/world-slot\.js"/, "a run should reach its props through the slot");

  // The interact barrel is what is left of that directory, and what is left
  // is the host's own: the places store, two content loaders, and collapse.
  const barrel = code("interact/index.ts");
  for (const own of ["SqlitePlacesStore", "loadVendors", "loadStructureBreakables", "CollapseSystem"]) {
    assert.match(barrel, new RegExp(`\\b${own}\\b`), `${own} is the host's and should stay in the barrel`);
  }
});
