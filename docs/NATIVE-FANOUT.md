# Native fan-out

`packages/addons/fanout` (C++, N-API) and `packages/engine-core/src/net/native-fanout.ts` do two jobs per tick that the Gateway used to do per session in JavaScript:

1. `assemble`: build every session's 0x25 DeltaSet envelope into one arena (byte-identical to `encodeEnvelope(DeltaSet, encodeDeltaSet(...))`).
2. `selectNames`: pick the wire ids each session has not been told the name of yet (the "named once per session" rule of `deliverNamesFor`).

Interest management (`interestEntries`), the delta encoding (`SectorFrame`), name text (`namesFor`), and the socket sends stay where they were. Sending is still `socket.send` in uWS.

## Which path runs, and how to tell

| Condition | Path | Where it shows |
|---|---|---|
| Default, addon built, uWS transport, interest on, no edge | native | `[server] listening ... fan-out native (addon-fanout 0.1.0)`; `gateway.fanoutStatus`; `gateway.fanoutTicks.native` |
| `MMO_NATIVE_FANOUT=0` | JavaScript | `fan-out js (MMO_NATIVE_FANOUT=0)` |
| Addon missing or built for another ABI | JavaScript | `fan-out js (addon unavailable: <first line of the error>)`. Never a startup failure. |
| `ws` fallback transport, the edge channel, or interest off | JavaScript, per tick | `fanoutTicks.js` counts these ticks. `ws` keeps a buffer until it is flushed, so it cannot take arena views. |
| A native call throws at runtime | JavaScript from that tick on | `fanoutStatus.reason` is `native call failed: <message>`. The failing tick is finished in JavaScript from the entries already computed (interest sets had advanced, so they are not recomputed). Names that tick fall back to the JavaScript rule, so a session may be re-sent a name once; that is harmless. |

Both paths are tested separately (`test/net/gateway-native-fanout.test.ts`).

## Ownership and lifetime

- **No SharedArrayBuffer.** The addon holds no reference to the SAB data plane or any simulation memory. It never sees entity or component storage.
- **Synchronous.** Both calls run on the main thread, inside the tick, and return before the tick continues. No worker threads, no async work, no callbacks.
- **Input pointers are call-scoped.** `assemble` reads the data pointers of the tick's payload `Uint8Array`s (the per-sector delta and full bytes from `SectorFrame`) and the descriptor arrays during the call only. Nothing is kept after it returns, so V8 may move or free them afterwards.
- **What the addon keeps** (per `Fanout` object, one per Gateway, so dungeon instances and tests in one process do not share it): the sector-name table (copied utf8), and per session slot a set of the u64 wire ids already named (copies). Both are freed when the `Fanout` object is garbage collected (C++ destructor).
- **Output buffers are JavaScript-owned.** The arena (`Uint8Array`), the offsets and the descriptors are allocated and grown by `native-fanout.ts`. If the arena is too small the addon writes nothing past it and returns the size needed; JavaScript grows it and calls again.
- **Arena reuse.** A session's envelope is a `subarray` of the arena, valid until the next tick's `begin()`. The Gateway hands it to `socket.send` immediately; uWS copies on send. If the socket is no longer open the envelope is `slice()`d before it goes into the session's send queue, so a queued message never aliases the arena.
- **Session lifetime.** A session gets a native slot the first tick it is named for. `sweep()` runs every 64 ticks, releases the sets of sessions no longer in the Gateway (disconnect after the grace period, kick, instance close) and recycles their slots. A session that reconnects within the grace period keeps its slot and its named set, as `namedSent` does on the JavaScript path.
- **World teardown / Gateway close.** Nothing to unwind: no threads, no handles. The `Fanout` object dies with the Gateway.
- **Addon failure.** See the table: JavaScript from then on, and the reason is recorded.

## Checks

- `npm run test --workspace=@mmo-engine/addon-fanout`: byte identity, once-per-session names, release, id 0, growth, two objects stay separate.
- `engine-core/test/net/native-fanout.test.ts`: a real `SectorFrame` over several ticks.
- `engine-core/test/net/gateway-native-fanout.test.ts`: a real Gateway on uWS with the native path shadowed in place; every envelope and name list is compared with the JavaScript rule on the same entries.
- `npm run valgrind:memcheck -- fanout`: clean.

## Shared assembly (`MMO_FANOUT_SHARE`)

Sessions whose envelope would be byte-identical share one assembled envelope. The group key is the replace flag plus the ordered list of (entry kind, sector, payload object) for the tick; the tick number is common. Equal bytes in different payload objects make separate groups (a missed share, never a wrong one). Every session still gets its own `socket.send` of the shared bytes.

| `MMO_FANOUT_SHARE` | Behaviour |
|---|---|
| unset / `assembly` | one assembled envelope per group (default) |
| `off` | one per session (the rollback) |
| `publish` | experimental: non-replace sessions subscribe to a topic named by the group key and each group is sent with one uWS `publish` |

Measured in `perf/shared-fanout-2026-11-03.md` (1,000 players, towns, paired exclusive-phase runs): assemble 10.3 -> 0.86 ms, send 26.3 -> 22.5 ms, tick mean 73.2 -> 62.5 ms, ticks/s 12.0 -> 14.1. `publish` gave no further gain (the cost moved into the publish calls), so it is not the default. Tests: every envelope shadow-checked against the JS encoding in a live Gateway for default, assembly and publish, and every client-received DeltaSet is one built for that client's session.

The arena view is shared by a group's sessions for the tick; it is valid until the next tick's `begin()`, as before. A closed socket still gets a `slice()` copy.

## selectNames: skipping what a session already knows

Per tick the addon hashes each sector's id list (order independent). A session remembers, per sector, the hash it last fully scanned. Same hash: nothing to do. Hash equals last call's hash (the session was current): only the ids that were not in that sector last call are checked. Anything else (a new session, one that missed a tick, a changed sector it never saw) scans the whole list. `sent` stays the single source of truth for "told", so the outputs equal the old full scan (tested against the JS rule); the hash only decides how much to look at. The hash is a skip hint only, never the record of what was sent. In the 1,000-player benchmark ids scanned per call fell from about 200,000 to about 4,000 and selectNames from 5.9 to 0.77 ms per tick. `Fanout.stats()` reports the counters.

**Hash collision policy.** If a sector's membership changes but its 64-bit hash equals the one a session last scanned (about 2^-64 per change), the session skips the change and a newly arrived name is not selected. Without more, that name could stay hidden for as long as the id stays in the sector and the session keeps scanning only "new" ids, so the addon bounds it: each session forgets what it scanned once every 256 `selectNames` calls (staggered by slot, so about 1/256 of sessions rescan per tick), and the next call scans every sector it sees in full against `sent`. A collision therefore hides a name for at most 256 ticks (about 8.5 s at 30 Hz), then recovers. The rescan costs about one full scan per session per 256 ticks, measured in the 1,000-session benchmark (3,000 ticks, Node 22.22.2) as median 0.39 to 0.43 ms with it and 0.39 to 0.40 ms without, p99 0.59 to 0.80 vs 0.79 to 0.87 ms, i.e. inside run-to-run noise. `new Fanout({ rescanEvery, hashBits })`: `rescanEvery` 0 turns it off, `hashBits` shortens the hash and exists to test collisions (tests force collisions with 3 bits and check the bound).

**Name lifetime and invalidation.** A name is sent once per session per wire id, by both paths. The invariant the rule relies on is that a wire id (slot + generation) names one thing for its whole life and its name does not change.
- *Entity-id reuse:* a reused slot gets a new generation, so a new wire id, so its name is sent (tested).
- *Name changes without a membership change:* not detected; the old name stays on the client. The only change that exists today is a guild tag, and `pushTags` re-sends those rows to every welcomed session outside this rule. Anything else that renames an entity must do the same.
- *Reconnect:* a new session has new state; a closed one is released by the sweep (at most 64 ticks later) and its slot is cleared on reuse (tested).
- *Resync / baseline replace and view changes:* `sent` is not cleared, because the client keeps the names it has been told. An entity that leaves view and returns is not named again; the client's name table must outlive visibility.
