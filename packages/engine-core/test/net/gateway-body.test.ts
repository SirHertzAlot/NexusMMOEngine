/**
 * The player's body over the wire (roadmap M2, protocol 0x18): joining
 * sends it whole; an injury is sent within a few ticks, and only once.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, MessageType, type BodyMessage } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { BodySystem } from "../../src/body.js";
import { SimWorld } from "../../src/world.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: body", () => {
  it("sends the player's body on joining and when it is hurt", async () => {
    const { rules, hooks } = loadGameRules();
    const world = new SimWorld();
    const body = new BodySystem(rules.body, hooks);
    now = 1_000_000;
    gw = new Gateway({ clock: () => now, world, credentialStore: await makeCredentialStore(), systems: [body], body });
    const port = await gw.listen();
    gw.frame(now);
    const tick = (n: number): void => {
      for (let i = 0; i < n; i++) {
        now += 1000 / 30;
        gw!.frame(now);
      }
    };

    const client = new HeadlessClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    const first = client.waitFor(MessageType.Body, 1);
    tick(1); // the avatar's body is made on the first tick it is seen
    const welcome = await client.hello("alice", { username: "alice", password: TEST_PASSWORD });
    tick(6);
    const joined = decodeControl<BodyMessage>((await first)[0]);
    assert.equal(joined.kind, "body");
    assert.equal(joined.entity, welcome.player_entity);
    assert.deepEqual(joined.parts.map((p) => p.id), rules.body.parts.map((p) => p.id));
    assert.ok(joined.parts.every((p) => p.state === "healthy" && p.hp === 1 && !p.bleeding));
    assert.equal(joined.blood, rules.body.blood.max);

    const hurt = client.waitFor(MessageType.Body, 1);
    const eid = world.resolveWireId(BigInt(welcome.player_entity));
    body.applyBlow(world, eid, "legLeft", "cut", 2);
    tick(6);
    const after = decodeControl<BodyMessage>((await hurt)[0]);
    const leg = after.parts.find((p) => p.id === "legLeft")!;
    assert.equal(leg.state, "harmed");
    assert.ok(leg.bleeding);
    assert.ok(leg.hp < 1);
    await client.close();
  });
});
