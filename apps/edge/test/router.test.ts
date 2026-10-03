import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StubChannel } from "../src/channel-stub.js";
import { pingHandler } from "../src/modules/ping.js";
import { loadRoutes, routePacket, type RouteEntry, type RouterCtx } from "../src/router.js";

// dist/test -> repo root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ROUTES_FILE = join(ROOT, "content", "edge", "routes.json");

const routes = loadRoutes(ROUTES_FILE);
const ctx: RouterCtx = { channel: new StubChannel(), modules: { ping: pingHandler } };

function withTempRoutes(body: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "edge-routes-"));
  try {
    const path = join(dir, "routes.json");
    writeFileSync(path, JSON.stringify(body));
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("seed routes.json loads", () => {
  assert.deepEqual(routes.map((r) => r.packetType), ["ping", "player.intent", "auth.login"]);
});

test("ping route returns { pong: true }", async () => {
  const res = await routePacket({ type: "ping", id: "p1" }, routes, ctx);
  assert.deepEqual(res, { type: "ping", id: "p1", payload: { pong: true } });
});

test("unknown type answers error.unknown_packet echoing the packetType", async () => {
  const res = await routePacket({ type: "no.such", id: "u1" }, routes, ctx);
  assert.deepEqual(res, { type: "error.unknown_packet", id: "u1", payload: { packetType: "no.such" } });
});

test("packet without type answers error.bad_packet", async () => {
  const res = await routePacket({ id: "b1", payload: {} }, routes, ctx);
  assert.deepEqual(res, { type: "error.bad_packet", id: "b1", payload: { message: "packet.type must be a string" } });
  const noId = await routePacket({ type: 7 }, routes, ctx);
  assert.equal(noId.type, "error.bad_packet");
  assert.equal(noId.id, "none");
});

test("player.intent with the stub channel answers core.unavailable", async () => {
  const res = await routePacket({ type: "player.intent", id: "i1", payload: { move: 1 } }, routes, ctx);
  assert.deepEqual(res, {
    type: "core.unavailable",
    id: "i1",
    payload: { retry: true, message: "The world is restarting. Your connection is safe — try again shortly." },
  });
});

test("duplicated packetType in a routes file throws naming it", () => {
  withTempRoutes(
    { routes: [
      { packetType: "ping", destination: "local:ping" },
      { packetType: "dupe.me", destination: "core" },
      { packetType: "dupe.me", destination: "local:ping" },
    ] },
    (path) => assert.throws(() => loadRoutes(path), /duplicate packetType "dupe\.me"/),
  );
});

test("routes file lists every bad row", () => {
  withTempRoutes(
    { routes: [
      { packetType: "a", destination: "elsewhere" },
      { packetType: "", destination: "core" },
      { packetType: "b", destination: "local:Bad-Name" },
      { packetType: "c", destination: "core", extra: true },
    ] },
    (path) => {
      assert.throws(() => loadRoutes(path), (err: Error) => {
        for (const i of [0, 1, 2, 3]) assert.match(err.message, new RegExp(`routes\\[${i}\\]`));
        return true;
      });
    },
  );
});

test("local:nosuch row answers error.unknown_module", async () => {
  const custom: RouteEntry[] = [{ packetType: "mystery", destination: "local:nosuch" }];
  const res = await routePacket({ type: "mystery", id: "m1" }, custom, ctx);
  assert.deepEqual(res, { type: "error.unknown_module", id: "m1", payload: { module: "nosuch" } });
});
