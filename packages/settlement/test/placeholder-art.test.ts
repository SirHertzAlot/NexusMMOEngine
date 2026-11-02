/**
 * The placeholder art (SG4a): every structure kind has a stand-in whose name its art pattern matches, so
 * `buildArtMap` maps the kind to it exactly as it maps a licensed preset. The committed catalog the client
 * serves is the one the table produces (regenerate with scripts/gen-placeholder-art.mjs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogModel } from "../src/art.js";
import { buildArtMap, DEFAULT_ART_PATTERNS, FORTIFICATION_KINDS, FORTIFICATION_NAME } from "../src/art.js";
import { PLACEHOLDER_ART, placeholderCatalog } from "../src/placeholder-art.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("placeholder art", () => {
  it("covers every structure kind with a model its own pattern matches", () => {
    const kinds = Object.keys(DEFAULT_ART_PATTERNS);
    const byKind = new Map(PLACEHOLDER_ART.map((p) => [p.kind, p]));
    for (const kind of kinds) assert.ok(byKind.has(kind), `no placeholder for ${kind}`);
    const map = buildArtMap(placeholderCatalog().models, DEFAULT_ART_PATTERNS);
    for (const kind of kinds) {
      assert.ok(map[kind]?.includes(byKind.get(kind)!.name), `${kind} does not map to its placeholder ${byKind.get(kind)!.name}`);
    }
  });

  it("keeps the fortification rule: only wall, tower and gate kinds take a wall or gate name", () => {
    for (const p of PLACEHOLDER_ART) {
      const fort = FORTIFICATION_NAME.test(p.name);
      const wallKind = (FORTIFICATION_KINDS as readonly string[]).includes(p.kind);
      if (fort) assert.ok(wallKind, `${p.name} is a fortification name on the non-wall kind ${p.kind}`);
    }
  });

  it("the committed client catalog is the table's catalog", () => {
    const served = JSON.parse(readFileSync(resolve(REPO, "apps/client/public/placeholder-art/catalog.json"), "utf8")) as { models: (CatalogModel & { file: string })[] };
    assert.deepEqual(served.models.map(({ file: _file, ...m }) => m), placeholderCatalog().models);
  });
});
