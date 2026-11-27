/**
 * What the host itself owns of the world's things.
 *
 * The two systems that used to be re-exported here, `BreakSystem` and
 * `ChestSystem`, live in `@mmo-engine/kit-economy` now (`ES5n`), and with
 * them went the last thing in the engine that could name an economy system.
 * What is left is the host's: the store that records what a scene placed and
 * what has happened to it, the content loaders a scene needs, and the
 * collapse system, which is `core`'s because toppling a building is the
 * world's business rather than a game's.
 */
export { SqlitePlacesStore, placeRecordsOf, type PlaceKind, type PlaceRecord, type PlacesStore } from "./places-store.js";
export { loadVendors, loadVendorTemplates, type VendorTemplate } from "./vendors.js";
export { loadStructureBreakables } from "./structures.js";
export { CollapseSystem, type CollapseOptions, type CollapsePartSpec } from "./collapse.js";
