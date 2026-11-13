---
name: blender-vfx
description: Create stylized 3D VFX in Blender, driven by an agent over MCP. Covers the five-node stylized-effect workflow (time clock + easing, per-object phase ramps, noise-mask dissolve driven by an age attribute, gradient swirl via animated mapping), the vendored Blender MCP server (vendor/blender-mcp) that lets an agent inspect, script, and screenshot Blender, and the Ubuntu LTS install (install-ubuntu-lts.sh). Use when someone asks for a Blender VFX, a magic/energy effect, a shader-node effect build, agent control of Blender, or a flipbook bake for the game's VFX recipes.
---

# Blender VFX via MCP

Two halves: a **technique** (how stylized effects are built in
Blender's node editors) and a **capability** (an MCP server that lets
an agent drive Blender directly — execute Python, inspect the scene,
screenshot the viewport, iterate). The technique is distilled from
Good Good 3D's workflow reel (2026-09-19); the capability is the
vendored Blender MCP (MIT, Siddharth Ahuja) in `vendor/blender-mcp/`.

## Capability: Blender MCP

- Architecture: an MCP server (Python, `vendor/blender-mcp/src/`)
  talks over a socket to `addon.py` running inside Blender. The
  agent's workhorse tool is arbitrary Blender Python execution;
  scene/object inspection and viewport screenshots are the
  verification tools. **Frames, not assurances:** never report an
  effect as built without a viewport screenshot or render.
- Extras in the server: Poly Haven asset fetching and third-party
  generation integrations (Hyper3D etc.) — optional, external,
  off by default in our use.
- Telemetry: per the vendored `TERMS_AND_CONDITIONS.md`, content
  collection is opt-in; a minimal anonymous usage record exists.
  House rule: leave telemetry consent OFF in the addon preferences.
- Install on Ubuntu LTS: run `install-ubuntu-lts.sh` (installs
  Blender + uv, stages the addon, prints the MCP client config).

## Technique: the five-node core

Stylized magic/energy effects (rings, domes, spirals, crescents) from
one reusable node pattern. Timing and colour are the craft; the
nodes are few.

1. **One master clock.** Scene Time → Map Range (frame range → 0..1)
   → Float Curve for hand-shaped easing. Every animated value in the
   effect derives from this clock, so the whole effect retimes by
   editing one curve.
2. **Per-object phase.** A Color Ramp remaps the clock per object, so
   layered copies of one effect start and end at offsets instead of
   in lockstep.
3. **Age-driven dissolve mask.** Noise Texture → Greater Than for a
   hard-edged mask, softened with a Mix node (Linear Light). A stored
   float attribute named `age` (0 at birth → 1 at death, written by
   the geometry side) drives the mask over the effect's life, so it
   grows, burns, and dies with its carrier.
4. **Swirl by mapping, not by W.** Center the texture coordinates
   (−0.5), Separate XYZ, rotate by an amount weighted by a radial
   gradient (tighter toward the center), and animate the Mapping
   node's **location** with the clock. Do not animate a 4D texture's
   W input — mapping animation is cheaper and translates to game
   engines; W-noise does not.
5. **Layer simple materials.** Each material stays minimal; richness
   comes from layering several effects, not from one mega-network.
   All experiments start from noise or voronoi — two textures carry
   the whole style.

## Getting it into the game

Blender is an **authoring** surface here; the runtime stays
three.quarks + the VFX recipe schema. Two export lanes:

- **Flipbook bake:** render the effect's life to a sprite sheet →
  recipe flipbook (the pixel-fireball lane; schema-v2 flipbook rules
  apply).
- **Recipe translation:** rebuild the pattern natively as a recipe —
  clock/easing → lifetime curves, age attribute → particle age,
  noise-mask dissolve → the recipe's dissolve shader, swirl → UV
  rotation over life. The Blender build is the reference and the
  proof of timing/colour; the recipe is the shippable form.
- Style gate: output must sit inside the cel/low-poly direction —
  palette first, effect second.
