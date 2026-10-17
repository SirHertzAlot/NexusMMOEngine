#!/usr/bin/env node
/**
 * npm run settlement:scale-report -- [--catalog assets/catalog.json] [--scale content/scale.json]
 * Prints, per structure kind, each mapped model's size before and after the building
 * factor and the parcel it must fit; exits 1 if any overflows. Reads the (ignored,
 * licensed) catalog locally; nothing is written.
 */

import { readFileSync } from "node:fs";
import { fromUser, settlementPaths } from "./paths.js";
import { parseArgs } from "node:util";
import { validateScale, type ScaleDoc } from "@mmo-engine/scene";
import { DEFAULT_ART_PATTERNS, type CatalogModel } from "./art.js";
import { formatScaleReport, scaleReport } from "./report.js";
import { defaultRules } from "./rules.js";

const paths = settlementPaths();
const { values: o } = parseArgs({ options: { catalog: { type: "string" }, scale: { type: "string" } } });
const doc = JSON.parse(readFileSync(fromUser(o.scale ?? paths.scaleBase), "utf8")) as unknown;
const issues = validateScale(doc);
if (issues.length) {
  console.error(`[scale-report] invalid scale doc: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  process.exit(1);
}
const models = (JSON.parse(readFileSync(fromUser(o.catalog ?? paths.catalog), "utf8")) as { models: CatalogModel[] }).models;
const rows = scaleReport(models, DEFAULT_ART_PATTERNS, doc as ScaleDoc, defaultRules(paths.rules));
console.log(formatScaleReport(rows));
const bad = rows.filter((r) => r.overflow).length;
console.log(`[scale-report] ${rows.length} models, ${bad} overflow their room`);
process.exit(bad ? 1 : 0);
