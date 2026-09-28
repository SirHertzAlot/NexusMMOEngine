/**
 * @mmo-engine/art — the art asset pipeline contract.
 *
 * - `manifest.ts`: the `assets/manifest.json` schema, validation, and
 *   pack-completeness checking (`parseManifestJSON`, `checkManifestFiles`).
 * - `scan.ts`: derive a manifest from a pack folder on disk (`scanAssetDir`).
 * - `provider.ts`: the `AssetProvider` interface the renderer consumes, plus
 *   `ManifestAssetProvider` — manifest-backed THREE.js meshes with
 *   placeholder fallback for anything missing or unloadable.
 */

export * from "./manifest.js";
export * from "./scan.js";
export * from "./provider.js";
