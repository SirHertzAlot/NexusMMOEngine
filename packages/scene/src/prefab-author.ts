/**
 * Authoring a prefab out of nodes that are already in a scene, and seeing
 * what one instance changes about it (roadmap EB3).
 *
 * The prefab document, the override merge, nesting and the cycle check are
 * `prefab.ts` and were there before this: a scene node with
 * `prefab: "goblin-camp"` is the bundle with the node's own components laid
 * over it field by field. What was missing is the other direction — you
 * could write a prefab file by hand, but not make one out of the camp you
 * had just arranged in the viewport, and nothing said which of an
 * instance's fields differ from the prefab it came from.
 *
 * Both are arithmetic over the documents, so both live here, pure:
 *
 *   `prefabFromNodes`   the chosen nodes become a prefab's children,
 *                       positioned from the group's own origin, and the
 *                       scene gets one node that places it
 *   `instanceOverrides` the fields an instance states that the prefab
 *                       states differently, or does not state at all
 *   `clearOverride`     drop one back to what the prefab says
 *
 * Transforms: a chosen node's stored transform is relative to its parent,
 * which the prefab will not have, so each child is written in the scene
 * space the nodes stood in, measured from the prefab's origin. Placing the
 * instance back at that origin leaves every node exactly where it was,
 * which is the only property worth testing here.
 */

import {
  addNode,
  findNode,
  removeNode,
  type SceneDoc,
  type SceneIssue,
  type SceneNode,
  type Vec3,
} from "./index.js";
import { uniqueId, worldNodes } from "./place.js";
import { PREFAB_NAME_RE, PREFAB_VERSION, type PrefabDoc } from "./prefab.js";

const round = (n: number): number => Math.round(n * 1e4) / 1e4 + 0; // + 0: no negative zero
const vec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The chosen nodes with any whose ancestor is also chosen dropped, in
 * document order: picking a group and one of its children means the group,
 * once, because the child comes along inside it.
 */
export function topOfSelection(doc: SceneDoc, ids: readonly string[]): string[] {
  const chosen = new Set(ids);
  const out: string[] = [];
  const walk = (list: readonly SceneNode[], inside: boolean): void => {
    for (const n of list) {
      const take = chosen.has(n.id) && !inside;
      if (take) out.push(n.id);
      if (n.children) walk(n.children, inside || chosen.has(n.id));
    }
  };
  walk(doc.nodes, false);
  return out;
}

/**
 * Where a prefab made from these nodes has its origin, in scene space: the
 * middle of their spread on X and Z, at the lowest Y. Centred so that
 * turning the instance turns the group about itself, and at the foot so
 * that dropping it on ground at another height does not bury it. This is
 * the point to draw a marker at; `prefabFromNodes` writes the same point in
 * the frame of the parent it puts the instance under.
 */
export function selectionAnchor(doc: SceneDoc, ids: readonly string[]): Vec3 {
  const want = new Set(topOfSelection(doc, ids));
  const chosen = worldNodes(doc).filter((w) => want.has(w.node.id));
  if (chosen.length === 0) return [0, 0, 0];
  const axis = (i: 0 | 1 | 2): number[] => chosen.map((w) => w.position[i]);
  const mid = (xs: number[]): number => (Math.min(...xs) + Math.max(...xs)) / 2;
  return vec([mid(axis(0)), Math.min(...axis(1)), mid(axis(2))]);
}

export interface AuthoredPrefab {
  /** The prefab document to write to `content/prefabs/<name>.prefab.json`. */
  prefab: PrefabDoc;
  /** The scene with those nodes gone and one node placing the prefab instead. */
  doc: SceneDoc;
  /** The id of that node. */
  id: string;
  /** The nodes that went in, in the order the prefab holds them. */
  took: string[];
  /** Where the instance node sits, in the frame of the parent it was put under. */
  anchor: Vec3;
}

/**
 * Lift `ids` out of `doc` into a prefab called `name`, and put one node in
 * their place that instances it. The node lands under the parent the nodes
 * shared, or at the root when they did not share one, so a camp lifted out
 * of a group stays in that group.
 *
 * The children are written in the instance's own frame, and the instance
 * only moves: it takes no turn and no scale of its own. So nodes that
 * shared a parent keep the transforms they were authored with, shifted to
 * the prefab's origin, and the parent goes on turning and scaling them as
 * it did — the prefab holds the thing, the group holds where and how big.
 * Nodes gathered from different parents have no shared frame to keep, so
 * those are resolved into scene space first.
 */
export function prefabFromNodes(
  doc: SceneDoc,
  ids: readonly string[],
  name: string,
  opts: { anchor?: Vec3; instanceId?: string } = {},
): AuthoredPrefab {
  const took = topOfSelection(doc, ids);
  if (took.length === 0) throw new Error("no nodes to make a prefab from");
  const world = new Map(worldNodes(doc).map((w) => [w.node.id, w]));
  for (const id of took) if (!world.has(id)) throw new Error(`no node "${id}"`);

  const parents = new Set(took.map((id) => world.get(id)!.parentId));
  const parentId = parents.size === 1 ? [...parents][0] : null;
  /** Each node's transform in the frame the prefab's children will live in. */
  const frame = (id: string): { position: Vec3; rotation?: Vec3; scale?: Vec3 } => {
    const w = world.get(id)!;
    if (parentId !== null) return { ...w.node.transform, position: (w.node.transform?.position ?? [0, 0, 0]) as Vec3 };
    const rotation: Vec3 = [round(w.tiltDeg[0]), round(w.yawDeg), round(w.tiltDeg[1])];
    return { position: vec(w.position), rotation, scale: vec(w.scale) };
  };
  const put = took.map(frame).map((t) => t.position);
  const mid = (i: 0 | 1 | 2): number => (Math.min(...put.map((p) => p[i])) + Math.max(...put.map((p) => p[i]))) / 2;
  const anchor = opts.anchor ?? vec([mid(0), Math.min(...put.map((p) => p[1])), mid(2)]);

  const children: SceneNode[] = took.map((id) => {
    const t = frame(id);
    const position = vec([t.position[0] - anchor[0], t.position[1] - anchor[1], t.position[2] - anchor[2]]);
    const { transform: _was, ...rest } = world.get(id)!.node;
    return {
      ...structuredClone(rest),
      transform: {
        position,
        ...(t.rotation && t.rotation.some((r) => r !== 0) ? { rotation: t.rotation } : {}),
        ...(t.scale && t.scale.some((s) => s !== 1) ? { scale: t.scale } : {}),
      },
    };
  });

  const id = opts.instanceId ?? uniqueId(doc, name);
  const gone = took.reduce((d, old) => removeNode(d, old), doc);
  const next = addNode(gone, parentId, { id, kind: "prefab", prefab: name, transform: { position: anchor } });
  return { prefab: { version: PREFAB_VERSION, name, children }, doc: next, id, took, anchor };
}

/**
 * Why these nodes cannot become a prefab called `name` — the editor asks
 * before it offers the button, and the host's own `validatePrefab` still
 * has the last word on the document that comes out.
 */
export function prefabAuthorProblems(
  doc: SceneDoc,
  ids: readonly string[],
  name: string,
  existing: readonly string[] = [],
): SceneIssue[] {
  const out: SceneIssue[] = [];
  if (!PREFAB_NAME_RE.test(name)) out.push({ path: "name", message: "must be lowercase letters, digits and dashes" });
  else if (existing.includes(name)) out.push({ path: "name", message: `a prefab called "${name}" is already there` });
  const missing = ids.filter((id) => !findNode(doc, id));
  if (missing.length > 0) out.push({ path: "nodes", message: `not in this scene: ${missing.join(", ")}` });
  const took = topOfSelection(doc, ids);
  if (took.length === 0) out.push({ path: "nodes", message: "choose at least one node" });
  // A node that already places this prefab would make the prefab place itself.
  const placesName = (n: SceneNode): boolean =>
    n.prefab === name || (n.children ?? []).some(placesName);
  if (took.some((id) => placesName(findNode(doc, id)!))) {
    out.push({ path: "nodes", message: `one of these nodes already places "${name}", which would make the prefab place itself` });
  }
  return out;
}

export interface PrefabOverride {
  component: string;
  field: string;
  /** What this instance says. */
  value: unknown;
  /** What the prefab says; absent when the prefab's component has no such field. */
  base?: unknown;
  /** The instance adds a component the prefab has not got at all. */
  added: boolean;
}

/**
 * The fields where an instance differs from its prefab, which is what the
 * merge in `expandPrefabs` consumes and nothing showed. Fields the instance
 * repeats unchanged are not overrides: they move with the prefab.
 */
export function instanceOverrides(node: SceneNode, prefab: PrefabDoc): PrefabOverride[] {
  const out: PrefabOverride[] = [];
  for (const [component, fields] of Object.entries(node.components ?? {})) {
    const base = prefab.components?.[component];
    for (const [field, value] of Object.entries(fields)) {
      if (base === undefined) out.push({ component, field, value, added: true });
      else if (!same(value, base[field])) {
        out.push({ component, field, value, ...(field in base ? { base: base[field] } : {}), added: false });
      }
    }
  }
  return out;
}

/** True where this instance states that field differently from its prefab. */
export const isOverridden = (node: SceneNode, prefab: PrefabDoc, component: string, field: string): boolean =>
  instanceOverrides(node, prefab).some((o) => o.component === component && o.field === field);

function editNode(doc: SceneDoc, id: string, fn: (n: SceneNode) => SceneNode): SceneDoc {
  const walk = (list: readonly SceneNode[]): SceneNode[] =>
    list.map((n) => (n.id === id ? fn(n) : n.children ? { ...n, children: walk(n.children) } : n));
  return { ...doc, nodes: walk(doc.nodes) };
}

/**
 * Drop an instance's override so the prefab's value applies again: one
 * field, or the whole component when `field` is left out. A component with
 * nothing left in it goes too, because an empty override block is the same
 * as no override and only reads as one.
 */
export function clearOverride(doc: SceneDoc, id: string, component: string, field?: string): SceneDoc {
  if (!findNode(doc, id)) throw new Error(`no node "${id}"`);
  return editNode(doc, id, (n) => {
    const components = { ...(n.components ?? {}) };
    if (field === undefined) delete components[component];
    else if (components[component]) {
      const { [field]: _gone, ...rest } = components[component];
      if (Object.keys(rest).length === 0) delete components[component];
      else components[component] = rest;
    }
    const { components: _old, ...node } = n;
    return Object.keys(components).length > 0 ? { ...node, components } : node;
  });
}
