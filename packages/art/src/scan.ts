/**
 * Asset pack directory scanner.
 *
 * Derives an AssetManifest from a pack folder on disk so Joey (or build
 * tooling) doesn't have to hand-write `manifest.json` for every pack:
 *
 *   <root>/models/**    (*.glb, *.gltf — recursive)
 *   <root>/textures/**  (*.png, *.jpg, *.jpeg, *.webp — recursive)
 *
 * Entry ids come from file basenames without extension
 * (`models/props/crate.glb` -> id `"crate"`, file `"models/props/crate.glb"`),
 * and entries are sorted by id so output is deterministic across runs and
 * machines (DOD: same input bytes -> same manifest bytes).
 *
 * The scanner is total: it never throws for missing or unreadable
 * directories — it emits a diagnostic per problem and returns whatever it
 * could collect. A half-present pack is a reportable condition, not a crash.
 * The returned manifest is informational (`version: "0.0.0-scan"`); promote
 * it to a real version when the pack is published.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { checkManifestFiles, parseManifestJSON, type AssetManifest } from "./manifest.js";
import { errMessage } from "./util.js";

const MODEL_EXTS: ReadonlySet<string> = new Set([".glb", ".gltf"]);
const TEXTURE_EXTS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface ScanResult {
  manifest: AssetManifest;
  diagnostics: string[];
}

interface RawEntry {
  id: string;
  /** Path relative to the pack root, POSIX separators (matches manifest `file`). */
  file: string;
}

/** Recursively collect files with wanted extensions under `dir`. */
function collectFiles(
  dir: string,
  root: string,
  exts: ReadonlySet<string>,
  kind: "models" | "textures",
  diagnostics: string[],
): RawEntry[] {
  const out: RawEntry[] = [];
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    diagnostics.push(
      code === "ENOENT"
        ? `${kind} directory not found: "${dir}" (no ${kind} scanned)`
        : `could not read ${kind} directory "${dir}": ${errMessage(err)}`,
    );
    return out;
  }
  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...collectFiles(full, root, exts, kind, diagnostics));
    } else if (dirent.isFile() && exts.has(extname(dirent.name).toLowerCase())) {
      const id = basename(dirent.name, extname(dirent.name));
      if (id.length === 0) {
        diagnostics.push(`skipping ${kind} file with empty id: "${full}"`);
        continue;
      }
      out.push({ id, file: relative(root, full).split(sep).join("/") });
    }
  }
  return out;
}

/** Report ids claimed by more than one file — the manifest keeps both. */
function duplicateIdDiagnostics(
  entries: ReadonlyArray<RawEntry>,
  kind: "model" | "texture",
  diagnostics: string[],
): void {
  const byId = new Map<string, string[]>();
  for (const entry of entries) {
    const files = byId.get(entry.id) ?? [];
    files.push(entry.file);
    byId.set(entry.id, files);
  }
  for (const [id, files] of byId) {
    if (files.length > 1) {
      diagnostics.push(
        `duplicate ${kind} id "${id}" from ${files.map((f) => `"${f}"`).join(" and ")} ` +
          `(shape/texture lookup uses the first)`,
      );
    }
  }
}

/**
 * The pack's asset list. A `<root>/manifest.json` (e.g. written by the
 * pack converter, with pack-qualified ids) wins: it is validated and every
 * file it references is checked to exist. Without one — or when it is
 * invalid — `<root>/models/` and `<root>/textures/` are scanned instead.
 * Never throws: problems land in `diagnostics`.
 */
export function scanAssetDir(root: string): ScanResult {
  const manifestPath = join(root, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = parseManifestJSON(JSON.parse(readFileSync(manifestPath, "utf8")));
      const present = new Set(
        [...manifest.models, ...manifest.textures]
          .map((e) => e.file)
          .filter((f) => existsSync(join(root, f))),
      );
      return { manifest, diagnostics: checkManifestFiles(manifest, present) };
    } catch (err) {
      const fallback = scanDirs(root);
      fallback.diagnostics.unshift(`manifest.json is invalid, scanned folders instead: ${errMessage(err)}`);
      return fallback;
    }
  }
  return scanDirs(root);
}

/** Scan `<root>/models/` and `<root>/textures/` into a manifest. */
function scanDirs(root: string): ScanResult {
  const diagnostics: string[] = [];
  const rawModels = collectFiles(join(root, "models"), root, MODEL_EXTS, "models", diagnostics);
  const rawTextures = collectFiles(join(root, "textures"), root, TEXTURE_EXTS, "textures", diagnostics);

  duplicateIdDiagnostics(rawModels, "model", diagnostics);
  duplicateIdDiagnostics(rawTextures, "texture", diagnostics);

  const byIdThenFile = (a: RawEntry, b: RawEntry): number =>
    a.id.localeCompare(b.id) || a.file.localeCompare(b.file);
  const models = rawModels
    .sort(byIdThenFile)
    .map((e) => ({ id: e.id, file: e.file }));
  const textures = rawTextures
    .sort(byIdThenFile)
    .map((e) => ({ id: e.id, file: e.file }));

  return {
    manifest: {
      name: basename(root),
      version: "0.0.0-scan",
      models,
      textures,
    },
    diagnostics,
  };
}
