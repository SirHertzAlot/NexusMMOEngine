/** scene-commands: a New / Open request reaches the Scenes panel, now or when it mounts. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { onSceneCommand, requestSceneCommand, type SceneCommand } from "../src/ui/scene-commands.js";

describe("scene-commands", () => {
  it("delivers to a mounted panel", () => {
    const got: SceneCommand[] = [];
    const off = onSceneCommand((c) => got.push(c));
    requestSceneCommand({ kind: "open", name: "arena" });
    requestSceneCommand({ kind: "new" });
    off();
    assert.deepEqual(got, [{ kind: "open", name: "arena" }, { kind: "new" }]);
  });

  it("holds the latest request until the panel mounts, then delivers it once", () => {
    requestSceneCommand({ kind: "open", name: "a" });
    requestSceneCommand({ kind: "open", name: "b" });
    const got: SceneCommand[] = [];
    const off = onSceneCommand((c) => got.push(c));
    off();
    const again: SceneCommand[] = [];
    onSceneCommand((c) => again.push(c))();
    assert.deepEqual(got, [{ kind: "open", name: "b" }]);
    assert.deepEqual(again, []);
  });

  it("a stale unregister keeps the newer panel", () => {
    const first: SceneCommand[] = [];
    const second: SceneCommand[] = [];
    const off1 = onSceneCommand((c) => first.push(c));
    const off2 = onSceneCommand((c) => second.push(c));
    off1();
    requestSceneCommand({ kind: "new" });
    off2();
    assert.deepEqual(first, []);
    assert.deepEqual(second, [{ kind: "new" }]);
  });
});
