/**
 * The dungeon run rules and entrances as designer forms (roadmap EG1):
 * field specs over content/dungeons/instances.json and entrances.json
 * (engine-core dungeons/content.ts holds their schemas). The server reads
 * both when it starts; the panel says so once rather than on every field.
 */

import type { FieldSectionSpec, FieldSpec } from "./rules-control.js";

const count = (max: number) => ({ kind: "number", int: true, min: 0, max }) as const;
const metres = { kind: "number", min: 0, max: 100 } as const;

/** instances.json, by section. `version` and `commit` have one legal value and are left out. */
export const RUN_SECTIONS: readonly FieldSectionSpec[] = [
  {
    title: "Party and time",
    help: "Who may enter together, and how long a run lasts.",
    fields: [
      { key: "partySize", label: "Party size (min–max)", kind: "pair", help: "Members who may enter together, 1 to 40." },
      { key: "timeLimitMinutes", label: "Time limit (min)", kind: "number", min: 0, max: 1440, help: "The run times out after this." },
      { key: "reentry", label: "Re-entry", kind: "bool", help: "A member who leaves or drops may come back while the run lasts." },
    ],
  },
  {
    title: "Instances",
    help: "How many runs a region keeps, and when an empty one ends.",
    fields: [
      { key: "maxInstances", label: "Runs at once per region", ...count(256) },
      { key: "emptyTeardownSeconds", label: "Empty run ends after (s)", kind: "number", min: 0, max: 3600, help: "Nobody inside for this long ends the run as abandoned." },
      { key: "fallbackCreature", label: "Fallback creature", kind: "enum", options: "creatures", help: "Creature rules a spawn point takes when its species has none." },
    ],
  },
  {
    title: "Loot",
    help: "Rolls from the loot pools. Each is a range: a run rolls a number in it.",
    fields: [
      { key: "lootRollsPerKill", label: "Rolls per kill (min–max)", kind: "pair" },
      { key: "bossLootRolls", label: "Rolls per boss-room kill (min–max)", kind: "pair" },
      { key: "chestsPerRun", label: "Chests per run", ...count(64), help: "Placed in the lowest-id rooms past the entrance." },
      { key: "chestLootRolls", label: "Rolls per chest (min–max)", kind: "pair" },
      { key: "chestOpenRadiusM", label: "Chest open distance (m)", ...metres },
    ],
  },
  {
    title: "Traps",
    help: "Traps spring once on the first member to come near, then are spent.",
    fields: [
      { key: "trapsPerRun", label: "Traps per run", ...count(64) },
      { key: "trapHarm", label: "Trap harm (health)", kind: "number", min: 1, max: 1000 },
      { key: "trapTriggerRadiusM", label: "Trap trigger distance (m)", ...metres },
    ],
  },
];

/** One entrance (entrances.json entrances.<id>). */
export const ENTRANCE_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", kind: "text" },
  { key: "x", label: "World x (m)", kind: "number" },
  { key: "z", label: "World z (m)", kind: "number" },
  { key: "radius", label: "Ask distance (m)", ...metres, help: "How close the party leader must stand." },
  { key: "rank", label: "Dressing rank", kind: "number", int: true, min: 0, nullable: true, help: "Only pool layouts of this rank. Empty: any." },
  { key: "themes", label: "Themes", kind: "list", def: [], help: "Only pool layouts of these themes, comma-separated. Empty: any." },
];

export const newEntrance = (): Record<string, unknown> => ({ name: "New entrance", x: 0, z: 0, radius: 8, rank: null, themes: [] });

/** Entrance ids are the schema's: lowercase letters, digits and dashes. */
export const ENTRANCE_ID = { pattern: /^[a-z][a-z0-9-]*$/, hint: "lowercase letters, digits, -" };
