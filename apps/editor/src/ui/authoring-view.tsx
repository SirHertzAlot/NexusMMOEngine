/**
 * Authoring view — the Designer surface (Phase B, first slice).
 *
 * View-centered, no-code authoring over the pure model layer in
 * ../authoring/: the hierarchy pane is the relationship navigator
 * (containment + role filters + saved views), selecting a node writes
 * the SAME editorSelection store the scenes panel and viewport use, and
 * the selection summons its widget stack + add shelf from the relevance
 * rules — no module panels, no component tables.
 *
 * Layout discipline (Joey, 2026-10-24, refined through the evening):
 * first the centered view pane (quarter / half / quarter), then
 * EMBEDDED panels (the pattern of VSCode / Blender / Unity /
 * PlayCanvas), then — the current model — FLOATING widgets: the
 * workspace is one view pane; the hierarchy dock (left edge), the
 * add-shelf strip (right edge), the identity bar (top) and the
 * history strip (bottom) dock INSIDE it and collapse, returning
 * their space to the center viewport-focus zone; and the selection
 * widgets FLOAT inside the pane, summoned by the selection —
 * restoring Joey's original 2026-10-17 design ("clicking a game
 * object summons contextual widgets within the viewport"). The
 * floating stack is dismissible (view state only) and re-summons on
 * the next pick. See docs/EDITOR-AUTHORING.md.
 *
 * Honest scope of this slice:
 * - The stage is a panel, not the 3D viewport: it shows the selected
 *   object's identity and its reference edges. The live viewport stays
 *   in the Scenes workspace; selection is shared, so picking here is
 *   picking there.
 * - Dispatch is LIVE (dispatch slice): widget CRUD and shelf verb
 *   actions are mapped by ../authoring/dispatch.ts to real admin
 *   commands and executed over the shared serverLink when a play
 *   server is live; the outcome (dispatched / refused / unsupported /
 *   offline, with the server's message) is recorded beside the call in
 *   the session history, and a dispatched mutation re-inspects its
 *   target so the stage shows the read-back. Verbs with no honest
 *   admin home stay unsupported — the mapper says why, per verb.
 *   Component-shaped shelf additions (add Health+Stamina, bind a
 *   marker) are unsupported for a real reason: admin `set` cannot add
 *   a component.
 * - Actions that need a value render real input fields (the model's
 *   input descriptors): item bases and creature kinds come from the
 *   gameplay snapshot the editor already loads; vendor templates from
 *   the running server's own `vendor list` (defined templates only —
 *   offline the picker is honestly empty). Field values flow into the
 *   call's params via `callWith` / `shelfActionParams`; the dispatch
 *   mapper stays the single gate on what was built.
 * - Applied-state lines come from the selection's own component fields
 *   (what the editor already read), never invented server state; after
 *   a dispatch whose read-back target IS this selection, the inspect
 *   lines join them.
 */

import * as React from "react";
import type { SceneDoc, SceneNode } from "@mmo-engine/scene";
import { loadGameplay } from "../gameplay-client.js";
import { getScene, listScenes } from "../scenes-client.js";
import { nodeSelection } from "../viewport-model.js";
import {
  AUTHORING_TEMPLATE_ID,
  LEGACY_TEMPLATE_ID,
  PresentationPins,
  PresentationResolver,
  buildHierarchy,
  buildWidgets,
  createBuiltinRegistry,
  deserializeSavedView,
  evaluateRelevance,
  executeDispatch,
  inputValue,
  inspectTargetForCall,
  makeFacts,
  makeVerbCall,
  parseVendorTemplateList,
  roleFilterById,
  sceneLevelWidgets,
  serializeSavedView,
  shelfActionParams,
  shelfComponentPlan,
  sortNodes,
  visibleShelf,
  VerbHistory,
  ROLE_FILTERS,
  type ActionInput,
  type AppliedState,
  type DispatchOutcome,
  type HierarchyNode,
  type InputValues,
  type PickerSource,
  type PresentationPin,
  type Provenance,
  type RoleFilterId,
  type SavedView,
  type SceneNodeData,
  type SelectionFacts,
  type ShelfEntry,
  type SortMode,
  type VerbCall,
  type WidgetAction,
} from "../authoring/index.js";
import { Button, Chip, EmptyState, Input, MIcon, SectionTitle, Select, notify, useLocalStorage } from "./components.js";
import { EcsInspectorPanel } from "./ecs-inspector.js";
import { ModulesPanel } from "./modules-panel.js";
import { browserStorage, currentProfile } from "./editor-prefs.js";
import { editorSelection, useEditorSelection, type EditorSelection } from "./editor-selection.js";
import { ModalTabs } from "./merged-modals.js";
import { serverLink, useServerLink } from "./server-gate.js";

/** Session history of every verb call this view produced (the provenance log, in-memory for this slice). */
export const authoringHistory = new VerbHistory();

// ------------------------------------------------- presentation templates

const bootstrapProvenance: Provenance = {
  who: { id: "editor", role: "developer" },
  what: "authoring slot presentation",
  when: 1_800_000_000_000,
  where: "Design / Authoring",
  why: "built-in template registration",
};

/** The template registry + pins for the authoring slot (session state; pins are mirrored to local prefs below). */
export const presentationRegistry = createBuiltinRegistry(bootstrapProvenance);
export const presentationPins = new PresentationPins();
export const presentationResolver = new PresentationResolver();
presentationPins.pin("authoring", { templateId: AUTHORING_TEMPLATE_ID, version: 1 }, { ...bootstrapProvenance, why: "default pin: the new authoring view" }, presentationRegistry);

/** The legacy presentation: the old data/module-first panels, kept alive as a template — retired by pin, not deletion. */
function LegacyPresentation(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 gap-3 overflow-hidden p-3">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <SectionTitle>Legacy presentation — modules (data-first)</SectionTitle>
        <ModulesPanel />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <SectionTitle>Legacy presentation — ECS inspector (component-first)</SectionTitle>
        <EcsInspectorPanel />
      </div>
    </div>
  );
}

/**
 * The shell of the Design workspace's panel: a presentation control over
 * the templating system, then whichever presentation the pin resolves to.
 * Switching the pin switches the rendered presentation for real.
 */
export function AuthoringView(): React.JSX.Element {
  const [pinTick, setPinTick] = React.useState(0);
  const [storedPins, setStoredPins] = useLocalStorage<Record<string, PresentationPin>>("authoring-presentation-pins", {
    authoring: { templateId: AUTHORING_TEMPLATE_ID, version: 1 },
  });
  const actor = React.useMemo(() => ({ id: currentProfile(browserStorage()) || "designer", role: "designer" as const }), []);

  // Restore the persisted pin once (pins are the only thing that decides presentation).
  React.useEffect(() => {
    const saved = storedPins.authoring;
    const current = presentationPins.get("authoring");
    if (saved && (saved.templateId !== current?.templateId || saved.version !== current?.version)) {
      try {
        presentationPins.pin("authoring", saved, { who: actor, what: "authoring slot presentation", when: Date.now(), where: "Design / Authoring", why: "restore persisted pin" }, presentationRegistry);
        setPinTick((t) => t + 1);
      } catch {
        // A persisted pin that no longer resolves is refused; the resolver falls back safely.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  void pinTick;
  const resolution = presentationResolver.resolve("authoring", presentationPins, presentationRegistry);
  const active = resolution.template;

  const pinTo = (target: PresentationPin, why: string): void => {
    try {
      presentationPins.pin("authoring", target, { who: actor, what: "authoring slot presentation", when: Date.now(), where: "Design / Authoring", why }, presentationRegistry);
      setStoredPins({ authoring: target });
      setPinTick((t) => t + 1);
      notify(`Pinned the authoring slot to ${target.templateId}@${target.version}.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  const rollback = (): void => {
    try {
      const back = presentationPins.rollback("authoring", { who: actor, what: "authoring slot presentation", when: Date.now(), where: "Design / Authoring", why: "roll back the presentation pin" }, presentationRegistry);
      setStoredPins({ authoring: back });
      setPinTick((t) => t + 1);
      notify(`Rolled the authoring pin back to ${back.templateId}@${back.version}.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--m3-outline-variant)" }}>
        <SectionTitle>Presentation</SectionTitle>
        <span className="text-[13px]">
          {active.id}@{active.version} · {active.status}
          {resolution.deprecated && " · deprecated — still resolving because it is pinned"}
        </span>
        {resolution.fallbackReason && (
          <span className="text-[13px]" style={{ color: "var(--m3-error)" }}>
            {resolution.fallbackReason}
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant={active.id === AUTHORING_TEMPLATE_ID ? "default" : "outline"} onClick={() => pinTo({ templateId: AUTHORING_TEMPLATE_ID, version: 1 }, "pin the new authoring view")}>
            Authoring view
          </Button>
          <Button size="sm" variant={active.id === LEGACY_TEMPLATE_ID ? "default" : "outline"} onClick={() => pinTo({ templateId: LEGACY_TEMPLATE_ID, version: 1 }, "pin the legacy presentation (retirement rehearsal / rollback)")}>
            Legacy view
          </Button>
          <Button size="sm" variant="ghost" onClick={rollback}>
            Roll back pin
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1">{active.id === LEGACY_TEMPLATE_ID ? <LegacyPresentation /> : <AuthoringPresentation />}</div>
    </div>
  );
}

// ------------------------------------------------------------- adapters

function fieldOf(sel: EditorSelection, component: string, keys: readonly string[]): string | undefined {
  const comp = sel.components.find((c) => c.name.toLowerCase() === component.toLowerCase());
  if (!comp) return undefined;
  for (const k of keys) {
    const f = comp.fields.find((x) => x.key.toLowerCase() === k.toLowerCase());
    if (f && f.value !== "") return f.value;
  }
  return comp.fields[0]?.value;
}

function hasSelComponent(sel: EditorSelection, name: string): boolean {
  return sel.components.some((c) => c.name.toLowerCase() === name.toLowerCase());
}

/**
 * The selection's ground position from its Transform fields, when it
 * carries one: scene-node selections carry `position` ("x, y, z"),
 * live-entity selections may carry `px`/`pz`. Absent/unparseable →
 * undefined, and teleport inputs simply start empty.
 */
export function positionFromSelection(sel: EditorSelection): { x: number; z: number } | undefined {
  const t = sel.components.find((c) => c.name.toLowerCase() === "transform");
  if (!t) return undefined;
  const field = (key: string): string | undefined => t.fields.find((f) => f.key.toLowerCase() === key)?.value;
  const px = field("px");
  const pz = field("pz");
  if (px !== undefined && pz !== undefined) {
    const x = Number(px);
    const z = Number(pz);
    if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
  }
  for (const key of ["position", "pos"]) {
    const raw = field(key);
    if (raw === undefined) continue;
    const parts = raw
      .split(/[,\s]+/)
      .filter((s) => s !== "")
      .map(Number);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) return { x: parts[0], z: parts[2] };
  }
  return undefined;
}

/** EditorSelection (the shared store) → SelectionFacts (the authoring layer's input). */
export function factsFromSelection(sel: EditorSelection): SelectionFacts {
  const isQuestGiver = hasSelComponent(sel, "QuestGiver");
  const quest = fieldOf(sel, "QuestGiver", ["quest"]);
  const kind = hasSelComponent(sel, "CharacterRef")
    ? "npc"
    : hasSelComponent(sel, "WorldItem")
      ? "prop"
      : hasSelComponent(sel, "DungeonEntrance")
        ? "dungeon-entrance"
        : hasSelComponent(sel, "Structure")
          ? "structure"
          : sel.kind;
  return makeFacts({
    id: sel.id,
    label: sel.label,
    kind,
    components: sel.components.map((c) => c.name),
    isVendor: hasSelComponent(sel, "Vendor"),
    vendorTemplateId: fieldOf(sel, "Vendor", ["template", "templateId"]),
    creatureKind: fieldOf(sel, "Creature", ["kind", "species"]) ?? fieldOf(sel, "CreatureRef", ["kind", "species"]),
    isQuestGiver,
    questIds: quest ? [quest] : undefined,
    isDungeonEntrance: hasSelComponent(sel, "DungeonEntrance") || hasSelComponent(sel, "Entrance"),
    hasCollider: hasSelComponent(sel, "Collider") || hasSelComponent(sel, "Physics") || hasSelComponent(sel, "PropCollision"),
    flowRef: fieldOf(sel, "FlowRef", ["graph", "graphId", "flow"]),
    vfxEmitter: fieldOf(sel, "VfxEmitter", ["effect", "emitter", "vfx"]),
    audioEmitter: fieldOf(sel, "AudioEmitter", ["clip", "emitter", "audio"]),
    position: positionFromSelection(sel),
  });
}

/** A scene document → flat hierarchy data (containment only; the doc carries no reference edges). */
export function sceneDocToHierarchyData(doc: SceneDoc): SceneNodeData[] {
  const out: SceneNodeData[] = [{ id: `scene:${doc.name}`, name: doc.name, level: "scene", parentId: null, kind: "scene" }];
  const walk = (nodes: readonly SceneNode[], parentId: string, depth: number): void => {
    for (const n of nodes) {
      const kids = n.children ?? [];
      const level = kids.length > 0 ? (depth === 0 ? "region" : "poi") : "object";
      const compNames = ["Transform", ...Object.keys(n.components ?? {})];
      const questGiver = n.components?.QuestGiver;
      const facts = makeFacts({
        id: n.id,
        label: n.name || n.id,
        kind: questGiver ? "npc" : n.components?.Structure ? "structure" : (n.kind ?? "prop"),
        components: compNames,
        isQuestGiver: questGiver !== undefined,
        questIds: questGiver && typeof questGiver.quest === "string" && questGiver.quest !== "" ? [questGiver.quest] : undefined,
        hasCollider: n.components?.Collider !== undefined,
      });
      const pos = n.transform?.position;
      out.push({
        id: n.id,
        name: n.name || n.id,
        level,
        parentId,
        kind: facts.kind,
        facts: pos && pos.length >= 3 ? { ...facts, position: { x: pos[0], z: pos[2] } } : facts,
      });
      walk(kids, n.id, depth + 1);
    }
  };
  walk(doc.nodes, `scene:${doc.name}`, 0);
  return out;
}

/** Which widget a selection component's fields describe, for applied-state lines. */
const COMPONENT_WIDGET: Readonly<Record<string, string>> = {
  transform: "transform",
  vendor: "vendor",
  characterref: "character",
  health: "combat",
  stamina: "combat",
  creature: "creature",
  navagent: "physics",
  collider: "physics",
  worlditem: "items",
  questgiver: "quests",
  flowref: "flow",
  vfxemitter: "vfx",
  audioemitter: "audio",
  playerintent: "intent",
};

/** Applied state read from the selection's own component fields — the only state this slice claims. */
export function appliedStateFromSelection(sel: EditorSelection): Readonly<Record<string, AppliedState>> {
  const out: Record<string, { identity?: string; lines: string[] }> = {};
  for (const comp of sel.components) {
    const widgetId = COMPONENT_WIDGET[comp.name.toLowerCase()];
    if (!widgetId) continue;
    const entry = (out[widgetId] ??= { lines: [] });
    for (const f of comp.fields) entry.lines.push(`${comp.name}.${f.key}: ${f.value}`);
  }
  return out;
}

/** Fold live inspect read-back lines ("Health: 40/50") into the applied state, under the same component→widget map. */
export function mergeInspectLines(state: Readonly<Record<string, AppliedState>>, lines: readonly string[]): Record<string, { identity?: string; lines: string[] }> {
  const out: Record<string, { identity?: string; lines: string[] }> = {};
  for (const [k, v] of Object.entries(state)) out[k] = { ...(v.identity !== undefined ? { identity: v.identity } : {}), lines: [...v.lines] };
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const widgetId = COMPONENT_WIDGET[m[1].trim().toLowerCase()];
    if (!widgetId) continue;
    (out[widgetId] ??= { lines: [] }).lines.push(`live · ${line}`);
  }
  return out;
}

/** A read-back joins a selection's applied state only when it names that selection's own id ("me" is the caller's avatar, never a scene selection). */
export function inspectTargetMatches(target: string, sel: EditorSelection): boolean {
  return target === sel.id;
}

// ------------------------------------------------- action input fields

/** A picker source resolved to its real option list + the honest note shown when that list is empty. */
export interface PickerResolution {
  options: readonly string[];
  emptyNote: string;
}
export type PickerResolver = (source: PickerSource | undefined) => PickerResolution;

/** One input field rendered from its descriptor: a picker fed by a resolved real list, or a compact number/text box. */
function ActionField({ input, value, onChange, pickerFor }: { input: ActionInput; value: string; onChange: (v: string) => void; pickerFor: PickerResolver }): React.JSX.Element {
  if (input.kind === "picker") {
    const { options, emptyNote } = pickerFor(input.source);
    const empty = options.length === 0;
    // A prefilled value the list doesn't carry (e.g. the vendor's current template) stays selectable, labelled as current.
    const withCurrent = value !== "" && !options.includes(value) ? [value, ...options] : options;
    return (
      <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
        {input.label}
        <Select size="sm" value={value} disabled={empty && value === ""} onChange={(e) => onChange(e.target.value)} aria-label={input.label}>
          <option value="">{empty ? emptyNote : (input.placeholder ?? "Choose…")}</option>
          {withCurrent.map((o) => (
            <option key={o} value={o}>
              {o}
              {o === value && !options.includes(o) ? " (current)" : ""}
            </option>
          ))}
        </Select>
      </label>
    );
  }
  return (
    <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
      {input.label}
      <Input
        style={{ width: input.kind === "number" ? 90 : 150 }}
        value={value}
        inputMode={input.kind === "number" ? "decimal" : undefined}
        placeholder={input.placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={input.label}
      />
    </label>
  );
}

/**
 * A widget action row: its declared input fields (if any), the action
 * button, and its note. Owns its field values — the caller keys it by
 * selection, so switching objects resets the fields to the new
 * selection's prefills. Firing hands the raw values to `callWith`;
 * the dispatch mapper remains the gate on the built call.
 */
function WidgetActionRow({ action, pickerFor, onDispatch }: { action: WidgetAction; pickerFor: PickerResolver; onDispatch: (call: VerbCall) => void }): React.JSX.Element {
  const [values, setValues] = React.useState<InputValues>({});
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {action.inputs.map((input) => (
          <ActionField key={input.id} input={input} value={inputValue(values, input)} onChange={(v) => setValues((prev) => ({ ...prev, [input.id]: v }))} pickerFor={pickerFor} />
        ))}
        <Button size="sm" variant="outline" onClick={() => onDispatch(action.callWith(values))}>
          {action.label}
        </Button>
      </div>
      {action.note && <p className="text-[12px] text-muted-foreground">{action.note}</p>}
    </div>
  );
}

/** A shelf entry whose verb action declares inputs: the fields render inline and the values ride the button. */
function ShelfActionRow({ entry, pickerFor, onFire }: { entry: ShelfEntry; pickerFor: PickerResolver; onFire: (entry: ShelfEntry, values: InputValues) => void }): React.JSX.Element {
  const [values, setValues] = React.useState<InputValues>({});
  const action = entry.action;
  if (!action) return <></>;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-2.5" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-2)" }}>
      <div>
        <div className="text-sm font-medium">{entry.title}</div>
        <p className="text-[12px] text-muted-foreground">{entry.reason}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {(action.inputs ?? []).map((input) => (
          <ActionField key={input.id} input={input} value={inputValue(values, input)} onChange={(v) => setValues((prev) => ({ ...prev, [input.id]: v }))} pickerFor={pickerFor} />
        ))}
        <Button size="sm" onClick={() => onFire(entry, values)}>
          {action.label}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- the view

const DEFAULT_VIEWS: readonly SavedView[] = [
  { name: "All quest givers", role: "quest-givers", sort: "name" },
  { name: "Vendors by name", role: "vendors", sort: "name" },
  { name: "Recently changed objects", role: "all", sort: "recent" },
];

function AuthoringPresentation(): React.JSX.Element {
  const selection = useEditorSelection();
  const [sceneNames, setSceneNames] = React.useState<string[]>([]);
  const [sceneName, setSceneName] = React.useState<string>("");
  const [doc, setDoc] = React.useState<SceneDoc | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [role, setRole] = React.useState<string>("all");
  const [sort, setSort] = React.useState<SortMode>("name");
  const [savedViews, setSavedViews] = React.useState<readonly SavedView[]>(DEFAULT_VIEWS);
  const [viewName, setViewName] = React.useState("");
  const [why, setWhy] = React.useState("hand tweak");
  const [historyTick, setHistoryTick] = React.useState(0);
  const [tabByWidget, setTabByWidget] = React.useState<Readonly<Record<string, string>>>({});
  /** Dispatch outcomes by the exact VerbCall object (history entries are the same references). */
  const [outcomes, setOutcomes] = React.useState<ReadonlyMap<VerbCall, DispatchOutcome>>(new Map());
  /** The latest live inspect read-back: which target it describes, and its lines. */
  const [readBack, setReadBack] = React.useState<{ target: string; lines: readonly string[] } | null>(null);
  /** Shelf component-add attempts and their (unsupported) outcomes — they have no canonical verb, so they live outside VerbHistory. */
  const [shelfLog, setShelfLog] = React.useState<readonly { id: number; title: string; detail: string }[]>([]);
  const link = useServerLink();
  const serverLive = link.phase === "live";
  /** Embedded-panel collapse state for the view pane (left dock / right dock / history strip), persisted like the pins. */
  const [panels, setPanels] = useLocalStorage("authoring-embedded-panels", { left: true, right: true, history: true });
  /**
   * The selection id whose floating widgets are dismissed (the stack's ×).
   * View state only — the selection itself is untouched. Any new selection
   * object (a fresh pick in this view or in Scenes, including re-clicking
   * the same object) clears it, so the widgets re-summon.
   */
  const [dismissedWidgetsFor, setDismissedWidgetsFor] = React.useState<string | null>(null);
  React.useEffect(() => {
    setDismissedWidgetsFor(null);
  }, [selection]);
  // ---- picker lists for action inputs: real data only, resolved here (the model layer names the sources, never the lists)
  const [itemBases, setItemBases] = React.useState<readonly string[]>([]);
  const [creatureKinds, setCreatureKinds] = React.useState<readonly string[]>([]);
  const [gameplayError, setGameplayError] = React.useState<string | null>(null);
  const [vendorTemplates, setVendorTemplates] = React.useState<readonly string[]>([]);

  // Item bases + creature kinds: the gameplay snapshot the editor already
  // loads from the dev host (content/rules/items.json + creatures.json refs).
  React.useEffect(() => {
    let live = true;
    loadGameplay()
      .then((snap) => {
        if (!live) return;
        setItemBases(snap.context.refs.items);
        setCreatureKinds(snap.context.refs.creatures);
      })
      .catch((e: unknown) => live && setGameplayError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  // Vendor templates: only the running server knows which are DEFINED
  // (content/vendors.json templates are defined lazily), so the list is
  // the server's own `vendor list` answer — refetched when the link goes
  // live and after any vendor dispatch. Offline there is no list.
  const refreshVendorTemplates = React.useCallback(async () => {
    const r = await serverLink.admin("vendor", { sub: "list" });
    if (r.ok) setVendorTemplates(parseVendorTemplateList(r.message));
  }, []);
  React.useEffect(() => {
    if (serverLive) void refreshVendorTemplates();
  }, [serverLive, refreshVendorTemplates]);

  /** Resolve a picker source to its options + the note shown while the list is empty. */
  const pickerFor: PickerResolver = (source) => {
    switch (source) {
      case "item-bases":
        return { options: itemBases, emptyNote: gameplayError ? "Item bases couldn't load from the gameplay tables." : "Loading item bases…" };
      case "creature-kinds":
        return { options: creatureKinds, emptyNote: gameplayError ? "Creature kinds couldn't load from the gameplay tables." : "Loading creature kinds…" };
      case "vendor-templates":
        return {
          options: vendorTemplates,
          emptyNote: serverLive ? "No vendor templates are defined on the server." : "Vendor templates live on the running server — start it to list them.",
        };
      default:
        return { options: [], emptyNote: "No list for this field." };
    }
  };

  React.useEffect(() => {
    let live = true;
    listScenes()
      .then((names) => {
        if (!live) return;
        setSceneNames(names);
        if (names.length > 0) setSceneName((cur) => cur || names[0]);
      })
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  React.useEffect(() => {
    if (!sceneName) return;
    let live = true;
    getScene(sceneName)
      .then((d) => {
        if (!live) return;
        setDoc(d);
        setLoadError(null);
      })
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [sceneName]);

  const model = React.useMemo(() => (doc ? buildHierarchy(sceneDocToHierarchyData(doc)) : null), [doc]);
  const sceneNodesById = React.useMemo(() => {
    const map = new Map<string, SceneNode>();
    const walk = (nodes: readonly SceneNode[]): void => {
      for (const n of nodes) {
        map.set(n.id, n);
        walk(n.children ?? []);
      }
    };
    if (doc) walk(doc.nodes);
    return map;
  }, [doc]);

  const actor = React.useMemo(() => ({ id: currentProfile(browserStorage()) || "designer", role: "designer" as const }), []);
  const facts = selection ? factsFromSelection(selection) : null;
  const where = (model && selection && model.byId.get(selection.id)?.path) || selection?.label || "";
  // The reflection: a read-back whose target IS this selection joins its applied state (labelled "live ·").
  const appliedState = selection
    ? readBack !== null && inspectTargetMatches(readBack.target, selection)
      ? mergeInspectLines(appliedStateFromSelection(selection), readBack.lines)
      : appliedStateFromSelection(selection)
    : {};
  const widgets = facts && selection ? buildWidgets(facts, { actor, why: why.trim() || "hand tweak", where, state: appliedState }) : [];
  const shelf = facts ? visibleShelf(facts) : [];
  const history = authoringHistory.forObject(where);

  /**
   * Record the intent, then dispatch it for real over the shared link.
   * No live server → the executor's transport is null and the outcome is
   * `offline`, said plainly. A dispatched mutation's read-back lands in
   * the stage (and in the widgets, when its target is this selection).
   */
  const dispatch = (call: VerbCall): void => {
    authoringHistory.append(call);
    setHistoryTick((t) => t + 1);
    const transport = serverLive
      ? {
          admin: (command: string, args?: Record<string, unknown>) => serverLink.admin(command, args),
          inspect: (entity: string) => serverLink.admin("inspect", { entity }),
        }
      : null;
    void (async () => {
      const outcome = await executeDispatch(call, transport);
      setOutcomes((prev) => new Map(prev).set(call, outcome));
      setHistoryTick((t) => t + 1);
      if (call.verb === "attachVendor" || call.verb === "detachVendor") void refreshVendorTemplates();
      if (outcome.status === "dispatched") {
        notify(`${call.verb} dispatched — ${outcome.message}`);
        if (outcome.readResult !== undefined && outcome.plan.kind !== "read") {
          const target = inspectTargetForCall(call);
          if (target !== null) setReadBack({ target, lines: outcome.readResult.split("\n").filter((l) => l.trim() !== "") });
        }
      } else if (outcome.status === "refused") {
        notify(`${call.verb} refused by the server — ${outcome.message}`);
      } else if (outcome.status === "offline") {
        notify(`${call.verb} recorded — the play server isn't running, so nothing was dispatched.`);
      } else {
        notify(`${call.verb} can't be dispatched — ${outcome.message}`);
      }
    })();
  };

  /** Fire a shelf entry: verb actions merge their input values over the placeholder params (the mapper gates the result); component-shaped ones have no verb. */
  const fireShelf = (e: ShelfEntry, values: InputValues): void => {
    if (!facts || !e.action) return;
    if (e.action.verb) {
      dispatch(makeVerbCall(e.action.verb, shelfActionParams(e.action, values), { who: actor, what: facts.label, when: Date.now(), where, why: why.trim() || "hand tweak" }));
    } else {
      dispatchShelfComponents(e.action.label, e.action.addComponents ?? []);
    }
  };

  /** Component-shaped shelf actions: no canonical verb exists, so the mapper's verdict is the outcome. */
  const dispatchShelfComponents = (label: string, components: readonly string[]): void => {
    const plan = shelfComponentPlan({ label, addComponents: components });
    const detail = plan !== null && plan.kind === "unsupported" ? plan.reason : "no dispatch plan for a component addition";
    setShelfLog((prev) => [...prev, { id: prev.length + 1, title: `${label} (${components.join(" + ")})`, detail }]);
    setHistoryTick((t) => t + 1);
    notify(`${label}: not dispatchable — admin set cannot add a component. The full reason is in the session history.`);
  };

  const pickNode = (node: HierarchyNode): void => {
    const sceneNode = sceneNodesById.get(node.id);
    if (sceneNode) {
      editorSelection.select(nodeSelection("outliner", sceneNode));
    } else {
      editorSelection.select({ source: "outliner", kind: "scene", id: node.id, label: node.name, components: [{ name: "Scene", fields: [{ key: "name", value: node.name }] }] });
    }
  };

  const visibleNodes: readonly HierarchyNode[] = !model
    ? []
    : sortNodes(role === "all" ? model.flat : model.flat.filter((n) => roleFilterById(role as RoleFilterId).test(n)), sort);

  return (
    // Embedded-panels workspace with FLOATING selection widgets (Joey,
    // 2026-10-24 evening — the pattern of the editors he named as the
    // reference set: VSCode, Blender, Unity, PlayCanvas). The three
    // workspace columns are gone: the workspace is ONE view pane — a
    // single framed canvas. The hierarchy docks at its left edge
    // (VSCode's sidebar / Unity's Hierarchy against the scene view), the
    // add shelf — the "available to add" catalog — docks as a strip at
    // its right edge, the identity bar runs across the top INSIDE the
    // pane, and the provenance history is a collapsible strip along the
    // bottom INSIDE the pane (VSCode's panel/console). The selection's
    // widgets are NOT docked at all: they FLOAT over the center
    // viewport-focus zone, summoned by the selection (Joey's original
    // 2026-10-17 design), anchored toward the zone's right-center, and
    // the layout never reflows for them. The docks are at the pane's
    // edges, not columns beside it, and collapsing a dock (edge toggles
    // in the identity bar) returns its width to the viewport zone.
    // Collapse state persists in local prefs. The rule of thirds
    // governs composition inside the pane: identity /
    // relationships-viewport-focus / provenance down its height.
    //
    // Honest scope: the panels are embedded within the Design workspace's
    // view pane. They are NOT overlays on the real-time 3D render — the
    // stage is still a panel; the live viewport stays in the Scenes
    // workspace, with selection shared between them.
    <div className="h-full min-h-0 overflow-hidden p-3">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-1)" }}>
        {/* ---------------- identity bar — across the top, inside the pane */}
        <div className="flex flex-none items-center gap-2 border-b px-2 py-1.5" style={{ borderColor: "var(--m3-outline-variant)" }}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPanels((p) => ({ ...p, left: !p.left }))}
            aria-label={panels.left ? "Collapse the hierarchy panel" : "Show the hierarchy panel"}
            title="Hierarchy panel (docked at the pane's left edge)"
          >
            <MIcon name={panels.left ? "chevron_left" : "chevron_right"} size={16} />
            Hierarchy
          </Button>
          {facts ? (
            <div className="flex min-w-0 items-center gap-2">
              <MIcon name="nearby" size={20} />
              <span className="truncate text-base font-medium">{facts.label}</span>
              <span className="flex-none text-[12px] text-muted-foreground">
                {facts.kind} · {facts.id}
              </span>
              <span className="truncate text-[12px] text-muted-foreground">{where}</span>
            </div>
          ) : (
            <span className="truncate text-[13px] text-muted-foreground">The view pane — pick an object and its widgets float here, summoned by the pick.</span>
          )}
          <Button
            className="ml-auto flex-none"
            size="sm"
            variant="ghost"
            onClick={() => setPanels((p) => ({ ...p, right: !p.right }))}
            aria-label={panels.right ? "Collapse the add-shelf strip" : "Show the add-shelf strip"}
            title="Add-shelf strip (docked at the pane's right edge)"
          >
            Add shelf
            <MIcon name={panels.right ? "chevron_right" : "chevron_left"} size={16} />
          </Button>
        </div>

        {/* ---------------- middle: left dock | center viewport zone (widgets float over it) | right shelf strip */}
        <div className="flex min-h-0 flex-1">
          {/* hierarchy — docked at the left edge inside the pane: Find */}
          {panels.left && (
            <div className="flex w-72 flex-none flex-col gap-2 overflow-y-auto border-r p-3" style={{ borderColor: "var(--m3-outline-variant)" }}>
              <SectionTitle>Hierarchy — relationships</SectionTitle>
              <Select value={sceneName} onChange={(e) => setSceneName(e.target.value)} aria-label="Scene">
                {sceneNames.length === 0 && <option value="">No scenes reachable</option>}
                {sceneNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <div className="flex flex-wrap gap-1.5">
                <Chip selected={role === "all"} onClick={() => setRole("all")}>
                  All
                </Chip>
                {ROLE_FILTERS.map((f) => (
                  <Chip key={f.id} selected={role === f.id} onClick={() => setRole(f.id)}>
                    {f.label}
                  </Chip>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <Chip selected={sort === "name"} onClick={() => setSort("name")}>
                  A–Z
                </Chip>
                <Chip selected={sort === "recent"} onClick={() => setSort("recent")}>
                  Recently modified
                </Chip>
              </div>
              <div className="flex flex-col gap-0.5">
                {visibleNodes.map((n) => {
                  const depth = n.path.split(" / ").length - 1;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => pickNode(n)}
                      className="m3-focus flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px]"
                      style={{
                        marginLeft: depth * 12,
                        background: selection?.id === n.id ? "var(--m3-secondary-container)" : "transparent",
                        color: "var(--m3-on-surface)",
                      }}
                    >
                      <MIcon name={n.level === "scene" ? "account_tree" : n.level === "object" ? "circle" : "folder"} size={15} />
                      <span className="truncate">{n.name}</span>
                      <span className="ml-auto text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
                        {n.level}
                      </span>
                    </button>
                  );
                })}
                {model && visibleNodes.length === 0 && <p className="text-[13px] text-muted-foreground">Nothing in this scene matches the filter.</p>}
                {!model && <p className="text-[13px] text-muted-foreground">{loadError ? `Scene load failed: ${loadError}` : "Loading the scene…"}</p>}
              </div>
              <SectionTitle>Saved views</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {savedViews.map((v) => (
                  <Chip
                    key={v.name}
                    onClick={() => {
                      const parsed = deserializeSavedView(serializeSavedView(v));
                      setRole(parsed.role);
                      setSort(parsed.sort);
                    }}
                  >
                    {v.name}
                  </Chip>
                ))}
              </div>
              <div className="flex gap-1.5">
                <Input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Name this view" aria-label="Saved view name" />
                <Button
                  size="sm"
                  onClick={() => {
                    const name = viewName.trim();
                    if (!name) return;
                    setSavedViews((prev) => [...prev, deserializeSavedView(serializeSavedView({ name, role: role as SavedView["role"], sort }))]);
                    setViewName("");
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          )}

          {/* the center viewport-focus zone — the pane's own middle. The
              selection widgets FLOAT over it (rendered at its end): the
              zone itself never reflows or resizes for them. */}
          <div className="relative min-w-0 flex-1">
            <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
              {!facts && (
                <EmptyState
                  icon="nearby"
                  title="Select an object"
                  body="Pick a node in the hierarchy dock (or any object in the Scenes viewport — selection is shared). Its widgets float in this pane: what's applied, and the verbs to change it. Scene-level modules for this scene: "
                />
              )}
              {!facts && (
                <div className="flex flex-wrap gap-1.5">
                  {sceneLevelWidgets().map((w) => (
                    <Chip key={w.widgetId}>{w.title}</Chip>
                  ))}
                </div>
              )}
              {facts && (
                <>
                  <p className="text-[13px] text-muted-foreground">
                    {evaluateRelevance(facts).applied.length} widget(s) summoned by the relevance rules, floating in this pane. Applied state there is read from the selection's own component fields — joined by the live inspect read-back (marked "live ·") after a dispatched action whose target is this object.
                  </p>
                {/* The object's relationships / viewport focus — this zone is the viewpoint and grows. */}
                <div className="flex flex-1 flex-col rounded-lg border border-dashed p-3" style={{ borderColor: "var(--m3-outline-variant)" }}>
                  <SectionTitle>Relationships — follow the thread</SectionTitle>
                  {model && model.edges.filter((e) => e.from === facts.id || e.to === facts.id).length > 0 ? (
                    <ul className="mt-1 text-[13px]">
                      {model.edges
                        .filter((e) => e.from === facts.id || e.to === facts.id)
                        .map((e) => (
                          <li key={`${e.kind}:${e.from}->${e.to}`}>↔ {e.label}</li>
                        ))}
                    </ul>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">No reference edges in the scene data for this object yet (quest → giver, vendor → template, creature → patrol land here when the data carries them). The live 3D viewport stays in the Scenes workspace — selection is shared, so this object is the selected object there too.</p>
                  )}
                </div>
                  {readBack !== null && (
                    <div className="rounded-lg border p-3" style={{ borderColor: "var(--m3-primary)" }}>
                      <SectionTitle>Live read-back — inspect {readBack.target}</SectionTitle>
                      <ul className="mt-1 font-mono text-[12px]">
                        {readBack.lines.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                      <p className="mt-1 text-[12px] text-muted-foreground">Read from the running server after the last dispatched action on this target — this is the result, reflected back.</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ---------- floating selection widgets — summoned by the
                selection into the pane (Joey's 2026-10-17 design: a
                clicked game object summons its contextual widgets
                WITHIN the viewport). Absolutely positioned over the
                viewport-focus zone, anchored toward its right-center;
                nothing reflows for them. The stack scrolls itself when
                tall. The × dismisses it until the selection changes or
                the object is clicked again (view state only — the
                selection is untouched). No selection, no widgets. */}
            {facts && dismissedWidgetsFor !== facts.id && (
              <div className="absolute bottom-3 right-3 top-3 z-10 flex w-80 flex-col gap-2 overflow-y-auto" role="group" aria-label={`Widgets for ${facts.label}`}>
                <div className="flex flex-none items-center gap-2 rounded-lg border px-3 py-2 shadow-lg" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-2)" }}>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">Widgets — {facts.label}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDismissedWidgetsFor(facts.id)}
                    aria-label="Dismiss the floating widgets"
                    title="Dismiss — the widgets return when the selection changes or the object is clicked again"
                  >
                    <MIcon name="close" size={16} />
                  </Button>
                </div>
                {widgets.map((w) => (
                  <div key={w.widgetId} className="flex-none rounded-lg border p-3 shadow-lg" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-2)" }}>
                    <div className="text-sm font-medium">{w.title}</div>
                    <p className="mt-0.5 text-[13px]">{w.identity}</p>
                    {w.tabs && (
                      <ModalTabs
                        tabs={w.tabs.map((t) => ({ id: t.toLowerCase(), label: t }))}
                        active={tabByWidget[w.widgetId] ?? w.tabs[0].toLowerCase()}
                        onTab={(id) => setTabByWidget((prev) => ({ ...prev, [w.widgetId]: id }))}
                      />
                    )}
                    {w.applied.length > 0 ? (
                      <ul className="mt-1 list-inside list-disc text-[13px]">
                        {w.applied.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-[13px] text-muted-foreground">No live state read for this widget yet.</p>
                    )}
                    <div className="mt-2 flex flex-col gap-2">
                      {w.actions.map((a) => (
                        <WidgetActionRow key={`${facts.id}:${a.id}`} action={a} pickerFor={pickerFor} onDispatch={dispatch} />
                      ))}
                    </div>
                  </div>
                ))}
                {widgets.length === 0 && (
                  <p className="flex-none rounded-lg border p-3 text-[13px] text-muted-foreground shadow-lg" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-2)" }}>
                    No widgets apply to this selection.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* add shelf — the "available to add" catalog, docked as a strip at the right edge inside the pane: Act */}
          {panels.right && (
            <div className="flex w-80 flex-none flex-col gap-2 overflow-y-auto border-l p-3" style={{ borderColor: "var(--m3-outline-variant)" }}>
              <SectionTitle>Available to add</SectionTitle>
              <p className="text-[12px]" style={{ color: serverLive ? "var(--m3-primary)" : "var(--m3-error)" }}>
                {serverLive ? "Server live — actions dispatch to the running server for real." : "Server not running — actions record intent only; their outcome reads offline and nothing is dispatched."}
              </p>
              <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                Why (intent — required on every action)
                <Input value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Intent for verb calls" />
              </label>
              {!facts && <p className="text-[13px] text-muted-foreground">Select an object — what can be established on it appears here. Its own widgets float in the view pane when it is picked.</p>}
              {shelf.map((e) =>
                e.action && (e.action.inputs?.length ?? 0) > 0 ? (
                  <ShelfActionRow key={e.moduleId} entry={e} pickerFor={pickerFor} onFire={fireShelf} />
                ) : (
                  <div key={e.moduleId} className="flex items-center gap-2 rounded-lg border p-2.5" style={{ borderColor: "var(--m3-outline-variant)", background: "var(--m3-surface-2)" }}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{e.title}</div>
                      <p className="text-[12px] text-muted-foreground">{e.reason}</p>
                    </div>
                    <Button size="sm" onClick={() => fireShelf(e, {})}>
                      {e.action?.label ?? "Add"}
                    </Button>
                  </div>
                ),
              )}
              {facts && shelf.length === 0 && <p className="text-[13px] text-muted-foreground">Everything establishable is already applied.</p>}
            </div>
          )}
        </div>

        {/* ---------------- provenance history — collapsible strip along the bottom, inside the pane */}
        <div className="flex-none border-t" style={{ borderColor: "var(--m3-outline-variant)" }}>
          <button
            type="button"
            onClick={() => setPanels((p) => ({ ...p, history: !p.history }))}
            className="m3-focus flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
            aria-label={panels.history ? "Collapse the session history" : "Show the session history"}
          >
            <MIcon name={panels.history ? "expand_more" : "chevron_right"} size={16} />
            <span className="text-[13px] font-medium">Session history{selection ? ` — ${selection.label}` : ""}</span>
            <span className="text-[12px] text-muted-foreground">
              {history.length + shelfLog.length} recorded
            </span>
          </button>
          {panels.history && (
            <div className="px-3 pb-2">
              {history.length === 0 && shelfLog.length === 0 && <p className="text-[13px] text-muted-foreground">No verb calls recorded yet — widget and shelf actions land here with their 5W1H envelope and their dispatch outcome.</p>}
              <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto text-[13px]">
                {history.map((c, i) => {
                  const o = outcomes.get(c);
                  return (
                    <li key={`${historyTick}-${i}`} className="rounded-md border px-2 py-1" style={{ borderColor: "var(--m3-outline-variant)" }}>
                      <strong>{c.verb}</strong> — {c.provenance.why} · by {c.provenance.who.id} ({c.provenance.who.role})
                      {o !== undefined && (
                        <span className="mt-0.5 block text-[12px]" style={{ color: o.status === "dispatched" ? "var(--m3-primary)" : o.status === "refused" ? "var(--m3-error)" : "var(--m3-on-surface-variant)" }}>
                          → {o.status}: {o.message}
                          {o.plan.kind === "read" && o.readResult !== undefined ? ` — answer: ${o.readResult}` : ""}
                        </span>
                      )}
                      {o === undefined && <span className="mt-0.5 block text-[12px] text-muted-foreground">→ dispatching…</span>}
                    </li>
                  );
                })}
                {shelfLog.map((s) => (
                  <li key={`shelf-${s.id}`} className="rounded-md border px-2 py-1" style={{ borderColor: "var(--m3-outline-variant)" }}>
                    <strong>{s.title}</strong>
                    <span className="mt-0.5 block text-[12px] text-muted-foreground">→ unsupported: {s.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
