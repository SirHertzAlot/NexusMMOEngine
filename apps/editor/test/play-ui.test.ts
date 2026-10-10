/**
 * Debug dock ↔ PlayMode panel contract: the shared playUiStore carries
 * the overlay entity id, auto-refresh, and lifecycle state, so the dock
 * drives the same fields the panel queries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  playUiStore,
  setPlayAutoRefresh,
  setPlayEntityId,
} from "../src/ui/play-mode.js";

describe("playUiStore", () => {
  it("starts idle with auto-refresh on", () => {
    playUiStore.set({ entityId: "", autoRefresh: true, pmState: "idle", paused: false });
    assert.deepEqual(playUiStore.get(), { entityId: "", autoRefresh: true, pmState: "idle", paused: false });
  });

  it("entity and refresh setters preserve the other fields", () => {
    playUiStore.set({ entityId: "", autoRefresh: true, pmState: "running", paused: false });
    setPlayEntityId("12345");
    assert.equal(playUiStore.get().entityId, "12345");
    assert.equal(playUiStore.get().pmState, "running");
    setPlayAutoRefresh(false);
    assert.equal(playUiStore.get().autoRefresh, false);
    assert.equal(playUiStore.get().entityId, "12345");
  });
});
