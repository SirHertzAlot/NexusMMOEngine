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

## Importing ready-made GLB packs

Packs that arrive as GLBs (a folder of `.glb` and a `manifest.json` of
`{ title, publicID, licence, file?, page }`, as Poly Pizza zips do) skip the FBX
converter. Unzip each into its own folder, then:

```bash
npm run build -w @mmo-engine/art
npm run import:glb -w @mmo-engine/art -- <dir>... [--assets <dir>]
```

Per model it copies the GLB to `models/glb/<slug>/<Category>/`, **rescales it to
a natural size** (the packs' units are arbitrary: the same pack holds a rabbit
2 units long and a sheep 766; `natural-size.ts` maps whole name words to metres)
with the base centre at the origin, and adds `catalog.json` / `manifest.json`
entries carrying `license` (author, licence name, page), `animations` and
`skinned`. Re-running a pack replaces its entries; `convert:packs` keeps them.
Models with no known size keep their units and are listed in the catalog
diagnostics.

What to do with them is data: `npm run wildlife:plan` (engine-core) writes a
gitignored `content/ecology/wildlife.local.ecology.json` (the wilds plan plus
name-pattern layers: sea floor with `habitat: "water"` and depths, shore birds,
woodland fauna, critters, farm animals; static, skinned models excluded; run
with `MMO_ECOLOGY`). `DEFAULT_DRESSING_PATTERNS` (settlement `art.ts`) names
farm produce, crops, tools and yard pieces for farmsteads. A creature that
moves needs a simulated agent, which is not built.

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

## Animals: procedural movement for static meshes

The imported animals (woodland fauna, farm animals) are static meshes with no
skeleton and no clips. They move through `apps/client/src/render/animal/`:
the client cuts the mesh into parts, adds a seven-bone skeleton to a copy of
its geometry and poses it from the server's velocity. No clip files are made
or needed, so every static quadruped moves the day it is imported.

**Decision.** The idea came from
[threejs-procedural-animals](https://github.com/majidmanzarpour/threejs-procedural-animals)
(MIT, Majid Manzarpour). We took option C of three:

- **A, use the library for its species:** rejected. It builds its own SDF
  animals (24 species) and cannot move another mesh; using it would replace
  our animals, and the project decision is to use our own.
- **B, drive our meshes with its gait/IK solver:** rejected. Its locomotion
  (`src/core/motion/quadruped.js`, about 180 KB, plus `rig/` and
  `render/dqs.js`) is welded to its own generated rig: it reads joint chains,
  paw/hoof bones and dual-quaternion skin from `data.joints`, which our meshes
  do not have. Faking that rig for 480 arbitrary meshes costs more than the
  motion is worth.
- **C, our own small rig and gait inspired by its concepts:** chosen. We took
  the ideas (a gait is a table of per-leg touchdown phase offsets and a duty
  factor, rows blended by speed, speeds compared by Froude number so a wolf
  and a bear change gait at the same effort, one-shots layered over
  locomotion) and wrote them for a seven-bone rig. **No code from the library
  is vendored**, so there is no licence text to carry and no
  `content/credits.json` entry; the concept credit is this paragraph. If you
  vendor any of its files later, copy its `LICENSE` and copyright notice next
  to them and add a credits entry (project, author, MIT, repository URL,
  `confirmed: false`).

**How it works.**

- `segment.ts` (pure, no three.js): the longest horizontal axis is the spine;
  the head end is the one held higher off the ground (the rear reaches down
  with hind legs; right on the seven tried: deer, bear, fox, cougar, wolf, pig, goat; vertex count is only the
  tiebreak); the belly is where a height slice's footprint fills in; smooth
  region weights give head, tail, four legs and body, four influences per
  vertex. A mesh that is not four-legged (length under 0.7 of height, snakes,
  birds, upright shapes) returns null and stays a static prop.
- `gait.ts` (pure): walk, trot, gallop rows blended by speed (Froude), duty
  factor, stride, swing lift, bob, the attack windup/strike pose and the
  death fall. A leg's hip angle is chosen so its stance foot moves at body
  speed (no sliding), up to a cap.
- `animal-rig.ts`: `AnimalTemplate` (one per model: skinned geometry copy) and
  `AnimalRig` (one per animal: `SkinnedMesh`, bones, state). `update` allocates
  nothing. The material is the model cache's, shared with the scenery, and is
  never disposed or tinted per animal.
- `EntityLayer` gives a moving entity with an `AssetRef` to a loaded art model
  the rig (`dressAsAnimal`), then feeds it the mirrored velocity, the Action
  row (`combatMove`: windup until `hitAt` is the telegraph, strike after) and
  health (zero: lies down). Animals farther than `ANIMAL_LOD_RADIUS` (45 m)
  hold the rest pose and cost no CPU.

**Add a species.** Import the GLB (`npm run import:glb`), give the creature
rules an entity with that model's `AssetRef`; it rigs itself. If the head is
picked wrong or the belly height is off, pass `SegmentHints`
(`headSign`, `legTop`) where the template is built. Megafauna (giant
predators) rig the same way; their stride scales with leg length (Froude).
Sea giants, birds and snakes need their own cut (fin and tail wave, wings,
spine wave): not built.

**Known artifacts.** Legs are rigid pieces blended over the belly, so a leg
shows some stretch at the hip, and there is no knee or hoof bend: feet slide
a little at gallop (hip swing is capped) and paws do not roll. Wide antlers or
tusks clip the ground when the body lies down. Only a dozen models were tried;
the head and belly heuristics may need a hint for others. A far animal is posed at
rest, not drawn from the instanced prop batch. Developer views of the rig
(bone layout, weights) belong in the editor and are not built.

## Licensing and attribution

Two different licences are in play and they must not be confused:

- **The art packs and animation libraries are licensed, not open.** They are
  confidential, gitignored, and your licence to use them is not this project's
  to grant. The animation sources' licences are declared in
  `ANIMATION_SOURCES`; check them before redistributing anything built from
  them.
- **Third-party art that needs attribution** (the CC-BY packs) is credited in
  `content/credits.json`, typed by `parseCredits` (`@mmo-engine/art/browser`):
  an author, a licence name and the line to show, never a model. The game's
  entrance / credits screen should read it
  (`import credits from ".../content/credits.json"`). Entries marked
  `confirmed: false` have wording still to be checked against the licence.
- **The vendored C++ libraries and the CC0 surface textures are open**, with
  their own notices. `packages/dungeon/THIRD_PARTY_NOTICES.md` is the model for
  how a ported or vendored dependency is attributed — it names the upstream
  project, the exact commit, the date and the licence. If you vendor or port
  something, do the same.

`rogue-packages/sirhertzalot/mmo-editor/COMPATIBILITY.md` records the pinned
Rogue docs commit and the upgrade checklist for the editor bridge.
