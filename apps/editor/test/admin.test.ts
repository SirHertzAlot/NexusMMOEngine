/**
 * Tests for Admin API and Admin Console logic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchAdminStatus, runAdminAction } from "../src/api/admin.js";

describe("Admin API", () => {
  it("defines admin client functions", () => {
    assert.equal(typeof fetchAdminStatus, "function");
    assert.equal(typeof runAdminAction, "function");
  });
});
