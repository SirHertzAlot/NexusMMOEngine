/**
 * Shared GLSL source strings for FX primitives [PROPOSED, PR1].
 * packages/render-fx/src/primitives-glsl.ts
 *
 * No imports, no renderer: plain exported strings. The client appends
 * FX_WARP_GLSL to [EXISTING] apps/client/src/render/glsl.ts NOISE_GLSL
 * (fxHash/fxNoise/fxFbm/fxRidge) — never a second noise copy.
 */

/** Domain-warp helper over the existing fxFbm (T2-derived, newly authored). */
export const FX_WARP_GLSL = /* glsl */ `
float fxWarp2(vec2 p, float t, float scale, float speed) {
  vec2 q = vec2(fxFbm(p * scale + t * speed), fxFbm(p * scale + vec2(3.7, 2.1) + t * speed * 0.7));
  return fxFbm(p * scale + 2.0 * q + t * speed * 0.5);
}
float prim_fresnel(vec3 viewNormal) {
  return 1.0 - abs(dot(normalize(viewNormal), vec3(0.0, 0.0, 1.0)));
}
`;

/**
 * Snippet pin for snapshot tests: every symbol the runtime requires from
 * the combined (NOISE_GLSL + FX_WARP_GLSL) chunk.
 */
export const REQUIRED_GLSL_SYMBOLS = ["fxHash(", "fxFbm(", "fxWarp2(", "prim_fresnel("] as const;
