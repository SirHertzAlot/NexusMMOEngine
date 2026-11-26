/**
 * The vocabulary boundary (roadmap ES5): the types the engine and a game's
 * systems share are declared where neither owns the other.
 *
 * Before `ES5a`, nine files across items, quests, dungeons, creatures and the
 * server imported `combat.ts` or `death.ts` to name a type — so a kit could
 * not take those systems out of engine-core without the rest of the engine
 * following. `ES5b` added what a system *announces*: a hit, an ability, a
 * telegraph, a status and a duel all reach the client, so the gateway's port
 * file had to name their shapes, and while they lived inside the systems
 * that meant importing the systems.
 *
 * The test reads the sources, the same way the ES2 and ES4 gates do, because
 * what matters is which module an import names.
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

/** Everything the vocabulary owns: the shared nouns, then what a system announces. */
const VOCABULARY = [
  "Weapon",
  "LifeEvent",
  "HitEvent",
  "AbilityEvent",
  "AbilityState",
  "TriggerResult",
  "TelegraphEvent",
  "TelegraphShape",
  "StatusChange",
  "DuelEvent",
  "DuelEndReason",
] as const;

const DECLARES = (name: string): RegExp => new RegExp(`export (interface|type) ${name}\\b`);

describe("ES5: the shared vocabulary", () => {
  it("declares every shared type, and nothing else declares them", () => {
    const vocabulary = ALL.find((f) => f.rel === "vocabulary.ts");
    assert.ok(vocabulary, "packages/engine-core/src/vocabulary.ts should exist");
    for (const name of VOCABULARY) {
      assert.match(vocabulary.text, DECLARES(name), `vocabulary.ts should declare ${name}`);
      for (const f of ALL) {
        if (f.rel === "vocabulary.ts") continue;
        assert.doesNotMatch(f.text, DECLARES(name), `${f.rel} declares ${name} too`);
      }
    }
  });

  it("depends on the rules package and nothing of the engine's", () => {
    const vocabulary = ALL.find((f) => f.rel === "vocabulary.ts")!;
    const imports = [...vocabulary.text.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
    assert.deepEqual(imports, ["@mmo-engine/rules"], `vocabulary.ts should import only the rules: ${imports.join(", ")}`);
  });

  it("is where every file reads them from, so a system can leave with none of them", () => {
    for (const f of ALL) {
      if (f.rel === "vocabulary.ts") continue;
      for (const m of f.text.matchAll(/import[^;]*?from "([^"]+)"/g)) {
        const spec = m[1] as string;
        if (spec.endsWith("vocabulary.js")) continue;
        for (const name of VOCABULARY) {
          assert.doesNotMatch(
            m[0] as string,
            new RegExp(`\\b${name}\\b`),
            `${f.rel} reads ${name} from ${spec}; it belongs to no system, so it comes from vocabulary.js`,
          );
        }
      }
    }
  });

  it("leaves the gateway's combat ports naming no system at all", () => {
    // The point of the move: a port says what a system announces, and saying
    // it must not mean importing the system — not even as a type.
    const ports = ALL.find((f) => f.rel === "net/ports.ts");
    assert.ok(ports, "net/ports.ts should exist");
    const specs = [...ports.text.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
    for (const system of [
      "../combat.js",
      "../death.js",
      "../abilities.js",
      "../telegraph.js",
      "../status.js",
      "../duel.js",
    ]) {
      assert.ok(!specs.includes(system), `net/ports.ts still imports ${system}`);
    }
  });

  it("keeps the engine's public exports where they were", () => {
    // A consumer importing them from the package index is unaffected by the move.
    const index = ALL.find((f) => f.rel === "index.ts")!;
    for (const name of VOCABULARY) {
      assert.match(index.text, new RegExp(`^  ${name},$`, "m"), `the package index should still export ${name}`);
    }
    assert.match(index.text, /\} from "\.\/vocabulary\.js";/);
  });
});
