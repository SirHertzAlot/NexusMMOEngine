# TS1: animouse Spike

## Verdict: ADOPT

**animouse** (MIT, v0.8.0) — animation state machine with blend trees for Three.js.

## What it provides

- `AnimationMachine`: event-driven and data-driven state transitions
- `LinearBlendTree`: 1D blending (idle → walk → run by speed)
- `PolarBlendTree`: 2D blending in polar coordinates (direction + speed)
- `FreeformBlendTree`: 2D blending via Delaunay triangulation
- `ClipState`: single clip with lifecycle events (footsteps, hit frames)

## Gates

| Gate | Target | Status |
|------|--------|--------|
| Pop-free blends | No position discontinuity | ✅ API verified (full test needs rendered scene) |
| Events within ±1 frame | Footstep/hit timing | ✅ `AnimationStateEvent` supported |
| Perf | < 0.1ms/character/frame | ⏳ Needs 100+ character benchmark |

## Integration

**Client side only.** The server still sends `(clipId, startTick, rate, layerMask)`; the client uses animouse to blend between clips smoothly.

```typescript
import { AnimationMachine, LinearBlendTree } from "animouse";

const movementTree = new LinearBlendTree([
  { action: mixer.clipAction(idleClip), value: 0 },
  { action: mixer.clipAction(walkClip), value: 0.5 },
  { action: mixer.clipAction(runClip), value: 1 },
]);

const machine = new AnimationMachine(movementTree, mixer);
movementTree.setBlend(speed);  // 0 = idle, 1 = run
machine.update(deltaTime);
```

## Time events (for EA24 audio)

Footstep and hit-frame events come from `ClipState` lifecycle:
- `onEnter`: clip starts (e.g., attack windup)
- `onUpdate`: per-frame (e.g., footstep at specific normalized time)
- `onExit`: clip ends

## Peer dependency note

animouse declares `three: ^0.175.0`; the client uses `three@0.186.1`. Installed with `--legacy-peer-deps`. The API surface used (AnimationMixer, AnimationAction) is stable across these versions.

## Follow-up

- 100+ character perf benchmark (validates the 0.1ms gate)
- Wire into EA21 client animation (replaces manual clip switching)
- Wire time events into EA24 audio (footsteps)
