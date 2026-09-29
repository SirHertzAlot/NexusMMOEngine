# @mmo-engine/placement

**Where** things go, once WFC (`@mmo-engine/wfc`) has decided **what** goes there.
Scatter proposes candidate spots. The raymarcher settles each item against
the space's signed distance field: on the floor, in the open centre, against
a wall, into a corner, or on terrain.

| Piece | |
|---|---|
| `GridSdf` | A 2D grid of solid and open cells (a dungeon) as an exact Euclidean distance transform, sampled bilinearly. Positive in open space, negative inside walls. |
| `HeightfieldSdf` | Open space above ground, scaled by the steepest slope so a raymarcher can step by it safely. |
| `march2`, `march3` | Sphere tracing to the first surface along a ray, with its normal. A step that overshoots a sampled field near corners is bisected back to the surface. A ray starting inside a surface reports no hit. |
| `poissonDisc` | Candidates at least `spacing` apart through a region, even without a grid's regularity. Deterministic per seed. |
| `placeInRegion` | Place a list of items, each with `where` (`floor`, `centre`, `wall` or `corner`), a footprint radius, and optionally mounted on the wall surface. Each is clear of walls and of everything already placed, and wall pieces face out. Returns `null` for an item with no room. |
| `snapToGround` | Drop a point onto terrain: its height and the ground's normal. |

Bake-time code, deterministic per seed. `@mmo-engine/dungeon`'s dressing uses it for
room contents and resource veins, and the terrain's formations will use it to set their
pieces on the ground.
