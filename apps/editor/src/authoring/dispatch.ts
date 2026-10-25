/**
 * Live dispatch — the mapper + executor that close the authoring loop.
 *
 * A VerbCall is intent (a canonical verb + params + the 5W1H envelope).
 * This layer translates intent into the ONE dispatch channel the editor
 * already has: admin commands on the running play-mode server (the
 * ServerLink / BackendClient admin surface, gateway `onAdmin`). It
 * invents no parallel protocol and no server behaviour.
 *
 * Faithfulness rules (the mapper never guesses):
 * - A plan names the exact admin command + args the gateway's own
 *   schemas accept (read from packages/engine-core/src/admin/*.ts and
 *   net/gateway.ts). Where a verb's params lack a target the command
 *   needs, the plan is `unsupported` with the reason — never a silently
 *   invented target.
 * - Admin `give` / `gold` act on the CONSOLE HOLDER only (the editor's
 *   dev-login avatar): they take no character argument. A verb call
 *   naming another character is unsupported, not redirected.
 * - Admin item picks address defs by STRING id or by base/rank pick
 *   (ItemPickArgsSchema). A numeric def index has no admin translation.
 * - Reads (resolveBase) route to the real read that answers them
 *   (`items`). Reads that no admin command honestly answers (defOf,
 *   countBase) are unsupported with the reason, not approximated.
 * - Component-shaped shelf actions can NOT ride admin `set`: applySet
 *   only writes numeric fields of a component the entity ALREADY has
 *   (it refuses otherwise) and only for its field whitelist, so `set`
 *   can never establish a component. Those plans are unsupported.
 *
 * The executor takes an injectable transport (the ServerLink's admin
 * surface in the UI, a fake in tests) and reports outcomes honestly:
 * a server refusal is `refused` with the server's message, no live
 * transport is `offline`, an unmappable verb is `unsupported` — and
 * nothing is ever reported `dispatched` on a refusal or offline.
 */

import { verbByName, type VerbCall } from "./verbs.js";
import type { ShelfAction } from "./add-shelf.js";

// ------------------------------------------------------------------ plans

export interface AdminStep {
  command: string;
  args: Record<string, unknown>;
}

export type DispatchPlan =
  | ({ kind: "admin"; verb: string } & AdminStep)
  | { kind: "composite"; verb: string; steps: readonly AdminStep[] }
  | ({ kind: "read"; verb: string } & AdminStep)
  | { kind: "unsupported"; verb: string; reason: string };

const unsupported = (verb: string, reason: string): DispatchPlan => ({ kind: "unsupported", verb, reason });

// ------------------------------------------------------------- param reads

function str(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function num(params: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Admin give/gold act on the console holder only; a call naming another character cannot be honoured. */
function callerOnly(params: Readonly<Record<string, unknown>>, command: string): string | undefined {
  const character = str(params, "character");
  if (character !== undefined && character !== "me") {
    return `admin "${command}" has no target argument — it acts on the console holder (the editor's avatar) only, so it cannot act on character "${character}"`;
  }
  return undefined;
}

/** An admin item pick from verb params: a string def id, or a base/rank/source pick. Null = translatable pick exists check failed upstream. */
function itemPick(params: Readonly<Record<string, unknown>>): { args: Record<string, unknown> } | { problem: string } {
  const def = params.def;
  if (typeof def === "string" && def.trim() !== "") return { args: { def: def.trim() } };
  if (typeof def === "number") {
    return { problem: `a numeric def index (${def}) has no admin translation — admin item picks address defs by string id or by base/rank` };
  }
  const base = str(params, "base");
  if (base !== undefined) {
    const args: Record<string, unknown> = { base };
    const rank = str(params, "rank");
    if (rank !== undefined) args.rank = rank;
    const source = str(params, "source");
    if (source !== undefined) args.source = source;
    return { args };
  }
  return { problem: "no item chosen: the call names neither a def id nor a base" };
}

// ------------------------------------------------------------------ mapper

/** Map one verb call to its dispatch plan. Pure: no I/O, no transport. */
export function planDispatch(call: VerbCall): DispatchPlan {
  const p = call.params;
  const verb = call.verb;

  // Aliases whose operation differs from the canonical entry come first.
  if (verb === "detachVendor") {
    const target = str(p, "entity") ?? str(p, "target");
    if (target === undefined) return unsupported(verb, "detachVendor needs the entity to detach from (a wire id)");
    return { kind: "admin", verb, command: "vendor", args: { sub: "detach", target } };
  }

  const canonical = verbByName(verb)?.name;
  if (canonical === undefined) return unsupported(verb, `unknown verb "${verb}" — authoring speaks only the 13 canonical verbs`);

  switch (canonical) {
    case "giveItem": {
      const caller = callerOnly(p, "give");
      if (caller !== undefined) return unsupported(verb, caller);
      const pick = itemPick(p);
      if ("problem" in pick) return unsupported(verb, pick.problem);
      return { kind: "admin", verb, command: "give", args: pick.args };
    }
    case "giveGold": {
      const caller = callerOnly(p, "gold");
      if (caller !== undefined) return unsupported(verb, caller);
      const amount = num(p, "amount");
      if (amount === undefined || !Number.isInteger(amount) || amount <= 0) {
        return unsupported(verb, `admin "gold" needs a positive integer amount (got ${JSON.stringify(p.amount ?? null)} — no usable amount chosen)`);
      }
      return { kind: "admin", verb, command: "gold", args: { amount } };
    }
    case "takeItem":
      return unsupported(verb, "no admin command takes an item out of a character's bag — the item commands (give/drop/loot) only add items for the console holder; ItemService.take has no admin home");
    case "moveItem":
      return unsupported(verb, "no admin command moves an item between two bags — items change hands only through player trade/auction actions; ItemService.moveItem has no admin home");
    case "defOf":
      return unsupported(verb, "no admin read answers an item instance's definition: `inspect` dumps component lines and prints no item/def line for a world item, and `items` looks definitions up by pick — it does not map an item instance to its def");
    case "countBase":
      return unsupported(verb, "no admin read counts a character's bag by base: `items` counts matching item DEFINITIONS, and `inspect` does not dump bag contents");
    case "resolveBase": {
      const base = str(p, "base");
      if (base === undefined) return unsupported(verb, "resolveBase needs a base name (none supplied)");
      const args: Record<string, unknown> = { base };
      const rank = str(p, "rank");
      if (rank !== undefined) args.rank = rank;
      return { kind: "read", verb, command: "items", args };
    }
    case "spawnCreature": {
      const kind = str(p, "kind") ?? str(p, "asset");
      if (kind === undefined) return unsupported(verb, "no spawn kind chosen: admin spawn needs a spawn-table asset / creature kind");
      const args: Record<string, unknown> = { asset: kind };
      const x = num(p, "x");
      if (x !== undefined) args.x = x;
      const z = num(p, "z");
      if (z !== undefined) args.z = z;
      return { kind: "admin", verb, command: "spawn", args };
    }
    case "teleport": {
      const x = num(p, "x");
      const z = num(p, "z");
      if (x === undefined || z === undefined) return unsupported(verb, "teleport needs explicit x and z (admin teleport has no default destination)");
      const args: Record<string, unknown> = { x, z };
      const entity = str(p, "entity");
      if (entity !== undefined) args.entity = entity; // absent = the gateway schema's own default, the caller's avatar ("me")
      return { kind: "admin", verb, command: "teleport", args };
    }
    case "startDialogue": {
      const player = str(p, "player");
      return unsupported(verb, `no admin command starts a dialogue — dialogue is player-initiated through the quest channel; startDialogue has no admin home${player === undefined ? " (this call also names no player)" : ""}`);
    }
    case "attachVendor": {
      const target = str(p, "entity") ?? str(p, "target");
      if (target === undefined) return unsupported(verb, "attachVendor needs the entity to attach to (a wire id)");
      const templateId = str(p, "templateId") ?? str(p, "id");
      if (templateId === undefined) return unsupported(verb, "no vendor template chosen: admin vendor attach needs {id, target} and this call's templateId is empty");
      return { kind: "admin", verb, command: "vendor", args: { sub: "attach", id: templateId, target } };
    }
    case "placeItemFixture":
      return unsupported(verb, "no admin command places an item fixture at a position: `drop` drops a fresh matching item at the console holder's feet and its args take no x/z, and `spawn` plants spawn-table archetypes, not item definitions — ItemService.placeFixture has no admin home");
    case "grantQuestReward": {
      const caller = callerOnly(p, "give/gold");
      if (caller !== undefined) return unsupported(verb, `grantQuestReward resolves to giveItem/giveGold steps, and ${caller}`);
      const rewards = p.rewards;
      if (!Array.isArray(rewards) || rewards.length === 0) return unsupported(verb, "no rewards specified: grantQuestReward needs a non-empty rewards list");
      const steps: AdminStep[] = [];
      for (const entry of rewards) {
        if (!isRecord(entry)) return unsupported(verb, "a reward entry is not an object with base/def/gold");
        const gold = num(entry, "gold");
        if (gold !== undefined) {
          if (!Number.isInteger(gold) || gold <= 0) return unsupported(verb, `a reward's gold must be a positive integer (got ${JSON.stringify(entry.gold)})`);
          steps.push({ command: "gold", args: { amount: gold } });
        }
        const hasDef = entry.def !== undefined && entry.def !== "";
        const hasBase = str(entry, "base") !== undefined;
        if (hasDef || hasBase) {
          const pick = itemPick(entry);
          if ("problem" in pick) return unsupported(verb, pick.problem);
          const count = num(entry, "count") ?? 1;
          if (!Number.isInteger(count) || count < 1 || count > 50) return unsupported(verb, `a reward's count must be an integer 1–50 (got ${JSON.stringify(entry.count ?? null)})`);
          for (let i = 0; i < count; i++) steps.push({ command: "give", args: pick.args });
        } else if (gold === undefined) {
          return unsupported(verb, "a reward entry names neither an item (base/def) nor gold");
        }
      }
      if (steps.length === 0) return unsupported(verb, "the rewards list produced no dispatchable steps");
      return { kind: "composite", verb, steps };
    }
  }
  return unsupported(verb, `no dispatch mapping for verb "${verb}"`);
}

/**
 * The plan for a component-shaped shelf action (addComponents). Admin
 * `set` can never establish a component — applySet writes only numeric
 * fields of a component the entity already has, and only for its field
 * whitelist — so every such action is unsupported, with the reason.
 * Returns null for verb-shaped actions (those go through planDispatch).
 */
export function shelfComponentPlan(action: ShelfAction): DispatchPlan | null {
  const components = action.addComponents;
  if (!components || components.length === 0) return null;
  return unsupported(
    "addComponents",
    `admin "set" cannot add ${components.join(" + ")}: set only writes numeric fields of a component an entity already has (it refuses with "has no <component>" otherwise) and only for its whitelist (Transform, Velocity, PlayerIntent, Health, BodyConfig, PathRequest, PathState, NavAgent, AssetRef, Locomotion, Action) — adding a component has no admin home`,
  );
}

// ---------------------------------------------------------------- executor

/** The transport the executor drives: the ServerLink's admin surface in the UI, a fake in tests. */
export interface DispatchTransport {
  admin(command: string, args?: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  inspect?(entity: string): Promise<{ ok: boolean; message: string }>;
}

export type DispatchStatus = "dispatched" | "refused" | "unsupported" | "offline";

export interface DispatchOutcome {
  status: DispatchStatus;
  verb: string;
  /** The plan the call mapped to (kept so the UI can show what was attempted). */
  plan: DispatchPlan;
  /** The server's message (last step), the refusal, or the unsupported/offline reason. Plain language, safe to show. */
  message: string;
  /** Steps completed / steps in the plan (composites report where they stopped). */
  stepsRun: number;
  stepsTotal: number;
  /** For read plans: the read's answer. After a dispatched mutation: the inspect read-back dump, when one was taken. */
  readResult?: string;
}

/** Which entity a dispatched mutation should be re-inspected through, to reflect the result. Null = no meaningful target. */
export function inspectTargetForCall(call: VerbCall): string | null {
  const p = call.params;
  const entity = str(p, "entity") ?? str(p, "target");
  if (entity !== undefined) return entity;
  const canonical = verbByName(call.verb)?.name;
  if (canonical === "giveItem" || canonical === "giveGold" || canonical === "grantQuestReward") return "me"; // the console holder acted on
  const character = str(p, "character");
  if (character !== undefined) return character;
  return null;
}

const OFFLINE_HINT = /not connected|not running|no live|not in the world/i;

/**
 * Execute one verb call's plan over the transport. `transport: null`
 * means no live server — the outcome is `offline` and nothing runs.
 * An unsupported plan short-circuits before the transport is touched.
 * After a dispatched mutation, the target entity is re-inspected (when
 * the transport offers inspect and a target exists) and the dump rides
 * the outcome as readResult — the reflection step.
 */
export async function executeDispatch(call: VerbCall, transport: DispatchTransport | null): Promise<DispatchOutcome> {
  const plan = planDispatch(call);
  if (plan.kind === "unsupported") {
    return { status: "unsupported", verb: call.verb, plan, message: plan.reason, stepsRun: 0, stepsTotal: 0 };
  }
  if (transport === null) {
    return { status: "offline", verb: call.verb, plan, message: "the play server isn't running — nothing was dispatched", stepsRun: 0, stepsTotal: plan.kind === "composite" ? plan.steps.length : 1 };
  }
  const steps: readonly AdminStep[] = plan.kind === "composite" ? plan.steps : [plan];
  let lastMessage = "";
  for (let i = 0; i < steps.length; i++) {
    let res: { ok: boolean; message: string };
    try {
      res = await transport.admin(steps[i].command, steps[i].args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { status: OFFLINE_HINT.test(message) ? "offline" : "refused", verb: call.verb, plan, message, stepsRun: i, stepsTotal: steps.length };
    }
    if (!res.ok) {
      const where = steps.length > 1 ? `step ${i + 1}/${steps.length} (${steps[i].command}) refused: ` : "";
      return { status: OFFLINE_HINT.test(res.message) ? "offline" : "refused", verb: call.verb, plan, message: `${where}${res.message}`, stepsRun: i, stepsTotal: steps.length };
    }
    lastMessage = res.message;
  }
  const outcome: DispatchOutcome = { status: "dispatched", verb: call.verb, plan, message: lastMessage, stepsRun: steps.length, stepsTotal: steps.length };
  if (plan.kind === "read") {
    outcome.readResult = lastMessage;
    return outcome;
  }
  // Reflect the result: re-inspect the acted-on entity and carry the dump back.
  const target = inspectTargetForCall(call);
  if (target !== null && transport.inspect) {
    try {
      const read = await transport.inspect(target);
      if (read.ok) outcome.readResult = read.message;
    } catch {
      /* the mutation already landed; a failed read-back never rewrites its outcome */
    }
  }
  return outcome;
}
