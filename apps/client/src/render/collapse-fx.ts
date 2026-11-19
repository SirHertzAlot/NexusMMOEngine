/**
 * Collapse FX tracker (DE2 / DE5): watches static structural/prop entities so that when
 * CollapseSystem switches one dynamic to fall, the client emits release dust + crumble
 * debris, trailing dust while falling, and an impact burst on landing. Pure: no THREE.
 */

import type { BodyConfigRow, TransformRow, VelocityRow } from "@mmo-engine/protocol";

export interface BoxBurstSpec {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

export interface CollapseFxEvent {
  release?: BoxBurstSpec;
  trail?: { x: number; y: number; z: number };
  impact?: BoxBurstSpec;
}

interface TrackedProp {
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  lastAt: number;
  hx: number;
  hy: number;
  hz: number;
  falling: boolean;
  impacted: boolean;
  lastTrailAt: number;
  maxDrop: number;
  peakSpeed: number;
  settleTime: number;
}

const RELEASE_DISP_SQ = 0.08 * 0.08;
const TRAIL_INTERVAL_S = 0.14;

export class CollapseWatch {
  private readonly props = new Map<bigint, TrackedProp>();

  get size(): number {
    return this.props.size;
  }

  observe(
    wid: bigint,
    t: TransformRow,
    body: BodyConfigRow | undefined,
    isStatic: boolean,
    velocity: VelocityRow | undefined,
    now: number,
    groundY: number,
  ): CollapseFxEvent | null {
    const existing = this.props.get(wid);
    const r = body && body.radius > 0 ? body.radius : 0.4;
    const hx = Math.max(0.15, (body && body.halfX > 0 ? body.halfX : r) * t.sx);
    const hy = Math.max(0.15, (body && body.halfY > 0 ? body.halfY : r) * t.sy);
    const hz = Math.max(0.15, (body && body.halfZ > 0 ? body.halfZ : r) * t.sz);

    if (!existing) {
      if (!isStatic) return null;
      this.props.set(wid, {
        anchorX: t.px,
        anchorY: t.py,
        anchorZ: t.pz,
        lastX: t.px,
        lastY: t.py,
        lastZ: t.pz,
        lastAt: now,
        hx,
        hy,
        hz,
        falling: false,
        impacted: false,
        lastTrailAt: now,
        maxDrop: 0,
        peakSpeed: 0,
        settleTime: 0,
      });
      return null;
    }

    existing.hx = hx;
    existing.hy = hy;
    existing.hz = hz;

    const dt = Math.max(1 / 120, now - existing.lastAt);
    const stepSpeed = Math.hypot(t.px - existing.lastX, t.py - existing.lastY, t.pz - existing.lastZ) / dt;
    const velSpeed = velocity ? Math.hypot(velocity.lx, velocity.ly, velocity.lz) : 0;
    const speed = velocity !== undefined ? velSpeed : stepSpeed;

    existing.lastX = t.px;
    existing.lastY = t.py;
    existing.lastZ = t.pz;
    existing.lastAt = now;
    existing.maxDrop = Math.max(existing.maxDrop, existing.anchorY - t.py);
    existing.peakSpeed = Math.max(existing.peakSpeed, speed);

    const dx = t.px - existing.anchorX;
    const dy = t.py - existing.anchorY;
    const dz = t.pz - existing.anchorZ;
    const dispSq = dx * dx + dy * dy + dz * dz;

    if (!existing.falling) {
      if (dispSq > RELEASE_DISP_SQ || (!isStatic && speed > 0.4)) {
        existing.falling = true;
        existing.lastTrailAt = now;
        return { release: { x: t.px, y: t.py - hy, z: t.pz, hx, hy, hz } };
      }
      return null;
    }

    if (existing.impacted) return null;

    const nearGround = t.py - hy <= groundY + 0.35;
    if (speed < 0.35 && (existing.maxDrop > 0.25 || nearGround)) {
      existing.settleTime += dt;
    } else {
      existing.settleTime = 0;
    }

    if ((nearGround && existing.peakSpeed > 1.0 && speed < 1.2) || existing.settleTime >= 0.12) {
      existing.impacted = true;
      return { impact: { x: t.px, y: Math.max(groundY, t.py - hy), z: t.pz, hx, hy, hz } };
    }

    if (speed > 0.6 && now - existing.lastTrailAt >= TRAIL_INTERVAL_S) {
      existing.lastTrailAt = now;
      return { trail: { x: t.px, y: t.py, z: t.pz } };
    }

    return null;
  }

  forget(wid: bigint): void {
    this.props.delete(wid);
  }

  prune(exists: (wid: bigint) => boolean): void {
    for (const wid of this.props.keys()) {
      if (!exists(wid)) this.props.delete(wid);
    }
  }
}
