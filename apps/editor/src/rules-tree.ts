/**
 * Browser-safe rules-tree helpers for the editor's Rules panel.
 *
 * Pure functions over plain JSON values: path strings in the exact
 * shape the rules loader reports (`gain.fullAt`, `parts[3].share` —
 * see pathString in packages/rules/src/load.ts), immutable get/set
 * for the tree editor, and grouping of per-path validation issues.
 * No Node imports, so the panel can bundle this freely.
 */

/** One step of a path into a JSON value (object key or array index). */
export type PathSegment = string | number;

/** Render segments the way the rules loader names fields. */
export function formatPath(segments: readonly PathSegment[]): string {
  let s = "";
  for (const k of segments) s += typeof k === "number" ? `[${k}]` : s ? `.${String(k)}` : String(k);
  return s;
}

/** Read the value at `segments` (undefined when absent). */
export function getAtPath(root: unknown, segments: readonly PathSegment[]): unknown {
  let cur = root;
  for (const k of segments) {
    if (typeof k === "number") {
      if (!Array.isArray(cur) || k < 0 || k >= cur.length) return undefined;
      cur = cur[k];
    } else {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
  }
  return cur;
}

/**
 * Immutable set: returns a copy of `root` with `value` at `segments`.
 * Missing objects/arrays along the way are created from the next
 * segment's kind. Object key order is preserved (new keys append).
 */
export function setAtPath(root: unknown, segments: readonly PathSegment[], value: unknown): unknown {
  if (segments.length === 0) return value;
  const [head, ...tail] = segments as [PathSegment, ...PathSegment[]];
  if (typeof head === "number") {
    const arr = Array.isArray(root) ? [...root] : [];
    arr[head] = setAtPath(arr[head], tail, value);
    return arr;
  }
  const obj = typeof root === "object" && root !== null && !Array.isArray(root)
    ? { ...(root as Record<string, unknown>) }
    : {};
  obj[head] = setAtPath((root as Record<string, unknown> | null)?.[head], tail, value);
  return obj;
}

/**
 * Immutable remove: arrays splice, objects drop the key (other keys
 * keep their order). Removing an absent path returns `root` unchanged.
 */
export function removeAtPath(root: unknown, segments: readonly PathSegment[]): unknown {
  if (segments.length === 0) return root;
  const [head, ...tail] = segments as [PathSegment, ...PathSegment[]];
  if (typeof head === "number") {
    if (!Array.isArray(root) || head < 0 || head >= root.length) return root;
    if (tail.length === 0) return [...root.slice(0, head), ...root.slice(head + 1)];
    const arr = [...root];
    arr[head] = removeAtPath(arr[head], tail);
    return arr;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return root;
  const obj = { ...(root as Record<string, unknown>) };
  if (!(head in obj)) return root;
  if (tail.length === 0) {
    delete obj[head];
    return obj;
  }
  obj[head] = removeAtPath(obj[head], tail);
  return obj;
}

/** One validation problem, as the dev host reports it. */
export interface RuleIssueView {
  file: string;
  path: string;
  message: string;
}

/** Group issue messages by their path ("" = the file itself). */
export function groupIssues(issues: readonly RuleIssueView[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const i of issues) {
    const list = out.get(i.path) ?? [];
    list.push(i.message);
    out.set(i.path, list);
  }
  return out;
}
