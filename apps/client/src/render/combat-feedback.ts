/**
 * Hit feedback (roadmap U12a): what the combat messages leave for the
 * frame loop. The mirror's events write it; the frame loop reads it (the
 * entity layer flashes struck bodies, the target frame follows `target`).
 * Plain mutable state, not React state: hits arrive many times a second.
 */

import type { HitMessage, LifeMessage } from "@mmo-engine/protocol";

/** How long a struck body glows red, seconds. */
export const FLASH_SECONDS = 0.15;

export class CombatFeedback {
  /** The entity the target frame shows (null: none). */
  target: bigint | null = null;
  /** Wire id -> when its hit flash ends (performance.now() seconds). */
  readonly flashUntil = new Map<bigint, number>();

  /**
   * A blow landed. Hits and blocks flash the target; a blow between the
   * player and anything makes that other party the target.
   */
  hit(h: HitMessage, player: bigint | null, now = performance.now() / 1000): void {
    const source = BigInt(h.source);
    const target = BigInt(h.target);
    if (h.outcome !== "dodged") this.flashUntil.set(target, now + FLASH_SECONDS);
    if (player === null) return;
    if (source === player && target !== player) this.target = target;
    else if (target === player && source !== player && this.target === null) this.target = source;
  }

  /** Life changes: a corpse stays targeted (it shows 0 hp) until it is gone. */
  life(l: LifeMessage): void {
    if (l.state === "alive") this.flashUntil.delete(BigInt(l.target));
  }

  /** Select (or, with null, clear) the target by hand. */
  select(wid: bigint | null): void {
    this.target = wid;
  }

  /** Forget what no longer exists (expired flashes, a despawned target). */
  prune(exists: (wid: bigint) => boolean, now = performance.now() / 1000): void {
    for (const [wid, until] of this.flashUntil) if (until <= now) this.flashUntil.delete(wid);
    if (this.target !== null && !exists(this.target)) this.target = null;
  }
}
