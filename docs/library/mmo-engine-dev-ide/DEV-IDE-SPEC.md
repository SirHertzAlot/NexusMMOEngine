# Dev IDE Specification — The Primary Development Environment

**Status:** Draft for review (2026-10-11)
**Positioning:** The Dev IDE is the primary environment for engine and game developers. Designers work through website authoring UIs (§10). Both produce the same validated data through the same pipeline.
**Companion:** `../mmo-engine-scripting/SCRIPTING-LAYER-SPEC.md` (data-definition layer, trust tiers, sandbox, invariants I1–I7).

---

## 1. Purpose

A developer should go from "idea for a mechanic" to "tested, versioned, baked, and running on a test shard" without leaving the editor. The Dev IDE is a complete development environment embedded in the editor app:

- Code editing (Monaco), file management, integrated terminal.
- Version control (git: status, diff, commit, branch, push, pull, history).
- CI/CD as a local pipeline runner: typecheck → lint → test → validate scripts → build → WASM compile → bake dry-run → deploy to test shard.
- WASM compilation target (AssemblyScript) for deterministic hot-path modules.
- Container orchestration for local services (world server, bake workers) via the Docker daemon API.

It is dev tooling, not runtime. Nothing in this spec touches the tick loop, the wire protocol, or the client renderer.

---

## 2. Design Principles

1. **Primary, not secondary.** The Dev IDE is where engine development happens. It is not a thin wrapper over CLIs — git, pipelines, and builds are first-class UI with full fidelity.
2. **Pipeline-as-code.** CI/CD stages are declared in a project file, versioned with the project, and runnable identically from the IDE or headless CLI. No click-only pipelines.
3. **Hermetic stages.** Each pipeline stage declares its inputs; same inputs → same outputs. Stages are cacheable and re-runnable independently.
4. **No lock-in to the IDE.** Everything the IDE does is also doable from the CLI (`engine` commands). The IDE is acceleration, not a cage. A dev who prefers a terminal loses nothing.
5. **Designers are not second-class.** The website authoring UIs (§10) write the same scripts and definitions the IDE edits. A designer's entity and a dev's system meet at the validated data boundary, never in conflict.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ Dev IDE (embedded in apps/editor)                        │
│                                                          │
│  Editor core    Terminal      Git panel     Pipeline     │
│  (Monaco,       (xterm.js)    (isomorphic-   runner       │
│   file tree,                   git)          (DAG)        │
│   search, tabs)                                              │
│                                                          │
│  WASM target    Services      Project       Scripting    │
│  (Assembly-     (dockerode →  system         layer        │
│   Script/asc)   Docker        (templates,    (spec §6:    │
│                  daemon)       manifests)    validate,   │
│                                             preview)     │
└─────────────────────────────────────────────────────────┘
        │                    │                   │
        ▼                    ▼                   ▼
   CLI parity          Docker daemon      Same data pipeline
   (engine cmds)       (or processes)     as website UIs
```

Every panel has a CLI equivalent. The IDE is a GUI over deterministic operations, not a separate implementation of them.

---

## 4. Editor Core

- **Monaco** (MIT): editing, with the TypeScript language service for IntelliSense, refactoring, and red squiggles.
- **File tree**: project-scoped, respects `.engineignore`. Multi-root (engine + game project side by side).
- **Search**: text search (ripgrep-backed) and symbol search across the project.
- **Terminal** (**xterm.js**, MIT): full PTY. Runs the project's toolchain. Multiple terminals, persistent across sessions.
- **Tasks**: named shell tasks (`engine tasks.json` equivalent) — "run world server", "tail bake logs" — one-click from the command palette.
- **Problems panel**: aggregated diagnostics from tsc, eslint, script validation, and pipeline stages. Click-to-navigate.

---

## 5. Version Control — The IDE Owns the Entire Git Lifecycle

The developer never thinks about git. Tracking is automatic, the full lifecycle is covered in the UI, confusing states are unreachable, and every state is recoverable. Git expertise is not a prerequisite for using the IDE.

**Library:** `isomorphic-git` (MIT, pure JS, no native deps) as the default backend — it works identically whether the editor runs as a desktop app or in a browser context. Where a git CLI is available and performance matters, `simple-git` may be used as an opt-in fast path; the UI never depends on which backend is active.

### 5.1 Zero-touch tracking

The IDE tracks everything without being asked:

- **Create** → file appears in the working copy, immediately tracked. Scripts additionally trigger branch-per-script (§13.1).
- **Save** → debounced auto-commit (2s) to the current branch with a generated message (`wip: <path>`). No staging, no "git add" — the concept of a staging area is not exposed in the UI. (The index exists underneath; the IDE manages it.)
- **Close / idle** → state persisted; unpushed commits are visible in the git panel as "waiting to sync," never as an error.
- **Push** → automatic after auto-commit (debounced 10s, batched). Manual push/pull buttons exist but are rarely needed; the panel shows sync state (in-sync, pushing, behind) as ambient status, not as tasks.
- **Fetch** → on push notification over the channel, with 30s poll fallback. Incoming changes become ghosts (§13.3) or fast-forward the branch — never a surprise.

Manual commit with a meaningful message remains available (command palette / git panel) for checkpoints the author wants named. Auto-commits squash at merge (§13.5), so WIP granularity never pollutes history.

### 5.2 Full lifecycle operations

Every git operation a developer needs is in the UI, with CLI parity (D1):

| Operation | UI surface |
|---|---|
| init / clone | Project templates init git; "clone project" flow with URL + auth |
| branch | Create, switch, rename, list (with ahead/behind, last activity, owner) |
| merge | Via the merge gate (§13.5) for scripts; guided merge for system code |
| rebase | Automatic on fetch when clean; manual with preview when not |
| tag | Lightweight + annotated tags for milestones/releases |
| stash ("shelve") | One-click shelve/unshelve for interrupted work (promoted to v1) |
| cherry-pick | Advanced operation, available with preview |
| log / history | Searchable history, per-file history, blame (with ghost attribution awareness) |
| diff | Inline + side-by-side, including branch-vs-branch and commit-vs-commit |
| .gitignore | Managed patterns UI; project templates ship sensible defaults |

Out of scope for v1 (explicit): `bisect` (debugger-adjacent, separate concern), submodules and worktrees (complexity without a proven need; revisit if multi-repo workflows emerge).

### 5.3 Confusing-state elimination

The classic git failure modes are unreachable from the UI:

- **Detached HEAD**: impossible. All checkouts go through named branches. If a detached state is detected (e.g. from external CLI use), the IDE offers one click: "create branch here" — never leaves the user stranded.
- **Diverged branches**: on fetch, if the local branch is behind and clean → auto fast-forward or rebase. If it would conflict → routes to ghost resolution (scripts, §13) or the visual merge tool (system code, §5.4). The user never sees "your branch has diverged" as a dead end.
- **Merge conflicts**: for scripts, prevented by the ghost workflow (§13.5). For system code, the residual cases open a 3-way visual merge tool (theirs/base/yours) with per-hunk accept — never raw conflict markers in the editor.
- **Accidental secret commit**: pre-commit scan for API keys, tokens, and private-key patterns. Blocks the commit with an explanation and a one-click "remove and recommit" fix. Secret patterns are configurable per project.
- **Oversized files**: warn above 10MB, block above 50MB with guidance (use the asset pipeline, not git). LFS is not adopted in v1 — the guidance is "don't put it in git."
- **Uncommitted work on branch switch**: the IDE shelves automatically (stash) and restores on return. Switching branches never loses work and never demands manual stashing.

### 5.4 Recovery — the time machine

Every auto-commit is recoverable. The IDE keeps a reflog-backed timeline per branch:

- "Time machine" view: every commit (including squashed-away WIP commits, retained 30 days) with diff preview and one-click restore-to-here (creates a recovery branch, never destroys current state).
- Accidental branch deletion: recoverable from the timeline within the retention window.
- Failed rebase/merge: one-click abort-and-restore to the pre-operation state. The IDE snapshots branch tips before every automated git mutation.

### 5.5 Safety rails

- No force-push from the UI. Ever. (CLI can, explicitly.)
- No destructive operation (hard reset, branch delete) without explicit typed confirmation — and even then, the pre-operation snapshot (§5.4) makes it reversible.
- Commit is always atomic and always includes the pipeline status at commit time (see §6).
- Script content never edits `main` directly — all script work flows through the stateful branch-per-script workflow (§13). The git panel surfaces workflow state (current branch, ghosts, collaborators) as the primary view, not raw git commands.
- Auth: uses the developer's existing credentials. The IDE never stores passwords; tokens live in the OS keychain via the existing credential flow, or are supplied per-operation. No credential material in project files, logs, or pipeline definitions.

---

## 6. Pipeline Runner (CI/CD)

The pipeline is declared in `engine.pipeline.ts` at the project root — TypeScript, typechecked, versioned with the project:

```ts
import { pipeline, stage } from '@engine/pipeline';

export default pipeline({
  name: 'dev',
  stages: [
    stage('typecheck', { run: 'tsc --noEmit', timeout: '2m' }),
    stage('lint',      { run: 'eslint . && engine scripts lint', dependsOn: ['typecheck'] }),
    stage('test',      { run: 'vitest run', dependsOn: ['lint'], timeout: '10m' }),
    stage('scripts:validate', { run: 'engine scripts validate', dependsOn: ['lint'] }),
    stage('build',     { run: 'engine build', dependsOn: ['test', 'scripts:validate'] }),
    stage('wasm',      { run: 'engine wasm build', dependsOn: ['build'], when: 'filesChanged("**/*.as.ts")' }),
    stage('bake:dry-run', { run: 'engine bake --dry-run', dependsOn: ['build', 'wasm'] }),
    stage('deploy:test-shard', { run: 'engine deploy --target test-shard', dependsOn: ['bake:dry-run'], manual: true }),
  ],
});
```

**Semantics:**

- **DAG execution** with `dependsOn`. Independent stages run in parallel. Failed stage fails the pipeline; downstream stages don't run.
- **Hermetic**: each stage declares inputs (file globs, env). The runner hashes inputs; unchanged inputs → cached outputs (content-addressed). Re-running a green pipeline is instant.
- **`when` conditions**: skip stages whose inputs didn't change (e.g. no `.as.ts` changes → skip WASM).
- **`manual` stages**: require explicit approval in the UI (deploy is manual by default).
- **Triggers**: on demand (button/palette), on commit (opt-in per project), on schedule (nightly bake soak).
- **Remote CI**: `engine pipeline trigger --remote` pushes via git and triggers GitHub Actions (or equivalent) using the same `engine.pipeline.ts` — one definition, local or remote.
- **Artifacts**: each stage may emit artifacts (bundles, `.wasm`, bake reports) — browsable in the UI, downloadable, retained per project policy.
- **Logs**: streaming, per-stage, persisted with the pipeline run. Failures link directly to the failing file/line.

---

## 7. WASM Compilation Target

**Language:** **AssemblyScript** (Apache 2.0) — a strict TypeScript dialect compiling to WASM via Binaryen. Devs already write TS; the dialect's restrictions (static types, no `any`/`undefined`) are the price of ahead-of-time compilation.

**Project convention:**

- `src/wasm/**/*.as.ts` — AssemblyScript sources.
- `engine wasm build` runs `asc` → emits `.wasm` + TypeScript bindings into `build/wasm/`.
- Modules load via `WebAssembly` in Node (bake workers, tools) and can ship to clients.

**Determinism discipline** (same as the sim-lab's wasm32 builds):

- WASM modules used in simulation or bake paths must satisfy the bit-identical contract: exact FP semantics, no platform-dependent intrinsics.
- `engine wasm golden` runs the module against checked input/output vectors; CI fails on divergence.
- The IDE surfaces determinism violations at compile time where the toolchain can detect them (e.g. flagged intrinsics), and the golden suite catches the rest.

**Use cases:** hot-path math (noise fields, pathfinding kernels, suitability scoring), portable bake kernels, client-side prediction helpers. Not a replacement for the C++ N-API addons — the native path remains for tick-hot code where profiling justifies it.

---

## 8. Container Orchestration

**Mechanism:** `dockerode` (Docker daemon API client). The IDE orchestrates containers on the developer's machine through the local Docker daemon — it does not embed a container runtime.

**Project convention:** `engine.services.yml` declares services:

```yaml
services:
  world-server:
    build: ./services/world-server
    ports: ["7777:7777"]
    dependsOn: [db]
  db:
    image: sqlite-sidecar:latest  # example; actual services per project
```

**IDE surface:** service list with status, one-click start/stop/restart, streaming logs per service, `exec` into a running container (terminal), rebuild on source change (opt-in watch).

**Graceful degradation:** if no Docker daemon is reachable, services fall back to local processes (`engine services up --no-docker`). The UI shows which mode is active. Containerization is an accelerator for local multi-service testing, not a requirement.

---

## 9. Project System

- **Project manifest** (`engine.project.json`): name, kind (`engine` | `game`), script-api version, pipeline file, service file, WASM targets.
- **Templates**: `engine new game`, `engine new system`, `engine new service` — scaffolded projects with working pipeline, git init, and example scripts.
- **Multi-root**: open the engine and a game project side by side; the pipeline runner is per-root, the git panel handles multiple repos.
- **`.engineignore`**: what the file tree, search, and pipeline input-hashing skip (node_modules, build output, local secrets).

---

## 10. Integration with Designer Website UIs

Designers do not use the Dev IDE. They use website authoring UIs (entity builder, component builder, species designer, etc.). The contract:

- Website UIs read and write the **same script files** the IDE edits (`scripts/...` in the project).
- The **same validation pipeline** runs on website submissions as on IDE saves (§6 `scripts:validate`).
- The **round-trip guarantee** from the scripting spec (§11) holds across the boundary: a designer authors an entity on the website → the IDE shows the generated script → a dev refactors nearby systems → the website still loads the entity.
- **Conflict policy**: website UIs operate on definitions; the IDE operates on files. If a designer saves a definition while a dev has uncommitted edits to the same script file, the website path goes through the same merge semantics as any other edit — last-writer-wins at the definition level with a visible conflict record, never silent overwrite.
- Devs can open any designer-authored script read-only in the IDE for inspection; editing a designer-owned script as a dev requires taking ownership explicitly (recorded in git history).

---

## 11. Security Model

The Dev IDE runs as the developer — full trust, local machine. The trust boundary that matters:

- **Player/mod scripts never execute in the Dev IDE's pipeline with dev privileges.** Mods are validated through the player-tier sandbox (scripting spec §7, §13) even when a dev previews them locally.
- **Pipeline stages run project code** (tests, builds) — this is normal dev-tool behavior, equivalent to running `npm test`. The IDE does not sandbox the dev's own project code from the dev.
- **Remote operations** (push, remote CI triggers) use the credential flow from §5. No tokens in logs, project files, or pipeline definitions.

---

## 12. Invariants

Numbered, testable, non-negotiable — extending the scripting spec's I1–I7:

- **D1 — CLI parity.** Every IDE operation (git, pipeline, build, deploy) has an equivalent `engine` CLI command producing identical results. Tested by running IDE-driven and CLI-driven pipelines on the same fixture and diffing artifacts.
- **D2 — Hermetic pipelines.** Same stage inputs → same stage outputs, byte-identical. Tested by cache-hit verification in CI.
- **D3 — No destructive git from the UI.** Force-push, hard reset, and branch deletion are unavailable in the IDE UI. Tested by asserting the UI action registry.
- **D4 — Offline-capable.** All local operations (edit, commit, pipeline, build, WASM compile, bake dry-run) work with no network. Only push/pull and remote CI triggers require connectivity. Tested by running the suite with networking disabled.
- **D5 — Single definition pipeline.** Website designer UIs and the Dev IDE produce definitions through the same validation path. No forked formats, no UI-only fields. Tested by round-tripping a definition through both frontends.
- **D6 — Deterministic WASM.** WASM modules in sim/bake paths pass golden bit-identical tests on every pipeline run. Tested by the golden suite (§7).
- **D7 — No surprise merges.** A script branch merges to `main` only with zero unresolved ghost regions and a clean rebase onto `main`. Tested by attempting merges with injected overlapping ghosts and asserting the gate refuses.
- **D8 — No unrecoverable state from the UI.** Every git mutation the IDE performs is reversible: pre-operation snapshots, 30-day WIP retention, one-click abort-and-restore. There is no sequence of UI actions that loses committed work. Tested by fault-injection (random operation sequences, asserting recovery always succeeds).

---

## 13. Stateful Git Workflow (Ghost Sync)

Git is not a tool the developer invokes — it is the substrate the IDE lives in. The IDE maintains continuous VCS state (current branch, ahead/behind, who is editing what, unresolved ghost regions) and all implementation flows through the workflow. There is no path that bypasses it.

### 13.1 Branch-per-script

- Creating a script (in the IDE or via a website authoring UI) automatically creates a divergent branch off `main`: `scripts/<author-id>/<slug>`.
- All edits to that script happen on its branch. `main` is never edited directly for script content — it only receives merges.
- Blast radius is minimal by construction: one script, one branch, one author (plus explicit collaborators).

### 13.2 Presence

- The IDE publishes presence over the internal channel (`packages/channel`): `{ authorId, authorName, color, branch, file, cursorRange, timestamp }`, heartbeat every 5s, expiry after 15s silence.
- The IDE subscribes to presence for the files currently open. Collaborators' cursors render as named flags in the editor gutter/margin (Monaco decorations).
- Designers working through website UIs are presence participants on equal footing — their activity appears in dev IDEs and vice versa.

### 13.3 Ghost code

When another author commits changes to a file you have open (on their script branch), their hunks appear in your buffer as **ghost code**:

- Rendered as inline ghost decorations (Monaco): visually distinct (faded, author-colored left border), attributed with author name/ID on hover, timestamped, branch-labeled.
- **Ghosts never modify your buffer.** They are a decoration layer over your working copy. Your file is never overwritten, never auto-merged under you.
- Ghost hunks are computed as the diff between the author's latest pushed commit on their branch and the merge-base with your branch, filtered to the open file.
- Sync transport: on save (2s debounce), the IDE auto-commits to the script branch (`wip: <file>` — squashed at merge, §13.5) and pushes to the shared remote. Other IDEs fetch on push notification (channel event) or 30s poll fallback, then recompute ghosts.

Ghost region states:

| State | Meaning | Rendering |
|---|---|---|
| `informational` | Hunk touches lines you haven't edited | Faded ghost, author color |
| `overlapping` | Hunk touches lines you have edited | Strong highlight, both authors notified immediately |
| `accepted` | You applied the hunk to your buffer | Ghost clears; your edit carries `Co-authored-by` attribution |
| `rejected` | You dismissed the hunk with a reason | Ghost clears; rejection recorded on the branch |
| `deferred` | Acknowledged, to be resolved later | Ghost minimizes to a gutter marker with reason |

Accepting a ghost applies the hunk as your edit — git blame then shows the original author via the `Co-authored-by` trailer, preserving true authorship through the squash.

### 13.4 Coordination

- Both parties are notified on `overlapping` ghosts (IDE notification + presence event). The notification links directly to the overlapping region in both editors.
- Either author can accept, reject, or defer. No lock, no blocking — but an `overlapping` ghost that remains unresolved blocks the merge gate (§13.5), so coordination has a forcing function without ever freezing anyone's editor.
- Ghost history is per-branch and auditable: who proposed what, who accepted/rejected/deferred, when.

### 13.5 The merge gate (implementation gated behind the workflow)

A script branch merges to `main` only when all of the following hold:

1. The branch pipeline is green (all §6 stages pass on the branch head).
2. The branch is rebased onto current `main` cleanly (auto-rebase; if the rebase itself conflicts, the branch bounces back to ghost resolution — this is the residual case the live ghosts didn't catch).
3. **Zero unresolved ghost regions** — every ghost is `accepted`, `rejected`, or `deferred`-with-reason. Unresolved `informational` or `overlapping` ghosts block the merge.
4. Script validation passes (scripting spec §9 — the data is valid, not just conflict-free).

Merge is a squash onto `main` with a generated message (`scripts(<slug>): <summary>`) and `Co-authored-by` trailers for every author whose ghost hunks were accepted. The WIP commit history stays on the branch for audit.

**On "merge conflicts never exist":** the workflow guarantees no *surprise* conflicts at merge time. Every textual overlap between collaborators is surfaced as an attributed ghost region during editing — while it's small, fresh, and both authors are present — and the gate refuses to merge until each is resolved. What remains possible is the pathological case (two authors simultaneously accepting overlapping ghosts in opposite ways between syncs); the gate's rebase check (step 2) catches it and returns the branch to ghost resolution. Conflicts become a 30-second coordination event, not a merge-day excavation.

### 13.6 File watching

- Local: `chokidar` watches the working copy; every save feeds the debounce → auto-commit → push cycle.
- Remote: push notifications over the channel trigger fetch + ghost recompute; poll fallback every 30s.
- The IDE's git state panel always shows: current branch, ahead/behind vs `main`, open ghost regions by file, collaborators present.

## 14. Explicitly Out of Scope (v1)
- **Remote pair editing / collaboration**: multi-user editing sessions in the IDE. Git is the collaboration mechanism for v1.
- **Visual debugging of the tick loop**: breakpoints in simulation code. The tick is native/Node; this needs a separate debugger integration design.
- **Plugin system for the IDE itself**: third-party IDE extensions. The IDE's own extensibility API is a later spec.
- **Mobile IDE**: the Dev IDE targets desktop. Designers' website UIs are responsive; the IDE is not.
- **Cloud dev environments**: browser-hosted ephemeral dev machines. The architecture doesn't preclude it (isomorphic-git + hermetic pipelines are the prerequisites), but it's not v1.

---

## 15. Implementation Phases

- **Phase 1 — Editor core**: Monaco, file tree, search, xterm.js terminal, tasks, problems panel, project system (§4, §9). CLI parity harness (D1) established from day one.
- **Phase 2 — Version control + Ghost Sync**: isomorphic-git integration; zero-touch tracking (§5.1); full lifecycle UI (§5.2); confusing-state elimination (§5.3); time-machine recovery (D8 tested); safety rails incl. secret scanning (§5.5); branch-per-script automation, presence over `packages/channel`, ghost rendering and resolution UI, merge gate (§13, D7 tested).
- **Phase 3 — Pipeline runner**: `engine.pipeline.ts` format, DAG execution, hermetic caching, triggers, artifacts, remote CI trigger. Default `dev` pipeline per §6.
- **Phase 4 — WASM target**: AssemblyScript toolchain integration, `*.as.ts` convention, golden determinism suite (D6).
- **Phase 5 — Services**: dockerode integration, `engine.services.yml`, process fallback.
- **Phase 6 — Website bridge**: designer UI integration contract (§10), conflict policy, ownership semantics (D5 tested).

Each phase holds all invariants from §12 that apply to it; a phase is not done until its invariant tests are green. Phases 1–3 are the minimal viable Dev IDE; 4–6 extend it.
