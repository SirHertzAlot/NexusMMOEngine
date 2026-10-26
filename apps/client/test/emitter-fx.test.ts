/**
 * EmitterFx: the client's half of the VfxEmitter wiring.
 *
 * - Hash agreement: the registry keys built from the real shrine
 *   effect documents (content/vfx/) equal the template hashes the
 *   server computes with @mmo-engine/scatter's fnv1a32 — pinned as
 *   goldens, the same values the server-side scene spawn writes into
 *   VfxEmitter.template (the fire value also appears in the demo boot
 *   log, DEMO.md).
 * - Lifecycle: a stub QuarksFx records attach/setIntensity/dispose
 *   while EmitterFxLayer reconciles MirrorState: spawn on row,
 *   in-place intensity updates, respawn on template change, despawn
 *   on entity loss, silence for unknown templates.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MirrorState } from "@mmo-engine/mirror";
import type { CollectedState, TransformRow, VfxEmitterRow } from "@mmo-engine/protocol";
import type { VfxEffect } from "@mmo-engine/art/browser";
import {
  buildEmitterRegistry,
  emitterTemplateHash,
  EmitterFxLayer,
} from "../src/render/emitter-fx.js";
import type { EffectHandle, QuarksFx } from "../src/render/vfx/quarks-fx.js";

/** fnv1a32 goldens, computed with the server's @mmo-engine/scatter fnv1a32. */
const GOLDENS: Record<string, number> = {
  "shrine-fire": 4098966889,
  "shrine-water": 2453196608,
  "shrine-earth": 4285717863,
  "shrine-wind": 2658217431,
  "shrine-darkness": 3089615354,
};

function shrineDocs(): unknown[] {
  return Object.keys(GOLDENS).map((id) =>
    JSON.parse(readFileSync(new URL(`../../../../content/vfx/${id}.json`, import.meta.url), "utf8")),
  );
}

test("registry keys agree with the server's template hashes for all five shrines", () => {
  const registry = buildEmitterRegistry(shrineDocs());
  assert.equal(registry.size, 5);
  for (const [id, golden] of Object.entries(GOLDENS)) {
    assert.equal(emitterTemplateHash(id), golden, `client fnv1a32(${id})`);
    assert.equal(registry.get(golden)?.id, id, `registry resolves ${id}`);
  }
});

// ------------------------------------------------------------- lifecycle

const SHRINE = 0x2001n;

function transform(wireId: bigint, x: number, y: number, z: number): TransformRow {
  return { wireId, px: x, py: y, pz: z, qx: 0, qy: 0, qz: 0, qw: 1, sx: 1, sy: 1, sz: 1 };
}

function state(tick: number, patch: Partial<CollectedState>): CollectedState {
  return {
    tick, baseTick: 0,
    transforms: [], velocities: [], intents: [], chunks: [], healths: [],
    staminas: [], characterRefs: [], bodies: [], assets: [], locomotions: [],
    appearances: [], actions: [], animations: [], vfxEmitters: [],
    spawned: [], despawned: [],
    ...patch,
  };
}

interface AttachCall {
  effect: VfxEffect;
  intensity: number;
  intensities: number[];
  disposed: boolean;
}

class StubQuarks {
  readonly calls: AttachCall[] = [];
  attachEffect(effect: VfxEffect, _target: unknown, intensity: number): EffectHandle {
    const call: AttachCall = { effect, intensity, intensities: [], disposed: false };
    this.calls.push(call);
    return {
      systems: [],
      setIntensity: (k: number) => call.intensities.push(k),
      dispose: () => { call.disposed = true; },
    };
  }
}

function setup(): { layer: EmitterFxLayer; stub: StubQuarks; mirror: MirrorState } {
  const stub = new StubQuarks();
  const layer = new EmitterFxLayer(stub as unknown as QuarksFx, buildEmitterRegistry(shrineDocs()));
  return { layer, stub, mirror: new MirrorState() };
}

const fireRow = (intensity: number): VfxEmitterRow =>
  ({ wireId: SHRINE, template: GOLDENS["shrine-fire"], intensity });

test("row appears -> effect spawns at the transform; intensity change rescales in place", () => {
  const { layer, stub, mirror } = setup();
  mirror.applySnapshot(state(1, {
    transforms: [transform(SHRINE, 216, 49, -256)],
    vfxEmitters: [fireRow(1.5)],
  }));
  layer.sync(mirror);
  assert.equal(layer.count, 1);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].effect.id, "shrine-fire");
  assert.equal(stub.calls[0].intensity, 1.5);
  assert.equal(layer.group.children.length, 1);
  assert.deepEqual(
    layer.group.children[0].position.toArray(),
    [216, 49, -256],
  );

  // Same row again: no respawn, no rescale.
  layer.sync(mirror);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].intensities, []);

  // Intensity change rides a delta: rescale, don't respawn.
  mirror.applyDelta(state(2, { vfxEmitters: [fireRow(2.5)] }));
  layer.sync(mirror);
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(stub.calls[0].intensities, [2.5]);
  assert.equal(stub.calls[0].disposed, false);
});

test("template change respawns; despawn disposes; unknown template is skipped", () => {
  const { layer, stub, mirror } = setup();
  mirror.applySnapshot(state(1, {
    transforms: [transform(SHRINE, 216, 49, -256)],
    vfxEmitters: [fireRow(1)],
  }));
  layer.sync(mirror);
  assert.equal(layer.count, 1);

  mirror.applyDelta(state(2, {
    vfxEmitters: [{ wireId: SHRINE, template: GOLDENS["shrine-darkness"], intensity: 1 }],
  }));
  layer.sync(mirror);
  assert.equal(stub.calls.length, 2);
  assert.equal(stub.calls[0].disposed, true);
  assert.equal(stub.calls[1].effect.id, "shrine-darkness");
  assert.equal(layer.count, 1);

  mirror.applyDelta(state(3, { despawned: [SHRINE] }));
  layer.sync(mirror);
  assert.equal(layer.count, 0);
  assert.equal(stub.calls[1].disposed, true);
  assert.equal(layer.group.children.length, 0);

  // A template the client doesn't bundle: no spawn, no throw.
  const OTHER = 0x2002n;
  mirror.applySnapshot(state(4, {
    transforms: [transform(OTHER, 0, 0, 0)],
    vfxEmitters: [{ wireId: OTHER, template: 424242, intensity: 1 }],
  }));
  layer.sync(mirror);
  assert.equal(layer.count, 0);
  assert.equal(stub.calls.length, 2);
});
