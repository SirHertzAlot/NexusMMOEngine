/**
 * The ports the region gateway reads, and what it asks of each.
 *
 * The gateway used to find these systems with `instanceof`, which meant a
 * value import of every class it looked for — `CombatSystem`, `DuelSystem`,
 * and so on. Those are the systems a game is most likely to replace, and the
 * ones the engine/game split moves into kits, so the import was the thing
 * standing between them and a package of their own.
 *
 * Here the gateway names what it needs instead. The table is the host's own
 * list — a game with its own entry point writes its own and uses none of
 * this — and each row carries the methods the gateway calls, so a system
 * that offers a port it cannot answer ends the boot rather than the tick.
 *
 * Most event payloads are still declared beside the systems that raise them
 * and imported here as types only, so nothing in this file reaches a system
 * at runtime. `LifeEvent` already moved to `vocabulary.ts` (`ES5a`); the
 * rest follow it, which is the step that lets the systems themselves move
 * out.
 */

import type { PortDecl } from "@mmo-engine/sdk";
import type { AbilityEvent, TriggerResult } from "../abilities.js";
import type { HitEvent } from "../combat.js";
import type { DuelEvent } from "../duel.js";
import type { StatusChange } from "../status.js";
import type { TelegraphEvent } from "../telegraph.js";
import type { LifeEvent } from "../vocabulary.js";

/** The blows struck this tick, and the stance a player fights in. */
export interface CombatPort {
  /** This tick's blows, cleared by the read (catalog 0x16). */
  drainHits(): HitEvent[];
  /** Set a fighter's technique and aim; returns the refusal, or `null`. */
  setStance(
    entity: number,
    technique: string | null | undefined,
    aim: string | null | undefined,
  ): string | null;
}

/** Deaths and respawns (catalog 0x17). */
export interface LifePort {
  drainEvents(): LifeEvent[];
}

/** Abilities a player triggers, and what became of them (catalog 0x1d). */
export interface AbilityPort {
  drainEvents(): AbilityEvent[];
  /** Ask for an ability; the outcome drains as an event next tick. */
  trigger(entity: number, id: string, tick: number): TriggerResult;
}

/** Telegraphed attacks: warning, resolution, cancellation (catalog 0x1e). */
export interface TelegraphPort {
  drainEvents(): TelegraphEvent[];
}

/** Buffs and debuffs applied or removed (catalog 0x1f). */
export interface StatusPort {
  drainChanges(): StatusChange[];
}

/** The duel flow a player drives from their client (catalog 0x20). */
export interface DuelPort {
  drainEvents(): DuelEvent[];
  challenge(a: number, b: number, tick: number): boolean;
  accept(entity: number, tick: number): boolean;
  decline(entity: number, tick: number): boolean;
  yield(entity: number, tick: number): boolean;
  /** Drop a leaver's duel and challenges (disconnect, logout, migration). */
  forget(entity: number, tick: number): void;
}

/** Every port the gateway reads, by the name a system offers it under. */
export interface GatewayPorts {
  combat: CombatPort;
  life: LifePort;
  abilities: AbilityPort;
  telegraphs: TelegraphPort;
  statuses: StatusPort;
  duels: DuelPort;
}

/**
 * One row per port, with the methods the gateway calls on it.
 *
 * Keep the method lists in step with the interfaces above: they are what the
 * boot checks, and a method the gateway starts calling without adding it
 * here is a method a half-finished provider can get away with not having.
 */
export const GATEWAY_PORTS: readonly PortDecl[] = [
  { key: "combat", methods: ["drainHits", "setStance"], what: "the blows struck this tick, and player stance" },
  { key: "life", methods: ["drainEvents"], what: "deaths and respawns" },
  { key: "abilities", methods: ["drainEvents", "trigger"], what: "abilities a player triggers" },
  { key: "telegraphs", methods: ["drainEvents"], what: "telegraphed attack warnings" },
  { key: "statuses", methods: ["drainChanges"], what: "buffs and debuffs" },
  {
    key: "duels",
    methods: ["drainEvents", "challenge", "accept", "decline", "yield", "forget"],
    what: "the duel flow",
  },
];
