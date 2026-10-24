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
import { decodeEnvelope, encodeControl, encodeEnvelope, MessageType, PROTOCOL_VERSION } from "@mmo-engine/protocol";
import { record, round, stats } from "../../../channel/test/bench/results.mjs";
import { ChannelTransport } from "../../dist/src/net/channel-transport.js";
import { applyTeleport } from "../../dist/src/admin/player.js";
import { BENCH_PASSWORD, benchGateway, mulberry32, placeIn } from "./world.mjs";

const TICKS = 300, WARMUP = 30, SESSIONS = 50, STEP = 1000 / 30;
const MODES = (process.env.B7_MODES ?? "global").split(",");
const tick = () => new Promise((r) => setImmediate(r));

async function run(layout, entities, mode) {
  let now = 1_000_000;
  const subs = new Map(); // topic -> Set<sid>
  const perSid = new Map(); // sid -> bytes this tick
  const welcomed = new Map(); // sid -> player wire id
  let channelBytes = 0;
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
    else if (type === "wire.publish") {
      const n = Buffer.from(payload.data, "base64").length;
      for (const sid of subs.get(payload.topic) ?? []) credit(sid, n);
    }
  };
  const transport = new ChannelTransport(push, 4000);
  const gw = await benchGateway({ entities, users: SESSIONS, layout, clock: () => now, transport, ...(mode === "interest" ? { interest: { enterM: 96, leaveM: 128 } } : {}) });
  await gw.listen();
  gw.frame(now);
  for (let i = 0; i < SESSIONS; i++) {
    const sid = `b7-${i}`;
    await transport.handle({ type: "wire.open", id: "p", payload: { sid, ip: "127.0.0.1" } });
    const hello = encodeEnvelope(MessageType.Hello, encodeControl({ protocol: PROTOCOL_VERSION, client: "b7", want_snapshot: true, username: `bench-${i}`, password: BENCH_PASSWORD }));
    await transport.handle({ type: "wire.msg", id: "p", payload: { sid, data: Buffer.from(hello).toString("base64") } });
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
  const tickMs = [], perClient = [], channel = [];
  for (let i = 0; i < WARMUP + TICKS; i++) {
    now += STEP;
    perSid.clear();
    channelBytes = 0;
    const t0 = performance.now();
    gw.frame(now);
    const dt = performance.now() - t0;
    if (i >= WARMUP) {
      tickMs.push(dt);
      channel.push(channelBytes);
      for (const sid of welcomed.keys()) perClient.push(perSid.get(sid) ?? 0);
    }
    if (i % 50 === 0) await tick();
  }
  await gw.close();
  return { layout, entities, mode, perClientBytes: stats(perClient), tickMs: stats(tickMs), channelBytes: stats(channel) };
}

const rows = [];
for (const mode of MODES) for (const layout of ["spread", "towns"]) for (const entities of [1000, 5000]) {
  rows.push(await run(layout, entities, mode));
  console.error(`done ${mode} ${layout} ${entities}`);
}
const kib = (b) => (b / 1024).toFixed(1);
record("B7", "Interest bandwidth", { ticks: TICKS, sessions: SESSIONS, rows }, `
${SESSIONS} sessions over the edge channel, placed like the entities; every entity moves every tick. ${TICKS} ticks after ${WARMUP} warm-up (includes the periodic snapshot tick). Mode \`global\` is today's path (every client gets the whole region's delta).

| Mode | Layout | Entities | bytes/client/tick mean | p99 | core tick ms mean | p99 | channel bytes/tick mean | p99 |
|---|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.mode} | ${r.layout} | ${r.entities} | ${kib(r.perClientBytes.mean)} KiB | ${kib(r.perClientBytes.p99)} KiB | ${round(r.tickMs.mean, 2)} | ${round(r.tickMs.p99, 2)} | ${kib(r.channelBytes.mean)} KiB | ${kib(r.channelBytes.p99)} KiB |`).join("\n")}
`);
process.exit(0);
