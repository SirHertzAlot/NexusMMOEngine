// Template native addon — proves the N-API / node-addon-api toolchain
// builds and loads. It is the pattern real systems follow:
//
//   - narrow, data-oriented entry points operating on shared buffers
//   - never chatty per-entity calls across the JS/C++ boundary (skill §4)
//   - stateless where possible (like the procgen addon in slice 1.6)
//
// Exceptions are disabled (NAPI_DISABLE_CPP_EXCEPTIONS): addon code must
// not throw across the N-API boundary.

#include <napi.h>

namespace mmo_template {

// hello() -> string. Toolchain smoke signal: if this loads and answers,
// node-gyp + node-addon-api + the ABI-stable N-API surface all work.
Napi::String Hello(const Napi::CallbackInfo& info) {
  return Napi::String::New(info.Env(), "mmo-engine native toolchain OK");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("hello", Napi::Function::New(env, Hello));
  return exports;
}

NODE_API_MODULE(addon, Init)

}  // namespace mmo_template
