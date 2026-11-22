# Building a game on this engine

This is the opinionated guide. [What the engine can do](CAPABILITIES.md) tells you
what exists; this tells you how to use it well, in what order, and which
roads are dead ends.

One principle underlies everything below:

> **Change the cheapest layer that can express what you want.** Data before
> rules, rules before a module, a module before native code, and native code
> before editing the engine. Every step down costs more to write, more to
> maintain, and more when you take an upstream change.

---

## 1. Know what is yours and what is the engine's

The repository is mid-way through separating a general-purpose engine from
the game built on it. Understanding the line as it stands now will save you
from building against something that is about to move.

**Today:**

| Layer | Where | Yours to change? |
|---|---|---|
| Engine core | `packages/engine-core` | No. Changing it means maintaining a fork. |
| Supporting packages | `packages/*` (rules, protocol, mirror, dungeon, settlement, …) | Mostly no; you consume them. |
| Modules | `modules/<name>/` | **Yes.** This is the code seam. |
| Content | `content/` | **Yes.** This is the data seam, and it is the sample game's content. |
| Client and editor | `apps/client`, `apps/editor` | Yes, as your game's front end. |

**Where it is going:** the person steering this project has settled the
shape — an engine core plus *official, swappable kits*, with several forkable
starting points (a bare one, and themed ones such as survival and sandbox)
rather than one blessed template. Kits are meant to be forked and edited, not
only configured. Package names and the manifest format for that are a
proposal under review, not settled, so this page deliberately describes the
seams by what they do rather than by names that will change.

**What that means for you now:** put your game in `content/` and
`modules/`, and keep a clean list of every place you had to edit something
under `packages/`. Those edits are the ones that will need revisiting, and
they are also the most useful bug reports this project can get.

Known places the seam still leaks, so you can plan around them:

- Modules reach into engine internals by deep path (`modules/combat/server.js`
  imports from `packages/engine-core/dist/...`).
- The server hardcodes the set of modules it wires up and the config it hands
  each one.
- A game is partly defined by around thirty `MMO_*` environment variables and
  by repository layout, not by one manifest.
- The skill contract hard-requires a specific list of named skills.
- Some content names are baked into engine schemas (the wildlife table names
  particular creature types).

---

## 2. Start from data

Most of what a designer calls "the game" is a number in a JSON file under
`content/`, validated by a Zod schema and loaded at boot.

```
content/rules/      combat, movement, body, death, skills, stats, spells,
                    items, loot, gathering, needs, creatures, social,
                    appearance, disciplines, interest, ingress
content/species/    creature ecology and spawn tables
content/quests/     quests and dialogue
content/strings/    user-visible text
content/pcg/        procedural asset graphs
content/scenes/     baked scene documents
content/modules.json  which modules are enabled
```

Rules reload while the server runs (the `reloader` system), so the loop here
is seconds, not a restart. Everything is schema-validated: a bad value fails
loudly at load rather than producing a strange game.

**Do this first, always.** Before you write a system to make combat feel
different, read `content/rules/combat.json` and find out whether the curve
you want is already a parameter. Most of the time it is.

The editor exposes much of this as grids and tables, so a designer can tune
without a text editor or a Git client. See [The editor](EDITOR.md).

## 3. Then rules hooks

`packages/rules` defines eight hooks where a game can override a formula
without replacing the system that calls it:

`computeDamage`, `resolveLanding`, `resolveDefence`, `resolveTreatment`,
`skillGain`, `onInjury`, `onDeath`, `onRespawn`

Each receives the input and the engine's own implementation, so you can wrap
rather than reimplement:

```ts
const overrides: HookOverrides = {
  computeDamage: (input, base) => {
    const result = base(input);
    return input.attacker.isBoss ? { ...result, amount: result.amount * 1.5 } : result;
  },
};
```

> **Gap, as of this writing.** `loadGameRules(dir, overrides)` accepts these,
> but the running server calls it without an overrides argument
> (`packages/engine-core/src/server.ts`), and the rules reloader does the
> same. **The hooks are therefore unreachable from a booted server today.**
> They work in tests and in code that calls `loadGameRules` directly. If you
> need them live, that wiring is a small, well-scoped contribution.

## 4. Then a module

Everything the engine does beyond its tick loop is a module: a folder
`modules/<name>/` with a `module.json`. Server systems, editor panels, native
code, sidecar processes, edge services and build-time tools all arrive the
same way.

A server module is a manifest and an entry exporting `createSystems(ctx)`:

```js
export function createSystems(ctx) {
  return {
    "my-system": {
      name: "my-system",
      step(sim, dt) { /* runs once per tick */ },
    },
  };
}
```

You declare where your system sits in the tick with `after` and `before`, and
the server resolves one order at boot. **Any ordering problem stops the boot
and names itself** — an unknown system id, a cycle, a dependency that is
installed but not enabled, a declared system the entry did not return. The
engine would rather refuse to start than run half a game. Build on that: make
your module fail at boot rather than degrade at runtime.

[Modules](MODULES.md) is the full contract, including native, sidecar,
edge, tools and database modules.

### Directives for module authors

- **One module, one domain.** Combat, economy, residents. If you cannot name
  the domain in one word, it is two modules.
- **Put tunables in `content/rules/`, not in your module's code.** A number
  compiled into a system is a number a designer cannot reach.
- **Publish stores you own through `ctx.stores`.** That is how the server
  wires your domain to the gateway.
- **Tolerate a missing `ctx.config`.** It is optional, and a module that
  crashes without it cannot be reused.
- **Export `dispose(ctx)`** if you hold anything. Modules are disposed in
  reverse dependency order at shutdown, and play mode in the editor restarts
  the server constantly.
- **Mark a system `optional: true`** if it may legitimately not be built
  (no bots, no navigation backend). Otherwise a missing system is a boot
  failure, which is usually what you want.

## 5. Native code, last

Write C++ when you have measured that you need to, not before. The path is
documented and the toolchain is already in place: copy `packages/addons/template`,
declare a `native` entry in your module manifest, and the server loads your
`.node` and calls its `createSystems`.

The rule that makes native addons fast here is non-negotiable:

> **Never cross the N-API boundary per object.** Do not inspect individual
> JavaScript object properties inside a simulation loop. Pass a contiguous
> `SharedArrayBuffer` or typed-array view across once per tick and work on
> raw pointers.

Breaking that rule produces a native addon slower than the JavaScript it
replaced, which is the single most common way this goes wrong.

A native change must pass `npm run valgrind:memcheck -- <addon>` clean, and a
change to the tick or a hot path must run `npm run valgrind:perf` and report
what moved.

---

## 6. Design for the tick budget

You have **33.3 ms per tick at 30 Hz**, and the network already wants a large
share of it at high player counts.

- **Spread heavy work across ticks.** Nothing that takes more than a few
  milliseconds should run every tick for every entity. Budget it, slice it,
  and let it finish over several ticks.
- **Bake it instead.** Terrain, settlements, dungeons, loot pools, navmeshes,
  scatter: all of it is computed before the server starts. If you are
  generating something at runtime, ask first whether it could have been baked.
- **Allocation is the hidden cost.** One garbage-collection leak in this
  engine produced 200–400 ms tick stalls. Game logic runs on one main thread
  per region; treat per-tick allocation as a bug.
- **Measure with instruction counts, not wall time.** `npm run valgrind:perf`
  gives counts that are repeatable run to run and independent of machine
  speed, which is what you want for a regression gate. Wall-clock numbers
  from shared hardware will lie to you.

## 7. Design for interest management

The world is in 64 m sectors and clients only receive the sectors near them.
This shapes what is cheap:

- **Entities that move every tick are the expensive ones.** Five thousand
  entities standing in a town cost roughly five times the bandwidth of the
  same five thousand spread out.
- **Mark genuinely distant things far-visible** rather than making everything
  globally visible. There is a `farM` rule (400 m) for landmarks.
- **Things with no position live in a global sector** that every client
  receives. Keep that set small.
- **Bursts are what breaks the budget**, not steady state. A hundred items
  dropping at once pushed a 5,000-entity p99 from the low 40s into the 60s of
  milliseconds. Rate-limit your own events.

## 8. Design for regions

A region boundary is a consistency boundary. Scale comes from adding regions
(about four per core), not from one big one.

- Cross-region state is eventually consistent — friends and presence sync on
  the order of every 30 seconds.
- Hand-offs are cheap (p50 around 5 ms) and were never refused under stress,
  but they have a 10-second commit timeout; an operation that straddles a
  border needs to tolerate that.
- The world server owns the durable record. Do not treat a region's SQLite
  file as the truth for anything cross-region.

## 9. Keep the client honest

No game logic in the browser. The client predicts only the local player's
walk and reconciles; everything else is interpolated from authoritative
state. Cosmetic physics (corpse ragdolls, debris) is fine precisely because
nobody else can see its result.

The corollary is about tooling: **developer tools belong in the editor, not
in the player client.** Debug overlays, performance graphs and inspectors go
in the editor's debug workspace and its play mode. See
[The client](CLIENT.md).

## 10. Own your content pipeline early

- The art contract is a manifest (`packages/art`), so your models and
  animations arrive the same way whatever pack they came from.
- The engine generates its own scenery through PICG graphs, so you can build
  and test a whole world with no art at all. Use that: it keeps your game
  runnable for contributors who do not have your asset licences.
- Keep licensed art out of the repository. Here, `/assets/` is confidential
  and git-ignored, served only over loopback in development.
- `npm run bake:all` is the whole chain. Make it part of your build, not
  something a person remembers to run.

---

## A working order for a new game

1. `npm start`, play the sample world, read [Architecture](ARCHITECTURE.md).
2. Write your own world spec and `npm run preview:world` until the map is the
   shape you want. Bake it.
3. Turn off the modules you do not want in `content/modules.json`. Boot. Fix
   what refuses to start — this tells you exactly what the engine assumes.
4. Retune `content/rules/` until the shipped systems feel like your game.
5. Replace the systems that are still wrong with your own modules, one domain
   at a time.
6. Only now consider native code, and only against a benchmark.
7. Keep a list of every `packages/` edit you were forced to make.

## Reading list, in order

| Doc | Why |
|---|---|
| [Getting started](GETTING-STARTED.md) | Get it running |
| [Architecture](ARCHITECTURE.md) | The tick, the ECS, replication, persistence |
| [Modules](MODULES.md) | The extension contract in full |
| [Configuration](CONFIGURATION.md) | Every environment variable and data file |
| [Performance and constraints](PERFORMANCE.md) | What you can afford |
| [Operations](OPERATIONS.md) | Running it for real |
| [Message catalog](MESSAGE-CATALOG.md) | The wire, if you add messages |
