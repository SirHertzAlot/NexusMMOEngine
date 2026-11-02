#!/usr/bin/env node
/**
 * Parity check: JoltPhysics.js (WASM, in the client) against the server's
 * native Jolt addon (packages/addons/physics). Same scene, same inputs, same
 * call order: a static floor, N dynamic spheres and boxes with varying mass,
 * friction and restitution, dropped and nudged, stepped at 60 Hz with two
 * collision substeps (one Update per substep, as the addon does it).
 *
 * Reports how far the two positions and rotations drift apart over time, and
 * whether each side repeats itself bit for bit across two fresh runs.
 *
 *   node scripts/physics-parity.mjs [--seconds 10] [--bodies 60] [--out file.json]
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const DT = 1 / 60;
const SUBSTEPS = 2;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Deterministic scene spec, shared by both sides. Index order is insertion order. */
export function sceneSpec(bodies) {
  let seed = 987654321;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const list = [];
  list.push({ kind: "box", motion: "static", half: [50, 0.5, 50], pos: [0, -0.5, 0], quat: [0, 0, 0, 1],
    mass: 0, friction: 0.6, restitution: 0.1, linVel: [0, 0, 0], angVel: [0, 0, 0], layer: 0 });
  for (let i = 0; i < bodies; i++) {
    const sphere = i % 2 === 0;
    const size = 0.25 + rnd() * 0.25;
    list.push({
      kind: sphere ? "sphere" : "box",
      motion: "dynamic",
      half: [size, size * 0.8, size * 1.1],
      radius: size,
      pos: [(rnd() - 0.5) * 12, 1.5 + rnd() * 6 + i * 0.05, (rnd() - 0.5) * 12],
      quat: normalise([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 1]),
      mass: 0.5 + rnd() * 4,
      friction: 0.3 + rnd() * 0.5,
      restitution: rnd() * 0.3,
      linVel: [(rnd() - 0.5) * 2, 0, (rnd() - 0.5) * 2],
      angVel: [(rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3],
      layer: 1,
    });
  }
  return list;
}

function normalise([x, y, z, w]) {
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}

// ---------------------------------------------------------------- native

export function runNative(spec, seconds) {
  const addon = require(join(here, "../../../packages/addons/physics/index.js"));
  const world = addon.createWorld({ threads: 0 });
  const n = spec.length;
  const ids = new BigUint64Array(n);
  const shape = new Uint8Array(n);
  const half = new Float32Array(3 * n);
  const radius = new Float32Array(n);
  const mass = new Float32Array(n);
  const friction = new Float32Array(n);
  const restitution = new Float32Array(n);
  const motion = new Uint8Array(n);
  const layer = new Uint8Array(n);
  const pos = new Float32Array(3 * n);
  const quat = new Float32Array(4 * n);
  const lin = new Float32Array(3 * n);
  const ang = new Float32Array(3 * n);
  spec.forEach((b, i) => {
    ids[i] = BigInt(i + 1);
    shape[i] = b.kind === "box" ? addon.ShapeKind.Box : addon.ShapeKind.Sphere;
    half.set(b.half, 3 * i);
    radius[i] = b.radius ?? 0;
    mass[i] = b.mass;
    friction[i] = b.friction;
    restitution[i] = b.restitution;
    motion[i] = b.motion === "static" ? addon.MotionType.Static : addon.MotionType.Dynamic;
    layer[i] = b.layer;
    pos.set(b.pos, 3 * i);
    quat.set(b.quat, 4 * i);
    lin.set(b.linVel, 3 * i);
    ang.set(b.angVel, 3 * i);
  });
  world.addBodies({ count: n, entityIds: ids, shapeKind: shape, halfExtents: half, radius, mass, friction,
    restitution, motionType: motion, layer, pos, quat, linVel: lin, angVel: ang });
  const eids = new Int32Array(n);
  for (let i = 0; i < n; i++) eids[i] = i;
  const out = Array.from({ length: 7 }, () => new Float32Array(n));
  const ang2 = Array.from({ length: 3 }, () => new Float32Array(n));
  const frames = [];
  const steps = Math.round(seconds / DT);
  for (let f = 1; f <= steps; f++) {
    world.step(DT, SUBSTEPS);
    if (f % 60 === 0) {
      world.copyResults(n, ids, eids, out[0], out[1], out[2], out[3], out[4], out[5], out[6],
        ang2[0], ang2[1], ang2[2], ang2[0], ang2[1], ang2[2]);
      frames.push({ t: f * DT, p: [out[0].slice(), out[1].slice(), out[2].slice()], q: [out[3].slice(), out[4].slice(), out[5].slice(), out[6].slice()] });
    }
  }
  world.destroy();
  return frames;
}

// ---------------------------------------------------------------- JS

export async function runJs(spec, seconds) {
  const Jolt = (await import("jolt-physics/wasm-compat")).default;
  const J = await Jolt();
  const pairFilter = new J.ObjectLayerPairFilterTable(2);
  pairFilter.EnableCollision(0, 1);
  pairFilter.EnableCollision(1, 1);
  const bp = new J.BroadPhaseLayerInterfaceTable(2, 2);
  bp.MapObjectToBroadPhaseLayer(0, new J.BroadPhaseLayer(0));
  bp.MapObjectToBroadPhaseLayer(1, new J.BroadPhaseLayer(1));
  const vs = new J.ObjectVsBroadPhaseLayerFilterTable(bp, 2, pairFilter, 2);
  const settings = new J.JoltSettings();
  settings.mMaxBodies = 65536;
  settings.mMaxBodyPairs = 65536;
  settings.mMaxContactConstraints = 10240;
  settings.mBroadPhaseLayerInterface = bp;
  settings.mObjectVsBroadPhaseLayerFilter = vs;
  settings.mObjectLayerPairFilter = pairFilter;
  const jolt = new J.JoltInterface(settings);
  const system = jolt.GetPhysicsSystem();
  system.SetGravity(new J.Vec3(0, -9.81, 0));
  const bi = system.GetBodyInterface();
  const ids = spec.map((b) => {
    const shape = b.kind === "box"
      ? new J.BoxShapeSettings(new J.Vec3(...b.half), 0.05).Create().Get()
      : new J.SphereShapeSettings(b.radius).Create().Get();
    const motion = b.motion === "static" ? J.EMotionType_Static : J.EMotionType_Dynamic;
    const s = new J.BodyCreationSettings(shape, new J.RVec3(...b.pos), new J.Quat(...b.quat), motion,
      b.layer);
    s.mFriction = b.friction;
    s.mRestitution = b.restitution;
    s.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia;
    s.mMassPropertiesOverride.mMass = b.mass > 0 ? b.mass : 1;
    const body = bi.CreateBody(s);
    J.destroy(s);
    bi.AddBody(body.GetID(), J.EActivation_Activate);
    bi.SetLinearVelocity(body.GetID(), new J.Vec3(...b.linVel));
    bi.SetAngularVelocity(body.GetID(), new J.Vec3(...b.angVel));
    return body.GetID();
  });
  const frames = [];
  const steps = Math.round(seconds / DT);
  for (let f = 1; f <= steps; f++) {
    // Two Updates with one collision step each, as the addon's step() does.
    for (let s = 0; s < SUBSTEPS; s++) jolt.Step(DT / SUBSTEPS, 1);
    if (f % 60 === 0) {
      const p = [[], [], []], q = [[], [], [], []];
      for (const id of ids) {
        const pos = bi.GetPosition(id);
        const rot = bi.GetRotation(id);
        p[0].push(pos.GetX()); p[1].push(pos.GetY()); p[2].push(pos.GetZ());
        q[0].push(rot.GetX()); q[1].push(rot.GetY()); q[2].push(rot.GetZ()); q[3].push(rot.GetW());
      }
      frames.push({ t: f * DT, p: p.map((a) => Float32Array.from(a)), q: q.map((a) => Float32Array.from(a)) });
    }
  }
  return frames;
}

// ---------------------------------------------------------------- compare

export function compare(a, b) {
  return a.map((fa, k) => {
    const fb = b[k];
    let maxPos = 0, maxRot = 0, sumPos = 0, count = 0, bitIdentical = true;
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < fa.p[axis].length; i++) {
        const d = Math.abs(fa.p[axis][i] - fb.p[axis][i]);
        if (!Number.isFinite(d)) continue;
        maxPos = Math.max(maxPos, d); sumPos += d; count++;
        if (fa.p[axis][i] !== fb.p[axis][i]) bitIdentical = false;
      }
    }
    for (let axis = 0; axis < 4; axis++) {
      for (let i = 0; i < fa.q[axis].length; i++) {
        // Rotations q and -q are the same orientation.
        const d1 = Math.abs(fa.q[axis][i] - fb.q[axis][i]);
        const d2 = Math.abs(fa.q[axis][i] + fb.q[axis][i]);
        maxRot = Math.max(maxRot, Math.min(d1, d2));
      }
    }
    return { t: fa.t, maxPosM: maxPos, meanPosM: sumPos / count, maxRotDiff: maxRot, bitIdentical };
  });
}

/** Stable fingerprint of the frames, to check that one side repeats itself. */
export function fingerprint(frames) {
  let h = 2166136261 >>> 0;
  for (const f of frames) for (const arr of [...f.p, ...f.q]) {
    const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
    for (const v of u) h = Math.imul(h ^ v, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function main() {
  const seconds = Number(arg("seconds", 10));
  const bodies = Number(arg("bodies", 60));
  const out = arg("out", null);
  const spec = sceneSpec(bodies);
  const native1 = runNative(spec, seconds);
  const native2 = runNative(spec, seconds);
  const js1 = await runJs(spec, seconds);
  const js2 = await runJs(spec, seconds);
  const result = {
    seconds, bodies, dt: DT, substeps: SUBSTEPS,
    nativeRepeatable: fingerprint(native1) === fingerprint(native2),
    jsRepeatable: fingerprint(js1) === fingerprint(js2),
    drift: compare(native1, js1),
    fingerprints: { native: fingerprint(native1), js: fingerprint(js1) },
  };
  const json = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, json);
  process.stdout.write(json + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(String(e?.stack ?? e) + "\n");
    process.exit(1);
  });
}
