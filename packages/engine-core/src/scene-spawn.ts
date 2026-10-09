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
 * Node resolution: a `Spawner` component's `creature` first, else the
 * node's `prefab` (the whole string, then its last path segment, so
 * "camps/goblin" finds the goblin). `spawn-point` and unknown prefabs are
 * reported as skipped, never an error. Heights: a node's y is added to the
 * ground height at its x/z (terrain snapping happens here, on the server).
 *
 * The spawned entities are written to the snapshot like any other, so the
 * next boot first removes what the previous boot spawned (their wire ids
 * are kept in the store's meta table) and then spawns again: no duplicates.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fnv1a32, type SpawnTable } from "@mmo-engine/scatter";
import { validateScene, worldNodes, type SceneDoc } from "@mmo-engine/scene";
import type { SimWorld } from "./world.js";
import type { CreatureSystem } from "./creatures.js";
import { buildSpawn } from "./admin/spawn.js";
import { spawnScatterEntity } from "./procgen/scatter-spawn.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
/** The repo's content/scenes (this file is dist/src/scene-spawn.js). */
export const DEFAULT_SCENES_DIR = fileURLToPath(new URL("../../../../content/scenes", import.meta.url));
const META_KEY = "scene_entities";

export interface SceneSpawnDeps {
  sim: SimWorld;
  creatures: Pick<CreatureSystem, "has" | "spawnPack">;
  /** The prop table (lazy: loading it cooks the scatter plan). */
  table: () => SpawnTable | null;
  groundHeightAt?: (x: number, z: number) => number;
}

export interface SceneSpawnResult {
  spawned: Array<{ id: string; what: string; entities: number[] }>;
  skipped: Array<{ id: string; reason: string }>;
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

export function spawnScene(doc: SceneDoc, deps: SceneSpawnDeps): SceneSpawnResult {
  const out: SceneSpawnResult = { spawned: [], skipped: [] };
  for (const w of worldNodes(doc)) {
    const { node } = w;
    if (node.kind === "spawn-point") {
      out.skipped.push({ id: node.id, reason: "spawn-point (players still enter at the world spawn)" });
      continue;
    }
    const creature = node.components?.Spawner?.creature;
    const names = [typeof creature === "string" ? creature : "", node.prefab ?? "", (node.prefab ?? "").split("/").pop() ?? ""].filter(Boolean);
    const [x, y, z] = w.position;
    const ground = deps.groundHeightAt?.(x, z) ?? 0;
    const kind = names.find((n) => deps.creatures.has(n));
    if (kind) {
      out.spawned.push({ id: node.id, what: `creature ${kind}`, entities: deps.creatures.spawnPack(deps.sim, kind, x, z) });
      continue;
    }
    const table = deps.table();
    const asset = table ? names.find((n) => n in table.archetypes) : undefined;
    if (table && asset) {
      const built = buildSpawn(table, asset, x, ground + y, z, (w.yawDeg * Math.PI) / 180);
      if (!("error" in built)) {
        built.sx = w.scale[0];
        built.sy = w.scale[1];
        built.sz = w.scale[2];
        built.seed = (fnv1a32(node.id) >>> 0) || 1;
        out.spawned.push({ id: node.id, what: `prop ${asset}`, entities: [spawnScatterEntity(deps.sim, built)] });
        continue;
      }
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
  const result = spawnScene(doc, deps);
  meta.setMeta(META_KEY, JSON.stringify(result.spawned.flatMap((s) => s.entities).map((e) => deps.sim.wireId(e).toString())));
  return result;
}
