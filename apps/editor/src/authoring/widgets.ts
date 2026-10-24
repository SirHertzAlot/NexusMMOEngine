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
 */

import { evaluateRelevance, type AppliedWidget } from "./relevance.js";
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
  /** The resolved mutation: a canonical verb + full provenance envelope. */
  call: VerbCall;
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
  params: (facts: SelectionFacts) => Record<string, unknown>;
}

/** Per-widget CRUD that a canonical verb honestly covers. Widgets absent here render no verb actions. */
const CRUD: Readonly<Record<string, readonly CrudSpec[]>> = {
  vendor: [
    { id: "change-template", label: "Change template", verb: "attachVendor", params: (f) => ({ entity: f.id, templateId: f.vendorTemplateId ?? "" }) },
    { id: "detach", label: "Detach vendor", verb: "detachVendor", params: (f) => ({ entity: f.id }) },
  ],
  character: [
    { id: "give-item", label: "Give item", verb: "giveItem", params: (f) => ({ character: f.id, def: "" }) },
    { id: "give-gold", label: "Give gold", verb: "giveGold", params: (f) => ({ character: f.id, amount: 0 }) },
  ],
  items: [
    { id: "take-item", label: "Take item", verb: "takeItem", params: (f) => ({ character: f.id, item: "" }) },
    { id: "move-item", label: "Move item", verb: "moveItem", params: (f) => ({ item: f.id, from: "", to: "" }) },
    { id: "count-base", label: "Count base", verb: "countBase", params: (f) => ({ character: f.id, base: "" }) },
  ],
  quests: [
    { id: "grant-reward", label: "Grant quest reward", verb: "grantQuestReward", params: (f) => ({ character: f.id, rewards: [] }) },
    { id: "start-dialogue", label: "Start dialogue", verb: "startDialogue", params: (f) => ({ npc: f.id, player: "" }) },
  ],
  creature: [{ id: "spawn-pack", label: "Spawn pack", verb: "spawnPack", params: (f) => ({ kind: f.creatureKind ?? "", x: 0, z: 0 }) }],
  dungeons: [{ id: "grant-reward", label: "Give item reward", verb: "giveItem", params: (f) => ({ character: "", def: "" }) }],
  physics: [{ id: "teleport", label: "Teleport here", verb: "teleport", params: (f) => ({ entity: f.id, x: 0, z: 0 }) }],
};

/** Build the widget stack for one selection. Throws if the actor/why envelope is invalid — anonymous UI is a bug. */
export function buildWidgets(facts: SelectionFacts, opts: BuildWidgetsOptions): readonly WidgetViewModel[] {
  const when = opts.when ?? Date.now();
  return evaluateRelevance(facts).applied.map((w: AppliedWidget) => {
    const state = opts.state?.[w.widgetId];
    const actions = (CRUD[w.widgetId] ?? []).map((spec) => ({
      id: spec.id,
      label: spec.label,
      call: makeVerbCall(spec.verb, spec.params(facts), {
        who: opts.actor,
        what: facts.label,
        when,
        where: opts.where,
        why: opts.why,
      }),
    }));
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
