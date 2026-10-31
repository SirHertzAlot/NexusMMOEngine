#!/usr/bin/env node
/**
 * Place an interior from the catalog and write it as a scene the server can spawn:
 *   node packages/synthesis/scripts/export-interior.mjs [id]  -> content/scenes/interior-<id>.scene.json
 * The catalog (content/synthesis/interiors.json) names each interior's grammar, style and seed.
 * Then run the server with MMO_SCENE=interior-<id> to spawn it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InteriorCatalogSchema, InteriorGrammarSchema, InteriorStyleSchema, placeInterior, synthesisToScene } from "../dist/src/index.js";
import { validateScene } from "@mmo-engine/scene";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const synthesis = path.join(root, "content", "synthesis");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf-8"));

const id = process.argv[2] ?? "crypt-hall";
const catalog = InteriorCatalogSchema.parse(read(path.join(synthesis, "interiors.json")));
const entry = catalog.interiors[id];
if (!entry) {
  console.error(`[export-interior] no interior "${id}" in content/synthesis/interiors.json`);
  process.exitCode = 1;
} else {
  const grammar = InteriorGrammarSchema.parse(read(path.join(synthesis, "grammars", `${entry.grammar}.json`)));
  const style = InteriorStyleSchema.parse(read(path.join(synthesis, "styles", `${entry.style}.json`)));
  const ruleSet = read(path.join(synthesis, "dungeon-rules.json"));
  const placements = placeInterior(grammar, style, ruleSet, entry.seed);
  const doc = synthesisToScene({ placements }, { name: `interior-${id}`, kind: "arena" });
  const issues = validateScene(doc);
  if (issues.length > 0) {
    console.error(issues);
    process.exitCode = 1;
  } else {
    const file = path.join(root, "content", "scenes", `${doc.name}.scene.json`);
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    console.log(`[export-interior] ${doc.nodes.length} nodes -> ${path.relative(root, file)}`);
  }
}
