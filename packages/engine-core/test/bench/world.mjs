/** A Gateway over a world of N moving entities, for the E5 benches. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addComponent } from "bitecs";
import { CsvCredentialStore, Gateway, hashPassword, IntegrateSystem, IntentSystem, SimWorld, Transform, Velocity } from "../../dist/src/index.js";

export const BENCH_PASSWORD = "bench-password-1";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** B7 town centres (towns layout): five 150 m towns inside the 2 km square. */
export const TOWNS = [[-600, -600], [600, -500], [0, 0], [-500, 550], [650, 600]];

/**
 * A position for layout: "packed" (B3/B4: a 100 m square), "spread" (a 2 km square) or
 * "towns" (70% inside five 150 m towns, the rest spread).
 */
export function placeIn(layout, prng) {
  if (layout === "packed") return [(prng() - 0.5) * 100, (prng() - 0.5) * 100];
  if (layout === "towns" && prng() < 0.7) {
    const [cx, cz] = TOWNS[Math.floor(prng() * TOWNS.length)];
    return [cx + (prng() - 0.5) * 150, cz + (prng() - 0.5) * 150];
  }
  return [(prng() - 0.5) * 2000, (prng() - 0.5) * 2000];
}

export { mulberry32 };

/** N entities with Transform + Velocity: every one moves, so every one is in every delta. */
export function populatedWorld(n, seed = 1337, layout = "packed") {
  const sim = new SimWorld();
  const prng = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid);
    addComponent(sim.ecs, Velocity, eid);
    const [x, z] = placeIn(layout, prng);
    Transform.px[eid] = x; Transform.py[eid] = 0; Transform.pz[eid] = z;
    Transform.qw[eid] = 1; Transform.sx[eid] = 1; Transform.sy[eid] = 1; Transform.sz[eid] = 1;
    Velocity.lx[eid] = (prng() - 0.5) * 4; Velocity.lz[eid] = (prng() - 0.5) * 4;
  }
  return sim;
}

/** Users bench-0 .. bench-(n-1), all with BENCH_PASSWORD. */
export async function benchCredentials(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-bench-"));
  const store = new CsvCredentialStore(path.join(dir, "users.csv"));
  const hash = await hashPassword(BENCH_PASSWORD);
  for (let i = 0; i < n; i++) await store.createUser(`bench-${i}`, hash);
  return store;
}

export async function benchGateway({ entities = 0, users = 0, clock, layout = "packed", ...rest } = {}) {
  return new Gateway({
    ...rest,
    world: populatedWorld(entities, 1337, layout),
    systems: [new IntentSystem(), new IntegrateSystem()],
    credentialStore: await benchCredentials(users),
    ...(clock ? { clock } : {}),
  });
}
