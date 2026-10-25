/**
 * Residents module server entry (SG3b, R1).
 *
 * The baked towns' people in the world: for every settlement manifest whose town is in the boot scene
 * (its square node `square-<id>` is there), a town of residents; likewise every baked homestead,
 * roadside inn and guard outpost of places.json whose node is in the scene (its family, keeper or
 * guards, with the farm field or pen as the workplace). Days come from settlement's
 * `scheduleAt` and whose anchors are the scene's structure positions (a structure's node id is its
 * structure id). Off unless the scene and a manifest match, or when MMO_RESIDENTS=0.
 *
 * Config (ctx.config.residents): structurePositions() -> Map<node id, {x, z}> | null (the boot scene),
 * manifestsDir, catalog, timeOfDay(tick), groundHeightAt, maxEntities.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ResidentSystem } from "../../packages/engine-core/dist/src/residents/index.js";
import { barkFor, scheduleAt, SQUARE } from "../../packages/settlement/dist/src/index.js";

export function createSystems(ctx) {
  const config = ctx.config?.residents ?? {};
  if (process.env.MMO_RESIDENTS === "0") return {};
  const positions = config.structurePositions?.();
  if (!positions || !config.manifestsDir || !existsSync(config.manifestsDir)) return {};

  const towns = [];
  for (const file of readdirSync(config.manifestsDir).filter((f) => f.endsWith(".settlement.json")).sort()) {
    const manifest = JSON.parse(readFileSync(join(config.manifestsDir, file), "utf8"));
    const square = positions.get(`square-${manifest.settlementId}`);
    if (!square || !manifest.occupancy) continue;
    const archetype = new Map(manifest.structures.map((s) => [s.id, s.archetype]));
    const taverns = manifest.structures.filter((s) => s.archetype === "tavern" || s.archetype === "inn").map((s) => s.id);
    const view = {
      archetypeOf: (id) => archetype.get(id),
      tavernNear: (home) => {
        const from = home ? positions.get(home) : square;
        let best;
        let bestD = Infinity;
        for (const id of taverns) {
          const p = positions.get(id);
          if (!p || !from) continue;
          const d = Math.hypot(p.x - from.x, p.z - from.z);
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
        return best;
      },
    };
    // The town's centre and radius, from its structures (the tiers go by a player's distance to its edge).
    const spots = manifest.structures.map((st) => positions.get(st.id)).filter(Boolean);
    const centre = spots.length ? { x: spots.reduce((n, p) => n + p.x, 0) / spots.length, z: spots.reduce((n, p) => n + p.z, 0) / spots.length } : square;
    const radius = spots.reduce((m, p) => Math.max(m, Math.hypot(p.x - centre.x, p.z - centre.z)), 0);
    towns.push({
      id: manifest.settlementId,
      centre,
      radius,
      npcs: manifest.occupancy.npcs,
      keeps: new Map((manifest.occupancy.shops ?? []).filter((s) => s.owner).map((s) => [s.owner, archetype.get(s.structure)])),
      view,
      positionOf: (anchor) => (anchor === SQUARE ? square : positions.get(anchor)),
    });
  }
  // Homesteads, inns and outposts (SG7, SG8): each place is a little town of its own.
  const placesFile = config.placesFile ?? join(config.manifestsDir, "places.json");
  if (existsSync(placesFile)) {
    const plan = JSON.parse(readFileSync(placesFile, "utf8"));
    for (const place of plan.places ?? []) {
      const house = positions.get(place.id);
      if (!house || !place.members?.length) continue;
      const field = place.works ? `${place.id}-${place.works}` : undefined;
      const archetype = new Map([[place.id, place.kind === "homestead" ? "farmhouse" : place.kind === "inn" ? "inn" : place.kind]]);
      if (field) archetype.set(field, place.works === "ranch" ? "ranch_pen" : "farm_field");
      towns.push({
        id: place.id,
        centre: house,
        radius: field ? 45 : 15,
        npcs: place.members,
        view: { archetypeOf: (id) => archetype.get(id), tavernNear: () => undefined },
        // The family's "square" is the yard before the house.
        positionOf: (anchor) => (anchor === SQUARE ? house : positions.get(anchor)),
      });
    }
  }
  if (towns.length === 0) return {};

  const residents = new ResidentSystem({
    towns,
    place: (town, npc, t) => scheduleAt(npc, t, towns.find((x) => x.id === town.id).view),
    timeOfDay: config.timeOfDay,
    dayOf: config.dayOf,
    bark: (town, npc, c) => {
      const view = towns.find((x) => x.id === town.id).view;
      return barkFor(npc, { ...c, workplace: npc.workplace ? view.archetypeOf(npc.workplace) : undefined, town: town.id });
    },
    catalog: config.catalog ?? null,
    groundHeightAt: config.groundHeightAt,
    maxEntities: config.maxEntities,
    fullM: config.fullM,
    coarseM: config.coarseM,
    maxFull: config.maxFull,
    store: config.store,
    raided: config.raided,
    replaceMs: config.replaceMs,
    attachShop: config.attachShop,
    detachShop: config.detachShop,
    steer: ctx.shared?.navBackend?.crowd !== undefined, // a crowd runs: residents walk between anchors
  });
  ctx.log(`[residents] ${towns.length} town(s), ${towns.reduce((n, t) => n + t.npcs.length, 0)} people`);
  return { residents };
}
