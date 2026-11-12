# Documentation audit

Audited 2026-11-11 against `main` at `f69dae9b`. This is roadmap item DOC1. It records what was checked, what this pass fixed, and, most usefully, what is still wrong, so the next pass starts from evidence and not from a guess.

## What was checked

`scripts/docs-audit.py` (Python 3, no dependencies) compares 106 Markdown files (104 at the first pass; `MODULES.md` and `OPERATIONS.md` were added since — everything under `docs/` except `docs/library/` and `docs/superpowers/`, plus the README, CONTRIBUTING and AGENTS) against the code:

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

| Check | Before | After |
|---|---:|---:|
| Broken relative links | 1 | **0** |
| `file:///c:/Users/user/...` links (dead on GitHub for everyone else) | 65 | **0** |
| Repo paths named in docs that do not exist | 57 | 58 (none is a broken link; see "Still open" 4: the rest are local-by-design, generated, planned or defaults documented as absent — the newest, `perf/history.json` in `CLI.md`, only exists after `valgrind:record --promote`) |
| Env vars in code and in no doc | 20 | **1** (a prefix, `MMO_DAY_`) |
| Env vars documented only outside `CONFIGURATION.md` | 41 | **0** |
| Root scripts not in the CLI docs | 24 | 6 (all `test:addon-<name>`, documented as one pattern: a false positive) |
| Packages not named in README or `ARCHITECTURE.md` | 7 | **0** |
| Message codes in the protocol but not the catalog | 5 | 2 (`0x46` is the fast-path magic byte and `0xff` a bit mask: not messages) |
| Protocol version in the catalog | 25 (code: 29) | **29** |
| Docs that say "not yet built" or "design" for something that is built | 6 | **0** (found by reading) |
| False statements in first-read docs (combat "deals no damage", hooks "not driven", the edge as opt-in) | 3 | **0** (found by reading) |
| Roadmap "what is left" IDs that were already done | about 35 | list rebuilt |

## Fixed

**First pass.** `PERFORMANCE.md` (new); message catalog (version 25 to 29, messages `0x25` to `0x27`); 28 environment variables in `CONFIGURATION.md`; scripts in `CLI.md`; `ARCHITECTURE.md` (how it runs today, the new addons and packages, persistence); the README layout; 65 dead `file:///` links; the roadmap's conflict markers; the `transport-bench` path; smaller link and math fixes.

**Second pass.**
- `GAMEPLAY.md`: Hurt, healing and death; Abilities, telegraphs and status effects (from `content/combat/abilities.json`, including that the `heal` ability is **not** the Mend spell); Duels; Magic and mana; Gathering; Gold, shops, trading and the auction house; chests and interactions; the people of the towns. The Controls table gained E, R, T, H, Tab and B.
- `ARCHITECTURE.md`: Interest management. `GETTING-STARTED.md`: the fast paths.
- Two false statements removed (combat "deals no damage yet"; rules hooks "not yet driven by the simulation").
- A wrong default corrected: `npm start` runs the core **behind the edge**. Native fan-out only runs when the core serves players directly, so the fan-out numbers are for that shape, and `PERFORMANCE.md` says so.

**Third pass.**
- The 29 environment variables still outside `CONFIGURATION.md`, from the server's own header block.
- Status headers corrected on `MASTERY-AND-COMBAT.md`, `DUNGEONS-AND-LOOT.md`, `CHARACTERS-AND-SOCIAL.md`, `WORLD-SERVER-SPEC.md` and `SETTLEMENTS.md` (all built, per the roadmap); `SETTLEMENTS.md`'s body no longer says roads and residents are unbuilt. Dated notes on `EDITOR-ARCHITECTURE.md`, `LIVING-SIM-DEEP-DIVE.md`, `ALPHA-PLAN.md`, `CHARACTER-PLAN.md`, `OPEN-WORLD-PLAN.md`, `PCG-SPEC.md` and `ENGINE-COMPARISON-AND-PERFORMANCE.md` §4.
- `PERFORMANCE.md` corrected: E5a and E5c are done and interest management is built, so the base64 encode numbers are labeled as the earlier stream. Its links to the private business analysis and the comparison doc are removed.
- The roadmap: the stale "what is left" list rebuilt from the open follow-ups the tables record; the at-a-glance counts recomputed from the tables (284 built, 4 in progress); notes where cited perf result files are not in the repository; armour wear shipped with U10b, so three statements that armour "waits" are fixed.
- A repeated block removed from wiki chapter 1; the duplicate SAB report replaced by a pointer; `npm run db` made precise (`-w @mmo-engine/world-server`); a `CLIENT-FX.md` path corrected. The README now carries the headline capacity numbers with their limits, as `ALPHA-PLAN.md` asked for.

**Fourth to sixth passes.**
- `MODULES.md` (new): the manifest, enabling, tick order, writing a module, and a generated table of all 34. `OPERATIONS.md` (new): processes, ports, health and metrics, data files, logs, failure behavior and a security checklist.
- The edge corrected everywhere (it is the default front door, not opt-in) in the wiki, `ARCHITECTURE.md` and the website's architecture page. Wiki chapters fixed for structure, the addon catalog and the native addon guide.
- `EDITOR.md` opening rewritten with a generated table of the 20 editor modules. The remaining environment variables, content locations and ingress limits are in `CONFIGURATION.md`. More scripts in `CLI.md`.
- `CLI.md`'s admin console table now lists every command the gateway handles (13 were missing: `god`, `noclip`, `addcomponent`, `removecomponent`, `appearance`, `find`, `interest`, `bots`, `residents`, `loglevel`, `pause`, `resume`, `step`).

**Seventh pass (2026-11-11).** The prose re-read against the code, over most of what "Still open" 1 named:
- `ARCHITECTURE.md` body: system order is no longer one list in `server.ts` — each module declares `after`/`before` and the server resolves one order at boot; the component table says it is the first twelve and names the rest of `COMPONENT_IDS` (`Stamina` 12 through `Breakable` 23); the message table says the protocol is at version 29 and runs to `0x27`; the gateway section now says interest management is built and on by default (`MMO_INTEREST=0` turns it off); the persistence table points to `OPERATIONS.md` for the full state-file set.
- `ART-PIPELINE.md`: the "not built" notes are gone — the wildlife table becomes real simulated creatures under `MMO_WILDLIFE=1` (WL2), and the editor has a rig view (`RigPreview`). The animal rig is the shared `@mmo-engine/animal-rig` package; birds, snakes and fish have their own rig types (`gait.ts`).
- `MASTERY-AND-COMBAT.md` §6 rewritten from the code as built (`body.ts`, `protocol/src/locomotion.ts`): the real `Body`/`Injury`/`Health` fields, and the buttons as shipped — Attack `0x02` (press), Block `0x04` (held; the plan called it Defend), Dodge `0x08` (press).
- `GAMEPLAY.md`: creature moves exist (ids 20 to 29, bite through cleave), and the needs "not built" note was wrong — the meters are on the wire, provisions carry `nourish`/`quench`, eating is a 1 s cast a move or a blow cancels, and **E** uses the bag panel's hotkey item.
- `WORLD-BUILDING.md`: the default coast is the WG3 island (`shape` `island`, `islandRadius` 1.04, 6 `satellites`, `wander` 300 m; peninsula stays the schema default, and the shipped spec's `side`/`waterEdge`/`tip`/`taper` only apply to it); `MMO_DATA_DIR`'s default (`./data` from where the process starts) made precise.
- Wiki chapters 01, 02, 06 and 10: `spiralEvents` (the telemetry field's real name); `createSystems(ctx)` returns an object keyed by system name (per `modules/sample-heartbeat`); border hand-offs as `MigrationCoordinator` actually behaves, with the measured 16-region numbers cited from `WORLD-STRESS-RESULTS.md`; and chapter 10's telemetry story was wrong — there is no WebSocket telemetry stream, the live numbers are the edge's Prometheus scrape (`GET :3000/metrics`) and `/health`, so the applet and plugin sketches were rewritten to poll.
- `EDITOR.md`: a dated note that the "tabs" of sections 1 to 3 are now panels in the workspaces, and that the dev host serves more routes than the list shows. `EDGE-CORE-SPLIT.md`: a note that the design's metric names carry family prefixes when scraped, and where the registered names live (`apps/edge/src/metrics.ts`, `channel-server.ts`).
- `CONTRIBUTING.md`: the `NexusMMORepo` remote instructions now also cover a fresh clone (which names it `origin`).
- `packages/bench/RESULTS.md` re-run on the audit machine (2026-11-10; verdict HOLD, unchanged); `packages/art/dist/test/clip-playback.test.js` rebuilt to match its committed source test (17/17 pass). The audit script re-run: 106 docs, 0 broken links, no new undocumented env vars, one more path documented as absent (58).

**Eighth pass (2026-11-12).** Closed out the remaining "Still open" items that could be settled from evidence:
- Wiki chapters 03 to 05 and 07 to 09 re-read against the code — **all accurate, no prose changed.** Verified: ch03 `SPSC_CACHE_LINE_BYTES = 64`, Rigtorp `cachedHead`/`cachedTail` and Vyukov MPSC (`packages/logging/src/lockless-ring.ts`, re-exported by `packages/engine-core/src/lockless-ring.ts`), `GenerationalSlabAllocator` (`sab-store.ts`), the 0.2024 ms / 2.02 ns and 0.238 ms mean figures (corroborated by `CPP-MAIN-TICK-PHASE4-REPORT.md` and `BOTS-WORKERS-PERFORMANCE-REPORT.md`); ch04 all 12 addon directories exist and `addon-codec` is confirmed absent from the root `workspaces` list; ch05 interest radii (`enterM: 96, leaveM: 128, farM: 400`), `SECTOR_SIZE` 64, `DeltaSet` `0x25`, `MMO_FANOUT_SHARE=publish`, `MMO_INTEREST=0`, error `4003`, `packCommandToken`; ch07 `extractor.ts`/`synthesizer.ts`/`extractLearnedRuleSet`/`isConnectingTwoFloors`/`createStairHandrailGeometry` and UMS 1.80 m (`packages/scene/src/measurement.ts`); ch08 `FirstPersonRig`; ch09 the two synthesis scripts (`render-examples.mjs`, `playtest-loft-access.mjs`) exist, `modules/sample-heartbeat` and `modules/template-native` exist, `target_name` is a real `binding.gyp` key, Node `>=22`.
- `DECISIONS.md`: appended a dated clarification (2026-11-12) that the 0.562 ms p99 figure is the sim worker's data-plane step, not the end-to-end tick (62–66 ms at 1,000 players per PF2/`PERFORMANCE.md`). The log is append-only, so the original Phase 4 entry stands unchanged.
- Roadmap IX1a: the stale "the unified `interact` op and chest entities (D4f) are still to do" note was contradicted by the tables and the code (`0x27` shipped via IX1b/D4f ✅; `packages/engine-core/src/interact/chests.ts`, `packages/protocol/src/interact.ts`) and corrected.
- The missing `perf/*.md` result files were confirmed **never committed**: `git log --all --diff-filter=A -- 'perf/*.md'` returns nothing, so there is nothing in history to recover. The docs already flag them as absent.
- Policy question §6 resolved (owner decision): `ENGINE-COMPARISON-AND-PERFORMANCE.md` moved from the public `docs/` folder into `docs/business-analysis/` per AGENTS.md §1; internal links re-based, all inbound `.md` references updated (the `site/docs/*.html` are uncommitted build artifacts and regenerate).

## Still open, in priority order

### 1. Not re-read in this audit

The machine checks above ran over all of these. The seventh pass (2026-11-11) read the prose against the code for wiki chapters 01, 02, 06 and 10, `EDITOR.md`, `WORLD-BUILDING.md`, `ART-PIPELINE.md`, `MASTERY-AND-COMBAT.md` §6 and the `ARCHITECTURE.md` sections it changed. The eighth pass (2026-11-12) re-read wiki chapters 03 to 05 and 07 to 09 and found them accurate. What has still **not** been read that way, so each can still be wrong in ways the script cannot see:

- The body of `ARCHITECTURE.md` outside the sections changed so far, `GETTING-STARTED.md` sections 1 to 8, and `GAMEPLAY.md`'s Movement, Characters and Bots sections.
- The `CONFIGURATION.md` rows that were already there. Only the rows added in this audit were checked against the code.
- `MASTERY-AND-COMBAT.md` §§2 to 5 (the design itself). Its status, slice table, open questions and §6 were corrected; its numbers and mechanics were not re-checked.
- `GAMEPLAY.md`'s residents section rests on the roadmap rows RS3 to RS7 and the system's header, not on a running world. **Resolved 2026-11-12:** the RS4-vs-SG7 conflict is settled — homestead families are baked (RS4 ✅, `placeMembers` into `places.json`; SG7's boot check logs 52 people), and SG7's stale "the families themselves are next" note was corrected. `GAMEPLAY.md` already described them as baked, so it stands.

### 2. Plan checklists — closed 2026-11-11

`CHARACTER-PLAN.md` and `OPEN-WORLD-PLAN.md` were re-checked box by box against the code; shipped boxes are ticked, each with a dated note saying what was verified. Five stay open because nothing in the code or the roadmap shows them built: four in `CHARACTER-PLAN.md` (the part thumbnail grid in the creator, single moves cut from the CMU takes, strafing blend spaces, enemy humans generated from the catalog) and one in `OPEN-WORLD-PLAN.md` that is a setting on one Windows machine, not repository work.

### 3. Files the docs cite that are not in the repository

`perf/native-fanout-results-2026-11-03.md` (roadmap PF2), `perf/shared-fanout-2026-11-03.md` (`NATIVE-FANOUT.md`) and `perf/drop-tick-delta-push` (a branch name, cited as a path). The docs now say the files are missing, but the raw results are still gone: commit them if they exist elsewhere. `perf/history.json` exists only after someone runs `valgrind:record --promote`.

### 4. The "missing path" findings that remain

Eight are `.local.json` files meant to be machine-local, five are generated or fetched at setup, two are created at runtime (`content/locks.json`), three are defaults documented as absent in a fresh checkout (`content/biomes.json`, `content/prefabs`, `content/scale.local.json`). The rest are planned folders in design docs (`EDITOR-ARCHITECTURE.md`, `EDITOR-GAP-AUDIT.md`, `LIVING-SIM-DEEP-DIVE.md`), historical entries in the append-only `DECISIONS.md` and roadmap log, and a few roadmap rows that cite scripts that were renamed (`scripts/dev.mjs`, `scripts/export-scene.mjs`).

### 5. Documents that mislead, or may

- **`docs/business-analysis/`** is marked private and was not touched. Its cost figures are not derived from anything measured in this repository, and `03-benchmark-telemetry.md` cites three test files that do not exist (`playtest-loft-accessibility.spec.ts`, `synthesizer.test.ts`, a dungeon decomposition JSON). Treat it as unverified until each claim is traced.
- **`ENGINE-COMPARISON-AND-PERFORMANCE.md`** — **Resolved 2026-11-12:** moved to `docs/business-analysis/ENGINE-COMPARISON-AND-PERFORMANCE.md` per the AGENTS.md §1 invariant (competitive comparisons live only in the private suite). Its internal relative links were re-based for the new depth, and every inbound reference (`DECISIONS.md`, `ROADMAP.md`, the paperclip snippet) was updated. The generated `site/docs/*.html` are build artifacts (not committed) and regenerate from the `.md` sources; the doc was never in the site's curated page set (`docs.config.json`).
- **`DECISIONS.md` line 44** reports a 0.562 ms p99 tick at 1,000 players and 50,000 entities. That is the sim worker's step on the data plane, not the end-to-end tick (about 62 to 66 ms at 1,000 players, roadmap PF2). **Resolved 2026-11-12:** a dated clarifying entry was appended to the (append-only) log; `PERFORMANCE.md` explains the difference.
- **A few roadmap row notes** are probably stale in the way M3's armour note was (for example IX1a "still to do", WL1 "not built"). I fixed the ones I could contradict from the tables and left the rest. **IX1a resolved 2026-11-12** (the `0x27` interact op and chest entities shipped). One internal inconsistency remains for the owners: the WL2 table row is marked ✅ while the at-a-glance line and the "Creatures and the editor rig view" note still list WL2 as in progress with several "not built" follow-ups (birds, snakes, sea giants, editor rig view, real creatures using it) — whether WL2 is built or in progress is a status call, not something this audit changed.

### 6. A policy question — resolved 2026-11-12

`docs/business-analysis/README.md` says competitive comparisons and commercial analyses live only in the private suite, and that public manuals cover the engine alone. `ENGINE-COMPARISON-AND-PERFORMANCE.md` was a competitive comparison in the public `docs/` folder, which conflicted with that rule (AGENTS.md §1). **Owner decision: move it.** It now lives at `docs/business-analysis/ENGINE-COMPARISON-AND-PERFORMANCE.md`; its internal links were re-based and all inbound references updated. `PERFORMANCE.md` still links to neither the private suite nor the comparison doc, as before.

### 7. Product gaps found while writing

The client has no UI for player-to-player trade, the auction house or casting a spell directly. They are built on the server and in the protocol (`0x21`, `0x1c`) and are usable by bots and tools. `GAMEPLAY.md` says so. No 1,000-session run through the edge exists, and the send-batching gate has not been run; both are on the roadmap's what-is-left list.

## Not audited

91 files: `docs/library/` (R&D notes and external research) and `docs/superpowers/` (specs). They are working papers, not product documentation, and were left out on purpose. The script skips them.

## Limits of this audit

- Link and path checks only catch things that are missing. A page can link correctly and still describe the wrong behavior.
- The environment check finds `MMO_*` names in code by pattern; a prefix such as `MMO_DAY_` shows up as a false positive, and the `MMO_TERRAIN_*` wildcard row in `CONFIGURATION.md` shows up as a documented-but-unused name (the two real variables are documented as themselves).
- The feature-coverage check searches for keywords. A feature described under another name would be missed, and a passing mention counts as a mention.
- `PERFORMANCE.md` quotes the repository's own logs, plus two fresh runs from the first session (callgrind instruction counts and a send-batching comparison), both labeled as such. The one benchmark re-run since is the JS-world decision bench, `packages/bench/RESULTS.md` (2026-11-10, audit machine: AMD EPYC 7763, Node v24.21.0); its verdict (HOLD) is unchanged.
