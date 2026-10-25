/**
 * Item bag admin sub-actions (viewport authoring): the `items`
 * command's take / move / defof / countbase sub-actions and the
 * `drop` command's position + fixture form, over a real Gateway.
 * The verbs are ItemService's own (take / takeBase / moveItem /
 * defOf / countBase / placeFixture); the admin layer only parses,
 * targets the console holder, and reports — bags change through the
 * service, never around it.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, encodeControl, MessageType, type AdminResult, type ErrorMessage } from "@mmo-engine/protocol";
import { engineDefaults } from "@mmo-engine/rules";
import { Gateway, type GatewayOptions } from "../../src/net/gateway.js";
import { MemoryCharacterStore } from "../../src/characters/index.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";
import { HeadlessClient, type HelloAuth } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

let now = 0;
let gw: Gateway | null = null;

const POOL: PoolItemLike[] = [
  ...["a", "b", "c"].map((id, i) => ({
    id, rank: "common", source: "mob", item: "sword", seed: i,
    bundle: { Identity: { id, name: `Sword ${id}`, base: "sword" }, Rank: { id: "common", color: "#aaaaaa" }, Stats: { power: 10 } },
  })),
  {
    id: "h", rank: "common", source: "chest", item: "helm", seed: 9,
    bundle: { Identity: { id: "h", name: "Helm h", base: "helm" }, Rank: { id: "common", color: "#aaaaaa" }, Stats: { armour: 5 } },
  },
];

function makeItems(): ItemService {
  const rules = engineDefaults();
  rules.items.bases.sword = {
    ...rules.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01"],
  };
  rules.items.bases.helm = { ...rules.items.fallback, slot: "head", models: ["pack/SM_Prop_Helm_01"] };
  return new ItemService({ defs: new ItemDefs(POOL, rules), loot: rules.loot, tickHz: 30 });
}

async function startGateway(opts: GatewayOptions = {}): Promise<string> {
  now = 1_000_000;
  const items = makeItems();
  gw = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    systems: [items],
    items,
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

/** Give the caller one helm and return its item instance id (from the give message). */
async function giveHelm(client: HeadlessClient): Promise<number> {
  const r = await admin(client, "give", { base: "helm" });
  assert.equal(r.ok, true, r.message);
  const m = r.message.match(/\(item (\d+)\)/);
  assert.ok(m, r.message);
  return Number(m[1]);
}

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

describe("gateway: items bag sub-actions", () => {
  it("countbase reads the caller's bag; defof names an instance's definition", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    const item = await giveHelm(client);
    const count = await admin(client, "items", { sub: "countbase", base: "helm" });
    assert.equal(count.ok, true);
    assert.match(count.message, /you carry 1 × helm/);
    const def = await admin(client, "items", { sub: "defof", item });
    assert.equal(def.ok, true);
    assert.match(def.message, new RegExp(`item ${item}: Helm h \\[common helm\\] h`));
    const missing = await adminError(client, "items", { sub: "defof", item: 424242 });
    assert.equal(missing.code, 4003);
    assert.match(missing.message, /not a live item/);
    await client.close();
  });

  it("take by item id removes exactly that item from the caller's bag", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    const first = await giveHelm(client);
    await giveHelm(client);
    const took = await admin(client, "items", { sub: "take", item: first });
    assert.equal(took.ok, true);
    assert.match(took.message, /took Helm h/);
    const count = await admin(client, "items", { sub: "countbase", base: "helm" });
    assert.match(count.message, /you carry 1 × helm/);
    // Taking what is no longer carried refuses.
    const again = await adminError(client, "items", { sub: "take", item: first });
    assert.equal(again.code, 4003);
    assert.match(again.message, /not in your bag/);
    await client.close();
  });

  it("take by base removes one of that base", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    await giveHelm(client);
    const took = await admin(client, "items", { sub: "take", base: "helm" });
    assert.equal(took.ok, true);
    assert.match(took.message, /took one helm from your bag/);
    const count = await admin(client, "items", { sub: "countbase", base: "helm" });
    assert.match(count.message, /you carry 0 × helm/);
    const none = await adminError(client, "items", { sub: "take", base: "helm" });
    assert.equal(none.code, 4003);
    await client.close();
  });

  it("move transfers an item to another character's bag", async () => {
    // Entered as characters, the holder ids are the character ids —
    // and each avatar's inspect dump names its own (CharacterRef).
    const characterStore = new MemoryCharacterStore();
    const look = '{"gender":"male","parts":{"head":"Chr_Head_Male_03"},"colours":{}}';
    const aliceRecord = await characterStore.create("alice", "Alicia", look, 8);
    const bobRecord = await characterStore.create("user-b", "Berta", look, 9);
    const url = await startGateway({ admins: ["alice", "user-b"], characterStore });
    const { client: alice } = await join(url, "alice");
    const { client: bob, entity: bobEntity } = await join(url, "user-b");
    const bobInspect = await admin(bob, "inspect", { entity: bobEntity.toString() });
    const idm = bobInspect.message.match(/CharacterRef: character (\d+)/);
    assert.ok(idm, bobInspect.message);
    assert.equal(Number(idm[1]), bobRecord.id);
    const item = await giveHelm(alice);
    const moved = await admin(alice, "items", { sub: "move", item, to: bobRecord.id });
    assert.equal(moved.ok, true, moved.message);
    assert.match(moved.message, new RegExp(`moved item ${item} from character ${aliceRecord.id} to character ${bobRecord.id}`));
    const aliceCount = await admin(alice, "items", { sub: "countbase", base: "helm" });
    assert.match(aliceCount.message, /you carry 0 × helm/);
    const bobCount = await admin(bob, "items", { sub: "countbase", base: "helm" });
    assert.match(bobCount.message, /you carry 1 × helm/);
    await alice.close();
    await bob.close();
  });

  it("the browse read is unchanged when no sub is given", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    const browse = await admin(client, "items", { base: "sword" });
    assert.equal(browse.ok, true);
    assert.match(browse.message, /3 items:/);
    await client.close();
  });
});

describe("gateway: drop at a position / as a fixture", () => {
  it("drop with x/z places the item there and says so", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    const r = await admin(client, "drop", { base: "helm", x: 50, z: -60 });
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /dropped Helm h \(item \d+\) as \d+ at 50, -60/);
    await client.close();
  });

  it("drop with fixture places a fixture that stays", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    const r = await admin(client, "drop", { base: "helm", x: 1, z: 2, fixture: true });
    assert.equal(r.ok, true, r.message);
    assert.match(r.message, /placed Helm h \(item \d+\) as \d+ at 1, 2 — a fixture, it stays/);
    await client.close();
  });

  it("drop with only one coordinate refuses as a usage error", async () => {
    const url = await startGateway({ admins: ["alice"] });
    const { client } = await join(url, "alice");
    const err = await adminError(client, "drop", { base: "helm", x: 5 });
    assert.equal(err.code, 4003);
    assert.match(err.message, /x and z together/);
    await client.close();
  });
});
