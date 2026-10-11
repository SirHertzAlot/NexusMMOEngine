/**
 * Scene documents (roadmap EA4, EDITOR-ARCHITECTURE.md section 5).
 *
 * A scene is a versioned JSON document (`content/scenes/<name>.scene.json`):
 * a name, a kind, and a tree of nodes. Each node has an id, an optional
 * prefab or node kind, a transform and a bag of components. Component
 * names and fields come from `COMPONENTS`, the registry modules extend, so
 * validation and the editor's Details form need no per-component code.
 *
 * Everything here is pure: edit operations return a new document and
 * never touch their input, `validateScene` returns every problem with its
 * path, and `History` is the undo/redo stack over the immutable documents.
 */

export const SCENE_VERSION = 1;
export const SCENE_KINDS = ["frontend", "world", "instance", "arena"] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

export type Vec3 = [number, number, number];
export interface Transform {
  position?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}
export interface SceneNode {
  id: string;
  name?: string;
  /** A node kind from NODE_KINDS (default "group"). */
  kind?: string;
  /** A prefab reference, e.g. "camps/goblin". */
  prefab?: string;
  transform?: Transform;
  components?: Record<string, Record<string, unknown>>;
  children?: SceneNode[];
}
export interface SceneDoc {
  version: number;
  name: string;
  kind: SceneKind;
  modules?: string[];
  nodes: SceneNode[];
}
export interface SceneIssue {
  path: string;
  message: string;
}

// ------------------------------------------------------------------ registry

export type FieldSpec =
  | { type: "string"; default: string }
  | { type: "number"; default: number; min?: number; max?: number }
  | { type: "boolean"; default: boolean }
  | { type: "enum"; default: string; options: readonly string[] };
export interface ComponentDef {
  label: string;
  fields: Record<string, FieldSpec>;
  defaults(): Record<string, unknown>;
}

function component(label: string, fields: Record<string, FieldSpec>): ComponentDef {
  return {
    label,
    fields,
    defaults: () => Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.default])),
  };
}

/** Node kinds the core module registers. */
export const NODE_KINDS: readonly string[] = ["group", "spawn-point", "prefab"];

/** Component registry: the core module's components. Modules add to it. */
export const COMPONENTS: Record<string, ComponentDef> = {
  Spawner: component("Spawner", {
    creature: { type: "string", default: "" },
    /** A species id (content/species): used when no creature is named. */
    species: { type: "string", default: "" },
    respawnSeconds: { type: "number", default: 60, min: 0 },
  }),
  /** An item lying on the ground at the node: an item base id from items.json. */
  ItemSpawn: component("Item", {
    base: { type: "string", default: "" },
    /** A rank id of the loot pool; empty: the base's lowest rank. */
    rank: { type: "string", default: "" },
  }),
  /** Where a quest is offered: the node moves the quest giver's post to it. */
  QuestGiver: component("Quest giver", {
    quest: { type: "string", default: "" },
  }),
  CharacterPreview: component("Character preview", {
    framing: { type: "enum", default: "body", options: ["body", "face"] },
  }),
  Light: component("Light", {
    intensity: { type: "number", default: 1, min: 0 },
    shadows: { type: "boolean", default: false },
  }),
  /**
   * Collider: per-node physics data (roadmap prop collision). At spawn a
   * node with a Collider becomes a static BodyConfig unless its shape is
   * "none" (walk-through decoration, like the scatter spawn table's
   * `"shape": "none"`): a box uses hx/hy/hz half-extents, a sphere uses
   * radius. Missing fields take their defaults; cross-field rules (a box
   * needs positive halves, a sphere a positive radius) are checked in
   * validateScene because one field's meaning depends on another's.
   */
  Collider: component("Collider", {
    shape: { type: "enum", default: "box", options: ["box", "sphere", "none"] },
    hx: { type: "number", default: 0.5, min: 0 },
    hy: { type: "number", default: 0.5, min: 0 },
    hz: { type: "number", default: 0.5, min: 0 },
    radius: { type: "number", default: 0.5, min: 0 },
  }),
};

// ---------------------------------------------------------------- validation

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkField(spec: FieldSpec, v: unknown): string | null {
  switch (spec.type) {
    case "string":
      return typeof v === "string" ? null : "must be a string";
    case "boolean":
      return typeof v === "boolean" ? null : "must be true or false";
    case "enum":
      return typeof v === "string" && spec.options.includes(v) ? null : `must be one of ${spec.options.join(", ")}`;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return "must be a number";
      if (spec.min !== undefined && v < spec.min) return `must be at least ${spec.min}`;
      if (spec.max !== undefined && v > spec.max) return `must be at most ${spec.max}`;
      return null;
  }
}

/** Cross-field rules for the Collider component (one field's meaning depends on another's). */
function checkCollider(props: Record<string, unknown>, cp: string, bad: (path: string, message: string) => void): void {
  const shape = props.shape ?? "box";
  // An unknown shape is already reported by the enum field check; only
  // judge dimensions for shapes with a meaning.
  const positive = (v: unknown): v is number => typeof v === "number" && v > 0;
  if (shape === "box") {
    for (const k of ["hx", "hy", "hz"]) {
      const v = props[k] ?? 0.5;
      if (typeof v === "number" && !positive(v)) bad(`${cp}.${k}`, "must be positive for a box collider");
    }
  } else if (shape === "sphere") {
    const v = props.radius ?? 0.5;
    if (typeof v === "number" && !positive(v)) bad(`${cp}.radius`, "must be positive for a sphere collider");
  }
}

/** Every problem in `doc`, each with the path of the offending value. */
export function validateScene(doc: unknown): SceneIssue[] {
  const out: SceneIssue[] = [];
  const bad = (path: string, message: string): void => void out.push({ path, message });
  if (!isObj(doc)) return [{ path: "", message: "a scene must be a JSON object" }];
  if (doc.version !== SCENE_VERSION) bad("version", `must be ${SCENE_VERSION}`);
  if (typeof doc.name !== "string" || !NAME_RE.test(doc.name)) bad("name", "must be lowercase letters, digits and dashes");
  if (!SCENE_KINDS.includes(doc.kind as SceneKind)) bad("kind", `must be one of ${SCENE_KINDS.join(", ")}`);
  if (doc.modules !== undefined && !(Array.isArray(doc.modules) && doc.modules.every((m) => typeof m === "string"))) {
    bad("modules", "must be a list of module names");
  }
  const seen = new Set<string>();
  const node = (n: unknown, path: string): void => {
    if (!isObj(n)) return bad(path, "a node must be an object");
    if (typeof n.id !== "string" || !n.id) bad(`${path}.id`, "needs a non-empty id");
    else if (seen.has(n.id)) bad(`${path}.id`, `id "${n.id}" is used twice`);
    else seen.add(n.id);
    for (const k of ["name", "prefab"]) if (n[k] !== undefined && typeof n[k] !== "string") bad(`${path}.${k}`, "must be a string");
    if (n.kind !== undefined && !(typeof n.kind === "string" && NODE_KINDS.includes(n.kind))) {
      bad(`${path}.kind`, `must be one of ${NODE_KINDS.join(", ")}`);
    }
    if (n.transform !== undefined) {
      if (!isObj(n.transform)) bad(`${path}.transform`, "must be an object");
      else {
        for (const [k, v] of Object.entries(n.transform)) {
          const ok = ["position", "rotation", "scale"].includes(k);
          if (!ok) bad(`${path}.transform.${k}`, "unknown field");
          else if (!(Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)))) {
            bad(`${path}.transform.${k}`, "must be three numbers [x, y, z]");
          }
        }
      }
    }
    if (n.components !== undefined) {
      if (!isObj(n.components)) bad(`${path}.components`, "must be an object");
      else {
        for (const [cn, props] of Object.entries(n.components)) {
          const cp = `${path}.components.${cn}`;
          const def = Object.prototype.hasOwnProperty.call(COMPONENTS, cn) ? COMPONENTS[cn] : undefined;
          if (!def) bad(cp, `unknown component "${cn}"`);
          else if (!isObj(props)) bad(cp, "must be an object");
          else {
            for (const [fn, v] of Object.entries(props)) {
              const spec = Object.prototype.hasOwnProperty.call(def.fields, fn) ? def.fields[fn] : undefined;
              if (!spec) bad(`${cp}.${fn}`, "unknown field");
              else {
                const e = checkField(spec, v);
                if (e) bad(`${cp}.${fn}`, e);
              }
            }
            if (cn === "Collider") checkCollider(props, cp, bad);
          }
        }
      }
    }
    if (n.children !== undefined) nodes(n.children, `${path}.children`);
  };
  const nodes = (list: unknown, path: string): void => {
    if (!Array.isArray(list)) return bad(path, "must be a list of nodes");
    list.forEach((n, i) => node(n, `${path}[${i}]`));
  };
  nodes(doc.nodes, "nodes");
  return out;
}

// ---------------------------------------------------------------- operations

export function emptyScene(name: string, kind: SceneKind): SceneDoc {
  return { version: SCENE_VERSION, name, kind, nodes: [] };
}

export function findNode(doc: SceneDoc, id: string): SceneNode | undefined {
  const walk = (list: SceneNode[]): SceneNode | undefined => {
    for (const n of list) {
      if (n.id === id) return n;
      const hit = n.children && walk(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(doc.nodes);
}

function mustFind(doc: SceneDoc, id: string): SceneNode {
  const n = findNode(doc, id);
  if (!n) throw new Error(`no node "${id}"`);
  return n;
}

/** Copy the tree, replacing the node `id` with fn(node) (undefined removes it). */
function mapTree(list: SceneNode[], id: string, fn: (n: SceneNode) => SceneNode | undefined): SceneNode[] {
  const out: SceneNode[] = [];
  for (const n of list) {
    if (n.id === id) {
      const r = fn(n);
      if (r) out.push(r);
    } else {
      out.push(n.children ? { ...n, children: mapTree(n.children, id, fn) } : n);
    }
  }
  return out;
}

function edit(doc: SceneDoc, id: string, fn: (n: SceneNode) => SceneNode): SceneDoc {
  mustFind(doc, id);
  return { ...doc, nodes: mapTree(doc.nodes, id, fn) };
}

function insert(list: SceneNode[], parent: string | null, node: SceneNode, index?: number): SceneNode[] {
  const put = (xs: SceneNode[]): SceneNode[] => {
    const i = index === undefined ? xs.length : Math.max(0, Math.min(index, xs.length));
    return [...xs.slice(0, i), node, ...xs.slice(i)];
  };
  return parent === null ? put(list) : mapTree(list, parent, (p) => ({ ...p, children: put(p.children ?? []) }));
}

export function addNode(doc: SceneDoc, parentId: string | null, node: SceneNode, index?: number): SceneDoc {
  if (findNode(doc, node.id)) throw new Error(`node "${node.id}" already exists`);
  if (parentId !== null) mustFind(doc, parentId);
  return { ...doc, nodes: insert(doc.nodes, parentId, node, index) };
}

export function removeNode(doc: SceneDoc, id: string): SceneDoc {
  mustFind(doc, id);
  return { ...doc, nodes: mapTree(doc.nodes, id, () => undefined) };
}

export function moveNode(doc: SceneDoc, id: string, parentId: string | null, index?: number): SceneDoc {
  const node = mustFind(doc, id);
  if (parentId !== null) {
    mustFind(doc, parentId);
    if (parentId === id || findNode({ ...doc, nodes: [node] }, parentId)) throw new Error("cannot move a node inside itself");
  }
  return { ...doc, nodes: insert(mapTree(doc.nodes, id, () => undefined), parentId, node, index) };
}

export function setNodeProp(doc: SceneDoc, id: string, prop: "name" | "kind" | "prefab", value: string | undefined): SceneDoc {
  return edit(doc, id, (n) => {
    const { [prop]: _old, ...rest } = n;
    return value === undefined || value === "" ? rest : { ...rest, [prop]: value };
  });
}

export function setTransform(doc: SceneDoc, id: string, t: Transform): SceneDoc {
  return edit(doc, id, (n) => ({ ...n, transform: { ...n.transform, ...t } }));
}

export function addComponent(doc: SceneDoc, id: string, name: string): SceneDoc {
  const def = Object.prototype.hasOwnProperty.call(COMPONENTS, name) ? COMPONENTS[name] : undefined;
  if (!def) throw new Error(`unknown component "${name}"`);
  if (mustFind(doc, id).components?.[name]) throw new Error(`node "${id}" already has ${name}`);
  return edit(doc, id, (n) => ({ ...n, components: { ...n.components, [name]: def.defaults() } }));
}

export function removeComponent(doc: SceneDoc, id: string, name: string): SceneDoc {
  return edit(doc, id, (n) => {
    const { [name]: _gone, ...rest } = n.components ?? {};
    const { components: _c, ...node } = n;
    return Object.keys(rest).length ? { ...node, components: rest } : node;
  });
}

export function setComponentField(doc: SceneDoc, id: string, comp: string, field: string, value: unknown): SceneDoc {
  if (!mustFind(doc, id).components?.[comp]) throw new Error(`node "${id}" has no ${comp}`);
  return edit(doc, id, (n) => ({
    ...n,
    components: { ...n.components, [comp]: { ...n.components?.[comp], [field]: value } },
  }));
}

// ------------------------------------------------------------------- history

/** Undo/redo over immutable documents: each step keeps the document it produced. */
export class History {
  private past: Array<{ label: string; doc: SceneDoc }> = [];
  private future: Array<{ label: string; doc: SceneDoc }> = [];
  private _doc: SceneDoc;
  private saved: SceneDoc;

  constructor(doc: SceneDoc) {
    this._doc = this.saved = doc;
  }
  get doc(): SceneDoc {
    return this._doc;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get dirty(): boolean {
    return this._doc !== this.saved;
  }
  /** Run an edit; if it throws, the history is untouched. */
  apply(label: string, fn: (doc: SceneDoc) => SceneDoc): void {
    const next = fn(this._doc);
    this.past.push({ label, doc: this._doc });
    this.future = [];
    this._doc = next;
  }
  undo(): string | undefined {
    const step = this.past.pop();
    if (!step) return undefined;
    this.future.push({ label: step.label, doc: this._doc });
    this._doc = step.doc;
    return step.label;
  }
  redo(): string | undefined {
    const step = this.future.pop();
    if (!step) return undefined;
    this.past.push({ label: step.label, doc: this._doc });
    this._doc = step.doc;
    return step.label;
  }
  markSaved(): void {
    this.saved = this._doc;
  }
  /** Open another document: history starts over. */
  replace(doc: SceneDoc): void {
    this.past = [];
    this.future = [];
    this._doc = this.saved = doc;
  }
}
export * from "./flow.js";

export * from "./place.js";

export * from "./strings.js";
export * from "./prefab.js";
