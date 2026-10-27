# feat/model-synthesis-unity-decomposition (PR #437)

## Continuous Model Synthesis, Inverse Procedural Modeling, and Architectural Grammar

### Overview
This feature introduces continuous spatial model synthesis, inverse procedural modeling, and learned architectural scene grammar for procedural dungeon construction in the `@mmo-engine/synthesis` package.

### Key Capabilities & Invariants
1. **Decomposition of Unity Scene**:
   - Decomposed `POLYGON_Dungeons_Demo_Scene.fbx` (3,376 child objects across 598 unique parts) into 10 spatial assemblies and extracted a learned architectural adjacency grammar.
2. **Architectural Archetypes**:
   - Synthesizes distinct dungeon archetypes: Pillared Crypt & Tomb Hall, Grand Boss Colosseum, and Multi-Level Staircase Descent & Loft.
   - Enforces continuous foundation floor plates, inward-facing sealed perimeter walls, tectonic colonnades, and second-level mezzanine lofts.
3. **Circulation Stairs Alignment & Flush Connection**:
   - Reoriented stairs 180° (`yawQuat(0)`) so the bottom step meets ground level ($Z = 0.0\text{m}, Y = 0.0\text{m}$) and the top step meets the loft deck ($Z = -5.0\text{m}, Y = 3.5\text{m}$) with zero vertical step discontinuity.
4. **Load-Bearing Structural Invariant (`isConnectingTwoFloors`)**:
   - Stairs must bridge a lower floor and an upper floor with $\Delta Y \ge 1.5\text{m}$.
   - Pillars must sit on a lower floor and directly support an upper mezzanine deck or overhead vaulted ceiling/roof arches.
   - Floor proximity uses half-cell Chebyshev box bounds (`dx <= 3.8m, dz <= 3.8m, dy <= 1.0m`), ensuring proper connectivity across 5.0m floor tile grids.
5. **Navigational Visibility & Visual Affordances**:
   - Twin guiding torch braziers at the base of the stairs ($X = \pm 2.4\text{m}, Z = 0.5\text{m}$) casting warm focal illumination.
   - Flanking handrails/balustrades along stair flanks ($X = \pm 2.1\text{m}$).
   - Grand 14-step profile ($3.8\text{m}$ wide) with high-contrast highlighted stone treads.
   - Architectural cutaway overview rendering in Three.js preview.
6. **In-Engine Locomotion Playtest**:
   - Automated Playwright WebGL playtest validating real $1.80\text{m}$ character capsule ascension from ground hall to second-level loft.
