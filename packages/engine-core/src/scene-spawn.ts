/**
 * Scene spawning (roadmap EA6, EDITOR-ARCHITECTURE.md section 5).
 *
 * `MMO_SCENE=<name>` makes the server read `content/scenes/<name>.scene.json`
 * (or `<MMO_SCENES>/<name>.scene.json`) and spawn the nodes of a world,
 * instance or arena scene as ordinary entities through the paths admin
 * `spawn` uses: a creature kind through the CreatureSystem (a pack, like
 * `spawn goblin`), a spawn-table archetype through `spawnScatterEntity`.
 * The client never reads a scene; it sees these entities on the wire.
 *
 * Prefab files (`content/prefabs/*.prefab.json`) are expanded first: a node
 * naming one becomes its component bundle with the node's own components laid
 * over it, plus its children.
 *
 * Node resolution: an `ItemSpawn` component puts an item on the ground, a
 * `QuestGiver` moves the quest giver's post, a `Structure` becomes a static box on the
 * ground carrying the kind's asset hash (settlement buildings); otherwise a `Spawner` component's
 * `creature`, else the node's `prefab`; a `Collider` replaces a prop's collision (shape `none`
 * makes it walk-through) or, on a node nothing else spawns, is a static box/sphere body (the whole string, then its last path
 * segment, so "camps/goblin" finds the goblin), else the `Spawner`'s `species`
 * (the roster's pack size). `spawn-point` and unknown prefabs are
 * reported as skipped, never an error. Heights: a node's y is added to the
 * ground height at its x/z (terrain snapping happens here, on the server).
 *
 * The spawned entities are written to the snapshot like any other, so the
 * next boot first removes what the previous boot spawned (their wire ids
 * are kept in the store's meta table) and then spawns again: no duplicates.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fnv1a32, type SpawnArchetype, type SpawnTable } from "@mmo-engine/scatter";
import { expandPrefabs, validatePrefab, validateScene, worldNodes, type PrefabDoc, type PrefabLookup, type SceneDoc, type ScaleCategory, type WorldNode } from "@mmo-engine/scene";
import type { SimWorld } from "./world.js";
import type { CreatureSystem } from "./creatures.js";
import { buildSpawn } from "./admin/spawn.js";
import { spawnScatterEntity } from "./procgen/scatter-spawn.js";
import type { ModelBounds } from "./procgen/prop-shape.js";
import type { ScaleResolver } from "./scale.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** The repo's content/scenes (this file is dist/src/scene-spawn.js). */
export const DEFAULT_SCENES_DIR = fileURLToPath(new URL("../../../../content/scenes", import.meta.url));
const META_KEY = "scene_entities";
const ITEMS_KEY = "scene_items";
/** The repo's content/prefabs (this file is dist/src/scene-spawn.js). */
export const DEFAULT_PREFABS_DIR = fileURLToPath(new URL("../../../../content/prefabs", import.meta.url));

export interface SceneSpawnDeps {
  sim: SimWorld;
  creatures: Pick<CreatureSystem, "has" | "spawnPack">;
  /** The prop table (lazy: loading it cooks the scatter plan). */
  table: () => SpawnTable | null;
  groundHeightAt?: (x: number, z: number) => number;
  /** The global scale: the factor per (category, asset), multiplied into every spawned prop and building. */
  scale?: ScaleResolver;
  /** Model sizes (the local art catalog): a Structure naming a model takes its body from them. */
  bounds?: ModelBounds;
  /** Prefab files (content/prefabs) by name: nodes naming one become its bundle. */
  prefabs?: PrefabLookup;
  /** The species roster: a Spawner's `species` spawns its creature at the species' pack size. */
  species?: (id: string) => { pack: readonly [number, number] } | undefined;
  /** Item nodes: `place` puts the base (at a rank) on the ground, null when the pool has none; `discard` removes ones placed by an earlier boot. */
  items?: {
    place(base: string, rank: string | undefined, x: number, z: number): { item: number } | null;
    discard(items: readonly number[]): void;
  };
  /** Quest nodes: move the quest giver's post to (x, z); null on success, else why not. */
  quests?: { place(quest: string, x: number, z: number): string | null };
}

export interface SceneSpawnResult {
  spawned: Array<{ id: string; what: string; entities: number[]; /** Item ids placed (not entities: the item service owns them). */ items?: number[] }>;
  skipped: Array<{ id: string; reason: string }>;
}

/** Read every `*.prefab.json` in `dir` (none if it doesn't exist). Throws listing every invalid file. */
export function loadPrefabs(dir: string): Record<string, PrefabDoc> {
  const out: Record<string, PrefabDoc> = {};
  if (!existsSync(dir)) return out;
  const problems: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".prefab.json")).sort()) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      problems.push(`${f}: not valid JSON: ${(e as Error).message}`);
      continue;
    }
    const issues = validatePrefab(doc);
    const name = f.slice(0, -".prefab.json".length);
    if ((doc as { name?: unknown } | null)?.name !== name) issues.push({ path: "name", message: `must match the file name "${name}"` });
    if (issues.length > 0) problems.push(...issues.map((i) => `${f}: ${i.path || "(prefab)"} ${i.message}`));
    else out[name] = doc as PrefabDoc;
  }
  if (problems.length > 0) throw new Error(`prefabs in ${dir}: ${problems.join("; ")}`);
  return out;
}

export interface SceneMeta {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** Read and validate a scene a server can run (not a frontend scene). */
export function loadSceneFile(dir: string, name: string): SceneDoc {
  if (!NAME_RE.test(name)) throw new Error(`MMO_SCENE: bad scene name "${name}" (lowercase letters, digits and dashes)`);
  const file = join(dir, `${name}.scene.json`);
  if (!existsSync(file)) throw new Error(`MMO_SCENE: no scene "${name}" in ${dir}`);
  const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
  const issues = validateScene(doc);
  if (issues.length > 0) {
    throw new Error(`MMO_SCENE: invalid scene "${name}": ${issues.map((i) => `${i.path || "(scene)"} ${i.message}`).join("; ")}`);
  }
  const scene = doc as SceneDoc;
  if (scene.kind === "frontend") throw new Error(`MMO_SCENE: "${name}" is a frontend scene (client-only); a server runs world, instance or arena scenes`);
  return scene;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

type Collision = NonNullable<SpawnArchetype["collision"]>;

/** A scene `Collider` as a static collision (scene defaults: a 0.5 box, a 0.5 sphere); none when the node has no Collider. */
function colliderOf(c: Record<string, unknown> | undefined): Collision | undefined {
  if (!c) return undefined;
  const n = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
  const shape = c.shape === "sphere" || c.shape === "none" ? c.shape : "box";
  return { shape, halfExtents: [n(c.hx, 0.5), n(c.hy, 0.5), n(c.hz, 0.5)], radius: n(c.radius, 0.5), motion: "static" };
}

/** One static body at the node's world pose (y above the ground), carrying `asset`'s hash, through the scatter spawn path. */
function spawnBody(deps: SceneSpawnDeps, id: string, w: WorldNode, ground: number, asset: string, collision: Collision, category: ScaleCategory = "prop"): number {
  const [x, y, z] = w.position;
  return spawnScatterEntity(deps.sim, {
    x, y: ground + y, z, yaw: (w.yawDeg * Math.PI) / 180, pitch: 0, roll: 0, sx: 1, sy: 1, sz: 1,
    assetId: asset, assetHash: fnv1a32(asset), variant: 0, seed: (fnv1a32(id) >>> 0) || 1, archetype: { asset, collision, category },
  }, deps.bounds, deps.scale);
}

export function spawnScene(scene: SceneDoc, deps: SceneSpawnDeps): SceneSpawnResult {
  const out: SceneSpawnResult = { spawned: [], skipped: [] };
  // Prefab files become their bundle (components, children) before anything spawns.
  const expanded = deps.prefabs ? expandPrefabs(scene, deps.prefabs) : { doc: scene, problems: [] as string[] };
  for (const p of expanded.problems) out.skipped.push({ id: p.split(":")[0], reason: p });
  const doc = expanded.doc;
  for (const w of worldNodes(doc)) {
    const { node } = w;
    if (node.kind === "spawn-point") {
      out.skipped.push({ id: node.id, reason: "spawn-point (players still enter at the world spawn)" });
      continue;
    }
    const [x, y, z] = w.position;
    const ground = deps.groundHeightAt?.(x, z) ?? 0;
    // An item on the ground, a quest's post: placed things with no creature behind them.
    const item = node.components?.ItemSpawn;
    if (item) {
      const base = str(item.base);
      const placed = base && deps.items ? deps.items.place(base, str(item.rank) || undefined, x, z) : null;
      if (placed) out.spawned.push({ id: node.id, what: `item ${base}`, entities: [], items: [placed.item] });
      else out.skipped.push({ id: node.id, reason: !base ? "Item has no base" : !deps.items ? "this server has no items" : `no item of base "${base}" in the pool` });
      continue;
    }
    const quest = node.components?.QuestGiver;
    if (quest) {
      const refused = str(quest.quest) ? (deps.quests ? deps.quests.place(str(quest.quest), x, z) : "this server has no quests") : "Quest giver has no quest";
      if (refused === null) out.spawned.push({ id: node.id, what: `quest ${str(quest.quest)}`, entities: [] });
      else out.skipped.push({ id: node.id, reason: refused });
      continue;
    }
    // A building (a settlement structure): a static box on the ground that carries an asset hash.
    // The hash is the named art model's (the client shows it when the art is served) or, with none
    // named, the kind's "structure:<kind>". The box stands on the ground with its centre at ground
    // level, so a model's base sits on the ground and a stand-in box shows exactly `height` above it.
    const structure = node.components?.Structure;
    if (structure) {
      const kind = str(structure.kind);
      if (!kind) out.skipped.push({ id: node.id, reason: "Structure has no kind" });
      else {
        const half: [number, number, number] = [Number(structure.width) / 2, Number(structure.height), Number(structure.depth) / 2];
        const asset = str(structure.asset) || `structure:${kind}`;
        // A named model that the catalog knows sizes the body (bounds x scale); otherwise the authored footprint.
        const modelSized = str(structure.asset) !== "" && deps.bounds?.(asset) !== undefined;
        const collision = { shape: "box" as const, ...(modelSized ? {} : { halfExtents: half }), motion: "static" as const };
        out.spawned.push({ id: node.id, what: `structure ${kind}`, entities: [spawnBody(deps, node.id, w, ground, asset, collision, "building")] });
      }
      continue;
    }
    const creature = node.components?.Spawner?.creature;
    const names = [str(creature), node.prefab ?? "", (node.prefab ?? "").split("/").pop() ?? ""].filter(Boolean);
    const kind = names.find((n) => deps.creatures.has(n));
    if (kind) {
      out.spawned.push({ id: node.id, what: `creature ${kind}`, entities: deps.creatures.spawnPack(deps.sim, kind, x, z) });
      continue;
    }
    // A species from the roster (content/species): its creature rules, its pack size.
    const species = str(node.components?.Spawner?.species);
    if (species) {
      const sp = deps.species?.(species);
      if (!sp) out.skipped.push({ id: node.id, reason: `no species "${species}" in the roster` });
      else if (!deps.creatures.has(species)) out.skipped.push({ id: node.id, reason: `species "${species}" has no creature rules (add a creature named "${species}")` });
      else out.spawned.push({ id: node.id, what: `species ${species}`, entities: deps.creatures.spawnPack(deps.sim, species, x, z, sp.pack) });
      continue;
    }
    // A Collider node: its box/sphere replaces a prop's own collision, or stands alone as a static body.
    const collision = colliderOf(node.components?.Collider);
    const table = deps.table();
    const asset = table ? names.find((n) => n in table.archetypes) : undefined;
    if (table && asset) {
      const built = buildSpawn(table, asset, x, ground + y, z, (w.yawDeg * Math.PI) / 180);
      if (!("error" in built)) {
        built.sx = w.scale[0];
        built.sy = w.scale[1];
        built.sz = w.scale[2];
        built.seed = (fnv1a32(node.id) >>> 0) || 1;
        if (collision) built.archetype = { ...built.archetype, collision };
        out.spawned.push({ id: node.id, what: `prop ${asset}`, entities: [spawnScatterEntity(deps.sim, built, deps.bounds, deps.scale)] });
        continue;
      }
    }
    if (collision && collision.shape !== "none") {
      out.spawned.push({ id: node.id, what: `collider ${collision.shape}`, entities: [spawnBody(deps, node.id, w, ground, names[0] || `collider:${node.id}`, collision)] });
      continue;
    }
    out.skipped.push({ id: node.id, reason: names.length > 0 ? `nothing spawns "${names[0]}"` : "no prefab or Spawner creature" });
  }
  return out;
}

/** Remove what the previous boot spawned, spawn the scene, remember the new entities. */
export function spawnSceneOnBoot(doc: SceneDoc, deps: SceneSpawnDeps, meta: SceneMeta): SceneSpawnResult {
  const previous = meta.getMeta(META_KEY);
  if (previous) {
    for (const wire of JSON.parse(previous) as string[]) {
      const slot = deps.sim.resolveWireId(BigInt(wire));
      if (slot >= 0) deps.sim.despawn(slot);
    }
  }
  // Items the previous boot placed come back from the ledger: discard what still lies there.
  const prevItems = meta.getMeta(ITEMS_KEY);
  if (prevItems && deps.items) deps.items.discard(JSON.parse(prevItems) as number[]);
  const result = spawnScene(doc, deps);
  meta.setMeta(ITEMS_KEY, JSON.stringify(result.spawned.flatMap((s) => s.items ?? [])));
  meta.setMeta(META_KEY, JSON.stringify(result.spawned.flatMap((s) => s.entities).map((e) => deps.sim.wireId(e).toString())));
  return result;
}
