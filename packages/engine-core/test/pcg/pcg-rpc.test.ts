/**
 * The Pcg webrpc service on the gateway's port (pcg.ridl), against the
 * repo's real asset library and the native cook: a logged-in client lists
 * the assets, asks for the mesh an entity's AssetRef shows, and downloads
 * it; everything else is refused with webrpc errors. Plus the library's
 * cook cache, with a counting stand-in cooker.
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePcgMesh, fnv1a32 } from "@mmo-engine/picg";
import { Gateway } from "../../src/net/gateway.js";
import { PcgAssetLibrary, type PcgCooker } from "../../src/pcg/asset-library.js";
import { DEFAULT_PCG_ASSETS, loadNativeCooker, startPcgService } from "../../src/pcg/boot.js";
import { HeadlessClient } from "../net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "../net/auth-harness.js";

describe("Pcg webrpc service", () => {
  let gw: Gateway;
  let base = "";
  let token = "";
  let client: HeadlessClient;

  before(async () => {
    gw = new Gateway({ credentialStore: await makeCredentialStore(), clock: () => 1_000_000 });
    const service = startPcgService(gw);
    assert.ok(service, "the repo's library loads");
    assert.ok(service.library.canCook, `native cook available: ${service.summary}`);
    const port = await gw.listen();
    gw.frame(1_000_000);
    base = `http://127.0.0.1:${port}`;
    client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const welcome = await client.hello("alice", { username: "alice", password: TEST_PASSWORD });
    token = welcome.session_token;
  });

  after(async () => {
    await client.close();
    await gw.close();
  });

  const rpc = (method: string, args: object, auth = token): Promise<Response> =>
    fetch(`${base}/rpc/Pcg/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(args),
    });

  it("needs the session token a welcome issued", async () => {
    const none = await rpc("ListAssets", {}, "");
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { code: 401, msg: "missing bearer token" });
    assert.equal((await rpc("ListAssets", {}, "f".repeat(64))).status, 401);
  });

  it("lists the library's assets by the ids spawn tables use", async () => {
    const res = await rpc("ListAssets", {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const { assets } = (await res.json()) as { assets: Array<{ id: string; assetHash: number; variants: number; revision: number }> };
    assert.deepEqual(assets.map((a) => a.id).sort(), ["birch", "oak", "pine"]);
    const oak = assets.find((a) => a.id === "oak")!;
    assert.equal(oak.assetHash, fnv1a32("oak"));
    assert.equal(oak.variants, 4);
    assert.equal(oak.revision, 1);
  });

  it("cooks the shape an AssetRef shows, and serves its bytes at the URL it returns", async () => {
    const res = await rpc("GetAssetMesh", { assetHash: fnv1a32("pine"), variant: 65534 });
    assert.equal(res.status, 200);
    const { mesh } = (await res.json()) as { mesh: { url: string; variantIndex: number; revision: number; vertexCount: number; triangleCount: number } };
    assert.equal(mesh.variantIndex, 65534 % 4);
    assert.match(mesh.url, new RegExp(`^/pcg/mesh/${fnv1a32("pine")}/2/1$`));
    assert.ok(mesh.vertexCount > 100 && mesh.triangleCount > 100, `${mesh.vertexCount} vertices`);

    assert.equal((await fetch(base + mesh.url)).status, 401, "the download needs the token too");
    const bytes = await fetch(base + mesh.url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get("content-type"), "application/octet-stream");
    assert.match(bytes.headers.get("cache-control") ?? "", /immutable/);
    const decoded = decodePcgMesh(await bytes.arrayBuffer());
    assert.equal(decoded.positions.length / 3, mesh.vertexCount);
    assert.equal(decoded.indices.length / 3, mesh.triangleCount);
    assert.ok(decoded.colors && decoded.normals, "vertex colours and normals");
  });

  it("answers preflights and refuses bad calls with webrpc errors", async () => {
    const pre = await fetch(`${base}/rpc/Pcg/ListAssets`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    const bad = await rpc("GetAssetMesh", { assetHash: -1, variant: 0 });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { msg: string }).msg, /assetHash/);
    assert.equal((await rpc("GetAssetMesh", { assetHash: 12345, variant: 0 })).status, 404);
    assert.equal((await rpc("NoSuchMethod", {})).status, 404);
    assert.equal((await rpc("SetAssetParameters", { assetId: "oak", values: {}, opId: "x" })).status, 501);
    assert.equal((await fetch(`${base}/somewhere-else`)).status, 404);
  });
});

describe("PcgAssetLibrary", () => {
  function library(cooker: PcgCooker | null): PcgAssetLibrary {
    return PcgAssetLibrary.load(DEFAULT_PCG_ASSETS, cooker);
  }

  it("cooks each shape once per revision, sharing concurrent requests", async () => {
    let cooks = 0;
    const seeds = new Set<number>();
    const counting: PcgCooker = {
      async cook(_graph, seed) {
        cooks++;
        seeds.add(seed);
        const native = loadNativeCooker().cooker!;
        return native.cook(_graph, seed);
      },
    };
    const lib = library(counting);
    const oak = fnv1a32("oak");
    await Promise.all([lib.mesh(oak, 0), lib.mesh(oak, 4), lib.mesh(oak, 8), lib.mesh(oak, 1)]);
    assert.equal(cooks, 2, "variants 0/4/8 are one shape; 1 is another");
    assert.equal(seeds.size, 2);
    assert.equal(await lib.mesh(fnv1a32("not-an-asset"), 0), null);
  });

  it("lists assets without a cooker, but has no meshes", async () => {
    const lib = library(null);
    assert.equal(lib.canCook, false);
    assert.equal(lib.list().length, 3);
    assert.equal(await lib.mesh(fnv1a32("oak"), 0), null);
  });

  it("refuses library files outside the library", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcglib-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, subgraphs: [], assets: [{ id: "x", graph: "../escape.pcg" }] }));
    assert.throws(() => PcgAssetLibrary.load(dir, null), /outside the library/);
  });
});
