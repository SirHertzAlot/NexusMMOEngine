/**
 * Toon outlines: the inverted hull. A copy of the mesh, drawn back faces
 * only and pushed out along its normals, shows as a line around the
 * silhouette and along creases.
 *
 * Adapted from KallkaGo's ToonShading (MIT, see THIRD_PARTY_NOTICES.md):
 * - Pushed in clip space, so the line is a steady width in pixels up
 *   close, then thins with distance (as the original clamps clip w).
 * - Along *smoothed* normals: the average of every normal at a
 *   position, so hard edges (where a vertex is split) don't open gaps
 *   in the hull. The original bakes these into a UV set; here they're
 *   computed once per geometry (`smoothNormals`).
 * - Skinned and morphed like the mesh itself, so it follows animation.
 * - Coloured as the base map darkened (the original's 0.15), or a flat
 *   colour.
 */

import * as THREE from "three";

export interface OutlineOptions {
  /** Line width in pixels up close. Default 2. */
  width?: number;
  /** Beyond this clip depth (about metres) the line thins with distance. Default 6. */
  fullWidthDepth?: number;
  /** Line colour; with `map`, multiplies the map. Default 0.15 grey with a map, else near black. */
  color?: THREE.ColorRepresentation;
  /** Take the colour from this base map (its alpha cuts the line out too). */
  map?: THREE.Texture | null;
}

const ATTR = "toonNormal";

/**
 * Add `toonNormal` to a geometry: at each position, the normalised sum of
 * the normals of every vertex there. Cached: a geometry that has it keeps it.
 */
export function smoothNormals(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  const have = geometry.getAttribute(ATTR);
  if (have) return have as THREE.BufferAttribute;
  const pos = geometry.getAttribute("position");
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const nor = geometry.getAttribute("normal");
  const n = pos.count;
  // Positions within ~0.1 mm are the same place.
  const key = (i: number): string => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const sums = new Map<string, THREE.Vector3>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = (keys[i] = key(i));
    let s = sums.get(k);
    if (!s) sums.set(k, (s = new THREE.Vector3()));
    s.x += nor.getX(i);
    s.y += nor.getY(i);
    s.z += nor.getZ(i);
  }
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.copy(sums.get(keys[i])!);
    // Opposite normals cancel (a paper-thin part): fall back to the vertex's own.
    if (v.lengthSq() < 1e-8) v.set(nor.getX(i), nor.getY(i), nor.getZ(i));
    v.normalize();
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const attr = new THREE.BufferAttribute(out, 3);
  geometry.setAttribute(ATTR, attr);
  return attr;
}

const VERTEX = /* glsl */ `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
attribute vec3 toonNormal;
uniform float uWidth;
uniform float uFullWidthDepth;
uniform vec2 uResolution;
varying vec2 vOutlineUv;

void main() {
  vOutlineUv = uv;
  vec3 objectNormal = toonNormal;
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  // Out along the normal's direction on screen: uWidth pixels up close, thinning beyond uFullWidthDepth.
  // (Not transformedNormal: drawing back faces flips it.)
  vec2 dir = (projectionMatrix * vec4(normalMatrix * objectNormal, 0.0)).xy;
  dir = dir * uResolution;
  float len = length(dir);
  if (len > 1e-6) {
    dir /= len;
    gl_Position.xy += dir * (2.0 * uWidth / uResolution) * min(gl_Position.w, uFullWidthDepth);
  }
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform sampler2D uMap;
uniform float uUseMap;
varying vec2 vOutlineUv;

void main() {
  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>
  vec3 c = uColor;
  if (uUseMap > 0.5) {
    vec4 t = texture2D(uMap, vOutlineUv);
    if (t.a < 0.5) discard;
    c *= t.rgb;
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class OutlineMaterial extends THREE.ShaderMaterial {
  declare uniforms: {
    uWidth: { value: number };
    uFullWidthDepth: { value: number };
    uResolution: { value: THREE.Vector2 };
    uColor: { value: THREE.Color };
    uMap: { value: THREE.Texture | null };
    uUseMap: { value: number };
  } & typeof THREE.UniformsLib.fog;

  constructor(o: OutlineOptions = {}) {
    super({
      name: "ToonOutline",
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uWidth: { value: o.width ?? 2 },
          uFullWidthDepth: { value: o.fullWidthDepth ?? 6 },
          uResolution: { value: new THREE.Vector2(1920, 1080) },
          uColor: { value: new THREE.Color(o.color ?? (o.map ? 0x262626 : 0x0d0b10)) },
          uMap: { value: null },
          uUseMap: { value: 0 },
        },
      ]) as OutlineMaterial["uniforms"],
    });
    // merge() clones textures; keep the map shared.
    this.uniforms.uMap.value = o.map ?? null;
    this.uniforms.uUseMap.value = o.map ? 1 : 0;
  }
}

const size = new THREE.Vector2();

/**
 * Give `mesh` an outline: a child drawing the same geometry (with smoothed
 * normals added) through `material`, skinned to the same skeleton and
 * sharing its morph weights. One material can serve many meshes. Returns
 * the outline mesh (remove it to drop the outline).
 */
export function addOutline(mesh: THREE.Mesh, material: OutlineMaterial): THREE.Mesh {
  smoothNormals(mesh.geometry);
  let outline: THREE.Mesh;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const skinned = mesh as THREE.SkinnedMesh;
    const s = new THREE.SkinnedMesh(skinned.geometry, material);
    s.bindMode = skinned.bindMode;
    s.bind(skinned.skeleton, skinned.bindMatrix);
    outline = s;
  } else {
    outline = new THREE.Mesh(mesh.geometry, material);
  }
  outline.name = `${mesh.name}:outline`;
  outline.morphTargetInfluences = mesh.morphTargetInfluences;
  outline.morphTargetDictionary = mesh.morphTargetDictionary;
  outline.frustumCulled = mesh.frustumCulled;
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.raycast = () => {};
  outline.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(size);
    material.uniforms.uResolution.value.copy(size);
  };
  mesh.add(outline);
  return outline;
}
