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
 * ground carrying the kind's asset hash (settlement buildings; with a `Collider` of shape
 * `none` it is walk-through, like a town gate, and gets no foundation slab); otherwise a `Spawner` component's
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
import { fnv1a32, type Breakable as BreakableDef, type SpawnArchetype, type SpawnTable } from "@mmo-engine/scatter";
import { expandPrefabs, validatePrefab, validateScene, worldNodes, type PrefabDoc, type PrefabLookup, type SceneDoc, type ScaleCategory, type WorldNode } from "@mmo-engine/scene";
import type { SimWorld } from "./world.js";
import { BodyConfig, ShapeKind } from "./components.js";
import type { CreatureSystem } from "./creatures.js";
import { buildSpawn } from "./admin/spawn.js";
import { spawnScatterEntity } from "./procgen/scatter-spawn.js";
import { archetypeOk, landDry, LAND_MARGIN_M, STRUCTURE_MARGIN_M, surfaceAt } from "./procgen/habitat.js";
import type { ModelBounds } from "./procgen/prop-shape.js";
import type { ScaleResolver } from "./scale.js";
import type { ResourceNodeSpec } from "./gathering/gathering.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** The repo's content/scenes (this file is dist/src/scene-spawn.js). */
export const DEFAULT_SCENES_DIR = fileURLToPath(new URL("../../../../content/scenes", import.meta.url));
/** A building on a slope stands this far above its footprint's highest ground sample, metres. */
const PLINTH_M = 0.05;
const META_KEY ="scene_entities";
const ITEMS_KEY = "scene_items";
/** The repo's content/prefabs (this file is dist/src/scene-spawn.js). */
export const DEFAULT_PREFABS_DIR = fileURLToPath(new URL("../../../../content/prefabs", import.meta.url));

export interface SceneSpawnDeps {
  sim: SimWorld;
  creatures: Pick<CreatureSystem, "has" | "spawnPack">;
  /** The prop table (lazy: loading it cooks the scatter plan). */
  table: () => SpawnTable | null;
  groundHeightAt?: (x: number, z: number) => number;
  /**
   * The world's water (habitat.ts): the sea level, the water surface lookup (sea and lakes) and the river cells.
   * With any of them, a building or prop standing in or at the water is refused (and reported), never drowned;
   * aquatic archetypes (habitat water) are the only ones placed below it. Without them nothing is checked.
   */
  seaLevel?: number;
  waterAt?: (x: number, z: number) => number | null;
  riverAt?: (x: number, z: number) => boolean;
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
  /** Resource nodes (a Structure with a ResourceNode: tree stands, ore veins, fishing spots): `register` makes the spawned entity gatherable, keyed by scene and node id. */
  resources?: { register(eid: number, key: string, spec: ResourceNodeSpec): void };
  /** World chests (a Structure with a Chest component: loot `table`, `refillSeconds`): `register` makes the spawned entity openable. */
  /** Breakable props (a Structure with a Breakable component): `register` makes the spawned entity break at zero health, under the scene and node id. */
  breakables?: { register(eid: number, key: string, def: BreakableDef): void };
  /** What a Structure `kind` breaks like when its node has no Breakable component of its own (content/structures.json): buildings, walls, gates. */
  structureBreakable?: (kind: string) => BreakableDef | undefined;
  /** A shop (a node with a Vendor component): `attach` makes the spawned entity a vendor of the named template; returns an error text, or null. */
  vendors?: { attach(eid: number, template: string): string | null };
  chests?: { register(eid: number, key: string, spec: { kind?: "chest" | "door"; table?: string; refillSeconds?: number; castSeconds?: number; requires?: { base: string; consume: boolean } }): void };
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
        // A Collider with shape "none" makes it walk-through (a town gate: the road passes under it).
        const walkThrough = node.components?.Collider?.shape === "none";
        // A fishing spot stands on the water: a gatherable node of the Fishing skill is never refused as wet.
        const resource = node.components?.ResourceNode;
        const onWater = resource !== undefined && str(resource.skill).toLowerCase() === "fishing";
        const collision = walkThrough ? { shape: "none" as const, motion: "static" as const } : { shape: "box" as const, ...(modelSized ? {} : { halfExtents: half }), motion: "static" as const };
        // Ground under the whole footprint, not just its centre: the floor stands on the highest point
        // (nothing sinks into a slope), the body reaches the lowest, and a foundation slab fills the gap.
        const f = deps.scale?.("building", asset) ?? 1;
        const size = modelSized ? deps.bounds?.(asset) : undefined;
        const [hw, hd] = size ? [(size[0] * f) / 2, (size[2] * f) / 2] : [half[0] * f, half[2] * f];
        const yaw = (w.yawDeg * Math.PI) / 180;
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        let high = -Infinity;
        let low = Infinity;
        // Wet footing: every sample a metre above the water surface, and none on a river cell.
        let wet: string | null = null;
        // A grid over the footprint, a sample a metre or so apart (the terrain's own sample spacing), always
        // including the corners, edge midpoints and centre. ponytail: capped at 32 a side; a bump narrower than that spacing can slip between samples.
        const nx = Math.min(16, Math.max(2, Math.ceil(hw)));
        const nz = Math.min(16, Math.max(2, Math.ceil(hd)));
        for (let i = -nx; i <= nx; i++) {
          for (let j = -nz; j <= nz; j++) {
            const lx = (i / nx) * hw;
            const lz = (j / nz) * hd;
            const sx = x + lx * cos + lz * sin;
            const sz = z - lx * sin + lz * cos;
            const g = deps.groundHeightAt?.(sx, sz) ?? 0;
            if (g > high) high = g;
            if (g < low) low = g;
            if (wet === null && deps.groundHeightAt && !onWater) {
              if (!landDry(g, surfaceAt(deps.waterAt, deps.seaLevel, sx, sz), STRUCTURE_MARGIN_M)) wet = "under water or on the shore (less than " + STRUCTURE_MARGIN_M + " m above the water)";
              else if (deps.riverAt?.(sx, sz)) wet = "on a river";
            }
          }
        }
        if (wet !== null) {
          out.skipped.push({ id: node.id, reason: `structure ${kind} refused: its footprint is ${wet}` });
          continue;
        }
        // On a slope the floor stands a plinth above the highest sample: the ground between samples can peak a few cm higher.
        // On the water, the floor is the water's surface.
        const surface = onWater ? surfaceAt(deps.waterAt, deps.seaLevel, x, z) : null;
        const floor = surface !== null && surface > high ? surface : high - low > 0.01 ? high + PLINTH_M : high;
        const drop = floor - low;
        const building = spawnBody(deps, node.id, w, floor, asset, collision, "building");
        const entities = [building];
        if (drop > 0 && !walkThrough) {
          // The body reaches the lowest ground (its buried half already does, unless the drop is taller than it).
          if (BodyConfig.shapeKind[building] === ShapeKind.Box) BodyConfig.halfY[building] = Math.max(BodyConfig.halfY[building]!, drop);
          // The slab: the building's footprint, from the lowest ground up to the floor.
          const f2 = deps.scale?.("building", "structure:foundation") ?? 1;
          const slab = { shape: "box" as const, halfExtents: [hw / f2, drop / 2 / f2, hd / f2] as [number, number, number], motion: "static" as const };
          entities.push(spawnBody(deps, `${node.id}/foundation`, w, floor - drop / 2, "structure:foundation", slab, "building"));
        }
        if (resource && deps.resources) {
          deps.resources.register(building, `${doc.name}/${node.id}`, {
            kind,
            material: str(resource.material),
            tier: Number(resource.tier ?? 1),
            skill: str(resource.skill),
            stock: Number(resource.stock ?? 1),
            regrowHours: Number(resource.regrowHours ?? 0),
            halfX: hw,
            halfZ: hd,
          });
        }
        const chest = node.components?.Chest ?? node.components?.Door;
        if (chest && deps.chests) {
          const requires = str(chest.requires);
          deps.chests.register(building, `${doc.name}/${node.id}`, {
            kind: node.components?.Door ? "door" : "chest",
            table: str(chest.table),
            refillSeconds: Number(chest.refillSeconds ?? 600),
            castSeconds: Number(chest.castSeconds ?? 0),
            ...(requires ? { requires: { base: requires, consume: chest.consume === true } } : {}),
          });
        }
        const shop = node.components?.Vendor;
        if (shop && deps.vendors) {
          const problem = deps.vendors.attach(building, str(shop.template));
          if (problem) out.skipped.push({ id: node.id, reason: `vendor not attached: ${problem}` });
        }
        const brk = node.components?.Breakable;
        const byKind = !brk && deps.breakables ? deps.structureBreakable?.(kind) : undefined;
        if (byKind && deps.breakables) deps.breakables.register(building, `${doc.name}/${node.id}`, byKind);
        if (brk && deps.breakables) {
          const into = str(brk.into);
          deps.breakables.register(building, `${doc.name}/${node.id}`, {
            health: Number(brk.health ?? 50),
            into: into === "variant" || into === "debris" ? into : "remove",
            ...(str(brk.debris) ? { debris: str(brk.debris) } : {}),
            ...(str(brk.loot) ? { loot: str(brk.loot) } : {}),
            respawnS: Number(brk.respawnSeconds ?? 0) > 0 ? Number(brk.respawnSeconds) : null,
            ...(Number(brk.minStrength ?? 0) > 0 ? { minStrength: Number(brk.minStrength) } : {}),
            ...(str(brk.repairMaterial) ? { repair: { material: str(brk.repairMaterial), count: Math.max(1, Math.round(Number(brk.repairCount ?? 1))), castSeconds: Number(brk.repairSeconds ?? 4) } } : {}),
          });
        }
        out.spawned.push({ id: node.id, what: chest ? (node.components?.Door ? "door" : "chest") : resource ? `resource ${kind} (${str(resource.material)})` : `structure ${kind}`, entities });
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
        if (deps.groundHeightAt && !archetypeOk(built.archetype, LAND_MARGIN_M, ground, surfaceAt(deps.waterAt, deps.seaLevel, x, z))) {
          out.skipped.push({ id: node.id, reason: `prop ${asset} refused: ${built.archetype.habitat === "water" ? "not at its depths in the water" : "under water or on the shore"} (ground ${ground.toFixed(2)} m)` });
          continue;
        }
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
