/**
 * Shading components: the client's named, data-driven answer to "how is
 * this surface lit".
 *
 * A shading component is a named, self-contained way to shade a surface:
 * `toon` is the cel look (../toon/toon-material.ts), `standard` leaves
 * three's own PBR alone. Which things carry which components is content
 * (content/materials/materials.json -> `shading`), so turning cell
 * shading on for a kind of thing is adding the `toon` component to it
 * there — never editing a renderer.
 *
 * Renderers ask for the kind they draw and apply whatever the content
 * says:
 * - `model`: an art-pack or PICG model's own material (scenery, creatures,
 *   held weapons — the materials those models share)
 * - `placeholder`: a stand-in shape for an entity without a model yet
 * - `prefab`: a composed entity (a rank's attachments on a stand-in body)
 *
 * The look's own numbers (band, ramp colours, rim) stay in materials.json's
 * `toon` block; this only decides who is shaded, and with which ramp row.
 *
 * Modular characters are not routed through here: the character kit shades
 * its own material (CharacterStyle, ../character/character-kit.ts).
 */

import * as THREE from "three";
import type { ShadingComponentId, ShadingDoc, ShadingKind, ToonRowName } from "@mmo-engine/art/browser";
import { applyToon, toonBand, type ToonRow } from "../toon/toon-material.js";

/** What a kind carries when the content says nothing: the cel look. */
const DEFAULT_KINDS: Record<ShadingKind, readonly ShadingComponentId[]> = {
  model: ["toon"],
  placeholder: ["toon"],
  prefab: ["toon"],
  terrain: ["toon"],
  structure: ["toon"],
  figure: ["toon"],
  fallback: ["toon"],
};

/** The ramp row a kind uses when the content names none. */
const DEFAULT_ROWS: Record<ShadingKind, ToonRowName> = {
  model: "leather",
  placeholder: "leather",
  prefab: "cloth",
  terrain: "leather",
  structure: "leather",
  figure: "cloth",
  fallback: "cloth",
};

/** Feathered-edge width of the cel band (0: hard); set per quality tier. */
let celFeather = 0;

/** Set the cel band's feathered-edge width: the quality tier's `celFeather`. */
export function setCelFeather(width: number): void {
  celFeather = Math.max(0, width);
}

/** The cel band the patch starts from: the content's band, feathered by the tier, centred. */
export function celBand(): [number, number] {
  const [lo, hi] = toonBand();
  const mid = (lo + hi) / 2;
  const half = Math.max(hi - lo, celFeather) / 2;
  return celFeather > 0 ? [mid - half, mid + half] : [mid, mid];
}

/** How each component shades a surface. */
const COMPONENTS: Record<ShadingComponentId, (material: THREE.MeshStandardMaterial, kind: ShadingKind) => void> = {
  toon: (material, kind) => {
    applyToon(material, { row: toonRowFor(kind), band: celBand() });
  },
  standard: () => {
    // three's own PBR: nothing to add.
  },
};

let content: ShadingDoc = {};

/** Apply the content's `shading` block (content/materials/materials.json). */
export function setShadingContent(shading: ShadingDoc | undefined): void {
  content = shading ?? {};
}

/** The components a kind of thing carries: the content's, else the engine's default. */
export function shadingFor(kind: ShadingKind): readonly ShadingComponentId[] {
  return content.kinds?.[kind] ?? DEFAULT_KINDS[kind];
}

/** The toon ramp row a kind of thing uses: the content's, else the engine's default. */
export function toonRowFor(kind: ShadingKind): ToonRow {
  return content.rows?.[kind] ?? DEFAULT_ROWS[kind];
}

/**
 * Shade one material as its kind says. Idempotent (a toon material keeps
 * its first patch); a material that isn't a standard one is left alone.
 */
export function applyShadingToMaterial(material: THREE.Material, kind: ShadingKind): void {
  const standard = material as THREE.MeshStandardMaterial;
  if (!standard.isMeshStandardMaterial) return;
  for (const id of shadingFor(kind)) COMPONENTS[id](standard, kind);
}

/** Shade every mesh under `object` as its kind says. */
export function applyShading(object: THREE.Object3D, kind: ShadingKind): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => applyShadingToMaterial(m, kind));
    else if (material) applyShadingToMaterial(material, kind);
  });
}

/** Shade a material as its kind says and hand it back (for field initialisers). */
export function shadedMaterial<M extends THREE.Material>(material: M, kind: ShadingKind): M {
  applyShadingToMaterial(material, kind);
  return material;
}
