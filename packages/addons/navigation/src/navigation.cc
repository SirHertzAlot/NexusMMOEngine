// @mmo-engine/addon-navigation — N-API shim (Phase 2).
//
// NavService owns one dtNavMesh plus one dtNavMeshQuery per agent
// profile. The boundary is bulk and SoA (DOD):
// - bakeTile(config, vertices, indices) runs the canonical Recast bake
//   pipeline (heightfield -> rasterize -> filters -> regions -> contours
//   -> polymesh -> detail -> dtCreateNavMeshData) synchronously and
//   returns the tile blob. Bake is a chunk-gen/load-time operation,
//   never per tick.
// - loadTiles(blobs[]) / unloadTiles(refs[]): tile blobs enter the
//   dtNavMesh with ZERO copies — the Node Buffers are kept alive
//   natively (flags=0 on addTile; one persistent Buffer reference per
//   tileRef). DT_TILE_FREE_DATA is deliberately NOT used: it would
//   free() Node-owned Buffer memory.
// - findPaths(batch, arena): one N-API call moves N path requests;
//   results land in caller-allocated arenas. No per-entity N-API in the
//   hot loop.
// - Native dtPolyRefs never cross to JS. Tile identity is the dtTileRef
//   (u64); entity identity is the engine's u64 wire id.
// - The crowd (DetourCrowd): agents keyed by entity id, added, retargeted
//   and removed in bulk. It is a STEERING service, not the authority on
//   position: crowdStep(dt, sync, out) first snaps each agent to where
//   the simulation has it (moving its corridor along the mesh, or
//   re-placing it after a teleport), then runs dtCrowd::update (path
//   following, corridor optimisation, separation, velocity-obstacle
//   avoidance) and hands back each agent's velocity for the game to use
//   as its intent. The crowd's own integration is only a prediction.
//
// Determinism posture (EVALUATION.md §2): Detour queries are
// synchronous with no internal randomness — the only randomness in the
// pipeline is the caller-supplied random-float callback, which this
// addon never uses (there is no such reference anywhere in this file;
// the test suite asserts that). Treat baked tiles as versioned build
// artifacts keyed by (bake-config hash + inputs); see README.md.
//
// Exceptions are disabled (NAPI_DISABLE_CPP_EXCEPTIONS): invalid input
// throws a JS exception via ThrowAsJavaScriptException and returns
// undefined; no C++ exception ever crosses the boundary. Each method
// throws at most ONCE per call: validators return null/false on failure
// and the caller bails out immediately, because a second throw while an
// exception is already pending is fatal.
//
// All native ops run on the JS thread, never concurrently.

#include <napi.h>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "DetourAlloc.h"
#include "DetourCommon.h"
#include "DetourCrowd.h"
#include "DetourNavMesh.h"
#include "DetourNavMeshBuilder.h"
#include "DetourNavMeshQuery.h"
#include "DetourStatus.h"
#include "Recast.h"

namespace mmo_navigation {

namespace {

// --- validation helpers (same pattern as addon-physics) ---

const float *CheckedF32(Napi::Env env, Napi::Value value, const char *name,
                        size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a Float32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Float32Array arr = value.As<Napi::Float32Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env, std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

float *CheckedF32Mut(Napi::Env env, Napi::Value value, const char *name,
                     size_t min_len) {
  return const_cast<float *>(CheckedF32(env, value, name, min_len));
}

const uint32_t *CheckedU32(Napi::Env env, Napi::Value value, const char *name,
                           size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_uint32_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a Uint32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Uint32Array arr = value.As<Napi::Uint32Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env, std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

uint32_t *CheckedU32Mut(Napi::Env env, Napi::Value value, const char *name,
                        size_t min_len) {
  return const_cast<uint32_t *>(CheckedU32(env, value, name, min_len));
}

const uint8_t *CheckedU8(Napi::Env env, Napi::Value value, const char *name,
                          size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a Uint8Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Uint8Array arr = value.As<Napi::Uint8Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env, std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

int32_t *CheckedI32Mut(Napi::Env env, Napi::Value value, const char *name,
                       size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_int32_array) {
    Napi::TypeError::New(env, std::string(name) + " must be an Int32Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Int32Array arr = value.As<Napi::Int32Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env, std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

uint64_t *CheckedBigU64Mut(Napi::Env env, Napi::Value value, const char *name,
                           size_t min_len) {
  if (!value.IsTypedArray() ||
      value.As<Napi::TypedArray>().TypedArrayType() != napi_biguint64_array) {
    Napi::TypeError::New(env, std::string(name) + " must be a BigUint64Array")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::BigUint64Array arr = value.As<Napi::BigUint64Array>();
  if (arr.ElementLength() < min_len) {
    Napi::RangeError::New(env, std::string(name) + " is shorter than required")
        .ThrowAsJavaScriptException();
    return nullptr;
  }
  return arr.Data();
}

const uint64_t *CheckedBigU64(Napi::Env env, Napi::Value value,
                              const char *name, size_t min_len) {
  return const_cast<const uint64_t *>(
      CheckedBigU64Mut(env, value, name, min_len));
}

Napi::Buffer<uint8_t> CheckedBuffer(Napi::Env env, Napi::Value value,
                                    const char *name) {
  bool isBuffer = false;
  if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer) {
    Napi::TypeError::New(env, std::string(name) + " must be a Buffer")
        .ThrowAsJavaScriptException();
    return Napi::Buffer<uint8_t>();
  }
  Napi::Buffer<uint8_t> buf = value.As<Napi::Buffer<uint8_t>>();
  if (buf.Length() == 0) {
    Napi::RangeError::New(env, std::string(name) + " must not be empty")
        .ThrowAsJavaScriptException();
    return Napi::Buffer<uint8_t>();
  }
  return buf;
}

// Read a required numeric field from a config object. On failure throws
// once and sets *ok = false.
double ReqNum(Napi::Env env, Napi::Object obj, const char *name, bool *ok) {
  Napi::Value v = obj.Get(name);
  if (!v.IsNumber()) {
    Napi::TypeError::New(env,
                         std::string("config.") + name + " must be a number")
        .ThrowAsJavaScriptException();
    *ok = false;
    return 0;
  }
  return v.As<Napi::Number>().DoubleValue();
}

}  // namespace

// PathStatus mirrors index.js PathStatus.
enum PathStatus : int32_t {
  PATH_OK = 0,
  PATH_NO_START_POLY = 1,
  PATH_NO_END_POLY = 2,
  PATH_NO_PATH = 3,
  PATH_UNKNOWN_PROFILE = 4,
};

struct BakeOpts {
  int tileX = 0;
  int tileZ = 0;
  float cellSize = 0.3f;
  float cellHeight = 0.2f;
  float agentHeight = 2.0f;
  float agentRadius = 0.6f;
  float agentMaxClimb = 0.9f;
  float walkableSlopeAngle = 45.0f;
  int regionMinSize = 8;
  int regionMergeSize = 20;
  float edgeMaxLen = 12.0f;
  float edgeMaxError = 1.3f;
  int vertsPerPoly = 6;
  float detailSampleDist = 6.0f;
  float detailSampleMaxError = 1.0f;
};

class NavServiceWrap : public Napi::ObjectWrap<NavServiceWrap> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function ctor = DefineClass(
        env, "NavService",
        {
            InstanceMethod("destroy", &NavServiceWrap::Destroy),
            InstanceMethod("bakeTile", &NavServiceWrap::BakeTile),
            InstanceMethod("loadTiles", &NavServiceWrap::LoadTiles),
            InstanceMethod("unloadTiles", &NavServiceWrap::UnloadTiles),
            InstanceMethod("findPaths", &NavServiceWrap::FindPaths),
            InstanceMethod("tileCount", &NavServiceWrap::TileCount),
            InstanceMethod("crowdAdd", &NavServiceWrap::CrowdAdd),
            InstanceMethod("crowdRemove", &NavServiceWrap::CrowdRemove),
            InstanceMethod("crowdTarget", &NavServiceWrap::CrowdTarget),
            InstanceMethod("crowdStep", &NavServiceWrap::CrowdStep),
            InstanceMethod("crowdCount", &NavServiceWrap::CrowdCount),
        });
    exports.Set("NavService", ctor);
    return exports;
  }

  explicit NavServiceWrap(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<NavServiceWrap>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
      Napi::TypeError::New(env, "NavService(config) requires a config object")
          .ThrowAsJavaScriptException();
      return;
    }
    Napi::Object cfg = info[0].As<Napi::Object>();
    bool ok = true;
    originX_ = ReqNum(env, cfg, "originX", &ok);
    originZ_ = ReqNum(env, cfg, "originZ", &ok);
    tileWorldSize_ = ReqNum(env, cfg, "tileWorldSize", &ok);
    if (!ok) return;
    if (!(tileWorldSize_ > 0)) {
      Napi::RangeError::New(env, "config.tileWorldSize must be > 0")
          .ThrowAsJavaScriptException();
      return;
    }
    int maxTiles = 128;
    int maxPolys = 2048;
    Napi::Value vMaxTiles = cfg.Get("maxTiles");
    if (vMaxTiles.IsNumber()) maxTiles = vMaxTiles.As<Napi::Number>().Int32Value();
    Napi::Value vMaxPolys = cfg.Get("maxPolys");
    if (vMaxPolys.IsNumber()) maxPolys = vMaxPolys.As<Napi::Number>().Int32Value();
    if (maxTiles <= 0 || maxPolys <= 0) {
      Napi::RangeError::New(env, "config.maxTiles/maxPolys must be > 0")
          .ThrowAsJavaScriptException();
      return;
    }

    Napi::Value vProfiles = cfg.Get("profiles");
    if (!vProfiles.IsArray() || vProfiles.As<Napi::Array>().Length() == 0) {
      Napi::TypeError::New(env, "config.profiles must be a non-empty array")
          .ThrowAsJavaScriptException();
      return;
    }

    mesh_ = dtAllocNavMesh();
    if (!mesh_) {
      Napi::Error::New(env, "NavService: dtAllocNavMesh failed")
          .ThrowAsJavaScriptException();
      return;
    }
    dtNavMeshParams params;
    memset(&params, 0, sizeof(params));
    params.orig[0] = static_cast<float>(originX_);
    params.orig[1] = 0.0f;
    params.orig[2] = static_cast<float>(originZ_);
    params.tileWidth = static_cast<float>(tileWorldSize_);
    params.tileHeight = static_cast<float>(tileWorldSize_);
    params.maxTiles = maxTiles;
    params.maxPolys = maxPolys;
    if (dtStatusFailed(mesh_->init(&params))) {
      Napi::Error::New(env, "NavService: dtNavMesh::init failed")
          .ThrowAsJavaScriptException();
      dtFreeNavMesh(mesh_);
      mesh_ = nullptr;
      return;
    }

    Napi::Array profiles = vProfiles.As<Napi::Array>();
    const uint32_t nProfiles = profiles.Length();
    for (uint32_t i = 0; i < nProfiles; i++) {
      Napi::Value pv = profiles[i];
      if (!pv.IsObject()) {
        Napi::TypeError::New(env, "config.profiles[] entries must be objects")
            .ThrowAsJavaScriptException();
        ok = false;
        break;
      }
      Napi::Object po = pv.As<Napi::Object>();
      const double idD = ReqNum(env, po, "id", &ok);
      const double hD = ReqNum(env, po, "agentHeight", &ok);
      const double rD = ReqNum(env, po, "agentRadius", &ok);
      const double cD = ReqNum(env, po, "agentMaxClimb", &ok);
      if (!ok) break;
      if (idD < 0 || idD > 255 || idD != static_cast<double>(static_cast<int>(idD))) {
        Napi::RangeError::New(env, "profile id must be an integer in [0, 255]")
            .ThrowAsJavaScriptException();
        ok = false;
        break;
      }
      const auto id = static_cast<uint8_t>(idD);
      if (profiles_.count(id)) {
        Napi::RangeError::New(env, "duplicate profile id in config.profiles")
            .ThrowAsJavaScriptException();
        ok = false;
        break;
      }
      dtNavMeshQuery *query = dtAllocNavMeshQuery();
      if (!query || dtStatusFailed(query->init(mesh_, 2048))) {
        if (query) dtFreeNavMeshQuery(query);
        Napi::Error::New(env, "NavService: dtNavMeshQuery::init failed")
            .ThrowAsJavaScriptException();
        ok = false;
        break;
      }
      Profile p;
      p.query = query;
      p.filter = dtQueryFilter();  // default: include all areas
      p.height = static_cast<float>(hD);
      p.radius = static_cast<float>(rD);
      p.climb = static_cast<float>(cD);
      profiles_[id] = p;
    }
    if (!ok) {
      DestroyNative();
      return;
    }

    // The crowd: config.crowd = { maxAgents = 1024, maxAgentRadius = 1 }.
    int maxAgents = 1024;
    float maxAgentRadius = 1.0f;
    Napi::Value vCrowd = cfg.Get("crowd");
    if (vCrowd.IsObject()) {
      Napi::Object co = vCrowd.As<Napi::Object>();
      Napi::Value vA = co.Get("maxAgents");
      if (vA.IsNumber()) maxAgents = vA.As<Napi::Number>().Int32Value();
      Napi::Value vR = co.Get("maxAgentRadius");
      if (vR.IsNumber()) maxAgentRadius = vR.As<Napi::Number>().FloatValue();
    }
    if (maxAgents <= 0 || !(maxAgentRadius > 0)) {
      Napi::RangeError::New(env, "config.crowd: maxAgents and maxAgentRadius must be > 0")
          .ThrowAsJavaScriptException();
      DestroyNative();
      return;
    }
    crowd_ = dtAllocCrowd();
    if (!crowd_ || !crowd_->init(maxAgents, maxAgentRadius, mesh_)) {
      Napi::Error::New(env, "NavService: dtCrowd::init failed")
          .ThrowAsJavaScriptException();
      DestroyNative();
      return;
    }
    // A query of our own for snapping agents to the simulation (the
    // crowd's is const).
    syncQuery_ = dtAllocNavMeshQuery();
    if (!syncQuery_ || dtStatusFailed(syncQuery_->init(mesh_, 512))) {
      Napi::Error::New(env, "NavService: dtNavMeshQuery::init failed")
          .ThrowAsJavaScriptException();
      DestroyNative();
      return;
    }
    alive_ = true;
  }

  ~NavServiceWrap() override { DestroyNative(); }

 private:
  struct Profile {
    dtNavMeshQuery *query = nullptr;
    dtQueryFilter filter;
    float height = 0;
    float radius = 0;
    float climb = 0;
  };

  bool CheckAlive(Napi::Env env) {
    if (!alive_ || !mesh_) {
      Napi::Error::New(env, "NavService is destroyed")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }

  void DestroyNative() {
    // The crowd and its query point into the mesh: they go first.
    if (crowd_) {
      dtFreeCrowd(crowd_);
      crowd_ = nullptr;
    }
    if (syncQuery_) {
      dtFreeNavMeshQuery(syncQuery_);
      syncQuery_ = nullptr;
    }
    agents_.clear();
    for (auto &kv : profiles_) {
      if (kv.second.query) dtFreeNavMeshQuery(kv.second.query);
    }
    profiles_.clear();
    tileBufs_.clear();  // releases the persistent Buffer references
    if (mesh_) {
      dtFreeNavMesh(mesh_);
      mesh_ = nullptr;
    }
    alive_ = false;
  }

  Napi::Value Destroy(const Napi::CallbackInfo &info) {
    DestroyNative();
    return info.Env().Undefined();
  }

  Napi::Value TileCount(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return env.Undefined();
    int n = 0;
    const dtNavMesh *cmesh = mesh_;  // const overload of getTile is public
    for (int i = 0; i < cmesh->getMaxTiles(); i++) {
      const dtMeshTile *tile = cmesh->getTile(i);
      if (tile && tile->header) n++;
    }
    return Napi::Number::New(env, static_cast<double>(n));
  }

  // --- bakeTile(config, vertices, indices) -> { blob, stats } ---

  bool ParseBakeOpts(Napi::Env env, Napi::Object obj, BakeOpts *out) {
    bool ok = true;
    out->tileX = static_cast<int>(ReqNum(env, obj, "tileX", &ok));
    out->tileZ = static_cast<int>(ReqNum(env, obj, "tileZ", &ok));
    out->cellSize = static_cast<float>(ReqNum(env, obj, "cellSize", &ok));
    out->cellHeight = static_cast<float>(ReqNum(env, obj, "cellHeight", &ok));
    out->agentHeight = static_cast<float>(ReqNum(env, obj, "agentHeight", &ok));
    out->agentRadius = static_cast<float>(ReqNum(env, obj, "agentRadius", &ok));
    out->agentMaxClimb =
        static_cast<float>(ReqNum(env, obj, "agentMaxClimb", &ok));
    out->walkableSlopeAngle =
        static_cast<float>(ReqNum(env, obj, "walkableSlopeAngle", &ok));
    out->regionMinSize = static_cast<int>(ReqNum(env, obj, "regionMinSize", &ok));
    out->regionMergeSize =
        static_cast<int>(ReqNum(env, obj, "regionMergeSize", &ok));
    out->edgeMaxLen = static_cast<float>(ReqNum(env, obj, "edgeMaxLen", &ok));
    out->edgeMaxError = static_cast<float>(ReqNum(env, obj, "edgeMaxError", &ok));
    out->vertsPerPoly =
        static_cast<int>(ReqNum(env, obj, "vertsPerPoly", &ok));
    out->detailSampleDist =
        static_cast<float>(ReqNum(env, obj, "detailSampleDist", &ok));
    out->detailSampleMaxError =
        static_cast<float>(ReqNum(env, obj, "detailSampleMaxError", &ok));
    if (!ok) return false;
    if (!(out->cellSize > 0) || !(out->cellHeight > 0)) {
      Napi::RangeError::New(env, "bakeTile: cellSize/cellHeight must be > 0")
          .ThrowAsJavaScriptException();
      return false;
    }
    if (!(out->agentHeight > 0) || !(out->agentRadius >= 0) ||
        !(out->agentMaxClimb >= 0)) {
      Napi::RangeError::New(
          env, "bakeTile: agentHeight must be > 0; agentRadius/agentMaxClimb >= 0")
          .ThrowAsJavaScriptException();
      return false;
    }
    if (!(out->walkableSlopeAngle >= 0) || !(out->walkableSlopeAngle < 90)) {
      Napi::RangeError::New(env,
                             "bakeTile: walkableSlopeAngle must be in [0, 90)")
          .ThrowAsJavaScriptException();
      return false;
    }
    if (out->vertsPerPoly < 3) {
      Napi::RangeError::New(env, "bakeTile: vertsPerPoly must be >= 3")
          .ThrowAsJavaScriptException();
      return false;
    }
    return true;
  }

  Napi::Value BakeTile(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return env.Undefined();
    if (info.Length() < 3 || !info[0].IsObject()) {
      Napi::TypeError::New(
          env, "bakeTile(config, vertices: Float32Array, indices: Uint32Array)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    BakeOpts opts;
    if (!ParseBakeOpts(env, info[0].As<Napi::Object>(), &opts))
      return env.Undefined();
    const float *verts = CheckedF32(env, info[1], "vertices", 9);
    if (!verts) return env.Undefined();
    const uint32_t *idx = CheckedU32(env, info[2], "indices", 3);
    if (!idx) return env.Undefined();
    const size_t nv =
        info[1].As<Napi::Float32Array>().ElementLength() / 3;
    const size_t nt =
        info[2].As<Napi::Uint32Array>().ElementLength() / 3;
    if (nv == 0 || nt == 0) {
      Napi::RangeError::New(env,
                             "bakeTile: need at least one triangle (vertices "
                             "and indices must be non-empty)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    for (size_t i = 0;
         i < info[2].As<Napi::Uint32Array>().ElementLength(); i++) {
      if (idx[i] >= nv) {
        Napi::RangeError::New(
            env, "bakeTile: triangle index out of vertex range")
            .ThrowAsJavaScriptException();
        return env.Undefined();
      }
    }

    // Voxel-space agent dimensions.
    const int walkableHeight =
        static_cast<int>(ceilf(opts.agentHeight / opts.cellHeight));
    const int walkableClimb =
        static_cast<int>(floorf(opts.agentMaxClimb / opts.cellHeight));
    const int walkableRadius =
        static_cast<int>(ceilf(opts.agentRadius / opts.cellSize));
    if (walkableHeight < 3) {
      Napi::RangeError::New(
          env, "bakeTile: agentHeight/cellHeight yields walkableHeight < 3 "
               "voxels — increase agentHeight or decrease cellHeight")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    // Tile bounds: X/Z from the service grid, Y from the geometry.
    float gmin[3], gmax[3];
    rcCalcBounds(verts, static_cast<int>(nv), gmin, gmax);
    float bmin[3], bmax[3];
    bmin[0] = static_cast<float>(originX_ + opts.tileX * tileWorldSize_);
    bmin[2] = static_cast<float>(originZ_ + opts.tileZ * tileWorldSize_);
    bmax[0] = bmin[0] + static_cast<float>(tileWorldSize_);
    bmax[2] = bmin[2] + static_cast<float>(tileWorldSize_);
    bmin[1] = gmin[1] - 1.0f;
    bmax[1] = gmax[1] + 1.0f;

    rcContext ctx(false);  // no logging; errors surface as JS exceptions
    int gw = 0, gh = 0;
    rcCalcGridSize(bmin, bmax, opts.cellSize, &gw, &gh);
    if (gw <= 0 || gh <= 0) {
      Napi::Error::New(env, "bakeTile: degenerate raster grid")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    rcHeightfield hf;
    if (!rcCreateHeightfield(&ctx, hf, gw, gh, bmin, bmax, opts.cellSize,
                             opts.cellHeight)) {
      Napi::Error::New(env, "bakeTile: rcCreateHeightfield failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    std::vector<unsigned char> triAreas(nt, RC_NULL_AREA);
    // NOTE: indices are int in the Recast API.
    std::vector<int> tris(nt * 3);
    for (size_t i = 0; i < nt * 3; i++) tris[i] = static_cast<int>(idx[i]);
    rcMarkWalkableTriangles(&ctx, opts.walkableSlopeAngle, verts,
                            static_cast<int>(nv), tris.data(),
                            static_cast<int>(nt), triAreas.data());
    if (!rcRasterizeTriangles(&ctx, verts, static_cast<int>(nv), tris.data(),
                              triAreas.data(), static_cast<int>(nt), hf)) {
      Napi::Error::New(env, "bakeTile: rcRasterizeTriangles failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    // Validation assert 1 (spike lesson): bad winding or out-of-bounds
    // geometry rasterizes to zero spans — fail loudly, not silently.
    const int spanCount = rcGetHeightFieldSpanCount(&ctx, hf);
    if (spanCount == 0) {
      Napi::Error::New(
          env,
          "bakeTile: rasterization produced 0 spans — no walkable surface "
          "found. Check that triangles overlap the tile bounds and use "
          "counter-clockwise winding when viewed from above (+Y).")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    rcFilterLowHangingWalkableObstacles(&ctx, walkableClimb, hf);
    rcFilterLedgeSpans(&ctx, walkableHeight, walkableClimb, hf);
    rcFilterWalkableLowHeightSpans(&ctx, walkableHeight, hf);

    rcCompactHeightfield chf;
    if (!rcBuildCompactHeightfield(&ctx, walkableHeight, walkableClimb, hf,
                                   chf)) {
      Napi::Error::New(env, "bakeTile: rcBuildCompactHeightfield failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (!rcErodeWalkableArea(&ctx, walkableRadius, chf)) {
      Napi::Error::New(env, "bakeTile: rcErodeWalkableArea failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (!rcBuildDistanceField(&ctx, chf)) {
      Napi::Error::New(env, "bakeTile: rcBuildDistanceField failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (!rcBuildRegions(&ctx, chf, 0, opts.regionMinSize,
                        opts.regionMergeSize)) {
      Napi::Error::New(env, "bakeTile: rcBuildRegions failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    rcContourSet cset;
    if (!rcBuildContours(&ctx, chf, opts.edgeMaxError, opts.edgeMaxLen,
                         cset)) {
      Napi::Error::New(env, "bakeTile: rcBuildContours failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // Validation assert 2: zero contours means no walkable region
    // survived (e.g. agent too big for the geometry) — fail loudly.
    if (cset.nconts == 0) {
      Napi::Error::New(
          env,
          "bakeTile: contour set is empty (0 contours) — no walkable "
          "region survived region building. Check agentHeight/agentRadius "
          "against the geometry scale.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    rcPolyMesh pmesh;
    if (!rcBuildPolyMesh(&ctx, cset, opts.vertsPerPoly, pmesh)) {
      Napi::Error::New(env, "bakeTile: rcBuildPolyMesh failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    // Validation assert 3: zero polys — nothing to navigate.
    if (pmesh.npolys == 0) {
      Napi::Error::New(env,
                        "bakeTile: polygon mesh is empty (0 polys) — no "
                        "navigable surface produced.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    rcPolyMeshDetail dmesh;
    if (!rcBuildPolyMeshDetail(&ctx, pmesh, chf, opts.detailSampleDist,
                               opts.detailSampleMaxError, dmesh)) {
      Napi::Error::New(env, "bakeTile: rcBuildPolyMeshDetail failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    for (int i = 0; i < pmesh.npolys; i++) pmesh.flags[i] = 1;  // walkable

    dtNavMeshCreateParams nmParams;
    memset(&nmParams, 0, sizeof(nmParams));
    nmParams.verts = pmesh.verts;
    nmParams.vertCount = pmesh.nverts;
    nmParams.polys = pmesh.polys;
    nmParams.polyAreas = pmesh.areas;
    nmParams.polyFlags = pmesh.flags;
    nmParams.polyCount = pmesh.npolys;
    nmParams.nvp = pmesh.nvp;
    nmParams.detailMeshes = dmesh.meshes;
    nmParams.detailVerts = dmesh.verts;
    nmParams.detailVertsCount = dmesh.nverts;
    nmParams.detailTris = dmesh.tris;
    nmParams.detailTriCount = dmesh.ntris;
    nmParams.walkableHeight = opts.agentHeight;
    nmParams.walkableRadius = opts.agentRadius;
    nmParams.walkableClimb = opts.agentMaxClimb;
    nmParams.tileX = opts.tileX;
    nmParams.tileY = opts.tileZ;
    nmParams.tileLayer = 0;
    rcVcopy(nmParams.bmin, bmin);
    rcVcopy(nmParams.bmax, bmax);
    nmParams.cs = opts.cellSize;
    nmParams.ch = opts.cellHeight;
    nmParams.buildBvTree = true;

    unsigned char *navData = nullptr;
    int navDataSize = 0;
    if (dtStatusFailed(dtCreateNavMeshData(&nmParams, &navData, &navDataSize)) ||
        !navData || navDataSize <= 0) {
      if (navData) dtFree(navData);
      Napi::Error::New(env, "bakeTile: dtCreateNavMeshData failed")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Buffer<uint8_t> blob =
        Napi::Buffer<uint8_t>::Copy(env, navData, navDataSize);
    dtFree(navData);

    Napi::Object result = Napi::Object::New(env);
    result.Set("blob", blob);
    Napi::Object stats = Napi::Object::New(env);
    stats.Set("spanCount", Napi::Number::New(env, spanCount));
    stats.Set("contourCount", Napi::Number::New(env, cset.nconts));
    stats.Set("polyCount", Napi::Number::New(env, pmesh.npolys));
    stats.Set("detailTriCount", Napi::Number::New(env, dmesh.ntris));
    stats.Set("blobBytes", Napi::Number::New(env, navDataSize));
    result.Set("stats", stats);
    return result;
  }

  // --- loadTiles(blobs[]) -> BigUint64Array of tile refs ---

  Napi::Value LoadTiles(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return env.Undefined();
    if (info.Length() < 1 || !info[0].IsArray()) {
      Napi::TypeError::New(env, "loadTiles(blobs: Buffer[])")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Array arr = info[0].As<Napi::Array>();
    const uint32_t n = arr.Length();
    Napi::BigUint64Array out = Napi::BigUint64Array::New(env, n);
    uint64_t *refs = out.Data();
    for (uint32_t i = 0; i < n; i++) {
      Napi::Buffer<uint8_t> buf =
          CheckedBuffer(env, arr[i], "loadTiles blob");
      if (env.IsExceptionPending()) return env.Undefined();
      dtTileRef ref = 0;
      // flags=0: Detour does NOT take ownership — the Buffer is kept
      // alive natively via the persistent reference below.
      dtStatus st =
          mesh_->addTile(buf.Data(), static_cast<int>(buf.Length()), 0, 0, &ref);
      if (dtStatusFailed(st) || ref == 0) {
        Napi::Error::New(env, "loadTiles: dtNavMesh::addTile failed")
            .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      tileBufs_[ref] = Napi::Persistent(buf);
      refs[i] = ref;
    }
    return out;
  }

  void UnloadTiles(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return;
    const uint64_t *refs = CheckedBigU64(env, info[0], "refs", 0);
    if (!refs) return;
    const size_t n = info[0].As<Napi::BigUint64Array>().ElementLength();
    for (size_t i = 0; i < n; i++) {
      unsigned char *data = nullptr;
      int dataSize = 0;
      mesh_->removeTile(refs[i], &data, &dataSize);
      tileBufs_.erase(refs[i]);  // releases the Buffer reference
    }
  }

  // --- findPaths(batch, arena) ---

  void FindPaths(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return;
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsObject()) {
      Napi::TypeError::New(env, "findPaths(batch, arena)")
          .ThrowAsJavaScriptException();
      return;
    }
    Napi::Object batch = info[0].As<Napi::Object>();
    Napi::Object arena = info[1].As<Napi::Object>();

    bool ok = true;
    const double countD = ReqNum(env, batch, "count", &ok);
    const double maxWpD = ReqNum(env, batch, "maxWaypoints", &ok);
    if (!ok) return;
    if (countD < 0 || countD != static_cast<double>(static_cast<int>(countD))) {
      Napi::RangeError::New(env, "batch.count must be a non-negative int")
          .ThrowAsJavaScriptException();
      return;
    }
    if (maxWpD <= 0 || maxWpD != static_cast<double>(static_cast<int>(maxWpD))) {
      Napi::RangeError::New(env, "batch.maxWaypoints must be a positive int")
          .ThrowAsJavaScriptException();
      return;
    }
    const size_t count = static_cast<size_t>(countD);
    const size_t maxWp = static_cast<size_t>(maxWpD);

    // entityIds are accepted for API symmetry with the other addons
    // (callers correlate results by index); they are not used natively.
    const uint64_t *entityIds =
        CheckedBigU64(env, batch.Get("entityIds"), "batch.entityIds", count);
    if (!entityIds && env.IsExceptionPending()) return;
    const float *starts = CheckedF32(env, batch.Get("start"), "batch.start",
                                     count * 3);
    if (!starts) return;
    const float *ends =
        CheckedF32(env, batch.Get("end"), "batch.end", count * 3);
    if (!ends) return;
    const uint8_t *profIds =
        CheckedU8(env, batch.Get("profile"), "batch.profile", count);
    if (!profIds) return;

    int32_t *status = CheckedI32Mut(env, arena.Get("status"), "arena.status",
                                    count);
    if (!status) return;
    uint32_t *wpCount = CheckedU32Mut(env, arena.Get("waypointCount"),
                                      "arena.waypointCount", count);
    if (!wpCount) return;
    uint32_t *polyCount = CheckedU32Mut(env, arena.Get("polyCount"),
                                        "arena.polyCount", count);
    if (!polyCount) return;
    float *waypoints = CheckedF32Mut(env, arena.Get("waypoints"),
                                     "arena.waypoints", count * maxWp * 3);
    if (!waypoints) return;

    static const int MAX_PATH = 256;
    static const float EXTENTS[3] = {2.0f, 4.0f, 2.0f};
    std::vector<dtPolyRef> path(MAX_PATH);

    for (size_t i = 0; i < count; i++) {
      auto pit = profiles_.find(profIds[i]);
      if (pit == profiles_.end()) {
        status[i] = PATH_UNKNOWN_PROFILE;
        wpCount[i] = 0;
        polyCount[i] = 0;
        continue;
      }
      dtNavMeshQuery *query = pit->second.query;
      const dtQueryFilter *filter = &pit->second.filter;

      dtPolyRef sRef = 0, eRef = 0;
      float sPos[3], ePos[3];
      const float *sIn = starts + i * 3;
      const float *eIn = ends + i * 3;
      if (dtStatusFailed(
              query->findNearestPoly(sIn, EXTENTS, filter, &sRef, sPos)) ||
          sRef == 0) {
        status[i] = PATH_NO_START_POLY;
        wpCount[i] = 0;
        polyCount[i] = 0;
        continue;
      }
      if (dtStatusFailed(
              query->findNearestPoly(eIn, EXTENTS, filter, &eRef, ePos)) ||
          eRef == 0) {
        status[i] = PATH_NO_END_POLY;
        wpCount[i] = 0;
        polyCount[i] = 0;
        continue;
      }
      int pathCount = 0;
      const dtStatus pathStatus = query->findPath(sRef, eRef, sPos, ePos, filter,
                                                 path.data(), &pathCount,
                                                 MAX_PATH);
      // NOTE: DT_PARTIAL_RESULT means the end poly was unreachable — the
      // corridor leads somewhere else. That is not a valid path for the
      // request, so it reports NO_PATH (documented in README.md).
      if (dtStatusFailed(pathStatus) || pathCount == 0 ||
          (pathStatus & DT_PARTIAL_RESULT) != 0) {
        status[i] = PATH_NO_PATH;
        wpCount[i] = 0;
        polyCount[i] = 0;
        continue;
      }
      int straightCount = 0;
      float *wpOut = waypoints + i * maxWp * 3;
      const dtStatus sst = query->findStraightPath(
          sPos, ePos, path.data(), pathCount, wpOut, nullptr, nullptr,
          &straightCount, static_cast<int>(maxWp),
          DT_STRAIGHTPATH_ALL_CROSSINGS);
      if (dtStatusFailed(sst) || straightCount == 0) {
        status[i] = PATH_NO_PATH;
        wpCount[i] = 0;
        polyCount[i] = 0;
        continue;
      }
      status[i] = PATH_OK;
      wpCount[i] = static_cast<uint32_t>(straightCount);
      polyCount[i] = static_cast<uint32_t>(pathCount);
    }
  }


  // --- crowd ---------------------------------------------------------------

  // CrowdAddStatus mirrors index.js CrowdAddStatus.
  enum CrowdAddStatus : int32_t {
    CROWD_ADDED = 0,
    CROWD_UPDATED = 1,  // already an agent: parameters updated
    CROWD_FULL = 2,
  };
  // CrowdTargetStatus mirrors index.js CrowdTargetStatus.
  enum CrowdTargetStatus : int32_t {
    TARGET_OK = 0,
    TARGET_UNKNOWN_AGENT = 1,
    TARGET_NO_POLY = 2,
    TARGET_CLEARED = 3,
  };
  // Agent states out of crowdStep (mirror index.js CrowdAgentState).
  enum CrowdAgentState : uint8_t {
    AGENT_INVALID = 0,   // not on the mesh (no tile under it yet, or off it)
    AGENT_IDLE = 1,      // on the mesh, no target
    AGENT_MOVING = 2,    // on the mesh, heading for its target
    AGENT_ARRIVED = 3,   // within its radius of the target
    AGENT_NO_PATH = 4,   // the target can't be reached
  };

  static dtCrowdAgentParams AgentParams(float radius, float height, float maxSpeed,
                                        float maxAccel) {
    dtCrowdAgentParams p;
    memset(&p, 0, sizeof(p));
    p.radius = radius;
    p.height = height;
    p.maxSpeed = maxSpeed;
    p.maxAcceleration = maxAccel;
    p.collisionQueryRange = radius * 12.0f;
    p.pathOptimizationRange = radius * 30.0f;
    p.separationWeight = 2.0f;
    p.updateFlags = DT_CROWD_ANTICIPATE_TURNS | DT_CROWD_OPTIMIZE_VIS |
                    DT_CROWD_OPTIMIZE_TOPO | DT_CROWD_OBSTACLE_AVOIDANCE |
                    DT_CROWD_SEPARATION;
    p.obstacleAvoidanceType = 3;  // the highest-quality preset
    p.queryFilterType = 0;
    return p;
  }

  bool ReadCount(Napi::Env env, Napi::Object batch, size_t *count) {
    bool ok = true;
    const double c = ReqNum(env, batch, "count", &ok);
    if (!ok) return false;
    if (c < 0 || c != static_cast<double>(static_cast<int>(c))) {
      Napi::RangeError::New(env, "batch.count must be a non-negative int")
          .ThrowAsJavaScriptException();
      return false;
    }
    *count = static_cast<size_t>(c);
    return true;
  }

  int AgentIndex(uint64_t id) const {
    auto it = agents_.find(id);
    return it == agents_.end() ? -1 : it->second;
  }

  // crowdAdd({count, entityIds, pos, radius, height, maxSpeed,
  //   maxAcceleration}) -> Int32Array of CrowdAddStatus.
  Napi::Value CrowdAdd(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return env.Undefined();
    if (info.Length() < 1 || !info[0].IsObject()) {
      Napi::TypeError::New(env, "crowdAdd(batch)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object b = info[0].As<Napi::Object>();
    size_t n = 0;
    if (!ReadCount(env, b, &n)) return env.Undefined();
    const uint64_t *ids = CheckedBigU64(env, b.Get("entityIds"), "batch.entityIds", n);
    if (!ids) return env.Undefined();
    const float *pos = CheckedF32(env, b.Get("pos"), "batch.pos", n * 3);
    if (!pos) return env.Undefined();
    const float *radius = CheckedF32(env, b.Get("radius"), "batch.radius", n);
    if (!radius) return env.Undefined();
    const float *height = CheckedF32(env, b.Get("height"), "batch.height", n);
    if (!height) return env.Undefined();
    const float *speed = CheckedF32(env, b.Get("maxSpeed"), "batch.maxSpeed", n);
    if (!speed) return env.Undefined();
    const float *accel = CheckedF32(env, b.Get("maxAcceleration"), "batch.maxAcceleration", n);
    if (!accel) return env.Undefined();
    Napi::Int32Array out = Napi::Int32Array::New(env, n);
    for (size_t i = 0; i < n; i++) {
      const dtCrowdAgentParams p = AgentParams(radius[i], height[i], speed[i], accel[i]);
      const int existing = AgentIndex(ids[i]);
      if (existing >= 0) {
        crowd_->updateAgentParameters(existing, &p);
        out[i] = CROWD_UPDATED;
        continue;
      }
      const int idx = crowd_->addAgent(pos + i * 3, &p);
      if (idx < 0) {
        out[i] = CROWD_FULL;
        continue;
      }
      agents_[ids[i]] = idx;
      out[i] = CROWD_ADDED;
    }
    return out;
  }

  // crowdRemove(entityIds: BigUint64Array): unknown ids are ignored.
  void CrowdRemove(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return;
    const uint64_t *ids = CheckedBigU64(env, info[0], "entityIds", 0);
    if (!ids) return;
    const size_t n = info[0].As<Napi::BigUint64Array>().ElementLength();
    for (size_t i = 0; i < n; i++) {
      auto it = agents_.find(ids[i]);
      if (it == agents_.end()) continue;
      crowd_->removeAgent(it->second);
      agents_.erase(it);
    }
  }

  // crowdTarget({count, entityIds, target}) -> Int32Array of
  // CrowdTargetStatus. A NaN x clears the agent's target (it stops).
  Napi::Value CrowdTarget(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return env.Undefined();
    if (info.Length() < 1 || !info[0].IsObject()) {
      Napi::TypeError::New(env, "crowdTarget(batch)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object b = info[0].As<Napi::Object>();
    size_t n = 0;
    if (!ReadCount(env, b, &n)) return env.Undefined();
    const uint64_t *ids = CheckedBigU64(env, b.Get("entityIds"), "batch.entityIds", n);
    if (!ids) return env.Undefined();
    const float *target = CheckedF32(env, b.Get("target"), "batch.target", n * 3);
    if (!target) return env.Undefined();
    Napi::Int32Array out = Napi::Int32Array::New(env, n);
    const dtQueryFilter *filter = crowd_->getFilter(0);
    for (size_t i = 0; i < n; i++) {
      const int idx = AgentIndex(ids[i]);
      if (idx < 0) {
        out[i] = TARGET_UNKNOWN_AGENT;
        continue;
      }
      const float *t = target + i * 3;
      if (std::isnan(t[0])) {
        crowd_->resetMoveTarget(idx);
        out[i] = TARGET_CLEARED;
        continue;
      }
      dtPolyRef ref = 0;
      float nearest[3];
      if (dtStatusFailed(syncQuery_->findNearestPoly(t, TARGET_EXTENTS, filter, &ref, nearest)) || ref == 0) {
        out[i] = TARGET_NO_POLY;
        continue;
      }
      crowd_->requestMoveTarget(idx, ref, nearest);
      out[i] = TARGET_OK;
    }
    return out;
  }

  // crowdStep(dt, sync {count, entityIds, pos}, out {vel, state, pos}):
  // snaps the listed agents to the simulation's positions, updates the
  // whole crowd once, and writes back the listed agents' velocities
  // (the move the crowd made this tick, over dt: steering plus
  // separation), states and navmesh positions.
  void CrowdStep(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return;
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsObject() || !info[2].IsObject()) {
      Napi::TypeError::New(env, "crowdStep(dt, sync, out)").ThrowAsJavaScriptException();
      return;
    }
    const float dt = info[0].As<Napi::Number>().FloatValue();
    if (!(dt > 0)) {
      Napi::RangeError::New(env, "crowdStep: dt must be > 0").ThrowAsJavaScriptException();
      return;
    }
    Napi::Object sync = info[1].As<Napi::Object>();
    Napi::Object out = info[2].As<Napi::Object>();
    size_t n = 0;
    if (!ReadCount(env, sync, &n)) return;
    const uint64_t *ids = CheckedBigU64(env, sync.Get("entityIds"), "sync.entityIds", n);
    if (!ids) return;
    const float *pos = CheckedF32(env, sync.Get("pos"), "sync.pos", n * 3);
    if (!pos) return;
    float *vel = CheckedF32Mut(env, out.Get("vel"), "out.vel", n * 3);
    if (!vel) return;
    float *navPos = CheckedF32Mut(env, out.Get("pos"), "out.pos", n * 3);
    if (!navPos) return;
    Napi::Value vState = out.Get("state");
    if (!vState.IsTypedArray() || vState.As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array ||
        vState.As<Napi::Uint8Array>().ElementLength() < n) {
      Napi::TypeError::New(env, "out.state must be a Uint8Array of length >= count")
          .ThrowAsJavaScriptException();
      return;
    }
    uint8_t *state = vState.As<Napi::Uint8Array>().Data();

    const dtQueryFilter *filter = crowd_->getFilter(0);
    before_.resize(n * 3);
    for (size_t i = 0; i < n; i++) {
      const int idx = AgentIndex(ids[i]);
      if (idx < 0) continue;
      dtCrowdAgent *ag = crowd_->getEditableAgent(idx);
      if (!ag || !ag->active) continue;
      SnapAgent(idx, ag, pos + i * 3, filter);
      dtVcopy(&before_[i * 3], ag->npos);
    }

    crowd_->update(dt, nullptr);

    for (size_t i = 0; i < n; i++) {
      const int idx = AgentIndex(ids[i]);
      const dtCrowdAgent *ag = idx >= 0 ? crowd_->getAgent(idx) : nullptr;
      float *v = vel + i * 3;
      float *p = navPos + i * 3;
      if (!ag || !ag->active || ag->state == DT_CROWDAGENT_STATE_INVALID) {
        v[0] = v[1] = v[2] = 0;
        dtVcopy(p, pos + i * 3);
        state[i] = AGENT_INVALID;
        continue;
      }
      // The move the crowd made this tick, over dt: its steering plus the
      // push that separates agents that got too close (dtCrowd resolves
      // overlaps by moving positions, not velocities), clamped to the mesh.
      const float inv = 1.0f / dt;
      v[0] = (ag->npos[0] - before_[i * 3]) * inv;
      v[1] = (ag->npos[1] - before_[i * 3 + 1]) * inv;
      v[2] = (ag->npos[2] - before_[i * 3 + 2]) * inv;
      dtVcopy(p, ag->npos);
      if (ag->targetState == DT_CROWDAGENT_TARGET_NONE) {
        state[i] = AGENT_IDLE;
      } else if (ag->targetState == DT_CROWDAGENT_TARGET_FAILED) {
        state[i] = AGENT_NO_PATH;
      } else if (dtVdist2DSqr(ag->npos, ag->targetPos) <= ag->params.radius * ag->params.radius) {
        state[i] = AGENT_ARRIVED;
      } else {
        state[i] = AGENT_MOVING;
      }
    }
  }

  // Put agent `idx` where the simulation has it: along the mesh from its
  // corridor when close (the everyday case: the game moved it by about
  // what the crowd asked), re-placed on the nearest poly after a jump
  // (teleport, respawn, a fall), keeping its target.
  void SnapAgent(int idx, dtCrowdAgent *ag, const float *simPos, const dtQueryFilter *filter) {
    if (ag->state == DT_CROWDAGENT_STATE_WALKING && dtVdist2DSqr(ag->npos, simPos) <= SNAP_JUMP * SNAP_JUMP) {
      if (ag->corridor.movePosition(simPos, syncQuery_, filter)) {
        dtVcopy(ag->npos, ag->corridor.getPos());
      }
      return;
    }
    dtPolyRef ref = 0;
    float nearest[3];
    if (dtStatusFailed(syncQuery_->findNearestPoly(simPos, crowd_->getQueryHalfExtents(), filter, &ref, nearest)) || ref == 0) {
      // Off the mesh (swimming, flying, beyond the loaded tiles): the
      // crowd leaves it alone until it's back on, when this re-places it.
      ag->state = DT_CROWDAGENT_STATE_INVALID;
      dtVset(ag->vel, 0, 0, 0);
      return;
    }
    ag->corridor.reset(ref, nearest);
    ag->boundary.reset();
    ag->partial = false;
    ag->topologyOptTime = 0;
    ag->targetReplanTime = 0;
    ag->nneis = 0;
    dtVset(ag->dvel, 0, 0, 0);
    dtVset(ag->nvel, 0, 0, 0);
    dtVset(ag->vel, 0, 0, 0);
    dtVcopy(ag->npos, nearest);
    ag->desiredSpeed = 0;
    ag->state = DT_CROWDAGENT_STATE_WALKING;
    if (ag->targetState != DT_CROWDAGENT_TARGET_NONE && ag->targetRef) {
      const dtPolyRef tref = ag->targetRef;
      float tpos[3];
      dtVcopy(tpos, ag->targetPos);
      crowd_->requestMoveTarget(idx, tref, tpos);
    }
  }

  Napi::Value CrowdCount(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (!CheckAlive(env)) return env.Undefined();
    return Napi::Number::New(env, static_cast<double>(agents_.size()));
  }

  // Beyond this (metres, horizontal) the simulation moved an agent further
  // than steering could: re-place it instead of sliding its corridor.
  static constexpr float SNAP_JUMP = 3.0f;
  static constexpr float TARGET_EXTENTS[3] = {4.0f, 8.0f, 4.0f};

  dtCrowd *crowd_ = nullptr;
  dtNavMeshQuery *syncQuery_ = nullptr;
  std::vector<float> before_;  // scratch: agent positions before the update
  std::map<uint64_t, int> agents_;

  bool alive_ = false;
  dtNavMesh *mesh_ = nullptr;
  std::map<uint8_t, Profile> profiles_;
  std::map<dtTileRef, Napi::Reference<Napi::Buffer<uint8_t>>> tileBufs_;
  double originX_ = 0;
  double originZ_ = 0;
  double tileWorldSize_ = 0;
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return NavServiceWrap::Init(env, exports);
}

}  // namespace mmo_navigation

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return mmo_navigation::Init(env, exports);
}

NODE_API_MODULE(navigation, InitAll)
