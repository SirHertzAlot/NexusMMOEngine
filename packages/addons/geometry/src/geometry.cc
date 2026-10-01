// @mmo-engine/addon-geometry: mesh and polygon Booleans for the engine,
// over manifold (solids) and Clipper2 (polygons, through manifold's
// CrossSection).
//
// Engine frame in, engine frame out: y is up; polygons lie in the x-z
// plane as (x, z) pairs, outer rings counter-clockwise seen from above,
// holes clockwise. Internally manifold works z-up, so a polygon point
// (x, z) is manifold (x, -z) and a solid's vertex (X, Y, Z) comes back as
// (X, Z, -Y): a -90 degree turn about x, which keeps triangle winding.
//
// All calls are synchronous and run on the calling thread: they are for
// bakes (a 40-room dungeon's shell takes about 0.1 s), never the tick.

#include <napi.h>

#include <cmath>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "clipper2/clipper.version.h"
#include "manifold/cross_section.h"
#include "manifold/manifold.h"

using manifold::CrossSection;
using manifold::Manifold;
using manifold::OpType;
using manifold::Polygons;
using manifold::SimplePolygon;
using manifold::vec2;
using manifold::vec3;

namespace {

struct Fail {
  std::string message;
};

[[noreturn]] void fail(const std::string& message) { throw Fail{message}; }

// ---- polygons: { points: Float64Array (x, z pairs), rings: Uint32Array (points per ring) }

Polygons ReadPolygons(const Napi::Value& v, const char* what) {
  if (!v.IsObject()) fail(std::string(what) + ": expected { points, rings }");
  Napi::Object o = v.As<Napi::Object>();
  Napi::Value pv = o.Get("points");
  Napi::Value rv = o.Get("rings");
  if (!pv.IsTypedArray() || pv.As<Napi::TypedArray>().TypedArrayType() != napi_float64_array)
    fail(std::string(what) + ".points: expected a Float64Array of (x, z) pairs");
  if (!rv.IsTypedArray() || rv.As<Napi::TypedArray>().TypedArrayType() != napi_uint32_array)
    fail(std::string(what) + ".rings: expected a Uint32Array of ring sizes");
  Napi::Float64Array pts = pv.As<Napi::Float64Array>();
  Napi::Uint32Array rings = rv.As<Napi::Uint32Array>();
  if (pts.ElementLength() % 2 != 0) fail(std::string(what) + ".points: odd length");
  size_t total = 0;
  for (size_t r = 0; r < rings.ElementLength(); ++r) total += rings[r];
  if (total != pts.ElementLength() / 2)
    fail(std::string(what) + ": the rings hold " + std::to_string(total) + " points, points has " +
         std::to_string(pts.ElementLength() / 2));
  Polygons out;
  out.reserve(rings.ElementLength());
  size_t at = 0;
  for (size_t r = 0; r < rings.ElementLength(); ++r) {
    SimplePolygon ring;
    ring.reserve(rings[r]);
    for (uint32_t i = 0; i < rings[r]; ++i, ++at) {
      const double x = pts[at * 2], z = pts[at * 2 + 1];
      if (!std::isfinite(x) || !std::isfinite(z)) fail(std::string(what) + ": a point isn't finite");
      ring.push_back(vec2(x, -z));
    }
    out.push_back(std::move(ring));
  }
  return out;
}

Napi::Object WritePolygons(Napi::Env env, const CrossSection& cs) {
  const Polygons polys = cs.ToPolygons();
  size_t total = 0;
  for (const auto& r : polys) total += r.size();
  Napi::Float64Array pts = Napi::Float64Array::New(env, total * 2);
  Napi::Uint32Array rings = Napi::Uint32Array::New(env, polys.size());
  size_t at = 0;
  for (size_t r = 0; r < polys.size(); ++r) {
    rings[r] = static_cast<uint32_t>(polys[r].size());
    for (const vec2& p : polys[r]) {
      pts[at * 2] = p.x;
      pts[at * 2 + 1] = p.y == 0 ? 0 : -p.y;  // no -0 in the output
      ++at;
    }
  }
  Napi::Object o = Napi::Object::New(env);
  o.Set("points", pts);
  o.Set("rings", rings);
  o.Set("area", cs.Area());
  return o;
}

CrossSection::JoinType ReadJoin(const Napi::Object& opts) {
  Napi::Value j = opts.Get("join");
  if (j.IsUndefined()) return CrossSection::JoinType::Miter;
  const std::string s = j.ToString().Utf8Value();
  if (s == "miter") return CrossSection::JoinType::Miter;
  if (s == "round") return CrossSection::JoinType::Round;
  if (s == "square") return CrossSection::JoinType::Square;
  if (s == "bevel") return CrossSection::JoinType::Bevel;
  fail("join: expected miter, round, square or bevel (got " + s + ")");
}

OpType ReadOp(const std::string& s, const char* what) {
  if (s == "union") return OpType::Add;
  if (s == "difference") return OpType::Subtract;
  if (s == "intersection") return OpType::Intersect;
  fail(std::string(what) + ": expected union, difference or intersection (got " + s + ")");
}

double NumberOr(const Napi::Object& o, const char* key, double fallback) {
  Napi::Value v = o.Get(key);
  if (v.IsUndefined()) return fallback;
  if (!v.IsNumber()) fail(std::string(key) + ": expected a number");
  const double d = v.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(d)) fail(std::string(key) + ": not finite");
  return d;
}

// cellsToPolygons(mask, width, height, { cell, value, simplify, offset, join })
// The outline of every cell whose mask byte equals `value` (default: any
// non-zero), merged: each row's runs become rectangles, unioned in one
// batch (Clipper2), then simplified (collinear points dropped).
Napi::Value CellsToPolygons(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    if (info.Length() < 3 || !info[0].IsTypedArray() || info[0].As<Napi::TypedArray>().TypedArrayType() != napi_uint8_array)
      fail("cellsToPolygons(mask: Uint8Array, width, height, opts?)");
    Napi::Uint8Array mask = info[0].As<Napi::Uint8Array>();
    const int64_t w = info[1].As<Napi::Number>().Int64Value();
    const int64_t h = info[2].As<Napi::Number>().Int64Value();
    if (w <= 0 || h <= 0 || static_cast<size_t>(w * h) != mask.ElementLength())
      fail("cellsToPolygons: width x height must equal the mask's length");
    Napi::Object opts = info.Length() > 3 && info[3].IsObject() ? info[3].As<Napi::Object>() : Napi::Object::New(env);
    const double cell = NumberOr(opts, "cell", 1);
    if (cell <= 0) fail("cell: must be positive");
    const bool anyValue = opts.Get("value").IsUndefined();
    const uint8_t value = anyValue ? 0 : static_cast<uint8_t>(opts.Get("value").As<Napi::Number>().Uint32Value());
    const double simplify = NumberOr(opts, "simplify", cell * 1e-3);
    const double offset = NumberOr(opts, "offset", 0);
    const CrossSection::JoinType join = ReadJoin(opts);  // checked even when there's no offset

    // Index the raw bytes: MSVC finds Napi::TypedArrayOf::operator[] ambiguous
    // with an int64_t index (C2666), and the pointer skips the wrapper per cell.
    const uint8_t* bytes = mask.Data();
    auto hit = [&](int64_t x, int64_t y) {
      const uint8_t m = bytes[static_cast<size_t>(y * w + x)];
      return anyValue ? m != 0 : m == value;
    };
    std::vector<CrossSection> runs;
    for (int64_t y = 0; y < h; ++y) {
      for (int64_t x = 0; x < w;) {
        if (!hit(x, y)) { ++x; continue; }
        int64_t e = x;
        while (e < w && hit(e, y)) ++e;
        // The run [x, e) x [y, y + 1), in manifold's (x, -z) frame, counter-clockwise.
        const double x0 = x * cell, x1 = e * cell, z0 = y * cell, z1 = (y + 1) * cell;
        runs.emplace_back(SimplePolygon{vec2(x0, -z1), vec2(x1, -z1), vec2(x1, -z0), vec2(x0, -z0)});
        x = e;
      }
    }
    CrossSection cs = CrossSection::BatchBoolean(runs, OpType::Add);
    if (offset != 0) cs = cs.Offset(offset, join, 2.0);
    if (simplify > 0) cs = cs.Simplify(simplify);
    return WritePolygons(env, cs);
  } catch (const Fail& f) {
    Napi::Error::New(env, f.message).ThrowAsJavaScriptException();
  } catch (const std::exception& e) {
    Napi::Error::New(env, std::string("cellsToPolygons: ") + e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// polygonBoolean(op, a, b) and polygonOffset(p, delta, { join, simplify })
Napi::Value PolygonBoolean(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    if (info.Length() < 3 || !info[0].IsString()) fail("polygonBoolean(op, a, b)");
    const OpType op = ReadOp(info[0].As<Napi::String>().Utf8Value(), "op");
    CrossSection a(ReadPolygons(info[1], "a"), CrossSection::FillRule::NonZero);
    CrossSection b(ReadPolygons(info[2], "b"), CrossSection::FillRule::NonZero);
    return WritePolygons(env, a.Boolean(b, op));
  } catch (const Fail& f) {
    Napi::Error::New(env, f.message).ThrowAsJavaScriptException();
  } catch (const std::exception& e) {
    Napi::Error::New(env, std::string("polygonBoolean: ") + e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value PolygonOffset(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    if (info.Length() < 2 || !info[1].IsNumber()) fail("polygonOffset(polygons, delta, opts?)");
    Napi::Object opts = info.Length() > 2 && info[2].IsObject() ? info[2].As<Napi::Object>() : Napi::Object::New(env);
    CrossSection cs(ReadPolygons(info[0], "polygons"), CrossSection::FillRule::NonZero);
    cs = cs.Offset(info[1].As<Napi::Number>().DoubleValue(), ReadJoin(opts), NumberOr(opts, "miterLimit", 2.0),
                   static_cast<int>(NumberOr(opts, "segments", 0)));
    const double simplify = NumberOr(opts, "simplify", 0);
    if (simplify > 0) cs = cs.Simplify(simplify);
    return WritePolygons(env, cs);
  } catch (const Fail& f) {
    Napi::Error::New(env, f.message).ThrowAsJavaScriptException();
  } catch (const std::exception& e) {
    Napi::Error::New(env, std::string("polygonOffset: ") + e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// ---- solids: a CSG tree evaluated by manifold
//
//   { op: "box", min: [x, y, z], max: [x, y, z], tag? }
//   { op: "extrude", polygons, y0, height, tag? }
//   { op: "union" | "difference" | "intersection", of: [node, ...], tag? }
//   { op: "translate", by: [x, y, z], of: node }
//
// A leaf's `tag` (a small integer) follows its faces through every Boolean
// (manifold's original ids), so the result says which input each triangle
// came from: floor, wall, a pool's bed. Faces of untagged leaves get 0; a
// tag on an operation node re-tags everything under it.

struct Tags {
  std::unordered_map<int, uint32_t> byOriginal;
};

vec3 ReadVec3(const Napi::Object& o, const char* key) {
  Napi::Value v = o.Get(key);
  if (!v.IsArray() || v.As<Napi::Array>().Length() != 3) fail(std::string(key) + ": expected [x, y, z]");
  Napi::Array a = v.As<Napi::Array>();
  double c[3];
  for (uint32_t i = 0; i < 3; ++i) {
    c[i] = a.Get(i).As<Napi::Number>().DoubleValue();
    if (!std::isfinite(c[i])) fail(std::string(key) + ": not finite");
  }
  return vec3(c[0], c[1], c[2]);
}

// Engine point to manifold's frame.
vec3 ToManifold(vec3 p) { return vec3(p.x, -p.z, p.y); }

Manifold Tagged(Manifold m, const Napi::Object& node, Tags& tags) {
  Napi::Value t = node.Get("tag");
  if (t.IsUndefined()) return m;
  const uint32_t tag = t.As<Napi::Number>().Uint32Value();
  Manifold o = m.AsOriginal();
  tags.byOriginal[o.OriginalID()] = tag;
  return o;
}

Manifold Build(const Napi::Value& v, Tags& tags, int depth) {
  if (depth > 256) fail("solid: the tree is deeper than 256");
  if (!v.IsObject()) fail("solid: a node must be an object");
  Napi::Object node = v.As<Napi::Object>();
  const std::string op = node.Get("op").ToString().Utf8Value();
  if (op == "box") {
    const vec3 a = ToManifold(ReadVec3(node, "min")), b = ToManifold(ReadVec3(node, "max"));
    const vec3 lo(std::min(a.x, b.x), std::min(a.y, b.y), std::min(a.z, b.z));
    const vec3 hi(std::max(a.x, b.x), std::max(a.y, b.y), std::max(a.z, b.z));
    if (hi.x - lo.x <= 0 || hi.y - lo.y <= 0 || hi.z - lo.z <= 0) fail("box: empty (max must exceed min on every axis)");
    return Tagged(Manifold::Cube(hi - lo).Translate(lo), node, tags);
  }
  if (op == "extrude") {
    const double y0 = NumberOr(node, "y0", 0), height = NumberOr(node, "height", 0);
    if (height <= 0) fail("extrude: height must be positive");
    // NonZero, then back to polygons: the rings may overlap or run either way.
    const Polygons polys = CrossSection(ReadPolygons(node.Get("polygons"), "extrude.polygons"),
                                        CrossSection::FillRule::NonZero).ToPolygons();
    return Tagged(Manifold::Extrude(polys, height).Translate(vec3(0, 0, y0)), node, tags);
  }
  if (op == "translate") {
    const vec3 by = ReadVec3(node, "by");
    return Tagged(Build(node.Get("of"), tags, depth + 1).Translate(vec3(by.x, -by.z, by.y)), node, tags);
  }
  if (op == "union" || op == "difference" || op == "intersection") {
    Napi::Value of = node.Get("of");
    if (!of.IsArray() || of.As<Napi::Array>().Length() == 0) fail(op + ": `of` must be a non-empty array");
    Napi::Array list = of.As<Napi::Array>();
    std::vector<Manifold> parts;
    parts.reserve(list.Length());
    for (uint32_t i = 0; i < list.Length(); ++i) parts.push_back(Build(list.Get(i), tags, depth + 1));
    Manifold out;
    if (op == "difference") {
      // The first minus the union of the rest.
      if (parts.size() == 1) out = parts[0];
      else {
        std::vector<Manifold> rest(parts.begin() + 1, parts.end());
        out = parts[0] - Manifold::BatchBoolean(rest, OpType::Add);
      }
    } else {
      out = Manifold::BatchBoolean(parts, op == "union" ? OpType::Add : OpType::Intersect);
    }
    if (!node.Get("tag").IsUndefined()) {
      // Re-tag: forget the ids underneath (their faces all get this tag).
      return Tagged(out, node, tags);
    }
    return out;
  }
  fail("solid: unknown op `" + op + "` (box, extrude, translate, union, difference, intersection)");
}

// solid(tree) -> { positions: Float32Array, indices: Uint32Array, tags: Uint16Array (per triangle),
//                  volume, area, genus }
Napi::Value Solid(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  try {
    if (info.Length() < 1) fail("solid(tree)");
    Tags tags;
    const Manifold m = Build(info[0], tags, 0);
    if (m.Status() != Manifold::Error::NoError) fail("solid: manifold reports an invalid result");
    const manifold::MeshGL mesh = m.GetMeshGL();
    const size_t nv = mesh.NumVert(), nt = mesh.NumTri(), np = mesh.numProp;
    Napi::Float32Array pos = Napi::Float32Array::New(env, nv * 3);
    for (size_t i = 0; i < nv; ++i) {
      const float X = mesh.vertProperties[i * np], Y = mesh.vertProperties[i * np + 1], Z = mesh.vertProperties[i * np + 2];
      pos[i * 3] = X;
      pos[i * 3 + 1] = Z;
      pos[i * 3 + 2] = Y == 0 ? 0.0f : -Y;
    }
    Napi::Uint32Array idx = Napi::Uint32Array::New(env, nt * 3);
    for (size_t i = 0; i < nt * 3; ++i) idx[i] = mesh.triVerts[i];
    Napi::Uint16Array tri = Napi::Uint16Array::New(env, nt);
    for (size_t r = 0; r < mesh.runOriginalID.size(); ++r) {
      const auto it = tags.byOriginal.find(static_cast<int>(mesh.runOriginalID[r]));
      const uint16_t tag = it == tags.byOriginal.end() ? 0 : static_cast<uint16_t>(it->second);
      for (size_t t = mesh.runIndex[r] / 3; t < mesh.runIndex[r + 1] / 3; ++t) tri[t] = tag;
    }
    Napi::Object out = Napi::Object::New(env);
    out.Set("positions", pos);
    out.Set("indices", idx);
    out.Set("tags", tri);
    out.Set("volume", m.Volume());
    out.Set("area", m.SurfaceArea());
    out.Set("genus", m.Genus());
    return out;
  } catch (const Fail& f) {
    Napi::Error::New(env, f.message).ThrowAsJavaScriptException();
  } catch (const std::exception& e) {
    Napi::Error::New(env, std::string("solid: ") + e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value Version(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), std::string("manifold 3.5.4, Clipper2 ") + CLIPPER2_VERSION);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("version", Napi::Function::New(env, Version));
  exports.Set("cellsToPolygons", Napi::Function::New(env, CellsToPolygons));
  exports.Set("polygonBoolean", Napi::Function::New(env, PolygonBoolean));
  exports.Set("polygonOffset", Napi::Function::New(env, PolygonOffset));
  exports.Set("solid", Napi::Function::New(env, Solid));
  return exports;
}

}  // namespace

NODE_API_MODULE(geometry, Init)
