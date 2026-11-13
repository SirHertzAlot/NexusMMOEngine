# Procedural Buildings — vendored standalone module

Vendored 2026-11-13 on Joey's direction ("utilize it standalone as a
module and pass params in procedurally to get an output").

- **Upstream:** https://github.com/achrefelouafi/ProceduralBuildingsThreeJS
  — **MIT** (© 2026 mohamedachrefelouafi); LICENSE and README in this
  folder are upstream's.
- **What it is:** Blender Geometry Nodes building generators
  re-implemented in TypeScript and verified against Blender itself
  (upstream: outputs match within 2e-4 m, `npm run verify`). The core
  is a **GN evaluator** (`src/nyc/gn.ts` — fields, 60 node types,
  Blender float32/hash semantics) shared by the building families
  (`src/nyc/`, `src/cn/`, Paris via `src/generator.ts`), with city
  layout in `src/city/` and a seeded RNG (`src/rng.ts`).

## The module contract (params in → building out)

`src/params.ts` + `src/generator.ts` are the surface. Parameters use
the **same names and ranges as the Blender modifier inputs**:

- `seed` — deterministic variation (upstream RNG is seeded; same
  seed, same building — matches the bake's hash discipline)
- `width`, `depth`, `floors` — massing
- bays X / Y, `dormers`, balcony type (Existing / Exterior),
  detail pattern — facade grammar
- `style` — family selection

Output: three.js geometry for one building instance.

## How the engine uses it

Bake-time only (our rule: bake-time code stays TS; only tick-hot
code earns C++). The settlement bake assigns a template family per
ward, narrows parameter ranges per lot (district rules), rolls the
seed per building, and calls this module for geometry — then the
texture pass (material masks → vertex-colour weathering → decals →
spillover layers) runs over the result. Design record:
`patches/PROCGEN-BUILDINGS-SYNTHESIS-ADOPTION.md`.

## Vendoring notes

- Included: `src/`, `tools/` (Blender export scripts), `blender/`
  (the .blend references), `docs/`, `index.html`, `package.json`,
  `package-lock.json`, LICENSE, README.
- **Excluded: `public/` (43 MB)** — the upstream demo's city-backdrop
  assets, not part of the generator. Pull from upstream if the demo
  page itself is ever needed.
- Standalone: this folder is deliberately **not** wired into the
  workspace build. It builds/runs on its own (`npm install`,
  `npm run dev`, `npm run verify`) until the settlement-bake
  integration is scheduled.
