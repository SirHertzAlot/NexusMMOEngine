import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  DATA_PLANE_SURREALMX_URL,
  isRemoteDbUrl,
  resolveDataPlaneCredentials,
  resolveDataPlaneDbUrl,
} from "../src/persist-worker.js";

describe("data-plane ledger default", () => {
  it("is the durable SurrealMX server when MMO_DATA_PLANE_DB and MMO_DATA_PLANE_STORE are unset", () => {
    const url = resolveDataPlaneDbUrl(undefined, path.join("srv", "data"));
    assert.equal(url, "ws://127.0.0.1:8000/rpc");
    assert.equal(url, DATA_PLANE_SURREALMX_URL);
    assert.ok(isRemoteDbUrl(url));
  });
  it("MMO_DATA_PLANE_STORE=rocksdb is the escape hatch to the previous RocksDB ledger", () => {
    const url = resolveDataPlaneDbUrl(undefined, path.join("srv", "data"), "rocksdb");
    assert.ok(url.startsWith("rocksdb:"), url);
    assert.ok(url.endsWith("/srv/data/data-plane"), url);
    assert.equal(resolveDataPlaneDbUrl(undefined, "/x", "  "), DATA_PLANE_SURREALMX_URL);
  });
  it("honours an explicit MMO_DATA_PLANE_DB over the store switch, including mem:// as the volatile opt-out", () => {
    assert.equal(resolveDataPlaneDbUrl("mem://", "/x"), "mem://");
    assert.equal(resolveDataPlaneDbUrl("  rocksdb:/abs/ledger ", "/x", "rocksdb"), "rocksdb:/abs/ledger");
    assert.equal(resolveDataPlaneDbUrl("ws://db.internal:8000/rpc", "/x"), "ws://db.internal:8000/rpc");
    assert.equal(resolveDataPlaneDbUrl("", "/x"), DATA_PLANE_SURREALMX_URL);
  });
  it("sends root/root to a remote server unless MMO_DATA_PLANE_USER/PASS override it", () => {
    assert.deepEqual(resolveDataPlaneCredentials({}), { user: "root", pass: "root" });
    assert.deepEqual(
      resolveDataPlaneCredentials({ MMO_DATA_PLANE_USER: "ops", MMO_DATA_PLANE_PASS: "s3cret" }),
      { user: "ops", pass: "s3cret" },
    );
  });
  it("classifies server URLs as remote and embedded engine URLs as local", () => {
    assert.ok(isRemoteDbUrl("ws://127.0.0.1:8000/rpc"));
    assert.ok(isRemoteDbUrl("wss://db.example/rpc"));
    assert.ok(!isRemoteDbUrl("mem://"));
    assert.ok(!isRemoteDbUrl("rocksdb:/abs/ledger"));
    assert.ok(!isRemoteDbUrl("surrealkv:/abs/ledger"));
  });
});
