# TS4: InstancedMesh2 Spike

## Verdict: ADOPT

**@three.ez/instanced-mesh** — enhanced InstancedMesh with BVH frustum culling, LOD, per-instance visibility.

## Gate

| Gate | Target | Status |
|------|--------|--------|
| Single-digit draw calls (50k trees) | < 10 draw calls | ✅ Architecture supports (1 draw call per LOD tier) |
| 60 fps on target hardware | Sustained | ⏳ Needs hardware benchmark |

## Features used

- **Per-instance frustum culling**: skip out-of-view instances
- **Dynamic BVH**: spatial index for fast culling/raycasting (static trees = ideal)
- **LOD**: distance-based detail switching (pairs with TS3 impostors)
- **Per-instance visibility**: toggle individual trees

## Integration

```
TS3 baked trees (GLB)
    ↓
InstancedMesh2 per species
    ├── Near: full geometry
    ├── Mid: simplified
    └── Far: octahedral impostor
    ↓
BVH culling → single-digit draw calls
```

## API

```typescript
import { InstancedMesh2 } from "@three.ez/instanced-mesh";

const forest = new InstancedMesh2(treeGeometry, treeMaterial, {
  capacity: 50000,
});
forest.addInstances(50000, (obj, i) => {
  obj.position.set(x[i], y[i], z[i]);
  obj.scale.setScalar(s[i]);
});
forest.computeBVH();  // static trees: build once
```

## Follow-up

1. 50k-tree benchmark on target hardware (validates 60fps gate)
2. LOD tiers wired to TS3 impostor baker
3. Wind shader compatibility (per-instance phase offset)
