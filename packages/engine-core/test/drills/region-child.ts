/**
 * Durability drills: the region process.
 *
 * A standalone child process that stands up a fleet-mode region's
 * durability-relevant stack with the PRODUCTION wiring (mirroring
 * server.ts and test/world-atomic.test.ts's makeRig):
 *
 * - economy mode: WorldClient (real webrpc/HTTP transport) +
 *   MemoryCharacterStore + WalletSystem + ItemService +
 *   WorldCharacterSync + WorldAtomicOps — the character/atomic plane.
 * - state mode: WorldClient + SimWorld + SnapshotStore + ItemLedger
 *   (both on one file-backed world.db, exactly as server.ts opens
 *   them) + ShardStateShipper — the shard state plane (P2/P3).
 *
 * Protocol: argv[2] is a JSON config file. Markers are JSON lines on
 * stdout ({ev: ...}); commands are JSON lines on stdin ({cmd: ...}).
 * The parent test kills this process with SIGKILL mid-scenario; the
 * process deliberately keeps no shutdown handling for durability
 * state — death is the scenario, not an error path.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import { addComponent } from "bitecs";
import { engineDefaults } from "@mmo-engine/rules";
import {
  Health,
  MemoryCharacterStore,
  SimWorld,
  SnapshotStore,
  Transform,
} from "../../src/index.js";
import { ItemLedger, LedgerKind } from "../../src/persist/item-ledger.js";
import { ItemDefs, ItemService, type PoolItemLike } from "../../src/items/index.js";
import { WalletSystem } from "../../src/economy/wallet.js";
import { WorldClient, WorldTransportError } from "../../src/world/client.js";
import { WebrpcWorldTransport } from "../../src/world/webrpc-transport.js";
import {
  WorldCharacterSync,
  economyOfState,
} from "../../src/world/character-sync.js";
import {
  LocalEconomyView,
  WorldAtomicOps,
} from "../../src/world/atomic-ops.js";
import { ShardStateShipper } from "../../src/world/state-shipper.js";
import { recallShardState } from "../../src/world/state-recall.js";

interface ChildConfig {
  worldUrl: string;
  apiKey: string;
  regionId: string;
  range: { x0: number; z0: number; x1: number; z1: number };
  lockTtlMs: number;
  mode: "economy" | "state";
  roster?: Array<{ account: string; name: string }>;
  login?: number[];
  loginDeadlineMs?: number;
  dataDir?: string;
}

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8")) as ChildConfig;

function mark(ev: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ev, ...extra }));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Item defs: the A2 test pool verbatim in shape — def 0 common sword,
// def 1 rare ("legendary") sword, def 2 common ring.
// ---------------------------------------------------------------------------

const RULES = (() => {
  const r = engineDefaults();
  r.items.bases.sword = {
    ...r.items.fallback,
    mass: 1.3, length: 0.9, edge: 0.9, point: 0.8, hardness: 0.9, hand: "main", technique: "cut",
    models: ["pack/SM_Wep_Sword_01", "pack/SM_Wep_Sword_02"],
  };
  return r;
})();

function poolItem(id: string, base: string, rank: string, source: string, seed: number): PoolItemLike {
  return {
    id, rank, source, item: base, seed,
    bundle: { Identity: { id, name: `${rank} ${base} ${id}`, base }, Rank: { id: rank, color: "#ffffff" }, Stats: {} },
  };
}

const POOL: PoolItemLike[] = [
  poolItem("a", "sword", "common", "mob", 0),
  poolItem("b", "sword", "rare", "boss", 1),
  poolItem("c", "ring", "common", "mob", 2),
];

const LOOT = { ownershipSeconds: 30, despawnSeconds: 300, pickupRange: 2.5, bagSlots: 20, maxGroundItems: 100 };
const LOOK = JSON.stringify({ gender: "female", parts: {}, colours: {} });

// ---------------------------------------------------------------------------
// Command plumbing: stdin lines are handled strictly sequentially.
// ---------------------------------------------------------------------------

type Handler = (cmd: Record<string, unknown>) => Promise<void>;
let handler: Handler = async () => {};
let chain: Promise<void> = Promise.resolve();

function installCommands(h: Handler): void {
  handler = h;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      mark("bad-command", { line: trimmed });
      return;
    }
    chain = chain.then(() => handler(cmd)).catch((err) => {
      mark("command-error", { cmd: String(cmd["cmd"]), error: String(err).slice(0, 300) });
    });
  });
}

function makeClient(): WorldClient {
  return new WorldClient({
    transport: new WebrpcWorldTransport(cfg.worldUrl),
    regionId: cfg.regionId,
    chunkRange: cfg.range,
    endpoint: "ws://127.0.0.1:7777",
    capacity: 100,
    apiKey: cfg.apiKey,
    heartbeatIntervalMs: 1_000,
    onError: () => {},
  });
}

/**
 * Boot registration with supervisor-style retries. A replacement
 * region that boots while its predecessor's lease is still live gets
 * a 409 from the world (two live regions for one range must not
 * coexist — the range-lease fence working as designed); the world's
 * reaper evicts the dead region once its heartbeat times out, and a
 * later attempt succeeds with a higher epoch. Production regions are
 * supervised the same way; the P3 recall tests model the same
 * reap-then-register takeover.
 */
async function startWithRetry(client: WorldClient, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      await client.start();
    } catch {
      // Refused or transport down — fall through to the retry check.
    }
    if (client.registered) return;
    if (Date.now() > deadline) {
      throw new Error("region failed to register with the world server");
    }
    await sleep(500);
  }
}

async function loginWithRetry(
  sync: WorldCharacterSync,
  characterId: number,
  deadlineMs: number,
): Promise<{ seeded: boolean }> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const r = await sync.login(characterId);
    if (r.ok) return { seeded: r.seeded };
    if (Date.now() > deadline) {
      throw new Error(`login for character ${characterId} refused past deadline: ${r.reason ?? "?"}`);
    }
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// Economy mode
// ---------------------------------------------------------------------------

async function runEconomy(): Promise<void> {
  const client = makeClient();
  const store = new MemoryCharacterStore();
  const wallet = new WalletSystem();
  const defs = new ItemDefs(POOL, RULES);
  let opsRef: WorldAtomicOps | null = null;
  const items = new ItemService({
    defs,
    loot: LOOT,
    tickHz: 30,
    atomicGrant: {
      loot: async (character, sourceId, instanceId, def) => {
        if (!opsRef) throw new Error("atomic ops not wired");
        const r = await opsRef.loot({ character, sourceId, instanceId, def });
        return r.ok
          ? { ok: true as const }
          : { ok: false as const, message: `grant refused by the world (${r.rejection}: ${r.message})` };
      },
    },
  });
  const view = new LocalEconomyView({
    wallet,
    store: items.store,
    durabilityOf: (def) => defs.durability[def] ?? 100,
  });
  const sync = new WorldCharacterSync({
    client,
    store,
    economy: view,
    lockTtlMs: cfg.lockTtlMs,
    log: () => {},
  });
  const ops = new WorldAtomicOps({ client, fences: sync });
  opsRef = ops;

  await startWithRetry(client, cfg.loginDeadlineMs ?? 30_000);
  if (!client.registered) throw new Error("region failed to register with the world server");

  for (const entry of cfg.roster ?? []) {
    const rec = await store.create(entry.account, entry.name, LOOK, 10);
    // A created character has no saveable state until one is stored —
    // without this, sync.save() has an empty payload and uploads
    // nothing (the A2 rig's seedCharacter does the same saveState).
    store.saveState(rec.id, { x: 0, y: 0, z: 0, health: 100, stamina: 100 });
  }
  const logins: Array<Record<string, unknown>> = [];
  for (const id of cfg.login ?? []) {
    const { seeded } = await loginWithRetry(sync, id, cfg.loginDeadlineMs ?? 25_000);
    logins.push({
      character: id,
      seeded,
      lockEpoch: sync.lockEpoch(id),
      version: sync.worldVersion(id),
    });
  }
  mark("ready", { regionEpoch: client.epoch, logins });

  installCommands(async (cmd) => {
    switch (cmd["cmd"]) {
      case "seed": {
        const character = Number(cmd["character"]);
        wallet.grant(character, Number(cmd["gold"]), 1);
        const ok = await sync.save(character);
        mark("seeded", { character, ok, version: sync.worldVersion(character) });
        break;
      }
      case "grant": {
        const character = Number(cmd["character"]);
        const r = await ops.loot({
          character,
          sourceId: String(cmd["sourceId"]),
          instanceId: String(cmd["instanceId"]),
          def: Number(cmd["def"]),
        });
        mark("grant-result", {
          character,
          ok: r.ok,
          rejection: r.ok ? null : r.rejection,
          lockEpoch: sync.lockEpoch(character),
          version: sync.worldVersion(character),
        });
        break;
      }
      case "grantMany": {
        const character = Number(cmd["character"]);
        const count = Number(cmd["count"]);
        let granted = 0;
        for (let i = 0; i < count; i++) {
          const r = await ops.loot({
            character,
            sourceId: String(cmd["sourceId"]),
            instanceId: `${String(cmd["idPrefix"])}${i}`,
            def: Number(cmd["def"]),
          });
          if (!r.ok) {
            mark("grantMany", { character, granted, failedAt: i, rejection: r.rejection });
            return;
          }
          granted++;
        }
        mark("grantMany", { character, granted, version: sync.worldVersion(character) });
        break;
      }
      case "tradeBurst": {
        const a = Number(cmd["a"]);
        const b = Number(cmd["b"]);
        const goldPerTrade = Number(cmd["goldPerTrade"]);
        for (const item of cmd["items"] as string[]) {
          const r = await ops.trade({
            a, b,
            aGivesItems: [item],
            aGivesGold: 0,
            bGivesItems: [],
            bGivesGold: goldPerTrade,
          });
          mark("trade", { item, ok: r.ok, rejection: r.ok ? null : r.rejection });
        }
        mark("tradeBurst-done", { count: (cmd["items"] as string[]).length });
        break;
      }
      case "report": {
        const character = Number(cmd["character"]);
        const rec = await client.getCharacterState(character);
        const eco = rec ? economyOfState(rec.state) : null;
        mark("report", {
          character,
          localGold: wallet.balanceOf(character),
          worldGold: eco?.gold ?? null,
          worldItems: eco?.inventory.map((i) => i.instanceId) ?? null,
          worldVersion: rec?.version ?? null,
          lockEpoch: sync.lockEpoch(character),
          heldVersion: sync.worldVersion(character),
        });
        break;
      }
      case "zombiePut": {
        const character = Number(cmd["character"]);
        try {
          await client.putCharacterState(character, Number(cmd["staleEpoch"]), cmd["state"]);
          mark("zombie-put", { character, ok: true });
        } catch (err) {
          mark("zombie-put", {
            character,
            ok: false,
            code: err instanceof WorldTransportError ? err.code : null,
            error: String(err).slice(0, 200),
          });
        }
        break;
      }
      case "zombieLoot": {
        const character = Number(cmd["character"]);
        try {
          const r = await client.lootGrant({
            opId: `zombie-${cfg.regionId}-${Date.now()}`,
            participant: {
              characterId: character,
              epoch: Number(cmd["staleEpoch"]),
              expectedVersion: Number(cmd["staleVersion"]),
            },
            sourceId: String(cmd["sourceId"] ?? "zombie"),
            instanceId: String(cmd["instanceId"]),
            def: Number(cmd["def"]),
          });
          mark("zombie-loot", { character, ok: r.ok, rejection: r.ok ? null : r.rejection });
        } catch (err) {
          mark("zombie-loot", {
            character,
            ok: false,
            thrown: true,
            code: err instanceof WorldTransportError ? err.code : null,
            error: String(err).slice(0, 200),
          });
        }
        break;
      }
      case "ping":
        mark("pong", {});
        break;
      default:
        mark("unknown-command", { cmd: String(cmd["cmd"]) });
    }
  });
}

// ---------------------------------------------------------------------------
// State mode (P2 shipper / P3 recall)
// ---------------------------------------------------------------------------

async function runState(): Promise<void> {
  const client = makeClient();
  const dbPath = `${cfg.dataDir}/world.db`;
  const store = new SnapshotStore({ dbPath, saveEveryTicks: 300 });
  const ledger = new ItemLedger(dbPath, { autoCheckpoint: false });
  const shipper = new ShardStateShipper({
    client,
    ledger,
    snapshotIntervalTicks: 300,
    log: () => {},
  });

  const sim = new SimWorld();
  for (let i = 0; i < 8; i++) {
    const e = sim.spawn();
    addComponent(sim.ecs, Transform, e);
    addComponent(sim.ecs, Health, e);
    Transform.px[e] = i * 3;
    Transform.py[e] = 1;
    Transform.pz[e] = -i;
    Transform.qw[e] = 1;
    Transform.sx[e] = 1;
    Transform.sy[e] = 1;
    Transform.sz[e] = 1;
    Health.current[e] = 50 + i;
    Health.max[e] = 100;
  }

  await startWithRetry(client, cfg.loginDeadlineMs ?? 30_000);
  if (!client.registered) throw new Error("region failed to register with the world server");
  mark("ready", { regionEpoch: client.epoch });

  let recordedTotal = 0;
  installCommands(async (cmd) => {
    switch (cmd["cmd"]) {
      case "burst": {
        const events = Number(cmd["events"]);
        const tick = Number(cmd["tick"]);
        ledger.tick = tick;
        for (let i = 1; i <= events; i++) {
          ledger.record(LedgerKind.Create, i, 3, 0, 0, 10);
        }
        const flushed = ledger.flush();
        recordedTotal += flushed;
        const sr = store.saveWorld(tick, sim);
        const digest = createHash("sha256").update(`${tick}:${sim.liveEntityCount}`).digest("hex");
        shipper.offerSnapshot(tick, digest, sr.snapshotBytes);
        // Pump past the phase-offset due tick so the snapshot ships in
        // this cycle too; the ledger batch cap (512) leaves the tail
        // unacked — the drill's bounded-loss window.
        await shipper.pump(tick + 300);
        mark("burst", {
          flushed,
          localHead: recordedTotal,
          acked: shipper.worldAckedSeq,
          snapshotTick: tick,
          snapshotBytes: sr.snapshotBytes.length,
        });
        break;
      }
      case "recall": {
        const outcome = await recallShardState({ client, store, ledger, log: () => {} });
        const rows = ledger.load();
        mark("recalled", {
          source: outcome.source,
          tick: outcome.tick,
          worldTick: outcome.worldTick,
          seen: outcome.ledgerEventsSeen,
          imported: outcome.ledgerEventsImported,
          liveItems: rows.length,
          maxItemId: ledger.maxItemId(),
          diverged: outcome.diverged,
        });
        break;
      }
      case "ping":
        mark("pong", {});
        break;
      default:
        mark("unknown-command", { cmd: String(cmd["cmd"]) });
    }
  });
}

try {
  if (cfg.mode === "economy") await runEconomy();
  else await runState();
} catch (err) {
  mark("fatal", { error: String(err).slice(0, 300) });
  process.exit(2);
}

// Stay alive until killed; the parent owns our lifetime.
setInterval(() => {}, 60_000);
