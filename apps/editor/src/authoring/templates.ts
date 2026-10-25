/**
 * The templating system — pseudo version control for presentation.
 *
 * A view template is DATA, not code: it names a slot, a layout, panes,
 * and — by reference only — the widget ids it can summon and the
 * hierarchy role filters it exposes (both drawn from the existing
 * registries in relevance.ts / hierarchy.ts). Which template version a
 * project actually presents is decided by ONE thing: the presentation
 * pin for that slot. Moving the pin is the retirement step for an old
 * view; rolling the pin back restores it. Nothing is deleted cold.
 *
 * Version rules:
 * - Published versions are immutable. An edit creates a NEW draft
 *   version (next number); it never touches an earlier published one.
 * - Status moves along one chain — draft → published → deprecated →
 *   retired — and every transition carries a 5W1H provenance entry
 *   (validated by the same validateProvenance the verb layer uses).
 * - A retired version cannot be newly pinned. A version that is
 *   currently pinned cannot be retired — the pin must move first
 *   (the graceful-retirement gate). A deprecated-but-pinned version
 *   still resolves, with the deprecation flagged.
 *
 * Resolution is defensive: an unknown template id, an unknown version,
 * a retired target, or a definition referencing an unknown widget or
 * filter makes the resolver refuse the pin and fall back to the last
 * known-good resolution for the slot (or the built-in legacy template),
 * reporting the reason. It never yields a broken or blank view.
 */

import { ROLE_FILTERS } from "./hierarchy.js";
import { WIDGET_IDS } from "./relevance.js";
import { validateProvenance, type Provenance } from "./verbs.js";

export type TemplateStatus = "draft" | "published" | "deprecated" | "retired";

/** The status chain, in order. Transitions move exactly one step forward. */
export const TEMPLATE_STATUS_CHAIN: readonly TemplateStatus[] = ["draft", "published", "deprecated", "retired"];

export interface ViewTemplateDefinition {
  /** Layout identifier (a named arrangement the shell knows how to mount). */
  layout: string;
  /** Pane identifiers shown in that layout. */
  panes: readonly string[];
  /** Widget ids this view can summon — references into the relevance registry, never code. */
  widgets: readonly string[];
  /** Hierarchy role-filter ids this view exposes — references into the hierarchy registry. */
  filters: readonly string[];
}

export interface TemplateHistoryEntry {
  action: "create" | "edit" | "publish" | "deprecate" | "retire";
  from?: TemplateStatus;
  to?: TemplateStatus;
  provenance: Provenance;
}

export interface ViewTemplate {
  id: string;
  /** The presentation slot this template can fill ("authoring", …). */
  slot: string;
  version: number;
  status: TemplateStatus;
  definition: ViewTemplateDefinition;
  history: readonly TemplateHistoryEntry[];
}

const keyOf = (id: string, version: number): string => `${id}@${version}`;

function mustProvenance(p: Provenance): void {
  const problems = validateProvenance(p);
  if (problems.length > 0) throw new Error(problems.join("; "));
}

// ------------------------------------------------------------- registry

export class TemplateRegistry {
  private readonly templates = new Map<string, ViewTemplate>();

  /** Register a template version (usually a draft; builtins register published). Duplicate id@version is refused. */
  register(template: Omit<ViewTemplate, "history">, provenance: Provenance): ViewTemplate {
    mustProvenance(provenance);
    const key = keyOf(template.id, template.version);
    if (this.templates.has(key)) throw new Error(`template ${key} already exists — versions are immutable, create a new one`);
    const entry: ViewTemplate = { ...template, history: [{ action: "create", to: template.status, provenance }] };
    this.templates.set(key, entry);
    return entry;
  }

  get(id: string, version: number): ViewTemplate | undefined {
    return this.templates.get(keyOf(id, version));
  }

  /** All versions of one template id, ascending. */
  versionsOf(id: string): readonly ViewTemplate[] {
    return [...this.templates.values()].filter((t) => t.id === id).sort((a, b) => a.version - b.version);
  }

  /**
   * Edit a template: creates the NEXT version as a draft carrying the new
   * definition. Earlier versions — published above all — are never mutated.
   */
  edit(id: string, definition: ViewTemplateDefinition, provenance: Provenance): ViewTemplate {
    mustProvenance(provenance);
    const versions = this.versionsOf(id);
    if (versions.length === 0) throw new Error(`unknown template "${id}"`);
    const latest = versions[versions.length - 1];
    const entry: ViewTemplate = {
      id,
      slot: latest.slot,
      version: latest.version + 1,
      status: "draft",
      definition,
      history: [{ action: "edit", to: "draft", provenance }],
    };
    this.templates.set(keyOf(id, entry.version), entry);
    return entry;
  }

  /** Move one step along the status chain, recording provenance on the template itself. */
  transition(id: string, version: number, to: TemplateStatus, provenance: Provenance): ViewTemplate {
    mustProvenance(provenance);
    const entry = this.get(id, version);
    if (!entry) throw new Error(`unknown template ${keyOf(id, version)}`);
    const from = entry.status;
    if (TEMPLATE_STATUS_CHAIN.indexOf(to) !== TEMPLATE_STATUS_CHAIN.indexOf(from) + 1) {
      throw new Error(`illegal template transition ${from} → ${to} — status moves one step along draft → published → deprecated → retired`);
    }
    const action = to === "published" ? "publish" : to === "deprecated" ? "deprecate" : "retire";
    const next: ViewTemplate = { ...entry, status: to, history: [...entry.history, { action, from, to, provenance }] };
    this.templates.set(keyOf(id, version), next);
    return next;
  }
}

/** Reference check: every widget/filter id a definition names must exist in the registries. */
export function validateTemplateRefs(template: ViewTemplate): string[] {
  const problems: string[] = [];
  for (const w of template.definition.widgets) if (!WIDGET_IDS.includes(w)) problems.push(`template ${keyOf(template.id, template.version)} references unknown widget "${w}"`);
  const filterIds = ROLE_FILTERS.map((f) => f.id as string);
  for (const f of template.definition.filters) if (!filterIds.includes(f)) problems.push(`template ${keyOf(template.id, template.version)} references unknown filter "${f}"`);
  return problems;
}

// ----------------------------------------------------------------- pins

export interface PresentationPin {
  templateId: string;
  version: number;
}

export interface PinHistoryEntry {
  slot: string;
  from?: PresentationPin;
  to: PresentationPin;
  provenance: Provenance;
}

/**
 * Per-project presentation pins: { slot → templateId@version }, with a
 * provenance-carrying change history. The pin — and only the pin —
 * decides which UI version a slot presents.
 */
export class PresentationPins {
  private readonly pins = new Map<string, PresentationPin>();
  private readonly history: PinHistoryEntry[] = [];

  get(slot: string): PresentationPin | undefined {
    return this.pins.get(slot);
  }

  entries(): ReadonlyMap<string, PresentationPin> {
    return this.pins;
  }

  pinHistory(): readonly PinHistoryEntry[] {
    return this.history;
  }

  /** Pin a slot to a template version. Refused: unknown template/version, or a retired version. */
  pin(slot: string, target: PresentationPin, provenance: Provenance, registry: TemplateRegistry): PresentationPin {
    mustProvenance(provenance);
    const template = registry.get(target.templateId, target.version);
    if (!template) throw new Error(`cannot pin ${slot} to unknown template ${keyOf(target.templateId, target.version)}`);
    if (template.slot !== slot) throw new Error(`template ${target.templateId} fills slot "${template.slot}", not "${slot}"`);
    if (template.status === "retired") throw new Error(`cannot pin ${slot} to retired template ${keyOf(target.templateId, target.version)} — retired versions are not newly pinnable`);
    if (template.status === "draft") throw new Error(`cannot pin ${slot} to draft template ${keyOf(target.templateId, target.version)} — publish it first`);
    const from = this.pins.get(slot);
    this.pins.set(slot, target);
    this.history.push({ slot, ...(from ? { from } : {}), to: target, provenance });
    return target;
  }

  /** Rollback = re-pin the slot's previous distinct target from history. */
  rollback(slot: string, provenance: Provenance, registry: TemplateRegistry): PresentationPin {
    mustProvenance(provenance);
    const current = this.pins.get(slot);
    if (!current) throw new Error(`nothing pinned for slot "${slot}" — nothing to roll back`);
    const previous = [...this.history].reverse().find((h) => h.slot === slot && (h.to.templateId !== current.templateId || h.to.version !== current.version))?.to;
    if (!previous) throw new Error(`no earlier pin for slot "${slot}" in history — nothing to roll back to`);
    return this.pin(slot, previous, provenance, registry);
  }
}

// ------------------------------------------------------------- resolver

export interface Resolution {
  slot: string;
  template: ViewTemplate;
  /** Set when the template's status is deprecated — it resolves, but the UI must show its age. */
  deprecated: boolean;
  /** Set when the pin was refused and this resolution is a fallback. */
  fallbackReason?: string;
}

/** The built-in fallback target per slot when nothing else is known-good. */
export const LEGACY_TEMPLATE_ID = "legacy-data-editor";
export const AUTHORING_TEMPLATE_ID = "viewport-authoring";

/**
 * Stateful resolver: remembers the last known-good resolution per slot,
 * which is what a refused pin falls back to (before the legacy builtin).
 */
export class PresentationResolver {
  private readonly knownGood = new Map<string, ViewTemplate>();

  resolve(slot: string, pins: PresentationPins, registry: TemplateRegistry): Resolution {
    const pin = pins.get(slot);
    if (pin) {
      const template = registry.get(pin.templateId, pin.version);
      if (!template) return this.fallback(slot, registry, `pin points at unknown template ${keyOf(pin.templateId, pin.version)}`);
      if (template.status === "retired") return this.fallback(slot, registry, `pinned template ${keyOf(pin.templateId, pin.version)} is retired`);
      if (template.status === "draft") return this.fallback(slot, registry, `pinned template ${keyOf(pin.templateId, pin.version)} is still a draft`);
      const refProblems = validateTemplateRefs(template);
      if (refProblems.length > 0) return this.fallback(slot, registry, refProblems.join("; "));
      this.knownGood.set(slot, template);
      return { slot, template, deprecated: template.status === "deprecated" };
    }
    return this.fallback(slot, registry, `no pin for slot "${slot}"`);
  }

  private fallback(slot: string, registry: TemplateRegistry, reason: string): Resolution {
    const good = this.knownGood.get(slot);
    if (good && good.status !== "retired" && validateTemplateRefs(good).length === 0) {
      return { slot, template: good, deprecated: good.status === "deprecated", fallbackReason: `${reason} — fell back to the last known-good ${keyOf(good.id, good.version)}` };
    }
    const legacy = registry.versionsOf(LEGACY_TEMPLATE_ID).find((t) => t.slot === slot && t.status !== "retired" && t.status !== "draft");
    if (legacy) {
      this.knownGood.set(slot, legacy);
      return { slot, template: legacy, deprecated: legacy.status === "deprecated", fallbackReason: `${reason} — fell back to the built-in legacy template ${keyOf(legacy.id, legacy.version)}` };
    }
    throw new Error(`cannot resolve slot "${slot}": ${reason}, and no legacy template is registered for the slot`);
  }
}

/**
 * The graceful-retirement gate, joining registry + pins: a version that
 * any slot currently pins cannot be retired. The pin must move first.
 */
export function retireTemplate(registry: TemplateRegistry, pins: PresentationPins, id: string, version: number, provenance: Provenance): ViewTemplate {
  for (const [slot, pin] of pins.entries()) {
    if (pin.templateId === id && pin.version === version) {
      throw new Error(`cannot retire ${keyOf(id, version)} — slot "${slot}" currently pins it. Move the pin first; that move IS the retirement step.`);
    }
  }
  const entry = registry.get(id, version);
  if (!entry) throw new Error(`unknown template ${keyOf(id, version)}`);
  // Retire moves along the chain; a published version passes through deprecated in the same gate call chain.
  if (entry.status === "published") registry.transition(id, version, "deprecated", provenance);
  return registry.transition(id, version, "retired", provenance);
}

// -------------------------------------------------------------- builtins

/** Built-in templates, both addressable by pin from day one. */
export function createBuiltinRegistry(provenance: Provenance): TemplateRegistry {
  const registry = new TemplateRegistry();
  registry.register(
    {
      id: LEGACY_TEMPLATE_ID,
      slot: "authoring",
      version: 1,
      status: "published",
      definition: {
        layout: "workspace-tabs",
        panes: ["modules-panel", "ecs-inspector", "data-tables"],
        widgets: [],
        filters: [],
      },
    },
    provenance,
  );
  registry.register(
    {
      id: AUTHORING_TEMPLATE_ID,
      slot: "authoring",
      version: 1,
      status: "published",
      definition: {
        layout: "authoring-three-pane",
        panes: ["hierarchy", "stage", "widgets"],
        widgets: [...WIDGET_IDS],
        filters: ROLE_FILTERS.map((f) => f.id),
      },
    },
    provenance,
  );
  return registry;
}
