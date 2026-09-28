# @mmo-engine/addon-template

Template N-API addon. Its only job: prove the native toolchain
(`node-gyp` + `node-addon-api`) builds and loads on this machine, so real
systems (procgen → slice 1.6, physics, pathfinding → Phase 2) start from a
known-good pattern.

- `binding.gyp` — build definition; `node-addon-api` include wired via
  `node -p` (no hardcoded paths).
- `src/addon.cc` — minimal addon exporting `hello()`.

```sh
npm install          # triggers `node-gyp rebuild` via the install script
npm test             # node:test loads build/Release/addon.node
```
