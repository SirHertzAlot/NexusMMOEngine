# `@mmo-engine/addon-geometry`: mesh and polygon Booleans

[manifold](https://github.com/elalish/manifold) (solids) and
[Clipper2](https://github.com/AngusJohnson/Clipper2) (polygons, through
manifold's `CrossSection`) behind an N-API boundary, for bakes: a
dungeon's shell (`@mmo-engine/dungeon`, `dungeonShell`), footprints,
anything carved or merged. Both are vendored (`third_party/VENDORING.md`)
and built by node-gyp with only a C++17 compiler (~30 s on 8 cores).

The engine frame in and out: **y is up**. Polygons lie in the x-z plane
as `(x, z)` pairs; outer rings run counter-clockwise seen from above,
holes clockwise.

```js
const geo = require("@mmo-engine/addon-geometry");

// Cells to merged outlines: each row's runs unioned in one batch, then simplified.
const floor = geo.cellsToPolygons(mask, width, height, { cell: 2 });
// floor: { points: Float64Array (x, z pairs), rings: Uint32Array (points per ring), area }

geo.polygonBoolean("union" | "difference" | "intersection", a, b);
geo.polygonOffset(polys, 0.5, { join: "round" });   // grow; negative shrinks

// A CSG tree, evaluated by manifold in one call.
const r = geo.solid({
  op: "difference",
  of: [
    { op: "box", min: [0, -1, 0], max: [40, 9, 40], tag: 1 },
    { op: "extrude", polygons: floor, y0: 0, height: 4, tag: 2 },
  ],
});
// r: { positions: Float32Array, indices: Uint32Array, tags: Uint16Array (per triangle), volume, area, genus }
```

- **Tags** follow faces through every Boolean (manifold's original ids): a
  triangle's tag says which leaf it came from, so a carved shell knows its
  rock's outside from its cavity. A tag on an operation node re-tags
  everything under it.
- **Always closed.** manifold's results are watertight 2-manifolds, which
  is what Jolt mesh colliders and Recast want.
- **Synchronous**, single-threaded (manifold without TBB): for bakes, not
  the tick. A 40-room dungeon's shell takes about 0.1 s.
- **Deterministic**: the same tree gives the same bytes.

Test: `npm run test:addon-geometry` from the repo root.
