# Green squares: settlement sites and farms from the survey's green land

## Problem
`settlement:bake --world` fails on the shipped world ("the site is too wet for the town"). The town itself is dry: the
parcels dropped are farm holdings 800-1400 m out whose fields reach the sea or mountains, so the demand solve cannot place
its farmsteads and grows block rows until it gives up. Site selection checks only the town's footprint, and sizes the town
before the demographics change it.

## Design
1. **Green squares** (`packages/settlement/src/green.ts`, `greenSquares(fields, rules.sites)`). A cell is green when its
   biome is in `rules.sites.greenBiomes` (default plains, forest, rainforest), it is not water, river or ice, and its height is
   at least `safeFloorM` above the sea. The largest-square DP over that mask finds the biggest all-green square; squares are
   taken greedily, largest first, never overlapping, down to `rules.sites.minSquareCells`. Each square is `{ cx, cz, cells,
   x0, z0, x1, z1, areaM2 }`: grid cells and world metres. Read from the survey grid (what the preview draws), not the PNG.
2. **Preview.** `preview:world -- --squares` outlines the squares on the biome panel and writes `<out>.squares.json`.
3. **Sites.** `selectSites` keeps only candidates whose footprint centre lies in a square with room for it; existing scoring
   (slope, relief, water, fertility) still ranks them. A site carries its `square`.
4. **Size from area.** `fitHouseholds(squareHalfSideM, rules, scale)` inverts `townHalfExtentM` (binary search on households).
   The CLI bakes `min(requested population, what fits)` and logs the cap.
5. **Farms.** The field-dry test in `layout.ts` becomes "every field sample is a green cell" (anywhere, not just in the
   square). When the green acres in reach cannot hold the required farmsteads, the farm count is lowered to what fits
   (event `farms_capped`); the missing food is imported through the existing trade model. No "too wet" failure.

## Out of scope
Shrinking holdings to squeeze more farms in; PNG pixel parsing; editor UI for squares.

## Checks
Unit tests on a synthetic grid (squares disjoint, all green, size inversion monotonic, farm cap); a real bake of the default
world at 600 people succeeds with 22 gates passing; before/after PNG for the PR (kept out of the repo).
