/**
 * The stats message carries the player's hunger and thirst (U3) and
 * skills (U9), and goes out again when either moves by a display step.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { decodeControl, MessageType, type StatsMessage } from "@mmo-engine/protocol";
import { loadRules } from "@mmo-engine/rules";
import { Gateway } from "../../src/net/gateway.js";
import { SimWorld } from "../../src/world.js";
import { MasterySystem } from "../../src/stats/mastery-system.js";
import * as C from "../../src/components.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const rules = loadRules(fileURLToPath(new URL("../../../../../content/rules", import.meta.url)));

let now = 0;
let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

const statsOf = (c: HeadlessClient): StatsMessage[] => c.payloads(MessageType.Stats).map((p) => decodeControl<StatsMessage>(p));

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "condition not met in time");
}

describe("gateway: needs and skills on the stats message", () => {
  it("sends meters and every skill, then again only when one moves a display step", async () => {
    now = 1_000_000;
    const world = new SimWorld({ stats: rules.stats });
    const mastery = new MasterySystem(rules.skills, () => now);
    gw = new Gateway({ clock: () => now, disconnectGraceMs: 1000, credentialStore: await makeCredentialStore(), world, mastery });
    const port = await gw.listen();
    gw.frame(now);

    const c = new HeadlessClient();
    await c.connect(`ws://127.0.0.1:${port}`);
    const snap = c.waitFor(MessageType.Snapshot, 1);
    await c.hello("alice", { username: "alice", password: TEST_PASSWORD });
    await snap;
    await until(() => statsOf(c).length >= 1);
    const first = statsOf(c).at(-1)!;
    assert.deepEqual(first.needs, { hunger: 100, hungerMax: 100, thirst: 100, thirstMax: 100 });
    assert.equal(first.skillMax, rules.skills.max);
    assert.deepEqual(first.skills!.map((k) => k.id), rules.skills.skills.map((k) => k.id));
    assert.ok(first.skills!.every((k) => k.value === 0 && k.peak === 0));
    assert.equal(first.skills!.find((k) => k.id === "swimming")!.family, "body");

    const eid = world.resolveWireId(BigInt(c.welcome!.player_entity));
    const count = statsOf(c).length;
    // Less than a point of drain and a few hundredths of skill: nothing new.
    C.Needs.hunger[eid] = 99.6;
    const sheet = mastery.sheetOf(eid);
    const swim = mastery.index.of("swimming");
    sheet.value[swim] = 0.04;
    for (let i = 0; i < 3; i++) gw.frame((now += 50));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(statsOf(c).length, count);

    C.Needs.hunger[eid] = 98.2;
    sheet.value[swim] = sheet.peak[swim] = 12.34;
    gw.frame((now += 50));
    await until(() => statsOf(c).length === count + 1);
    const next = statsOf(c).at(-1)!;
    assert.equal(next.needs!.hunger, 99);
    assert.deepEqual(next.skills!.find((k) => k.id === "swimming"), { id: "swimming", name: "Swimming", family: "body", value: 12.3, peak: 12.3 });
    await c.close();
  });
});
