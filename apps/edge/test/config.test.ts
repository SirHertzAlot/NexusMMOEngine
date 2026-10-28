import assert from "node:assert/strict";
import { test } from "node:test";
import { gamePort, loadConfig } from "../src/config.js";

test("defaults are 3000/3001/4000", () => {
  assert.deepEqual(loadConfig({}), { httpPort: 3000, wsPort: 3001, coreChannelPort: 4000 });
});

test("env overrides are respected", () => {
  assert.deepEqual(
    loadConfig({ EDGE_HTTP_PORT: "8080", EDGE_WS_PORT: "8081", CORE_CHANNEL_PORT: "9000" }),
    { httpPort: 8080, wsPort: 8081, coreChannelPort: 9000 },
  );
});

test("EDGE_HTTP_PORT=abc throws naming the var", () => {
  assert.throws(() => loadConfig({ EDGE_HTTP_PORT: "abc" }), /EDGE_HTTP_PORT/);
});

test("out-of-range ports throw", () => {
  assert.throws(() => loadConfig({ EDGE_WS_PORT: "0" }), /EDGE_WS_PORT/);
  assert.throws(() => loadConfig({ CORE_CHANNEL_PORT: "65536" }), /CORE_CHANNEL_PORT/);
});

test("EDGE_GAME_PORT: unset is no game port; a bad one throws naming the var", () => {
  assert.equal(gamePort({}), null);
  assert.equal(gamePort({ EDGE_GAME_PORT: "7777" }), 7777);
  assert.throws(() => gamePort({ EDGE_GAME_PORT: "0" }), /EDGE_GAME_PORT/);
});
