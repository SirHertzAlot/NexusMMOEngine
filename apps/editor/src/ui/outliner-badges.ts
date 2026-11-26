/**
 * Component badges for the scene outliner (docs/EDITOR-UI-2026.md §2.2,
 * slice EU4).
 *
 * Both mockups put a component count and a few component chips on every
 * row of the object tree. We already draw exactly that in the ECS
 * entity list (`ui/ecs-inspector.tsx`), where a row carries its
 * components as badges; the scene outliner, which is the tree you
 * actually build a scene in, showed only a name and a kind. Same data,
 * one place drew it.
 *
 * This is the arithmetic, kept out of the panel so it can be tested
 * without rendering a tree: which chips fit, and how many are left.
 */

import type { SceneNode } from "@mmo-engine/scene";

export interface NodeBadges {
  /** How many components the node carries. The mockup's `8C`. */
  count: number;
  /** The chips that fit, in the node's own key order. */
  shown: string[];
  /** How many did not fit, for a `+2` chip. Zero when they all did. */
  hidden: number;
}

/**
 * `max` is how many chips a row has room for. A node with none gets an
 * empty list and a zero count — never a chip saying "none", because a
 * group node legitimately has no components and should read as quiet.
 */
export function nodeBadges(node: Pick<SceneNode, "components">, max = 3): NodeBadges {
  const names = Object.keys(node.components ?? {});
  if (names.length <= max) return { count: names.length, shown: names, hidden: 0 };
  return { count: names.length, shown: names.slice(0, max), hidden: names.length - max };
}

/**
 * Shorten a component name for a chip without losing which one it is:
 * drop a lower-case tail from each word, so `Health` -> `Hlth` stays
 * readable and `NavAgent` -> `NvAg` keeps both halves. Names already
 * short enough are left alone.
 */
export function chipLabel(name: string, max = 6): string {
  if (name.length <= max) return name;
  const words = name.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [name];
  if (words.length === 1) return name.slice(0, max);
  const per = Math.max(2, Math.floor(max / words.length));
  return words.map((w) => w.slice(0, per)).join("");
}

/**
 * The whole badge strip as one title, so a row that had to drop chips
 * still says what it holds on hover.
 */
export function badgeTitle(node: Pick<SceneNode, "components">): string {
  const names = Object.keys(node.components ?? {});
  if (names.length === 0) return "no components";
  return `${names.length} component${names.length === 1 ? "" : "s"}: ${names.join(", ")}`;
}
