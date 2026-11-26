# Blender live link

Send a model from Blender to the running editor without exporting by
hand, finding the folder, and reloading.

## Install

1. Start the editor: `npm run dev --workspace apps/editor`.
2. In Blender: **Edit → Preferences → Add-ons → Install…**, pick
   [`scripts/blender/mmo_live_link.py`](../scripts/blender/mmo_live_link.py),
   and tick **Nexus live link**.
3. In the 3D viewport press <kbd>N</kbd> and open the **Nexus** tab.

The add-on uses Blender's own Python and the standard library. There is
nothing to install with `pip` and nothing that has to stay in step with
the engine's dependencies.

## Send

Select the objects and press **Send selection**, or tick **Send on
save** and every save of that `.blend` sends the current selection.

The model name defaults to the `.blend` file's name, lower-cased. Set
**Model name** to send several models from one file; a name is
lower-case letters, digits, `-` and `_`, up to 64 characters.

What arrives shows up in the editor under **Art & audio → Blender
link**: the newest model on screen, and every model with its size, when
it last came in, and how many times it has been pushed.

## Where models land

`assets/live/<name>.glb`, with an `index.json` beside them.

That folder matters. `/assets/` is **gitignored in full** and the dev
server serves it on loopback only, so a model you are iterating on
cannot be committed by accident, and `vcs-host.ts` refuses every path
under it in any case. The live link writes nowhere else.

A re-push replaces the file and keeps one entry in the index, so
iterating on a model does not fill the list with versions. Deleting a
`.glb` by hand removes it from the list on the next read; nothing has to
be told about it.

## What the host refuses

The push is the one route in the editor that writes binary from outside
the browser, so it is deliberately narrow:

| Refused | Why |
|---|---|
| A name that is not a plain identifier | The name is the only part of a push that reaches the filesystem. It is checked against a whitelist before anything is opened, which leaves no traversal, no hidden file and no device name to reason about. |
| A body that is not a glTF binary | The first twelve bytes must be a `glTF` version 2 header. |
| An empty export, or one over 256 MB | A runaway export should not fill the disk. |
| A push that is cut off | The body is streamed to a temporary file and renamed into place only once it is whole, so the editor never loads half a model. |

A refused push writes nothing and answers with the reason, which the
add-on reports in Blender's status bar.

## What it is not

It is not a two-way link. Blender pushes; the editor receives. There is
no editor-to-Blender command, no live mesh streaming while you sculpt,
and no material or rig translation beyond what Blender's own glTF
exporter does.

The transport is a plain HTTP POST rather than a websocket. A websocket
would only buy editor-to-Blender commands, and it would need a modal
timer in Blender's main thread to pump; the push direction, which is
where the work happens, needs neither.

A live-linked model is a working copy, not a game asset. Baking it into
a pack, giving it an `AssetRef` and referencing it from content is the
art pipeline's job — see [ART-PIPELINE.md](ART-PIPELINE.md).
