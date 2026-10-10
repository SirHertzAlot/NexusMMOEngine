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

Pattern established. Remaining migrations are mechanical.
