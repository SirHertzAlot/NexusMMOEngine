/** Gateway extensions (P1): a feature owning a 0x11 kind gets its messages and hears enter and leave. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import type { ExtensionPlayer, GatewayExtension } from "../../src/net/extension.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("gateway: extensions", () => {
  it("routes its kind to it, with a player handle that answers; enter and leave are told", async () => {
    const events: string[] = [];
    const ext: GatewayExtension = {
      kind: "quest",
      onEnter: (p) => events.push(`enter ${p.name}`),
      onLeave: (p) => events.push(`leave ${p.name}`),
      onMessage: (p: ExtensionPlayer, raw) => {
        events.push(`msg ${JSON.stringify(raw)} entity ${p.entity() >= 0}`);
        p.send({ kind: "quests", quests: [] });
      },
    };
    let now = 1_000_000;
    gw = new Gateway({ clock: () => now, credentialStore: await makeCredentialStore(), extensions: [ext] });
    const port = await gw.listen();
    gw.frame(now);
    const c = new HeadlessClient();
    await c.connect(`ws://127.0.0.1:${port}`);
    const snap = c.waitFor(MessageType.Snapshot, 1);
    await c.hello("alice", { username: "alice", password: TEST_PASSWORD });
    await snap;
    await until(() => events.includes("enter alice"));
    c.sendRaw(MessageType.Interact, encodeControl({ kind: "interact", npc: "warden" }));
    await until(() => c.payloads(MessageType.Chat).some((f) => decodeControl<{ kind: string }>(f).kind === "quests"));
    assert.ok(events.includes('msg {"kind":"quest","op":"talk","npc":"warden"} entity true'));
    // Other kinds still reach the chat handler.
    c.sendRaw(MessageType.Chat, encodeControl({ kind: "chat", channel: "say", text: "hi" }));
    await until(() => c.payloads(MessageType.Chat).some((f) => decodeControl<{ text?: string }>(f).text === "hi"));
    c.close();
    await until(() => events.includes("leave alice"));
    now += 1;
  });
});
