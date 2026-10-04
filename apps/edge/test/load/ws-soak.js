// k6 WebSocket soak against the edge (slice E6 of docs/EDGE-CORE-SPLIT.md).
//
//   k6 run apps/edge/test/load/ws-soak.js
//   EDGE_WS_URL=ws://host:3001 k6 run apps/edge/test/load/ws-soak.js
//   CORE_DOWN=1 k6 run ...   (the core is down on purpose: core.unavailable is expected)
//
// Each virtual user holds one connection, sends `ping` every 200 ms and one
// `player.intent` a second. It asserts on the edge's answers only: the core
// may be a stub, so an intent's answer just has to come back.
import ws from "k6/ws";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const URL = __ENV.EDGE_WS_URL || "ws://localhost:3001";
const CORE_DOWN = __ENV.CORE_DOWN === "1";

const pingRtt = new Trend("ping_rtt", true);
const coreUnavailable = new Counter("core_unavailable");
const badAnswers = new Counter("bad_answers");

export const options = {
  stages: [
    { duration: "1m", target: 50 },
    { duration: "3m", target: 50 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    ping_rtt: ["p(99)<100"],
    core_unavailable: CORE_DOWN ? [] : ["count==0"],
    bad_answers: ["count==0"],
  },
};

export default function () {
  const res = ws.connect(URL, null, (socket) => {
    const sent = new Map();
    let n = 0;
    const send = (type, payload) => {
      const id = `${__VU}-${n++}`;
      sent.set(id, Date.now());
      socket.send(JSON.stringify({ type, id, payload }));
    };

    socket.on("open", () => {
      socket.setInterval(() => send("ping", {}), 200);
      socket.setInterval(() => send("player.intent", { token: "k6-soak", intent: { mx: 0, my: 0, mz: 1, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 } }), 1000);
      // Each iteration holds its connection for 30 s, then the VU reconnects.
      socket.setTimeout(() => socket.close(), 30000);
    });

    socket.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { badAnswers.add(1); return; }
      const t0 = sent.get(msg.id);
      if (t0 === undefined) { badAnswers.add(1); return; }
      sent.delete(msg.id);
      if (msg.type === "ping") pingRtt.add(Date.now() - t0);
      else if (msg.type === "core.unavailable") coreUnavailable.add(1);
      else if (msg.type !== "player.intent") badAnswers.add(1);
    });
  });
  check(res, { "connected (101)": (r) => r && r.status === 101 });
}
