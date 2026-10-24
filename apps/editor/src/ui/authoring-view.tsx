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
 * Honest scope of this slice:
 * - The stage is a panel, not the 3D viewport: it shows the selected
 *   object's identity and its reference edges. The live viewport stays
 *   in the Scenes workspace; selection is shared, so picking here is
 *   picking there.
 * - Widget CRUD buttons and shelf verb actions are resolved to full
 *   VerbCalls and recorded in the session VerbHistory shown under the
 *   stage. They are NOT dispatched to the live verb layer yet — the
 *   button feedback says so, every time.
 * - Applied-state lines come from the selection's own component fields
 *   (what the editor already read), never invented server state.
 */

import * as React from "react";
import type { SceneDoc, SceneNode } from "@mmo-engine/scene";
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
  makeFacts,
  makeVerbCall,
  roleFilterById,
  sceneLevelWidgets,
  serializeSavedView,
  sortNodes,
  visibleShelf,
  VerbHistory,
  ROLE_FILTERS,
  type AppliedState,
  type HierarchyNode,
  type PresentationPin,
  type Provenance,
  type RoleFilterId,
  type SavedView,
  type SceneNodeData,
  type SelectionFacts,
  type SortMode,
  type VerbCall,
} from "../authoring/index.js";
import { Button, Chip, EmptyState, Input, MIcon, SectionTitle, Select, notify, useLocalStorage } from "./components.js";
import { EcsInspectorPanel } from "./ecs-inspector.js";
import { ModulesPanel } from "./modules-panel.js";
import { browserStorage, currentProfile } from "./editor-prefs.js";
import { editorSelection, useEditorSelection, type EditorSelection } from "./editor-selection.js";
import { ModalTabs } from "./merged-modals.js";

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
      out.push({ id: n.id, name: n.name || n.id, level, parentId, kind: facts.kind, facts });
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
  const widgets = facts && selection ? buildWidgets(facts, { actor, why: why.trim() || "hand tweak", where, state: appliedStateFromSelection(selection) }) : [];
  const shelf = facts ? visibleShelf(facts) : [];
  const history = authoringHistory.forObject(where);

  const dispatch = (call: VerbCall): void => {
    authoringHistory.append(call);
    setHistoryTick((t) => t + 1);
    notify(`${call.verb} recorded in the authoring history — live dispatch is not wired in this slice.`);
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
    <div className="flex h-full min-h-0 gap-3 overflow-hidden p-3">
      {/* ------------------------------------------------ hierarchy pane */}
      <div className="flex w-72 flex-none flex-col gap-2 overflow-y-auto pr-1">
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

      {/* ------------------------------------------------------- stage */}
      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
        <SectionTitle>Stage — Designer surface</SectionTitle>
        {!facts && (
          <EmptyState
            icon="nearby"
            title="Select an object"
            body="Pick a node in the hierarchy (or any object in the Scenes viewport — selection is shared). Its widgets appear here: what's applied, and the verbs to change it. Scene-level modules for this scene: "
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
            <div className="rounded-lg border p-3" style={{ borderColor: "var(--m3-outline-variant)" }}>
              <div className="flex items-center gap-2">
                <MIcon name="nearby" size={20} />
                <span className="text-base font-medium">{facts.label}</span>
                <span className="text-[12px] text-muted-foreground">
                  {facts.kind} · {facts.id}
                </span>
              </div>
              <p className="mt-1 text-[13px] text-muted-foreground">{where}</p>
              {model && model.edges.filter((e) => e.from === facts.id || e.to === facts.id).length > 0 && (
                <ul className="mt-2 text-[13px]">
                  {model.edges
                    .filter((e) => e.from === facts.id || e.to === facts.id)
                    .map((e) => (
                      <li key={`${e.kind}:${e.from}->${e.to}`}>↔ {e.label}</li>
                    ))}
                </ul>
              )}
              <p className="mt-2 text-[13px] text-muted-foreground">
                {evaluateRelevance(facts).applied.length} widget(s) summoned by the relevance rules. Applied state below is read from the selection's own component fields.
              </p>
            </div>
            <SectionTitle>Session history for this object</SectionTitle>
            {history.length === 0 && <p className="text-[13px] text-muted-foreground">No verb calls recorded yet — widget and shelf actions land here with their 5W1H envelope.</p>}
            <ul className="flex flex-col gap-1 text-[13px]">
              {history.map((c, i) => (
                <li key={`${historyTick}-${i}`} className="rounded-md border px-2 py-1" style={{ borderColor: "var(--m3-outline-variant)" }}>
                  <strong>{c.verb}</strong> — {c.provenance.why} · by {c.provenance.who.id} ({c.provenance.who.role})
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* ------------------------------------------- widgets + add shelf */}
      <div className="flex w-80 flex-none flex-col gap-2 overflow-y-auto pr-1">
        <SectionTitle>Selection widgets</SectionTitle>
        <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
          Why (intent — required on every action)
          <Input value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Intent for verb calls" />
        </label>
        {widgets.map((w) => (
          <div key={w.widgetId} className="rounded-lg border p-3" style={{ borderColor: "var(--m3-outline-variant)" }}>
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
            <div className="mt-2 flex flex-wrap gap-1.5">
              {w.actions.map((a) => (
                <Button key={a.id} size="sm" variant="outline" onClick={() => dispatch(a.call)}>
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
        {facts && widgets.length === 0 && <p className="text-[13px] text-muted-foreground">No widgets apply to this selection.</p>}
        <SectionTitle>Available to add</SectionTitle>
        {shelf.map((e) => (
          <div key={e.moduleId} className="flex items-center gap-2 rounded-lg border p-2.5" style={{ borderColor: "var(--m3-outline-variant)" }}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{e.title}</div>
              <p className="text-[12px] text-muted-foreground">{e.reason}</p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                if (!facts || !e.action) return;
                if (e.action.verb) {
                  dispatch(makeVerbCall(e.action.verb, e.action.params ?? {}, { who: actor, what: facts.label, when: Date.now(), where, why: why.trim() || "hand tweak" }));
                } else {
                  notify(`Would add ${e.action.addComponents?.join(" + ") ?? "the precondition"} to ${facts.label} — component editing is not wired in this slice.`);
                }
              }}
            >
              {e.action?.label ?? "Add"}
            </Button>
          </div>
        ))}
        {facts && shelf.length === 0 && <p className="text-[13px] text-muted-foreground">Everything establishable is already applied.</p>}
      </div>
    </div>
  );
}
