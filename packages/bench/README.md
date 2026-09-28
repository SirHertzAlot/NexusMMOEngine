# @mmo-engine/bench

Slice-1.5 validation benchmark for the world-location decision
(Phase 1 plan §6): **harness A** (bitECS world + C++ `integrate` addon on
shared zero-copy buffers) vs **harness B** (pure C++ world, one
`stepWorld(dt)` N-API call per tick).

Workload: `position += velocity * dt` (f32 SoA) at 1k / 10k / 100k
entities; 200 warmup + 1000 measured ticks per case; empty N-API call
overhead measured separately. Both harnesses run the same C++ kernel, so
the numbers isolate world-location / boundary cost.

## Run

```sh
npm run bench          # from the repo root, or in this package
npm test               # fast correctness tests (A/B bit-exactness, small N)
```

`npm run bench` prints the comparison table and writes
[`RESULTS.md`](RESULTS.md) (date + machine stamped) with the verdict on
the reopen rule.

**Reopen rule:** if harness A exceeds 50% of the 33.3 ms tick budget at
10k entities, the JS-world decision is revisited (skill: surface
constraints early).

## Layout

- `src/harness.ts` — harness A/B setup, deterministic seeding, exactness check
- `src/run.ts` — driver: correctness checks, timing, RESULTS.md writer
- `test/correctness.test.ts` — fast node:test suite
