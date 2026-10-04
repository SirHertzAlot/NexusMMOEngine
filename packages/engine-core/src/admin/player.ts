/**
 * Player tweaks (roadmap A4, first slice): teleport, heal, and flight
 * for the admin console. These are convenience covers over the same
 * stores `set` writes — teleport snaps ground height and stills
 * velocity (no flings), heal fills from max, fly flips the Fly ability
 * bit (and lands the avatar when revoked mid-air is left to gravity).
 *
 * Heal also makes the body whole (M2), and the gateway fills the mana pool
 * with it. God-mode waits for damage to exist (M2/M3), and time/weather for
 * a runtime clock design — both noted in the roadmap row rather than faked here.
 */

import { hasComponent } from "bitecs";
import { z } from "zod";
import { Ability } from "@mmo-engine/protocol";
import { restoreBody } from "../body.js";
import * as C from "../components.js";
import type { SimWorld } from "../world.js";

export const TeleportArgsSchema = z
  .object({
    entity: z.string().min(1).max(32).default("me"),
    x: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

export type TeleportArgs = z.infer<typeof TeleportArgsSchema>;

export const HealArgsSchema = z
  .object({
    entity: z.string().min(1).max(32).default("me"),
  })
  .strict();

export type HealArgs = z.infer<typeof HealArgsSchema>;

/** `injure {part, kind?, amount?, entity?}` (M3): a blow on one body part, for testing injuries. */
export const InjureArgsSchema = z
  .object({
    entity: z.string().min(1).max(32).default("me"),
    part: z.string().min(1).max(32),
    kind: z.enum(["cut", "blunt", "thrust"]).default("cut"),
    /** Health points; default: the part's whole health (a cut that severs it). */
    amount: z.number().finite().positive().max(100000).optional(),
  })
  .strict();

/** `skill {id, value, entity?}` (M4): set a skill (its peak rises with it), for testing disciplines. */
export const SkillArgsSchema = z
  .object({
    entity: z.string().min(1).max(32).default("me"),
    id: z.string().min(1).max(32),
    value: z.number().finite().min(0).max(100000),
  })
  .strict();

export const FlyArgsSchema = z
  .object({
    entity: z.string().min(1).max(32).default("me"),
    on: z.boolean(),
  })
  .strict();

export type FlyArgs = z.infer<typeof FlyArgsSchema>;

/** Move the entity to (x, z): ground snap + stilled velocity. Pure sim write. */
export function applyTeleport(
  world: SimWorld,
  wireId: bigint,
  x: number,
  z: number,
  groundY: number | null,
): { ok: boolean; message: string } {
  const eid = world.resolveWireId(wireId);
  if (eid < 0 || !hasComponent(world.ecs, C.Transform, eid)) {
    return { ok: false, message: `unknown entity ${wireId}` };
  }
  C.Transform.px[eid] = x;
  C.Transform.pz[eid] = z;
  C.Transform.py[eid] = groundY ?? C.Transform.py[eid];
  if (hasComponent(world.ecs, C.Velocity, eid)) {
    C.Velocity.lx[eid] = 0; C.Velocity.ly[eid] = 0; C.Velocity.lz[eid] = 0;
    C.Velocity.ax[eid] = 0; C.Velocity.ay[eid] = 0; C.Velocity.az[eid] = 0;
  }
  return { ok: true, message: `teleported ${wireId} to ${x} ${z}` };
}

/** Fill Health from its max. */
export function applyHeal(world: SimWorld, wireId: bigint): { ok: boolean; message: string } {
  const eid = world.resolveWireId(wireId);
  if (eid < 0 || !hasComponent(world.ecs, C.Health, eid)) {
    return { ok: false, message: `entity ${wireId} has no Health` };
  }
  // Injuries too (M2): lost parts back, wounds closed, blood full.
  restoreBody(world, eid);
  C.Health.current[eid] = C.Health.max[eid];
  return { ok: true, message: `healed ${wireId} to ${C.Health.max[eid]}` };
}

/** Grant or revoke flight (the Fly ability bit). */
export function applyFly(world: SimWorld, wireId: bigint, on: boolean): { ok: boolean; message: string } {
  const eid = world.resolveWireId(wireId);
  if (eid < 0 || !hasComponent(world.ecs, C.Locomotion, eid)) {
    return { ok: false, message: `entity ${wireId} has no Locomotion` };
  }
  const abs = C.Locomotion.abilities[eid];
  C.Locomotion.abilities[eid] = on ? abs | Ability.Fly : abs & ~Ability.Fly;
  return { ok: true, message: `flight ${on ? "granted to" : "revoked from"} ${wireId}` };
}
