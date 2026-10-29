# CGHEVEN VFX Pack — for in-game use

Compiled 2026-10-22 from [cgheven.com](https://cgheven.com) free-tier downloads
(artist: Ammar Khan). Built for use **inside Joey's own game projects**.

## License — read this first

CGHEVEN's free license allows use in your own projects, **including commercial
games**, with no attribution required (credit appreciated). It does **not**
allow: sharing/reselling/re-uploading the raw files, bundling them into
downloadable packs for others, or using them to train AI models. So: this pack
lives in the private project files — never ship it as a standalone download,
and don't include it in the engine's redistributable prototype packs. The
finished game that *uses* the effects is fine to sell.

Full terms: https://cgheven.com/licensing

## What's in here

- `source/` — the original free 2K MP4 masters (shot on black), ~403 MB total.
- `flipbooks/` — game-ready sprite sheets built locally from the masters:
  **8×8 grid, 64 frames, 256×256 px cells, 2048×2048 PNG** with an alpha
  channel keyed from brightness (alpha = max(R,G,B); RGB color preserved).
  Each sheet has a `.json` sidecar with grid, timing, crop and blending hints.
- `manifest.json` — machine-readable index of all 12 effects.
- `build-flipbooks.py` — the converter. Re-runnable; skips up-to-date sheets.

Why local conversion: CGHEVEN's own flipbook PNG downloads turned out to be
Pro-gated despite "Free" badges, so the sheets here were generated from the
free MP4s instead. Same source material, no payment, no account.

## Bonus: water splash (not CGHEVEN)

CGHEVEN has no water-splash VFX at all, so the water slot is filled by a
bonus effect from Pexels (video 9667666, Pexels License — free for personal
and commercial use, no attribution required; do not sell unaltered copies or
redistribute on stock platforms). The 12s original was trimmed to the 0–4s
action range for the master in `source/`; the sheet follows the same 8×8
flipbook convention. Same in-project-use-only rule as the rest of the pack.

## The effects

| Sheet | Type | Clip | Replay fps* | Loop | Blending |
|---|---|---|---|---|---|
| aerial-explosion-07-front | explosion | 1.5s | 42 | no | additive |
| aerial-explosion-07-offcentre | explosion | 1.5s | 42 | no | additive |
| campfire-02-offcentre | fire | 8.3s | 7.7 | yes | additive |
| groundfire-09-front | fire | 12.5s | 5.1 | no | additive |
| flamethrower-07-fpv | fire | 5.8s | 11 | no | additive |
| electric-arc-bolt-01 | lightning | 4.2s | 15.3 | no | additive |
| shockwave-smoke-03-side | smoke | 7.7s | 8.3 | no | normal/alpha |
| shockwave-smoke-01-top | smoke | 13.3s | 4.8 | no | normal/alpha |
| magical-tornado-01-front | magic | 16.7s | 3.8 | no | additive |
| magic-beam-01-front | magic | 4.2s | 15.2 | no | additive |
| cannon-spark-01-fpv | sparks | 1.9s | 34 | no | additive |
| dust-explosion-01-top | dust | 9.6s | 6.7 | no | normal/alpha |
| water-splash-01 | water | 4.0s | 16 | no | normal/alpha |

\* Replay fps spreads all 64 frames across the original clip's real duration.
For ambient loops (campfire, ground fire, tornado) that's slow — in practice
play a sub-range at 12–24 fps, or speed up 2–3×. One-shots (explosions, sparks,
beam) feel right near the listed rate.

Source pages: every effect's `.json` sidecar (and `manifest.json`) carries its
cgheven.com asset-page URL.

## Porting into the engine (three.js / three.quarks)

- **Texture**: load the sheet PNG as a texture (flipY default is fine —
  ffmpeg writes frame 0 top-left and the tile order is left→right,
  top→bottom; if frames play upside down in your UV setup, offset
  `repeat.y` sign once in the material, not per effect).
- **three.quarks**: use the sheet as a particle texture with texture-sheet
  (grid) animation — set grid 8×8, frames 64, and drive frame-over-life from
  the particle's age so one particle lifetime = one pass through the sheet.
  Fits the agnostic `VfxEffect` format (PR #218): the sheet + fps + loop +
  blending in the sidecar JSON map straight onto an emitter definition.
- **Plain billboard**: a `Sprite` or camera-facing quad stepping UV offset per
  frame also works for placed effects (campfire on a fire pit, tornado).
- **Blending**: additive for fire/explosion/lightning/magic/sparks (glow-type;
  black = invisible). Normal alpha blending for smoke and dust — their alpha
  is brightness-derived, so bright smoke reads denser than dark smoke; tint via
  material color if a sheet reads too faint.
- **Orientation**: "Top" effects (smoke 01, dust) are shot from above — lay
  them flat as ground decals/expanding rings, not upright billboards. "Side"
  smoke 03 is a wide, flat band (its cells are letterboxed) — good as a
  ground-hugging shockwave seen edge-on. FPV effects (flamethrower, sparks)
  are framed for a first-person origin; they also work as short cone bursts
  from a weapon or nozzle.
- **Performance**: each sheet is one 2048² texture (~0.25–3 MB on disk) — one
  texture per effect, no per-frame uploads. Keep simultaneous additive sheets
  modest on low tiers (overdraw), per the usual particle discipline.

## Gaps and caveats

- **No water splash** — checked thoroughly; CGHEVEN has no water-splash VFX
  (only a few Pro 3D water props). Source it elsewhere.
- No heal/portal effect was in the free set either; Magic Beam and Magical
  Tornado cover the "magic" slot for now.
- The campfire clip's flame sits in a tall crop (smoke column above it), so
  its cells have some dark space under the flame — anchor the billboard by
  its lower third when placing it on a fire pit.
- These are realistic/photo-style renders. Against the game's low-poly
  stylized look they'll read as "realistic effect cards" — test one in-engine
  before committing to the style across all effects.
