/**
 * Dungeon instances (roadmap D4): pool layouts decode and are picked by
 * rank and theme; walls hold bodies on the floor; an instance admits its
 * party by token, populates its spawn points, ends cleared when the boss
 * room falls and reports one result; the region's manager starts a run at
 * an entrance, transfers the party, lets members back in, and commits loot
 * only when the run reports.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent, defineQuery } from "bitecs";
import { encodePcgMesh, fnv1a32 } from "@mmo-engine/picg";
import { decodeControl, encodeControl, MessageType, PROTOCOL_VERSION } from "@mmo-engine/protocol";
import * as C from "../../src/components.js";
import { SimWorld } from "../../src/world.js";
import { Gateway } from "../../src/net/gateway.js";
import { MemoryCharacterStore } from "../../src/index.js";
import { loadGameRules } from "../../src/rules/boot.js";
import { DEFAULT_DUNGEON_CONTENT, loadDungeonContent, parseDungeonContent, type DungeonContent } from "../../src/dungeons/content.js";
import { DungeonPool, readLayout, walkableAt, CELL_M } from "../../src/dungeons/pool.js";
import { DungeonWallSystem } from "../../src/dungeons/walls.js";
import { PROP_SLOTS } from "../../src/dungeons/prop-mesh.js";
import { DungeonInstance, type InstanceResult } from "../../src/dungeons/instance.js";
import type { Weapon } from "../../src/combat.js";
import { InstanceManager } from "../../src/dungeons/manager.js";
import { MemoryInstanceResultStore, SqliteInstanceResultStore } from "../../src/dungeons/results.js";
import { HeadlessClient } from "../net/headless-client.js";
import { makeCredentialStore, TEST_PASSWORD } from "../net/auth-harness.js";

const game = loadGameRules();
const content = loadDungeonContent();

/** A 24 × 12 layout: an entrance room, a corridor, a boss room with two spawns, one spawn by the entrance. */
function fixture(id = "grim-abc", theme = "grim", rank = 1): Record<string, unknown> {
  const W = 24, H = 12;
  const grid = new Uint8Array(W * H).fill(2);
  const floor = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y * W + x] = 1;
  };
  floor(1, 6, 1, 10);
  floor(7, 14, 5, 6);
  floor(15, 22, 1, 10);
  return {
    format: "mmo-dungeon/1", id, name: "The Test Barrow", params: { theme }, width: W, height: H,
    rooms: [{ id: 0, cx: 3, cy: 5 }, { id: 1, cx: 18, cy: 5 }], entrance: 0, boss: 1,
    spawns: [{ x: 5, y: 2, tier: 1, room: 0 }, { x: 18, y: 4, tier: 3, room: 1 }, { x: 19, y: 6, tier: 3, room: 1 }],
    grids: { grid: Buffer.from(grid).toString("base64") },
    dressing: { rank },
    population: { spawns: [{ x: 5, y: 2, species: "skeleton" }, { x: 18, y: 4, species: "goblin" }, { x: 19, y: 6, species: "goblin" }] },
  };
}

function poolDir(entries: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  for (const f of entries) writeFileSync(join(dir, `${f.id as string}.dungeon.json`), JSON.stringify(f));
  writeFileSync(join(dir, "index.json"), JSON.stringify({
    format: "mmo-dungeon-index/1",
    dungeons: entries.map((f) => ({ id: f.id, file: `${f.id as string}.dungeon.json`, name: f.name, theme: (f.params as { theme: string }).theme, rank: (f.dressing as { rank: number }).rank, rooms: 2, width: 24, height: 12 })),
  }));
  return dir;
}

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Every entity of `sim` that has component `c`. */
const queryEntities = (sim: SimWorld, c: object): Iterable<number> => defineQuery([c])(sim.ecs);
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(20);
  }
}
type Ctl = { kind?: string; op?: string; [k: string]: unknown };
const ctl = (c: HeadlessClient): Ctl[] => c.payloads(MessageType.Chat).map((f) => decodeControl<Ctl>(f));

describe("dungeon content and pool", () => {
  it("the shipped rules and entrances load; bad ones name their problems", () => {
    assert.equal(content.rules.commit, "on-report");
    assert.deepEqual(content.rules.partySize, [1, 5]);
    assert.ok(content.entrances["barrow-gate"]);
    assert.throws(() => parseDungeonContent({ ...content.rules, partySize: [5, 1] }, { version: 1, entrances: {} }), /instances.json: partySize/);
  });

  it("decodes a layout and picks pool entries by rank and theme", () => {
    const l = readLayout(fixture());
    assert.deepEqual(l.entrance, { x: 3.5 * CELL_M, z: 5.5 * CELL_M });
    assert.equal(l.spawns.length, 3);
    assert.equal(l.spawns[0].species, "skeleton");
    assert.ok(walkableAt(l, 10 * CELL_M + 1, 5 * CELL_M + 1), "corridor");
    assert.ok(!walkableAt(l, 10 * CELL_M + 1, 2 * CELL_M + 1), "rock beside it");
    const dir = poolDir([fixture("grim-1", "grim", 1), fixture("frost-2", "frost", 2)]);
    dirs.push(dir);
    const pool = new DungeonPool(dir);
    assert.equal(pool.matching(null, []).length, 2);
    assert.deepEqual(pool.matching(2, []).map((e) => e.id), ["frost-2"]);
    assert.deepEqual(pool.matching(null, ["grim"]).map((e) => e.id), ["grim-1"]);
    assert.equal(pool.pick(3, [], 1), null);
    assert.equal(pool.pick(1, [], 99)!.id, "grim-1");
    assert.deepEqual(new DungeonPool(join(dir, "missing")).entries, []);
  });

  it("walls keep a body on the floor, sliding along them", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const e = sim.spawn();
    addComponent(sim.ecs, C.Transform, e);
    addComponent(sim.ecs, C.Velocity, e);
    const walls = new DungeonWallSystem(readLayout(fixture()));
    C.Transform.px[e] = 3;
    C.Transform.pz[e] = 3;
    walls.step(sim);
    C.Transform.px[e] = -1; // into the outer wall, and down the room
    C.Transform.pz[e] = 5;
    walls.step(sim);
    assert.deepEqual([C.Transform.px[e], C.Transform.pz[e]], [3, 5]);
  });

  it("a noclip body passes through walls", () => {
    SimWorld.resetEntityCursorForTesting();
    const sim = new SimWorld();
    const e = sim.spawn();
    addComponent(sim.ecs, C.Transform, e);
    addComponent(sim.ecs, C.Velocity, e);
    addComponent(sim.ecs, C.Noclip, e);
    const walls = new DungeonWallSystem(readLayout(fixture()));
    C.Transform.px[e] = -1; // straight into the outer wall
    C.Transform.pz[e] = 5;
    walls.step(sim);
    assert.deepEqual([C.Transform.px[e], C.Transform.pz[e]], [-1, 5]);
  });
});

describe("dungeon instance", () => {
  it("admits a member by token at the entrance, ends cleared with the boss room, and reports once", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const results: InstanceResult[] = [];
    let now = 1_000_000;
    const inst = new DungeonInstance({
      id: "run-1", entrance: "barrow-gate", layout: readLayout(fixture()), rules: content.rules, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      lootPool: [7, 8, 9], onEnd: (r) => results.push(r), now: () => now, clock: () => Date.now(), transport: "ws",
    });
    const port = await inst.start();
    closers.push(() => inst.close());
    assert.equal(inst.remaining().creatures, 3, "skeletons have no rules: the fallback goblin stands in");
    assert.equal(inst.remaining().boss, 2);
    const token = inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" });
    const c = new HeadlessClient();
    closers.push(() => c.close());
    await c.connect(`ws://127.0.0.1:${port}`);
    const welcome = await c.hello("t", { token });
    assert.equal(welcome.character?.name, "Alice");
    await until(() => ctl(c).some((m) => m.kind === "dungeon" && m.op === "state"));
    const state = ctl(c).find((m) => m.op === "state")!;
    assert.equal(state.dungeon, "The Test Barrow");
    assert.equal(state.bossLeft, 2);
    // The character's avatar in the instance, and its kills (credited to the killer).
    const avatar = inst.world.resolveWireId(BigInt(welcome.player_entity));
    assert.ok(Math.abs(C.Transform.px[avatar] - 7) < 3 && avatar >= 0 || assert.fail(`at ${avatar} ${C.Transform.px[avatar]},${C.Transform.pz[avatar]}`)); assert.ok(Math.abs(C.Transform.px[avatar] - 7) < 3 && Math.abs(C.Transform.pz[avatar] - 11) < 3, "at the entrance");
    const boss = [...inst.creatures.entities()].filter((e) => C.Transform.px[e] > 30);
    const onDeath = (inst as unknown as { onDeath(s: SimWorld, ev: object): void }).onDeath.bind(inst);
    for (const e of boss) {
      C.Health.current[e] = 0;
      onDeath(inst.world, { tick: 1, target: e, state: "dead", killer: avatar });
    }
    now += 1000;
    await until(() => results.length === 1);
    const r = results[0];
    assert.equal(r.outcome, "cleared");
    assert.deepEqual(r.members, [rec.id]);
    assert.deepEqual(r.kills, [{ characterId: rec.id, kind: "goblin", count: 2 }]);
    assert.ok(r.loot.length >= 4 && r.loot.every((l) => l.characterId === rec.id && [7, 8, 9].includes(l.def)), "2-3 boss rolls each");
    await until(() => ctl(c).some((m) => m.op === "ended"));
    assert.equal(ctl(c).find((m) => m.op === "ended")!.outcome, "cleared");
    await sleep(100);
    assert.equal(results.length, 1, "reported once");
  });

  it("serves its baked shell as an ordinary asset: an AssetRef entity and the Pcg service on its own port", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const shell = encodePcgMesh({ positions: new Float32Array([0, 0, 0, 8, 0, 0, 8, 0, 8]), indices: new Uint32Array([0, 1, 2]) });
    const dir = mkdtempSync(join(tmpdir(), "shell-"));
    dirs.push(dir);
    writeFileSync(join(dir, "grim-abc.shell.pcgm"), shell);
    // The SoA stores are process-wide and a recycled slot keeps its dead entity's data: poison them,
    // so a shell entity that left any field unwritten (the position, the variant) shows up below.
    for (const a of [C.Transform.px, C.Transform.py, C.Transform.pz, C.Transform.qx, C.Transform.sx, C.AssetRef.variant]) a.fill(77);
    closers.push(async () => {
      for (const a of [C.Transform.px, C.Transform.py, C.Transform.pz, C.Transform.qx, C.Transform.sx, C.AssetRef.variant]) a.fill(0);
    });
    const inst = new DungeonInstance({
      id: "run-shell", entrance: "barrow-gate", layout: { ...readLayout(fixture()), shell: join(dir, "grim-abc.shell.pcgm") }, rules: content.rules, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
    });
    const port = await inst.start();
    closers.push(() => inst.close());
    const hash = fnv1a32("dungeon:grim-abc");
    const holders = [...queryEntities(inst.world, C.AssetRef)].filter((e) => C.AssetRef.assetHash[e] === hash);
    assert.equal(holders.length, 1, "one static entity carries the shell's asset hash");
    const [shellEid] = holders;
    assert.deepEqual([C.Transform.px[shellEid], C.Transform.py[shellEid], C.Transform.pz[shellEid]], [0, 0, 0], "at the origin, where the shell's own coordinates start");
    assert.equal(C.Transform.qx[shellEid], 0);
    assert.equal(C.Transform.sx[shellEid], 1);
    assert.equal(C.AssetRef.variant[shellEid], 0);
    // A client in the run asks the instance's own Pcg service, with its session token, and gets the baked bytes.
    const c = new HeadlessClient();
    closers.push(() => c.close());
    await c.connect(`ws://127.0.0.1:${port}`);
    const welcome = await c.hello("t", { token: inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" }) });
    const base = `http://127.0.0.1:${port}`;
    const ask = await fetch(`${base}/rpc/Pcg/GetAssetMesh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${welcome.session_token}` },
      body: JSON.stringify({ assetHash: hash, variant: 0 }),
    });
    assert.equal(ask.status, 200);
    const { mesh } = (await ask.json()) as { mesh: { url: string; triangleCount: number; lods: unknown[] } };
    assert.equal(mesh.triangleCount, 1);
    assert.deepEqual(mesh.lods, []);
    const bytes = new Uint8Array(await (await fetch(`${base}${mesh.url}`, { headers: { Authorization: `Bearer ${welcome.session_token}` } })).arrayBuffer());
    assert.deepEqual(bytes, shell, "the client downloads exactly what was baked");
  });

  it("stands the baked props in the run as scatter entities, from props.json, and leaves them where the bake put them", async () => {
    SimWorld.resetEntityCursorForTesting();
    // Grid cells are continuous: (x, y) stands at x * 2 m. The banner and torch are on the rock east of the last room.
    const baked = {
      ...fixture(),
      props: [
        { kind: "pillar", x: 3, y: 5, rot: 0, scale: 1, room: 0 },
        { kind: "banner", x: 23.5, y: 5, dx: -1, dy: 0, rot: 0, scale: 1 },
        { kind: "crack", x: 4, y: 4, dx: 1, dy: 0, rot: 0, scale: 1 },
      ],
      dressing: { rank: 1, props: [{ kind: "barrel", x: 5, y: 3, rot: 0.5, room: 0, radius: 0.25 }] },
      torches: [{ x: 23.5, y: 6, dx: -1, dy: 0 }],
      // A solid prop has its own baked collider: the wall system must not push the pillar out of it.
      colliders: [{ x: 3, y: 5, r: 0.25 }],
    };
    const layout = readLayout(baked);
    assert.deepEqual(layout.props.map((p) => [p.kind, p.x, p.z]), [["pillar", 6, 10], ["banner", 47, 10], ["crack", 8, 8], ["barrel", 10, 6], ["torch", 47, 12]], "cells to metres, in file order: props, dressing, torches");
    assert.equal(layout.props[3].radius, 0.5, "the bake's footprint, in metres");
    assert.ok(Math.abs(layout.props[1].yaw - -Math.PI / 2) < 1e-9, "a mounted kind faces out of its wall");
    const inst = new DungeonInstance({
      id: "run-props", entrance: "barrow-gate", layout, rules: content.rules, props: content.props, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: new MemoryCharacterStore(),
      onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
    });
    await inst.start();
    closers.push(() => inst.close());
    await sleep(300); // a few ticks: the wall system must not have touched a prop in the rock
    const of = (kind: string): number => {
      const hits = [...queryEntities(inst.world, C.AssetRef)].filter((e) => C.AssetRef.assetHash[e] === fnv1a32(`dungeon:${kind}`));
      assert.equal(hits.length, 1, `one ${kind}`);
      return hits[0];
    };
    const pillar = of("pillar");
    assert.deepEqual([C.Transform.px[pillar], C.Transform.py[pillar], C.Transform.pz[pillar]], [6, 0, 10], "a standing prop rests on the floor");
    assert.equal(C.BodyConfig.motionType[pillar], C.MotionType.Static);
    assert.ok(Math.abs(C.BodyConfig.halfY[pillar] - 5.2) < 1e-6, "halfY is its full height (the world's convention)");
    const banner = of("banner");
    const at = (e: number): number[] => [C.Transform.px[e], C.Transform.py[e], C.Transform.pz[e]];
    const near = (got: number[], want: number[], why: string): void => assert.ok(got.every((v, i) => Math.abs(v - want[i]) < 1e-5), `${why}: ${got} vs ${want}`); // float32 stores
    near(at(banner), [47, 2.6, 10], "mounted: at its lift, still in the rock");
    const torch = of("torch");
    near(at(torch), [47, 2.2, 12], "the torch, at its lift");
    assert.ok(Math.abs(C.Transform.qy[torch] - Math.sin(-Math.PI / 4)) < 1e-6, "turned to face out of the wall");
    const barrel = of("barrel");
    assert.ok(Math.abs(C.BodyConfig.halfX[barrel] - 0.5) < 1e-6, "its own footprint sizes the box");
    assert.ok(Math.abs(C.BodyConfig.halfY[barrel] - 1) < 1e-6, "the table's height");
    assert.deepEqual([...inst.unspawnedProps], [["crack", 1]], "a kind with no entry is counted, not spawned");
  });

  it("serves each prop kind's procedural mesh from the run's Pcg library, once per kind, beside the shell", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const dir = mkdtempSync(join(tmpdir(), "shell-props-"));
    dirs.push(dir);
    writeFileSync(join(dir, "grim-abc.shell.pcgm"), encodePcgMesh({ positions: new Float32Array([0, 0, 0, 8, 0, 0, 8, 0, 8]), indices: new Uint32Array([0, 1, 2]) }));
    const baked = {
      ...fixture(),
      props: [
        { kind: "pillar", x: 3, y: 5, rot: 0, scale: 1, room: 0 },
        { kind: "pillar", x: 5, y: 5, rot: 0, scale: 1, room: 0 },
        { kind: "crack", x: 4, y: 4, dx: 1, dy: 0, rot: 0, scale: 1 },
      ],
      dressing: { rank: 1, props: [{ kind: "barrel", x: 5, y: 3, rot: 0.5, room: 0, radius: 0.25 }, { kind: "sarcophagus", x: 6, y: 3, rot: 0, room: 0, radius: 0.6 }] },
      torches: [{ x: 23.5, y: 6, dx: -1, dy: 0 }],
    };
    const inst = new DungeonInstance({
      id: "run-meshes", entrance: "barrow-gate", layout: { ...readLayout(baked), shell: join(dir, "grim-abc.shell.pcgm") }, rules: content.rules, props: content.props, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
    });
    const port = await inst.start();
    closers.push(() => inst.close());
    const c = new HeadlessClient();
    closers.push(() => c.close());
    await c.connect(`ws://127.0.0.1:${port}`);
    const welcome = await c.hello("t", { token: inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" }) });
    const base = `http://127.0.0.1:${port}`;
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${welcome.session_token}` };
    const { assets } = (await (await fetch(`${base}/rpc/Pcg/ListAssets`, { method: "POST", headers: auth, body: "{}" })).json()) as { assets: { id: string; assetHash: number }[] };
    assert.deepEqual(assets.map((a) => a.id).sort(), ["dungeon:barrel", "dungeon:grim-abc", "dungeon:pillar", "dungeon:sarcophagus", "dungeon:torch"], "the shell and one mesh per kind in the run; none for a kind with no table entry");
    const barrel = assets.find((a) => a.id === "dungeon:barrel")!;
    assert.equal(barrel.assetHash, fnv1a32("dungeon:barrel"), "listed under the hash its entities carry");
    const ask = await fetch(`${base}/rpc/Pcg/GetAssetMesh`, { method: "POST", headers: auth, body: JSON.stringify({ assetHash: barrel.assetHash, variant: 0 }) });
    const { mesh } = (await ask.json()) as { mesh: { triangleCount: number } };
    assert.ok(mesh.triangleCount >= 12, `${mesh.triangleCount} triangles`);
  });

  it("serves the props' meshes even when the dungeon was baked without a shell, and nothing when it has no props", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const list = async (baked: Record<string, unknown>, props: typeof content.props | undefined): Promise<string[]> => {
      const inst = new DungeonInstance({
        id: "run-noshell", entrance: "barrow-gate", layout: readLayout(baked), rules: content.rules, ...(props ? { props } : {}), game,
        members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
        onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
      });
      const port = await inst.start();
      closers.push(() => inst.close());
      const c = new HeadlessClient();
      closers.push(() => c.close());
      await c.connect(`ws://127.0.0.1:${port}`);
      const welcome = await c.hello("t", { token: inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" }) });
      const res = await fetch(`http://127.0.0.1:${port}/rpc/Pcg/ListAssets`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${welcome.session_token}` }, body: "{}" });
      return res.status === 200 ? ((await res.json()) as { assets: { id: string }[] }).assets.map((a) => a.id) : [];
    };
    assert.deepEqual(await list({ ...fixture(), props: [{ kind: "pillar", x: 3, y: 5, rot: 0, scale: 1, room: 0 }] }, content.props), ["dungeon:pillar"]);
    assert.deepEqual(await list(fixture(), content.props), [], "no props, no shell: no Pcg service to serve");
    assert.deepEqual(await list({ ...fixture(), props: [{ kind: "pillar", x: 3, y: 5, rot: 0, scale: 1, room: 0 }] }, undefined), [], "no table: nothing spawns, nothing to serve");
  });

  it("spawns no props without a table, and a bad props.json refuses the content", () => {
    assert.equal(parseDungeonContent(content.rules, { version: 1, entrances: {} }).props.archetypes["dungeon:pillar"], undefined);
    assert.ok(content.props.archetypes["dungeon:pillar"] && content.props.lift["banner"] === 2.6, "the shipped table loads");
    assert.throws(() => parseDungeonContent(content.rules, { version: 1, entrances: {} }, { version: 1, archetypes: { "dungeon:pillar": { asset: "" } } }), /props\.json/);
  });

  it("sends the run's look when a member enters (the layout's theme), and nothing without looks.json", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const run = async (looks: typeof content.looks): Promise<Ctl[]> => {
      const inst = new DungeonInstance({
        id: "run-look", entrance: "barrow-gate", layout: readLayout(fixture("grim-look", "grim")), rules: content.rules, game,
        ...(looks ? { looks } : {}),
        members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
        onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
      });
      const port = await inst.start();
      closers.push(() => inst.close());
      const c = new HeadlessClient();
      closers.push(() => c.close());
      await c.connect(`ws://127.0.0.1:${port}`);
      await c.hello("t", { token: inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" }) });
      await until(() => ctl(c).some((m) => m.kind === "dungeon" && m.op === "state"));
      return ctl(c);
    };
    const withLooks = await run(content.looks);
    const look = withLooks.find((m) => m.op === "look")?.look as { theme: string; palette: Record<string, string>; emitters: string[]; maxLights: number; label?: unknown } | undefined;
    assert.ok(look, "a look arrived");
    assert.equal(look.theme, "grim");
    assert.deepEqual(Object.keys(look.palette).sort(), ["basin", "ceiling", "floor", "wall", ...PROP_SLOTS].sort(), "the shell's slots and the props'");
    assert.ok(look.emitters.includes("dungeon:torch") && look.maxLights > 0);
    assert.equal(look.label, undefined, "the label is for the editor, not the client");
    assert.ok(withLooks.findIndex((m) => m.op === "look") < withLooks.findIndex((m) => m.op === "state"), "the look comes before the first state");
    assert.equal((await run(null)).some((m) => m.op === "look"), false, "no looks.json: the client keeps the open world's look");
  });

  it("loads and validates looks.json: every theme a palette of colours, a bad colour refuses the content", () => {
    assert.ok(content.looks && Object.keys(content.looks.themes).length >= 5, "the shipped looks load");
    for (const [theme, l] of Object.entries(content.looks!.themes)) assert.ok(l.torch.range > 0 && /^#[0-9a-f]{6}$/i.test(l.palette.floor ?? ""), `${theme}: a floor colour`);
    const bad = { version: 1, emitters: [], maxLights: 4, themes: { grim: { ...content.looks!.themes.grim, background: "black" } } };
    assert.throws(() => parseDungeonContent(content.rules, { version: 1, entrances: {} }, undefined, bad), /looks\.json/);
  });

  it("gives every theme's palette a colour for every prop material slot", () => {
    for (const [theme, l] of Object.entries(content.looks!.themes)) {
      for (const slot of PROP_SLOTS) assert.match(l.palette[slot] ?? "", /^#[0-9a-f]{6}$/i, `${theme}: a ${slot} colour`);
    }
  });

  describe("the local art overlay (props.local.json)", () => {
    const rawProps = JSON.parse(readFileSync(join(DEFAULT_DUNGEON_CONTENT, "props.json"), "utf8")) as unknown;
    const entrances = { version: 1, entrances: {} };

    it("remaps the kinds it names to catalog models, and changes nothing else; no overlay changes nothing at all", () => {
      const plain = parseDungeonContent(content.rules, entrances, rawProps);
      assert.deepEqual(plain.artAssets, {});
      const art = parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 1, assets: { coffin: "SomeCoffinModel" } });
      assert.equal(art.props.archetypes["dungeon:coffin"].asset, "SomeCoffinModel");
      assert.deepEqual(art.props.archetypes["dungeon:coffin"].collision, plain.props.archetypes["dungeon:coffin"].collision, "its collision box is unchanged");
      assert.deepEqual({ ...art.props.archetypes, "dungeon:coffin": plain.props.archetypes["dungeon:coffin"] }, plain.props.archetypes, "the other kinds are untouched");
      assert.deepEqual(art.artAssets, { coffin: "SomeCoffinModel" });
      assert.deepEqual(art.artScales, {}, "no sizes unless the overlay gives them");
      const sized = parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 1, assets: { coffin: "SomeCoffinModel" }, scales: { coffin: 2 } });
      assert.deepEqual(sized.artScales, { coffin: 2 });
    });

    it("refuses a size for a kind with no model, or an absurd one", () => {
      assert.throws(() => parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 1, assets: {}, scales: { coffin: 2 } }), /props\.local\.json.*scales\.coffin/);
      assert.throws(() => parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 1, assets: { coffin: "X" }, scales: { coffin: 0 } }), /props\.local\.json/);
    });

    it("fails loud, naming the file, for a kind the table lacks or a wrong shape", () => {
      assert.throws(() => parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 1, assets: { nope: "X" } }), /props\.local\.json.*nope/);
      assert.throws(() => parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 2, assets: {} }), /props\.local\.json/);
      assert.throws(() => parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 1, assets: { coffin: "" } }), /props\.local\.json/);
    });

    it("loadDungeonContent reads it from the content folder when it is there", () => {
      const dir = mkdtempSync(join(tmpdir(), "art-overlay-"));
      dirs.push(dir);
      for (const f of ["instances.json", "entrances.json", "props.json", "looks.json"]) writeFileSync(join(dir, f), readFileSync(join(DEFAULT_DUNGEON_CONTENT, f)));
      assert.deepEqual(loadDungeonContent(dir).artAssets, {});
      writeFileSync(join(dir, "props.local.json"), JSON.stringify({ version: 1, assets: { barrel: "SomeBarrelModel" } }));
      assert.equal(loadDungeonContent(dir).props.archetypes["dungeon:barrel"].asset, "SomeBarrelModel");
    });

    it("stands a remapped kind in the run under the model's hash, and keeps the run's torch lights lit", async () => {
      SimWorld.resetEntityCursorForTesting();
      const characters = new MemoryCharacterStore();
      const rec = await characters.create("alice", "Alice", "{}", 8);
      const art = parseDungeonContent(content.rules, entrances, rawProps, undefined, { version: 1, assets: { pillar: "SomePillarModel", torch: "SomeTorchModel" }, scales: { pillar: 2 } });
      const baked = { ...fixture("grim-art", "grim"), props: [{ kind: "pillar", x: 3, y: 5, rot: 0, scale: 1, room: 0 }], torches: [{ x: 23.5, y: 6, dx: -1, dy: 0 }] };
      const inst = new DungeonInstance({
        id: "run-art", entrance: "barrow-gate", layout: readLayout(baked), rules: content.rules, props: art.props, looks: content.looks!, artAssets: art.artAssets, artScales: art.artScales, game,
        members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
        onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
      });
      const port = await inst.start();
      closers.push(() => inst.close());
      const hashes = [...queryEntities(inst.world, C.AssetRef)].map((e) => C.AssetRef.assetHash[e]);
      assert.ok(hashes.includes(fnv1a32("SomePillarModel")) && !hashes.includes(fnv1a32("dungeon:pillar")), "the pillar carries the model's hash");
      const pillar = [...queryEntities(inst.world, C.AssetRef)].find((e) => C.AssetRef.assetHash[e] === fnv1a32("SomePillarModel"))!;
      assert.equal(C.Transform.sx[pillar], 2, "drawn at the overlay's size factor");
      const c = new HeadlessClient();
      closers.push(() => c.close());
      await c.connect(`ws://127.0.0.1:${port}`);
      await c.hello("t", { token: inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" }) });
      await until(() => ctl(c).some((m) => m.kind === "dungeon" && m.op === "look"));
      const look = ctl(c).find((m) => m.op === "look")!.look as { emitters: string[] };
      assert.ok(look.emitters.includes("dungeon:torch") && look.emitters.includes("SomeTorchModel"), "both ids give light");
      assert.equal(new Set(look.emitters).size, look.emitters.length, "no duplicates");
    });
  });

  it("runs as before when the dungeon was baked without a shell", async () => {
    SimWorld.resetEntityCursorForTesting();
    const inst = new DungeonInstance({
      id: "run-bare", entrance: "barrow-gate", layout: readLayout(fixture()), rules: content.rules, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: new MemoryCharacterStore(),
      onEnd: () => {}, now: () => 1_000_000, clock: () => Date.now(), transport: "ws",
    });
    await inst.start();
    closers.push(() => inst.close());
    assert.equal([...queryEntities(inst.world, C.AssetRef)].length, 0, "no shell entity");
  });

  it("places chests per run and opens the nearest one into the result loot", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const results: InstanceResult[] = [];
    const now = 2_000_000;
    const inst = new DungeonInstance({
      id: "run-chest", entrance: "barrow-gate", layout: readLayout(fixture()), rules: content.rules, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      lootPool: [7, 8, 9], chestPool: [11, 12], onEnd: (r) => results.push(r), now: () => now, clock: () => Date.now(), transport: "ws",
    });
    const port = await inst.start();
    closers.push(() => inst.close());
    // One chest per non-entrance room (the fixture's room 1), closed.
    assert.deepEqual(inst.chests.map((c) => [c.id, c.opened]), [["chest-0", false]]);
    const token = inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" });
    const c = new HeadlessClient();
    closers.push(() => c.close());
    await c.connect(`ws://127.0.0.1:${port}`);
    const w = await c.hello("t", { token });
    const avatar = inst.world.resolveWireId(BigInt(w.player_entity));
    // Stand on the chest and open it: its rolls join the result loot.
    C.Transform.px[avatar] = inst.chests[0].x;
    C.Transform.pz[avatar] = inst.chests[0].z;
    c.sendRaw(MessageType.Chat, encodeControl({ kind: "dungeon", op: "open" }));
    await until(() => inst.chests[0].opened);
    // Opening again finds it empty: still one opened chest, no run yet.
    c.sendRaw(MessageType.Chat, encodeControl({ kind: "dungeon", op: "open" }));
    await sleep(100);
    assert.equal(inst.chests.filter((ch) => ch.opened).length, 1);
    assert.equal(results.length, 0);
    inst.end("abandoned");
    assert.equal(results.length, 1);
    const loot = results[0].loot.filter((l) => l.characterId === rec.id).map((l) => l.def);
    assert.ok(loot.length >= 1 && loot.length <= 2, `1-2 chest rolls, got ${loot.length}`);
    assert.ok(loot.every((d) => [11, 12].includes(d)), "chest rolls come from the chest pool");
  });

  it("the run state names each chest and whether it is opened", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const results: InstanceResult[] = [];
    const inst = new DungeonInstance({
      id: "run-chest-state", entrance: "barrow-gate", layout: readLayout(fixture()), rules: content.rules, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      lootPool: [], chestPool: [11], onEnd: (r) => results.push(r), now: () => 2_000_000, clock: () => Date.now(), transport: "ws",
    });
    const port = await inst.start();
    closers.push(() => inst.close());
    const token = inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" });
    const c = new HeadlessClient();
    closers.push(() => c.close());
    await c.connect(`ws://127.0.0.1:${port}`);
    const w = await c.hello("t", { token });
    await until(() => ctl(c).some((m) => m.op === "state"));
    assert.deepEqual(
      ctl(c).find((m) => m.op === "state")!.chests,
      [{ id: "chest-0", opened: false, x: inst.chests[0].x, z: inst.chests[0].z }],
    );
    const avatar = inst.world.resolveWireId(BigInt(w.player_entity));
    C.Transform.px[avatar] = inst.chests[0].x;
    C.Transform.pz[avatar] = inst.chests[0].z;
    c.sendRaw(MessageType.Chat, encodeControl({ kind: "dungeon", op: "open" }));
    await until(() => ctl(c).filter((m) => m.op === "state").length >= 2);
    assert.deepEqual(
      ctl(c).filter((m) => m.op === "state").at(-1)!.chests,
      [{ id: "chest-0", opened: true, x: inst.chests[0].x, z: inst.chests[0].z }],
    );
  });

  it("springs a trap under a member for the rules harm, once", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const results: InstanceResult[] = [];
    const inst = new DungeonInstance({
      id: "run-trap", entrance: "barrow-gate", layout: readLayout(fixture()), rules: content.rules, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      lootPool: [], onEnd: (r) => results.push(r), now: () => 2_000_000, clock: () => Date.now(), transport: "ws",
    });
    const port = await inst.start();
    closers.push(() => inst.close());
    // Traps in the lowest-id non-entrance rooms, unsprung.
    assert.deepEqual(inst.traps.map((t) => [t.id, t.sprung]), [["trap-0", false]]);
    const token = inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" });
    const c = new HeadlessClient();
    closers.push(() => c.close());
    await c.connect(`ws://127.0.0.1:${port}`);
    const w = await c.hello("t", { token });
    const avatar = inst.world.resolveWireId(BigInt(w.player_entity));
    C.Transform.px[avatar] = inst.traps[0].x;
    C.Transform.pz[avatar] = inst.traps[0].z;
    const before = C.Health.current[avatar];
    await until(() => inst.traps[0].sprung);
    assert.equal(before - C.Health.current[avatar], content.rules.trapHarm);
    // A spent trap never fires again.
    await sleep(200);
    assert.equal(before - C.Health.current[avatar], content.rules.trapHarm);
  });

  it("the run state names each trap and whether it is sprung", async () => {
    SimWorld.resetEntityCursorForTesting();
    const characters = new MemoryCharacterStore();
    const rec = await characters.create("alice", "Alice", "{}", 8);
    const inst = new DungeonInstance({
      id: "run-trap-state", entrance: "barrow-gate", layout: readLayout(fixture()), rules: content.rules, game,
      members: [], credentialStore: await makeCredentialStore(), characterStore: characters,
      lootPool: [], onEnd: () => {}, now: () => 2_000_000, clock: () => Date.now(), transport: "ws",
    });
    const port = await inst.start();
    closers.push(() => inst.close());
    const token = inst.admit({ characterId: rec.id, username: "alice", name: "Alice", look: "{}" });
    const c = new HeadlessClient();
    closers.push(() => c.close());
    await c.connect(`ws://127.0.0.1:${port}`);
    const w = await c.hello("t", { token });
    await until(() => ctl(c).some((m) => m.op === "state"));
    assert.deepEqual(
      ctl(c).find((m) => m.op === "state")!.traps,
      [{ id: "trap-0", sprung: false }],
    );
    const avatar = inst.world.resolveWireId(BigInt(w.player_entity));
    C.Transform.px[avatar] = inst.traps[0].x;
    C.Transform.pz[avatar] = inst.traps[0].z;
    await until(() => ctl(c).filter((m) => m.op === "state").length >= 2);
    assert.deepEqual(
      ctl(c).filter((m) => m.op === "state").at(-1)!.traps,
      [{ id: "trap-0", sprung: true }],
    );
  });

  it("times out, and an empty run is abandoned", async () => {
    for (const [advance, want] of [[46 * 60_000, "timeout"], [121_000, "abandoned"]] as const) {
      SimWorld.resetEntityCursorForTesting();
      const results: InstanceResult[] = [];
      let now = 5_000_000;
      const inst = new DungeonInstance({
        id: `run-${want}`, entrance: "barrow-gate", layout: readLayout(fixture()), rules: content.rules, game,
        members: [], credentialStore: await makeCredentialStore(), characterStore: new MemoryCharacterStore(),
        onEnd: (r) => results.push(r), now: () => now, clock: () => Date.now(), transport: "ws",
      });
      await inst.start();
      closers.push(() => inst.close());
      now += advance;
      await until(() => results.length === 1);
      assert.equal(results[0].outcome, want);
    }
  });
});

describe("instance manager", () => {
  async function region(
    dungeons: DungeonContent,
    partySizes?: [number, number],
    extra?: {
      weaponOf?: (characterId: number) => Weapon | null;
      train?: (characterId: number, skill: string, difficulty: number, key: number) => void;
    },
  ) {
    SimWorld.resetEntityCursorForTesting();
    const dir = poolDir([fixture()]);
    dirs.push(dir);
    const characters = new MemoryCharacterStore();
    const credentialStore = await makeCredentialStore();
    const results = new MemoryInstanceResultStore();
    const granted: Array<[number, number]> = [];
    let gw!: Gateway;
    const rules = partySizes ? { ...dungeons.rules, partySize: partySizes } : dungeons.rules;
    const mgr = new InstanceManager({
      content: { ...dungeons, rules }, pool: new DungeonPool(dir), game: () => game,
      credentialStore, characterStore: characters, partyOf: (n) => gw.partyOf(n),
      lootPool: () => [42], grant: (c, d) => (granted.push([c, d]), true),
      endpoint: (p) => `ws://127.0.0.1:${p}`, results, transport: "ws",
      ...(extra?.weaponOf ? { weaponOf: extra.weaponOf } : {}),
      ...(extra?.train ? { train: extra.train } : {}),
    });
    const gate = content.entrances["barrow-gate"];
    gw = new Gateway({ credentialStore, characterStore: characters, extensions: [mgr], spawnPoint: { x: gate.x + 14, z: gate.z + 14 } /* the first avatar stands 14 m off it, on the gate */, transport: "ws" });
    const port = await gw.listen();
    gw.startTicking();
    closers.push(() => gw.close());
    closers.push(async () => {
      mgr.endAll();
      await Promise.all(mgr.instances().map((i) => i.close()));
    });
    const join = async (user: string, name: string) => {
      const rec = await characters.create(user, name, "{}", 8);
      const c = new HeadlessClient();
      closers.push(() => c.close());
      await c.connect(`ws://127.0.0.1:${port}`);
      const account = c.waitFor(MessageType.Account, 1);
      c.sendRaw(MessageType.Hello, encodeControl({ protocol: PROTOCOL_VERSION, client: "t", want_snapshot: true, characters: true, username: user, password: TEST_PASSWORD }));
      await account;
      const snap = c.waitFor(MessageType.Snapshot, 1);
      c.sendRaw(MessageType.EnterWorld, encodeControl({ character: rec.id }));
      await snap;
      return c;
    };
    return { mgr, gw, results, granted, join };
  }

  const ask = (c: HeadlessClient, entrance = "barrow-gate"): void => c.sendRaw(MessageType.Chat, encodeControl({ kind: "dungeon", op: "enter", entrance }));

  it("starts a run at the entrance, transfers the member, lets them back in, and commits loot on report", async () => {
    const r = await region(content);
    const a = await r.join("alice", "Alice");
    // Entering the world tells the client where the entrances are.
    await until(() => ctl(a).some((m) => m.op === "entrances"));
    const listed = ctl(a).find((m) => m.op === "entrances")!.entrances as { id: string; x: number; radius: number }[];
    assert.deepEqual(listed.map((e) => e.id), ["barrow-gate"]);
    assert.equal(listed[0].x, content.entrances["barrow-gate"].x);
    ask(a, "nowhere");
    await until(() => ctl(a).some((m) => m.text === "there is no dungeon entrance here"));
    ask(a);
    await until(() => ctl(a).some((m) => m.op === "transfer"));
    const t = ctl(a).find((m) => m.op === "transfer")!;
    assert.equal(t.dungeon, "The Test Barrow");
    assert.equal(r.mgr.count, 1);
    // Into the instance with the token.
    const inside = new HeadlessClient();
    closers.push(() => inside.close());
    await inside.connect(t.endpoint as string);
    const w = await inside.hello("t", { token: t.token as string });
    assert.equal(w.character?.name, "Alice");
    // Asking again while the run lasts lets the member back in, to the same run.
    ask(a);
    await until(() => ctl(a).filter((m) => m.op === "transfer").length === 2);
    assert.equal(ctl(a).filter((m) => m.op === "transfer")[1].instance, t.instance);
    assert.equal(r.mgr.count, 1);
    // Nothing is granted until the run reports.
    const inst = r.mgr.instances()[0];
    const avatar = inst.world.resolveWireId(BigInt(w.player_entity));
    const onDeath = (inst as unknown as { onDeath(s: SimWorld, ev: object): void }).onDeath.bind(inst);
    const first = [...inst.creatures.entities()].find((e) => C.Transform.px[e] < 30)!;
    C.Health.current[first] = 0;
    onDeath(inst.world, { tick: 1, target: first, state: "dead", killer: avatar });
    await sleep(100);
    assert.equal(r.granted.length, 0);
    inst.end("abandoned");
    assert.equal(r.results.unreported().length, 1);
    assert.equal(r.results.unreported()[0].kills[0].count, 1);
    assert.ok(r.granted.every(([, d]) => d === 42));
    assert.equal(r.mgr.count, 0);
  });

  it("commit trains the killer's weapon skill, one use per kill", async () => {
    const trained: Array<[number, string, number, number]> = [];
    const r = await region(content, undefined, {
      weaponOf: () => ({ technique: "cut", item: { mass: 1, edge: 1, point: 0, hardness: 1 }, reach: 1 }),
      train: (c, s, d, k) => void trained.push([c, s, d, k]),
    });
    const a = await r.join("alice", "Alice");
    await until(() => ctl(a).some((m) => m.op === "entrances"));
    ask(a);
    await until(() => ctl(a).some((m) => m.op === "transfer"));
    const t = ctl(a).find((m) => m.op === "transfer")!;
    const inside = new HeadlessClient();
    closers.push(() => inside.close());
    await inside.connect(t.endpoint as string);
    const w = await inside.hello("t", { token: t.token as string });
    const inst = r.mgr.instances()[0];
    const avatar = inst.world.resolveWireId(BigInt(w.player_entity));
    const onDeath = (inst as unknown as { onDeath(s: SimWorld, ev: object): void }).onDeath.bind(inst);
    for (const e of [...inst.creatures.entities()]) {
      C.Health.current[e] = 0;
      onDeath(inst.world, { tick: 1, target: e, state: "dead", killer: avatar });
    }
    inst.end("cleared");
    assert.equal(trained.length, 3);
    for (const [c, s, d, k] of trained) {
      assert.equal(c, trained[0][0]);
      assert.equal(s, "cutting");
      assert.equal(d, 0.5);
      assert.equal(k, trained[0][3]);
    }
  });

  it("refuses a party outside its size", async () => {
    const r = await region(content, [2, 5]);
    const a = await r.join("alice", "Alice");
    ask(a);
    await until(() => ctl(a).some((m) => m.text === "a party of at least 2 is needed here"));
    assert.equal(r.mgr.count, 0);
  });

  it("the SQLite store keeps results until reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "inst-"));
    dirs.push(dir);
    const store = new SqliteInstanceResultStore(join(dir, "instances.db"));
    const res: InstanceResult = { instance: "run-x", dungeon: "d", entrance: "e", outcome: "cleared", startedAt: 1, endedAt: 2, members: [1], kills: [], deaths: [], loot: [{ characterId: 1, def: 3 }] };
    store.record(res, 1, 0);
    assert.deepEqual(store.unreported(), [res]);
    store.markReported(["run-x"]);
    assert.deepEqual(store.unreported(), []);
    store.close();
  });
});
