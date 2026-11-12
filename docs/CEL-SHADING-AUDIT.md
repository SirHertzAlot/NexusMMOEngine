# Cel-shading consistency audit (Phase 0)

Status: audit only. No rendering behaviour changes in this document. Phase 1
converges the client on one model and must re-issue the coverage table in
section 4 with every row either on the unified path or carrying a named
opt-out.

Scope read: `apps/client/src/render/**` (toon, shading, quality, terrain,
dungeon look, characters, props, prefabs, VFX, sky, water, UI-adjacent
meshes) and `packages/art/src/media/materials.ts` (`SHADING_COMPONENTS`,
`SHADING_KINDS`, the `shading` block validator).

## 1. How cel shading is applied today

Three pieces exist, and they are not connected by a single rule.

| Piece | File | What it does |
| --- | --- | --- |
| Toon patch | `apps/client/src/render/toon/toon-material.ts` | `applyToon(material, opts)` patches any `MeshStandardMaterial` in place (half-Lambert band, ramp row lookup, rim, optional light map / matcap / face shadow). Idempotent per material. |
| Outline | `apps/client/src/render/toon/outline.ts` | `addOutline(mesh, OutlineMaterial)` adds an inverted-hull mesh. Only the character kit calls it. |
| Shading module | `apps/client/src/render/shading/shading.ts` | Maps a `ShadingKind` (`model`, `placeholder`, `prefab`) to components (`toon`, `standard`) using content (`content/materials/materials.json` `shading` block) with engine defaults. Renderers opt in by calling `applyShading` / `applyShadingToMaterial`. |
| Quality | `apps/client/src/render/quality.ts` | `outlines: boolean` per tier. Only the character kit reads the flag's intent; it is not wired to any other outline. |

**Why it is inconsistent.** Toon is opt-in per call site. Nothing enumerates
world geometry and asserts that it passed through `shading.ts`. A new
renderer that builds a `MeshStandardMaterial` directly silently renders
smooth PBR. The art package's `SHADING_COMPONENTS` union (`toon`,
`standard`) and the client's patch agree on the names, but nothing checks
that a material the art package authors as cel is actually shaded cel at
runtime.

## 2. The D1 shader: design in the repo, implementation not on main

Searched the whole repo (`git grep`) for `libD1`, `D1Diffuse`, `D1`, `ramp`,
and `shader library`.

- **The design exists.** `docs/library/mmo-engine-shader-rnd/STYLIZED-RENDERING-DNA.md`
  section "D1 — Banded diffuse via 1D ramp lookup (the cel core)" defines it:
  `diffuse = ramp(saturate(NdotL * 0.5 + 0.5))`, shadow colour taken from
  the ramp rather than multiplied to black, ramps as versioned assets with
  a `shadowRamp` slot and `rampFeather`, a bake-time generator from a
  palette triple, and a validator (≤ 8 bands, luminance monotonic). Other
  docs (`NEXT-ROADMAP-2026-10-26.md`, `ANIMATION-PIPELINE-AUDIT.md`) refer
  to a "D1 shader bench" still owed on real GPU hardware.
- **The implementation is not on main.** `libD1Diffuse`, the ramp-as-asset
  loader, and the `arlo/shader-library-seed` branch have no ref in this
  clone of `origin/main` (d5b506bf) or on the remote. Those files can't be
  read here.
- **Main already implements the D1 idea** in `toon/toon-material.ts`: a
  shadow ramp texture with 10 rows (5 materials × day/night), shadow colour
  from the ramp, a half-Lambert band, and per-kind row selection through
  `shading.rows` in content. It does not yet have the D1 spec's bake-time
  generator, its validator, or per-material `shadowRamp` / `rampFeather`
  slots. `vfx/materials/ColorRampMaterial.ts` is a scalar-to-gradient VFX
  material and is not the cel diffuse.
- **Decision for Phase 1: the D1 design is the convergence target, and the
  main-branch ramp is its implementation.** Phase 1 adds the D1 pieces
  (authored ramp asset with validator, feather policy from `quality.ts`) on
  top of `toon-material.ts`. It does not import the unseen branch code. If
  that branch is pushed later, it gets compared against this in a separate
  decision.

## 3. Shading paths by material

| Path | Where | Shades |
| --- | --- | --- |
| A. Toon via `shading.ts` (`model` kind) | `entity-layer.ts:969`, `instanced-props.ts:147`, `synty-props.ts:191` | Creature/NPC models, instanced prop models, Synty props |
| B. Toon via `shading.ts` (`placeholder` kind) | `entity-layer.ts:975,985`, `instanced-props.ts:146` | Stand-in shapes for entities without a model |
| C. Toon via `shading.ts` (`prefab` kind) | `prefab/gallery.ts:29`, `prefab/prefab-builder.ts` | Composed prefab entities |
| D. Toon direct (`applyToon`) | `character/character-kit.ts:163` | Modular characters (own `CharacterStyle`), plus inverted-hull outlines `character-kit.ts:243` |
| E. Smooth PBR (`MeshStandardMaterial`, no toon) | `terrain/terrain-material.ts:298`, `dungeon-look.ts:100`, `first-person-rig.ts:405-472`, `npc-markers.ts:63-64`, `animal/corpse-proxy.ts:18`, `dungeon-entrances.ts:45`, `assets.ts:71,101` | Terrain, dungeon stone, first-person arms and weapon, NPC marker bodies, corpse proxy, portal stone, asset fallbacks |
| F. Custom ShaderMaterial | `water-material.ts:202`, `sky/day-sky.ts:75`, `sky/star-field.ts:251` | Water, sky dome, stars |
| G. Unlit (`MeshBasicMaterial`) | `vfx/quarks-fx.ts:348`, `first-person-rig.ts:625` (swing trail), `dungeon-entrances.ts:44,46`, `drop-labels.ts:62` | Particles, sword trail, portal ring/void, labels |

## 4. Coverage table

Rendered object class × shading path today. "Opt-out" means a deliberate
non-cel choice that Phase 1 must record with a reason.

| Object class | Shading path today | Cel today? | Phase 1 target |
| --- | --- | --- | --- |
| Terrain | E (`terrain-material.ts`) | No | Cel (default) |
| Buildings / dungeon stone | E (`dungeon-look.ts`, flatShading) | No | Cel (default) |
| Props (instanced models) | A / B (`instanced-props.ts`) | Yes | Cel (default) |
| Props (Synty) | A (`synty-props.ts`) | Yes | Cel (default) |
| Characters (modular) | D (`character-kit.ts`) | Yes, with outlines | Cel + outline (default) |
| Creatures / NPC models | A (`entity-layer.ts`) | Yes | Cel (default) |
| Creature placeholders | B | Yes | Cel (default) |
| Prefab entities | C | Yes | Cel (default) |
| NPC markers (robe, skin) | E (`npc-markers.ts`) | No | Cel (default) |
| Corpse proxy | E (`corpse-proxy.ts`) | No | Cel (default) |
| First-person arms and weapon | E (`first-person-rig.ts`) | No | Cel (default); view-model is a world-geometry exception to decide in Phase 1 |
| Portal stone / void | E (`dungeon-entrances.ts`) | No | Cel (default) |
| Asset fallbacks | E (`assets.ts`) | No | Cel (default) |
| Water | F (`water-material.ts`) | n/a | **Opt-out: custom shader, own lighting** |
| Sky | F (`day-sky.ts`) | n/a | **Opt-out: sky dome, unlit** |
| Stars | F (`star-field.ts`) | n/a | **Opt-out: sky, unlit** |
| VFX particles | G (`quarks-fx.ts`) | n/a | **Opt-out: transparent VFX** |
| Sword swing trail | G (`first-person-rig.ts`) | n/a | **Opt-out: transparent VFX** |
| Portal ring | G (`dungeon-entrances.ts`) | n/a | **Opt-out: transparent VFX** |
| Labels | G (`drop-labels.ts`) | n/a | **Opt-out: editor/UI helper** |
| Impostors | Not located in this pass | Unknown | Phase 1 must locate and classify |

## 5. Outlines

- Only characters draw outlines today (`character-kit.ts:98,243`).
- The quality preset flag `outlines` (`quality.ts`) is documented as "toon
  outlines on characters" and is not read by any other renderer.
- Phase 1 applies the same rule as shading: outlines on by default for the
  same world classes, tier-gated by cost, off only via an opt-out record.

## 6. Gaps and risks found

1. Terrain, dungeon stone, and first-person meshes bypass `shading.ts`.
   Adding them is a visible change and must be checked on a GPU.
2. Nothing enforces the rule. A new `MeshStandardMaterial` in world code
   is silently smooth. Phase 1's registry test addresses this.
3. Impostor classes were not located in this pass and need classification.
4. Headless software-GL can confirm that code paths run. It cannot confirm
   how the output looks. Visual acceptance is left for a human on a GPU.

## 7. Phase 1 acceptance checklist

- [ ] Every row in section 4 is on the unified path or has a named opt-out.
- [ ] Opt-outs recorded in the material registry with a reason.
- [ ] One shared ramp asset and one feather policy sourced from `quality.ts`.
- [ ] Test: walks the material registry and fails on any world material
      that resolves to smooth PBR without an opt-out record.
- [ ] Stills checklist for noon, dusk and night, left for human GPU check.
