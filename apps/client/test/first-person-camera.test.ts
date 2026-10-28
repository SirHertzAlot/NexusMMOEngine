/**
 * TDD: First-person camera — the sibling of followCamera, with DoD
 * biomechanical breathing, stride head-bob, landing spring, skeletal head
 * bone coupling, and combat move camera impulses.
 *
 * Same yaw/pitch convention as the third-person follow camera
 * (yaw 0 faces +Z; positive pitch from mouse-up looks down, matching the
 * follow cam's feel so the toggle never inverts controls). The camera
 * sits at the eye point and looks along the view direction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { LocomotionMode, Move } from "@mmo-engine/protocol";
import {
  firstPersonCamera,
  EYE_HEIGHT,
  createFirstPersonCameraState,
  stepFirstPersonMotion,
  computeCombatCameraImpulse,
} from "../src/render/first-person-camera.js";

const approx = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe("firstPersonCamera", () => {
  it("sits at the eye and looks toward +Z at yaw 0, pitch 0", () => {
    const camera = new THREE.PerspectiveCamera();
    const eye = new THREE.Vector3(10, 11.6, 20);
    firstPersonCamera(camera, eye, 0, 0);
    assert.ok(approx(camera.position.x, 10));
    assert.ok(approx(camera.position.y, 11.6));
    assert.ok(approx(camera.position.z, 20));
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(fwd.z > 0.99, `looking +Z, got ${fwd.toArray()}`);
    assert.ok(Math.abs(fwd.y) < 1e-9);
  });

  it("yaw π/2 looks toward +X", () => {
    const camera = new THREE.PerspectiveCamera();
    firstPersonCamera(camera, new THREE.Vector3(0, 1.6, 0), Math.PI / 2, 0);
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(fwd.x > 0.99, `looking +X, got ${fwd.toArray()}`);
  });

  it("positive pitch looks down, matching the follow camera's feel", () => {
    const camera = new THREE.PerspectiveCamera();
    firstPersonCamera(camera, new THREE.Vector3(0, 1.6, 0), 0, 0.5);
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(fwd.y < -0.4, `looking down, got ${fwd.toArray()}`);
    assert.ok(fwd.z > 0.8);
  });

  it("negative pitch looks up", () => {
    const camera = new THREE.PerspectiveCamera();
    firstPersonCamera(camera, new THREE.Vector3(0, 1.6, 0), 0, -0.5);
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    assert.ok(fwd.y > 0.4, `looking up, got ${fwd.toArray()}`);
  });

  it("null eye leaves the camera alone (caller falls back)", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    firstPersonCamera(camera, null, 0, 0);
    assert.ok(approx(camera.position.x, 1));
    assert.ok(approx(camera.position.y, 2));
    assert.ok(approx(camera.position.z, 3));
  });

  it("EYE_HEIGHT is a sensible eye offset", () => {
    assert.ok(EYE_HEIGHT > 1.2 && EYE_HEIGHT < 2.0, `EYE_HEIGHT=${EYE_HEIGHT}`);
  });

  it("produces smooth idle breathing oscillation when stationary", () => {
    const state = createFirstPersonCameraState();
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 120; i++) {
      const m = stepFirstPersonMotion(state, { dt: 1 / 30, vx: 0, vy: 0, vz: 0, grounded: true });
      if (m.up < minY) minY = m.up;
      if (m.up > maxY) maxY = m.up;
    }
    assert.ok(maxY - minY > 0.015, `idle breathing vertical span=${maxY - minY}`);
    assert.ok(state.bobWeight < 0.01, "bobWeight stays near zero at rest");
  });

  it("produces figure-8 stride head-bob and roll tilt during walking and running", () => {
    const state = createFirstPersonCameraState();
    const camera = new THREE.PerspectiveCamera();
    const eye = new THREE.Vector3(0, EYE_HEIGHT, 0);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxAbsRoll = 0;
    for (let i = 0; i < 60; i++) {
      const m = stepFirstPersonMotion(state, {
        dt: 1 / 60,
        vx: 0,
        vy: 0,
        vz: 6.0,
        mode: LocomotionMode.Ground,
        grounded: true,
      });
      firstPersonCamera(camera, eye, 0, 0, m);
      if (camera.position.x < minX) minX = camera.position.x;
      if (camera.position.x > maxX) maxX = camera.position.x;
      if (camera.position.y < minY) minY = camera.position.y;
      if (camera.position.y > maxY) maxY = camera.position.y;
      if (Math.abs(m.roll) > maxAbsRoll) maxAbsRoll = Math.abs(m.roll);
    }
    assert.ok(state.bobWeight > 0.85, `bobWeight=${state.bobWeight}`);
    assert.ok(maxX - minX > 0.03, `lateral sway span=${maxX - minX}`);
    assert.ok(maxY - minY > 0.04, `vertical bob span=${maxY - minY}`);
    assert.ok(maxAbsRoll > 0.008, `roll tilt=${maxAbsRoll}`);
  });

  it("dips and recovers with a critically-damped spring on landing from a jump", () => {
    const state = createFirstPersonCameraState();
    // Airborne falling downward
    stepFirstPersonMotion(state, { dt: 1 / 60, vy: -6.0, grounded: false, mode: LocomotionMode.Ground });
    // Touchdown frame
    stepFirstPersonMotion(state, { dt: 1 / 60, vy: 0, grounded: true, mode: LocomotionMode.Ground });
    let lowestUp = 0;
    for (let i = 0; i < 20; i++) {
      const m = stepFirstPersonMotion(state, { dt: 1 / 60, vy: 0, grounded: true, mode: LocomotionMode.Ground });
      if (m.up < lowestUp) lowestUp = m.up;
    }
    assert.ok(lowestUp < -0.04, `landing dip reached ${lowestUp}`);
    // Settle back after 1 second
    for (let i = 0; i < 60; i++) {
      stepFirstPersonMotion(state, { dt: 1 / 60, vy: 0, grounded: true, mode: LocomotionMode.Ground });
    }
    assert.ok(Math.abs(state.landOffset) < 0.01, `spring settled to ${state.landOffset}`);
  });

  it("couples combat move impulses (SwordA, SwordB, SwordC, Guard, ShieldBash, Roll) and skeletal Head bone offset", () => {
    const aWind = computeCombatCameraImpulse(Move.SwordA, 0.08);
    const aHit = computeCombatCameraImpulse(Move.SwordA, 0.22);
    assert.ok(aWind.forward < 0, "SwordA wind-up pulls back");
    assert.ok(aHit.forward > 0.05, "SwordA strike lunges forward");

    const bHit = computeCombatCameraImpulse(Move.SwordB, 0.25);
    assert.ok(bHit.forward > 0.05 && bHit.right > 0, "SwordB cleaves right and forward");

    const cWind = computeCombatCameraImpulse(Move.SwordC, 0.2);
    const cSlam = computeCombatCameraImpulse(Move.SwordC, 0.45);
    assert.ok(cWind.up > 0.03 && cWind.pitch < 0, "SwordC wind-up lifts camera");
    assert.ok(cSlam.up < -0.05 && cSlam.forward > 0.08 && cSlam.pitch > 0, "SwordC slams down and forward");

    const guard = computeCombatCameraImpulse(Move.Guard, 0.3);
    assert.ok(guard.up < -0.03, "Guard lowers stance");

    const bash = computeCombatCameraImpulse(Move.ShieldBash, 0.2);
    assert.ok(bash.forward > 0.08, "ShieldBash rams forward");

    const roll = computeCombatCameraImpulse(Move.Roll, 0.7);
    assert.ok(roll.up < -0.35, "Roll tucks eye height down");

    // Skeletal head bone offset coupling
    const state = createFirstPersonCameraState();
    const sample = stepFirstPersonMotion(state, {
      dt: 0,
      headBoneOffset: { x: 0.1, y: -0.1, z: 0.2 },
    });
    assert.ok(sample.forward > 0.05);
    assert.ok(sample.up < -0.02);
  });
});
