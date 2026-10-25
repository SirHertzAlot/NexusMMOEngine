/**
 * Field writes (roadmap A2, write path): set one numeric component field
 * on one entity, for the admin console. This is the running-game editor
 * the roadmap §1b describes — direct writes bypass sim validation and
 * ownership by construction, so every write lands in the command log
 * (the gateway logs all answered admin commands).
 *
 * Only numeric SoA fields; Appearance stays out (look ids are resolved
 * through the world's look table — A6 owns appearance editing). Integer
 * stores reject non-integers; every value must be finite.
 */

import { hasComponent } from "bitecs";
import { z } from "zod";
import * as C from "../components.js";
import type { SimWorld } from "../world.js";

export const SetArgsSchema = z
  .object({
    entity: z.string().min(1).max(32),
    component: z.string().min(1).max(32),
    field: z.string().min(1).max(32),
    value: z.number(),
  })
  .strict();

export type SetArgs = z.infer<typeof SetArgsSchema>;

/** Writable numeric field stores per component (explicit whitelist). */
const FIELDS: Record<
  string,
  { comp: Parameters<typeof hasComponent>[1]; store: Record<string, { [eid: number]: number }>; fields: Record<string, "int" | "float"> }
> = {
  Transform: {
    comp: C.Transform,
    store: C.Transform as unknown as Record<string, { [eid: number]: number }>,
    fields: { px: "float", py: "float", pz: "float", qx: "float", qy: "float", qz: "float", qw: "float", sx: "float", sy: "float", sz: "float" },
  },
  Velocity: {
    comp: C.Velocity,
    store: C.Velocity as unknown as Record<string, { [eid: number]: number }>,
    fields: { lx: "float", ly: "float", lz: "float", ax: "float", ay: "float", az: "float" },
  },
  PlayerIntent: {
    comp: C.PlayerIntent,
    store: C.PlayerIntent as unknown as Record<string, { [eid: number]: number }>,
    fields: { mx: "float", my: "float", mz: "float", lookYaw: "float", lookPitch: "float", jump: "int", buttons: "int" },
  },
  Health: {
    comp: C.Health,
    store: C.Health as unknown as Record<string, { [eid: number]: number }>,
    fields: { current: "float", max: "float" },
  },
  Stamina: {
    comp: C.Stamina,
    store: C.Stamina as unknown as Record<string, { [eid: number]: number }>,
    fields: { current: "float", max: "float" },
  },
  CharacterRef: {
    comp: C.CharacterRef,
    store: C.CharacterRef as unknown as Record<string, { [eid: number]: number }>,
    fields: { idHi: "int", idLo: "int" },
  },
  FlowRef: {
    comp: C.FlowRef,
    store: C.FlowRef as unknown as Record<string, { [eid: number]: number }>,
    fields: { graph: "int", enabled: "int" },
  },
  VfxEmitter: {
    comp: C.VfxEmitter,
    store: C.VfxEmitter as unknown as Record<string, { [eid: number]: number }>,
    fields: { template: "int", intensity: "float" },
  },
  AudioEmitter: {
    comp: C.AudioEmitter,
    store: C.AudioEmitter as unknown as Record<string, { [eid: number]: number }>,
    fields: { clip: "int", radius: "float" },
  },
  BodyConfig: {
    comp: C.BodyConfig,
    store: C.BodyConfig as unknown as Record<string, { [eid: number]: number }>,
    fields: { shapeKind: "int", halfX: "float", halfY: "float", halfZ: "float", radius: "float", mass: "float", motionType: "int", layer: "int", friction: "float", restitution: "float" },
  },
  PathRequest: {
    comp: C.PathRequest,
    store: C.PathRequest as unknown as Record<string, { [eid: number]: number }>,
    fields: { x: "float", z: "float", profile: "int", token: "int" },
  },
  PathState: {
    comp: C.PathState,
    store: C.PathState as unknown as Record<string, { [eid: number]: number }>,
    fields: { status: "int", token: "int", waypointOffset: "int", waypointCount: "int" },
  },
  NavAgent: {
    comp: C.NavAgent,
    store: C.NavAgent as unknown as Record<string, { [eid: number]: number }>,
    fields: { tx: "float", ty: "float", tz: "float", seq: "int", speed: "float", state: "int" },
  },
  AssetRef: {
    comp: C.AssetRef,
    store: C.AssetRef as unknown as Record<string, { [eid: number]: number }>,
    fields: { assetHash: "int", variant: "int" },
  },
  Locomotion: {
    comp: C.Locomotion,
    store: C.Locomotion as unknown as Record<string, { [eid: number]: number }>,
    fields: { mode: "int", abilities: "int", breath: "float" },
  },
  Action: {
    comp: C.Action,
    store: C.Action as unknown as Record<string, { [eid: number]: number }>,
    fields: { move: "int", started: "int", seq: "int", yaw: "float" },
  },
};

/**
 * Write one field. Returns the confirmation line, or an error message
 * (never throws for bad input — the gateway answers 4003 with it).
 */
export function applySet(world: SimWorld, wireId: bigint, component: string, field: string, value: number): { ok: boolean; message: string } {
  const eid = world.resolveWireId(wireId);
  if (eid < 0) return { ok: false, message: `unknown entity ${wireId}` };
  const comp = FIELDS[component];
  if (!comp) return { ok: false, message: `unknown component ${JSON.stringify(component)}` };
  const kind = comp.fields[field];
  if (!kind) return { ok: false, message: `unknown field ${JSON.stringify(field)} on ${component}` };
  if (!Number.isFinite(value)) return { ok: false, message: "value is not finite" };
  if (kind === "int" && !Number.isInteger(value)) {
    return { ok: false, message: `${component}.${field} is an integer store` };
  }
  // Component presence is checked against the live world, not the table:
  // an entity without the component reads as absent, never as zeros.
  if (!hasComponent(world.ecs, comp.comp, eid)) {
    return { ok: false, message: `entity ${wireId} has no ${component}` };
  }
  comp.store[field][eid] = value;
  return { ok: true, message: `${component}.${field} = ${value} on ${wireId}` };
}
