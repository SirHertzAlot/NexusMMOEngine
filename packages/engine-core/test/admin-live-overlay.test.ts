/**
 * Graphify H4 selection-scoped live overlay tests:
 *  1. `projectEntityOverlay` values match text `inspectEntity` projections.
 *  2. `EntityFieldTracker` stays inert (`hasWatches=false`) until an entity
 *     is inspected, bounds active watches via LRU + TTL expiry, and tracks
 *     exact `lastWriter` (`{ system, tick }`) without full-world scans.
 *  3. Real `Gateway` serves both text `inspect` and `format: "json"` live
 *     overlay over the WebSocket admin channel with `buildCommit` metadata.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { addComponent } from "bitecs";
import { decodeControl, encodeControl, MessageType, type AdminResult } from "@mmo-engine/protocol";
import * as C from "../src/components.js";
import {
  EntityFieldTracker,
  MAX_WATCHED_ENTITIES,
  WATCH_TTL_TICKS,
  inspectEntity,
  projectEntityOverlay,
  type LiveEntityOverlay,
} from "../src/index.js";
import { IntentSystem, IntegrateSystem } from "../src/systems.js";
import { STEP_MS } from "../src/tick-loop.js";
import { SimWorld } from "../src/world.js";
import { Gateway, type GatewayOptions } from "../src/net/gateway.js";
import { HeadlessClient, type HelloAuth } from "./net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "./net/auth-harness.js";

let gw: Gateway | null = null;

afterEach(async () => {
  if (gw) {
    await gw.close();
    gw = null;
  }
});

async function startGateway(opts: GatewayOptions = {}): Promise<{ gw: Gateway; url: string }> {
  let now = 1_000_000;
  const g = new Gateway({
    clock: () => now,
    disconnectGraceMs: 1000,
    credentialStore: await makeCredentialStore(),
    transport: "ws",
    ...opts,
  });
  const port = await g.listen();
  g.frame(now);
  gw = g;
  return { gw: g, url: `ws://127.0.0.1:${port}` };
}

async function adminCall(client: HeadlessClient, command: string, args?: unknown): Promise<AdminResult> {
  const resP = client.waitFor(MessageType.Admin, 1);
  client.sendRaw(MessageType.Admin, encodeControl({ kind: "admin", command, args }));
  const [payload] = await resP;
  return decodeControl<AdminResult>(payload);
}

describe("Graphify H4 selection-scoped live overlay", () => {
  it("projects identical values to text inspectEntity and records per-field lastWriter", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    sim.beginTick(1);

    const eid = sim.spawn();
    addComponent(sim.ecs, C.Transform, eid);
    addComponent(sim.ecs, C.Velocity, eid);
    addComponent(sim.ecs, C.PlayerIntent, eid);
    addComponent(sim.ecs, C.Health, eid);
    C.Transform.px[eid] = 10.1234;
    C.Transform.py[eid] = 2.5;
    C.Transform.pz[eid] = -4.5678;
    C.Transform.qw[eid] = 1;
    C.Health.current[eid] = 85.449;
    C.Health.max[eid] = 100;
    C.PlayerIntent.mx[eid] = 1;

    const unwatched = sim.spawn();
    addComponent(sim.ecs, C.Transform, unwatched);
    addComponent(sim.ecs, C.Velocity, unwatched);
    addComponent(sim.ecs, C.PlayerIntent, unwatched);
    C.PlayerIntent.mx[unwatched] = 1;

    const wire = sim.wireId(eid);
    const otherWire = sim.wireId(unwatched);
    const tracker = new EntityFieldTracker();
    assert.equal(tracker.hasWatches, false);

    // Initial inspect activates the watch for `wire` only.
    const initial = projectEntityOverlay(sim, wire, "deadbeef1234", tracker);
    assert.ok(initial);
    assert.equal(initial.buildCommit, "deadbeef1234");
    assert.equal(tracker.hasWatches, true);
    assert.equal(tracker.watchedCount, 1);

    // Verify field values match the text `inspectEntity` output (`r2` rounding).
    const textDump = inspectEntity(sim, wire)!;
    const tComp = initial.components.find((c) => c.component === "Transform");
    assert.ok(tComp);
    const px = tComp.fields.find((f) => f.name === "px")?.value;
    const py = tComp.fields.find((f) => f.name === "py")?.value;
    const pz = tComp.fields.find((f) => f.name === "pz")?.value;
    assert.ok(textDump.includes(`Transform: pos ${px} ${py} ${pz}`));
    const hComp = initial.components.find((c) => c.component === "Health");
    assert.ok(hComp);
    assert.ok(
      textDump.includes(
        `Health: ${hComp.fields.find((f) => f.name === "current")?.value}/${hComp.fields.find((f) => f.name === "max")?.value}`,
      ),
    );

    // Step IntentSystem then IntegrateSystem with the tracker around each step.
    sim.beginTick(2);
    const intent = new IntentSystem();
    const integrate = new IntegrateSystem();
    for (const sys of [intent, integrate]) {
      tracker.beforeSystem(sim, sys.access);
      sys.step(sim, STEP_MS / 1000);
      tracker.afterSystem(sim, sys.name, sys.access);
    }

    const updated = projectEntityOverlay(sim, wire, "deadbeef1234", tracker)!;
    const vel = updated.components.find((c) => c.component === "Velocity")!;
    const tr = updated.components.find((c) => c.component === "Transform")!;
    assert.deepEqual(vel.fields.find((f) => f.name === "lx")?.lastWriter, { system: "intent", tick: 2 });
    assert.deepEqual(tr.fields.find((f) => f.name === "px")?.lastWriter, { system: "integrate", tick: 2 });
    assert.equal(tr.fields.find((f) => f.name === "py")?.lastWriter, undefined, "unmodified field has no writer");
    assert.equal(tracker.lastWriterOf(otherWire, "Transform", "px"), undefined, "unwatched entity was not scanned");
  });

  it("caps watched entities (LRU) and expires stale watches automatically", () => {
    const tracker = new EntityFieldTracker();
    for (let i = 1; i <= MAX_WATCHED_ENTITIES + 5; i++) {
      tracker.watch(BigInt(i), 10);
    }
    assert.equal(tracker.watchedCount, MAX_WATCHED_ENTITIES);
    tracker.pruneExpired(10 + WATCH_TTL_TICKS + 1);
    assert.equal(tracker.hasWatches, false);
    assert.equal(tracker.watchedCount, 0);
  });

  it("serves inspect { format: 'json' } over Gateway admin channel and tracks live writes", async () => {
    const { gw: server, url } = await startGateway({
      admins: ["alice"],
      buildCommit: "cafebabe0001",
    });
    const client = new HeadlessClient();
    await client.connect(url);
    const auth: HelloAuth = { username: "alice", password: TEST_PASSWORD };
    const snapP = client.waitFor(MessageType.Snapshot, 1);
    const welcome = await client.hello("alice", auth);
    await snapP;

    const myId = welcome.player_entity;
    const first = await adminCall(client, "inspect", { entity: myId, format: "json" });
    assert.equal(first.ok, true);
    const parsedFirst = JSON.parse(first.message) as LiveEntityOverlay;
    assert.equal(parsedFirst.wireId, myId);
    assert.equal(parsedFirst.buildCommit, "cafebabe0001");
    assert.ok(parsedFirst.components.some((c) => c.component === "Transform"));

    // Drive movement intent then step Gateway ticks so IntentSystem & IntegrateSystem write fields.
    const eid = server.world.resolveWireId(BigInt(myId));
    server.world.queueIntent(eid, { mx: 1, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 });
    let now = 1_000_000 + STEP_MS * 2;
    server.frame(now);
    now += STEP_MS;
    server.frame(now);

    const textRes = await adminCall(client, "inspect", { entity: myId });
    const jsonRes = await adminCall(client, "inspect", { entity: myId, format: "json" });
    assert.equal(textRes.ok, true);
    assert.equal(jsonRes.ok, true);
    const overlay = JSON.parse(jsonRes.message) as LiveEntityOverlay;
    const transform = overlay.components.find((c) => c.component === "Transform")!;
    const px = transform.fields.find((f) => f.name === "px")!;
    const py = transform.fields.find((f) => f.name === "py")!;
    const pz = transform.fields.find((f) => f.name === "pz")!;
    assert.ok(textRes.message.includes(`Transform: pos ${px.value} ${py.value} ${pz.value}`));
    assert.equal(px.lastWriter?.system, "integrate");

    await client.close();
  });
});
