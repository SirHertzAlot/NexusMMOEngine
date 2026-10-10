/**
 * Asset ID → URL resolution for the editor (EA15).
 *
 * Resolves a manifest model/texture ID to its servable URL so the
 * AssetPreview component can render it without knowing the file layout.
 *
 * Route (wired in host.ts):
 *   GET /api/editor/assets/resolve?id=<assetId> → { ok: true, url: "/assets/<file>" }
 *   404 if the ID isn't in the manifest or assets/ is missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AssetResolveResult {
  ok: boolean;
  /** Servable URL (e.g. "/assets/models/goblin.glb"), present when ok. */
  url?: string;
  /** Error message, present when !ok. */
  error?: string;
}

/**
 * Resolve an asset ID to its URL via the pack manifest.
 * Returns { ok: false } if assets/ is missing or the ID isn't found.
 */
export function resolveAssetUrl(repoRoot: string, assetId: string): AssetResolveResult {
  const assetsRoot = join(repoRoot, "assets");
  if (!existsSync(assetsRoot)) {
    return { ok: false, error: "assets/ directory not found" };
  }
  const manifestPath = join(assetsRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, error: "assets/manifest.json not found" };
  }
  let manifest: { models?: Array<{ id: string; file: string }>; textures?: Array<{ id: string; file: string }> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, error: "assets/manifest.json is not valid JSON" };
  }
  const all = [...(manifest.models ?? []), ...(manifest.textures ?? [])];
  const entry = all.find((e) => e.id === assetId);
  if (!entry) {
    return { ok: false, error: `asset "${assetId}" not found in manifest` };
  }
  // Confine to assets/ (no path traversal).
  const file = entry.file.replace(/^\/+/, "");
  if (file.includes("..")) {
    return { ok: false, error: "invalid asset path" };
  }
  return { ok: true, url: `/assets/${file}` };
}
