# wRPC for Game Actions — Keep or Kill Verdict

**Scope:** wRPC (webrpc) as the transport for client↔region *game
actions* — the question left open since 2026-10-14. Evaluation only:
nothing in the live gateway was changed, and nothing from the spike
is merged (local branch `arlo/wrpc-eval`, spike in
`spikes/wrpc-race/`). All figures below were measured in this
sandbox; none are projected or estimated.

## Decision criteria

The original ruling (`docs/DECISIONS.md`, 2026-09-27) names no
numeric thresholds. Its stated reason is qualitative — *"webrpc was
not adopted (Go-server-first codegen does not fit the Node server)"*
— alongside two standing design commitments from the same entry and
the project brief: the data plane stays zero-copy binary
(FlatBuffers / fast-path), the control plane stays JSON + Zod, and
*validate everything, fail closed*. The race therefore judges wRPC
on the axes those commitments imply, plus the expired objection
re-tested as-is:

1. **Toolchain fit (the original objection).** Can the official
   webrpc toolchain generate a usable TypeScript client *and*
   server for a Node stack today, in this build environment?
2. **Per-action latency** — full request pipeline round trip
   (serialize → parse → validate → dispatch → respond → parse),
   p50 / mean / p99.
3. **Per-action CPU cost** — µs per operation on the same pipeline
   (the gateway shares one Node process with the 30 Hz tick).
4. **Bytes on the wire** per action, request + response.
5. **Validation strength preserved** — does the generated stack
   reject what the current Zod-strict control plane rejects
   (enums, ranges, integer-ness, patterns, unknown fields)?
   Fail-closed is a hard project rule, not a preference.
6. **Hot-path viability** — the same pricing applied to a position +
   velocity update, the traffic the binary data plane exists for.

## Method

- **Action set** (identical payloads on every lane), taken from the
  gateway's real control-plane schemas (`net/gateway.ts`): ability
  **trigger**, spell **cast**, **vendor buy**, **trade offer**
  (item + gold), **auction bid** — spanning small and medium
  payloads — plus a **position update** (pos + linear velocity) as
  the hot-path probe.
- **Lane (a) — current gateway:** JSON text → `JSON.parse` →
  dispatch on `kind` → Zod `.strict()` `safeParse` with the
  production schemas (copied verbatim from `gateway.ts` — they are
  module-private there) → shared handler core → JSON result →
  parse. The position action's JSON schema is a same-style strict
  schema written for this race and labelled hypothetical: movement
  has no JSON path in production today.
- **Lane (b) — incumbent binary (position only):** FlatBuffers
  Delta and fast-path v1 from `@mmo-engine/protocol`, N=1 and
  amortized at N=1000. These codecs cannot encode the control
  actions; no numbers are claimed for them there.
- **Lane (c) — wRPC:** the *real* generated stack. `game.ridl` →
  webrpc-gen **v0.48.0** (official release binary, downloaded and
  run in this sandbox) `-target=typescript -client/-server`. The
  generated client talks to the generated server handler
  (`serveGameActionsRpc`) through an in-process fetch loopback:
  generated code serializes and parses every byte on both sides;
  only the socket is looped out — identically for lane (a). The
  service implementation calls the *same* handler core as lane (a)
  after its own generated validation. In production wRPC would ride
  real HTTP fetches, so this loopback is generous to wRPC.
- Warmup 500, then **5,000 per-call samples** per action/lane for the
  JSON lanes (run 3 times; medians were stable across runs, means
  and p99 vary with shared-sandbox noise — the table is the final
  run, `results.json` in the spike). Binary lanes: batch timing,
  20,000 iterations, encode and decode in separate loops in the
  repo bench style (`packages/protocol/test/bench/`); the combined
  figure is the sum of the two means.
- Environment: Node v24.22.1, Zod 4.6.7, Linux x64, 2 vCPU
  (AMD EPYC 9D25). **Sandbox-indicative, not production truth.**

## Measured results — control actions

Full-pipeline round trip, µs per call (5,000 samples):

| Action | Gateway p50 | Gateway mean | Gateway p99 | wRPC p50 | wRPC mean | wRPC p99 | p50 ratio |
|---|---|---|---|---|---|---|---|
| trigger (ability) | 2.47 | 13.79 | 19.70 | 35.86 | 281.18 | 7198.26 | 14.5× |
| cast (spell + target) | 3.04 | 6.64 | 18.59 | 28.79 | 76.55 | 1171.92 | 9.5× |
| vendor buy | 3.10 | 7.21 | 12.43 | 26.80 | 55.12 | 282.86 | 8.6× |
| trade offer (item + gold) | 3.33 | 6.57 | 14.79 | 27.49 | 71.51 | 424.16 | 8.3× |
| auction bid | 2.97 | 4.66 | 5.96 | 26.62 | 42.99 | 102.83 | 9.0× |
| position update | 3.71 | 5.69 | 12.00 | 27.50 | 53.33 | 195.06 | 7.4× |

At the median, a wRPC call costs **~7–15×** the current gateway
call for identical work (≈72–215k ops/s vs ≈3.5–23k ops/s on mean
figures). The p99 tail is also far fatter on the wRPC lane (up to
7.2 ms in spike samples vs ≤ 32 µs for the gateway across runs);
sandbox noise inflates both tails, but it inflates the heavier
machinery more, in every run.

Bytes on the wire (request + response): a wash. wRPC requests run
7–10 B smaller (no `kind` field; a `{"req":…}` wrapper instead),
its responses 8 B larger (`{"res":…}` wrapper): e.g. trade offer
80 + 19 B (gateway) vs 73 + 27 B (wRPC); position 85 + 19 B vs
75 + 27 B. **No bandwidth case for switching.**

## Measured results — position update, all lanes (N=1)

| Lane | Encode µs | Decode µs | Combined µs | Bytes |
|---|---|---|---|---|
| fast-path v1 | 2.51 | 2.57 | 5.08 | 44 |
| gateway JSON + Zod (hypothetical) | — | — | p50 3.71 (full pipeline) | 85 + 19 |
| wRPC | — | — | p50 27.50 (full pipeline) | 75 + 27 |
| FlatBuffers Delta | 46.80 | 19.62 | 66.41 | 568 |

The FlatBuffers N=1 figure is its fixed full-Delta construction
cost; production batches. Amortized at N=1000 in one frame:
fast-path **0.19 µs/entity** (32,012 B) vs FlatBuffers
**4.38 µs/entity** (96,488 B). Both frame sizes match
`docs/PERFORMANCE-SAB.md` exactly (96,488 / 32,012 B), which
validates the harness against the repo's published bench; my
per-entity times read ~2–4× slower than that doc's on this shared
box today, with the same ordering and comparable ratios. On the hot
path, wRPC is ~5× the fast-path codec's *entire* encode+decode at
N=1 and ~145× its amortized per-entity cost at N=1000 — it is not
a contender there, and was never going to be; the number just makes
it official.

## Validation probe — measured, not argued

Six malformed payloads, one per weakness class, sent to both lanes
(gateway: production `safeParse`; wRPC: the generated server
handler's own response):

| Malformed payload | Gateway JSON + Zod | wRPC generated |
|---|---|---|
| vendor `action` outside the enum (`"hack"`) | rejected | **ACCEPTED** |
| trade `gold` below minimum (−5) | rejected | **ACCEPTED** |
| cast with unknown extra field (strict violation) | rejected | **ACCEPTED** |
| trigger `id` of wrong type (42) | rejected | rejected |
| auction `amount` not an integer (1.5) | rejected | **ACCEPTED** |
| cast `target` failing the id pattern (`"abc"`) | rejected | **ACCEPTED** |

5 of 6 malformed classes pass the generated validators. They check
field presence and JS `typeof` only. RIDL has no way to express
enums, ranges, integer constraints, string patterns, or strict
unknown-field rejection, so parity with the current control plane
would mean hand-writing a Zod-equivalent validation layer per
method *on top of* wRPC — reintroducing the very layer it was meant
to replace, while keeping its per-call cost.

## Toolchain fit — the 2026 objection, re-tested

The original objection has **expired**, and this report says so
plainly: webrpc-gen v0.48.0 generates a first-class TypeScript
client *and* server (fetch-style handler, no runtime dependencies),
and the generated code typechecks clean under the repo's TypeScript
(`tsc --strict --noEmit`, exit 0). Frictions found, for the record:
the built-in target silently emits types-only unless `-client` /
`-server` are passed (documented only in the template repo's
example Makefile, not the CLI help), and the RIDL parser rejects
`//` comments between declarations — the comment style this repo's
own `world.ridl` header uses; the spike schema uses `#`. Neither
friction is fatal. The kill below does not rest on the old reason;
it rests on today's latency, cost, and validation measurements.

## Caveats

- In-process loopback for both JSON lanes: socket/kernel cost is
  excluded symmetrically, and production wRPC (real HTTP per call,
  connection semantics on top of a persistent game socket the
  gateway gets for free) would look worse, not better.
- The shared 2-vCPU sandbox injects spikes: gateway means ranged
  4.7–35 µs across the three runs while its p50 held at 2.5–4.5 µs.
  Medians are the reliable comparator here; every run produced the
  same ordering and roughly the same median ratios.
- The handler core is deliberately small (a state touch and a
  sequenced result) and identical across lanes; real handlers add
  equal cost to both lanes and do not change the transport delta.
- One async asymmetry is intrinsic, not a harness artifact: the
  generated wRPC stack is promise/Request/Response machinery end to
  end, while the gateway path is a synchronous parse-validate-
  dispatch on an already-open socket. That machinery *is* the
  product being evaluated.

## Verdict

**KILL wRPC for game actions. Close the thread.**

Basis, from the measurements above: for identical game actions,
wRPC costs ~7–15× the current gateway at the median with a fatter
tail, saves no bytes, cannot approach the binary data plane on the
hot path, and — decisively — its generated validation accepts 5 of
6 malformed-payload classes the current control plane rejects, in a
project whose rule is *validate everything, fail closed*. The one
argument that killed it in 2026 (codegen fit) no longer holds, and
it still loses on the numbers measured today. Nothing about this
verdict touches the region↔world plane, where hand-authored webrpc
(with Zod at the edge) is already the shipped design — that is
server-to-server control traffic, a different class from per-action
gameplay messages, and it stays as is.

---

## Audit addendum (2026-10-25, after Joey's challenge)

Joey asked whether wRPC was implemented correctly, since it is
supposed to be much more performant than ordinary gateways. The spike
was re-audited line by line and re-measured with attribution lanes
(same sandbox, Node 24, 5,000 samples/action; medians are the stable
signal — means on this shared sandbox are noise-sensitive):

**One harness artifact found, conceded, and corrected.** The spike's
loopback cloned every wRPC response (`res.clone()` + a fire-and-forget
`.text()`) to count bytes, inside the timed path. Removing it drops
wRPC's median from ~27–41 µs to **~20–21 µs** per action (gateway:
2.6–3.5 µs). The headline gap narrows from ~7–15× to **~6–8× at the
median**. The verdict below does not change; the figures above should
be read with this correction.

**Where the remaining cost lives — measured attribution:**
- HTTP plumbing alone (construct a `Request`, construct a `Response`,
  read both bodies — no service, no validation): **~15 µs median**.
  This is not a harness invention: the generated webrpc TypeScript
  client and server do exactly this on every call, by design. In
  production the same stack would additionally pay a real network hop
  to a separate HTTP endpoint; the gateway rides the already-open
  game WebSocket. The loopback was still generous to wRPC.
- Codec floor: with ALL plumbing removed and even validation skipped,
  wRPC's floor (stringify + parse + handler + stringify + parse) is
  1.9–2.5 µs — the same as the gateway's FULL pipeline including
  strict Zod validation (2.6–3.5 µs). There is no faster encoding
  inside webrpc to unlock: its generated `JsonEncode` is literally
  `JSON.stringify` and `JsonDecode` is `JSON.parse` (read directly in
  the generated code). Its wire format is plain JSON, same as the
  gateway's.
- Under load (100 concurrent in-flight, 20k calls): gateway
  ~195–250k ops/s vs wRPC ~26–31k ops/s as raced (~8×). The gap is
  not a single-call measurement quirk.

**Implementation correctness:** the raced code was genuine
webrpc-gen v0.48.0 output (official binary), client and server both
generated, every byte serialized/parsed by that code, handlers shared
verbatim with the gateway lane. The validation-probe finding (wRPC
accepts 5/6 malformed classes) is unaffected by this audit.

**Verdict after audit: KILL stands**, on corrected numbers: ~6–8×
median cost, ~8× throughput cost, no byte savings, no codec advantage
available at any implementation quality, and a validation model that
cannot express the project's fail-closed rules.
