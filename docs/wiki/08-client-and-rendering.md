# 08. Client & Viewport Mirror

[← Previous: Procedural Generation & Synthesis](07-procedural-generation.md) | [Back to Wiki Index](README.md) | [Next: Developer Guide & Extension Manual →](09-developer-guide.md)

---

## 1. Overview
The client application in [`apps/client`](file:///c:/Users/user/Downloads/mmo-engine-full/apps/client) acts as a decoupled visual mirror of the authoritative server world.

---

## 2. Thin-Client Philosophy
- **Zero Authoritative Game Logic**: The browser client does not decide damage, check inventory allowances, or step physical collisions.
- **Intent Dispatch**: The client captures user inputs (WASD, mouse look, skill hotkeys) and transmits them as compact binary intent tokens.
- **Visual Interpolation**: Visual entities update their transforms by interpolating between server snapshot states, decoupling rendering frame rates (60–144 Hz) from server tick rates (30 Hz).

---

## 3. Rendering Pipeline (Three.js & React Three Fiber)

```
Server Delta Stream (WebSocket)
            │
            ▼
Mirror Client Driver (@mmo-engine/mirror)
            │ Unpacks binary deltas & updates entity buffers
            ▼
Entity Layer (Three.js InstancedMesh & SkinnedMesh)
            │
            ▼
Post-Processing Pass (GT Tonemapping, Outlines, Water, FX)
            │
            ▼
Canvas Output (WebGL2 / WebGPU)
```

- **Chunk Streaming**: Terrain chunks stream dynamically into view based on distance.
- **Instanced Props**: Rocks, trees, and architectural dressings render via GPU instancing (`InstancedMesh`) to minimize draw calls.
- **Mesh Optimization**: Models are pre-compressed with `meshopt` and unpacked in web workers via `SharedArrayBuffer`.

---

## 4. Biomechanical First-Person Rig & Viewmodel

The client features an articulated first-person viewmodel and arms rig ([`FirstPersonRig`](file:///c:/Users/user/Downloads/mmo-engine-full/apps/client/src/render/first-person-rig.ts)):

- **Biomechanical Camera Coupling**:
  - Lissajous idle breathing harmonics ($0.40\text{Hz}$).
  - Stride-frequency head bobbing for walk, jog, sprint, and swimming gaits with lateral banking roll tilt.
  - Spring-damper landing dip upon hitting the ground from falls.
- **Visual Weapon Swing Trails**: Dynamic ribbon trails emit from blade edges during attack combo windows and fade smoothly.
- **Pitch-Driven Anatomical Aiming**: Reticle raycasts map look pitch directly to target anatomy (head, torso, legs) for server-authoritative combat strikes.

---

## 5. WebGPU Modernization Roadmap

The client architecture is prepared for migration to **WebGPU**:
- **Why WebGPU?** Unlike legacy WebGL2 single-threaded draw calls, WebGPU exposes general-purpose GPU compute shaders (WGSL) and indirect multi-draws.
- **Compute Pipelines**: Simulates 100,000 weather particles, crowd skinning, and GPU frustum culling directly on the graphics card.

---

[← Previous: Procedural Generation & Synthesis](07-procedural-generation.md) | [Back to Wiki Index](README.md) | [Next: Developer Guide & Extension Manual →](09-developer-guide.md)
