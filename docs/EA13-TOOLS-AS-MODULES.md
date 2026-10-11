# EA13: Existing Tools as Modules

## Design

Convert existing editor panels and tools into modules (EA3) so they can be enabled/disabled.

### Migration list

| Tool | Current | Target module |
|------|---------|---------------|
| Characters Records | hardcoded panel | `characters` ✅ (done) |
| Scenes workspace | hardcoded | `scenes` |
| Flow editor | hardcoded | `flow` |
| Story editor | hardcoded | `story` |
| VFX editor | hardcoded | `vfx` |
| Audio panel | hardcoded | `audio` |
| HUD editor | hardcoded | `hud` |

### How

1. Move panel code to `modules/<name>/editor.tsx`
2. Add `module.json` with `editor.entry`
3. Register in `content/modules.json`
4. Remove hardcoded import from shell

### Done

- `characters` module ✅ (EA3)

### Remaining

The rest follow the same pattern. Each is a mechanical move.

## Status

Implemented 2026-10-10, following the EA3 `characters` module pattern.
- Six modules created: `scenes`, `flow`, `story`, `vfx`, `audio`, `hud` —
  each with `module.json` (`editor.entry: editor/index.tsx`) and a thin
  `editor/index.tsx` that re-exports the existing panel component as a
  contributed panel (panel code stays in `apps/editor/src/ui/`).
- `apps/editor/src/ui/App.tsx`: the six hardcoded WORKSPACES views removed
  (imports dropped); workspaces left with `views: []` plus a comment, so the
  registry contributes the panels and disabling a module shows the
  "No module contributes" placeholder.
- `content/modules.json`: all six enabled by default, preserving the
  out-of-box workspace layout (tab order within a workspace may shift where
  a module panel now appends after hardcoded views).
- Tests: `apps/editor/test/modules-client.test.ts` gains an EA13 block —
  manifests validate with editor entries, all six enabled by default, and
  the registry serves each panel to its workspace.
