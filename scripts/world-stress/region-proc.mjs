/**
 * One headless region for the world-server stress harness (slice D):
 * a real Gateway ticking a populated world at 30 Hz, registered with the
 * world server, with players wandering across its borders so that the
 * MigrationCoordinator hands them to the neighbouring regions.
 *
 * Forked by run.mjs (IPC). Messages:
 *   in:  {type:"arrive", migrationId}   a player's client reaches us
 *        {type:"report"}                send stats and reset them
 *        {type:"stop"}
 *   out: {type:"ready"} | {type:"redirect", endpoint, migrationId}
 *        {type:"accepted", migrationId, ok} | {type:"report", ...stats}
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { addComponent } from "bitecs";
import {
  CsvCredentialStore, Gateway, IntegrateSystem, IntentSystem, MigrationCoordinator,
  SimWorld, Transform, Velocity, WebrpcWorldTransport, WorldClient,
} from "../../packages/engine-core/dist/src/index.js";

const cfg = JSON.parse(process.argv[2]);
const { regionId, index, regions, worldUrl, apiKey, entities, players, chunkSize, chunksPerRegion, speed } = cfg;
const RANGE = { x0: index * chunksPerRegion, x1: (index + 1) * chunksPerRegion, z0: 0, z1: chunksPerRegion };
const WORLD_W = regions * chunksPerRegion * chunkSize;
const DEPTH = chunksPerRegion * chunkSize;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(1000 + index);

// -- the simulation: N moving entities, ticking at 30 Hz -------------------
const sim = new SimWorld();
for (let i = 0; i < entities; i++) {
  const eid = sim.spawn();
  addComponent(sim.ecs, Transform, eid);
  addComponent(sim.ecs, Velocity, eid);
  Transform.px[eid] = (rand() - 0.5) * 100; Transform.pz[eid] = (rand() - 0.5) * 100;
  Transform.qw[eid] = 1; Transform.sx[eid] = 1; Transform.sy[eid] = 1; Transform.sz[eid] = 1;
  Velocity.lx[eid] = (rand() - 0.5) * 4; Velocity.lz[eid] = (rand() - 0.5) * 4;
}
const credDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-stress-"));
const gw = new Gateway({ world: sim, systems: [new IntentSystem(), new IntegrateSystem()], credentialStore: new CsvCredentialStore(path.join(credDir, "users.csv")) });
const loopDelay = monitorEventLoopDelay({ resolution: 1 });
loopDelay.enable();

// -- the world link, with every webrpc call timed --------------------------
const opTimes = {};
const inner = new WebrpcWorldTransport(worldUrl, { timeoutMs: 5000 });
const transport = {
  async call(method, args, token) {
    const t0 = performance.now();
    try { return await inner.call(method, args, token); }
    finally { (opTimes[method] ??= []).push(performance.now() - t0); }
  },
};
const errors = {};
let lastError = null;
const client = new WorldClient({
  transport, regionId, chunkRange: RANGE, endpoint: `ws://${regionId}.stress`, capacity: 10_000, apiKey,
  getStats: () => ({ load: 0, tickJitterMs: loopDelay.percentile(99) / 1e6, entityCount: sim.liveEntityCount }),
  onError: (err, ctx) => { errors[ctx] = (errors[ctx] ?? 0) + 1; lastError = `${ctx}: ${err?.message ?? err}`; },
  onAck: (ack) => { void coord.onAck(ack).catch((e) => { errors.ack = (errors.ack ?? 0) + 1; }); },
});

// -- wandering players: plain state, moved off the tick --------------------
const here = new Map(); // id -> {x, z, vx, vz, hp, bag}
const host = {
  serialize: (id) => here.get(id) ?? null,
  instantiate: (id, s) => here.set(id, { ...s }),
  drop: (id) => here.delete(id),
  has: (id) => here.has(id),
  // The client is told to reconnect; the harness plays the client and delivers it.
  redirect: (id, endpoint, migrationId) => process.send({ type: "redirect", endpoint, migrationId }),
};
const coord = new MigrationCoordinator({ world: client, host, chunkRange: RANGE, chunkSize, retryAfterMs: 1000, log: () => {} });
const counts = { begun: 0, handed_off: 0, kept: 0, walked_back: 0, accepted: 0, refused: 0 };
coord.onEvent((e) => { counts[e.kind]++; });

for (let k = 0; k < players; k++) {
  const ang = rand() * Math.PI * 2;
  here.set(`${regionId}-p${k}`, {
    x: (RANGE.x0 + 0.5 + rand() * (chunksPerRegion - 1)) * chunkSize,
    z: (0.5 + rand() * (chunksPerRegion - 1)) * chunkSize,
    vx: Math.cos(ang) * speed, vz: Math.sin(ang) * speed,
    hp: 100, bag: Array.from({ length: 12 }, (_, i) => ({ def: i, n: 1 })),
  });
}
const STEP = 100;
const mover = setInterval(() => {
  for (const p of here.values()) {
    p.x += p.vx * STEP / 1000; p.z += p.vz * STEP / 1000;
    if (p.x < 1 || p.x > WORLD_W - 1) { p.vx = -p.vx; p.x = Math.min(Math.max(p.x, 1), WORLD_W - 1); }
    if (p.z < 1 || p.z > DEPTH - 1) { p.vz = -p.vz; p.z = Math.min(Math.max(p.z, 1), DEPTH - 1); }
  }
}, STEP);
let observing = false;
const observer = setInterval(() => {
  if (observing || !client.registered) return;
  observing = true;
  coord.observe([...here].map(([entityId, p]) => ({ entityId, x: p.x, z: p.z }))).finally(() => { observing = false; });
}, 250);

process.on("message", async (m) => {
  if (m.type === "arrive") {
    const t0 = performance.now();
    const ok = await coord.accept(m.migrationId);
    process.send({ type: "accepted", migrationId: m.migrationId, ok, ms: performance.now() - t0 });
  } else if (m.type === "report") {
    const tel = gw.telemetry.snapshot().tick;
    process.send({
      type: "report", regionId, ops: opTimes, counts: { ...counts }, errors: { ...errors },
      loopDelayP99Ms: loopDelay.percentile(99) / 1e6, loopDelayMaxMs: loopDelay.max / 1e6,
      tickP99Ms: tel.p99Ms, tickMaxMs: tel.maxMs, players: here.size, outgoing: coord.pendingOutgoing.size,
    });
    for (const k of Object.keys(opTimes)) delete opTimes[k];
    for (const k of Object.keys(counts)) counts[k] = 0;
    for (const k of Object.keys(errors)) delete errors[k];
    loopDelay.reset();
  } else if (m.type === "stop") {
    clearInterval(mover); clearInterval(observer);
    await client.stop();
    await gw.close();
    process.exit(0);
  }
});

gw.startTicking();
// Many regions starting at once can outrun the world (a register verifies
// the API key with argon2): retry for a while before giving up.
await client.start();
for (let tries = 1; !client.registered && tries < 20; tries++) {
  await client.stop();
  await new Promise((r) => setTimeout(r, 500 * tries));
  await client.start();
}
if (client.registered) await coord.refreshRegistry();
process.send({ type: "ready", registered: client.registered, error: client.registered ? null : lastError });
