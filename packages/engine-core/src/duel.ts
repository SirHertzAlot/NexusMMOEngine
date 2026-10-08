/**
 * DuelSystem — consensual PvP and the hostility query behind it.
 *
 * Flow: `challenge(a, b)` → `b` accepts or declines (challenges expire).
 * While dueled, the pair may hurt each other; everyone else may not
 * (see `canHit`, which CombatSystem consults before a blow lands). A duel
 * ends at first blood (a duelist's health hits 0 — the DeathSystem is told
 * it was a duel, so there is no death penalty), on yield, or on timeout.
 *
 * Beyond duels, `setHostile` lets events and GMs mark ad-hoc hostility
 * (a brawl pit, a faction war). The default is peace: strangers cannot
 * hurt each other through the combat path that consults this system.
 * Nothing here moves entities or touches Health — it is pure rules.
 */

export type DuelEndReason = "blood" | "yield" | "timeout" | "declined" | "expired" | "cancelled";

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

interface Challenge {
  a: number;
  b: number;
  expiresAt: number;
}

interface Duel {
  a: number;
  b: number;
  startedAt: number;
  endsAt: number;
}

const msToTicks = (ms: number, tickHz: number): number => Math.max(0, Math.round((ms / 1000) * tickHz));

export class DuelSystem {
  readonly name = "duel";
  /** Target -> challenge (one incoming challenge at a time; latest wins). */
  private readonly challenges = new Map<number, Challenge>();
  /** Entity -> its duel (both partners point at the same Duel). */
  private readonly duels = new Map<number, Duel>();
  /** Ad-hoc hostility pairs: "min-max" keys. */
  private readonly hostilePairs = new Set<string>();
  private events: DuelEvent[] = [];

  constructor(
    private readonly tickHz = 30,
    /** ms a challenge waits for an answer. */
    private readonly challengeMs = 30000,
    /** ms a duel may run before it is called a draw. */
    private readonly duelMs = 300000,
  ) {}

  private pairKey(a: number, b: number): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  /** `a` challenges `b` to a duel at `tick`. False when either is busy. */
  challenge(a: number, b: number, tick: number): boolean {
    if (a === b || this.duels.has(a) || this.duels.has(b)) return false;
    this.challenges.set(b, { a, b, expiresAt: tick + msToTicks(this.challengeMs, this.tickHz) });
    this.events.push({ tick, state: "challenged", a, b });
    return true;
  }

  /** `b` accepts the incoming challenge. */
  accept(b: number, tick: number): boolean {
    const c = this.challenges.get(b);
    if (!c || tick > c.expiresAt) return false;
    this.challenges.delete(b);
    const duel: Duel = { a: c.a, b: c.b, startedAt: tick, endsAt: tick + msToTicks(this.duelMs, this.tickHz) };
    this.duels.set(c.a, duel);
    this.duels.set(c.b, duel);
    this.events.push({ tick, state: "accepted", a: c.a, b: c.b });
    this.events.push({ tick, state: "started", a: c.a, b: c.b });
    return true;
  }

  /** `b` declines the incoming challenge. */
  decline(b: number, tick: number): boolean {
    const c = this.challenges.get(b);
    if (!c) return false;
    this.challenges.delete(b);
    this.events.push({ tick, state: "declined", a: c.a, b: c.b, reason: "declined" });
    return true;
  }

  /** `e` yields the duel it is in. */
  yield(e: number, tick: number): boolean {
    const d = this.duels.get(e);
    if (!d) return false;
    const winner = d.a === e ? d.b : d.a;
    this.endDuel(d, tick, "yield", winner);
    return true;
  }

  /**
   * After damage, the owner reports `e`'s health fraction; a duelist at
   * zero ends the duel by blood. Returns the winner, if the duel ended.
   */
  checkBlood(e: number, healthFraction: number, tick: number): number | undefined {
    const d = this.duels.get(e);
    if (!d || healthFraction > 0) return undefined;
    const winner = d.a === e ? d.b : d.a;
    this.endDuel(d, tick, "blood", winner);
    return winner;
  }

  /** Who `e` is dueling, if anyone. */
  opponent(e: number): number | undefined {
    const d = this.duels.get(e);
    if (!d) return undefined;
    return d.a === e ? d.b : d.a;
  }

  /** Whether `e` is in a duel at all. */
  inDuel(e: number): boolean {
    return this.duels.has(e);
  }

  /** Was this death in a duel (no death penalty)? */
  wasDuelDeath(e: number): boolean {
    return this.duels.has(e);
  }

  /** Mark or clear ad-hoc hostility (brawl pits, faction wars, GMs). */
  setHostile(a: number, b: number, hostile: boolean): void {
    const k = this.pairKey(a, b);
    if (hostile) this.hostilePairs.add(k);
    else this.hostilePairs.delete(k);
  }

  /**
   * May `a` hurt `b`? Duel opponents and hostile pairs may; everyone
   * else may not. CombatSystem consults this before a blow lands.
   */
  canHit(a: number, b: number): boolean {
    if (a === b) return false;
    const d = this.duels.get(a);
    if (d && (d.a === b || d.b === b)) return true;
    return this.hostilePairs.has(this.pairKey(a, b));
  }

  /** Forget `e` (despawn): drop challenges and end duels it was in. */
  forget(e: number, tick: number): void {
    this.challenges.delete(e);
    for (const [target, c] of this.challenges) {
      if (c.a === e) {
        this.challenges.delete(target);
        this.events.push({ tick, state: "expired", a: c.a, b: c.b, reason: "cancelled" });
      }
    }
    const d = this.duels.get(e);
    if (d) this.endDuel(d, tick, "cancelled");
  }

  step(tick: number): void {
    for (const [b, c] of this.challenges) {
      if (tick > c.expiresAt) {
        this.challenges.delete(b);
        this.events.push({ tick, state: "expired", a: c.a, b: c.b, reason: "expired" });
      }
    }
    const seen = new Set<Duel>();
    for (const d of this.duels.values()) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (tick > d.endsAt) this.endDuel(d, tick, "timeout");
    }
  }

  private endDuel(d: Duel, tick: number, reason: DuelEndReason, winner?: number): void {
    this.duels.delete(d.a);
    this.duels.delete(d.b);
    this.events.push({ tick, state: "ended", a: d.a, b: d.b, reason, winner });
  }

  /** Events since the last call, for the gateway. */
  drainEvents(): DuelEvent[] {
    const out = this.events;
    if (out.length > 0) this.events = [];
    return out;
  }
}
