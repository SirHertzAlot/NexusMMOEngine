/**
 * Command search (Ctrl K): what it can find and how it ranks. The command
 * list itself is built by the shell, which owns what each command does; this
 * module is the matching and the catalog-to-destination mapping.
 */

import type { CatalogEntry, CatalogKind } from "./content-catalog-types.js";

export type PaletteGroup = "Go to" | "Command" | "Asset" | "Setting";

export interface PaletteCommand {
  id: string;
  label: string;
  group: PaletteGroup;
  /** Shortcut or short detail shown at the right. */
  hint?: string;
  /** Extra words that find it without showing (e.g. "terrain" for the World viewport). */
  keywords?: string;
  icon: string;
  run: () => void;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Commands matching every word of the query, best first. A label that
 * starts with the query beats a label with a word that starts with it, which
 * beats a word buried inside, which beats a match only in the group or hint.
 * Ties keep the list's order. An empty query keeps the order as it is.
 */
export function rankCommands(commands: PaletteCommand[], query: string, limit = 12): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "") return commands.slice(0, limit);
  const tokens = words(q);
  if (tokens.length === 0) return commands.slice(0, limit);
  const scored: Array<{ c: PaletteCommand; score: number; i: number }> = [];
  commands.forEach((c, i) => {
    const label = c.label.toLowerCase();
    const labelWords = words(c.label);
    const rest = `${c.group} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (label.startsWith(t)) score += 0;
      else if (labelWords.some((w) => w.startsWith(t))) score += 1;
      else if (label.includes(t)) score += 2;
      else if (rest.includes(t)) score += 3;
      else return;
    }
    if (label.startsWith(q)) score -= 1;
    scored.push({ c, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.c);
}

/** Where picking a catalog entry takes you: a workspace and one of its views. */
export function catalogTarget(kind: CatalogKind): [workspace: string, view: string] {
  switch (kind) {
    case "scene":
      return ["scenes", "scene"];
    case "species":
    case "creature":
    case "item":
      return ["gameplay", "grids"];
    case "picg":
      return ["dungeons", "graphs"];
    case "quest":
      return ["story", "story-editor"];
    case "prefab":
      return ["gameplay", "content"];
  }
}

const KIND_LABEL: Record<CatalogKind, string> = {
  species: "Species",
  creature: "Creature",
  item: "Item",
  prefab: "Prefab",
  picg: "PICG graph",
  scene: "Scene",
  quest: "Quest",
};

const KIND_ICON: Record<CatalogKind, string> = {
  species: "pets",
  creature: "bug_report",
  item: "swords",
  prefab: "deployed_code",
  picg: "graph_3",
  scene: "account_tree",
  quest: "flag",
};

/** One palette command per catalog entry. */
export function catalogCommands(
  entries: CatalogEntry[],
  go: (workspace: string, view: string) => void,
  open?: (kind: string, id: string) => void,
): PaletteCommand[] {
  return entries.map((e) => {
    const [ws, view] = catalogTarget(e.kind);
    return {
      id: `asset:${e.kind}:${e.id}`,
      label: `${KIND_LABEL[e.kind]}: ${e.label}`,
      group: "Asset" as const,
      hint: e.detail,
      icon: KIND_ICON[e.kind],
      run: () => {
        go(ws, view);
        open?.(e.kind, e.id);
      },
    };
  });
}
