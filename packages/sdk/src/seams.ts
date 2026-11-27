/**
 * Every path the engine reads a game through, in one table.
 *
 * Each row is a seam: its key in `game.json`'s `paths`, the `MMO_*`
 * variables that override it for one run, where its default is rooted, and
 * that default. The table is the whole contract — a reader can see what a
 * game may point elsewhere without reading the engine, and a new seam is
 * one row rather than a path spelled out in a fourth place.
 *
 * `base` says what the default is relative to:
 *
 * - `content` — the game's content root (`game.json`'s `content`, default
 *   `<root>/content`). Everything a game authors.
 * - `engine` — the engine's own bundled content
 *   (`packages/engine-core/content`). Sample data that ships with the
 *   engine: the biome registry, the ecology plan, the wildlife tables.
 *   A game points these at its own files and nothing of ours is read.
 * - `assets` — the art root (`game.json`'s `assets`, default
 *   `<root>/assets`). Licensed and read-only here.
 * - `root` — the checkout itself, for the few paths that are the engine's
 *   rather than a game's.
 * - `cwd` — resolved from where the process was started, not the repo.
 *   Only `dataDir`, which has always behaved that way.
 *
 * The defaults are the engine's current constants, verbatim; the test
 * beside this file imports each one and fails if a default drifts from it.
 */

export type SeamBase = "content" | "engine" | "assets" | "root" | "cwd";

export interface Seam {
  /** The key in `game.json`'s `paths`. */
  readonly key: string;
  /** `MMO_*` variables, in the order the engine reads them today. */
  readonly env: readonly string[];
  readonly base: SeamBase;
  /** The default, relative to `base`, in POSIX form. */
  readonly rel: string;
  /** What it is, for the manifest docs and the boot summary. */
  readonly what: string;
  /**
   * The variable is also used as an on/off flag, so `0` and `1` are not
   * paths (`MMO_WILDLIFE=1` means "plan the table", not "read ./1").
   */
  readonly flagLike?: boolean;
}

const SEAM_TABLE = [
  // The game's own content.
  { key: "rulesDir", env: ["MMO_RULES"], base: "content", rel: "rules", what: "skills, disciplines, combat, body parts, death, appearance" },
  { key: "scenesDir", env: ["MMO_SCENES", "MMO_SCENES_DIR"], base: "content", rel: "scenes", what: "scenes whose nodes spawn at boot" },
  { key: "prefabsDir", env: ["MMO_PREFABS"], base: "content", rel: "prefabs", what: "the prefab files scenes expand" },
  { key: "serverSettingsDir", env: ["MMO_SERVER_SETTINGS"], base: "content", rel: "server", what: "operator settings: persistence.json, world.json" },
  { key: "combatFile", env: ["MMO_COMBAT"], base: "content", rel: "combat/moves.json", what: "the combat moves" },
  { key: "craftingFile", env: ["MMO_CRAFTING"], base: "content", rel: "crafting/recipes.json", what: "crafting rules" },
  { key: "questsDir", env: ["MMO_QUESTS"], base: "content", rel: "quests", what: "quest and dialog content" },
  { key: "dungeonsDir", env: ["MMO_DUNGEONS"], base: "content", rel: "dungeons", what: "dungeon instance rules and entrances" },
  { key: "speciesFile", env: ["MMO_SPECIES"], base: "content", rel: "species/species.json", what: "the species overlay over the built-in roster" },
  { key: "speciesDir", env: ["MMO_SPECIES_DIR"], base: "content", rel: "species", what: "species definitions" },
  { key: "settlementsDir", env: ["MMO_SETTLEMENTS", "MMO_SETTLEMENT_OUT"], base: "content", rel: "settlements", what: "baked settlement manifests" },
  { key: "settlementRulesFile", env: ["MMO_SETTLEMENT_RULES"], base: "content", rel: "settlements/rules.json", what: "the town generator's rules" },
  { key: "characterRulesFile", env: ["MMO_CHARACTER_RULES"], base: "content", rel: "settlements/character.json", what: "settlement character rules" },
  { key: "civicRulesFile", env: ["MMO_CIVIC_RULES"], base: "content", rel: "rules/civic.json", what: "civic and logistics rules" },
  { key: "characterCreationFile", env: ["MMO_CHARACTER_CREATION"], base: "content", rel: "character-creation.json", what: "what a player may choose when creating a character (absent: the engine's defaults)" },
  { key: "lessonsFile", env: ["MMO_LESSONS"], base: "content", rel: "lessons.json", what: "lessons a pupil can take" },
  { key: "vendorsFile", env: ["MMO_VENDORS"], base: "content", rel: "vendors.json", what: "shop templates placed in scenes" },
  { key: "structuresFile", env: ["MMO_STRUCTURES"], base: "content", rel: "structures.json", what: "breakable structure kinds" },
  { key: "modulesSetFile", env: ["MMO_MODULES"], base: "content", rel: "modules.json", what: "the enabled module set" },
  { key: "pcgAssetsDir", env: ["MMO_PCG_ASSETS"], base: "content", rel: "pcg", what: "the PCG asset library the server cooks and serves" },
  { key: "scaleFile", env: [], base: "content", rel: "scale.json", what: "committed model scales" },
  { key: "scaleLocalFile", env: ["MMO_SCALE_OUT"], base: "content", rel: "scale.local.json", what: "fitted model scales, written by scale-fit (gitignored)" },
  { key: "synthesisFile", env: ["MMO_SYNTHESIS"], base: "content", rel: "synthesis/fantasy-kingdom.local.json", what: "optional building and interior synthesis library" },
  { key: "animationClipsFile", env: [], base: "content", rel: "animation/clips.json", what: "the clip map replication uses" },
  { key: "graphFile", env: [], base: "content", rel: "graph/ecs-graph.json", what: "the committed ECS graph artifact" },
  { key: "creditsFile", env: [], base: "content", rel: "credits.json", what: "art credits and licence lanes" },

  // The engine's own bundled content, inside packages/engine-core.
  { key: "biomesFile", env: ["MMO_BIOMES"], base: "engine", rel: "biomes.json", what: "the biome registry: scatter multipliers and creature tables" },
  { key: "ecologyFile", env: ["MMO_ECOLOGY"], base: "engine", rel: "ecology/wilds.ecology.json", what: "what grows on a chunk the first time it loads" },
  { key: "wildlifeTableFile", env: ["MMO_WILDLIFE"], base: "engine", rel: "wildlife/wildlife.json", what: "the wildlife table", flagLike: true },
  { key: "naturalWeaponsFile", env: [], base: "engine", rel: "wildlife/natural.json", what: "natural weapons for wild creatures" },

  // The engine's and the art's.
  { key: "modulesDir", env: [], base: "root", rel: "modules", what: "the module folders the server loads" },
  { key: "worldSpecFile", env: ["MMO_WORLD_SPEC"], base: "root", rel: "packages/engine-core/worlds/default.world.json", what: "the world spec a bake builds from" },
  { key: "catalogFile", env: ["MMO_CATALOG"], base: "assets", rel: "catalog.json", what: "the art catalog (licensed, absent in a fresh clone)" },
  { key: "characterCatalogFile", env: ["MMO_CHARACTER_CATALOG"], base: "assets", rel: "models/glb/modular-fantasy-hero/Rigged/catalog.json", what: "the modular part catalog a character's look is checked against" },
  { key: "dataDir", env: ["MMO_DATA_DIR"], base: "cwd", rel: "data", what: "the region database, logs and saves" },
] as const;

export type SeamKey = (typeof SEAM_TABLE)[number]["key"];

/** Every seam, in table order. */
export const SEAMS: readonly Seam[] = SEAM_TABLE;

export const SEAM_KEYS = SEAM_TABLE.map((s) => s.key) as unknown as readonly [SeamKey, ...SeamKey[]];

/** Every seam by key. */
export const SEAM_BY_KEY: Readonly<Record<SeamKey, Seam>> = Object.freeze(
  Object.fromEntries(SEAMS.map((s) => [s.key, s])) as unknown as Record<SeamKey, Seam>,
);

/** Every `MMO_*` variable a seam reads, deduplicated, in table order. */
export const SEAM_ENV_NAMES: readonly string[] = [...new Set(SEAMS.flatMap((s) => s.env))];
