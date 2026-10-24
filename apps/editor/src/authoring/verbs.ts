/**
 * The verb layer + the 5W1H provenance envelope.
 *
 * Authoring speaks ONLY the 13 canonical verbs of MODULE-AUTHORING-AUDIT.md
 * §4 — the table's paired rows (spawnCreature/spawnPack,
 * attachVendor/detachVendor) are one canonical entry each, with the second
 * name kept as an alias so call sites can use either. Every verb names its
 * canonical home in the engine; this registry is the editor-side mirror of
 * that table, not a second implementation.
 *
 * Every mutation travels as a VerbCall: the verb + params (how), wrapped
 * in a mandatory provenance envelope (who / what / when / where / why).
 * Validation rejects anonymous mutations — a call with no actor or no
 * intent never reaches a system. The history log is append-only and
 * queryable per object and per actor, as the design requires ("history
 * lives with the content").
 */

export type ActorRole = "designer" | "developer";

export interface ActorRef {
  id: string;
  role: ActorRole;
}

export interface Provenance {
  /** Who: actor identity + which surface they act from. */
  who: ActorRef;
  /** What: a one-line summary of the target ("Blacksmith Mara"). */
  what: string;
  /** When: epoch milliseconds. */
  when: number;
  /** Where: the target's hierarchy path ("Haven / Market Square / Blacksmith Mara"). */
  where: string;
  /** Why: the calling intent ("vendor stock", "quest reward", "hand tweak", "procgen run: village-7"). */
  why: string;
}

export interface VerbCall {
  /** Canonical verb name (or a registered alias). */
  verb: string;
  params: Readonly<Record<string, unknown>>;
  provenance: Provenance;
}

export interface VerbDef {
  /** Canonical name — the authoring layer's vocabulary. */
  name: string;
  /** Other names for the same canonical verb (audit §4 paired rows). */
  aliases: readonly string[];
  /** Where the verb canonically lives in the engine. */
  home: string;
  /** One-line signature summary from the audit table. */
  signature: string;
}

/** The 13 canonical verbs (audit §4), in the audit's order. */
export const CANONICAL_VERBS: readonly VerbDef[] = [
  { name: "giveItem", aliases: [], home: "items · ItemService.give", signature: "(character, def) → ok" },
  { name: "giveGold", aliases: [], home: "core · WalletSystem.grant", signature: "(character, amount) → ok" },
  { name: "takeItem", aliases: [], home: "items · ItemService.take", signature: "(character, item) → ok" },
  { name: "defOf", aliases: [], home: "items · ItemService.defOf", signature: "(item) → def" },
  { name: "moveItem", aliases: [], home: "items · ItemService.moveItem", signature: "(item, from, to) → ok" },
  { name: "countBase", aliases: [], home: "items · ItemService.countBase", signature: "(character, base) → n" },
  { name: "resolveBase", aliases: [], home: "items · item defs", signature: "(base, rank) → def" },
  { name: "spawnCreature", aliases: ["spawnPack"], home: "creatures · CreatureSystem.spawn/spawnPack", signature: "(kind, x, z) → eid(s)" },
  { name: "teleport", aliases: [], home: "admin · player teleport (GM verb)", signature: "(entity, x, z)" },
  { name: "startDialogue", aliases: [], home: "quests · dialog graphs", signature: "(npc, player)" },
  { name: "attachVendor", aliases: ["detachVendor"], home: "core · VendorSystem.attach/detach", signature: "(entity, templateId)" },
  { name: "placeItemFixture", aliases: [], home: "items · ItemService.placeFixture", signature: "(base, rank, x, z)" },
  { name: "grantQuestReward", aliases: [], home: "quests · QuestService reward application", signature: "(character, {base,count,gold}[]) → resolves to giveItem/giveGold" },
];

const VERB_BY_NAME: ReadonlyMap<string, VerbDef> = new Map(
  CANONICAL_VERBS.flatMap((v) => [[v.name, v] as const, ...v.aliases.map((a) => [a, v] as const)]),
);

/** Resolve a verb name or alias to its canonical def; undefined = not a canonical verb. */
export function verbByName(name: string): VerbDef | undefined {
  return VERB_BY_NAME.get(name);
}

/**
 * Validate a verb call's envelope. Returns every problem; an empty list
 * means the call may execute. Missing who (identity or role) or missing
 * why are rejections — anonymous mutations never pass.
 */
export function validateVerbCall(call: VerbCall): string[] {
  const problems: string[] = [];
  if (!verbByName(call.verb)) problems.push(`unknown verb "${call.verb}" — authoring speaks only the 13 canonical verbs`);
  const p = call.provenance;
  if (!p) return [...problems, "missing provenance envelope"];
  if (!p.who || !p.who.id || p.who.id.trim() === "") problems.push("anonymous mutation rejected: provenance.who.id is required");
  if (!p.who || (p.who.role !== "designer" && p.who.role !== "developer")) problems.push("anonymous mutation rejected: provenance.who.role must be designer or developer");
  if (!p.why || p.why.trim() === "") problems.push("mutation rejected: provenance.why (intent) is required");
  if (!p.what || p.what.trim() === "") problems.push("provenance.what (target summary) is required");
  if (!p.where || p.where.trim() === "") problems.push("provenance.where (hierarchy path) is required");
  if (!Number.isFinite(p.when) || p.when <= 0) problems.push("provenance.when must be a positive epoch-ms timestamp");
  return problems;
}

/** Build a verb call, throwing on an invalid envelope — the one construction path widgets use. */
export function makeVerbCall(verb: string, params: Record<string, unknown>, provenance: Provenance): VerbCall {
  const call: VerbCall = { verb, params, provenance };
  const problems = validateVerbCall(call);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return call;
}

/**
 * Append-only history of verb calls. The log never rewrites an entry;
 * queries are views over the same entries (per object by hierarchy path
 * or `what`, per actor by who.id).
 */
export class VerbHistory {
  private readonly entries: VerbCall[] = [];

  /** Append a call after validation; invalid (e.g. anonymous) calls throw and are not recorded. */
  append(call: VerbCall): VerbCall {
    const problems = validateVerbCall(call);
    if (problems.length > 0) throw new Error(problems.join("; "));
    this.entries.push(call);
    return call;
  }

  all(): readonly VerbCall[] {
    return this.entries;
  }

  /** Every change to one object: matched by hierarchy path or by target summary. */
  forObject(whereOrWhat: string): readonly VerbCall[] {
    return this.entries.filter((c) => c.provenance.where === whereOrWhat || c.provenance.what === whereOrWhat);
  }

  /** Every change one actor made. */
  forActor(actorId: string): readonly VerbCall[] {
    return this.entries.filter((c) => c.provenance.who.id === actorId);
  }
}
