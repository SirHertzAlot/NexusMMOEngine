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
     "dependsOn": ["core"],
     "server": {
       "entry": "server/index.js",
       "systems": [{ "name": "my-gameplay", "after": "intent" }]
     }
   }
   ```
3. **Implement the system in `modules/my-gameplay/server/index.js`**. `createSystems(ctx)` returns an object with one system per name the manifest declares, keyed by that name:
   ```js
   export function createSystems(ctx) {
     return {
       "my-gameplay": {
         name: "my-gameplay",
         step(sim, dt) {
           // iterate over bitECS components of ctx.sim
         },
       },
     };
   }
   ```
   The context, ordering rules and failure messages are in [MODULES.md](../MODULES.md); `modules/sample-heartbeat/` is a working example.
4. **Enable the Module**:
   Add `"my-gameplay"` to [`content/modules.json`](../../content/modules.json).

---

## 4. How to Author a Native C++ Addon

Start from the template, which exists to prove the native toolchain builds and loads on your machine (`packages/addons/template`, with a working module wrapper in `modules/template-native`).

1. **Copy the template.**
   ```sh
   cp -r packages/addons/template packages/addons/my-addon
   ```
   In the copy, rename the package (`@mmo-engine/addon-my-addon`) and the `target_name` in `binding.gyp`. The package's scripts are `install` (`node-gyp rebuild`) and `test` (`node --test "test/*.test.js"`), and `index.js` loads the built `.node` file.
2. **Write the addon** in `src/addon.cc` with `node-addon-api`. Follow the bulk-SoA rule from [chapter 4](04-native-addons.md): take typed arrays in, loop in C++, and never cross the N-API boundary per entity in a hot loop. The engine builds on Windows (Visual Studio Build Tools), macOS and Linux, so add `-mavx2` or similar only for a kernel that needs it, and keep a scalar path.
3. **Register it.** Add `packages/addons/my-addon` to the root `package.json` `workspaces` list (the addons are listed one by one) and a `test:addon-my-addon` script beside the others.
4. **Build and test.**
   ```sh
   cd packages/addons/my-addon && npx node-gyp rebuild && npm test
   ```
   A change to an addon needs it rebuilt before engine-core's tests use it.
5. **Check memory.** `npm run valgrind:memcheck -- my-addon` must run clean for errors and leaks in your own code (Linux, needs Valgrind). If the addon is on a hot path, `npm run valgrind:perf` shows what it costs.
6. **Hook it into the server** as a module, if it provides systems: a manifest with `native.entry` (the compiled `.node`) and `native.systems`, and a `.node` that exports `createSystems`. See [MODULES.md](../MODULES.md) and `modules/template-native`.

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
