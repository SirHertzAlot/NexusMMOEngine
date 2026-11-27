/**
 * Making a prefab out of what is selected in the Scenes viewport, and
 * reading an instance back (roadmap EB3).
 *
 * The documents and the arithmetic are `@mmo-engine/scene`
 * (`prefabFromNodes`, `instanceOverrides`, `clearOverride`); the writing is
 * the prefabs data table, which `data-host.ts` has validated and written
 * since the Gameplay grids were built. So this file is only the join: the
 * name to suggest, the table payload to send, and the words for what one
 * instance changes.
 *
 * Pure and browser-safe: the panel and the test apply the same rules, and
 * the host's `validatePrefab` still has the last word.
 */

import { instanceOverrides, PREFAB_NAME_RE, type PrefabDoc, type PrefabOverride, type SceneNode } from "@mmo-engine/scene";

/** A prefab row as the data table holds it: the document without its version and name. */
export type PrefabRow = Omit<PrefabDoc, "version" | "name">;

/** The prefabs table out of a gameplay snapshot (`{ prefabs: { … } }`), or nothing when it did not load. */
export function prefabRows(table: unknown): Record<string, PrefabRow> {
  const rows = (table as { prefabs?: unknown } | null | undefined)?.prefabs;
  return rows !== null && typeof rows === "object" && !Array.isArray(rows) ? (rows as Record<string, PrefabRow>) : {};
}

export const prefabNames = (table: unknown): string[] => Object.keys(prefabRows(table)).sort();

/**
 * A prefab by the reference a node carries: the whole string, else its last
 * path segment, which is what `expandPrefabs` and the server's spawner do.
 */
export function prefabOf(table: unknown, ref: string | undefined): PrefabDoc | undefined {
  if (!ref) return undefined;
  const rows = prefabRows(table);
  const name = Object.prototype.hasOwnProperty.call(rows, ref) ? ref : (ref.split("/").pop() ?? "");
  const row = Object.prototype.hasOwnProperty.call(rows, name) ? rows[name] : undefined;
  return row ? { version: 1, name, ...row } : undefined;
}

/** The whole table with this prefab added or replaced — what a save sends, so the other prefabs survive it. */
export function prefabTableContent(table: unknown, prefab: PrefabDoc): { prefabs: Record<string, PrefabRow> } {
  const { version: _v, name, ...row } = prefab;
  return { prefabs: { ...prefabRows(table), [name]: row } };
}

/** A name from what is selected: "Goblin camp" or "camp-3" becomes "goblin-camp", and a name in use gets a number. */
export function suggestPrefabName(nodes: readonly SceneNode[], existing: readonly string[] = []): string {
  const from = nodes[0]?.name ?? nodes[0]?.id ?? "";
  const base =
    from
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-\d+$/, "") || "prefab";
  const stem = PREFAB_NAME_RE.test(base) ? base : "prefab";
  if (!existing.includes(stem)) return stem;
  for (let i = 2; ; i++) if (!existing.includes(`${stem}-${i}`)) return `${stem}-${i}`;
}

const show = (v: unknown): string => (typeof v === "string" ? (v === "" ? '""' : v) : JSON.stringify(v));

/** One override in words: what this instance says, and what the prefab says instead. */
export function overrideLabel(o: PrefabOverride): string {
  if (o.added) return `${o.component}.${o.field} = ${show(o.value)} (the prefab has no ${o.component})`;
  if (o.base === undefined) return `${o.component}.${o.field} = ${show(o.value)} (the prefab leaves it to the default)`;
  return `${o.component}.${o.field} = ${show(o.value)} (the prefab says ${show(o.base)})`;
}

/** The one line the Details rail leads with for an instance. */
export function instanceSummary(node: SceneNode, prefab: PrefabDoc | undefined): string {
  if (!prefab) return `No prefab called "${node.prefab ?? ""}" — the server will try it as a creature or a prop.`;
  const overrides = instanceOverrides(node, prefab);
  const kids = prefab.children?.length ?? 0;
  const parts = [kids === 0 ? "no children" : `${kids} ${kids === 1 ? "child" : "children"}`];
  parts.push(overrides.length === 0 ? "nothing overridden here" : `${overrides.length} override${overrides.length === 1 ? "" : "s"} on this instance`);
  return `${prefab.name}: ${parts.join(", ")}.`;
}
