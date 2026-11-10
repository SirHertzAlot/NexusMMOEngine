/**
 * EmitterFx — VfxEmitter mirror rows made visible.
 *
 * The server owns VfxEmitter components (ComponentId 19): a template
 * hash (fnv1a32 of the VfxEffect id) and an intensity. The wire carries
 * the rows (protocol VfxEmitter block); this layer resolves each hash
 * against the bundled effect registry and runs the effect — converted
 * by @mmo-engine/art's vfxToQuarks and drawn by the shared QuarksFx
 * renderer — on an anchor that follows the entity's Transform.
 *
 * Lifecycle, reconciled every frame from MirrorState (the same shape
 * as EntityLayer/DropLabels sync):
 * - row appears            -> spawn the effect at the entity's Transform
 * - template changes       -> despawn + respawn with the new effect
 * - intensity changes      -> rescale emission in place (no respawn)
 * - entity or row vanishes -> despawn
 * - unknown template hash  -> nothing (content the client doesn't
 *   bundle yet is skipped, never guessed at)
 *
 * The browser holds no game logic (operating rule 1): this only draws
 * what the authoritative rows say.
 */

import * as THREE from "three";
import { parseVfxEffect, type VfxEffect } from "@mmo-engine/art/browser";
import type { MirrorState } from "@mmo-engine/mirror";
import { fnv1a32 } from "./synty-props.js";
import type { EffectHandle, QuarksFx } from "./vfx/quarks-fx.js";

/** The wire template hash of an effect id — the server's fnv1a32 (see @mmo-engine/scatter). */
export function emitterTemplateHash(effectId: string): number {
  return fnv1a32(effectId) >>> 0;
}

/**
 * Build the template-hash -> effect registry from raw effect documents
 * (each validated by parseVfxEffect, so a malformed document fails at
 * startup, not at first spawn). Two documents with the same id are a
 * content bug and throw.
 */
export function buildEmitterRegistry(docs: Iterable<unknown>): Map<number, VfxEffect> {
  const out = new Map<number, VfxEffect>();
  for (const doc of docs) {
    const effect = parseVfxEffect(doc);
    const hash = emitterTemplateHash(effect.id);
    if (out.has(hash)) throw new Error(`emitter registry: duplicate effect id "${effect.id}"`);
    out.set(hash, effect);
  }
  return out;
}

interface LiveEmitter {
  anchor: THREE.Object3D;
  handle: EffectHandle;
  template: number;
  intensity: number;
}

export class EmitterFxLayer {
  /** Add this to the scene: it holds the anchors (QuarksFx draws the particles). */
  readonly group = new THREE.Group();
  private readonly live = new Map<bigint, LiveEmitter>();

  constructor(
    private readonly quarks: QuarksFx,
    private readonly registry: ReadonlyMap<number, VfxEffect>,
  ) {
    this.group.name = "emitter-fx";
  }

  /** Effects running now (tests, HUD). */
  get count(): number {
    return this.live.size;
  }

  /** Reconcile the layer with mirror state. */
  sync(state: MirrorState): void {
    // Despawn: the entity left the mirror, or its emitter row is gone.
    for (const [wid, l] of this.live) {
      if (!state.entities.get(wid)?.vfxEmitter) this.despawn(wid, l);
    }
    for (const [wid, e] of state.entities) {
      const row = e.vfxEmitter;
      if (!row) continue;
      const template = row.template >>> 0;
      let l = this.live.get(wid);
      if (l && l.template !== template) {
        this.despawn(wid, l);
        l = undefined;
      }
      if (!l) {
        const effect = this.registry.get(template);
        if (!effect) continue; // unbundled content: skip, never guess
        const anchor = new THREE.Object3D();
        anchor.name = `emitter-${effect.id}`;
        this.group.add(anchor);
        l = {
          anchor,
          handle: this.quarks.attachEffect(effect, anchor, row.intensity),
          template,
          intensity: row.intensity,
        };
        this.live.set(wid, l);
      }
      if (e.transform) l.anchor.position.set(e.transform.px, e.transform.py, e.transform.pz);
      if (l.intensity !== row.intensity) {
        l.handle.setIntensity(row.intensity);
        l.intensity = row.intensity;
      }
    }
  }

  dispose(): void {
    for (const [wid, l] of [...this.live]) this.despawn(wid, l);
  }

  private despawn(wid: bigint, l: LiveEmitter): void {
    l.handle.dispose();
    this.group.remove(l.anchor);
    this.live.delete(wid);
  }
}
