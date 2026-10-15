/**
 * Colliders overlay (play-mode debugger) — draws the server's collision
 * bodies near the player as wireframes over the game view, so a walk
 * through a house can be checked against what the server actually has.
 *
 * The server answers the read-only `colliders` debug query (0x0a) from
 * the live sim; the geometry is the pure model in inspectors/collider-view.ts.
 * Three LineSegments batches, one per shape kind (box, sphere, capsule):
 * three draw calls however many bodies there are. The static batches are
 * re-uploaded only when the set changes; capsules (they move) every poll.
 * Developer tool, so it lives in the editor, never in the player client.
 */

import * as React from "react";
import * as THREE from "three";
import type { DebugCollider } from "@mmo-engine/protocol";
import type { MirrorClient } from "@mmo-engine/mirror";
import { colliderCounts, colliderKey, colliderLines } from "../inspectors/collider-view.js";

/** Metres around the player the overlay asks for. */
export const COLLIDER_RADIUS = 64;
const POLL_MS = 1000;

/** One growable line batch: the buffer only reallocates when a bigger set arrives. */
class LineBatch {
  readonly lines: THREE.LineSegments;
  private capacity = 0;

  constructor(color: number) {
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      // Over everything: the point is seeing a body inside the wall that hides it.
      new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9, fog: false }),
    );
    this.lines.renderOrder = 999;
    this.lines.frustumCulled = false;
    // Allocated up front: an empty set still leaves a valid (zero-length) position buffer.
    this.set(new Float32Array(0));
  }

  set(data: Float32Array): void {
    if (data.length > this.capacity || this.capacity === 0) {
      this.capacity = 3 * Math.max(128, 2 ** Math.ceil(Math.log2(data.length / 3)));
      this.lines.geometry.dispose();
      this.lines.geometry = new THREE.BufferGeometry();
      this.lines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.capacity), 3));
    }
    const pos = this.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    pos.array.set(data);
    pos.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, data.length / 3);
    this.lines.geometry.boundingSphere = null; // the set changed: recompute on demand
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

export class ColliderOverlay {
  private readonly box = new LineBatch(0xffa030);
  private readonly sphere = new LineBatch(0x30d0ff);
  private readonly capsule = new LineBatch(0x40ff70);
  private readonly group = new THREE.Group();
  private staticKey = "";

  constructor(private readonly scene: THREE.Scene) {
    this.group.name = "collider-overlay";
    this.group.add(this.box.lines, this.sphere.lines, this.capsule.lines);
    scene.add(this.group);
  }

  /** Show this answer: statics only when their set changed, capsules always. */
  set(list: readonly DebugCollider[]): void {
    const statics = list.filter((c) => c.shape !== 2);
    const key = colliderKey(statics);
    if (key !== this.staticKey) {
      this.staticKey = key;
      const { box, sphere } = colliderLines(statics);
      this.box.set(box);
      this.sphere.set(sphere);
    }
    this.capsule.set(colliderLines(list.filter((c) => c.shape === 2)).capsule);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.box.dispose();
    this.sphere.dispose();
    this.capsule.dispose();
  }
}

export interface ColliderReadout {
  box: number;
  sphere: number;
  capsule: number;
  /** Every body in range; more than the drawn sum when the server capped the list. */
  total: number;
}

/**
 * Poll the colliders around `at()` while `enabled` and draw them in `scene`.
 * Returns the last counts (null: off or no answer yet).
 */
export function useColliderOverlay(
  client: MirrorClient,
  scene: THREE.Scene | null,
  enabled: boolean,
  at: () => { x: number; z: number } | null,
): ColliderReadout | null {
  const [readout, setReadout] = React.useState<ColliderReadout | null>(null);
  const atRef = React.useRef(at);
  atRef.current = at;
  React.useEffect(() => {
    if (!enabled || !scene) {
      setReadout(null);
      return;
    }
    const overlay = new ColliderOverlay(scene);
    let alive = true;
    const poll = (): void => {
      const p = atRef.current();
      if (!p) return;
      client
        .debug({ kind: "debug", query: "colliders", x: p.x, z: p.z, radius: COLLIDER_RADIUS })
        .then((res) => {
          if (!alive || res.query !== "colliders") return;
          overlay.set(res.colliders);
          setReadout({ ...colliderCounts(res.colliders), total: res.total });
        })
        // One query in flight at a time (the Play panel's overlays share the client): try again next tick.
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
      overlay.dispose();
    };
  }, [client, scene, enabled]);
  return readout;
}
