/**
 * Admin `vendor` commands through the real gateway: define, stock,
 * attach, list — including the error paths.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type AdminResult } from "@mmo-engine/protocol";
import { Gateway } from "../../src/net/gateway.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";
import { WalletSystem } from "../../src/economy/wallet.js";
import { VendorSystem } from "../../src/economy/vendor.js";

let gw: Gateway | null = null;
let vendor: VendorSystem;

async function startGateway(): Promise<string> {
  const wallet = new WalletSystem();
  vendor = new VendorSystem(wallet, { give: () => false, take: () => false, defOf: () => -1 });
  gw = new Gateway({
    clock: () => Date.now(),
    admins: ["alice"],
    credentialStore: await makeCredentialStore(),
    systems: [wallet, vendor],
  });
  const port = await gw.listen();
  gw.frame(Date.now());
  return `ws://127.0.0.1:${port}`;
}

const creds = (username: string): HelloAuth => ({ username, password: TEST_PASSWORD });

async function join(url: string, username: string): Promise<HeadlessClient> {
  const client = new HeadlessClient();
  await client.connect(url);
  const snapP = client.waitFor(MessageType.Snapshot, 1);
  await client.hello(username, creds(username));
  await snapP;
  return client;
}

async function admin(client: HeadlessClient, command: string, args?: unknown): Promise<AdminResult> {
  const resP = client.waitFor(MessageType.Admin, 1);
  client.sendRaw(
    MessageType.Admin,
    encodeControl(args === undefined ? { kind: "admin", command } : { kind: "admin", command, args }),
  );
  const [payload] = await resP;
  return decodeControl<AdminResult>(payload);
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("admin: vendor commands", () => {
  it("define -> stock -> list -> attach all work", async () => {
    const url = await startGateway();
    const client = await join(url, "alice");

    const d = await admin(client, "vendor", { sub: "define", id: "blacksmith", name: "Blacksmith" });
    assert.equal(d.ok, true);
    assert.match(d.message, /blacksmith/);

    const s = await admin(client, "vendor", { sub: "stock", id: "blacksmith", def: 7, price: 100 });
    assert.equal(s.ok, true);
    assert.match(s.message, /def 7 at 100g/);

    const l = await admin(client, "vendor", { sub: "list" });
    assert.equal(l.ok, true);
    assert.match(l.message, /blacksmith/);

    // Attach the vendor to our own avatar.
    const sessions = [...(gw as unknown as { sessions: Map<string, { playerEntity: bigint }> }).sessions.values()];
    const wireId = sessions[0].playerEntity.toString();
    const a = await admin(client, "vendor", { sub: "attach", id: "blacksmith", target: wireId });
    assert.equal(a.ok, true);
    assert.match(a.message, /attached/);
    assert.equal(vendor.vendorOf(Number(sessions[0].playerEntity))?.id, "blacksmith");
    await client.close();
  });

  it("errors are clean", async () => {
    const url = await startGateway();
    const client = await join(url, "alice");

    await admin(client, "vendor", { sub: "define", id: "smith" });
    // Failures come back as error 4003 (the pattern for all admin commands).
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(
      MessageType.Admin,
      encodeControl({ kind: "admin", command: "vendor", args: { sub: "define", id: "smith" } }),
    );
    const [errPayload] = await errP;
    assert.match(decodeControl<{ message: string }>(errPayload).message, /already defined/);

    const errP2 = client.waitFor(MessageType.Error, 1);
    client.sendRaw(
      MessageType.Admin,
      encodeControl({ kind: "admin", command: "vendor", args: { sub: "stock", id: "nope", def: 7, price: 100 } }),
    );
    const [errPayload2] = await errP2;
    assert.match(decodeControl<{ message: string }>(errPayload2).message, /unknown vendor/);

    const l = await admin(client, "vendor", { sub: "list" });
    assert.equal(l.ok, true);
    assert.match(l.message, /smith/);
    await client.close();
  });

  it("a non-admin is rejected", async () => {
    const url = await startGateway();
    const client = await join(url, "user-b");
    const errP = client.waitFor(MessageType.Error, 1);
    client.sendRaw(
      MessageType.Admin,
      encodeControl({ kind: "admin", command: "vendor", args: { sub: "list" } }),
    );
    const [errPayload] = await errP;
    assert.match(decodeControl<{ message: string }>(errPayload).message, /admin/i);
    await client.close();
  });
});
