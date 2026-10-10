/**
 * Shared GLTF loader factory (TL1a).
 *
 * Every GLTFLoader in the client goes through `createGltfLoader()`, which
 * wires:
 * - MeshoptDecoder — for gltfpack-compressed geometry (Phase 1b)
 * - KTX2Loader + Basis transcoder — for KTX2 textures (Phase 1c)
 *
 * Both decoders are idle against uncompressed assets: zero behavior change
 * until compressed assets ship. This is the decoder-first ordering — the
 * client can read compressed assets before the bake pipeline produces them.
 */
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { LoadingManager } from "three";

/** Base URL for the Basis transcoder wasm. Served from the client's public dir. */
const BASIS_TRANSCODER_PATH = "/basis/";

let sharedKtx2Loader: KTX2Loader | null = null;

function getKtx2Loader(manager?: LoadingManager): KTX2Loader {
  if (!sharedKtx2Loader) {
    sharedKtx2Loader = new KTX2Loader(manager);
    sharedKtx2Loader.setTranscoderPath(BASIS_TRANSCODER_PATH);
  }
  return sharedKtx2Loader;
}

/**
 * Create a GLTFLoader with Meshopt and KTX2 decoders wired.
 * Use this instead of `new GLTFLoader()` directly.
 */
export function createGltfLoader(manager?: LoadingManager): GLTFLoader {
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(getKtx2Loader(manager));
  return loader;
}
