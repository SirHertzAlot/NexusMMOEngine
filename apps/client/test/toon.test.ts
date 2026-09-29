/**
 * Toon shading: the material patch (onto three's own physical shader,
 * after any patch the material already has), the ramp, the day/night
 * fade, the outline's smoothed normals and skinned hull, and the Gran
 * Turismo tone curve.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CharacterMaterial } from "../src/render/character/character-material.js";
import {
  applyToon, defaultToonRamp, setToonDay, TOON_GLOBALS, TOON_ROWS, toonDayFromSun, toonOf,
} from "../src/render/toon/toon-material.js";
import { addOutline, OutlineMaterial, smoothNormals } from "../src/render/toon/outline.js";
import { GT_DEFAULTS, gtTonemap } from "../src/render/effects/gt-tonemap-effect.js";

const physical = (): { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string } => ({
  uniforms: {},
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
});
const compile = (m: THREE.Material, shader = physical()) => {
  m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
  return shader;
};

describe("applyToon", () => {
  it("swaps three's direct lighting for the toon's, keeping the rest of the shader", () => {
    const m = new THREE.MeshStandardMaterial();
    applyToon(m);
    const s = compile(m);
    assert.match(s.fragmentShader, /#define RE_Direct RE_Direct_Toon/);
    assert.ok(s.fragmentShader.indexOf("RE_Direct_Physical") < s.fragmentShader.indexOf("#define RE_Direct RE_Direct_Toon"), "after the physical chunk's own define");
    assert.ok(s.fragmentShader.includes("#include <lights_fragment_begin>"), "three still runs its light loop");
    assert.ok(s.fragmentShader.includes("uToonRim"), "the rim is added before the output");
    assert.equal(s.uniforms.uToonDay, TOON_GLOBALS.uToonDay, "day is shared by every toon material");
    assert.equal(s.uniforms.uToonRow.value, TOON_ROWS.indexOf("cloth"));
    assert.ok(!/#define TOON_(LIGHTMAP|FACE|MATCAP)/.test(s.fragmentShader), "optional parts off without their maps");
  });

  it("runs after the material's own patch, and is applied once", () => {
    const t = { base: new THREE.Texture(), masks: [0, 1, 2, 3].map(() => new THREE.Texture()) };
    const m = new CharacterMaterial(t);
    const h = applyToon(m, { row: "skin" });
    assert.equal(applyToon(m, { row: "hair" }), h, "a second apply changes nothing");
    assert.equal(toonOf(m), h);
    const s = compile(m);
    assert.ok(s.uniforms.uCharColours && s.uniforms.uToonRamp, "both patches' uniforms");
    assert.ok(s.fragmentShader.includes("chrMask0") && s.fragmentShader.includes("RE_Direct_Toon"));
    assert.equal(h.uniforms.uToonRow.value, TOON_ROWS.indexOf("skin"));
    assert.equal(m.customProgramCacheKey(), "mmo-modular-character|toon:");
  });

  it("switches its optional parts on with their maps, as program variants", () => {
    const m = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const lightMap = new THREE.Texture();
    applyToon(m, { lightMap, matcap: new THREE.Texture(), faceShadow: new THREE.Texture() });
    const s = compile(m);
    for (const d of ["TOON_LIGHTMAP", "TOON_MATCAP", "TOON_FACE"]) assert.match(s.fragmentShader, new RegExp(`#define ${d}`));
    assert.equal(s.uniforms.uToonLightMap.value, lightMap);
    assert.match(m.customProgramCacheKey(), /toon:LMF$/);
    toonOf(m)!.setFaceFrame(new THREE.Vector3(0, 0, 2), new THREE.Vector3(3, 0, 0));
    assert.deepEqual(s.uniforms.uToonFaceForward.value.toArray(), [0, 0, 1]);
  });

  it("refuses a shader that isn't a standard material's", () => {
    const m = new THREE.MeshStandardMaterial();
    applyToon(m);
    assert.throws(() => compile(m, { uniforms: {}, vertexShader: "", fragmentShader: "void main() {}" }), /no #include <lights_physical_pars_fragment>/);
  });
});

describe("the ramp and the day", () => {
  it("has a day and a night row per material, darker at the left, cooler at night", () => {
    const ramp = defaultToonRamp();
    assert.equal(defaultToonRamp(), ramp, "shared");
    const { width: W, height: H } = ramp.image;
    assert.equal(H, 10);
    const d = ramp.image.data as Uint8Array;
    const px = (topRow: number, x: number) => Array.from(d.subarray(((H - 1 - topRow) * W + x) * 4, ((H - 1 - topRow) * W + x) * 4 + 3));
    TOON_ROWS.forEach((_, k) => {
      const [dayDark, dayEdge, nightEdge] = [px(k, 0), px(k, W - 1), px(k + 5, W - 1)];
      assert.ok(dayDark.reduce((a, b) => a + b) < dayEdge.reduce((a, b) => a + b), `${TOON_ROWS[k]}: darker at the left`);
      assert.ok(nightEdge.reduce((a, b) => a + b) < dayEdge.reduce((a, b) => a + b), `${TOON_ROWS[k]}: darker at night`);
      assert.ok(nightEdge[2] >= nightEdge[0], `${TOON_ROWS[k]}: bluer at night`);
    });
  });

  it("fades from night to day as the sun rises", () => {
    assert.equal(toonDayFromSun(-0.5), 0);
    assert.equal(toonDayFromSun(0.8), 1);
    assert.ok(toonDayFromSun(0.02) > 0 && toonDayFromSun(0.02) < 1);
    setToonDay(2);
    assert.equal(TOON_GLOBALS.uToonDay.value, 1);
    setToonDay(1);
  });
});

describe("outlines", () => {
  it("smooth the normals of a hard-edged mesh: one unit normal per corner", () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const n = smoothNormals(box);
    assert.equal(smoothNormals(box), n, "cached");
    const pos = box.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(n.getX(i), n.getY(i), n.getZ(i));
      assert.ok(Math.abs(v.length() - 1) < 1e-6);
      // At a cube's corner the averaged normal points out along the diagonal.
      const out = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
      assert.ok(v.dot(out) > 0.999, `vertex ${i} points out of its corner`);
    }
  });

  it("follow a skinned mesh's skeleton and morphs, and never catch rays", () => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const count = geo.getAttribute("position").count;
    geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
    geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const bone = new THREE.Bone();
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    mesh.morphTargetInfluences = [0.5];
    const material = new OutlineMaterial({ width: 3, map: new THREE.Texture() });
    const o = addOutline(mesh, material) as THREE.SkinnedMesh;
    assert.ok(o.isSkinnedMesh && o.skeleton === mesh.skeleton && o.geometry === mesh.geometry);
    assert.equal(o.parent, mesh);
    assert.equal(o.morphTargetInfluences, mesh.morphTargetInfluences);
    assert.equal(material.side, THREE.BackSide);
    assert.equal(material.uniforms.uWidth.value, 3);
    assert.equal(material.uniforms.uUseMap.value, 1);
    const hits: THREE.Intersection[] = [];
    o.raycast(new THREE.Raycaster(), hits);
    assert.equal(hits.length, 0);
  });
});

describe("gtTonemap", () => {
  it("keeps the middle linear, rolls highlights off below the maximum, and never goes back", () => {
    assert.ok(Math.abs(gtTonemap(0)) < 1e-9, "black stays black");
    for (const x of [0.25, 0.35, 0.45]) assert.ok(Math.abs(gtTonemap(x) - x) < 1e-6, `${x}: linear`);
    let prev = -1;
    for (let x = 0; x <= 20; x += 0.01) {
      const y = gtTonemap(x);
      assert.ok(y >= prev - 1e-9, `rising at ${x.toFixed(2)}`);
      assert.ok(y <= GT_DEFAULTS.maxLuminance + 1e-9, `under the maximum at ${x.toFixed(2)}`);
      prev = y;
    }
    assert.ok(gtTonemap(4) > 0.99, "bright light approaches white");
    assert.ok(gtTonemap(0.1) < 0.1, "the toe tightens the blacks");
  });
});
