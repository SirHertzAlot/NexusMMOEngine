/**
 * This kit's boundary with the engine.
 *
 * `kit-combat` and `kit-economy` have the same file (`ES6a`, `ES5n`); the
 * cross-kit scan lives in `kit-economy`'s copy, because that is the kit that
 * holds the only test dependency on another kit and the rule belongs beside
 * its exception. What is left to hold here is this kit's own side of the
 * engine line, and it is worth holding separately rather than trusting the
 * other two: the quests were the first thing moved out that the *gateway*
 * talks to directly, so the temptation to reach for an engine internal was a
 * real one — `QuestService` is an extension rather than a port, and the three
 * questions the gateway asks it had been written out inline at four call
 * sites until `ES5o` gave them a name.
 *
 * It did not need widening to make this pass. `ExtensionPlayer`,
 * `GatewayExtension`, `QuestExtension` and `hash` are the four names the
 * engine's public entry gained at `ES5p`, and they are the whole of what this
 * kit asks of the engine beyond the vocabulary every kit uses.
 *
 * The engine's side of the same rule — that nothing in `engine-core/src`
 * imports or names any of this — is pinned in
 * `engine-core/test/quests/engine-boundary.test.ts`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** This test runs from packages/kit-quests/dist/test. */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = join(REPO, "packages", "kit-quests", "src");

/** Every `.ts` under a directory, recursively. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every module specifier a file imports, static or dynamic. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  return found;
}

describe("kit boundary (ES5p)", () => {
  const files = sources(SRC);

  it("reaches the engine only through its public entry", () => {
    // A kit written outside this repository would have the bare specifier and
    // nothing more, so these sources have the same. A deep `dist/src/...`
    // path would compile and work, and would also be a claim this kit cannot
    // be written by anyone else.
    assert.ok(files.length >= 7, `expected this kit's sources, found ${files.length}`);
    const specs = files.flatMap((f) => specifiers(readFileSync(f, "utf8")));
    assert.ok(specs.includes("@mmo-engine/engine-core"), "this kit should reach the engine");
    for (const spec of specs) {
      assert.doesNotMatch(
        spec,
        /^@mmo-engine\/engine-core\//,
        `a source imports an engine internal (${spec}); a kit outside this repo could not`,
      );
    }
  });

  it("imports no other kit", () => {
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith("@mmo-engine/kit-")) continue;
        const other = spec.split("/").slice(0, 2).join("/");
        assert.equal(other, "@mmo-engine/kit-quests", `${file.slice(REPO.length)} imports ${other}`);
      }
    }
  });

  it("asks the engine for four names and the vocabulary, nothing more", () => {
    // Named, not counted: the list is the kit's half of the contract, and it
    // should be read in a review rather than inferred from a number. The
    // components and world types are the vocabulary every kit uses; the four
    // of interest are the two extension types, the demand the gateway makes,
    // and the mixer a generated quest seeds from.
    const imported = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@mmo-engine\/engine-core"/g)) {
        for (const part of (m[1] as string).split(",")) {
          const name = part.trim().replace(/^type\s+/, "");
          if (name) imported.add(name);
        }
      }
    }
    assert.deepEqual(
      [...imported].sort(),
      ["CharacterRef", "ExtensionPlayer", "GatewayExtension", "LifeEvent", "SimSystem", "SimWorld", "Transform", "hash"],
      "this kit's demand on the engine changed; say so in the roadmap if it grew",
    );
  });
});
