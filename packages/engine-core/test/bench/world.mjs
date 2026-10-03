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

/** N entities with Transform + Velocity: every one moves, so every one is in every delta. */
export function populatedWorld(n, seed = 1337) {
  const sim = new SimWorld();
  const prng = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const eid = sim.spawn();
    addComponent(sim.ecs, Transform, eid);
    addComponent(sim.ecs, Velocity, eid);
    Transform.px[eid] = (prng() - 0.5) * 100; Transform.py[eid] = 0; Transform.pz[eid] = (prng() - 0.5) * 100;
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

export async function benchGateway({ entities = 0, users = 0, clock } = {}) {
  return new Gateway({
    world: populatedWorld(entities),
    systems: [new IntentSystem(), new IntegrateSystem()],
    credentialStore: await benchCredentials(users),
    ...(clock ? { clock } : {}),
  });
}
