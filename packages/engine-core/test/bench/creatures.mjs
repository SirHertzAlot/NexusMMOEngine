// Creature brain cost per tick (docs/WILDLIFE.md): N wildlife creatures, P players, one step each.
//   npm run build -w @mmo-engine/engine-core && node packages/engine-core/test/bench/creatures.mjs [N...]
// Prints the mean and p99 ms of CreatureSystem.step over 300 ticks, with nobody near (all idle) and
// with players among them (flee, warn, chase), and the heap growth over the run (young-generation garbage from the Map iteration and
// this script's own loops, not retained state; run with --expose-gc).
import { addComponent } from "bitecs";
import { SimWorld } from "../../dist/src/world.js";
import * as C from "../../dist/src/components.js";
import { CreatureSystem } from "../../dist/src/creatures.js";
import { loadGameRules } from "../../dist/src/rules/boot.js";
import { loadWildlifeTable } from "../../dist/src/procgen/wildlife-table.js";
import { loadNaturalWeapons, wildlifeCreatures, withWildlife } from "../../dist/src/procgen/wildlife-creatures.js";

const game = loadGameRules();
const table = loadWildlifeTable();
const kinds = withWildlife(game.rules.creatures.creatures, wildlifeCreatures(table, loadNaturalWeapons()));
const land = Object.keys(table.species).filter((k) => table.species[k].habitat !== "water");

function run(n, players, near) {
  SimWorld.resetEntityCursorForTesting();
  const sim = new SimWorld();
  const ps = [];
  for (let i = 0; i < players; i++) {
    const p = sim.spawn();
    for (const c of [C.Transform, C.Health, C.CharacterRef]) addComponent(sim.ecs, c, p);
    C.Transform.px[p] = near ? (i * 97) % 1500 : 1e6;
    C.Transform.pz[p] = near ? (i * 53) % 1500 : 1e6;
    C.Health.current[p] = C.Health.max[p] = 100;
    ps.push(p);
  }
  const sys = new CreatureSystem({ creatures: kinds, bases: game.rules.items.bases, timeOfDay: (t) => (t / 30 / 40) % 1, warn() {}, cancelWarn() {} });
  let made = 0;
  for (let i = 0; made < n; i++) made += sys.spawnPack(sim, land[i % land.length], (i * 131) % 1500, (i * 71) % 1500).length;
  const times = [];
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  for (let t = 1; t <= 300; t++) {
    sim.beginTick(t);
    const t0 = process.hrtime.bigint();
    sys.step(sim);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    sim.endTick();
    for (const e of sys.entities()) { C.Transform.px[e] += C.PlayerIntent.mx[e] * 0.1; C.Transform.pz[e] += C.PlayerIntent.mz[e] * 0.1; }
  }
  const heap = process.memoryUsage().heapUsed - heap0;
  times.sort((a, b) => a - b);
  return { n: sys.size, mean: times.reduce((s, x) => s + x, 0) / times.length, p99: times[Math.floor(times.length * 0.99)], heapKB: heap / 1024 };
}

const sizes = process.argv.slice(2).map(Number);
for (const n of sizes.length ? sizes : [200, 1000, 5000]) {
  for (const [label, players, near] of [["idle (no player near)", 20, false], ["20 players among them", 20, true]]) {
    const r = run(n, players, near);
    console.log(`${String(r.n).padStart(5)} creatures, ${label.padEnd(22)}: mean ${r.mean.toFixed(3)} ms, p99 ${r.p99.toFixed(3)} ms per tick (budget 33 ms); heap ${r.heapKB.toFixed(0)} KB over 300 ticks`);
  }
}
