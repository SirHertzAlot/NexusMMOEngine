/**
 * The engine does not have quests (roadmap `ES5o`–`ES5p`).
 *
 * `ES5o` took the engine's three holds on them and left the code where it
 * was: `services.ts` stopped importing the `QuestService` class and declared
 * the two interfaces the host calls, the gateway's four inline
 * `as unknown as { ... }` casts became one `QuestExtension`, and `server.ts`
 * gave up holding the quest store to put a character's log on its world
 * record. The real find was `place`: a scene saying where a quest starts was
 * carried out by reaching through the service into its content, so a game
 * whose quests are not keyed by giver could not place one at all.
 *
 * `ES5p` moved the code. The seven files are `@mmo-engine/kit-quests` now, so
 * what this file holds is a line rather than a list:
 *
 * 1. None of what moved is back in `src`.
 * 2. Nothing in `src` names one of the kit's exports in code.
 * 3. The engine still declares what it asks for, where neither side owns it.
 *
 * The general clause — that `engine-core/src` imports no `@mmo-engine/kit-*`
 * at all, by package name or any other route — is in
 * `test/economy/engine-boundary.test.ts` and covers every kit, so it is not
 * repeated here.
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

/** This test runs from packages/engine-core/dist/test/quests. */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

/**
 * What moved into `@mmo-engine/kit-quests`, by the path it used to have.
 *
 * Kept as the old paths on purpose: the failure this guards against is
 * someone re-adding one of these here rather than in the kit, and the message
 * naming the path it used to live at is the useful one.
 */
const MOVED = [
  "quests/content.ts",
  "quests/generate.ts",
  "quests/quest-def.ts",
  "quests/quest-log.ts",
  "quests/quest-service.ts",
  "quests/quest-store.ts",
  "quests/worldbuilding-generics.ts",
];

/**
 * The kit's exports, which nothing in the engine should be able to name.
 *
 * `QuestService` is deliberately not in this list, though the kit exports a
 * class by that name: `services.ts` declares an *interface* of the same name,
 * which is the host's statement of what it calls rather than a reference to
 * the class. Same reason `lessonTerms` is excluded from the economy's list —
 * a name the host owns too is not a coupling. `QuestRecords` and
 * `QuestExtension` are the engine's own names and appear nowhere in the kit.
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
  "advancePact",
  "composeGiverProfile",
  "performRite",
  "treatSickPlace",
  "STRUCTURE_SKINS",
  "CHARACTER_MOTIVATIONS",
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
  assert.deepEqual(back, [], "these belong in packages/kit-quests/src, not in the engine");
  assert.equal(existsSync(join(SRC, "quests")), false, "src/quests should be gone, not empty");
});

test("nothing in the engine names one of the kit's exports", () => {
  const offenders: string[] = [];
  for (const rel of sources()) {
    const text = code(rel);
    const named = NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    if (named.length > 0) offenders.push(`${rel} (names ${named.join(", ")})`);
  }
  assert.deepEqual(offenders, [], "a name here is a game's quests the engine cannot do without");
});

test("the engine declares what it asks for instead", () => {
  // What the host calls, and what rides a character's world record, in
  // services.ts beside the other eight the registry declares.
  const services = code("services.ts");
  for (const decl of ["export interface QuestService extends GatewayExtension {", "export interface QuestRecords {"]) {
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
  const extension = code("net/extension.ts");
  assert.match(extension, /export interface QuestExtension extends GatewayExtension/);
  for (const member of ["pinnedResidentsOf?", "npcOfResident?", "talkAt?"]) {
    assert.ok(extension.includes(member), `QuestExtension should offer ${member}`);
  }

  // And the gateway uses that name rather than writing the shape out again.
  const gateway = code("net/gateway.ts");
  assert.equal(
    [...gateway.matchAll(/pinnedResidentsOf/g)].length,
    2,
    "pinnedResidentsOf should appear only where it is called, not in a repeated inline type",
  );
  assert.doesNotMatch(gateway, /as unknown as \{[^}]*pinnedResidentsOf/);
  assert.doesNotMatch(gateway, /as unknown as \{[^}]*npcOfResident/);
  assert.equal([...gateway.matchAll(/as QuestExtension \| undefined/g)].length, 3);

  // The four names the public entry gained for the kit to be writable from
  // outside this repository, each exported rather than reachable only by a
  // deep path into dist.
  const index = code("index.ts");
  assert.match(index, /export type \{ ExtensionPlayer, GatewayExtension, QuestExtension \} from "\.\/net\/extension\.js";/);
  assert.match(index, /export \{ hash \} from "\.\/procgen\/ecology\.js";/);
});
