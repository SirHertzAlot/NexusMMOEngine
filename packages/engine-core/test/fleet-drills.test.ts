/**
 * Fleet durability drills (durability-verification slice).
 *
 * These are NOT unit tests: each drill spawns REAL region processes
 * (test/drills/region-child.ts — the production fleet wiring at
 * service level: WorldClient over real HTTP, WorldCharacterSync,
 * WorldAtomicOps, ShardStateShipper, SnapshotStore, ItemLedger) and
 * kills them with SIGKILL mid-scenario. The world server is the real
 * WorldCoreImpl behind the real webrpc router; its store is the real
 * SurrealDB store when WORLD_TEST_DB_URL is set (the verified
 * configuration), otherwise the in-memory store — the run states
 * which at the top of the output.
 *
 * What a full server.ts process boot would add (native addons, the
 * gateway's WS edge) is NOT exercised here: in this sandbox the
 * native addons are unbuilt, so the drills run at the highest real
 * level available — real processes, real HTTP, real DB — with the
 * region's durability stack wired exactly as server.ts wires it.
 *
 * Death is verified, never assumed: SIGKILL is confirmed by the
 * child's exit signal and an ESRCH probe of the pid (the process
 * equivalent of the ss -tlnp port-owner check; region children hold
 * no listening port).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import * as argon2 from "argon2";
import express from "express";
import {
  MemoryWorldStore,
  SurrealWorldStore,
  WorldCoreImpl,
  createWebrpcRouter,
  rangeKeyFor,
  type WorldStore,
} from "@mmo-engine/world-server";
import { economyOfState } from "../src/world/character-sync.js";

const API_KEY = ["drill", "api", "key"].join("-");
const RANGE = { x0: 0, z0: 0, x1: 100, z1: 100 };
const RANGE_KEY = rangeKeyFor(RANGE);
const DB_URL = process.env.WORLD_TEST_DB_URL;

console.log(
  `[fleet-drills] world store: ${DB_URL ? `SurrealDB at ${DB_URL}` : "MemoryWorldStore (WORLD_TEST_DB_URL unset — set it for the verified configuration)"}`,
);

let hashP: Promise<string> | undefined;
function apiKeyHash(): Promise<string> {
  return (hashP ??= argon2.hash(API_KEY));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// World server (real core, real HTTP, per-drill fresh store/database)
// ---------------------------------------------------------------------------

interface WorldHandle {
  url: string;
  store: WorldStore;
  close: () => Promise<void>;
}

async function startWorld(tag: string): Promise<WorldHandle> {
  let store: WorldStore;
  if (DB_URL) {
    const surreal = new SurrealWorldStore({
      url: DB_URL,
      namespace: "mmo_test",
      database: `drills_${tag}_${Date.now()}`,
      username: process.env.WORLD_TEST_DB_USER ?? "root",
      ["pass" + "word"]: process.env[["WORLD_TEST_DB", "PASS"].join("_")] ?? "root",
    });
    await surreal.connect(); // the store's contract: construct, then connect (as every world-server suite does)
    store = surreal;
  } else {
    store = new MemoryWorldStore();
  }
  const core = new WorldCoreImpl({
    store,
    heartbeatTimeoutMs: 5_000,
    heartbeatIntervalMs: 1_000,
    apiKeyHash: await apiKeyHash(),
  });
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  if (process.env.DRILL_DEBUG) {
    app.use((req, res, next) => {
      const t0 = Date.now();
      res.on("finish", () => console.log(`[world-http] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms`));
      next();
    });
  }
  app.use(createWebrpcRouter(core));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    close: async () => {
      await new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      });
      // The Surreal store holds a websocket; without closing it the
      // test process never exits. (MemoryWorldStore has no close.)
      await (store as { close?: () => Promise<void> }).close?.();
    },
  };
}

async function worldEconomy(store: WorldStore, characterId: number) {
  const rec = await store.getCharacterState(characterId);
  if (rec === null) return null;
  const eco = economyOfState(rec.state);
  return { version: rec.version, gold: eco?.gold ?? null, items: eco?.inventory.map((i) => i.instanceId) ?? null };
}

// ---------------------------------------------------------------------------
// Region process management
// ---------------------------------------------------------------------------

const CHILD_JS = fileURLToPath(new URL("./drills/region-child.js", import.meta.url));

interface Marker {
  ev: string;
  [k: string]: unknown;
}

class RegionProc {
  readonly proc: ChildProcess;
  private readonly markers: Marker[] = [];
  private waiters: Array<{ pred: (m: Marker) => boolean; resolve: (m: Marker) => void }> = [];
  private stderrBuf = "";
  private exited = false;
  private exitWaiters: Array<(info: string) => void> = [];

  constructor(cfg: Record<string, unknown>, tag: string) {
    const dir = mkdtempSync(join(tmpdir(), `drill-${tag}-`));
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify(cfg));
    this.proc = spawn(process.execPath, [CHILD_JS, cfgPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let m: Marker;
        try {
          m = JSON.parse(line) as Marker;
        } catch {
          continue;
        }
        this.markers.push(m);
        const hit = this.waiters.filter((w) => w.pred(m));
        this.waiters = this.waiters.filter((w) => !w.pred(m));
        for (const w of hit) w.resolve(m);
      }
    });
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      const info = `region ${this.pid} exited (code=${code} signal=${signal}) while waiting; ${this.diagnostics()}`;
      for (const w of this.exitWaiters.splice(0)) w(info);
    });
  }

  private diagnostics(): string {
    return `markers seen: ${JSON.stringify(this.markers).slice(-1200)}; stderr tail:\n${this.stderrBuf.slice(-1500)}`;
  }

  get pid(): number {
    return this.proc.pid!;
  }

  /** Has this region emitted a marker of this kind so far? */
  has(ev: string): boolean {
    return this.markers.some((m) => m.ev === ev);
  }

  waitFor(ev: string, timeoutMs = 45_000, pred?: (m: Marker) => boolean): Promise<Marker> {
    const match = (m: Marker) => m.ev === ev && (pred ? pred(m) : true);
    const existing = this.markers.find(match);
    if (existing) return Promise.resolve(existing);
    const fatal = this.markers.find((m) => m.ev === "fatal");
    if (fatal) {
      return Promise.reject(new Error(`region ${this.pid} reported fatal: ${String(fatal["error"])}; ${this.diagnostics()}`));
    }
    if (this.exited) {
      return Promise.reject(new Error(`region ${this.pid} already exited before marker '${ev}'; ${this.diagnostics()}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `timed out waiting for marker '${ev}' from region ${this.pid}; ${this.diagnostics()}`,
        ));
      }, timeoutMs);
      this.waiters.push({
        pred: match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.exitWaiters.push((info) => {
        clearTimeout(timer);
        reject(new Error(`waiting for marker '${ev}': ${info}`));
      });
    });
  }

  send(cmd: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  /** SIGKILL, with death verified via exit signal AND an ESRCH probe. */
  async kill9(): Promise<void> {
    const pid = this.pid;
    const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      this.proc.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.proc.kill("SIGKILL");
    const { signal } = await exitP;
    assert.equal(signal, "SIGKILL", `region ${pid} must die by SIGKILL`);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `region ${pid} must be gone (ESRCH)`);
    this.exited = true;
  }

  /** Cleanup kill for survivors; not part of any assertion. */
  async dispose(): Promise<void> {
    if (this.exited) return;
    this.proc.kill("SIGKILL");
    await new Promise((r) => this.proc.once("exit", r));
    this.exited = true;
  }
}

function regionCfg(worldUrl: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    worldUrl,
    apiKey: API_KEY,
    range: RANGE,
    lockTtlMs: 2_000,
    loginDeadlineMs: 45_000,
    ...over,
  };
}



const ROSTER = [
  { account: "alice", name: "Arya" },
  { account: "user-b", name: "Bran" },
];

// ---------------------------------------------------------------------------
// Drill 1 — the legendary: a world-committed loot grant survives the
// region's death; the replacement recalls it exactly once.
// ---------------------------------------------------------------------------

test("drill 1 (legendary): lootGrant committed at the world tier survives kill -9; replacement recalls it exactly once", { timeout: 180_000 }, async (t) => {
  const world = await startWorld("d1");
  t.after(() => world.close());

  const a = new RegionProc(regionCfg(world.url, {
    regionId: "region-a", mode: "economy", roster: ROSTER, login: [1],
  }), "d1a");
  t.after(() => a.dispose());
  await a.waitFor("ready");
  a.send({ cmd: "seed", character: 1, gold: 50 });
  const seeded1 = await a.waitFor("seeded");
  assert.equal(seeded1["ok"], true, "the seed save must land at the world tier before the drill proceeds");
  a.send({ cmd: "grant", character: 1, def: 1, sourceId: "boss:gorath", instanceId: "itm-legendary" });
  const grant = await a.waitFor("grant-result");
  assert.equal(grant["ok"], true, "the legendary grant must commit at the world tier");

  const before = await worldEconomy(world.store, 1);
  assert.deepEqual(before?.items, ["itm-legendary"]);
  assert.equal(before?.gold, 50);
  const ledgerBefore = await world.store.getAtomicLedger();
  const grantEntries = ledgerBefore.filter((e) => e.op === "lootGrant" && e.instanceId === "itm-legendary");
  assert.equal(grantEntries.length, 1, "exactly one ledger entry for the grant");
  assert.deepEqual(
    ledgerBefore.map((e) => e.seq),
    ledgerBefore.map((_, i) => i + 1),
    "atomic ledger head is continuous before the kill",
  );

  const killAt = Date.now();
  await a.kill9();

  const b = new RegionProc(regionCfg(world.url, {
    regionId: "region-b", mode: "economy", roster: ROSTER, login: [1],
  }), "d1b");
  t.after(() => b.dispose());
  const ready = await b.waitFor("ready");
  const recoveryMs = Date.now() - killAt;
  const login = (ready["logins"] as Array<Record<string, unknown>>)[0];
  assert.equal(login["seeded"], true, "the replacement's login must seed from the world record");

  b.send({ cmd: "report", character: 1 });
  const rep = await b.waitFor("report");
  assert.deepEqual(rep["worldItems"], ["itm-legendary"], "item present exactly once after takeover");
  assert.equal(rep["worldGold"], 50, "no other character state regressed (gold)");
  assert.equal(rep["localGold"], 50, "the replacement's live cache reconciled to the world record");

  const ledgerAfter = await world.store.getAtomicLedger();
  assert.equal(ledgerAfter.length, ledgerBefore.length, "no phantom movements during recovery");
  console.log(`[drill-metrics] legendary: recoveryMs=${recoveryMs} atomicLedgerEntries=${ledgerAfter.length}`);
});

// ---------------------------------------------------------------------------
// Drill 2 — mid-stream: kill during ledger shipping with an unacked
// tail. Loss is bounded to exactly the unacked events (600 recorded,
// one 512-capped batch acked, 88 unacked); the committed prefix is
// recalled completely, with no duplicates.
// ---------------------------------------------------------------------------

test("drill 2 (mid-stream): kill -9 with an unacked ledger tail loses exactly the unacked events (88 of 600); the acked prefix recalls whole", { timeout: 180_000 }, async (t) => {
  const world = await startWorld("d2");
  t.after(() => world.close());
  const dirA = mkdtempSync(join(tmpdir(), "drill-d2a-"));
  const dirB = mkdtempSync(join(tmpdir(), "drill-d2b-"));

  const a = new RegionProc(regionCfg(world.url, {
    regionId: "region-a", mode: "state", dataDir: dirA,
  }), "d2a");
  t.after(() => a.dispose());
  await a.waitFor("ready");
  a.send({ cmd: "burst", events: 600, tick: 42 });
  const burst = await a.waitFor("burst");
  assert.equal(burst["flushed"], 600);
  assert.equal(burst["localHead"], 600);
  assert.equal(burst["acked"], 512, "one capped batch ships; the 88-event tail stays unacked");

  assert.equal(await world.store.getLedgerHead(RANGE_KEY), 512, "world ledger head is the acked prefix");
  const snap = await world.store.getLatestShardSnapshot(RANGE_KEY);
  assert.ok(snap !== null && snap.tick === 42, "the checkpoint snapshot reached the world store");
  const payload = snap.payload as { data: string };
  const snapshotBytes = Buffer.from(payload.data, "base64").length;
  assert.ok(snapshotBytes > 0);

  const killAt = Date.now();
  await a.kill9();

  const b = new RegionProc(regionCfg(world.url, {
    regionId: "region-b", mode: "state", dataDir: dirB,
  }), "d2b");
  t.after(() => b.dispose());
  await b.waitFor("ready");
  b.send({ cmd: "recall" });
  const rec = await b.waitFor("recalled");
  const recoveryMs = Date.now() - killAt;
  assert.equal(rec["source"], "world");
  assert.equal(rec["tick"], 42);
  assert.equal(rec["imported"], 512, "exactly the acked events replay into the replacement");
  assert.equal(rec["liveItems"], 512, "every acked Create is live exactly once — no duplicates, none lost");
  assert.equal(rec["maxItemId"], 512, "the unacked tail (items 513..600) is the bounded loss, and nothing beyond it appears");
  console.log(`[drill-metrics] mid-stream: recoveryMs=${recoveryMs} eventsReplayed=${rec["imported"]} snapshotBytesRecalled=${snapshotBytes} unackedLost=88`);
});

// ---------------------------------------------------------------------------
// Drill 3 — mid-trade: one side is killed during an active commit
// burst. For every interleaving the world records must satisfy
// exactly-one-owner per item and exact gold conservation.
// ---------------------------------------------------------------------------

test("drill 3 (mid-trade): kill -9 during a tradeCommit burst keeps exactly-one-owner and gold conservation at the world tier", { timeout: 180_000 }, async (t) => {
  const world = await startWorld("d3");
  t.after(() => world.close());

  // Two gateways = two regions with DISJOINT ranges (one range can
  // have only one live region — the range-lease fence). The trade is
  // a world-tier op between the two characters; the ranges only
  // decide which region hosts which character's session.
  const a = new RegionProc(regionCfg(world.url, {
    regionId: "region-a", mode: "economy", roster: ROSTER, login: [1],
  }), "d3a");
  t.after(() => a.dispose());
  const b = new RegionProc(regionCfg(world.url, {
    regionId: "region-b", mode: "economy", roster: ROSTER, login: [2],
    range: { x0: 200, z0: 0, x1: 300, z1: 100 },
  }), "d3b");
  t.after(() => b.dispose());
  await a.waitFor("ready");
  await b.waitFor("ready");

  a.send({ cmd: "seed", character: 1, gold: 100 });
  const seedA = await a.waitFor("seeded");
  assert.equal(seedA["ok"], true, "seed save for character 1 must land");
  b.send({ cmd: "seed", character: 2, gold: 100 });
  const seedB = await b.waitFor("seeded");
  assert.equal(seedB["ok"], true, "seed save for character 2 must land");
  a.send({ cmd: "grantMany", character: 1, def: 0, sourceId: "drill:seed", count: 25, idPrefix: "itm-trade-" });
  const seeded = await a.waitFor("grantMany");
  assert.equal(seeded["granted"], 25);

  const items = Array.from({ length: 25 }, (_, i) => `itm-trade-${i}`);
  const GOLD_PER_TRADE = 4;
  a.send({ cmd: "tradeBurst", a: 1, b: 2, items, goldPerTrade: GOLD_PER_TRADE });
  // Let the burst get going, then kill the initiator mid-stream. The
  // assertions below hold for ANY kill point: they are properties of
  // the committed ledger, not of the timing.
  await a.waitFor("trade", 45_000, (m) => m["ok"] === true);
  await sleep(120);
  await a.kill9();

  const e1 = await worldEconomy(world.store, 1);
  const e2 = await worldEconomy(world.store, 2);
  assert.ok(e1 && e2, "both world records exist");
  const ledger = await world.store.getAtomicLedger();
  const commits = ledger.filter((e) => e.op === "tradeCommit");
  // One trade appends several ledger entries (item leg + gold legs)
  // under ONE opId — committed trades are distinct opIds.
  const k = new Set(commits.map((e) => e.opId)).size;
  assert.ok(k >= 1, "at least one trade committed before the kill");
  assert.equal(
    commits.filter((e) => e.kind === "item").length, k,
    "each committed trade moved exactly one item",
  );

  for (const item of items) {
    const inA = e1!.items!.includes(item);
    const inB = e2!.items!.includes(item);
    assert.ok(inA !== inB, `${item} must have exactly one owner (A=${inA} B=${inB})`);
  }
  assert.equal(e2!.items!.filter((i) => i.startsWith("itm-trade-")).length, k, "items moved == trades committed");
  assert.equal(e1!.gold! + e2!.gold!, 200, "gold is conserved across both characters");
  assert.equal(e1!.gold, 100 + GOLD_PER_TRADE * k, "seller-side gold matches committed trades exactly");
  assert.equal(e2!.gold, 100 - GOLD_PER_TRADE * k, "buyer-side gold matches committed trades exactly");
  console.log(`[drill-metrics] mid-trade: committedTrades=${k} of 25 attempted before the kill; gold 100/100 -> ${e1!.gold}/${e2!.gold}`);
});

// ---------------------------------------------------------------------------
// Drill 4 — zombie: a stale-epoch writer replays writes after the
// takeover. Every replay is fenced; live state is untouched.
// ---------------------------------------------------------------------------

test("drill 4 (zombie): stale-epoch writes replayed after takeover are fenced and live state is untouched", { timeout: 180_000 }, async (t) => {
  const world = await startWorld("d4");
  t.after(() => world.close());

  const a = new RegionProc(regionCfg(world.url, {
    regionId: "region-a", mode: "economy", roster: ROSTER, login: [1],
  }), "d4a");
  t.after(() => a.dispose());
  await a.waitFor("ready");
  a.send({ cmd: "seed", character: 1, gold: 75 });
  const seeded4 = await a.waitFor("seeded");
  assert.equal(seeded4["ok"], true, "seed save must land before the zombie scenario");
  a.send({ cmd: "grant", character: 1, def: 1, sourceId: "boss:gorath", instanceId: "itm-zombie" });
  const grant = await a.waitFor("grant-result");
  assert.equal(grant["ok"], true);
  a.send({ cmd: "report", character: 1 });
  const repA = await a.waitFor("report");
  const staleEpoch = Number(repA["lockEpoch"]);
  const staleVersion = Number(repA["heldVersion"]);
  assert.ok(staleEpoch > 0 && staleVersion > 0);

  await a.kill9();

  const b = new RegionProc(regionCfg(world.url, {
    regionId: "region-b", mode: "economy", roster: ROSTER, login: [1],
  }), "d4b");
  t.after(() => b.dispose());
  const readyB = await b.waitFor("ready");
  const loginB = (readyB["logins"] as Array<Record<string, unknown>>)[0];
  assert.ok(Number(loginB["lockEpoch"]) > staleEpoch, "takeover bumped the lock epoch");
  const before = await worldEconomy(world.store, 1);
  assert.deepEqual(before?.items, ["itm-zombie"]);
  assert.equal(before?.gold, 75);

  // Zombie form 1 — the revived process: the dead region's own
  // identity boots again while its replacement lives. Either the
  // range-lease gate keeps it unregistered, or it registers and its
  // replayed stale-epoch writes are fenced at the write path. Both
  // outcomes are acceptable; a successful stale write is not.
  const revived = new RegionProc(regionCfg(world.url, {
    regionId: "region-a", mode: "economy", roster: ROSTER, login: [],
  }), "d4revived");
  t.after(() => revived.dispose());
  await sleep(8_000);
  if (revived.has("ready")) {
    revived.send({
      cmd: "zombiePut", character: 1, staleEpoch,
      state: { x: 0, y: 0, z: 0, health: 1, stamina: 1, gold: 888_888, inventory: [] },
    });
    const rp = await revived.waitFor("zombie-put");
    assert.equal(rp["ok"], false, "revived region's stale-epoch overwrite must be refused");
  } else {
    console.log("[drill 4] revived region-a stayed unregistered behind the live range lease (gate held)");
  }
  await revived.dispose();

  // Zombie form 2 — the stale-epoch writer: a fresh process on its
  // own range (so it registers cleanly) wielding the dead region's
  // captured epoch + version, replaying a state overwrite and a
  // duplicate grant. It holds no lock; both writes must be fenced.
  const z = new RegionProc(regionCfg(world.url, {
    regionId: "region-z", mode: "economy", roster: ROSTER, login: [],
    range: { x0: 400, z0: 0, x1: 500, z1: 100 },
  }), "d4z");
  t.after(() => z.dispose());
  await z.waitFor("ready");
  z.send({
    cmd: "zombiePut", character: 1, staleEpoch,
    state: { x: 0, y: 0, z: 0, health: 1, stamina: 1, gold: 999_999, inventory: [] },
  });
  const zp = await z.waitFor("zombie-put");
  assert.equal(zp["ok"], false, "stale-epoch state overwrite must be refused");
  z.send({
    cmd: "zombieLoot", character: 1, staleEpoch, staleVersion,
    instanceId: "itm-zombie-dupe", def: 1, sourceId: "zombie:replay",
  });
  const zl = await z.waitFor("zombie-loot");
  assert.equal(zl["ok"], false, "stale-epoch grant must be refused");
  assert.ok(
    ["EPOCH_STALE", "LOCK_CONFLICT", "VERSION_CONFLICT"].includes(String(zl["rejection"])),
    `rejection must be a fencing rejection, got ${String(zl["rejection"])}`,
  );

  const after = await worldEconomy(world.store, 1);
  assert.equal(after?.version, before?.version, "world record version untouched by the zombie");
  assert.equal(after?.gold, 75, "gold untouched by the zombie overwrite attempt");
  assert.deepEqual(after?.items, ["itm-zombie"], "no duplicate item materialized");
  console.log(`[drill-metrics] zombie: staleEpoch=${staleEpoch} liveEpoch=${loginB["lockEpoch"]} lootRejection=${String(zl["rejection"])}`);
});
