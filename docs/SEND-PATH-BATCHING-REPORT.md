# Send-path batching (`MMO_UWS_CORK`) — report

Branch `feat/perf-send-path`. Status: **implemented, locally tested, performance unmeasured.** No performance claim is made here; every performance number below is either absent or tagged.

## Why

A 1,000-client uWS profile on the pinned Linux harness (Node 24, `perf record --call-graph fp`) put most gateway time in the socket write path: roughly 45% `node::StreamBase::Writev`/`_writeGeneric`, 30% `__writev`, 15% libuv write bookkeeping `[measured, user-supplied profile, percentages approximate]`. Outside a uWS callback every `ws.send` is its own write syscall, and a session receives several messages per tick (names, delta, stats), so syscalls per tick scale with messages, not sockets `[modeled from the code path; syscall counts not yet measured]`.

## What changed

| Change | File | Default |
|---|---|---|
| Per-tick send batching: sends during `broadcast()` are copied into one reusable arena and written per socket inside one `ws.cork` at the end of the broadcast; `publish()` flushes held sends first | `src/net/transport.ts` (`UwsBatch`, `UwsTransport.beginBatch/endBatch`), `src/net/gateway.ts` (`broadcast` wraps `broadcastInner`) | **off** (`MMO_UWS_CORK=1` to enable) |
| `BigInt(tick)` made once per tick (`bigTick()`) instead of once per session per delivery | `src/net/gateway.ts` | on (behaviour-neutral) |
| `--multi` / `--cork` bench modes | `src/net/transport-bench.ts` | n/a |

Not changed: wire bytes, ordering per socket, the `publish`/sector paths, the native fan-out. Copies are taken (not references) because some encoders return views into reused builders.

Investigated and dropped: pre-computing numeric ids for `parseWireEntityId` — all of its call sites in `gateway.ts` are cold paths (despawn, grace sweep, admin, token-intent API).

## Environment (what was actually run here)

| Item | Value |
|---|---|
| OS / CPU | Windows, developer workstation (not the pinned harness) |
| Node | 25.x |
| uWS | **not loadable** on this host (prebuilt binary does not support this Node on Windows) |
| Build | `tsc -p packages/engine-core` |

## Verification

| Telemetry Metric | Measured Value | Gate Requirement | Gate Status |
|---|---|---|---|
| `tsc --noEmit`, engine-core | 0 errors `[measured]` | clean | PASS |
| New `transport-batch.test.ts` (fake uWS: off-by-default, hold/flush order, buffer-reuse safety, publish-flush ordering, arena/index growth) | 4/4 `[measured]` | all green | PASS |
| Net regression subset (`gateway`, `gateway-sector`, `gateway-interest`, `gateway-names`, `native-fanout`, `transport`) | 51/52 `[measured]` | no new failures | PASS (see caveat) |
| Tick p50/p99 with/without batching at 1,000 uWS clients | not measured | below 33.33 ms frame budget | **NOT MEASURED** |
| Write syscalls per tick with/without batching | not measured | fewer with batching | **NOT MEASURED** |
| Bytes per send | not measured | unchanged | **NOT MEASURED** |

Caveat on 51/52: `transport.test.js` aborts at process exit with a libuv assertion (`UV_HANDLE_CLOSING`, `src\win\async.c:76`) after all its subtests pass. The identical failure occurs with `transport.ts` and `gateway.ts` from the parent commit, so it is a pre-existing Windows/Node 25 teardown problem, not caused by this change. It is documented here, not inherited silently. Tests that need real uWS (`gateway-native-fanout.test.ts` on uWS) were not run on this host.

A `ws`-only smoke run of the new bench mode (`--multi`, 100 clients, 3 s) executed end to end `[measured, ws transport, sandbox, not a batching result since batching is uWS-only]`.

## How to measure (pinned Linux / Node 22, real uWS)

```bash
npm run build -w @mmo-engine/engine-core
# three messages per socket per tick (64 B, 1.2 KB, 64 B), 1,000 clients, 60 s
node packages/engine-core/dist/src/net/transport-bench.js 1000 --multi --seconds 60 --out multi-nocork.json
node packages/engine-core/dist/src/net/transport-bench.js 1000 --multi --seconds 60 --cork --out multi-cork.json
# syscalls per tick (count write syscalls during the window)
strace -f -c -e trace=writev,write,sendto -p <pid>
# call-graph profile for the flame graph
perf record --call-graph fp -F 99 -p <pid> -o gateway-uws.perf.data -- sleep 60
```

Compare CPU %, broadcast p50/p99, loop p99, delivered/s, and syscall counts. Then repeat with the full gateway (`MMO_UWS_CORK=1` on the server) at 1k / 10k entities for the whole-tick numbers AGENTS.md §8.1 asks for. Gate to flip the default: lower CPU and p99 with delivered/s unchanged and no ordering failures in the gateway suites on uWS.

## Documentation sync

`docs/NATIVE-FANOUT.md` (send-batching section). `docs/ROADMAP.md` and `docs/DECISIONS.md` are unchanged because the default behaviour and port status are unchanged; they should be updated in the PR that makes batching the default.
