/**
 * PrefabGallery — composed entities on show (part of the FX showcase): a
 * few creatures and items composed at high ranks by the entity composer
 * (@mmo-engine/compose), built by PrefabBuilder on stand-in bodies, with
 * their names above them. Local and visual only.
 */

import * as THREE from "three";
import { composeCreature, composeItem, type Composition, type CreatureBase } from "@mmo-engine/compose/browser";
import { applyToon } from "../toon/toon-material.js";
import type { QuarksFx } from "../vfx/quarks-fx.js";
import { PrefabBuilder, type PrefabInstance } from "./prefab-builder.js";

const CREATURES: [CreatureBase, string, number][] = [
  [{ id: "fiend", name: "Fiend", tags: ["demon", "fire"], stats: { health: 120, power: 14 } }, "legendary", 7],
  [{ id: "lich", name: "Lich", tags: ["undead"], stats: { health: 90, spell: 20 } }, "legendary", 3],
  [{ id: "troll", name: "Troll", tags: ["organic"], stats: { health: 200, power: 16 } }, "epic", 5],
];
const ITEMS: [string, string, number][] = [
  ["greatsword", "legendary", 2],
  ["staff", "legendary", 4],
  ["shield", "epic", 9],
];

/** A stand-in body for a composed entity: a toon capsule, or a rough shape of the item. */
export function standInFor(c: Composition): THREE.Object3D {
  const toon = (color: number): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
    applyToon(m, { row: "cloth" });
    return m;
  };
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, color: number, y = 0): void => {
    const mesh = new THREE.Mesh(geo, toon(color));
    mesh.position.y = y;
    g.add(mesh);
  };
  if (c.bundle.Identity.kind === "creature") {
    add(new THREE.CapsuleGeometry(0.4, 1, 6, 16), 0xc8b4a0, 0.9);
    return g;
  }
  switch (c.bundle.Identity.base) {
    case "sword":
    case "greatsword":
    case "dagger":
      add(new THREE.BoxGeometry(0.1, 1.2, 0.03), 0xdddddd, 1.1);
      add(new THREE.BoxGeometry(0.4, 0.06, 0.08), 0x886644, 0.48);
      add(new THREE.CylinderGeometry(0.03, 0.03, 0.3), 0x553322, 0.3);
      break;
    case "staff":
    case "wand":
      add(new THREE.CylinderGeometry(0.035, 0.045, 1.6), 0x8a6a44, 0.8);
      add(new THREE.IcosahedronGeometry(0.12), 0xffffff, 1.65);
      break;
    case "shield": {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, 24), toon(0xbbbbbb));
      s.rotation.x = Math.PI / 2;
      s.position.y = 0.9;
      g.add(s);
      break;
    }
    default:
      add(new THREE.TorusGeometry(0.2, 0.05, 8, 24), 0xdddddd, 0.9);
  }
  return g;
}

export class PrefabGallery {
  readonly group = new THREE.Group();
  private readonly instances: PrefabInstance[] = [];

  constructor(vfx: QuarksFx, label: (text: string) => THREE.Object3D) {
    this.group.name = "prefab-gallery";
    const builder = new PrefabBuilder(vfx);
    const all: Composition[] = [
      ...CREATURES.map(([base, rank, seed]) => composeCreature(base, rank, { seed })),
      ...ITEMS.map(([item, rank, seed]) => composeItem(item, rank, { seed })),
    ];
    all.forEach((c, i) => {
      const inst = builder.build(c.bundle, standInFor(c));
      // A row behind the orb ring, creatures then items.
      inst.root.position.set((i - (all.length - 1) / 2) * 4, 0, -9);
      const tag = label(c.bundle.Identity.name);
      // Staggered, so neighbours' long names don't overlap.
      tag.position.y = i % 2 ? 3.6 : 3;
      // Legendary names are long: keep every label about the same height.
      tag.scale.multiplyScalar(0.3);
      inst.root.add(tag);
      this.group.add(inst.root);
      this.instances.push(inst);
    });
  }

  update(dt: number, time: number): void {
    for (const i of this.instances) i.update(dt, time);
  }

  dispose(): void {
    for (const i of this.instances) i.dispose();
    this.instances.length = 0;
    this.group.removeFromParent();
  }
}
