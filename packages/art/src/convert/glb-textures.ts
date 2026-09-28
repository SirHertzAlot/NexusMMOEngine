/**
 * Point a GLB's materials at shared, external texture atlases.
 *
 * Every model in a pack samples the same few atlases, so embedding the
 * atlas in each GLB would duplicate megabytes thousands of times. Instead
 * the GLB's JSON gets an `images[].uri` relative to the GLB file; glTF
 * loaders (three's GLTFLoader included) resolve it against the GLB's URL.
 * Only the JSON chunk changes; the binary chunk is copied untouched.
 */

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface GltfJson {
  materials?: Array<{
    name?: string;
    pbrMetallicRoughness?: Record<string, unknown>;
  }>;
  images?: Array<{ uri: string }>;
  textures?: Array<{ source: number; sampler: number }>;
  samplers?: Array<Record<string, number>>;
  [key: string]: unknown;
}

export function readGlbJson(glb: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a GLB file");
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset < glb.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const data = glb.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data)) as GltfJson;
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + length;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, bin };
}

export function writeGlb(json: GltfJson, bin: Uint8Array | null): Uint8Array {
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = align4(enc.length);
  const binLen = bin ? align4(bin.length) : 0;
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(enc, 20);
  out.fill(0x20, 20 + enc.length, 20 + jsonLen); // JSON pads with spaces
  if (bin) {
    const at = 20 + jsonLen;
    view.setUint32(at, binLen, true);
    view.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8); // BIN pads with zeros (already zero)
  }
  return out;
}

const align4 = (n: number): number => (n + 3) & ~3;

/**
 * Give each material named in `uriByMaterial` a baseColorTexture pointing
 * at that URI (white base colour so the atlas shows unmodified). Images
 * are shared: materials using the same atlas reference one image.
 */
export function withExternalTextures(glb: Uint8Array, uriByMaterial: ReadonlyMap<string, string>): Uint8Array {
  const { json, bin } = readGlbJson(glb);
  const images = (json.images ??= []);
  const textures = (json.textures ??= []);
  const samplers = (json.samplers ??= []);
  let sampler = -1;
  const textureByUri = new Map<string, number>();
  for (const material of json.materials ?? []) {
    const uri = material.name !== undefined ? uriByMaterial.get(material.name) : undefined;
    if (uri === undefined) continue;
    if (sampler < 0) {
      // LINEAR / LINEAR_MIPMAP_LINEAR / REPEAT: atlas UVs wrap.
      sampler = samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }) - 1;
    }
    let texture = textureByUri.get(uri);
    if (texture === undefined) {
      const image = images.push({ uri }) - 1;
      texture = textures.push({ source: image, sampler }) - 1;
      textureByUri.set(uri, texture);
    }
    material.pbrMetallicRoughness = {
      ...material.pbrMetallicRoughness,
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index: texture },
    };
  }
  if (images.length === 0) delete json.images;
  if (textures.length === 0) delete json.textures;
  if (samplers.length === 0) delete json.samplers;
  return writeGlb(json, bin);
}
