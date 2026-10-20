import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A path the user typed: relative to where they ran npm (INIT_CWD), not the package folder npm runs the script in. */
export const fromUser = (p: string): string => resolve(process.env.INIT_CWD ?? process.cwd(), p);

/** The repo root, from this file's place in dist/src. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface SettlementPaths {
  settlements: string;
  scenes: string;
  scaleBase: string;
  scaleOut: string;
  catalog: string;
  /** The town generator's rules file (the editor's Towns screen edits it). */
  rules: string;
}

/**
 * Where the settlement CLIs read and write, from the MMO_* path variables `npm run bake:all`
 * documents (README "Baking everything"), else the repo's content/ and assets/. Relative values
 * resolve from `cwd` (where npm was run). Flags on a CLI still win over these.
 */
export function settlementPaths(env: NodeJS.ProcessEnv = process.env, cwd: string = env.INIT_CWD ?? process.cwd(), repo: string = REPO): SettlementPaths {
  const pick = (...names: string[]): string | undefined => names.map((n) => env[n]).find((v) => v !== undefined && v !== "");
  const abs = (v: string | undefined, fallback: string): string => (v === undefined ? fallback : resolve(cwd, v));
  const root = abs(pick("MMO_REPO"), repo);
  const content = abs(pick("MMO_CONTENT_DIR"), resolve(root, "content"));
  const assets = abs(pick("MMO_ASSETS_DIR"), resolve(root, "assets"));
  return {
    settlements: abs(pick("MMO_SETTLEMENT_OUT"), resolve(content, "settlements")),
    scenes: abs(pick("MMO_SCENES_DIR", "MMO_SCENES"), resolve(content, "scenes")),
    scaleBase: resolve(content, "scale.json"),
    scaleOut: abs(pick("MMO_SCALE_OUT"), resolve(content, "scale.local.json")),
    catalog: abs(pick("MMO_CATALOG"), resolve(assets, "catalog.json")),
    // Authored content, not bake output: it stays with the repo when MMO_CONTENT_DIR points the bakes elsewhere.
    rules: abs(pick("MMO_SETTLEMENT_RULES"), resolve(root, "content", "settlements", "rules.json")),
  };
}
