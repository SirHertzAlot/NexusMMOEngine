import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { IssuesError, callEnvelope, invalidMessage, refuseInvalid, requestJson } from "../src/api.js";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

function fakeFetch(status: number, body: unknown): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls };
}

class DocError extends IssuesError<{ path: string }> {}

describe("api", () => {
  it("names the problems, singular and plural", () => {
    assert.equal(invalidMessage("flow", 1), "invalid flow: 1 problem");
    assert.equal(invalidMessage("flow", 2), "invalid flow: 2 problems");
  });

  it("the host's refusal is a 400 carrying the issues", () => {
    const e = refuseInvalid("scene", [{ path: "a" }, { path: "b" }], 1) as Error & { status: number; issues: unknown[] };
    assert.equal(e.message, "invalid scene: 1 problem");
    assert.equal(e.status, 400);
    assert.equal(e.issues.length, 2);
  });

  it("GETs by default and POSTs a body as JSON", async () => {
    const f = fakeFetch(200, { a: 1 });
    assert.deepEqual(await requestJson("/x", { fail: "x failed" }), { a: 1 });
    assert.equal(f.calls[0].init?.method, "GET");
    await requestJson("/x", { body: { b: 2 }, fail: "x failed" });
    assert.equal(f.calls[1].init?.method, "POST");
    assert.equal(f.calls[1].init?.body, '{"b":2}');
  });

  it("an empty success body resolves undefined", async () => {
    fakeFetch(200, undefined);
    assert.equal(await requestJson("/x", { method: "PUT", body: {}, fail: "x" }), undefined);
  });

  it("a 400 with issues becomes the document's own error", async () => {
    fakeFetch(400, { error: "invalid", issues: [{ path: "p" }] });
    await assert.rejects(
      requestJson("/x", { fail: "x", refused: (i) => new DocError(i, "refused") }),
      (e: unknown) => e instanceof DocError && e.name === "DocError" && e.issues[0].path === "p",
    );
  });

  it("without a refusal handler a 400 falls back to the host's error text", async () => {
    fakeFetch(400, { error: "bad name", issues: [] });
    await assert.rejects(requestJson("/x", { fail: "x" }), /bad name/);
  });

  it("a failure with no JSON body names the status", async () => {
    fakeFetch(502, "<html>bad gateway</html>");
    await assert.rejects(requestJson("/x", { fail: "thing failed" }), /thing failed: HTTP 502/);
  });

  it("the ok envelope throws on ok:false even with a 200", async () => {
    fakeFetch(200, { ok: false, error: "locked" });
    await assert.rejects(callEnvelope("/x", "GET"), /locked/);
    fakeFetch(200, { ok: true, v: 3 });
    assert.equal(((await callEnvelope("/x", "POST", {})) as { v: number }).v, 3);
  });

  it("the envelope error carries the host's whole answer and PUT sends a body", async () => {
    const { calls } = fakeFetch(400, { ok: false, error: "bad patch", issues: [{ path: "a" }] });
    await assert.rejects(callEnvelope("/x", "PUT", { n: 1 }), (e: Error & { body?: { issues?: unknown[] } }) => e.message === "bad patch" && e.body?.issues?.length === 1);
    assert.equal(calls[0].init?.method, "PUT");
    assert.equal(calls[0].init?.body, '{"n":1}');
  });
});
