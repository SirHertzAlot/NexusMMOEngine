#!/usr/bin/env node
/**
 * import-art-pack.mjs — copy an MMO engine art pack into a Rogue Engine
 * project's documented asset folders.
 *
 * Reads the pack's manifest.json (see @mmo-engine/art) and copies each
 * model into <project>/Assets/Models/mmo/<id>.<ext> and each texture
 * into <project>/Assets/Textures/mmo/<id>.<ext>, then writes a
 * <project>/Assets/Models/mmo/manifest.json mapping model ids to their
 * Rogue-relative paths for RE.Model.fetch().
 *
 * Only manifest-listed files are copied (never ".." — entries are
 * validated as pack-relative paths), so a malicious or sloppy manifest
 * cannot write outside the destination folders.
 *
 * Usage:
 *   node import-art-pack.mjs --project /path/to/rogue-project \
 *       --pack /path/to/mmo-engine/assets [--force]
 *
 * Requires node >= 18. No dependencies.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

function usage() {
  console.error(
    "usage: node import-art-pack.mjs --project <rogue-project-dir> --pack <assets-dir> [--force]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const projectIdx = args.indexOf("--project");
const packIdx = args.indexOf("--pack");
if (projectIdx < 0 || packIdx < 0 || !args[projectIdx + 1] || !args[packIdx + 1]) usage();
const projectDir = resolve(args[projectIdx + 1]);
const packDir = resolve(args[packIdx + 1]);
const force = args.includes("--force");

const manifestPath = join(packDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`no manifest.json in pack dir: ${packDir}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const section of ["models", "textures"]) {
  if (!Array.isArray(manifest[section])) {
    console.error(`manifest.json: "${section}" must be an array`);
    process.exit(1);
  }
}

/** Resolve a manifest file entry strictly inside the pack dir. */
function packFile(entry) {
  if (typeof entry !== "string" || entry.length === 0) throw new Error(`bad entry: ${JSON.stringify(entry)}`);
  const p = normalize(join(packDir, entry));
  if (p !== packDir && !p.startsWith(packDir + sep)) {
    throw new Error(`entry escapes pack dir: ${entry}`);
  }
  return p;
}

const modelsDest = join(projectDir, "Assets", "Models", "mmo");
const texturesDest = join(projectDir, "Assets", "Textures", "mmo");
if (!force && existsSync(modelsDest)) {
  console.error(`destination exists: ${modelsDest} (pass --force to overwrite)`);
  process.exit(1);
}
mkdirSync(modelsDest, { recursive: true });
mkdirSync(texturesDest, { recursive: true });

const index = { pack: manifest.name ?? "unnamed", version: manifest.version ?? "0", models: {} };
let copied = 0;

for (const m of manifest.models) {
  const src = packFile(m.file);
  if (!existsSync(src)) {
    console.error(`warning: missing model file, skipping: ${m.file}`);
    continue;
  }
  const ext = src.includes(".") ? src.slice(src.lastIndexOf(".")) : "";
  const destName = `${m.id}${ext}`;
  cpSync(src, join(modelsDest, destName));
  // Rogue-relative path (forward slashes) for RE.Model.fetch().
  index.models[m.id] = `Assets/Models/mmo/${destName}`;
  copied++;
}
for (const t of manifest.textures) {
  const src = packFile(t.file);
  if (!existsSync(src)) {
    console.error(`warning: missing texture file, skipping: ${t.file}`);
    continue;
  }
  const ext = src.includes(".") ? src.slice(src.lastIndexOf(".")) : "";
  cpSync(src, join(texturesDest, `${t.id}${ext}`));
  copied++;
}

writeFileSync(join(modelsDest, "manifest.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`imported ${copied} files from ${manifestPath}`);
console.log(`models -> ${modelsDest}`);
console.log(`index  -> ${join(modelsDest, "manifest.json")}`);
