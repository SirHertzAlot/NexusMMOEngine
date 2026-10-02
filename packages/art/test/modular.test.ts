/**
 * Modular characters: part names parse into slots, genders, sets, masks
 * and coverings; the starter armour is set 01; and the rig converter's
 * skeleton fix — one skeleton rebuilt by bone name from FBXLoader's nested
 * per-part copies — binds a part so it rests and moves exactly as before.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  buildCatalog,
  parsePartName,
  partsFor,
  starterArmour,
} from "../src/character/modular-catalog.js";
import { canonicalSkeleton, partScene } from "../src/convert/convert-modular.js";
import { canonicalLook, effectiveColours, heldOf, lookToJson, parseLook, resolveLook, validateLook, withHeld, type CharacterLook } from "../src/character/look.js";
import { DEFAULT_COLOURS } from "../src/character/colour-slots.js";

describe("part names", () => {
  it("reads slot, gender, set, masks and coverings", () => {
    assert.deepEqual(parsePartName("Chr_Torso_Male_05"), { name: "Chr_Torso_Male_05", slot: "torso", gender: "male", index: 5 });
    assert.deepEqual(parsePartName("Chr_ArmLowerLeft_Female_00")?.slot, "armLowerLeft");
    assert.deepEqual(parsePartName("Chr_Head_No_Elements_Female_03"), {
      name: "Chr_Head_No_Elements_Female_03", slot: "head", gender: "female", index: 3, mask: true,
    });
    assert.equal(parsePartName("Chr_Head_Male_12")?.mask, undefined, "an ordinary head is no mask");
    assert.deepEqual(parsePartName("Chr_Hair_38"), { name: "Chr_Hair_38", slot: "hair", gender: null, index: 38 });
    assert.equal(parsePartName("Chr_FacialHair_Male_02")?.gender, "male");
    assert.equal(parsePartName("Chr_Ear_Ear_2")?.slot, "ears");
    assert.deepEqual(parsePartName("Chr_HeadCoverings_No_Hair_4")?.hides, ["hair"]);
    assert.deepEqual(parsePartName("Chr_HeadCoverings_No_FacialHair_1")?.hides, ["facialHair"]);
    assert.deepEqual(parsePartName("Chr_HeadCoverings_Base_Hair_1")?.hides, []);
    assert.equal(parsePartName("Chr_KneeAttachRight_7")?.slot, "kneeRight");
    assert.equal(parsePartName("SK_Wep_Sword"), null);
  });

  it("builds a sorted catalog, filters by gender, and finds the starter set", () => {
    const names = ["Chr_Hair_02", "Chr_Hair_01", "Chr_Eyebrow_Female_1", "Chr_Eyebrow_Male_1", "Mystery_Mesh"];
    const body = ["Torso", "ArmUpperRight", "ArmUpperLeft", "ArmLowerRight", "ArmLowerLeft", "HandRight", "HandLeft", "Hips", "LegRight", "LegLeft"];
    for (const g of ["Male", "Female"]) for (const b of body) for (const n of ["00", "01", "02"]) names.push(`Chr_${b}_${g}_${n}`);
    const { catalog, unknown } = buildCatalog(names);
    assert.deepEqual(unknown, ["Mystery_Mesh"]);
    assert.equal(catalog.parts[0].slot, "torso", "body slots first");
    assert.deepEqual(partsFor(catalog, "hair", "female").map((p) => p.name), ["Chr_Hair_01", "Chr_Hair_02"], "shared, by index");
    assert.deepEqual(partsFor(catalog, "eyebrows", "male").map((p) => p.name), ["Chr_Eyebrow_Male_1"]);
    const starter = starterArmour(catalog, "female");
    assert.equal(starter.torso, "Chr_Torso_Female_01");
    assert.equal(starter.legLeft, "Chr_LegLeft_Female_01");
    assert.throws(() => starterArmour(buildCatalog(["Chr_Torso_Male_01"]).catalog, "male"), /no starter armUpperRight/);
  });
});

describe("rig conversion", () => {
  /** Root → Hips → Spine, plus the loader's duplicate Hips' → Spine' nested under Hips. */
  function loaderLikeScene(): { space: THREE.Group; original: THREE.SkinnedMesh; duplicate: THREE.SkinnedMesh } {
    const space = new THREE.Group();
    const chain = (parent: THREE.Object3D, name: string, y: number): THREE.Bone => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.y = y;
      parent.add(b);
      return b;
    };
    const root = chain(space, "Root", 0);
    const hips = chain(root, "Hips", 100); // centimetres, like the FBX
    const spine = chain(hips, "Spine", 20);
    const hipsDup = chain(hips, "Hips", 0); // same world pose as hips
    const spineDup = chain(hipsDup, "Spine", 20);
    const mesh = (bones: THREE.Bone[]): THREE.SkinnedMesh => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([0, 100, 0, 0, 125, 5], 3));
      g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0], 4));
      g.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4));
      const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
      m.name = "Chr_Torso_Male_01";
      space.add(m);
      space.updateMatrixWorld(true);
      m.bind(new THREE.Skeleton(bones));
      return m;
    };
    return { space, original: mesh([hips, spine]), duplicate: mesh([hipsDup, spineDup]) };
  }

  const vertex = (m: THREE.SkinnedMesh, i: number): THREE.Vector3 =>
    m.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(m.geometry.attributes.position, i)).applyMatrix4(m.matrixWorld);

  it("rebuilds one skeleton by name from nested per-part copies", () => {
    const { space, original, duplicate } = loaderLikeScene();
    const rig = canonicalSkeleton([original, duplicate], space);
    assert.deepEqual([...rig.byName.keys()].sort(), ["Hips", "Root", "Spine"]);
    assert.equal(rig.byName.get("Spine")!.parent!.name, "Hips");
    assert.equal(rig.byName.get("Hips")!.parent!.name, "Root");
    assert.equal(rig.byName.get("Hips")!.position.y, 100);
    assert.equal(rig.byName.get("Spine")!.position.y, 20);
  });

  it("keeps like-named bones on each side apart (both hands' fingers)", () => {
    const space = new THREE.Group();
    const bone = (parent: THREE.Object3D, name: string, x: number): THREE.Bone => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.x = x;
      parent.add(b);
      return b;
    };
    const root = bone(space, "Root", 0);
    const handL = bone(root, "Hand_L", 50);
    const handR = bone(root, "Hand_R", -50);
    const thumbL = bone(handL, "Thumb_01", 5);
    const thumbR = bone(handR, "Thumb_01", -5);
    // A per-part copy of the left hand, nested in the original.
    const thumbCopy = bone(bone(handL, "Hand_L", 0), "Thumb_01", 5);
    const skinned = (bones: THREE.Bone[]): THREE.SkinnedMesh => {
      const m = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
      space.add(m);
      space.updateMatrixWorld(true);
      m.bind(new THREE.Skeleton(bones));
      return m;
    };
    const rig = canonicalSkeleton([skinned([handL, thumbL]), skinned([handR, thumbR]), skinned([thumbCopy])], space);
    assert.deepEqual([...rig.byName.keys()].sort(), ["Hand_L", "Hand_R", "Root", "Thumb_01_L", "Thumb_01_R"]);
    assert.equal(rig.byName.get("Thumb_01_L")!.parent!.name, "Hand_L");
    assert.equal(rig.byName.get("Thumb_01_R")!.parent!.name, "Hand_R");
    assert.equal(rig.nameOf(thumbCopy), "Thumb_01_L", "the copy is the left thumb");
    assert.equal(rig.nameOf(thumbR), "Thumb_01_R");
  });

  it("binds a part so it rests and moves as in the source, in metres", () => {
    const { space, original, duplicate } = loaderLikeScene();
    const rig = canonicalSkeleton([original, duplicate], space);
    const scene = partScene(duplicate, rig.root, space, new THREE.MeshBasicMaterial(), 0.01, rig.nameOf);
    const part = scene.children.find((c) => (c as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
    scene.updateMatrixWorld(true);
    for (const i of [0, 1]) {
      assert.ok(vertex(part, i).distanceTo(vertex(duplicate, i).multiplyScalar(0.01)) < 1e-6, `vertex ${i} rests in place`);
    }
    // Bend the spine the same way in both: the part follows its new rig.
    const bend = (s: THREE.Bone): void => {
      s.rotation.z = 0.6;
    };
    bend(duplicate.skeleton.bones[1]);
    bend(part.skeleton.bones[1]);
    space.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    duplicate.skeleton.update();
    part.skeleton.update();
    assert.ok(vertex(part, 1).distanceTo(vertex(duplicate, 1).multiplyScalar(0.01)) < 1e-6, "posed vertex matches");
    assert.equal(part.skeleton.bones[0], scene.getObjectByName("Hips"), "bound to the part file's own rig copy");
  });
});

describe("character looks", () => {
  const body = ["Torso", "ArmUpperRight", "ArmUpperLeft", "ArmLowerRight", "ArmLowerLeft", "HandRight", "HandLeft", "Hips", "LegRight", "LegLeft"];
  const names = [
    "Chr_Head_Male_01", "Chr_Head_Male_02", "Chr_Head_No_Elements_Male_01", "Chr_Head_Female_01",
    "Chr_Hair_05", "Chr_Eyebrow_Male_02", "Chr_FacialHair_Male_03", "Chr_Eyebrow_Female_01",
    "Chr_HeadCoverings_No_Hair_02", "Chr_HelmetAttachment_01",
  ];
  for (const g of ["Male", "Female"]) for (const b of body) for (const n of ["01", "05"]) names.push(`Chr_${b}_${g}_${n}`);
  const { catalog } = buildCatalog(names);
  const shown = (look: CharacterLook): string[] => resolveLook(catalog, look).map((p) => p.name);

  it("wears the starter armour and a default head unless told otherwise", () => {
    const parts = shown({ gender: "male", parts: {}, colours: {} });
    assert.ok(parts.includes("Chr_Torso_Male_01") && parts.includes("Chr_LegLeft_Male_01"));
    assert.ok(parts.includes("Chr_Head_Male_01"), "first ordinary head");
    assert.equal(parts.length, 11);
  });

  it("hides what a mask head or a covering hides, and ignores parts of the other gender", () => {
    const base = { gender: "male" as const, colours: {}, parts: { head: "Chr_Head_Male_02", hair: "Chr_Hair_05", eyebrows: "Chr_Eyebrow_Male_02", facialHair: "Chr_FacialHair_Male_03" } };
    assert.ok(shown(base).includes("Chr_FacialHair_Male_03"));
    const masked = shown({ ...base, parts: { ...base.parts, head: "Chr_Head_No_Elements_Male_01" } });
    assert.ok(!masked.includes("Chr_Eyebrow_Male_02") && !masked.includes("Chr_FacialHair_Male_03"), "a mask head shows no brows or beard");
    assert.ok(masked.includes("Chr_Hair_05"));
    const covered = shown({ ...base, parts: { ...base.parts, headCovering: "Chr_HeadCoverings_No_Hair_02" } });
    assert.ok(!covered.includes("Chr_Hair_05") && covered.includes("Chr_HeadCoverings_No_Hair_02"), "a No_Hair covering hides the hair");
    const wrong = shown({ gender: "female", parts: { eyebrows: "Chr_Eyebrow_Male_02", torso: "Chr_Torso_Male_05" }, colours: {} });
    assert.ok(!wrong.includes("Chr_Eyebrow_Male_02") && wrong.includes("Chr_Torso_Female_01"), "other-gender parts fall back");
  });

  it("validates a new character: appearance free, armour locked, colours hex", () => {
    const ok: CharacterLook = { gender: "female", parts: { head: "Chr_Head_Female_01", hair: "Chr_Hair_05", eyebrows: "Chr_Eyebrow_Female_01" }, colours: { skin: "#8d5524", hair: "#1c1c1c" } };
    assert.deepEqual(validateLook(catalog, ok, { creation: true }), []);
    const problems = validateLook(
      catalog,
      { gender: "female", parts: { torso: "Chr_Torso_Female_05", helmet: "Chr_HelmetAttachment_01", eyebrows: "Chr_Eyebrow_Male_02", tail: "x" } as CharacterLook["parts"], colours: { primary: "#ffffff", skin: "red" } },
      { creation: true },
    ).map((p) => p.field);
    assert.deepEqual(problems.sort(), ["colours.primary", "colours.skin", "parts.eyebrows", "parts.helmet", "parts.tail", "parts.torso"].sort());
    assert.deepEqual(validateLook(catalog, { gender: "male", parts: { torso: "Chr_Torso_Male_05" }, colours: { primary: "#ffffff" } }), [], "later (not creation): any set, any colour");
  });
});

describe("effective colours", () => {
  it("unchosen regions follow the skin; chosen ones win; armour keeps the pack's", () => {
    const man = effectiveColours({ gender: "male", parts: {}, colours: { skin: "#8d5524", hair: "#0f0d0c" } });
    assert.equal(man.skin, "#8d5524");
    assert.equal(man.bodyArt, "#8d5524", "body art invisible until chosen");
    assert.equal(man.stubble, "#7c4b20", "a darker skin");
    assert.equal(man.hair, "#0f0d0c");
    assert.equal(man.primary, DEFAULT_COLOURS.primary);
    const woman = effectiveColours({ gender: "female", parts: {}, colours: { skin: "#ffdbc4", bodyArt: "#2244aa", stubble: "#000000" } });
    assert.equal(effectiveColours({ gender: "male", parts: {}, colours: { stubble: "bad" } }).stubble, "#e0b499", "an invalid choice is ignored");
    assert.equal(woman.stubble, "#ffdbc4", "no stubble on women");
    assert.equal(woman.bodyArt, "#2244aa");
  });
});

describe("look JSON", () => {
  it("canonical form: slot order, no empty slots, lower-case colours", () => {
    const a: CharacterLook = { gender: "male", parts: { hair: "Chr_Hair_01", head: "Chr_Head_Male_02", ears: null }, colours: { hair: "#AABBCC", skin: "#112233" } };
    const b: CharacterLook = { gender: "male", parts: { head: "Chr_Head_Male_02", hair: "Chr_Hair_01" }, colours: { skin: "#112233", hair: "#aabbcc" } };
    assert.equal(lookToJson(a), lookToJson(b));
    assert.deepEqual(Object.keys(canonicalLook(a).parts), ["head", "hair"]);
  });
  it("parseLook takes objects and JSON, drops unknown slots, refuses garbage", () => {
    const json = lookToJson({ gender: "female", parts: { head: "Chr_Head_Female_01" }, colours: { skin: "#ffdbc4" } });
    assert.deepEqual(parseLook(json), JSON.parse(json));
    assert.deepEqual(parseLook({ gender: "female", parts: { wings: "x", head: "Chr_Head_Female_01" }, colours: { glow: "#ffffff" } }), {
      gender: "female", parts: { head: "Chr_Head_Female_01" }, colours: {},
    });
    for (const bad of [null, 3, "{", "[]", { gender: "other", parts: {}, colours: {} }, { gender: "male", parts: [], colours: {} },
      { gender: "male", parts: { head: 5 }, colours: {} }, { gender: "male", parts: {}, colours: { skin: 1 } }, "x".repeat(5000)]) {
      assert.equal(parseLook(bad), null, JSON.stringify(bad)?.slice(0, 40));
    }
  });
});

describe("held weapons in the appearance (M3b)", () => {
  const look = lookToJson({ gender: "male", parts: { head: "Chr_Head_Male_02" }, colours: {} });
  it("withHeld adds and clears held models, keeping the look; heldOf reads them back", () => {
    const armed = withHeld(look, { main: "pack/SM_Wep_Sword_01" });
    assert.deepEqual(heldOf(armed), { main: "pack/SM_Wep_Sword_01" });
    assert.deepEqual(parseLook(armed), parseLook(look), "the look itself is unchanged");
    assert.equal(withHeld(armed, {}), look, "nothing held: no held key");
    assert.deepEqual(heldOf(withHeld(armed, { off: "pack/Shield" })), { off: "pack/Shield" });
  });
  it("heldOf ignores garbage and bad model ids", () => {
    assert.deepEqual(heldOf("{"), {});
    assert.deepEqual(heldOf(JSON.stringify({ held: { main: "<script>", off: 3 } })), {});
    assert.deepEqual(heldOf(look), {});
  });
});
