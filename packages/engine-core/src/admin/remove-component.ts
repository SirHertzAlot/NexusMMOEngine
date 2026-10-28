/**
 * Component removal (viewport authoring): take one component off one
 * entity, live. This is the inverse of `addcomponent` — the write the
 * authoring layer needs to UNBIND what a shelf add established (the
 * flow widget's unbind removes FlowRef; emitter unbinds remove
 * VfxEmitter / AudioEmitter).
 *
 * The removal rides the normal ECS path — bitECS removeComponent on
 * the live world — so queries, systems and `inspect` stop seeing the
 * component exactly as if the entity had never had it. No guard set
 * beyond the two named refusals below: the engine's systems select by
 * component presence (defineQuery) and its registration-driven
 * subsystems (nav obstacles, physics bodies) subscribe to enter/exit
 * queries, so a removal is a normal ECS event the codebase already
 * handles — despawn itself removes every component through this same
 * path. Like `set` and `addcomponent`, this is an admin power tool:
 * direct writes bypass sim validation and ownership by construction,
 * and every answered admin command lands in the command log.
 *
 * Refusals: unknown entity, unknown component, component absent, and
 * the two session toggles — God and Noclip stay with their own
 * commands (`god` / `noclip`), which own the session-facing side of
 * those states, exactly as `addcomponent` leaves the tags to them.
 */

import { hasComponent, removeComponent } from "bitecs";
import { z } from "zod";
import * as C from "../components.js";
import type { SimWorld } from "../world.js";

export const RemoveComponentArgsSchema = z
  .object({
    entity: z.string().min(1).max(32),
    component: z.string().min(1).max(32),
  })
  .strict();

export type RemoveComponentArgs = z.infer<typeof RemoveComponentArgsSchema>;

type Comp = Parameters<typeof hasComponent>[1];

/** Every component the registry defines, by name — the "unknown component" check (same names as add-component's). */
const REGISTRY: Record<string, Comp> = {
  Transform: C.Transform,
  Velocity: C.Velocity,
  PlayerIntent: C.PlayerIntent,
  Chunk: C.Chunk,
  Health: C.Health,
  Stamina: C.Stamina,
  Needs: C.Needs,
  God: C.God,
  Breakable: C.Breakable,
  Noclip: C.Noclip,
  BodyConfig: C.BodyConfig,
  PathRequest: C.PathRequest,
  PathState: C.PathState,
  NavAgent: C.NavAgent,
  AssetRef: C.AssetRef,
  Locomotion: C.Locomotion,
  Appearance: C.Appearance,
  Action: C.Action,
  CharacterRef: C.CharacterRef,
  WorldItem: C.WorldItem,
  Animation: C.Animation,
  FlowRef: C.FlowRef,
  VfxEmitter: C.VfxEmitter,
  AudioEmitter: C.AudioEmitter,
};

/** Component names an admin may remove, in registry order. */
export const REMOVABLE_COMPONENTS: readonly string[] = Object.keys(REGISTRY).filter((n) => n !== "God" && n !== "Noclip");

/** Tags whose state is owned by a dedicated toggle command — removal refuses and names it. */
const TOGGLE_OWNED: Readonly<Record<string, string>> = {
  God: "god",
  Noclip: "noclip",
};

/**
 * Remove one component from one entity. Returns the confirmation line,
 * or an error message (never throws for bad input — the gateway
 * answers 4003 with it).
 */
export function applyRemoveComponent(world: SimWorld, wireId: bigint, component: string): { ok: boolean; message: string } {
  const eid = world.resolveWireId(wireId);
  if (eid < 0) return { ok: false, message: `unknown entity ${wireId}` };
  const comp = REGISTRY[component];
  if (!comp) return { ok: false, message: `unknown component ${JSON.stringify(component)}` };
  const toggle = TOGGLE_OWNED[component];
  if (toggle !== undefined) {
    return { ok: false, message: `${component} is owned by the "${toggle}" toggle command — remove it there, not with removecomponent` };
  }
  if (!hasComponent(world.ecs, comp, eid)) {
    return { ok: false, message: `entity ${wireId} has no ${component}` };
  }
  removeComponent(world.ecs, comp, eid);
  return { ok: true, message: `${component} removed from ${wireId}` };
}
