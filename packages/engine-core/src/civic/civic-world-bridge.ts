/**
 * CivicWorldBridge (Track A2): synchronizes authoritative civic restoration sites
 * into physical ECS entities in `SimWorld`:
 *
 * - A bridge deck visual entity (`Transform`, `AssetRef`) whose `AssetRef.variant`
 *   encodes the current stage (`0`, `1`, `2`, ...) or `BROKEN_VARIANT` (`0xfffe`)
 *   when structurally damaged.
 * - A gorge blocking barrier entity (`Transform`, `AssetRef` collider tag, `Velocity`,
 *   `BodyConfig` with `ShapeKind.Box` + `MotionType.Static`) that cuts
 *   `NavObstacleSystem`, `PropCollisionSystem`, and `PhysicsSystem` whenever
 *   `stage === 0` or `damaged === true`, and safely removes `BodyConfig` once
 *   `stage >= 1 && !damaged`.
 *
 * Idempotent across repeated `syncSite` / `syncAll` calls and resilient to entity
 * despawns or world restarts.
 */

import { addComponent, entityExists, hasComponent, removeComponent } from "bitecs";
import { BROKEN_VARIANT, type CivicSiteView } from "@mmo-engine/protocol";
import type { CivicRules, CivicSiteDef } from "@mmo-engine/rules";
import { fnv1a32 } from "@mmo-engine/scatter";
import { AssetRef, BodyConfig, MotionType, ShapeKind, Transform, Velocity } from "../components.js";
import type { SimWorld } from "../world.js";
import type { StoredSite } from "./civic-store.js";

const COLLIDER_ASSET_HASH = fnv1a32("collider") >>> 0;
const DEFAULT_BARRIER_HALF_Y = 2.5;
const DEFAULT_BARRIER_HALF_Z = 2.0;

export type CivicBridgeSiteState =
  | Pick<CivicSiteView, "siteId" | "stage" | "damaged">
  | Pick<StoredSite, "id" | "stage" | "damaged">
  | { siteId?: string; id?: string; stage: number; damaged: boolean };

export interface CivicWorldBridgeOptions {
  sim: SimWorld;
  rules: CivicRules;
  /** Authoritative ground height at (x, z); defaults to y = 0. */
  groundHeightAt?: (x: number, z: number) => number;
  /** Optional deck asset id per civic site (defaults to `civic:${site.id}`). */
  deckAssetIdFor?: (site: CivicSiteDef) => string;
  /** Optional gorge barrier half-extents `[hx, hy, hz]` per site. */
  barrierHalfExtentsFor?: (site: CivicSiteDef) => readonly [number, number, number];
  /** Optional yaw in radians around +Y per site (defaults to 0). */
  yawRadFor?: (site: CivicSiteDef) => number;
  /** Optional initial site states to sync immediately upon construction. */
  initialSites?: readonly CivicBridgeSiteState[];
}

export interface CivicSiteEntityPair {
  siteId: string;
  deckEid: number;
  barrierEid: number;
  deckWireId: bigint;
  barrierWireId: bigint;
  blocked: boolean;
}

interface TrackedSiteEntities {
  deckEid: number;
  deckWid: bigint;
  barrierEid: number;
  barrierWid: bigint;
}

function siteIdOf(site: CivicBridgeSiteState): string | undefined {
  if ("siteId" in site && typeof site.siteId === "string" && site.siteId.length > 0) {
    return site.siteId;
  }
  if ("id" in site && typeof site.id === "string" && site.id.length > 0) {
    return site.id;
  }
  return undefined;
}

/** Manages physical ECS bridge visual and gorge-blocking collider entities for civic sites. */
export class CivicWorldBridge {
  private readonly sim: SimWorld;
  private rules: CivicRules;
  private readonly sitesById = new Map<string, CivicSiteDef>();
  private readonly tracked = new Map<string, TrackedSiteEntities>();
  private readonly groundHeightAt: (x: number, z: number) => number;
  private readonly deckAssetIdFor: (site: CivicSiteDef) => string;
  private readonly barrierHalfExtentsFor: (site: CivicSiteDef) => readonly [number, number, number];
  private readonly yawRadFor: (site: CivicSiteDef) => number;

  constructor(opts: CivicWorldBridgeOptions) {
    this.sim = opts.sim;
    this.rules = opts.rules;
    this.groundHeightAt = opts.groundHeightAt ?? (() => 0);
    this.deckAssetIdFor = opts.deckAssetIdFor ?? ((site) => `civic:${site.id}`);
    this.barrierHalfExtentsFor =
      opts.barrierHalfExtentsFor ??
      ((site) => [site.crossingHalfWidthM, DEFAULT_BARRIER_HALF_Y, DEFAULT_BARRIER_HALF_Z] as const);
    this.yawRadFor = opts.yawRadFor ?? (() => 0);

    this.indexRules(this.rules);
    if (opts.initialSites) {
      this.syncAll(opts.initialSites);
    }
  }

  /** Replace civic rules and re-index known sites. */
  setRules(rules: CivicRules): void {
    this.rules = rules;
    this.indexRules(rules);
  }

  private indexRules(rules: CivicRules): void {
    this.sitesById.clear();
    for (const site of rules.sites) {
      this.sitesById.set(site.id, site);
    }
  }

  private isLiveEntity(eid: number, wid: bigint): boolean {
    return eid >= 0 && entityExists(this.sim.ecs, eid) && this.sim.resolveWireId(wid) === eid;
  }

  private spawnDeckEntity(): { eid: number; wid: bigint } {
    const eid = this.sim.spawn();
    addComponent(this.sim.ecs, Transform, eid);
    addComponent(this.sim.ecs, AssetRef, eid);
    return { eid, wid: this.sim.wireId(eid) };
  }

  private spawnBarrierEntity(): { eid: number; wid: bigint } {
    const eid = this.sim.spawn();
    addComponent(this.sim.ecs, Transform, eid);
    addComponent(this.sim.ecs, AssetRef, eid);
    addComponent(this.sim.ecs, Velocity, eid);
    Velocity.lx[eid] = 0;
    Velocity.ly[eid] = 0;
    Velocity.lz[eid] = 0;
    Velocity.ax[eid] = 0;
    Velocity.ay[eid] = 0;
    Velocity.az[eid] = 0;
    return { eid, wid: this.sim.wireId(eid) };
  }

  private ensureEntities(def: CivicSiteDef): TrackedSiteEntities {
    let entry = this.tracked.get(def.id);
    if (!entry) {
      const deck = this.spawnDeckEntity();
      const barrier = this.spawnBarrierEntity();
      entry = {
        deckEid: deck.eid,
        deckWid: deck.wid,
        barrierEid: barrier.eid,
        barrierWid: barrier.wid,
      };
      this.tracked.set(def.id, entry);
      return entry;
    }

    if (!this.isLiveEntity(entry.deckEid, entry.deckWid)) {
      const deck = this.spawnDeckEntity();
      entry.deckEid = deck.eid;
      entry.deckWid = deck.wid;
    }
    if (!this.isLiveEntity(entry.barrierEid, entry.barrierWid)) {
      const barrier = this.spawnBarrierEntity();
      entry.barrierEid = barrier.eid;
      entry.barrierWid = barrier.wid;
    }
    return entry;
  }

  private writeTransform(eid: number, x: number, y: number, z: number, yawRad: number): void {
    const T = Transform;
    const halfYaw = yawRad * 0.5;
    T.px[eid] = x;
    T.py[eid] = y;
    T.pz[eid] = z;
    T.qx[eid] = 0;
    T.qy[eid] = Math.sin(halfYaw);
    T.qz[eid] = 0;
    T.qw[eid] = Math.cos(halfYaw);
    T.sx[eid] = 1;
    T.sy[eid] = 1;
    T.sz[eid] = 1;
  }

  /**
   * Synchronize a single civic site's visual deck variant and blocking barrier collider.
   * Safe and idempotent across repeated calls and entity despawns.
   */
  syncSite(siteId: string, stage: number, damaged: boolean): void {
    const def = this.sitesById.get(siteId);
    if (!def) return;

    const entry = this.ensureEntities(def);
    const rawGround = this.groundHeightAt(def.x, def.z);
    const groundY = Number.isFinite(rawGround) ? rawGround : 0;
    const yawRad = this.yawRadFor(def);
    const rawExtents = this.barrierHalfExtentsFor(def);
    const hx = Math.max(0.25, Number.isFinite(rawExtents[0]) ? rawExtents[0] : def.crossingHalfWidthM);
    // Keep halfY strictly > 0.2 m so NavObstacleSystem treats the barrier as an obstacle, not a floor slab.
    const hy = Math.max(0.5, Number.isFinite(rawExtents[1]) ? rawExtents[1] : DEFAULT_BARRIER_HALF_Y);
    const hz = Math.max(0.25, Number.isFinite(rawExtents[2]) ? rawExtents[2] : DEFAULT_BARRIER_HALF_Z);

    // 1. Bridge deck visual entity (Transform + AssetRef)
    const deckEid = entry.deckEid;
    if (!hasComponent(this.sim.ecs, Transform, deckEid)) addComponent(this.sim.ecs, Transform, deckEid);
    if (!hasComponent(this.sim.ecs, AssetRef, deckEid)) addComponent(this.sim.ecs, AssetRef, deckEid);
    this.writeTransform(deckEid, def.x, groundY, def.z, yawRad);
    AssetRef.assetHash[deckEid] = fnv1a32(this.deckAssetIdFor(def)) >>> 0;
    const clampedStage = Math.max(0, Math.min(0xfffd, Math.trunc(Number.isFinite(stage) ? stage : 0)));
    AssetRef.variant[deckEid] = damaged ? BROKEN_VARIANT : clampedStage;

    // 2. Gorge blocking barrier entity (Transform + hidden collider AssetRef + Velocity + BodyConfig)
    const barrierEid = entry.barrierEid;
    if (!hasComponent(this.sim.ecs, Transform, barrierEid)) addComponent(this.sim.ecs, Transform, barrierEid);
    if (!hasComponent(this.sim.ecs, AssetRef, barrierEid)) addComponent(this.sim.ecs, AssetRef, barrierEid);
    this.writeTransform(barrierEid, def.x, groundY + hy * 0.5, def.z, yawRad);
    AssetRef.assetHash[barrierEid] = COLLIDER_ASSET_HASH;
    AssetRef.variant[barrierEid] = 0;

    const blocked = clampedStage < 1 || damaged;
    if (blocked) {
      if (!hasComponent(this.sim.ecs, Velocity, barrierEid)) {
        addComponent(this.sim.ecs, Velocity, barrierEid);
      }
      Velocity.lx[barrierEid] = 0;
      Velocity.ly[barrierEid] = 0;
      Velocity.lz[barrierEid] = 0;
      Velocity.ax[barrierEid] = 0;
      Velocity.ay[barrierEid] = 0;
      Velocity.az[barrierEid] = 0;

      if (!hasComponent(this.sim.ecs, BodyConfig, barrierEid)) {
        addComponent(this.sim.ecs, BodyConfig, barrierEid);
      }
      BodyConfig.shapeKind[barrierEid] = ShapeKind.Box;
      BodyConfig.halfX[barrierEid] = hx;
      BodyConfig.halfY[barrierEid] = hy;
      BodyConfig.halfZ[barrierEid] = hz;
      BodyConfig.radius[barrierEid] = 0;
      BodyConfig.mass[barrierEid] = 0;
      BodyConfig.motionType[barrierEid] = MotionType.Static;
      BodyConfig.layer[barrierEid] = 0;
      BodyConfig.friction[barrierEid] = 0.8;
      BodyConfig.restitution[barrierEid] = 0;
    } else if (hasComponent(this.sim.ecs, BodyConfig, barrierEid)) {
      removeComponent(this.sim.ecs, BodyConfig, barrierEid);
    }
  }

  /**
   * Synchronize a batch of civic sites (e.g. `store.listSites()` or `state.sites`).
   * Unseen rule-defined sites are initialized to stage 0 (blocked) if not yet tracked.
   */
  syncAll(sites: readonly CivicBridgeSiteState[]): void {
    const synced = new Set<string>();
    for (const site of sites) {
      const id = siteIdOf(site);
      if (!id) continue;
      synced.add(id);
      this.syncSite(id, site.stage, site.damaged);
    }
    for (const def of this.rules.sites) {
      if (!synced.has(def.id) && !this.tracked.has(def.id)) {
        this.syncSite(def.id, 0, false);
      }
    }
  }

  /** Return live entity handles for a civic site, or undefined if not synced/live. */
  entitiesOf(siteId: string): CivicSiteEntityPair | undefined {
    const entry = this.tracked.get(siteId);
    if (!entry) return undefined;
    if (!this.isLiveEntity(entry.deckEid, entry.deckWid) || !this.isLiveEntity(entry.barrierEid, entry.barrierWid)) {
      return undefined;
    }
    return {
      siteId,
      deckEid: entry.deckEid,
      barrierEid: entry.barrierEid,
      deckWireId: entry.deckWid,
      barrierWireId: entry.barrierWid,
      blocked: hasComponent(this.sim.ecs, BodyConfig, entry.barrierEid),
    };
  }

  /** Whether the site's gorge barrier currently carries an active static BodyConfig collider. */
  isBlocked(siteId: string): boolean {
    const pair = this.entitiesOf(siteId);
    return pair ? pair.blocked : false;
  }

  /** Despawn all live bridge visual and barrier entities tracked by this bridge. */
  dispose(): void {
    for (const entry of this.tracked.values()) {
      if (this.isLiveEntity(entry.deckEid, entry.deckWid)) {
        this.sim.despawn(entry.deckEid);
      }
      if (this.isLiveEntity(entry.barrierEid, entry.barrierWid)) {
        this.sim.despawn(entry.barrierEid);
      }
    }
    this.tracked.clear();
  }
}
