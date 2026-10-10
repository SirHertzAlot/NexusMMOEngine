/**
 * EA19: assemble the local package.
 *
 * Usage: node scripts/package.mjs [--out <dir>]
 *
 * Copies the built server and content into the package dir (preserving
 * repo-relative paths) and writes manifest.json. The default profile's
 * "package" stage runs this.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, symlinkSync, rmSync } from "node:fs";
import { assemblePackage } from "../packages/build/dist/src/index.js";
import { collectInputFiles } from "../packages/build/dist/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const outDir = outArg >= 0 ? process.argv[outArg + 1] : join(root, "dist", "package");

// Everything the server needs to boot: its built output, its package.json
// (read at runtime for the version), and content.
// node_modules is symlinked (local target; a staging target would install).
const inputs = ["packages/engine-core/dist", "packages/engine-core/package.json", "content"];
const files = collectInputFiles(root, inputs);

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
const manifest = assemblePackage(root, outDir, "default", files);

const nm = join(outDir, "node_modules");
if (!existsSync(nm)) symlinkSync(join(root, "node_modules"), nm, "dir");

console.log(`package: ${files.length} files -> ${outDir}`);
console.log(`manifest: profile=${manifest.profile} createdAt=${manifest.createdAt}`);
