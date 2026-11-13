# Wire-ready editor prototype package

This package preserves the completed W1–W5 editor-prototype workflow in
the repository. It is a design and integration prototype, not the shipped
React editor in `apps/editor/`.

## Contents

- [`EDITOR-PROTOTYPE-TW.html`](EDITOR-PROTOTYPE-TW.html) — the single-file
  Tailwind prototype with the NexusWire data layer, command bus,
  whole-game save, context-summoned add-object flow, HTTP write-through,
  GSAP motion, and the standard / scene-first layout modes.
- [`../EDITOR-WIRE-READY-AND-GAME-SAVE-SPEC.md`](../EDITOR-WIRE-READY-AND-GAME-SAVE-SPEC.md)
  — the original design and the dated build addenda. The opening status
  records the pre-build state; the 2026-11-13 addenda record what was
  actually built and verified.
- [`../backend-reference/`](../backend-reference/) — the executable W4
  backend contract: a zero-dependency reference server and endpoint map.
  It is a conformance fixture, not the production Express editor backend.
- `preview/desktop-vision-layout.png` — the scene-first layout with an
  object added to North Gate.
- `preview/desktop-game-panel-http.png` — the whole-game panel with the
  Local mock / HTTP server backend picker.

## Run the prototype

Open `EDITOR-PROTOTYPE-TW.html` in a browser, or serve the repository
root with any static file server. The local mock backend is the default
and needs no server process. Tailwind CSS and three.js still load from
their CDNs in this prototype; GSAP is inlined. When those CDNs are
unreachable, the viewport uses its stand-in render.

## Run the reference backend

From `docs/library/mmo-engine-editor-ui/backend-reference/`:

```sh
node server.mjs
```

The server listens on `http://127.0.0.1:8921` by default and stores
documents under `./data/`. `PORT` and `DATA_DIR` override those values.
In the prototype, open **Game**, choose **HTTP server**, and keep or edit
the base URL. Drafts and versions then write through to the reference
server, commands stream to it in batches, and boot reconciliation picks
the newer local or server draft by `manifest.savedAt`.

If the server is unavailable, the editor continues against the local
mirror and reports that state in the Game panel. Invalid project
documents are refused rather than hydrated.

## Architectural boundary

The GameProject document is authoring truth. It does not replace the
SurrealDB runtime world store, and this package does not change
`apps/editor/`, the world server, or the game client. Production work
still has to implement the same contract in the Express editor backend
and consume the same document shape in the React editor.

GSAP is scoped to this prototype surface. The ratified motion split for
the shipped surfaces remains GSAP for the website and anime.js for the
game frontend.

## Verification recorded for this package

The source files were copied byte-for-byte from the verified working
set. Recorded checks on that set were:

- JavaScript syntax checks for the prototype's script blocks and the
  reference server.
- W1–W3 save-flow regression: all substantive checks passed; the one
  labelled failure is a known bad test expectation (provenance verbs do
  not fire during boot, while interaction verbs do reach the bus).
- Add-object flow: 10/10 checks passed.
- W4 HTTP flow: write-through, command delivery, server restart, and
  recovery of the whole game into a fresh browser from the server alone
  passed; the server-down local-mirror path also passed.
- W5 motion and layout checks passed, including the scene-first rail
  proportions and persistence of the layout choice.
- Final regression reported zero page errors.

These are functional prototype checks, not performance measurements or
production acceptance gates.
