/**
 * B7: interest bandwidth (docs/superpowers/specs/2026-10-23-interest-management-design.md).
 * A gateway served through the edge channel (ChannelTransport, as with MMO_EDGE=1), 50 player
 * sessions logged in over relayed sockets and placed like the entities, 1k and 5k moving entities
 * in the "spread" (2 km square) and "towns" (70% in five 150 m towns) layouts. Per row:
 * bytes per client per tick (what the edge would send each player, modelled from the pushes:
 * wire.send to the session, wire.publish to every member of the topic), core tick ms, and channel
 * bytes per tick (the JSON push frames core -> edge). Not part of `npm test`.
 *
 * Run: node packages/engine-core/test/bench/b7-interest.mjs  (after building engine-core).
 */
import { decodeEnvelope, encodeDeltaSet, encodeControl, encodeEnvelope, MessageType, PROTOCOL_VERSION } from "@mmo-engine/protocol";
import { record, round, stats } from "../../../channel/test/bench/results.mjs";
import { ChannelTransport } from "../../dist/src/net/channel-transport.js";
import { applyTeleport } from "../../dist/src/admin/player.js";
import { ItemDefs, ItemService } from "../../dist/src/items/index.js";
import { engineDefaults } from "@mmo-engine/rules";
import { BENCH_PASSWORD, benchGateway, mulberry32, placeIn } from "./world.mjs";

const TICKS = 300, WARMUP = 30, SESSIONS = 50, STEP = 1000 / 30;
const MODES = (process.env.B7_MODES ?? "global").split(",");
// Spawn-burst (IM5 drops): with B7_BURSTS=0,1 each row also runs without and with bursts. A burst
// drops BURST_SIZE ground items at once, every BURST_EVERY ticks after warm-up, placed like the entities.
const BURSTS = (process.env.B7_BURSTS ?? "0").split(",").map((v) => v === "1");
const BURST_EVERY = 30, BURST_SIZE = 100;
const tick = () => new Promise((r) => setImmediate(r));

const DROP_POOL = [{
  id: "a", rank: "common", source: "mob", item: "sword", seed: 0,
  bundle: { Identity: { id: "a", name: "Sword a", base: "sword" }, Rank: { id: "common", color: "#aaaaaa" }, Stats: { power: 10 } },
}];

function makeItems() {
  const rules = engineDefaults();
  rules.items.bases.sword = {
    ...rules.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01"],
  };
  return new ItemService({ defs: new ItemDefs(DROP_POOL, rules), loot: rules.loot, tickHz: 30 });
}

async function run(layout, entities, mode, burst) {
  let now = 1_000_000;
  const subs = new Map(); // topic -> Set<sid>
  const perSid = new Map(); // sid -> bytes this tick
  const welcomed = new Map(); // sid -> player wire id
  let channelBytes = 0, edgeMs = 0;
  const credit = (sid, n) => perSid.set(sid, (perSid.get(sid) ?? 0) + n);
  const push = (type, payload) => {
    channelBytes += JSON.stringify({ type, id: "push-0", payload }).length;
    if (type === "wire.send") {
      const bytes = Buffer.from(payload.data, "base64");
      credit(payload.sid, bytes.length);
      if (!welcomed.has(payload.sid)) {
        const env = decodeEnvelope(new Uint8Array(bytes));
        if (env.type === MessageType.Welcome) welcomed.set(payload.sid, BigInt(JSON.parse(Buffer.from(env.payload).toString()).player_entity));
      }
    } else if (type === "wire.sub") {
      let m = subs.get(payload.topic);
      if (!m) subs.set(payload.topic, (m = new Set()));
      m.add(payload.sid);
    } else if (type === "wire.unsub") subs.get(payload.topic)?.delete(payload.sid);
    else if (type === "wire.sectors") {
      // The edge's assembly (game-relay.ts), timed: decode the shared bytes once, a DeltaSet per plan.
      const t0 = performance.now();
      const shared = new Map(Object.entries(payload.bytes).map(([k, v]) => [k, Buffer.from(v, "base64")]));
      for (const plan of payload.plans) {
        const set = encodeDeltaSet({ tick: payload.tick, replace: plan.replace, entries: plan.entries.map(([kind, sector, key]) => ({ kind, sector, bytes: shared.get(key) ?? new Uint8Array(0) })) });
        credit(plan.sid, set.length + 1);
      }
      edgeMs += performance.now() - t0;
    } else if (type === "wire.publish") {
      const n = Buffer.from(payload.data, "base64").length;
      for (const sid of subs.get(payload.topic) ?? []) credit(sid, n);
    }
  };
  const transport = new ChannelTransport(push, 4000);
  const items = burst ? makeItems() : null;
  const gw = await benchGateway({ entities, users: SESSIONS, layout, clock: () => now, transport, ...(items ? { items } : {}), ...(mode === "interest" ? { interest: { enterM: 96, leaveM: 128 } } : {}) });
  await gw.listen();
  gw.frame(now);
  for (let i = 0; i < SESSIONS; i++) {
    const sid = `b7-${i}`;
    await transport.handle({ type: "wire.open", id: "p", payload: { sid, ip: "127.0.0.1" } });
    const hello = encodeEnvelope(MessageType.Hello, encodeControl({ protocol: PROTOCOL_VERSION, client: "b7", want_snapshot: true, username: `bench-${i}`, password: BENCH_PASSWORD }));
    await transport.handle({ type: "wire.msg", id: "p", payload: { sid, data: Buffer.from(hello) } });
  }
  for (let i = 0; welcomed.size < SESSIONS; i++) {
    if (i > 3000) throw new Error(`only ${welcomed.size} sessions welcomed`);
    await new Promise((r) => setTimeout(r, 10));
  }
  // Players go where people are: the same distribution as the entities.
  const prng = mulberry32(7);
  for (const wid of welcomed.values()) {
    const [x, z] = placeIn(layout, prng);
    if (!applyTeleport(gw.world, wid, x, z, null).ok) throw new Error("teleport failed");
  }
  const tickMs = [], perClient = [], channel = [], edge = [];
  for (let i = 0; i < WARMUP + TICKS; i++) {
    now += STEP;
    perSid.clear();
    channelBytes = 0;
    edgeMs = 0;
    if (items && i >= WARMUP && (i - WARMUP) % BURST_EVERY === 0) {
      for (let k = 0; k < BURST_SIZE; k++) {
        const [x, z] = placeIn(layout, prng);
        items.spawnDrop(gw.world, 0, x, z, 0);
      }
    }
    const t0 = performance.now();
    gw.frame(now);
    const dt = performance.now() - t0;
    if (i >= WARMUP) {
      tickMs.push(dt);
      channel.push(channelBytes);
      edge.push(edgeMs);
      for (const sid of welcomed.keys()) perClient.push(perSid.get(sid) ?? 0);
    }
    if (i % 50 === 0) await tick();
  }
  await gw.close();
  return { layout, entities, mode, burst, perClientBytes: stats(perClient), tickMs: stats(tickMs), channelBytes: stats(channel), edgeMs: stats(edge) };
}

// B7_ONLY=spread:1000 runs just that layout and entity count (repeat runs for timing).
const ONLY = process.env.B7_ONLY ? process.env.B7_ONLY.split(":") : null;
const rows = [];
// B7_REPEATS=3 runs every cell that many times. The row reports the median of the per-run means
// and the min to max range, so a burst cost is confirmed only when it clears the spread.
const REPEATS = Math.max(1, Number(process.env.B7_REPEATS ?? 1));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
for (const mode of MODES) for (const burst of BURSTS) for (const layout of ["spread", "towns"]) for (const entities of [1000, 5000]) {
  if (ONLY && (ONLY[0] !== layout || Number(ONLY[1]) !== entities)) continue;
  const runs = [];
  for (let r = 0; r < REPEATS; r++) {
    runs.push(await run(layout, entities, mode, burst));
    const last = runs[runs.length - 1];
    console.error(`done ${mode} burst=${burst} ${layout} ${entities} run=${r + 1}/${REPEATS} tickMs mean=${round(last.tickMs.mean, 2)} p99=${round(last.tickMs.p99, 2)}`);
  }
  const pick = (get) => {
    const vals = runs.map(get);
    return { median: median(vals), min: Math.min(...vals), max: Math.max(...vals) };
  };
  rows.push({
    ...runs[0], runs: REPEATS,
    perClientBytes: { ...runs[0].perClientBytes, mean: median(runs.map((x) => x.perClientBytes.mean)) },
    tickMs: { ...runs[0].tickMs, mean: median(runs.map((x) => x.tickMs.mean)), p99: median(runs.map((x) => x.tickMs.p99)), range: pick((x) => x.tickMs.mean) },
    channelBytes: { ...runs[0].channelBytes, mean: median(runs.map((x) => x.channelBytes.mean)) },
    edgeMs: { ...runs[0].edgeMs, mean: median(runs.map((x) => x.edgeMs.mean)) },
  });
}
const kib = (b) => (b / 1024).toFixed(1);
record("B7", "Interest bandwidth", { ticks: TICKS, sessions: SESSIONS, rows }, `
${SESSIONS} sessions over the edge channel, placed like the entities; every entity moves every tick. ${TICKS} ticks after ${WARMUP} warm-up (includes the periodic snapshot tick). Mode \`global\` is today's path (every client gets the whole region's delta). Spawn burst \`yes\`: ${BURST_SIZE} ground items dropped at once every ${BURST_EVERY} ticks (drops ride the per-session drops path with interest on).

| Mode | Spawn burst | Layout | Entities | runs | bytes/client/tick mean | p99 | core tick ms mean, median of runs (min to max) | p99 | channel bytes/tick mean | p99 | edge assembly ms mean |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.mode} | ${r.burst ? "yes" : "no"} | ${r.layout} | ${r.entities} | ${r.runs} | ${kib(r.perClientBytes.mean)} KiB | ${kib(r.perClientBytes.p99)} KiB | ${round(r.tickMs.mean, 2)} (${round(r.tickMs.range.min, 2)} to ${round(r.tickMs.range.max, 2)}) | ${round(r.tickMs.p99, 2)} | ${kib(r.channelBytes.mean)} KiB | ${kib(r.channelBytes.p99)} KiB | ${round(r.edgeMs.mean, 3)} |`).join("\n")}
`);
process.exit(0);
