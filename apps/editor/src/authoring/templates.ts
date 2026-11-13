/**
 * The templating system — pseudo version control for presentation.
 *
 * A view template is DATA, not code: it names a slot and describes the
 * interface for that slot as a regions tree of pane instances — each
 * pane a reference into the component registry below, with data
 * bindings, visibility predicates, verb-only actions, and Mustache
 * content (the VC + templating design, T1: EDITOR-VC-TEMPLATING-DESIGN).
 * It also names — by reference only — the widget ids it can summon and
 * the hierarchy role filters it exposes (both drawn from the existing
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
import { validateProvenance, verbByName, type Provenance } from "./verbs.js";

export type TemplateStatus = "draft" | "published" | "deprecated" | "retired";

/** The status chain, in order. Transitions move exactly one step forward. */
export const TEMPLATE_STATUS_CHAIN: readonly TemplateStatus[] = ["draft", "published", "deprecated", "retired"];

// ------------------------------------------------- interface templates (T1)

/**
 * Where a pane binding reads from. `graph` = the Graphify ECS graph
 * (object → entity → components → fields), `editor` = editor/session
 * state (selection, scene, transport), `live` = the live overlay
 * (streaming values; panes bound here carry the live decorators).
 */
export type InterfaceBindingSource = "graph" | "editor" | "live";

export interface InterfaceBinding {
  /** Name the rest of the pane instance references (predicates, action args). Unique within the pane. */
  name: string;
  source: InterfaceBindingSource;
  /** Dotted path inside the source (e.g. "selection.object.components"). Paths are data, never expressions. */
  path: string;
}

export type InterfacePlayState = "edit" | "simulate" | "play" | "paused";

/**
 * Visibility as data: a pane instance shows when its predicate holds for
 * the current context. This is "only show what's necessary at that
 * moment" in a form the resolver can validate and the shell can evaluate
 * without any code living in the template.
 */
export type InterfacePredicate =
  | { kind: "always" }
  | { kind: "hasSelection" }
  | { kind: "selectionKind"; kinds: readonly string[] }
  | { kind: "hasComponent"; component: string }
  | { kind: "playState"; states: readonly InterfacePlayState[] }
  | { kind: "bindingPresent"; binding: string }
  | { kind: "all"; predicates: readonly InterfacePredicate[] }
  | { kind: "any"; predicates: readonly InterfacePredicate[] }
  | { kind: "not"; predicate: InterfacePredicate };

/** One action argument: from a pane binding, a literal, or a Mustache template rendered against the binding context. */
export type InterfaceArgumentValue = { fromBinding: string } | { literal: string | number | boolean | null } | { template: string };

export interface InterfaceAction {
  /** Unique within the pane instance. */
  id: string;
  /** A canonical verb name or alias (verbs.ts) — actions name verbs, never code. */
  verb: string;
  /** Optional Mustache label template. */
  label?: string;
  args?: Readonly<Record<string, InterfaceArgumentValue>>;
  when?: InterfacePredicate;
}

/**
 * Pane text as Mustache templates, rendered against the pane's binding
 * context (T2 renders; T1 validates tag/section balance). Content only —
 * Mustache is the expression layer, never the layout format.
 */
export interface InterfaceContent {
  title?: string;
  body?: string;
  empty?: string;
  /** Named Mustache partials this pane's templates can include. */
  partials?: Readonly<Record<string, string>>;
}

export interface InterfacePaneInstance {
  /** Instance id, unique across the whole template — this is what semantic diffs key on. */
  id: string;
  /** Component type from INTERFACE_COMPONENTS — a reference, never code. */
  component: string;
  bindings?: readonly InterfaceBinding[];
  visibleWhen?: InterfacePredicate;
  actions?: readonly InterfaceAction[];
  content?: InterfaceContent;
  /** Component-specific configuration; plain JSON data only. */
  config?: Readonly<Record<string, unknown>>;
}

export type InterfaceMobilePresentation = "inline" | "drawer" | "bottom-sheet" | "hidden";

export interface InterfaceRegion {
  /** Region id, unique across the whole template. */
  id: string;
  direction?: "row" | "column" | "stack";
  /** Size token the shell interprets ("1fr", "320px", …) — presentation data, not a layout engine. */
  size?: string;
  /** How this region presents on the phone-shaped view. */
  mobile?: { presentation: InterfaceMobilePresentation };
  panes?: readonly InterfacePaneInstance[];
  children?: readonly InterfaceRegion[];
}

export interface InterfaceComponentDef {
  id: string;
  kind: "viewport" | "navigation" | "inspector" | "panel" | "widget-stack" | "content";
  label: string;
  /** Binding sources a pane of this type may read from. */
  accepts: readonly InterfaceBindingSource[];
}

/**
 * The component registry: every surface type a template may instantiate.
 * Adding a type is a code change (reviewed, tested); arranging instances
 * of existing types is a template change (drafted, diffed, published,
 * pinned, rolled back). T1 declared the registry in the model; T2 added
 * the shell-chrome types and the shell renders from the registry too.
 */
export const INTERFACE_COMPONENTS: readonly InterfaceComponentDef[] = [
  { id: "hierarchy", kind: "navigation", label: "Hierarchy", accepts: ["editor", "graph"] },
  { id: "stage", kind: "viewport", label: "Scene stage", accepts: ["editor", "graph", "live"] },
  { id: "widgets", kind: "widget-stack", label: "Summoned widgets", accepts: ["editor", "graph", "live"] },
  { id: "modules-panel", kind: "panel", label: "Modules panel", accepts: ["editor"] },
  { id: "ecs-inspector", kind: "inspector", label: "ECS inspector", accepts: ["editor", "graph", "live"] },
  { id: "data-tables", kind: "panel", label: "Data tables", accepts: ["editor"] },
  { id: "content", kind: "content", label: "Templated content", accepts: ["editor", "graph", "live"] },
  { id: "shell-menu-bar", kind: "navigation", label: "Shell menu bar", accepts: ["editor"] },
  { id: "shell-workspace-nav", kind: "navigation", label: "Workspace navigation", accepts: ["editor"] },
  { id: "shell-tool-bar", kind: "panel", label: "Shell tool bar", accepts: ["editor"] },
  { id: "shell-view-tabs", kind: "navigation", label: "View tabs", accepts: ["editor"] },
  { id: "workspace-stage", kind: "viewport", label: "Workspace stage", accepts: ["editor", "live"] },
  { id: "shell-dock", kind: "panel", label: "Shell dock", accepts: ["editor"] },
  { id: "shell-status-bar", kind: "panel", label: "Shell status bar", accepts: ["editor", "live"] },
];

const COMPONENT_BY_ID: ReadonlyMap<string, InterfaceComponentDef> = new Map(INTERFACE_COMPONENTS.map((c) => [c.id, c]));

/** Resolve a component type id to its registry def; undefined = not a registered component. */
export function interfaceComponentById(id: string): InterfaceComponentDef | undefined {
  return COMPONENT_BY_ID.get(id);
}

export interface ViewTemplateDefinition {
  /** The layout as a regions tree: named regions, their pane instances, their mobile shape. */
  regions: readonly InterfaceRegion[];
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

const BINDING_SOURCES: readonly string[] = ["graph", "editor", "live"];
const PLAY_STATES: readonly string[] = ["edit", "simulate", "play", "paused"];
const REGION_DIRECTIONS: readonly string[] = ["row", "column", "stack"];
const MOBILE_PRESENTATIONS: readonly string[] = ["inline", "drawer", "bottom-sheet", "hidden"];
const BINDING_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

/**
 * Schema-level Mustache check: every tag closed, every section closed by
 * the name that opened it. Rendering is T2; this is what lets the
 * resolver refuse a malformed content template before it can render.
 */
function mustacheProblems(text: string, where: string): string[] {
  const problems: string[] = [];
  const sections: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open === -1) break;
    const triple = text.startsWith("{{{", open);
    const closeToken = triple ? "}}}" : "}}";
    const end = text.indexOf(closeToken, open + (triple ? 3 : 2));
    if (end === -1) {
      problems.push(`${where}: unclosed "{{" tag`);
      break;
    }
    if (!triple) {
      const tag = text.slice(open + 2, end).trim();
      const sigil = tag.charAt(0);
      if (sigil === "#" || sigil === "^") sections.push(tag.slice(1).trim());
      else if (sigil === "/") {
        const name = tag.slice(1).trim();
        const expected = sections.pop();
        if (expected !== name) problems.push(`${where}: section "{{/${name}}}" ${expected ? `closes "{{#${expected}}}"` : "has no opening section"}`);
      }
    }
    i = end + closeToken.length;
  }
  for (const name of sections) problems.push(`${where}: section "{{#${name}}}" is never closed`);
  return problems;
}

function predicateProblems(predicate: InterfacePredicate, where: string, bindingNames: ReadonlySet<string>, problems: string[], depth: number): void {
  if (depth > 8) {
    problems.push(`${where}: predicate nesting is too deep (max 8)`);
    return;
  }
  if (!predicate || typeof predicate !== "object") {
    problems.push(`${where}: predicate must be an object`);
    return;
  }
  switch (predicate.kind) {
    case "always":
    case "hasSelection":
      return;
    case "selectionKind":
      if (!Array.isArray(predicate.kinds) || predicate.kinds.length === 0 || predicate.kinds.some((k) => typeof k !== "string" || k === "")) problems.push(`${where}: selectionKind needs a non-empty kinds list`);
      return;
    case "hasComponent":
      if (typeof predicate.component !== "string" || predicate.component === "") problems.push(`${where}: hasComponent needs a component name`);
      return;
    case "playState":
      if (!Array.isArray(predicate.states) || predicate.states.length === 0) problems.push(`${where}: playState needs a non-empty states list`);
      else for (const s of predicate.states) if (!PLAY_STATES.includes(s)) problems.push(`${where}: unknown play state "${s}"`);
      return;
    case "bindingPresent":
      if (!bindingNames.has(predicate.binding)) problems.push(`${where}: bindingPresent references unknown binding "${predicate.binding}" in this pane`);
      return;
    case "all":
    case "any":
      if (!Array.isArray(predicate.predicates) || predicate.predicates.length === 0) problems.push(`${where}: ${predicate.kind} needs a non-empty predicates list`);
      else for (const p of predicate.predicates) predicateProblems(p, where, bindingNames, problems, depth + 1);
      return;
    case "not":
      predicateProblems(predicate.predicate, where, bindingNames, problems, depth + 1);
      return;
    default:
      problems.push(`${where}: unknown predicate kind "${(predicate as unknown as { kind: string }).kind}"`);
  }
}

function argumentProblems(value: InterfaceArgumentValue, where: string, bindingNames: ReadonlySet<string>, problems: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${where}: argument must be { fromBinding }, { literal }, or { template }`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    problems.push(`${where}: argument needs exactly one of fromBinding / literal / template`);
    return;
  }
  if ("fromBinding" in value) {
    if (!bindingNames.has(value.fromBinding)) problems.push(`${where}: argument references unknown binding "${value.fromBinding}" in this pane`);
  } else if ("template" in value) {
    if (typeof value.template !== "string") problems.push(`${where}: template argument must be a string`);
    else problems.push(...mustacheProblems(value.template, where));
  } else if (!("literal" in value)) {
    problems.push(`${where}: argument needs exactly one of fromBinding / literal / template`);
  }
}

/**
 * Full definition validation: the reference checks (validateTemplateRefs)
 * plus the interface structure — regions tree shape, pane instances
 * against the component registry, binding sources and paths, predicate
 * and action references (verbs only, bindings by name), and Mustache
 * content balance. The resolver refuses — and falls back on — any
 * template with problems, so a malformed interface can never render.
 */
export function validateTemplateDefinition(template: ViewTemplate): string[] {
  const problems: string[] = [...validateTemplateRefs(template)];
  const label = `template ${keyOf(template.id, template.version)}`;
  const def = template.definition;
  if (!def || !Array.isArray(def.regions)) {
    problems.push(`${label} definition has no regions tree`);
    return problems;
  }
  const regionIds = new Set<string>();
  const paneIds = new Set<string>();

  const visitPane = (pane: InterfacePaneInstance, regionId: string): void => {
    if (!pane || typeof pane.id !== "string" || pane.id === "") {
      problems.push(`${label} has a pane with no id in region "${regionId}"`);
      return;
    }
    const where = `${label} pane "${pane.id}" in region "${regionId}"`;
    if (paneIds.has(pane.id)) problems.push(`${label} reuses pane instance id "${pane.id}" — instance ids are unique across a template`);
    paneIds.add(pane.id);
    const component = interfaceComponentById(pane.component);
    if (!component) {
      problems.push(`${where} references unknown component "${pane.component}"`);
      return;
    }
    const bindingNames = new Set<string>();
    for (const binding of pane.bindings ?? []) {
      if (!binding || typeof binding.name !== "string" || binding.name === "") {
        problems.push(`${where} has a binding with no name`);
        continue;
      }
      if (bindingNames.has(binding.name)) problems.push(`${where} reuses binding name "${binding.name}"`);
      bindingNames.add(binding.name);
      if (!BINDING_SOURCES.includes(binding.source)) problems.push(`${where} binding "${binding.name}" has unknown source "${binding.source}"`);
      else if (!component.accepts.includes(binding.source)) problems.push(`${where} binding "${binding.name}" reads from "${binding.source}", which component "${component.id}" does not accept`);
      if (typeof binding.path !== "string" || !BINDING_PATH.test(binding.path)) problems.push(`${where} binding "${binding.name}" has a malformed path "${binding.path}"`);
    }
    if (pane.visibleWhen) predicateProblems(pane.visibleWhen, `${where} visibleWhen`, bindingNames, problems, 0);
    const actionIds = new Set<string>();
    for (const action of pane.actions ?? []) {
      if (!action || typeof action.id !== "string" || action.id === "") {
        problems.push(`${where} has an action with no id`);
        continue;
      }
      if (actionIds.has(action.id)) problems.push(`${where} reuses action id "${action.id}"`);
      actionIds.add(action.id);
      if (!verbByName(action.verb)) problems.push(`${where} action "${action.id}" references unknown verb "${action.verb}"`);
      if (action.label !== undefined) {
        if (typeof action.label !== "string") problems.push(`${where} action "${action.id}" label must be a Mustache template string`);
        else problems.push(...mustacheProblems(action.label, `${where} action "${action.id}" label`));
      }
      if (action.when) predicateProblems(action.when, `${where} action "${action.id}" when`, bindingNames, problems, 0);
      for (const [argName, argValue] of Object.entries(action.args ?? {})) argumentProblems(argValue, `${where} action "${action.id}" arg "${argName}"`, bindingNames, problems);
    }
    if (pane.content) {
      for (const field of ["title", "body", "empty"] as const) {
        const text = pane.content[field];
        if (text !== undefined) {
          if (typeof text !== "string") problems.push(`${where} content.${field} must be a Mustache template string`);
          else problems.push(...mustacheProblems(text, `${where} content.${field}`));
        }
      }
      for (const [name, partial] of Object.entries(pane.content.partials ?? {})) {
        if (typeof partial !== "string") problems.push(`${where} partial "${name}" must be a Mustache template string`);
        else problems.push(...mustacheProblems(partial, `${where} partial "${name}"`));
      }
    }
    if (pane.config !== undefined && (typeof pane.config !== "object" || pane.config === null || Array.isArray(pane.config))) problems.push(`${where} config must be a plain object`);
  };

  const visitRegion = (region: InterfaceRegion): void => {
    if (!region || typeof region.id !== "string" || region.id === "") {
      problems.push(`${label} has a region with no id`);
      return;
    }
    if (regionIds.has(region.id)) problems.push(`${label} reuses region id "${region.id}" — region ids are unique across a template`);
    regionIds.add(region.id);
    if (region.direction !== undefined && !REGION_DIRECTIONS.includes(region.direction)) problems.push(`${label} region "${region.id}" has unknown direction "${region.direction}"`);
    if (region.size !== undefined && (typeof region.size !== "string" || region.size === "")) problems.push(`${label} region "${region.id}" has an empty size token`);
    if (region.mobile !== undefined && !MOBILE_PRESENTATIONS.includes(region.mobile.presentation)) problems.push(`${label} region "${region.id}" has unknown mobile presentation "${region.mobile?.presentation}"`);
    for (const pane of region.panes ?? []) visitPane(pane, region.id);
    for (const child of region.children ?? []) visitRegion(child);
  };

  for (const region of def.regions) visitRegion(region);
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
  private readonly listeners = new Set<(slot: string) => void>();

  /** Be told, with the slot, after a pin (or a rollback, which is a pin) moves: what lets a running UI follow its pins. Returns the unsubscribe. */
  subscribe(listener: (slot: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

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
    for (const l of [...this.listeners]) l(slot);
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
export const SHELL_TEMPLATE_ID = "current-shell";
export const LEGACY_SHELL_TEMPLATE_ID = "legacy-shell";

/** Each slot's built-in legacy template: the resolver's fallback of last resort for that slot. */
const LEGACY_TEMPLATE_IDS: Readonly<Record<string, string>> = {
  authoring: LEGACY_TEMPLATE_ID,
  shell: LEGACY_SHELL_TEMPLATE_ID,
};

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
      const refProblems = validateTemplateDefinition(template);
      if (refProblems.length > 0) return this.fallback(slot, registry, refProblems.join("; "));
      this.knownGood.set(slot, template);
      return { slot, template, deprecated: template.status === "deprecated" };
    }
    return this.fallback(slot, registry, `no pin for slot "${slot}"`);
  }

  private fallback(slot: string, registry: TemplateRegistry, reason: string): Resolution {
    const good = this.knownGood.get(slot);
    if (good && good.status !== "retired" && validateTemplateDefinition(good).length === 0) {
      return { slot, template: good, deprecated: good.status === "deprecated", fallbackReason: `${reason} — fell back to the last known-good ${keyOf(good.id, good.version)}` };
    }
    const legacy = registry.versionsOf(LEGACY_TEMPLATE_IDS[slot] ?? LEGACY_TEMPLATE_ID).find((t) => t.slot === slot && t.status !== "retired" && t.status !== "draft");
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

/** Built-in templates, all addressable by pin from day one: two for the authoring slot (T1), two for the shell slot (T2). */
export function createBuiltinRegistry(provenance: Provenance): TemplateRegistry {
  const registry = new TemplateRegistry();
  registry.register(
    {
      id: LEGACY_TEMPLATE_ID,
      slot: "authoring",
      version: 1,
      status: "published",
      definition: {
        regions: [
          {
            id: "legacy-main",
            direction: "row",
            panes: [
              { id: "modules", component: "modules-panel", bindings: [{ name: "modules", source: "editor", path: "project.modules" }] },
              {
                id: "inspector",
                component: "ecs-inspector",
                bindings: [
                  { name: "selection", source: "editor", path: "selection" },
                  { name: "liveEntity", source: "live", path: "selection.entity" },
                ],
              },
              { id: "tables", component: "data-tables", bindings: [{ name: "tables", source: "editor", path: "project.dataTables" }] },
            ],
          },
        ],
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
        regions: [
          {
            id: "authoring-main",
            direction: "row",
            children: [
              {
                id: "left-rail",
                direction: "column",
                size: "1fr",
                mobile: { presentation: "drawer" },
                panes: [
                  {
                    id: "hierarchy",
                    component: "hierarchy",
                    bindings: [
                      { name: "tree", source: "editor", path: "scene.hierarchy" },
                      { name: "scene", source: "graph", path: "scene" },
                      { name: "selection", source: "editor", path: "selection" },
                    ],
                    content: { title: "Hierarchy — {{scene.name}}" },
                  },
                ],
              },
              {
                id: "center",
                direction: "column",
                size: "2fr",
                panes: [
                  {
                    id: "stage",
                    component: "stage",
                    bindings: [
                      { name: "scene", source: "graph", path: "scene" },
                      { name: "selection", source: "editor", path: "selection" },
                      { name: "liveSelection", source: "live", path: "selection" },
                    ],
                  },
                ],
              },
              {
                id: "right-shelf",
                direction: "column",
                size: "1fr",
                mobile: { presentation: "bottom-sheet" },
                panes: [
                  {
                    id: "widgets",
                    component: "widgets",
                    bindings: [
                      { name: "selection", source: "editor", path: "selection" },
                      { name: "facts", source: "graph", path: "selection.facts" },
                    ],
                    visibleWhen: { kind: "hasSelection" },
                    content: { title: "Widgets — {{selection.name}}", empty: "Select something in the scene" },
                  },
                ],
              },
            ],
          },
        ],
        widgets: [...WIDGET_IDS],
        filters: ROLE_FILTERS.map((f) => f.id),
      },
    },
    provenance,
  );
  registry.register(
    {
      id: LEGACY_SHELL_TEMPLATE_ID,
      slot: "shell",
      version: 1,
      status: "published",
      definition: {
        regions: [
          {
            id: "shell",
            direction: "column",
            children: [
              {
                id: "shell-top",
                direction: "row",
                panes: [
                  { id: "menu-bar", component: "shell-menu-bar", bindings: [{ name: "workspace", source: "editor", path: "shell.workspace" }] },
                ],
              },
              {
                id: "shell-main",
                direction: "row",
                panes: [
                  { id: "stage", component: "workspace-stage", bindings: [{ name: "view", source: "editor", path: "shell.activeView" }] },
                ],
              },
              {
                id: "shell-status",
                direction: "row",
                panes: [
                  { id: "status-bar", component: "shell-status-bar", bindings: [{ name: "session", source: "editor", path: "shell.session" }] },
                ],
              },
            ],
          },
        ],
        widgets: [],
        filters: [],
      },
    },
    provenance,
  );
  registry.register(
    {
      id: SHELL_TEMPLATE_ID,
      slot: "shell",
      version: 1,
      status: "published",
      definition: {
        regions: [
          {
            id: "shell",
            direction: "column",
            children: [
              {
                id: "shell-top",
                direction: "column",
                panes: [
                  { id: "menu-bar", component: "shell-menu-bar", bindings: [{ name: "workspace", source: "editor", path: "shell.workspace" }] },
                  { id: "workspace-nav", component: "shell-workspace-nav", bindings: [{ name: "workspaces", source: "editor", path: "shell.workspaces" }] },
                  { id: "tool-bar", component: "shell-tool-bar", bindings: [{ name: "toolbar", source: "editor", path: "shell.toolbar" }] },
                ],
              },
              {
                id: "shell-main",
                direction: "row",
                children: [
                  {
                    id: "shell-left",
                    direction: "column",
                    mobile: { presentation: "drawer" },
                    panes: [
                      { id: "dock-left", component: "shell-dock", config: { side: "left" }, bindings: [{ name: "layout", source: "editor", path: "layout.docks" }] },
                    ],
                  },
                  {
                    id: "shell-center",
                    direction: "column",
                    panes: [
                      { id: "view-tabs", component: "shell-view-tabs", bindings: [{ name: "views", source: "editor", path: "shell.views" }] },
                      {
                        id: "stage",
                        component: "workspace-stage",
                        bindings: [
                          { name: "view", source: "editor", path: "shell.activeView" },
                          { name: "liveView", source: "live", path: "view" },
                        ],
                      },
                      { id: "dock-bottom", component: "shell-dock", config: { side: "bottom" }, bindings: [{ name: "layout", source: "editor", path: "layout.docks" }] },
                    ],
                  },
                  {
                    id: "shell-right",
                    direction: "column",
                    mobile: { presentation: "drawer" },
                    panes: [
                      { id: "dock-right", component: "shell-dock", config: { side: "right" }, bindings: [{ name: "layout", source: "editor", path: "layout.docks" }] },
                    ],
                  },
                ],
              },
              {
                id: "shell-status",
                direction: "row",
                panes: [
                  {
                    id: "status-bar",
                    component: "shell-status-bar",
                    bindings: [
                      { name: "session", source: "editor", path: "shell.session" },
                      { name: "server", source: "live", path: "server.status" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        widgets: [],
        filters: [],
      },
    },
    provenance,
  );
  return registry;
}
