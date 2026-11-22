# Third-party notices

This file lists the third-party software included in builds of this engine,
with the attribution each licence asks for. **Ship it with the game** — in a
credits screen, an "about" page, or alongside the binary. A studio building
on this engine can include this file as-is; everything in it is in their
build too.

Analysis behind it, including what each licence obliges:
[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md). Last regenerated 2026-11-22.

Art is not covered here. Licensed art under `/assets/` ships with no build;
the engine runs on stand-ins and a game brings its own content pack.

## Native libraries compiled into the server

Vendored in `packages/addons/*/third_party/` and linked into the `.node`
addons.

| Library | Version / commit | Licence | Copyright | Upstream |
| --- | --- | --- | --- | --- |
| Jolt Physics | `074b2a84` | MIT | © 2021 Jorrit Rouwe | https://github.com/jrouwe/JoltPhysics |
| Recast & Detour | vendored 2026 | zlib | © 2009 Mikko Mononen | https://github.com/recastnavigation/recastnavigation |
| FastNoise2 | `06969a19` | MIT | © 2020 Jordan Peck | https://github.com/Auburn/FastNoise2 |
| FastSIMD | ships with FastNoise2 | MIT | © 2022 Jordan Peck | https://github.com/Auburn/FastSIMD |
| manifold | `v3.5.4` (`ce50d78`) | Apache-2.0 | © The Manifold authors | https://github.com/elalish/manifold |
| Clipper2 | `Clipper2_2.0.1` (`21ebba0`) | BSL-1.0 | © 2010-2025 Angus Johnson | https://github.com/AngusJohnson/Clipper2 |
| PICG / pcg-core | `0.1.2` (`d10074f`) | Apache-2.0 | © The PCG-AI authors | https://github.com/DJ-Huang/PCG-AI |
| CDT | `7bd85e4` | **MPL-2.0** | the CDT authors (files carry the MPL header, no copyright line) | https://github.com/artem-ogre/CDT |
| meshoptimizer | `v1.3` | MIT | © 2016-2026 Arseny Kapoulkine | https://github.com/zeux/meshoptimizer |
| nlohmann/json | `v3.11.3` | MIT | © 2013-2023 Niels Lohmann | https://github.com/nlohmann/json |
| `valgrind.h`, `callgrind.h` | — | BSD-style (single-file exception to Valgrind's GPL-2) | © 2000-2017 Julian Seward | https://valgrind.org |

### Libraries bundled inside those libraries

Upstream carries these; they compile in with their hosts and their notices
must travel too.

| File | Inside | Licence | Copyright |
| --- | --- | --- | --- |
| `include/predicates.h` | CDT | BSD-3-Clause | © 2019 William C. Lenthe |
| `src/svd.h` | manifold | MIT | © 2019 wi-re; © 2023 The Manifold Authors |
| `src/disjoint_sets.h` | manifold | permissive, as stated in the file | © 2015 Wenzel Jakob |
| `include/manifold/math.h` (musl-derived `atan2`, `tan`) | manifold | "Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is preserved." | © 1993 Sun Microsystems, Inc., developed at SunPro/SunSoft |
| UTF-8 decoder, Grisu2 `dtoa` | nlohmann/json | MIT | © 2008-2009 Björn Hoehrmann; © 2009 Florian Loitsch |

**MPL-2.0 source offer.** CDT is included unmodified. Its source, in the
form used here, is the upstream repository at commit `7bd85e4`; a copy also
ships in this repository at `packages/addons/picg/third_party/CDT/`. The same
offer applies to the `bitecs` npm package (MPL-2.0, unmodified, pinned at
0.3.40).

`pcg-core` carries two local changes, each marked in source with the string
`NexusMMOEngine`: Assimp support is made optional, and its embedded node
manifest is split across string literals. Recorded here per Apache-2.0 §4(b).

## Source adapted into this engine

Code derived from these projects, kept under their original licences. Each
adapted file names its source in its header comment.

| Project | Licence | Copyright | Where |
| --- | --- | --- | --- |
| Dungeon Forge (`threejs-procedural-dungeon`) | MIT | © 2026 Majid Manzarpour | `packages/dungeon/` — see its `THIRD_PARTY_NOTICES.md` |
| ProceduralTerrains | MIT | © 2026 ZyFou | `apps/client/src/render/` — sky, water |
| Next.js Nights galaxy shader | MIT | Vercel Labs | `apps/client/src/render/` |
| ToonShading | MIT | © KallkaGo | `apps/client/src/render/` |
| three.quarks editor | MIT | © 2019 Forrest Sun | `apps/editor/src/vfx/` |
| hairline 0.5.1 | MIT | © 2026 Lucas Marques | `site/vendor/hairline/`, unmodified |
| ProceduralBuildingsThreeJS | MIT | © 2026 mohamedachrefelouafi | `third_party/procedural-buildings/`, vendored, not yet used by engine code |

Per-app detail, with the full licence text of each adapted source, lives in
`apps/client/THIRD_PARTY_NOTICES.md` and
`packages/dungeon/THIRD_PARTY_NOTICES.md`.

## Agent skill sets vendored for development

Not part of any shipped build; listed because they are redistributed with
this repository.

| Project | Licence | Where |
| --- | --- | --- |
| Open 3D Skills (8 skills) | MIT | `.agents/skills/` |
| 3Dviz Pro Max | MIT | `.agents/skills/3dviz-pro-max/` |
| Blender MCP | MIT | `.agents/skills/blender-vfx/vendor/blender-mcp/` |

## Build tools redistributed in this repository

| Tool | Version | Licence | Where |
| --- | --- | --- | --- |
| FlatBuffers `flatc` (Linux, macOS, Windows) | 25.12.19 | Apache-2.0 | `third_party/flatc/`, licence at `third_party/flatc/LICENSE` |
