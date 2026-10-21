/**
 * The one place `npm run bake:all` decides where things are. Resolved once,
 * handed to every step. Precedence: flag, then environment variable, then a
 * default under the repo root. Relative values resolve from where npm was run
 * (INIT_CWD), like the settlement CLIs' own flags.
 *
 *   key            flag             variable             default
 *   repo           --repo           MMO_REPO             auto-detected (this checkout)
 *   dataDir        --data-dir       MMO_DATA_DIR         <repo>/packages/engine-core/data
 *   contentDir     --content-dir    MMO_CONTENT_DIR      <repo>/content
 *   assetsDir      --assets-dir     MMO_ASSETS_DIR       <repo>/assets            (read only)
 *   catalog        --catalog        MMO_CATALOG          <assets>/catalog.json
 *   worldSpec      --world-spec     MMO_WORLD_SPEC       <repo>/packages/engine-core/worlds/default.world.json
 *   settlementOut  --settlement-out MMO_SETTLEMENT_OUT   <content>/settlements
 *   scenesDir      --scenes-dir     MMO_SCENES_DIR       <content>/scenes   (alias: the server's MMO_SCENES)
 *   scaleOut       --scale-out      MMO_SCALE_OUT        <content>/scale.local.json
 */

import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** key -> [flag, variables in precedence order]. */
export const PATH_SETTINGS = {
  repo: ["repo", ["MMO_REPO"]],
  dataDir: ["data-dir", ["MMO_DATA_DIR"]],
  contentDir: ["content-dir", ["MMO_CONTENT_DIR"]],
  assetsDir: ["assets-dir", ["MMO_ASSETS_DIR"]],
  catalog: ["catalog", ["MMO_CATALOG"]],
  worldSpec: ["world-spec", ["MMO_WORLD_SPEC"]],
  settlementOut: ["settlement-out", ["MMO_SETTLEMENT_OUT"]],
  scenesDir: ["scenes-dir", ["MMO_SCENES_DIR", "MMO_SCENES"]],
  scaleOut: ["scale-out", ["MMO_SCALE_OUT"]],
};
export const PATH_FLAGS = Object.values(PATH_SETTINGS).map(([flag]) => flag);

const inside = (child, parent) => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[a-zA-Z]:/.test(r));
};

/** @returns every resolved path, plus `sources` (where each came from) and `hasCatalog`. Throws a message naming the variable that is wrong. */
export function resolvePaths({ env = process.env, flags = {}, initCwd = env.INIT_CWD ?? process.cwd(), repo = defaultRepo, exists = existsSync } = {}) {
  const sources = {};
  const names = {};
  /** The value of a setting, absolute, or `fallback` (already absolute). */
  const pick = (key, fallback) => {
    const [flag, vars] = PATH_SETTINGS[key];
    let raw;
    let from = "default";
    if (flag in flags) {
      raw = flags[flag];
      if (typeof raw !== "string" || raw === "") throw new Error(`--${flag} needs a value`);
      from = `--${flag}`;
    } else {
      for (const v of vars) {
        if (env[v] !== undefined && env[v] !== "") {
          raw = env[v];
          from = v;
          break;
        }
      }
    }
    sources[key] = from;
    names[key] = from === "default" ? vars[0] : from;
    if (raw === undefined) return fallback;
    if (raw.includes("\0")) throw new Error(`${names[key]}: not a path`);
    return resolve(initCwd, raw);
  };

  const root = pick("repo", resolve(repo));
  if (!exists(join(root, "package.json"))) throw new Error(`${names.repo}: ${root} is not a repo checkout (no package.json)`);
  const dataDir = pick("dataDir", resolve(root, "packages", "engine-core", "data"));
  const contentDir = pick("contentDir", resolve(root, "content"));
  const assetsDir = pick("assetsDir", resolve(root, "assets"));
  const catalog = pick("catalog", resolve(assetsDir, "catalog.json"));
  const worldSpec = pick("worldSpec", resolve(root, "packages", "engine-core", "worlds", "default.world.json"));
  const settlementOut = pick("settlementOut", resolve(contentDir, "settlements"));
  const scenesDir = pick("scenesDir", resolve(contentDir, "scenes"));
  const scaleOut = pick("scaleOut", resolve(contentDir, "scale.local.json"));

  if (worldSpec === resolve(initCwd, "none")) throw new Error(`${names.worldSpec}=none is the legacy world, which has no town sites: bake:all needs a world spec`);
  if (!exists(worldSpec)) throw new Error(`${names.worldSpec}: ${worldSpec} does not exist`);
  // The art is licensed and read only: nothing the bake writes may land in it.
  const outs = { dataDir, contentDir, settlementOut, scenesDir, scaleOut };
  for (const [key, dir] of Object.entries(outs)) {
    for (const forbidden of new Set([assetsDir, resolve(root, "assets")])) {
      if (inside(dir, forbidden)) throw new Error(`${names[key]}: ${dir} is inside the assets folder (MMO_ASSETS_DIR ${forbidden}); the bake never writes there`);
    }
  }

  const repoScale = resolve(root, "content", "scale.json");
  const ownScale = resolve(contentDir, "scale.json");
  return {
    repo: root,
    dataDir,
    contentDir,
    assetsDir,
    catalog,
    worldSpec,
    settlementOut,
    scenesDir,
    scaleOut,
    // derived
    scaleBase: exists(ownScale) ? ownScale : repoScale,
    ecologyBase: resolve(root, "packages", "engine-core", "content", "ecology", "wilds.ecology.json"),
    ecologyOut: resolve(contentDir, "ecology", "wildlife.local.ecology.json"),
    wildlifeModelsOut: resolve(contentDir, "wildlife", "models.local.json"),
    envFile: resolve(contentDir, "bake-env.local.txt"),
    hasCatalog: exists(catalog),
    sources,
  };
}
