/**
 * @mmo-engine/picg — the engine's host library for PICG (PCG-AI) graphs,
 * shared by the region server, the client and the editor (no Node APIs).
 * Cooking itself is @mmo-engine/addon-picg (server only).
 */
export * from "./types.js";
export { sha256Hex } from "./sha256.js";
export {
  canonicalGuid,
  definitionIdForGuid,
  hasLinkedSubgraphs,
  MAX_SUBGRAPH_ASSETS,
  MAX_SUBGRAPH_DEPTH,
  resolveLinkedSubgraphs,
  SubgraphResolveError,
  type ResolvedGraph,
  type SubgraphLoader,
} from "./resolve.js";
export {
  applyParameters,
  coerceParameter,
  exposedParameters,
  findTargetNode,
  parameterValues,
  type ParameterValues,
} from "./parameters.js";
export { prepareForCook, type PreparedGraph, type PrepareOptions } from "./prepare.js";
export { decodePcgMesh, PCGM_MAGIC, type PcgMesh } from "./mesh.js";
export {
  fnv1a32,
  parseLibraryIndex,
  variantIndex,
  variantSeed,
  type PcgLibraryAsset,
  type PcgLibraryIndex,
} from "./library.js";
export {
  httpBaseForGameUrl,
  PcgRpcClient,
  PcgRpcError,
  type PcgAssetInfo,
  type PcgMeshRef,
} from "./rpc-client.js";
