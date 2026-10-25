/**
 * The region chunk range covering a whole baked world, for `npm start`'s
 * dev region. A bake records `world_bounds` in world.db's meta table as
 * {minChunk, maxChunk}, inclusive and the same on both axes (worlds are
 * centred on the origin); REGION_CHUNK_RANGE is "x0,z0,x1,z1" with x1/z1
 * exclusive (the world server's and the migration router's convention).
 */
export function regionRangeOf(worldBounds) {
  const { minChunk, maxChunk } = JSON.parse(worldBounds);
  return `${minChunk},${minChunk},${maxChunk + 1},${maxChunk + 1}`;
}
