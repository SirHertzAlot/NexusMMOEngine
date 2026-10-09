import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerRuntime, type WorkerScope } from "../src/workers/runtime.js";

/** In-memory stand-in for a worker's global scope: records what the runtime posts. */
function fakeScope() {
  const posted: any[] = [];
  const scope: WorkerScope = {
    onmessage: null,
    onerror: null,
    postMessage: (m: any) => void posted.push(m),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const send = async (data: unknown) => {
    await (scope.onmessage as (e: { data: unknown }) => Promise<void>)({ data });
  };
  return { scope, posted, send };
}

describe("WorkerRuntime", () => {
  it("runs the registered handler and posts its unwrapped result", async () => {
    const { scope, posted, send } = fakeScope();
    const rt = new WorkerRuntime({}, scope);
    rt.registerHandler("terrain", {
      type: "terrain",
      handle: async (p: any) => ({ doubled: p.n * 2 }) as any,
    });

    await send({ id: 7, type: "terrain", payload: { n: 21 } });

    assert.deepEqual(posted, [{ id: 7, type: "terrain", payload: { doubled: 42 } }]);
  });

  it("retries a failing handler with backoff, then succeeds", async () => {
    const { scope, posted, send } = fakeScope();
    const rt = new WorkerRuntime({ maxRetries: 2, retryDelayMs: 1 }, scope);
    let calls = 0;
    rt.registerHandler("pcg", {
      type: "pcg",
      handle: async () => {
        if (++calls < 3) throw new Error("flaky");
        return { ok: true } as any;
      },
    });
    await send({ id: 1, type: "pcg", payload: {} });
    assert.equal(calls, 3);
    assert.deepEqual(posted, [{ id: 1, type: "pcg", payload: { ok: true } }]);
  });

  it("posts an error response once retries are exhausted", async () => {
    const { scope, posted, send } = fakeScope();
    const rt = new WorkerRuntime({ maxRetries: 1, retryDelayMs: 1 }, scope);
    rt.registerHandler("bvh", { type: "bvh", handle: async () => { throw new Error("boom"); } });
    await send({ id: 2, type: "bvh", payload: {} });
    assert.deepEqual(posted, [{ id: 2, type: "bvh", payload: { error: "boom" } }]);
  });

  it("posts an error for an unknown task type", async () => {
    const { scope, posted, send } = fakeScope();
    new WorkerRuntime({}, scope);
    await send({ id: 3, type: "nope", payload: {} });
    assert.match(posted[0].payload.error, /No handler for task type: nope/);
  });

  it("transfers result buffers instead of copying them", async () => {
    const { scope, send } = fakeScope();
    const transfers: any[] = [];
    scope.postMessage = (_m: any, t?: Transferable[]) => void transfers.push(t);
    const rt = new WorkerRuntime({}, scope);
    const buf = new Float32Array(4);
    rt.registerHandler("terrain", { type: "terrain", handle: async () => ({ position: buf }) as any });
    await send({ id: 4, type: "terrain", payload: {} });
    assert.deepEqual(transfers, [[buf.buffer]]);
  });

  it("request() resolves with the response payload", async () => {
    const { scope, posted, send } = fakeScope();
    const rt = new WorkerRuntime({}, scope);
    const p = rt.request("bvh", {} as any);
    await send({ id: posted[0].id, type: "bvh", payload: { roots: [] } });
    assert.deepEqual(await p, { roots: [] });
  });

  it("request() rejects when the response carries an error", async () => {
    const { scope, posted, send } = fakeScope();
    const rt = new WorkerRuntime({}, scope);
    const p = rt.request("bvh", {} as any);
    await send({ id: posted[0].id, type: "bvh", payload: { error: "nope" } });
    await assert.rejects(p, /nope/);
  });

  it("runs at most maxConcurrentTasks handlers at once", async () => {
    const { scope, posted, send } = fakeScope();
    const rt = new WorkerRuntime({ maxConcurrentTasks: 2 }, scope);
    let running = 0, peak = 0;
    rt.registerHandler("pcg", {
      type: "pcg",
      handle: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return {} as any;
      },
    });
    await Promise.all([1, 2, 3, 4, 5].map((id) => send({ id, type: "pcg", payload: {} })));
    assert.equal(posted.length, 5);
    assert.equal(peak, 2);
  });
});
