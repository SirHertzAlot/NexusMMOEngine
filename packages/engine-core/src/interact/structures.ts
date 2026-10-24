/**
 * Structure kinds that break (IX6): content/structures.json maps a scene Structure `kind` (a
 * house, a guildhall, a gate) to how it breaks: health, `minStrength` a player needs for a blow
 * to hurt it, and what mending it takes. A scene node's own Breakable component beats it.
 * Buildings have `into: "variant"` and no respawn: a broken one stays broken until someone mends it.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { BreakableSchema, type Breakable } from "@mmo-engine/scatter";

const StructuresSchema = z.object({
  version: z.literal(1, "unsupported structures version"),
  kinds: z.record(z.string(), BreakableSchema),
});

/** The breakable structure kinds in `file` (absent file: none). Throws on a bad file, naming what is wrong. */
export function loadStructureBreakables(file: string): Map<string, Breakable> {
  if (!existsSync(file)) return new Map();
  const parsed = StructuresSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return new Map(Object.entries(parsed.data.kinds));
}
