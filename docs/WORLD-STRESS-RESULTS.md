# World server stress results (slice D)

The acceptance number from WORLD-SERVER-SPEC §11: **16 regions per box
before degradation** on the reference box below. At 24 regions a region's
tick p99 runs past one 30 Hz frame. The limit is region CPU on a shared
box. The world server is not the limit: at 16 regions it used 15% of one
core.

Run it with `npm run stress:world` (after `npm run build`). It takes the
options `--sweep 1,2,4 --window 30 --warmup 8 --entities 500 --players 40
--out results.json`.

## Setup

- **Box:** 4 cores (Intel Xeon @ 2.10 GHz), 16 GiB, Node v22.22.
- **World server:** one process with the in-memory store (spec §10: the DB
  stays out of the measurement), served over webrpc. It ran with heartbeat
  1 s, heartbeat timeout 5 s and migration timeout 5 s.
- **Regions:** N child processes, each a real `Gateway` ticking at 30 Hz.
  Each region has:
  - 500 simulated entities;
  - 100 players wandering at 7 m/s across an 8-chunk-wide strip, so they
    cross region borders all the time;
  - a `WorldClient` and a `MigrationCoordinator`.
- **Clients:** the harness plays each player's client. It takes a source's
  redirect to the target region, and the target accepts with the migration
  id.
- **Hand-off time:** from the redirect to the target's confirmed commit.
- **Window:** 8 s warm-up, then 30 s measured per step. The step at
  N = 32 used a 10 s window.

Stop conditions, taken from the spec plus one addition. The sweep stops at
the first N that breaks one of them:
- hand-off p99 > 500 ms;
- tick jitter (event-loop delay p99) > 8 ms on any region;
- world CPU > 80%;
- any region's tick p99 > 33.3 ms. This one is added: a tick longer than a
  frame means the region can no longer hold 30 Hz.

## Results

| Regions | Hand-offs (ok/started) | Hand-off p50 / p99 ms | Tick jitter p99 ms | Region tick p99 ms | World CPU % (avg) | World RSS MB | Heartbeat p99 ms | Begin / commit p99 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 / 0 | – | 2.00 | 2.0 | 0.4 | 69 | 4.8 | – |
| 2 | 118 / 118 | 5.4 / 8.0 | 2.03 | 1.5 | 2.3 | 78 | 4.5 | 8.7 / 4.4 |
| 3 | 218 / 218 | 5.5 / 10.4 | 2.13 | 2.0 | 3.7 | 84 | 18.2 | 5.1 / 5.8 |
| 4 | 329 / 329 | 5.4 / 16.0 | 2.13 | 2.0 | 4.9 | 92 | 4.5 | 10.8 / 8.2 |
| 6 | 525 / 525 | 5.3 / 13.6 | 2.12 | 2.0 | 6.3 | 122 | 6.0 | 7.2 / 6.1 |
| 8 | 731 / 731 | 5.3 / 17.1 | 2.24 | 4.0 | 8.7 | 123 | 5.1 | 8.5 / 6.4 |
| 12 | 1169 / 1169 | 5.0 / 13.6 | 2.31 | 13.5 | 12.5 | 125 | 6.6 | 6.7 / 6.7 |
| **16** | **1584 / 1584** | **5.1 / 15.4** | **2.54** | **7.5** | **14.9** | **125** | **7.8** | **8.7 / 8.0** |
| 24 | 2398 / 2398 | 6.4 / 26.2 | 3.45 | **40.5** | 20.2 | 147 | 10.6 | – |
| 32 | 951 / 953 | 8.6 / 36.1 | 4.01 | **40.5** | 20.8 | 148 | 17.3 | 18.9 / 18.8 |

Every hand-off that started inside a window committed, and the world
refused none. At N = 32, 2 hand-offs were still in flight when its short
window closed. No region logged an error at any N.

## What it says

- **Regions run out of CPU before the world server does.** From 24 regions
  up, 6 or more 30 Hz processes share each core and their ticks stretch
  past a frame. Even then the world server sat at about 20% of one core,
  and its webrpc p99 stayed under 20 ms.
- **The world server has headroom for many more regions,** as long as they
  run on other boxes. This is inferred, not measured: its CPU grew by
  roughly 0.9% of a core per region up to 16, which puts 80% of one core
  somewhere past 80 regions. The heartbeat and migration work it does is
  small. The next sweep worth running puts the world on its own box with
  regions spread over several (spec §10, "Later").
- **Hand-offs stay fast.** p50 holds at about 5 ms from 2 to 24 regions. p99
  grows with box load, not with world load: it reached 36 ms at 32 regions,
  far under the 500 ms limit. Payload size is not a bottleneck yet, so the
  spec's slice B+ (direct A→B transfer) isn't needed.
- **Starting many regions at once** can make registers time out, because
  each one verifies the API key with argon2. Regions now retry registering
  with backoff. Production regions start one by one and won't hit this.
