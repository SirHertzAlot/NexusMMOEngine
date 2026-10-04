# MMO Engine — Editor

The editor is the Rogue Engine Editor customization for this project: a
**standalone companion app** (`apps/editor/`, Vite + React + Tailwind)
with three inspectors, each owning its own tab:

1. **ECS Inspector** — read-only entity/component browser over a live
   mirror connection.
2. **Play Mode** — launches one owned local authoritative server,
   connects a client, and drives debug overlays (navmesh tiles, path
   waypoints).
3. **Art Asset Pipeline** — scans and validates an art pack, loads it in
   the browser with per-asset placeholder fallback.

It is standalone on purpose: Rogue Engine exposes no stable public API
for custom dockable editor panels, so building on private editor
internals would break on the next Rogue update. The scene-side half of
the integration is the public-API package
`rogue-packages/sirhertzalot/mmo-editor/` (see its README). The two meet
over a `BroadcastChannel` (`"mmo-editor-bridge"`) — no shared code with
the Rogue editor, nothing to break on upgrade.

## Launch

```bash
npm run editor          # vite dev server (default http://localhost:5174)
npm run editor:build    # production build of the companion
npm run editor:test     # editor unit tests (view-models, play-mode controller)
```

The dev server also hosts the **dev-only** play-mode control API
(`apps/editor/src/host.ts`), used by the Play Mode tab:

- `POST /api/editor/server/start` → spawns the owned server, returns
  `{ ok, pid, port, url, username, password }`
- `POST /api/editor/server/stop` → stops it, returns `{ ok, stopped }`
- `GET /api/editor/server/status` → `{ running, pid?, port? }`
- `GET /api/editor/assets` → scans the repo `assets/` pack
- `/assets/*` → serves pack files (path-guarded, no traversal)

These routes exist only under `vite dev`. They are localhost-only
tooling, never production surface.

## 1. ECS Inspector (read-only)

Open the **ECS Inspector** tab, enter the server URL
(`ws://127.0.0.1:7777` when play mode runs it) plus credentials, and
connect. You get:

- Live tick + entity count.
- Entity list with **search** (wire-id substring) and **component
  filter** (entity must carry ALL selected components).
- Per-entity component detail with three-decimal number formatting.

**Why read-only.** The inspector's view-model
(`src/inspectors/ecs.ts`) exposes no mutation APIs and the panel shows
an explicit notice: direct edits would bypass validation, ownership,
event ordering, and the authoritative simulation. The server stays
authoritative — the editor inspects mirror state and may send the same
intents a game client sends, but it never writes ECS state directly.

## 2. Play Mode

The **Play Mode** tab drives a full local loop:

1. **Start** — the dev host spawns exactly one `npm run server`
   (30 Hz authoritative sim: Intent/Integrate + Jolt physics + Recast
   navigation, procgen chunk, SQLite persistence).
2. **Seed** — before the server boots, the host seeds a one-session dev
   user (`editor-<rand>`) with a random 256-bit password into the
   server's data dir (`<repo>/data`, via `MMO_DATA_DIR`; only the
   argon2id hash is stored, the plaintext is never logged or persisted).
   Seeding happens first because the gateway's credential store loads
   the CSV once at startup.
3. **Connect** — the companion logs in with those credentials and shows
   live tick, entity count, and the debug overlays:
   - **Navmesh tiles** — bounds of tiles actually loaded into the nav
     backend (protocol v3 `0x0a` `tiles` query).
   - **Waypoints** — per-entity path status (`active`/`idle`/`failed`/
     `unknown`) and live waypoint list (`0x0a` `waypoints` query).
   - **Game view** (ROADMAP E4) — the world drawn by the game client's
     own renderer (`WorldCanvas`, imported from `apps/client/src/render`
     through `@mmo-engine/client/render`: a Vite alias to the source, and
     tsconfig paths to the built client's types), on the same mirror
     client the overlays query. Click the view to steer the avatar with
     the default bindings (Esc frees the mouse); fps, tick, entities,
     position, time of day and weather show under it. The view loads on
     first use, so the other tabs never download the renderer. Terrain
     surfaces come from the client's `public/` folder (the editor's
     `publicDir`), when fetched.
   - **Debugger** (ROADMAP E5) — the developer client's own dockable
     panels (`DevHud`, `PerfHud`, `AdminConsole`, through
     `@mmo-engine/client/debug`) drawn over the game view: drag a panel
     by its title, resize it from its corner, fade, fold or close it; the
     "dev" menu reopens panels or resets the layout, and ` hides them all.
     *status* (tick, time, weather, fps, entities, position, movement,
     the GPU, a warning on software rendering), *performance* (the last
     minute of fps, frame time, draw calls and triangles over every pass,
     props by level of detail, GPU memory, network in and out, JS heap),
     *tools* (wireframe terrain, quality preset, FX showcase, maximize the
     view to the window — Esc restores it — and the admin console) and
     *controls* (the key bindings). The panels sit inside the view and
     follow its size; the layout is kept per browser. The play server
     lists the editor's play user in `MMO_ADMINS`, so the admin console
     works on the server the editor owns.
   - **Selection card** (ROADMAP E6, PICG slice 3) — the debugger's
     *selection* panel: left-click an entity in the game view (or "my
     avatar") and it lists every component the mirror holds for it, field
     by field. When its AssetRef names a PICG library asset
     (`content/pcg/index.json`), the card adds the asset: its graph, which
     cooked shape the entity's variant picks and that shape's seed (the
     server cook's own mapping), and the graph's exposed parameters with
     their values, ranges and an ● where the asset overrides the graph
     default. The view-model is `src/inspectors/selection.ts` (pure TS);
     the library comes from `GET /api/editor/pcg/library` (`src/pcg-host.ts`,
     read-only, confined to `content/pcg`).
4. **Stop** — disconnects the client, kills the owned server process
   group, and restores the pre-play editor state (form fields, auto-
   refresh, entity selection).

**Ownership & cleanup.** The host spawns the server `detached` (its own
process group: `npm → sh → node`) and stops it with a group kill
(negative pid) — killing only the npm wrapper would orphan the real
server. The host tracks the child handle immediately after spawn so a
startup timeout can still kill it; readiness watches stdout for the
listen line (60 s budget) and surfaces the server's own fatal output on
failure. Stop is best-effort across every step (client disconnect, group
SIGTERM → SIGKILL after 5 s, state restore) so one failing step never
skips the rest. Only the process the host launched is ever signaled —
nothing is killed by port. If the dev server itself exits, its exit hook
kills the owned group.

## 3. Art Asset Pipeline

Folder convention (repo root):

```text
assets/
  manifest.json
  models/
  textures/
```

**Refresh scan** validates the pack with `@mmo-engine/art`: Zod schema
(name, version, models[], textures[]), pack-relative paths (traversal
rejected), per-entry diagnostics. **Load pack in browser** instantiates
`ManifestAssetProvider` against `/assets/*` and reports per-asset
`loaded` / `fallback` status with diagnostics — a failed model never
breaks the pack; it stays on the deterministic placeholder mesh.

Joey supplies the real art later; until then everything renders the
placeholder pipeline (the same one the game client uses — both consume
`@mmo-engine/art`, one contract).

To import a finished pack into a Rogue project:

```bash
node rogue-packages/sirhertzalot/mmo-editor/src/import-art-pack.mjs \
  --project /path/to/rogue-project --pack /path/to/mmo-engine/assets
```

Models land in `Assets/Models/mmo/`, textures in
`Assets/Textures/mmo/`, with an index manifest for `RE.Model.fetch()`.

## Rogue scene bridge

In your Rogue project, copy
`rogue-packages/sirhertzalot/mmo-editor/` to
`rogue-packages/sirhertzalot/mmo-editor`, register the
`MmoEditorBridge` component, and attach it to any Object3D. Configure:

- `editorUrl` — companion URL (default `http://localhost:5174`)
- `autoOpenOnPlay` — open the companion when Rogue play starts
- `announcePlayState` — broadcast play/stop on the bridge channel

The companion listens on the same `BroadcastChannel` and reflects Rogue
play state. Full install + compatibility notes (pinned Rogue docs
commit, upgrade checklist) are in the package's `README.md` and
`COMPATIBILITY.md`.

## Manual UI test procedure

1. `npm run editor`; open http://localhost:5174.
2. **Play Mode** → Start. Expect: status running, tick advancing,
   entity count > 0, tile overlay shows the loaded chunk bounds,
   waypoint query for your entity shows `idle`.
3. **ECS Inspector** → connect with the same URL (credentials are shown
   in Play Mode while running). Expect: tick/entity count live, search
   filters the list, component filter narrows it, selecting an entity
   shows Transform/Velocity/etc. with 3-decimal numbers, and the
   read-only notice is visible.
4. **Art Assets** → Refresh scan. Expect: "no pack" diagnostic until
   you create `assets/manifest.json`; with a pack, per-asset loaded /
   fallback rows.
5. **Play Mode** → Stop. Expect: status idle, server port closed
   (`ss -tln | grep 7777` empty), no orphan `server.js` process, form
   state restored.
6. Start → immediately Stop during the 60 s readiness window is also
   safe: the owned group is still killed.

## Code map

```text
apps/editor/
  src/host.ts                 dev-only server/assets control API (vite plugin)
  src/play-mode.ts            PlayModeController (idle→starting→running→stopping→idle→error)
  src/inspectors/ecs.ts       read-only ECS view-model (no React, unit-tested)
  src/ui/App.tsx              tab shell — one tab per inspector
  src/ui/ecs-inspector.tsx    ECS panel (search, filters, details, read-only notice)
  src/ui/play-mode.tsx        Play Mode panel (start/stop, overlays, debug queries)
  src/ui/asset-inspector.tsx  Art panel (scan, validation, browser load test)
  src/ui/mirror-connect.ts    MirrorClient adapter (connect/login/debug/close)
  src/ui/components.tsx       shared shadcn-style primitives
packages/mirror/              shared mirror client (game client + editor)
packages/art/                 shared art contract (manifest, scanner, provider)
rogue-packages/sirhertzalot/mmo-editor/
                              public-API Rogue bridge package
```
