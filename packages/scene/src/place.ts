/**
 * Placement helpers shared by the editor viewport (EA5), the server's
 * scene spawner (EA6) and "Keep" (live entity back into the scene).
 *
 * Conventions: positions are metres, +Y up; `rotation` is Euler degrees and
 * only its Y component (yaw, about +Y) is used by the game world; a child's
 * transform is relative to its parent's (position scaled and turned by the
 * parent's scale and yaw).
 */

import { addNode, findNode, setTransform, type SceneDoc, type SceneNode, type Vec3 } from "./index.js";

export interface WorldNode {
  node: SceneNode;
  parentId: string | null;
  position: Vec3;
  yawDeg: number;
  scale: Vec3;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Every node (depth first) with its transform resolved into scene space. */
export function worldNodes(doc: SceneDoc): WorldNode[] {
  const out: WorldNode[] = [];
  const walk = (list: SceneNode[], parent: WorldNode | null): void => {
    for (const node of list) {
      const p = node.transform?.position ?? [0, 0, 0];
      const yaw = node.transform?.rotation?.[1] ?? 0;
      const s = node.transform?.scale ?? [1, 1, 1];
      let w: WorldNode;
      if (!parent) {
        w = { node, parentId: null, position: [...p] as Vec3, yawDeg: yaw, scale: [...s] as Vec3 };
      } else {
        const lx = p[0] * parent.scale[0];
        const ly = p[1] * parent.scale[1];
        const lz = p[2] * parent.scale[2];
        const c = Math.cos(rad(parent.yawDeg));
        const sn = Math.sin(rad(parent.yawDeg));
        w = {
          node,
          parentId: parent.node.id,
          // Rotation about +Y: x' = x cos + z sin, z' = -x sin + z cos.
          position: [parent.position[0] + lx * c + lz * sn, parent.position[1] + ly, parent.position[2] - lx * sn + lz * c],
          yawDeg: parent.yawDeg + yaw,
          scale: [parent.scale[0] * s[0], parent.scale[1] * s[1], parent.scale[2] * s[2]],
        };
      }
      out.push(w);
      if (node.children) walk(node.children, w);
    }
  };
  walk(doc.nodes, null);
  return out;
}

/** A free node id built from `base` ("oak" -> "oak-1", "oak-2", ...). */
export function uniqueId(doc: SceneDoc, base: string): string {
  for (let i = 1; ; i++) if (!findNode(doc, `${base}-${i}`)) return `${base}-${i}`;
}

/** Add a prefab node (a species, prop or PICG asset id) at `position`, at the root. */
export function placePrefab(doc: SceneDoc, prefab: string, position: Vec3): { doc: SceneDoc; id: string } {
  const slug = (prefab.split("/").pop() ?? "node").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "node";
  const id = uniqueId(doc, slug);
  return { doc: addNode(doc, null, { id, kind: "prefab", prefab, transform: { position: [...position] as Vec3 } }), id };
}

// ---------------------------------------------------------------------- keep

export interface LiveTransform {
  position: Vec3;
  yawDeg: number;
  /** Scene-space scale (the viewport gizmo); a live entity read leaves it out. */
  scale?: Vec3;
}

/** A live entity's transform out of a shared-selection component list (null if it has none). */
export function liveTransform(
  components: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ key: string; value: string }> }>,
): LiveTransform | null {
  const t = components.find((c) => c.name.toLowerCase() === "transform");
  if (!t) return null;
  const num = (key: string): number => {
    const f = t.fields.find((x) => x.key === key);
    return f && f.value.trim() !== "" ? Number(f.value) : NaN;
  };
  const position: Vec3 = [num("px"), num("py"), num("pz")];
  if (!position.every(Number.isFinite)) return null;
  const qy = num("qy");
  const qw = num("qw");
  const yawDeg = Number.isFinite(qy) && Number.isFinite(qw) ? (2 * Math.atan2(qy, qw) * 180) / Math.PI : 0;
  return { position, yawDeg };
}

/**
 * Set node `id` to a scene-space position and yaw (and scale): a live
 * entity ("Keep") or a viewport gizmo drag. Stored relative to its parent.
 */
export function keepLiveTransform(doc: SceneDoc, id: string, live: LiveTransform): SceneDoc {
  const node = findNode(doc, id);
  if (!node) throw new Error(`no node "${id}"`);
  const all = worldNodes(doc);
  const parent = all.find((w) => w.node.id === id)?.parentId;
  const pw = parent ? all.find((w) => w.node.id === parent) : undefined;
  let position: Vec3 = [...live.position] as Vec3;
  let yaw = live.yawDeg;
  if (pw) {
    const dx = live.position[0] - pw.position[0];
    const dy = live.position[1] - pw.position[1];
    const dz = live.position[2] - pw.position[2];
    const c = Math.cos(rad(pw.yawDeg));
    const s = Math.sin(rad(pw.yawDeg));
    position = [(dx * c - dz * s) / pw.scale[0], dy / pw.scale[1], (dx * s + dz * c) / pw.scale[2]];
    yaw -= pw.yawDeg;
  }
  const round = (n: number): number => Math.round(n * 1e4) / 1e4 + 0; // + 0: no negative zero
  const r = node.transform?.rotation ?? [0, 0, 0];
  const scale = live.scale ? (live.scale.map((s, i) => round(s / (pw?.scale[i] ?? 1))) as Vec3) : undefined;
  return setTransform(doc, id, { position: position.map(round) as Vec3, rotation: [r[0], round(yaw), r[2]], ...(scale ? { scale } : {}) });
}
