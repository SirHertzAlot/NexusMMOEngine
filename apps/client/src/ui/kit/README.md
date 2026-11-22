# Game client style kit

A small system for the game client's UI, in place of a pile of pictures.

Everything the UI needs to look like it belongs in a fantasy game is here:
one palette, one light direction, one bevel depth, a 9-slice frame set, a
type scale, and a fixed set of spacing and radius values. Screens are built
from these; they do not invent colours or shadows of their own.

## Why a system and not generated art

Generated fantasy UI art tends to come back as *finished panels* — a whole
inventory window rendered as one image. That fails for reasons that have
nothing to do with how good the image is:

- **It cannot resize.** A panel image stretched to another size smears its
  moulding and distorts its corner ornament. Every new size needs a new
  image.
- **Nothing repeats.** A divider baked into the picture cannot run to a
  different width. A slot baked into the picture cannot become a grid of
  thirty.
- **The light direction wanders.** Two images generated separately are lit
  from different angles. Side by side, that reads as "assembled from parts"
  faster than any other cue.
- **The palette drifts.** Each image has its own browns. Put six on a
  screen and none of them match.
- **Text lands on noise.** A painted panel has detail everywhere, including
  under the text, so labels sit on busy ground and legibility goes.

The fix is to generate *materials and parts*, not screens. Generated art is
good raw material for a tiling grain or an ornament silhouette. It is not a
finished screen.

## What is here

| File | What it is |
| --- | --- |
| `tokens.css` | The whole system: palette, light, bevel, radii, spacing, type scale, state colours. The only place a value is defined. |
| `kit.css` | Component classes built only from those tokens: panel, slot, button, bar, divider, ornament, tooltip, and the layout helpers. |
| `generate-textures.mjs` | Produces every texture from code with a seeded PRNG. The source of truth for `textures/`. |
| `textures/*.png` | The generated textures (about 12 KB in total). Committed, and checked byte-for-byte against the generator in the test run. |
| `check-contrast.mjs` | Asserts every text/surface pairing meets its contrast floor. |
| `preview.tsx` | Mounts the real `BagPanel` and the real `BagPanelKit` side by side, plus a sheet of every kit part. |
| `capture.mjs` | Builds the preview and screenshots before/after and the kit sheet. |

## The three rules

**1. One light direction.** Light comes from the top-left for every element
in the client. A raised edge catches light on its top and left; an inset
edge catches it on its bottom and right. That inversion is what makes a
slot read as a hole and a button read as a thing you can press, and it is
why `.kit-slot` and `.kit-panel` look different while using the same
tokens. The direction lives in `--kit-light` and in `LIGHT` in the
generator; they must agree.

**2. Banded shade, ramped shadow.** Shading steps between flat values
rather than sliding smoothly, and a shadow is a darker, cooler, more
saturated colour rather than a black overlay. Both come from the engine's
cel shader (`docs/CEL-SHADING-AUDIT.md`: D1's banded diffuse, "shadow
colour taken from the ramp rather than multiplied to black"). Every
gradient in `kit.css` is a hard-stop gradient — the 2D form of the same
ramp — so the UI is shaded by the same rule as the world it sits over. This
is what makes the kit sit *with* cel shading rather than fight it.

**3. Text never sits on texture.** Each text colour is paired with one
surface and meets at least 4.5:1 against it. Surfaces that carry text use a
narrow band of their material's ramp, so the measured ratio holds across
the whole panel rather than only at its lightest point. `check-contrast.mjs`
asserts all 13 pairings and runs in `npm test`.

## Materials

Four, each a three-stop ramp (shadow / base / light):

- **leather** — the panel ground. Dark, so the 3D scene behind stays the
  brightest thing on screen.
- **iron** — slot wells, secondary frames, item tiles. Cold, to sit apart
  from the bronze.
- **bronze** — frames, buttons, dividers, ornament. The one warm metal.
- **parchment** — tooltips and anything read at length. Dark ink on a light
  ground beats light ink on a dark one for more than a line or two.

A light ground needs its own state colours: the gain/loss pair that reads
well on leather is unreadable on parchment (1.11:1), so `--kit-good-dark`
and `--kit-bad-dark` exist and are applied automatically inside
`.kit-surface-parchment` and `.kit-tooltip`.

## Using it

```tsx
<div className="kit kit-panel">
  <div className="kit-panel__body kit-surface-leather">
    <h2 className="kit-title">Bag</h2>
    <hr className="kit-divider" />
    <button className="kit-btn">Equip</button>
  </div>
</div>
```

`.kit` carries the tokens, so it goes on the outermost element of any
kitted tree. Import `tokens.css` before `kit.css`.

## Changing it

- **A colour**: edit `tokens.css`, run `node check-contrast.mjs`, fix
  anything that drops below its floor.
- **A texture**: edit `generate-textures.mjs`, re-run it, commit both the
  generator and the regenerated PNGs. The test asserts they match.
- **Never** add a colour, shadow, radius or spacing value in a component
  file. If something needs a value the kit has not got, add the token.

## Rolling it across the rest of the client

`bag-panel-kit.tsx` is the worked example. The remaining surfaces, in the
order that gets the most visible change for the least work:

1. **The always-on HUD** — `player-frame`, `target-frame`, `party-frame`,
   `cast-bar`, `status-frame`, `ability-bar`. These are on screen the whole
   time, so they set the game's look more than any panel. Mostly small
   frames and meters, which the kit already covers; no new parts needed.
2. **The other full panels** — `character-screen`, `quests`, `vendor-panel`,
   `civic-panel`, `guild-frame`, `friends-frame`. Same shape as the bag
   panel: frame, labelled sections, slots, buttons.
3. **Chat and notices** — `chat-panel`, the notice components. These need
   one new part, a soft-edged scrim that stays readable over bright terrain.
4. **Menus** — `settings-menu`, `choreo-menu`, `duel-panel`.

Two things are deliberately out of scope and stay as they are:

- **The editor** (`apps/editor`). It is a tool, and the person's preference
  there is Material 3 and data density. Fantasy framing would make it worse
  to work in.
- **Developer overlays** (`perf-hud`, `dev-panels`, `admin-console`). Per
  the repo's rule these belong to the editor and its debugger, not to the
  player's client.

Work still owed when the kit spreads:

- **Icons.** Item tiles currently show the item's base name as text because
  there are no item icons. A tile is the right place for an icon, and the
  kit's well/tile pair is built to hold one. That is a content job, not a
  CSS one.
- **A display face.** The type scale uses system serif and sans stacks so
  the kit forces neither a licence decision nor a font download. An
  open-licensed display face at the front of `--kit-font-display` would
  lift the titles; commit its OFL licence beside it if so.

## Captures

```
node apps/client/src/ui/kit/generate-textures.mjs   # textures
node apps/client/src/ui/kit/check-contrast.mjs      # contrast
node apps/client/src/ui/kit/capture.mjs [outDir]    # before/after + kit sheet
```
