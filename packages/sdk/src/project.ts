/**
 * The resolver every entry point reads a game through.
 *
 * `openGameProject()` answers one question for each seam in
 * {@link SEAMS}: which absolute path do we read it from? The order is
 *
 *   1. an `MMO_*` variable, so one run can point anywhere;
 *   2. `game.json`'s `paths` entry for that seam;
 *   3. `game.json`'s `content` root plus the seam's own default;
 *   4. the engine's default, which is what the engine used before any of
 *      this existed.
 *
 * With no manifest and no variables set, every path equals the constant
 * the engine already had — that is what `test/defaults.test.ts` asserts,
 * seam by seam, by importing those constants.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GAME_MANIFEST_ENV,
  GAME_MANIFEST_FILE,
  loadManifest,
  type GameManifest,
} from "./manifest.js";
import { SEAMS, type Seam, type SeamKey } from "./seams.js";

/** The checkout this engine runs from (this file lives in dist/src). */
export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** Where each resolved path came from. */
export type PathSource = "default" | "manifest" | `env:${string}`;

export type GamePaths = Readonly<Record<SeamKey, string>>;

export interface GameProject {
  /** The folder the manifest sits in, or the checkout when there is none. */
  readonly root: string;
  /** The manifest actually read, absent when the engine's defaults are in use. */
  readonly manifestFile?: string;
  readonly manifest?: GameManifest;
  /** The game's name: the manifest's, or `engine defaults` with no manifest. */
  readonly name: string;
  readonly contentDir: string;
  readonly assetsDir: string;
  /** The engine's own bundled content (biome registry, ecology, wildlife). */
  readonly engineContentDir: string;
  readonly paths: GamePaths;
  /** The rule hooks module the manifest names (ES3), if any. */
  readonly hooksFile?: string;
  readonly sources: Readonly<Record<SeamKey | "contentDir" | "assetsDir", PathSource>>;
  /**
   * A hash of the layout, not of the content: the name plus every path that
   * differs from the engine's default, each relative to the root. Two
   * regions pointed at the same game agree on it however they were started,
   * so a fleet can register it at boot and see a mismatched region at once.
   */
  readonly layoutHash: string;
  /** One line for the boot log. */
  readonly summary: string;
}

export interface OpenGameProjectOptions {
  /** Where to look for `game.json`. Default: the checkout root. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** What a relative value in a variable is relative to. Default: `INIT_CWD`, else the process's cwd. */
  cwd?: string;
  /** For tests. */
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
}

const isFlagValue = (v: string): boolean => v === "0" || v === "1";

/** `true` when `child` is inside `parent` (or is it). */
export const isInside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r));
};

/** Find the manifest to use, or `undefined` for the engine's defaults. */
export function findManifest(
  env: NodeJS.ProcessEnv = process.env,
  dir: string = ENGINE_ROOT,
  cwd: string = env.INIT_CWD ?? process.cwd(),
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const named = env[GAME_MANIFEST_ENV];
  if (named !== undefined && named !== "") {
    if (named === "0") return undefined; // explicitly: no manifest
    const file = resolve(cwd, named);
    if (!exists(file)) {
      throw new Error(`${GAME_MANIFEST_ENV}=${named}: no manifest at ${file}`);
    }
    return file;
  }
  const beside = join(dir, GAME_MANIFEST_FILE);
  return exists(beside) ? beside : undefined;
}

export function openGameProject(opts: OpenGameProjectOptions = {}): GameProject {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const cwd = opts.cwd ?? env.INIT_CWD ?? process.cwd();
  const checkout = env.MMO_REPO !== undefined && env.MMO_REPO !== "" ? resolve(cwd, env.MMO_REPO) : ENGINE_ROOT;
  const dir = opts.dir !== undefined ? resolve(cwd, opts.dir) : checkout;

  const manifestFile = findManifest(env, dir, cwd, exists);
  const manifest = manifestFile === undefined ? undefined : loadManifest(manifestFile, opts.read);
  const root = manifestFile === undefined ? checkout : dirname(manifestFile);

  const sources: Record<string, PathSource> = {};
  /** A value from the environment, if one of `names` is set to something that is a path. */
  const fromEnv = (names: readonly string[], flagLike = false): { value: string; name: string } | undefined => {
    for (const name of names) {
      const raw = env[name];
      if (raw === undefined || raw === "") continue;
      if (flagLike && isFlagValue(raw)) continue;
      if (raw.includes("\0")) throw new Error(`${name}: not a path`);
      return { value: resolve(cwd, raw), name };
    }
    return undefined;
  };

  const contentEnv = fromEnv(["MMO_CONTENT_DIR"]);
  const contentDir = contentEnv
    ? contentEnv.value
    : manifest?.content !== undefined
      ? resolve(root, manifest.content)
      : resolve(root, "content");
  sources.contentDir = contentEnv ? `env:${contentEnv.name}` : manifest?.content !== undefined ? "manifest" : "default";

  const assetsEnv = fromEnv(["MMO_ASSETS_DIR"]);
  const assetsDir = assetsEnv
    ? assetsEnv.value
    : manifest?.assets !== undefined
      ? resolve(root, manifest.assets)
      : resolve(root, "assets");
  sources.assetsDir = assetsEnv ? `env:${assetsEnv.name}` : manifest?.assets !== undefined ? "manifest" : "default";

  const engineContentDir = join(checkout, "packages", "engine-core", "content");

  const baseOf = (seam: Seam): string => {
    switch (seam.base) {
      case "content":
        return contentDir;
      case "engine":
        return engineContentDir;
      case "assets":
        return assetsDir;
      case "root":
        return checkout;
      case "cwd":
        return cwd;
    }
  };

  const paths: Record<string, string> = {};
  for (const seam of SEAMS) {
    const hit = fromEnv(seam.env, seam.flagLike);
    if (hit) {
      paths[seam.key] = hit.value;
      sources[seam.key] = `env:${hit.name}`;
      continue;
    }
    const named = manifest?.paths?.[seam.key as SeamKey];
    if (named !== undefined) {
      paths[seam.key] = isAbsolute(named) ? resolve(named) : resolve(seam.base === "content" ? contentDir : baseOf(seam), named);
      sources[seam.key] = "manifest";
      continue;
    }
    paths[seam.key] = resolve(baseOf(seam), ...seam.rel.split("/"));
    sources[seam.key] = "default";
  }

  const hooksFile =
    manifest?.hooks === undefined
      ? undefined
      : isAbsolute(manifest.hooks)
        ? resolve(manifest.hooks)
        : resolve(contentDir, manifest.hooks);

  const name = manifest?.name ?? "engine defaults";
  const moved = SEAMS.filter((s) => sources[s.key] !== "default");
  const layout: Record<string, string> = { name };
  for (const seam of moved) {
    const p = paths[seam.key] as string;
    layout[seam.key] = isInside(p, root) ? relative(root, p).split(sep).join("/") : p;
  }
  if (sources.contentDir !== "default") layout.content = relative(root, contentDir).split(sep).join("/") || ".";
  const layoutHash = createHash("sha256").update(JSON.stringify(layout, Object.keys(layout).sort())).digest("hex");

  const summary =
    `game: ${name}${manifestFile === undefined ? "" : ` (${manifestFile})`}, content ${contentDir}` +
    (moved.length ? `, ${moved.length} path${moved.length === 1 ? "" : "s"} moved: ${moved.map((s) => s.key).join(", ")}` : "") +
    `, layout ${layoutHash.slice(0, 12)}`;

  return {
    root,
    ...(manifestFile === undefined ? {} : { manifestFile, manifest }),
    name,
    contentDir,
    assetsDir,
    engineContentDir,
    paths: Object.freeze(paths) as GamePaths,
    ...(hooksFile === undefined ? {} : { hooksFile }),
    sources: Object.freeze(sources) as GameProject["sources"],
    layoutHash,
    summary,
  };
}
