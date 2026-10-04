/**
 * The client's world renderer, as the editor's play mode embeds it
 * (ROADMAP E4): one renderer for the game and the editor, not a copy.
 * The editor resolves `@mmo-engine/client/render` here (its Vite alias
 * and tsconfig paths); nothing in the client imports this file.
 */

export { WorldCanvas, type WorldCanvasProps, type HudData, type CombatView, type NearDrop } from "./world-canvas.js";
export { PlaceholderAssets, type AssetProvider } from "./assets.js";
export { CombatFeedback } from "./combat-feedback.js";
export { QUALITY_TIERS, type QualityTier } from "./quality.js";
export type { GpuInfo } from "./gpu.js";
export type { PerfSample } from "./perf-stats.js";
export { DEFAULT_BINDINGS, type Bindings } from "../input/bindings.js";
export { httpBaseForGameUrl, PcgRpcClient } from "@mmo-engine/picg";
export { groundColors, BIOME_GROUND } from "./terrain/ground.js";
