/**
 * PhysicalSky — the high presets' sky: Eric Bruneton's precomputed
 * atmospheric scattering (@takram/three-atmosphere), fitted to our world.
 *
 * - The sky: takram's SkyMaterial, drawn where DaySky's keyframed dome
 *   would be (DaySky hides its dome while this runs). Rayleigh and Mie
 *   scattering give the real gradients: a deep zenith, a pale horizon, a
 *   glowing sun, red sunsets, a blue twilight. Our star field still draws
 *   over it at night.
 * - Aerial perspective: distant terrain fades into the sky's own colour
 *   (the light scattered along each view ray), replacing the flat fog.
 *
 * Fitting it to us:
 *
 * - Frame: takram works on the Earth (ECEF, metres). Our world sits on it
 *   at one latitude and longitude, x east, y up, z south, so
 *   `worldToECEF` maps our metres onto the ellipsoid there.
 * - Time: the sun is ours. DaySky's time of day gives its direction,
 *   rotated into ECEF; takram's date-based sun is not used.
 * - Brightness: takram's radiance is physical and dim next to our lit
 *   scene (colours near 0..1). The sky is scaled by `exposure` in its
 *   shader. Aerial perspective runs between two scale effects (÷ exposure
 *   before, × exposure after), so the haze it adds is in the sky's scale
 *   and the scene's own colours pass through unchanged.
 * - Assets: nothing is fetched. The scattering tables are computed on the
 *   GPU at start (PrecomputedTexturesGenerator); until they're ready the
 *   classic sky stays.
 *
 * Volumetric clouds (@takram/three-clouds) were tried and left out: they
 * rendered no clouds and a dark band at the horizon in this setup, and
 * need testing on real GPUs first.
 */

import * as THREE from "three";
import { BlendFunction, Effect } from "postprocessing";
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, SkyMaterial, type PrecomputedTextures } from "@takram/three-atmosphere";
import { Ellipsoid, Geodetic } from "@takram/three-geospatial";

export interface PhysicalSkyOptions {
  /** Where on Earth the world sits (degrees): sets the sun's arc and the atmosphere's thickness above. */
  latitude?: number;
  longitude?: number;
  /** Sky brightness scale (see above). */
  exposure?: number;
}

/** Multiply the image by a constant: the brackets around aerial perspective. */
class ScaleEffect extends Effect {
  constructor(name: string, scale: number) {
    super(name, "uniform float scale;\nvoid mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(inputColor.rgb * scale, inputColor.a); }", {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([["scale", new THREE.Uniform(scale)]]),
    });
  }

  set scale(v: number) {
    this.uniforms.get("scale")!.value = v;
  }
}

/** Our world (x east, y up, z south, metres) onto the ellipsoid at a latitude and longitude. */
export function worldToECEF(latitude: number, longitude: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const origin = new Geodetic(THREE.MathUtils.degToRad(longitude), THREE.MathUtils.degToRad(latitude), 0).toECEF();
  const enu = Ellipsoid.WGS84.getEastNorthUpFrame(origin); // local east, north, up → ECEF
  // Ours → ENU: x → east, y → up, z → south (−north).
  const axes = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  return out.multiplyMatrices(enu, axes);
}

export class PhysicalSky {
  /** Add this to the scene: the sky, drawn behind everything. */
  readonly dome: THREE.Mesh;
  /** The screen effects, in order: put them in the composer. */
  readonly effects: Effect[];
  readonly aerial: AerialPerspectiveEffect;
  /** Ready once the scattering tables are computed (until then, keep the classic sky). */
  ready = false;
  private readonly material: SkyMaterial;
  private readonly frame: THREE.Matrix4;
  private readonly sunEcef = new THREE.Vector3();
  private readonly pre: ScaleEffect;
  private readonly post: ScaleEffect;
  private readonly exposureUniform: { value: number };
  private generator: PrecomputedTexturesGenerator | null;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, camera: THREE.Camera, o: PhysicalSkyOptions = {}) {
    const exposure = o.exposure ?? 10;
    this.frame = worldToECEF(o.latitude ?? 42, o.longitude ?? 12);
    this.exposureUniform = { value: exposure };

    this.material = new SkyMaterial({ moon: false, ground: true });
    // Scale the sky's radiance into our scene's range, in its own shader.
    const base = this.material.onBeforeCompile.bind(this.material);
    const exposureUniform = this.exposureUniform;
    this.material.onBeforeCompile = (p, r) => {
      p.uniforms.skyExposure = exposureUniform;
      p.fragmentShader = p.fragmentShader
        .replace("void main()", "uniform float skyExposure;\nvoid main()")
        .replace("#include <mrt_output>", "outputColor.rgb *= skyExposure;\n  #include <mrt_output>");
      base(p, r);
    };
    this.material.customProgramCacheKey = () => "mmo-physical-sky";
    this.material.worldToECEFMatrix.copy(this.frame);
    this.dome = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.dome.name = "physical-sky";
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.visible = false;

    this.aerial = new AerialPerspectiveEffect(camera, { sky: false, sunLight: false, skyLight: false, transmittance: true, inscatter: true });
    this.aerial.worldToECEFMatrix.copy(this.frame);
    this.pre = new ScaleEffect("SkyExposureIn", 1 / exposure);
    this.post = new ScaleEffect("SkyExposureOut", exposure);
    this.effects = [this.pre, this.aerial, this.post];

    this.generator = new PrecomputedTexturesGenerator(renderer);
    void this.generator
      .update()
      .then((textures) => {
        if (this.disposed) return;
        this.setTextures(textures);
        this.ready = true;
        this.dome.visible = true;
      })
      .catch((e: unknown) => console.warn(`[sky] physical sky unavailable: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The sun, as a unit vector in our world (from DaySky's time of day). */
  setSun(worldDir: THREE.Vector3): void {
    this.sunEcef.copy(worldDir).transformDirection(this.frame);
    this.material.sunDirection.copy(this.sunEcef);
    this.aerial.sunDirection.copy(this.sunEcef);
  }

  set exposure(v: number) {
    this.exposureUniform.value = v;
    this.pre.scale = 1 / v;
    this.post.scale = v;
  }

  dispose(): void {
    this.disposed = true;
    this.dome.removeFromParent();
    this.dome.geometry.dispose();
    this.material.dispose();
    for (const e of this.effects) e.dispose();
    this.generator?.dispose();
    this.generator = null;
  }

  private setTextures(t: PrecomputedTextures): void {
    for (const target of [this.material, this.aerial] as const) {
      target.irradianceTexture = t.irradianceTexture;
      target.scatteringTexture = t.scatteringTexture;
      target.transmittanceTexture = t.transmittanceTexture;
      target.singleMieScatteringTexture = t.singleMieScatteringTexture ?? null;
      target.higherOrderScatteringTexture = t.higherOrderScatteringTexture ?? null;
    }
  }

}
