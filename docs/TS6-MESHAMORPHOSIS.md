# TS6: Batch FBX → GLB Evaluation

## Verdict: EVALUATE fbx2.1glb (no immediate adoption)

**Roadmap gate:** Permissive license; clips retarget without manual bone remapping.

## Candidate: fbx2.1glb

- **License:** MIT/BSD (no proprietary Autodesk FBX SDK)
- **Parser:** ufbx (MIT, single-file C99)
- **Features:** skeletal skinning, blend shapes, animation baking (24/30/60fps), Draco, binary GLB
- **Build:** CMake, C++17, ARM64-native

**Why not immediate adoption:**
1. No current FBX assets in the pipeline (all prototype assets are GLB-native: KayKit, Kenney, Gobkit)
2. Mixamo is excluded by policy (Adobe ToS — cannot bundle)
3. Bone remapping still needs verification against our skeleton

## When to adopt

If FBX sources enter the pipeline (e.g., commissioned art delivered as FBX):
1. Build fbx2.1glb
2. Test clip retargeting against our skeleton (no manual remapping = gate)
3. Wire into `packages/art` as a pre-step before gltfpack

## Alternative

Blender headless (`blender --background --python`) can also batch-convert FBX→GLB. Heavier but already a known tool.
