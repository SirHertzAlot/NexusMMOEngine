/**
 * The species roster the server runs with: the engine's built-in roster with
 * the game's overlay file merged over it (`content/species/species.json`,
 * what the editor's Species grid writes; `MMO_SPECIES` names another).
 *
 * Where it reaches the game:
 *  - scenes: a node's `Spawner.species` spawns a pack of that species' creature,
 *    sized by the species' `pack` (scene-spawn.ts);
 *  - the open world: a species the overlay edits sets the pack size of its
 *    creature when a biome table doesn't (the shipped roster leaves creature
 *    rules in charge, so playing with no overlay is unchanged);
 *  - boot checks: biome tables must name a creature or a species.
 *
 * A malformed overlay refuses the boot, listing every problem, like rules.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_SPECIES, loadSpecies, type Roster } from "@mmo-engine/species";

/** The repo's content/species/species.json (this file is dist/src/species-roster.js). */
export const DEFAULT_SPECIES_FILE = fileURLToPath(new URL("../../../../content/species/species.json", import.meta.url));

export interface ServerRoster {
  roster: Roster;
  /** Ids the overlay file adds or replaces. */
  edited: ReadonlySet<string>;
  /** For the boot log. */
  summary: string;
}

export function loadServerRoster(file: string = process.env.MMO_SPECIES || DEFAULT_SPECIES_FILE): ServerRoster {
  if (!existsSync(file)) {
    if (process.env.MMO_SPECIES) throw new Error(`MMO_SPECIES: no file ${file}`);
    return { roster: BUILTIN_SPECIES, edited: new Set(), summary: `species: ${Object.keys(BUILTIN_SPECIES).length} built in (no ${file})` };
  }
  const roster = loadSpecies(file);
  const edited = new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object));
  return { roster, edited, summary: `species: ${Object.keys(roster).length} (${edited.size} from ${file})` };
}

/** The pack size an edited species gives its creature in the open world; undefined: leave it to the biome and creature rules. */
export function editedPack(r: ServerRoster, kind: string): [number, number] | undefined {
  const sp = r.edited.has(kind) ? r.roster[kind] : undefined;
  return sp ? [sp.pack[0], sp.pack[1]] : undefined;
}
