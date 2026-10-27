## Edge / Core Split — Build Plan

**For:** Claude (the implementing agent). **Goal:** separate the engine into two processes — the **edge** API layer (client connections, HTTP routes, generic packet router, content services) and **engine-core** (pure simulation) — with zero open decisions. Work the slices in order, E1 through E6. Do not start a slice until the previous slice's done checklist is fully green.

**Why:** today the front door (player connections) and the engine room (simulation) are one process. If the core crashes or stalls, every player disconnects. After this change: core-down → the edge holds connections and degrades gracefully; edge-down → the core keeps simulating with no rollback.

**The same 6 global rules from the quest build plan apply** (edge-side/content determinism, no `Math.random` in new packages, strict validation, tests + docs per slice). New packages also follow the repo's existing TypeScript/Express conventions — do not invent new frameworks.

**Ordering vs the quest plan:** E1 → E2 → E3 → E4. Quest slices Q1–Q6 are independent of the E-slices. Q7 (editor routes) requires E1 done — its routes register on the edge. Q9's mythic evaluator reads the edge's tick buffer (provided in E2).

---

## Slice E1 — Edge skeleton + generic packet router

**Goal:** a running edge process that accepts WebSocket + HTTP, routes packets by type from a data file, and answers. Core forwarding is stubbed (real channel arrives in E2).

**Files to create (exact, repo-root relative):**
```
apps/edge/src/index.ts
apps/edge/src/config.ts
apps/edge/src/router.ts
apps/edge/src/channel-stub.ts
apps/edge/src/modules/ping.ts
apps/edge/test/router.test.ts
apps/edge/test/config.test.ts
apps/edge/README.md
content/edge/routes.json
```
Add `apps/edge` to the root `package.json` workspaces array if not picked up automatically.

**`config.ts` — exact:**
```ts
export interface EdgeConfig { httpPort: number; wsPort: number; coreChannelPort: number; }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig {
  const p = (name: string, def: number): number => {
    const raw = env[name] ?? String(def);
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port in ${name}: ${raw}`);
    return n;
  };
  return { httpPort: p("EDGE_HTTP_PORT", 3000), wsPort: p("EDGE_WS_PORT", 3001), coreChannelPort: p("CORE_CHANNEL_PORT", 4000) };
}
```
Copy exactly.

**`content/edge/routes.json` — seed exactly:**
```json
{ "routes": [
  { "packetType": "ping", "destination": "local:ping" },
  { "packetType": "player.intent", "destination": "core" },
  { "packetType": "auth.login", "destination": "core" }
] }
```
Rules: `packetType` unique; `destination` is `"core"` or matches `^local:[a-z0-9_]+$`. Rows for not-yet-built modules are allowed in the future — the router errors cleanly until the module registers (see below). Quest slices add their rows when they land (Q7 adds `quest.preview` etc.).

**`router.ts` — exact:**
```ts
export interface RouteEntry { packetType: string; destination: string; }
export interface ChannelLike {
  request(type: string, payload: unknown, id: string): Promise<unknown>;
  readonly status: "up" | "down" | "unknown";
}
export interface RouterCtx { channel: ChannelLike; modules: Record<string, (payload: unknown) => Promise<unknown> | unknown>; }
export function loadRoutes(path: string): RouteEntry[];  // strict: throws listing every bad row
export async function routePacket(
  packet: { type?: unknown; id?: unknown; payload?: unknown },
  routes: RouteEntry[], ctx: RouterCtx
): Promise<{ type: string; id: string; payload: unknown }> {
  const id = typeof packet.id === "string" ? packet.id : "none";
  if (typeof packet.type !== "string")
    return { type: "error.bad_packet", id, payload: { message: "packet.type must be a string" } };
  const route = routes.find(r => r.packetType === packet.type);
  if (!route)
    return { type: "error.unknown_packet", id, payload: { packetType: packet.type } };
  if (route.destination === "core") {
    try { const result = await ctx.channel.request(packet.type, packet.payload ?? null, id);
      return { type: packet.type, id, payload: result }; }
    catch (err) {
      return { type: "core.unavailable", id, payload: { retry: true,
        message: "The world is restarting. Your connection is safe — try again shortly." } };
    }
  }
  const mod = route.destination.slice("local:".length);
  const handler = ctx.modules[mod];
  if (!handler)
    return { type: "error.unknown_module", id, payload: { module: mod } };
  const result = await handler(packet.payload ?? null);
  return { type: packet.type, id, payload: result };
}
```
Copy this function exactly. The `core.unavailable` shape and message are the contract reused by E4's degraded mode — character-identical.

**`channel-stub.ts`:** `export class StubChannel implements ChannelLike { readonly status = "unknown" as const; request(): Promise<unknown> { throw new Error("core channel not yet implemented (E2)"); } }` — E2 replaces this with the real client; the router code does not change.

**`modules/ping.ts`:** `export async function pingHandler(): Promise<unknown> { return { pong: true }; }`

**`index.ts` — exact boot behavior:**
1. `loadConfig()`, `loadRoutes("content/edge/routes.json")` (resolve relative to repo root: walk up from `__dirname` until `package.json` with a `workspaces` field is found — implement `findRepoRoot()` here, exact).
2. Create Express app: `GET /health` → `{ ok: true, core: channel.status }`.
3. WebSocket server on wsPort: on message → JSON.parse (failure → send `{ type: "error.bad_packet", id: "none", payload: { message: "invalid JSON" } }`) → `routePacket` → send response.
4. Register modules: `{ ping: pingHandler }`.
5. SIGTERM/SIGINT → stop accepting, close servers after 5 s, exit 0.

**Tests:**
- `router.test.ts`: (1) `ping` route returns `{ pong: true }`; (2) unknown type → `error.unknown_packet` with the packetType echoed; (3) packet without type → `error.bad_packet`; (4) `player.intent` with the stub channel → `core.unavailable` with `retry: true` and the exact message; (5) temp routes file with a duplicated packetType throws naming it; (6) `local:nosuch` row → `error.unknown_module`.
- `config.test.ts`: defaults 3000/3001/4000; env overrides respected; `EDGE_HTTP_PORT=abc` throws naming the var.

**README:** what the edge is, the routes.json format, the 3 steps to add a module (implement handler in `src/modules/`, register in `index.ts`, add row to routes.json), the stub note pointing at E2.

**Done checklist:** `npm test` green; `grep -rn "Math.random" apps/edge` empty; boot the built edge and `GET /health` returns `{ok:true,core:"unknown"}`; README matches implementation.

---

## Slice E2 — Internal channel edge↔core

**Goal:** the real private channel between edge and core: framed TCP, request/response with correlation, server→client pushes, heartbeats, reconnect backoff. Replaces E1's stub.

**Files to create (exact):**
```
packages/channel/src/types.ts
packages/channel/src/framing.ts
packages/channel/src/client.ts
packages/channel/src/server.ts
packages/channel/src/index.ts
packages/channel/test/framing.test.ts
packages/channel/test/channel.test.ts
packages/channel/README.md
```
Add `packages/channel` to workspaces. Then modify `apps/edge/src/index.ts`: replace `new StubChannel()` with the real client (exact change specified below). Keep `channel-stub.ts` (tests still use it) but index.ts no longer imports it.

**`types.ts` — exact:**
```ts
export interface ChannelPacket { type: string; id: string; payload: unknown; }
export interface ChannelResponse { type: string; id: string; payload: unknown; error?: string; }
export interface ChannelLike {
  request(type: string, payload: unknown, id: string, timeoutMs?: number): Promise<unknown>;
  notify(type: string, payload: unknown): void;
  onPush(type: string, handler: (payload: unknown) => void): void;
  onStatus(cb: (s: "up" | "down" | "unknown") => void): void;
  readonly status: "up" | "down" | "unknown";
}
```
(This supersedes E1's narrower `ChannelLike` — update `apps/edge/src/router.ts` to import the type from `packages/channel`. The router only uses `request` and `status`.)

**`framing.ts` — exact wire format:**
- `encodeFrame(obj: unknown): Buffer`: `JSON.stringify` → UTF-8 bytes; if bytes > 8 MiB (8388608) throw `frame exceeds 8 MiB`; output = 4-byte big-endian length + bytes.
- `class FrameReader { push(chunk: Buffer): unknown[] }`: buffers partial frames across pushes; returns all complete decoded objects (JSON.parse); on invalid JSON in a complete frame, throw `invalid frame JSON` (and drop the connection — caller closes the socket).

**`client.ts` — `class ChannelClient implements ChannelLike`. Exact behavior:**
- Constructor `{ port: number; host?: string; heartbeatMs?: number; maxMissed?: number }`; defaults host `127.0.0.1`, heartbeatMs `5000`, maxMissed `3`.
- `connect(): Promise<void>` resolves on TCP connect. Any close/error → status `"down"`, notify status listeners, schedule reconnect.
- `request(type, payload, id, timeoutMs = 5000)`: if status !== `"up"` → reject `Error("channel down")` immediately. Else write frame, store pending by id; on matching response id: `error` set → reject `Error(response.error)`; else resolve payload. No response within timeoutMs → delete pending, reject `Error("channel timeout after " + timeoutMs + "ms for " + type)` (exact format).
- `notify(type, payload)`: if status === `"up"`, write `{ type, id: "push-" + (counter++), payload }`. Never waits.
- `onPush(type, handler)`: incoming frames with id starting `"push-"` are dispatched to handlers (no response sent); all other ids match pending requests (unknown id → ignore).
- Heartbeat: every `heartbeatMs`, if status is `"up"`, send `{ type: "channel.ping", id: "hb-" + (counter++), payload: {} }` via notify and expect any frame within the interval as liveness; simpler exact rule: count intervals with zero inbound frames as missed; `maxMissed` consecutive missed → destroy socket (triggers reconnect path).
- Reconnect delays: 1000, 2000, 4000, 8000, 16000, then 30000 cap (exact sequence; no jitter). On successful connect → status `"up"`, notify listeners, reset backoff.
- Request ids are caller-supplied (the router passes the client packet id through — correlation is end-to-end). Internal ids (`push-`, `hb-`) use one incrementing counter starting at 0. No randomness anywhere.

**`server.ts` — exact:**
- `serveChannel(port: number, handler: (p: ChannelPacket) => Promise<unknown>): Promise<ChannelServer>`.
- Per connection: FrameReader; on `{ type: "channel.ping" }` → immediately respond `{ type: "channel.pong", id: <same id>, payload: {} }`; otherwise `await handler(packet)` → respond `{ type: packet.type, id: packet.id, payload: result }`; handler throw → respond with `error: String(err && err.message ? err.message : err)`.
- Returned `ChannelServer`: `{ pushToAll(type: string, payload: unknown): void; close(): Promise<void>; }`. `pushToAll` writes `{ type, id: "push-" + (counter++), payload }` to every connected socket.
- Malformed frame → close that socket (do not crash the server).

**`index.ts`:** re-export everything. Nothing else.

**E1 integration (exact change to `apps/edge/src/index.ts`):** replace stub construction with:
```ts
const channel = new ChannelClient({ port: config.coreChannelPort });
channel.onStatus(() => {}); // status is polled by /health; no action needed yet (E4 wires reactions)
channel.connect().catch(err => console.error("initial channel connect failed, retrying in background:", err.message));
```
Boot must NOT fail if the core isn't running — log and continue; the reconnect loop handles it.

**Tests:**
- `framing.test.ts`: round-trip object; two frames in one push → 2 objects; frame split across 3 pushes → 1 object; >8 MiB throws.
- `channel.test.ts`: (1) request/response happy path with echo handler; (2) handler throw → client rejects with the handler's message; (3) timeout: handler never responds, timeoutMs 50 → rejects with exact `channel timeout after 50ms for test.type`; (4) push: server `pushToAll("tick.events", {...})` → client's onPush handler receives payload; (5) reconnect: connect, kill server, restart on same port (heartbeatMs 50, backoff starts 1000 — test waits), status returns "up" and a request succeeds; (6) heartbeat death: server accepts TCP but a handler that never answers pings… simpler exact: connect client to a raw TCP server that never sends anything, heartbeatMs 50, maxMissed 3 → status becomes "down" within ~300ms.

**README:** byte diagram of the frame (4-byte BE length + JSON), the packet/response shapes, heartbeat + backoff numbers, the push convention (`push-` ids), and "E3 wires the core side."

**Done checklist:** `npm test` green; `grep -rn "Math.random" packages/channel` empty; edge boots against a live test channel server and `/health` reports `"up"`; README matches implementation.

---

## Slice E3 — Core decoupling

**Goal:** engine-core stops talking to players. It keeps the tick loop, ECS, addons, and SQLite; it drops every client-facing listener and serves the internal channel instead.

**Files to modify/create (exact):**
```
packages/engine-core/src/channel-server.ts   (create)
packages/engine-core/src/index.ts             (modify: boot channel instead of gateway)
packages/engine-core/src/sessions.ts          (modify or create: SQLite-backed sessions)
packages/engine-core/test/channel-server.test.ts (create)
packages/engine-core/README.md                (modify)
apps/edge/src/mirror.ts                       (create: moved fan-out code)
apps/edge/src/mirror-buffer.ts                (create)
```

**Remove client listeners (exact):** delete or gate off every `server.listen(...)` / WebSocket-server construction in `packages/engine-core` that accepts player connections. Keep the tick loop, ECS world, C++ addon calls, and SQLite exactly as they are. Verification (in done checklist): `grep -rn "\.listen(" packages/engine-core/src` shows ONLY the channel serve call.

**`channel-server.ts` — exact:** boot `serveChannel(port, handler)` from `packages/channel`, port from `CORE_CHANNEL_PORT` env (default 4000, same parsing/validation as E1's config — copy the helper, do not import edge code). The handler routes these exact packet types:
- `player.intent` → push `payload` into the sim's existing intent queue (the same queue the old gateway used — do not redesign the queue); respond `{ accepted: true, tick: currentTick }`.
- `auth.login` → run the EXISTING auth logic unchanged (CSV/argon2 dev path); respond `{ ok: true, token, playerId }` or `{ ok: false, reason }` — byte-shape compatible with what the old gateway returned. Do not redesign auth in this slice.
- `session.validate` → payload `{ token }` → `{ valid: boolean }` from the sessions table.
- `core.sync` → `{ tick: currentTick, sessionIds: string[] }` (all unexpired session tokens).
- `mythic.grant_item` → payload `{ playerId, itemId, instanceId, stats }` → apply via the EXISTING inventory mutation path; respond `{ ok: true }`. (Content of the grant comes from the edge's mythic evaluator — the core does not validate lore here.)
- `mythic.spawn_boss` → payload `{ bossId, instanceId, placeId, stats }` → enqueue into the sim's EXISTING spawn pipeline; respond `{ ok: true, instanceId }`.
- `metrics.get` → respond with the core registry's Prometheus scrape text (added for E6; the registry lives behind this packet type from the start so E6 is wiring, not refactoring).
- Any other type → the channel server's default unknown-type error (no custom code needed).

**Sessions → SQLite (exact):** table `sessions`: `token TEXT PRIMARY KEY, playerId TEXT NOT NULL, createdTick INTEGER NOT NULL, expiresTick INTEGER NOT NULL`. Replace the in-memory session map with DB reads/writes. Expiry policy UNCHANGED (same TTL semantics as before — do not redesign sessions here).

**Per-tick event stream (exact):** at the end of every tick, call the channel server's `pushToAll("tick.events", { tick: n, events: [...] })` where `events` is that tick's gameplay events in the engine's existing event shape. Send EVERY tick, even when the array is empty. (The edge feeds these to content systems like the mythic evaluator.)

**Mirror stream — deltas + snapshots (exact):** the core produces the mirror protocol data; the edge fans it out to clients. Wire it as pushes:
- Every tick: `pushToAll("tick.delta", { tick: n, delta: <existing delta builder output> })`.
- Every 300 ticks (the existing snapshot cadence): `pushToAll("snapshot", { tick: n, snapshot: <existing snapshot builder output> })`.
- Move the existing client fan-out code from the old gateway into the edge UNCHANGED as `apps/edge/src/mirror.ts` — same subscribe/send logic, but its input is now the push buffer below instead of direct function calls. Do not redesign the mirror protocol in this slice.
- Edge side (`apps/edge/src/mirror-buffer.ts`, exact): keep `latestSnapshot: { tick, snapshot } | null` and `latestDelta: { tick, delta } | null`; `onPush("tick.delta", ...)` and `onPush("snapshot", ...)` update them. New WebSocket client → immediately send `latestSnapshot` (if null, wait for the next one — do not request it from the core), then live deltas. This replaces the old "snapshot on connect" gateway path with zero new round trips.

**Edge tick buffer (exact, in `apps/edge`):** add `apps/edge/src/tick-buffer.ts`:
```ts
export interface TickEntry { tick: number; events: unknown[]; }
const MAX_TICKS = 3600;
const buf: TickEntry[] = [];
export function pushTick(tick: number, events: unknown[]): void {
  buf.push({ tick, events });
  while (buf.length > MAX_TICKS) buf.shift();
}
export function getTickBuffer(): TickEntry[] { return buf; }
```
In `apps/edge/src/index.ts`, register `channel.onPush("tick.events", (p) => { const { tick, events } = p as { tick: number; events: unknown[] }; pushTick(tick, events); })`. (Q9's evaluator reads this buffer when that slice lands.)

**Tests (`channel-server.test.ts`):**
1. `player.intent` round-trip over a real channel: accepted true, tick is a non-negative integer.
2. `session.validate` with a bogus token → `{ valid: false }`.
3. `core.sync` → tick integer + sessionIds array.
4. Unknown packet type → response has `error` set.
5. `tick.events` push: connect a test channel client with onPush → run 3 ticks → receives 3 pushes with ascending ticks.
6. Mirror stream: extract the snapshot cadence into a pure `isSnapshotTick(n): boolean` (`n % 300 === 0`) in the core; test it directly (0→false? exact: tick 0 is a snapshot tick → true; 1→false; 300→true). Spy on pushToAll: drive ticks where `isSnapshotTick` is true → `snapshot` pushed; other ticks → only `tick.delta` pushed.
7. The grep check from "Remove client listeners" above (encode as a test that scans the source dir — or document as a manual done-checklist item; do BOTH: manual checklist item).

**README (engine-core):** new "Processes" section: what moved to the edge, the channel packet catalog (the 7 types above + tick.events), the sessions table, and "players never connect here."

**Done checklist:** `npm test` green; grep check passes; core boots headless binding ONLY `CORE_CHANNEL_PORT`; a full tick still runs (existing sim tests green); README matches.

---

## Slice E4 — Degraded mode + resync

**Goal:** the edge behaves sanely when the core dies and recovers cleanly when it returns. No new packages.

**Files to modify (exact):**
```
apps/edge/src/index.ts          (modify: status reactions + resync)
apps/edge/test/degraded.test.ts (create)
apps/edge/README.md             (modify: degraded-mode + client contract)
```

**Exact behavior:**
1. The router ALREADY maps channel failures to `core.unavailable` (E1) — no change needed there. E4 wires the lifecycle around it.
2. Track `coreStatus` from `channel.onStatus`. On transition to `"down"`: log `core channel down at <ISO timestamp>` (exact format: `console.error("core channel down at " + new Date().toISOString())`). Nothing else changes — local routes (`local:*`) keep working; that IS degraded mode.
3. On transition `"down"` → `"up"` (resync, exact steps in order):
   a. `await channel.request("core.sync", {}, "sync-" + Date.now())` with timeout 10000.
   b. Prune the edge's `knownSessions: Set<string>` (add this Set to index.ts in E1's place — E4 adds it; it records session tokens from successful `auth.login` responses passing through the router): drop any token not in the returned `sessionIds`.
   c. Log `core resync complete at <ISO> tick=<n> sessions=<m>` (exact format).
   d. If the sync request itself fails → stay `"down"` (do not half-resync; the reconnect loop will retry and the transition will fire again).
4. Intents sent during the outage are NOT replayed (documented: player intents are ephemeral; the client re-sends on `core.unavailable` per the contract below).

**Client contract (document in README, exact):** when the edge cannot reach the core it responds `{ type: "core.unavailable", id: <same id>, payload: { retry: true, message: "The world is restarting. Your connection is safe — try again shortly." } }`. Clients MUST: show a non-dismissible "reconnecting" banner on this packet; automatically retry the original action once after 3 seconds; never drop the WebSocket. (Client implementation is out of scope — this documents the contract the client team builds against.)

**Tests (`degraded.test.ts`, real channel client + server):**
1. Kill the channel server mid-run → `routePacket({type:"player.intent",...})` returns `core.unavailable` with `retry: true` and the exact message; `routePacket({type:"ping",...})` still returns `{ pong: true }`.
2. `GET /health` equivalent (call the health handler directly) reports `core: "down"` while down, `"up"` after restart.
3. Restart the server → resync runs (spy on channel.request: first call after "up" is `core.sync`); unknown session tokens pruned from knownSessions; `player.intent` flows again.
4. Sync failure (server accepts TCP but never answers) → status stays "down", no partial resync (knownSessions untouched).

**Done checklist:** `npm test` green; kill-core/restart-core drill passes end-to-end with a real edge + core pair; README documents degraded mode + the client contract verbatim.

---

## Slice E5 — Empirical evaluation of the split

**Goal:** replace opinions about the split with numbers. Run every benchmark below, record the results, and file follow-ups for any breached budget. No redesigns in this slice — measure, record, report.

**Results file (exact):** `docs/EDGE-SPLIT-RESULTS.md` at the repo root. Each bench script prints a JSON summary to stdout AND appends a dated markdown section (date, machine specs, commit hash, numbers). Create the file if missing.

**Bench script locations (exact):** `packages/channel/test/bench/` (B1, B2), `packages/engine-core/test/bench/` (B3, B4), `apps/edge/test/bench/` (B5, B6). Bench scripts are not part of `npm test` (they take minutes); they run via `npm run bench:e5` from the root (add the script).

**B1 — Extra-hop latency.** Method: edge + core on one machine, loopback. Drive 10,000 `player.intent` packets through the full path (WS test client → edge → channel → core → back); timestamp at edge ingress and edge egress; report p50/p95/p99. Budget: **p99 < 1 ms** added by the hop.

**B2 — Channel throughput.** Method: N concurrent channel clients (N = 10, 50, 100) sending `player.intent` in a tight loop for 30 s against a core whose handler responds immediately; report sustained req/s and p99 latency per N. No fixed budget — establish the baseline; flag in RESULTS.md if p99 exceeds 10 ms at 100 clients.

**B3 — Tick overhead of pushes.** Method: sim tick harness, pushes enabled vs disabled, same seed, 1000 ticks; report mean tick time both ways. Budget: **pushes add < 0.5 ms** mean per tick.

**B4 — Delta bandwidth at scale.** Method: sim with 1k, 5k, 10k entities; capture `tick.delta` frames for 300 ticks each; report bytes/sec through the channel at 30 Hz and JSON encode time per delta (mean/p99). Budget: **encode p99 < 5 ms** (must stay well inside the 33.3 ms tick); bandwidth reported as info.

**B5 — Failure drill timings (the point of the split).** Method, all wall-clock: (1) `kill -9` the core mid-session → time to edge marking "down" (expect ≈ heartbeatMs × maxMissed = 15 s at defaults — record actual); (2) time from "down" to first `core.unavailable` served (expect < 100 ms — record actual); (3) restart core → time to resync complete. Plus the blackout assertion: a test WS client sends core-bound packets through the whole outage — EVERY one must receive the explicit `core.unavailable` response; zero silent hangs. No pass/fail on timing — Joey decides whether 15 s detection is acceptable or the heartbeat needs tightening (a config change, not a redesign).

**B6 — Soak.** 10-minute run: edge + core, 20 simulated WS clients at 5 Hz intents each, tick stream flowing. Assert: no unhandled rejections, no dropped `tick.delta` pushes (tick numbers strictly sequential at the edge), RSS growth < 100 MB over the run.

**Done checklist:** all six benchmarks run and recorded in `docs/EDGE-SPLIT-RESULTS.md` with machine specs + commit hash; every budget breach filed as a named follow-up slice proposal (not fixed silently, not ignored); `npm test` still green.

---

## Slice E6 — Network health instrumentation

**Goal:** the engine reports its own network health continuously, and we have the external tools to verify the wire independently. E5 measured once; E6 watches always.

**Toolchain evaluation (what to run for what):**
- **Built-in `/metrics` (this slice)** — the primary source of truth: request rates, error rates, latency histograms, connection counts, channel bytes. Everything below cross-checks against it.
- **Prometheus + Grafana** — Prometheus scrapes `/metrics` every 15 s; Grafana renders the shipped dashboard. This is the daily driver for "how is our network doing." Both run as **Go binaries alongside the engine** (per Joey 2026-10-01 — wanted for their full power, no WASMification). The Node-only constraint applies to engine runtime services, not supporting observability binaries.
- **Wireshark / tcpdump** — deep inspection of a specific failure (`tcpdump -i lo port 4000` captures the internal channel; WS frames client↔edge). Forensics, not monitoring.
- **k6** — WebSocket load generation (`apps/edge/test/load/ws-soak.js`): ramps virtual users against the edge, asserts p99 thresholds. The client-facing complement to E5's channel benches.
- **Clinic.js** (`clinic doctor`) — when latency looks like a network problem but is actually event-loop lag or GC pauses under load. Run against edge and core under k6 load.
- **Valgrind Helgrind** — you have memcheck for leaks; Helgrind covers thread races where the C++ addons meet N-API. Scope it to addon test binaries — Helgrind on the full Node process is too noisy to be useful.
- **iperf3 / ping / mtr** — only when edge and core (or clients) span machines. Not needed while everything is loopback; documented here so nobody rediscovers them later.

**Files to create/modify (exact):**
```
packages/nethealth/src/registry.ts      (create: counters, gauges, histograms)
packages/nethealth/src/prometheus.ts    (create: text-format serializer)
packages/nethealth/src/index.ts         (create: re-exports)
packages/nethealth/test/registry.test.ts (create)
packages/nethealth/test/prometheus.test.ts (create)
apps/edge/src/metrics.ts                (create: edge metric definitions + /metrics handler)
apps/edge/src/index.ts                  (modify: register /metrics route, instrument router + WS server)
packages/channel/src/client.ts          (modify: record channel metrics)
packages/channel/src/server.ts          (modify: record channel metrics)
packages/engine-core/src/channel-server.ts (modify: record core metrics; answer metrics.get)
docs/grafana/dashboard.json             (create: Grafana dashboard)
docs/prometheus/prometheus.yml          (create: scrape config)
apps/edge/test/load/ws-soak.js          (create: k6 script)
apps/edge/README.md                     (modify: metrics catalog)
packages/channel/README.md              (modify: channel metrics)
```

**`registry.ts` — exact minimal API (no new deps for counters/gauges; histograms use the `hdrhistogram-js` npm package, MIT):**
```ts
export class Registry {
  counter(name: string, help: string, labels?: string[]): Counter;
  gauge(name: string, help: string, labels?: string[]): Gauge;
  histogram(name: string, help: string, labels?: string[]): Histogram; // hdrhistogram under the hood, ms buckets
  scrape(): string; // Prometheus text format via prometheus.ts
}
```
`prometheus.ts` emits `# HELP <name> <help>`, `# TYPE <name> counter|gauge|histogram`, then samples as `mmo_name{label="v"} <value>`. Histograms serialize as `_bucket` cumulative counts + `_sum` + `_count` (Prometheus native histogram format — exact, don't invent a variant).

**Exact metric catalog (register ALL of these; a test asserts the full set — see below):**

Edge (`mmo_edge_`):
- `ws_connections` (gauge) — active WebSocket connections.
- `ws_connects_total`, `ws_disconnects_total` (counters).
- `router_requests_total{packet_type}` (counter).
- `router_errors_total{packet_type,error}` (counter; `error` ∈ `unknown_packet|bad_packet|unknown_module|core_unavailable`).
- `router_latency_ms{packet_type}` (histogram) — `routePacket` duration.
- `mirror_deltas_fanned_out_total` (counter).
- `mirror_snapshot_age_ticks` (gauge) — `currentTick - latestSnapshot.tick`.

Channel (`mmo_channel_`, recorded in `packages/channel`, labeled by `side=edge|core`):
- `requests_total`, `timeouts_total`, `errors_total` (counters).
- `request_latency_ms` (histogram).
- `pushes_total{type}` (counter).
- `bytes_sent_total`, `bytes_received_total` (counters).
- `reconnects_total`, `heartbeat_missed_total` (counters).

Core (`mmo_core_`):
- `tick_duration_ms` (histogram).
- `tick_events_pushed_total` (counter).
- `intents_accepted_total` (counter).

**`/metrics` (exact):** `GET /metrics` on the edge returns `Content-Type: text/plain; version=0.0.4` with the Prometheus exposition of edge + channel-edge-side metrics, PLUS core metrics: the edge requests `{ type: "metrics.get" }` from the core every 15 s (new core packet type — add to E3's handler list: respond with the core registry's scrape text), caches the result, and includes it under the same endpoint. If the core is down, serve edge metrics only plus `mmo_edge_core_metrics_stale 1` (gauge).

**Structured logs (exact):** network lifecycle events log one JSON object per line: `{ "ts": "<ISO>", "level": "info|warn|error", "component": "edge|channel|core", "event": "<name>", ...fields }`. Events: `ws.open`, `ws.close` (with `code`), `channel.up`, `channel.down`, `channel.reconnect` (with `attempt`), `heartbeat.missed`, `frame.oversized` (with `bytes`). No log line may contain tokens, packet payloads, or PII.

**Grafana dashboard (`docs/grafana/dashboard.json`):** panels (exact): (1) WS connections (gauge + time series); (2) router p50/p95/p99 latency by packet_type; (3) router error rate by error; (4) channel bytes sent/received; (5) channel p99 request latency; (6) core tick duration p99 vs the 33.3 ms budget line; (7) snapshot age in ticks; (8) reconnect + heartbeat-missed events. Refresh 15 s. Alert annotations (documented, not auto-provisioned): router p99 > 50 ms for 5 min; `heartbeat_missed_total` increasing; snapshot age > 600 ticks.

**Prometheus scrape config (`docs/prometheus/prometheus.yml`, exact):**
```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
scrape_configs:
  - job_name: "mmo-edge"
    static_configs:
      - targets: ["localhost:3000"]
    metrics_path: "/metrics"
```
One target covers everything: the edge's `/metrics` already includes the core's metrics via the `metrics.get` proxy. If `EDGE_HTTP_PORT` is overridden, the target port must match — document this in the README next to the config. Future services follow the same convention: expose Prometheus exposition, add a scrape job. Run order for a dev session: `prometheus --config.file=docs/prometheus/prometheus.yml`, then the Grafana binary with `docs/grafana/dashboard.json` imported (document both commands in the README).

**k6 script (`apps/edge/test/load/ws-soak.js`, exact):** stages: 0→50 VUs over 1 min, hold 50 for 3 min, down over 30 s. Each VU: connect, send `ping` every 200 ms, one `player.intent` per second (core may be a stub — script asserts on edge responses only). Thresholds: `p(99) < 100ms` on ping round-trip; `http_req_failed` n/a (WS only); zero `core.unavailable` unless the core is intentionally down. Run: `k6 run apps/edge/test/load/ws-soak.js` (k6 installed separately — document the install command for Linux/Windows/macOS in the README).

**Tests:**
- `registry.test.ts`: counter increments, gauge set/inc/dec, histogram records and `scrape()` contains `_bucket`, `_sum`, `_count` lines.
- `prometheus.test.ts`: exact-format assertion on a small registry (HELP/TYPE/sample lines, label rendering).
- Metric catalog test (in `apps/edge/test/`): import the metric definitions and assert every name in the catalog above is registered — fails loudly if someone adds code without a metric or vice versa.
- Log format test: emit each lifecycle event to a fake stream, JSON.parse every line, assert required fields present and no `token`/`payload` keys.

**Done checklist:** `npm test` green; `GET /metrics` scraped successfully by a local Prometheus using the shipped `prometheus.yml` (target shows UP); `docs/grafana/dashboard.json` imports into Grafana without errors; k6 script runs against the edge; README catalogs every metric with its meaning; no tokens/payloads in logs (test).

---

## Build order + quest-plan interplay

- E1 → E2 → E3 → E4 → E5 → E6, strictly in order.
- Quest slices Q1–Q6 are independent of the E-slices and can build in parallel.
- Q7 (editor routes) requires E1 complete — its routes register on the edge via `content/edge/routes.json` rows (`quest.preview` → `local:quest`, etc.) and the `quest`/`lore` local modules.
- Q8's override/approval routes likewise register on the edge.
- Q9's mythic evaluator runs in the edge, reading `getTickBuffer()` (E2/E3); its `grant_item`/`spawn_boss` outcomes travel to the core as channel packets (E3 handler); announcements broadcast from the edge's WebSocket connections.
- The old quest-plan phrase "the existing Express server" now means `apps/edge` everywhere (quest plan already updated).

## Final acceptance (after E4)

- Kill the core process mid-session: connected clients stay connected, sim packets get `core.unavailable` with the exact message, local routes keep answering.
- Restart the core: resync completes, sessions reattach, no client re-login needed.
- Kill the edge: the core keeps ticking (verify tick counter advances); a fresh edge boots, syncs, and clients reconnect.
- `npm test` from the repo root is fully green.
- No player-facing listener remains in `packages/engine-core` (grep check).
- Both READMEs (edge, engine-core) describe the split the same way this plan does.
- E5's numbers are recorded in `docs/EDGE-SPLIT-RESULTS.md`, and any breached budget has a named follow-up.

## Appendix — ByteByteGo Shorts alignment scan (added 2026-10-01)

Screened the channel's 27 latest Shorts (titles-only scan). Full findings:
`~/workspace/your_files/mmo-engine-system-design/BYTEBYTEGO-SHORTS-FINDINGS.md`.
What landed in this plan as clarification/alignment:

- **Latency vs throughput is the framing for E5.** The tick path and the
  internal hop are latency budgets (p99); delta fan-out and the JSON
  control plane are throughput problems. Keeping the two budgets separate
  is the point of the E5 acceptance numbers. ("Latency vs Throughput")
- **gRPC considered, not taken (E2).** Framed TCP + FlatBuffers stays for
  the internal channel; gRPC is the recorded fallback if the channel ever
  needs typed-RPC ergonomics more than wire control. Same precedent as
  the webrpc decision. ("gRPC, WebSocket and WebHook!", "Why gRPC is
  Popular")
- **Kafka patterns, not Kafka.** Append-only log + per-consumer offsets
  is the right shape for sim event distribution, rumors, and world-tier
  heartbeats — as a pattern inside our own systems. A Kafka deployment is
  ops weight we don't carry; adoption waits behind a seam. ("Kafka
  Basics", "Why is Kafka so Fast?" P1/P2)
- **Redis is the future-scale door, not today's dependency (E3).**
  Sessions/presence/leaderboards would land behind the existing
  session-store seam; SQLite sessions stay until a bench says otherwise.
  ("Why is Redis so FAST", "Top Redis Use Cases")
- **Fan-out math reference (E5).** "1 TRILLION messages" as the
  extreme-end reference for edge `tick.delta` fan-out cost.
- **Philosophy check (whole plan).** Stack Overflow's boring,
  mostly-monolithic architecture is the reminder that this split is
  fault isolation, not a microservices program.
  ("Stack Overflow's Shocking Architecture")
