/**
 * The line between this kit and the engine (roadmap ES6a).
 *
 * The nine systems left `@mmo-engine/engine-core` because the engine stopped
 * being able to name them. That only stays true if nobody reaches back across
 * the line, in either direction, and neither direction is something a type
 * error would catch: the engine can import a kit perfectly happily, and this
 * kit can import engine internals by path perfectly happily. So the line is
 * a test.
 *
 * Source files here use the bare `@mmo-engine/engine-core` specifier — the
 * engine's public surface, the same thing a kit written outside this
 * repository would have. The tests are allowed further, because several of
 * them boot a whole region gateway to watch fighting happen inside it, and a
 * deep path says "this is an integration test" where widening the engine's
 * public API to tidy the import would have said something false.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as engine from "@mmo-engine/engine-core";

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = resolve(here, "..", "..");
const engineSrc = resolve(kitRoot, "..", "engine-core", "src");

/** Every `.ts` file under `dir`. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...tsFiles(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/** The module specifiers a file imports from or re-exports from. */
function specifiers(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string);
}

/** The specifiers a file loads at run time: `import("x")`, `require("x")`. */
function dynamicSpecifiers(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/(?:import|require)\("([^"]+)"\)/g)].map((m) => m[1] as string);
}

describe("ES6a: the kit and the engine stay on their own sides", () => {
  it("the kit's sources reach the engine only through its public entry", () => {
    const files = tsFiles(resolve(kitRoot, "src"));
    assert.ok(files.length >= 11, `expected the kit's sources, found ${files.length}`);
    for (const file of files) {
      for (const spec of specifiers(file)) {
        if (spec.startsWith("node:") || !spec.includes("/") || spec.startsWith("@mmo-engine/")) {
          assert.doesNotMatch(
            spec,
            /^@mmo-engine\/engine-core\//,
            `${file} imports an engine internal (${spec}); a kit outside this repo could not`,
          );
          continue;
        }
        assert.ok(
          spec.startsWith("./") || spec.startsWith("../"),
          `${file} imports ${spec}, which is neither a package nor a path inside the kit`,
        );
        assert.ok(
          !resolve(dirname(file), spec).startsWith(resolve(kitRoot, "..")) ||
            resolve(dirname(file), spec).startsWith(resolve(kitRoot) + "/"),
          `${file} reaches out of the kit with ${spec}`,
        );
      }
    }
  });

  it("the engine never imports this kit", () => {
    // The engine asks for ports and reads a registry; if it ever depends on
    // this package, a game that replaces the kit is back to patching the
    // engine, which is the thing the split was for. Prose about the kit is
    // fine and there is some — what must not exist is a specifier.
    const offenders = tsFiles(engineSrc).filter((f) =>
      [...specifiers(f), ...dynamicSpecifiers(f)].some((spec) => spec.includes("kit-")),
    );
    assert.deepEqual(offenders, [], "engine-core sources importing a kit");
  });

  it("the nine systems are gone from the engine's public surface", () => {
    for (const name of [
      "AbilitySystem",
      "BodySystem",
      "CombatSystem",
      "DeathSystem",
      "DuelSystem",
      "MagicSystem",
      "StaminaSystem",
      "StatusSystem",
      "TelegraphSystem",
    ]) {
      assert.equal(
        (engine as Record<string, unknown>)[name],
        undefined,
        `@mmo-engine/engine-core still exports ${name}`,
      );
    }
  });

  it("what the engine still owns is the vocabulary and the contract", () => {
    // The move was of the systems, not of what they say or what a host asks
    // for: the protocol and persistence speak the vocabulary, and a kit is
    // written against the ports, the services and the rules loader.
    for (const name of ["GATEWAY_PORTS", "SERVICE_TABLE", "loadGameRules", "openEngineServices"]) {
      assert.notEqual(
        (engine as Record<string, unknown>)[name],
        undefined,
        `a kit cannot be written without ${name}`,
      );
    }
  });
});
