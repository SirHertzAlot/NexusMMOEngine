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

## npm packages in the production tree

189 packages resolve into the production dependency tree of this
repository. Their licences, counted:

| Licence | Packages |
| --- | --- |
| MIT | 152 |
| Apache-2.0 | 22 |
| ISC | 8 |
| BSD-3-Clause | 2 |
| MPL-2.0 | 1 |
| Zlib | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |
| (not declared) | 1 |

Each package's own licence text travels inside the package, under
`node_modules/<name>/`, and is reproduced there by `npm install`.

<details>
<summary>Full list (189 packages)</summary>

| Package | Version | Licence |
| --- | --- | --- |
| `@babel/runtime` | 7.29.7 | MIT |
| `@dgreenheck/ez-tree` | 1.1.0 | MIT |
| `@dimforge/rapier3d-compat` | 0.12.0 | Apache-2.0 |
| `@epic-web/invariant` | 1.0.0 | MIT |
| `@mediapipe/tasks-vision` | 0.10.17 | Apache-2.0 |
| `@monogrid/gainmap-js` | 3.4.0 | MIT |
| `@petamoriken/float16` | 3.9.3 | MIT |
| `@phc/format` | 1.0.0 | MIT |
| `@pmndrs/detect-gpu` | 6.0.24 | MIT |
| `@react-three/drei` | 10.7.9 | MIT |
| `@react-three/fiber` | 9.8.1 | MIT |
| `@react-three/postprocessing` | 3.1.3 | MIT |
| `@surrealdb/cbor` | 2.0.0-alpha.4 | Apache-2.0 |
| `@surrealdb/node` | 3.1.0 | Apache-2.0 |
| `@surrealdb/node-native` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-darwin-arm64` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-darwin-x64` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-linux-arm64-gnu` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-linux-arm64-musl` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-linux-x64-gnu` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-linux-x64-musl` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-win32-arm64-msvc` | 3.3.5 | Apache-2.0 |
| `@surrealdb/node-native-win32-x64-msvc` | 3.3.5 | Apache-2.0 |
| `@surrealdb/sqon` | 0.2.0 | Apache-2.0 |
| `@takram/three-atmosphere` | 0.19.1 | MIT |
| `@takram/three-geospatial` | 0.9.1 | MIT |
| `@three.ez/instanced-mesh` | 0.3.16 | MIT |
| `@tweenjs/tween.js` | 23.1.3 | MIT |
| `@types/draco3d` | 1.4.10 | MIT |
| `@types/offscreencanvas` | 2019.7.3 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-reconciler` | 0.28.9 | MIT |
| `@types/stats.js` | 0.17.4 | MIT |
| `@types/three` | 0.186.0 | MIT |
| `@types/webxr` | 0.5.24 | MIT |
| `@use-gesture/core` | 10.3.1 | MIT |
| `@use-gesture/react` | 10.3.1 | MIT |
| `accepts` | 2.0.0 | MIT |
| `animouse` | 0.8.0 | MIT |
| `argon2` | 0.45.1 | MIT |
| `astronomy-engine` | 2.1.19 | MIT |
| `base64-js` | 1.5.1 | MIT |
| `better-sqlite3` | 13.0.3 | MIT |
| `bidi-js` | 1.1.0 | MIT |
| `bitecs` | 0.3.40 | MPL-2.0 |
| `body-parser` | 2.3.0 | MIT |
| `buffer` | 6.0.3 | MIT |
| `bvh.js` | 0.0.13 | MIT |
| `bytes` | 3.1.2 | MIT |
| `call-bind-apply-helpers` | 1.0.2 | MIT |
| `call-bound` | 1.0.4 | MIT |
| `camera-controls` | 3.1.2 | MIT |
| `content-disposition` | 1.1.0 | MIT |
| `content-type` | 1.0.5 | MIT |
| `content-type` | 2.1.0 | MIT |
| `cookie` | 0.7.2 | MIT |
| `cookie-signature` | 1.2.2 | MIT |
| `cross-env` | 10.1.0 | MIT |
| `cross-env` | 7.0.3 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `csstype` | 3.2.3 | MIT |
| `debug` | 4.4.3 | MIT |
| `depd` | 2.0.0 | MIT |
| `dequal` | 2.0.3 | MIT |
| `detect-gpu` | 5.0.70 | MIT |
| `dockview` | 8.8.0 | MIT |
| `dockview-core` | 8.8.0 | MIT |
| `dockview-react` | 8.8.0 | MIT |
| `draco3d` | 1.5.7 | Apache-2.0 |
| `dunder-proto` | 1.0.1 | MIT |
| `ee-first` | 1.1.1 | MIT |
| `encodeurl` | 2.0.0 | MIT |
| `es-define-property` | 1.0.1 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `es-object-atoms` | 1.1.2 | MIT |
| `escape-html` | 1.0.3 | MIT |
| `etag` | 1.8.1 | MIT |
| `eventail` | 0.2.12 | MIT |
| `express` | 5.2.1 | MIT |
| `fflate` | 0.6.11 | MIT |
| `fflate` | 0.8.3 | MIT |
| `finalhandler` | 2.1.1 | MIT |
| `flatbuffers` | 25.9.23 | Apache-2.0 |
| `forwarded` | 0.2.0 | MIT |
| `fresh` | 2.0.0 | MIT |
| `function-bind` | 1.1.2 | MIT |
| `get-intrinsic` | 1.3.0 | MIT |
| `get-proto` | 1.0.1 | MIT |
| `glsl-noise` | 0.0.0 | MIT |
| `gltfpack` | 1.3.0 | MIT |
| `gopd` | 1.2.0 | MIT |
| `has-symbols` | 1.1.0 | MIT |
| `hasown` | 2.0.4 | MIT |
| `hls.js` | 1.7.3 | Apache-2.0 |
| `http-errors` | 2.0.1 | MIT |
| `iconv-lite` | 0.7.3 | MIT |
| `ieee754` | 1.2.1 | BSD-3-Clause |
| `immediate` | 3.0.6 | MIT |
| `inherits` | 2.0.4 | ISC |
| `ipaddr.js` | 1.9.1 | MIT |
| `is-promise` | 2.2.2 | MIT |
| `is-promise` | 4.0.0 | MIT |
| `isexe` | 2.0.0 | ISC |
| `its-fine` | 2.1.1 | MIT |
| `lie` | 3.3.0 | MIT |
| `lil-gui` | 0.21.0 | MIT |
| `maath` | 0.10.8 | MIT |
| `math-intrinsics` | 1.1.0 | MIT |
| `media-typer` | 1.1.1 | MIT |
| `merge-descriptors` | 2.0.0 | MIT |
| `meshline` | 3.3.1 | MIT |
| `meshoptimizer` | 1.1.1 | MIT |
| `mime-db` | 1.54.0 | MIT |
| `mime-types` | 3.0.2 | MIT |
| `ms` | 2.1.3 | MIT |
| `n8ao` | 2.0.1 | ISC |
| `negotiator` | 1.1.0 | MIT |
| `node-addon-api` | 8.9.2 | MIT |
| `node-gyp-build` | 4.8.4 | MIT |
| `object-inspect` | 1.13.4 | MIT |
| `on-finished` | 2.4.1 | MIT |
| `once` | 1.4.0 | ISC |
| `parseurl` | 1.3.3 | MIT |
| `path-key` | 3.1.1 | MIT |
| `path-to-regexp` | 8.4.2 | MIT |
| `postprocessing` | 6.39.5 | Zlib |
| `potpack` | 1.0.2 | ISC |
| `promise-worker-transferable` | 1.0.4 | Apache-2.0 |
| `proxy-addr` | 2.0.8 | MIT |
| `qs` | 6.16.0 | BSD-3-Clause |
| `quarks.core` | 0.17.1 | MIT |
| `range-parser` | 1.3.0 | MIT |
| `raw-body` | 3.0.2 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `react-merge-refs` | 3.0.2 | MIT |
| `react-use-measure` | 2.1.7 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `router` | 2.2.0 | MIT |
| `safer-buffer` | 2.1.2 | MIT |
| `scheduler` | 0.28.0 | MIT |
| `send` | 1.2.1 | MIT |
| `serve-static` | 2.2.1 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `side-channel` | 1.1.1 | MIT |
| `side-channel-list` | 1.0.1 | MIT |
| `side-channel-map` | 1.0.1 | MIT |
| `side-channel-weakmap` | 1.0.2 | MIT |
| `stats-gl` | 2.4.2 | MIT |
| `stats.js` | 0.17.0 | MIT |
| `statuses` | 2.0.2 | MIT |
| `surrealdb` | 2.2.0 | Apache-2.0 |
| `suspend-react` | 0.1.3 | MIT |
| `swr` | 2.5.1 | MIT |
| `tagged-tag` | 1.0.0 | MIT |
| `three` | 0.170.0 | MIT |
| `three` | 0.186.1 | MIT |
| `three-mesh-bvh` | 0.8.3 | MIT |
| `three-mesh-bvh` | 0.9.15 | MIT |
| `three-nebula` | 13.3.0 | MIT |
| `three-stdlib` | 2.36.1 | MIT |
| `three.quarks` | 0.17.1 | MIT |
| `tiny-invariant` | 1.3.3 | MIT |
| `toidentifier` | 1.0.1 | MIT |
| `troika-three-text` | 0.52.5 | MIT |
| `troika-three-utils` | 0.52.5 | MIT |
| `troika-worker-utils` | 0.52.0 | MIT |
| `tslib` | 2.8.1 | 0BSD |
| `tunnel-rat` | 0.1.2 | MIT |
| `type-fest` | 5.10.0 | (MIT OR CC0-1.0) |
| `type-is` | 2.1.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `unpipe` | 1.0.0 | MIT |
| `url-join` | 5.0.0 | MIT |
| `use-sync-external-store` | 1.7.0 | MIT |
| `utility-types` | 3.11.0 | MIT |
| `uuidv7` | 1.2.1 | Apache-2.0 |
| `uWebSockets.js` | 20.71.0 | Apache-2.0 |
| `vary` | 1.1.2 | MIT |
| `webgl-constants` | 1.1.1 | (not declared) |
| `webgl-sdf-generator` | 1.1.1 | MIT |
| `which` | 2.0.2 | ISC |
| `wrappy` | 1.0.2 | ISC |
| `ws` | 8.22.0 | MIT |
| `zod` | 4.6.7 | MIT |
| `zustand` | 4.5.7 | MIT |
| `zustand` | 5.0.15 | MIT |

</details>

## Licence texts

The full text of each licence used by the vendored libraries above.

### MIT License

Reproduced from `packages/addons/physics/third_party/JoltPhysics/LICENSE`.

```
Copyright 2021 Jorrit Rouwe

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Apache License 2.0

Reproduced from `packages/addons/geometry/third_party/manifold/LICENSE`.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### Mozilla Public License 2.0

Reproduced from `packages/addons/picg/third_party/CDT/LICENSE`.

```
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in 
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

### zlib License

Reproduced from `packages/addons/navigation/third_party/RecastNavigation/License.txt`.

```
Copyright (c) 2009 Mikko Mononen memon@inside.org

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
claim that you wrote the original software. If you use this software
in a product, an acknowledgment in the product documentation would be
appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

### Boost Software License 1.0

Reproduced from `packages/addons/geometry/third_party/Clipper2/LICENSE`.

```
Boost Software License - Version 1.0 - August 17th, 2003

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to
do so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer,
must be included in all copies of the Software, in whole or in part, and
all derivative works of the Software, unless such copies or derivative
works are solely in the form of machine-executable object code generated by
a source language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

---

Generated by `scripts/gen-notices.mjs` from `package-lock.json` and the
in-tree licence files. Re-run it after changing dependencies:

```
node scripts/gen-notices.mjs
```
