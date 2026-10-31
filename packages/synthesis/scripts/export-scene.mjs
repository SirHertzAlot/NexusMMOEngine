#!/usr/bin/env node
/**
 * Synthesize a room and write it as a scene the server can spawn:
 *   node packages/synthesis/scripts/export-scene.mjs [name]   -> content/scenes/<name>.scene.json
 * Then run the server with MMO_SCENE=<name> to spawn it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synthesizeAssembly, synthesisToScene } from "../dist/src/index.js";
import { validateScene } from "@mmo-engine/scene";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const name = process.argv[2] ?? "synth-multi-level-descent";
const ruleSet = JSON.parse(fs.readFileSync(path.join(root, "content", "synthesis", "dungeon-rules.json"), "utf-8"));

const out = synthesizeAssembly({
  ruleSet,
  seed: 9913,
  site: { bounds: { min: [-22, 0, -22], max: [22, 14, 22] } },
  blueprint: { archetype: "multi-level-descent" },
  budget: { maxParts: 85, maxGrowthAttempts: 1200 },
});
const doc = synthesisToScene(out, { name, kind: "arena" });
const issues = validateScene(doc);
if (issues.length > 0) {
  console.error(issues);
  process.exitCode = 1;
} else {
  const file = path.join(root, "content", "scenes", `${name}.scene.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`[export-scene] ${doc.nodes.length} nodes -> ${path.relative(root, file)}`);
}
