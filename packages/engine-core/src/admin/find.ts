/**
 * Entity search (roadmap A2, pick-or-search): find entities for the admin
 * console when you do not have a wire id. A query matches an entity when
 *  - its decimal wire id starts with the query (`find 1234`),
 *  - it carries the component named by the query (`find Needs`),
 *  - its creature kind or name contains the query (`find wolf`).
 * Matching is case-insensitive. A pure read: nothing is written.
 * Results are capped so a broad query stays a few hundred bytes.
 */

import { defineQuery, hasComponent } from "bitecs";
import { z } from "zod";
import * as C from "../components.js";
import type { SimWorld } from "../world.js";

export const FIND_LIMIT = 20;

export const FindArgsSchema = z
  .object({
    query: z.string().min(1).max(64),
  })
  .strict();

export type FindArgs = z.infer<typeof FindArgsSchema>;

/** Components a search can name, the same set `inspect` dumps. */
const COMPONENTS: Record<string, object> = {
  Transform: C.Transform,
  Velocity: C.Velocity,
  PlayerIntent: C.PlayerIntent,
  Chunk: C.Chunk,
  Health: C.Health,
  Stamina: C.Stamina,
  Needs: C.Needs,
  CharacterRef: C.CharacterRef,
  FlowRef: C.FlowRef,
  VfxEmitter: C.VfxEmitter,
  AudioEmitter: C.AudioEmitter,
  BodyConfig: C.BodyConfig,
  PathRequest: C.PathRequest,
  PathState: C.PathState,
  NavAgent: C.NavAgent,
  AssetRef: C.AssetRef,
  Locomotion: C.Locomotion,
  Appearance: C.Appearance,
  Action: C.Action,
};

const positioned = defineQuery([C.Transform]);

export interface FindResult {
  /** Entities that matched, before the cap. */
  total: number;
  /** One line per shown match: `<wire id> <label>`. */
  lines: string[];
}

/** Search the live world; `creatureName` reads a creature's kind or name (undefined: none). */
export function findEntities(world: SimWorld, query: string, creatureName?: (e: number) => string | undefined): FindResult {
  const q = query.toLowerCase();
  const compName = Object.keys(COMPONENTS).find((k) => k.toLowerCase() === q);
  const lines: string[] = [];
  let total = 0;
  for (const eid of positioned(world.ecs)) {
    const e = eid as number;
    const wire = world.wireId(e).toString();
    const name = creatureName?.(e);
    const idHit = wire.startsWith(query);
    const compHit = compName !== undefined && hasComponent(world.ecs, COMPONENTS[compName] as never, e);
    const nameHit = name !== undefined && name.toLowerCase().includes(q);
    if (!idHit && !compHit && !nameHit) continue;
    total++;
    if (lines.length < FIND_LIMIT) lines.push(`${wire}${name !== undefined ? ` ${name}` : ""}`);
  }
  return { total, lines };
}
