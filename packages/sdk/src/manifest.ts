/**
 * `game.json`: the one file that says where a game's content lives.
 *
 * A game that has no manifest behaves exactly as the engine always has —
 * every path falls back to the engine's own default, and the `MMO_*`
 * variables still win over both. The manifest is here so a game can live
 * anywhere, under any layout, without editing engine source; it is not a
 * list of what a game is allowed to change. Forking a system or replacing
 * it outright stays as available as it ever was.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { SEAM_KEYS, type SeamKey } from "./seams.js";

/** The file a game drops beside its content. */
export const GAME_MANIFEST_FILE = "game.json";

/** Names a manifest elsewhere; `0` runs with no manifest at all. */
export const GAME_MANIFEST_ENV = "MMO_GAME";

const PathString = z
  .string()
  .min(1, "must not be empty")
  .refine((v) => !v.includes("\0"), "must not contain a null byte");

export const GameManifestSchema = z.strictObject({
  /** The game's name, for the boot log and the manifest hash. */
  name: z.string().min(1),
  /** Free-form, for humans reading the file. */
  description: z.string().optional(),
  /** The game's content root, relative to the manifest's own folder (or absolute). Default `content`. */
  content: PathString.optional(),
  /** The art root, relative to the manifest's folder (or absolute). Default `assets`. */
  assets: PathString.optional(),
  /** Per-seam overrides, each relative to the content root (or absolute). */
  paths: z.partialRecord(z.enum(SEAM_KEYS), PathString).optional(),
  /** The rule hooks module (ES3), relative to the content root (or absolute). */
  hooks: PathString.optional(),
  /**
   * Per-module settings, by module name: `{"residents": {"maxEntities": 1200}}`.
   *
   * Reaches the module as `ctx.config[name]`, under whatever the host passes
   * for that module, so a value a run's `MMO_*` variable set still wins and a
   * key the host does not set falls through to the module's own default. The
   * keys are the module's own, not a list the engine fixes: a game's own
   * module reads its own settings here with no engine change.
   */
  modules: z.record(z.string().min(1), z.record(z.string().min(1), z.unknown())).optional(),
});

export type GameManifest = z.infer<typeof GameManifestSchema>;
export type GameManifestPaths = Partial<Record<SeamKey, string>>;

/** A manifest that cannot be used, with every problem named by field. */
export class ManifestError extends Error {
  constructor(
    readonly file: string,
    readonly problems: readonly string[],
  ) {
    super(`${file}: ${problems.length === 1 ? problems[0] : `${problems.length} problems\n  - ${problems.join("\n  - ")}`}`);
    this.name = "ManifestError";
  }
}

/**
 * Read and check a manifest. Throws {@link ManifestError} naming every
 * problem at once, the way the rules loader does, so one run fixes the file.
 */
export function loadManifest(file: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): GameManifest {
  let text: string;
  try {
    text = read(file);
  } catch (err) {
    throw new ManifestError(file, [`cannot be read (${(err as Error).message})`]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new ManifestError(file, [`is not valid JSON (${(err as Error).message})`]);
  }

  const result = GameManifestSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const where = issue.path.length ? issue.path.join(".") : "(root)";
      if (issue.code === "unrecognized_keys") {
        const keys = (issue as unknown as { keys: string[] }).keys;
        return `${where}: unknown ${keys.length === 1 ? "key" : "keys"} ${keys.join(", ")}. Known path keys are ${SEAM_KEYS.join(", ")}`;
      }
      return `${where}: ${issue.message}`;
    });
    throw new ManifestError(file, problems);
  }
  return result.data;
}
