# mmo-editor — Rogue Engine bridge package

A project-local [Rogue Engine](https://github.com/beardscript/rogueengine)
package that connects a Rogue scene to the **standalone MMO Engine editor
companion** (the ECS inspector / play-mode / art-pipeline dock in
`apps/editor/` of this repo).

## What it is

- `src/mmo-editor-bridge.ts` — a public `RE.Component` (`MmoEditorBridge`).
  Attach it to any Object3D. Its inspector props configure the companion
  URL; on Rogue play/stop it announces state over a `BroadcastChannel`
  (`"mmo-editor-bridge"`) so the companion — running in the same browser
  in another tab or iframe — can reflect play state. A button prop opens
  the companion in one click.
- `src/import-art-pack.mjs` — Node script that copies an MMO art pack
  (`assets/manifest.json` + models/textures) into a Rogue project's
  `Assets/Models/mmo/` and `Assets/Textures/mmo/`, and writes an index
  manifest for `RE.Model.fetch()`.

## What it is not

It does **not** add panels to the Rogue editor, restyle it, or touch any
editor internals. There is no stable public API for custom dockable
editor panels, so the MMO editor ships as a standalone companion app and
this package is only the scene-side bridge. That keeps the integration
upgrade-safe: only documented public surfaces are used.

## Install

1. Copy this folder into your Rogue project at
   `rogue-packages/sirhertzalot/mmo-editor` (path and the `package.json`
   `rogue.publisher` / `rogue.packageId` must agree — see the Rogue
   Marketplace docs).
2. In the Rogue editor: Assets → Component, or drop
   `src/mmo-editor-bridge.ts` into your project's components folder so
   `RE.registerComponent(MmoEditorBridge)` runs.
3. Attach **MmoEditorBridge** to any Object3D (an empty "EditorBridge"
   object is the convention). Set the inspector props:
   - `editorUrl` — where the companion runs (`npm run editor` default:
     `http://localhost:5174`)
   - `autoOpenOnPlay` — open the companion when Rogue play starts
   - `announcePlayState` — broadcast play/stop on the channel
4. Start the companion (`npm run editor` in this repo) and press
   **Open MMO Editor** (or enable `autoOpenOnPlay`).

## Importing an art pack

```bash
node rogue-packages/sirhertzalot/mmo-editor/src/import-art-pack.mjs \
  --project /path/to/rogue-project \
  --pack /path/to/mmo-engine/assets
```

Models land in `Assets/Models/mmo/<id>.<ext>`, textures in
`Assets/Textures/mmo/<id>.<ext>`, plus
`Assets/Models/mmo/manifest.json` mapping ids → Rogue-relative paths.
Load one at runtime with the public API:

```ts
import * as RE from "rogue-engine";
const model = await RE.Model.fetch("Assets/Models/mmo/player.glb");
const obj = RE.Model.instantiate(model); // add to your scene graph
```

Only manifest-listed, pack-relative files are copied — entries that
escape the pack directory are rejected.

## Compatibility

Pinned to Rogue Engine docs/commit
`cf383bd80623ff082aff2c4e95f92f043f26d983`. Public surfaces used:

| Surface | Use |
|---|---|
| `RE.Component` subclass + `RE.registerComponent()` | the bridge component |
| `@RE.props.text/checkbox/button/group` | inspector props |
| `SceneController.onPlay` / `onStop` → `{stop}` | play-state hooks |
| `App.sceneController`, `App.currentScene` | reach the controller/scene |
| `RE.Model.fetch` / `RE.Model.instantiate` | load imported models |
| `rogue-packages/<publisher>/<package-id>` layout | install path |

If a Rogue upgrade renames any of these, only this package's `src/`
needs updating — the standalone companion (`apps/editor/`) is
unaffected. See `COMPATIBILITY.md`.
