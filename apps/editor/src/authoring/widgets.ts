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
 * the add shelf instead (see add-shelf.ts). Two non-verb affordance kinds
 * ride along as dispatch plans through the same executor: component
 * REMOVALS (the flow widget's unbind — the shelf add's inverse) and
 * plan actions for admin surfaces the verbs don't cover (vendor
 * stocking). Neither invents a verb; both are gated by their plan
 * builders in dispatch.ts.
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
import { vendorStockPlan, type DispatchPlan } from "./dispatch.js";
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

/**
 * A component removal the widget offers (the inverse of a shelf add):
 * take one ECS component off the live entity. Not a canonical verb —
 * removals travel as dispatch plans (removeComponentPlan in
 * dispatch.ts) through the same executor as the shelf adds.
 */
export interface ComponentRemoval {
  id: string;
  label: string;
  /** The ECS component the removal takes off the entity (admin removecomponent). */
  component: string;
  /** Plain-language truth rendered with the action. */
  note?: string;
}

/**
 * A widget action that is not a canonical verb but a dispatch plan —
 * for admin surfaces the 13 verbs don't cover (vendor stocking is the
 * first). Inputs work exactly like WidgetAction's: descriptors as
 * data, and `buildPlan` resolves the designer's values through them
 * before the plan builder (the gate) sees them.
 */
export interface WidgetPlanAction {
  id: string;
  label: string;
  inputs: readonly ActionInput[];
  note?: string;
  /** Build the plan with designer-supplied input values applied (descriptor prefills fill any gaps). */
  buildPlan: (values: InputValues) => DispatchPlan;
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
  /** Zone 3 — component removals (unbinds), as dispatch plans. */
  removals: readonly ComponentRemoval[];
  /** Zone 3 — non-verb affordances as dispatch plans (vendor stock). */
  planActions: readonly WidgetPlanAction[];
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
const BAG_NOTE = "Admin bag verbs act on your avatar's bag (the console holder) — they take no character target, so this runs there, not on the selected character.";
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
    {
      id: "take-item",
      label: "Take item",
      verb: "takeItem",
      note: BAG_NOTE,
      inputs: () => [
        { id: "base", label: "Item base (takes one)", kind: "picker", source: "item-bases", placeholder: "Choose a base" },
        { id: "item", label: "or item id", kind: "number", placeholder: "instance id" },
      ],
      params: (_f, v) => {
        const item = parseInputNumber(v.item);
        return { character: "me", ...(v.base ? { base: v.base } : {}), ...(item !== undefined ? { item } : {}) };
      },
    },
    {
      id: "move-item",
      label: "Move item",
      verb: "moveItem",
      note: "Admin move takes the item out of your avatar's bag (the console holder) unless a from id is named in the call — the destination is a character (holder) id, as in an inspect dump's CharacterRef line.",
      inputs: () => [
        { id: "item", label: "Item id", kind: "number", placeholder: "instance id" },
        { id: "to", label: "To character id", kind: "number", placeholder: "holder id" },
      ],
      params: (_f, v) => {
        const item = parseInputNumber(v.item);
        const to = parseInputNumber(v.to);
        return { ...(item !== undefined ? { item } : {}), ...(to !== undefined ? { to } : {}) };
      },
    },
    {
      id: "count-base",
      label: "Count base",
      verb: "countBase",
      note: BAG_NOTE,
      inputs: () => [{ id: "base", label: "Item base", kind: "picker", source: "item-bases", placeholder: "Choose a base" }],
      params: (_f, v) => ({ character: "me", ...(v.base ? { base: v.base } : {}) }),
    },
    {
      id: "def-of",
      label: "Def of item",
      verb: "defOf",
      inputs: () => [{ id: "item", label: "Item id", kind: "number", placeholder: "instance id" }],
      params: (_f, v) => {
        const item = parseInputNumber(v.item);
        return { ...(item !== undefined ? { item } : {}) };
      },
    },
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

interface PlanSpec {
  id: string;
  label: string;
  note?: string;
  /** Input descriptors for this action (may depend on the facts — prefills do). */
  inputs?: (facts: SelectionFacts) => readonly ActionInput[];
  /** The plan from the facts + the RESOLVED input values (every declared input id present, "" when unfilled). */
  plan: (facts: SelectionFacts, values: Readonly<Record<string, string>>) => DispatchPlan;
}

/** Per-widget affordances no canonical verb covers, as dispatch plans. Widgets absent here render no plan actions. */
const PLAN_ACTIONS: Readonly<Record<string, readonly PlanSpec[]>> = {
  vendor: [
    {
      id: "stock-item",
      label: "Stock item",
      note: "Stocks the chosen template — the template must already be defined on the server (vendor define); stocking an undefined one is refused. Items are addressed by exact def name (the name a defOf read or the items browse shows): admin stock looks defs up by name, and a base is a family of defs, not a def. There is no stock read-back in the admin surface — the dispatch reply is the confirmation.",
      inputs: (f) => [
        {
          id: "templateId",
          label: "Vendor template",
          kind: "picker",
          source: "vendor-templates",
          ...(f.vendorTemplateId ? { initial: f.vendorTemplateId } : {}),
          placeholder: "Choose a template",
        },
        { id: "itemName", label: "Item name", kind: "text", placeholder: "Exact def name, e.g. Flaming Mithril Sword" },
        { id: "price", label: "Price (gold)", kind: "number", placeholder: "e.g. 250" },
        { id: "qty", label: "Qty", kind: "number", placeholder: "blank = infinite" },
      ],
      plan: (_f, v) => vendorStockPlan({ templateId: v.templateId, itemName: v.itemName, price: parseInputNumber(v.price), qty: parseInputNumber(v.qty) }),
    },
  ],
};

/** Component removals a widget offers for this selection (unbinds). Only where the component is actually applied. */
function removalsFor(widgetId: string, facts: SelectionFacts): readonly ComponentRemoval[] {
  // The flow widget exists only while a FlowRef is bound (relevance
  // rule 13); its unbind is the removal of that marker component —
  // the inverse of the shelf's "Bind flow graph" add.
  if (widgetId === "flow" && facts.flowRef !== undefined) {
    return [
      {
        id: "unbind-flow",
        label: "Unbind flow graph",
        component: "FlowRef",
        note: "Takes the FlowRef component off the live entity (admin removecomponent) — the graph content itself is not deleted, and re-binding is the shelf's add.",
      },
    ];
  }
  return [];
}

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
    const planActions = (PLAN_ACTIONS[w.widgetId] ?? []).map((spec) => {
      const inputs = spec.inputs?.(facts) ?? [];
      const buildPlan = (values: InputValues): DispatchPlan => {
        const resolved: Record<string, string> = {};
        for (const input of inputs) resolved[input.id] = inputValue(values, input);
        return spec.plan(facts, resolved);
      };
      return {
        id: spec.id,
        label: spec.label,
        inputs,
        ...(spec.note ? { note: spec.note } : {}),
        buildPlan,
      };
    });
    return {
      widgetId: w.widgetId,
      title: w.title,
      ...(w.tabs ? { tabs: w.tabs } : {}),
      identity: state?.identity ?? `${w.title} · ${facts.label} — ${w.detail}`,
      applied: state?.lines ?? [],
      actions,
      removals: removalsFor(w.widgetId, facts),
      planActions,
    };
  });
}
