/**
 * Server settings forms (Live ops › Server settings): content/server/
 * persistence.json (roadmap EG13) and world.json (EG14) as labelled
 * fields. The server reads them when it starts; the editor's Database query
 * uses the query caps at once. Browser-safe.
 */

import type { FieldSectionSpec } from "./rules-control.js";

export const PERSISTENCE_SECTIONS: FieldSectionSpec[] = [
  {
    title: "Saving the world",
    help: "Read when the server starts: restart it to apply a change.",
    fields: [
      { key: "saveEverySeconds", label: "Save every (s)", kind: "number", min: 0, max: 3600, def: 10, help: "Also saved on shutdown. Shorter loses less on a crash and costs more disk writes." },
      { key: "keepSnapshots", label: "Snapshots kept", kind: "number", int: true, min: 1, max: 1000, def: 6, help: "The newest ones; each is a full copy of the world." },
      { key: "walLimitMb", label: "Save log limit (MB)", kind: "number", min: 0, max: 1024, def: 4, help: "The log is cut back to this after each checkpoint." },
    ],
  },
  {
    title: "Database queries",
    help: "The Database › Query view and admin tools. A change applies to the next query.",
    fields: [
      { key: "queryDefaultRows", label: "Rows when none asked", kind: "number", int: true, min: 1, def: 500 },
      { key: "queryMaxRows", label: "Most rows", kind: "number", int: true, min: 1, max: 1000000, def: 5000 },
      { key: "queryTimeoutSeconds", label: "Stop a query after (s)", kind: "number", min: 0, max: 600, def: 2 },
    ],
  },
];

/** world.json (EG14): the day cycle and the server-run bots. */
export const WORLD_SECTIONS: FieldSectionSpec[] = [
  {
    title: "Day and night",
    help: "Read when the server starts. MMO_DAY_SECONDS and MMO_DAY_OFFSET, when set, win over these.",
    fields: [
      { key: "daySeconds", label: "Real seconds per game day", kind: "number", min: 0, def: 2400, help: "2400 is a 40-minute day. 0 turns the day cycle off." },
      { key: "dayOffset", label: "Time of day at the start", kind: "number", min: 0, max: 0.999, def: 0.35, help: "0 midnight, 0.25 dawn, 0.5 noon, 0.75 dusk." },
    ],
  },
  {
    title: "Bots",
    help: "Computer-driven characters near the spawn: two in three spar in pairs, the rest wander. MMO_BOTS, MMO_BOTS_HOME and MMO_BOTS_RADIUS win over these, and so does Play's bot count. How they move is in Gameplay › Tables › Movement.",
    fields: [
      { key: "bots.count", label: "Bots", kind: "number", int: true, min: 0, max: 1000, def: 0 },
      { key: "bots.home", label: "Home (x, z in m)", kind: "point", nullable: true, def: null, help: "Where they gather. Empty: beside the spawn point." },
      { key: "bots.radiusM", label: "Roam radius (m)", kind: "number", min: 0, def: 18 },
    ],
  },
];

/** What the bake fixes: shown, not edited (docs/CONFIGURATION.md). */
export const WORLD_FIXED: ReadonlyArray<{ label: string; where: string }> = [
  { label: "World seed", where: "The bake's, recorded with the world. MMO_WORLD_SEED (default 1234) only seeds an unbaked world." },
  { label: "Chunk size", where: "MMO_CHUNK_SIZE, default 16 m. Must match the bake." },
  { label: "Spawn area radius", where: "MMO_WORLD_RADIUS, default 1 chunk (3 × 3), matching bake:world." },
  { label: "Streaming radius", where: "MMO_STREAM_RADIUS, default 8 chunks around each player." },
];
