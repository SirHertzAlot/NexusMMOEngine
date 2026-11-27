/**
 * The engine does not have quests (roadmap `ES5o`).
 *
 * The same boundary `ES5i`–`ES5m` drew around the economy, drawn around the
 * quests before their code moves. Nothing here moves a file: what it changes
 * is who asks whom.
 *
 * Three couplings were in the way, and each was the engine knowing something
 * only a game can know:
 *
 * 1. `services.ts` typed the registry's `quests` row by importing the
 *    `QuestService` *class*. It declares the interface itself now — what the
 *    host calls, which is `place` and `onDeath` on top of being a gateway
 *    extension.
 * 2. The gateway asked three questions of `extensions.get("quest")` through
 *    an `as unknown as { ... }` shape written out at four call sites. That
 *    shape is `QuestExtension` in `net/extension.ts`, once.
 * 3. `server.ts` held the quest store itself to put a character's log on its
 *    world record, and — the real leak — carried out a scene's "stand this
 *    quest's giver here" by reaching through the service into its `content`
 *    with a cast, looking up the giver and writing the NPC's coordinates. A
 *    game whose quests are not keyed by giver could not be placed at all.
 *    The service answers `place` now, and the log rides a `QuestRecords`
 *    facade a module publishes, rows `unknown` in both directions.
 *
 * What this test holds is the result: outside `src/quests/`, the engine
 * neither imports that directory nor names anything in it. That is what makes
 * the move itself (`ES5p`) a rewrite of import paths and nothing else.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** This test runs from packages/engine-core/dist/test/quests. */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

/** Every `.ts` under `dir`. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) sources(abs, out);
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/** The engine's own sources, excluding the quests directory itself. */
const outsideQuests = (): [string, string][] =>
  sources(SRC)
    .map((f) => [relative(SRC, f).split("\\").join("/"), readFileSync(f, "utf8")] as [string, string])
    .filter(([rel]) => !rel.startsWith("quests/"));

/**
 * The quests' own exports, which nothing in the engine should be able to
 * name.
 *
 * `QuestService` is deliberately not in this list, though `quest-service.ts`
 * exports a class by that name: `services.ts` declares an *interface* of the
 * same name, which is the host's statement of what it calls rather than a
 * reference to the class. Same reason `lessonTerms` is excluded from the
 * economy's list — a name the host owns too is not a coupling. `QuestRecords`
 * and `QuestExtension` are the engine's own names and appear nowhere in
 * `quests/`.
 */
const NAMES = [
  "SqliteQuestStore",
  "MemoryQuestStore",
  "questRecordsOf",
  "QuestLog",
  "QuestStore",
  "QuestContent",
  "QuestDef",
  "QuestRecord",
  "loadQuestContent",
  "checkQuestContent",
  "parseQuestContent",
  "generateQuest",
  "authoredQuest",
  "DEFAULT_QUEST_DIR",
  "EMPTY_QUEST_CONTENT",
];

test("nothing outside src/quests imports it", () => {
  // Static and dynamic both: `server.ts` was reaching the store through an
  // inline `import("./quests/quest-store.js").SqliteQuestStore` type, which a
  // check on `from "..."` alone would have walked straight past.
  const offenders: string[] = [];
  for (const [rel, text] of outsideQuests()) {
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1] as string;
      if (!spec.startsWith(".")) continue;
      const abs = resolve(dirname(join(SRC, rel)), spec);
      if (relative(SRC, abs).split("\\").join("/").startsWith("quests/")) offenders.push(`${rel} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "engine sources importing the quests");
});

test("nothing outside src/quests names one of its exports", () => {
  const offenders: string[] = [];
  for (const [rel, text] of outsideQuests()) {
    // Comments are fine and there are several: the coupling is a specifier or
    // an identifier in code, not prose about where the quests went.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const name of NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [], "engine sources naming a quests export");
});

test("the engine declares what it asks for instead", () => {
  const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

  // What the host calls, and what the world record carries, in services.ts
  // beside the other eight the registry declares.
  const services = read("services.ts");
  for (const decl of [
    "export interface QuestService extends GatewayExtension {",
    "export interface QuestRecords {",
  ]) {
    assert.ok(services.includes(decl), `services.ts should declare ${decl}`);
  }
  // Anchored at the end of the line, not a substring: a signature widened to
  // `string | null | undefined` contains the narrow one, so `includes` would
  // have called a weaker demand the same demand.
  for (const member of [
    "place(quest: string, x: number, z: number): string | null;",
    "loadQuests(charId: number): readonly unknown[];",
    "replaceQuests(charId: number, rows: unknown): void;",
  ]) {
    assert.match(
      services,
      new RegExp(`^\\s*${member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
      `services.ts should declare exactly: ${member}`,
    );
  }

  // What the gateway asks of the "quest" extension, in one place.
  const extension = read("net/extension.ts");
  assert.match(extension, /export interface QuestExtension extends GatewayExtension/);
  for (const member of ["pinnedResidentsOf?", "npcOfResident?", "talkAt?"]) {
    assert.ok(extension.includes(member), `QuestExtension should offer ${member}`);
  }

  // And the gateway uses that name rather than writing the shape out again.
  const gateway = read("net/gateway.ts");
  assert.equal(
    [...gateway.matchAll(/pinnedResidentsOf/g)].length,
    2,
    "pinnedResidentsOf should appear only where it is called, not in a repeated inline type",
  );
  assert.doesNotMatch(gateway, /as unknown as \{[^}]*pinnedResidentsOf/);
  assert.doesNotMatch(gateway, /as unknown as \{[^}]*npcOfResident/);
  assert.equal([...gateway.matchAll(/as QuestExtension \| undefined/g)].length, 3);
});
