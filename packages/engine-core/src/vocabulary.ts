/**
 * The shared vocabulary: the few types the engine and a game's systems must
 * agree on, with no system behind them (roadmap ES5).
 *
 * A kit owns its systems; what it cannot own alone is the shape of what it
 * hands the rest of the world. `Weapon` is what a striker swings, and every
 * place that produces one — an item's definition, a creature's natural
 * weapon, a dungeon's loadout — has to describe it the same way as the
 * combat system that consumes it. `LifeEvent` is the same for a death: loot,
 * quests and a dungeon's run all react to one, none of them owning it.
 *
 * These lived in `combat.ts` and `death.ts`, which made nine files across
 * items, quests, dungeons and admin import a combat system's module to name
 * a type. Here they depend on the rules package and nothing else, so a kit
 * imports the vocabulary from the engine and the engine never imports the
 * kit — the direction the split needs.
 *
 * The same holds for what a system *announces*. A blow, an ability, a
 * telegraph, a status and a duel each end up on the wire, so the gateway has
 * to name their shapes — and while those shapes lived inside the systems,
 * naming one meant importing the system (`ES4c` left `net/ports.ts` doing
 * exactly that, as type imports). They are events, not behaviour: a game
 * that writes its own combat still raises hits the client can read, and a
 * game with no duels raises none. So they live here, and the systems that
 * raise them import them like everyone else.
 */

import type { DamageInput, DeathInput, DeathOutcome, PartState } from "@mmo-engine/rules";

/** What a striker swings: the rules technique, the item's physics and its reach (m). */
export interface Weapon {
  technique: string;
  item: DamageInput["item"];
  reach: number;
  /** The item family familiarity builds with (its base: "sword", "axe"); absent: none. */
  family?: string;
  /** Optional percentage of defender armour mitigation bypassed on hit (clamped 0..100). */
  armourPenetrationPct?: number;
  /** Optional percentage reduction of attack stamina drain (clamped 0..50). */
  staminaReductionPct?: number;
}

/** A death or a return, as the rest of the world hears about it. */
export interface LifeEvent {
  tick: number;
  target: number;
  state: "dead" | "alive";
  killer?: number;
  /** Tick the body respawns (dead events). */
  respawnAt?: number;
  outcome?: DeathOutcome;
  /** Where it fell (dead events). */
  x?: number;
  z?: number;
  /** What killed it (dead events). */
  cause?: DeathInput;
}

/* --- What a system announces (ES5b) --- */

/** A blow's outcome, for the gateway to tell clients. */
export interface HitEvent {
  tick: number;
  source: number;
  target: number;
  outcome: "hit" | "blocked" | "dodged";
  amount: number;
  /** With bodies: the part the blow landed on, its state after it, and the parts it cut off. */
  part?: string;
  state?: PartState;
  lost?: string[];
  /** A parry took the attacker's weapon (M4): what it holds in its main hand falls. */
  disarmed?: boolean;
}

/** How far a trigger got: fired now, queued behind the cast, or refused. */
export type TriggerResult = "fired" | "queued" | "rejected";

/** The states an ability passes through, as the client hears them. */
export type AbilityState = "casting" | "queued" | "fired" | "interrupted" | "rejected";

/** An ability's progress, for the gateway to tell clients. */
export interface AbilityEvent {
  tick: number;
  entity: number;
  id: string;
  state: AbilityState;
  /** Why a trigger was rejected ("cooldown", "unknown"). */
  reason?: string;
}

/** The ground an attack covers while it is telegraphed. */
export type TelegraphShape =
  | { kind: "circle"; x: number; z: number; r: number }
  | { kind: "cone"; x: number; z: number; yaw: number; range: number; halfAngle: number }
  | { kind: "rect"; x: number; z: number; yaw: number; length: number; width: number };

/** A telegraphed attack's warning, landing or cancellation. */
export interface TelegraphEvent {
  tick: number;
  id: number;
  source: number;
  shape: TelegraphShape;
  state: "warned" | "resolved" | "cancelled";
  /** Warned: ticks until it lands. Resolved: targets hit. */
  ticksUntilHit?: number;
  hits?: { target: number; amount: number }[];
}

/** A buff/debuff gained or lost, for the gateway. */
export interface StatusChange {
  tick: number;
  entity: number;
  id: string;
  state: "applied" | "removed";
  stacks?: number;
}

/** Why a duel ended. */
export type DuelEndReason = "blood" | "yield" | "timeout" | "declined" | "expired" | "cancelled";

/** A duel's progress, for the two fighters and anyone watching. */
export interface DuelEvent {
  tick: number;
  state: "challenged" | "accepted" | "declined" | "expired" | "started" | "ended";
  a: number;
  b: number;
  /** Ended: why. */
  reason?: DuelEndReason;
  /** Ended by blood/yield: the winner. */
  winner?: number;
}
