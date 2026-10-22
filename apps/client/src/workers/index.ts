/**
 * Main worker entry point — registers all task handlers and starts the runtime.
 */
import { WorkerRuntime } from './runtime.js';
import { terrainHandler } from './handlers/terrain.js';
import { pcgHandler } from './handlers/pcg.js';
import { bvhHandler } from './handlers/bvh.js';
import { terrainBlockHandler } from './handlers/terrain-block.js';
import { chunkDecomposeHandler } from './handlers/chunk-decompose.js';
import { assetDecodeHandler } from './handlers/asset-decode.js';
import { weatherHandler } from './handlers/weather.js';

const runtime = new WorkerRuntime({
  maxRetries: 3,
  retryDelayMs: 1000,
  maxConcurrentTasks: 4,
});

// Register all task handlers
runtime.registerHandler('terrain', terrainHandler);
runtime.registerHandler('pcg', pcgHandler);
runtime.registerHandler('bvh', bvhHandler);
runtime.registerHandler('terrainBlock', terrainBlockHandler);
runtime.registerHandler('chunkDecompose', chunkDecomposeHandler);
runtime.registerHandler('assetDecode', assetDecodeHandler);
runtime.registerHandler('weather', weatherHandler);

console.log('[Worker] Terrain/PCG/BVH/AssetDecode/Weather worker ready');