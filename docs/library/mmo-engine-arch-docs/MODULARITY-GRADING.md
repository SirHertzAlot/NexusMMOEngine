# Subsystem À-La-Carte Grading

**Status:** assessment (2026-10-12)
**Scale:** READY (narrow seam exists, extraction is mechanical) →
         CLOSE (mostly decoupled, needs a seam cut) →
         LOCKED (deep coupling, extraction is a project)

## READY — extract mechanically

| Subsystem | Seam | Notes |
|---|---|---|
| Terrain baking | BAKE-OUTPUT-CONTRACT | Contract written; producers already interchangeable. Needs `bake:validate` implementation. |
| Chunk generation | `ChunkDataSource` ABI | `generateChunk(seed,cx,cz,lod)` — the C++ kernel drops in here. |
| Chunk streaming (protocol) | 0x21/0x22 | Just built; gateway ↔ client contract is clean. |
| Tile decomposition | worker `chunkDecompose` | Pure function, protocol tiles in/out. |
| WFC solver | `packages/wfc` | Standalone package; three jobs (layout, variants, collapse) share one solver. |
| Module manifests | `packages/modules` | Discovery/validation/ordering done; needs runtime adoption. |

## CLOSE — one seam cut away

| Subsystem | Coupling | Cut needed |
|---|---|---|
| Chat | Gateway imports `../chat.js` directly | Inject chat rules via GatewayExtension or constructor; move 0x11 handler behind the seam. **First slice.** |
| Species/needs | Species package exists; needs are greenfield | Needs registry is new code — build it as a module from day one (per NEEDS-WFC spec). |
| Art pipeline | gltfpack/transform/jsx wired as tools | Already tool-shaped; wrap as EA13 tools-as-modules. |
| Erosion stages | Kernel-internal | Bake-time stages inside the C++ kernel; contract is the bake output. |
| Dungeons | `dungeons/` has manager/pool/instance | Has internal structure; needs manifest + entry. |
| Items | `items/` has service/store/boot | Same — service exists, needs the module wrapper. |

## LOCKED — extraction is a project

| Subsystem | Coupling | Why it's hard |
|---|---|---|
| Combat/magic/abilities/status | Cross-import body, stamina, components; tick-order entangled | ~8 systems share component writes; needs component-ownership declarations first. |
| Quests | Quest service + stores + content gen | Tied to entity lifecycle and dialogue; moderate rewrite. |
| Gateway core | 0x01–0x22 handlers inline, imports chat/items/etc. | The biggest monolith; modularize *around* it first (extensions), then split handlers. |
| Client renderer | `apps/client/src/render` — no module system | Needs the client-modules layer designed before extraction. |
| server.ts bootstrap | Constructs ~30 systems inline | Shrinks automatically as slices land; last to go. |

## Extraction order (recommended)

1. **Chat** — smallest, demonstrates the full pattern (manifest + entry + gateway seam).
2. **Art pipeline tools** — already tool-shaped, low risk.
3. **Species/needs** — greenfield, build modular from birth.
4. **Dungeons, items** — service-shaped, mechanical.
5. **Combat cluster** — needs the component-ownership work first.
6. **Gateway handlers** — split after dependents are modules.
7. **Client modules** — parallel track, needs design.
8. **server.ts** — empties itself; the final slice is deleting code.

## The doors (standalone entry points this unlocks)

Each READY/CLOSE subsystem is a door someone can walk through without the engine:
- Bake terrain without the engine → bake contract
- Generate chunks without the engine → ChunkDataSource ABI
- Stream tiles without the game → 0x21/0x22 + ChunkStreamManager
- Solve WFC without the engine → packages/wfc
- Chat without the engine → chat module (after slice 1)
