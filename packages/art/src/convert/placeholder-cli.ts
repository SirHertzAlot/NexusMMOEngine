/**
 * WL1: write a generated placeholder pack from a titles file (`[{title, publicID}]`, e.g. from
 * `wildlife-table.js --placeholder-titles`). The pack folder is yours to choose, not assets/.
 *   node dist/src/convert/placeholder-cli.js --titles <json> --out <folder>
 */

import * as fs from "node:fs";
import { makePlaceholderPack } from "./placeholder-pack.js";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const titlesFile = flag("--titles");
const out = flag("--out");
if (!titlesFile || !out) throw new Error("usage: placeholder-cli --titles <json> --out <folder>");
const titles = JSON.parse(fs.readFileSync(titlesFile, "utf8")) as Array<{ title: string; publicID: string }>;
makePlaceholderPack(out, titles).then((entries) => console.log(`[placeholder] ${entries.length} stand-in models -> ${out}`));
