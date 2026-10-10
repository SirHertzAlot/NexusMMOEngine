import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { onNewSceneRequest, requestNewScene, takeNewSceneRequest } from "../src/open-scene.js";

describe("new scene request", () => {
  it("waits for a panel that is not mounted yet, once", () => {
    requestNewScene();
    assert.equal(takeNewSceneRequest(), true);
    assert.equal(takeNewSceneRequest(), false);
  });
  it("reaches a mounted panel at once", () => {
    let calls = 0;
    const off = onNewSceneRequest(() => {
      if (takeNewSceneRequest()) calls++;
    });
    requestNewScene();
    assert.equal(calls, 1);
    off();
    requestNewScene();
    assert.equal(calls, 1);
    takeNewSceneRequest();
  });
});
