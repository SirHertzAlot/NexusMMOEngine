# Library incorporation manifest — 2026-11-13 pass

Every library touched in the 2026-11-10 → 13 evaluation run, with
its incorporation state and lane. "Incorporated" means an agent
working in this repo can consume it — as a dependency, a vendored
module, or a hot-loaded skill — not merely that a note exists.

| Library | State | Lane / notes |
|---|---|---|
| three.quarks | **In engine** (`apps/client` dependency) | Adopted VFX runtime; recipe converter targets it |
| ProceduralBuildingsThreeJS (MIT) | **Vendored module** — `third_party/procedural-buildings/` | Params in → building out; settlement-bake integration per its NEXUS-MODULE.md |
| Blender MCP (MIT) | **Vendored** — `.agents/skills/blender-vfx/vendor/blender-mcp/` | Agent→Blender control; Ubuntu LTS installer in the skill; telemetry off by house rule |
| Open 3D Skills (MIT) | **Vendored skills** — `.agents/skills/` (8 skills) | Hot-loaded via `.agents/skills/INDEX.md` |
| 3Dviz Pro Max (MIT) | **Vendored skill** — `.agents/skills/3dviz-pro-max/` (805 files) | Recipes/knowledge core; upstream capture archive not vendored |
| GSAP + React Bits | **Chosen, not yet installed** | Joey's motion-layer pick (2026-11-10); first trial surface TBD; anime.js declined as second engine (2026-11-13) |
| Casting Abilities (spline VFX demo) | **Reference only — cannot vendor** | Captioned repo URL returns 404 (checked 2026-11-13); design adopted in the engine note (curve emitter, schema-v2 candidate) |
| Grassworks (WebGPU grass) | **Not incorporable — commercial** | Paid product, licence unread; EVALUATE verdict; purchase + WebGPU strategy are Joey's decisions |
| Polyfork `.mjs` factories | **Not incorporable — licence** | Upstream terms forbid redistributing the source; local evaluation only. GLB meshes are CC BY 4.0 (local catalogue, CREDITS.md) |
| Casberry particle effects | **Recipes local, not vendored code** | Engine-schema recipes from the spike live in the VFX files; the site's export terms are unverified, so nothing exported from it ships |
| Spark (Gaussian splatting) | **R&D lane, not incorporated** | Shader R&D Exp 11; adoption waits on the cost/benefit gate (spillover experiment in the buildings adoption doc) |
| Quixel Megascans | **External library, account-gated** | Free on Fab (Nov 2026), Fab Standard License — use in own games GO, redistribution NO; claiming is Joey's Fab account action; local scaffold in the catalogue workspace |

Rule for the next pass: a library joins this manifest only with a
licence read and a named consumption path (dependency, third_party,
or skill). Anything else is a note, and notes live in `patches/` or
the research files — not in this table.
