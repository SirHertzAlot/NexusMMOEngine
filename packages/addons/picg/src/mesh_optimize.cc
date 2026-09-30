// optimizeMesh(pcgm, { lods, maxError }) — meshoptimizer over a PCGM mesh.
//
// Cooked meshes come out of pcg-core as the modelling nodes built them:
// duplicated vertices, triangles in construction order. Before the server
// hands one to clients this:
//
//   1. welds vertices that are identical in every stream (position,
//      normal, colour, uv), so shared corners are drawn once;
//   2. orders each material group's triangles for the GPU's post-transform
//      vertex cache, then for overdraw (fewer hidden pixels shaded);
//   3. orders the vertices in first-use order (fewer cache misses when the
//      GPU fetches them);
//   4. builds a level-of-detail chain: each group simplified to a fraction
//      of its triangles (`lods`, e.g. [0.5, 0.25, 0.1]) within `maxError`
//      (relative to the mesh's size), borders between groups locked so
//      they don't crack apart, each level with its own compacted vertices.
//
// Result: { mesh: ArrayBuffer (PCGM), lods: [{ mesh, triangles, error }],
//           stats: { vertices: [in, out], triangles, acmr: [before, after] } }
// ACMR is the average vertex-shader runs per triangle with a 16-entry
// cache (lower is better; 0.5 is the floor for a grid).
//
// meshoptimizer (github.com/zeux/meshoptimizer, MIT) is vendored under
// third_party/meshoptimizer. This runs on the calling thread: a few
// milliseconds per tree, once per cooked variant.

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "meshoptimizer.h"

namespace {

constexpr uint32_t kMagic = 0x4d474350;  // 'PCGM'

struct Mesh {
    uint32_t flags = 0;
    std::vector<float> positions, normals, colors, uvs;
    std::vector<uint32_t> indices;
    std::vector<std::string> materials;
    std::vector<uint32_t> triangleMaterials;
    size_t vertexCount() const { return positions.size() / 3; }
};

bool Parse(const uint8_t* b, size_t n, Mesh& m, std::string& err)
{
    auto u32 = [&](size_t at) {
        uint32_t v;
        std::memcpy(&v, b + at, 4);
        return v;
    };
    if (n < 16 || u32(0) != kMagic) return err = "not a PCGM mesh", false;
    const uint32_t version = u32(4);
    const size_t vc = u32(8), ic = u32(12);
    m.flags = version >= 2 ? u32(16) : 0;
    size_t at = version >= 3 ? 24 : version == 2 ? 20 : 16;
    auto take = [&](std::vector<float>& out, size_t count) {
        if (at + count * 4 > n) return false;
        out.resize(count);
        std::memcpy(out.data(), b + at, count * 4);
        at += count * 4;
        return true;
    };
    if (!take(m.positions, vc * 3)) return err = "PCGM truncated (positions)", false;
    if (at + ic * 4 > n) return err = "PCGM truncated (indices)", false;
    m.indices.resize(ic);
    std::memcpy(m.indices.data(), b + at, ic * 4);
    at += ic * 4;
    if ((m.flags & 1) && !take(m.normals, vc * 3)) return err = "PCGM truncated (normals)", false;
    if ((m.flags & 2) && !take(m.colors, vc * 4)) return err = "PCGM truncated (colours)", false;
    if ((m.flags & 4) && !take(m.uvs, vc * 2)) return err = "PCGM truncated (uvs)", false;
    if (version >= 3 && (m.flags & 8)) {
        if (at + 4 > n) return err = "PCGM truncated (materials)", false;
        const uint32_t slots = u32(at);
        at += 4;
        for (uint32_t i = 0; i < slots; ++i) {
            if (at + 4 > n) return err = "PCGM truncated (material names)", false;
            const uint32_t len = u32(at);
            at += 4;
            if (at + len > n) return err = "PCGM truncated (material names)", false;
            m.materials.emplace_back(reinterpret_cast<const char*>(b + at), len);
            at += len;
        }
        const size_t tris = ic / 3;
        if (at + tris * 4 > n) return err = "PCGM truncated (triangle materials)", false;
        m.triangleMaterials.resize(tris);
        std::memcpy(m.triangleMaterials.data(), b + at, tris * 4);
    }
    for (uint32_t i : m.indices)
        if (i >= vc) return err = "PCGM index out of range", false;
    if (ic % 3) return err = "PCGM index count isn't a multiple of 3", false;
    return true;
}

std::vector<uint8_t> Write(const Mesh& m)
{
    const bool mats = (m.flags & 8) != 0;
    size_t matBytes = 0;
    if (mats) {
        matBytes = 4 + m.triangleMaterials.size() * 4;
        for (const auto& s : m.materials) matBytes += 4 + s.size();
    }
    const size_t vc = m.vertexCount();
    std::vector<uint8_t> out(24 + vc * 12 + m.indices.size() * 4 + m.normals.size() * 4 + m.colors.size() * 4 + m.uvs.size() * 4 + matBytes);
    size_t at = 0;
    auto put = [&](const void* p, size_t bytes) {
        std::memcpy(out.data() + at, p, bytes);
        at += bytes;
    };
    auto u32 = [&](uint32_t v) { put(&v, 4); };
    u32(kMagic);
    u32(3);
    u32(static_cast<uint32_t>(vc));
    u32(static_cast<uint32_t>(m.indices.size()));
    u32(m.flags);
    u32(static_cast<uint32_t>(matBytes));
    put(m.positions.data(), m.positions.size() * 4);
    put(m.indices.data(), m.indices.size() * 4);
    if (m.flags & 1) put(m.normals.data(), m.normals.size() * 4);
    if (m.flags & 2) put(m.colors.data(), m.colors.size() * 4);
    if (m.flags & 4) put(m.uvs.data(), m.uvs.size() * 4);
    if (mats) {
        u32(static_cast<uint32_t>(m.materials.size()));
        for (const auto& s : m.materials) {
            u32(static_cast<uint32_t>(s.size()));
            put(s.data(), s.size());
        }
        put(m.triangleMaterials.data(), m.triangleMaterials.size() * 4);
    }
    return out;
}

/** Apply a vertex remap (old -> new) to every stream; `count` new vertices. */
void RemapStreams(Mesh& m, const std::vector<unsigned int>& remap, size_t count)
{
    const size_t vc = m.vertexCount();
    auto remapStream = [&](std::vector<float>& s, size_t width) {
        if (s.empty()) return;
        std::vector<float> out(count * width);
        meshopt_remapVertexBuffer(out.data(), s.data(), vc, width * sizeof(float), remap.data());
        s.swap(out);
    };
    remapStream(m.positions, 3);
    remapStream(m.normals, 3);
    remapStream(m.colors, 4);
    remapStream(m.uvs, 2);
}

/** Keep only the vertices `m.indices` uses, in first-use order. */
void CompactVertices(Mesh& m)
{
    std::vector<unsigned int> remap(m.vertexCount());
    const size_t unique = meshopt_optimizeVertexFetchRemap(remap.data(), m.indices.data(), m.indices.size(), m.vertexCount());
    meshopt_remapIndexBuffer(m.indices.data(), m.indices.data(), m.indices.size(), remap.data());
    RemapStreams(m, remap, unique);
}

struct Group {
    uint32_t material;
    size_t start;  // first index
    size_t count;  // index count
};

/** Sort triangles by material (stable), so each material's triangles are one run. */
std::vector<Group> GroupByMaterial(Mesh& m)
{
    const size_t tris = m.indices.size() / 3;
    std::vector<Group> groups;
    if (m.triangleMaterials.empty()) {
        if (tris) groups.push_back({0, 0, m.indices.size()});
        return groups;
    }
    std::vector<size_t> order(tris);
    for (size_t i = 0; i < tris; ++i) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return m.triangleMaterials[a] < m.triangleMaterials[b]; });
    std::vector<uint32_t> idx(m.indices.size()), mat(tris);
    for (size_t i = 0; i < tris; ++i) {
        std::memcpy(&idx[i * 3], &m.indices[order[i] * 3], 12);
        mat[i] = m.triangleMaterials[order[i]];
    }
    m.indices.swap(idx);
    m.triangleMaterials.swap(mat);
    for (size_t t = 0; t < tris;) {
        size_t e = t;
        while (e < tris && m.triangleMaterials[e] == m.triangleMaterials[t]) ++e;
        groups.push_back({m.triangleMaterials[t], t * 3, (e - t) * 3});
        t = e;
    }
    return groups;
}

float Acmr(const Mesh& m)
{
    if (m.indices.empty()) return 0;
    return meshopt_analyzeVertexCache(m.indices.data(), m.indices.size(), m.vertexCount(), 16, 0, 0).acmr;
}

}  // namespace

Napi::Value OptimizeMesh(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !(info[0].IsTypedArray() || info[0].IsArrayBuffer())) {
        Napi::TypeError::New(env, "optimizeMesh(pcgm: Uint8Array | ArrayBuffer, { lods?: number[], maxError?: number })")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const uint8_t* bytes;
    size_t length;
    if (info[0].IsArrayBuffer()) {
        auto ab = info[0].As<Napi::ArrayBuffer>();
        bytes = static_cast<const uint8_t*>(ab.Data());
        length = ab.ByteLength();
    } else {
        auto ta = info[0].As<Napi::TypedArray>();
        bytes = static_cast<const uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset();
        length = ta.ByteLength();
    }
    std::vector<float> ratios = {0.5f, 0.25f, 0.1f};
    float maxError = 0.02f;
    if (info.Length() > 1 && info[1].IsObject()) {
        Napi::Object o = info[1].As<Napi::Object>();
        Napi::Value l = o.Get("lods");
        if (l.IsArray()) {
            ratios.clear();
            Napi::Array a = l.As<Napi::Array>();
            for (uint32_t i = 0; i < a.Length(); ++i) {
                Napi::Value v = a[i];
                const float r = v.IsNumber() ? v.As<Napi::Number>().FloatValue() : -1;
                if (!(r > 0 && r < 1)) {
                    Napi::RangeError::New(env, "optimizeMesh: lods are fractions of the triangles, each in (0, 1)").ThrowAsJavaScriptException();
                    return env.Undefined();
                }
                ratios.push_back(r);
            }
        }
        Napi::Value e = o.Get("maxError");
        if (e.IsNumber()) maxError = e.As<Napi::Number>().FloatValue();
    }

    Mesh m;
    std::string err;
    if (!Parse(bytes, length, m, err)) {
        Napi::Error::New(env, "optimizeMesh: " + err).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const size_t verticesIn = m.vertexCount();
    const float acmrBefore = Acmr(m);

    // 1. Weld identical vertices across every stream.
    std::vector<meshopt_Stream> streams;
    streams.push_back({m.positions.data(), 12, 12});
    if (!m.normals.empty()) streams.push_back({m.normals.data(), 12, 12});
    if (!m.colors.empty()) streams.push_back({m.colors.data(), 16, 16});
    if (!m.uvs.empty()) streams.push_back({m.uvs.data(), 8, 8});
    std::vector<unsigned int> remap(m.vertexCount());
    const size_t unique = meshopt_generateVertexRemapMulti(remap.data(), m.indices.data(), m.indices.size(), m.vertexCount(),
                                                           streams.data(), streams.size());
    meshopt_remapIndexBuffer(m.indices.data(), m.indices.data(), m.indices.size(), remap.data());
    RemapStreams(m, remap, unique);

    // 2. Per material: vertex cache order, then overdraw.
    const std::vector<Group> groups = GroupByMaterial(m);
    for (const Group& g : groups) {
        unsigned int* idx = m.indices.data() + g.start;
        meshopt_optimizeVertexCache(idx, idx, g.count, m.vertexCount());
        meshopt_optimizeOverdraw(idx, idx, g.count, m.positions.data(), m.vertexCount(), 12, 1.05f);
    }
    // 3. Vertices in first-use order.
    CompactVertices(m);
    const float acmrAfter = Acmr(m);

    // 4. The LOD chain, each level from the full mesh.
    Napi::Array lods = Napi::Array::New(env);
    for (size_t li = 0; li < ratios.size(); ++li) {
        Mesh lod = m;
        lod.indices.clear();
        lod.triangleMaterials.clear();
        float worst = 0;
        std::vector<unsigned int> out;
        for (const Group& g : groups) {
            const size_t target = std::max<size_t>(3, static_cast<size_t>(g.count / 3 * ratios[li]) * 3);
            out.resize(g.count);
            float groupError = 0;
            const size_t n = meshopt_simplify(out.data(), m.indices.data() + g.start, g.count, m.positions.data(), m.vertexCount(),
                                              12, target, maxError, meshopt_SimplifyLockBorder, &groupError);
            meshopt_optimizeVertexCache(out.data(), out.data(), n, m.vertexCount());
            lod.indices.insert(lod.indices.end(), out.begin(), out.begin() + n);
            if (!m.triangleMaterials.empty()) lod.triangleMaterials.insert(lod.triangleMaterials.end(), n / 3, g.material);
            worst = std::max(worst, groupError);
        }
        CompactVertices(lod);
        const std::vector<uint8_t> lodBytes = Write(lod);
        Napi::Object entry = Napi::Object::New(env);
        Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, lodBytes.size());
        std::memcpy(ab.Data(), lodBytes.data(), lodBytes.size());
        entry.Set("mesh", ab);
        entry.Set("ratio", ratios[li]);
        entry.Set("vertices", static_cast<double>(lod.vertexCount()));
        entry.Set("triangles", static_cast<double>(lod.indices.size() / 3));
        entry.Set("error", worst);
        lods.Set(static_cast<uint32_t>(li), entry);
    }

    const std::vector<uint8_t> base = Write(m);
    Napi::Object result = Napi::Object::New(env);
    Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, base.size());
    std::memcpy(ab.Data(), base.data(), base.size());
    result.Set("mesh", ab);
    result.Set("lods", lods);
    Napi::Object stats = Napi::Object::New(env);
    Napi::Array verts = Napi::Array::New(env, 2);
    verts.Set(0u, static_cast<double>(verticesIn));
    verts.Set(1u, static_cast<double>(m.vertexCount()));
    stats.Set("vertices", verts);
    stats.Set("triangles", static_cast<double>(m.indices.size() / 3));
    Napi::Array acmr = Napi::Array::New(env, 2);
    acmr.Set(0u, acmrBefore);
    acmr.Set(1u, acmrAfter);
    stats.Set("acmr", acmr);
    result.Set("stats", stats);
    return result;
}
