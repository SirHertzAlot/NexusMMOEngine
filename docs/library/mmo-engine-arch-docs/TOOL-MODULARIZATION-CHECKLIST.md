# Tool-Modularization Completion Checklist

**Purpose:** answer the question "what does 'every tool to edit our game is now
modularized' concretely mean?" — Joey's completion criterion, 2026-10-13:
"Nothing is locked. Please continue to completion. Completion means every tool
to edit our game is now modularized."

**Verified:** 2026-10-13 ~10:00 ET against `~/workspace/nexus-engine`
(branch `arlo/tooling-full-audit`, commits + uncommitted work),
`apps/editor/src/ui/App.tsx` (workspace→views map, lines 95–211),
`modules/*/module.json`, `packages/engine-core/src/server.ts` (`provided.core`,
line 786), and `docs/EA13-TOOLS-AS-MODULES.md`.

**Re-verified:** 2026-10-19 ~13:40 ET against `origin/main` (`bc95812`),
read-only, file-by-file. See "Re-verification notes" inline below. **Verdict:
the "every tool to edit our game is now modularized" claim is NOT TRUE yet**
— real progress since 10-13 (defects a/b fixed, slices 7–9 landed), but
~20 editor panels remain hardcoded, the economy domain
(wallet/trade/vendor/auction) is still in `provided.core`, all domain stores
are inline, the manifest schema has NO `tools` or `db` contribution keys, and
client modules / module `dispose()` don't exist.

## What "done" means (three axes)

1. **Editor tools as modules** — every workspace panel is contributed via an
   `editor.entry` module panel (EA13 pattern), so disabling the module removes
   the tool from the shell. No hardcoded `<Panel />` views.
2. **Server subsystems as modules** — `provided.core` holds only the irreducible
   minimum (SimWorld, tick loop, gateway, module assembly, session/auth);
   every domain system is assembled from a module entry. (Complete-modularity
   spec §"What stays in core".)
3. **Tool-shaped utilities wrapped as modules** — art pipeline tools, bake
   tools, DB functions declared through the manifest contribution types
   (`tools`, `db`, `native`, `sidecar`, `edge` from EA10/EA11/EA12/EA17).

## Axis 1 — Editor tools (EA13 pattern)

Done (7 modules, `editor.entry` verified on origin/main 2026-10-19):
`scenes` (`scenes.document`), `flow` (`flow.graph`), `characters`
(`characters.records`), `story` (`story.editor` — "Quest & dialog"), `vfx`
(`vfx.editor`), `audio` (`audio.panel`), `hud` (`hud.editor`).
Manifest shape is top-level `"editor": {"entry": ...}` (not under
`contributions`).

Remaining hardcoded views in `apps/editor/src/ui/App.tsx` (origin/main,
re-verified 2026-10-19):

| Workspace | Hardcoded panels | Notes |
|---|---|---|
| World | TerrainEditorPanel | terrain sculpt tool |
| Scene | EcsInspectorPanel | ECS inspector viewport |
| Flow & UI | HudPreview | flow graph itself comes from the `flow` module |
| Gameplay | GameplayGridsPanel, ContentBrowserPanel, TablesPanel, RulesPanel | data/content/rules editing |
| Dungeons & PCG | DungeonPanel, GraphEditorPanel | PICG graphs; pairs with the `dungeons` server module |
| Live ops | LiveOpsOverview, LiveOpsConsole, LiveOpsTelemetryView | via `LiveOpsViews()` |
| Network | EdgeRoutesPanel, ConnectionsPanel | |
| Debug | PlayModePanel | |
| Changes | ChangesPanel | git/version-control UI |
| Database | DatabaseGridPanel, DatabaseQueryPanel, DatabaseAuditPanel | pairs with EA17 DB-functions; no module declares a `db` contribution yet |
| Story | QuestsPanel (quests-live.tsx), StringsPanel | ⚠️ defect (a) RESOLVED 2026-10-19: the hardcoded `<StoryEditorPanel />` is gone; the story module's `story.editor` panel IS `StoryEditorPanel` (`modules/story/editor/index.tsx` imports it from the shell). Remaining hardcoded `quests`/`strings` views are distinct tools (read-only quest list linking to the editor; EA25 l10n grid), not the quest & dialog editor. Disable contract now holds for the editor. |
| Art & audio | AssetInspectorPanel, AnimationPanel, MaterialsPanel (NEW since 10-13) | pairs with EA15 asset previewer / EA21 animouse; vfx + audio panels come from modules |
| Release | PipelineView, PlaytestsPanel, HudEditor | pairs with EA19 build/deploy, EA26 playtests; ⚠️ see defect (b) |
| Modules | ModulesPanel | the registry UI itself — arguably belongs in `core` |

**Defects found (verified 2026-10-13; re-verified 2026-10-19):**
- (a) ~~`story` module contributes `story.editor` ("Quest & dialog") **and**
  App.tsx still hardcodes `story-editor` (`<StoryEditorPanel />`) plus
  `quests` and `strings`.~~ **RESOLVED** — the hardcoded `story-editor` view
  is gone; module contributes the real panel. Remaining `quests`/`strings`
  hardcoded views are distinct tools (see table row).
- (b) ~~`hud` module contributes `hud.editor` to the `release` workspace **and**
  App.tsx still hardcodes `hud` (`<HudEditor />`) in `release`.~~ **RESOLVED**
  — hardcoded `<HudEditor />` removed; release workspace comment confirms the
  hud module contributes it.

Note: `HudPreview` (listed under Flow & UI on 10-13) no longer exists anywhere
in `apps/editor/src` — removed, not modularized.

Both are the exact EA13 disable-capability regressing after later features
re-added hardcoded views.

## Axis 2 — Server subsystems

Done (slices 1–9, on origin/main as of 2026-10-19):
chat, items, dungeons, quests, combat, creatures (slices 1–6),
**character (slice 7 — `modules/character/server.js`; CharacterSystem +
mastery extracted)**, **physics (slice 8 — `modules/physics/server.js`;
physics, navigation, obstacles, integrate, prop-collision, collider)**,
**intent (slice 9 — `modules/intent/server.js`; IntentSystem)**.
18 module folders now (was 16): `intent` and `physics` are new.
Gateway seam working: `dungeons`, `items` (`dropper`), `quests` declare
`server.extensions` in their manifests.

`provided.core` on origin/main (`server.ts:858`, re-verified 2026-10-19) now
holds only: `reloader`, `streamer`, `wallet`, `trade`, `vendor`, `auction`.
**Still NOT modularized:** the economy domain (`wallet`, `trade`, `vendor`,
`auction` — inline in server.ts:607-608 and the 0x21 trade/vendor/auction
adapters), plus `reloader` and `streamer` services.

Domain stores still constructed inline (server.ts, re-verified 2026-10-19):
`characterStore` (:495), `guildStore` (:496), `socialStore` (:497),
`partyStore` (:498), `credentialStore` (:492), `sessionStore` (:921 —
allowed to stay in core per spec), `tiles` TerrainTileStore (:329),
`chunkStore` (:422), `formationTiles` (:423), `walletStore` (:607),
`instanceResults` (:783).

Verb-layer duplication from the 2026-10-17 audit UNCHANGED on origin/main
(re-verified 2026-10-19): `defOf` lambda verbatim ×2 (server.ts:647, :658),
`move` lambda verbatim ×2 (:633, :662), hand-rolled `countInBag` (:723),
`take` adapter (:642), two `grantItem` adapters with different signatures
(:730 quest vs :802 dungeon). No NEW duplication shapes found.

## Axis 3 — Tool-shaped utilities

**CORRECTION (re-verified 2026-10-19): the manifest schema does NOT have
`tools` or `db` contribution keys.** `packages/modules/src/index.ts` lines
39–65 define only `editor`, `server` (with `extensions`), `native`, `sidecar`,
`edge`. Zero modules declare `native`/`sidecar`/`edge` either, and no
`tools/`, `db/`, `native/`, `sidecar/`, or `edge/` directories exist under
`modules/`. So the EA13 "tools-as-modules" and EA17 DB-function contribution
paths are schema work, not just adoption work — `docs/EA17-DB-FUNCTIONS.md`
exists but nothing can declare a `db` contribution yet.

- **Art pipeline tools** (`packages/art`: gltfpack, gltf-transform, gltfjsx —
  implemented end-to-end in TL1–TL3, commit `3e220f3`): functional, but not
  wrapped as module contributions — and there is no `tools` key to wrap them
  as. MODULARITY-GRADING.md extraction order #2 ("already tool-shaped; wrap
  as EA13 tools-as-modules") — still open.
- **Bake tools** (WFC solver: standalone package; erosion stages:
  kernel-internal; bake output contract: producers interchangeable): no module
  wrappers.
- **Native/sidecar/edge** (EA10/11/12): schema keys exist in the manifest;
  zero modules use them.
- **Dev IDE tools** (DEV-IDE-SPEC: Monaco, xterm terminal, pipeline-as-code DAG
  runner, Ghost Sync, zero-touch git): separate track, not modularized.
- **Client modules** (spec: `apps/client` gains `client-modules/` with the
  same manifest shape): not started — `apps/client/src/` has no module layer.
- **Module `dispose()`** (spec Lifecycle: teardown in reverse dependency
  order): still missing from the assembler — no `dispose` in
  `packages/modules/src` or `modules/core`.

## Suggested slice order to "done"

(Re-verified 2026-10-19 — status marked per item.)

1. ~~Fix defects (a) and (b) — remove the re-hardcoded views; small, restores
   the EA13 disable contract.~~ **DONE** (both resolved on origin/main).
2. ~~Finish slice 7 (character) — in flight.~~ **DONE**, plus slices 8
   (physics) and 9 (intent).
3. **Economy domain → modules** (wallet/trade/vendor/auction — the new
   `provided.core` remainder; verb-duplication audit shapes live here too).
4. Database workspace → `db` module(s) (pairs with EA17) — **needs the `db`
   manifest key to exist first** (schema correction above).
5. Domain stores → module-owned (guilds/social/parties; characterStore with
   the character module; `credentialStore` stays core-side per spec).
6. Gameplay workspace panels → modules (grids/content/tables/rules).
7. Dungeons & PCG panels → `dungeons` module editor entry (pairs with the
   server-side dungeons module — natural fit).
8. Remaining workspaces (world/scene/network/debug/changes/liveops/release) →
   one module per workspace, following the EA13 mechanical pattern.
9. Art pipeline + bake tools → `tools` contributions — **needs the `tools`
   manifest key to exist first** (schema correction above).
10. `streamer`/`reloader` services → module pattern.
11. Client modules layer — needs design (spec §"Client modularity").
12. Module `dispose()` lifecycle — missing from the assembler.
13. Gateway handlers + client modules — the spec's later steps.
