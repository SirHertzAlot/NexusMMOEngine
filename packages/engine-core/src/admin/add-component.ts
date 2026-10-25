/**
 * Component addition (viewport authoring): give one entity a component
 * it does not have yet, initialised to that component's defaults. This
 * is the write `set` cannot do — applySet only writes numeric fields of
 * a component already present — and it is what the authoring add-shelf
 * dispatches ("Add combat", "Bind flow graph", …).
 *
 * The addable set is the DEFAULTS table below, and nothing else. Every
 * entry is derived from the component's own field schema in
 * components.ts: the table names every field of the component and the
 * value a fresh row starts with (a test asserts the field sets match
 * the live component objects, so the table cannot silently drift from
 * the registry). Values follow the engine's own spawn conventions
 * where they exist (bots spawn Health 100/100; a scene Collider is a
 * 0.5 static box with friction 0.8; Needs are full at spawn; Locomotion
 * breath 1 is full). Components whose rows are system-owned state with
 * no designer-meaningful default (PathState, NavAgent, WorldItem,
 * Chunk, Animation, Action, AssetRef, Appearance — the look table is
 * A6's) are NOT in the table and refuse as such; tag components
 * (God / Noclip / Breakable) carry no fields to default and stay with
 * their own commands.
 *
 * The add rides the normal ECS path — bitECS addComponent on the live
 * world, then every field written (never left at whatever a recycled
 * slot held) — so queries, systems and `inspect` see the component
 * exactly as if it had spawned with the entity.
 */

import { addComponent, hasComponent } from "bitecs";
import { z } from "zod";
import * as C from "../components.js";
import type { SimWorld } from "../world.js";

export const AddComponentArgsSchema = z
  .object({
    entity: z.string().min(1).max(32),
    component: z.string().min(1).max(32),
  })
  .strict();

export type AddComponentArgs = z.infer<typeof AddComponentArgsSchema>;

type Comp = Parameters<typeof hasComponent>[1];

/** Every component the registry defines, by name — the "unknown component" check. */
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

/**
 * The addable components and their fresh-row defaults: every field of
 * the component, named. Adding writes exactly these values.
 */
export const COMPONENT_DEFAULTS: Record<string, { comp: Comp; defaults: Record<string, number> }> = {
  Transform: {
    comp: C.Transform,
    defaults: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 },
  },
  Velocity: {
    comp: C.Velocity,
    defaults: { lx: 0, ly: 0, lz: 0, ax: 0, ay: 0, az: 0 },
  },
  PlayerIntent: {
    comp: C.PlayerIntent,
    defaults: { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: 0, buttons: 0 },
  },
  Health: {
    comp: C.Health,
    defaults: { current: 100, max: 100 },
  },
  Stamina: {
    comp: C.Stamina,
    defaults: { current: 100, max: 100 },
  },
  Needs: {
    comp: C.Needs,
    defaults: { hunger: 100, hungerMax: 100, thirst: 100, thirstMax: 100 },
  },
  BodyConfig: {
    // The scene Collider's own defaults (scene-spawn colliderOf): a
    // 0.5 box standing still; friction as the scatter spawner writes it.
    comp: C.BodyConfig,
    defaults: { shapeKind: 0, halfX: 0.5, halfY: 0.5, halfZ: 0.5, radius: 0.5, mass: 0, motionType: 0, layer: 0, friction: 0.8, restitution: 0 },
  },
  Locomotion: {
    comp: C.Locomotion,
    defaults: { mode: 0, abilities: 0, breath: 1 },
  },
  CharacterRef: {
    // 0 = unassigned; `set` can write a real character id afterwards.
    comp: C.CharacterRef,
    defaults: { idHi: 0, idLo: 0 },
  },
  FlowRef: {
    // graph 0 = no graph bound yet (the hash resolves through the
    // content index; 0 names nothing), enabled so binding a graph via
    // `set` is the only step left.
    comp: C.FlowRef,
    defaults: { graph: 0, enabled: 1 },
  },
  VfxEmitter: {
    // template 0 = no effect bound yet; intensity 1 = as authored.
    comp: C.VfxEmitter,
    defaults: { template: 0, intensity: 1 },
  },
  AudioEmitter: {
    // clip 0 = no event bound yet; radius 10 m is the admin default
    // audible range until `set` tunes it.
    comp: C.AudioEmitter,
    defaults: { clip: 0, radius: 10 },
  },
};

/** Names an admin may add, in registry order. */
export const ADDABLE_COMPONENTS: readonly string[] = Object.keys(COMPONENT_DEFAULTS);

/**
 * Add one component with its defaults. Returns the confirmation line,
 * or an error message (never throws for bad input — the gateway
 * answers 4003 with it).
 */
export function applyAddComponent(world: SimWorld, wireId: bigint, component: string): { ok: boolean; message: string } {
  const eid = world.resolveWireId(wireId);
  if (eid < 0) return { ok: false, message: `unknown entity ${wireId}` };
  const known = REGISTRY[component];
  if (!known) return { ok: false, message: `unknown component ${JSON.stringify(component)}` };
  const entry = COMPONENT_DEFAULTS[component];
  if (!entry) {
    return {
      ok: false,
      message: `${component} has no defined defaults, so it cannot be added — addable components are: ${ADDABLE_COMPONENTS.join(", ")}`,
    };
  }
  if (hasComponent(world.ecs, entry.comp, eid)) {
    return { ok: false, message: `entity ${wireId} already has ${component}` };
  }
  addComponent(world.ecs, entry.comp, eid);
  const store = entry.comp as unknown as Record<string, { [eid: number]: number }>;
  for (const [field, value] of Object.entries(entry.defaults)) store[field][eid] = value;
  const written = Object.entries(entry.defaults)
    .map(([f, v]) => `${f}=${v}`)
    .join(" ");
  return { ok: true, message: `${component} added to ${wireId} (${written})` };
}
