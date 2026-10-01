// @mmo-engine/addon-perf-probe: marks where a callgrind measurement starts
// and ends, from JavaScript.
//
// Under `valgrind --tool=callgrind --collect-atstart=no`, begin() zeroes
// the counters and turns collection on, and end(name) turns it off and
// writes a dump named after the workload, so a measurement is exactly the
// instructions between the two calls (JS, the JIT's code, native addons),
// not Node's startup or the workload's setup. Outside valgrind every call
// is a few instructions and does nothing.

#include <napi.h>

#include <string>

#include "valgrind/callgrind.h"
#include "valgrind/valgrind.h"

namespace {

bool collecting = false;

Napi::Value Running(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), RUNNING_ON_VALGRIND != 0);
}

Napi::Value Begin(const Napi::CallbackInfo& info) {
  if (collecting) {
    Napi::Error::New(info.Env(), "perf-probe: begin() twice without end()").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  CALLGRIND_ZERO_STATS;
  CALLGRIND_TOGGLE_COLLECT;
  collecting = true;
  return info.Env().Undefined();
}

Napi::Value End(const Napi::CallbackInfo& info) {
  CALLGRIND_TOGGLE_COLLECT;
  if (!collecting) {
    Napi::Error::New(info.Env(), "perf-probe: end() without begin()").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  collecting = false;
  const std::string name = info.Length() > 0 && info[0].IsString() ? info[0].As<Napi::String>().Utf8Value() : "region";
  CALLGRIND_DUMP_STATS_AT(name.c_str());
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("running", Napi::Function::New(env, Running));
  exports.Set("begin", Napi::Function::New(env, Begin));
  exports.Set("end", Napi::Function::New(env, End));
  return exports;
}

}  // namespace

NODE_API_MODULE(perf_probe, Init)
