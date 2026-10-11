/**
 * TDD: GET /health for deploy health checks (EA19). Answers 200 "ok"
 * and claims the request; everything else falls through (false) so it
 * composes with the other handlers on the game port.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { healthHttpHandler } from "../../src/net/health.js";
import type { HttpRequest, HttpResponse } from "../../src/net/transport.js";

function req(method: string, url: string): HttpRequest {
  return {
    method,
    url,
    header: () => "",
    readBody: () => Promise.reject(new Error("no body")),
  };
}

function res(): HttpResponse & { sent: { status: number; body: string } | null } {
  const r: HttpResponse & { sent: { status: number; body: string } | null } = {
    sent: null,
    get done() {
      return this.sent !== null;
    },
    send(status, _headers, body) {
      this.sent = { status, body: typeof body === "string" ? body : "" };
    },
    abort() {},
  };
  return r;
}

describe("healthHttpHandler", () => {
  it("answers GET /health with 200 and claims it", () => {
    const r = res();
    assert.equal(healthHttpHandler(req("GET", "/health"), r), true);
    assert.equal(r.sent?.status, 200);
  });

  it("ignores query strings on /health", () => {
    const r = res();
    assert.equal(healthHttpHandler(req("GET", "/health?deep=1"), r), true);
    assert.equal(r.sent?.status, 200);
  });

  it("falls through on other paths and methods", () => {
    for (const [m, u] of [["GET", "/"], ["POST", "/health"], ["GET", "/rpc/Pcg/ListAssets"]] as const) {
      const r = res();
      assert.equal(healthHttpHandler(req(m, u), r), false, `${m} ${u}`);
      assert.equal(r.sent, null);
    }
  });
});
