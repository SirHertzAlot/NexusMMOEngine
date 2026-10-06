/**
 * Shared scope tree (editor DRY slice 1).
 *
 * Every outliner (world regions, LiveOps scopes, story steps, release
 * profiles, …) renders the same data-driven rows instead of reimplementing
 * open/selected/breadcrumb around TreeItem. These helpers are pure so the
 * editor's node:test suite covers them; the ScopeTree renderer in
 * ui/components wraps TreeItem with them.
 */

export interface ScopeNode {
  id: string;
  label: string;
  icon?: string;
  trailing?: string;
  mono?: boolean;
  children?: readonly ScopeNode[];
}

export interface ScopeRow {
  node: ScopeNode;
  depth: number;
  hasKids: boolean;
  /** The root-to-row path, for breadcrumb bars. */
  path: ScopeNode[];
}

/** Toggle `id` in the open list, keeping the rest in order. */
export function toggleOpen(open: readonly string[], id: string): string[] {
  return open.includes(id) ? open.filter((x) => x !== id) : [...open, id];
}

/** Depth-first visible rows: children show only under an open parent. */
export function flattenVisible(roots: readonly ScopeNode[], open: readonly string[]): ScopeRow[] {
  const rows: ScopeRow[] = [];
  const walk = (nodes: readonly ScopeNode[], depth: number, path: ScopeNode[]): void => {
    for (const node of nodes) {
      const here = [...path, node];
      const kids = node.children ?? [];
      rows.push({ node, depth, hasKids: kids.length > 0, path: here });
      if (kids.length > 0 && open.includes(node.id)) walk(kids, depth + 1, here);
    }
  };
  walk(roots, 0, []);
  return rows;
}

/** The root-to-node path for `id` (the breadcrumb); empty when unknown. */
export function breadcrumb(roots: readonly ScopeNode[], id: string): ScopeNode[] {
  for (const row of flattenVisible(roots, openAll(roots))) {
    if (row.node.id === id) return row.path;
  }
  return [];
}

function openAll(nodes: readonly ScopeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly ScopeNode[]): void => {
    for (const n of list) {
      ids.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}
