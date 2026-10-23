/**
 * The vulnerability → counter matrix, as data.
 *
 * Every defensive form carries the ways it fails (tags), every attacker
 * tactic probes for specific failures, and every counter clears a failure
 * at a cost. The fortify loop never hard-codes "square towers become
 * round": it asks the matrix which counters clear the weakness the attack
 * sim just found. Era gating lives here too — a counter with `era: 2`
 * does not exist for an era-1 settlement, so the historical progression
 * (motte → walls → flanking towers → bent entrances → gun loops) falls
 * out of the data instead of being scripted.
 *
 * Prototype scope: four tactics (charge, ladders, mining, siege). The
 * Roman-fort Short added siege + the lilia obstacle belt + doctrine
 * presets; cannon/gun-loops slot into the same shape later.
 */

import type { FaceId } from "./model.js";

export type TacticId = "charge" | "ladders" | "mining" | "siege";

/** The failure modes the attack sim can find. */
export type WeaknessKind =
  /** The cheapest approach reaches the gate in a long straight run: a
   *  formed charge (or ram) covers it at full speed, side-on to nothing. */
  | "straight-charge"
  /** A stretch of wall face no firing position can see: ladders go up
   *  unshot-at. Located on a specific face. */
  | "dead-ground"
  /** A structure whose foundations can be tunnelled: diggable soil and a
   *  water table below tunnel depth, so the sap does not flood. Located
   *  on a specific structure. */
  | "undermine"
  /** Nothing stored inside the walls: no internal well, no granary.
   *  The siege tactic needs no assault at all — just time. (The Roman
   *  variation's lesson, and the water castle's internal well.) */
  | "no-reserve";

export interface TacticDef {
  id: TacticId;
  /** How much this tactic counts toward total exposure (0..1 scale). */
  weight: number;
  /** The weakness kind this tactic exploits. */
  probes: WeaknessKind;
}

export type CounterId =
  | "bend-approach"
  | "barbican"
  | "flanking-tower"
  | "round-tower"
  | "moat"
  | "lilia"
  | "internal-well"
  | "granary";

export interface CounterDef {
  id: CounterId;
  /** The weakness kind one application clears (at its location). */
  clears: WeaknessKind;
  /** Build cost, in the settlement's defence-budget points. */
  cost: number;
  /** First era this counter is available in. */
  era: number;
}

export interface Matrix {
  tactics: TacticDef[];
  counters: CounterDef[];
}

export const DEFAULT_MATRIX: Matrix = {
  tactics: [
    { id: "charge", weight: 1.0, probes: "straight-charge" },
    { id: "ladders", weight: 0.8, probes: "dead-ground" },
    { id: "mining", weight: 0.9, probes: "undermine" },
    { id: "siege", weight: 0.7, probes: "no-reserve" },
  ],
  counters: [
    // Rebuild the approach with a sharp corner near the gate: cheap,
    // available early, and exactly what the pond castles did first.
    { id: "bend-approach", clears: "straight-charge", cost: 2, era: 1 },
    // Lilia: rows of hidden stake pits dug into the approach field —
    // the Roman answer. The defence leaves the wall and sits on the
    // attacker's path, breaking the charge before it forms up. Caesar's
    // soldiers named them; they predate every medieval counter here.
    { id: "lilia", clears: "straight-charge", cost: 2, era: 1 },
    // A second gated guardhouse on its own island: the charge must stop
    // twice. Expensive, and it also shortens the final straight run.
    { id: "barbican", clears: "straight-charge", cost: 5, era: 2 },
    // A tower mid-face so archers shoot along the wall: clears that
    // face's dead ground.
    { id: "flanking-tower", clears: "dead-ground", cost: 4, era: 2 },
    // Rebuild one square tower round: no corner to undermine, glancing
    // surface. Clears undermining at that one tower.
    { id: "round-tower", clears: "undermine", cost: 3, era: 2 },
    // Flood a ditch around a structure: every sap tunnel drowns. Only
    // applicable where the water table allows it (see analyze.ts).
    { id: "moat", clears: "undermine", cost: 6, era: 2 },
    // Stored calories behind the walls: a granary on a raised floor, so
    // damp cannot rot the reserve. Available early — the Romans built
    // them in marching-camp country.
    { id: "granary", clears: "no-reserve", cost: 3, era: 1 },
    // A well inside the walls (the water castle keeps its in a tower).
    // Only buildable where a well can actually reach water.
    { id: "internal-well", clears: "no-reserve", cost: 4, era: 2 },
  ],
};

/**
 * Doctrines: the Roman variation's real export. A doctrine is the
 * fortify loop's output compiled ahead of time — a culture's standard
 * answers, stamped onto every new settlement at generation, before any
 * local threat is known. The loop still runs afterwards for whatever
 * the doctrine doesn't cover.
 */
export const DOCTRINES: Record<string, CounterId[]> = {
  roman: ["lilia", "granary", "internal-well"],
};

export const counterById = (m: Matrix, id: CounterId): CounterDef => {
  const c = m.counters.find((x) => x.id === id);
  if (!c) throw new Error(`matrix: unknown counter ${id}`);
  return c;
};

/** Where a weakness lives: the approach, a wall face, a structure, or the interior. */
export type WeaknessSite =
  | { kind: "approach" }
  | { kind: "face"; face: FaceId }
  | { kind: "structure"; x: number; y: number; structure: "tower" | "gate" }
  | { kind: "interior" };
