import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { fnv1a32, variantSeed } from "@mmo-engine/picg";
import { formatValue, selectionCard } from "../src/inspectors/selection.js";
import { readPcgLibrary, resolvePcgPath } from "../src/pcg-host.js";

// dist/test → repo root
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

test("the library lists every asset with its AssetRef hash and graph parameters", () => {
  const lib = readPcgLibrary(repoRoot);
  const oak = lib.assets.find((a) => a.id === "oak");
  assert.ok(oak, "oak in content/pcg/index.json");
  assert.equal(oak.assetHash, fnv1a32("oak"));
  assert.equal(oak.variants, 4);
  assert.equal(oak.error, undefined);
  const thickness = oak.parameters.find((p) => p.id === "trunk_thickness");
  assert.ok(thickness);
  assert.equal(thickness.default, 0.26);
  assert.equal(thickness.value, 0.26);
  assert.equal(thickness.overridden, false);
  assert.equal(thickness.min, 0.1);
  assert.equal(thickness.max, 0.6);
  assert.ok(lib.subgraphs.length >= 3);
});

test("library paths can't leave content/pcg", () => {
  assert.throws(() => resolvePcgPath(repoRoot, "../rules/loot.json"), /escapes/);
  assert.throws(() => resolvePcgPath(repoRoot, "/etc/passwd"), /escapes/);
  assert.match(resolvePcgPath(repoRoot, "trees/oak.pcg"), /content[\\/]pcg[\\/]trees[\\/]oak\.pcg$/);
});

test("a picked tree's card names its asset, shape, seed and parameters", () => {
  const { assets } = readPcgLibrary(repoRoot);
  const entity = {
    wireId: 42n,
    transform: { wireId: 42n, px: 1.23456, py: 2, pz: -3.5, qx: 0, qy: 0, qz: 0, qw: 1 },
    asset: { wireId: 42n, assetHash: fnv1a32("oak"), variant: 6 },
    health: { wireId: 42n, current: 100, max: 100 },
  };
  const card = selectionCard(entity, null, assets);
  assert.equal(card.wireId, "42");
  assert.equal(card.kind, "Oak");
  assert.ok(card.asset);
  assert.equal(card.asset.variant, 6);
  assert.equal(card.asset.shape, 2); // 6 % 4 variants
  assert.equal(card.asset.seed, variantSeed({ id: "oak", graph: "trees/oak.pcg", variants: 4 }, 2));
  assert.ok(card.asset.parameters.some((p) => p.name === "TrunkThickness" && p.range === "0.100 – 0.600"));
  assert.deepEqual(card.components.map((c) => c.name), ["Transform", "AssetRef", "Health"]);
  const px = card.components[0].fields.find((f) => f.key === "px");
  assert.equal(px?.value, "1.235");
  assert.ok(!card.components[0].fields.some((f) => f.key === "wireId"));
  assert.equal(card.unknownAsset, null);
});

test("a character's card shows its name; an unknown AssetRef is flagged", () => {
  const card = selectionCard(
    { wireId: 7n, characterRef: { wireId: 7n, characterId: 3 }, asset: { wireId: 7n, assetHash: 123, variant: 1 } },
    "Aria",
    [],
  );
  assert.equal(card.name, "Aria");
  assert.equal(card.kind, "character");
  assert.equal(card.asset, null);
  assert.deepEqual(card.unknownAsset, { assetHash: 123, variant: 1 });
  // Components the card has no name for still show, by key.
  assert.equal(selectionCard({ wireId: 1n, futureThing: { a: 1 } }, null, []).components[0].name, "futureThing");
});

test("values format compactly", () => {
  assert.equal(formatValue(5n), "5");
  assert.equal(formatValue(0.5), "0.500");
  assert.equal(formatValue(3), "3");
  assert.equal(formatValue([1, 2.5]), "[1, 2.500]");
  assert.equal(formatValue({ a: true }), "{ a: true }");
  assert.equal(formatValue(undefined), "—");
  assert.match(formatValue(Array.from({ length: 10 }, (_, i) => i)), /… 10\]$/);
});
