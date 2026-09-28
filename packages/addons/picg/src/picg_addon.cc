// @mmo-engine/addon-picg — N-API wrapper over PICG's pcg-core C API.
//
// PICG (github.com/DJ-Huang/PCG-AI, Apache-2.0) cooks `.pcg` node graphs
// into procedural geometry. This addon exposes its public C API
// (third_party/pcg-core/include/pcg_api.h) to the engine:
//
//   version()                 -> "0.1.x" (pcg-core runtime version)
//   validate(json)            -> null when valid, else the error message
//   cook(json, seed, cb)      -> cb(err, result) on the libuv thread pool:
//                                { kind: "mesh", mesh: ArrayBuffer (PCGM bytes),
//                                  vertexCount, indexCount }
//                              | { kind: "json", json: string }
//                              | { kind: "none" }
//   clearCache()              -> drop pcg-core's per-node cook cache
//
// Cooking never runs on the calling thread: a graph can take hundreds of
// milliseconds, and the region's tick loop must not wait on it. pcg-core
// keeps process-global state (cook cache, cancel flag), so the JS side
// (index.js) runs one cook at a time.
//
// Mesh results come back as PICG's own PCGM binary (see pcg_api.h): the
// server can hand those bytes to clients unchanged, and one decoder
// (@mmo-engine/picg) serves both sides.

#include <napi.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "pcg_api.h"

namespace {

constexpr int kErrBytes = 4096;
/** First mesh buffer; a larger mesh reports its size and is re-cooked (from pcg-core's cache). */
constexpr int kInitialMeshBytes = 8 << 20;
constexpr int kInitialJsonBytes = 1 << 20;
/** Largest result buffer the addon will allocate. */
constexpr int kMaxBytes = 512 << 20;

/** The byte count in pcg-core's "... buffer too small (need N bytes, ...)" message, or 0. */
int requiredBytes(const char* err)
{
    const char* need = std::strstr(err, "need ");
    if (!need) return 0;
    const long value = std::strtol(need + 5, nullptr, 10);
    return value > 0 && value <= kMaxBytes ? static_cast<int>(value) : 0;
}

class CookWorker final : public Napi::AsyncWorker {
public:
    CookWorker(Napi::Function& callback, std::string json, int seed)
        : Napi::AsyncWorker(callback), json_(std::move(json)), seed_(seed) {}

    void Execute() override
    {
        int mesh_size = kInitialMeshBytes;
        int json_size = kInitialJsonBytes;
        // A too-small buffer fails after the cook and names the size it
        // needs; the retry comes from pcg-core's per-node cook cache.
        for (int attempt = 0; attempt < 3; ++attempt) {
            mesh_.assign(static_cast<size_t>(mesh_size), 0);
            json_out_.assign(static_cast<size_t>(json_size), '\0');
            char err[kErrBytes] = {0};
            int kind = PCG_RESULT_KIND_NONE;
            vertex_count_ = 0;
            index_count_ = 0;
            const PcgResultCode rc = pcg_execute_graph_v2(
                json_.c_str(), seed_, &kind, json_out_.data(), json_size, mesh_.data(), mesh_size,
                &vertex_count_, &index_count_, err, kErrBytes);
            if (rc == PCG_OK) {
                kind_ = kind;
                if (kind == PCG_RESULT_KIND_MESH) mesh_.resize(meshBytes());
                return;
            }
            const int need = requiredBytes(err);
            if (rc == PCG_ERR_EXECUTION && need > 0 && need <= kMaxBytes) {
                if (std::strncmp(err, "JSON buffer", 11) == 0 && need > json_size) {
                    json_size = need + 1;
                    continue;
                }
                if (std::strncmp(err, "Mesh binary", 11) == 0 && need > mesh_size) {
                    mesh_size = need;
                    continue;
                }
            }
            SetError(std::string("picg cook failed (code ") + std::to_string(rc) + "): " + err);
            return;
        }
        SetError("picg cook failed: result buffers kept growing");
    }

    void OnOK() override
    {
        Napi::Env env = Env();
        Napi::Object result = Napi::Object::New(env);
        if (kind_ == PCG_RESULT_KIND_MESH) {
            result.Set("kind", "mesh");
            Napi::ArrayBuffer bytes = Napi::ArrayBuffer::New(env, mesh_.size());
            std::memcpy(bytes.Data(), mesh_.data(), mesh_.size());
            result.Set("mesh", bytes);
            result.Set("vertexCount", vertex_count_);
            result.Set("indexCount", index_count_);
        } else if (kind_ == PCG_RESULT_KIND_JSON || kind_ == PCG_RESULT_KIND_POINTS) {
            result.Set("kind", "json");
            result.Set("json", std::string(json_out_.c_str()));
        } else {
            result.Set("kind", "none");
        }
        Callback().Call({env.Null(), result});
    }

private:
    /** Bytes pcg-core wrote: the header states every section's size. */
    size_t meshBytes() const
    {
        const auto* b = mesh_.data();
        auto u32 = [b](size_t at) {
            uint32_t v;
            std::memcpy(&v, b + at, 4);
            return v;
        };
        const uint32_t version = u32(4);
        const uint32_t flags = version >= 2 ? u32(16) : 0u;
        const size_t header = version >= 3 ? 24 : (version == 2 ? 20 : 16);
        const size_t n = static_cast<size_t>(vertex_count_);
        size_t bytes = header + n * 12 + static_cast<size_t>(index_count_) * 4;
        if (flags & 0x1u) bytes += n * 12;
        if (flags & 0x2u) bytes += n * 16;
        if (flags & 0x4u) bytes += n * 8;
        if (version >= 3 && (flags & 0x8u)) bytes += u32(20);
        return bytes <= mesh_.size() ? bytes : mesh_.size();
    }

    std::string json_;
    int seed_;
    int kind_ = PCG_RESULT_KIND_NONE;
    int vertex_count_ = 0;
    int index_count_ = 0;
    std::vector<uint8_t> mesh_;
    std::string json_out_;
};

Napi::Value Version(const Napi::CallbackInfo& info)
{
    return Napi::String::New(info.Env(), pcg_get_version());
}

Napi::Value Validate(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "validate(json: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    const std::string json = info[0].As<Napi::String>();
    char err[kErrBytes] = {0};
    if (pcg_validate_graph(json.c_str(), err, kErrBytes) == PCG_OK) return env.Null();
    return Napi::String::New(env, err[0] ? err : "invalid graph");
}

Napi::Value Cook(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsFunction()) {
        Napi::TypeError::New(env, "cook(json: string, seed: number, callback)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::Function callback = info[2].As<Napi::Function>();
    auto* worker = new CookWorker(callback, info[0].As<Napi::String>(), info[1].As<Napi::Number>().Int32Value());
    worker->Queue();
    return env.Undefined();
}

Napi::Value ClearCache(const Napi::CallbackInfo& info)
{
    pcg_cook_cache_clear();
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("version", Napi::Function::New(env, Version));
    exports.Set("validate", Napi::Function::New(env, Validate));
    exports.Set("cook", Napi::Function::New(env, Cook));
    exports.Set("clearCache", Napi::Function::New(env, ClearCache));
    return exports;
}

} // namespace

NODE_API_MODULE(picg, Init)
