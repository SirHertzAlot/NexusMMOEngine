import type { SystemRole } from "./schema.js";

/**
 * Reviewed architectural roles for every system in the resolved tick roster.
 * Validation (§7 invariant 6) enforces that every system in the resolved tick
 * roster has a known, non-empty role configured here.
 */
export const SYSTEM_ROLES: Readonly<Record<string, SystemRole>> = {
  // core module
  reloader: "infrastructure",
  streamer: "infrastructure",
  gathering: "simulation",
  chests: "simulation",
  breaks: "simulation",
  collapse: "simulation",

  // economy module
  wallet: "infrastructure",
  trade: "infrastructure",
  vendor: "simulation",
  auction: "infrastructure",

  // items module
  items: "simulation",

  // civic module
  civic: "simulation",

  // character module
  character: "simulation",
  animation: "simulation",
  mastery: "simulation",
  stats: "simulation",

  // combat module
  stamina: "simulation",
  body: "simulation",
  magic: "simulation",
  abilities: "simulation",
  status: "simulation",
  telegraphs: "simulation",
  duels: "simulation",
  combat: "simulation",
  death: "simulation",

  // physics module
  physics: "simulation",
  navigation: "simulation",
  obstacles: "simulation",
  integrate: "simulation",
  "character-bridge": "simulation",
  "prop-collision": "simulation",
  collider: "simulation",

  // creatures module
  creatures: "simulation",
  bots: "simulation",
  crowd: "simulation",
  needs: "simulation",

  // residents module
  residents: "simulation",

  // intent module
  intent: "simulation",
};

/**
 * H3 ratchet allowlist: empty once every simulation system explicitly declares
 * `SimSystem.access`. Any newly added unannotated simulation system fails validation.
 */
export const INFERRED_SIM_ALLOWLIST: readonly string[] = [];

/** Maximum permitted unannotated simulation systems under the H3 ratchet. */
export const MAX_UNANNOTATED_SIM_SYSTEMS = INFERRED_SIM_ALLOWLIST.length;

/**
 * Mapping from core/module tick-roster names whose runtime `SimSystem.name` or
 * TypeScript class differs from the manifest key.
 */
export const ROSTER_TO_CLASS_HINTS: Readonly<Record<string, { className: string; simName: string }>> = {
  reloader: { className: "RulesReloader", simName: "rules" },
  streamer: { className: "ChunkStreamer", simName: "chunk-streamer" },
  collider: { className: "ColliderSystem", simName: "colliders" },
  navigation: { className: "NavigationSystem", simName: "NavigationSystem" },
  obstacles: { className: "NavObstacleSystem", simName: "nav-obstacles" },
  animation: { className: "AnimationSystem", simName: "AnimationSystem" },
  telegraphs: { className: "TelegraphSystem", simName: "telegraph" },
  duels: { className: "DuelSystem", simName: "duel" },
  items: { className: "ItemService", simName: "items" },
  civic: { className: "CivicService", simName: "civic" },
};
