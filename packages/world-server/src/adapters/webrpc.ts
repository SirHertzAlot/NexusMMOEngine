/**
 * webrpc adapter: Express router implementing the webrpc JSON wire
 * protocol for the World service, per world.ridl.
 *
 *   POST /rpc/World/<Method>   Content-Type: application/json
 *   -> {"argName": ...}        <- {"outName": ...}
 *   errors: HTTP <code> with {"code": <code>, "msg": "..."}
 *
 * Hand-authored to the protocol; regenerating with
 *   webrpc-gen -schema=world.ridl -target=typescript
 * must be a drop-in replacement.
 *
 * Auth: RegisterRegion bootstraps with the pre-shared apiKey in the
 * body. Every other method requires `Authorization: Bearer <token>`
 * from the lease; the adapter resolves the token to a region id and
 * rejects body regionIds that don't match. Authentication happens
 * before validation, validation before the core call.
 */
import { json, Router, type Request, type Response } from "express";
import { z } from "zod";
import { WorldCoreImpl } from "../core.js";
import {
  AbortMigrationSchema,
  AcquireCharacterLockSchema,
  AllocateSocialIdsSchema,
  GetSocialRecordsSchema,
  PutSocialRecordSchema,
  AppendLedgerEventsSchema,
  AuctionSettleSchema,
  BeginMigrationSchema,
  CommitMigrationSchema,
  CraftExecuteSchema,
  DeregisterSchema,
  DungeonResultsReportSchema,
  GetCharacterLockSchema,
  GetCharacterStateSchema,
  GetLedgerEventsSchema,
  GetLedgerHeadSchema,
  GetMigrationSchema,
  GetShardSnapshotSchema,
  HeartbeatSchema,
  InventoryMutateSchema,
  LootGrantSchema,
  MAX_CHARACTER_STATE_BYTES,
  MAX_LEDGER_BATCH_BYTES,
  MAX_SNAPSHOT_PAYLOAD_BYTES,
  PutCharacterStateSchema,
  PutShardSnapshotSchema,
  QueryPresenceSchema,
  RegisterRegionSchema,
  ReleaseCharacterLockSchema,
  ReportHostResourcesSchema,
  SetPresenceSchema,
  SnapshotReportSchema,
  TradeCommitSchema,
  VendorTransactSchema,
} from "../schema.js";
import { WorldError } from "../types.js";

const BEARER = /^Bearer ([0-9a-f]{64})$/;

/** Request body caps. Every call gets 256 KiB except the state-plane writes, which get the payload cap their schema enforces plus room for the envelope. */
const DEFAULT_BODY_BYTES = 256 * 1024;
const ENVELOPE_BYTES = 64 * 1024;
const BODY_BYTES: Record<string, number> = {
  "/rpc/World/PutShardSnapshot": MAX_SNAPSHOT_PAYLOAD_BYTES + ENVELOPE_BYTES,
  "/rpc/World/AppendLedgerEvents": MAX_LEDGER_BATCH_BYTES + ENVELOPE_BYTES,
  "/rpc/World/PutCharacterState": MAX_CHARACTER_STATE_BYTES + ENVELOPE_BYTES,
};

function sendError(res: Response, err: unknown): void {
  if (err instanceof WorldError) {
    res.status(err.code).json({ code: err.code, msg: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    const msg = err.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    res.status(400).json({ code: 400, msg: `invalid argument: ${msg}` });
    return;
  }
  console.error("[world] internal error", err);
  res.status(500).json({ code: 500, msg: "internal error" });
}

function bearerToken(req: Request): string | null {
  const h = req.get("authorization");
  if (!h) return null;
  const m = BEARER.exec(h.trim());
  return m ? m[1] : null;
}

export function createWebrpcRouter(core: WorldCoreImpl): Router {
  const r = Router();
  r.use((req, res, next) => {
    if (!req.is("application/json")) {
      res.status(415).json({ code: 415, msg: "content-type must be application/json" });
      return;
    }
    next();
  });
  // The router parses its own bodies: an app-level parser in front of it would cap every call at one size.
  for (const [path, limit] of Object.entries(BODY_BYTES)) r.use(path, json({ limit }));
  r.use(json({ limit: DEFAULT_BODY_BYTES }));

  // -- RegisterRegion: bootstrap auth via apiKey in the body ------------
  r.post("/rpc/World/RegisterRegion", async (req, res) => {
    try {
      const input = RegisterRegionSchema.parse(req.body?.input);
      const lease = await core.registerRegion(input);
      res.json({ lease });
    } catch (err) {
      sendError(res, err);
    }
  });

  // -- ReportHostResources (P5): bootstrap auth via apiKey in the body --
  // The host sidecar is not a region and holds no lease token, so —
  // like RegisterRegion — it authenticates with the pre-shared key;
  // the core verifies it before storing anything.
  r.post("/rpc/World/ReportHostResources", async (req, res) => {
    try {
      const input = ReportHostResourcesSchema.parse(req.body?.input);
      const report = await core.reportHostResources(input);
      res.json({ report });
    } catch (err) {
      sendError(res, err);
    }
  });

  // -- Authenticated methods --------------------------------------------
  async function authed(
    req: Request,
    res: Response,
    fn: (regionId: string) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const token = bearerToken(req);
      if (!token) {
        res.status(401).json({ code: 401, msg: "missing bearer token" });
        return;
      }
      const regionId = await core.authenticate(token);
      if (regionId === null) {
        res.status(401).json({ code: 401, msg: "invalid bearer token" });
        return;
      }
      const bodyRegion = (req.body as Record<string, unknown> | undefined)
        ?.input as Record<string, unknown> | undefined;
      const claimed =
        typeof bodyRegion?.regionId === "string" ? bodyRegion.regionId : null;
      if (claimed !== null && claimed !== regionId) {
        res.status(403).json({ code: 403, msg: "regionId does not match token" });
        return;
      }
      res.json(await fn(regionId));
    } catch (err) {
      sendError(res, err);
    }
  }

  r.post("/rpc/World/Heartbeat", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = HeartbeatSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      const ack = await core.heartbeat(input);
      return { ack };
    }),
  );

  r.post("/rpc/World/DeregisterRegion", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = DeregisterSchema.parse(req.body ?? {});
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      await core.deregisterRegion(input.regionId, input.opId);
      return {};
    }),
  );

  r.post("/rpc/World/ReportSnapshot", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = SnapshotReportSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      await core.reportSnapshot(input);
      return {};
    }),
  );

  // -- Slice B: migration arbitration -----------------------------------
  // The core checks that the caller is the right party for each op.

  r.post("/rpc/World/ListRegions", (req, res) =>
    authed(req, res, async () => ({ regions: await core.listRegions() })),
  );

  r.post("/rpc/World/BeginMigration", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = BeginMigrationSchema.parse(req.body?.input);
      return core.beginMigration(regionId, input);
    }),
  );

  r.post("/rpc/World/CommitMigration", (req, res) =>
    authed(req, res, async (regionId) => {
      await core.commitMigration(regionId, CommitMigrationSchema.parse(req.body ?? {}));
      return {};
    }),
  );

  r.post("/rpc/World/AbortMigration", (req, res) =>
    authed(req, res, async (regionId) => {
      await core.abortMigration(regionId, AbortMigrationSchema.parse(req.body ?? {}));
      return {};
    }),
  );

  r.post("/rpc/World/GetMigration", (req, res) =>
    authed(req, res, async (regionId) => {
      const { migrationId } = GetMigrationSchema.parse(req.body ?? {});
      return { migration: await core.getMigration(regionId, migrationId) };
    }),
  );

  // -- Slice D4: the region's committed dungeon runs ----------------------
  // Idempotent on `instance`: the region replays its `instances.db`
  // unreported rows until the world confirms them ingested.

  r.post("/rpc/World/ReportDungeonResults", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = DungeonResultsReportSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return core.reportDungeonResults(regionId, input);
    }),
  );

  // -- Slice S2: cross-region presence ------------------------------------
  // State, not events: regions replace their online names; queries map
  // names to regions for friends lists.

  r.post("/rpc/World/SetPresence", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = SetPresenceSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      await core.setPresence(regionId, input);
      return {};
    }),
  );

  r.post("/rpc/World/QueryPresence", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = QueryPresenceSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return core.queryPresence(regionId, input);
    }),
  );

  // -- Persistence P1: the state plane ------------------------------------
  // Epoch-fenced writes (snapshots, ledger, character state) and the
  // unfenced reads a booting shard recalls from. The core checks the
  // fence and the session lock; this adapter only validates the edge.

  r.post("/rpc/World/PutShardSnapshot", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = PutShardSnapshotSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { snapshot: await core.putShardSnapshot(regionId, input) };
    }),
  );

  r.post("/rpc/World/GetShardSnapshot", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = GetShardSnapshotSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { snapshot: await core.getShardSnapshot(regionId, input.rangeKey) };
    }),
  );

  r.post("/rpc/World/AppendLedgerEvents", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = AppendLedgerEventsSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return core.appendLedgerEvents(regionId, input);
    }),
  );

  r.post("/rpc/World/GetLedgerEvents", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = GetLedgerEventsSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return core.getLedgerEvents(regionId, input);
    }),
  );

  r.post("/rpc/World/GetLedgerHead", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = GetLedgerHeadSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return core.getLedgerHead(regionId, input);
    }),
  );

  r.post("/rpc/World/PutCharacterState", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = PutCharacterStateSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { character: await core.putCharacterState(regionId, input) };
    }),
  );

  r.post("/rpc/World/GetCharacterState", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = GetCharacterStateSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { character: await core.getCharacterState(regionId, input) };
    }),
  );

  r.post("/rpc/World/PutSocialRecord", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = PutSocialRecordSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { record: await core.putSocialRecord(regionId, input) };
    }),
  );

  r.post("/rpc/World/GetSocialRecords", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = GetSocialRecordsSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { records: await core.getSocialRecords(regionId, input) };
    }),
  );

  r.post("/rpc/World/AllocateSocialIds", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = AllocateSocialIdsSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { ids: await core.allocateSocialIds(regionId, input) };
    }),
  );

  r.post("/rpc/World/AcquireCharacterLock", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = AcquireCharacterLockSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { lock: await core.acquireCharacterLock(regionId, input) };
    }),
  );

  r.post("/rpc/World/ReleaseCharacterLock", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = ReleaseCharacterLockSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      await core.releaseCharacterLock(regionId, input);
      return {};
    }),
  );

  r.post("/rpc/World/GetCharacterLock", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = GetCharacterLockSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { lock: await core.getCharacterLock(regionId, input) };
    }),
  );

  // -- Atomic operations (slice A1) ---------------------------------------
  // The six value-moving exchanges. The settled outcome (success or
  // typed rejection) is the response body: a rejection is a 200 with
  // { result: { ok: false, rejection, ... } } — the operation visibly
  // didn't happen, and nothing partially applied. Malformed input is
  // still a 400 and a foreign regionId a 403, like every other edge.

  r.post("/rpc/World/TradeCommit", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = TradeCommitSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { result: await core.tradeCommit(regionId, input) };
    }),
  );

  r.post("/rpc/World/VendorTransact", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = VendorTransactSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { result: await core.vendorTransact(regionId, input) };
    }),
  );

  r.post("/rpc/World/AuctionSettle", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = AuctionSettleSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { result: await core.auctionSettle(regionId, input) };
    }),
  );

  r.post("/rpc/World/CraftExecute", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = CraftExecuteSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { result: await core.craftExecute(regionId, input) };
    }),
  );

  r.post("/rpc/World/LootGrant", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = LootGrantSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { result: await core.lootGrant(regionId, input) };
    }),
  );

  r.post("/rpc/World/InventoryMutate", (req, res) =>
    authed(req, res, async (regionId) => {
      const input = InventoryMutateSchema.parse(req.body?.input);
      if (input.regionId !== regionId)
        throw new WorldError(403, "regionId does not match token");
      return { result: await core.inventoryMutate(regionId, input) };
    }),
  );

  return r;
}
