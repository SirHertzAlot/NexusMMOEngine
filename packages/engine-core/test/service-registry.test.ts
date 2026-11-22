/**
 * The gate for ES4: the table in `src/services.ts` is the only way
 * `server.ts` reads back what the enabled modules built, and every row in it
 * agrees with the `module.json` that promises it.
 *
 * Two kinds of check. The source-text ones (the same way
 * `rules-hook-overrides.test.ts` guards its call sites) fail if a read goes
 * back to `assembled.byName[...]`, where a typo is an `undefined` nothing
 * catches. The manifest ones fail if a module renames or makes optional a
 * system the table promises, which is the drift the casts used to hide.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MissingServicesError } from "@mmo-engine/sdk";
import { SERVICE_TABLE, openEngineServices } from "../src/services.js";
import { mergeModuleConfig } from "../src/modules.js";

/** This test runs from packages/engine-core/dist/test. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const source = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");
const SERVER = source("packages/engine-core/src/server.ts");

interface ModuleManifest {
  name: string;
  server?: { systems?: Array<{ name: string; optional?: boolean }>; extensions?: string[] };
  native?: { systems?: string[] };
}
const manifestOf = (module: string): ModuleManifest =>
  JSON.parse(source(join("modules", module, "module.json"))) as ModuleManifest;

describe("ES4: the service table matches the modules that provide it", () => {
  for (const decl of SERVICE_TABLE) {
    it(`${decl.key} is declared by the ${decl.module} module`, () => {
      const m = manifestOf(decl.module);
      assert.equal(m.name, decl.module, `modules/${decl.module}/module.json names itself ${m.name}`);
      const declared =
        decl.kind === "system"
          ? [...(m.server?.systems ?? []).map((s) => s.name), ...(m.native?.systems ?? [])]
          : (m.server?.extensions ?? []);
      assert.ok(
        declared.includes(decl.key),
        `modules/${decl.module}/module.json does not declare the ${decl.kind} "${decl.key}" (it declares ${declared.join(", ") || "none"})`,
      );
    });
  }

  it("never marks a service required that its own module declares optional", () => {
    for (const decl of SERVICE_TABLE.filter((d) => d.required && d.kind === "system")) {
      const optional = (manifestOf(decl.module).server?.systems ?? []).find((s) => s.name === decl.key)?.optional;
      assert.notEqual(
        optional,
        true,
        `${decl.key} is optional in modules/${decl.module}/module.json, so the table must not require it`,
      );
    }
  });

  it("requires only the engine's own: physics, character and mastery (ES4b)", () => {
    // The measure of the split. Everything else is a game's design, and a
    // game that wants none of it boots without the modules that provide it:
    // `core` alone reports exactly these three, and `core`, `physics`,
    // `character` runs. If this list grows, the engine has re-coupled itself
    // to something a game should be free to drop — which is what ES8's
    // kit-less boot job will fail on.
    assert.deepEqual(
      SERVICE_TABLE.filter((d) => d.required).map((d) => d.key),
      ["physics", "character", "mastery"],
    );
    // And each of those is the engine's own, not a game's design.
    assert.deepEqual(
      [...new Set(SERVICE_TABLE.filter((d) => d.required).map((d) => d.module))].sort(),
      ["character", "physics"],
    );
  });

  it("has a unique key, a module, and a sentence per row", () => {
    const keys = SERVICE_TABLE.map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const d of SERVICE_TABLE) {
      assert.ok(d.what.length > 0, `${d.key} says nothing about what it is for`);
      assert.ok(d.module.length > 0, `${d.key} names no module`);
    }
  });
});

describe("ES4: server.ts reads services only through the registry", () => {
  it("no longer reaches into the assembled bags by string", () => {
    assert.doesNotMatch(
      SERVER,
      /assembled\.(byName|extensions)\s*\[/,
      "server.ts should read services through the registry, where a missing one is a boot error",
    );
  });

  it("asks only for services the table declares", () => {
    const keys = new Set(SERVICE_TABLE.map((d) => d.key));
    const asked = [...SERVER.matchAll(/services\.(?:get|optional)\("([^"]+)"\)/g)].map((m) => m[1] as string);
    assert.ok(asked.length >= 19, `expected the converted call sites, found ${asked.length}`);
    for (const key of new Set(asked)) {
      assert.ok(keys.has(key), `server.ts asks for "${key}", which is not in SERVICE_TABLE`);
    }
  });

  it("uses get() only where the table says the server cannot run without it", () => {
    const required = new Set(SERVICE_TABLE.filter((d) => d.required).map((d) => d.key));
    for (const m of SERVER.matchAll(/services\.get\("([^"]+)"\)/g)) {
      assert.ok(required.has(m[1] as string), `server.ts calls get("${m[1]}"), which the table marks optional`);
    }
    // And every optional read is one: get() on an optional key throws.
    const optional = new Set(SERVICE_TABLE.filter((d) => !d.required).map((d) => d.key));
    const reads = [...SERVER.matchAll(/services\.optional\("([^"]+)"\)/g)].map((m) => m[1] as string);
    for (const key of new Set(reads)) assert.ok(optional.has(key), `server.ts calls optional("${key}"), which the table requires`);
  });

  it("covers every service: the table's required keys are all read", () => {
    for (const decl of SERVICE_TABLE) {
      assert.match(
        SERVER,
        new RegExp(`services\\.(get|optional)\\("${decl.key}"\\)`),
        `${decl.key} is in the table but server.ts never reads it`,
      );
    }
  });
});

describe("ES4: a missing service stops the boot", () => {
  const everything = (): { byName: Record<string, unknown>; extensions: Record<string, unknown>; modules: string[] } => ({
    byName: Object.fromEntries(SERVICE_TABLE.filter((d) => d.kind === "system").map((d) => [d.key, { name: d.key }])),
    extensions: Object.fromEntries(SERVICE_TABLE.filter((d) => d.kind === "extension").map((d) => [d.key, { name: d.key }])),
    modules: [...new Set(SERVICE_TABLE.map((d) => d.module))],
  });

  it("reads every row when every module is there", () => {
    const r = openEngineServices(everything());
    assert.deepEqual(r.absent, []);
    assert.equal(r.get("physics").constructor, Object);
    assert.equal(r.optional("items")?.constructor, Object);
    assert.match(r.summary, /^services: \d+\/\d+$/);
  });

  it("runs without the modules the table marks optional", () => {
    const all = everything();
    const optional = SERVICE_TABLE.filter((d) => !d.required);
    for (const d of optional) delete (d.kind === "system" ? all.byName : all.extensions)[d.key];
    const r = openEngineServices(all);
    assert.deepEqual([...r.absent].sort(), optional.map((d) => d.key).sort());
    for (const d of optional) assert.equal(r.optional(d.key as "civic"), undefined);
  });

  it("names the module and what it is for when a required one is missing", () => {
    const all = everything();
    delete all.byName["physics"];
    delete all.byName["mastery"];
    all.modules = all.modules.filter((m) => m !== "physics");
    let err: MissingServicesError | undefined;
    try {
      openEngineServices(all);
    } catch (caught) {
      assert.ok(caught instanceof MissingServicesError, String(caught));
      err = caught;
    }
    assert.ok(err, "a missing required service should stop the boot");
    assert.deepEqual(err.missing.map((m) => m.key), ["physics", "mastery"]);
    // The physics module is off; the character module ran without mastery.
    assert.match(err.message, /enable physics in the module set/);
    assert.match(
      err.message,
      /mastery \(what a character has got better at\), provided by the character module — that module is enabled but did not provide it/,
    );
  });

  it("boots with none of the game's modules, which is the point of the split", () => {
    // Everything optional removed: what is left is the three the engine
    // itself needs, and the registry hands them over without complaint.
    const all = everything();
    for (const d of SERVICE_TABLE.filter((x) => !x.required)) {
      delete (d.kind === "system" ? all.byName : all.extensions)[d.key];
    }
    all.modules = ["core", "physics", "character"];
    const r = openEngineServices(all);
    assert.equal(r.absent.length, SERVICE_TABLE.length - 3);
    assert.ok(r.get("physics"));
    assert.equal(r.optional("combat"), undefined);
  });
});

describe("ES4: game.json's modules block layers under the host's wiring", () => {
  it("fills a key the host leaves unset and keeps the one it sets", () => {
    const merged = mergeModuleConfig(
      { residents: { maxEntities: 1200, maxFull: undefined, store: { kind: "places" } } },
      { residents: { maxEntities: 50, maxFull: 99, fullM: 60 } },
    );
    // The host set maxEntities (from MMO_RESIDENTS_MAX), so the manifest loses.
    assert.equal(merged.residents?.maxEntities, 1200);
    // It left maxFull undefined, so the manifest wins; fullM only the manifest has.
    assert.equal(merged.residents?.maxFull, 99);
    assert.equal(merged.residents?.fullM, 60);
    assert.deepEqual(merged.residents?.store, { kind: "places" });
  });

  it("gives a module the host wires nothing for its settings anyway", () => {
    const merged = mergeModuleConfig({ items: { defs: 1 } }, { "a-game-module": { anything: true } });
    assert.deepEqual(merged["a-game-module"], { anything: true });
    assert.deepEqual(merged.items, { defs: 1 });
  });

  it("changes nothing when there is no manifest", () => {
    const host = { items: { defs: 1 }, residents: { maxEntities: 7 } };
    assert.deepEqual(mergeModuleConfig(host, {}), host);
  });

  it("is what server.ts passes the assembler", () => {
    assert.match(SERVER, /config: mergeModuleConfig\(/);
    assert.match(SERVER, /GAME\.moduleConfig,/);
    // The residents caps no longer carry a second copy of the system's defaults.
    assert.doesNotMatch(SERVER, /MMO_RESIDENTS_MAX \?\? 800/);
    assert.match(SERVER, /maxEntities: envNumber\("MMO_RESIDENTS_MAX"\)/);
  });
});
