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
