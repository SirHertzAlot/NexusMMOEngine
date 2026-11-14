/**
 * Worldbuilding Quest Generics 1-7 (KR-HOUSE-WORLDBUILDING-GENERICS.md).
 *
 * Pure schemas and state transitions turning world systems (`magicSource`,
 * `costLedger`, `fabricHealth`, `shrineDevotion`, NPC `role x motivation x flaw`)
 * into playable quest chains and concrete `QuestDef` hooks compatible with `QuestLog`.
 */
import { z } from "zod";
import type { CostLedger, FabricHealth, GiftedRole, ShrineDevotion } from "@mmo-engine/rules";
import type { QuestDef } from "./quest-def.js";
import type { StructureSkin } from "./content.js";

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id (a-z, 0-9, -)");

export const CHARACTER_MOTIVATIONS = [
  "revenge",
  "comfort",
  "redemption",
  "belonging",
  "success",
  "freedom",
  "control",
  "truth",
  "righteousness",
  "greater-good",
] as const;
export type CharacterMotivation = (typeof CHARACTER_MOTIVATIONS)[number];

export const CHARACTER_FLAWS = [
  "selfish",
  "pride",
  "greed",
  "cowardice",
  "manipulative",
  "stubborn",
  "naivety",
  "wrath",
  "envy",
  "secretive",
] as const;
export type CharacterFlaw = (typeof CHARACTER_FLAWS)[number];

// ---------------------------------------------------------------------------
// Generic 1: The Pact Ledger (offered -> active -> due -> settled | breached)
// ---------------------------------------------------------------------------

export const PACT_STATES = ["offered", "active", "due", "breached", "settled"] as const;
export type PactState = (typeof PACT_STATES)[number];

export const PactSchema = z.strictObject({
  id,
  being: id,
  holder: z.string().min(1).max(80),
  gift: z.string().min(1).max(120),
  price: z.string().min(1).max(120),
  clauses: z.array(z.string().min(1).max(200)).min(1),
  hiddenClause: z.string().min(1).max(200),
  hiddenRevealed: z.boolean().default(false),
  state: z.enum(PACT_STATES).default("offered"),
  nextClauseIndex: z.number().int().min(0).default(0),
});
export type Pact = z.infer<typeof PactSchema>;

export type PactAction =
  | { type: "accept" }
  | { type: "clause-due" }
  | { type: "reveal-hidden" }
  | { type: "fulfil-clause" }
  | { type: "renegotiate"; replacementPrice: string }
  | { type: "breach" };

export function advancePact(pact: Pact, action: PactAction): Pact {
  switch (action.type) {
    case "accept":
      if (pact.state !== "offered") throw new Error(`pact "${pact.id}": cannot accept in state ${pact.state}`);
      return { ...pact, state: "active" };
    case "clause-due":
      if (pact.state !== "active") throw new Error(`pact "${pact.id}": clause-due requires active state`);
      return { ...pact, state: "due" };
    case "reveal-hidden":
      return { ...pact, hiddenRevealed: true };
    case "fulfil-clause": {
      if (pact.state !== "due" && pact.state !== "active") {
        throw new Error(`pact "${pact.id}": cannot fulfil in state ${pact.state}`);
      }
      const nextIdx = Math.min(pact.clauses.length, pact.nextClauseIndex + 1);
      const done = nextIdx >= pact.clauses.length;
      return { ...pact, nextClauseIndex: nextIdx, state: done ? "settled" : "active" };
    }
    case "renegotiate":
      if (pact.state === "breached" || pact.state === "settled") {
        throw new Error(`pact "${pact.id}": cannot renegotiate ${pact.state} pact`);
      }
      return { ...pact, price: action.replacementPrice, state: "active" };
    case "breach":
      return { ...pact, state: "breached" };
  }
}

export function pactDueQuest(pact: Pact, giverNpc: string, targetPlace: { name: string; x: number; z: number; radius?: number }): QuestDef {
  const clause = pact.clauses[Math.min(pact.nextClauseIndex, pact.clauses.length - 1)];
  return {
    id: `pact:${pact.id}:${pact.nextClauseIndex}`,
    name: `${pact.being} calls the debt due`,
    giver: giverNpc,
    summary: `Terms for ${pact.gift}: ${clause}${pact.hiddenRevealed ? ` (revealed clause: ${pact.hiddenClause})` : ""}`,
    steps: [
      {
        id: "travel",
        text: `Reach ${targetPlace.name} to answer ${pact.being}'s call`,
        objective: { type: "reach", place: targetPlace.name, x: targetPlace.x, z: targetPlace.z, radius: targetPlace.radius ?? 10 },
      },
      {
        id: "answer",
        text: `Report back to ${giverNpc} to settle or renegotiate the clause`,
        objective: { type: "talk", npc: giverNpc },
      },
    ],
    rewards: [{ base: "ward-token", count: 1 }],
    repeatable: false,
    after: [],
  };
}

// ---------------------------------------------------------------------------
// Generic 2: Devotion Circuit (calendar rites updating shrine devotion)
// ---------------------------------------------------------------------------

export const RiteSchema = z.strictObject({
  id,
  shrineId: id,
  name: z.string().min(1).max(80),
  calendarWindow: z.string().min(1).max(60),
  offerings: z.array(z.string().min(1).max(60)).min(1),
  roles: z.array(z.string().min(1).max(60)).min(1),
  devotionDelta: z.number().positive(),
});
export type RiteDef = z.infer<typeof RiteSchema>;

export function performRite(
  shrine: ShrineDevotion,
  rite: RiteDef,
): { shrine: ShrineDevotion; answered: boolean } {
  if (shrine.shrineId !== rite.shrineId) {
    throw new Error(`rite "${rite.id}" belongs to shrine "${rite.shrineId}", got "${shrine.shrineId}"`);
  }
  const devotion = Math.min(100, shrine.devotion + rite.devotionDelta);
  return {
    shrine: { ...shrine, devotion },
    answered: devotion > shrine.devotion,
  };
}

export function riteQuest(rite: RiteDef, giverNpc: string, shrinePlace: { name: string; x: number; z: number }): QuestDef {
  return {
    id: `rite:${rite.id}`,
    name: `${rite.name} (${rite.calendarWindow})`,
    giver: giverNpc,
    summary: `Gather ${rite.offerings.join(", ")} and complete the ${rite.calendarWindow} observance.`,
    steps: [
      {
        id: "offering",
        text: `Gather ${rite.offerings[0]} for ${rite.name}`,
        objective: { type: "collect", base: rite.offerings[0], count: 1 },
      },
      {
        id: "shrine",
        text: `Bring the offering to ${shrinePlace.name}`,
        objective: { type: "reach", place: shrinePlace.name, x: shrinePlace.x, z: shrinePlace.z, radius: 8 },
      },
      {
        id: "complete",
        text: `Speak with ${giverNpc} to close the circuit`,
        objective: { type: "talk", npc: giverNpc },
      },
    ],
    rewards: [{ base: rite.offerings[0], count: 1, gold: 25 }],
    repeatable: true,
    after: [],
  };
}

// ---------------------------------------------------------------------------
// Generic 3: Sick Places (behavioural treatment rather than pure combat)
// ---------------------------------------------------------------------------

export const CAUSE_TREATMENTS: Record<FabricHealth["cause"], string[]> = {
  healthy: [],
  overuse: ["rest-soil", "replant-grove"],
  "broken-taboo": ["atone-taboo", "mend-boundary"],
  "dead-grove-heart": ["plant-heartseed", "tend-sap"],
  "pact-drain": ["sever-siphon", "repay-patron"],
  "lapsed-rite": ["restore-shrine-rite", "light-braziers"],
};

export function treatSickPlace(
  fabric: FabricHealth,
  action: string,
  recovery: number,
): { fabric: FabricHealth; effective: boolean } {
  const valid = CAUSE_TREATMENTS[fabric.cause] ?? [];
  const effective = valid.includes(action);
  const health = effective ? Math.min(100, fabric.health + Math.max(0, recovery)) : fabric.health;
  const cause = health >= 80 ? "healthy" : fabric.cause;
  return {
    fabric: { ...fabric, health, cause },
    effective,
  };
}

// ---------------------------------------------------------------------------
// Generic 4: The Price Comes Due (payable cost-ledger sub-quests)
// ---------------------------------------------------------------------------

export function priceDueOptions(ledger: CostLedger): string[] {
  const base = ["seek-ward-wright", "gather-rite-cost", "accept-transformation"];
  if (ledger.paymentOptions.length > 0) {
    return [...ledger.paymentOptions.map((p) => p.id), ...base];
  }
  return base;
}

// ---------------------------------------------------------------------------
// Generics 5-7: Decision-Point Arcs & Giver Engine (role x motivation x flaw)
// ---------------------------------------------------------------------------

export interface NpcArcSpec {
  npc: string;
  motivation: CharacterMotivation;
  flaw: CharacterFlaw;
  fork: string;
  changeCost: string;
  doubtState: "untested" | "doubted" | "proven";
}

export interface GiverQuestSignature {
  role: GiftedRole;
  preferredSkin: StructureSkin;
  questHook: string;
  flawTwist: string;
}

export function composeGiverProfile(
  role: GiftedRole,
  motivation: CharacterMotivation,
  flaw: CharacterFlaw,
): GiverQuestSignature {
  const hookByRole: Record<GiftedRole, { skin: StructureSkin; hook: string }> = {
    ruler: { skin: "fichtean-curve", hook: "service-and-favour" },
    outcast: { skin: "kishotenketsu", hook: "smuggling-and-ward-shelter" },
    worker: { skin: "story-circle", hook: "ward-and-healing-contract" },
    legend: { skin: "monomyth", hook: "relic-trail-and-witnesses" },
  };
  const twists: Record<CharacterFlaw, string> = {
    selfish: "keeps the safest exit for themselves",
    pride: "refuses a ward-wright's help until disaster hits",
    greed: "withholds part of the payment terms until mid-chain",
    cowardice: "pulls back right before the confrontation beat",
    manipulative: "frames a rival patron as the sole culprit",
    stubborn: "insists on repeating an outdated rite",
    naivety: "misreads a hidden clause in good faith",
    wrath: "escalates a boundary dispute into open raids",
    envy: "sabotages a keeping shrine out of spite",
    secretive: "hides active corruption bleed beneath heavy cloaks",
  };
  const h = hookByRole[role];
  return {
    role,
    preferredSkin: h.skin,
    questHook: `${h.hook}:${motivation}`,
    flawTwist: twists[flaw],
  };
}
