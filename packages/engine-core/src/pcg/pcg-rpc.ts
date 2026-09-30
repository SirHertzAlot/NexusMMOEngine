/**
 * The Pcg webrpc service (pcg.ridl) over the region's asset library.
 *
 * Slice 2: ListAssets and GetAssetMesh, plus the GET route the mesh URL
 * points at. The edit methods are declared in the contract and answer 501
 * until their slices land.
 */

import type { PcgAssetLibrary } from "./asset-library.js";
import { RpcError, type RpcServer } from "../net/rpc-http.js";

export const PCG_MESH_PATH = "/pcg/mesh";

function uint(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new RpcError(400, `invalid argument: ${name} must be an integer 0..${max}`);
  }
  return value;
}

export function registerPcgRpc(rpc: RpcServer, library: PcgAssetLibrary): void {
  rpc.method("Pcg", "ListAssets", async () => ({ assets: library.list() }));

  rpc.method("Pcg", "GetAssetMesh", async (args) => {
    const assetHash = uint(args.assetHash, "assetHash", 0xffffffff);
    const variant = uint(args.variant, "variant", 0xffff);
    const info = library.info(assetHash);
    if (!info) throw new RpcError(404, `no PCG asset with hash ${assetHash}`);
    let mesh;
    try {
      mesh = await library.mesh(assetHash, variant);
    } catch (err) {
      throw new RpcError(422, `cook failed for '${info.id}': ${(err as Error).message}`);
    }
    if (!mesh) {
      return { mesh: { assetHash, variantIndex: 0, revision: info.revision, url: "", vertexCount: 0, triangleCount: 0, lods: [] } };
    }
    const url = `${PCG_MESH_PATH}/${assetHash}/${mesh.variantIndex}/${mesh.revision}`;
    return {
      mesh: {
        assetHash,
        variantIndex: mesh.variantIndex,
        revision: mesh.revision,
        url,
        vertexCount: mesh.vertexCount,
        triangleCount: mesh.triangleCount,
        // Simplified levels, most detailed first: same URL plus the level (1..n).
        lods: mesh.lods.map((l, i) => ({ url: `${url}/${i + 1}`, vertexCount: l.vertexCount, triangleCount: l.triangleCount, error: l.error })),
      },
    };
  });

  for (const m of ["GetAsset", "SetAssetParameters", "GetEntity", "SetEntityComponents", "SaveAssetGraph", "CookPreview"]) {
    rpc.method("Pcg", m, async () => {
      throw new RpcError(501, `${m} is not implemented yet`);
    });
  }

  rpc.get(PCG_MESH_PATH, async ([hash, vi, rev, lod]) => {
    const pending = library.cachedMesh(Number(hash), Number(vi), Number(rev));
    const mesh = pending ? await pending : null;
    if (!mesh) throw new RpcError(404, "no such mesh (ask GetAssetMesh for the current URL)");
    const level = lod === undefined ? 0 : Number(lod);
    const body = level === 0 ? mesh.bytes : mesh.lods[level - 1]?.bytes;
    if (!body) throw new RpcError(404, `no level ${lod} for this mesh`);
    return {
      contentType: "application/octet-stream",
      body,
      headers: { "Cache-Control": "private, max-age=31536000, immutable" },
    };
  });
}
