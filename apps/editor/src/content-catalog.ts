/**
 * The content catalog (roadmap EA15): everything the game defines, in one
 * list for the content browser, and the drag source for the scene viewport.
 *
 *   GET /api/editor/content-catalog -> { entries, notes }
 *
 * Each entry names where it comes from and what to drop: `drag` is the small
 * payload to carry (kind and id), `node` is the scene node it becomes when
 * dropped in a scene (null when no scene component exists for it yet, so the
 * viewport shows it as not placeable instead of inventing a component).
 * Read-only; the lists are read the way the editors read their files.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listScenes, readScene } from "./scenes-host.js";
import { loadSpeciesModule } from "./gameplay-host.js";
import { readPrefabs } from "./data-host.js";
import type { Catalog, CatalogEntry, CatalogKind, NodeTemplate } from "./content-catalog-types.js";

export * from "./content-catalog-types.js";

function json(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const keysOf = (v: unknown): string[] => (v && typeof v === "object" ? Object.keys(v) : []);

export async function buildCatalog(repoRoot: string): Promise<Catalog> {
  const entries: CatalogEntry[] = [];
  const notes: string[] = [];
  const add = (kind: CatalogKind, id: string, label: string, detail: string, node: NodeTemplate | null = null): void => {
    entries.push({ kind, id, label, detail, drag: { kind, id }, node });
  };

  try {
    const sp = await loadSpeciesModule(repoRoot);
    const file = join(repoRoot, "content", "species", "species.json");
    const roster = (existsSync(file) ? sp.loadSpecies(file) : sp.loadSpecies()) as Record<string, { name: string; kind: string }>;
    const creatureIds = new Set(keysOf((json(join(repoRoot, "content", "rules", "creatures.json")) ?? {}).creatures));
    for (const [id, s] of Object.entries(roster)) {
      add("species", id, s.name, creatureIds.has(id) ? s.kind : `${s.kind} (no creature rules: placing it spawns nothing yet)`, {
        name: s.name,
        kind: "group",
        components: { Spawner: { species: id } },
      });
    }
  } catch (e) {
    notes.push(`species not listed: ${(e as Error).message}`);
  }

  const rules = (name: string): Record<string, unknown> => json(join(repoRoot, "content", "rules", `${name}.json`)) ?? {};
  const creatures = (rules("creatures").creatures ?? {}) as Record<string, { name?: string; health?: number }>;
  for (const [id, c] of Object.entries(creatures)) {
    add("creature", id, c.name ?? id, `health ${c.health ?? "?"}`, {
      name: c.name ?? id,
      kind: "group",
      components: { Spawner: { creature: id, respawnSeconds: 60 } },
    });
  }
  for (const id of keysOf(rules("items").bases)) add("item", id, id, "item base", { name: id, kind: "group", components: { ItemSpawn: { base: id } } });

  // Prefabs: the files in content/prefabs, then the references scenes place that no file backs.
  const files = readPrefabs(repoRoot);
  for (const [id, p] of Object.entries(files)) {
    const n = Object.keys(p.components ?? {}).length;
    add("prefab", id, id, `prefab file: ${n} component${n === 1 ? "" : "s"}, ${(p.children ?? []).length} child node${(p.children ?? []).length === 1 ? "" : "s"}`, { name: id, prefab: id });
  }
  const prefabs = new Set<string>();
  const scenes = listScenes(repoRoot);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.prefab === "string" && o.prefab) prefabs.add(o.prefab);
    Object.values(o).forEach(walk);
  };
  for (const s of scenes) {
    try {
      walk(readScene(repoRoot, s));
    } catch {
      /* the Scenes workspace reports an unreadable scene */
    }
  }
  for (const id of [...prefabs].sort()) if (!(id in files)) add("prefab", id, id, "placed in a scene (no prefab file)", { name: id.split("/").pop() ?? id, prefab: id });

  const pcg = json(join(repoRoot, "content", "pcg", "index.json"));
  for (const a of (pcg?.assets ?? []) as { id: string; displayName?: string; variants?: number }[]) {
    add("picg", a.id, a.displayName ?? a.id, `${a.variants ?? 1} variants`, { name: a.displayName ?? a.id, kind: "prefab", prefab: a.id });
  }
  for (const s of scenes) add("scene", s, s, "scene document");
  for (const [id, q] of Object.entries((json(join(repoRoot, "content", "quests", "quests.json"))?.quests ?? {}) as Record<string, { name?: string }>)) {
    add("quest", id, q.name ?? id, "quest (moves its giver's post)", { name: q.name ?? id, kind: "group", components: { QuestGiver: { quest: id } } });
  }
  return { entries, notes };
}

export async function handleCatalog(repoRoot: string, method: string): Promise<{ status: number; body: unknown }> {
  if (method !== "GET") return { status: 404, body: { ok: false, error: "not found" } };
  try {
    return { status: 200, body: { ok: true, ...(await buildCatalog(repoRoot)) } };
  } catch (e) {
    return { status: 500, body: { ok: false, error: e instanceof Error ? e.message : String(e) } };
  }
}
