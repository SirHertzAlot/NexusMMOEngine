# Pixel Fireball → 3D: Proof-of-Concept Spec

**Date:** 2026-11-03 · **Status:** SPEC ONLY — no code, nothing added to the repo.
**Question it answers:** can a classic 2D pixel-art spell effect be translated into a 3D
effect on Nexus's existing VFX rails — and what does each translation route cost?

**Grounding (verified on origin/main, 2026-11-03):**
- Format: `packages/art/src/vfx-schema.ts` — the engine-agnostic `VfxEffect` zod schema
  (emitters, spawn shapes, forces, curves over life, color gradients; converts to
  three.quarks for the client via `vfx-convert.ts`, maps to C++ structs per
  `docs/VFX-CPP-MAPPING.md`).
- Budgets: `content/vfx/budgets.json` — low 8 emitters / 1,000 particles ·
  medium 16 / 2,500 · high 32 / 5,000 · ultra 48 / 8,000.
- Prior art: `content/vfx/fireball-impact.json` already exists on main as the schema's
  smoke-test example — a single 60-particle burst emitter. This PoC is the full effect
  (projectile + impact + smoke) built to production shape; its `burst` emitter is a
  deliberate refinement of that example, not a replacement for it.

---

## 1. The reference effect, anatomized

The source archetype is the 16-bit JRPG fireball (the FF/Chrono-era fire spell), chosen
because it is the most-copied pixel VFX shape in existence and exercises every phase a
spell effect has. Authored at **12 fps** on a **64×64 px** frame canvas.

| Phase | Frames | Time | What the pixel artist encoded |
|---|---|---|---|
| Ignition | 3 | 0.25 s | Small white flare at the caster's hand; fast in, no hold |
| Flight (loop) | 4 | 0.33 s loop | Orb with a flickering silhouette; 2–3 mini-flames shed behind; spark streaks |
| Impact bloom | 6 | 0.50 s | Expansion to ~3× orb diameter; **frame 2 held for 2 ticks** (the impact hold, ≈ +0.17 s) |
| Smoke linger | 4 | 0.60 s | 3–4 gray-purple puffs rising and thinning after the fire dies |

**Palette ramp** (the recipe every version below obeys):
`#FFFFFF` white core → `#FFF3A0` pale yellow → `#FFC93C` yellow → `#FF7A1A` orange →
`#E83A0C` red-orange → `#7A1E05` dark-red edge. Smoke: `#6B5B73` → `#3E3644`, alpha-out.

**Texel-density standard (proposed house rule):** the 64 px frame maps to a 0.5 m orb,
i.e. **128 px per meter** for all pixel-sourced VFX. Mixed pixel densities are what make
pixel art look wrong next to itself; the density is a constant, not a per-effect choice.

**Total authored duration:** ≈ 1.1 s of fire + 0.6 s of smoke tail.

---

## 2. Version B — the recipe translation (expressible in schema v1 TODAY)

The pixel art is *not* reused. Its timing, palette ramp, and shapes are re-authored as
particle behaviors. Because `blendMode` is an **effect-level** field in v1, the fireball
is a **suite of three effects** the host plays as one spell:

- `pfb-projectile` (additive) — plays while the projectile flies; the host moves the
  effect origin along the flight path and stops the effect on hit.
- `pfb-impact` (additive) — one-shot at the hit point.
- `pfb-smoke` (normal blend) — companion one-shot at the hit point. Smoke *must* be
  normal-blended (additive smoke can only brighten; it can never read as smoke), and v1
  gives an effect exactly one blend mode — hence the separate file. This is Gap #3 in §4.

### Emitters

**pfb-projectile** — texture `vfx/soft-circle`, authored tier medium

| Emitter | Shape | Rate | Life (s) | Size (m) | Behavior |
|---|---|---|---|---|---|
| core | point | 90/s | 0.28–0.40 | 0.40→0.52→0.36 (mid-life swell = the flicker) | Full palette ramp white→pale yellow→orange→dark red |
| trail | sphere r0.10 | 110/s | 0.40–0.60 | 0.30→0.05 | Orange→dark red; drag 1.2 + turbulence 0.6 (shed flames wobble) |
| embers | point | 26/s | 0.60–1.00 | 0.06→0.03 | Wide spread (1.9 rad), gentle −2.5 gravity, drag 0.4 (spark streaks) |

**pfb-impact** — texture `vfx/soft-circle`, authored tier medium

| Emitter | Shape | Spawn | Life (s) | Size (m) | Behavior |
|---|---|---|---|---|---|
| flash | sphere r0.15 | burst 18 @ t0 | 0.14–0.20 | 0.8→1.4 | White→warm fade; the bloom's first beat |
| burst | sphere r0.28 | burst 46 @ t0 | 0.50–0.80 | 0.34→0.06 | Speed 7→2.5, drag 2.2, +1.5 buoyant rise — refines the on-main example |
| spark-ring | disc r0.10 | burst 40 @ t0 | 0.35–0.55 | 0.07→0.02 | Near-horizontal spread (1.45 rad), speed 6→9, −6 gravity arc |
| tongues | cone (0.5 rad) | 70/s × 0.55 s | 0.40–0.65 | 0.30→0.05 | +3.2 rise, turbulence 1.4 — flame licks after the bloom |
| fall-embers | sphere r0.30 | burst 26 @ t0.05 | 0.80–1.30 | 0.05→0.02 | Wide spread, −7.5 gravity — the dying fall |

**pfb-smoke** — texture `vfx/soft-circle`, authored tier medium

| Emitter | Shape | Spawn | Life (s) | Size (m) | Behavior |
|---|---|---|---|---|---|
| puffs | sphere r0.25 | burst 10 @ t0.15 + 14/s × 0.7 s | 0.90–1.40 | 0.35→0.95 (grows) | `#6B5B73`→`#3E3644` alpha-out; +0.8 rise, turbulence 0.8, drag 0.6 |

Full JSON for all three effects: sibling files `effects/pfb-projectile.json`,
`effects/pfb-impact.json`, `effects/pfb-smoke.json`, and Appendix A of this document.

### Budget check (against the real `budgets.json`)

| | Emitters | maxParticles |
|---|---|---|
| Suite total | **9** | **382** |
| Medium cap | 16 | 2,500 |
| Low cap | 8 | 1,000 |

Per effect, the suite sits at 9 of medium's 16 emitters and 382 of its 2,500
particles (~15%). Read per-scene instead, the emitter cap would bind first — the
budget file doesn't say which reading the runtime enforces, so the honest claim is
the per-effect one. The suite does **not** fit low as-is (9 emitters > 8).
**Low-tier reduction set (defined now, not improvised later):** drop `pfb-smoke`
entirely and drop `tongues` from the impact → **7 emitters / 298 particles**, inside
low with room to spare. Sacrificing smoke first is deliberate: at low tier the effect
keeps its silhouette (core, bloom, sparks) and loses only atmosphere.

### Integration assumptions (host-side, outside the format)

1. The host attaches `pfb-projectile`'s origin to the moving projectile entity;
   particles are born at the origin with ~zero inherited velocity, so the trail is the
   path the origin has travelled — this is how the pixel version's shed flames work too.
2. On hit, the host stops the projectile effect and plays `pfb-impact` + `pfb-smoke`
   at the hit point, oriented to the surface normal (the spark-ring's disc assumes +Y
   up; the host rotates the effect root for wall hits).
3. A point light (warm orange, ~0.35 s decay at impact) is a **host/renderer binding**,
   not part of `VfxEffect` — v1 has no light concept, and this spec does not propose
   adding one to the particle format.

### Validation status

All three JSONs were parsed with the repo's own `parseVfxEffect` (schema extracted
from origin/main) on 2026-11-03: **PASS** (control: the on-main `fireball-impact.json`
also passes through the same harness). Version B is valid v1 data today.

---

## 3. Version A — the flipbook translation (the literal route)

The pixel frames themselves become a texture atlas played on billboards. This is what
most shipped stylized games do — and it is **not expressible in schema v1**. Writing
this version is what surfaced the format gaps in §4; the JSON below is therefore a
*proposal sketch* using the proposed v2 fields (marked †), not valid data.

### Sheet spec

One atlas, **256×320 px, 4×5 grid of 64 px frames**, nearest-sampled:

| Row | Frames | Content |
|---|---|---|
| 1 | 0–2 (+1 blank) | Ignition flare |
| 2 | 4–7 | Flight loop (orb flicker) |
| 3–4 | 8–13 | Impact bloom (frame 10 authored doubled — the hold is *in the sheet*) |
| 5 | 16–19 | Smoke puffs |

**Provenance rule:** the PoC sheet is *generated from the palette ramp in §1* (radial
falloff discs rasterized per frame), so the proof-of-concept involves **no third-party
asset and no license question**. Swapping in a real pixel pack later follows the normal
lane discipline — the license file inside the archive settles it, never the store page.

### Emitter sketch (proposed fields marked †)

- `core`: 1 particle, `texture†: "vfx/pixel-fireball-sheet"`,
  `flipbook†: {columns:4, rows:4, frames:[4,5,6,7], fps:12, loop:"loop"}` — a single
  billboard playing the flight loop; size fixed 0.5 m (= 64 px at the 128 px/m standard).
- `impact-bloom`: 1 particle on hit, `flipbook† frames:[8..13], fps:12, loop:"once"`,
  size 1.5 m.
- `smoke`: 6–10 particles, frames 16–19, `blendMode†: "normal"` (per-emitter override),
  slow rise — mirrors `pfb-smoke`'s behavior block.
- `sparks`: **borrowed from Version B unchanged.** Shipped games hybridize exactly
  here: flipbooks for the body of the effect, real particles for sparks and debris,
  because drawn sparks strobing at 12 fps read worse than simulated ones.

### Cost profile

Particles: negligible (~15 live). Texture: 256×320 RGBA ≈ 320 KB uncompressed.
The real cost is **overdraw** — a 1.5 m additive billboard at close range is a
fullscreen-ish transparent quad; on the low tier the impact bloom should clamp its
size, not its frame rate. Flipbook playback is deterministic under the fixed-timestep
rule already in the C++ mapping (frame = f(sim tick, fps)), so the C++ side stays
bit-identical with the client.

---

## 4. What the PoC actually found: three schema gaps

Version B needed **zero** format changes. Version A needs exactly three, all small,
all expressible in engine-agnostic terms (no three.js types leak in):

1. **Per-emitter `texture`** (override of the effect-level field). One atlas per
   effect forces unrelated phases to share a sheet or an effect to split per phase.
2. **`flipbook` block on the emitter**: `{columns, rows, frames | frameRange, fps,
   loop: "loop" | "once" | "hold"}` — UV-grid concepts every engine shares.
3. **Per-emitter `blendMode` override + `textureSampling: "nearest" | "linear"`**
   (default linear). Smoke-vs-fire blending is the forcing case for the first;
   pixel content is simply broken without the second (linear filtering melts the
   pixels the whole translation exists to preserve).

None of these changes the C++ mapping's determinism story (64-sample curve tables,
seeded PRNG, fixed timestep all unaffected). Estimated shape of the change: one
schema revision (v2), converter support for UV frame selection, editor field
additions. **Not built by this spec** — it is the decision this PoC puts in front
of Joey.

---

## 5. Head-to-head

| | A — Flipbook | B — Recipe |
|---|---|---|
| Authoring cost | Low if a good sheet exists; drawing sheets is the cost | Medium; all dials, no art |
| Runtime cost | ~15 particles; overdraw-bound | 382 maxParticles; fill-rate light |
| Camera robustness | Billboard-only; degrades at steep angles | True 3D particles; robust |
| Resolution behavior | Fixed by sheet (128 px/m standard contains it) | Resolution-independent |
| Style read | Authentically pixel — deliberate HD-2D flavor | Stylized-particle — matches the locked low-poly direction natively |
| Determinism (C++ parity) | Frame index from sim tick — clean | Seeded curves — already the mapping's design |
| Format readiness | **Blocked on v2 extension (§4)** | **Valid v1 today (validated)** |

**Reading of the table:** B is the production route — it ships on today's format and
matches the game's art direction. A is the flavor route — worth the small v2 extension
*if* pixel-flavored effects become a deliberate signature (e.g. a retro spell school,
a guest-artist pack), not as the default pipeline.

---

## 6. Acceptance protocol (when this gets built)

1. Load the suite in the editor's VFX preview / client via `vfxToQuarks`; capture at
   gameplay camera (third-person, ~15 m) and at 5 m.
2. Pass criteria: silhouette reads as "fireball" at 15 m in a single frame grab;
   impact hold is perceptible without slow motion; suite validates + budgets green
   at medium; low-tier reduction set applied and re-checked (7 emitters / 298).
3. A/B: same capture angles for Version A once the v2 extension exists; judge on
   style fit against the locked art direction, not on nostalgia.
4. Visual verification is by Joey's eyes on a real client — sandbox headless GL
   cannot verify rendered output (standing limit); nothing in this spec claims a
   visual result.

**Decision this PoC informs:** (a) adopt the recipe route as the standard way
pixel-era effects enter the engine (no format work needed), and (b) yes/no on the
§4 v2 flipbook extension as a separate, later slice.

---

## Appendix A — Version B JSON (validated 2026-11-03)

The three files below are semantically identical to `effects/pfb-*.json` in this
folder (reformatted for print; the files are the canonical copies). Those exact
files were validated against `packages/art/src/vfx-schema.ts` @ origin/main via
`parseVfxEffect` on 2026-11-03: all PASS (control: on-main `fireball-impact.json`,
also PASS through the same harness).

### pfb-projectile.json

```json
{
  "authoredTier": "medium",
  "blendMode": "additive",
  "emitters": [
    {
      "bursts": [],
      "color": { "stops": [
        { "color": { "a": 1, "b": 1, "g": 1, "r": 1 }, "t": 0 },
        { "color": { "a": 1, "b": 0.63, "g": 0.95, "r": 1 }, "t": 0.35 },
        { "color": { "a": 0.9, "b": 0.1, "g": 0.48, "r": 1 }, "t": 0.7 },
        { "color": { "a": 0, "b": 0.01, "g": 0.09, "r": 0.48 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 0,
      "forces": [],
      "lifetime": { "points": [ { "t": 0, "value": 0.28 }, { "t": 1, "value": 0.4 } ] },
      "looping": true,
      "maxParticles": 48,
      "name": "core",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 90,
      "size": { "points": [ { "t": 0, "value": 0.4 }, { "t": 0.5, "value": 0.52 }, { "t": 1, "value": 0.36 } ] },
      "spawnShape": { "kind": "point" },
      "speed": 0,
      "spread": 0
    },
    {
      "bursts": [],
      "color": { "stops": [
        { "color": { "a": 0.9, "b": 0.12, "g": 0.55, "r": 1 }, "t": 0 },
        { "color": { "a": 0, "b": 0.02, "g": 0.1, "r": 0.55 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 0,
      "forces": [ { "coefficient": 1.2, "kind": "drag" }, { "frequency": 2.5, "intensity": 0.6, "kind": "turbulence" } ],
      "lifetime": { "points": [ { "t": 0, "value": 0.4 }, { "t": 1, "value": 0.6 } ] },
      "looping": true,
      "maxParticles": 80,
      "name": "trail",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 110,
      "size": { "points": [ { "t": 0, "value": 0.3 }, { "t": 1, "value": 0.05 } ] },
      "spawnShape": { "kind": "sphere", "radius": 0.1 },
      "speed": { "points": [ { "t": 0, "value": 0.4 }, { "t": 1, "value": 0.1 } ] },
      "spread": 0.4
    },
    {
      "bursts": [],
      "color": { "stops": [
        { "color": { "a": 1, "b": 0.25, "g": 0.75, "r": 1 }, "t": 0 },
        { "color": { "a": 0, "b": 0.02, "g": 0.2, "r": 0.8 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 0,
      "forces": [ { "acceleration": { "x": 0, "y": -2.5, "z": 0 }, "kind": "gravity" }, { "coefficient": 0.4, "kind": "drag" } ],
      "lifetime": { "points": [ { "t": 0, "value": 0.6 }, { "t": 1, "value": 1.0 } ] },
      "looping": true,
      "maxParticles": 40,
      "name": "embers",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 26,
      "size": { "points": [ { "t": 0, "value": 0.06 }, { "t": 1, "value": 0.03 } ] },
      "spawnShape": { "kind": "point" },
      "speed": { "points": [ { "t": 0, "value": 1.2 }, { "t": 1, "value": 2.2 } ] },
      "spread": 1.9
    }
  ],
  "id": "pfb-projectile",
  "name": "Pixel Fireball — Projectile (Recipe)",
  "texture": "vfx/soft-circle",
  "version": 1
}
```

### pfb-impact.json

```json
{
  "authoredTier": "medium",
  "blendMode": "additive",
  "emitters": [
    {
      "bursts": [ { "count": 18, "interval": 1, "repeat": 0, "time": 0 } ],
      "color": { "stops": [
        { "color": { "a": 1, "b": 1, "g": 1, "r": 1 }, "t": 0 },
        { "color": { "a": 0, "b": 0.3, "g": 0.8, "r": 1 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 0.25,
      "forces": [],
      "lifetime": { "points": [ { "t": 0, "value": 0.14 }, { "t": 1, "value": 0.2 } ] },
      "looping": false,
      "maxParticles": 18,
      "name": "flash",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 0,
      "size": { "points": [ { "t": 0, "value": 0.8 }, { "t": 1, "value": 1.4 } ] },
      "spawnShape": { "kind": "sphere", "radius": 0.15 },
      "speed": 0.5,
      "spread": 0
    },
    {
      "bursts": [ { "count": 46, "interval": 1, "repeat": 0, "time": 0 } ],
      "color": { "stops": [
        { "color": { "a": 1, "b": 0.85, "g": 0.98, "r": 1 }, "t": 0 },
        { "color": { "a": 0.9, "b": 0.1, "g": 0.55, "r": 1 }, "t": 0.45 },
        { "color": { "a": 0, "b": 0.01, "g": 0.08, "r": 0.55 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 0.9,
      "forces": [ { "acceleration": { "x": 0, "y": 1.5, "z": 0 }, "kind": "gravity" }, { "coefficient": 2.2, "kind": "drag" } ],
      "lifetime": { "points": [ { "t": 0, "value": 0.5 }, { "t": 1, "value": 0.8 } ] },
      "looping": false,
      "maxParticles": 46,
      "name": "burst",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 0,
      "size": { "points": [ { "t": 0, "value": 0.34 }, { "t": 1, "value": 0.06 } ] },
      "spawnShape": { "kind": "sphere", "radius": 0.28 },
      "speed": { "points": [ { "t": 0, "value": 7 }, { "t": 1, "value": 2.5 } ] },
      "spread": 1.35
    },
    {
      "bursts": [ { "count": 40, "interval": 1, "repeat": 0, "time": 0 } ],
      "color": { "stops": [
        { "color": { "a": 1, "b": 0.4, "g": 0.85, "r": 1 }, "t": 0 },
        { "color": { "a": 0, "b": 0.05, "g": 0.35, "r": 1 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 0.25, "z": 0 },
      "duration": 0.6,
      "forces": [ { "acceleration": { "x": 0, "y": -6, "z": 0 }, "kind": "gravity" }, { "coefficient": 0.8, "kind": "drag" } ],
      "lifetime": { "points": [ { "t": 0, "value": 0.35 }, { "t": 1, "value": 0.55 } ] },
      "looping": false,
      "maxParticles": 40,
      "name": "spark-ring",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 0,
      "size": { "points": [ { "t": 0, "value": 0.07 }, { "t": 1, "value": 0.02 } ] },
      "spawnShape": { "kind": "disc", "normal": { "x": 0, "y": 1, "z": 0 }, "radius": 0.1 },
      "speed": { "points": [ { "t": 0, "value": 6 }, { "t": 1, "value": 9 } ] },
      "spread": 1.45
    },
    {
      "bursts": [],
      "color": { "stops": [
        { "color": { "a": 0.95, "b": 0.12, "g": 0.6, "r": 1 }, "t": 0 },
        { "color": { "a": 0, "b": 0.01, "g": 0.1, "r": 0.6 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 0.55,
      "forces": [ { "acceleration": { "x": 0, "y": 3.2, "z": 0 }, "kind": "gravity" }, { "frequency": 3.0, "intensity": 1.4, "kind": "turbulence" } ],
      "lifetime": { "points": [ { "t": 0, "value": 0.4 }, { "t": 1, "value": 0.65 } ] },
      "looping": false,
      "maxParticles": 48,
      "name": "tongues",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 70,
      "size": { "points": [ { "t": 0, "value": 0.3 }, { "t": 1, "value": 0.05 } ] },
      "spawnShape": { "angle": 0.5, "height": 0.3, "kind": "cone", "radius": 0.22 },
      "speed": { "points": [ { "t": 0, "value": 2.2 }, { "t": 1, "value": 3.4 } ] },
      "spread": 0.2
    },
    {
      "bursts": [ { "count": 26, "interval": 1, "repeat": 0, "time": 0.05 } ],
      "color": { "stops": [
        { "color": { "a": 1, "b": 0.2, "g": 0.7, "r": 1 }, "t": 0 },
        { "color": { "a": 0, "b": 0.02, "g": 0.15, "r": 0.7 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 1.1,
      "forces": [ { "acceleration": { "x": 0, "y": -7.5, "z": 0 }, "kind": "gravity" }, { "coefficient": 0.5, "kind": "drag" } ],
      "lifetime": { "points": [ { "t": 0, "value": 0.8 }, { "t": 1, "value": 1.3 } ] },
      "looping": false,
      "maxParticles": 26,
      "name": "fall-embers",
      "position": { "x": 0, "y": 0, "z": 0 },
      "rate": 0,
      "size": { "points": [ { "t": 0, "value": 0.05 }, { "t": 1, "value": 0.02 } ] },
      "spawnShape": { "kind": "sphere", "radius": 0.3 },
      "speed": { "points": [ { "t": 0, "value": 3 }, { "t": 1, "value": 5 } ] },
      "spread": 2.6
    }
  ],
  "id": "pfb-impact",
  "name": "Pixel Fireball — Impact (Recipe)",
  "texture": "vfx/soft-circle",
  "version": 1
}
```

### pfb-smoke.json

```json
{
  "authoredTier": "medium",
  "blendMode": "normal",
  "emitters": [
    {
      "bursts": [ { "count": 10, "interval": 1, "repeat": 0, "time": 0.15 } ],
      "color": { "stops": [
        { "color": { "a": 0.55, "b": 0.45, "g": 0.36, "r": 0.42 }, "t": 0 },
        { "color": { "a": 0, "b": 0.27, "g": 0.21, "r": 0.24 }, "t": 1 }
      ]},
      "direction": { "x": 0, "y": 1, "z": 0 },
      "duration": 1.6,
      "forces": [
        { "acceleration": { "x": 0, "y": 0.8, "z": 0 }, "kind": "gravity" },
        { "frequency": 1.6, "intensity": 0.8, "kind": "turbulence" },
        { "coefficient": 0.6, "kind": "drag" }
      ],
      "lifetime": { "points": [ { "t": 0, "value": 0.9 }, { "t": 1, "value": 1.4 } ] },
      "looping": false,
      "maxParticles": 36,
      "name": "puffs",
      "position": { "x": 0, "y": 0.1, "z": 0 },
      "rate": 14,
      "size": { "points": [ { "t": 0, "value": 0.35 }, { "t": 1, "value": 0.95 } ] },
      "spawnShape": { "kind": "sphere", "radius": 0.25 },
      "speed": { "points": [ { "t": 0, "value": 0.7 }, { "t": 1, "value": 1.1 } ] },
      "spread": 0.7
    }
  ],
  "id": "pfb-smoke",
  "name": "Pixel Fireball — Smoke (Recipe, companion)",
  "texture": "vfx/soft-circle",
  "version": 1
}
```
