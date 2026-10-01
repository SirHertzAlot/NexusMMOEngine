/**
 * Admin console (roadmap A1, protocol 0x10): real Gateway + WebSocket
 * clients. An admin runs help/whoami and lands in the command log; a
 * non-admin, a malformed or unknown command, and a pre-welcome sender
 * are all answered 4003 and logged as rejected.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  MessageType,
  type AdminResult,
  type ErrorMessage,
} from "@mmo-engine/protocol";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    ...opts,
  });
  const port = await gw.listen();
  gw.frame(now);
  return `ws://127.0.0.1:${port}`;
}

const creds = (username: string): HelloAuth => ({
  username,
  password: TEST_PASSWORD,
});

async function join(url: string, username: string): Promise<{ client: HeadlessClient; entity: bigint }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(username, creds(username));
  await snapP;
  return { client, entity: BigInt(welcome.player_entity) };
}

async function joinClient(url: string, username: string): Promise<HeadlessClient> {
  return (await join(url, username)).client;
}

async function admin(client: HeadlessClient, command: string, args?: unknown): Promise<AdminResult> {
  const resP = client.waitFor(MessageType.Admin, 1);
  client.sendRaw(MessageType.Admin, encodeControl(args === undefined ? { kind: "admin", command } : { kind: "admin", command, args }));
  const [payload] = await resP;
  return decodeControl<AdminResult>(payload);
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: admin console", () => {
  it("a named admin runs help and whoami", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = await joinClient(url, "alice");
    const help = await admin(client, "help");
    assert.equal(help.ok, true);
    assert.match(help.message, /whoami/);
    const who = await admin(client, "whoami");
    assert.equal(who.ok, true);
    assert.match(who.message, /alice/);
    const log = gw!.adminLogEntries();
    assert.deepEqual(
      log.map((e) => [e.username, e.command, e.ok]),
      [["alice", "help", true], ["alice", "whoami", true]],
    );
    await client.close();
  });

  it("a non-admin is rejected and logged", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = await joinClient(url, "user-a");
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "whoami" }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    assert.deepEqual(
      gw!.adminLogEntries().map((e) => [e.username, e.command, e.ok]),
      [["user-a", "whoami", false]],
    );
    await client.close();
  });

  it("unknown and malformed commands are rejected", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = await joinClient(url, "alice");
    const errP = client.waitFor(MessageType.Error, 2);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "nuke" }));
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin" }));
    const errs = await errP;
    for (const payload of errs) assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    await client.close();
  });

  it("pre-welcome senders are rejected", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = new HeadlessClient();
    await client.connect(url);
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "whoami" }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    await client.close();
  });

  it("a dev server treats every account as admin", async () => {
    const url = await startGateway({ devServer: true });
    const client = await joinClient(url, "user-b");
    const who = await admin(client, "whoami");
    assert.equal(who.ok, true);
    assert.match(who.message, /dev server/);
    await client.close();
  });

  it("inspect dumps the caller's own avatar as me", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const client = await joinClient(url, "alice");
    const res = await admin(client, "inspect", { entity: "me" });
    assert.equal(res.ok, true);
    assert.match(res.message, /Transform: pos /);
    assert.match(res.message, /Health: /);
    assert.match(res.message, /Locomotion: /);
    await client.close();
  });

  it("inspect reads an arbitrary entity id and rejects unknown ones", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client, entity } = await join(url, "alice");
    const res = await admin(client, "inspect", { entity: entity.toString() });
    assert.equal(res.ok, true);
    assert.match(res.message, new RegExp(`entity ${entity}`));
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "inspect", args: { entity: "999999999999" } }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003);
    await client.close();
  });

  it("set changes a field and inspect shows it; bad writes are rejected", async () => {    const url = await startGateway({ admins: ["alice"] });
    const { client, entity } = await join(url, "alice");
    const set = await admin(client, "set", { entity: entity.toString(), component: "Health", field: "current", value: 33 });
    assert.equal(set.ok, true);
    assert.match(set.message, /Health\.current = 33/);
    const after = await admin(client, "inspect", { entity: entity.toString() });
    assert.match(after.message, /Health: 33\//);
    const bad = [
      { entity: entity.toString(), component: "Nope", field: "current", value: 1 },
      { entity: entity.toString(), component: "Health", field: "nope", value: 1 },
      { entity: entity.toString(), component: "Locomotion", field: "mode", value: 1.5 },
      { entity: "999999999999", component: "Health", field: "current", value: 1 },
    ];
    for (const args of bad) {
      const errP = client.waitFor(MessageType.Error, 1);
      client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "set", args }));
      const [payload] = await errP;
      assert.equal(decodeControl<ErrorMessage>(payload).code, 4003, JSON.stringify(args));
    }
    // The pool still reads through the sim: a rejected write changed nothing.
    const same = await admin(client, "inspect", { entity: entity.toString() });
    assert.match(same.message, /Health: 33\//);
    await client.close();
  });

  it("teleport moves the avatar with ground snap; heal fills; fly flips the bit", async () => {
    const url = await startGateway({ admins: ["alice"], groundHeightAt: () => 42 });
    const { client, entity } = await join(url, "alice");
    const tp = await admin(client, "teleport", { x: 100, z: 200 });
    assert.equal(tp.ok, true);
    assert.match(tp.message, /teleported .* to 100 200/);
    const at = await admin(client, "inspect", { entity: entity.toString() });
    assert.match(at.message, /Transform: pos 100 42 200/);
    const hurt = await admin(client, "set", { entity: entity.toString(), component: "Health", field: "current", value: 5 });
    assert.equal(hurt.ok, true);
    const healed = await admin(client, "heal", {});
    assert.equal(healed.ok, true);
    assert.match(healed.message, /healed .* to 100/);
    const fly = await admin(client, "fly", { on: true });
    assert.equal(fly.ok, true);
    const flying = await admin(client, "inspect", { entity: entity.toString() });
    assert.match(flying.message, /Locomotion: mode 0 abilities 3 breath/);
    const grounded = await admin(client, "fly", { on: false });
    assert.equal(grounded.ok, true);
    await client.close();
  });

  it("spawnlist names the table; spawn plants at me; despawn removes", async () => {
    const url = await startGateway({
      admins: ["alice"],
      spawnTable: { version: 1, archetypes: { "test-tree": { asset: "test-tree" } } },
    });
    const { client } = await join(url, "alice");
    const list = await admin(client, "spawnlist");
    assert.equal(list.ok, true);
    assert.match(list.message, /test-tree/);
    const spawned = await admin(client, "spawn", { asset: "test-tree" });
    assert.equal(spawned.ok, true);
    const id = spawned.message.split(" ").at(-1)!;
    const seen = await admin(client, "inspect", { entity: id });
    assert.equal(seen.ok, true);
    assert.match(seen.message, /AssetRef: hash \d+ variant 0/);
    const gone = await admin(client, "despawn", { entity: id });
    assert.equal(gone.ok, true);
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command: "inspect", args: { entity: id } }));
    const [payload] = await errP;
    assert.equal(decodeControl<ErrorMessage>(payload).code, 4003, "despawned reads as unknown");
    await client.close();
  });

  it("spawn rejects unknown assets; despawn refuses live avatars", async () => {
    const url = await startGateway({
      admins: ["alice"],
      spawnTable: { version: 1, archetypes: { "test-tree": { asset: "test-tree" } } },
    });
    const { client, entity } = await join(url, "alice");
    for (const args of [{ asset: "nope" }, { entity: entity.toString() }]) {
      const errP = client.waitFor(MessageType.Error, 1);
      client.sendRaw(
        MessageType.Admin,
        encodeControl({ kind: "admin", command: args.asset ? "spawn" : "despawn", args }),
      );
      const [payload] = await errP;
      assert.equal(decodeControl<ErrorMessage>(payload).code, 4003, JSON.stringify(args));
    }
    await client.close();
  });
});
