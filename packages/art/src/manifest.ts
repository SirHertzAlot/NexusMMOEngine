/**
 * Asset pack manifest contract (`assets/manifest.json`).
 *
 * The manifest is the single source of truth for "which art files belong to
 * this pack and what they are for". It is data, not code: Joey authors it by
 * hand (or it is produced by `scanAssetDir`), and every consumer — the
 * THREE.js provider in this package, the editor's asset inspector, future
 * build tooling — reads the same schema. Validation happens at the boundary
 * (`parseManifestJSON`), so everything downstream can trust the shape.
 *
 * Path safety rule: `file` entries must be relative POSIX paths with no `..`
 * segments and no absolute paths. A manifest is untrusted input (it ships
 * with a pack); without this rule a malicious or sloppy entry like
 * `../evil.glb` could make a loader read outside the pack root. The schema
 * rejects such entries at parse time — fail fast, never silently resolve.
 *
 * Example:
 * ```json
 * {
 *   "name": "my-pack",
 *   "version": "1.0.0",
 *   "models": [{ "id": "player", "file": "models/player.glb", "forShape": "1" }],
 *   "textures": [{ "id": "grass", "file": "textures/grass.png" }]
 * }
 * ```
 */

import { z } from "zod";

/**
 * A path inside an asset pack. Relative POSIX only: no leading `/`, no
 * Windows drive prefix, no backslashes, and no `..` segments, so the path
 * can never escape the pack root it is resolved against.
 */
const PackPath = z
  .string()
  .min(1, "file must be a non-empty path")
  .refine((p) => !p.startsWith("/"), {
    message: "file must be a relative path, not an absolute POSIX path",
  })
  .refine((p) => !/^[A-Za-z]:/.test(p), {
    message: "file must be a relative path, not a Windows absolute path",
  })
  .refine((p) => !p.includes("\\"), {
    message: "file must use POSIX '/' separators",
  })
  .refine((p) => !p.split("/").includes(".."), {
    message: 'file must not contain ".." segments (path traversal)',
  });

const EntryId = z.string().min(1, "id must be a non-empty string");

const ModelEntrySchema = z.object({
  id: EntryId,
  file: PackPath,
  /**
   * Optional shape binding. Matched as `String(body.shapeKind)` by
   * ManifestAssetProvider.bodyMesh — e.g. `forShape: "1"` selects this
   * model for every Sphere body. A model without `forShape` still loads
   * and appears in fallbackStatus(), but is never auto-selected.
   */
  forShape: z.string().min(1).optional(),
});

const TextureEntrySchema = z.object({
  id: EntryId,
  file: PackPath,
  /** When true, this texture is used as the terrain albedo (see provider). */
  forTerrain: z.boolean().optional(),
});

export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type TextureEntry = z.infer<typeof TextureEntrySchema>;

/**
 * The full manifest schema. `models` and `textures` are both required
 * (possibly empty): a manifest must declare both sections so a missing
 * section is a loud authoring error, not a silent default. Unknown keys
 * are stripped (not rejected) so the schema stays forward-compatible.
 * Duplicate ids within one section are rejected — an id is the lookup
 * key for loading and fallback reporting, so it must be unambiguous.
 */
export const ManifestSchema = z
  .object({
    name: z.string().min(1, "name must be a non-empty string"),
    version: z.string().min(1, "version must be a non-empty string"),
    models: z.array(ModelEntrySchema),
    textures: z.array(TextureEntrySchema),
  })
  .superRefine((manifest, ctx) => {
    const sections: ReadonlyArray<readonly [string, ReadonlyArray<{ id: string; file: string }>]> = [
      ["model", manifest.models],
      ["texture", manifest.textures],
    ];
    for (const [kind, entries] of sections) {
      const seen = new Map<string, string>();
      for (const entry of entries) {
        const firstFile = seen.get(entry.id);
        if (firstFile !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${kind} id "${entry.id}" is duplicated ("${firstFile}" and "${entry.file}"); ids must be unique`,
          });
        } else {
          seen.set(entry.id, entry.file);
        }
      }
    }
  });

export type AssetManifest = z.infer<typeof ManifestSchema>;

/**
 * Parse untrusted JSON into a validated AssetManifest. Throws a ZodError
 * on any contract violation (missing sections, bad paths, duplicate ids).
 */
export function parseManifestJSON(value: unknown): AssetManifest {
  return ManifestSchema.parse(value);
}

/**
 * Cross-check a manifest against the files actually present in a pack.
 * Returns one human-readable diagnostic per referenced file that is
 * missing from `existingFiles` (paths as they appear in the manifest,
 * e.g. `"models/player.glb"`); empty array means the pack is complete.
 */
export function checkManifestFiles(
  manifest: AssetManifest,
  existingFiles: ReadonlySet<string>,
): string[] {
  const diagnostics: string[] = [];
  for (const model of manifest.models) {
    if (!existingFiles.has(model.file)) {
      diagnostics.push(
        `model "${model.id}": file "${model.file}" is referenced in the manifest but missing from the pack`,
      );
    }
  }
  for (const texture of manifest.textures) {
    if (!existingFiles.has(texture.file)) {
      diagnostics.push(
        `texture "${texture.id}": file "${texture.file}" is referenced in the manifest but missing from the pack`,
      );
    }
  }
  return diagnostics;
}
