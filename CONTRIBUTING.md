# Contributing

How to change this repository without breaking it. Read
[ARCHITECTURE.md](docs/ARCHITECTURE.md) first if you are new to the code —
it explains what the pieces are and which way the data flows.

---

## 1. Prerequisites

Same as a player: Node.js 22 or newer (CI runs 24), a C++17 compiler, Python
3, and bash. The full table, with per-platform instructions, is in
[GETTING-STARTED.md](docs/GETTING-STARTED.md#1-prerequisites).

Two gotchas cost real time, so they are repeated here:

- **`flatc` must be on your `PATH`.** `npm run codegen` is a bash script that
  prefers the vendored `third_party/flatc/flatc`, but that binary is a Linux
  x86_64 build. On Windows and macOS it is not executable, so a system
  `flatc` 25.x is what actually gets used. Verify with `flatc --version`.
- **Use Git Bash on Windows, not WSL's `bash`.** If `bash` resolves to
  `C:\WINDOWS\system32\bash.exe`, codegen fails with
  `set: pipefail: invalid option name`. Either put
  `C:\Program Files\Git\bin` ahead of it on `PATH`, or run the commands from
  a Git Bash terminal.

## 2. Set up

```bash
npm install        # workspaces + compiles the native addons (slow the first time)
npm run codegen    # packages/schema/mmo_engine.fbs -> generated C++ and TS
npm test           # the whole suite; must be green before you start
```

`npm test` is the gate for everything below. It builds every package first,
so it also catches type errors.

## 3. The branch workflow

All work happens on a short-lived branch cut from an up-to-date `main`.
`main` only changes by merging a finished branch, and a merged branch is
deleted so nobody keeps building on it.

```bash
git checkout main
git pull NexusMMORepo main
git checkout -b feat/<short-name>     # fix/<short-name> for bug fixes
```

The GitHub remote is named **`NexusMMORepo`**, not `origin`.

One feature per branch. Never resume an old branch, even one with a similar
name — if `main` has moved, `git merge main` **into your branch** and resolve
conflicts there, never on `main`.

When the work is done:

```bash
git push -u NexusMMORepo feat/<short-name>
```

Merge it with a pull request on GitHub (this keeps the "Merge pull request
#N" history). Afterwards:

```bash
git checkout main
git pull NexusMMORepo main
git branch -d feat/<short-name>
git push NexusMMORepo --delete feat/<short-name>
git fetch --prune NexusMMORepo
```

Only `main` should be left, locally and on GitHub.

## 4. What "done" means

A change is finished when all three hold:

1. **`npm test` passes for every workspace it touches.** Run the whole suite
   if you are unsure — it is a few minutes.
2. **It builds**: `npm run build`, plus the browser bundle
   (`npm run build --workspace=@mmo-engine/client`, or
   `npm run editor:build`) if you touched a browser app. Note that the
   production client bundle has no root script — that is a gap, not an
   oversight on your part.
3. **It has been played**, if it changes what players see or do. Start the
   server and client per [GETTING-STARTED.md](docs/GETTING-STARTED.md) and
   look at it. Tests do not catch a bad camera or an invisible mesh.

### Tests

Tests are `node:test` suites, colocated in each package's `test/` directory
and compiled by `tsc` before they run. There is no test framework to learn
and no configuration to edit.

Match the existing style, which is unusually specific to this codebase:

- **Test the property, not the implementation.** `"adjacent chunks share
  border samples bit-for-bit"` is a good test name; `"generateChunk works"`
  is not.
- **Pin determinism with golden vectors.** Where output must be reproducible
  across languages or runs, commit the exact expected value (a hash, a
  fingerprint, a first record) and assert against it.
- **Name the failure you are preventing.** Several suites encode a
  regression directly (an ABA slot-reuse test, a seam test, a "stale row is
  ignored after restart" test). Do the same: when you fix a bug, add the
  test that would have caught it.
- **Native code needs its own determinism test.** Addons are tested from
  Node against the built `.node` binary, and anything numeric should prove
  the same inputs give identical bytes across fresh processes.

### Changing the wire contract

`packages/schema/mmo_engine.fbs` is the single source of truth for the C++ ↔
JS contract. If you touch it:

1. Edit **only** the `.fbs`. Make additive changes (new tables or fields)
   and **never reuse a field id**.
2. Run `npm run codegen`.
3. Keep the C++ ↔ JS round-trip green — both sides must read the same bytes
   field-for-field.

Generated bindings are gitignored and never hand-edited. CI regenerates them
twice and diffs the result, so a hand-edit or a non-reproducible generator
will fail the build.

Protocol message ids and their envelopes are catalogued in
[MESSAGE-CATALOG.md](docs/MESSAGE-CATALOG.md); a new message means a new
entry there.

### Changing rules or content

Game rules are data, not code: `content/rules/*.json`, validated at boot by
`@mmo-engine/rules`. A bad rules file stops the server before the world
loads and names every problem by file and field, so the feedback loop is
fast. Prefer changing a rules file over adding a branch in the engine.

## 5. Code standards

- **TypeScript, `strict: true`, no exceptions.** Every package compiles with
  `strict`. Do not add `any` or `@ts-ignore` to get past a type error; there
  are only a handful in the whole codebase and each is deliberate.
- **No linter is configured yet.** Match the surrounding file: two-space
  indent, double quotes, semicolons, trailing commas in multiline literals.
  Keep lines readable rather than short.
- **Comment the "why", not the "what".** The existing comments explain
  decisions, invariants and physical units. A comment that restates the code
  is noise; a comment that says *why* a diagonal was chosen or *why* a
  constant is 12000 bytes is the house style.
- **Units and frames go in names or comments.** Say `metres`, `seconds`,
  `ticks`, or `world-space` rather than leaving a reader to guess.
- **Do not add a dependency lightly.** This repo vendors its C++ libraries
  and deliberately avoids frameworks (no linting framework, no test
  framework, no state library). Anything added to the root `package.json`
  has to earn its place — and if it turns out to be unused, remove it.

## 6. CI

`.github/workflows/ci.yml` runs on every push and pull request, on
`ubuntu-latest` with Node 24:

1. `npm ci`
2. `npm run codegen`
3. **Codegen reproducibility** — generate into a second directory and
   `diff -r` it against the first. Drift means the bindings cannot be
   rebuilt from the `.fbs`.
4. `npm test`

Note what CI does **not** cover: it does not lint, and it does not build the
browser clients' production bundles. A change that only breaks
`npm run client:build` can pass CI. Build the apps yourself when you touch
them.

CI runs on Linux. Windows-specific behaviour (the native addon builds, the
POSIX-mode tests that skip themselves, the `flatc` situation above) is on you
to verify locally.

## 7. Things that must never be committed

This is the one hard rule. The licensed art lives in the gitignored
`assets/` folder — Synty packs, the Kevin Iglesias and other animation packs,
and any render of them. **It is confidential and must never reach GitHub.**

Before pushing, run:

```bash
git log --name-only --format= NexusMMORepo/main..HEAD | sort -u \
  | grep -iE '^(assets|patches|data)/|\.(zip|fbx|glb|gltf|png|jpg|tga|psd|unitypackage)$'
```

**This must print nothing.** The same applies to `data/` (world databases,
account records), `patches/` (archives that can bundle the art), and
`prebuilds/`. See [.gitignore](.gitignore) — it is commented, and the
anchoring choices there are deliberate.

Secrets follow the same rule: passwords come from the environment only,
never from a command-line argument, and are never printed or logged. See
[CONFIGURATION.md](docs/CONFIGURATION.md#accounts-from-the-command-line).

## 8. Where to go next

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the engine fits together.
- [GAMEPLAY.md](docs/GAMEPLAY.md) — movement, combat, bots, and how to extend them.
- [WORLD-BUILDING.md](docs/WORLD-BUILDING.md) — world specs, scenery and terrain edits.
- [ART-PIPELINE.md](docs/ART-PIPELINE.md) — the art packs and the conversion tools.
- [DECISIONS.md](docs/DECISIONS.md) — why the engine is built the way it is.
