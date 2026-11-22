/**
 * The vocabulary boundary (roadmap ES5): the types the engine and a game's
 * systems share are declared where neither owns the other.
 *
 * Before this, nine files across items, quests, dungeons, creatures and the
 * server imported `combat.ts` or `death.ts` to name a type — so a kit could
 * not take those systems out of engine-core without the rest of the engine
 * following. The test reads the sources, the same way the ES2 and ES4 gates
 * do, because what matters is which module an import names.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** This test runs from packages/engine-core/dist/test. */
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

const tsFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
};

const ALL = tsFiles(SRC).map((p) => ({ rel: p.slice(SRC.length), text: readFileSync(p, "utf8") }));

describe("ES5: the shared vocabulary", () => {
  it("declares Weapon and LifeEvent, and nothing else declares them", () => {
    const vocabulary = ALL.find((f) => f.rel === "vocabulary.ts");
    assert.ok(vocabulary, "packages/engine-core/src/vocabulary.ts should exist");
    assert.match(vocabulary.text, /export interface Weapon \{/);
    assert.match(vocabulary.text, /export interface LifeEvent \{/);
    for (const f of ALL) {
      if (f.rel === "vocabulary.ts") continue;
      assert.doesNotMatch(f.text, /export interface (Weapon|LifeEvent) \{/, `${f.rel} declares one of them too`);
    }
  });

  it("depends on the rules package and nothing of the engine's", () => {
    const vocabulary = ALL.find((f) => f.rel === "vocabulary.ts")!;
    const imports = [...vocabulary.text.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
    assert.deepEqual(imports, ["@mmo-engine/rules"], `vocabulary.ts should import only the rules: ${imports.join(", ")}`);
  });

  it("is where every file reads them from, so a system can leave without them", () => {
    for (const f of ALL) {
      for (const m of f.text.matchAll(/import[^;]*?\b(Weapon|LifeEvent)\b[^;]*?from "([^"]+)"/g)) {
        assert.match(
          m[2] as string,
          /vocabulary\.js$/,
          `${f.rel} reads ${m[1]} from ${m[2]}; it belongs to no system, so it comes from vocabulary.js`,
        );
      }
    }
  });

  it("keeps the engine's public exports where they were", () => {
    // A consumer importing them from the package index is unaffected by the move.
    const index = ALL.find((f) => f.rel === "index.ts")!;
    assert.match(index.text, /export type \{ LifeEvent, Weapon \} from "\.\/vocabulary\.js"/);
  });
});
