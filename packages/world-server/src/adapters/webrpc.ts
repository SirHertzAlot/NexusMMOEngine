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
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { WorldCoreImpl } from "../core.js";
import {
  AbortMigrationSchema,
  BeginMigrationSchema,
  CommitMigrationSchema,
  DeregisterSchema,
  DungeonResultsReportSchema,
  GetMigrationSchema,
  HeartbeatSchema,
  RegisterRegionSchema,
  SnapshotReportSchema,
} from "../schema.js";
import { WorldError } from "../types.js";

const BEARER = /^Bearer ([0-9a-f]{64})$/;

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

  return r;
}
