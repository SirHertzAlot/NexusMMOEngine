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
  /** Audio events (content/audio/events.json): `start` plays as the move begins, `hit` on the hit frame. Client only. */
  sound?: { start?: string; hit?: string };
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
  Bite: 20,
  Claw: 21,
  Pounce: 22,
  Roar: 23,
  Breath: 24,
  TailWhip: 25,
  Stomp: 26,
  WingBuffet: 27,
  Sting: 28,
  Cleave: 29,
} as const;

/**
 * The moves built into the engine: what runs when content/combat/moves.json
 * is absent. The game's moves are that file, which the server and the
 * client load at start (`setCombatMoves`).
 */
export const DEFAULT_COMBAT_MOVES: readonly CombatMove[] = [
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
  { id: Move.Bite, name: "bite", clip: "Creature_Bite", kind: "attack", duration: 0.6, hitAt: 0.25, moveScale: 0.2 },
  { id: Move.Claw, name: "claw", clip: "Creature_Claw", kind: "attack", duration: 0.5, hitAt: 0.2, moveScale: 0.3 },
  { id: Move.Pounce, name: "pounce", clip: "Creature_Pounce", kind: "attack", duration: 0.8, advance: { distance: 1.2, from: 0.1, to: 0.5 }, hitAt: 0.35, moveScale: 0 },
  { id: Move.Roar, name: "roar", clip: "Creature_Roar", kind: "attack", duration: 1.0, hitAt: 0.4, moveScale: 0 },
  { id: Move.Breath, name: "breath", clip: "Creature_Breath", kind: "attack", duration: 1.2, hitAt: 0.5, moveScale: 0 },
  { id: Move.TailWhip, name: "tail whip", clip: "Creature_TailWhip", kind: "attack", duration: 0.7, hitAt: 0.3, moveScale: 0.1 },
  { id: Move.Stomp, name: "stomp", clip: "Creature_Stomp", kind: "attack", duration: 0.9, hitAt: 0.4, moveScale: 0 },
  { id: Move.WingBuffet, name: "wing buffet", clip: "Creature_WingBuffet", kind: "attack", duration: 0.6, hitAt: 0.25, moveScale: 0 },
  { id: Move.Sting, name: "sting", clip: "Creature_Sting", kind: "attack", duration: 0.5, hitAt: 0.2, moveScale: 0.2 },
  { id: Move.Cleave, name: "cleave", clip: "Creature_Cleave", kind: "attack", duration: 0.8, advance: { distance: 0.5, from: 0.1, to: 0.4 }, hitAt: 0.35, moveScale: 0 },
];

/** The moves in force (a live array: `setCombatMoves` replaces its contents). */
export const COMBAT_MOVES: CombatMove[] = [...DEFAULT_COMBAT_MOVES];
const BY_ID = new Map(COMBAT_MOVES.map((m) => [m.id, m]));

export interface CombatIssue {
  path: string;
  message: string;
}

/** Check a combat moves document (`{ version: 1, moves: [...] }`): every problem, by path. */
export function validateCombatMoves(doc: unknown): CombatIssue[] {
  const out: CombatIssue[] = [];
  const add = (path: string, message: string): void => void out.push({ path, message });
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!obj(doc)) return [{ path: "", message: "combat moves must be an object" }];
  if (doc.version !== 1) add("version", "must be 1");
  if (!Array.isArray(doc.moves)) return [...out, { path: "moves", message: "must be a list of moves" }];
  const ids = new Set<number>();
  for (const m of doc.moves) if (obj(m) && num(m.id)) ids.add(m.id);
  const known = new Set<number>(Object.values(Move).filter((v) => v !== Move.None));
  for (const id of known) if (!ids.has(id)) add("moves", `no move with id ${id} (${Object.keys(Move).find((k) => Move[k as keyof typeof Move] === id)})`);
  const seen = new Set<number>();
  doc.moves.forEach((raw: unknown, i: number) => {
    const p = `moves[${i}].`;
    if (!obj(raw)) return add(`moves[${i}]`, "must be an object");
    const m = raw;
    if (!num(m.id) || !known.has(m.id)) add(`${p}id`, "must be one of the engine's move ids");
    else if (seen.has(m.id)) add(`${p}id`, `duplicate id ${m.id}`);
    else seen.add(m.id);
    for (const k of ["name", "clip"]) if (typeof m[k] !== "string" || m[k] === "") add(`${p}${k}`, "must be a non-empty string");
    if (!["attack", "guard", "dodge"].includes(m.kind as string)) add(`${p}kind`, "must be attack, guard or dodge");
    const dur = m.duration;
    if (!num(dur) || dur < 0.1 || dur > 10) add(`${p}duration`, "must be 0.1..10 seconds");
    const d = num(dur) ? dur : 10;
    if (!num(m.moveScale) || m.moveScale < 0 || m.moveScale > 1) add(`${p}moveScale`, "must be 0..1");
    if (m.held !== undefined && typeof m.held !== "boolean") add(`${p}held`, "must be true or false");
    const inRange = (k: string, v: unknown): void => {
      if (!num(v) || v < 0 || v > d) add(`${p}${k}`, `must be 0..${d} seconds`);
    };
    if (m.hitAt !== undefined) inRange("hitAt", m.hitAt);
    if (m.branchAt !== undefined) inRange("branchAt", m.branchAt);
    if (m.recovery !== undefined && !(num(m.recovery) && ids.has(m.recovery))) add(`${p}recovery`, "must be the id of a move in this file");
    const win = (k: "chain" | "advance" | "iframes"): void => {
      const w = m[k];
      if (w === undefined) return;
      if (!obj(w)) return add(`${p}${k}`, "must be an object");
      inRange(`${k}.from`, w.from);
      inRange(`${k}.to`, w.to);
      if (num(w.from) && num(w.to) && w.from > w.to) add(`${p}${k}`, "from must not be after to");
      if (k === "chain" && !(num(w.next) && ids.has(w.next))) add(`${p}chain.next`, "must be the id of a move in this file");
      if (k === "advance" && (!num(w.distance) || w.distance < 0 || w.distance > 20)) add(`${p}advance.distance`, "must be 0..20 metres");
    };
    win("chain");
    win("advance");
    win("iframes");
    if (m.sound !== undefined) {
      if (!obj(m.sound)) add(`${p}sound`, "must be an object");
      else for (const k of ["start", "hit"]) if (m.sound[k] !== undefined && (typeof m.sound[k] !== "string" || m.sound[k] === "")) add(`${p}sound.${k}`, "must be an audio event id");
    }
  });
  return out;
}

/** Make `doc` the game's moves. Throws (and changes nothing) when it has problems. */
export function setCombatMoves(doc: unknown): void {
  const issues = validateCombatMoves(doc);
  if (issues.length > 0) throw new Error(`invalid combat moves: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  COMBAT_MOVES.splice(0, COMBAT_MOVES.length, ...(doc as { moves: CombatMove[] }).moves);
  BY_ID.clear();
  for (const m of COMBAT_MOVES) BY_ID.set(m.id, m);
}

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
