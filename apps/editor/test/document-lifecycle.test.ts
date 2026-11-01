/**
 * Document lifecycle (roadmap M9): new, load, import, export and retry run
 * through the controller with a fake adapter. A failed operation keeps its
 * message and can be run again; a successful one clears its error.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDocumentLifecycle, INITIAL_LIFECYCLE, type LifecycleAdapter } from "../src/ui/document-lifecycle.js";

function fakeAdapter(over: Partial<LifecycleAdapter> = {}): LifecycleAdapter & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    create: async (kind, name) => {
      created.push(`${kind}/${name}`);
    },
    list: async (kind) => (kind === "scene" ? ["camp", "forest-camp"] : []),
    importFile: async () => "saved.json",
    exportFile: async () => "camp.json",
    ...over,
  };
}

describe("document lifecycle: the operations", () => {
  it("new creates the document and reloads its kind's names", async () => {
    const a = fakeAdapter();
    const life = createDocumentLifecycle(a);
    await life.run({ type: "new", kind: "scene", name: "  forest-camp " });
    assert.deepEqual(a.created, ["scene/forest-camp"], "the name is trimmed");
    assert.deepEqual(life.state.names.scene, ["camp", "forest-camp"]);
    assert.equal(life.state.error, null);
    assert.equal(life.state.busy, null);
  });

  it("load fills the names of one kind and leaves the others alone", async () => {
    const life = createDocumentLifecycle(fakeAdapter());
    await life.run({ type: "load", kind: "scene" });
    assert.deepEqual(life.state.names, { scene: ["camp", "forest-camp"] });
    await life.run({ type: "load", kind: "build" });
    assert.deepEqual(life.state.names, { scene: ["camp", "forest-camp"], build: [] });
  });

  it("import records the file it took, and a dismissed picker records nothing", async () => {
    let next: string | null = "saved.json";
    const life = createDocumentLifecycle(fakeAdapter({ importFile: async () => next }));
    await life.run({ type: "import" });
    assert.equal(life.state.lastFile, "saved.json");
    next = null;
    await life.run({ type: "import" });
    assert.equal(life.state.lastFile, "saved.json", "dismissing the picker keeps the last file");
    assert.equal(life.state.error, null);
  });

  it("export records the file it wrote", async () => {
    const life = createDocumentLifecycle(fakeAdapter());
    await life.run({ type: "export" });
    assert.equal(life.state.lastFile, "camp.json");
  });

  it("refuses an empty name before any call is made", async () => {
    const a = fakeAdapter();
    const life = createDocumentLifecycle(a);
    await life.run({ type: "new", kind: "scene", name: "   " });
    assert.deepEqual(a.created, []);
    assert.equal(life.state.error, "a document needs a name");
  });
});

describe("document lifecycle: failure and retry", () => {
  it("keeps the failure message and retry runs the failed operation again", async () => {
    let fail = true;
    const a = fakeAdapter({
      create: async (kind, name) => {
        if (fail) throw new Error("scene/forest-camp already exists");
        a.created.push(`${kind}/${name}`);
      },
    });
    const life = createDocumentLifecycle(a);
    await life.run({ type: "new", kind: "scene", name: "forest-camp" });
    assert.equal(life.state.error, "scene/forest-camp already exists");
    assert.equal(life.state.busy, null, "a failed operation is not left busy");
    fail = false;
    await life.retry();
    assert.deepEqual(a.created, ["scene/forest-camp"]);
    assert.equal(life.state.error, null, "a successful retry clears the error");
  });

  it("retry does nothing after a success or before any operation", async () => {
    let calls = 0;
    const life = createDocumentLifecycle(
      fakeAdapter({
        list: async () => {
          calls++;
          return [];
        },
      }),
    );
    await life.retry();
    assert.equal(calls, 0, "no operation yet");
    await life.run({ type: "load", kind: "scene" });
    await life.retry();
    assert.equal(calls, 1, "the last load succeeded, so retry has nothing to run");
  });

  it("reports busy while an operation runs, then clears it", async () => {
    const seen: (string | null)[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const life = createDocumentLifecycle(
      fakeAdapter({
        list: async () => {
          await gate;
          return [];
        },
      }),
      (s) => seen.push(s.busy),
    );
    const pending = life.run({ type: "load", kind: "scene" });
    assert.equal(life.state.busy, "load");
    release();
    await pending;
    assert.equal(life.state.busy, null);
    assert.ok(seen.includes("load"));
    assert.equal(INITIAL_LIFECYCLE.busy, null, "the initial state is idle");
  });
});
