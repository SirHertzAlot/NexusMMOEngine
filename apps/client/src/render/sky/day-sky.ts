/**
 * DaySky — the sky dome, the sun (and moon) light, the sky light, and the
 * haze colour, all set from one time of day, and the stars at night
 * (star-field.ts).
 *
 * The dome is a large sphere drawn behind everything at the far plane; its
 * shader draws a zenith-to-horizon gradient, a sun disc with glow (bright
 * enough for bloom), and horizon haze in the fog colour; the stars are
 * their own layer in front of it.
 * The scene fog takes the same colour as the haze, so far terrain fades
 * into the horizon seamlessly at every hour.
 *
 * The dome (sky-glsl.ts) is adapted from ProceduralTerrains'
 * proceduralSkyGLSL.js and ProceduralSky.js (MIT, © 2026 ZyFou; see THIRD_PARTY_NOTICES.md),
 * writing linear colour through three's colour-space chunk instead of a
 * hand-applied gamma, so it is correct with and without postprocessing.
 */

import * as THREE from "three";
import { createSkyUniforms, SKY_EVAL_GLSL, SKY_UNIFORMS_GLSL, type SkyUniforms } from "./sky-glsl.js";
import { StarField } from "./star-field.js";
import { evaluateTimeOfDay, sunDirection, type TimeOfDayLook } from "./time-of-day.js";
import { setToonDay, toonDayFromSun } from "../toon/toon-material.js";

/** Light scale: noon (light 1.5, ambient 0.5) matches the fixed lighting the client had before. */
const SUN_SCALE = 1.6 / 1.5;
const SKY_LIGHT_SCALE = 0.9 / 0.5;
/** Night floor: moonlight, so the world stays readable. */
const MOON_LIGHT = 0.28;
const MOON_COLOR = new THREE.Color(0.55, 0.62, 0.85);
const MIN_SKY_LIGHT = 0.32;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  // The dome follows the camera and sits on the far plane.
  gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  gl_Position.z = gl_Position.w * 0.9999;
}
`;

const SKY_FRAGMENT = /* glsl */ `
${SKY_UNIFORMS_GLSL}
${SKY_EVAL_GLSL}
varying vec3 vDirection;

void main() {
  // No hashed stars on the dome: the StarField draws them.
  gl_FragColor = vec4(evaluateSky(vDirection, 1.0, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class DaySky {
  /** The dome and both lights: add it to the scene. */
  readonly group = new THREE.Group();
  /** Direct light: the sun by day, the moon (opposite it) by night. */
  readonly sunLight = new THREE.DirectionalLight(0xffffff, 1);
  readonly skyLight = new THREE.HemisphereLight(0xbdd4ff, 0x2a2118, 0.9);
  /** The night sky: call `stars.setFrame` each frame for its size and twinkle. */
  readonly stars = new StarField();
  /** The current look (after the last update). */
  look: TimeOfDayLook = evaluateTimeOfDay(0.5);
  private readonly dome: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  /** The sky's uniforms: the water binds the same objects to reflect this sky. */
  readonly uniforms: SkyUniforms = createSkyUniforms();
  /** Unit vector toward the sun at the time last set (physical-sky.ts follows it). */
  readonly sunDir = new THREE.Vector3();

  constructor() {
    this.group.name = "day-sky";
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.IcosahedronGeometry(1000, 4), this.material);
    this.dome.name = "sky-dome";
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    this.group.add(this.dome, this.stars.mesh, this.sunLight, this.skyLight);
  }

  /** Set the sky, the lights, and the haze for a time of day (0..1, 0 = midnight). */
  update(time: number, fog: THREE.Fog | null): void {
    const look = evaluateTimeOfDay(time);
    this.look = look;
    const dir = sunDirection(look, this.sunDir);
    const u = this.uniforms;
    u.uZenith.value.setRGB(...look.zenith);
    u.uHorizon.value.setRGB(...look.horizon);
    u.uSunColor.value.setRGB(...look.sunColor);
    u.uFogColor.value.setRGB(...look.fogColor);
    u.uSunDir.value.copy(dir);
    u.uLight.value = look.lightIntensity;
    this.stars.update(time, dir.y, u.uStars.value);
    // Toon shadows take their night colours as the sun sets.
    setToonDay(toonDayFromSun(dir.y));

    // Direct light: the sun above the horizon, the moon below it.
    const sunUp = THREE.MathUtils.smoothstep(dir.y, -0.05, 0.08);
    const sunLight = look.lightIntensity * SUN_SCALE;
    if (sunUp > 0.5) {
      this.sunLight.position.copy(dir).multiplyScalar(100);
      this.sunLight.color.setRGB(...look.sunColor);
      this.sunLight.intensity = Math.max(sunLight, MOON_LIGHT);
    } else {
      this.sunLight.position.copy(dir).multiplyScalar(-100);
      this.sunLight.color.copy(MOON_COLOR);
      this.sunLight.intensity = MOON_LIGHT;
    }
    this.skyLight.intensity = Math.max(look.ambientIntensity * SKY_LIGHT_SCALE, MIN_SKY_LIGHT);
    if (fog) fog.color.setRGB(...look.fogColor);
  }

  /** Hide the keyframed dome (the physical sky draws the sky instead); stars, lights and haze stay. */
  setDomeVisible(v: boolean): void {
    this.dome.visible = v;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.dome.geometry.dispose();
    this.material.dispose();
    this.stars.dispose();
    this.sunLight.dispose();
    this.skyLight.dispose();
  }
}
