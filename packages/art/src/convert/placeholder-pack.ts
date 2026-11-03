/**
 * Generated placeholder packs (WL1, D4g): stand-in models for the art that is
 * not in the repo yet, in the same shape as a Poly Pizza pack folder (a
 * `manifest.json` and one GLB per entry), so the GLB importer can take them
 * exactly as it takes licensed packs. Written to a folder of your choosing
 * (not assets/, not the repo) and marked with a licence that says what they are.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { PackEntry } from "./import-glb-packs.js";

export const PLACEHOLDER_LICENCE = "generated placeholder (no art)";

/** GLTFExporter reads blobs through FileReader, which Node lacks. */
function ensureFileReader(): void {
  const g = globalThis as { FileReader?: unknown };
  g.FileReader ??= class {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((r) => {
        this.result = r;
        this.onloadend?.();
      });
    }
  };
}

/** A four-legged stand-in built from boxes, in metres: body, head, tail and four legs. */
export function placeholderAnimal(name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  const part = (w: number, h: number, d: number, x: number, y: number, z: number, part: string): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ name: `${name}_${part}`, color: 0x8a7a66 }));
    m.position.set(x, y, z);
    m.name = part;
    return m;
  };
  group.add(part(0.6, 0.6, 1.4, 0, 0.9, 0, "body"));
  group.add(part(0.35, 0.35, 0.4, 0, 1.15, 0.9, "head"));
  group.add(part(0.1, 0.1, 0.3, 0, 1.0, -0.85, "tail"));
  for (const [x, z] of [[-0.2, 0.5], [0.2, 0.5], [-0.2, -0.5], [0.2, -0.5]] as const) {
    group.add(part(0.14, 0.7, 0.14, x, 0.35, z, "leg"));
  }
  return group;
}

export async function exportGlb(obj: THREE.Object3D): Promise<Uint8Array> {
  ensureFileReader();
  return new Uint8Array((await new GLTFExporter().parseAsync(obj, { binary: true })) as ArrayBuffer);
}

/**
 * Write a placeholder pack folder: a manifest and one GLB per title. Returns the
 * manifest entries. `folder` is the pack's name, e.g. `poly-pizza-placeholder-wildlife`.
 */
export async function makePlaceholderPack(folder: string, titles: ReadonlyArray<{ title: string; publicID: string }>): Promise<PackEntry[]> {
  fs.mkdirSync(folder, { recursive: true });
  const entries: PackEntry[] = [];
  for (const t of titles) {
    fs.writeFileSync(path.join(folder, `${t.title}_${t.publicID}.glb`), await exportGlb(placeholderAnimal(t.title)));
    entries.push({ title: t.title, publicID: t.publicID, licence: PLACEHOLDER_LICENCE });
  }
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(entries, null, 2));
  return entries;
}
