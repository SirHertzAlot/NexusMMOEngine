/**
 * The hierarchy as a relationship navigator.
 *
 * Containment (scene → region → POI → object) plus reference edges
 * (quest → giver, vendor → template, creature → patrol route / dialogue
 * graph) in one model, built from flat scene-node data. Role filters are
 * defined AS relevance facts — the same predicates that summon widgets
 * also answer "show me every quest giver in this region" — and saved
 * views (role + sort + query) serialize to plain JSON for the project.
 */

import { hasComponent, type SelectionFacts } from "./facts.js";

export type HierarchyLevel = "scene" | "region" | "poi" | "object";

export interface NodeReferences {
  /** This node (a quest) is given by the node with this id. */
  giverId?: string;
  /** This vendor node sells from the named template. */
  templateId?: string;
  /** This creature node follows the named patrol route. */
  patrolRouteId?: string;
  /** This node speaks the named dialogue graph. */
  dialogueGraphId?: string;
}

export interface SceneNodeData {
  id: string;
  name: string;
  level: HierarchyLevel;
  parentId: string | null;
  /** Designer-language kind of the object ("npc", "rock", …). */
  kind?: string;
  facts?: SelectionFacts;
  references?: NodeReferences;
  /** Provenance timestamp (ms) of the last change — "recently modified" sorting. */
  modifiedAt?: number;
}

export interface HierarchyNode extends SceneNodeData {
  children: HierarchyNode[];
  /** Containment path of names, root first ("Haven / Market Square / Mara"). */
  path: string;
}

export type ReferenceKind = "quest-giver" | "vendor-template" | "creature-patrol" | "creature-dialogue";

export interface ReferenceEdge {
  from: string;
  to: string;
  kind: ReferenceKind;
  label: string;
}

export interface HierarchyModel {
  roots: readonly HierarchyNode[];
  byId: ReadonlyMap<string, HierarchyNode>;
  edges: readonly ReferenceEdge[];
  /** Every node, flat, in containment order. */
  flat: readonly HierarchyNode[];
}

const LEVELS: readonly HierarchyLevel[] = ["scene", "region", "poi", "object"];

/** Build the tree + reference edges from flat node data. Unknown parents become roots (never dropped). */
export function buildHierarchy(data: readonly SceneNodeData[]): HierarchyModel {
  const byId = new Map<string, HierarchyNode>();
  for (const d of data) byId.set(d.id, { ...d, children: [], path: d.name });
  const roots: HierarchyNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId !== null ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const flat: HierarchyNode[] = [];
  const walk = (node: HierarchyNode, prefix: string): void => {
    node.path = prefix === "" ? node.name : `${prefix} / ${node.name}`;
    flat.push(node);
    for (const child of node.children) walk(child, node.path);
  };
  for (const r of roots) walk(r, "");

  const edges: ReferenceEdge[] = [];
  for (const node of byId.values()) {
    const refs = node.references ?? {};
    if (refs.giverId) edges.push({ from: node.id, to: refs.giverId, kind: "quest-giver", label: `${node.name} is given by ${byId.get(refs.giverId)?.name ?? refs.giverId}` });
    if (refs.templateId) edges.push({ from: node.id, to: refs.templateId, kind: "vendor-template", label: `${node.name} sells from template ${refs.templateId}` });
    if (refs.patrolRouteId) edges.push({ from: node.id, to: refs.patrolRouteId, kind: "creature-patrol", label: `${node.name} patrols ${refs.patrolRouteId}` });
    if (refs.dialogueGraphId) edges.push({ from: node.id, to: refs.dialogueGraphId, kind: "creature-dialogue", label: `${node.name} speaks ${refs.dialogueGraphId}` });
  }
  return { roots, byId, edges, flat };
}

// ------------------------------------------------------------- role filters

export type RoleFilterId = "quest-givers" | "vendors" | "loot-spawners" | "mob-spawners" | "dungeon-entrances" | "environment" | "characters";

export interface RoleFilter {
  id: RoleFilterId;
  label: string;
  test: (node: HierarchyNode) => boolean;
}

const factsOf = (node: HierarchyNode): SelectionFacts | undefined => node.facts;

/** Role filters defined as relevance rules over the same facts the widgets use. */
export const ROLE_FILTERS: readonly RoleFilter[] = [
  { id: "quest-givers", label: "Quest givers", test: (n) => factsOf(n)?.isQuestGiver === true },
  { id: "vendors", label: "Vendors", test: (n) => factsOf(n)?.isVendor === true },
  {
    id: "loot-spawners",
    label: "Loot spawners",
    test: (n) => {
      const f = factsOf(n);
      return f !== undefined && (hasComponent(f, "WorldItem") || hasComponent(f, "ItemSpawn"));
    },
  },
  {
    id: "mob-spawners",
    label: "Mob spawners",
    test: (n) => {
      const f = factsOf(n);
      return f !== undefined && (hasComponent(f, "Spawner") || f.creatureKind !== undefined);
    },
  },
  { id: "dungeon-entrances", label: "Dungeon entrances", test: (n) => factsOf(n)?.isDungeonEntrance === true },
  {
    id: "environment",
    label: "Environment",
    test: (n) => {
      const kind = (n.kind ?? n.facts?.kind ?? "").toLowerCase();
      return ["prop", "rock", "structure", "tree", "terrain"].includes(kind);
    },
  },
  { id: "characters", label: "Characters", test: (n) => factsOf(n) !== undefined && hasComponent(factsOf(n)!, "CharacterRef") },
];

export function roleFilterById(id: RoleFilterId): RoleFilter {
  const f = ROLE_FILTERS.find((r) => r.id === id);
  if (!f) throw new Error(`unknown role filter "${id}"`);
  return f;
}

/** Nodes matching a role filter, in containment order. */
export function filterByRole(model: HierarchyModel, role: RoleFilterId): readonly HierarchyNode[] {
  const filter = roleFilterById(role);
  return model.flat.filter((n) => filter.test(n));
}

// ------------------------------------------------------------------- sorting

export type SortMode = "name" | "recent";

const modifiedOf = (n: HierarchyNode): number => n.modifiedAt ?? n.facts?.lastModifiedAt ?? 0;

/** Sort a node list without mutating it. "recent" = provenance timestamp, newest first; ties fall back to name. */
export function sortNodes(nodes: readonly HierarchyNode[], mode: SortMode): HierarchyNode[] {
  const out = [...nodes];
  if (mode === "name") out.sort((a, b) => a.name.localeCompare(b.name));
  else out.sort((a, b) => modifiedOf(b) - modifiedOf(a) || a.name.localeCompare(b.name));
  return out;
}

// --------------------------------------------------------------- saved views

export interface SavedView {
  name: string;
  role: RoleFilterId | "all";
  sort: SortMode;
  query?: string;
}

export function serializeSavedView(view: SavedView): string {
  return JSON.stringify(view);
}

/** Parse a saved view, validating every field; throws with the problem on bad data. */
export function deserializeSavedView(json: string): SavedView {
  const raw = JSON.parse(json) as Partial<SavedView>;
  if (typeof raw.name !== "string" || raw.name === "") throw new Error("saved view needs a name");
  if (raw.role !== "all" && !ROLE_FILTERS.some((r) => r.id === raw.role)) throw new Error(`saved view "${raw.name}" has an unknown role filter`);
  if (raw.sort !== "name" && raw.sort !== "recent") throw new Error(`saved view "${raw.name}" has an unknown sort`);
  if (raw.query !== undefined && typeof raw.query !== "string") throw new Error(`saved view "${raw.name}" query must be a string`);
  return { name: raw.name, role: raw.role as SavedView["role"], sort: raw.sort, ...(raw.query !== undefined ? { query: raw.query } : {}) };
}

/** Apply a saved view: role filter (unless "all"), name query, then sort. */
export function applySavedView(model: HierarchyModel, view: SavedView): readonly HierarchyNode[] {
  let nodes: readonly HierarchyNode[] = view.role === "all" ? model.flat.filter((n) => n.level === "object" || n.level === "poi") : filterByRole(model, view.role);
  if (view.query) {
    const q = view.query.toLowerCase();
    nodes = nodes.filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
  }
  return sortNodes(nodes, view.sort);
}

export { LEVELS as HIERARCHY_LEVELS };
