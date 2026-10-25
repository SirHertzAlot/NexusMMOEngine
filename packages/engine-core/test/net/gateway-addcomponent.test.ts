/**
 * Admin `addcomponent` over the wire (viewport authoring): an admin
 * gives an entity a component it lacks, with defaults; inspect shows
 * it; `set` can then tune its fields. Refusals — already present, no
 * defined defaults, unknown component, unknown entity — answer 4003.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type AdminResult, type ErrorMessage } from "@mmo-engine/protocol";
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

const creds = (username: string): HelloAuth => ({ username, password: TEST_PASSWORD });

async function join(url: string, username: string): Promise<{ client: HeadlessClient; entity: bigint }> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  const welcome = await client.hello(username, creds(username));
  await snapP;
  return { client, entity: BigInt(welcome.player_entity) };
}

async function admin(client: HeadlessClient, command: string, args?: unknown): Promise<AdminResult> {
  const resP = client.waitFor(MessageType.Admin, 1);
  client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command, ...(args === undefined ? {} : { args }) }));
  return decodeControl<AdminResult>((await resP)[0]);
}

async function adminError(client: HeadlessClient, command: string, args?: unknown): Promise<ErrorMessage> {
  const errP = client.waitFor(MessageType.Error, 1);
  client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command, ...(args === undefined ? {} : { args }) }));
  return decodeControl<ErrorMessage>((await errP)[0]);
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: addcomponent", () => {
  it("adds a marker component with defaults; inspect shows it; set tunes it afterwards", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client, entity } = await join(url, "alice");
    const me = entity.toString();
    const add = await admin(client, "addcomponent", { entity: me, component: "FlowRef" });
    assert.equal(add.ok, true, add.message);
    assert.match(add.message, /FlowRef added/);
    const dump = await admin(client, "inspect", { entity: me });
    assert.match(dump.message, /FlowRef: graph 0 enabled 1/);
    const tune = await admin(client, "set", { entity: me, component: "FlowRef", field: "graph", value: 12345 });
    assert.equal(tune.ok, true, tune.message);
    const after = await admin(client, "inspect", { entity: me });
    assert.match(after.message, /FlowRef: graph 12345 enabled 1/);
    await client.close();
  });

  it("refusals answer 4003: already present, no defaults, unknown component, unknown entity", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client, entity } = await join(url, "alice");
    const me = entity.toString();
    // The avatar spawns with Health — adding it again refuses.
    const present = await adminError(client, "addcomponent", { entity: me, component: "Health" });
    assert.equal(present.code, 4003);
    assert.match(present.message, /already has Health/);
    // PathState is real but system-owned: no defaults are defined for it.
    const noDefaults = await adminError(client, "addcomponent", { entity: me, component: "PathState" });
    assert.equal(noDefaults.code, 4003);
    assert.match(noDefaults.message, /no defined defaults/);
    const unknown = await adminError(client, "addcomponent", { entity: me, component: "Nope" });
    assert.equal(unknown.code, 4003);
    assert.match(unknown.message, /unknown component/);
    const ghost = await adminError(client, "addcomponent", { entity: "999999999999", component: "FlowRef" });
    assert.equal(ghost.code, 4003);
    assert.match(ghost.message, /unknown entity/);
    await client.close();
  });

  it("help lists the new command", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    const help = await admin(client, "help");
    assert.equal(help.ok, true);
    assert.match(help.message, /addcomponent/);
    await client.close();
  });
});
