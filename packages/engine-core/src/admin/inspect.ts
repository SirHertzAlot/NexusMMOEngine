/**
 * Entity inspector (roadmap A2, read path & Graphify H4 live overlay):
 * projects one entity's components for both the admin `inspect` text dump
 * and the selection-scoped H4 JSON overlay. Pure read — it never mutates
 * component stores, and unknown/recycled entities return null instead of
 * throwing.
 */

import { hasComponent } from "bitecs";
import { z } from "zod";
import * as C from "../components.js";
import { joinU64 } from "../components.js";
import { Body, Injury, Mana } from "../components.js";
import type { SimWorld } from "../world.js";

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Args for `inspect`: the entity to dump, as a decimal u64 wire id —
 * or "me" for the caller's own player entity.
 */
export const InspectArgsSchema = z
  .object({
    entity: z.string().min(1).max(32),
    format: z.enum(["text", "json"]).optional(),
  })
  .strict();

export type InspectArgs = z.infer<typeof InspectArgsSchema>;

export interface ProjectedField {
  name: string;
  value: unknown;
}

export interface ProjectedComponent {
  component: string;
  tag?: boolean;
  /** Exact human-readable line emitted by text `inspect` (omitted for extra H4-only rows). */
  textLine?: string;
  fields: ProjectedField[];
}

/**
 * Shared component projection for one entity slot.
 * Both `inspectEntity` (text) and `projectEntityOverlay` (H4 JSON) read from
 * this single projection so values and rounding stay identical.
 */
export function projectEntityComponents(world: SimWorld, eid: number): ProjectedComponent[] {
  const ecs = world.ecs;
  const out: ProjectedComponent[] = [];

  if (hasComponent(ecs, C.Transform, eid)) {
    const T = C.Transform;
    const px = r2(T.px[eid]);
    const py = r2(T.py[eid]);
    const pz = r2(T.pz[eid]);
    const qx = r2(T.qx[eid]);
    const qy = r2(T.qy[eid]);
    const qz = r2(T.qz[eid]);
    const qw = r2(T.qw[eid]);
    out.push({
      component: "Transform",
      textLine: `Transform: pos ${px} ${py} ${pz} rot ${qx} ${qy} ${qz} ${qw}`,
      fields: [
        { name: "px", value: px },
        { name: "py", value: py },
        { name: "pz", value: pz },
        { name: "qx", value: qx },
        { name: "qy", value: qy },
        { name: "qz", value: qz },
        { name: "qw", value: qw },
        { name: "sx", value: r2(T.sx[eid]) },
        { name: "sy", value: r2(T.sy[eid]) },
        { name: "sz", value: r2(T.sz[eid]) },
      ],
    });
  }

  if (hasComponent(ecs, C.Velocity, eid)) {
    const V = C.Velocity;
    const lx = r2(V.lx[eid]);
    const ly = r2(V.ly[eid]);
    const lz = r2(V.lz[eid]);
    out.push({
      component: "Velocity",
      textLine: `Velocity: lin ${lx} ${ly} ${lz}`,
      fields: [
        { name: "lx", value: lx },
        { name: "ly", value: ly },
        { name: "lz", value: lz },
        { name: "ax", value: r2(V.ax[eid]) },
        { name: "ay", value: r2(V.ay[eid]) },
        { name: "az", value: r2(V.az[eid]) },
      ],
    });
  }

  if (hasComponent(ecs, C.PlayerIntent, eid)) {
    const I = C.PlayerIntent;
    const mx = r2(I.mx[eid]);
    const my = r2(I.my[eid]);
    const mz = r2(I.mz[eid]);
    const lookYaw = r2(I.lookYaw[eid]);
    const lookPitch = r2(I.lookPitch[eid]);
    const jump = I.jump[eid];
    const buttons = I.buttons[eid];
    out.push({
      component: "PlayerIntent",
      textLine: `PlayerIntent: move ${mx} ${my} ${mz} look ${lookYaw} ${lookPitch} jump ${jump} buttons ${buttons}`,
      fields: [
        { name: "mx", value: mx },
        { name: "my", value: my },
        { name: "mz", value: mz },
        { name: "lookYaw", value: lookYaw },
        { name: "lookPitch", value: lookPitch },
        { name: "jump", value: jump },
        { name: "buttons", value: buttons },
      ],
    });
  }

  if (hasComponent(ecs, C.Chunk, eid)) {
    const K = C.Chunk;
    const id = joinU64(K.chunkIdHi[eid], K.chunkIdLo[eid]).toString();
    const seed = joinU64(K.seedHi[eid], K.seedLo[eid]).toString();
    const lod = K.lod[eid];
    out.push({
      component: "Chunk",
      textLine: `Chunk: id ${id} lod ${lod}`,
      fields: [
        { name: "chunkIdHi", value: K.chunkIdHi[eid] },
        { name: "chunkIdLo", value: K.chunkIdLo[eid] },
        { name: "seed", value: seed },
        { name: "lod", value: lod },
      ],
    });
  }

  if (hasComponent(ecs, C.Health, eid)) {
    const current = r2(C.Health.current[eid]);
    const max = r2(C.Health.max[eid]);
    out.push({
      component: "Health",
      textLine: `Health: ${current}/${max}`,
      fields: [
        { name: "current", value: current },
        { name: "max", value: max },
      ],
    });
  }

  if (hasComponent(ecs, C.Stamina, eid)) {
    const current = r2(C.Stamina.current[eid]);
    const max = r2(C.Stamina.max[eid]);
    out.push({
      component: "Stamina",
      textLine: `Stamina: ${current}/${max}`,
      fields: [
        { name: "current", value: current },
        { name: "max", value: max },
      ],
    });
  }

  if (hasComponent(ecs, Mana, eid)) {
    out.push({
      component: "Mana",
      fields: [
        { name: "current", value: r2(Mana.current[eid]) },
        { name: "max", value: r2(Mana.max[eid]) },
      ],
    });
  }

  if (hasComponent(ecs, C.Needs, eid)) {
    const N = C.Needs;
    const hunger = r2(N.hunger[eid]);
    const hungerMax = r2(N.hungerMax[eid]);
    const thirst = r2(N.thirst[eid]);
    const thirstMax = r2(N.thirstMax[eid]);
    out.push({
      component: "Needs",
      textLine: `Needs: hunger ${hunger}/${hungerMax} thirst ${thirst}/${thirstMax}`,
      fields: [
        { name: "hunger", value: hunger },
        { name: "hungerMax", value: hungerMax },
        { name: "thirst", value: thirst },
        { name: "thirstMax", value: thirstMax },
      ],
    });
  }

  if (hasComponent(ecs, C.CharacterRef, eid)) {
    const character = joinU64(C.CharacterRef.idHi[eid], C.CharacterRef.idLo[eid]).toString();
    out.push({
      component: "CharacterRef",
      textLine: `CharacterRef: character ${character}`,
      fields: [
        { name: "idHi", value: C.CharacterRef.idHi[eid] },
        { name: "idLo", value: C.CharacterRef.idLo[eid] },
      ],
    });
  }

  if (hasComponent(ecs, C.FlowRef, eid)) {
    const graph = C.FlowRef.graph[eid];
    const enabled = C.FlowRef.enabled[eid];
    out.push({
      component: "FlowRef",
      textLine: `FlowRef: graph ${graph} enabled ${enabled}`,
      fields: [
        { name: "graph", value: graph },
        { name: "enabled", value: enabled },
      ],
    });
  }

  if (hasComponent(ecs, C.VfxEmitter, eid)) {
    const template = C.VfxEmitter.template[eid];
    const intensity = r2(C.VfxEmitter.intensity[eid]);
    out.push({
      component: "VfxEmitter",
      textLine: `VfxEmitter: template ${template} intensity ${intensity}`,
      fields: [
        { name: "template", value: template },
        { name: "intensity", value: intensity },
      ],
    });
  }

  if (hasComponent(ecs, C.AudioEmitter, eid)) {
    const clip = C.AudioEmitter.clip[eid];
    const radius = r2(C.AudioEmitter.radius[eid]);
    out.push({
      component: "AudioEmitter",
      textLine: `AudioEmitter: clip ${clip} radius ${radius}`,
      fields: [
        { name: "clip", value: clip },
        { name: "radius", value: radius },
      ],
    });
  }

  if (hasComponent(ecs, C.BodyConfig, eid)) {
    const B = C.BodyConfig;
    const shapeKind = B.shapeKind[eid];
    const motionType = B.motionType[eid];
    const mass = r2(B.mass[eid]);
    out.push({
      component: "BodyConfig",
      textLine: `BodyConfig: shape ${shapeKind} motion ${motionType} mass ${mass}`,
      fields: [
        { name: "shapeKind", value: shapeKind },
        { name: "motionType", value: motionType },
        { name: "mass", value: mass },
        { name: "halfX", value: r2(B.halfX[eid]) },
        { name: "halfY", value: r2(B.halfY[eid]) },
        { name: "halfZ", value: r2(B.halfZ[eid]) },
        { name: "radius", value: r2(B.radius[eid]) },
        { name: "layer", value: B.layer[eid] },
        { name: "friction", value: r2(B.friction[eid]) },
        { name: "restitution", value: r2(B.restitution[eid]) },
      ],
    });
  }

  if (hasComponent(ecs, C.PathRequest, eid)) {
    const P = C.PathRequest;
    const x = r2(P.x[eid]);
    const z = r2(P.z[eid]);
    const profile = P.profile[eid];
    const token = P.token[eid];
    out.push({
      component: "PathRequest",
      textLine: `PathRequest: to ${x} ${z} profile ${profile} token ${token}`,
      fields: [
        { name: "x", value: x },
        { name: "z", value: z },
        { name: "profile", value: profile },
        { name: "token", value: token },
      ],
    });
  }

  if (hasComponent(ecs, C.PathState, eid)) {
    const P = C.PathState;
    const status = P.status[eid];
    const token = P.token[eid];
    const waypointCount = P.waypointCount[eid];
    out.push({
      component: "PathState",
      textLine: `PathState: status ${status} token ${token} waypoints ${waypointCount}`,
      fields: [
        { name: "status", value: status },
        { name: "token", value: token },
        { name: "waypointCount", value: waypointCount },
        { name: "waypointOffset", value: P.waypointOffset[eid] },
      ],
    });
  }

  if (hasComponent(ecs, C.NavAgent, eid)) {
    const N = C.NavAgent;
    const tx = r2(N.tx[eid]);
    const ty = r2(N.ty[eid]);
    const tz = r2(N.tz[eid]);
    const state = N.state[eid];
    out.push({
      component: "NavAgent",
      textLine: `NavAgent: target ${tx} ${ty} ${tz} state ${state}`,
      fields: [
        { name: "tx", value: tx },
        { name: "ty", value: ty },
        { name: "tz", value: tz },
        { name: "state", value: state },
        { name: "speed", value: r2(N.speed[eid]) },
        { name: "seq", value: N.seq[eid] },
      ],
    });
  }

  if (hasComponent(ecs, C.AssetRef, eid)) {
    const assetHash = C.AssetRef.assetHash[eid];
    const variant = C.AssetRef.variant[eid];
    out.push({
      component: "AssetRef",
      textLine: `AssetRef: hash ${assetHash} variant ${variant}`,
      fields: [
        { name: "assetHash", value: assetHash },
        { name: "variant", value: variant },
      ],
    });
  }

  if (hasComponent(ecs, C.Locomotion, eid)) {
    const L = C.Locomotion;
    const mode = L.mode[eid];
    const abilities = L.abilities[eid];
    const breath = r2(L.breath[eid]);
    out.push({
      component: "Locomotion",
      textLine: `Locomotion: mode ${mode} abilities ${abilities} breath ${breath}`,
      fields: [
        { name: "mode", value: mode },
        { name: "abilities", value: abilities },
        { name: "breath", value: breath },
      ],
    });
  }

  if (hasComponent(ecs, C.Appearance, eid)) {
    const look = C.Appearance.look[eid];
    const lookJson = world.lookJson(look);
    out.push({
      component: "Appearance",
      textLine: `Appearance: look ${look} ${lookJson}`,
      fields: [
        { name: "look", value: look },
        ...(lookJson ? [{ name: "lookJson", value: lookJson }] : []),
      ],
    });
  }

  if (hasComponent(ecs, C.Action, eid)) {
    const move = C.Action.move[eid];
    const started = C.Action.started[eid];
    const seq = C.Action.seq[eid];
    out.push({
      component: "Action",
      textLine: `Action: move ${move} started ${started} seq ${seq}`,
      fields: [
        { name: "move", value: move },
        { name: "started", value: started },
        { name: "seq", value: seq },
        { name: "yaw", value: r2(C.Action.yaw[eid]) },
      ],
    });
  }

  if (hasComponent(ecs, C.Animation, eid)) {
    const A = C.Animation;
    out.push({
      component: "Animation",
      fields: [
        { name: "clipId", value: A.clipId[eid] },
        { name: "startTick", value: A.startTick[eid] },
        { name: "rate", value: r2(A.rate[eid]) },
        { name: "layerMask", value: A.layerMask[eid] },
      ],
    });
  }

  if (hasComponent(ecs, C.WorldItem, eid)) {
    const W = C.WorldItem;
    out.push({
      component: "WorldItem",
      fields: [
        { name: "item", value: W.item[eid] },
        { name: "owner", value: W.owner[eid] },
        { name: "ownedUntil", value: W.ownedUntil[eid] },
        { name: "despawnAt", value: W.despawnAt[eid] },
      ],
    });
  }

  if (hasComponent(ecs, Body, eid)) {
    out.push({
      component: "Body",
      fields: [
        { name: "blood", value: r2(Body.blood[eid]) },
        { name: "bloodMax", value: r2(Body.bloodMax[eid]) },
        { name: "seen", value: r2(Body.seen[eid]) },
        { name: "lost", value: Body.lost[eid] },
      ],
    });
  }

  if (hasComponent(ecs, Injury, eid)) {
    out.push({
      component: "Injury",
      fields: [
        { name: "bits", value: Injury.bits[eid] },
        { name: "move", value: r2(Injury.move[eid]) },
        { name: "stamina", value: r2(Injury.stamina[eid]) },
        { name: "flags", value: Injury.flags[eid] },
      ],
    });
  }

  if (hasComponent(ecs, C.God, eid)) out.push({ component: "God", tag: true, fields: [] });
  if (hasComponent(ecs, C.Breakable, eid)) out.push({ component: "Breakable", tag: true, fields: [] });
  if (hasComponent(ecs, C.Noclip, eid)) out.push({ component: "Noclip", tag: true, fields: [] });
  if (hasComponent(ecs, C.FarVisible, eid)) out.push({ component: "FarVisible", tag: true, fields: [] });

  if (world.stats.has(eid)) {
    const sheet = world.stats.sheet(eid);
    if (sheet) {
      out.push({
        component: "Stat",
        textLine: `Stats: ${sheet.map((l) => `${l.id}=${r2(l.value)}`).join(" ")}`,
        fields: sheet.map((l) => ({ name: l.id, value: r2(l.value) })),
      });
    }
  }

  return out;
}

/** Dump one entity's components; null when the wire id resolves nowhere. */
export function inspectEntity(world: SimWorld, wireId: bigint): string | null {
  const eid = world.resolveWireId(wireId);
  if (eid < 0) return null;
  const lines = [`entity ${wireId} (slot ${eid})`];
  for (const c of projectEntityComponents(world, eid)) {
    if (c.textLine !== undefined) lines.push(c.textLine);
  }
  return lines.join("\n");
}
