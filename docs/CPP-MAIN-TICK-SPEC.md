# C++ Main Tick — Specification and Implementation Roadmap

**Status:** Spec + roadmap, commissioned by Joey 2026-10-27. Implementation
phases are gated on his word per phase. Nothing in this document is built yet
beyond the components marked SHIPPED.
**Scope:** Move the authoritative main tick from TypeScript (engine-core) to
C++; reduce Node to the networking/session layer on uWebSockets.js; keep the
persistence tier (world-server + SurrealDB atomic ops) unchanged.
**Target scale (unchanged):** 1,000 concurrent users + 50,000 entities/NPCs
in ONE region, shared resources, no sharding escape hatch. Tick 30 Hz
(33.33 ms budget).

---

## 1. Where things actually stand (verified against origin/main, 2026-10-27)

The popular picture — "the engine is Node with a `ws` server and a TS sim" —
is two years of decisions out of date. Verified current state:

| Layer | State |
|---|---|
| Client transport | **SHIPPED: uWebSockets.js is already the default.** `packages/engine-core/src/net/transport.ts` defines a `Transport` interface; uWS (C++ event loop, HTTP parser, framing) is the default whenever its prebuilt binary loads; `ws` on node:http is the fallback and test reference. Selected by `MMO_TRANSPORT=uws\|ws\|auto`. Decision recorded 2026-09-30 (`docs/DECISIONS.md`). |
| Transport bench | **SHIPPED:** `npm run bench:transport` (30 Hz, 1.2 KB deltas out, 48 B intents in, transport alone; measures server CPU, fan-out loop p50/p99, RSS). Results recorded in DECISIONS.md (see §3). |
| Production tick | **TypeScript.** `tick-loop.ts` (fixed-step accumulator, spiral-of-death guard: max 5 catch-up steps, backlog dropped and counted) drives the engine-core `World` + systems in the gateway process. Physics is already native (Jolt addon, system named `"jolt"` in `systems.ts`) behind a bulk SoA boundary. |
| SAB data plane | **SHIPPED but NOT wired into production boot** (PR #430). 3-thread topology: master thread (uWS on `/ws/sim`) → lockless SPSC ring of packed intent tokens → sim worker (30 Hz; applies tokens to the SAB SoA plane, steps the C++ kernel) → second SPSC ring → persist worker (embedded SurrealDB). Kernels live in `packages/addons/integrate` (`stepSimulation`, `applyIntentsAndStep`, branchless SIMD `stepSimulationSoA`). `/ws/sim` has NO auth/validation/rate-limiting and must not become an ingress as-is. |
| C++ addons on main | geometry, integrate, navigation (Recast/Detour), perf-probe, physics (Jolt), picg, procgen, scatter, terrain-kernel, template. The native build chain (node-gyp, N-API) is proven on Windows (Node 25 + VS Build Tools 2026 target). |
| Port workflow | **Decided 2026-10-14, pilot never run:** transpiler-first (typescript2cxx, wowemulation-dev, Apache-2.0/MIT), hand-finish SAB/bitECS/Node boundaries. Pilot candidate verified 2026-10-21: `packages/protocol/src/fast-path.ts` (230 lines, zero async/await, tick-hot codec). typescript2cxx has since gained full TypedArray support; async/await is still unsupported, so port candidates must be fully synchronous. |
| Persistence | Independent track (atomic ops, ledger, dedup fold). **Out of scope for this migration** and unaffected by it — see §6. |

**The gap this spec closes:** the production boot still runs the TS tick
inside the gateway process. The C++ kernel path exists only in the standalone
data-plane server. The migration wires the prototyped topology into
production and then moves the tick's systems behind the SAB contract one by
one, densest first.

---

## 2. Target architecture

```
            clients (three.js / R3F mirror)
                      │  WebSocket (binary deltas / intents)
                      ▼
┌─ Node process (networking & session layer) ─────────────────────┐
│  uWebSockets.js transport (default; ws = test reference only)   │
│  Gateway: auth, rate limiting, Zod validation, session/reattach  │
│  Interest management (sectors) + per-client delta ENCODE         │
│  webrpc/HTTP control plane, admin, downloads — unchanged         │
└──────┬───────────────────────────────────────────────▲──────────┘
       │ validated intents (SPSC ring, packed tokens)  │ per-tick
       │                                               │ delta source data (SAB views)
       ▼                                               │
┌─ Sim worker (C++ tick host) ────────────────────────────────────┐
│  Fixed 30 Hz loop (TickLoop semantics preserved exactly)        │
│  SAB SoA component plane = the single shared state              │
│  Systems: native kernels/addons where ported, TS where not      │
│  Jolt step = direct native call (no per-tick N-API crossing)    │
│  Deterministic FP build; goldens vs TS reference per system     │
└──────┬──────────────────────────────────────────────────────────┘
       │ checkpoint / atomic-op transactions (SPSC ring)
       ▼
┌─ Persist worker (unchanged) ────────────────────────────────────┐
│  SurrealDB WorldStore, atomic ops, ledger — as today            │
└─────────────────────────────────────────────────────────────────┘
```

Rules of the target shape:

1. **Node owns connections, never simulation.** The gateway validates every
   byte (the security perimeter: memory-unsafe code never parses untrusted
   input), owns sessions and reattach, encodes per-client deltas from SAB
   views, and sends. It holds no authoritative state.
2. **The SAB plane is the contract.** Not function calls, not message
   copies: shared SoA component storage + two lockless rings (intents in,
   persistence transactions out), exactly as the data plane already defines.
   Either side can be reimplemented without the other changing.
3. **The tick is deterministic.** Fixed-step semantics of `tick-loop.ts`
   carry over unchanged (same accumulator, same spiral guard, same drop
   accounting). Native systems build under a fixed FP model; every ported
   system ships golden tests against its TS reference.
4. **Crash containment.** The sim worker can die and restart — rebuilding
   state from the persist tier — while the gateway process keeps every
   socket open. Players see a pause, not a disconnect.
5. **WorldCore stays transport-agnostic** (existing decision). The gateway
   is an adapter; nothing about this migration leaks transport or threading
   into game logic interfaces.

---

## 3. Performance model — what changes, by how much, on what evidence

Every number below is tagged: **[measured]** = produced by a bench on this
project; **[modeled]** = an estimate with stated assumptions, to be replaced
by measurement at the phase gates.

### 3.1 The tick

**Today [measured].** The 51k contention harness (JS, 2-vCPU sandbox, sim
passes only — no physics, no network in the loop): 51,256 entities, mean
6.06 ms, **p99 23.9 ms, max 55.6 ms** against a 33.33 ms budget. Read that
carefully: the *mean* tick uses 18% of budget, but the p99 uses 72% and the
max overruns outright — and an overrun is not free, because the TickLoop's
spiral guard drops backlog sim time (counted as spiral events). The problem
is not the average; it is the tail, and the tail in V8 is structural: GC
pauses and JIT deopt tiers are outside the program's control.

**The dense-math slice [measured].** The PR #430 integrate kernel steps
50,000 entities' planar integration in a claimed 0.037 ms; reproduced in
this sandbox at roughly half the claimed speed. The equivalent JS pass is
one to two orders of magnitude slower. This is one pass, not a tick — it
bounds what dense SoA math gains, nothing more.

**After the port [modeled].** Assumptions: dense SoA passes (integration,
intent application, sector/spatial queries) improve 10–50×; branchy systems
(combat resolution, resident logic) improve 2–4× (native code, no GC, but
the logic is the logic); Jolt's step cost is unchanged (already native) but
loses its per-tick N-API marshaling. Blended expectation for the full tick
at 51k entities under contention: **mean ~1–2.5 ms, and p99 close to the
mean** — because the two tail sources (GC, JIT) are gone, not merely
reduced. The headline deliverable is **variance collapse**: p99 from ~72%
of budget to roughly ~10%, which is what actually protects 30 Hz when
1,000 players contend over the same resources. These modeled figures are
Phase-gate homework: Phase 0 re-baselines the JS tick, Phase 3 replaces
each system's modeled number with its measured one, system by system.

**Latency consequence [modeled].** Fewer overruns → fewer dropped
catch-up steps → input-to-delta latency stops spiking under load. The mean
player won't feel the mean improvement; everyone feels the p99 fix.

### 3.2 The fan-out (why uWS, in the project's own numbers)

**[measured]** — `docs/DECISIONS.md`, 2026-09-30, `bench:transport`
(30 Hz, 1.2 KB deltas out, 48 B intents in, transport alone):

- uWS uses **25–35% less server CPU than ws at 100–2,000 clients**, with a
  faster median fan-out.
- At 2,000 clients, **ws saturated a full core and fell behind (57k of the
  required 60k messages/s delivered) while uWS held the full rate at 69%
  of one core.**
- Honest caveat recorded at the time: uWS's p99 send-loop time reads
  slightly higher at 1,000+ clients (it writes to the kernel inside the
  loop where ws defers); CPU is the fair metric, and CPU is what a region
  runs out of.

At the 1,000-client target the fan-out is 30,000 delta messages/s before
intents. On ws that is already near a single core's ceiling — spent in the
same process and event loop as today's TS tick, so fan-out spikes and tick
spikes contend for the same 33 ms. In the target shape they can no longer
starve each other: the gateway loop does encode+send only; the sim loop
never touches a socket. External vendor/community figures for uWS-vs-ws
multiples (10–50×) come from old versions and echo workloads and are **not**
used anywhere in this model; the project's own bench is the evidence.

**Memory [measured directionally].** uWS's per-connection footprint is a
fraction of ws's (the transport bench records RSS; the DECISIONS entry kept
the CPU figures). At 1,000 connections this is comfortable either way; it
matters at the 2,000-client stress end, not at target.

### 3.3 What does NOT change

- **Persistence throughput.** SurrealDB IO (ledger append, store puts,
  atomic ops — the current optimization track, incl. the unverified dedup
  fold) is untouched and remains its own bottleneck program. A faster tick
  produces checkpoints faster; it does not make the DB write faster.
- **Bandwidth.** Same deltas, same bytes. The fast-path/SAB-view encoding
  work is orthogonal and already on main.
- **Client rendering, bake times, editor.** Out of scope entirely.
- **Delta encode cost** stays in Node (per-client, embarrassingly
  parallel across connections, not tick-shaped). If Phase 0 profiling ever
  shows encode — not transport — dominating the gateway loop, the remedy
  is the Phase 1 pilot's codec, not a new transport.

### 3.4 The risk that can silently eat the win

uWebSockets.js is an **optional dependency pinned to a git tag**
(`git+https://github.com/uNetworking/uWebSockets.js.git#v20.71.0`) because
the project isn't on npm. If that install fails or the prebuilt binary
doesn't load on a deployment machine, `auto` **silently falls back to ws**
and the region runs at the saturated-core profile with no alarm. Phase 0
closes this: boot-time assertion + a visible "transport in use" metric,
and a packaging decision (vendor the binary / self-host the artifact) so a
production install cannot degrade quietly.

---

## 4. Implementation roadmap (phased, gated)

Standing rules apply throughout: local branches, tests green before
anything leaves, every performance phase ships a metrics doc + chart with
measured numbers, methodology, and caveats (Joey's 2026-10-20 rule), and
push/PR/merge happen only on Joey's word. Each phase lists its **gate** —
the evidence required before the next phase starts.

### Phase 0 — Baselines and the transport guarantee (no sim changes)

1. Re-run `bench:transport` at 250 / 500 / 1,000 / 2,000 clients in the
   production shape; publish the metrics doc + chart (CPU, fan-out
   p50/p99, RSS, both transports).
2. Re-baseline the JS production tick under the contention harness at
   51k entities (mean/p99/max, spiral-event count), same doc.
3. Boot assertion: the server logs and exposes which transport loaded;
   production mode fails loud if uWS was requested but ws loaded.
4. Decide the uWS packaging fix (vendored binary vs self-hosted artifact)
   so installs can't silently degrade.

**Gate:** baseline numbers on file; transport guaranteed in deployment.
*Known environment limit: the transport test suite hangs on uWS inside
Arlo's sandbox, so Phase 0 network numbers must be produced or reproduced
on real hardware (Joey's Windows machine) — sandbox numbers are labeled
as such wherever used.*

### Phase 1 — Transpiler pilot (the 2026-10-21 candidate, finally run)

1. Run typescript2cxx on `packages/protocol/src/fast-path.ts` (230 lines,
   sync-only, tick-hot). Hand-finish the SAB boundary per the 2026-10-14
   workflow decision.
2. Golden tests: byte-identical outputs vs the TS reference across the
   existing codec test corpus (the repo's established parity pattern).
3. Bench encode/decode vs the TS fast path; publish the numbers.

**Gate:** byte-identical parity + a real measured speedup + an honest
account of hand-finish hours. If the hand-finish cost is ugly, STOP and
reassess the whole port strategy before Phase 2 — this pilot exists to
price the workflow cheaply.

### Phase 2 — Production wiring of the data-plane topology

1. Move the production boot onto the PR #430 topology behind a flag:
   gateway (uWS, auth/validation/sessions — the production gateway, NOT
   the unauthenticated `/ws/sim` demo ingress) → SPSC intent ring → sim
   worker → persist ring → persist worker (unchanged).
2. The sim worker initially steps the existing TS World/systems, reading
   intents from the ring and publishing delta source data into the SAB
   plane; the gateway encodes/sends as today. The old in-process boot
   remains available behind the flag as the rollback path.
3. Full test suite green on the new boot; persistence soak re-run
   (crash cycles, recovery) against the new topology.

**Gate:** production-equivalent boot on the new topology, suite green,
soak clean, rollback flag proven. No system has been ported yet — this
phase buys the *shape* (crash containment, separated budgets) and the
measured before/after of the wiring itself.

### Phase 3 — System-by-system migration, densest first

Order follows measured tick share from Phase 0/2 profiling; expected
order: integration/movement (kernel exists) → intent application →
creature passes → sector/spatial queries → combat resolution →
residents (branchiest, last; residents may stay TS longest or move to
their existing coarse think cadence instead).

Per system, no exceptions:

1. Port (transpiler-first where the module is sync; hand-port where it
   isn't), behind the same SimSystem-style narrow interface.
2. Golden/parity tests vs the TS system on shared scenario corpora.
3. Per-system bench + metrics doc + chart in the push.
4. If parity fails or the measured gain is under ~2× for a branchy
   system, the system stays TS and the doc says so. The SAB contract
   makes a mixed tick a legitimate end state, not a failure.

**Gate (per system):** parity green + measured improvement, or it doesn't
merge.

### Phase 4 — Native tick loop and hardening

1. The fixed-step loop itself runs natively in the sim worker (same
   accumulator and spiral-guard semantics; drop accounting preserved and
   exported as telemetry).
2. Determinism audit: fixed FP model across the native build, TS `Math.*`
   replacements inventoried, replay-golden suite over long scenario runs.
3. Crash drill: kill the sim worker mid-soak; sessions survive on the
   gateway; state rebuilds from the persist tier; drill report published.
4. The owed B3 load test, done properly: 1,000 real-client fan-out at
   51k entities **with network-profile injection** (latency/jitter/loss
   profiles per the late-input-sealing evaluation — localhost numbers
   lie), plus the owed `PlayerIntent` edge-trigger re-fire test.

**Gate:** p99 tick ≤ 25% of the 33.33 ms budget at target load, zero
dropped steps across the soak window, crash drill passed, determinism
suite green.

---

## 5. Risks and honest costs

- **Two languages, permanently.** Debugging crosses the boundary; the
  golden-test discipline is the price of sleeping at night. The Phase 1
  pilot exists to price the workflow before the program commits to it.
- **typescript2cxx emits JS-emulation C++** (js:: types) that hand-finish
  replaces with native/SAB types, and it cannot transpile async code.
  Module selection (sync, dense, self-contained) is therefore the main
  lever on port cost — chatty or async-heavy systems are poor candidates
  and may legitimately stay TS forever.
- **A native crash is total for the worker.** Mitigated by topology
  (Phase 2/4: sockets survive, state rebuilds), not by hope.
- **uWS supply chain.** Git-pinned optional dependency (see §3.4). Also:
  uWS's event loop is its own (not libuv's) — the adapter's buffer-copy
  semantics (uWS reuses buffers after callbacks) are already handled in
  `transport.ts` and must survive any refactor.
- **Sandbox verification limits.** uWS hangs in Arlo's sandbox test
  environment; the sandbox is 2 vCPUs shared with whatever else is
  running. Every performance claim in this program carries its
  measurement environment with it, and gate numbers for the network
  phases come from real hardware.

---

## 6. Explicitly out of scope

- SurrealDB throughput work (slices 1–2, dedup fold, Postgres A/B
  question) — continues on its own track; this migration consumes its
  outputs unchanged through the persist worker.
- WebTransport — remains gated on B3-style evidence (Phase 4 produces
  exactly that evidence; if ordered-WS head-of-line blocking shows up
  there, it becomes its own proposal).
- The client, the editor, bake-time code (which can stay JS/TS by the
  standing rule — only tick-hot code needs C++).
- Any change to wire protocol, delta format, or the atomic-op contract.

---

## 7. Decision record

- 2026-09-30 — uWebSockets.js serves the game port; ws is the fallback
  (DECISIONS.md). Transport question: settled.
- 2026-10-14 — C++ direction recorded as under consideration; transpiler-
  first workflow chosen (typescript2cxx preferred). SAB phases named as
  prerequisites.
- 2026-10-21 — Pilot candidate chosen (fast-path.ts); pilot not run.
  Substrate prerequisite met the same day (SAB arc complete on main).
- 2026-10-25 — SAB data-plane topology prototyped (PR #430), not wired
  into production boot.
- **2026-10-27 — Joey commissions this spec and roadmap: the main tick
  moves to C++, Node becomes the networking layer on uWS. Implementation
  proceeds phase by phase on his word, gated as above.**
