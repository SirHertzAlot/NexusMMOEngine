/**
 * What the engine still names of the economy (roadmap ES5i).
 *
 * `ES4d` made the gateway ask for the eight economy and world systems by port,
 * but the rest of the engine still named their classes to type what it was
 * handed, and that is the same thing in a different place: a type import is a
 * module `@mmo-engine/kit-economy` would have to provide. The registry asks
 * for `WalletPort`, `VendorPort` and `ResidentPort` now; loot drops and the
 * world sync state their own one- and two-method demands; `scene-spawn.ts`
 * reads `ResourceNodeSpec` from the shared vocabulary; and the gateway asks a
 * game what a lesson is worth instead of working it out from
 * `residents/lessons.ts`.
 *
 * What is left is construction, and it is listed below rather than hidden:
 * three files still *build* an economy system, each for a reason that takes
 * its own change. This test fails if a fourth appears, and it fails if one of
 * the three starts reaching for something new — which is what stops the
 * boundary drifting back while those changes are made.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

/** The modules that become `@mmo-engine/kit-economy`. */
const KIT = [
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
];

/** Their classes, which nothing in the engine should have to name. */
const CLASSES = [
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
];

/**
 * The three that still build one, and what each is waiting on.
 *
 * Listed so that the boundary is a fact in a test rather than something a
 * reader has to work out, and so that the next three changes have somewhere
 * to delete a line from.
 */
const BUILDS: Readonly<Record<string, string>> = {
  // A barrel over `breaks.ts` and `chests.ts`: it goes when they do.
  "interact/index.ts": "the interact barrel re-exports them",
  // `server.ts` still builds the chest and break systems inline. Gathering
  // left for `modules/gathering` at `ES5k`; these two share the places
  // store, the respawn pool, the loot table and the collapse system with
  // the host, so they take a module of their own (`ES5l`).
  "server.ts": "chests and breaks have no module to build them",
  // The engine's own wiring of the run's world slot (`ES5j`), kept off the
  // boot path exactly so it can move into the kit unchanged — the same place
  // `dungeons/default-combat.ts` stood before `ES5h` took it.
  "dungeons/default-world.ts": "it is the kit's own file, waiting for the kit",
};

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

/** A file's text with comments stripped: prose may name what moved. */
function code(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("only the three known files still name an economy system", () => {
  const offenders: string[] = [];
  for (const rel of sources()) {
    if (KIT.includes(rel)) continue;
    const text = code(rel);
    const named = CLASSES.filter((c) => new RegExp(`\\b${c}\\b`).test(text));
    const imported = [...text.matchAll(/from "(\.[^"]*)"/g)]
      .map((m) => relative(SRC, resolve(SRC, dirname(rel), m[1] as string)).split("\\").join("/"))
      .map((p) => p.replace(/\.js$/, ".ts"))
      .filter((p) => KIT.includes(p));
    if (named.length === 0 && imported.length === 0) continue;
    if (BUILDS[rel] !== undefined) continue;
    offenders.push(`${rel} (names ${named.join(", ") || "-"}; imports ${imported.join(", ") || "-"})`);
  }
  assert.deepEqual(offenders, [], "engine files naming an economy system that are not a known construction site");
});

test("each known construction site is still there, so the list cannot rot", () => {
  // The other half: a file that stops building one should be taken off this
  // list in the same change, or the list quietly becomes a licence.
  for (const [rel, why] of Object.entries(BUILDS)) {
    const text = code(rel);
    const touches =
      CLASSES.some((c) => new RegExp(`\\b${c}\\b`).test(text)) ||
      [...text.matchAll(/from "(\.[^"]*)"/g)].some((m) =>
        KIT.includes(relative(SRC, resolve(SRC, dirname(rel), m[1] as string)).split("\\").join("/").replace(/\.js$/, ".ts")),
      );
    assert.ok(touches, `${rel} no longer builds an economy system (${why}); take it off the list`);
  }
});

test("the vocabulary carries what the engine needs instead", () => {
  // `scene-spawn.ts` wants the shape of a thing worth gathering; the gateway
  // wants what a lesson is worth. Both are shared terms now, and
  // `vocabulary.ts` still imports nothing of the engine's.
  const vocab = readFileSync(join(SRC, "vocabulary.ts"), "utf8");
  for (const name of ["ResourceNodeSpec", "LessonTerms", "LessonOffer"]) {
    assert.match(vocab, new RegExp(`export interface ${name} \\{`), `${name} should be shared vocabulary`);
  }
  const specs = [...vocab.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual([...new Set(specs)], ["@mmo-engine/rules"], "vocabulary.ts may import the rules and nothing else");

  assert.doesNotMatch(code("scene-spawn.ts"), /gathering\//, "scene-spawn.ts should read the spec from the vocabulary");
  assert.doesNotMatch(code("net/gateway.ts"), /residents\/lessons/, "the gateway should ask a game what a lesson is worth");
  // And a dungeon run reaches its chests, breakables and veins through the
  // slot in `dungeons/world-slot.ts`, the way it reaches its fighting.
  assert.doesNotMatch(code("dungeons/instance.ts"), /from "\.\.\/(interact|gathering)\//, "a run should ask for its props, not build them");
  assert.match(code("dungeons/instance.ts"), /from "\.\/world-slot\.js"/, "the run should know the slot");
  // And the entry point asks for gathering rather than building it (ES5k).
  assert.doesNotMatch(code("server.ts"), /from "\.\/gathering\//, "server.ts should ask for the gathering service");
  assert.match(code("services.ts"), /gathering: GatheringService/, "the registry should carry it");
});
