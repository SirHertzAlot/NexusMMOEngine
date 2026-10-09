/**
 * Cell checks for the Gameplay grids' structured columns (loot lines,
 * crafting inputs, prefab components and children): the answer while typing.
 * The server's own loaders still have the last word on a save; these are the
 * same rules in the small, browser-safe.
 */

import { validatePrefab } from "@mmo-engine/scene";
import type { GridContext } from "./gameplay-grid.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A loot table's `entries`: lines of { base, rank?, chance, count }. */
export function checkLootEntries(value: unknown, ctx: GridContext): string | null {
  if (!Array.isArray(value) || value.length === 0) return "needs at least one line";
  for (const [i, e] of value.entries()) {
    const at = `line ${i + 1}`;
    if (!isObj(e)) return `${at}: must be an object like {"base": "dagger", "chance": 0.5}`;
    for (const k of Object.keys(e)) if (!["base", "rank", "chance", "count"].includes(k)) return `${at}: unknown field "${k}"`;
    if (typeof e.base !== "string" || e.base === "") return `${at}: needs a "base" (an item base)`;
    const bases = ctx.refs.items;
    if (bases && bases.length > 0 && !bases.includes(e.base)) return `${at}: no item base "${e.base}"`;
    if (e.rank !== undefined && typeof e.rank !== "string") return `${at}: "rank" must be a rank id`;
    if (e.chance !== undefined && !(typeof e.chance === "number" && e.chance >= 0 && e.chance <= 1)) return `${at}: "chance" must be between 0 and 1`;
    if (e.count !== undefined) {
      const c = e.count;
      if (!(Array.isArray(c) && c.length === 2 && c.every((n) => Number.isInteger(n) && n >= 1))) return `${at}: "count" must be two whole numbers from 1, like [1, 2]`;
      if ((c[0] as number) > (c[1] as number)) return `${at}: "count" min is above max`;
    }
  }
  return null;
}

/** A refining row's `inputs`: raw material id -> whole units. */
export function checkRawInputs(value: unknown, ctx: GridContext): string | null {
  if (!isObj(value) || Object.keys(value).length === 0) return 'needs at least one input like {"iron-ore": 2}';
  const known = ctx.refs.materials;
  for (const [m, n] of Object.entries(value)) {
    if (known && known.length > 0 && !known.includes(m)) return `"${m}" is not a known raw material`;
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 1)) return `"${m}" needs a whole number of 1 or more`;
  }
  return null;
}

/** A prefab's `components` or `children`, checked the way the scene validator checks a node. */
export function checkPrefabPart(part: "components" | "children"): (value: unknown) => string | null {
  return (value) => {
    const issue = validatePrefab({ version: 1, name: "x", [part]: value }).find((i) => i.path === part || i.path.startsWith(`${part}.`) || i.path.startsWith(`${part}[`));
    return issue ? `${issue.path}: ${issue.message}` : null;
  };
}
