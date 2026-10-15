#!/usr/bin/env node
/**
 * npm run settlement:scale-fit -- [--catalog assets/catalog.json] [--scale content/scale.json] [--out content/scale.local.json]
 * Fits every mapped model to its archetype's architectural height (within its parcel) and
 * writes the scale doc. The output names licensed models: keep it at a gitignored path and
 * run the server with MMO_SCALE=content/scale.local.json.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validateScale, type ScaleDoc } from "@mmo-engine/scene";
import { DEFAULT_ART_PATTERNS, type CatalogModel } from "./art.js";
import { fitScale } from "./fit.js";
import { formatScaleReport, scaleReport } from "./report.js";
import { BUILTIN_RULES } from "./rules.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { values: o } = parseArgs({ options: { catalog: { type: "string" }, scale: { type: "string" }, out: { type: "string" } } });
const base = JSON.parse(readFileSync(resolve(o.scale ?? `${root}/content/scale.json`), "utf8")) as unknown;
const issues = validateScale(base);
if (issues.length) {
  console.error(`[scale-fit] invalid scale doc: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  process.exit(1);
}
const models = (JSON.parse(readFileSync(resolve(o.catalog ?? `${root}/assets/catalog.json`), "utf8")) as { models: CatalogModel[] }).models;
const doc = fitScale(models, DEFAULT_ART_PATTERNS, BUILTIN_RULES, base as ScaleDoc);
const out = resolve(o.out ?? `${root}/content/scale.local.json`);
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
const rows = scaleReport(models, DEFAULT_ART_PATTERNS, doc, BUILTIN_RULES);
console.log(formatScaleReport(rows));
console.log(`[scale-fit] ${Object.keys(doc.assets).length} models fitted, ${rows.filter((r) => r.overflow).length} overflow; wrote ${out} (gitignored; MMO_SCALE=content/scale.local.json)`);
