# Art Pipeline

How the licensed art becomes web-ready models, and the rules that keep it out
of the repository. Read the [confidentiality rule](#the-one-hard-rule) first if
you are about to commit anything.

## The one hard rule

**The licensed art is confidential and must never reach GitHub.**

Everything the packs and the third-party animations live under
`assets/`, which is gitignored at the repository root (`/assets/` — anchored,
so it cannot accidentally match a vendored library's own `Assets/` folder on a
case-insensitive filesystem). Nothing under `assets/` is tracked: the manifest,
the converted GLBs, the atlases, the previews and the animation libraries are
all local to the machine that converted them. On this checkout the folder is
about 3.2 GB and the repository itself is about 57 MB.

This is fine by design: **a fresh clone works without the art.** Without it
the client draws the engine's own procedurally cooked PICG trees instead of
the nature set, and characters are placeholder shapes — but terrain, water,
sky, weather, physics, combat and networking are unaffected.

Before pushing, run the check in
[CONTRIBUTING.md](../CONTRIBUTING.md#7-things-that-must-never-be-committed).
It must print nothing.

## What is in `assets/`

```text
assets/
  models/
    3d/       the source packs (FBX + MaterialList_*.txt + textures)
    2d/       source textures
    glb/      the converted output, one folder per pack
  textures/   converted atlases, one folder per pack
  animations/ the third-party animation libraries
  previews/   local render previews
  manifest.json  the art-pack contract the editor and client load
  catalog.json   per-model metadata (category, rig, size, …)
```

The converted output for the shipped packs is 4,080 models and 160 textures
across four packs — `fantasy-kingdom` (2,423), `modular-fantasy-hero` (1,504),
`dungeon-pack` (814) and `fantasy-rivals` (68) — recorded in `manifest.json`
as `models`/`textures` entries.

## The manifest is the contract

`assets/manifest.json` is what the editor and the client agree on:

```json
{ "name": "converted-packs", "version": "3.0.0", "models": [ … ], "textures": [ … ] }
```

It is parsed by a **strict Zod schema** in `packages/art/src/manifest.ts`:
unknown keys are errors, ids must be unique within a section, and every path
must be relative and cannot escape the pack (`../evil.glb`, a bare `..`,
`/etc/passwd` and Windows absolute paths are all rejected). A manifest that
fails is reported with the reason rather than crashing the reader, and a pack
whose entry is missing from disk is reported as a diagnostic per asset.

`@mmo-engine/art` is the single implementation of this contract, shared by the
game client, the editor and the server, so there is one definition of what an
art pack is. `ManifestAssetProvider` loads a served pack in the browser and
reports per-asset `loaded` / `fallback`; **a failed model never breaks the
pack** — it stays on the deterministic placeholder mesh.

## Converting a pack

`convert-packs` turns source packs into web-ready GLBs:

```bash
npm run convert:packs                                  # convert new/changed files
npm run convert:packs -- --force                       # reconvert everything
npm run convert:packs -- --only dungeon-pack --limit 20
```

| Flag | |
|---|---|
| `--force` | reconvert everything, not just what changed |
| `--only <pack>` | one pack; every other pack is kept from the last run |
| `--limit <n>` | convert at most n models (useful for a quick look) |
| `--assets <dir>` | a pack root other than the repo's `assets/` |

Input is `<assets>/models/3d/<pack>/` — any folder holding a
`MaterialList_*.txt`. Output goes to `<assets>/models/glb/<pack>/<category>/`
and `<assets>/textures/<pack>/`, and rewrites `manifest.json` and
`catalog.json`.

Per model the converter:

1. loads the FBX with three.js's `FBXLoader`;
2. **detects the folder's unit** — FBX headers always claim centimetres, but
   some folders are authored in metres. The converter samples twelve files and
   treats a folder whose median model would be under 5 cm as metres (this is
   what the dungeon pack's static meshes need), then scales everything to
   metres;
3. **renames materials from the pack's material list**, because the FBX
   carries only DCC leftovers like `lambert1439`;
4. flips UVs to glTF orientation;
5. exports a GLB whose materials reference the **shared atlas by relative
   URI** instead of embedding a copy of the texture per model.

It skips OBJ duplicates, Unreal-rigged copies and `*FixedScale*` variants.
`CONVERTER_VERSION` is bumped to force a full reconvert when the output format
changes.

Everything here stays under `assets/`, which is gitignored. **Run it from the
repo root**; `convert:packs` builds the art package first, but the other two
need `npm run build -w @mmo-engine/art` beforehand.

## The character rig

Two more converters prepare the modular character:

```bash
npm run convert:modular    -w @mmo-engine/art          # [--assets <dir>]
npm run convert:animations -w @mmo-engine/art          # [--assets <dir>]
```

`convert:modular` builds the character rig into
`<assets>/models/glb/modular-fantasy-hero/Rigged/`: one `rig.glb` (52 bones, in
metres), one skinned `parts/<name>.glb` per modular part (720 of them), and a
`catalog.json` describing what each part is.

The interesting part is why it needs a converter at all. `FBXLoader` gives each
of the 720 parts **its own copy of the skeleton** — 3,513 bones, nested inside
the real one. Every copy has the same rest pose, so the converter builds **one**
skeleton and re-binds each part to it. Bones are identified by their path from
the top, because copies nested inside the bone they copy collapse onto it. The
pack also names both hands' fingers identically (`Thumb_01` …), so those get a
side suffix (`Thumb_01_L`, `Thumb_01_R`) to keep every bone name unique. Each
part file still carries a skeleton; the client binds a character's parts to one
shared rig **by bone name**.

`convert:animations` retargets the third-party animation libraries onto that
rig, writing `animations/<source>.glb` and an `animations.json` inventory
(source, duration, loop, travel). Sources are declared in `ANIMATION_SOURCES`
with where they sit under `assets/`, their skeleton's bone names for ours, and
**their licence**. Missing sources are skipped, so each machine converts what it
actually has, and a clip name already taken by an earlier source is skipped too
— the packs repeat their idles.

**Clips play in place.** Horizontal root motion is taken out of the animation
and reported as `travel`, so the *server* moves the character rather than the
animation dragging it. `_RM` (root-motion) duplicates of in-place clips are
skipped, and a clip that exists only in root-motion form is adapted.

The combat move table in `packages/protocol/src/combat.ts` refers to these
clips by name, and a test keeps the two in step — so changing a clip's duration
means changing the move's duration too. See
[GAMEPLAY.md](GAMEPLAY.md#the-moves).

## Terrain surface textures

```bash
npm run surfaces:fetch      # ~23 MB, once
npm run surfaces:fetch -- --from <dir>
```

This fetches **CC0 photo-scanned ground materials** (Poly Haven, ambientCG)
prepared by ProceduralTerrains, as packed mip-mapped RGBA8 files. By default it
downloads each material's 512 px file from the ProceduralTerrains repository at
a **pinned commit** and verifies it against the SHA-256 recorded in that
commit's catalog; `--from <dir>` copies them from a local prepared checkout
with the same checks.

Output goes to `apps/client/public/surfaces/` (gitignored) as `<id>.pbr` files
(zlib-deflated RGBA8 levels: colour+height, then normal.xy+roughness+AO, per mip
level), plus `manifest.json` (layers, tile sizes, biome assignments) and
`ATTRIBUTION.md`.

Without them the terrain uses flat biome colours. With them it blends grass,
rock, sand, snow and mud by biome, slope and height.

These are for the *shared* ground look. The art packs' own ground textures are
a separate, licensed set.

## The Rogue bridge

`rogue-packages/sirhertzalot/mmo-editor/` holds the public-API package that
connects this project's editor to a Rogue Engine project, and
`docs/EDITOR.md` documents the install. To import a finished pack:

```bash
node rogue-packages/sirhertzalot/mmo-editor/src/import-art-pack.mjs \
  --project /path/to/rogue-project --pack /path/to/mmo-engine/assets
```

Models land in `Assets/Models/mmo/` and textures in `Assets/Textures/mmo/`,
with an index manifest for `RE.Model.fetch()`.

## Licensing and attribution

Two different licences are in play and they must not be confused:

- **The art packs and animation libraries are licensed, not open.** They are
  confidential, gitignored, and your licence to use them is not this project's
  to grant. The animation sources' licences are declared in
  `ANIMATION_SOURCES`; check them before redistributing anything built from
  them.
- **The vendored C++ libraries and the CC0 surface textures are open**, with
  their own notices. `packages/dungeon/THIRD_PARTY_NOTICES.md` is the model for
  how a ported or vendored dependency is attributed — it names the upstream
  project, the exact commit, the date and the licence. If you vendor or port
  something, do the same.

`rogue-packages/sirhertzalot/mmo-editor/COMPATIBILITY.md` records the pinned
Rogue docs commit and the upgrade checklist for the editor bridge.
