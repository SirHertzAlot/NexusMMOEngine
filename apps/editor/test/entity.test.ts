/**
 * Unit and integration tests for Entity Inspector API and Component.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchEntities, fetchEntityDetail } from "../src/api/entity.js";

describe("Entity Inspector API & Component", () => {
  it("fetches mock entity list successfully", async () => {
    const list = await fetchEntities();
    assert.ok(Array.isArray(list), "entities list should be an array");
    assert.ok(list.length > 0, "should return at least one mock entity");
    assert.equal(typeof list[0].id, "string");
    assert.equal(typeof list[0].name, "string");
  });

  it("fetches entity detail successfully for valid ID", async () => {
    const detail = await fetchEntityDetail("entity-1");
    assert.ok(detail, "should return entity detail");
    assert.equal(detail.id, "entity-1");
    assert.equal(detail.name, "Hero Player");
    assert.ok(detail.components, "should contain components");
    assert.ok(detail.health, "should contain health info");
  });

  it("returns null for non-existent entity detail", async () => {
    const detail = await fetchEntityDetail("non-existent-id");
    assert.equal(detail, null);
  });
});
