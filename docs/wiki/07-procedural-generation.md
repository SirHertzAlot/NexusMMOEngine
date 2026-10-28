# 07. Procedural Generation & Spatial Synthesis


---

## 5. Architectural Synthesis: Staircase Handrail & Balustrade Alignment

Procedural dungeon synthesis (`@mmo-engine/synthesis`) incorporates continuous circulation geometry:
- **Incline Pitch Rotation**: Handrails align to exact slope pitch $\theta = \arctan(3.5\text{m} / 5.0\text{m}) \approx 34.99^\circ$ ($0.6109\text{ rad}$) and hypotenuse length $L = \sqrt{3.5^2 + 5.0^2} \approx 6.103\text{m}$.
- **Flank Alignment**: Rails flank stairwells at $X = \pm 2.00\text{m}$, centered at $Z = -2.50\text{m}, Y = \text{lowerY} + 2.20\text{m}$.
- **Flush Balcony Thresholds**: Loft balcony railings connect flush with stair handrail tops, eliminating horizontal traversal obstructions.
- **Architectural Balustrades**: Built via `createStairHandrailGeometry` featuring top rails, bottom runners, and vertical balusters.

[← Previous: Multi-Region World Coordination](06-multi-region-world.md) | [Back to Wiki Index](README.md) | [Next: Client & Viewport Mirror →](08-client-and-rendering.md)

---

## 1. Overview
The procedural generation toolchain creates vast, coherent game spaces ranging from multi-kilometer open-world biomes to intricate architectural interiors and multi-story dungeons.

---

## 2. Continuous Model Synthesis (`@mmo-engine/synthesis`)

Traditional procedural generation relies on discrete grid blocks (voxels or cubic tiles), which can create repetitive tiling artifacts and rigid layouts. The Continuous Model Synthesis engine ([`packages/synthesis`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/synthesis)) synthesizes tileless 3D spaces using continuous transforms:

```
3D Source Scene (FBX)
       │
       ▼ Decompose Scene (extractor.ts)
Decomposed Architectural Assemblies (Floors, Walls, Colonnades, Stairs)
       │
       ▼ Extract Learned Grammar (extractLearnedRuleSet)
Continuous Adjacency Rules (Frequency, Yaw Rotations, Offset Distributions)
       │
       ▼ Spatial Assembly Synthesizer (synthesizer.ts)
Coherent Procedural Level (Multi-level halls, boss arenas, lofts)
```

- **Solve Duration**: Generates 100–140 part structures in **5–15 ms**.
- **Memory Profile**: Zero garbage collection allocations during generation.

---

## 3. Universal Measurement System (UMS) & SI Standards

To ensure spaces feel authentic and physically functional for human avatars, the Universal Measurement System ([`packages/scene`](file:///c:/Users/user/Downloads/mmo-engine-full/packages/scene)) defines authoritative scale standards:

| Dimension / Metric | Standard Value | Rationale |
| :--- | :--- | :--- |
| **Coordinate System** | $1.0\text{ unit} = 1.0\text{ meter}$ | Pure SI metric standard across physics, assets, and shaders. |
| **Human Eye Height** | $1.65\text{ meters}$ | Authentic first-person camera horizon. |
| **Character Height / Radius** | $1.80\text{m} \times 0.25\text{m}$ | Player capsule collision geometry. |
| **Staircase Step Rise** | $0.25\text{ meters}$ | Matches human stride biomechanics. |
| **Floor Module Size** | $5.0\text{m} \times 5.0\text{m}$ | Architectural grid module standard. |

### Visual Perspective Tiers
UMS calculates vertical and horizontal visual angles ($\theta = 2 \arctan\frac{S}{2D}$) to classify spatial perception:
- **Intimate ($< 3\text{m}$)**: Narrow crawlspaces and catacomb tunnels ($> 45^\circ$ FoV occupancy).
- **Room ($3–10\text{m}$)**: Functional chambers, crypts, and guard rooms.
- **Monumental ($> 10\text{m}$)**: Grand boss colosseums and vaulted cathedral naves.

---

## 4. Structural Load-Bearing Invariants

Procedural spaces enforce physical architecture rules to prevent unnatural or disjoint layouts:

```
        Upper Mezzanine / Roof Arch
       ┌───────────────────────────┐
       │                           │
       └─────────────▲─────────────┘
                     │ Supported by
             ┌───────┴───────┐
             │ Pillar Module │
             └───────▲───────┘
                     │ Resting on
       ┌─────────────┴─────────────┐
       │                           │
       └───────────────────────────┘
               Lower Floor
```

- **Two-Floor Connectivity (`isConnectingTwoFloors`)**:
  - Pillars and colonnades must connect a lower foundation floor to an upper mezzanine or roof vault. Floating pillars without overhead structures are pruned.
  - Staircases must bridge an elevation difference $\Delta Y \ge 1.5\text{m}$ connecting distinct floor levels.
- **Chebyshev Half-Cell Proximity**:
  - Adjacent floor tiles are detected using Chebyshev box thresholds (`dx <= 3.8m, dz <= 3.8m, dy <= 1.0m`), preventing false-negative pruning on $5.0\text{m}$ floor tile grids.
- **Circulation Stair Alignment**:
  - Stair modules are automatically rotated 180° so the base step lands flush with the ground level and the top step meets the loft threshold with zero vertical discontinuity.

---

## 5. 3D Wave Function Collapse (`@mmo-engine/wfc`)

For macro-level dungeon topologies:
- The 3D WFC solver resolves room connectivity across 6-face socket constraints.
- Macro module layouts are then handed off to continuous synthesis to populate architectural dressings, torches, and clutter.

---

[← Previous: Multi-Region World Coordination](06-multi-region-world.md) | [Back to Wiki Index](README.md) | [Next: Client & Viewport Mirror →](08-client-and-rendering.md)
