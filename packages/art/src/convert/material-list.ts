/**
 * Parser for Synty-style MaterialList_*.txt files (shipped with each pack).
 *
 * The FBX files only carry DCC leftovers for materials ("lambert1439",
 * "file2159"); the material list is the real mapping from each prefab to
 * its category folder, meshes, material names, and texture atlas:
 *
 *   Folder Name: Props
 *   Prefab Name: SM_Prop_Barrel_01
 *       Mesh Name: SM_Prop_Barrel_01
 *           Slot: PolygonFantasyKingdom_Mat_01_A (PolygonFantasyKingdom_Texture_01_A)
 *
 * The texture is the LAST parenthesised name on a slot line — material
 * names can contain their own "(1)" suffixes. "(Uses custom shader)" and
 * "(No Albedo Texture)" mean the slot has no atlas.
 */

export interface MaterialSlot {
  material: string;
  /** Atlas texture name without extension, or null (custom shader / none). */
  texture: string | null;
  customShader: boolean;
}

export interface PrefabMaterials {
  folder: string;
  /** Mesh name -> its slots, in material-index order. */
  meshes: Map<string, MaterialSlot[]>;
}

const NO_TEXTURE = new Set(["Uses custom shader", "No Albedo Texture"]);

export function parseSlot(text: string): MaterialSlot {
  const m = /^(.*)\(([^()]*)\)\s*$/.exec(text.trim());
  if (!m) return { material: text.trim(), texture: null, customShader: false };
  const inner = m[2].trim();
  return {
    material: m[1].trim(),
    texture: NO_TEXTURE.has(inner) ? null : inner,
    customShader: inner === "Uses custom shader",
  };
}

export function parseMaterialList(text: string): Map<string, PrefabMaterials> {
  const prefabs = new Map<string, PrefabMaterials>();
  let folder = "";
  let prefab: PrefabMaterials | null = null;
  let mesh: MaterialSlot[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^Folder Name:\s*(.+)$/.exec(line))) {
      folder = m[1].trim();
    } else if ((m = /^Prefab Name:\s*(.+)$/.exec(line))) {
      prefab = { folder, meshes: new Map() };
      prefabs.set(m[1].trim(), prefab);
      mesh = null;
    } else if ((m = /^Mesh Name:\s*(.+)$/.exec(line)) && prefab) {
      mesh = [];
      prefab.meshes.set(m[1].trim(), mesh);
    } else if ((m = /^Slot:\s*(.+)$/.exec(line)) && mesh) {
      mesh.push(parseSlot(m[1]));
    }
  }
  return prefabs;
}

/** The atlas used by the most slots — the pack's default texture. */
export function primaryTexture(prefabs: Map<string, PrefabMaterials>): string | null {
  const counts = new Map<string, number>();
  for (const p of prefabs.values()) {
    for (const slots of p.meshes.values()) {
      for (const s of slots) if (s.texture) counts.set(s.texture, (counts.get(s.texture) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [t, n] of counts) if (n > bestN) [best, bestN] = [t, n];
  return best;
}
