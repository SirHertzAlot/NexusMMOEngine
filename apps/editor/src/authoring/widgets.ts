/**
 * Widget view-models — the builder between relevance and the renderer.
 *
 * Given the relevance result for a selection plus caller-supplied applied
 * state (read live from the systems by the caller — this layer invents no
 * data paths), produce one view-model per widget with the design's three
 * anatomy zones:
 *
 *   1. what it is       — identity line
 *   2. what's applied   — current state lines (the caller's, verbatim)
 *   3. CRUD             — affordances, each resolved to a VerbCall with a
 *                         full 5W1H envelope, so the UI is a thin renderer
 *                         and dispatch is "execute this call / log this call".
 *
 * CRUD mappings are honest: where a canonical verb covers the action it
 * is used; where none does (binding a flow graph, adding an emitter), the
 * widget carries no fake verb — those preconditions are established from
 * the add shelf instead (see add-shelf.ts).
 *
 * Actions that need a designer-supplied value declare it as an input
 * (inputs.ts): a picker fed by a real list, or a number. The view renders
 * the fields and hands the raw values back to `callWith`, which rebuilds
 * the VerbCall with those values in its params. Unfilled inputs leave the
 * placeholder param in place, and the dispatch mapper refuses it with its
 * reason — the mapper is the single gate; nothing here pre-approves.
 *
 * One targeting truth, stated on the actions themselves: admin give /
 * gold (and therefore quest-reward grants, which resolve to them) act on
 * the CONSOLE HOLDER only — the editor's own avatar. The give actions
 * below therefore build calls for "me" and carry a note saying so. A call
 * naming another character is still refused by the mapper, never
 * silently redirected; these actions simply never claimed that target.
 */

import { evaluateRelevance, type AppliedWidget } from "./relevance.js";
import { inputValue, parseInputNumber, type ActionInput, type InputValues } from "./inputs.js";
import { makeVerbCall, type ActorRef, type VerbCall } from "./verbs.js";
import type { SelectionFacts } from "./facts.js";

export interface AppliedState {
  /** Zone 1 override: "Vendor · Blacksmith Mara · template `weapons-tier2`". Defaults to the relevance detail. */
  identity?: string;
  /** Zone 2: current-state lines, read live by the caller. */
  lines: readonly string[];
}

export interface WidgetAction {
  id: string;
  label: string;
  /** Fields the designer fills before dispatching (data — see inputs.ts). Empty = the action fires as-is. */
  inputs: readonly ActionInput[];
  /** Plain-language truth about the action, rendered with it (e.g. who admin give really acts on). */
  note?: string;
  /** The resolved mutation with unfilled inputs: a canonical verb + full provenance envelope. */
  call: VerbCall;
  /** Rebuild the call with designer-supplied input values applied (descriptor prefills fill any gaps). */
  callWith: (values: InputValues) => VerbCall;
}

export interface WidgetViewModel {
  widgetId: string;
  title: string;
  tabs?: readonly string[];
  /** Zone 1 — what it is. */
  identity: string;
  /** Zone 2 — what's applied (empty = the caller supplied no live state; rendered as "nothing read yet", never invented). */
  applied: readonly string[];
  /** Zone 3 — CRUD affordances as verb calls. */
  actions: readonly WidgetAction[];
}

export interface BuildWidgetsOptions {
  actor: ActorRef;
  /** Intent stamped into every action's envelope (the widget session's why). */
  why: string;
  /** Hierarchy path of the selection, stamped as `where`. */
  where: string;
  /** Timestamp for the envelopes; defaults to Date.now(). */
  when?: number;
  /** Caller-supplied live state per widget id. */
  state?: Readonly<Record<string, AppliedState>>;
}

interface CrudSpec {
  id: string;
  label: string;
  verb: string;
  /** Input descriptors for this action (may depend on the facts — prefills do). */
  inputs?: (facts: SelectionFacts) => readonly ActionInput[];
  /** Plain-language truth rendered with the action. */
  note?: string;
  /** Params from the facts + the RESOLVED input values (every declared input id present, "" when unfilled). */
  params: (facts: SelectionFacts, values: Readonly<Record<string, string>>) => Record<string, unknown>;
}

const AVATAR_NOTE = "Admin give/gold act on your avatar (the console holder) — they take no character target, so this grant lands there, not on the selected character.";
const REWARD_NOTE = "Quest rewards resolve to admin give + gold steps, which act on your avatar (the console holder) only.";

/** Per-widget CRUD that a canonical verb honestly covers. Widgets absent here render no verb actions. */
const CRUD: Readonly<Record<string, readonly CrudSpec[]>> = {
  vendor: [
    {
      id: "change-template",
      label: "Change template",
      verb: "attachVendor",
      inputs: (f) => [
        {
          id: "templateId",
          label: "Vendor template",
          kind: "picker",
          source: "vendor-templates",
          ...(f.vendorTemplateId ? { initial: f.vendorTemplateId } : {}),
          placeholder: "Choose a template",
        },
      ],
      params: (f, v) => ({ entity: f.id, templateId: v.templateId }),
    },
    { id: "detach", label: "Detach vendor", verb: "detachVendor", params: (f) => ({ entity: f.id }) },
  ],
  character: [
    {
      id: "give-item",
      label: "Give item",
      verb: "giveItem",
      note: AVATAR_NOTE,
      inputs: () => [{ id: "base", label: "Item base", kind: "picker", source: "item-bases", placeholder: "Choose an item base" }],
      params: (_f, v) => ({ character: "me", ...(v.base ? { base: v.base } : { def: "" }) }),
    },
    {
      id: "give-gold",
      label: "Give gold",
      verb: "giveGold",
      note: AVATAR_NOTE,
      inputs: () => [{ id: "amount", label: "Gold amount", kind: "number", placeholder: "e.g. 250" }],
      params: (_f, v) => ({ character: "me", amount: parseInputNumber(v.amount) ?? 0 }),
    },
  ],
  items: [
    { id: "take-item", label: "Take item", verb: "takeItem", params: (f) => ({ character: f.id, item: "" }) },
    { id: "move-item", label: "Move item", verb: "moveItem", params: (f) => ({ item: f.id, from: "", to: "" }) },
    { id: "count-base", label: "Count base", verb: "countBase", params: (f) => ({ character: f.id, base: "" }) },
  ],
  quests: [
    {
      id: "grant-reward",
      label: "Grant quest reward",
      verb: "grantQuestReward",
      note: REWARD_NOTE,
      inputs: () => [
        { id: "base", label: "Reward item base", kind: "picker", source: "item-bases", placeholder: "No item (gold only)" },
        { id: "gold", label: "Reward gold", kind: "number", placeholder: "0" },
      ],
      params: (_f, v) => {
        const rewards: Record<string, unknown>[] = [];
        if (v.base) rewards.push({ base: v.base });
        const gold = parseInputNumber(v.gold);
        if (gold !== undefined) rewards.push({ gold });
        return { character: "me", rewards };
      },
    },
    { id: "start-dialogue", label: "Start dialogue", verb: "startDialogue", params: (f) => ({ npc: f.id, player: "" }) },
  ],
  creature: [
    {
      id: "spawn-pack",
      label: "Spawn pack",
      verb: "spawnPack",
      note: "Admin spawn plants the pack at your avatar — it takes the caller's position when the call names no x/z.",
      inputs: (f) => [
        {
          id: "kind",
          label: "Creature kind",
          kind: "picker",
          source: "creature-kinds",
          ...(f.creatureKind ? { initial: f.creatureKind } : {}),
          placeholder: "Choose a kind",
        },
      ],
      params: (_f, v) => ({ kind: v.kind }),
    },
  ],
  dungeons: [
    {
      id: "grant-reward",
      label: "Give item reward",
      verb: "giveItem",
      note: AVATAR_NOTE,
      inputs: () => [{ id: "base", label: "Item base", kind: "picker", source: "item-bases", placeholder: "Choose an item base" }],
      params: (_f, v) => ({ character: "", ...(v.base ? { base: v.base } : { def: "" }) }),
    },
  ],
  physics: [
    {
      id: "teleport",
      label: "Teleport here",
      verb: "teleport",
      inputs: (f) => [
        { id: "x", label: "Teleport x", kind: "number", ...(f.position ? { initial: String(f.position.x) } : {}), placeholder: "x" },
        { id: "z", label: "Teleport z", kind: "number", ...(f.position ? { initial: String(f.position.z) } : {}), placeholder: "z" },
      ],
      params: (f, v) => {
        const x = parseInputNumber(v.x);
        const z = parseInputNumber(v.z);
        // Unfilled coordinates stay ABSENT so the mapper refuses with its
        // reason — never a silent teleport to 0,0.
        return { entity: f.id, ...(x !== undefined ? { x } : {}), ...(z !== undefined ? { z } : {}) };
      },
    },
  ],
};

/** Build the widget stack for one selection. Throws if the actor/why envelope is invalid — anonymous UI is a bug. */
export function buildWidgets(facts: SelectionFacts, opts: BuildWidgetsOptions): readonly WidgetViewModel[] {
  const when = opts.when ?? Date.now();
  return evaluateRelevance(facts).applied.map((w: AppliedWidget) => {
    const state = opts.state?.[w.widgetId];
    const actions = (CRUD[w.widgetId] ?? []).map((spec) => {
      const inputs = spec.inputs?.(facts) ?? [];
      const callWith = (values: InputValues): VerbCall => {
        const resolved: Record<string, string> = {};
        for (const input of inputs) resolved[input.id] = inputValue(values, input);
        return makeVerbCall(spec.verb, spec.params(facts, resolved), {
          who: opts.actor,
          what: facts.label,
          when,
          where: opts.where,
          why: opts.why,
        });
      };
      return {
        id: spec.id,
        label: spec.label,
        inputs,
        ...(spec.note ? { note: spec.note } : {}),
        call: callWith({}),
        callWith,
      };
    });
    return {
      widgetId: w.widgetId,
      title: w.title,
      ...(w.tabs ? { tabs: w.tabs } : {}),
      identity: state?.identity ?? `${w.title} · ${facts.label} — ${w.detail}`,
      applied: state?.lines ?? [],
      actions,
    };
  });
}
