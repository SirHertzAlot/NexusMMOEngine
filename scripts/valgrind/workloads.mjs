#!/usr/bin/env node
/**
 * The engine's headless performance workloads, for callgrind
 * (scripts/valgrind/perf.mjs runs this file under it).
 *
 * Each workload builds its state (not measured), warms up (not measured,
 * so the JIT has settled), then runs `n` operations between the probe's
 * begin() and end(name): the dump holds exactly those instructions. The
 * baseline is instructions per operation.
 *
 *   node scripts/valgrind/workloads.mjs [name ...]     (outside valgrind:
 *   runs them once, as a smoke test, and prints wall time)
 *
 * Workloads whose packages aren't built (or don't exist on this branch)
 * are skipped with a note.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const probe = require(join(root, "packages/addons/perf-probe/index.js"));
const core = () => import(pathToFileURL(join(root, "packages/engine-core/dist/src/index.js")).href);

/** Deterministic PRNG (mulberry32), as the engine's own benchmarks use. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flat rectangles at y = 0 as a navmesh input (x0, x1, z0, z1), counter-clockwise from above. */
function rects(list) {
  const verts = [], idx = [];
  for (const [x0, x1, z0, z1] of list) {
    const b = verts.length / 3;
    verts.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

async function navWorld(size) {
  const { createNavigationBackend } = await core();
  const backend = createNavigationBackend({
    originX: 0, originZ: 0, tileWorldSize: size,
    profiles: [{ id: 0, agentHeight: 2, agentRadius: 0.35, agentMaxClimb: 0.9 }],
  });
  // A floor with a wall of pillars, so paths have corners to turn.
  const list = [[0, size, 0, size * 0.3], [0, size, size * 0.7, size]];
  for (let x = 0; x < size; x += 8) list.push([x, x + 5, size * 0.3, size * 0.7]);
  const { verts, idx } = rects(list);
  const { blob } = backend.bakeTile({
    tileX: 0, tileZ: 0, cellSize: 0.25, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.35, agentMaxClimb: 0.9,
    walkableSlopeAngle: 45, regionMinSize: 2, regionMergeSize: 20, edgeMaxLen: 12, edgeMaxError: 1.3,
    vertsPerPoly: 6, detailSampleDist: 6, detailSampleMaxError: 1,
  }, verts, idx);
  backend.loadTiles([blob]);
  return backend;
}

export const WORKLOADS = {
  /** The engine's tick on its benchmark world (sim.ts): 1,000 entities, intents, movement, a delta per tick. */
  "sim-tick-1000": {
    n: 60, warm: 30, unit: "tick",
    async setup() {
      const C = await core();
      // The same bitecs module engine-core imports (resolved from the repo root, as its own import is).
      const { addComponent } = await import("bitecs");
      const prng = mulberry32(1337);
      const sim = new C.SimWorld();
      const systems = [new C.IntentSystem(), new C.IntegrateSystem()];
      const tracker = new C.DeltaTracker();
      const mover = () => {
        const e = sim.spawn();
        addComponent(sim.ecs, C.Transform, e);
        addComponent(sim.ecs, C.Velocity, e);
        C.Transform.px[e] = (prng() - 0.5) * 100; C.Transform.pz[e] = (prng() - 0.5) * 100;
        C.Transform.qw[e] = 1; C.Transform.sx[e] = C.Transform.sy[e] = C.Transform.sz[e] = 1;
        C.Velocity.lx[e] = (prng() - 0.5) * 4; C.Velocity.lz[e] = (prng() - 0.5) * 4;
        return e;
      };
      const players = [];
      for (let i = 0; i < 600; i++) mover();
      for (let i = 0; i < 300; i++) {
        const e = mover();
        addComponent(sim.ecs, C.PlayerIntent, e);
        addComponent(sim.ecs, C.Health, e);
        C.Health.current[e] = C.Health.max[e] = 100;
        players.push(e);
      }
      for (let i = 0; i < 100; i++) {
        const e = sim.spawn();
        addComponent(sim.ecs, C.Transform, e);
        addComponent(sim.ecs, C.Chunk, e);
        C.Transform.px[e] = (prng() - 0.5) * 200; C.Transform.qw[e] = 1;
      }
      return { C, sim, systems, tracker, players, tick: 0 };
    },
    run(s) {
      const { C, sim } = s;
      const tick = ++s.tick;
      sim.beginTick(tick);
      for (let i = 0; i < s.players.length; i++) {
        const a = i + tick * 0.07;
        sim.queueIntent(s.players[i], { mx: Math.cos(a), my: 0, mz: Math.sin(a), lookYaw: a, lookPitch: 0, jump: false, buttons: 0 });
      }
      for (const sys of s.systems) sys.step(sim, C.STEP_MS / 1000);
      sim.emitTick(tick);
      C.encodeDelta(C.collectDeltaState(sim, tick, tick - 1, s.tracker));
      s.tracker.commit(sim);
      sim.endTick();
    },
  },

  /** Jolt: 200 dynamic boxes settling onto a static floor, one 30 Hz step. */
  "physics-step-200": {
    n: 60, warm: 20, unit: "step",
    setup() {
      const { createWorld, ShapeKind, MotionType } = require(join(root, "packages/addons/physics/index.js"));
      const w = createWorld();
      const n = 201;
      const f32 = (k) => new Float32Array(n * k);
      const d = {
        count: n, entityIds: new BigUint64Array(n), shapeKind: new Uint8Array(n).fill(ShapeKind.Box),
        halfExtents: f32(3).fill(0.5), radius: f32(1).fill(0.5), mass: f32(1).fill(10), friction: f32(1).fill(0.6),
        restitution: f32(1), motionType: new Uint8Array(n).fill(MotionType.Dynamic), layer: new Uint8Array(n).fill(1),
        pos: f32(3), quat: f32(4), linVel: f32(3), angVel: f32(3),
      };
      const prng = mulberry32(7);
      for (let i = 0; i < n; i++) {
        d.entityIds[i] = BigInt(i + 1);
        d.quat[i * 4 + 3] = 1;
        d.pos[i * 3] = (prng() - 0.5) * 20; d.pos[i * 3 + 1] = 1 + (i % 10) * 1.2; d.pos[i * 3 + 2] = (prng() - 0.5) * 20;
      }
      // The floor: body 0, static.
      d.motionType[0] = MotionType.Static; d.layer[0] = 0;
      d.halfExtents.set([40, 0.5, 40], 0); d.pos.set([0, -0.5, 0], 0);
      w.addBodies(d);
      return { w };
    },
    run(s) {
      s.w.step(1 / 30, 1);
    },
  },

  /** DetourCrowd through the engine's systems: 100 characters walking to targets across a 64 m tile, per tick. */
  "crowd-tick-100": {
    n: 60, warm: 20, unit: "tick",
    async setup() {
      const C = await core();
      // The same bitecs module engine-core imports (resolved from the repo root, as its own import is).
      const { addComponent } = await import("bitecs");
      const nav = await navWorld(64);
      const sim = new C.SimWorld();
      const crowd = new C.CrowdSystem(nav.crowd);
      const systems = [crowd, new C.IntentSystem(), new C.IntegrateSystem()];
      const prng = mulberry32(3);
      const walkers = [];
      for (let i = 0; i < 100; i++) {
        const e = sim.spawn();
        for (const c of [C.Transform, C.Velocity, C.PlayerIntent, C.Locomotion, C.NavAgent]) addComponent(sim.ecs, c, e);
        C.Transform.px[e] = 2 + prng() * 60; C.Transform.pz[e] = 2 + prng() * 14; C.Transform.qw[e] = 1;
        C.NavAgent.speed[e] = 3;
        C.NavAgent.tx[e] = 2 + prng() * 60; C.NavAgent.ty[e] = 0; C.NavAgent.tz[e] = 48 + prng() * 14;
        C.NavAgent.seq[e] = 1;
        walkers.push(e);
      }
      return { C, sim, systems };
    },
    run(s) {
      for (const sys of s.systems) sys.step(s.sim, 1 / 30);
    },
  },

  /** Residents (RS3): a town of 600 people placed by the schedule, one simulated second per operation (the system steps once a second), a player in the square. */
  "residents-tick": {
    n: 40, warm: 10, unit: "second",
    async setup() {
      const C = await core();
      const { addComponent } = await import("bitecs");
      const comps = await import(pathToFileURL(join(root, "packages/engine-core/dist/src/components.js")).href);
      const { ResidentSystem } = await import(pathToFileURL(join(root, "packages/engine-core/dist/src/residents/index.js")).href);
      const settlement = await import(pathToFileURL(join(root, "packages/settlement/dist/src/index.js")).href);
      const arch = { house: "house", bakery: "bakery", chapel: "chapel", tavern: "tavern" };
      const structures = Array.from({ length: 60 }, (_, i) => ["h" + i, { x: (i % 10) * 20, z: Math.floor(i / 10) * 20 }]);
      const pos = new Map([...structures, [settlement.SQUARE, { x: 100, z: 60 }], ["b1", { x: 40, z: 130 }], ["c1", { x: 80, z: 130 }], ["t1", { x: 120, z: 130 }]]);
      const archetypeOf = (s) => (s.startsWith("h") ? "house" : arch[{ b1: "bakery", c1: "chapel", t1: "tavern" }[s]]);
      const view = { archetypeOf, tavernNear: () => "t1" };
      const npcs = Array.from({ length: 600 }, (_, i) => ({
        id: "npc_" + i, household: "hh" + (i % 60), home: "h" + (i % 60), cohort: i % 5 === 0 ? "child" : "adult", class: "peasant", role: i % 3 === 0 ? "worker" : "resident",
        ...(i % 3 === 0 && i % 5 !== 0 ? { workplace: ["b1", "c1", "t1"][i % 9 === 0 ? 0 : i % 2 ? 1 : 2] } : {}),
      }));
      const town = { id: "t", npcs, positionOf: (a) => pos.get(a), centre: { x: 100, z: 60 }, radius: 100 };
      const sim = new C.SimWorld();
      const player = sim.spawn();
      for (const c of [C.Transform, comps.CharacterRef]) addComponent(sim.ecs, c, player);
      C.Transform.px[player] = 100; C.Transform.pz[player] = 60; C.Transform.qw[player] = 1;
      let hour = 0.3;
      const sys = new ResidentSystem({
        towns: [town], place: (_t, npc, tod) => settlement.scheduleAt(npc, tod, view), timeOfDay: () => hour, catalog: null,
      });
      return { sim, sys, tick: 0, bump: () => (hour = (hour + 0.01) % 1) };
    },
    run(s) {
      s.tick += 30;
      s.bump();
      s.sim.beginTick(s.tick);
      s.sys.step(s.sim);
    },
  },

  /** Detour: a batch of 100 paths round the pillars. */
  "paths-batch-100": {
    n: 20, warm: 5, unit: "batch",
    async setup() {
      const nav = await navWorld(64);
      const n = 100, prng = mulberry32(11);
      const input = { count: n, entityIds: new BigUint64Array(n), start: new Float32Array(n * 3), end: new Float32Array(n * 3), profile: new Uint8Array(n), maxWaypoints: 64 };
      for (let i = 0; i < n; i++) {
        input.entityIds[i] = BigInt(i + 1);
        input.start.set([2 + prng() * 60, 0, 2 + prng() * 14], i * 3);
        input.end.set([2 + prng() * 60, 0, 48 + prng() * 14], i * 3);
      }
      const output = { status: new Int32Array(n), waypointCount: new Uint32Array(n), polyCount: new Uint32Array(n), waypoints: new Float32Array(n * 64 * 3) };
      return { nav, input, output };
    },
    run(s) {
      s.nav.findPaths(s.input, s.output);
    },
  },

  /** FastNoise2: one 16 x 16 terrain chunk. */
  "procgen-chunk": {
    n: 200, warm: 50, unit: "chunk",
    setup() {
      const { generateChunk } = require(join(root, "packages/addons/procgen/index.js"));
      return { generateChunk, out: new Float32Array(256), i: 0 };
    },
    run(s) {
      s.i++;
      s.generateChunk(1234n, s.i % 64, (s.i / 64) | 0, 0, s.out);
    },
  },

  /** PICG: cook the spiral staircase fixture (a mid-size procedural asset). */
  "picg-cook-staircase": {
    n: 5, warm: 2, unit: "cook",
    setup() {
      const picg = require(join(root, "packages/addons/picg/index.js"));
      const graph = readFileSync(join(root, "packages/addons/picg/test/fixtures/spiral-staircase.pcg"), "utf8");
      return { picg, graph, seed: 0 };
    },
    async run(s) {
      await s.picg.cook(s.graph, ++s.seed);
    },
  },

  /** meshoptimizer: weld, reorder and build three levels of detail for the cooked staircase. */
  "meshopt-staircase": {
    n: 10, warm: 3, unit: "mesh",
    async setup() {
      const picg = require(join(root, "packages/addons/picg/index.js"));
      if (!picg.optimizeMesh) throw new Error("this addon-picg has no optimizeMesh");
      const graph = readFileSync(join(root, "packages/addons/picg/test/fixtures/spiral-staircase.pcg"), "utf8");
      const r = await picg.cook(graph, 1);
      return { picg, mesh: r.mesh };
    },
    run(s) {
      s.picg.optimizeMesh(s.mesh, { lods: [0.5, 0.25, 0.1], maxError: 0.05 });
    },
  },

  /** manifold + Clipper2: a 30-room dungeon's shell (walls, floors, ceilings carved from rock). */
  "dungeon-shell-30": {
    n: 3, warm: 1, unit: "shell",
    async setup() {
      const geo = require(join(root, "packages/addons/geometry/index.js"));
      const dungeon = await import(join(root, "packages/dungeon/dist/src/index.js"));
      if (!dungeon.dungeonShell) throw new Error("this @mmo-engine/dungeon has no dungeonShell");
      const d = dungeon.generateDungeon({ seed: 5, rooms: 30, loopChance: 0.15, decorDensity: 0.6, theme: "molten" }, dungeon.BUILTIN_THEMES.molten);
      return { geo, dungeon, d };
    },
    run(s) {
      s.dungeon.dungeonShell(s.d, s.geo);
    },
  },
};

/** Run the named workloads (all by default); returns [{ name, n, unit, ms } | { name, skipped }]. */
export async function runWorkloads(names = Object.keys(WORKLOADS)) {
  const results = [];
  for (const name of names) {
    const w = WORKLOADS[name];
    if (!w) throw new Error(`no workload "${name}" (have: ${Object.keys(WORKLOADS).join(", ")})`);
    let state;
    try {
      state = await w.setup();
    } catch (e) {
      results.push({ name, skipped: e.message.split("\n")[0] });
      continue;
    }
    for (let i = 0; i < w.warm; i++) await w.run(state, i);
    const t0 = performance.now();
    probe.begin();
    for (let i = 0; i < w.n; i++) await w.run(state, i);
    probe.end(name);
    results.push({ name, n: w.n, unit: w.unit, ms: performance.now() - t0 });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  const results = await runWorkloads(names.length ? names : undefined);
  // One JSON line for perf.mjs; a readable table otherwise.
  if (process.env.PERF_JSON) console.log(`PERF_RESULTS ${JSON.stringify(results)}`);
  else for (const r of results) console.log(r.skipped ? `  ${r.name.padEnd(22)} skipped: ${r.skipped}` : `  ${r.name.padEnd(22)} ${(r.ms / r.n).toFixed(3)} ms per ${r.unit} (${r.n} in ${r.ms.toFixed(1)} ms)`);
}
