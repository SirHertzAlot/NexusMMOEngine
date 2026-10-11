/**
 * TDD: First-person camera — the sibling of followCamera.
 *
 * Same yaw/pitch convention as the third-person follow camera
 * (yaw 0 faces +Z; positive pitch from mouse-up looks down, matching the
 * follow cam's feel so the toggle never inverts controls). The camera
 * sits at the eye point and looks along the view direction.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { firstPersonCamera, EYE_HEIGHT } from "../src/render/first-person-camera.js";

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
});
