#!/usr/bin/env node
/**
 * npm run settlement:scale-fit -- [--catalog assets/catalog.json] [--scale content/scale.json] [--out content/scale.local.json]
 * Fits every mapped model to its archetype's architectural height (within its parcel) and
 * writes the scale doc. The output names licensed models: keep it at a gitignored path and
 * run the server with MMO_SCALE=content/scale.local.json.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fromUser, settlementPaths } from "./paths.js";
import { parseArgs } from "node:util";
import { validateScale, type ScaleDoc } from "@mmo-engine/scene";
import { DEFAULT_ART_PATTERNS, DEFAULT_PROP_PATTERNS, END_TO_END_KINDS, type CatalogModel } from "./art.js";
import { fitScale } from "./fit.js";
import { formatScaleReport, scaleReport } from "./report.js";
import { defaultRules } from "./rules.js";

const paths = settlementPaths();
const { values: o } = parseArgs({ options: { catalog: { type: "string" }, scale: { type: "string" }, out: { type: "string" } } });
const base = JSON.parse(readFileSync(fromUser(o.scale ?? paths.scaleBase), "utf8")) as unknown;
const issues = validateScale(base);
if (issues.length) {
  console.error(`[scale-fit] invalid scale doc: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  process.exit(1);
}
const models = (JSON.parse(readFileSync(fromUser(o.catalog ?? paths.catalog), "utf8")) as { models: CatalogModel[] }).models;
const rules = defaultRules(paths.rules);
// Street furniture is not fitted, but the pieces that must meet end to end (a property fence) are, like the wall.
const patterns = { ...DEFAULT_ART_PATTERNS, ...Object.fromEntries(END_TO_END_KINDS.filter((k) => k in DEFAULT_PROP_PATTERNS).map((k) => [k, DEFAULT_PROP_PATTERNS[k]!])) };
const doc = fitScale(models, patterns, rules, base as ScaleDoc);
const out = fromUser(o.out ?? paths.scaleOut);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
const rows = scaleReport(models, patterns, doc, rules);
console.log(formatScaleReport(rows));
console.log(`[scale-fit] ${Object.keys(doc.assets).length} models fitted, ${rows.filter((r) => r.overflow).length} overflow; wrote ${out} (gitignored; MMO_SCALE=content/scale.local.json)`);
