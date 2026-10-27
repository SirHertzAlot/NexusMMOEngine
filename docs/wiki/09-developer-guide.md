# 09. Developer Guide & Extension Manual

[← Previous: Client & Viewport Mirror](08-client-and-rendering.md) | [Back to Wiki Index](README.md)

---

## 1. Prerequisites & Environment Setup

### Required Toolchain
- **Node.js**: v22.x LTS (Recommended: `v22.22.x`)
- **npm**: v10+
- **C++ Compiler**:
  - Windows: Visual Studio 2022 Build Tools (Desktop development with C++)
  - Linux: GCC 13+ or Clang 16+
  - macOS: Xcode Command Line Tools

---

## 2. Quickstart Commands

```sh
# 1. Install dependencies across all workspaces
npm install

# 2. Compile FlatBuffers schemas to C++ and TypeScript
npm run codegen

# 3. Build native C++ addons
npm run build:native

# 4. Run all unit and correctness test suites
npm test

# 5. Launch local server and client development environment
npm start
```

---

## 3. How to Author a Custom Gameplay Module

1. **Create the Module Folder**:
   ```sh
   mkdir modules/my-gameplay
   ```
2. **Add `modules/my-gameplay/module.json`**:
   ```json
   {
     "name": "my-gameplay",
     "version": "1.0.0",
     "server": {
       "entry": "dist/index.js",
       "systems": [
         { "name": "CustomPhysicsSystem", "after": ["TransformSystem"] }
       ]
     }
   }
   ```
3. **Implement the System in `modules/my-gameplay/src/index.ts`**:
   ```ts
   import type { SimWorld } from "@mmo-engine/engine-core";
   
   export function createSystems(world: SimWorld) {
     return [
       {
         name: "CustomPhysicsSystem",
         step: (dt: number) => {
           // Iterate over bitECS components
         }
       }
     ];
   }
   ```
4. **Enable the Module**:
   Add `"my-gameplay"` to [`content/modules.json`](file:///c:/Users/user/Downloads/mmo-engine-full/content/modules.json).

---

## 4. How to Author a Native C++ Addon

1. **Create the Addon Folder**:
   ```sh
   mkdir packages/addons/my-addon
   ```
2. **Add `binding.gyp`**:
   ```python
   {
     "targets": [
       {
         "target_name": "my_addon",
         "sources": [ "src/addon.cc" ],
         "include_dirs": [ "<!@(node -p \"require('node-addon-api').include\")" ],
         "dependencies": [ "<!(node -p \"require('node-addon-api').gyp\")" ],
         "cflags_cc": [ "-O3", "-mavx2" ],
         "msvs_settings": {
           "VCCLCompilerTool": { "Optimization": "3", "EnableEnhancedInstructionSet": "5" }
         }
       }
     ]
   }
   ```
3. **Implement Bulk SoA Processing**:
   Accept raw `Float32Array` pointers via N-API and process buffers with SIMD vectorization.

---

## 5. Running Automated Verification & Playtests

The engine provides headless browser automation using Playwright to verify full runtime stacks:

```sh
# Procedural synthesis preview and stair visibility verification
node packages/synthesis/scripts/render-examples.mjs

# Automated in-engine locomotion playtest
node packages/synthesis/scripts/playtest-loft-access.mjs
```

---

[← Previous: Client & Viewport Mirror](08-client-and-rendering.md) | [Back to Wiki Index](README.md)
