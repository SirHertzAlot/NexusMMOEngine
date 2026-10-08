/**
 * Semantic diff and three-way merge of JSON documents by stable ids (EA18).
 *
 * Objects are compared key by key. An array whose elements are all objects
 * with a unique string `id` (scene nodes, quest steps) or `guid` (pcg
 * subgraphs) is a keyed collection, so moving or editing one element never
 * touches another. Any other array is an atomic value.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface DocChange {
  /** e.g. `nodes[camp].transform.position` or `creatures.goblin.health`. */
  path: string;
  kind: "added" | "removed" | "changed";
  before?: Json;
  after?: Json;
}

export interface MergeConflict {
  path: string;
  base?: Json;
  ours?: Json;
  theirs?: Json;
}

type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function keyField(a: Json[]): "id" | "guid" | null {
  if (a.length === 0) return null;
  for (const f of ["id", "guid"] as const) {
    const ids = a.map((e) => (isObj(e) ? e[f] : undefined));
    if (ids.every((i) => typeof i === "string") && new Set(ids).size === ids.length) return f;
  }
  return null;
}

/** Common key field of the arrays among the values; null if none or they disagree. */
function fieldFor(...vs: Array<Json | undefined>): "id" | "guid" | null {
  const fields = (vs.filter(Array.isArray) as Json[][]).filter((a) => a.length > 0).map(keyField);
  const f = fields[0] ?? null;
  return fields.every((x) => x === f) ? f : null;
}

function entries(v: Json | undefined, field: "id" | "guid" | null): Map<string, Json> | null {
  if (v === undefined) return new Map();
  if (isObj(v)) return new Map(Object.entries(v));
  if (Array.isArray(v) && (field || v.length === 0)) return new Map(v.map((e) => [(e as Obj)[field as string] as string, e]));
  return null;
}

const childPath = (isArray: boolean, path: string, k: string): string =>
  isArray ? `${path}[${k}]` : path ? `${path}.${k}` : k;

export function diffDocs(before: Json | undefined, after: Json | undefined, path = ""): DocChange[] {
  if (same(before, after)) return [];
  if (before === undefined) return [{ path, kind: "added", after }];
  if (after === undefined) return [{ path, kind: "removed", before }];
  const field = fieldFor(before, after);
  const sameShape = Array.isArray(before) === Array.isArray(after) && (isObj(before) || Array.isArray(before));
  const b = sameShape ? entries(before, field) : null;
  const a = sameShape ? entries(after, field) : null;
  if (!b || !a) return [{ path, kind: "changed", before, after }];
  const out: DocChange[] = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    out.push(...diffDocs(b.get(k), a.get(k), childPath(Array.isArray(before), path, k)));
  }
  return out;
}

/** One line per change, e.g. `creatures.goblin.health: 60 -> 75`. */
export function summarize(changes: DocChange[]): string[] {
  const show = (v: Json | undefined): string => {
    const s = JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  };
  return changes.map((c) => {
    const p = c.path || "(document)";
    return c.kind === "added" ? `${p}: added ${show(c.after)}` : c.kind === "removed" ? `${p}: removed` : `${p}: ${show(c.before)} -> ${show(c.after)}`;
  });
}

export function mergeDocs(
  base: Json | undefined,
  ours: Json | undefined,
  theirs: Json | undefined,
  /** Settles a conflict at `path` for one side (used to apply the user's choices). */
  choose?: (path: string) => "ours" | "theirs" | undefined,
): { merged: Json | undefined; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const go = (b: Json | undefined, o: Json | undefined, t: Json | undefined, path: string): Json | undefined => {
    if (same(o, t)) return o;
    if (same(b, o)) return t;
    if (same(b, t)) return o;
    const field = fieldFor(b, o, t);
    const shape = (v: Json | undefined) => (Array.isArray(v) ? "a" : isObj(v) ? "o" : "x");
    if (o !== undefined && t !== undefined && shape(o) === shape(t) && shape(o) !== "x" && (b === undefined || shape(b) === shape(o))) {
      const eo = entries(o, field);
      const et = entries(t, field);
      const eb = entries(b, field);
      if (eo && et && eb) {
        const isArr = Array.isArray(o);
        const res = new Map<string, Json>();
        for (const k of new Set([...eo.keys(), ...et.keys(), ...eb.keys()])) {
          const m = go(eb.get(k), eo.get(k), et.get(k), childPath(isArr, path, k));
          if (m !== undefined) res.set(k, m);
        }
        // ours order first, then theirs-only additions in their order.
        const order = [...eo.keys(), ...[...et.keys()].filter((k) => !eo.has(k))].filter((k) => res.has(k));
        return isArr ? order.map((k) => res.get(k) as Json) : Object.fromEntries(order.map((k) => [k, res.get(k) as Json]));
      }
    }
    const side = choose?.(path || "(document)");
    if (side) return side === "ours" ? o : t;
    conflicts.push({ path: path || "(document)", base: b, ours: o, theirs: t });
    return o; // ours stays until the conflict is resolved
  };
  return { merged: go(base, ours, theirs, ""), conflicts };
}
