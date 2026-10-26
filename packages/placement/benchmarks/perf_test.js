/**
 * Simple performance benchmark for the placement engine.
 * Measures time to place a set of items in a generated region.
 */
import { GridSdf } from '../dist/src/sdf.js';
import { placeInRegion } from '../dist/src/place.js';
import { mulberry32 } from '../dist/src/scatter.js';

function generateRegion(width, height) {
  const solid = (x, y) => x === 0 || y === 0 || x === width - 1 || y === height - 1;
  const sdf = new GridSdf(width, height, solid, 1);
  const region = { x0: 0, y0: 0, x1: width, y1: height, inside: undefined };
  return { sdf, region };
}

function createItems(count) {
  const items = [];
  const rng = mulberry32(12345);
  const whereOpts = ['floor', 'wall', 'corner'];
  for (let i = 0; i < count; i++) {
    const radius = 0.5 + rng() * 1.5;
    const where = whereOpts[Math.floor(rng() * whereOpts.length)];
    items.push({ where, radius });
  }
  return items;
}

function runBenchmark() {
  const { sdf, region } = generateRegion(200, 200);
  const items = createItems(200);
  const opts = { seed: 42, spacing: undefined, reach: 3, maxCandidates: 5000 };
  console.time('placement');
  const result = placeInRegion(sdf, region, items, opts);
  console.timeEnd('placement');
  console.log('placed', result.filter(r => r !== null).length, '/', items.length);
}

runBenchmark();
