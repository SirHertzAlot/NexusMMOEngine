# Compatibility & upgrade notes

Pinned Rogue Engine docs commit: `cf383bd80623ff082aff2c4e95f92f043f26d983`
(public repo https://github.com/beardscript/rogueengine).

## Why this package is upgrade-safe

1. **Only public surfaces.** The bridge uses `RE.Component`,
   `RE.registerComponent`, `@RE.props.*` decorators,
   `SceneController.onPlay`/`onStop`, `App.sceneController` /
   `App.currentScene`, and `RE.Model.fetch` / `RE.Model.instantiate` —
   all documented in the Rogue Engine API docs. No editor internals,
   no private dock/panel APIs, no monkey-patching.
2. **Companion stays standalone.** The three inspectors (ECS, play mode,
   art pipeline) live in `apps/editor/`, a normal Vite+React app. A
   Rogue upgrade can never break them because they share no code with
   the Rogue editor.
3. **Narrow channel contract.** Rogue ↔ companion communication is a
   `BroadcastChannel` with a 3-message JSON protocol (`mmo-editor:play`,
   `mmo-editor:stop`, `mmo-editor:hello`). It depends on the web
   platform, not on Rogue.

## Upgrade checklist (when Rogue releases a new version)

1. Check the pinned docs commit against the new release for changes to:
   - `Component` lifecycle method names (`awake`, `start`, `onDisabled`)
   - `RE.props` decorator names
   - `SceneController.onPlay` / `onStop` signatures
   - `RE.Model.fetch` / `RE.Model.instantiate`
2. Update `src/mmo-editor-bridge.ts` accordingly; bump `version` in
   `package.json`; update the pin at the top of this file.
3. If Rogue ever ships a stable public custom-panel API, the companion
   could optionally embed as a panel — but the standalone app remains
   the supported path (it works against any Rogue version).

## What we deliberately avoided

- **Private editor panel APIs**: none were found documented; depending
  on undocumented internals would break on the next Rogue update.
- **Writing into Rogue's editor state**: the bridge only *announces*
  play state. The authoritative MMO simulation still lives in the
  Node server; Rogue never edits ECS state directly.
