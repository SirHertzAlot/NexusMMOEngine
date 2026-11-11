# Documentation audit

Audited 2026-11-11 against `main` at `f69dae9b`. This is roadmap item DOC1. It records what was checked, what this pass fixed, and, most usefully, what is still wrong, so the next pass starts from evidence and not from a guess.

## What was checked

`scripts/docs-audit.py` (Python 3, no dependencies) compares 104 Markdown files (everything under `docs/` except `docs/library/` and `docs/superpowers/`, plus the README, CONTRIBUTING and AGENTS) against the code:

| Check | What it compares |
|---|---|
| Links | every relative Markdown link, to the file system |
| Paths | every repo path named in backticks (`apps/...`, `packages/...`, `content/...`), to the file system |
| Environment | every `MMO_*` variable in the code, to the docs, and `docs/CONFIGURATION.md` in particular |
| Scripts | every root `npm run` script, to `CLI.md`, `GETTING-STARTED.md` and the README, and every `npm run X` in the docs, to the scripts that exist |
| Packages | every workspace package, to the README and `ARCHITECTURE.md` |
| Messages | every message code in `packages/protocol`, to `MESSAGE-CATALOG.md` |

It also needed judgment: a human read of the performance sources, the roadmap and the oldest docs. **The script cannot tell you a paragraph is out of date.** It finds missing things, not wrong prose. The section "Features with no doc" below is the result of the part it cannot do.

Run it again with `python3 scripts/docs-audit.py`. It writes `valgrind-out/docs-audit.json` (git-ignored).

## Result

| Check | Before | After this pass |
|---|---:|---:|
| Broken relative links | 1 | **0** |
| `file:///c:/Users/user/...` links (dead on GitHub for everyone else) | 65 | **0** |
| Repo paths named in docs that do not exist | 57 | 55 (see below: most are not errors) |
| Env vars in code and in no doc | 20 | **1** (a prefix, `MMO_DAY_`) |
| Env vars documented only outside `CONFIGURATION.md` | 41 | 30 |
| Root scripts not in the CLI docs | 24 | 6 (all `test:addon-<name>`, documented as one pattern: a false positive) |
| Packages not named in README or `ARCHITECTURE.md` | 7 | **0** |
| Message codes in the protocol but not the catalog | 5 | 2 (`0x46` is the fast-path magic byte and `0xff` a bit mask: not messages) |
| Protocol version in the catalog | 25 (code: 29) | **29** |

## Fixed in this pass

- **`PERFORMANCE.md` (new, DOC2).** Measured cost and constraints, with every number sourced and dated and each marked measured, derived or not measured. Published on the docs site under Start here.
- **`MESSAGE-CATALOG.md`.** Protocol version 25 to 29, with the v26 to v29 history from the code; added messages `0x25` DeltaSet, `0x26` border and `0x27` interact.
- **`CONFIGURATION.md`.** 28 variables added in three sections: performance and transport switches (data plane, native fan-out, send batching, slow-consumer policy, interest management, edge), content file locations, and bake and editor switches. Each default was checked in the code.
- **`CLI.md`.** Added the valgrind family, `lint`, `test:scripts`, `smoke:editor-load`, the ragdoll and persistence benchmarks and three other tools.
- **`ARCHITECTURE.md`.** A new "How it runs today" section (standalone, edge and core, data plane, many regions); the addon table gained `geometry`, `terrain-kernel` and `fanout`; the package list gained seven packages; the persistence decision now reflects SurrealKV and SurrealMX.
- **`README.md`.** The layout block lists every package; pointers to the performance page and the docs site.
- **65 dead `file:///` links** across 13 docs rewritten to correct relative links (all targets exist). They were dead on GitHub for everyone except one Windows checkout.
- **Roadmap.** Two unresolved merge-conflict blocks resolved (keeping the current summary); the stale "GitHub Actions is out of credits" note replaced with CI's current state.
- **Smaller fixes.** Two wrong relative links in the wiki, a malformed math span, the `transport-bench` path (it moved to `src/net/`) in three docs, an implementation note on `EDGE-CORE-SPLIT.md`, and a dead image link.

## Still open, in priority order

### 1. Features that exist and have no doc

Found by checking which docs mention features the roadmap and protocol say shipped. A count of 0 across the player and designer docs means the feature is only in the code and the message catalog.

| Feature | Evidence it exists | Where it is documented today |
|---|---|---|
| **Duels** | message `0x20`, roadmap M5 | the message catalog only |
| **Magic, mana and spells** | message `0x1c`, protocol v21 | `DUNGEONS-AND-LOOT.md` mentions mana in passing; nowhere explained |
| **Trade, vendors and auctions** | message `0x21`, roadmap EC1 | `CHARACTERS-AND-SOCIAL.md` (2 mentions), `GAMEPLAY.md` (none) |
| **Gathering and resource nodes** | message `0x24` | one line in `GAMEPLAY.md` |
| **Residents** (people living in towns) | roadmap RS and SG7, 800 resident cap | `SETTLEMENTS.md` partly |
| **Ragdolls** | roadmap, cost gate | `RAGDOLL-COST-GATE.md` and `CLIENT-PHYSICS.md` only; not in `GAMEPLAY.md` |
| **Interest management** | on by default; messages `0x25`, `0x26` | the wiki and `CONFIGURATION.md`, as a switch; the concept is not explained anywhere player-facing |
| **The data plane** | `MMO_DATA_PLANE=1` | wiki chapter 1 only; `GETTING-STARTED.md` never says it exists |

**Write next:** `GAMEPLAY.md` and `MASTERY-AND-COMBAT.md` need new sections for duels, magic and mana, trade and vendors, and gathering; `GETTING-STARTED.md` needs a short "turn on the fast paths" section.

### 2. Docs not changed for a month or more

Last change on `main` for the first-read set, oldest first: `CHARACTER-PLAN.md` and `PCG-SPEC.md` (2026-09-28), `CLIENT-FX.md` and `MASTERY-AND-COMBAT.md` (09-29), `ALPHA-PLAN.md` and `EDGE-CORE-SPLIT.md` (10-01), `WORLD-SERVER-SPEC.md` and `WORLD-STRESS-RESULTS.md` (10-04), `GAMEPLAY.md` (10-06). Most of the combat, economy and interaction features above landed after these dates, which is why they are the ones with gaps. Each needs a read against the code, not just a date check.

### 3. Files the docs cite that are not in the repository

- `perf/native-fanout-results-2026-11-03.md` and `perf/drop-tick-delta-push` (roadmap PF2), `perf/shared-fanout-2026-11-03.md` (`NATIVE-FANOUT.md`). The measurements they support are quoted in the roadmap and in `PERFORMANCE.md`, but **the raw results are missing**, so the numbers cannot be checked. Commit the files or reword the citations.
- `perf/history.json` (`CLI.md`, roadmap): created only when someone runs `valgrind:record --promote`; say so.
- `scripts/fetch-surfaces.mjs` (`CLIENT-FX.md`), `scripts/dev.mjs` and `scripts/export-scene.mjs` (roadmap): gone or renamed.
- `content/items`, `content/recipes`, `content/ecology` (`DUNGEONS-AND-LOOT.md`): the folders no longer exist; the content moved.

### 4. Design documents that name files that were never built

`EDITOR-ARCHITECTURE.md` lists planned folders (`content/dialog`, `content/editor/layouts`, `content/tests`, `packages/sidecar`); `EDITOR-GAP-AUDIT.md` lists `content/prefabs` and `content/play/setups.json`; `LIVING-SIM-DEEP-DIVE.md` lists `content/lore/factions.json`. These are plans. Each should say so at the top, as `EDGE-CORE-SPLIT.md` now does.

The remaining "missing path" findings are not errors: eight are `.local.json` files that are meant to be machine-local, five are generated or fetched at setup (`region.db`, `apps/client/public/surfaces`), and two are created at runtime (`content/locks.json`).

### 5. Environment variables still outside `CONFIGURATION.md`

They are documented somewhere, just not on the page people look at. Thirty names, mostly content locations: `MMO_ADMINS`, `MMO_ASSETS_DIR`, `MMO_BAKE_SHAPE`, `MMO_BAKE_SIZE_CHUNKS`, `MMO_BIOMES`, `MMO_CATALOG`, `MMO_COMBAT`, `MMO_CONTENT_DIR`, `MMO_CRAFTING`, `MMO_DEV_SERVER`, `MMO_DUNGEONS`, `MMO_INSTANCE_HOST`, `MMO_MODULES`, `MMO_ORDERED_BUILD`, `MMO_PREFABS`, `MMO_QUESTS`, `MMO_REPO`, `MMO_SCALE`, `MMO_SCALE_OUT`, `MMO_SCENE`, `MMO_SCENES`, `MMO_SCENES_DIR`, `MMO_SETTLEMENT_OUT`, `MMO_SETTLEMENT_RULES`, `MMO_SPAWN_OVERRIDE`, `MMO_SPECIES`, `MMO_USERS_CSV`, `MMO_WILDLIFE`, `MMO_WILDLIFE_LOG`, `MMO_WILD_CREATURES`.

### 6. Documents that mislead

- **`ENGINE-COMPARISON-AND-PERFORMANCE.md` §4 "Current bottlenecks"** is out of date. It describes interest-management allocation churn that has been worked on since (PF1 and the zero-allocation interest commits), and a WebGL draw-call ceiling that nothing in the repository measures. Its comparison matrix is a positioning document, not a benchmark. `PERFORMANCE.md` is the current account; this section should point to it or be removed.
- **`docs/business-analysis/`** quotes cloud costs per concurrent user and a "benchmark telemetry" table. The cost figures are not derived from anything measured in the repository, and `03-benchmark-telemetry.md` cites three test files that do not exist (`playtest-loft-accessibility.spec.ts`, `synthesizer.test.ts`, a dungeon decomposition JSON). Treat it as unverified until each claim is traced.
- **`DECISIONS.md` line 44** reports a 0.562 ms p99 tick at 1,000 players and 50,000 entities. That figure is the sim worker's step on the data plane, not the end-to-end tick (about 62 to 66 ms at 1,000 players, the roadmap's PF2). Both are true; the decision log should say which one it means. `PERFORMANCE.md` does.

### 7. Duplicates and drift

- `docs/SAB-LOGGING-PERFORMANCE-REPORT.md` and `docs/wiki/SAB-LOGGING-PERFORMANCE-REPORT.md` are the same report.
- `docs/WIKI.md` is the single-page form of `docs/wiki/`; they will drift. Pick one as the source.
- `docs/wiki/01-architecture-overview.md` repeats its first three sections at the end.
- `npm run db` appears in several docs without saying it is a script of `@mmo-engine/world-server` (`npm run db -w @mmo-engine/world-server`) and needs the `surreal` binary.
- The roadmap's "At a glance" counts (279 built, 1 in progress, 0 planned, dated 2026-11-01) were computed from the tables and are out of date as items have been added since. They should be regenerated by a script, not edited by hand.

## Not audited

91 files: `docs/library/` (R&D notes and external research) and `docs/superpowers/` (specs). They are working papers, not product documentation, and were left out on purpose. The script skips them.

## Limits of this audit

- Link and path checks only catch things that are missing. A page can link correctly and still describe the wrong behavior.
- The environment check finds `MMO_*` names in code by pattern; a prefix such as `MMO_DAY_` shows up as a false positive.
- The feature-coverage check searches for keywords. A feature described under another name would be missed, and a passing mention counts as a mention.
- Nothing here re-ran the benchmarks. `PERFORMANCE.md` quotes the repository's own logs, plus two fresh runs from this session (callgrind instruction counts and a send-batching comparison), both labeled as such.
