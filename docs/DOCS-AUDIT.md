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

| Check | Before | After |
|---|---:|---:|
| Broken relative links | 1 | **0** |
| `file:///c:/Users/user/...` links (dead on GitHub for everyone else) | 65 | **0** |
| Repo paths named in docs that do not exist | 57 | 57 (none is a broken link; see "Still open" 4: the rest are local-by-design, generated, planned or defaults documented as absent) |
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

## Still open, in priority order

### 1. Not re-read in this audit

The machine checks above ran over all of these. **What I did not do is read their prose against the code**, so each can still be wrong in ways the script cannot see:

- Wiki chapters 02 to 10 (written 2026-10-27), `EDITOR.md`, `WORLD-BUILDING.md`, `ART-PIPELINE.md` (its "not built" notes about moving creatures and rig views), the body of `ARCHITECTURE.md` outside the sections changed here, `GETTING-STARTED.md` sections 1 to 8, and `GAMEPLAY.md`'s Movement, Characters and Bots sections.
- The `CONFIGURATION.md` rows that were already there. Only the rows added in this audit were checked against the code.
- `MASTERY-AND-COMBAT.md` §§2 to 6 (the design itself). Its status, slice table and open questions were corrected; its numbers and mechanics were not re-checked.
- `GAMEPLAY.md`'s residents section rests on the roadmap rows RS3 to RS7 and the system's header, not on a running world. In particular the roadmap says homestead people are baked (RS4) while SG7's row says the families "are next"; I did not check which is current.

### 2. Plan checklists that are stale

`CHARACTER-PLAN.md` and `OPEN-WORLD-PLAN.md` carry dated notes that their unchecked boxes are not current. The boxes themselves were not re-ticked: each needs checking against the code.

### 3. Files the docs cite that are not in the repository

`perf/native-fanout-results-2026-11-03.md` (roadmap PF2), `perf/shared-fanout-2026-11-03.md` (`NATIVE-FANOUT.md`) and `perf/drop-tick-delta-push` (a branch name, cited as a path). The docs now say the files are missing, but the raw results are still gone: commit them if they exist elsewhere. `perf/history.json` exists only after someone runs `valgrind:record --promote`.

### 4. The "missing path" findings that remain

Eight are `.local.json` files meant to be machine-local, five are generated or fetched at setup, two are created at runtime (`content/locks.json`), three are defaults documented as absent in a fresh checkout (`content/biomes.json`, `content/prefabs`, `content/scale.local.json`). The rest are planned folders in design docs (`EDITOR-ARCHITECTURE.md`, `EDITOR-GAP-AUDIT.md`, `LIVING-SIM-DEEP-DIVE.md`), historical entries in the append-only `DECISIONS.md` and roadmap log, and a few roadmap rows that cite scripts that were renamed (`scripts/dev.mjs`, `scripts/export-scene.mjs`).

### 5. Documents that mislead, or may

- **`docs/business-analysis/`** is marked private and was not touched. Its cost figures are not derived from anything measured in this repository, and `03-benchmark-telemetry.md` cites three test files that do not exist (`playtest-loft-accessibility.spec.ts`, `synthesizer.test.ts`, a dungeon decomposition JSON). Treat it as unverified until each claim is traced.
- **`ENGINE-COMPARISON-AND-PERFORMANCE.md`** now has a status note on §4, but it is still a competitive comparison in the public `docs/` folder. See the policy question below.
- **`DECISIONS.md` line 44** reports a 0.562 ms p99 tick at 1,000 players and 50,000 entities. That is the sim worker's step on the data plane, not the end-to-end tick (about 62 to 66 ms at 1,000 players, roadmap PF2). The decision log is append-only, so a clarifying entry would be the way to fix it; `PERFORMANCE.md` explains the difference.
- **A few roadmap row notes** are probably stale in the way M3's armour note was (for example IX1a "still to do", WL1 "not built"). I fixed the ones I could contradict from the tables and left the rest.

### 6. A policy question

`docs/business-analysis/README.md` says competitive comparisons and commercial analyses live only in the private suite, and that public manuals cover the engine alone. `ENGINE-COMPARISON-AND-PERFORMANCE.md` is in the public `docs/` folder and is a competitive comparison, and the root README links to the business analysis. `PERFORMANCE.md` deliberately links to neither. Whether the comparison doc should move is a decision for the owners, not something this audit changed.

### 7. Product gaps found while writing

The client has no UI for player-to-player trade, the auction house or casting a spell directly. They are built on the server and in the protocol (`0x21`, `0x1c`) and are usable by bots and tools. `GAMEPLAY.md` says so. No 1,000-session run through the edge exists, and the send-batching gate has not been run; both are on the roadmap's what-is-left list.

## Not audited

91 files: `docs/library/` (R&D notes and external research) and `docs/superpowers/` (specs). They are working papers, not product documentation, and were left out on purpose. The script skips them.

## Limits of this audit

- Link and path checks only catch things that are missing. A page can link correctly and still describe the wrong behavior.
- The environment check finds `MMO_*` names in code by pattern; a prefix such as `MMO_DAY_` shows up as a false positive.
- The feature-coverage check searches for keywords. A feature described under another name would be missed, and a passing mention counts as a mention.
- Nothing here re-ran the benchmarks. `PERFORMANCE.md` quotes the repository's own logs, plus two fresh runs from this session (callgrind instruction counts and a send-batching comparison), both labeled as such.
