/**
 * ResourceNodes (gathering, protocol 0x24): which resource node the
 * interact key would gather from, and which nodes are worked out.
 *
 * The server says what every node is (the mirror's `resources`); the node
 * itself is drawn by the instanced props like any building. A worked-out
 * node is drawn low (stumps, a spent vein, a still pool) until it comes
 * back: `depleted` is the set the entity layer shrinks.
 */

import type * as THREE from "three";
import type { MirrorState } from "@mmo-engine/mirror";
import type { ResourceNodeView } from "@mmo-engine/protocol";

/** A worked-out node is drawn at this share of its height. */
export const DEPLETED_HEIGHT = 0.2;

export class ResourceNodes {
  private nearestId: bigint | null = null;
  /** Worked-out nodes by wire id. */
  readonly depleted = new Set<bigint>();

  /** The node nearest the player whose edge is within `range` metres at the last sync, or null. */
  get nearest(): bigint | null {
    return this.nearestId;
  }

  sync(state: MirrorState, nodes: ReadonlyMap<bigint, ResourceNodeView>, player: THREE.Vector3 | null, range: number): void {
    this.nearestId = null;
    this.depleted.clear();
    let best = Infinity;
    for (const [wid, n] of nodes) {
      if (n.stock <= 0) this.depleted.add(wid);
      const t = state.entities.get(wid)?.transform;
      if (!t || !player) continue;
      // From the node's edge (its footprint, unrotated: nodes are near square).
      const dx = Math.max(0, Math.abs(t.px - player.x) - n.size[0] / 2);
      const dz = Math.max(0, Math.abs(t.pz - player.z) - n.size[1] / 2);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= range && d < best && Math.abs(t.py - player.y) < 6) {
        best = d;
        this.nearestId = wid;
      }
    }
  }
}
