// Server-side playtest of building collapse on a baked village scene (no client, no art): the scene is spawned through
// spawnScene with the real break + collapse systems and the real Jolt world; parts are broken the way combat would
// (health to 0) and the fall is measured (parts that fell, peak dynamic carriers, entity count, per-tick cost).
//
//   SCENE=<settlement scene json> [MAXA=64] [PERTICK=8] [SCEN=largest,median,smallest,demolish] //     node scripts/collapse-playtest.mjs
//
// Needs the engine-core, scatter and addon builds (npm run build). The headless world has no terrain, so a flat slab
// is put under every building. Results: docs/DESTRUCTION-PLAYTEST.md.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const W = new URL("packages/engine-core/dist/src/", ROOT).href;
const imp = (f) => import(W + f);
const { SimWorld, PhysicsSystem, createJoltBackend, STEP_MS } = await imp("index.js");
const C = await imp("components.js");
const { spawnScene } = await imp("scene-spawn.js");
const { BreakSystem, breakDefsOf, CollapseSystem, loadStructureBreakables } = await imp("interact/index.js");
const { CreatureSystem } = await imp("creatures.js");
const { loadGameRules } = await imp("rules/boot.js");
const { parseSpawnTableJSON } = await import(new URL("packages/scatter/dist/src/index.js", ROOT).href);

const SCENE = process.env.SCENE;
if (!SCENE) throw new Error("set SCENE to a baked settlement scene json");
const dt = STEP_MS / 1000;
const game = loadGameRules();
const doc = JSON.parse(readFileSync(SCENE, "utf8"));
const kinds = loadStructureBreakables(fileURLToPath(new URL("content/structures.json", ROOT)));

async function world(store) {
  SimWorld.resetEntityCursorForTesting?.();
  const sim = new SimWorld();
  const collapse = new CollapseSystem({ maxActive: +(process.env.MAXA ?? 64), perTick: +(process.env.PERTICK ?? 8), ...(store ? { store } : {}) });
  let pbMs = 0, pbCalls = 0; const origPB = collapse.partBroken.bind(collapse); collapse.partBroken = (s2, e) => { const t = performance.now(); const r = origPB(s2, e); pbMs += performance.now() - t; pbCalls++; return r; };
  globalThis.__pb = () => [pbCalls, +pbMs.toFixed(1)];
  const breaks = new BreakSystem(breakDefsOf(), { ...(store ? { store } : {}), onBreak: (s, ev) => collapse.partBroken(s, ev.eid) });
  const creatures = new CreatureSystem({ creatures: game.rules.creatures.creatures, bases: game.rules.items.bases });
  const t0 = performance.now();
  const r = spawnScene(doc, {
    sim, creatures, table: () => parseSpawnTableJSON({ version: 1, archetypes: {} }),
    breakables: { register: (eid, key, def) => breaks.register(sim, eid, key, def) },
    structureBreakable: (k) => kinds.get(k),
    collapse: { registerBuilding: (s, key, parts, o) => collapse.registerBuilding(s, key, parts, o) },
  });
  const spawnMs = performance.now() - t0;
  // The real server has terrain colliders; this headless world has none, so give it flat ground at y = 0.
  const { addComponent } = await import("bitecs");
  // One flat slab under every building (the buildings are kilometres from the origin).
  for (const [, bld] of collapse.buildings) {
    const e0 = sim.resolveWireId(bld.parts[0].wid);
    const ground = sim.spawn();
    addComponent(sim.ecs, C.Transform, ground); addComponent(sim.ecs, C.Velocity, ground); addComponent(sim.ecs, C.BodyConfig, ground);
    C.Transform.px[ground] = C.Transform.px[e0]; C.Transform.pz[ground] = C.Transform.pz[e0];
    C.Transform.py[ground] = -0.5; C.Transform.qw[ground] = 1;
    C.BodyConfig.shapeKind[ground] = 0; C.BodyConfig.halfX[ground] = 60; C.BodyConfig.halfY[ground] = 0.5; C.BodyConfig.halfZ[ground] = 60;
    C.BodyConfig.motionType[ground] = 0; C.BodyConfig.layer[ground] = 0; C.BodyConfig.friction[ground] = 0.8;
  }
  const physics = new PhysicsSystem(createJoltBackend());
  return { sim, collapse, breaks, physics, r, spawnMs };
}

if (process.env.PERSIST) {
  // Persistence: demolish a building, let it settle, then boot a second world from the same store and compare.
  const { SqlitePlacesStore } = await imp("interact/index.js");
  const Database = (await import("better-sqlite3")).default;
  const store = new SqlitePlacesStore(new Database(":memory:"));
  const a = await world(store);
  const pick = [...a.collapse.buildings.entries()].sort((x, y) => y[1].parts.length - x[1].parts.length)[1];
  const grounded = pick[1].graph.grounded.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  for (const i of grounded) { const e = a.sim.resolveWireId(pick[1].parts[i].wid); if (e >= 0) C.Health.current[e] = 0; }
  for (let i = 0; i < 30 * 40; i++) { a.breaks.step(a.sim); a.collapse.step(a.sim, dt); a.physics.step(a.sim, dt); }
  const rec = store.all().filter((r) => r.kind === "collapse");
  console.log("run 1:", { building: pick[0], parts: pick[1].parts.length, fell: a.collapse.stats.fallen, stillFalling: a.collapse.stats.active, queued: a.collapse.stats.queued, collapseRecords: rec.length, breakRecords: store.all().filter((r) => r.kind === "break").length, entities: a.sim.liveEntityCount });
  const poseOf = (w2, key) => { const b = w2.collapse.buildings.get(key); return b.parts.map((p) => { const e = w2.sim.resolveWireId(p.wid); return e < 0 ? null : [+C.Transform.px[e].toFixed(2), +C.Transform.py[e].toFixed(2), +C.Transform.pz[e].toFixed(2)]; }); };
  const before = poseOf(a, pick[0]);
  a.physics.close();
  const b = await world(store);
  const after = poseOf(b, pick[0]);
  const same = before.filter((p, i) => JSON.stringify(p) === JSON.stringify(after[i])).length;
  if (process.env.SHOWDIFF) console.log(before.map((p, i) => (JSON.stringify(p) === JSON.stringify(after[i]) ? null : [i, p, after[i]])).filter(Boolean).slice(0, 6));
  let ticks = 0;
  for (; ticks < 30 * 5; ticks++) { b.breaks.step(b.sim); b.collapse.step(b.sim, dt); b.physics.step(b.sim, dt); }
  console.log("run 2 (restart):", { partsAtSamePose: same + " of " + before.length, partsGoneBoth: before.filter((p, i) => p === null && after[i] === null).length, fellAgainAfter5s: b.collapse.stats.fallen, stillFalling: b.collapse.stats.active, queued: b.collapse.stats.queued, entities: b.sim.liveEntityCount, spawnMs: +b.spawnMs.toFixed(0) });
  b.physics.close();
  process.exit(0);
}
const w = await world();
const { sim, collapse, breaks, physics } = w;
const stats = { spawned: w.r.spawned.length, skipped: w.r.skipped.length, buildings: collapse.stats.buildings, entities: sim.liveEntityCount, spawnMs: +w.spawnMs.toFixed(0) };
console.log("scene", stats);

// Pick buildings by size, largest first, and find a ground-level wall to break.
const byBuilding = [...collapse.buildings.entries()].map(([k, b]) => ({ k, b })).sort((a, b) => b.b.parts.length - a.b.parts.length);
const tickOnce = () => {
  const t = performance.now();
  breaks.step(sim);
  const t1 = performance.now();
  collapse.step(sim, dt);
  const t2 = performance.now();
  physics.step(sim, dt);
  const t3 = performance.now();
  return [t1 - t, t2 - t1, t3 - t2];
};
// Settle the static scene.
for (let i = 0; i < 30; i++) tickOnce();

const results = [];
for (const which of (process.env.SCEN ? process.env.SCEN.split(",") : ["largest", "median", "smallest", "demolish"])) {
  const list = byBuilding;
  const pick = which === "largest" || which === "demolish" ? list[which === "demolish" ? 1 : 0] : which === "median" ? list[Math.floor(list.length / 2)] : list[list.length - 1];
  const b = pick.b;
  // Break the grounded part nearest the middle: the building's own foundation-level wall/floor.
  const g = b.graph;
  const grounded = g.grounded.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  let best = -1, bestDep = -1;
  for (const i of grounded) if (g.dependents[i].length > bestDep) { bestDep = g.dependents[i].length; best = i; }
  const eid = sim.resolveWireId(b.parts[best].wid);
  if (eid < 0) continue;
  const f0 = collapse.stats.fallen;
  const before = { entities: sim.liveEntityCount, standing: g.stands.filter(Boolean).length };
  // Break it as combat would: health to zero, the break system does the rest.
  if (which === "demolish") { for (const i of grounded) { const e = sim.resolveWireId(b.parts[i].wid); if (e >= 0) C.Health.current[e] = 0; } } else C.Health.current[eid] = 0;
  const all = [];
  const times = { break: 0, collapse: 0, physics: 0, ticks: 0, maxTick: 0 };
  let peakActive = 0, peakEntities = before.entities;
  const timeline = [];
  for (let i = 0; i < 30 * 20; i++) {
    const [a, c, p] = tickOnce();
    times.break += a; times.collapse += c; times.physics += p; times.ticks++;
    times.maxTick = Math.max(times.maxTick, a + c + p); all.push([a + c + p, i]);
    peakActive = Math.max(peakActive, collapse.stats.active);
    peakEntities = Math.max(peakEntities, sim.liveEntityCount);
    if (i % 60 === 59) timeline.push({ t: (i + 1) / 30, fallen: collapse.stats.fallen - f0, active: collapse.stats.active, queued: collapse.stats.queued });
  }
  results.push({ partBroken: globalThis.__pb(),
    building: pick.k, size: which, parts: b.parts.length, grounded: grounded.length, brokenPart: best, dependentsOfBroken: bestDep,
    standingBefore: before.standing, fallen: collapse.stats.fallen - f0, queuedLeft: collapse.stats.queued, peakActive, entitiesBefore: before.entities, entitiesPeak: peakEntities, entitiesAfter: sim.liveEntityCount,
    pct: (() => { const v = all.map((x) => x[0]).sort((x, y) => x - y); const q = (f) => +v[Math.min(v.length - 1, Math.floor(v.length * f))].toFixed(2); return { p50: q(0.5), p95: q(0.95), p99: q(0.99), top: all.slice().sort((x, y) => y[0] - x[0]).slice(0, 4).map((x) => [+x[0].toFixed(1), x[1]]) }; })(), avgTickMs: { collapse: +(times.collapse / times.ticks).toFixed(4), physics: +(times.physics / times.ticks).toFixed(3), break: +(times.break / times.ticks).toFixed(4) }, worstTickMs: +times.maxTick.toFixed(2), timeline,
  });
}
console.log(JSON.stringify(results, null, 1));
physics.close();
