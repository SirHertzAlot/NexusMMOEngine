/**
 * Prefabs: a component bundle a scene places by name
 * (`content/prefabs/<name>.prefab.json`, roadmap data-driven entities).
 *
 *   { "version": 1, "name": "goblin-camp", "kind": "group",
 *     "components": { "Spawner": { "creature": "goblin", "respawnSeconds": 90 } },
 *     "children": [ { "id": "lookout", "components": { "Spawner": { "creature": "goblin" } },
 *                     "transform": { "position": [6, 0, 2] } } ] }
 *
 * A scene node with `prefab: "goblin-camp"` is that bundle with the node's
 * own components laid over it field by field (an override) and the node's
 * transform; the prefab's children come along, placed relative to the node.
 * A prefab may place other prefabs among its children. `prefab: "camps/goblin"`
 * finds the prefab "camps/goblin", else "goblin" (the last path segment, like
 * the server's spawner).
 *
 * Pure: the server (scene-spawn.ts) and the editor (prefab grid, viewport)
 * call the same `validatePrefab` and `expandPrefabs`.
 */

import { validateScene, type SceneDoc, type SceneIssue, type SceneNode } from "./index.js";

export const PREFAB_VERSION = 1;
export const PREFAB_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Nested prefabs deeper than this are reported as a cycle. */
const MAX_DEPTH = 8;

export interface PrefabDoc {
  version: number;
  name: string;
  /** A node kind from NODE_KINDS; absent: "group". */
  kind?: string;
  components?: Record<string, Record<string, unknown>>;
  children?: SceneNode[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every problem in `doc` as a prefab, each with the path of the offending value. */
export function validatePrefab(doc: unknown): SceneIssue[] {
  if (!isObj(doc)) return [{ path: "", message: "a prefab must be a JSON object" }];
  const out: SceneIssue[] = [];
  const bad = (path: string, message: string): void => void out.push({ path, message });
  if (doc.version !== PREFAB_VERSION) bad("version", `must be ${PREFAB_VERSION}`);
  if (typeof doc.name !== "string" || !PREFAB_NAME_RE.test(doc.name)) bad("name", "must be lowercase letters, digits and dashes");
  for (const k of Object.keys(doc)) if (!["version", "name", "kind", "components", "children"].includes(k)) bad(k, "unknown field");
  // The scene validator knows nodes and components: check the bundle as the root node of a scene.
  const root: Record<string, unknown> = { id: "prefab" };
  for (const k of ["kind", "components", "children"]) if (doc[k] !== undefined) root[k] = doc[k];
  for (const i of validateScene({ version: 1, name: "prefab", kind: "world", nodes: [root] })) {
    out.push({ path: i.path.replace(/^nodes\[0\]\.?/, ""), message: i.message });
  }
  return out;
}

export type PrefabLookup = Readonly<Record<string, PrefabDoc>> | ((name: string) => PrefabDoc | undefined);

function find(lookup: PrefabLookup, ref: string): PrefabDoc | undefined {
  const get = typeof lookup === "function" ? lookup : (n: string): PrefabDoc | undefined => (Object.prototype.hasOwnProperty.call(lookup, n) ? lookup[n] : undefined);
  return get(ref) ?? get(ref.split("/").pop() ?? "");
}

/** `over` laid over `base`, component by component, field by field. */
export function mergeComponents(
  base: Record<string, Record<string, unknown>> | undefined,
  over: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!base && !over) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [c, fields] of Object.entries(base ?? {})) out[c] = { ...fields };
  for (const [c, fields] of Object.entries(over ?? {})) out[c] = { ...out[c], ...fields };
  return out;
}

export interface Expanded {
  doc: SceneDoc;
  /** Prefab names that resolved to a prefab file, in first-use order. */
  used: string[];
  /** Cycles and too-deep nesting, as "node-id: message". */
  problems: string[];
}

/** The scene with every node that names a known prefab replaced by the bundle (unknown names are left alone for the spawner to try as creatures and props). Child ids are `<node id>.<child id>`. */
export function expandPrefabs(doc: SceneDoc, lookup: PrefabLookup): Expanded {
  const used: string[] = [];
  const problems: string[] = [];
  const one = (node: SceneNode, chain: readonly string[]): SceneNode => {
    const prefab = node.prefab !== undefined ? find(lookup, node.prefab) : undefined;
    if (prefab) {
      if (chain.includes(prefab.name) || chain.length >= MAX_DEPTH) {
        problems.push(`${node.id}: prefab "${prefab.name}" places itself (${[...chain, prefab.name].join(" > ")})`);
        const { prefab: _gone, ...rest } = node;
        return rest;
      }
      if (!used.includes(prefab.name)) used.push(prefab.name);
      const { prefab: _ref, ...rest } = node;
      const components = mergeComponents(prefab.components, node.components);
      const own = (prefab.children ?? []).map((c) => one({ ...c, id: `${node.id}.${c.id}` }, [...chain, prefab.name]));
      // The node's own children may name prefabs too.
      const kids = [...own, ...(node.children ?? []).map((c) => one(c, chain))];
      return {
        ...rest,
        ...((node.kind ?? prefab.kind) ? { kind: node.kind ?? prefab.kind } : {}),
        ...(components ? { components } : {}),
        ...(kids.length > 0 ? { children: kids } : {}),
      };
    }
    return node.children ? { ...node, children: node.children.map((c) => one(c, chain)) } : node;
  };
  return { doc: { ...doc, nodes: doc.nodes.map((n) => one(n, [])) }, used, problems };
}
