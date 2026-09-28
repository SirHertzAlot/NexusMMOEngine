/**
 * Modular characters in the client: the recolour material's shader
 * injection and colours, and the arms-down rest pose.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { COLOUR_SLOTS, DEFAULT_COLOURS, MASK_CHANNELS } from "@mmo-engine/art/browser";
import { CharacterMaterial } from "../src/render/character/character-material.js";
import { ModularCharacter, type CharacterKit } from "../src/render/character/character-kit.js";

const textures = (masks = 4): { base: THREE.Texture; masks: THREE.Texture[] } => ({
  base: new THREE.Texture(),
  masks: Array.from({ length: masks }, () => new THREE.Texture()),
});

describe("CharacterMaterial", () => {
  it("wants the four mask textures", () => {
    assert.throws(() => new CharacterMaterial(textures(3)), /4 mask textures/);
  });

  it("injects the colour and mask uniforms and one mix per colour slot", () => {
    const t = textures();
    const material = new CharacterMaterial(t, { skin: "#8d5524" });
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: "",
      fragmentShader: "#include <common>\nvoid main() {\n#include <map_fragment>\n}",
    };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    assert.equal((shader.uniforms.uCharColours.value as THREE.Color[]).length, COLOUR_SLOTS.length);
    t.masks.forEach((m, i) => assert.equal(shader.uniforms[`uCharMask${i}`].value, m));
    assert.match(shader.fragmentShader, new RegExp(`uniform vec3 uCharColours\\[${COLOUR_SLOTS.length}\\]`));
    COLOUR_SLOTS.forEach((slot, i) => {
      const [mask, channel] = MASK_CHANNELS[slot];
      assert.ok(
        shader.fragmentShader.includes(`uCharColours[${i}], 1.0 - chrMask${mask}.${"rgb"[channel]})`),
        `${slot} mixes from mask ${mask} channel ${"rgb"[channel]}`,
      );
    });
    // The mixes run after the atlas is sampled.
    assert.ok(shader.fragmentShader.indexOf("#include <map_fragment>") < shader.fragmentShader.indexOf("chrMask0"));
  });

  it("sets colours, and unset slots go back to the pack's", () => {
    const material = new CharacterMaterial(textures(), { skin: "#8d5524" });
    assert.equal(material.colourOf("skin"), "#8d5524");
    assert.equal(material.colourOf("primary"), DEFAULT_COLOURS.primary);
    material.setColours({ hair: "#0f0d0c" });
    assert.equal(material.colourOf("hair"), "#0f0d0c");
    assert.equal(material.colourOf("skin"), DEFAULT_COLOURS.skin);
  });
});

describe("ModularCharacter rest pose", () => {
  /**
   * Root (0.01 scale, like the rig file) → Hips → Clavicle → Shoulder →
   * Elbow per side: each arm points straight out along ±X in the world,
   * though every bone has an arbitrary local frame (like the pack's).
   */
  function rig(): THREE.Group {
    const root = new THREE.Group();
    root.scale.setScalar(0.01);
    const hips = new THREE.Bone();
    hips.name = "Hips";
    hips.position.y = 100;
    root.add(hips);
    const chain = (names: string[], x: number): void => {
      let p: THREE.Object3D = hips;
      for (const name of names) {
        const b = new THREE.Bone();
        b.name = name;
        b.quaternion.setFromEuler(new THREE.Euler(0.3, -0.7, 1.1 * Math.sign(x)));
        root.updateMatrixWorld(true);
        b.position.set(x, 0, 0).applyQuaternion(p.getWorldQuaternion(new THREE.Quaternion()).invert());
        p.add(b);
        p = b;
      }
    };
    chain(["Clavicle_L", "Shoulder_L", "Elbow_L"], 15);
    chain(["Clavicle_R", "Shoulder_R", "Elbow_R"], -15);
    return root;
  }

  it("lowers both arms to hang down, turning about the body's forward axis at the shoulder", () => {
    const character = new ModularCharacter({} as CharacterKit, rig(), new CharacterMaterial(textures()));
    const world = (name: string): THREE.Vector3 => character.bones.get(name)!.getWorldPosition(new THREE.Vector3());
    character.root.updateMatrixWorld(true);
    const before = { L: world("Shoulder_L"), R: world("Shoulder_R") };
    assert.ok(world("Elbow_L").sub(before.L).distanceTo(new THREE.Vector3(0.15, 0, 0)) < 1e-6, "left arm out along +X");
    assert.ok(world("Elbow_R").sub(before.R).distanceTo(new THREE.Vector3(-0.15, 0, 0)) < 1e-6, "right arm out along -X");
    character.relaxArms(90);
    for (const side of ["L", "R"] as const) {
      const shoulder = world(`Shoulder_${side}`);
      assert.ok(shoulder.distanceTo(before[side]) < 1e-6, `${side} shoulder stays`);
      const arm = world(`Elbow_${side}`).sub(shoulder);
      assert.ok(arm.distanceTo(new THREE.Vector3(0, -0.15, 0)) < 1e-6, `${side} arm hangs straight down (${arm.toArray().map((v) => v.toFixed(4))})`);
    }
  });
});
