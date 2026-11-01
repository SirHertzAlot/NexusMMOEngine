import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveDataPlaneDbUrl } from "../src/persist-worker.js";

describe("data-plane ledger default", () => {
  it("is durable under the data dir when MMO_DATA_PLANE_DB is unset", () => {
    const url = resolveDataPlaneDbUrl(undefined, path.join("srv", "data"));
    assert.ok(url.startsWith("rocksdb:"), url);
    assert.ok(url.endsWith("/srv/data/data-plane"), url);
  });
  it("honours an explicit MMO_DATA_PLANE_DB, including mem:// as the volatile opt-out", () => {
    assert.equal(resolveDataPlaneDbUrl("mem://", "/x"), "mem://");
    assert.equal(resolveDataPlaneDbUrl("  rocksdb:/abs/ledger ", "/x"), "rocksdb:/abs/ledger");
    assert.ok(resolveDataPlaneDbUrl("", "/x").startsWith("rocksdb:"));
  });
});
