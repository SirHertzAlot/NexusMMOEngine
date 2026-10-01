/**
 * Entity inspector (roadmap A2, read path): a text dump of every
 * component on one entity, for the admin console. Pure read — it never
 * touches component stores, and unknown/recycled entities read as
 * "unknown entity" instead of throwing.
 *
 * Numbers print short (2 decimals); u64 ids print decimal. The dump is
 * sized for the JSON control plane (a few hundred bytes).
 */

import { hasComponent } from "bitecs";
import { z } from "zod";
import * as C from "../components.js";
import { joinU64 } from "../components.js";
import type { SimWorld } from "../world.js";

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Args for `inspect`: the entity to dump, as a decimal u64 wire id —
 * or "me" for the caller's own player entity.
 */
export const InspectArgsSchema = z
  .object({
    entity: z.string().min(1).max(32),
  })
  .strict();

export type InspectArgs = z.infer<typeof InspectArgsSchema>;

/** Dump one entity's components; null when the wire id resolves nowhere. */
export function inspectEntity(world: SimWorld, wireId: bigint): string | null {
  const eid = world.resolveWireId(wireId);
  if (eid < 0) return null;
  const ecs = world.ecs;
  const lines = [`entity ${wireId} (slot ${eid})`];
  if (hasComponent(ecs, C.Transform, eid)) {
    const T = C.Transform;
    lines.push(
      `Transform: pos ${r2(T.px[eid])} ${r2(T.py[eid])} ${r2(T.pz[eid])} rot ${r2(T.qx[eid])} ${r2(T.qy[eid])} ${r2(T.qz[eid])} ${r2(T.qw[eid])}`,
    );
  }
  if (hasComponent(ecs, C.Velocity, eid)) {
    const V = C.Velocity;
    lines.push(`Velocity: lin ${r2(V.lx[eid])} ${r2(V.ly[eid])} ${r2(V.lz[eid])}`);
  }
  if (hasComponent(ecs, C.PlayerIntent, eid)) {
    const I = C.PlayerIntent;
    lines.push(
      `PlayerIntent: move ${r2(I.mx[eid])} ${r2(I.my[eid])} ${r2(I.mz[eid])} look ${r2(I.lookYaw[eid])} ${r2(I.lookPitch[eid])} jump ${I.jump[eid]} buttons ${I.buttons[eid]}`,
    );
  }
  if (hasComponent(ecs, C.Chunk, eid)) {
    const K = C.Chunk;
    lines.push(`Chunk: id ${joinU64(K.chunkIdHi[eid], K.chunkIdLo[eid])} lod ${K.lod[eid]}`);
  }
  if (hasComponent(ecs, C.Health, eid)) {
    lines.push(`Health: ${r2(C.Health.current[eid])}/${r2(C.Health.max[eid])}`);
  }
  if (hasComponent(ecs, C.BodyConfig, eid)) {
    const B = C.BodyConfig;
    lines.push(`BodyConfig: shape ${B.shapeKind[eid]} motion ${B.motionType[eid]} mass ${r2(B.mass[eid])}`);
  }
  if (hasComponent(ecs, C.PathRequest, eid)) {
    const P = C.PathRequest;
    lines.push(`PathRequest: to ${r2(P.x[eid])} ${r2(P.z[eid])} profile ${P.profile[eid]} token ${P.token[eid]}`);
  }
  if (hasComponent(ecs, C.PathState, eid)) {
    const P = C.PathState;
    lines.push(`PathState: status ${P.status[eid]} token ${P.token[eid]} waypoints ${P.waypointCount[eid]}`);
  }
  if (hasComponent(ecs, C.NavAgent, eid)) {
    const N = C.NavAgent;
    lines.push(`NavAgent: target ${r2(N.tx[eid])} ${r2(N.ty[eid])} ${r2(N.tz[eid])} state ${N.state[eid]}`);
  }
  if (hasComponent(ecs, C.AssetRef, eid)) {
    lines.push(`AssetRef: hash ${C.AssetRef.assetHash[eid]} variant ${C.AssetRef.variant[eid]}`);
  }
  if (hasComponent(ecs, C.Locomotion, eid)) {
    const L = C.Locomotion;
    lines.push(`Locomotion: mode ${L.mode[eid]} abilities ${L.abilities[eid]} breath ${r2(L.breath[eid])}`);
  }
  if (hasComponent(ecs, C.Appearance, eid)) {
    lines.push(`Appearance: ${world.lookJson(C.Appearance.look[eid])}`);
  }
  if (hasComponent(ecs, C.Action, eid)) {
    lines.push(`Action: move ${C.Action.move[eid]} started ${C.Action.started[eid]} seq ${C.Action.seq[eid]}`);
  }
  if (world.stats.has(eid)) {
    const sheet = world.stats.sheet(eid);
    if (sheet) lines.push(`Stats: ${sheet.map((l) => `${l.id}=${r2(l.value)}`).join(" ")}`);
  }
  return lines.join("\n");
}
