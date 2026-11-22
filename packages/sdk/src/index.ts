/**
 * `@mmo-engine/sdk` — the seam between the engine and a game.
 *
 * A game says where its content is in a `game.json`; the engine reads every
 * path through {@link openGameProject}. Nothing here constrains what a game
 * does: it exists so a game can sit outside the engine's folders and keep
 * doing so across an engine upgrade.
 */

export {
  GAME_MANIFEST_ENV,
  GAME_MANIFEST_FILE,
  GameManifestSchema,
  ManifestError,
  loadManifest,
  type GameManifest,
  type GameManifestPaths,
} from "./manifest.js";

export {
  SEAMS,
  SEAM_BY_KEY,
  SEAM_ENV_NAMES,
  SEAM_KEYS,
  type Seam,
  type SeamBase,
  type SeamKey,
} from "./seams.js";

export {
  ENGINE_ROOT,
  findManifest,
  isInside,
  openGameProject,
  type GamePaths,
  type GameProject,
  type OpenGameProjectOptions,
  type PathSource,
} from "./project.js";

export {
  MissingServicesError,
  ServiceRegistry,
  openServiceRegistry,
  type MissingService,
  type ServiceDecl,
  type ServiceSources,
} from "./services.js";
