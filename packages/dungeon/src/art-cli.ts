#!/usr/bin/env node
/**
 * npm run dungeon:art -- [--catalog assets/catalog.json] [--props content/dungeons/props.json] [--out content/dungeons/props.local.json]
 *
 * Writes the local art overlay: which catalog model stands in for each dungeon prop kind it can match by name (art.ts).
 * Prints what it picked, how many models matched each kind (a kind with many may deserve a look by eye), and the kinds that
 * stay procedural. The overlay is git-ignored: it names licensed art, which is never committed. The run's server reads it over
 * props.json; the client draws the models when the art is served (the dev server serves `assets/`), else the prop is a
 * stand-in box, so generate it only where the art is.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "node:util";
import { writeArtOverlay, type CatalogModel } from "./art.js";

const { values: o } = parseArgs({ options: { catalog: { type: "string" }, props: { type: "string" }, out: { type: "string" } } });
let repoRoot = process.cwd();
for (let d = dirname(fileURLToPath(import.meta.url)); d && d !== dirname(d); d = dirname(d)) {
  if (existsSync(join(d, "assets", "catalog.json")) || (existsSync(join(d, "content")) && existsSync(join(d, "packages")))) {
    repoRoot = d;
    break;
  }
}

const findPath = (rel: string): string => {
  if (existsSync(resolve(rel))) return resolve(rel);
  if (existsSync(join(repoRoot, rel))) return join(repoRoot, rel);
  return resolve(rel);
};

const catalog = findPath(o.catalog ?? "assets/catalog.json");
const propsFile = findPath(o.props ?? "content/dungeons/props.json");
const out = o.out ? resolve(o.out) : join(repoRoot, "content/dungeons/props.local.json");

const models = (JSON.parse(readFileSync(catalog, "utf8")) as { models: CatalogModel[] }).models;
const kinds = Object.keys((JSON.parse(readFileSync(propsFile, "utf8")) as { archetypes: Record<string, unknown> }).archetypes).map((k) => k.replace(/^dungeon:/, ""));
const match = writeArtOverlay(models, kinds, out);

console.log(`[dungeon:art] ${Object.keys(match.assets).length} of ${kinds.length} kinds matched, from ${models.length} models -> ${out}`);
for (const c of match.contact) console.log(`  ${c.kind.padEnd(13)} ${c.name}  (${c.candidates} match${c.candidates === 1 ? "" : "es"}${match.scales[c.kind] ? `, scaled x${match.scales[c.kind]}` : ""}${c.triangles !== undefined ? `, ${c.triangles} tris` : ""}${c.size ? `, ${c.size.map((n) => n.toFixed(2)).join(" x ")} m` : ""})`);
console.log(`  procedural: ${match.unmatched.join(", ")}`);
console.log("  The overlay names licensed art: it is git-ignored, keep it that way. It needs the art served (the dev server serves assets/).");
