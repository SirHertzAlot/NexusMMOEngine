/**
 * Drops with interest management (IM5): a ground item's drop row (0x15) goes to a session only when the
 * item is in its view, and a drop the session missed (it lay out of view) arrives when its sector comes
 * into view, so a player never sees a ground item with no name. Each drop goes out once per session.
 */
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { decodeControl, MessageType, type DropsMessage } from "@mmo-engine/protocol";
import { engineDefaults } from "@mmo-engine/rules";
import { Gateway } from "../../src/net/gateway.js";
import { Transform } from "../../src/components.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";
import { HeadlessClient } from "./headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./auth-harness.js";

const STEP_MS = 1000 / 30;
let now = 0;
let gw: Gateway | null = null;

const POOL: PoolItemLike[] = [
  {
    id: "a", rank: "common", source: "mob", item: "sword", seed: 0,
    bundle: { Identity: { id: "a", name: "Sword a", base: "sword" }, Rank: { id: "common", color: "#aaaaaa" }, Stats: { power: 10 } },
  },
];

function makeItems(): ItemService {
  const rules = engineDefaults();
  rules.items.bases.sword = {
    ...rules.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01"],
  };
  return new ItemService({ defs: new ItemDefs(POOL, rules), loot: rules.loot, tickHz: 30 });
}

afterEach(async () => {
  await gw?.close();
  gw = null;
});

function frames(n: number): void {
  for (let i = 0; i < n; i++) {
    now += STEP_MS;
    gw!.frame(now);
  }
}

/** Run n frames and wait until the client has received each one's DeltaSet. */
async function run(n: number, client: HeadlessClient): Promise<void> {
  const waited = client.waitFor(MessageType.DeltaSet, n);
  frames(n);
  await waited;
}

/** Every drop wire id named to this client so far. */
function droppedIds(client: HeadlessClient): Set<string> {
  const out = new Set<string>();
  for (const p of client.payloads(MessageType.Drops)) {
    for (const [id] of decodeControl<DropsMessage>(p).drops) out.add(id);
  }
  return out;
}

it("a far drop is not sent; it arrives when its item comes into view", async () => {
  now = 1_000_000;
  const items = makeItems();
  gw = new Gateway({
    clock: () => now,
    credentialStore: await makeCredentialStore(),
    systems: [items],
    items,
    interest: { enterM: 96, leaveM: 128 },
  });
  const url = `ws://127.0.0.1:${await gw.listen()}`;
  gw.frame(now);

  const client = new HeadlessClient();
  await client.connect(url);
  await client.hello("alice", { username: "alice", password: TEST_PASSWORD });
  await run(3, client);

  // An item lies 1.4 km away: alice is not sent its drop row.
  const { eid } = items.spawnDrop(gw.world, 0, 1000, 1000, 0);
  const wid = String(gw.world.wireId(eid));
  await run(3, client);
  assert.ok(!droppedIds(client).has(wid), "a drop 1.4 km away is not sent");

  // The item is moved into alice's sector: its row arrives then, once.
  Transform.px[eid] = 20;
  Transform.pz[eid] = 20;
  await run(3, client);
  assert.ok(droppedIds(client).has(wid), "the drop's row arrives when its item comes into view");

  client.close();
});
