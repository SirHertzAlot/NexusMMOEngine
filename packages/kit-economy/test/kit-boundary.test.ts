/**
 * No kit's `src/` imports another kit (`ES5`).
 *
 * This is what keeps the kits separable rather than one template in six
 * folders: a game may take `kit-economy` and replace `kit-combat` with its
 * own fighting, or the other way round, and neither has to come along. The
 * engine's side of the same rule — that `engine-core/src` imports no kit at
 * all — is pinned in `engine-core/test/economy/engine-boundary.test.ts`.
 *
 * The rule is the repo's, not this kit's, so the scan finds every
 * `packages/kit-*` rather than naming them. It lives here because this kit
 * holds the only *test* dependency on another kit (see the README), so the
 * rule and its one exception are written down together: the exception is in
 * `test/`, and the assertion below is about `src/`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/** This test runs from packages/kit-economy/dist/test. */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const PACKAGES = join(REPO, "packages");

const kits = (): string[] =>
  readdirSync(PACKAGES)
    .filter((name) => name.startsWith("kit-"))
    .filter((name) => {
      try {
        return statSync(join(PACKAGES, name, "src")).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

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

describe("kit boundary (ES5)", () => {
  it("finds the kits in the repo rather than naming them", () => {
    // If this ever drops to one, the test below proves nothing: it would be
    // asserting that the only kit does not import itself.
    const found = kits();
    assert.ok(found.length >= 2, `expected at least two kits, found ${JSON.stringify(found)}`);
    assert.ok(found.includes("kit-economy"), "this kit should be in its own scan");
  });

  it("no kit's src imports another kit", () => {
    for (const kit of kits()) {
      const self = `@mmo-engine/${kit}`;
      for (const file of sources(join(PACKAGES, kit, "src"))) {
        const rel = file.slice(REPO.length);
        for (const spec of specifiers(readFileSync(file, "utf8"))) {
          // A relative path cannot leave the package without `../..`, which
          // would also have to climb out of `src`; the package specifiers are
          // what a cross-kit import actually looks like.
          if (!spec.startsWith("@mmo-engine/kit-")) continue;
          const other = spec.split("/").slice(0, 2).join("/");
          assert.equal(other, self, `${rel} imports ${other}, which is another kit`);
        }
      }
    }
  });

  it("a kit may reach the engine, which is the contract both sides share", () => {
    // Not a loophole being closed, a shape being pinned: the engine is how
    // the kits meet, so every kit depends on it and that is the only package
    // dependency the rule above cares about.
    const economy = sources(join(PACKAGES, "kit-economy", "src"))
      .flatMap((f) => specifiers(readFileSync(f, "utf8")))
      .filter((s) => s.startsWith("@mmo-engine/"));
    assert.ok(economy.includes("@mmo-engine/engine-core"), "this kit should reach the engine");
    assert.deepEqual(
      economy.filter((s) => s.startsWith("@mmo-engine/kit-")),
      [],
      "and no kit",
    );
  });
});
