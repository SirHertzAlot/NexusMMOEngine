# EA10: C++ Modules

## Design

C++ modules extend the module system (EA3/EA9) to native code via N-API.

### Manifest extension

```json
{
  "name": "physics-jolt",
  "version": "1.0.0",
  "server": {
    "systems": [{ "name": "PhysicsSystem", "after": ["TransformSystem"] }]
  },
  "native": {
    "entry": "./build/Release/physics.node",
    "systems": ["PhysicsSystem"]
  }
}
```

### How it works

1. Module manifest declares `native.entry` (compiled `.node` file)
2. At boot, `resolveModuleSet` includes native modules in dependency order
3. The host loads the `.node` file via `require()` (N-API)
4. The native module exports `createSystems()` returning system instances
5. Systems run on the tick like JS systems (bulk SoA boundary)

### Existing pattern

The engine already has N-API addons:
- Jolt physics (vendored, bulk SoA boundary)
- Recast/Detour navigation

EA10 formalizes these as modules rather than hardcoded addons.

### Build integration

- `npm run build:native` compiles all `native` entries
- The build profile (EA19) includes native build as a stage
- Missing `.node` file = module disabled with a clear error

## Status

Implemented 2026-10-10.
- `native` manifest field validated in `@mmo-engine/modules` (`validateManifest`);
  `resolveModuleSet` orders native systems after the module's JS systems.
- `assembleServerSystems` (`packages/engine-core/src/modules.ts`) loads the
  `.node` entry via require and calls its `createSystems(ctx)`; missing file
  disables the module with a clear error pointing at `npm run build:native`.
- `npm run build:native` (scripts/build-native.mjs) compiles every module
  with a `native.entry` via node-gyp.
- Tests: manifest validation + ordering (packages/modules), loader incl.
  missing-file disable and refusal paths (engine-core).
