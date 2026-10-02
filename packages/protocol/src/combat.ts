/**
 * Combat moves — the data the server (timing, chaining, movement) and the
 * clients (which clip) share. The server runs moves (CombatSystem) and
 * sends the one each character is in (the Action component: move id,
 * start tick, sequence, facing); clients play its clip from that tick.
 *
 * Move ids are wire contract: never renumber. Durations are the clips'
 * (packages/art animations.json); a test keeps them in step.
 *
 * The sword combo is three hits. An attack pressed during a hit's chain
 * window queues the next hit, which starts when the current hit lands
 * (`branchAt`); with nothing queued the hit's recovery plays instead, and
 * a press early in the recovery can still pick the combo up.
 */

export type MoveKind = "attack" | "guard" | "dodge";

export interface CombatMove {
  id: number;
  name: string;
  /** The animation clip (a woman's `.F` take is used when there is one). */
  clip: string;
  kind: MoveKind;
  /** Seconds the move lasts (a held move: one loop of its clip). */
  duration: number;
  /** Attack pressed at seconds in [from, to] queues `next`. */
  chain?: { next: number; from: number; to: number };
  /** Seconds in when the queued `next` (or else `recovery`) takes over. */
  branchAt?: number;
  /** Played from `branchAt` when no follow-up was queued. */
  recovery?: number;
  /** Forward travel (metres, along the move's facing) between seconds from and to. */
  advance?: { distance: number; from: number; to: number };
  /** Walking during the move, as a fraction of normal speed. */
  moveScale: number;
  /** Lasts while its button is held (a guard); its clip loops. */
  held?: boolean;
  /** Seconds in when the blow lands (attacks that hurt); in step with the clip's swing. */
  hitAt?: number;
  /** Seconds in [from, to] when the mover cannot be hit (the roll). */
  iframes?: { from: number; to: number };
}

/** Move ids. */
export const Move = {
  None: 0,
  SwordA: 1,
  SwordB: 2,
  SwordC: 3,
  SwordARecover: 4,
  SwordBRecover: 5,
  Guard: 6,
  Roll: 7,
  ShieldBash: 8,
} as const;

export const COMBAT_MOVES: readonly CombatMove[] = [
  {
    id: Move.SwordA, name: "sword A", clip: "Sword_Regular_A", kind: "attack", duration: 0.4333,
    chain: { next: Move.SwordB, from: 0.08, to: 0.4333 }, branchAt: 0.4333, recovery: Move.SwordARecover,
    advance: { distance: 0.79, from: 0, to: 0.4333 }, moveScale: 0, hitAt: 0.2,
  },
  {
    id: Move.SwordB, name: "sword B", clip: "Sword_Regular_B", kind: "attack", duration: 0.5333,
    chain: { next: Move.SwordC, from: 0.08, to: 0.5333 }, branchAt: 0.5333, recovery: Move.SwordBRecover,
    moveScale: 0, hitAt: 0.25,
  },
  {
    id: Move.SwordC, name: "sword C (finisher)", clip: "Sword_Regular_C", kind: "attack", duration: 2.0,
    advance: { distance: 1.49, from: 0.1, to: 0.9 }, moveScale: 0, hitAt: 0.5,
  },
  {
    id: Move.SwordARecover, name: "sword A recovery", clip: "Sword_Regular_A_Rec", kind: "attack", duration: 0.9667,
    chain: { next: Move.SwordB, from: 0, to: 0.25 }, branchAt: 0.25,
    advance: { distance: 0.3, from: 0, to: 0.6 }, moveScale: 0.3,
  },
  {
    id: Move.SwordBRecover, name: "sword B recovery", clip: "Sword_Regular_B_Rec", kind: "attack", duration: 1.0333,
    chain: { next: Move.SwordC, from: 0, to: 0.25 }, branchAt: 0.25,
    advance: { distance: 0.35, from: 0, to: 0.6 }, moveScale: 0.3,
  },
  { id: Move.Guard, name: "guard", clip: "Idle_Shield_Loop", kind: "guard", duration: 2.5, held: true, moveScale: 0.35 },
  {
    id: Move.Roll, name: "roll", clip: "Roll", kind: "dodge", duration: 1.4667,
    advance: { distance: 4.5, from: 0.05, to: 1.05 }, moveScale: 0, iframes: { from: 0.05, to: 0.8 },
  },
  { id: Move.ShieldBash, name: "shield bash", clip: "Shield_OneShot", kind: "attack", duration: 0.8333, moveScale: 0 },
];

const BY_ID = new Map(COMBAT_MOVES.map((m) => [m.id, m]));

/** The move with this id, or undefined (Move.None, or unknown). */
export function combatMove(id: number): CombatMove | undefined {
  return BY_ID.get(id);
}

/**
 * Distance travelled `t` seconds into a move (metres along its facing):
 * its advance, spread evenly over the advance's window.
 */
export function moveTravel(move: CombatMove, t: number): number {
  const a = move.advance;
  if (!a || a.to <= a.from) return 0;
  const k = Math.min(1, Math.max(0, (t - a.from) / (a.to - a.from)));
  return a.distance * k;
}
